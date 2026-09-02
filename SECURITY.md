# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include credentials, customer information, request logs, or exploit details in public discussions.

Use GitHub's private vulnerability reporting for this repository. Include the affected component, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Deployment responsibility

ResolveHQ is self-hosted. Operators are responsible for protecting Cloudflare and mail-provider credentials, using unique production secrets, applying database migrations, keeping dependencies current, and restricting access to their Cloudflare account.

Never deploy the included demo seed data to production.
