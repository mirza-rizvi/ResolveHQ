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

/** The webhooks section renders nothing until its own fetch resolves; always scope to it. */
function webhookSection(target: Page) {
  return target.locator("section").filter({ has: target.getByRole("heading", { name: "Webhooks" }) });
}

test("an endpoint is added, its signing secret is shown once, and health is reported", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  const section = webhookSection(page);
  await expect(section).toBeVisible();
  await expect(section.getByText(/never contain message text/)).toBeVisible();

  await section.getByLabel("URL").fill("https://hooks.example.com/resolvehq");
  await section.getByLabel("A customer replies").check();
  await section.getByRole("button", { name: "Add endpoint" }).click();

  // The secret follows the same contract as an API key: shown once, confirmed explicitly.
  const dialog = page.getByRole("dialog", { name: "Your webhook signing secret" });
  await expect(dialog).toBeVisible();
  // The prose mentions the header in a <code> too, so scope to the value block.
  const secret = await dialog.locator(".api-key-value code").innerText();
  expect(secret).toMatch(/^whsec_/);
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "I have saved it" }).click();
  await expect(dialog).toBeHidden();

  const row = section.locator(".webhook-list article").filter({ hasText: "hooks.example.com" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("A ticket is opened");
  await expect(row).toContainText("A customer replies");
  // Health is stated rather than assumed.
  await expect(row.locator(".webhook-health")).toContainText("Nothing delivered yet");
  await expect(page.locator("body")).not.toContainText(secret);
});

test("a private address is refused with a plain-language reason", async () => {
  await page.goto("/settings");
  const section = webhookSection(page);
  await section.getByLabel("URL").fill("https://169.254.169.254/latest/meta-data");
  await section.getByRole("button", { name: "Add endpoint" }).click();
  await expect(section.locator(".form-error")).toContainText(/private or internal network/);
});

test("a failing endpoint reports the failure after a test send", async () => {
  await page.goto("/settings");
  const section = webhookSection(page);
  const row = section.locator(".webhook-list article").filter({ hasText: "hooks.example.com" });
  await row.getByRole("button", { name: "Test" }).click();

  // hooks.example.com does not exist, so the test reports a failure rather than pretending.
  await expect(section.locator(".webhook-health.webhook-warn").first()).toContainText(/failure/i);
});

test("the Slack and Telegram forms ask for what those destinations need", async () => {
  await page.goto("/settings");
  const section = webhookSection(page);
  await section.getByLabel("Endpoint kind").selectOption("slack");
  await expect(section.getByLabel("URL")).toHaveAttribute("placeholder", /hooks\.slack\.com/);

  await section.getByLabel("Endpoint kind").selectOption("telegram");
  await expect(section.getByLabel("Bot token")).toBeVisible();
  await expect(section.getByLabel("Chat id")).toBeVisible();
  await expect(section.getByLabel("URL")).toHaveCount(0);
});

test("the webhook list stays readable at phone width", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/settings");
  await expect(webhookSection(page).locator(".webhook-list article").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
