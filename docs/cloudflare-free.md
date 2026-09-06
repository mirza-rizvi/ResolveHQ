# Cloudflare Free-plan audit

Audited September 6, 2026. ResolveHQ can run on Cloudflare's Free plan for small deployments if usage and execution fit its quotas. This is conditional compatibility, not a guarantee of zero cost or of authentication fitting the Free CPU budget. The architecture remains one Worker with static assets/API, D1, private R2, Queues, Cron, Email Routing, and Resend outbound mail.

## Components

| Component      | Free-plan compatible                   | Issue                                                                                                    | Change made                                                                                                                                       |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers        | Yes, within quotas                     | Older declared Wrangler floor and fresh-account migrations before resource creation                      | Require Wrangler 4.127.1; offline deployment check; document D1 creation first; preserve paid settings                                            |
| CPU            | Conditional; benchmark required        | Password derivation, MIME parsing, sanitization and full-text documents can exceed Free execution limits | Keep strong native PBKDF2; safe opt-in timings; single-job consumers and bounded maintenance; no security downgrade                               |
| D1             | Yes, within query/storage/row quotas   | Bulk/team N+1 reads, customer-wide counts, unbounded maintenance and FTS identifier scans                | Set-based bulk/team operations; page customers before counts; small cleanup batches; indexed FTS row mapping and cursor indexes                   |
| R2             | Yes, within its own free allowance     | Full-buffer browser uploads, readback checksums, duplicate upload intents, cleanup races                 | Backpressured uploads with incremental checksum, durable reservations and cleanup claims; authenticated streamed downloads preserved              |
| Queues         | Yes                                    | Documentation wrongly required Paid; repeated Cron and queue retries; batches of five mail jobs          | Keep existing queues; single-job batches, D1 dispatch reservations/leases, six automatic attempts, DLQs and admin recovery; add maintenance queue |
| Cron           | Yes, subject to CPU                    | Large direct cleanup runs, stalled-job recovery loops                                                    | Every five minutes, bounded 20-row recovery sweeps; five-item maintenance consumers; no queued cleanup for empty sweeps                           |
| Email Routing  | Yes, subject to CPU and message limits | MIME recipient could supersede actual envelope recipient; buffered MIME processing                       | Route by persisted envelope; reject oversized/unknown recipients early; stage to private R2 and process five attachments at a time                |
| Outbound email | External Resend limits                 | Expired idempotency keys and bounce/complaint requeue could duplicate mail                               | Persist send envelope, 23-hour automatic retry window, terminal negative events, acknowledged manual retry generations                            |
| Static assets  | Yes                                    | Frontend example suggested unused API origin; deployment could inherit local capture settings            | Preserve same-origin API/static routing; production-safe examples; no frontend secrets                                                            |
| Rate limiting  | Yes                                    | Login IP+email key alone could be bypassed across emails; invitation/password-change gaps                | Retain existing native limits and add IP login and invitation/password-change protection                                                          |

[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) explicitly includes Workers Free: 10,000 operations/day and fixed 24-hour retention. A small successfully delivered job normally uses three operations; retries and DLQs add operations. Batching does not reduce per-message operation charges. D1 holds recovery state beyond queue retention; DLQs are diagnostic sinks, not automatically replayed.

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) include Free HTTP CPU of 10 ms, 100,000 requests/day, 128 MB memory, and a 3 MB compressed Worker bundle. Cron and Email Routing also need production CPU verification. Offloading to Queues does not establish unlimited CPU. Static asset requests served without invoking the Worker do not use the dynamic request allowance.

[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) include 50 queries per Free invocation, 100 bound parameters per statement and 500 MB per database. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) includes 5 million rows read and 100,000 rows written per day. Active inbox polling, dashboards, full-text search, and index maintenance all count. Queries can remain under the per-invocation ceiling while exhausting daily quotas.

[R2 activation](https://developers.cloudflare.com/r2/get-started/) requires subscription checkout separately from Workers Paid. Keep both public bucket access and r2.dev disabled. Domain registration and Resend are separate from Cloudflare Workers usage.

## Authentication findings and measurement

The previous implementation already used Web Crypto `importKey`/`deriveBits`, not JavaScript PBKDF2 loops or Node crypto. It derives 256 bits using PBKDF2-SHA256 at 310,000 iterations, a 16-byte random salt, and `password + NUL + SESSION_PEPPER`. The persisted format remains `pbkdf2-sha256$iterations$salt$digest`. Existing hashes, including the seeded legacy fixture, remain compatible. No migration or lower work factor was introduced.

The change validates malformed encodings before derivation and uses Workers' native `crypto.subtle.timingSafeEqual` for digest comparison. The KDF remains the likely dominant cost; changing the comparison is not a material KDF speedup. Password change performs both verification and hashing. A missing or shorter-than-32-character pepper fails authentication closed. Never rotate an existing pepper without a separate credential migration plan.

Run `npm run auth:benchmark` for synthetic local Miniflare timings. On the audit machine, 12 samples measured median hash 24.3 ms (max 25.8), verify 24.0 ms (max 24.4), and verify+rehash 47.3 ms (max 49.1). These measure local end-to-end elapsed time, not production CPU, and do not prove that Free will accept or reject an operation.

`AUTH_TIMING_SAMPLE_RATE=0` disables application timing by default. Temporarily set `0.01` in Worker variables to sample approximately 1% of auth requests, or `1` for a short controlled benchmark. Both `/api/auth` and `/api/v1/auth` emit one anonymous `auth_timing` record containing only a fixed operation name, status, operation elapsed durations, total elapsed duration, and `clock: elapsed_not_cpu`. Passwords, hashes, tokens, email addresses, and full URLs are excluded. Automatic invocation logs are disabled because URLs may carry upload/reset tokens. Safe application error events remain available.

Workers' [performance timers](https://developers.cloudflare.com/workers/runtime-apis/performance/) advance around I/O and do not measure CPU work. Use [Workers CPU metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) and CPU-limit/error outcomes during a controlled production test of signup, successful/failed login, reset, and change-password. A terminated invocation may never emit its final timing record. If CPU does not fit Free, upgrade Workers; do not lower iterations or replace PBKDF2 with a fast digest.

## Recovery and storage behavior

Mail consumers claim a 20-minute D1 lease, longer than the queue invocation wall-time limit. Dispatch is reserved before enqueue so Cron does not repeatedly create copies while a message is in flight. An ambiguous enqueue failure remains recoverable after the reservation expires. Each actual failure consumes one of six attempts (initial plus five retries), with exponential delays starting at 15 seconds and capped at one hour. Additional chunks of five inbound attachments do not consume the failure budget. Cron dispatches continuations; this can add five-minute latency between chunks.

Outbound envelopes and keys remain identical during automatic retries. No automatic resend occurs after 23 hours from the first provider attempt, inside [Resend's 24-hour idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys). Config/permanent provider errors and negative delivery events stop automatically. Administrators can review up to 50 recent stopped jobs in Settings, fix the underlying issue and request a new generation. Previously attempted/uncertain sends require explicit duplicate-risk acknowledgment. Spam complaints cannot be manually resent. Retry endpoints enforce tenant ownership, administrator role, CSRF, rate limits, and generation checks. D1 recovery records are retained even when a DLQ message expires.

Inbound raw MIME is limited to 25 MiB; attachments are limited to 15 MiB. The email handler stages the raw stream; PostalMime still buffers and parses a complete bounded message in the consumer. MIME decoding is not fully streaming and can exceed Free CPU/memory headroom for complex messages. Five attachments are persisted per invocation, with idempotent checkpoints. Browser uploads and private downloads stream; signature inspection buffers at most 512 bytes and checksums use DigestStream. Type signatures are not malware scanning. Downloads force attachment disposition and retain authorization and nosniff protections.

Unlinked uploads and abandoned reservations become cleanup candidates after one day; old staged mail after seven days. Cleanup consumers handle five objects at a time. Do not rely on failed raw MIME being available forever. A missing raw payload cannot be manually recovered: ask the sender to resend.

Maintenance retries are durable in `maintenance_tasks`; failures stop after six attempts. An operator can inspect failed tasks using:

```bash
npx wrangler d1 execute DB --remote --command "SELECT id, kind, attempts FROM maintenance_tasks WHERE status = 'failed' LIMIT 20"
```

After fixing the cause, reset only the reviewed task (replace `REVIEWED_TASK_ID`; do not blindly reset all failures):

```bash
npx wrangler d1 execute DB --remote --command "UPDATE maintenance_tasks SET status = 'pending', attempts = 0, lease_until = 0, dispatch_until = 0, next_attempt_at = 0 WHERE id = 'REVIEWED_TASK_ID' AND status = 'failed'"
```

## Remaining limitations

- Authentication, complex MIME, large HTML, and large search documents still require production CPU benchmarking. Native crypto preserves security but cannot promise a Free-plan fit.
- The MIME parser buffers raw/decoded mail. Individual file limits are not a guarantee that every pathological message fits 128 MB.
- Customer search refresh is eventually consistent, five tickets per maintenance invocation. High backlogs can take many Cron cycles.
- Full-text documents still include all ticket messages. Large histories can hit D1 text/row limits; first-time/legacy FTS mapping repair may scan the virtual table. Dashboard aggregations and substring customer search remain scoped scans, and active-client polling consumes daily reads/writes.
- Bulk updates retain optimistic version checks and assignment/activity behavior. As before, ticket mutation and subsequent audit/notification persistence are separate database operations; catastrophic interruption can leave partial side effects.
- Bounded sweeps limit work returned and written, not necessarily every row read by a sparse recovery predicate. Large backlogs and tenant histories can require further indexing/retention work or an upgrade.
- Free Queue retention is 24 hours. D1 recovery mitigates expiry, but quota exhaustion delays mail and cleanup. DLQ delivery itself can fail; retained D1 terminal state is authoritative.
- System invitation/reset emails use Resend directly and are not durable ticket-mail jobs. A verified sender and working provider are required.
- R2 usage beyond its allowance, domain ownership, Resend quotas, logs, Workers traffic/CPU, or D1 quotas may incur cost or require upgrades. This release does not deploy to or certify any production account.

For exact new-account commands and upgrade sequencing, follow [deployment and configuration](deployment.md). The [changed-file manifest and validation record](cloudflare-free-changes.md) lists all 51 changed files and why.
