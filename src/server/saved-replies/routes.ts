import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { savedReplies } from "resolve-server/db/schema";
import { newId } from "resolve-server/lib/id";
import type { HonoEnv } from "resolve-server/types";

const inputSchema = z.object({ name: z.string().trim().min(1).max(100), content: z.string().trim().min(1).max(50_000), category: z.string().trim().max(80).optional().nullable() });

export const savedReplyRoutes = new Hono<HonoEnv>();
savedReplyRoutes.use("*", requireAuth);
savedReplyRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB).select().from(savedReplies).where(eq(savedReplies.organizationId, tenant.organizationId)).orderBy(asc(savedReplies.category), asc(savedReplies.name));
  return context.json({ savedReplies: rows });
});
savedReplyRoutes.post("/", zValidator("json", inputSchema), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const id = newId("rpl");
  await createDb(context.env.DB).insert(savedReplies).values({ id, organizationId: tenant.organizationId, createdByUserId: tenant.userId, ...input });
  return context.json({ savedReply: { id, ...input } }, 201);
});
savedReplyRoutes.patch("/:id", zValidator("json", inputSchema.partial()), async (context) => {
  const tenant = context.get("tenant");
  await createDb(context.env.DB).update(savedReplies).set({ ...context.req.valid("json"), updatedAt: new Date() }).where(and(eq(savedReplies.id, context.req.param("id")), eq(savedReplies.organizationId, tenant.organizationId)));
  return context.json({ ok: true });
});
