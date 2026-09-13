import { expect, test } from "@playwright/test";

/**
 * Captures the marketing screenshots used in README.md. Runs against the seeded demo
 * workspace (see drizzle/seed.sql) via `npm run screenshots`, which resets the local D1
 * database first so the captures are deterministic.
 */
test("capture marketing screenshots of the seeded workspace", async ({ page }) => {
  test.setTimeout(120_000);

  async function login() {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to ResolveHQ" })).toBeVisible();
    await page.getByLabel("Email").fill("owner@northstarlabs.test");
    await page.getByLabel("Password").fill("resolve-demo-2026");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/inbox/);
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  }

  async function openSeededTicket() {
    await page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).first().click();
    await expect(page.getByLabel("Selected conversation")).toBeVisible();
    await expect(page.getByLabel("Reply message")).toBeVisible();
  }

  await login();

  // inbox.png — three-pane inbox with a ticket selected.
  await openSeededTicket();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/inbox.png", fullPage: false });

  // ticket-thread.png — just the conversation pane, so the thread reads clearly at a glance.
  await page.locator('[aria-label="Selected conversation"]').screenshot({ path: "docs/images/ticket-thread.png" });

  // dashboard.png
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent tickets", exact: true })).toBeVisible();
  await expect(page.getByText("Data export stuck at 0%", { exact: true }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/dashboard.png", fullPage: false });

  // reports.png — scroll past the (mostly empty, 30-day) daily table so the status/priority
  // breakdown with real seeded numbers is in frame alongside the summary stats.
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  const byStatusHeading = page.getByRole("heading", { name: "By status", exact: true });
  await expect(byStatusHeading).toBeVisible();
  await page.waitForLoadState("networkidle");
  await byStatusHeading.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/images/reports.png", fullPage: false });

  // knowledge-base.png
  await page.goto("/knowledge-base");
  await expect(page.getByRole("heading", { name: "Knowledge base", exact: true })).toBeVisible();
  await expect(page.getByText("Setting up email forwarding for your support inbox")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/knowledge-base.png", fullPage: false });

  // automations.png
  await page.goto("/automations");
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await expect(page.getByText("Tag invoice mentions as billing")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/automations.png", fullPage: false });

  // customers.png
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Customers", exact: true })).toBeVisible();
  await expect(page.getByText("Priya Nair", { exact: true }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/customers.png", fullPage: false });

  // settings.png
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/settings.png", fullPage: false });

  // help-center.png — public route, no auth required.
  await page.goto("/help/northstar-labs");
  await expect(page.getByRole("heading", { name: "Northstar Labs help", exact: true })).toBeVisible();
  await expect(page.getByText("Setting up email forwarding for your support inbox")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/help-center.png", fullPage: false });

  // inbox-dark.png — toggle the theme from the sidebar dock, then reselect the ticket.
  await page.goto("/inbox");
  await openSeededTicket();
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/inbox-dark.png", fullPage: false });

  // Switch back to light before the mobile capture, which should represent the default theme.
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // mobile-inbox.png
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/inbox");
  await page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).click();
  await expect(page.getByLabel("Selected conversation")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/images/mobile-inbox.png", fullPage: false });
});
