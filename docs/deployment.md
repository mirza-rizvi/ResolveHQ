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

AI assistance supports two providers. Cloudflare Workers AI is preferred when its binding exists: uncomment the `ai` block in `wrangler.jsonc` and redeploy; no credential is required, `WORKERS_AI_MODEL` overrides the text model (default `@cf/meta/llama-4-scout-17b-16e-instruct`) and `AI_GATEWAY_ID` routes the calls through an AI Gateway. Otherwise add `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4o-mini`) as Worker secrets. The binding wins whenever both are present. The block ships commented out because, once it is present, the local dev server opens a remote proxy for Workers AI and refuses to start without `wrangler login` or `CLOUDFLARE_API_TOKEN`.

A configured provider only makes the feature available: each workspace opts in through Settings → AI assistance, which names the provider the conversations are sent to. With no provider the AI controls stay hidden and the Worker makes no AI requests. Translation (composer drafts and single messages) follows the same opt-in.

Workers Free is supported subject to CPU and service quotas; a successful deployment alone does not prove that authentication or MIME parsing fits the Free CPU allowance. Queues are available on Free. Activate R2 in the Cloudflare dashboard and complete its subscription checkout separately; this does not require Workers Paid. See the [audit, limits, and recovery guide](cloudflare-free.md).

## Required configuration

- `SESSION_PEPPER` is required. Generate at least 32 random characters.
- `APP_URL` is optional. When unset, ResolveHQ uses the request's own origin for CSRF validation, cookie security, and links in reset and invitation emails. Set it only if you serve the app behind a custom domain where the request origin would differ from the URL people should see (rare).
- `DEV_MAIL_MODE` defaults to `disabled` in production; set it to `capture` locally to record outgoing mail in Settings instead of sending it.
- `RESEND_API_KEY` is optional; required to actually send outbound mail.
- `RESEND_WEBHOOK_SECRET` is optional; required to verify Resend delivery webhooks.
- `EMAIL` is an optional `send_email` binding for native Cloudflare Email Sending. When bound it replaces Resend for all outgoing mail; see the section below. It requires Workers Paid and stays commented out in `wrangler.jsonc`.
- `SYSTEM_MAIL_FROM` sets the sender used for password reset and invitation email. For production, use an address on a Resend-verified domain; the default workers.dev sender usually cannot send through Resend.
- `TICKET_RETENTION_DAYS` is optional. Set a whole number of days (1–3650) and the 5-minute cron permanently deletes resolved and closed tickets whose last activity is older, including their attachments and in-flight mail. Unset keeps everything until you erase it manually.

## Optional: Cloudflare Turnstile

Add a Turnstile challenge to sign-in, sign-up, and forgot-password with no code changes:

1. In the Cloudflare dashboard, create a Turnstile widget of type **Managed** for your domain.
2. Set `TURNSTILE_SITE_KEY` as a Worker variable (in `wrangler.jsonc` or the dashboard) — it is public and safe to expose to the browser.
3. Set `TURNSTILE_SECRET_KEY` as a Worker secret: `npx wrangler secret put TURNSTILE_SECRET_KEY`.

Both must be set together: the server only exposes the site key from `GET /api/auth/config` and only verifies a token once `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are both configured, so a half-configured deploy (only one of the two) leaves the feature fully off rather than showing a widget nobody checks or rejecting sign-ins with no widget to satisfy them. Once both are set, the widget appears on the three auth forms and the server rejects a submission with an invalid or missing token before it does any password hashing.

## First-run setup

1. Open your deployed ResolveHQ URL and sign up: name, email, workspace, and an optional support email. The support email becomes your default inbox.
2. In the Cloudflare dashboard, go to Email Routing and add a rule sending your support address to the `resolvehq` Worker.
3. Send a test email to that address. It should appear in the inbox shortly after.
4. Replies go out through Resend once `RESEND_API_KEY` is set. Without it, outgoing messages show a Failed delivery badge with the reason on hover.

## Resend webhooks

Point Resend's webhooks at `https://<your-worker>/api/webhooks/resend` and set `RESEND_WEBHOOK_SECRET` so signatures can be verified.

## Native Cloudflare email (optional, Workers Paid)

Outgoing mail goes through Resend by default. Cloudflare Email Sending can send it from your own
account instead, with no third-party key. It is in beta, it needs Workers Paid, and its delivery
events arrive on a Queues event subscription rather than a webhook. Neither the binding nor the
subscription can be provisioned by the Deploy button, so both ship commented out in `wrangler.jsonc`
and a deploy that does not want them is unaffected.

1. Enable Email Sending on the zone you send from (Cloudflare dashboard, your domain, Email) and
   verify the sending domain.
2. Uncomment the `send_email` block in `wrangler.jsonc`:

   ```jsonc
   "send_email": [{ "name": "EMAIL" }],
   ```

3. Create the delivery-event queues:

   ```bash
   npx wrangler queues create resolvehq-email-events
   npx wrangler queues create resolvehq-email-events-dlq
   ```

4. Subscribe the queue to the sending events:

   ```bash
   npx wrangler queues subscription create resolvehq-email-events \
     --source email.sending \
     --events delivered,bounced,failed,rejected,complained,deferred
   ```

5. Uncomment the two `resolvehq-email-events` consumer blocks in `wrangler.jsonc`.
6. Redeploy with `npm run deploy`.

Once `EMAIL` is bound the Worker sends every outgoing message through it and ignores
`RESEND_API_KEY`. **Settings, Mail delivery** names the provider that is actually in use. Set
`EMAIL_EVENTS_QUEUE_NAME` only if you name the queue something other than `resolvehq-email-events`.

Two things behave differently from Resend:

- **No idempotency key, and no Message-ID of your own.** Cloudflare assigns the Message-ID and has no
  way to collapse a repeated send, so a resend is a second email in the customer's mailbox. ResolveHQ
  records an attempt marker before it calls the binding and never sends that job again on its own: a
  send that was never confirmed stops in **Settings, Stopped mail** and goes out again only when an
  administrator accepts the duplicate risk. Replies still thread, because the id the binding returns is
  stored as the message's provider id and matched against the `References` header of incoming mail.
- **Receiving is still Email Routing.** Email Sending only sends. Keep the routing rule that forwards
  your support address to the Worker, and add a catch-all rule for the sending domain if you enable
  `OUTBOUND_REPLY_TOKEN`, or tagged replies never reach the Worker.

`npm run cloudflare:check` validates the binding name, the dead-letter queue, and this documented
subscription step once the blocks are uncommented; while they are commented it prints an information
line and stays green.

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

`npm run build` runs Vite with `@cloudflare/vite-plugin`, which writes the client bundle to
`dist/client`, the bundled Worker to `dist/resolvehq/index.js`, and a generated
`dist/resolvehq/wrangler.json` that merges `wrangler.jsonc` with the built asset directory. It also
writes `.wrangler/deploy/config.json`, so a plain `wrangler deploy` from the repository root picks
up the generated config automatically — the `assets.directory` field is therefore absent from
`wrangler.jsonc` on purpose. Deploy only after a build; `wrangler deploy` on its own does not
rebuild.

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

### Case-only duplicate addresses (migrations 0006 and 0007)

Inbox addresses and customer emails were stored case-sensitively before this release, so a database
can hold `Support@acme.test` and `support@acme.test` as two rows. Both migrations resolve this
deterministically, but inspect the duplicates first — the outcome is not reversible by re-running the
migration.

```sql
-- Inboxes that will be affected by 0006
SELECT lower(email_address), count(*) FROM inboxes WHERE disabled_at IS NULL GROUP BY 1 HAVING count(*) > 1;
-- Customers that will be affected by 0007
SELECT organization_id, lower(email), count(*) FROM customers GROUP BY 1, 2 HAVING count(*) > 1;
```

**Inboxes (0006).** The oldest live inbox per lower-cased address keeps the address; every other live
duplicate is disabled (`disabled_at` set) before the unique index is created, so the migration cannot
abort. Mail for that address then routes to the surviving inbox. If the wrong one survived, re-enable
the inbox you want in **Settings → Support inboxes** after disabling the other.

**Customers (0007).** The oldest customer per `(organization_id, lower(email))` receives the backfilled
primary identity. The newer duplicate keeps its tickets and stays visible in the Customers list, but
it holds no identity, so new mail from that address attaches to the older record. Fold the pair with
**Customers → Merge into…** (admin only) after upgrading; the merge moves tickets, messages, tags and
identities and deletes the duplicate profile. Nothing is merged automatically.

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
npm run dev              # Single Vite dev server on :5173 (SPA + Worker, one origin)
npm run preview          # Serve the build output in the Workers runtime on :4173
npm run build            # Type-check and build the SPA
npm run typecheck        # Type-check only (tsc -b)
npm run test             # Business-critical tests (Workers pool)
npm run test:web         # React component tests (jsdom)
npm run test:e2e         # Resets the local D1 database, then runs Playwright (chromium project)
npm run screenshots      # Resets the local D1 database, then regenerates docs/images PNGs
npm run lint              # ESLint checks
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

## Continuous deployment (optional)

`.github/workflows/deploy.yml` can deploy on every push to `dev` (or on demand via
"Run workflow"), using [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action).
It is inert until you add repository secrets: with none set, the workflow's deploy job is
skipped outright, so cloning or forking the repository does not require touching this file.

Add these under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` (required to enable the workflow) — a Cloudflare API token scoped to:
  - Workers Scripts: Edit
  - D1: Edit
  - Queues: Edit
  - R2 Storage: Edit
  - Account Settings: Read
  - Email Routing: Edit — only if you use native Cloudflare email sending (see above); not needed for Resend
  - Workers AI: Read is not required for deployment
- `CLOUDFLARE_ACCOUNT_ID` (required to enable the workflow) — your Cloudflare account ID.

Worker secrets, including `SESSION_PEPPER`, are set once, out of band — with
`npx wrangler secret put SESSION_PEPPER` locally or from the Cloudflare dashboard — and the
workflow never touches them.

The workflow runs `npm run cloudflare:check`, builds, applies pending D1 migrations
(`wrangler d1 migrations apply DB --remote`), then runs `wrangler deploy`. It does not create D1,
R2, or Queues resources — those must already exist (the one-click flow or manual setup above
provisions them).

The [Deploy to Cloudflare button](#one-click-deployment) remains the recommended path for a first
deployment. This workflow is for redeploying an already-provisioned installation on every push,
not for initial setup.

## Public repository safety

- Keep `.dev.vars`, `.env`, Cloudflare credentials, API keys, webhook secrets, and production database identifiers out of version control. Only the example files belong in the repository.
- `wrangler.jsonc` does not store a production D1 database ID; manual setup creates it by name before migrations. Do not add a hardcoded database ID to a reusable or public copy of this repository.
- Generate a unique production `SESSION_PEPPER` with at least 32 random characters. For manual deployment, set it with `wrangler secret put SESSION_PEPPER`; the one-click flow prompts for it directly.
- Store `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` with `wrangler secret put`; never place them in `wrangler.jsonc` or frontend environment variables.
- Never apply `drizzle/seed.sql` to production. Create the production owner through the signup flow.
- Review the repository for generated agent, local browser, coverage, and test-output artifacts before each release; the supplied `.gitignore` excludes them.

Never commit `.dev.vars`, `.env` files, credentials, or account-specific secrets.
