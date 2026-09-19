import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { advanceBackup, EXPORT_TABLES, sweepExpiredBackups } from "resolve-server/backups/service";
import { runScheduled } from "resolve-server/maintenance/scheduled";
import { request, signup, type TestSession } from "./helpers";

/** Small limits so a handful of seeded rows still exercises chunking and resumption. */
const TINY = { chunkRows: 1, maxRowsPerRun: 1, maxChunksPerRun: 1 };

async function seedTicket(session: TestSession, suffix: string) {
  const customer = await request(
    "/customers",
    { method: "POST", body: JSON.stringify({ name: "Casey", email: `casey-${suffix}@example.test` }) },
    session,
  );
  const customerId = ((await customer.json()) as { customer: { id: string } }).customer.id;
  const created = await request(
    "/tickets",
    { method: "POST", body: JSON.stringify({ customerId, subject: `Subject ${suffix}`, message: "Hello" }) },
    session,
  );
  expect(created.status).toBe(201);
  return ((await created.json()) as { ticket: { id: string } }).ticket;
}

async function startBackup(session: TestSession) {
  const response = await request("/organization/backups", { method: "POST" }, session);
  expect(response.status).toBe(201);
  return ((await response.json()) as { backup: { id: string } }).backup;
}

async function runToCompletion(backupId: string, limits: Record<string, number> = TINY) {
  for (let step = 0; step < 4000; step += 1) {
    const { done } = await advanceBackup(env, backupId, limits);
    if (done) return step + 1;
  }
  throw new Error("Backup did not finish within the step budget");
}

async function readBackup(backupId: string) {
  const row = await env.DB.prepare(
    "SELECT status, cursor, row_counts AS rowCounts, size_bytes AS sizeBytes, error FROM backups WHERE id = ?",
  )
    .bind(backupId)
    .first<{ status: string; cursor: string | null; rowCounts: string; sizeBytes: number; error: string | null }>();
  if (!row) throw new Error("Backup row missing");
  return {
    ...row,
    cursor: row.cursor ? (JSON.parse(row.cursor) as { table: string; rowId: number; seq: number }) : null,
    rowCounts: JSON.parse(row.rowCounts) as Record<string, number>,
  };
}

async function download(session: TestSession, backupId: string, table: string) {
  return request(`/organization/backups/${backupId}/download/${table}`, {}, session);
}

async function downloadLines(session: TestSession, backupId: string, table: string) {
  const response = await download(session, backupId, table);
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("workspace backups", () => {
  it("completes across many bounded invocations and records per-table row counts", async () => {
    const workspace = await signup("backup-complete");
    await seedTicket(workspace, "backup-complete");
    const backup = await startBackup(workspace);

    const steps = await runToCompletion(backup.id);
    expect(steps).toBeGreaterThan(1);

    const finished = await readBackup(backup.id);
    expect(finished.status).toBe("completed");
    expect(finished.cursor).toBeNull();
    expect(finished.error).toBeNull();
    expect(finished.sizeBytes).toBeGreaterThan(0);

    const ticketCount = await env.DB.prepare("SELECT COUNT(*) AS total FROM tickets WHERE organization_id = ?")
      .bind(workspace.organizationId)
      .first<{ total: number }>();
    expect(finished.rowCounts.tickets).toBe(ticketCount?.total);

    const messageCount = await env.DB.prepare("SELECT COUNT(*) AS total FROM messages WHERE organization_id = ?")
      .bind(workspace.organizationId)
      .first<{ total: number }>();
    expect(finished.rowCounts.messages).toBe(messageCount?.total);
  });

  it("resumes from the cursor rather than restarting the table", async () => {
    const workspace = await signup("backup-resume");
    await seedTicket(workspace, "backup-resume-a");
    await seedTicket(workspace, "backup-resume-b");
    await seedTicket(workspace, "backup-resume-c");
    const backup = await startBackup(workspace);

    let previous = { table: "", rowId: -1 };
    for (let step = 0; step < 6; step += 1) {
      await advanceBackup(env, backup.id, TINY);
      const state = await readBackup(backup.id);
      if (!state.cursor) break;
      if (state.cursor.table === previous.table) expect(state.cursor.rowId).toBeGreaterThan(previous.rowId);
      previous = { table: state.cursor.table, rowId: state.cursor.rowId };
    }

    await runToCompletion(backup.id);
    const finished = await readBackup(backup.id);
    expect(finished.status).toBe("completed");
    // Three tickets, exported exactly once each despite the interruptions.
    expect(finished.rowCounts.tickets).toBe(3);
    const lines = await downloadLines(workspace, backup.id, "tickets");
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((line) => line.id as string)).size).toBe(3);
  });

  it("never exports another organization's rows", async () => {
    const alpha = await signup("backup-tenant-alpha");
    const beta = await signup("backup-tenant-beta");
    const alphaTicket = await seedTicket(alpha, "backup-tenant-alpha");
    await seedTicket(beta, "backup-tenant-beta");

    const backup = await startBackup(beta);
    await runToCompletion(backup.id);

    const tickets = await downloadLines(beta, backup.id, "tickets");
    expect(tickets.some((row) => row.id === alphaTicket.id)).toBe(false);
    expect(tickets.every((row) => row.organization_id === beta.organizationId)).toBe(true);

    const customers = await downloadLines(beta, backup.id, "customers");
    expect(customers.every((row) => row.organization_id === beta.organizationId)).toBe(true);
  });

  it("omits credential tables and credential columns", async () => {
    const workspace = await signup("backup-secrets");
    await request(
      "/organization/api-keys",
      { method: "POST", body: JSON.stringify({ name: "Backup key", scopes: ["tickets:read"] }) },
      workspace,
    );
    await request(
      "/organization/webhooks",
      {
        method: "POST",
        body: JSON.stringify({ kind: "generic", url: "https://example.com/hook", events: ["ticket.created"] }),
      },
      workspace,
    );

    const tableNames = EXPORT_TABLES.map((entry) => entry.table);
    expect(tableNames).not.toContain("sessions");
    expect(tableNames).not.toContain("password_reset_tokens");
    expect(tableNames).not.toContain("mail_captures");
    expect(tableNames).not.toContain("backups");

    const backup = await startBackup(workspace);
    await runToCompletion(backup.id);

    const manifest = (await (
      await request(`/organization/backups/${backup.id}/files`, {}, workspace)
    ).json()) as { files: Array<{ table: string }> };
    expect(manifest.files.some((file) => file.table === "sessions")).toBe(false);
    expect(manifest.files.some((file) => file.table === "password_reset_tokens")).toBe(false);

    const keys = await downloadLines(workspace, backup.id, "api_keys");
    expect(keys).not.toHaveLength(0);
    expect(keys.every((row) => !("key_hash" in row))).toBe(true);

    const endpoints = await downloadLines(workspace, backup.id, "webhook_endpoints");
    expect(endpoints).not.toHaveLength(0);
    expect(endpoints.every((row) => !("secret" in row) && !("config" in row))).toBe(true);

    const users = await downloadLines(workspace, backup.id, "users");
    expect(users.every((row) => !("password_hash" in row))).toBe(true);

    expect((await download(workspace, backup.id, "sessions")).status).toBe(404);
  });

  it("refuses a second backup while one is running, and a second backup the same day", async () => {
    const workspace = await signup("backup-one-at-a-time");
    const backup = await startBackup(workspace);

    const concurrent = await request("/organization/backups", { method: "POST" }, workspace);
    expect(concurrent.status).toBe(409);
    expect(((await concurrent.json()) as { error: { code: string } }).error.code).toBe("backup_in_progress");

    await runToCompletion(backup.id);
    const sameDay = await request("/organization/backups", { method: "POST" }, workspace);
    expect(sameDay.status).toBe(429);
    expect(((await sameDay.json()) as { error: { code: string } }).error.code).toBe("backup_daily_limit");
  });

  it("sweeps expired backups, deleting both the row state and the objects", async () => {
    const workspace = await signup("backup-expiry");
    await seedTicket(workspace, "backup-expiry");
    const backup = await startBackup(workspace);
    await runToCompletion(backup.id);

    const prefix = (
      await env.DB.prepare("SELECT object_prefix AS prefix FROM backups WHERE id = ?")
        .bind(backup.id)
        .first<{ prefix: string }>()
    )?.prefix as string;
    expect((await env.ATTACHMENTS.list({ prefix })).objects.length).toBeGreaterThan(0);

    await env.DB.prepare("UPDATE backups SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, backup.id)
      .run();
    await sweepExpiredBackups(env, Date.now());

    expect((await readBackup(backup.id)).status).toBe("expired");
    expect((await env.ATTACHMENTS.list({ prefix })).objects).toHaveLength(0);
    expect((await download(workspace, backup.id, "tickets")).status).toBe(404);
  });

  it("deletes a backup's objects on request", async () => {
    const workspace = await signup("backup-delete");
    const backup = await startBackup(workspace);
    await runToCompletion(backup.id);
    const prefix = (
      await env.DB.prepare("SELECT object_prefix AS prefix FROM backups WHERE id = ?")
        .bind(backup.id)
        .first<{ prefix: string }>()
    )?.prefix as string;

    const deleted = await request(`/organization/backups/${backup.id}`, { method: "DELETE" }, workspace);
    expect(deleted.status).toBe(204);
    expect((await env.ATTACHMENTS.list({ prefix })).objects).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT id FROM backups WHERE id = ?").bind(backup.id).first<{ id: string }>(),
    ).toBeNull();
  });

  it("scopes listing and download to the owning workspace", async () => {
    const alpha = await signup("backup-scope-alpha");
    const beta = await signup("backup-scope-beta");
    const backup = await startBackup(alpha);
    await runToCompletion(backup.id);

    const list = (await (await request("/organization/backups", {}, beta)).json()) as {
      backups: Array<{ id: string }>;
    };
    expect(list.backups.some((row) => row.id === backup.id)).toBe(false);

    expect((await download(beta, backup.id, "tickets")).status).toBe(404);
    expect((await request(`/organization/backups/${backup.id}/files`, {}, beta)).status).toBe(404);
    expect((await request(`/organization/backups/${backup.id}`, { method: "DELETE" }, beta)).status).toBe(404);
  });

  it("is closed to agents", async () => {
    const workspace = await signup("backup-agent");
    const backup = await startBackup(workspace);
    await runToCompletion(backup.id);

    await env.DB.prepare("UPDATE organization_memberships SET role = 'agent' WHERE organization_id = ? AND user_id = ?")
      .bind(workspace.organizationId, workspace.userId)
      .run();

    expect((await request("/organization/backups", {}, workspace)).status).toBe(403);
    expect((await request("/organization/backups", { method: "POST" }, workspace)).status).toBe(403);
    expect((await download(workspace, backup.id, "tickets")).status).toBe(403);
  });

  it("advances a running backup from the cron", async () => {
    const workspace = await signup("backup-cron");
    await seedTicket(workspace, "backup-cron");
    const backup = await startBackup(workspace);

    const before = await readBackup(backup.id);
    await runScheduled(env);
    const after = await readBackup(backup.id);

    expect(after.status === "running" || after.status === "completed").toBe(true);
    expect(Object.keys(after.rowCounts).length).toBeGreaterThanOrEqual(Object.keys(before.rowCounts).length);
    expect(after.cursor?.table ?? "done").not.toBe(before.cursor?.table ?? "start");
  });

  it("serves the export as newline-delimited JSON", async () => {
    const workspace = await signup("backup-ndjson");
    await seedTicket(workspace, "backup-ndjson");
    const backup = await startBackup(workspace);
    await runToCompletion(backup.id);

    const response = await download(workspace, backup.id, "tickets");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("content-disposition")).toContain("tickets.ndjson");
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const text = await response.text();
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("stores the retention setting and applies it to new backups", async () => {
    const workspace = await signup("backup-retention");
    const saved = await request(
      "/organization/backups/schedule",
      { method: "PUT", body: JSON.stringify({ enabled: true, retainDays: 14 }) },
      workspace,
    );
    expect(saved.status).toBe(200);

    const backup = await startBackup(workspace);
    const row = await env.DB.prepare("SELECT started_at AS startedAt, expires_at AS expiresAt FROM backups WHERE id = ?")
      .bind(backup.id)
      .first<{ startedAt: number; expiresAt: number }>();
    expect(Math.round((row!.expiresAt - row!.startedAt) / 86400000)).toBe(14);

    const listed = (await (await request("/organization/backups", {}, workspace)).json()) as {
      schedule: { enabled: boolean; retainDays: number };
    };
    expect(listed.schedule).toEqual({ enabled: true, retainDays: 14 });
  });
});
