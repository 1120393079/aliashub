"""Retry protocol checkout until the PayPal signup stage is reached."""

from __future__ import annotations

import argparse
import json
import os
import time
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True, type=int)
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
    parser.add_argument("--max-attempts", type=int, default=5)
    parser.add_argument("--wait-seconds", type=int, default=60)
    args = parser.parse_args()

    base_url = str(args.base_url or "").strip().rstrip("/")
    if not base_url:
        parser.error("--base-url must not be empty")
    sms_pool = _load_sms_pool(args.sms_pool_file)
    body = json.dumps(
        {
            "params": {
                "plan": "plus",
                "country": "US",
                "currency": "USD",
                "payment_method": "paypal",
                "auto_checkout": "true",
                "checkout_mode": "protocol",
                "headless": "false",
                "checkout_timeout": 180,
                "sms_pool": sms_pool,
            }
        }
    ).encode("utf-8")
    action_url = f"{base_url}/api/actions/chatgpt/{args.account_id}/payment_link"

    for attempt in range(max(args.max_attempts, 1)):
        req = urllib.request.Request(
            action_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as response:
            task_id = json.loads(response.read())["task_id"]
        print(f"[{attempt + 1}] task: {task_id}")
        time.sleep(max(args.wait_seconds, 0))
        with urllib.request.urlopen(f"{base_url}/api/tasks/{task_id}") as response:
            result = json.loads(response.read())
        error = str(result.get("error") or "")[:300]
        status = result.get("status")
        print(f"    status={status}, error={error}")
        if "accessToken" in error or "paypal_signup" in error.lower():
            print("    -> reached signup stage, stopping retry")
            break
        if status in ("completed", "success"):
            print("    -> SUCCESS")
            break


if __name__ == "__main__":
    main()
