# ResolveHQ architecture

## Shape

ResolveHQ ships as one Cloudflare Worker. Hono owns `/api/*`, inbound email, queue consumers, and scheduled work. The Worker serves the Vite-built React application for all other routes. This keeps deployment and operations simple while preserving clear module boundaries in code.

```text
Browser ──HTTPS──> Worker/Hono ──> D1
                         │         relational source of truth
                         ├───────> R2 via StorageProvider
Incoming mail ──> Worker email() ──> Queue ──> ticket/message services
Replies ────────> Queue ──> OutgoingMailProvider
Cron ───────────> expired sessions/invites and maintenance
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

`IncomingMailProvider` normalizes raw MIME into an inbound support message. The queue consumer resolves the exact organization by its configured support address, de-duplicates provider message IDs, links replies by `In-Reply-To` or ticket number, and validates accepted attachments before R2 storage. `OutgoingMailProvider` sends a reply envelope and returns a provider message ID. The development adapter captures mail deterministically; production delivery requires a provider adapter.

`AIProvider` exposes optional summarize, draft, classify, sentiment, similar-ticket, and tag suggestions. The default provider reports that AI is unavailable; core workflows never depend on it.

## Multi-tenancy

Organizations are the tenant boundary. Users may belong to more than one organization through memberships. All tenant-owned tables include `organization_id`, even where it is derivable through another relationship; this makes tenant filters explicit, indexable, and auditable. Composite indexes lead with `organization_id` for primary query paths.

## Async behavior

Inbound and outbound email payloads contain opaque IDs or raw RFC 822 mail, never session credentials or provider secrets. Queue consumers resolve current tenant data before acting. Inbound retries are idempotent through provider message IDs; outbound jobs stop once their message is marked sent.

## Search

The MVP uses tenant-scoped indexed SQL with normalized search text on tickets, customers, messages, and tags. The search service owns the query strategy so D1 FTS can be introduced later without changing API contracts.
