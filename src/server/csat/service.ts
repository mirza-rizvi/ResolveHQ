import { and, eq } from "drizzle-orm";
import { createDb } from "../db";
import { csatResponses, settings } from "../db/schema";
import { newId } from "../lib/id";
import type { AppBindings } from "../types";
import { CSAT_RATINGS, CSAT_RATING_LABELS, csatToken, type CsatRating } from "./token";

export const CSAT_ENABLED_KEY = "csat.enabled";
export const CSAT_PROMPT_KEY = "csat.prompt";
export const DEFAULT_CSAT_PROMPT = "How did we do?";

/** Off by default: a survey nobody asked for is worse than no survey. */
export async function readCsatSettings(env: AppBindings, organizationId: string) {
  const rows = await createDb(env.DB)
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.organizationId, organizationId));
  const enabled = rows.find((row) => row.key === CSAT_ENABLED_KEY)?.value === true;
  const raw = rows.find((row) => row.key === CSAT_PROMPT_KEY)?.value;
  const prompt = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_CSAT_PROMPT;
  return { enabled, prompt };
}

export interface SurveyParts {
  text: string;
  html: string;
}

/** Plain links only. No tracking pixel, no external images, no web fonts — deliberately. */
export async function renderSurvey(
  env: AppBindings,
  appUrl: string,
  ticketId: string,
  prompt: string,
): Promise<SurveyParts> {
  const faces: Record<CsatRating, string> = { 1: "😞", 3: "😐", 5: "🙂" };
  const links = await Promise.all(
    CSAT_RATINGS.map(async (rating) => ({
      rating,
      label: CSAT_RATING_LABELS[rating],
      face: faces[rating],
      url: `${appUrl.replace(/\/+$/, "")}/rate/${await csatToken(env, ticketId, rating)}`,
    })),
  );
  const text = [
    "",
    "---",
    prompt,
    ...links.map((link) => `${link.label.padEnd(5)} ${link.url}`),
  ].join("\n");
  const html = [
    '<hr style="border:0;border-top:1px solid #dddddd;margin:24px 0 12px">',
    `<p style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#454245;margin:0 0 8px">${escapeHtml(prompt)}</p>`,
    '<p style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0">',
    links
      .map(
        (link) =>
          `<a href="${escapeHtml(link.url)}" style="display:inline-block;margin-right:14px;text-decoration:none;color:#1264a3">${link.face} ${escapeHtml(link.label)}</a>`,
      )
      .join(""),
    "</p>",
  ].join("");
  return { text, html };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Claims the single survey slot for a ticket, returning false when one already exists.
 *
 * The unique index on `ticket_id` is the real guard: a ticket that is resolved, reopened
 * and resolved again must not survey the customer twice.
 */
export async function claimSurvey(
  env: AppBindings,
  organizationId: string,
  ticketId: string,
  customerId: string,
  messageId: string,
) {
  const now = new Date();
  const inserted = await createDb(env.DB)
    .insert(csatResponses)
    .values({
      id: newId("csat"),
      organizationId,
      ticketId,
      customerId,
      messageId,
      sentAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: csatResponses.id });
  return inserted.length > 0;
}

export async function surveyExists(env: AppBindings, organizationId: string, ticketId: string) {
  const [row] = await createDb(env.DB)
    .select({ id: csatResponses.id })
    .from(csatResponses)
    .where(and(eq(csatResponses.organizationId, organizationId), eq(csatResponses.ticketId, ticketId)))
    .limit(1);
  return Boolean(row);
}
