import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processInboundMail, processOutboundMail } from "resolve-server/mail/queue";
import { sendSystemMail } from "resolve-server/mail/system";
import type { AppBindings } from "resolve-server/types";
import { signup } from "./helpers";
import worker from "../worker";

describe("mail queue workflow", () => {
  it("creates an isolated ticket from inbound email and de-duplicates provider messages", async () => {
    const alpha = await signup("mail-alpha");
    const beta = await signup("mail-beta");
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?").bind("help-alpha@example.test", alpha.organizationId).run();
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?").bind("help-beta@example.test", beta.organizationId).run();
    const raw = mimeMessage({ id: "<inbound-1@example.test>", to: "help-alpha@example.test", subject: "Checkout cannot complete", body: "The checkout spinner never stops." });

    await processInboundMail(env as AppBindings, { raw, from: "customer@example.test", to: "help-alpha@example.test" });
    await processInboundMail(env as AppBindings, { raw, from: "customer@example.test", to: "help-alpha@example.test" });

    const alphaTickets = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(alpha.organizationId).first<{ count: number }>();
    const betaTickets = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(beta.organizationId).first<{ count: number }>();
    const messages = await env.DB.prepare("SELECT count(*) AS count FROM messages WHERE organization_id = ? AND provider_message_id = ?").bind(alpha.organizationId, "<inbound-1@example.test>").first<{ count: number }>();
    expect(alphaTickets?.count).toBe(1);
    expect(betaTickets?.count).toBe(0);
    expect(messages?.count).toBe(1);
  });

  it("stages mail larger than the queue limit and cleans up the R2 object", async () => {
    const workspace = await signup("mail-large");
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?").bind("large@example.test", workspace.organizationId).run();
    const eventId = "ime_large_mail_test";
    const stagingObjectKey = `_mail-staging/${eventId}.eml`;
    const raw = mimeMessage({ id: "<large@example.test>", to: "large@example.test", subject: "Large diagnostic log", body: "x".repeat(150_000) });
    expect(raw.byteLength).toBeGreaterThan(128 * 1024);
    await env.ATTACHMENTS.put(stagingObjectKey, raw);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO inbound_mail_events (id, staging_object_key, status, attachment_cursor, attempts, created_at, updated_at) VALUES (?, ?, 'staged', 0, 0, ?, ?)").bind(eventId, stagingObjectKey, now, now).run();

    await processInboundMail(env as AppBindings, { eventId, stagingObjectKey, from: "customer@example.test", to: "large@example.test" });

    expect(await env.ATTACHMENTS.head(stagingObjectKey)).toBeNull();
    const event = await env.DB.prepare("SELECT status FROM inbound_mail_events WHERE id = ?").bind(eventId).first<{ status: string }>();
    expect(event?.status).toBe("completed");
  });

  it("does not attach a forged subject ticket number to another customer", async () => {
    const workspace = await signup("mail-forged-subject");
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?").bind("forged@example.test", workspace.organizationId).run();
    const customerResponse = await import("./helpers").then(({ request }) => request("/customers", { method: "POST", body: JSON.stringify({ name: "Victim", email: "victim@example.test" }) }, workspace));
    const customer = (await customerResponse.json() as { customer: { id: string } }).customer;
    const ticketResponse = await import("./helpers").then(({ request }) => request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Private billing issue", message: "Original request" }) }, workspace));
    const ticket = (await ticketResponse.json() as { ticket: { number: number } }).ticket;

    await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<forged@example.test>", to: "forged@example.test", subject: `Re: [#${ticket.number}] Private billing issue`, body: "Please expose the history." }), from: "customer@example.test", to: "forged@example.test" });

    const count = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ count: number }>();
    expect(count?.count).toBe(2);
  });

  it("captures outbound mail in development mode", async () => {
    const workspace = await signup("mail-capture");
    const { request } = await import("./helpers");
    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "capture@example.test" }) }, workspace);
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Cap", email: "cap@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Capture me", message: "Hello" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    const reply = await (await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Reply body", kind: "message" }) }, workspace)).json() as { message: { id: string } };
    const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(reply.message.id).first<{ id: string }>();
    await processOutboundMail(env as AppBindings, { jobId: job!.id });
    const capture = await env.DB.prepare("SELECT to_address AS \"to\", subject FROM mail_captures WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(workspace.organizationId).first<{ to: string; subject: string }>();
    expect(capture?.to).toBe("cap@example.test");
    expect(capture?.subject).toContain("Capture me");
    const listed = await request("/operations/dev-mail", {}, workspace);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { captures: unknown[] }).captures.length).toBeGreaterThan(0);
  });

  it("threads a customer reply onto the ticket the agent replied from", async () => {
    const workspace = await signup("mail-thread");
    const { request } = await import("./helpers");
    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "thread@example.test" }) }, workspace);
    await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<first@example.test>", to: "thread@example.test", subject: "Login broken", body: "Cannot sign in." }), from: "customer@example.test", to: "thread@example.test" });
    const ticket = await env.DB.prepare("SELECT id FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ id: string }>();
    const reply = await (await request(`/tickets/${ticket!.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Try resetting.", kind: "message" }) }, workspace)).json() as { message: { id: string } };
    const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(reply.message.id).first<{ id: string }>();
    await processOutboundMail(env as AppBindings, { jobId: job!.id });
    const sent = await env.DB.prepare("SELECT rfc_message_id AS rfc FROM messages WHERE id = ?").bind(reply.message.id).first<{ rfc: string }>();
    expect(sent?.rfc).toMatch(/^<.+@example\.test>$/);
    const capture = await env.DB.prepare("SELECT headers FROM mail_captures WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(workspace.organizationId).first<{ headers: string }>();
    expect(JSON.parse(capture!.headers)["In-Reply-To"]).toBe("<first@example.test>");
    await request(`/tickets/${ticket!.id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }, workspace);

    await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<second@example.test>", to: "thread@example.test", subject: "Re: Login broken", body: "Still broken.", inReplyTo: sent!.rfc }), from: "customer@example.test", to: "thread@example.test" });
    const count = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ count: number }>();
    expect(count?.count).toBe(1);
    const state = await env.DB.prepare("SELECT status, message_count AS messages FROM tickets WHERE id = ?").bind(ticket!.id).first<{ status: string; messages: number }>();
    expect(state).toMatchObject({ status: "open", messages: 3 });
  });

  it("threads a reply that carries only a multi-id References header", async () => {
    const workspace = await signup("mail-references");
    const { request } = await import("./helpers");
    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "references@example.test" }) }, workspace);
    await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<r1@example.test>", to: "references@example.test", subject: "Export fails", body: "The export button errors." }), from: "customer@example.test", to: "references@example.test" });
    const ticket = await env.DB.prepare("SELECT id FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ id: string }>();
    const reply = await (await request(`/tickets/${ticket!.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Looking into it.", kind: "message" }) }, workspace)).json() as { message: { id: string } };
    const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(reply.message.id).first<{ id: string }>();
    await processOutboundMail(env as AppBindings, { jobId: job!.id });
    const sent = await env.DB.prepare("SELECT rfc_message_id AS rfc FROM messages WHERE id = ?").bind(reply.message.id).first<{ rfc: string }>();

    await processInboundMail(env as AppBindings, {
      raw: mimeMessage({ id: "<r2@example.test>", to: "references@example.test", subject: "Re: Export fails", body: "Still failing.", references: `<junk-a@elsewhere.test> <junk-b@elsewhere.test> ${sent!.rfc}` }),
      from: "customer@example.test",
      to: "references@example.test",
    });

    const count = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ count: number }>();
    expect(count?.count).toBe(1);
    const state = await env.DB.prepare("SELECT message_count AS messages FROM tickets WHERE id = ?").bind(ticket!.id).first<{ messages: number }>();
    expect(state?.messages).toBe(3);
  });

  it("fails the job and the message when no support address is configured", async () => {
    const workspace = await signup("mail-no-inbox");
    const { request } = await import("./helpers");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Nina", email: "nina@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "No inbox", message: "Original request" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    const settings = await (await request("/organization/settings", {}, workspace)).json() as { inboxes: Array<{ id: string }> };
    expect((await request(`/organization/inboxes/${settings.inboxes[0].id}`, { method: "PATCH", body: JSON.stringify({ disabled: true }) }, workspace)).status).toBe(200);
    const reply = await (await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Reply body", kind: "message" }) }, workspace)).json() as { message: { id: string } };
    const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(reply.message.id).first<{ id: string }>();

    await expect(processOutboundMail(env as AppBindings, { jobId: job!.id })).rejects.toThrow("No support inbox");

    const jobState = await env.DB.prepare("SELECT status, last_error AS error FROM outbound_mail_jobs WHERE id = ?").bind(job!.id).first<{ status: string; error: string }>();
    expect(jobState?.status).toBe("failed");
    expect(jobState?.error).toContain("No support inbox");
    const messageState = await env.DB.prepare("SELECT delivery_status AS status FROM messages WHERE id = ?").bind(reply.message.id).first<{ status: string }>();
    expect(messageState?.status).toBe("failed");
  });

  it("falls back to the subject ticket number only for the same customer", async () => {
    const workspace = await signup("mail-subject");
    const { request } = await import("./helpers");
    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "subject@example.test" }) }, workspace);
    await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<s1@example.test>", to: "subject@example.test", subject: "Invoice", body: "Where is it?" }), from: "customer@example.test", to: "subject@example.test" });
    const ticket = await env.DB.prepare("SELECT number FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ number: number }>();
    await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<s2@example.test>", to: "subject@example.test", subject: `Re: [#${ticket!.number}] Invoice`, body: "Following up." }), from: "customer@example.test", to: "subject@example.test" });
    await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<s3@example.test>", to: "subject@example.test", subject: `Re: [#${ticket!.number}] Invoice`, body: "I am someone else.", from: "Other <other@example.test>" }), from: "other@example.test", to: "subject@example.test" });
    const count = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ count: number }>();
    expect(count?.count).toBe(2);
  });
});

describe("system mail", () => {
  it("persists system mail as an organization-less capture using the default from address", async () => {
    await sendSystemMail(env as AppBindings, { to: "notify-default@example.test", subject: "Default from address", text: "hello" });
    const capture = await env.DB.prepare("SELECT organization_id AS organizationId, from_address AS \"from\" FROM mail_captures WHERE to_address = ?").bind("notify-default@example.test").first<{ organizationId: string | null; from: string }>();
    expect(capture?.organizationId).toBeNull();
    expect(capture?.from).toBe("no-reply@localhost");
  });

  it("honors a SYSTEM_MAIL_FROM override", async () => {
    await sendSystemMail({ ...env, SYSTEM_MAIL_FROM: "alerts@resolvehq.test" } as AppBindings, { to: "notify-override@example.test", subject: "Custom from address", text: "hello" });
    const capture = await env.DB.prepare("SELECT from_address AS \"from\" FROM mail_captures WHERE to_address = ?").bind("notify-override@example.test").first<{ from: string }>();
    expect(capture?.from).toBe("alerts@resolvehq.test");
  });

  it("rejects when no outgoing mail provider is configured", async () => {
    await expect(
      sendSystemMail({ ...env, DEV_MAIL_MODE: "disabled" } as AppBindings, { to: "notify-unconfigured@example.test", subject: "No provider", text: "hello" }),
    ).rejects.toThrow("No outgoing mail provider is configured.");
  });
});

describe("scheduled mail recovery", () => {
  it("recovers stalled jobs, re-enqueues staged inbound email, and clears expired staging objects", async () => {
    const workspace = await signup("mail-cron");
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?").bind("cron@example.test", workspace.organizationId).run();
    const { request } = await import("./helpers");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Cron", email: "cron-customer@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Stalled send", message: "Please reply." }) }, workspace);
    const stale = Date.now() - 30 * 60 * 1000;
    await env.DB.prepare("UPDATE outbound_mail_jobs SET status = 'processing', updated_at = ? WHERE organization_id = ?").bind(stale, workspace.organizationId).run();

    const eventId = "ime_cron_recovery";
    const stagingObjectKey = `_mail-staging/${eventId}.eml`;
    await env.ATTACHMENTS.put(stagingObjectKey, mimeMessage({ id: "<cron@example.test>", to: "cron@example.test", subject: "Stalled inbound", body: "Recover me." }));
    await env.DB.prepare("INSERT INTO inbound_mail_events (id, staging_object_key, status, attachment_cursor, attempts, created_at, updated_at) VALUES (?, ?, 'processing', 0, 1, ?, ?)").bind(eventId, stagingObjectKey, stale, stale).run();

    const expiredKey = "_mail-staging/ime_cron_expired.eml";
    await env.ATTACHMENTS.put(expiredKey, new TextEncoder().encode("stale staging payload"));
    await env.DB.prepare("INSERT INTO inbound_mail_events (id, staging_object_key, status, attachment_cursor, attempts, created_at, updated_at) VALUES (?, ?, 'completed', 0, 1, ?, ?)")
      .bind("ime_cron_expired", expiredKey, 0, Date.now() - 30 * 24 * 60 * 60 * 1000).run();

    const context = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry: () => undefined }, env as AppBindings, context);
    await waitOnExecutionContext(context);

    const job = await env.DB.prepare("SELECT status, last_error AS lastError FROM outbound_mail_jobs WHERE organization_id = ?").bind(workspace.organizationId).first<{ status: string; lastError: string }>();
    expect(job?.status).toBe("failed");
    expect(job?.lastError).toBe("Recovered from stalled processing");
    const recovered = await env.DB.prepare("SELECT status FROM inbound_mail_events WHERE id = ?").bind(eventId).first<{ status: string }>();
    expect(recovered?.status).toBe("failed");
    expect(await env.ATTACHMENTS.head(expiredKey)).toBeNull();
    const retired = await env.DB.prepare("SELECT staging_object_key AS key FROM inbound_mail_events WHERE id = ?").bind("ime_cron_expired").first<{ key: string }>();
    expect(retired?.key).toBe("deleted/ime_cron_expired");
    expect(await env.ATTACHMENTS.head(stagingObjectKey)).not.toBeNull();
    const live = await env.DB.prepare("SELECT staging_object_key AS key FROM inbound_mail_events WHERE id = ?").bind(eventId).first<{ key: string }>();
    expect(live?.key).toBe(stagingObjectKey);

    // The cron re-enqueue carries no envelope addresses, so processing must rely
    // on the parsed headers alone and must not collide with the existing row.
    await processInboundMail(env as AppBindings, { eventId, stagingObjectKey, from: "", to: "" });
    const completed = await env.DB.prepare("SELECT status FROM inbound_mail_events WHERE id = ?").bind(eventId).first<{ status: string }>();
    expect(completed?.status).toBe("completed");
    const ticket = await env.DB.prepare("SELECT subject FROM tickets WHERE organization_id = ? AND subject = ?").bind(workspace.organizationId, "Stalled inbound").first<{ subject: string }>();
    expect(ticket?.subject).toBe("Stalled inbound");
  });

  it("adopts an agent reply whose outbound job never landed", async () => {
    const workspace = await signup("mail-orphan");
    const { request } = await import("./helpers");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Orphan", email: "orphan@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Orphan", message: "first" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    // A reply whose message insert committed but whose ticket/job batch never ran.
    const messageId = "msg_orphaned_reply_fixture";
    await env.DB.prepare("INSERT INTO messages (id, organization_id, ticket_id, author_type, author_user_id, kind, body_text, normalized_search, delivery_status, created_at) VALUES (?, ?, ?, 'agent', ?, 'message', 'orphaned reply', 'orphaned reply', 'queued', ?)")
      .bind(messageId, workspace.organizationId, ticket.id, workspace.userId, Date.now() - 5 * 60 * 1000).run();
    expect(await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(messageId).first()).toBeNull();

    const context = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry: () => undefined }, env as AppBindings, context);
    await waitOnExecutionContext(context);

    const job = await env.DB.prepare("SELECT id, status, idempotency_key AS idempotencyKey FROM outbound_mail_jobs WHERE message_id = ?").bind(messageId).first<{ id: string; status: string; idempotencyKey: string }>();
    expect(job?.status).toBe("pending");
    expect(job?.idempotencyKey).toBe(`message/${messageId}`);
    expect(job?.id).toMatch(/^omj_[0-9a-f]{32}$/);
  });

  it("counts an attempt and records the reason when the staged payload is gone", async () => {
    const eventId = "ime_missing_payload";
    const stagingObjectKey = `_mail-staging/${eventId}.eml`;
    const now = Date.now();
    await env.DB.prepare("INSERT INTO inbound_mail_events (id, staging_object_key, status, attachment_cursor, attempts, created_at, updated_at) VALUES (?, ?, 'failed', 0, 0, ?, ?)").bind(eventId, stagingObjectKey, now, now).run();
    // Nothing was ever written to R2 under that key.
    await expect(processInboundMail(env as AppBindings, { eventId, stagingObjectKey, from: "", to: "" })).rejects.toThrow("The staged inbound email is missing.");
    const row = await env.DB.prepare("SELECT attempts, status, last_error AS lastError FROM inbound_mail_events WHERE id = ?").bind(eventId).first<{ attempts: number; status: string; lastError: string }>();
    // Without the attempt landing here the cron would re-queue this row forever.
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("The staged inbound email is missing.");
  });
});

function mimeMessage(input: { id: string; to: string; subject: string; body: string; inReplyTo?: string; references?: string; from?: string }) {
  return new TextEncoder().encode([
    `From: ${input.from ?? "Casey Customer <customer@example.test>"}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${input.id}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
  ].join("\r\n")).buffer as ArrayBuffer;
}
