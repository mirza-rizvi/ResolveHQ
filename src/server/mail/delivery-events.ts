import { z } from "zod";
import { normalizeMessageId } from "../providers/mail";

export type DeliveryOutcome = "sent" | "failed" | "noop";

export interface DeliveryEvent {
  /** Namespace the external event id is unique within, e.g. `resend` or `cloudflare`. */
  provider: string;
  externalEventId: string;
  eventType: string;
  /** Raw event body, stored verbatim for auditing. */
  payload: string;
  providerMessageId: string;
  outcome: DeliveryOutcome;
  /** Terminal reason recorded on the job for a failed outcome. */
  terminalReason?: string;
  detail: string;
  /**
   * When true, an event whose provider message id matches no outbound job is
   * left unprocessed so a later redelivery can still apply it. Use it for
   * transports that redeliver on failure; webhook callers that answer 200
   * regardless should leave it false.
   */
  requireMatch?: boolean;
}

/**
 * Applies one delivery event from any provider. Recording and de-duplication are
 * keyed on `(provider, external_event_id)` so an at-least-once redelivery is a
 * no-op. A provider message id is only unique within the tenant that sent it, so
 * every update is scoped through the outbound job that owns it.
 */
export async function applyDeliveryEvent(database: D1Database, event: DeliveryEvent) {
  const now = Date.now();
  const inserted = await database
    .prepare(
      "INSERT OR IGNORE INTO provider_webhook_events (id, provider, external_event_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(`pwe_${crypto.randomUUID()}`, event.provider, event.externalEventId, event.eventType, event.payload, now)
    .run();
  if (!inserted.meta.changes) {
    const prior = await database
      .prepare("SELECT processed_at FROM provider_webhook_events WHERE provider = ? AND external_event_id = ?")
      .bind(event.provider, event.externalEventId)
      .first<{ processed_at: number | null }>();
    if (prior?.processed_at != null) return { duplicate: true, matched: true };
  }

  // A provider message id is only unique within the tenant that sent it, so the
  // owning job is resolved once and both updates are bound to its organization.
  const owner = await database
    .prepare(
      "SELECT organization_id AS organizationId FROM outbound_mail_jobs WHERE provider_message_id = ? ORDER BY created_at, id LIMIT 1",
    )
    .bind(event.providerMessageId)
    .first<{ organizationId: string }>();
  if (!owner) {
    // The send's own write may not have landed yet. Leaving processed_at NULL
    // keeps a redelivery of the same event id usable instead of deduping it away.
    if (event.requireMatch) return { duplicate: false, matched: false };
  } else if (event.outcome === "failed") {
    await database
      .prepare(
        "UPDATE messages SET delivery_status = ? WHERE organization_id = ? AND id IN (SELECT message_id FROM outbound_mail_jobs WHERE provider_message_id = ? AND organization_id = ? AND terminal_reason IS NULL)",
      )
      .bind("failed", owner.organizationId, event.providerMessageId, owner.organizationId)
      .run();
    await database
      .prepare(
        "UPDATE outbound_mail_jobs SET status = 'failed', terminal_reason = CASE WHEN terminal_reason = 'email.complained' THEN terminal_reason ELSE ? END, last_error = ?, updated_at = ? WHERE provider_message_id = ? AND organization_id = ?",
      )
      .bind(event.terminalReason ?? event.eventType, event.detail, now, event.providerMessageId, owner.organizationId)
      .run();
  } else if (event.outcome === "sent") {
    await database
      .prepare(
        "UPDATE messages SET delivery_status = ? WHERE organization_id = ? AND id IN (SELECT message_id FROM outbound_mail_jobs WHERE provider_message_id = ? AND organization_id = ? AND terminal_reason IS NULL)",
      )
      .bind("sent", owner.organizationId, event.providerMessageId, owner.organizationId)
      .run();
  }
  await database
    .prepare("UPDATE provider_webhook_events SET processed_at = ? WHERE provider = ? AND external_event_id = ?")
    .bind(now, event.provider, event.externalEventId)
    .run();
  return { duplicate: false, matched: Boolean(owner) };
}

const cloudflareEventPrefix = "cf.email.sending.message.";

/**
 * Shape of a Cloudflare Email Sending event as it arrives on a Queues event
 * subscription. Only the fields the consumer reads are declared.
 */
export interface CloudflareEmailEvent {
  type: string;
  source?: { type?: string; zoneId?: string; domain?: string };
  payload: { messageId: string; eventId: string; recipient?: string; terminal?: boolean };
  metadata?: { eventTimestamp?: string };
}

const cloudflareEventSchema = z.object({
  type: z.string().startsWith(cloudflareEventPrefix),
  payload: z.object({ messageId: z.string().min(1), eventId: z.string().min(1) }),
});

/**
 * Cloudflare's own vocabulary mapped onto the reason names the rest of the
 * product already uses: `recovery.ts` keys the resend block on `email.complained`.
 */
const cloudflareOutcomes: Record<string, { outcome: DeliveryOutcome; terminalReason?: string }> = {
  delivered: { outcome: "sent" },
  bounced: { outcome: "failed", terminalReason: "email.bounced" },
  failed: { outcome: "failed", terminalReason: "email.failed" },
  rejected: { outcome: "failed", terminalReason: "email.failed" },
  complained: { outcome: "failed", terminalReason: "email.complained" },
  // Deferred is a retry in progress at Cloudflare, not an outcome: it is
  // recorded for the audit trail and changes no delivery state.
  deferred: { outcome: "noop" },
};

/**
 * Consumes one delivery event. Returns `accepted: false` for a body that is not
 * a recognised event so the caller can acknowledge it instead of retrying it
 * forever, and `matched: false` when no outbound job carries the message id yet
 * so the caller can retry the message; database failures propagate.
 *
 * The subscription is account-internal, so the event's `source` is trusted and
 * only the fields the update needs are validated.
 */
export async function processCloudflareEmailEvent(database: D1Database, body: unknown) {
  const parsed = cloudflareEventSchema.safeParse(body);
  if (!parsed.success) return { accepted: false as const, matched: false };
  const mapping = cloudflareOutcomes[parsed.data.type.slice(cloudflareEventPrefix.length)];
  if (!mapping) return { accepted: false as const, matched: false };
  const result = await applyDeliveryEvent(database, {
    requireMatch: true,
    provider: "cloudflare",
    externalEventId: parsed.data.payload.eventId,
    eventType: parsed.data.type,
    payload: JSON.stringify(body),
    // The send stored an angle-bracketed id; the event carries the bare one.
    providerMessageId: normalizeMessageId(parsed.data.payload.messageId),
    outcome: mapping.outcome,
    terminalReason: mapping.terminalReason,
    detail: `Cloudflare event: ${parsed.data.type}`,
  });
  return { accepted: true as const, matched: result.matched };
}
