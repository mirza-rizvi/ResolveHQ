import { and, eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createDb } from "../db";
import { tickets } from "../db/schema";
import type { AppBindings } from "../types";

/** A ticket snoozed past this is a mistake, not a use case. */
export const MAX_SNOOZE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Clears a snooze and shifts the SLA targets forward by the time actually spent snoozed,
 * which is how the clock pauses rather than merely being ignored.
 *
 * The shift is a plain duration add: it does not re-run business-hours arithmetic, so a
 * ticket snoozed across a change to the workspace schedule keeps targets computed under
 * the old one. Accepted — re-deriving per row would not fit the cron's CPU budget.
 */
export function wakeAssignments(now: number) {
  const elapsed = sql`(${now} - COALESCE(${tickets.snoozeStartedAt}, ${now}))`;
  return {
    snoozedUntil: null,
    snoozeStartedAt: null,
    snoozeReason: null,
    snoozedTotalMs: sql`${tickets.snoozedTotalMs} + ${elapsed}`,
    firstResponseDueAt: sql`CASE WHEN ${tickets.firstResponseDueAt} IS NULL THEN NULL ELSE ${tickets.firstResponseDueAt} + ${elapsed} END`,
    resolutionDueAt: sql`CASE WHEN ${tickets.resolutionDueAt} IS NULL THEN NULL ELSE ${tickets.resolutionDueAt} + ${elapsed} END`,
  };
}

/**
 * Wakes one ticket early because its customer replied. This is the behaviour that makes
 * snooze safe to use: the agent deferred the ticket, not the conversation.
 *
 * A no-op when the ticket is not snoozed, so the inbound path can call it unconditionally.
 */
export async function wakeOnCustomerReply(env: AppBindings, organizationId: string, ticketId: string) {
  const result = await createDb(env.DB)
    .update(tickets)
    .set(wakeAssignments(Date.now()))
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.organizationId, organizationId),
        isNotNull(tickets.snoozedUntil),
      ),
    );
  return result.meta.changes > 0;
}
