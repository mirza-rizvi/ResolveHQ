import { expect, test } from "@playwright/test";

test("owner can open the seeded support inbox across desktop and mobile", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Continue the conversation." })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/inbox/);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  await expect(page.getByLabel("Reply message")).toBeVisible();

  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(desktopOverflow).toBe(false);
  await page.screenshot({ path: ".impeccable/review/desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/inbox");
  await page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).click();
  await expect(page.getByLabel("Selected conversation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to ticket list" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(mobileOverflow).toBe(false);
  await page.screenshot({ path: ".impeccable/review/mobile.png", fullPage: true });
});
