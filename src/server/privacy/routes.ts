import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { customers, tickets } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { eraseTicket, collectCustomerExport, requestCustomerErasure } from "./service";
import type { HonoEnv } from "../types";

async function assertCustomer(database: D1Database, organizationId: string, customerId: string) {
  const [customer] = await createDb(database)
    .select({ id: customers.id, name: customers.name, email: customers.email })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
    .limit(1);
  if (!customer) throw new HttpError(404, "customer_not_found", "Customer not found.");
  return customer;
}

export const privacyRoutes = new Hono<HonoEnv>();
privacyRoutes.use("*", requireAuth, requireRole("admin"));

privacyRoutes.get("/customers/:id/export", async (context) => {
  const tenant = context.get("tenant");
  const customer = await assertCustomer(context.env.DB, tenant.organizationId, context.req.param("id"));
  const payload = await collectCustomerExport(context.env.DB, tenant.organizationId, customer.id);
  if (!payload) throw new HttpError(404, "customer_not_found", "Customer not found.");
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="customer-${customer.id}-export.json"`,
    },
  });
});

privacyRoutes.post(
  "/customers/:id/erasure",
  validate("json", z.object({ acknowledge: z.literal(true) })),
  async (context) => {
    const tenant = context.get("tenant");
    if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `erasure:${tenant.userId}` })).success)
      throw new HttpError(429, "rate_limited", "Slow down and try again in a moment.");
    const customer = await assertCustomer(context.env.DB, tenant.organizationId, context.req.param("id"));
    await requestCustomerErasure(context.env, tenant.organizationId, customer.id);
    return context.json({ ok: true, queued: true });
  },
);

privacyRoutes.delete("/tickets/:id", async (context) => {
  const tenant = context.get("tenant");
  if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `ticket-delete:${tenant.userId}` })).success)
    throw new HttpError(429, "rate_limited", "Slow down and try again in a moment.");
  const result = await eraseTicket(
    context.env.DB,
    context.env.ATTACHMENTS,
    tenant.organizationId,
    context.req.param("id"),
  );
  if (!result.deleted) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  return context.json({ ok: true });
});

/** Confirmation payload for the UI: shows what erasure will remove. */
privacyRoutes.get("/tickets/:id/preview", async (context) => {
  const tenant = context.get("tenant");
  const [ticket] = await createDb(context.env.DB)
    .select({ id: tickets.id, number: tickets.number, subject: tickets.subject })
    .from(tickets)
    .where(and(eq(tickets.id, context.req.param("id")), eq(tickets.organizationId, tenant.organizationId)))
    .limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  return context.json({ ticket });
});
