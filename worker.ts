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
    const pending = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50").bind(now).all<{ id: string }>();
    await Promise.all(pending.results.map((job) => env.OUTBOUND_MAIL_QUEUE.send({ kind: "outbound-mail", jobId: job.id })));
  },
} satisfies ExportedHandler<AppBindings, MailQueueMessage>;
