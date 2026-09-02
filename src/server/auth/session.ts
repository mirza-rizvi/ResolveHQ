import { and, eq, gt, isNull } from "drizzle-orm";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { createDb } from "resolve-server/db";
import { organizationMemberships, organizations, sessions, users } from "resolve-server/db/schema";
import { resolveAppUrl } from "resolve-server/lib/app-url";
import { randomToken, sha256 } from "resolve-server/lib/crypto";
import { newId } from "resolve-server/lib/id";
import type { HonoEnv, Role, TenantContext } from "resolve-server/types";

export const SESSION_COOKIE = "resolvehq_session";
export const CSRF_COOKIE = "resolvehq_csrf";
const sessionDurationSeconds = 60 * 60 * 24 * 14;

export async function createSession(context: Context<HonoEnv>, userId: string, organizationId: string) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionDurationSeconds * 1000);
  const db = createDb(context.env.DB);
  await db.insert(sessions).values({
    id: newId("ses"),
    userId,
    organizationId,
    tokenHash: await sha256(`${token}.${context.env.SESSION_PEPPER}`),
    csrfTokenHash: await sha256(`${csrfToken}.${context.env.SESSION_PEPPER}`),
    userAgent: context.req.header("user-agent")?.slice(0, 512),
    ipHash: await sha256(`${context.req.header("cf-connecting-ip") ?? "local"}.${context.env.SESSION_PEPPER}`),
    expiresAt,
    lastSeenAt: now,
  });

  const secure = resolveAppUrl(context.env, context.req.raw).startsWith("https://");
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: sessionDurationSeconds,
  });
  setCookie(context, CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: sessionDurationSeconds,
  });
  return csrfToken;
}

export async function resolveTenant(context: Context<HonoEnv>): Promise<TenantContext | null> {
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(`${token}.${context.env.SESSION_PEPPER}`);
  const now = new Date();
  const db = createDb(context.env.DB);
  const [result] = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      csrfTokenHash: sessions.csrfTokenHash,
      userId: users.id,
      organizationId: organizations.id,
      role: organizationMemberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.userId, sessions.userId),
        eq(organizationMemberships.organizationId, sessions.organizationId),
      ),
    )
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
        isNull(organizationMemberships.disabledAt),
      ),
    )
    .limit(1);
  if (!result) return null;

  const csrfToken = getCookie(context, CSRF_COOKIE) ?? "";
  if (!csrfToken || (await sha256(`${csrfToken}.${context.env.SESSION_PEPPER}`)) !== result.csrfTokenHash) return null;

  if (now.getTime() - result.lastSeenAt.getTime() >= 60 * 60 * 1000) {
    const touchSession = db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, result.sessionId));
    try {
      context.executionCtx.waitUntil(touchSession);
    } catch {
      // Direct app.request() tests do not provide a Workers ExecutionContext.
      await touchSession;
    }
  }
  return {
    requestId: context.req.header("cf-ray") ?? crypto.randomUUID(),
    userId: result.userId,
    organizationId: result.organizationId,
    role: result.role as Role,
    csrfToken,
  };
}

export function clearSessionCookies(context: Context<HonoEnv>) {
  const secure = resolveAppUrl(context.env, context.req.raw).startsWith("https://");
  setCookie(context, SESSION_COOKIE, "", { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: 0 });
  setCookie(context, CSRF_COOKIE, "", { httpOnly: false, secure, sameSite: "Lax", path: "/", maxAge: 0 });
}
