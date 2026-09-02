#!/usr/bin/env bash
set -euo pipefail
rm -rf .wrangler/state/v3/d1
npm run db:migrate:local
npm run db:seed:local
