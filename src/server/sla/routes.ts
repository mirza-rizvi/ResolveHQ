import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { settings, slaPolicies } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { newId } from "../lib/id";
import type { HonoEnv } from "../types";
import { ticketPriorities } from "../../shared/domain";
import { BUSINESS_HOURS_KEY, misconfiguredDays, parseBusinessHours } from "./service";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const businessHoursInput = z.object({
  timezone: z.string().trim().min(1).max(64),
  days: z
    .array(
      z.object({
        day: z.number().int().min(0).max(6),
        start: z.string().regex(timePattern, "Use HH:MM, for example 09:00."),
        end: z.string().regex(timePattern, "Use HH:MM, for example 17:30."),
      }),
    )
    .max(7),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60),
});

const policyInput = z.object({
  name: z.string().trim().min(1).max(120),
  // Null is the workspace default; the database enforces one default and one policy per priority.
  priority: z.enum(ticketPriorities).nullable().default(null),
  firstResponseMinutes: z.number().int().positive().max(100_000).nullable().default(null),
  resolutionMinutes: z.number().int().positive().max(1_000_000).nullable().default(null),
  enabled: z.boolean().default(true),
});

export const slaRoutes = new Hono<HonoEnv>();
slaRoutes.use("*", requireAuth);

slaRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [hoursRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.organizationId, tenant.organizationId), eq(settings.key, BUSINESS_HOURS_KEY)))
    .limit(1);
  const businessHours = parseBusinessHours(hoursRow?.value);
  const policies = await db
    .select()
    .from(slaPolicies)
    .where(eq(slaPolicies.organizationId, tenant.organizationId))
    .orderBy(asc(slaPolicies.priority), asc(slaPolicies.name));
  return context.json({
    businessHours,
    // Surfaced so Settings can warn about a day that can never open.
    misconfiguredDays: misconfiguredDays(businessHours),
    policies,
  });
});

slaRoutes.put("/business-hours", requireRole("admin"), validate("json", businessHoursInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw new HttpError(400, "invalid_timezone", "That is not a timezone this server recognises.");
  }
  const now = new Date();
  await createDb(context.env.DB)
    .insert(settings)
    .values({
      organizationId: tenant.organizationId,
      key: BUSINESS_HOURS_KEY,
      value: input,
      updatedByUserId: tenant.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [settings.organizationId, settings.key],
      set: { value: input, updatedByUserId: tenant.userId, updatedAt: now },
    });
  return context.json({ businessHours: parseBusinessHours(input), misconfiguredDays: misconfiguredDays(input) });
});

slaRoutes.post("/policies", requireRole("admin"), validate("json", policyInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  if (input.firstResponseMinutes === null && input.resolutionMinutes === null)
    throw new HttpError(400, "empty_policy", "Set a first-response target, a resolution target, or both.");
  const id = newId("slp");
  try {
    await createDb(context.env.DB)
      .insert(slaPolicies)
      .values({ id, organizationId: tenant.organizationId, ...input });
  } catch (reason) {
    throw duplicateOrRethrow(reason, input.priority);
  }
  return context.json({ policy: { id, organizationId: tenant.organizationId, ...input } }, 201);
});

slaRoutes.patch("/policies/:id", requireRole("admin"), validate("json", policyInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  if (input.firstResponseMinutes === null && input.resolutionMinutes === null)
    throw new HttpError(400, "empty_policy", "Set a first-response target, a resolution target, or both.");
  let result;
  try {
    result = await createDb(context.env.DB)
      .update(slaPolicies)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(slaPolicies.id, context.req.param("id")),
          eq(slaPolicies.organizationId, tenant.organizationId),
        ),
      );
  } catch (reason) {
    throw duplicateOrRethrow(reason, input.priority);
  }
  if (!result.meta.changes) throw new HttpError(404, "policy_not_found", "SLA policy not found.");
  return context.json({ ok: true });
});

slaRoutes.delete("/policies/:id", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  // Tickets keep their computed due dates: sla_policy_id is a plain column, not a
  // foreign key, so deleting a policy never rewrites history.
  const result = await createDb(context.env.DB)
    .delete(slaPolicies)
    .where(
      and(eq(slaPolicies.id, context.req.param("id")), eq(slaPolicies.organizationId, tenant.organizationId)),
    );
  if (!result.meta.changes) throw new HttpError(404, "policy_not_found", "SLA policy not found.");
  return context.json({ ok: true });
});

/**
 * The uniqueness rules live in SQL, so a violation has to be translated back into plain
 * language. Drizzle wraps the driver error, so the constraint text is on the cause chain
 * rather than the top-level message.
 */
function describe(reason: unknown, depth = 0): string {
  if (depth > 4 || !(reason instanceof Error)) return String(reason);
  return `${reason.message} ${describe(reason.cause, depth + 1)}`;
}

function duplicateOrRethrow(reason: unknown, priority: string | null) {
  if (!describe(reason).includes("UNIQUE constraint failed")) return reason;
  return new HttpError(
    409,
    "policy_exists",
    priority
      ? `This workspace already has a policy for ${priority} priority. Edit that one instead.`
      : "This workspace already has a default policy. Edit that one instead.",
  );
}
