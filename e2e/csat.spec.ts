import { expect, test, type Page } from "@playwright/test";

// One sign-in per file: each login consumes the Worker's auth rate limit.
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

test("satisfaction ratings can be configured and recent answers are listed", async () => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Satisfaction ratings" })).toBeVisible();
  // The seed answers two surveys; both comments are shown on the recent list.
  await expect(page.getByText("Took a little while, but it got sorted.")).toBeVisible();
  await expect(page.getByText("Fast and clear, thank you.")).toBeVisible();

  await page.getByLabel("Question asked in the email").fill("How did that go?");
  await page.getByRole("button", { name: "Save question" }).click();
  await expect(page.getByText(/Satisfaction ratings are on/)).toBeVisible();
});

test("reports never show a satisfaction score without its sample size", async () => {
  await page.goto("/reports");
  const tile = page.locator(".measure-strip > span").filter({ hasText: "Satisfaction" });
  await expect(tile).toBeVisible();
  // Either a score with its denominator, or an honest empty state — never a bare average.
  await expect(tile.locator("strong")).toHaveText(/^(\d\.\d \(\d+\)|No answers yet)$/);
});

test("an invalid rating link shows a calm sentence rather than an error", async ({ browser }) => {
  // A customer arrives with no session at all, straight from their mail client.
  const anonymous = await browser.newPage();
  await anonymous.goto("/rate/tkt_nonexistent.5.notavalidsignature");
  await expect(anonymous.getByRole("heading", { name: "This rating link is no longer available" })).toBeVisible();
  await expect(anonymous.getByText(/nothing you need to do/)).toBeVisible();
  // No sign-in wall, no stack trace, no navigation rail.
  await expect(anonymous.locator(".rail")).toHaveCount(0);
  await anonymous.close();
});

test("the rating page is usable at phone width", async ({ browser }) => {
  const anonymous = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await anonymous.goto("/rate/tkt_nonexistent.5.notavalidsignature");
  await expect(anonymous.locator(".rate-card")).toBeVisible();
  const overflow = await anonymous.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await anonymous.close();
});
