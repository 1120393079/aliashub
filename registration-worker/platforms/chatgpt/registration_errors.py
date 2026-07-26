from __future__ import annotations

import re
from typing import Any


_POLICY_MARKERS = (
    "terms of use",
    "terms of service",
    "policy",
    "cannot create your account",
    "can't create your account",
    "unable to create your account",
    "利用規約",
    "アカウントを作成できません",
    "无法创建您的账户",
    "无法创建你的账户",
)
_POLICY_CODES = {
    "registration_disallowed",
    "policy_violation",
    "terms_of_use",
    "terms_of_use_violation",
    "signup_not_allowed",
    "account_creation_not_allowed",
    "account_creation_blocked",
}


def _clean(value: Any, maximum: int) -> str:
    return re.sub(r"[\x00-\x1f\x7f-\x9f]+", "", str(value or "")).strip()[:maximum]


def extract_create_account_error(*, status: int = 0, payload: Any = None, fallback_text: str = "") -> dict:
    source = payload if isinstance(payload, dict) else {}
    error = source.get("error") if isinstance(source.get("error"), dict) else source
    code = _clean(
        error.get("code")
        or error.get("error_code")
        or source.get("code")
        or source.get("error_code"),
        120,
    )
    message = _clean(
        error.get("message")
        or error.get("detail")
        or source.get("message")
        or source.get("detail")
        or fallback_text,
        500,
    )
    request_id = _clean(
        error.get("request_id")
        or error.get("requestId")
        or source.get("request_id")
        or source.get("requestId"),
        160,
    )
    normalized_code = re.sub(r"[^a-z0-9]+", "_", code.lower()).strip("_")
    normalized_message = message.lower()
    policy_blocked = normalized_code in _POLICY_CODES or any(
        marker in normalized_message for marker in _POLICY_MARKERS
    )
    return {
        "status": int(status or 0),
        "code": code,
        "message": message,
        "request_id": request_id,
        "policy_blocked": policy_blocked,
    }


def format_create_account_error(details: dict, fallback_text: str = "") -> str:
    code = _clean(details.get("code"), 120)
    request_id = _clean(details.get("request_id"), 160)
    message = _clean(details.get("message") or fallback_text, 500)
    parts = []
    if code:
        parts.append(f"error_code: {code}")
    if request_id:
        parts.append(f"request_id: {request_id}")
    if message:
        parts.append(message)
    return " ".join(parts) or "账号创建请求被拒绝"
