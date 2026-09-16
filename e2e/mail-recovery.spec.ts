import { expect, test } from "@playwright/test";

test("administrator reviews stopped mail on desktop and mobile", async ({ page }, testInfo) => {
  await page.route("**/api/mail-recovery", (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: "job-review",
            kind: "outbound-mail",
            reason: "delivery_uncertain",
            generation: 0,
            updatedAt: 1,
            firstAttemptAt: null,
            requiresDuplicateAck: 1,
          },
          {
            id: "job-complaint",
            kind: "outbound-mail",
            reason: "email.complained",
            generation: 0,
            updatedAt: 1,
            firstAttemptAt: null,
            requiresDuplicateAck: 1,
          },
        ],
      },
    }),
  );
  // The session comes from the shared sign-in in auth.setup.ts.
  await page.goto("/settings");
  const section = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Stopped mail", exact: true }) });
  await expect(section.getByRole("button", { name: "Retry email" }).first()).toBeDisabled();
  await section.getByRole("checkbox").check();
  await expect(section.getByRole("button", { name: "Retry email" }).first()).toBeEnabled();
  await expect(section.getByRole("button", { name: "Retry email" }).last()).toBeDisabled();
  await section.screenshot({ path: testInfo.outputPath("recovery-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(
    false,
  );
  await expect(section.getByRole("checkbox")).toBeVisible();
  await section.screenshot({ path: testInfo.outputPath("recovery-mobile.png") });
});
