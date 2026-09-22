import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // Every spec drives the same seeded demo workspace, so running files in parallel has
  // them mutating each other's data. One worker keeps the suite deterministic.
  workers: 1,
  retries: 0,
  // The dev server compiles route chunks lazily, so a page visited for the first time
  // mid-suite can take several seconds before it is interactive. A CI runner is slower
  // and colder than a developer's machine: the first sign-in there pays the lazy
  // compile and a 100,000-iteration password derivation at once, which overran 60s.
  timeout: process.env.CI ? 150_000 : 60_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Signs in once and saves the session, so the suite does not spend the Worker's
    // ten-sign-ins-a-minute budget on repeated logins.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      testIgnore: /screenshots\.spec\.ts|auth\.setup\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: "e2e/.auth/owner.json",
      },
    },
    {
      name: "screenshots",
      testMatch: /screenshots\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        storageState: "e2e/.auth/owner.json",
      },
    },
  ],
  webServer: {
    command: "npx vite --port 5173",
    url: "http://localhost:5173/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 180_000 : 90_000,
  },
});
