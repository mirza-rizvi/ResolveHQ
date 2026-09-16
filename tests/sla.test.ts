import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addBusinessMinutes, businessMinutesBetween, type BusinessHours } from "resolve-server/sla/policy";
import { processInboundMail } from "resolve-server/mail/queue";
import { runScheduled } from "resolve-server/maintenance/scheduled";
import type { AppBindings } from "resolve-server/types";
import { mimeMessage, request, signup, type TestSession } from "./helpers";

const weekday = (day: number) => ({ day, start: "09:00", end: "17:00" });

/** Monday–Friday, 09:00–17:00, London — the timezone whose DST shifts we assert on. */
const london: BusinessHours = {
  timezone: "Europe/London",
  days: [1, 2, 3, 4, 5].map(weekday),
  holidays: [],
};

/** Formats an instant as wall-clock local time, which is what these targets are really about. */
function wall(ms: number, timezone = "Europe/London") {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Builds an instant from wall-clock local time in a timezone, so tests read as humans think. */
function at(local: string, timezone = "Europe/London") {
  const guess = Date.parse(`${local.replace(" ", "T")}:00Z`);
  // Correct the guess by the zone's offset at that moment, then once more in case the
  // correction crossed a DST boundary.
  let ms = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const formatted = wall(ms, timezone);
    const drift = Date.parse(`${formatted.replace(" ", "T")}:00Z`) - guess;
    ms -= drift;
  }
  return ms;
}

describe("addBusinessMinutes", () => {
  it("adds within a single working day", () => {
    // Wednesday 10:00 + 120 business minutes → 12:00 the same day.
    expect(wall(addBusinessMinutes(at("2026-03-04 10:00"), 120, london))).toBe("2026-03-04 12:00");
  });

  it("spills into the next working day", () => {
    // Wednesday 16:00 + 120 → one hour today, one hour from Thursday 09:00.
    expect(wall(addBusinessMinutes(at("2026-03-04 16:00"), 120, london))).toBe("2026-03-05 10:00");
  });

  it("skips the weekend", () => {
    // Friday 17:00 is the close of business; 60 minutes lands on Monday morning.
    expect(wall(addBusinessMinutes(at("2026-03-06 17:00"), 60, london))).toBe("2026-03-09 10:00");
  });

  it("skips a configured holiday", () => {
    const withHoliday: BusinessHours = { ...london, holidays: ["2026-03-05"] };
    // Wednesday 16:30 + 60: 30 minutes today, Thursday is a holiday, rest on Friday.
    expect(wall(addBusinessMinutes(at("2026-03-04 16:30"), 60, withHoliday))).toBe("2026-03-06 09:30");
  });

  it("starts the clock when the window opens if the ticket arrived before it", () => {
    expect(wall(addBusinessMinutes(at("2026-03-04 06:00"), 30, london))).toBe("2026-03-04 09:30");
  });

  it("starts the clock next morning if the ticket arrived after the window closed", () => {
    expect(wall(addBusinessMinutes(at("2026-03-04 22:00"), 30, london))).toBe("2026-03-05 09:30");
  });

  it("adds plain wall-clock time when no business hours are configured", () => {
    const from = at("2026-03-07 22:00");
    expect(addBusinessMinutes(from, 90, null)).toBe(from + 90 * 60_000);
  });

  it("terminates instead of hanging when every day is non-working", () => {
    const closed: BusinessHours = { timezone: "Europe/London", days: [], holidays: [] };
    const from = at("2026-03-04 10:00");
    const result = addBusinessMinutes(from, 60, closed);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(from);
  });

  it("skips a day configured with its end before its start", () => {
    const broken: BusinessHours = {
      timezone: "Europe/London",
      days: [{ day: 3, start: "17:00", end: "09:00" }, weekday(4)],
      holidays: [],
    };
    // Wednesday is misconfigured, so the clock starts on Thursday morning.
    expect(wall(addBusinessMinutes(at("2026-03-04 10:00"), 60, broken))).toBe("2026-03-05 10:00");
  });
});

describe("addBusinessMinutes across DST transitions", () => {
  // Europe/London springs forward 2026-03-29 01:00 → 02:00 (a 23-hour day) and
  // falls back 2026-10-25 02:00 → 01:00 (a 25-hour day). Both land on a Sunday,
  // so the business window either side is Friday and Monday.
  it("keeps wall-clock targets correct across the spring-forward", () => {
    // Friday 2026-03-27 16:30 + 60 business minutes → Monday 2026-03-30 09:30 local.
    const due = addBusinessMinutes(at("2026-03-27 16:30"), 60, london);
    expect(wall(due)).toBe("2026-03-30 09:30");
    // The same instant in UTC is 08:30, because London is now BST (UTC+1).
    expect(wall(due, "UTC")).toBe("2026-03-30 08:30");
  });

  it("keeps wall-clock targets correct across the autumn-back", () => {
    // Friday 2026-10-23 16:30 + 60 → Monday 2026-10-26 09:30 local.
    const due = addBusinessMinutes(at("2026-10-23 16:30"), 60, london);
    expect(wall(due)).toBe("2026-10-26 09:30");
    // London is back on GMT (UTC+0), so the UTC wall-clock matches.
    expect(wall(due, "UTC")).toBe("2026-10-26 09:30");
  });

  it("does not drift when a multi-day target spans the spring-forward", () => {
    // Thursday 2026-03-26 16:00 + 8 hours of business time: 1h Thursday, 7h Friday.
    expect(wall(addBusinessMinutes(at("2026-03-26 16:00"), 480, london))).toBe("2026-03-27 16:00");
    // Exhausting Friday too (1h Thursday + 8h Friday = 540) lands on Friday's close,
    // and one minute beyond it rolls over the weekend and the clock change into Monday.
    expect(wall(addBusinessMinutes(at("2026-03-26 16:00"), 540, london))).toBe("2026-03-27 17:00");
    expect(wall(addBusinessMinutes(at("2026-03-26 16:00"), 541, london))).toBe("2026-03-30 09:01");
  });

  it("handles a timezone whose DST runs the other way round", () => {
    const sydney: BusinessHours = {
      timezone: "Australia/Sydney",
      days: [1, 2, 3, 4, 5].map(weekday),
      holidays: [],
    };
    // Sydney falls back 2026-04-05. Friday 2026-04-03 16:30 + 60 → Monday 09:30 local.
    const due = addBusinessMinutes(at("2026-04-03 16:30", "Australia/Sydney"), 60, sydney);
    expect(wall(due, "Australia/Sydney")).toBe("2026-04-06 09:30");
  });
});

describe("businessMinutesBetween", () => {
  it("counts only time inside the working window", () => {
    // Wednesday 16:00 → Thursday 10:00 is one hour today plus one hour tomorrow.
    expect(businessMinutesBetween(at("2026-03-04 16:00"), at("2026-03-05 10:00"), london)).toBe(120);
  });

  it("counts nothing across a weekend", () => {
    expect(businessMinutesBetween(at("2026-03-07 09:00"), at("2026-03-08 17:00"), london)).toBe(0);
  });

  it("returns zero when the range is inverted", () => {
    expect(businessMinutesBetween(at("2026-03-05 10:00"), at("2026-03-04 10:00"), london)).toBe(0);
  });

  it("is the inverse of addBusinessMinutes across a weekend", () => {
    const from = at("2026-03-06 16:30");
    expect(businessMinutesBetween(from, addBusinessMinutes(from, 200, london), london)).toBe(200);
  });
});

describe("SLA integration", () => {
  /** Creates a customer and returns its id, so tickets can be opened through the API. */
  async function customerFor(session: TestSession, email: string) {
    const response = await request(
      "/customers",
      { method: "POST", body: JSON.stringify({ name: "Casey Customer", email }) },
      session,
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { customer: { id: string } }).customer.id;
  }

  async function ticketRow(id: string) {
    return env.DB.prepare(
      "SELECT sla_state AS slaState, sla_policy_id AS slaPolicyId, first_response_due_at AS firstResponseDueAt, resolution_due_at AS resolutionDueAt, first_response_at AS firstResponseAt, created_at AS createdAt FROM tickets WHERE id = ?",
    )
      .bind(id)
      .first<{
        slaState: string;
        slaPolicyId: string | null;
        firstResponseDueAt: number | null;
        resolutionDueAt: number | null;
        firstResponseAt: number | null;
        createdAt: number;
      }>();
  }

  /** Opens a ticket the way a customer does, so the first-response clock is actually running. */
  async function inboundTicket(session: TestSession, suffix: string) {
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
      .bind(`help-${suffix}@example.test`, session.organizationId)
      .run();
    await processInboundMail(env as AppBindings, {
      raw: mimeMessage({
        id: `<sla-${suffix}@example.test>`,
        to: `help-${suffix}@example.test`,
        subject: "Checkout cannot complete",
        body: "The spinner never stops.",
      }),
      from: `customer-${suffix}@example.test`,
      to: `help-${suffix}@example.test`,
    });
    const row = await env.DB.prepare(
      "SELECT id FROM tickets WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(session.organizationId)
      .first<{ id: string }>();
    if (!row) throw new Error("Inbound ticket was not created");
    return row.id;
  }

  it("leaves sla_state as none when no policy is configured", async () => {
    const workspace = await signup("sla-nopolicy");
    const customerId = await customerFor(workspace, "sla-nopolicy@example.test");
    const response = await request(
      "/tickets",
      { method: "POST", body: JSON.stringify({ customerId, subject: "Hello", message: "Hi" }) },
      workspace,
    );
    const ticket = ((await response.json()) as { ticket: { id: string } }).ticket;
    const row = await ticketRow(ticket.id);
    expect(row?.slaState).toBe("none");
    expect(row?.firstResponseDueAt).toBeNull();
    expect(row?.slaPolicyId).toBeNull();
  });

  it("applies a matching priority policy over the workspace default", async () => {
    const workspace = await signup("sla-priority");
    const asDefault = await request(
      "/sla/policies",
      {
        method: "POST",
        body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 480 }),
      },
      workspace,
    );
    expect(asDefault.status).toBe(201);
    const urgent = await request(
      "/sla/policies",
      {
        method: "POST",
        body: JSON.stringify({ name: "Urgent", priority: "urgent", firstResponseMinutes: 60, resolutionMinutes: 240 }),
      },
      workspace,
    );
    expect(urgent.status).toBe(201);
    const urgentId = ((await urgent.json()) as { policy: { id: string } }).policy.id;

    const customerId = await customerFor(workspace, "sla-priority@example.test");
    const response = await request(
      "/tickets",
      {
        method: "POST",
        body: JSON.stringify({ customerId, subject: "Down", message: "Everything is down", priority: "urgent" }),
      },
      workspace,
    );
    const ticket = ((await response.json()) as { ticket: { id: string } }).ticket;
    const row = await ticketRow(ticket.id);
    expect(row?.slaPolicyId).toBe(urgentId);
    expect(row?.slaState).toBe("ok");
    // 24/7 by default: 60 minutes after creation.
    expect(row?.firstResponseDueAt).toBe(row!.createdAt + 60 * 60_000);
    expect(row?.resolutionDueAt).toBe(row!.createdAt + 240 * 60_000);
    // An agent-opened ticket ships with the agent's message, so the response already happened.
    expect(row?.firstResponseAt).not.toBeNull();
  });

  it("refuses a second default policy and a second policy for the same priority", async () => {
    const workspace = await signup("sla-unique");
    const first = await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 480 }) },
      workspace,
    );
    expect(first.status).toBe(201);
    const second = await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Another default", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    expect(second.status).toBe(409);

    const high = await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "High", priority: "high", firstResponseMinutes: 120 }) },
      workspace,
    );
    expect(high.status).toBe(201);
    const highAgain = await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "High again", priority: "high", firstResponseMinutes: 30 }) },
      workspace,
    );
    expect(highAgain.status).toBe(409);
  });

  it("promotes ok to due_soon and then to breached on the cron", async () => {
    const workspace = await signup("sla-promote");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "promote");
    expect((await ticketRow(ticketId))?.slaState).toBe("ok");

    // Backdate creation so the ticket is past 75% of its window but not yet due.
    const created = Date.now() - 50 * 60_000;
    await env.DB.prepare("UPDATE tickets SET created_at = ?, first_response_due_at = ? WHERE id = ?")
      .bind(created, created + 60 * 60_000, ticketId)
      .run();
    await runScheduled(env as AppBindings);
    expect((await ticketRow(ticketId))?.slaState).toBe("due_soon");

    await env.DB.prepare("UPDATE tickets SET first_response_due_at = ? WHERE id = ?")
      .bind(Date.now() - 60_000, ticketId)
      .run();
    await runScheduled(env as AppBindings);
    expect((await ticketRow(ticketId))?.slaState).toBe("breached");
  });

  it("stops promoting once an agent has replied", async () => {
    const workspace = await signup("sla-replied");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "replied");
    const reply = await request(
      `/tickets/${ticketId}/messages`,
      { method: "POST", body: JSON.stringify({ body: "Looking into it now.", kind: "message" }) },
      workspace,
    );
    expect(reply.status).toBe(201);
    expect((await ticketRow(ticketId))?.firstResponseAt).not.toBeNull();

    await env.DB.prepare("UPDATE tickets SET first_response_due_at = ? WHERE id = ?")
      .bind(Date.now() - 60_000, ticketId)
      .run();
    await runScheduled(env as AppBindings);
    expect((await ticketRow(ticketId))?.slaState).toBe("ok");
  });

  it("does not let an internal note count as the first response", async () => {
    const workspace = await signup("sla-note");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "note");
    await request(
      `/tickets/${ticketId}/messages`,
      { method: "POST", body: JSON.stringify({ body: "Internal only.", kind: "internal_note" }) },
      workspace,
    );
    expect((await ticketRow(ticketId))?.firstResponseAt).toBeNull();
  });

  it("recomputes from created_at on a priority change, so a toggle cannot clear a breach", async () => {
    const workspace = await signup("sla-recompute");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 600 }) },
      workspace,
    );
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Urgent", priority: "urgent", firstResponseMinutes: 30 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "recompute");
    const before = await ticketRow(ticketId);
    expect(before?.firstResponseDueAt).toBe(before!.createdAt + 600 * 60_000);

    const patched = await request(
      `/tickets/${ticketId}`,
      { method: "PATCH", body: JSON.stringify({ priority: "urgent" }) },
      workspace,
    );
    expect(patched.status).toBe(200);
    const after = await ticketRow(ticketId);
    // Anchored to created_at, not to the moment of the change.
    expect(after?.firstResponseDueAt).toBe(before!.createdAt + 30 * 60_000);
  });

  it("never promotes a snoozed ticket", async () => {
    const workspace = await signup("sla-snoozed");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "snoozed");
    await env.DB.prepare("UPDATE tickets SET first_response_due_at = ?, snoozed_until = ? WHERE id = ?")
      .bind(Date.now() - 60_000, Date.now() + 3_600_000, ticketId)
      .run();
    await runScheduled(env as AppBindings);
    expect((await ticketRow(ticketId))?.slaState).toBe("ok");
  });

  it("returns exactly the breached, non-snoozed tickets in the Overdue queue", async () => {
    const workspace = await signup("sla-queue");
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    const breachedId = await inboundTicket(workspace, "queue-breached");
    const healthyId = await inboundTicket(workspace, "queue-healthy");
    await env.DB.prepare("UPDATE tickets SET sla_state = 'breached' WHERE id = ?").bind(breachedId).run();

    const response = await request("/tickets?sla=breached", {}, workspace);
    const body = (await response.json()) as { tickets: Array<{ id: string }> };
    expect(body.tickets.map((ticket) => ticket.id)).toEqual([breachedId]);
    expect(body.tickets.some((ticket) => ticket.id === healthyId)).toBe(false);

    const counts = (await (await request("/tickets/counts", {}, workspace)).json()) as {
      counts: { overdue: number; due_soon: number };
    };
    expect(counts.counts.overdue).toBe(1);
  });

  it("keeps SLA policies and business hours scoped to one organization", async () => {
    const alpha = await signup("sla-tenant-alpha");
    const beta = await signup("sla-tenant-beta");
    const created = await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Alpha only", priority: null, firstResponseMinutes: 60 }) },
      alpha,
    );
    expect(created.status).toBe(201);
    const policyId = ((await created.json()) as { policy: { id: string } }).policy.id;

    const betaView = (await (await request("/sla", {}, beta)).json()) as { policies: Array<{ id: string }> };
    expect(betaView.policies).toHaveLength(0);

    const betaDelete = await request(`/sla/policies/${policyId}`, { method: "DELETE" }, beta);
    expect(betaDelete.status).toBe(404);

    // Beta may reuse the same default slot; uniqueness is per workspace, not global.
    const betaDefault = await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Beta default", priority: null, firstResponseMinutes: 120 }) },
      beta,
    );
    expect(betaDefault.status).toBe(201);
  });

  it("refuses SLA configuration changes from a non-admin", async () => {
    const workspace = await signup("sla-role");
    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();
    const response = await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Nope", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    expect(response.status).toBe(403);
  });

  it("stores business hours and uses them for due dates", async () => {
    const workspace = await signup("sla-hours");
    const saved = await request(
      "/sla/business-hours",
      {
        method: "PUT",
        body: JSON.stringify({
          timezone: "Europe/London",
          days: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
          holidays: [],
        }),
      },
      workspace,
    );
    expect(saved.status).toBe(200);
    await request(
      "/sla/policies",
      { method: "POST", body: JSON.stringify({ name: "Standard", priority: null, firstResponseMinutes: 60 }) },
      workspace,
    );
    const ticketId = await inboundTicket(workspace, "hours");
    const row = await ticketRow(ticketId);
    // Business hours are in force, so the due date is no longer created_at + 60 minutes
    // unless the ticket happened to arrive inside the window with an hour to spare.
    expect(row?.firstResponseDueAt).not.toBeNull();
    expect(row!.firstResponseDueAt!).toBeGreaterThanOrEqual(row!.createdAt);
    expect(
      businessMinutesBetween(row!.createdAt, row!.firstResponseDueAt!, {
        timezone: "Europe/London",
        days: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
        holidays: [],
      }),
    ).toBe(60);
  });

  it("rejects a timezone the server does not recognise", async () => {
    const workspace = await signup("sla-badzone");
    const response = await request(
      "/sla/business-hours",
      {
        method: "PUT",
        body: JSON.stringify({ timezone: "Mars/Olympus", days: [{ day: 1, start: "09:00", end: "17:00" }], holidays: [] }),
      },
      workspace,
    );
    expect(response.status).toBe(400);
  });
});
