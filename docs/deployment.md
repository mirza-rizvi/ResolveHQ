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

The flow reads the active entries in `.dev.vars.example`: supply a unique `SESSION_PEPPER` (at least 32 random characters) and keep `DEV_MAIL_MODE=disabled`. Configure optional `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SYSTEM_MAIL_FROM`, and `APP_URL` afterward in Worker secrets/settings; commented example entries are not configuration.

### Smoke-testing a deployment

Every automated gate in this repository runs against local `workerd`, which does not enforce some
limits the production runtime does. That gap has shipped two bugs: password derivation at 310,000
PBKDF2 iterations, which the runtime refuses above 100,000, and a database whose migrations were
never applied. Both passed every local test and broke every deployment.

```bash
npm run smoke -- https://<your-worker>            # worker responds, schema present, app shell served
npm run smoke -- https://<your-worker> --signup   # also exercises password hashing end to end
```

`--signup` creates one throwaway workspace, because signing up is the only request that derives a
password hash; a deployment can pass every read-only check and still be unable to create an account.
The script prints the `wrangler d1 execute` command that removes the workspace again. Run it after
the first deploy of a new environment and after any change to authentication.

### Sign-in and the CPU budget

Workers Free allows **10 ms of CPU per request**, and password hashing is the heaviest thing
ResolveHQ does in a request. Whether it fits has not been measured across accounts and hardware, so
treat it as the number to watch: check CPU time for a sign-in under your Worker's **Metrics**, and
move to Workers Paid if it runs over. An invocation that exceeds the limit is terminated and
reported as `exceededCpu`.

This is separate from the runtime's PBKDF2 ceiling. The runtime refuses more than 100,000 iterations
outright, with `Pbkdf2 failed: iteration counts above 100000 are not supported`; ResolveHQ derives at
exactly 100,000 since 0.3.2. **No plan raises that ceiling**, so upgrading is never the answer to
that particular error.

100,000 is the platform maximum, not a freely chosen work factor, and it sits below current OWASP
guidance for PBKDF2-SHA256. A 32-character-minimum `SESSION_PEPPER` mixed into every derivation and
rate-limited auth routes are what compensate. Do not lower it further.

### If the schema is missing

The deploy flow provisions the D1 database and normally applies the migrations with it. If it did
not, every request that touches a table fails and the app answers:

```json
{ "error": { "code": "database_not_migrated", "message": "The database schema is missing. Apply the migrations, then retry: npx wrangler d1 migrations apply DB --remote" } }
```

`GET /api/ready` answers the same question without a session, and needs no sign-in:

```bash
curl https://<your-worker>/api/ready
# {"ok":true,"database":"ready"}          ready to use
# {"ok":false,"database":"unmigrated"}    schema missing, with the count and the command
```

Fix it once, from a local checkout of the repository the button created on your account:

```bash
npx wrangler login          # if this machine is not already authenticated
npm run db:migrate:remote   # wrangler d1 migrations apply DB --remote
```

`DB` there is the binding name from `wrangler.jsonc`, which Wrangler resolves to the `resolvehq`
database; the npm script spells the whole command out if you would rather run it directly.

To stop this recurring on every future deploy, open the Worker in the Cloudflare dashboard and set
**Settings → Build → Deploy command** to `npm run deploy`. Workers Builds then applies migrations
before each deployment, the same way the GitHub Actions workflow in this repository does. Workers
Builds does not read build or deploy commands from `wrangler.jsonc`, so this has to be set in the
dashboard.

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
3. Open **/setup** (or **Settings → Setup & health**) and work through the checklist. It checks your deployment's configuration and looks up the MX, SPF, DKIM, and DMARC records of every domain your inboxes use, over DNS-over-HTTPS. Each row says what was found and what to change; nothing on the page blocks you from using ResolveHQ meanwhile.
4. Send a test email to that address. It should appear in the inbox shortly after.
5. Replies go out through Resend once `RESEND_API_KEY` is set. Without it, outgoing messages show a Failed delivery badge with the reason on hover.

## API keys

Admins create keys under **Settings → API keys**. A key is shown once, at creation, and only its
prefix is stored afterwards; if it is lost, revoke it and create another.

Keys authenticate the versioned surface only:

```bash
curl -H "Authorization: Bearer rhq_live_…" https://<your-worker>/api/v1/tickets
```

`/api/*` — the surface the browser app uses — stays session-only. A request carrying both a session
cookie and a bearer token is refused rather than silently preferring one.

Scopes are coarse: `tickets:read`, `tickets:write`, `customers:read`, `customers:write`, `kb:read`,
`reports:read`, and `mcp:read`. Anything outside that list is unreachable with a key at all, which
includes the assistant, privacy, automations, and workspace-administration endpoints.

**A key can never do more than the person who created it.** The creating member's role is re-read on
every request and intersected with the key's scopes, so demoting them from admin to agent
immediately removes the admin-only powers from every key they issued — no re-issue needed. If that
member is removed or disabled, their keys stop working and are shown as inactive in the list.

Keys may optionally expire, and may be restricted to particular inboxes; a restricted key sees no
tickets outside them, and reports a ticket it may not see as missing rather than forbidden.

## Outbound webhooks

Admins add endpoints under **Settings → Webhooks**, choosing which of six events to send: a ticket
opened, assigned, changed status, or missed its response target; a customer replied; a customer rated
their support.

**What a payload contains is a deliberate decision: ids, numbers, statuses and names — never message
text, never a customer's email address, never the subject of a private note.** A consumer that needs
the conversation reads it back through `/api/v1` with a scoped key, where the workspace's own
permissions apply.

Deliveries go out immediately and failures are retried by the existing five-minute cron with
backoff (15s, 1m, 5m, 30m, 2h) up to six attempts. **No Cloudflare Queue is used** — the Free plan's
10,000 daily operations are reserved for mail. An endpoint that fails ten times in a row turns itself
off and says so in the list, with a Re-enable button.

### Verifying a signature

Endpoints of kind "My own service" receive a signature header; Slack and Telegram authenticate with
their own secret URL or bot token instead. The signing secret is shown once, when you create the
endpoint.

```
X-ResolveHQ-Signature: t=1788870600,v1=<base64url HMAC-SHA256>
X-ResolveHQ-Event: ticket.created
```

The signed value is `"<t>.<raw request body>"`, keyed with your endpoint secret. In Node:

```js
import { createHmac } from "node:crypto";

function verify(secret, header, rawBody) {
  const [timestampPart, signaturePart] = header.split(",");
  const timestamp = timestampPart.slice(2);
  const provided = signaturePart.slice(3);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("base64url");
  // Reject anything older than five minutes to stop a captured request being replayed.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  return provided === expected;
}
```

Verify against the **raw** body, before parsing it: re-serialising JSON changes the bytes and the
signature will not match.

### What ResolveHQ refuses to send to

Destinations are validated when you save them **and again immediately before every send**, because
DNS can change in between. Private, loopback, carrier-grade-NAT and internal addresses are refused,
as are bare hostnames, addresses pointing back at your own deployment, and link-local metadata
addresses such as `169.254.169.254`. Redirects are not followed, the request times out after ten
seconds, and only the response status is read.

## Connecting an AI assistant (MCP)

ResolveHQ speaks the Model Context Protocol at `POST /api/mcp`, so Claude Code, Claude Desktop, or
Cursor can look things up in your helpdesk directly.

**It is read-only.** The five tools — `search_tickets`, `get_ticket`, `list_queues`, `get_customer`,
`search_knowledge_base` — can search and read, and there is no tool that replies, assigns, or
changes anything. Write tools need a human approval screen, which is planned for a later release.

Create an API key with the **Connect an AI assistant (MCP)** permission, then open
**Settings → AI assistants (MCP)**, paste the key, and copy the snippet for your client. For Claude
Code that is:

```bash
claude mcp add resolvehq --transport http https://<your-worker>/api/mcp \
  --header "Authorization: Bearer rhq_live_…"
```

The workspace always comes from the key: no tool accepts an organization id, and a key restricted to
particular inboxes sees nothing outside them. Long message threads and article bodies are truncated,
and the response says when that happened.

### Rotating `SESSION_PEPPER`

`SESSION_PEPPER` signs sessions, the optional signed reply address, and satisfaction rating links. Changing it signs everyone out **and** invalidates any rating link already sitting in a customer's inbox — those customers see "this rating link is no longer available" rather than an error. This is deliberate: a second secret would be one more thing to get wrong, and the consequence of a rotation is limited to unanswered surveys.

The readiness checks need no API token: they use the public `cloudflare-dns.com` resolver, so they work on a fresh deployment with nothing else configured. Results are cached per workspace for ten minutes; **Re-check** bypasses the cache. A DMARC record is reported as optional, and a resolver that cannot be reached is reported as unknown rather than as a missing record.

## Workspace backups

**Settings → Workspace export** writes every table in your workspace to newline-delimited JSON in
the R2 bucket you already use for attachments, under `_backups/<organization-id>/<backup-id>/`. One
file per table, downloadable from the same page. No new binding and no extra setup.

An export runs in the background: each cron tick writes another bounded slice and remembers where it
got to, so a large workspace finishes across several ticks rather than timing out. One export at a
time per workspace, one per day. Turn on the weekly schedule and set how long exports are kept
(30 days by default) on the same page.

What is **not** in an export: attachment files (their database records are included), session and
password-reset rows, API key hashes, webhook signing secrets and bot tokens, and passwords. It is a
point-in-time-ish copy — rows written after the export starts may not be included.

### Restoring

There is deliberately no restore button. A restore that half-applies, leaving foreign keys pointing
at rows that no longer exist, is worse than no button at all. Restore is a deliberate operation:

```bash
# 1. Download the tables you need from Settings → Workspace export.
# 2. Turn each NDJSON line into an INSERT against a scratch database first, and check it.
npx wrangler d1 execute DB --remote --file=./restore.sql
```

Load tables in the order the export lists them — `organizations`, `users`, memberships, inboxes,
customers, tickets, then messages and everything that references them — so foreign keys resolve.
Test the whole thing against a local database (`--local`) before you point it at production.

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

### Upgrading to 0.3.0 (migrations 0009 to 0014)

Six migrations land together if you are coming from 0.2.0. All are additive — new tables and new
nullable columns — and nothing in them rewrites or deletes an existing row, so the usual
`wrangler d1 migrations apply DB --remote` before deploying is enough. Three things to know
afterwards:

- **Nothing is tracked until you configure it.** With no SLA policy, no ticket is ever marked late;
  satisfaction ratings stay off until an admin turns them on; no webhook is sent until an endpoint
  exists.
- **The cron does more per tick.** Response-target promotion, snooze wake-ups, webhook retries and
  workspace exports all run in the same five-minute handler, each bounded. No new binding and no new
  queue is required.
- **R2 gains a second consumer.** Workspace exports are written to the attachments bucket under
  `_backups/`. They count against the same storage allowance; the retention window (30 days by
  default) is what controls how much they accumulate.

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
npm run smoke -- <url>    # Smoke-test a real deployment (add --signup to test auth)
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
