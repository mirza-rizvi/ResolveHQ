import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { hashPassword, verifyPassword } from "resolve-server/auth/password";
import { request, signup } from "./helpers";

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
});
