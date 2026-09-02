import type { AppDatabase } from "resolve-server/db";
import { activityLogs } from "resolve-server/db/schema";
import { newId } from "resolve-server/lib/id";
import type { TenantContext } from "resolve-server/types";

export async function recordActivity(
  db: AppDatabase,
  tenant: TenantContext,
  event: {
    ticketId?: string;
    eventType: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(activityLogs).values({
    id: newId("act"),
    organizationId: tenant.organizationId,
    ticketId: event.ticketId,
    actorUserId: tenant.userId,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    metadata: event.metadata ?? {},
    requestId: tenant.requestId,
  });
}
