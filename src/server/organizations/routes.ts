import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "resolve-server/db";
import { organizationInvitations, organizationMemberships, users } from "resolve-server/db/schema";
import { requireAuth, requireRole } from "resolve-server/auth/middleware";
import { randomToken, sha256 } from "resolve-server/lib/crypto";
import { newId } from "resolve-server/lib/id";
import { HttpError } from "resolve-server/http/errors";
import type { HonoEnv } from "resolve-server/types";

const inviteInput = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  role: z.enum(["admin", "agent"]),
});

export const organizationRoutes = new Hono<HonoEnv>();
organizationRoutes.use("*", requireAuth);

organizationRoutes.get("/members", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB)
    .select({ id: users.id, name: users.name, email: users.email, role: organizationMemberships.role, disabledAt: organizationMemberships.disabledAt })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.organizationId, tenant.organizationId));
  return context.json({ members: rows });
});

organizationRoutes.post("/invitations", requireRole("admin"), zValidator("json", inviteInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(organizationMemberships, and(
      eq(organizationMemberships.userId, users.id),
      eq(organizationMemberships.organizationId, tenant.organizationId),
      isNull(organizationMemberships.disabledAt),
    ))
    .where(eq(users.email, input.email))
    .limit(1);
  if (existing) throw new HttpError(409, "already_member", "That person is already a member of this workspace.");

  const token = randomToken();
  const invitationId = newId("inv");
  await db.insert(organizationInvitations).values({
    id: invitationId,
    organizationId: tenant.organizationId,
    email: input.email,
    role: input.role,
    tokenHash: await sha256(`${token}.${context.env.SESSION_PEPPER}`),
    invitedByUserId: tenant.userId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return context.json({ invitation: { id: invitationId, email: input.email, role: input.role, inviteUrl: `${context.env.APP_URL}/accept-invite?token=${encodeURIComponent(token)}` } }, 201);
});

organizationRoutes.patch("/members/:userId", requireRole("admin"), zValidator("json", z.object({ role: z.enum(["admin", "agent"]).optional(), disabled: z.boolean().optional() })), async (context) => {
  const tenant = context.get("tenant");
  const targetUserId = context.req.param("userId");
  if (targetUserId === tenant.userId) throw new HttpError(409, "self_change", "You cannot change your own membership here.");
  const values = context.req.valid("json");
  const result = await createDb(context.env.DB).update(organizationMemberships).set({
    ...(values.role ? { role: values.role } : {}),
    ...(values.disabled !== undefined ? { disabledAt: values.disabled ? new Date() : null } : {}),
  }).where(and(
    eq(organizationMemberships.organizationId, tenant.organizationId),
    eq(organizationMemberships.userId, targetUserId),
  ));
  if (!result.meta.changes) throw new HttpError(404, "member_not_found", "Team member not found.");
  return context.json({ ok: true });
});
