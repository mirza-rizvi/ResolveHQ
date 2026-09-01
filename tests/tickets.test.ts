import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("tenant ticket workflow", () => {
  it("creates customers and tickets, replies, notes, assigns, and isolates tenants", async () => {
    const alpha = await signup("alpha");
    const beta = await signup("beta");
    const customerResponse = await request("/customers", { method: "POST", body: JSON.stringify({ name: "Taylor Reed", email: "taylor@example.test", company: "Reed Labs" }) }, alpha);
    expect(customerResponse.status).toBe(201);
    const customer = (await customerResponse.json() as { customer: { id: string } }).customer;

    const ticketResponse = await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Production webhook is delayed", message: "Events are arriving ten minutes late.", priority: "high" }) }, alpha);
    expect(ticketResponse.status).toBe(201);
    const ticket = (await ticketResponse.json() as { ticket: { id: string; number: number } }).ticket;
    expect(ticket.number).toBe(1001);

    expect((await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Investigating the queue lag now.", kind: "internal_note" }) }, alpha)).status).toBe(201);
    expect((await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "We found the delayed consumer and are draining it now.", kind: "message" }) }, alpha)).status).toBe(201);
    expect((await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ assignedUserId: alpha.userId, status: "resolved", priority: "urgent" }) }, alpha)).status).toBe(200);
    const tagResponse = await request("/tags", { method: "POST", body: JSON.stringify({ name: "escalated-test", color: "red" }) }, alpha);
    const tag = (await tagResponse.json() as { tag: { id: string } }).tag;
    expect((await request(`/tickets/${ticket.id}/tags`, { method: "POST", body: JSON.stringify({ tagId: tag.id }) }, alpha)).status).toBe(201);

    const messageSearch = await request("/tickets?q=draining", {}, alpha);
    const tagSearch = await request("/tickets?q=escalated-test", {}, alpha);
    expect((await messageSearch.json() as { tickets: unknown[] }).tickets).toHaveLength(1);
    expect((await tagSearch.json() as { tickets: unknown[] }).tickets).toHaveLength(1);

    const detail = await request(`/tickets/${ticket.id}`, {}, alpha);
    const detailBody = await detail.json() as { ticket: { status: string; priority: string }; messages: unknown[] };
    expect(detailBody.ticket).toMatchObject({ status: "resolved", priority: "urgent" });
    expect(detailBody.messages).toHaveLength(3);

    expect((await request(`/tickets/${ticket.id}`, {}, beta)).status).toBe(404);
    expect((await request(`/customers/${customer.id}`, {}, beta)).status).toBe(404);
  });
});
