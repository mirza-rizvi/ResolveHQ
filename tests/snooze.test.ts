import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processInboundMail } from "resolve-server/mail/queue";
import { runScheduled } from "resolve-server/maintenance/scheduled";
import type { AppBindings } from "resolve-server/types";
import { mimeMessage, request, signup, type TestSession } from "./helpers";

const HOUR = 3_600_000;

interface SnoozeRow {
  snoozedUntil: number | null;
  snoozeStartedAt: number | null;
  snoozeReason: string | null;
  snoozedTotalMs: number;
  slaState: string;
  firstResponseDueAt: number | null;
  resolutionDueAt: number | null;
  version: number;
  status: string;
}

function ticketRow(id: string) {
  return env.DB.prepare(
    "SELECT snoozed_until AS snoozedUntil, snooze_started_at AS snoozeStartedAt, snooze_reason AS snoozeReason, snoozed_total_ms AS snoozedTotalMs, sla_state AS slaState, first_response_due_at AS firstResponseDueAt, resolution_due_at AS resolutionDueAt, version, status FROM tickets WHERE id = ?",
  )
    .bind(id)
    .first<SnoozeRow>();
}

/** Opens a ticket the way a customer does, so it sits in the open queue with a live clock. */
async function inboundTicket(session: TestSession, suffix: string) {
  await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
    .bind(`help-${suffix}@example.test`, session.organizationId)
    .run();
  await processInboundMail(env as AppBindings, {
    raw: mimeMessage({
      id: `<snooze-${suffix}@example.test>`,
      to: `help-${suffix}@example.test`,
      subject: "Waiting on a shipment",
      body: "Any update?",
      from: `customer-${suffix}@example.test`,
    }),
    from: `customer-${suffix}@example.test`,
    to: `help-${suffix}@example.test`,
  });
  const row = await env.DB.prepare("SELECT id FROM tickets WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(session.organizationId)
    .first<{ id: string }>();
  if (!row) throw new Error("Inbound ticket was not created");
  return row.id;
}

/** Threads onto the original message, so the reply lands on the same ticket. */
async function customerReply(suffix: string, messageId: string) {
  await processInboundMail(env as AppBindings, {
    raw: mimeMessage({
      id: messageId,
      to: `help-${suffix}@example.test`,
      subject: "Re: Waiting on a shipment",
      body: "It arrived, thanks.",
      from: `customer-${suffix}@example.test`,
      inReplyTo: `<snooze-${suffix}@example.test>`,
      references: `<snooze-${suffix}@example.test>`,
    }),
    from: `customer-${suffix}@example.test`,
    to: `help-${suffix}@example.test`,
  });
}

describe("ticket snooze", () => {
  it("removes a snoozed ticket from the open queue but keeps it in all", async () => {
    const workspace = await signup("snooze-queues");
    const ticketId = await inboundTicket(workspace, "queues");
    const response = await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + 4 * HOUR, reason: "Waiting on the carrier" }) },
      workspace,
    );
    expect(response.status).toBe(200);

    const open = (await (await request("/tickets?status=open", {}, workspace)).json()) as {
      tickets: Array<{ id: string }>;
    };
    expect(open.tickets.some((ticket) => ticket.id === ticketId)).toBe(false);

    const all = (await (await request("/tickets", {}, workspace)).json()) as { tickets: Array<{ id: string }> };
    expect(all.tickets.some((ticket) => ticket.id === ticketId)).toBe(true);

    const snoozedQueue = (await (await request("/tickets?snoozed=only", {}, workspace)).json()) as {
      tickets: Array<{ id: string }>;
    };
    expect(snoozedQueue.tickets.map((ticket) => ticket.id)).toEqual([ticketId]);

    const counts = (await (await request("/tickets/counts", {}, workspace)).json()) as {
      counts: { snoozed: number };
    };
    expect(counts.counts.snoozed).toBe(1);

    const row = await ticketRow(ticketId);
    expect(row?.snoozeReason).toBe("Waiting on the carrier");
    expect(row?.snoozeStartedAt).not.toBeNull();
  });

  it("wakes a ticket on the cron once its time has passed and shifts the SLA targets", async () => {
    const workspace = await signup("snooze-cron");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 120 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "cron");
    const before = await ticketRow(ticketId);
    expect(before?.firstResponseDueAt).not.toBeNull();

    await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + HOUR }) },
      workspace,
    );
    // Backdate the snooze so it started two hours ago and expired one hour ago.
    const startedAt = Date.now() - 2 * HOUR;
    await env.DB.prepare("UPDATE tickets SET snooze_started_at = ?, snoozed_until = ? WHERE id = ?")
      .bind(startedAt, Date.now() - HOUR, ticketId)
      .run();

    await runScheduled(env as AppBindings);
    const after = await ticketRow(ticketId);
    expect(after?.snoozedUntil).toBeNull();
    expect(after?.snoozeStartedAt).toBeNull();
    // The pause is measured from when the snooze began, not from when it expired, so a
    // late cron run does not under-count it.
    const paused = after!.snoozedTotalMs;
    expect(paused).toBeGreaterThanOrEqual(2 * HOUR - 5000);
    expect(after!.firstResponseDueAt!).toBe(before!.firstResponseDueAt! + paused);
  });

  it("wakes a snoozed ticket the moment the customer replies", async () => {
    const workspace = await signup("snooze-reply");
    const ticketId = await inboundTicket(workspace, "reply");
    await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + 24 * HOUR }) },
      workspace,
    );
    expect((await ticketRow(ticketId))?.snoozedUntil).not.toBeNull();

    await customerReply("reply", "<snooze-reply-2@example.test>");

    // The reply must land on the same ticket, not open a new one.
    const ticketCount = await env.DB.prepare("SELECT count(*) AS n FROM tickets WHERE organization_id = ?")
      .bind(workspace.organizationId)
      .first<{ n: number }>();
    expect(ticketCount?.n).toBe(1);

    const after = await ticketRow(ticketId);
    expect(after?.snoozedUntil).toBeNull();
    expect(after?.status).toBe("open");
    const activity = await env.DB.prepare(
      "SELECT actor_type AS actorType FROM activity_logs WHERE organization_id = ? AND event_type = 'ticket.unsnoozed' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(workspace.organizationId)
      .first<{ actorType: string }>();
    expect(activity?.actorType).toBe("customer");
  });

  it("accumulates snoozed time across two consecutive snoozes", async () => {
    const workspace = await signup("snooze-accumulate");
    const ticketId = await inboundTicket(workspace, "accumulate");
    await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + HOUR }) },
      workspace,
    );
    await env.DB.prepare("UPDATE tickets SET snooze_started_at = ? WHERE id = ?")
      .bind(Date.now() - 3 * HOUR, ticketId)
      .run();

    // Re-snoozing banks the first period before starting the second.
    await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + 2 * HOUR }) },
      workspace,
    );
    const middle = await ticketRow(ticketId);
    expect(middle!.snoozedTotalMs).toBeGreaterThanOrEqual(3 * HOUR - 5000);
    expect(middle?.snoozedUntil).not.toBeNull();

    await env.DB.prepare("UPDATE tickets SET snooze_started_at = ? WHERE id = ?")
      .bind(Date.now() - HOUR, ticketId)
      .run();
    await request(`/tickets/${ticketId}/snooze`, { method: "DELETE" }, workspace);
    const final = await ticketRow(ticketId);
    expect(final!.snoozedTotalMs).toBeGreaterThanOrEqual(4 * HOUR - 10_000);
    expect(final?.snoozedUntil).toBeNull();
  });

  it("never promotes a snoozed ticket to due_soon or breached", async () => {
    const workspace = await signup("snooze-noslabreach");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "noslabreach");
    await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + 24 * HOUR }) },
      workspace,
    );
    await env.DB.prepare("UPDATE tickets SET first_response_due_at = ? WHERE id = ?")
      .bind(Date.now() - HOUR, ticketId)
      .run();

    await runScheduled(env as AppBindings);
    expect((await ticketRow(ticketId))?.slaState).toBe("ok");

    const overdue = (await (await request("/tickets?sla=breached", {}, workspace)).json()) as {
      tickets: Array<{ id: string }>;
    };
    expect(overdue.tickets.some((ticket) => ticket.id === ticketId)).toBe(false);
  });

  it("allows snoozing a resolved ticket as a follow-up, and waking does not reopen it", async () => {
    const workspace = await signup("snooze-resolved");
    const ticketId = await inboundTicket(workspace, "resolved");
    await env.DB.prepare("UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?")
      .bind(Date.now(), ticketId)
      .run();
    const response = await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + HOUR }) },
      workspace,
    );
    expect(response.status).toBe(200);

    await env.DB.prepare("UPDATE tickets SET snoozed_until = ?, snooze_started_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, Date.now() - HOUR, ticketId)
      .run();
    await runScheduled(env as AppBindings);
    const after = await ticketRow(ticketId);
    expect(after?.snoozedUntil).toBeNull();
    expect(after?.status).toBe("resolved");
  });

  it("rejects a time in the past, a time beyond a year, and a stale version", async () => {
    const workspace = await signup("snooze-validation");
    const ticketId = await inboundTicket(workspace, "validation");

    const past = await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() - 1000 }) },
      workspace,
    );
    expect(past.status).toBe(400);

    const tooFar = await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + 400 * 24 * HOUR }) },
      workspace,
    );
    expect(tooFar.status).toBe(400);

    const stale = await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + HOUR, version: 999 }) },
      workspace,
    );
    expect(stale.status).toBe(409);
  });

  it("treats unsnoozing an unsnoozed ticket as a no-op", async () => {
    const workspace = await signup("snooze-noop");
    const ticketId = await inboundTicket(workspace, "noop");
    const response = await request(`/tickets/${ticketId}/snooze`, { method: "DELETE" }, workspace);
    expect(response.status).toBe(200);
    expect((await ticketRow(ticketId))?.snoozedTotalMs).toBe(0);
  });

  it("does not let one organization snooze another's ticket", async () => {
    const alpha = await signup("snooze-tenant-alpha");
    const beta = await signup("snooze-tenant-beta");
    const ticketId = await inboundTicket(alpha, "tenant-alpha");

    const response = await request(
      `/tickets/${ticketId}/snooze`,
      { method: "POST", body: JSON.stringify({ until: Date.now() + HOUR }) },
      beta,
    );
    expect(response.status).toBe(404);
    expect((await ticketRow(ticketId))?.snoozedUntil).toBeNull();
  });
});
