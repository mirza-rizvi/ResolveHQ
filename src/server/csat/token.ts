import { constantTimeEqual, signValue } from "../lib/crypto";

/** Three faces, not five stars: fewer choices raise response rates, the comment carries nuance. */
export const CSAT_RATINGS = [1, 3, 5] as const;
export type CsatRating = (typeof CSAT_RATINGS)[number];

export const CSAT_RATING_LABELS: Record<CsatRating, string> = { 1: "Bad", 3: "OK", 5: "Good" };

/**
 * Signs the ticket id **and the rating together**.
 *
 * Signing the ticket id alone would let anyone edit `…/rate/tkt_1.1.<sig>` into
 * `…/rate/tkt_1.5.<sig>` and still pass verification, so each rating gets its own link.
 *
 * Nothing token-shaped is stored: the server recomputes the HMAC and compares. Reading
 * the database therefore does not let an attacker forge a link.
 *
 * Signed with SESSION_PEPPER, like the reply token — rotating the pepper invalidates
 * outstanding rating links, which is documented in docs/deployment.md.
 */
export async function csatToken(env: { SESSION_PEPPER: string }, ticketId: string, rating: CsatRating) {
  const payload = `${ticketId}.${rating}`;
  const signature = await signValue(`csat:${payload}`, env.SESSION_PEPPER);
  return `${payload}.${signature}`;
}

export interface CsatTokenParts {
  ticketId: string;
  rating: CsatRating;
}

/**
 * Verifies a rating token without touching the database. Returns null for anything
 * malformed, tampered with, or signed for a different rating.
 */
export async function verifyCsatToken(
  env: { SESSION_PEPPER: string },
  token: string,
): Promise<CsatTokenParts | null> {
  // Split from the right: the signature is the last segment, and a ticket id never
  // contains a dot, but splitting from the left would break if that ever changed.
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  if (!signature) return null;

  const ratingDot = payload.lastIndexOf(".");
  if (ratingDot <= 0) return null;
  const ticketId = payload.slice(0, ratingDot);
  const rating = Number(payload.slice(ratingDot + 1));
  if (!CSAT_RATINGS.includes(rating as CsatRating)) return null;

  const expected = await signValue(`csat:${payload}`, env.SESSION_PEPPER);
  if (!constantTimeEqual(expected, signature)) return null;
  return { ticketId, rating: rating as CsatRating };
}
