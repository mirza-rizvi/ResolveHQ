# Changelog

All notable changes to ResolveHQ are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- Applied the open Dependabot updates: Hono, Zod, Tiptap, React 19.3, Playwright, and TypeScript ESLint bumped to their latest minor/patch; `@testing-library/jest-dom` to 7.0.1; `lucide-react` to 1.x (major, icon names unchanged); ESLint to 10 with `eslint-plugin-react-hooks` 7 (adds React Compiler lint rules; `set-state-in-effect` and `refs` kept at warn pending a follow-up cleanup pass); GitHub Actions `actions/checkout`/`actions/setup-node` to v7 and `cloudflare/wrangler-action` to v4 (Wrangler version pin unchanged).

## [0.2.0] - 2026-09-14

### Added
- Screenshots of the inbox, ticket thread, dashboard, reports, knowledge base, automations, customers, settings, help center, dark mode, and mobile layout in `docs/images/`, shown in the README. `npm run screenshots` regenerates them from the demo seed.
- Customer identities: one customer can have several email addresses. Add or remove addresses on the customer record; admins can merge two customers, which moves tickets, messages, tags, and addresses onto the surviving record.
- Optional Cloudflare Email Sending provider. When the `EMAIL` (`send_email`) binding is present, outgoing mail goes through Cloudflare instead of Resend, and delivery events arrive on the `resolvehq-email-events` queue. Workers Paid plan; setup steps in `docs/deployment.md`.
- Optional Workers AI provider. When the `AI` binding is present it is used for summaries, drafts, classification, and translation instead of OpenAI. `WORKERS_AI_MODEL` and `AI_GATEWAY_ID` are supported.
- Translation of customer messages and of your draft reply (`POST /api/assistant/translate`), with a target language and optional source language. Available with either AI provider once a workspace enables AI assistance.
- Optional Cloudflare Turnstile on sign-up, sign-in, and password reset. Active only when both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set.
- Optional signed reply address. With `OUTBOUND_REPLY_TOKEN=enabled`, replies carry a `Reply-To` of the form `support+t<ticket>.<signature>@…` so a customer reply threads even when their mail system strips the `References` headers. Requires an Email Routing catch-all rule.
- GitHub Actions deploy workflow (`.github/workflows/deploy.yml`) using `cloudflare/wrangler-action`. Runs only when `CLOUDFLARE_API_TOKEN` is configured as a repository secret.
- A fuller demo workspace in `drizzle/seed.sql`: nine tickets across every status, knowledge-base articles, automation rules, notifications, and a saved view.

### Changed
- Email threading now works across all inboxes of a workspace and across all addresses of a customer. Header matching (`In-Reply-To`, `References`) and the signed reply address accept mail from any of the customer's known addresses, including a `Reply-To` that differs from `From`. The `[#1234]` subject fallback still requires the original sender address. A reply that matches nothing opens a new ticket; it never lands on another customer's ticket.
- Plus-addressed recipients (`support+anything@example.com`) resolve to the `support@example.com` inbox.
- Local development runs on one server: `npm run dev` starts Vite with `@cloudflare/vite-plugin`, serving the app and the Worker on `http://localhost:5173`. `vite preview` runs the production build in the Workers runtime. The `concurrently` dependency and the per-file `alias` map in `wrangler.jsonc` are gone; Wrangler is now `^4.131.1`.
- `npm run test:e2e` runs only the `chromium` project so it no longer rewrites the committed screenshots.
- The Resend webhook and the Cloudflare event consumer share one delivery-state routine (`applyDeliveryEvent`). Behaviour of the Resend webhook is unchanged.
- The `ai` and `send_email` blocks in `wrangler.jsonc` ship commented out. With the `ai` binding present, `wrangler dev` needs `wrangler login` or `CLOUDFLARE_API_TOKEN` because Workers AI has no local simulator.

### Fixed
- Inbound mail could be attached to another workspace's inbox when two workspaces used the same support address in different letter case. Inbox resolution is now scoped to the owning workspace, and inbox addresses are unique case-insensitively (migration 0006 retires newer case-only duplicates; see the upgrade notes).
- `wrangler dev` failed to start because `wrangler.jsonc` was missing an alias for the organization settings module.
- Incoming email staging in local development failed at the R2 upload; the raw message is now written through a fixed-length stream.
- Sending through a provider without an idempotency key could, after a crash, resend the same message. Outbound jobs record when a send was handed to the provider and stop as "delivery uncertain" instead of retrying; an administrator can resend after acknowledging the duplicate risk.
- Translations of long text no longer cut words in half or insert paragraph breaks; a truncated model response fails the request rather than replacing the draft.

### Migrations
- `0006_inbox_tenant_scope`, `0007_customer_identities`, `0008_outbound_send_marker`. All additive. Read "Case-only duplicate addresses" in `docs/deployment.md` before applying to a database with existing data.

## [0.1.0] - 2026-09-12

Initial public release: shared inbox with tenant isolation, assignment, status, priority, tags, and full-text search; RFC 5322 threading; Cloudflare Email Routing inbound and Resend outbound with delivery status, retries, and idempotent webhooks; R2 attachments; saved replies, internal notes, and opt-in AI drafts; password reset and invitations; public help center; reports with CSV export; rule-based automations; in-app notifications; customer data export and erasure; five-minute cron recovery; per-workspace AI gate and `TICKET_RETENTION_DAYS` sweep; one-click Deploy to Cloudflare; Free-plan audit.
