import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { customers, tickets } from "resolve-server/db/schema";
import { toFtsQuery } from "resolve-server/search/index";
import type { HonoEnv } from "resolve-server/types";

export const searchRoutes = new Hono<HonoEnv>();
searchRoutes.use("*", requireAuth);
searchRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const query = context.req.query("q")?.trim().toLowerCase() ?? "";
  if (query.length < 2) return context.json({ results: [] });
  const ftsQuery = toFtsQuery(query);
  if (ftsQuery === null) return context.json({ results: [] });
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      priority: tickets.priority,
      customerName: customers.name,
      customerEmail: customers.email,
      updatedAt: tickets.updatedAt,
    })
    .from(tickets)
    .innerJoin(
      customers,
      and(eq(customers.id, tickets.customerId), eq(customers.organizationId, tenant.organizationId)),
    )
    .where(
      and(
        eq(tickets.organizationId, tenant.organizationId),
        sql`${tickets.id} in (select ticket_id from ticket_search where organization_id = ${tenant.organizationId} and ticket_search match ${ftsQuery})`,
      ),
    )
    .orderBy(desc(tickets.updatedAt))
    .limit(50);
  return context.json({ results: rows });
});
