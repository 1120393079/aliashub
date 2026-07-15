"""
支付核心逻辑 — 生成 Plus/Team 支付链接、无痕打开浏览器、检测订阅状态
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import string
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, unquote, urlparse

from curl_cffi import requests as cffi_requests

from .card_generator import generate_visa_card
from ._payment_jslib import (
    AUTOCOMPLETE_SUPPRESSOR_JS,
    CHECKOUT_AMOUNT_PROBE_JS,
    HUMAN_LIKE_CLICK_JS,
    STAGE_PROBE_JS,
)

try:
    from camoufox import DefaultAddons
    from camoufox.sync_api import Camoufox
except Exception:  # pragma: no cover
    Camoufox = None
    DefaultAddons = None

# Browser backend 抽象层 —— 让 PayPal checkout / 注册流可以在 Camoufox
# 和 BitBrowser（比特浏览器）之间无差别切换。BitBrowser 通过本地 API
# 启动用户预先建好的 profile（带固定指纹+代理），再用 Playwright
# ``connect_over_cdp`` 接入；CDP 接入后业务代码看到的 page 接口跟
# Camoufox 完全一致，主流程不需要改。
from .._browser_backend import (  # noqa: E402
    BrowserBackendConfig,
    open_browser_backend,
)

# from ..database.models import Account  # removed: external dep

logger = logging.getLogger(__name__)

PAYMENT_CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout"
TEAM_CHECKOUT_BASE_URL = "https://chatgpt.com/checkout/openai_llc/"
WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
ACCOUNTS_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"
SUBSCRIPTIONS_URL = "https://chatgpt.com/backend-api/subscriptions"
WHAM_USAGE_MAX_ATTEMPTS = 3
WHAM_USAGE_RETRY_DELAYS = (0.2, 0.5)
AUTHORITATIVE_STATUS_MAX_ATTEMPTS = 2

# ── Stripe payment_pages init（accessToken → 完整 pay.openai.com 长链）────
# 移植自 gopay-auto-protocol/oaipayy/server.py：在拿到 OpenAI 的
# checkout_session_id 后，显式调 Stripe ``/v1/payment_pages/{cs}/init`` 把
# checkout 实体化成 ``checkout.stripe.com/c/pay/cs_...`` 的 hosted URL，再把
# host 重写成 ``pay.openai.com`` 得到最终长链（cashier_url）。
# 与默认的"直接用 OpenAI 响应里的 url"相比，这条路保证拿到带完整 ``#fid...``
# 片段的长链，纯协议、不开浏览器。OpenAI 的 Stripe live publishable key
# 是公开的（嵌在 checkout JS 里），仅在 OpenAI 响应没回 publishable_key 时兜底。
DEFAULT_STRIPE_PK = (
    "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRac"
    "ViovU3kLKvpkjh7IqkW00iXQsjo3n"
)
DEFAULT_STRIPE_VERSION = (
    "2025-03-31.basil; checkout_server_update_beta=v1; "
    "checkout_manual_approval_preview=v1"
)
DEFAULT_STRIPE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
WHAM_USAGE_USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal"
MEIGUODIZHI_ADDRESS_URL = "https://www.meiguodizhi.com/api/v1/dz"


def _payment_env(name: str) -> str:
    return str(os.environ.get(name, "") or "").strip()


# Legacy constant names remain import-compatible, but contain only deployment
# configuration. Payment/OTP flows validate these values when (and only when)
# the hosted checkout path is reached, so ordinary account registration does
# not depend on payment secrets.
CTF_RELAY_CODE_URL = _payment_env("CHATGPT_PAYMENT_SMS_RELAY_URL")
CTF_PHONE_NUMBER = _payment_env("CHATGPT_PAYMENT_PHONE_E164")
CTF_CARD_NUMBER = _payment_env("CHATGPT_PAYMENT_CARD_NUMBER")
CTF_CARD_EXP_MONTH = _payment_env("CHATGPT_PAYMENT_CARD_EXP_MONTH")
CTF_CARD_EXP_YEAR = _payment_env("CHATGPT_PAYMENT_CARD_EXP_YEAR")
CTF_CARD_CVV = _payment_env("CHATGPT_PAYMENT_CARD_CVV")
CTF_ADDRESS_LINE1 = _payment_env("CHATGPT_PAYMENT_ADDRESS_LINE1")
CTF_ADDRESS_LINE2 = _payment_env("CHATGPT_PAYMENT_ADDRESS_LINE2")
CTF_CITY = _payment_env("CHATGPT_PAYMENT_CITY")
CTF_STATE = _payment_env("CHATGPT_PAYMENT_STATE")
CTF_STATE_NAME = _payment_env("CHATGPT_PAYMENT_STATE_NAME")
CTF_POSTAL_CODE = _payment_env("CHATGPT_PAYMENT_POSTAL_CODE")
CTF_DATE_OF_BIRTH = _payment_env("CHATGPT_PAYMENT_DATE_OF_BIRTH")

_CAMOUFOX_FINGERPRINT_LIMIT = 128
_CAMOUFOX_FINGERPRINT_LOCK = threading.Lock()
_CAMOUFOX_FINGERPRINT_HASHES: list[str] = []

CTF_FIRST_NAMES = (
    "Liam",
    "Mason",
    "Logan",
    "Ethan",
    "Noah",
    "Lucas",
    "Caleb",
    "Owen",
    "Nolan",
    "Ryan",
)
CTF_LAST_NAMES = (
    "Walker",
    "Bennett",
    "Morgan",
    "Parker",
    "Reed",
    "Cooper",
    "Hayes",
    "Sullivan",
    "Brooks",
    "Foster",
)
# 日本姓 / 名（``汉字, 片假名``）—— PayPal hosted guest checkout 签收页要求
# 同时填 ``#firstName`` / ``#lastName``（汉字）和 ``#countrySpecificFirstName``
# / ``#countrySpecificLastName``（片假名）。两组字段必须**字面对应**，
# 否则 PayPal 风控会判"片假名跟汉字不匹配"导致提交失败。
JP_LAST_NAMES = (
    ("佐藤", "サトウ"),
    ("鈴木", "スズキ"),
    ("高橋", "タカハシ"),
    ("田中", "タナカ"),
    ("伊藤", "イトウ"),
    ("渡辺", "ワタナベ"),
    ("山本", "ヤマモト"),
    ("中村", "ナカムラ"),
    ("小林", "コバヤシ"),
    ("加藤", "カトウ"),
    ("吉田", "ヨシダ"),
    ("山田", "ヤマダ"),
    ("佐々木", "ササキ"),
    ("山口", "ヤマグチ"),
    ("松本", "マツモト"),
    ("井上", "イノウエ"),
    ("木村", "キムラ"),
    ("林", "ハヤシ"),
    ("清水", "シミズ"),
    ("山崎", "ヤマザキ"),
)
# 名（``汉字, 片假名, 性别``）—— 性别仅参考，业务上未做拆分。
JP_GIVEN_NAMES = (
    ("翔太", "ショウタ", "M"),
    ("大輔", "ダイスケ", "M"),
    ("健太", "ケンタ", "M"),
    ("拓也", "タクヤ", "M"),
    ("悠真", "ユウマ", "M"),
    ("蓮", "レン", "M"),
    ("陽翔", "ハルト", "M"),
    ("海斗", "カイト", "M"),
    ("直樹", "ナオキ", "M"),
    ("一郎", "イチロウ", "M"),
    ("美咲", "ミサキ", "F"),
    ("葵", "アオイ", "N"),
    ("結衣", "ユイ", "F"),
    ("陽菜", "ヒナ", "F"),
    ("凛", "リン", "F"),
    ("愛莉", "アイリ", "F"),
    ("美月", "ミツキ", "F"),
    ("花音", "カノン", "F"),
    ("真央", "マオ", "F"),
    ("七海", "ナナミ", "F"),
)

_PLAYWRIGHT_PAGEERROR_PATCH_REPLACEMENTS = (
    ('url: pageError.location.url,', 'url: pageError.location?.url || "",'),
    ('line: pageError.location.lineNumber,', 'line: pageError.location?.lineNumber || 0,'),
    ('column: pageError.location.columnNumber', 'column: pageError.location?.columnNumber || 0'),
)

_PLAYWRIGHT_FIREFOX_WEBSOCKET_PATCH = (
    """const request2 = this._webSocketRequests.get(event.requestId);
        assert(request2);
        const response2 = this._webSocketResponses.get(event.requestId);
        assert(response2);""",
    """const request2 = this._webSocketRequests.get(event.requestId);
        const response2 = this._webSocketResponses.get(event.requestId);
        if (!request2 || !response2) {
          this._webSocketRequests.delete(event.requestId);
          this._webSocketResponses.delete(event.requestId);
          this._page.frameManager.onWebSocketRequest(webSocketId(event.frameId, event.wsid));
          return;
        }""",
)


def _playwright_core_bundle_path() -> Path:
    import playwright

    return Path(playwright.__file__).resolve().parent / "driver" / "package" / "lib" / "coreBundle.js"


def _patch_playwright_firefox_pageerror_location_bug(
    *,
    bundle_path: str | Path | None = None,
    log_fn: Callable[[str], None] | None = None,
) -> bool:
    """Patch Playwright's Firefox dispatchers for Camoufox.

    Some Camoufox/Firefox page errors arrive without a location object. The
    bundled Playwright driver dereferences pageError.location.url directly and
    crashes the Node driver process. Firefox can also emit an orphan WebSocket
    open event without the matching request/response events; Playwright asserts
    on that event and terminates the same driver process. This idempotent local
    patch guards both dispatchers so the browser can stay alive.
    """
    log = log_fn or (lambda message: logger.info(message))
    path = Path(bundle_path) if bundle_path is not None else _playwright_core_bundle_path()
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        log(f"Playwright pageerror 热补丁读取失败: {exc}")
        return False

    patched = text
    for old, new in _PLAYWRIGHT_PAGEERROR_PATCH_REPLACEMENTS:
        patched = patched.replace(old, new)
    patched = patched.replace(*_PLAYWRIGHT_FIREFOX_WEBSOCKET_PATCH)
    if patched == text:
        return False
    try:
        path.write_text(patched, encoding="utf-8")
        log("已应用 Playwright Firefox pageerror 热补丁")
        return True
    except Exception as exc:
        log(f"Playwright pageerror 热补丁写入失败: {exc}")
        return False


def _build_proxies(proxy: Optional[str]) -> Optional[dict]:
    if proxy:
        return {"http": proxy, "https": proxy}
    return None


def _normalize_card_expiry(value: str) -> tuple[str, str]:
    parts = re.findall(r"\d+", str(value or ""))
    if len(parts) < 2:
        return "", ""
    first = parts[0]
    second = parts[1]
    try:
        first_num = int(first)
        second_num = int(second)
    except ValueError:
        return "", ""
    if first_num > 12 and 1 <= second_num <= 12:
        first, second = second, first
        first_num = second_num
    if not (1 <= first_num <= 12):
        return "", ""
    month = str(first_num).zfill(2)
    year = str(second)
    if len(year) == 2:
        year = "20" + year
    return month, year


def _normalize_us_billing_address(data: dict, *, email: str = "", country: str = "US") -> dict:
    """规整 ``meiguodizhi.com`` /api/v1/dz 返回的地址。

    JP 接口返回的字段名跟美国接口完全对齐（``Full_Name / Address / City /
    State / Zip_Code / Telephone / Credit_Card_Number / Expires / CVV2``），
    所以 normalize 共用一份；区别只是 ``country`` 字段值（"US" / "JP"）。
    """
    address = data.get("address") if isinstance(data, dict) else {}
    if not isinstance(address, dict):
        address = {}
    card_exp_month, card_exp_year = _normalize_card_expiry(
        str(address.get("Expires") or address.get("expires") or address.get("card_expiry") or "")
    )
    normalized = {
        "name": str(address.get("Full_Name") or address.get("name") or "").strip(),
        "line1": str(address.get("Address") or address.get("line1") or "").strip(),
        "city": str(address.get("City") or address.get("city") or "").strip(),
        "state": str(address.get("State") or address.get("state") or "").strip(),
        "postal_code": str(address.get("Zip_Code") or address.get("postal_code") or "").strip(),
        "phone": str(address.get("Telephone") or address.get("phone") or "").strip(),
        "country": str(country or "US").strip().upper() or "US",
        "email": str(email or address.get("Temporary_mail") or "").strip(),
    }
    card_number = str(
        address.get("Credit_Card_Number")
        or address.get("credit_card_number")
        or address.get("card_number")
        or ""
    ).strip()
    card_cvv = str(address.get("CVV2") or address.get("cvv") or address.get("card_cvv") or "").strip()
    if card_number:
        normalized["card_number"] = card_number
    if card_exp_month:
        normalized["card_exp_month"] = card_exp_month
    if card_exp_year:
        normalized["card_exp_year"] = card_exp_year
    if card_cvv:
        normalized["card_cvv"] = card_cvv
    return normalized


def fetch_us_billing_address(*, email: str = "", use_local_card: bool = True) -> dict:
    """获取美国账单地址（向下兼容入口）。

    地址来自 ``meiguodizhi.com``，但卡号 / 有效期 / CVV 默认改由本地
    :func:`generate_visa_card` 现场生成（Luhn 合规、随机 BIN），原因是
    ``meiguodizhi`` 返回的卡号基本已被使用过，无法通过 PayPal / CTF
    sandbox 注册校验。设置 ``use_local_card=False`` 可保留远端卡数据
    （仅用于测试或对照）。
    """
    return fetch_billing_address("US", email=email, use_local_card=use_local_card)


# ``meiguodizhi.com`` 接口请求体里的 ``path`` 字段对应不同地区的地址数据源。
# JP 路径用户实测可用：``{"path": "/jp-address", "method": "address"}``。
# 接口的字段名跟 US 完全对齐，所以下层 normalize 共用一份。
_BILLING_ADDRESS_REGION_PATHS = {
    "AU": "/au-address",
    "DE": "/de-address",
    "FR": "/fr-address",
    "ID": "/id-address",
    "US": "/",
    "JP": "/jp-address",
    "KR": "/kr-address",
}

# Address seed values adapted from FoundZiGu/GuJumpgate data/address-sources.js
# (MIT License, copyright 2026 whwh1233 / QLHazyCoder and contributors).
_LOCAL_BILLING_ADDRESS_SEEDS = {
    "AU": (
        {
            "line1": "Thyne Reid Drive",
            "city": "Thredbo",
            "state": "New South Wales",
            "postal_code": "2625",
        },
        {
            "line1": "George Street",
            "city": "Sydney",
            "state": "New South Wales",
            "postal_code": "2000",
        },
    ),
    "DE": (
        {
            "line1": "Unter den Linden",
            "city": "Berlin",
            "state": "Berlin",
            "postal_code": "10117",
        },
        {
            "line1": "Marienplatz",
            "city": "Munich",
            "state": "Bavaria",
            "postal_code": "80331",
        },
    ),
    "FR": (
        {
            "line1": "Rue de Rivoli",
            "city": "Paris",
            "state": "Ile-de-France",
            "postal_code": "75001",
        },
        {
            "line1": "Rue de la Republique",
            "city": "Lyon",
            "state": "Auvergne-Rhone-Alpes",
            "postal_code": "69002",
        },
    ),
    "ID": (
        {
            "line1": "Jalan M.H. Thamrin No. 1",
            "city": "Jakarta",
            "state": "DKI Jakarta",
            "postal_code": "10310",
        },
        {
            "line1": "Jalan Jenderal Sudirman Kav. 52-53",
            "city": "Jakarta",
            "state": "DKI Jakarta",
            "postal_code": "12190",
        },
    ),
    "JP": (
        {
            "line1": "Marunouchi 1-1",
            "city": "Chiyoda-ku",
            "state": "Tokyo",
            "postal_code": "100-0005",
        },
        {
            "line1": "Umeda 3-1",
            "city": "Kita-ku",
            "state": "Osaka",
            "postal_code": "530-0001",
        },
    ),
    "KR": (
        {
            "line1": "Sejong-daero 110",
            "city": "Jung-gu",
            "state": "Seoul",
            "postal_code": "04524",
        },
        {
            "line1": "Teheran-ro 152",
            "city": "Gangnam-gu",
            "state": "Seoul",
            "postal_code": "06236",
        },
    ),
    "US": (
        {
            "line1": "Broadway",
            "city": "New York",
            "state": "New York",
            "postal_code": "10007",
        },
    ),
}


def _build_local_billing_address_fallback(
    region_key: str,
    *,
    email: str = "",
    use_local_card: bool = True,
) -> dict:
    normalized_region = str(region_key or "").strip().upper()
    if normalized_region not in _LOCAL_BILLING_ADDRESS_SEEDS:
        normalized_region = "US"
    seed = _LOCAL_BILLING_ADDRESS_SEEDS[normalized_region][0]
    address = {
        "name": "James Smith",
        "line1": seed["line1"],
        "city": seed["city"],
        "state": seed["state"],
        "postal_code": seed["postal_code"],
        "phone": "",
        "country": normalized_region,
        "email": str(email or "").strip(),
        "source": "local_address_seed",
    }
    if use_local_card:
        address.update(generate_visa_card())
    return address


def fetch_billing_address(
    region: str,
    *,
    email: str = "",
    use_local_card: bool = True,
) -> dict:
    """根据地区从 ``meiguodizhi.com`` 拉账单地址。

    支持 ``region="US"`` / ``"JP"`` 等地址种子表里的国家码（大小写不敏感）。
    地区不在白名单时回退到 US，避免上层调用方传错值导致整个 checkout 流程崩。
    ``use_local_card`` 与 :func:`fetch_us_billing_address` 一致：默认仍然用本地
    Luhn-valid Visa 替换远端卡，因为 PayPal hosted checkout 对远端测试卡号
    风控偏严，本地生成的 Luhn 卡过卡号格式校验更稳定（实际扣款由 sandbox 模拟）。
    """
    region_key = str(region or "").strip().upper()
    if region_key not in _BILLING_ADDRESS_REGION_PATHS:
        region_key = "US"
    path = _BILLING_ADDRESS_REGION_PATHS[region_key]
    # 与 generate_plus_link 同理：并发场景下 curl_cffi 首次多线程初始化 SSL
    # 库会偶发 ``curl: (35) ... invalid library`` 竞态。加轻量重试兜底，只对
    # 瞬时 TLS/连接错误重试。
    resp = None
    for attempt in range(1, 4):
        try:
            resp = cffi_requests.post(
                MEIGUODIZHI_ADDRESS_URL,
                json={"path": path, "method": "address"},
                timeout=20,
            )
            resp.raise_for_status()
            break
        except Exception as exc:  # noqa: BLE001 - 需按错误内容判断是否重试
            msg = str(exc).lower()
            transient = (
                "tls connect error" in msg
                or "invalid library" in msg
                or "curl: (35)" in msg
                or "curl: (56)" in msg
                or "connection reset" in msg
                or "failed to perform" in msg
            )
            if attempt >= 3 or not transient:
                return _build_local_billing_address_fallback(
                    region_key,
                    email=email,
                    use_local_card=use_local_card,
                )
            time.sleep(0.5 * (2 ** (attempt - 1)))
    if resp is None:
        return _build_local_billing_address_fallback(
            region_key,
            email=email,
            use_local_card=use_local_card,
        )
    data = resp.json()
    address = _normalize_us_billing_address(
        data if isinstance(data, dict) else {},
        email=email,
        country=region_key,
    )
    required = ("name", "line1", "city", "state", "postal_code")
    missing = [key for key in required if not address.get(key)]
    if missing:
        return _build_local_billing_address_fallback(
            region_key,
            email=email,
            use_local_card=use_local_card,
        )
    if use_local_card:
        address.update(generate_visa_card())
    return address


_COUNTRY_CURRENCY_MAP = {
    "SG": "SGD",
    "US": "USD",
    "TR": "TRY",
    "JP": "JPY",
    "HK": "HKD",
    "GB": "GBP",
    "EU": "EUR",
    "AU": "AUD",
    "CA": "CAD",
    "IN": "INR",
    "ID": "IDR",
    "BR": "BRL",
    "MX": "MXN",
}


def _extract_oai_did(cookies_str: str) -> Optional[str]:
    """从 cookie 字符串中提取 oai-device-id"""
    for part in cookies_str.split(";"):
        part = part.strip()
        if part.startswith("oai-did="):
            return part[len("oai-did="):].strip()
    return None


def _resolve_currency(country: str, currency: str | None = None) -> str:
    selected = str(currency or "").strip().upper()
    if selected:
        return selected
    return _COUNTRY_CURRENCY_MAP.get(str(country or "").strip().upper(), "USD")


def _extract_checkout_url(data: dict) -> str:
    for key in ("url", "stripe_hosted_url", "checkout_url"):
        value = str(data.get(key) or "").strip()
        if value:
            return value
    session_id = str(data.get("checkout_session_id") or "").strip()
    if session_id:
        return TEAM_CHECKOUT_BASE_URL + session_id
    return ""


def _extract_chatgpt_account_id(account) -> str:
    direct_candidates = [
        getattr(account, "chatgpt_account_id", ""),
    ]
    extra = getattr(account, "extra", {}) or {}
    if isinstance(extra, dict):
        direct_candidates.extend(
            [
                extra.get("account_id", ""),
                extra.get("accountId", ""),
                extra.get("chatgpt_account_id", ""),
                extra.get("chatgptAccountId", ""),
            ]
        )
    for candidate in direct_candidates:
        text = str(candidate or "").strip()
        if text:
            return text

    token_candidates = [
        getattr(account, "access_token", ""),
        getattr(account, "id_token", ""),
    ]
    if isinstance(extra, dict):
        token_candidates.extend(
            [
                extra.get("access_token", ""),
                extra.get("accessToken", ""),
                extra.get("id_token", ""),
                extra.get("idToken", ""),
            ]
        )
    from platforms.chatgpt.oauth import _jwt_claims_no_verify

    for token in token_candidates:
        parsed = token if isinstance(token, dict) else None
        if isinstance(token, str) and token.strip().startswith("{"):
            try:
                parsed = json.loads(token)
            except Exception:
                parsed = None
        if parsed is None and isinstance(token, str):
            parsed = _jwt_claims_no_verify(token)
        if not isinstance(parsed, dict):
            continue
        auth = parsed.get("https://api.openai.com/auth")
        nodes = [parsed, auth] if isinstance(auth, dict) else [parsed]
        for node in nodes:
            for key in ("chatgpt_account_id", "chatgptAccountId", "account_id", "accountId"):
                value = str(node.get(key) or "").strip()
                if value:
                    return value
    return ""


_CONCLUSIVE_ACCOUNT_CODES = {
    "account_banned": "banned",
    "account_deactivated": "invalid",
    "account_deleted": "invalid",
    "account_disabled": "invalid",
    "account_suspended": "suspended",
    "user_banned": "banned",
    "user_deactivated": "invalid",
    "user_deleted": "invalid",
    "user_disabled": "invalid",
    "user_suspended": "suspended",
    "access_token_expired": "expired",
    "authentication_expired": "expired",
    "invalid_token": "expired",
    "session_expired": "expired",
    "token_expired": "expired",
    "auth_revoked": "invalid",
    "authentication_revoked": "invalid",
    "credentials_revoked": "invalid",
    "session_revoked": "invalid",
    "token_revoked": "invalid",
}
_ACCOUNT_STATUS_REASONS = {
    "account_banned": "账号已被封禁",
    "account_deactivated": "账号已被停用",
    "account_deleted": "账号已被删除",
    "account_disabled": "账号已被禁用",
    "account_suspended": "账号已被暂停",
    "user_banned": "用户已被封禁",
    "user_deactivated": "用户已被停用",
    "user_deleted": "用户已被删除",
    "user_disabled": "用户已被禁用",
    "user_suspended": "用户已被暂停",
    "access_token_expired": "Access Token 已过期",
    "authentication_expired": "登录凭据已过期",
    "invalid_token": "Access Token 已失效",
    "session_expired": "登录会话已过期",
    "token_expired": "Access Token 已过期",
    "auth_revoked": "登录授权已撤销",
    "authentication_revoked": "登录授权已撤销",
    "credentials_revoked": "账号凭据已撤销",
    "session_revoked": "登录会话已撤销",
    "token_revoked": "Access Token 已撤销",
}


class ConclusiveAccountStatusError(RuntimeError):
    def __init__(
        self,
        *,
        result: str,
        code: str,
        reason: str,
        source: str,
        account_state: str = "unknown",
        credential_state: str = "unknown",
        http_status: int = 0,
        evidence_path: str = "",
    ):
        super().__init__(reason)
        self.result = result
        self.code = code
        self.reason = reason
        self.source = source
        self.account_state = account_state
        self.credential_state = credential_state
        self.http_status = http_status
        self.evidence_path = evidence_path
        self.retryable = False


class StatusCheckInconclusiveError(RuntimeError):
    def __init__(
        self,
        *,
        code: str,
        reason: str,
        source: str = "",
        retryable: bool = True,
        http_status: int = 0,
        evidence_path: str = "",
    ):
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.source = source
        self.retryable = retryable
        self.http_status = http_status
        self.evidence_path = evidence_path


def _failure_axes(code: str) -> tuple[str, str]:
    if code.startswith("account_") or code.startswith("user_"):
        state = code.rsplit("_", 1)[-1]
        if state in {"disabled", "banned", "suspended", "deleted", "deactivated"}:
            return state, "unknown"
    if "revoked" in code or code == "invalid_token":
        return "unknown", "revoked"
    if "expired" in code:
        return "unknown", "expired"
    return "unknown", "unknown"


def _normalize_status_code(value: Any) -> str:
    raw = str(value or "").strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "_", raw).strip("_")
    return normalized[:80]


def _conclusive_account_failure(response: Any, *, source: str) -> ConclusiveAccountStatusError | None:
    status_code = int(getattr(response, "status_code", 0) or 0)
    if status_code in {408, 425, 429} or status_code >= 500:
        return None
    try:
        payload = response.json()
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None

    nodes: list[tuple[str, dict[str, Any]]] = [("response", payload)]
    for parent_name in ("error", "detail", "account", "user", "auth", "authentication"):
        parent = payload.get(parent_name)
        if isinstance(parent, dict):
            nodes.append((parent_name, parent))
            for child_name in ("account", "user", "auth", "authentication"):
                child = parent.get(child_name)
                if isinstance(child, dict):
                    nodes.append((f"{parent_name}.{child_name}", child))

    for node_name, node in nodes:
        context = node_name.rsplit(".", 1)[-1]
        account_context = context in {"account", "user", "auth", "authentication"}
        for field_name in ("code", "error_code", "type", "reason", "status"):
            code = _normalize_status_code(node.get(field_name))
            result = _CONCLUSIVE_ACCOUNT_CODES.get(code)
            if result:
                account_state, credential_state = _failure_axes(code)
                return ConclusiveAccountStatusError(
                    result=result,
                    code=code,
                    reason=_ACCOUNT_STATUS_REASONS[code],
                    source=source,
                    account_state=account_state,
                    credential_state=credential_state,
                    http_status=status_code,
                    evidence_path=f"{node_name}.{field_name}",
                )
            if account_context and field_name in {"reason", "status"}:
                contextual_code = {
                    "banned": "account_banned",
                    "deactivated": "account_deactivated",
                    "deleted": "account_deleted",
                    "disabled": "account_disabled",
                    "expired": "authentication_expired",
                    "revoked": "auth_revoked",
                    "suspended": "account_suspended",
                }.get(code)
                if contextual_code:
                    account_state, credential_state = _failure_axes(contextual_code)
                    return ConclusiveAccountStatusError(
                        result=_CONCLUSIVE_ACCOUNT_CODES[contextual_code],
                        code=contextual_code,
                        reason=_ACCOUNT_STATUS_REASONS[contextual_code],
                        source=source,
                        account_state=account_state,
                        credential_state=credential_state,
                        http_status=status_code,
                        evidence_path=f"{node_name}.{field_name}",
                    )
        for flag_name in (
            "account_banned", "account_deactivated", "account_deleted", "account_disabled",
            "account_suspended", "user_banned", "user_deactivated", "user_deleted",
            "user_disabled", "user_suspended", "auth_revoked", "authentication_revoked",
            "credentials_revoked", "session_revoked", "token_revoked",
        ):
            if node.get(flag_name) is True:
                account_state, credential_state = _failure_axes(flag_name)
                return ConclusiveAccountStatusError(
                    result=_CONCLUSIVE_ACCOUNT_CODES[flag_name],
                    code=flag_name,
                    reason=_ACCOUNT_STATUS_REASONS[flag_name],
                    source=source,
                    account_state=account_state,
                    credential_state=credential_state,
                    http_status=status_code,
                    evidence_path=f"{node_name}.{flag_name}",
                )
    return None


def _raise_conclusive_account_failure(response: Any, *, source: str) -> None:
    evidence = _conclusive_account_failure(response, source=source)
    if evidence:
        raise evidence


def _raise_inconclusive_http_failure(response: Any, *, source: str) -> None:
    status_code = int(getattr(response, "status_code", 0) or 0)
    if status_code < 400:
        return
    if status_code in {408, 425}:
        code, reason = "check_timeout", "上游状态检测超时，已保留上次结果"
    elif status_code == 429:
        code, reason = "rate_limited", "上游请求频率受限，已保留上次结果"
    elif status_code >= 500:
        code, reason = "upstream_unavailable", "上游服务暂时不可用，已保留上次结果"
    elif status_code in {401, 403}:
        code, reason = "auth_unauthorized_unconfirmed", "上游授权失败但证据不足，已保留上次结果"
    else:
        code, reason = "upstream_rejected", "上游拒绝状态检测请求，已保留上次结果"
    raise StatusCheckInconclusiveError(
        code=code,
        reason=reason,
        source=source,
        http_status=status_code,
        evidence_path="http.status",
    )


def _recognized_subscription_plan(plan: str) -> str | None:
    raw = str(plan or "").strip().lower()
    if not raw:
        return None
    compact = re.sub(r"[^a-z0-9]+", "", raw)
    aliases = {
        "free": {"free", "basic", "starter", "hobby", "chatgptfree", "chatgptfreeplan"},
        "go": {"go", "goplan", "chatgptgo", "chatgptgoplan"},
        "plus": {"plus", "premium", "chatgptplus", "chatgptplusplan"},
        "pro": {"pro", "proplan", "chatgptpro", "chatgptproplan"},
        "team": {"team", "teamplan", "chatgptteam", "chatgptteamplan"},
        "business": {"business", "businessplan", "chatgptbusiness", "chatgptbusinessplan"},
        "enterprise": {
            "enterprise", "enterpriseplan", "chatgptenterprise", "chatgptenterpriseplan",
            "corporate", "corporateplan",
        },
        "edu": {"edu", "eduplan", "education", "chatgptedu", "chatgpteduplan"},
        "trial": {"trial", "trialing", "freetrial", "chatgpttrial"},
    }
    exact = next((family for family, values in aliases.items() if compact in values), None)
    if exact:
        return exact
    tokens = set(re.findall(r"[a-z0-9]+", raw))
    token_aliases = (
        ("enterprise", {"enterprise", "corporate"}),
        ("business", {"business"}),
        ("team", {"team"}),
        ("edu", {"edu", "education"}),
        ("pro", {"pro"}),
        ("plus", {"plus", "premium"}),
        ("go", {"go"}),
        ("trial", {"trial", "trialing"}),
        ("free", {"free", "basic", "starter", "hobby"}),
    )
    return next((family for family, values in token_aliases if tokens & values), None)


def _raw_subscription_plan(plan: Any) -> str:
    raw = str(plan or "").strip().lower()
    return re.sub(r"[^a-z0-9]+", "_", raw).strip("_")[:64]


def _normalize_subscription_plan(plan: str) -> str:
    recognized = _recognized_subscription_plan(plan)
    if recognized:
        return recognized
    return "other" if _raw_subscription_plan(plan) else "unknown"


def _subscription_state_from_plan(plan: Any, family: str = "") -> str:
    compact = re.sub(r"[^a-z0-9]+", "", str(plan or "").strip().lower())
    if compact in {"expired", "subscriptionexpired", "planexpired", "ended"}:
        return "expired"
    if compact in {"cancelled", "canceled"}:
        return "canceled"
    if compact in {"pastdue", "past_due"}:
        return "past_due"
    if family == "free":
        return "free"
    if family == "trial":
        return "trialing"
    if family not in {"", "unknown"}:
        return "active"
    return "unknown"


def _plan_observation(value: Any, *, source: str, scope: str) -> dict[str, Any] | None:
    raw = _raw_subscription_plan(value)
    if not raw:
        return None
    family = _recognized_subscription_plan(value) or "unknown"
    return {
        "plan_family": family,
        "plan_code_raw": raw,
        "subscription_state": _subscription_state_from_plan(value, family),
        "source": source,
        "scope": scope,
    }


def _subscription_details_from_me(data: dict) -> dict[str, Any]:
    plans: list[dict[str, Any]] = []
    top = _plan_observation(data.get("plan_type"), source="backend-api/me", scope="personal")
    if top:
        plans.append(top)
    org_container = data.get("orgs")
    orgs = org_container.get("data", []) if isinstance(org_container, dict) else (
        org_container if isinstance(org_container, list) else []
    )
    if isinstance(orgs, list):
        for org in orgs:
            if not isinstance(org, dict):
                continue
            settings_ = org.get("settings") if isinstance(org.get("settings"), dict) else {}
            observation = _plan_observation(
                settings_.get("workspace_plan_type"),
                source="backend-api/me",
                scope="workspace",
            )
            if observation:
                observation["workspace_id"] = str(org.get("id") or org.get("account_id") or "")[:80]
                plans.append(observation)
    rank = {
        "enterprise": 90, "business": 80, "team": 70, "edu": 60,
        "pro": 50, "plus": 40, "go": 30, "trial": 20, "free": 10,
        "unknown": 1,
    }
    primary = max(plans, key=lambda item: rank.get(item["plan_family"], 1), default=None)
    return {
        "status": (primary or {}).get("plan_family", "unknown"),
        "account_type_raw": (primary or {}).get("plan_code_raw", ""),
        "subscription_state": (primary or {}).get("subscription_state", "unknown"),
        "plans": plans,
    }


def _subscription_status_from_me(data: dict) -> str:
    details = _subscription_details_from_me(data)
    return details["status"] if details["status"] != "unknown" else (
        "other" if details["account_type_raw"] else "unknown"
    )


def _subscription_status_from_usage(data: dict) -> str:
    return _normalize_subscription_plan(data.get("plan_type"))


def _usage_account_id(data: dict[str, Any]) -> str:
    for key in ("account_id", "accountId", "chatgpt_account_id", "chatgptAccountId"):
        value = str(data.get(key) or "").strip()
        if value:
            return value
    account = data.get("account")
    if isinstance(account, dict):
        return _usage_account_id(account)
    return ""


def _status_api_headers(account, account_id: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {account.access_token}",
        "Chatgpt-Account-Id": account_id,
        "Accept": "application/json",
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/",
        "User-Agent": WHAM_USAGE_USER_AGENT,
    }


def _fetch_authoritative_status_data(
    account,
    *,
    account_id: str,
    url: str,
    source: str,
    proxy: Optional[str] = None,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(AUTHORITATIVE_STATUS_MAX_ATTEMPTS):
        try:
            response = cffi_requests.get(
                url,
                headers=_status_api_headers(account, account_id),
                params=params,
                proxies=_build_proxies(proxy),
                timeout=20,
                impersonate="chrome124",
            )
            payload = None
            try:
                payload = response.json()
            except Exception:
                pass
            status_code = int(getattr(response, "status_code", 0) or 0)
            if source == "backend-api/subscriptions" and status_code == 404:
                detail = str((payload or {}).get("detail") or "") if isinstance(payload, dict) else ""
                if "no subscription found for account" in detail.lower():
                    return {"_no_subscription": True}
            _raise_conclusive_account_failure(response, source=source)
            _raise_inconclusive_http_failure(response, source=source)
            response.raise_for_status()
            if not isinstance(payload, dict):
                raise StatusCheckInconclusiveError(
                    code="response_unrecognized",
                    reason="上游状态响应格式异常，已保留上次结果",
                    source=source,
                    evidence_path="response.body",
                )
            return payload
        except ConclusiveAccountStatusError:
            raise
        except StatusCheckInconclusiveError as exc:
            last_error = exc
            if not exc.retryable:
                raise
        except Exception as exc:
            last_error = StatusCheckInconclusiveError(
                code="network_error",
                reason="权威套餐接口网络异常，已保留上次结果",
                source=source,
                evidence_path="request",
            )
            last_error.__cause__ = exc

        if attempt + 1 < AUTHORITATIVE_STATUS_MAX_ATTEMPTS:
            time.sleep(WHAM_USAGE_RETRY_DELAYS[0])

    if last_error is not None:
        raise last_error
    raise StatusCheckInconclusiveError(
        code="check_inconclusive",
        reason="权威套餐接口未得出可靠结论，已保留上次结果",
        source=source,
    )


def _fetch_accounts_check_data(account, account_id: str, proxy: Optional[str] = None) -> dict[str, Any]:
    data = _fetch_authoritative_status_data(
        account,
        account_id=account_id,
        url=ACCOUNTS_CHECK_URL,
        source="backend-api/accounts/check",
        proxy=proxy,
    )
    accounts = data.get("accounts")
    if not isinstance(accounts, dict) or account_id not in accounts:
        raise StatusCheckInconclusiveError(
            code="account_identity_mismatch",
            reason="权威状态响应缺少当前账号的精确 workspace 节点，已保留上次结果",
            source="backend-api/accounts/check",
            retryable=False,
            evidence_path="response.accounts[account_id]",
        )
    if not isinstance(accounts[account_id], dict):
        raise StatusCheckInconclusiveError(
            code="response_unrecognized",
            reason="权威账号状态节点格式异常，已保留上次结果",
            source="backend-api/accounts/check",
            evidence_path="response.accounts[account_id]",
        )
    return data


def _fetch_subscriptions_data(account, account_id: str, proxy: Optional[str] = None) -> dict[str, Any]:
    data = _fetch_authoritative_status_data(
        account,
        account_id=account_id,
        url=SUBSCRIPTIONS_URL,
        source="backend-api/subscriptions",
        proxy=proxy,
        params={"account_id": account_id},
    )
    if data.get("_no_subscription") is True:
        return data
    response_account_id = str(data.get("account_id") or data.get("id") or "").strip()
    if not response_account_id or response_account_id != account_id:
        raise StatusCheckInconclusiveError(
            code="account_identity_mismatch",
            reason="订阅响应与当前账号 workspace 不匹配，已保留上次结果",
            source="backend-api/subscriptions",
            retryable=False,
            evidence_path="response.account_id",
        )
    return data


def _accounts_check_plan_signal(data: dict[str, Any], account_id: str) -> dict[str, Any]:
    node = data["accounts"][account_id]
    account_data = node.get("account") if isinstance(node.get("account"), dict) else {}
    entitlement = node.get("entitlement") if isinstance(node.get("entitlement"), dict) else {}
    account_observation = _plan_observation(
        account_data.get("plan_type"),
        source="backend-api/accounts/check",
        scope="account",
    )
    entitlement_observation = _plan_observation(
        entitlement.get("subscription_plan"),
        source="backend-api/accounts/check",
        scope="entitlement",
    )
    entitlement_active = entitlement.get("has_active_subscription")
    paid_observation = None
    if (
        entitlement_active is True
        and entitlement_observation
        and entitlement_observation["plan_family"] != "free"
    ):
        paid_observation = entitlement_observation
    elif account_observation and account_observation["plan_family"] != "free":
        paid_observation = account_observation
    elif entitlement_observation and entitlement_observation["plan_family"] != "free":
        paid_observation = entitlement_observation

    if paid_observation:
        paid_observation = dict(paid_observation)
        paid_observation["evidence_path"] = (
            "accounts[account_id].entitlement.subscription_plan"
            if paid_observation.get("scope") == "entitlement"
            else "accounts[account_id].account.plan_type"
        )
        if entitlement_active is True:
            paid_observation["subscription_state"] = (
                "trialing" if paid_observation["plan_family"] == "trial" else "active"
            )
        elif entitlement_active is False:
            paid_observation["subscription_state"] = "expired"

    free_inactive = bool(
        account_observation
        and account_observation["plan_family"] == "free"
        and entitlement_observation
        and entitlement_observation["plan_family"] == "free"
        and entitlement_active is False
    )
    free_observation = dict(account_observation) if free_inactive else None
    if free_observation:
        free_observation["subscription_state"] = "free"
        free_observation["evidence_path"] = "accounts[account_id].account.plan_type+entitlement"
    return {
        "paid_observation": paid_observation,
        "free_observation": free_observation,
        "free_inactive": free_inactive,
    }


def _subscriptions_plan_signal(data: dict[str, Any]) -> dict[str, Any] | None:
    if data.get("_no_subscription") is True:
        return None
    observation = _plan_observation(
        data.get("plan_type"),
        source="backend-api/subscriptions",
        scope="subscription",
    )
    if not observation:
        return None
    observation = dict(observation)
    observation["evidence_path"] = "response.plan_type"
    if data.get("is_delinquent") is True:
        observation["subscription_state"] = "past_due"
    elif observation["plan_family"] == "free":
        observation["subscription_state"] = "free"
    elif observation["plan_family"] == "trial":
        observation["subscription_state"] = "trialing"
    else:
        observation["subscription_state"] = "active"
    return observation


def _fetch_usage_data(
    account,
    proxy: Optional[str] = None,
    *,
    max_attempts: int = WHAM_USAGE_MAX_ATTEMPTS,
    require_identity: bool = False,
) -> dict:
    if not account.access_token:
        raise ValueError("账号缺少 access_token")

    headers = {
        "Authorization": f"Bearer {account.access_token}",
        "User-Agent": WHAM_USAGE_USER_AGENT,
    }
    chatgpt_account_id = _extract_chatgpt_account_id(account)
    if require_identity and not chatgpt_account_id:
        raise StatusCheckInconclusiveError(
            code="account_identity_missing",
            reason="账号缺少 workspace ID，无法核对套餐响应",
            source="backend-api/wham/usage",
            retryable=False,
            evidence_path="credentials.account_id",
        )
    if chatgpt_account_id:
        headers["Chatgpt-Account-Id"] = chatgpt_account_id

    attempts = max(1, min(int(max_attempts or 1), 5))
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            resp = cffi_requests.get(
                WHAM_USAGE_URL,
                headers=headers,
                proxies=_build_proxies(proxy),
                timeout=20,
                impersonate="chrome124",
            )
            _raise_conclusive_account_failure(resp, source="backend-api/wham/usage")
            _raise_inconclusive_http_failure(resp, source="backend-api/wham/usage")
            resp.raise_for_status()
            try:
                data = resp.json()
            except Exception as exc:
                raise StatusCheckInconclusiveError(
                    code="response_unrecognized",
                    reason="上游返回了无法识别的状态响应，已保留上次结果",
                    source="backend-api/wham/usage",
                    evidence_path="response.json",
                ) from exc
            if not isinstance(data, dict):
                raise StatusCheckInconclusiveError(
                    code="response_unrecognized",
                    reason="上游状态响应格式异常，已保留上次结果",
                    source="backend-api/wham/usage",
                    evidence_path="response.body",
                )
            response_account_id = _usage_account_id(data)
            if require_identity and response_account_id != chatgpt_account_id:
                raise StatusCheckInconclusiveError(
                    code="account_identity_mismatch",
                    reason="套餐响应缺少当前账号的精确 workspace 身份，已保留上次结果",
                    source="backend-api/wham/usage",
                    retryable=False,
                    evidence_path="response.account_id",
                )
            if chatgpt_account_id and response_account_id and response_account_id != chatgpt_account_id:
                raise StatusCheckInconclusiveError(
                    code="account_identity_mismatch",
                    reason="状态响应与当前账号 workspace 不匹配，已保留上次结果",
                    source="backend-api/wham/usage",
                    retryable=False,
                    evidence_path="response.account_id",
                )
            return data
        except ConclusiveAccountStatusError:
            raise
        except StatusCheckInconclusiveError as exc:
            last_error = exc
            if not exc.retryable:
                raise
        except Exception as exc:
            last_error = StatusCheckInconclusiveError(
                code="network_error",
                reason="套餐状态接口网络异常，已保留上次结果",
                source="backend-api/wham/usage",
                evidence_path="request",
            )
            last_error.__cause__ = exc

        if attempt + 1 < attempts:
            delay_index = min(attempt, len(WHAM_USAGE_RETRY_DELAYS) - 1)
            time.sleep(WHAM_USAGE_RETRY_DELAYS[delay_index])

    if last_error is not None:
        raise last_error
    raise StatusCheckInconclusiveError(
        code="check_inconclusive",
        reason="套餐状态检测未得出可靠结论，已保留上次结果",
        source="backend-api/wham/usage",
    )


def _parse_cookie_str(cookies_str: str, domain: str) -> list:
    """将 'key=val; key2=val2' 格式解析为 Playwright cookie 列表"""
    cookies = []
    # Playwright对于部分域名的cookie要求首字母带点
    if domain == "chatgpt.com":
        domain = ".chatgpt.com"

    for part in cookies_str.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        cookie_name = name.strip()

        cookie_obj = {
            "name": cookie_name,
            "value": value.strip(),
            "domain": domain,
            "path": "/",
        }

        # Chromium/Playwright: prefix __Secure- 开头的 cookie 必须携带 secure: True 的 flag
        if cookie_name.startswith("__Secure-"):
            cookie_obj["secure"] = True

        cookies.append(cookie_obj)
    return cookies


def _build_camoufox_proxy(proxy: Optional[str]) -> Optional[dict]:
    if not proxy:
        return None
    proxy = str(proxy).strip()
    if not proxy:
        return None
    if "://" not in proxy:
        if "@" in proxy:
            auth, hostport = proxy.rsplit("@", 1)
            username, sep, password = auth.partition(":")
            config = {"server": f"http://{hostport}"}
            if username:
                config["username"] = unquote(username)
            if sep:
                config["password"] = unquote(password)
            return config
        parts = proxy.split(":", 3)
        if len(parts) == 2 and parts[1].isdigit():
            return {"server": f"http://{proxy}"}
        if len(parts) == 4 and parts[1].isdigit():
            host, port, username, password = parts
            config = {"server": f"http://{host}:{port}"}
            if username:
                config["username"] = unquote(username)
            if password:
                config["password"] = unquote(password)
            return config
    parsed = urlparse(proxy)
    if not parsed.scheme or not parsed.hostname or not parsed.port:
        return {"server": proxy}
    config = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        config["username"] = unquote(parsed.username)
    if parsed.password:
        config["password"] = unquote(parsed.password)
    return config


def _mask_proxy(proxy: str | None) -> str:
    value = str(proxy or "").strip()
    if not value or "@" not in value:
        return value
    prefix, _, host = value.rpartition("@")
    scheme, sep, _credentials = prefix.partition("://")
    return f"{scheme}{sep}***@{host}" if sep else f"***@{host}"


def _probe_camoufox_proxy_exit(page, *, log: Callable[[str], None]) -> dict:
    for url in ("https://api.ipify.org?format=json", "https://httpbin.org/ip"):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            text = str(page.locator("body").inner_text(timeout=5000) or "").strip()
            data = json.loads(text)
            ip = str(data.get("ip") or data.get("origin") or "").strip()
            if ip:
                log(f"Camoufox 代理出口检测: {ip} ({url})")
                return {"ok": True, "ip": ip, "source": url}
        except Exception as exc:
            log(f"Camoufox 代理出口检测失败: {url} {exc}")
    return {"ok": False, "ip": "", "source": ""}


def _locator_ready(locator) -> bool:
    try:
        if hasattr(locator, "count") and locator.count() <= 0:
            return False
        if hasattr(locator, "is_visible") and not locator.is_visible():
            return False
        if hasattr(locator, "is_enabled") and not locator.is_enabled():
            return False
        return True
    except Exception:
        return False


def _locator_visible(locator) -> bool:
    try:
        if hasattr(locator, "count") and locator.count() <= 0:
            return False
        if hasattr(locator, "is_visible") and not locator.is_visible():
            return False
        return True
    except Exception:
        return False


def _document_ready_state(page) -> str:
    try:
        state = page.evaluate("() => document.readyState")
        return str(state or "").strip().lower()
    except Exception:
        return ""


def _click_or_check(locator) -> None:
    try:
        tag_name = str(locator.evaluate("(el) => el.tagName") or "").lower()
    except Exception:
        tag_name = ""
    if tag_name == "input":
        try:
            locator.check(timeout=3000, force=True)
            return
        except Exception:
            pass
    locator.click(timeout=3000, force=True)


def _human_click_via_js(page, selector: str, *, log: Callable[[str], None]) -> bool:
    """对付 hidden / tabindex=-1 / 被遮挡 元素的拟人点击兜底。

    Playwright ``Locator.click()`` 即便 ``force=True`` 也救不了 hidden
    input 这种 actionability check 失败的情况——3s 必超时。这里直接走
    JS 派发完整 PointerEvent + MouseEvent 序列，再调 ``el.click()`` /
    ``form.requestSubmit(el)``，绕开所有 actionability 检查。

    JS 详细逻辑见 ``_payment_jslib.HUMAN_LIKE_CLICK_JS``。

    返回 True/False；不抛异常（让调用方继续走下一个候选）。
    """
    try:
        result = page.evaluate(HUMAN_LIKE_CLICK_JS, selector)
    except Exception as exc:
        log(f"拟人点击 evaluate 失败 ({selector!r}): {exc}")
        return False
    if isinstance(result, dict) and result.get("ok"):
        log(f"拟人点击命中 {selector!r}: tag={result.get('tag', '')}")
        return True
    return False


def _try_click_paypal(page) -> bool:
    """点击结账页上的 "PayPal" 支付方式。

    **关键改动**（hidden input 超时回归）：

    1. **点击 label 而非 hidden input**。Stripe 结账页里 PayPal radio 是
       ``<input type="radio" tabindex="-1" id="payment-method-...-paypal" />``
       搭配 ``<label for="...-paypal">PayPal</label>`` 渲染——真正可见可点的
       是 label，input 本体被 CSS 隐藏。直接 click input 即便 ``force=True``
       也会因 actionability check 而 3s 超时。``page.get_by_label`` 命中的
       是 label，能正常 dispatch click。

    2. **单个 locator 失败时继续尝试下一个候选**。之前一个 locator click
       超时就直接抛出，但其实后面还有更宽松的候选（``[data-testid*=paypal]``
       容器、``input[value=paypal]`` 等）。现在改成"任意候选成功就 return
       True"，所有候选都失败才抛错。
    """
    paypal_pattern = re.compile(r"paypal|pay\s*pal|贝宝", re.I)
    factories = (
        # 先点 label 容器（visible，dispatch click 最稳）
        lambda: page.get_by_label(paypal_pattern).first,
        # 然后是 role=radio / role=button（依赖 accessible name）
        lambda: page.get_by_role("radio", name=paypal_pattern).first,
        lambda: page.get_by_role("button", name=paypal_pattern).first,
        # 通用 testid / id 容器
        lambda: page.locator('[data-testid*="paypal" i]').first,
        lambda: page.locator('[id*="paypal" i]:not(input)').first,
        # 文本回退（dismiss-prone, 放最后）
        lambda: page.get_by_text(paypal_pattern).first,
        # 最后兜底：直接点 hidden input（force=True，多数会超时但仍是合理回退）
        lambda: page.locator('input[value="paypal"]').first,
    )
    last_exc: Exception | None = None
    for factory in factories:
        try:
            locator = factory()
        except Exception as exc:
            last_exc = exc
            continue
        if not _locator_ready(locator):
            continue
        try:
            _click_or_check(locator)
        except Exception as exc:
            # 某个候选 click 超时 / 被覆盖等都正常，继续试下一个
            last_exc = exc
            continue
        try:
            page.wait_for_timeout(800)
        except Exception:
            pass
        return True
    # 全部 Playwright Locator 候选都失败 → 走 JS 拟人点击兜底
    # （针对 Stripe hidden radio + tabindex=-1，actionability check 永远不过）
    js_log: list[str] = []
    for selector in (
        '[data-testid*="paypal" i]',
        'label[for*="paypal" i]',
        'input[value="paypal" i]',
        '[id*="paypal" i]:not(input)',
    ):
        if _human_click_via_js(page, selector, log=js_log.append):
            try:
                page.wait_for_timeout(800)
            except Exception:
                pass
            return True
    if last_exc is not None:
        raise RuntimeError(f"未找到可点击的 PayPal 支付方式: {last_exc}")
    raise RuntimeError("未找到 PayPal 支付方式")


def _verify_checkout_amount_nonzero(page, *, log: Callable[[str], None]) -> None:
    """检查支付页显示的订阅金额是否 > 0。

    实战痛点：偶尔 Stripe checkout 渲染出来的金额是 ``$0.00 / month`` 或
    ``Total $0``——可能是券码错乱、计费配置失败、Stripe 后端瞬态异常。继续
    走完流程也不会真扣 / 真升级 Plus，所以**直接判失败**让外层调度立刻
    换 worker 重试。

    实现：抠 ``[data-testid*=order-summary] / [data-testid*=total]`` 等常见
    金额容器的文本，匹配 ``$X.XX`` 或 ``X 元`` / ``CN¥X.XX`` 等货币格式。
    至少一个金额 > 0 视为 OK。**所有**金额都是 0 才 raise；抠不到任何金额
    （DOM 变化）只 log warning，不阻塞——避免误杀。

    **注意**：本函数语义跟字面相反——它检测的是"金额是否合法（非 0）"，
    适用于 GoPay / Team / 一次性付款这类**正常应当付费**的场景。
    Plus checkout（``promo_campaign_id=plus-1-month-free``）期望**今日应付
    必须是 0**——这种场景请用 ``_verify_checkout_is_free_trial``。
    """
    try:
        text = _page_body_text(page)
    except Exception:
        text = ""
    if not text:
        log("金额校验：页面正文为空，跳过校验（不阻塞）")
        return
    # 抠出所有形如 $0.00 / $20.00 / US$ 0 / 0.00 USD / SGD 27 等的货币金额。
    # 简化：只看 ``$`` / 货币符号 + 数字 这一种，覆盖 PayPal/Stripe checkout
    # 主流场景；JPY 等无小数币种也命中（^\d+(\.\d{1,2})?）。
    amount_pattern = re.compile(
        r"(?:US\$|S\$|HK\$|CN¥|￥|\$|€|£|¥)\s*([0-9]+(?:[.,][0-9]{1,2})?)",
        re.IGNORECASE,
    )
    matches = amount_pattern.findall(text)
    if not matches:
        log("金额校验：未抠出任何货币金额（可能 DOM 结构变化），跳过校验（不阻塞）")
        return
    parsed: list[float] = []
    for raw in matches:
        try:
            parsed.append(float(str(raw).replace(",", ".")))
        except ValueError:
            continue
    if not parsed:
        log(f"金额校验：抠出 {len(matches)} 条但都解析失败，跳过校验（不阻塞）")
        return
    nonzero = [v for v in parsed if v > 0]
    if not nonzero:
        # 全部 0 → 异常态
        sample = ", ".join(f"{v:.2f}" for v in parsed[:5])
        raise RuntimeError(
            f"支付金额异常：页面所有金额都为 0（共 {len(parsed)} 条，样本 {sample}）"
            "—— 可能是券码错乱 / 计费失败，本轮判定失败，关闭浏览器重试"
        )
    log(
        f"金额校验通过：抠出 {len(parsed)} 条金额，其中 {len(nonzero)} 条 > 0"
        f"（最大 {max(nonzero):.2f}）"
    )


def _verify_checkout_is_free_trial(page, *, log: Callable[[str], None]) -> None:
    """Plus checkout 专用：要求"今日应付金额 == 0"，否则判定为没免费试用资格。

    跟 ``_verify_checkout_amount_nonzero`` 语义相反——后者用于 GoPay /
    Team 等正常付费场景，期望金额 > 0。Plus 链路（携带
    ``promo_campaign_id=plus-1-month-free``）期望免费试用，今日应付应该
    显示 ``$0.00``，否则说明这个号没有免费试用资格，继续付款没意义，
    应该立刻弃号让外层换号重试，不要烧 PayPal / 银行卡配额。

    实现走 JS（``CHECKOUT_AMOUNT_PROBE_JS``）——同时覆盖：
      * hosted Stripe（``pay.openai.com``）的 ``#OrderDetails-TotalAmount``
      * chatgpt.com 自有 checkout 的"今日应付金额"label 同级金额

    抠不到（DOM 变化 / 页面早期未渲染）时**不阻塞**——只 log warning，
    跟原 ``_verify_checkout_amount_nonzero`` 的兜底策略一致。

    错误信息前缀 ``PLUS_CHECKOUT_NON_FREE_TRIAL::`` 给外层 ``except`` 用
    来识别"硬失败立即换号"分支。
    """
    try:
        result = page.evaluate(CHECKOUT_AMOUNT_PROBE_JS)
    except Exception as exc:
        log(f"免费试用校验：金额探测脚本失败（不阻塞）: {exc}")
        return
    if not isinstance(result, dict):
        log("免费试用校验：金额探测脚本未返回结构化结果（不阻塞）")
        return
    if not result.get("has_today_due"):
        log("免费试用校验：未在页面找到'今日应付金额'区块（不阻塞）")
        return
    amount = result.get("amount")
    raw_amount = str(result.get("raw_amount") or "")
    source = str(result.get("source") or "?")
    if amount is None:
        log(f"免费试用校验：找到金额区块但无法解析金额（source={source}, raw={raw_amount!r}），不阻塞")
        return
    if bool(result.get("is_zero")):
        log(f"免费试用校验通过：今日应付 {raw_amount or '0'}（source={source}）")
        return
    raise RuntimeError(
        f"PLUS_CHECKOUT_NON_FREE_TRIAL::今日应付金额不为 0（{raw_amount or amount}, "
        f"source={source}）—— 该账号没有 Plus 免费试用资格，立即弃号换 worker 重试"
    )


def _wait_checkout_page_ready(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    blank_timeout_seconds: int = 30,
) -> None:
    """等待支付页面加载到可交互状态。

    **白屏检测**：超过 ``blank_timeout_seconds`` 秒（默认 30s）没有任何
    关键支付元素出现 → 抛 ``RuntimeError("支付页面白屏超时...")``，外层
    主流程的 except 分支会 fail-fast 这一轮，关闭浏览器、释放 SMS 槽，
    用户级别看到的就是"该号失败、自动换下一个 worker 继续"的体验。

    元素信号包括 PayPal 单选按钮、订阅 submit 按钮、email/账单字段等——
    任一可见即视为页面活了。这些都没出现 = PayPal/Stripe 后端没把页面
    渲染出来 = 当前会话基本废了，继续等也是浪费。
    """
    log("等待支付页面加载完成")
    state_timeout = max(int(blank_timeout_seconds or 30), 5) * 1000
    poll_interval_ms = 250
    max_polls = max(int(state_timeout / poll_interval_ms), 1)
    ready_selector = ", ".join(
        (
            'input[value="paypal"]',
            '[data-testid*="paypal" i]',
            '[id*="paypal" i]',
            'button[data-testid="hosted-payment-submit-button"]',
            'button[type="submit"]',
            'input[type="submit"]',
            'input[type="email"]',
            'input[name="billingName"]',
            'input[name="billingAddressLine1"]',
            'input[name="addressLine1"]',
        )
    )
    last_state = ""
    for _ in range(max_polls):
        state = _document_ready_state(page)
        if state and state != last_state:
            log(f"支付页面 readyState={state}")
            last_state = state
        try:
            if _locator_ready(page.locator(ready_selector).first):
                log("支付页面关键元素已出现，开始执行 checkout 操作")
                return
        except Exception:
            pass
        try:
            page.wait_for_timeout(poll_interval_ms)
        except Exception:
            time.sleep(poll_interval_ms / 1000)
    raise RuntimeError(
        f"支付页面白屏超时（{blank_timeout_seconds}s 内未渲染出任何支付元素），"
        f"readyState={last_state or 'unknown'}；本轮判定失败，关闭浏览器重试"
    )


def _wait_page_loaded(page, *, timeout_ms: int, log: Callable[[str], None], label: str = "页面") -> None:
    log(f"等待{label}加载完成")
    state_timeout = min(max(int(timeout_ms or 30000), 5000), 30000)
    poll_interval_ms = 250
    max_polls = max(int(state_timeout / poll_interval_ms), 1)
    last_state = ""
    for _ in range(max_polls):
        state = _document_ready_state(page)
        if state and state != last_state:
            log(f"{label} readyState={state}")
            last_state = state
        if state in {"interactive", "complete"}:
            log(f"{label}已进入可交互状态")
            return
        try:
            page.wait_for_timeout(poll_interval_ms)
        except Exception:
            time.sleep(poll_interval_ms / 1000)
    log(f"等待{label}加载完成超时，继续: readyState={last_state or 'unknown'}")


def _run_step_with_retries(
    label: str,
    action,
    *,
    page=None,
    log: Callable[[str], None],
    attempts: int = 3,
    delay_ms: int = 5000,
    progressed=None,
    progressed_value=None,
    progressed_log: str | None = None,
    cancel_check: Callable[[], bool] | None = None,
):
    def _raise_if_cancelled() -> None:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")

    def _progressed_result():
        if not callable(progressed):
            return False, None
        try:
            if not progressed():
                return False, None
        except Exception:
            return False, None
        log(progressed_log or f"{label}已进入下一步，跳过当前步骤重试")
        if callable(progressed_value):
            try:
                return True, progressed_value()
            except Exception:
                return True, None
        return True, None

    max_attempts = max(int(attempts or 3), 1)
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        _raise_if_cancelled()
        try:
            return action()
        except Exception as exc:
            _raise_if_cancelled()
            last_exc = exc
            log(f"{label}第 {attempt}/{max_attempts} 次失败，准备重试: {exc}")
            done, value = _progressed_result()
            if done:
                return value
            try:
                if page is not None:
                    page.wait_for_timeout(delay_ms)
                else:
                    time.sleep(max(int(delay_ms), 0) / 1000)
            except Exception:
                time.sleep(max(int(delay_ms), 0) / 1000)
            _raise_if_cancelled()
            done, value = _progressed_result()
            if done:
                return value
            if attempt >= max_attempts:
                log(f"{label}连续 {max_attempts} 次失败: {exc}")
                raise
    if last_exc is not None:
        raise last_exc
    return None


def _click_first_ready(locators, *, label: str) -> bool:
    for locator in locators:
        if _locator_ready(locator):
            _click_or_check(locator)
            return True
    raise RuntimeError(f"未找到可点击的{label}")


def _click_by_candidates(
    page,
    *,
    label: str,
    selectors: tuple[str, ...] = (),
    patterns: tuple[re.Pattern, ...] = (),
    roles: tuple[str, ...] = ("button",),
) -> bool:
    locators = []
    for selector in selectors:
        try:
            locators.append(page.locator(selector).first)
        except Exception:
            pass
    for pattern in patterns:
        for role in roles:
            try:
                locators.append(page.get_by_role(role, name=pattern).first)
            except Exception:
                pass
        try:
            locators.append(page.get_by_text(pattern).first)
        except Exception:
            pass
    return _click_first_ready(locators, label=label)


def _challenge_contexts(page):
    try:
        for frame in getattr(page, "frames", []) or []:
            if frame is not page:
                yield frame
    except Exception:
        pass
    yield page


def _click_security_challenge_control(page, *, label: str) -> bool:
    human_pattern = re.compile(
        r"\bi\s*am\s*human\b|i'm\s*human|not\s+a\s+robot|verify|continue|验证|继续|人类|"
        r"私は人間です|ロボットではありません|本人確認|続ける|認証",
        re.I,
    )
    selectors = (
        'input[type="checkbox"]',
        '[role="checkbox"]',
        'button:has-text("I am human")',
        'button:has-text("I\'m human")',
        'button:has-text("I am not a robot")',
        'button:has-text("私は人間です")',
        'button:has-text("ロボットではありません")',
        '[role="button"]:has-text("I am human")',
        '[role="button"]:has-text("I\'m human")',
        '[role="button"]:has-text("I am not a robot")',
        '[role="button"]:has-text("私は人間です")',
        '[role="button"]:has-text("ロボットではありません")',
        'button[data-testid*="human" i]',
        'button[data-testid*="verify" i]',
        'button[data-testid*="challenge" i]',
        '[data-testid*="human" i]',
        '[data-testid*="verify" i]',
        '[aria-label*="I am human" i]',
        '[aria-label*="not a robot" i]',
        '[aria-label*="人間"]',
        '[aria-label*="ロボット"]',
        'button[type="submit"]',
    )
    for context in _challenge_contexts(page):
        locators = []
        for selector in selectors:
            try:
                locators.append(context.locator(selector).first)
            except Exception:
                pass
        for role in ("button", "checkbox", "link"):
            try:
                locators.append(context.get_by_role(role, name=human_pattern).first)
            except Exception:
                pass
        try:
            locators.append(context.get_by_label(human_pattern).first)
        except Exception:
            pass
        try:
            locators.append(context.get_by_text(human_pattern).first)
        except Exception:
            pass
        for locator in locators:
            if _locator_ready(locator):
                _click_or_check(locator)
                return True
    raise RuntimeError(f"未找到可点击的{label}")


def _fill_checkout_field(
    page,
    value: str,
    *,
    selectors: tuple[str, ...],
    labels: tuple[re.Pattern, ...] = (),
    select: bool = False,
    fill_timeout_ms: int = 1500,
) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    locators = []
    for selector in selectors:
        try:
            locators.append(page.locator(selector).first)
        except Exception:
            pass
    for label in labels:
        try:
            locators.append(page.get_by_label(label).first)
        except Exception:
            pass

    if select:
        # 下拉框：**优先走 GuJumpgate 风格的 JS 强制设值**（不看可见性，直接
        # 在 DOM 层命中 option + 派发 change）。Stripe/PayPal 的下拉常是视觉
        # 隐藏的原生 select，Playwright select_option 等不到可见会超时、
        # is_visible 检查会跳过——这是"下拉经常选不上"的根因。
        # 候选词用 JP 都道府县别名展开，吸收英文/日文/罗马字差异。
        candidates = _jp_prefecture_candidates(text) or [text]
        # 1) 先对所有匹配到的 select 元素（含隐藏）直接 JS 强制选
        for selector in selectors:
            try:
                loc = page.locator(selector).first
                if loc.count() <= 0:
                    continue
            except Exception:
                continue
            if _force_select_native_option(loc, candidates):
                return True
        # 2) 回退：可见 select 走 Playwright select_option（自定义/原生都试）
        for locator in locators:
            if not _locator_ready(locator):
                continue
            if _select_option_smart(locator, text, timeout_ms=int(fill_timeout_ms)):
                return True
        return False

    for locator in locators:
        if not _locator_ready(locator):
            continue
        # 跳过"已经填好同样值"的 input：避免重试时再次 fill 触发 React
        # re-render 把整张表单状态打回——这是用户截图里 6 个字段来回
        # 写好几遍才填满的根因之一。
        try:
            current_value = str(locator.input_value(timeout=300) or "").strip()
        except Exception:
            current_value = ""
        if current_value and current_value == text:
            return True
        try:
            # 默认 1500ms：单字段 8 候选 locator 全失败的最坏情况控制在
            # ~12s 内，不让 _fill_checkout_billing_details 累计成 3 分钟
            # 看起来挂死。原 3000ms 在英美页面是给慢框架的容忍，但日本
            # locale + Stripe captcha 重载下 8×3000=24s 单字段太长。
            locator.fill(text, timeout=int(fill_timeout_ms))
            return True
        except Exception:
            pass
    return False


# 日本都道府县别名表（``[paypal_value, english, japanese_short, kanji_full]``）。
# Stripe / PayPal hosted checkout 的 ``billingAdministrativeArea`` select：
#   option ``value="北海道"`` / label ``"北海道 — Hokkaido"``
# meiguodizhi 的 ``/jp-address`` 接口 ``State`` 字段实测可能是英文短名
# （``"Hokkaido"``）、日文短名（``"北海道"``）或片假名罗马字混合。三者
# 都要能命中同一个 option，否则 select 会留空让 Stripe 报"辖区未填写"。
#
# 设计参考 GuJumpgate ``content/paypal-flow.js`` 的
# ``HOSTED_PAYPAL_JP_PREFECTURES`` 三元组表，本项目把 PayPal 自有的全大
# 写代码（``TOKYO-TO`` 等）也带上，方便未来给 PayPal hosted guest checkout
# 复用。
_JP_PREFECTURE_ALIASES: tuple[tuple[str, ...], ...] = (
    ("HOKKAIDO", "Hokkaido", "北海道"),
    ("AOMORI-KEN", "Aomori", "青森県"),
    ("IWATE-KEN", "Iwate", "岩手県"),
    ("MIYAGI-KEN", "Miyagi", "宮城県"),
    ("AKITA-KEN", "Akita", "秋田県"),
    ("YAMAGATA-KEN", "Yamagata", "山形県"),
    ("FUKUSHIMA-KEN", "Fukushima", "福島県"),
    ("IBARAKI-KEN", "Ibaraki", "茨城県"),
    ("TOCHIGI-KEN", "Tochigi", "栃木県"),
    ("GUNMA-KEN", "Gunma", "群馬県"),
    ("SAITAMA-KEN", "Saitama", "埼玉県"),
    ("CHIBA-KEN", "Chiba", "千葉県"),
    ("TOKYO-TO", "Tokyo", "東京都"),
    ("KANAGAWA-KEN", "Kanagawa", "神奈川県"),
    ("NIIGATA-KEN", "Niigata", "新潟県"),
    ("TOYAMA-KEN", "Toyama", "富山県"),
    ("ISHIKAWA-KEN", "Ishikawa", "石川県"),
    ("FUKUI-KEN", "Fukui", "福井県"),
    ("YAMANASHI-KEN", "Yamanashi", "山梨県"),
    ("NAGANO-KEN", "Nagano", "長野県"),
    ("GIFU-KEN", "Gifu", "岐阜県"),
    ("SHIZUOKA-KEN", "Shizuoka", "静岡県"),
    ("AICHI-KEN", "Aichi", "愛知県"),
    ("MIE-KEN", "Mie", "三重県"),
    ("SHIGA-KEN", "Shiga", "滋賀県"),
    ("KYOTO-FU", "Kyoto", "京都府"),
    ("OSAKA-FU", "Osaka", "大阪府"),
    ("HYOGO-KEN", "Hyogo", "兵庫県"),
    ("NARA-KEN", "Nara", "奈良県"),
    ("WAKAYAMA-KEN", "Wakayama", "和歌山県"),
    ("TOTTORI-KEN", "Tottori", "鳥取県"),
    ("SHIMANE-KEN", "Shimane", "島根県"),
    ("OKAYAMA-KEN", "Okayama", "岡山県"),
    ("HIROSHIMA-KEN", "Hiroshima", "広島県"),
    ("YAMAGUCHI-KEN", "Yamaguchi", "山口県"),
    ("TOKUSHIMA-KEN", "Tokushima", "徳島県"),
    ("KAGAWA-KEN", "Kagawa", "香川県"),
    ("EHIME-KEN", "Ehime", "愛媛県"),
    ("KOCHI-KEN", "Kochi", "高知県"),
    ("FUKUOKA-KEN", "Fukuoka", "福岡県"),
    ("SAGA-KEN", "Saga", "佐賀県"),
    ("NAGASAKI-KEN", "Nagasaki", "長崎県"),
    ("KUMAMOTO-KEN", "Kumamoto", "熊本県"),
    ("OITA-KEN", "Oita", "大分県"),
    ("MIYAZAKI-KEN", "Miyazaki", "宮崎県"),
    ("KAGOSHIMA-KEN", "Kagoshima", "鹿児島県"),
    ("OKINAWA-KEN", "Okinawa", "沖縄県"),
)


def _jp_prefecture_candidates(value: str) -> list[str]:
    """根据任意形式的都道府县字符串（英文 / 日文 / PayPal 全大写代码 /
    带连字符 ``Hokkaido-do`` / 街道结尾片段等），返回这一组的所有别名。

    匹配规则：先做"紧凑化"（小写、去除非字母数字+CJK），再跟表里每个字段
    的紧凑形式比对——只要任意字段的紧凑形式跟入参的紧凑形式相等、或者
    其中一个包含另一个，就把这一行所有别名都返回。

    返回时把入参原文也放在最前面，调用方按"原文 → 别名"顺序去 fuzzy
    match select option。
    """
    raw = str(value or "").strip()
    if not raw:
        return []

    def _compact(text: str) -> str:
        return re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", str(text or "").lower())

    target = _compact(raw)
    if not target:
        return [raw]
    candidates: list[str] = [raw]
    seen = {raw}
    for row in _JP_PREFECTURE_ALIASES:
        compacts = [(item, _compact(item)) for item in row]
        if not any(c for _, c in compacts):
            continue
        hit = False
        for _, comp in compacts:
            if not comp:
                continue
            if comp == target:
                hit = True
                break
            # 长方向包含：``"hokkaido" in "hokkaidoddo..."`` 或反向
            if len(comp) >= 3 and (comp in target or target in comp):
                hit = True
                break
        if hit:
            for item in row:
                if item and item not in seen:
                    candidates.append(item)
                    seen.add(item)
    return candidates


def _select_option_smart(locator, text: str, *, timeout_ms: int) -> bool:
    """智能选 option：依次尝试 value 精确 / label 精确 / 模糊匹配。

    日本 PayPal/Stripe checkout 的 ``billingAdministrativeArea`` 实测：
      - option ``value="青森県"``，label ``"青森県 — Aomori"``
      - meiguodizhi ``/jp-address`` 接口返回的 state 可能是
        ``"Aomori"`` / ``"アオモリケン"`` / ``"青森県"`` 三种之一，
        没法保证总跟 option value 完全一致。

    匹配策略（短路命中即返回）：
      1. 把入参 ``text`` 通过 ``_jp_prefecture_candidates`` 展开成所有别名
         （``"Hokkaido"`` → ``["Hokkaido", "HOKKAIDO", "北海道"]``）；非 JP
         地区 / 不在表中的输入会原样返回，不影响行为。
      2. 每个候选先 ``select_option(value=...)`` exact 命中（最稳）
      3. 再 ``select_option(label=...)`` exact
      4. 都失败时拉所有 option，按 label/value 是否包含/反向包含候选
         （处理 "Aomori" 命中 "青森県 — Aomori" 这种情形）

    任何一步成功都返回 True；全部失败返回 False。
    """
    primary = str(text or "").strip()
    if not primary:
        return False
    expanded = _jp_prefecture_candidates(primary)
    # ``expanded`` 至少包含 ``primary`` 本身；增量是 JP 别名
    for candidate in expanded:
        for kwargs in ({"value": candidate}, {"label": candidate}):
            try:
                locator.select_option(timeout=timeout_ms, **kwargs)
                return True
            except Exception:
                pass
    try:
        options = locator.evaluate(
            "(el) => Array.from(el.options || []).map((o) => ({ value: o.value, label: o.text }))"
        )
    except Exception:
        options = None
    if not options:
        return False
    for candidate in expanded:
        cand_lower = candidate.lower()
        for option in options:
            opt_value = str(option.get("value") or "")
            opt_label = str(option.get("label") or "")
            if not opt_value:
                continue
            if (
                opt_value == candidate
                or opt_label == candidate
                or opt_value.lower() == cand_lower
                or opt_label.lower() == cand_lower
                or cand_lower in opt_label.lower()
                or cand_lower in opt_value.lower()
                or opt_value.lower() in cand_lower
                or opt_label.lower() in cand_lower
            ):
                try:
                    locator.select_option(value=opt_value, timeout=timeout_ms)
                    return True
                except Exception:
                    continue
    return False


def _force_select_native_option(locator, candidates: list[str], *, log=None, field_label: str = "select") -> bool:
    """对原生 ``<select>``（含 Stripe ``.Select-source`` 这种**视觉隐藏**的）
    用 JS 直接命中 option 并设值——参考 GuJumpgate ``fillHostedBillingState`` /
    ``selectHostedOptionByIdText`` 的做法。

    背景：Stripe / PayPal hosted checkout 的下拉是"可见壳 ``.Select`` + 视觉
    隐藏的真实 ``<select>``"结构（``opacity:0`` / 定位覆盖）。Playwright
    ``select_option`` 默认要等元素可见可操作 → 隐藏 select 上永远超时；
    ``_fill_checkout_field`` 的 ``is_visible()`` 检查也会直接跳过它。这是
    "下拉框经常选不上"的根因。

    JS 路径不看可见性，直接在 DOM 层：
      1. **精确**：option.value / option.text 小写后等于候选词
      2. **压缩匹配**（GuJumpgate ``compactHostedPrefectureText``）：把候选词
         和 option 都去掉非字母数字+CJK 再比，吸收 ``"東京都 — Tokyo"`` /
         ``"Tokyo (+81)"`` / 空格连字符差异
      3. **包含**：双向 includes 兜底
    命中后 ``value=`` + 清 React ``_valueTracker`` + 派发 ``input``/``change``
    （Stripe React 监听 change 同步内部状态，不派发提交时为空）。

    ``candidates`` 已展开候选词（原文 + 别名）。命中返回 True。
    """
    script = """
    (el, cands) => {
      const opts = Array.from(el.options || []);
      const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
      const compact = (s) => norm(s).replace(/[^a-z0-9\\u4e00-\\u9fff]/g, '');
      const pick = () => {
        // 1) 精确（小写）
        for (const c of cands) {
          const cl = norm(c);
          if (!cl) continue;
          for (const o of opts) {
            if (norm(o.value) === cl || norm(o.text) === cl || norm(o.label) === cl) return o;
          }
        }
        // 2) 压缩匹配（去掉空格/连字符/破折号等）
        for (const c of cands) {
          const cc = compact(c);
          if (!cc || cc.length < 2) continue;
          for (const o of opts) {
            if (!o.value && !o.text) continue;
            const cv = compact(o.value), ct = compact(o.text);
            if (cv === cc || ct === cc) return o;
          }
        }
        // 3) 双向包含
        for (const c of cands) {
          const cc = compact(c);
          if (!cc || cc.length < 2) continue;
          for (const o of opts) {
            if (!o.value) continue;
            const cv = compact(o.value), ct = compact(o.text);
            if ((cv && (cv.includes(cc) || cc.includes(cv))) || (ct && (ct.includes(cc) || cc.includes(ct)))) return o;
          }
        }
        return null;
      };
      const opt = pick();
      if (!opt) return '';
      const proto = window.HTMLSelectElement && window.HTMLSelectElement.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value') &&
                     Object.getOwnPropertyDescriptor(proto, 'value').set;
      try { if (el._valueTracker) el._valueTracker.setValue(''); } catch (e) {}
      if (setter) setter.call(el, opt.value); else el.value = opt.value;
      try { opt.selected = true; } catch (e) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    }
    """
    try:
        picked = locator.evaluate(script, candidates)
    except Exception as exc:
        if callable(log):
            log(f"  · {field_label} JS 强制选项异常: {exc}")
        return False
    if picked:
        if callable(log):
            log(f"  · {field_label} 已 JS 强制选中 value={picked!r}")
        return True
    return False


def _wait_and_force_select_by_id(
    page, element_id: str, candidates: list[str], *,
    log=None, attempts: int = 10, interval_ms: int = 500,
) -> bool:
    """轮询等 ``<select id>`` 出现且有 option → JS 强制选中 → 校验 value 真变了。

    React 受控 select（如 ``#billingState`` 都道府县）经常：
      - option 异步填充（刚渲染时是空的）
      - 被后续重渲染重置回空

    所以单次设值不可靠，要等 option 就绪、设完校验、被清了再重试。失败时
    dump 实际 option 摘要便于定位。
    """
    eid = str(element_id or "").strip()
    if not eid or not candidates:
        return False
    opt_count_script = """
    (id) => {
      const el = document.getElementById(id);
      if (!el) return -1;
      return (el.options || []).length;
    }
    """
    cur_val_script = """
    (id) => {
      const el = document.getElementById(id);
      if (!el) return '__noel__';
      return String(el.value == null ? '' : el.value);
    }
    """
    for i in range(max(int(attempts), 1)):
        try:
            opt_n = page.evaluate(opt_count_script, eid)
        except Exception:
            opt_n = -1
        # 等元素出现且 option 已填充（>1，排除只有 disabled 占位项）
        if isinstance(opt_n, int) and opt_n > 1:
            try:
                loc = page.locator(f"#{eid}").first
            except Exception:
                loc = None
            if loc is not None and _force_select_native_option(loc, candidates, log=log, field_label=f"#{eid}"):
                # 校验 value 非空
                try:
                    cur = page.evaluate(cur_val_script, eid)
                except Exception:
                    cur = ""
                if cur not in ("", "__noel__"):
                    return True
        try:
            page.wait_for_timeout(int(interval_ms))
        except Exception:
            time.sleep(interval_ms / 1000)
    # 最终失败：dump option 摘要
    if callable(log):
        try:
            preview = page.evaluate(
                "(id) => { const el = document.getElementById(id); if (!el) return 'no_element';"
                " return Array.from(el.options || []).slice(0, 10).map(o => `${o.value}|${o.text}`).join(' ; '); }",
                eid,
            )
        except Exception:
            preview = "(dump 失败)"
        log(f"  · #{eid} 多次重试仍未选上，候选={candidates} option前10={preview}")
    return False


def _force_fill_input_by_id(page, element_id: str, value: str, *, log=None) -> bool:
    """按**精确 id** 用 JS 直接给 input 设值——参考 GuJumpgate
    ``fillHostedInputById`` / ``fillInput``。

    PayPal 统一 guest 表单（``/checkoutweb/signup`` 上 ``国/地域 + メール +
    電話 + カード + 漢字/片假名姓名`` 同页）的字段都是 React 受控 input，
    且 id 唯一（``#email`` / ``#phone`` / ``#cardNumber`` / ``#firstName`` 等）。
    Playwright ``.fill()`` 走可见性/可操作性检查，在这种被浮层/动画包裹的
    React 受控框上经常超时或写不进（写完被 React re-render 清掉）。

    GuJumpgate 的做法稳：拿到元素后用原生 value setter 写值 + 清掉 React
    ``_valueTracker`` + 依次派发 ``input``/``change``/``blur``，让 React 同步
    内部 state。这里照搬。返回是否成功命中并写入。
    """
    eid = str(element_id or "").strip()
    if not eid:
        return False
    script = """
    (args) => {
      const { id, value } = args;
      const el = document.getElementById(id);
      if (!el) return 'no_element';
      // 跳过 disabled / aria-disabled
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled';
      const tag = el.tagName;
      const proto = tag === 'TEXTAREA'
        ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement && window.HTMLInputElement.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')
        && Object.getOwnPropertyDescriptor(proto, 'value').set;
      try { el.focus(); } catch (e) {}
      try { if (el._valueTracker) el._valueTracker.setValue(''); } catch (e) {}
      if (setter) setter.call(el, value); else el.value = value;
      try { el.setAttribute('value', value); } catch (e) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return 'ok:' + String(el.value || '');
    }
    """
    try:
        result = page.evaluate(script, {"id": eid, "value": str(value or "")})
    except Exception as exc:
        if callable(log):
            log(f"  · #{eid} JS 设值异常: {exc}")
        return False
    ok = isinstance(result, str) and result.startswith("ok")
    if callable(log):
        if ok:
            log(f"  · #{eid} 已 JS 设值 ✓")
        else:
            log(f"  · #{eid} JS 设值未命中（{result}）")
    return ok


def _force_select_by_id(page, element_id: str, candidates: list[str], *, log=None) -> bool:
    """按精确 id 取 ``<select>`` 再用 JS 强制选 option（复用 _force_select_native_option）。"""
    eid = str(element_id or "").strip()
    if not eid:
        return False
    try:
        loc = page.locator(f"#{eid}").first
        if loc.count() <= 0:
            return False
    except Exception:
        return False
    return _force_select_native_option(loc, candidates, log=log, field_label=f"#{eid}")


def _require_ctf_checkout_field(
    page,
    label: str,
    value: str,
    *,
    selectors: tuple[str, ...],
    labels: tuple[re.Pattern, ...] = (),
    select: bool = False,
) -> None:
    if not _fill_checkout_field(page, value, selectors=selectors, labels=labels, select=select):
        raise RuntimeError(f"CTF 创建页字段未填写: {label}")


def _wait_checkout_billing_form_ready(
    page,
    *,
    timeout_ms: int = 15000,
    log: Callable[[str], None] | None = None,
) -> bool:
    """等待 PayPal 选中后真正展开的账单信息表单出现。

    选了 PayPal 之后 Stripe 结账页会动态加载一段美国账单信息（姓名、地址、
    邮编、电话等）输入框。如果立刻调 `_fill_checkout_billing_details` 就
    去抢着 fill，DOM 还没渲染完，多个字段会被静默跳过（locator 没找到
    就默默 return False），后续提交时表单校验失败。

    这里轮询 ``billingName`` / ``billingAddressLine1`` / ``billingPostalCode``
    任一字段可见即视为表单已加载完成（这三个是账单 block 的早期渲染元素）。
    """
    poll_interval_ms = 250
    max_polls = max(int(max(int(timeout_ms or 15000), 2000) / poll_interval_ms), 1)
    selectors = (
        'input[name="billingName"]',
        'input[name="billingAddressLine1"]',
        'input[name="addressLine1"]',
        'input[autocomplete="billing address-line1"]',
        'input[name="billingPostalCode"]',
        'input[name="postalCode"]',
        'input[autocomplete="billing postal-code"]',
    )
    for _ in range(max_polls):
        for selector in selectors:
            try:
                if _locator_visible(page.locator(selector).first):
                    if log:
                        log(f"账单信息表单已加载: {selector}")
                    return True
            except Exception:
                pass
        try:
            page.wait_for_timeout(poll_interval_ms)
        except Exception:
            time.sleep(poll_interval_ms / 1000)
    if log:
        log("等待账单信息表单加载超时，仍尝试填写")
    return False


def _snapshot_country_select(page) -> tuple:
    """记录 PayPal/Stripe checkout 页 country 下拉的当前选中值。

    Stripe 给账单 country 下拉有两类常见 selector：
      - ``select[name="billingCountry"]``（hosted checkout）
      - ``select[name="country"]``（payment element）
    PayPal 自家 hosted checkout 页则用 ``select[name="account-country"]``。

    返回 ``(locator | None, value | None)``。如果页面没出现 country select
    （例如 GoPay 印尼渠道，country 是 hidden field），返回 (None, None)，
    后续 restore 也是 no-op。
    """
    for selector in (
        'select[name="billingCountry"]',
        'select[name="country"]',
        'select[autocomplete="billing country"]',
        'select[autocomplete="country"]',
        'select[name="account-country"]',
    ):
        try:
            locator = page.locator(selector).first
            if locator.count() > 0 and locator.is_visible():
                try:
                    value = str(locator.input_value(timeout=500) or "")
                except Exception:
                    try:
                        value = str(
                            locator.evaluate("(el) => el.value || ''") or ""
                        )
                    except Exception:
                        value = ""
                return locator, value
        except Exception:
            continue
    return None, None


def _restore_country_select_if_changed(
    locator,
    before: str | None,
    *,
    log: Callable[[str], None],
) -> None:
    """如果 country select 在 state fill 期间被误改，回滚到原值。

    PayPal 切换 country 后会触发整张表单重新渲染（清空所有 input + 切货币），
    所以一旦命中误改要立即回滚，避免把后续 fill 都打到错误的 country DOM 上。
    """
    if locator is None or not before:
        return
    try:
        try:
            current = str(locator.input_value(timeout=500) or "")
        except Exception:
            current = str(
                locator.evaluate("(el) => el.value || ''") or ""
            )
    except Exception:
        return
    if not current or current == before:
        return
    log(
        f"  ! country 下拉被误改 {before!r} → {current!r}，回滚"
    )
    for kwargs in ({"value": before}, {"label": before}):
        try:
            locator.select_option(timeout=1500, **kwargs)
            return
        except Exception:
            continue
    log(f"  ! country 回滚失败，可能需要手动重选: {before!r}")


def _fill_checkout_billing_details(
    page,
    address: dict,
    *,
    log: Callable[[str], None] | None = None,
) -> None:
    # 标签 regex 都补了日文 alt：日本 IP 进 Stripe/PayPal checkout 时
    # 表单 label/aria-label/placeholder 全切日文，原英文 regex 命中失败。
    log_fn = log or (lambda _msg: None)
    region = str(address.get("country") or "").strip().upper() or "?"
    filled: list[str] = []
    skipped: list[str] = []

    def _try(field: str, ok: bool) -> None:
        # 每个字段都打条进度日志，避免整个 fill 跑完才输出汇总——
        # 用户只看到 "填写XX账单信息" 一行，会以为卡死。
        log_fn(f"  · {field} {'✓' if ok else '×'}")
        (filled if ok else skipped).append(field)

    _try(
        "email",
        _fill_checkout_field(
            page,
            address.get("email", ""),
            selectors=('input[type="email"]', 'input[name="email"]', '#email'),
            labels=(re.compile(r"email|邮箱|电子邮件|メール|メールアドレス", re.I),),
        ),
    )
    _try(
        "name",
        _fill_checkout_field(
            page,
            address.get("name", ""),
            selectors=(
                '#billingName',
                'input[name="billingName"]',
                'input[name="name"]',
                'input[autocomplete="name"]',
            ),
            labels=(re.compile(r"name|姓名|full name|氏名|お名前|フルネーム", re.I),),
        ),
    )
    _try(
        "line1",
        _fill_checkout_field(
            page,
            address.get("line1", ""),
            selectors=(
                '#billingAddressLine1',
                'input[name="billingAddressLine1"]',
                'input[name="addressLine1"]',
                'input[autocomplete="billing address-line1"]',
                'input[autocomplete="address-line1"]',
            ),
            labels=(re.compile(r"address|地址|street|住所|番地|町名", re.I),),
        ),
    )
    _try(
        "city",
        _fill_checkout_field(
            page,
            address.get("city", ""),
            selectors=(
                '#billingLocality',
                'input[name="billingLocality"]',
                'input[name="city"]',
                'input[autocomplete="billing address-level2"]',
                'input[autocomplete="address-level2"]',
            ),
            labels=(re.compile(r"city|城市|市区町村|都市|市", re.I),),
        ),
    )
    # 修复：保护 country select 不被 state fill 误改。
    # 实测日本 IP 下页面会渲染 ``account-country`` select（默认日本）+
    # ``billingAdministrativeArea`` select（省/州）；以前 state fill 用的
    # ``get_by_label(re.compile("州|府"))`` 会先命中 country 下拉（label 含
    # "国家/州"等组合词），把 country 改成 "PH/菲律宾" 之类。
    #
    # 这里在 fill state 之前先记下 country select 的当前值（PayPal 已按 IP
    # 选好），fill 完后再校验，被误改就回滚。state 选择器去掉 label 兜底，
    # 只走最精准的 ``name=state``/``billingAdministrativeArea``。
    country_locator, country_before = _snapshot_country_select(page)

    state_value = str(address.get("state", "") or "").strip()
    if state_value and region.upper() == "JP":
        # JP 区 state 命中失败是用户实战痛点（接口返英文 / 日文 / 罗马字
        # 全混着）。在 fill 之前把候选别名展开打印一份，方便日志复盘。
        try:
            jp_aliases = _jp_prefecture_candidates(state_value)
        except Exception:
            jp_aliases = [state_value]
        log_fn(f"  · state 输入={state_value!r} 展开候选={jp_aliases}")

    state_select_ok = _fill_checkout_field(
        page,
        state_value,
        selectors=(
            '#billingAdministrativeArea',
            'select[name="billingAdministrativeArea"]',
            'select[name="state"]',
            'select[autocomplete="billing address-level1"]',
            'select[autocomplete="address-level1"]',
        ),
        labels=(),  # 关键：去掉 label fallback，避免误中 country 下拉
        select=True,
    )
    if not state_select_ok:
        state_select_ok = _fill_checkout_field(
            page,
            state_value,
            selectors=(
                'input[name="billingAdministrativeArea"]',
                'input[name="state"]',
                'input[autocomplete="billing address-level1"]',
                'input[autocomplete="address-level1"]',
            ),
            labels=(),
        )
    if not state_select_ok and state_value:
        # 仍未命中：把当前 select 的全部 option 摘要打到日志里，方便用户
        # 把这条贴回来扩 ``_JP_PREFECTURE_ALIASES`` / 调整接口字段映射。
        try:
            preview = page.locator('#billingAdministrativeArea').first.evaluate(
                "(el) => Array.from(el.options || []).slice(0, 8)"
                ".map((o) => `${o.value}|${o.text}`).join(' ; ')"
            )
            log_fn(f"  · state 仍未命中，当前 option 摘要前 8 项: {preview}")
        except Exception:
            pass
    _restore_country_select_if_changed(
        country_locator, country_before, log=log_fn
    )
    _try("state", state_select_ok)
    _try(
        "postal_code",
        _fill_checkout_field(
            page,
            address.get("postal_code", ""),
            selectors=(
                '#billingPostalCode',
                'input[name="billingPostalCode"]',
                'input[name="postalCode"]',
                'input[autocomplete="billing postal-code"]',
                'input[autocomplete="postal-code"]',
            ),
            labels=(re.compile(r"zip|postal|邮编|郵便番号|〒", re.I),),
        ),
    )
    _try(
        "phone",
        _fill_checkout_field(
            page,
            address.get("phone", ""),
            selectors=('input[type="tel"]', 'input[name="phone"]', 'input[autocomplete="tel"]'),
            labels=(re.compile(r"phone|telephone|手机|电话|電話|携帯|モバイル", re.I),),
        ),
    )
    log_fn(
        f"账单字段填写结果 region={region} 成功={','.join(filled) or '无'} "
        f"未命中={','.join(skipped) or '无'}"
    )


# 账单字段 → 用于"填写完整性校验"的只读探测选择器。只覆盖 checkout 页
# 可能存在的可填字段；email/phone 在 GoPay 印尼渠道通常不在表单里，校验
# 时按"页面上有没有这个输入框"动态判断，不强制要求（避免误判不完整）。
_BILLING_VERIFY_SPECS: tuple[tuple[str, tuple[str, ...], bool], ...] = (
    (
        "name",
        (
            '#billingName',
            'input[name="billingName"]',
            'input[name="name"]',
            'input[autocomplete="name"]',
        ),
        False,
    ),
    (
        "line1",
        (
            '#billingAddressLine1',
            'input[name="billingAddressLine1"]',
            'input[name="addressLine1"]',
            'input[autocomplete="billing address-line1"]',
            'input[autocomplete="address-line1"]',
        ),
        False,
    ),
    (
        "city",
        (
            '#billingLocality',
            'input[name="billingLocality"]',
            'input[name="city"]',
            'input[autocomplete="billing address-level2"]',
            'input[autocomplete="address-level2"]',
        ),
        False,
    ),
    (
        "state",
        (
            '#billingAdministrativeArea',
            'select[name="billingAdministrativeArea"]',
            'select[name="state"]',
            'input[name="billingAdministrativeArea"]',
            'input[name="state"]',
        ),
        True,
    ),
    (
        "postal_code",
        (
            '#billingPostalCode',
            'input[name="billingPostalCode"]',
            'input[name="postalCode"]',
            'input[autocomplete="billing postal-code"]',
            'input[autocomplete="postal-code"]',
        ),
        False,
    ),
    (
        "email",
        ('input[type="email"]', 'input[name="email"]', '#email'),
        False,
    ),
    (
        "phone",
        ('input[type="tel"]', 'input[name="phone"]', 'input[autocomplete="tel"]'),
        False,
    ),
)


def _billing_required_missing(
    page,
    address: dict,
    *,
    log: Callable[[str], None] | None = None,
) -> list[str]:
    """返回"页面上存在该输入框、地址里也有值、但当前仍为空"的字段名。

    点击订阅前的填写完整性校验用：只把"该填却没填上"的字段算缺失。地址里
    没值的字段、或页面上压根没有的输入框（如 GoPay 印尼渠道没有 email/phone
    框），都不算缺失，避免误判导致永远重填不完整。
    """
    missing: list[str] = []
    for field, selectors, is_select in _BILLING_VERIFY_SPECS:
        value = str(address.get(field) or "").strip()
        if not value:
            continue  # 地址没这个值 → 不要求
        locator = None
        for selector in selectors:
            try:
                cand = page.locator(selector).first
            except Exception:
                continue
            if _locator_ready(cand):
                locator = cand
                break
        if locator is None:
            continue  # 页面上没有这个输入框 → 不要求
        try:
            if is_select:
                current = str(locator.evaluate("(el) => el.value || ''") or "").strip()
            else:
                current = str(locator.input_value(timeout=500) or "").strip()
        except Exception:
            current = ""
        if not current:
            missing.append(field)
    return missing


def _fill_billing_until_complete(
    page,
    address: dict,
    *,
    max_attempts: int = 3,
    log: Callable[[str], None] = print,
) -> list[str]:
    """填账单并做完整性校验，不完整就重填，最多 ``max_attempts`` 次。

    返回最后一次校验仍缺失的字段列表（空列表=填写完整）。每次填写中的
    非致命异常都吞掉继续（填写本身已是 best-effort）。
    """
    attempts = max(int(max_attempts), 1)
    missing: list[str] = []
    for attempt in range(1, attempts + 1):
        try:
            _fill_checkout_billing_details(page, address, log=log)
        except Exception as exc:
            log(f"填写账单信息时出现非致命异常（第 {attempt}/{attempts} 次，继续）: {exc}")
        missing = _billing_required_missing(page, address, log=log)
        if not missing:
            log(f"账单信息校验通过（第 {attempt}/{attempts} 次填写）")
            return []
        if attempt < attempts:
            log(
                f"账单信息不完整，缺失字段 {','.join(missing)}，"
                f"第 {attempt}/{attempts} 次后重填"
            )
        else:
            log(
                f"账单信息经 {attempts} 次填写仍不完整（缺失 {','.join(missing)}），"
                "仍尝试点击订阅"
            )
    return missing


def _accept_checkout_terms(page) -> bool:
    terms_pattern = re.compile(
        r"agree|accept|terms|service|policy|agreement|同意|接受|协议|条款|服务|政策|收费|金额|周期|取消|更改|订阅|"
        r"同意します|利用規約|プライバシー|サービス規約|規約に同意|個人情報",
        re.I,
    )
    locators = []
    for factory in (
        lambda: page.locator('input[type="checkbox"][name*="terms" i]').first,
        lambda: page.locator('input[type="checkbox"][id*="terms" i]').first,
        lambda: page.locator('input[type="checkbox"][name*="agree" i]').first,
        lambda: page.locator('input[type="checkbox"][id*="agree" i]').first,
        lambda: page.locator('[role="checkbox"][aria-label*="terms" i]').first,
        lambda: page.locator('[role="checkbox"][aria-label*="agree" i]').first,
        lambda: page.locator('[role="checkbox"][aria-label*="同意"]').first,
        lambda: page.locator('[role="checkbox"][aria-label*="規約"]').first,
        lambda: page.get_by_role("checkbox", name=terms_pattern).first,
        lambda: page.get_by_label(terms_pattern).first,
        lambda: page.get_by_text(terms_pattern).first,
    ):
        try:
            locators.append(factory())
        except Exception:
            pass
    for locator in locators:
        if _locator_ready(locator):
            _click_or_check(locator)
            try:
                page.wait_for_timeout(500)
            except Exception:
                pass
            return True
    return False


def _click_subscribe_button(page) -> bool:
    selectors = (
        'button[data-testid="hosted-payment-submit-button"]',
        'button[type="submit"]',
        'input[type="submit"]',
    )
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            if _locator_ready(locator):
                locator.click(timeout=5000, force=True)
                return True
        except Exception:
            pass
    submit_pattern = re.compile(
        r"subscribe|订阅|pay|支付|confirm|确认|continue|继续|"
        r"購読|登録|支払う|お支払い|確認|続ける|次へ|申し込む|送信",
        re.I,
    )
    for factory in (
        lambda: page.get_by_role("button", name=submit_pattern).first,
        lambda: page.get_by_text(submit_pattern).first,
    ):
        try:
            locator = factory()
            if _locator_ready(locator):
                locator.click(timeout=5000, force=True)
                return True
        except Exception:
            pass
    raise RuntimeError("未找到订阅提交按钮")


def _click_subscribe_button_burst(
    page,
    *,
    checkout_url: str,
    log: Callable[[str], None],
    clicks: int = 3,
    delay_ms: int = 1000,
) -> bool:
    clicked = False
    for index in range(1, max(int(clicks), 1) + 1):
        if _checkout_redirected(page, checkout_url):
            break
        log(f"点击最终订阅按钮第 {index}/{clicks} 次")
        _click_subscribe_button(page)
        clicked = True
        if index < clicks:
            try:
                page.wait_for_timeout(delay_ms)
            except Exception:
                time.sleep(max(delay_ms, 0) / 1000)
    return clicked


def _current_page_url(page, fallback: str = "") -> str:
    try:
        return str(page.url or fallback)
    except Exception:
        return fallback


def _is_page_load_error_url(url: str) -> bool:
    """Chromium 页面加载失败（代理断流 / 连接重置 / DNS 失败）时会落到内部
    错误页。动态 IP 不稳定断流后，导航通常会停在这些 URL 上。"""
    lowered = str(url or "").strip().lower()
    if not lowered:
        return True
    return (
        lowered.startswith("chrome-error://")
        or "chromewebdata" in lowered
        or lowered.startswith("chrome://network-error")
        or lowered in ("about:blank", "about:blank#blocked", "data:,")
    )


def _recover_page_load_if_errored(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    attempts: int = 3,
    cancel_check: Callable[[], bool] | None = None,
) -> bool:
    """检测并恢复 Chromium 加载失败页（``chrome-error://chromewebdata/`` 等）。

    动态 IP 断流时导航会落到内部错误页。``page.reload()`` 会重新发起上一次
    导航请求；最多重试 ``attempts`` 次，恢复成正常 URL 返回 ``True``，始终
    失败返回 ``False``（由调用方决定是否最终判失败）。

    页面本就正常（非错误页）时直接返回 ``True``，不做任何操作。
    """
    if not _is_page_load_error_url(_current_page_url(page)):
        return True
    reload_timeout = max(int(timeout_ms or 30000), 15000)
    for attempt in range(1, max(int(attempts or 3), 1) + 1):
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")
        log(
            f"检测到页面加载失败（疑似代理断流），第 {attempt}/{attempts} 次重新加载: "
            f"{_current_page_url(page)}"
        )
        try:
            page.reload(wait_until="domcontentloaded", timeout=reload_timeout)
        except Exception as exc:
            log(f"  · 重新加载抛错: {exc}")
        # reload 后等 URL 稳定
        try:
            page.wait_for_timeout(1500)
        except Exception:
            time.sleep(1.5)
        if not _is_page_load_error_url(_current_page_url(page)):
            log(f"  · 页面已恢复: {_current_page_url(page)}")
            return True
        backoff_ms = int(2000 * attempt)
        try:
            page.wait_for_timeout(backoff_ms)
        except Exception:
            time.sleep(backoff_ms / 1000)
    log(f"页面连续 {attempts} 次重新加载仍失败: {_current_page_url(page)}")
    return False


def _pick_active_page(page):
    """返回同一 BrowserContext 中仍活着的 page。

    场景：PayPal 的 `/checkoutweb/signup` OTP 提交后会调 `window.close()` 关闭自身，
    但主商户页（stripe checkout / chatgpt）仍会在同一上下文继续跳转。本函数
    检测 `page.is_closed()`，若已关闭则从 `context.pages` 中选择最近创建的另一个活 page，
    以便后续 `wait_for_function` 能继续监听 chatgpt URL。

    对单元测试中未提供 `is_closed()` 的 fake page 保持兼容，原封不动返回。
    """
    try:
        closed = bool(page.is_closed())
    except AttributeError:
        return page
    except Exception:
        return page
    if not closed:
        return page
    siblings = []
    try:
        siblings = list(page.context.pages)
    except Exception:
        siblings = []
    for candidate in reversed(siblings):
        if candidate is page:
            continue
        try:
            if not candidate.is_closed():
                return candidate
        except Exception:
            continue
    raise RuntimeError("camoufox 上下文中已无存活的 page，OTP 提交后无法继续等待跳回 chatgpt")


def _checkout_redirected(page, checkout_url: str) -> bool:
    current_url = _current_page_url(page).strip().rstrip("/")
    original_url = str(checkout_url or "").strip().rstrip("/")
    return bool(current_url and original_url and current_url != original_url)


def _checkout_url_progressed(page, checkout_url: str) -> bool:
    current_url = _current_page_url(page, checkout_url)
    return (
        _checkout_redirected(page, checkout_url)
        or _is_paypal_intermediate_url(current_url)
        or _is_ctf_sandbox_url(current_url)
        or _is_paypal_pay_create_url(current_url)
    )


def _checkout_flow_progressed(page, checkout_url: str) -> bool:
    """**严格判定**：只有 URL 真的离开了原 Stripe checkout 并进入 PayPal /
    CTF sandbox / PayPal mock 才算"已往下进展"。

    **历史背景**：之前这里把 hidden input 超时误报为“成功”，
    ``_has_security_challenge`` 和 ``_ctf_after_continue_ready`` 也算"进展"。
    问题是 Stripe 自家结账页加载的 fraud 检测 iframe（URL 含 ``recaptcha`` /
    ``challenge``）让 ``_has_security_challenge`` 在用户**还没点 PayPal**
    时就返 True——结果点击 PayPal 单选按钮失败后，``_run_step_with_retries``
    的 progressed 回调误报"已进下一步"，主流程直接 fast-path 返回成功。
    日志写"成功"但 final_url 仍是原 Stripe URL，用户点开支付链接还要从头填表。

    现在严格只看 URL：URL 没动 = 没进展，老老实实重试或报错，绝不"伪成功"。
    """
    return _checkout_url_progressed(page, checkout_url)


def _wait_for_checkout_redirect(
    page,
    *,
    checkout_url: str,
    timeout_ms: int,
    log: Callable[[str], None],
) -> bool:
    log("等待测试支付链接跳转")
    redirect_timeout = min(max(int(timeout_ms or 15000), 5000), 15000)
    # 用 Python 端轮询替换 page.wait_for_function：Stripe / PayPal 的部分
    # 页面 CSP 禁了 unsafe-eval，wait_for_function 会立刻 EvalError 失效。
    _poll_url_changed(
        page,
        initial_url=str(checkout_url or ""),
        timeout_ms=redirect_timeout,
        log=log,
        label="测试支付链接",
    )
    if _checkout_redirected(page, checkout_url):
        log(f"测试支付链接已跳转: {_current_page_url(page)}")
        return True
    return False


def _is_ctf_sandbox_url(url: str) -> bool:
    lowered = str(url or "").lower()
    return "sandbox" in lowered or "ctf" in lowered


# ---------------------------------------------------------------------------
# DOM-based stage detector（参考 GuJumpgate content/paypal-flow.js）
# ---------------------------------------------------------------------------
#
# url 判断（``_is_paypal_intermediate_url`` 等）是早期实现，URL 模板每隔
# 半年就会被 PayPal 改。新增的 ``detect_paypal_stage`` 在 url 之外再读
# DOM 特征（OTP 输入框、consentButton、blocked 文案），让外层主循环可以
# **基于真实页面状态**决定下一步，而不是把"按顺序选 PayPal → 填账单 →
# 提交"硬编码在 try/except 链里。
#
# 主循环每轮先调一次本函数；返回的 stage 决定调用哪个 helper。已存在的
# url-based helper 仍然保留，作为 stage detector 的 fallback——避免一次
# 性大改打破已有测试。

_STAGE_CHATGPT_SUCCESS = "chatgpt_success"
_STAGE_HOSTED_CHECKOUT = "hosted_checkout"
_STAGE_CHATGPT_CHECKOUT = "chatgpt_checkout"
_STAGE_PAYPAL_LOGIN = "paypal_login"
_STAGE_PAYPAL_REVIEW = "paypal_review"
_STAGE_PAYPAL_VERIFY = "paypal_verify"
_STAGE_PAYPAL_BLOCKED = "paypal_blocked"
_STAGE_PAYPAL_GENERIC_ERROR = "paypal_generic_error"
_STAGE_PAYPAL_INTERMEDIATE = "paypal_intermediate"
_STAGE_CTF_SANDBOX = "ctf_sandbox"
_STAGE_UNKNOWN = "unknown"

_PAYPAL_STAGE_TERMINAL_FAIL = frozenset({_STAGE_PAYPAL_BLOCKED, _STAGE_PAYPAL_GENERIC_ERROR})


def detect_paypal_stage(page) -> dict:
    """探测当前 page 在 checkout 流程中所处的阶段。

    返回 ``{"stage": str, "host": str, "pathname": str, "signals": dict}``。
    JS 端就是 ``platforms/chatgpt/_payment_jslib.STAGE_PROBE_JS``——CDP
    通道下 Camoufox / BitBrowser / Chromium 行为一致，无需分支。

    任何异常（page 已关闭、跨域 frame）都吞掉返回 ``unknown``，调用方
    永远拿到合法 dict。
    """
    fallback = {
        "stage": _STAGE_UNKNOWN,
        "host": "",
        "pathname": "",
        "signals": {},
    }
    try:
        result = page.evaluate(STAGE_PROBE_JS)
    except Exception:
        return fallback
    if not isinstance(result, dict):
        return fallback
    return {
        "stage": str(result.get("stage") or _STAGE_UNKNOWN),
        "host": str(result.get("host") or ""),
        "pathname": str(result.get("pathname") or ""),
        "signals": dict(result.get("signals") or {}),
    }


def _is_paypal_intermediate_url(url: str) -> bool:
    lowered = str(url or "").lower()
    if "paypal." not in lowered:
        return False
    return "/agreements/approve" in lowered


def _is_paypal_approval_url(url: str) -> bool:
    return _is_paypal_intermediate_url(url)


def _is_paypal_pay_create_url(url: str) -> bool:
    lowered = str(url or "").lower()
    if "paypal." not in lowered:
        return False
    if ("/pay?" in lowered or "/pay/" in lowered) and "token=ba-" in lowered:
        return True
    return "/checkoutweb/signup" in lowered and "ba_token=ba-" in lowered


def _is_paypal_signin_required_url(url: str) -> bool:
    """PayPal Agree-and-Continue / 协议确认后被风控强制要求登录账号。

    实战：日本 IP 偶尔会从 ``/agreements/approve`` 直接跳到
    ``https://www.paypal.com/signin?intent=checkout&...&returnUri=/webapps/hermes&...``。
    用户没 PayPal 账号 / 不打算登录时这是终态硬失败——该号没法走通，应
    立刻关浏览器换号重试，而不是返回 ``status="submitted"`` 让上层误以为
    付款流已经走完。

    为了避免误伤"PayPal 已经登录、只是页面短暂跳到 signin 又自动跳回"
    的偶发状态，调用方应配合 url 多次轮询；本判断只表达"当前 url 形态
    匹配 signin"，不直接做 sleep。
    """
    lowered = str(url or "").lower()
    if "paypal." not in lowered:
        return False
    if "/signin" not in lowered:
        return False
    # signin 页常见两种形态：
    #   - ``/signin?intent=checkout&...&returnUri=/webapps/hermes&...``
    #     —— Agree 之后强制登录
    #   - ``/signin/?...`` —— 直接进入登录页
    return "intent=checkout" in lowered or "returnuri=" in lowered or lowered.endswith("/signin")


def _is_paypal_review_url(url: str) -> bool:
    lowered = str(url or "").lower()
    if "paypal." not in lowered:
        return False
    return "/webapps/hermes" in lowered


def _is_stripe_paypal_authorize_url(url: str) -> bool:
    lowered = str(url or "").lower()
    return "pm-redirects.stripe.com/authorize/" in lowered


def _is_paypal_authorize_start_url(url: str) -> bool:
    return (
        _is_stripe_paypal_authorize_url(url)
        or _is_paypal_intermediate_url(url)
        or _is_paypal_pay_create_url(url)
        or _is_paypal_signin_required_url(url)
        or _is_paypal_review_url(url)
    )


def _paypal_signin_offers_signup(page) -> bool:
    """signin 页是否提供 "创建账户 / 新規登録 / Sign Up" 入口。

    PayPal ``/signin?intent=checkout`` 页（美区 / 日区都一样）底部有一个
    "Create Account / 新規登録 / アカウントを開設" 按钮——点它会进入 guest
    signup 表单（和 ``/checkoutweb/signup`` 同一套表单）。美区实战就是在这
    页点 Create 进创建流程。

    本判断收紧到"页面真出现了 create/signup 入口"才返回 True，避免把"纯
    密码登录、无注册入口"的强制登录页误判成可继续。复用
    ``_ctf_create_account_ready`` 的按钮探测（已覆盖中/英/日文案）。
    """
    try:
        if _ctf_create_account_ready(page):
            return True
    except Exception:
        pass
    # signin 页特有的注册入口文案（_ctf_create_account_ready 之外的兜底）
    return _any_locator_ready(
        page,
        (
            lambda: page.locator('a[href*="signup" i]').first,
            lambda: page.locator('a[href*="create" i]').first,
            lambda: page.locator('button[data-testid*="signup" i]').first,
            lambda: page.locator('button:has-text("Sign Up")').first,
            lambda: page.locator('button:has-text("アカウントを開設")').first,
            lambda: page.locator('a:has-text("アカウントを開設")').first,
            lambda: page.get_by_role(
                "button",
                name=re.compile(
                    r"sign\s*up|create\s+(an\s+)?account|アカウントを開設|"
                    r"アカウントを作成|新規登録|登録する|开设账户|创建账户",
                    re.I,
                ),
            ).first,
            lambda: page.get_by_role(
                "link",
                name=re.compile(
                    r"sign\s*up|create\s+(an\s+)?account|アカウントを開設|"
                    r"アカウントを作成|新規登録|登録する|开设账户|创建账户",
                    re.I,
                ),
            ).first,
        ),
    )


def _extract_paypal_tokens_from_url(url: str) -> tuple[str, str]:
    """从 PayPal signin/checkout URL 抽 ``(ba_token, ec_token)``。

    signin 页 URL 形如::

        /signin?intent=checkout&ctxId=xo_ctx_EC-2A96...&returnUri=/webapps/hermes
                &state=%3Fflow%3D1-P%26ulReturn%3Dtrue%26ba_token%3DBA-1TP0...
                %26token%3DEC-2A96...&locale.x=ja_JP&country.x=JP

    ``ba_token`` / ``token`` 藏在 **二次 URL 编码**的 ``state`` 参数里；
    ``ctxId`` 形如 ``xo_ctx_EC-XXX`` 也含 EC token。这里直接对整串做
    正则兜底抽取（先 unquote 两次再 search），无视嵌套层级。
    找不到返回空串。
    """
    raw = str(url or "")
    candidates = [raw]
    try:
        candidates.append(unquote(raw))
        candidates.append(unquote(unquote(raw)))
    except Exception:
        pass
    ba_token = ""
    ec_token = ""
    for text in candidates:
        if not ba_token:
            m = re.search(r"\bba_token=(BA-[A-Z0-9]+)", text, re.I)
            if m:
                ba_token = m.group(1)
        if not ec_token:
            m = re.search(r"[?&]token=(EC-[A-Z0-9]+)", text, re.I)
            if m:
                ec_token = m.group(1)
        if not ec_token:
            m = re.search(r"(EC-[A-Z0-9]{17,})", text, re.I)
            if m:
                ec_token = m.group(1)
        if ba_token and ec_token:
            break
    return ba_token, ec_token


def _enter_signup_from_paypal_signin(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
) -> bool:
    """从 PayPal signin 页进入 guest signup 表单。

    两条路径，按可靠性排序：
      1. **URL 直达**（首选）：从 signin URL 抽 ``ba_token`` / ``ec_token``，
         直接 ``goto`` ``/checkoutweb/signup?token=EC-...&ba_token=BA-...``。
         比"找按钮点"稳得多——不依赖 signin 页是否渲染出创建入口、文案是
         中/英/日哪种。
      2. **点按钮**（兜底）：点页面上的 "创建账户 / 新規登録" 入口。

    任一路径成功离开 signin / 出现 signup 表单即返回 True；都失败返回 False。
    """
    start_url = _current_page_url(page)

    def _settled() -> bool:
        current = _current_page_url(page)
        if _is_paypal_signin_required_url(current):
            return False
        return (
            _ctf_signup_form_ready(page)
            or _ctf_create_account_ready(page)
            or _ctf_payment_form_ready(page)
            or _is_paypal_pay_create_url(current)
            or "/checkoutweb/" in current.lower()
        )

    # 路径 1：URL 直达 signup 表单
    ba_token, ec_token = _extract_paypal_tokens_from_url(start_url)
    if ec_token:
        signup_url = f"https://www.paypal.com/checkoutweb/signup?token={ec_token}"
        if ba_token:
            signup_url += f"&ba_token={ba_token}"
        signup_url += "&rcache=1&cookieBannerVariant=hidden"
        log(f"signin 页 → 直达 guest signup 表单: {signup_url}")
        try:
            page.goto(signup_url, wait_until="domcontentloaded", timeout=max(int(timeout_ms or 30000), 15000))
            try:
                page.wait_for_timeout(1500)
            except Exception:
                time.sleep(1.5)
            if _settled() or _is_paypal_pay_create_url(_current_page_url(page)) \
                    or "/checkoutweb/" in _current_page_url(page).lower():
                log(f"已直达创建流程: {_current_page_url(page)}")
                return True
            log(f"直达 signup 后页面未就绪，回退点按钮: {_current_page_url(page)}")
        except Exception as exc:
            log(f"直达 signup 表单失败，回退点按钮: {exc}")

    # 路径 2：点 "创建账户 / 新規登録" 按钮
    log(f"signin 页尝试点击创建账户入口: {_current_page_url(page)}")
    try:
        _click_ctf_create_account(page)
    except Exception as exc:
        log(f"signin 页点击创建账户入口失败: {exc}")
        return False
    deadline_ms = max(int(timeout_ms or 30000), 15000)
    waited = 0
    step = 600
    while waited < deadline_ms:
        try:
            page.wait_for_timeout(step)
        except Exception:
            time.sleep(step / 1000)
        waited += step
        if _settled():
            log(f"已从 signin 进入创建流程: {_current_page_url(page)}")
            return True
    log("点击创建账户入口后仍停留在 signin 页，判定无可用注册路径")
    return False


def _paypal_review_page_visible(page) -> bool:
    current_url = _current_page_url(page)
    if _is_paypal_review_url(current_url):
        return True
    if "paypal." not in str(current_url or "").lower():
        return False
    review_pattern = re.compile(
        r"review your payment|agree and continue|set up once|pay faster next time|同意|继续|"
        r"お支払いの確認|同意して続行|同意して次へ|一度設定すれば|次回からスムーズに",
        re.I,
    )
    locators = []
    for factory in (
        lambda: page.get_by_role("button", name=review_pattern).first,
        lambda: page.get_by_text(review_pattern).first,
        lambda: page.locator('button:has-text("Agree and Continue")').first,
        lambda: page.locator('button:has-text("同意して続行")').first,
        lambda: page.locator('button:has-text("同意して次へ")').first,
    ):
        try:
            locators.append(factory())
        except Exception:
            pass
    return any(_locator_visible(locator) for locator in locators)


def _click_paypal_approval_button(page) -> bool:
    approve_pattern = re.compile(
        r"agree|approve|continue|accept|confirm|save|同意|批准|继续|接受|确认|"
        r"承認|同意して続行|同意して次へ|続行|続ける|保存|確認|送信|次へ",
        re.I,
    )
    return _click_by_candidates(
        page,
        label="PayPal 协议确认按钮",
        selectors=(
            'button[data-testid*="paypal-approve" i]',
            'button[data-testid*="approve" i]',
            'button[data-testid*="continue" i]',
            'button[name*="approve" i]',
            'button[name*="continue" i]',
            'button[id*="approve" i]',
            'button[id*="continue" i]',
            'button[type="submit"]',
            'input[type="submit"]',
        ),
        patterns=(approve_pattern,),
    )


def _approve_paypal_agreement_if_needed(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
) -> str:
    paypal_url = _current_page_url(page)
    if not _is_paypal_intermediate_url(paypal_url):
        return paypal_url
    log(f"进入 PayPal 协议确认页: {paypal_url}")
    _wait_page_loaded(page, timeout_ms=timeout_ms, log=log, label="PayPal 协议确认页")
    click_result = _run_step_with_retries(
        "点击 PayPal 协议确认按钮",
        lambda: _click_paypal_approval_button(page),
        page=page,
        log=log,
        progressed=lambda: _current_page_url(page, paypal_url) != paypal_url,
        progressed_value=lambda: _current_page_url(page, paypal_url),
        progressed_log="PayPal 页面已进入下一跳，跳过当前确认点击",
    )
    if isinstance(click_result, str) and click_result:
        log(f"PayPal 协议确认后当前页面: {click_result}")
        # 代理断流会让点击后的跳转落到 chrome-error 页，重新加载几次再判
        if _is_page_load_error_url(click_result):
            if _recover_page_load_if_errored(page, timeout_ms=timeout_ms, log=log):
                return _current_page_url(page, paypal_url)
        return click_result
    log("已点击 PayPal 协议确认按钮，等待下一跳")
    # Python 端轮询，避开 paypal.com 的 CSP unsafe-eval 限制
    _poll_url_changed(
        page,
        initial_url=paypal_url,
        timeout_ms=max(int(timeout_ms or 30000), 30000),
        log=log,
        label="PayPal 协议确认页",
    )
    final_url = _current_page_url(page, paypal_url)
    # 代理断流：轮询期间页面落到 chrome-error，重新加载几次再判定
    if _is_page_load_error_url(final_url):
        if _recover_page_load_if_errored(page, timeout_ms=timeout_ms, log=log):
            final_url = _current_page_url(page, paypal_url)
    log(f"PayPal 协议确认后当前页面: {final_url}")
    return final_url


def _advance_paypal_intermediate_pages(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    max_steps: int = 6,
) -> str:
    current_url = _current_page_url(page)
    max_paypal_steps = max(int(max_steps or 6), 1)
    for step in range(1, max_paypal_steps + 1):
        # 代理断流：进入循环时页面可能已经是 chrome-error 页，先尝试恢复
        if _is_page_load_error_url(current_url):
            if _recover_page_load_if_errored(page, timeout_ms=timeout_ms, log=log):
                current_url = _current_page_url(page)
        if not _is_paypal_intermediate_url(current_url):
            return current_url
        log(f"处理 PayPal 中间页第 {step}/{max_paypal_steps} 次: {current_url}")
        current_url = _approve_paypal_agreement_if_needed(page, timeout_ms=timeout_ms, log=log)
    if _is_paypal_intermediate_url(current_url):
        raise RuntimeError(f"PayPal 中间页连续处理 {max_paypal_steps} 次后仍未离开: {current_url}")
    return current_url


def _click_paypal_review_agree_button(page) -> bool:
    agree_pattern = re.compile(
        r"agree\s+and\s+continue|agree|continue|同意|继续|"
        r"同意して続行|同意して次へ|承認|続ける|次へ",
        re.I,
    )
    return _click_by_candidates(
        page,
        label="PayPal 再次确认 Agree and Continue 按钮",
        selectors=(
            'button:has-text("Agree and Continue")',
            '[role="button"]:has-text("Agree and Continue")',
            'button:has-text("同意して続行")',
            '[role="button"]:has-text("同意して続行")',
            'button:has-text("同意して次へ")',
            '[role="button"]:has-text("同意して次へ")',
            'button[data-testid*="agree" i]',
            'button[data-testid*="continue" i]',
            'button[name*="agree" i]',
            'button[name*="continue" i]',
            'button[id*="agree" i]',
            'button[id*="continue" i]',
            'button[type="submit"]',
            'input[type="submit"]',
        ),
        patterns=(agree_pattern,),
    )


def _advance_paypal_review_if_needed(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    cancel_check: Callable[[], bool] | None = None,
    turnstile_solver: Callable[..., str] | None = None,
) -> str:
    def _raise_if_cancelled() -> None:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")

    active_page = _pick_active_page(page)
    if active_page is not page:
        log(f"PayPal review 阶段检测到原 page 已关闭，切换到上下文中存活的 page: {_current_page_url(active_page)}")
        page = active_page
    review_url = _current_page_url(page)
    if not _paypal_review_page_visible(page):
        return review_url
    log(f"进入 PayPal 再次确认页: {review_url}")
    _wait_page_loaded(page, timeout_ms=timeout_ms, log=log, label="PayPal 再次确认页")
    _raise_if_cancelled()
    # PayPal 再次确认页**偶尔**会再弹一次 security challenge（实战 < 5% 概率，
    # 一般是触发了它的 fraud 二次评估）。进入页面后先 try 一次自动求解，
    # 配了 ``turnstile_solver`` 就走 YesCaptcha，否则跳过。
    if callable(turnstile_solver) and _has_security_challenge(page):
        try:
            _wait_for_manual_security_challenge(
                page,
                timeout_ms=120000,
                log=log,
                cancel_check=cancel_check,
                turnstile_solver=turnstile_solver,
            )
        except Exception as exc:
            log(f"PayPal 再次确认页 security challenge 求解失败（继续尝试点击）: {exc}")
    _raise_if_cancelled()
    click_result = _run_step_with_retries(
        "点击 PayPal Agree and Continue",
        lambda: _click_paypal_review_agree_button(page),
        page=page,
        log=log,
        cancel_check=cancel_check,
        progressed=lambda: _current_page_url(page, review_url) != review_url,
        progressed_value=lambda: _current_page_url(page, review_url),
        progressed_log="PayPal 再次确认页已进入下一跳，跳过重复点击",
    )
    if isinstance(click_result, str) and click_result:
        log(f"PayPal 再次确认后当前页面: {click_result}")
        return click_result
    log("已点击 PayPal Agree and Continue，等待跳转（CSP 友好的 Python 轮询，3s/次）")
    # **关键修复**（用户实战日志）：原 ``page.wait_for_function`` 在 PayPal
    # hermes 页 CSP（``unsafe-eval`` 不允许）下立刻抛 EvalError 失效，外层
    # ``_run_step_with_retries`` 1 秒内重进重点 30 多次 Agree 按钮。改为
    # Python 端 3s 轮询 ``page.url``，命中 chatgpt.com / pay.openai.com 即立刻
    # return。
    poll_deadline = time.monotonic() + max(int(timeout_ms or 30000), 30000) / 1000
    while time.monotonic() <= poll_deadline:
        _raise_if_cancelled()
        current_url = _current_page_url(page, review_url)
        if _is_chatgpt_success_url(current_url):
            log(f"PayPal 再次确认后已跳到成功 URL: {current_url}")
            return current_url
        if current_url and current_url != review_url and not _is_paypal_review_url(current_url):
            log(f"PayPal 再次确认后已跳走: {current_url}")
            break
        try:
            page.wait_for_timeout(3000)
        except Exception:
            time.sleep(3)
    final_url = _current_page_url(page, review_url)
    if _is_paypal_review_url(final_url):
        raise RuntimeError(f"PayPal 再次确认页点击后未跳转: {final_url}")
    log(f"PayPal 再次确认后当前页面: {final_url}")
    return final_url


def _extract_six_digit_code(text: str) -> str:
    match = re.search(r"\b(\d{6})\b", str(text or ""))
    return match.group(1) if match else ""


def _extract_all_six_digit_codes(text: str) -> list[str]:
    """从 relay 响应里抽**所有**6 位数字串（按出现顺序去重）。

    ``_fetch_ctf_relay_code`` 的 baseline 模式用：在发起新 OTP_INITIATE 之前
    先把 relay 当前已有的所有 pin 都记下来，然后真实轮询时把它们当成"旧的"
    跳过，避免拿到上一次任务残留的 SMS（实战观察到两次任务同号 ``+182...``
    跑出完全相同的 pin ``799466``，第二次自然 ``VALIDATION_FAILED``）。
    """
    seen: list[str] = []
    seen_set: set[str] = set()
    for match in re.finditer(r"\b(\d{6})\b", str(text or "")):
        code = match.group(1)
        if code not in seen_set:
            seen.append(code)
            seen_set.add(code)
    return seen


def _fetch_ctf_relay_code(
    *,
    url: str | None = None,
    timeout_seconds: int = 300,
    poll_interval_seconds: float = 5,
    initial_burst_attempts: int = 4,
    initial_burst_interval: float = 1.5,
    log: Callable[[str], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    single_attempt: bool = False,
    excluded_pins: set[str] | None = None,
) -> str:
    """轮询 relay URL 拉取 6 位数字验证码。

    使用 "前期密集 + 后期稀疏" 的退避策略：
    - 前 ``initial_burst_attempts`` 次未命中 → 间隔 ``initial_burst_interval`` 秒；
    - 之后回到 ``poll_interval_seconds``。
    短信链路本身就有 5-15 秒抖动，密集前几次可以覆盖快路径，
    避免出现 "短信其实早到了，但下一轮 5 秒后才看到" 的体感卡顿。
    """
    relay_url = str(url or CTF_RELAY_CODE_URL or "").strip()
    if not relay_url:
        raise RuntimeError(
            "PayPal OTP relay 未配置：请通过任务 sms_pool 或 "
            "CHATGPT_PAYMENT_SMS_RELAY_URL 显式配置"
        )
    log_fn = log or (lambda message: None)
    deadline = time.monotonic() + max(int(timeout_seconds), 1)
    last_text = ""
    miss_count = 0
    while time.monotonic() <= deadline:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")
        # 拉响应。relay 服务可能返回多种形态：
        #   * JSON：``{"data": "...your code 123456..."}`` / ``{"code": "123456"}``
        #   * 纯文本：``"123456"`` 或 SMS 原文
        #   * HTML / 空字符串（极少数 endpoint 在没短信时这么响应）
        # 我们对所有情况一视同仁：把响应**字符串化后 grep 6 位数字**，避免在某些
        # endpoint 响应不是 JSON 时直接 ``json.JSONDecodeError`` 把整次任务拖死。
        try:
            resp = cffi_requests.get(relay_url, timeout=20)
            resp.raise_for_status()
        except Exception as exc:
            # 网络错或 4xx/5xx：当作"暂未出现"继续轮询，不抛硬错让上层 OTP 子链
            # 错失后续机会。最后一次轮询仍未拿到时 deadline 到了会抛
            # ``RuntimeError("未从验证码邮件中提取到...")``。
            log_fn(f"轮询请求失败（继续重试）: {exc}")
            last_text = ""
        else:
            payload_text = ""
            try:
                data = resp.json()
                if isinstance(data, dict):
                    # 优先尝试常见字段；都没有就 dump 整个 dict
                    for key in ("data", "code", "sms", "message", "text", "content"):
                        v = data.get(key)
                        if v:
                            payload_text = str(v)
                            break
                    if not payload_text:
                        payload_text = str(data)
                elif isinstance(data, list):
                    payload_text = str(data)
                else:
                    payload_text = str(data)
            except Exception:
                # 非 JSON 响应直接拿 text 来 grep
                payload_text = str(getattr(resp, "text", "") or "")
            last_text = payload_text
            # 当指定了 excluded_pins（OTP 子链拉过 baseline 的"上次残留 pin"）时，
            # 只接受**不在排除集**里的 6 位 code，避免拿到旧 SMS。
            # 实战 case：两次任务同号 +182…2563474 都拿到 799466（第二次失败），
            # 是因为部分 relay 服务返回的是包含历史的字串，regex 命中第一个。
            if excluded_pins:
                for code in _extract_all_six_digit_codes(payload_text):
                    if code not in excluded_pins:
                        log_fn(f"已获取 PayPal 验证码（跳过 {len(excluded_pins)} 条旧 pin）")
                        return code
            else:
                code = _extract_six_digit_code(payload_text)
                if code:
                    log_fn("已获取 PayPal 验证码")
                    return code

        if single_attempt:
            return ""
        miss_count += 1
        if miss_count <= max(int(initial_burst_attempts), 0):
            wait = max(float(initial_burst_interval), 0.1)
        else:
            wait = max(float(poll_interval_seconds), 1.0)
        log_fn(f"验证码邮件暂未出现，{wait:.1f}s 后重试 (第 {miss_count} 次)")
        time.sleep(wait)
    raise RuntimeError(f"未从验证码邮件中提取到 6 位数字验证码: {last_text[:120]}")


def parse_sms_pool(raw: str) -> list[dict]:
    """解析支付弹窗里的 SMS 号码池配置。

    每行格式（来自用户截图）::

        +<E164_PHONE>----https://relay.example.invalid/code

    返回形如 ``[{"phone": "<LOCAL_PHONE>", "phone_e164": "+<E164_PHONE>",
    "relay_url": "https://relay.example.invalid/code"}]`` 的列表（顺序保留）。空白行 / 注释行 / 不符
    格式的行会被静默忽略，方便用户从文件粘贴时夹杂注释。

    Note:
        ``phone`` 不带 ``+`` 前缀（PayPal SignUp 的 ``phone.number`` 不带国家码
        前缀的 +），``phone_e164`` 带 ``+``（短信发起 mutation 需要 E.164 格式）。
        我们一次性给出两种形态，避免上层调用方再做字符串切分。
    """
    pool: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for line in str(raw or "").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # 容忍 ----, ---, 任意数量的 - 作为分隔符，但至少 3 个 - 以避免误吞
        # 普通 url 里的破折号
        import re as _re
        match = _re.match(r"^\s*(\+?\d{6,16})\s*-{3,}\s*(https?://\S+)\s*$", stripped)
        if not match:
            continue
        phone_raw = match.group(1)
        relay_url = match.group(2)
        phone_e164 = phone_raw if phone_raw.startswith("+") else f"+{phone_raw}"
        phone = phone_e164.lstrip("+")
        key = (phone, relay_url)
        if key in seen:
            continue
        seen.add(key)
        pool.append(
            {
                "phone": phone,
                "phone_e164": phone_e164,
                "relay_url": relay_url,
            }
        )
    return pool


def _generate_ctf_test_identity() -> dict:
    first_name = secrets.choice(CTF_FIRST_NAMES)
    last_name = secrets.choice(CTF_LAST_NAMES)
    email_digits = "".join(secrets.choice(string.digits) for _ in range(5))
    email_suffix = "".join(secrets.choice(string.ascii_lowercase) for _ in range(3))
    token = secrets.token_hex(4)
    identity = {
        "email": f"{first_name.lower()}{last_name.lower()}{email_digits}{email_suffix}@gmail.com",
        "password": f"{first_name}{token}Aa1!",
        "first_name": first_name,
        "last_name": last_name,
        "name": f"{first_name} {last_name}",
    }
    deployment_fields = {
        "address_line1": CTF_ADDRESS_LINE1,
        "address_line2": CTF_ADDRESS_LINE2,
        "city": CTF_CITY,
        "state": CTF_STATE,
        "state_name": CTF_STATE_NAME or CTF_STATE,
        "postal_code": CTF_POSTAL_CODE,
        "date_of_birth": CTF_DATE_OF_BIRTH,
    }
    identity.update({key: value for key, value in deployment_fields.items() if value})
    return identity


def _apply_billing_profile_to_ctf_identity(identity: dict, billing_profile: Optional[dict]) -> dict:
    profile = billing_profile if isinstance(billing_profile, dict) else {}
    configured_fields = {
        "card_number": (profile.get("card_number"), CTF_CARD_NUMBER),
        "card_exp_month": (profile.get("card_exp_month"), CTF_CARD_EXP_MONTH),
        "card_exp_year": (profile.get("card_exp_year"), CTF_CARD_EXP_YEAR),
        "card_cvv": (profile.get("card_cvv"), CTF_CARD_CVV),
        "address_line1": (
            profile.get("address_line1") or profile.get("line1"),
            CTF_ADDRESS_LINE1,
        ),
        "address_line2": (
            profile.get("address_line2") or profile.get("line2"),
            CTF_ADDRESS_LINE2,
        ),
        "city": (profile.get("city"), CTF_CITY),
        "state": (profile.get("state"), CTF_STATE),
        "state_name": (
            profile.get("state_name") or profile.get("state"),
            CTF_STATE_NAME or CTF_STATE,
        ),
        "postal_code": (profile.get("postal_code"), CTF_POSTAL_CODE),
        "date_of_birth": (profile.get("date_of_birth"), CTF_DATE_OF_BIRTH),
    }
    for field, candidates in configured_fields.items():
        value = next((str(item).strip() for item in candidates if str(item or "").strip()), "")
        if value:
            identity[field] = value
        else:
            identity.pop(field, None)
    # JP 区：PayPal hosted guest checkout 要求姓名同时填**汉字**和**片假名**，
    # 还必须有合法的 ``#dateOfBirth``。注意：PayPal hosted 这个字段是带
    # ``M/D/YYYY`` 掩码的受控 input（``type=tel``），即使是日本区也走美式
    # 月/日/年布局，**不是** ``YYYY/MM/DD``。早期注释写错了，按 ``YYYY/MM/DD``
    # 写进去会被 mask 重排成 ``1/9/9207`` 这种 aria-invalid 值。从 ``JP_GIVEN_NAMES``
    # / ``JP_LAST_NAMES`` 各抽一对，保证两份姓名同源；US 池里那对英文姓
    # 名仍保留作 fallback（万一某条 JP 字段未出现，selector 扫不到也能继
    # 续按英文填，行为不退化）。
    region_code = str(profile.get("country") or "").strip().upper()
    if region_code == "JP":
        last_kanji, last_kana = secrets.choice(JP_LAST_NAMES)
        first_kanji, first_kana, _ = secrets.choice(JP_GIVEN_NAMES)
        identity["region"] = "JP"
        identity["first_name_kanji"] = first_kanji
        identity["last_name_kanji"] = last_kanji
        identity["first_name_kana"] = first_kana
        identity["last_name_kana"] = last_kana
        identity["jp_full_name"] = f"{last_kanji} {first_kanji}"
        identity["jp_full_name_kana"] = f"{last_kana} {first_kana}"
        # 把 JP 姓名也写入通用字段，让既有 ``#firstName`` / ``#lastName``
        # selector 直接命中（CTF sandbox 用 US 名时这两个字段也是同名走
        # 同一 fill 链路，只是值会被改成日文）。
        identity["first_name"] = first_kanji
        identity["last_name"] = last_kanji
        identity["name"] = f"{last_kanji} {first_kanji}"
    return identity


def _require_ctf_payment_configuration(identity: dict) -> None:
    required = {
        "phone": "phone / sms_pool",
        "phone_e164": "phone_e164 / sms_pool",
        "sms_relay_url": "relay_url / sms_pool",
        "card_number": "card_number",
        "card_exp_month": "card_exp_month",
        "card_exp_year": "card_exp_year",
        "card_cvv": "card_cvv",
        "address_line1": "address_line1",
        "city": "city",
        "state": "state",
        "postal_code": "postal_code",
        "date_of_birth": "date_of_birth",
    }
    missing = [label for field, label in required.items() if not str(identity.get(field) or "").strip()]
    if missing:
        raise RuntimeError(
            "PayPal hosted checkout 配置不完整（已安全终止）: " + ", ".join(missing)
        )


def _page_body_text(page) -> str:
    try:
        return str(page.locator("body").inner_text(timeout=2000) or "")
    except Exception:
        return ""


def _dump_page_clickables(page, *, log: Callable[[str], None], limit: int = 40) -> None:
    """把当前页面所有可见的 button / a / [role=button] 的文字 + 关键属性打到日志。

    专治"signin 页判定无创建入口但实际有按钮"这类盲区：检测失败时先 dump
    页面到底有哪些可点控件，便于按真实文案 / data-testid 扩选择器。
    遍历主 frame + 所有子 frame（PayPal 常把表单塞进 iframe）。
    """
    script = """
    () => {
      const out = [];
      const seen = new Set();
      const sel = 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]';
      for (const el of document.querySelectorAll(sel)) {
        try {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible = rect.width > 0 && rect.height > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none' &&
            Number(style.opacity || '1') > 0.05;
          if (!visible) continue;
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
          const tid = el.getAttribute('data-testid') || '';
          const id = el.getAttribute('id') || '';
          const name = el.getAttribute('name') || '';
          const href = (el.getAttribute('href') || '').slice(0, 60);
          const key = [el.tagName, text, tid, id, name, href].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 60), testid: tid, id, name, href });
        } catch (e) {}
      }
      return out;
    }
    """
    contexts = [page]
    try:
        contexts.extend(_iter_page_frames(page))
    except Exception:
        pass
    total = 0
    for ctx in contexts:
        try:
            items = ctx.evaluate(script)
        except Exception:
            continue
        if not items:
            continue
        ctx_url = ""
        try:
            ctx_url = str(getattr(ctx, "url", "") or "")
        except Exception:
            ctx_url = ""
        scope = "主页面" if ctx is page else f"frame({ctx_url[:48]})"
        for it in items:
            if total >= limit:
                log(f"  · [可点控件] …已达上限 {limit} 条，省略其余")
                return
            log(
                f"  · [可点控件/{scope}] <{it.get('tag')}> "
                f"text={it.get('text')!r} testid={it.get('testid')!r} "
                f"id={it.get('id')!r} name={it.get('name')!r} href={it.get('href')!r}"
            )
            total += 1
    if total == 0:
        log("  · [可点控件] 未扫描到任何可见 button/link（页面可能还没渲染完）")


def _extract_paypal_onboarding_redirect_url(text: str) -> str:
    match = re.search(r'"onboardingRedirectUrl"\s*:\s*"((?:\\.|[^"\\])*)"', str(text or ""))
    if not match:
        return ""
    raw_url = match.group(1)
    try:
        url = json.loads(f'"{raw_url}"')
    except Exception:
        url = raw_url.replace(r"\/", "/").replace(r"\u0026", "&")
    url = str(url or "").strip()
    if not _is_paypal_intermediate_url(url):
        return ""
    return url


def _follow_paypal_onboarding_redirect_response(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
) -> bool:
    if not _is_paypal_pay_create_url(_current_page_url(page)):
        return False
    redirect_url = _extract_paypal_onboarding_redirect_url(_page_body_text(page))
    if not redirect_url:
        return False
    log(f"检测到 PayPal onboardingRedirectUrl，手动跳转: {redirect_url}")
    page.goto(
        redirect_url,
        wait_until="domcontentloaded",
        timeout=max(int(timeout_ms or 30000), 30000),
    )
    return True


def _any_locator_ready(page, factories) -> bool:
    for factory in factories:
        try:
            if _locator_ready(factory()):
                return True
        except Exception:
            pass
    return False


def _any_locator_visible(page, factories) -> bool:
    for factory in factories:
        try:
            if _locator_visible(factory()):
                return True
        except Exception:
            pass
    return False


def _ctf_signup_email_ready(page) -> bool:
    return _any_locator_visible(
        page,
        (
            lambda: page.locator("#login_email").first,
            lambda: page.locator('input[name="login_email"]').first,
            lambda: page.locator('input[type="email"]').first,
            lambda: page.locator('input[name="email"]').first,
            lambda: page.locator('input[autocomplete="username"]').first,
            lambda: page.locator('input[autocomplete="email"]').first,
            lambda: page.locator("#email").first,
            lambda: page.get_by_label(re.compile(r"email|邮箱|メール|メールアドレス", re.I)).first,
        ),
    )


def _ctf_continue_to_payment_ready(page) -> bool:
    return _any_locator_visible(
        page,
        (
            lambda: page.locator('button[data-testid="continueButton"]').first,
            lambda: page.locator('button[data-atomic-wait-intent="Continue_To_Payment"]').first,
            lambda: page.locator('button[data-testid*="continue" i]').first,
            lambda: page.locator('button:has-text("Continue to Payment")').first,
            lambda: page.locator('button:has-text("お支払いに進む")').first,
            lambda: page.locator('button:has-text("支払いへ進む")').first,
            lambda: page.get_by_role("button", name=re.compile(r"continue to payment|お支払いに進む|支払いへ進む|お支払い手続き", re.I)).first,
        ),
    )


def _ctf_create_account_ready(page) -> bool:
    return _any_locator_ready(
        page,
        (
            lambda: page.locator('a[href*="create" i]').first,
            lambda: page.locator('button[data-testid*="create" i]').first,
            lambda: page.locator('button:has-text("Create an account")').first,
            lambda: page.locator('a:has-text("Create an account")').first,
            lambda: page.locator('button:has-text("アカウントを作成")').first,
            lambda: page.locator('a:has-text("アカウントを作成")').first,
            lambda: page.locator('button:has-text("新規登録")').first,
            lambda: page.locator('a:has-text("新規登録")').first,
            lambda: page.get_by_role("button", name=re.compile(r"create an account|create account|创建账户|创建账号|アカウントを作成|アカウント作成|新規登録|登録する", re.I)).first,
            lambda: page.get_by_role("link", name=re.compile(r"create an account|create account|创建账户|创建账号|アカウントを作成|アカウント作成|新規登録|登録する", re.I)).first,
        ),
    )


def _ctf_signup_form_ready(page) -> bool:
    return _ctf_signup_email_ready(page) and _ctf_continue_to_payment_ready(page)


def _ctf_payment_form_ready(page) -> bool:
    return _any_locator_ready(
        page,
        (
            lambda: page.locator('input[name*="card" i]').first,
            lambda: page.locator('input[autocomplete="cc-number"]').first,
            lambda: page.locator('input[type="tel"]').first,
            lambda: page.locator('input[name*="phone" i]').first,
            lambda: page.locator('input[type="password"]').first,
        ),
    )


def _ctf_card_field_ready(page) -> bool:
    """页面上是否**直接**出现了信用卡号输入框。

    用来区分 PayPal 两种 guest 形态：
      - "Create account → 邮箱 → Continue to Payment" 两步式（邮箱页**没有**卡号框）
      - 直达 ``/checkoutweb/signup`` 的**统一 guest 表单**：国/地域 + メール +
        電話番号 + カード番号 同页（卡号框直接在）

    卡号框是统一表单的强信号（邮箱-only 步骤不会有），据此判断"已经在最终
    填写页，无需再走创建账户/Continue 两步"。
    """
    return _any_locator_ready(
        page,
        (
            lambda: page.locator('input[autocomplete="cc-number"]').first,
            lambda: page.locator('input[name*="cardnumber" i]').first,
            lambda: page.locator('input[name*="card_number" i]').first,
            lambda: page.locator('input[name*="card-number" i]').first,
            lambda: page.locator('input[id*="cardnumber" i]').first,
            lambda: page.locator('input[id*="card-number" i]').first,
            lambda: page.locator('input[placeholder*="カード番号"]').first,
            lambda: page.locator('input[aria-label*="カード番号"]').first,
            lambda: page.locator('input[placeholder*="Card number" i]').first,
            lambda: page.locator('input[aria-label*="Card number" i]').first,
        ),
    )


def _ctf_after_continue_ready(page) -> bool:
    return _has_security_challenge(page) or _ctf_payment_form_ready(page) or _ctf_verification_popup_visible(page)


def _has_security_challenge_text(page) -> bool:
    """检测页面正文是否明确显示了 "Security Challenge" 类提示。

    **关键字必须收紧**：之前用 ``"captcha"`` / ``"人机"`` / ``"验证码"`` 这类
    单字 / 子串太松，会被 Stripe / ChatGPT 结账页里的无关词（``verify your
    billing``, ``card verification value`` 一类常规支付术语）和 DOM 里
    ``data-captcha-foo`` 之类的属性命中，造成 progressed / challenge 误判。

    现在只匹配真正的挑战页面用语：完整短语 ``security challenge`` / ``human
    verification`` / ``verify you are human`` / ``i am human``，以及对应中文
    短语 ``安全验证`` / ``人机验证``。
    """
    text = _page_body_text(page).lower()
    if any(
        token in text
        for token in (
            "security challenge",
            "verify you are human",
            "human verification",
            "i am human",
            "i'm human",
            "are you human",
        )
    ):
        return True
    if any(token in text for token in ("人机验证", "安全验证")):
        return True
    # 日文 Cloudflare/PayPal 人机校验文案
    if any(
        token in text
        for token in (
            "セキュリティチェック",
            "セキュリティ確認",
            "本人確認",
            "人間であることを確認",
            "あなたは人間ですか",
            "私は人間です",
        )
    ):
        return True
    return False


def _has_security_challenge(page) -> bool:
    if _has_security_challenge_text(page):
        return True
    try:
        for frame in getattr(page, "frames", []) or []:
            frame_url = str(getattr(frame, "url", "") or "").lower()
            if any(token in frame_url for token in ("captcha", "challenge", "turnstile", "recaptcha")):
                return True
    except Exception:
        pass
    return False


def _has_real_security_challenge(page) -> bool:
    """严格版 security challenge 判断，用于 paypal_mock 创建账户页面。

    PayPal 自家 ``paypal.com/pay`` 创建账号页里会嵌入若干内部 fraud 检测
    iframe，URL 经常含 ``challenge``/``captcha`` 一类关键字（PayPal 内部
    风控信号，**不是**真正的 captcha 控件）。`_has_security_challenge` 看
    frame URL 关键字会把它误报，让主流程在 "create an account" 阶段空跑
    captcha solver、3 次后超时失败（症状：日志连续两条
    "检测到 security challenge，主动调用 captcha solver 求解" 后流程
    直接失败）。

    本函数在 paypal_mock 页面下要求：要么页面正文有 "security challenge"
    / "captcha" / "human verification" 等措辞，要么能从 DOM/frame 中实际
    抠出 Turnstile/reCAPTCHA sitekey，才认定为"真"挑战。其他场景回退到
    `_has_security_challenge` 的宽松判断（CTF sandbox 等老流程仍依赖
    iframe URL 检测）。
    """
    if not _is_paypal_pay_create_url(_current_page_url(page)):
        return _has_security_challenge(page)
    if _has_security_challenge_text(page):
        return True
    if _extract_turnstile_sitekey(page):
        return True
    if _extract_recaptcha_sitekey(page):
        return True
    return False


def _try_complete_ctf_sandbox_click_challenge(page, *, log: Callable[[str], None]) -> bool:
    current_url = _current_page_url(page)
    is_paypal_mock_challenge = _is_paypal_pay_create_url(current_url) and _has_security_challenge_text(page)
    if not (_is_ctf_sandbox_url(current_url) or is_paypal_mock_challenge):
        return False
    challenge_label = "PayPal mock I am human" if is_paypal_mock_challenge else "CTF sandbox 点击验证"
    log(f"检测到 {challenge_label}，尝试自动点击")
    try:
        _click_security_challenge_control(page, label=challenge_label)
    except Exception as exc:
        log(f"{challenge_label}未找到可点击控件: {exc}")
        return False
    try:
        page.wait_for_timeout(1000)
    except Exception:
        time.sleep(1)
    if is_paypal_mock_challenge:
        if _is_ctf_sandbox_url(_current_page_url(page)) or not _has_security_challenge_text(page):
            log("PayPal mock I am human 已点击完成")
            return True
        log("PayPal mock I am human 点击后仍检测到 challenge")
        return False
    if not _has_security_challenge(page):
        log("CTF sandbox 点击验证已完成")
        return True
    log("CTF sandbox 点击验证后仍检测到 challenge")
    return False


def _iter_page_frames(page) -> list:
    """安全枚举 page 上的所有 frame（包括跨域子 frame）。

    Playwright 的 ``page.frames`` 已经是扁平列表，枚举包括嵌套 iframe。
    这里再做兜底保护，避免某些场景下属性访问抛异常。
    """
    try:
        frames = getattr(page, "frames", None)
        if frames is None:
            return []
        return list(frames or [])
    except Exception:
        return []


# === PayPal Hosted Checkout 软 Captcha 旁路 ==================================
#
# **背景**：``FoundZiGu/GuJumpgate`` Chrome 扩展自称对 ChatGPT Plus → PayPal
# 注册 + 激活全流程 100% 通过率，README 里只透露关键信息：**"账单页面的
# Captcha 扩展已经实现了自动屏蔽"** + **"PayPal 注册代理越干净，越不容易触发
# PayPal 注册滑块"**。源码不公开（只发 release zip），我们没看到具体 selector。
#
# 选择器是我们**按 PayPal hosted checkout 通用 DOM 约定 + GuJumpgate README
# 描述推断**的（id="captcha-standalone" / class="captcha-overlay" /
# class="captcha-container"），并非照抄。如果未来逆向出真实清单可以扩充。
#
# **适用范围**：PayPal billing / signup 页 PayPal 临时挂出的 **软 captcha** 浮层
# ——它本质是覆盖在表单 DOM 之上的一层 overlay，PayPal 在**真实 Chrome +
# 干净 US 代理**场景下显示这种软 overlay；删 overlay 后 submit button 直接可
# 触发 form 提交，PayPal 后端不再二次校验。
#
# **不适用范围**：``<h1>Security Challenge</h1>`` 全屏重定向 / **hCaptcha 硬
# 挑战**（iframe + sitekey + 后端 token 强校验）。**硬 captcha 的核心在**：
# PayPal 后端 **必须**收到 hCaptcha solver 算出来的 token 才放行，删 iframe
# 不解决问题——token 没生成，提交会被 reject。硬挑战要走
# ``_try_auto_solve_security_challenge`` 调 captcha 服务商求解。
#
# **GuJumpgate 100% 成功率的边界**：README 明示测试环境是 **真实 Chrome
# 148 + US 自建代理 + 无痕模式**——这种"干净环境"PayPal 给的就是软 captcha
# 不是硬 hCaptcha，所以 DOM 删除就够了。我们在 Camoufox (Firefox) + 数据
# 中心代理的环境下，PayPal 倾向于升级到硬 hCaptcha，DOM 删除帮不上。
#
# **实现要点**：
# 1) **content-script 等价物**：通过 ``page.add_init_script`` 在每个页面
#    navigate 之前注入，让 stripper 在 PayPal 自家脚本运行**之前**就装好
#    MutationObserver——这才是 GuJumpgate 扩展同款行为（content script 也是
#    在 ``document_start`` 阶段注入）。
# 2) **observer 寿命 5min**：覆盖整个 checkout（包括手填 OTP / 等 review）。
# 3) **window sentinel 防重装**：同一 page 反复 evaluate 不会装多个 observer。
# 4) **删除节点数 = 0 也打 log**：方便诊断 stripper 是否实际跑了。

_PAYPAL_CAPTCHA_DOM_STRIPPER_JS = (
    "(function () {\n"
    "    // 三类要清理的 PayPal 软 captcha：\n"
    "    //   A) #captcha-standalone / .captcha-overlay / .captcha-container\n"
    "    //      ——authchallenge interstitial 遮罩（GuJumpgate 同款），覆盖\n"
    "    //      在下层 SMS OTP / 主表单**上面**，自带\n"
    "    //      form[action=\"/auth/validatecaptcha\"]。即便内含 reCAPTCHA\n"
    "    //      iframe 也直接删（实战 DOM：删后下层原 form 能正常 submit，\n"
    "    //      不需要真解 reCAPTCHA）。\n"
    "    //   B) 通过 captcha 信号节点反向找最外层包裹 modal 容器整体删——\n"
    "    //      实战：账单页 SMS 提交后弹的 captcha modal 不一定带 A 里的\n"
    "    //      标准 class，但内含 iframe[name=\"recaptcha\"] /\n"
    "    //      #captchaHeading / form[action=\"/auth/validatecaptcha\"]。\n"
    "    //      从这些信号节点向上爬找 dialog/modal/overlay 容器删。\n"
    "    //   C) [data-testid*=securityChallenge] 软遮罩：含真 hCaptcha /\n"
    "    //      Turnstile iframe 的节点保留（专用 solver / 自动点击复选框\n"
    "    //      路径处理），其它纯前端软遮罩直接删。\n"
    "    function findOverlayAncestor(node) {\n"
    "        let cur = node;\n"
    "        for (let i = 0; cur && i < 10; i++) {\n"
    "            const cls = String((cur.className || '') + '').toLowerCase();\n"
    "            const id = String((cur.id || '') + '').toLowerCase();\n"
    "            const role = (cur.getAttribute && cur.getAttribute('role')) || '';\n"
    "            if (\n"
    "                cls.includes('overlay')\n"
    "                || cls.includes('modal')\n"
    "                || cls.includes('captcha')\n"
    "                || cls.includes('challenge')\n"
    "                || cls.includes('interstitial')\n"
    "                || id.includes('captcha')\n"
    "                || id.includes('challenge')\n"
    "                || id === 'ads-plugin'\n"
    "                || role === 'dialog'\n"
    "                || role === 'alertdialog'\n"
    "            ) {\n"
    "                return cur;\n"
    "            }\n"
    "            cur = cur.parentElement;\n"
    "        }\n"
    "        return node;\n"
    "    }\n"
    "    function strip() {\n"
    "        let removed = 0;\n"
    "        // A 路径：直接 selector 强删\n"
    "        const FORCE_DROP_SELECTORS = [\n"
    "            '#captcha-standalone',\n"
    "            '.captcha-overlay',\n"
    "            '.captcha-container',\n"
    "            'form[action=\"/auth/validatecaptcha\"]',\n"
    "            '#captchaHeading',\n"
    "            '#captchaComponent',\n"
    "            '.ngrl-anomalydetection-div',\n"
    "            '#ads-plugin',\n"
    "        ];\n"
    "        for (const sel of FORCE_DROP_SELECTORS) {\n"
    "            try {\n"
    "                for (const node of document.querySelectorAll(sel)) {\n"
    "                    try { node.remove(); removed += 1; } catch (e) {}\n"
    "                }\n"
    "            } catch (e) {}\n"
    "        }\n"
    "        // B 路径：从 captcha 信号节点向上找 overlay 容器删\n"
    "        const CAPTCHA_SIGNAL_SELECTORS = [\n"
    "            'iframe[name=\"recaptcha\"]',\n"
    "            'iframe[src*=\"recaptcha\" i][src*=\"siteKey\" i]',\n"
    "            'iframe[src*=\"recaptcha_v2\" i]',\n"
    "        ];\n"
    "        for (const sel of CAPTCHA_SIGNAL_SELECTORS) {\n"
    "            try {\n"
    "                for (const node of document.querySelectorAll(sel)) {\n"
    "                    try {\n"
    "                        const ancestor = findOverlayAncestor(node);\n"
    "                        if (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {\n"
    "                            ancestor.remove();\n"
    "                            removed += 1;\n"
    "                        }\n"
    "                    } catch (e) {}\n"
    "                }\n"
    "            } catch (e) {}\n"
    "        }\n"
    "        // C 路径：data-testid*=securityChallenge 等，不含真硬 captcha 才删\n"
    "        const SOFT_SELECTORS = [\n"
    "            '[data-testid*=\"securityChallenge\" i]',\n"
    "            '[data-testid*=\"security-challenge\" i]',\n"
    "            '[id*=\"securityChallenge\" i]',\n"
    "            '[id*=\"security-challenge\" i]',\n"
    "            '[class*=\"securityChallenge\" i]',\n"
    "            '[class*=\"security-challenge\" i]',\n"
    "        ];\n"
    "        for (const sel of SOFT_SELECTORS) {\n"
    "            try {\n"
    "                for (const node of document.querySelectorAll(sel)) {\n"
    "                    try {\n"
    "                        if (node.querySelector('iframe[src*=\"hcaptcha\" i], iframe[src*=\"turnstile\" i]')) {\n"
    "                            continue;\n"
    "                        }\n"
    "                        node.remove();\n"
    "                        removed += 1;\n"
    "                    } catch (e) {}\n"
    "                }\n"
    "            } catch (e) {}\n"
    "        }\n"
    "        return removed;\n"
    "    }\n"
    "    const SENTINEL = '__MULTIPAGE_PAYPAL_CAPTCHA_STRIPPER__';\n"
    "    if (!window[SENTINEL]) {\n"
    "        window[SENTINEL] = true;\n"
    "        try {\n"
    "            const observer = new MutationObserver(strip);\n"
    "            observer.observe(document.documentElement || document.body, {\n"
    "                childList: true,\n"
    "                subtree: true\n"
    "            });\n"
    "            // **额外**：MutationObserver 偶尔会漏（PayPal 用 display 切换\n"
    "            // 而非 childList 增删，或挑战在 observer 续命间隙出现）。再挂\n"
    "            // 一个 1s setInterval 主动扫，双保险——尤其覆盖 JP 流程里\n"
    "            // SMS 等待期间 NGRL 异步注入的 reCAPTCHA authchallenge。\n"
    "            const ticker = setInterval(strip, 1000);\n"
    "            // 寿命拉到 20min：JP 的 SMS OTP 流程（120s 初始 + 多轮 resend\n"
    "            // + 换号）经常超过原来的 5min，observer/ticker 提前死掉会让\n"
    "            // 后出现的挑战无人清理。\n"
    "            setTimeout(function () {\n"
    "                try { observer.disconnect(); } catch (e) {}\n"
    "                try { clearInterval(ticker); } catch (e) {}\n"
    "                try { window[SENTINEL] = false; } catch (e) {}\n"
    "            }, 1200000);\n"
    "        } catch (e) {}\n"
    "    }\n"
    "    return strip();\n"
    "})();"
)


def _arm_paypal_captcha_stripper_on_navigations(page, *, log: Callable[[str], None]) -> bool:
    """**Content-script 等价物**：用 ``page.add_init_script`` 让 stripper 在每个
    页面 navigate **之前**自动注入——比 ``page.evaluate`` 主动调用更早，赶在
    PayPal 自家脚本加载 captcha overlay 之前就装好 MutationObserver。

    这正是 GuJumpgate Chrome 扩展 ``content_scripts: run_at: document_start``
    同款行为。Playwright/patchright 都支持 ``add_init_script``。

    返回 True 表示成功 arm；False 表示 page/context 已死或不支持。

    调用方应在 page 一创建时立刻调一次，之后整条 checkout 流程不需要再装
    ``MutationObserver``——init_script 会自动在每次 navigate 时跑。**仍然**
    可以额外调 ``_install_paypal_captcha_dom_stripper`` 立即扫一遍当前 DOM
    （针对 init_script arm 之**前**就已存在的浮层节点）。
    """
    try:
        page.add_init_script(_PAYPAL_CAPTCHA_DOM_STRIPPER_JS)
        log("已 arm PayPal captcha stripper init_script（每次 navigate 自动注入）")
        return True
    except Exception as exc:
        log(f"arm PayPal captcha stripper init_script 失败（不阻塞）: {exc}")
        return False


def _arm_autocomplete_suppressor_on_navigations(page, *, log: Callable[[str], None]) -> bool:
    """同 ``_arm_paypal_captcha_stripper_on_navigations`` 的范式，把 Stripe 地址
    autocomplete 浮层抑制器装成 init_script。

    Stripe hosted checkout 的 ``.AddressAutocomplete-results`` 浮层会盖住
    ``Subscribe`` / ``Pay`` 按钮，导致 click 被吃掉。GuJumpgate 用同款
    MutationObserver 隐藏这类节点。Playwright 端走 init_script 跟 PayPal
    captcha stripper 完全平行——单独成一个函数是为了让上层启动逻辑分别
    控制（比如未来想给 BitBrowser 路径单独关掉 captcha stripper 而保留
    autocomplete suppressor 也方便）。

    返回 True/False；任何异常都吞掉只 log，不阻塞主流程。
    """
    try:
        page.add_init_script(AUTOCOMPLETE_SUPPRESSOR_JS)
        log("已 arm autocomplete suppressor init_script（隐藏 Stripe 地址浮层）")
        return True
    except Exception as exc:
        log(f"arm autocomplete suppressor init_script 失败（不阻塞）: {exc}")
        return False


def _install_paypal_captcha_dom_stripper(page, *, log: Callable[[str], None]) -> int:
    """主动扫一遍当前 DOM + 所有 frame，立即删 ``#captcha-standalone`` /
    ``.captcha-overlay`` / ``.captcha-container`` 节点 + 装 MutationObserver 守
    5 分钟。返回这一轮被删的节点总数（仅用于日志）。

    **跟 ``_arm_paypal_captcha_stripper_on_navigations`` 互补**：arm 走
    init_script 装在每次 navigate **之前**——但 arm 之前已加载的页面要靠
    本函数立即扫一遍。两者都装上 window sentinel，互不重复。

    本函数对 page 关闭 / frame 失活 / 跨域 evaluate 异常都做兜底，调用方
    不需要包 try/except。单个 frame 失败不影响主流程。

    **永远打 log**：即便删 0 个节点也打——方便诊断 stripper 是否真跑了。
    """
    total_removed = 0
    try:
        result = page.evaluate(_PAYPAL_CAPTCHA_DOM_STRIPPER_JS)
        if isinstance(result, (int, float)):
            total_removed += int(result)
    except Exception as exc:
        log(f"主 page 装 PayPal captcha DOM stripper 失败（不阻塞）: {exc}")
    for frame in _iter_page_frames(page):
        try:
            result = frame.evaluate(_PAYPAL_CAPTCHA_DOM_STRIPPER_JS)
            if isinstance(result, (int, float)):
                total_removed += int(result)
        except Exception:
            # 跨域 frame 经常 evaluate 抛错，正常跳过
            pass
    log(f"PayPal captcha DOM stripper: 立即删除 {total_removed} 个节点（observer 仍守 5min）")
    return total_removed


_PAYPAL_GUEST_ENTRY_BUTTON_PATTERN = re.compile(
    r"pay\s+with\s+(?:debit|credit)|pay\s+with\s+card|continue\s+as\s+guest|"
    r"guest\s+checkout|不创建账户|访客|不注册|"
    r"デビット.*クレジット|クレジット.*カード|カードで(支払う|お支払い)|"
    r"ゲスト.*続行|ゲストとして(続行|お支払い)|アカウントを作成せずに",
    re.I,
)


def _try_click_paypal_pay_with_card_or_guest(
    page,
    *,
    log: Callable[[str], None],
) -> bool:
    """在点 "Create an account" 之前，先试着点 "Pay with debit or credit card" /
    "Continue as Guest" 直通 ``/checkoutweb/`` guest checkout 表单。

    **背景**：PayPal hosted checkout 提供两条路径：
      1. "Create an account"——重型路径，必跳 SMS OTP + fraud 二次评估 +
         hCaptcha 硬挑战的概率显著更高。
      2. "Pay with debit or credit card" / "Continue as Guest"——轻量路径，
         直接进 ``/checkoutweb/`` guest 表单填卡 + 账单提交。GuJumpgate
         实战的 100% 成功率主要靠走这条。

    **行为**：找到按钮就点并 wait 1s 让导航发生；找不到就返 False，调用方
    回退到原 Create-an-account 路径。**不抛错**——找不到按钮是正常情况
    （PayPal 不一定每次都给 guest 入口）。

    返回 True 表示已点击 guest 入口，False 表示未找到（应继续走 Create-an-account）。
    """
    locators = []
    for factory in (
        lambda: page.get_by_role("button", name=_PAYPAL_GUEST_ENTRY_BUTTON_PATTERN).first,
        lambda: page.get_by_role("link", name=_PAYPAL_GUEST_ENTRY_BUTTON_PATTERN).first,
        lambda: page.locator('button[data-testid*="guest" i]').first,
        lambda: page.locator('button[data-testid*="card" i]').first,
        lambda: page.locator('a[data-testid*="guest" i]').first,
        lambda: page.get_by_text(_PAYPAL_GUEST_ENTRY_BUTTON_PATTERN).first,
    ):
        try:
            locators.append(factory())
        except Exception:
            pass
    for locator in locators:
        if not _locator_ready(locator):
            continue
        try:
            _click_or_check(locator)
        except Exception as exc:
            log(f"PayPal guest 入口点击失败（继续尝试下一个候选）: {exc}")
            continue
        log("已点击 PayPal guest 入口（Pay with card / Continue as Guest）")
        try:
            page.wait_for_timeout(1500)
        except Exception:
            time.sleep(1.5)
        return True
    return False


_TURNSTILE_DOM_SCRIPT = (
    "() => {\n"
    "    const sel = '[data-sitekey], .cf-turnstile, [data-captcha-sitekey]';\n"
    "    for (const el of document.querySelectorAll(sel)) {\n"
    "        const k = el.getAttribute('data-sitekey') || el.getAttribute('data-captcha-sitekey');\n"
    "        if (k) return k;\n"
    "    }\n"
    "    const ifr = [...document.querySelectorAll('iframe')].find((f) => (f.src || '').includes('challenges.cloudflare.com'));\n"
    "    if (ifr) {\n"
    "        try {\n"
    "            const u = new URL(ifr.src);\n"
    "            const sk = u.searchParams.get('sitekey') || u.searchParams.get('k');\n"
    "            if (sk) return sk;\n"
    "        } catch (e) {}\n"
    "        const m = ifr.src.match(/\\/turnstile\\/[^\\/]+\\/([0-9a-zA-Z_-]+)/);\n"
    "        if (m) return m[1];\n"
    "    }\n"
    "    return '';\n"
    "}"
)


def _turnstile_sitekey_from_url(raw_url: str) -> str:
    """从 cloudflare turnstile 类 iframe URL 中抠 sitekey。

    匹配优先级：
    1. ``?sitekey=0xXXX`` 或 ``?k=0xXXX`` query 参数（最稳）。
    2. 路径 ``/turnstile/v0/.../0xXXX``（cloudflare 当前格式）。
    3. 路径 ``/turnstile/<seg>/<token>`` 的 fallback（兼容老 URL 与测试 stub）。
    """
    raw_url = str(raw_url or "")
    if not raw_url or "challenges.cloudflare.com" not in raw_url.lower():
        return ""
    try:
        parsed = urlparse(raw_url)
        query = parse_qs(parsed.query)
        for key in ("sitekey", "k"):
            values = query.get(key) or []
            if values and str(values[0] or "").strip():
                return str(values[0]).strip()
        match = re.search(
            r"/turnstile/v0/[^/]+/(0x[0-9a-zA-Z_-]+)", parsed.path or ""
        )
        if match:
            return match.group(1)
        match = re.search(r"/turnstile/[^/]+/([0-9a-zA-Z_-]+)", parsed.path or "")
        if match:
            candidate = match.group(1)
            # 'v0' 这种是版本号，需要更长 / 0x 开头才算合理 sitekey
            if candidate.startswith("0x") or len(candidate) >= 8:
                return candidate
    except Exception:
        pass
    return ""


def _extract_turnstile_sitekey(page) -> str:
    """从主 DOM、所有 frame DOM 以及 frame URL 中提取 Turnstile sitekey。

    PayPal mock 页面的 Turnstile widget 经常被嵌在跨域子 iframe 中
    （PayPal 自家 risk iframe → cloudflare iframe），单看主 DOM 是抠不出
    sitekey 的，必须遍历每个 frame 各自 evaluate + 解析 frame URL。
    """
    try:
        sitekey = page.evaluate(_TURNSTILE_DOM_SCRIPT)
        if sitekey:
            return str(sitekey).strip()
    except Exception:
        pass
    # 子 frame 的 DOM（如 PayPal 自家的 risk iframe 内挂载了 cf-turnstile div）
    for frame in _iter_page_frames(page):
        try:
            sitekey = frame.evaluate(_TURNSTILE_DOM_SCRIPT)
            if sitekey:
                return str(sitekey).strip()
        except Exception:
            pass
    # frame URL 直接是 cloudflare turnstile 的 iframe
    for frame in _iter_page_frames(page):
        sitekey = _turnstile_sitekey_from_url(str(getattr(frame, "url", "") or ""))
        if sitekey:
            return sitekey
    return ""


def _recaptcha_sitekey_from_url(raw_url: str) -> str:
    try:
        parsed = urlparse(str(raw_url or ""))
        if "recaptcha" not in parsed.netloc.lower() and "recaptcha" not in parsed.path.lower():
            return ""
        values = parse_qs(parsed.query).get("k") or []
        return str(values[0] or "").strip() if values else ""
    except Exception:
        return ""


_RECAPTCHA_DOM_SCRIPT = (
    "() => {\n"
    "    const selectors = ['.g-recaptcha[data-sitekey]', '[data-recaptcha-sitekey]', '[data-sitekey]'];\n"
    "    for (const sel of selectors) {\n"
    "        for (const el of document.querySelectorAll(sel)) {\n"
    "            if (el.classList && el.classList.contains('cf-turnstile')) continue;\n"
    "            const k = el.getAttribute('data-sitekey') || el.getAttribute('data-recaptcha-sitekey');\n"
    "            if (k) return k;\n"
    "        }\n"
    "    }\n"
    "    const iframe = [...document.querySelectorAll('iframe')].find((f) => {\n"
    "        const src = f.src || '';\n"
    "        return src.includes('/recaptcha/api2/anchor') || src.includes('google.com/recaptcha') || src.includes('recaptcha.net/recaptcha');\n"
    "    });\n"
    "    if (!iframe) return '';\n"
    "    try { return new URL(iframe.src).searchParams.get('k') || ''; } catch (e) { return ''; }\n"
    "}"
)


def _extract_recaptcha_sitekey(page) -> str:
    """从 PayPal reCAPTCHA widget / iframe URL 中提取 sitekey。

    与 turnstile 同样需要遍历每个 frame，因为 PayPal 把 reCAPTCHA 也常常
    放在 ``recaptcha.net`` / ``google.com/recaptcha`` 跨域 iframe 内。
    """
    try:
        sitekey = page.evaluate(_RECAPTCHA_DOM_SCRIPT)
        if sitekey:
            return str(sitekey).strip()
    except Exception:
        pass
    for frame in _iter_page_frames(page):
        try:
            sitekey = frame.evaluate(_RECAPTCHA_DOM_SCRIPT)
            if sitekey:
                return str(sitekey).strip()
        except Exception:
            pass
    for frame in _iter_page_frames(page):
        sitekey = _recaptcha_sitekey_from_url(str(getattr(frame, "url", "") or ""))
        if sitekey:
            return sitekey
    return ""


# ----------------------------------------------------------------------------
# hCaptcha sitekey extraction
# ----------------------------------------------------------------------------
#
# Sanitized regression capture `@tools/captures/paypal-hcaptcha-example.har`
# (entry 347): ``paypal.com/pay/`` Continue to Payment 后被风控弹的页面是
# **Security Challenge**，里面嵌的是 **hCaptcha**（不是 Turnstile / reCAPTCHA）。
# 关键 DOM：
#
#   <h1>Security Challenge</h1>
#   <form name="challenge" action="/pay/?...&paypal_client_cfci=...&ctxId=...">
#     <iframe src="paypalobjects.com/.../hcaptcha/hcaptcha_fph.html?siteKey=bf07db68-..."
#             name="recaptcha"></iframe>      <!-- 注意 name 是 recaptcha 但内容是 hcaptcha -->
#     <input type="hidden" name="_csrf"      value="..."/>
#     <input type="hidden" name="_requestId" value="..."/>
#     ...
#     <button type="submit" name="continue">Continue</button>
#   </form>
#
# YesCaptcha 解出 hCaptcha token 后，我们在 form 里追加
# ``<input name="g-recaptcha-response" value="<token>">`` 然后 submit form。
# PayPal 的 authchallenge 后端按 ``g-recaptcha-response`` 字段读取 hCaptcha
# token，token + sessionID + _csrf 配套即可放行。
def _hcaptcha_sitekey_from_url(raw_url: str) -> str:
    """从 PayPal hCaptcha wrapper iframe URL 中抠 sitekey。

    匹配 ``hcaptcha_fph.html?siteKey=...`` / ``api.js?siteKey=...`` 等多种
    PayPal hCaptcha 嵌入形式以及 hcaptcha.com 自家的 ``sitekey`` query 参数。
    """
    raw_url = str(raw_url or "")
    if not raw_url:
        return ""
    lowered = raw_url.lower()
    is_hcaptcha = (
        "hcaptcha" in lowered
        or "hcaptcha_fph" in lowered
        or "hcaptcha.paypal" in lowered
    )
    if not is_hcaptcha:
        return ""
    try:
        parsed = urlparse(raw_url)
        query = parse_qs(parsed.query)
        for key in ("siteKey", "sitekey", "k"):
            values = query.get(key) or []
            if values and str(values[0] or "").strip():
                return str(values[0]).strip()
    except Exception:
        pass
    # 兜底：直接正则匹配 ``siteKey=<uuid>``
    match = re.search(r"[?&]siteKey=([0-9a-f-]{8,})", raw_url, re.IGNORECASE)
    if match:
        return match.group(1)
    return ""


_HCAPTCHA_DOM_SCRIPT = (
    "() => {\n"
    "    // 1) hCaptcha 标准属性 (h-captcha / data-hcaptcha-sitekey)\n"
    "    const hcap = document.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-sitekey]');\n"
    "    if (hcap) {\n"
    "        const k = hcap.getAttribute('data-sitekey') || hcap.getAttribute('data-hcaptcha-sitekey');\n"
    "        if (k) return k;\n"
    "    }\n"
    "    // 2) PayPal authchallenge 框架嵌的 iframe（src 含 hcaptcha_fph.html / hcaptcha 关键字）\n"
    "    for (const ifr of document.querySelectorAll('iframe')) {\n"
    "        const src = ifr.src || '';\n"
    "        if (!src) continue;\n"
    "        if (!/hcaptcha/i.test(src)) continue;\n"
    "        try {\n"
    "            const u = new URL(src);\n"
    "            const sk = u.searchParams.get('siteKey') || u.searchParams.get('sitekey') || u.searchParams.get('k');\n"
    "            if (sk) return sk;\n"
    "        } catch (e) {}\n"
    "        const m = src.match(/[?&]siteKey=([0-9a-fA-F-]{8,})/);\n"
    "        if (m) return m[1];\n"
    "    }\n"
    "    return '';\n"
    "}"
)


def _extract_hcaptcha_sitekey(page) -> str:
    """从主 DOM、所有 frame DOM 以及 frame URL 中提取 hCaptcha sitekey。

    PayPal 把 hCaptcha 包在自家 wrapper iframe (``paypalobjects.com/.../
    hcaptcha/hcaptcha_fph.html``) 里——这个 wrapper iframe 的 src 上有
    ``siteKey=...`` query，最稳的方式是直接抠 frame URL；DOM 评估作为兜底。
    """
    try:
        sitekey = page.evaluate(_HCAPTCHA_DOM_SCRIPT)
        if sitekey:
            return str(sitekey).strip()
    except Exception:
        pass
    for frame in _iter_page_frames(page):
        try:
            sitekey = frame.evaluate(_HCAPTCHA_DOM_SCRIPT)
            if sitekey:
                return str(sitekey).strip()
        except Exception:
            pass
    for frame in _iter_page_frames(page):
        sitekey = _hcaptcha_sitekey_from_url(str(getattr(frame, "url", "") or ""))
        if sitekey:
            return sitekey
    return ""


def _inject_hcaptcha_token(page, token: str) -> bool:
    """把求解到的 hCaptcha token 注入 PayPal authchallenge 表单并提交。

    PayPal authchallenge 的 form 长这样::

        <form name="challenge" action="/pay/?..." method="post">
          <iframe src="hcaptcha_fph.html?siteKey=..." name="recaptcha"></iframe>
          <input type="hidden" name="_csrf" .../>
          <input type="hidden" name="_requestId" .../>
          <input type="hidden" name="_hash" .../>
          <input type="hidden" name="_sessionID" .../>
          <button type="submit" name="continue" value="Continue">Continue</button>
        </form>

    后端按 ``g-recaptcha-response`` field 读取 hCaptcha token。我们直接追加
    一个 ``<input type=hidden name=g-recaptcha-response value=TOKEN>`` 然后调
    ``form.submit()`` 提交（也同时填 ``h-captcha-response`` 兼容老分支）。
    """
    safe = str(token or "").replace("\\", "\\\\").replace("'", "\\'")
    script = (
        "(function() {\n"
        "    const token = '" + safe + "';\n"
        "    if (!token) return false;\n"
        "    let form = document.querySelector('form[name=\"challenge\"]')\n"
        "        || document.querySelector('form[action*=\"paypal_client_cfci\"]')\n"
        "        || document.querySelector('form[name=\"authchallenge\"]')\n"
        "        || document.querySelector('form[method=\"post\"]');\n"
        "    if (!form) return false;\n"
        "    const ensureField = (name) => {\n"
        "        let el = form.querySelector('input[name=\"' + name + '\"]');\n"
        "        if (!el) {\n"
        "            el = document.createElement('input');\n"
        "            el.type = 'hidden';\n"
        "            el.name = name;\n"
        "            form.appendChild(el);\n"
        "        }\n"
        "        el.value = token;\n"
        "    };\n"
        "    ensureField('g-recaptcha-response');\n"
        "    ensureField('h-captcha-response');\n"
        "    // 也尝试调全局 hCaptcha API（如果页面注入了），兼容部分需要 callback 的场景\n"
        "    try {\n"
        "        if (window.hcaptcha && typeof window.hcaptcha.execute === 'function') {\n"
        "            // no-op: token 已经塞表单里\n"
        "        }\n"
        "    } catch (e) {}\n"
        "    try { form.submit(); } catch (e) { return false; }\n"
        "    return true;\n"
        "})()"
    )
    try:
        return bool(page.evaluate(script))
    except Exception:
        return False


def _inject_turnstile_token(page, token: str) -> bool:
    """把求解到的 Turnstile token 注入到页面，并尝试触发回调/隐藏字段。"""
    safe = str(token or "").replace("\\", "\\\\").replace("'", "\\'")
    script = (
        "(function() {\n"
        "    const token = '" + safe + "';\n"
        "    try {\n"
        "        if (window.turnstile) {\n"
        "            const orig = window.turnstile;\n"
        "            window.turnstile = new Proxy(orig, {\n"
        "                get(target, prop) {\n"
        "                    if (prop === 'getResponse') return () => token;\n"
        "                    if (prop === 'isExpired') return () => false;\n"
        "                    return Reflect.get(target, prop);\n"
        "                }\n"
        "            });\n"
        "        }\n"
        "    } catch (e) {}\n"
        "    const fns = [\n"
        "        window._turnstileTokenCallback,\n"
        "        window.turnstileCallback,\n"
        "        window.onTurnstileSuccess,\n"
        "        window.cfTurnstileCallback,\n"
        "    ];\n"
        "    fns.forEach((fn) => { if (typeof fn === 'function') { try { fn(token); } catch (e) {} } });\n"
        "    const names = ['cf-turnstile-response', 'g-recaptcha-response', 'captcha', 'turnstile_token'];\n"
        "    const form = document.querySelector('form') || document.body;\n"
        "    names.forEach((name) => {\n"
        "        let f = document.querySelector('input[name=\"' + name + '\"], textarea[name=\"' + name + '\"]');\n"
        "        if (!f) {\n"
        "            f = document.createElement('input');\n"
        "            f.type = 'hidden';\n"
        "            f.name = name;\n"
        "            form.appendChild(f);\n"
        "        }\n"
        "        f.value = token;\n"
        "        try { f.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}\n"
        "        try { f.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}\n"
        "    });\n"
        "    return true;\n"
        "})();"
    )
    try:
        return bool(page.evaluate(script))
    except Exception:
        return False


def _inject_recaptcha_token(page, token: str) -> bool:
    """把求解到的 reCAPTCHA token 注入页面并触发显式 callback。"""
    script = (
        "(function(token) {\n"
        "    const form = document.querySelector('form') || document.body;\n"
        "    const names = ['g-recaptcha-response', 'recaptcha-token'];\n"
        "    names.forEach((name) => {\n"
        "        let f = document.querySelector('textarea[name=\"' + name + '\"], input[name=\"' + name + '\"]');\n"
        "        if (!f) {\n"
        "            f = document.createElement(name === 'g-recaptcha-response' ? 'textarea' : 'input');\n"
        "            f.name = name;\n"
        "            if (f.tagName !== 'TEXTAREA') f.type = 'hidden';\n"
        "            f.style.display = 'none';\n"
        "            form.appendChild(f);\n"
        "        }\n"
        "        f.value = token;\n"
        "        try { f.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}\n"
        "        try { f.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}\n"
        "    });\n"
        "    const clients = (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) || {};\n"
        "    const seen = new Set();\n"
        "    const visit = (obj) => {\n"
        "        if (!obj || typeof obj !== 'object' || seen.has(obj)) return 0;\n"
        "        seen.add(obj);\n"
        "        let count = 0;\n"
        "        for (const key of Object.keys(obj)) {\n"
        "            const value = obj[key];\n"
        "            if (key === 'callback' && typeof value === 'function') {\n"
        "                try { value(token); count += 1; } catch (e) {}\n"
        "            } else if (value && typeof value === 'object') {\n"
        "                count += visit(value);\n"
        "            }\n"
        "        }\n"
        "        return count;\n"
        "    };\n"
        "    visit(clients);\n"
        "    return true;\n"
        "})(arguments[0]);"
    )
    try:
        return bool(page.evaluate(script, str(token or "")))
    except Exception:
        try:
            return bool(page.evaluate(script.replace("arguments[0]", json.dumps(str(token or "")))))
        except Exception:
            return False


def _solve_security_challenge_token(
    solver: Callable[..., str],
    page_url: str,
    site_key: str,
    challenge_type: str,
) -> str:
    if challenge_type == "turnstile":
        return str(solver(page_url, site_key) or "").strip()
    return str(solver(page_url, site_key, challenge_type) or "").strip()


def _is_permanent_captcha_error(exc: BaseException) -> bool:
    """duck-typing 识别 ``providers.captcha.yescaptcha.PermanentCaptchaError``。

    payment.py 不直接 import providers 层（避免逆向依赖），用类名 + ``error_code``
    属性双重判断即可：``YesCaptcha`` 把不可恢复错误（``ERROR_DOMAIN_NOT_ALLOWED``、
    ``ERROR_IP_BLOCKED_*``、``ERROR_ZERO_BALANCE`` 等）封装在 ``PermanentCaptchaError``
    里抛出，这里捕获后让 ``_wait_for_manual_security_challenge`` 立刻停止重试。
    """
    if exc.__class__.__name__ == "PermanentCaptchaError":
        return True
    code = getattr(exc, "error_code", "") or ""
    if not code:
        return False
    code_upper = str(code).strip().upper()
    return (
        code_upper.startswith("ERROR_IP_BLOCKED")
        or code_upper.startswith("ERROR_ACCOUNT_")
        or code_upper in ("ERROR_DOMAIN_NOT_ALLOWED", "ERROR_KEY_DOES_NOT_EXIST", "ERROR_ZERO_BALANCE")
    )


def _try_solve_detected_security_challenge(
    page,
    *,
    solver: Callable[..., str],
    page_url: str,
    site_key: str,
    challenge_type: str,
    label: str,
    inject: Callable[[object, str], bool],
    log: Callable[[str], None],
) -> bool:
    """求解一次 challenge。**永久错误**会原地 raise 出去让上层 fail-fast 不要再重试。"""
    masked_key = site_key if len(site_key) <= 14 else f"{site_key[:10]}...{site_key[-4:]}"
    log(f"调用验证码服务求解 {label} (sitekey={masked_key})")
    try:
        token = _solve_security_challenge_token(solver, page_url, site_key, challenge_type)
    except Exception as exc:
        if _is_permanent_captcha_error(exc):
            # Sanitized PayPal regression: YesCaptcha does not recognize PayPal's
            # ``bf07db68-...`` sitekey，3s 一次的 retry loop 立刻把 IP 干封到
            # ``ERROR_IP_BLOCKED_5MIN``。永久错误必须把异常抛出去停止本轮 auto-solve。
            log(f"验证码服务求解 {label} 永久错误，停止自动重试: {exc}")
            raise
        log(f"验证码服务求解 {label} 失败: {exc}")
        return False
    if not token:
        log(f"验证码服务返回空 {label} token，放弃本次自动求解")
        return False
    log(f"验证码服务返回 {label} token (len={len(token)})，注入到页面")
    if not inject(page, token):
        log(f"{label} token 注入失败")
        return False
    for _ in range(20):
        try:
            page.wait_for_timeout(500)
        except Exception:
            time.sleep(0.5)
        if not _has_security_challenge(page):
            log(f"{label} token 已生效，security challenge 通过")
            return True
    log(f"{label} token 已注入但 challenge 未消失，继续轮询重试")
    return False


def _click_hcaptcha_anchor_checkbox(page, *, log: Callable[[str], None]) -> bool:
    """在 hCaptcha 复选框 iframe 里点 "I am human" 复选框。

    **背景**：YesCaptcha 反复抛 ``ERROR_DOMAIN_NOT_ALLOWED`` 拦不下 PayPal
    家的 hCaptcha sitekey（用户实战日志：``884d15d9-...75eb`` / ``bf07db68-...``
    都被拒识）。继续重试不仅烧配额还会被打 IP-blocked。

    用户诉求：出现 hCaptcha 时**不调任何远端服务**，自己用鼠标点 hCaptcha
    iframe 里的复选框（"I am human"）。简单的"checkbox 类挑战"在干净 IP +
    像人手指纹（BitBrowser profile 持续养号）下能直接通过；触发图片选择
    挑战时点击当然不解决问题，外层 10s 超时会把这一轮失败往上抛。

    实现要点：
      1. hCaptcha 把 anchor checkbox 渲染在 ``hcaptcha.com/captcha/?...`` iframe
         里，复选框 id 是 ``#checkbox`` 或 ``#anchor``（不同 hCaptcha 版本）。
         我们枚举所有 frame，匹配 URL 含 ``hcaptcha`` 并尝试这两个 id。
      2. 也兜底在主 page 直接点 ``.h-captcha`` / ``[data-sitekey]`` 容器（少数
         嵌入方式 anchor 直接挂在主 DOM）。
      3. 任一点击成功立刻 return True；后续是否真的通过由调用方等 10s 检查。
    """
    candidate_selectors = ("#checkbox", "#anchor", "div[role='checkbox']")
    # 1) iframe 内点击：枚举 frame，命中 hcaptcha URL 后尝试每个候选 selector
    for frame in _iter_page_frames(page):
        try:
            frame_url = str(getattr(frame, "url", "") or "").lower()
        except Exception:
            frame_url = ""
        if "hcaptcha" not in frame_url:
            continue
        for selector in candidate_selectors:
            try:
                locator = frame.locator(selector).first
            except Exception:
                continue
            if not _locator_ready(locator):
                continue
            try:
                locator.click(timeout=3000, force=True)
                log(f"已点击 hCaptcha checkbox（frame={frame_url[:80]}, selector={selector}）")
                return True
            except Exception as exc:
                log(f"hCaptcha checkbox 点击 frame={frame_url[:80]} selector={selector} 失败: {exc}")
    # 2) 主 page 兜底：极少数页面 hCaptcha 直接渲染在主 DOM
    for selector in (".h-captcha", "[data-sitekey]"):
        try:
            locator = page.locator(selector).first
        except Exception:
            continue
        if not _locator_ready(locator):
            continue
        try:
            locator.click(timeout=3000, force=True)
            log(f"已点击主 DOM hCaptcha 容器（selector={selector}）")
            return True
        except Exception as exc:
            log(f"主 DOM hCaptcha 容器 selector={selector} 点击失败: {exc}")
    return False


def _try_auto_solve_security_challenge(
    page,
    *,
    solver: Callable[..., str] | None,
    log: Callable[[str], None],
) -> bool:
    """识别 challenge 类型并求解。

    **hCaptcha 永不走 solver**：YesCaptcha 反复 ``ERROR_DOMAIN_NOT_ALLOWED``
    且烧配额，改为"代码点击 anchor checkbox + 由外层 10s 超时判定"路径，
    无论 ``solver`` 是否传入都不调。
    Turnstile / reCAPTCHA 仍走 solver。

    返回 True 表示已尝试过点击 / 求解（可能成功也可能尚未通过——具体由
    调用方下一轮 ``_challenge_still_visible`` 判定）；False 表示本轮没识别
    到任何 challenge 元素。
    """
    page_url = _current_page_url(page) or ""
    # 先检测 hCaptcha：命中即点击复选框，永不调 solver
    hcaptcha_sitekey = _extract_hcaptcha_sitekey(page)
    if hcaptcha_sitekey:
        masked = (
            hcaptcha_sitekey
            if len(hcaptcha_sitekey) <= 14
            else f"{hcaptcha_sitekey[:10]}...{hcaptcha_sitekey[-4:]}"
        )
        log(f"检测到 hCaptcha (sitekey={masked})，自动点击复选框（不调验证码服务）")
        clicked = _click_hcaptcha_anchor_checkbox(page, log=log)
        if not clicked:
            log("hCaptcha 复选框未找到可点击控件；交给外层 10s 超时判定")
        return True
    # Turnstile / reCAPTCHA 仍按原 solver 路径
    if not callable(solver):
        return False
    if not page_url:
        log("security challenge 未取得当前页面 URL，跳过自动求解")
        return False
    turnstile_sitekey = _extract_turnstile_sitekey(page)
    if turnstile_sitekey and _try_solve_detected_security_challenge(
        page,
        solver=solver,
        page_url=page_url,
        site_key=turnstile_sitekey,
        challenge_type="turnstile",
        label="Turnstile",
        inject=_inject_turnstile_token,
        log=log,
    ):
        return True
    recaptcha_sitekey = _extract_recaptcha_sitekey(page)
    if recaptcha_sitekey and _try_solve_detected_security_challenge(
        page,
        solver=solver,
        page_url=page_url,
        site_key=recaptcha_sitekey,
        challenge_type="recaptcha_v2",
        label="reCAPTCHA v2",
        inject=_inject_recaptcha_token,
        log=log,
    ):
        return True
    if not turnstile_sitekey and not recaptcha_sitekey:
        log("security challenge 本轮未识别到 Turnstile/reCAPTCHA sitekey，暂不调用验证码服务")
        # 仅在第一次给出诊断信息：dump 当前所有 frame URL，便于下次定位
        # 究竟 sitekey 藏在哪个跨域子 frame 里。
        if not getattr(page, "_security_challenge_diag_dumped", False):
            try:
                urls = [str(getattr(f, "url", "") or "") for f in _iter_page_frames(page)]
                urls = [u for u in urls if u]
                if urls:
                    log(f"[diag] 当前 frame 数量={len(urls)}，URL 列表(最多 6 条): {urls[:6]}")
            except Exception:
                pass
            try:
                setattr(page, "_security_challenge_diag_dumped", True)
            except Exception:
                pass
    return False


def _wait_short_for_challenge_clear(
    page,
    *,
    cancel_check: Callable[[], bool] | None,
    log: Callable[[str], None],
    label: str,
    challenge_visible: Callable[[], bool] | None = None,
    timeout_seconds: int = 10,
) -> bool:
    """点击 challenge 控件后短轮询等页面跳转。

    用户诉求：出现 captcha 时**不调任何远端验证码服务**——代码自己点击
    后，等 ``timeout_seconds`` 秒，页面 URL 跳走 / challenge DOM 消失即成功，
    超时直接 raise 让外层 fail-fast 这一轮（避免在硬挑战上空转 5 分钟）。

    参数：
        challenge_visible: 自定义"挑战是否仍在"的判定。默认走
            ``_extract_hcaptcha_sitekey + _has_security_challenge_text + URL
            是否还指向 PayPal 风控页`` 的并集，对 hCaptcha 路径足够准确。
    """
    initial_url = _current_page_url(page)

    def _default_visible() -> bool:
        # **仅**根据"挑战 DOM 是否还在"判定。URL 跳走可作为成功信号但不是
        # 必要条件（点击 hCaptcha checkbox 后通常 form 直接 submit、URL 才跳；
        # 但也有 PayPal hosted checkout 走 XHR 提交，URL 不变但 challenge 元素
        # 消失）。两种情况都应视为通过——所以只要挑战元素消失就 return False。
        if _extract_hcaptcha_sitekey(page):
            return True
        if _has_security_challenge_text(page):
            return True
        # URL 跳到其它页面也算通过：原地 URL 但 challenge 元素已消失也算通过
        return False

    visible_fn = challenge_visible or _default_visible
    short_deadline = time.monotonic() + max(int(timeout_seconds), 1)
    while time.monotonic() <= short_deadline:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")
        try:
            page.wait_for_timeout(1000)
        except Exception:
            time.sleep(1)
        if not visible_fn():
            log(f"{label} 已通过（{timeout_seconds}s 内消失/页面跳转）")
            return True
    raise RuntimeError(
        f"{label} {timeout_seconds} 秒内未通过（自动点击 + 等待路径，不调验证码服务）"
    )


def _wait_for_manual_security_challenge(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    cancel_check: Callable[[], bool] | None = None,
    turnstile_solver: Callable[..., str] | None = None,
) -> bool:
    is_paypal_mock = _is_paypal_pay_create_url(_current_page_url(page))
    # paypal_mock 入口判断：text 命中 **或** 能抠出真实 Turnstile/reCAPTCHA sitekey。
    # 单看 frame URL 含 "captcha"/"challenge" 关键字会把 PayPal 自家的 fraud iframe
    # 也误报；要求能提取 sitekey 等于强制确认是真实 captcha 控件，避免空跑求解。
    # 非 paypal_mock 页面走全量 _has_security_challenge（含 iframe）保持原行为。
    if is_paypal_mock:
        if not (
            _has_security_challenge_text(page)
            or _extract_turnstile_sitekey(page)
            or _extract_recaptcha_sitekey(page)
            # PayPal 实战主走 hCaptcha，不认它就会在这里提前 return False
            or _extract_hcaptcha_sitekey(page)
        ):
            return False
    elif not _has_security_challenge(page):
        return False

    def _challenge_still_visible() -> bool:
        if is_paypal_mock:
            return bool(
                _has_security_challenge_text(page)
                or _extract_turnstile_sitekey(page)
                or _extract_recaptcha_sitekey(page)
                or _extract_hcaptcha_sitekey(page)
            )
        return _has_security_challenge(page)

    deadline = time.monotonic() + max(int(timeout_ms or 300000), 1000) / 1000

    # ---- 路径 A：检测到 hCaptcha，永不调 solver ----
    # 用户诉求：YesCaptcha 拒识 PayPal 家的 hCaptcha sitekey
    # （ERROR_DOMAIN_NOT_ALLOWED）。改为代码自己点 hCaptcha checkbox + 10s 等
    # 页面跳转，10s 没跳转 → fail。
    if _extract_hcaptcha_sitekey(page):
        log("检测到 hCaptcha，跳过验证码服务，自动点击 checkbox 并等 10s")
        try:
            _click_hcaptcha_anchor_checkbox(page, log=log)
        except Exception as exc:
            log(f"点击 hCaptcha checkbox 异常（继续 10s 等待）: {exc}")
        return _wait_short_for_challenge_clear(
            page,
            cancel_check=cancel_check,
            log=log,
            label="hCaptcha",
        )

    # ---- 路径 B：配了 solver，走 Turnstile/reCAPTCHA 求解循环 ----
    auto_solver_disabled = False
    if callable(turnstile_solver):
        log("检测到 security challenge，已启用验证码服务，等待 sitekey 并自动求解")
        while time.monotonic() <= deadline:
            if callable(cancel_check) and cancel_check():
                raise RuntimeError("任务已取消")
            if not _challenge_still_visible():
                log("security challenge 已通过，继续 CTF sandbox 流程")
                return True
            # 求解循环中途页面可能升级到 hCaptcha（少数实战 case），主动转
            # 走"点击 + 10s"路径，避免空跑 solver。
            if _extract_hcaptcha_sitekey(page):
                log("循环中检测到 hCaptcha，转为自动点击 checkbox + 10s 等")
                try:
                    _click_hcaptcha_anchor_checkbox(page, log=log)
                except Exception as exc:
                    log(f"点击 hCaptcha checkbox 异常（继续 10s 等待）: {exc}")
                return _wait_short_for_challenge_clear(
                    page,
                    cancel_check=cancel_check,
                    log=log,
                    label="hCaptcha",
                )
            try:
                if _try_auto_solve_security_challenge(
                    page, solver=turnstile_solver, log=log
                ):
                    return True
            except Exception as exc:
                if _is_permanent_captcha_error(exc):
                    # YesCaptcha 永久错误：停 solver，降级到"点击 + 10s"，
                    # 避免烧配额和 IP-blocked。
                    log(
                        "验证码服务永久不可用，停止自动求解；改走自动点击 + 10s 等"
                        f"。原始错误: {exc}"
                    )
                    auto_solver_disabled = True
                    break
                log(f"自动求解抛出非永久错误，按 3s 节流继续重试: {exc}")
            try:
                page.wait_for_timeout(3000)
            except Exception:
                time.sleep(3)
        if not auto_solver_disabled:
            raise RuntimeError(
                "security challenge 自动求解超时：未识别到 Turnstile/reCAPTCHA sitekey 或 token 未生效"
            )

    # ---- 路径 C：未配 solver / solver 永久禁用 → 自动点击 + 10s 等 ----
    log("检测到 security challenge，未启用 captcha solver；尝试自己点击控件并等 10s")
    try:
        if _click_security_challenge_control(page, label="security challenge"):
            log("已自动点击 security challenge 控件，等待页面 10s 内进展")
    except Exception as exc:
        log(f"自动点击 security challenge 控件失败（继续 10s 静等）: {exc}")
    return _wait_short_for_challenge_clear(
        page,
        cancel_check=cancel_check,
        log=log,
        label="security challenge",
        challenge_visible=_challenge_still_visible,
    )


def _wait_for_ctf_after_continue_ready(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    cancel_check: Callable[[], bool] | None = None,
    turnstile_solver: Callable[..., str] | None = None,
) -> None:
    log("等待 Continue to Payment 后进入 security challenge 或 CTF 创建页")
    deadline = time.monotonic() + max(int(timeout_ms or 300000), 1000) / 1000
    while time.monotonic() <= deadline:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")
        current_url = _current_page_url(page)
        # 代理断流：加载失败页先尝试重新加载恢复，再继续判定
        if _is_page_load_error_url(current_url):
            _recover_page_load_if_errored(
                page, timeout_ms=timeout_ms, log=log, cancel_check=cancel_check
            )
            continue
        if _is_paypal_intermediate_url(current_url):
            _advance_paypal_intermediate_pages(page, timeout_ms=timeout_ms, log=log)
            continue
        if _follow_paypal_onboarding_redirect_response(page, timeout_ms=timeout_ms, log=log):
            continue
        if _has_security_challenge(page):
            _wait_for_manual_security_challenge(
                page,
                timeout_ms=300000,
                log=log,
                cancel_check=cancel_check,
                turnstile_solver=turnstile_solver,
            )
            continue
        if _ctf_after_continue_ready(page):
            log("CTF 创建页付款表单已出现")
            return
        try:
            page.wait_for_timeout(1000)
        except Exception:
            time.sleep(1)
    raise RuntimeError("Continue to Payment 后未进入 security challenge 或 CTF 创建页")


def _fill_ctf_signup_email(page, identity: dict) -> None:
    email = identity["email"]
    if not _fill_checkout_field(
        page,
        email,
        selectors=(
            "#login_email",
            'input[name="login_email"]',
            'input[type="email"]',
            'input[name="email"]',
            'input[autocomplete="username"]',
            'input[autocomplete="email"]',
            '#email',
        ),
        labels=(re.compile(r"email|邮箱|メール|メールアドレス", re.I),),
    ):
        raise RuntimeError("未找到 CTF 测试邮箱输入框")
    if not _ctf_signup_email_matches(page, email):
        raise RuntimeError("CTF 测试邮箱输入框未正确填写")


def _ctf_signup_email_locator(page):
    locators = []
    for selector in (
        "#login_email",
        'input[name="login_email"]',
        'input[type="email"]',
        'input[name="email"]',
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
        '#email',
    ):
        try:
            locators.append(page.locator(selector).first)
        except Exception:
            pass
    try:
        locators.append(page.get_by_label(re.compile(r"email|邮箱|メール|メールアドレス", re.I)).first)
    except Exception:
        pass
    for locator in locators:
        if _locator_ready(locator):
            return locator
    return None


def _locator_input_value(locator) -> str:
    try:
        return str(locator.input_value(timeout=1000) or "")
    except Exception:
        pass
    try:
        return str(locator.evaluate("(el) => el.value || el.getAttribute('value') || ''") or "")
    except Exception:
        return ""


def _ctf_signup_email_matches(page, email: str) -> bool:
    locator = _ctf_signup_email_locator(page)
    if locator is None:
        return False
    return _locator_input_value(locator).strip().lower() == str(email or "").strip().lower()


def _click_ctf_create_account(page) -> None:
    _click_by_candidates(
        page,
        label="create an account",
        selectors=(
            'a[href*="create" i]',
            'button[data-testid*="create" i]',
            'button:has-text("Create an account")',
            'a:has-text("Create an account")',
            'button:has-text("アカウントを作成")',
            'a:has-text("アカウントを作成")',
            'button:has-text("新規登録")',
            'a:has-text("新規登録")',
        ),
        patterns=(re.compile(
            r"create an account|create account|创建账户|创建账号|"
            r"アカウントを作成|アカウント作成|新規登録|登録する",
            re.I,
        ),),
        roles=("button", "link"),
    )


def _click_ctf_continue_to_payment(page) -> None:
    _click_by_candidates(
        page,
        label="Continue to Payment",
        selectors=(
            'button[data-testid="continueButton"]',
            'button[data-atomic-wait-intent="Continue_To_Payment"]',
            'button:has-text("Continue to Payment")',
            'button:has-text("お支払いに進む")',
            'button:has-text("支払いへ進む")',
            'button:has-text("お支払い手続き")',
            'button[type="submit"]',
            'input[type="submit"]',
        ),
        patterns=(re.compile(
            r"continue to payment|continue|payment|继续|付款|支付|"
            r"お支払いに進む|支払いへ進む|お支払い手続き|次へ|続ける",
            re.I,
        ),),
    )


def _select_ctf_state_field(page, identity: dict | None = None, *, log: Callable[[str], None] | None = None) -> bool:
    log_fn = log or (lambda _msg: None)
    ident = identity if isinstance(identity, dict) else {}
    region = str(ident.get("region") or "").strip().upper()
    # JP 区辖区是都道府县（option value=汉字），必须使用任务/部署配置，
    # 不再回退到仓库内置州信息。
    state_value = str(ident.get("state") or CTF_STATE).strip()
    state_name = str(
        ident.get("state_name") or CTF_STATE_NAME or state_value
    ).strip()
    if not state_value:
        log_fn("  · state 未配置")
        return False
    # 候选词：原文 + 全名 + JP 别名（``"Tokyo"`` → ``["Tokyo","東京都","東京",...]``）。
    candidates: list[str] = []
    seen: set[str] = set()
    for base in (state_value, state_name):
        for cand in _jp_prefecture_candidates(base):
            if cand and cand not in seen:
                candidates.append(cand)
                seen.add(cand)
    if not candidates:
        candidates = [state_value]
    log_fn(f"  · state 输入={state_value!r} region={region or '?'} 展开候选={candidates}")

    # 1) 常规 select（可见原生 select / 走 _select_option_smart 别名匹配）
    if _fill_checkout_field(
        page,
        state_value,
        selectors=(
            '#billingAdministrativeArea',
            'select[name="billingAdministrativeArea"]',
            'select[name*="state" i]',
            'select[name*="region" i]',
            'select[autocomplete="address-level1"]',
            'select[autocomplete="billing address-level1"]',
            'select[aria-label*="state" i]',
            'select[aria-label*="辖区"]',
            'select[aria-label*="都道府県"]',
        ),
        labels=(re.compile(r"state|province|region|辖区|州|省|都道府県|県|府", re.I),),
        select=True,
    ):
        log_fn("  · 辖区 via 常规 select ✓")
        return True

    # 2) 隐藏的 Stripe 原生 select（``.Select-source``，CSS 藏起来）：
    #    Playwright select_option 等不到可见 → 直接 JS 强制设值 + 派发事件。
    for sel in (
        '#billingAdministrativeArea',
        'select[name="billingAdministrativeArea"]',
        'select[autocomplete="billing address-level1"]',
        'select.Select-source[name*="state" i]',
        'select[name*="state" i]',
        'select[name*="region" i]',
    ):
        try:
            locator = page.locator(sel).first
            if locator.count() <= 0:
                continue
        except Exception:
            continue
        if _force_select_native_option(locator, candidates, log=log_fn, field_label="辖区"):
            log_fn("  · 辖区 via JS 强制设值 ✓")
            return True

    # 3) 文本输入框形态
    if _fill_checkout_field(
        page,
        state_value,
        selectors=(
            'input[name*="state" i]',
            'input[name*="region" i]',
            'input[autocomplete="address-level1"]',
            'input[autocomplete="billing address-level1"]',
            'input[placeholder*="State" i]',
            'input[placeholder*="辖区"]',
        ),
        labels=(re.compile(r"state|province|region|辖区|州|省|都道府県|県|府", re.I),),
    ):
        log_fn("  · 辖区 via input ✓")
        return True

    # 4) 自定义 combobox（button + listbox）
    locators = []
    for factory in (
        lambda: page.locator('[role="combobox"][aria-label*="state" i]').first,
        lambda: page.locator('[role="combobox"][aria-label*="辖区"]').first,
        lambda: page.locator('[role="button"][aria-label*="state" i]').first,
        lambda: page.locator('[role="combobox"][aria-label*="都道府県"]').first,
        lambda: page.locator('[role="button"][aria-label*="都道府県"]').first,
        lambda: page.locator('button:has-text("State")').first,
        lambda: page.locator('button:has-text("都道府県")').first,
        lambda: page.get_by_role("combobox", name=re.compile(r"state|province|region|辖区|都道府県|県|府", re.I)).first,
        lambda: page.get_by_label(re.compile(r"state|province|region|辖区|都道府県|県|府", re.I)).first,
    ):
        try:
            locators.append(factory())
        except Exception:
            pass
    for locator in locators:
        if not _locator_ready(locator):
            continue
        try:
            _click_or_check(locator)
            try:
                page.wait_for_timeout(300)
            except Exception:
                time.sleep(0.3)
            option_selectors = []
            for cand in candidates:
                option_selectors.append(f'[role="option"]:has-text("{cand}")')
                option_selectors.append(f'li:has-text("{cand}")')
            if _click_by_candidates(
                page,
                label="State option",
                selectors=tuple(option_selectors) or (
                    f'[role="option"]:has-text("{state_value}")',
                ),
                patterns=(re.compile("|".join(re.escape(c) for c in candidates), re.I),),
                roles=("option", "button", "link"),
            ):
                log_fn("  · 辖区 via combobox ✓")
                return True
        except Exception:
            pass
    log_fn("  · 辖区所有策略均未命中 ✗")
    return False


def _open_ctf_create_account_and_continue(
    page,
    identity: dict,
    *,
    log: Callable[[str], None],
    cancel_check: Callable[[], bool] | None = None,
    turnstile_solver: Callable[..., str] | None = None,
) -> None:
    def _raise_if_cancelled() -> None:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")

    def _solve_challenge_if_present() -> bool:
        """如当前页面已出现 **真** security challenge，主动调用配置的 captcha
        solver 求解。

        使用 `_has_real_security_challenge` 收紧 paypal_mock 页面下的判定，
        避免被 PayPal 自家 fraud iframe 的 URL 关键字（``challenge``/
        ``captcha`` 等）误报，进而空跑 captcha solver、把 create-account
        阶段拖到 3 次失败超时。

        返回 True 表示已求解（或 challenge 不存在），可继续后续点击；False 表示
        challenge 仍在但未配置 solver，调用方应交给后续步骤处理或抛错。
        """
        if not _has_real_security_challenge(page):
            return True
        if not callable(turnstile_solver):
            log("检测到 security challenge 但未配置 captcha solver，交给后续步骤处理")
            return False
        try:
            return _wait_for_manual_security_challenge(
                page,
                timeout_ms=300000,
                log=log,
                cancel_check=cancel_check,
                turnstile_solver=turnstile_solver,
            )
        except Exception as exc:
            log(f"Create-account 阶段 captcha 求解失败: {exc}")
            return False

    def _wait_for_signup_form_after_create_click() -> bool:
        try:
            page.wait_for_timeout(3000)
        except Exception:
            time.sleep(3)
        for index in range(11):
            _raise_if_cancelled()
            if _ctf_signup_form_ready(page):
                return True
            if index >= 10:
                break
            try:
                page.wait_for_timeout(500)
            except Exception:
                time.sleep(0.5)
        return False

    def _fill_signup_and_continue() -> None:
        log("填写 CTF 测试邮箱")
        _fill_ctf_signup_email(page, identity)
        log("点击 Continue to Payment")
        _click_ctf_continue_to_payment(page)

    # **GuJumpgate 兼容**：进入循环前先扫一遍 captcha DOM stripper，让 5min
    # MutationObserver 守住整个 create-account 阶段——PayPal 软 captcha 浮层
    # 一冒出来立刻删，规避按钮被 overlay 拦截。
    #
    # 注意：``_arm_paypal_captcha_stripper_on_navigations`` 已在 page 创建时装
    # 好 init_script，理论上 navigate 时自动跑。这里额外 install 一次是为了
    # 处理**当前已加载的页面**——arm 不影响已存在的页面（init_script 只在新
    # navigate 时跑）。
    _install_paypal_captcha_dom_stripper(page, log=log)
    for attempt in range(1, 4):
        _raise_if_cancelled()
        # **直达统一 guest 表单**：从 signin 直达 ``/checkoutweb/signup`` 时，
        # PayPal 有时直接渲染"国/地域 + メール + 電話 + カード番号"同页的统一
        # 表单（没有 Create-account → 邮箱 → Continue to Payment 两步）。此时
        # 卡号框已在，无需再找创建账户/Continue，直接返回让调用方填表。
        # 放在循环最前、captcha 求解之前——避免对着一个本就该填的表单空等。
        if _ctf_card_field_ready(page):
            log("检测到统一 guest 付款表单（卡号框已就绪），跳过创建账户/Continue 步骤，直接填表")
            return
        # 入口先**主动**求解 security challenge（如有 captcha 必先过这关）
        # 否则点击 Create an account 时按钮会被 captcha iframe / AtomicWait 锁死
        #
        # **重要决策**：GuJumpgate 不跳过 Create-an-account（README 明示流程是
        # "自动填写 PayPal 账单并完成流程"，含创建账户），所以我们也不跳。
        # 之前尝试 ``_try_click_paypal_pay_with_card_or_guest`` guest 直通是
        # **误读** GuJumpgate 策略——ChatGPT Plus 用 BA token（订阅）PayPal
        # 不提供 guest checkout，那条路径在订阅场景永远 False。函数保留供
        # 单测 + 未来一次性付款场景复用，**不在订阅 checkout 流程调用**。
        _solve_challenge_if_present()
        is_paypal_mock = _is_paypal_pay_create_url(_current_page_url(page))
        create_ready = _ctf_create_account_ready(page)
        if is_paypal_mock and create_ready:
            # 点 Create-an-account 前再 strip 一次，防 PayPal 在最后一秒注入 overlay
            _install_paypal_captcha_dom_stripper(page, log=log)
            log(f"准备点击 create an account 第 {attempt}/3 次")
            try:
                _click_ctf_create_account(page)
                log("已点击 create an account，等待邮箱表单")
            except Exception as exc:
                log(f"create an account 第 {attempt}/3 次未点击成功，检查邮箱表单: {exc}")
            # 点击后再 strip 一次：Create-account 跳转后 PayPal 经常立刻挂 captcha
            _install_paypal_captcha_dom_stripper(page, log=log)
            if _wait_for_signup_form_after_create_click():
                _fill_signup_and_continue()
                return
            continue
        if _ctf_signup_form_ready(page):
            _fill_signup_and_continue()
            return
        if not is_paypal_mock and (_ctf_payment_form_ready(page) or _ctf_verification_popup_visible(page)):
            log("检测到 CTF 已进入 security challenge/付款下一步，跳过 create an account")
            return
        # 使用 _has_real_security_challenge 收紧 paypal_mock 下的判定：仅当
        # 文本命中或真 sitekey 存在时才喊"检测到 security challenge"。否则
        # 误报会把 create-account 阶段拖到 3 次失败超时（症状：连续两条
        # "检测到 security challenge，主动调用 captcha solver 求解" 后流程
        # 直接报"点击 create an account 3 次后仍未出现 ... 邮箱输入框"）。
        if _has_real_security_challenge(page) and not create_ready:
            log("检测到 security challenge，主动调用 captcha solver 求解")
            _solve_challenge_if_present()
            # 求解后回到 for 头部，下一轮会重新评估 create_ready / signup_form 状态
            continue
        log(f"准备点击 create an account 第 {attempt}/3 次")
        try:
            _click_ctf_create_account(page)
            log("已点击 create an account，等待邮箱表单")
        except Exception as exc:
            log(f"create an account 第 {attempt}/3 次未点击成功，检查邮箱表单: {exc}")
        if _wait_for_signup_form_after_create_click():
            _fill_signup_and_continue()
            return
    raise RuntimeError("点击 create an account 3 次后仍未出现 Continue to Payment 和邮箱输入框")


# ISO2 → 电话区号选择器的候选匹配文案。PayPal / Stripe 的电话国家下拉
# option 形态各异（``+81`` / ``Japan`` / ``JP`` / ``Japan (+81)`` / ``日本``），
# 这里给每个国家列一组候选，命中任一即可。
_PHONE_COUNTRY_OPTION_CANDIDATES: dict[str, tuple[str, ...]] = {
    "US": ("+1", "United States", "US", "USA", "美国", "アメリカ", "United States (+1)"),
    "JP": ("+81", "Japan", "JP", "日本", "Japan (+81)", "日本 (+81)"),
    "GB": ("+44", "United Kingdom", "GB", "UK", "英国", "イギリス"),
    "AU": ("+61", "Australia", "AU", "澳大利亚", "オーストラリア"),
    "CN": ("+86", "China", "CN", "中国", "中国 (+86)"),
    "SG": ("+65", "Singapore", "SG", "新加坡", "シンガポール"),
    "HK": ("+852", "Hong Kong", "HK", "香港", "香港 (+852)"),
    "DE": ("+49", "Germany", "DE", "德国", "ドイツ"),
    "FR": ("+33", "France", "FR", "法国", "フランス"),
    "IN": ("+91", "India", "IN", "印度", "インド"),
}


def _select_ctf_phone_country(page, phone_e164: str, *, log: Callable[[str], None] | None = None) -> bool:
    """按号码实际国家码设置电话框旁的区号选择器。

    **为什么需要**：PayPal hosted guest 表单的电话框自带国家区号选择器，
    默认值跟随页面 locale（日本 IP / JP 区 → 默认 ``+81``）。如果号码是
    美国 ``+1`` 而选择器停在 ``+81``，提交后 PayPal 判号码非法，弹出
    「別の電話番号をお試しください」(请换电话号码) —— 这正是 JP 区填 US
    号 / US 区填 JP 号时 100% 复现的拒号根因。

    实现：从 ``phone_e164`` 解析国家码 → ISO2 → 候选文案，依次尝试
      1. 原生 ``<select>``（按 value / label / 候选文案模糊匹配）
      2. 自定义 combobox（button + listbox，点开后挑 option）
    best-effort：找不到选择器（号码与页面 locale 本就一致、或表单没有独立
    区号选择器）直接返回 False，不抛错、不影响主填表流程。
    """
    log_fn = log or (lambda _msg: None)
    e164 = str(phone_e164 or "").strip()
    if not e164:
        return False
    try:
        from .payment_protocol import _calling_code_from_e164
    except Exception:
        return False
    calling_code, iso2, _local = _calling_code_from_e164(e164)
    if not iso2:
        return False
    candidates = _PHONE_COUNTRY_OPTION_CANDIDATES.get(iso2, ())
    if not candidates:
        candidates = (f"+{calling_code}",) if calling_code else ()
    if not candidates:
        return False

    # 1) 原生 <select> 区号下拉
    select_selectors = (
        'select[name*="phoneCountry" i]',
        'select[name*="phone_country" i]',
        'select[name*="countryCode" i]',
        'select[name*="country_code" i]',
        'select[name*="dialCode" i]',
        'select[id*="phoneCountry" i]',
        'select[id*="countryCode" i]',
        'select[aria-label*="country code" i]',
        'select[aria-label*="国番号"]',
        'select[aria-label*="国コード"]',
    )
    for sel in select_selectors:
        try:
            locator = page.locator(sel).first
        except Exception:
            continue
        if not _locator_ready(locator):
            continue
        for candidate in candidates:
            if _select_option_smart(locator, candidate, timeout_ms=1500):
                log_fn(f"  · 电话区号选择器已设为 {iso2}(+{calling_code}) via <select>={candidate!r}")
                return True

    # 2) 自定义 combobox（button + listbox）
    combo_selectors = (
        'button[aria-label*="country code" i]',
        'button[aria-label*="dialing" i]',
        'button[aria-label*="国番号"]',
        'button[aria-label*="国コード"]',
        'button[data-testid*="phoneCountry" i]',
        'button[data-testid*="countryCode" i]',
        'button[id*="phoneCountry" i]',
        'button[id*="countryCode" i]',
        '[role="combobox"][aria-label*="country code" i]',
        '[role="combobox"][aria-label*="国番号"]',
    )
    for sel in combo_selectors:
        try:
            widget = page.locator(sel).first
        except Exception:
            continue
        if not _locator_ready(widget):
            continue
        try:
            _click_or_check(widget)
        except Exception:
            continue
        try:
            page.wait_for_timeout(300)
        except Exception:
            time.sleep(0.3)
        for candidate in candidates:
            cand = candidate.strip()
            if not cand:
                continue
            for opt_sel in (
                f'[role="option"]:has-text("{cand}")',
                f'[role="menuitem"]:has-text("{cand}")',
                f'li:has-text("{cand}")',
            ):
                try:
                    opt = page.locator(opt_sel).first
                except Exception:
                    continue
                if not _locator_ready(opt):
                    continue
                try:
                    _click_or_check(opt)
                    log_fn(f"  · 电话区号选择器已设为 {iso2}(+{calling_code}) via combobox={cand!r}")
                    return True
                except Exception:
                    continue
        # 没挑到 option，关掉下拉避免遮挡后续字段
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass
    return False


def _wait_and_type_dob_by_id(
    page, element_id: str, value: str, *,
    log=None, attempts: int = 12, interval_ms: int = 500,
) -> bool:
    """专治 PayPal hosted ``#dateOfBirth`` 的 mask 输入框。

    这个字段是 ``type=tel`` + 输入掩码（react-imask 之类）的受控组件，模板
    是 ``MM/DD/YYYY``。当前 PayPal mask 对逐键输入不稳定：纯数字可能变成
    ``0615/1/9``，逐键输入带斜杠又可能变成 ``11/2/4``。

    GuJumpgate 的做法是先走 React-compatible native setter + ``input/change``
    事件；这里也优先按这个方式直写并验证，失败时再用 ``keyboard.insert_text``
    一次性插入，最后才退回逐键 ``type``。
    """
    eid = str(element_id or "").strip()
    if not eid:
        return False
    val = str(value or "")
    if not val:
        return True
    dob_value = _normalize_paypal_dob_value(val)
    if not dob_value:
        digits = re.sub(r"\D", "", val)
        if callable(log):
            log(f"  · #{eid} DOB 格式无效，回退到 JS 设值")
        return _wait_and_force_fill_by_id(page, eid, val, log=log, attempts=attempts, interval_ms=interval_ms)
    check_script = """
    (id) => {
      const el = document.getElementById(id);
      if (!el) return '__noel__';
      return String(el.value == null ? '' : el.value);
    }
    """

    def _focus_and_clear_dob() -> None:
        try:
            loc = page.locator(f"#{eid}").first
            loc.click()
        except Exception:
            try:
                page.evaluate("(id) => document.getElementById(id) && document.getElementById(id).focus()", eid)
            except Exception:
                pass
        try:
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
        except Exception:
            pass

    candidates = _paypal_dob_input_candidates(dob_value)
    for i in range(max(int(attempts), 1)):
        try:
            cur = page.evaluate(check_script, eid)
        except Exception:
            cur = "__noel__"
        if cur == "__noel__":
            try:
                page.wait_for_timeout(int(interval_ms))
            except Exception:
                time.sleep(interval_ms / 1000)
            continue
        if _paypal_dob_value_matches(cur, dob_value):
            return True

        for candidate in candidates:
            after = _force_fill_dob_input_by_id(page, eid, candidate, log=log)
            if _paypal_dob_value_matches(after, dob_value):
                if callable(log):
                    log(f"  · #{eid} 已 JS 设值 DOB ✓")
                return True
            if after not in (None, "", "__noel__") and callable(log):
                log(f"  · #{eid} DOB JS 设值未通过校验，继续尝试")

        # 元素已在：聚焦 → 全选清空 → 一次性插入。insert_text 比逐键 type
        # 更不容易被 masked input 把斜杠当成用户按键后重排。
        for candidate in candidates:
            _focus_and_clear_dob()
            try:
                page.keyboard.insert_text(candidate)
            except Exception:
                continue
            try:
                page.keyboard.press("Tab")
            except Exception:
                pass
            try:
                after = page.evaluate(check_script, eid)
            except Exception:
                after = ""
            if _paypal_dob_value_matches(after, dob_value):
                if callable(log):
                    log(f"  · #{eid} 已插入 DOB ✓")
                return True
        for candidate in candidates:
            _focus_and_clear_dob()
            try:
                # 最后的兼容 fallback：逐键输入候选格式。
                page.keyboard.type(candidate, delay=40)
            except Exception:
                try:
                    loc = page.locator(f"#{eid}").first
                    loc.type(candidate, delay=40)
                except Exception:
                    pass
            try:
                page.keyboard.press("Tab")
            except Exception:
                pass
            try:
                after = page.evaluate(check_script, eid)
            except Exception:
                after = ""
            if _paypal_dob_value_matches(after, dob_value):
                if callable(log):
                    log(f"  · #{eid} 已键入 DOB ✓")
                return True
        after = _lock_dob_input_value_by_id(page, eid, dob_value, log=log)
        if _paypal_dob_value_matches(after, dob_value):
            if callable(log):
                log(f"  · #{eid} 已锁定 DOB ✓")
            return True
        if callable(log):
            log(f"  · #{eid} 键入 DOB 后未通过校验，重试")
        try:
            page.wait_for_timeout(int(interval_ms))
        except Exception:
            time.sleep(interval_ms / 1000)
    if callable(log):
        log(f"  · #{eid} 多次重试仍未填上 DOB")
    return False


def _is_complete_paypal_dob_value(value: object) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(r"(?:\d{2}/\d{2}/\d{4}|\d{4}/\d{2}/\d{2})", value or "") is not None
    )


def _paypal_dob_input_candidates(dob_value: str) -> list[str]:
    normalized = _normalize_paypal_dob_value(dob_value)
    if not normalized:
        return [str(dob_value or "")]
    first, second, third = normalized.split("/")
    if len(first) == 4:
        year, month, day = first, second, third
        no_padding = f"{year}/{int(month)}/{int(day)}"
    else:
        month, day, year = first, second, third
        no_padding = f"{int(month)}/{int(day)}/{year}"
    return list(
        dict.fromkeys(
            [
                normalized,
                re.sub(r"\D", "", normalized),
                no_padding,
            ]
        )
    )


def _paypal_dob_value_matches(actual: object, expected: str) -> bool:
    normalized_actual = _normalize_paypal_dob_value(str(actual or ""))
    normalized_expected = _normalize_paypal_dob_value(expected)
    return bool(normalized_actual and normalized_expected and normalized_actual == normalized_expected)


def _force_fill_dob_input_by_id(page, element_id: str, value: str, *, log=None) -> str:
    """GuJumpgate-style DOB fill: native input value setter + input/change events."""
    eid = str(element_id or "").strip()
    dob_value = str(value or "").strip()
    if not eid or not dob_value:
        return ""
    script = """
    (args) => {
      const { id, value } = args;
      const el = document.getElementById(id);
      if (!el) return 'no_element';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled';
      const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')
        && Object.getOwnPropertyDescriptor(proto, 'value').set;
      try { el.focus(); } catch (e) {}
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok:' + String(el.value || '');
    }
    """
    try:
        result = page.evaluate(script, {"id": eid, "value": dob_value})
    except Exception as exc:
        if callable(log):
            log(f"  · #{eid} DOB JS 设值异常: {exc}")
        return ""
    if isinstance(result, str) and result.startswith("ok:"):
        return result[3:]
    return str(result or "")


def _lock_dob_input_value_by_id(page, element_id: str, value: str, *, log=None) -> str:
    """Last-resort DOB fill: keep PayPal's mask from rewriting YYYY into YY."""
    eid = str(element_id or "").strip()
    dob_value = str(value or "").strip()
    if not eid or not dob_value:
        return ""
    script = """
    (args) => {
      const { id, value } = args;
      const el = document.getElementById(id);
      if (!el) return 'no_element';
      const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      const nativeGet = desc && desc.get;
      const nativeSet = desc && desc.set;
      if (!nativeSet) return 'no_setter';
      const expectedDigits = String(value || '').replace(/\\D/g, '');
      const getValue = () => String(nativeGet ? nativeGet.call(el) : el.value || '');
      const setNative = (next) => {
        nativeSet.call(el, String(next || ''));
        try { el.setAttribute('value', String(next || '')); } catch (e) {}
      };
      if (!el.__ctfDobValueLock) {
        Object.defineProperty(el, 'value', {
          configurable: true,
          get() {
            return getValue();
          },
          set(next) {
            const text = String(next == null ? '' : next);
            const digits = text.replace(/\\D/g, '');
            if (expectedDigits && digits && digits.length < expectedDigits.length) {
              setNative(value);
              return;
            }
            setNative(text);
          },
        });
        el.__ctfDobValueLock = true;
      }
      try { el.focus(); } catch (e) {}
      try { if (el._valueTracker) el._valueTracker.setValue(''); } catch (e) {}
      setNative(value);
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      setNative(value);
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      setNative(value);
      for (const delay of [0, 50, 150, 400, 900]) {
        setTimeout(() => {
          try { setNative(value); } catch (e) {}
        }, delay);
      }
      return 'ok:' + getValue();
    }
    """
    try:
        result = page.evaluate(script, {"id": eid, "value": dob_value})
    except Exception as exc:
        if callable(log):
            log(f"  · #{eid} DOB value lock 异常: {exc}")
        return ""
    if isinstance(result, str) and result.startswith("ok:"):
        return result[3:]
    return str(result or "")


def _normalize_paypal_dob_value(value: str) -> str:
    """把常见 DOB 输入规范成 PayPal hosted 接受的 ``MM/DD/YYYY``。"""
    raw = str(value or "").strip()
    if not raw:
        return ""
    parts = re.findall(r"\d+", raw)
    year = month = day = ""
    year_first = False
    if len(parts) >= 3:
        first, second, third = parts[:3]
        if len(first) == 4:
            year_first = True
            year, month, day = first, second, third
        else:
            month, day, year = first, second, third
    else:
        digits = re.sub(r"\D", "", raw)
        if len(digits) != 8:
            return ""
        possible_year = int(digits[:4])
        possible_month = int(digits[4:6])
        possible_day = int(digits[6:8])
        if 1900 <= possible_year <= 2099 and 1 <= possible_month <= 12 and 1 <= possible_day <= 31:
            year_first = True
            year, month, day = digits[:4], digits[4:6], digits[6:8]
        else:
            month, day, year = digits[:2], digits[2:4], digits[4:8]
    try:
        year_int = int(year)
        month_int = int(month)
        day_int = int(day)
    except Exception:
        return ""
    if not (1900 <= year_int <= 2099 and 1 <= month_int <= 12 and 1 <= day_int <= 31):
        return ""
    if year_first:
        return f"{year_int:04d}/{month_int:02d}/{day_int:02d}"
    return f"{month_int:02d}/{day_int:02d}/{year_int:04d}"


def _wait_and_force_fill_by_id(
    page, element_id: str, value: str, *,
    log=None, attempts: int = 12, interval_ms: int = 500,
) -> bool:
    """轮询等 ``#id`` 出现 → JS 设值 → 校验值写进去了。没写进就重试。

    专治 PayPal 统一 guest 表单里 ``forced-with-password-flow`` 段（密码/生年
    月日/漢字+片假名姓名）的**懒加载/异步渲染**：这一段在主字段之后才挂到
    DOM（password 框带 ``data-testid="lazy-password-input"``）。一次性填会因为
    元素还不存在而漏填，提交时报"入力必須項目です"。

    空 value 直接跳过（视为成功，避免无意义重试）。
    """
    eid = str(element_id or "").strip()
    if not eid:
        return False
    val = str(value or "")
    if not val:
        return True
    check_script = """
    (id) => {
      const el = document.getElementById(id);
      if (!el) return '__noel__';
      return String(el.value == null ? '' : el.value);
    }
    """
    for i in range(max(int(attempts), 1)):
        try:
            cur = page.evaluate(check_script, eid)
        except Exception:
            cur = "__noel__"
        if cur != "__noel__":
            # 元素已在：值已正确则成功；否则 JS 设值
            if str(cur) == val:
                return True
            if _force_fill_input_by_id(page, eid, val, log=log):
                # 设完再校验一次（React 可能异步清值）
                try:
                    after = page.evaluate(check_script, eid)
                except Exception:
                    after = ""
                if str(after) == val:
                    return True
        # 还没出现 / 没写进 → 等一下重试
        try:
            page.wait_for_timeout(int(interval_ms))
        except Exception:
            time.sleep(interval_ms / 1000)
    if callable(log):
        log(f"  · #{eid} 多次重试仍未填上（懒加载段可能未渲染）")
    return False


def _fill_paypal_unified_guest_form(page, identity: dict, *, log: Callable[[str], None] | None = None) -> bool:
    """GuJumpgate 式：PayPal 统一 guest 表单（``#cardNumber`` 同页含
    国/地域 + メール + 電話 + 卡 + 账单 + 漢字/片假名姓名）全部按**精确 id**
    用 JS 直接设值，绕开 Playwright 可见性检查与 React re-render 清值。

    仅当页面确实是这种统一表单（存在 ``#cardNumber``）时才接管并返回 True；
    否则返回 False，让调用方走原有逐字段逻辑（两步式 / Stripe checkout）。

    字段 id 对照（来自实采 HTML）：
      #country(select) #email #phoneType(select) #phone #cardNumber #cardExpiry
      #cardCvv #billingPostalCode #billingState(select 都道府县) #billingCity
      #billingLine1 #billingLine2 #password #dateOfBirth
      #countrySpecificFirstName/#countrySpecificLastName（片假名）
      #firstName/#lastName（漢字）
    """
    log_fn = log or (lambda _msg: None)
    # 判定统一表单：必须有 #cardNumber（卡号框）
    try:
        has_card = page.locator("#cardNumber").first.count() > 0
    except Exception:
        has_card = False
    if not has_card:
        return False

    log_fn("PayPal 统一 guest 表单：按 GuJumpgate 方式逐 id JS 填值")
    region = str(identity.get("region") or "").strip().upper()

    email = str(identity.get("email") or "")
    password = str(identity.get("password") or "")
    phone_local = str(identity.get("phone") or "")
    card_number = str(identity.get("card_number") or CTF_CARD_NUMBER)
    card_exp_month = str(identity.get("card_exp_month") or CTF_CARD_EXP_MONTH)
    card_exp_year = str(identity.get("card_exp_year") or CTF_CARD_EXP_YEAR)
    card_cvv = str(identity.get("card_cvv") or CTF_CARD_CVV)
    postal_code = str(identity.get("postal_code") or CTF_POSTAL_CODE)
    city = str(identity.get("city") or CTF_CITY)
    line1 = str(identity.get("address_line1") or CTF_ADDRESS_LINE1)
    line2 = str(identity.get("address_line2") or CTF_ADDRESS_LINE2)
    state_value = str(identity.get("state") or "")

    # 有効期限：统一表单是单框 ``MM / YY`` 形态（pattern=\d{2}\s/\s\d{2}）
    exp_yy = card_exp_year[-2:] if card_exp_year else ""
    card_expiry = f"{card_exp_month} / {exp_yy}" if (card_exp_month and exp_yy) else ""

    # 1) 国/地域 select：**只在值不同时才改**。改 country 会触发整个账单区
    #    React 重渲染，把后面填的字段全清空（GuJumpgate selectHostedCountryByCode
    #    同款防护：值相同直接 return，真改了 sleep 等重渲染）。日区页面通常已
    #    默认日本，所以这步基本不动；只有当前值不对才设并等 1.5s 让表单稳定。
    expected_country = "JP" if region == "JP" else "US"
    try:
        cur_country = str(page.locator("#country").first.input_value(timeout=800) or "").strip().upper()
    except Exception:
        cur_country = ""
    if cur_country != expected_country:
        country_candidates = (
            ["JP", "Japan", "日本"] if region == "JP" else ["US", "United States", "アメリカ合衆国", "美国"]
        )
        if _force_select_by_id(page, "country", country_candidates, log=log_fn):
            log_fn(f"  · 国/地域已改为 {expected_country}，等待账单区重渲染")
            try:
                page.wait_for_timeout(1800)
            except Exception:
                time.sleep(1.8)
    else:
        log_fn(f"  · 国/地域已是 {expected_country}，跳过（避免触发重渲染清空字段）")

    # 2) 电话区号 + 本地号
    _select_ctf_phone_country(page, str(identity.get("phone_e164") or ""), log=log_fn)
    _force_fill_input_by_id(page, "phone", phone_local, log=log_fn)

    # 3) 基本字段（按 id 直填）
    _force_fill_input_by_id(page, "email", email, log=log_fn)
    _force_fill_input_by_id(page, "cardNumber", card_number, log=log_fn)
    if card_expiry:
        _force_fill_input_by_id(page, "cardExpiry", card_expiry, log=log_fn)
    _force_fill_input_by_id(page, "cardCvv", card_cvv, log=log_fn)
    _force_fill_input_by_id(page, "billingPostalCode", postal_code, log=log_fn)
    _force_fill_input_by_id(page, "billingCity", city, log=log_fn)
    _force_fill_input_by_id(page, "billingLine1", line1, log=log_fn)
    if line2:
        _force_fill_input_by_id(page, "billingLine2", line2, log=log_fn)
    if password:
        # forced-with-password-flow 段（密码/DOB/姓名）是懒加载的，往往要滚动
        # 进视口才渲染。先把页面滚到底触发渲染，再轮询填。
        try:
            page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        try:
            page.wait_for_timeout(400)
        except Exception:
            time.sleep(0.4)
        _wait_and_force_fill_by_id(page, "password", password, log=log_fn)

    # 5) 生年月日（懒加载段，需等渲染）。这个字段带 mask 模板，用 JS setter
    # 强写会被 mask 截断（``10/09/1985`` → ``10/09/19``），改成模拟键盘输入。
    dob = str(identity.get("date_of_birth") or CTF_DATE_OF_BIRTH)
    if dob:
        _wait_and_type_dob_by_id(page, "dateOfBirth", dob, log=log_fn)

    # 6) 姓名（懒加载段）：漢字 #firstName/#lastName + 片假名
    #    #countrySpecificFirstName/#countrySpecificLastName
    if region == "JP":
        _wait_and_force_fill_by_id(page, "firstName", str(identity.get("first_name_kanji") or identity.get("first_name") or ""), log=log_fn)
        _wait_and_force_fill_by_id(page, "lastName", str(identity.get("last_name_kanji") or identity.get("last_name") or ""), log=log_fn)
        _wait_and_force_fill_by_id(page, "countrySpecificFirstName", str(identity.get("first_name_kana") or ""), log=log_fn)
        _wait_and_force_fill_by_id(page, "countrySpecificLastName", str(identity.get("last_name_kana") or ""), log=log_fn)
    else:
        _wait_and_force_fill_by_id(page, "firstName", str(identity.get("first_name") or ""), log=log_fn)
        _wait_and_force_fill_by_id(page, "lastName", str(identity.get("last_name") or ""), log=log_fn)

    # 7) **最终校验重填**：React 重渲染 / 懒加载段挂载会把先填的字段清空
    #    （实测 billingLine1 等被清）。这里把所有"应有值"的字段再扫一遍，
    #    谁空了就补填。最多两轮，覆盖"填A时清了B、填B时清了A"的连锁。
    name_pairs = (
        [
            ("firstName", str(identity.get("first_name_kanji") or identity.get("first_name") or "")),
            ("lastName", str(identity.get("last_name_kanji") or identity.get("last_name") or "")),
            ("countrySpecificFirstName", str(identity.get("first_name_kana") or "")),
            ("countrySpecificLastName", str(identity.get("last_name_kana") or "")),
        ]
        if region == "JP"
        else [
            ("firstName", str(identity.get("first_name") or "")),
            ("lastName", str(identity.get("last_name") or "")),
        ]
    )
    expected_fields = [
        ("email", email),
        ("phone", phone_local),
        ("cardNumber", card_number),
        ("cardExpiry", card_expiry),
        ("cardCvv", card_cvv),
        ("billingPostalCode", postal_code),
        ("billingCity", city),
        ("billingLine1", line1),
        ("billingLine2", line2),
        ("password", password),
        ("dateOfBirth", dob),
    ] + name_pairs
    check_value_script = """
    (id) => {
      const el = document.getElementById(id);
      if (!el) return '__noel__';
      return String(el.value == null ? '' : el.value);
    }
    """
    for verify_round in range(2):
        refilled = 0
        for fid, fval in expected_fields:
            if not fval:
                continue
            try:
                cur = page.evaluate(check_value_script, fid)
            except Exception:
                continue
            if cur == "__noel__":
                continue
            # 卡号/有効期限页面会重格式化（加空格/斜杠），用去空格去斜杠比较
            def _norm(s):
                return re.sub(r"[\s/]", "", str(s or ""))
            if _norm(cur) == _norm(fval) or cur == fval:
                continue
            # ``dateOfBirth`` 是 mask 输入框，不能用 JS setter 强写（会被
            # mask 截断成前 6 位），必须用键盘 type。
            if fid == "dateOfBirth":
                if _wait_and_type_dob_by_id(page, fid, fval, log=log_fn, attempts=2, interval_ms=200):
                    refilled += 1
                continue
            if _force_fill_input_by_id(page, fid, fval, log=log_fn):
                refilled += 1
        # 都道府县 select 也校验一遍
        # 都道府县 select 也校验一遍（用强力轮询版，等 option 就绪 + 校验非空）
        if state_value:
            try:
                cur_state = page.evaluate(check_value_script, "billingState")
            except Exception:
                cur_state = "__noel__"
            if cur_state in ("", "__noel__"):
                if _wait_and_force_select_by_id(
                    page, "billingState", _jp_prefecture_candidates(state_value),
                    log=log_fn, attempts=4, interval_ms=400,
                ):
                    refilled += 1
        if refilled == 0:
            break
        log_fn(f"  · 最终校验第 {verify_round + 1} 轮：补填了 {refilled} 个被清空的字段")
        try:
            page.wait_for_timeout(400)
        except Exception:
            time.sleep(0.4)

    # **最后一步**：所有字段填完、页面稳定后，再强力选一次都道府县。
    # billingState 必须放最后——它在填 DOB/姓名（懒加载段）时会被 React
    # 重渲染清空，放最后选才不会被后续渲染重置。带轮询等 option 就绪 + 重试。
    if state_value:
        try:
            cur_state = page.evaluate(
                "() => { const el = document.getElementById('billingState');"
                " return el ? String(el.value || '') : '__noel__'; }"
            )
        except Exception:
            cur_state = ""
        if cur_state in ("", "__noel__"):
            _wait_and_force_select_by_id(
                page, "billingState", _jp_prefecture_candidates(state_value),
                log=log_fn, attempts=10, interval_ms=500,
            )
        else:
            log_fn(f"  · 都道府县已选中 value={cur_state!r}")

    log_fn("PayPal 统一 guest 表单：逐 id 填值完成")
    return True


def _fill_ctf_payment_form(page, identity: dict, *, log: Callable[[str], None] | None = None) -> None:
    # **GuJumpgate 兼容**：填表前先 strip 一次 captcha DOM 浮层 + 装 observer。
    # PayPal 进入 ``/checkoutweb/`` guest 表单时偶尔会用 ``#captcha-standalone``
    # overlay 把所有 input/按钮挡住，直接 click 会被 overlay 接走。
    log_fn = log or (lambda _msg: None)
    if callable(log):
        _install_paypal_captcha_dom_stripper(page, log=log)
    # **统一 guest 表单优先**：若页面是 ``#cardNumber`` 同页的统一表单
    # （国/地域+メール+電話+卡+账单+姓名），按 GuJumpgate 方式逐 id JS 填值，
    # 填完直接返回，跳过下面的逐字段 _require/_fill 链路（那套对 React 受控
    # 框 + 隐藏 select 不稳）。非统一表单（两步式 / Stripe）返回 False 继续走旧逻辑。
    try:
        if _fill_paypal_unified_guest_form(page, identity, log=log_fn):
            return
    except Exception as exc:
        log_fn(f"统一 guest 表单填写异常，回退逐字段逻辑: {exc}")
    address_line1 = str(identity.get("address_line1") or CTF_ADDRESS_LINE1)
    address_line2 = str(identity.get("address_line2") or CTF_ADDRESS_LINE2)
    city = str(identity.get("city") or CTF_CITY)
    postal_code = str(identity.get("postal_code") or CTF_POSTAL_CODE)
    card_number = str(identity.get("card_number") or CTF_CARD_NUMBER)
    card_exp_month = str(identity.get("card_exp_month") or CTF_CARD_EXP_MONTH)
    card_exp_year = str(identity.get("card_exp_year") or CTF_CARD_EXP_YEAR)
    card_cvv = str(identity.get("card_cvv") or CTF_CARD_CVV)
    _require_ctf_checkout_field(
        page,
        "Email",
        identity["email"],
        selectors=(
            'input[type="email"]',
            'input[name="email"]',
            'input[name*="email" i]',
            'input[id*="email" i]',
            'input[autocomplete="email"]',
            'input[placeholder*="Email" i]',
            'input[aria-label*="Email" i]',
            'input[placeholder*="メール"]',
            'input[aria-label*="メール"]',
        ),
        labels=(re.compile(r"email|邮箱|メール|メールアドレス", re.I),),
    )
    # 密码：两步式 "Create account" 流程有；直达的统一 guest 表单
    # （国/地域+メール+電話+カード 同页，访客付款）**没有**密码框。
    # 所以这里 best-effort 填——找不到不抛错，避免误杀统一 guest 表单。
    if not _fill_checkout_field(
        page,
        identity["password"],
        selectors=(
            'input[type="password"]',
            'input[name="password"]',
            'input[name*="password" i]',
            'input[id*="password" i]',
            'input[autocomplete="new-password"]',
            'input[placeholder*="Create password" i]',
            'input[placeholder*="Password" i]',
            'input[aria-label*="Create password" i]',
            'input[aria-label*="Password" i]',
            'input[placeholder*="パスワード"]',
            'input[aria-label*="パスワード"]',
        ),
        labels=(re.compile(r"password|密码|パスワード", re.I),),
    ):
        log_fn("  · 未发现密码框（统一 guest 表单无需创建密码），跳过")
    _require_ctf_checkout_field(
        page,
        "First name",
        identity["first_name"],
        selectors=(
            'input[name="firstName"]',
            'input[name="first_name"]',
            'input[name*="first" i]',
            'input[id*="first" i]',
            'input[autocomplete="given-name"]',
            'input[placeholder*="First name" i]',
            'input[aria-label*="First name" i]',
            'input[placeholder*="名"]',
            'input[aria-label*="名"]',
            'input[placeholder*="ファーストネーム"]',
            'input[aria-label*="ファーストネーム"]',
        ),
        labels=(re.compile(r"first name|given name|名|ファーストネーム|名前", re.I),),
    )
    _require_ctf_checkout_field(
        page,
        "Last name",
        identity["last_name"],
        selectors=(
            'input[name="lastName"]',
            'input[name="last_name"]',
            'input[name*="last" i]',
            'input[id*="last" i]',
            'input[autocomplete="family-name"]',
            'input[placeholder*="Last name" i]',
            'input[aria-label*="Last name" i]',
            'input[placeholder*="姓"]',
            'input[aria-label*="姓"]',
            'input[placeholder*="苗字"]',
            'input[aria-label*="苗字"]',
            'input[placeholder*="ラストネーム"]',
            'input[aria-label*="ラストネーム"]',
        ),
        labels=(re.compile(r"last name|family name|姓|苗字|ラストネーム", re.I),),
    )
    _fill_checkout_field(
        page,
        identity["name"],
        selectors=('input[name="name"]', 'input[autocomplete="name"]'),
        labels=(re.compile(r"full name|name|姓名|氏名|お名前|フルネーム", re.I),),
    )
    _require_ctf_checkout_field(
        page,
        "Street address",
        address_line1,
        selectors=(
            'input[name="streetAddress"]',
            'input[name="addressLine1"]',
            'input[name="address1"]',
            'input[autocomplete="address-line1"]',
            'input[autocomplete="billing address-line1"]',
            'input[placeholder*="Street address" i]',
            'textarea[placeholder*="Street address" i]',
            'input[placeholder*="住所"]',
            'input[aria-label*="住所"]',
            'input[placeholder*="番地"]',
            'input[placeholder*="町名"]',
        ),
        labels=(re.compile(r"street address|address line 1|address|街道|地址|住所|番地|町名|住所1", re.I),),
    )
    _fill_checkout_field(
        page,
        address_line2,
        selectors=(
            'input[name="addressLine2"]',
            'input[name="address2"]',
            'input[autocomplete="address-line2"]',
            'input[autocomplete="billing address-line2"]',
            'input[placeholder*="Apt" i]',
            'input[placeholder*="ste." i]',
            'input[placeholder*="bldg" i]',
        ),
        labels=(re.compile(r"apt|suite|address line 2|公寓|单元|建物名|部屋番号|住所2", re.I),),
    )
    _require_ctf_checkout_field(
        page,
        "City",
        city,
        selectors=(
            'input[name="city"]',
            'input[name="locality"]',
            'input[id*="city" i]',
            'input[autocomplete="address-level2"]',
            'input[autocomplete="billing address-level2"]',
            'input[placeholder*="City" i]',
            'input[aria-label*="City" i]',
            'input[placeholder*="市区町村"]',
            'input[aria-label*="市区町村"]',
            'input[placeholder*="都市"]',
        ),
        labels=(re.compile(r"city|城市|市区町村|都市|市", re.I),),
    )
    if not _select_ctf_state_field(page, identity, log=log_fn):
        raise RuntimeError("CTF 创建页字段未填写: State")
    _require_ctf_checkout_field(
        page,
        "ZIP code",
        postal_code,
        selectors=(
            'input[name="zip"]',
            'input[name="zipcode"]',
            'input[name="postalCode"]',
            'input[name="postal_code"]',
            'input[id*="zip" i]',
            'input[id*="postal" i]',
            'input[autocomplete="postal-code"]',
            'input[autocomplete="billing postal-code"]',
            'input[placeholder*="ZIP" i]',
            'input[placeholder*="Postal" i]',
            'input[aria-label*="ZIP" i]',
            'input[aria-label*="Postal" i]',
            'input[placeholder*="郵便番号"]',
            'input[aria-label*="郵便番号"]',
            'input[placeholder*="〒"]',
        ),
        labels=(re.compile(r"zip|postal|邮编|郵便番号|〒", re.I),),
    )
    # 填电话号前先按号码实际国家码设区号选择器：避免 JP 区页面默认 +81
    # 选择器 + US 本地号（或反之）错配导致 PayPal 弹「請換電話號碼」。
    # best-effort，找不到选择器不影响后续填号。
    _select_ctf_phone_country(
        page,
        str(identity.get("phone_e164") or ""),
        log=log_fn,
    )
    _require_ctf_checkout_field(
        page,
        "Phone number",
        str(identity.get("phone") or CTF_PHONE_NUMBER).lstrip("+"),
        selectors=(
            'input[type="tel"]',
            'input[name*="phone" i]',
            'input[id*="phone" i]',
            'input[autocomplete="tel"]',
            'input[placeholder*="Phone number" i]',
            'input[placeholder*="Mobile" i]',
            'input[aria-label*="Phone number" i]',
            'input[aria-label*="Mobile" i]',
            'input[placeholder*="電話番号"]',
            'input[aria-label*="電話番号"]',
            'input[placeholder*="携帯"]',
            'input[aria-label*="携帯"]',
        ),
        labels=(re.compile(r"phone|mobile|telephone|手机|电话|電話|電話番号|携帯|モバイル", re.I),),
    )
    _require_ctf_checkout_field(
        page,
        "Card number",
        card_number,
        selectors=(
            'input[name*="cardNumber" i]',
            'input[name*="card_number" i]',
            'input[name*="card-number" i]',
            'input[id*="cardNumber" i]',
            'input[id*="card_number" i]',
            'input[id*="card-number" i]',
            'input[autocomplete="cc-number"]',
            'input[placeholder*="Card number" i]',
            'input[aria-label*="Card number" i]',
            'input[placeholder*="カード番号"]',
            'input[aria-label*="カード番号"]',
        ),
        labels=(re.compile(r"card number|card|卡号|カード番号|クレジットカード番号", re.I),),
    )
    _require_ctf_checkout_field(
        page,
        "Expiration date",
        f"{card_exp_month}/{card_exp_year}",
        selectors=(
            'input[name*="exp" i]',
            'input[id*="exp" i]',
            'input[autocomplete="cc-exp"]',
            'input[placeholder*="Expiration date" i]',
            'input[placeholder*="Expiry" i]',
            'input[aria-label*="Expiration date" i]',
            'input[aria-label*="Expiry" i]',
            'input[placeholder*="有効期限"]',
            'input[aria-label*="有効期限"]',
        ),
        labels=(re.compile(r"exp|expiry|expiration|有效期|有効期限", re.I),),
    )
    _fill_checkout_field(
        page,
        card_exp_month,
        selectors=('input[name*="month" i]', 'select[name*="month" i]', 'input[autocomplete="cc-exp-month"]'),
        labels=(re.compile(r"month|月份|月", re.I),),
        select=True,
    )
    _fill_checkout_field(
        page,
        card_exp_year,
        selectors=('input[name*="year" i]', 'select[name*="year" i]', 'input[autocomplete="cc-exp-year"]'),
        labels=(re.compile(r"year|年份|年", re.I),),
        select=True,
    )
    _require_ctf_checkout_field(
        page,
        "CVV",
        card_cvv,
        selectors=(
            'input[name*="cvv" i]',
            'input[name*="cvc" i]',
            'input[name*="securityCode" i]',
            'input[name*="security_code" i]',
            'input[id*="cvv" i]',
            'input[id*="cvc" i]',
            'input[id*="securityCode" i]',
            'input[id*="security_code" i]',
            'input[autocomplete="cc-csc"]',
            'input[placeholder*="CVV" i]',
            'input[placeholder*="CVC" i]',
            'input[aria-label*="CVV" i]',
            'input[aria-label*="CVC" i]',
            'input[placeholder*="セキュリティコード"]',
            'input[aria-label*="セキュリティコード"]',
            'input[placeholder*="セキュリティ番号"]',
            'input[aria-label*="セキュリティ番号"]',
        ),
        labels=(re.compile(r"cvv|cvc|security code|安全码|セキュリティコード|セキュリティ番号", re.I),),
    )

    # ===== PayPal hosted guest checkout（``paypal.com/checkoutweb/signup``）
    # JP 区专属字段：identity 在 ``_apply_billing_profile_to_ctf_identity``
    # 里检测到 ``country == "JP"`` 时已经填好了 ``first_name_kanji`` /
    # ``first_name_kana`` / ``date_of_birth`` 等。这里 best-effort 填——
    # CTF sandbox 上这些 ID 不存在，``_fill_checkout_field`` 找不到 locator
    # 直接 return False，主流程不抛错；PayPal hosted 上能命中就把片假名 /
    # 出生日期 / 详细账单地址都填进去，避免风控判"姓名片假名缺失" /
    # "DOB 必填"导致提交失败。
    if str(identity.get("region") or "").upper() == "JP":
        if log_fn:
            log_fn("PayPal hosted JP 专属字段：开始 best-effort 填写漢字/片假名姓名 / DOB / 账单地址")
        # 漢字姓名（``#firstName`` / ``#lastName``）。统一 guest 表单里漢字组
        # 和片假名组**共用** ``name="fname"`` / ``name="lname"``，只有 id 不同，
        # 且片假名组在 DOM 里靠前——前面 "First name"/"Last name" 的 require
        # 用 ``input[id*="first" i].first`` 只会命中靠前的片假名框，漢字框
        # （``#firstName``/``#lastName``）始终漏填。这里按**精确 id**补上漢字组。
        _fill_checkout_field(
            page,
            str(identity.get("first_name_kanji") or identity.get("first_name") or ""),
            selectors=('#firstName', 'input#firstName'),
            labels=(),
        )
        _fill_checkout_field(
            page,
            str(identity.get("last_name_kanji") or identity.get("last_name") or ""),
            selectors=('#lastName', 'input#lastName'),
            labels=(),
        )
        # 片假名姓名（``#countrySpecificFirstName`` / ``#countrySpecificLastName``）
        _fill_checkout_field(
            page,
            str(identity.get("first_name_kana") or ""),
            selectors=(
                '#countrySpecificFirstName',
                'input[name="countrySpecificFirstName"]',
                'input[id*="countrySpecificFirst" i]',
            ),
            labels=(),
        )
        _fill_checkout_field(
            page,
            str(identity.get("last_name_kana") or ""),
            selectors=(
                '#countrySpecificLastName',
                'input[name="countrySpecificLastName"]',
                'input[id*="countrySpecificLast" i]',
            ),
            labels=(),
        )
        # 出生日期（``#dateOfBirth``，``MM/DD/YYYY`` 文本格式；hosted form
        # 的输入掩码即便 JP 区也走美式 M/D/YYYY 布局）
        _wait_and_type_dob_by_id(
            page,
            "dateOfBirth",
            str(identity.get("date_of_birth") or CTF_DATE_OF_BIRTH),
            log=log_fn,
            attempts=4,
            interval_ms=300,
        )
        # PayPal hosted 的账单字段命名（``billingState`` / ``billingPostalCode``
        # / ``billingCity`` / ``billingLine1`` / ``billingLine2``）跟 Stripe 不同；
        # 这里把 ``identity`` 里的真实 JP 地址再补一遍（``_apply_billing_profile_to_ctf_identity``
        # 已把 billing_profile 的 ``state`` / ``postal_code`` / ``city`` /
        # ``line1`` / ``line2`` 透传到 identity 同名字段）。
        # CTF sandbox 上这些 ID 不存在，selector 全部 miss 直接返回，无影响。
        jp_state = str(identity.get("state") or "")
        jp_city = str(identity.get("city") or "")
        jp_postal = str(identity.get("postal_code") or "")
        jp_line1 = str(identity.get("address_line1") or "")
        jp_line2 = str(identity.get("address_line2") or "")
        if jp_state:
            # billingState 是隐藏/异步渲染的原生 <select>（option value=汉字，
            # label=汉字）。Playwright select_option 对这种 select 经常等不到
            # 可见而超时——参考 GuJumpgate ``fillHostedBillingState`` 的做法，
            # 直接用 JS 命中 option + 设 value + 派发 input/change。先展开都道府县
            # 别名（罗马字/汉字/PayPal 全大写码都能命中）。
            jp_state_candidates = _jp_prefecture_candidates(jp_state)
            state_done = False
            for sel in ('#billingState', 'select[name="billingState"]'):
                try:
                    loc = page.locator(sel).first
                    if loc.count() <= 0:
                        continue
                except Exception:
                    continue
                if _force_select_native_option(loc, jp_state_candidates, log=log_fn):
                    state_done = True
                    break
            # 兜底：JS 没命中再走常规 select_option（可见 select 时有效）
            if not state_done:
                _fill_checkout_field(
                    page,
                    jp_state,
                    selectors=('#billingState', 'select[name="billingState"]'),
                    labels=(),
                    select=True,
                )
            if log_fn:
                log_fn(f"  · billingState 候选={jp_state_candidates} {'✓' if state_done else '(走常规兜底)'}")
        if jp_postal:
            _fill_checkout_field(
                page,
                jp_postal,
                selectors=(
                    '#billingPostalCode',
                    'input[name="billingPostalCode"]',
                ),
                labels=(),
            )
        if jp_city:
            _fill_checkout_field(
                page,
                jp_city,
                selectors=(
                    '#billingCity',
                    'input[name="billingCity"]',
                ),
                labels=(),
            )
        if jp_line1:
            _fill_checkout_field(
                page,
                jp_line1,
                selectors=(
                    '#billingLine1',
                    'input[name="billingLine1"]',
                ),
                labels=(),
            )
        if jp_line2:
            _fill_checkout_field(
                page,
                jp_line2,
                selectors=(
                    '#billingLine2',
                    'input[name="billingLine2"]',
                ),
                labels=(),
            )
        if log_fn:
            log_fn(
                "PayPal hosted JP 专属字段填写完毕："
                f"姓={identity.get('last_name_kanji', '?')}({identity.get('last_name_kana', '?')}) "
                f"名={identity.get('first_name_kanji', '?')}({identity.get('first_name_kana', '?')}) "
                "DOB=<configured>"
            )


def _ctf_verification_popup_visible(page) -> bool:
    locators = []
    for factory in (
        lambda: page.locator('[data-testid="sca-confirm-multi-field"]').first,
        lambda: page.locator('[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"]').first,
        lambda: page.locator('[data-testid="sca-confirm-multi-field"] input[id^="ci-ciBasic-"]').first,
        lambda: page.locator('#ciBasic input[name^="ciBasic-"]').first,
        lambda: page.locator('#ciBasic input[id^="ci-ciBasic-"]').first,
        lambda: page.locator('input[name^="ciBasic-"]').first,
        lambda: page.locator('input[id^="ci-ciBasic-"]').first,
        lambda: page.locator('input[autocomplete="one-time-code"]').first,
        lambda: page.locator('input[name*="otp" i]').first,
        lambda: page.locator('input[id*="otp" i]').first,
        lambda: page.locator('input[name*="verification" i]').first,
        lambda: page.locator('input[id*="verification" i]').first,
        lambda: page.locator('input[placeholder*="verification code" i]').first,
        lambda: page.locator('input[aria-label*="verification code" i]').first,
        lambda: page.locator('input[placeholder*="one-time" i]').first,
        lambda: page.locator('input[aria-label*="one-time" i]').first,
        lambda: page.locator('input[placeholder*="認証コード"]').first,
        lambda: page.locator('input[aria-label*="認証コード"]').first,
        lambda: page.locator('input[placeholder*="確認コード"]').first,
        lambda: page.locator('input[aria-label*="確認コード"]').first,
        lambda: page.locator('input[placeholder*="ワンタイム"]').first,
        lambda: page.locator('input[aria-label*="ワンタイム"]').first,
        lambda: page.locator('[role="dialog"] input[name*="code" i]').first,
        lambda: page.locator('[role="dialog"] input[inputmode="numeric"]').first,
        lambda: page.locator('[aria-modal="true"] input[name*="code" i]').first,
        lambda: page.locator('[aria-modal="true"] input[inputmode="numeric"]').first,
    ):
        try:
            locators.append(factory())
        except Exception:
            pass
    if any(_locator_ready(locator) for locator in locators):
        return True

    dialog_locators = []
    text_pattern = re.compile(r"enter.*code|sent.*6[- ]digit|6[- ]digit|security code|verification code|one[- ]?time code|验证码|安全码|認証コード|確認コード|ワンタイムコード|6桁|送信したコード", re.I)
    for factory in (
        lambda: page.locator('[role="dialog"]').first,
        lambda: page.locator('[aria-modal="true"]').first,
    ):
        try:
            dialog_locators.append(factory())
        except Exception:
            pass
    text_locators = []
    for factory in (
        lambda: page.get_by_text(text_pattern).first,
    ):
        try:
            text_locators.append(factory())
        except Exception:
            pass
    return any(_locator_visible(locator) for locator in dialog_locators) and any(_locator_visible(locator) for locator in text_locators)


# === PayPal SMS OTP popup 容错三件套 =========================================
#
# **背景**：PayPal 在 ``/checkoutweb/signup`` 注册流程提交后会弹一个 SCA confirm
# popup 让用户填 6 位 SMS 验证码。生产环境上经常碰到这两类异常：
#
#   1. **"Resend code"**：SMS 一直不到（短信运营商抖动 / PayPal 后端慢），用户
#      只要点 popup 上的"Resend code"按钮让 PayPal 重新触发一条 SMS 就行。
#      原实现是"取不到 code → 关 popup → 重新填表 → 重新点 submit"——这条路径
#      会被 PayPal 风控判"同邮箱短时间二次注册"，OAS_ERROR 概率显著上升。
#
#   2. **"号码被拒"**：PayPal 识别号码所在国家/运营商不在白名单（VOIP 号 / 已被
#      标记的池号），popup 上会直接出"Phone number not supported / Try a
#      different phone"。这时要做的是关掉 popup → 换 ``sms_pool[i+1]`` 重启
#      流程，而不是傻乎乎在同一号码上 Resend。
#
# 这三个函数就是给主循环用的最小化原语：``_click_ctf_resend_in_popup`` 点
# Resend，``_detect_ctf_phone_rejected`` 识别拒号文案，``_close_ctf_popup_if_present``
# 关 popup 让换号能重新走表单。三者都对 page 关闭 / locator 异常做兜底。

_CTF_RESEND_PATTERN = re.compile(
    r"resend\s*code|send\s+a?\s*new\s+code|send\s+(it\s+)?again|new\s+code|"
    r"重新发送|重发验证码|再发一次|重新获取|"
    r"コードを再送|もう一度送信|新しいコード|再送信|再度送信|もう一度コード",
    re.I,
)
_CTF_PHONE_REJECTED_PATTERN = re.compile(
    r"can'?t\s+send|couldn'?t\s+send|cannot\s+send|unable\s+to\s+send|"
    r"(invalid|unsupported|not\s+supported|not\s+valid)\s+(phone|number)|"
    r"(phone|number)\s+(invalid|unsupported|not\s+supported|not\s+valid|isn'?t\s+supported)|"
    r"try\s+(another|a\s+different)\s+(phone|number)|"
    r"different\s+(phone|number)|"
    r"无法发送|号码无效|换.{0,4}(手机|号码)|不支持(的)?号码|号码不可用|请使用其他号码|"
    r"送信できません|送信に失敗|無効な(電話|番号)|サポートされていない(電話|番号)|"
    r"別の(電話|番号)|有効な電話番号|電話番号を確認|サポート対象外",
    re.I,
)
_CTF_POPUP_CLOSE_PATTERN = re.compile(
    r"cancel|close|dismiss|取消|关闭|キャンセル|閉じる|戻る",
    re.I,
)


def _click_ctf_resend_in_popup(page, *, log: Callable[[str], None]) -> bool:
    """点 PayPal SCA confirm popup 上的 "Resend code" 按钮。

    返回 ``True`` 表示点到了；``False`` 表示 popup 上没有可点的 Resend 按钮
    （或 popup 已不可见）。

    选择器优先级：dialog scope 内的 button/link → 全局 button/link → text。
    Dialog scope 优先是因为 PayPal 注册页（``/checkoutweb/signup``）整页也有
    一个"Resend code"按钮（注册流程主页面级 OTP），不属于 popup 范畴。
    """
    locators: list = []
    for sel in (
        '[role="dialog"] button:has-text("Resend code")',
        '[role="dialog"] button:has-text("Resend")',
        '[aria-modal="true"] button:has-text("Resend code")',
        '[aria-modal="true"] button:has-text("Resend")',
        '[role="dialog"] a:has-text("Resend code")',
        '[role="dialog"] a:has-text("Resend")',
        '[aria-modal="true"] a:has-text("Resend code")',
        '[aria-modal="true"] a:has-text("Resend")',
        # 日文文案
        '[role="dialog"] button:has-text("コードを再送")',
        '[role="dialog"] button:has-text("再送信")',
        '[role="dialog"] button:has-text("もう一度送信")',
        '[aria-modal="true"] button:has-text("コードを再送")',
        '[aria-modal="true"] button:has-text("再送信")',
        '[aria-modal="true"] button:has-text("もう一度送信")',
        '[role="dialog"] a:has-text("コードを再送")',
        '[role="dialog"] a:has-text("再送信")',
        '[aria-modal="true"] a:has-text("コードを再送")',
        '[aria-modal="true"] a:has-text("再送信")',
        '[role="dialog"] [data-testid*="resend" i]',
        '[aria-modal="true"] [data-testid*="resend" i]',
        '[role="dialog"] button[name*="resend" i]',
        '[aria-modal="true"] button[name*="resend" i]',
    ):
        try:
            locators.append(page.locator(sel).first)
        except Exception:
            pass
    for role in ("button", "link"):
        try:
            locators.append(page.get_by_role(role, name=_CTF_RESEND_PATTERN).first)
        except Exception:
            pass
    try:
        locators.append(page.get_by_text(_CTF_RESEND_PATTERN).first)
    except Exception:
        pass
    for locator in locators:
        if not _locator_ready(locator):
            continue
        try:
            _click_or_check(locator)
        except Exception as exc:
            log(f"点击 PayPal popup Resend 按钮失败（尝试下一候选）: {exc}")
            continue
        log("已点击 PayPal OTP popup 上的 Resend 按钮，等待新短信")
        return True
    return False


def _request_swap_phone(
    callback: Optional[Callable[[str], Optional[dict]]],
    rejected_e164: str,
    *,
    log: Callable[[str], None],
) -> Optional[dict]:
    """调上层提供的 swap callback 换一条号。

    用途：CTF sandbox 流程检测到 PayPal 拒号文案后，希望从全局空闲 SMS
    池里拿一条新号继续。这个抽象让 application 层（持有跨 worker 的
    slot_queue）注入 swap 逻辑，payment 模块本身保持无状态。

    返回 ``{"phone": "...", "phone_e164": "+...", "relay_url": "..."}``
    或 ``None``（callback 没传 / 返回 None / 抛错）。
    """
    if not callable(callback):
        return None
    try:
        result = callback(str(rejected_e164 or ""))
    except Exception as exc:
        log(f"phone_swap_callback 抛错（视为池空）: {exc}")
        return None
    if not isinstance(result, dict):
        return None
    phone_e164 = str(result.get("phone_e164") or "").strip()
    relay_url = str(result.get("relay_url") or "").strip()
    if not (phone_e164 and relay_url):
        log("phone_swap_callback 返回的 entry 缺 phone_e164/relay_url，视为池空")
        return None
    log("phone_swap_callback 已提供新的号码配置")
    return result


def _detect_ctf_phone_rejected(page) -> tuple[bool, str]:
    """检查 popup / 页面 body 上是否出现 PayPal 拒绝号码的文案。

    返回 ``(rejected, reason)``。``reason`` 是命中的上下文片段（截 80 字以
    内），便于在 log 里定位是哪类拒绝。

    实现：把 body inner_text 全部拉出来一次扫，覆盖 PayPal 在不同 locale /
    A-B test 下的多种话术（详见 ``_CTF_PHONE_REJECTED_PATTERN``）。
    """
    try:
        text = _page_body_text(page)
    except Exception:
        text = ""
    if not text:
        return False, ""
    match = _CTF_PHONE_REJECTED_PATTERN.search(text)
    if not match:
        return False, ""
    start = max(match.start() - 16, 0)
    end = min(match.end() + 60, len(text))
    snippet = re.sub(r"\s+", " ", text[start:end]).strip()
    return True, snippet[:80]


def _close_ctf_popup_if_present(page, *, log: Callable[[str], None]) -> bool:
    """关闭 PayPal OTP popup（用于换号 / 取消时让表单重新可见）。

    顺序：
      1. 找 dialog scope 内的 ``aria-label="Close"`` / ``data-testid="close"``
         X 按钮。
      2. 找 dialog scope 内文案为 Cancel/Close/取消 的 button。
      3. 兜底：发 ESC 键。

    返回 ``True`` 表示已经发出关闭指令（不保证 100% 关掉，因为某些 PayPal
    popup 在号码被拒时只允许 Cancel，没有 Close）；``False`` 表示连 ESC 都失败。
    """
    locators: list = []
    for sel in (
        '[role="dialog"] [aria-label="Close"]',
        '[aria-modal="true"] [aria-label="Close"]',
        '[role="dialog"] [aria-label="閉じる"]',
        '[aria-modal="true"] [aria-label="閉じる"]',
        '[role="dialog"] [aria-label*="閉じる"]',
        '[aria-modal="true"] [aria-label*="閉じる"]',
        '[role="dialog"] button[data-testid*="close" i]',
        '[aria-modal="true"] button[data-testid*="close" i]',
        '[role="dialog"] button[data-testid*="cancel" i]',
        '[aria-modal="true"] button[data-testid*="cancel" i]',
        '[role="dialog"] button[aria-label*="close" i]',
        '[aria-modal="true"] button[aria-label*="close" i]',
        '[role="dialog"] button[aria-label*="キャンセル"]',
        '[aria-modal="true"] button[aria-label*="キャンセル"]',
    ):
        try:
            locators.append(page.locator(sel).first)
        except Exception:
            pass
    try:
        locators.append(
            page.get_by_role("button", name=_CTF_POPUP_CLOSE_PATTERN).first
        )
    except Exception:
        pass
    for locator in locators:
        if not _locator_ready(locator):
            continue
        try:
            _click_or_check(locator)
        except Exception as exc:
            log(f"点击 PayPal popup 关闭按钮失败（尝试下一候选）: {exc}")
            continue
        log("已点击关闭 PayPal OTP popup（用于换号 / 取消）")
        try:
            page.wait_for_timeout(600)
        except Exception:
            time.sleep(0.6)
        return True
    # 兜底：ESC 键
    try:
        page.keyboard.press("Escape")
        log("已发送 ESC 关闭 PayPal OTP popup（兜底，无明确关闭按钮）")
        try:
            page.wait_for_timeout(500)
        except Exception:
            time.sleep(0.5)
        return True
    except Exception as exc:
        log(f"ESC 关闭 PayPal OTP popup 失败: {exc}")
        return False


def _click_ctf_submit_until_code_popup(page, *, log: Callable[[str], None]) -> None:
    submit_patterns = (re.compile(r"submit|continue|pay|create|verify|提交|继续|支付|创建|验证|送信|登録|支払う|作成|確認|続ける|認証", re.I),)
    for attempt in range(1, 4):
        log(f"提交 CTF 创建页第 {attempt}/3 次")
        # **GuJumpgate 兼容**：点提交前后各 strip 一次 captcha DOM。
        # PayPal 的 ``#captcha-standalone`` 浮层常在点击提交按钮时**才**
        # 注入到 DOM——比 form 填写阶段还晚——所以这里要双保险。
        _install_paypal_captcha_dom_stripper(page, log=log)
        _click_by_candidates(
            page,
            label="CTF 创建页提交按钮",
            selectors=('button[type="submit"]', 'input[type="submit"]'),
            patterns=submit_patterns,
        )
        _install_paypal_captcha_dom_stripper(page, log=log)
        try:
            page.wait_for_timeout(10000)
        except Exception:
            time.sleep(10)
        if _ctf_verification_popup_visible(page):
            log("检测到验证码弹窗")
            return
    raise RuntimeError("提交 3 次后仍未检测到验证码弹窗")


def _fill_segmented_ctf_verification_code(page, code: str) -> bool:
    digits = re.sub(r"\D", "", str(code or ""))
    if len(digits) != 6:
        return False
    for selector in (
        '[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"]',
        '[data-testid="sca-confirm-multi-field"] input[id^="ci-ciBasic-"]',
        '[data-testid="sca-confirm-multi-field"] input[type="tel"]',
        '#ciBasic input[name^="ciBasic-"]',
        '#ciBasic input[id^="ci-ciBasic-"]',
        '#ciBasic input[type="tel"]',
        'input[name^="ciBasic-"]',
        'input[id^="ci-ciBasic-"]',
    ):
        try:
            group = page.locator(selector)
            count = group.count()
        except Exception:
            continue
        if count < len(digits) or not hasattr(group, "nth"):
            continue
        filled = 0
        for index, digit in enumerate(digits):
            try:
                locator = group.nth(index)
                if not _locator_ready(locator):
                    break
                locator.fill(digit, timeout=3000)
                filled += 1
            except Exception:
                break
        if filled == len(digits):
            return True
    return False


def _detect_ctf_otp_error(page) -> bool:
    """检测 OTP 提交后 PayPal popup 上的"验证码错误"提示。

    PayPal 在 SCA confirm popup 里 OTP 校验失败时会渲染 ``Sorry, something
    went wrong. Get a new code.`` 文案；上层捕获后应主动点 Resend code，
    重新拉一次 SMS、重新填，避免在错码上死磕导致 popup 卡死。

    误报兜底：只匹配 popup / dialog scope 里的红字提示 + 经典文案，避免
    把页面其它 fraud 提示误识为 OTP 错误。
    """
    try:
        text = _page_body_text(page).lower()
    except Exception:
        text = ""
    if not text:
        return False
    # 命中任一文案即视为 OTP 校验失败
    return any(
        token in text
        for token in (
            "sorry, something went wrong",
            "get a new code",
            "code is incorrect",
            "incorrect code",
            "invalid code",
            "code expired",
            "code didn'\u2019t work",
            "code didn't work",
            "验证码不正确",
            "验证码已过期",
            # 日文兼容
            "申し訳ございません",
            "申し訳ありません",
            "エラーが発生",
            "新しいコードを取得",
            "コードが正しくありません",
            "無効なコード",
            "コードの有効期限が切れました",
            "コードの有効期限が切れ",
            "コードが機能しませんでした",
        )
    )


def _fill_ctf_verification_code(page, code: str, *, log: Callable[[str], None] | None = None) -> None:
    log_fn = log or (lambda _msg: None)
    # **GuJumpgate 同款**：填验证码前先 strip 一次 PayPal captcha 浮层。
    # 实战日志：账单页提交 SMS 时 PayPal 弹 ``#captchaComponent``
    # （内含 reCAPTCHA iframe 的 ngrl-anomalydetection-div 容器），如果
    # 不在 fill+点击前后 strip，下层 OTP 表单会被遮罩拦截 click。
    _install_paypal_captcha_dom_stripper(page, log=log_fn)
    if not _fill_segmented_ctf_verification_code(page, code) and not _fill_checkout_field(
        page,
        code,
        selectors=(
            '[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"]',
            '[data-testid="sca-confirm-multi-field"] input[id^="ci-ciBasic-"]',
            '#ciBasic input[name^="ciBasic-"]',
            '#ciBasic input[id^="ci-ciBasic-"]',
            'input[autocomplete="one-time-code"]',
            'input[name*="otp" i]',
            'input[id*="otp" i]',
            'input[name*="verification" i]',
            'input[id*="verification" i]',
            'input[placeholder*="verification code" i]',
            'input[aria-label*="verification code" i]',
            'input[placeholder*="one-time" i]',
            'input[aria-label*="one-time" i]',
            'input[placeholder*="認証コード"]',
            'input[aria-label*="認証コード"]',
            'input[placeholder*="確認コード"]',
            'input[aria-label*="確認コード"]',
            'input[placeholder*="ワンタイム"]',
            'input[aria-label*="ワンタイム"]',
            '[role="dialog"] input[name*="code" i]',
            '[role="dialog"] input[inputmode="numeric"]',
            '[aria-modal="true"] input[name*="code" i]',
            '[aria-modal="true"] input[inputmode="numeric"]',
            'input[inputmode="numeric"]',
        ),
        labels=(re.compile(r"security code|verification code|code|验证码|安全码|認証コード|確認コード|ワンタイムコード", re.I),),
    ):
        raise RuntimeError("未找到验证码输入框")
    # 点击 submit 按钮**之前**再 strip 一次：PayPal 通常在 fill input 触发
    # 的 input/blur 事件回调里才动态插入 captcha 浮层（实战 DOM 拍照即此），
    # 也就是 fill 完成那一瞬间才出现。
    _install_paypal_captcha_dom_stripper(page, log=log_fn)
    try:
        _click_by_candidates(
            page,
            label="验证码提交按钮",
            selectors=('button[type="submit"]', 'input[type="submit"]'),
            patterns=(re.compile(r"submit|continue|verify|提交|继续|验证|送信|確認|認証|次へ|続ける", re.I),),
        )
    except Exception:
        pass
    # 点击之后再 strip 一次：有些页面 captcha 会在 submit 触发后才弹。
    _install_paypal_captcha_dom_stripper(page, log=log_fn)


def _is_chatgpt_success_url(url: str) -> bool:
    """支付完成后的"成功跳回"判定。

    PayPal 完成后跳回的目的页历史上是 ``chatgpt.com``，但部分账号 / 部分
    plan / 新版 cashier 流程会跳到 ``pay.openai.com``（OpenAI 自家收银台
    域名）—— 两者都视为成功。判定只看 host 子串，不强依赖 path / query
    参数，避免随时间漂移。
    """
    lowered = str(url or "").lower()
    return "chatgpt.com" in lowered or "pay.openai.com" in lowered


def _poll_url_changed(
    page,
    *,
    initial_url: str,
    timeout_ms: int,
    log: Callable[[str], None],
    poll_interval_ms: int = 3000,
    label: str = "页面",
) -> str:
    """Python 端轮询等待主 page URL 离开 ``initial_url``。

    **背景**：PayPal hermes / billingweb / paypal.com 多数页面 CSP 禁了
    ``unsafe-eval``，``page.wait_for_function`` 会立刻抛 ``EvalError`` 失效，
    外层循环 1 秒内重进重点几十次（实战日志：review 页 1s 内 ~30 次
    "Agree and Continue"）。改为 Python 端读 ``page.url`` 轮询，跟 CSP
    无关。

    检查频率默认 ``poll_interval_ms=3000``——Agree/Approve 后转圈一般
    5~15s，3s 一次足够覆盖且不空转。

    返回当前主 page URL：
      * URL 已离开 ``initial_url`` → 返回新 URL
      * 超时 → 返回当前 URL（外层据此判断是否真离开）
    """
    deadline = time.monotonic() + max(int(timeout_ms or 30000), 1000) / 1000
    interval = max(int(poll_interval_ms), 500) / 1000
    while time.monotonic() <= deadline:
        current_url = _current_page_url(page, initial_url)
        if current_url and current_url != initial_url:
            log(f"{label}已跳走: {current_url}")
            return current_url
        try:
            page.wait_for_timeout(int(interval * 1000))
        except Exception:
            time.sleep(interval)
    log(f"{label}等待跳转超时，仍停在 {initial_url}")
    return _current_page_url(page, initial_url)


def _detect_paypal_account_limited(page) -> bool:
    """检测 PayPal "Your account is limited" 终态页。

    实战截图：``Your account is limited. Please check your PayPal Account
    Overview page for information on how to resolve this problem.`` +
    "Return to merchant" 按钮。匹配关键文案命中即视为账户被风控限制。

    根因通常不在代码层（卡 BIN 黑、IP 关联、profile 关联），上层应直接
    fail 这一轮，不再重试同号同 profile。
    """
    try:
        text = _page_body_text(page).lower()
    except Exception:
        return False
    if not text:
        return False
    if "account is limited" in text and "paypal" in text:
        return True
    if "account has been limited" in text and "paypal" in text:
        return True
    # 日文文案
    if (
        ("アカウントが制限" in text or "アカウントは制限" in text or "アカウント制限" in text)
        and ("paypal" in text or "ペイパル" in text)
    ):
        return True
    return False


def _wait_for_chatgpt_return(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    cancel_check: Callable[[], bool] | None = None,
    turnstile_solver: Callable[..., str] | None = None,
) -> str:
    """轮询等待页面跳回 ChatGPT / pay.openai 收银台。

    **关键不变量**：等待期间会主动处理 PayPal 在 SMS 之后插入的中间页和随机
    弹出的反爬控件——否则会卡 5 分钟超时（实测有用户截图为证）：

    1. ``/webapps/hermes`` "Set up once. Pay faster next time." 再次确认页
       → 自动点 ``Agree and Continue``（见用户截图：SMS 验证完后被 PayPal
       引到这里要求同意，错过这步永远不会跳 ChatGPT）。
    2. ``/agreements/approve`` 协议中间页 → 自动走 ``_advance_paypal_intermediate_pages``。
    3. 期间随机弹出的 Turnstile / reCAPTCHA security challenge → 调用
       配置的 ``turnstile_solver`` （YesCaptcha）自动求解；未配 solver 时
       退化为静态等待，避免空跑。

    成功条件放宽：URL host 含 ``chatgpt.com`` **或** ``pay.openai.com``
    都视为完成（见 ``_is_chatgpt_success_url``）。

    若超时仍未跳回，抛 ``RuntimeError`` 把最后已知 URL 带出。
    """
    deadline = time.monotonic() + max(int(timeout_ms or 300000), 60000) / 1000
    last_logged_url = ""
    log("等待页面跳回 chatgpt / pay.openai（期间会自动处理 Agree and Continue / security challenge）")
    while time.monotonic() <= deadline:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")
        active_page = _pick_active_page(page)
        if active_page is not page:
            log(
                f"检测到原 page 已关闭，切换到上下文中存活的 page: "
                f"{_current_page_url(active_page)}"
            )
            page = active_page
        current_url = _current_page_url(page)
        if _is_chatgpt_success_url(current_url):
            log(f"已跳回 chatgpt / pay.openai: {current_url}")
            return current_url
        # PayPal "Your account is limited" 终态页：硬失败，立刻退出循环。
        # 实战截图：PayPal logo + "Your account is limited. Please check
        # your PayPal Account Overview page for information on how to
        # resolve this problem." + "Return to merchant" 按钮。
        # 通常根因是卡 BIN / IP / profile 被 PayPal 关联风控；继续等没意义。
        if _detect_paypal_account_limited(page):
            raise RuntimeError(
                "PayPal 拒付：账户被限制（Your account is limited），"
                "通常是卡 BIN / IP / profile 被风控，请更换"
            )
        if current_url and current_url != last_logged_url:
            log(f"等待跳回 chatgpt / pay.openai，当前页面: {current_url}")
            last_logged_url = current_url
        # 代理断流：页面落到 chrome-error 加载失败页，重新加载几次再继续
        if _is_page_load_error_url(current_url):
            _recover_page_load_if_errored(
                page, timeout_ms=int(timeout_ms), log=log, cancel_check=cancel_check
            )
            continue
        # PayPal /webapps/hermes 再次确认页：点 "Agree and Continue" 才能继续
        if _paypal_review_page_visible(page):
            try:
                _advance_paypal_review_if_needed(
                    page,
                    timeout_ms=int(timeout_ms),
                    log=log,
                    cancel_check=cancel_check,
                    turnstile_solver=turnstile_solver,
                )
            except Exception as exc:
                log(f"PayPal Agree and Continue 处理失败，继续等待: {exc}")
            continue
        # PayPal /agreements/approve 协议中间页
        if _is_paypal_intermediate_url(current_url):
            try:
                _advance_paypal_intermediate_pages(
                    page, timeout_ms=int(timeout_ms), log=log
                )
            except Exception as exc:
                log(f"PayPal 协议中间页处理失败，继续等待: {exc}")
            continue
        # 中途若再弹 security challenge，配了 solver 就自动求解，没配则静静等待
        # （不在这里 raise，避免单一 challenge 直接 fail 整个 checkout）
        if callable(turnstile_solver) and _has_security_challenge(page):
            try:
                _wait_for_manual_security_challenge(
                    page,
                    timeout_ms=120000,
                    log=log,
                    cancel_check=cancel_check,
                    turnstile_solver=turnstile_solver,
                )
            except Exception as exc:
                log(
                    f"等待跳回 chatgpt 期间 security challenge 求解失败，继续等待: {exc}"
                )
            continue
        try:
            page.wait_for_timeout(2000)
        except Exception:
            time.sleep(2)
    final_url = _current_page_url(page)
    raise RuntimeError(f"CTF sandbox 未跳回 chatgpt / pay.openai，当前页面: {final_url}")


def _complete_ctf_sandbox_flow(
    page,
    *,
    timeout_ms: int,
    log: Callable[[str], None],
    cancel_check: Callable[[], bool] | None = None,
    billing_profile: Optional[dict] = None,
    turnstile_solver: Callable[..., str] | None = None,
    sms_pool: Optional[list[dict]] = None,
    phone_swap_callback: Optional[Callable[[str], Optional[dict]]] = None,
) -> dict:
    def _raise_if_cancelled() -> None:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")

    _raise_if_cancelled()
    identity = _apply_billing_profile_to_ctf_identity(_generate_ctf_test_identity(), billing_profile)
    # 将任务 sms_pool（优先）或部署环境配置注入 identity。两者都没有时
    # 在触碰 hosted checkout 表单前 fail closed。
    pool_list = [entry for entry in (sms_pool or []) if isinstance(entry, dict)]
    if not pool_list and (CTF_PHONE_NUMBER or CTF_RELAY_CODE_URL):
        pool_list = [
            {
                "phone_e164": CTF_PHONE_NUMBER,
                "relay_url": CTF_RELAY_CODE_URL,
            }
        ]
    if pool_list:
        # 复用 payment_protocol 里同款 E.164 → 本地号实现，避免再写一份多国家码表。
        # lazy import：payment_protocol 也间接 import payment，模块顶部 import 会触发循环。
        from .payment_protocol import _local_phone_from_e164

        chosen = pool_list[0]
        phone_no_plus = str(chosen.get("phone") or "").strip()
        phone_e164 = str(
            chosen.get("phone_e164")
            or (phone_no_plus if phone_no_plus.startswith("+") else (f"+{phone_no_plus}" if phone_no_plus else ""))
        ).strip()
        relay_url = str(chosen.get("relay_url") or "").strip()
        # **关键**：CTF / PayPal mock 表单的 phone input 旁边已经有国家码选择器
        # （例如默认 +1）。如果把含国家码的 E.164 数字再次填入，浏览器会
        # 重复拼接国家码并触发 phone 校验失败；所以这里只填本地号。
        # phone_e164 / sms_relay_url 仍保留完整 E.164，给 OTP relay 轮询等不需要
        # 剥国家码的下游使用。
        phone_local = _local_phone_from_e164(phone_e164) or phone_no_plus
        if phone_local and relay_url:
            identity["phone"] = phone_local
            identity["phone_e164"] = phone_e164
            identity["sms_relay_url"] = relay_url
            log("Camoufox 已加载 sms_pool[0] 的手机号与 relay 配置")
        else:
            log("sms_pool[0] 缺少 phone 或 relay_url")
    else:
        log("Camoufox 未提供 sms_pool 或部署级 OTP 配置")
    _require_ctf_payment_configuration(identity)
    entry_url = _current_page_url(page)
    entry_label = "PayPal mock 页面" if _is_paypal_pay_create_url(entry_url) else "CTF sandbox 页面"
    log(f"进入 {entry_label} 创建账户流程，测试邮箱: {identity['email']}")
    if not _is_paypal_pay_create_url(entry_url):
        _wait_page_loaded(page, timeout_ms=timeout_ms, log=log, label=entry_label)
    _raise_if_cancelled()
    _open_ctf_create_account_and_continue(
        page,
        identity,
        log=log,
        cancel_check=cancel_check,
        turnstile_solver=turnstile_solver,
    )
    _wait_for_ctf_after_continue_ready(
        page,
        timeout_ms=timeout_ms,
        log=log,
        cancel_check=cancel_check,
        turnstile_solver=turnstile_solver,
    )
    _wait_page_loaded(page, timeout_ms=timeout_ms, log=log, label="CTF 创建页")

    # ============= SMS OTP 容错主循环（号码池轮换 + Resend 重试 + 拒号识别）=============
    #
    # **背景**：旧实现是 ``for attempt in range(3): _fill_form + _click_submit
    # + _fetch_code(single_attempt=True)``——拿不到 code 就**重新填整张 form
    # + 重新点 submit**。这条路径致命问题：
    #   1) PayPal 风控会判"同邮箱短时间二次注册" → OAS_ERROR 概率显著上升；
    #   2) ``single_attempt=True`` 一次性查 relay 不到就放弃，但 SMS 抵达延迟
    #      抖动 5-30s，第一次大概率是"短信还没到"——盲目重 submit 没意义；
    #   3) 永远只用 ``sms_pool[0]``，号码被 PayPal 拒了也不会换号。
    #
    # 新版主循环改成两层（用户原话）：
    #   * 外层 ``for pool_index in range(pool_size)``——遇到拒号就关 popup 换
    #     ``sms_pool[pool_index + 1]``。
    #   * 内层 ``for code_attempt in range(3)``——同一号最多 3 次拉 code，
    #     每次失败后只点 popup 上的 Resend 让 PayPal 重发 SMS（不重新填表
    #     /不重新 SignUp）。
    #   * 每次拉 code 前后都用 ``_detect_ctf_phone_rejected`` 探一下 popup，
    #     PayPal 有时连 SMS 都不发就出"Phone not supported"——这时立刻关
    #     popup 换下个号，省掉空等。
    #
    # ``pool_index == 0`` 复用外层已经注入的 identity（``_open_ctf_create_account_and_continue``
    # 也已经跑过）；``pool_index >= 1`` 才走"重注入新号 + 重填表 + 重 submit"。

    # lazy import：循环引用，参见外层 ``if pool_list`` 分支同款注释
    from .payment_protocol import _local_phone_from_e164

    pool_size = max(len(pool_list), 1)
    code = ""
    last_code_error: Exception | None = None
    rejected_pool_indexes: list[int] = []
    current_phone_exhausted = False

    pool_index = 0
    while pool_index < max(len(pool_list), 1):
        _raise_if_cancelled()

        if pool_index > 0:
            chosen = pool_list[pool_index]
            phone_no_plus = str(chosen.get("phone") or "").strip()
            phone_e164 = str(
                chosen.get("phone_e164") or (f"+{phone_no_plus}" if phone_no_plus else "")
            ).strip()
            relay_url = str(chosen.get("relay_url") or "").strip()
            phone_local = _local_phone_from_e164(phone_e164) or phone_no_plus
            if not (phone_local and relay_url):
                log(f"sms_pool[{pool_index}] 缺 phone/relay，跳过这条")
                rejected_pool_indexes.append(pool_index)
                pool_index += 1
                continue
            identity["phone"] = phone_local
            identity["phone_e164"] = phone_e164
            identity["sms_relay_url"] = relay_url
            log(
                f"切换到 sms_pool[{pool_index}] phone={phone_local} "
                f"(E.164 {phone_e164}) relay={relay_url[:48]}…"
            )

        log(f"填写 CTF sandbox 测试资料和付款信息 (pool[{pool_index}])")
        _run_step_with_retries(
            f"填写 CTF sandbox 测试资料和付款信息 pool[{pool_index}]",
            lambda: _fill_ctf_payment_form(page, identity, log=log),
            page=page,
            log=log,
            cancel_check=cancel_check,
        )
        _run_step_with_retries(
            f"提交 CTF 创建页并等待验证码弹窗 pool[{pool_index}]",
            lambda: _click_ctf_submit_until_code_popup(page, log=log),
            page=page,
            log=log,
            cancel_check=cancel_check,
        )

        # popup 弹出后立即扫一次拒号文案（PayPal 有时不发短信直接拒）
        rejected, reason = _detect_ctf_phone_rejected(page)
        if rejected:
            log(
                f"PayPal 拒绝 sms_pool[{pool_index}]: {reason}，关闭弹窗换号"
            )
            _close_ctf_popup_if_present(page, log=log)
            rejected_pool_indexes.append(pool_index)
            # 优先调上层提供的 swap callback 拿一个全局空闲号（多线程时是
            # 在跨 worker 的 slot 池里找）；callback 返回 None 表示池空，
            # 此时退化为继续 outer for 用 pool_list 里下一条（一般也无）。
            extra_entry = _request_swap_phone(
                phone_swap_callback,
                identity.get("phone_e164", ""),
                log=log,
            )
            if extra_entry:
                pool_list.append(extra_entry)
                pool_size = len(pool_list)
            last_code_error = RuntimeError(
                f"sms_pool[{pool_index}] 被 PayPal 拒绝: {reason}"
            )
            pool_index += 1
            continue

        # 首次等待原始短信；若没有新码，同一号最多点 3 次 Resend。
        max_resends = 3
        for code_attempt in range(0, max_resends + 1):
            _raise_if_cancelled()
            # 首次给 120s 等 SMS 抵达；Resend 后 30s 没有新码就判当前号失效。
            sub_timeout = 120 if code_attempt == 0 else 30
            try:
                code = _fetch_ctf_relay_code(
                    url=str(identity.get("sms_relay_url") or CTF_RELAY_CODE_URL),
                    timeout_seconds=sub_timeout,
                    log=log,
                    cancel_check=cancel_check,
                )
            except Exception as exc:
                last_code_error = exc
                code = ""
                log(
                    f"sms_pool[{pool_index}] 拉 code 第 {code_attempt + 1}/{max_resends + 1} "
                    f"次失败: {exc}"
                )
            if code:
                break

            # 没拿到 code：先扫一次拒号文案（短信延迟 → PayPal 后端超时 → 弹拒号）
            rejected, reason = _detect_ctf_phone_rejected(page)
            if rejected:
                log(
                    f"等待 sms_pool[{pool_index}] 验证码期间检测到拒号: "
                    f"{reason}，关闭弹窗换号"
                )
                _close_ctf_popup_if_present(page, log=log)
                rejected_pool_indexes.append(pool_index)
                extra_entry = _request_swap_phone(
                    phone_swap_callback,
                    identity.get("phone_e164", ""),
                    log=log,
                )
                if extra_entry:
                    pool_list.append(extra_entry)
                    pool_size = len(pool_list)
                last_code_error = RuntimeError(
                    f"sms_pool[{pool_index}] 等待 code 期间被拒: {reason}"
                )
                break

            # 不是拒号、就是 SMS 没到：点 popup 上 Resend 让 PayPal 重发。
            # Resend 前先 strip 一次——JP 流程等 SMS 期间 PayPal NGRL 异常
            # 检测常在这个空窗注入 reCAPTCHA authchallenge 浮层（#captchaComponent
            # / .ngrl-anomalydetection-div），盖住 popup 上的 Resend 按钮。
            if code_attempt < max_resends:
                _install_paypal_captcha_dom_stripper(page, log=log)
                if _click_ctf_resend_in_popup(page, log=log):
                    log(
                        f"已点击 Resend，继续等 sms_pool[{pool_index}] "
                        f"第 {code_attempt + 2}/{max_resends + 1} 次"
                    )
                else:
                    log(
                        f"popup 上未找到 Resend 按钮，放弃 sms_pool[{pool_index}]，"
                        f"关弹窗换下条号"
                    )
                    _close_ctf_popup_if_present(page, log=log)
                    current_phone_exhausted = True
                    break
            else:
                current_phone_exhausted = True
                log(
                    f"sms_pool[{pool_index}] 点击 Resend 3 次后仍未获取新验证码，"
                    "标记当前号码失效"
                )
                _close_ctf_popup_if_present(page, log=log)

        if code:
            break
        pool_index += 1

    if not code:
        msg = (
            f"耗尽 sms_pool {pool_size} 条号码仍未获取验证码 "
            f"(失败 indexes={rejected_pool_indexes})"
        )
        if current_phone_exhausted and not rejected_pool_indexes:
            msg = f"SMS_PHONE_EXHAUSTED: {msg}"
        else:
            # 标记错误类型让上层（前端 / task 层）能区分"全局号池不可用"和其它失败。
            # ``SMS_POOL_EXHAUSTED`` 前缀供 application 层 grep 识别并停止投新任务。
            msg = f"SMS_POOL_EXHAUSTED: {msg}"
        if last_code_error is not None:
            raise RuntimeError(f"{msg}: {last_code_error}") from last_code_error
        raise RuntimeError(msg)
    log("填写 PayPal 6 位验证码")
    _run_step_with_retries(
        "填写 PayPal 6 位验证码",
        lambda: _fill_ctf_verification_code(page, code, log=log),
        page=page,
        log=log,
        progressed=lambda: _is_chatgpt_success_url(_current_page_url(page)),
        cancel_check=cancel_check,
        progressed_log="检测到页面已跳回 chatgpt / pay.openai,跳过重复填写验证码",
    )

    # OTP 提交校验失败重试：实战日志多次出现 "Sorry, something went wrong.
    # Get a new code." —— 表示 PayPal 后端拒绝了 OTP（短信晚到 / 已过期 /
    # 被错误识别）。处理方式跟拉 code 阶段对称：popup 上点 Resend → 重新
    # 拉 code → 重新填。最多 3 次（加上首次填，总共最多 4 次提交）。
    otp_validation_attempts = 3
    for otp_attempt in range(1, otp_validation_attempts + 1):
        _raise_if_cancelled()
        wait_deadline = time.monotonic() + 8
        otp_failed = False
        while time.monotonic() <= wait_deadline:
            _raise_if_cancelled()
            if _is_chatgpt_success_url(_current_page_url(page)) or _paypal_review_page_visible(page):
                break
            if _detect_ctf_otp_error(page):
                otp_failed = True
                break
            try:
                page.wait_for_timeout(1000)
            except Exception:
                time.sleep(1)
        if not otp_failed:
            break
        log(
            f"检测到 OTP 校验失败提示，第 {otp_attempt}/{otp_validation_attempts} 次"
            "尝试 Resend 重新拉 code"
        )
        if not _click_ctf_resend_in_popup(page, log=log):
            log("popup 上未找到 Resend 按钮，停止 OTP 重试")
            break
        try:
            new_code = _fetch_ctf_relay_code(
                url=str(identity.get("sms_relay_url") or CTF_RELAY_CODE_URL),
                timeout_seconds=30,
                log=log,
                cancel_check=cancel_check,
                excluded_pins={code},
            )
        except Exception as exc:
            log(f"OTP Resend 后拉 code 失败：{exc}")
            _close_ctf_popup_if_present(page, log=log)
            raise RuntimeError(
                "SMS_PHONE_EXHAUSTED: OTP Resend 后 30s 未获取到新验证码，当前号码失效"
            ) from exc
        if not new_code:
            log("OTP Resend 后未拉到新 code，停止 OTP 重试")
            _close_ctf_popup_if_present(page, log=log)
            raise RuntimeError(
                "SMS_PHONE_EXHAUSTED: OTP Resend 后 30s 未获取到新验证码，当前号码失效"
            )
        code = new_code
        log(f"OTP Resend 已拿到新 code，重新填写（第 {otp_attempt + 1} 次）")
        try:
            _fill_ctf_verification_code(page, code, log=log)
        except Exception as exc:
            log(f"OTP Resend 后重新填 code 失败：{exc}")
            break

    _advance_paypal_review_if_needed(
        page,
        timeout_ms=timeout_ms,
        log=log,
        cancel_check=cancel_check,
        turnstile_solver=turnstile_solver,
    )
    final_url = _run_step_with_retries(
        "等待页面跳回 chatgpt",
        lambda: _wait_for_chatgpt_return(
            page,
            timeout_ms=timeout_ms,
            log=log,
            cancel_check=cancel_check,
            turnstile_solver=turnstile_solver,
        ),
        page=page,
        log=log,
        cancel_check=cancel_check,
    )
    return {
        "ok": True,
        "status": "ctf_completed",
        "final_url": final_url,
        "email": identity["email"],
    }


def _resolve_checkout_hold_seconds(*, headless: bool, hold_seconds: Optional[int]) -> int:
    if hold_seconds is not None:
        return max(int(hold_seconds), 0)
    return 0 if headless else 10


def _hold_checkout_browser(
    page,
    *,
    headless: bool,
    hold_seconds: Optional[int],
    log: Callable[[str], None],
    cancel_check: Callable[[], bool] | None = None,
) -> None:
    seconds = _resolve_checkout_hold_seconds(headless=headless, hold_seconds=hold_seconds)
    if seconds <= 0:
        return
    log(f"前台调试模式保留浏览器 {seconds} 秒，之后自动关闭")
    if not callable(cancel_check):
        time.sleep(seconds)
        return
    for _ in range(seconds):
        if cancel_check():
            log("收到终止请求，关闭 Camoufox 浏览器")
            return
        time.sleep(1)
    if cancel_check():
        log("收到终止请求，关闭 Camoufox 浏览器")


def _is_camoufox_geoip_extra_error(exc: Exception) -> bool:
    text = str(exc or "").lower()
    return "geoip extra" in text or "camoufox[geoip]" in text


def _camoufox_geoip_extra_available() -> bool:
    try:
        from camoufox.locale import ALLOW_GEOIP

        return bool(ALLOW_GEOIP)
    except Exception:
        return False


def _enter_camoufox_browser(
    launch_opts: dict,
    log: Callable[[str], None],
    backend_config: Optional[BrowserBackendConfig] = None,
):
    """启动浏览器后端并返回 ``(context_manager, browser)``。

    历史名字保留 ``camoufox``，但实际按 ``backend_config.backend`` 分发：
        * ``backend_config is None`` → Camoufox（默认，兼容老调用方 / 单测）
        * ``backend_config.is_bitbrowser`` → BitBrowserContext
        * ``backend_config.is_camoufox`` → Camoufox（与 None 等价，但显式）

    BitBrowser 路径下 ``launch_opts`` 大部分键被忽略（profile 已经预设
    指纹/代理/locale 等）；只有 ``window_mode`` 通过 ``backend_config``
    传，``open_browser_backend`` dispatcher 内部拼成 Chromium ``--headless``
    / ``--window-position`` flag。
    """
    if backend_config is None:
        backend_config = BrowserBackendConfig.camoufox(
            headless=bool(launch_opts.get("headless"))
        )
    try:
        browser_context = open_browser_backend(
            launch_opts=launch_opts,
            config=backend_config,
            camoufox_class=Camoufox,
            log=log,
        )
        return browser_context, browser_context.__enter__()
    except Exception as exc:
        # geoip extra 报错只在 Camoufox 路径有意义；BitBrowser 不依赖它。
        if (
            backend_config.is_camoufox
            and launch_opts.get("geoip")
            and _is_camoufox_geoip_extra_error(exc)
        ):
            raise RuntimeError(
                "Camoufox geoip extra 未安装，请执行: pip install camoufox[geoip]"
            ) from exc
        raise


def _collect_camoufox_fingerprint_hash(page) -> str:
    evaluate = getattr(page, "evaluate", None)
    if not callable(evaluate):
        return ""
    try:
        payload = evaluate(
            """() => {
                const readWebgl = () => {
                    try {
                        const canvas = document.createElement("canvas");
                        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
                        if (!gl) return {};
                        const info = gl.getExtension("WEBGL_debug_renderer_info");
                        return {
                            vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
                            renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
                        };
                    } catch (error) {
                        return {error: String(error)};
                    }
                };
                const readCanvas = () => {
                    try {
                        const canvas = document.createElement("canvas");
                        canvas.width = 120;
                        canvas.height = 32;
                        const ctx = canvas.getContext("2d");
                        ctx.textBaseline = "top";
                        ctx.font = "16px Arial";
                        ctx.fillStyle = "#f60";
                        ctx.fillRect(0, 0, 120, 32);
                        ctx.fillStyle = "#069";
                        ctx.fillText("camoufox", 4, 6);
                        return canvas.toDataURL();
                    } catch (error) {
                        return String(error);
                    }
                };
                return {
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    hardwareConcurrency: navigator.hardwareConcurrency,
                    deviceMemory: navigator.deviceMemory || null,
                    language: navigator.language,
                    languages: navigator.languages,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    webdriver: navigator.webdriver,
                    screen: {
                        width: screen.width,
                        height: screen.height,
                        availWidth: screen.availWidth,
                        availHeight: screen.availHeight,
                        colorDepth: screen.colorDepth,
                        pixelDepth: screen.pixelDepth
                    },
                    window: {
                        innerWidth: window.innerWidth,
                        innerHeight: window.innerHeight,
                        outerWidth: window.outerWidth,
                        outerHeight: window.outerHeight,
                        devicePixelRatio: window.devicePixelRatio
                    },
                    webgl: readWebgl(),
                    canvas: readCanvas()
                };
            }"""
        )
        raw = json.dumps(payload, sort_keys=True, ensure_ascii=True, default=str)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()
    except Exception:
        return ""


def _remember_camoufox_fingerprint_hash(fingerprint_hash: str) -> bool:
    if not fingerprint_hash:
        return True
    with _CAMOUFOX_FINGERPRINT_LOCK:
        if fingerprint_hash in _CAMOUFOX_FINGERPRINT_HASHES:
            return False
        _CAMOUFOX_FINGERPRINT_HASHES.append(fingerprint_hash)
        overflow = len(_CAMOUFOX_FINGERPRINT_HASHES) - _CAMOUFOX_FINGERPRINT_LIMIT
        if overflow > 0:
            del _CAMOUFOX_FINGERPRINT_HASHES[:overflow]
        return True


def _close_camoufox_context(browser_context) -> None:
    try:
        browser_context.__exit__(None, None, None)
    except Exception:
        pass


def _new_camoufox_page(
    browser,
    *,
    record_har_path: Optional[str] = None,
    record_har_url_filter: str = "**/*",
):
    """创建 Camoufox 页面；当 record_har_path 给定时，使用带 HAR 录制的 BrowserContext。"""
    if record_har_path:
        context = browser.new_context(
            record_har_path=record_har_path,
            record_har_url_filter=record_har_url_filter,
        )
        return context.new_page()
    return browser.new_page()


def _open_unique_camoufox_page(
    launch_opts: dict,
    *,
    log: Callable[[str], None],
    browser_timeout: int,
    max_attempts: int = 3,
    record_har_path: Optional[str] = None,
    record_har_url_filter: str = "**/*",
    backend_config: Optional[BrowserBackendConfig] = None,
):
    """启动浏览器 + 创建 page。

    Camoufox 路径：每次 ``__enter__`` 生成的指纹是新的，会做"连续 3 次生成
    出重复指纹则 raise"的去重，避免 Camoufox 内部 RNG 出现退化。

    BitBrowser 路径：profile 固定指纹是**故意设计**——用户养号、cookie
    持久化、hCaptcha 风险评分都依赖每次都用同一个指纹的 profile。这条
    路径直接返回首次启动的 page，跳过去重逻辑。
    """
    # 走 BitBrowser：单次启动，不去重。
    if backend_config is not None and backend_config.is_bitbrowser:
        browser_context = None
        try:
            browser_context, browser = _enter_camoufox_browser(
                launch_opts, log, backend_config
            )
            page = _new_camoufox_page(
                browser,
                record_har_path=record_har_path,
                record_har_url_filter=record_har_url_filter,
            )
            page.set_default_timeout(browser_timeout)
            _arm_paypal_captcha_stripper_on_navigations(page, log=log)
            _arm_autocomplete_suppressor_on_navigations(page, log=log)
            log("BitBrowser profile 已就绪，跳过指纹去重（profile 指纹固定）")
            return browser_context, browser, page
        except Exception:
            if browser_context is not None:
                _close_camoufox_context(browser_context)
            raise

    # Camoufox 路径：原有去重逻辑保持不变。
    last_hash = ""
    for attempt in range(1, max(int(max_attempts or 1), 1) + 1):
        browser_context = None
        try:
            browser_context, browser = _enter_camoufox_browser(
                launch_opts, log, backend_config
            )
            page = _new_camoufox_page(
                browser,
                record_har_path=record_har_path,
                record_har_url_filter=record_har_url_filter,
            )
            page.set_default_timeout(browser_timeout)
            # **GuJumpgate 同款 content-script 行为**：在 page 一创建时就 arm
            # PayPal captcha DOM stripper 的 init_script。这样后续每个
            # navigate（包括跳到 Stripe / PayPal hosted checkout 的子页）都会
            # 在 PayPal 自家 JS 跑**之前**先装好 MutationObserver，赶在
            # captcha overlay 出现的瞬间删除。
            _arm_paypal_captcha_stripper_on_navigations(page, log=log)
            _arm_autocomplete_suppressor_on_navigations(page, log=log)
            fingerprint_hash = _collect_camoufox_fingerprint_hash(page)
            if not fingerprint_hash:
                log("Camoufox 指纹摘要获取失败，继续使用当前浏览器")
                return browser_context, browser, page
            if _remember_camoufox_fingerprint_hash(fingerprint_hash):
                log(f"Camoufox 指纹摘要: {fingerprint_hash[:12]}")
                return browser_context, browser, page
            last_hash = fingerprint_hash
            log(f"Camoufox 指纹摘要重复: {fingerprint_hash[:12]}，重新生成浏览器 ({attempt}/{max_attempts})")
        except Exception:
            if browser_context is not None:
                _close_camoufox_context(browser_context)
            raise
        if browser_context is not None:
            _close_camoufox_context(browser_context)
    raise RuntimeError(f"Camoufox 连续生成重复指纹: {last_hash[:12]}")


def _is_transient_page_navigation_error(exc: BaseException) -> bool:
    """判断 Playwright page.goto 抛错是否属于可重试的瞬时网络断连。"""
    msg = str(exc or "").lower()
    return any(
        token in msg
        for token in (
            "err_socks_connection_failed",
            "err_timed_out",
            "err_connection_reset",
            "err_connection_closed",
            "err_proxy_connection_failed",
            "err_tunnel_connection_failed",
            "err_empty_response",
        )
    )


def complete_paypal_checkout(
    *,
    checkout_url: str,
    cookies_str: Optional[str] = None,
    proxy: Optional[str] = None,
    email: str = "",
    payment_method: str = "paypal",
    headless: bool = False,
    timeout: int = 180,
    hold_seconds: Optional[int] = None,
    log_fn: Callable[[str], None] = print,
    cancel_check: Callable[[], bool] | None = None,
    turnstile_solver: Callable[..., str] | None = None,
    record_har_path: Optional[str] = None,
    sms_pool: Optional[list[dict]] = None,
    backend_config: Optional[BrowserBackendConfig] = None,
    phone_swap_callback: Optional[Callable[[str], Optional[dict]]] = None,
    address_region: str = "US",
    existing_page: Optional[Any] = None,
) -> dict:
    log = log_fn or (lambda message: logger.info(message))
    # 短链物理复用：existing_page 非空时，不自建浏览器，直接在注册用的同一个
    # page 上跑 PayPal checkout（短链是 ChatGPT 托管页、URL 无 token，必须用
    # 已登录浏览器打开）。此时浏览器生命周期由调用方（注册流程）管，本函数
    # 不开也不关浏览器，也不注入 cookie / 不跑代理出口检测（同一会话已登录）。
    own_browser = existing_page is None
    # 没显式传 backend_config 时按 headless flag 走 Camoufox（保持
    # 老调用方/单测的行为）。BitBrowser 路径必须显式构造 backend_config。
    if backend_config is None:
        backend_config = BrowserBackendConfig.camoufox(headless=bool(headless))
    if backend_config.is_bitbrowser:
        log(
            f"使用 BitBrowser backend (profile={backend_config.bit_profile_id}, "
            f"window_mode={backend_config.window_mode})"
        )
    def _raise_if_cancelled() -> None:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")

    page = None
    if str(payment_method or "").strip().lower() != "paypal":
        return {
            "ok": False,
            "status": "failed",
            "final_url": checkout_url,
            "error": f"不支持的支付方式: {payment_method}",
        }
    if record_har_path:
        try:
            Path(record_har_path).parent.mkdir(parents=True, exist_ok=True)
            log(f"已启用 HAR 录制: {record_har_path}")
        except Exception as exc:
            log(f"HAR 录制目录创建失败，跳过录制: {exc}")
            record_har_path = None
    try:
        _raise_if_cancelled()
        if backend_config.is_camoufox and Camoufox is None:
            raise RuntimeError(
                "Camoufox 不可用，请先安装并执行 python -m camoufox fetch"
            )
        _patch_playwright_firefox_pageerror_location_bug(log_fn=log)
        _raise_if_cancelled()
        # address_region 决定走 ``/`` (US) 还是 ``/jp-address`` (JP)；其它值
        # fallback 到 US，保持老调用方语义不变。
        # 向下兼容：region=US 时仍调用 ``fetch_us_billing_address``，因为大量
        # 测试用 ``monkeypatch.setattr(..., "fetch_us_billing_address", ...)``
        # 替换；如果改走 ``fetch_billing_address``，这些 monkeypatch 不生效。
        region_norm = str(address_region or "US").strip().upper() or "US"
        if region_norm == "US":
            address = fetch_us_billing_address(email=email)
        else:
            address = fetch_billing_address(region_norm, email=email)
        log(f"已加载账单资料: region={address.get('country', '?')}")
        _raise_if_cancelled()
        browser_timeout = max(int(timeout or 180), 30) * 1000
        direct_paypal_authorize_start = _is_paypal_authorize_start_url(checkout_url)
        if backend_config.is_bitbrowser:
            # BitBrowser 路径：profile 已经在 GUI 里配好指纹/代理/UA/locale，
            # launch_opts 里这些 Camoufox 参数全部不会被读到。
            # window_mode 通过 backend_config 走，headless 字段也只是给
            # 业务下游判断 hold_browser 用，不再传 Chromium。
            launch_opts = {"headless": backend_config.is_headless}
        else:
            launch_opts = {
                "headless": bool(headless),
                "addons": [],
                "persistent_context": False,
                # PayPal / Akamai 反检测关键配置
                # NOTE: humanize 原为 True（人化鼠标轨迹），但 PayPal 新版风控对
                # 连续曲线过于规整的“伪人手”轨迹反而更敏感，AtomicWait 会锁住按钮
                # 使用者看到“create an account / Continue to Payment 点不动”的现象。
                # 改为 False 后点击走 Playwright 原生发送，反而避开这类检测。
                "humanize": False,                  # 关闭鼠标轨迹人化（避免 PayPal AtomicWait 锁死按钮）
                "block_webrtc": True,               # 阻止 WebRTC 泄漏本机 IP，否则与代理出口 IP 不一致
                "locale": ["en-US", "en"],          # 显式锁 US 英语，geoip 失败时不退回 zh-CN
                "os": ("windows", "macos"),         # 限制为住宅 IP 上常见的桌面操作系统
            }
            if DefaultAddons is not None:
                launch_opts["exclude_addons"] = [DefaultAddons.UBO]
            log("Camoufox 使用临时干净 profile，已禁用默认 uBlock Origin 扩展")
            log("Camoufox 反检测: humanize=False, block_webrtc=True, locale=en-US, os=(windows, macos)")
            proxy_config = _build_camoufox_proxy(proxy)
            if proxy_config:
                launch_opts["proxy"] = proxy_config
                launch_opts["geoip"] = True
                log("Camoufox geoip 已启用，将按代理出口同步地理位置/语言/时区")
                log(f"Camoufox 启动代理: {_mask_proxy(proxy)}")
                if proxy_config.get("username") and proxy_config.get("password"):
                    log("Camoufox 代理认证: 已配置用户名/密码")
                else:
                    log("Camoufox 代理认证: 未配置认证")
            else:
                log("Camoufox 启动代理: 未配置")
        browser_context = None
        try:
            if own_browser:
                browser_context, browser, page = _open_unique_camoufox_page(
                    launch_opts,
                    log=log,
                    browser_timeout=browser_timeout,
                    max_attempts=3,
                    record_har_path=record_har_path,
                    backend_config=backend_config,
                )
            else:
                # 短链物理复用：直接用注册流程传进来的 page，不自建浏览器。
                page = existing_page
                log("短链复用：在注册浏览器的同一 page 上执行 PayPal checkout（不另开浏览器）")
            _raise_if_cancelled()
            try:
                # 命中"成功跳回 chatgpt.com / pay.openai.com"后立刻关浏览器，
                # 跳过 hold_seconds 等待（用户诉求：成功立即关窗）。
                # finally 块通过这个 flag 决定是否跳过 hold。
                #
                # 必须在 ``page.goto`` / 出口检测之前初始化——否则代理拨号
                # 失败 (ERR_SOCKS_CONNECTION_FAILED) 等早期异常会绕过原来
                # 的初始化点，下面 finally / except 读 flag 时报
                # UnboundLocalError。
                checkout_finished_success: dict = {"value": False}
                _raise_if_cancelled()
                # BitBrowser 路径：profile 自己持久化 cookie/storage（这正是
                # 用 BitBrowser 的核心动机），代理也由 profile 内置；外层既
                # 不应再注入 ChatGPT cookies（Chromium 对 cookie domain/secure
                # 校验比 Firefox 严，``Storage.setCookies`` 会因 ``Invalid
                # cookie fields`` 直接报错），也不应跑代理出口检测（业务诉求
                # 是"BitBrowser 阶段直接打开付款链接"）。
                if not own_browser:
                    # 短链复用：同一浏览器已登录 ChatGPT，无需注入 cookie / 探代理。
                    proxy_check = {"ok": True, "ip": "", "source": "reuse"}
                    log("短链复用：跳过 cookie 注入与代理出口检测（同会话已登录）")
                elif backend_config.is_bitbrowser:
                    proxy_check = {"ok": True, "ip": "", "source": "bitbrowser"}
                    log("BitBrowser 模式：跳过代理出口检测与 cookie 注入，直接打开付款链接")
                else:
                    proxy_check = _probe_camoufox_proxy_exit(page, log=log)
                    _raise_if_cancelled()
                    if cookies_str:
                        page.context.add_cookies(_parse_cookie_str(cookies_str, "chatgpt.com"))
                        log("ChatGPT cookies 已注入 Camoufox")
                log("打开 ChatGPT 测试支付链接")
                last_nav_exc: Exception | None = None
                for nav_attempt in range(1, 4):
                    try:
                        page.goto(checkout_url, wait_until="domcontentloaded", timeout=browser_timeout)
                        last_nav_exc = None
                        break
                    except Exception as exc:  # noqa: BLE001 - 按错误内容判定是否重试
                        last_nav_exc = exc
                        if nav_attempt >= 3 or not _is_transient_page_navigation_error(exc):
                            raise
                        backoff = 1.5 * nav_attempt
                        log(
                            f"打开 ChatGPT 测试支付链接瞬时网络失败（第 {nav_attempt}/3 次，"
                            f"{backoff}s 后重试）: {exc}"
                        )
                        time.sleep(backoff)
                        _raise_if_cancelled()
                if last_nav_exc is not None:
                    raise last_nav_exc
                _raise_if_cancelled()
                if direct_paypal_authorize_start:
                    log("PayPal 授权长链接接管：跳过 pay.openai.com checkout 页，直接进入 PayPal 自动填写流程")
                else:
                    _wait_checkout_page_ready(page, timeout_ms=browser_timeout, log=log)
                    _raise_if_cancelled()
                    # 金额校验（Plus 免费试用专用）：要求"今日应付金额 == 0"，
                    # 否则说明这个号没有 Plus 免费试用资格，立即弃号换号——继续
                    # 走完流程也是真扣钱，浪费 PayPal 配额。错误前缀
                    # ``PLUS_CHECKOUT_NON_FREE_TRIAL::`` 给下面 except 用来识别
                    # "硬失败立即关浏览器"分支。
                    _verify_checkout_is_free_trial(page, log=log)
                _raise_if_cancelled()
                max_submit_attempts = 3

                def _check_final_success() -> bool:
                    """轮询当前 active page 看是否已跳回 chatgpt / pay.openai。

                    支付链接最终目的页是 chatgpt.com 或 pay.openai.com。
                    命中其一即可终结流程，不必再走 CTF sandbox / PayPal review。
                    """
                    try:
                        active = _pick_active_page(page)
                    except Exception:
                        active = page
                    return _is_chatgpt_success_url(_current_page_url(active))

                def _finish_checkout_progress(attempt: int) -> dict:
                    _raise_if_cancelled()
                    redirected_url = _current_page_url(page, checkout_url)
                    # **早退**：若直接跳到了 chatgpt.com / pay.openai.com，整个
                    # PayPal 子流程不必再跑（CTF sandbox / 协议确认 / SMS 都跳过）。
                    # 这是终极成功条件，命中即置 flag 让 finally 跳过 hold。
                    if _is_chatgpt_success_url(redirected_url):
                        log(f"已跳回 chatgpt / pay.openai，checkout 完成: {redirected_url}")
                        checkout_finished_success["value"] = True
                        return {
                            "ok": True,
                            "status": "completed",
                            "final_url": redirected_url,
                            "error": "",
                            "proxy_check": proxy_check,
                            "attempts": attempt,
                        }
                    if _is_paypal_intermediate_url(redirected_url):
                        redirected_url = _advance_paypal_intermediate_pages(
                            page,
                            timeout_ms=browser_timeout,
                            log=log,
                        )
                    if _is_ctf_sandbox_url(redirected_url) or _is_paypal_pay_create_url(redirected_url):
                        ctf_result = _complete_ctf_sandbox_flow(
                            page,
                            timeout_ms=browser_timeout,
                            log=log,
                            cancel_check=cancel_check,
                            billing_profile=address,
                            turnstile_solver=turnstile_solver,
                            sms_pool=sms_pool,
                            phone_swap_callback=phone_swap_callback,
                        )
                        # CTF sandbox 内部最后一步是 _wait_for_chatgpt_return，
                        # 已经命中 chatgpt / pay.openai 才会出来，这里同样置 flag。
                        if _is_chatgpt_success_url(ctf_result.get("final_url", "")):
                            checkout_finished_success["value"] = True
                        return {
                            "ok": True,
                            "status": "ctf_completed",
                            "final_url": ctf_result["final_url"],
                            "error": "",
                            "proxy_check": proxy_check,
                            "attempts": attempt,
                            "ctf_sandbox": ctf_result,
                        }
                    # PayPal 强制登录页：``/agreements/approve`` Agree 之后
                    # 跳到 ``/signin?intent=checkout&...&returnUri=/webapps/hermes&...``。
                    # **不要直接弃号**——美区 / 日区这个 signin 页底部都有
                    # "创建账户 / 新規登録 / Sign Up" 入口，点它即可进入 guest
                    # 创建流程（和 ``/checkoutweb/signup`` 同一套表单）。先探测
                    # 并尝试进入创建流程；只有当 signin 页确实没有任何注册入口
                    # （纯密码登录）时，才判终态硬失败弃号换 worker。
                    if _is_paypal_signin_required_url(redirected_url):
                        # signin SPA 是异步渲染的。**不要**因为没探到"创建账户"
                        # 按钮就弃号——``_enter_signup_from_paypal_signin`` 首选
                        # 从 URL 抽 ba_token/ec_token 直达 ``/checkoutweb/signup``
                        # 表单（不依赖按钮渲染/文案），按钮点击只是兜底。
                        _wait_page_loaded(
                            page, timeout_ms=browser_timeout, log=log, label="PayPal signin 页"
                        )
                        if _enter_signup_from_paypal_signin(
                            page,
                            timeout_ms=browser_timeout,
                            log=log,
                        ):
                            ctf_result = _complete_ctf_sandbox_flow(
                                page,
                                timeout_ms=browser_timeout,
                                log=log,
                                cancel_check=cancel_check,
                                billing_profile=address,
                                turnstile_solver=turnstile_solver,
                                sms_pool=sms_pool,
                                phone_swap_callback=phone_swap_callback,
                            )
                            if _is_chatgpt_success_url(ctf_result.get("final_url", "")):
                                checkout_finished_success["value"] = True
                            return {
                                "ok": True,
                                "status": "ctf_completed",
                                "final_url": ctf_result["final_url"],
                                "error": "",
                                "proxy_check": proxy_check,
                                "attempts": attempt,
                                "ctf_sandbox": ctf_result,
                            }
                        # 直达 + 点按钮都没进去：dump 页面控件再硬失败，便于定位
                        log("signin 页直达 signup 与点击创建入口均失败，dump 当前页面可点控件：")
                        try:
                            _dump_page_clickables(page, log=log)
                        except Exception as exc:
                            log(f"dump signin 页控件失败（忽略）: {exc}")
                        checkout_finished_success["value"] = True
                        raise RuntimeError(
                            "PayPal 强制登录页（PAYPAL_SIGNIN_REQUIRED）："
                            f"{redirected_url} —— 无法进入 guest 创建流程，"
                            "当前账号被 PayPal 风控要求登录账号才能继续，弃号换 worker 重试"
                        )
                    return {
                        "ok": True,
                        "status": (
                            "completed"
                            if _is_chatgpt_success_url(redirected_url)
                            else "submitted"
                        ),
                        "final_url": redirected_url,
                        "error": "",
                        "proxy_check": proxy_check,
                        "attempts": attempt,
                    }

                # Stage 早退：``page.goto`` 之后偶尔已经直接在 chatgpt.com /
                # pay.openai.com（cookie 还在 + 链接已激活），整个 PayPal
                # 子流程不必再跑。这里复用 GuJumpgate 的"DOM 决定下一步"
                # 范式——``detect_paypal_stage`` 综合 host + DOM 特征，比
                # 单看 url 模板更稳。
                stage_info = detect_paypal_stage(page)
                early_stage = str(stage_info.get("stage", _STAGE_UNKNOWN))
                if early_stage == _STAGE_CHATGPT_SUCCESS:
                    log(f"page.goto 后已在成功页（stage={early_stage}），跳过 PayPal 流程")
                    return _finish_checkout_progress(0)
                if early_stage in _PAYPAL_STAGE_TERMINAL_FAIL:
                    raise RuntimeError(
                        f"PayPal 终态失败页（stage={early_stage}, "
                        f"host={stage_info.get('host', '')}, pathname={stage_info.get('pathname', '')}）"
                    )
                if direct_paypal_authorize_start:
                    return _finish_checkout_progress(0)

                # 短链物理复用（existing_page 非空 → own_browser=False）：
                # ChatGPT 官方更新了 checkout 页（custom UI），旧的"选 PayPal
                # 支付方式 / 填账单 / 点订阅"主动脚本选择器已全部失效（实测连续
                # 3 次"未找到 PayPal 支付方式"）。按用户要求：短链复用时**不要**
                # 在 checkout 页跑这套主动脚本，改成纯被动轮询——等页面（人工在
                # headed 浏览器里点、或页面自身逻辑）跳进 PayPal 创建页 / 中间页 /
                # CTF sandbox，再交给既有的 _finish_checkout_progress 走后续
                # PayPal guest 创建流程。
                if not own_browser:
                    log(
                        "短链复用：跳过 checkout 页主动脚本（选 PayPal / 填账单 / 点订阅），"
                        "改为被动轮询等待进入 PayPal 创建页"
                    )
                    poll_deadline = time.monotonic() + max(browser_timeout, 30000) / 1000
                    poll_interval = 3.0
                    while time.monotonic() <= poll_deadline:
                        _raise_if_cancelled()
                        if _checkout_url_progressed(page, checkout_url):
                            cur = _current_page_url(page, checkout_url)
                            log(f"短链复用：检测到已进入 PayPal 创建页 / 下一步: {cur}")
                            return _finish_checkout_progress(1)
                        try:
                            page.wait_for_timeout(int(poll_interval * 1000))
                        except Exception:
                            time.sleep(poll_interval)
                    raise RuntimeError(
                        "短链复用：等待进入 PayPal 创建页超时，仍停在 "
                        f"{_current_page_url(page, checkout_url)}"
                    )

                for attempt in range(1, max_submit_attempts + 1):
                    _raise_if_cancelled()
                    if _checkout_url_progressed(page, checkout_url):
                        log("检测到页面已进入 checkout 下一步，跳过重复 checkout 操作")
                        return _finish_checkout_progress(attempt)
                    log(f"checkout 操作第 {attempt}/{max_submit_attempts} 次")
                    log("选择 PayPal 支付方式")
                    progressed_marker = object()
                    paypal_result = _run_step_with_retries(
                        "选择 PayPal 支付方式",
                        lambda: _try_click_paypal(page),
                        page=page,
                        log=log,
                        cancel_check=cancel_check,
                        progressed=lambda: _checkout_flow_progressed(page, checkout_url),
                        progressed_value=lambda: progressed_marker,
                        progressed_log="检测到页面已进入 checkout 下一步，跳过选择 PayPal 重试",
                    )
                    if paypal_result is progressed_marker:
                        return _finish_checkout_progress(attempt)
                    log("已选择 PayPal 支付方式")
                    # PayPal 选中后账单信息表单是动态加载的，需要等渲染完
                    # 才能真正 fill。原来是选完 PayPal 立刻 fill，太快导致
                    # 多个 locator 还没出现就被默默跳过，后续提交报字段缺失。
                    _wait_checkout_billing_form_ready(
                        page, timeout_ms=browser_timeout, log=log
                    )
                    region_label = "日本" if address.get("country") == "JP" else "美国"
                    # 账单自动填写已停用：ChatGPT 官方更新了账单页结构，旧的字段
                    # 选择器已失效，自动填只会反复未命中拖时间甚至填错。改成不
                    # 自动填，由人工在浏览器里补（或后续按新页面结构重写选择器）。
                    # 如需恢复，取消下面 _run_step_with_retries 那段注释。
                    log(f"账单自动填写已停用（官方页面更新），跳过{region_label}账单自动填写")
                    # _run_step_with_retries(
                    #     f"填写{region_label}账单信息",
                    #     lambda: _fill_billing_until_complete(
                    #         page, address, max_attempts=3, log=log
                    #     ),
                    #     page=page,
                    #     log=log,
                    #     cancel_check=cancel_check,
                    # )
                    # 上面循环已尽力填到完整，但仍可能剩缺失字段（locator
                    # 一直找不到 / Stripe 重渲染冲掉）。点击订阅前再做一次
                    # 显式快照校验：缺啥就 log 啥，不阻塞——让用户在日志里
                    # 直观看到"哪个字段没填上"，方便复盘失败原因。
                    final_missing = _billing_required_missing(page, address, log=log)
                    if final_missing:
                        log(
                            f"账单字段最终校验：仍缺失 {','.join(final_missing)}，"
                            "继续提交（Stripe 端报错时按报错信息处理）"
                        )
                    else:
                        log("账单字段最终校验：全部填写完整")
                    log("勾选同意协议")
                    terms_checked = _run_step_with_retries("勾选同意协议", lambda: _accept_checkout_terms(page), page=page, log=log, cancel_check=cancel_check)
                    if terms_checked:
                        log("已勾选同意协议")
                    else:
                        log("未找到同意协议勾选框，继续提交")
                    log("点击最终订阅按钮")
                    _run_step_with_retries(
                        "点击最终订阅按钮",
                        lambda: _click_subscribe_button_burst(page, checkout_url=checkout_url, log=log),
                        page=page,
                        log=log,
                        cancel_check=cancel_check,
                    )
                    _raise_if_cancelled()
                    if _wait_for_checkout_redirect(
                        page,
                        checkout_url=checkout_url,
                        timeout_ms=browser_timeout,
                        log=log,
                    ):
                        return _finish_checkout_progress(attempt)
                    final_url = _current_page_url(page, checkout_url)
                    if attempt < max_submit_attempts:
                        log(f"点击订阅后未检测到跳转，准备重试 ({attempt}/{max_submit_attempts})，当前页面: {final_url}")
                        try:
                            page.wait_for_timeout(5000)
                        except Exception:
                            pass
                raise RuntimeError(f"点击订阅后未检测到测试支付链接跳转，当前页面: {_current_page_url(page, checkout_url)}")
            except Exception as exc:
                final_url = checkout_url
                try:
                    final_url = str(page.url or checkout_url)
                except Exception:
                    pass
                log(f"PayPal checkout 自动流程异常: {exc}")
                log(f"当前支付页面: {final_url}")
                # 硬失败（白屏超时 / 账户被风控限制 等）：跳过 hold_seconds
                # 立即关浏览器，让外层调度立刻换 worker / 换号重试，不再
                # 浪费 10s。其它失败保留原 hold（方便用户调试看到现场）。
                err_text = str(exc or "")
                if (
                    "白屏超时" in err_text
                    or "支付金额异常" in err_text
                    or "PLUS_CHECKOUT_NON_FREE_TRIAL" in err_text
                    or "PayPal 终态失败页" in err_text
                    or "PAYPAL_SIGNIN_REQUIRED" in err_text
                    or "account is limited" in err_text.lower()
                ):
                    checkout_finished_success["value"] = True
                    log("硬失败场景：跳过 hold_seconds，立即关闭浏览器换 worker 重试")
                return {"ok": False, "status": "failed", "final_url": final_url, "error": str(exc)}
            finally:
                # 已经成功跳回 chatgpt.com / pay.openai.com 时立刻关浏览器，
                # 跳过 hold_seconds（用户诉求：成功就关窗，不要再多停几秒）。
                # 硬失败场景（白屏超时 / PayPal limited）也走这条路径——
                # except 里把 flag 置 True 了，一并跳过 hold 立即换 worker。
                if checkout_finished_success["value"]:
                    log("checkout 终态（成功跳走或硬失败），立即关闭浏览器")
                elif not own_browser:
                    log("短链复用：checkout 结束，不 hold 浏览器（交回注册流程关闭）")
                else:
                    _hold_checkout_browser(
                        page,
                        headless=bool(headless),
                        hold_seconds=hold_seconds,
                        log=log,
                        cancel_check=cancel_check,
                    )
        finally:
            if own_browser and record_har_path and page is not None:
                try:
                    page.context.close()
                    log(f"HAR 已落盘: {record_har_path}")
                except Exception as exc:
                    log(f"HAR context 关闭失败: {exc}")
            if own_browser and browser_context is not None:
                browser_context.__exit__(None, None, None)
            elif not own_browser:
                log("短链复用：PayPal checkout 完成，浏览器交回注册流程管理（不在此关闭）")
    except Exception as exc:
        final_url = checkout_url
        try:
            final_url = str(page.url or checkout_url) if page else checkout_url
        except Exception:
            pass
        return {"ok": False, "status": "failed", "final_url": final_url, "error": str(exc)}


# ---------------------------------------------------------------------------
# GoPay 渠道选择 + Midtrans URL 抓取（GoPay 生成 GPTPlus 流水线步骤②）
# ---------------------------------------------------------------------------

# Stripe hosted checkout 上 GoPay 支付方式 radio 的 selector（用户从实际
# 页面 DOM 抓的）。多 selector 兜底，Stripe 偶尔改 class 名。
_GOPAY_RADIO_SELECTORS = (
    'input#payment-method-accordion-item-title-gopay',
    'input[value="gopay"][name="payment-method-accordion-item-title"]',
    '#payment-method-label-gopay',
    '[data-testid="gopay-accordion-item-button"]',
)

_MIDTRANS_URL_PATTERN = re.compile(
    r"https?://app\.midtrans\.com/snap/v[34]/redirection/[0-9a-f-]{36}",
    re.IGNORECASE,
)


def _click_gopay_payment_method(page, *, log: Callable[[str], None]) -> bool:
    """在 Stripe checkout 页点选 GoPay 支付方式。多 selector 兜底。"""
    for selector in _GOPAY_RADIO_SELECTORS:
        try:
            locator = page.locator(selector).first
            if _locator_ready(locator):
                _click_or_check(locator)
                log(f"已选择 GoPay 支付方式（selector={selector}）")
                try:
                    page.wait_for_timeout(800)
                except Exception:
                    pass
                return True
        except Exception:
            continue
    log("未找到 GoPay 支付方式选项（可能该 checkout 不支持 GoPay）")
    return False


def _grab_midtrans_from_ready_page(
    page,
    *,
    checkout_url: str,
    address: dict,
    timeout_seconds: int = 300,
    cancel_check: Optional[Callable[[], bool]] = None,
    log: Callable[[str], None] = print,
) -> str:
    """在已 goto 到 cashier_url 的 page 上：等页面 ready → 校验金额非零 →
    选 GoPay → 填账单 → 点订阅 burst → 轮询 page.url 命中 midtrans 即返回。

    page 已经被调用方 goto 过；本函数只做 checkout 页内的操作 + URL 轮询。
    """
    browser_timeout_ms = max(int(timeout_seconds or 300), 30) * 1000
    _wait_checkout_page_ready(page, timeout_ms=min(browser_timeout_ms, 60_000), log=log)
    # 支付页加载出来后先校验金额——0 元说明 promo / 地区异常，直接判失败。
    _verify_checkout_amount_nonzero(page, log=log)

    if not _click_gopay_payment_method(page, log=log):
        raise RuntimeError("Stripe checkout 页没有 GoPay 支付方式，无法继续")

    # 账单自动填写已停用：ChatGPT 官方更新了账单页结构，旧的字段选择器/省份
    # 下拉匹配已失效，自动填只会反复"未命中"拖时间。改成不填账单直接点订阅
    # （GoPay 印尼渠道账单字段多数非必填；若页面强制要求，由人工在浏览器里补）。
    # 如需恢复自动填写，取消下面这行注释：
    # _fill_billing_until_complete(page, address, max_attempts=3, log=log)
    log("账单自动填写已停用（官方页面更新），跳过填写直接点订阅")

    _accept_checkout_terms(page)
    # 点订阅按钮（最多 3 次，间隔 1s）。点完会跳转到 Midtrans。
    _click_subscribe_button_burst(page, checkout_url=checkout_url, log=log, clicks=3, delay_ms=1000)

    deadline = time.time() + max(int(timeout_seconds or 300), 30)
    while time.time() < deadline:
        if callable(cancel_check) and cancel_check():
            raise RuntimeError("任务已取消")
        try:
            current = str(page.url or "")
        except Exception:
            current = ""
        match = _MIDTRANS_URL_PATTERN.search(current)
        if match:
            url = match.group(0)
            log(f"捕获到 midtrans_url = {url}")
            return url
        try:
            page.wait_for_timeout(1000)
        except Exception:
            time.sleep(1.0)

    raise RuntimeError(
        f"等待 {timeout_seconds}s 仍未跳转到 Midtrans —— "
        "可能点订阅后没跳转，或 GoPay 渠道不可用"
    )


def _gopay_capture_dir() -> str:
    """调试抓包目录：设了 ``OPAI_GOPAY_CAPTURE_DIR`` 就开启 HAR + HTML 抓取。

    开启后 ``select_gopay_and_grab_midtrans`` 抓到 midtrans_url 不关浏览器，
    停在付款页让人工走完整付款流程，全程录 HAR + 周期 dump 每个页面 HTML。
    """
    return str(os.environ.get("OPAI_GOPAY_CAPTURE_DIR", "") or "").strip()


def _capture_context_pages(page):
    """从 page 拿到真正的 Playwright BrowserContext 和它的所有 page。

    注意：抓包传进来的是业务 page，``page.context`` 才是真正的
    Playwright BrowserContext（带 ``.pages`` / ``.close()``）。之前误把
    camoufox 的上下文管理器 wrapper 当 context，导致 ``.pages`` 取不到、
    一进循环就误判"所有页面已关闭"。
    """
    try:
        ctx = page.context
    except Exception:
        ctx = None
    pages = []
    if ctx is not None:
        try:
            pages = list(ctx.pages or [])
        except Exception:
            pages = []
    if not pages:
        pages = [page]
    return ctx, pages


def _dump_all_pages_html(page, capture_dir: str, seen: set, counter: list, log) -> None:
    """把当前所有打开页面的 HTML dump 到 capture_dir，按 (url, html-hash) 去重。"""
    _ctx, pages = _capture_context_pages(page)
    for pg in pages:
        try:
            if pg.is_closed():
                continue
        except Exception:
            pass
        try:
            url = str(pg.url or "")
            html = pg.content()
        except Exception:
            continue
        h = hashlib.sha256((url + "\n" + html).encode("utf-8", "ignore")).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        counter[0] += 1
        idx = counter[0]
        ts = time.strftime("%H%M%S")
        # 文件名带序号+时间+url 主机/路径片段，方便对着 HAR 看
        try:
            u = urlparse(url)
            tag = (u.netloc + u.path).replace("/", "_").replace(":", "_")[:60] or "page"
        except Exception:
            tag = "page"
        fname = f"{idx:03d}_{ts}_{tag}.html"
        try:
            Path(capture_dir, fname).write_text(html, encoding="utf-8")
            # 同时存一份 url 映射
            with open(Path(capture_dir, "pages_index.txt"), "a", encoding="utf-8") as fh:
                fh.write(f"{fname}\t{url}\n")
            log(f"[capture] dump HTML #{idx}: {url[:90]}")
        except Exception as exc:
            log(f"[capture] dump HTML 失败: {exc}")


def _manual_capture_loop(page, capture_dir: str, *, max_minutes: int, log) -> None:
    """人工付款抓包循环。

    停止条件（任一）：``capture_dir/STOP`` 文件出现 / 超过 max_minutes /
    浏览器上下文里所有页面都关闭。期间每 3 秒扫一遍所有打开页面 dump
    HTML（去重），HAR 由 context 关闭时落盘。
    """
    Path(capture_dir).mkdir(parents=True, exist_ok=True)
    stop_file = Path(capture_dir, "STOP")
    log(
        "================ HAR/HTML 抓包模式已开启 ================\n"
        f"[capture] 浏览器保持打开，请在浏览器里手动走完 GoPay 网页付款全流程。\n"
        f"[capture] 全程录 HAR + 自动 dump 每个页面 HTML 到: {capture_dir}\n"
        f"[capture] 完成后：在该目录下新建一个名为 STOP 的空文件即可结束抓包并落盘 HAR。\n"
        f"[capture] 或者最多等 {max_minutes} 分钟自动结束。\n"
        "========================================================"
    )
    seen: set = set()
    counter = [0]
    deadline = time.time() + max(int(max_minutes or 20), 1) * 60
    while time.time() < deadline:
        if stop_file.exists():
            log("[capture] 检测到 STOP 文件，结束抓包")
            break
        # 判断是否还有存活页面：context 没了 / 所有 page 都 closed 才算结束。
        _ctx, pages = _capture_context_pages(page)
        alive = False
        for pg in pages:
            try:
                if not pg.is_closed():
                    alive = True
                    break
            except Exception:
                alive = True
                break
        if not alive:
            log("[capture] 浏览器已被手动关闭，结束抓包")
            break
        _dump_all_pages_html(page, capture_dir, seen, counter, log)
        time.sleep(3)
    else:
        log(f"[capture] 已达最长 {max_minutes} 分钟，结束抓包")
    # 最后再 dump 一轮，确保抓到最终页
    _dump_all_pages_html(page, capture_dir, seen, counter, log)
    log(f"[capture] HTML 抓取完成，共 {counter[0]} 个快照；关闭浏览器将落盘 HAR")


def grab_midtrans_on_existing_page(
    page,
    cashier_url: str,
    *,
    timeout_seconds: int = 300,
    cancel_check: Optional[Callable[[], bool]] = None,
    log: Callable[[str], None] = print,
) -> str:
    """在一个**已存在的 page**（注册用的同一浏览器）上打开 cashier_url（短链）
    并抓 midtrans_url。

    短链复用流程专用：注册浏览器没关，直接复用它的登录态打开短链
    （chatgpt.com/checkout/openai_llc/<id>），选 GoPay → 点订阅 → 抓 midtrans。
    账单自动填写已停用（官方页面更新），不再填账单。
    """
    log(f"短链复用：在注册浏览器里打开 cashier_url 并抓 midtrans（{cashier_url[:60]}…）")
    last_nav_exc: Exception | None = None
    for nav_attempt in range(1, 4):
        try:
            page.goto(cashier_url, wait_until="domcontentloaded", timeout=60_000)
            last_nav_exc = None
            break
        except Exception as exc:  # noqa: BLE001
            last_nav_exc = exc
            msg = str(exc).lower()
            transient = (
                "err_socks_connection_failed" in msg
                or "err_timed_out" in msg
                or "err_connection_reset" in msg
                or "err_connection_closed" in msg
                or "err_proxy_connection_failed" in msg
                or "err_tunnel_connection_failed" in msg
                or "err_empty_response" in msg
            )
            if nav_attempt >= 3 or not transient:
                raise
            time.sleep(1.5 * nav_attempt)
    if last_nav_exc is not None:
        raise last_nav_exc
    # address 传空 dict —— 账单自动填写已停用，_grab_midtrans_from_ready_page
    # 内部已不再填账单。
    return _grab_midtrans_from_ready_page(
        page,
        checkout_url=cashier_url,
        address={},
        timeout_seconds=timeout_seconds,
        cancel_check=cancel_check,
        log=log,
    )


def select_gopay_and_grab_midtrans(
    cashier_url: str,
    *,
    backend_config: Optional[BrowserBackendConfig] = None,
    proxy: Optional[str] = None,
    timeout_seconds: int = 300,
    cancel_check: Optional[Callable[[], bool]] = None,
    capture_dir: str = "",
    after_grab: Optional[Callable[[str], None]] = None,
    chatgpt_cookies: str = "",
    log: Callable[[str], None] = print,
) -> str:
    """启动浏览器（camoufox/bitbrowser）打开 cashier_url，自动选 GoPay 渠道、
    填账单、点订阅，抓跳转后的 Midtrans URL，关闭浏览器后返回。

    backend_config 为 None 时默认 camoufox headed。

    调试抓包：传入 ``capture_dir``（或设环境变量 ``OPAI_GOPAY_CAPTURE_DIR``）
    后，抓到 midtrans_url **不关浏览器**，开启 HAR 录制并停在付款页，让人工
    手动走完 GoPay 网页付款全流程，全程 dump 每个页面 HTML。在该目录新建
    ``STOP`` 文件结束抓包。

    ``after_grab``：抓包模式下，抓到 midtrans_url 并导航到付款页后、进入人工
    付款等待循环**之前**调用一次（参数为 midtrans_url）。用于在浏览器保持
    打开的同时跑 GoPay 注册/设 PIN/查余额，把账号信息准备好给人工手动付款。
    回调内异常不会中断抓包（只记日志）。
    """
    if backend_config is None:
        backend_config = BrowserBackendConfig.camoufox(headless=False)

    # 抓包目录：优先用显式传入的 capture_dir（前端开关），否则回退环境变量。
    capture_dir = str(capture_dir or "").strip() or _gopay_capture_dir()

    try:
        from camoufox.sync_api import Camoufox as _Camoufox
    except Exception:
        _Camoufox = None

    launch_opts: dict[str, Any] = {
        "headless": backend_config.is_headless,
        "humanize": False,
        "block_webrtc": True,
        "locale": ["en-US", "en"],
        "os": ("windows", "macos"),
    }
    if backend_config.is_camoufox and proxy:
        proxy_config = _build_camoufox_proxy(proxy)
        if proxy_config:
            # Chromium 不支持「带账号密码的 socks5」代理（Playwright issue
            # #10567）。代理池里给 GoPay 浏览器用的请放 http/https 代理。
            server = str(proxy_config.get("server") or "")
            if server.lower().startswith("socks") and (
                proxy_config.get("username") or proxy_config.get("password")
            ):
                log(
                    "⚠ 检测到带认证的 socks5 代理——Chromium/Camoufox 不支持，"
                    "浏览器代理大概率失效。请在代理池放 http/https 印尼代理。"
                )
            launch_opts["proxy"] = proxy_config
            # geoip=True：让 camoufox 按代理出口 IP 自动对齐时区 / 经纬度 /
            # 地理位置，指纹和印尼出口 IP 一致（不开的话默认时区会和 IP
            # 对不上，直接被 GoPay/Midtrans 风控判异常）。
            launch_opts["geoip"] = True
            # 出口是印尼代理，locale 也对齐成印尼优先，避免 en-US + 印尼 IP
            # 这种地理/语言不一致的指纹特征。
            launch_opts["locale"] = ["id-ID", "en-US", "en"]
            log(
                f"Camoufox 走代理 + geoip 指纹对齐: {_mask_proxy(proxy)}"
            )
        else:
            log(f"Camoufox 代理解析失败，回退直连: {_mask_proxy(proxy)}")
    elif backend_config.is_camoufox and not proxy:
        log("Camoufox 未配置代理（直连），印尼站点指纹/地理大概率过不了风控")

    browser_timeout_ms = max(int(timeout_seconds or 300), 30) * 1000
    # GoPay 是印尼渠道：cashier 页 country=ID，省/州下拉是印尼省份
    # （DKI Jakarta / Jawa Barat ...）。以前这里硬编 ``fetch_us_billing_address``
    # 填的是 "New York" 这种美国州，印尼下拉永远匹配不上 → state 一直未命中
    # （日志里 "账单字段填写结果 ... 未命中=state"）。改用印尼地址（DKI
    # Jakarta + 10310 邮编）让 state option 能命中。
    address = fetch_billing_address("ID")

    log(
        f"浏览器打开 cashier_url 选 GoPay 渠道（backend={backend_config.backend}, "
        f"window_mode={backend_config.window_mode}）"
    )

    # 抓包模式：HAR 路径放在 capture_dir 下，context 创建时挂上录制。
    # 注意：BitBrowser（CDP attach）下 Playwright 无法录 HAR（会被跳过），
    # 这种后端只能拿到 HTML 快照；要 HAR 请用 camoufox_headed 模式跑抓包。
    record_har_path = None
    if capture_dir:
        try:
            Path(capture_dir).mkdir(parents=True, exist_ok=True)
            record_har_path = str(Path(capture_dir, "midtrans_payment.har"))
            log(f"[capture] 已启用 HAR 录制: {record_har_path}")
            if backend_config.is_bitbrowser:
                log(
                    "[capture] ⚠ 当前是 BitBrowser 后端，CDP attach 下无法录 HAR，"
                    "只会拿到页面 HTML 快照。要 HAR 请改用 camoufox_headed 模式重跑抓包。"
                )
        except Exception as exc:
            log(f"[capture] HAR 目录创建失败，关闭抓包: {exc}")
            capture_dir = ""
            record_har_path = None

    browser_context = None
    try:
        browser_context, browser, page = _open_unique_camoufox_page(
            launch_opts,
            log=log,
            browser_timeout=browser_timeout_ms,
            max_attempts=3,
            record_har_path=record_har_path,
            backend_config=backend_config,
        )
        # 短链模式（chatgpt.com/checkout/openai_llc/<id>）：URL 里没有 token，
        # 必须带 ChatGPT 登录态 cookie 才能打开（否则跳登录页）。这里在 goto
        # 之前注入。BitBrowser 后端的 profile 自己持久化 cookie（且 Chromium
        # 对 add_cookies 校验严会报错），只对 Camoufox 注入。
        if chatgpt_cookies and backend_config.is_camoufox:
            try:
                page.context.add_cookies(_parse_cookie_str(chatgpt_cookies, "chatgpt.com"))
                log("短链模式：已向 Camoufox 注入 ChatGPT 登录 cookie")
            except Exception as exc:
                log(f"短链 cookie 注入失败（继续，可能需要在同一浏览器登录）: {exc}")
        elif chatgpt_cookies and backend_config.is_bitbrowser:
            log("短链模式 + BitBrowser：依赖 profile 自身登录态（不外部注入 cookie）")
        # 并发启动 N 个 headed 浏览器时，profile 绑定的 SOCKS 代理会在同一
        # 瞬间一起握手，瞬时拥塞导致部分 goto 抛 ERR_SOCKS_CONNECTION_FAILED
        # / ERR_TIMED_OUT。对这类瞬时网络错误重试（代理真挂了重试几次照样
        # 抛，不会无限拖）。业务/页面错误不在重试范围。
        last_nav_exc: Exception | None = None
        for nav_attempt in range(1, 4):
            try:
                page.goto(cashier_url, wait_until="domcontentloaded", timeout=60_000)
                last_nav_exc = None
                break
            except Exception as exc:  # noqa: BLE001 - 按错误内容判定是否重试
                last_nav_exc = exc
                msg = str(exc).lower()
                transient = (
                    "err_socks_connection_failed" in msg
                    or "err_timed_out" in msg
                    or "err_connection_reset" in msg
                    or "err_connection_closed" in msg
                    or "err_proxy_connection_failed" in msg
                    or "err_tunnel_connection_failed" in msg
                    or "err_empty_response" in msg
                )
                if nav_attempt >= 3 or not transient:
                    raise
                backoff = 1.5 * nav_attempt
                log(
                    f"打开 cashier_url 瞬时网络失败（第 {nav_attempt}/3 次，"
                    f"{backoff}s 后重试）: {exc}"
                )
                time.sleep(backoff)
        if last_nav_exc is not None:
            raise last_nav_exc
        url = _grab_midtrans_from_ready_page(
            page,
            checkout_url=cashier_url,
            address=address,
            timeout_seconds=timeout_seconds,
            cancel_check=cancel_check,
            log=log,
        )
        # 抓包模式：不关浏览器，确保停在 midtrans 付款页，人工走完整流程抓 HAR/HTML。
        if capture_dir:
            try:
                cur = str(page.url or "")
            except Exception:
                cur = ""
            if "midtrans.com" not in cur:
                try:
                    log(f"[capture] 导航到 midtrans 付款页: {url}")
                    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                except Exception as exc:
                    log(f"[capture] 导航 midtrans 失败（可忽略，页面可能已自动跳转）: {exc}")
            # 浏览器开着的同时跑 GoPay 注册/设 PIN/查余额（after_grab 回调），
            # 把可手动付款的账号准备好，再进人工付款等待循环。
            if callable(after_grab):
                try:
                    log("[capture] 浏览器保持打开，后台开始准备 GoPay 账号（注册/设PIN/查余额）…")
                    after_grab(url, page)
                except Exception as exc:
                    log(f"[capture] 准备 GoPay 账号失败（不中断抓包，可手动用别的号）: {exc}")
            max_minutes = int(os.environ.get("OPAI_GOPAY_CAPTURE_MAX_MIN", "20") or "20")
            _manual_capture_loop(page, capture_dir, max_minutes=max_minutes, log=log)
            # 抓包结束后显式关掉录 HAR 的那个 context，确保 HAR 落盘
            # （即使浏览器还没整体关闭）。
            try:
                page.context.close()
                log(f"[capture] HAR 已落盘: {record_har_path}")
            except Exception as exc:
                log(f"[capture] 关闭 capture context 落盘 HAR 失败（finally 仍会兜底）: {exc}")
        return url
    finally:
        if browser_context is not None:
            try:
                _close_camoufox_context(browser_context)
            except Exception:
                pass


def complete_paypal_checkout_protocol(
    *,
    checkout_url: str,
    cookies_str: Optional[str] = None,
    proxy: Optional[str] = None,
    email: str = "",
    payment_method: str = "paypal",
    timeout: int = 180,
    log_fn: Callable[[str], None] = print,
    cancel_check: Callable[[], bool] | None = None,
    turnstile_solver: Callable[..., str] | None = None,
    sms_pool: Optional[list[dict]] = None,
    address_region: str = "US",
) -> dict:
    """协议模式 checkout 入口。委托给 `payment_protocol.run_protocol_checkout` 运行 pipeline。

    Stripe 协议阶段需要账单地址（从 meiguodizhi 拉取），所以在调度 pipeline 之前
    主动 fetch 一次并以 ``address=`` 注入。失败仍会回落到 camoufox。

    ``address_region`` 用于切 US / JP 地址源；其它值 fallback US。
    """
    from . import payment_protocol

    address: dict = {}
    try:
        # 与 :func:`complete_paypal_checkout` 同样保持 US 走老函数（兼容
        # monkeypatch ``fetch_us_billing_address``），JP 走新函数。
        region_norm = str(address_region or "US").strip().upper() or "US"
        if region_norm == "US":
            fetched = fetch_us_billing_address(email=email)
        else:
            fetched = fetch_billing_address(region_norm, email=email)
        if isinstance(fetched, dict):
            address = fetched
    except Exception as exc:
        log_fn(f"协议模式获取账单地址失败，将带空地址进入 pipeline: {exc}")

    return payment_protocol.run_protocol_checkout(
        checkout_url=checkout_url,
        cookies_str=cookies_str,
        proxy=proxy,
        email=email,
        payment_method=payment_method,
        timeout=timeout,
        log_fn=log_fn,
        cancel_check=cancel_check,
        turnstile_solver=turnstile_solver,
        address=address,
        sms_pool=list(sms_pool) if sms_pool else [],
    )


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _is_go_gateway_timeout_error(error_text: str) -> bool:
    text = str(error_text or "").lower()
    return (
        "curl: (28)" in text
        or "operation timed out" in text
        or "request timed out" in text
        or "read timed out" in text
        or "timed out after" in text
    )


def extract_paypal_authorize_link_go(
    *,
    access_token: str,
    proxy: Optional[str] = None,
    gateway_url: str = "",
    timeout: int = 180,
    log_fn: Callable[[str], None] = print,
) -> dict:
    """Call an optional Go gateway to turn an access token into a PayPal authorize URL."""
    log = log_fn or (lambda message: logger.info(message))
    base_url = str(gateway_url or os.environ.get("PAYPAL_PROTOCOL_GATEWAY_URL", "")).strip().rstrip("/")
    token = str(access_token or "").strip()
    if not base_url:
        return {
            "ok": False,
            "status": "failed",
            "paypal_authorize_url": "",
            "error": "未配置 PAYPAL_PROTOCOL_GATEWAY_URL",
        }
    if not token:
        return {
            "ok": False,
            "status": "failed",
            "paypal_authorize_url": "",
            "error": "缺少 access_token，无法调用 Go 协议提链网关",
        }
    health_data: dict = {}
    health_status = 0
    request_timeout = max(int(timeout or 180), 30)
    try:
        health_url = f"{base_url}/api/health"
        try:
            health_response = cffi_requests.get(
                health_url,
                timeout=5,
                impersonate="chrome110",
            )
            try:
                health_data = health_response.json()
            except Exception:
                health_data = {"message": str(getattr(health_response, "text", "") or "")}
            health_status = int(getattr(health_response, "status_code", 0) or 0)
            if health_status >= 400 or not isinstance(health_data, dict) or not health_data.get("ok"):
                message = (
                    str(health_data.get("message") or health_data.get("error") or "")
                    if isinstance(health_data, dict)
                    else ""
                )
                return {
                    "ok": False,
                    "status": "failed",
                    "paypal_authorize_url": "",
                    "error": f"Go gateway 未响应: {health_url} HTTP {health_status} {message}".strip(),
                    "protocol_backend": "go",
                    "protocol_result": {"health": health_data, "health_status": health_status},
                }
            queue_used = health_data.get("extract_queue_used")
            queue_limit = health_data.get("extract_queue_limit")
            gateway_extract_timeout = _safe_int(health_data.get("extract_timeout_seconds"), 0)
            if gateway_extract_timeout > 0:
                request_timeout = max(request_timeout, gateway_extract_timeout + 10)
            if queue_used is not None and queue_limit is not None:
                config_bits = []
                if health_data.get("timeout_seconds") is not None:
                    config_bits.append(f"timeout={health_data.get('timeout_seconds')}s")
                if health_data.get("max_attempts") is not None:
                    config_bits.append(f"attempts={health_data.get('max_attempts')}")
                if health_data.get("race_parallel") is not None:
                    config_bits.append(f"race_parallel={health_data.get('race_parallel')}")
                if gateway_extract_timeout > 0:
                    config_bits.append(f"extract_timeout={gateway_extract_timeout}s")
                suffix = f" ({', '.join(config_bits)})" if config_bits else ""
                log(f"Go gateway 健康检查通过: extract_queue={queue_used}/{queue_limit}{suffix}")
            else:
                log("Go gateway 健康检查通过")
        except Exception as health_exc:
            return {
                "ok": False,
                "status": "failed",
                "paypal_authorize_url": "",
                "error": f"Go gateway 未响应: {health_url} ({health_exc})",
                "protocol_backend": "go",
                "protocol_result": {"health_error": str(health_exc)},
            }
        log(f"协议长链模式：调用 Go 网关提取 PayPal 授权长链接 {base_url}/api/extract，最长等待 {request_timeout}s")
        response = cffi_requests.post(
            f"{base_url}/api/extract",
            json={"accessToken": token, "proxy": proxy or ""},
            timeout=request_timeout,
            impersonate="chrome110",
        )
        try:
            data = response.json()
        except Exception:
            data = {"message": str(getattr(response, "text", "") or "")}
        status_code = int(getattr(response, "status_code", 0) or 0)
        if not isinstance(data, dict):
            data = {"message": str(data)}
        paypal_url = str(data.get("paypal_authorize_url") or "")
        if status_code >= 400 or not data.get("ok") or not _is_stripe_paypal_authorize_url(paypal_url):
            gateway_code = str(data.get("code") or "").strip()
            gateway_message = str(
                data.get("message")
                or data.get("error")
                or data.get("code")
                or f"Go 协议提链失败 HTTP {status_code}"
            ).strip()
            error = f"{gateway_code}: {gateway_message}" if gateway_code and gateway_code != gateway_message else gateway_message
            return {
                "ok": False,
                "status": "failed",
                "paypal_authorize_url": paypal_url,
                "error": error,
                "protocol_backend": "go",
                "protocol_result": data,
            }
        return {
            "ok": True,
            "status": "paypal_authorize_ready",
            "paypal_authorize_url": paypal_url,
            "final_url": paypal_url,
            "error": "",
            "protocol_backend": "go",
            "protocol_result": data,
        }
    except Exception as exc:  # noqa: BLE001 - gateway errors should be surfaced as task failures.
        if _is_go_gateway_timeout_error(str(exc)):
            message = (
                f"Go gateway 提链等待超时（{request_timeout}s）。"
                "通常是代理出口或 Stripe/PayPal 上游阻塞，本轮可重试"
            )
            return {
                "ok": False,
                "status": "failed",
                "paypal_authorize_url": "",
                "error": message,
                "protocol_backend": "go",
                "protocol_result": {
                    "code": "go_gateway_timeout",
                    "message": message,
                    "health": health_data,
                    "health_status": health_status,
                    "request_timeout": request_timeout,
                },
            }
        return {
            "ok": False,
            "status": "failed",
            "paypal_authorize_url": "",
            "error": str(exc),
            "protocol_backend": "go",
        }


def extract_paypal_authorize_link_protocol(
    *,
    checkout_url: str,
    cookies_str: Optional[str] = None,
    proxy: Optional[str] = None,
    email: str = "",
    timeout: int = 180,
    log_fn: Callable[[str], None] = print,
    cancel_check: Callable[[], bool] | None = None,
    address_region: str = "US",
) -> dict:
    """Run only the Stripe direct-confirm protocol stage and return the PayPal authorize URL."""
    from . import payment_protocol

    log = log_fn or (lambda message: logger.info(message))
    address: dict = {}
    try:
        region_norm = str(address_region or "US").strip().upper() or "US"
        if region_norm == "US":
            fetched = fetch_us_billing_address(email=email)
        else:
            fetched = fetch_billing_address(region_norm, email=email)
        if isinstance(fetched, dict):
            address = fetched
    except Exception as exc:
        log(f"协议长链模式获取账单地址失败，将带空地址提取 PayPal 授权长链接: {exc}")

    log("协议长链模式：使用 Stripe direct confirm 提取 PayPal 授权长链接")
    result = payment_protocol.run_protocol_checkout(
        checkout_url=checkout_url,
        cookies_str=cookies_str,
        proxy=proxy,
        email=email,
        payment_method="paypal",
        timeout=timeout,
        log_fn=log,
        cancel_check=cancel_check,
        turnstile_solver=None,
        address=address,
        sms_pool=[],
        pipeline=[payment_protocol.proto_stage_stripe_checkout],
    )
    paypal_url = str(
        result.get("paypal_authorize_url")
        or result.get("final_url")
        or result.get("redirect_url")
        or ""
    )
    if not result.get("ok") or not _is_stripe_paypal_authorize_url(paypal_url):
        error = str(
            result.get("error")
            or result.get("message")
            or "协议提取 PayPal 授权长链接失败"
        )
        return {
            "ok": False,
            "status": "failed",
            "paypal_authorize_url": paypal_url,
            "cashier_url": checkout_url,
            "error": error,
            "protocol_backend": "python",
            "protocol_result": result,
        }
    return {
        "ok": True,
        "status": "paypal_authorize_ready",
        "paypal_authorize_url": paypal_url,
        "cashier_url": checkout_url,
        "final_url": paypal_url,
        "error": "",
        "protocol_backend": "python",
        "protocol_result": result,
    }


def _open_url_system_browser(url: str) -> bool:
    """回退方案：调用系统浏览器以无痕模式打开"""
    platform = sys.platform
    try:
        if platform == "win32":
            for browser, flag in [("chrome", "--incognito"), ("msedge", "--inprivate")]:
                try:
                    subprocess.Popen(f'start {browser} {flag} "{url}"', shell=True)
                    return True
                except Exception:
                    continue
        elif platform == "darwin":
            subprocess.Popen(["open", "-a", "Google Chrome", "--args", "--incognito", url])
            return True
        else:
            for binary in ["google-chrome", "chromium-browser", "chromium"]:
                try:
                    subprocess.Popen([binary, "--incognito", url])
                    return True
                except FileNotFoundError:
                    continue
    except Exception as e:
        logger.warning(f"系统浏览器无痕打开失败: {e}")
    return False


def _stripe_init_long_url(
    cs_id: str,
    publishable_key: str,
    *,
    payment_locale: str = "en",
    user_agent: str = "",
    proxy: Optional[str] = None,
) -> str:
    """用 Stripe ``payment_pages/{cs}/init`` 把 checkout_session 实体化成长链。

    移植自 oaipayy/server.py 的 step2/step3：POST Stripe init 拿
    ``stripe_hosted_url``（``checkout.stripe.com/c/pay/cs_...``），再把 host
    重写成 ``pay.openai.com`` 返回最终 cashier_url。失败抛 ValueError。
    """
    pk = str(publishable_key or "").strip() or DEFAULT_STRIPE_PK
    stripe_js_id = str(uuid.uuid4())
    body = {
        "browser_locale": "en-US",
        "browser_timezone": "Asia/Shanghai",
        "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
        "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
        "elements_session_client[elements_init_source]": "custom_checkout",
        "elements_session_client[referrer_host]": "chatgpt.com",
        "elements_session_client[stripe_js_id]": stripe_js_id,
        "elements_session_client[locale]": str(payment_locale or "en"),
        "elements_session_client[is_aggregation_expected]": "false",
        "elements_options_client[saved_payment_method][enable_save]": "auto",
        "elements_options_client[saved_payment_method][enable_redisplay]": "auto",
        "key": pk,
        "_stripe_version": DEFAULT_STRIPE_VERSION,
    }
    headers = {
        "Authorization": f"Bearer {pk}",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": user_agent or DEFAULT_STRIPE_UA,
    }
    resp = cffi_requests.post(
        f"https://api.stripe.com/v1/payment_pages/{cs_id}/init",
        data=body,
        headers=headers,
        proxies=_build_proxies(proxy),
        timeout=30,
        impersonate="chrome110",
    )
    if resp.status_code != 200:
        raise ValueError(f"Stripe init 失败 HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json() if callable(getattr(resp, "json", None)) else {}
    if not isinstance(data, dict):
        data = {}
    hosted = (
        str(data.get("stripe_hosted_url") or "").strip()
        or str(data.get("hosted_url") or "").strip()
        or str(data.get("url") or "").strip()
    )
    if not hosted:
        raise ValueError(f"Stripe init 响应没 hosted URL: {str(data)[:300]}")
    if "checkout.stripe.com" not in hosted:
        # host 不是预期的 checkout.stripe.com，不重写，原样返回（仍可用）
        return hosted
    return hosted.replace("checkout.stripe.com", "pay.openai.com")


def generate_plus_link(
    account: Account,
    proxy: Optional[str] = None,
    country: str = "ID",
    currency: str | None = None,
    use_stripe_init: bool = False,
    use_short_link: bool = False,
) -> str:
    """生成 Plus 支付链接（后端携带账号 cookie 发请求）。

    三种模式（互斥，优先级 short_link > stripe_init > 默认）：
      - ``use_short_link=True``：走"短链"书签脚本那套——payload 用
        ``checkout_ui_mode: "custom"`` + ``entry_point: "all_plans_pricing_modal"``
        且**不带 promo_campaign**，拿 ``checkout_session_id`` 拼成
        ``chatgpt.com/checkout/openai_llc/<cs_id>`` 短链返回。
      - ``use_stripe_init=True``：oaipayy 协议，调 Stripe ``payment_pages/{cs}/init``
        实体化成完整 ``pay.openai.com`` 长链。
      - 默认：直接用 OpenAI 响应里的 url。
    """
    if not account.access_token:
        raise ValueError("账号缺少 access_token")

    country = str(country or "ID").strip().upper()
    currency = _resolve_currency(country, currency)
    headers = {
        "Authorization": f"Bearer {account.access_token}",
        "Content-Type": "application/json",
        "oai-language": "zh-CN",
    }
    if account.cookies:
        headers["cookie"] = account.cookies
        oai_did = _extract_oai_did(account.cookies)
        if oai_did:
            headers["oai-device-id"] = oai_did

    if use_short_link:
        # 短链书签脚本的 payload：custom UI mode + all_plans_pricing_modal 入口，
        # 不带 promo。返回 checkout_session_id 拼 chatgpt.com/checkout 短链。
        payload = {
            "entry_point": "all_plans_pricing_modal",
            "plan_name": "chatgptplusplan",
            "billing_details": {"country": country, "currency": currency},
            "checkout_ui_mode": "custom",
        }
    else:
        payload = {
            "plan_name": "chatgptplusplan",
            "billing_details": {"country": country, "currency": currency},
            "cancel_url": "https://chatgpt.com/#pricing",
            "promo_campaign": {
                "promo_campaign_id": "plus-1-month-free",
                "is_coupon_from_query_param": False,
            },
            "checkout_ui_mode": "hosted",
        }

    resp = cffi_requests.post(
        PAYMENT_CHECKOUT_URL,
        headers=headers,
        json=payload,
        proxies=_build_proxies(proxy),
        timeout=30,
        impersonate="chrome110",
    )
    resp.raise_for_status()
    data = resp.json()
    data = data if isinstance(data, dict) else {}

    if use_short_link:
        cs_id = (
            str(data.get("checkout_session_id") or "").strip()
            or str(data.get("cs_id") or "").strip()
        )
        if not cs_id:
            raise ValueError(f"短链提取失败：OpenAI 响应没 checkout_session_id: {data.get('detail') or str(data)[:300]}")
        logger.info("generate_plus_link: 短链 cs_id=%s", cs_id)
        return TEAM_CHECKOUT_BASE_URL + cs_id

    if use_stripe_init:
        cs_id = (
            str(data.get("checkout_session_id") or "").strip()
            or str(data.get("cs_id") or "").strip()
        )
        if not cs_id:
            raise ValueError(f"OpenAI 响应没 checkout_session_id（无法 Stripe init）: {str(data)[:300]}")
        pk = str(data.get("publishable_key") or "").strip()
        logger.info("generate_plus_link: 走 Stripe init 协议长链 cs_id=%s", cs_id)
        return _stripe_init_long_url(cs_id, pk, proxy=proxy)

    url = _extract_checkout_url(data)
    if url:
        return url
    raise ValueError(data.get("detail", "API 未返回 checkout URL"))


def generate_team_link(
    account: Account,
    workspace_name: str = "MyTeam",
    price_interval: str = "month",
    seat_quantity: int = 5,
    proxy: Optional[str] = None,
    country: str = "ID",
    currency: str | None = None,
) -> str:
    """生成 Team 支付链接（后端携带账号 cookie 发请求）"""
    if not account.access_token:
        raise ValueError("账号缺少 access_token")

    country = str(country or "ID").strip().upper()
    currency = _resolve_currency(country, currency)
    headers = {
        "Authorization": f"Bearer {account.access_token}",
        "Content-Type": "application/json",
        "oai-language": "zh-CN",
    }
    if account.cookies:
        headers["cookie"] = account.cookies
        oai_did = _extract_oai_did(account.cookies)
        if oai_did:
            headers["oai-device-id"] = oai_did

    payload = {
        "plan_name": "chatgptteamplan",
        "team_plan_data": {
            "workspace_name": workspace_name,
            "price_interval": price_interval,
            "seat_quantity": seat_quantity,
        },
        "billing_details": {"country": country, "currency": currency},
        "promo_campaign": {
            "promo_campaign_id": "team-1-month-free",
            "is_coupon_from_query_param": True,
        },
        "cancel_url": "https://chatgpt.com/#pricing",
        "checkout_ui_mode": "hosted",
    }

    resp = cffi_requests.post(
        PAYMENT_CHECKOUT_URL,
        headers=headers,
        json=payload,
        proxies=_build_proxies(proxy),
        timeout=30,
        impersonate="chrome110",
    )
    resp.raise_for_status()
    data = resp.json()
    url = _extract_checkout_url(data if isinstance(data, dict) else {})
    if url:
        return url
    raise ValueError((data if isinstance(data, dict) else {}).get("detail", "API 未返回 checkout URL"))


def open_url_incognito(url: str, cookies_str: Optional[str] = None) -> bool:
    """用 Playwright 以无痕模式打开 URL，可注入 cookie"""
    import threading
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning("playwright 未安装，回退到系统浏览器")
        return _open_url_system_browser(url)

    def _launch():
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=False, args=["--incognito"])
                ctx = browser.new_context()
                if cookies_str:
                    ctx.add_cookies(_parse_cookie_str(cookies_str, "chatgpt.com"))
                page = ctx.new_page()
                page.goto(url)
                # 保持窗口打开直到用户关闭
                page.wait_for_timeout(300_000)  # 最多等待 5 分钟
        except Exception as e:
            logger.warning(f"Playwright 无痕打开失败: {e}")

    threading.Thread(target=_launch, daemon=True).start()
    return True


def check_subscription_status(account: Account, proxy: Optional[str] = None) -> str:
    """
    检测账号当前订阅状态。

    Returns the canonical plan family. Unknown future plans return ``other`` and
    remain available in ``fetch_subscription_status_details.account_type_raw``.
    """
    return fetch_subscription_status_details(account, proxy=proxy)["status"]


def _confirmed_subscription_details(
    observation: dict[str, Any],
    *,
    plans: list[dict[str, Any]] | None = None,
    plan_conflict: bool = False,
    me: dict[str, Any] | None = None,
    usage: dict[str, Any] | None = None,
    accounts_check: dict[str, Any] | None = None,
    subscriptions: dict[str, Any] | None = None,
) -> dict[str, Any]:
    raw_status = str(observation.get("plan_code_raw") or "")
    status = str(observation.get("plan_family") or "unknown")
    subscription_state = str(observation.get("subscription_state") or "unknown")
    if status == "unknown" and raw_status and subscription_state not in {
        "expired", "canceled", "past_due",
    }:
        status = "other"
    source = str(observation.get("source") or "")
    if source.startswith(("backend-api/accounts/check", "backend-api/subscriptions")):
        plan_authority, confidence = "authoritative", "high"
    elif source == "backend-api/wham/usage":
        plan_authority, confidence = "verified", "medium"
    else:
        plan_authority, confidence = "weak", "low"
    return {
        "status": status,
        "account_type": status,
        "account_type_raw": raw_status,
        "account_type_source": source,
        "type_observed": bool(raw_status),
        "plan_detection_result": "confirmed" if raw_status else "inconclusive",
        "plan_authority": plan_authority,
        "account_type_confidence": confidence,
        "account_status": "active",
        "credential_status": "valid",
        "subscription_status": subscription_state,
        "detection_result": "confirmed",
        "status_code": "plan_conflict" if plan_conflict else "ok",
        "status_reason": (
            "套餐来源存在冲突，已按权威证据优先级保留本次观测类型"
            if plan_conflict else "状态检测成功"
        ),
        "status_retryable": bool(plan_conflict),
        "status_evidence_path": str(observation.get("evidence_path") or "")[:120],
        "source": source,
        "plans": list(plans or [observation]),
        "plan_conflict": plan_conflict,
        "me": me,
        "usage": usage,
        "accounts_check": accounts_check,
        "subscriptions": subscriptions,
    }


def fetch_subscription_status_details(account: Account, proxy: Optional[str] = None) -> dict:
    """Return a plan observed from the strongest identity-matched live endpoint."""
    if not account.access_token:
        raise StatusCheckInconclusiveError(
            code="credentials_missing",
            reason="账号缺少 Access Token，无法完成状态检测",
            source="local/credentials",
            retryable=False,
            evidence_path="credentials.access_token",
        )

    errors: list[Exception] = []
    account_id = _extract_chatgpt_account_id(account)
    accounts_check_data = None
    subscriptions_data = None
    accounts_signal: dict[str, Any] = {}
    subscriptions_observation = None

    if account_id:
        try:
            accounts_check_data = _fetch_accounts_check_data(account, account_id, proxy=proxy)
            accounts_signal = _accounts_check_plan_signal(accounts_check_data, account_id)
        except ConclusiveAccountStatusError:
            raise
        except Exception as exc:
            errors.append(exc)
            logger.info("accounts/check plan detection failed: %s", exc)

        try:
            subscriptions_data = _fetch_subscriptions_data(account, account_id, proxy=proxy)
            subscriptions_observation = _subscriptions_plan_signal(subscriptions_data)
        except ConclusiveAccountStatusError:
            raise
        except Exception as exc:
            errors.append(exc)
            logger.info("subscriptions plan detection failed: %s", exc)
    else:
        errors.append(StatusCheckInconclusiveError(
            code="account_identity_missing",
            reason="账号缺少 workspace ID，无法核对权威套餐响应",
            source="local/credentials",
            retryable=False,
            evidence_path="credentials.account_id",
        ))

    accounts_paid = accounts_signal.get("paid_observation")
    subscriptions_paid = (
        subscriptions_observation
        if subscriptions_observation
        and subscriptions_observation.get("plan_family") != "free"
        else None
    )
    authoritative_plans = [
        item for item in (
            accounts_paid,
            accounts_signal.get("free_observation"),
            subscriptions_observation,
        ) if item
    ]
    if accounts_paid:
        conflict = bool(
            subscriptions_paid
            and subscriptions_paid.get("plan_family") != accounts_paid.get("plan_family")
        )
        return _confirmed_subscription_details(
            accounts_paid,
            plans=authoritative_plans,
            plan_conflict=conflict,
            accounts_check=accounts_check_data,
            subscriptions=subscriptions_data,
        )
    if subscriptions_paid:
        conflict = bool(accounts_signal.get("free_inactive"))
        return _confirmed_subscription_details(
            subscriptions_paid,
            plans=authoritative_plans,
            plan_conflict=conflict,
            accounts_check=accounts_check_data,
            subscriptions=subscriptions_data,
        )
    if (
        accounts_signal.get("free_inactive")
        and isinstance(subscriptions_data, dict)
        and subscriptions_data.get("_no_subscription") is True
    ):
        free_observation = dict(accounts_signal["free_observation"])
        free_observation["source"] = "backend-api/accounts/check+subscriptions"
        free_observation["evidence_path"] = "account.plan_type+entitlement+subscriptions.404"
        return _confirmed_subscription_details(
            free_observation,
            plans=authoritative_plans,
            accounts_check=accounts_check_data,
            subscriptions=subscriptions_data,
        )

    usage_data = None
    usage_observation = None
    if account_id:
        try:
            usage_data = _fetch_usage_data(account, proxy=proxy, require_identity=True)
            usage_observation = _plan_observation(
                usage_data.get("plan_type"),
                source="backend-api/wham/usage",
                scope="workspace",
            )
        except ConclusiveAccountStatusError:
            raise
        except Exception as exc:
            errors.append(exc)
            logger.info("wham/usage plan detection failed: %s", exc)
    if usage_observation:
        usage_observation = dict(usage_observation)
        usage_observation["evidence_path"] = "response.plan_type"
        return _confirmed_subscription_details(
            usage_observation,
            plans=authoritative_plans + [usage_observation],
            usage=usage_data,
            accounts_check=accounts_check_data,
            subscriptions=subscriptions_data,
        )

    me_data = None
    me_details: dict[str, Any] = {"status": "unknown", "plans": []}
    try:
        response = cffi_requests.get(
            "https://chatgpt.com/backend-api/me",
            headers={
                "Authorization": f"Bearer {account.access_token}",
                "Content-Type": "application/json",
            },
            proxies=_build_proxies(proxy),
            timeout=20,
            impersonate="chrome110",
        )
        _raise_conclusive_account_failure(response, source="backend-api/me")
        _raise_inconclusive_http_failure(response, source="backend-api/me")
        response.raise_for_status()
        me_data = response.json()
        if not isinstance(me_data, dict):
            raise StatusCheckInconclusiveError(
                code="response_unrecognized",
                reason="上游账号状态响应格式异常，已保留上次结果",
                source="backend-api/me",
                evidence_path="response.body",
            )
        me_details = _subscription_details_from_me(me_data)
    except ConclusiveAccountStatusError:
        raise
    except Exception as exc:
        errors.append(exc)
        logger.info("backend-api/me plan detection failed: %s", exc)

    me_status = str(me_details.get("status") or "unknown")
    me_observation = next(
        (
            plan for plan in me_details.get("plans", [])
            if plan.get("plan_family") == me_status
        ),
        None,
    )
    if me_observation:
        me_observation = dict(me_observation)
        me_observation["evidence_path"] = "response.plan_type|orgs[].settings.workspace_plan_type"
        return _confirmed_subscription_details(
            me_observation,
            plans=authoritative_plans + list(me_details.get("plans") or []),
            me=me_data,
            usage=usage_data,
            accounts_check=accounts_check_data,
            subscriptions=subscriptions_data,
        )

    structured_errors = [
        error for error in errors if isinstance(error, StatusCheckInconclusiveError)
    ]
    if structured_errors:
        raise structured_errors[-1]
    if errors:
        raise StatusCheckInconclusiveError(
            code="check_inconclusive",
            reason="实时套餐检测未得出可靠结论，已保留上次结果",
            source="chatgpt/status-check",
        ) from errors[-1]
    raise StatusCheckInconclusiveError(
        code="plan_not_detected",
        reason="实时套餐接口均未返回可确认的类型，已保留上次结果",
        source="chatgpt/status-check",
        evidence_path="plan_type",
    )
