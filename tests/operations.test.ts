import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "resolve-server/app";
import { processOutboundMail } from "resolve-server/mail/queue";
import { sendSystemMail } from "resolve-server/mail/system";
import type { AppBindings } from "resolve-server/types";
import { request, signup, type TestSession } from "./helpers";

describe("operational workflows", () => {
  it("protects ticket updates with versions and isolates drafts", async () => {
    const alpha = await signup("operations-alpha");
    const beta = await signup("operations-beta");
    const customerResponse = await request("/customers", { method: "POST", body: JSON.stringify({ name: "Version Customer", email: "version@example.test" }) }, alpha);
    const customer = (await customerResponse.json() as { customer: { id: string } }).customer;
    const created = await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Concurrent update", message: "Initial message" }) }, alpha);
    const ticket = (await created.json() as { ticket: { id: string } }).ticket;
    const detail = await request(`/tickets/${ticket.id}`, {}, alpha);
    const version = (await detail.json() as { ticket: { version: number } }).ticket.version;

    expect((await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ priority: "high", version }) }, alpha)).status).toBe(200);
    expect((await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ priority: "urgent", version }) }, alpha)).status).toBe(409);

    expect((await request(`/operations/tickets/${ticket.id}/draft`, { method: "PUT", body: JSON.stringify({ body: "Private draft", kind: "internal_note", revision: 0 }) }, alpha)).status).toBe(200);
    const draft = await request(`/operations/tickets/${ticket.id}/draft`, {}, alpha);
    expect(await draft.json()).toMatchObject({ draft: { body: "Private draft", revision: 1 } });
    expect((await request(`/operations/tickets/${ticket.id}/draft`, {}, beta)).status).toBe(404);
  });

  it("returns exact aggregate metrics independently of ticket page size", async () => {
    const workspace = await signup("operations-dashboard");
    const customerResponse = await request("/customers", { method: "POST", body: JSON.stringify({ name: "Metrics Customer", email: "metrics@example.test" }) }, workspace);
    const customer = (await customerResponse.json() as { customer: { id: string } }).customer;
    for (let index = 0; index < 55; index += 1) {
      await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: `Metric ${index}`, message: "Measure this ticket" }) }, workspace);
    }
    const list = await request("/tickets", {}, workspace);
    const listBody = await list.json() as { items: unknown[]; hasMore: boolean; nextCursor: string };
    expect(listBody.items).toHaveLength(30);
    expect(listBody.hasMore).toBe(true);
    expect(listBody.nextCursor).toBeTruthy();
    const dashboard = await request("/operations/dashboard", {}, workspace);
    expect(await dashboard.json()).toMatchObject({ metrics: { waitingForCustomer: 55, unassignedTickets: 55 } });
  });

  it("isolates dev-mail captures by organization, lists system mail addressed to the caller, and blocks non-admin roles", async () => {
    const alpha = await signup("dev-mail-alpha");
    const beta = await signup("dev-mail-beta");

    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "alpha-support@example.test" }) }, alpha);
    const alphaCustomer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Alpha Customer", email: "alpha-customer@example.test" }) }, alpha)).json() as { customer: { id: string } }).customer;
    const alphaTicket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: alphaCustomer.id, subject: "Alpha ticket", message: "Hello alpha" }) }, alpha)).json() as { ticket: { id: string } }).ticket;
    const alphaReply = (await (await request(`/tickets/${alphaTicket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Alpha reply", kind: "message" }) }, alpha)).json() as { message: { id: string } }).message;
    const alphaJob = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(alphaReply.id).first<{ id: string }>();
    await processOutboundMail(env as AppBindings, { jobId: alphaJob!.id });

    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "beta-support@example.test" }) }, beta);
    const betaCustomer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Beta Customer", email: "beta-customer@example.test" }) }, beta)).json() as { customer: { id: string } }).customer;
    const betaTicket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: betaCustomer.id, subject: "Beta ticket", message: "Hello beta" }) }, beta)).json() as { ticket: { id: string } }).ticket;
    const betaReply = (await (await request(`/tickets/${betaTicket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Beta reply", kind: "message" }) }, beta)).json() as { message: { id: string } }).message;
    const betaJob = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(betaReply.id).first<{ id: string }>();
    await processOutboundMail(env as AppBindings, { jobId: betaJob!.id });

    // Org-less system mail: one addressed to alpha's own owner email, one addressed to a stranger.
    await sendSystemMail(env as AppBindings, { to: "owner-dev-mail-alpha@example.test", subject: "System notice for alpha", text: "hi" });
    await sendSystemMail(env as AppBindings, { to: "someone-else@example.test", subject: "Not for alpha", text: "hi" });

    const alphaListing = await request("/operations/dev-mail", {}, alpha);
    expect(alphaListing.status).toBe(200);
    const alphaCaptures = ((await alphaListing.json()) as { captures: Array<{ toAddress: string; subject: string }> }).captures;
    expect(alphaCaptures.some((capture) => capture.toAddress === "alpha-customer@example.test")).toBe(true);
    expect(alphaCaptures.some((capture) => capture.toAddress === "beta-customer@example.test")).toBe(false);
    expect(alphaCaptures.some((capture) => capture.subject === "System notice for alpha")).toBe(true);
    expect(alphaCaptures.some((capture) => capture.subject === "Not for alpha")).toBe(false);

    const betaListing = await request("/operations/dev-mail", {}, beta);
    const betaCaptures = ((await betaListing.json()) as { captures: Array<{ toAddress: string }> }).captures;
    expect(betaCaptures.some((capture) => capture.toAddress === "beta-customer@example.test")).toBe(true);
    expect(betaCaptures.some((capture) => capture.toAddress === "alpha-customer@example.test")).toBe(false);

    const inviteResponse = await request("/organization/invitations", { method: "POST", body: JSON.stringify({ email: "dev-mail-agent@example.test", role: "agent" }) }, alpha);
    expect(inviteResponse.status).toBe(201);
    const invite = (await inviteResponse.json()) as { invitation: { inviteUrl: string } };
    const token = new URL(invite.invitation.inviteUrl).searchParams.get("token")!;
    const acceptResponse = await request("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token, name: "Agent Person", password: "a-secure-test-password" }) });
    expect(acceptResponse.status).toBe(201);
    const acceptBody = (await acceptResponse.json()) as { user: { id: string }; organizationId: string; csrfToken: string };
    const cookies = acceptResponse.headers.get("set-cookie") ?? "";
    const found = [...cookies.matchAll(/(resolvehq_(?:session|csrf))=([^;,]+)/g)];
    const agentSession: TestSession = { cookie: found.map((match) => `${match[1]}=${match[2]}`).join("; "), csrf: acceptBody.csrfToken, userId: acceptBody.user.id, organizationId: acceptBody.organizationId };

    const agentListing = await request("/operations/dev-mail", {}, agentSession);
    expect(agentListing.status).toBe(403);
  });

  it("returns 404 for GET /operations/dev-mail when capture mode is disabled or Resend is configured", async () => {
    const workspace = await signup("dev-mail-disabled");

    const disabledResponse = await app.request("http://localhost:8787/api/operations/dev-mail", { headers: { cookie: workspace.cookie } }, { ...env, DEV_MAIL_MODE: "disabled" });
    expect(disabledResponse.status).toBe(404);

    const resendConfiguredResponse = await app.request("http://localhost:8787/api/operations/dev-mail", { headers: { cookie: workspace.cookie } }, { ...env, RESEND_API_KEY: "re_test_key" });
    expect(resendConfiguredResponse.status).toBe(404);
  });

  it("bulk updates refuse cross-tenant assignees and report skipped tickets", async () => {
    const alpha = await signup("bulk-alpha");
    const beta = await signup("bulk-beta");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "B", email: "b@example.test" }) }, alpha)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Bulk", message: "x" }) }, alpha)).json() as { ticket: { id: string } }).ticket;
    const crossTenant = await request("/operations/tickets/bulk", { method: "POST", body: JSON.stringify({ ticketIds: [ticket.id], assignedUserId: beta.userId }) }, alpha);
    expect(crossTenant.status).toBe(404);
    const result = await (await request("/operations/tickets/bulk", { method: "POST", body: JSON.stringify({ ticketIds: [ticket.id, "tkt_missing"], status: "resolved" }) }, alpha)).json() as { updated: number; skipped: Array<{ ticketId: string }> };
    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual([{ ticketId: "tkt_missing", reason: "ticket_not_found" }]);
    const row = await env.DB.prepare("SELECT resolved_at AS resolvedAt, version FROM tickets WHERE id = ?").bind(ticket.id).first<{ resolvedAt: number | null; version: number }>();
    expect(row?.resolvedAt).not.toBeNull(); expect(row?.version).toBe(2);
  });

  it("rejects a bulk update for an unknown team before writing any ticket", async () => {
    const workspace = await signup("bulk-team");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "T", email: "t@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Team bulk", message: "x" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    const before = await env.DB.prepare("SELECT version FROM tickets WHERE id = ?").bind(ticket.id).first<{ version: number }>();
    const response = await request("/operations/tickets/bulk", { method: "POST", body: JSON.stringify({ ticketIds: [ticket.id], assignedTeamId: "tem_missing" }) }, workspace);
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("team_not_found");
    const after = await env.DB.prepare("SELECT version FROM tickets WHERE id = ?").bind(ticket.id).first<{ version: number }>();
    expect(after?.version).toBe(before?.version);
  });

  it("reports queue counts and de-duplicates saved views", async () => {
    const workspace = await signup("counts");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "C", email: "c@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "One", message: "x" }) }, workspace);
    const counts = (await (await request("/tickets/counts", {}, workspace)).json() as { counts: Record<string, number> }).counts;
    expect(counts).toMatchObject({ all: 1, waiting_customer: 1, open: 0, unassigned: 1, mine: 0 });
    const first = await request("/operations/views", { method: "POST", body: JSON.stringify({ name: "Open tickets", filters: { status: "open" } }) }, workspace);
    const second = await request("/operations/views", { method: "POST", body: JSON.stringify({ name: "Open tickets", filters: { status: "open" } }) }, workspace);
    expect(first.status).toBe(201); expect(second.status).toBe(200);
    const views = (await (await request("/operations/views", {}, workspace)).json() as { views: Array<{ id: string }> }).views;
    expect(views).toHaveLength(1);
    expect((await request(`/operations/views/${views[0].id}`, { method: "DELETE" }, workspace)).status).toBe(204);
  });
});
