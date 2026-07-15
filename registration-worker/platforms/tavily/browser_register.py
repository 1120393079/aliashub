"""Tavily 浏览器注册流程。"""
import re
import time
from typing import Callable, Optional
from urllib.parse import urlparse

import requests
from camoufox.sync_api import Camoufox


TURNSTILE_SITEKEY = "0x4AAAAAAAQFNSW6xordsuIq"
ORG_ONLY_SIGNUP_MARKERS = (
    "email/password signup is only available for specific organizations",
    "please use google, github, linkedin, or microsoft to sign up",
)
from core.oauth_browser import (
    try_click_provider_on_page,
)


def extract_signup_url(html: str) -> Optional[str]:
    match = re.search(r'href="(/u/signup/identifier[^"]*)"', html)
    if not match:
        return None
    return f"https://auth.tavily.com{match.group(1)}"


def fill_first_input(page, selectors: list[str], value: str) -> Optional[str]:
    for selector in selectors:
        if page.query_selector(selector):
            page.fill(selector, value)
            return selector
    return None


def close_marketing_dialog(page) -> None:
    close_button = page.query_selector('button[aria-label="Close"]')
    if close_button:
        close_button.click()
        time.sleep(1)


def extract_api_key(page) -> Optional[str]:
    html = page.content()
    api_key_matches = re.findall(r'tvly-[a-zA-Z0-9_-]{20,}', html)
    api_keys = [key for key in api_key_matches if key != "tvly-YOUR_API_KEY"]
    if not api_keys:
        return None
    return max(api_keys, key=len)


def wait_for_api_key(page, timeout: int = 20) -> Optional[str]:
    start_time = time.time()
    while time.time() - start_time < timeout:
        close_marketing_dialog(page)
        api_key = extract_api_key(page)
        if api_key:
            return api_key
        time.sleep(1)
    return None


def verify_api_key(api_key: str, timeout: int = 30) -> bool:
    try:
        response = requests.post(
            "https://api.tavily.com/search",
            json={
                "api_key": api_key,
                "query": "api key verification",
                "max_results": 1,
            },
            timeout=timeout,
        )
    except Exception:
        return False

    return response.status_code == 200


click_oauth_provider = try_click_provider_on_page


def wait_for_manual_oauth_completion(page, timeout: int = 300) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        current_url = page.url.lower()
        if "app.tavily.com" in current_url:
            return True
        time.sleep(1)

    try:
        page.goto("https://app.tavily.com", wait_until="networkidle", timeout=30000)
        return "app.tavily.com" in page.url.lower()
    except Exception:
        return False


def submit_primary_action(page, input_selector: Optional[str] = None) -> bool:
    button_selectors = [
        'button[data-action-button-primary="true"]',
        'button[type="submit"][name="action"][value="default"]:not([aria-hidden="true"])',
        'button[type="submit"]:not([aria-hidden="true"])',
    ]

    for selector in button_selectors:
        if page.query_selector(selector):
            try:
                page.click(selector, no_wait_after=True, timeout=3000)
                return True
            except Exception:
                continue

    if input_selector and page.query_selector(input_selector):
        try:
            page.press(input_selector, "Enter")
            return True
        except Exception:
            return False

    return False


def extract_page_feedback(page) -> str:
    selectors = [
        '[role="alert"]',
        '[data-error-visible="true"]',
        ".ulp-input-error-message",
        ".auth0-global-message",
        ".cf-turnstile-error",
    ]
    messages = []
    for selector in selectors:
        for node in page.query_selector_all(selector):
            text = (node.inner_text() or "").strip()
            if text and text not in messages:
                messages.append(text)
    return " | ".join(messages)


def detect_org_only_signup_message(page) -> Optional[str]:
    feedback = extract_page_feedback(page)
    lowered = feedback.lower()
    if any(marker in lowered for marker in ORG_ONLY_SIGNUP_MARKERS):
        return feedback

    try:
        body_text = (page.locator("body").inner_text() or "").strip()
    except Exception:
        body_text = ""
    lowered = body_text.lower()
    if any(marker in lowered for marker in ORG_ONLY_SIGNUP_MARKERS):
        return body_text

    return None


def wait_for_post_signup_target(page, timeout_ms: int) -> bool:
    deadline = time.time() + (timeout_ms / 1000)
    while time.time() < deadline:
        current_url = page.url.lower()
        if "app.tavily.com" in current_url or "/verify" in current_url or "/continue" in current_url:
            return True
        time.sleep(0.5)
    return False


def normalize_feedback(feedback: Optional[str]) -> str:
    return (feedback or "").replace("’", "'").strip().lower()


def get_turnstile_sitekey(page) -> str:
    try:
        sitekey = page.evaluate(
            """
            () => {
                const node = document.querySelector(
                    '[data-captcha-sitekey], .cf-turnstile, [data-sitekey]'
                );
                if (!node) {
                    return '';
                }
                return (
                    node.getAttribute('data-captcha-sitekey') ||
                    node.getAttribute('data-sitekey') ||
                    ''
                );
            }
            """
        )
    except Exception:
        sitekey = ""

    if sitekey:
        return sitekey.strip()

    html = page.content()
    match = re.search(
        r'(?:data-captcha-sitekey|data-sitekey)=["\']([^"\']+)["\']',
        html,
        re.IGNORECASE,
    )
    if match:
        return match.group(1).strip()

    return TURNSTILE_SITEKEY


def collect_turnstile_state(page) -> dict:
    try:
        state = page.evaluate(
            """
            () => {
                const passwordInput = document.querySelector('input[name="password"]');
                const widget = document.querySelector(
                    'div[data-captcha-sitekey], .cf-turnstile, [data-sitekey]'
                );
                const iframe = document.querySelector(
                    'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
                );
                const captchaInput = document.querySelector(
                    'input[name="captcha"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
                );
                return {
                    hasCaptchaDiv: !!widget,
                    hasChallengeIframe: !!iframe,
                    hasCaptchaInput: !!captchaInput,
                    hasTurnstile: typeof window.turnstile !== 'undefined',
                    hasPasswordInput: !!passwordInput,
                    passwordValueLength: passwordInput ? passwordInput.value.length : 0,
                    sitekey: widget
                        ? (widget.getAttribute('data-captcha-sitekey') || widget.getAttribute('data-sitekey') || '')
                        : '',
                };
            }
            """
        )
    except Exception:
        state = {}

    return {
        "hasCaptchaDiv": bool(state.get("hasCaptchaDiv")),
        "hasChallengeIframe": bool(state.get("hasChallengeIframe")),
        "hasCaptchaInput": bool(state.get("hasCaptchaInput")),
        "hasTurnstile": bool(state.get("hasTurnstile")),
        "hasPasswordInput": bool(state.get("hasPasswordInput")),
        "passwordValueLength": int(state.get("passwordValueLength") or 0),
        "sitekey": (state.get("sitekey") or "").strip(),
    }


def has_password_challenge_signal(feedback: Optional[str] = None, state: Optional[dict] = None) -> bool:
    lowered = normalize_feedback(feedback)
    if any(
        keyword in lowered
        for keyword in (
            "security challenge",
            "captcha",
            "turnstile",
            "cloudflare",
            "couldn't load the security challenge",
        )
    ):
        return True

    state = state or {}
    return any(
        (
            state.get("hasCaptchaDiv"),
            state.get("hasChallengeIframe"),
            state.get("hasCaptchaInput"),
            state.get("hasTurnstile"),
        )
    )


def format_turnstile_state(state: dict) -> str:
    return (
        f"captchaDiv={'Y' if state.get('hasCaptchaDiv') else 'N'}, "
        f"iframe={'Y' if state.get('hasChallengeIframe') else 'N'}, "
        f"input={'Y' if state.get('hasCaptchaInput') else 'N'}, "
        f"turnstile={'Y' if state.get('hasTurnstile') else 'N'}, "
        f"pwdLen={state.get('passwordValueLength', 0)}"
    )


def refill_password(page, password: str) -> bool:
    selector = 'input[name="password"]'
    if not page.query_selector(selector):
        return False
    page.fill(selector, password)
    return True


def refresh_password_page_if_needed(page, feedback: Optional[str], state: dict) -> bool:
    lowered = normalize_feedback(feedback)
    if "couldn't load the security challenge" not in lowered:
        return False

    if any(
        (
            state.get("hasCaptchaDiv"),
            state.get("hasChallengeIframe"),
            state.get("hasTurnstile"),
        )
    ):
        return False

    try:
        page.reload(wait_until="networkidle", timeout=30000)
        page.wait_for_selector('input[name="password"]', timeout=15000)
        time.sleep(2)
        return True
    except Exception:
        return False


def inject_turnstile_token(page, token: str) -> bool:
    safe_token = token.replace("\\", "\\\\").replace("'", "\\'")
    script = f"""
    (function() {{
        const token = '{safe_token}';
        const form = document.querySelector('form') || document.body;
        const names = ['captcha', 'cf-turnstile-response'];

        const ensureField = (name) => {{
            let field = document.querySelector(`input[name="${{name}}"], textarea[name="${{name}}"]`);
            if (field) {{
                return field;
            }}

            field = document.createElement(name.includes('response') ? 'textarea' : 'input');
            if (field.tagName === 'INPUT') {{
                field.type = 'hidden';
            }}
            field.name = name;
            form.appendChild(field);
            return field;
        }};

        names.forEach((name) => {{
            const field = ensureField(name);
            field.value = token;
            field.dispatchEvent(new Event('input', {{ bubbles: true }}));
            field.dispatchEvent(new Event('change', {{ bubbles: true }}));
        }});

        if (typeof window._turnstileTokenCallback === 'function') {{
            window._turnstileTokenCallback(token);
        }}
        if (typeof window.turnstileCallback === 'function') {{
            window.turnstileCallback(token);
        }}
        return true;
    }})();
    """
    return bool(page.evaluate(script))


def _build_proxy_config(proxy: Optional[str]) -> Optional[dict]:
    if not proxy:
        return None

    parsed = urlparse(proxy)
    if not parsed.scheme or not parsed.hostname or not parsed.port:
        return {"server": proxy}

    config = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        config["username"] = parsed.username
    if parsed.password:
        config["password"] = parsed.password
    return config


class TavilyBrowserRegister:
    def __init__(
        self,
        *,
        captcha,
        headless: bool,
        proxy: Optional[str] = None,
        otp_callback: Optional[Callable[[], str]] = None,
        verification_link_callback: Optional[Callable[[], str]] = None,
        email_code_timeout: int = 120,
        api_key_timeout: int = 20,
        log_fn: Callable[[str], None] = print,
    ):
        self.captcha = captcha
        self.headless = headless
        self.proxy = proxy
        self.otp_callback = otp_callback
        self.verification_link_callback = verification_link_callback
        self.email_code_timeout = email_code_timeout
        self.api_key_timeout = api_key_timeout
        self.log = log_fn

    def _solve_turnstile(self, url: str, sitekey: str) -> Optional[str]:
        if not self.captcha:
            return None
        try:
            return self.captcha.solve_turnstile(url, sitekey or TURNSTILE_SITEKEY)
        except Exception as exc:
            self.log(f"Turnstile 求解失败: {exc}")
            return None

    def _finalize_api_key(self, page) -> str:
        self.log("提取并验证 Tavily API Key")
        close_marketing_dialog(page)
        api_key = wait_for_api_key(page, timeout=self.api_key_timeout)
        if not api_key:
            try:
                page.goto("https://app.tavily.com", wait_until="networkidle", timeout=30000)
                time.sleep(3)
            except Exception:
                pass
            api_key = wait_for_api_key(page, timeout=self.api_key_timeout)
        if not api_key:
            raise RuntimeError("未找到 Tavily API Key")
        if not verify_api_key(api_key):
            raise RuntimeError("Tavily API Key 校验失败")
        return api_key

    def _recover_password_challenge(self, page, password: str, max_attempts: int = 3) -> bool:
        self.log("密码页未完成跳转，开始恢复安全挑战")

        for attempt in range(1, max_attempts + 1):
            if wait_for_post_signup_target(page, timeout_ms=5000):
                return True

            time.sleep(2)
            feedback = extract_page_feedback(page)
            state = collect_turnstile_state(page)

            self.log(f"密码页恢复尝试 {attempt}/{max_attempts}")
            self.log(f"  DOM: {format_turnstile_state(state)}")
            if feedback:
                self.log(f"  页面提示: {feedback}")

            if wait_for_post_signup_target(page, timeout_ms=2000):
                return True

            if refresh_password_page_if_needed(page, feedback, state):
                feedback = extract_page_feedback(page)
                state = collect_turnstile_state(page)
                if wait_for_post_signup_target(page, timeout_ms=2000):
                    return True

            if has_password_challenge_signal(feedback, state):
                sitekey = state.get("sitekey") or get_turnstile_sitekey(page)
                token = self._solve_turnstile(page.url, sitekey)
                if token and inject_turnstile_token(page, token):
                    self.log("已注入密码页 Turnstile token")
            if not refill_password(page, password):
                if wait_for_post_signup_target(page, timeout_ms=5000):
                    return True
                return False

            time.sleep(1)
            submit_primary_action(page, 'input[name="password"]')
            time.sleep(4)

        return wait_for_post_signup_target(page, timeout_ms=5000)

    def _submit_password_with_recovery(self, page, password: str) -> bool:
        if not refill_password(page, password):
            return False

        time.sleep(1)
        submit_primary_action(page, 'input[name="password"]')
        time.sleep(5)

        if wait_for_post_signup_target(page, timeout_ms=15000):
            return True

        return self._recover_password_challenge(page, password)

    def run(self, email: str, password: str) -> dict:
        launch_options = {"headless": self.headless}
        proxy = _build_proxy_config(self.proxy)
        if proxy:
            launch_options["proxy"] = proxy

        with Camoufox(**launch_options) as browser:
            page = browser.new_page()

            page.goto("https://app.tavily.com/sign-in", wait_until="networkidle", timeout=30000)
            time.sleep(2)

            signup_url = extract_signup_url(page.content())
            if not signup_url:
                raise RuntimeError("未找到 Tavily 注册入口")

            self.log("进入 Tavily 注册页")
            page.goto(signup_url, wait_until="networkidle", timeout=30000)
            time.sleep(2)

            email_selector = fill_first_input(page, ['input[name="email"]', 'input[name="username"]'], email)
            if not email_selector:
                raise RuntimeError("注册页未找到邮箱输入框")

            self.log("处理注册页 Turnstile")
            token = self._solve_turnstile(page.url, get_turnstile_sitekey(page))
            if not token:
                raise RuntimeError("注册页 Turnstile 求解失败")
            inject_turnstile_token(page, token)

            submit_primary_action(page, email_selector)
            time.sleep(6)

            try:
                page.wait_for_selector('input[name="code"], input[name="password"]', timeout=15000)
            except Exception:
                org_only_message = detect_org_only_signup_message(page)
                if org_only_message:
                    raise RuntimeError(
                        "Tavily 当前已禁用普通邮箱密码注册，仅允许特定组织使用 Email/password，"
                        "普通账号需要改走 Google/GitHub/LinkedIn/Microsoft OAuth。"
                    )
                submit_primary_action(page)
                time.sleep(3)
                try:
                    page.wait_for_selector('input[name="code"], input[name="password"]', timeout=20000)
                except Exception:
                    org_only_message = detect_org_only_signup_message(page)
                    if org_only_message:
                        raise RuntimeError(
                            "Tavily 当前已禁用普通邮箱密码注册，仅允许特定组织使用 Email/password，"
                            "普通账号需要改走 Google/GitHub/LinkedIn/Microsoft OAuth。"
                        )
                    feedback = extract_page_feedback(page)
                    raise RuntimeError(f"未进入验证码/密码页面: {feedback or page.url}")

            if page.query_selector('input[name="code"]'):
                if not self.otp_callback:
                    raise RuntimeError("当前流程需要邮箱验证码，但未提供 otp_callback")
                self.log("等待邮箱验证码")
                code = self.otp_callback()
                if not code:
                    raise RuntimeError("未获取到邮箱验证码")
                page.fill('input[name="code"]', code)
                submit_primary_action(page, 'input[name="code"]')
                time.sleep(3)

            try:
                page.wait_for_selector('input[name="password"]', timeout=30000)
            except Exception:
                raise RuntimeError(f"未到达注册密码页: {page.url}")

            self.log("设置 Tavily 密码")
            if not self._submit_password_with_recovery(page, password):
                feedback = extract_page_feedback(page)
                raise RuntimeError(f"密码提交失败: {feedback or page.url}")

            time.sleep(3)
            if "verify" in page.url.lower():
                if not self.verification_link_callback:
                    raise RuntimeError("当前流程需要邮件验证链接，但未提供 verification_link_callback")
                self.log("等待 Tavily 验证链接")
                verify_url = self.verification_link_callback()
                if not verify_url:
                    raise RuntimeError("未获取到 Tavily 验证链接")
                page.goto(verify_url, wait_until="networkidle", timeout=60000)
                page.wait_for_url("**/app.tavily.com/**", timeout=60000)
                time.sleep(3)

            api_key = self._finalize_api_key(page)
            return {"email": email, "password": password, "api_key": api_key}
