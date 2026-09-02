import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./drizzle/migrations");
  return {
    resolve: { alias: { "@": path.resolve(__dirname, "./src"), "resolve-server": path.resolve(__dirname, "./src/server"), "resolve-shared": path.resolve(__dirname, "./src/shared") } },
    define: { __D1_MIGRATIONS__: JSON.stringify(migrations) },
    plugins: [cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["ATTACHMENTS"],
        queueProducers: { INBOUND_MAIL_QUEUE: "resolvehq-test-inbound", OUTBOUND_MAIL_QUEUE: "resolvehq-test-outbound" },
        ratelimits: { AUTH_RATE_LIMIT: { namespace_id: "1001", simple: { limit: 1000, period: 60 } }, WRITE_RATE_LIMIT: { namespace_id: "1002", simple: { limit: 1000, period: 60 } } },
        bindings: {
          APP_URL: "http://localhost:8787",
          SESSION_PEPPER: "test-resolvehq-session-pepper-at-least-32-characters",
          DEV_MAIL_MODE: "capture",
        },
      },
    })],
    test: {
      setupFiles: ["./tests/setup.ts"],
      include: ["tests/**/*.test.ts"],
      exclude: ["e2e/**", "node_modules/**", "dist/**"],
    },
  };
});
