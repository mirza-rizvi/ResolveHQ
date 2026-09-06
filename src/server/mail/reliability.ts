import type { AppBindings, MailQueueMessage } from "../types";
export const leaseMs = 20 * 60 * 1000;
export const retryWindowMs = 23 * 60 * 60 * 1000;
export const maxAttempts = 6;
export const retryDelay = (attempts: number) => Math.min(3600, 15 * 2 ** Math.min(Math.max(0, attempts - 1), 8));
export class MailFailure extends Error {
  constructor(
    message: string,
    readonly terminal = false,
    readonly code = "delivery_failed",
    readonly delaySeconds = 15,
  ) {
    super(message);
  }
}

/** Reserve before send; an ambiguous enqueue is retried only after the reservation expires. */
export async function dispatchMail(env: AppBindings, kind: "inbound-mail" | "outbound-mail", ids?: string[]) {
  const inbound = kind === "inbound-mail";
  const table = inbound ? "inbound_mail_events" : "outbound_mail_jobs";
  const statuses = inbound ? "('staged','failed')" : "('pending','failed')";
  const now = Date.now();
  const filter = ids?.length ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
  const rows = await env.DB.prepare(
    `UPDATE ${table} SET dispatch_until = ? WHERE id IN (SELECT id FROM ${table} WHERE status IN ${statuses} AND terminal_reason IS NULL AND attempts < 6 AND lease_until <= ? AND dispatch_until <= ? AND next_attempt_at <= ?${filter} ORDER BY next_attempt_at, id LIMIT 20) RETURNING id${inbound ? ", staging_object_key AS objectKey" : ""}`,
  )
    .bind(now + leaseMs, now, now, now, ...(ids ?? []))
    .all<{ id: string; objectKey?: string }>();
  if (!rows.results.length) return;
  const queue = inbound ? env.INBOUND_MAIL_QUEUE : env.OUTBOUND_MAIL_QUEUE;
  const messages = rows.results.map((row) => ({
    body: inbound
      ? ({ kind, eventId: row.id, stagingObjectKey: row.objectKey! } as MailQueueMessage)
      : ({ kind, jobId: row.id } as MailQueueMessage),
  }));
  try {
    await queue.sendBatch(messages);
  } catch {
    console.error({ event: "mail_enqueue_failed", kind });
  }
}
