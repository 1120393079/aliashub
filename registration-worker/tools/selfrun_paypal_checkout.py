"""Trigger a PayPal protocol checkout and stream its task events."""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


def _load_sms_pool(path: str) -> str:
    if path:
        value = Path(path).expanduser().read_text(encoding="utf-8")
    else:
        value = os.environ.get("CHATGPT_PAYMENT_SMS_POOL", "")
    if not value.strip():
        raise SystemExit(
            "SMS pool is required; use --sms-pool-file or CHATGPT_PAYMENT_SMS_POOL"
        )
    return value


def http_post(base_url: str, path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base_url + path,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get(base_url: str, path: str) -> dict:
    with urllib.request.urlopen(base_url + path, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_server(base_url: str, retries: int = 20) -> None:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(base_url + "/api/health", timeout=3) as response:
                if response.status == 200:
                    print(f"[selfrun] backend up after {attempt + 1}s")
                    return
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit("[selfrun] backend not reachable")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("account_id", type=int)
    parser.add_argument(
        "--base-url",
        default=os.environ.get(
            "REGISTRATION_WORKER_API_BASE_URL", "http://127.0.0.1:8000"
        ),
    )
    parser.add_argument(
        "--sms-pool-file",
        default=os.environ.get("CHATGPT_PAYMENT_SMS_POOL_FILE", ""),
    )
    args = parser.parse_args()

    base_url = str(args.base_url or "").strip().rstrip("/")
    if not base_url:
        parser.error("--base-url must not be empty")
    sms_pool = _load_sms_pool(args.sms_pool_file)
    wait_server(base_url)

    params = {
        "country": "US",
        "currency": "USD",
        "plan": "plus",
        "auto_checkout": "true",
        "payment_method": "paypal",
        "headless": "false",
        "checkout_mode": "protocol",
        "checkout_timeout": 240,
        "sms_pool": sms_pool,
    }
    print(
        "[selfrun] POST payment_link action "
        f"with {len(sms_pool.splitlines())} SMS rows"
    )
    task = http_post(
        base_url,
        f"/api/actions/chatgpt/{args.account_id}/payment_link",
        {"params": params},
    )
    if "id" not in task:
        print(
            "[selfrun] action returned (sync?): "
            f"{json.dumps(task, ensure_ascii=False)[:500]}"
        )
        return
    task_id = task["id"]
    print(f"[selfrun] task_id={task_id} status={task.get('status')}")

    cursor = 0
    deadline = time.monotonic() + 360.0
    while time.monotonic() < deadline:
        try:
            events = http_get(
                base_url, f"/api/tasks/{task_id}/events?since={cursor}&limit=200"
            )
        except urllib.error.HTTPError as exc:
            print(f"[selfrun] event poll HTTP {exc.code}: {exc.reason}")
            time.sleep(1)
            continue
        for item in events.get("items") or []:
            cursor = max(cursor, int(item.get("id") or 0))
            line = str(item.get("line") or "").strip()
            if line:
                print(f"  {line}")
        try:
            current = http_get(base_url, f"/api/tasks/{task_id}")
        except Exception as exc:
            print(f"[selfrun] task GET failed: {exc}")
            time.sleep(1)
            continue
        status = current.get("status")
        if status in ("succeeded", "failed", "cancelled", "interrupted"):
            print(
                f"[selfrun] terminal status={status} "
                f"error={current.get('error') or ''}"
            )
            return
        time.sleep(1.5)

    print("[selfrun] timeout 6min reached, giving up.")


if __name__ == "__main__":
    main()
