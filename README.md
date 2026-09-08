# ResolveHQ

ResolveHQ is a Cloudflare-native, self-hostable helpdesk for small support teams.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mirza-rizvi/ResolveHQ)

## What you can do

- Run a shared inbox with tenant-isolated customers, tickets, assignment, status, priority, tags, and full-text search.
- Sign up as owner, invite teammates, and manage Owner/Admin/Agent roles with a workspace switcher across organizations.
- Thread email correctly per RFC 5322, resistant to subject-line spoofing across tickets.
- Receive mail through Cloudflare Email Routing and send it through Resend, with delivery status, retries, and idempotent webhooks. Outbound replies carry their linked attachments, and dead-letter queues drain to durable, recoverable records.
- Attach files to tickets through validated, authorized R2 uploads.
- Reply faster with saved replies, internal notes, AI-drafted responses (opt-in), and a responsive three-pane inbox with optimistic-version conflict handling.
- Reset passwords and accept invitations through system email sent via the same provider seam as ticket mail.
- Publish a public help center from knowledge-base articles, with drafts kept private to your team.
- Track volume and response speed in Reports, export any window to CSV, and automate triage with rule-based Automations.
- Notify agents of assignments and customer replies in-app, and work comfortably in light or dark mode.
- Export everything stored about a customer as JSON, or erase it with a durable, resumable workflow that cancels queued mail.
- Recover automatically: a five-minute cron job retries stalled mail jobs and cleans up staging and orphaned data.

## How it works

ResolveHQ runs as a single Cloudflare Worker in your own account. Hono serves both the REST API and the built React application. Cloudflare D1 holds tickets and customers, Cloudflare R2 holds attachments, and Cloudflare Queues carry inbound and outbound mail jobs. Cloudflare Email Routing delivers incoming mail to the Worker, and Resend sends outgoing mail. Tickets and attachments are stored in your Cloudflare account; outbound email content passes through Resend.

## How much does it cost?

ResolveHQ can run on Cloudflare’s Free plan for small deployments, provided usage stays within the current limits for Workers, D1, R2, Queues, Cron Triggers, and Email Routing. CPU-intensive authentication or mail parsing may require Workers Paid; benchmark your deployment. Queues are available on Workers Free. R2 requires account activation and billing setup separately. Resend handles outbound email under its own limits. See the [Free-plan audit](docs/cloudflare-free.md).

## Deploy

The easiest way to get started is with the **Deploy to Cloudflare** button above. You will need:

- A Cloudflare account; Workers Free supports Queues. Activate R2 separately.
- A domain on Cloudflare, so you can set up Email Routing.
- Optionally, a Resend account with a verified sending domain, to send outgoing mail.

After deployment, open your ResolveHQ URL and sign up as the owner, giving an optional support email that becomes your default inbox. In the Cloudflare dashboard, add an Email Routing rule sending that address to the deployed Worker, then send a test email to confirm it arrives in the inbox.

See the [deployment guide](docs/deployment.md) for what the deploy flow provisions, required configuration, first-run setup, and manual deployment.

## Local development

```bash
npm install
cp .dev.vars.local.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

The Vite application runs on `http://localhost:5173` and proxies `/api` to Wrangler on `http://localhost:8787`.

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [Security](SECURITY.md)

## Optional configuration

- **AI assistance**: set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4o-mini`) as Worker secrets to enable AI drafts, summaries, and classification in the composer. Without a key the feature stays hidden and no AI calls are made.

## Not yet implemented

- Multi-language interface and notifications outside the app (email digests).

## License

See [LICENSE](LICENSE).
