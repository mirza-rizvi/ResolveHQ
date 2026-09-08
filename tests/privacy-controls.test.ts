import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { enforceTicketRetention, parseRetentionDays } from "resolve-server/maintenance/retention";
import { request, signup, type TestSession } from "./helpers";

interface SettingsBody {
  mail: { resendConfigured: boolean };
  ai: { available: boolean; enabled: boolean };
}

async function createTicket(session: TestSession, suffix: string) {
  const customerResponse = await request(
    "/customers",
    { method: "POST", body: JSON.stringify({ name: "Retention Customer", email: `retention-${suffix}@example.test` }) },
    session,
  );
  const customer = ((await customerResponse.json()) as { customer: { id: string } }).customer;
  const created = await request(
    "/tickets",
    { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: `Retention ${suffix}`, message: "Keep or delete me" }) },
    session,
  );
  return ((await created.json()) as { ticket: { id: string; version: number } }).ticket;
}

async function closeTicket(session: TestSession, ticket: { id: string; version: number }) {
  const detail = await request(`/tickets/${ticket.id}`, {}, session);
  const version = ((await detail.json()) as { ticket: { version: number } }).ticket.version;
  const response = await request(
    `/tickets/${ticket.id}`,
    { method: "PATCH", body: JSON.stringify({ status: "closed", version }) },
    session,
  );
  expect(response.status).toBe(200);
}

describe("workspace AI opt-in", () => {
  it("blocks assistant calls until an admin enables the workspace, then reports the missing key", async () => {
    const workspace = await signup("ai-gate");

    const blocked = await request(
      "/assistant/draft",
      { method: "POST", body: JSON.stringify({ ticketId: "tkt_missing" }) },
      workspace,
    );
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { code: "ai_disabled" } });

    const enabled = await request(
      "/organization/settings",
      { method: "PATCH", body: JSON.stringify({ aiEnabled: true }) },
      workspace,
    );
    expect(enabled.status).toBe(200);

    const settings = await request("/organization/settings", {}, workspace);
    const body = (await settings.json()) as SettingsBody;
    // The test Worker has no OPENAI_API_KEY, so the feature stays available=false
    // even though this workspace opted in.
    expect(body.ai).toEqual({ available: false, enabled: true });

    const unconfigured = await request(
      "/assistant/draft",
      { method: "POST", body: JSON.stringify({ ticketId: "tkt_missing" }) },
      workspace,
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: { code: "ai_unavailable" } });
  });

  it("rejects an empty settings patch", async () => {
    const workspace = await signup("ai-gate-empty");
    const response = await request(
      "/organization/settings",
      { method: "PATCH", body: JSON.stringify({}) },
      workspace,
    );
    expect(response.status).toBe(400);
  });
});

describe("ticket retention", () => {
  it("deletes only closed tickets past the window and keeps recent ones", async () => {
    const workspace = await signup("retention-sweep");
    const expired = await createTicket(workspace, "expired");
    const recent = await createTicket(workspace, "recent");
    await closeTicket(workspace, expired);
    await closeTicket(workspace, recent);

    const old = Date.now() - 31 * 86_400_000;
    await env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(old, expired.id).run();

    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays("0")).toBeNull();
    expect(parseRetentionDays("nope")).toBeNull();
    expect(parseRetentionDays("30")).toBe(30);

    const deleted = await enforceTicketRetention(env, 30);
    expect(deleted).toBe(1);

    expect((await request(`/tickets/${expired.id}`, {}, workspace)).status).toBe(404);
    expect((await request(`/tickets/${recent.id}`, {}, workspace)).status).toBe(200);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE ticket_id = ?",
    )
      .bind(expired.id)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it("never touches open tickets regardless of age", async () => {
    const workspace = await signup("retention-open");
    const open = await createTicket(workspace, "stale-open");
    await env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - 400 * 86_400_000, open.id)
      .run();
    expect(await enforceTicketRetention(env, 30)).toBe(0);
    expect((await request(`/tickets/${open.id}`, {}, workspace)).status).toBe(200);
  });
});
