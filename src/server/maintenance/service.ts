import type { AppBindings } from "../types";
import { leaseMs, retryDelay } from "../mail/reliability";
import { refreshTicketSearch } from "../search/index";

export async function requestCustomerRefresh(env: AppBindings, organizationId: string, customerId: string) {
  await env.DB.prepare(
    "INSERT INTO maintenance_tasks (id, kind, organization_id, customer_id) VALUES (?, 'search', ?, ?) ON CONFLICT(id) DO UPDATE SET cursor = NULL, generation = generation + 1, status = 'pending', attempts = 0, dispatch_until = 0, next_attempt_at = 0",
  )
    .bind(`search/${organizationId}/${customerId}`, organizationId, customerId)
    .run();
}

export async function dispatchMaintenance(env: AppBindings) {
  if (!env.MAINTENANCE_QUEUE) return;
  const now = Date.now();
  const rows = await env.DB.prepare(
    "UPDATE maintenance_tasks SET dispatch_until = ? WHERE id IN (SELECT id FROM maintenance_tasks WHERE status = 'pending' AND attempts < 6 AND lease_until <= ? AND dispatch_until <= ? AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 20) RETURNING id",
  )
    .bind(now + leaseMs, now, now, now)
    .all<{ id: string }>();
  if (!rows.results.length) return;
  try {
    await env.MAINTENANCE_QUEUE.sendBatch(
      rows.results.map(({ id }) => ({ body: { kind: "maintenance", taskId: id } })),
    );
  } catch {
    console.error({ event: "maintenance_enqueue_failed" });
  }
}

/** One invocation handles five items, including retries of interrupted deletes. */
export async function processMaintenance(env: AppBindings, taskId: string) {
  const now = Date.now();
  const task = await env.DB.prepare(
    "UPDATE maintenance_tasks SET lease_until = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts < 6 AND lease_until <= ? AND next_attempt_at <= ? RETURNING kind, organization_id AS organizationId, customer_id AS customerId, cursor, generation, attempts",
  )
    .bind(now + leaseMs, taskId, now, now)
    .first<{
      kind: string;
      organizationId: string;
      customerId: string;
      cursor: string | null;
      generation: number;
      attempts: number;
    }>();
  if (!task) return;
  let count = 0,
    cursor = task.cursor;
  try {
    if (task.kind === "search") {
      const rows = await env.DB.prepare(
        "SELECT id FROM tickets WHERE organization_id = ? AND customer_id = ? AND id > ? ORDER BY id LIMIT 5",
      )
        .bind(task.organizationId, task.customerId, cursor ?? "")
        .all<{ id: string }>();
      for (const row of rows.results) {
        await refreshTicketSearch(env.DB, task.organizationId, row.id);
        cursor = row.id;
        count++;
      }
    } else if (task.kind === "attachments") {
      const rows = await env.DB.prepare(
        "UPDATE attachments SET cleanup_claimed_at = ? WHERE id IN (SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ? ORDER BY created_at, id LIMIT 5) RETURNING id, object_key AS objectKey",
      )
        .bind(now, now - 86400000)
        .all<{ id: string; objectKey: string }>();
      for (const row of rows.results) {
        await env.ATTACHMENTS.delete(row.objectKey);
        await env.DB.prepare(
          "DELETE FROM attachments WHERE id = ? AND message_id IS NULL AND cleanup_claimed_at IS NOT NULL",
        )
          .bind(row.id)
          .run();
        count++;
      }
    } else if (task.kind === "staging") {
      const rows = await env.DB.prepare(
        "SELECT id, staging_object_key AS objectKey FROM inbound_mail_events WHERE status IN ('completed','failed') AND updated_at < ? AND lease_until <= ? AND staging_object_key GLOB '_mail-staging/*' ORDER BY updated_at, id LIMIT 5",
      )
        .bind(now - 7 * 86400000, now)
        .all<{ id: string; objectKey: string }>();
      for (const row of rows.results) {
        // Reserve against a manual retry before removing the only raw copy.
        const claimed = await env.DB.prepare(
          "UPDATE inbound_mail_events SET lease_until = ? WHERE id = ? AND lease_until <= ? AND updated_at < ? RETURNING id",
        )
          .bind(now + leaseMs, row.id, now, now - 7 * 86400000)
          .first();
        if (!claimed) continue;
        await env.ATTACHMENTS.delete(row.objectKey);
        await env.DB.prepare(
          "UPDATE inbound_mail_events SET staging_object_key = 'deleted/' || id, lease_until = 0 WHERE id = ?",
        )
          .bind(row.id)
          .run();
        count++;
      }
    } else if (task.kind === "uploads") {
      const rows = await env.DB.prepare(
        "SELECT id, object_key AS objectKey FROM attachment_uploads WHERE created_at < ? ORDER BY created_at LIMIT 5",
      )
        .bind(now - 86400000)
        .all<{ id: string; objectKey: string }>();
      for (const row of rows.results) {
        await env.ATTACHMENTS.delete(row.objectKey);
        await env.DB.prepare("DELETE FROM attachment_uploads WHERE id = ?").bind(row.id).run();
        count++;
      }
    }
    await env.DB.prepare(
      "UPDATE maintenance_tasks SET cursor = ?, status = ?, attempts = 0, dispatch_until = 0, lease_until = 0, next_attempt_at = 0 WHERE id = ? AND generation = ?",
    )
      .bind(cursor, count === 5 ? "pending" : "completed", taskId, task.generation)
      .run();
    // A customer edited during processing invalidates the cursor but still needs the lease released.
    await env.DB.prepare("UPDATE maintenance_tasks SET lease_until = 0 WHERE id = ? AND generation <> ?")
      .bind(taskId, task.generation)
      .run();
  } catch {
    await env.DB.prepare(
      "UPDATE maintenance_tasks SET lease_until = 0, dispatch_until = 0, status = ?, next_attempt_at = ? WHERE id = ? AND generation = ?",
    )
      .bind(task.attempts >= 6 ? "failed" : "pending", now + retryDelay(task.attempts) * 1000, taskId, task.generation)
      .run();
    console.error({ event: "maintenance_failed", operation: task.kind });
    if (task.attempts >= 6 && env.MAINTENANCE_DLQ) await env.MAINTENANCE_DLQ.send({ kind: "maintenance", taskId });
  }
}

export async function discoverCleanup(env: AppBindings) {
  const now = Date.now();
  // No queue messages for empty sweeps, and failed tasks require operator recovery.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO maintenance_tasks (id, kind) SELECT 'cleanup/attachments', 'attachments' WHERE EXISTS (SELECT 1 FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT 1) ON CONFLICT(id) DO UPDATE SET status = 'pending' WHERE maintenance_tasks.status = 'completed'",
    ).bind(now - 86400000),
    env.DB.prepare(
      "INSERT INTO maintenance_tasks (id, kind) SELECT 'cleanup/uploads', 'uploads' WHERE EXISTS (SELECT 1 FROM attachment_uploads WHERE created_at < ? LIMIT 1) ON CONFLICT(id) DO UPDATE SET status = 'pending' WHERE maintenance_tasks.status = 'completed'",
    ).bind(now - 86400000),
    env.DB.prepare(
      "INSERT INTO maintenance_tasks (id, kind) SELECT 'cleanup/staging', 'staging' WHERE EXISTS (SELECT 1 FROM inbound_mail_events WHERE status IN ('completed','failed') AND updated_at < ? AND staging_object_key GLOB '_mail-staging/*' LIMIT 1) ON CONFLICT(id) DO UPDATE SET status = 'pending' WHERE maintenance_tasks.status = 'completed'",
    ).bind(now - 7 * 86400000),
  ]);
}
