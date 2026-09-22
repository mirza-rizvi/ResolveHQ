import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
// The journal is the list of migrations this build expects. Bundling it is what lets a
// deployed Worker notice that it is running ahead of its own database.
import journal from "../../../drizzle/migrations/meta/_journal.json";

/**
 * The command that fixes an unmigrated database. Quoted verbatim in the API error, in
 * the readiness page, and in the deployment guide — one string, one source of truth.
 */
export const MIGRATE_COMMAND = "npx wrangler d1 migrations apply DB --remote";

/**
 * Every table the running code expects, derived from the Drizzle schema rather than a
 * hand-kept list, so adding a table to `schema.ts` cannot leave this check behind.
 */
export function expectedTables(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema) as unknown[]) {
    if (is(value, SQLiteTable)) names.push(getTableName(value));
  }
  return names.sort();
}

/** Migration file names this build ships, in the order Wrangler applies them. */
export function expectedMigrations(): string[] {
  return journal.entries.map((entry) => `${entry.tag}.sql`);
}

/**
 * Migrations this build expects that the database has not recorded.
 *
 * Comparing table names alone misses a half-applied chain: a migration that adds a
 * column, an index or a constraint leaves the table list identical while the code
 * expects something the database does not have. Wrangler records what it applied in
 * `d1_migrations`, so that is the honest comparison.
 *
 * Returns null when the table is absent, which means the database was created by some
 * other route and there is nothing to compare against — not that everything is fine.
 */
export async function pendingMigrations(database: D1Database): Promise<string[] | null> {
  const table = await database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'")
    .first<{ name: string }>();
  if (!table) return null;
  const applied = await database.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const have = new Set((applied.results ?? []).map((row) => row.name));
  return expectedMigrations().filter((name) => !have.has(name));
}

/**
 * Tables the schema declares that the database does not have. Empty means migrated.
 * One query, no per-table round trip.
 */
export async function missingTables(database: D1Database): Promise<string[]> {
  const present = await database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  const have = new Set((present.results ?? []).map((row) => row.name));
  return expectedTables().filter((name) => !have.has(name));
}

/**
 * Recognises the failure a Worker makes when it is deployed against a database whose
 * migrations were never applied. D1 reports `no such table: <name>`, but Drizzle wraps
 * it — its own message is only `Failed query: …` — so the cause chain has to be walked.
 */
export function isMissingSchemaError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (/no such table/i.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}
