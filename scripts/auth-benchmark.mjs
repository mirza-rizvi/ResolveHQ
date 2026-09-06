import console from "node:console";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const bundled = await build({
  stdin: {
    contents: `import { hashPassword, verifyPassword } from './src/server/auth/password.ts';
const password = 'synthetic-benchmark-password', pepper = 'synthetic-benchmark-pepper-at-least-32-characters';
let hash;
export default { async fetch(request) {
 const operation = new URL(request.url).pathname;
 if (operation === '/hash') hash = await hashPassword(password, pepper);
 else if (operation === '/verify') await verifyPassword(password, hash, pepper);
 else { await verifyPassword(password, hash, pepper); hash = await hashPassword(password, pepper); }
 return new Response('ok');
} };`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  alias: { "resolve-server": "./src/server" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: "resolvehq-auth-benchmark",
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
  }),
);
try {
  await mf.dispatchFetch("http://benchmark/hash");
  for (const operation of ["hash", "verify", "change"]) {
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      await mf.dispatchFetch(`http://benchmark/${operation}`);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      `${operation}: median ${samples[6].toFixed(1)} ms, max ${samples.at(-1).toFixed(1)} ms (12 local elapsed samples)`,
    );
  }
  console.log(
    "These are local elapsed times, not Cloudflare production CPU measurements. Check Workers CPU metrics after deployment.",
  );
} finally {
  await mf.dispose();
}
