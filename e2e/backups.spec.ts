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

/** The section renders nothing until its own fetch resolves; always scope to it. */
function backupSection(target: Page) {
  return target.locator("section").filter({ has: target.getByRole("heading", { name: "Workspace export" }) });
}

test("an export starts, reports progress, and states what it leaves out", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  const section = backupSection(page);
  await expect(section).toBeVisible();

  // The three caveats are the point of the copy: nobody should discover them later.
  await expect(section.getByText(/Point-in-time/)).toBeVisible();
  await expect(section.getByText(/Attachment files are not included/)).toBeVisible();
  await expect(section.getByText(/To restore, see the deployment guide/)).toBeVisible();

  // Deliberately not asserting the empty state: one export per workspace per day means
  // a suite re-run against a database that was not reset would start from a populated
  // list, and a test that only passes on a pristine database is a test that will cry
  // wolf in CI.
  const create = section.getByRole("button", { name: "Create backup" });
  if (await create.isEnabled()) await create.click();

  // An export spans several scheduled runs, so the row must say what it is doing rather
  // than leaving a spinner that reads as broken.
  const row = section.locator(".backup-list article").first();
  await expect(row).toBeVisible();
  await expect(row.getByText(/Exporting|Starting|rows|Expired/)).toBeVisible();
});

test("the retention window is saved", async () => {
  await page.goto("/settings");
  const section = backupSection(page);
  await section.getByLabel("Keep exports for (days)").fill("45");
  await section.getByRole("button", { name: "Save backup settings" }).click();
  await expect(page.getByText("Backup settings saved.")).toBeVisible();

  // Re-read from a fresh page load rather than trusting the in-memory state, with room
  // for the section's own fetch to resolve on a loaded runner.
  await page.reload();
  await expect(backupSection(page).getByLabel("Keep exports for (days)")).toHaveValue("45", { timeout: 15_000 });
});
