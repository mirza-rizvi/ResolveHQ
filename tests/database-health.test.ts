import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "resolve-server/app";
import {
  expectedMigrations,
  expectedTables,
  isMissingSchemaError,
  missingTables,
  pendingMigrations,
  MIGRATE_COMMAND,
} from "resolve-server/db/health";
import { evaluateReadiness } from "resolve-server/operations/readiness";
import { request, signup } from "./helpers";

/**
 * Stands in for a D1 that was provisioned but never migrated: every statement fails the
 * way the real binding fails, message and cause included.
 */
function unmigratedDatabase(): D1Database {
  const fail = (): never => {
    const error = new Error("D1_ERROR: no such table: users: SQLITE_ERROR");
    (error as Error & { cause?: Error }).cause = new Error("no such table: users: SQLITE_ERROR");
    throw error;
  };
  // A Proxy rather than a hand-written stub: Drizzle calls several statement methods
  // (`raw`, `values`, `bind`, …) and a stub that misses one throws a TypeError instead,
  // which would make this test pass for the wrong reason.
  const statement: unknown = new Proxy(
    {},
    {
      get: (_target, property) => (property === "then" ? undefined : () => (property === "bind" ? statement : fail())),
    },
  );
  return new Proxy(
    {},
    {
      get: (_target, property) => (property === "then" ? undefined : () => (property === "prepare" ? statement : fail())),
    },
  ) as D1Database;
}

describe("unmigrated database", () => {
  it("names the tables the running code expects, straight from the schema", () => {
    const tables = expectedTables();
    // A spread across the releases, so a truncated or stale list fails here.
    expect(tables).toContain("users");
    expect(tables).toContain("tickets");
    expect(tables).toContain("api_keys");
    expect(tables).toContain("backups");
    expect(tables.length).toBeGreaterThan(30);
  });

  it("reports nothing missing against the test database", async () => {
    expect(await missingTables(env.DB)).toEqual([]);
  });

  it("recognises the D1 failure through Drizzle's wrapper", () => {
    const d1 = new Error("D1_ERROR: no such table: users: SQLITE_ERROR");
    expect(isMissingSchemaError(d1)).toBe(true);

    // What Drizzle actually surfaces: its own message says only "Failed query".
    const wrapped = new Error('Failed query: select "id" from "users" where "email" = ?');
    (wrapped as Error & { cause?: Error }).cause = new Error("no such table: users: SQLITE_ERROR");
    expect(isMissingSchemaError(wrapped)).toBe(true);

    expect(isMissingSchemaError(new Error("UNIQUE constraint failed: users.email"))).toBe(false);
    expect(isMissingSchemaError(new Error("network error"))).toBe(false);
    expect(isMissingSchemaError("no such table: users")).toBe(false);
  });

  it("does not loop on an error whose cause points at itself", () => {
    const looping = new Error("Failed query");
    (looping as Error & { cause?: unknown }).cause = looping;
    expect(isMissingSchemaError(looping)).toBe(false);
  });

  it("answers a signup against an unmigrated database with the command that fixes it", async () => {
    const response = await app.request(
      "http://localhost:8787/api/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.APP_URL },
        body: JSON.stringify({
          name: "Test Owner",
          email: "unmigrated@example.test",
          password: "a-secure-test-password",
          organizationName: "Test Workspace",
          organizationSlug: "unmigrated-workspace",
        }),
      },
      { ...env, DB: unmigratedDatabase() },
    );

    // 503, not 500: the deployment is not broken, it is not finished.
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("database_not_migrated");
    expect(body.error.message).toContain(MIGRATE_COMMAND);
  });

  it("reports an unmigrated database as not ready, with the same instruction", async () => {
    const response = await app.request("http://localhost:8787/api/ready", {}, { ...env, DB: unmigratedDatabase() });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; database: string };
    expect(body.ok).toBe(false);
    expect(body.database).toBe("unavailable");
  });

  it("knows which migrations this build expects", () => {
    const migrations = expectedMigrations();
    expect(migrations[0]).toMatch(/^0000_.*\.sql$/);
    expect(migrations).toContain("0014_workspace_backups.sql");
    // The journal is the source, so a new migration file without a journal entry is
    // invisible here exactly as it would be to Wrangler.
    expect(migrations.length).toBeGreaterThanOrEqual(15);
  });

  it("reports nothing pending against the test database", async () => {
    expect(await pendingMigrations(env.DB)).toEqual([]);
  });

  it("notices a half-applied chain that leaves every table in place", async () => {
    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{
      name: string;
    }>();
    expect(applied?.name).toBeTruthy();

    // A migration that only adds a column or an index changes no table name, so the
    // table comparison cannot see it. Removing the record simulates exactly that: the
    // schema looks complete and the chain is not.
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name = ?").bind(applied!.name).run();
    try {
      expect(await missingTables(env.DB)).toEqual([]);
      expect(await pendingMigrations(env.DB)).toEqual([applied!.name]);

      const response = await request("/ready");
      expect(response.status).toBe(503);
      const body = (await response.json()) as { database: string; pendingMigrations: number; detail: string };
      expect(body.database).toBe("unmigrated");
      expect(body.pendingMigrations).toBe(1);
      expect(body.detail).toContain(MIGRATE_COMMAND);
    } finally {
      await env.DB.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, CURRENT_TIMESTAMP)")
        .bind(applied!.name)
        .run();
    }
  });

  it("reports a migrated database as ready", async () => {
    const response = await request("/ready");
    expect(response.status).toBe(200);
    expect((await response.json()) as { ok: boolean }).toEqual({ ok: true, database: "ready" });
  });

  it("puts the schema first on the readiness report", async () => {
    const workspace = await signup("schema-readiness");
    const report = await evaluateReadiness(
      env,
      workspace.organizationId,
      (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    );
    expect(report.checks[0].id).toBe("config.database_schema");
    expect(report.checks[0].status).toBe("ready");
  });
});
