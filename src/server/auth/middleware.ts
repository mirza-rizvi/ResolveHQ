import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { roleRank, type MemberRole } from "resolve-shared/domain";
import { constantTimeEqual } from "resolve-server/lib/crypto";
import { HttpError } from "resolve-server/http/errors";
import { resolveAppUrl } from "resolve-server/lib/app-url";
import type { HonoEnv } from "resolve-server/types";
import { CSRF_COOKIE, resolveTenant } from "./session";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function assertMutationOrigin(context: Context<HonoEnv>): void {
  if (safeMethods.has(context.req.method)) return;
  const origin = context.req.header("origin");
  if (!origin) throw new HttpError(403, "invalid_origin", "The request origin is not allowed.");
  // A same-site proxy (Vite dev, a tunnel) forwards the browser's origin while
  // the Worker itself may be addressed differently; APP_URL does not always
  // reach local dev runtimes. When the Origin host matches the forwarded Host
  // header, the browser is talking to this site directly, which is the thing
  // cross-site request forgery tries to fake. A forged Host without a
  // victim browser is outside the CSRF threat model.
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  const host = context.req.header("host");
  const matchesProxyHost = Boolean(originHost && host && originHost === host);
  const expectedOrigin = new URL(resolveAppUrl(context.env, context.req.raw)).origin;
  if (origin !== expectedOrigin && !matchesProxyHost)
    throw new HttpError(403, "invalid_origin", "The request origin is not allowed.");
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
