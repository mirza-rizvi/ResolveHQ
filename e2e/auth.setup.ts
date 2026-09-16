import { expect, test as setup } from "@playwright/test";

export const OWNER_STATE = "e2e/.auth/owner.json";

/**
 * Signs in once for the whole run and saves the session.
 *
 * The Worker allows ten sign-ins a minute from one address, so a suite where every
 * spec file logs in exhausts that budget as soon as a handful of specs exist — and the
 * failure reads as an unrelated timeout rather than as a rate limit.
 */
setup("authenticate as the workspace owner", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@northstarlabs.test");
  await page.getByLabel("Password").fill("resolve-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/inbox/);
  // Proof the session is real, not just that the URL changed.
  await expect(page.locator(".ticket-ledger")).toBeVisible();
  await page.context().storageState({ path: OWNER_STATE });
});
