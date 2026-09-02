import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processInboundMail, processOutboundMail } from "resolve-server/mail/queue";
import { sendSystemMail } from "resolve-server/mail/system";
import type { AppBindings } from "resolve-server/types";
import { signup } from "./helpers";

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

function mimeMessage(input: { id: string; to: string; subject: string; body: string }) {
  return new TextEncoder().encode([
    "From: Casey Customer <customer@example.test>",
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${input.id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
  ].join("\r\n")).buffer as ArrayBuffer;
}
