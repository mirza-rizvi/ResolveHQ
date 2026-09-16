import { expect, request as apiRequest, test, type Page } from "@playwright/test";

// Unique per run, for the same reason as in api-keys.spec.ts.
const runId = Date.now().toString(36);

/**
 * The API-keys section renders nothing until its own fetch resolves, so a bare
 * getByLabel("Name") can land on the inbox form instead. Always scope to the section.
 */
function apiKeySection(target: Page) {
  return target.locator("section").filter({ has: target.getByRole("heading", { name: "API keys" }) });
}

async function createKeyThroughUi(target: Page, name: string, extraScope?: string) {
  const section = apiKeySection(target);
  await expect(section).toBeVisible();
  await section.getByLabel("Name").fill(name);
  if (extraScope) await section.getByLabel(extraScope).check();
  await section.getByRole("button", { name: "Create key" }).click();
  const dialog = target.getByRole("dialog", { name: "Your new API key" });
  await expect(dialog.or(target.locator(".form-error"))).toBeVisible();
  const value = await dialog.locator("code").innerText();
  await dialog.getByRole("button", { name: "I have saved it" }).click();
  return value;
}

/** A request context with no cookies: a bearer key must never ride a browser session. */
async function bearerContext() {
  return apiRequest.newContext({ storageState: undefined });
}

// One page for the whole file; the session comes from the shared sign-in in auth.setup.ts.
test.describe.configure({ mode: "serial" });

let page: Page;
let mcpKey = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("settings builds a copy-paste snippet per client and says plainly that it is read-only", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "AI assistants (MCP)" })).toBeVisible();
  await expect(page.getByText(/no way to reply, assign, or change anything/)).toBeVisible();

  // Create a real MCP key through the UI, exactly as an operator would.
  mcpKey = await createKeyThroughUi(page, `MCP key ${runId}`, "Connect an AI assistant (MCP)");

  await page.getByLabel("API key to include in the snippet").fill(mcpKey);
  const snippet = page.locator(".mcp-snippet pre");

  // The snippet carries the real endpoint and the real key, not placeholders.
  await expect(snippet).toContainText("claude mcp add resolvehq --transport http");
  await expect(snippet).toContainText("http://localhost:5173/api/mcp");
  await expect(snippet).toContainText(mcpKey);

  await page.getByRole("button", { name: "Claude Desktop" }).click();
  await expect(snippet).toContainText('"mcpServers"');
  await expect(snippet).toContainText(mcpKey);

  await page.getByRole("button", { name: "Cursor" }).click();
  await expect(snippet).toContainText('"url": "http://localhost:5173/api/mcp"');
});

test("the endpoint completes a real MCP handshake and lists real tickets", async () => {
  const api = await bearerContext();
  expect(mcpKey).toMatch(/^rhq_live_/);
  const call = (body: unknown) =>
    api.post("http://localhost:5173/api/mcp", {
      headers: { authorization: `Bearer ${mcpKey}`, "content-type": "application/json" },
      data: body,
    });

  const initialize = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "playwright", version: "1" },
    },
  });
  expect(initialize.status()).toBe(200);
  const handshake = (await initialize.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  expect(handshake.result.protocolVersion).toBe("2025-06-18");
  expect(handshake.result.serverInfo.name).toBe("resolvehq");

  // The initialized notification must be accepted with no body.
  const notified = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect(notified.status()).toBe(202);

  const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
  expect(tools).toHaveLength(5);
  for (const tool of tools) expect(tool.name).not.toMatch(/reply|send|assign|create|update|delete|set_/);

  const called = await call({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "search_tickets", arguments: { queue: "open", limit: 5 } },
  });
  const body = (await called.json()) as {
    result: { isError: boolean; structuredContent: { tickets: Array<{ subject: string }> } };
  };
  expect(body.result.isError).toBe(false);
  // Real seeded tickets, not an empty envelope.
  expect(body.result.structuredContent.tickets.length).toBeGreaterThan(0);
  expect(body.result.structuredContent.tickets[0].subject.length).toBeGreaterThan(0);
  await api.dispose();
});

test("a key without the MCP permission is refused", async () => {
  const api = await bearerContext();
  await page.goto("/settings");
  const key = await createKeyThroughUi(page, `Tickets only key ${runId}`);

  const response = await api.post("http://localhost:5173/api/mcp", {
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(response.status()).toBe(403);
  await api.dispose();
});
