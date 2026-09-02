import { DevelopmentMailProvider, ResendMailProvider, type OutgoingMailProvider } from "../providers/mail";
import type { AppBindings } from "../types";

export function selectOutgoingProvider(env: AppBindings, organizationId: string | null): OutgoingMailProvider | null {
  if (env.RESEND_API_KEY) return new ResendMailProvider(env.RESEND_API_KEY);
  if (env.DEV_MAIL_MODE === "capture") return new DevelopmentMailProvider(env.DB, organizationId);
  return null;
}

/**
 * Sender address for system mail (password resets, invitations). Falls back to
 * `no-reply@<host of appUrl>`; `appUrl` should come from `resolveAppUrl` so the
 * request origin is used when `APP_URL` is not configured.
 */
export function systemMailFrom(env: AppBindings, appUrl?: string) {
  if (env.SYSTEM_MAIL_FROM) return env.SYSTEM_MAIL_FROM;
  const base = appUrl?.trim() || env.APP_URL?.trim() || "http://localhost";
  return `no-reply@${new URL(base).hostname}`;
}

export async function sendSystemMail(
  env: AppBindings,
  mail: { to: string; subject: string; text: string },
  appUrl?: string,
) {
  const provider = selectOutgoingProvider(env, null);
  if (!provider) throw new Error("No outgoing mail provider is configured.");
  await provider.send({ from: systemMailFrom(env, appUrl), to: mail.to, subject: mail.subject, text: mail.text });
}
