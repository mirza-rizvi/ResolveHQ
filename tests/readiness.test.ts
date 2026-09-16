import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { evaluateReadiness, readinessBlocking, type ReadinessCheck } from "resolve-server/operations/readiness";
import type { AppBindings } from "resolve-server/types";
import { request, signup, type TestSession } from "./helpers";

type DnsFixture = Record<string, { Status: number; Answer?: Array<{ name: string; type: number; data: string }> }>;

/** Builds a fetch stub that answers DoH queries from a fixture keyed `<name>|<type>`. */
function dohStub(fixture: DnsFixture, onCall?: () => void) {
  return (async (input: RequestInfo | URL) => {
    onCall?.();
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const key = `${url.searchParams.get("name")}|${url.searchParams.get("type")}`;
    const body = fixture[key] ?? { Status: 3 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/dns-json" } });
  }) as unknown as typeof fetch;
}

const mx = (data: string) => ({ name: "acme.test", type: 15, data });
const txt = (name: string, data: string) => ({ name, type: 16, data: `"${data}"` });

function healthyFixture(): DnsFixture {
  return {
    "acme.test|MX": { Status: 0, Answer: [mx("10 route1.mx.cloudflare.net.")] },
    "acme.test|TXT": { Status: 0, Answer: [txt("acme.test", "v=spf1 include:amazonses.com ~all")] },
    "resend._domainkey.acme.test|TXT": {
      Status: 0,
      Answer: [txt("resend._domainkey.acme.test", "v=DKIM1; k=rsa; p=MIIBIjANBg")],
    },
    "_dmarc.acme.test|TXT": { Status: 0, Answer: [txt("_dmarc.acme.test", "v=DMARC1; p=none;")] },
  };
}

/** Points the workspace's only inbox at acme.test so the DNS fixtures apply. */
async function workspaceOnAcme(suffix: string): Promise<TestSession> {
  const session = await signup(suffix);
  await env.DB.prepare("UPDATE inboxes SET email_address = ? WHERE organization_id = ?")
    .bind(`support-${suffix}@acme.test`, session.organizationId)
    .run();
  return session;
}

function mailEnv(overrides: Partial<AppBindings> = {}): AppBindings {
  return { ...(env as unknown as AppBindings), RESEND_API_KEY: "re_test_key", ...overrides };
}

function find(checks: ReadinessCheck[], id: string) {
  const check = checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`No readiness check with id ${id}. Got: ${checks.map((c) => c.id).join(", ")}`);
  return check;
}

describe("readiness DNS checks", () => {
  it("reports every DNS check ready when all records are present", async () => {
    const workspace = await workspaceOnAcme("readiness-healthy");
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub(healthyFixture()));
    expect(find(report.checks, "dns.mx.acme.test").status).toBe("ready");
    expect(find(report.checks, "dns.spf.acme.test").status).toBe("ready");
    expect(find(report.checks, "dns.dkim.acme.test").status).toBe("ready");
    expect(find(report.checks, "dns.dmarc.acme.test").status).toBe("ready");
  });

  it("fails the MX check with an actionable detail when no MX record exists", async () => {
    const workspace = await workspaceOnAcme("readiness-nomx");
    const fixture = healthyFixture();
    fixture["acme.test|MX"] = { Status: 0, Answer: [] };
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub(fixture));
    const check = find(report.checks, "dns.mx.acme.test");
    expect(check.status).toBe("failed");
    expect(check.advisory).toBe(false);
    expect(check.detail).toContain("Email Routing");
    expect(check.observed).toBe("Found: no MX records");
  });

  it("degrades SPF when the provider include is absent and shows the record found", async () => {
    const workspace = await workspaceOnAcme("readiness-spf");
    const fixture = healthyFixture();
    fixture["acme.test|TXT"] = { Status: 0, Answer: [txt("acme.test", "v=spf1 include:example.net ~all")] };
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub(fixture));
    const check = find(report.checks, "dns.spf.acme.test");
    expect(check.status).toBe("degraded");
    expect(check.observed).toBe("Found: v=spf1 include:example.net ~all");
  });

  it("degrades when a domain publishes more than one SPF record", async () => {
    const workspace = await workspaceOnAcme("readiness-spf-dup");
    const fixture = healthyFixture();
    fixture["acme.test|TXT"] = {
      Status: 0,
      Answer: [txt("acme.test", "v=spf1 include:amazonses.com ~all"), txt("acme.test", "v=spf1 include:example.net ~all")],
    };
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub(fixture));
    const check = find(report.checks, "dns.spf.acme.test");
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("more than one SPF record");
  });

  it("treats a missing DMARC record as advisory, never as a failure", async () => {
    const workspace = await workspaceOnAcme("readiness-dmarc");
    const fixture = healthyFixture();
    delete fixture["_dmarc.acme.test|TXT"];
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub(fixture));
    const check = find(report.checks, "dns.dmarc.acme.test");
    expect(check.status).toBe("degraded");
    expect(check.advisory).toBe(true);
    expect(readinessBlocking(report).some((entry) => entry.id === check.id)).toBe(false);
  });

  it("fails the MX check on NXDOMAIN", async () => {
    const workspace = await workspaceOnAcme("readiness-nxdomain");
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub({}));
    expect(find(report.checks, "dns.mx.acme.test").status).toBe("failed");
  });

  it("reports unknown, and throws nothing, when the resolver is unreachable", async () => {
    const workspace = await workspaceOnAcme("readiness-unreachable");
    const exploding = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, exploding);
    const check = find(report.checks, "dns.mx.acme.test");
    expect(check.status).toBe("unknown");
    expect(check.detail).toContain("does not mean your record is missing");
    expect(readinessBlocking(report).some((entry) => entry.id === check.id)).toBe(false);
  });

  it("queries a shared domain once even with several inboxes on it", async () => {
    const workspace = await workspaceOnAcme("readiness-dedupe");
    const added = await request(
      "/organization/inboxes",
      { method: "POST", body: JSON.stringify({ name: "Billing", emailAddress: "billing-dedupe@acme.test" }) },
      workspace,
    );
    expect(added.status).toBe(201);
    let calls = 0;
    const report = await evaluateReadiness(
      mailEnv(),
      workspace.organizationId,
      dohStub(healthyFixture(), () => {
        calls += 1;
      }),
    );
    // One domain, four record types.
    expect(calls).toBe(4);
    expect(report.checks.filter((check) => check.id.startsWith("dns.mx.")).length).toBe(1);
  });
});

describe("readiness configuration checks", () => {
  it("fails when SESSION_PEPPER is shorter than 32 characters", async () => {
    const workspace = await workspaceOnAcme("readiness-pepper");
    const report = await evaluateReadiness(
      mailEnv({ SESSION_PEPPER: "too-short" }),
      workspace.organizationId,
      dohStub(healthyFixture()),
    );
    expect(find(report.checks, "config.session_pepper").status).toBe("failed");
  });

  it("fails when exactly one Turnstile key is set", async () => {
    const workspace = await workspaceOnAcme("readiness-turnstile");
    const report = await evaluateReadiness(
      mailEnv({ TURNSTILE_SITE_KEY: "site-key-only" }),
      workspace.organizationId,
      dohStub(healthyFixture()),
    );
    const check = find(report.checks, "config.turnstile");
    expect(check.status).toBe("failed");
    expect(check.advisory).toBe(false);
  });

  it("keeps Turnstile advisory and ready when neither key is set", async () => {
    const workspace = await workspaceOnAcme("readiness-turnstile-off");
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub(healthyFixture()));
    const check = find(report.checks, "config.turnstile");
    expect(check.status).toBe("ready");
    expect(check.advisory).toBe(true);
  });

  it("fails when APP_URL is set to something unparseable", async () => {
    const workspace = await workspaceOnAcme("readiness-appurl");
    const report = await evaluateReadiness(
      mailEnv({ APP_URL: "not a url" }),
      workspace.organizationId,
      dohStub(healthyFixture()),
    );
    expect(find(report.checks, "config.app_url").status).toBe("failed");
  });

  it("never lets the AI check block setup", async () => {
    const workspace = await workspaceOnAcme("readiness-ai");
    const report = await evaluateReadiness(mailEnv(), workspace.organizationId, dohStub(healthyFixture()));
    const check = find(report.checks, "config.ai");
    expect(check.advisory).toBe(true);
    expect(readinessBlocking(report).some((entry) => entry.id === check.id)).toBe(false);
  });
});

describe("readiness route", () => {
  it("caches per organization and does not re-check within the TTL", async () => {
    const workspace = await workspaceOnAcme("readiness-cache");
    const first = await request("/operations/readiness", {}, workspace);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { cached: boolean }).cached).toBe(false);

    const second = await request("/operations/readiness", {}, workspace);
    expect(((await second.json()) as { cached: boolean }).cached).toBe(true);

    const refreshed = await request("/operations/readiness?refresh=1", {}, workspace);
    expect(((await refreshed.json()) as { cached: boolean }).cached).toBe(false);
  });

  it("never returns one organization's cached report to another", async () => {
    const alpha = await workspaceOnAcme("readiness-tenant-alpha");
    const beta = await signup("readiness-tenant-beta");
    await request("/operations/readiness", {}, alpha);

    const response = await request("/operations/readiness", {}, beta);
    const body = (await response.json()) as { cached: boolean; checks: ReadinessCheck[] };
    expect(body.cached).toBe(false);
    expect(body.checks.some((check) => check.id.includes("acme.test"))).toBe(false);
  });

  it("refuses a non-admin", async () => {
    const workspace = await signup("readiness-role");
    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();
    const response = await request("/operations/readiness", {}, workspace);
    expect(response.status).toBe(403);
  });
});
