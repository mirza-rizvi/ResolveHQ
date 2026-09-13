import app from "resolve-server/app";
import type { AppBindings, MailQueueMessage } from "resolve-server/types";
import { processCloudflareEmailEvent, type CloudflareEmailEvent } from "./src/server/mail/delivery-events";
import { processInboundMail, processOutboundMail, resolveInbox } from "./src/server/mail/queue";
import { dispatchMail, leaseMs, MailFailure } from "./src/server/mail/reliability";
import { processMaintenance } from "./src/server/maintenance/service";
import { runScheduled } from "./src/server/maintenance/scheduled";
import { newId } from "./src/server/lib/id";

export default {
  fetch: app.fetch,
  async email(message, env) {
    if (message.rawSize > 25 * 1024 * 1024) {
      message.setReject("Message exceeds the 25 MiB limit.");
      return;
    }
    const inbox = await resolveInbox(env.DB, message.to.toLowerCase());
    if (!inbox) {
      message.setReject("Recipient is not configured.");
      return;
    }
    const eventId = newId("ime"),
      stagingObjectKey = `_mail-staging/${eventId}.eml`,
      now = Date.now();
    // Register before writing bytes so an interrupted staging upload remains discoverable.
    await env.DB.prepare(
      "INSERT INTO inbound_mail_events (id, inbox_id, organization_id, staging_object_key, envelope_from, envelope_to, status, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)",
    )
      .bind(
        eventId,
        inbox.id,
        inbox.organizationId,
        stagingObjectKey,
        message.from,
        message.to,
        now + leaseMs,
        now,
        now,
      )
      .run();
    try {
      const body = message.raw.pipeThrough(new FixedLengthStream(message.rawSize));
      await env.ATTACHMENTS.put(stagingObjectKey, body, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { eventId, from: message.from.slice(0, 250), to: message.to.slice(0, 250) },
      });
      await env.DB.prepare(
        "UPDATE inbound_mail_events SET status = 'staged', lease_until = 0, updated_at = ? WHERE id = ?",
      )
        .bind(Date.now(), eventId)
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE inbound_mail_events SET status = 'failed', lease_until = 0, last_error = 'staging_failed', updated_at = ? WHERE id = ?",
      )
        .bind(Date.now(), eventId)
        .run();
      throw new Error("Inbound email staging failed.");
    }
    await dispatchMail(env, "inbound-mail", [eventId]);
  },
  async queue(batch, env) {
    // Cloudflare Email Sending delivery events arrive on their own subscription
    // queue. It is matched before the dead-letter check because its own DLQ also
    // ends in "-dlq" and carries event bodies, not mail jobs.
    const emailEventsQueue = env.EMAIL_EVENTS_QUEUE_NAME || "resolvehq-email-events";
    if (batch.queue === emailEventsQueue || batch.queue === `${emailEventsQueue}-dlq`) {
      const deadLetter = batch.queue !== emailEventsQueue;
      for (const message of batch.messages) {
        if (deadLetter) {
          console.error({ event: "email_event_dead_letter", queue: batch.queue });
          message.ack();
          continue;
        }
        try {
          const { accepted, matched } = await processCloudflareEmailEvent(env.DB, message.body);
          if (!accepted) {
            const body = message.body as { type?: unknown; payload?: { eventId?: unknown } };
            console.error({
              event: "invalid_email_event",
              queue: batch.queue,
              type: typeof body?.type === "string" ? body.type : null,
              eventId: typeof body?.payload?.eventId === "string" ? body.payload.eventId : null,
            });
          } else if (!matched) {
            // The send's own D1 write may not have landed yet; retry so the
            // outcome is applied instead of being deduped away as processed.
            console.error({ event: "email_event_unmatched", queue: batch.queue });
            message.retry({ delaySeconds: 60 });
            continue;
          }
          message.ack();
        } catch {
          console.error({ event: "email_event_failure", queue: batch.queue });
          message.retry({ delaySeconds: 60 });
        }
      }
      return;
    }
    // Dead-letter consumers drain exhausted and terminal work. Each message's
    // durable row is marked queue_exhausted so it stops looking in-flight,
    // the arrival is recorded once, and the message is acknowledged.
    if (batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        const body = message.body;
        if (!body || typeof body !== "object" || !("kind" in body)) {
          console.error({ event: "invalid_dead_letter", queue: batch.queue });
          message.ack();
          continue;
        }
        try {
          if (body.kind === "outbound-mail") {
            await env.DB.batch([
              env.DB.prepare(
                "UPDATE outbound_mail_jobs SET status = 'failed', terminal_reason = 'queue_exhausted', lease_until = 0, dispatch_until = 0, updated_at = ? WHERE id = ? AND status <> 'sent' AND terminal_reason IS NULL",
              ).bind(Date.now(), body.jobId),
              env.DB.prepare(
                "UPDATE messages SET delivery_status = 'failed' WHERE delivery_status = 'queued' AND id = (SELECT message_id FROM outbound_mail_jobs WHERE id = ?)",
              ).bind(body.jobId),
            ]);
          } else if (body.kind === "inbound-mail") {
            await env.DB.prepare(
              "UPDATE inbound_mail_events SET status = 'failed', terminal_reason = 'queue_exhausted', lease_until = 0, dispatch_until = 0, updated_at = ? WHERE id = ? AND status <> 'completed' AND terminal_reason IS NULL",
            )
              .bind(Date.now(), body.eventId)
              .run();
          } else if (body.kind === "maintenance") {
            await env.DB.prepare(
              "UPDATE maintenance_tasks SET status = 'failed', lease_until = 0, dispatch_until = 0 WHERE id = ? AND status = 'pending'",
            )
              .bind(body.taskId)
              .run();
          }
          const reference =
            body.kind === "inbound-mail" ? body.eventId : body.kind === "outbound-mail" ? body.jobId : body.taskId;
          await env.DB.prepare(
            "INSERT OR IGNORE INTO mail_dlq_events (id, kind, reference, created_at) VALUES (?, ?, ?, ?)",
          )
            .bind(`${batch.queue}/${reference}`, body.kind, reference, Date.now())
            .run();
        } catch {
          console.error({ event: "dlq_record_failed", queue: batch.queue });
        }
        console.error({ event: "mail_dead_letter", queue: batch.queue, kind: body.kind });
        message.ack();
      }
      return;
    }
    for (const message of batch.messages) {
      const body = message.body;
      if (!body || typeof body !== "object" || !("kind" in body)) {
        console.error({ event: "invalid_queue_message", queue: batch.queue });
        message.ack();
        continue;
      }
      try {
        if (body.kind === "inbound-mail") await processInboundMail(env, body);
        else if (body.kind === "outbound-mail") await processOutboundMail(env, { jobId: body.jobId });
        else if (body.kind === "maintenance") await processMaintenance(env, body.taskId, body.generation);
        else {
          console.error({ event: "invalid_queue_message" });
          message.ack();
          continue;
        }
        message.ack();
      } catch (error) {
        console.error({
          event: "queue_failure",
          kind: body.kind,
          code: error instanceof MailFailure ? error.code : "infrastructure_failure",
        });
        if (error instanceof MailFailure && error.terminal) {
          const dlq = body.kind === "inbound-mail" ? env.INBOUND_MAIL_DLQ : env.OUTBOUND_MAIL_DLQ;
          if (dlq) await dlq.send(body.kind === "outbound-mail" ? { ...body, generation: body.generation } : body);
          message.ack();
        } else message.retry({ delaySeconds: error instanceof MailFailure ? error.delaySeconds : 60 });
      }
    }
  },
  async scheduled(_controller, env) {
    await runScheduled(env);
  },
} satisfies ExportedHandler<AppBindings, MailQueueMessage | CloudflareEmailEvent>;
