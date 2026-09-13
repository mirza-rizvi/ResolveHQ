import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { processCustomerErasure } from "resolve-server/privacy/service";
import type { AppBindings } from "resolve-server/types";
import { request, signup } from "./helpers";
import type { TestSession } from "./helpers";

interface Identity {
  id: string;
  value: string;
  isPrimary: boolean;
  source: string;
}

async function createCustomer(session: TestSession, name: string, email: string) {
  const response = await request("/customers", { method: "POST", body: JSON.stringify({ name, email }) }, session);
  if (response.status !== 201) throw new Error(`Customer creation failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { customer: { id: string } }).customer;
}

async function readCustomer(session: TestSession, id: string) {
  const response = await request(`/customers/${id}`, {}, session);
  return (await response.json()) as {
    customer: { id: string; name: string; email: string; notes: string | null };
    identities: Identity[];
    tickets: Array<{ id: string }>;
  };
}

async function createTicket(session: TestSession, customerId: string, subject: string) {
  const response = await request(
    "/tickets",
    { method: "POST", body: JSON.stringify({ customerId, subject, message: "Original request" }) },
    session,
  );
  if (response.status !== 201) throw new Error(`Ticket creation failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { ticket: { id: string; number: number } }).ticket;
}

describe("customer identities", () => {
  it("gives every customer exactly one primary email identity", async () => {
    const workspace = await signup("identity-backfill");
    const customer = await createCustomer(workspace, "Robin Ray", "Robin.Ray@example.test");

    const detail = await readCustomer(workspace, customer.id);

    expect(detail.identities).toHaveLength(1);
    expect(detail.identities[0].value).toBe("robin.ray@example.test");
    expect(detail.identities[0].isPrimary).toBe(true);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS count FROM customer_identities WHERE organization_id = ? AND is_primary = 1",
    )
      .bind(workspace.organizationId)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("rejects an identity that another customer already owns and names the owner", async () => {
    const workspace = await signup("identity-conflict");
    const owner = await createCustomer(workspace, "Owner", "shared-identity@example.test");
    const other = await createCustomer(workspace, "Other", "other-identity@example.test");

    const response = await request(
      `/customers/${other.id}/identities`,
      { method: "POST", body: JSON.stringify({ email: "Shared-Identity@example.test" }) },
      workspace,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; ownerCustomerId: string } };
    expect(body.error.code).toBe("identity_in_use");
    expect(body.error.ownerCustomerId).toBe(owner.id);
  });

  it("adds and removes secondary identities but refuses to remove the primary", async () => {
    const workspace = await signup("identity-remove");
    const customer = await createCustomer(workspace, "Alex", "alex-primary@example.test");
    const added = await request(
      `/customers/${customer.id}/identities`,
      { method: "POST", body: JSON.stringify({ email: "alex-secondary@example.test" }) },
      workspace,
    );
    expect(added.status).toBe(201);

    const detail = await readCustomer(workspace, customer.id);
    const primary = detail.identities.find((identity) => identity.isPrimary)!;
    const secondary = detail.identities.find((identity) => !identity.isPrimary)!;
    expect(secondary.value).toBe("alex-secondary@example.test");
    expect(secondary.source).toBe("manual");

    const refused = await request(
      `/customers/${customer.id}/identities/${primary.id}`,
      { method: "DELETE" },
      workspace,
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("identity_is_primary");

    const removed = await request(
      `/customers/${customer.id}/identities/${secondary.id}`,
      { method: "DELETE" },
      workspace,
    );
    expect(removed.status).toBe(200);
    expect((await readCustomer(workspace, customer.id)).identities).toHaveLength(1);
  });

  it("moves the primary identity when the customer email changes", async () => {
    const workspace = await signup("identity-primary-change");
    const customer = await createCustomer(workspace, "Sam", "sam-old@example.test");

    const response = await request(
      `/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ email: "Sam-New@example.test" }) },
      workspace,
    );
    expect(response.status).toBe(200);

    const detail = await readCustomer(workspace, customer.id);
    expect(detail.customer.email).toBe("sam-new@example.test");
    const primary = detail.identities.find((identity) => identity.isPrimary)!;
    expect(primary.value).toBe("sam-new@example.test");
    expect(detail.identities.map((identity) => identity.value).sort()).toEqual([
      "sam-new@example.test",
      "sam-old@example.test",
    ]);

    const taken = await createCustomer(workspace, "Taken", "taken@example.test");
    const conflict = await request(
      `/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ email: "taken@example.test" }) },
      workspace,
    );
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string; ownerCustomerId: string } };
    expect(body.error.code).toBe("identity_in_use");
    expect(body.error.ownerCustomerId).toBe(taken.id);
  });

  it("finds a customer by a secondary identity when listing", async () => {
    const workspace = await signup("identity-search");
    const customer = await createCustomer(workspace, "Dana", "dana-primary@example.test");
    await request(
      `/customers/${customer.id}/identities`,
      { method: "POST", body: JSON.stringify({ email: "dana-alias@other.test" }) },
      workspace,
    );

    const response = await request("/customers?q=dana-alias@other.test", {}, workspace);
    const body = (await response.json()) as { customers: Array<{ id: string }> };

    expect(body.customers.map((row) => row.id)).toEqual([customer.id]);
  });

  it("merges a source customer into the target and keeps their history searchable", async () => {
    const workspace = await signup("identity-merge");
    const target = await createCustomer(workspace, "Jordan Work", "jordan@work.test");
    const source = await createCustomer(workspace, "Jordan Home", "jordan@home.test");
    await request(
      `/customers/${source.id}`,
      { method: "PATCH", body: JSON.stringify({ company: "Acme", phone: "+100", notes: "Prefers email" }) },
      workspace,
    );
    const sourceTicket = await createTicket(workspace, source.id, "Laptop will not boot");
    const tagResponse = await request(
      "/tags",
      { method: "POST", body: JSON.stringify({ name: "vip", color: "blue" }) },
      workspace,
    );
    const tag = ((await tagResponse.json()) as { tag: { id: string } }).tag;
    await env.DB.prepare("INSERT INTO customer_tags (organization_id, customer_id, tag_id) VALUES (?, ?, ?)")
      .bind(workspace.organizationId, source.id, tag.id)
      .run();

    const response = await request(
      `/customers/${target.id}/merge`,
      { method: "POST", body: JSON.stringify({ sourceCustomerId: source.id }) },
      workspace,
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { movedTickets: number }).toMatchObject({ movedTickets: 1 });
    const detail = await readCustomer(workspace, target.id);
    expect(detail.identities.map((identity) => identity.value).sort()).toEqual([
      "jordan@home.test",
      "jordan@work.test",
    ]);
    expect(detail.identities.filter((identity) => identity.isPrimary)).toHaveLength(1);
    expect(detail.identities.find((identity) => identity.value === "jordan@home.test")?.source).toBe("merge");
    expect(detail.tickets.map((ticket) => ticket.id)).toContain(sourceTicket.id);
    expect(detail.customer.notes).toContain("Prefers email");

    const gone = await request(`/customers/${source.id}`, {}, workspace);
    expect(gone.status).toBe(404);
    const movedMessages = await env.DB.prepare(
      "SELECT count(*) AS count FROM messages WHERE organization_id = ? AND author_customer_id = ?",
    )
      .bind(workspace.organizationId, source.id)
      .first<{ count: number }>();
    expect(movedMessages?.count).toBe(0);
    const movedTags = await env.DB.prepare(
      "SELECT count(*) AS count FROM customer_tags WHERE organization_id = ? AND customer_id = ?",
    )
      .bind(workspace.organizationId, target.id)
      .first<{ count: number }>();
    expect(movedTags?.count).toBe(1);
    const logged = await env.DB.prepare(
      "SELECT metadata FROM activity_logs WHERE organization_id = ? AND event_type = 'customer.merged'",
    )
      .bind(workspace.organizationId)
      .first<{ metadata: string }>();
    expect(JSON.parse(logged!.metadata)).toMatchObject({ sourceEmail: "jordan@home.test", movedTickets: 1 });

    const search = await request("/customers?q=jordan@home.test", {}, workspace);
    const found = (await search.json()) as { customers: Array<{ id: string }> };
    expect(found.customers.map((row) => row.id)).toEqual([target.id]);
  });

  it("refuses a merge from an agent, across tenants, and while an erasure is queued", async () => {
    const workspace = await signup("identity-merge-guard");
    const other = await signup("identity-merge-other");
    const target = await createCustomer(workspace, "Target", "merge-target@example.test");
    const source = await createCustomer(workspace, "Source", "merge-source@example.test");
    const foreign = await createCustomer(other, "Foreign", "merge-foreign@example.test");

    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();
    const asAgent = await request(
      `/customers/${target.id}/merge`,
      { method: "POST", body: JSON.stringify({ sourceCustomerId: source.id }) },
      workspace,
    );
    expect(asAgent.status).toBe(403);
    await env.DB.prepare("UPDATE organization_memberships SET role = 'owner' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();

    const crossTenant = await request(
      `/customers/${target.id}/merge`,
      { method: "POST", body: JSON.stringify({ sourceCustomerId: foreign.id }) },
      workspace,
    );
    expect(crossTenant.status).toBe(404);

    const itself = await request(
      `/customers/${target.id}/merge`,
      { method: "POST", body: JSON.stringify({ sourceCustomerId: target.id }) },
      workspace,
    );
    expect(itself.status).toBe(400);

    await request(
      `/privacy/customers/${source.id}/erasure`,
      { method: "POST", body: JSON.stringify({ acknowledge: true }) },
      workspace,
    );
    const blocked = await request(
      `/customers/${target.id}/merge`,
      { method: "POST", body: JSON.stringify({ sourceCustomerId: source.id }) },
      workspace,
    );
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("merge_blocked_by_erasure");
  });

  it("exports identities and erases mail captured for every one of them", async () => {
    const workspace = await signup("identity-privacy");
    const customer = await createCustomer(workspace, "Kai", "kai-primary@example.test");
    await request(
      `/customers/${customer.id}/identities`,
      { method: "POST", body: JSON.stringify({ email: "kai-alias@example.test" }) },
      workspace,
    );
    for (const address of ["kai-primary@example.test", "kai-alias@example.test"])
      await env.DB.prepare(
        "INSERT INTO mail_captures (id, organization_id, to_address, from_address, subject, text, created_at) VALUES (?, ?, ?, 'support@example.test', 'Hello', 'Body', ?)",
      )
        .bind(`cap_${address}`, workspace.organizationId, address, Date.now())
        .run();

    const exported = (await (
      await request(`/privacy/customers/${customer.id}/export`, {}, workspace)
    ).json()) as { identities: Array<{ value: string; isPrimary: boolean }> };
    expect(exported.identities.map((identity) => identity.value).sort()).toEqual([
      "kai-alias@example.test",
      "kai-primary@example.test",
    ]);

    await processCustomerErasure(env as AppBindings, workspace.organizationId, customer.id);

    const captures = await env.DB.prepare(
      "SELECT count(*) AS count FROM mail_captures WHERE organization_id = ?",
    )
      .bind(workspace.organizationId)
      .first<{ count: number }>();
    expect(captures?.count).toBe(0);
  });

  it("gives the oldest of two case-only duplicate customers the backfilled identity", async () => {
    const workspace = await signup("identity-backfill-duplicate");
    const migration = __D1_MIGRATIONS__.find((entry) => entry.name.includes("0007_customer_identities"));
    const backfill = migration?.queries.find((query) => query.includes("INSERT OR IGNORE INTO `customer_identities`"));
    expect(backfill).toBeDefined();
    // `customers_organization_email_uidx` is case-sensitive, so an upgraded
    // database can hold both spellings of one address.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO customers (id, organization_id, name, email, normalized_search, created_at, updated_at) VALUES ('cus_dupe_old', ?, 'Older', 'Dup@example.test', 'older', ?, ?)",
      ).bind(workspace.organizationId, now - 60_000, now - 60_000),
      env.DB.prepare(
        "INSERT INTO customers (id, organization_id, name, email, normalized_search, created_at, updated_at) VALUES ('cus_dupe_new', ?, 'Newer', 'dup@example.test', 'newer', ?, ?)",
      ).bind(workspace.organizationId, now, now),
    ]);

    await env.DB.prepare(backfill!).run();

    const rows = await env.DB.prepare(
      "SELECT customer_id AS customerId FROM customer_identities WHERE organization_id = ? AND value = 'dup@example.test'",
    )
      .bind(workspace.organizationId)
      .all<{ customerId: string }>();
    expect(rows.results.map((row) => row.customerId)).toEqual(["cus_dupe_old"]);
    // The loser keeps its record and its tickets; an admin folds it with Merge.
    const listed = await request("/customers?q=newer", {}, workspace);
    expect(((await listed.json()) as { customers: Array<{ id: string }> }).customers.map((row) => row.id)).toEqual([
      "cus_dupe_new",
    ]);
  });
});
