import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "resolve-server/db";
import {
  inboxes,
  organizationInvitations,
  organizationMemberships,
  organizations,
  users,
} from "resolve-server/db/schema";
import { requireAuth, requireRole } from "resolve-server/auth/middleware";
import { randomToken, sha256 } from "resolve-server/lib/crypto";
import { newId } from "resolve-server/lib/id";
import { sendSystemMail } from "resolve-server/mail/system";
import { HttpError } from "resolve-server/http/errors";
import { validate } from "resolve-server/http/validate";
import type { HonoEnv } from "resolve-server/types";

const inviteInput = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  role: z.enum(["admin", "agent"]),
});

export const organizationRoutes = new Hono<HonoEnv>();
organizationRoutes.use("*", requireAuth);

organizationRoutes.get("/members", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB)
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: organizationMemberships.role,
      disabledAt: organizationMemberships.disabledAt,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(eq(organizationMemberships.organizationId, tenant.organizationId));
  return context.json({ members: rows });
});

organizationRoutes.get("/settings", async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [workspace, inboxRows] = await Promise.all([
    db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, tenant.organizationId))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        id: inboxes.id,
        name: inboxes.name,
        emailAddress: inboxes.emailAddress,
        provider: inboxes.provider,
        isDefault: inboxes.isDefault,
        disabledAt: inboxes.disabledAt,
      })
      .from(inboxes)
      .where(eq(inboxes.organizationId, tenant.organizationId)),
  ]);
  return context.json({
    workspace,
    inboxes: inboxRows,
    mail: {
      resendConfigured: Boolean(context.env.RESEND_API_KEY),
      webhookConfigured: Boolean(context.env.RESEND_WEBHOOK_SECRET),
    },
  });
});

organizationRoutes.patch(
  "/settings",
  requireRole("admin"),
  validate("json", z.object({ name: z.string().trim().min(2).max(120) })),
  async (context) => {
    const tenant = context.get("tenant");
    const input = context.req.valid("json");
    await createDb(context.env.DB)
      .update(organizations)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(organizations.id, tenant.organizationId));
    return context.json({ workspace: { id: tenant.organizationId, name: input.name } });
  },
);

organizationRoutes.post(
  "/inboxes",
  requireRole("admin"),
  validate(
    "json",
    z.object({
      name: z.string().trim().min(1).max(80),
      emailAddress: z
        .string()
        .trim()
        .email()
        .max(254)
        .transform((value) => value.toLowerCase()),
    }),
  ),
  async (context) => {
    const tenant = context.get("tenant");
    const input = context.req.valid("json");
    const id = newId("inb");
    try {
      await createDb(context.env.DB)
        .insert(inboxes)
        .values({
          id,
          organizationId: tenant.organizationId,
          name: input.name,
          emailAddress: input.emailAddress,
          provider: "cloudflare_email",
        });
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new HttpError(409, "inbox_address_exists", "That inbox address is already in use.");
      throw error;
    }
    return context.json({ inbox: { id, ...input, provider: "cloudflare_email" } }, 201);
  },
);

organizationRoutes.patch(
  "/inboxes/:id",
  requireRole("admin"),
  validate("json", z.object({ name: z.string().trim().min(1).max(80).optional(), disabled: z.boolean().optional() })),
  async (context) => {
    const tenant = context.get("tenant");
    const input = context.req.valid("json");
    const result = await createDb(context.env.DB)
      .update(inboxes)
      .set({
        name: input.name,
        disabledAt: input.disabled === undefined ? undefined : input.disabled ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(inboxes.id, context.req.param("id")), eq(inboxes.organizationId, tenant.organizationId)));
    if (!result.meta.changes) throw new HttpError(404, "inbox_not_found", "Inbox not found.");
    return context.json({ ok: true });
  },
);

organizationRoutes.post("/invitations", requireRole("admin"), validate("json", inviteInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.userId, users.id),
        eq(organizationMemberships.organizationId, tenant.organizationId),
        isNull(organizationMemberships.disabledAt),
      ),
    )
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
  const inviteUrl = `${context.env.APP_URL}/accept-invite?token=${encodeURIComponent(token)}`;
  const [workspace] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, tenant.organizationId))
    .limit(1);
  const workspaceName = workspace?.name ?? "ResolveHQ";
  try {
    await sendSystemMail(context.env, {
      to: input.email,
      subject: `You're invited to ${workspaceName} on ResolveHQ`,
      text: `Join the ${workspaceName} support workspace:\n${inviteUrl}\n\nThis link expires in 7 days.`,
    });
  } catch (error) {
    console.error("Invitation mail failed", error);
  }
  return context.json({ invitation: { id: invitationId, email: input.email, role: input.role, inviteUrl } }, 201);
});

organizationRoutes.patch(
  "/members/:userId",
  requireRole("admin"),
  validate("json", z.object({ role: z.enum(["admin", "agent"]).optional(), disabled: z.boolean().optional() })),
  async (context) => {
    const tenant = context.get("tenant");
    const targetUserId = context.req.param("userId");
    if (targetUserId === tenant.userId)
      throw new HttpError(409, "self_change", "You cannot change your own membership here.");
    const values = context.req.valid("json");
    const target = await createDb(context.env.DB)
      .select({ role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, tenant.organizationId),
          eq(organizationMemberships.userId, targetUserId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!target) throw new HttpError(404, "member_not_found", "Team member not found.");
    if (target.role === "owner")
      throw new HttpError(403, "owner_protected", "The workspace owner cannot be changed or disabled.");
    const result = await createDb(context.env.DB)
      .update(organizationMemberships)
      .set({
        ...(values.role ? { role: values.role } : {}),
        ...(values.disabled !== undefined ? { disabledAt: values.disabled ? new Date() : null } : {}),
      })
      .where(
        and(
          eq(organizationMemberships.organizationId, tenant.organizationId),
          eq(organizationMemberships.userId, targetUserId),
        ),
      );
    if (!result.meta.changes) throw new HttpError(404, "member_not_found", "Team member not found.");
    return context.json({ ok: true });
  },
);
