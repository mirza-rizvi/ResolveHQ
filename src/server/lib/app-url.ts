import type { AppBindings } from "../types";

/**
 * The public origin of this deployment. `APP_URL` is optional: when it is not
 * configured (the one-click Cloudflare deploy flow does not know the final URL
 * ahead of time) the origin of the incoming request is used instead.
 */
export function resolveAppUrl(env: Pick<AppBindings, "APP_URL">, request: Request): string {
  const configured = env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}
