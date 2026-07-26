#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${RELEASE_VERSION:-$(node -p "require('$ROOT_DIR/package.json').version")}
PACKAGE_NAME="aliashub-local-$VERSION"
RELEASE_DIR=${LOCAL_RELEASE_DIR:-$ROOT_DIR/release/local}
ARCHIVE_PATH="$RELEASE_DIR/$PACKAGE_NAME.zip"
BUILD_ROOT=$(mktemp -d)
PACKAGE_DIR="$BUILD_ROOT/$PACKAGE_NAME"
trap 'rm -rf "$BUILD_ROOT"' EXIT

for command in node npm convert tar zip sha256sum; do
  command -v "$command" >/dev/null || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done

cd "$ROOT_DIR"
bash scripts/check-public-release.sh
mkdir -p \
  "$PACKAGE_DIR/scripts" \
  "$PACKAGE_DIR/release" \
  "$PACKAGE_DIR/data/attachments" \
  "$PACKAGE_DIR/data/registration-worker" \
  "$RELEASE_DIR"

for directory in server src public extension; do
  cp -a "$directory" "$PACKAGE_DIR/$directory"
done

[[ -f registration-worker/Dockerfile ]] || {
  printf 'Bundled registration worker source is missing.\n' >&2
  exit 1
}
mkdir -p "$PACKAGE_DIR/registration-worker"
tar \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./.deploy-password*' \
  --exclude='./.venv' \
  --exclude='./venv' \
  --exclude='./data' \
  --exclude='./account_manager.db*' \
  --exclude='./static' \
  --exclude='./dist' \
  --exclude='./build' \
  --exclude='./release' \
  --exclude='*/node_modules' \
  --exclude='./frontend/dist' \
  --exclude='./.pytest_cache' \
  --exclude='./tools/captures' \
  --exclude='*/captures' \
  --exclude='*/artifacts' \
  --exclude='*/screenshots' \
  --exclude='*/runtime-screenshots' \
  --exclude='*.har' \
  --exclude='*.har.*' \
  --exclude='*_accounts.txt' \
  --exclude='acc*.json' \
  --exclude='*_har.json' \
  --exclude='otp_*.txt' \
  --exclude='har_*.txt' \
  --exclude='./deploy-build.pid' \
  --exclude='./deploy-build.log' \
  --exclude='./docker-compose.override.yml' \
  --exclude='./docker-compose.override.yaml' \
  --exclude='*.egg-info' \
  --exclude='*/__pycache__' \
  --exclude='*.pyc' \
  --exclude='*.pyo' \
  -C registration-worker -cf - . \
  | tar -C "$PACKAGE_DIR/registration-worker" -xf -

for file in \
  package.json package-lock.json index.html vite.config.js \
  .env.example .gitignore .dockerignore Dockerfile compose.yaml compose.full.yaml; do
  cp -a "$file" "$PACKAGE_DIR/$file"
done

for script in check-public-release.sh package-extension.sh package-local-release.sh setup-local.sh start-local.sh; do
  cp -a "scripts/$script" "$PACKAGE_DIR/scripts/$script"
done

cp -a README.md LOCAL-DEPLOY.md CHANGELOG.md "$PACKAGE_DIR/"
for file in CONTRIBUTING.md SECURITY.md THIRD_PARTY_NOTICES.md; do
  [[ -f "$file" ]] && cp -a "$file" "$PACKAGE_DIR/$file"
done
if [[ -d docs ]]; then
  cp -a docs "$PACKAGE_DIR/docs"
fi
for file in LICENSE LICENSE.md LICENSE.txt COPYING COPYING.md; do
  if [[ -f "$file" ]]; then
    cp -a "$file" "$PACKAGE_DIR/$file"
    break
  fi
done
: >"$PACKAGE_DIR/data/attachments/.gitkeep"

VITE_BASE_PATH=/ npx vite build --outDir "$PACKAGE_DIR/dist" --emptyOutDir
EXTENSION_OUTPUT_PATH="$PACKAGE_DIR/release/aliashub-outlook-extension.zip" \
  bash scripts/package-extension.sh "" "http://127.0.0.1:4180"
bash scripts/check-public-release.sh "$PACKAGE_DIR"

if find "$PACKAGE_DIR" ! -type d ! -type f -print -quit | grep -q .; then
  printf 'Refusing to package a symbolic link or special filesystem entry.\n' >&2
  exit 1
fi

if find "$PACKAGE_DIR" -type f \( \
  -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) -o \
  -name '*.db*' -o -name '*.sqlite*' -o -name '*.wal' -o \
  -name '*.shm' -o -name '*.log*' -o -name '*.bak*' -o -name '*.backup*' \
\) -print -quit | grep -q .; then
  printf 'Refusing to package a runtime data or secret file.\n' >&2
  exit 1
fi

find "$PACKAGE_DIR" -type d -exec chmod 755 {} +
find "$PACKAGE_DIR" -type f -exec chmod 644 {} +
chmod 755 "$PACKAGE_DIR/scripts/"*.sh
chmod 700 \
  "$PACKAGE_DIR/data" \
  "$PACKAGE_DIR/data/attachments" \
  "$PACKAGE_DIR/data/registration-worker"

rm -f "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256"
(
  cd "$BUILD_ROOT"
  zip -qr "$ARCHIVE_PATH" "$PACKAGE_NAME"
)
(
  cd "$RELEASE_DIR"
  sha256sum "$(basename "$ARCHIVE_PATH")" >"$(basename "$ARCHIVE_PATH").sha256"
)
chmod 644 "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256"

printf 'Local release: %s\n' "$ARCHIVE_PATH"
printf 'SHA-256 file: %s.sha256\n' "$ARCHIVE_PATH"
