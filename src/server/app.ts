import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { HonoEnv } from "./types";
import { authRoutes } from "./auth/routes";
import { organizationRoutes } from "./organizations/routes";
import { HttpError } from "./http/errors";
import { customerRoutes } from "./customers/routes";
import { ticketRoutes } from "./tickets/routes";
import { tagRoutes } from "./tags/routes";
import { savedReplyRoutes } from "./saved-replies/routes";
import { searchRoutes } from "./search/routes";
import { attachmentRoutes } from "./attachments/routes";
import { operationRoutes } from "./operations/routes";
import { webhookRoutes } from "./webhooks/routes";

const app = new Hono<HonoEnv>();

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "blob:"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: "strict-origin-when-cross-origin",
}));

app.use("/api/*", async (context, next) => {
  const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
  const startedAt = performance.now();
  context.set("requestId", requestId);
  context.header("x-request-id", requestId);
  context.header("cache-control", "private, no-store");
  await next();
  context.header("server-timing", `app;dur=${(performance.now() - startedAt).toFixed(1)}`);
});

app.get("/api/health", (context) => context.json({ ok: true, service: "resolvehq" }));
app.get("/api/ready", async (context) => {
  const database = await context.env.DB.prepare("SELECT 1 AS ready").first<{ ready: number }>();
  return context.json({ ok: database?.ready === 1, database: database?.ready === 1 ? "ready" : "unavailable" }, database?.ready === 1 ? 200 : 503);
});
app.route("/api/auth", authRoutes);
app.route("/api/organization", organizationRoutes);
app.route("/api/customers", customerRoutes);
app.route("/api/tickets", ticketRoutes);
app.route("/api/tags", tagRoutes);
app.route("/api/saved-replies", savedReplyRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/attachments", attachmentRoutes);
app.route("/api/operations", operationRoutes);
app.route("/api/webhooks", webhookRoutes);

const v1 = new Hono<HonoEnv>();
v1.route("/auth", authRoutes);
v1.route("/organization", organizationRoutes);
v1.route("/customers", customerRoutes);
v1.route("/tickets", ticketRoutes);
v1.route("/tags", tagRoutes);
v1.route("/saved-replies", savedReplyRoutes);
v1.route("/search", searchRoutes);
v1.route("/attachments", attachmentRoutes);
v1.route("/operations", operationRoutes);
v1.route("/webhooks", webhookRoutes);
app.route("/api/v1", v1);

app.notFound((context) => {
  if (context.req.path.startsWith("/api/")) {
    return context.json({ error: { code: "not_found", message: "The requested resource was not found.", requestId: context.get("requestId") } }, 404);
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

app.onError((error, context) => {
  if (error instanceof HttpError) {
    return context.json({ error: { code: error.code, message: error.message, requestId: context.get("requestId") } }, error.status);
  }
  if (error instanceof SyntaxError) {
    return context.json({ error: { code: "invalid_json", message: "Request body must be valid JSON.", requestId: context.get("requestId") } }, 400);
  }
  console.error("Unhandled request error", error);
  return context.json({ error: { code: "internal_error", message: "Something went wrong.", requestId: context.get("requestId") } }, 500);
});

export default app;
