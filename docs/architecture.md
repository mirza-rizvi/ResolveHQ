# ResolveHQ architecture

## Shape

ResolveHQ ships as one Cloudflare Worker. Hono owns `/api/*`, inbound email, queue consumers, and scheduled work. The Worker serves the Vite-built React application for all other routes. This keeps deployment and operations simple while preserving clear module boundaries in code.

```text
Browser ──HTTPS──> Worker/Hono ──> D1
                         │         relational source of truth
                         ├───────> R2 via StorageProvider
Incoming mail ──> Worker email() ──> R2 staging ──> Queue pointer ──> ticket/message services
Replies ────────> D1 outbox ──> Queue ──> OutgoingMailProvider
Cron ───────────> outbox reconciliation, expired sessions/invites, and maintenance
```

## Trust boundaries

- Authentication resolves a session to a user and active organization membership.
- Every request creates a `TenantContext` containing organization, user, role, and request metadata.
- Business repositories require `organizationId`; domain services never accept an unscoped database handle for tenant-owned reads.
- Object storage keys include opaque organization and attachment identifiers, but object-key structure is not authorization. Downloads re-check the attachment row and organization membership.
- Browser input is validated with Zod. Drizzle parameterizes database operations. Agent replies with rich formatting are sanitized server-side (`src/server/lib/sanitize-html.ts`, `sanitizeHtml`) against an allowlist (`p`, `br`, `strong`, `b`, `em`, `i`, `u`, `ul`, `ol`, `li`, and `a` with an `http(s)`/`mailto` `href`; every other tag, attribute, and script/style body is stripped) before being stored in `messages.body_html` and rendered as HTML. Inbound customer email is never treated as HTML; it is stored and rendered as plain text only.
- Mutating cookie-authenticated requests require same-origin validation and a matching CSRF token.
- `APP_URL` is optional; when unset the request origin is used for CSRF validation and outbound links.

## Modules

- `src/server/auth`: passwords, sessions, CSRF, and rate limiting.
- `src/server/organizations`: organizations, memberships, invitations, and roles.
- `src/server/customers`: customer profiles and history.
- `src/server/tickets`: tickets, messages, notes, assignment, tags, and activity.
- `src/server/attachments`: validated uploads and authorized downloads.
- `src/server/search`: tenant-scoped ticket and message search.
- `src/server/knowledge-base`: internal articles plus the public help center; drafts never leave the tenant.
- `src/server/reports`: tenant-scoped window metrics and formula-safe CSV export.
- `src/server/automations`: ordered rule matching with per-event deduplication.
- `src/server/privacy`: customer export, durable erasure, and ticket deletion with mail-cancellation guards.
- `src/server/assistant`: optional AI summarize, draft, and classification behind the provider seam.
- `src/server/providers`: storage, incoming/outgoing mail, and optional AI contracts.
- `src/web`: React application and route surfaces.

## Provider boundaries

`StorageProvider` exposes validated object put/get/delete operations. The Cloudflare implementation uses R2; a future S3-compatible implementation can replace it without changing ticket services.

`IncomingMailProvider` normalizes raw MIME into an inbound support message. The email handler records the envelope recipient and a durable staging reservation, then streams RFC822 to a randomized R2 staging key; Queues receive only the event ID and object key. The consumer resolves a globally unique inbox, de-duplicates provider message IDs, checkpoints attachment progress, and links replies to a ticket the sending customer already owns. Visible ticket numbers are never trusted for threading. `OutgoingMailProvider` sends a reply envelope and returns a provider message ID. The production Resend adapter uses deterministic idempotency keys; signed webhooks are replay-protected by `svix-id`.

Every outgoing adapter declares whether it is idempotent. Resend and the development capture provider are: a repeated send of the same idempotency key collapses into one email. The optional Cloudflare Email Sending adapter is not — the platform offers no idempotency key and assigns the Message-ID itself — so `processOutboundMail` writes a generation-fenced `send_attempted_at` marker in its own statement immediately before calling the binding. A job that already carries the marker is stopped as `delivery_uncertain` instead of being sent again; only a synchronous rejection, which proves nothing left the Worker, clears it. Nothing resends a non-idempotent message automatically: an administrator must accept the duplicate risk in Settings, and that retry bumps the generation and clears the marker.

Delivery outcomes from either provider converge on `applyDeliveryEvent`, which records `(provider, external_event_id)` once, scopes the message update through the outbound job that owns the provider message id, and preserves an existing complaint reason. Resend delivers them as signed webhooks; Cloudflare delivers them as a Queues event subscription, de-duplicated on `payload.eventId`, where `deferred` is recorded but changes no state.

### Threading

Every message carries two identifiers: `provider_message_id` (the outgoing mail provider's id, or the inbound `Message-ID` as received) and `rfc_message_id` (an RFC 5322 Message-ID, unique per organization). Sending a reply mints `<${messageId}@${inboxDomain}>`, stores it as `rfc_message_id`, and sends it as the `Message-ID` header, with `In-Reply-To`/`References` set to the ticket's most recent customer message.

**Identity scope.** A customer is a set of addresses, not one address: `customer_identities` holds every address the workspace knows for them, with exactly one primary (mirrored in `customers.email`). An inbound message contributes two candidate addresses — `From` and `Reply-To` — and the identity rows for those candidates name the customers a reply may attach to. Only `From` can create an identity (`source = 'inbound_from'`); a `Reply-To` is never persisted, because anyone can put anyone's address in that header.

**Delivering inbox.** No tier filters on `tickets.inbox_id`. A workspace with `support@` and `billing@` threads a reply that arrives at either one onto the same conversation. A matched ticket keeps the inbox it was created with, so the outbound `From` never changes mid-thread; only a new ticket records the inbox that delivered it.

Tiers, in order, all scoped to the resolved inbox's organization:

1. **Same `provider_message_id`** — the duplicate detector. Sender-agnostic, org-wide.
2. **`References` / `In-Reply-To`** matched against `rfc_message_id` or `provider_message_id`, restricted to tickets owned by one of the candidate customers. Knowing an RFC Message-ID is the secret here, so `Reply-To` is admitted.
3. **Signed reply address** — the plus tag on the envelope recipient, `t<number>.<signature>`, verified against the ticket it names before it is accepted (see below). Restricted to the candidate customers; runs before the subject tier so a header-stripping mail client still threads.
4. **Subject `[#<number>]`** — guessable, so it is restricted to the ticket customer of the `From` address alone. A forged subject from a different sender, or a forged `Reply-To`, opens a new ticket rather than attaching to someone else's.

**Reply token format.** `t<ticket number>.<first 10 characters of base64url(HMAC-SHA256(SESSION_PEPPER, "reply-token:" + organizationId + ":" + ticketId)), lower-cased>`; verification is constant-time. The signature is lower-cased because a delivery address is normalized to lower case before the tag is read. A tampered or foreign token is ignored, and the message falls through to the remaining tiers.

**Plus addressing.** `canonicalizeRecipient` splits a recipient at the first `+` of the local part: `support+t1002.ab12cd34ef@acme.test` is a delivery for the `support@acme.test` inbox carrying the tag `t1002.ab12cd34ef`. Inbox resolution tries the address as delivered first and the bare mailbox second; only the bare mailbox may auto-provision an inbox from an organization's `support_email`, and that provisioning only ever returns an inbox the claiming workspace owns. The raw recipient is still stored in `inbound_mail_events.envelope_to`.

**Outbound `Reply-To` is opt-in.** With `OUTBOUND_REPLY_TOKEN = "enabled"`, the frozen outbound envelope gets `Reply-To: <local>+<token>@<domain>`. It is off by default because Cloudflare Email Routing matches custom addresses exactly: the tagged address only reaches the Worker if the sending domain has a catch-all rule pointing at it. Enable the flag only after adding that rule.

### Cron recovery

The scheduled handler runs every five minutes. Each sweep touches at most 20 candidate rows: expired sessions, invitations and reset tokens; expired 20-minute mail leases; exhausted retries; and missing outbound outbox rows after a two-minute grace period. D1 dispatch reservations prevent repeated enqueueing while a delivery is in flight. Cleanup discovery creates durable maintenance tasks only when old objects exist; maintenance consumers process five objects or customer-search tickets per invocation. Raw staging objects become cleanup candidates after seven days; unlinked uploads and abandoned reservations after one day. See the [Free-plan audit](cloudflare-free.md) for retry windows, manual recovery, and remaining CPU limits.

`AIProvider` exposes optional summarize, draft, classify, translate, sentiment, similar-ticket, and tag suggestions. The default provider reports that AI is unavailable; core workflows never depend on it.

Two implementations exist and `resolveAIProvider` picks between them: `WorkersAIProvider` when the `AI` binding is present, otherwise `OpenAIProvider` when `OPENAI_API_KEY` is configured, otherwise none. Workers AI is preferred because inference then runs inside the deployer's own Cloudflare account. Both share the same system prompt, so conversation content is passed as untrusted data either way; every response is validated, classification JSON is extracted from whatever wrapper text the model returns, and failures surface as `502`/`503` errors the UI reports without touching the agent's draft. Translation uses `@cf/meta/m2m100-1.2b` in chunks of at most 2,000 characters, or a chat prompt on OpenAI.

### Erasure

Customer erasure reuses the durable maintenance task queue: each invocation deletes five tickets (cancelling in-flight outbound jobs and terminalizing matching inbound events first), removes attachment bytes from R2, and finishes by deleting the customer profile and any captured dev mail. The final pass loops over every identity the customer holds, not just the primary address, so staged mail from a secondary address cannot revive the conversation. A customer merge is blocked while an erasure task for either side is outstanding. A lost invocation resumes from the task row; an interrupted one never leaves mail jobs alive behind deleted content.

## Multi-tenancy

Organizations are the tenant boundary. Users may belong to more than one organization through memberships. All tenant-owned tables include `organization_id`, even where it is derivable through another relationship; this makes tenant filters explicit, indexable, and auditable. Composite indexes lead with `organization_id` for primary query paths.

## Async behavior

Queue payloads contain only opaque event/job IDs and R2 object keys, never raw mail, session credentials, or provider secrets. Inbound retries are idempotent through event checkpoints, unique provider message IDs, deterministic attachment keys, and an attachment cursor. Outbound jobs live in a D1 outbox, stop once sent, back off after failure, and are re-enqueued by Cron. Six actual failures stop automatic processing and retain D1 state; terminal jobs and exhausted Queue retries flow to dedicated dead-letter queues, whose consumers drain the queues by marking the durable rows `queue_exhausted` and recording each arrival. Administrators review stopped mail in Settings. Outbound automatic retries keep a frozen envelope and attachment manifest within a 23-hour window — attachment bytes resolve from storage and re-verify on every attempt — and complaints cannot be resent.

## Search

Ticket search uses tenant-scoped D1 FTS5 with prefix queries across ticket number, subject, customer identity, messages, and tags. Writes refresh one ticket's search document. Ticket and customer lists use bounded keyset cursors instead of offsets; ticket hot-path metadata avoids joining the message table for routine inbox loads.

## Consistency and concurrency

Tickets carry an integer `version`. Clients include it with mutations and receive `409 ticket_version_conflict` when another session won the update. Agent drafts have monotonically increasing revisions, message submissions accept a client idempotency ID, and opening a conversation updates the user's tenant-scoped read state.
