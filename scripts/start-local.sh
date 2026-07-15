#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"
umask 077

[[ -f .env ]] || { printf 'Run ./scripts/setup-local.sh --native first.\n' >&2; exit 1; }
[[ -d node_modules/better-sqlite3 ]] || { printf 'Runtime dependencies are missing. Run ./scripts/setup-local.sh --native.\n' >&2; exit 1; }
[[ -f dist/index.html ]] || { printf 'Local frontend build is missing.\n' >&2; exit 1; }

mkdir -p data/attachments
chmod 700 data data/attachments
find data -maxdepth 1 -type f -name 'outlook-alias-hub.db*' -exec chmod 600 {} + 2>/dev/null || true

PUBLIC_URL=$(sed -n 's/^PUBLIC_BASE_URL=//p' .env | head -n 1)
printf 'AliasHub listening at %s\n' "$PUBLIC_URL"
exec node server/index.js
