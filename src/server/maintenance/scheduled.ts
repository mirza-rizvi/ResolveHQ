import type { AppBindings } from "../types";
import { dispatchMail, leaseMs, retryWindowMs } from "../mail/reliability";
import { discoverCleanup, dispatchMaintenance } from "./service";
import { enforceTicketRetention } from "./retention";

export async function runScheduled(env: AppBindings) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE maintenance_tasks SET status = 'failed', lease_until = 0, dispatch_until = 0 WHERE id IN (SELECT id FROM maintenance_tasks WHERE status = 'pending' AND attempts >= 6 AND lease_until <= ? LIMIT 20)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ? ORDER BY expires_at LIMIT 20)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM organization_invitations WHERE id IN (SELECT id FROM organization_invitations WHERE expires_at < ? AND accepted_at IS NULL ORDER BY expires_at LIMIT 20)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM password_reset_tokens WHERE id IN (SELECT id FROM password_reset_tokens WHERE expires_at < ? ORDER BY expires_at LIMIT 20)",
    ).bind(now),
    env.DB.prepare(
      "UPDATE outbound_mail_jobs SET status = 'failed', lease_until = 0, dispatch_until = 0, next_attempt_at = ?, last_error = 'Recovered from stalled processing' WHERE id IN (SELECT id FROM outbound_mail_jobs WHERE status = 'processing' AND lease_until <= ? AND updated_at < ? ORDER BY updated_at LIMIT 20)",
    ).bind(now, now, now - leaseMs),
    env.DB.prepare(
      "UPDATE inbound_mail_events SET status = 'failed', lease_until = 0, dispatch_until = 0, last_error = 'Recovered from stalled processing' WHERE id IN (SELECT id FROM inbound_mail_events WHERE status = 'processing' AND lease_until <= ? AND updated_at < ? ORDER BY updated_at LIMIT 20)",
    ).bind(now, now - leaseMs),
    env.DB.prepare(
      "UPDATE outbound_mail_jobs SET terminal_reason = 'delivery_uncertain', status = 'failed' WHERE id IN (SELECT id FROM outbound_mail_jobs WHERE status IN ('pending','failed') AND terminal_reason IS NULL AND (attempts >= 6 OR first_attempt_at < ?) ORDER BY next_attempt_at LIMIT 20)",
    ).bind(now - retryWindowMs),
    env.DB.prepare(
      "UPDATE inbound_mail_events SET terminal_reason = 'retry_exhausted', status = 'failed' WHERE id IN (SELECT id FROM inbound_mail_events WHERE status IN ('staged','failed') AND terminal_reason IS NULL AND attempts >= 6 ORDER BY updated_at LIMIT 20)",
    ),
  ]);
  await recoverMissingOutbox(env, now);
  await dispatchMail(env, "inbound-mail");
  await dispatchMail(env, "outbound-mail");
  await discoverCleanup(env);
  await enforceTicketRetention(env);
  await dispatchMaintenance(env);
}

/** Walk twenty queued candidates, including ones with jobs, instead of scanning a whole backlog for gaps. */
async function recoverMissingOutbox(env: AppBindings, now: number) {
  const state = await env.DB.prepare("SELECT cursor FROM maintenance_tasks WHERE id = 'recovery/outbox'").first<{
    cursor: string | null;
  }>();
  const cursor = state?.cursor
    ? (JSON.parse(state.cursor) as { createdAt: number; id: string })
    : { createdAt: -1, id: "" };
  const rows = await env.DB.prepare(
    "SELECT id, organization_id AS organizationId, created_at AS createdAt FROM messages WHERE author_type = 'agent' AND kind = 'message' AND delivery_status = 'queued' AND created_at < ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT 20",
  )
    .bind(now - 120000, cursor.createdAt, cursor.id)
    .all<{ id: string; organizationId: string; createdAt: number }>();
  if (!rows.results.length && !state?.cursor) return;
  const last = rows.results.at(-1);
  const nextCursor =
    rows.results.length === 20 && last ? JSON.stringify({ createdAt: last.createdAt, id: last.id }) : null;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO outbound_mail_jobs (id, organization_id, message_id, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at) SELECT 'omj_' || lower(hex(randomblob(16))), json_extract(value,'$.organizationId'), json_extract(value,'$.id'), 'message/' || json_extract(value,'$.id'), 'pending', 0, ?, ?, ? FROM json_each(?)",
    ).bind(now, now, now, JSON.stringify(rows.results)),
    env.DB.prepare(
      "INSERT INTO maintenance_tasks (id, kind, status, cursor) VALUES ('recovery/outbox', 'outbox', 'completed', ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor",
    ).bind(nextCursor),
  ]);
}
