import { expect, test, type Page } from "@playwright/test";

// One page for the whole file; the session comes from the shared sign-in in auth.setup.ts.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("the Snoozed queue holds the deferred ticket and the banner explains the early wake", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/inbox?queue=snoozed");
  const row = page.locator(".ticket-table tbody tr").first();
  await expect(row).toBeVisible();
  await row.locator(".ticket-subject-link").click();

  const banner = page.locator(".snooze-banner");
  await expect(banner).toBeVisible();
  // The promise of an early wake is the whole point of the feature.
  await expect(banner).toContainText("wakes early if the customer replies");
  await expect(banner).toContainText("Waiting on the carrier");
});

test("an agent can snooze a ticket with a preset and put it straight back", async () => {
  await page.goto("/inbox?queue=open");
  await page.locator(".ticket-table tbody tr").first().locator(".ticket-subject-link").click();
  await expect(page.getByRole("button", { name: "Send reply" })).toBeVisible();

  await page.getByRole("button", { name: "Snooze ticket" }).click();
  const menu = page.getByRole("dialog", { name: "Snooze ticket" });
  await expect(menu).toBeVisible();
  await menu.getByLabel("Snooze reason").fill("Waiting on a deploy");
  await menu.getByRole("button", { name: /^Tomorrow/ }).click();

  const banner = page.locator(".snooze-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Waiting on a deploy");

  await banner.getByRole("button", { name: "Unsnooze" }).click();
  await expect(banner).toBeHidden();
});

test("Z opens the snooze menu", async () => {
  await page.goto("/inbox?queue=open");
  await page.locator(".ticket-table tbody tr").first().locator(".ticket-subject-link").click();
  await expect(page.getByRole("button", { name: "Send reply" })).toBeVisible();
  await page.locator("body").press("z");
  await expect(page.getByRole("dialog", { name: "Snooze ticket" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Snooze ticket" })).toBeHidden();
});

test("a snoozed ticket is absent from Open and never shows an overdue badge", async () => {
  await page.goto("/inbox?queue=snoozed");
  const snoozedSubject = await page.locator(".ticket-table tbody tr").first().locator(".ticket-subject-link").innerText();

  await page.goto("/inbox?queue=open");
  await expect(page.getByRole("link", { name: snoozedSubject })).toHaveCount(0);
  await page.goto("/inbox?queue=overdue");
  await expect(page.getByRole("link", { name: snoozedSubject })).toHaveCount(0);
});

test("the snooze sheet is usable at phone width", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/inbox?queue=open");
  await page.locator(".ticket-table tbody tr").first().locator(".ticket-subject-link").click();
  await page.getByRole("button", { name: "Snooze ticket" }).click();
  await expect(page.getByRole("dialog", { name: "Snooze ticket" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
