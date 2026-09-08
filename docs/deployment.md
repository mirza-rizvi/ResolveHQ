# Deployment and configuration

This guide covers Cloudflare deployment, runtime configuration, first-run setup, the demo workspace, commands, and public repository safety.

## One-click deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mirza-rizvi/ResolveHQ)

The deployment flow reads `wrangler.jsonc` and provisions everything ResolveHQ needs:

- D1 database `resolvehq`
- R2 bucket `resolvehq-attachments`
- Queues `resolvehq-inbound-mail`, `resolvehq-outbound-mail`, and `resolvehq-maintenance`, plus their dead-letter queues and their drain consumers
- Rate limit namespaces `1001` (auth, 10 requests/minute) and `1002` (writes, 120 requests/minute)
- A cron trigger that runs every 5 minutes

The flow reads the active entries in `.dev.vars.example`: supply a unique `SESSION_PEPPER` (at least 32 random characters) and keep `DEV_MAIL_MODE=disabled`. Configure optional `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SYSTEM_MAIL_FROM`, and `APP_URL` afterward in Worker secrets/settings; commented example entries are not configuration. D1 migrations are applied as part of `npm run deploy` (`wrangler d1 migrations apply DB --remote`, then `wrangler deploy`), which the deploy flow runs on your behalf.

For AI assistance, add `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4o-mini`) as Worker secrets. A key only makes the feature available: each workspace opts in through Settings → AI assistance, which discloses that ticket conversations are sent to OpenAI. Without a key the AI controls stay hidden and the Worker makes no AI requests.

Workers Free is supported subject to CPU and service quotas; a successful deployment alone does not prove that authentication or MIME parsing fits the Free CPU allowance. Queues are available on Free. Activate R2 in the Cloudflare dashboard and complete its subscription checkout separately; this does not require Workers Paid. See the [audit, limits, and recovery guide](cloudflare-free.md).

## Required configuration

- `SESSION_PEPPER` is required. Generate at least 32 random characters.
- `APP_URL` is optional. When unset, ResolveHQ uses the request's own origin for CSRF validation, cookie security, and links in reset and invitation emails. Set it only if you serve the app behind a custom domain where the request origin would differ from the URL people should see (rare).
- `DEV_MAIL_MODE` defaults to `disabled` in production; set it to `capture` locally to record outgoing mail in Settings instead of sending it.
- `RESEND_API_KEY` is optional; required to actually send outbound mail.
- `RESEND_WEBHOOK_SECRET` is optional; required to verify Resend delivery webhooks.
- `SYSTEM_MAIL_FROM` sets the sender used for password reset and invitation email. For production, use an address on a Resend-verified domain; the default workers.dev sender usually cannot send through Resend.
- `TICKET_RETENTION_DAYS` is optional. Set a whole number of days (1–3650) and the 5-minute cron permanently deletes resolved and closed tickets whose last activity is older, including their attachments and in-flight mail. Unset keeps everything until you erase it manually.

## First-run setup

1. Open your deployed ResolveHQ URL and sign up: name, email, workspace, and an optional support email. The support email becomes your default inbox.
2. In the Cloudflare dashboard, go to Email Routing and add a rule sending your support address to the `resolvehq` Worker.
3. Send a test email to that address. It should appear in the inbox shortly after.
4. Replies go out through Resend once `RESEND_API_KEY` is set. Without it, outgoing messages show a Failed delivery badge with the reason on hover.

## Resend webhooks

Point Resend's webhooks at `https://<your-worker>/api/webhooks/resend` and set `RESEND_WEBHOOK_SECRET` so signatures can be verified.

## Manual deployment

```bash
git clone https://github.com/mirza-rizvi/ResolveHQ.git
cd ResolveHQ
npm install
npx wrangler login

# Create D1 BEFORE deploy runs migrations. No account ID needs to be committed.
npx wrangler d1 create resolvehq --update-config=false

# Generate a unique pepper, then paste it at the secret prompt. Save it securely.
openssl rand -hex 32
npx wrangler secret put SESSION_PEPPER
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SYSTEM_MAIL_FROM
# Optional, after configuring a Resend webhook:
npx wrangler secret put RESEND_WEBHOOK_SECRET

npm run cloudflare:check
npm run deploy
```

Before running these commands, activate R2 and verify your sender domain in Resend. Secret creation may prompt to create the named Worker on a new account; accept that prompt. Wrangler 4.127.1 or newer resolves the pre-created D1 database by its configured name and provisions the R2 bucket and Queues during deploy. The one-click flow provisions D1 before its deploy command; the manual flow must create it explicitly because migrations run before `wrangler deploy`. Existing installations should reuse their configured D1 binding, never create a replacement database.

After deployment, complete First-run setup above. Keep R2 public access and r2.dev access disabled. No production account changes are made by `cloudflare:check`; it only validates local configuration.

## Updating

```bash
git pull
npm run deploy
```

Migrations are idempotent, so re-running `deploy` on an already-migrated database is safe.

If you deploy a second copy of ResolveHQ into the same Cloudflare account, the rate limit namespace IDs must be unique per account. Change `1001` and `1002` in `wrangler.jsonc` before deploying the second copy.

## Upgrade notes

Apply the additive migrations before deploying this Worker. Password and session formats, existing R2 keys, API defaults, and mail queue names remain supported. Do not rotate `SESSION_PEPPER`: existing password hashes depend on it. This release adds a maintenance queue and its DLQ.

Previously attempted failed/stalled outbound jobs are conservatively stopped for administrator review because their provider idempotency age is unknown. Review **Settings → Stopped mail** after upgrading. Do not leave old and new Worker versions processing mail concurrently for an extended rollout: older versions do not honor the new retry leases and terminal states. Preserve any existing paid-plan configuration; no Free-specific CPU cap is added.

For local development, copy `.dev.vars.local.example` to `.dev.vars`. The production example deliberately uses `DEV_MAIL_MODE=disabled` and omits the localhost origin so one-click deployment cannot accidentally capture production mail.

## Demo workspace

After loading the seed data:

```text
Email: owner@northstarlabs.test
Password: resolve-demo-2026
Inbox: support@northstarlabs.test
```

This seed is for local evaluation only, and the seed password only works when `SESSION_PEPPER` is set to the example value in `.dev.vars.local.example`. Never load `drizzle/seed.sql` into a production database.

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
npm run cloudflare:check  # Offline configuration checks and limitations
npm run auth:benchmark    # Synthetic local elapsed-time benchmark; not production CPU
npm run deploy           # Check, build, apply remote D1 migrations, deploy
```

## Public repository safety

- Keep `.dev.vars`, `.env`, Cloudflare credentials, API keys, webhook secrets, and production database identifiers out of version control. Only the example files belong in the repository.
- `wrangler.jsonc` does not store a production D1 database ID; manual setup creates it by name before migrations. Do not add a hardcoded database ID to a reusable or public copy of this repository.
- Generate a unique production `SESSION_PEPPER` with at least 32 random characters. For manual deployment, set it with `wrangler secret put SESSION_PEPPER`; the one-click flow prompts for it directly.
- Store `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` with `wrangler secret put`; never place them in `wrangler.jsonc` or frontend environment variables.
- Never apply `drizzle/seed.sql` to production. Create the production owner through the signup flow.
- Review the repository for generated agent, local browser, coverage, and test-output artifacts before each release; the supplied `.gitignore` excludes them.

Never commit `.dev.vars`, `.env` files, credentials, or account-specific secrets.
