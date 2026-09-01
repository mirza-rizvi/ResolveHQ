import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { createDb } from "resolve-server/db";
import { organizationInvitations, organizationMemberships, organizations, sessions, users } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { newId } from "resolve-server/lib/id";
import { sha256 } from "resolve-server/lib/crypto";
import type { HonoEnv } from "resolve-server/types";
import { hashPassword, verifyPassword } from "./password";
import { clearSessionCookies, createSession, SESSION_COOKIE } from "./session";
import { requireAuth } from "./middleware";

const credentials = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});

const signupInput = credentials.extend({
  name: z.string().trim().min(2).max(100),
  organizationName: z.string().trim().min(2).max(100),
  organizationSlug: z.string().trim().min(2).max(48).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const authRoutes = new Hono<HonoEnv>();

authRoutes.post("/signup", zValidator("json", signupInput), async (context) => {
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
  await db.batch([
    db.insert(users).values({
      id: userId,
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password, context.env.SESSION_PEPPER),
    }),
    db.insert(organizations).values({ id: organizationId, name: input.organizationName, slug: input.organizationSlug }),
    db.insert(organizationMemberships).values({ organizationId, userId, role: "owner", createdAt: now }),
  ]);

  const csrfToken = await createSession(context, userId, organizationId);
  return context.json({ user: { id: userId, email: input.email, name: input.name }, organization: { id: organizationId, name: input.organizationName, slug: input.organizationSlug }, role: "owner", csrfToken }, 201);
});

authRoutes.post("/login", zValidator("json", credentials), async (context) => {
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

authRoutes.post("/accept-invitation", zValidator("json", z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(12).max(128),
})), async (context) => {
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const tokenHash = await sha256(`${input.token}.${context.env.SESSION_PEPPER}`);
  const [invitation] = await db.select().from(organizationInvitations).where(and(
    eq(organizationInvitations.tokenHash, tokenHash),
    isNull(organizationInvitations.acceptedAt),
  )).limit(1);
  if (!invitation || invitation.expiresAt <= new Date()) throw new HttpError(404, "invitation_invalid", "This invitation is invalid or has expired.");
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, invitation.email)).limit(1);
  if (existing) throw new HttpError(409, "account_exists", "Sign in before accepting this invitation.");
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
  return context.json({
    user: { id: result.userId, email: result.email, name: result.name },
    organization: { id: tenant.organizationId, name: result.organizationName, slug: result.organizationSlug },
    role: tenant.role,
    csrfToken: tenant.csrfToken,
  });
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
