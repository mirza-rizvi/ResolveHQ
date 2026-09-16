import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@northstarlabs.test");
  await page.getByLabel("Password").fill("resolve-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/inbox/);
}

test("the setup page reports live readiness and never blocks the app", async ({ page }) => {
  await signIn(page);
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Set up ResolveHQ" })).toBeVisible();

  // Rows describe what is being checked; a real DNS answer arrives for each one.
  const rows = page.locator(".readiness-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByText("Session secret", { exact: true })).toBeVisible();
  await expect(page.getByText("Support inbox", { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "Email Routing (MX)" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "DMARC" }).first()).toBeVisible();

  // Every row shows its own evidence, so the owner can judge a verdict they disagree with.
  await expect(rows.first().locator("code")).toBeVisible();

  // DMARC is advisory and is labelled as such, whatever its status.
  await expect(rows.filter({ hasText: "DMARC" }).first().getByText("Optional")).toBeVisible();

  // The page informs; it never prevents work.
  await page.getByRole("link", { name: "Continue to inbox" }).click();
  await page.waitForURL(/\/inbox/);
});

test("the settings health card shares the setup checklist and re-checks on demand", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Setup & health" })).toBeVisible();
  await expect(page.locator(".readiness-row").first()).toBeVisible();

  const status = page.locator(".readiness-toolbar p");
  await expect(status).toContainText(/Checked|Checking/);
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(status).toContainText(/Checked/);
});

test("the setup banner can be dismissed and stays dismissed across reloads", async ({ page }) => {
  await signIn(page);
  // The demo workspace's domain resolves to nothing, so a required check fails and raises the banner.
  const banner = page.locator(".setup-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Setup incomplete");

  await banner.getByRole("button", { name: "Dismiss setup notice" }).click();
  await expect(banner).toBeHidden();

  await page.reload();
  await page.waitForURL(/\/inbox/);
  await expect(page.locator(".ticket-ledger")).toBeVisible();
  await expect(banner).toBeHidden();
});

test("the setup checklist stays readable at phone width and in dark mode", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/setup");
  await expect(page.locator(".readiness-row").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(page.locator(".readiness-row").first()).toBeVisible();
  const contrast = await page.evaluate(() => {
    const row = document.querySelector(".readiness-row");
    if (!row) return null;
    const style = getComputedStyle(row);
    return { background: style.backgroundColor, color: getComputedStyle(row.querySelector("strong")!).color };
  });
  expect(contrast?.background).not.toBe(contrast?.color);
});
