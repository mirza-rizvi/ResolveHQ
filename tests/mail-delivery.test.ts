import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { processOutboundMail } from "../src/server/mail/queue";
import { base64Url } from "../src/server/lib/crypto";
import worker from "../worker";
import type { AppBindings, MailQueueMessage } from "../src/server/types";
import { request, signup } from "./helpers";

async function fixture(name: string) {
  const session = await signup(name);
  const customer = (await (
    await request(
      "/customers",
      { method: "POST", body: JSON.stringify({ name: "Mail customer", email: `${name}@example.test` }) },
      session,
    )
  ).json()) as { customer: { id: string } };
  const response = await request(
    "/tickets",
    {
      method: "POST",
      body: JSON.stringify({ customerId: customer.customer.id, subject: "Files for you", message: "Please review" }),
    },
    session,
  );
  expect(response.status).toBe(201);
  const { ticket } = (await response.json()) as { ticket: { id: string } };
  const job = await env.DB.prepare(
    "SELECT id, message_id AS messageId FROM outbound_mail_jobs WHERE organization_id = ?",
  )
    .bind(session.organizationId)
    .first<{ id: string; messageId: string }>();
  return { session, ticket, job: job! };
}

async function attach(
  f: Awaited<ReturnType<typeof fixture>>,
  content = "Private attachment",
  changes: { organizationId?: string; messageId?: string | null; size?: number } = {},
) {
  const id = `att_${crypto.randomUUID()}`;
  const organizationId = changes.organizationId ?? f.session.organizationId;
  const key = `${organizationId}/${id}/${crypto.randomUUID()}`;
  const bytes = new TextEncoder().encode(content);
  const checksum = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  await env.ATTACHMENTS.put(key, bytes, {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { attachmentId: id },
  });
  await env.DB.prepare(
    "INSERT INTO attachments (id, organization_id, ticket_id, message_id, object_key, filename, content_type, size, checksum, created_at) VALUES (?, ?, ?, ?, ?, 'evidence.txt', 'text/plain', ?, ?, ?)",
  )
    .bind(
      id,
      organizationId,
      f.ticket.id,
      changes.messageId === undefined ? f.job.messageId : changes.messageId,
      key,
      changes.size ?? bytes.length,
      checksum,
      Date.now(),
    )
    .run();
  return { id, key, content };
}

async function deliver(queue: string, body: MailQueueMessage, bindings: AppBindings = env) {
  const message = { body, ack: vi.fn(), retry: vi.fn(), id: crypto.randomUUID(), timestamp: new Date(), attempts: 6 };
  await worker.queue({ queue, messages: [message], ackAll: vi.fn(), retryAll: vi.fn() }, bindings);
  return message;
}

describe("outbound attachment delivery", () => {
  it("sends only authorized linked bytes and freezes the provider payload across retries", async () => {
    const f = await fixture("attachment-payload");
    const file = await attach(f);
    await attach(f, "Unlinked draft", { messageId: null });
    const other = await signup("attachment-other");
    await attach(f, "Foreign tenant", { organizationId: other.organizationId });
    const provider = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValue(Response.json({ id: "resend-delivered" }));
    try {
      const bindings = { ...env, RESEND_API_KEY: "synthetic-test-key" };
      await expect(processOutboundMail(bindings, { jobId: f.job.id })).rejects.toMatchObject({ terminal: false });
      const body = JSON.parse(provider.mock.calls[0][1]!.body as string);
      expect(body.attachments).toEqual([
        { filename: "evidence.txt", content_type: "text/plain", content: btoa(file.content) },
      ]);
      await env.DB.prepare("UPDATE attachments SET filename = 'changed.txt' WHERE id = ?").bind(file.id).run();
      await env.DB.prepare("UPDATE messages SET body_text = 'Changed reply' WHERE id = ?").bind(f.job.messageId).run();
      await env.DB.prepare("UPDATE outbound_mail_jobs SET next_attempt_at = 0 WHERE id = ?").bind(f.job.id).run();
      await processOutboundMail(bindings, { jobId: f.job.id });
      expect(provider.mock.calls[1][1]?.body).toBe(provider.mock.calls[0][1]?.body);
      expect(new Headers(provider.mock.calls[1][1]?.headers).get("idempotency-key")).toBe(
        new Headers(provider.mock.calls[0][1]?.headers).get("idempotency-key"),
      );
      expect(
        await env.DB.prepare("SELECT status FROM outbound_mail_jobs WHERE id = ?").bind(f.job.id).first(),
      ).toMatchObject({ status: "sent" });
    } finally {
      provider.mockRestore();
    }
  });

  it("stops rather than silently sending when a linked object is missing", async () => {
    const f = await fixture("attachment-missing");
    const file = await attach(f);
    await env.ATTACHMENTS.delete(file.key);
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "must-not-send" }));
    try {
      await expect(
        processOutboundMail({ ...env, RESEND_API_KEY: "synthetic-test-key" }, { jobId: f.job.id }),
      ).rejects.toMatchObject({ terminal: true, code: "attachment_missing" });
      expect(provider).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare("SELECT terminal_reason AS reason FROM outbound_mail_jobs WHERE id = ?")
          .bind(f.job.id)
          .first(),
      ).toMatchObject({ reason: "attachment_missing" });
    } finally {
      provider.mockRestore();
    }
  });
});

describe("dead-letter consumption", () => {
  it("records a terminal mail job without calling the provider or enqueueing another dead letter", async () => {
    const f = await fixture("mail-dlq");
    const send = vi.fn();
    const message = await deliver(
      "resolvehq-outbound-mail-dlq",
      { kind: "outbound-mail", jobId: f.job.id },
      { ...env, OUTBOUND_MAIL_DLQ: { send } as unknown as Queue<MailQueueMessage> },
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT status, terminal_reason AS reason FROM outbound_mail_jobs WHERE id = ?")
        .bind(f.job.id)
        .first(),
    ).toEqual({ status: "failed", reason: "queue_exhausted" });
    expect(
      await env.DB.prepare("SELECT delivery_status AS status FROM messages WHERE id = ?").bind(f.job.messageId).first(),
    ).toEqual({ status: "failed" });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM mail_captures WHERE organization_id = ?")
        .bind(f.session.organizationId)
        .first(),
    ).toEqual({ n: 0 });
  });
});
