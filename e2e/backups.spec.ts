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
  await expect(section.getByText("No exports yet.")).toBeVisible();

  await section.getByRole("button", { name: "Create backup" }).click();

  // An export spans several scheduled runs, so the row must say what it is doing rather
  // than leaving a spinner that reads as broken.
  const row = section.locator(".backup-list article").first();
  await expect(row).toBeVisible();
  await expect(row.getByText(/Exporting|Starting|rows/)).toBeVisible();
  await expect(section.getByRole("button", { name: "Export in progress" })).toBeVisible();
});

test("the retention window is saved", async () => {
  await page.goto("/settings");
  const section = backupSection(page);
  await section.getByLabel("Keep exports for (days)").fill("45");
  await section.getByRole("button", { name: "Save backup settings" }).click();
  await expect(page.getByText("Backup settings saved.")).toBeVisible();

  await page.reload();
  await expect(backupSection(page).getByLabel("Keep exports for (days)")).toHaveValue("45");
});
