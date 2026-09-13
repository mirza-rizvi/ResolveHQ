import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "resolve-server/app";
import { resolveAIProvider } from "resolve-server/assistant/routes";
import type { AppBindings } from "resolve-server/types";
import { request, signup, type TestSession } from "./helpers";

type AiRun = (model: string, inputs: Record<string, unknown>, options?: unknown) => Promise<unknown>;

/** Workers AI is not reachable from the test runtime, so the binding is faked. */
function fakeAi(run?: AiRun) {
  return {
    run: vi.fn<AiRun>(
      run ??
        (async (model) =>
          model === "@cf/meta/m2m100-1.2b" ? { translated_text: "Hola" } : { response: "generated text" })),
  };
}

function aiEnv(binding: { run: unknown }, extra: Record<string, unknown> = {}) {
  return { ...env, AI: binding, ...extra } as unknown as AppBindings;
}

/** helpers.request always uses the ambient env; assistant tests need an injected AI binding. */
function requestWith(path: string, init: RequestInit, session: TestSession, bindings: AppBindings) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("cookie", session.cookie);
  headers.set("x-csrf-token", session.csrf);
  headers.set("origin", env.APP_URL as string);
  return app.request(`http://localhost:8787/api${path}`, { ...init, headers }, bindings);
}

async function enableAi(session: TestSession) {
  const response = await request(
    "/organization/settings",
    { method: "PATCH", body: JSON.stringify({ aiEnabled: true }) },
    session,
  );
  if (response.status !== 200) throw new Error(`Enabling AI failed: ${response.status} ${await response.text()}`);
}

async function seedTicket(session: TestSession, suffix: string) {
  const customerResponse = await request(
    "/customers",
    { method: "POST", body: JSON.stringify({ name: `Customer ${suffix}`, email: `c-${suffix}@example.test` }) },
    session,
  );
  const customer = ((await customerResponse.json()) as { customer: { id: string } }).customer;
  const ticketResponse = await request(
    "/tickets",
    {
      method: "POST",
      body: JSON.stringify({ customerId: customer.id, subject: `Subject ${suffix}`, message: "Hello there." }),
    },
    session,
  );
  const ticket = ((await ticketResponse.json()) as { ticket: { id: string } }).ticket;
  const detail = await request(`/tickets/${ticket.id}`, {}, session);
  const body = (await detail.json()) as { messages: Array<{ id: string; bodyText: string }> };
  return { ticketId: ticket.id, messageId: body.messages[0].id };
}

describe("assistant provider selection", () => {
  it("prefers Workers AI, falls back to OpenAI, and stays unconfigured otherwise", () => {
    const withBoth = resolveAIProvider(aiEnv(fakeAi(), { OPENAI_API_KEY: "sk-test" }));
    expect(withBoth?.providerName).toBe("workers-ai");
    const withKey = resolveAIProvider({ ...env, OPENAI_API_KEY: "sk-test" } as unknown as AppBindings);
    expect(withKey?.providerName).toBe("openai");
    expect(resolveAIProvider({ ...env } as unknown as AppBindings)).toBeNull();
  });

  it("reports the active provider in workspace settings", async () => {
    const session = await signup("ai-settings");
    const response = await requestWith("/organization/settings", {}, session, aiEnv(fakeAi()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ai: { available: boolean; enabled: boolean; provider: string | null } };
    expect(body.ai).toMatchObject({ available: true, provider: "workers-ai" });
    const withoutAi = await request("/organization/settings", {}, session);
    const plain = (await withoutAi.json()) as { ai: { available: boolean; provider: string | null } };
    expect(plain.ai).toMatchObject({ available: false, provider: null });
  });
});

describe("assistant translation", () => {
  it("translates a message that belongs to the caller's workspace", async () => {
    const session = await signup("translate-owner");
    await enableAi(session);
    const { ticketId, messageId } = await seedTicket(session, "translate-owner");
    const binding = fakeAi();
    const response = await requestWith(
      "/assistant/translate",
      { method: "POST", body: JSON.stringify({ ticketId, messageId, targetLanguage: "es" }) },
      session,
      aiEnv(binding),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ translation: "Hola" });
    expect(binding.run).toHaveBeenCalledWith(
      "@cf/meta/m2m100-1.2b",
      expect.objectContaining({ text: "Hello there.", target_lang: "es" }),
      undefined,
    );
  });

  it("rejects a message from another workspace", async () => {
    const alpha = await signup("translate-alpha");
    const beta = await signup("translate-beta");
    await enableAi(alpha);
    const mine = await seedTicket(alpha, "translate-alpha");
    const theirs = await seedTicket(beta, "translate-beta");
    const binding = fakeAi();
    const response = await requestWith(
      "/assistant/translate",
      {
        method: "POST",
        body: JSON.stringify({ ticketId: mine.ticketId, messageId: theirs.messageId, targetLanguage: "es" }),
      },
      alpha,
      aiEnv(binding),
    );
    expect(response.status).toBe(404);
    expect(binding.run).not.toHaveBeenCalled();
    const foreignTicket = await requestWith(
      "/assistant/translate",
      {
        method: "POST",
        body: JSON.stringify({ ticketId: theirs.ticketId, messageId: theirs.messageId, targetLanguage: "es" }),
      },
      alpha,
      aiEnv(binding),
    );
    expect(foreignTicket.status).toBe(404);
    expect(binding.run).not.toHaveBeenCalled();
  });

  it("keeps the workspace opt-in ahead of any model call", async () => {
    const session = await signup("translate-optout");
    const { ticketId, messageId } = await seedTicket(session, "translate-optout");
    const binding = fakeAi();
    const response = await requestWith(
      "/assistant/translate",
      { method: "POST", body: JSON.stringify({ ticketId, messageId, targetLanguage: "es" }) },
      session,
      aiEnv(binding),
    );
    expect(response.status).toBe(403);
    expect(binding.run).not.toHaveBeenCalled();
  });

  it("passes the AI Gateway id and chunks long text", async () => {
    const session = await signup("translate-gateway");
    await enableAi(session);
    const { ticketId } = await seedTicket(session, "translate-gateway");
    const binding = fakeAi(async () => ({ translated_text: "parte" }));
    const paragraph = `${"a".repeat(1_500)}\n\n${"b".repeat(1_500)}`;
    const response = await requestWith(
      "/assistant/translate",
      { method: "POST", body: JSON.stringify({ ticketId, text: paragraph, targetLanguage: "fr" }) },
      session,
      aiEnv(binding, { AI_GATEWAY_ID: "resolvehq-gateway" }),
    );
    expect(response.status).toBe(200);
    expect(binding.run).toHaveBeenCalledTimes(2);
    expect(binding.run.mock.calls[0][2]).toEqual({ gateway: { id: "resolvehq-gateway" } });
  });
});

describe("assistant classification", () => {
  it("parses a JSON object wrapped in prose", async () => {
    const session = await signup("classify-wrapped");
    await enableAi(session);
    const { ticketId } = await seedTicket(session, "classify-wrapped");
    const binding = fakeAi(async () => ({
      response:
        'Sure! Here is the classification:\n```json\n{"category":"billing","sentiment":"negative","tags":["invoice"]}\n```\nLet me know if you need more.',
    }));
    const response = await requestWith(
      "/assistant/classify",
      { method: "POST", body: JSON.stringify({ ticketId }) },
      session,
      aiEnv(binding),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classification: { category: "billing", sentiment: "negative", tags: ["invoice"] },
    });
    expect(binding.run).toHaveBeenCalledWith(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      expect.objectContaining({ max_tokens: 1200 }),
      undefined,
    );
  });
});
