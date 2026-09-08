import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { validate } from "../http/validate";
import { newId } from "../lib/id";
import { ruleInput } from "./service";
import { automationRules, automationRuns, inboxes, tickets } from "../db/schema";
import { HttpError } from "../http/errors";
import type { HonoEnv } from "../types";

export const automationRoutes = new Hono<HonoEnv>();
automationRoutes.use("*", requireAuth);

automationRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB)
    .select()
    .from(automationRules)
    .where(eq(automationRules.organizationId, tenant.organizationId))
    .orderBy(automationRules.position, automationRules.id);
  return context.json({ rules: rows });
});

automationRoutes.post("/", requireRole("admin"), validate("json", ruleInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  if (input.conditions.some((condition) => condition.field === "inboxId")) {
    const inbox = await db
      .select({ id: inboxes.id })
      .from(inboxes)
      .where(
        and(
          eq(inboxes.organizationId, tenant.organizationId),
          eq(inboxes.id, input.conditions.find((condition) => condition.field === "inboxId")!.value),
        ),
      )
      .limit(1);
    if (!inbox.length) throw new HttpError(400, "unknown_inbox", "The rule references an inbox that does not exist.");
  }
  const [{ position }] = await db
    .select({ position: sql<number>`coalesce(max(${automationRules.position}), 0)` })
    .from(automationRules)
    .where(eq(automationRules.organizationId, tenant.organizationId));
  const id = newId("rul");
  const now = new Date();
  await db.insert(automationRules).values({
    id,
    organizationId: tenant.organizationId,
    name: input.name,
    enabled: input.enabled,
    position: position + 1,
    conditions: input.conditions,
    actions: input.actions,
    createdByUserId: tenant.userId,
    createdAt: now,
    updatedAt: now,
  });
  return context.json({ rule: { id, position: position + 1 } }, 201);
});

automationRoutes.patch(
  "/:id",
  requireRole("admin"),
  validate(
    "json",
    ruleInput.partial().extend({
      position: z.number().int().min(0).max(999).optional(),
    }),
  ),
  async (context) => {
    const tenant = context.get("tenant");
    const input = context.req.valid("json");
    const result = await createDb(context.env.DB)
      .update(automationRules)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(eq(automationRules.id, context.req.param("id")), eq(automationRules.organizationId, tenant.organizationId)),
      );
    if (!result.meta.changes) throw new HttpError(404, "rule_not_found", "Automation rule not found.");
    return context.json({ ok: true });
  },
);

automationRoutes.delete("/:id", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  const result = await createDb(context.env.DB)
    .delete(automationRules)
    .where(
      and(eq(automationRules.id, context.req.param("id")), eq(automationRules.organizationId, tenant.organizationId)),
    );
  if (!result.meta.changes) throw new HttpError(404, "rule_not_found", "Automation rule not found.");
  return context.json({ ok: true });
});

automationRoutes.get("/runs", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB)
    .select({
      id: automationRuns.id,
      ruleName: automationRules.name,
      ticketNumber: tickets.number,
      ticketSubject: tickets.subject,
      ticketId: automationRuns.ticketId,
      eventKey: automationRuns.eventKey,
      applied: automationRuns.applied,
      createdAt: automationRuns.createdAt,
    })
    .from(automationRuns)
    .innerJoin(
      automationRules,
      and(eq(automationRules.id, automationRuns.ruleId), eq(automationRules.organizationId, tenant.organizationId)),
    )
    .innerJoin(tickets, and(eq(tickets.id, automationRuns.ticketId), eq(tickets.organizationId, tenant.organizationId)))
    .where(eq(automationRuns.organizationId, tenant.organizationId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(50);
  return context.json({ runs: rows });
});
