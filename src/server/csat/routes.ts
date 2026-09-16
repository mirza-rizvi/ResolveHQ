import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { createDb } from "../db";
import { csatResponses } from "../db/schema";
import { validate } from "../http/validate";
import type { HonoEnv } from "../types";
import { verifyCsatToken } from "./token";

/**
 * The only public, unauthenticated mutation in the product.
 *
 * Every failure answers the same way — `{ status: "unavailable" }` with a 200 — so the
 * endpoint never reveals whether a ticket exists, never leaks internals, and never
 * returns a 500 to a customer who clicked a link in an email. The customer sees a calm
 * sentence either way.
 */
export const csatRoutes = new Hono<HonoEnv>();

const commentInput = z.object({ comment: z.string().trim().max(2000) });

/** Deliberately indistinguishable from "no such ticket", "already used" and "bad signature". */
const unavailable = { status: "unavailable" as const };

csatRoutes.post("/:token", async (context) => {
  const token = context.req.param("token");
  const rate = await context.env.AUTH_RATE_LIMIT.limit({ key: `csat:${clientKey(context.req.raw)}` });
  if (!rate.success) return context.json(unavailable);

  // Signature first: nothing touches the database until the token proves itself.
  const parts = await verifyCsatToken(context.env, token);
  if (!parts) return context.json(unavailable);

  const db = createDb(context.env.DB);
  const now = new Date();
  // Single-use is enforced by the predicate, not by a read-then-write, so two
  // simultaneous clicks cannot both win.
  const claimed = await db
    .update(csatResponses)
    .set({ rating: parts.rating, respondedAt: now, consumedAt: now, updatedAt: now })
    .where(and(eq(csatResponses.ticketId, parts.ticketId), isNull(csatResponses.consumedAt)))
    .returning({ id: csatResponses.id, rating: csatResponses.rating });

  if (claimed.length) return context.json({ status: "recorded", rating: parts.rating });

  // Already rated: confirm the score actually recorded rather than silently accepting
  // a different one, and stay idempotent for a customer who clicks the same link twice.
  const [existing] = await db
    .select({ rating: csatResponses.rating, comment: csatResponses.comment })
    .from(csatResponses)
    .where(eq(csatResponses.ticketId, parts.ticketId))
    .limit(1);
  if (!existing) return context.json(unavailable);
  return context.json({
    status: "already_rated",
    rating: existing.rating,
    hasComment: Boolean(existing.comment),
  });
});

csatRoutes.post("/:token/comment", validate("json", commentInput), async (context) => {
  const rate = await context.env.AUTH_RATE_LIMIT.limit({ key: `csat:${clientKey(context.req.raw)}` });
  if (!rate.success) return context.json(unavailable);

  const parts = await verifyCsatToken(context.env, context.req.param("token"));
  if (!parts) return context.json(unavailable);

  const comment = context.req.valid("json").comment;
  // A comment without a rating would be an unanswered survey with prose attached;
  // the rating is what the link recorded.
  const updated = await createDb(context.env.DB)
    .update(csatResponses)
    .set({ comment: comment || null, updatedAt: new Date() })
    .where(and(eq(csatResponses.ticketId, parts.ticketId), eq(csatResponses.rating, parts.rating)))
    .returning({ id: csatResponses.id });
  if (!updated.length) return context.json(unavailable);
  return context.json({ status: "recorded" });
});

/** Rate limiting keyed on the caller, falling back to a shared bucket behind a proxy. */
function clientKey(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "local";
}
