import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("search", () => {
  it("returns nothing for punctuation-only queries and finds renamed customers", async () => {
    const workspace = await signup("search");
    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "search@example.test" }) }, workspace);
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Original Name", email: "orig@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Search subject", message: "body" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    expect(((await (await request("/tickets?q=%3F%3F%3F", {}, workspace)).json()) as { tickets: unknown[] }).tickets).toHaveLength(0);
    expect(((await (await request("/search?q=%3F%3F%3F", {}, workspace)).json()) as { results: unknown[] }).results).toHaveLength(0);
    await request(`/customers/${customer.id}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed Person" }) }, workspace);
    await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "note", kind: "internal_note" }) }, workspace);
    expect(((await (await request("/tickets?q=renamed", {}, workspace)).json()) as { tickets: unknown[] }).tickets).toHaveLength(1);
  });
});
