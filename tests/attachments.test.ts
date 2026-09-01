import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("attachment authorization", () => {
  it("stores validated files and denies another organization", async () => {
    const alpha = await signup("files-alpha"); const beta = await signup("files-beta");
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Ari Stone", email: "ari@example.test" }) }, alpha)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Attach debug report", message: "Please review the report." }) }, alpha)).json() as { ticket: { id: string } }).ticket;
    const detail = await (await request(`/tickets/${ticket.id}`, {}, alpha)).json() as { messages: Array<{ id: string }> };
    const form = new FormData(); form.set("ticketId", ticket.id); form.set("messageId", detail.messages[0].id); form.set("file", new File([new TextEncoder().encode("%PDF-1.7\nTest report")], "report.pdf", { type: "application/pdf" }));
    const upload = await request("/attachments", { method: "POST", body: form }, alpha);
    expect(upload.status).toBe(201);
    const attachment = (await upload.json() as { attachment: { id: string } }).attachment;
    expect((await request(`/attachments/${attachment.id}`, {}, alpha)).status).toBe(200);
    expect((await request(`/attachments/${attachment.id}`, {}, beta)).status).toBe(404);
  });
});
