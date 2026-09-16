import type { AppBindings } from "../types";
import { dispatchMail, leaseMs, retryWindowMs } from "../mail/reliability";
import { discoverCleanup, dispatchMaintenance } from "./service";
import { enforceTicketRetention } from "./retention";
import { emitWebhookEvent } from "../webhooks/outbound";
import { retryDueWebhooks } from "../webhooks/outbound";

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
    // SLA promotion. The cron is the only writer of due_soon and breached, so the
    // Overdue queue is an index lookup rather than business-hours arithmetic per row.
    // Snoozed tickets are excluded from both sweeps: a snoozed ticket must never breach.
    // The 75% warning threshold is derived in SQL from the stored timestamps; running the
    // pure business-hours function across the batch would not fit the CPU budget. The
    // warning is an approximation, the breach itself is exact.
    env.DB.prepare(
      "UPDATE tickets SET sla_state = 'due_soon' WHERE id IN (SELECT id FROM tickets WHERE sla_state = 'ok' AND snoozed_until IS NULL AND first_response_at IS NULL AND first_response_due_at IS NOT NULL AND status NOT IN ('resolved','closed') AND ? >= created_at + ((first_response_due_at - created_at) * 3 / 4) ORDER BY first_response_due_at LIMIT 20)",
    ).bind(now),
    // Wake expired snoozes, shifting the SLA targets by the time actually spent snoozed.
    // snooze_started_at makes the shift exact even when this run is late.
    env.DB.prepare(
      "UPDATE tickets SET snoozed_until = NULL, snooze_started_at = NULL, snooze_reason = NULL, snoozed_total_ms = snoozed_total_ms + (? - COALESCE(snooze_started_at, ?)), first_response_due_at = CASE WHEN first_response_due_at IS NULL THEN NULL ELSE first_response_due_at + (? - COALESCE(snooze_started_at, ?)) END, resolution_due_at = CASE WHEN resolution_due_at IS NULL THEN NULL ELSE resolution_due_at + (? - COALESCE(snooze_started_at, ?)) END WHERE id IN (SELECT id FROM tickets WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? ORDER BY snoozed_until LIMIT 20)",
    ).bind(now, now, now, now, now, now, now),
    env.DB.prepare(
      "UPDATE tickets SET sla_state = 'breached' WHERE id IN (SELECT id FROM tickets WHERE sla_state IN ('ok','due_soon') AND snoozed_until IS NULL AND first_response_at IS NULL AND first_response_due_at IS NOT NULL AND status NOT IN ('resolved','closed') AND first_response_due_at < ? ORDER BY first_response_due_at LIMIT 20)",
    ).bind(now),
  ]);
  // Delivered and abandoned rows are swept here rather than through a maintenance task:
  // this is the highest-volume new table in the release and would otherwise grow without
  // bound. Bounded like every other statement in this file.
  await env.DB.prepare(
    "DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE status IN ('delivered','abandoned') AND updated_at < ? ORDER BY updated_at LIMIT 20)",
  )
    .bind(now - 7 * 86400000)
    .run();
  await announceSlaBreaches(env);
  await retryDueWebhooks(env, now);
  await recoverMissingOutbox(env, now);
  await dispatchMail(env, "inbound-mail");
  await dispatchMail(env, "outbound-mail");
  await discoverCleanup(env);
  await enforceTicketRetention(env);
  await dispatchMaintenance(env);
}

/**
 * Emits ticket.sla_breached for tickets the sweep above just promoted.
 *
 * The flag lives on the ticket rather than in a side table: `sla_breach_notified_at` is
 * set in the same statement that reads the rows, so a breach is announced exactly once
 * even if this run and the next overlap.
 */
async function announceSlaBreaches(env: AppBindings) {
  const breached = await env.DB.prepare(
    "UPDATE tickets SET sla_breach_notified_at = ? WHERE id IN (SELECT id FROM tickets WHERE sla_state = 'breached' AND sla_breach_notified_at IS NULL ORDER BY first_response_due_at LIMIT 20) RETURNING id, organization_id AS organizationId, number, subject, priority, first_response_due_at AS firstResponseDueAt",
  )
    .bind(Date.now())
    .all<{
      id: string;
      organizationId: string;
      number: number;
      subject: string;
      priority: string;
      firstResponseDueAt: number | null;
    }>();
  for (const ticket of breached.results)
    await emitWebhookEvent(env, ticket.organizationId, "ticket.sla_breached", {
      ticketId: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      priority: ticket.priority,
      firstResponseDueAt: ticket.firstResponseDueAt,
    });
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
