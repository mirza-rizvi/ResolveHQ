import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../db";
import { tickets } from "../db/schema";
import type { AppBindings, TenantContext } from "../types";
import { statusTimestamps, type TicketChanges } from "./service";

/** Bounded, set-based writes: twenty tickets never become twenty authentication/assignment reads. */
export async function applyBulkUpdate(env: AppBindings, tenant: TenantContext, ids: string[], changes: TicketChanges) {
  const current = await createDb(env.DB)
    .select()
    .from(tickets)
    .where(and(eq(tickets.organizationId, tenant.organizationId), inArray(tickets.id, ids)));
  const now = new Date();
  const requested = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
  const next = current.map((row) => ({ ...row, ...requested, ...statusTimestamps(row, changes.status, now) }));
  const input = JSON.stringify(
    next.map((row) => ({
      ...row,
      resolvedAt: row.resolvedAt?.getTime() ?? null,
      closedAt: row.closedAt?.getTime() ?? null,
      waitingSince: row.waitingSince?.getTime() ?? null,
    })),
  );
  const changed = await env.DB.prepare(
    `UPDATE tickets SET
    status = json_extract(j.value, '$.status'), priority = json_extract(j.value, '$.priority'),
    assigned_user_id = json_extract(j.value, '$.assignedUserId'), assigned_team_id = json_extract(j.value, '$.assignedTeamId'),
    resolved_at = json_extract(j.value, '$.resolvedAt'), closed_at = json_extract(j.value, '$.closedAt'), waiting_since = json_extract(j.value, '$.waitingSince'),
    updated_at = ?, version = tickets.version + 1 FROM json_each(?) j
    WHERE tickets.id = json_extract(j.value, '$.id') AND tickets.organization_id = ? AND tickets.version = json_extract(j.value, '$.version') RETURNING id`,
  )
    .bind(now.getTime(), input, tenant.organizationId)
    .all<{ id: string }>();
  const updated = new Set(changed.results.map((row) => row.id));
  const assignments: Array<{ id: string; number: number }> = [];
  const events: Array<{ id: string; type: string; metadata: unknown }> = [];
  for (const row of current) {
    if (!updated.has(row.id)) continue;
    for (const [field, type] of [
      ["assignedUserId", "assigned"],
      ["status", "status_changed"],
      ["priority", "priority_changed"],
    ] as const) {
      if (changes[field] !== undefined && changes[field] !== row[field]) {
        events.push({ id: row.id, type: `ticket.${type}`, metadata: { from: row[field], to: changes[field] } });
        if (field === "assignedUserId") assignments.push({ id: row.id, number: row.number });
      }
    }
    events.push({ id: row.id, type: "ticket.bulk_updated", metadata: requested });
  }
  const statements = [
    env.DB.prepare(
      `INSERT INTO activity_logs (id, organization_id, ticket_id, actor_user_id, event_type, entity_type, entity_id, metadata, request_id, created_at)
    SELECT 'act_' || lower(hex(randomblob(16))), ?, json_extract(value,'$.id'), ?, json_extract(value,'$.type'), 'ticket', json_extract(value,'$.id'), json_extract(value,'$.metadata'), ?, ? FROM json_each(?)`,
    ).bind(tenant.organizationId, tenant.userId, tenant.requestId, now.getTime(), JSON.stringify(events)),
  ];
  if (assignments.length) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO ticket_assignments (id, organization_id, ticket_id, assigned_to_user_id, assigned_by_user_id, created_at)
      SELECT 'asn_' || lower(hex(randomblob(16))), ?, json_extract(value,'$.id'), ?, ?, ? FROM json_each(?)`,
      ).bind(
        tenant.organizationId,
        changes.assignedUserId ?? null,
        tenant.userId,
        now.getTime(),
        JSON.stringify(assignments),
      ),
    );
    if (changes.assignedUserId && changes.assignedUserId !== tenant.userId)
      statements.push(
        env.DB.prepare(
          `INSERT INTO notifications (id, organization_id, user_id, ticket_id, type, title, created_at)
      SELECT 'ntf_' || lower(hex(randomblob(16))), ?, ?, json_extract(value,'$.id'), 'ticket.assigned', 'Ticket #' || json_extract(value,'$.number') || ' was assigned to you', ? FROM json_each(?)`,
        ).bind(tenant.organizationId, changes.assignedUserId, now.getTime(), JSON.stringify(assignments)),
      );
  }
  await env.DB.batch(statements);
  const found = new Set(current.map((row) => row.id));
  return {
    updated: updated.size,
    skipped: [...new Set(ids)]
      .filter((id) => !updated.has(id))
      .map((ticketId) => ({ ticketId, reason: found.has(ticketId) ? "ticket_version_conflict" : "ticket_not_found" })),
  };
}
