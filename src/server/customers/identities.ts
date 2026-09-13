import { newId, normalizeSearch } from "../lib/id";

/** How an address became an identity; `inbound_from` is the only automatic one. */
export type IdentitySource = "backfill" | "inbound_from" | "manual" | "merge";

export interface IdentityRow {
  id: string;
  customerId: string;
  value: string;
  isPrimary: boolean;
  source: string;
  createdAt: number;
}

export function normalizeIdentity(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Every identity row for the given addresses, tenant-scoped. Inbound threading
 * reads this to learn which customers a From/Reply-To pair belongs to.
 */
export async function findCustomerByIdentities(
  database: D1Database,
  organizationId: string,
  values: string[],
): Promise<Array<{ customerId: string; value: string }>> {
  const wanted = [...new Set(values.map(normalizeIdentity).filter(Boolean))];
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => "?").join(",");
  const rows = await database
    .prepare(
      `SELECT DISTINCT customer_id AS customerId, value FROM customer_identities WHERE organization_id = ? AND kind = 'email' AND value IN (${placeholders})`,
    )
    .bind(organizationId, ...wanted)
    .all<{ customerId: string; value: string }>();
  return rows.results;
}

export async function listIdentities(database: D1Database, organizationId: string, customerId: string) {
  const rows = await database
    .prepare(
      "SELECT id, customer_id AS customerId, value, is_primary AS isPrimary, source, created_at AS createdAt FROM customer_identities WHERE organization_id = ? AND customer_id = ? ORDER BY is_primary DESC, created_at, id",
    )
    .bind(organizationId, customerId)
    .all<Omit<IdentityRow, "isPrimary"> & { isPrimary: number }>();
  return rows.results.map((row) => ({ ...row, isPrimary: Boolean(row.isPrimary) }));
}

/** The customer that already owns an address, or null when it is free. */
export async function identityOwner(database: D1Database, organizationId: string, value: string) {
  const row = await database
    .prepare(
      "SELECT customer_id AS customerId FROM customer_identities WHERE organization_id = ? AND kind = 'email' AND value = ? LIMIT 1",
    )
    .bind(organizationId, normalizeIdentity(value))
    .first<{ customerId: string }>();
  return row?.customerId ?? null;
}

export interface NewCustomerInput {
  name: string;
  email: string;
  company?: string | null;
  phone?: string | null;
  notes?: string | null;
  lastContactedAt?: number | null;
}

/**
 * Creates a customer and its primary identity in one batch so a customer can
 * never exist without the address threading resolves it by.
 */
export async function createCustomerWithIdentity(
  database: D1Database,
  organizationId: string,
  input: NewCustomerInput,
  source: IdentitySource,
) {
  const id = newId("cus");
  const email = normalizeIdentity(input.email);
  const now = Date.now();
  await database.batch([
    database
      .prepare(
        "INSERT INTO customers (id, organization_id, name, email, company, phone, notes, normalized_search, last_contacted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        organizationId,
        input.name,
        email,
        input.company ?? null,
        input.phone ?? null,
        input.notes ?? null,
        normalizeSearch(input.name, email, input.company, input.phone),
        input.lastContactedAt ?? null,
        now,
        now,
      ),
    database
      .prepare(
        "INSERT INTO customer_identities (id, organization_id, customer_id, kind, value, is_primary, source, created_at, updated_at) VALUES (?, ?, ?, 'email', ?, 1, ?, ?, ?)",
      )
      .bind(newId("cid"), organizationId, id, email, source, now, now),
  ]);
  return { id, email };
}

/**
 * Points the customer at a new primary address. The previous primary stays as
 * a secondary identity so replies to the old address still thread.
 */
export async function setPrimaryEmail(
  database: D1Database,
  organizationId: string,
  customer: { id: string; name: string; company: string | null; phone: string | null },
  email: string,
) {
  const value = normalizeIdentity(email);
  const now = Date.now();
  await database.batch([
    database
      .prepare("UPDATE customer_identities SET is_primary = 0, updated_at = ? WHERE organization_id = ? AND customer_id = ?")
      .bind(now, organizationId, customer.id),
    database
      .prepare(
        "INSERT INTO customer_identities (id, organization_id, customer_id, kind, value, is_primary, source, created_at, updated_at) VALUES (?, ?, ?, 'email', ?, 1, 'manual', ?, ?) ON CONFLICT(organization_id, kind, value) DO UPDATE SET is_primary = 1, updated_at = excluded.updated_at",
      )
      .bind(newId("cid"), organizationId, customer.id, value, now, now),
    database
      .prepare("UPDATE customers SET email = ?, normalized_search = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
      .bind(
        value,
        normalizeSearch(customer.name, value, customer.company, customer.phone),
        now,
        organizationId,
        customer.id,
      ),
  ]);
}
