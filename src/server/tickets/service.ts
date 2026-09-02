import { and, eq, isNull } from "drizzle-orm";
import { recordActivity } from "resolve-server/activity/service";
import { createDb } from "resolve-server/db";
import { notifications, organizationMemberships, teams, ticketAssignments, tickets } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { newId } from "resolve-server/lib/id";
import type { AppBindings, TenantContext } from "resolve-server/types";
import type { TicketPriority, TicketStatus } from "resolve-shared/domain";

export type Ticket = typeof tickets.$inferSelect;

export interface TicketChanges {
  status?: TicketStatus;
  priority?: TicketPriority;
  assignedUserId?: string | null;
  assignedTeamId?: string | null;
}

interface StatusTimestamps {
  resolvedAt: Date | null;
  closedAt: Date | null;
  waitingSince: Date | null;
}

/**
 * Derives the ticket lifecycle timestamps for a status transition. Closing a
 * ticket keeps the resolution time it already carried, and only a customer wait
 * keeps (or starts) the waiting clock.
 */
export function statusTimestamps(current: StatusTimestamps, next: TicketStatus | undefined, now: Date): StatusTimestamps {
  if (!next) return { resolvedAt: current.resolvedAt, closedAt: current.closedAt, waitingSince: current.waitingSince };
  if (next === "resolved") return { resolvedAt: now, closedAt: null, waitingSince: null };
  if (next === "closed") return { resolvedAt: current.resolvedAt, closedAt: now, waitingSince: null };
  if (next === "waiting_customer") return { resolvedAt: null, closedAt: null, waitingSince: current.waitingSince ?? now };
  return { resolvedAt: null, closedAt: null, waitingSince: null };
}

/**
 * The single tenant-safe path for ticket mutations. Both the ticket PATCH route
 * and the bulk operations route go through here so assignment validation,
 * optimistic locking, lifecycle timestamps, and the audit trail stay identical.
 */
export async function applyTicketUpdate(
  env: AppBindings,
  tenant: TenantContext,
  ticketId: string,
  requested: TicketChanges,
  options: { expectedVersion?: number } = {},
): Promise<Ticket> {
  // Callers may pass explicit undefined for untouched fields; drop them so the
  // update and the returned row never overwrite existing values with undefined.
  const changes = Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== undefined)) as TicketChanges;
  if (changes.assignedUserId) await assertActiveMember(env.DB, tenant.organizationId, changes.assignedUserId);
  if (changes.assignedTeamId) await assertTeam(env.DB, tenant.organizationId, changes.assignedTeamId);
  const db = createDb(env.DB);
  const [current] = await db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!current) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
    throw new HttpError(409, "ticket_version_conflict", "This ticket changed in another session. Refresh and try again.");
  }
  const now = new Date();
  const stamps = statusTimestamps(current, changes.status, now);
  const result = await db.update(tickets).set({ ...changes, ...stamps, updatedAt: now, version: current.version + 1 })
    .where(and(eq(tickets.id, current.id), eq(tickets.organizationId, tenant.organizationId), eq(tickets.version, current.version)));
  if (!result.meta.changes) throw new HttpError(409, "ticket_version_conflict", "This ticket changed in another session. Refresh and try again.");

  if (changes.assignedUserId !== undefined && changes.assignedUserId !== current.assignedUserId) {
    await db.insert(ticketAssignments).values({ id: newId("asn"), organizationId: tenant.organizationId, ticketId: current.id, assignedToUserId: changes.assignedUserId, assignedByUserId: tenant.userId });
    if (changes.assignedUserId && changes.assignedUserId !== tenant.userId) {
      await db.insert(notifications).values({ id: newId("ntf"), organizationId: tenant.organizationId, userId: changes.assignedUserId, ticketId: current.id, type: "ticket.assigned", title: `Ticket #${current.number} was assigned to you` });
    }
    await recordActivity(db, tenant, { ticketId: current.id, eventType: "ticket.assigned", entityType: "ticket", entityId: current.id, metadata: { from: current.assignedUserId, to: changes.assignedUserId } });
  }
  if (changes.status && changes.status !== current.status) {
    await recordActivity(db, tenant, { ticketId: current.id, eventType: "ticket.status_changed", entityType: "ticket", entityId: current.id, metadata: { from: current.status, to: changes.status } });
  }
  if (changes.priority && changes.priority !== current.priority) {
    await recordActivity(db, tenant, { ticketId: current.id, eventType: "ticket.priority_changed", entityType: "ticket", entityId: current.id, metadata: { from: current.priority, to: changes.priority } });
  }
  return { ...current, ...changes, ...stamps, updatedAt: now, version: current.version + 1 };
}

export async function assertActiveMember(database: D1Database, organizationId: string, userId: string) {
  const [member] = await createDb(database).select({ userId: organizationMemberships.userId }).from(organizationMemberships).where(and(
    eq(organizationMemberships.organizationId, organizationId),
    eq(organizationMemberships.userId, userId),
    isNull(organizationMemberships.disabledAt),
  )).limit(1);
  if (!member) throw new HttpError(404, "member_not_found", "Team member not found.");
}

export async function assertTeam(database: D1Database, organizationId: string, teamId: string) {
  const [team] = await createDb(database).select({ id: teams.id }).from(teams).where(and(eq(teams.organizationId, organizationId), eq(teams.id, teamId))).limit(1);
  if (!team) throw new HttpError(404, "team_not_found", "Team not found.");
}

export function preview(value: string) { return value.replace(/\s+/g, " ").trim().slice(0, 280); }

export async function refreshTicketSearch(database: D1Database, organizationId: string, ticketId: string) {
  const row = await database.prepare("SELECT t.normalized_search || ' ' || coalesce((SELECT group_concat(m.normalized_search, ' ') FROM messages m WHERE m.organization_id = t.organization_id AND m.ticket_id = t.id), '') || ' ' || coalesce((SELECT group_concat(g.name, ' ') FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id AND g.organization_id = tt.organization_id WHERE tt.organization_id = t.organization_id AND tt.ticket_id = t.id), '') AS content FROM tickets t WHERE t.organization_id = ? AND t.id = ?").bind(organizationId, ticketId).first<{ content: string }>();
  await database.batch([
    database.prepare("DELETE FROM ticket_search WHERE organization_id = ? AND ticket_id = ?").bind(organizationId, ticketId),
    database.prepare("INSERT INTO ticket_search (organization_id, ticket_id, content) VALUES (?, ?, ?)").bind(organizationId, ticketId, row?.content ?? ""),
  ]);
}
