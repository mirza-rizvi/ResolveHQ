import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { CloudflareEmailProvider } from "../src/server/providers/mail";
import { selectOutgoingProvider } from "../src/server/mail/system";
import { processOutboundMail } from "../src/server/mail/queue";
import { base64Url } from "../src/server/lib/crypto";
import type { AppBindings } from "../src/server/types";
import { request, signup } from "./helpers";

/** Stand-in for the `send_email` binding; the real one is only available on Workers Paid. */
function binding(result: unknown = { messageId: "cf-default@mail.example" }) {
  return { send: vi.fn().mockResolvedValue(result) };
}

function withBinding(email: { send: unknown }) {
  return { ...env, EMAIL: email } as unknown as AppBindings;
}

async function fixture(name: string) {
  const session = await signup(name);
  const customer = (await (
    await request(
      "/customers",
      { method: "POST", body: JSON.stringify({ name: "Mail customer", email: `${name}@example.test` }) },
      session,
    )
  ).json()) as { customer: { id: string } };
  const created = await request(
    "/tickets",
    {
      method: "POST",
      body: JSON.stringify({ customerId: customer.customer.id, subject: "Native send", message: "Please review" }),
    },
    session,
  );
  expect(created.status).toBe(201);
  const { ticket } = (await created.json()) as { ticket: { id: string } };
  const job = await env.DB.prepare(
    "SELECT id, message_id AS messageId FROM outbound_mail_jobs WHERE organization_id = ?",
  )
    .bind(session.organizationId)
    .first<{ id: string; messageId: string }>();
  return { session, ticket, job: job! };
}

/** Links `size` bytes to the fixture's message so the frozen envelope carries them. */
async function attach(f: Awaited<ReturnType<typeof fixture>>, size: number) {
  const id = `att_${crypto.randomUUID()}`;
  const key = `${f.session.organizationId}/${id}/${crypto.randomUUID()}`;
  const bytes = new Uint8Array(size).fill(65);
  const checksum = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  await env.ATTACHMENTS.put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { attachmentId: id },
  });
  await env.DB.prepare(
    "INSERT INTO attachments (id, organization_id, ticket_id, message_id, object_key, filename, content_type, size, checksum, created_at) VALUES (?, ?, ?, ?, ?, 'oversize.bin', 'application/octet-stream', ?, ?, ?)",
  )
    .bind(id, f.session.organizationId, f.ticket.id, f.job.messageId, key, size, checksum, Date.now())
    .run();
}

function jobRow(id: string) {
  return env.DB.prepare(
    "SELECT status, terminal_reason AS terminalReason, provider_message_id AS providerMessageId, send_attempted_at AS sendAttemptedAt, generation FROM outbound_mail_jobs WHERE id = ?",
  )
    .bind(id)
    .first<{
      status: string;
      terminalReason: string | null;
      providerMessageId: string | null;
      sendAttemptedAt: number | null;
      generation: number;
    }>();
}

describe("cloudflare email provider selection", () => {
  it("prefers the binding over a Resend key and declares itself non-idempotent", () => {
    const provider = selectOutgoingProvider(
      { ...env, EMAIL: binding(), RESEND_API_KEY: "synthetic-test-key" } as unknown as AppBindings,
      "org_selection",
    );
    expect(provider).toBeInstanceOf(CloudflareEmailProvider);
    expect(provider?.providerName).toBe("cloudflare");
    expect(provider?.idempotent).toBe(false);
  });

  it("falls back to Resend when the binding is absent", () => {
    const provider = selectOutgoingProvider(
      { ...env, RESEND_API_KEY: "synthetic-test-key" } as unknown as AppBindings,
      "org_selection",
    );
    expect(provider?.providerName).toBe("resend");
    expect(provider?.idempotent).toBe(true);
  });
});

describe("cloudflare email provider send", () => {
  it("passes threading headers without a Message-ID and wraps the returned id", async () => {
    const email = binding({ messageId: "cf-abc@mail.example" });
    const result = await new CloudflareEmailProvider(email as never).send({
      from: "support@acme.test",
      to: "customer@example.test",
      subject: "[#1] Native send",
      text: "Body",
      html: "<p>Body</p>",
      messageId: "<local@acme.test>",
      references: ["<first@acme.test>", "<second@acme.test>"],
      replyTo: "support+token@acme.test",
    });
    expect(result.providerMessageId).toBe("<cf-abc@mail.example>");
    const sent = email.send.mock.calls[0][0] as {
      headers?: Record<string, string>;
      replyTo?: string;
      to: string;
      from: string;
      subject: string;
      text: string;
      html?: string;
    };
    expect(sent).toMatchObject({
      from: "support@acme.test",
      to: "customer@example.test",
      subject: "[#1] Native send",
      text: "Body",
      html: "<p>Body</p>",
      replyTo: "support+token@acme.test",
    });
    expect(sent.headers).toEqual({
      "In-Reply-To": "<second@acme.test>",
      References: "<first@acme.test> <second@acme.test>",
    });
    expect(sent.headers?.["Message-ID"]).toBeUndefined();
  });

  it("stops an oversized message before the binding is called", async () => {
    const email = binding();
    const content = "A".repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3));
    await expect(
      new CloudflareEmailProvider(email as never).send({
        from: "support@acme.test",
        to: "customer@example.test",
        subject: "Too big",
        text: "Body",
        attachments: [{ filename: "big.bin", contentType: "application/octet-stream", content }],
      }),
    ).rejects.toMatchObject({ terminal: true, code: "attachments_too_large" });
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe("non-idempotent send marker", () => {
  it("marks the attempt, sends once, and stores the normalised provider id", async () => {
    const f = await fixture("cf-send");
    const email = binding({ messageId: "cf-job-1@mail.example" });
    await processOutboundMail(withBinding(email), { jobId: f.job.id });
    expect(email.send).toHaveBeenCalledOnce();
    const row = await jobRow(f.job.id);
    expect(row).toMatchObject({ status: "sent", providerMessageId: "<cf-job-1@mail.example>" });
    expect(row?.sendAttemptedAt).toBeGreaterThan(0);
    expect(
      await env.DB.prepare("SELECT delivery_status AS status FROM messages WHERE id = ?").bind(f.job.messageId).first(),
    ).toEqual({ status: "sent" });
  });

  it("clears the marker when the binding rejects the message outright", async () => {
    const f = await fixture("cf-rejected");
    const email = { send: vi.fn().mockRejectedValue(new Error("sender domain is not verified")) };
    await expect(processOutboundMail(withBinding(email), { jobId: f.job.id })).rejects.toMatchObject({
      terminal: true,
      code: "provider_rejected",
    });
    expect(await jobRow(f.job.id)).toMatchObject({
      status: "failed",
      terminalReason: "provider_rejected",
      sendAttemptedAt: null,
    });
  });

  it("refuses a second attempt when an earlier attempt was never confirmed", async () => {
    const f = await fixture("cf-uncertain");
    // An isolate that dies between the marker and the provider acknowledgement
    // leaves exactly this row: marked, still claimable, never confirmed.
    await env.DB.prepare("UPDATE outbound_mail_jobs SET send_attempted_at = ? WHERE id = ?")
      .bind(Date.now(), f.job.id)
      .run();
    const email = binding();
    await expect(processOutboundMail(withBinding(email), { jobId: f.job.id })).rejects.toMatchObject({
      terminal: true,
      code: "delivery_uncertain",
    });
    expect(email.send).not.toHaveBeenCalled();
    expect(await jobRow(f.job.id)).toMatchObject({ terminalReason: "delivery_uncertain" });
  });

  it("stops an oversized job without recording a send attempt", async () => {
    const f = await fixture("cf-oversize");
    await attach(f, 4 * 1024 * 1024);
    const email = binding();
    await expect(processOutboundMail(withBinding(email), { jobId: f.job.id })).rejects.toMatchObject({
      terminal: true,
      code: "attachments_too_large",
    });
    expect(email.send).not.toHaveBeenCalled();
    // The message provably never left the Worker, so no duplicate risk attaches to it.
    expect(await jobRow(f.job.id)).toMatchObject({
      status: "failed",
      terminalReason: "attachments_too_large",
      sendAttemptedAt: null,
    });
  });

  it("only retries a marked job once an administrator accepts the duplicate risk", async () => {
    const f = await fixture("cf-retry");
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE outbound_mail_jobs SET status = 'failed', terminal_reason = 'delivery_uncertain', send_attempted_at = ?, first_attempt_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(now, now, now, f.job.id)
      .run();
    const listed = (await (await request("/mail-recovery", {}, f.session)).json()) as {
      jobs: Array<{ id: string; requiresDuplicateAck: number }>;
    };
    expect(listed.jobs.find((job) => job.id === f.job.id)?.requiresDuplicateAck).toBe(1);
    const blocked = await request(
      `/mail-recovery/${f.job.id}/retry`,
      { method: "POST", body: JSON.stringify({ kind: "outbound-mail", generation: 0 }) },
      f.session,
    );
    expect(blocked.status).toBe(409);
    const allowed = await request(
      `/mail-recovery/${f.job.id}/retry`,
      {
        method: "POST",
        body: JSON.stringify({ kind: "outbound-mail", generation: 0, acknowledgeDuplicateRisk: true }),
      },
      f.session,
    );
    expect(allowed.status).toBe(200);
    expect(await jobRow(f.job.id)).toMatchObject({
      status: "pending",
      terminalReason: null,
      sendAttemptedAt: null,
      generation: 1,
    });
  });
});
