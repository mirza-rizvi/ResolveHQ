import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { API_SCOPES } from "../auth/api-key";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { apiKeys, organizationMemberships } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { newId } from "../lib/id";
import { randomToken, sha256 } from "../lib/crypto";
import type { HonoEnv } from "../types";

const createInput = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
  /** Null or omitted means every inbox. */
  inboxIds: z.array(z.string().min(1).max(80)).max(20).nullable().default(null),
  /** Epoch ms. Omitted means the key does not expire. */
  expiresAt: z.number().int().positive().nullable().default(null),
});

export const apiKeyRoutes = new Hono<HonoEnv>();
apiKeyRoutes.use("*", requireAuth);

/**
 * Metadata only. `key_hash` is never selected in a response path — the columns are
 * listed explicitly rather than selecting the row, so adding a secret column later
 * cannot leak it by accident.
 */
apiKeyRoutes.get("/", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      inboxIds: apiKeys.inboxIds,
      createdByUserId: apiKeys.createdByUserId,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, tenant.organizationId))
    .orderBy(desc(apiKeys.createdAt));

  // An orphaned key fails every request. Saying so beats letting it fail silently.
  const members = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, tenant.organizationId),
        isNull(organizationMemberships.disabledAt),
      ),
    );
  const active = new Set(members.map((member) => member.userId));
  return context.json({
    keys: rows.map(({ createdByUserId, ...row }) => ({
      ...row,
      orphaned: !createdByUserId || !active.has(createdByUserId),
    })),
  });
});

apiKeyRoutes.post("/", requireRole("admin"), validate("json", createInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  if (input.expiresAt !== null && input.expiresAt <= Date.now())
    throw new HttpError(400, "expiry_in_past", "Choose an expiry date in the future.");

  // Only the hash is stored. The key itself is returned once, in this response, and
  // can never be recovered afterwards.
  const secret = randomToken(24);
  const key = `rhq_live_${secret}`;
  const id = newId("apk");
  const now = new Date();
  await createDb(context.env.DB)
    .insert(apiKeys)
    .values({
      id,
      organizationId: tenant.organizationId,
      name: input.name,
      prefix: key.slice(0, 12),
      keyHash: await sha256(key),
      scopes: input.scopes,
      inboxIds: input.inboxIds,
      createdByUserId: tenant.userId,
      expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
      createdAt: now,
      updatedAt: now,
    });
  return context.json(
    {
      key,
      apiKey: {
        id,
        name: input.name,
        prefix: key.slice(0, 12),
        scopes: input.scopes,
        inboxIds: input.inboxIds,
        expiresAt: input.expiresAt,
        createdAt: now.toISOString(),
        orphaned: false,
      },
    },
    201,
  );
});

apiKeyRoutes.delete("/:id", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  // Revoked rather than deleted, so the audit trail of what existed survives.
  const result = await createDb(context.env.DB)
    .update(apiKeys)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, context.req.param("id")),
        eq(apiKeys.organizationId, tenant.organizationId),
        isNull(apiKeys.revokedAt),
      ),
    );
  if (!result.meta.changes) throw new HttpError(404, "api_key_not_found", "API key not found.");
  return context.json({ ok: true });
});
