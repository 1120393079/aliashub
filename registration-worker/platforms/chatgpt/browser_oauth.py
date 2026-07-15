"""ChatGPT OAuth 浏览器流程。"""
import time

from curl_cffi import requests as curl_requests

from core.oauth_browser import (
    OAuthBrowser,
    browser_login_method_text,
    finalize_oauth_email,
    oauth_provider_label,
)
from platforms.chatgpt.oauth import OAuthManager


def _build_proxies(proxy: str | None) -> dict | None:
    if not proxy:
        return None
    return {"http": proxy, "https": proxy}


def _fetch_profile(access_token: str, proxy: str | None = None) -> dict:
    if not access_token:
        return {}
    try:
        response = curl_requests.get(
            "https://chatgpt.com/backend-api/me",
            headers={
                "authorization": f"Bearer {access_token}",
                "accept": "application/json",
                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            },
            proxies=_build_proxies(proxy),
            timeout=20,
            impersonate="chrome124",
        )
        if response.status_code == 200:
            return response.json()
    except Exception:
        return {}
    return {}


def register_with_browser_oauth(
    *,
    proxy: str | None = None,
    oauth_provider: str = "",
    email_hint: str = "",
    timeout: int = 300,
    log_fn=print,
    headless: bool = False,
    chrome_user_data_dir: str = "",
    chrome_cdp_url: str = "",
) -> dict:
    method_text = browser_login_method_text(oauth_provider)
    manager = OAuthManager(proxy_url=proxy)
    oauth_start = manager.start_oauth()

    with OAuthBrowser(
        proxy=proxy,
        headless=headless,
        chrome_user_data_dir=chrome_user_data_dir,
        chrome_cdp_url=chrome_cdp_url,
        log_fn=log_fn,
    ) as browser:
        # goto 带瞬时网络错误重试（ERR_CONNECTION_CLOSED/RESET/TIMED_OUT 等
        # 一次波动不直接判失败）。OAuthBrowser.goto 是自有封装，这里在外层
        # 做轻量 3 次重试。
        _nav_tokens = (
            "err_connection", "err_timed_out", "err_network_changed",
            "err_empty_response", "err_socks", "err_proxy", "err_tunnel",
            "err_name_not_resolved", "err_address_unreachable",
            "ns_error_net", "neterror", "navigating to",
        )
        _last_exc = None
        for _attempt in range(1, 4):
            try:
                browser.goto(oauth_start.auth_url)
                _last_exc = None
                break
            except Exception as _exc:  # noqa: BLE001
                _last_exc = _exc
                _m = str(_exc).lower()
                if _attempt >= 3 or not any(tk in _m for tk in _nav_tokens):
                    raise
                log_fn(f"OAuth 打开授权页瞬时网络失败（第 {_attempt}/3 次，重试）: {str(_exc)[:120]}")
                time.sleep(1.5 * _attempt)
        if _last_exc is not None:
            raise _last_exc
        time.sleep(2)
        if oauth_provider:
            browser.try_click_provider(oauth_provider)

        if chrome_user_data_dir or chrome_cdp_url:
            browser.auto_select_google_account()
        else:
            log_fn(f"请在浏览器中完成登录/授权，可使用 {method_text}，最长等待 {timeout} 秒")
            if email_hint:
                log_fn(f"请确认最终登录账号邮箱为: {email_hint}")

        callback_url = browser.wait_for_url(
            lambda url: url.startswith(oauth_start.redirect_uri) and "code=" in url,
            timeout=timeout,
        )
        if not callback_url:
            raise RuntimeError(f"ChatGPT 浏览器登录未在 {timeout} 秒内完成")

        token_info = manager.handle_callback(
            callback_url=callback_url,
            expected_state=oauth_start.state,
            code_verifier=oauth_start.code_verifier,
        )
        time.sleep(2)
        profile = _fetch_profile(token_info.get("access_token", ""), proxy=proxy)
        resolved_email = finalize_oauth_email(
            token_info.get("email") or profile.get("email", ""),
            email_hint,
            "ChatGPT",
        )
        return {
            "email": resolved_email,
            "account_id": token_info.get("account_id", ""),
            "access_token": token_info.get("access_token", ""),
            "refresh_token": token_info.get("refresh_token", ""),
            "id_token": token_info.get("id_token", ""),
            "session_token": browser.cookie_value(
                "__Secure-next-auth.session-token",
                domain_substrings=("chatgpt.com", "openai.com"),
            ),
            "cookies": browser.cookie_header(domain_substrings=("chatgpt.com", "openai.com")),
            "workspace_id": "",
            "profile": profile,
        }


# Backward-compat alias
register_with_manual_oauth = register_with_browser_oauth
