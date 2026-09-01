import { and, desc, eq, like, or } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { customers, messages, tickets } from "resolve-server/db/schema";
import type { HonoEnv } from "resolve-server/types";

export const searchRoutes = new Hono<HonoEnv>();
searchRoutes.use("*", requireAuth);
searchRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const query = context.req.query("q")?.trim().toLowerCase() ?? "";
  if (query.length < 2) return context.json({ results: [] });
  const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const db = createDb(context.env.DB);
  const rows = await db.select({
    id: tickets.id, number: tickets.number, subject: tickets.subject, status: tickets.status, priority: tickets.priority,
    customerName: customers.name, customerEmail: customers.email, updatedAt: tickets.updatedAt,
  }).from(tickets)
    .innerJoin(customers, and(eq(customers.id, tickets.customerId), eq(customers.organizationId, tenant.organizationId)))
    .leftJoin(messages, and(eq(messages.ticketId, tickets.id), eq(messages.organizationId, tenant.organizationId)))
    .where(and(eq(tickets.organizationId, tenant.organizationId), or(
      like(tickets.normalizedSearch, pattern),
      like(customers.normalizedSearch, pattern),
      like(messages.normalizedSearch, pattern),
    )))
    .groupBy(tickets.id)
    .orderBy(desc(tickets.updatedAt))
    .limit(50);
  return context.json({ results: rows });
});
