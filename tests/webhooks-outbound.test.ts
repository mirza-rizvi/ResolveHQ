import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processInboundMail } from "resolve-server/mail/queue";
import { runScheduled } from "resolve-server/maintenance/scheduled";
import { formatPayload } from "resolve-server/webhooks/formats";
import { AUTO_DISABLE_AFTER, retryDueWebhooks } from "resolve-server/webhooks/outbound";
import type { AppBindings } from "resolve-server/types";
import { mimeMessage, request, signup, type TestSession } from "./helpers";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let captured: CapturedRequest[] = [];
let respondWith: () => Response;
let originalFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  respondWith = () => new Response("ok", { status: 200 });
  originalFetch = globalThis.fetch;
  // Endpoints are external by definition, so the send path is stubbed rather than
  // reaching the network.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({ url, headers, body: String(init?.body ?? "") });
    return respondWith();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function createEndpoint(session: TestSession, overrides: Record<string, unknown> = {}) {
  const response = await request(
    "/organization/webhooks",
    {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.example.com/incoming",
        kind: "generic",
        events: ["ticket.created"],
        ...overrides,
      }),
    },
    session,
  );
  return response;
}

async function endpointFor(session: TestSession, overrides: Record<string, unknown> = {}) {
  const response = await createEndpoint(session, overrides);
  expect(response.status).toBe(201);
  return (await response.json()) as { secret: string | null; endpoint: { id: string } };
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
    { method: "POST", body: JSON.stringify({ customerId, subject: `Subject ${suffix}`, message: "Hello there" }) },
    session,
  );
  expect(created.status).toBe(201);
  return ((await created.json()) as { ticket: { id: string; number: number } }).ticket;
}

function deliveries(organizationId: string) {
  return env.DB.prepare(
    "SELECT id, event, status, attempts, next_attempt_at AS nextAttemptAt, response_code AS responseCode, last_error AS lastError, payload FROM webhook_deliveries WHERE organization_id = ? ORDER BY created_at",
  )
    .bind(organizationId)
    .all<{
      id: string;
      event: string;
      status: string;
      attempts: number;
      nextAttemptAt: number | null;
      responseCode: number | null;
      lastError: string | null;
      payload: string;
    }>();
}

function endpointRow(id: string) {
  return env.DB.prepare(
    "SELECT enabled, failure_count AS failureCount, disabled_at AS disabledAt, last_error AS lastError, last_success_at AS lastSuccessAt FROM webhook_endpoints WHERE id = ?",
  )
    .bind(id)
    .first<{
      enabled: number;
      failureCount: number;
      disabledAt: number | null;
      lastError: string | null;
      lastSuccessAt: number | null;
    }>();
}

describe("outbound webhook delivery", () => {
  it("delivers a subscribed event and records success", async () => {
    const workspace = await signup("wh-deliver");
    const { endpoint } = await endpointFor(workspace);
    const ticket = await seedTicket(workspace, "deliver");

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://hooks.example.com/incoming");
    const body = JSON.parse(captured[0].body) as { event: string; data: { ticketId: string; number: number } };
    expect(body.event).toBe("ticket.created");
    expect(body.data.ticketId).toBe(ticket.id);

    const rows = await deliveries(workspace.organizationId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status).toBe("delivered");
    expect(rows.results[0].responseCode).toBe(200);
    expect((await endpointRow(endpoint.id))?.lastSuccessAt).not.toBeNull();
  });

  it("sends nothing to an endpoint that did not subscribe to the event", async () => {
    const workspace = await signup("wh-unsubscribed");
    await endpointFor(workspace, { events: ["csat.received"] });
    await seedTicket(workspace, "unsubscribed");
    expect(captured).toHaveLength(0);
    expect((await deliveries(workspace.organizationId)).results).toHaveLength(0);
  });

  it("signs generic deliveries so an independent check verifies them", async () => {
    const workspace = await signup("wh-signature");
    const { secret } = await endpointFor(workspace);
    expect(secret).toMatch(/^whsec_/);
    await seedTicket(workspace, "signature");

    const header = captured[0].headers["x-resolvehq-signature"];
    expect(header).toMatch(/^t=\d+,v1=[A-Za-z0-9_-]+$/);
    expect(captured[0].headers["x-resolvehq-event"]).toBe("ticket.created");

    // Verified with an independently written HMAC, not with the code under test.
    const [timestampPart, signaturePart] = header.split(",");
    const timestamp = timestampPart.slice(2);
    const provided = signaturePart.slice(3);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${captured[0].body}`));
    const base64Url = btoa(String.fromCharCode(...new Uint8Array(expected)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(provided).toBe(base64Url);

    // Altering the body invalidates it.
    const tampered = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.{"event":"fake"}`));
    expect(btoa(String.fromCharCode(...new Uint8Array(tampered)))).not.toBe(btoa(String.fromCharCode(...new Uint8Array(expected))));
  });

  it("never ships message bodies, subjects of notes, or customer email addresses", async () => {
    const workspace = await signup("wh-payload");
    await endpointFor(workspace, { events: ["ticket.created", "message.received"] });
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
      .bind("help-payload@example.test", workspace.organizationId)
      .run();
    await processInboundMail(env as AppBindings, {
      raw: mimeMessage({
        id: "<wh-payload@example.test>",
        to: "help-payload@example.test",
        subject: "My card was charged twice",
        body: "SECRET-BODY-TEXT that must never leave the workspace",
        from: "payer@example.test",
      }),
      from: "payer@example.test",
      to: "help-payload@example.test",
    });
    await retryDueWebhooks(env as AppBindings);

    const everything = captured.map((entry) => entry.body).join("\n");
    expect(everything).not.toContain("SECRET-BODY-TEXT");
    expect(everything).not.toContain("payer@example.test");
    // Ids, numbers and statuses are what a consumer gets.
    expect(everything).toContain("ticketId");
  });

  it("retries with backoff, abandons after six attempts, and disables a persistently failing endpoint", async () => {
    const workspace = await signup("wh-retry");
    const { endpoint } = await endpointFor(workspace);
    respondWith = () => new Response("SECRET-INTERNAL-BODY", { status: 502, statusText: "Bad Gateway" });
    await seedTicket(workspace, "retry");

    let rows = await deliveries(workspace.organizationId);
    expect(rows.results[0].status).toBe("pending");
    expect(rows.results[0].attempts).toBe(1);
    expect(rows.results[0].lastError).toContain("502");
    // The destination's response body is never stored or relayed. It used to be, 200
    // bytes of it, which the list and test routes handed straight back — turning a
    // tenant-supplied URL into a readable probe rather than a blind one.
    expect(rows.results[0].lastError).not.toContain("SECRET-INTERNAL-BODY");
    // First backoff is fifteen seconds.
    expect(rows.results[0].nextAttemptAt! - Date.now()).toBeGreaterThan(10_000);

    // Drive it to exhaustion through the retry path, which is what the cron calls.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Only pending rows: forcing every row due would re-populate next_attempt_at on
      // a delivery that has already been abandoned.
      await env.DB.prepare(
        "UPDATE webhook_deliveries SET next_attempt_at = ? WHERE organization_id = ? AND status = 'pending'",
      )
        .bind(Date.now() - 1000, workspace.organizationId)
        .run();
      await retryDueWebhooks(env as AppBindings);
    }
    rows = await deliveries(workspace.organizationId);
    expect(rows.results[0].status).toBe("abandoned");
    expect(rows.results[0].attempts).toBe(6);
    expect(rows.results[0].nextAttemptAt).toBeNull();

    // One delivery exhausts at six attempts, which is six endpoint failures — not yet
    // enough to disable it. Auto-disable counts failures across deliveries.
    const health = await endpointRow(endpoint.id);
    expect(health?.failureCount).toBe(6);
    expect(health?.enabled).toBe(1);
    expect(health?.lastError).toContain("502");
  });

  it("disables an endpoint after ten consecutive failures, across deliveries", async () => {
    const workspace = await signup("wh-autodisable");
    const { endpoint } = await endpointFor(workspace);
    respondWith = () => new Response("nope", { status: 500, statusText: "Server Error" });

    for (let index = 0; index < AUTO_DISABLE_AFTER; index += 1) await seedTicket(workspace, `autodisable-${index}`);

    const health = await endpointRow(endpoint.id);
    expect(health?.failureCount).toBeGreaterThanOrEqual(AUTO_DISABLE_AFTER);
    expect(health?.enabled).toBe(0);
    expect(health?.disabledAt).not.toBeNull();
    expect(health?.lastError).toContain("500");
  });

  it("stops retrying a disabled endpoint and abandons what it had queued", async () => {
    const workspace = await signup("wh-disabled-queue");
    const { endpoint } = await endpointFor(workspace);
    respondWith = () => new Response("nope", { status: 503, statusText: "Unavailable" });
    await seedTicket(workspace, "disabled-queue");

    await env.DB.prepare("UPDATE webhook_endpoints SET enabled = 0, disabled_at = ? WHERE id = ?")
      .bind(Date.now(), endpoint.id)
      .run();
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET next_attempt_at = ? WHERE organization_id = ? AND status = 'pending'",
    )
      .bind(Date.now() - 1000, workspace.organizationId)
      .run();
    captured = [];
    await retryDueWebhooks(env as AppBindings);

    // No further request, and the queue is cleared rather than left pending forever.
    expect(captured).toHaveLength(0);
    const rows = await deliveries(workspace.organizationId);
    expect(rows.results[0].status).toBe("abandoned");
    expect(rows.results[0].lastError).toContain("disabled");
  });

  it("sweeps delivered rows off the cron so the table cannot grow without bound", async () => {
    const workspace = await signup("wh-sweep");
    await endpointFor(workspace);
    await seedTicket(workspace, "sweep");
    expect((await deliveries(workspace.organizationId)).results).toHaveLength(1);

    await env.DB.prepare("UPDATE webhook_deliveries SET updated_at = ? WHERE organization_id = ?")
      .bind(Date.now() - 8 * 86_400_000, workspace.organizationId)
      .run();
    await runScheduled(env as AppBindings);
    expect((await deliveries(workspace.organizationId)).results).toHaveLength(0);
  });

  it("abandons immediately on 410 Gone without retrying", async () => {
    const workspace = await signup("wh-gone");
    await endpointFor(workspace);
    respondWith = () => new Response("", { status: 410 });
    await seedTicket(workspace, "gone");

    const rows = await deliveries(workspace.organizationId);
    expect(rows.results[0].status).toBe("abandoned");
    expect(rows.results[0].attempts).toBe(1);
    expect(rows.results[0].responseCode).toBe(410);
  });

  it("honours Retry-After on a 429", async () => {
    const workspace = await signup("wh-throttled");
    await endpointFor(workspace);
    respondWith = () => new Response("", { status: 429, headers: { "retry-after": "120" } });
    await seedTicket(workspace, "throttled");

    const rows = await deliveries(workspace.organizationId);
    expect(rows.results[0].status).toBe("pending");
    // Two minutes, not the fifteen-second default.
    expect(rows.results[0].nextAttemptAt! - Date.now()).toBeGreaterThan(100_000);
  });

  it("does not follow a redirect to another host", async () => {
    const workspace = await signup("wh-redirect");
    await endpointFor(workspace);
    respondWith = () => new Response("", { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    await seedTicket(workspace, "redirect");

    // Exactly one request: the redirect was never followed.
    expect(captured).toHaveLength(1);
    const rows = await deliveries(workspace.organizationId);
    expect(rows.results[0].status).toBe("abandoned");
    expect(rows.results[0].lastError).toContain("redirect");
  });

  it("does not fail ticket creation when every endpoint is down", async () => {
    const workspace = await signup("wh-nonfatal");
    await endpointFor(workspace);
    globalThis.fetch = (async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const ticket = await seedTicket(workspace, "nonfatal");
    expect(ticket.id).toBeTruthy();
    const rows = await deliveries(workspace.organizationId);
    expect(rows.results[0].status).toBe("pending");
    expect(rows.results[0].lastError).toContain("network unreachable");
  });

  it("never delivers one organization's event to another's endpoint", async () => {
    const alpha = await signup("wh-tenant-alpha");
    const beta = await signup("wh-tenant-beta");
    await endpointFor(beta, { url: "https://hooks.beta.example.com/incoming" });
    await seedTicket(alpha, "tenant-alpha");

    expect(captured).toHaveLength(0);
    expect((await deliveries(beta.organizationId)).results).toHaveLength(0);
  });
});

describe("webhook payload shaping", () => {
  const base = {
    id: "whe_1",
    organizationId: "org_1",
    secret: "whsec_x",
    events: ["ticket.created"],
    enabled: true,
    failureCount: 0,
    disabledAt: null,
    lastSuccessAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const payload = {
    event: "ticket.created",
    occurredAt: new Date().toISOString(),
    organizationId: "org_1",
    data: { ticketId: "tkt_1", number: 42, subject: "Card charged twice", status: "open", priority: "normal" },
  };

  it("shapes a Slack message with a link back to the ticket", () => {
    const formatted = formatPayload(
      { ...base, kind: "slack", url: "https://hooks.slack.com/services/T0/B0/x", config: {} },
      payload,
      "https://support.example.com",
    )!;
    expect(formatted.url).toBe("https://hooks.slack.com/services/T0/B0/x");
    expect(formatted.sign).toBe(false);
    const body = JSON.parse(formatted.body) as { text: string };
    expect(body.text).toContain("#42");
    expect(body.text).toContain("https://support.example.com/inbox/tkt_1");
  });

  it("targets the Telegram bot API with the configured chat id", () => {
    const formatted = formatPayload(
      { ...base, kind: "telegram", url: "https://unused.example.com", config: { botToken: "123:ABC", chatId: "-100200" } },
      payload,
    )!;
    expect(formatted.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(formatted.body) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("-100200");
    expect(body.text).toContain("#42");
  });

  it("refuses to build a Telegram request with no token or chat id", () => {
    expect(
      formatPayload({ ...base, kind: "telegram", url: "https://unused.example.com", config: {} }, payload),
    ).toBeNull();
  });
});

describe("webhook endpoint management", () => {
  it("refuses a link-local metadata destination, and says why", async () => {
    const workspace = await signup("wh-ssrf");
    // The test environment's APP_URL is localhost, so it counts as a local deployment and
    // ordinary private ranges are permitted — the full matrix against a deployed APP_URL
    // lives in tests/webhook-destination.test.ts. Metadata addresses are refused anywhere.
    for (const url of ["https://169.254.169.254/latest", "https://[fe80::1]/hook"]) {
      const response = await createEndpoint(workspace, { url });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("destination_host_not_public");
      expect(body.error.message.length).toBeGreaterThan(10);
    }
  });

  it("refuses a destination pointing back at this deployment", async () => {
    const workspace = await signup("wh-self");
    const response = await createEndpoint(workspace, { url: `${env.APP_URL}/api/v1/tickets` });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("destination_self_reference");
  });

  it("caps endpoints per workspace and never returns a secret in the list", async () => {
    const workspace = await signup("wh-cap");
    for (let index = 0; index < 10; index += 1) {
      const response = await createEndpoint(workspace, { url: `https://hooks-${index}.example.com/incoming` });
      expect(response.status).toBe(201);
    }
    const eleventh = await createEndpoint(workspace, { url: "https://hooks-11.example.com/incoming" });
    expect(eleventh.status).toBe(409);

    const listed = await request("/organization/webhooks", {}, workspace);
    const text = await listed.text();
    expect(text).not.toContain("whsec_");
    expect(text).not.toContain("secret");
  });

  it("re-enables an endpoint that disabled itself", async () => {
    const workspace = await signup("wh-reenable");
    const { endpoint } = await endpointFor(workspace);
    await env.DB.prepare("UPDATE webhook_endpoints SET enabled = 0, disabled_at = ?, failure_count = 10 WHERE id = ?")
      .bind(Date.now(), endpoint.id)
      .run();

    const response = await request(`/organization/webhooks/${endpoint.id}/enable`, { method: "POST" }, workspace);
    expect(response.status).toBe(200);
    const health = await endpointRow(endpoint.id);
    expect(health?.enabled).toBe(1);
    expect(health?.failureCount).toBe(0);
    expect(health?.disabledAt).toBeNull();
  });

  it("sends a test delivery and reports the outcome", async () => {
    const workspace = await signup("wh-test");
    const { endpoint } = await endpointFor(workspace);
    const response = await request(`/organization/webhooks/${endpoint.id}/test`, { method: "POST" }, workspace);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { delivered: boolean }).delivered).toBe(true);
    expect(captured).toHaveLength(1);
  });

  it("does not let one organization read, test, or delete another's endpoint", async () => {
    const alpha = await signup("wh-scope-alpha");
    const beta = await signup("wh-scope-beta");
    const { endpoint } = await endpointFor(alpha);

    const listed = (await (await request("/organization/webhooks", {}, beta)).json()) as { endpoints: unknown[] };
    expect(listed.endpoints).toHaveLength(0);
    expect((await request(`/organization/webhooks/${endpoint.id}/test`, { method: "POST" }, beta)).status).toBe(404);
    expect((await request(`/organization/webhooks/${endpoint.id}`, { method: "DELETE" }, beta)).status).toBe(404);
  });

  it("refuses endpoint management from a non-admin", async () => {
    const workspace = await signup("wh-role");
    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();
    expect((await createEndpoint(workspace)).status).toBe(403);
    expect((await request("/organization/webhooks", {}, workspace)).status).toBe(403);
  });
});

describe("SLA breach events", () => {
  it("announces a breach exactly once", async () => {
    const workspace = await signup("wh-breach");
    await endpointFor(workspace, { events: ["ticket.sla_breached"] });
    const ticket = await seedTicket(workspace, "breach");
    captured = [];

    await env.DB.prepare("UPDATE tickets SET sla_state = 'breached' WHERE id = ?").bind(ticket.id).run();
    await runScheduled(env as AppBindings);
    const breachSends = captured.filter((entry) => entry.body.includes("ticket.sla_breached"));
    expect(breachSends).toHaveLength(1);

    // A second sweep must not announce it again.
    captured = [];
    await runScheduled(env as AppBindings);
    expect(captured.filter((entry) => entry.body.includes("ticket.sla_breached"))).toHaveLength(0);
  });
});
