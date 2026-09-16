import { and, desc, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { csatResponses, settings, tickets } from "../db/schema";
import { validate } from "../http/validate";
import type { HonoEnv } from "../types";
import { CSAT_ENABLED_KEY, CSAT_PROMPT_KEY, readCsatSettings } from "./service";

const csatSettingsInput = z.object({
  enabled: z.boolean(),
  prompt: z.string().trim().min(1).max(160),
});

/** Admin-facing counterpart to the public rating routes. */
export const csatAdminRoutes = new Hono<HonoEnv>();
csatAdminRoutes.use("*", requireAuth);

csatAdminRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const config = await readCsatSettings(context.env, tenant.organizationId);
  const recent = await createDb(context.env.DB)
    .select({
      id: csatResponses.id,
      rating: csatResponses.rating,
      comment: csatResponses.comment,
      respondedAt: csatResponses.respondedAt,
      ticketNumber: tickets.number,
      ticketId: tickets.id,
    })
    .from(csatResponses)
    .innerJoin(tickets, and(eq(tickets.id, csatResponses.ticketId), eq(tickets.organizationId, tenant.organizationId)))
    .where(and(eq(csatResponses.organizationId, tenant.organizationId), isNotNull(csatResponses.respondedAt)))
    .orderBy(desc(csatResponses.respondedAt))
    .limit(10);
  return context.json({ ...config, recent });
});

csatAdminRoutes.put("/", requireRole("admin"), validate("json", csatSettingsInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const now = new Date();
  const db = createDb(context.env.DB);
  const upsert = (key: string, value: unknown) =>
    db
      .insert(settings)
      .values({ organizationId: tenant.organizationId, key, value, updatedByUserId: tenant.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.organizationId, settings.key],
        set: { value, updatedByUserId: tenant.userId, updatedAt: now },
      });
  await db.batch([upsert(CSAT_ENABLED_KEY, input.enabled), upsert(CSAT_PROMPT_KEY, input.prompt)]);
  return context.json({ ...input });
});
