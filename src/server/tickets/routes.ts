import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { recordActivity } from "resolve-server/activity/service";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { attachments, customers, inboxes, messages, outboundMailJobs, tags, ticketReadStates, ticketTags, tickets, users } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { validate } from "resolve-server/http/validate";
import { newId, normalizeSearch } from "resolve-server/lib/id";
import { sanitizeHtml } from "resolve-server/lib/sanitize-html";
import { refreshTicketSearch, toFtsQuery } from "resolve-server/search/index";
import { applyTicketUpdate, assertActiveMember, preview } from "resolve-server/tickets/service";
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
  assignedTeamId: z.string().optional().nullable(),
  version: z.number().int().positive().optional(),
});

const messageInput = z.object({
  body: z.string().trim().min(1).max(100_000),
  bodyHtml: z.string().max(200_000).optional(),
  kind: z.enum(["message", "internal_note"]).default("message"),
  clientMessageId: z.string().min(8).max(100).optional(),
});

export const ticketRoutes = new Hono<HonoEnv>();
ticketRoutes.use("*", requireAuth);

ticketRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const status = context.req.query("status");
  const priority = context.req.query("priority");
  const assignee = context.req.query("assignee");
  const search = context.req.query("q")?.trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(context.req.query("limit") ?? 30) || 30));
  const cursor = decodeCursor(context.req.query("cursor"));
  const ftsQuery = search ? toFtsQuery(search) : undefined;
  // A query that sanitises down to nothing must not fall through to an
  // unfiltered listing; answer with an empty page instead.
  if (search && ftsQuery === null) return context.json({ tickets: [], items: [], nextCursor: null, hasMore: false });
  const db = createDb(context.env.DB);
  const rows = await db.select({
    id: tickets.id,
    number: tickets.number,
    subject: tickets.subject,
    status: tickets.status,
    priority: tickets.priority,
    assignedUserId: tickets.assignedUserId,
    assignedTeamId: tickets.assignedTeamId,
    assigneeName: users.name,
    customerId: customers.id,
    customerName: customers.name,
    customerEmail: customers.email,
    preview: tickets.lastMessagePreview,
    messageCount: tickets.messageCount,
    version: tickets.version,
    unread: sql<number>`case when ${ticketReadStates.lastReadAt} is null or ${ticketReadStates.lastReadAt} < ${tickets.updatedAt} then 1 else 0 end`,
    lastReplyAt: tickets.lastReplyAt,
    updatedAt: tickets.updatedAt,
  }).from(tickets)
    .innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, tenant.organizationId)))
    .leftJoin(users, eq(users.id, tickets.assignedUserId))
    .leftJoin(ticketReadStates, and(eq(ticketReadStates.ticketId, tickets.id), eq(ticketReadStates.organizationId, tenant.organizationId), eq(ticketReadStates.userId, tenant.userId)))
    .where(and(
      eq(tickets.organizationId, tenant.organizationId),
      status && ticketStatuses.includes(status as (typeof ticketStatuses)[number]) ? eq(tickets.status, status as (typeof ticketStatuses)[number]) : undefined,
      priority && ticketPriorities.includes(priority as (typeof ticketPriorities)[number]) ? eq(tickets.priority, priority as (typeof ticketPriorities)[number]) : undefined,
      assignee === "me" ? eq(tickets.assignedUserId, tenant.userId) : assignee === "unassigned" ? isNull(tickets.assignedUserId) : undefined,
      ftsQuery ? sql`${tickets.id} in (select ticket_id from ticket_search where organization_id = ${tenant.organizationId} and ticket_search match ${ftsQuery})` : undefined,
      cursor ? or(lt(tickets.updatedAt, new Date(cursor.updatedAt)), and(eq(tickets.updatedAt, new Date(cursor.updatedAt)), lt(tickets.id, cursor.id))) : undefined,
    ))
    .orderBy(desc(tickets.updatedAt), desc(tickets.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ updatedAt: new Date(last.updatedAt).getTime(), id: last.id }) : null;
  const tagMap = new Map<string, Array<{ id: string; name: string; color: string }>>();
  if (items.length) {
    const placeholders = items.map(() => "?").join(",");
    const tagRows = await context.env.DB.prepare(`SELECT tt.ticket_id AS ticketId, g.id, g.name, g.color FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id AND g.organization_id = tt.organization_id WHERE tt.organization_id = ? AND tt.ticket_id IN (${placeholders}) ORDER BY g.name`).bind(tenant.organizationId, ...items.map((item) => item.id)).all<{ ticketId: string; id: string; name: string; color: string }>();
    for (const tag of tagRows.results) tagMap.set(tag.ticketId, [...(tagMap.get(tag.ticketId) ?? []), { id: tag.id, name: tag.name, color: tag.color }]);
  }
  const enriched = items.map((item) => ({ ...item, unread: Boolean(item.unread), tags: tagMap.get(item.id) ?? [] }));
  return context.json({ tickets: enriched, items: enriched, nextCursor, hasMore });
});

ticketRoutes.post("/", validate("json", createTicketInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [customer] = await db.select({ id: customers.id, name: customers.name, email: customers.email }).from(customers).where(and(
    eq(customers.id, input.customerId),
    eq(customers.organizationId, tenant.organizationId),
  )).limit(1);
  if (!customer) throw new HttpError(404, "customer_not_found", "Customer not found.");
  if (input.assignedUserId) await assertActiveMember(context.env.DB, tenant.organizationId, input.assignedUserId);
  const defaultInbox = await db.select({ id: inboxes.id }).from(inboxes).where(and(eq(inboxes.organizationId, tenant.organizationId), isNull(inboxes.disabledAt))).orderBy(desc(inboxes.isDefault), asc(inboxes.createdAt)).limit(1).then((rows) => rows[0]);
  if (!defaultInbox) throw new HttpError(409, "no_inbox", "Add a support inbox in Settings before starting conversations.");

  const numberRow = await context.env.DB.prepare(
    "UPDATE organizations SET next_ticket_number = next_ticket_number + 1, updated_at = ? WHERE id = ? RETURNING next_ticket_number - 1 AS number",
  ).bind(Date.now(), tenant.organizationId).first<{ number: number }>();
  if (!numberRow) throw new HttpError(404, "organization_not_found", "Workspace not found.");

  const ticketId = newId("tkt");
  const messageId = newId("msg");
  const outboundJobId = newId("omj");
  const now = new Date();
  await db.batch([
    db.insert(tickets).values({
      id: ticketId,
      organizationId: tenant.organizationId,
      inboxId: defaultInbox.id,
      number: numberRow.number,
      customerId: customer.id,
      subject: input.subject,
      status: "waiting_customer",
      priority: input.priority,
      assignedUserId: input.assignedUserId,
      normalizedSearch: normalizeSearch(String(numberRow.number), input.subject, customer.name, customer.email),
      lastReplyAt: now,
      lastAgentReplyAt: now,
      waitingSince: now,
      lastMessagePreview: preview(input.message),
      messageCount: 1,
    }),
    db.insert(messages).values({
      id: messageId,
      organizationId: tenant.organizationId,
      ticketId,
      authorType: "agent",
      authorUserId: tenant.userId,
      kind: "message",
      bodyText: input.message,
      normalizedSearch: normalizeSearch(input.message),
      deliveryStatus: "queued",
    }),
    db.insert(outboundMailJobs).values({ id: outboundJobId, organizationId: tenant.organizationId, messageId, idempotencyKey: `message/${messageId}`, status: "pending", nextAttemptAt: now }),
    db.update(customers).set({ lastContactedAt: now, updatedAt: now }).where(and(eq(customers.id, customer.id), eq(customers.organizationId, tenant.organizationId))),
  ]);
  await refreshTicketSearch(context.env.DB, tenant.organizationId, ticketId);
  await recordActivity(db, tenant, { ticketId, eventType: "ticket.created", entityType: "ticket", entityId: ticketId, metadata: { number: numberRow.number } });
  await context.env.OUTBOUND_MAIL_QUEUE.send({ kind: "outbound-mail", jobId: outboundJobId });
  return context.json({ ticket: { id: ticketId, number: numberRow.number, subject: input.subject, status: "waiting_customer", priority: input.priority } }, 201);
});

ticketRoutes.get("/:id", async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [ticket] = await db.select({
    id: tickets.id, number: tickets.number, subject: tickets.subject, status: tickets.status, priority: tickets.priority,
    assignedUserId: tickets.assignedUserId, assignedTeamId: tickets.assignedTeamId, customerId: customers.id, customerName: customers.name, customerEmail: customers.email,
    customerCompany: customers.company, createdAt: tickets.createdAt, updatedAt: tickets.updatedAt, version: tickets.version,
  }).from(tickets)
    .innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, tenant.organizationId)))
    .where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const [thread, tagRows, attachmentRows] = await Promise.all([
    db.select({
      id: messages.id,
      ticketId: messages.ticketId,
      authorType: messages.authorType,
      authorUserId: messages.authorUserId,
      kind: messages.kind,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
      deliveryStatus: messages.deliveryStatus,
      deliveryError: outboundMailJobs.lastError,
      authorName: users.name,
      createdAt: messages.createdAt,
    }).from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .leftJoin(outboundMailJobs, and(eq(outboundMailJobs.messageId, messages.id), eq(outboundMailJobs.organizationId, tenant.organizationId)))
      .where(and(eq(messages.ticketId, ticket.id), eq(messages.organizationId, tenant.organizationId)))
      .orderBy(asc(messages.createdAt)).limit(50),
    db.select({ id: tags.id, name: tags.name, color: tags.color }).from(ticketTags).innerJoin(tags, and(eq(tags.id, ticketTags.tagId), eq(tags.organizationId, tenant.organizationId))).where(and(eq(ticketTags.ticketId, ticket.id), eq(ticketTags.organizationId, tenant.organizationId))),
    db.select({ id: attachments.id, messageId: attachments.messageId, filename: attachments.filename, contentType: attachments.contentType, size: attachments.size }).from(attachments).where(and(eq(attachments.ticketId, ticket.id), eq(attachments.organizationId, tenant.organizationId))),
  ]);
  await db.insert(ticketReadStates).values({ organizationId: tenant.organizationId, ticketId: ticket.id, userId: tenant.userId, lastReadAt: new Date() }).onConflictDoUpdate({ target: [ticketReadStates.ticketId, ticketReadStates.userId], set: { lastReadAt: new Date() } });
  return context.json({ ticket, messages: thread, tags: tagRows, attachments: attachmentRows });
});

ticketRoutes.patch("/:id", validate("json", updateTicketInput), async (context) => {
  const tenant = context.get("tenant");
  const { version, ...changes } = context.req.valid("json");
  const ticket = await applyTicketUpdate(context.env, tenant, context.req.param("id"), changes, { expectedVersion: version });
  return context.json({ ticket });
});

ticketRoutes.post("/:id/messages", validate("json", messageInput), async (context) => {
  const tenant = context.get("tenant");
  if (!(await context.env.AUTH_RATE_LIMIT.limit({ key: `messages:${tenant.userId}` })).success) throw new HttpError(429, "rate_limited", "Slow down and try again in a moment.");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [ticket] = await db.select({ id: tickets.id, customerId: tickets.customerId, status: tickets.status }).from(tickets).where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const id = newId("msg");
  const outboundJobId = newId("omj");
  const now = new Date();
  // An agent reply hands the conversation back to the customer; internal notes,
  // and tickets already waiting, resolved, or closed, keep the status they had.
  const handsOffToCustomer = input.kind === "message" && (ticket.status === "open" || ticket.status === "pending");
  const values: typeof messages.$inferInsert = { id, organizationId: tenant.organizationId, ticketId: ticket.id, authorType: "agent", authorUserId: tenant.userId, kind: input.kind, bodyText: input.body, bodyHtml: input.kind === "message" && input.bodyHtml ? sanitizeHtml(input.bodyHtml) : null, normalizedSearch: normalizeSearch(input.body), clientMessageId: input.clientMessageId, deliveryStatus: input.kind === "message" ? "queued" : "received" };
  // The unique (organization_id, client_message_id) index arbitrates duplicate
  // submits instead of a read-then-write check, which two concurrent retries
  // can both pass. That index is partial, and SQLite only matches a conflict
  // target that repeats its predicate, so the clause stays untargeted; a freshly
  // generated id with null provider and RFC identifiers can collide on nothing
  // else. Only the request whose insert took effect goes on to bump the ticket
  // and queue delivery; the losers report the message that won.
  const inserted = await db.insert(messages).values(values).onConflictDoNothing();
  if (input.clientMessageId && !inserted.meta.changes) {
    const existing = await db.select({ id: messages.id, ticketId: messages.ticketId, authorType: messages.authorType, kind: messages.kind, bodyText: messages.bodyText, createdAt: messages.createdAt })
      .from(messages).where(and(eq(messages.organizationId, tenant.organizationId), eq(messages.clientMessageId, input.clientMessageId))).limit(1).then((rows) => rows[0]);
    if (!existing) throw new HttpError(409, "message_conflict", "The message could not be saved. Try again.");
    return context.json({ message: existing, duplicate: true }, 200);
  }
  const updateTicket = db.update(tickets).set({ updatedAt: now, lastReplyAt: input.kind === "message" ? now : undefined, lastAgentReplyAt: input.kind === "message" ? now : undefined, lastMessagePreview: preview(input.body), messageCount: sql`${tickets.messageCount} + 1`, version: sql`${tickets.version} + 1` }).where(and(eq(tickets.id, ticket.id), eq(tickets.organizationId, tenant.organizationId)));
  if (input.kind === "message") {
    await db.batch([updateTicket, db.insert(outboundMailJobs).values({ id: outboundJobId, organizationId: tenant.organizationId, messageId: id, idempotencyKey: `message/${id}`, status: "pending", nextAttemptAt: now }).onConflictDoNothing()]);
  } else {
    await db.batch([updateTicket]);
  }
  if (handsOffToCustomer) {
    await context.env.DB.prepare("UPDATE tickets SET status = 'waiting_customer', waiting_since = ? WHERE organization_id = ? AND id = ?").bind(now.getTime(), tenant.organizationId, ticket.id).run();
  }
  await refreshTicketSearch(context.env.DB, tenant.organizationId, ticket.id);
  await recordActivity(db, tenant, { ticketId: ticket.id, eventType: input.kind === "internal_note" ? "ticket.note_added" : "ticket.agent_replied", entityType: "message", entityId: id });
  if (handsOffToCustomer) {
    await recordActivity(db, tenant, { ticketId: ticket.id, eventType: "ticket.status_changed", entityType: "ticket", entityId: ticket.id, metadata: { from: ticket.status, to: "waiting_customer" } });
  }
  if (input.kind === "message") await context.env.OUTBOUND_MAIL_QUEUE.send({ kind: "outbound-mail", jobId: outboundJobId });
  return context.json({ message: { id, ticketId: ticket.id, authorType: "agent", kind: input.kind, bodyText: input.body, createdAt: now } }, 201);
});

ticketRoutes.post("/:id/tags", validate("json", z.object({ tagId: z.string().min(1) })), async (context) => {
  const tenant = context.get("tenant");
  const tagId = context.req.valid("json").tagId;
  const db = createDb(context.env.DB);
  const [ticket] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const [tag] = await db.select({ id: tags.id }).from(tags).where(and(eq(tags.id, tagId), eq(tags.organizationId, tenant.organizationId))).limit(1);
  if (!tag) throw new HttpError(404, "tag_not_found", "Tag not found.");
  await db.insert(ticketTags).values({ organizationId: tenant.organizationId, ticketId: context.req.param("id"), tagId }).onConflictDoNothing();
  await refreshTicketSearch(context.env.DB, tenant.organizationId, context.req.param("id"));
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
  await refreshTicketSearch(context.env.DB, tenant.organizationId, ticket.id);
  await recordActivity(db, tenant, { ticketId: ticket.id, eventType: "ticket.tag_removed", entityType: "tag", entityId: context.req.param("tagId") });
  return context.body(null, 204);
});

function encodeCursor(value: { updatedAt: number; id: string }) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(value?: string) {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as { updatedAt?: unknown; id?: unknown };
    return typeof decoded.updatedAt === "number" && typeof decoded.id === "string" ? { updatedAt: decoded.updatedAt, id: decoded.id } : undefined;
  } catch { return undefined; }
}
