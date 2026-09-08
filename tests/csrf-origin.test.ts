import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "resolve-server/app";
import { signup, type TestSession } from "./helpers";

function proxyHeaders(session: TestSession, origin: string) {
  return new Headers({
    "content-type": "application/json",
    cookie: session.cookie,
    "x-csrf-token": session.csrf,
    origin,
  });
}

describe("mutation origin checks", () => {
  it("accepts a mutation whose origin host matches the forwarded Host header", async () => {
    const session = await signup("origin-proxy");
    // Stand-in for the Vite dev proxy: Host stays on the browser origin while
    // the Worker is addressed on a different host, and APP_URL may be absent.
    const headers = proxyHeaders(session, "http://localhost:5173");
    headers.set("host", "localhost:5173");
    const response = await app.request(
      "http://localhost:8787/api/organization/settings",
      { method: "PATCH", body: JSON.stringify({ name: "Proxied Workspace" }), headers },
      env,
    );
    expect(response.status).toBe(200);
  });

  it("rejects a mutation from a foreign origin", async () => {
    const session = await signup("origin-attacker");
    const response = await app.request(
      "http://localhost:8787/api/organization/settings",
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Hijacked" }),
        headers: proxyHeaders(session, "https://evil.example"),
      },
      env,
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_origin");
  });

  it("rejects a mutation with a mismatching CSRF token", async () => {
    const session = await signup("origin-csrf");
    const headers = proxyHeaders(session, "http://localhost:8787");
    headers.set("x-csrf-token", "wrong-token");
    const response = await app.request(
      "http://localhost:8787/api/organization/settings",
      { method: "PATCH", body: JSON.stringify({ name: "Nope" }), headers },
      env,
    );
    expect(response.status).toBe(403);
  });
});
