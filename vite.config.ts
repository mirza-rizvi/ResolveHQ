import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The Cloudflare plugin reads wrangler.jsonc and runs worker.ts inside workerd,
  // so the dev server serves the SPA and /api from a single origin (no proxy).
  plugins: [cloudflare(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "resolve-server": path.resolve(__dirname, "./src/server"),
      "resolve-shared": path.resolve(__dirname, "./src/shared"),
    },
  },
  server: { port: 5173 },
  build: { sourcemap: true },
});
