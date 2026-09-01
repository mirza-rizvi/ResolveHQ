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
