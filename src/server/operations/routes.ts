import { and, desc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { recordActivity } from "../activity/service";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { notifications, savedViews, teamMembers, teams, ticketDrafts, ticketReadStates } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { newId } from "../lib/id";
import { applyTicketUpdate, type TicketChanges } from "../tickets/service";
import type { HonoEnv } from "../types";
import { ticketPriorities, ticketStatuses } from "../../shared/domain";

const draftInput = z.object({
  body: z.string().max(100_000),
  kind: z.enum(["message", "internal_note"]).default("message"),
  revision: z.number().int().nonnegative(),
});

const viewFilters = z.object({
  status: z.enum(ticketStatuses).optional(),
  priority: z.enum(ticketPriorities).optional(),
  assignee: z.enum(["me", "unassigned", "any"]).optional(),
  tagId: z.string().max(80).optional(),
}).strict();

export const operationRoutes = new Hono<HonoEnv>();
operationRoutes.use("*", requireAuth);

operationRoutes.get("/dashboard", async (context) => {
  const tenant = context.get("tenant");
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const metrics = await context.env.DB.prepare(
    "SELECT sum(status = 'open') AS openTickets, sum(assigned_user_id IS NULL AND status NOT IN ('resolved','closed')) AS unassignedTickets, sum(status = 'waiting_customer') AS waitingForCustomer, sum(priority = 'urgent' AND status NOT IN ('resolved','closed')) AS urgentTickets, sum(status = 'resolved' AND resolved_at >= ?) AS resolvedToday FROM tickets WHERE organization_id = ?",
  ).bind(startOfToday.getTime(), tenant.organizationId).first<Record<string, number | null>>();
  const recentTickets = await context.env.DB.prepare(
    "SELECT t.id, t.number, t.subject, t.status, t.priority, t.updated_at AS updatedAt, c.name AS customerName FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE t.organization_id = ? ORDER BY t.updated_at DESC, t.id DESC LIMIT 8",
  ).bind(tenant.organizationId).all();
  const recentActivity = await context.env.DB.prepare(
    "SELECT a.id, a.event_type AS eventType, a.ticket_id AS ticketId, a.created_at AS createdAt, u.name AS actorName FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 12",
  ).bind(tenant.organizationId).all();
  return context.json({
    metrics: {
      openTickets: metrics?.openTickets ?? 0,
      unassignedTickets: metrics?.unassignedTickets ?? 0,
      waitingForCustomer: metrics?.waitingForCustomer ?? 0,
      urgentTickets: metrics?.urgentTickets ?? 0,
      resolvedToday: metrics?.resolvedToday ?? 0,
    },
    recentTickets: recentTickets.results,
    recentActivity: recentActivity.results,
  });
});

operationRoutes.get("/notifications", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB).select().from(notifications).where(and(eq(notifications.organizationId, tenant.organizationId), eq(notifications.userId, tenant.userId))).orderBy(desc(notifications.createdAt)).limit(50);
  return context.json({ notifications: rows, unread: rows.filter((item) => !item.readAt).length });
});

operationRoutes.post("/notifications/:id/read", async (context) => {
  const tenant = context.get("tenant");
  const result = await createDb(context.env.DB).update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, context.req.param("id")), eq(notifications.organizationId, tenant.organizationId), eq(notifications.userId, tenant.userId)));
  if (!result.meta.changes) throw new HttpError(404, "notification_not_found", "Notification not found.");
  return context.json({ ok: true });
});

operationRoutes.get("/tickets/:ticketId/draft", async (context) => {
  const tenant = context.get("tenant");
  await assertTicket(context.env.DB, tenant.organizationId, context.req.param("ticketId"));
  const draft = await createDb(context.env.DB).select().from(ticketDrafts).where(and(eq(ticketDrafts.organizationId, tenant.organizationId), eq(ticketDrafts.ticketId, context.req.param("ticketId")), eq(ticketDrafts.userId, tenant.userId))).limit(1).then((rows) => rows[0] ?? null);
  return context.json({ draft });
});

operationRoutes.put("/tickets/:ticketId/draft", validate("json", draftInput), async (context) => {
  const tenant = context.get("tenant");
  const ticketId = context.req.param("ticketId");
  const input = context.req.valid("json");
  await assertTicket(context.env.DB, tenant.organizationId, ticketId);
  const current = await context.env.DB.prepare("SELECT revision FROM ticket_drafts WHERE organization_id = ? AND ticket_id = ? AND user_id = ?").bind(tenant.organizationId, ticketId, tenant.userId).first<{ revision: number }>();
  if (current && input.revision < current.revision) throw new HttpError(409, "draft_revision_conflict", "A newer draft already exists.");
  const nextRevision = Math.max(input.revision, current?.revision ?? 0) + 1;
  await createDb(context.env.DB).insert(ticketDrafts).values({ organizationId: tenant.organizationId, ticketId, userId: tenant.userId, body: input.body, kind: input.kind, revision: nextRevision, updatedAt: new Date() }).onConflictDoUpdate({ target: [ticketDrafts.ticketId, ticketDrafts.userId], set: { body: input.body, kind: input.kind, revision: nextRevision, updatedAt: new Date() } });
  return context.json({ draft: { body: input.body, kind: input.kind, revision: nextRevision } });
});

operationRoutes.delete("/tickets/:ticketId/draft", async (context) => {
  const tenant = context.get("tenant");
  await createDb(context.env.DB).delete(ticketDrafts).where(and(eq(ticketDrafts.organizationId, tenant.organizationId), eq(ticketDrafts.ticketId, context.req.param("ticketId")), eq(ticketDrafts.userId, tenant.userId)));
  return context.body(null, 204);
});

operationRoutes.post("/tickets/:ticketId/read", async (context) => {
  const tenant = context.get("tenant");
  const ticketId = context.req.param("ticketId");
  await assertTicket(context.env.DB, tenant.organizationId, ticketId);
  await createDb(context.env.DB).insert(ticketReadStates).values({ organizationId: tenant.organizationId, ticketId, userId: tenant.userId, lastReadAt: new Date() }).onConflictDoUpdate({ target: [ticketReadStates.ticketId, ticketReadStates.userId], set: { lastReadAt: new Date() } });
  return context.json({ ok: true });
});

operationRoutes.get("/views", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB).select().from(savedViews).where(and(eq(savedViews.organizationId, tenant.organizationId), or(eq(savedViews.visibility, "shared"), eq(savedViews.ownerUserId, tenant.userId)))).orderBy(desc(savedViews.updatedAt));
  return context.json({ views: rows });
});

operationRoutes.post("/views", validate("json", z.object({ name: z.string().trim().min(1).max(80), visibility: z.enum(["personal", "shared"]).default("personal"), filters: viewFilters })), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  if (input.visibility === "shared" && tenant.role === "agent") throw new HttpError(403, "forbidden", "Only admins can create shared views.");
  const id = newId("viw");
  await createDb(context.env.DB).insert(savedViews).values({ id, organizationId: tenant.organizationId, ownerUserId: tenant.userId, name: input.name, visibility: input.visibility, filters: input.filters });
  return context.json({ view: { id, ...input } }, 201);
});

operationRoutes.get("/teams", async (context) => {
  const tenant = context.get("tenant");
  const rows = await context.env.DB.prepare("SELECT t.id, t.name, count(tm.user_id) AS memberCount FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.organization_id = t.organization_id WHERE t.organization_id = ? GROUP BY t.id ORDER BY t.name").bind(tenant.organizationId).all();
  return context.json({ teams: rows.results });
});

operationRoutes.post("/teams", requireRole("admin"), validate("json", z.object({ name: z.string().trim().min(1).max(80), userIds: z.array(z.string()).max(50).default([]) })), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const id = newId("tem");
  const db = createDb(context.env.DB);
  await db.insert(teams).values({ id, organizationId: tenant.organizationId, name: input.name });
  for (const userId of input.userIds) {
    const member = await context.env.DB.prepare("SELECT 1 FROM organization_memberships WHERE organization_id = ? AND user_id = ? AND disabled_at IS NULL").bind(tenant.organizationId, userId).first();
    if (!member) throw new HttpError(404, "member_not_found", "A selected team member was not found.");
    await db.insert(teamMembers).values({ organizationId: tenant.organizationId, teamId: id, userId }).onConflictDoNothing();
  }
  return context.json({ team: { id, ...input } }, 201);
});

operationRoutes.post("/tickets/bulk", validate("json", z.object({ ticketIds: z.array(z.string()).min(1).max(20), status: z.enum(ticketStatuses).optional(), priority: z.enum(ticketPriorities).optional(), assignedUserId: z.string().nullable().optional() })), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  if (input.status === undefined && input.priority === undefined && input.assignedUserId === undefined) throw new HttpError(400, "empty_bulk_action", "Choose at least one change.");
  const db = createDb(context.env.DB);
  const changes: TicketChanges = { status: input.status, priority: input.priority, assignedUserId: input.assignedUserId };
  const skipped: Array<{ ticketId: string; reason: string }> = [];
  let updated = 0;
  for (const ticketId of input.ticketIds) {
    try {
      await applyTicketUpdate(context.env, tenant, ticketId, changes);
    } catch (error) {
      // A ticket that is gone (or belongs to another workspace) is reported and
      // skipped; every other failure, such as an assignee outside this
      // workspace, fails the whole request instead of silently doing less.
      if (error instanceof HttpError && error.status === 404 && error.code === "ticket_not_found") {
        skipped.push({ ticketId, reason: error.code });
        continue;
      }
      throw error;
    }
    await recordActivity(db, tenant, { ticketId, eventType: "ticket.bulk_updated", entityType: "ticket", entityId: ticketId, metadata: { status: input.status, priority: input.priority, assignedUserId: input.assignedUserId } });
    updated += 1;
  }
  return context.json({ updated, skipped });
});

operationRoutes.get("/dev-mail", requireRole("admin"), async (context) => {
  if (context.env.DEV_MAIL_MODE !== "capture" || context.env.RESEND_API_KEY) throw new HttpError(404, "not_found", "Mail capture is not enabled.");
  const tenant = context.get("tenant");
  const me = await context.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(tenant.userId).first<{ email: string }>();
  const rows = await context.env.DB.prepare(
    "SELECT id, to_address AS toAddress, from_address AS fromAddress, subject, text, html, headers, created_at AS createdAt FROM mail_captures WHERE organization_id = ? OR (organization_id IS NULL AND to_address = ?) ORDER BY created_at DESC LIMIT 50",
  ).bind(tenant.organizationId, me?.email ?? "").all();
  return context.json({ captures: rows.results.map((row) => ({ ...row, headers: JSON.parse(String(row.headers)) })) });
});

async function assertTicket(database: D1Database, organizationId: string, ticketId: string) {
  const ticket = await database.prepare("SELECT 1 FROM tickets WHERE organization_id = ? AND id = ?").bind(organizationId, ticketId).first();
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
}
