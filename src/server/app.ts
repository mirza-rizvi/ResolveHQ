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
  context.header("x-request-id", requestId);
  await next();
});

app.get("/api/health", (context) => context.json({ ok: true, service: "resolvehq" }));
app.route("/api/auth", authRoutes);
app.route("/api/organization", organizationRoutes);
app.route("/api/customers", customerRoutes);
app.route("/api/tickets", ticketRoutes);
app.route("/api/tags", tagRoutes);
app.route("/api/saved-replies", savedReplyRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/attachments", attachmentRoutes);

app.notFound((context) => {
  if (context.req.path.startsWith("/api/")) {
    return context.json({ error: { code: "not_found", message: "The requested resource was not found." } }, 404);
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

app.onError((error, context) => {
  if (error instanceof HttpError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error("Unhandled request error", error);
  return context.json({ error: { code: "internal_error", message: "Something went wrong." } }, 500);
});

export default app;
