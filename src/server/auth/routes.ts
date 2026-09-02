import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { createDb } from "resolve-server/db";
import { inboxes, organizationInvitations, organizationMemberships, organizations, passwordResetTokens, sessions, users } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { validate } from "resolve-server/http/validate";
import { newId } from "resolve-server/lib/id";
import { randomToken, sha256 } from "resolve-server/lib/crypto";
import { sendSystemMail } from "resolve-server/mail/system";
import type { HonoEnv } from "resolve-server/types";
import { hashPassword, verifyPassword } from "./password";
import { clearSessionCookies, createSession, resolveTenant, SESSION_COOKIE } from "./session";
import { assertMutationOrigin, requireAuth } from "./middleware";

const credentials = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});

const signupInput = credentials.extend({
  name: z.string().trim().min(2).max(100),
  organizationName: z.string().trim().min(2).max(100),
  organizationSlug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  supportEmail: z.string().trim().email().max(254).transform((value) => value.toLowerCase()).optional(),
});

export const authRoutes = new Hono<HonoEnv>();

authRoutes.post("/signup", validate("json", signupInput), async (context) => {
  const rate = await context.env.AUTH_RATE_LIMIT.limit({ key: `signup:${context.req.header("cf-connecting-ip") ?? "local"}` });
  if (!rate.success) throw new HttpError(429, "rate_limited", "Too many signup attempts. Try again shortly.");

  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
  const [existingOrg] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, input.organizationSlug)).limit(1);
  if (existingUser || existingOrg) throw new HttpError(409, "account_exists", "That email or workspace URL is already in use.");

  const userId = newId("usr");
  const organizationId = newId("org");
  const now = new Date();
  const insertUser = db.insert(users).values({
    id: userId,
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password, context.env.SESSION_PEPPER),
  });
  const insertOrganization = db.insert(organizations).values({ id: organizationId, name: input.organizationName, slug: input.organizationSlug, supportEmail: input.supportEmail });
  const insertMembership = db.insert(organizationMemberships).values({ organizationId, userId, role: "owner", createdAt: now });
  try {
    if (input.supportEmail) {
      await db.batch([insertUser, insertOrganization, insertMembership, db.insert(inboxes).values({ id: newId("inb"), organizationId, name: "Support", emailAddress: input.supportEmail, provider: "cloudflare_email", isDefault: true })]);
    } else {
      await db.batch([insertUser, insertOrganization, insertMembership]);
    }
  } catch (error) {
    const failure = String(error);
    if (failure.includes("UNIQUE")) {
      if (input.supportEmail && (failure.includes("inboxes") || failure.includes("email_address"))) throw new HttpError(409, "inbox_address_exists", "That inbox address is already in use.");
      throw new HttpError(409, "account_exists", "That email or workspace URL is already in use.");
    }
    throw error;
  }

  const csrfToken = await createSession(context, userId, organizationId);
  return context.json({ user: { id: userId, email: input.email, name: input.name }, organization: { id: organizationId, name: input.organizationName, slug: input.organizationSlug }, role: "owner", csrfToken }, 201);
});

authRoutes.post("/login", validate("json", credentials), async (context) => {
  const ip = context.req.header("cf-connecting-ip") ?? "local";
  const input = context.req.valid("json");
  const rate = await context.env.AUTH_RATE_LIMIT.limit({ key: `login:${ip}:${input.email}` });
  if (!rate.success) throw new HttpError(429, "rate_limited", "Too many sign-in attempts. Try again shortly.");

  const db = createDb(context.env.DB);
  const [result] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      role: organizationMemberships.role,
    })
    .from(users)
    .innerJoin(organizationMemberships, and(eq(organizationMemberships.userId, users.id), isNull(organizationMemberships.disabledAt)))
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(eq(users.email, input.email), isNull(users.disabledAt)))
    .orderBy(asc(organizationMemberships.createdAt))
    .limit(1);

  if (!result || !(await verifyPassword(input.password, result.passwordHash, context.env.SESSION_PEPPER))) {
    throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, result.userId));
  const csrfToken = await createSession(context, result.userId, result.organizationId);
  return context.json({
    user: { id: result.userId, email: result.email, name: result.name },
    organization: { id: result.organizationId, name: result.organizationName, slug: result.organizationSlug },
    role: result.role,
    csrfToken,
  });
});

authRoutes.post("/accept-invitation", validate("json", z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2).max(100).optional(),
  password: z.string().min(12).max(128).optional(),
})), async (context) => {
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const tokenHash = await sha256(`${input.token}.${context.env.SESSION_PEPPER}`);
  const [invitation] = await db.select().from(organizationInvitations).where(and(
    eq(organizationInvitations.tokenHash, tokenHash),
    isNull(organizationInvitations.acceptedAt),
  )).limit(1);
  if (!invitation || invitation.expiresAt <= new Date()) throw new HttpError(404, "invitation_invalid", "This invitation is invalid or has expired.");

  const tenant = await resolveTenant(context);
  if (tenant) {
    assertMutationOrigin(context);
    const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, tenant.userId)).limit(1);
    if (!me || me.email !== invitation.email) throw new HttpError(409, "wrong_account", "This invitation was sent to a different email address. Sign out and try again.");
    const now = new Date();
    await db.batch([
      db.insert(organizationMemberships).values({ organizationId: invitation.organizationId, userId: tenant.userId, role: invitation.role, createdAt: now })
        .onConflictDoUpdate({ target: [organizationMemberships.organizationId, organizationMemberships.userId], set: { role: invitation.role, disabledAt: null } }),
      db.update(organizationInvitations).set({ acceptedAt: now }).where(eq(organizationInvitations.id, invitation.id)),
    ]);
    const token = getCookie(context, SESSION_COOKIE)!;
    await db.update(sessions).set({ organizationId: invitation.organizationId, lastSeenAt: now }).where(and(eq(sessions.tokenHash, await sha256(`${token}.${context.env.SESSION_PEPPER}`)), eq(sessions.userId, tenant.userId)));
    return context.json({ ok: true, organizationId: invitation.organizationId, role: invitation.role });
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)).limit(1);
  if (existing) throw new HttpError(409, "account_exists", "Sign in before accepting this invitation.");
  if (!input.name || !input.password) throw new HttpError(400, "validation_error", "name and password are required to create your account.");
  const userId = newId("usr");
  const now = new Date();
  await db.batch([
    db.insert(users).values({ id: userId, email: invitation.email, name: input.name, passwordHash: await hashPassword(input.password, context.env.SESSION_PEPPER) }),
    db.insert(organizationMemberships).values({ organizationId: invitation.organizationId, userId, role: invitation.role, createdAt: now }),
    db.update(organizationInvitations).set({ acceptedAt: now }).where(eq(organizationInvitations.id, invitation.id)),
  ]);
  const csrfToken = await createSession(context, userId, invitation.organizationId);
  return context.json({ user: { id: userId, email: invitation.email, name: input.name }, organizationId: invitation.organizationId, role: invitation.role, csrfToken }, 201);
});

authRoutes.post("/forgot-password", validate("json", z.object({ email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()) })), async (context) => {
  const ip = context.req.header("cf-connecting-ip") ?? "local";
  const { email } = context.req.valid("json");
  const [byIp, byEmail] = await Promise.all([context.env.AUTH_RATE_LIMIT.limit({ key: `forgot:ip:${ip}` }), context.env.AUTH_RATE_LIMIT.limit({ key: `forgot:email:${email}` })]);
  if (!byIp.success || !byEmail.success) throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.");
  const db = createDb(context.env.DB);
  const [user] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.email, email), isNull(users.disabledAt))).limit(1);
  if (user) {
    const work = (async () => {
      try {
        const token = randomToken();
        await db.insert(passwordResetTokens).values({ id: newId("prt"), userId: user.id, tokenHash: await sha256(`${token}.${context.env.SESSION_PEPPER}`), expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
        await sendSystemMail(context.env, { to: email, subject: "Reset your ResolveHQ password", text: `Hi ${user.name},\n\nReset your password within 30 minutes:\n${context.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}\n\nIf you did not request this, ignore this email.` });
      } catch (error) {
        console.error("Password reset work failed", error);
      }
    })();
    try {
      context.executionCtx.waitUntil(work);
    } catch {
      // Direct app.request() tests do not provide a Workers ExecutionContext.
      await work;
    }
  }
  return context.json({ ok: true });
});

authRoutes.post("/reset-password", validate("json", z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(128) })), async (context) => {
  const ip = context.req.header("cf-connecting-ip") ?? "local";
  if (!(await context.env.AUTH_RATE_LIMIT.limit({ key: `reset:${ip}` })).success) throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const tokenHash = await sha256(`${input.token}.${context.env.SESSION_PEPPER}`);
  const [row] = await db.select().from(passwordResetTokens).where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt))).limit(1);
  if (!row || row.expiresAt <= new Date()) throw new HttpError(404, "reset_invalid", "This reset link is invalid or has expired.");
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(input.password, context.env.SESSION_PEPPER), updatedAt: new Date() }).where(eq(users.id, row.userId)),
    db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id)),
    db.delete(sessions).where(eq(sessions.userId, row.userId)),
  ]);
  return context.json({ ok: true });
});

authRoutes.post("/change-password", requireAuth, validate("json", z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) })), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, tenant.userId)).limit(1);
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash, context.env.SESSION_PEPPER))) throw new HttpError(401, "invalid_credentials", "Your current password is incorrect.");
  const token = getCookie(context, SESSION_COOKIE) ?? "";
  const currentHash = await sha256(`${token}.${context.env.SESSION_PEPPER}`);
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(input.newPassword, context.env.SESSION_PEPPER), updatedAt: new Date() }).where(eq(users.id, tenant.userId)),
    db.delete(sessions).where(and(eq(sessions.userId, tenant.userId), ne(sessions.tokenHash, currentHash))),
  ]);
  return context.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [result] = await db
    .select({ userId: users.id, email: users.email, name: users.name, organizationName: organizations.name, organizationSlug: organizations.slug })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, tenant.organizationId))
    .where(eq(users.id, tenant.userId))
    .limit(1);
  if (!result) throw new HttpError(401, "unauthenticated", "Sign in to continue.");
  const workspaceRows = await db.select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: organizationMemberships.role }).from(organizationMemberships).innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId)).where(and(eq(organizationMemberships.userId, tenant.userId), isNull(organizationMemberships.disabledAt)));
  return context.json({
    user: { id: result.userId, email: result.email, name: result.name },
    organization: { id: tenant.organizationId, name: result.organizationName, slug: result.organizationSlug },
    role: tenant.role,
    csrfToken: tenant.csrfToken,
    workspaces: workspaceRows,
  });
});

authRoutes.post("/switch-workspace", requireAuth, validate("json", z.object({ organizationId: z.string().min(1) })), async (context) => {
  const tenant = context.get("tenant");
  const organizationId = context.req.valid("json").organizationId;
  const membership = await createDb(context.env.DB).select({ id: organizations.id }).from(organizationMemberships).innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId)).where(and(eq(organizationMemberships.userId, tenant.userId), eq(organizationMemberships.organizationId, organizationId), isNull(organizationMemberships.disabledAt))).limit(1).then((rows) => rows[0]);
  if (!membership) throw new HttpError(404, "workspace_not_found", "Workspace not found.");
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "unauthenticated", "Sign in to continue.");
  const tokenHash = await sha256(`${token}.${context.env.SESSION_PEPPER}`);
  await createDb(context.env.DB).update(sessions).set({ organizationId, lastSeenAt: new Date() }).where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, tenant.userId)));
  return context.json({ ok: true, organizationId });
});

authRoutes.get("/sessions", requireAuth, async (context) => {
  const tenant = context.get("tenant");
  const token = getCookie(context, SESSION_COOKIE);
  const currentHash = token ? await sha256(`${token}.${context.env.SESSION_PEPPER}`) : "";
  const rows = await createDb(context.env.DB).select({ id: sessions.id, userAgent: sessions.userAgent, lastSeenAt: sessions.lastSeenAt, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt, tokenHash: sessions.tokenHash }).from(sessions).where(eq(sessions.userId, tenant.userId));
  return context.json({ sessions: rows.map(({ tokenHash, ...session }) => ({ ...session, current: tokenHash === currentHash })) });
});

authRoutes.delete("/sessions/:id", requireAuth, async (context) => {
  const tenant = context.get("tenant");
  const result = await createDb(context.env.DB).delete(sessions).where(and(eq(sessions.id, context.req.param("id")), eq(sessions.userId, tenant.userId)));
  if (!result.meta.changes) throw new HttpError(404, "session_not_found", "Session not found.");
  return context.body(null, 204);
});

authRoutes.post("/logout", requireAuth, async (context) => {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256(`${token}.${context.env.SESSION_PEPPER}`);
    await createDb(context.env.DB).delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }
  clearSessionCookies(context);
  deleteCookie(context, SESSION_COOKIE);
  return context.body(null, 204);
});
