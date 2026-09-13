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
});
