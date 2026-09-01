import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
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
    ))
    .groupBy(customers.id)
    .orderBy(desc(customers.lastContactedAt), customers.name)
    .limit(100);
  return context.json({ customers: rows });
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
  )).orderBy(desc(tickets.updatedAt));
  return context.json({ customer, tickets: history });
});

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
  return context.json({ customer: { ...current, ...input } });
});
