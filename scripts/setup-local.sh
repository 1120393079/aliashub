#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
MODE=${1:-config}

if [[ "$MODE" != "config" && "$MODE" != "--native" && "$MODE" != "--full" ]]; then
  printf 'Usage: %s [--native|--full]\n' "$0" >&2
  exit 2
fi

for command in od tr id; do
  command -v "$command" >/dev/null || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done

random_hex() {
  od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
}

cd "$ROOT_DIR"
umask 077
mkdir -p data/attachments data/registration-worker
chmod 700 data data/attachments data/registration-worker

ensure_generated_secret() {
  local key=$1
  local byte_count=$2
  local current temporary generated
  current=$(sed -n "s/^${key}=//p" .env | head -n 1)
  [[ -n "$current" ]] && return 0

  generated=$(random_hex "$byte_count")
  if grep -q "^${key}=" .env; then
    temporary=$(mktemp "$ROOT_DIR/.env.tmp.XXXXXX")
    awk -v key="$key" -v value="$generated" '
      BEGIN { replaced = 0 }
      $0 ~ ("^" key "=") && !replaced { print key "=" value; replaced = 1; next }
      { print }
    ' .env >"$temporary"
    mv "$temporary" .env
  else
    printf '%s=%s\n' "$key" "$generated" >>.env
  fi
  chmod 600 .env
}

ensure_env_default() {
  local key=$1
  local value=$2
  grep -q "^${key}=" .env || printf '%s=%s\n' "$key" "$value" >>.env
}

CREATED_ENV=false
if [[ ! -f .env ]]; then
  CREATED_ENV=true
  PORT_VALUE=${PORT:-4180}
  PUBLIC_URL=${PUBLIC_BASE_URL:-http://127.0.0.1:$PORT_VALUE}
  case "$PUBLIC_URL" in
    http://*|https://*) ;;
    *) printf 'PUBLIC_BASE_URL must start with http:// or https://\n' >&2; exit 1 ;;
  esac
  ADMIN_USER=${ADMIN_USERNAME:-admin}
  ADMIN_PASS=${ADMIN_PASSWORD:-$(random_hex 12)}
  SESSION_VALUE=${SESSION_SECRET:-$(random_hex 32)}
  ENCRYPTION_VALUE=${DATA_ENCRYPTION_KEY:-$(random_hex 32)}
  EXTENSION_VALUE=${EXTENSION_API_KEY:-$(random_hex 24)}
  REGISTRATION_TOKEN_VALUE=${REGISTRATION_SERVICE_TOKEN:-$(random_hex 32)}
  REGISTRATION_VNC_VALUE=${REGISTRATION_VNC_PASSWORD:-$(random_hex 12)}
  MICROSOFT_CLIENT_VALUE=${MICROSOFT_PUBLIC_CLIENT_ID:-8787a430-6eee-41e1-b914-681d90d35625}
  {
    printf 'NODE_ENV=production\n'
    printf 'PORT=%s\n' "$PORT_VALUE"
    printf 'HOST=127.0.0.1\n'
    printf 'DATABASE_PATH=./data/outlook-alias-hub.db\n'
    printf 'DATA_DIR=./data\n'
    printf 'PUBLIC_BASE_URL=%s\n' "$PUBLIC_URL"
    printf 'SEED_DEMO=false\n'
    printf 'ADMIN_USERNAME=%s\n' "$ADMIN_USER"
    printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASS"
    printf 'SESSION_SECRET=%s\n' "$SESSION_VALUE"
    printf 'DATA_ENCRYPTION_KEY=%s\n' "$ENCRYPTION_VALUE"
    printf 'EXTENSION_API_KEY=%s\n' "$EXTENSION_VALUE"
    printf 'REGISTRATION_SERVICE_URL=%s\n' "${REGISTRATION_SERVICE_URL:-}"
    printf 'REGISTRATION_SERVICE_TOKEN=%s\n' "$REGISTRATION_TOKEN_VALUE"
    printf 'REGISTRATION_MAILBOX_URL=%s\n' "${REGISTRATION_MAILBOX_URL:-}"
    printf 'REGISTRATION_BROWSER_URL=%s\n' "${REGISTRATION_BROWSER_URL:-}"
    printf 'REGISTRATION_WORKER_PORT=%s\n' "${REGISTRATION_WORKER_PORT:-8000}"
    printf 'REGISTRATION_BROWSER_PORT=%s\n' "${REGISTRATION_BROWSER_PORT:-6080}"
    printf 'REGISTRATION_VNC_PASSWORD=%s\n' "$REGISTRATION_VNC_VALUE"
    printf 'SUB2_BASE_URL=%s\n' "${SUB2_BASE_URL:-}"
    printf 'SUB2_ADMIN_API_KEY=%s\n' "${SUB2_ADMIN_API_KEY:-}"
    printf 'MICROSOFT_PUBLIC_CLIENT_ID=%s\n' "$MICROSOFT_CLIENT_VALUE"
    printf 'GOOGLE_OAUTH_CLIENT_ID=%s\n' "${GOOGLE_OAUTH_CLIENT_ID:-}"
    printf 'GOOGLE_OAUTH_CLIENT_SECRET=%s\n' "${GOOGLE_OAUTH_CLIENT_SECRET:-}"
    printf 'GOOGLE_OAUTH_REDIRECT_URI=%s\n' "${GOOGLE_OAUTH_REDIRECT_URI:-http://127.0.0.1:12142/}"
    printf 'LOCAL_UID=%s\n' "$(id -u)"
    printf 'LOCAL_GID=%s\n' "$(id -g)"
  } >.env
  chmod 600 .env
fi

if [[ "$MODE" == "--full" ]]; then
  ensure_generated_secret REGISTRATION_SERVICE_TOKEN 32
  ensure_generated_secret REGISTRATION_VNC_PASSWORD 12
  ensure_env_default REGISTRATION_WORKER_PORT 8000
  ensure_env_default REGISTRATION_BROWSER_PORT 6080
fi
chmod 600 .env

if [[ "$MODE" == "--native" ]]; then
  for command in node npm; do
    command -v "$command" >/dev/null || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
  done
  NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
  if (( NODE_MAJOR < 18 )); then
    printf 'Node.js 18 or newer is required.\n' >&2
    exit 1
  fi
  npm ci --omit=dev --no-audit --no-fund
fi

PUBLIC_URL=$(sed -n 's/^PUBLIC_BASE_URL=//p' .env | head -n 1)
ADMIN_USER=$(sed -n 's/^ADMIN_USERNAME=//p' .env | head -n 1)
printf 'AliasHub local configuration is ready.\n'
printf 'URL: %s\n' "$PUBLIC_URL"
printf 'Admin user: %s\n' "$ADMIN_USER"
if [[ "$CREATED_ENV" == "true" ]]; then
  ADMIN_PASS=$(sed -n 's/^ADMIN_PASSWORD=//p' .env | head -n 1)
  printf 'Admin password: %s\n' "$ADMIN_PASS"
  printf 'Keep .env together with data/ when backing up this installation.\n'
  printf 'Never commit or include .env in a release archive.\n'
fi
if [[ "$MODE" == "--native" ]]; then
  printf 'Start with: ./scripts/start-local.sh\n'
elif [[ "$MODE" == "--full" ]]; then
  WORKER_PORT=$(sed -n 's/^REGISTRATION_WORKER_PORT=//p' .env | head -n 1)
  BROWSER_PORT=$(sed -n 's/^REGISTRATION_BROWSER_PORT=//p' .env | head -n 1)
  printf 'Registration worker UI: http://127.0.0.1:%s\n' "${WORKER_PORT:-8000}"
  printf 'Registration browser: http://127.0.0.1:%s/vnc.html\n' "${BROWSER_PORT:-6080}"
  printf 'The worker and noVNC passwords are stored in .env.\n'
  printf 'Start with: docker compose -f compose.yaml -f compose.full.yaml up -d --build\n'
else
  printf 'Start with: docker compose up -d --build\n'
fi
