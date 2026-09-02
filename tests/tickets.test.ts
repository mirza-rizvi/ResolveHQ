import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("tenant ticket workflow", () => {
  it("creates customers and tickets, replies, notes, assigns, and isolates tenants", async () => {
    const alpha = await signup("alpha");
    const beta = await signup("beta");
    const customerResponse = await request(
      "/customers",
      {
        method: "POST",
        body: JSON.stringify({ name: "Taylor Reed", email: "taylor@example.test", company: "Reed Labs" }),
      },
      alpha,
    );
    expect(customerResponse.status).toBe(201);
    const customer = ((await customerResponse.json()) as { customer: { id: string } }).customer;

    const ticketResponse = await request(
      "/tickets",
      {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.id,
          subject: "Production webhook is delayed",
          message: "Events are arriving ten minutes late.",
          priority: "high",
        }),
      },
      alpha,
    );
    expect(ticketResponse.status).toBe(201);
    const ticket = ((await ticketResponse.json()) as { ticket: { id: string; number: number } }).ticket;
    expect(ticket.number).toBe(1001);

    expect(
      (
        await request(
          `/tickets/${ticket.id}/messages`,
          { method: "POST", body: JSON.stringify({ body: "Investigating the queue lag now.", kind: "internal_note" }) },
          alpha,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          `/tickets/${ticket.id}/messages`,
          {
            method: "POST",
            body: JSON.stringify({ body: "We found the delayed consumer and are draining it now.", kind: "message" }),
          },
          alpha,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          `/tickets/${ticket.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ assignedUserId: alpha.userId, status: "resolved", priority: "urgent" }),
          },
          alpha,
        )
      ).status,
    ).toBe(200);
    const tagResponse = await request(
      "/tags",
      { method: "POST", body: JSON.stringify({ name: "escalated-test", color: "red" }) },
      alpha,
    );
    const tag = ((await tagResponse.json()) as { tag: { id: string } }).tag;
    expect(
      (await request(`/tickets/${ticket.id}/tags`, { method: "POST", body: JSON.stringify({ tagId: tag.id }) }, alpha))
        .status,
    ).toBe(201);

    const messageSearch = await request("/tickets?q=draining", {}, alpha);
    const tagSearch = await request("/tickets?q=escalated-test", {}, alpha);
    expect(((await messageSearch.json()) as { tickets: unknown[] }).tickets).toHaveLength(1);
    expect(((await tagSearch.json()) as { tickets: unknown[] }).tickets).toHaveLength(1);

    const detail = await request(`/tickets/${ticket.id}`, {}, alpha);
    const detailBody = (await detail.json()) as { ticket: { status: string; priority: string }; messages: unknown[] };
    expect(detailBody.ticket).toMatchObject({ status: "resolved", priority: "urgent" });
    expect(detailBody.messages).toHaveLength(3);

    expect((await request(`/tickets/${ticket.id}`, {}, beta)).status).toBe(404);
    expect((await request(`/customers/${customer.id}`, {}, beta)).status).toBe(404);
  });

  it("agent-created tickets are agent-authored, queued for delivery, and wait on the customer", async () => {
    const workspace = await signup("agent-ticket");
    await request(
      "/organization/inboxes",
      { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "agent-ticket@example.test" }) },
      workspace,
    );
    const customer = (
      (await (
        await request(
          "/customers",
          { method: "POST", body: JSON.stringify({ name: "Pat", email: "pat@example.test" }) },
          workspace,
        )
      ).json()) as { customer: { id: string } }
    ).customer;
    const ticket = (
      (await (
        await request(
          "/tickets",
          { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Welcome", message: "Hi Pat" }) },
          workspace,
        )
      ).json()) as { ticket: { id: string; status: string } }
    ).ticket;
    expect(ticket.status).toBe("waiting_customer");
    const detail = (await (await request(`/tickets/${ticket.id}`, {}, workspace)).json()) as {
      messages: Array<{ authorType: string; authorName: string | null; deliveryStatus: string }>;
    };
    expect(detail.messages[0]).toMatchObject({
      authorType: "agent",
      authorName: "Owner agent-ticket",
      deliveryStatus: "queued",
    });
    const job = await env.DB.prepare("SELECT count(*) AS count FROM outbound_mail_jobs WHERE organization_id = ?")
      .bind(workspace.organizationId)
      .first<{ count: number }>();
    expect(job?.count).toBe(1);
  });

  it("keeps resolved_at when closing and moves open tickets to waiting_customer on reply", async () => {
    const workspace = await signup("status-flow");
    await request(
      "/organization/inboxes",
      { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "status-flow@example.test" }) },
      workspace,
    );
    const customer = (
      (await (
        await request(
          "/customers",
          { method: "POST", body: JSON.stringify({ name: "Sam", email: "sam@example.test" }) },
          workspace,
        )
      ).json()) as { customer: { id: string } }
    ).customer;
    const ticket = (
      (await (
        await request(
          "/tickets",
          { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Flow", message: "Start" }) },
          workspace,
        )
      ).json()) as { ticket: { id: string } }
    ).ticket;
    await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }, workspace);
    await request(
      `/tickets/${ticket.id}/messages`,
      { method: "POST", body: JSON.stringify({ body: "Handled", kind: "message" }) },
      workspace,
    );
    let row = await env.DB.prepare("SELECT status, waiting_since AS waitingSince FROM tickets WHERE id = ?")
      .bind(ticket.id)
      .first<{ status: string; waitingSince: number | null }>();
    expect(row?.status).toBe("waiting_customer");
    expect(row?.waitingSince).not.toBeNull();
    await request(
      `/tickets/${ticket.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "resolved" }) },
      workspace,
    );
    await env.DB.prepare("UPDATE tickets SET resolved_at = 1000 WHERE id = ?").bind(ticket.id).run();
    await request(
      `/tickets/${ticket.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "resolved" }) },
      workspace,
    );
    const reResolved = await env.DB.prepare("SELECT resolved_at AS resolvedAt FROM tickets WHERE id = ?")
      .bind(ticket.id)
      .first<{ resolvedAt: number }>();
    expect(reResolved?.resolvedAt).toBe(1000);
    await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status: "closed" }) }, workspace);
    row = await env.DB.prepare(
      "SELECT resolved_at AS resolvedAt, closed_at AS closedAt, waiting_since AS waitingSince FROM tickets WHERE id = ?",
    )
      .bind(ticket.id)
      .first();
    expect(row?.resolvedAt).toBe(1000);
    expect(row?.closedAt).not.toBeNull();
    expect(row?.waitingSince).toBeNull();
  });

  it("refuses to open a ticket when the workspace has no enabled inbox", async () => {
    const workspace = await signup("no-inbox");
    const settings = (await (await request("/organization/settings", {}, workspace)).json()) as {
      inboxes: Array<{ id: string }>;
    };
    expect(
      (
        await request(
          `/organization/inboxes/${settings.inboxes[0].id}`,
          { method: "PATCH", body: JSON.stringify({ disabled: true }) },
          workspace,
        )
      ).status,
    ).toBe(200);
    const customer = (
      (await (
        await request(
          "/customers",
          { method: "POST", body: JSON.stringify({ name: "Nia", email: "nia@example.test" }) },
          workspace,
        )
      ).json()) as { customer: { id: string } }
    ).customer;
    const response = await request(
      "/tickets",
      {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id, subject: "Nowhere to send", message: "Hello" }),
      },
      workspace,
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("no_inbox");
  });

  it("treats concurrent submits with the same clientMessageId as one message", async () => {
    const workspace = await signup("idempotent");
    await request(
      "/organization/inboxes",
      { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "idem@example.test" }) },
      workspace,
    );
    const customer = (
      (await (
        await request(
          "/customers",
          { method: "POST", body: JSON.stringify({ name: "I", email: "i@example.test" }) },
          workspace,
        )
      ).json()) as { customer: { id: string } }
    ).customer;
    const ticket = (
      (await (
        await request(
          "/tickets",
          { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Idem", message: "x" }) },
          workspace,
        )
      ).json()) as { ticket: { id: string } }
    ).ticket;
    const body = JSON.stringify({ body: "same", kind: "message", clientMessageId: "client-message-0001" });
    const responses = await Promise.all(
      [1, 2, 3].map(() => request(`/tickets/${ticket.id}/messages`, { method: "POST", body }, workspace)),
    );
    expect(responses.every((response) => response.status === 201 || response.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ duplicate?: boolean }>));
    expect(bodies.filter((entry) => !entry.duplicate)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT count(*) AS count FROM messages WHERE organization_id = ? AND client_message_id = ?",
    )
      .bind(workspace.organizationId, "client-message-0001")
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
    // The ticket must be bumped exactly once, by whichever request won the insert.
    const bumped = await env.DB.prepare("SELECT message_count AS messageCount FROM tickets WHERE id = ?")
      .bind(ticket.id)
      .first<{ messageCount: number }>();
    expect(bumped?.messageCount).toBe(2);
  });

  it("sanitizes rich reply html and keeps internal notes text-only", async () => {
    const workspace = await signup("rich-reply");
    const customer = (
      (await (
        await request(
          "/customers",
          { method: "POST", body: JSON.stringify({ name: "Rich", email: "rich@example.test" }) },
          workspace,
        )
      ).json()) as { customer: { id: string } }
    ).customer;
    const ticket = (
      (await (
        await request(
          "/tickets",
          { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Rich", message: "Hello" }) },
          workspace,
        )
      ).json()) as { ticket: { id: string } }
    ).ticket;
    const html = "<p>Fixed <strong>now</strong><script>alert(1)</script></p>";
    expect(
      (
        await request(
          `/tickets/${ticket.id}/messages`,
          { method: "POST", body: JSON.stringify({ body: "Fixed now", kind: "message", bodyHtml: html }) },
          workspace,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          `/tickets/${ticket.id}/messages`,
          { method: "POST", body: JSON.stringify({ body: "Internal", kind: "internal_note", bodyHtml: html }) },
          workspace,
        )
      ).status,
    ).toBe(201);
    const rows = await env.DB.prepare(
      "SELECT kind, body_html AS bodyHtml FROM messages WHERE organization_id = ? AND ticket_id = ? ORDER BY created_at",
    )
      .bind(workspace.organizationId, ticket.id)
      .all<{ kind: string; bodyHtml: string | null }>();
    expect(rows.results.find((row) => row.kind === "message" && row.bodyHtml)?.bodyHtml).toBe(
      "<p>Fixed <strong>now</strong></p>",
    );
    expect(rows.results.find((row) => row.kind === "internal_note")?.bodyHtml).toBeNull();
  });
});
