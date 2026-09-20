import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "resolve-server/app";
import { scopeForRequest } from "resolve-server/auth/api-key";
import { request, signup, type TestSession } from "./helpers";

/** Calls the versioned surface the way a script would: a bearer key, no cookies. */
function asKey(path: string, key: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(`http://localhost:8787/api/v1${path}`, { ...init, headers }, env);
}

async function createKey(
  session: TestSession,
  overrides: Record<string, unknown> = {},
): Promise<{ key: string; id: string }> {
  const response = await request(
    "/organization/api-keys",
    {
      method: "POST",
      body: JSON.stringify({ name: "Zapier integration", scopes: ["tickets:read"], ...overrides }),
    },
    session,
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { key: string; apiKey: { id: string } };
  return { key: body.key, id: body.apiKey.id };
}

async function seedTicket(session: TestSession, suffix: string) {
  const customer = await request(
    "/customers",
    { method: "POST", body: JSON.stringify({ name: "Casey", email: `casey-${suffix}@example.test` }) },
    session,
  );
  const customerId = ((await customer.json()) as { customer: { id: string } }).customer.id;
  const created = await request(
    "/tickets",
    { method: "POST", body: JSON.stringify({ customerId, subject: `Subject ${suffix}`, message: "Hello" }) },
    session,
  );
  expect(created.status).toBe(201);
  return ((await created.json()) as { ticket: { id: string } }).ticket;
}

describe("API key scope mapping", () => {
  it("denies by default for surfaces with no scope in the vocabulary", () => {
    expect(scopeForRequest("GET", "/api/v1/tickets")).toBe("tickets:read");
    expect(scopeForRequest("POST", "/api/v1/tickets")).toBe("tickets:write");
    expect(scopeForRequest("GET", "/api/v1/customers")).toBe("customers:read");
    expect(scopeForRequest("GET", "/api/v1/reports/summary")).toBe("reports:read");
    expect(scopeForRequest("GET", "/api/v1/knowledge-base")).toBe("kb:read");
    expect(scopeForRequest("POST", "/api/mcp")).toBe("mcp:read");
    // Not in the vocabulary — unreachable with a key at all.
    expect(scopeForRequest("GET", "/api/v1/privacy/customers/x")).toBeNull();
    expect(scopeForRequest("POST", "/api/v1/assistant/draft")).toBeNull();
    expect(scopeForRequest("GET", "/api/v1/operations/dashboard")).toBeNull();
  });
});

describe("API key authentication", () => {
  it("authenticates the versioned surface and nothing outside its scope", async () => {
    const workspace = await signup("apikey-basic");
    const ticket = await seedTicket(workspace, "basic");
    const { key } = await createKey(workspace);

    const list = await asKey("/tickets", key);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { tickets: Array<{ id: string }> };
    expect(body.tickets.map((entry) => entry.id)).toContain(ticket.id);

    // tickets:read only — writing is refused, and the reason is stated.
    const write = await asKey("/tickets", key, {
      method: "POST",
      body: JSON.stringify({ customerId: "cus_x", subject: "Nope", message: "Nope" }),
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: { code: string } }).error.code).toBe("insufficient_scope");

    // Reports are outside this key's scopes entirely.
    const reports = await asKey("/reports/summary", key);
    expect(reports.status).toBe(403);
  });

  it("refuses the unversioned app surface, which stays session-only", async () => {
    const workspace = await signup("apikey-appsurface");
    const { key } = await createKey(workspace);
    const response = await app.request(
      "http://localhost:8787/api/tickets",
      { headers: { authorization: `Bearer ${key}` } },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("refuses a request carrying both a session cookie and a bearer key", async () => {
    const workspace = await signup("apikey-both");
    const { key } = await createKey(workspace);
    const response = await app.request(
      "http://localhost:8787/api/v1/tickets",
      { headers: { authorization: `Bearer ${key}`, cookie: workspace.cookie } },
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("ambiguous_credentials");
  });

  it("answers identically for unknown, revoked and expired keys", async () => {
    const workspace = await signup("apikey-neutral");
    const { key: revokedKey, id } = await createKey(workspace, { name: "Revoked" });
    await request(`/organization/api-keys/${id}`, { method: "DELETE" }, workspace);

    const { key: expiredKey } = await createKey(workspace, { name: "Expiring", expiresAt: Date.now() + 60_000 });
    await env.DB.prepare("UPDATE api_keys SET expires_at = ? WHERE name = 'Expiring'")
      .bind(Date.now() - 1000)
      .run();

    const bodies = [];
    for (const candidate of ["rhq_live_totallymadeup", revokedKey, expiredKey]) {
      const response = await asKey("/tickets", candidate);
      expect(response.status).toBe(401);
      bodies.push(((await response.json()) as { error: { code: string; message: string } }).error);
    }
    // No oracle: the three failures are indistinguishable.
    expect(new Set(bodies.map((body) => `${body.code}:${body.message}`)).size).toBe(1);
  });

  it("reduces a key's power the moment its creator is demoted, without re-issuing it", async () => {
    const workspace = await signup("apikey-demote");
    const { key } = await createKey(workspace, { scopes: ["tickets:read", "reports:read"] });
    expect((await asKey("/reports/summary", key)).status).toBe(200);

    // An agent may read tickets but not reports; the stored scope is intersected with
    // what the live role is allowed to grant.
    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();
    expect((await asKey("/reports/summary", key)).status).toBe(403);
    expect((await asKey("/tickets", key)).status).toBe(200);
  });

  it("denies an orphaned key whose creator is gone or disabled", async () => {
    const workspace = await signup("apikey-orphan");
    const { key } = await createKey(workspace);
    expect((await asKey("/tickets", key)).status).toBe(200);

    await env.DB.prepare("UPDATE organization_memberships SET disabled_at = ? WHERE organization_id = ? AND user_id = ?")
      .bind(Date.now(), workspace.organizationId, workspace.userId)
      .run();
    expect((await asKey("/tickets", key)).status).toBe(401);

    await env.DB.prepare("UPDATE api_keys SET created_by_user_id = NULL WHERE organization_id = ?")
      .bind(workspace.organizationId)
      .run();
    expect((await asKey("/tickets", key)).status).toBe(401);
  });

  it("restricts a key to its inboxes, in the list and on the ticket itself", async () => {
    const workspace = await signup("apikey-inbox");
    const ticket = await seedTicket(workspace, "inbox");
    const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE organization_id = ? LIMIT 1")
      .bind(workspace.organizationId)
      .first<{ id: string }>();

    const allowed = await createKey(workspace, { name: "Allowed", inboxIds: [inbox!.id] });
    const listed = (await (await asKey("/tickets", allowed.key)).json()) as { tickets: Array<{ id: string }> };
    expect(listed.tickets.map((entry) => entry.id)).toContain(ticket.id);
    expect((await asKey(`/tickets/${ticket.id}`, allowed.key)).status).toBe(200);

    const elsewhere = await createKey(workspace, { name: "Elsewhere", inboxIds: ["inb_somewhere_else"] });
    const empty = (await (await asKey("/tickets", elsewhere.key)).json()) as { tickets: unknown[] };
    expect(empty.tickets).toHaveLength(0);
    // Reported as missing rather than forbidden, so the response confirms nothing.
    expect((await asKey(`/tickets/${ticket.id}`, elsewhere.key)).status).toBe(404);

    // Search reads the same tickets under the same tickets:read scope. It carried no
    // inbox predicate at all, so the restriction was one query away from meaningless:
    // subjects from every inbox came back to a key scoped to one.
    const term = ticket.subject.split(" ")[0];
    const searched = (await (await asKey(`/search?q=${encodeURIComponent(term)}`, elsewhere.key)).json()) as {
      results: Array<{ id: string }>;
    };
    expect(searched.results.map((entry) => entry.id)).not.toContain(ticket.id);

    const allowedSearch = (await (await asKey(`/search?q=${encodeURIComponent(term)}`, allowed.key)).json()) as {
      results: Array<{ id: string }>;
    };
    expect(allowedSearch.results.map((entry) => entry.id)).toContain(ticket.id);
  });

  it("does not let one organization's key read another's tickets", async () => {
    const alpha = await signup("apikey-tenant-alpha");
    const beta = await signup("apikey-tenant-beta");
    const alphaTicket = await seedTicket(alpha, "tenant-alpha");
    const { key } = await createKey(beta, { name: "Beta key" });

    const list = (await (await asKey("/tickets", key)).json()) as { tickets: Array<{ id: string }> };
    expect(list.tickets.some((entry) => entry.id === alphaTicket.id)).toBe(false);
    expect((await asKey(`/tickets/${alphaTicket.id}`, key)).status).toBe(404);
  });
});

describe("API key management", () => {
  it("returns the key exactly once and never exposes the hash afterwards", async () => {
    const workspace = await signup("apikey-reveal");
    const created = await request(
      "/organization/api-keys",
      { method: "POST", body: JSON.stringify({ name: "Reveal", scopes: ["tickets:read"] }) },
      workspace,
    );
    const body = (await created.json()) as { key: string; apiKey: Record<string, unknown> };
    expect(body.key.startsWith("rhq_live_")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("keyHash");

    const listed = await request("/organization/api-keys", {}, workspace);
    const text = await listed.text();
    expect(text).not.toContain(body.key);
    expect(text).not.toContain("keyHash");
    expect(text).not.toContain("key_hash");
    const parsed = JSON.parse(text) as { keys: Array<{ prefix: string; orphaned: boolean }> };
    expect(parsed.keys[0].prefix).toBe(body.key.slice(0, 12));
    expect(parsed.keys[0].orphaned).toBe(false);
  });

  it("marks a key whose creator has left as orphaned", async () => {
    const workspace = await signup("apikey-orphan-list");
    await createKey(workspace);
    await env.DB.prepare("UPDATE api_keys SET created_by_user_id = NULL WHERE organization_id = ?")
      .bind(workspace.organizationId)
      .run();
    const listed = (await (await request("/organization/api-keys", {}, workspace)).json()) as {
      keys: Array<{ orphaned: boolean }>;
    };
    expect(listed.keys[0].orphaned).toBe(true);
  });

  it("rejects an expiry date in the past", async () => {
    const workspace = await signup("apikey-expiry");
    const response = await request(
      "/organization/api-keys",
      {
        method: "POST",
        body: JSON.stringify({ name: "Past", scopes: ["tickets:read"], expiresAt: Date.now() - 1000 }),
      },
      workspace,
    );
    expect(response.status).toBe(400);
  });

  it("refuses creation, listing and revocation from a non-admin", async () => {
    const workspace = await signup("apikey-role");
    const { id } = await createKey(workspace);
    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();

    expect((await request("/organization/api-keys", {}, workspace)).status).toBe(403);
    expect(
      (
        await request(
          "/organization/api-keys",
          { method: "POST", body: JSON.stringify({ name: "Nope", scopes: ["tickets:read"] }) },
          workspace,
        )
      ).status,
    ).toBe(403);
    expect((await request(`/organization/api-keys/${id}`, { method: "DELETE" }, workspace)).status).toBe(403);
  });

  it("does not let one organization revoke another's key", async () => {
    const alpha = await signup("apikey-revoke-alpha");
    const beta = await signup("apikey-revoke-beta");
    const { id, key } = await createKey(alpha, { name: "Alpha key" });

    expect((await request(`/organization/api-keys/${id}`, { method: "DELETE" }, beta)).status).toBe(404);
    expect((await asKey("/tickets", key)).status).toBe(200);
  });
});
