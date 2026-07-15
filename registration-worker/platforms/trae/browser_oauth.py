"""Trae OAuth 浏览器流程。"""
import time

from core.executors.protocol import ProtocolExecutor
from core.oauth_browser import (
    OAuthBrowser,
    browser_login_method_text,
    finalize_oauth_email,
    oauth_provider_label,
)
from platforms.trae.core import TraeRegister


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

    with OAuthBrowser(
        proxy=proxy,
        headless=headless,
        chrome_user_data_dir=chrome_user_data_dir,
        chrome_cdp_url=chrome_cdp_url,
        log_fn=log_fn,
    ) as browser:
        browser.goto("https://www.trae.ai/account-setting?type=login")
        time.sleep(2)
        if oauth_provider:
            browser.try_click_provider(oauth_provider)

        if chrome_user_data_dir or chrome_cdp_url:
            browser.auto_select_google_account()
        else:
            log_fn(f"请在浏览器中完成登录，可使用 {method_text}，最长等待 {timeout} 秒")
            if email_hint:
                log_fn(f"请确认最终登录账号邮箱为: {email_hint}")

        final_url = browser.wait_for_url(
            lambda url: "trae.ai" in url and ("account-setting" in url or "workspace" in url or "ide" in url),
            timeout=timeout,
        )
        if not final_url:
            raise RuntimeError(f"Trae 浏览器登录未在 {timeout} 秒内完成")

        browser_cookies = browser.cookie_dict(domain_substrings=("trae.ai",))

    with ProtocolExecutor(proxy=proxy) as ex:
        ex.set_cookies(browser_cookies)
        reg = TraeRegister(executor=ex, log_fn=log_fn)
        reg.step4_trae_login()
        token = reg.step5_get_token()
        if not token:
            raise RuntimeError("Trae OAuth 登录后未获取到平台 token")
        result = reg.step6_check_login()
        cashier_url = reg.step7_create_order(token)

    resolved_email = finalize_oauth_email("", email_hint, "Trae")
    return {
        "email": resolved_email,
        "user_id": result.get("UserId", "") or result.get("UserID", ""),
        "token": token,
        "region": result.get("Region", ""),
        "cashier_url": cashier_url,
        "ai_pay_host": result.get("AIPayHost", ""),
        "final_url": final_url,
    }


# Backward-compat alias
register_with_manual_oauth = register_with_browser_oauth
