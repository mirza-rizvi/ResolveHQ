import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db";
import { messages, tickets } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { resolveAIProvider, type AIProvider } from "../providers/ai";
import { readAiEnabled } from "../organizations/settings";
import type { AppBindings, HonoEnv, TenantContext } from "../types";

const ticketThreadInput = z.object({
  ticketId: z.string().min(1).max(80),
  instruction: z.string().trim().max(2_000).optional(),
});

const translateInput = z
  .object({
    ticketId: z.string().min(1).max(80),
    // Two-letter ISO 639-1 only: the Workers AI translation model rejects regional tags.
    targetLanguage: z.string().regex(/^[a-z]{2}$/),
    sourceLanguage: z.string().regex(/^[a-z]{2}$/).optional(),
    messageId: z.string().min(1).max(80).optional(),
    text: z.string().trim().min(1).max(20_000).optional(),
  })
  .refine((input) => Boolean(input.messageId) !== Boolean(input.text), {
    message: "Provide either messageId or text.",
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

/**
 * The Worker key only makes AI available; each workspace opts in through
 * Settings. The workspace check runs first so a disabled workspace can never
 * reach the provider, and the missing-key check keeps unconfigured Workers
 * answering with a setup hint instead of a silent failure.
 */
async function requireWorkspaceProvider(env: AppBindings, organizationId: string): Promise<AIProvider> {
  if (!(await readAiEnabled(env.DB, organizationId)))
    throw new HttpError(
      403,
      "ai_disabled",
      "AI assistance is disabled for this workspace. An admin can enable it in Settings.",
    );
  const provider = resolveAIProvider(env);
  if (!provider)
    throw new HttpError(
      503,
      "ai_unavailable",
      "AI assistance is not configured. Add the Workers AI binding (AI) or set OPENAI_API_KEY on the Worker to enable it.",
    );
  return provider;
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
  const provider = await requireWorkspaceProvider(context.env, tenant.organizationId);
  const thread = await loadThread(context.env.DB, tenant.organizationId, input.ticketId);
  const summary = await provider.summarize({
    subject: thread.ticket.subject,
    messages: thread.thread ? [thread.thread] : [],
  });
  return context.json({ summary });
});

assistantRoutes.post("/draft", validate("json", ticketThreadInput), async (context) => {
  const tenant = await authorizeAssistantRequest(context);
  const input = context.req.valid("json");
  const provider = await requireWorkspaceProvider(context.env, tenant.organizationId);
  const thread = await loadThread(context.env.DB, tenant.organizationId, input.ticketId);
  const draft = await provider.draftReply({
    subject: thread.ticket.subject,
    messages: thread.thread ? [thread.thread] : [],
    instruction: input.instruction,
  });
  return context.json({ draft });
});

assistantRoutes.post("/classify", validate("json", ticketThreadInput), async (context) => {
  const tenant = await authorizeAssistantRequest(context);
  const input = context.req.valid("json");
  const provider = await requireWorkspaceProvider(context.env, tenant.organizationId);
  const thread = await loadThread(context.env.DB, tenant.organizationId, input.ticketId);
  const classification = await provider.classify({
    subject: thread.ticket.subject,
    body: thread.thread,
  });
  return context.json({ classification });
});

/**
 * Translation reads one stored message or takes text from the composer. Both
 * paths resolve the ticket inside the caller's organization first, so a message
 * id from another workspace resolves to nothing rather than to its body.
 */
assistantRoutes.post("/translate", validate("json", translateInput), async (context) => {
  const tenant = await authorizeAssistantRequest(context);
  const input = context.req.valid("json");
  const provider = await requireWorkspaceProvider(context.env, tenant.organizationId);
  const db = createDb(context.env.DB);
  const [ticket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.id, input.ticketId), eq(tickets.organizationId, tenant.organizationId)))
    .limit(1);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  let source = input.text ?? "";
  if (input.messageId) {
    const [message] = await db
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.messageId),
          eq(messages.organizationId, tenant.organizationId),
          eq(messages.ticketId, ticket.id),
        ),
      )
      .limit(1);
    if (!message) throw new HttpError(404, "message_not_found", "Message not found.");
    source = message.bodyText;
  }
  source = source.slice(0, 20_000).trim();
  if (!source) throw new HttpError(400, "nothing_to_translate", "There is no text to translate.");
  const translation = await provider.translate({
    text: source,
    targetLanguage: input.targetLanguage,
    sourceLanguage: input.sourceLanguage,
  });
  return context.json({ translation: translation.text, targetLanguage: input.targetLanguage });
});
