import { eraseTicket } from "../privacy/service";
import type { AppBindings } from "../types";

const dayMs = 86_400_000;
/** Cap per cron invocation so a large backlog cannot exceed worker limits; the next run continues. */
const batchLimit = 10;
const maxDays = 3650;

/**
 * Parses the retention window. Only whole days between 1 and 3650 enable the
 * sweep; anything else (unset, zero, malformed) keeps retention off so data is
 * never deleted by surprise.
 */
export function parseRetentionDays(raw: string | undefined): number | null {
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > maxDays) return null;
  return days;
}

/**
 * Deletes resolved and closed tickets whose last activity is older than the
 * retention window, reusing the customer-erasure path so messages, attachments
 * (including their R2 objects), read states, drafts, tags, and search rows all
 * go together, and in-flight mail for the ticket is terminalized first.
 */
export async function enforceTicketRetention(env: AppBindings, days = parseRetentionDays(env.TICKET_RETENTION_DAYS)) {
  if (!days) return 0;
  const cutoff = Date.now() - days * dayMs;
  const rows = await env.DB.prepare(
    "SELECT id, organization_id AS organizationId FROM tickets WHERE status IN ('resolved','closed') AND updated_at < ? ORDER BY updated_at LIMIT ?",
  )
    .bind(cutoff, batchLimit)
    .all<{ id: string; organizationId: string }>();
  let deleted = 0;
  for (const row of rows.results) {
    const result = await eraseTicket(env.DB, env.ATTACHMENTS, row.organizationId, row.id);
    if (result.deleted) deleted += 1;
  }
  return deleted;
}
