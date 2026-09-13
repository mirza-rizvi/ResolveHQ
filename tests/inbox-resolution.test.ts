import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resolveInbox } from "resolve-server/mail/queue";
import { signup } from "./helpers";

describe("inbox resolution", () => {
  it("never hands another tenant's disabled inbox to the workspace that claims the address", async () => {
    const owner = await signup("inbox-disabled-owner");
    const claimant = await signup("inbox-disabled-claimant");
    const address = "shared-disabled@example.test";
    await env.DB.prepare("UPDATE inboxes SET email_address = ?, disabled_at = ? WHERE organization_id = ?")
      .bind(address, Date.now(), owner.organizationId)
      .run();
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
      .bind(address, claimant.organizationId)
      .run();

    const resolved = await resolveInbox(env.DB, address);

    expect(resolved).toBeNull();
    const rows = await env.DB.prepare("SELECT count(*) AS count FROM inboxes WHERE lower(email_address) = ?")
      .bind(address)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("keeps an active inbox with the owning tenant when another workspace claims the same support address", async () => {
    const owner = await signup("inbox-active-owner");
    const claimant = await signup("inbox-active-claimant");
    const address = "shared-active@example.test";
    await env.DB.prepare("UPDATE inboxes SET email_address = ? WHERE organization_id = ?")
      .bind(address, owner.organizationId)
      .run();
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
      .bind(address, claimant.organizationId)
      .run();

    const resolved = await resolveInbox(env.DB, address);

    expect(resolved?.organizationId).toBe(owner.organizationId);
    const claimantInboxes = await env.DB.prepare(
      "SELECT count(*) AS count FROM inboxes WHERE organization_id = ? AND lower(email_address) = ?",
    )
      .bind(claimant.organizationId, address)
      .first<{ count: number }>();
    expect(claimantInboxes?.count).toBe(0);
  });

  it("provisions the support address inbox once and reuses it", async () => {
    const workspace = await signup("inbox-provision");
    const address = "auto-provision@example.test";
    await env.DB.prepare("UPDATE organizations SET support_email = ? WHERE id = ?")
      .bind(address, workspace.organizationId)
      .run();

    const first = await resolveInbox(env.DB, address);
    const second = await resolveInbox(env.DB, address);

    expect(first?.organizationId).toBe(workspace.organizationId);
    expect(second?.id).toBe(first?.id);
    const rows = await env.DB.prepare("SELECT count(*) AS count FROM inboxes WHERE lower(email_address) = ?")
      .bind(address)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("retires a case-only duplicate address instead of aborting the migration", async () => {
    const workspace = await signup("inbox-duplicate-case");
    const migration = __D1_MIGRATIONS__.find((entry) => entry.name.includes("0006_inbox_tenant_scope"));
    expect(migration).toBeDefined();
    // Recreate the pre-0006 shape: without the unique index two active inboxes
    // may differ only by case, which is what an upgraded database can hold.
    await env.DB.prepare("DROP INDEX IF EXISTS inboxes_lower_email_uidx").run();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO inboxes (id, organization_id, name, email_address, provider, is_default, created_at, updated_at) VALUES ('inb_dupe_old', ?, 'Older', 'Dupe@example.test', 'cloudflare_email', 0, ?, ?)",
      ).bind(workspace.organizationId, now - 60_000, now - 60_000),
      env.DB.prepare(
        "INSERT INTO inboxes (id, organization_id, name, email_address, provider, is_default, created_at, updated_at) VALUES ('inb_dupe_new', ?, 'Newer', 'dupe@example.test', 'cloudflare_email', 0, ?, ?)",
      ).bind(workspace.organizationId, now, now),
    ]);

    for (const query of migration!.queries) await env.DB.prepare(query).run();

    const rows = await env.DB.prepare(
      "SELECT id, disabled_at AS disabledAt FROM inboxes WHERE lower(email_address) = 'dupe@example.test' ORDER BY created_at",
    ).all<{ id: string; disabledAt: number | null }>();
    expect(rows.results.map((row) => row.id)).toEqual(["inb_dupe_old", "inb_dupe_new"]);
    expect(rows.results[0].disabledAt).toBeNull();
    expect(rows.results[1].disabledAt).toBeGreaterThan(0);
    // The oldest survivor keeps the address, and the index now guards it.
    expect(await resolveInbox(env.DB, "dupe@example.test")).toMatchObject({ id: "inb_dupe_old" });
    await expect(
      env.DB.prepare(
        "INSERT INTO inboxes (id, organization_id, name, email_address, provider, is_default, created_at, updated_at) VALUES ('inb_dupe_third', ?, 'Third', 'DUPE@example.test', 'cloudflare_email', 0, ?, ?)",
      )
        .bind(workspace.organizationId, now, now)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
