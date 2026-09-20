import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

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
