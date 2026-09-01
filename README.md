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
- Cloudflare Email Routing ingestion through an idempotent queue consumer
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
3. Set the production `APP_URL` in `wrangler.jsonc` and store `SESSION_PEPPER` with `wrangler secret put SESSION_PEPPER`.
4. Run `npm run db:migrate:remote`.
5. Run `npm run deploy`.

Route the organization support address to the deployed Worker with Cloudflare Email Routing. The inbound consumer matches the envelope recipient against `organizations.support_email`, then creates or updates the correct tenant ticket. `DEV_MAIL_MODE=capture` marks outbound replies as captured in development. Before production email delivery, add an `OutgoingMailProvider` adapter for Resend, Postmark, Mailgun, SES, SMTP, or another provider and set `DEV_MAIL_MODE=disabled`.

## Demo workspace

After loading the seed data:

```text
Email: owner@northstarlabs.test
Password: resolve-demo-2026
Inbox: support@northstarlabs.test
```

The seed password is only for local evaluation. Do not load `drizzle/seed.sql` into a real production database.

Never commit `.dev.vars`, `.env` files, credentials, or account-specific secrets.
