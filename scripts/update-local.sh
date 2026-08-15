#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
MODE=${1:-auto}
REMOTE=${ALIAS_HUB_UPDATE_REMOTE:-origin}
BRANCH=${ALIAS_HUB_UPDATE_BRANCH:-main}
BACKUP_ROOT=${ALIAS_HUB_UPDATE_BACKUP_ROOT:-$ROOT_DIR/deploy-backups}
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$BACKUP_ROOT/update-$TIMESTAMP"
STOPPED_MODE=""

restart_after_failure() {
  local status=$?
  trap - ERR
  if [[ "$STOPPED_MODE" == "full" ]]; then
    docker compose -f "$ROOT_DIR/compose.yaml" -f "$ROOT_DIR/compose.full.yaml" up -d || true
  elif [[ "$STOPPED_MODE" == "core" ]]; then
    docker compose -f "$ROOT_DIR/compose.yaml" up -d || true
  fi
  printf 'AliasHub update failed. Local data backup: %s\n' "$BACKUP_DIR" >&2
  exit "$status"
}

trap restart_after_failure ERR

if [[ "$MODE" != "auto" && "$MODE" != "--core" && "$MODE" != "--full" && "$MODE" != "--native" ]]; then
  printf 'Usage: %s [--core|--full|--native]\n' "$0" >&2
  exit 2
fi

for command in git cp find sha256sum sort xargs awk cmp grep; do
  command -v "$command" >/dev/null || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'This updater must run from a Git clone.\n' >&2
  exit 1
}
git -C "$ROOT_DIR" remote get-url "$REMOTE" >/dev/null 2>&1 || {
  printf 'Git remote not found: %s\n' "$REMOTE" >&2
  exit 1
}

for env_file in .env registration-worker/.env; do
  if [[ -f "$ROOT_DIR/$env_file" ]] && ! git -C "$ROOT_DIR" check-ignore -q "$env_file"; then
    printf 'Refusing to update because %s is not ignored by Git.\n' "$env_file" >&2
    exit 1
  fi
done
if [[ -d "$ROOT_DIR/data" ]]; then
  probe=$(find "$ROOT_DIR/data" -type f ! -name .gitkeep -print -quit)
  if [[ -n "$probe" ]]; then
    relative=${probe#"$ROOT_DIR/"}
    git -C "$ROOT_DIR" check-ignore -q "$relative" || {
      printf 'Refusing to update because runtime data is not ignored by Git: %s\n' "$relative" >&2
      exit 1
    }
  fi
fi

if [[ "$MODE" == "auto" ]]; then
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    if docker compose -f "$ROOT_DIR/compose.yaml" -f "$ROOT_DIR/compose.full.yaml" ps -q registration-worker 2>/dev/null | grep -q .; then
      MODE=--full
    elif docker compose -f "$ROOT_DIR/compose.yaml" ps -q aliashub 2>/dev/null | grep -q .; then
      MODE=--core
    else
      MODE=--native
    fi
  else
    MODE=--native
  fi
fi

case "$MODE" in
  --full)
    command -v docker >/dev/null || { printf 'Docker is required for --full.\n' >&2; exit 1; }
    docker compose -f "$ROOT_DIR/compose.yaml" -f "$ROOT_DIR/compose.full.yaml" stop
    STOPPED_MODE=full
    ;;
  --core)
    command -v docker >/dev/null || { printf 'Docker is required for --core.\n' >&2; exit 1; }
    docker compose -f "$ROOT_DIR/compose.yaml" stop
    STOPPED_MODE=core
    ;;
esac

umask 077
mkdir -p "$BACKUP_DIR"
for env_file in .env registration-worker/.env; do
  if [[ -f "$ROOT_DIR/$env_file" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$env_file")"
    cp -a "$ROOT_DIR/$env_file" "$BACKUP_DIR/$env_file"
  fi
done
if [[ -d "$ROOT_DIR/data" ]]; then
  mkdir -p "$BACKUP_DIR/data"
  cp -a "$ROOT_DIR/data/." "$BACKUP_DIR/data/"
fi

data_manifest() {
  local output=$1
  if [[ ! -d "$ROOT_DIR/data" ]]; then
    : >"$output"
    return
  fi
  (
    cd "$ROOT_DIR"
    find data -type f ! -name .gitkeep -print0 \
      | sort -z \
      | xargs -0 -r sha256sum
  ) >"$output"
}

data_manifest "$BACKUP_DIR/data-before.sha256"

env_manifest() {
  local output=$1
  (
    cd "$ROOT_DIR"
    for env_file in .env registration-worker/.env; do
      [[ -f "$env_file" ]] && sha256sum "$env_file"
    done
  ) >"$output"
}

env_manifest "$BACKUP_DIR/env-before.sha256"

git -C "$ROOT_DIR" fetch --prune "$REMOTE" "$BRANCH"
git -C "$ROOT_DIR" reset --hard "$REMOTE/$BRANCH"

data_manifest "$BACKUP_DIR/data-after.sha256"
cmp -s "$BACKUP_DIR/data-before.sha256" "$BACKUP_DIR/data-after.sha256" || {
  printf 'Runtime data changed during the source update. Backup: %s\n' "$BACKUP_DIR" >&2
  exit 1
}
env_manifest "$BACKUP_DIR/env-after.sha256"
cmp -s "$BACKUP_DIR/env-before.sha256" "$BACKUP_DIR/env-after.sha256" || {
  printf 'Local environment files changed during the source update. Backup: %s\n' "$BACKUP_DIR" >&2
  exit 1
}

# A full-suite update may introduce new generated secrets. The current setup
# script only adds missing values and never replaces existing configuration.
if [[ "$MODE" == "--full" ]]; then
  bash "$ROOT_DIR/scripts/setup-local.sh" --full
fi

case "$MODE" in
  --full)
    docker compose -f "$ROOT_DIR/compose.yaml" -f "$ROOT_DIR/compose.full.yaml" up -d --build
    ;;
  --core)
    docker compose -f "$ROOT_DIR/compose.yaml" up -d --build
    ;;
  --native)
    command -v node >/dev/null && command -v npm >/dev/null || {
      printf 'Node.js and npm are required for --native.\n' >&2
      exit 1
    }
    npm --prefix "$ROOT_DIR" ci --no-audit --no-fund
    npm --prefix "$ROOT_DIR" run build:local
    printf 'Native source updated. Restart the existing AliasHub process now.\n'
    ;;
esac

trap - ERR
printf 'AliasHub source updated to %s/%s.\n' "$REMOTE" "$BRANCH"
printf 'Local .env files and data were preserved. Backup: %s\n' "$BACKUP_DIR"
