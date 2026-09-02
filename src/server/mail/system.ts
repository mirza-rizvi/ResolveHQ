import { DevelopmentMailProvider, ResendMailProvider, type OutgoingMailProvider } from "../providers/mail";
import type { AppBindings } from "../types";

export function selectOutgoingProvider(env: AppBindings, organizationId: string | null): OutgoingMailProvider | null {
  if (env.RESEND_API_KEY) return new ResendMailProvider(env.RESEND_API_KEY);
  if (env.DEV_MAIL_MODE === "capture") return new DevelopmentMailProvider(env.DB, organizationId);
  return null;
}

export function systemMailFrom(env: AppBindings) {
  return env.SYSTEM_MAIL_FROM || `no-reply@${new URL(env.APP_URL).hostname}`;
}

export async function sendSystemMail(env: AppBindings, mail: { to: string; subject: string; text: string }) {
  const provider = selectOutgoingProvider(env, null);
  if (!provider) throw new Error("No outgoing mail provider is configured.");
  await provider.send({ from: systemMailFrom(env), to: mail.to, subject: mail.subject, text: mail.text });
}
