import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb } from "../db";
import { webhookDeliveries, webhookEndpoints, webhookEvents } from "../db/schema";
import { newId } from "../lib/id";
import { signValue } from "../lib/crypto";
import type { AppBindings } from "../types";
import { checkDestination } from "./destination";
import { formatPayload, type WebhookEndpoint, type WebhookPayload } from "./formats";

export type WebhookEvent = (typeof webhookEvents)[number];

/**
 * Hono's `executionCtx` getter throws when the request was dispatched without one —
 * which is every test, and every call from inside a queue consumer. Reading it safely
 * lets the caller pass "deliver now if you can" without guarding at each site.
 */
export function backgroundRunner(context: {
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const ctx = context.executionCtx;
    return ctx ? ctx.waitUntil.bind(ctx) : undefined;
  } catch {
    return undefined;
  }
}

/** 15s, 1m, 5m, 30m, 2h — then the delivery is abandoned. */
const BACKOFF_MS = [15_000, 60_000, 300_000, 1_800_000, 7_200_000];
export const MAX_ATTEMPTS = 6;
/** Consecutive endpoint failures before it disables itself. */
export const AUTO_DISABLE_AFTER = 10;
const SEND_TIMEOUT_MS = 10_000;
/** Only the status is needed; a huge body must not be read into memory. */

/**
 * Records and attempts one event for every subscribed endpoint.
 *
 * **A webhook failure must never fail the originating request.** A ticket is created
 * even when every endpoint is down, so the whole emission is wrapped in a catch.
 *
 * No Queue is used: Queues are capped at 10,000 operations a day on the Free plan and
 * are shared with inbound mail, outbound mail and maintenance. Deliveries go out on
 * `waitUntil` and are retried by the existing five-minute cron.
 */
export async function emitWebhookEvent(
  env: AppBindings,
  organizationId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  try {
    const db = createDb(env.DB);
    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.enabled, true),
          isNull(webhookEndpoints.disabledAt),
        ),
      );
    const subscribed = endpoints.filter((endpoint) => (endpoint.events ?? []).includes(event));
    if (!subscribed.length) return;

    const payload: WebhookPayload = {
      event,
      occurredAt: new Date().toISOString(),
      organizationId,
      data,
    };
    const body = JSON.stringify(payload);
    const now = new Date();
    const rows = subscribed.map((endpoint) => ({
      id: newId("whd"),
      organizationId,
      endpointId: endpoint.id,
      event,
      payload: body,
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    await db.insert(webhookDeliveries).values(rows);

    for (const [index, endpoint] of subscribed.entries()) {
      const attempt = attemptDelivery(env, endpoint, rows[index].id, payload);
      // Without a waitUntil — inside a queue consumer, say — the row simply waits for
      // the cron. Delivery is delayed, never lost.
      if (waitUntil) waitUntil(attempt);
      else void attempt.catch(() => undefined);
    }
  } catch {
    // Logging an event must never be the reason a customer's ticket was not created.
  }
}

interface SendOutcome {
  ok: boolean;
  status?: number;
  error?: string;
  /** Terminal failures are abandoned without further attempts. */
  terminal?: boolean;
  retryAfterMs?: number;
}

/** Performs one HTTP attempt, revalidating the destination immediately beforehand. */
async function send(env: AppBindings, endpoint: WebhookEndpoint, payload: WebhookPayload): Promise<SendOutcome> {
  const formatted = formatPayload(endpoint, payload, env.APP_URL);
  if (!formatted) return { ok: false, error: "The endpoint is missing its bot token or chat id.", terminal: true };

  // Re-checked here, not only at creation: DNS can change in between, and this is the
  // check that is actually load-bearing.
  const destination = checkDestination(env, formatted.url);
  if (!destination.ok) return { ok: false, error: destination.message, terminal: true };

  const headers: Record<string, string> = { ...formatted.headers };
  if (formatted.sign) {
    const timestamp = Math.floor(Date.now() / 1000);
    headers["x-resolvehq-signature"] = `t=${timestamp},v1=${await signValue(`${timestamp}.${formatted.body}`, endpoint.secret)}`;
    headers["x-resolvehq-event"] = payload.event;
  }

  try {
    const response = await fetch(formatted.url, {
      method: "POST",
      headers,
      body: formatted.body,
      // A redirect to a different host would bypass the validation above entirely.
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400)
      return { ok: false, status: response.status, error: "The endpoint redirected, which is not followed.", terminal: true };
    // Gone means the consumer has retired this endpoint; retrying is pointless.
    if (response.status === 410)
      return { ok: false, status: 410, error: "The endpoint reported it is gone.", terminal: true };
    if (response.ok) return { ok: true, status: response.status };

    // The body is deliberately not read. It used to be stored on the endpoint and
    // returned by the list and test routes, which turned a destination into a readable
    // probe: status plus 200 bytes of whatever answered. The status is what an operator
    // needs to fix a broken endpoint; the body is the target's, not ours to relay.
    const retryAfter = response.headers.get("retry-after");
    return {
      ok: false,
      status: response.status,
      error: `${response.status} ${response.statusText}`.trim(),
      retryAfterMs: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined,
    };
  } catch (reason) {
    return { ok: false, error: reason instanceof Error ? reason.message.slice(0, 200) : "The request failed." };
  }
}

/**
 * Attempts one delivery and records the outcome, including the endpoint's own health.
 *
 * Exported so the cron retry path and the immediate path share exactly one
 * implementation of what success and failure mean.
 */
export async function attemptDelivery(
  env: AppBindings,
  endpoint: WebhookEndpoint,
  deliveryId: string,
  payload: WebhookPayload,
): Promise<void> {
  const db = createDb(env.DB);
  const outcome = await send(env, endpoint, payload);
  const now = new Date();

  if (outcome.ok) {
    await db.batch([
      db
        .update(webhookDeliveries)
        .set({
          status: "delivered",
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          responseCode: outcome.status ?? null,
          nextAttemptAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.id, deliveryId)),
      db
        .update(webhookEndpoints)
        .set({ failureCount: 0, lastSuccessAt: now, lastError: null, updatedAt: now })
        .where(eq(webhookEndpoints.id, endpoint.id)),
    ]);
    return;
  }

  const [current] = await db
    .select({ attempts: webhookDeliveries.attempts })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  const attempts = (current?.attempts ?? 0) + 1;
  const exhausted = outcome.terminal || attempts >= MAX_ATTEMPTS;
  const backoff = outcome.retryAfterMs ?? BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  const failures = endpoint.failureCount + 1;
  const disabling = failures >= AUTO_DISABLE_AFTER;

  await db.batch([
    db
      .update(webhookDeliveries)
      .set({
        status: exhausted ? "abandoned" : "pending",
        attempts,
        responseCode: outcome.status ?? null,
        lastError: outcome.error ?? "The request failed.",
        nextAttemptAt: exhausted ? null : new Date(Date.now() + backoff),
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, deliveryId)),
    db
      .update(webhookEndpoints)
      .set({
        failureCount: failures,
        lastError: outcome.error ?? "The request failed.",
        // An escalation path nobody has verified is worse than none, so a persistently
        // failing endpoint turns itself off and says so rather than pretending.
        enabled: disabling ? false : endpoint.enabled,
        disabledAt: disabling ? now : endpoint.disabledAt,
        updatedAt: now,
      })
      .where(eq(webhookEndpoints.id, endpoint.id)),
  ]);
}

/**
 * Retries up to twenty due deliveries. Called from the existing five-minute cron; the
 * claim is bounded and the sweep is global across tenants, which is why the retry index
 * is not organization-scoped.
 */
export async function retryDueWebhooks(env: AppBindings, now = Date.now()): Promise<number> {
  const due = await env.DB.prepare(
    "SELECT id, endpoint_id AS endpointId, payload FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20",
  )
    .bind(now)
    .all<{ id: string; endpointId: string; payload: string }>();
  if (!due.results.length) return 0;

  const db = createDb(env.DB);
  for (const delivery of due.results) {
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, delivery.endpointId))
      .limit(1);
    if (!endpoint) continue;
    // A disabled endpoint stops consuming attempts; its queue is abandoned.
    if (!endpoint.enabled) {
      await db
        .update(webhookDeliveries)
        .set({ status: "abandoned", lastError: "The endpoint is disabled.", nextAttemptAt: null, updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
      continue;
    }
    try {
      await attemptDelivery(env, endpoint, delivery.id, JSON.parse(delivery.payload) as WebhookPayload);
    } catch {
      /* One broken delivery must not stop the rest of the sweep. */
    }
  }
  return due.results.length;
}
