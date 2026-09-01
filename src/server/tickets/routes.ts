import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, isNull, like, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { recordActivity } from "resolve-server/activity/service";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { attachments, customers, messages, organizationMemberships, tags, ticketAssignments, ticketTags, tickets, users } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { newId, normalizeSearch } from "resolve-server/lib/id";
import type { HonoEnv } from "resolve-server/types";
import { ticketPriorities, ticketStatuses } from "resolve-shared/domain";

const createTicketInput = z.object({
  customerId: z.string().min(1),
  subject: z.string().trim().min(1).max(240),
  message: z.string().trim().min(1).max(100_000),
  priority: z.enum(ticketPriorities).default("normal"),
  assignedUserId: z.string().optional().nullable(),
});

const updateTicketInput = z.object({
  status: z.enum(ticketStatuses).optional(),
  priority: z.enum(ticketPriorities).optional(),
  assignedUserId: z.string().optional().nullable(),
});

const messageInput = z.object({
  body: z.string().trim().min(1).max(100_000),
  kind: z.enum(["message", "internal_note"]).default("message"),
});

export const ticketRoutes = new Hono<HonoEnv>();
ticketRoutes.use("*", requireAuth);

ticketRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const status = context.req.query("status");
  const priority = context.req.query("priority");
  const assignee = context.req.query("assignee");
  const search = context.req.query("q")?.trim().toLowerCase();
  const db = createDb(context.env.DB);
  const rows = await db.select({
    id: tickets.id,
    number: tickets.number,
    subject: tickets.subject,
    status: tickets.status,
    priority: tickets.priority,
    assignedUserId: tickets.assignedUserId,
    assigneeName: users.name,
    customerId: customers.id,
    customerName: customers.name,
    customerEmail: customers.email,
    lastReplyAt: tickets.lastReplyAt,
    updatedAt: tickets.updatedAt,
  }).from(tickets)
    .innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, tenant.organizationId)))
    .leftJoin(users, eq(users.id, tickets.assignedUserId))
    .leftJoin(messages, and(eq(messages.ticketId, tickets.id), eq(messages.organizationId, tenant.organizationId)))
    .leftJoin(ticketTags, and(eq(ticketTags.ticketId, tickets.id), eq(ticketTags.organizationId, tenant.organizationId)))
    .leftJoin(tags, and(eq(tags.id, ticketTags.tagId), eq(tags.organizationId, tenant.organizationId)))
    .where(and(
      eq(tickets.organizationId, tenant.organizationId),
      status && ticketStatuses.includes(status as (typeof ticketStatuses)[number]) ? eq(tickets.status, status as (typeof ticketStatuses)[number]) : undefined,
      priority && ticketPriorities.includes(priority as (typeof ticketPriorities)[number]) ? eq(tickets.priority, priority as (typeof ticketPriorities)[number]) : undefined,
      assignee === "me" ? eq(tickets.assignedUserId, tenant.userId) : assignee === "unassigned" ? isNull(tickets.assignedUserId) : undefined,
      search ? or(like(tickets.normalizedSearch, `%${search}%`), like(customers.normalizedSearch, `%${search}%`), like(messages.normalizedSearch, `%${search}%`), like(tags.name, `%${search}%`)) : undefined,
    ))
    .groupBy(tickets.id)
    .orderBy(desc(tickets.updatedAt))
    .limit(100);
  return context.json({ tickets: rows });
});

ticketRoutes.post("/", zValidator("json", createTicketInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [customer] = await db.select({ id: customers.id, name: customers.name, email: customers.email }).from(customers).where(and(
    eq(customers.id, input.customerId),
    eq(customers.organizationId, tenant.organizationId),
  )).limit(1);
  if (!customer) throw new HttpError(404, "customer_not_found", "Customer not found.");
  if (input.assignedUserId) await assertActiveMember(context.env.DB, tenant.organizationId, input.assignedUserId);

  const numberRow = await context.env.DB.prepare(
    "UPDATE organizations SET next_ticket_number = next_ticket_number + 1, updated_at = ? WHERE id = ? RETURNING next_ticket_number - 1 AS number",
  ).bind(Date.now(), tenant.organizationId).first<{ number: number }>();
  if (!numberRow) throw new HttpError(404, "organization_not_found", "Workspace not found.");

  const ticketId = newId("tkt");
  const messageId = newId("msg");
  const now = new Date();
  await db.batch([
    db.insert(tickets).values({
      id: ticketId,
      organizationId: tenant.organizationId,
      number: numberRow.number,
      customerId: customer.id,
      subject: input.subject,
      status: "open",
      priority: input.priority,
      assignedUserId: input.assignedUserId,
      normalizedSearch: normalizeSearch(String(numberRow.number), input.subject, customer.name, customer.email),
      lastReplyAt: now,
    }),
    db.insert(messages).values({
      id: messageId,
      organizationId: tenant.organizationId,
      ticketId,
      authorType: "customer",
      authorCustomerId: customer.id,
      kind: "message",
      bodyText: input.message,
      normalizedSearch: normalizeSearch(input.message),
      deliveryStatus: "received",
    }),
    db.update(customers).set({ lastContactedAt: now, updatedAt: now }).where(and(eq(customers.id, customer.id), eq(customers.organizationId, tenant.organizationId))),
  ]);
  await recordActivity(db, tenant, { ticketId, eventType: "ticket.created", entityType: "ticket", entityId: ticketId, metadata: { number: numberRow.number } });
  return context.json({ ticket: { id: ticketId, number: numberRow.number, subject: input.subject, status: "open", priority: input.priority } }, 201);
});

ticketRoutes.get("/:id", async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [ticket] = await db.select({
    id: tickets.id, number: tickets.number, subject: tickets.subject, status: tickets.status, priority: tickets.priority,
    assignedUserId: tickets.assignedUserId, customerId: customers.id, customerName: customers.name, customerEmail: customers.email,
    customerCompany: customers.company, createdAt: tickets.createdAt, updatedAt: tickets.updatedAt,
  }).from(tickets)
    .innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, tenant.organizationId)))
    .where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const [thread, tagRows, attachmentRows] = await Promise.all([
    db.select().from(messages).where(and(eq(messages.ticketId, ticket.id), eq(messages.organizationId, tenant.organizationId))).orderBy(asc(messages.createdAt)),
    db.select({ id: tags.id, name: tags.name, color: tags.color }).from(ticketTags).innerJoin(tags, and(eq(tags.id, ticketTags.tagId), eq(tags.organizationId, tenant.organizationId))).where(and(eq(ticketTags.ticketId, ticket.id), eq(ticketTags.organizationId, tenant.organizationId))),
    db.select({ id: attachments.id, messageId: attachments.messageId, filename: attachments.filename, contentType: attachments.contentType, size: attachments.size }).from(attachments).where(and(eq(attachments.ticketId, ticket.id), eq(attachments.organizationId, tenant.organizationId))),
  ]);
  return context.json({ ticket, messages: thread, tags: tagRows, attachments: attachmentRows });
});

ticketRoutes.patch("/:id", zValidator("json", updateTicketInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  if (input.assignedUserId) await assertActiveMember(context.env.DB, tenant.organizationId, input.assignedUserId);
  const db = createDb(context.env.DB);
  const [current] = await db.select().from(tickets).where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!current) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const now = new Date();
  await db.update(tickets).set({
    ...input,
    resolvedAt: input.status === "resolved" ? now : input.status ? null : current.resolvedAt,
    closedAt: input.status === "closed" ? now : input.status ? null : current.closedAt,
    updatedAt: now,
  }).where(and(eq(tickets.id, current.id), eq(tickets.organizationId, tenant.organizationId)));
  if (input.assignedUserId !== undefined && input.assignedUserId !== current.assignedUserId) {
    await db.insert(ticketAssignments).values({ id: newId("asn"), organizationId: tenant.organizationId, ticketId: current.id, assignedToUserId: input.assignedUserId, assignedByUserId: tenant.userId });
    await recordActivity(db, tenant, { ticketId: current.id, eventType: "ticket.assigned", entityType: "ticket", entityId: current.id, metadata: { from: current.assignedUserId, to: input.assignedUserId } });
  }
  if (input.status && input.status !== current.status) await recordActivity(db, tenant, { ticketId: current.id, eventType: "ticket.status_changed", entityType: "ticket", entityId: current.id, metadata: { from: current.status, to: input.status } });
  if (input.priority && input.priority !== current.priority) await recordActivity(db, tenant, { ticketId: current.id, eventType: "ticket.priority_changed", entityType: "ticket", entityId: current.id, metadata: { from: current.priority, to: input.priority } });
  return context.json({ ticket: { ...current, ...input, updatedAt: now } });
});

ticketRoutes.post("/:id/messages", zValidator("json", messageInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [ticket] = await db.select({ id: tickets.id, customerId: tickets.customerId }).from(tickets).where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const id = newId("msg");
  const now = new Date();
  await db.batch([
    db.insert(messages).values({ id, organizationId: tenant.organizationId, ticketId: ticket.id, authorType: "agent", authorUserId: tenant.userId, kind: input.kind, bodyText: input.body, normalizedSearch: normalizeSearch(input.body), deliveryStatus: input.kind === "message" ? "queued" : "received" }),
    db.update(tickets).set({ updatedAt: now, lastReplyAt: input.kind === "message" ? now : undefined }).where(and(eq(tickets.id, ticket.id), eq(tickets.organizationId, tenant.organizationId))),
  ]);
  await recordActivity(db, tenant, { ticketId: ticket.id, eventType: input.kind === "internal_note" ? "ticket.note_added" : "ticket.agent_replied", entityType: "message", entityId: id });
  if (input.kind === "message") await context.env.OUTBOUND_MAIL_QUEUE.send({ kind: "outbound-mail", organizationId: tenant.organizationId, messageId: id });
  return context.json({ message: { id, ticketId: ticket.id, authorType: "agent", kind: input.kind, bodyText: input.body, createdAt: now } }, 201);
});

ticketRoutes.post("/:id/tags", zValidator("json", z.object({ tagId: z.string().min(1) })), async (context) => {
  const tenant = context.get("tenant");
  const tagId = context.req.valid("json").tagId;
  const db = createDb(context.env.DB);
  const [pair] = await Promise.all([
    db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId))).limit(1),
    db.select({ id: tags.id }).from(tags).where(and(eq(tags.id, tagId), eq(tags.organizationId, tenant.organizationId))).limit(1),
  ]);
  if (!pair.length) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const [tag] = await db.select({ id: tags.id }).from(tags).where(and(eq(tags.id, tagId), eq(tags.organizationId, tenant.organizationId))).limit(1);
  if (!tag) throw new HttpError(404, "tag_not_found", "Tag not found.");
  await db.insert(ticketTags).values({ organizationId: tenant.organizationId, ticketId: context.req.param("id"), tagId }).onConflictDoNothing();
  await recordActivity(db, tenant, { ticketId: context.req.param("id"), eventType: "ticket.tag_added", entityType: "tag", entityId: tagId });
  return context.json({ ok: true }, 201);
});

ticketRoutes.delete("/:id/tags/:tagId", async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [ticket] = await db.select({ id: tickets.id }).from(tickets).where(and(
    eq(tickets.id, context.req.param("id")),
    eq(tickets.organizationId, tenant.organizationId),
  )).limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  await db.delete(ticketTags).where(and(
    eq(ticketTags.organizationId, tenant.organizationId),
    eq(ticketTags.ticketId, ticket.id),
    eq(ticketTags.tagId, context.req.param("tagId")),
  ));
  await recordActivity(db, tenant, { ticketId: ticket.id, eventType: "ticket.tag_removed", entityType: "tag", entityId: context.req.param("tagId") });
  return context.body(null, 204);
});

async function assertActiveMember(database: D1Database, organizationId: string, userId: string) {
  const [member] = await createDb(database).select({ userId: organizationMemberships.userId }).from(organizationMemberships).where(and(
    eq(organizationMemberships.organizationId, organizationId),
    eq(organizationMemberships.userId, userId),
    isNull(organizationMemberships.disabledAt),
  )).limit(1);
  if (!member) throw new HttpError(404, "member_not_found", "Team member not found.");
}
