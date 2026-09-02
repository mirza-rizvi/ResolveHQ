# ResolveHQ

ResolveHQ is a Cloudflare-native, self-hostable helpdesk for small support teams.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mirza-rizvi/ResolveHQ)

## What you can do

- Run a shared inbox with tenant-isolated customers, tickets, assignment, status, priority, tags, and full-text search.
- Sign up as owner, invite teammates, and manage Owner/Admin/Agent roles with a workspace switcher across organizations.
- Thread email correctly per RFC 5322, resistant to subject-line spoofing across tickets.
- Receive mail through Cloudflare Email Routing and send it through Resend, with delivery status, retries, and idempotent webhooks.
- Attach files to tickets through validated, authorized R2 uploads.
- Reply faster with saved replies, internal notes, and a responsive three-pane inbox with optimistic-version conflict handling.
- Reset passwords and accept invitations through system email sent via the same provider seam as ticket mail.
- Recover automatically: a five-minute cron job retries stalled mail jobs and cleans up staging and orphaned data.

## How it works

ResolveHQ runs as a single Cloudflare Worker in your own account. Hono serves both the REST API and the built React application. Cloudflare D1 holds tickets and customers, Cloudflare R2 holds attachments, and Cloudflare Queues carry inbound and outbound mail jobs. Cloudflare Email Routing delivers incoming mail to the Worker, and Resend sends outgoing mail. All of your data stays in your own Cloudflare account.

## How much does it cost?

D1 and R2 free tiers are ample for a small team, and Cloudflare Email Routing is free. Cloudflare Queues require a Workers Paid plan ($5/month), so ResolveHQ needs Workers Paid regardless of traffic. Resend's free tier covers up to 3,000 emails a month for outbound mail.

## Deploy

The easiest way to get started is with the **Deploy to Cloudflare** button above. You will need:

- A Cloudflare account on the Workers Paid plan (required for Queues).
- A domain on Cloudflare, so you can set up Email Routing.
- Optionally, a Resend account with a verified sending domain, to send outgoing mail.

After deployment, open your ResolveHQ URL and sign up as the owner, giving an optional support email that becomes your default inbox. In the Cloudflare dashboard, add an Email Routing rule sending that address to the deployed Worker, then send a test email to confirm it arrives in the inbox.

See the [deployment guide](docs/deployment.md) for what the deploy flow provisions, required configuration, first-run setup, and manual deployment.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

The Vite application runs on `http://localhost:5173` and proxies `/api` to Wrangler on `http://localhost:8787`.

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [Security](SECURITY.md)

## Not yet implemented

- Dead-letter queue consumers: the DLQs exist and receive exhausted retries, but nothing drains them yet.
- AI provider wiring: the `AIProvider` seam exists; the default implementation reports AI as unavailable.
- Attachments inside outbound email: attachments are stored and linked to messages, but not attached to the outgoing email itself.
- Pagination / load-more UI: the API is cursor-paginated; the UI does not yet expose loading further pages.
- Notifications UI: notification rows are written; there is no bell or notification center.
- Dark mode.
- Team membership editing.
- Entity deletion / GDPR export or erasure.
- Knowledge Base, Reports, and Automations.

## License

See [LICENSE](LICENSE).
