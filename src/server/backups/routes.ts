import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { backups } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import type { HonoEnv } from "../types";
import {
  deleteObjects,
  listBackupFiles,
  readSchedule,
  startBackup,
  streamTable,
  writeSchedule,
  EXPORT_TABLES,
} from "./service";

const scheduleInput = z.object({
  enabled: z.boolean(),
  retainDays: z.number().int().min(1).max(365),
});

export const backupRoutes = new Hono<HonoEnv>();
backupRoutes.use("*", requireAuth, requireRole("admin"));

async function assertBackup(database: D1Database, organizationId: string, id: string) {
  const [row] = await createDb(database)
    .select({ id: backups.id, objectPrefix: backups.objectPrefix, status: backups.status })
    .from(backups)
    .where(and(eq(backups.id, id), eq(backups.organizationId, organizationId)))
    .limit(1);
  // 404 rather than 403: a caller must not learn that another workspace's backup exists.
  if (!row) throw new HttpError(404, "backup_not_found", "Backup not found.");
  return row;
}

backupRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const rows = await createDb(context.env.DB)
    .select({
      id: backups.id,
      status: backups.status,
      sizeBytes: backups.sizeBytes,
      rowCounts: backups.rowCounts,
      cursor: backups.cursor,
      requestedByUserId: backups.requestedByUserId,
      startedAt: backups.startedAt,
      completedAt: backups.completedAt,
      expiresAt: backups.expiresAt,
      error: backups.error,
    })
    .from(backups)
    .where(eq(backups.organizationId, tenant.organizationId))
    .orderBy(desc(backups.startedAt))
    .limit(20);

  return context.json({
    backups: rows.map((row) => ({
      ...row,
      // What the UI shows while an export is in flight, so a multi-tick run does not
      // read as a stuck spinner.
      progressTable: row.cursor?.table ?? null,
      rowsExported: Object.values(row.rowCounts ?? {}).reduce((total, count) => total + count, 0),
    })),
    schedule: await readSchedule(context.env, tenant.organizationId),
    tables: EXPORT_TABLES.length,
  });
});

backupRoutes.post("/", async (context) => {
  const tenant = context.get("tenant");
  if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `backup:${tenant.organizationId}` })).success)
    throw new HttpError(429, "rate_limited", "Slow down and try again in a moment.");
  const started = await startBackup(context.env, {
    organizationId: tenant.organizationId,
    userId: tenant.userId,
  });
  const [row] = await createDb(context.env.DB)
    .select()
    .from(backups)
    .where(eq(backups.id, started.id))
    .limit(1);
  return context.json({ backup: row }, 201);
});

backupRoutes.put("/schedule", validate("json", scheduleInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const schedule = await writeSchedule(context.env, tenant.organizationId, tenant.userId, input);
  return context.json({ schedule });
});

backupRoutes.get("/:id/files", async (context) => {
  const tenant = context.get("tenant");
  const backup = await assertBackup(context.env.DB, tenant.organizationId, context.req.param("id"));
  return context.json({ files: await listBackupFiles(context.env, backup.objectPrefix) });
});

backupRoutes.get("/:id/download/:table", async (context) => {
  const tenant = context.get("tenant");
  const backup = await assertBackup(context.env.DB, tenant.organizationId, context.req.param("id"));
  const table = context.req.param("table").replace(/\.ndjson$/, "");
  // Only ever a table this export writes: the name reaches an R2 key, never SQL.
  if (!EXPORT_TABLES.some((entry) => entry.table === table))
    throw new HttpError(404, "backup_file_not_found", "That table is not part of a workspace export.");

  const body = await streamTable(context.env, backup.objectPrefix, table);
  if (!body) throw new HttpError(404, "backup_file_not_found", "That file is not part of this backup.");
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${table}.ndjson"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

backupRoutes.delete("/:id", async (context) => {
  const tenant = context.get("tenant");
  const backup = await assertBackup(context.env.DB, tenant.organizationId, context.req.param("id"));
  await deleteObjects(context.env, backup.objectPrefix);
  // The row is kept and marked expired rather than deleted. Deleting it also deleted the
  // only record the one-per-day cap reads, so start-then-delete looped without limit.
  // Nothing is downloadable once the objects are gone, which is what "deleted" has to mean.
  await createDb(context.env.DB)
    .update(backups)
    .set({ status: "expired", sizeBytes: 0, cursor: null, error: null })
    .where(eq(backups.id, backup.id));
  return context.body(null, 204);
});
