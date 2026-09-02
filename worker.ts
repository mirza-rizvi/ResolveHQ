import app from "resolve-server/app";
import type { AppBindings, MailQueueMessage } from "resolve-server/types";
import { processInboundMail, processOutboundMail } from "./src/server/mail/queue";
import { newId } from "./src/server/lib/id";

export default {
  fetch: app.fetch,
  async email(message, env) {
    const eventId = newId("ime");
    const stagingObjectKey = `_mail-staging/${eventId}.eml`;
    await env.ATTACHMENTS.put(stagingObjectKey, message.raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { eventId, from: message.from.slice(0, 250), to: message.to.slice(0, 250) },
    });
    const now = Date.now();
    await env.DB.prepare("INSERT INTO inbound_mail_events (id, staging_object_key, status, attachment_cursor, attempts, created_at, updated_at) VALUES (?, ?, 'staged', 0, 0, ?, ?)")
      .bind(eventId, stagingObjectKey, now, now).run();
    await env.INBOUND_MAIL_QUEUE.send({
      kind: "inbound-mail",
      eventId,
      stagingObjectKey,
      from: message.from,
      to: message.to,
    } satisfies MailQueueMessage);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "inbound-mail") await processInboundMail(env, message.body);
        else await processOutboundMail(env, { jobId: message.body.jobId });
        message.ack();
      } catch (error) {
        console.error("ResolveHQ queue failure", error);
        message.retry({ delaySeconds: 15 });
      }
    }
  },
  async scheduled(_controller, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM organization_invitations WHERE expires_at < ? AND accepted_at IS NULL").bind(now),
    ]);
    // A worker that dies mid-delivery leaves rows parked in 'processing' with
    // nothing left to move them. Anything untouched for ten minutes is treated
    // as abandoned so the normal retry paths can pick it up again.
    const stale = now - 10 * 60 * 1000;
    await env.DB.prepare("UPDATE outbound_mail_jobs SET status = 'failed', next_attempt_at = ?, last_error = coalesce(last_error, 'Recovered from stalled processing') WHERE status = 'processing' AND updated_at < ?").bind(now, stale).run();
    await env.DB.prepare("UPDATE inbound_mail_events SET status = 'failed', last_error = coalesce(last_error, 'Recovered from stalled processing') WHERE status = 'processing' AND updated_at < ?").bind(stale).run();
    // Retries stop after a day so a permanently broken event cannot be queued
    // on every tick; processInboundMail counts its attempt before it can fail.
    const stalledInbound = await env.DB.prepare("SELECT id, staging_object_key AS key FROM inbound_mail_events WHERE status = 'failed' AND attempts < 5 AND updated_at > ? AND staging_object_key LIKE '\\_mail-staging/%' ESCAPE '\\' ORDER BY updated_at LIMIT 20").bind(now - 24 * 60 * 60 * 1000).all<{ id: string; key: string }>();
    for (const event of stalledInbound.results) await env.INBOUND_MAIL_QUEUE.send({ kind: "inbound-mail", eventId: event.id, stagingObjectKey: event.key, from: "", to: "" });

    // An agent reply whose message row landed but whose job insert did not would
    // sit at 'queued' forever, and a client retry only ever answers 'duplicate'.
    // Give the request two minutes to finish on its own before adopting it.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO outbound_mail_jobs (id, organization_id, message_id, idempotency_key, status, attempts, next_attempt_at, created_at, updated_at) SELECT 'omj_' || lower(hex(randomblob(16))), m.organization_id, m.id, 'message/' || m.id, 'pending', 0, ?, ?, ? FROM messages m LEFT JOIN outbound_mail_jobs j ON j.message_id = m.id WHERE j.id IS NULL AND m.author_type = 'agent' AND m.kind = 'message' AND m.delivery_status = 'queued' AND m.created_at < ?",
    ).bind(now, now, now, now - 2 * 60 * 1000).run();

    const pending = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50").bind(now).all<{ id: string }>();
    await Promise.all(pending.results.map((job) => env.OUTBOUND_MAIL_QUEUE.send({ kind: "outbound-mail", jobId: job.id })));

    // Staging objects outlive their event only until the retry window closes.
    // Retiring the key afterwards drops the row out of this query, so the sweep
    // advances instead of re-selecting the same rows behind its LIMIT forever.
    const expired = await env.DB.prepare("SELECT id, staging_object_key AS key FROM inbound_mail_events WHERE status IN ('completed','failed') AND updated_at < ? AND staging_object_key LIKE '\\_mail-staging/%' ESCAPE '\\' ORDER BY updated_at LIMIT 50").bind(now - 7 * 24 * 60 * 60 * 1000).all<{ id: string; key: string }>();
    for (const row of expired.results) {
      await env.ATTACHMENTS.delete(row.key);
      await env.DB.prepare("UPDATE inbound_mail_events SET staging_object_key = 'deleted/' || id WHERE id = ?").bind(row.id).run();
    }

    // An upload that never made it onto a reply is dead weight in R2. The object
    // goes first so a failure here leaves a row to retry rather than a file with
    // nothing left pointing at it.
    const orphans = await env.DB.prepare("SELECT id, object_key AS key FROM attachments WHERE message_id IS NULL AND created_at < ? ORDER BY created_at LIMIT 50").bind(now - 24 * 60 * 60 * 1000).all<{ id: string; key: string }>();
    for (const orphan of orphans.results) {
      try {
        await env.ATTACHMENTS.delete(orphan.key);
        await env.DB.prepare("DELETE FROM attachments WHERE id = ? AND message_id IS NULL").bind(orphan.id).run();
      } catch (error) {
        console.error("ResolveHQ orphan attachment cleanup failure", orphan.id, error);
      }
    }
  },
} satisfies ExportedHandler<AppBindings, MailQueueMessage>;
