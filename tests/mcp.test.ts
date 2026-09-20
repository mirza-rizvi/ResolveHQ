import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "resolve-server/app";
import { MCP_TOOLS } from "resolve-server/mcp/tools";
import { request, signup, type TestSession } from "./helpers";

interface RpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Calls the MCP endpoint the way a client does: bearer key, JSON-RPC body, no cookies. */
async function rpc(key: string, body: unknown): Promise<RpcResponse> {
  const response = await app.request(
    "http://localhost:8787/api/mcp",
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
  return (await response.json()) as RpcResponse;
}

function rawCall(key: string, body: string) {
  return app.request(
    "http://localhost:8787/api/mcp",
    { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body },
    env,
  );
}

async function mcpKey(session: TestSession, overrides: Record<string, unknown> = {}) {
  const response = await request(
    "/organization/api-keys",
    {
      method: "POST",
      body: JSON.stringify({ name: "MCP", scopes: ["mcp:read"], ...overrides }),
    },
    session,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { key: string }).key;
}

async function seedTicket(session: TestSession, suffix: string, subject = `Subject ${suffix}`) {
  const customer = await request(
    "/customers",
    { method: "POST", body: JSON.stringify({ name: "Casey Customer", email: `casey-${suffix}@example.test` }) },
    session,
  );
  const customerId = ((await customer.json()) as { customer: { id: string } }).customer.id;
  const created = await request(
    "/tickets",
    { method: "POST", body: JSON.stringify({ customerId, subject, message: "The export never finishes." }) },
    session,
  );
  expect(created.status).toBe(201);
  return { ticket: ((await created.json()) as { ticket: { id: string } }).ticket, customerId };
}

function toolResult(response: RpcResponse) {
  return response.result?.structuredContent as Record<string, unknown>;
}

describe("MCP transport", () => {
  it("negotiates initialize and echoes a protocol version it speaks", async () => {
    const workspace = await signup("mcp-init");
    const key = await mcpKey(workspace);

    const modern = await rpc(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(modern.result?.protocolVersion).toBe("2025-06-18");
    expect((modern.result?.serverInfo as { name: string }).name).toBe("resolvehq");

    const older = await rpc(key, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(older.result?.protocolVersion).toBe("2024-11-05");

    // An unknown version falls back rather than failing the handshake.
    const unknown = await rpc(key, { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknown.result?.protocolVersion).toBe("2025-06-18");
  });

  it("answers a notification with no body and a ping with an empty result", async () => {
    const workspace = await signup("mcp-notify");
    const key = await mcpKey(workspace);

    const notification = await rawCall(key, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const ping = await rpc(key, { jsonrpc: "2.0", id: 9, method: "ping" });
    expect(ping.result).toEqual({});
  });

  it("returns proper JSON-RPC envelopes for malformed input and unknown methods", async () => {
    const workspace = await signup("mcp-errors");
    const key = await mcpKey(workspace);

    const parse = await rpc(key, "{not json");
    expect(parse.error?.code).toBe(-32700);

    const shape = await rpc(key, { id: 1, method: "tools/list" });
    expect(shape.error?.code).toBe(-32600);

    const method = await rpc(key, { jsonrpc: "2.0", id: 2, method: "does/not/exist" });
    expect(method.error?.code).toBe(-32601);

    // A tool that does not exist is simply unknown; nothing hints at a future write tool.
    const write = await rpc(key, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "reply_to_ticket", arguments: {} },
    });
    expect(write.error?.code).toBe(-32601);
    expect(write.error?.message).not.toMatch(/later|soon|0\.4/i);
  });

  it("handles a JSON-RPC batch", async () => {
    const workspace = await signup("mcp-batch");
    const key = await mcpKey(workspace);
    const response = await rawCall(
      key,
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    );
    const body = (await response.json()) as RpcResponse[];
    // The notification contributes no response.
    expect(body).toHaveLength(2);
    expect(body.map((entry) => entry.id)).toEqual([1, 2]);
  });
});

describe("MCP tools", () => {
  it("exposes exactly five read-only tools and no write tool", async () => {
    const workspace = await signup("mcp-tools");
    const key = await mcpKey(workspace);
    const listed = await rpc(key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = listed.result?.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;

    expect(tools).toHaveLength(5);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_customer",
      "get_ticket",
      "list_queues",
      "search_knowledge_base",
      "search_tickets",
    ]);
    // Nothing that could change a ticket or send mail.
    for (const tool of tools) expect(tool.name).not.toMatch(/reply|send|assign|create|update|delete|set_/);
    // Every schema is a usable JSON Schema object.
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).toHaveProperty("properties");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("searches and reads tickets from the key's workspace", async () => {
    const workspace = await signup("mcp-read");
    const { ticket } = await seedTicket(workspace, "read", "Export never finishes");
    const key = await mcpKey(workspace);

    const found = await rpc(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_tickets", arguments: { query: "export" } },
    });
    const search = toolResult(found) as { tickets: Array<{ id: string }> };
    expect(search.tickets.map((entry) => entry.id)).toContain(ticket.id);
    expect(found.result?.isError).toBe(false);

    const detail = await rpc(key, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_ticket", arguments: { ticketId: ticket.id } },
    });
    const read = toolResult(detail) as { ticket: { id: string }; messages: unknown[] };
    expect(read.ticket.id).toBe(ticket.id);
    expect(read.messages.length).toBeGreaterThan(0);

    const queues = await rpc(key, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_queues", arguments: {} },
    });
    expect((toolResult(queues) as { queues: { all: number } }).queues.all).toBeGreaterThan(0);
  });

  it("finds a customer by id or by any of their addresses", async () => {
    const workspace = await signup("mcp-customer");
    const { customerId } = await seedTicket(workspace, "customer");
    const key = await mcpKey(workspace);

    const byId = await rpc(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_customer", arguments: { customerId } },
    });
    expect((toolResult(byId) as { customer: { id: string } }).customer.id).toBe(customerId);

    // Addresses match regardless of case.
    const byEmail = await rpc(key, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_customer", arguments: { email: "CASEY-CUSTOMER@EXAMPLE.TEST" } },
    });
    expect((toolResult(byEmail) as { customer: { id: string } }).customer.id).toBe(customerId);

    // An address nobody owns is reported as not found, not as an error envelope.
    const unknown = await rpc(key, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_customer", arguments: { email: "nobody@example.test" } },
    });
    expect(toolResult(unknown)).toEqual({ error: "not_found" });
  });

  it("caps limit and never exceeds fifty results", async () => {
    const workspace = await signup("mcp-limit");
    const key = await mcpKey(workspace);
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "search_tickets")!;
    expect((tool.inputSchema.properties as { limit: { maximum: number } }).limit.maximum).toBe(50);

    const capped = await rpc(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_tickets", arguments: { limit: 5000 } },
    });
    expect((toolResult(capped) as { tickets: unknown[] }).tickets.length).toBeLessThanOrEqual(50);
  });

  it("never returns a knowledge-base draft", async () => {
    const workspace = await signup("mcp-kb");
    const key = await mcpKey(workspace);
    await env.DB.prepare(
      "INSERT INTO knowledge_base_articles (id, organization_id, title, slug, category, body, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'General', ?, ?, 1, ?, ?)",
    )
      .bind("kb_mcp_draft", workspace.organizationId, "Secret draft", "secret-draft", "Internal only notes", "draft", Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO knowledge_base_articles (id, organization_id, title, slug, category, body, status, version, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'General', ?, 'published', 1, ?, ?, ?)",
    )
      .bind("kb_mcp_live", workspace.organizationId, "Published guide", "published-guide", "Internal only notes", Date.now(), Date.now(), Date.now())
      .run();

    const response = await rpc(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_knowledge_base", arguments: { query: "internal only" } },
    });
    const found = toolResult(response) as { articles: Array<{ id: string }> };
    expect(found.articles.map((entry) => entry.id)).toEqual(["kb_mcp_live"]);
  });
});

describe("MCP authorization", () => {
  it("rejects an unauthenticated request and a key without mcp:read", async () => {
    const workspace = await signup("mcp-auth");
    const anonymous = await app.request(
      "http://localhost:8787/api/mcp",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
      env,
    );
    expect(anonymous.status).toBe(401);

    const ticketsOnly = await request(
      "/organization/api-keys",
      { method: "POST", body: JSON.stringify({ name: "Tickets only", scopes: ["tickets:read"] }) },
      workspace,
    );
    const key = ((await ticketsOnly.json()) as { key: string }).key;
    const response = await app.request(
      "http://localhost:8787/api/mcp",
      { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
      env,
    );
    // Explanatory on purpose: this is the owner's own key.
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("insufficient_scope");
  });

  it("rejects a revoked key", async () => {
    const workspace = await signup("mcp-revoked");
    const created = await request(
      "/organization/api-keys",
      { method: "POST", body: JSON.stringify({ name: "Doomed", scopes: ["mcp:read"] }) },
      workspace,
    );
    const body = (await created.json()) as { key: string; apiKey: { id: string } };
    await request(`/organization/api-keys/${body.apiKey.id}`, { method: "DELETE" }, workspace);
    const response = await app.request(
      "http://localhost:8787/api/mcp",
      { method: "POST", headers: { authorization: `Bearer ${body.key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("scopes every tool to the key's workspace and cannot be pointed at another", async () => {
    const alpha = await signup("mcp-tenant-alpha");
    const beta = await signup("mcp-tenant-beta");
    const { ticket, customerId } = await seedTicket(alpha, "tenant-alpha", "Alpha only subject");
    const key = await mcpKey(beta);

    const search = await rpc(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_tickets", arguments: { query: "alpha" } },
    });
    expect((toolResult(search) as { tickets: unknown[] }).tickets).toHaveLength(0);

    // Naming the id directly must not confirm that it exists.
    const detail = await rpc(key, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_ticket", arguments: { ticketId: ticket.id } },
    });
    expect(toolResult(detail)).toEqual({ error: "not_found" });

    const customer = await rpc(key, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_customer", arguments: { customerId } },
    });
    expect(toolResult(customer)).toEqual({ error: "not_found" });

    // An organization id is not an argument any tool accepts.
    for (const tool of MCP_TOOLS) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/organization/i);
  });

  it("honours the key's inbox restriction in every tool", async () => {
    const workspace = await signup("mcp-inbox");
    const { ticket, customerId } = await seedTicket(workspace, "inbox");
    const key = await mcpKey(workspace, { name: "Elsewhere", inboxIds: ["inb_somewhere_else"] });

    const search = await rpc(key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_tickets", arguments: {} },
    });
    expect((toolResult(search) as { tickets: unknown[] }).tickets).toHaveLength(0);

    const detail = await rpc(key, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_ticket", arguments: { ticketId: ticket.id } },
    });
    expect(toolResult(detail)).toEqual({ error: "not_found" });

    const queues = await rpc(key, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_queues", arguments: {} },
    });
    expect((toolResult(queues) as { queues: { all: number } }).queues.all).toBe(0);

    // The customer used to come back with name, company and every known email address,
    // because only the recentTickets sub-query carried the inbox filter. A key that can
    // see none of a customer's tickets must not be able to confirm the customer exists.
    const customer = await rpc(key, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_customer", arguments: { customerId } },
    });
    expect(toolResult(customer)).toEqual({ error: "not_found" });
  });

  it("refuses an oversized batch instead of spending one token on many queries", async () => {
    const workspace = await signup("mcp-batch-cap");
    await seedTicket(workspace, "batch");
    const key = await mcpKey(workspace, { name: "Batch" });

    const batch = Array.from({ length: 25 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name: "search_tickets", arguments: {} },
    }));
    const response = await rawCall(key, JSON.stringify(batch));
    expect(response.status).toBe(400);

    // The rate limit is checked once per HTTP request, so an unbounded batch was a
    // multiplier on the workspace's own D1 budget.
    const within = await rawCall(
      key,
      JSON.stringify(batch.slice(0, 3)),
    );
    expect(within.status).toBe(200);
    expect((await within.json()) as unknown[]).toHaveLength(3);
  });
});
