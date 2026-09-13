import { HttpError } from "resolve-server/http/errors";
import { newId, normalizeSearch } from "resolve-server/lib/id";
import { listIdentities } from "./identities";
import type { Customer } from "resolve-server/db/schema";

/**
 * Folds one customer into another: identities, tickets, messages and tags move
 * to the target, the source row disappears, and the merge is recorded. It runs
 * as a single batch so a partial merge cannot leave tickets pointing at a
 * deleted customer. Irreversible.
 */
export async function mergeCustomers(
  database: D1Database,
  organizationId: string,
  target: Customer,
  source: Customer,
  actorUserId: string,
  requestId: string,
) {
  const blocked = await database
    .prepare(
      "SELECT id FROM maintenance_tasks WHERE kind = 'erasure' AND organization_id = ? AND customer_id IN (?, ?) AND status <> 'completed' LIMIT 1",
    )
    .bind(organizationId, target.id, source.id)
    .first<{ id: string }>();
  if (blocked)
    throw new HttpError(
      409,
      "merge_blocked_by_erasure",
      "An erasure is queued for one of these customers. Wait for it to finish before merging.",
    );

  const identities = [
    ...(await listIdentities(database, organizationId, target.id)),
    ...(await listIdentities(database, organizationId, source.id)),
  ];
  const company = target.company ?? source.company;
  const phone = target.phone ?? source.phone;
  const notes = [target.notes, source.notes].filter(Boolean).join("\n\n") || null;
  const lastContactedAt = Math.max(
    target.lastContactedAt ? target.lastContactedAt.getTime() : 0,
    source.lastContactedAt ? source.lastContactedAt.getTime() : 0,
  );
  const now = Date.now();

  // The log is written first so its ticket count is taken inside the same
  // transaction, before the tickets are re-pointed; the returned count comes
  // from the update itself, so neither can drift from what actually moved.
  const results = await database.batch([
    database
      .prepare(
        "INSERT INTO activity_logs (id, organization_id, actor_user_id, event_type, entity_type, entity_id, metadata, request_id, created_at) VALUES (?, ?, ?, 'customer.merged', 'customer', ?, json_object('sourceId', ?, 'sourceEmail', ?, 'movedTickets', (SELECT count(*) FROM tickets WHERE organization_id = ? AND customer_id = ?)), ?, ?)",
      )
      .bind(
        newId("act"),
        organizationId,
        actorUserId,
        target.id,
        source.id,
        source.email,
        organizationId,
        source.id,
        requestId,
        now,
      ),
    database
      .prepare(
        "UPDATE customer_identities SET customer_id = ?, is_primary = 0, source = 'merge', updated_at = ? WHERE organization_id = ? AND customer_id = ?",
      )
      .bind(target.id, now, organizationId, source.id),
    database
      .prepare(
        "UPDATE tickets SET customer_id = ?, version = version + 1, updated_at = ? WHERE organization_id = ? AND customer_id = ?",
      )
      .bind(target.id, now, organizationId, source.id),
    database
      .prepare("UPDATE messages SET author_customer_id = ? WHERE organization_id = ? AND author_customer_id = ?")
      .bind(target.id, organizationId, source.id),
    database
      .prepare(
        "INSERT OR IGNORE INTO customer_tags (organization_id, customer_id, tag_id) SELECT organization_id, ?, tag_id FROM customer_tags WHERE organization_id = ? AND customer_id = ?",
      )
      .bind(target.id, organizationId, source.id),
    database
      .prepare("DELETE FROM customer_tags WHERE organization_id = ? AND customer_id = ?")
      .bind(organizationId, source.id),
    database
      .prepare(
        "UPDATE customers SET normalized_search = ?, notes = ?, company = ?, phone = ?, last_contacted_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?",
      )
      .bind(
        normalizeSearch(target.name, ...identities.map((identity) => identity.value), company, phone),
        notes,
        company,
        phone,
        lastContactedAt || null,
        now,
        organizationId,
        target.id,
      ),
    database.prepare("DELETE FROM customers WHERE organization_id = ? AND id = ?").bind(organizationId, source.id),
  ]);
  return { movedTickets: results[2]?.meta.changes ?? 0 };
}
