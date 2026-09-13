import { Hono } from "hono";
import { applyDeliveryEvent, type DeliveryOutcome } from "../mail/delivery-events";
import type { HonoEnv } from "../types";

export const webhookRoutes = new Hono<HonoEnv>();

webhookRoutes.post("/resend", async (context) => {
  const secret = context.env.RESEND_WEBHOOK_SECRET;
  if (!secret)
    return context.json(
      { error: { code: "webhook_not_configured", message: "Resend webhooks are not configured." } },
      503,
    );
  const eventId = context.req.header("svix-id");
  const timestamp = context.req.header("svix-timestamp");
  const signatures = context.req.header("svix-signature");
  if (!eventId || !timestamp || !signatures)
    return context.json({ error: { code: "invalid_signature", message: "Missing webhook signature headers." } }, 401);
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || Math.abs(Date.now() / 1000 - numericTimestamp) > 300)
    return context.json(
      { error: { code: "expired_signature", message: "Webhook timestamp is outside the allowed window." } },
      401,
    );
  const body = await context.req.text();
  if (!(await verifySvix(secret, `${eventId}.${timestamp}.${body}`, signatures)))
    return context.json({ error: { code: "invalid_signature", message: "Webhook signature is invalid." } }, 401);

  const event = JSON.parse(body) as { type?: string; data?: { email_id?: string } };
  if (!event.type || !event.data?.email_id)
    return context.json({ error: { code: "invalid_event", message: "Webhook payload is incomplete." } }, 400);
  const outcome: DeliveryOutcome = ["email.bounced", "email.failed", "email.complained"].includes(event.type)
    ? "failed"
    : ["email.sent", "email.delivered"].includes(event.type)
      ? "sent"
      : "noop";
  const result = await applyDeliveryEvent(context.env.DB, {
    provider: "resend",
    externalEventId: eventId,
    eventType: event.type,
    payload: body,
    providerMessageId: event.data.email_id,
    outcome,
    terminalReason: outcome === "failed" ? event.type : undefined,
    detail: `Resend event: ${event.type}`,
  });
  if (result.duplicate) return context.json({ ok: true, duplicate: true });
  return context.json({ ok: true });
});

async function verifySvix(secret: string, signedContent: string, signatures: string) {
  try {
    const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const keyBytes = Uint8Array.from(atob(encodedSecret), (character) => character.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent)));
    return signatures.split(" ").some((signature) => {
      const value = signature.startsWith("v1,") ? signature.slice(3) : "";
      if (!value) return false;
      const actual = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
      if (actual.length !== expected.length) return false;
      let mismatch = 0;
      for (let index = 0; index < actual.length; index += 1) mismatch |= actual[index] ^ expected[index];
      return mismatch === 0;
    });
  } catch {
    return false;
  }
}
