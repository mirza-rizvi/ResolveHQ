import type { AppDatabase } from "resolve-server/db";
import { activityLogs } from "resolve-server/db/schema";
import { newId } from "resolve-server/lib/id";
import type { TenantContext } from "resolve-server/types";

export type ActorType = "user" | "customer" | "automation" | "ai" | "api_key" | "system";

/**
 * Metadata keys that must never reach `activity_logs`. The table is not swept by
 * customer erasure, so anything landing here outlives a deletion request.
 * Compared case-insensitively.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  "address",
  "body",
  "content",
  "credential",
  "email",
  "filename",
  "password",
  "raw",
  "recipient",
  "secret",
  "subject",
  "token",
]);

/**
 * Actor types where the entry is not attributable to a signed-in person, even when
 * one happened to be in the request context. `ai` is deliberately absent: a human
 * asked for the suggestion, so the requesting user stays on the row.
 */
const IMPERSONAL_ACTORS = new Set<ActorType>(["customer", "automation", "system"]);

/**
 * Strips denylisted top-level keys and lists what was removed under `redacted`.
 *
 * Strips rather than throws: a refused activity write inside mail ingestion would
 * fail the whole ingestion for a logging concern. Nested objects are not traversed —
 * deep traversal on every write is not worth the CPU on a 10 ms budget.
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) redacted.push(key);
    else clean[key] = value;
  }
  if (redacted.length) clean.redacted = redacted;
  return clean;
}

export interface ActivityEvent {
  ticketId?: string;
  eventType: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  /** Defaults to `user`. */
  actorType?: ActorType;
  /** Display only — a rule name, a model id, an API key name. Never authorization. */
  actorLabel?: string | null;
}

/**
 * Builds the row every activity write must go through, so the denylist and the
 * actor rules apply on paths that cannot call {@link recordActivity} — notably
 * inserts batched inside a `DB.batch`.
 */
export function buildActivityRow(
  context: { organizationId: string; userId?: string | null; requestId?: string | null },
  event: ActivityEvent,
) {
  const actorType: ActorType = event.actorType ?? "user";
  return {
    id: newId("act"),
    organizationId: context.organizationId,
    ticketId: event.ticketId,
    actorUserId: IMPERSONAL_ACTORS.has(actorType) ? null : (context.userId ?? null),
    actorType,
    actorLabel: event.actorLabel ?? null,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    metadata: sanitizeMetadata(event.metadata ?? {}),
    requestId: context.requestId ?? null,
  };
}

export async function recordActivity(db: AppDatabase, tenant: TenantContext, event: ActivityEvent) {
  await db.insert(activityLogs).values(
    buildActivityRow(
      { organizationId: tenant.organizationId, userId: tenant.userId, requestId: tenant.requestId },
      event,
    ),
  );
}
