import type { AppBindings } from "../types";
import { HttpError } from "../http/errors";
import { newId } from "../lib/id";
import { READINESS_CACHE_KEY } from "../operations/readiness";

/**
 * How a table is narrowed to one workspace. Everything is keyset-paginated by `rowid`
 * rather than by the primary key, because several exported tables have composite keys.
 */
type ExportScope = "organization" | "workspace" | "members";

export interface ExportTable {
  table: string;
  scope: ExportScope;
  /** Returns null to drop the row entirely. Runs before anything is written to R2. */
  redact?: (row: Record<string, unknown>) => Record<string, unknown> | null;
}

function omit(row: Record<string, unknown>, ...columns: string[]): Record<string, unknown> {
  const copy = { ...row };
  for (const column of columns) delete copy[column];
  return copy;
}

/**
 * Every tenant-scoped table, in dependency order so a reader can replay the export
 * top to bottom. Deliberately absent: `sessions` and `password_reset_tokens` (live
 * credentials), `mail_captures` (a local dev artefact), `ticket_search_rows` and
 * `ticket_search` (derived indexes), `maintenance_tasks`, `attachment_uploads`,
 * `provider_webhook_events` and `mail_dlq_events` (transient machinery), and `backups`
 * itself. Attachment *metadata* is exported; attachment bytes are not.
 */
export const EXPORT_TABLES: ExportTable[] = [
  { table: "organizations", scope: "workspace" },
  { table: "users", scope: "members", redact: (row) => omit(row, "password_hash") },
  { table: "organization_memberships", scope: "organization" },
  { table: "organization_invitations", scope: "organization", redact: (row) => omit(row, "token_hash") },
  { table: "inboxes", scope: "organization" },
  { table: "teams", scope: "organization" },
  { table: "team_members", scope: "organization" },
  { table: "customers", scope: "organization" },
  { table: "customer_identities", scope: "organization" },
  { table: "tags", scope: "organization" },
  { table: "customer_tags", scope: "organization" },
  { table: "tickets", scope: "organization" },
  { table: "ticket_tags", scope: "organization" },
  { table: "ticket_assignments", scope: "organization" },
  { table: "ticket_read_states", scope: "organization" },
  { table: "ticket_drafts", scope: "organization" },
  { table: "messages", scope: "organization" },
  { table: "attachments", scope: "organization" },
  { table: "saved_views", scope: "organization" },
  { table: "saved_replies", scope: "organization" },
  { table: "notifications", scope: "organization" },
  { table: "activity_logs", scope: "organization" },
  { table: "sla_policies", scope: "organization" },
  { table: "csat_responses", scope: "organization" },
  { table: "knowledge_base_articles", scope: "organization" },
  { table: "automation_rules", scope: "organization" },
  { table: "automation_runs", scope: "organization" },
  // Metadata only: the hash is the credential, and a restored hash would be a live key.
  { table: "api_keys", scope: "organization", redact: (row) => omit(row, "key_hash") },
  // `secret` signs deliveries and `config` holds a Telegram bot token; for Slack and
  // Telegram the URL is itself the credential.
  {
    table: "webhook_endpoints",
    scope: "organization",
    redact: (row) => {
      const stripped = omit(row, "secret", "config");
      return row.kind === "generic" ? stripped : omit(stripped, "url");
    },
  },
  { table: "webhook_deliveries", scope: "organization" },
  { table: "inbound_mail_events", scope: "organization", redact: (row) => omit(row, "staging_object_key") },
  { table: "outbound_mail_jobs", scope: "organization" },
  // A cache, not configuration: exporting it would date the moment it was written.
  {
    table: "settings",
    scope: "organization",
    // Compare against the exported constant, not a literal. This shipped as
    // "readiness_cache" against a key that is actually "readiness.cache", so the
    // branch never fired and no test noticed.
    redact: (row) => (row.key === READINESS_CACHE_KEY ? null : row),
  },
];

export const BACKUP_PREFIX = "_backups/";
export const DEFAULT_RETAIN_DAYS = 30;
const MIN_RETAIN_DAYS = 1;
const MAX_RETAIN_DAYS = 365;
const DAY_MS = 86_400_000;
const AUTO_BACKUP_INTERVAL_MS = 7 * DAY_MS;
/** A failed export keeps its partial chunks briefly for diagnosis, then they are reclaimed. */
const FAILED_RETENTION_MS = DAY_MS;
/** A running export that has not advanced for this long is treated as abandoned. */
const ABANDONED_RUNNING_MS = 6 * 60 * 60 * 1000;

// A cron tick shares its D1 budget with every other sweep, so an export takes a slice
// and leaves. The query cap is what keeps `runScheduled` well inside the Free-plan
// statement ceiling even while a backup is walking empty tables.
const DEFAULT_LIMITS = { chunkRows: 200, maxRowsPerRun: 1000, maxChunksPerRun: 10, maxQueriesPerRun: 12 };

export interface AdvanceLimits {
  chunkRows?: number;
  maxRowsPerRun?: number;
  maxChunksPerRun?: number;
  maxQueriesPerRun?: number;
}

export interface BackupSchedule {
  enabled: boolean;
  retainDays: number;
}

interface BackupCursor {
  table: string;
  rowId: number;
  seq: number;
}

interface BackupRow {
  id: string;
  organizationId: string;
  status: string;
  objectPrefix: string;
  sizeBytes: number;
  rowCounts: string;
  cursor: string | null;
}

export const SCHEDULE_SETTING_KEY = "backup_schedule";

export function clampRetainDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETAIN_DAYS;
  return Math.min(MAX_RETAIN_DAYS, Math.max(MIN_RETAIN_DAYS, Math.round(value)));
}

export async function readSchedule(env: AppBindings, organizationId: string): Promise<BackupSchedule> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE organization_id = ? AND key = ?")
    .bind(organizationId, SCHEDULE_SETTING_KEY)
    .first<{ value: string }>();
  if (!row?.value) return { enabled: false, retainDays: DEFAULT_RETAIN_DAYS };
  try {
    const parsed = JSON.parse(row.value) as Partial<BackupSchedule>;
    return {
      enabled: parsed.enabled === true,
      retainDays: clampRetainDays(Number(parsed.retainDays ?? DEFAULT_RETAIN_DAYS)),
    };
  } catch {
    return { enabled: false, retainDays: DEFAULT_RETAIN_DAYS };
  }
}

export async function writeSchedule(
  env: AppBindings,
  organizationId: string,
  userId: string,
  schedule: BackupSchedule,
): Promise<BackupSchedule> {
  const stored: BackupSchedule = { enabled: schedule.enabled, retainDays: clampRetainDays(schedule.retainDays) };
  await env.DB.prepare(
    "INSERT INTO settings (organization_id, key, value, updated_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at",
  )
    .bind(organizationId, SCHEDULE_SETTING_KEY, JSON.stringify(stored), userId, Date.now())
    .run();
  return stored;
}

/**
 * Starts an export. One at a time per workspace, and one per day: each backup is a full
 * copy of the workspace, and the R2 free allowance is the binding constraint.
 */
export async function startBackup(
  env: AppBindings,
  input: { organizationId: string; userId: string | null; now?: number },
): Promise<{ id: string }> {
  const now = input.now ?? Date.now();
  const running = await env.DB.prepare(
    "SELECT id FROM backups WHERE organization_id = ? AND status = 'running' LIMIT 1",
  )
    .bind(input.organizationId)
    .first<{ id: string }>();
  if (running) throw new HttpError(409, "backup_in_progress", "A backup is already running for this workspace.");

  const recent = await env.DB.prepare(
    "SELECT id FROM backups WHERE organization_id = ? AND started_at > ? LIMIT 1",
  )
    .bind(input.organizationId, now - DAY_MS)
    .first<{ id: string }>();
  if (recent) throw new HttpError(429, "backup_daily_limit", "One backup per workspace per day. Try again tomorrow.");

  const schedule = await readSchedule(env, input.organizationId);
  const id = newId("bkp");
  await env.DB.prepare(
    "INSERT INTO backups (id, organization_id, status, object_prefix, size_bytes, row_counts, cursor, requested_by_user_id, started_at, expires_at, created_at, updated_at) VALUES (?, ?, 'running', ?, 0, '{}', NULL, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      input.organizationId,
      `${BACKUP_PREFIX}${input.organizationId}/${id}/`,
      input.userId,
      now,
      now + schedule.retainDays * DAY_MS,
      now,
      now,
    )
    .run();
  return { id };
}

function scopeClause(scope: ExportScope): string {
  if (scope === "workspace") return "id = ?";
  if (scope === "members") return "id IN (SELECT user_id FROM organization_memberships WHERE organization_id = ?)";
  return "organization_id = ?";
}

function parseCursor(raw: string | null): BackupCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as BackupCursor;
      if (typeof parsed.table === "string") return parsed;
    } catch {
      // Fall through and restart from the first table.
    }
  }
  return { table: EXPORT_TABLES[0].table, rowId: 0, seq: 0 };
}

/**
 * Does one bounded slice of an export and returns whether the backup is finished.
 * R2 objects are not appendable, so every slice is written as its own numbered object
 * and the download route concatenates them; that keeps memory flat whatever the
 * workspace's size.
 */
export async function advanceBackup(
  env: AppBindings,
  backupId: string,
  limits: AdvanceLimits = {},
): Promise<{ done: boolean; rows: number }> {
  const chunkRows = limits.chunkRows ?? DEFAULT_LIMITS.chunkRows;
  const maxRows = limits.maxRowsPerRun ?? DEFAULT_LIMITS.maxRowsPerRun;
  const maxChunks = limits.maxChunksPerRun ?? DEFAULT_LIMITS.maxChunksPerRun;
  const maxQueries = limits.maxQueriesPerRun ?? DEFAULT_LIMITS.maxQueriesPerRun;

  const backup = await env.DB.prepare(
    "SELECT id, organization_id AS organizationId, status, object_prefix AS objectPrefix, size_bytes AS sizeBytes, row_counts AS rowCounts, cursor FROM backups WHERE id = ?",
  )
    .bind(backupId)
    .first<BackupRow>();
  if (!backup || backup.status !== "running") return { done: true, rows: 0 };

  let cursor = parseCursor(backup.cursor);
  const rowCounts = JSON.parse(backup.rowCounts) as Record<string, number>;
  let sizeBytes = backup.sizeBytes;
  let rows = 0;
  let chunks = 0;
  let queries = 0;
  let done = false;

  try {
    // The query budget also bounds the walk across empty tables: a small workspace
    // crosses several tables per tick instead of spending a whole tick on each.
    for (;;) {
      if (rows >= maxRows || chunks >= maxChunks || queries >= maxQueries) break;
      const index = EXPORT_TABLES.findIndex((entry) => entry.table === cursor.table);
      if (index === -1) {
        done = true;
        break;
      }
      const entry = EXPORT_TABLES[index];
      const page = await env.DB.prepare(
        `SELECT rowid AS __rowid, * FROM "${entry.table}" WHERE ${scopeClause(entry.scope)} AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
        .bind(backup.organizationId, cursor.rowId, chunkRows)
        .all<Record<string, unknown>>();
      queries += 1;
      const results = page.results ?? [];

      if (results.length === 0) {
        const next = EXPORT_TABLES[index + 1];
        if (!next) {
          done = true;
          break;
        }
        cursor = { table: next.table, rowId: 0, seq: 0 };
        continue;
      }

      const lastRowId = Number(results[results.length - 1].__rowid);
      const lines: string[] = [];
      for (const raw of results) {
        const row = { ...raw };
        delete row.__rowid;
        const kept = entry.redact ? entry.redact(row) : row;
        if (kept) lines.push(JSON.stringify(kept));
      }

      if (lines.length > 0) {
        const body = `${lines.join("\n")}\n`;
        const bytes = new TextEncoder().encode(body);
        await env.ATTACHMENTS.put(`${backup.objectPrefix}${entry.table}.${cursor.seq}.ndjson`, bytes, {
          httpMetadata: { contentType: "application/x-ndjson" },
        });
        sizeBytes += bytes.byteLength;
        rowCounts[entry.table] = (rowCounts[entry.table] ?? 0) + lines.length;
        chunks += 1;
      }

      rows += results.length;
      cursor = { table: entry.table, rowId: lastRowId, seq: cursor.seq + 1 };
    }
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "The export failed.";
    await env.DB.prepare("UPDATE backups SET status = 'failed', error = ?, cursor = ?, updated_at = ? WHERE id = ?")
      .bind(message.slice(0, 500), JSON.stringify(cursor), Date.now(), backupId)
      .run();
    return { done: true, rows };
  }

  const now = Date.now();
  if (done) {
    await env.DB.prepare(
      "UPDATE backups SET status = 'completed', cursor = NULL, row_counts = ?, size_bytes = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(JSON.stringify(rowCounts), sizeBytes, now, now, backupId)
      .run();
  } else {
    await env.DB.prepare("UPDATE backups SET cursor = ?, row_counts = ?, size_bytes = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(cursor), JSON.stringify(rowCounts), sizeBytes, now, backupId)
      .run();
  }
  return { done, rows };
}

/** Deletes every object beneath a prefix, a page at a time. */
export async function deleteObjects(env: AppBindings, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.ATTACHMENTS.list({ prefix, cursor, limit: 500 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await env.ATTACHMENTS.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/**
 * Advances at most one running backup per tick and, when the weekly schedule is on,
 * starts one for a workspace that is due. Bounded like every other cron step.
 */
export async function advanceBackups(env: AppBindings, limits: AdvanceLimits = {}): Promise<void> {
  // Ordered by least-recently-advanced, not by start time: with ORDER BY started_at a
  // single large or fast-growing workspace holds the only slot indefinitely and every
  // other tenant's export makes no progress at all.
  const running = await env.DB.prepare(
    "SELECT id FROM backups WHERE status = 'running' ORDER BY updated_at LIMIT 1",
  ).first<{ id: string }>();
  if (running) {
    await advanceBackup(env, running.id, limits);
    return;
  }

  const now = Date.now();
  const due = await env.DB.prepare(
    "SELECT organization_id AS organizationId FROM settings WHERE key = ? AND json_extract(value, '$.enabled') = 1 AND NOT EXISTS (SELECT 1 FROM backups WHERE backups.organization_id = settings.organization_id AND backups.started_at > ?) ORDER BY organization_id LIMIT 1",
  )
    .bind(SCHEDULE_SETTING_KEY, now - AUTO_BACKUP_INTERVAL_MS)
    .first<{ organizationId: string }>();
  if (!due) return;
  try {
    await startBackup(env, { organizationId: due.organizationId, userId: null, now });
  } catch (reason) {
    if (!(reason instanceof HttpError)) throw reason;
  }
}

/** Marks due backups expired and removes their objects. Five at a time: each implies several R2 deletes. */
export async function sweepExpiredBackups(env: AppBindings, now: number): Promise<void> {
  // Three kinds of reclaimable backup, not one:
  //   completed and past its expiry;
  //   failed, whose partial chunks were previously left in R2 forever because the sweep
  //     only ever looked at completed rows;
  //   running but abandoned, which a Worker that died mid-chunk leaves behind and which
  //     would otherwise hold the single advance slot and its objects indefinitely.
  const due = await env.DB.prepare(
    `SELECT id, object_prefix AS objectPrefix FROM backups
       WHERE (status = 'completed' AND expires_at IS NOT NULL AND expires_at <= ?)
          OR (status = 'failed' AND updated_at <= ?)
          OR (status = 'running' AND updated_at <= ?)
       ORDER BY updated_at LIMIT 5`,
  )
    .bind(now, now - FAILED_RETENTION_MS, now - ABANDONED_RUNNING_MS)
    .all<{ id: string; objectPrefix: string }>();
  for (const backup of due.results ?? []) {
    await deleteObjects(env, backup.objectPrefix);
    await env.DB.prepare(
      "UPDATE backups SET status = 'expired', size_bytes = 0, cursor = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(now, backup.id)
      .run();
  }
}

export interface BackupFile {
  table: string;
  chunks: number;
  bytes: number;
}

/** Groups the chunk objects back into one entry per table. */
export async function listBackupFiles(env: AppBindings, prefix: string): Promise<BackupFile[]> {
  const files = new Map<string, BackupFile>();
  let cursor: string | undefined;
  do {
    const listed = await env.ATTACHMENTS.list({ prefix, cursor, limit: 500 });
    for (const object of listed.objects) {
      const name = object.key.slice(prefix.length);
      const table = name.split(".")[0];
      const existing = files.get(table) ?? { table, chunks: 0, bytes: 0 };
      existing.chunks += 1;
      existing.bytes += object.size;
      files.set(table, existing);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return [...files.values()].sort((left, right) => left.table.localeCompare(right.table));
}

/**
 * Streams one table's chunks back as a single NDJSON body, in the order they were
 * written. Nothing is buffered beyond the chunk currently in flight.
 */
export async function streamTable(env: AppBindings, prefix: string, table: string): Promise<ReadableStream | null> {
  const keys: Array<{ key: string; seq: number }> = [];
  let cursor: string | undefined;
  do {
    const listed = await env.ATTACHMENTS.list({ prefix: `${prefix}${table}.`, cursor, limit: 500 });
    for (const object of listed.objects) {
      const seq = Number(object.key.slice(`${prefix}${table}.`.length).replace(".ndjson", ""));
      if (Number.isFinite(seq)) keys.push({ key: object.key, seq });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  if (keys.length === 0) return null;
  keys.sort((left, right) => left.seq - right.seq);

  const bucket = env.ATTACHMENTS;
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      while (index < keys.length) {
        const object = await bucket.get(keys[index].key);
        index += 1;
        if (!object) continue;
        controller.enqueue(new Uint8Array(await object.arrayBuffer()));
        return;
      }
      controller.close();
    },
  });
}
