import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("operational workflows", () => {
  it("protects ticket updates with versions and isolates drafts", async () => {
    const alpha = await signup("operations-alpha");
    const beta = await signup("operations-beta");
    const customerResponse = await request("/customers", { method: "POST", body: JSON.stringify({ name: "Version Customer", email: "version@example.test" }) }, alpha);
    const customer = (await customerResponse.json() as { customer: { id: string } }).customer;
    const created = await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Concurrent update", message: "Initial message" }) }, alpha);
    const ticket = (await created.json() as { ticket: { id: string } }).ticket;
    const detail = await request(`/tickets/${ticket.id}`, {}, alpha);
    const version = (await detail.json() as { ticket: { version: number } }).ticket.version;

    expect((await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ priority: "high", version }) }, alpha)).status).toBe(200);
    expect((await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ priority: "urgent", version }) }, alpha)).status).toBe(409);

    expect((await request(`/operations/tickets/${ticket.id}/draft`, { method: "PUT", body: JSON.stringify({ body: "Private draft", kind: "internal_note", revision: 0 }) }, alpha)).status).toBe(200);
    const draft = await request(`/operations/tickets/${ticket.id}/draft`, {}, alpha);
    expect(await draft.json()).toMatchObject({ draft: { body: "Private draft", revision: 1 } });
    expect((await request(`/operations/tickets/${ticket.id}/draft`, {}, beta)).status).toBe(404);
  });

  it("returns exact aggregate metrics independently of ticket page size", async () => {
    const workspace = await signup("operations-dashboard");
    const customerResponse = await request("/customers", { method: "POST", body: JSON.stringify({ name: "Metrics Customer", email: "metrics@example.test" }) }, workspace);
    const customer = (await customerResponse.json() as { customer: { id: string } }).customer;
    for (let index = 0; index < 55; index += 1) {
      await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: `Metric ${index}`, message: "Measure this ticket" }) }, workspace);
    }
    const list = await request("/tickets", {}, workspace);
    const listBody = await list.json() as { items: unknown[]; hasMore: boolean; nextCursor: string };
    expect(listBody.items).toHaveLength(30);
    expect(listBody.hasMore).toBe(true);
    expect(listBody.nextCursor).toBeTruthy();
    const dashboard = await request("/operations/dashboard", {}, workspace);
    expect(await dashboard.json()).toMatchObject({ metrics: { openTickets: 55, unassignedTickets: 55 } });
  });
});
