import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/server/app";
import { hashPassword, verifyPassword, type AuthTiming } from "../src/server/auth/password";
import { dispatchMail, leaseMs, retryDelay } from "../src/server/mail/reliability";
import { processOutboundMail, processInboundMail } from "../src/server/mail/queue";
import { discoverCleanup, processMaintenance, requestCustomerRefresh } from "../src/server/maintenance/service";
import { runScheduled } from "../src/server/maintenance/scheduled";
import { request, signup } from "./helpers";

async function fixture(name: string) {
  const session = await signup(name);
  const customer = (await (
    await request(
      "/customers",
      { method: "POST", body: JSON.stringify({ name: "Customer", email: `${name}@example.test` }) },
      session,
    )
  ).json()) as { customer: { id: string } };
  const response = await request(
    "/tickets",
    {
      method: "POST",
      body: JSON.stringify({ customerId: customer.customer.id, subject: "Reliability", message: "Hello" }),
    },
    session,
  );
  expect(response.status).toBe(201);
  const { ticket } = (await response.json()) as { ticket: { id: string } };
  return { session, ticket, customer: customer.customer };
}

describe("Free-plan reliability", () => {
  it("rejects malformed hashes before expensive derivation and keeps timing records anonymous", async () => {
    const timings: AuthTiming[] = [];
    const hash = await hashPassword("synthetic password", env.SESSION_PEPPER, timings);
    expect(hash.startsWith("pbkdf2-sha256$310000$")).toBe(true);
    expect(await verifyPassword("synthetic password", hash, env.SESSION_PEPPER, timings)).toBe(true);
    for (const invalid of [
      "",
      hash + "$extra",
      hash.replace("310000", "99999"),
      hash.replace("310000", "NaN"),
      hash.slice(0, -1),
    ]) {
      expect(await verifyPassword("synthetic password", invalid, env.SESSION_PEPPER)).toBe(false);
    }
    expect(timings.map((row) => row.operation)).toEqual(["hash", "verify"]);
    expect(Object.keys(timings[0]).sort()).toEqual(["elapsedMs", "operation"]);
    expect(await verifyPassword("synthetic password", hash, "different pepper")).toBe(false);
  });

  it("samples both auth route prefixes without logging input or URL fragments", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const prefix of ["/api/auth", "/api/v1/auth"]) {
        await app.request(
          `http://localhost:8787${prefix}/sensitive-url-fragment?token=secret`,
          {},
          { ...env, AUTH_TIMING_SAMPLE_RATE: "1" },
        );
      }
      expect(log).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/sensitive-url-fragment|secret|token=/);
      expect(log.mock.calls[0][0]).toMatchObject({
        event: "auth_timing",
        operation: "other",
        clock: "elapsed_not_cpu",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("reserves dispatch once, acknowledges duplicate processing without sending twice, and bounds backoff", async () => {
    const { session } = await fixture("free-idempotency");
    const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE organization_id = ?")
      .bind(session.organizationId)
      .first<{ id: string }>();
    const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
    await env.DB.prepare("UPDATE outbound_mail_jobs SET dispatch_until = 0 WHERE id = ?").bind(job!.id).run();
    const bindings = { ...env, OUTBOUND_MAIL_QUEUE: queue as unknown as typeof env.OUTBOUND_MAIL_QUEUE };
    await dispatchMail(bindings, "outbound-mail", [job!.id]);
    await dispatchMail(bindings, "outbound-mail", [job!.id]);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    await processOutboundMail(env, { jobId: job!.id });
    await processOutboundMail(env, { jobId: job!.id });
    const count = await env.DB.prepare("SELECT count(*) AS n FROM mail_captures WHERE organization_id = ?")
      .bind(session.organizationId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect(retryDelay(1)).toBe(15);
    expect(retryDelay(100)).toBe(3600);
  });

  it("requires admin ownership, acknowledgment and generation matching for uncertain retries", async () => {
    const { session } = await fixture("free-recovery");
    const outsider = await signup("free-outsider");
    const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE organization_id = ?")
      .bind(session.organizationId)
      .first<{ id: string }>();
    await env.DB.prepare(
      "UPDATE outbound_mail_jobs SET status = 'failed', terminal_reason = 'delivery_uncertain', first_attempt_at = ?, dispatch_until = 0 WHERE id = ?",
    )
      .bind(Date.now() - 86400000, job!.id)
      .run();
    const visible = (await (await request("/mail-recovery", {}, session)).json()) as {
      jobs: Array<{ id: string; requiresDuplicateAck: number }>;
    };
    expect(visible.jobs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: job!.id, requiresDuplicateAck: 1 })]),
    );
    const hidden = (await (await request("/mail-recovery", {}, outsider)).json()) as { jobs: unknown[] };
    expect(hidden.jobs).toEqual([]);
    const path = `/mail-recovery/${job!.id}/retry`;
    const body = { kind: "outbound-mail", generation: 0, acknowledgeDuplicateRisk: false };
    expect((await request(path, { method: "POST", body: JSON.stringify(body) }, outsider)).status).toBe(404);
    expect((await request(path, { method: "POST", body: JSON.stringify(body) }, session)).status).toBe(409);
    body.acknowledgeDuplicateRisk = true;
    expect((await request(path, { method: "POST", body: JSON.stringify(body) }, session)).status).toBe(200);
    expect((await request(path, { method: "POST", body: JSON.stringify(body) }, session)).status).not.toBe(200);
    await env.DB.prepare(
      "UPDATE outbound_mail_jobs SET status = 'failed', terminal_reason = 'email.complained' WHERE id = ?",
    )
      .bind(job!.id)
      .run();
    expect(
      (await request(path, { method: "POST", body: JSON.stringify({ ...body, generation: 1 }) }, session)).status,
    ).toBe(409);
  });

  it("bounds cleanup to five objects and keeps scheduled SQL below the Free request query ceiling", async () => {
    const { session, ticket } = await fixture("free-cleanup");
    for (let i = 0; i < 7; i++)
      await env.DB.prepare(
        "INSERT INTO attachments (id, organization_id, ticket_id, object_key, filename, content_type, size, checksum, created_at) VALUES (?, ?, ?, ?, 'old.txt', 'text/plain', 1, 'sum', 0)",
      )
        .bind(`free-cleanup-${i}`, session.organizationId, ticket.id, `free-cleanup/${i}`)
        .run();
    await discoverCleanup(env);
    await processMaintenance(env, "cleanup/attachments");
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM attachments WHERE organization_id = ?")
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    await processMaintenance(env, "cleanup/attachments");
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM attachments WHERE organization_id = ?")
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    const spy = vi.spyOn(env.DB, "prepare");
    try {
      await runScheduled(env);
      expect(spy.mock.calls.length).toBeLessThan(40);
    } finally {
      spy.mockRestore();
    }
  });

  it("bounds the SLA promotion sweeps and never promotes a snoozed or answered ticket", async () => {
    const { session } = await fixture("free-sla");
    const now = Date.now();
    const due = now - 60_000;
    // Twenty-five breach candidates: the sweep must move at most twenty per run.
    for (let i = 0; i < 25; i++)
      await env.DB.prepare(
        "INSERT INTO tickets (id, organization_id, number, customer_id, subject, status, priority, sla_state, first_response_due_at, created_at, updated_at) SELECT ?, ?, ?, customer_id, 'Late', 'open', 'normal', 'ok', ?, ?, ? FROM tickets WHERE organization_id = ? LIMIT 1",
      )
        .bind(`free-sla-${i}`, session.organizationId, 9000 + i, due, now - 7_200_000, now, session.organizationId)
        .run();
    // One snoozed and one already answered; neither may ever be promoted.
    await env.DB.prepare(
      "INSERT INTO tickets (id, organization_id, number, customer_id, subject, status, priority, sla_state, first_response_due_at, snoozed_until, created_at, updated_at) SELECT 'free-sla-snoozed', ?, 9100, customer_id, 'Snoozed', 'open', 'normal', 'ok', ?, ?, ?, ? FROM tickets WHERE organization_id = ? LIMIT 1",
    )
      .bind(session.organizationId, due, now + 3_600_000, now - 7_200_000, now, session.organizationId)
      .run();
    await env.DB.prepare(
      "INSERT INTO tickets (id, organization_id, number, customer_id, subject, status, priority, sla_state, first_response_due_at, first_response_at, created_at, updated_at) SELECT 'free-sla-answered', ?, 9101, customer_id, 'Answered', 'open', 'normal', 'ok', ?, ?, ?, ? FROM tickets WHERE organization_id = ? LIMIT 1",
    )
      .bind(session.organizationId, due, now - 30_000, now - 7_200_000, now, session.organizationId)
      .run();

    const breachedCount = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM tickets WHERE organization_id = ? AND sla_state = 'breached'",
        )
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n ?? 0;

    await runScheduled(env);
    expect(await breachedCount()).toBe(20);
    await runScheduled(env);
    expect(await breachedCount()).toBe(25);

    const untouched = await env.DB.prepare(
      "SELECT id, sla_state AS slaState FROM tickets WHERE id IN ('free-sla-snoozed','free-sla-answered')",
    ).all<{ id: string; slaState: string }>();
    expect(untouched.results.every((row) => row.slaState === "ok")).toBe(true);
  });

  it("bounds the snooze wake sweep to twenty tickets per run", async () => {
    const { session } = await fixture("free-snooze");
    const now = Date.now();
    for (let i = 0; i < 25; i++)
      await env.DB.prepare(
        "INSERT INTO tickets (id, organization_id, number, customer_id, subject, status, priority, snoozed_until, snooze_started_at, created_at, updated_at) SELECT ?, ?, ?, customer_id, 'Snoozed', 'open', 'normal', ?, ?, ?, ? FROM tickets WHERE organization_id = ? LIMIT 1",
      )
        .bind(
          `free-snooze-${i}`,
          session.organizationId,
          9200 + i,
          now - 60_000,
          now - 3_600_000,
          now - 7_200_000,
          now,
          session.organizationId,
        )
        .run();

    const stillSnoozed = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM tickets WHERE organization_id = ? AND snoozed_until IS NOT NULL",
        )
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n ?? 0;

    await runScheduled(env);
    expect(await stillSnoozed()).toBe(5);
    await runScheduled(env);
    expect(await stillSnoozed()).toBe(0);
  });

  it("bounds the webhook retry sweep and uses no queue for outbound webhooks", async () => {
    const { session } = await fixture("free-webhooks");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO webhook_endpoints (id, organization_id, kind, url, secret, config, events, enabled, failure_count, created_at, updated_at) VALUES ('whe_free', ?, 'generic', 'https://hooks.example.com/incoming', 'whsec_free', '{}', '[\"ticket.created\"]', 1, 0, ?, ?)",
    )
      .bind(session.organizationId, now, now)
      .run();
    for (let i = 0; i < 25; i++)
      await env.DB.prepare(
        "INSERT INTO webhook_deliveries (id, organization_id, endpoint_id, event, payload, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'whe_free', 'ticket.created', '{\"event\":\"ticket.created\",\"data\":{}}', 'pending', 0, ?, ?, ?)",
      )
        .bind(`whd_free_${i}`, session.organizationId, now - 60_000, now, now)
        .run();

    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      // The queue producers must stay untouched: webhooks deliberately spend no Queue
      // operations, which are capped at 10,000 a day and shared with mail.
      const inbound = vi.spyOn(env.INBOUND_MAIL_QUEUE, "send");
      const outbound = vi.spyOn(env.OUTBOUND_MAIL_QUEUE, "send");
      try {
        await runScheduled(env);
        expect(sends).toBe(20);
        expect(inbound).not.toHaveBeenCalled();
        expect(outbound).not.toHaveBeenCalled();
      } finally {
        inbound.mockRestore();
        outbound.mockRestore();
      }
      await runScheduled(env);
      expect(sends).toBe(25);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads the newest message page and walks older messages without overlap at equal timestamps", async () => {
    const { session, ticket } = await fixture("free-pages");
    for (let i = 0; i < 60; i++)
      await env.DB.prepare(
        "INSERT INTO messages (id, organization_id, ticket_id, author_type, kind, body_text, delivery_status, created_at) VALUES (?, ?, ?, 'customer', 'message', 'hello', 'received', 1)",
      )
        .bind(`free-page-${String(i).padStart(3, "0")}`, session.organizationId, ticket.id)
        .run();
    type Page = { messages: Array<{ id: string }>; nextMessageCursor?: string };
    const first = (await (await request(`/tickets/${ticket.id}?messageWindow=latest`, {}, session)).json()) as Page;
    expect(first.messages).toHaveLength(50);
    expect(first.nextMessageCursor).toBeTruthy();
    const older = (await (
      await request(
        `/tickets/${ticket.id}?messageWindow=latest&messageCursor=${encodeURIComponent(first.nextMessageCursor!)}`,
        {},
        session,
      )
    ).json()) as Page;
    expect(new Set([...first.messages, ...older.messages].map((row) => row.id)).size).toBe(61);
    expect(older.nextMessageCursor).toBeNull();
    const legacy = (await (await request(`/tickets/${ticket.id}`, {}, session)).json()) as Page;
    expect(legacy.nextMessageCursor).toBeUndefined();
  });

  it("chunks customer search refreshes and does not lose edits while a task is leased", async () => {
    const { session, customer, ticket } = await fixture("free-search");
    await requestCustomerRefresh(env, session.organizationId, customer.id);
    const taskId = `search/${session.organizationId}/${customer.id}`;
    await env.DB.prepare("UPDATE maintenance_tasks SET lease_until = ? WHERE id = ?")
      .bind(Date.now() + leaseMs, taskId)
      .run();
    await requestCustomerRefresh(env, session.organizationId, customer.id);
    await processMaintenance(env, taskId);
    expect(
      await env.DB.prepare("SELECT generation, status FROM maintenance_tasks WHERE id = ?").bind(taskId).first(),
    ).toMatchObject({ generation: 1, status: "pending" });
    await env.DB.prepare("UPDATE maintenance_tasks SET lease_until = 0 WHERE id = ?").bind(taskId).run();
    await processMaintenance(env, taskId);
    expect(
      (await env.DB.prepare("SELECT status FROM maintenance_tasks WHERE id = ?").bind(taskId).first())?.status,
    ).toBe("completed");
    expect(
      await env.DB.prepare("SELECT row_id FROM ticket_search_rows WHERE ticket_id = ?").bind(ticket.id).first(),
    ).not.toBeNull();
  });

  it("uses the envelope recipient and checkpoints six MIME attachments across two invocations", async () => {
    const session = await signup("free-mime");
    const raw = new TextEncoder().encode(
      [
        "From: Sender <sender@example.test>",
        "To: wrong@example.test",
        "Subject: Six files",
        "Message-ID: <free-six@example.test>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="parts"',
        "",
        "--parts",
        "Content-Type: text/plain",
        "",
        "Hello",
        ...Array.from({ length: 6 }, (_, i) => [
          "--parts",
          `Content-Type: text/plain; name="${i}.txt"`,
          `Content-Disposition: attachment; filename="${i}.txt"`,
          "",
          "hello",
        ]).flat(),
        "--parts--",
        "",
      ].join("\r\n"),
    );
    const eventId = "free-mime-event",
      key = "_mail-staging/free-mime-event.eml";
    await env.ATTACHMENTS.put(key, raw);
    await env.DB.prepare(
      "INSERT INTO inbound_mail_events (id, staging_object_key, envelope_to, status, created_at, updated_at) VALUES (?, ?, ?, 'staged', ?, ?)",
    )
      .bind(eventId, key, "support-free-mime@example.test", Date.now(), Date.now())
      .run();
    await processInboundMail(env, { eventId, stagingObjectKey: key });
    expect(
      await env.DB.prepare("SELECT status, attachment_cursor AS cursor, attempts FROM inbound_mail_events WHERE id = ?")
        .bind(eventId)
        .first(),
    ).toMatchObject({ status: "staged", cursor: 5, attempts: 0 });
    await env.DB.prepare("UPDATE tickets SET status = 'resolved' WHERE organization_id = ?")
      .bind(session.organizationId)
      .run();
    await processInboundMail(env, { eventId, stagingObjectKey: key });
    expect(
      (
        await env.DB.prepare("SELECT status FROM tickets WHERE organization_id = ?")
          .bind(session.organizationId)
          .first()
      )?.status,
    ).toBe("resolved");
    expect(
      await env.DB.prepare("SELECT status, attachment_cursor AS cursor FROM inbound_mail_events WHERE id = ?")
        .bind(eventId)
        .first(),
    ).toMatchObject({ status: "completed", cursor: 6 });
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM attachments WHERE organization_id = ?")
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(6);
  });
});

describe("streaming upload failures", () => {
  it("releases a stalled stream when the R2 sink rejects before reading", async () => {
    const { storeValidatedUpload } = await import("../src/server/attachments/stream");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const bucket = {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;
    await expect(
      storeValidatedUpload(bucket, "synthetic", body, 3, "text/plain", "synthetic", () => true),
    ).rejects.toThrow("R2 unavailable");
  });
});

describe("D1 bulk query budget", () => {
  it("updates twenty tickets with lifecycle/audit records within forty SQL statements", async () => {
    const { session, customer, ticket } = await fixture("free-bulk");
    const ids = [ticket.id];
    for (let i = 0; i < 19; i++) {
      const id = `free-bulk-${i}`;
      ids.push(id);
      await env.DB.prepare(
        "INSERT INTO tickets (id, organization_id, customer_id, number, subject, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'Bulk', 'open', 'normal', 1, 1)",
      )
        .bind(id, session.organizationId, customer.id, 100 + i)
        .run();
    }
    const spy = vi.spyOn(env.DB, "prepare");
    try {
      const response = await request(
        "/operations/tickets/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            ticketIds: ids,
            status: "resolved",
            priority: "urgent",
            assignedUserId: session.userId,
          }),
        },
        session,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ updated: 20, skipped: [] });
      expect(spy.mock.calls.length).toBeLessThan(40);
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM activity_logs WHERE organization_id = ? AND event_type = 'ticket.bulk_updated'",
        )
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(20);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM ticket_assignments WHERE organization_id = ?")
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(20);
  });
});

describe("provider retry boundaries", () => {
  it("freezes the envelope and stops after six transient failures", async () => {
    const { session, ticket } = await fixture("free-provider-retries");
    const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE organization_id = ?")
      .bind(session.organizationId)
      .first<{ id: string }>();
    const provider = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ message: "private provider detail" }, { status: 503 }));
    try {
      for (let attempt = 1; attempt <= 6; attempt++) {
        await expect(
          processOutboundMail({ ...env, RESEND_API_KEY: "synthetic-test-key" }, { jobId: job!.id }),
        ).rejects.toMatchObject({ terminal: attempt === 6 });
        await env.DB.prepare("UPDATE outbound_mail_jobs SET next_attempt_at = 0 WHERE id = ?").bind(job!.id).run();
        await env.DB.prepare("UPDATE tickets SET subject = 'Changed during retry' WHERE id = ?").bind(ticket.id).run();
      }
      await processOutboundMail({ ...env, RESEND_API_KEY: "synthetic-test-key" }, { jobId: job!.id });
      expect(provider).toHaveBeenCalledTimes(6);
      const envelopes = provider.mock.calls.map((call) => call[1]?.body);
      expect(new Set(envelopes).size).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT attempts, terminal_reason AS reason, last_error AS error FROM outbound_mail_jobs WHERE id = ?",
        )
          .bind(job!.id)
          .first(),
      ).toMatchObject({ attempts: 6, reason: "provider_503", error: "provider_503" });
    } finally {
      provider.mockRestore();
    }
  });
});

describe("incremental outbox discovery", () => {
  it("recovers only twenty queued candidates and resumes at the next cursor", async () => {
    const { session, ticket } = await fixture("free-outbox-cursor");
    for (let i = 0; i < 25; i++)
      await env.DB.prepare(
        "INSERT INTO messages (id, organization_id, ticket_id, author_type, kind, body_text, delivery_status, created_at) VALUES (?, ?, ?, 'agent', 'message', 'pending', 'queued', 0)",
      )
        .bind(`free-outbox-${String(i).padStart(3, "0")}`, session.organizationId, ticket.id)
        .run();
    await runScheduled(env);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM outbound_mail_jobs WHERE organization_id = ?")
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(21);
    await runScheduled(env);
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM outbound_mail_jobs WHERE organization_id = ?")
          .bind(session.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(26);
  });
});
