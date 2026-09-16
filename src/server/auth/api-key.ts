import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { createDb } from "resolve-server/db";
import { apiKeys, organizationMemberships } from "resolve-server/db/schema";
import { HttpError } from "resolve-server/http/errors";
import { sha256 } from "resolve-server/lib/crypto";
import type { HonoEnv, Role, TenantContext } from "resolve-server/types";
import { SESSION_COOKIE } from "./session";

/**
 * Coarse on purpose. Fine-grained scopes for a fifteen-person team are a UI burden
 * with no security gain.
 */
export const API_SCOPES = [
  "tickets:read",
  "tickets:write",
  "customers:read",
  "customers:write",
  "kb:read",
  "reports:read",
  "mcp:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** What each live role is allowed to grant. The effective permission is the narrower of the two. */
const ROLE_SCOPES: Record<Role, readonly ApiScope[]> = {
  agent: ["tickets:read", "tickets:write", "customers:read", "kb:read", "mcp:read"],
  admin: API_SCOPES,
  owner: API_SCOPES,
};

export interface ApiKeyContext {
  id: string;
  name: string;
  scopes: ApiScope[];
  /** Null means every inbox. */
  inboxIds: string[] | null;
}

/**
 * Every failure answers identically. Distinguishing "unknown", "revoked" and "expired"
 * would tell a caller which of their guesses was once a real key.
 */
function denied(): never {
  throw new HttpError(401, "invalid_api_key", "The API key is missing, invalid, revoked, or expired.");
}

/**
 * Maps a request to the scope it needs.
 *
 * Deny by default: a surface with no scope in the vocabulary is not reachable with a
 * key at all. Adding one later is a deliberate act, and it cannot be done by accident.
 */
export function scopeForRequest(method: string, path: string): ApiScope | null {
  const read = method === "GET" || method === "HEAD";
  // Handles both the versioned REST surface and the MCP endpoint, which sits beside it.
  const section = path.replace(/^\/api(\/v1)?/, "").split("/").filter(Boolean)[0] ?? "";
  if (section === "tickets" || section === "search") return read ? "tickets:read" : "tickets:write";
  if (section === "customers") return read ? "customers:read" : "customers:write";
  if (section === "knowledge-base" || section === "help-center") return read ? "kb:read" : null;
  if (section === "reports") return read ? "reports:read" : null;
  if (section === "mcp") return "mcp:read";
  return null;
}

/**
 * Authenticates a bearer key and sets the tenant, so the shared route objects mounted
 * under /api/v1 see an already-resolved caller.
 *
 * The live-role recheck is the whole design: scopes captured at creation time are
 * intersected with what the creating member is permitted to grant *right now*, so
 * demoting or removing that member immediately reduces every key they issued, with no
 * re-issue required.
 */
export const requireApiKey: MiddlewareHandler<HonoEnv> = async (context, next) => {
  const header = context.req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) denied();
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) denied();

  // A key must never ride a browser session: mixing the two makes a CSRF-exempt path
  // reachable with ambient cookie authority.
  if (getCookie(context, SESSION_COOKIE))
    throw new HttpError(400, "ambiguous_credentials", "Send either a session cookie or an API key, not both.");

  const db = createDb(context.env.DB);
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, await sha256(presented))).limit(1);
  if (!key) denied();
  if (key.revokedAt) denied();
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) denied();
  // The creating member was deleted, so the key is orphaned and has no role to inherit.
  if (!key.createdByUserId) denied();

  const [member] = await db
    .select({ role: organizationMemberships.role, disabledAt: organizationMemberships.disabledAt })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, key.organizationId),
        eq(organizationMemberships.userId, key.createdByUserId),
      ),
    )
    .limit(1);
  if (!member || member.disabledAt) denied();

  const allowed = new Set<string>(ROLE_SCOPES[member.role as Role]);
  const effective = (key.scopes ?? []).filter((scope): scope is ApiScope =>
    allowed.has(scope),
  );

  const required = scopeForRequest(context.req.method, context.req.path);
  if (!required)
    throw new HttpError(403, "unsupported_surface", "This endpoint cannot be used with an API key.");
  if (!effective.includes(required))
    throw new HttpError(403, "insufficient_scope", `This key does not have the ${required} scope.`);

  if (!(await context.env.WRITE_RATE_LIMIT.limit({ key: `api-key:${key.id}` })).success)
    throw new HttpError(429, "rate_limited", "Too many requests for this API key.");

  const tenant: TenantContext = {
    requestId: context.get("requestId"),
    userId: key.createdByUserId,
    organizationId: key.organizationId,
    role: member.role as Role,
    // No browser session exists, so there is no CSRF token to match. Nothing on this
    // path calls assertMutationOrigin.
    csrfToken: "",
  };
  context.set("tenant", tenant);
  context.set("apiKey", {
    id: key.id,
    name: key.name,
    scopes: effective,
    inboxIds: key.inboxIds ?? null,
  });

  await touchLastUsed(context.env.DB, key.id, key.lastUsedAt?.getTime() ?? 0);
  await next();
};

/** Throttled to once a minute per key: a write per request would burn the D1 daily budget. */
async function touchLastUsed(database: D1Database, keyId: string, lastUsedAt: number) {
  const now = Date.now();
  if (now - lastUsedAt < 60_000) return;
  await database.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, keyId).run();
}
