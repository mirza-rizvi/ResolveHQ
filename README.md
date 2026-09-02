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

- Owner signup, secure sessions, organization creation, invitations, and Owner/Admin/Agent roles
- Tenant-isolated customers, customer history, tickets, assignment, status, priority, tags, search, replies, and internal notes
- Authorized R2 attachments with size, MIME, signature, and ownership checks
- Saved replies and a responsive three-pane inbox with a focused mobile conversation flow
- Cloudflare Email Routing ingestion through R2 staging and an idempotent, checkpointed queue consumer
- Cursor pagination, D1 FTS5 search, unread state, drafts, saved views, teams, bulk actions, and optimistic ticket versions
- Resend delivery with an outbox, idempotency keys, signed webhooks, retries, reconciliation, and dead-letter queues
- Provider seams for outgoing mail, object storage, and optional AI
- Dashboard, team management, activity logging, realistic seed data, and honest placeholders for future product areas

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
npm run test             # Business-critical tests
npm run test:e2e         # Browser flow and responsive assertions (dev servers required)
npm run lint             # TypeScript and ESLint checks
npm run db:generate      # Generate a migration from Drizzle schema changes
npm run db:migrate:local # Apply migrations to local D1
npm run db:seed:local    # Load realistic local demo data
npm run deploy           # Build and deploy; does not apply remote migrations
```

## Deployment

1. Create the D1 database, R2 bucket, and inbound/outbound queues.
2. Replace the placeholder resource names in `wrangler.jsonc` if needed.
3. Set the production `APP_URL` in `wrangler.jsonc` and store secrets with `wrangler secret put SESSION_PEPPER`, `wrangler secret put RESEND_API_KEY`, and `wrangler secret put RESEND_WEBHOOK_SECRET`.
4. Run `npm run db:migrate:remote`.
5. Run `npm run deploy`.

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
