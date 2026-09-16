import { expect, request as apiRequest, test, type Page } from "@playwright/test";

// Key names are unique per run, so a rerun against a database that was not reset does
// not match two rows with the same name.
const runId = Date.now().toString(36);

/**
 * The API-keys section renders nothing until its own fetch resolves, so a bare
 * getByLabel("Name") can land on the inbox form instead. Always scope to the section,
 * and wait for it.
 */
function apiKeySection(target: Page) {
  return target.locator("section").filter({ has: target.getByRole("heading", { name: "API keys" }) });
}

async function createKeyThroughUi(target: Page, name: string, extraScope?: string) {
  const section = apiKeySection(target);
  await expect(section).toBeVisible();
  await section.getByLabel("Name").fill(name);
  if (extraScope) await section.getByLabel(extraScope).check();
  await section.getByRole("button", { name: "Create key" }).click();
  const dialog = target.getByRole("dialog", { name: "Your new API key" });
  // Surface a server-side refusal instead of timing out on a dialog that never opens.
  await expect(dialog.or(target.locator(".form-error"))).toBeVisible();
  const value = await dialog.locator("code").innerText();
  await dialog.getByRole("button", { name: "I have saved it" }).click();
  return value;
}

/** A request context with no cookies: a bearer key must never ride a browser session. */
async function bearerContext() {
  return apiRequest.newContext({ storageState: undefined });
}

// One page for the whole file; the session comes from the shared sign-in in auth.setup.ts.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("a key is revealed once, behind a dialog that cannot be dismissed by accident", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  const section = apiKeySection(page);
  await expect(section).toBeVisible();
  await section.getByLabel("Name").fill(`Playwright key ${runId}`);
  await section.getByLabel("Read reports").check();
  await section.getByRole("button", { name: "Create key" }).click();

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
  const row = page.locator(".api-key-list article").filter({ hasText: `Playwright key ${runId}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText(revealed.slice(0, 12));
  await expect(page.locator("body")).not.toContainText(revealed);
});

test("the key authenticates /api/v1 and nothing outside its scopes", async () => {
  const api = await bearerContext();
  await page.goto("/settings");
  const key = await createKeyThroughUi(page, `Scoped key ${runId}`);

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
  await api.dispose();
});

test("a revoked key stops working immediately", async () => {
  const api = await bearerContext();
  await page.goto("/settings");
  const key = await createKeyThroughUi(page, `Doomed key ${runId}`);

  const before = await api.get("http://localhost:5173/api/v1/tickets", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(before.status()).toBe(200);

  page.once("dialog", (confirmation) => void confirmation.accept());
  await page
    .locator(".api-key-list article")
    .filter({ hasText: `Doomed key ${runId}` })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.locator(".api-key-list article").filter({ hasText: `Doomed key ${runId}` })).toHaveClass(/api-key-inactive/);

  const after = await api.get("http://localhost:5173/api/v1/tickets", {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(after.status()).toBe(401);
  await api.dispose();
});

test("the reveal dialog is usable at phone width", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings");
  const section = apiKeySection(page);
  await expect(section).toBeVisible();
  await section.getByLabel("Name").fill(`Phone key ${runId}`);
  await section.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog", { name: "Your new API key" });
  await expect(dialog).toBeVisible();
  // The copy button must be reachable without scrolling.
  await expect(dialog.getByRole("button", { name: /Copy/ })).toBeInViewport();
  await dialog.getByRole("button", { name: "I have saved it" }).click();
});
