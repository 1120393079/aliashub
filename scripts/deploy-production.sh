#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR=$(cd "$(dirname "$0")/.." && pwd)

: "${DEPLOY_DIR:?Set DEPLOY_DIR to the existing application directory}"
: "${DATABASE_PATH:?Set DATABASE_PATH to the existing SQLite database}"
: "${BACKUP_ROOT:?Set BACKUP_ROOT to a protected backup directory}"
: "${SERVICE_NAME:?Set SERVICE_NAME to the existing systemd unit}"
: "${HEALTH_URL:?Set HEALTH_URL to the AliasHub /api/health URL}"

DEPLOY_OWNER=${DEPLOY_OWNER:-}
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$BACKUP_ROOT/deploy-$TIMESTAMP"

if [[ $(id -u) -ne 0 ]]; then
  printf 'Run this deployment as root.\n' >&2
  exit 1
fi

for command in curl grep realpath rsync sqlite3 systemctl; do
  command -v "$command" >/dev/null || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

[[ -d "$DEPLOY_DIR" ]] || { printf 'Deploy directory not found: %s\n' "$DEPLOY_DIR" >&2; exit 1; }
[[ -f "$DATABASE_PATH" ]] || { printf 'Database not found: %s\n' "$DATABASE_PATH" >&2; exit 1; }
[[ -f "$SOURCE_DIR/dist/index.html" ]] || { printf 'Build output is missing. Run npm run build first.\n' >&2; exit 1; }
[[ $(realpath "$SOURCE_DIR") != $(realpath "$DEPLOY_DIR") ]] || {
  printf 'SOURCE_DIR and DEPLOY_DIR must be different directories.\n' >&2
  exit 1
}

umask 077
mkdir -p "$BACKUP_DIR/code"
sqlite3 "$DATABASE_PATH" ".timeout 5000" ".backup '$BACKUP_DIR/aliashub.db'"
sqlite3 "$BACKUP_DIR/aliashub.db" "PRAGMA integrity_check;" | grep -qx 'ok'
rsync -a \
  --exclude='.env' \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='audit/' \
  --exclude='release/' \
  "$DEPLOY_DIR/" "$BACKUP_DIR/code/"

set_permissions() {
  if [[ -n "$DEPLOY_OWNER" ]]; then
    find "$DEPLOY_DIR" \
      -path "$DEPLOY_DIR/.env" -prune -o \
      -path "$DEPLOY_DIR/data" -prune -o \
      -exec chown "$DEPLOY_OWNER" {} +
  fi
  find "$DEPLOY_DIR" \
    -path "$DEPLOY_DIR/.env" -prune -o \
    -path "$DEPLOY_DIR/data" -prune -o \
    -type d -exec chmod 750 {} +
  find "$DEPLOY_DIR" \
    -path "$DEPLOY_DIR/.env" -prune -o \
    -path "$DEPLOY_DIR/data" -prune -o \
    -type f -exec chmod 640 {} +
}

rollback() {
  local status=$?
  trap - ERR
  printf 'Deployment failed; restoring the previous application files.\n' >&2
  rsync -a --delete \
    --exclude='.env' \
    --exclude='node_modules/' \
    --exclude='data/' \
    --exclude='audit/' \
    "$BACKUP_DIR/code/" "$DEPLOY_DIR/"
  set_permissions
  systemctl restart "$SERVICE_NAME" || true
  exit "$status"
}

trap rollback ERR
systemctl stop "$SERVICE_NAME"
rsync -a --delete \
  --exclude='.env' \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='audit/' \
  --exclude='release/' \
  "$SOURCE_DIR/" "$DEPLOY_DIR/"
set_permissions
systemctl start "$SERVICE_NAME"

for _attempt in {1..20}; do
  if curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >"$BACKUP_DIR/health.json"; then
    break
  fi
  sleep 1
done

curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null
trap - ERR

printf 'AliasHub deployed successfully. Backup: %s\n' "$BACKUP_DIR"
