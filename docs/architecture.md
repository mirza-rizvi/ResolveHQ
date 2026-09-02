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
- Browser input is validated with Zod. Drizzle parameterizes database operations. HTML email is sanitized before display.
- Mutating cookie-authenticated requests require same-origin validation and a matching CSRF token.

## Modules

- `src/server/auth`: passwords, sessions, CSRF, and rate limiting.
- `src/server/organizations`: organizations, memberships, invitations, and roles.
- `src/server/customers`: customer profiles and history.
- `src/server/tickets`: tickets, messages, notes, assignment, tags, and activity.
- `src/server/attachments`: validated uploads and authorized downloads.
- `src/server/search`: tenant-scoped ticket and message search.
- `src/server/providers`: storage, incoming/outgoing mail, and optional AI contracts.
- `src/web`: React application and route surfaces.

## Provider boundaries

`StorageProvider` exposes validated object put/get/delete operations. The Cloudflare implementation uses R2; a future S3-compatible implementation can replace it without changing ticket services.

`IncomingMailProvider` normalizes raw MIME into an inbound support message. The email handler first streams RFC822 to a randomized R2 staging key; Queues receive only the event ID and object key. The consumer resolves a globally unique inbox, de-duplicates provider message IDs, checkpoints attachment progress, and only links replies when `In-Reply-To` matches the same inbox and customer. Visible ticket numbers are never trusted for threading. `OutgoingMailProvider` sends a reply envelope and returns a provider message ID. The production Resend adapter uses deterministic idempotency keys; signed webhooks are replay-protected by `svix-id`.

`AIProvider` exposes optional summarize, draft, classify, sentiment, similar-ticket, and tag suggestions. The default provider reports that AI is unavailable; core workflows never depend on it.

## Multi-tenancy

Organizations are the tenant boundary. Users may belong to more than one organization through memberships. All tenant-owned tables include `organization_id`, even where it is derivable through another relationship; this makes tenant filters explicit, indexable, and auditable. Composite indexes lead with `organization_id` for primary query paths.

## Async behavior

Queue payloads contain only opaque event/job IDs and R2 object keys, never raw mail, session credentials, or provider secrets. Inbound retries are idempotent through event checkpoints, unique provider message IDs, deterministic attachment keys, and an attachment cursor. Outbound jobs live in a D1 outbox, stop once sent, back off after failure, and are re-enqueued by Cron. Exhausted Queue retries flow to dedicated dead-letter queues.

## Search

Ticket search uses tenant-scoped D1 FTS5 with prefix queries across ticket number, subject, customer identity, messages, and tags. Writes refresh one ticket's search document. Ticket and customer lists use bounded keyset cursors instead of offsets; ticket hot-path metadata avoids joining the message table for routine inbox loads.

## Consistency and concurrency

Tickets carry an integer `version`. Clients include it with mutations and receive `409 ticket_version_conflict` when another session won the update. Agent drafts have monotonically increasing revisions, message submissions accept a client idempotency ID, and opening a conversation updates the user's tenant-scoped read state.
