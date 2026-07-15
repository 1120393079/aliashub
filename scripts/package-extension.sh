#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
API_KEY=""
if (( $# >= 1 )) && [[ -n "$1" ]]; then
  printf 'Refusing to embed a connector key. Pass an empty first argument and enter the key in the extension popup.\n' >&2
  exit 2
fi
if (( $# >= 2 )); then
  BASE_URL=$2
else
  BASE_URL=${PUBLIC_BASE_URL:-http://127.0.0.1:4180}
fi
OUTPUT_PATH=${EXTENSION_OUTPUT_PATH:-$ROOT_DIR/release/aliashub-outlook-extension.zip}
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

for command in node convert zip; do
  command -v "$command" >/dev/null || { printf 'Missing required command: %s\n' "$command" >&2; exit 1; }
done

cp -a "$ROOT_DIR/extension/." "$BUILD_DIR/"
mkdir -p "$BUILD_DIR/icons" "$(dirname "$OUTPUT_PATH")"
OUTPUT_DIR=$(cd "$(dirname "$OUTPUT_PATH")" && pwd)
OUTPUT_PATH="$OUTPUT_DIR/$(basename "$OUTPUT_PATH")"

node --input-type=module - "$BUILD_DIR" "$API_KEY" "$BASE_URL" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [buildDir, apiKey, baseUrl] = process.argv.slice(2);
const url = new URL(baseUrl);
if (!["http:", "https:"].includes(url.protocol)) throw new Error("AliasHub URL must use http or https");
if (url.username || url.password) throw new Error("AliasHub URL must not contain credentials");
if (url.search || url.hash) throw new Error("AliasHub URL must not contain a query or fragment");
const normalizedBase = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
const hostPermission = `${url.protocol}//${url.hostname}/*`;

const backgroundPath = path.join(buildDir, "background.js");
let background = fs.readFileSync(backgroundPath, "utf8");
for (const [placeholder, value] of [
  ["__ALIAS_HUB_BASE_URL__", normalizedBase],
  ["__ALIAS_HUB_EXTENSION_KEY__", apiKey],
]) {
  const marker = JSON.stringify(placeholder);
  if (!background.includes(marker)) throw new Error(`Missing extension placeholder: ${placeholder}`);
  background = background.replace(marker, JSON.stringify(value));
}
fs.writeFileSync(backgroundPath, background);

const manifestPath = path.join(buildDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...new Set(manifest.host_permissions.map((value) => (
  value === "__ALIAS_HUB_HOST_PERMISSION__" ? hostPermission : value
)))];
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

for size in 16 32 48 128; do
  convert -background none "$ROOT_DIR/public/aliashub-mark.svg" -resize "${size}x${size}" "$BUILD_DIR/icons/icon-${size}.png"
done

find "$BUILD_DIR" -type d -exec chmod 755 {} +
find "$BUILD_DIR" -type f -exec chmod 644 {} +

rm -f "$OUTPUT_PATH"
(
  cd "$BUILD_DIR"
  zip -qr "$OUTPUT_PATH" .
)

printf 'Extension package: %s\n' "$OUTPUT_PATH"
printf 'Connector key: not embedded; configure it in the extension popup.\n'
