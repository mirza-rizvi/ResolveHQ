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
});
