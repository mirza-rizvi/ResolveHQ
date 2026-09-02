import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processInboundMail } from "resolve-server/mail/queue";
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
