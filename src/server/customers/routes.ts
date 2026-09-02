import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, like, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { customers, tickets } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { newId, normalizeSearch } from "resolve-server/lib/id";
import type { HonoEnv } from "resolve-server/types";

const customerInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  company: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  notes: z.string().trim().max(10_000).optional().nullable(),
});

export const customerRoutes = new Hono<HonoEnv>();
customerRoutes.use("*", requireAuth);

customerRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const query = context.req.query("q")?.trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(context.req.query("limit") ?? 30) || 30));
  const cursor = decodeCustomerCursor(context.req.query("cursor"));
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      company: customers.company,
      phone: customers.phone,
      lastContactedAt: customers.lastContactedAt,
      createdAt: customers.createdAt,
      ticketCount: sql<number>`count(${tickets.id})`,
    })
    .from(customers)
    .leftJoin(tickets, and(eq(tickets.customerId, customers.id), eq(tickets.organizationId, tenant.organizationId)))
    .where(and(
      eq(customers.organizationId, tenant.organizationId),
      query ? or(like(customers.normalizedSearch, `%${query}%`), like(customers.email, `%${query}%`)) : undefined,
      cursor ? or(lt(customers.createdAt, new Date(cursor.createdAt)), and(eq(customers.createdAt, new Date(cursor.createdAt)), lt(customers.id, cursor.id))) : undefined,
    ))
    .groupBy(customers.id)
    .orderBy(desc(customers.createdAt), desc(customers.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = hasMore && last ? btoa(JSON.stringify({ createdAt: new Date(last.createdAt).getTime(), id: last.id })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") : null;
  return context.json({ customers: items, items, nextCursor, hasMore });
});

customerRoutes.post("/", zValidator("json", customerInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const id = newId("cus");
  try {
    await createDb(context.env.DB).insert(customers).values({
      id,
      organizationId: tenant.organizationId,
      ...input,
      normalizedSearch: normalizeSearch(input.name, input.email, input.company, input.phone),
    });
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "customer_exists", "A customer with this email already exists.");
    throw error;
  }
  return context.json({ customer: { id, ...input } }, 201);
});

customerRoutes.get("/:id", async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [customer] = await db.select().from(customers).where(and(
    eq(customers.id, context.req.param("id")),
    eq(customers.organizationId, tenant.organizationId),
  )).limit(1);
  if (!customer) throw new HttpError(404, "customer_not_found", "Customer not found.");
  const history = await db.select().from(tickets).where(and(
    eq(tickets.organizationId, tenant.organizationId),
    eq(tickets.customerId, customer.id),
  )).orderBy(desc(tickets.updatedAt)).limit(50);
  return context.json({ customer, tickets: history });
});

function decodeCustomerCursor(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as { createdAt?: unknown; id?: unknown };
    return typeof parsed.createdAt === "number" && typeof parsed.id === "string" ? { createdAt: parsed.createdAt, id: parsed.id } : undefined;
  } catch { return undefined; }
}

customerRoutes.patch("/:id", zValidator("json", customerInput.partial()), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [current] = await db.select().from(customers).where(and(eq(customers.id, context.req.param("id")), eq(customers.organizationId, tenant.organizationId))).limit(1);
  if (!current) throw new HttpError(404, "customer_not_found", "Customer not found.");
  const merged = { ...current, ...input };
  await db.update(customers).set({
    ...input,
    normalizedSearch: normalizeSearch(merged.name, merged.email, merged.company, merged.phone),
    updatedAt: new Date(),
  }).where(and(eq(customers.id, current.id), eq(customers.organizationId, tenant.organizationId)));
  const related = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.organizationId, tenant.organizationId), eq(tickets.customerId, current.id))).limit(50);
  for (const ticket of related) await refreshCustomerTicketSearch(context.env.DB, tenant.organizationId, ticket.id);
  return context.json({ customer: { ...current, ...input } });
});

async function refreshCustomerTicketSearch(database: D1Database, organizationId: string, ticketId: string) {
  const row = await database.prepare("SELECT t.normalized_search || ' ' || c.normalized_search || ' ' || coalesce((SELECT group_concat(m.normalized_search, ' ') FROM messages m WHERE m.organization_id = t.organization_id AND m.ticket_id = t.id), '') || ' ' || coalesce((SELECT group_concat(g.name, ' ') FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id AND g.organization_id = tt.organization_id WHERE tt.organization_id = t.organization_id AND tt.ticket_id = t.id), '') AS content FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE t.organization_id = ? AND t.id = ?").bind(organizationId, ticketId).first<{ content: string }>();
  await database.batch([
    database.prepare("DELETE FROM ticket_search WHERE organization_id = ? AND ticket_id = ?").bind(organizationId, ticketId),
    database.prepare("INSERT INTO ticket_search (organization_id, ticket_id, content) VALUES (?, ?, ?)").bind(organizationId, ticketId, row?.content ?? ""),
  ]);
}
