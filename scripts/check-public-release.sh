#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCAN_ROOT=${1:-$SCRIPT_ROOT}
REQUIRE_LICENSE=${REQUIRE_LICENSE:-0}
CHECK_GIT_HISTORY=${CHECK_GIT_HISTORY:-0}
DENYLIST_FILE=${PUBLIC_RELEASE_DENYLIST_FILE:-}

for command in find grep; do
  command -v "$command" >/dev/null || {
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  }
done

[[ -d "$SCAN_ROOT" ]] || { printf 'Scan directory not found: %s\n' "$SCAN_ROOT" >&2; exit 1; }
SCAN_ROOT=$(cd "$SCAN_ROOT" && pwd)

declare -a private_identifiers=()
if [[ -n "$DENYLIST_FILE" ]]; then
  [[ -f "$DENYLIST_FILE" ]] || {
    printf 'Private-identifier denylist not found: %s\n' "$DENYLIST_FILE" >&2
    exit 1
  }
  while IFS= read -r identifier || [[ -n "$identifier" ]]; do
    identifier=${identifier%$'\r'}
    [[ -z "$identifier" || "$identifier" == \#* ]] && continue
    private_identifiers+=("$identifier")
  done <"$DENYLIST_FILE"
fi

declare -a files=()
IS_GIT_REPOSITORY=false
if command -v git >/dev/null \
  && git -C "$SCAN_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  IS_GIT_REPOSITORY=true
  while IFS= read -r -d '' file; do
    files+=("$SCAN_ROOT/$file")
  done < <(git -C "$SCAN_ROOT" ls-files --cached --others --exclude-standard -z)
else
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(find "$SCAN_ROOT" -path "$SCAN_ROOT/.git" -prune -o ! -type d -print0)
fi

failures=0

report_failure() {
  printf 'ERROR: %s\n' "$1" >&2
  failures=$((failures + 1))
}

is_forbidden_path() {
  local relative=$1
  case "$relative" in
    .env.example|*/.env.example|data/attachments/.gitkeep) return 1 ;;
  esac
  case "$relative" in
    .env|.env.*|*/.env|*/.env.*|.deploy-password|.deploy-password.*|*/.deploy-password|*/.deploy-password.*|\
    docker-compose.override.yml|*/docker-compose.override.yml|docker-compose.override.yaml|*/docker-compose.override.yaml|\
    *.db|*.db-*|*.db.*|*.sqlite|*.sqlite-*|*.sqlite.*|*.sqlite3|*.sqlite3-*|*.sqlite3.*|*:memory:*|*.pem|*.p12|*.pfx|*.jks|\
    *.key|*.har|*.har.*|*.log|*.log.*|*.bak|*.backup|id_rsa|id_ed25519|credentials.json|\
    cookies.json|cookies-*.json|storage-state*.json|browser-profile/*|*/browser-profile/*|user-data/*|*/user-data/*|\
    .venv/*|*/.venv/*|node_modules/*|*/node_modules/*|tools/captures/*|*/tools/captures/*|\
    *.pyc|*.pyo|__pycache__/*|*/__pycache__/*|.pytest_cache/*|*/.pytest_cache/*|\
    .mypy_cache/*|*/.mypy_cache/*|.ruff_cache/*|*/.ruff_cache/*|*.egg-info/*|*/*.egg-info/*|\
    cache/*|*/cache/*|caches/*|*/caches/*|.tools/downloads/*|*/.tools/downloads/*|\
    playwright-report/*|*/playwright-report/*|test-results/*|*/test-results/*|\
    captures/*|*/captures/*|artifacts/*|*/artifacts/*|screenshots/*|*/screenshots/*|runtime-screenshots/*|*/runtime-screenshots/*|\
    accounts.txt|*/accounts.txt|account.txt|*/account.txt|*_accounts.txt|acc*.json|*/acc*.json|*_har.json|*/tests/fixtures/paypal_*_har.json|\
    otp_*.txt|*/otp_*.txt|har_*.txt|*/har_*.txt|logger.txt|*/logger.txt|task_events.txt|*/task_events.txt|\
    progress.txt|*/progress.txt|pytest_out.txt|*/pytest_out.txt|\
    data/*|registration-worker/data/*|audit/*) return 0 ;;
    *) return 1 ;;
  esac
}

while IFS= read -r nested_git_dir; do
  [[ -n "$nested_git_dir" ]] || continue
  report_failure "nested Git metadata must not be published: ${nested_git_dir#"$SCAN_ROOT/"}"
done < <(find "$SCAN_ROOT" -mindepth 2 -type d -name .git -print)

# Inspect ignored paths too. A release gate must catch a local secret even when
# .gitignore would prevent Git from listing it.
while IFS= read -r -d '' physical_path; do
  relative=${physical_path#"$SCAN_ROOT/"}
  if [[ -L "$physical_path" ]]; then
    report_failure "symbolic link must not be published: $relative"
  elif [[ ! -f "$physical_path" ]]; then
    report_failure "special filesystem entry must not be published: $relative"
  elif is_forbidden_path "$relative"; then
    report_failure "forbidden local or packaged file: $relative"
  fi
done < <(find "$SCAN_ROOT" \
  -path "$SCAN_ROOT/.git" -prune -o \
  -type d \( -name .git -o -name node_modules -o -name .venv \) -prune -o \
  -path "$SCAN_ROOT/dist" -prune -o \
  -path "$SCAN_ROOT/release" -prune -o \
  ! -type d -print0)

for file in "${files[@]}"; do
  relative=${file#"$SCAN_ROOT/"}
  if [[ -L "$file" ]]; then
    report_failure "symbolic link is tracked or selected for packaging: $relative"
    continue
  fi
  if [[ ! -f "$file" ]]; then
    report_failure "special filesystem entry is tracked or selected for packaging: $relative"
    continue
  fi
  if is_forbidden_path "$relative"; then
    report_failure "forbidden tracked or packaged file: $relative"
  fi
done

secret_pattern='-----BEGIN ([A-Z0-9 ]+)?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|eca_tr_[A-Za-z0-9_-]{12,}'

for file in "${files[@]}"; do
  relative=${file#"$SCAN_ROOT/"}
  [[ "$relative" == "scripts/check-public-release.sh" ]] && continue
  [[ -f "$file" ]] || continue
  if matches=$(grep -nIH -E "$secret_pattern" -- "$file" 2>/dev/null); then
    printf '%s\n' "$matches" >&2
    report_failure "secret-like value found in $relative"
  fi
  for identifier in "${private_identifiers[@]}"; do
    if matches=$(grep -nIH -F -- "$identifier" "$file" 2>/dev/null); then
      printf '%s\n' "$matches" >&2
      report_failure "private deployment identifier found in $relative"
    fi
  done
done

license_file=""
for candidate in LICENSE LICENSE.md LICENSE.txt COPYING COPYING.md; do
  if [[ -f "$SCAN_ROOT/$candidate" ]]; then
    license_file=$candidate
    break
  fi
done
if [[ -z "$license_file" ]]; then
  if [[ "$REQUIRE_LICENSE" == "1" ]]; then
    report_failure "no LICENSE or COPYING file; select a license before an open-source release"
  else
    printf 'WARNING: no license selected. Use REQUIRE_LICENSE=1 for the final public-release gate.\n' >&2
  fi
fi

if [[ "$CHECK_GIT_HISTORY" == "1" ]]; then
  if [[ "$IS_GIT_REPOSITORY" != "true" ]]; then
    report_failure "CHECK_GIT_HISTORY=1 requires a Git repository"
  else
    while IFS= read -r commit; do
      [[ -n "$commit" ]] || continue
      while IFS= read -r -d '' historical_path; do
        if is_forbidden_path "$historical_path"; then
          report_failure "forbidden file exists in Git commit $commit: $historical_path"
        fi
      done < <(git -C "$SCAN_ROOT" ls-tree -r --name-only -z "$commit")
      if matches=$(git -C "$SCAN_ROOT" grep -nI -E "$secret_pattern" "$commit" -- . \
        ':(exclude)scripts/check-public-release.sh' 2>/dev/null); then
        printf '%s\n' "$matches" >&2
        report_failure "secret-like value exists in Git commit $commit"
      fi
      for identifier in "${private_identifiers[@]}"; do
        if matches=$(git -C "$SCAN_ROOT" grep -nI -F "$identifier" "$commit" -- . \
          ':(exclude)scripts/check-public-release.sh' 2>/dev/null); then
          printf '%s\n' "$matches" >&2
          report_failure "private deployment identifier exists in Git commit $commit"
        fi
      done
    done < <(git -C "$SCAN_ROOT" rev-list --all)
  fi
fi

if (( failures > 0 )); then
  printf 'Public release check failed with %d issue(s).\n' "$failures" >&2
  exit 1
fi

printf 'Public release check passed for %s.\n' "$SCAN_ROOT"
if [[ -n "$license_file" ]]; then
  printf 'License file: %s\n' "$license_file"
fi
