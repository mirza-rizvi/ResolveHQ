import { expect, test, type Page } from "@playwright/test";

// One sign-in for the whole file: each login consumes the Worker's auth rate limit,
// and these assertions are all about one signed-in workspace anyway.
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

test("the Overdue queue lists what is late and the badge says how late", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/inbox?queue=overdue");
  await expect(page.locator(".ticket-table tbody tr").first()).toBeVisible();

  // The badge carries its meaning in text; colour only reinforces it.
  const badge = page.locator(".sla-badge.sla-breached").first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("title", /Overdue by \d+[mhd]/);
  await expect(badge.locator(".sla-full")).toHaveText(/Overdue by \d+[mhd]/);
  await expect(badge.locator(".sla-short")).toHaveText(/-\d+[mhd]/);

  await page.goto("/inbox?queue=due_soon");
  const dueSoon = page.locator(".sla-badge.sla-due_soon").first();
  await expect(dueSoon).toBeVisible();
  await expect(dueSoon).toHaveAttribute("title", /Due in \d+[mhd]/);
});

test("response targets can be configured from settings", async () => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Response targets" })).toBeVisible();

  // The seeded policies are listed.
  await expect(page.getByText("Default for every ticket")).toBeVisible();
  await expect(page.getByText(/urgent priority/)).toBeVisible();

  // Business hours round-trip.
  await page.getByRole("button", { name: "Save business hours" }).click();
  await expect(page.getByText("Business hours saved.")).toBeVisible();

  // A second default is refused in plain language rather than as a server error.
  await page.getByLabel("Policy name").fill("Duplicate default");
  await page.getByLabel("First response target in working minutes").fill("45");
  await page.getByRole("button", { name: "Add policy" }).click();
  await expect(page.getByText(/already has a default policy/)).toBeVisible();
});

test("SLA figures appear in reports", async () => {
  await page.goto("/reports");
  await expect(page.getByText("SLA breached")).toBeVisible();
  await expect(page.getByText("SLA due soon")).toBeVisible();
});

test("the SLA badge shortens at phone width without overflowing", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/inbox?queue=overdue");
  const badge = page.locator(".sla-badge").first();
  await expect(badge).toBeVisible();
  // The short form is what a phone shows; the sentence stays in the title.
  await expect(badge.locator(".sla-short")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
