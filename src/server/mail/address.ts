import { constantTimeEqual, signValue } from "../lib/crypto";

/**
 * Splits a delivery address into the mailbox that owns it and the plus tag the
 * sender replied to. Mail to `support+t1002.ab12cd34ef@acme.test` is mail for
 * `support@acme.test` carrying the tag `t1002.ab12cd34ef`.
 */
export function canonicalizeRecipient(address: string): { inboxAddress: string; tag: string | null } {
  const value = address.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return { inboxAddress: value, tag: null };
  const local = value.slice(0, at);
  const plus = local.indexOf("+");
  if (plus < 0) return { inboxAddress: value, tag: null };
  return { inboxAddress: `${local.slice(0, plus)}${value.slice(at)}`, tag: local.slice(plus + 1) || null };
}

const replyTagPattern = /^t(\d{1,12})\.([A-Za-z0-9_-]{10})$/;

/** Reads `t<number>.<signature>` out of a plus tag, or null when it is not one. */
export function parseReplyTag(tag: string | null | undefined) {
  const match = tag ? replyTagPattern.exec(tag) : null;
  return match ? { number: Number(match[1]), token: match[0] } : null;
}

/**
 * A reply address is a bearer credential for exactly one ticket: the signature
 * binds the tenant and the ticket id, so a guessed ticket number alone never
 * opens a conversation.
 */
export async function replyToken(
  env: { SESSION_PEPPER: string },
  organizationId: string,
  ticketId: string,
  number: number,
) {
  // Mail addresses are normalised to lower case before the tag is read, so the
  // signature has to be case-insensitive to survive the round trip.
  const signature = await signValue(`reply-token:${organizationId}:${ticketId}`, env.SESSION_PEPPER);
  return `t${number}.${signature.slice(0, 10).toLowerCase()}`;
}

export async function verifyReplyToken(
  env: { SESSION_PEPPER: string },
  organizationId: string,
  ticketId: string,
  number: number,
  token: string,
) {
  return constantTimeEqual(await replyToken(env, organizationId, ticketId, number), token.toLowerCase());
}

/** Turns an inbox address into the tagged address replies to a ticket should use. */
export function taggedAddress(address: string, token: string) {
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  return `${address.slice(0, at)}+${token}${address.slice(at)}`;
}
