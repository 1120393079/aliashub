"""OpenBlockLabs OAuth 浏览器流程。"""
import time

from core.oauth_browser import (
    OAuthBrowser,
    browser_login_method_text,
    finalize_oauth_email,
    oauth_provider_label,
)
from platforms.openblocklabs.core import AUTH_BASE, DASHBOARD_BASE, DASHBOARD_CALLBACK


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
    signup_url = f"{AUTH_BASE}/sign-up?redirect_uri={DASHBOARD_CALLBACK}"

    with OAuthBrowser(
        proxy=proxy,
        headless=headless,
        chrome_user_data_dir=chrome_user_data_dir,
        chrome_cdp_url=chrome_cdp_url,
        log_fn=log_fn,
    ) as browser:
        browser.goto(signup_url)
        time.sleep(2)
        if oauth_provider:
            browser.try_click_provider(oauth_provider)

        if chrome_user_data_dir or chrome_cdp_url:
            browser.auto_select_google_account()
        else:
            log_fn(f"请在浏览器中完成登录，可使用 {method_text}，最长等待 {timeout} 秒")
            if email_hint:
                log_fn(f"请确认最终登录账号邮箱为: {email_hint}")

        session_token = browser.wait_for_cookie_value(
            ["wos-session"],
            timeout=timeout,
            domain_substrings=("openblocklabs.com",),
        )
        if not session_token:
            raise RuntimeError(f"OpenBlockLabs 浏览器登录未在 {timeout} 秒内拿到 Session")

        try:
            browser.goto(f"{DASHBOARD_BASE}/api/create-personal-org", wait_until="domcontentloaded", timeout=20000)
            time.sleep(1)
        except Exception:
            pass

        resolved_email = finalize_oauth_email("", email_hint, "OpenBlockLabs")
        return {
            "email": resolved_email,
            "wos_session": session_token,
        }


# Backward-compat alias
register_with_manual_oauth = register_with_browser_oauth
