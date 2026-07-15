"""ChatGPT 浏览器注册流程（Camoufox）。"""
import base64
import hashlib
import json
import queue
import random
import re
import secrets
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import date
from http.cookies import SimpleCookie
from typing import Any, Callable, Optional
from urllib.parse import parse_qsl, quote, unquote, urljoin, urlparse, urlsplit

import requests
from camoufox.sync_api import Camoufox

from core.proxy_urls import build_proxy_config, canonicalize_ip

from .._browser_backend import BrowserBackendConfig, open_browser_backend
from .constants import (
    OPENAI_AUTH,
    CHATGPT_APP,
    PLATFORM_LOGIN_ENTRY,
    SENTINEL_SDK_URL,
    SENTINEL_REQ_URL,
    SENTINEL_FRAME_URL,
    SENTINEL_BASE,
    OAUTH_CONSENT_FORM_SELECTOR,
)


CAMOUFOX_VISIBLE_WINDOW_SIZE = (1280, 720)


def _apply_camoufox_visible_window_limit(
    launch_opts: dict,
    backend_config: BrowserBackendConfig,
) -> None:
    if not backend_config.is_camoufox:
        return
    if backend_config.is_headless or bool(launch_opts.get("headless")):
        return
    launch_opts.setdefault("window", CAMOUFOX_VISIBLE_WINDOW_SIZE)


def _is_transient_nav_error(exc: BaseException) -> bool:
    """page.goto / page.reload 抛错是否属于可重试的瞬时网络断连。

    覆盖 Chromium/Firefox 常见的瞬时网络错误码。业务/页面错误（4xx、选择器
    超时等）不在此列，不会被误判重试。
    """
    msg = str(exc or "").lower()
    return any(
        token in msg
        for token in (
            "err_connection_closed",
            "err_connection_reset",
            "err_connection_refused",
            "err_connection_aborted",
            "err_connection_failed",
            "err_timed_out",
            "err_network_changed",
            "err_empty_response",
            "err_socks_connection_failed",
            "err_proxy_connection_failed",
            "err_tunnel_connection_failed",
            "err_name_not_resolved",
            "err_address_unreachable",
            "ns_error_net",            # Firefox/Camoufox 网络错误前缀
            "neterror",
            "navigating to",           # Playwright 包装的导航失败常带这句
        )
    )


def _goto_with_retry(
    page,
    url: str,
    *,
    wait_until: str = "domcontentloaded",
    timeout: int = 30000,
    attempts: int = 3,
    log: Optional[Callable[[str], None]] = None,
    deadline: float | None = None,
    cancel_check: Optional[Callable[[], bool]] = None,
):
    """``page.goto`` 带瞬时网络错误重试（默认 3 次，指数退避）。

    全局统一：注册流程里所有打开页面都该走这个，避免一次网络波动
    （ERR_CONNECTION_CLOSED / RESET / TIMED_OUT 等）就直接判失败。
    瞬时错误重试；业务错误（页面 4xx、选择器问题）原样抛出不重试。
    """
    _log = log or (lambda *_a, **_k: None)
    last_exc: Optional[BaseException] = None
    for attempt in range(1, max(int(attempts), 1) + 1):
        attempt_timeout = max(int(timeout), 1)
        if deadline is not None:
            _raise_if_cancelled(cancel_check)
            remaining = _password_settings_remaining(deadline, "打开 Security 设置页")
            attempt_timeout = max(
                1,
                min(
                    attempt_timeout,
                    int(remaining * 1000),
                    int(PASSWORD_SETTINGS_NAVIGATION_SLICE_SECONDS * 1000),
                ),
            )
        try:
            result = page.goto(url, wait_until=wait_until, timeout=attempt_timeout)
            if deadline is not None:
                _raise_if_cancelled(cancel_check)
                _password_settings_remaining(deadline, "打开 Security 设置页")
            return result
        except Exception as exc:  # noqa: BLE001 - 按错误内容判定是否重试
            last_exc = exc
            if deadline is not None:
                _raise_if_cancelled(cancel_check)
                _password_settings_remaining(deadline, "打开 Security 设置页")
            deadline_timeout = deadline is not None and "timeout" in str(exc or "").lower()
            if attempt >= attempts or not (_is_transient_nav_error(exc) or deadline_timeout):
                raise
            backoff = 1.5 * attempt
            if deadline is not None:
                backoff = min(
                    backoff,
                    _password_settings_remaining(deadline, "打开 Security 设置页"),
                )
            _log(
                f"打开页面瞬时网络失败（第 {attempt}/{attempts} 次，{backoff:.1f}s 后重试）："
                f"{str(exc)[:120]}"
            )
            if deadline is None and cancel_check is None:
                time.sleep(backoff)
            else:
                _cancelable_sleep(backoff, cancel_check)
    if last_exc is not None:
        if deadline is not None:
            _raise_if_cancelled(cancel_check)
            _password_settings_remaining(deadline, "打开 Security 设置页")
        raise last_exc


def _reload_with_retry(
    page,
    *,
    wait_until: str = "domcontentloaded",
    timeout: int = 30000,
    attempts: int = 3,
    log: Optional[Callable[[str], None]] = None,
):
    """``page.reload`` 带瞬时网络错误重试。"""
    _log = log or (lambda *_a, **_k: None)
    last_exc: Optional[BaseException] = None
    for attempt in range(1, max(int(attempts), 1) + 1):
        try:
            return page.reload(wait_until=wait_until, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt >= attempts or not _is_transient_nav_error(exc):
                raise
            time.sleep(1.5 * attempt)
    if last_exc is not None:
        raise last_exc

EMAIL_INPUT_SELECTORS = [
    'input#login-email',
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[autocomplete*="username"]',
    'input[inputmode="email"]',
    'input[id*="email"]',
]

PASSWORD_INPUT_SELECTORS = [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="new-password"]',
]

EMAIL_SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'button[data-testid="continue-button"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("Next")',
    'button:has-text("next")',
    'button:has-text("続ける")',
    'button:has-text("続行")',
    'button:has-text("次へ")',
]

PASSWORD_SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'button[data-testid="continue-button"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("Sign up")',
    'button:has-text("sign up")',
    'button:has-text("Create account")',
    'button:has-text("create account")',
    'button:has-text("続ける")',
    'button:has-text("続行")',
    'button:has-text("登録")',
    'button:has-text("新規登録")',
    'button:has-text("アカウントを作成")',
    'button:has-text("サインアップ")',
]

PASSWORD_SETTING_SELECTOR = '[data-testid="password-setting"]'
PASSWORD_SETTINGS_TIMEOUT_SECONDS = 240
PASSWORD_NEXTAUTH_FETCH_TIMEOUT_SECONDS = 12
PASSWORD_ELIGIBILITY_FETCH_TIMEOUT_SECONDS = 3
PASSWORD_REAUTH_REDIRECT_TIMEOUT_SECONDS = 20
PASSWORD_SETTINGS_NAVIGATION_SLICE_SECONDS = 5
PASSWORD_CHATGPT_COOKIE_HEADER_MAX_BYTES = 7168
PASSWORD_POST_SUBMIT_ROOT_STABILITY_SECONDS = 2
NEW_PASSWORD_INPUT_SELECTORS = [
    'input[name="new-password"][autocomplete="new-password"]',
    'input[name="new-password"]',
]
CONFIRM_PASSWORD_INPUT_SELECTORS = [
    'input[name="confirm-password"][autocomplete="new-password"]',
    'input[name="confirm-password"]',
]

OTP_INPUT_SELECTORS = [
    "input[inputmode='numeric']",
    "input[autocomplete='one-time-code']",
    "input[type='tel']",
    "input[type='number']",
    "input[name*='code' i]",
    "input[id*='code' i]",
]

SIGNUP_RECOVERY_SELECTORS = [
    'a:has-text("Sign up")',
    'button:has-text("Sign up")',
    'a:has-text("sign up")',
    'button:has-text("sign up")',
    'a:has-text("Register")',
    'button:has-text("Register")',
    'a:has-text("Create account")',
    'button:has-text("Create account")',
    'a:has-text("创建账号")',
    'button:has-text("创建账号")',
    'a:has-text("注册")',
    'button:has-text("注册")',
    'a:has-text("登録")',
    'button:has-text("登録")',
    'a:has-text("新規登録")',
    'button:has-text("新規登録")',
    'a:has-text("アカウントを作成")',
    'button:has-text("アカウントを作成")',
    'a:has-text("サインアップ")',
    'button:has-text("サインアップ")',
]

PASSWORDLESS_LOGIN_SELECTORS = [
    'button[name="intent"][value="passwordless_login_send_otp"]',
    'button[value="passwordless_login_send_otp"]',
    'button:has-text("one-time code")',
    'button:has-text("one time code")',
    'button:has-text("passwordless")',
    'button:has-text("一次性验证码")',
    'button:has-text("驗證碼")',
    'button:has-text("验证码")',
    'button:has-text("código único")',
    'button:has-text("code unique")',
    'button:has-text("Einmalcode")',
    'button:has-text("código de uso único")',
    'button:has-text("ワンタイムコード")',
    'button:has-text("一回限りのコード")',
    'button:has-text("認証コード")',
]

PASSWORD_LOGIN_INSTEAD_SELECTORS = [
    'a:has-text("Continue with password")',
    'button:has-text("Continue with password")',
    'a:has-text("Use password")',
    'button:has-text("Use password")',
    'a:has-text("使用密码")',
    'button:has-text("使用密码")',
    'a:has-text("使用密碼")',
    'button:has-text("使用密碼")',
    'a:has-text("パスワードで続行")',
    'button:has-text("パスワードで続行")',
]


def _generate_browser_registration_password(length: int = 16) -> str:
    specials = ",._!@#"
    size = max(int(length or 12), 12)
    chars = [
        secrets.choice("abcdefghijklmnopqrstuvwxyz"),
        secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        secrets.choice("0123456789"),
        secrets.choice(specials),
    ]
    pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + specials
    chars.extend(secrets.choice(pool) for _ in range(size - len(chars)))
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def _sanitize_password_error(
    error: Any,
    candidate_password: str = "",
    *,
    sensitive_values: Optional[list[str]] = None,
) -> str:
    text = str(error or "").strip()
    candidate = str(candidate_password or "")
    if candidate:
        text = text.replace(candidate, "[redacted-password]")
    secrets_to_redact = [str(value or "") for value in (sensitive_values or [])]
    for value in sorted(
        {value for value in secrets_to_redact if value and value != candidate},
        key=len,
        reverse=True,
    ):
        text = text.replace(value, "[redacted-secret]")
    text = re.sub(
        r"(https?://[^\s?]+)\?[^\s]+",
        r"\1?[redacted-query]",
        text,
        flags=re.I,
    )
    text = re.sub(
        r"(?i)(?:__Host-|__Secure-)?[A-Za-z0-9_.-]*(?:session|token|cookie)[A-Za-z0-9_.-]*=[^;\s]+",
        "[redacted-cookie]",
        text,
    )
    return re.sub(r"(?<!\d)\d{6}(?!\d)", "[redacted-otp]", text)


class BrowserTaskCancelled(RuntimeError):
    pass


class PasswordSettingsTimeout(RuntimeError):
    pass


def _raise_if_cancelled(cancel_check: Optional[Callable[[], bool]] = None) -> None:
    if callable(cancel_check) and cancel_check():
        raise BrowserTaskCancelled("任务已取消")


def _cancelable_sleep(
    seconds: float,
    cancel_check: Optional[Callable[[], bool]] = None,
    *,
    interval: float = 0.1,
) -> None:
    deadline = time.monotonic() + max(float(seconds), 0.0)
    while True:
        _raise_if_cancelled(cancel_check)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(max(float(interval), 0.01), remaining))


def _password_settings_remaining(deadline: float, label: str = "注册后设置密码") -> float:
    remaining = float(deadline) - time.monotonic()
    if remaining <= 0:
        raise PasswordSettingsTimeout(f"{label}超时")
    return remaining


def _password_settings_cancel_check(
    deadline: float,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Callable[[], bool]:
    def _check() -> bool:
        if callable(cancel_check) and cancel_check():
            return True
        _password_settings_remaining(deadline)
        return False

    return _check


def _password_settings_timeout_ms(
    deadline: float,
    cap_seconds: float,
    label: str,
) -> int:
    remaining = _password_settings_remaining(deadline, label)
    return max(1, int(min(remaining, max(float(cap_seconds), 0.001)) * 1000))


def _password_step_timeout_ms(
    deadline: float | None,
    cap_seconds: float,
    label: str,
) -> int:
    if deadline is None:
        return max(1, int(max(float(cap_seconds), 0.001) * 1000))
    return _password_settings_timeout_ms(deadline, cap_seconds, label)


def _password_step_timeout_seconds(
    deadline: float | None,
    cap_seconds: float,
    label: str,
) -> float:
    if deadline is None:
        return max(float(cap_seconds), 0.001)
    return min(
        _password_settings_remaining(deadline, label),
        max(float(cap_seconds), 0.001),
    )


def _password_step_sleep(
    seconds: float,
    cancel_check: Optional[Callable[[], bool]],
    *,
    deadline: float | None,
    label: str,
) -> None:
    duration = _password_step_timeout_seconds(deadline, seconds, label)
    _cancelable_sleep(duration, cancel_check)


_PASSWORD_REAUTH_AUTHORIZE_PATHS = {
    "/authorize",
    "/oauth/authorize",
    "/api/auth/authorize",
    "/api/accounts/authorize",
    "/api/oauth/authorize",
    "/api/oauth/oauth2/authorize",
    "/api/oauth/oauth2/auth",
}
_PASSWORD_REAUTH_ENTRY_PATHS = {
    "/reauth",
    "/api/accounts/reauth",
    "/api/accounts/password/reauth",
}
_PASSWORD_REAUTH_FORBIDDEN_PATHS = {
    "/create-account",
    "/about-you",
    "/add-phone",
    "/phone-verification",
    "/log-in",
    "/login",
    "/sign-up",
    "/signup",
    "/register",
    "/api/accounts/user/register",
}
_PASSWORD_REAUTH_FORBIDDEN_PATH_SEGMENTS = {
    "consent",
    "organization",
    "organizations",
    "sign-in-with-chatgpt",
    "sign_in_with_chatgpt",
    "workspace",
    "workspaces",
}
_PASSWORD_REAUTH_SIGNUP_QUERY_KEYS = {
    "action",
    "callback",
    "flow",
    "intent",
    "mode",
    "next",
    "prompt",
    "redirect",
    "redirect_uri",
    "return_to",
    "screen_hint",
}


@dataclass(frozen=True)
class _PasswordReauthEvidence:
    original_email: str
    transaction_id: str
    expected_auth_origin: tuple[str, str, int]
    button_dispatch_marker: str
    mode: str = "add"


@dataclass(frozen=True)
class _PasswordSessionEvidence:
    original_email: str
    account_id: str


class PasswordAccountSessionExpired(RuntimeError):
    pass


def _url_origin(url: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(str(url or "").strip())
        scheme = str(parsed.scheme or "").lower()
        hostname = str(parsed.hostname or "").lower()
        if not scheme or not hostname or parsed.username is not None or parsed.password is not None:
            return None
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if port is None:
        port = 443 if scheme == "https" else 80 if scheme == "http" else -1
    return scheme, hostname, int(port)


def _normalized_auth_path(url: str) -> str:
    try:
        path = str(urlsplit(str(url or "").strip()).path or "/")
    except (TypeError, ValueError):
        return ""
    for _ in range(3):
        decoded = unquote(path)
        if decoded == path:
            break
        path = decoded
    if "\\" in path or "\x00" in path:
        return ""
    normalized = re.sub(r"/+", "/", path).rstrip("/") or "/"
    return normalized.lower()


def _password_reauth_has_signup_query(url: str) -> bool:
    try:
        query_items = parse_qsl(
            urlsplit(str(url or "").strip()).query,
            keep_blank_values=True,
        )
    except (TypeError, ValueError):
        return True
    for key, value in query_items:
        if str(key or "").strip().lower() not in _PASSWORD_REAUTH_SIGNUP_QUERY_KEYS:
            continue
        normalized = str(value or "").strip().lower().replace("-", "_")
        if any(
            token in normalized
            for token in (
                "signup",
                "sign_up",
                "register",
                "create_account",
                "create-account",
                "about_you",
                "about-you",
                "add_phone",
                "add-phone",
                "phone_verification",
                "phone-verification",
            )
        ):
            return True
    return False


def _password_reauth_has_error_query(url: str) -> bool:
    try:
        return any(
            str(key or "").strip().lower() in {"error", "error_code", "error_description"}
            and bool(str(value or "").strip())
            for key, value in parse_qsl(
                urlsplit(str(url or "").strip()).query,
                keep_blank_values=True,
            )
        )
    except (TypeError, ValueError):
        return True


def _classify_password_reauth_url(url: str) -> str:
    value = str(url or "").strip()
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return "invalid"
    candidate_origin = _url_origin(value)
    expected_origin = _url_origin(OPENAI_AUTH)
    if (
        candidate_origin is None
        or expected_origin is None
        or candidate_origin != expected_origin
        or parsed.scheme.lower() != "https"
    ):
        return "foreign_origin"
    if parsed.fragment:
        return "invalid"
    path = _normalized_auth_path(value)
    if not path:
        return "invalid"
    if any(path == item or path.startswith(f"{item}/") for item in _PASSWORD_REAUTH_FORBIDDEN_PATHS):
        return "forbidden"
    path_segments = {segment for segment in path.split("/") if segment}
    if any(
        segment == family
        or segment.startswith(f"{family}-")
        or segment.startswith(f"{family}_")
        for segment in path_segments
        for family in _PASSWORD_REAUTH_FORBIDDEN_PATH_SEGMENTS
    ):
        return "forbidden"
    if _password_reauth_has_signup_query(value):
        return "forbidden"
    if _password_reauth_has_error_query(value):
        return "error"
    if path in _PASSWORD_REAUTH_AUTHORIZE_PATHS:
        return "authorize"
    if path in _PASSWORD_REAUTH_ENTRY_PATHS:
        return "reauth"
    if path == "/email-verification":
        return "email_verification"
    if path == "/reset-password/new-password":
        return "new_password"
    if path == "/reset-password/success":
        return "success"
    return "unknown"


def _is_password_security_settings_url(url: str) -> bool:
    value = str(url or "").strip()
    candidate_origin = _url_origin(value)
    expected_origin = _url_origin(CHATGPT_APP)
    if candidate_origin is None or expected_origin is None or candidate_origin != expected_origin:
        return False
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return False
    if parsed.scheme.lower() != "https":
        return False
    path = _normalized_auth_path(value)
    fragment = str(parsed.fragment or "").strip().lower().strip("/")
    return path == "/open-security-settings" or (
        path == "/" and fragment == "settings/security"
    )


def _is_password_reauth_chatgpt_wait_url(url: str) -> bool:
    value = str(url or "").strip()
    if _url_origin(value) != _url_origin(CHATGPT_APP):
        return False
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return False
    if parsed.scheme.lower() != "https" or parsed.query:
        return False
    path = _normalized_auth_path(value)
    fragment = str(parsed.fragment or "").strip().lower().strip("/")
    return path == "/open-security-settings" or (
        path == "/" and fragment in {"", "settings/security"}
    )


def _is_exact_password_post_submit_root(url: str) -> bool:
    value = str(url or "").strip()
    if _url_origin(value) != _url_origin(CHATGPT_APP):
        return False
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return False
    return bool(
        parsed.scheme.lower() == "https"
        and parsed.username is None
        and parsed.password is None
        and _normalized_auth_path(value) == "/"
        and not parsed.query
        and not parsed.fragment
    )


def _password_expired_session_modal_visible(page) -> bool:
    try:
        result = page.evaluate(
                r"""
                () => {
                  const modal = document.querySelector('[data-testid="modal-expired-session"]');
                  if (!modal) return false;
                  const style = window.getComputedStyle(modal);
                  const rect = modal.getBoundingClientRect();
                  return Boolean(
                    style
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 0
                    && rect.height > 0
                  );
                }
                """
            )
        return result is True
    except Exception:
        return False


class _PasswordSigninResponseObserver:
    def __init__(self, page):
        self.page = page
        self.statuses: list[int] = []
        self._attached = False

    def _handle_response(self, response) -> None:
        try:
            response_url = str(response.url or "")
            if (
                _url_origin(response_url) != _url_origin(CHATGPT_APP)
                or _normalized_auth_path(response_url) != "/api/auth/signin/openai"
            ):
                return
            request = response.request
            method = str(request.method or "").upper()
            if method != "POST":
                return
            status = int(response.status)
        except Exception:
            return
        self.statuses.append(status)

    def __enter__(self):
        register = getattr(self.page, "on", None)
        if callable(register):
            register("response", self._handle_response)
            self._attached = True
        return self

    def __exit__(self, exc_type, exc, tb):
        if not self._attached:
            return False
        remover = getattr(self.page, "remove_listener", None)
        if not callable(remover):
            remover = getattr(self.page, "off", None)
        if callable(remover):
            try:
                remover("response", self._handle_response)
            except Exception:
                pass
        return False


def _password_reauth_poll_sleep(page, seconds: float, cancel_check=None) -> None:
    _raise_if_cancelled(cancel_check)
    duration = max(float(seconds), 0.0)
    waiter = getattr(page, "wait_for_timeout", None)
    if callable(waiter):
        try:
            waiter(max(1, int(duration * 1000)))
        except Exception:
            _cancelable_sleep(duration, cancel_check)
    else:
        _cancelable_sleep(duration, cancel_check)
    _raise_if_cancelled(cancel_check)


def _wait_for_password_reauth_landing(
    page,
    *,
    security_url: str,
    evidence: _PasswordReauthEvidence,
    observer: _PasswordSigninResponseObserver,
    log,
    deadline: float,
    cancel_check=None,
) -> None:
    logged_status_count = 0

    def check_signin_statuses() -> None:
        nonlocal logged_status_count
        new_statuses = list(observer.statuses[logged_status_count:])
        logged_status_count += len(new_statuses)
        for status in new_statuses:
            log(f"Security NextAuth signin POST status={status}")
            if status >= 400:
                raise RuntimeError(f"Security NextAuth signin POST HTTP {status}")

    while time.monotonic() < deadline:
        check_signin_statuses()
        _raise_if_cancelled(cancel_check)
        current_url = str(page.url or "")
        kind = _classify_password_reauth_url(current_url)
        if kind == "email_verification":
            return
        if kind in {"new_password", "success"}:
            safe_url = _sanitize_password_error(current_url)
            raise RuntimeError(
                f"Security 密码重新认证未经原邮箱验证即进入终态页 ({kind}): {safe_url}"
            )
        if current_url == security_url or _is_password_reauth_chatgpt_wait_url(current_url):
            _password_reauth_poll_sleep(page, 0.25, cancel_check)
            continue
        if (
            _url_origin(current_url) == evidence.expected_auth_origin
            and kind in {"authorize", "reauth", "unknown"}
        ):
            _password_reauth_poll_sleep(page, 0.25, cancel_check)
            continue
        safe_url = _sanitize_password_error(current_url)
        raise RuntimeError(
            f"Security 密码重新认证进入不受信任页面 ({kind}): {safe_url}"
        )
    check_signin_statuses()
    _raise_if_cancelled(cancel_check)
    safe_url = _sanitize_password_error(str(page.url or ""))
    raise RuntimeError(f"Security 密码重新认证启动后未进入邮箱验证页: {safe_url}")


def _run_password_callback_with_deadline(
    callback: Callable[[], Any],
    *,
    deadline: float,
    cancel_check: Optional[Callable[[], bool]],
    label: str,
    cancel_wait_target: Optional[Callable[[], Any]] = None,
) -> Any:
    outcome: dict[str, Any] = {}
    done = threading.Event()

    def _invoke() -> None:
        try:
            outcome["value"] = callback()
        except Exception as exc:  # Preserve mailbox cancellation/errors verbatim.
            outcome["error"] = exc
        finally:
            done.set()

    threading.Thread(
        target=_invoke,
        name="chatgpt-password-mail-callback",
        daemon=True,
    ).start()
    try:
        while True:
            _raise_if_cancelled(cancel_check)
            remaining = _password_settings_remaining(deadline, label)
            if done.wait(timeout=min(0.2, remaining)):
                break
    except (BrowserTaskCancelled, PasswordSettingsTimeout):
        cancel_wait = getattr(cancel_wait_target or callback, "cancel_wait", None)
        if callable(cancel_wait):
            try:
                cancel_wait()
            except Exception:
                pass
        raise
    error = outcome.get("error")
    if error is not None:
        raise error
    return outcome.get("value")

# add-phone 页面国际拨号码 -> 国家名映射（用于 UI 下拉选择）
PHONE_COUNTRY_CODE_MAP = {
    "1": "United States", "7": "Russia", "20": "Egypt", "27": "South Africa",
    "30": "Greece", "31": "Netherlands", "32": "Belgium", "33": "France",
    "34": "Spain", "36": "Hungary", "39": "Italy", "40": "Romania",
    "44": "United Kingdom", "45": "Denmark", "46": "Sweden", "47": "Norway",
    "48": "Poland", "49": "Germany", "51": "Peru", "52": "Mexico",
    "53": "Cuba", "54": "Argentina", "55": "Brazil", "56": "Chile",
    "57": "Colombia", "58": "Venezuela", "60": "Malaysia", "61": "Australia",
    "62": "Indonesia", "63": "Philippines", "64": "New Zealand",
    "65": "Singapore", "66": "Thailand", "81": "Japan", "82": "South Korea",
    "84": "Vietnam", "86": "China", "90": "Turkey", "91": "India",
    "92": "Pakistan", "93": "Afghanistan", "94": "Sri Lanka", "95": "Myanmar",
    "98": "Iran", "212": "Morocco", "213": "Algeria", "216": "Tunisia",
    "218": "Libya", "220": "Gambia", "221": "Senegal", "234": "Nigeria",
    "254": "Kenya", "255": "Tanzania", "256": "Uganda", "260": "Zambia",
    "263": "Zimbabwe", "351": "Portugal", "353": "Ireland", "354": "Iceland",
    "358": "Finland", "370": "Lithuania", "371": "Latvia", "372": "Estonia",
    "374": "Armenia", "375": "Belarus", "380": "Ukraine", "381": "Serbia",
    "385": "Croatia", "420": "Czech Republic", "421": "Slovakia",
    "855": "Cambodia", "856": "Laos", "880": "Bangladesh", "886": "Taiwan",
    "960": "Maldives", "966": "Saudi Arabia", "971": "United Arab Emirates",
    "972": "Israel", "977": "Nepal", "992": "Tajikistan",
    "993": "Turkmenistan", "994": "Azerbaijan", "995": "Georgia",
    "996": "Kyrgyzstan", "998": "Uzbekistan",
}

# 拨号码 -> ISO 3166-1 alpha-2 国家代码（用于 React Aria <select> 的 value 匹配）
PHONE_DIAL_TO_ISO = {
    "1": "US", "7": "RU", "20": "EG", "27": "ZA",
    "30": "GR", "31": "NL", "32": "BE", "33": "FR",
    "34": "ES", "36": "HU", "39": "IT", "40": "RO",
    "44": "GB", "45": "DK", "46": "SE", "47": "NO",
    "48": "PL", "49": "DE", "51": "PE", "52": "MX",
    "53": "CU", "54": "AR", "55": "BR", "56": "CL",
    "57": "CO", "58": "VE", "60": "MY", "61": "AU",
    "62": "ID", "63": "PH", "64": "NZ",
    "65": "SG", "66": "TH", "81": "JP", "82": "KR",
    "84": "VN", "86": "CN", "90": "TR", "91": "IN",
    "92": "PK", "93": "AF", "94": "LK", "95": "MM",
    "98": "IR", "212": "MA", "213": "DZ", "216": "TN",
    "218": "LY", "220": "GM", "221": "SN", "234": "NG",
    "254": "KE", "255": "TZ", "256": "UG", "260": "ZM",
    "263": "ZW", "351": "PT", "353": "IE", "354": "IS",
    "358": "FI", "370": "LT", "371": "LV", "372": "EE",
    "374": "AM", "375": "BY", "380": "UA", "381": "RS",
    "385": "HR", "420": "CZ", "421": "SK",
    "855": "KH", "856": "LA", "880": "BD", "886": "TW",
    "960": "MV", "966": "SA", "971": "AE",
    "972": "IL", "977": "NP", "992": "TJ",
    "993": "TM", "994": "AZ", "995": "GE",
    "996": "KG", "998": "UZ",
}

PHONE_INPUT_SELECTORS = [
    'input[type="tel"]',
    'input[name="phone"]',
    'input[name="phone_number"]',
    'input[name="phoneNumber"]',
    'input[id*="phone" i]',
    'input[placeholder*="phone" i]',
    'input[autocomplete="tel"]',
    'input[autocomplete="tel-national"]',
]

PHONE_SEND_SELECTORS = [
    'button[data-testid="continue-button"]',
    'button[data-testid*="send" i]',
    'button:has-text("Send code via SMS")',
    'button:has-text("Send code")',
    'button:has-text("Send via SMS")',
    'button:has-text("Send link via SMS")',
    'button:has-text("Send")',
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("发送")',
    'button:has-text("コードを送信")',
    'button:has-text("SMSで送信")',
    'button:has-text("送信")',
    'button:has-text("続ける")',
    'button:has-text("続行")',
    'button:has-text("次へ")',
]

PHONE_VERIFY_SELECTORS = [
    'button:has-text("Verify")',
    'button:has-text("verify")',
    'button:has-text("Check")',
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("continue")',
    'button:has-text("验证")',
    'button:has-text("确认")',
    'button:has-text("確認")',
    'button:has-text("認証")',
    'button:has-text("続ける")',
    'button:has-text("続行")',
    'button:has-text("次へ")',
]


AUTH_TIMEOUT_TITLE_RE = re.compile(r"oops,\s*an\s*error\s*occurred|出错|發生錯誤|エラーが発生|問題が発生", re.I)
AUTH_TIMEOUT_DETAIL_RE = re.compile(
    r"operation\s+timed\s+out|route\s+error|405\s+method\s+not\s+allowed|failed\s+to\s+fetch|network\s+error|fetch\s+failed|タイムアウト|ネットワークエラー|取得に失敗",
    re.I,
)
AUTH_RETRY_TEXT_RE = re.compile(r"try\s+again|重试|重試|再試行|もう一度|やり直す", re.I)


def _is_auth_timeout_retry_text(text: str) -> bool:
    value = str(text or "")
    return bool(
        AUTH_RETRY_TEXT_RE.search(value)
        and (AUTH_TIMEOUT_TITLE_RE.search(value) or AUTH_TIMEOUT_DETAIL_RE.search(value))
    )


def _parse_phone_country_and_local(phone_number: str) -> tuple[str, str, str]:
    """从完整手机号解析出 (拨号码, 本地号码, 国家名)。

    例: +12025550101 -> ("1", "2025550101", "United States")
    """
    num = str(phone_number or "").lstrip("+").strip()
    for length in (3, 2, 1):
        if length > len(num):
            continue
        prefix = num[:length]
        if prefix in PHONE_COUNTRY_CODE_MAP:
            return prefix, num[length:], PHONE_COUNTRY_CODE_MAP[prefix]
    return "", num, ""


def _select_phone_country_ui(page, dial_code: str, country_name: str, log) -> bool:
    """在 add-phone 页面的国家下拉框中选择对应国家。

    OpenAI add-phone 页面使用 React Aria Select 组件，底层有一个隐藏的原生 <select>
    和一个可视的 button trigger + listbox 弹出层。
    """
    if not dial_code and not country_name:
        log("  无法识别国家码，跳过国家选择")
        return False

    iso_code = PHONE_DIAL_TO_ISO.get(dial_code, "")
    log(f"  目标国家: {country_name} (+{dial_code}) ISO={iso_code}")

    # 先检查当前下拉框是否已经是目标国家
    dial_pattern = f"(+{dial_code})"
    already = page.evaluate(
        """
        (dialPattern) => {
          const visible = (el) => {
            if (!el) return false;
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const all = Array.from(document.querySelectorAll('button, div, span, a, [role="button"], [role="combobox"], select'));
          for (const el of all) {
            if (!visible(el)) continue;
            const text = (el.innerText || el.textContent || '').trim();
            if (text.includes(dialPattern) && text.length < 80) return true;
          }
          return false;
        }
        """,
        dial_pattern,
    )
    if already:
        log(f"  国家已是目标值: (+{dial_code})")
        return True

    # ═══════════════════════════════════════════════════════════════════
    # 策略 1: 通过底层原生 <select> 直接设置值（最可靠）
    # React Aria Select 底层会有一个隐藏的 <select> 用于表单提交和无障碍。
    # 直接修改它的值并触发 change 事件可以同步 React 状态。
    # ═══════════════════════════════════════════════════════════════════
    native_selected = page.evaluate(
        """
        ({ isoCode, dialCode, countryName }) => {
          const selects = document.querySelectorAll('select');
          for (const sel of selects) {
            if (sel.options.length < 10) continue;  // 排除非国家的 select

            // 尝试多种匹配策略找到目标 option
            let targetValue = null;
            for (const opt of sel.options) {
              const v = (opt.value || '').trim();
              const t = (opt.text || opt.label || '').trim();
              // 匹配 ISO 代码 (如 "TH")
              if (isoCode && v === isoCode) { targetValue = v; break; }
              // 匹配拨号码 (如 value 包含 "66" 或 text 包含 "+66")
              if (t.includes('(+' + dialCode + ')')) { targetValue = v; break; }
              if (t.includes(countryName)) { targetValue = v; break; }
            }

            if (targetValue !== null) {
              // 使用 React 兼容的方式设置值
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype, 'value'
              )?.set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(sel, targetValue);
              } else {
                sel.value = targetValue;
              }
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              sel.dispatchEvent(new Event('input', { bubbles: true }));
              return { ok: true, value: targetValue, method: 'native_setter' };
            }
          }
          return { ok: false };
        }
        """,
        {"isoCode": iso_code, "dialCode": dial_code, "countryName": country_name},
    )
    if native_selected and native_selected.get("ok"):
        log(f"  ✓ 通过原生 <select> 选择成功: value={native_selected.get('value')}")
        time.sleep(0.5)
        # 验证 UI 是否同步更新
        verify = page.evaluate(
            "(dp) => { const b = document.querySelector('button[aria-haspopup=\"listbox\"]'); return b ? (b.innerText || '').trim() : ''; }",
            dial_pattern,
        )
        if f"+{dial_code}" in (verify or ""):
            log(f"  ✓ UI 已同步: {verify}")
            return True
        log(f"  原生 select 已设置但 UI 未同步 ({verify})，尝试 UI 交互...")

    # ═══════════════════════════════════════════════════════════════════
    # 策略 2: 通过 React Aria 的 key 属性直接操作
    # ═══════════════════════════════════════════════════════════════════
    key_selected = page.evaluate(
        """
        ({ isoCode, dialCode, countryName }) => {
          // 找到 React Aria Select 的隐藏 <select> 并通过 selectOption 模拟
          const selects = document.querySelectorAll('select');
          for (const sel of selects) {
            if (sel.options.length < 10) continue;
            for (const opt of sel.options) {
              const v = (opt.value || '').trim();
              const t = (opt.text || opt.label || '').trim();
              if ((isoCode && v === isoCode) || t.includes('(+' + dialCode + ')') || t.includes(countryName)) {
                sel.value = v;
                // 触发 React 合成事件
                const ev = new Event('change', { bubbles: true });
                Object.defineProperty(ev, 'target', { writable: false, value: sel });
                sel.dispatchEvent(ev);
                return { ok: true, value: v, text: t };
              }
            }
          }
          return { ok: false };
        }
        """,
        {"isoCode": iso_code, "dialCode": dial_code, "countryName": country_name},
    )

    # ═══════════════════════════════════════════════════════════════════
    # 策略 3: 使用 Playwright 的 selectOption API（对原生 select 最可靠）
    # ═══════════════════════════════════════════════════════════════════
    try:
        select_el = page.query_selector("select")
        if select_el:
            # 尝试用 ISO 代码选择
            if iso_code:
                try:
                    select_el.select_option(value=iso_code)
                    log(f"  ✓ Playwright selectOption(value={iso_code}) 成功")
                    time.sleep(0.5)
                    return True
                except Exception:
                    pass
            # 尝试用 label 匹配（包含国家名或拨号码）
            try:
                # 获取所有 option 的 value 和 text，找到匹配的
                match_value = page.evaluate(
                    """
                    ({ dialCode, countryName }) => {
                      const sel = document.querySelector('select');
                      if (!sel) return '';
                      for (const opt of sel.options) {
                        const t = (opt.text || opt.label || '').trim();
                        const v = (opt.value || '').trim();
                        if (t.includes('(+' + dialCode + ')') || t.includes(countryName)) return v;
                      }
                      return '';
                    }
                    """,
                    {"dialCode": dial_code, "countryName": country_name},
                )
                if match_value:
                    select_el.select_option(value=match_value)
                    log(f"  ✓ Playwright selectOption(value={match_value}) 成功")
                    time.sleep(0.5)
                    return True
            except Exception as e:
                log(f"  selectOption label 匹配失败: {e}")
    except Exception as e:
        log(f"  Playwright selectOption 策略失败: {e}")

    # ═══════════════════════════════════════════════════════════════════
    # 策略 4: 点击 trigger 按钮打开 listbox，然后在 listbox 中选择
    # ═══════════════════════════════════════════════════════════════════
    trigger = None
    for sel in [
        'button[aria-haspopup="listbox"]',
        '.react-aria-Select button',
        'button[class*="select" i]',
        'button[class*="country" i]',
    ]:
        trigger = page.query_selector(sel)
        if trigger:
            break

    if not trigger:
        trigger = page.evaluate(
            r"""
            () => {
              const pattern = /\(\+\d{1,4}\)/;
              const all = document.querySelectorAll('button, [role="button"], [role="combobox"]');
              for (const el of all) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const text = (el.innerText || '').trim();
                if (pattern.test(text)) {
                  el.scrollIntoView({ block: 'center' });
                  el.click();
                  return true;
                }
              }
              return false;
            }
            """,
        )
        if not trigger:
            log("  ⚠️ 未找到国家选择器触发按钮")
            return False
        log("  已通过 JS 点击触发按钮")
    else:
        trigger.scroll_into_view_if_needed()
        trigger.click()
        log("  已点击国家选择器下拉框")

    time.sleep(0.8)

    # 等待 listbox 出现
    listbox = None
    for _ in range(10):
        listbox = page.query_selector('[role="listbox"]')
        if listbox:
            break
        time.sleep(0.3)

    if not listbox:
        log("  ⚠️ 下拉框 listbox 未出现")
        return False

    log("  listbox 已出现")

    # 在 listbox 中查找并点击目标 option
    option = None
    if iso_code:
        for attr in ["data-key", "data-value", "value", "id"]:
            # 尝试精确匹配和包含匹配
            option = page.query_selector(f'[role="option"][{attr}="{iso_code}"]')
            if not option:
                option = page.query_selector(f'[role="option"][{attr}*="{iso_code}"]')
            if option:
                log(f"  找到 option: [{attr} 含 {iso_code}]")
                break

    if not option:
        option_idx = page.evaluate(
            """
            ({ countryName, dialCode }) => {
              const options = document.querySelectorAll('[role="option"]');
              for (let i = 0; i < options.length; i++) {
                const text = (options[i].innerText || options[i].textContent || '').trim();
                if (text.includes(countryName) || text.includes('(+' + dialCode + ')') || text.includes('+' + dialCode)) {
                  return i;
                }
              }
              // 宽松匹配：只匹配拨号码数字
              for (let i = 0; i < options.length; i++) {
                const text = (options[i].innerText || options[i].textContent || '').trim();
                if (text.includes(dialCode)) {
                  return i;
                }
              }
              return -1;
            }
            """,
            {"countryName": country_name, "dialCode": dial_code},
        )
        if option_idx >= 0:
            options = page.query_selector_all('[role="option"]')
            if option_idx < len(options):
                option = options[option_idx]
                log(f"  找到 option: 文本匹配 index={option_idx}")

    if option:
        option.scroll_into_view_if_needed()
        option.click()
        time.sleep(0.5)
        new_text = page.evaluate(
            """() => {
              const btn = document.querySelector('button[aria-haspopup="listbox"]') ||
                          document.querySelector('.react-aria-Select button');
              return btn ? (btn.innerText || '').trim() : '';
            }""",
        )
        log(f"  选择后下拉框显示: {new_text}")
        if f"+{dial_code}" in (new_text or ""):
            log(f"  ✓ 国家选择成功: {new_text}")
            return True

    # 键盘 type-ahead 搜索
    log(f"  尝试键盘 type-ahead: {country_name}")
    page.keyboard.type(country_name, delay=80)
    time.sleep(0.8)

    # 按 Enter 确认选择
    page.keyboard.press("Enter")
    time.sleep(0.5)

    # 验证
    final_text = page.evaluate(
        """() => {
          const btn = document.querySelector('button[aria-haspopup="listbox"]') ||
                      document.querySelector('.react-aria-Select button');
          return btn ? (btn.innerText || '').trim() : '';
        }""",
    )
    if f"+{dial_code}" in (final_text or ""):
        log(f"  ✓ type-ahead 选择成功: {final_text}")
        return True

    log(f"  ⚠️ 下拉框已展开但未找到匹配国家: {country_name} (+{dial_code})")
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return False


def _build_proxy_config(proxy: Optional[str]) -> Optional[dict]:
    return build_proxy_config(proxy)


def _proxy_requests_url(proxy: Optional[dict]) -> str | None:
    if not proxy:
        return None
    server = str(proxy.get("server") or "")
    username = proxy.get("username")
    password = proxy.get("password")
    if username is None and password is None:
        return server
    if username is None or password is None:
        raise ValueError("代理地址无效")
    parsed = urlsplit(server)
    credentials = f"{quote(str(username), safe='')}:{quote(str(password), safe='')}"
    return f"{parsed.scheme}://{credentials}@{parsed.netloc}"


PUBLIC_IP_DEFAULT_DEADLINE_SECONDS = 35.0
PUBLIC_IP_REQUEST_TIMEOUT_SECONDS = 8.0
PUBLIC_IP_MAX_RESPONSE_BYTES = 128


def _monotonic() -> float:
    return time.monotonic()


def _read_public_ip_response(response, deadline: float) -> str:
    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_content(chunk_size=1):
        if _monotonic() >= deadline:
            raise TimeoutError("出口 IP 检测超时")
        if not chunk:
            continue
        raw_chunk = chunk.encode("ascii") if isinstance(chunk, str) else bytes(chunk)
        size += len(raw_chunk)
        if size > PUBLIC_IP_MAX_RESPONSE_BYTES:
            raise ValueError("出口 IP 响应过长")
        chunks.append(raw_chunk)
    return b"".join(chunks).decode("ascii").strip()


def _run_with_deadline(callback: Callable[[], str], deadline: float) -> str:
    remaining = deadline - _monotonic()
    if remaining <= 0:
        raise TimeoutError("出口 IP 检测超时")

    result_queue: queue.Queue[tuple[bool, object]] = queue.Queue(maxsize=1)

    def _worker() -> None:
        try:
            result_queue.put((True, callback()))
        except Exception as exc:  # noqa: BLE001 - transfer to the waiting caller
            result_queue.put((False, exc))

    threading.Thread(
        target=_worker,
        daemon=True,
        name="proxy-public-ip-probe",
    ).start()
    try:
        ok, result = result_queue.get(timeout=remaining)
    except queue.Empty:
        raise TimeoutError("出口 IP 检测超时") from None
    if ok:
        return str(result)
    if isinstance(result, BaseException):
        raise result
    raise RuntimeError("出口 IP 检测失败")


def _request_public_ip(url: str, proxies: dict[str, str] | None, deadline: float) -> str:
    remaining = deadline - _monotonic()
    if remaining <= 0:
        raise TimeoutError("出口 IP 检测超时")
    request_timeout = max(
        0.001,
        min(PUBLIC_IP_REQUEST_TIMEOUT_SECONDS, remaining),
    )
    response = None
    try:
        response = requests.get(
            url,
            proxies=proxies,
            timeout=(request_timeout, request_timeout),
            verify=True,
            headers={"Cache-Control": "no-cache"},
            stream=True,
        )
        response.raise_for_status()
        value = _read_public_ip_response(response, deadline)
        return canonicalize_ip(value)
    finally:
        close = getattr(response, "close", None)
        if callable(close):
            close()


def _detect_public_ip(proxy: Optional[dict], *, deadline: float | None = None) -> str:
    """Resolve the current exit IP without Camoufox's per-proxy cache.

    A proxy endpoint can rotate its exit between tasks, so reusing
    ``camoufox.ip.public_ip`` would also reuse its lru-cached first result and
    could create a locale/timezone mismatch.
    """
    proxy_url = _proxy_requests_url(proxy)
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    effective_deadline = (
        float(deadline)
        if deadline is not None
        else _monotonic() + PUBLIC_IP_DEFAULT_DEADLINE_SECONDS
    )
    urls = (
        "https://api.ipify.org",
        "https://checkip.amazonaws.com",
        "https://ipinfo.io/ip",
        "https://icanhazip.com",
    )
    for url in urls:
        if effective_deadline - _monotonic() <= 0:
            break
        try:
            return _run_with_deadline(
                lambda current_url=url: _request_public_ip(
                    current_url,
                    proxies,
                    effective_deadline,
                ),
                effective_deadline,
            )
        except TimeoutError:
            break
        except Exception:  # noqa: BLE001 - try the next independent IP service
            continue
    raise RuntimeError("无法识别浏览器出口 IP") from None


def _dominant_locale_for_country(country_code: str) -> tuple[str, str]:
    """Return the dominant CLDR locale for a country, not a random minority locale."""
    from camoufox.locale import SELECTOR, normalize_locale

    code = str(country_code or "").strip().upper()
    languages, probabilities = SELECTOR._load_territory_data(code)
    index = max(range(len(probabilities)), key=lambda item: float(probabilities[item]))
    language = str(languages[index]).replace("_", "-")
    locale = normalize_locale(f"{language}-{code}")
    return locale.as_string, locale.language


def _region_profile_for_ip(ip: str) -> dict[str, Any]:
    """Read the actual IP country from GeoLite rather than owner registration.

    Camoufox 0.4.11 uses ``registered_country``. Reallocated ranges can have an
    owner registered in one country while the routed IP, city and timezone are
    elsewhere (for example UA ownership with a Tokyo/JP exit). The browser
    locale must follow ``country`` to remain consistent with coordinates and
    timezone.
    """
    import geoip2.database
    from camoufox.locale import MMDB_FILE

    ip = canonicalize_ip(ip)
    with geoip2.database.Reader(str(MMDB_FILE)) as reader:
        record = reader.city(ip)
    country_code = str(record.country.iso_code or record.registered_country.iso_code or "").upper()
    if not country_code:
        raise RuntimeError(f"无法识别出口 IP {ip} 的国家")
    locale, language = _dominant_locale_for_country(country_code)
    timezone = str(record.location.time_zone or "")
    if not timezone or record.location.latitude is None or record.location.longitude is None:
        raise RuntimeError(f"出口 IP {ip} 缺少时区或地理位置")
    return {
        "ip": ip,
        "country_code": country_code,
        "country_name": str(record.country.name or record.registered_country.name or country_code),
        "locale": locale,
        "language": language,
        "timezone": timezone,
        "latitude": float(record.location.latitude),
        "longitude": float(record.location.longitude),
    }


def _apply_regional_fingerprint(
    launch_opts: dict,
    proxy: Optional[dict],
    log: Callable[[str], None],
) -> dict[str, Any]:
    exit_ip = canonicalize_ip(_detect_public_ip(proxy))
    profile = _region_profile_for_ip(exit_ip)
    if proxy:
        launch_opts["proxy"] = proxy
    launch_opts["geoip"] = exit_ip
    launch_opts["locale"] = [profile["locale"], profile["language"]]
    log(
        "代理地域识别: "
        f"IP={exit_ip}, country={profile['country_code']}/{profile['country_name']}, "
        f"locale={profile['locale']}, timezone={profile['timezone']}"
    )
    return profile


class BrowserProxyVerificationError(RuntimeError):
    pass


class BrowserProxyExitChangedError(RuntimeError):
    pass


def _browser_public_ip(page) -> str:
    response = None
    try:
        response = page.request.get(
            "https://api.ipify.org?format=json",
            timeout=15000,
        )
        if not response.ok:
            raise BrowserProxyVerificationError("浏览器代理出口复核失败")
        payload = response.json()
        if not isinstance(payload, dict) or not payload.get("ip"):
            raise BrowserProxyVerificationError("浏览器代理出口复核失败")
        return canonicalize_ip(payload["ip"])
    except BrowserProxyVerificationError:
        raise
    except Exception:
        raise BrowserProxyVerificationError("浏览器代理出口复核失败") from None
    finally:
        dispose = getattr(response, "dispose", None)
        if callable(dispose):
            dispose()


def _verify_browser_exit(page, expected_ip: str) -> str:
    expected = canonicalize_ip(expected_ip)
    actual = _browser_public_ip(page)
    if actual != expected:
        raise BrowserProxyExitChangedError(
            f"代理出口在浏览器启动后发生变化: {expected} -> {actual}"
        )
    return actual


def _verify_browser_exit_for_flow(
    page,
    expected_ip: str,
    *,
    proxy: Optional[dict],
    log: Callable[[str], None],
    no_proxy_failure_message: str,
) -> str | None:
    try:
        return _verify_browser_exit(page, expected_ip)
    except BrowserProxyVerificationError:
        if proxy:
            raise
        log(no_proxy_failure_message)
        return None


def _fingerprint_snapshot(page) -> dict[str, Any]:
    try:
        result = page.evaluate(
            """
            async () => {
              let webgl = {};
              let canvas = '';
              let audio = {};
              let mediaDevices = [];
              let clientRect = {};
              try {
                const node = document.createElement('canvas');
                node.width = 220;
                node.height = 40;
                const ctx = node.getContext('2d');
                ctx.textBaseline = 'top';
                ctx.font = '16px Arial';
                ctx.fillStyle = '#f60';
                ctx.fillRect(12, 2, 80, 26);
                ctx.fillStyle = '#069';
                ctx.fillText('AliasHub fingerprint', 4, 5);
                canvas = node.toDataURL();
                const glNode = document.createElement('canvas');
                const gl = glNode.getContext('webgl') || glNode.getContext('experimental-webgl');
                if (gl) {
                  const ext = gl.getExtension('WEBGL_debug_renderer_info');
                  webgl = {
                    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
                    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                  };
                }
              } catch (_) {}
              try {
                const AudioCtor = window.AudioContext || window.webkitAudioContext;
                const context = AudioCtor ? new AudioCtor() : null;
                if (context) {
                  audio = {
                    sampleRate: context.sampleRate,
                    maxChannelCount: context.destination.maxChannelCount,
                  };
                  await context.close();
                }
              } catch (_) {}
              try {
                mediaDevices = (await navigator.mediaDevices.enumerateDevices()).map((item) => item.kind);
              } catch (_) {}
              try {
                const probe = document.createElement('span');
                probe.textContent = 'AliasHub ClientRects';
                probe.style.cssText = 'position:absolute;left:-9999px;font:13.37px Arial';
                document.body.appendChild(probe);
                const rect = probe.getBoundingClientRect();
                clientRect = { width: rect.width, height: rect.height };
                probe.remove();
              } catch (_) {}
              return {
                userAgent: navigator.userAgent,
                platform: navigator.platform,
                language: navigator.language,
                languages: Array.from(navigator.languages || []),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory || null,
                screen: {
                  width: screen.width,
                  height: screen.height,
                  colorDepth: screen.colorDepth,
                  pixelRatio: window.devicePixelRatio,
                },
                webgl,
                canvas,
                audio,
                mediaDevices,
                clientRect,
                speechVoices: window.speechSynthesis ? speechSynthesis.getVoices().length : 0,
              };
            }
            """
        )
    except Exception:
        result = {}
    return result if isinstance(result, dict) else {}


def _fingerprint_id(snapshot: dict[str, Any]) -> str:
    if not snapshot:
        return uuid.uuid4().hex[:12]
    payload = json.dumps(snapshot, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _age_on_date(birthdate: str, today: date | None = None) -> int:
    born = date.fromisoformat(str(birthdate))
    current = today or date.today()
    return current.year - born.year - ((current.month, current.day) < (born.month, born.day))


def _classify_about_you_mode(
    *,
    has_age_label: bool,
    has_birthday_label: bool,
    has_age_field: bool,
    has_birthday_field: bool,
    has_birthday_select: bool,
) -> str:
    if has_birthday_select:
        return "birthday_select"
    if (has_age_label and not has_birthday_label) or (has_age_field and not has_birthday_field):
        return "age"
    return "birthday"


def _wait_for_url(page, substring: str, timeout: int = 60) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if substring in page.url:
            return True
        time.sleep(1)
    return False


def _find_first_selector(page, selectors: list[str]) -> str | None:
    for sel in selectors:
        try:
            node = page.query_selector(sel)
        except Exception:
            node = None
        if node:
            return sel
    return None


def _wait_for_any_selector(page, selectors: list[str], timeout: int = 30, cancel_check=None):
    deadline = time.time() + timeout
    while time.time() < deadline:
        _raise_if_cancelled(cancel_check)
        found = _find_first_selector(page, selectors)
        if found:
            return found
        _cancelable_sleep(0.5, cancel_check)
    return None


def _click_first(page, selectors: list[str], *, timeout: int = 10, cancel_check=None) -> str | None:
    found = _wait_for_any_selector(page, selectors, timeout=timeout, cancel_check=cancel_check)
    if not found:
        return None
    try:
        page.click(found)
        return found
    except Exception:
        return None


def _click_first_no_wait(page, selectors: list[str], *, timeout: int = 10, cancel_check=None) -> str | None:
    """Click a visible element without waiting for navigation.

    OpenAI's add-phone page sometimes leaves the submit XHR pending long enough
    that Playwright reports "Operation timed out" even though the click was
    delivered. This helper treats that as a click problem only after a
    no-wait click and a DOM fallback both fail.
    """
    found = _wait_for_any_selector(page, selectors, timeout=timeout, cancel_check=cancel_check)
    if not found:
        return None
    for kwargs in (
        {"timeout": 3000, "no_wait_after": True},
        {"timeout": 3000, "force": True, "no_wait_after": True},
    ):
        try:
            page.click(found, **kwargs)
            return found
        except Exception:
            pass
    try:
        clicked = bool(
            page.evaluate(
                """
                (selector) => {
                  const visible = (el) => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                  };
                  let target = null;
                  try {
                    target = document.querySelector(selector);
                  } catch (_) {
                    const textMatch = selector.match(/:has-text\\(["'](.+?)["']\\)/);
                    const tag = String(selector.split(':')[0] || 'button').trim() || 'button';
                    const needle = textMatch ? textMatch[1].toLowerCase() : '';
                    target = Array.from(document.querySelectorAll(tag)).find((el) => {
                      const text = String(el.innerText || el.textContent || '').trim().toLowerCase();
                      return visible(el) && (!needle || text.includes(needle));
                    });
                  }
                  if (!target || !visible(target) || target.disabled) return false;
                  target.click();
                  return true;
                }
                """,
                found,
            )
        )
        return found if clicked else None
    except Exception:
        return None


def _click_first_once_no_wait(
    page,
    selectors: list[str],
    *,
    timeout: float,
    cancel_check=None,
    deadline: float | None = None,
    label: str,
    accepted_url_kind: str | None = None,
) -> str | None:
    found = _wait_for_any_selector(
        page,
        selectors,
        timeout=_password_step_timeout_seconds(deadline, timeout, label),
        cancel_check=cancel_check,
    )
    if not found:
        return None
    _raise_if_cancelled(cancel_check)
    try:
        page.click(
            found,
            timeout=_password_step_timeout_ms(deadline, 3, label),
            no_wait_after=True,
        )
    except Exception as exc:
        if accepted_url_kind and _classify_password_reauth_url(
            str(page.url or "")
        ) == accepted_url_kind:
            return found
        raise RuntimeError(f"{label}状态不确定，已停止重试") from exc
    return found


def _phone_page_status(page) -> dict:
    try:
        result = page.evaluate(
            r"""
            () => {
              const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              };
              const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
              const addPhoneForm = document.querySelector('form[action*="/add-phone" i]');
              const verificationForm = document.querySelector('form[action*="/phone-verification" i]');
              const codeInput = verificationForm?.querySelector('input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
              const addPhoneError = (() => {
                if (!addPhoneForm) return '';
                const selectors = [
                  '.react-aria-FieldError',
                  '[slot="errorMessage"]',
                  '[id$="-error"]',
                  '[data-invalid="true"] + *',
                  '[aria-invalid="true"] + *',
                  '[class*="error" i]'
                ];
                for (const selector of selectors) {
                  for (const el of Array.from(addPhoneForm.querySelectorAll(selector))) {
                    const msg = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
                    if (msg) return msg;
                  }
                }
                return '';
              })();
              const verifyError = (() => {
                if (!verificationForm) return '';
                const selectors = [
                  '.react-aria-FieldError',
                  '[slot="errorMessage"]',
                  '[id$="-error"]',
                  '[data-invalid="true"] + *',
                  '[aria-invalid="true"] + *',
                  '[class*="error" i]',
                  '[role="alert"]'
                ];
                for (const selector of selectors) {
                  for (const el of Array.from(verificationForm.querySelectorAll(selector))) {
                    const msg = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
                    if (msg) return msg;
                  }
                }
                return '';
              })();
              return {
                url: location.href,
                addPhoneReady: Boolean(addPhoneForm && visible(addPhoneForm.querySelector('input[type="tel"], input[name="__reservedForPhoneNumberInput_tel"], input[autocomplete="tel"], input[name="phoneNumber"]'))),
                phoneVerificationReady: Boolean(verificationForm && codeInput && visible(codeInput)),
                addPhoneError,
                verifyError,
                text,
              };
            }
            """
        )
        return result if isinstance(result, dict) else {}
    except Exception:
        return {}


def _auth_timeout_retry_page_state(page, *, path_patterns: list[str] | None = None) -> dict:
    try:
        result = page.evaluate(
            """
            (pathPatterns) => {
              const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              };
              const pathname = String(location.pathname || '');
              if (Array.isArray(pathPatterns) && pathPatterns.length) {
                const matched = pathPatterns.some((raw) => {
                  try { return new RegExp(raw, 'i').test(pathname); } catch (_) { return false; }
                });
                if (!matched) return { retryPage: false, url: location.href, text: '' };
              }
              const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
              const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
              const retryButton = document.querySelector('button[data-dd-action-name="Try again"]')
                || buttons.find((button) => {
                  const label = String([button.value, button.textContent, button.getAttribute?.('aria-label'), button.getAttribute?.('title')].filter(Boolean).join(' '));
                  return visible(button) && /try\\s+again|重试|重試|再試行|もう一度|やり直す/i.test(label);
                });
              return {
                retryPage: Boolean(retryButton && /try\\s+again|重试|重試/i.test(text) && (/oops,?\\s*an\\s*error\\s*occurred|operation\\s+timed\\s+out|route\\s+error|405\\s+method\\s+not\\s+allowed|failed\\s+to\\s+fetch|network\\s+error/i.test(text))),
                retryEnabled: Boolean(retryButton && visible(retryButton) && !retryButton.disabled && retryButton.getAttribute('aria-disabled') !== 'true'),
                url: location.href,
                text,
              };
            }
            """,
            path_patterns or [],
        )
        if isinstance(result, dict):
            result["retryPage"] = bool(result.get("retryPage") or _is_auth_timeout_retry_text(str(result.get("text") or "")))
            return result
    except Exception:
        pass
    return {"retryPage": False, "retryEnabled": False, "url": str(page.url or ""), "text": ""}


def _recover_auth_timeout_retry_page(
    page,
    log,
    *,
    path_patterns: list[str] | None = None,
    max_clicks: int = 3,
    wait_after_click: float = 3.0,
) -> dict:
    last_state = {}
    for attempt in range(1, max_clicks + 1):
        state = _auth_timeout_retry_page_state(page, path_patterns=path_patterns)
        last_state = state
        if not state.get("retryPage"):
            return {"recovered": attempt > 1, "clicks": attempt - 1, "url": str(state.get("url") or page.url)}
        if not state.get("retryEnabled"):
            time.sleep(0.5)
            continue
        log(f"  检测到 OpenAI auth 超时重试页，点击 Try again ({attempt}/{max_clicks})")
        clicked = _click_first_no_wait(
            page,
            [
                'button[data-dd-action-name="Try again"]',
                'button:has-text("Try again")',
                'button:has-text("try again")',
                'button:has-text("重试")',
                'button:has-text("重試")',
                'button:has-text("再試行")',
                'button:has-text("もう一度")',
                'button:has-text("やり直す")',
            ],
            timeout=2,
        )
        if not clicked:
            try:
                clicked = "dom" if page.evaluate(
                    """
                    () => {
                      const visible = (el) => {
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                      };
                      const direct = document.querySelector('button[data-dd-action-name="Try again"]');
                      const target = direct || Array.from(document.querySelectorAll('button, [role="button"]')).find((el) => {
                        const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                        return visible(el) && /try\\s+again|重试|重試/i.test(text);
                      });
                      if (!target) return false;
                      target.click();
                      return true;
                    }
                    """
                ) else ""
            except Exception:
                clicked = ""
        if not clicked:
            break
        time.sleep(wait_after_click)
        state = _auth_timeout_retry_page_state(page, path_patterns=path_patterns)
        last_state = state
        if not state.get("retryPage"):
            return {"recovered": True, "clicks": attempt, "url": str(state.get("url") or page.url)}
    return {
        "recovered": False,
        "clicks": max_clicks,
        "url": str(last_state.get("url") or page.url),
        "text": str(last_state.get("text") or "")[:300],
    }


def _wait_for_phone_verification_ready(page, *, timeout: int = 25) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = _phone_page_status(page)
        if last.get("phoneVerificationReady"):
            return last
        if last.get("addPhoneError"):
            return last
        time.sleep(0.25)
    return last


def _submit_add_phone_dom(
    page,
    *,
    phone_number: str,
    dial_code: str,
    local_number: str,
    country_name: str,
    log,
) -> dict:
    """Submit OpenAI add-phone with GuJumpgate-style DOM state sync."""
    e164 = "+" + str(phone_number or "").lstrip("+").strip()
    national = str(local_number or "").strip() or e164
    iso_code = PHONE_DIAL_TO_ISO.get(str(dial_code or ""), "")
    payload = {
        "phoneNumber": e164,
        "nationalPhoneNumber": national,
        "dialCode": str(dial_code or ""),
        "countryLabel": str(country_name or ""),
        "isoCode": iso_code,
    }
    try:
        result = page.evaluate(
            """
            async (payload) => {
              const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
              const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              };
              const dispatchInputEvents = (el) => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              };
              const setNativeValue = (el, value) => {
                const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, value);
                else el.value = value;
                dispatchInputEvents(el);
              };
              const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
              const form = document.querySelector('form[action*="/add-phone" i]');
              if (!form) return { ok: false, reason: 'missing_add_phone_form', url: location.href };

              const channelInput = form.querySelector('input[name="channel"]');
              const radioEntries = Array.from(form.querySelectorAll('input[type="radio"]')).map((input) => {
                const label = input.closest('label');
                const root = label || input.closest('[role="radio"], [data-state], [class*="option"]') || input;
                const text = normalize([input.value, label?.textContent, root?.textContent, root?.getAttribute?.('aria-label')].filter(Boolean).join(' '));
                const channel = /^(sms)$/i.test(input.value || '') || /\\b(sms|text message)\\b/i.test(text)
                  ? 'sms'
                  : (/whats\\s*app/i.test(text) || /^(whatsapp)$/i.test(input.value || '') ? 'whatsapp' : '');
                return { input, label, root, channel, text };
              }).filter((entry) => entry.channel || entry.text);
              const sms = radioEntries.find((entry) => entry.channel === 'sms');
              if (sms) {
                const target = sms.label || sms.root || sms.input;
                target?.click?.();
                await sleep(120);
                radioEntries.forEach((entry) => {
                  entry.input.checked = entry.input === sms.input;
                  entry.input.dispatchEvent(new Event('input', { bubbles: true }));
                  entry.input.dispatchEvent(new Event('change', { bubbles: true }));
                  entry.label?.setAttribute?.('data-state', entry.input === sms.input ? 'on' : 'off');
                  entry.root?.setAttribute?.('data-state', entry.input === sms.input ? 'on' : 'off');
                });
                if (channelInput) {
                  channelInput.value = 'sms';
                  dispatchInputEvents(channelInput);
                }
              }

              // ★ 跳过国家选择器：OpenAI 使用 React Aria 自定义组件（非原生 select），
              // 触碰隐藏的 a11y <select> 会触发下拉浮层弹出遮挡提交按钮。
              // 默认国家已是美国 (+1)，无需切换。

              const phoneInput = form.querySelector('input[type="tel"], input[name="__reservedForPhoneNumberInput_tel"], input[autocomplete="tel"]');
              if (!phoneInput) return { ok: false, reason: 'missing_phone_input', url: location.href };
              phoneInput.focus();
              setNativeValue(phoneInput, payload.nationalPhoneNumber);
              phoneInput.dispatchEvent(new Event('blur', { bubbles: true }));

              const hidden = form.querySelector('input[name="phoneNumber"]');
              if (hidden) {
                setNativeValue(hidden, payload.phoneNumber);
              }
              await sleep(120);

              const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button'));
              const submit = buttons.find((button) => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true')
                || buttons.find((button) => visible(button));
              if (!submit) return { ok: false, reason: 'missing_submit_button', url: location.href };
              submit.click();
              return {
                ok: true,
                url: location.href,
                selectedCountry: select ? select.value : '',
                channel: channelInput ? channelInput.value : (sms ? 'sms' : ''),
                visibleValue: phoneInput.value || '',
                hiddenValue: hidden ? hidden.value : '',
              };
            }
            """,
            payload,
        )
    except Exception as exc:
        return {"ok": False, "reason": f"dom_exception: {exc}", "url": str(page.url or "")}

    if not isinstance(result, dict):
        result = {"ok": False, "reason": "dom_result_invalid", "url": str(page.url or "")}
    if result.get("ok"):
        log(
            "  add-phone DOM 提交: "
            f"country={result.get('selectedCountry') or iso_code or '-'} "
            f"channel={result.get('channel') or '-'} "
            f"hidden={'yes' if result.get('hiddenValue') else 'no'}"
        )
    return result


def _submit_phone_otp_dom(page, code: str, log) -> dict:
    otp = str(code or "").strip()
    if not otp:
        return {"ok": False, "status": 400, "url": str(page.url or ""), "text": "empty phone otp"}
    try:
        result = page.evaluate(
            """
            async (code) => {
              const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
              const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              };
              const setNativeValue = (el, value) => {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(el, value);
                else el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              };
              const form = document.querySelector('form[action*="/phone-verification" i]');
              if (!form) return { ok: false, reason: 'missing_phone_verification_form', url: location.href };
              const input = form.querySelector('input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
              if (!input || !visible(input)) return { ok: false, reason: 'missing_code_input', url: location.href };
              input.focus();
              setNativeValue(input, code);
              input.dispatchEvent(new Event('blur', { bubbles: true }));
              await sleep(120);
              const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button'));
              const submit = buttons.find((button) => {
                if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
                const text = String([button.value, button.textContent, button.getAttribute('aria-label')].filter(Boolean).join(' '));
                return !/resend/i.test(text);
              }) || buttons.find((button) => visible(button));
              if (!submit) return { ok: false, reason: 'missing_submit_button', url: location.href };
              submit.click();
              return { ok: true, url: location.href, value: input.value || '' };
            }
            """,
            otp,
        )
    except Exception as exc:
        return {"ok": False, "status": 0, "url": str(page.url or ""), "text": f"phone otp dom exception: {exc}"}
    if not isinstance(result, dict) or not result.get("ok"):
        return {
            "ok": False,
            "status": 0,
            "url": str((result or {}).get("url") or page.url),
            "text": str((result or {}).get("reason") or "phone otp dom submit failed"),
        }
    log("  phone-otp DOM 已填写并提交")
    deadline = time.time() + 25
    last_url = str(page.url or "")
    while time.time() < deadline:
        status = _phone_page_status(page)
        current_url = str(status.get("url") or page.url or "")
        last_url = current_url or last_url
        if status.get("verifyError"):
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": str(status.get("verifyError") or "")}
        if "phone-verification" not in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if any(key in current_url for key in ("code=", "consent", "sign-in-with-chatgpt", "workspace", "organization")):
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        time.sleep(0.4)
    return {"ok": False, "status": 0, "url": last_url, "data": None, "text": "phone otp submit stayed on verification page"}


def _is_login_password_url(url: str) -> bool:
    return bool(re.search(r"(?:auth|accounts)\.openai\.com/.*log-?in/password", str(url or ""), flags=re.I))


def _build_manual_flow_state(page_type: str, current_url: str) -> dict:
    state = _extract_flow_state(None, current_url)
    state["page_type"] = page_type
    state["current_url"] = current_url
    return state


def _get_visible_page_text(page) -> str:
    try:
        return str(page.evaluate("() => document.body?.innerText || ''") or "")
    except Exception:
        return ""


def _has_signup_registration_choice(page) -> bool:
    if not _is_login_password_url(str(page.url or "")):
        return False
    if _find_first_selector(page, SIGNUP_RECOVERY_SELECTORS):
        return True
    text = _get_visible_page_text(page)
    return bool(re.search(r"sign\s*up|register|create\s*account|还没有帐户|还没有账户|請註冊|请注册|去注册|注册", text, flags=re.I))


def _click_passwordless_login_if_available(page, log, *, context: str) -> bool:
    selector = _click_first(page, PASSWORDLESS_LOGIN_SELECTORS, timeout=1)
    if selector:
        log(f"{context} 已选择一次性验证码登录: {selector}")
        time.sleep(1)
        return True
    try:
        clicked = bool(
            page.evaluate(
                """
                () => {
                  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
                  const visible = (el) => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                  };
                  const target = nodes.find((el) => {
                    const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                    return visible(el) && /使用一次性验证码登录|使用一次性驗證碼登入|one-time code|one time code|passwordless|ワンタイムコード|一回限りのコード|認証コード/i.test(text);
                  });
                  if (!target) return false;
                  target.click();
                  return true;
                }
                """
            )
        )
    except Exception:
        clicked = False
    if clicked:
        log(f"{context} 已选择一次性验证码登录")
        time.sleep(1)
    return clicked


def _get_page_oauth_url(page) -> str:
    try:
        return str(
            page.evaluate(
                """
                () => {
                  const visible = (el) => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                  };
                  const anchors = Array.from(document.querySelectorAll('a[href*="/api/oauth/authorize"], a[href*="/oauth/authorize"]'));
                  const anchor = anchors.find((el) => visible(el));
                  return anchor ? String(anchor.href || anchor.getAttribute('href') || '') : '';
                }
                """
            )
            or ""
        ).strip()
    except Exception:
        return ""


def _oauth_url_matches_state(url: str, state: str) -> bool:
    if not url or not state:
        return False
    return f"state={state}" in url or f"state%3D{state}" in url


def _extract_auth_error_text(page) -> str:
    selectors = [
        "text=Failed to create account",
        "text=Sorry, we cannot create your account",
        "text=Please try again",
        "text=Invalid code",
        "text=Enter a valid age to continue",
        "text=doesn't look right",
        "[role='alert']",
        ".error, [class*='error'], [class*='Error']",
    ]
    for selector in selectors:
        try:
            text = str(page.locator(selector).first.text_content(timeout=350) or "").strip()
        except Exception:
            text = ""
        if text and "oai_log" not in text and "SSR_HTML" not in text:
            return text
    return ""


def _fill_input_like_user(
    page,
    selector: str,
    value: str,
    *,
    deadline: float | None = None,
    cancel_check=None,
) -> bool:
    _raise_if_cancelled(cancel_check)
    try:
        locator = page.locator(selector).first
        locator.wait_for(
            state="visible",
            timeout=_password_step_timeout_ms(deadline, 2, "等待密码输入框"),
        )
        current = str(locator.input_value() or "").strip()
        if current == str(value).strip():
            return True
        locator.click(
            timeout=_password_step_timeout_ms(deadline, 1.5, "点击密码输入框")
        )
        if deadline is None:
            _browser_pause(page)
        else:
            _password_step_sleep(
                0.15,
                cancel_check,
                deadline=deadline,
                label="填写密码",
            )
        try:
            if deadline is None:
                locator.fill("")
            else:
                locator.fill(
                    "",
                    timeout=_password_step_timeout_ms(deadline, 1.5, "清空密码输入框"),
                )
        except Exception:
            pass
        if deadline is None:
            _browser_pause(page, headed=False)
        else:
            _password_step_sleep(
                0.06,
                cancel_check,
                deadline=deadline,
                label="填写密码",
            )
        try:
            if deadline is None:
                locator.type(value, delay=random.randint(35, 85))
            else:
                locator.type(
                    value,
                    delay=random.randint(35, 85),
                    timeout=_password_step_timeout_ms(deadline, 5, "填写密码"),
                )
        except Exception:
            try:
                if deadline is None:
                    page.fill(selector, value)
                else:
                    page.fill(
                        selector,
                        value,
                        timeout=_password_step_timeout_ms(deadline, 3, "填写密码"),
                    )
            except Exception:
                return False
        final_value = str(locator.input_value() or "").strip()
        if final_value == str(value):
            return True
    except Exception:
        pass

    _raise_if_cancelled(cancel_check)
    if deadline is not None:
        _password_settings_remaining(deadline, "填写密码")
    try:
        ok = page.evaluate(
            """
            ({ selector, value }) => {
              const input = document.querySelector(selector);
              if (!input) return false;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              if (!setter) return false;
              setter.call(input, value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return String(input.value || '') === String(value || '');
            }
            """,
            {"selector": selector, "value": value},
        )
        return bool(ok)
    except Exception:
        return False


def _submit_form_with_fallback(page, input_selector: str) -> bool:
    try:
        return bool(
            page.evaluate(
                """
                (selector) => {
                  const input = document.querySelector(selector);
                  if (!input) return false;
                  const form = input.form || input.closest?.('form');
                  if (form?.requestSubmit) {
                    form.requestSubmit();
                    return true;
                  }
                  if (form?.submit) {
                    form.submit();
                    return true;
                  }
                  input.focus?.();
                  for (const type of ['keydown', 'keypress', 'keyup']) {
                    input.dispatchEvent(new KeyboardEvent(type, {
                      key: 'Enter',
                      code: 'Enter',
                      bubbles: true,
                      cancelable: true,
                    }));
                  }
                  return true;
                }
                """,
                input_selector,
            )
        )
    except Exception:
        return False


def _sync_hidden_birthday_input(page, birthdate: str, log) -> bool:
    try:
        synced = bool(
            page.evaluate(
                """
                (value) => {
                  const input = document.querySelector("input[name='birthday']");
                  if (!input) return false;
                  input.value = value;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  return String(input.value || '') === String(value || '');
                }
                """,
                birthdate,
            )
        )
    except Exception:
        synced = False
    if synced:
        log(f"about_you 已同步隐藏 birthday: {birthdate}")
    return synced


def _collect_visible_text_inputs(page) -> list[dict]:
    try:
        inputs = page.evaluate(
            """
            () => {
              const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
              const nodes = Array.from(document.querySelectorAll("input:not([type='hidden']):not([disabled]):not([readonly])"));
              const visible = nodes.filter((el) => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style
                  && style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && rect.width > 0
                  && rect.height > 0;
              });
              return visible.map((el, visibleIndex) => {
                const explicitLabels = Array.from(document.querySelectorAll('label'))
                  .filter((label) => String(label.getAttribute('for') || '') === String(el.id || ''))
                  .map((label) => normalize(label.textContent));
                const wrappedLabel = normalize(el.closest('label')?.textContent || '');
                const ariaLabel = normalize(el.getAttribute('aria-label'));
                const labelledByText = normalize(
                  String(el.getAttribute('aria-labelledby') || '')
                    .split(/\\s+/)
                    .filter(Boolean)
                    .map((id) => normalize(document.getElementById(id)?.textContent || ''))
                    .join(' ')
                );
                const parentText = normalize(el.parentElement?.textContent || '');
                return {
                  visibleIndex,
                  type: normalize(el.getAttribute('type') || el.type || ''),
                  name: normalize(el.getAttribute('name') || ''),
                  id: normalize(el.id || ''),
                  inputMode: normalize(el.getAttribute('inputmode') || ''),
                  autocomplete: normalize(el.getAttribute('autocomplete') || ''),
                  min: normalize(el.getAttribute('min') || ''),
                  max: normalize(el.getAttribute('max') || ''),
                  placeholder: normalize(el.getAttribute('placeholder') || ''),
                  ariaLabel,
                  labels: explicitLabels.filter(Boolean),
                  wrappedLabel,
                  labelledByText,
                  parentText,
                };
              });
            }
            """
        ) or []
    except Exception:
        inputs = []
    return [item for item in inputs if isinstance(item, dict)]


def _about_you_input_hints(entry: dict) -> str:
    parts: list[str] = []
    labels = entry.get("labels") or []
    if isinstance(labels, list):
        parts.extend(str(item or "") for item in labels)
    parts.extend(
        [
            str(entry.get("wrappedLabel") or ""),
            str(entry.get("labelledByText") or ""),
            str(entry.get("ariaLabel") or ""),
            str(entry.get("placeholder") or ""),
            str(entry.get("name") or ""),
            str(entry.get("id") or ""),
            str(entry.get("inputMode") or ""),
            str(entry.get("autocomplete") or ""),
            str(entry.get("parentText") or ""),
        ]
    )
    return " ".join(part for part in parts if part).strip().lower()


def _pick_best_about_you_input(entries: list[dict], field: str, exclude_visible_indices: set[int] | None = None) -> dict | None:
    exclude = {int(value) for value in (exclude_visible_indices or set())}
    best_entry = None
    best_score = float("-inf")
    for entry in entries:
        try:
            visible_index = int(entry.get("visibleIndex"))
        except Exception:
            continue
        if visible_index in exclude:
            continue
        hints = _about_you_input_hints(entry)
        if not hints:
            continue

        score = 0
        if field == "name":
            if any(token in hints for token in ("full name", "fullname", "全名", "姓名", "nombre completo", "nom complet", "vollständiger name", "nome completo", "повне ім", "полное имя")):
                score += 10
            if any(token in hints for token in (" name ", "name", "autocomplete=name", "nombre", "nom", "nome")):
                score += 3
            if any(token in hints for token in ("age", "年龄", "edad", "âge", "alter", "idade", "birthday", "birth", "date of birth", "出生", "生日")):
                score -= 8
        elif field == "age":
            if any(token in hints for token in ("age", "年龄", "how old", "edad", "âge", "alter", "idade", "나이", "вік", "возраст")):
                score += 10
            stable_name = str(entry.get("name") or "").strip().lower()
            stable_id = str(entry.get("id") or "").strip().lower()
            if stable_name == "age" or stable_id == "age" or stable_name.endswith("_age") or stable_id.endswith("-age"):
                score += 20
            if any(token in hints for token in ("full name", "fullname", "全名", "姓名", "nombre completo", "nom complet")):
                score -= 10
            if "name" in hints and "age" not in hints and "年龄" not in hints and "edad" not in hints:
                score -= 6
            if any(token in hints for token in ("birthday", "birth", "date of birth", "出生", "生日", "fecha de nacimiento", "nascimento")):
                score -= 3
        else:
            continue

        if score > best_score:
            best_score = score
            best_entry = entry

    if best_score > 0:
        return best_entry

    return None


def _derive_registration_state_from_page(page) -> dict:
    current_url = str(page.url or "")
    state = _extract_flow_state(None, current_url)
    if state.get("page_type"):
        return state

    if _find_first_selector(page, PASSWORD_INPUT_SELECTORS):
        page_type = "login_password" if _is_login_password_url(current_url) else "create_account_password"
        return _build_manual_flow_state(page_type, current_url)

    otp_selector = _find_first_selector(page, OTP_INPUT_SELECTORS)
    if otp_selector and "password" not in otp_selector:
        return _build_manual_flow_state("email_otp_verification", current_url)

    try:
        about_visible = bool(
            page.evaluate(
                """
                () => {
                  const inputs = Array.from(document.querySelectorAll("input:not([type='hidden'])"));
                  const text = String(document.body?.innerText || '').toLowerCase();
                  const hasName = inputs.some((el) => {
                    const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
                    return hint.includes('name') || hint.includes('姓名') || hint.includes('全名');
                  });
                  const hasAgeOrBirth = inputs.some((el) => {
                    const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
                    return hint.includes('age') || hint.includes('birth') || hint.includes('birthday') || hint.includes('年龄') || hint.includes('生日');
                  });
                  return (hasName && hasAgeOrBirth) || text.includes('about you');
                }
                """
            )
        )
    except Exception:
        about_visible = False
    if about_visible:
        return _build_manual_flow_state("about_you", current_url)

    return state


def _recover_signup_password_page(page, log) -> bool:
    if not _is_login_password_url(str(page.url or "")):
        return False
    if not _has_signup_registration_choice(page):
        return False
    selector = _click_first(page, SIGNUP_RECOVERY_SELECTORS, timeout=2)
    if not selector:
        return False
    log(f"密码页落到登录态，尝试点击注册入口恢复: {selector}")
    time.sleep(1.2)
    return True


def _wait_for_signup_entry_transition(page, log, timeout: int = 20) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _click_passwordless_login_if_available(page, log, context="邮箱页提交后"):
            time.sleep(0.5)
            continue
        state = _derive_registration_state_from_page(page)
        if state.get("page_type") in {
            "create_account_password",
            "login_password",
            "email_otp_verification",
            "about_you",
            "add_phone",
            "chatgpt_home",
            "oauth_callback",
        }:
            if state.get("page_type") == "login_password" and _recover_signup_password_page(page, log):
                return _derive_registration_state_from_page(page)
            return state
        error_text = _extract_auth_error_text(page)
        if error_text:
            raise RuntimeError(f"邮箱页提交失败: {error_text[:300]}")
        time.sleep(0.25)
    raise RuntimeError("邮箱页提交后未进入密码/验证码页面")


def _start_browser_signup_via_page(page, email: str, log) -> dict:
    for entry_url in (PLATFORM_LOGIN_ENTRY, f"{OPENAI_AUTH}/log-in"):
        try:
            log(f"打开 OpenAI 注册入口: {entry_url}")
            _goto_with_retry(page, entry_url, wait_until="domcontentloaded", timeout=30000, log=log)
        except Exception as exc:
            log(f"注册入口访问失败: {entry_url} -> {exc}")
            continue

        initial_state = _derive_registration_state_from_page(page)
        if initial_state.get("page_type") in {
            "create_account_password",
            "login_password",
            "email_otp_verification",
            "about_you",
            "add_phone",
        }:
            return initial_state

        email_selector = _wait_for_any_selector(page, EMAIL_INPUT_SELECTORS, timeout=12)
        if not email_selector:
            continue
        if not _fill_input_like_user(page, email_selector, email):
            raise RuntimeError("邮箱页填写失败")
        log(f"邮箱页输入框: {email_selector}")

        inline_state = _derive_registration_state_from_page(page)
        if inline_state.get("page_type") in {"create_account_password", "login_password"}:
            if inline_state.get("page_type") == "login_password" and _recover_signup_password_page(page, log):
                return _derive_registration_state_from_page(page)
            return inline_state

        submit_selector = _click_first(page, EMAIL_SUBMIT_SELECTORS, timeout=8)
        if submit_selector:
            log(f"邮箱页已点击继续按钮: {submit_selector}")
        elif _submit_form_with_fallback(page, email_selector):
            log("邮箱页未找到可点击 Continue，已使用表单 fallback 提交")
        else:
            raise RuntimeError("邮箱页未找到 Continue 按钮")

        return _wait_for_signup_entry_transition(page, log)

    raise RuntimeError("未找到 OpenAI 注册入口邮箱输入框")


def _start_browser_signup_via_authorize(page, email: str, device_id: str, log) -> dict:
    log("访问 ChatGPT 首页...")
    _goto_with_retry(page, f"{CHATGPT_APP}/", wait_until="domcontentloaded", timeout=30000, log=log)

    log("获取 CSRF token...")
    csrf_token = _get_browser_csrf_token(page)
    if not csrf_token:
        raise RuntimeError("获取 CSRF token 失败")

    log(f"提交邮箱: {email}")
    authorize_url = _start_browser_signin(page, email, device_id, csrf_token)
    if not authorize_url:
        raise RuntimeError("提交邮箱失败，未获取 authorize URL")

    final_url = _browser_authorize(page, authorize_url, log)
    if not final_url:
        raise RuntimeError("访问 authorize URL 失败")
    return _derive_registration_state_from_page(page)


def _dump_debug(page, prefix: str) -> None:
    page.screenshot(path=f"/tmp/{prefix}.png")
    with open(f"/tmp/{prefix}.html", "w") as f:
        f.write(page.content())


def _get_cookies(page) -> dict:
    return {c["name"]: c["value"] for c in page.context.cookies()}


def _cookies_to_header(cookies_dict: dict) -> str:
    parts = []
    for name, value in (cookies_dict or {}).items():
        if name and value not in (None, ""):
            parts.append(f"{name}={value}")
    return "; ".join(parts)


_CHATGPT_COOKIE_EXACT_NAMES = {
    "__cf_bm",
    "__cflb",
    "__cfruid",
    "_cfuvid",
    "cf_clearance",
}
_CHATGPT_COOKIE_PREFIXES = (
    "__Host-authjs.",
    "__Host-next-auth.",
    "__Secure-authjs.",
    "__Secure-next-auth.",
    "authjs.",
    "cf_chl_",
    "next-auth.",
)
_OPENAI_AUTH_COOKIE_EXACT_NAMES = {
    "__Secure-oai-is",
    "hydra_redirect",
    "iss_context",
    "login_session",
    "oai-hlib",
    "oai-sc",
    "rg_context",
    "unified_session_manifest",
}
_OPENAI_AUTH_COOKIE_PREFIXES = (
    "__Host-oai-client-auth-",
    "__Secure-oai-client-auth-",
    "oai-client-auth-",
    "oai-hlib-",
    "oai-login-csrf",
    "usc",
)


def _password_cookie_target_origins(name: str) -> tuple[str, ...]:
    cookie_name = str(name or "").strip()
    if cookie_name == "oai-did":
        return CHATGPT_APP, OPENAI_AUTH
    if cookie_name in _CHATGPT_COOKIE_EXACT_NAMES or cookie_name.startswith(
        _CHATGPT_COOKIE_PREFIXES
    ):
        return (CHATGPT_APP,)
    if cookie_name in _OPENAI_AUTH_COOKIE_EXACT_NAMES or cookie_name.startswith(
        _OPENAI_AUTH_COOKIE_PREFIXES
    ):
        return (OPENAI_AUTH,)
    return ()


def _cookie_header_to_playwright_cookies(cookies: Any) -> list[dict[str, str]]:
    values: dict[str, str] = {}
    if isinstance(cookies, dict):
        values = {
            str(name): str(value)
            for name, value in cookies.items()
            if str(name or "").strip() and value not in (None, "")
        }
    else:
        raw = str(cookies or "").strip()
        if raw:
            parsed = SimpleCookie()
            try:
                parsed.load(raw)
                values = {
                    str(name): str(morsel.value)
                    for name, morsel in parsed.items()
                    if str(name or "").strip() and morsel.value not in (None, "")
                }
            except Exception:
                values = {}
            if not values:
                for item in raw.split(";"):
                    name, separator, value = item.strip().partition("=")
                    if separator and name and value:
                        values[name] = value
    mapped: list[dict[str, str]] = []
    for name, value in values.items():
        for origin in _password_cookie_target_origins(name):
            mapped.append(
                {
                    "name": name,
                    "value": value,
                    "url": f"{origin.rstrip('/')}/",
                }
            )
    return mapped


def _estimated_cookie_header_bytes(
    cookies: list[dict[str, str]],
    origin: str,
) -> int:
    target_origin = _url_origin(origin)
    parts = [
        f"{item.get('name') or ''}={item.get('value') or ''}"
        for item in cookies
        if _url_origin(str(item.get("url") or "")) == target_origin
        and item.get("name")
        and item.get("value") not in (None, "")
    ]
    return len("; ".join(parts).encode("utf-8"))


class ExistingAccountIdentityMismatch(RuntimeError):
    pass


def _chatgpt_session_email(session_info: dict) -> str:
    profile = session_info.get("profile") if isinstance(session_info, dict) else {}
    session = session_info.get("session") if isinstance(session_info, dict) else {}
    user = session.get("user") if isinstance(session, dict) else {}
    candidates = [
        profile.get("email") if isinstance(profile, dict) else "",
        user.get("email") if isinstance(user, dict) else "",
        session.get("email") if isinstance(session, dict) else "",
    ]
    return next((str(value).strip() for value in candidates if str(value or "").strip()), "")


def _validate_existing_account_session(
    session_info: dict,
    *,
    expected_email: str,
    expected_account_id: str = "",
    require_account_id: bool = False,
) -> None:
    actual_email = _chatgpt_session_email(session_info)
    if not actual_email or actual_email.casefold() != str(expected_email or "").strip().casefold():
        raise ExistingAccountIdentityMismatch("恢复的 ChatGPT Session 与目标账号邮箱不一致")

    expected_id = str(expected_account_id or "").strip()
    actual_id = str(session_info.get("account_id") or "").strip()
    if require_account_id and not actual_id:
        raise ExistingAccountIdentityMismatch("恢复的 ChatGPT Session 缺少账号 ID")
    if expected_id and (not actual_id or actual_id != expected_id):
        raise ExistingAccountIdentityMismatch("恢复的 ChatGPT Session 与目标账号 ID 不一致")


def _validated_password_session_evidence(
    session_info: dict,
    *,
    expected_email: str,
    expected_account_id: str = "",
) -> _PasswordSessionEvidence:
    _validate_existing_account_session(
        session_info,
        expected_email=expected_email,
        expected_account_id=expected_account_id,
        require_account_id=True,
    )
    return _PasswordSessionEvidence(
        original_email=str(expected_email or "").strip(),
        account_id=str(session_info.get("account_id") or "").strip(),
    )


def _refresh_otp_baseline(otp_callback, *, strict: bool) -> None:
    refresh = getattr(otp_callback, "refresh_baseline", None)
    if not callable(refresh):
        if strict:
            raise RuntimeError("原邮箱 OTP callback 不支持严格刷新邮件基线")
        return
    refresh(strict=strict)


def _wait_for_existing_login_transition(
    page,
    previous_page_type: str,
    *,
    cancel_check: Optional[Callable[[], bool]] = None,
    timeout: int = 20,
) -> dict:
    deadline = time.monotonic() + max(int(timeout or 0), 1)
    last_state = _derive_registration_state_from_page(page)
    while time.monotonic() < deadline:
        _raise_if_cancelled(cancel_check)
        state = _derive_registration_state_from_page(page)
        last_state = state
        page_type = str(state.get("page_type") or "")
        if page_type and page_type != previous_page_type:
            return state
        _cancelable_sleep(0.25, cancel_check)
    return last_state


def _restore_existing_account_session(
    page,
    *,
    email: str,
    cookies: Any,
    otp_callback,
    expected_account_id: str = "",
    log: Callable[[str], None] = print,
    cancel_check: Optional[Callable[[], bool]] = None,
    deadline: float | None = None,
) -> dict:
    """Restore an existing account and never enter account-creation states."""
    bounded_cancel_check = (
        _password_settings_cancel_check(deadline, cancel_check)
        if deadline is not None
        else cancel_check
    )
    _raise_if_cancelled(bounded_cancel_check)
    context = page.context
    context.clear_cookies()
    playwright_cookies = _cookie_header_to_playwright_cookies(cookies)
    chatgpt_header_bytes = _estimated_cookie_header_bytes(
        playwright_cookies,
        CHATGPT_APP,
    )
    if chatgpt_header_bytes >= PASSWORD_CHATGPT_COOKIE_HEADER_MAX_BYTES:
        log(
            "现有账号 ChatGPT Cookie header 域映射后仍超过安全上限，"
            "跳过 Cookie Session 恢复"
        )
        playwright_cookies = []
    if playwright_cookies:
        context.add_cookies(playwright_cookies)
        log(
            f"已按域注入现有账号 Cookie（{len(playwright_cookies)} 项，"
            f"ChatGPT header 估算 {chatgpt_header_bytes} bytes）"
        )
        try:
            _goto_with_retry(
                page,
                f"{CHATGPT_APP}/",
                wait_until="domcontentloaded",
                timeout=30000,
                log=log,
                deadline=deadline,
                cancel_check=bounded_cancel_check,
            )
            session_info = _fetch_chatgpt_session_from_page(page, _get_cookies(page), log, timeout=10)
            _validate_existing_account_session(
                session_info,
                expected_email=email,
                expected_account_id=expected_account_id,
            )
            if _password_expired_session_modal_visible(page):
                raise PasswordAccountSessionExpired("ChatGPT Session UI 已过期")
            log("现有账号 Session 恢复成功")
            return session_info
        except ExistingAccountIdentityMismatch:
            raise
        except Exception as exc:
            log(f"现有账号 Cookie 已失效，切换同邮箱 OTP 登录: {_sanitize_password_error(exc)}")

    if not otp_callback:
        raise RuntimeError("现有账号 Session 已失效且原邮箱 OTP callback 不可用")

    if deadline is None:
        _refresh_otp_baseline(otp_callback, strict=True)
    else:
        _run_password_callback_with_deadline(
            lambda: _refresh_otp_baseline(otp_callback, strict=True),
            deadline=deadline,
            cancel_check=cancel_check,
            label="同邮箱 OTP 登录前刷新邮件基线",
            cancel_wait_target=otp_callback,
        )
    context.clear_cookies()
    device_id = str(uuid.uuid4())
    _seed_browser_device_id(page, device_id)
    state = _start_browser_signup_via_authorize(page, email, device_id, log)

    forbidden_states = {"create_account_password", "password", "about_you", "add_phone"}
    seen: dict[str, int] = {}
    for _ in range(10):
        _raise_if_cancelled(bounded_cancel_check)
        page_type = str(state.get("page_type") or "")
        signature = f"{page_type}|{state.get('current_url') or ''}|{state.get('continue_url') or ''}"
        seen[signature] = seen.get(signature, 0) + 1
        if seen[signature] > 2:
            raise RuntimeError(f"同邮箱登录状态卡住: page={page_type or '-'}")

        if page_type in forbidden_states:
            raise RuntimeError(f"同邮箱登录进入禁止的新注册状态: page={page_type}")

        if _is_registration_complete(state):
            session_info = _fetch_chatgpt_session_from_page(page, _get_cookies(page), log, timeout=20)
            _validate_existing_account_session(
                session_info,
                expected_email=email,
                expected_account_id=expected_account_id,
            )
            log("同邮箱 OTP 登录已恢复现有账号 Session")
            return session_info

        if page_type == "login_password":
            if not _click_passwordless_login_if_available(page, log, context="现有账号登录"):
                raise RuntimeError("现有账号登录只允许一次性验证码，页面未提供 passwordless 入口")
            state = _wait_for_existing_login_transition(
                page,
                page_type,
                cancel_check=bounded_cancel_check,
            )
            continue

        if _is_email_otp(state):
            code = (
                otp_callback()
                if deadline is None
                else _run_password_callback_with_deadline(
                    otp_callback,
                    deadline=deadline,
                    cancel_check=cancel_check,
                    label="等待同邮箱登录验证码",
                    cancel_wait_target=otp_callback,
                )
            )
            _raise_if_cancelled(bounded_cancel_check)
            if not code:
                raise RuntimeError("原邮箱未获取到登录验证码")
            if deadline is None:
                response = _submit_otp_via_page(
                    page,
                    code,
                    log,
                    cancel_check=bounded_cancel_check,
                )
            else:
                response = _submit_otp_via_page(
                    page,
                    code,
                    log,
                    cancel_check=bounded_cancel_check,
                    deadline=deadline,
                )
            if not response.get("ok"):
                raise RuntimeError("原邮箱登录验证码校验失败")
            state = _extract_flow_state(response.get("data"), response.get("url", page.url))
            if not state.get("page_type") or _is_email_otp(state):
                state = _wait_for_existing_login_transition(
                    page,
                    "email_otp_verification",
                    cancel_check=bounded_cancel_check,
                )
            continue

        if _requires_registration_navigation(state):
            target = _normalize_url(
                str(state.get("continue_url") or state.get("current_url") or ""),
                OPENAI_AUTH,
            )
            hostname = str(urlparse(target).hostname or "").lower()
            if not target or not (
                hostname == "openai.com"
                or hostname.endswith(".openai.com")
                or hostname == "chatgpt.com"
                or hostname.endswith(".chatgpt.com")
            ):
                raise RuntimeError("同邮箱登录返回了不允许的跳转地址")
            _goto_with_retry(
                page,
                target,
                wait_until="domcontentloaded",
                timeout=30000,
                log=log,
                deadline=deadline,
                cancel_check=bounded_cancel_check,
            )
            state = _derive_registration_state_from_page(page)
            continue

        state = _wait_for_existing_login_transition(
            page,
            page_type,
            cancel_check=bounded_cancel_check,
            timeout=5,
        )

    raise RuntimeError("同邮箱登录状态机超出最大步数")


def _decode_jwt_payload_no_verify(token: str) -> dict:
    try:
        parts = str(token or "").split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        raw = base64.urlsafe_b64decode(payload.encode("ascii"))
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _extract_chatgpt_account_id(access_token: str) -> str:
    payload = _decode_jwt_payload_no_verify(access_token)
    auth_info = payload.get("https://api.openai.com/auth") or {}
    if isinstance(auth_info, dict):
        account_id = str(auth_info.get("chatgpt_account_id") or "").strip()
        if account_id:
            return account_id
    return str(payload.get("sub") or "").strip()


def _chatgpt_session_result_from_data(data: dict, page, cookies_dict: dict, log) -> tuple[dict | None, str]:
    if not isinstance(data, dict):
        return None, "session API JSON 不是对象"

    access_token = str(data.get("accessToken") or data.get("access_token") or "").strip()
    if not access_token:
        return None, "session API 未返回 accessToken"

    latest_cookies = dict(cookies_dict or {})
    try:
        latest_cookies.update(_get_cookies(page))
    except Exception as exc:
        log(f"ChatGPT session cookies 读取失败，使用已捕获 cookies: {exc}")
    session_token = str(latest_cookies.get("__Secure-next-auth.session-token") or "").strip()
    account_id = _extract_chatgpt_account_id(access_token)
    result = {
        "access_token": access_token,
        "refresh_token": str(data.get("refreshToken") or data.get("refresh_token") or "").strip(),
        "id_token": str(data.get("idToken") or data.get("id_token") or "").strip(),
        "session_token": session_token,
        "account_id": account_id,
        "workspace_id": str(data.get("workspaceId") or data.get("workspace_id") or "").strip(),
        "profile": data.get("user") if isinstance(data.get("user"), dict) else {},
        "expires_at": str(data.get("expires") or "").strip(),
        "cookies": _cookies_to_header(latest_cookies),
        "session": data,
    }
    log(
        "ChatGPT session 获取成功: "
        f"accessToken=yes, session_token={'yes' if session_token else 'no'}, "
        f"account_id={account_id or '-'}"
    )
    return result, ""


def _chatgpt_session_result_from_text(text: str, page, cookies_dict: dict, log) -> tuple[dict | None, str]:
    try:
        data = json.loads(text)
    except Exception as exc:
        return None, f"session API JSON 解析失败: {exc}"
    return _chatgpt_session_result_from_data(data, page, cookies_dict, log)


def _fetch_chatgpt_session_via_same_origin(page, cookies_dict: dict, log, session_url: str) -> tuple[dict | None, str, bool]:
    current_url = str(getattr(page, "url", "") or "")
    if "chatgpt.com" not in current_url.lower():
        return None, "", False

    log(f"浏览器内请求 ChatGPT session API: {session_url}")
    try:
        payload = page.evaluate(
            """
            async (sessionUrl) => {
              const response = await fetch(sessionUrl, {
                method: "GET",
                credentials: "include",
                headers: { "accept": "application/json" },
              });
              return {
                status: response.status,
                url: response.url,
                text: await response.text(),
              };
            }
            """,
            session_url,
        )
    except Exception as exc:
        return None, str(exc), True

    if not isinstance(payload, dict):
        return None, "session API 浏览器内请求未返回对象", True

    status = int(payload.get("status") or 0)
    response_url = str(payload.get("url") or "")
    text = str(payload.get("text") or "")
    log(f"ChatGPT session API 浏览器内请求状态: {status} url={response_url[:120]}")
    if status == 200 and text:
        return (*_chatgpt_session_result_from_text(text, page, cookies_dict, log), True)
    return None, f"session API HTTP {status}: {text[:200]}", True


def _fetch_chatgpt_session_from_page(page, cookies_dict: dict, log, timeout: int = 45) -> dict:
    deadline = time.time() + max(int(timeout or 0), 5)
    last_error = ""
    session_url = f"{CHATGPT_APP}/api/auth/session"
    log(f"打开 ChatGPT session API: {session_url}")

    while time.time() < deadline:
        same_origin_result, same_origin_error, same_origin_attempted = _fetch_chatgpt_session_via_same_origin(
            page,
            cookies_dict,
            log,
            session_url,
        )
        if same_origin_result:
            return same_origin_result
        if same_origin_attempted and same_origin_error:
            last_error = same_origin_error
            log(f"ChatGPT session API 浏览器内请求暂未拿到 token: {last_error}")
            if "object has no attribute 'evaluate'" not in last_error:
                time.sleep(2)
                continue

        try:
            response = page.goto(session_url, wait_until="domcontentloaded", timeout=15000)
            status = int(response.status if response else 0)
            if response:
                try:
                    text = response.text()
                except Exception as body_exc:
                    last_error = str(body_exc)
                    log(f"ChatGPT session API 响应体不可直接读取，改读页面正文: {last_error}")
                    text = page.locator("body").inner_text(timeout=3000)
            else:
                text = page.locator("body").inner_text(timeout=3000)
            current_url = str(getattr(page, "url", "") or "")
            log(f"ChatGPT session API 状态: {status} url={current_url[:120]}")
            if status == 200 and text:
                result, error = _chatgpt_session_result_from_text(text, page, cookies_dict, log)
                if result:
                    return result
                last_error = error
            else:
                last_error = f"session API HTTP {status}: {text[:200]}"
            log(f"ChatGPT session API 暂未拿到 token: {last_error}")
        except Exception as exc:
            last_error = str(exc)
            log(f"ChatGPT session API 打开异常: {last_error}")
        time.sleep(2)

    raise RuntimeError(f"ChatGPT session 未返回 accessToken: {last_error}")


def _random_chrome_ua() -> str:
    patch = random.randint(0, 220)
    return (
        f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/136.0.7103.{patch} Safari/537.36"
    )


def _infer_sec_ch_ua(user_agent: str) -> str:
    match = re.search(r"Chrome/(\d+)", str(user_agent or ""))
    major = str(match.group(1) if match else "136")
    return f'"Chromium";v="{major}", "Google Chrome";v="{major}", "Not.A/Brand";v="99"'


def _build_browser_headers(
    *,
    user_agent: str,
    accept: str,
    referer: str = "",
    origin: str = "",
    content_type: str = "",
    navigation: bool = False,
    extra_headers: dict | None = None,
) -> dict:
    headers = {
        "user-agent": user_agent or _random_chrome_ua(),
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": _infer_sec_ch_ua(user_agent),
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "accept": accept,
    }
    if referer:
        headers["referer"] = referer
    if origin:
        headers["origin"] = origin
    if content_type:
        headers["content-type"] = content_type
    if navigation:
        headers["sec-fetch-dest"] = "document"
        headers["sec-fetch-mode"] = "navigate"
        headers["sec-fetch-user"] = "?1"
        headers["upgrade-insecure-requests"] = "1"
    else:
        headers["sec-fetch-dest"] = "empty"
        headers["sec-fetch-mode"] = "cors"
    for key, value in dict(extra_headers or {}).items():
        if value is not None:
            headers[key] = value
    return headers


def _browser_pause(page, *, headed: bool = True):
    delay_ms = random.randint(150, 450) if headed else random.randint(60, 180)
    try:
        page.wait_for_timeout(delay_ms)
    except Exception:
        time.sleep(delay_ms / 1000)


def _generate_datadog_trace_headers() -> dict:
    trace_hex = secrets.token_hex(8).rjust(16, "0")
    parent_hex = secrets.token_hex(8).rjust(16, "0")
    trace_id = str(int(trace_hex, 16))
    parent_id = str(int(parent_hex, 16))
    return {
        "traceparent": f"00-0000000000000000{trace_hex}-{parent_hex}-01",
        "tracestate": "dd=s:1;o:rum",
        "x-datadog-origin": "rum",
        "x-datadog-parent-id": parent_id,
        "x-datadog-sampling-priority": "1",
        "x-datadog-trace-id": trace_id,
    }


def _infer_page_type(data: dict | None, current_url: str = "") -> str:
    raw = data if isinstance(data, dict) else {}
    url = (current_url or "").lower()
    if "add-phone" in url or "phone-verification" in url:
        return "add_phone"
    page_type = str(((raw.get("page") or {}).get("type")) or "").strip().lower().replace("-", "_").replace("/", "_").replace(" ", "_")
    if page_type:
        if page_type in {"phone_verification", "phone_otp_verification"}:
            return "add_phone"
        return page_type
    if "code=" in url:
        return "oauth_callback"
    if "create-account/password" in url:
        return "create_account_password"
    if "email-verification" in url or "email-otp" in url:
        return "email_otp_verification"
    if "about-you" in url:
        return "about_you"
    if "log-in/password" in url:
        return "login_password"
    if "sign-in-with-chatgpt" in url and "consent" in url:
        return "consent"
    if "workspace" in url and "select" in url:
        return "workspace_selection"
    if "organization" in url and "select" in url:
        return "organization_selection"
    if "/api/oauth/oauth2/auth" in url:
        return "external_url"
    if "chatgpt.com" in url:
        return "chatgpt_home"
    return ""


def _extract_flow_state(data: dict | None, current_url: str = "") -> dict:
    raw = data if isinstance(data, dict) else {}
    page = raw.get("page") or {}
    payload = page.get("payload") or {}
    continue_url = str(raw.get("continue_url") or payload.get("url") or "").strip()
    if continue_url and continue_url.startswith("/"):
        continue_url = urljoin(OPENAI_AUTH, continue_url)
    effective_url = continue_url or current_url
    return {
        "page_type": _infer_page_type(raw, effective_url),
        "continue_url": continue_url,
        "method": str(raw.get("method") or payload.get("method") or "GET").upper(),
        "current_url": effective_url,
        "payload": payload if isinstance(payload, dict) else {},
        "raw": raw,
    }


def _extract_code_from_url(url: str) -> str:
    if not url or "code=" not in url:
        return ""
    try:
        from urllib.parse import parse_qs, urlparse as _up

        parsed = _up(url)
        values = parse_qs(parsed.query, keep_blank_values=True)
        return str((values.get("code") or [""])[0] or "").strip()
    except Exception:
        return ""


def _normalize_url(target_url: str, base_url: str = OPENAI_AUTH) -> str:
    value = str(target_url or "").strip()
    if not value:
        return ""
    if value.startswith(("http://", "https://")):
        return value
    try:
        return urljoin(base_url, value)
    except Exception:
        return value


def _decode_jwt_payload(token: str) -> dict:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        pad = "=" * ((4 - (len(payload) % 4)) % 4)
        return json.loads(base64.urlsafe_b64decode((payload + pad).encode("ascii")).decode("utf-8"))
    except Exception:
        return {}


class _SentinelTokenGenerator:
    def __init__(self, device_id: str, user_agent: str):
        self.device_id = device_id or str(uuid.uuid4())
        self.user_agent = user_agent or _random_chrome_ua()
        self.sid = str(uuid.uuid4())

    @staticmethod
    def _fnv1a32(text: str) -> str:
        h = 2166136261
        for ch in text:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        h ^= (h >> 16)
        h = (h * 2246822507) & 0xFFFFFFFF
        h ^= (h >> 13)
        h = (h * 3266489909) & 0xFFFFFFFF
        h ^= (h >> 16)
        return f"{h & 0xFFFFFFFF:08x}"

    @staticmethod
    def _b64(data) -> str:
        return base64.b64encode(json.dumps(data, separators=(",", ":")).encode("utf-8")).decode("ascii")

    def _config(self) -> list:
        perf_now = 1000 + random.random() * 49000
        return [
            "1920x1080",
            time.strftime("%a, %d %b %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime()),
            4294705152,
            random.random(),
            self.user_agent,
            SENTINEL_SDK_URL,
            None,
            None,
            "en-US",
            "en-US,en",
            random.random(),
            "webkitTemporaryStorage−undefined",
            "location",
            "Object",
            perf_now,
            self.sid,
            "",
            random.choice([4, 8, 12, 16]),
            int(time.time() * 1000 - perf_now),
        ]

    def generate_requirements_token(self) -> str:
        cfg = self._config()
        cfg[3] = 1
        cfg[9] = round(5 + random.random() * 45)
        return "gAAAAAC" + self._b64(cfg)

    def generate_token(self, seed: str, difficulty: str) -> str:
        max_attempts = 500000
        cfg = self._config()
        start_ms = int(time.time() * 1000)
        diff = str(difficulty or "0")
        for nonce in range(max_attempts):
            cfg[3] = nonce
            cfg[9] = round(int(time.time() * 1000) - start_ms)
            encoded = self._b64(cfg)
            digest = self._fnv1a32((seed or "") + encoded)
            if digest[: len(diff)] <= diff:
                return "gAAAAAB" + encoded + "~S"
        return "gAAAAAB" + self._b64(None)


def _browser_fetch(page, url: str, *, method: str = "GET", headers: dict | None = None, body: str | None = None, redirect: str = "manual", timeout_ms: int = 30000) -> dict:
    return page.evaluate(
        """
        async ({ url, method, headers, body, redirect, timeoutMs }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs);
          try {
            const resp = await fetch(url, {
              method,
              headers: headers || {},
              body: body === null ? undefined : body,
              redirect,
              signal: controller.signal,
            });
            const respHeaders = {};
            resp.headers.forEach((v, k) => { respHeaders[k] = v; });
            let text = '';
            try { text = await resp.text(); } catch {}
            let data = null;
            try { data = JSON.parse(text); } catch {}
            return { ok: resp.ok, status: resp.status, url: resp.url || url, headers: respHeaders, text, data };
          } catch (e) {
            return { ok: false, status: 0, url, headers: {}, text: String(e && e.message || e), data: null };
          } finally {
            clearTimeout(timer);
          }
        }
        """,
        {
            "url": url,
            "method": method,
            "headers": headers or {},
            "body": body,
            "redirect": redirect,
            "timeoutMs": timeout_ms,
        },
    )


def _build_browser_sentinel_token(page, device_id: str, flow: str, user_agent: str) -> str:
    generator = _SentinelTokenGenerator(device_id, user_agent)
    req_body = json.dumps(
        {"p": generator.generate_requirements_token(), "id": device_id, "flow": flow},
        separators=(",", ":"),
    )
    result = _browser_fetch(
        page,
        SENTINEL_REQ_URL,
        method="POST",
        headers=_build_browser_headers(
            user_agent=user_agent,
            accept="*/*",
            referer=SENTINEL_FRAME_URL,
            origin=SENTINEL_BASE,
            content_type="text/plain;charset=UTF-8",
            extra_headers={
                "sec-fetch-site": "same-origin",
            },
        ),
        body=req_body,
        redirect="follow",
    )
    data = result.get("data") or {}
    challenge_token = str(data.get("token") or "").strip()
    if not challenge_token:
        return ""
    pow_meta = data.get("proofofwork") or {}
    if pow_meta.get("required") and pow_meta.get("seed"):
        p_value = generator.generate_token(str(pow_meta.get("seed") or ""), str(pow_meta.get("difficulty") or "0"))
    else:
        p_value = generator.generate_requirements_token()
    return json.dumps(
        {
            "p": p_value,
            "t": "",
            "c": challenge_token,
            "id": device_id,
            "flow": flow,
        },
        separators=(",", ":"),
    )


def _submit_browser_user_register(page, email: str, password: str, device_id: str, user_agent: str) -> dict:
    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=f"{OPENAI_AUTH}/create-account/password",
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )
    sentinel = _build_browser_sentinel_token(page, device_id, "username_password_create", user_agent)
    if sentinel:
        headers["openai-sentinel-token"] = sentinel
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/user/register",
        method="POST",
        headers=headers,
        body=json.dumps({"username": email, "password": password}),
        redirect="follow",
    )


def _send_browser_email_otp(page) -> dict:
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/email-otp/send",
        method="GET",
        headers={
            "accept": "application/json, text/plain, */*",
            "referer": f"{OPENAI_AUTH}/create-account/password",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "accept-language": "en-US,en;q=0.9",
        },
        redirect="follow",
    )


def _decode_oauth_session_cookie(cookies_dict: dict) -> dict:
    raw = str(cookies_dict.get("oai-client-auth-session") or "").strip()
    if not raw:
        return {}
    first = raw.split(".")[0]
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            pad = "=" * ((4 - (len(first) % 4)) % 4)
            decoded = decoder((first + pad).encode("ascii")).decode("utf-8")
            parsed = json.loads(decoded)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def _extract_workspace_from_consent_html(session, consent_url: str) -> dict:
    try:
        response = session.get(consent_url, allow_redirects=True, timeout=30)
        html = response.text or ""
        if "workspaces" not in html:
            return {}
        ids = re.findall(r'"id"(?:,|:)"([0-9a-f-]{36})"', html, flags=re.I)
        kinds = re.findall(r'"kind"(?:,|:)"([^"]+)"', html, flags=re.I)
        if not ids:
            return {}
        seen: set[str] = set()
        workspaces: list[dict] = []
        for idx, workspace_id in enumerate(ids):
            if workspace_id in seen:
                continue
            seen.add(workspace_id)
            item = {"id": workspace_id}
            if idx < len(kinds):
                item["kind"] = kinds[idx]
            workspaces.append(item)
        return {"workspaces": workspaces} if workspaces else {}
    except Exception:
        return {}


def _seed_session_cookies(session, cookies_dict: dict):
    for name, value in cookies_dict.items():
        for domain in [".openai.com", ".chatgpt.com", ".auth.openai.com", "auth.openai.com", "chatgpt.com"]:
            try:
                session.cookies.set(name, value, domain=domain, path="/")
            except Exception:
                pass


def _follow_redirects_for_code(session, start_url: str, log, *, max_redirects: int = 12) -> str:
    current_url = start_url
    for idx in range(max_redirects):
        response = session.get(current_url, allow_redirects=False, timeout=30)
        log(f"  redirect-follow[{idx+1}] {response.status_code} {str(current_url)[:140]}")
        location = str(response.headers.get("Location") or "").strip()
        if not location:
            break
        next_url = urljoin(current_url, location)
        code = _extract_code_from_url(next_url)
        if code:
            return next_url
        if response.status_code not in (301, 302, 303, 307, 308):
            break
        current_url = next_url
    return ""


def _complete_oauth_with_session(cookies_dict: dict, oauth_start, proxy: str | None, log) -> dict | None:
    from .oauth import submit_callback_url
    from curl_cffi import requests as cffi_requests

    s = cffi_requests.Session(impersonate="chrome131")
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    _seed_session_cookies(s, cookies_dict)

    try:
        session_meta = _decode_oauth_session_cookie(cookies_dict)
        consent_url = "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"
        workspaces = list(session_meta.get("workspaces") or [])
        if not workspaces:
            session_meta = _extract_workspace_from_consent_html(s, consent_url)
            workspaces = list(session_meta.get("workspaces") or [])
        if not workspaces:
            log("  ⚠️ 缺少 oai-client-auth-session workspaces，OAuth 失败")
            return None
        workspace_id = str((workspaces[0] or {}).get("id") or "").strip()
        log(f"  选择 workspace: {workspace_id}")
        ws_resp = s.post(
            "https://auth.openai.com/api/accounts/workspace/select",
            headers={
                "accept": "application/json",
                "referer": consent_url,
                "origin": OPENAI_AUTH,
                "content-type": "application/json",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
            },
            data=json.dumps({"workspace_id": workspace_id}),
            allow_redirects=False,
            timeout=30,
        )
        log(f"  workspace/select -> {ws_resp.status_code}")

        next_url = str(ws_resp.headers.get("Location") or "").strip()
        next_data = {}
        if not next_url:
            try:
                next_data = ws_resp.json() or {}
            except Exception:
                next_data = {}
            next_url = str(next_data.get("continue_url") or "").strip()
        next_url = _normalize_url(next_url, consent_url)
        direct_code = _extract_code_from_url(next_url)
        if direct_code:
            result_json = submit_callback_url(
                callback_url=next_url,
                expected_state=oauth_start.state,
                code_verifier=oauth_start.code_verifier,
                proxy_url=proxy,
            )
            return json.loads(result_json)

        orgs = list((((next_data.get("data") or {}).get("orgs")) or []))
        if orgs and orgs[0].get("id"):
            org_id = str(orgs[0].get("id") or "").strip()
            org_body = {"org_id": org_id}
            projects = list(orgs[0].get("projects") or [])
            if projects and projects[0].get("id"):
                org_body["project_id"] = str(projects[0].get("id") or "").strip()
            log(f"  选择 organization: {org_id}")
            org_resp = s.post(
                "https://auth.openai.com/api/accounts/organization/select",
                headers={
                    "accept": "application/json",
                    "referer": consent_url,
                    "origin": OPENAI_AUTH,
                    "content-type": "application/json",
                    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
                },
                data=json.dumps(org_body),
                allow_redirects=False,
                timeout=30,
            )
            log(f"  organization/select -> {org_resp.status_code}")
            next_url = str(org_resp.headers.get("Location") or "").strip() or next_url
            if not next_url:
                try:
                    org_data = org_resp.json() or {}
                    next_url = str(org_data.get("continue_url") or "").strip()
                    if not next_url:
                        org_state = _extract_flow_state(org_data, str(org_resp.url))
                        next_url = org_state.get("continue_url") or org_state.get("current_url") or ""
                except Exception:
                    next_url = ""
            next_url = _normalize_url(next_url, consent_url)

        if not next_url and next_data:
            state = _extract_flow_state(next_data, str(ws_resp.url))
            next_url = state.get("continue_url") or state.get("current_url") or ""
            next_url = _normalize_url(next_url, consent_url)

        if not next_url:
            next_url = "https://auth.openai.com/api/oauth/oauth2/auth?" + oauth_start.auth_url.split("?", 1)[1]

        callback_url = _follow_redirects_for_code(s, next_url, log)
        if not callback_url:
            log("  ⚠️ 未能跟到 OAuth callback")
            return None
        result_json = submit_callback_url(
            callback_url=callback_url,
            expected_state=oauth_start.state,
            code_verifier=oauth_start.code_verifier,
            proxy_url=proxy,
        )
        return json.loads(result_json)
    except Exception as e:
        log(f"  OAuth 会话补全异常: {e}")
        return None


def _submit_callback_result(callback_url: str, oauth_start, proxy: str | None) -> dict:
    from .oauth import submit_callback_url

    result_json = submit_callback_url(
        callback_url=callback_url,
        expected_state=oauth_start.state,
        code_verifier=oauth_start.code_verifier,
        redirect_uri=oauth_start.redirect_uri,
        client_id=oauth_start.client_id,
        proxy_url=proxy,
    )
    return json.loads(result_json)


def _wait_for_oauth_callback_result(
    page,
    oauth_start,
    proxy: str | None,
    log,
    *,
    timeout_sec: int = 90,
) -> dict | None:
    """Wait for the browser to land on the localhost OAuth callback and exchange it."""
    deadline = time.time() + max(int(timeout_sec or 0), 1)
    seen_urls: set[str] = set()

    while time.time() < deadline:
        candidates: list[str] = []
        try:
            candidates.append(str(page.url or ""))
        except Exception:
            pass
        try:
            location_href = str(page.evaluate("() => location.href") or "")
            if location_href:
                candidates.append(location_href)
        except Exception:
            pass

        for url in candidates:
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            if "localhost" in url or "code=" in url:
                log(f"  OAuth callback wait 检测到 URL: {url[:160]}")
            if not _extract_code_from_url(url):
                continue
            try:
                result = _submit_callback_result(url, oauth_start, proxy)
                log("  OAuth callback 已换取 token")
                return result
            except Exception as exc:
                log(f"  OAuth callback token exchange 失败: {exc}")
                return {"error": f"OAuth callback token exchange 失败: {exc}"}
        time.sleep(0.8)
    return None


def _extract_callback_url_from_exception(exc: Exception) -> str:
    text = str(exc or "")
    if not text:
        return ""
    match = re.search(r"(https?://localhost[^\s\"')]+)", text, flags=re.I)
    if not match:
        return ""
    callback_url = str(match.group(1) or "").strip().rstrip(".,")
    return callback_url if _extract_code_from_url(callback_url) else ""


def _derive_oauth_state_from_page(page) -> dict:
    state = _derive_registration_state_from_page(page)
    if state.get("page_type"):
        return state
    current_url = str(page.url or "")
    if _find_first_selector(page, EMAIL_INPUT_SELECTORS):
        return _build_manual_flow_state("login_email", current_url)
    return _extract_flow_state(None, current_url)


def _submit_login_email_via_page(page, email: str, log) -> dict:
    start_url = str(page.url or "")
    last_url = start_url
    last_text = ""

    for submit_attempt in range(1, 4):
        input_selector = _wait_for_any_selector(page, EMAIL_INPUT_SELECTORS, timeout=15)
        if not input_selector:
            retry_state = _auth_timeout_retry_page_state(page, path_patterns=[r"/log-in(?:[/?#]|$)", r"/email-verification(?:[/?#]|$)"])
            if retry_state.get("retryPage"):
                recovery = _recover_auth_timeout_retry_page(
                    page,
                    log,
                    path_patterns=[r"/log-in(?:[/?#]|$)", r"/email-verification(?:[/?#]|$)"],
                )
                if recovery.get("recovered"):
                    continue
            raise RuntimeError("OAuth 邮箱页未找到输入框")
        if not _fill_input_like_user(page, input_selector, email):
            raise RuntimeError("OAuth 邮箱页填写失败")
        log(f"OAuth 邮箱页输入框: {input_selector}")
        _browser_pause(page)

        submit_selector = _click_first_no_wait(page, EMAIL_SUBMIT_SELECTORS, timeout=8)
        if submit_selector:
            log(f"OAuth 邮箱页已点击继续按钮: {submit_selector}")
        elif _submit_form_with_fallback(page, input_selector):
            log("OAuth 邮箱页未找到可点击 Continue，已使用表单 fallback 提交")
        else:
            raise RuntimeError("OAuth 邮箱页未找到 Continue 按钮")

        deadline = time.time() + 20
        while time.time() < deadline:
            current_url = str(page.url or "")
            last_url = current_url or last_url
            retry_state = _auth_timeout_retry_page_state(page, path_patterns=[r"/log-in(?:[/?#]|$)", r"/email-verification(?:[/?#]|$)"])
            if retry_state.get("retryPage"):
                last_text = str(retry_state.get("text") or "")
                recovery = _recover_auth_timeout_retry_page(
                    page,
                    log,
                    path_patterns=[r"/log-in(?:[/?#]|$)", r"/email-verification(?:[/?#]|$)"],
                )
                if recovery.get("recovered"):
                    time.sleep(0.8)
                    state = _derive_oauth_state_from_page(page)
                    page_type = str(state.get("page_type") or "")
                    if page_type and page_type != "login_email":
                        return {"ok": True, "status": 200, "url": str(page.url or ""), "data": None, "text": ""}
                    break
                return {"ok": False, "status": 0, "url": str(recovery.get("url") or current_url), "data": None, "text": str(recovery.get("text") or "OpenAI auth retry page recovery failed")}

            if _click_passwordless_login_if_available(page, log, context="OAuth 邮箱页提交后"):
                time.sleep(0.5)
                continue
            state = _derive_oauth_state_from_page(page)
            page_type = str(state.get("page_type") or "")
            if page_type in {
                "login_password",
                "create_account_password",
                "email_otp_verification",
                "about_you",
                "consent",
                "workspace_selection",
                "organization_selection",
                "add_phone",
                "external_url",
                "oauth_callback",
                "chatgpt_home",
            }:
                return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
            if current_url != start_url and page_type != "login_email":
                return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
            error_text = _extract_auth_error_text(page)
            if error_text:
                return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
            time.sleep(0.5)
        log(f"OAuth 邮箱页提交后未跳转，准备重试提交 ({submit_attempt}/3)")

    return {"ok": False, "status": 0, "url": last_url, "data": None, "text": last_text or "OAuth 邮箱页提交后未跳转"}


def _do_codex_oauth(
    page,
    cookies_dict: dict,
    email: str,
    password: str,
    otp_callback,
    phone_callback,
    proxy: str | None,
    log,
    *,
    allow_add_phone_retry: bool = True,
    oauth_start=None,
) -> dict | None:
    """在真实浏览器会话内完成 Codex OAuth，返回完整 token 包。

    如果传入 ``oauth_start``，则使用预生成的 OAuth 参数（重用 state/code_verifier），
    这样外层可以用同一 code_verifier 完成 token 交换（fallback 场景）。
    """
    from .oauth import generate_oauth_url
    from .constants import CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CODEX_SCOPE

    if oauth_start is None:
        oauth_start = generate_oauth_url(
            redirect_uri=CODEX_REDIRECT_URI,
            scope=CODEX_SCOPE,
            client_id=CODEX_CLIENT_ID,
        )
    try:
        user_agent = str(page.evaluate("() => navigator.userAgent") or "").strip() or _random_chrome_ua()
    except Exception:
        user_agent = _random_chrome_ua()
    device_id = str(cookies_dict.get("oai-did") or uuid.uuid4())
    log(f"  Codex OAuth 授权链接: {oauth_start.auth_url}")
    log(f"  OAuth state={oauth_start.state[:20]}...")

    try:
        try:
            _goto_with_retry(page, oauth_start.auth_url, wait_until="domcontentloaded", timeout=30000, log=log)
        except Exception as exc:
            callback_url = _extract_callback_url_from_exception(exc)
            if callback_url:
                log(f"  OAuth bootstrap 直接捕获 callback: {callback_url[:100]}...")
                return _submit_callback_result(callback_url, oauth_start, proxy)
            raise

        current_url = str(page.url or "")
        log(f"  OAuth bootstrap -> {current_url[:100]}...")

        for step in range(20):
            state = _derive_oauth_state_from_page(page)
            current_url = str(page.url or "")
            next_url = str(state.get("continue_url") or "").strip()
            log(
                f"  OAuth state step[{step+1}/20]: "
                f"page={state.get('page_type') or '-'} next={next_url[:60]}"
                f" url={current_url[:120]}"
            )

            callback_url = ""
            if _extract_code_from_url(current_url):
                callback_url = current_url
            elif _extract_code_from_url(next_url):
                callback_url = next_url
            if callback_url:
                return _submit_callback_result(callback_url, oauth_start, proxy)

            page_oauth_url = _get_page_oauth_url(page)
            if (
                page_oauth_url
                and page_oauth_url != current_url
                and _oauth_url_matches_state(page_oauth_url, oauth_start.state)
            ):
                log("  OAuth 页面检测到更新的授权链接，跟随页面授权链接...")
                _goto_with_retry(page, page_oauth_url, wait_until="domcontentloaded", timeout=30000, log=log)
                continue

            if state["page_type"] == "login_email":
                log("  OAuth 页面需要邮箱登录，提交邮箱...")
                email_resp = _submit_login_email_via_page(page, email, log)
                log(f"  OAuth 邮箱页提交状态: {email_resp.get('status', 0)}")
                if not email_resp.get("ok"):
                    raise RuntimeError(f"OAuth 邮箱页提交失败: {(email_resp.get('text') or '')[:300]}")
                continue

            if state["page_type"] in {"login_password", "create_account_password"}:
                log("  OAuth 页面需要密码登录，提交密码...")
                # OAuth 流程中直接填密码登录，不尝试恢复到注册态
                password_resp = _submit_oauth_password_direct(page, password, log)
                log(f"  OAuth 密码页提交状态: {password_resp.get('status', 0)}")
                if not password_resp.get("ok"):
                    raise RuntimeError(f"OAuth 密码页提交失败: {(password_resp.get('text') or '')[:300]}")
                continue

            if state["page_type"] == "email_otp_verification":
                if not otp_callback:
                    log("  ⚠️ OAuth 需要邮箱 OTP 但没有 otp_callback")
                    return None
                log("  OAuth 等待邮箱验证码...")
                code = otp_callback()
                if not code:
                    log("  ⚠️ OAuth OTP 获取失败")
                    return None
                otp_resp = _submit_otp_via_page(page, code, log)
                log(f"  OAuth 验证码页提交状态: {otp_resp.get('status', 0)}")
                if not otp_resp.get("ok"):
                    raise RuntimeError(f"OAuth 验证码校验失败: {(otp_resp.get('text') or '')[:300]}")
                continue

            if state["page_type"] == "about_you":
                log("  OAuth 页面出现 about_you，继续页面填写...")
                about_resp = _submit_about_you_via_page(page, log)
                log(f"  OAuth about_you 提交状态: {about_resp.get('status', 0)}")
                if not about_resp.get("ok"):
                    raise RuntimeError(f"OAuth about_you 提交失败: {(about_resp.get('text') or '')[:300]}")
                continue

            if state["page_type"] in {"consent", "workspace_selection", "organization_selection", "external_url"}:
                browser_result = _complete_oauth_in_browser(page, oauth_start, proxy, log)
                if browser_result:
                    return browser_result
                cookies_dict = _get_cookies(page)
                session_result = _complete_oauth_with_session(cookies_dict, oauth_start, proxy, log)
                if session_result:
                    return session_result
                log("  ⚠️ 页面已到 consent/workspace，但会话补全失败")
                return None

            if state["page_type"] == "add_phone":
                if phone_callback:
                    log("  OAuth 检测到 add_phone，优先执行短信验证...")
                    try:
                        _handle_add_phone_challenge(
                            page, phone_callback,
                            device_id=device_id, user_agent=user_agent,
                            log=log, resume_url=oauth_start.auth_url,
                        )
                        callback_result = _wait_for_oauth_callback_result(
                            page,
                            oauth_start,
                            proxy,
                            log,
                            timeout_sec=45,
                        )
                        if callback_result:
                            return callback_result
                        continue
                    except Exception as exc:
                        log(f"  短信验证失败，停止 OAuth 流程: {exc}")
                        return None

                if not allow_add_phone_retry:
                    log("  OAuth 检测到 add_phone，等待手动完成手机号验证并跳转 callback...")
                    callback_result = _wait_for_oauth_callback_result(
                        page,
                        oauth_start,
                        proxy,
                        log,
                        timeout_sec=180,
                    )
                    if callback_result:
                        return callback_result
                    return {"error": "OpenAI OAuth 要求手机号验证，等待后未捕获 callback URL"}

                # 先尝试跳过 add_phone，直接重新访问 OAuth 授权 URL
                # 用户已登录，重新访问 auth URL 应该能直接跳到 callback
                log("  检测到 add_phone，尝试跳过...")
                try:
                    _goto_with_retry(page, oauth_start.auth_url, wait_until="domcontentloaded", timeout=15000, log=log)
                    time.sleep(2)
                    current_url = str(page.url or "")

                    # 检查是否直接拿到了 callback
                    callback_url = ""
                    if "code=" in current_url:
                        callback_url = current_url
                    else:
                        # 可能需要跟随重定向
                        for _ in range(5):
                            time.sleep(1)
                            current_url = str(page.url or "")
                            if "code=" in current_url:
                                callback_url = current_url
                                break

                    if callback_url:
                        log("  ✓ 成功跳过 add_phone，获取到 OAuth callback")
                        return _submit_callback_result(callback_url, oauth_start, proxy)

                    # 检查页面状态
                    skip_state = _derive_registration_state_from_page(page)
                    if skip_state.get("page_type") in {"consent", "workspace_selection", "organization_selection"}:
                        log("  ✓ 跳过 add_phone 到达 consent 页面")
                        # 尝试在浏览器里完成 consent 流程
                        browser_result = _complete_oauth_in_browser(page, oauth_start, proxy, log)
                        if browser_result:
                            return browser_result
                        # 回退到 curl session 方式
                        cookies_dict = _get_cookies(page)
                        session_result = _complete_oauth_with_session(cookies_dict, oauth_start, proxy, log)
                        if session_result:
                            return session_result

                    if skip_state.get("page_type") == "add_phone":
                        log("  跳过失败，仍在 add_phone 页面")
                    else:
                        log(f"  跳过后页面状态: {skip_state.get('page_type') or '-'}")
                        # 继续状态机循环
                        continue

                except Exception as exc:
                    callback_url = _extract_callback_url_from_exception(exc)
                    if callback_url:
                        return _submit_callback_result(callback_url, oauth_start, proxy)
                    log(f"  跳过 add_phone 异常: {exc}")

                log("  ⚠️ add_phone 无法跳过且无可用接码服务")
                return None

            # chatgpt_home: 页面可能正在 JS 重定向（如跳转到 add-phone）
            # 等待更长时间让重定向完成
            if state["page_type"] == "chatgpt_home":
                # 检查是否是错误页面
                if "error" in current_url:
                    error_msg = current_url.split("error=")[-1].split("&")[0] if "error=" in current_url else "unknown"
                    log(f"  OAuth 错误页面: {error_msg} url={current_url[:150]}")
                    raise RuntimeError(f"OpenAI OAuth 错误: {error_msg}")
                time.sleep(2)
                new_url = str(page.url or "")
                if new_url != current_url:
                    continue
                # 检查 cookie 里是否有 session
                cookies_dict = _get_cookies(page)
                for ck, cv in cookies_dict.items():
                    if "session" in ck.lower() and cv:
                        log(f"  chatgpt_home 检测到 session cookie: {ck}")
                        session_result = _complete_oauth_with_session(cookies_dict, oauth_start, proxy, log)
                        if session_result:
                            return session_result
                        break
                continue

            target_url = _normalize_url(state.get("continue_url") or "", OPENAI_AUTH)
            if target_url and target_url != current_url:
                try:
                    _goto_with_retry(page, target_url, wait_until="domcontentloaded", timeout=30000, log=log)
                except Exception as exc:
                    callback_url = _extract_callback_url_from_exception(exc)
                    if callback_url:
                        return _submit_callback_result(callback_url, oauth_start, proxy)
                    log(f"  OAuth navigation failed: {exc}")
                    break
                continue

            error_text = _extract_auth_error_text(page)
            if error_text:
                raise RuntimeError(f"OAuth 页面错误: {error_text[:300]}")
            time.sleep(0.5)
    except Exception as e:
        log(f"  OAuth 异常: {e}")
        return None

    cookies_dict = _get_cookies(page)
    result = _complete_oauth_with_session(cookies_dict, oauth_start, proxy, log)
    if result:
        return result

    session_token = cookies_dict.get("__Secure-next-auth.session-token", "")
    if not session_token:
        log("  ⚠️ 无 session_token，OAuth 失败")
        return None
    log("  ⚠️ 完整 OAuth 失败，回退 session access_token")
    return None


def _wait_for_access_token(page, timeout: int = 60) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = page.evaluate("""
            async () => {
                const r = await fetch('/api/auth/session');
                const j = await r.json();
                return j.accessToken || '';
            }
            """)
            if r:
                return r
        except Exception:
            pass
        time.sleep(2)
    return ""


def _is_registration_complete(state: dict) -> bool:
    page_type = str(state.get("page_type") or "")
    url = str(state.get("current_url") or state.get("continue_url") or "").lower()
    return page_type in {"callback", "oauth_callback", "chatgpt_home"} or (
        "chatgpt.com" in url and "redirect_uri" not in url and "about-you" not in url
    )


def _post_signup_snapshot(page) -> dict:
    try:
        result = page.evaluate(
            r"""
            () => {
              const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return !el.disabled && style.display !== 'none' && style.visibility !== 'hidden'
                  && rect.width > 0 && rect.height > 0;
              };
              const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(visible);
              const links = Array.from(document.querySelectorAll('a[href]')).filter(visible);
              const hrefs = links.map((el) => String(el.getAttribute('href') || '').toLowerCase());
              const appSelectors = [
                '#prompt-textarea',
                '[data-testid="accounts-profile-button"]',
                'textarea[data-id="root"]',
                'main form [contenteditable="true"]',
                'main textarea'
              ];
              let appMarker = '';
              for (const selector of appSelectors) {
                try {
                  if (Array.from(document.querySelectorAll(selector)).some(visible)) {
                    appMarker = selector;
                    break;
                  }
                } catch (_) {}
              }
              const hasTerms = hrefs.some((href) => /terms|policies[/]terms/.test(href));
              const hasPrivacy = hrefs.some((href) => /privacy/.test(href));
              const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
              return {
                url: String(location.href || ''),
                body_text: bodyText.slice(0, 1200),
                visible_button_count: buttons.length,
                has_terms: hasTerms,
                has_privacy: hasPrivacy,
                legal_gate: hasTerms && hasPrivacy && !appMarker && buttons.length > 0,
                app_ready: Boolean(appMarker),
                app_marker: appMarker,
                questionnaire: /what brings you to chatgpt|how do you want to use chatgpt/i.test(bodyText),
              };
            }
            """
        )
    except Exception:
        result = {}
    return result if isinstance(result, dict) else {}


def _click_post_signup_legal_gate(page) -> str:
    try:
        result = page.evaluate(
            """
            () => {
              const visible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return !el.disabled && style.display !== 'none' && style.visibility !== 'hidden'
                  && rect.width > 0 && rect.height > 0;
              };
              const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(visible);
              const explicit = buttons.find((el) => {
                const testId = String(el.getAttribute('data-testid') || '').toLowerCase();
                const action = String(el.getAttribute('data-dd-action-name') || '').toLowerCase();
                return testId.includes('continue') || action === 'continue'
                  || (el.closest('form') && String(el.getAttribute('type') || '').toLowerCase() === 'submit');
              });
              const target = explicit || (buttons.length === 1 ? buttons[0] : null);
              if (!target) return '';
              const descriptor = target.getAttribute('data-testid')
                || target.getAttribute('data-dd-action-name')
                || target.getAttribute('type')
                || target.tagName.toLowerCase();
              target.click();
              return descriptor;
            }
            """
        )
    except Exception:
        return ""
    return str(result or "").strip()


def _handle_post_signup_onboarding(
    page,
    log,
    *,
    timeout: int = 30,
    auto_continue_legal_gate: bool = True,
    manual_continue_timeout: int = 300,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> dict:
    _raise_if_cancelled(cancel_check)
    current_url = str(page.url or "")
    if "chatgpt.com" not in current_url:
        log("注册认证已完成，打开 ChatGPT 主界面处理后续准备页面...")
        _goto_with_retry(page, "https://chatgpt.com/", wait_until="domcontentloaded", timeout=30000, log=log)

    try:
        popup_selectors = [
            'button:has-text("Allow")',
            'button:has-text("allow")',
            'button:has-text("Block")',
            'button:has-text("block")',
            'button:has-text("許可")',
            'button:has-text("ブロック")',
            'button:has-text("拒否")',
        ]
        allow_selector = (
            _click_first(page, popup_selectors, timeout=1)
            if cancel_check is None
            else _click_first(
                page,
                popup_selectors,
                timeout=1,
                cancel_check=cancel_check,
            )
        )
        if allow_selector:
            log(f"已处理浏览器弹窗: {allow_selector}")
    except BrowserTaskCancelled:
        raise
    except Exception:
        pass

    gate_clicked = False
    gate_seen = False
    manual_wait_logged = False
    gate_wait_rounds = 0
    effective_timeout = (
        max(1, int(manual_continue_timeout or 300))
        if not auto_continue_legal_gate
        else max(2, int(timeout or 30))
    )
    rounds = max(4, int(effective_timeout * 2))
    deadline = time.monotonic() + effective_timeout
    gate_stuck_limit = min(20, max(2, rounds - 1))
    last_snapshot = {}
    for _ in range(rounds):
        _raise_if_cancelled(cancel_check)
        if time.monotonic() >= deadline:
            break
        snapshot = _post_signup_snapshot(page)
        last_snapshot = snapshot
        if snapshot.get("app_ready") and not snapshot.get("legal_gate") and not snapshot.get("questionnaire"):
            marker = str(snapshot.get("app_marker") or "-")
            log(f"注册后准备页面已完成，ChatGPT 主界面就绪: {marker}")
            return {
                "post_signup_ready": True,
                "post_signup_gate_handled": gate_seen or gate_clicked,
                "post_signup_app_marker": marker,
                **(
                    {"post_signup_continue_mode": "manual"}
                    if not auto_continue_legal_gate
                    else {}
                ),
            }

        # 问卷属于普通 onboarding，manual 模式仍应自动处理；只有最终的
        # legal/准备完成 Continue 留给用户手动点击。
        if snapshot.get("questionnaire"):
            questionnaire_selectors = [
                'button[data-testid*="skip" i]',
                'button:has-text("Skip")',
                'button:has-text("skip")',
                'button:has-text("Next")',
                'button:has-text("next")',
                'button:has-text("スキップ")',
                'button:has-text("次へ")',
            ]
            skip_selector = (
                _click_first_no_wait(page, questionnaire_selectors, timeout=2)
                if cancel_check is None
                else _click_first_no_wait(
                    page,
                    questionnaire_selectors,
                    timeout=2,
                    cancel_check=cancel_check,
                )
            )
            if skip_selector:
                log(f"已处理 onboarding 问卷页面: {skip_selector}")
                _browser_pause(page)
        elif snapshot.get("legal_gate"):
            gate_seen = True
            if not auto_continue_legal_gate:
                if not manual_wait_logged:
                    log(
                        "已暂停自动点击注册后准备完成页面 Continue；"
                        f"请在内嵌浏览器中手动继续，最长等待 {effective_timeout} 秒"
                    )
                    manual_wait_logged = True
            elif not gate_clicked:
                clicked = _click_post_signup_legal_gate(page)
                if not clicked:
                    _dump_debug(page, "chatgpt_post_signup_gate_click_fail")
                    raise RuntimeError("注册后准备完成页面未找到可点击的继续按钮")
                gate_clicked = True
                gate_wait_rounds = 0
                log(f"已点击注册后准备完成页面继续按钮: {clicked}")
                _browser_pause(page)
            else:
                gate_wait_rounds += 1
                if gate_wait_rounds >= gate_stuck_limit:
                    _dump_debug(page, "chatgpt_post_signup_gate_stuck")
                    raise RuntimeError("注册后准备完成页面点击继续后未消失")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        _cancelable_sleep(min(0.5, remaining), cancel_check)

    _dump_debug(page, "chatgpt_post_signup_not_ready")
    detail = str(last_snapshot.get("body_text") or "")[:200]
    if not auto_continue_legal_gate and gate_seen:
        raise RuntimeError(
            f"等待用户手动点击注册后准备完成页面 Continue 超时（{effective_timeout} 秒）"
        )
    raise RuntimeError(f"注册后未进入可用的 ChatGPT 主界面: {detail or '-'}")


def _eligibility_flag(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if not isinstance(value, dict):
        return None
    for key in (
        "eligible",
        "is_eligible",
        "isEligible",
        "enabled",
        "can_add_password",
        "can_change_password",
    ):
        if isinstance(value.get(key), bool):
            return bool(value[key])
    for key in ("data", "result"):
        nested = _eligibility_flag(value.get(key))
        if nested is not None:
            return nested
    return None


def _password_eligibility(
    page,
    action: str,
    *,
    deadline: float | None = None,
    cancel_check=None,
    timeout_seconds: float = PASSWORD_ELIGIBILITY_FETCH_TIMEOUT_SECONDS,
) -> bool | None:
    normalized = str(action or "").strip().lower()
    if normalized not in {"add", "change"}:
        raise ValueError(f"未知密码资格类型: {action}")
    timeout_cap = max(float(timeout_seconds), 0.001)
    effective_deadline = deadline or (time.monotonic() + timeout_cap)
    bounded_cancel_check = _password_settings_cancel_check(
        effective_deadline,
        cancel_check,
    )
    try:
        _raise_if_cancelled(bounded_cancel_check)
        result = _browser_fetch(
            page,
            f"{CHATGPT_APP}/backend-api/accounts/{normalized}_password/eligibility",
            method="GET",
            headers={
                "accept": "application/json",
                "referer": f"{CHATGPT_APP}/#settings/Security",
                "sec-fetch-site": "same-origin",
            },
            redirect="follow",
            timeout_ms=_password_settings_timeout_ms(
                effective_deadline,
                timeout_cap,
                "检查密码设置资格",
            ),
        )
        _raise_if_cancelled(bounded_cancel_check)
    except (BrowserTaskCancelled, PasswordSettingsTimeout):
        raise
    except Exception:
        return None
    if not isinstance(result, dict) or not result.get("ok"):
        return None
    return _eligibility_flag(result.get("data"))


def _password_settings_snapshot(page) -> dict[str, Any]:
    try:
        result = page.evaluate(
            r"""
            (selector) => {
              const row = document.querySelector(selector);
              if (!row) {
                return {
                  ready: false,
                  row_visible: false,
                  row_disabled: false,
                  testid: '',
                  tag_name: '',
                  button_type: '',
                  configured: false,
                  text: '',
                };
              }
              const style = window.getComputedStyle(row);
              const rect = row.getBoundingClientRect();
              const rowVisible = Boolean(
                style
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
              );
              const rowDisabled = Boolean(
                row.disabled
                || row.hasAttribute('disabled')
                || String(row.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
              );
              const testid = String(row.getAttribute('data-testid') || '');
              const tagName = String(row.tagName || '').toLowerCase();
              const buttonType = String(row.getAttribute('type') || '').toLowerCase();
              const text = String(row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
              const configured = /[*\u2022]{3,}/.test(text)
                || Boolean(row.querySelector('[aria-label*="change password" i], [data-testid*="change-password" i]'));
              return {
                ready: testid === 'password-setting'
                  && tagName === 'button'
                  && buttonType === 'button'
                  && rowVisible
                  && !rowDisabled,
                row_visible: rowVisible,
                row_disabled: rowDisabled,
                testid,
                tag_name: tagName,
                button_type: buttonType,
                configured,
                text,
              };
            }
            """,
            PASSWORD_SETTING_SELECTOR,
        )
    except Exception:
        result = {}
    return result if isinstance(result, dict) else {}


def _open_password_security_settings(
    page,
    log,
    cancel_check=None,
    *,
    deadline: float | None = None,
) -> dict[str, Any]:
    effective_deadline = deadline or (time.monotonic() + 20)
    local_deadline = min(effective_deadline, time.monotonic() + 20)
    bounded_cancel_check = _password_settings_cancel_check(
        effective_deadline,
        cancel_check,
    )
    _raise_if_cancelled(bounded_cancel_check)
    _goto_with_retry(
        page,
        f"{CHATGPT_APP}/open-security-settings",
        wait_until="domcontentloaded",
        timeout=30000,
        log=log,
        deadline=effective_deadline,
        cancel_check=bounded_cancel_check,
    )
    snapshot: dict[str, Any] = {}
    while True:
        _raise_if_cancelled(bounded_cancel_check)
        if _password_expired_session_modal_visible(page):
            raise PasswordAccountSessionExpired("ChatGPT Security Session 已过期")
        local_remaining = local_deadline - time.monotonic()
        if local_remaining <= 0:
            break
        snapshot = _password_settings_snapshot(page)
        if snapshot.get("ready"):
            return snapshot
        _cancelable_sleep(
            min(0.5, local_remaining),
            bounded_cancel_check,
        )
    _raise_if_cancelled(bounded_cancel_check)
    raise RuntimeError("ChatGPT Security 设置页未找到密码设置项")


def _start_password_reauth_via_nextauth(
    page,
    email: str,
    log,
    cancel_check=None,
    *,
    deadline: float | None = None,
    mode: str = "add",
) -> _PasswordReauthEvidence | bool:
    effective_deadline = deadline or (
        time.monotonic() + PASSWORD_SETTINGS_TIMEOUT_SECONDS
    )
    bounded_cancel_check = _password_settings_cancel_check(
        effective_deadline,
        cancel_check,
    )
    normalized_mode = str(mode or "").strip().lower()
    if normalized_mode not in {"add", "change"}:
        raise ValueError("Security 密码设置模式无效")
    _raise_if_cancelled(bounded_cancel_check)
    transaction_id = str(uuid.uuid4())
    dispatch_marker = f"password-reauth-button:{transaction_id}"
    _raise_if_cancelled(bounded_cancel_check)
    try:
        page.click(
            PASSWORD_SETTING_SELECTOR,
            timeout=_password_settings_timeout_ms(
                effective_deadline,
                3,
                "点击 Security 密码设置按钮",
            ),
            no_wait_after=True,
        )
    except Exception as exc:
        raise RuntimeError("Security 密码设置按钮单次点击状态不确定") from exc
    _raise_if_cancelled(bounded_cancel_check)
    log("Security 密码设置按钮已单次点击，等待前端 NextAuth 重新认证")
    return _PasswordReauthEvidence(
        original_email=str(email or "").strip(),
        transaction_id=transaction_id,
        expected_auth_origin=_url_origin(OPENAI_AUTH),
        button_dispatch_marker=dispatch_marker,
        mode=normalized_mode,
    )


def _trigger_password_settings_reauth(
    page,
    email: str,
    otp_callback,
    log,
    cancel_check=None,
    *,
    deadline: float | None = None,
    session_evidence: _PasswordSessionEvidence | None = None,
) -> str:
    original_email = str(email or "").strip()
    if not original_email:
        raise RuntimeError("设置密码重新认证缺少原注册邮箱")
    effective_deadline = deadline or (
        time.monotonic() + PASSWORD_SETTINGS_TIMEOUT_SECONDS
    )
    bounded_cancel_check = _password_settings_cancel_check(
        effective_deadline,
        cancel_check,
    )
    _raise_if_cancelled(bounded_cancel_check)
    refresh_baseline = getattr(otp_callback, "refresh_baseline", None)
    if not callable(refresh_baseline):
        raise RuntimeError("设置密码验证码回调不支持刷新邮件基线")

    def strict_refresh_baseline() -> None:
        _run_password_callback_with_deadline(
            lambda: refresh_baseline(strict=True),
            deadline=effective_deadline,
            cancel_check=cancel_check,
            label="设置密码前刷新邮箱验证码基线",
            cancel_wait_target=otp_callback,
        )
        _raise_if_cancelled(bounded_cancel_check)
        log("设置密码前已严格刷新邮箱验证码基线")

    strict_refresh_baseline()
    try:
        snapshot = _open_password_security_settings(
            page,
            log,
            cancel_check=bounded_cancel_check,
            deadline=effective_deadline,
        )
    except PasswordAccountSessionExpired:
        evidence_valid = bool(
            isinstance(session_evidence, _PasswordSessionEvidence)
            and session_evidence.original_email.casefold() == original_email.casefold()
            and session_evidence.account_id
        )
        if not evidence_valid:
            raise RuntimeError(
                "ChatGPT Security Session 已过期，且缺少已验证账号身份"
            )
        fresh_session = _restore_existing_account_session(
            page,
            email=original_email,
            cookies="",
            otp_callback=otp_callback,
            expected_account_id=session_evidence.account_id,
            log=log,
            cancel_check=cancel_check,
            deadline=effective_deadline,
        )
        _validated_password_session_evidence(
            fresh_session,
            expected_email=original_email,
            expected_account_id=session_evidence.account_id,
        )
        log("已通过原邮箱 OTP 恢复 Security Session")
        # 登录 OTP 与随后密码重新认证 OTP 必须使用两个独立邮件基线。
        strict_refresh_baseline()
        snapshot = _open_password_security_settings(
            page,
            log,
            cancel_check=bounded_cancel_check,
            deadline=effective_deadline,
        )
    row_evidence_valid = bool(
        snapshot.get("ready") is True
        and snapshot.get("row_visible") is True
        and snapshot.get("row_disabled") is False
        and snapshot.get("testid") == "password-setting"
        and snapshot.get("tag_name") == "button"
        and snapshot.get("button_type") == "button"
    )
    if not row_evidence_valid:
        raise RuntimeError("ChatGPT Security 未找到可验证的密码设置项")
    if snapshot.get("configured") not in {True, False}:
        raise RuntimeError("ChatGPT Security 无法确认密码配置状态")
    password_mode = "change" if snapshot.get("configured") is True else "add"
    security_url = str(page.url or "")
    if not _is_password_security_settings_url(security_url):
        safe_url = _sanitize_password_error(security_url)
        raise RuntimeError(f"ChatGPT Security 设置页地址不受信任: {safe_url}")
    eligibility = _password_eligibility(
        page,
        password_mode,
        deadline=effective_deadline,
        cancel_check=bounded_cancel_check,
    )
    mode_label = "更改" if password_mode == "change" else "添加"
    if eligibility is False:
        raise RuntimeError(f"ChatGPT Security 明确拒绝当前账号{mode_label}密码资格")
    if eligibility is not True:
        evidence_valid = bool(
            isinstance(session_evidence, _PasswordSessionEvidence)
            and session_evidence.original_email.casefold() == original_email.casefold()
            and session_evidence.account_id
        )
        if not evidence_valid:
            raise RuntimeError(
                f"ChatGPT Security 无法确认当前账号具备{mode_label}密码资格，"
                "且缺少已验证 Session 身份"
            )
        log(
            f"Security {mode_label}密码资格接口不可用；已验证 Session 身份与"
            "密码设置行，仅继续受控 NextAuth 重新认证"
        )

    with _PasswordSigninResponseObserver(page) as signin_observer:
        reauth_evidence: _PasswordReauthEvidence | bool = False
        try:
            reauth_evidence = _start_password_reauth_via_nextauth(
                page,
                original_email,
                log,
                cancel_check=bounded_cancel_check,
                deadline=effective_deadline,
                mode=password_mode,
            )
        except (BrowserTaskCancelled, PasswordSettingsTimeout):
            raise
        except Exception as exc:
            raise RuntimeError(
                "Security NextAuth 启动状态不确定，已停止 UI 回退"
            ) from exc

        if reauth_evidence is False:
            raise RuntimeError("Security NextAuth 在按钮点击前未启动，已停止密码设置")
        if not isinstance(reauth_evidence, _PasswordReauthEvidence):
            raise RuntimeError(
                "Security NextAuth 未返回确定启动状态，已停止 UI 回退"
            )
        if (
            reauth_evidence.original_email.casefold() != original_email.casefold()
            or not reauth_evidence.transaction_id
            or reauth_evidence.expected_auth_origin != _url_origin(OPENAI_AUTH)
            or reauth_evidence.button_dispatch_marker
            != f"password-reauth-button:{reauth_evidence.transaction_id}"
            or reauth_evidence.mode != password_mode
        ):
            raise RuntimeError("Security NextAuth 重新认证 transaction lineage 校验失败")

        redirect_deadline = min(
            effective_deadline,
            time.monotonic() + PASSWORD_REAUTH_REDIRECT_TIMEOUT_SECONDS,
        )
        _wait_for_password_reauth_landing(
            page,
            security_url=security_url,
            evidence=reauth_evidence,
            observer=signin_observer,
            log=log,
            deadline=redirect_deadline,
            cancel_check=bounded_cancel_check,
        )
    return password_mode


def _submit_new_password_via_page(
    page,
    password: str,
    log,
    cancel_check=None,
    *,
    deadline: float | None = None,
) -> str:
    if deadline is not None:
        cancel_check = _password_settings_cancel_check(deadline, cancel_check)
    _raise_if_cancelled(cancel_check)
    new_selector = _wait_for_any_selector(
        page,
        NEW_PASSWORD_INPUT_SELECTORS,
        timeout=_password_step_timeout_seconds(
            deadline,
            20,
            "等待新密码输入框",
        ),
        cancel_check=cancel_check,
    )
    confirm_selector = _wait_for_any_selector(
        page,
        CONFIRM_PASSWORD_INPUT_SELECTORS,
        timeout=_password_step_timeout_seconds(
            deadline,
            5,
            "等待确认密码输入框",
        ),
        cancel_check=cancel_check,
    )
    if not new_selector or not confirm_selector:
        raise RuntimeError("新增密码页面未找到两次密码输入框")
    if not _fill_input_like_user(
        page,
        new_selector,
        password,
        deadline=deadline,
        cancel_check=cancel_check,
    ):
        raise RuntimeError("新增密码页面首次密码填写失败")
    if not _fill_input_like_user(
        page,
        confirm_selector,
        password,
        deadline=deadline,
        cancel_check=cancel_check,
    ):
        raise RuntimeError("新增密码页面确认密码填写失败")
    if deadline is None:
        _browser_pause(page)
    else:
        _password_step_sleep(
            0.15,
            cancel_check,
            deadline=deadline,
            label="提交新密码",
        )
    submit_selectors = [
        'button[type="submit"]',
        'button[data-testid="continue-button"]',
        'button:has-text("Continue")',
        'button:has-text("Save")',
        'button:has-text("続ける")',
        'button:has-text("保存")',
    ]
    try:
        submit_selector = _click_first_once_no_wait(
            page,
            submit_selectors,
            timeout=8,
            cancel_check=cancel_check,
            deadline=deadline,
            label="新增密码页提交",
            accepted_url_kind="success",
        )
    except RuntimeError:
        current_url = str(page.url or "")
        if _classify_password_reauth_url(current_url) == "success":
            return "success_url"
        if not _is_exact_password_post_submit_root(current_url):
            raise
        # The click was attempted and may have committed remotely. Never
        # submit again; the caller must prove the candidate in a fresh login.
        submit_selector = "dispatch-uncertain-root"
    if not submit_selector:
        submitted = _submit_form_with_fallback(page, confirm_selector)
        if not submitted and _classify_password_reauth_url(str(page.url or "")) != "success":
            raise RuntimeError("新增密码页面未找到提交按钮")
    log("新增密码页面已提交")

    transition_deadline = time.monotonic() + 30
    if deadline is not None:
        transition_deadline = min(transition_deadline, deadline)
    stable_root_since: float | None = None
    while True:
        current_url = str(page.url or "")
        if _classify_password_reauth_url(current_url) == "success":
            return "success_url"
        if _is_exact_password_post_submit_root(current_url):
            stable_root_since = stable_root_since or time.monotonic()
            if (
                time.monotonic() - stable_root_since
                >= PASSWORD_POST_SUBMIT_ROOT_STABILITY_SECONDS
            ):
                return "chatgpt_root"
        else:
            stable_root_since = None
        _raise_if_cancelled(cancel_check)
        if time.monotonic() >= transition_deadline:
            break
        if deadline is not None:
            _password_settings_remaining(deadline, "等待新增密码成功页")
        error_text = (
            ""
            if _is_exact_password_post_submit_root(str(page.url or ""))
            else _extract_auth_error_text(page)
        )
        if _classify_password_reauth_url(str(page.url or "")) == "success":
            return "success_url"
        if error_text:
            raise RuntimeError(f"新增密码失败: {error_text[:200]}")
        pause_deadline = min(transition_deadline, time.monotonic() + 0.5)
        while time.monotonic() < pause_deadline:
            if _classify_password_reauth_url(str(page.url or "")) == "success":
                return "success_url"
            _raise_if_cancelled(cancel_check)
            time.sleep(min(0.05, max(pause_deadline - time.monotonic(), 0.0)))
    current_url = str(page.url or "")
    if _classify_password_reauth_url(current_url) == "success":
        return "success_url"
    if deadline is not None:
        _password_settings_remaining(deadline, "等待新增密码成功页")
    safe_url = _sanitize_password_error(str(page.url or ""))
    raise RuntimeError(f"新增密码提交后未进入成功页: {safe_url}")


def _submit_password_proof_email_once(
    page,
    email: str,
    *,
    deadline: float,
    cancel_check=None,
) -> str:
    selector = _wait_for_any_selector(
        page,
        EMAIL_INPUT_SELECTORS,
        timeout=_password_step_timeout_seconds(deadline, 15, "候选密码登录邮箱页"),
        cancel_check=cancel_check,
    )
    if not selector or not _fill_input_like_user(
        page,
        selector,
        email,
        deadline=deadline,
        cancel_check=cancel_check,
    ):
        raise RuntimeError("候选密码登录邮箱页填写失败")
    submit_selector = _wait_for_any_selector(
        page,
        EMAIL_SUBMIT_SELECTORS,
        timeout=_password_step_timeout_seconds(deadline, 8, "候选密码登录邮箱提交"),
        cancel_check=cancel_check,
    )
    if not submit_selector:
        raise RuntimeError("候选密码登录邮箱页缺少提交按钮")
    marker = f"password-proof-email:{uuid.uuid4()}"
    try:
        page.click(
            submit_selector,
            timeout=_password_step_timeout_ms(deadline, 3, "候选密码登录邮箱提交"),
            no_wait_after=True,
        )
    except Exception:
        # Dispatch is uncertain; never submit the email form twice.
        pass
    return marker


def _submit_candidate_password_login_once(
    page,
    password: str,
    *,
    deadline: float,
    cancel_check=None,
) -> str:
    if not _is_login_password_url(str(page.url or "")):
        raise RuntimeError("候选密码证明未处于已有账号密码登录页")
    selector = _wait_for_any_selector(
        page,
        PASSWORD_INPUT_SELECTORS,
        timeout=_password_step_timeout_seconds(deadline, 15, "候选密码登录输入框"),
        cancel_check=cancel_check,
    )
    if not selector or not _fill_input_like_user(
        page,
        selector,
        password,
        deadline=deadline,
        cancel_check=cancel_check,
    ):
        raise RuntimeError("候选密码登录填写失败")
    submit_selector = _wait_for_any_selector(
        page,
        PASSWORD_SUBMIT_SELECTORS,
        timeout=_password_step_timeout_seconds(deadline, 8, "候选密码登录提交"),
        cancel_check=cancel_check,
    )
    if not submit_selector:
        raise RuntimeError("候选密码登录页缺少提交按钮")
    marker = f"candidate-password-submit:{uuid.uuid4()}"
    try:
        page.click(
            submit_selector,
            timeout=_password_step_timeout_ms(deadline, 3, "候选密码登录提交"),
            no_wait_after=True,
        )
    except Exception:
        # The password dispatch may already have reached the server. Observe
        # the resulting state, but never click or submit it a second time.
        pass
    return marker


def _select_password_login_instead_once(
    page,
    *,
    deadline: float,
    cancel_check=None,
) -> str:
    selector = _wait_for_any_selector(
        page,
        PASSWORD_LOGIN_INSTEAD_SELECTORS,
        timeout=_password_step_timeout_seconds(deadline, 8, "选择候选密码登录"),
        cancel_check=cancel_check,
    )
    if not selector:
        raise RuntimeError("候选密码验证页未提供改用密码登录入口")
    marker = f"password-login-instead:{uuid.uuid4()}"
    try:
        page.click(
            selector,
            timeout=_password_step_timeout_ms(deadline, 3, "选择候选密码登录"),
            no_wait_after=True,
        )
    except Exception:
        # Observe the resulting page, but never click the mode switch twice.
        pass
    return marker


def _verify_existing_account_password_login(
    page,
    *,
    source_context,
    email: str,
    password: str,
    expected_account_id: str,
    otp_callback,
    log,
    deadline: float,
    cancel_check=None,
) -> dict[str, Any]:
    original_email = str(email or "").strip()
    expected_id = str(expected_account_id or "").strip()
    if not original_email or not password or not expected_id:
        raise RuntimeError("候选密码重新登录缺少原账号强身份")
    context = page.context
    if context is source_context:
        raise RuntimeError("候选密码重新登录未使用隔离浏览器 Context")
    initial_cookies = list(context.cookies() or [])
    if initial_cookies:
        raise RuntimeError("候选密码重新登录 Context 含有旧 Cookie")
    storage_state = getattr(context, "storage_state", None)
    if callable(storage_state):
        state = storage_state() or {}
        if (state.get("cookies") or []) or (state.get("origins") or []):
            raise RuntimeError("候选密码重新登录 Context 含有旧存储状态")

    bounded_cancel_check = _password_settings_cancel_check(deadline, cancel_check)
    _raise_if_cancelled(bounded_cancel_check)
    refresh_baseline = getattr(otp_callback, "refresh_baseline", None)
    if callable(refresh_baseline):
        _run_password_callback_with_deadline(
            lambda: refresh_baseline(strict=True),
            deadline=deadline,
            cancel_check=cancel_check,
            label="候选密码登录前刷新邮箱验证码基线",
            cancel_wait_target=otp_callback,
        )

    device_id = str(uuid.uuid4())
    _seed_browser_device_id(page, device_id)
    state = _start_browser_signup_via_authorize(
        page,
        original_email,
        device_id,
        log,
    )
    forbidden_states = {
        "create_account_password",
        "password",
        "about_you",
        "add_phone",
        "consent",
        "workspace_selection",
        "organization_selection",
        "external_url",
    }
    email_submit_marker = ""
    password_login_instead_marker = ""
    password_login_instead_at = 0.0
    candidate_submit_marker = ""
    otp_submit_count = 0
    seen: dict[str, int] = {}

    while time.monotonic() < deadline:
        _raise_if_cancelled(bounded_cancel_check)
        page_type = str(state.get("page_type") or "")
        current_url = str(page.url or state.get("current_url") or "")
        if _is_login_password_url(current_url):
            page_type = "login_password"
            state = {**state, "page_type": page_type, "current_url": current_url}
        elif password_login_instead_marker and _find_first_selector(
            page,
            PASSWORD_INPUT_SELECTORS,
        ):
            page_type = "login_password"
            state = {**state, "page_type": page_type, "current_url": current_url}
        elif _is_exact_password_post_submit_root(current_url):
            page_type = "chatgpt_home"
            state = {**state, "page_type": page_type, "current_url": current_url}
        signature = f"{page_type}|{_normalized_auth_path(current_url)}"
        seen[signature] = seen.get(signature, 0) + 1
        if seen[signature] > 12:
            raise RuntimeError("候选密码重新登录状态未推进")

        if page_type in forbidden_states:
            raise RuntimeError(f"候选密码重新登录进入禁止状态: {page_type}")

        if _is_registration_complete(state):
            if not candidate_submit_marker:
                raise RuntimeError("候选密码未实际提交，拒绝自动登录证明")
            session_info = _fetch_chatgpt_session_from_page(
                page,
                _get_cookies(page),
                log,
                timeout=max(
                    1,
                    min(20, int(_password_settings_remaining(deadline, "验证候选密码 Session"))),
                ),
            )
            _validate_existing_account_session(
                session_info,
                expected_email=original_email,
                expected_account_id=expected_id,
                require_account_id=True,
            )
            log("候选密码已通过隔离 Context 登录和原账号身份校验")
            return {
                "session_info": session_info,
                "candidate_submit_marker": candidate_submit_marker,
                "candidate_submit_count": 1,
            }

        if page_type == "login_email":
            if email_submit_marker:
                raise RuntimeError("候选密码登录邮箱只允许提交一次")
            email_submit_marker = _submit_password_proof_email_once(
                page,
                original_email,
                deadline=deadline,
                cancel_check=bounded_cancel_check,
            )
            state = _wait_for_existing_login_transition(
                page,
                "login_email",
                cancel_check=bounded_cancel_check,
                timeout=min(
                    20,
                    max(1, int(_password_settings_remaining(deadline, "等待候选密码登录页"))),
                ),
            )
            continue

        if page_type == "login_password":
            if not candidate_submit_marker:
                candidate_submit_marker = _submit_candidate_password_login_once(
                    page,
                    password,
                    deadline=deadline,
                    cancel_check=bounded_cancel_check,
                )
            else:
                error_text = _extract_auth_error_text(page)
                if error_text:
                    raise RuntimeError("候选密码登录验证失败")
            state = _wait_for_existing_login_transition(
                page,
                "login_password",
                cancel_check=bounded_cancel_check,
                timeout=min(
                    20,
                    max(1, int(_password_settings_remaining(deadline, "等待候选密码登录结果"))),
                ),
            )
            continue

        if _is_email_otp(state):
            if not candidate_submit_marker:
                if password_login_instead_marker:
                    if (
                        time.monotonic() - password_login_instead_at
                        > 20
                    ):
                        raise RuntimeError("改用候选密码登录后仍停留在 OTP 页面")
                    state = _wait_for_existing_login_transition(
                        page,
                        "email_otp_verification",
                        cancel_check=bounded_cancel_check,
                        timeout=min(
                            5,
                            max(1, int(_password_settings_remaining(deadline, "等待候选密码输入页"))),
                        ),
                    )
                    continue
                password_login_instead_marker = _select_password_login_instead_once(
                    page,
                    deadline=deadline,
                    cancel_check=bounded_cancel_check,
                )
                password_login_instead_at = time.monotonic()
                state = _wait_for_existing_login_transition(
                    page,
                    "email_otp_verification",
                    cancel_check=bounded_cancel_check,
                    timeout=min(
                        20,
                        max(1, int(_password_settings_remaining(deadline, "等待候选密码输入页"))),
                    ),
                )
                continue
            if otp_submit_count:
                raise RuntimeError("候选密码登录 OTP 只允许提交一次")
            code = _run_password_callback_with_deadline(
                otp_callback,
                deadline=deadline,
                cancel_check=cancel_check,
                label="候选密码登录附加邮箱验证码",
                cancel_wait_target=otp_callback,
            )
            if not str(code or "").strip():
                raise RuntimeError("候选密码登录未获取到附加邮箱验证码")
            response = _submit_otp_via_page(
                page,
                str(code).strip(),
                log,
                cancel_check=bounded_cancel_check,
                deadline=deadline,
            )
            otp_submit_count = 1
            if not response.get("ok"):
                raise RuntimeError("候选密码登录附加邮箱验证码失败")
            state = _extract_flow_state(
                response.get("data"),
                response.get("url", page.url),
            )
            if not state.get("page_type") or _is_email_otp(state):
                state = _wait_for_existing_login_transition(
                    page,
                    "email_otp_verification",
                    cancel_check=bounded_cancel_check,
                    timeout=min(
                        20,
                        max(1, int(_password_settings_remaining(deadline, "等待候选密码登录完成"))),
                    ),
                )
            continue

        state = _wait_for_existing_login_transition(
            page,
            page_type,
            cancel_check=bounded_cancel_check,
            timeout=min(
                5,
                max(1, int(_password_settings_remaining(deadline, "等待候选密码登录状态"))),
            ),
        )

    _raise_if_cancelled(bounded_cancel_check)
    raise PasswordSettingsTimeout("候选密码重新登录验证超时")


def _confirm_password_in_security(page, log, *, timeout: int = 8, cancel_check=None) -> bool:
    try:
        snapshot = (
            _open_password_security_settings(page, log)
            if cancel_check is None
            else _open_password_security_settings(page, log, cancel_check=cancel_check)
        )
    except BrowserTaskCancelled:
        raise
    except Exception as exc:
        log(f"密码已提交成功，Security 页面暂时无法复核: {exc}")
        return False

    deadline = time.time() + max(int(timeout), 1)
    while time.time() < deadline:
        _raise_if_cancelled(cancel_check)
        change_eligible = _password_eligibility(page, "change")
        snapshot = _password_settings_snapshot(page) or snapshot
        if change_eligible is True or snapshot.get("configured"):
            return True
        _cancelable_sleep(0.5, cancel_check)
    log("密码已提交成功，但 Security/eligibility 尚未传播到已配置状态")
    return False


def _set_password_from_security_settings(
    page,
    email: str,
    password: str,
    otp_callback,
    log,
    cancel_check=None,
    *,
    timeout_seconds: float = PASSWORD_SETTINGS_TIMEOUT_SECONDS,
    session_evidence: _PasswordSessionEvidence | None = None,
    candidate_login_verifier: Optional[Callable[..., dict[str, Any]]] = None,
) -> dict[str, Any]:
    if not otp_callback:
        raise RuntimeError("注册后设置密码需要邮箱验证码回调")
    deadline = time.monotonic() + max(float(timeout_seconds), 0.01)
    bounded_cancel_check = _password_settings_cancel_check(deadline, cancel_check)
    _raise_if_cancelled(bounded_cancel_check)
    _trigger_password_settings_reauth(
        page,
        email,
        otp_callback,
        log,
        cancel_check=cancel_check,
        deadline=deadline,
        session_evidence=session_evidence,
    )

    current_url = str(page.url or "")
    current_kind = _classify_password_reauth_url(current_url)
    if current_kind != "email_verification":
        safe_url = _sanitize_password_error(current_url)
        raise RuntimeError(
            f"设置密码重新认证未进入原邮箱验证页 ({current_kind}): {safe_url}"
        )
    log("等待设置密码邮箱验证码")
    _raise_if_cancelled(bounded_cancel_check)
    code = str(
        _run_password_callback_with_deadline(
            otp_callback,
            deadline=deadline,
            cancel_check=cancel_check,
            label="等待设置密码邮箱验证码",
        )
        or ""
    ).strip()
    _raise_if_cancelled(bounded_cancel_check)
    if not code:
        raise RuntimeError("未获取到设置密码邮箱验证码")
    otp_result = _submit_otp_via_page(
        page,
        code,
        log,
        cancel_check=bounded_cancel_check,
        deadline=deadline,
        expected_url_kind="new_password",
    )
    if not otp_result.get("ok"):
        raise RuntimeError(f"设置密码邮箱验证码校验失败: {(otp_result.get('text') or '')[:200]}")
    transition_deadline = min(deadline, time.monotonic() + 20)
    while time.monotonic() < transition_deadline:
        _raise_if_cancelled(bounded_cancel_check)
        transition_kind = _classify_password_reauth_url(str(page.url or ""))
        if transition_kind == "new_password":
            break
        if transition_kind != "email_verification":
            safe_url = _sanitize_password_error(str(page.url or ""))
            raise RuntimeError(
                f"邮箱验证码通过后进入不受信任页面 ({transition_kind}): {safe_url}"
            )
        _cancelable_sleep(0.25, bounded_cancel_check)
    _raise_if_cancelled(bounded_cancel_check)
    if _classify_password_reauth_url(str(page.url or "")) != "new_password":
        safe_url = _sanitize_password_error(str(page.url or ""))
        raise RuntimeError(f"邮箱验证码通过后未进入新增密码页: {safe_url}")

    post_submit_verification = _submit_new_password_via_page(
        page,
        password,
        log,
        cancel_check=bounded_cancel_check,
        deadline=deadline,
    )
    if (
        post_submit_verification is None
        and _classify_password_reauth_url(str(page.url or "")) == "success"
    ):
        post_submit_verification = "success_url"
    if post_submit_verification == "success_url":
        if _classify_password_reauth_url(str(page.url or "")) != "success":
            raise RuntimeError("新增密码成功页校验失败")
        log("新增密码成功页已确认，跳过 Security 页面二次导航")
        return {
            "password_set": True,
            "password_status": "configured",
            "password_source": "settings",
            "password_verification": "success_url",
        }

    if (
        post_submit_verification != "chatgpt_root"
        or not _is_exact_password_post_submit_root(str(page.url or ""))
    ):
        raise RuntimeError("新增密码提交后未获得可验证终态")
    if not (
        isinstance(session_evidence, _PasswordSessionEvidence)
        and session_evidence.original_email.casefold() == str(email or "").strip().casefold()
        and session_evidence.account_id
    ):
        raise RuntimeError("候选密码重新登录缺少已验证原账号身份")
    if not callable(candidate_login_verifier):
        raise RuntimeError("新增密码回首页后缺少隔离登录验证器")

    proof = candidate_login_verifier(
        deadline=deadline,
        cancel_check=cancel_check,
    )
    session_info = proof.get("session_info") if isinstance(proof, dict) else None
    marker = str((proof or {}).get("candidate_submit_marker") or "")
    if (
        not isinstance(session_info, dict)
        or (proof or {}).get("candidate_submit_count") != 1
        or not marker.startswith("candidate-password-submit:")
    ):
        raise RuntimeError("候选密码隔离登录未返回单次提交强证明")
    _validate_existing_account_session(
        session_info,
        expected_email=str(email or "").strip(),
        expected_account_id=session_evidence.account_id,
        require_account_id=True,
    )
    log("新增密码已通过隔离 Context 候选密码登录强校验")
    result = {
        "password_set": True,
        "password_status": "configured",
        "password_source": "settings",
        "password_verification": "password_login_reconciled",
    }
    for key in (
        "account_id",
        "access_token",
        "refresh_token",
        "id_token",
        "session_token",
        "workspace_id",
        "cookies",
    ):
        if session_info.get(key):
            result[key] = session_info[key]
    return result


def _is_password_registration(state: dict) -> bool:
    return str(state.get("page_type") or "") in {"create_account_password", "password"}


def _is_email_otp(state: dict) -> bool:
    target = f"{state.get('continue_url') or ''} {state.get('current_url') or ''}".lower()
    return str(state.get("page_type") or "") == "email_otp_verification" or "email-verification" in target or "email-otp" in target


def _is_registration_otp_dom_failure(result: dict) -> bool:
    if (result or {}).get("ok") or int((result or {}).get("status") or 0) != 0:
        return False
    text = str((result or {}).get("text") or "")
    return any(
        marker in text
        for marker in (
            "验证码页未找到可填写输入框",
            "验证码页未找到 Continue 按钮",
        )
    )


def _is_about_you(state: dict) -> bool:
    target = f"{state.get('continue_url') or ''} {state.get('current_url') or ''}".lower()
    return str(state.get("page_type") or "") == "about_you" or "about-you" in target


def _is_add_phone(state: dict) -> bool:
    target = f"{state.get('continue_url') or ''} {state.get('current_url') or ''}".lower()
    return (
        str(state.get("page_type") or "") == "add_phone"
        or "add-phone" in target
        or "phone-verification" in target
    )


def _mask_phone_number(phone_number: str) -> str:
    text = str(phone_number or "").strip()
    if len(text) <= 4:
        return text
    if len(text) <= 8:
        return f"{text[:2]}****{text[-2:]}"
    return f"{text[:4]}****{text[-2:]}"


def _is_invalid_phone_otp_response(result: dict) -> bool:
    status = int((result or {}).get("status") or 0)
    if status != 400:
        return False
    data = (result or {}).get("data")
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "").lower()
            code = str(error.get("code") or "").lower()
            return code == "invalid_input" and "invalid otp code" in message
    text = str((result or {}).get("text") or "").lower()
    return "invalid otp code" in text


def _handle_add_phone_challenge(
    page,
    phone_callback,
    *,
    device_id: str,
    user_agent: str,
    log,
    resume_url: str = "",
    max_phone_attempts: int = 3,
) -> dict:
    """在 add-phone 页面通过 UI 交互完成手机号验证。

    流程: 选择国家 -> 输入本地号码 -> 点击发送 -> 填写 OTP -> 点击验证。
    如果验证码超时未收到，自动换号重试（最多 max_phone_attempts 次）。
    """
    if not phone_callback:
        raise RuntimeError(
            "ChatGPT 注册遇到手机号验证，但未配置 phone_callback。"
            "请在 RegisterConfig.extra 中配置接码服务，或手动完成手机验证。"
        )

    last_error = None
    for phone_attempt in range(max_phone_attempts):
        if phone_attempt > 0:
            log(f"换号重试第 {phone_attempt + 1}/{max_phone_attempts} 次...")
            # 回到 add-phone 页面
            try:
                _goto_with_retry(page, f"{OPENAI_AUTH}/add-phone", wait_until="domcontentloaded", timeout=15000, log=log)
                time.sleep(1)
            except Exception:
                pass

        try:
            result = _do_add_phone_attempt(
                page, phone_callback,
                device_id=device_id, user_agent=user_agent,
                log=log, resume_url=resume_url,
            )
            return result
        except RuntimeError as exc:
            last_error = exc
            error_msg = str(exc)
            # 验证码超时或号码已被使用时换号重试，其他错误直接抛出
            should_retry = (
                "未获取到短信验证码" in error_msg
                or "phone_number_in_use" in error_msg
                or "already" in error_msg.lower()
                or "in use" in error_msg.lower()
            )
            if not should_retry:
                raise
            log(f"⚠️ 验证码超时未收到，准备换号重试...")
            # 取消当前号码
            if hasattr(phone_callback, "cleanup"):
                phone_callback.cleanup()
            # 重置 phone_callback 状态为 need_number
            if hasattr(phone_callback, "phase"):
                phone_callback.phase = "need_number"
                phone_callback.activation = None
                phone_callback.completed = False

    raise last_error or RuntimeError("短信验证失败: 多次换号均未收到验证码")


def _do_add_phone_attempt(
    page,
    phone_callback,
    *,
    device_id: str,
    user_agent: str,
    log,
    resume_url: str = "",
) -> dict:
    """单次手机号验证尝试（内部函数）。"""

    # 保留 HTTP resend 回调供 SMS provider 内部使用
    referer = _normalize_url(str(page.url or ""), OPENAI_AUTH) or f"{OPENAI_AUTH}/add-phone"
    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=referer,
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )

    def _request_openai_resend():
        # 浏览器模式下只通过页面 UI 点击 Resend 按钮
        resend_clicked = _click_first_no_wait(page, [
            'button:has-text("Resend")',
            'button:has-text("resend")',
            'button:has-text("Resend code")',
            'button[data-testid="resend-link"]',
            'button:has-text("重新发送")',
            'a:has-text("Resend")',
            'a:has-text("resend")',
            'a:has-text("Resend code")',
            'button:has-text("再送信")',
            'button:has-text("コードを再送")',
            'a:has-text("再送信")',
            'a:has-text("コードを再送")',
        ], timeout=3)
        if resend_clicked:
            log(f"  phone-otp/resend -> 已点击页面 Resend 按钮: {resend_clicked}")
        else:
            log("  phone-otp/resend -> 页面未找到 Resend 按钮，跳过（浏览器模式不走 HTTP）")

    if hasattr(phone_callback, "set_resend_callback"):
        phone_callback.set_resend_callback(_request_openai_resend)

    # ---- 第1步: 获取手机号 ----
    log("注册流程已进入 add_phone，开始准备租号并接收短信验证码...")
    phone_number = str(phone_callback() or "").strip()
    if not phone_number:
        raise RuntimeError("未获取到手机号")
    log(f"检测到 add_phone，提交手机号(UI): {_mask_phone_number(phone_number)}")

    # 解析国家拨号码和本地号码
    dial_code, local_number, country_name = _parse_phone_country_and_local(phone_number)
    log(f"  解析号码: 国家={country_name or '未知'} 拨号码=+{dial_code} 本地号={local_number[:4]}...")

    # 确保在 add-phone 页面
    current_url = str(page.url or "")
    if "add-phone" not in current_url:
        _goto_with_retry(page, f"{OPENAI_AUTH}/add-phone", wait_until="domcontentloaded", timeout=30000, log=log)
    time.sleep(1)

    submit_result = _submit_add_phone_dom(
        page,
        phone_number=phone_number,
        dial_code=dial_code,
        local_number=local_number,
        country_name=country_name,
        log=log,
    )
    if not submit_result.get("ok"):
        log(f"  add-phone DOM 提交失败，回退旧 UI 路径: {submit_result.get('reason') or submit_result}")
        country_selected = _select_phone_country_ui(page, dial_code, country_name, log)
        _browser_pause(page)
        phone_input_sel = _wait_for_any_selector(page, PHONE_INPUT_SELECTORS, timeout=10)
        if not phone_input_sel:
            raise RuntimeError("未找到手机号输入框")
        fill_value = local_number if country_selected else phone_number
        if not _fill_input_like_user(page, phone_input_sel, fill_value):
            raise RuntimeError(f"手机号输入框填写失败: {phone_input_sel}")
        send_sel = _click_first_no_wait(page, PHONE_SEND_SELECTORS, timeout=8)
        if send_sel:
            log(f"  已点击发送按钮: {send_sel}")
        elif _submit_form_with_fallback(page, phone_input_sel):
            log("  未找到发送按钮，已使用表单 fallback 提交")
        else:
            raise RuntimeError("未找到发送验证码按钮")

    phone_status = _wait_for_phone_verification_ready(page, timeout=30)
    if phone_status.get("addPhoneError"):
        if hasattr(phone_callback, "mark_send_failed"):
            phone_callback.mark_send_failed(str(phone_status.get("addPhoneError") or ""))
        raise RuntimeError(f"手机号提交失败: {str(phone_status.get('addPhoneError') or '')[:200]}")
    if not phone_status.get("phoneVerificationReady"):
        error_text = _extract_auth_error_text(page)
        if error_text:
            if hasattr(phone_callback, "mark_send_failed"):
                phone_callback.mark_send_failed(error_text)
            raise RuntimeError(f"手机号提交失败: {error_text[:200]}")
        raise RuntimeError(f"手机号提交后未进入验证码页: {str(phone_status.get('url') or page.url)}")

    # 检查发送是否成功（页面应出现 OTP 输入框或 URL 变化）
    error_text = _extract_auth_error_text(page)
    if error_text:
        if hasattr(phone_callback, "mark_send_failed"):
            phone_callback.mark_send_failed(error_text)
        raise RuntimeError(f"手机号提交失败: {error_text[:200]}")

    if hasattr(phone_callback, "mark_send_succeeded"):
        phone_callback.mark_send_succeeded()
    log("手机号提交成功(UI)，开始等待短信验证码...")

    # ---- 第5步: 等待 SMS 验证码并在页面 OTP 输入框中填写 ----
    for code_attempt in range(3):
        sms_code = str(phone_callback() or "").strip()
        if not sms_code:
            raise RuntimeError("未获取到短信验证码")

        phone_status = _wait_for_phone_verification_ready(page, timeout=12)
        if not phone_status.get("phoneVerificationReady"):
            raise RuntimeError(f"未找到短信验证码输入框: {str(phone_status.get('url') or page.url)}")

        otp_resp = _submit_phone_otp_dom(page, sms_code, log)
        if not otp_resp.get("ok") and "missing_phone_verification" in str(otp_resp.get("text") or ""):
            otp_resp = _submit_otp_via_page(page, sms_code, log)
        otp_status = int(otp_resp.get("status") or 0)
        log(f"  phone-otp 页面提交状态: {otp_status}")

        if otp_resp.get("ok") or otp_status in (200, 201, 204):
            if hasattr(phone_callback, "report_success"):
                phone_callback.report_success()
            # 等待页面跳转
            time.sleep(1.5)
            state = _extract_flow_state(
                otp_resp.get("data"),
                otp_resp.get("url", page.url),
            )
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            next_url = _normalize_url(resume_url, OPENAI_AUTH) if resume_url else ""
            if next_url:
                _goto_with_retry(page, next_url, wait_until="domcontentloaded", timeout=30000, log=log)
                return _extract_flow_state(None, page.url)
            return state

        # 检查是否是无效验证码
        page_error = _extract_auth_error_text(page)
        if page_error and any(kw in page_error.lower() for kw in ("invalid", "incorrect", "wrong", "expired")):
            log(f"短信验证码被判定无效: {page_error[:100]}，继续等待下一条...")
            if hasattr(phone_callback, "mark_code_failed"):
                phone_callback.mark_code_failed(page_error or "invalid otp code")
            continue

        if hasattr(phone_callback, "mark_code_failed"):
            phone_callback.mark_code_failed(page_error or f"status {otp_status}")
        raise RuntimeError(f"短信验证码校验失败: {page_error[:200] if page_error else f'status {otp_status}'}")

    raise RuntimeError("短信验证码校验失败: 多次验证码均无效或未通过")


def _requires_registration_navigation(state: dict) -> bool:
    if str(state.get("method") or "GET").upper() != "GET":
        return False
    if str(state.get("page_type") or "") == "external_url" and state.get("continue_url"):
        return True
    continue_url = str(state.get("continue_url") or "")
    current_url = str(state.get("current_url") or "")
    return bool(continue_url and continue_url != current_url)


def _browser_add_cookies(page, cookies: list[dict]) -> None:
    try:
        page.context.add_cookies(cookies)
    except Exception:
        pass


def _seed_browser_device_id(page, device_id: str) -> None:
    _browser_add_cookies(
        page,
        [
            {"name": "oai-did", "value": device_id, "domain": "chatgpt.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": ".chatgpt.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": "openai.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": "auth.openai.com", "path": "/"},
            {"name": "oai-did", "value": device_id, "domain": ".auth.openai.com", "path": "/"},
        ],
    )


_NEXTAUTH_CSRF_COOKIE_NAMES = (
    "__Host-next-auth.csrf-token",
    "__Secure-next-auth.csrf-token",
    "next-auth.csrf-token",
)


def _csrf_token_from_cookie_value(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    decoded = unquote(value.strip())
    separator_positions = [
        position
        for position in (
            decoded.find("|"),
            decoded.lower().find("%7c"),
        )
        if position >= 0
    ]
    if separator_positions:
        decoded = decoded[: min(separator_positions)]
    return decoded.strip()


def _get_browser_csrf_token(page, *, timeout_ms: int = 30000) -> str:
    try:
        result = _browser_fetch(
            page,
            f"{CHATGPT_APP}/api/auth/csrf",
            method="GET",
            headers={
                "accept": "application/json",
                "referer": f"{CHATGPT_APP}/",
                "sec-fetch-site": "same-origin",
            },
            redirect="follow",
            timeout_ms=timeout_ms,
        )
    except Exception:
        result = {}
    if isinstance(result, dict) and result.get("ok") and isinstance(result.get("data"), dict):
        api_token = (result.get("data") or {}).get("csrfToken")
        if isinstance(api_token, str) and api_token.strip():
            return api_token.strip()
    try:
        cookies = _get_cookies(page)
    except Exception:
        cookies = {}
    for cookie_name in _NEXTAUTH_CSRF_COOKIE_NAMES:
        cookie_token = _csrf_token_from_cookie_value(cookies.get(cookie_name))
        if cookie_token:
            return cookie_token
    return ""


def _start_browser_signin(page, email: str, device_id: str, csrf_token: str) -> str:
    from urllib.parse import urlencode

    query = urlencode(
        {
            "prompt": "login",
            "ext-oai-did": device_id,
            "auth_session_logging_id": str(uuid.uuid4()),
            "screen_hint": "login_or_signup",
            "login_hint": email,
        }
    )
    body = urlencode(
        {
            "callbackUrl": f"{CHATGPT_APP}/",
            "csrfToken": csrf_token,
            "json": "true",
        }
    )
    result = _browser_fetch(
        page,
        f"{CHATGPT_APP}/api/auth/signin/openai?{query}",
        method="POST",
        headers={
            "accept": "application/json",
            "referer": f"{CHATGPT_APP}/",
            "origin": CHATGPT_APP,
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
        },
        body=body,
        redirect="follow",
    )
    if result.get("ok") and isinstance(result.get("data"), dict):
        return str((result.get("data") or {}).get("url") or "").strip()
    return ""


def _browser_authorize(page, auth_url: str, log) -> str:
    if not auth_url:
        return ""
    try:
        _goto_with_retry(page, auth_url, wait_until="domcontentloaded", timeout=30000, log=log)
        final_url = page.url
        log(f"Authorize -> {final_url[:120]}")
        return final_url
    except Exception as exc:
        log(f"Authorize 失败: {exc}")
        return ""


def _validate_browser_email_otp(page, code: str, device_id: str, user_agent: str, referer: str) -> dict:
    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=referer or f"{OPENAI_AUTH}/email-verification",
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )
    sentinel = _build_browser_sentinel_token(page, device_id, "email_otp_validate", user_agent)
    if sentinel:
        headers["openai-sentinel-token"] = sentinel
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/email-otp/validate",
        method="POST",
        headers=headers,
        body=json.dumps({"code": code}),
        redirect="follow",
    )


def _submit_browser_about_you(page, device_id: str, user_agent: str, referer: str) -> dict:
    from .constants import generate_random_user_info

    headers = _build_browser_headers(
        user_agent=user_agent,
        accept="application/json",
        referer=referer or f"{OPENAI_AUTH}/about-you",
        origin=OPENAI_AUTH,
        content_type="application/json",
        extra_headers={
            "sec-fetch-site": "same-origin",
            "oai-device-id": device_id,
            **_generate_datadog_trace_headers(),
        },
    )
    sentinel = _build_browser_sentinel_token(page, device_id, "oauth_create_account", user_agent)
    if sentinel:
        headers["openai-sentinel-token"] = sentinel
    user_info = generate_random_user_info()
    _browser_pause(page)
    return _browser_fetch(
        page,
        f"{OPENAI_AUTH}/api/accounts/create_account",
        method="POST",
        headers=headers,
        body=json.dumps(user_info),
        redirect="follow",
    )


def _complete_oauth_in_browser(page, oauth_start, proxy, log) -> dict | None:
    """在浏览器里完成 OAuth consent 流程，多策略重试点击 Continue。

    参考 Chrome 扩展项目的 step9 实现:
    - consent 页面是一个 <form action="/sign-in-with-chatgpt/.../consent">
    - 首选 form.requestSubmit(button) 而非 button.click()
    - 多轮重试: requestSubmit → click → dispatchEvent → 刷新重试
    """
    from .oauth import submit_callback_url

    CONSENT_FORM_SEL = OAUTH_CONSENT_FORM_SELECTOR
    MAX_ROUNDS = 4
    CLICK_EFFECT_TIMEOUT = 30

    def _try_extract_callback(url: str) -> dict | None:
        if not url or "code=" not in url:
            return None
        try:
            return json.loads(submit_callback_url(
                callback_url=url,
                expected_state=oauth_start.state,
                code_verifier=oauth_start.code_verifier,
                redirect_uri=oauth_start.redirect_uri,
                client_id=oauth_start.client_id,
                proxy_url=proxy,
            ))
        except ValueError as ve:
            # state 缺失或不匹配时，如果 URL 确实是我们的 callback，跳过 state 验证直接换 token
            if "state" in str(ve) and "localhost" in url and "code=" in url:
                try:
                    # 手动提取 code，跳过 state 验证
                    from urllib.parse import urlparse, parse_qs
                    parsed = urlparse(url)
                    params = parse_qs(parsed.query)
                    code = (params.get("code") or [""])[0]
                    if code:
                        from .oauth import _post_form, _jwt_claims_no_verify, OAUTH_TOKEN_URL
                        import time as _time
                        token_resp = _post_form(
                            OAUTH_TOKEN_URL,
                            {
                                "grant_type": "authorization_code",
                                "client_id": oauth_start.client_id,
                                "code": code,
                                "redirect_uri": oauth_start.redirect_uri,
                                "code_verifier": oauth_start.code_verifier,
                            },
                            proxy_url=proxy,
                        )
                        access_token = (token_resp.get("access_token") or "").strip()
                        refresh_token = (token_resp.get("refresh_token") or "").strip()
                        id_token = (token_resp.get("id_token") or "").strip()
                        if access_token:
                            claims = _jwt_claims_no_verify(id_token)
                            auth_claims = claims.get("https://api.openai.com/auth") or {}
                            now = int(_time.time())
                            expires_in = int(token_resp.get("expires_in") or 0)
                            return {
                                "id_token": id_token,
                                "access_token": access_token,
                                "refresh_token": refresh_token,
                                "account_id": str(auth_claims.get("chatgpt_account_id") or ""),
                                "email": str(claims.get("email") or ""),
                                "expired": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime(now + max(expires_in, 0))),
                                "last_refresh": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime(now)),
                            }
                except Exception:
                    pass
            return None
        except Exception:
            return None

    def _check_current_url() -> dict | None:
        url = str(page.url or "")
        result = _try_extract_callback(url)
        if result:
            return result
        cb = _extract_callback_url_from_exception(Exception(url))
        return _try_extract_callback(cb) if cb else None

    def _wait_for_callback(timeout_sec: int) -> dict | None:
        deadline = time.time() + timeout_sec
        checked_urls = set()
        while time.time() < deadline:
            try:
                url = str(page.url or "")
            except Exception:
                url = ""
            if url and url not in checked_urls:
                checked_urls.add(url)
                if "code=" in url or "localhost" in url:
                    log(f"  [callback_wait] 检测到 URL 变化: {url[:150]}")
            result = _check_current_url()
            if result:
                return result
            # 也检查是否有导航到 localhost 的请求（即使页面加载失败）
            if "localhost" in url and "code=" in url:
                result = _try_extract_callback(url)
                if result:
                    return result
            time.sleep(0.8)
        # 最后再检查一次
        try:
            final_url = str(page.url or "")
            if "code=" in final_url:
                log(f"  [callback_wait] 超时后最终 URL: {final_url[:150]}")
                result = _try_extract_callback(final_url)
                if result:
                    return result
        except Exception:
            pass
        return None

    def _find_consent_button():
        """按优先级查找 consent 页面的 Continue 按钮"""
        # 策略 1: 在 consent form 内找 submit 按钮
        _sel = CONSENT_FORM_SEL
        btn = page.evaluate("""(sel) => {
            const form = document.querySelector(sel);
            if (!form) return null;
            const buttons = form.querySelectorAll('button[type="submit"], input[type="submit"], [role="button"]');
            for (const el of buttons) {
                if (el.offsetParent === null) continue;
                const text = (el.textContent || '').trim().toLowerCase();
                const ddName = el.getAttribute('data-dd-action-name') || '';
                if (ddName === 'Continue' || /continue|继续|continuar|fortfahren|continuer|続ける/i.test(text)) return 'form-continue';
            }
            const first = Array.from(buttons).find(el => el.offsetParent !== null);
            if (first) return 'form-submit';
            return null;
        }""", _sel)
        if btn:
            return btn
        # 策略 2: 全局查找 Continue 按钮
        for sel in [
            'button[type="submit"][data-dd-action-name="Continue"]',
            'button:has-text("Continue")',
            'button:has-text("继续")',
            'button:has-text("Continuar")',
            'button:has-text("Fortfahren")',
            'button:has-text("Continuer")',
            'button:has-text("Allow")',
            'button:has-text("Authorize")',
            'button:has-text("続ける")',
            'button:has-text("続行")',
            'button:has-text("許可")',
            'button:has-text("認可")',
            'button[type="submit"]',
        ]:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=500):
                    return sel
            except Exception:
                continue
        return None

    def _click_strategy_request_submit(log_round: int) -> bool:
        """策略 1: form.requestSubmit(button) — 最可靠的表单提交方式"""
        try:
            result = page.evaluate("""(sel) => {
                const form = document.querySelector(sel);
                if (!form) return 'no-form';
                const buttons = form.querySelectorAll('button[type="submit"], input[type="submit"]');
                let target = null;
                for (const el of buttons) {
                    if (el.offsetParent === null) continue;
                    const text = (el.textContent || '').trim().toLowerCase();
                    const ddName = el.getAttribute('data-dd-action-name') || '';
                    if (ddName === 'Continue' || /continue|继续|continuar|fortfahren|continuer|続ける|続行|許可|認可/i.test(text)) { target = el; break; }
                }
                if (!target) target = Array.from(buttons).find(el => el.offsetParent !== null);
                if (!target) return 'no-button';
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit(target);
                    return 'requestSubmit';
                }
                target.click();
                return 'click-fallback';
            }""", CONSENT_FORM_SEL)
            log(f"  consent 第{log_round}轮 requestSubmit: {result}")
            return result not in ("no-form", "no-button")
        except Exception as e:
            log(f"  consent requestSubmit 异常: {e}")
            return False

    def _click_strategy_playwright(log_round: int) -> bool:
        """策略 2: Playwright locator.click()"""
        for sel in [
            'button:has-text("Continue")',
            'button:has-text("继续")',
            'button:has-text("Continuar")',
            'button:has-text("Fortfahren")',
            'button:has-text("Continuer")',
            'button:has-text("続ける")',
            'button:has-text("続行")',
            'button:has-text("許可")',
            'button:has-text("認可")',
            'button[type="submit"]',
        ]:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=1500):
                    loc.click()
                    log(f"  consent 第{log_round}轮 playwright click: {sel}")
                    return True
            except Exception:
                continue
        return False

    def _click_strategy_js_dispatch(log_round: int) -> bool:
        """策略 3: JS dispatchEvent 模拟点击"""
        try:
            result = page.evaluate("""() => {
                const buttons = document.querySelectorAll('button, [role="button"]');
                for (const el of buttons) {
                    if (el.offsetParent === null) continue;
                    const text = (el.textContent || '').trim().toLowerCase();
                    const ddName = el.getAttribute('data-dd-action-name') || '';
                    if (ddName === 'Continue' || /continue|继续|continuar|fortfahren|continuer/i.test(text)) {
                        el.focus();
                        el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
                        return text || 'dispatched';
                    }
                }
                return null;
            }
            """)
            if result:
                log(f"  consent 第{log_round}轮 JS dispatch: {result}")
                return True
            return False
        except Exception:
            return False

    strategies = [
        _click_strategy_request_submit,
        _click_strategy_playwright,
        _click_strategy_js_dispatch,
        _click_strategy_request_submit,
    ]

    try:
        current_url = str(page.url or "")
        log(f"  浏览器 consent 处理: {current_url[:100]}")

        # 先检查当前 URL 是否已经有 code
        result = _check_current_url()
        if result:
            log("  ✓ 页面已在 callback URL")
            return result

        # 等待页面加载
        try:
            page.wait_for_load_state("domcontentloaded", timeout=8000)
        except Exception:
            pass
        time.sleep(1)

        # 检查 "Try again" 按钮
        try:
            try_again = page.query_selector('button:has-text("Try again"), button:has-text("再試行"), button:has-text("もう一度")')
            if try_again and try_again.is_visible():
                log("  consent 页面报错，点击 Try again...")
                try_again.click()
                time.sleep(3)
        except Exception:
            pass

        # 多轮策略重试
        for round_idx in range(MAX_ROUNDS):
            result = _check_current_url()
            if result:
                log("  ✓ 浏览器 OAuth consent 完成")
                return result

            strategy_fn = strategies[min(round_idx, len(strategies) - 1)]
            clicked = strategy_fn(round_idx + 1)

            if clicked:
                # consent 提交后会跳转到 localhost:1455/auth/callback
                # 由于没有本地服务监听，浏览器可能报连接错误，但 URL 已经更新
                try:
                    page.wait_for_url("**/auth/callback*", timeout=15000)
                except Exception:
                    pass  # 超时或导航错误都忽略，下面会检查 URL
                time.sleep(1)
                result = _wait_for_callback(CLICK_EFFECT_TIMEOUT)
                if result:
                    log("  ✓ 浏览器 OAuth consent 完成")
                    return result
                log(f"  consent 第{round_idx + 1}轮点击后页面未跳转")
            else:
                log(f"  consent 第{round_idx + 1}轮未找到按钮")

            # 最后一轮前刷新页面重试
            if round_idx < MAX_ROUNDS - 1:
                log(f"  consent 刷新页面准备第{round_idx + 2}轮...")
                try:
                    _reload_with_retry(page, wait_until="domcontentloaded", timeout=15000, log=log)
                except Exception:
                    pass
                time.sleep(2)

        log(f"  consent {MAX_ROUNDS}轮尝试后仍未完成，当前: {str(page.url or '')[:100]}")
        return None
    except Exception as exc:
        cb = _extract_callback_url_from_exception(exc)
        if cb:
            result = _try_extract_callback(cb)
            if result:
                log("  ✓ 从异常中提取 callback 完成 OAuth")
                return result
        log(f"  浏览器 OAuth consent 异常: {exc}")
        return None


def _submit_oauth_password_direct(page, password: str, log) -> dict:
    """OAuth 流程专用：直接填密码登录，不尝试恢复到注册态。"""
    input_selector = _wait_for_any_selector(page, PASSWORD_INPUT_SELECTORS, timeout=15)
    if not input_selector:
        # 密码输入框没出现，可能页面还在加载或跳转了
        # 等一下再试
        time.sleep(2)
        input_selector = _wait_for_any_selector(page, PASSWORD_INPUT_SELECTORS, timeout=10)
    if not input_selector:
        raise RuntimeError("OAuth 密码页未找到输入框")
    if not _fill_input_like_user(page, input_selector, password):
        raise RuntimeError("OAuth 密码页填写失败")
    log(f"  OAuth 密码页输入框: {input_selector}")
    _browser_pause(page)

    submit_selector = _click_first(page, PASSWORD_SUBMIT_SELECTORS, timeout=8)
    if submit_selector:
        log(f"  OAuth 密码页已点击继续按钮: {submit_selector}")
    elif _submit_form_with_fallback(page, input_selector):
        log("  OAuth 密码页使用表单 fallback 提交")
    else:
        raise RuntimeError("OAuth 密码页未找到 Continue 按钮")

    # Account creation can stay in a disabled/spinner state for tens of
    # seconds on distant proxies even though the request is still in flight.
    deadline = time.time() + 90
    while time.time() < deadline:
        current_url = str(page.url or "")
        state = _derive_registration_state_from_page(page)
        page_type = str(state.get("page_type") or "")
        if page_type in {"email_otp_verification", "about_you", "consent", "workspace_selection",
                         "organization_selection", "add_phone", "oauth_callback", "chatgpt_home", "external_url"}:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if "code=" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        error_text = _extract_auth_error_text(page)
        if error_text:
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        time.sleep(0.5)
    return {"ok": False, "status": 0, "url": str(page.url or ""), "data": None, "text": "OAuth 密码提交后未跳转"}


def _submit_password_via_page(page, password: str, log, cancel_check=None) -> dict:
    _raise_if_cancelled(cancel_check)
    if _recover_signup_password_page(page, log):
        _cancelable_sleep(1, cancel_check)

    input_selector = _wait_for_any_selector(
        page,
        PASSWORD_INPUT_SELECTORS,
        timeout=15,
        cancel_check=cancel_check,
    )
    if not input_selector:
        raise RuntimeError("密码页未找到输入框")
    if not _fill_input_like_user(page, input_selector, password):
        raise RuntimeError("密码页填写失败")
    log(f"密码页输入框: {input_selector}")
    _browser_pause(page)

    start_url = str(page.url or "")
    submit_selector = (
        _click_first(page, PASSWORD_SUBMIT_SELECTORS, timeout=8)
        if cancel_check is None
        else _click_first(
            page,
            PASSWORD_SUBMIT_SELECTORS,
            timeout=8,
            cancel_check=cancel_check,
        )
    )
    if submit_selector:
        log(f"密码页已点击继续按钮: {submit_selector}")
    elif _submit_form_with_fallback(page, input_selector):
        log("密码页未找到可点击 Continue，已使用表单 fallback 提交")
    else:
        raise RuntimeError("密码页未找到 Continue 按钮")

    deadline = time.time() + 20
    last_url = str(page.url or "")
    while time.time() < deadline:
        _raise_if_cancelled(cancel_check)
        current_url = str(page.url or "")
        last_url = current_url or last_url
        state = _derive_registration_state_from_page(page)
        page_type = str(state.get("page_type") or "")
        if page_type in {"email_otp_verification", "about_you", "add_phone", "oauth_callback", "chatgpt_home"}:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if current_url != start_url and page_type and page_type not in {"create_account_password", "login_password"}:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if page_type == "login_password" and _recover_signup_password_page(page, log):
            input_selector = _wait_for_any_selector(
                page,
                PASSWORD_INPUT_SELECTORS,
                timeout=5,
                cancel_check=cancel_check,
            )
            if not input_selector:
                return {"ok": False, "status": 400, "url": current_url, "data": None, "text": "登录密码页恢复后未找到注册密码输入框"}
            if not _fill_input_like_user(page, input_selector, password):
                return {"ok": False, "status": 400, "url": current_url, "data": None, "text": "登录密码页恢复后密码重新填写失败"}
            submit_selector = _click_first(
                page,
                PASSWORD_SUBMIT_SELECTORS,
                timeout=5,
                cancel_check=cancel_check,
            )
            if submit_selector:
                log(f"恢复后重新点击密码提交按钮: {submit_selector}")
                start_url = str(page.url or start_url)
                _cancelable_sleep(0.4, cancel_check)
                continue
            if _submit_form_with_fallback(page, input_selector):
                log("恢复后未找到密码提交按钮，已使用表单 fallback 提交")
                start_url = str(page.url or start_url)
                _cancelable_sleep(0.4, cancel_check)
                continue
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": "登录密码页恢复后未找到提交方式"}
        error_text = _extract_auth_error_text(page)
        if error_text:
            _dump_debug(page, "chatgpt_password_fail")
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        _cancelable_sleep(0.5, cancel_check)
    _dump_debug(page, "chatgpt_password_fail")
    return {"ok": False, "status": 0, "url": last_url, "data": None, "text": "密码页提交后未跳转"}


def _submit_otp_via_page(
    page,
    code: str,
    log,
    cancel_check=None,
    *,
    deadline: float | None = None,
    expected_url_kind: str | None = None,
) -> dict:
    if deadline is not None:
        cancel_check = _password_settings_cancel_check(deadline, cancel_check)
    _raise_if_cancelled(cancel_check)
    otp = str(code or "").strip()
    if not otp:
        return {"ok": False, "status": 400, "url": page.url, "data": None, "text": "验证码为空"}
    if expected_url_kind:
        start_url = str(page.url or "")
        start_kind = _classify_password_reauth_url(start_url)
        if start_kind != "email_verification":
            return {
                "ok": False,
                "status": 0,
                "url": start_url,
                "data": None,
                "text": (
                    f"验证码提交前已离开原邮箱验证页 ({start_kind}): "
                    f"{_sanitize_password_error(start_url)}"
                ),
            }

    # 等待页面加载完成，确保 OTP 输入框已渲染
    try:
        page.wait_for_load_state(
            "domcontentloaded",
            timeout=_password_step_timeout_ms(deadline, 5, "等待验证码页加载"),
        )
    except Exception:
        pass
    _password_step_sleep(
        1,
        cancel_check,
        deadline=deadline,
        label="等待验证码输入框",
    )

    filled = False

    # 先尝试 6 格 OTP 输入框
    try:
        digit_inputs = page.locator(
            "input[inputmode='numeric'], input[autocomplete='one-time-code'], input[type='tel'], input[type='number']"
        )
        count = digit_inputs.count()
        if count >= len(otp):
            done = 0
            for i in range(min(count, len(otp))):
                _raise_if_cancelled(cancel_check)
                box = digit_inputs.nth(i)
                try:
                    box.wait_for(
                        state="visible",
                        timeout=_password_step_timeout_ms(deadline, 0.8, "等待分格验证码输入框"),
                    )
                    if deadline is None:
                        box.fill("")
                        box.type(otp[i], delay=random.randint(20, 60))
                    else:
                        box.fill(
                            "",
                            timeout=_password_step_timeout_ms(deadline, 0.8, "清空分格验证码输入框"),
                        )
                        box.type(
                            otp[i],
                            delay=random.randint(20, 60),
                            timeout=_password_step_timeout_ms(deadline, 1, "填写分格验证码输入框"),
                        )
                    done += 1
                except Exception:
                    break
            if done >= len(otp):
                filled = True
                log(f"验证码页已填写 {done} 位分格输入框")
    except Exception:
        pass

    # 再尝试单输入框
    if not filled:
        otp_candidates = [
            page.get_by_label(re.compile(r"verification code|code|otp|認証コード|確認コード|ワンタイムコード", re.IGNORECASE)),
            page.get_by_role("textbox", name=re.compile(r"verification code|code|otp|認証コード|確認コード|ワンタイムコード", re.IGNORECASE)),
            page.locator("input[autocomplete='one-time-code']"),
            page.locator("input[name*='code' i]"),
            page.locator("input[id*='code' i]"),
            page.locator("input[type='text']"),
            page.locator("input"),
        ]
        for candidate in otp_candidates:
            _raise_if_cancelled(cancel_check)
            try:
                target = candidate.first
                target.wait_for(
                    state="visible",
                    timeout=_password_step_timeout_ms(deadline, 1.2, "等待验证码输入框"),
                )
                target.click(
                    timeout=_password_step_timeout_ms(deadline, 1.2, "点击验证码输入框")
                )
                if deadline is None:
                    target.fill("")
                    target.type(otp, delay=random.randint(18, 45))
                else:
                    target.fill(
                        "",
                        timeout=_password_step_timeout_ms(deadline, 1.2, "清空验证码输入框"),
                    )
                    target.type(
                        otp,
                        delay=random.randint(18, 45),
                        timeout=_password_step_timeout_ms(deadline, 2, "填写验证码输入框"),
                    )
                final_value = str(target.input_value() or "").strip()
                if final_value:
                    filled = True
                    log("验证码页已填写单输入框")
                    break
            except Exception:
                continue

    if not filled:
        # 再等 3 秒重试一次（页面可能还在渲染）
        _password_step_sleep(
            3,
            cancel_check,
            deadline=deadline,
            label="重试等待验证码输入框",
        )
        otp_retry_selectors = [
            "input[inputmode='numeric']",
            "input[autocomplete='one-time-code']",
            "input[name*='code' i]",
            "input[type='text']",
        ]
        for sel in otp_retry_selectors:
            _raise_if_cancelled(cancel_check)
            try:
                target = page.locator(sel).first
                if target.is_visible(
                    timeout=_password_step_timeout_ms(deadline, 2, "重试等待验证码输入框")
                ):
                    target.click(
                        timeout=_password_step_timeout_ms(deadline, 1.5, "重试点击验证码输入框")
                    )
                    if deadline is None:
                        target.fill("")
                        target.type(otp, delay=random.randint(18, 45))
                    else:
                        target.fill(
                            "",
                            timeout=_password_step_timeout_ms(deadline, 1.2, "重试清空验证码输入框"),
                        )
                        target.type(
                            otp,
                            delay=random.randint(18, 45),
                            timeout=_password_step_timeout_ms(deadline, 2, "重试填写验证码输入框"),
                        )
                    if str(target.input_value() or "").strip():
                        filled = True
                        log("验证码页已填写单输入框(重试)")
                        break
            except Exception:
                continue

    if not filled:
        return {"ok": False, "status": 0, "url": page.url, "data": None, "text": "验证码页未找到可填写输入框"}

    if deadline is None:
        _browser_pause(page)
    else:
        _password_step_sleep(
            0.15,
            cancel_check,
            deadline=deadline,
            label="提交验证码",
        )
    otp_submit_selectors = [
        'button[type="submit"]',
        'button[data-testid="continue-button"]',
        'button:has-text("Continue")',
        'button:has-text("continue")',
        'button:has-text("Verify")',
        'button:has-text("verify")',
        'button:has-text("Next")',
        'button:has-text("next")',
        'button:has-text("続ける")',
        'button:has-text("確認")',
        'button:has-text("認証")',
        'button:has-text("次へ")',
    ]
    if expected_url_kind:
        submit_selector = _click_first_once_no_wait(
            page,
            otp_submit_selectors,
            timeout=8,
            cancel_check=cancel_check,
            deadline=deadline,
            label="验证码页提交",
            accepted_url_kind=expected_url_kind,
        )
    else:
        submit_selector = (
            _click_first(page, otp_submit_selectors, timeout=8)
            if cancel_check is None
            else _click_first(
                page,
                otp_submit_selectors,
                timeout=8,
                cancel_check=cancel_check,
            )
        )
    if not submit_selector:
        return {"ok": False, "status": 0, "url": page.url, "data": None, "text": "验证码页未找到 Continue 按钮"}
    log(f"验证码页已点击继续按钮: {submit_selector}")

    transition_deadline = time.monotonic() + 20
    if deadline is not None:
        transition_deadline = min(transition_deadline, deadline)
    last_url = page.url
    while True:
        current_url = str(page.url or "")
        last_url = current_url or last_url
        if expected_url_kind:
            current_kind = _classify_password_reauth_url(current_url)
            if current_kind == expected_url_kind:
                return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
            if current_kind != "email_verification":
                safe_url = _sanitize_password_error(current_url)
                return {
                    "ok": False,
                    "status": 0,
                    "url": current_url,
                    "data": None,
                    "text": f"验证码页提交后进入不受信任页面 ({current_kind}): {safe_url}",
                }
        if "about-you" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if "/reset-password/new-password" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if "add-phone" in current_url or "chatgpt.com" in current_url or "code=" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if "consent" in current_url or "sign-in-with-chatgpt" in current_url or "workspace" in current_url or "organization" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        _raise_if_cancelled(cancel_check)
        if time.monotonic() >= transition_deadline:
            break
        if deadline is not None:
            _password_settings_remaining(deadline, "等待验证码提交跳转")
        try:
            error_text = page.locator("text=Invalid code").first.text_content(
                timeout=_password_step_timeout_ms(deadline, 0.4, "检查验证码错误")
            )
        except Exception:
            error_text = ""
        if expected_url_kind and _classify_password_reauth_url(
            str(page.url or "")
        ) == expected_url_kind:
            return {
                "ok": True,
                "status": 200,
                "url": str(page.url or ""),
                "data": None,
                "text": "",
            }
        if error_text:
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        pause_deadline = min(transition_deadline, time.monotonic() + 0.5)
        while time.monotonic() < pause_deadline:
            if expected_url_kind and _classify_password_reauth_url(
                str(page.url or "")
            ) == expected_url_kind:
                return {
                    "ok": True,
                    "status": 200,
                    "url": str(page.url or ""),
                    "data": None,
                    "text": "",
                }
            _raise_if_cancelled(cancel_check)
            time.sleep(min(0.05, max(pause_deadline - time.monotonic(), 0.0)))
    current_url = str(page.url or "")
    if expected_url_kind and _classify_password_reauth_url(current_url) == expected_url_kind:
        return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
    if deadline is not None:
        _password_settings_remaining(deadline, "等待验证码提交跳转")
    return {"ok": False, "status": 0, "url": last_url, "data": None, "text": "验证码页提交后未跳转"}


def _submit_about_you_via_page(page, log) -> dict:
    from .constants import generate_random_user_info

    user_info = generate_random_user_info()
    name = str(user_info.get("name") or "").strip()
    birthdate = str(user_info.get("birthdate") or "").strip()
    if not name or not birthdate:
        raise RuntimeError("about_you 数据生成失败")
    date_parts = birthdate.split("-")
    if len(date_parts) == 3:
        yyyy, mm, dd = date_parts
        us_birthdate = f"{mm}/{dd}/{yyyy}"
        cn_birthdate = f"{yyyy}/{mm}/{dd}"
    else:
        us_birthdate = birthdate
        cn_birthdate = birthdate.replace("-", "/")
    log(f"about_you 表单: name={name}, birthdate={birthdate}, ui_birthdate={us_birthdate}, cn_birthdate={cn_birthdate}")

    def _fill_locator(locator, value: str) -> bool:
        try:
            target = locator.first
            target.wait_for(state="visible", timeout=1500)
            target.click(timeout=1500)
            _browser_pause(page, headed=False)
            try:
                applied = bool(
                    target.evaluate(
                        """
                        (input, nextValue) => {
                          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                          if (!setter) return false;
                          setter.call(input, nextValue);
                          input.dispatchEvent(new Event('input', { bubbles: true }));
                          input.dispatchEvent(new Event('change', { bubbles: true }));
                          return String(input.value || '') === String(nextValue || '');
                        }
                        """,
                        value,
                    )
                )
            except Exception:
                applied = False
            if not applied:
                target.fill("")
                target.type(value, delay=random.randint(25, 70))
            try:
                target.dispatch_event("blur")
            except Exception:
                pass
            final_val = str(target.input_value() or "").strip()
            return final_val == str(value).strip()
        except Exception:
            return False

    def _locator_from_visible_input_entry(entry: dict):
        try:
            visible_index = int(entry.get("visibleIndex"))
        except Exception:
            return None
        return page.locator("input:visible:not([type='hidden']):not([disabled]):not([readonly])").nth(visible_index)

    def _fill_visible_input_entry(entry: dict | None, value: str) -> bool:
        if not entry:
            return False
        locator = _locator_from_visible_input_entry(entry)
        if locator is None:
            return False
        return _fill_locator(locator, value)

    def _resolve_visible_input_selector(selectors: list[str]) -> str | None:
        for selector in selectors:
            try:
                locator = page.locator(selector).first
                locator.wait_for(state="visible", timeout=500)
                return selector
            except Exception:
                continue
        return None

    def _fill_second_visible_input(values: list[str], excluded_visible_indices: set[int] | None = None) -> bool:
        """兜底：about_you 卡片一般是 Full name + Birthday/Age 两个输入框。"""
        try:
            locator = page.locator(
                "input:visible:not([type='hidden']):not([disabled]):not([readonly])"
            )
            count = locator.count()
            if count < 2:
                return False
            excluded = {int(value) for value in (excluded_visible_indices or set())}
            target_index = None
            for idx in range(count):
                if idx not in excluded:
                    target_index = idx
                    if idx > 0:
                        break
            if target_index is None:
                return False
            target = locator.nth(target_index)
            target.click(timeout=1200)
            _browser_pause(page, headed=False)
            for value in values:
                try:
                    target.fill("")
                except Exception:
                    pass
                try:
                    target.type(str(value), delay=random.randint(18, 45))
                except Exception:
                    continue
                final_val = str(target.input_value() or "").strip()
                if final_val:
                    return True
            return False
        except Exception:
            return False

    def _has_visible(locator) -> bool:
        try:
            locator.first.wait_for(state="visible", timeout=700)
            return True
        except Exception:
            return False

    def _fill_birthday_selects(yyyy: str, mm: str, dd: str) -> bool:
        """处理 Month/Day/Year 下拉样式的生日控件。"""
        try:
            select_locator = page.locator("select:visible")
            count = select_locator.count()
            if count < 2:
                return False

            month_num = int(mm)
            day_num = int(dd)
            year_num = int(yyyy)
            month_short = time.strftime("%b", time.strptime(str(month_num), "%m"))
            month_full = time.strftime("%B", time.strptime(str(month_num), "%m"))

            assigned = {"month": False, "day": False, "year": False}

            for i in range(count):
                sel = select_locator.nth(i)
                try:
                    options = sel.locator("option")
                    option_count = options.count()
                except Exception:
                    option_count = 0
                if option_count <= 0:
                    continue

                texts: list[str] = []
                for idx in range(min(option_count, 80)):
                    try:
                        texts.append(str(options.nth(idx).inner_text(timeout=300) or "").strip())
                    except Exception:
                        continue
                joined = " ".join(texts).lower()

                try:
                    if (not assigned["month"]) and (
                        "january" in joined or "february" in joined or "march" in joined or "april" in joined
                    ):
                        for candidate in (month_full, month_short, str(month_num), f"{month_num:02d}"):
                            try:
                                sel.select_option(label=candidate, timeout=800)
                                assigned["month"] = True
                                break
                            except Exception:
                                try:
                                    sel.select_option(value=candidate, timeout=800)
                                    assigned["month"] = True
                                    break
                                except Exception:
                                    continue
                        continue

                    if (not assigned["year"]) and any(str(y) in joined for y in (year_num, year_num - 1, year_num + 1, 2026, 2025)):
                        for candidate in (str(year_num),):
                            try:
                                sel.select_option(label=candidate, timeout=800)
                                assigned["year"] = True
                                break
                            except Exception:
                                try:
                                    sel.select_option(value=candidate, timeout=800)
                                    assigned["year"] = True
                                    break
                                except Exception:
                                    continue
                        continue

                    if (not assigned["day"]) and any(str(x) in joined for x in (" 1 ", "2", "30", "31")):
                        for candidate in (str(day_num), f"{day_num:02d}"):
                            try:
                                sel.select_option(label=candidate, timeout=800)
                                assigned["day"] = True
                                break
                            except Exception:
                                try:
                                    sel.select_option(value=candidate, timeout=800)
                                    assigned["day"] = True
                                    break
                                except Exception:
                                    continue
                except Exception:
                    continue

            # 下拉顺序兜底：month/day/year
            if count >= 3:
                try:
                    if not assigned["month"]:
                        select_locator.nth(0).select_option(label=month_short, timeout=800)
                        assigned["month"] = True
                except Exception:
                    pass
                try:
                    if not assigned["day"]:
                        select_locator.nth(1).select_option(label=str(day_num), timeout=800)
                        assigned["day"] = True
                except Exception:
                    pass
                try:
                    if not assigned["year"]:
                        select_locator.nth(2).select_option(label=str(year_num), timeout=800)
                        assigned["year"] = True
                except Exception:
                    pass

            return assigned["month"] and assigned["day"] and assigned["year"]
        except Exception:
            return False

    visible_inputs = _collect_visible_text_inputs(page)
    if visible_inputs:
        log(
            "about_you 可见输入框: "
            + " | ".join(
                f"#{int(item.get('visibleIndex', 0))} {(_about_you_input_hints(item) or '-')[:80]}"
                for item in visible_inputs[:4]
            )
        )
    ordered_visible_entries = sorted(
        [item for item in visible_inputs if str(item.get("visibleIndex", "")).isdigit()],
        key=lambda item: int(item.get("visibleIndex", 0)),
    )
    name_entry = _pick_best_about_you_input(visible_inputs, "name")
    age_entry = _pick_best_about_you_input(
        visible_inputs,
        "age",
        exclude_visible_indices={int(name_entry.get("visibleIndex"))} if name_entry and str(name_entry.get("visibleIndex", "")).isdigit() else set(),
    )

    name_candidates = [
        page.get_by_label(re.compile(r"full\s*name", re.IGNORECASE)),
        page.get_by_label(re.compile(r"全名|姓名|氏名|お名前|フルネーム", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"full\s*name|name", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"全名|姓名|氏名|お名前|フルネーム", re.IGNORECASE)),
        page.locator("input[autocomplete='name']"),
        page.locator("input[name*='name' i]"),
        page.locator("input[id*='name' i]"),
        page.locator("input[name*='姓名']"),
        page.locator("input[id*='姓名']"),
        page.locator(
            "xpath=//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'full name')]/following::input[1]"
        ),
        page.locator("xpath=//*[contains(normalize-space(string(.)),'全名') or contains(normalize-space(string(.)),'姓名')]/following::input[1]"),
    ]
    birthday_candidates = [
        page.get_by_label(re.compile(r"birthday|date of birth|birth", re.IGNORECASE)),
        page.get_by_label(re.compile(r"生日|出生|生年月日|誕生日", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"birthday|date of birth|birth", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"生日|出生|生年月日|誕生日", re.IGNORECASE)),
        page.get_by_placeholder(re.compile(r"mm.?dd.?yyyy|yyyy.?mm.?dd|birthday|生日|生年月日|誕生日", re.IGNORECASE)),
        page.locator("input[name*='birth' i]"),
        page.locator("input[id*='birth' i]"),
        page.locator("input[placeholder*='MM' i]"),
        page.locator("input[placeholder*='DD' i]"),
        page.locator("input[placeholder*='YYYY' i]"),
        page.locator("input[placeholder*='年']"),
        page.locator("input[placeholder*='月']"),
        page.locator("input[placeholder*='日']"),
        page.locator("input[inputmode='numeric']"),
        page.locator(
            "xpath=//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'birthday')]/following::input[1]"
        ),
        page.locator("xpath=//*[contains(normalize-space(string(.)),'生日') or contains(normalize-space(string(.)),'出生')]/following::input[1]"),
        page.locator("input[type='date']"),
    ]

    age_years = None
    try:
        age_years = _age_on_date(birthdate)
        if not 18 <= age_years <= 100:
            raise ValueError("generated age is outside the accepted range")
    except Exception:
        age_years = random.randint(25, 35)

    age_candidates = [
        page.get_by_label(re.compile(r"age", re.IGNORECASE)),
        page.get_by_label(re.compile(r"年龄|年齢", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"age", re.IGNORECASE)),
        page.get_by_role("textbox", name=re.compile(r"年龄|年齢", re.IGNORECASE)),
        page.locator("input[name*='age' i]"),
        page.locator("input[id*='age' i]"),
        page.locator("input[placeholder*='Age' i]"),
        page.locator("input[placeholder*='年龄']"),
        page.locator("input[placeholder*='年齢']"),
        page.locator(
            "xpath=//*[contains(translate(normalize-space(string(.)),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'age')]/following::input[1]"
        ),
        page.locator("xpath=//*[contains(normalize-space(string(.)),'年龄')]/following::input[1]"),
    ]

    fill_result = {"name": False, "birthdate": False, "age": False, "month": False, "day": False, "year": False}
    if _fill_visible_input_entry(name_entry, name):
        fill_result["name"] = True
    if not fill_result.get("name"):
        for candidate in name_candidates:
            if _fill_locator(candidate, name):
                fill_result["name"] = True
                break
    mode_probe = {}
    try:
        mode_probe = page.evaluate(
            """
            () => {
              const labels = Array.from(document.querySelectorAll('label'))
                .map((n) => String(n.textContent || '').trim().toLowerCase())
                .filter(Boolean);
              const placeholders = Array.from(document.querySelectorAll('input'))
                .map((n) => String(n.placeholder || '').trim().toLowerCase())
                .filter(Boolean);
              const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
                .map((n) => String(n.textContent || '').trim().toLowerCase())
                .filter(Boolean);
              const allText = labels.concat(placeholders).concat(headings);
              const hasAge = allText.some((t) => t === 'age' || t === 'edad' || t === 'âge' || t === 'alter' || t === 'idade' || t === '年齢' || t === 'вік' || t === 'возраст' || t.includes('how old') || t.includes('年龄') || t.includes('年齢') || t.includes('나이'));
              const hasBirthday = allText.some((t) =>
                t.includes('birthday') || t.includes('date of birth') || t.includes('birth') || t.includes('生日') || t.includes('出生') || t.includes('生年月日') || t.includes('誕生日') || t.includes('fecha de nacimiento') || t.includes('nascimento') || t.includes('geburtstag') || t.includes('naissance') || t.includes('дата народження') || t.includes('дата рождения')
              );
              return { labels, placeholders, headings, hasAge, hasBirthday };
            }
            """
        ) or {}
    except Exception:
        mode_probe = {}

    has_age_label = bool(mode_probe.get("hasAge"))
    has_birthday_label = bool(mode_probe.get("hasBirthday"))
    try:
        has_stable_age_input = page.locator(
            "input:visible[name='age' i], input:visible[id='age' i], "
            "input:visible[name*='_age' i], input:visible[id*='-age' i]"
        ).count() > 0
    except Exception:
        has_stable_age_input = False
    try:
        has_stable_birthday_input = page.locator(
            "input:visible[name*='birth' i], input:visible[id*='birth' i], "
            "input:visible[type='date'], input:visible[data-type='month'], "
            "input:visible[data-type='day'], input:visible[data-type='year']"
        ).count() > 0
    except Exception:
        has_stable_birthday_input = False
    has_age_field = bool(age_entry) or has_stable_age_input
    has_birthday_field = has_stable_birthday_input or any(_has_visible(candidate) for candidate in birthday_candidates[:7])
    has_birthday_select = False
    try:
        has_birthday_select = page.locator("select:visible").count() >= 2
    except Exception:
        has_birthday_select = False
    about_mode = _classify_about_you_mode(
        has_age_label=has_age_label,
        has_birthday_label=has_birthday_label,
        has_age_field=has_age_field,
        has_birthday_field=has_birthday_field,
        has_birthday_select=has_birthday_select,
    )
    log(f"about_you 页面模式: {about_mode} labels={mode_probe.get('labels', [])[:4]}")
    direct_name_selector = _resolve_visible_input_selector(
        [
            'input[name="name"]',
            'input[name="full_name"]',
            'input[autocomplete="name"]',
            'input[placeholder*="全名"]',
            'input[placeholder*="name" i]',
            'input[id*="name" i]:not([type="hidden"])',
        ]
    )
    direct_age_selector = _resolve_visible_input_selector(
        [
            'input[name="age"]',
            'input[placeholder="Age"]',
            'input[placeholder="age"]',
            'input[placeholder*="年龄"]',
            'input[id*="age" i]',
        ]
    )
    if about_mode == "age" and len(ordered_visible_entries) >= 2:
        name_entry = ordered_visible_entries[0]
        age_entry = ordered_visible_entries[1]
        log(
            f"about_you age 输入框映射: name=#{int(name_entry.get('visibleIndex', 0))}, "
            f"age=#{int(age_entry.get('visibleIndex', 0))}"
        )
    if about_mode == "age":
        log(
            "about_you age 直接定位: "
            f"name={direct_name_selector or '-'}, age={direct_age_selector or '-'}"
        )

    def _fill_segmented_date(mm: str, dd: str, yyyy: str) -> bool:
        """处理 MM / DD / YYYY 分段日期输入框（React DateField 样式）。
        特征：一个 Birthday label 下有多个小 input 或 div[data-type] 段。"""
        try:
            # 方式1: div[data-type] 段 (React Aria DateField)
            month_seg = page.locator('div[data-type="month"], input[data-type="month"]')
            day_seg = page.locator('div[data-type="day"], input[data-type="day"]')
            year_seg = page.locator('div[data-type="year"], input[data-type="year"]')
            if month_seg.count() > 0 and day_seg.count() > 0 and year_seg.count() > 0:
                month_seg.first.click(force=True)
                page.keyboard.type(mm, delay=50)
                time.sleep(0.3)
                day_seg.first.click(force=True)
                page.keyboard.type(dd, delay=50)
                time.sleep(0.3)
                year_seg.first.click(force=True)
                page.keyboard.type(yyyy, delay=50)
                return True

            # 方式2: 单个 date input 里有 MM/DD/YYYY 占位符
            # 点击输入框，然后按顺序输入 MM DD YYYY（Tab 切换段）
            date_input = page.locator("input[placeholder*='MM'], input[placeholder*='mm'], input[type='date']")
            if date_input.count() > 0:
                date_input.first.click(force=True)
                time.sleep(0.2)
                page.keyboard.type(mm, delay=50)
                page.keyboard.type(dd, delay=50)
                page.keyboard.type(yyyy, delay=50)
                return True

            # 方式3: Birthday label 下的第二个可见 input，直接点击后按数字键输入
            birthday_input = page.get_by_label(re.compile(r"birthday|birth", re.IGNORECASE))
            if birthday_input.count() > 0:
                birthday_input.first.click(force=True)
                time.sleep(0.2)
                page.keyboard.type(mm, delay=50)
                page.keyboard.type(dd, delay=50)
                page.keyboard.type(yyyy, delay=50)
                return True

        except Exception:
            pass
        return False

    if about_mode == "birthday_select":
        if len(date_parts) == 3 and _fill_birthday_selects(yyyy, mm, dd):
            fill_result["month"] = True
            fill_result["day"] = True
            fill_result["year"] = True
            fill_result["birthdate"] = True
    elif about_mode == "age":
        if direct_name_selector and _fill_input_like_user(page, direct_name_selector, name):
            fill_result["name"] = True
        elif _fill_visible_input_entry(name_entry, name):
            fill_result["name"] = True
        if age_years is not None:
            if direct_age_selector and _fill_input_like_user(page, direct_age_selector, str(age_years)):
                fill_result["age"] = True
            elif _fill_visible_input_entry(age_entry, str(age_years)):
                fill_result["age"] = True
            if not fill_result.get("age") and len(ordered_visible_entries) < 2:
                for candidate in age_candidates:
                    if _fill_locator(candidate, str(age_years)):
                        fill_result["age"] = True
                        break
        # fallback: 直接找 placeholder="Age" 的输入框
        if not fill_result.get("age") and age_years is not None and len(ordered_visible_entries) < 2:
            try:
                age_input = page.locator("input[placeholder='Age'], input[placeholder='age']")
                if age_input.count() > 0:
                    age_input.first.click(force=True)
                    time.sleep(0.2)
                    age_input.first.fill("")
                    age_input.first.type(str(age_years), delay=random.randint(30, 60))
                    fill_result["age"] = True
            except Exception:
                pass
        if not fill_result.get("age") and age_years is not None:
            excluded_indices = set()
            if name_entry and str(name_entry.get("visibleIndex", "")).isdigit():
                excluded_indices.add(int(name_entry.get("visibleIndex")))
            if _fill_second_visible_input([str(age_years)], excluded_visible_indices=excluded_indices):
                fill_result["age"] = True
        if len(date_parts) == 3 and _sync_hidden_birthday_input(page, f"{yyyy}-{mm}-{dd}", log):
            fill_result["birthdate"] = True
    elif about_mode == "birthday" or about_mode == "birthday_text":
        # 先尝试分段日期输入（MM / DD / YYYY 格式的 DateField）
        if len(date_parts) == 3 and _fill_segmented_date(mm, dd, yyyy):
            fill_result["birthdate"] = True
            log("about_you 使用分段日期输入成功")
        # 再尝试普通文本输入
        if not fill_result.get("birthdate"):
            for candidate in birthday_candidates:
                if _fill_locator(candidate, cn_birthdate):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, us_birthdate):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, birthdate):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, cn_birthdate.replace("/", "")):
                    fill_result["birthdate"] = True
                    break
                if _fill_locator(candidate, us_birthdate.replace("/", "")):
                    fill_result["birthdate"] = True
                    break
        # Never type a date into an unknown positional field. Localized age
        # forms also contain exactly two inputs, and the second one is Age.

    if about_mode == "age":
        age_locator = None
        if direct_age_selector:
            age_locator = page.locator(direct_age_selector).first
        elif age_entry:
            age_locator = _locator_from_visible_input_entry(age_entry)
        if age_locator is None:
            if fill_result.get("birthdate"):
                log("about_you 当前变体没有可见年龄框，仅同步隐藏 birthday，不向未知控件输入日期")
            else:
                raise RuntimeError("about_you age 模式未找到稳定的年龄输入框")
        else:
            try:
                actual_age = str(age_locator.input_value() or "").strip()
            except Exception:
                actual_age = ""
            valid_age = bool(re.fullmatch(r"\d{1,3}", actual_age)) and 18 <= int(actual_age) <= 100
            if not valid_age and age_years is not None:
                _fill_locator(age_locator, str(age_years))
                try:
                    actual_age = str(age_locator.input_value() or "").strip()
                except Exception:
                    actual_age = ""
                valid_age = bool(re.fullmatch(r"\d{1,3}", actual_age)) and 18 <= int(actual_age) <= 100
            if not valid_age:
                raise RuntimeError(f"about_you 年龄输入校验失败: {actual_age or '-'}")
            fill_result["age"] = True
            log(f"about_you 年龄输入已校验: {actual_age}")

    log(f"about_you 填写结果: {fill_result}")
    if not fill_result.get("name"):
        raise RuntimeError("about_you 未成功填写 Full name")
    if not (
        fill_result.get("birthdate")
        or fill_result.get("age")
        or (fill_result.get("month") and fill_result.get("day") and fill_result.get("year"))
    ):
        raise RuntimeError("about_you 未成功填写 Birthday/Age")
    _browser_pause(page)

    try:
        visible_buttons = page.evaluate(
            r"""
            () => Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
              .filter((node) => {
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return !node.disabled && style.display !== 'none' && style.visibility !== 'hidden'
                  && rect.width > 0 && rect.height > 0;
              })
              .map((node) => ({
                tag: node.tagName.toLowerCase(),
                type: node.getAttribute('type') || '',
                text: String(node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
                testid: node.getAttribute('data-testid') || '',
              }))
            """
        ) or []
    except Exception:
        visible_buttons = []
    log(f"about_you 可见提交控件: {visible_buttons[:6]}")

    submit_selector = _click_first(
        page,
        [
            'main form button:not([disabled])',
            'form button:not([disabled])',
            'button:has-text("Finish creating account")',
            'button:has-text("finish creating account")',
            'button[type="submit"]',
            'input[type="submit"]',
            'button[data-testid="continue-button"]',
            'button:has-text("Continue")',
            'button:has-text("continue")',
            'button:has-text("Next")',
            'button:has-text("next")',
            'button:has-text("続行")',
            'button:has-text("次へ")',
            'button:has-text("アカウント")',
            'button:has-text("继续")',
            'button:has-text("下一步")',
            'button:has-text("Продовжити")',
            'button:has-text("Продолжить")',
            '[role="button"][data-testid="continue-button"]',
        ],
        timeout=8,
    )
    if not submit_selector:
        state_after_fill = _derive_registration_state_from_page(page)
        if not _is_about_you(state_after_fill):
            log(f"about_you 填写后页面已自动推进: page={state_after_fill.get('page_type') or '-'}")
            return {"ok": True, "status": 200, "url": page.url, "data": state_after_fill, "text": ""}
        try:
            age_locator.press("Enter") if about_mode == "age" and age_locator is not None else page.keyboard.press("Enter")
            submit_selector = "age-input:Enter" if about_mode == "age" else "keyboard:Enter"
        except Exception:
            raise RuntimeError(f"about_you 未找到提交按钮: {visible_buttons[:6]}")
    log(f"about_you 已点击继续按钮: {submit_selector}")

    deadline = time.time() + 20
    retried_generic_validation = False
    last_url = page.url
    while time.time() < deadline:
        current_url = page.url
        last_url = current_url or last_url
        if "code=" in current_url or "chatgpt.com" in current_url or "sign-in-with-chatgpt" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        if "add-phone" in current_url:
            return {"ok": True, "status": 200, "url": current_url, "data": None, "text": ""}
        try:
            error_text = page.locator("text=Sorry, we cannot create your account").first.text_content(timeout=500)
        except Exception:
            error_text = ""
        if not error_text:
            try:
                error_text = page.locator("text=Enter a valid age to continue").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        if not error_text:
            try:
                error_text = page.locator("text=doesn't look right").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        if not error_text:
            try:
                error_text = page.locator("[role='alert']").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        if not error_text:
            try:
                error_text = page.locator(".error, [class*='error'], [class*='Error']").first.text_content(timeout=300)
            except Exception:
                error_text = ""
        if error_text and "oai_log" not in error_text and "SSR_HTML" not in error_text:
            normalized_error = str(error_text).strip().lower()
            if (
                about_mode == "age"
                and not retried_generic_validation
                and ("doesn't look right" in normalized_error or "try again" in normalized_error)
            ):
                retried_generic_validation = True
                log("about_you age 模式提交被拒，重新同步 Full name/Age/hidden birthday 后重试一次...")
                if direct_name_selector and _fill_input_like_user(page, direct_name_selector, name):
                    fill_result["name"] = True
                elif _fill_visible_input_entry(name_entry, name):
                    fill_result["name"] = True
                elif len(ordered_visible_entries) < 2:
                    for candidate in name_candidates:
                        if _fill_locator(candidate, name):
                            fill_result["name"] = True
                            break
                if age_years is not None:
                    if direct_age_selector and _fill_input_like_user(page, direct_age_selector, str(age_years)):
                        fill_result["age"] = True
                    elif _fill_visible_input_entry(age_entry, str(age_years)):
                        fill_result["age"] = True
                    elif len(ordered_visible_entries) < 2:
                        for candidate in age_candidates:
                            if _fill_locator(candidate, str(age_years)):
                                fill_result["age"] = True
                                break
                if len(date_parts) == 3 and _sync_hidden_birthday_input(page, f"{yyyy}-{mm}-{dd}", log):
                    fill_result["birthdate"] = True
                _browser_pause(page)
                retry_submit_selector = _click_first(
                    page,
                    [
                        'button:has-text("Finish creating account")',
                        'button:has-text("finish creating account")',
                        'button[type="submit"]',
                        'button[data-testid="continue-button"]',
                        'button:has-text("Continue")',
                        'button:has-text("continue")',
                        'button:has-text("Next")',
                        'button:has-text("next")',
                    ],
                    timeout=5,
                )
                if retry_submit_selector:
                    log(f"about_you 重试提交按钮: {retry_submit_selector}")
                    time.sleep(0.5)
                    continue
            return {"ok": False, "status": 400, "url": current_url, "data": None, "text": error_text}
        time.sleep(0.5)
    _dump_debug(page, "chatgpt_about_you_fail")
    return {"ok": False, "status": 0, "url": last_url, "data": None, "text": "about_you 提交后未跳转"}


def _browser_registration_flow(
    page,
    email: str,
    password: str,
    otp_callback,
    phone_callback,
    log,
    password_factory: Optional[Callable[[], str]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    auto_continue_post_signup: bool = True,
    manual_post_signup_timeout: int = 300,
) -> dict:
    _raise_if_cancelled(cancel_check)
    password = str(password or "").strip()
    configured_password = ""
    password_source = "none"

    def _new_signup_password() -> str:
        nonlocal password
        if not password:
            factory = password_factory or _generate_browser_registration_password
            password = str(factory() or "").strip()
        if not password:
            raise RuntimeError("注册密码生成失败")
        return password

    device_id = str(uuid.uuid4())
    try:
        user_agent = str(page.evaluate("() => navigator.userAgent") or "").strip() or _random_chrome_ua()
    except Exception:
        user_agent = _random_chrome_ua()

    _seed_browser_device_id(page, device_id)
    try:
        log("使用 ChatGPT NextAuth 注册入口启动浏览器注册")
        state = _start_browser_signup_via_authorize(page, email, device_id, log)
    except Exception as exc:
        log(f"ChatGPT NextAuth 注册入口失败: {exc}")
        raise
    auth_cookies = _get_cookies(page)
    log(
        "授权态 cookies: "
        f"login_session={'yes' if auth_cookies.get('login_session') else 'no'}, "
        f"oai-did={'yes' if auth_cookies.get('oai-did') else 'no'}"
    )
    log(f"注册状态起点: page={state.get('page_type') or '-'} url={(state.get('current_url') or '')[:100]}")
    register_submitted = False
    seen_states: dict[str, int] = {}

    for step in range(12):
        _raise_if_cancelled(cancel_check)
        signature = "|".join(
            [
                str(state.get("page_type") or ""),
                str(state.get("method") or ""),
                str(state.get("continue_url") or ""),
                str(state.get("current_url") or ""),
            ]
        )
        seen_states[signature] = seen_states.get(signature, 0) + 1
        log(
            f"注册状态推进: step={step+1} page={state.get('page_type') or '-'} "
            f"next={str(state.get('continue_url') or '')[:60]} seen={seen_states[signature]}"
        )
        if seen_states[signature] > 2:
            raise RuntimeError(f"注册状态卡住: page={state.get('page_type') or '-'}")

        if _is_registration_complete(state):
            onboarding_kwargs = {}
            if cancel_check is not None:
                onboarding_kwargs["cancel_check"] = cancel_check
            if not auto_continue_post_signup:
                onboarding_kwargs.update(
                    {
                        "auto_continue_legal_gate": False,
                        "manual_continue_timeout": min(
                            max(int(manual_post_signup_timeout or 300), 1),
                            300,
                        ),
                    }
                )
            readiness = _handle_post_signup_onboarding(page, log, **onboarding_kwargs)
            final_state = _extract_flow_state(None, page.url)
            final_state.update(readiness)
            final_state.update(
                {
                    "password": configured_password,
                    "password_set": bool(configured_password),
                    "password_status": "configured" if configured_password else "not_configured",
                    "password_source": password_source if configured_password else "none",
                }
            )
            return final_state

        if _is_password_registration(state):
            if register_submitted:
                raise RuntimeError("重复进入密码注册阶段")
            log("提交注册密码...")
            pre_cookies = _get_cookies(page)
            log(
                "密码阶段 cookies: "
                f"login_session={'yes' if pre_cookies.get('login_session') else 'no'}, "
                f"oai-client-auth-session={'yes' if pre_cookies.get('oai-client-auth-session') else 'no'}"
            )
            active_password = _new_signup_password()
            reg_resp = (
                _submit_password_via_page(page, active_password, log)
                if cancel_check is None
                else _submit_password_via_page(
                    page,
                    active_password,
                    log,
                    cancel_check=cancel_check,
                )
            )
            log(f"密码页提交状态: {reg_resp.get('status', 0)}")
            if not reg_resp.get("ok"):
                raise RuntimeError(f"密码页提交失败: {(reg_resp.get('text') or '')[:300]}")
            register_submitted = True
            configured_password = active_password
            password_source = "signup_required"
            state = _extract_flow_state(reg_resp.get("data"), reg_resp.get("url", page.url))
            if not state.get("page_type") or _is_password_registration(state):
                state = _derive_registration_state_from_page(page)
            continue

        if str(state.get("page_type") or "") == "login_password":
            if _recover_signup_password_page(page, log):
                state = _derive_registration_state_from_page(page)
                continue
            if not password:
                raise RuntimeError("注册流程进入已有账号登录密码页，但未提供已知密码")
            log("注册流程落到已有账号登录密码页，按登录流程继续认证...")
            login_resp = _submit_oauth_password_direct(page, password, log)
            log(f"登录密码页提交状态: {login_resp.get('status', 0)}")
            if not login_resp.get("ok"):
                raise RuntimeError(f"登录密码页提交失败: {(login_resp.get('text') or '')[:300]}")
            configured_password = password
            password_source = "signup_required"
            state = _extract_flow_state(login_resp.get("data"), login_resp.get("url", page.url))
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            continue

        if _is_email_otp(state):
            if not otp_callback:
                raise RuntimeError("ChatGPT 注册需要邮箱验证码但未提供 otp_callback")
            log("等待 ChatGPT 验证码")
            _raise_if_cancelled(cancel_check)
            code = otp_callback()
            _raise_if_cancelled(cancel_check)
            if not code:
                raise RuntimeError("未获取到验证码")
            otp_page_url = str(page.url or state.get("current_url") or f"{OPENAI_AUTH}/email-verification")
            fallback_state = None
            otp_resp = (
                _submit_otp_via_page(page, code, log)
                if cancel_check is None
                else _submit_otp_via_page(page, code, log, cancel_check=cancel_check)
            )
            if _is_registration_otp_dom_failure(otp_resp):
                log("验证码页 DOM 提交不可用，改用同一浏览器会话 API 校验")
                try:
                    _dump_debug(page, "chatgpt_registration_otp_dom_missing")
                except Exception as exc:
                    log(f"验证码页调试快照保存失败: {_sanitize_password_error(exc)}")
                try:
                    api_resp = _validate_browser_email_otp(
                        page,
                        code,
                        device_id,
                        user_agent,
                        otp_page_url,
                    )
                except Exception as exc:
                    api_resp = {
                        "ok": False,
                        "status": 0,
                        "url": otp_page_url,
                        "data": None,
                        "text": f"同浏览器 API 校验异常: {_sanitize_password_error(exc)}",
                    }
                log(f"验证码同浏览器 API 校验状态: {api_resp.get('status', 0)}")
                api_state = _extract_flow_state(api_resp.get("data"), otp_page_url)
                if api_resp.get("ok") and api_state.get("page_type") and not _is_email_otp(api_state):
                    otp_resp = api_resp
                    fallback_state = api_state
                    log(
                        "验证码同浏览器 API 校验已推进注册状态: "
                        f"page={api_state.get('page_type') or '-'}"
                    )
                else:
                    api_text = str(api_resp.get("text") or "").strip()
                    if api_resp.get("ok"):
                        api_text = "校验响应未返回后续注册状态"
                    otp_resp = {
                        **api_resp,
                        "ok": False,
                        "text": f"验证码页 DOM 提交不可用；同浏览器 API 校验失败: {api_text or 'unknown error'}",
                    }
            log(f"验证码页提交状态: {otp_resp.get('status', 0)}")
            if not otp_resp.get("ok"):
                raise RuntimeError(f"验证码校验失败: {(otp_resp.get('text') or '')[:300]}")
            state = fallback_state or _extract_flow_state(otp_resp.get("data"), otp_resp.get("url", page.url))
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            continue

        if _is_about_you(state):
            log("提交 about_you 信息...")
            target_url = _normalize_url(
                str(state.get("current_url") or state.get("continue_url") or f"{OPENAI_AUTH}/about-you"),
                OPENAI_AUTH,
            )
            if "about-you" not in str(page.url):
                log(f"跳转到 about_you 页面: {target_url[:120]}")
                _goto_with_retry(page, target_url, wait_until="domcontentloaded", timeout=30000, log=log)
            about_resp = _submit_about_you_via_page(page, log)
            log(f"about_you 提交状态: {about_resp.get('status', 0)}")
            if not about_resp.get("ok"):
                raise RuntimeError(f"about_you 提交失败: {(about_resp.get('text') or '')[:300]}")
            state = _extract_flow_state(about_resp.get("data"), about_resp.get("url", page.url))
            if not state.get("page_type"):
                state = _derive_registration_state_from_page(page)
            if _is_add_phone(state):
                if not phone_callback:
                    raise RuntimeError(
                        "OpenAI 当前要求手机号验证；任务已按仅邮箱注册模式停止，未调用 SMS 服务"
                    )
                log("about_you 后进入 add_phone，尝试短信验证...")
                state = _handle_add_phone_challenge(
                    page,
                    phone_callback,
                    device_id=device_id,
                    user_agent=user_agent,
                    log=log,
                    resume_url=f"{CHATGPT_APP}/",
                )
            continue

        if _is_add_phone(state):
            if not phone_callback:
                raise RuntimeError(
                    "OpenAI 当前要求手机号验证；任务已按仅邮箱注册模式停止，未调用 SMS 服务"
                )
            log("注册流程进入 add_phone，尝试短信验证...")
            state = _handle_add_phone_challenge(
                page,
                phone_callback,
                device_id=device_id,
                user_agent=user_agent,
                log=log,
                resume_url=f"{CHATGPT_APP}/",
            )
            continue

        if _requires_registration_navigation(state):
            target_url = _normalize_url(str(state.get("continue_url") or state.get("current_url") or ""), OPENAI_AUTH)
            if not target_url:
                raise RuntimeError("缺少可跟随的 continue_url")
            _goto_with_retry(page, target_url, wait_until="domcontentloaded", timeout=30000, log=log)
            state = _extract_flow_state(None, page.url)
            continue

        raise RuntimeError(f"未支持的注册状态: page={state.get('page_type') or '-'}")

    raise RuntimeError("注册状态机超出最大步数")


class ChatGPTBrowserRegister:
    def __init__(
        self,
        *,
        headless: bool,
        proxy: Optional[str] = None,
        otp_callback: Optional[Callable[[], str]] = None,
        phone_callback: Optional[Callable[[], str]] = None,
        log_fn: Callable[[str], None] = print,
        backend_config: Optional[BrowserBackendConfig] = None,
        post_register_in_browser: Optional[Callable[[Any, dict], dict]] = None,
        set_password_after_registration: bool = False,
        password_generator: Optional[Callable[[], str]] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
        auto_continue_post_signup: bool = True,
    ):
        self.auto_continue_post_signup = bool(auto_continue_post_signup)
        self.headless = bool(headless)
        self.proxy = proxy
        self.otp_callback = otp_callback
        self.phone_callback = phone_callback
        self.log = log_fn
        self.set_password_after_registration = bool(set_password_after_registration)
        self.password_generator = password_generator or _generate_browser_registration_password
        self.cancel_check = cancel_check
        # post_register_in_browser(page, session_info) -> dict|None：
        # 注册拿到 session 后、**浏览器还开着**时回调。短链复用流程用它在
        # 同一个浏览器/同一 page 里打开短链并抓 midtrans_url。返回的 dict 会
        # 合并进 run() 的结果（如 {"midtrans_url": "..."}）。回调异常不影响
        # 注册结果本身（只记日志、不抛）。
        self.post_register_in_browser = post_register_in_browser
        # backend_config 为 None 时默认 Camoufox，跟老调用方一致。
        # BitBrowser 路径需要上层 plugin.py 显式传 backend_config。
        resolved_backend = backend_config or BrowserBackendConfig.camoufox(
            headless=self.headless
        )
        if not self.auto_continue_post_signup:
            self.headless = False
            if resolved_backend.window_mode != "headed":
                resolved_backend = BrowserBackendConfig(
                    backend=resolved_backend.backend,
                    window_mode="headed",
                    bit_profile_id=resolved_backend.bit_profile_id,
                    bit_api_url=resolved_backend.bit_api_url,
                    bit_api_token=resolved_backend.bit_api_token,
                )
            log_fn("手动 Continue 模式需要可见浏览器，已强制使用 headed 窗口")
        self.backend_config = resolved_backend
        if self.backend_config.is_bitbrowser:
            log_fn(
                f"ChatGPT 注册使用 BitBrowser backend "
                f"(profile={self.backend_config.bit_profile_id}, "
                f"window_mode={self.backend_config.window_mode})"
            )

    def _open_browser(self, launch_opts: dict):
        """与业务代码代期使用的 ``with Camoufox(**launch_opts) as browser:`` 接口
        保持兑现：按 ``self.backend_config`` 路由到 Camoufox 或 BitBrowser。
        BitBrowser 路径下 launch_opts 里的 proxy/geoip 会被忽略（profile
        自带代理）。"""
        if self.backend_config.is_camoufox:
            from .payment import _patch_playwright_firefox_pageerror_location_bug

            _patch_playwright_firefox_pageerror_location_bug(log_fn=self.log)
        _apply_camoufox_visible_window_limit(launch_opts, self.backend_config)
        return open_browser_backend(
            launch_opts=launch_opts,
            config=self.backend_config,
            camoufox_class=Camoufox,
            log=self.log,
        )

    def _new_isolated_page(self, browser):
        if self.backend_config.is_camoufox:
            context = browser.new_context(no_viewport=True)
            return context.new_page()
        return browser.new_page()

    def _generate_password(self) -> str:
        password = str(self.password_generator() or "").strip()
        if not password:
            raise RuntimeError("ChatGPT 密码生成失败")
        return password

    def set_password_for_existing_account(
        self,
        *,
        email: str,
        password: str,
        cookies: Any = "",
        expected_account_id: str = "",
    ) -> dict:
        """Set a password on an existing account without entering signup."""
        candidate_password = str(password or "")
        cookie_items = _cookie_header_to_playwright_cookies(cookies)
        existing_cookie_header = (
            str(cookies)
            if isinstance(cookies, str)
            else _cookies_to_header(
                {
                    str(item.get("name") or ""): str(item.get("value") or "")
                    for item in cookie_items
                }
            )
        )
        sensitive_values = [
            str(email or ""),
            candidate_password,
            str(cookies or ""),
            str(self.proxy or ""),
            str(expected_account_id or ""),
            *[item.get("value", "") for item in cookie_items],
        ]

        def safe_log(message: Any) -> None:
            self.log(
                _sanitize_password_error(
                    message,
                    candidate_password,
                    sensitive_values=sensitive_values,
                )
            )

        confirmed_result: dict[str, Any] | None = None

        def add_post_commit_warning(message: str, error: Any = "") -> None:
            detail = _sanitize_password_error(
                error,
                candidate_password,
                sensitive_values=sensitive_values,
            )
            safe_log(f"{message}: {detail}" if detail else message)
            if confirmed_result is not None:
                current = str(confirmed_result.get("message") or "").strip()
                if message not in current:
                    confirmed_result["message"] = "；".join(
                        item for item in (current, message) if item
                    )

        if not str(email or "").strip():
            return {
                "password": "",
                "password_set": False,
                "password_status": "failed",
                "password_source": "settings",
                "password_error": "账号缺少原注册邮箱",
            }
        if not candidate_password:
            return {
                "password": "",
                "password_set": False,
                "password_status": "failed",
                "password_source": "settings",
                "password_error": "设置密码不能为空",
            }

        try:
            _raise_if_cancelled(self.cancel_check)
            proxy = None
            region_profile = None
            if self.backend_config.is_bitbrowser:
                launch_opts = {"headless": self.backend_config.is_headless}
            else:
                proxy = _build_proxy_config(self.proxy)
                launch_opts = {
                    "headless": self.headless,
                    "block_webrtc": True,
                    "humanize": True,
                    "os": ["windows", "macos", "linux"],
                }
                region_profile = _apply_regional_fingerprint(launch_opts, proxy, safe_log)

            with self._open_browser(launch_opts) as browser:
                _raise_if_cancelled(self.cancel_check)
                page = self._new_isolated_page(browser)
                snapshot = _fingerprint_snapshot(page)
                if not self.backend_config.is_bitbrowser and snapshot:
                    actual_locale = str(snapshot.get("language") or "")
                    actual_timezone = str(snapshot.get("timezone") or "")
                    if (
                        actual_locale != region_profile["locale"]
                        or actual_timezone != region_profile["timezone"]
                    ):
                        raise RuntimeError(
                            "浏览器地域指纹校验失败: "
                            f"expected={region_profile['locale']}/{region_profile['timezone']}, "
                            f"actual={actual_locale or '-'}/{actual_timezone or '-'}"
                        )
                safe_log("已创建账号密码设置专用浏览器会话")

                if self.backend_config.is_bitbrowser:
                    try:
                        safe_log(f"浏览器出口 IP: {_browser_public_ip(page)}")
                    except BrowserProxyVerificationError:
                        safe_log("浏览器出口 IP 复核失败；BitBrowser profile 使用自身代理配置")
                else:
                    exit_ip = _verify_browser_exit_for_flow(
                        page,
                        region_profile["ip"],
                        proxy=proxy,
                        log=safe_log,
                        no_proxy_failure_message="浏览器出口 IP 复核失败；本次 action 已显式使用直连",
                    )
                    if exit_ip:
                        safe_log(f"浏览器出口 IP: {exit_ip}")

                session_info = _restore_existing_account_session(
                    page,
                    email=str(email).strip(),
                    cookies=cookies,
                    otp_callback=self.otp_callback,
                    expected_account_id=expected_account_id,
                    log=safe_log,
                    cancel_check=self.cancel_check,
                )
                session_evidence = _validated_password_session_evidence(
                    session_info,
                    expected_email=str(email).strip(),
                    expected_account_id=expected_account_id,
                )
                _raise_if_cancelled(self.cancel_check)

                def verify_candidate_password_login(
                    *,
                    deadline: float,
                    cancel_check=None,
                ) -> dict[str, Any]:
                    proof_page = self._new_isolated_page(browser)
                    proof_context = proof_page.context
                    if proof_context is page.context:
                        raise RuntimeError(
                            "候选密码重新登录无法创建隔离浏览器 Context"
                        )
                    try:
                        return _verify_existing_account_password_login(
                            proof_page,
                            source_context=page.context,
                            email=str(email).strip(),
                            password=candidate_password,
                            expected_account_id=session_evidence.account_id,
                            otp_callback=self.otp_callback,
                            log=safe_log,
                            deadline=deadline,
                            cancel_check=cancel_check,
                        )
                    finally:
                        close_context = getattr(proof_context, "close", None)
                        if callable(close_context):
                            try:
                                close_context()
                            except Exception:
                                pass

                settings_result = _set_password_from_security_settings(
                    page,
                    str(email).strip(),
                    candidate_password,
                    self.otp_callback,
                    safe_log,
                    cancel_check=self.cancel_check,
                    session_evidence=session_evidence,
                    candidate_login_verifier=verify_candidate_password_login,
                )
                password_verification = str(
                    settings_result.get("password_verification") or ""
                )
                if not (
                    settings_result.get("password_set")
                    and settings_result.get("password_status") == "configured"
                    and password_verification
                    in {"success_url", "password_login_reconciled"}
                ):
                    raise RuntimeError("ChatGPT 密码设置未通过强校验")

                proof_session = settings_result
                if password_verification == "password_login_reconciled":
                    credential_source = proof_session
                    fallback_session: dict[str, Any] = {}
                    fallback_cookie_header = ""
                else:
                    credential_source = proof_session
                    fallback_session = session_info
                    fallback_cookie_header = existing_cookie_header
                confirmed_result = {
                    "password": candidate_password,
                    "password_set": True,
                    "password_status": "configured",
                    "password_source": "settings",
                    "password_verification": password_verification,
                    "account_id": credential_source.get("account_id")
                    or fallback_session.get("account_id", ""),
                    "access_token": credential_source.get("access_token")
                    or fallback_session.get("access_token", ""),
                    "refresh_token": credential_source.get("refresh_token")
                    or fallback_session.get("refresh_token", ""),
                    "id_token": credential_source.get("id_token")
                    or fallback_session.get("id_token", ""),
                    "session_token": credential_source.get("session_token")
                    or fallback_session.get("session_token", ""),
                    "workspace_id": credential_source.get("workspace_id")
                    or fallback_session.get("workspace_id", ""),
                    "cookies": credential_source.get("cookies")
                    or fallback_session.get("cookies", "")
                    or fallback_cookie_header,
                }

                if callable(self.cancel_check) and self.cancel_check():
                    add_post_commit_warning("密码已设置，迟到取消请求未回滚已生效密码")
                    return confirmed_result

                if not self.backend_config.is_bitbrowser:
                    try:
                        exit_ip = _verify_browser_exit_for_flow(
                            page,
                            region_profile["ip"],
                            proxy=proxy,
                            log=safe_log,
                            no_proxy_failure_message="密码设置完成后出口 IP 复核失败；本次 action 已显式使用直连",
                        )
                        if exit_ip:
                            safe_log(f"密码设置完成后出口 IP: {exit_ip}")
                    except Exception as exc:
                        add_post_commit_warning("密码已设置，后置出口复核未完成", exc)

                if callable(self.cancel_check) and self.cancel_check():
                    add_post_commit_warning("密码已设置，迟到取消请求未回滚已生效密码")
                    return confirmed_result

                if password_verification == "password_login_reconciled":
                    safe_log("现有账号密码已通过隔离登录及 Session 身份校验")
                    return confirmed_result

                try:
                    latest_cookies = _get_cookies(page)
                    refreshed_session = _fetch_chatgpt_session_from_page(
                        page,
                        latest_cookies,
                        safe_log,
                        timeout=20,
                    )
                    _validate_existing_account_session(
                        refreshed_session,
                        expected_email=str(email).strip(),
                        expected_account_id=expected_account_id,
                    )
                    latest_cookies = _get_cookies(page)
                    for key in (
                        "account_id",
                        "access_token",
                        "refresh_token",
                        "id_token",
                        "session_token",
                        "workspace_id",
                    ):
                        if refreshed_session.get(key):
                            confirmed_result[key] = refreshed_session[key]
                    refreshed_cookies = (
                        refreshed_session.get("cookies", "")
                        or _cookies_to_header(latest_cookies)
                    )
                    if refreshed_cookies:
                        confirmed_result["cookies"] = refreshed_cookies
                    safe_log("现有账号密码设置已通过成功页和 Session 身份校验")
                except Exception as exc:
                    add_post_commit_warning("密码已设置，后置 Session 刷新未完成", exc)
                return confirmed_result
        except BrowserTaskCancelled as exc:
            if confirmed_result is not None:
                add_post_commit_warning("密码已设置，迟到取消请求未回滚已生效密码", exc)
                return confirmed_result
            raise
        except Exception as exc:
            if confirmed_result is not None:
                add_post_commit_warning("密码已设置，后置处理异常未回滚已生效密码", exc)
                return confirmed_result
            error = _sanitize_password_error(
                exc,
                candidate_password,
                sensitive_values=sensitive_values,
            )
            safe_log(f"现有账号密码设置失败: {error}")
            return {
                "password": "",
                "password_set": False,
                "password_status": "failed",
                "password_source": "settings",
                "password_verification": "failed",
                "password_error": error,
            }

    def run(self, email: str, password: str) -> dict:
        _raise_if_cancelled(self.cancel_check)
        proxy = None
        region_profile = None
        if self.backend_config.is_bitbrowser:
            # BitBrowser 路径：profile 已配代理/指纹，launch_opts 不传这些。
            launch_opts = {"headless": self.backend_config.is_headless}
        else:
            proxy = _build_proxy_config(self.proxy)
            launch_opts = {
                "headless": self.headless,
                "block_webrtc": True,
                "humanize": True,
                "os": ["windows", "macos", "linux"],
            }
            region_profile = _apply_regional_fingerprint(launch_opts, proxy, self.log)

        with self._open_browser(launch_opts) as browser:
            _raise_if_cancelled(self.cancel_check)
            page = self._new_isolated_page(browser)
            page.context.clear_cookies()
            snapshot = _fingerprint_snapshot(page)
            fingerprint_id = _fingerprint_id(snapshot)
            if not self.backend_config.is_bitbrowser and snapshot:
                actual_locale = str(snapshot.get("language") or "")
                actual_timezone = str(snapshot.get("timezone") or "")
                if actual_locale != region_profile["locale"] or actual_timezone != region_profile["timezone"]:
                    raise RuntimeError(
                        "浏览器地域指纹校验失败: "
                        f"expected={region_profile['locale']}/{region_profile['timezone']}, "
                        f"actual={actual_locale or '-'}/{actual_timezone or '-'}"
                    )
            self.log(f"已创建全新 Camoufox 随机指纹会话: {fingerprint_id}，Cookie 已清空")
            if snapshot:
                screen = snapshot.get("screen") or {}
                self.log(
                    "浏览器指纹参数: "
                    f"platform={snapshot.get('platform') or '-'}, "
                    f"locale={snapshot.get('language') or '-'}, "
                    f"timezone={snapshot.get('timezone') or '-'}, "
                    f"screen={screen.get('width', '-') }x{screen.get('height', '-')}, "
                    "WebRTC=blocked, Canvas/WebGL/AudioContext/ClientRects=per-task-random"
                )
            if self.backend_config.is_bitbrowser:
                try:
                    exit_ip = _browser_public_ip(page)
                    self.log(f"浏览器出口 IP: {exit_ip}")
                except BrowserProxyVerificationError:
                    self.log("浏览器出口 IP 复核失败；BitBrowser profile 继续使用自身代理配置")
            else:
                exit_ip = _verify_browser_exit_for_flow(
                    page,
                    region_profile["ip"],
                    proxy=proxy,
                    log=self.log,
                    no_proxy_failure_message="浏览器出口 IP 复核失败；当前未配置代理，继续注册",
                )
                if exit_ip:
                    self.log(f"浏览器出口 IP: {exit_ip}")
            self.log("启动浏览器上下文注册状态机")
            flow_kwargs = {"password_factory": self._generate_password}
            if self.cancel_check is not None:
                flow_kwargs["cancel_check"] = self.cancel_check
            if not self.auto_continue_post_signup:
                flow_kwargs["auto_continue_post_signup"] = False
                flow_kwargs["manual_post_signup_timeout"] = 300
            final_state = _browser_registration_flow(
                page,
                email,
                password,
                self.otp_callback,
                self.phone_callback,
                self.log,
                **flow_kwargs,
            )
            _raise_if_cancelled(self.cancel_check)
            if _is_add_phone(final_state):
                raise RuntimeError(
                    "OpenAI 当前要求手机号验证；任务已按仅邮箱注册模式停止，未调用 SMS 服务"
                )
            if not final_state.get("post_signup_ready"):
                raise RuntimeError("注册后准备页面尚未完成，拒绝提前获取 Session/AT")
            if not self.backend_config.is_bitbrowser:
                exit_ip = _verify_browser_exit_for_flow(
                    page,
                    region_profile["ip"],
                    proxy=proxy,
                    log=self.log,
                    no_proxy_failure_message="注册状态机完成后出口 IP 复核失败；当前未配置代理，继续注册",
                )
                if exit_ip:
                    self.log(f"注册状态机完成后出口 IP: {exit_ip}")
            self.log(f"注册流程完成: page={final_state.get('page_type') or '-'}")

            configured_password = str(final_state.pop("password", "") or "").strip()
            password_set = bool(final_state.get("password_set") and configured_password)
            password_status = str(
                final_state.get("password_status")
                or ("configured" if password_set else "not_configured")
            )
            password_source = str(
                final_state.get("password_source")
                or ("signup_required" if password_set else "none")
            )
            password_error = ""

            # Lock in the completed account before the optional password step.
            # Password reauthentication may be unsupported or time out, but it
            # must never prevent persistence of an already registered account.
            _raise_if_cancelled(self.cancel_check)
            cookies_dict = _get_cookies(page)
            session_info = _fetch_chatgpt_session_from_page(page, cookies_dict, self.log)
            session_evidence = _validated_password_session_evidence(
                session_info,
                expected_email=str(email or "").strip(),
            )

            if self.set_password_after_registration and not password_set:
                candidate_password = str(password or "").strip() or self._generate_password()
                try:
                    self.log("注册未要求密码，开始在 ChatGPT Security 设置中添加密码")
                    settings_args = (
                        page,
                        email,
                        candidate_password,
                        self.otp_callback,
                        self.log,
                    )
                    settings_kwargs = {
                        "session_evidence": session_evidence,
                    }
                    if self.cancel_check is not None:
                        settings_kwargs["cancel_check"] = self.cancel_check
                    settings_result = _set_password_from_security_settings(
                        *settings_args,
                        **settings_kwargs,
                    )
                    configured_password = candidate_password
                    password_set = bool(settings_result.get("password_set"))
                    password_status = str(settings_result.get("password_status") or "configured")
                    password_source = str(settings_result.get("password_source") or "settings")
                    final_state.update(settings_result)
                except BrowserTaskCancelled:
                    raise
                except Exception as exc:
                    configured_password = ""
                    password_set = False
                    password_status = "failed"
                    password_source = "settings"
                    password_error = _sanitize_password_error(exc, candidate_password)
                    final_state.update(
                        {
                            "password_set": False,
                            "password_status": password_status,
                            "password_source": password_source,
                            "password_error": password_error,
                        }
                    )
                    self.log(f"注册后设置密码失败，账号仍按注册成功保存: {password_error}")

            if not self.backend_config.is_bitbrowser:
                exit_ip = _verify_browser_exit_for_flow(
                    page,
                    region_profile["ip"],
                    proxy=proxy,
                    log=self.log,
                    no_proxy_failure_message="密码阶段完成后出口 IP 复核失败；当前未配置代理，继续注册",
                )
                if exit_ip:
                    self.log(f"密码阶段完成后出口 IP: {exit_ip}")

            final_state.update(
                {
                    "password_set": password_set,
                    "password_status": password_status,
                    "password_source": password_source,
                }
            )
            if password_error:
                final_state["password_error"] = password_error

            result = {
                "email": email,
                "password": configured_password if password_set else "",
                "password_set": password_set,
                "password_status": password_status,
                "password_source": password_source,
                "password_error": password_error,
                "account_id": session_info.get("account_id", ""),
                "access_token": session_info.get("access_token", ""),
                "refresh_token": session_info.get("refresh_token", ""),
                "id_token": session_info.get("id_token", ""),
                "session_token": session_info.get("session_token", ""),
                "workspace_id": session_info.get("workspace_id", ""),
                "cookies": session_info.get("cookies", "") or _cookies_to_header(cookies_dict),
                "profile": session_info.get("profile", {}),
                "expires_at": session_info.get("expires_at", ""),
                "session": session_info.get("session", {}),
                "registration_state": final_state,
            }

            # 短链复用流程：注册拿到 session 后、**浏览器还开着**时，在同一个
            # page 里继续打开短链 + 抓 midtrans_url。结果合并进返回值。
            if callable(self.post_register_in_browser):
                try:
                    _raise_if_cancelled(self.cancel_check)
                    self.log("注册完成，浏览器保持打开，继续在同一浏览器里走短链付款流程…")
                    extra = self.post_register_in_browser(page, dict(result))
                    if isinstance(extra, dict):
                        result.update(extra)
                except BrowserTaskCancelled:
                    raise
                except Exception as exc:
                    self.log(f"浏览器内短链后续流程异常（不影响注册结果）: {exc}")
            if not self.backend_config.is_bitbrowser:
                exit_ip = _verify_browser_exit_for_flow(
                    page,
                    region_profile["ip"],
                    proxy=proxy,
                    log=self.log,
                    no_proxy_failure_message="浏览器流程返回前出口 IP 复核失败；当前未配置代理，继续返回",
                )
                if exit_ip:
                    self.log(f"浏览器流程返回前出口 IP: {exit_ip}")
            return result

    def _retry_oauth_fresh_browser(self, email, password):
        """在全新浏览器 context 里做 Codex OAuth（绕过 add_phone session）。"""
        proxy = None
        region_profile = None
        if self.backend_config.is_bitbrowser:
            launch_opts = {"headless": self.backend_config.is_headless}
        else:
            proxy = _build_proxy_config(self.proxy)
            launch_opts = {
                "headless": self.headless,
                "block_webrtc": True,
                "humanize": True,
                "os": ["windows", "macos", "linux"],
            }
            region_profile = _apply_regional_fingerprint(launch_opts, proxy, self.log)
        try:
            with self._open_browser(launch_opts) as browser:
                page = self._new_isolated_page(browser)
                if self.backend_config.is_bitbrowser:
                    try:
                        exit_ip = _browser_public_ip(page)
                        self.log(f"  全新浏览器出口 IP: {exit_ip}")
                    except BrowserProxyVerificationError:
                        self.log("  全新浏览器出口 IP 复核失败；BitBrowser profile 继续使用自身代理配置")
                else:
                    exit_ip = _verify_browser_exit_for_flow(
                        page,
                        region_profile["ip"],
                        proxy=proxy,
                        log=self.log,
                        no_proxy_failure_message="  全新浏览器出口 IP 复核失败；当前未配置代理，继续 OAuth",
                    )
                    if exit_ip:
                        self.log(f"  全新浏览器出口 IP: {exit_ip}")
                self.log("  全新浏览器 OAuth 开始...")
                result = _do_codex_oauth(
                    page, {}, email, password,
                    self.otp_callback, self.phone_callback, self.proxy, self.log,
                )
                if not self.backend_config.is_bitbrowser:
                    exit_ip = _verify_browser_exit_for_flow(
                        page,
                        region_profile["ip"],
                        proxy=proxy,
                        log=self.log,
                        no_proxy_failure_message="  OAuth 完成后出口 IP 复核失败；当前未配置代理，继续返回",
                    )
                    if exit_ip:
                        self.log(f"  OAuth 完成后出口 IP: {exit_ip}")
                return result
        except Exception as e:
            self.log(f"  全新浏览器 OAuth 异常: {e}")
            return None
