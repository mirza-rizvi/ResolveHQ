import { beforeAll } from "vitest";
import { applyD1Migrations, env } from "cloudflare:test";
beforeAll(async () => { await applyD1Migrations(env.DB, __D1_MIGRATIONS__); });
