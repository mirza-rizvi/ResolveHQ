import { expect, test, type Page } from "@playwright/test";

// One sign-in per file: the Worker allows ten sign-ins a minute from one address.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@northstarlabs.test");
  await page.getByLabel("Password").fill("resolve-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/inbox/);
});

test.afterAll(async () => {
  await page.close();
});

test("a key is revealed once, behind a dialog that cannot be dismissed by accident", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await page.getByLabel("Name").last().fill("Playwright key");
  await page.getByLabel("Read reports").check();
  await page.getByRole("button", { name: "Create key" }).click();

  const dialog = page.getByRole("dialog", { name: "Your new API key" });
  await expect(dialog).toBeVisible();
  const revealed = await dialog.locator("code").innerText();
  expect(revealed).toMatch(/^rhq_live_/);

  // Clicking the backdrop and pressing Escape must both leave it open.
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "I have saved it" }).click();
  await expect(dialog).toBeHidden();

  // Afterwards only the prefix is shown, never the key.
  const row = page.locator(".api-key-list article").filter({ hasText: "Playwright key" });
  await expect(row).toBeVisible();
  await expect(row).toContainText(revealed.slice(0, 12));
  await expect(page.locator("body")).not.toContainText(revealed);
});

test("the key authenticates /api/v1 and nothing outside its scopes", async ({ request: api }) => {
  await page.goto("/settings");
  await page.getByLabel("Name").last().fill("Scoped key");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog", { name: "Your new API key" });
  const key = await dialog.locator("code").innerText();
  await dialog.getByRole("button", { name: "I have saved it" }).click();

  // A bare bearer request, with no cookies at all — the way a script would call it.
  const tickets = await api.get("http://localhost:5173/api/v1/tickets", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(tickets.status()).toBe(200);
  expect(((await tickets.json()) as { tickets: unknown[] }).tickets.length).toBeGreaterThan(0);

  // tickets:read only.
  const reports = await api.get("http://localhost:5173/api/v1/reports/summary", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(reports.status()).toBe(403);

  // The app surface stays session-only.
  const appSurface = await api.get("http://localhost:5173/api/tickets", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(appSurface.status()).toBe(401);
});

test("a revoked key stops working immediately", async ({ request: api }) => {
  await page.goto("/settings");
  await page.getByLabel("Name").last().fill("Doomed key");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog", { name: "Your new API key" });
  const key = await dialog.locator("code").innerText();
  await dialog.getByRole("button", { name: "I have saved it" }).click();

  const before = await api.get("http://localhost:5173/api/v1/tickets", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(before.status()).toBe(200);

  page.once("dialog", (confirmation) => void confirmation.accept());
  await page
    .locator(".api-key-list article")
    .filter({ hasText: "Doomed key" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.locator(".api-key-list article").filter({ hasText: "Doomed key" })).toHaveClass(/api-key-inactive/);

  const after = await api.get("http://localhost:5173/api/v1/tickets", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(after.status()).toBe(401);
});

test("the reveal dialog is usable at phone width", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings");
  await page.getByLabel("Name").last().fill("Phone key");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog", { name: "Your new API key" });
  await expect(dialog).toBeVisible();
  // The copy button must be reachable without scrolling.
  await expect(dialog.getByRole("button", { name: /Copy/ })).toBeInViewport();
  await dialog.getByRole("button", { name: "I have saved it" }).click();
});
