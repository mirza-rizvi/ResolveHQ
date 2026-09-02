import { expect, test } from "@playwright/test";

test("owner can open the seeded support inbox across desktop and mobile", async ({ page }, testInfo) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to ResolveHQ" })).toBeVisible();
  await page.getByLabel("Email").fill("owner@northstarlabs.test");
  await page.getByLabel("Password").fill("resolve-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/inbox/);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  await expect(page.getByLabel("Reply message")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.getByRole("dialog", { name: "Command menu" })).toBeVisible();
  await page.keyboard.press("Escape");

  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(desktopOverflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/inbox");
  await page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).click();
  await expect(page.getByLabel("Selected conversation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to ticket list" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(mobileOverflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
});

test("agent can reply, see delivery state, and create a ticket", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@northstarlabs.test");
  await page.getByLabel("Password").fill("resolve-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).first().click();
  await page.getByLabel("Reply message").fill("Thanks — looking into this now.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Thanks — looking into this now.")).toBeVisible();
  await expect(page.locator(".delivery-badge").last()).toHaveText(/Queued|Sent/);
  await page.getByRole("button", { name: "New ticket" }).click();
  const createTicketDialog = page.getByRole("dialog", { name: "Create ticket" });
  await createTicketDialog.getByLabel("Customer").selectOption({ index: 1 });
  await createTicketDialog.getByLabel("Subject").fill("Proactive outreach");
  await createTicketDialog.getByLabel("Initial message").fill("Checking in.");
  await createTicketDialog.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { name: "Proactive outreach" })).toBeVisible();
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: /Reset your password/i })).toBeVisible();
});
