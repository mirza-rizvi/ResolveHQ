import type { AppBindings } from "resolve-server/types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;

/**
 * Verifies a Cloudflare Turnstile token. Inert when TURNSTILE_SECRET_KEY is unset: returns
 * true immediately without making a network call, so the feature has no effect until an
 * operator configures it.
 */
export async function verifyTurnstile(
  env: Pick<AppBindings, "TURNSTILE_SECRET_KEY">,
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
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
