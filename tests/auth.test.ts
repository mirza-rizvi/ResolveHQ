import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { hashPassword, verifyPassword } from "resolve-server/auth/password";
import { login, request, signup } from "./helpers";

describe("authentication", () => {
  it("hashes passwords with a unique salt and verifies them", async () => {
    const first = await hashPassword("correct horse battery staple", env.SESSION_PEPPER);
    const second = await hashPassword("correct horse battery staple", env.SESSION_PEPPER);
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery staple", first, env.SESSION_PEPPER)).toBe(true);
    expect(await verifyPassword("wrong password", first, env.SESSION_PEPPER)).toBe(false);
  });

  it("keeps the documented local demo credential in sync with the seed", async () => {
    const seededHash = "pbkdf2-sha256$310000$5YVp6WPqIjWJg4XXdTp-hg$tBZNVDTyqpuZWFVeu3sjpTjVX-05QRkhCDw5HLI-Guk";
    expect(await verifyPassword(
      "resolve-demo-2026",
      seededHash,
      "replace-with-at-least-32-random-characters",
    )).toBe(true);
  });

  it("creates an owner session and rejects mutation without CSRF", async () => {
    const session = await signup("auth");
    const me = await request("/auth/me", {}, session);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: "owner", organization: { id: session.organizationId } });
    const rejected = await request("/customers", { method: "POST", body: JSON.stringify({ name: "No CSRF", email: "no-csrf@example.test" }), headers: { cookie: session.cookie, origin: env.APP_URL } });
    expect(rejected.status).toBe(403);
  });

  it("resets a password through a captured email link and invalidates old sessions", async () => {
    const workspace = await signup("reset");
    const email = "owner-reset@example.test";
    expect((await request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) })).status).toBe(200);
    const capture = await env.DB.prepare("SELECT text FROM mail_captures WHERE to_address = ? ORDER BY created_at DESC LIMIT 1").bind(email).first<{ text: string }>();
    const token = /token=([A-Za-z0-9_-]+)/.exec(capture!.text)![1];
    expect((await request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password: "a-brand-new-password-1" }) })).status).toBe(200);
    expect((await request("/auth/me", {}, workspace)).status).toBe(401);
    expect((await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "a-secure-test-password" }) })).status).toBe(401);
    expect((await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "a-brand-new-password-1" }) })).status).toBe(200);
    expect((await request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password: "another-new-password-2" }) })).status).toBe(404);
  });

  it("changes a password with the current one", async () => {
    const workspace = await signup("change");
    const email = "owner-change@example.test";
    const secondSession = await login(email, "a-secure-test-password");
    expect((await request("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: "wrong-password-value", newPassword: "a-brand-new-password-3" }) }, workspace)).status).toBe(401);
    expect((await request("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: "a-secure-test-password", newPassword: "a-brand-new-password-3" }) }, workspace)).status).toBe(200);
    expect((await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "a-brand-new-password-3" }) })).status).toBe(200);
    expect((await request("/auth/me", {}, workspace)).status).toBe(200);
    expect((await request("/auth/me", {}, secondSession)).status).toBe(401);
  });

  it("lets an existing user accept an invitation and switch workspaces", async () => {
    const host = await signup("invite-host");
    const guest = await signup("invite-guest");
    const invitation = await (await request("/organization/invitations", { method: "POST", body: JSON.stringify({ email: "owner-invite-guest@example.test", role: "agent" }) }, host)).json() as { invitation: { inviteUrl: string } };
    const token = new URL(invitation.invitation.inviteUrl).searchParams.get("token")!;
    expect((await request("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token }) }, host)).status).toBe(409);
    const accepted = await request("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token }) }, guest);
    expect(accepted.status).toBe(200);
    const me = await (await request("/auth/me", {}, guest)).json() as { organization: { id: string }; role: string; workspaces: unknown[] };
    expect(me.organization.id).toBe(host.organizationId);
    expect(me.role).toBe("agent");
    expect(me.workspaces).toHaveLength(2);
    expect((await request("/auth/switch-workspace", { method: "POST", body: JSON.stringify({ organizationId: guest.organizationId }) }, guest)).status).toBe(200);
    expect(((await (await request("/auth/me", {}, guest)).json()) as { organization: { id: string } }).organization.id).toBe(guest.organizationId);
  });

  it("rejects a signed-in accept-invitation without a CSRF token", async () => {
    const host = await signup("invite-csrf-host");
    const guest = await signup("invite-csrf-guest");
    const invitation = await (await request("/organization/invitations", { method: "POST", body: JSON.stringify({ email: "owner-invite-csrf-guest@example.test", role: "agent" }) }, host)).json() as { invitation: { inviteUrl: string } };
    const token = new URL(invitation.invitation.inviteUrl).searchParams.get("token")!;
    const response = await request("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token }), headers: { cookie: guest.cookie, origin: env.APP_URL } });
    expect(response.status).toBe(403);
    const membership = await env.DB.prepare("SELECT * FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(host.organizationId, guest.userId).first();
    expect(membership).toBeNull();
  });

  it("creates a default support inbox when signup supplies a support email", async () => {
    const suffix = "signup-inbox";
    const response = await request("/auth/signup", { method: "POST", body: JSON.stringify({ name: `Owner ${suffix}`, email: `owner-${suffix}@example.test`, password: "a-secure-test-password", organizationName: `Workspace ${suffix}`, organizationSlug: `workspace-${suffix}`, supportEmail: `Support-${suffix}@Example.test` }) });
    expect(response.status).toBe(201);
    const body = await response.json() as { csrfToken: string; user: { id: string }; organization: { id: string } };
    const cookies = [...(response.headers.get("set-cookie") ?? "").matchAll(/(resolvehq_(?:session|csrf))=([^;,]+)/g)];
    const session = { cookie: cookies.map((match) => `${match[1]}=${match[2]}`).join("; "), csrf: body.csrfToken, userId: body.user.id, organizationId: body.organization.id };

    const settings = await (await request("/organization/settings", {}, session)).json() as { inboxes: Array<{ name: string; emailAddress: string; isDefault: boolean }> };
    expect(settings.inboxes).toHaveLength(1);
    expect(settings.inboxes[0]).toMatchObject({ name: "Support", emailAddress: `support-${suffix}@example.test`, isDefault: true });
    expect(await env.DB.prepare("SELECT support_email FROM organizations WHERE id = ?").bind(session.organizationId).first<{ support_email: string }>()).toMatchObject({ support_email: `support-${suffix}@example.test` });

    const customer = await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Signup Customer", email: `customer-${suffix}@example.test` }) }, session)).json() as { customer: { id: string } };
    const ticket = await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.customer.id, subject: "Inbox came from signup", message: "No manual inbox creation needed." }) }, session);
    expect(ticket.status).toBe(201);

    const duplicate = await request("/auth/signup", { method: "POST", body: JSON.stringify({ name: "Second Owner", email: `owner-${suffix}-2@example.test`, password: "a-secure-test-password", organizationName: "Second Workspace", organizationSlug: `workspace-${suffix}-2`, supportEmail: `support-${suffix}@example.test` }) });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "inbox_address_exists" } });
    expect(await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(`owner-${suffix}-2@example.test`).first()).toBeNull();
  });
});
