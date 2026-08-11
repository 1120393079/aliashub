#!/usr/bin/env bash
set -euo pipefail

display_number="${LDXP_VERIFY_DISPLAY_NUMBER:-89}"
display=":${display_number}"
vnc_port="${LDXP_VERIFY_VNC_PORT:-5989}"
web_port="${LDXP_VERIFY_WEB_PORT:-6089}"
cdp_port="${LDXP_VERIFY_CDP_PORT:-9289}"
profile_dir="${LDXP_VERIFY_PROFILE_DIR:-/var/lib/mail-pickup/ldxp-browser/interactive}"
state_dir="${LDXP_VERIFY_STATE_DIR:-/var/lib/mail-pickup/ldxp-verification}"

mkdir -p "$profile_dir" "$state_dir"
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"

children=()
cleanup() {
  for pid in "${children[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp >"$state_dir/xvfb.log" 2>&1 &
children+=("$!")

for _ in $(seq 1 100); do
  if [ -S "/tmp/.X11-unix/X${display_number}" ]; then
    break
  fi
  sleep 0.05
done

x11vnc \
  -display "$display" \
  -listen 127.0.0.1 \
  -no6 \
  -rfbport "$vnc_port" \
  -nopw \
  -forever \
  -shared \
  -noxdamage \
  -o "$state_dir/x11vnc.log" &
children+=("$!")

websockify \
  --web=/usr/share/novnc \
  "127.0.0.1:${web_port}" \
  "127.0.0.1:${vnc_port}" \
  >"$state_dir/websockify.log" 2>&1 &
children+=("$!")

DISPLAY="$display" google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$cdp_port" \
  --remote-allow-origins='*' \
  --user-data-dir="$profile_dir" \
  --window-position=0,0 \
  --window-size=1280,800 \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-dev-shm-usage \
  https://www.ldxp.cn/ \
  >"$state_dir/chrome.log" 2>&1 &
chrome_pid="$!"
children+=("$chrome_pid")

wait "$chrome_pid"
