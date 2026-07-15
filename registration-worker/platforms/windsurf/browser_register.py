"""Windsurf headed/headless browser-assisted flows."""
from __future__ import annotations

import json
import os
import random
import re
import time
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from playwright.sync_api import Page, sync_playwright
try:
    from camoufox.sync_api import Camoufox
except Exception:  # pragma: no cover
    Camoufox = None

from platforms.windsurf.core import (
    SEAT_SERVICE,
    UA,
    WINDSURF_BASE,
    WINDSURF_TURNSTILE_SITEKEY,
    _field_string,
    _field_varint,
    build_account_overview,
    parse_current_user_response,
    parse_plan_status_response,
    parse_post_auth_response,
    parse_proto,
    parse_stripe_subscription_state,
    parse_subscribe_to_plan_response,
    summarize_account_state,
)


def _proxy_config(proxy: Optional[str]) -> Optional[dict]:
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


def _launch_chromium(pw, launch_opts: dict):
    chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if os.path.exists(chrome_path):
        return pw.chromium.launch(executable_path=chrome_path, **launch_opts)
    return pw.chromium.launch(**launch_opts)


def _extract_stripe_redirect_url(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        return ""
    setup_intent = payload.get("setup_intent")
    if not isinstance(setup_intent, dict):
        return ""
    next_action = setup_intent.get("next_action")
    if not isinstance(next_action, dict):
        return ""
    for key in ("alipay_handle_redirect", "redirect_to_url"):
        candidate = next_action.get(key)
        if not isinstance(candidate, dict):
            continue
        for field in ("url", "native_url"):
            value = str(candidate.get(field) or "").strip()
            if value:
                return value
    return ""


def _get_turnstile_sitekey(page: Page) -> str:
    try:
        sitekey = page.evaluate(
            """() => {
                const node = document.querySelector('[data-sitekey], .cf-turnstile, [data-captcha-sitekey]');
                return node ? (node.getAttribute('data-sitekey') || node.getAttribute('data-captcha-sitekey') || '') : '';
            }"""
        )
        if sitekey:
            return str(sitekey).strip()
    except Exception:
        pass
    return WINDSURF_TURNSTILE_SITEKEY


def _inject_turnstile(page: Page, token: str) -> bool:
    safe = token.replace("\\", "\\\\").replace("'", "\\'")
    script = f"""(function() {{
        const token = '{safe}';
        if (window.turnstile) {{
            const orig = window.turnstile;
            window.turnstile = new Proxy(orig, {{
                get(target, prop) {{
                    if (prop === 'getResponse') return () => token;
                    if (prop === 'isExpired') return () => false;
                    return Reflect.get(target, prop);
                }}
            }});
        }}
        const fns = [
            window._turnstileTokenCallback,
            window.turnstileCallback,
            window.onTurnstileSuccess,
            window.cfTurnstileCallback,
        ];
        fns.forEach(fn => {{ if (typeof fn === 'function') {{ try {{ fn(token); }} catch (e) {{}} }} }});
        const names = ['captcha', 'cf-turnstile-response', 'turnstile_token'];
        const form = document.querySelector('form') || document.body;
        names.forEach(name => {{
            let f = document.querySelector('input[name="' + name + '"], textarea[name="' + name + '"]');
            if (!f) {{
                f = document.createElement('input');
                f.type = 'hidden';
                f.name = name;
                form.appendChild(f);
            }}
            f.value = token;
            f.dispatchEvent(new Event('input', {{ bubbles: true }}));
            f.dispatchEvent(new Event('change', {{ bubbles: true }}));
        }});
        return true;
    }})();"""
    try:
        return bool(page.evaluate(script))
    except Exception:
        return False


def _has_turnstile_iframe(page: Page) -> bool:
    try:
        for frame in page.frames:
            if "challenges.cloudflare.com" in frame.url:
                return True
        return bool(
            page.evaluate(
                """() => [...document.querySelectorAll('iframe')].some((f) => (f.src || '').includes('challenges.cloudflare.com'))"""
            )
        )
    except Exception:
        return False


def _is_cf_full_block(page: Page) -> bool:
    try:
        content = page.content().lower()
        full_block_signals = [
            "just a moment",
            "checking your browser",
            "verifying you are human",
            "verify you are human",
            "performing security verification",
            "security check to access",
            "ray id",
        ]
        if any(signal in content for signal in full_block_signals):
            has_pricing = bool(page.query_selector('button, a[href*="pricing"], [data-testid]'))
            if not has_pricing:
                return True
    except Exception:
        pass
    return False


def _is_turnstile_modal_visible(page: Page) -> bool:
    try:
        content = page.content().lower()
        signals = [
            "confirm you are human",
            "we need to confirm you are human",
            "verify you are human",
            "需要确认您是真人",
            "确认您是真人",
        ]
        if any(signal in content for signal in signals):
            return True
        return _has_turnstile_iframe(page)
    except Exception:
        return False


def _click_turnstile_in_iframe(page: Page, log_fn: Callable[[str], None] = print) -> bool:
    deadline = time.time() + 15
    cf_frame_obj = None
    while time.time() < deadline:
        for frame in page.frames:
            if "challenges.cloudflare.com" in frame.url:
                cf_frame_obj = frame
                break
        if cf_frame_obj:
            break
        time.sleep(0.5)
    if not cf_frame_obj:
        log_fn("未找到 Windsurf Turnstile iframe，跳过直接点击")
        return False
    iframe_el = None
    for el in page.query_selector_all("iframe"):
        try:
            if "cloudflare.com" in str(el.get_attribute("src") or ""):
                iframe_el = el
                break
        except Exception:
            continue
    if not iframe_el:
        try:
            iframe_el = cf_frame_obj.frame_element()
        except Exception:
            iframe_el = None
    if iframe_el:
        try:
            box = None
            for _ in range(10):
                current = iframe_el.bounding_box()
                if current and current["height"] > 10 and current["y"] > 0:
                    box = current
                    break
                time.sleep(1)
            if box:
                cx = box["x"] + 24
                cy = box["y"] + box["height"] / 2
                page.mouse.move(cx + random.randint(-5, 5), cy + random.randint(-3, 3))
                time.sleep(random.uniform(0.1, 0.25))
                page.mouse.down()
                time.sleep(random.uniform(0.08, 0.15))
                page.mouse.up()
                log_fn(f"✅ 点击 Windsurf Turnstile checkbox: ({cx:.0f}, {cy:.0f})")
                time.sleep(2)
                if _is_turnstile_modal_visible(page):
                    page.mouse.move(cx + 12, cy)
                    time.sleep(0.1)
                    page.mouse.down()
                    time.sleep(0.1)
                    page.mouse.up()
                    time.sleep(1)
                return True
        except Exception as exc:
            log_fn(f"Windsurf Turnstile 坐标点击失败: {exc}")
    try:
        cf_frame_obj.locator("body").click(position={"x": 24, "y": 32}, timeout=5000)
        log_fn("✅ Windsurf Turnstile frame 内点击成功")
        return True
    except Exception as exc:
        log_fn(f"Windsurf Turnstile frame 内点击失败: {exc}")
    return False


def _visible_text_buttons(page: Page) -> str:
    try:
        values = page.evaluate(
            """() => [...document.querySelectorAll('button,a,[role="button"]')]
                .filter((el) => el.offsetWidth || el.offsetHeight || el.getClientRects().length)
                .map((el) => (el.innerText || el.textContent || '').trim())
                .filter(Boolean)
                .slice(0, 30)"""
        )
        return " | ".join(str(item) for item in values)
    except Exception:
        return ""


def _click_start_trial(page: Page, log_fn: Callable[[str], None] = print, *, timeout: int = 30) -> bool:
    patterns = (
        re.compile(r"Start Free Trial", re.I),
        re.compile(r"Free Trial", re.I),
        re.compile(r"Start.*Trial", re.I),
    )
    deadline = time.time() + max(int(timeout or 30), 5)
    while time.time() < deadline:
        for pattern in patterns:
            for locator in (
                page.get_by_role("button", name=pattern).first,
                page.get_by_text(pattern).first,
            ):
                try:
                    if locator.count() and locator.is_visible() and locator.is_enabled():
                        locator.scroll_into_view_if_needed(timeout=3000)
                        locator.click(timeout=5000, force=True)
                        log_fn("已点击 Windsurf pricing 页 Start Free Trial")
                        return True
                except Exception:
                    pass
        try:
            clicked = page.evaluate(
                """() => {
                    const candidates = [...document.querySelectorAll('button,a,[role="button"]')];
                    for (const el of candidates) {
                        const text = (el.innerText || el.textContent || '').trim();
                        const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                        const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
                        if (visible && !disabled && /Start\\s+Free\\s+Trial|Free\\s+Trial|Start.*Trial/i.test(text)) {
                            el.scrollIntoView({ block: 'center', inline: 'center' });
                            el.click();
                            return text;
                        }
                    }
                    return '';
                }"""
            )
            if clicked:
                log_fn(f"已点击 Windsurf pricing 页按钮: {clicked}")
                return True
        except Exception:
            pass
        page.wait_for_timeout(1000)
    log_fn(f"未找到 Windsurf pricing 页 Start Free Trial，可见按钮: {_visible_text_buttons(page)}")
    return False


def _click_turnstile_continue(page: Page, log_fn: Callable[[str], None] = print, *, timeout: int = 12) -> bool:
    patterns = (
        re.compile(r"^\s*Continue\s*$", re.I),
        re.compile(r"^\s*继续\s*$", re.I),
        re.compile(r"Continue", re.I),
    )
    deadline = time.time() + max(int(timeout or 12), 3)
    while time.time() < deadline:
        if "checkout.stripe.com" in str(page.url or ""):
            return True
        for pattern in patterns:
            for locator in (
                page.get_by_role("button", name=pattern).first,
                page.get_by_text(pattern).first,
            ):
                try:
                    if locator.count() and locator.is_visible() and locator.is_enabled():
                        locator.scroll_into_view_if_needed(timeout=2500)
                        locator.click(timeout=4000, force=True)
                        log_fn("已点击 Windsurf Turnstile 弹窗 Continue")
                        return True
                except Exception:
                    pass
        try:
            clicked = page.evaluate(
                """() => {
                    const candidates = [...document.querySelectorAll('button,[role="button"],a')];
                    for (const el of candidates) {
                        const text = (el.innerText || el.textContent || '').trim();
                        const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                        const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
                        if (visible && !disabled && /^continue$/i.test(text)) {
                            el.scrollIntoView({ block: 'center', inline: 'center' });
                            el.click();
                            return text;
                        }
                    }
                    return '';
                }"""
            )
            if clicked:
                log_fn(f"已点击 Windsurf Turnstile 弹窗按钮: {clicked}")
                return True
        except Exception:
            pass
        page.wait_for_timeout(800)
    return False


def _wait_cf_full_block_clear(page: Page, timeout: int = 120, log_fn: Callable[[str], None] = print) -> None:
    deadline = time.time() + timeout
    warned = False
    clicked = False
    while time.time() < deadline:
        if not _is_cf_full_block(page):
            break
        if not warned:
            log_fn("检测到 Windsurf Cloudflare 全页拦截，尝试点击验证 checkbox...")
            warned = True
        try:
            w = page.viewport_size or {"width": 1280, "height": 720}
            for _ in range(3):
                page.mouse.move(random.randint(100, w["width"] - 100), random.randint(100, w["height"] - 100))
                time.sleep(random.uniform(0.1, 0.3))
        except Exception:
            pass
        if not clicked:
            clicked = _click_turnstile_in_iframe(page, log_fn)
            if not clicked:
                time.sleep(1)
        else:
            time.sleep(2)


def _handle_turnstile(
    page: Page,
    *,
    log_fn: Callable[[str], None] = print,
    provided_token: str = "",
    wait_secs: int = 12,
) -> bool:
    deadline = time.time() + wait_secs
    has_turnstile = False
    while time.time() < deadline:
        if _is_cf_full_block(page) or _is_turnstile_modal_visible(page):
            has_turnstile = True
            break
        if "checkout.stripe.com" in str(page.url or ""):
            return False
        time.sleep(1)
    if not has_turnstile:
        return False
    if _is_cf_full_block(page):
        _wait_cf_full_block_clear(page, timeout=max(wait_secs, 30), log_fn=log_fn)
        if "checkout.stripe.com" in str(page.url or ""):
            return True
    log_fn("检测到 Windsurf Turnstile，尝试直接点击 iframe checkbox...")
    solved = _click_turnstile_in_iframe(page, log_fn)
    if not solved and provided_token:
        token = str(provided_token or "").strip()
        if token:
            log_fn(f"注入 Windsurf Turnstile token ({token[:40]}...)")
            _inject_turnstile(page, token)
            time.sleep(2)
            _click_start_trial(page, log_fn)
            time.sleep(3)
            return True
    if solved:
        time.sleep(3)
        _click_turnstile_continue(page, log_fn=log_fn, timeout=10)
        if _is_turnstile_modal_visible(page):
            log_fn("Windsurf Turnstile 仍在显示，继续等待自动通过...")
            time.sleep(5)
        if "checkout.stripe.com" not in str(page.url or ""):
            _click_start_trial(page, log_fn)
            _click_turnstile_continue(page, log_fn=log_fn, timeout=8)
            time.sleep(2)
            deadline = time.time() + max(wait_secs, 8)
            while time.time() < deadline:
                if "checkout.stripe.com" in str(page.url or ""):
                    break
                page.wait_for_timeout(600)
    return True


def _headers(*, content_type: str, referer: str, account_id: str = "", org_id: str = "") -> dict[str, str]:
    headers = {
        "accept": "*/*",
        "content-type": content_type,
        "origin": WINDSURF_BASE,
        "referer": f"{WINDSURF_BASE}{referer}",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
    }
    if content_type == "application/proto":
        headers["connect-protocol-version"] = "1"
    if account_id:
        headers["x-devin-account-id"] = account_id
    if org_id:
        headers["x-devin-primary-org-id"] = org_id
    return headers


class WindsurfBrowserApi:
    def __init__(self, page: Page, log_fn: Callable[[str], None] = print):
        self.page = page
        self.log = log_fn

    def _json_post(self, path: str, payload: dict, *, referer: str = "/account/register") -> dict:
        response = self.page.request.post(
            f"{WINDSURF_BASE}{path}",
            headers=_headers(content_type="application/json", referer=referer),
            data=json.dumps(payload),
        )
        if response.status >= 400:
            raise RuntimeError(f"{path} 失败: HTTP {response.status} {response.text()[:200]}")
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError(f"{path} 返回格式异常")
        return data

    def _proto_post(
        self,
        method: str,
        body: bytes,
        *,
        account_id: str = "",
        org_id: str = "",
        referer: str = "/profile",
    ) -> bytes:
        response = self.page.request.post(
            f"{WINDSURF_BASE}{SEAT_SERVICE}/{method}",
            headers=_headers(
                content_type="application/proto",
                referer=referer,
                account_id=account_id,
                org_id=org_id,
            ),
            data=body,
        )
        if response.status >= 400:
            raise RuntimeError(f"{method} 失败: HTTP {response.status} {response.text()[:200]}")
        return response.body()

    def fetch_connections(self, email: str) -> dict:
        return self._json_post("/_devin-auth/connections", {"product": "windsurf", "email": email})

    def check_user_login_method(self, email: str) -> None:
        self._proto_post("CheckUserLoginMethod", _field_string(1, email), referer="/account/register")

    def start_email_signup(self, email: str) -> str:
        self.log(f"Step1: 发送 Windsurf 验证码到 {email}")
        data = self._json_post(
            "/_devin-auth/email/start",
            {"email": email, "mode": "signup", "product": "Windsurf"},
        )
        token = str(data.get("email_verification_token") or "").strip()
        if not token:
            raise RuntimeError("Windsurf 未返回 email_verification_token")
        return token

    def complete_email_signup(self, *, verification_token: str, code: str, password: str, name: str) -> dict:
        self.log("Step2: 提交 Windsurf 邮箱验证码")
        data = self._json_post(
            "/_devin-auth/email/complete",
            {
                "email_verification_token": verification_token,
                "code": code,
                "mode": "signup",
                "password": password,
                "name": name,
            },
        )
        if not str(data.get("token") or "").strip():
            raise RuntimeError("Windsurf 未返回 auth token")
        return data

    def post_auth(self, auth_token: str) -> dict[str, str]:
        self.log("Step3: 兑换 Windsurf session")
        content = self._proto_post("WindsurfPostAuth", _field_string(1, auth_token), referer="/account/register")
        data = parse_post_auth_response(content)
        if not data.get("session_token"):
            raise RuntimeError("Windsurf 未返回 session_token")
        return data

    def load_account_state(self, *, session_token: str, account_id: str, org_id: str, fallback_email: str) -> dict:
        auth_body = _field_string(1, session_token)
        current_user = parse_current_user_response(
            self._proto_post("GetCurrentUser", auth_body, account_id=account_id, org_id=org_id)
        )
        plan_status = parse_plan_status_response(
            self._proto_post(
                "GetPlanStatus",
                auth_body + _field_varint(2, 1),
                account_id=account_id,
                org_id=org_id,
                referer="/subscription/usage",
            )
        )
        stripe_state = {}
        try:
            stripe_state = parse_stripe_subscription_state(
                self._proto_post(
                    "GetStripeSubscriptionState",
                    auth_body,
                    account_id=account_id,
                    org_id=org_id,
                    referer="/subscription/manage-plan",
                )
            )
        except Exception as exc:
            stripe_state = {"error": str(exc)}
        state = {
            "current_user": current_user,
            "plan_status": plan_status,
            "stripe_subscription": stripe_state,
        }
        state["summary"] = summarize_account_state(state, fallback_email=fallback_email)
        return state

    def subscribe_to_plan(self, *, session_token: str, account_id: str, org_id: str, turnstile_token: str) -> dict[str, str]:
        body = b"".join([
            _field_string(1, session_token),
            _field_varint(3, 1),
            _field_string(4, f"{WINDSURF_BASE}/subscription/pending?expect_tier=trial"),
            _field_string(5, f"{WINDSURF_BASE}/plan?plan_cancelled=true&plan_tier=trial"),
            _field_varint(8, 2),
            _field_varint(9, 1),
            _field_string(10, turnstile_token),
        ])
        content = self._proto_post(
            "SubscribeToPlan",
            body,
            account_id=account_id,
            org_id=org_id,
            referer=f"/billing/individual?plan=9&turnstile_token={turnstile_token}",
        )
        result = parse_subscribe_to_plan_response(content)
        if not result.get("checkout_url"):
            raise RuntimeError("Windsurf SubscribeToPlan 未返回 checkout_url")
        return result


class WindsurfBrowserRegister:
    def __init__(
        self,
        *,
        headless: bool = False,
        proxy: str | None = None,
        otp_callback: Optional[Callable[[], str]] = None,
        log_fn: Callable[[str], None] = print,
    ):
        self.headless = headless
        self.proxy = proxy
        self.otp_callback = otp_callback
        self.log = log_fn

    def run(self, *, email: str, password: str, name: str) -> dict:
        if not self.otp_callback:
            raise RuntimeError("otp_callback is required")
        if Camoufox is not None:
            try:
                self.log("Step0: 使用 Camoufox 打开 Windsurf 注册页")
                launch_opts = {"headless": self.headless}
                proxy = _proxy_config(self.proxy)
                if proxy:
                    launch_opts["proxy"] = proxy
                with Camoufox(**launch_opts) as browser:
                    page = browser.new_page()
                    page.set_default_timeout(90000)
                    WindsurfCamoufoxCheckoutFlow._add_mouse_event_patch(page)
                    return self._run_with_page(page, email=email, password=password, name=name)
            except Exception as exc:
                self.log(f"Camoufox 注册失败，回退到 Playwright: {exc}")
        with sync_playwright() as pw:
            launch_opts = {
                "headless": self.headless,
                "args": ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"],
            }
            proxy = _proxy_config(self.proxy)
            if proxy:
                launch_opts["proxy"] = proxy
            browser = _launch_chromium(pw, launch_opts)
            context = browser.new_context(viewport={"width": 1280, "height": 820}, user_agent=UA)
            context.set_default_timeout(90000)
            page = context.new_page()
            try:
                return self._run_with_page(page, email=email, password=password, name=name)
            finally:
                context.close()
                browser.close()

    def _run_with_page(self, page: Page, *, email: str, password: str, name: str) -> dict:
        first_name, last_name = self._split_name(name)
        self.log("Step0: 打开 Windsurf 登录页并进入注册页")
        page.goto(f"{WINDSURF_BASE}/account/login", wait_until="domcontentloaded", timeout=90000)
        page.get_by_role("link", name=re.compile(r"Sign up", re.I)).click()
        page.wait_for_url(re.compile(r"/account/register"), timeout=90000)
        page.wait_for_selector('input[autocomplete="given-name"]', state="visible", timeout=90000)
        self.log("Step1: 填写姓名、邮箱并同意条款")
        page.locator('input[autocomplete="given-name"]').fill(first_name)
        page.locator('input[autocomplete="family-name"]').fill(last_name)
        page.locator('input[type="email"]').fill(email)
        tos = page.locator("#auth1-agree-tos")
        if not tos.is_checked():
            tos.check()
        page.locator('button[type="submit"]').click()
        page.wait_for_selector('input[name="password"]', state="visible", timeout=90000)

        self.log("Step2: 填写 Windsurf 密码")
        page.locator('input[name="password"]').fill(password)
        page.locator('input[name="confirmPassword"]').fill(password)
        page.locator('button[type="submit"]').click()
        page.wait_for_selector('input[autocomplete="one-time-code"]', state="visible", timeout=90000)

        raw_code = self.otp_callback()
        code = self._extract_code(raw_code)
        self.log(f"获取 Windsurf 验证码: {code}")

        complete_data: dict = {}
        auth_data: dict[str, str] = {}

        def _capture_response(response):
            nonlocal complete_data, auth_data
            try:
                if "/_devin-auth/email/complete" in response.url and response.status == 200:
                    data = response.json()
                    if isinstance(data, dict):
                        complete_data = data
                elif "SeatManagementService/WindsurfPostAuth" in response.url and response.status == 200:
                    parsed = parse_post_auth_response(response.body())
                    if parsed.get("session_token"):
                        auth_data = parsed
            except Exception:
                pass

        page.on("response", _capture_response)
        self.log("Step3: 填写邮箱验证码并创建账号")
        self._fill_otp(page, code)
        page.get_by_role("button", name=re.compile(r"Create account", re.I)).click()

        deadline = time.time() + 90
        while time.time() < deadline and not auth_data.get("session_token"):
            page.wait_for_timeout(1000)

        api = WindsurfBrowserApi(page, log_fn=self.log)
        complete = complete_data
        auth_token = str(complete.get("token") or "")
        if not auth_data and auth_token:
            self.log("页面未捕获 WindsurfPostAuth 响应，使用页面会话补充兑换 session")
            auth_data = api.post_auth(auth_token)
        if not auth_data.get("session_token"):
            visible_text = ""
            try:
                visible_text = page.locator("body").inner_text(timeout=3000)[:500]
            except Exception:
                pass
            raise RuntimeError(f"Windsurf 页面注册未拿到 session_token，当前页面: {visible_text}")
        auth = auth_data
        session_token = auth["session_token"]
        account_id = auth.get("account_id", "")
        org_id = auth.get("org_id", "")
        state = api.load_account_state(
            session_token=session_token,
            account_id=account_id,
            org_id=org_id,
            fallback_email=email,
        )
        summary = dict(state.get("summary") or {})
        overview = dict(summary.get("account_overview") or {})
        self.log(
            f"Windsurf 浏览器注册成功: {email} "
            f"plan={overview.get('plan_name', 'unknown')} "
            f"quota={overview.get('remaining_credits', '-')}"
        )
        return {
            "email": str(complete.get("email") or email),
            "password": password,
            "name": name,
            "user_id": str(complete.get("user_id") or (overview.get("remote_user") or {}).get("user_id") or ""),
            "auth_token": auth_token,
            "session_token": session_token,
            "account_id": account_id,
            "org_id": org_id,
            "account_overview": overview,
            "state_summary": summary,
        }

    @staticmethod
    def _extract_code(raw: str) -> str:
        match = re.search(r"\b(\d{6})\b", str(raw or ""))
        if match:
            return match.group(1)
        raise RuntimeError(f"无法从邮件内容中提取 Windsurf 6 位验证码: {str(raw or '')[:200]}")

    @staticmethod
    def _split_name(name: str) -> tuple[str, str]:
        parts = [part for part in re.split(r"\s+", str(name or "").strip()) if part]
        sanitized_parts: list[str] = []
        for part in parts:
            cleaned = re.sub(r"[^A-Za-z]+", "", part)
            if cleaned:
                sanitized_parts.append(cleaned.capitalize())
        if not sanitized_parts:
            return "Windsurf", "User"
        if len(sanitized_parts) == 1:
            token = sanitized_parts[0]
            if len(token) >= 8:
                return token[: min(8, len(token))], token[min(8, len(token)) :] or "User"
            return token, "User"
        return sanitized_parts[0], " ".join(sanitized_parts[1:])

    @staticmethod
    def _fill_otp(page: Page, code: str) -> None:
        inputs = [
            item
            for item in page.locator('input[autocomplete="one-time-code"], input[autocomplete="off"]').all()
            if item.is_visible()
        ]
        if len(inputs) >= len(code):
            for item, char in zip(inputs, code):
                item.fill(char)
            return
        page.locator('input[autocomplete="one-time-code"]').fill(code)


def solve_turnstile_in_headed_browser(
    *,
    proxy: str | None = None,
    timeout: int = 180,
    log_fn: Callable[[str], None] = print,
) -> str:
    with sync_playwright() as pw:
        launch_opts = {
            "headless": False,
            "args": ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"],
        }
        proxy_config = _proxy_config(proxy)
        if proxy_config:
            launch_opts["proxy"] = proxy_config
        browser = _launch_chromium(pw, launch_opts)
        context = browser.new_context(viewport={"width": 1100, "height": 760}, user_agent=UA)
        context.set_default_timeout(90000)
        page = context.new_page()
        try:
            page.goto(f"{WINDSURF_BASE}/pricing", wait_until="domcontentloaded", timeout=90000)
            page.evaluate(
                """
                (sitekey) => {
                  window.__windsurfTurnstileToken = '';
                  const host = document.createElement('div');
                  host.style.position = 'fixed';
                  host.style.zIndex = '2147483647';
                  host.style.left = '50%';
                  host.style.top = '50%';
                  host.style.transform = 'translate(-50%, -50%)';
                  host.style.padding = '24px';
                  host.style.borderRadius = '18px';
                  host.style.background = 'white';
                  host.style.boxShadow = '0 24px 80px rgba(0,0,0,.28)';
                  const title = document.createElement('div');
                  title.textContent = 'Complete Windsurf Turnstile';
                  title.style.cssText = 'font: 600 16px sans-serif; margin-bottom: 14px; color: #111;';
                  const widget = document.createElement('div');
                  widget.id = 'windsurf-turnstile-widget';
                  host.appendChild(title);
                  host.appendChild(widget);
                  document.body.appendChild(host);
                  const render = () => window.turnstile.render(widget, {
                    sitekey,
                    callback: token => { window.__windsurfTurnstileToken = token; }
                  });
                  if (window.turnstile && window.turnstile.render) {
                    render();
                    return;
                  }
                  const script = document.createElement('script');
                  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
                  script.async = true;
                  script.defer = true;
                  script.onload = render;
                  document.head.appendChild(script);
                }
                """,
                WINDSURF_TURNSTILE_SITEKEY,
            )
            log_fn("请在打开的浏览器窗口中完成 Windsurf Turnstile 验证...")
            deadline = time.time() + max(int(timeout or 180), 30)
            while time.time() < deadline:
                token = str(page.evaluate("() => window.__windsurfTurnstileToken || ''") or "").strip()
                if token:
                    return token
                time.sleep(1)
            raise TimeoutError("等待浏览器 Turnstile token 超时")
        finally:
            context.close()
            browser.close()


class WindsurfStripeCheckoutBrowser:
    def __init__(
        self,
        *,
        headless: bool = True,
        proxy: str | None = None,
        log_fn: Callable[[str], None] = print,
    ):
        self.headless = headless
        self.proxy = proxy
        self.log = log_fn

    def generate_alipay_link(
        self,
        *,
        checkout_url: str,
        email: str,
        billing_name: str,
        timeout: int = 120,
        billing_country: str = "US",
        billing_state: str = "CA",
        billing_city: str = "San Francisco",
        billing_postal_code: str = "94105",
        billing_line1: str = "1 Market St",
        billing_line2: str = "",
    ) -> dict[str, str]:
        with sync_playwright() as pw:
            launch_opts = {
                "headless": self.headless,
                "args": ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"],
            }
            proxy = _proxy_config(self.proxy)
            if proxy:
                launch_opts["proxy"] = proxy
            browser = _launch_chromium(pw, launch_opts)
            context = browser.new_context(viewport={"width": 1280, "height": 900}, user_agent=UA, locale="zh-CN")
            context.set_default_timeout(90000)
            page = context.new_page()
            try:
                confirm_payload: dict = {}
                self.log("Step4: 打开 Stripe Checkout")
                page.goto(checkout_url, wait_until="domcontentloaded", timeout=90000)
                result = self._complete_alipay_checkout(
                    page,
                    email=email,
                    billing_name=billing_name,
                    timeout=timeout,
                    billing_country=billing_country,
                    billing_state=billing_state,
                    billing_city=billing_city,
                    billing_postal_code=billing_postal_code,
                    billing_line1=billing_line1,
                    billing_line2=billing_line2,
                )
                confirm_payload = result["confirm_payload"]
                final_url = result["final_url"]

                if not final_url:
                    visible_text = self._page_text(page)[:500]
                    raise RuntimeError(f"未获取到支付宝授权链接，当前页面: {visible_text}")

                return {
                    "checkout_url": checkout_url,
                    "alipay_url": final_url,
                    "cashier_url": final_url,
                    "payment_channel": "alipay",
                    "payment_provider": "stripe",
                    "stripe_checkout_state": str(confirm_payload.get("state") or ""),
                    "stripe_checkout_status": str(confirm_payload.get("status") or ""),
                }
            finally:
                context.close()
                browser.close()

    def _complete_alipay_checkout(
        self,
        page: Page,
        *,
        email: str,
        billing_name: str,
        timeout: int,
        billing_country: str = "US",
        billing_state: str = "CA",
        billing_city: str = "San Francisco",
        billing_postal_code: str = "94105",
        billing_line1: str = "1 Market St",
        billing_line2: str = "",
    ) -> dict[str, Any]:
        page.wait_for_timeout(5000)
        page_text = self._page_text(page)
        if "Something went wrong" in page_text or "could not be found" in page_text:
            raise RuntimeError("Stripe Checkout 已失效，请重新生成 Windsurf 订阅链接")

        confirm_payload: dict[str, Any] = {}
        redirect_url = ""
        alipay_gateway_url = ""

        def _capture_response(response):
            nonlocal confirm_payload, redirect_url, alipay_gateway_url
            try:
                if "openapi.alipay.com/gateway.do" in response.url:
                    alipay_gateway_url = str(response.url or "").strip()
                    return
                is_confirm = "/confirm" in response.url
                is_payment_page_submit = (
                    "api.stripe.com/v1/payment_pages/" in response.url
                    and str(getattr(response.request, "method", "") or "").upper() == "POST"
                )
                if not is_confirm and not is_payment_page_submit:
                    return
                data = response.json()
                if not isinstance(data, dict):
                    return
                confirm_payload = data
                extracted_url = _extract_stripe_redirect_url(data)
                if extracted_url:
                    redirect_url = extracted_url
            except Exception:
                pass

        page.on("response", _capture_response)
        try:
            self.log("Step5: 尝试选择 Alipay 并补齐账单信息")
            self._select_alipay(page)
            self._wait_for_billing_fields(page, timeout=12000)
            self._fill_checkout_form(
                page,
                email=email,
                billing_name=billing_name,
                billing_country=billing_country,
                billing_state=billing_state,
                billing_city=billing_city,
                billing_postal_code=billing_postal_code,
                billing_line1=billing_line1,
                billing_line2=billing_line2,
            )
            self._check_checkout_boxes(page)
            self._log_checkout_form_state(page)

            self.log("Step6: 提交 Stripe Checkout，获取支付宝授权链接")
            self._submit_checkout(page)
            deadline = time.time() + max(int(timeout or 120), 30)
            final_url = ""
            fallback_url = ""
            followed_urls: set[str] = set()
            while time.time() < deadline:
                for candidate_url in self._candidate_urls(page):
                    if self._is_final_alipay_cashier_url(candidate_url):
                        final_url = candidate_url
                        break
                    if "pm-redirects.stripe.com/authorize/" in candidate_url:
                        fallback_url = candidate_url
                    elif "openapi.alipay.com/gateway.do" in candidate_url:
                        fallback_url = candidate_url
                    elif "render.alipay.com/" in candidate_url:
                        fallback_url = candidate_url
                if final_url:
                    self.log(f"Step7: 已进入支付宝扫码/授权页面: {final_url[:160]}")
                    break
                if alipay_gateway_url:
                    fallback_url = alipay_gateway_url
                if redirect_url and not fallback_url:
                    fallback_url = redirect_url
                redirect_candidate = self._next_intermediate_alipay_url(
                    redirect_url=redirect_url,
                    gateway_url=alipay_gateway_url,
                    fallback_url=fallback_url,
                )
                if redirect_candidate and redirect_candidate not in followed_urls:
                    followed_urls.add(redirect_candidate)
                    self.log(f"Step6: 跟进支付宝中转页: {redirect_candidate[:160]}")
                    self._follow_intermediate_alipay_url(page, redirect_candidate)
                    page.wait_for_timeout(1500)
                    continue
                self._advance_intermediate_alipay_page(page)
                try:
                    body_text = self._page_text(page)
                    if "支付宝" in body_text and ("扫码" in body_text or "二维码" in body_text or "授权" in body_text):
                        current_url = str(page.url or "").strip()
                        if current_url and not self._is_stripe_checkout_url(current_url):
                            final_url = current_url
                            self.log(f"Step7: 当前页面已显示支付宝扫码/授权内容: {final_url[:160]}")
                            break
                except Exception:
                    pass
                page.wait_for_timeout(1000)

            if not final_url and fallback_url:
                final_url = fallback_url
            if not final_url and confirm_payload:
                final_url = _extract_stripe_redirect_url(confirm_payload)
            if final_url and self._is_stripe_checkout_url(final_url):
                final_url = ""
            if not final_url and confirm_payload:
                message = str(confirm_payload.get("error", {}).get("message") or "").strip()
                if message:
                    raise RuntimeError(f"Stripe Checkout confirm 失败: {message}")
            if not final_url:
                submit_state = self._submit_button_state(page)
                current_url = str(page.url or "").strip()
                raise RuntimeError(
                    "未进入支付宝扫码/授权页，不能保存 Stripe Checkout 页面。"
                    f"当前 URL: {current_url[:160]} "
                    f"提交按钮状态: {submit_state}"
                )
            return {
                "confirm_payload": confirm_payload,
                "final_url": final_url,
            }
        finally:
            try:
                page.remove_listener("response", _capture_response)
            except Exception:
                pass

    def _log_checkout_form_state(self, page: Page) -> None:
        try:
            state = page.evaluate(
                """() => {
                    const value = (selector) => document.querySelector(selector)?.value || '';
                    const checked = (selector) => !!document.querySelector(selector)?.checked;
                    const submit = document.querySelector('button[data-testid="hosted-payment-submit-button"]') || document.querySelector('button[type="submit"]');
                    return {
                        alipay: checked('input[value="alipay"]'),
                        email: value('input[type="email"]') || value('input[autocomplete="email"]') || value('input[name="email"]'),
                        name: value('#billingName'),
                        country: value('#billingCountry'),
                        line1: value('#billingAddressLine1'),
                        city: value('#billingLocality'),
                        postal: value('#billingPostalCode'),
                        state: value('#billingAdministrativeArea'),
                        terms: checked('#termsOfServiceConsentCheckbox'),
                        submitClass: submit ? String(submit.className || '') : '',
                        submitText: submit ? String(submit.innerText || submit.textContent || '').trim() : '',
                        submitDisabled: submit ? !!submit.disabled : null,
                    };
                }"""
            )
            self.log(
                "Stripe 表单状态: "
                f"alipay={state.get('alipay')} "
                f"email={bool(state.get('email'))} "
                f"name={bool(state.get('name'))} "
                f"country={state.get('country') or '-'} "
                f"line1={bool(state.get('line1'))} "
                f"city={bool(state.get('city'))} "
                f"postal={bool(state.get('postal'))} "
                f"state={bool(state.get('state'))} "
                f"terms={state.get('terms')} "
                f"submitDisabled={state.get('submitDisabled')} "
                f"submitClass={state.get('submitClass') or '-'} "
                f"submitText={state.get('submitText') or '-'}"
            )
        except Exception:
            pass

    def _fill_checkout_form(
        self,
        page: Page,
        *,
        email: str,
        billing_name: str,
        billing_country: str,
        billing_state: str,
        billing_city: str,
        billing_postal_code: str,
        billing_line1: str,
        billing_line2: str,
    ) -> None:
        self._fill_if_empty(
            page,
            [re.compile(r"电子邮箱|邮箱|email", re.I)],
            email,
            selectors=('input[type="email"]', 'input[autocomplete="email"]', 'input[name="email"]'),
        )
        self._select_country_if_needed(page, billing_country)
        self._fill_if_empty(
            page,
            [re.compile(r"姓名|name", re.I)],
            billing_name,
            selectors=('#billingName', 'input[name="billingName"]', 'input[autocomplete="name"]'),
        )
        self._fill_if_empty(
            page,
            [re.compile(r"地址.*1|地址|address line 1|street address", re.I)],
            billing_line1,
            selectors=(
                '#billingAddressLine1',
                'input[name="billingAddressLine1"]',
                'input[autocomplete="billing address-line1"]',
                'input[autocomplete="address-line1"]',
            ),
        )
        self._fill_if_empty(
            page,
            [re.compile(r"地址.*2|address line 2|apartment|suite", re.I)],
            billing_line2,
            selectors=(
                '#billingAddressLine2',
                'input[name="billingAddressLine2"]',
                'input[autocomplete="billing address-line2"]',
                'input[autocomplete="address-line2"]',
            ),
        )
        self._fill_if_empty(
            page,
            [re.compile(r"城市|city", re.I)],
            billing_city,
            selectors=(
                '#billingLocality',
                'input[name="billingLocality"]',
                'input[autocomplete="billing address-level2"]',
                'input[autocomplete="address-level2"]',
            ),
        )
        self._fill_if_empty(
            page,
            [re.compile(r"州|省|state|province|region", re.I)],
            billing_state,
            selectors=(
                '#billingAdministrativeArea',
                'select[name="billingAdministrativeArea"]',
                'input[name="billingAdministrativeArea"]',
                'select[autocomplete="billing address-level1"]',
                'input[autocomplete="billing address-level1"]',
                'select[autocomplete="address-level1"]',
                'input[autocomplete="address-level1"]',
            ),
        )
        self._fill_if_empty(
            page,
            [re.compile(r"邮编|postal|zip", re.I)],
            billing_postal_code,
            selectors=('#billingPostalCode', 'input[name="billingPostalCode"]', 'input[autocomplete="billing postal-code"]', 'input[autocomplete="postal-code"]'),
        )

    def _select_alipay(self, page: Page) -> None:
        for selector in (
            '#payment-method-label-alipay',
            'button[data-testid="alipay-accordion-item-button"]',
            'button[data-testid*="alipay"]',
            '[data-testid*="alipay"]',
            'label[for*="alipay"]',
            'input[value="alipay"]',
        ):
            try:
                page.wait_for_selector(selector, state="attached", timeout=15000)
                target = page.locator(selector).first
                if target.count():
                    target.click(timeout=5000, force=True)
                    page.wait_for_timeout(1200)
                    if self._is_alipay_selected(page):
                        return
            except Exception:
                pass
        try:
            page.evaluate("""() => {
                const input = document.querySelector('input[value="alipay"]');
                if (!input) return false;
                input.click();
                input.checked = true;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                const label = document.querySelector('label[for="' + input.id + '"]');
                if (label) label.click();
                return input.checked;
            }""")
            page.wait_for_timeout(900)
            if self._is_alipay_selected(page):
                return
        except Exception:
            pass
        pattern = re.compile(r"Alipay|支付宝", re.I)
        for target in (
            page.get_by_role("radio", name=pattern).first,
            page.get_by_role("button", name=pattern).first,
            page.get_by_label(pattern).first,
            page.get_by_text(pattern).first,
        ):
            try:
                if target and target.count() and target.is_visible():
                    target.click(timeout=5000, force=True)
                    page.wait_for_timeout(800)
                    if self._is_alipay_selected(page):
                        return
            except Exception:
                pass
        raise RuntimeError(f"Stripe Checkout 中未找到或无法选中 Alipay 支付方式，可见支付方式: {self._visible_payment_methods(page)}")

    @staticmethod
    def _has_billing_fields(page: Page) -> bool:
        try:
            return bool(
                page.evaluate(
                    """() => {
                        const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                        const selectors = [
                            '#billingName',
                            '#billingCountry',
                            '#billingAddressLine1',
                            '#billingLocality',
                            '#billingPostalCode',
                            '#billingAdministrativeArea',
                        ];
                        return selectors.some((selector) => visible(document.querySelector(selector)));
                    }"""
                )
            )
        except Exception:
            return False

    @staticmethod
    def _visible_payment_methods(page: Page) -> str:
        try:
            values = page.evaluate(
                """() => [...document.querySelectorAll('input[name="payment-method-accordion-item-title"], button[aria-label], [data-testid*="accordion-item"]')]
                    .map((el) => el.value || el.getAttribute('aria-label') || (el.innerText || el.textContent || '').trim())
                    .filter(Boolean)
                    .slice(0, 20)"""
            )
            return " | ".join(str(item) for item in values) or "-"
        except Exception:
            return "-"

    def _wait_for_billing_fields(self, page: Page, *, timeout: int = 12000) -> bool:
        deadline = time.time() + max(int(timeout or 12000) / 1000.0, 2.0)
        while time.time() < deadline:
            if self._has_billing_fields(page):
                return True
            if not self._is_alipay_selected(page):
                try:
                    page.locator('button[data-testid="alipay-accordion-item-button"]').first.click(timeout=1200, force=True)
                except Exception:
                    pass
            page.wait_for_timeout(300)
        raise RuntimeError("已选择支付宝但未出现账单信息表单")

    def _submit_checkout(self, page: Page) -> None:
        selectors = (
            'button[data-testid="hosted-payment-submit-button"]',
            'button[type="submit"]',
        )
        for selector in selectors:
            try:
                button = page.locator(selector).last
                if button.count():
                    button.wait_for(state="visible", timeout=10000)
                    ready = self._wait_submit_ready(page, selector)
                    if button.is_enabled():
                        initial_state = self._button_state(button)
                        if not ready and "SubmitButton--incomplete" in initial_state["class_name"]:
                            self.log(f"Step6: Stripe 提交按钮仍标记 incomplete，但按钮可点击，继续提交: {self._submit_button_state(page)}")
                        self._dom_click(button)
                        self.log("Step6: 已点击 Stripe Checkout 提交按钮")
                        if "SubmitButton--incomplete" in initial_state["class_name"]:
                            try:
                                page.wait_for_function(
                                    """(sel) => {
                                        const el = document.querySelector(sel);
                                        if (!el) return false;
                                        const cls = String(el.className || '');
                                        return cls.includes('SubmitButton--complete') && !cls.includes('SubmitButton--processing') && !el.disabled;
                                    }""",
                                    selector,
                                    timeout=45000,
                                )
                                refreshed = page.locator(selector).last
                                if refreshed.count() and refreshed.is_visible() and refreshed.is_enabled():
                                    self._dom_click(refreshed)
                                    self.log("Step6: Stripe 提交按钮完整后已二次点击")
                            except Exception:
                                self.log(f"Step6: 等待 Stripe 提交按钮变完整超时: {self._submit_button_state(page)}")
                        return
            except Exception:
                pass
        patterns = (re.compile(r"Start trial|Subscribe|Authorize|Continue|Pay|立即|继续|授权|订阅", re.I),)
        for pattern in patterns:
            try:
                button = page.get_by_role("button", name=pattern).last
                if button.count() and button.is_visible():
                    page.wait_for_timeout(1500)
                    if button.is_enabled():
                        self._dom_click(button)
                        return
            except Exception:
                pass
        buttons = page.locator("button").all()
        for button in reversed(buttons):
            try:
                if button.is_visible():
                    if not button.is_enabled():
                        page.wait_for_timeout(300)
                    if button.is_enabled():
                        self._dom_click(button)
                        return
            except Exception:
                pass
        raise RuntimeError("Stripe Checkout 中未找到可点击的提交按钮")

    def _fill_if_empty(
        self,
        page: Page,
        patterns: list[re.Pattern[str]],
        value: str,
        *,
        selectors: tuple[str, ...] = (),
    ) -> bool:
        text = str(value or "").strip()
        if not text:
            return False
        for selector in selectors:
            try:
                locator = page.locator(selector).first
                if locator.count() and locator.is_visible():
                    current = str(locator.input_value(timeout=2000) or "").strip()
                    if not current:
                        tag = str(locator.evaluate("(el) => el.tagName")).lower()
                        if tag == "select":
                            self._select_option_flexible(locator, text)
                        else:
                            locator.fill(text)
                    return True
            except Exception:
                pass
        for pattern in patterns:
            try:
                locator = page.get_by_label(pattern).first
                if locator.count() and locator.is_visible():
                    current = str(locator.input_value(timeout=2000) or "").strip()
                    if not current:
                        tag = str(locator.evaluate("(el) => el.tagName")).lower()
                        if tag == "select":
                            self._select_option_flexible(locator, text)
                        else:
                            locator.fill(text)
                    return True
            except Exception:
                pass
        return False

    def _select_country_if_needed(self, page: Page, billing_country: str) -> bool:
        country = str(billing_country or "").strip()
        if not country:
            return False
        for selector in ('#billingCountry', 'select[name="billingCountry"]', 'select[autocomplete="billing country"]', 'select[autocomplete="country"]'):
            try:
                locator = page.locator(selector).first
                if locator.count() and locator.is_visible():
                    current = str(locator.input_value(timeout=2000) or "").strip().upper()
                    if current != country.upper():
                        self._select_option_flexible(locator, country)
                        page.wait_for_timeout(700)
                    return True
            except Exception:
                pass
        for pattern in (re.compile(r"国家|地区|country|region", re.I),):
            try:
                locator = page.get_by_label(pattern).first
                if locator.count() and locator.is_visible():
                    tag = str(locator.evaluate("(el) => el.tagName")).lower()
                    if tag == "select":
                        self._select_option_flexible(locator, country)
                    else:
                        current = str(locator.input_value(timeout=2000) or "").strip().upper()
                        if not current:
                            locator.fill(country)
                    return True
            except Exception:
                pass
        return False

    def _check_checkout_boxes(self, page: Page) -> None:
        try:
            checkbox = page.locator("#termsOfServiceConsentCheckbox").first
            if checkbox.count():
                checkbox.check(timeout=3000, force=True)
                page.wait_for_timeout(300)
        except Exception:
            pass
        patterns = (re.compile(r"条款|terms|agree|authorize|授权|mandate|订阅", re.I),)
        for pattern in patterns:
            try:
                checkbox = page.get_by_role("checkbox", name=pattern).first
                if checkbox.count() and checkbox.is_visible():
                    checked = False
                    try:
                        checked = checkbox.is_checked()
                    except Exception:
                        checked = str(checkbox.get_attribute("aria-checked") or "").lower() == "true"
                    if not checked:
                        checkbox.click(timeout=3000, force=True)
                        page.wait_for_timeout(300)
            except Exception:
                pass

    def _wait_submit_ready(self, page: Page, selector: str) -> bool:
        try:
            page.wait_for_function(
                """(sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return false;
                    if (el.disabled) return false;
                    const cls = String(el.className || '');
                    return !cls.includes('SubmitButton--incomplete');
                }""",
                selector,
                timeout=10000,
            )
            return True
        except Exception:
            pass
        page.wait_for_timeout(1000)
        return False

    def _follow_intermediate_alipay_url(self, page: Page, url: str) -> None:
        value = str(url or "").strip()
        if not value:
            return
        try:
            page.goto(value, wait_until="domcontentloaded", timeout=90000)
            return
        except Exception as exc:
            self.log(f"支付宝中转页直接打开失败，尝试页面内跳转: {exc}")
        try:
            page.evaluate(
                """(targetUrl) => {
                    window.location.href = targetUrl;
                }""",
                value,
            )
        except Exception:
            pass

    def _advance_intermediate_alipay_page(self, page: Page) -> bool:
        current_url = str(page.url or "")
        if not any(marker in current_url for marker in ("pm-redirects.stripe.com", "openapi.alipay.com", "render.alipay.com")):
            return False
        if self._is_final_alipay_cashier_url(current_url):
            return False
        for pattern in (
            re.compile(r"继续|Continue|Proceed|打开支付宝|Open Alipay|授权|Authorize|支付|Pay", re.I),
        ):
            for locator in (
                page.get_by_role("button", name=pattern).first,
                page.get_by_role("link", name=pattern).first,
                page.get_by_text(pattern).first,
            ):
                try:
                    if locator.count() and locator.is_visible() and locator.is_enabled():
                        locator.click(timeout=3000, force=True)
                        self.log("Step6: 已点击支付宝中转页继续按钮")
                        return True
                except Exception:
                    pass
        try:
            submitted = page.evaluate(
                """() => {
                    const form = document.querySelector('form');
                    if (form) {
                        if (typeof form.requestSubmit === 'function') form.requestSubmit();
                        else form.submit();
                        return 'form';
                    }
                    const candidate = [...document.querySelectorAll('button,a,input[type="submit"]')]
                        .find((el) => (el.offsetWidth || el.offsetHeight || el.getClientRects().length) && !el.disabled);
                    if (candidate) {
                        candidate.click();
                        return 'click';
                    }
                    return '';
                }"""
            )
            if submitted:
                self.log("Step6: 已推进支付宝中转页表单")
                return True
        except Exception:
            pass
        return False

    @staticmethod
    def _select_option_flexible(locator, text: str) -> None:
        value = str(text or "").strip()
        if not value:
            return
        try:
            locator.select_option(value=value)
            return
        except Exception:
            pass
        try:
            locator.select_option(label=value)
            return
        except Exception:
            pass
        selected = locator.evaluate(
            """(el, wanted) => {
                const normalize = (value) => String(value || '').trim().toLowerCase();
                const target = normalize(wanted);
                const stateNames = { ca: 'california', ny: 'new york', tx: 'texas', wa: 'washington' };
                const aliases = new Set([target, normalize(stateNames[target])]);
                const options = [...el.options];
                const option = options.find((item) => aliases.has(normalize(item.value)) || aliases.has(normalize(item.textContent)));
                if (!option) return false;
                el.value = option.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }""",
            value,
        )
        if not selected:
            raise RuntimeError(f"未找到下拉选项: {value}")

    @staticmethod
    def _dom_click(button) -> None:
        button.evaluate("""(el) => {
            el.click();
        }""")

    @staticmethod
    def _button_state(button) -> dict[str, Any]:
        return button.evaluate("""(el) => ({
            text: (el.innerText || el.textContent || '').trim(),
            class_name: String(el.className || ''),
            disabled: !!el.disabled,
        })""")

    def _submit_button_state(self, page: Page) -> str:
        try:
            state = page.evaluate(
                """() => {
                    const submit = document.querySelector('button[data-testid="hosted-payment-submit-button"]') || document.querySelector('button[type="submit"]');
                    if (!submit) return { missing: true };
                    return {
                        text: String(submit.innerText || submit.textContent || '').trim(),
                        className: String(submit.className || ''),
                        disabled: !!submit.disabled,
                    };
                }"""
            )
            return json.dumps(state, ensure_ascii=False)
        except Exception as exc:
            return f"unknown ({exc})"

    @staticmethod
    def _is_alipay_selected(page: Page) -> bool:
        try:
            selected = page.evaluate(
                """() => {
                    const input = document.querySelector('input[value="alipay"]');
                    if (input && input.checked) return true;
                    const byAria = document.querySelector(
                        '[data-testid*="alipay"][aria-checked="true"], button[data-testid*="alipay"][aria-expanded="true"], [id*="alipay"][aria-checked="true"]'
                    );
                    if (byAria) return true;
                    const row = [...document.querySelectorAll('button,label,div,[role="radio"]')]
                        .find((el) => /alipay|支付宝/i.test((el.innerText || el.textContent || '').trim()));
                    if (!row) return false;
                    if (row.getAttribute('aria-checked') === 'true') return true;
                    if (row.getAttribute('aria-selected') === 'true') return true;
                    return false;
                }"""
            )
            if selected:
                return True
        except Exception:
            pass
        return False

    @staticmethod
    def _is_final_alipay_cashier_url(url: str) -> bool:
        value = str(url or "").strip()
        return any(
            marker in value
            for marker in (
                "payauth.alipay.com/",
                "mobilecodec.alipay.com/show.htm",
                "render.alipay.com/p/w/ac-fe-adaptor/",
            )
        )

    @staticmethod
    def _is_stripe_checkout_url(url: str) -> bool:
        return "checkout.stripe.com/" in str(url or "")

    @staticmethod
    def _next_intermediate_alipay_url(*, redirect_url: str, gateway_url: str, fallback_url: str) -> str:
        for value in (redirect_url, gateway_url, fallback_url):
            candidate = str(value or "").strip()
            if not candidate:
                continue
            if WindsurfStripeCheckoutBrowser._is_final_alipay_cashier_url(candidate):
                continue
            if any(
                marker in candidate
                for marker in (
                    "pm-redirects.stripe.com/authorize/",
                    "openapi.alipay.com/gateway.do",
                    "render.alipay.com/",
                )
            ):
                return candidate
        return ""

    @staticmethod
    def _candidate_urls(page: Page) -> list[str]:
        seen: list[str] = []
        for current in list(page.context.pages):
            try:
                url = str(current.url or "").strip()
            except Exception:
                url = ""
            if url and url not in seen:
                seen.append(url)
        return seen

    @staticmethod
    def _page_text(page: Page) -> str:
        try:
            return str(page.locator("body").inner_text(timeout=3000) or "")
        except Exception:
            return ""


class WindsurfBrowserPaymentFlow:
    def __init__(
        self,
        *,
        headless: bool = True,
        proxy: str | None = None,
        log_fn: Callable[[str], None] = print,
    ):
        self.headless = headless
        self.proxy = proxy
        self.log = log_fn

    def generate_checkout_link(
        self,
        *,
        email: str,
        password: str,
        turnstile_token: str = "",
        timeout: int = 180,
    ) -> dict[str, str]:
        token = str(turnstile_token or "").strip()
        if not token and Camoufox is not None:
            try:
                self.log("Step0: 使用 Camoufox 生成 Windsurf Pro Trial Stripe 链接")
                checkout_url = WindsurfCamoufoxCheckoutFlow(
                    headless=self.headless,
                    proxy=self.proxy,
                    log_fn=self.log,
                ).open_checkout(
                    email=email,
                    password=password,
                    turnstile_token="",
                    timeout=timeout,
                )
                return {
                    "url": checkout_url,
                    "cashier_url": checkout_url,
                    "checkout_url": checkout_url,
                    "payment_channel": "checkout",
                    "payment_provider": "stripe",
                }
            except Exception as exc:
                self.log(f"Camoufox 生成 Windsurf Pro Trial Stripe 链接失败，回退到 Playwright: {exc}")
        with sync_playwright() as pw:
            launch_opts = {
                "headless": self.headless,
                "args": ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"],
            }
            proxy = _proxy_config(self.proxy)
            if proxy:
                launch_opts["proxy"] = proxy
            browser = _launch_chromium(pw, launch_opts)
            context = browser.new_context(viewport={"width": 1440, "height": 960}, user_agent=UA, locale="zh-CN")
            context.set_default_timeout(90000)
            page = context.new_page()
            try:
                self._login(page, email=email, password=password)
                checkout_url = self._open_pro_checkout(page, turnstile_token=token, timeout=timeout)
                return {
                    "url": checkout_url,
                    "cashier_url": checkout_url,
                    "checkout_url": checkout_url,
                    "payment_channel": "checkout",
                    "payment_provider": "stripe",
                }
            finally:
                context.close()
                browser.close()

    def run(
        self,
        *,
        email: str,
        password: str,
        turnstile_token: str = "",
        timeout: int = 180,
    ) -> dict[str, str]:
        token = str(turnstile_token or "").strip()
        if not token and Camoufox is not None:
            try:
                self.log("Step0: 使用 Camoufox 尝试通过 Windsurf Turnstile")
                checkout_url = WindsurfCamoufoxCheckoutFlow(
                    headless=self.headless,
                    proxy=self.proxy,
                    log_fn=self.log,
                ).open_checkout(
                    email=email,
                    password=password,
                    turnstile_token="",
                    timeout=timeout,
                )
                billing_name = email.split("@", 1)[0] or "Windsurf User"
                self.log("Step4: Camoufox 已进入 Stripe，继续生成支付宝授权链接")
                return WindsurfStripeCheckoutBrowser(
                    headless=self.headless,
                    proxy=self.proxy,
                    log_fn=self.log,
                ).generate_alipay_link(
                    checkout_url=checkout_url,
                    email=email,
                    billing_name=billing_name,
                    timeout=timeout,
                )
            except Exception as exc:
                self.log(f"Camoufox 进入 Windsurf Pro 失败，回退到 Playwright 流程: {exc}")
        with sync_playwright() as pw:
            launch_opts = {
                "headless": self.headless,
                "args": ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"],
            }
            proxy = _proxy_config(self.proxy)
            if proxy:
                launch_opts["proxy"] = proxy
            browser = _launch_chromium(pw, launch_opts)
            context = browser.new_context(viewport={"width": 1440, "height": 960}, user_agent=UA, locale="zh-CN")
            context.set_default_timeout(90000)
            page = context.new_page()
            try:
                checkout_data: dict[str, str] = {}
                self._login(page, email=email, password=password)
                checkout_url = self._open_pro_checkout(page, turnstile_token=token, timeout=timeout)
                checkout_data["checkout_url"] = checkout_url
                stripe_helper = WindsurfStripeCheckoutBrowser(headless=self.headless, proxy=self.proxy, log_fn=self.log)
                result = stripe_helper._complete_alipay_checkout(
                    page,
                    email=email,
                    billing_name=email.split("@", 1)[0] or "Windsurf User",
                    timeout=timeout,
                )
                final_url = str(result["final_url"] or "").strip()
                confirm_payload = dict(result["confirm_payload"] or {})
                if not final_url:
                    visible_text = stripe_helper._page_text(page)[:500]
                    raise RuntimeError(f"未获取到支付宝授权链接，当前页面: {visible_text}")
                return {
                    **checkout_data,
                    "url": final_url,
                    "cashier_url": final_url,
                    "alipay_url": final_url,
                    "payment_channel": "alipay",
                    "payment_provider": "stripe",
                    "stripe_checkout_state": str(confirm_payload.get("state") or ""),
                    "stripe_checkout_status": str(confirm_payload.get("status") or ""),
                }
            finally:
                context.close()
                browser.close()

    def _login(self, page: Page, *, email: str, password: str) -> None:
        self.log("Step1: 打开 Windsurf 登录页")
        page.goto(f"{WINDSURF_BASE}/account/login", wait_until="networkidle", timeout=90000)
        self._accept_cookies_if_present(page)
        page.locator('input[type="email"]').fill(email)
        page.locator('button[type="submit"]').click()
        page.wait_for_selector('input[name="password"]', state="visible", timeout=90000)
        self.log("Step2: 输入 Windsurf 账号密码")
        page.locator('input[name="password"]').fill(password)
        page.locator('button[type="submit"]').click()
        page.wait_for_url(re.compile(rf"{re.escape(WINDSURF_BASE)}/profile"), timeout=90000)

    def _open_pro_checkout(self, page: Page, *, turnstile_token: str, timeout: int) -> str:
        self.log("Step3: 进入 Pro 升级页面")
        page.get_by_role("link", name=re.compile(r"Upgrade to Pro", re.I)).click()
        page.wait_for_url(re.compile(rf"{re.escape(WINDSURF_BASE)}/pricing"), timeout=90000)
        self._accept_cookies_if_present(page)
        try:
            if _click_start_trial(page, self.log, timeout=45):
                page.wait_for_timeout(3000)
                self.log(f"点击 Start Free Trial 后当前页面: {str(page.url or '')[:160]}")
        except Exception:
            pass
        _handle_turnstile(
            page,
            log_fn=self.log,
            provided_token=str(turnstile_token or "").strip(),
            wait_secs=min(max(int(timeout or 180), 12), 30),
        )
        if "checkout.stripe.com" in str(page.url or ""):
            self.log("Step4: 已从 Windsurf 页面进入 Stripe Checkout")
            return str(page.url or "").strip()
        token = str(turnstile_token or "").strip()
        if not token:
            raise RuntimeError("页面点击 Pro 后仍停留在 pricing，页面内 Turnstile 处理未进入 Stripe，且缺少 turnstile_token 兜底")
        self.log("Step4: 使用 Turnstile token 继续进入 Pro Checkout")
        page.goto(f"{WINDSURF_BASE}/billing/individual?plan=9&turnstile_token={token}", wait_until="domcontentloaded", timeout=90000)
        deadline = time.time() + max(int(timeout or 180), 30)
        while time.time() < deadline:
            current_url = str(page.url or "").strip()
            if "checkout.stripe.com" in current_url:
                return current_url
            page.wait_for_timeout(1000)
        visible_text = WindsurfStripeCheckoutBrowser._page_text(page)[:500]
        raise RuntimeError(f"进入 Stripe Checkout 超时，当前页面: {visible_text}")

    @staticmethod
    def _accept_cookies_if_present(page: Page) -> None:
        for pattern in (
            re.compile(r"Accept all", re.I),
            re.compile(r"接受|同意", re.I),
        ):
            try:
                button = page.get_by_role("button", name=pattern).first
                if button.count() and button.is_visible():
                    button.click(timeout=2000)
                    page.wait_for_timeout(500)
                    return
            except Exception:
                pass


class WindsurfCamoufoxCheckoutFlow(WindsurfBrowserPaymentFlow):
    @staticmethod
    def _add_mouse_event_patch(page: Page) -> None:
        page.add_init_script("""
(function() {
    var screenX = Math.floor(Math.random() * (1200 - 800 + 1)) + 800;
    var screenY = Math.floor(Math.random() * (600 - 400 + 1)) + 400;
    Object.defineProperty(MouseEvent.prototype, 'screenX', {
        get: function() { return this.clientX + screenX; },
        configurable: true
    });
    Object.defineProperty(MouseEvent.prototype, 'screenY', {
        get: function() { return this.clientY + screenY; },
        configurable: true
    });
    Object.defineProperty(PointerEvent.prototype, 'screenX', {
        get: function() { return this.clientX + screenX; },
        configurable: true
    });
    Object.defineProperty(PointerEvent.prototype, 'screenY', {
        get: function() { return this.clientY + screenY; },
        configurable: true
    });
})();
""")

    def open_checkout(
        self,
        *,
        email: str,
        password: str,
        turnstile_token: str = "",
        timeout: int = 180,
    ) -> str:
        if Camoufox is None:
            raise RuntimeError("Camoufox 不可用")
        launch_opts = {"headless": self.headless}
        proxy = _proxy_config(self.proxy)
        if proxy:
            launch_opts["proxy"] = proxy
        with Camoufox(**launch_opts) as browser:
            page = browser.new_page()
            page.set_default_timeout(90000)
            self._add_mouse_event_patch(page)
            self._login(page, email=email, password=password)
            return self._open_pro_checkout(page, turnstile_token=turnstile_token, timeout=timeout)


def generate_alipay_link_in_browser(
    *,
    checkout_url: str,
    email: str,
    billing_name: str,
    timeout: int = 120,
    proxy: str | None = None,
    headless: bool = True,
    log_fn: Callable[[str], None] = print,
) -> dict[str, str]:
    return WindsurfStripeCheckoutBrowser(headless=headless, proxy=proxy, log_fn=log_fn).generate_alipay_link(
        checkout_url=checkout_url,
        email=email,
        billing_name=billing_name,
        timeout=timeout,
    )


def generate_alipay_link_via_windsurf_ui(
    *,
    email: str,
    password: str,
    turnstile_token: str = "",
    timeout: int = 180,
    proxy: str | None = None,
    headless: bool = True,
    log_fn: Callable[[str], None] = print,
) -> dict[str, str]:
    return WindsurfBrowserPaymentFlow(headless=headless, proxy=proxy, log_fn=log_fn).run(
        email=email,
        password=password,
        turnstile_token=turnstile_token,
        timeout=timeout,
    )


def generate_checkout_link_via_windsurf_ui(
    *,
    email: str,
    password: str,
    turnstile_token: str = "",
    timeout: int = 180,
    proxy: str | None = None,
    headless: bool = True,
    log_fn: Callable[[str], None] = print,
) -> dict[str, str]:
    return WindsurfBrowserPaymentFlow(headless=headless, proxy=proxy, log_fn=log_fn).generate_checkout_link(
        email=email,
        password=password,
        turnstile_token=turnstile_token,
        timeout=timeout,
    )
