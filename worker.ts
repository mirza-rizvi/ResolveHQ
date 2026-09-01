import app from "resolve-server/app";
import type { AppBindings, MailQueueMessage } from "resolve-server/types";
import { processInboundMail, processOutboundMail } from "./src/server/mail/queue";

export default {
  fetch: app.fetch,
  async email(message, env) {
    await env.INBOUND_MAIL_QUEUE.send({
      kind: "inbound-mail",
      from: message.from,
      to: message.to,
      raw: await new Response(message.raw).arrayBuffer(),
    } satisfies MailQueueMessage);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "inbound-mail") await processInboundMail(env, message.body);
        else await processOutboundMail(env, message.body);
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
  },
} satisfies ExportedHandler<AppBindings, MailQueueMessage>;
