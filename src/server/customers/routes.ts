import { and, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "resolve-server/auth/middleware";
import { createDb } from "resolve-server/db";
import { customers, tickets } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { validate } from "resolve-server/http/validate";
import { newId, normalizeSearch } from "resolve-server/lib/id";
import {
  createCustomerWithIdentity,
  identityOwner,
  listIdentities,
  normalizeIdentity,
  setPrimaryEmail,
} from "./identities";
import { mergeCustomers } from "./merge";
import { requestCustomerRefresh } from "../maintenance/service";
import type { HonoEnv } from "resolve-server/types";

const emailInput = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

/** Loads a customer inside the caller's tenant or refuses with 404. */
async function loadCustomer(database: D1Database, organizationId: string, id: string) {
  const [customer] = await createDb(database)
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.organizationId, organizationId)))
    .limit(1);
  if (!customer) throw new HttpError(404, "customer_not_found", "Customer not found.");
  return customer;
}

/**
 * The customer that already holds this address, when it is not the one being
 * edited. Callers answer with `identityConflict` so the UI can offer a merge.
 */
async function conflictingOwner(
  database: D1Database,
  organizationId: string,
  value: string,
  customerId: string | null,
) {
  const owner = await identityOwner(database, organizationId, value);
  return owner && owner !== customerId ? owner : null;
}

function identityConflict(context: Context<HonoEnv>, ownerCustomerId: string | null) {
  return context.json(
    {
      error: {
        code: "identity_in_use",
        message: "Another customer already uses this email address.",
        ...(ownerCustomerId ? { ownerCustomerId } : {}),
        requestId: context.get("requestId"),
      },
    },
    409,
  );
}

const customerInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
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
    })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, tenant.organizationId),
        query
          ? or(
              like(customers.normalizedSearch, `%${query}%`),
              like(customers.email, `%${query}%`),
              sql`EXISTS (SELECT 1 FROM customer_identities ci WHERE ci.organization_id = ${customers.organizationId} AND ci.customer_id = ${customers.id} AND ci.value LIKE ${`%${query}%`})`,
            )
          : undefined,
        cursor
          ? or(
              lt(customers.createdAt, new Date(cursor.createdAt)),
              and(eq(customers.createdAt, new Date(cursor.createdAt)), lt(customers.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(customers.createdAt), desc(customers.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const counts = page.length
    ? await db
        .select({ customerId: tickets.customerId, count: sql<number>`count(*)` })
        .from(tickets)
        .where(
          and(
            eq(tickets.organizationId, tenant.organizationId),
            inArray(
              tickets.customerId,
              page.map((row) => row.id),
            ),
          ),
        )
        .groupBy(tickets.customerId)
    : [];
  const totals = new Map(counts.map((row) => [row.customerId, row.count]));
  const items = page.map((row) => ({ ...row, ticketCount: totals.get(row.id) ?? 0 }));
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? btoa(JSON.stringify({ createdAt: new Date(last.createdAt).getTime(), id: last.id }))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "")
      : null;
  return context.json({ customers: items, items, nextCursor, hasMore });
});

customerRoutes.post("/", validate("json", customerInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const taken = await conflictingOwner(context.env.DB, tenant.organizationId, input.email, null);
  if (taken) return identityConflict(context, taken);
  let id: string;
  try {
    ({ id } = await createCustomerWithIdentity(context.env.DB, tenant.organizationId, input, "manual"));
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      throw new HttpError(409, "customer_exists", "A customer with this email already exists.");
    throw error;
  }
  return context.json({ customer: { id, ...input } }, 201);
});

customerRoutes.get("/:id", async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const customer = await loadCustomer(context.env.DB, tenant.organizationId, context.req.param("id"));
  const identities = await listIdentities(context.env.DB, tenant.organizationId, customer.id);
  const history = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.organizationId, tenant.organizationId), eq(tickets.customerId, customer.id)))
    .orderBy(desc(tickets.updatedAt))
    .limit(50);
  return context.json({ customer, identities, tickets: history });
});

function decodeCustomerCursor(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as {
      createdAt?: unknown;
      id?: unknown;
    };
    return typeof parsed.createdAt === "number" && typeof parsed.id === "string"
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : undefined;
  } catch {
    return undefined;
  }
}

customerRoutes.patch("/:id", validate("json", customerInput.partial()), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const current = await loadCustomer(context.env.DB, tenant.organizationId, context.req.param("id"));
  const merged = { ...current, ...input };
  const { email, ...rest } = input;
  // The conflict check runs before anything is written, so a refused email
  // change leaves the profile exactly as it was.
  const movesPrimary = Boolean(email && email !== current.email);
  if (movesPrimary) {
    const taken = await conflictingOwner(context.env.DB, tenant.organizationId, email!, current.id);
    if (taken) return identityConflict(context, taken);
  }
  await db
    .update(customers)
    .set({
      ...rest,
      normalizedSearch: normalizeSearch(merged.name, merged.email, merged.company, merged.phone),
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, current.id), eq(customers.organizationId, tenant.organizationId)));
  // A new address becomes the primary identity; the previous one stays behind
  // so replies sent to it still land on the same customer.
  if (movesPrimary)
    try {
      await setPrimaryEmail(context.env.DB, tenant.organizationId, { ...current, ...rest }, email!);
    } catch (error) {
      // Another request can claim the address between the check and the batch.
      if (!String(error).includes("UNIQUE")) throw error;
      return identityConflict(context, await identityOwner(context.env.DB, tenant.organizationId, email!));
    }
  await requestCustomerRefresh(context.env, tenant.organizationId, current.id);
  return context.json({ customer: { ...current, ...input } });
});

customerRoutes.post(
  "/:id/identities",
  validate("json", z.object({ email: emailInput })),
  async (context) => {
    const tenant = context.get("tenant");
    const customer = await loadCustomer(context.env.DB, tenant.organizationId, context.req.param("id"));
    const value = normalizeIdentity(context.req.valid("json").email);
    const taken = await conflictingOwner(context.env.DB, tenant.organizationId, value, customer.id);
    if (taken) return identityConflict(context, taken);
    const owner = await identityOwner(context.env.DB, tenant.organizationId, value);
    const id = newId("cid");
    if (!owner) {
      const now = Date.now();
      await context.env.DB.prepare(
        "INSERT INTO customer_identities (id, organization_id, customer_id, kind, value, is_primary, source, created_at, updated_at) VALUES (?, ?, ?, 'email', ?, 0, 'manual', ?, ?)",
      )
        .bind(id, tenant.organizationId, customer.id, value, now, now)
        .run();
      await requestCustomerRefresh(context.env, tenant.organizationId, customer.id);
    }
    return context.json({ identities: await listIdentities(context.env.DB, tenant.organizationId, customer.id) }, 201);
  },
);

customerRoutes.delete("/:id/identities/:identityId", async (context) => {
  const tenant = context.get("tenant");
  const customer = await loadCustomer(context.env.DB, tenant.organizationId, context.req.param("id"));
  const identity = await context.env.DB.prepare(
    "SELECT id, is_primary AS isPrimary FROM customer_identities WHERE organization_id = ? AND customer_id = ? AND id = ? LIMIT 1",
  )
    .bind(tenant.organizationId, customer.id, context.req.param("identityId"))
    .first<{ id: string; isPrimary: number }>();
  if (!identity) throw new HttpError(404, "identity_not_found", "Identity not found.");
  if (identity.isPrimary)
    throw new HttpError(
      409,
      "identity_is_primary",
      "The primary address cannot be removed. Change the customer email first.",
    );
  await context.env.DB.prepare("DELETE FROM customer_identities WHERE organization_id = ? AND id = ?")
    .bind(tenant.organizationId, identity.id)
    .run();
  return context.json({ identities: await listIdentities(context.env.DB, tenant.organizationId, customer.id) });
});

customerRoutes.post(
  "/:id/merge",
  requireRole("admin"),
  validate("json", z.object({ sourceCustomerId: z.string().trim().min(1).max(64) })),
  async (context) => {
    const tenant = context.get("tenant");
    if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `customer-merge:${tenant.userId}` })).success)
      throw new HttpError(429, "rate_limited", "Slow down and try again in a moment.");
    const { sourceCustomerId } = context.req.valid("json");
    const targetId = context.req.param("id");
    if (sourceCustomerId === targetId)
      throw new HttpError(400, "merge_same_customer", "Pick a different customer to merge in.");
    const target = await loadCustomer(context.env.DB, tenant.organizationId, targetId);
    const source = await loadCustomer(context.env.DB, tenant.organizationId, sourceCustomerId);
    const result = await mergeCustomers(
      context.env.DB,
      tenant.organizationId,
      target,
      source,
      tenant.userId,
      context.get("requestId"),
    );
    await requestCustomerRefresh(context.env, tenant.organizationId, target.id);
    return context.json({ ok: true, customerId: target.id, ...result });
  },
);
