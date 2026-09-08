import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db";
import { messages, tickets } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { OpenAIProvider, type AIProvider } from "../providers/ai";
import type { AppBindings, HonoEnv, TenantContext } from "../types";

/** AI is strictly opt-in: it activates only when an API key is configured. */
export function resolveAIProvider(env: AppBindings): AIProvider | null {
  if (!env.OPENAI_API_KEY) return null;
  return new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL || "gpt-4o-mini");
}

function requireProvider(env: AppBindings): AIProvider {
  const provider = resolveAIProvider(env);
  if (!provider)
    throw new HttpError(
      503,
      "ai_unavailable",
      "AI assistance is not configured. Set OPENAI_API_KEY on the Worker to enable it.",
    );
  return provider;
}

const ticketThreadInput = z.object({
  ticketId: z.string().min(1).max(80),
  instruction: z.string().trim().max(2_000).optional(),
});

interface AssistantRequestContext {
  env: AppBindings;
  get: (key: "tenant") => TenantContext;
}

async function authorizeAssistantRequest(context: AssistantRequestContext) {
  const tenant = context.get("tenant");
  if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `assistant:${tenant.userId}` })).success)
    throw new HttpError(429, "rate_limited", "AI requests are rate limited. Try again in a moment.");
  return tenant;
}

async function loadThread(database: D1Database, organizationId: string, ticketId: string) {
  const db = createDb(database);
  const [ticket] = await db
    .select({ id: tickets.id, subject: tickets.subject, number: tickets.number })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, organizationId)))
    .limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  const rows = await db
    .select({ authorType: messages.authorType, kind: messages.kind, bodyText: messages.bodyText })
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), eq(messages.ticketId, ticketId)))
    .orderBy(desc(messages.createdAt))
    .limit(40);
  const thread = rows
    .reverse()
    .map(
      (row) =>
        `${row.authorType === "customer" ? "Customer" : row.kind === "internal_note" ? "Internal note" : "Agent"}: ${row.bodyText}`,
    )
    .join("\n\n")
    .slice(0, 60_000);
  return { ticket, thread };
}

export const assistantRoutes = new Hono<HonoEnv>();
assistantRoutes.use("*", requireAuth);

assistantRoutes.post("/summarize", validate("json", ticketThreadInput), async (context) => {
  const tenant = await authorizeAssistantRequest(context);
  const input = context.req.valid("json");
  const thread = await loadThread(context.env.DB, tenant.organizationId, input.ticketId);
  const summary = await requireProvider(context.env).summarize({
    subject: thread.ticket.subject,
    messages: thread.thread ? [thread.thread] : [],
  });
  return context.json({ summary });
});

assistantRoutes.post("/draft", validate("json", ticketThreadInput), async (context) => {
  const tenant = await authorizeAssistantRequest(context);
  const input = context.req.valid("json");
  const thread = await loadThread(context.env.DB, tenant.organizationId, input.ticketId);
  const draft = await requireProvider(context.env).draftReply({
    subject: thread.ticket.subject,
    messages: thread.thread ? [thread.thread] : [],
    instruction: input.instruction,
  });
  return context.json({ draft });
});

assistantRoutes.post("/classify", validate("json", ticketThreadInput), async (context) => {
  const tenant = await authorizeAssistantRequest(context);
  const input = context.req.valid("json");
  const thread = await loadThread(context.env.DB, tenant.organizationId, input.ticketId);
  const classification = await requireProvider(context.env).classify({
    subject: thread.ticket.subject,
    body: thread.thread,
  });
  return context.json({ classification });
});
