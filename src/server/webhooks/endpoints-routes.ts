import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { webhookDeliveries, webhookEndpoints, webhookEvents, webhookKinds } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { newId } from "../lib/id";
import { randomToken } from "../lib/crypto";
import type { HonoEnv } from "../types";
import { checkDestination } from "./destination";
import { attemptDelivery } from "./outbound";

/** Capped per workspace: ten endpoints across six events is already sixty sends per event storm. */
const MAX_ENDPOINTS = 10;

const endpointInput = z.object({
  url: z.string().trim().min(1).max(2000),
  kind: z.enum(webhookKinds).default("generic"),
  events: z.array(z.enum(webhookEvents)).min(1),
  config: z.record(z.string(), z.string().max(4000)).default({}),
});

export const webhookEndpointRoutes = new Hono<HonoEnv>();
webhookEndpointRoutes.use("*", requireAuth);

webhookEndpointRoutes.get("/", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  // The secret is never selected in a response path; it is shown once, at creation.
  const rows = await db
    .select({
      id: webhookEndpoints.id,
      kind: webhookEndpoints.kind,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      enabled: webhookEndpoints.enabled,
      failureCount: webhookEndpoints.failureCount,
      disabledAt: webhookEndpoints.disabledAt,
      lastSuccessAt: webhookEndpoints.lastSuccessAt,
      lastError: webhookEndpoints.lastError,
      createdAt: webhookEndpoints.createdAt,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.organizationId, tenant.organizationId))
    .orderBy(desc(webhookEndpoints.createdAt));
  return context.json({ endpoints: rows, events: webhookEvents });
});

webhookEndpointRoutes.post("/", requireRole("admin"), validate("json", endpointInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);

  const existing = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.organizationId, tenant.organizationId))
    .limit(MAX_ENDPOINTS + 1);
  if (existing.length >= MAX_ENDPOINTS)
    throw new HttpError(409, "too_many_endpoints", `A workspace can have at most ${MAX_ENDPOINTS} endpoints.`);

  // Telegram builds its own URL from the bot token, so only the other kinds are checked
  // against the address the user typed.
  if (input.kind !== "telegram") {
    const destination = checkDestination(context.env, input.url, { request: context.req.raw });
    if (!destination.ok) throw new HttpError(400, `destination_${destination.reason}`, destination.message!);
  } else if (!input.config.botToken || !input.config.chatId) {
    throw new HttpError(400, "telegram_config_missing", "Telegram needs both a bot token and a chat id.");
  }

  const id = newId("whe");
  const secret = `whsec_${randomToken(24)}`;
  const now = new Date();
  await db.insert(webhookEndpoints).values({
    id,
    organizationId: tenant.organizationId,
    kind: input.kind,
    url: input.url,
    secret,
    config: input.config,
    events: input.events,
    createdAt: now,
    updatedAt: now,
  });
  return context.json(
    {
      // Shown exactly once, like an API key.
      secret: input.kind === "generic" ? secret : null,
      endpoint: {
        id,
        kind: input.kind,
        url: input.url,
        events: input.events,
        enabled: true,
        failureCount: 0,
        disabledAt: null,
        lastSuccessAt: null,
        lastError: null,
        createdAt: now.toISOString(),
      },
    },
    201,
  );
});

/** Re-enables an endpoint that disabled itself, and clears its failure count. */
webhookEndpointRoutes.post("/:id/enable", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  const result = await createDb(context.env.DB)
    .update(webhookEndpoints)
    .set({ enabled: true, disabledAt: null, failureCount: 0, lastError: null, updatedAt: new Date() })
    .where(
      and(eq(webhookEndpoints.id, context.req.param("id")), eq(webhookEndpoints.organizationId, tenant.organizationId)),
    );
  if (!result.meta.changes) throw new HttpError(404, "endpoint_not_found", "Webhook endpoint not found.");
  return context.json({ ok: true });
});

/** Sends a sample event so an operator can confirm the endpoint before trusting it. */
webhookEndpointRoutes.post("/:id/test", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  const db = createDb(context.env.DB);
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.id, context.req.param("id")), eq(webhookEndpoints.organizationId, tenant.organizationId)),
    )
    .limit(1);
  if (!endpoint) throw new HttpError(404, "endpoint_not_found", "Webhook endpoint not found.");
  if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `webhook-test:${tenant.userId}` })).success)
    throw new HttpError(429, "rate_limited", "Wait a moment before testing again.");

  const payload = {
    event: "ticket.created" as const,
    occurredAt: new Date().toISOString(),
    organizationId: tenant.organizationId,
    data: { ticketId: "tkt_test", number: 0, subject: "Test delivery from ResolveHQ", status: "open", priority: "normal" },
  };
  const deliveryId = newId("whd");
  const now = new Date();
  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    organizationId: tenant.organizationId,
    endpointId: endpoint.id,
    event: "ticket.created",
    payload: JSON.stringify(payload),
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await attemptDelivery(context.env, endpoint, deliveryId, payload);

  const [delivery] = await db
    .select({ status: webhookDeliveries.status, responseCode: webhookDeliveries.responseCode, lastError: webhookDeliveries.lastError })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  return context.json({ delivered: delivery?.status === "delivered", ...delivery });
});

webhookEndpointRoutes.delete("/:id", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  // Pending deliveries cascade away with the endpoint.
  const result = await createDb(context.env.DB)
    .delete(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.id, context.req.param("id")), eq(webhookEndpoints.organizationId, tenant.organizationId)),
    );
  if (!result.meta.changes) throw new HttpError(404, "endpoint_not_found", "Webhook endpoint not found.");
  return context.json({ ok: true });
});
