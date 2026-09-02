# ResolveHQ MVP hardening — design

Date: 2026-09-02. Baseline commit: `a412048`.

## Goal

Make ResolveHQ a credible MVP for a small support team: the full loop (customer emails in → agent replies → customer reply threads back onto the same ticket) works out of the box, failures are visible, tenant boundaries hold in every write path, and the README describes what actually exists.

Two phases. Phase 1 makes the core loop work. Phase 2 hardens correctness, security, and maintainability. Items deliberately out of scope are listed at the end.

## Phase 1 — core loop

### 1.1 Email threading

Problem: outbound messages store the Resend API id in `messages.provider_message_id`; inbound replies carry an RFC 5322 `Message-ID` in `In-Reply-To`. They never match, and outbound mail sets no `In-Reply-To`/`References`.

Design:

- Add `messages.rfc_message_id TEXT` (unique per organization, nullable). Migration `0002_mvp_hardening.sql` (one migration for every schema change in this spec).
- Outbound: before sending, generate `<${messageId}@${domain}>` where `domain` is the inbox address domain, store it in `rfc_message_id`, and pass it as a `Message-ID` header to the provider. Also set `In-Reply-To` and `References` to the ticket's most recent customer message `rfc_message_id`/`provider_message_id` when one exists. `OutgoingMail` gains `messageId?: string` and `references?: string[]`.
- Inbound: collect candidate ids from `In-Reply-To` and `References` (postal-mime exposes `references`). Match any candidate against `messages.rfc_message_id` OR `messages.provider_message_id` within the resolved inbox's organization, and require the ticket's customer email to equal the sender. First match wins.
- Subject fallback: if no header match and the subject contains `[#<number>]`, match a ticket with that number in the same inbox whose customer email equals the sender. Different sender → new ticket (existing forged-subject test stays green).
- Store inbound `Message-ID` in both `provider_message_id` (existing) and `rfc_message_id`.
- Test: agent reply → capture outbound Message-ID → inbound reply with `In-Reply-To` → same ticket, status reopened to `open`. Second test: subject fallback with matching customer attaches, with different customer does not.

### 1.2 Default inbox and visible delivery state

- Signup accepts optional `supportEmail`. When present: create default inbox named "Support" and set `organizations.support_email`. Signup UI adds the field with helper text "The address customers write to. You can add it later in Settings."
- `POST /tickets` and outbound sending require an inbox. Outbound with no resolvable `from` fails the job with `last_error = "No support inbox is configured."` and sets `messages.delivery_status = 'failed'` — never sends from `.invalid`.
- `GET /tickets/:id` returns per-message `deliveryStatus` and `deliveryError` (from `outbound_mail_jobs.last_error`), plus `authorName` (join `users` on `author_user_id`).
- UI: agent messages show a delivery badge (Queued / Sent / Failed, error text on hover/title). Settings and Dashboard show a banner "No support inbox configured — replies cannot be sent" with a link to Settings when `inboxes` is empty.
- Remove `DEV_MAIL_MODE`-independent `.invalid` fallback.

### 1.3 Agent-created tickets reach the customer

`POST /tickets`: initial message is `authorType: "agent"`, `authorUserId: tenant.userId`, `deliveryStatus: "queued"`, outbound job enqueued, ticket status `waiting_customer`, `waiting_since = now`, `last_agent_reply_at = now`. Test asserts an outbound job row exists and the message is agent-authored.

### 1.4 Development mail capture

- New table `mail_captures (id, organization_id NULL, to, from, subject, text, html, headers JSON, created_at)`.
- `DevelopmentMailProvider` takes a `D1Database` and inserts one row per send. Returns `providerMessageId = dev_<uuid>`.
- `GET /api/operations/dev-mail` (admin+, only when `DEV_MAIL_MODE === "capture"`, else 404) returns the last 50 captures for the tenant plus system mails (organization NULL) addressed to the current user's email.
- Settings page: "Captured outgoing mail (development)" section listing to/subject/time with expandable text. Hidden in production automatically because the endpoint 404s.
- Test: agent reply in capture mode → one `mail_captures` row with the right `to` and subject.

### 1.5 Password reset and change

- Table `password_reset_tokens (id, user_id, token_hash UNIQUE, expires_at, used_at, created_at)`. Tokens hashed with the same `sha256(token.pepper)` pattern as invitations. 30-minute expiry.
- `POST /auth/forgot-password {email}` — rate limited by ip and by email (two keys), always 200. If the user exists, insert a token and send a system mail with `${APP_URL}/reset-password?token=…`.
- `POST /auth/reset-password {token, password}` — validates, sets the hash, marks the token used, deletes all sessions for the user.
- `POST /auth/change-password {currentPassword, newPassword}` (authenticated) — verifies current, sets new, deletes all other sessions.
- System mail helper `sendSystemMail(env, { to, subject, text })` in `src/server/mail/system.ts`: picks Resend or capture provider, `from` = `env.SYSTEM_MAIL_FROM` (new var, default `no-reply@<APP_URL host>`). Invitations now also send a system mail with the invite link (URL still returned for copy/paste).
- Pages: `/forgot-password`, `/reset-password`. Login page links to forgot. Settings gains an "Account" section with change-password form.
- Tests: forgot → capture row contains link → reset → old password rejected, new accepted, previous session 401.

### 1.6 Invitations for existing users, workspace switching

- `POST /auth/accept-invitation`: if a valid session cookie is present and the session user's email equals the invitation email, create the membership (or re-enable a disabled one), mark accepted, switch the session's organization, return the session shape. If signed in with a different email → 409 `wrong_account`. Unauthenticated path unchanged (creates user).
- Accept-invite page: when signed in, show "Join <workspace> as <email>" button; when signed in as the wrong user, explain and offer sign-out. When signed out, show existing form plus a "Already have an account? Sign in" link that preserves the token via `?next=`.
- Login: the membership query orders by `organization_memberships.created_at ASC` so the first workspace is chosen deterministically.
- App shell: workspace name becomes a dropdown when `session.workspaces.length > 1`; selecting one calls `/auth/switch-workspace`, then `refresh()` and navigates to `/inbox`. Header account area gets a menu with Settings and Sign out.
- Test: existing user accepts invitation, `GET /auth/me` lists two workspaces, switch works, cross-tenant read after switch is 404.

### 1.7 Inbox data layer and error handling

- Move inbox state to `@tanstack/react-query`: `useTicketList(filters)` (keepPreviousData, `refetchInterval` 15 s when visible), `useConversation(ticketId)` (`refetchInterval` 15 s), mutations via `useMutation` with `onError → toast`, `onSuccess → invalidate`. No skeleton on filter change once data exists; skeleton only on first load. Poll interval must not restart on selection.
- 409 `ticket_version_conflict` → toast "Ticket changed elsewhere. Reloaded." and refetch conversation.
- `api()`: on 401 (except `/auth/me`, `/auth/login`) dispatch a `resolvehq:unauthenticated` window event; `AuthProvider` listens, clears the session, and `RequireAuth` redirects to `/login?next=`. `ApiError` class carries `status` and `code`.
- Toast system: `src/web/components/toast.tsx` — context + `useToast()`; 4 s auto-dismiss, `role="status"`, stacked bottom-right. No new dependency.
- Error boundary at router root (`errorElement`) with "Something went wrong — reload" and a `path: "*"` 404 page.
- Conversation load failures render inside the conversation panel, not the ledger.
- Composer: `submitting` state disables Send; attachment upload happens before the message is created (see 2.6).

### 1.8 Message authorship

Thread entries render `authorName` from the server. `system` messages get a distinct muted style with "System" label.

## Phase 2 — hardening

### 2.1 Ticket update service

`src/server/tickets/service.ts` exports `applyTicketUpdate(db, env, tenant, ticketId, changes, { expectedVersion? })` doing: tenant load, version check, `assertActiveMember`/`assertTeam`, `resolvedAt`/`closedAt` semantics, `waiting_since`, assignment history, notification, activity, `refreshTicketSearch`. `PATCH /tickets/:id` and `POST /operations/tickets/bulk` both call it. Bulk reports `{ updated, skipped: [{ticketId, reason}] }`.

Status timestamp semantics: `resolved` sets `resolved_at` (keeps `closed_at` null); `closed` sets `closed_at` and keeps an existing `resolved_at`; reopening to `open`/`pending`/`waiting_customer` clears both. `waiting_customer` sets `waiting_since`; other statuses clear it.

### 2.2 Reply advances status

Agent `message` (not note) on a ticket in `open`/`pending` → `waiting_customer`, `waiting_since = now`. Inbound customer mail → `open` (existing), clears `waiting_since`.

### 2.3 Search consistency

- Single `refreshTicketSearch` in `src/server/search/index.ts` used by tickets, customers, and mail. Document = ticket normalized + customer name/email + messages + tags, no cartesian product (subqueries).
- `toFtsQuery` shared; empty result after sanitizing → return zero rows (both `/tickets?q=` and `/search`).
- Fix tag attach double query.

### 2.4 Idempotency and upserts

- `POST /tickets/:id/messages`: insert with `onConflictDoNothing` on `(organization_id, client_message_id)`, then read back; duplicate → 200 with `duplicate: true`.
- Inbound event upsert: conflict target on `staging_object_key` for staged events; direct-raw test path keeps `id`.
- `outbound_mail_jobs` in `processing` older than 10 minutes are re-enqueued by cron; same for `inbound_mail_events`. Cron deletes `_mail-staging/*` objects for events in `completed` or `failed` older than 7 days.

### 2.5 Security fixes

- Webhook updates join through `outbound_mail_jobs.provider_message_id` and scope by that job's `organization_id`.
- Rate limits (same `AUTH_RATE_LIMIT` binding, distinct keys): accept-invitation, forgot-password, reset-password, attachment intents, message posts per user (60/min effectively via key `messages:${userId}`).
- Validation errors: `validate("json", schema)` wrapper in `src/server/http/validate.ts` throws `HttpError(400, "validation_error", <first issue path: message>)`. Replace every `zValidator` use.
- Rich text: `src/server/lib/sanitize-html.ts` allowlist sanitizer (p, br, strong, b, em, i, u, ul, ol, li, a[href http/https/mailto]); strips everything else including all other attributes. `messageInput` gains optional `bodyHtml`; sanitized value stored in `body_html` and sent as HTML mail. UI renders `bodyHtml` for agent messages via `dangerouslySetInnerHTML` only when present (server-sanitized); customer messages stay plain text. Test: script/onclick/javascript: href are stripped.

### 2.6 Attachments before send

- `attachments.message_id` becomes nullable; add `attachments.uploaded_by_user_id` existing. Intents accept `ticketId` only; the uploaded row has `message_id NULL`. `POST /tickets/:id/messages` accepts `attachmentIds[]`, verifies each belongs to the tenant, ticket, and uploader with `message_id IS NULL`, then links them in the same batch as the message insert. Cron deletes orphan attachments (`message_id IS NULL`, older than 1 day) and their objects.
- Composer: choose file → upload immediately with progress state → chip with remove; Send disabled while uploading. File input gets `accept` from the allowlist and a client-side 15 MB check.

### 2.7 Queues and drafts UI

- `pending` queue added; "All" queue (no status filter) added. Queue badge shows counts from a new `GET /tickets/counts` (per status + unassigned + mine).
- Draft autosave: on 409, refetch the draft and adopt the server revision; show "Draft saved · 12:03" / "Saving…" under the composer. Sequence the delete after any in-flight save.
- Saved views: creating a view whose name and filters match an existing one is a no-op; `DELETE /operations/views/:id` (owner or admin) with a remove button.
- Queue nav uses a single `navigate`, preserving `priority`.

### 2.8 Inbox refactor

Split `src/web/pages/inbox.tsx` into `src/web/inbox/` components (`queue-sidebar`, `ticket-ledger`, `conversation`, `thread-message`, `composer`, `create-ticket-dialog`, `customer-sheet`) and hooks (`use-tickets`, `use-conversation`, `use-draft`, `use-inbox-shortcuts`). Add Prettier (`printWidth: 120`) and format `src/`. Inbox shortcuts ignore keys while a `g` chord is pending.

### 2.9 Tests

Vitest additions: threading (1.1), agent ticket outbound (1.3), capture (1.4), reset/change password (1.5), invitation accept for existing user + switch (1.6), bulk tenant/version (2.1), reply status (2.2), search punctuation (2.3), message idempotency race (2.4), webhook signature + tenant scope (2.5), sanitizer (2.5), attachment link rules (2.6), RBAC matrix (agent denied on settings/invitations/inboxes/teams), validation envelope shape.

Playwright: `webServer` in config (vite + wrangler), `npm run db:reset:local` script (drops `.wrangler/state` D1, migrates, seeds) run by `test:e2e` first. Spec covers login → open seeded ticket → send reply → delivery badge → create ticket → forgot-password page renders.

### 2.10 Docs

README and `docs/architecture.md` updated: threading model, system mail, `SYSTEM_MAIL_FROM`, dev mail capture, password reset, what remains unimplemented (DLQ consumer, AI provider, outbound attachments in mail, pagination UI). Remove the "HTML email is sanitized" claim and replace with the agent-HTML sanitizer description.

## Out of scope

Dark mode, pagination/load-more UI, notification bell, team membership editing, attachments inside outbound email, FTS in ⌘K, entity deletion/GDPR, DLQ consumers, AI provider wiring, Knowledge Base/Reports/Automations.

## Migration list (`0002_mvp_hardening.sql`)

- `messages.rfc_message_id TEXT`; unique index `(organization_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL`.
- `mail_captures` table.
- `password_reset_tokens` table.
- `attachments.message_id` nullable (SQLite: rebuild table).
- `messages.body_html` already exists.
