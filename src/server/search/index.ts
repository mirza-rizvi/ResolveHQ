/**
 * The single definition of how ResolveHQ reads from and writes to the ticket
 * full-text index. Every writer (ticket routes, customer renames, inbound mail)
 * has to build the same document, otherwise a later refresh silently drops the
 * parts an earlier writer included.
 */

const searchContentQuery =
  "SELECT t.normalized_search || ' ' || c.normalized_search || ' ' || coalesce((SELECT group_concat(m.normalized_search, ' ') FROM messages m WHERE m.organization_id = t.organization_id AND m.ticket_id = t.id), '') || ' ' || coalesce((SELECT group_concat(g.name, ' ') FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id AND g.organization_id = tt.organization_id WHERE tt.organization_id = t.organization_id AND tt.ticket_id = t.id), '') AS content FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE t.organization_id = ? AND t.id = ?";

/**
 * Turns user input into an FTS5 prefix query. Returns null when nothing
 * searchable survives sanitisation so callers can answer with an empty result
 * instead of running an unfiltered query.
 */
export function toFtsQuery(value: string): string | null {
  const terms = value
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9@._-]/g, ""))
    .filter(Boolean)
    .slice(0, 8);
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ") : null;
}

export async function refreshTicketSearch(
  database: D1Database,
  organizationId: string,
  ticketId: string,
): Promise<void> {
  const mapped = await database
    .prepare(
      "SELECT r.row_id AS rowId, f.ticket_id AS ticketId, f.organization_id AS organizationId FROM ticket_search_rows r LEFT JOIN ticket_search f ON f.rowid = r.row_id WHERE r.organization_id = ? AND r.ticket_id = ?",
    )
    .bind(organizationId, ticketId)
    .first<{ rowId: number; ticketId: string | null; organizationId: string | null }>();
  const stable = mapped?.ticketId === ticketId && mapped?.organizationId === organizationId;
  const statements = stable
    ? [database.prepare("DELETE FROM ticket_search WHERE rowid = ?").bind(mapped.rowId)]
    : [
        // A one-time repair also supports rows refreshed by an older Worker during rollout.
        database
          .prepare("DELETE FROM ticket_search WHERE organization_id = ? AND ticket_id = ?")
          .bind(organizationId, ticketId),
        database
          .prepare(
            "INSERT INTO ticket_search_rows (row_id, organization_id, ticket_id) VALUES (max(coalesce((SELECT max(rowid) FROM ticket_search),0), coalesce((SELECT max(row_id) FROM ticket_search_rows),0)) + 1, ?, ?) ON CONFLICT(organization_id, ticket_id) DO UPDATE SET row_id = excluded.row_id",
          )
          .bind(organizationId, ticketId),
      ];
  statements.push(
    database
      .prepare(
        `INSERT INTO ticket_search (rowid, organization_id, ticket_id, content) SELECT (SELECT row_id FROM ticket_search_rows WHERE organization_id = ? AND ticket_id = ?), ?, ?, content FROM (${searchContentQuery})`,
      )
      .bind(organizationId, ticketId, organizationId, ticketId, organizationId, ticketId),
  );
  await database.batch(statements);
}
