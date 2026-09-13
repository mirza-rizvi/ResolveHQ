import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../worker";
import type { AppBindings } from "../src/server/types";
import { request, signup } from "./helpers";

const eventsQueue = "resolvehq-email-events";

function event(kind: string, messageId: string, eventId: string) {
  return {
    type: `cf.email.sending.message.${kind}`,
    source: { type: "email.sending", zoneId: "zone_1", domain: "acme.test" },
    payload: {
      messageId,
      eventId,
      sender: "support@acme.test",
      recipient: "customer@example.test",
      terminal: kind !== "deferred",
      delivery: { status: kind },
    },
    metadata: { eventTimestamp: new Date().toISOString() },
  };
}

async function deliver(body: unknown, queue = eventsQueue, bindings: AppBindings = env) {
  const message = { body, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date(), attempts: 1 };
  await worker.queue({ queue, messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as never, bindings as never);
  return message;
}

/** Two tenants whose messages carry the same provider id; only alpha's job records it. */
async function tenants(suffix: string, providerMessageId: string) {
  const messageIds: Record<string, string> = {};
  const sessions: Record<string, Awaited<ReturnType<typeof signup>>> = {};
  for (const name of ["alpha", "beta"]) {
    const session = await signup(`${suffix}-${name}`);
    sessions[name] = session;
    const customer = (await (
      await request(
        "/customers",
        { method: "POST", body: JSON.stringify({ name: `Customer ${name}`, email: `${suffix}-${name}@example.test` }) },
        session,
      )
    ).json()) as { customer: { id: string } };
    const created = await request(
      "/tickets",
      {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.customer.id,
          subject: `Subject ${name}`,
          message: `Hello ${name}`,
        }),
      },
      session,
    );
    expect(created.status).toBe(201);
    const { ticket } = (await created.json()) as { ticket: { id: string } };
    const row = await env.DB.prepare("SELECT id FROM messages WHERE organization_id = ? AND ticket_id = ?")
      .bind(session.organizationId, ticket.id)
      .first<{ id: string }>();
    messageIds[name] = row!.id;
  }
  await env.DB.prepare("UPDATE messages SET provider_message_id = ? WHERE id IN (?, ?)")
    .bind(providerMessageId, messageIds.alpha, messageIds.beta)
    .run();
  await env.DB.prepare("UPDATE outbound_mail_jobs SET provider_message_id = ? WHERE message_id = ?")
    .bind(providerMessageId, messageIds.alpha)
    .run();
  return { messageIds, sessions };
}

function deliveryStatus(messageId: string) {
  return env.DB.prepare("SELECT delivery_status AS status FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ status: string }>();
}

describe("cloudflare email delivery events", () => {
  it("marks the owning tenant's message delivered and leaves another tenant alone", async () => {
    const { messageIds } = await tenants("cf-delivered", "<cf-delivered@mail.example>");
    // The event payload carries the bare id; the consumer normalises it the way the send did.
    const message = await deliver(event("delivered", "cf-delivered@mail.example", "evt_cf_delivered"));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("sent");
    expect((await deliveryStatus(messageIds.beta))?.status).toBe("queued");
  });

  it("stops the job with the bounce reason", async () => {
    const { messageIds } = await tenants("cf-bounced", "<cf-bounced@mail.example>");
    await deliver(event("bounced", "cf-bounced@mail.example", "evt_cf_bounced"));
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("failed");
    expect((await deliveryStatus(messageIds.beta))?.status).toBe("queued");
    expect(
      await env.DB.prepare("SELECT status, terminal_reason AS reason FROM outbound_mail_jobs WHERE message_id = ?")
        .bind(messageIds.alpha)
        .first(),
    ).toMatchObject({ status: "failed", reason: "email.bounced" });
  });

  it("stops only the owning tenant's job when two tenants hold the same provider id", async () => {
    const providerMessageId = "<cf-shared@mail.example>";
    const { messageIds } = await tenants("cf-shared", providerMessageId);
    // A provider id is only unique within one tenant. Both jobs carry it here;
    // the oldest owns it, and the other tenant's job must not be touched.
    await env.DB.prepare("UPDATE outbound_mail_jobs SET provider_message_id = ? WHERE message_id = ?")
      .bind(providerMessageId, messageIds.beta)
      .run();
    await env.DB.prepare("UPDATE outbound_mail_jobs SET created_at = ? WHERE message_id = ?")
      .bind(1, messageIds.alpha)
      .run();
    await env.DB.prepare("UPDATE outbound_mail_jobs SET created_at = ? WHERE message_id = ?")
      .bind(2, messageIds.beta)
      .run();
    await deliver(event("bounced", "cf-shared@mail.example", "evt_cf_shared"));
    expect(
      await env.DB.prepare("SELECT status, terminal_reason AS reason FROM outbound_mail_jobs WHERE message_id = ?")
        .bind(messageIds.alpha)
        .first(),
    ).toMatchObject({ status: "failed", reason: "email.bounced" });
    expect(
      await env.DB.prepare("SELECT status, terminal_reason AS reason FROM outbound_mail_jobs WHERE message_id = ?")
        .bind(messageIds.beta)
        .first(),
    ).toMatchObject({ status: "pending", reason: null });
    expect((await deliveryStatus(messageIds.beta))?.status).toBe("queued");
  });

  it("retries an event that arrives before the job records its provider id", async () => {
    const { messageIds } = await tenants("cf-race", "<cf-race-other@mail.example>");
    const early = await deliver(event("bounced", "cf-race@mail.example", "evt_cf_race"));
    expect(early.retry).toHaveBeenCalledOnce();
    expect(early.ack).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT processed_at AS processedAt FROM provider_webhook_events WHERE provider = 'cloudflare' AND external_event_id = ?",
      )
        .bind("evt_cf_race")
        .first(),
    ).toEqual({ processedAt: null });
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("queued");
    // The send's write lands, and the redelivered event is applied rather than
    // deduped away.
    await env.DB.prepare("UPDATE outbound_mail_jobs SET provider_message_id = ? WHERE message_id = ?")
      .bind("<cf-race@mail.example>", messageIds.alpha)
      .run();
    const later = await deliver(event("bounced", "cf-race@mail.example", "evt_cf_race"));
    expect(later.ack).toHaveBeenCalledOnce();
    expect(later.retry).not.toHaveBeenCalled();
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("failed");
  });

  it("keeps the complaint reason so the job stays blocked from resending", async () => {
    const { messageIds } = await tenants("cf-complained", "<cf-complained@mail.example>");
    await deliver(event("complained", "cf-complained@mail.example", "evt_cf_complained"));
    await deliver(event("bounced", "cf-complained@mail.example", "evt_cf_complained_later"));
    expect(
      await env.DB.prepare("SELECT terminal_reason AS reason FROM outbound_mail_jobs WHERE message_id = ?")
        .bind(messageIds.alpha)
        .first(),
    ).toMatchObject({ reason: "email.complained" });
  });

  it("ignores a replayed event id", async () => {
    const { messageIds } = await tenants("cf-replay", "<cf-replay@mail.example>");
    await deliver(event("delivered", "cf-replay@mail.example", "evt_cf_replay"));
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("sent");
    // Same event id, different outcome: at-least-once redelivery must not rewrite state.
    const replay = await deliver(event("bounced", "cf-replay@mail.example", "evt_cf_replay"));
    expect(replay.ack).toHaveBeenCalledOnce();
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("sent");
  });

  it("records a deferred event without changing delivery state", async () => {
    const { messageIds } = await tenants("cf-deferred", "<cf-deferred@mail.example>");
    await deliver(event("deferred", "cf-deferred@mail.example", "evt_cf_deferred"));
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("queued");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM provider_webhook_events WHERE provider = 'cloudflare' AND external_event_id = ?",
      )
        .bind("evt_cf_deferred")
        .first(),
    ).toEqual({ n: 1 });
  });

  it("acknowledges a malformed event instead of retrying it forever", async () => {
    const message = await deliver({ type: "cf.email.sending.message.delivered", payload: {} });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const unrelated = await deliver({ kind: "not-an-email-event" });
    expect(unrelated.ack).toHaveBeenCalledOnce();
    expect(unrelated.retry).not.toHaveBeenCalled();
  });

  it("acknowledges dead-lettered delivery events without touching mail jobs", async () => {
    const { messageIds } = await tenants("cf-dlq", "<cf-dlq@mail.example>");
    const message = await deliver(event("delivered", "cf-dlq@mail.example", "evt_cf_dlq"), `${eventsQueue}-dlq`);
    expect(message.ack).toHaveBeenCalledOnce();
    expect((await deliveryStatus(messageIds.alpha))?.status).toBe("queued");
    expect(
      await env.DB.prepare("SELECT terminal_reason AS reason FROM outbound_mail_jobs WHERE message_id = ?")
        .bind(messageIds.alpha)
        .first(),
    ).toMatchObject({ reason: null });
  });
});
