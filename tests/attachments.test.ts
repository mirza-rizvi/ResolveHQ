import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "resolve-server/types";
import { request, signup } from "./helpers";
import worker from "../worker";

describe("attachment authorization", () => {
  it("uploads before sending and links attachments to the new message", async () => {
    const workspace = await signup("attach-first");
    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "attach-first@example.test" }) }, workspace);
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "A", email: "a@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Attach", message: "x" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    const file = new TextEncoder().encode("plain text log");
    const intent = await (await request("/attachments/intents", { method: "POST", body: JSON.stringify({ ticketId: ticket.id, filename: "log.txt", contentType: "text/plain", size: file.byteLength }) }, workspace)).json() as { upload: { attachmentId: string; url: string } };
    const upload = await request(intent.upload.url.replace(/^\/api/, ""), { method: "PUT", body: file, headers: { "content-type": "text/plain", "content-length": String(file.byteLength) } }, workspace);
    expect(upload.status).toBe(201);
    expect((await upload.json() as { attachment: { messageId: string | null } }).attachment.messageId).toBeNull();
    const message = await (await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "see log", kind: "message", attachmentIds: [intent.upload.attachmentId] }) }, workspace)).json() as { message: { id: string } };
    const row = await env.DB.prepare("SELECT message_id AS messageId FROM attachments WHERE id = ?").bind(intent.upload.attachmentId).first<{ messageId: string }>();
    expect(row?.messageId).toBe(message.message.id);
    expect((await request(`/attachments/${intent.upload.attachmentId}`, {}, workspace)).status).toBe(200);
    const other = await signup("attach-other");
    expect((await request(`/attachments/${intent.upload.attachmentId}`, {}, other)).status).toBe(404);
    expect((await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "again", kind: "message", attachmentIds: [intent.upload.attachmentId] }) }, workspace)).status).toBe(404);
  });

  it("refuses to create a message when an attachment belongs to another uploader or ticket", async () => {
    const workspace = await signup("attach-owner");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "B", email: "b@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const first = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "First", message: "x" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    const second = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Second", message: "y" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    const file = new TextEncoder().encode("another log");
    const intent = await (await request("/attachments/intents", { method: "POST", body: JSON.stringify({ ticketId: first.id, filename: "log.txt", contentType: "text/plain", size: file.byteLength }) }, workspace)).json() as { upload: { attachmentId: string; url: string } };
    expect((await request(intent.upload.url.replace(/^\/api/, ""), { method: "PUT", body: file, headers: { "content-type": "text/plain", "content-length": String(file.byteLength) } }, workspace)).status).toBe(201);

    // The upload belongs to another ticket, so the reply must fail before a
    // message row exists.
    const wrongTicket = await request(`/tickets/${second.id}/messages`, { method: "POST", body: JSON.stringify({ body: "wrong ticket", kind: "message", attachmentIds: [intent.upload.attachmentId] }) }, workspace);
    expect(wrongTicket.status).toBe(404);
    expect((await wrongTicket.json() as { error: { code: string } }).error.code).toBe("attachment_not_found");
    const stray = await env.DB.prepare("SELECT count(*) AS total FROM messages WHERE ticket_id = ? AND body_text = 'wrong ticket'").bind(second.id).first<{ total: number }>();
    expect(stray?.total).toBe(0);

    const missing = await request(`/tickets/${first.id}/messages`, { method: "POST", body: JSON.stringify({ body: "missing", kind: "message", attachmentIds: [intent.upload.attachmentId, "att_does_not_exist"] }) }, workspace);
    expect(missing.status).toBe(404);
    const unlinked = await env.DB.prepare("SELECT message_id AS messageId FROM attachments WHERE id = ?").bind(intent.upload.attachmentId).first<{ messageId: string | null }>();
    expect(unlinked?.messageId).toBeNull();
  });

  it("sweeps orphaned uploads and their objects after a day", async () => {
    const workspace = await signup("attach-orphan");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "C", email: "c@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Orphan", message: "x" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    const objectKey = `${workspace.organizationId}/att_orphan_fixture/object`;
    await env.ATTACHMENTS.put(objectKey, new TextEncoder().encode("abandoned upload"));
    await env.DB.prepare("INSERT INTO attachments (id, organization_id, ticket_id, message_id, object_key, filename, content_type, size, checksum, uploaded_by_user_id, created_at) VALUES (?, ?, ?, NULL, ?, 'orphan.txt', 'text/plain', 16, 'sum', ?, ?)")
      .bind("att_orphan_fixture", workspace.organizationId, ticket.id, objectKey, workspace.userId, Date.now() - 2 * 24 * 60 * 60 * 1000).run();

    const fresh = `${workspace.organizationId}/att_fresh_fixture/object`;
    await env.ATTACHMENTS.put(fresh, new TextEncoder().encode("recent upload"));
    await env.DB.prepare("INSERT INTO attachments (id, organization_id, ticket_id, message_id, object_key, filename, content_type, size, checksum, uploaded_by_user_id, created_at) VALUES (?, ?, ?, NULL, ?, 'fresh.txt', 'text/plain', 13, 'sum', ?, ?)")
      .bind("att_fresh_fixture", workspace.organizationId, ticket.id, fresh, workspace.userId, Date.now()).run();

    const context = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry: () => undefined }, env as AppBindings, context);
    await waitOnExecutionContext(context);

    expect(await env.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind("att_orphan_fixture").first()).toBeNull();
    expect(await env.ATTACHMENTS.head(objectKey)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind("att_fresh_fixture").first()).not.toBeNull();
    expect(await env.ATTACHMENTS.head(fresh)).not.toBeNull();
  });
});
