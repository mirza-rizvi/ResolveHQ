import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { validate } from "../http/validate";
import { HttpError } from "../http/errors";
import type { HonoEnv } from "../types";
import { dispatchMail } from "./reliability";

export const mailRecoveryRoutes = new Hono<HonoEnv>();
mailRecoveryRoutes.use("*", requireAuth, requireRole("admin"));
mailRecoveryRoutes.get("/", async (context) => {
  const rows = await context.env.DB.prepare(
    `
    SELECT j.id, 'outbound-mail' AS kind, j.terminal_reason AS reason, j.generation, j.updated_at AS updatedAt,
      j.first_attempt_at AS firstAttemptAt, (j.first_attempt_at IS NOT NULL OR j.terminal_reason = 'delivery_uncertain') AS requiresDuplicateAck,
      t.id AS ticketId, t.number AS ticketNumber, t.subject
    FROM outbound_mail_jobs j LEFT JOIN messages m ON m.id = j.message_id AND m.organization_id = j.organization_id
    LEFT JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = j.organization_id
    WHERE j.organization_id = ? AND j.status = 'failed' AND j.terminal_reason IS NOT NULL
    UNION ALL
    SELECT j.id, 'inbound-mail' AS kind, j.terminal_reason AS reason, j.generation, j.updated_at AS updatedAt,
      NULL AS firstAttemptAt, 0 AS requiresDuplicateAck, t.id AS ticketId, t.number AS ticketNumber, t.subject
    FROM inbound_mail_events j LEFT JOIN messages m ON m.id = j.message_id AND m.organization_id = j.organization_id
    LEFT JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = j.organization_id
    WHERE j.organization_id = ? AND j.status = 'failed' AND j.terminal_reason IS NOT NULL
    ORDER BY updatedAt DESC LIMIT 50`,
  )
    .bind(context.get("tenant").organizationId, context.get("tenant").organizationId)
    .all();
  return context.json({ jobs: rows.results });
});
mailRecoveryRoutes.post(
  "/:id/retry",
  validate(
    "json",
    z.object({
      kind: z.enum(["inbound-mail", "outbound-mail"]),
      generation: z.number().int().nonnegative(),
      acknowledgeDuplicateRisk: z.boolean().default(false),
    }),
  ),
  async (context) => {
    const tenant = context.get("tenant"),
      input = context.req.valid("json");
    if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `mail-recovery:${tenant.userId}` })).success)
      throw new HttpError(429, "rate_limited", "Try again in a minute.");
    const inbound = input.kind === "inbound-mail";
    const table = inbound ? "inbound_mail_events" : "outbound_mail_jobs";
    const row = await context.env.DB.prepare(
      `SELECT id, terminal_reason AS reason, generation, ${inbound ? "staging_object_key AS objectKey" : "first_attempt_at AS firstAttemptAt"} FROM ${table} WHERE id = ? AND organization_id = ? AND status = 'failed' AND terminal_reason IS NOT NULL`,
    )
      .bind(context.req.param("id"), tenant.organizationId)
      .first<{ id: string; reason: string; generation: number; objectKey?: string; firstAttemptAt?: number }>();
    if (!row) throw new HttpError(404, "job_not_found", "Stopped mail job not found.");
    if (row.reason === "email.complained")
      throw new HttpError(409, "complaint_blocked", "A spam complaint prevents resending this message.");
    if (
      !inbound &&
      (row.firstAttemptAt != null || row.reason === "delivery_uncertain") &&
      !input.acknowledgeDuplicateRisk
    )
      throw new HttpError(
        409,
        "duplicate_risk",
        "The earlier message may have arrived. Acknowledge the duplicate risk to resend.",
      );
    if (
      inbound &&
      (!row.objectKey?.startsWith("_mail-staging/") || !(await context.env.ATTACHMENTS.head(row.objectKey)))
    )
      throw new HttpError(
        409,
        "payload_expired",
        "The original email is no longer available. Ask the sender to resend it.",
      );
    const changed = await context.env.DB.prepare(
      `UPDATE ${table} SET status = '${inbound ? "staged" : "pending"}', terminal_reason = NULL, last_error = NULL, attempts = 0, dispatch_until = 0, next_attempt_at = 0, generation = generation + 1, updated_at = ?${inbound ? "" : ", first_attempt_at = NULL, envelope = NULL, idempotency_key = 'message/' || message_id || '/retry/' || (generation + 1)"} WHERE id = ? AND organization_id = ? AND generation = ? AND status = 'failed' AND lease_until <= ? AND terminal_reason = ? RETURNING id`,
    )
      .bind(Date.now(), row.id, tenant.organizationId, input.generation, Date.now(), row.reason)
      .first();
    if (!changed)
      throw new HttpError(409, "retry_conflict", "This job changed or is still processing. Refresh before retrying.");
    await context.env.DB.prepare(
      "INSERT INTO activity_logs (id, organization_id, actor_user_id, event_type, entity_type, entity_id, metadata, request_id, created_at) VALUES (?, ?, ?, 'mail.retry_requested', 'mail_job', ?, ?, ?, ?)",
    )
      .bind(
        `act_${crypto.randomUUID()}`,
        tenant.organizationId,
        tenant.userId,
        row.id,
        JSON.stringify({ generation: input.generation + 1, acknowledgeDuplicateRisk: input.acknowledgeDuplicateRisk }),
        tenant.requestId,
        Date.now(),
      )
      .run();
    await dispatchMail(context.env, input.kind, [row.id]);
    return context.json({ ok: true });
  },
);
