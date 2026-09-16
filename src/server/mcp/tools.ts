import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { createDb } from "../db";
import { customers, inboxes, knowledgeBaseArticles, messages, tickets, users } from "../db/schema";
import { listIdentities, normalizeIdentity } from "../customers/identities";
import { toFtsQuery } from "../search/index";
import type { AppBindings } from "../types";
import { ticketStatuses } from "../../shared/domain";

/** Generous, and still small enough that a runaway thread cannot blow the CPU budget. */
const MAX_LIMIT = 50;
/** An agent does not need a 200 KB thread, and truncation is stated in the response. */
const MAX_BODY_CHARS = 4000;
const MAX_MESSAGES = 30;

export interface ToolContext {
  env: AppBindings;
  organizationId: string;
  /** Null means every inbox. An empty array means none, and must yield no rows. */
  inboxIds: string[] | null;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (context: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

function clampLimit(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 20;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Applied to every query; without it the key's inbox restriction would be decorative. */
function inboxFilter(context: ToolContext) {
  if (!context.inboxIds) return undefined;
  return context.inboxIds.length ? inArray(tickets.inboxId, context.inboxIds) : sql`0`;
}

function truncate(body: string) {
  if (body.length <= MAX_BODY_CHARS) return { body, truncated: false };
  return { body: `${body.slice(0, MAX_BODY_CHARS)}…`, truncated: true };
}

const searchTickets: McpTool = {
  name: "search_tickets",
  description:
    "Search this workspace's tickets by free text, status, assignee, or queue. Returns ticket summaries, newest activity first.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search across subject, customer, and message bodies." },
      status: { type: "string", enum: [...ticketStatuses], description: "Restrict to one ticket status." },
      assignee: {
        type: "string",
        enum: ["any", "unassigned"],
        description: "Restrict to unassigned tickets, or leave unset for all.",
      },
      queue: {
        type: "string",
        enum: ["all", "open", "overdue", "due_soon", "snoozed"],
        description: "A named queue. 'overdue' and 'due_soon' reflect the workspace's response targets.",
      },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Maximum results, capped at 50." },
    },
    additionalProperties: false,
  },
  async run(context, args) {
    const db = createDb(context.env.DB);
    const limit = clampLimit(args.limit);
    const query = text(args.query);
    const fts = query ? toFtsQuery(query) : undefined;
    // A query that sanitises to nothing must not fall through to an unfiltered listing.
    if (query && fts === null) return { tickets: [], count: 0 };
    const queue = text(args.queue, "all");
    const status = text(args.status);

    const rows = await db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        slaState: tickets.slaState,
        firstResponseDueAt: tickets.firstResponseDueAt,
        snoozedUntil: tickets.snoozedUntil,
        assignee: users.name,
        customerName: customers.name,
        customerId: customers.id,
        updatedAt: tickets.updatedAt,
        preview: tickets.lastMessagePreview,
      })
      .from(tickets)
      .innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, context.organizationId)))
      .leftJoin(users, eq(users.id, tickets.assignedUserId))
      .where(
        and(
          eq(tickets.organizationId, context.organizationId),
          inboxFilter(context),
          status && (ticketStatuses as readonly string[]).includes(status)
            ? eq(tickets.status, status as (typeof ticketStatuses)[number])
            : undefined,
          args.assignee === "unassigned" ? isNull(tickets.assignedUserId) : undefined,
          queue === "open" ? eq(tickets.status, "open") : undefined,
          queue === "overdue" ? eq(tickets.slaState, "breached") : undefined,
          queue === "due_soon" ? eq(tickets.slaState, "due_soon") : undefined,
          queue === "snoozed" ? isNotNull(tickets.snoozedUntil) : undefined,
          fts
            ? sql`${tickets.id} in (select ticket_id from ticket_search where organization_id = ${context.organizationId} and ticket_search match ${fts})`
            : undefined,
        ),
      )
      .orderBy(desc(tickets.updatedAt), desc(tickets.id))
      .limit(limit);
    return { tickets: rows, count: rows.length };
  },
};

const getTicket: McpTool = {
  name: "get_ticket",
  description: "Fetch one ticket with its message thread. Long message bodies are truncated.",
  inputSchema: {
    type: "object",
    properties: { ticketId: { type: "string", description: "The ticket's id, as returned by search_tickets." } },
    required: ["ticketId"],
    additionalProperties: false,
  },
  async run(context, args) {
    const db = createDb(context.env.DB);
    const ticketId = text(args.ticketId);
    if (!ticketId) return { error: "not_found" };
    const [ticket] = await db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        slaState: tickets.slaState,
        firstResponseDueAt: tickets.firstResponseDueAt,
        resolutionDueAt: tickets.resolutionDueAt,
        snoozedUntil: tickets.snoozedUntil,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        customerName: customers.name,
        customerEmail: customers.email,
        customerId: customers.id,
        assignee: users.name,
        inboxName: inboxes.name,
      })
      .from(tickets)
      .innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, context.organizationId)))
      .leftJoin(users, eq(users.id, tickets.assignedUserId))
      .leftJoin(inboxes, eq(inboxes.id, tickets.inboxId))
      // A ticket from another workspace, or outside this key's inboxes, is simply not
      // found: anything else would confirm it exists.
      .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, context.organizationId), inboxFilter(context)))
      .limit(1);
    if (!ticket) return { error: "not_found" };

    const thread = await db
      .select({
        id: messages.id,
        authorType: messages.authorType,
        kind: messages.kind,
        bodyText: messages.bodyText,
        createdAt: messages.createdAt,
        authorName: users.name,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(and(eq(messages.ticketId, ticket.id), eq(messages.organizationId, context.organizationId)))
      .orderBy(messages.createdAt)
      .limit(MAX_MESSAGES + 1);

    const shown = thread.slice(0, MAX_MESSAGES);
    return {
      ticket,
      messages: shown.map((message) => {
        const { body, truncated } = truncate(message.bodyText ?? "");
        return { ...message, bodyText: body, bodyTruncated: truncated };
      }),
      // Said plainly rather than silently dropping the rest.
      messagesTruncated: thread.length > MAX_MESSAGES,
    };
  },
};

const listQueues: McpTool = {
  name: "list_queues",
  description: "List this workspace's ticket queues with their current counts.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run(context) {
    const restricted = context.inboxIds;
    const clause = restricted
      ? restricted.length
        ? ` AND inbox_id IN (${restricted.map(() => "?").join(",")})`
        : " AND 0"
      : "";
    const statement = context.env.DB.prepare(
      `SELECT count(*) AS total, sum(status='open') AS open, sum(status='pending') AS pending, sum(status='waiting_customer') AS waiting_customer, sum(status='resolved') AS resolved, sum(status='closed') AS closed, sum(assigned_user_id IS NULL AND status NOT IN ('resolved','closed')) AS unassigned, sum(sla_state='breached' AND status NOT IN ('resolved','closed')) AS overdue, sum(sla_state='due_soon' AND status NOT IN ('resolved','closed')) AS due_soon, sum(snoozed_until IS NOT NULL AND snoozed_until >= ?) AS snoozed FROM tickets WHERE organization_id = ?${clause}`,
    );
    const row = await statement
      .bind(Date.now(), context.organizationId, ...(restricted ?? []))
      .first<Record<string, number | null>>();
    return {
      queues: {
        all: row?.total ?? 0,
        open: row?.open ?? 0,
        pending: row?.pending ?? 0,
        waiting_customer: row?.waiting_customer ?? 0,
        unassigned: row?.unassigned ?? 0,
        overdue: row?.overdue ?? 0,
        due_soon: row?.due_soon ?? 0,
        snoozed: row?.snoozed ?? 0,
        resolved: row?.resolved ?? 0,
        closed: row?.closed ?? 0,
      },
    };
  },
};

const getCustomer: McpTool = {
  name: "get_customer",
  description: "Fetch one customer by id or email address, with their known addresses and recent tickets.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "The customer's id." },
      email: { type: "string", description: "Any email address known to belong to the customer." },
    },
    additionalProperties: false,
  },
  async run(context, args) {
    const db = createDb(context.env.DB);
    const customerId = text(args.customerId);
    const email = text(args.email);
    if (!customerId && !email) return { error: "not_found" };
    const [customer] = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        company: customers.company,
        createdAt: customers.createdAt,
        lastContactedAt: customers.lastContactedAt,
      })
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, context.organizationId),
          customerId
            ? eq(customers.id, customerId)
            : eq(sql`lower(${customers.email})`, normalizeIdentity(email)),
        ),
      )
      .limit(1);
    if (!customer) return { error: "not_found" };

    const identities = await listIdentities(context.env.DB, context.organizationId, customer.id);
    const recent = await db
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        updatedAt: tickets.updatedAt,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.organizationId, context.organizationId),
          eq(tickets.customerId, customer.id),
          inboxFilter(context),
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(10);
    return {
      customer,
      identities: identities.map((identity) => ({ value: identity.value, isPrimary: identity.isPrimary })),
      recentTickets: recent,
    };
  },
};

const searchKnowledgeBase: McpTool = {
  name: "search_knowledge_base",
  description: "Search this workspace's knowledge-base articles. Drafts are never returned.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to match in the title or body." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Maximum results, capped at 50." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(context, args) {
    const db = createDb(context.env.DB);
    const query = text(args.query);
    if (!query) return { articles: [], count: 0 };
    const like = `%${query.toLowerCase()}%`;
    const rows = await db
      .select({
        id: knowledgeBaseArticles.id,
        title: knowledgeBaseArticles.title,
        slug: knowledgeBaseArticles.slug,
        category: knowledgeBaseArticles.category,
        body: knowledgeBaseArticles.body,
        updatedAt: knowledgeBaseArticles.updatedAt,
      })
      .from(knowledgeBaseArticles)
      .where(
        and(
          eq(knowledgeBaseArticles.organizationId, context.organizationId),
          // Drafts stay inside the team, as they do everywhere else in the product.
          eq(knowledgeBaseArticles.status, "published"),
          or(
            sql`lower(${knowledgeBaseArticles.title}) like ${like}`,
            sql`lower(${knowledgeBaseArticles.body}) like ${like}`,
          ),
        ),
      )
      .orderBy(desc(knowledgeBaseArticles.updatedAt))
      .limit(clampLimit(args.limit));
    return {
      articles: rows.map((row) => {
        const { body, truncated } = truncate(row.body ?? "");
        return { ...row, body, bodyTruncated: truncated };
      }),
      count: rows.length,
    };
  },
};

/** Exactly five, all read-only. Write tools wait for an approval surface. */
export const MCP_TOOLS: McpTool[] = [searchTickets, getTicket, listQueues, getCustomer, searchKnowledgeBase];
