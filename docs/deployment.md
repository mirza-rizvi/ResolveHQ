# Deployment and configuration

This guide covers Cloudflare deployment, runtime configuration, first-run setup, the demo workspace, commands, and public repository safety.

## One-click deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mirza-rizvi/ResolveHQ)

The deployment flow reads `wrangler.jsonc` and provisions everything ResolveHQ needs:

- D1 database `resolvehq`
- R2 bucket `resolvehq-attachments`
- Queues `resolvehq-inbound-mail` and `resolvehq-outbound-mail`, plus their dead-letter queues
- Rate limit namespaces `1001` (auth, 10 requests/minute) and `1002` (writes, 120 requests/minute)
- A cron trigger that runs every 5 minutes

You will be prompted for the secrets listed in `.dev.vars.example`: `SESSION_PEPPER` is required (at least 32 random characters); `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SYSTEM_MAIL_FROM`, and `APP_URL` are optional. `DEV_MAIL_MODE` defaults to `disabled` in production (`capture` locally). D1 migrations are applied as part of `npm run deploy` (`wrangler d1 migrations apply DB --remote`, then `wrangler deploy`), which the deploy flow runs on your behalf.

## Required configuration

- `SESSION_PEPPER` is required. Generate at least 32 random characters.
- `APP_URL` is optional. When unset, ResolveHQ uses the request's own origin for CSRF validation, cookie security, and links in reset and invitation emails. Set it only if you serve the app behind a custom domain where the request origin would differ from the URL people should see (rare).
- `DEV_MAIL_MODE` defaults to `disabled` in production; set it to `capture` locally to record outgoing mail in Settings instead of sending it.
- `RESEND_API_KEY` is optional; required to actually send outbound mail.
- `RESEND_WEBHOOK_SECRET` is optional; required to verify Resend delivery webhooks.
- `SYSTEM_MAIL_FROM` is optional; it sets the sender used for password reset and invitation email.

## First-run setup

1. Open your deployed ResolveHQ URL and sign up: name, email, workspace, and an optional support email. The support email becomes your default inbox.
2. In the Cloudflare dashboard, go to Email Routing and add a rule sending your support address to the `resolvehq` Worker.
3. Send a test email to that address. It should appear in the inbox shortly after.
4. Replies go out through Resend once `RESEND_API_KEY` is set. Without it, outgoing messages show a Failed delivery badge with the reason on hover.

## Resend webhooks

Point Resend's webhooks at `https://<your-worker>/api/webhooks/resend` and set `RESEND_WEBHOOK_SECRET` so signatures can be verified.

## Manual deployment

```bash
wrangler login
npm install
npm run deploy
```

Wrangler provisions any resources declared in `wrangler.jsonc` that don't already exist on first deploy.

## Updating

```bash
git pull
npm run deploy
```

Migrations are idempotent, so re-running `deploy` on an already-migrated database is safe.

If you deploy a second copy of ResolveHQ into the same Cloudflare account, the rate limit namespace IDs must be unique per account. Change `1001` and `1002` in `wrangler.jsonc` before deploying the second copy.

## Demo workspace

After loading the seed data:

```text
Email: owner@northstarlabs.test
Password: resolve-demo-2026
Inbox: support@northstarlabs.test
```

This seed is for local evaluation only, and the seed password only works when `SESSION_PEPPER` is set to the example value in `.dev.vars.example`. Never load `drizzle/seed.sql` into a production database.

## Commands

```bash
npm run dev              # Vite and Wrangler together
npm run build            # Type-check and build the SPA
npm run test             # Business-critical tests (Workers pool)
npm run test:web         # React component tests (jsdom)
npm run test:e2e         # Resets the local D1 database, then runs Playwright
npm run lint              # TypeScript and ESLint checks
npm run format            # Format src/, tests/, and e2e/ with Prettier
npm run db:generate       # Generate a migration from Drizzle schema changes
npm run db:migrate:local  # Apply migrations to local D1
npm run db:migrate:remote # Apply migrations to remote D1
npm run db:seed:local     # Load realistic local demo data
npm run db:reset:local    # Wipe local D1, migrate, and reseed (used by test:e2e)
npm run deploy            # Apply remote D1 migrations, build, and deploy
```

## Public repository safety

- Keep `.dev.vars`, `.env`, Cloudflare credentials, API keys, webhook secrets, and production database identifiers out of version control. Only the example files belong in the repository.
- `wrangler.jsonc` does not store a production D1 database ID; Wrangler provisions the database on first deploy. Do not add a hardcoded database ID to a reusable or public copy of this repository.
- Generate a unique production `SESSION_PEPPER` with at least 32 random characters. For manual deployment, set it with `wrangler secret put SESSION_PEPPER`; the one-click flow prompts for it directly.
- Store `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` with `wrangler secret put`; never place them in `wrangler.jsonc` or frontend environment variables.
- Never apply `drizzle/seed.sql` to production. Create the production owner through the signup flow.
- Review the repository for generated agent, local browser, coverage, and test-output artifacts before each release; the supplied `.gitignore` excludes them.

Never commit `.dev.vars`, `.env` files, credentials, or account-specific secrets.
