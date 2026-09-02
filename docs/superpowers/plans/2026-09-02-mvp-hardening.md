# ResolveHQ MVP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the customer-email → agent-reply → customer-reply loop work end to end, surface failures, close tenant/security gaps, and make the inbox UI resilient.

**Architecture:** One Cloudflare Worker (Hono) serving `/api/*` plus a Vite React SPA. D1 via Drizzle is the source of truth; R2 for objects; Queues for mail. Server work lands in `src/server/*`, UI in `src/web/*`. Every schema change goes into one new migration `drizzle/migrations/0002_mvp_hardening.sql`.

**Tech Stack:** TypeScript, Hono 4, Drizzle ORM (sqlite/D1), Zod 4, React 19, react-router 7, @tanstack/react-query 5, TipTap 3, Vitest 4 with `@cloudflare/vitest-pool-workers`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-mvp-hardening-design.md`

## Global Constraints

- Two-space indent, semicolons, double quotes (AGENTS.md). Server modules import via `resolve-server/...` aliases (see `wrangler.jsonc` `alias` and `vitest.config.ts`); when you add a new server module that tests import, add it to BOTH alias maps.
- Every tenant-owned read/write must filter by `organization_id`.
- Tests: `npm test` (Vitest, runs against a fresh D1 with all migrations applied via `tests/setup.ts`). `signup(suffix)` and `request(path, init, session)` helpers live in `tests/helpers.ts`. Suffixes must be unique per test (they become emails and slugs).
- `npm run typecheck` and `npm run lint` must pass before each commit.
- Commit with the repo's existing git identity; no AI co-author trailers. Never push.
- Drizzle migration journal: after adding `0002_mvp_hardening.sql`, append an entry to `drizzle/migrations/meta/_journal.json` (copy the shape of the `0001` entry, `idx: 2`, `tag: "0002_mvp_hardening"`, `when` = current epoch ms). Do not run `drizzle-kit generate`.

---

### Task 1: Migration 0002, schema, validation envelope

**Files:**
- Create: `drizzle/migrations/0002_mvp_hardening.sql`
- Modify: `drizzle/migrations/meta/_journal.json`
- Modify: `src/server/db/schema.ts`
- Create: `src/server/http/validate.ts`
- Modify: every route file using `zValidator` (`src/server/auth/routes.ts`, `organizations/routes.ts`, `customers/routes.ts`, `tickets/routes.ts`, `tags/routes.ts`, `saved-replies/routes.ts`, `operations/routes.ts`)
- Modify: `wrangler.jsonc` and `vitest.config.ts` alias maps (add `resolve-server/http/validate`, `resolve-server/mail/system`, `resolve-server/lib/sanitize-html`, `resolve-server/search/index`, `resolve-server/tickets/service`, `resolve-server/mail/queue` — some are created in later tasks; adding aliases now is harmless)
- Test: `tests/validation.test.ts`

**Interfaces:**
- Produces: `validate(target: "json" | "query", schema: ZodSchema)` Hono middleware; on failure throws `HttpError(400, "validation_error", "<path>: <message>")`. Handlers keep using `context.req.valid("json")`.
- Produces schema tables: `mailCaptures`, `passwordResetTokens`; columns `messages.rfcMessageId`; `attachments.messageId` nullable.

- [ ] **Step 1: Write the failing test**

```ts
// tests/validation.test.ts
import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("validation envelope", () => {
  it("returns the standard error shape for invalid JSON bodies", async () => {
    const session = await signup("validation");
    const response = await request("/customers", { method: "POST", body: JSON.stringify({ name: "", email: "not-an-email" }) }, session);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run tests/validation.test.ts` → FAIL (body has `success:false`, no `error.code`).

- [ ] **Step 3: Migration**

```sql
-- drizzle/migrations/0002_mvp_hardening.sql
ALTER TABLE messages ADD COLUMN rfc_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS messages_organization_rfc_uidx ON messages (organization_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
UPDATE messages SET rfc_message_id = provider_message_id WHERE author_type = 'customer' AND provider_message_id LIKE '<%';

CREATE TABLE mail_captures (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  to_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  html TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX mail_captures_org_created_idx ON mail_captures (organization_id, created_at);
CREATE INDEX mail_captures_to_created_idx ON mail_captures (to_address, created_at);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- attachments.message_id becomes nullable (SQLite table rebuild)
CREATE TABLE attachments_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO attachments_new SELECT id, organization_id, ticket_id, message_id, object_key, filename, content_type, size, checksum, uploaded_by_user_id, created_at FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;
CREATE INDEX attachments_organization_ticket_idx ON attachments (organization_id, ticket_id);
CREATE INDEX attachments_organization_message_idx ON attachments (organization_id, message_id);
CREATE INDEX attachments_pending_idx ON attachments (message_id, created_at) WHERE message_id IS NULL;
```

Check the existing `0000`/`0001` SQL for the exact original `attachments` column list before writing the rebuild; the `INSERT ... SELECT` column order must match.

- [ ] **Step 4: Schema** — in `src/server/db/schema.ts`: add `rfcMessageId: text("rfc_message_id")` to `messages` and `uniqueIndex("messages_organization_rfc_uidx").on(table.organizationId, table.rfcMessageId)`; make `attachments.messageId` `text("message_id").references(() => messages.id, { onDelete: "cascade" })` (drop `.notNull()`); add:

```ts
export const mailCaptures = sqliteTable("mail_captures", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  toAddress: text("to_address").notNull(),
  fromAddress: text("from_address").notNull(),
  subject: text("subject").notNull(),
  text: text("text").notNull(),
  html: text("html"),
  headers: text("headers", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [index("mail_captures_org_created_idx").on(table.organizationId, table.createdAt)]);

export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [index("password_reset_tokens_user_idx").on(table.userId)]);
```

- [ ] **Step 5: validate wrapper**

```ts
// src/server/http/validate.ts
import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import { HttpError } from "./errors";

export function validate<T extends ZodType>(target: "json" | "query", schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
      throw new HttpError(400, "validation_error", `${path}${issue?.message ?? "Invalid input."}`);
    }
  });
}
```

Replace every `zValidator(` call with `validate(` and update imports. Also handle non-JSON bodies: in `src/server/app.ts` `onError`, if `error instanceof SyntaxError` return 400 `{ error: { code: "invalid_json", message: "Request body must be valid JSON." } }`.

- [ ] **Step 6: Run** `npm test` → all pass (existing tests + new). `npm run typecheck && npm run lint`.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: add mvp hardening migration and validation envelope"`

---

### Task 2: System mail and development capture

**Files:**
- Modify: `src/server/providers/mail.ts` (DevelopmentMailProvider writes to D1; `OutgoingMail` gains `messageId?`, `references?`, and `headers` are emitted)
- Create: `src/server/mail/system.ts`
- Modify: `src/server/types.ts` (`SYSTEM_MAIL_FROM?: string`)
- Modify: `src/server/mail/queue.ts` (`processOutboundMail` uses the new provider constructor)
- Modify: `src/server/operations/routes.ts` (`GET /dev-mail`)
- Modify: `.dev.vars.example`, `wrangler.jsonc` vars (`SYSTEM_MAIL_FROM` optional; do not set in production vars)
- Test: `tests/mail.test.ts` (new case), `tests/operations.test.ts` (new case)

**Interfaces:**
- Produces: `class DevelopmentMailProvider { constructor(database: D1Database, organizationId?: string | null) }`.
- Produces: `sendSystemMail(env: AppBindings, mail: { to: string; subject: string; text: string }): Promise<void>` — throws when no provider is configured.
- Produces: `selectOutgoingProvider(env: AppBindings, organizationId: string | null): OutgoingMailProvider | null`.
- Produces: `OutgoingMail { from; to; subject; text; html?; messageId?: string; references?: string[] }`. Resend adapter sends headers `Message-ID` (when `messageId`), `In-Reply-To` (last of `references`), `References` (joined by space).

- [ ] **Step 1: Failing test** — append to `tests/mail.test.ts`:

```ts
it("captures outbound mail in development mode", async () => {
  const workspace = await signup("mail-capture");
  const { request } = await import("./helpers");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "capture@example.test" }) }, workspace);
  const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Cap", email: "cap@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
  const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Capture me", message: "Hello" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
  const reply = await (await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Reply body", kind: "message" }) }, workspace)).json() as { message: { id: string } };
  const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(reply.message.id).first<{ id: string }>();
  await processOutboundMail(env as AppBindings, { jobId: job!.id });
  const capture = await env.DB.prepare("SELECT to_address AS to, subject FROM mail_captures WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(workspace.organizationId).first<{ to: string; subject: string }>();
  expect(capture?.to).toBe("cap@example.test");
  expect(capture?.subject).toContain("Capture me");
  const listed = await request("/operations/dev-mail", {}, workspace);
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as { captures: unknown[] }).captures.length).toBeGreaterThan(0);
});
```

Import `processOutboundMail` alongside `processInboundMail`.

- [ ] **Step 2: Run** → FAIL (`mail_captures` empty / `/operations/dev-mail` 404).

- [ ] **Step 3: Provider changes** in `src/server/providers/mail.ts`:

```ts
export interface OutgoingMail { from: string; to: string; subject: string; text: string; html?: string; messageId?: string; references?: string[] }

export class DevelopmentMailProvider implements OutgoingMailProvider {
  constructor(private readonly database: D1Database, private readonly organizationId: string | null = null) {}
  async send(message: OutgoingMail) {
    const id = `dev_${crypto.randomUUID()}`;
    const headers = { ...(message.messageId ? { "Message-ID": message.messageId } : {}), ...(message.references?.length ? { "In-Reply-To": message.references.at(-1)!, References: message.references.join(" ") } : {}) };
    await this.database.prepare("INSERT INTO mail_captures (id, organization_id, to_address, from_address, subject, text, html, headers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, this.organizationId, message.to, message.from, message.subject, message.text, message.html ?? null, JSON.stringify(headers), Date.now()).run();
    return { providerMessageId: id };
  }
}
```

Resend adapter body: replace the `replyToMessageId` spread with

```ts
headers: {
  ...(message.messageId ? { "Message-ID": message.messageId } : {}),
  ...(message.references?.length ? { "In-Reply-To": message.references.at(-1)!, References: message.references.join(" ") } : {}),
},
```

(omit `headers` entirely when both are empty). Delete `replyToMessageId`.

- [ ] **Step 4: system.ts**

```ts
// src/server/mail/system.ts
import { DevelopmentMailProvider, ResendMailProvider, type OutgoingMailProvider } from "../providers/mail";
import type { AppBindings } from "../types";

export function selectOutgoingProvider(env: AppBindings, organizationId: string | null): OutgoingMailProvider | null {
  if (env.RESEND_API_KEY) return new ResendMailProvider(env.RESEND_API_KEY);
  if (env.DEV_MAIL_MODE === "capture") return new DevelopmentMailProvider(env.DB, organizationId);
  return null;
}

export function systemMailFrom(env: AppBindings) {
  return env.SYSTEM_MAIL_FROM || `no-reply@${new URL(env.APP_URL).hostname}`;
}

export async function sendSystemMail(env: AppBindings, mail: { to: string; subject: string; text: string }) {
  const provider = selectOutgoingProvider(env, null);
  if (!provider) throw new Error("No outgoing mail provider is configured.");
  await provider.send({ from: systemMailFrom(env), to: mail.to, subject: mail.subject, text: mail.text });
}
```

In `queue.ts` `processOutboundMail`, replace provider selection with `selectOutgoingProvider(env, job.organizationId)`.

- [ ] **Step 5: dev-mail route** in `operations/routes.ts`:

```ts
operationRoutes.get("/dev-mail", requireRole("admin"), async (context) => {
  if (context.env.DEV_MAIL_MODE !== "capture" || context.env.RESEND_API_KEY) throw new HttpError(404, "not_found", "Mail capture is not enabled.");
  const tenant = context.get("tenant");
  const me = await context.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(tenant.userId).first<{ email: string }>();
  const rows = await context.env.DB.prepare("SELECT id, to_address AS toAddress, from_address AS fromAddress, subject, text, html, headers, created_at AS createdAt FROM mail_captures WHERE organization_id = ? OR (organization_id IS NULL AND to_address = ?) ORDER BY created_at DESC LIMIT 50").bind(tenant.organizationId, me?.email ?? "").all();
  return context.json({ captures: rows.results.map((row) => ({ ...row, headers: JSON.parse(String(row.headers)) })) });
});
```

- [ ] **Step 6: Run** `npm test`, typecheck, lint → pass. Add `SYSTEM_MAIL_FROM=` commented line to `.dev.vars.example`.

- [ ] **Step 7: Commit** — `git commit -am "feat: persist development mail captures and add system mail helper"`

---

### Task 3: Email threading

**Files:**
- Modify: `src/server/providers/mail.ts` (`IncomingMail.references: string[]`, parse from `email.references`)
- Modify: `src/server/mail/queue.ts` (outbound Message-ID/References; inbound matching + subject fallback)
- Test: `tests/mail.test.ts`

**Interfaces:**
- Consumes: `OutgoingMail.messageId/references` from Task 2.
- Produces: `messages.rfc_message_id` populated for every sent agent message (`<${messageId}@${domain}>`) and every inbound customer message (its `Message-ID`).

- [ ] **Step 1: Failing tests** — append to `tests/mail.test.ts`. `mimeMessage` gains optional `inReplyTo` and `from` fields; emit `In-Reply-To:` when given.

```ts
it("threads a customer reply onto the ticket the agent replied from", async () => {
  const workspace = await signup("mail-thread");
  const { request } = await import("./helpers");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "thread@example.test" }) }, workspace);
  await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<first@example.test>", to: "thread@example.test", subject: "Login broken", body: "Cannot sign in." }), from: "customer@example.test", to: "thread@example.test" });
  const ticket = await env.DB.prepare("SELECT id FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ id: string }>();
  const reply = await (await request(`/tickets/${ticket!.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Try resetting.", kind: "message" }) }, workspace)).json() as { message: { id: string } };
  const job = await env.DB.prepare("SELECT id FROM outbound_mail_jobs WHERE message_id = ?").bind(reply.message.id).first<{ id: string }>();
  await processOutboundMail(env as AppBindings, { jobId: job!.id });
  const sent = await env.DB.prepare("SELECT rfc_message_id AS rfc FROM messages WHERE id = ?").bind(reply.message.id).first<{ rfc: string }>();
  expect(sent?.rfc).toMatch(/^<.+@example\.test>$/);
  const capture = await env.DB.prepare("SELECT headers FROM mail_captures WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(workspace.organizationId).first<{ headers: string }>();
  expect(JSON.parse(capture!.headers)["In-Reply-To"]).toBe("<first@example.test>");
  await request(`/tickets/${ticket!.id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }, workspace);

  await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<second@example.test>", to: "thread@example.test", subject: "Re: [#1001] Login broken", body: "Still broken.", inReplyTo: sent!.rfc }), from: "customer@example.test", to: "thread@example.test" });
  const count = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ count: number }>();
  expect(count?.count).toBe(1);
  const state = await env.DB.prepare("SELECT status, message_count AS messages FROM tickets WHERE id = ?").bind(ticket!.id).first<{ status: string; messages: number }>();
  expect(state).toMatchObject({ status: "open", messages: 3 });
});

it("falls back to the subject ticket number only for the same customer", async () => {
  const workspace = await signup("mail-subject");
  const { request } = await import("./helpers");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "subject@example.test" }) }, workspace);
  await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<s1@example.test>", to: "subject@example.test", subject: "Invoice", body: "Where is it?" }), from: "customer@example.test", to: "subject@example.test" });
  const ticket = await env.DB.prepare("SELECT number FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ number: number }>();
  await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<s2@example.test>", to: "subject@example.test", subject: `Re: [#${ticket!.number}] Invoice`, body: "Following up." }), from: "customer@example.test", to: "subject@example.test" });
  await processInboundMail(env as AppBindings, { raw: mimeMessage({ id: "<s3@example.test>", to: "subject@example.test", subject: `Re: [#${ticket!.number}] Invoice`, body: "I am someone else.", from: "Other <other@example.test>" }), from: "other@example.test", to: "subject@example.test" });
  const count = await env.DB.prepare("SELECT count(*) AS count FROM tickets WHERE organization_id = ?").bind(workspace.organizationId).first<{ count: number }>();
  expect(count?.count).toBe(2);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Incoming parse** — `IncomingMail` gains `references: string[]`; in `PostalMimeIncomingProvider.parse`, `references: [email.inReplyTo, ...(email.references ?? "").split(/\s+/)].filter((v): v is string => Boolean(v)).map((v) => v.trim().slice(0, 998))`. Keep `inReplyTo`.

- [ ] **Step 4: Outbound** in `processOutboundMail`: the `OutboundRow` query additionally selects `t.id AS ticketId`, `m.rfc_message_id AS rfcMessageId`, and `i.email_address AS inboxAddress`. Before `provider.send`:

```ts
if (!row.supportEmail) throw new Error("No support inbox is configured. Add one in Settings → Support inboxes.");
const domain = row.supportEmail.split("@")[1] ?? "resolvehq.local";
const rfcMessageId = row.rfcMessageId ?? `<${job.messageId}@${domain}>`;
if (!row.rfcMessageId) await env.DB.prepare("UPDATE messages SET rfc_message_id = ? WHERE organization_id = ? AND id = ?").bind(rfcMessageId, job.organizationId, job.messageId).run();
const lastCustomer = await env.DB.prepare("SELECT coalesce(rfc_message_id, provider_message_id) AS ref FROM messages WHERE organization_id = ? AND ticket_id = ? AND author_type = 'customer' AND coalesce(rfc_message_id, provider_message_id) IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(job.organizationId, row.ticketId).first<{ ref: string }>();
```

Pass `messageId: rfcMessageId, references: lastCustomer?.ref ? [lastCustomer.ref] : undefined`. Remove the `.invalid` fallback; the failure path (catch) already marks the job failed — additionally set `messages.delivery_status = 'failed'` for the message in that catch.

- [ ] **Step 5: Inbound matching** — replace the `if (!ticket && mail.inReplyTo)` block:

```ts
if (!ticket && mail.references.length) {
  const placeholders = mail.references.map(() => "?").join(",");
  ticket = await env.DB.prepare(
    `SELECT t.id, t.number, t.subject, t.customer_id AS customerId FROM messages m JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = m.organization_id JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE m.organization_id = ? AND t.inbox_id = ? AND c.email = ? AND (m.rfc_message_id IN (${placeholders}) OR m.provider_message_id IN (${placeholders})) ORDER BY m.created_at DESC LIMIT 1`,
  ).bind(organizationId, inbox.id, mail.from.email, ...mail.references, ...mail.references).first<TicketReference>() ?? undefined;
}
if (!ticket) {
  const numberMatch = /\[#(\d{1,12})\]/.exec(mail.subject);
  if (numberMatch) ticket = await env.DB.prepare("SELECT t.id, t.number, t.subject, t.customer_id AS customerId FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE t.organization_id = ? AND t.inbox_id = ? AND t.number = ? AND c.email = ? LIMIT 1").bind(organizationId, inbox.id, Number(numberMatch[1]), mail.from.email).first<TicketReference>() ?? undefined;
}
```

When inserting the inbound message, also set `rfcMessageId: mail.providerMessageId`. In the "new message on existing ticket" UPDATE, add `waiting_since = NULL`.

- [ ] **Step 6: Run** `npm test` → pass (including the pre-existing forged-subject test: different sender → new ticket). Typecheck, lint.

- [ ] **Step 7: Commit** — `git commit -am "feat: thread customer replies by RFC message ids and subject fallback"`

---

### Task 4: Ticket update service, agent-created tickets, reply status, ticket detail enrichment

**Files:**
- Create: `src/server/tickets/service.ts`
- Modify: `src/server/tickets/routes.ts` (POST `/`, GET `/:id`, PATCH `/:id`, POST `/:id/messages`, tag attach)
- Modify: `src/server/operations/routes.ts` (bulk uses service)
- Test: `tests/tickets.test.ts`, `tests/operations.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TicketChanges { status?: TicketStatus; priority?: TicketPriority; assignedUserId?: string | null; assignedTeamId?: string | null }
export async function applyTicketUpdate(env: AppBindings, tenant: TenantContext, ticketId: string, changes: TicketChanges, options?: { expectedVersion?: number }): Promise<Ticket /* updated row */>
export async function assertActiveMember(database: D1Database, organizationId: string, userId: string): Promise<void>
export async function assertTeam(database: D1Database, organizationId: string, teamId: string): Promise<void>
export function statusTimestamps(current: { resolvedAt: Date | null; closedAt: Date | null; waitingSince: Date | null }, next: TicketStatus | undefined, now: Date): { resolvedAt: Date | null; closedAt: Date | null; waitingSince: Date | null }
```

- `GET /tickets/:id` messages now include `authorName: string | null`, `deliveryStatus`, `deliveryError: string | null`, `bodyHtml`.
- Bulk response: `{ updated: number; skipped: Array<{ ticketId: string; reason: string }> }`.

- [ ] **Step 1: Failing tests** — append to `tests/tickets.test.ts`:

```ts
it("agent-created tickets are agent-authored, queued for delivery, and wait on the customer", async () => {
  const workspace = await signup("agent-ticket");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "agent-ticket@example.test" }) }, workspace);
  const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Pat", email: "pat@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
  const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Welcome", message: "Hi Pat" }) }, workspace)).json() as { ticket: { id: string; status: string } }).ticket;
  expect(ticket.status).toBe("waiting_customer");
  const detail = await (await request(`/tickets/${ticket.id}`, {}, workspace)).json() as { messages: Array<{ authorType: string; authorName: string | null; deliveryStatus: string }> };
  expect(detail.messages[0]).toMatchObject({ authorType: "agent", authorName: "Owner agent-ticket", deliveryStatus: "queued" });
  const job = await env.DB.prepare("SELECT count(*) AS count FROM outbound_mail_jobs WHERE organization_id = ?").bind(workspace.organizationId).first<{ count: number }>();
  expect(job?.count).toBe(1);
});

it("keeps resolved_at when closing and moves open tickets to waiting_customer on reply", async () => {
  const workspace = await signup("status-flow");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "status-flow@example.test" }) }, workspace);
  const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Sam", email: "sam@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
  const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Flow", message: "Start" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
  await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }, workspace);
  await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "Handled", kind: "message" }) }, workspace);
  let row = await env.DB.prepare("SELECT status, waiting_since AS waitingSince FROM tickets WHERE id = ?").bind(ticket.id).first<{ status: string; waitingSince: number | null }>();
  expect(row?.status).toBe("waiting_customer"); expect(row?.waitingSince).not.toBeNull();
  await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }, workspace);
  await request(`/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status: "closed" }) }, workspace);
  row = await env.DB.prepare("SELECT resolved_at AS resolvedAt, closed_at AS closedAt, waiting_since AS waitingSince FROM tickets WHERE id = ?").bind(ticket.id).first();
  expect(row?.resolvedAt).not.toBeNull(); expect(row?.closedAt).not.toBeNull(); expect(row?.waitingSince).toBeNull();
});
```

Import `env` from `cloudflare:test` at the top of `tests/tickets.test.ts`.

Append to `tests/operations.test.ts`:

```ts
it("bulk updates refuse cross-tenant assignees and report skipped tickets", async () => {
  const alpha = await signup("bulk-alpha");
  const beta = await signup("bulk-beta");
  const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "B", email: "b@example.test" }) }, alpha)).json() as { customer: { id: string } }).customer;
  const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Bulk", message: "x" }) }, alpha)).json() as { ticket: { id: string } }).ticket;
  const crossTenant = await request("/operations/tickets/bulk", { method: "POST", body: JSON.stringify({ ticketIds: [ticket.id], assignedUserId: beta.userId }) }, alpha);
  expect(crossTenant.status).toBe(404);
  const result = await (await request("/operations/tickets/bulk", { method: "POST", body: JSON.stringify({ ticketIds: [ticket.id, "tkt_missing"], status: "resolved" }) }, alpha)).json() as { updated: number; skipped: Array<{ ticketId: string }> };
  expect(result.updated).toBe(1);
  expect(result.skipped).toEqual([{ ticketId: "tkt_missing", reason: "ticket_not_found" }]);
  const row = await env.DB.prepare("SELECT resolved_at AS resolvedAt, version FROM tickets WHERE id = ?").bind(ticket.id).first<{ resolvedAt: number | null; version: number }>();
  expect(row?.resolvedAt).not.toBeNull(); expect(row?.version).toBe(2);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: service.ts** — move `assertActiveMember`, `assertTeam`, `preview`, `refreshTicketSearch` (temporarily; Task 6 relocates search) out of `routes.ts` into `service.ts` and export them. Add:

```ts
export function statusTimestamps(current, next, now) {
  if (!next) return { resolvedAt: current.resolvedAt, closedAt: current.closedAt, waitingSince: current.waitingSince };
  if (next === "resolved") return { resolvedAt: now, closedAt: null, waitingSince: null };
  if (next === "closed") return { resolvedAt: current.resolvedAt, closedAt: now, waitingSince: null };
  if (next === "waiting_customer") return { resolvedAt: null, closedAt: null, waitingSince: current.waitingSince ?? now };
  return { resolvedAt: null, closedAt: null, waitingSince: null };
}

export async function applyTicketUpdate(env, tenant, ticketId, changes, options = {}) {
  if (changes.assignedUserId) await assertActiveMember(env.DB, tenant.organizationId, changes.assignedUserId);
  if (changes.assignedTeamId) await assertTeam(env.DB, tenant.organizationId, changes.assignedTeamId);
  const db = createDb(env.DB);
  const [current] = await db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.organizationId, tenant.organizationId))).limit(1);
  if (!current) throw new HttpError(404, "ticket_not_found", "Ticket not found.");
  if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) throw new HttpError(409, "ticket_version_conflict", "This ticket changed in another session. Refresh and try again.");
  const now = new Date();
  const stamps = statusTimestamps(current, changes.status, now);
  const result = await db.update(tickets).set({ ...changes, ...stamps, updatedAt: now, version: current.version + 1 })
    .where(and(eq(tickets.id, current.id), eq(tickets.organizationId, tenant.organizationId), eq(tickets.version, current.version)));
  if (!result.meta.changes) throw new HttpError(409, "ticket_version_conflict", "This ticket changed in another session. Refresh and try again.");
  // assignment history + notification + activity: copy the three blocks from the old PATCH handler verbatim
  return { ...current, ...changes, ...stamps, updatedAt: now, version: current.version + 1 };
}
```

Use `TenantContext` and `AppBindings` types from `resolve-server/types`. Export the full-signature version with types as in the Interfaces block.

- [ ] **Step 4: Routes** —
  - PATCH `/:id`: body becomes `const { version, ...changes } = input; const ticket = await applyTicketUpdate(context.env, tenant, id, changes, { expectedVersion: version }); return context.json({ ticket });`.
  - POST `/`: initial message `authorType: "agent", authorUserId: tenant.userId, deliveryStatus: "queued"`; ticket `status: "waiting_customer", waitingSince: now, lastAgentReplyAt: now` (drop `lastCustomerReplyAt`); add an `outboundMailJobs` insert to the batch (`idempotencyKey: \`message/${messageId}\``) and `await context.env.OUTBOUND_MAIL_QUEUE.send({ kind: "outbound-mail", jobId })` after; response `status: "waiting_customer"`. If no inbox exists throw `HttpError(409, "no_inbox", "Add a support inbox in Settings before starting conversations.")`.
  - POST `/:id/messages`: after the batch, when `kind === "message"` and the current status is `open` or `pending`, run `UPDATE tickets SET status = 'waiting_customer', waiting_since = ? WHERE organization_id = ? AND id = ?` (select `status` in the initial ticket lookup). Record `ticket.status_changed` activity.
  - GET `/:id`: message query becomes a left join on `users` (`authorName: users.name`) and on `outboundMailJobs` (`deliveryError: outboundMailJobs.lastError`); select explicit columns: `id, ticketId, authorType, authorUserId, kind, bodyText, bodyHtml, deliveryStatus, deliveryError, authorName, createdAt`.
  - Tag attach: replace the `Promise.all` with two sequential lookups (ticket, then tag).
  - Bulk in `operations/routes.ts`: loop calling `applyTicketUpdate(context.env, tenant, ticketId, changes)`; catch `HttpError` with status 404 for `ticket_not_found` → push to `skipped`; any other `HttpError` (e.g. `member_not_found`) rethrows so cross-tenant assignees fail the whole request with 404. Record `ticket.bulk_updated` activity per updated ticket.

- [ ] **Step 5: Run** `npm test` → pass. Existing `tickets.test.ts` first test asserts `detailBody.messages` length 3 — still true. Typecheck, lint.

- [ ] **Step 6: Commit** — `git commit -am "feat: share ticket update service, agent-authored tickets, status timestamps"`

---

### Task 5: Search consistency, message idempotency, inbound upsert, cron recovery

**Files:**
- Create: `src/server/search/index.ts` (`refreshTicketSearch`, `toFtsQuery`)
- Modify: `src/server/search/routes.ts`, `src/server/tickets/routes.ts`, `src/server/tickets/service.ts`, `src/server/customers/routes.ts`, `src/server/mail/queue.ts` (delete local copies; import shared)
- Modify: `worker.ts` `scheduled`
- Test: `tests/search.test.ts`, `tests/tickets.test.ts`, `tests/mail.test.ts`

**Interfaces:**
- Produces: `refreshTicketSearch(database: D1Database, organizationId: string, ticketId: string): Promise<void>` and `toFtsQuery(value: string): string | null` (null when nothing searchable remains).

- [ ] **Step 1: Failing tests** — `tests/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { request, signup } from "./helpers";

describe("search", () => {
  it("returns nothing for punctuation-only queries and finds renamed customers", async () => {
    const workspace = await signup("search");
    await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "search@example.test" }) }, workspace);
    const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "Original Name", email: "orig@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
    const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Search subject", message: "body" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
    expect(((await (await request("/tickets?q=%3F%3F%3F", {}, workspace)).json()) as { tickets: unknown[] }).tickets).toHaveLength(0);
    expect(((await (await request("/search?q=%3F%3F%3F", {}, workspace)).json()) as { results: unknown[] }).results).toHaveLength(0);
    await request(`/customers/${customer.id}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed Person" }) }, workspace);
    await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "note", kind: "internal_note" }) }, workspace);
    expect(((await (await request("/tickets?q=renamed", {}, workspace)).json()) as { tickets: unknown[] }).tickets).toHaveLength(1);
  });
});
```

Check `src/server/search/routes.ts` for the actual response key (`results` vs other) and adjust the assertion to match.

Append to `tests/tickets.test.ts`:

```ts
it("treats concurrent submits with the same clientMessageId as one message", async () => {
  const workspace = await signup("idempotent");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "idem@example.test" }) }, workspace);
  const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "I", email: "i@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
  const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Idem", message: "x" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
  const body = JSON.stringify({ body: "same", kind: "message", clientMessageId: "client-message-0001" });
  const responses = await Promise.all([1, 2, 3].map(() => request(`/tickets/${ticket.id}/messages`, { method: "POST", body }, workspace)));
  expect(responses.every((response) => response.status === 201 || response.status === 200)).toBe(true);
  const count = await env.DB.prepare("SELECT count(*) AS count FROM messages WHERE organization_id = ? AND client_message_id = ?").bind(workspace.organizationId, "client-message-0001").first<{ count: number }>();
  expect(count?.count).toBe(1);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: search/index.ts**

```ts
export function toFtsQuery(value: string): string | null {
  const terms = value.toLowerCase().split(/\s+/).map((term) => term.replace(/[^a-z0-9@._-]/g, "")).filter(Boolean).slice(0, 8);
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ") : null;
}

export async function refreshTicketSearch(database: D1Database, organizationId: string, ticketId: string) {
  const row = await database.prepare(
    "SELECT t.normalized_search || ' ' || c.normalized_search || ' ' || coalesce((SELECT group_concat(m.normalized_search, ' ') FROM messages m WHERE m.organization_id = t.organization_id AND m.ticket_id = t.id), '') || ' ' || coalesce((SELECT group_concat(g.name, ' ') FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id AND g.organization_id = tt.organization_id WHERE tt.organization_id = t.organization_id AND tt.ticket_id = t.id), '') AS content FROM tickets t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id WHERE t.organization_id = ? AND t.id = ?",
  ).bind(organizationId, ticketId).first<{ content: string }>();
  await database.batch([
    database.prepare("DELETE FROM ticket_search WHERE organization_id = ? AND ticket_id = ?").bind(organizationId, ticketId),
    database.prepare("INSERT INTO ticket_search (organization_id, ticket_id, content) VALUES (?, ?, ?)").bind(organizationId, ticketId, row?.content ?? ""),
  ]);
}
```

In `GET /tickets`: `const ftsQuery = search ? toFtsQuery(search) : undefined; if (search && ftsQuery === null) return context.json({ tickets: [], items: [], nextCursor: null, hasMore: false });`. In `search/routes.ts` use the same helper and return an empty list when null. Delete all local `refreshTicketSearch`/`toFtsQuery` copies and import the shared ones.

- [ ] **Step 4: Idempotent insert** — in POST `/:id/messages`, when `clientMessageId` is present: run the batch with `db.insert(messages).values(...).onConflictDoNothing({ target: [messages.organizationId, messages.clientMessageId] })`, but the ticket update + job insert must only happen when the insert took effect. Do it as: `const inserted = await db.insert(messages).values(...).onConflictDoNothing(...); if (!inserted.meta.changes) { const existing = await …select by clientMessageId…; return context.json({ message: existing, duplicate: true }, 200); }` then run the remaining batch (ticket update, job insert) separately. Use `INSERT OR IGNORE` semantics for the job row too (`onConflictDoNothing()` on `idempotencyKey`).

- [ ] **Step 5: Inbound upsert** — in `processInboundMail`, use `target: inboundMailEvents.stagingObjectKey` when `staged`, else `inboundMailEvents.id`.

- [ ] **Step 6: Cron** — in `worker.ts` `scheduled`:

```ts
const stale = now - 10 * 60 * 1000;
await env.DB.prepare("UPDATE outbound_mail_jobs SET status = 'failed', next_attempt_at = ?, last_error = coalesce(last_error, 'Recovered from stalled processing') WHERE status = 'processing' AND updated_at < ?").bind(now, stale).run();
await env.DB.prepare("UPDATE inbound_mail_events SET status = 'failed', last_error = coalesce(last_error, 'Recovered from stalled processing') WHERE status = 'processing' AND updated_at < ?").bind(stale).run();
const stalledInbound = await env.DB.prepare("SELECT id, staging_object_key AS key FROM inbound_mail_events WHERE status = 'failed' AND attempts < 5 AND staging_object_key LIKE '_mail-staging/%' LIMIT 20").all<{ id: string; key: string }>();
for (const event of stalledInbound.results) await env.INBOUND_MAIL_QUEUE.send({ kind: "inbound-mail", eventId: event.id, stagingObjectKey: event.key, from: "", to: "" });
const expired = await env.DB.prepare("SELECT staging_object_key AS key FROM inbound_mail_events WHERE status IN ('completed','failed') AND updated_at < ? AND staging_object_key LIKE '_mail-staging/%' LIMIT 50").bind(now - 7 * 24 * 60 * 60 * 1000).all<{ key: string }>();
for (const row of expired.results) await env.ATTACHMENTS.delete(row.key);
```

`processInboundMail` must tolerate empty `from`/`to` in the payload (it already prefers parsed headers).

- [ ] **Step 7: Run** tests, typecheck, lint → pass. **Commit** — `git commit -am "fix: unify ticket search, idempotent message inserts, cron recovery"`

---

### Task 6: Password reset and change, invitation email

**Files:**
- Modify: `src/server/auth/routes.ts`
- Modify: `src/server/organizations/routes.ts` (invitation sends system mail; ignore provider errors but log)
- Test: `tests/auth.test.ts`

**Interfaces:**
- `POST /auth/forgot-password { email }` → 200 `{ ok: true }` always.
- `POST /auth/reset-password { token, password }` → 200 `{ ok: true }`; 404 `reset_invalid` when bad/expired/used.
- `POST /auth/change-password { currentPassword, newPassword }` (auth) → 200; 401 `invalid_credentials` when current is wrong.

- [ ] **Step 1: Failing test** — append to `tests/auth.test.ts`:

```ts
it("resets a password through a captured email link and invalidates old sessions", async () => {
  const workspace = await signup("reset");
  const email = "owner-reset@example.test";
  expect((await request("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) })).status).toBe(200);
  const capture = await env.DB.prepare("SELECT text FROM mail_captures WHERE to_address = ? ORDER BY created_at DESC LIMIT 1").bind(email).first<{ text: string }>();
  const token = /token=([A-Za-z0-9_-]+)/.exec(capture!.text)![1];
  expect((await request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password: "a-brand-new-password-1" }) })).status).toBe(200);
  expect((await request("/auth/me", {}, workspace)).status).toBe(401);
  expect((await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "a-secure-test-password" }) })).status).toBe(401);
  expect((await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "a-brand-new-password-1" }) })).status).toBe(200);
  expect((await request("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password: "another-new-password-2" }) })).status).toBe(404);
});

it("changes a password with the current one", async () => {
  const workspace = await signup("change");
  expect((await request("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: "wrong-password-value", newPassword: "a-brand-new-password-3" }) }, workspace)).status).toBe(401);
  expect((await request("/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: "a-secure-test-password", newPassword: "a-brand-new-password-3" }) }, workspace)).status).toBe(200);
  expect((await request("/auth/login", { method: "POST", body: JSON.stringify({ email: "owner-change@example.test", password: "a-brand-new-password-3" }) })).status).toBe(200);
});
```

Add `import { env } from "cloudflare:test";` if missing.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Routes** in `auth/routes.ts`:

```ts
authRoutes.post("/forgot-password", validate("json", z.object({ email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()) })), async (context) => {
  const ip = context.req.header("cf-connecting-ip") ?? "local";
  const { email } = context.req.valid("json");
  const [byIp, byEmail] = await Promise.all([context.env.AUTH_RATE_LIMIT.limit({ key: `forgot:ip:${ip}` }), context.env.AUTH_RATE_LIMIT.limit({ key: `forgot:email:${email}` })]);
  if (!byIp.success || !byEmail.success) throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.");
  const db = createDb(context.env.DB);
  const [user] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.email, email), isNull(users.disabledAt))).limit(1);
  if (user) {
    const token = randomToken();
    await db.insert(passwordResetTokens).values({ id: newId("prt"), userId: user.id, tokenHash: await sha256(`${token}.${context.env.SESSION_PEPPER}`), expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
    try { await sendSystemMail(context.env, { to: email, subject: "Reset your ResolveHQ password", text: `Hi ${user.name},\n\nReset your password within 30 minutes:\n${context.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}\n\nIf you did not request this, ignore this email.` }); }
    catch (error) { console.error("Password reset mail failed", error); }
  }
  return context.json({ ok: true });
});

authRoutes.post("/reset-password", validate("json", z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(128) })), async (context) => {
  const ip = context.req.header("cf-connecting-ip") ?? "local";
  if (!(await context.env.AUTH_RATE_LIMIT.limit({ key: `reset:${ip}` })).success) throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const tokenHash = await sha256(`${input.token}.${context.env.SESSION_PEPPER}`);
  const [row] = await db.select().from(passwordResetTokens).where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt))).limit(1);
  if (!row || row.expiresAt <= new Date()) throw new HttpError(404, "reset_invalid", "This reset link is invalid or has expired.");
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(input.password, context.env.SESSION_PEPPER), updatedAt: new Date() }).where(eq(users.id, row.userId)),
    db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id)),
    db.delete(sessions).where(eq(sessions.userId, row.userId)),
  ]);
  return context.json({ ok: true });
});

authRoutes.post("/change-password", requireAuth, validate("json", z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) })), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, tenant.userId)).limit(1);
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash, context.env.SESSION_PEPPER))) throw new HttpError(401, "invalid_credentials", "Your current password is incorrect.");
  const token = getCookie(context, SESSION_COOKIE) ?? "";
  const currentHash = await sha256(`${token}.${context.env.SESSION_PEPPER}`);
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(input.newPassword, context.env.SESSION_PEPPER), updatedAt: new Date() }).where(eq(users.id, tenant.userId)),
    db.delete(sessions).where(and(eq(sessions.userId, tenant.userId), ne(sessions.tokenHash, currentHash))),
  ]);
  return context.json({ ok: true });
});
```

Import `ne` from drizzle-orm, `randomToken` from `resolve-server/lib/crypto`, `passwordResetTokens` from schema, `sendSystemMail` from `resolve-server/mail/system`.

- [ ] **Step 4: Invitation mail** — in `POST /organization/invitations`, after insert: `try { await sendSystemMail(context.env, { to: input.email, subject: \`You're invited to ${workspaceName} on ResolveHQ\`, text: \`Join the ${workspaceName} support workspace:\n${inviteUrl}\n\nThis link expires in 7 days.\` }); } catch (error) { console.error("Invitation mail failed", error); }`. Load the workspace name with a select on `organizations`.

- [ ] **Step 5: Run** tests, typecheck, lint → pass. **Commit** — `git commit -am "feat: password reset, password change, emailed invitations"`

---

### Task 7: Invitations for existing users, deterministic login workspace

**Files:**
- Modify: `src/server/auth/routes.ts` (`/accept-invitation`, `/login`)
- Test: `tests/auth.test.ts`

**Interfaces:**
- `POST /auth/accept-invitation`: body `{ token, name?, password? }`. With a valid session whose email matches → joins and switches; returns the same shape as `/auth/me`. 409 `wrong_account` when signed in as someone else. Unauthenticated with existing email → 409 `account_exists` (unchanged).

- [ ] **Step 1: Failing test** — append to `tests/auth.test.ts`:

```ts
it("lets an existing user accept an invitation and switch workspaces", async () => {
  const host = await signup("invite-host");
  const guest = await signup("invite-guest");
  const invitation = await (await request("/organization/invitations", { method: "POST", body: JSON.stringify({ email: "owner-invite-guest@example.test", role: "agent" }) }, host)).json() as { invitation: { inviteUrl: string } };
  const token = new URL(invitation.invitation.inviteUrl).searchParams.get("token")!;
  expect((await request("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token }) }, host)).status).toBe(409);
  const accepted = await request("/auth/accept-invitation", { method: "POST", body: JSON.stringify({ token }) }, guest);
  expect(accepted.status).toBe(200);
  const me = await (await request("/auth/me", {}, guest)).json() as { organization: { id: string }; role: string; workspaces: unknown[] };
  expect(me.organization.id).toBe(host.organizationId);
  expect(me.role).toBe("agent");
  expect(me.workspaces).toHaveLength(2);
  expect((await request("/auth/switch-workspace", { method: "POST", body: JSON.stringify({ organizationId: guest.organizationId }) }, guest)).status).toBe(200);
  expect(((await (await request("/auth/me", {}, guest)).json()) as { organization: { id: string } }).organization.id).toBe(guest.organizationId);
});
```

- [ ] **Step 2: Run** → FAIL (accept returns 409 `account_exists` for the guest; `name`/`password` required).

- [ ] **Step 3: Implement** — schema `z.object({ token, name: z.string().trim().min(2).max(100).optional(), password: z.string().min(12).max(128).optional() })`. After loading the invitation:

```ts
const tenant = await resolveTenant(context);
if (tenant) {
  const [me] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, tenant.userId)).limit(1);
  if (!me || me.email !== invitation.email) throw new HttpError(409, "wrong_account", "This invitation was sent to a different email address. Sign out and try again.");
  const now = new Date();
  await db.batch([
    db.insert(organizationMemberships).values({ organizationId: invitation.organizationId, userId: tenant.userId, role: invitation.role, createdAt: now }).onConflictDoUpdate({ target: [organizationMemberships.organizationId, organizationMemberships.userId], set: { role: invitation.role, disabledAt: null } }),
    db.update(organizationInvitations).set({ acceptedAt: now }).where(eq(organizationInvitations.id, invitation.id)),
  ]);
  const token = getCookie(context, SESSION_COOKIE)!;
  await db.update(sessions).set({ organizationId: invitation.organizationId, lastSeenAt: now }).where(eq(sessions.tokenHash, await sha256(`${token}.${context.env.SESSION_PEPPER}`)));
  return context.json({ ok: true, organizationId: invitation.organizationId, role: invitation.role });
}
if (!input.name || !input.password) throw new HttpError(400, "validation_error", "name: Required to create your account.");
```

Then the existing unauthenticated branch. Import `resolveTenant` from `./session`. Note `resolveTenant` is non-throwing (returns null without a valid cookie).

Login: add `.orderBy(asc(organizationMemberships.createdAt))` before `.limit(1)`; import `asc`.

- [ ] **Step 4: Run** tests, typecheck, lint → pass. **Commit** — `git commit -am "feat: accept invitations while signed in, deterministic login workspace"`

---

### Task 8: Webhook tenant scope, rate limits, HTML sanitizer, rich replies

**Files:**
- Modify: `src/server/webhooks/routes.ts`
- Modify: `src/server/attachments/routes.ts`, `src/server/tickets/routes.ts`, `src/server/auth/routes.ts` (rate limits)
- Create: `src/server/lib/sanitize-html.ts`
- Modify: `src/server/tickets/routes.ts` (`messageInput.bodyHtml`), `src/server/mail/queue.ts` (already sends `row.html`)
- Test: `tests/webhooks.test.ts`, `tests/sanitize.test.ts`

**Interfaces:**
- `sanitizeHtml(input: string): string` — keeps `p, br, strong, b, em, i, u, ul, ol, li, a`; `a` keeps only `href` with `http:`, `https:`, `mailto:` schemes and gets `rel="noopener noreferrer" target="_blank"`; text is entity-escaped; output limited to 200 000 chars.
- `messageInput` gains `bodyHtml: z.string().max(200_000).optional()`.

- [ ] **Step 1: Failing tests**

```ts
// tests/sanitize.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "resolve-server/lib/sanitize-html";

describe("sanitizeHtml", () => {
  it("keeps formatting and strips scripts, handlers, and unsafe links", () => {
    const out = sanitizeHtml('<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.test/path?a=1">ok</a><img src=x onerror=alert(1)></p><ul><li>one</li></ul>');
    expect(out).toBe('<p>Hi <strong>there</strong>alert(1)<a>bad</a><a href="https://ok.test/path?a=1" rel="noopener noreferrer" target="_blank">ok</a></p><ul><li>one</li></ul>');
  });
  it("escapes text content", () => {
    expect(sanitizeHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
});
```

```ts
// tests/webhooks.test.ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "resolve-server/app";

async function sign(secret: string, id: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...sig))}`;
}

describe("resend webhooks", () => {
  it("rejects bad signatures and only updates the owning tenant's message", async () => {
    const secret = `whsec_${btoa("test-webhook-secret-value")}`;
    const testEnv = { ...env, RESEND_WEBHOOK_SECRET: secret };
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_shared_id" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bad = await app.request("http://localhost/api/webhooks/resend", { method: "POST", body, headers: { "svix-id": "evt_bad", "svix-timestamp": timestamp, "svix-signature": "v1,AAAA" } }, testEnv);
    expect(bad.status).toBe(401);
    const good = await app.request("http://localhost/api/webhooks/resend", { method: "POST", body, headers: { "svix-id": "evt_good", "svix-timestamp": timestamp, "svix-signature": await sign(secret, "evt_good", timestamp, body) } }, testEnv);
    expect(good.status).toBe(200);
    const replay = await app.request("http://localhost/api/webhooks/resend", { method: "POST", body, headers: { "svix-id": "evt_good", "svix-timestamp": timestamp, "svix-signature": await sign(secret, "evt_good", timestamp, body) } }, testEnv);
    expect((await replay.json() as { duplicate?: boolean }).duplicate).toBe(true);
  });
});
```

Tenant-scoping is enforced structurally (join through `outbound_mail_jobs`); the test above covers signature and replay. If time permits, seed two orgs with messages sharing `provider_message_id` via raw SQL and assert only the one whose job has that id flips.

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: sanitizer** — implement with a single-pass tokenizer over `<[^>]*>` matches. Skeleton:

```ts
const allowed = new Set(["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "a"]);
const voidTags = new Set(["br"]);
export function sanitizeHtml(input: string): string {
  const source = input.slice(0, 200_000);
  let out = ""; let last = 0; const open: string[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let match: RegExpExecArray | null; let skipDepth = 0; let skipTag = "";
  while ((match = tagPattern.exec(source))) {
    const text = source.slice(last, match.index); last = tagPattern.lastIndex;
    if (!skipDepth) out += escapeText(text);
    const name = match[1].toLowerCase(); const closing = match[0].startsWith("</");
    if (name === "script" || name === "style") { if (closing && skipTag === name) { skipDepth = 0; skipTag = ""; } else if (!closing) { skipDepth = 1; skipTag = name; } continue; }
    if (skipDepth) continue;
    if (!allowed.has(name)) continue;
    if (closing) { if (open.lastIndexOf(name) >= 0) { while (open.length) { const top = open.pop()!; out += `</${top}>`; if (top === name) break; } } continue; }
    if (name === "a") { const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[2]); const value = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim(); const safe = /^(https?:|mailto:)/i.test(value) ? value : ""; out += safe ? `<a href="${escapeAttribute(safe)}" rel="noopener noreferrer" target="_blank">` : "<a>"; open.push("a"); continue; }
    if (voidTags.has(name)) { out += `<${name}>`; continue; }
    out += `<${name}>`; open.push(name);
  }
  if (!skipDepth) out += escapeText(source.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
function escapeText(v: string) { return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function escapeAttribute(v: string) { return escapeText(v).replaceAll('"', "&quot;"); }
```

Adjust until both sanitizer tests pass exactly (the expected string in test 1 is the contract: `<script>` content dropped, `<img>` dropped, `javascript:` link becomes bare `<a>`).

- [ ] **Step 4: Wire bodyHtml** — in POST `/:id/messages`: `bodyHtml: input.bodyHtml ? sanitizeHtml(input.bodyHtml) : null` on insert (only for `kind === "message"`; notes store text only). `processOutboundMail` already passes `row.html`.

- [ ] **Step 5: Webhook scope** — replace the two `UPDATE messages …` statements with:

```sql
UPDATE messages SET delivery_status = ? WHERE id IN (SELECT message_id FROM outbound_mail_jobs WHERE provider_message_id = ?) AND organization_id IN (SELECT organization_id FROM outbound_mail_jobs WHERE provider_message_id = ?)
```

bind status, id, id. Keep the jobs update.

- [ ] **Step 6: Rate limits** — `POST /attachments/intents`: key `upload:${tenant.userId}`; `POST /tickets/:id/messages`: key `messages:${tenant.userId}`; `PUT /operations/tickets/:ticketId/draft`: key `drafts:${tenant.userId}` — all via `context.env.AUTH_RATE_LIMIT.limit`, throwing `HttpError(429, "rate_limited", "Slow down and try again in a moment.")`. Note the binding is 10/min in `wrangler.jsonc`; raise the production limit to `{ limit: 60, period: 60 }` there (vitest config already uses 1000).

- [ ] **Step 7: Run** tests, typecheck, lint → pass. **Commit** — `git commit -am "feat: sanitize rich replies, scope webhooks by tenant, rate limit writes"`

---

### Task 9: Attachments uploaded before send

**Files:**
- Modify: `src/server/attachments/routes.ts` (intents take `ticketId` only; remove the legacy multipart `POST /`)
- Modify: `src/server/tickets/routes.ts` (`messageInput.attachmentIds`)
- Modify: `worker.ts` (orphan cleanup)
- Test: `tests/attachments.test.ts`

**Interfaces:**
- `POST /attachments/intents { ticketId, filename, contentType, size }` → `{ upload: { attachmentId, url, method: "PUT", expiresIn } }`.
- `PUT /attachments/intents/:token` → 201 `{ attachment }` with `messageId: null`.
- `POST /tickets/:id/messages` accepts `attachmentIds: string[]` (max 10); each must be tenant + ticket + uploader owned and unlinked; else 404 `attachment_not_found`.

- [ ] **Step 1: Failing test** — rewrite `tests/attachments.test.ts` (read the existing test first; keep its cross-tenant download assertion):

```ts
it("uploads before sending and links attachments to the new message", async () => {
  const workspace = await signup("attach-first");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "attach-first@example.test" }) }, workspace);
  const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "A", email: "a@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
  const ticket = (await (await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "Attach", message: "x" }) }, workspace)).json() as { ticket: { id: string } }).ticket;
  const file = new TextEncoder().encode("plain text log");
  const intent = await (await request("/attachments/intents", { method: "POST", body: JSON.stringify({ ticketId: ticket.id, filename: "log.txt", contentType: "text/plain", size: file.byteLength }) }, workspace)).json() as { upload: { attachmentId: string; url: string } };
  const upload = await request(intent.upload.url.replace(/^\/api/, ""), { method: "PUT", body: file, headers: { "content-type": "text/plain", "content-length": String(file.byteLength) } }, workspace);
  expect(upload.status).toBe(201);
  const message = await (await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "see log", kind: "message", attachmentIds: [intent.upload.attachmentId] }) }, workspace)).json() as { message: { id: string } };
  const row = await env.DB.prepare("SELECT message_id AS messageId FROM attachments WHERE id = ?").bind(intent.upload.attachmentId).first<{ messageId: string }>();
  expect(row?.messageId).toBe(message.message.id);
  const other = await signup("attach-other");
  expect((await request(`/attachments/${intent.upload.attachmentId}`, {}, other)).status).toBe(404);
  expect((await request(`/tickets/${ticket.id}/messages`, { method: "POST", body: JSON.stringify({ body: "again", kind: "message", attachmentIds: [intent.upload.attachmentId] }) }, workspace)).status).toBe(404);
});
```

`request()` sets `content-type: application/json` when a body is present — extend the helper: only set it when the caller has not provided one.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — intents: drop `messageId` from input/payload; `assertTicket(db, organizationId, ticketId)` instead of `assertMessage`; PUT inserts with `messageId: null`. Delete the multipart `POST /` route (frontend never uses it). In `POST /tickets/:id/messages`: after the message insert succeeds, `UPDATE attachments SET message_id = ? WHERE organization_id = ? AND ticket_id = ? AND uploaded_by_user_id = ? AND message_id IS NULL AND id IN (...)`; if `meta.changes !== attachmentIds.length` throw `HttpError(404, "attachment_not_found", "An attachment is missing or already used.")` — do this check by first counting eligible rows before inserting the message so no message is created on failure. Cron: `SELECT id, object_key FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT 50` (24 h), delete R2 objects then rows.

- [ ] **Step 4: Run** tests, typecheck, lint → pass. **Commit** — `git commit -am "feat: upload attachments before sending and link them to the message"`

---

### Task 10: Queue counts, saved view dedupe and delete

**Files:**
- Modify: `src/server/tickets/routes.ts` (`GET /counts` — register BEFORE `GET /:id`)
- Modify: `src/server/operations/routes.ts` (`POST /views` dedupe, `DELETE /views/:id`)
- Test: `tests/operations.test.ts`

**Interfaces:**
- `GET /tickets/counts` → `{ counts: { all, open, pending, waiting_customer, resolved, closed, unassigned, mine } }` (all numbers; `unassigned` counts non-resolved/closed).
- `POST /operations/views` returns 200 with the existing view when name + filters match; 201 otherwise.
- `DELETE /operations/views/:id` → 204; agents may delete only their own personal views; admins may delete any.

- [ ] **Step 1: Failing test** — append to `tests/operations.test.ts`:

```ts
it("reports queue counts and de-duplicates saved views", async () => {
  const workspace = await signup("counts");
  await request("/organization/inboxes", { method: "POST", body: JSON.stringify({ name: "Support", emailAddress: "counts@example.test" }) }, workspace);
  const customer = (await (await request("/customers", { method: "POST", body: JSON.stringify({ name: "C", email: "c@example.test" }) }, workspace)).json() as { customer: { id: string } }).customer;
  await request("/tickets", { method: "POST", body: JSON.stringify({ customerId: customer.id, subject: "One", message: "x" }) }, workspace);
  const counts = (await (await request("/tickets/counts", {}, workspace)).json() as { counts: Record<string, number> }).counts;
  expect(counts).toMatchObject({ all: 1, waiting_customer: 1, open: 0, unassigned: 1, mine: 0 });
  const first = await request("/operations/views", { method: "POST", body: JSON.stringify({ name: "Open tickets", filters: { status: "open" } }) }, workspace);
  const second = await request("/operations/views", { method: "POST", body: JSON.stringify({ name: "Open tickets", filters: { status: "open" } }) }, workspace);
  expect(first.status).toBe(201); expect(second.status).toBe(200);
  const views = (await (await request("/operations/views", {}, workspace)).json() as { views: Array<{ id: string }> }).views;
  expect(views).toHaveLength(1);
  expect((await request(`/operations/views/${views[0].id}`, { method: "DELETE" }, workspace)).status).toBe(204);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — counts SQL:

```sql
SELECT count(*) AS all_count, sum(status='open') AS open, sum(status='pending') AS pending, sum(status='waiting_customer') AS waiting_customer, sum(status='resolved') AS resolved, sum(status='closed') AS closed, sum(assigned_user_id IS NULL AND status NOT IN ('resolved','closed')) AS unassigned, sum(assigned_user_id = ? AND status NOT IN ('resolved','closed')) AS mine FROM tickets WHERE organization_id = ?
```

Coerce nulls to 0. Views: before insert, `SELECT id, name, visibility, filters FROM saved_views WHERE organization_id = ? AND owner_user_id = ? AND name = ? AND filters = ?` (bind `JSON.stringify(input.filters)`; Drizzle stores JSON as text) → return 200 `{ view }` when found. Delete route checks ownership or `roleRank[tenant.role] >= roleRank.admin`.

- [ ] **Step 4: Run** tests, typecheck, lint → pass. **Commit** — `git commit -am "feat: ticket queue counts, saved view dedupe and delete"`

---

### Task 11: Frontend foundation — API errors, toasts, error boundary, auth pages, shell menus, settings

**Files:**
- Modify: `src/web/lib/api.ts`
- Create: `src/web/components/toast.tsx`
- Create: `src/web/components/error-boundary.tsx`, `src/web/pages/not-found.tsx`
- Create: `src/web/pages/forgot-password.tsx`, `src/web/pages/reset-password.tsx`
- Modify: `src/web/main.tsx`, `src/web/auth.tsx`, `src/web/pages/login.tsx`, `src/web/pages/signup.tsx`, `src/web/pages/accept-invite.tsx`, `src/web/components/app-shell.tsx`, `src/web/pages/settings.tsx`, `src/web/pages/dashboard.tsx`, `src/web/pages/customers.tsx`, `src/web/pages/team.tsx`
- Modify: `src/web/styles/pages.css`, `src/web/styles/shell.css` (toast, menu, banner, `.app-loading`, tag colours `slate|blue|green|pink`, `.thread-entry.system`)
- Test: `src/web/__tests__/api.test.ts` (jsdom; add a `vitest.web.config.ts` with `environment: "jsdom"` and script `test:web`; keep `npm test` for Workers tests)

**Interfaces:**
- `class ApiError extends Error { status: number; code: string }`; `api<T>()` throws `ApiError`; on 401 for any path except `/auth/login`, `/auth/me`, `/auth/signup`, `/auth/accept-invitation` it dispatches `window.dispatchEvent(new CustomEvent("resolvehq:unauthenticated"))` before throwing.
- `useToast(): { push(message: string, tone?: "info" | "success" | "error"): void }`; `<ToastProvider>` wraps the router in `main.tsx`.
- Session gains `workspaces` (already returned). `useAuth()` gains `switchWorkspace(organizationId: string): Promise<void>`.

- [ ] **Step 1: Failing unit test**

```ts
// src/web/__tests__/api.test.ts
import { describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/web/lib/api";

describe("api()", () => {
  it("throws ApiError with code and dispatches unauthenticated on 401", async () => {
    const listener = vi.fn(); window.addEventListener("resolvehq:unauthenticated", listener);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Sign in to continue." } }), { status: 401 })));
    await expect(api("/tickets")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(new ApiError(409, "ticket_version_conflict", "x")).toBeInstanceOf(Error);
  });
});
```

`vitest.web.config.ts`: `defineConfig({ resolve: { alias: { "@": path.resolve(__dirname, "./src") } }, test: { environment: "jsdom", include: ["src/web/**/*.test.ts?(x)"] } })`; script `"test:web": "vitest run --config vitest.web.config.ts"`. Exclude `src/web/**/*.test.*` from the Workers config include (already limited to `tests/**`).

- [ ] **Step 2: Run** `npm run test:web` → FAIL.

- [ ] **Step 3: api.ts**

```ts
export class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const silent401 = ["/auth/login", "/auth/me", "/auth/signup", "/auth/accept-invitation"];
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // …headers/csrf unchanged…
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorBody;
    if (response.status === 401 && !silent401.some((prefix) => path.startsWith(prefix))) window.dispatchEvent(new CustomEvent("resolvehq:unauthenticated"));
    throw new ApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? "The request could not be completed.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
```

`AuthProvider`: `useEffect(() => { const clear = () => setSession(null); window.addEventListener("resolvehq:unauthenticated", clear); return () => window.removeEventListener(...); }, [])`. `RequireAuth` redirects to `/login?next=${encodeURIComponent(location.pathname + location.search)}`; login navigates to `next` (only if it starts with `/`). Add `switchWorkspace` = `await api("/auth/switch-workspace", { method: "POST", body: JSON.stringify({ organizationId }) }); await refresh();`.

- [ ] **Step 4: Toast**

```tsx
// src/web/components/toast.tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
interface Toast { id: number; message: string; tone: "info" | "success" | "error" }
const ToastContext = createContext<{ push: (message: string, tone?: Toast["tone"]) => void } | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }].slice(-4));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return <ToastContext.Provider value={value}>{children}<div className="toast-stack" role="status" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.message}</div>)}</div></ToastContext.Provider>;
}
export function useToast() { const context = useContext(ToastContext); if (!context) throw new Error("useToast must be used inside ToastProvider"); return context; }
```

CSS: `.toast-stack { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 8px; z-index: 60 }`, `.toast { padding: 10px 14px; border-radius: 8px; background: var(--ink); color: var(--paper); font-size: 13px; box-shadow: var(--shadow-2) }`, `.toast-error { background: var(--danger) }`, `.toast-success { background: var(--success) }` (use existing token names from `tokens.css`; add missing ones).

- [ ] **Step 5: Error boundary + 404** — `RouteError` component using `useRouteError()` rendering a `.placeholder-page` with "Something went wrong" and a Reload button (`location.reload()`); `NotFoundPage` similar with "Page not found" and a link to `/inbox`. Router: `errorElement: <RouteError />` on the root objects and `{ path: "*", element: <NotFoundPage /> }`.

- [ ] **Step 6: Auth pages** — `/forgot-password`: email form → `POST /auth/forgot-password` → always shows "If that email exists, a reset link is on its way." `/reset-password`: reads `token`, password form (min 12) → `POST /auth/reset-password` → toast + navigate to `/login`. Login page: "Forgot password?" link. Signup: add `Support email (optional)` input named `supportEmail` with helper text "The address customers write to. You can add it later in Settings." Accept-invite: if `session` exists → do NOT redirect; show "Join workspace as {session.user.email}" button → `POST /auth/accept-invitation { token }` → `refresh()` → navigate `/inbox`; on `wrong_account` show the message with a Sign out button; when signed out add "Already have an account? Sign in" link to `/login?next=/accept-invite?token=…`.

- [ ] **Step 7: Shell** — account area becomes a button opening a small menu (`role="menu"`) with "Settings" and "Sign out" (`logout()` then `navigate("/login")`). Workspace name becomes a `<select>` when `session.workspaces.length > 1`, calling `switchWorkspace` then `navigate("/inbox")`. Add `.app-loading` CSS (centered muted text).

- [ ] **Step 8: Settings** — sections: Workspace (existing), Support inboxes (existing + inline banner when empty), Account (change password form → `POST /auth/change-password`, toast on success), Mail delivery (existing), and "Captured outgoing mail (development)" which calls `GET /operations/dev-mail`, hides itself on 404, lists `to · subject · time` with a `<details>` for text. Dashboard: fetch `/organization/settings` and show `.page-banner` "No support inbox configured — replies cannot be sent. Add one in Settings." when `inboxes.length === 0`. Customers and Team pages: wrap loads in try/catch → `toast.push(message, "error")`, add an empty-state paragraph when lists are empty.

- [ ] **Step 9: Server signup** — accept `supportEmail: z.string().trim().email().max(254).transform(lower).optional()`; when present create the inbox (`isDefault: true`) and set `organizations.support_email`; on UNIQUE failure of the inbox address return 409 `inbox_address_exists`.

- [ ] **Step 10: Verify** — `npm run test:web`, `npm test`, typecheck, lint, `npm run build`. Manually: `npm run dev`, login, open Settings, trigger forgot-password, see the capture in Settings. **Commit** — `git commit -am "feat: api errors, toasts, error boundary, password reset pages, shell menus, settings"`

---

### Task 12: Inbox refactor on react-query

**Files:**
- Create: `src/web/inbox/queue-sidebar.tsx`, `ticket-ledger.tsx`, `conversation.tsx`, `thread-message.tsx`, `composer.tsx`, `create-ticket-dialog.tsx`, `customer-sheet.tsx`
- Create: `src/web/hooks/use-tickets.ts`, `use-conversation.ts`, `use-draft.ts`, `use-inbox-shortcuts.ts`, `use-workspace-data.ts`
- Modify: `src/web/pages/inbox.tsx` (composition only), `src/web/components/app-shell.tsx` (chord gating), `src/web/components/rich-composer.tsx`, `src/web/styles/inbox.css`

**Interfaces:**
- `useTickets(filters: { queue: string; priority?: string; q: string })` → `{ tickets, isPending, isFetching, error, refetch }` using `useQuery({ queryKey: ["tickets", filters], placeholderData: keepPreviousData, refetchInterval: () => document.visibilityState === "visible" ? 15_000 : 60_000 })`.
- `useTicketCounts()` → `{ counts }` from `GET /tickets/counts`, `refetchInterval: 30_000`.
- `useConversation(ticketId?: string)` → `{ conversation, error, isPending, update(changes), addTag(id), removeTag(id), sendMessage({ body, bodyHtml, kind, attachmentIds, clientMessageId }) }`; each mutation `onError: (e) => toast.push(e.message, "error")`; 409 → also `refetch()` and toast "Ticket changed elsewhere. Reloaded."; `onSuccess` invalidates `["tickets"]`, `["conversation", ticketId]`, `["ticket-counts"]`.
- `useDraft(ticketId)` → `{ body, html, kind, setBody(text, html), setKind, status: "idle" | "saving" | "saved" | "error", savedAt, clear(): Promise<void> }` — autosave 700 ms debounce, serialised writes; on 409 `draft_revision_conflict` refetch draft and adopt `revision`; `clear()` awaits any in-flight save before `DELETE`.
- `useWorkspaceData()` → members, customers, tags, savedReplies, teams, savedViews via `useQueries`; exposes `createView`, `deleteView`.
- Queue keys: `all | open | pending | unassigned | mine | waiting_customer | resolved | closed`. `all` sends no status filter.
- `RichComposer` props: `{ value: string; html?: string; onChange(text, html); onSubmit; placeholder; insertText(text) via ref }` — external inserts use `editor.commands.insertContent` instead of `setContent` (saved replies no longer flatten formatting). The `value` sync effect only runs when `value` changed from outside (track a ref of the last emitted text).
- Composer: attachments upload immediately on selection (`POST /attachments/intents` → PUT), show a chip with a remove button and an "Uploading…" state; Send is disabled while `uploading || submitting || !body.trim()`; file input `accept=".pdf,.zip,.json,.txt,.csv,.jpg,.jpeg,.png,.gif,.webp,.docx,.xlsx"` and a 15 MB check with toast.
- Thread message: `authorName ?? "System"`; agent messages render `bodyHtml` via `dangerouslySetInnerHTML` when present, else `bodyText`; delivery badge for `authorType === "agent" && kind === "message"`: Queued / Sent / Failed (title = `deliveryError`). `system` entries use `.thread-entry.system`.
- Shortcuts: `useInboxShortcuts` receives `chordPending()` from the shell via a small module `src/web/lib/chord.ts` exporting `let pendingUntil = 0; export const startChord = () => { pendingUntil = Date.now() + 1000 }; export const chordPending = () => Date.now() < pendingUntil;` — the shell calls `startChord()` on `g`; the inbox handler returns early when `chordPending()`.
- Errors: conversation load error renders inside `.conversation-panel` ("Could not open this conversation" + Retry); create-ticket errors render inside the dialog.
- Queue nav: single `navigate(\`/inbox?${next}\`)` preserving `priority`.

- [ ] **Step 1: Extract without behaviour change** — move JSX blocks into the seven components with props, keeping the existing `useState` logic in `inbox.tsx`. Run `npm run build` and the Playwright smoke locally (`npx playwright test --project=chromium`, dev servers running) to confirm nothing regressed.

- [ ] **Step 2: Hooks** — implement `use-tickets`, `use-conversation`, `use-workspace-data`, `use-draft`, `use-inbox-shortcuts` as specified; replace state in `inbox.tsx`. Mutations:

```ts
const update = useMutation({
  mutationFn: (changes: Record<string, unknown>) => api(`/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify({ ...changes, version: query.data?.ticket.version }) }),
  onError: (error) => { if (error instanceof ApiError && error.status === 409) { toast.push("Ticket changed elsewhere. Reloaded.", "info"); void query.refetch(); } else toast.push(error.message, "error"); },
  onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["conversation", ticketId] }); void queryClient.invalidateQueries({ queryKey: ["tickets"] }); void queryClient.invalidateQueries({ queryKey: ["ticket-counts"] }); },
});
```

- [ ] **Step 3: Composer + thread + queues + drafts + chord fix** per the Interfaces block. Sidebar shows `counts[queue]` badges for every queue.

- [ ] **Step 4: CSS** — `.delivery-badge` (`.queued` muted, `.sent` green, `.failed` red), `.attachment-chip`, `.draft-status` (small muted text under the editor), `.thread-entry.system`, `.page-banner`, tag colours `.tag-slate .tag-blue .tag-green .tag-pink`, `.priority-normal`. Remove dead `.filter-button` rules; fold `finishing.css` overrides into the base files and delete `finishing.css` + its import.

- [ ] **Step 5: Verify** — build, typecheck, lint, `npm test`, `npm run test:web`. Manual: two browser tabs; reply in one, see it appear in the other within 15 s; change status in both → conflict toast; attach a `.txt`, send, download it. **Commit** — `git commit -am "refactor: inbox on react-query with resilient mutations, composer uploads, delivery state"`

---

### Task 13: Tooling, hermetic e2e, docs

**Files:**
- Create: `.prettierrc` (`{ "printWidth": 120, "singleQuote": false, "semi": true }`), `scripts/db-reset-local.sh`
- Modify: `package.json` (scripts `format`, `db:reset:local`, `test:e2e` runs reset first), `playwright.config.ts` (`webServer`), `e2e/resolvehq.spec.ts`, `README.md`, `docs/architecture.md`, `.github/workflows/ci.yml` (add `test:web`)

- [ ] **Step 1: Prettier** — `npm i -D prettier`; add script `"format": "prettier --write \"src/**/*.{ts,tsx,css}\" \"tests/**/*.ts\" \"e2e/**/*.ts\""`; run it; ensure ESLint has no formatting rules that conflict (`npm run lint`). Commit separately: `style: format with prettier`.

- [ ] **Step 2: db reset** — `scripts/db-reset-local.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
rm -rf .wrangler/state/v3/d1
npm run db:migrate:local
npm run db:seed:local
```

`"db:reset:local": "bash scripts/db-reset-local.sh"`, `"test:e2e": "npm run db:reset:local && playwright test"`. Also fix `drizzle/seed.sql` so `users` uses `INSERT OR IGNORE` (no password reset on reseed).

- [ ] **Step 3: Playwright webServer**

```ts
webServer: [
  { command: "npx wrangler dev --port 8787", url: "http://localhost:8787/api/health", reuseExistingServer: !process.env.CI, timeout: 60_000 },
  { command: "npx vite --port 5173", url: "http://localhost:5173", reuseExistingServer: !process.env.CI, timeout: 60_000 },
],
```

`baseURL` default becomes `http://localhost:5173`.

- [ ] **Step 4: E2E spec** — keep the existing smoke and add:

```ts
test("agent can reply, see delivery state, and create a ticket", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@northstarlabs.test");
  await page.getByLabel("Password").fill("resolve-demo-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Webhook deliveries retrying indefinitely", { exact: true }).first().click();
  await page.getByLabel("Reply message").fill("Thanks — looking into this now.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Thanks — looking into this now.")).toBeVisible();
  await expect(page.locator(".delivery-badge").last()).toHaveText(/Queued|Sent/);
  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Customer").selectOption({ index: 1 });
  await page.getByLabel("Subject").fill("Proactive outreach");
  await page.getByLabel("Initial message").fill("Checking in.");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { name: "Proactive outreach" })).toBeVisible();
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: /Reset your password/i })).toBeVisible();
});
```

Run `npm run test:e2e` → both tests pass on chromium (fix selectors as needed; keep them role/label based).

- [ ] **Step 5: Docs** — README: update "Included MVP" to match reality (threading model, password reset, system mail via `SYSTEM_MAIL_FROM`, dev mail capture in Settings, attachments-before-send); add a "Not yet implemented" list (DLQ consumers, AI provider, outbound attachments in email, pagination UI, notifications UI, dark mode). `docs/architecture.md`: replace the HTML-sanitisation sentence with the agent-HTML allowlist description; document rfc/provider ids; document cron recovery + staging cleanup. `.dev.vars.example`: `SYSTEM_MAIL_FROM`. CI: add `npm run test:web`.

- [ ] **Step 6: Final verification** — `npm run typecheck && npm run lint && npm test && npm run test:web && npm run build && npm run test:e2e`. **Commit** — `git commit -am "chore: hermetic e2e, prettier, docs aligned with implementation"`

---

## Self-review notes

- Spec coverage: 1.1→T3, 1.2→T3/T4/T11, 1.3→T4, 1.4→T2/T11, 1.5→T6/T11, 1.6→T7/T11, 1.7→T11/T12, 1.8→T4/T12, 2.1/2.2→T4, 2.3/2.4→T5, 2.5→T8, 2.6→T9, 2.7→T10/T12, 2.8→T12/T13, 2.9→each task, 2.10→T13.
- Names used across tasks: `validate`, `sendSystemMail`, `selectOutgoingProvider`, `applyTicketUpdate`, `statusTimestamps`, `refreshTicketSearch`, `toFtsQuery`, `sanitizeHtml`, `ApiError`, `useToast`, `chordPending/startChord`. Keep them exact.
