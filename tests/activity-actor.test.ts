import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { recordActivity, sanitizeMetadata } from "resolve-server/activity/service";
import { createDb } from "resolve-server/db";
import { processInboundMail } from "resolve-server/mail/queue";
import type { AppBindings, TenantContext } from "resolve-server/types";
import { mimeMessage, request, signup, type TestSession } from "./helpers";

function tenantOf(session: TestSession): TenantContext {
  return {
    requestId: "req_activity_test",
    userId: session.userId,
    organizationId: session.organizationId,
    role: "owner",
    csrfToken: session.csrf,
  };
}

interface ActivityRow {
  actorType: string;
  actorUserId: string | null;
  actorLabel: string | null;
  metadata: string;
}

function activityByEvent(organizationId: string, eventType: string) {
  return env.DB.prepare(
    "SELECT actor_type AS actorType, actor_user_id AS actorUserId, actor_label AS actorLabel, metadata FROM activity_logs WHERE organization_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(organizationId, eventType)
    .first<ActivityRow>();
}

describe("activity metadata denylist", () => {
  it("strips denylisted keys and records which were removed", () => {
    const clean = sanitizeMetadata({ token: "sk-live-123", to: "high", from: "normal" });
    expect(clean.token).toBeUndefined();
    expect(clean.to).toBe("high");
    expect(clean.from).toBe("normal");
    expect(clean.redacted).toEqual(["token"]);
  });

  it("compares keys case-insensitively", () => {
    const clean = sanitizeMetadata({ Email: "a@b.test", TOKEN: "x", Secret: "y", number: 12 });
    expect(clean.Email).toBeUndefined();
    expect(clean.TOKEN).toBeUndefined();
    expect(clean.Secret).toBeUndefined();
    expect(clean.number).toBe(12);
    expect(clean.redacted).toEqual(["Email", "TOKEN", "Secret"]);
  });

  it("leaves metadata without denylisted keys untouched and adds no marker", () => {
    const clean = sanitizeMetadata({ from: "open", to: "resolved", count: 3 });
    expect(clean).toEqual({ from: "open", to: "resolved", count: 3 });
    expect(clean.redacted).toBeUndefined();
  });

  it("does not traverse nested objects (documented limitation)", () => {
    const clean = sanitizeMetadata({ payload: { token: "sk-live-123" } });
    expect(clean.payload).toEqual({ token: "sk-live-123" });
    expect(clean.redacted).toBeUndefined();
  });

  it("persists a sanitized row through recordActivity", async () => {
    const workspace = await signup("activity-denylist");
    const db = createDb(env.DB);
    await recordActivity(db, tenantOf(workspace), {
      eventType: "test.denylist",
      entityType: "ticket",
      entityId: "tkt_denylist",
      metadata: { subject: "Password reset for acme", to: "urgent" },
    });
    const row = await activityByEvent(workspace.organizationId, "test.denylist");
    const metadata = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.subject).toBeUndefined();
    expect(metadata.to).toBe("urgent");
    expect(metadata.redacted).toEqual(["subject"]);
  });
});

describe("activity actor types", () => {
  it("defaults to the user actor with the acting user recorded", async () => {
    const workspace = await signup("activity-user");
    const db = createDb(env.DB);
    await recordActivity(db, tenantOf(workspace), {
      eventType: "test.user_action",
      entityType: "ticket",
      entityId: "tkt_user",
    });
    const row = await activityByEvent(workspace.organizationId, "test.user_action");
    expect(row?.actorType).toBe("user");
    expect(row?.actorUserId).toBe(workspace.userId);
    expect(row?.actorLabel).toBeNull();
  });

  it("clears the actor user for automation, customer and system actors", async () => {
    const workspace = await signup("activity-nonhuman");
    const db = createDb(env.DB);
    for (const actorType of ["automation", "customer", "system"] as const) {
      await recordActivity(db, tenantOf(workspace), {
        eventType: `test.${actorType}`,
        entityType: "ticket",
        entityId: `tkt_${actorType}`,
        actorType,
        actorLabel: `${actorType} label`,
      });
      const row = await activityByEvent(workspace.organizationId, `test.${actorType}`);
      expect(row?.actorType).toBe(actorType);
      expect(row?.actorUserId).toBeNull();
      expect(row?.actorLabel).toBe(`${actorType} label`);
    }
  });

  it("keeps the requesting user on an ai actor", async () => {
    const workspace = await signup("activity-ai");
    const db = createDb(env.DB);
    await recordActivity(db, tenantOf(workspace), {
      eventType: "test.ai_action",
      entityType: "ticket",
      entityId: "tkt_ai",
      actorType: "ai",
      actorLabel: "@cf/meta/llama-3.1-8b-instruct",
    });
    const row = await activityByEvent(workspace.organizationId, "test.ai_action");
    expect(row?.actorType).toBe("ai");
    expect(row?.actorUserId).toBe(workspace.userId);
    expect(row?.actorLabel).toBe("@cf/meta/llama-3.1-8b-instruct");
  });

  it("attributes an automation rule run to the automation actor", async () => {
    const workspace = await signup("activity-automation");
    const created = await request(
      "/automations",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Route billing to finance",
          enabled: true,
          conditions: [{ field: "subject", op: "contains", value: "invoice" }],
          actions: [{ type: "set_priority", priority: "urgent" }],
        }),
      },
      workspace,
    );
    expect(created.status).toBe(201);

    const customerResponse = await request(
      "/customers",
      { method: "POST", body: JSON.stringify({ name: "Casey Customer", email: "casey-automation@example.test" }) },
      workspace,
    );
    expect(customerResponse.status).toBe(201);
    const customer = ((await customerResponse.json()) as { customer: { id: string } }).customer;

    const ticket = await request(
      "/tickets",
      {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.id,
          subject: "Invoice question",
          message: "Where can I find my invoice?",
          priority: "normal",
        }),
      },
      workspace,
    );
    expect(ticket.status).toBe(201);

    const row = await activityByEvent(workspace.organizationId, "automation.priority_changed");
    expect(row?.actorType).toBe("automation");
    expect(row?.actorUserId).toBeNull();
    expect(row?.actorLabel).toBe("Route billing to finance");
  });

  it("attributes an inbound customer email to the customer actor", async () => {
    const workspace = await signup("activity-inbound");
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
      .bind("help-activity@example.test", workspace.organizationId)
      .run();
    await processInboundMail(env as AppBindings, {
      raw: mimeMessage({
        id: "<activity-inbound-1@example.test>",
        to: "help-activity@example.test",
        subject: "Checkout cannot complete",
        body: "The checkout spinner never stops.",
      }),
      from: "customer@example.test",
      to: "help-activity@example.test",
    });

    const row = await activityByEvent(workspace.organizationId, "ticket.created_from_email");
    expect(row?.actorType).toBe("customer");
    expect(row?.actorUserId).toBeNull();
  });

  it("never exposes another organization's activity on the dashboard", async () => {
    const alpha = await signup("activity-tenant-alpha");
    const beta = await signup("activity-tenant-beta");
    const db = createDb(env.DB);
    await recordActivity(db, tenantOf(alpha), {
      eventType: "test.tenant_scope",
      entityType: "ticket",
      entityId: "tkt_alpha_only",
      actorType: "automation",
      actorLabel: "Alpha only rule",
    });

    const response = await request("/operations/dashboard", {}, beta);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      recentActivity: Array<{ eventType: string; actorType: string; actorLabel: string | null }>;
    };
    expect(body.recentActivity.some((entry) => entry.eventType === "test.tenant_scope")).toBe(false);
    expect(body.recentActivity.some((entry) => entry.actorLabel === "Alpha only rule")).toBe(false);
  });

  it("returns actor type and label on the dashboard activity feed", async () => {
    const workspace = await signup("activity-dashboard");
    const db = createDb(env.DB);
    await recordActivity(db, tenantOf(workspace), {
      eventType: "test.dashboard_feed",
      entityType: "ticket",
      entityId: "tkt_dashboard",
      actorType: "api_key",
      actorLabel: "Zapier integration",
    });

    const response = await request("/operations/dashboard", {}, workspace);
    const body = (await response.json()) as {
      recentActivity: Array<{ eventType: string; actorType: string; actorLabel: string | null }>;
    };
    const entry = body.recentActivity.find((item) => item.eventType === "test.dashboard_feed");
    expect(entry?.actorType).toBe("api_key");
    expect(entry?.actorLabel).toBe("Zapier integration");
  });
});
