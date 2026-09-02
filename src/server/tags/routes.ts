import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { tags } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { validate } from "resolve-server/http/validate";
import { newId } from "resolve-server/lib/id";
import type { HonoEnv } from "resolve-server/types";

const tagInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((value) => value.toLowerCase()),
  color: z.enum(["slate", "blue", "green", "amber", "red", "violet", "pink"]).default("slate"),
});

export const tagRoutes = new Hono<HonoEnv>();
tagRoutes.use("*", requireAuth);
tagRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB)
    .select()
    .from(tags)
    .where(eq(tags.organizationId, tenant.organizationId))
    .orderBy(asc(tags.name));
  return context.json({ tags: rows });
});
tagRoutes.post("/", validate("json", tagInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const id = newId("tag");
  try {
    await createDb(context.env.DB)
      .insert(tags)
      .values({ id, organizationId: tenant.organizationId, ...input });
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      throw new HttpError(409, "tag_exists", "A tag with this name already exists.");
    throw error;
  }
  return context.json({ tag: { id, ...input } }, 201);
});
