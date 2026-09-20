#!/usr/bin/env node
/**
 * Smoke-tests a real deployment.
 *
 * Every other gate in this repository runs against local workerd, which does not enforce
 * some of the limits the production runtime does. That gap shipped two bugs: password
 * derivation at 310,000 PBKDF2 iterations, which the runtime refuses above 100,000, and
 * a database whose migrations had never been applied. Both were invisible locally and
 * fatal on a deployment.
 *
 *   node scripts/smoke.mjs https://your-worker.example.workers.dev
 *   node scripts/smoke.mjs https://your-worker.example.workers.dev --signup
 *
 * Without --signup it only reads. With --signup it creates one throwaway workspace,
 * which is the only way to exercise password hashing end to end; use it on a fresh or
 * staging deployment, and see the cleanup note printed at the end.
 */

import process from "node:process";
import console from "node:console";

// Node 18+ provides fetch as a global. Read it off globalThis rather than importing
// undici, which is only present transitively.
const { fetch } = globalThis;

const [, , rawUrl, ...flags] = process.argv;
const withSignup = flags.includes("--signup");

if (!rawUrl) {
  console.error("Usage: node scripts/smoke.mjs <deployment-url> [--signup]");
  process.exit(2);
}

const base = rawUrl.replace(/\/+$/, "");
const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function json(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body, headers: response.headers };
}

async function main() {
  console.log(`Smoke-testing ${base}\n`);

  const health = await json("/api/health");
  record("worker responds", health.status === 200 && health.body?.ok === true, `status ${health.status}`);

  const ready = await json("/api/ready");
  const db = ready.body?.database;
  record(
    "database schema present",
    ready.status === 200 && db === "ready",
    db === "unmigrated"
      ? "migrations never applied — run: npm run db:migrate:remote"
      : `status ${ready.status}, database ${db ?? "unknown"}`,
  );

  const spa = await fetch(`${base}/login`);
  const contentType = spa.headers.get("content-type") ?? "";
  record("app shell served", spa.ok && contentType.includes("text/html"), `status ${spa.status}`);

  if (!withSignup) {
    console.log("\nSkipping the sign-up probe. Pass --signup to exercise password hashing,");
    console.log("which is the only check that catches a runtime-level crypto failure.");
    return;
  }

  // The one path that derives a password hash. A deployment can pass every check above
  // and still be unusable if the runtime refuses the derivation or the request exceeds
  // its CPU budget.
  const suffix = Date.now().toString(36);
  const account = {
    name: "Smoke Test",
    email: `smoke-${suffix}@example.invalid`,
    password: `smoke-${suffix}-${Math.random().toString(36).slice(2)}`,
    organizationName: `Smoke ${suffix}`,
    organizationSlug: `smoke-${suffix}`,
  };

  const started = Date.now();
  const signup = await json("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(account),
  });
  const elapsed = Date.now() - started;

  const code = signup.body?.error?.code;
  record(
    "sign-up completes",
    signup.status === 201,
    signup.status === 201
      ? `${elapsed} ms wall clock`
      : `status ${signup.status}${code ? `, ${code}` : ""} — ${signup.body?.error?.message ?? ""}`,
  );

  if (signup.status === 201) {
    const login = await json("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    record("sign-in completes", login.status === 200, `status ${login.status}`);

    console.log(`\nCreated workspace "${account.organizationSlug}". To remove it:`);
    console.log(
      `  npx wrangler d1 execute DB --remote --command "DELETE FROM organizations WHERE slug = '${account.organizationSlug}'; DELETE FROM users WHERE email = '${account.email}';"`,
    );
  }
}

main()
  .then(() => {
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(`\nSmoke test could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
