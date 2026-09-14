# Contributing

Bug reports, fixes, and small improvements are welcome. Open an issue first for anything larger than a bug fix so the approach can be agreed before you spend time on it.

## Setup

```bash
npm install
cp .dev.vars.local.example .dev.vars
npm run db:reset:local
npm run dev
```

The app and API run on `http://localhost:5173`. Sign in as `owner@northstarlabs.test` / `resolve-demo-2026`.

## Before you open a pull request

- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- UI changes include a screenshot; changes to the inbox, thread, or settings pages should also refresh `docs/images` with `npm run screenshots`.
- Database changes ship as a hand-written SQL file in `drizzle/migrations/` plus a `meta/_journal.json` entry, with the docs that describe them.
- Mail, auth, tenant-isolation, and attachment changes come with regression tests in `tests/`.
- Add a line under `## [Unreleased]` in `CHANGELOG.md`.

## Style

TypeScript, two-space indentation, semicolons, double quotes. Small explicit modules. Keep tenant filtering and authorization server-side. Commit subjects are short and imperative (`fix: enforce tenant scope on ticket search`).

## License of contributions

ResolveHQ is source-available, not open source. By submitting a contribution you agree it is provided under the terms of [LICENSE](LICENSE) and that the copyright holder may use, relicense, and distribute it as part of ResolveHQ.

## Security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
