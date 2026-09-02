import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { roleRank, type MemberRole } from "resolve-shared/domain";
import { constantTimeEqual } from "resolve-server/lib/crypto";
import { HttpError } from "resolve-server/http/errors";
import type { HonoEnv } from "resolve-server/types";
import { CSRF_COOKIE, resolveTenant } from "./session";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function assertMutationOrigin(context: Context<HonoEnv>): void {
  if (safeMethods.has(context.req.method)) return;
  const expectedOrigin = new URL(context.env.APP_URL).origin;
  const origin = context.req.header("origin");
  if (!origin || origin !== expectedOrigin) throw new HttpError(403, "invalid_origin", "The request origin is not allowed.");
  const cookieToken = getCookie(context, CSRF_COOKIE) ?? "";
  const headerToken = context.req.header("x-csrf-token") ?? "";
  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    throw new HttpError(403, "invalid_csrf", "Refresh the page and try again.");
  }
}

export const requireAuth: MiddlewareHandler<HonoEnv> = async (context, next) => {
  const tenant = await resolveTenant(context);
  if (!tenant) throw new HttpError(401, "unauthenticated", "Sign in to continue.");

  assertMutationOrigin(context);

  context.set("tenant", tenant);
  await next();
};

export function requireRole(minimum: MemberRole): MiddlewareHandler<HonoEnv> {
  return async (context, next) => {
    const tenant = context.get("tenant");
    if (!tenant || roleRank[tenant.role] < roleRank[minimum]) {
      throw new HttpError(403, "forbidden", "Your role does not allow this action.");
    }
    await next();
  };
}
