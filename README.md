# ResolveHQ

ResolveHQ is a Cloudflare-native, self-hostable helpdesk for small support teams. It combines a fast shared inbox, customer history, internal collaboration, search, attachments, saved replies, and team management without enterprise helpdesk complexity.

## Stack

- React, TypeScript, React Router, Tailwind CSS, and shadcn/ui
- Hono on Cloudflare Workers
- Cloudflare D1 with Drizzle ORM
- Cloudflare R2 behind a replaceable storage interface
- Cloudflare Queues for inbound and outbound mail jobs
- Cloudflare Cron Triggers for maintenance

## Included MVP

- Owner signup, secure sessions, organization creation, invitations (including acceptance while already signed in, with a workspace switcher), and Owner/Admin/Agent roles
- Tenant-isolated customers, customer history, tickets, assignment, status, priority, tags, search, replies, and internal notes
- RFC 5322 email threading: outbound replies set `Message-ID`/`In-Reply-To`/`References`; inbound replies match on those headers first and fall back to a same-customer `[#<ticket number>]` subject token — a forged subject from a different sender never attaches to someone else's ticket
- Signup accepts an optional support email and creates the default inbox from it; outbound sending fails loudly (a delivery badge of Queued/Sent/Failed, with the error on hover) when no inbox is configured, instead of silently sending from a `.invalid` address
- Agent-created tickets email the customer: the initial message is agent-authored, queued for delivery, and the ticket starts in `waiting_customer`
- A development mail capture mode (`DEV_MAIL_MODE=capture`): every outgoing send is recorded in `mail_captures` and viewable in Settings instead of actually being delivered
- Password reset (`/forgot-password`, `/reset-password`) and an authenticated change-password form, plus system mail (password reset, invitations) sent via `SYSTEM_MAIL_FROM` through the same provider seam as ticket mail
- Authorized R2 attachments with size, MIME, signature, and ownership checks; uploads happen immediately on selection and are linked to the message atomically when it is sent, rather than being uploaded at send time
- Saved replies and a responsive three-pane inbox with a focused mobile conversation flow, built on react-query with optimistic-version conflict handling, toasts, an error boundary, and a 404 page
- Cloudflare Email Routing ingestion through R2 staging and an idempotent, checkpointed queue consumer
- Cursor pagination, D1 FTS5 search over a single unified per-ticket document, unread state, drafts, saved views (with dedupe and delete), teams, bulk actions, queue counts, `pending`/`all` queues, and optimistic ticket versions
- A shared ticket update service backing both single and bulk edits; replying with a customer-facing message advances the ticket to `waiting_customer`
- Resend delivery with an outbox, idempotency keys, signed and tenant-scoped webhooks, retries, and reconciliation
- A `WRITE_RATE_LIMIT` binding (in addition to `AUTH_RATE_LIMIT`) covering write-heavy endpoints
- Server-side HTML allowlist sanitization (`src/server/lib/sanitize-html.ts`) for agent replies with rich formatting; customer email is always rendered as plain text
- Cron recovery every 5 minutes: stalled outbound jobs and inbound events, orphaned-job reconciliation, expired mail staging cleanup, and orphaned-attachment cleanup
- Provider seams for outgoing mail, object storage, and optional AI
- Dashboard, team management, activity logging, realistic seed data, and honest placeholders for future product areas

## Not yet implemented

- Dead-letter queue consumers (the DLQs exist and receive exhausted retries, but nothing drains them yet)
- AI provider wiring (the `AIProvider` seam exists; the default implementation reports AI as unavailable)
- Attachments inside outbound email (attachments are stored and linked to messages, but are not attached to the outgoing email itself)
- Pagination / load-more UI (the API is cursor-paginated; the UI does not yet expose loading further pages)
- Notifications UI (notification rows are written; there is no bell or notification center)
- Dark mode
- Team membership editing
- Entity deletion / GDPR export or erasure
- Knowledge Base, Reports, and Automations

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

The Vite application runs on `http://localhost:5173` and proxies `/api` to Wrangler on `http://localhost:8787`.

## Commands

```bash
npm run dev              # Vite and Wrangler together
npm run build            # Type-check and build the SPA
npm run test             # Business-critical tests (Workers pool)
npm run test:web         # React component tests (jsdom)
npm run test:e2e         # Resets the local D1 database, then runs Playwright (dev servers started automatically)
npm run lint             # TypeScript and ESLint checks
npm run format           # Format src/, tests/, and e2e/ with Prettier
npm run db:generate      # Generate a migration from Drizzle schema changes
npm run db:migrate:local # Apply migrations to local D1
npm run db:seed:local    # Load realistic local demo data
npm run db:reset:local   # Wipe local D1, migrate, and reseed (used by test:e2e)
npm run deploy           # Build and deploy; does not apply remote migrations
```

## Deployment

1. Create the D1 database, R2 bucket, and inbound/outbound queues.
2. Replace the placeholder resource names in `wrangler.jsonc` if needed.
3. Set the production `APP_URL` in `wrangler.jsonc` and store secrets with `wrangler secret put SESSION_PEPPER`, `wrangler secret put RESEND_API_KEY`, `wrangler secret put RESEND_WEBHOOK_SECRET`, and (if the default `no-reply@<APP_URL host>` isn't right) set `SYSTEM_MAIL_FROM`.
4. Create the rate limit namespaces referenced by `wrangler.jsonc` (`AUTH_RATE_LIMIT` at `1001`, `WRITE_RATE_LIMIT` at `1002`) — Cloudflare provisions a rate limiting namespace the first time a Worker deploys with that binding, so no separate `wrangler` command is needed, but double-check both namespace IDs are free before reusing this config for a second Worker.
5. Run `npm run db:migrate:remote`.
6. Run `npm run deploy`.

Add each support address in **Settings → Support inboxes**, then route it to the deployed Worker with Cloudflare Email Routing. Raw RFC822 is streamed to an R2 staging key before a small pointer enters Queues, avoiding the 128 KB queue-message ceiling. Configure Resend to post webhooks to `/api/webhooks/resend`; signatures are verified before events are deduplicated. Set `DEV_MAIL_MODE=disabled` in production.

Create the two dead-letter queues referenced by `wrangler.jsonc`:

```bash
wrangler queues create resolvehq-inbound-mail-dlq
wrangler queues create resolvehq-outbound-mail-dlq
```

The authenticated API is also available under the versioned `/api/v1` prefix. List endpoints return `items`, `nextCursor`, and `hasMore`; legacy collection keys remain during the local pre-release period.

## Demo workspace

After loading the seed data:

```text
Email: owner@northstarlabs.test
Password: resolve-demo-2026
Inbox: support@northstarlabs.test
```

The seed password is only for local evaluation. Do not load `drizzle/seed.sql` into a real production database. The production login form never pre-fills these credentials.

## Public repository safety

- Keep `.dev.vars`, `.env`, Cloudflare credentials, API keys, webhook secrets, and production database identifiers out of version control. Only the example files belong in the repository.
- Generate a unique production `SESSION_PEPPER` with at least 32 random characters and add it with `wrangler secret put SESSION_PEPPER`.
- Store `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` with `wrangler secret put`; never place them in `wrangler.jsonc` or frontend environment variables.
- Replace the placeholder D1 database ID only in your deployment configuration and review it before publishing.
- Never apply `drizzle/seed.sql` to production. Create the production owner through the signup flow.
- Review the repository for generated agent, local browser, coverage, and test-output artifacts before each release; the supplied `.gitignore` excludes them.

Never commit `.dev.vars`, `.env` files, credentials, or account-specific secrets.
