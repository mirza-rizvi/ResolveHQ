import { mailRecoveryRoutes } from "./mail/recovery";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { HonoEnv } from "./types";
import { authRoutes } from "./auth/routes";
import { organizationRoutes } from "./organizations/routes";
import { HttpError } from "./http/errors";
import { isMissingSchemaError, missingTables, MIGRATE_COMMAND } from "./db/health";
import { requireApiKey } from "./auth/api-key";
import { mcpRoutes } from "./mcp/routes";
import { customerRoutes } from "./customers/routes";
import { ticketRoutes } from "./tickets/routes";
import { tagRoutes } from "./tags/routes";
import { savedReplyRoutes } from "./saved-replies/routes";
import { searchRoutes } from "./search/routes";
import { attachmentRoutes } from "./attachments/routes";
import { operationRoutes } from "./operations/routes";
import { webhookRoutes } from "./webhooks/routes";
import { knowledgeBaseRoutes, helpCenterRoutes } from "./knowledge-base/routes";
import { reportRoutes } from "./reports/routes";
import { automationRoutes } from "./automations/routes";
import { slaRoutes } from "./sla/routes";
import { csatRoutes } from "./csat/routes";
import { csatAdminRoutes } from "./csat/admin-routes";
import { apiKeyRoutes } from "./api-keys/routes";
import { webhookEndpointRoutes } from "./webhooks/endpoints-routes";
import { backupRoutes } from "./backups/routes";
import { privacyRoutes } from "./privacy/routes";
import { assistantRoutes } from "./assistant/routes";

const app = new Hono<HonoEnv>();

// Keep this policy in sync with public/_headers: that file governs asset-server responses
// (the SPA HTML/JS/CSS under the current single-page-application routing), this middleware
// governs anything the Worker itself responds to (API routes, app.notFound fallbacks, etc.),
// and hono/secure-headers overwrites any CSP the asset server would otherwise have set. A
// directive added to one must be added to the other or it only half-applies.
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
      connectSrc: ["'self'"],
      frameSrc: ["https://challenges.cloudflare.com"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
  }),
);

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
  // `SELECT 1` answers on a database with no tables at all, which is exactly what a
  // freshly provisioned D1 looks like when the migrations were never applied. Readiness
  // has to mean "this schema can serve requests", so the tables are what is checked.
  let missing: string[];
  try {
    missing = await missingTables(context.env.DB);
  } catch {
    return context.json({ ok: false, database: "unavailable" }, 503);
  }
  if (missing.length > 0)
    return context.json(
      {
        ok: false,
        database: "unmigrated",
        // A count, never the names. This endpoint is deliberately unauthenticated so an
        // operator can check a deployment before signing in, and the schema of a product
        // is not something an anonymous caller needs enumerated back to them.
        missingTables: missing.length,
        detail: `The database is missing ${missing.length} table(s). Apply the migrations: ${MIGRATE_COMMAND}`,
      },
      503,
    );
  return context.json({ ok: true, database: "ready" });
});
app.route("/api/auth", authRoutes);
// Registered before the /api/organization mount so the more specific path wins.
app.route("/api/organization/api-keys", apiKeyRoutes);
app.route("/api/organization/webhooks", webhookEndpointRoutes);
app.route("/api/organization/backups", backupRoutes);
app.route("/api/organization", organizationRoutes);
app.route("/api/customers", customerRoutes);
app.route("/api/tickets", ticketRoutes);
app.route("/api/tags", tagRoutes);
app.route("/api/saved-replies", savedReplyRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/attachments", attachmentRoutes);
app.route("/api/operations", operationRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/mail-recovery", mailRecoveryRoutes);
app.route("/api/knowledge-base", knowledgeBaseRoutes);
app.route("/api/help-center", helpCenterRoutes);
app.route("/api/reports", reportRoutes);
app.route("/api/automations", automationRoutes);
app.route("/api/sla", slaRoutes);
// Public and unauthenticated: rating links are clicked from a customer's mail client.
app.route("/api/csat", csatRoutes);
app.route("/api/satisfaction", csatAdminRoutes);
app.route("/api/privacy", privacyRoutes);
app.route("/api/assistant", assistantRoutes);

const v1 = new Hono<HonoEnv>();
/**
 * The versioned surface accepts either a browser session or an API key. /api/* stays
 * session-only: keeping the browser surface and the programmatic surface apart is what
 * keeps the CSRF story coherent.
 */
v1.use("*", async (context, next) => {
  if (context.req.header("authorization")?.startsWith("Bearer ")) return requireApiKey(context, next);
  return next();
});
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
v1.route("/mail-recovery", mailRecoveryRoutes);
v1.route("/knowledge-base", knowledgeBaseRoutes);
v1.route("/help-center", helpCenterRoutes);
v1.route("/reports", reportRoutes);
v1.route("/automations", automationRoutes);
v1.route("/privacy", privacyRoutes);
v1.route("/assistant", assistantRoutes);
app.route("/api/v1", v1);
// Mounted outside both /api/* and /api/v1/*: an MCP client speaks JSON-RPC, not REST,
// and authenticates with a key carrying mcp:read.
app.route("/api/mcp", mcpRoutes);

app.notFound((context) => {
  if (context.req.path.startsWith("/api/")) {
    return context.json(
      {
        error: {
          code: "not_found",
          message: "The requested resource was not found.",
          requestId: context.get("requestId"),
        },
      },
      404,
    );
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

app.onError((error, context) => {
  if (error instanceof HttpError) {
    return context.json(
      { error: { code: error.code, message: error.message, requestId: context.get("requestId") } },
      error.status,
    );
  }
  if (error instanceof SyntaxError) {
    return context.json(
      {
        error: {
          code: "invalid_json",
          message: "Request body must be valid JSON.",
          requestId: context.get("requestId"),
        },
      },
      400,
    );
  }
  // A Worker deployed against a database whose migrations never ran fails here on every
  // request that touches a table. Saying so beats "Something went wrong": the operator
  // cannot guess the cause, and this is the first thing a fresh deployment hits.
  if (isMissingSchemaError(error)) {
    console.error({
      event: "database_not_migrated",
      requestId: context.get("requestId"),
      message: error instanceof Error ? error.message : String(error),
    });
    return context.json(
      {
        error: {
          code: "database_not_migrated",
          message: `The database schema is missing. Apply the migrations, then retry: ${MIGRATE_COMMAND}`,
          requestId: context.get("requestId"),
        },
      },
      503,
    );
  }
  console.error({
    event: "request_failed",
    requestId: context.get("requestId"),
    message: error instanceof Error ? error.message : String(error),
  });
  return context.json(
    { error: { code: "internal_error", message: "Something went wrong.", requestId: context.get("requestId") } },
    500,
  );
});

export default app;
