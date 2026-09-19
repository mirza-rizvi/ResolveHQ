# Security policy

## Supported versions

Only the latest release on the `dev` branch receives fixes. Upgrade before reporting an issue against an older build.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include credentials, customer information, request logs, or exploit details in public discussions.

Use GitHub's private vulnerability reporting for this repository. Include the affected component, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Deployment responsibility

ResolveHQ is self-hosted. Operators are responsible for protecting Cloudflare and mail-provider credentials, using unique production secrets, applying database migrations, keeping dependencies current, and restricting access to their Cloudflare account.

A workspace export is a complete copy of that workspace's data in your R2 bucket. Keep the bucket private with `r2.dev` disabled, treat a downloaded export as you would the database itself, and shorten the retention window if exports should not sit around. Exports never contain passwords, API-key hashes or webhook secrets.

Never deploy the included demo seed data to production.
