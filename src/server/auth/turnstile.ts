import type { AppBindings } from "resolve-server/types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;

type TurnstileEnv = Pick<AppBindings, "TURNSTILE_SITE_KEY" | "TURNSTILE_SECRET_KEY">;

/**
 * Turnstile is only "on" when both the public site key and the secret key are configured.
 * A half-configured deploy (secret only) would 400 every auth request with no widget on
 * screen to satisfy it; (site key only) would show a challenge the server never checks. Both
 * server-side verification and whatever exposes the site key to the SPA must gate on this.
 */
export function turnstileEnabled(env: TurnstileEnv): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/**
 * Verifies a Cloudflare Turnstile token. Inert unless both TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY are set: returns true immediately without making a network call, so
 * the feature has no effect until an operator configures both.
 */
export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!turnstileEnabled(env) || !secret) return true;
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: controller.signal });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
