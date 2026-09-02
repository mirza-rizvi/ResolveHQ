import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "resolve-server/app";
import { request, signup } from "./helpers";

async function sign(secret: string, id: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return `v1,${btoa(String.fromCharCode(...signature))}`;
}

const secret = `whsec_${btoa("test-webhook-secret-value")}`;

async function deliver(eventId: string, body: string, signature?: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.request(
    "http://localhost/api/webhooks/resend",
    {
      method: "POST",
      body,
      headers: {
        "svix-id": eventId,
        "svix-timestamp": timestamp,
        "svix-signature": signature ?? (await sign(secret, eventId, timestamp, body)),
      },
    },
    { ...env, RESEND_WEBHOOK_SECRET: secret },
  );
}

describe("resend webhooks", () => {
  it("rejects bad signatures and replays the same event once", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_signature_id" } });
    const bad = await deliver("evt_bad", body, "v1,AAAA");
    expect(bad.status).toBe(401);
    const good = await deliver("evt_good", body);
    expect(good.status).toBe(200);
    const replay = await deliver("evt_good", body);
    expect(((await replay.json()) as { duplicate?: boolean }).duplicate).toBe(true);
  });

  it("only updates the message owned by the tenant whose job holds the provider id", async () => {
    const alpha = await signup("webhook-alpha");
    const beta = await signup("webhook-beta");
    const messageIds: Record<string, string> = {};
    for (const [name, workspace] of [
      ["alpha", alpha],
      ["beta", beta],
    ] as const) {
      const customer = (
        (await (
          await request(
            "/customers",
            {
              method: "POST",
              body: JSON.stringify({ name: `Customer ${name}`, email: `customer-${name}@example.test` }),
            },
            workspace,
          )
        ).json()) as { customer: { id: string } }
      ).customer;
      const ticket = (
        (await (
          await request(
            "/tickets",
            {
              method: "POST",
              body: JSON.stringify({ customerId: customer.id, subject: `Subject ${name}`, message: `Hello ${name}` }),
            },
            workspace,
          )
        ).json()) as { ticket: { id: string } }
      ).ticket;
      const row = await env.DB.prepare("SELECT id FROM messages WHERE organization_id = ? AND ticket_id = ?")
        .bind(workspace.organizationId, ticket.id)
        .first<{ id: string }>();
      messageIds[name] = row!.id;
    }
    // Both tenants carry the same provider id on their message rows, but only
    // alpha's outbound job records it — the update must follow the job.
    const providerMessageId = "re_shared_id";
    await env.DB.prepare("UPDATE messages SET provider_message_id = ? WHERE id IN (?, ?)")
      .bind(providerMessageId, messageIds.alpha, messageIds.beta)
      .run();
    await env.DB.prepare("UPDATE outbound_mail_jobs SET provider_message_id = ? WHERE message_id = ?")
      .bind(providerMessageId, messageIds.alpha)
      .run();

    const body = JSON.stringify({ type: "email.delivered", data: { email_id: providerMessageId } });
    expect((await deliver("evt_scope", body)).status).toBe(200);

    const alphaStatus = await env.DB.prepare("SELECT delivery_status AS status FROM messages WHERE id = ?")
      .bind(messageIds.alpha)
      .first<{ status: string }>();
    const betaStatus = await env.DB.prepare("SELECT delivery_status AS status FROM messages WHERE id = ?")
      .bind(messageIds.beta)
      .first<{ status: string }>();
    expect(alphaStatus?.status).toBe("sent");
    expect(betaStatus?.status).toBe("queued");
  });
});
