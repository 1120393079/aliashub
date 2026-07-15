"""
通过浏览器 OAuth 获取 ChatGPT refresh_token（跳过手机验证）。

基于 openai_skip_phone_otp.py 的 Reqable 脚本思路，用 Playwright 的
page.route() 拦截 OpenAI 的 API 响应，实现相同的手机验证跳过逻辑：

1. session/select → 把 add_phone / phone_otp_* 替换为 email_otp_verification
2. email-otp/send → 失败时 302 重定向到 email-verification 页
3. email-otp/validate → 返回假成功响应，直接跳到 consent
4. consent.data → 返回假成功
5. workspace/select → 返回假成功 callback
"""

from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Callable, Optional
from urllib.parse import urljoin

from .constants import OPENAI_AUTH


# ── state 存储（跨请求传递） ──────────────────────────────────
_state_store: dict[str, str] = {}


def setup_oauth_state_capture(page, log: Callable[[str], None] = lambda _: None) -> None:
    """Register a lightweight OAuth state capture route.

    This helper does not modify any OpenAI/Auth response. It only records the
    state query parameter so the surrounding OAuth flow can keep its normal
    server-side behavior.
    """
    _state_store.pop("oauth_state", None)

    def _capture_oauth_state(route):
        try:
            url = route.request.url
            m = re.search(r"state=([^&\s]+)", url)
            if m:
                _state_store["oauth_state"] = m.group(1)
                log(f"  [route] captured OAuth state: {m.group(1)[:20]}...")
        except Exception:
            pass
        route.fallback()

    page.route("**/oauth/authorize*", _capture_oauth_state)
    log("  [route] OAuth state capture ready (no response rewrite)")


def _setup_skip_phone_otp_routes(page, log: Callable[[str], None] = lambda _: None) -> None:
    """在 Playwright page 上设置 route 拦截，跳过手机验证。

    必须在 page.goto 之前调用。直接用 page.route() 拦截所有到
    auth.openai.com 的 API 请求，修改响应体实现与 Reqable 脚本同等的效果。
    """

    def _handle_session_select(route, response):
        """拦截 session/select —— 替换手机验证为邮箱验证"""
        try:
            body = response.body()
            text = body.decode("utf-8", errors="replace")

            # 替换 phone OTP 页面类型 → email_otp_verification
            text = text.replace('"type": "add_phone"', '"type": "email_otp_verification"')
            text = text.replace('"type":"add_phone"', '"type":"email_otp_verification"')
            text = text.replace(
                '"type": "phone_otp_select_channel"', '"type": "email_otp_verification"'
            )
            text = text.replace(
                '"type":"phone_otp_select_channel"', '"type":"email_otp_verification"'
            )
            text = text.replace(
                '"type": "phone_otp_send"', '"type": "email_otp_verification"'
            )
            text = text.replace(
                '"type":"phone_otp_send"', '"type":"email_otp_verification"'
            )

            # 把 continue_url 改为 email-verification 页
            text = re.sub(
                r'"continue_url"\s*:\s*"[^"]*"',
                '"continue_url":"https://auth.openai.com/email-verification"',
                text,
            )
            # 改 POST → GET
            text = text.replace('"method": "POST"', '"method": "GET"')
            text = text.replace('"method":"POST"', '"method":"GET"')
            # 删掉 phone 相关字段
            text = re.sub(r',\s*"multi_channel_allowed"\s*:\s*(?:true|false)', '', text)
            text = re.sub(r',\s*"phone_number"\s*:\s*"[^"]*"', '', text)
            text = re.sub(r',\s*"phone_verification_channel"\s*:\s*"[^"]*"', '', text)

            if text != body.decode("utf-8", errors="replace"):
                log("  [route] session/select: 已替换 phone OTP → email_otp_verification")

            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=text.encode("utf-8"),
            )
        except Exception:
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )

    def _handle_email_otp_send(route, response):
        """拦截 email-otp/send —— 错误时 302 到 email-verification"""
        try:
            if response.status >= 300:
                log(f"  [route] email-otp/send 失败({response.status}) → 302 重定向")
                headers = dict(response.headers)
                headers["Location"] = "https://auth.openai.com/email-verification"
                return route.fulfill(status=302, headers=headers)
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )
        except Exception:
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )

    def _handle_email_otp_validate(route, response):
        """拦截 email-otp/validate —— 返回假成功"""
        try:
            if response.status >= 400:
                log("  [route] email-otp/validate 失败 → 返回假成功")
                fake_body = json.dumps({
                    "continue_url": (
                        "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"
                    ),
                    "method": "GET",
                    "page": {
                        "type": "external_url",
                        "backstack_behavior": "default",
                        "payload": {
                            "url": (
                                "https://auth.openai.com/"
                                "sign-in-with-chatgpt/codex/consent"
                            )
                        },
                    },
                    "oai-client-auth-session": {
                        "email": "user@outlook.com",
                        "name": "User",
                        "workspaces": [{
                            "id": "00000000-0000-0000-0000-000000000000",
                            "name": None,
                            "kind": "personal",
                        }],
                    },
                })
                return route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=fake_body,
                )
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )
        except Exception:
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )

    def _handle_consent_data(route, response):
        """拦截 consent.data —— 返回假成功"""
        try:
            if response.status >= 400:
                log("  [route] consent.data 失败 → 返回假成功")
                return route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body='[{"_1":2},"SIGN_IN_WITH_CHATGPT_CODEX_CONSENT",{"_3":-5},"data"]',
                )
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )
        except Exception:
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )

    def _handle_workspace_select(route, response):
        """拦截 workspace/select —— 提取 state 并返回假成功"""
        try:
            if response.status >= 400:
                state = _state_store.get("oauth_state", "unknown")
                log(f"  [route] workspace/select 失败 → 返回假成功 (state={state[:20]}...)")
                cb_url = (
                    f"http://localhost:1455/auth/callback"
                    f"?code=bypass"
                    f"&scope=openid+profile+email+offline_access"
                    f"+api.connectors.read+api.connectors.invoke"
                    f"&state={state}"
                )
                fake_body = json.dumps({
                    "continue_url": cb_url,
                    "method": "GET",
                    "page": {
                        "type": "external_url",
                        "backstack_behavior": "default",
                        "payload": {"url": cb_url},
                    },
                })
                return route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=fake_body,
                )
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )
        except Exception:
            return route.fulfill(
                status=response.status,
                headers=dict(response.headers),
                body=response.body(),
            )

    def _capture_state(route):
        """拦截 oauth/authorize 请求 —— 提取 state 参数"""
        try:
            url = route.request.url
            m = re.search(r'state=([^&\s]+)', url)
            if m:
                _state_store["oauth_state"] = m.group(1)
        except Exception:
            pass
        route.continue_()

    try:
        # 注册 route handler: 在请求完成后拦截并修改响应
        page.route(
            "**/api/accounts/session/select**",
            lambda route: route.fallback(),
        )
        page.route(
            "**/api/accounts/email-otp/send**",
            lambda route: route.fallback(),
        )
        page.route(
            "**/api/accounts/email-otp/validate**",
            lambda route: route.fallback(),
        )
        page.route(
            "**/consent.data**",
            lambda route: route.fallback(),
        )
        page.route(
            "**/api/accounts/workspace/select**",
            lambda route: route.fallback(),
        )
        page.route(
            "**/oauth/authorize*",
            _capture_state,
        )

        # 用 page.on("response") 拦截响应（Playwright 在 fallback 之后会触发）
        def _on_response(response):
            url = response.url
            try:
                if "/api/accounts/session/select" in url:
                    _modify_response(response, _handle_session_select)
                elif "/api/accounts/email-otp/send" in url:
                    _modify_response(response, _handle_email_otp_send)
                    if response.status >= 300:
                        pass  # route 处理
                elif "/api/accounts/email-otp/validate" in url:
                    _modify_response(response, _handle_email_otp_validate)
                elif "/consent.data" in url and "CONSENT" in url:
                    _modify_response(response, _handle_consent_data)
                elif "/api/accounts/workspace/select" in url:
                    _modify_response(response, _handle_workspace_select)
            except Exception:
                pass

        page.on("response", _on_response)
        log("  [route] 已设置手机验证跳过拦截器")

    except Exception as exc:
        log(f"  [route] 设置拦截器失败: {exc}")


def _modify_response(response, handler) -> None:
    """替换 Playwright response 的 body。

    原理：通过 response.request 重新 fetch 并拦截。
    这里用更简单的方式：不修改已完成的 response，而是注册 route 在
    下次请求时拦截。

    实际上对已发生的请求不能 retroactively 修改，但 Playwright 的
    page.route 是拦截**后续**请求的。对于已经触发的 response，
    我们在 on("response") 中只能读取不能修改。

    解决：改为在 page.route 里用 route.fetch() 先发请求再改响应。
    """
    pass  # 本函数保留为占位——实际拦截在重建的 route handler 里完成


def setup_phone_otp_skip_interception(
    page,
    log: Callable[[str], None] = lambda _: None,
) -> None:
    """设置手机验证跳过的 Playwright route 拦截（主动 fetch + 修改模式）。

    使用 page.route() 拦截所有相关 API URL，内部先 route.fetch() 拿到真实响应，
    再按 openai_skip_phone_otp.py 逻辑修改后 fulfill。
    """

    def _intercept_session_select(route):
        try:
            resp = route.fetch()
            body_bytes = resp.body()
            text = body_bytes.decode("utf-8", errors="replace")
            original = text

            # ★ 将手机验证类型替换为 consent 类型（而非 email_otp_verification，
            # 因为邮箱 OTP 已经在前一步完成了）→ 浏览器直接跳 consent
            for old_type, new_type in [
                ('"type": "add_phone"', '"type": "sign_in_with_chatgpt_codex_consent"'),
                ('"type":"add_phone"', '"type":"sign_in_with_chatgpt_codex_consent"'),
                ('"type": "phone_otp_select_channel"', '"type": "sign_in_with_chatgpt_codex_consent"'),
                ('"type":"phone_otp_select_channel"', '"type":"sign_in_with_chatgpt_codex_consent"'),
                ('"type": "phone_otp_send"', '"type": "sign_in_with_chatgpt_codex_consent"'),
                ('"type":"phone_otp_send"', '"type":"sign_in_with_chatgpt_codex_consent"'),
            ]:
                text = text.replace(old_type, new_type)
            text = re.sub(
                r'"continue_url"\s*:\s*"[^"]*"',
                '"continue_url":"https://auth.openai.com/sign-in-with-chatgpt/codex/consent"',
                text,
            )
            text = re.sub(r',\s*"multi_channel_allowed"\s*:\s*(?:true|false)', '', text)
            text = re.sub(r',\s*"phone_number"\s*:\s*"[^"]*"', '', text)
            text = re.sub(r',\s*"phone_verification_channel"\s*:\s*"[^"]*"', '', text)

            if text != original:
                log("  [拦截] session/select: phone OTP → consent（直接跳过手机验证）")

            route.fulfill(
                status=resp.status,
                headers=dict(resp.headers),
                body=text.encode("utf-8"),
            )
        except Exception as exc:
            log(f"  [拦截] session/select 异常: {exc}")
            route.fallback()

    def _intercept_email_otp_send(route):
        try:
            resp = route.fetch()
            if resp.status >= 300:
                log(f"  [拦截] email-otp/send {resp.status} → 302")
                headers = dict(resp.headers)
                headers["location"] = "https://auth.openai.com/email-verification"
                route.fulfill(status=302, headers=headers)
            else:
                route.fulfill(
                    status=resp.status,
                    headers=dict(resp.headers),
                    body=resp.body(),
                )
        except Exception as exc:
            log(f"  [拦截] email-otp/send 异常: {exc}")
            route.fallback()

    def _intercept_email_otp_validate(route):
        """拦截 email-otp/validate — 不影响正常响应，仅打日志。"""
        try:
            resp = route.fetch()
            body_bytes = resp.body()
            text = body_bytes.decode("utf-8", errors="replace")
            phone_triggers = ["add_phone", "phone_otp_select_channel", "phone_otp_send", "phone-otp", "add-phone"]
            if any(t in text for t in phone_triggers):
                log("  [拦截] email-otp/validate: 检测到 phone 响应（不拦截，让 add_phone skip 逻辑处理）")
            route.fulfill(status=resp.status, headers=dict(resp.headers), body=body_bytes)
        except Exception as exc:
            log(f"  [拦截] email-otp/validate 异常: {exc}")
            route.fallback()

    def _intercept_consent_data(route):
        try:
            resp = route.fetch()
            if resp.status >= 400:
                log("  [拦截] consent.data → 假成功")
                route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body='[{"_1":2},"SIGN_IN_WITH_CHATGPT_CODEX_CONSENT",{"_3":-5},"data"]',
                )
            else:
                route.fulfill(
                    status=resp.status,
                    headers=dict(resp.headers),
                    body=resp.body(),
                )
        except Exception as exc:
            log(f"  [拦截] consent.data 异常: {exc}")
            route.fallback()

    def _intercept_workspace_select(route):
        try:
            resp = route.fetch()
            if resp.status >= 400:
                state = _state_store.get("oauth_state", "unknown")
                log(f"  [拦截] workspace/select → 假成功 (state={state[:20]}...)")
                cb_url = (
                    f"http://localhost:1455/auth/callback"
                    f"?code=bypass"
                    f"&scope=openid+profile+email+offline_access"
                    f"+api.connectors.read+api.connectors.invoke"
                    f"&state={state}"
                )
                fake = json.dumps({
                    "continue_url": cb_url,
                    "method": "GET",
                    "page": {
                        "type": "external_url",
                        "backstack_behavior": "default",
                        "payload": {"url": cb_url},
                    },
                })
                route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=fake,
                )
            else:
                route.fulfill(
                    status=resp.status,
                    headers=dict(resp.headers),
                    body=resp.body(),
                )
        except Exception as exc:
            log(f"  [拦截] workspace/select 异常: {exc}")
            route.fallback()

    # ★ OAuth URL 拦截：捕获 state + 第 2 次起 302 → consent
    _oauth_nav_count = [0]
    def _intercept_oauth_url(route):
        _oauth_nav_count[0] += 1
        try:
            url = route.request.url
            m = re.search(r'state=([^&\s]+)', url)
            if m:
                _state_store["oauth_state"] = m.group(1)
                log(f"  [拦截] 捕获 OAuth state: {m.group(1)[:20]}... (第{_oauth_nav_count[0]}次)")
        except Exception:
            pass
        if _oauth_nav_count[0] > 1:
            # 第二次访问：改成 prompt=none → 已认证 session 可能直接 callback
            new_url = route.request.url.replace("prompt=login", "prompt=none")
            if new_url != route.request.url:
                log("  [拦截] OAuth 重访 → prompt=none（已认证 session 直接 callback）")
                route.fulfill(status=302, headers={"Location": new_url})
            else:
                log("  [拦截] OAuth 重访 → 302 consent")
                route.fulfill(status=302, headers={"Location": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"})
        else:
            route.fallback()

    # ★ Codex consent 页面 HTML 注入</parameter>

    def _intercept_consent_page(route):
        """拦截 consent 页面 HTML，注入 auto-continue JS。"""
        try:
            resp = route.fetch()
            html = resp.body().decode("utf-8", errors="replace")
            inject_js = """
<script>
(function(){var _t=setInterval(function(){
var btns=document.querySelectorAll('button');
for(var i=0;i<btns.length;i++){var b=btns[i];
var r=b.getBoundingClientRect();
if(r.width>0&&r.height>0&&!b.disabled){
var t=(b.textContent||'').toLowerCase();
if(t.includes('continue')||t.includes('authorize')||t.includes('allow')||t.includes('agree')||t.includes('select')||t.indexOf('同意')>-1||t.indexOf('继续')>-1||t.indexOf('授权')>-1||t.indexOf('确认')>-1){
b.click();clearInterval(_t);break;
}}}},2000);setTimeout(function(){clearInterval(_t)},30000);})();
</script>
"""
            html = html.replace("</body>", inject_js + "</body>")
            route.fulfill(status=resp.status, headers=dict(resp.headers), body=html.encode("utf-8"))
            log("  [拦截] consent/workspace 页面已注入 auto-click JS")
        except Exception as exc:
            log(f"  [拦截] consent 页面注入异常: {exc}")
            route.fallback()

    # 注册所有拦截路由
    page.route("**/sign-in-with-chatgpt/codex/consent**", _intercept_consent_page)
    page.route("**/api/accounts/session/select**", _intercept_session_select)
    page.route("**/api/accounts/email-otp/send**", _intercept_email_otp_send)
    page.route("**/api/accounts/email-otp/validate**", _intercept_email_otp_validate)
    page.route("**/consent.data*", _intercept_consent_data)
    page.route("**/api/accounts/workspace/select**", _intercept_workspace_select)
    page.route("**/oauth/authorize*", _intercept_oauth_url)

    log("  [拦截] 手机验证跳过拦截器已就绪（route.fetch + consent/workspace 自动点击 JS 注入）")


# ═══════════════════════════════════════════════════════════════
#  Phone OTP callback — 浏览器 add_phone 验证用
# ═══════════════════════════════════════════════════════════════

class GetRtPhoneCallback:
    """浏览器 add_phone 步骤的手机号 + OTP 回调。

    两种接码渠道：
      - smspool: 租一次性美国号，OpenAI service=671, country=1
      - smsapi:  固定手机号 + 查最新短信 API

    用法::

        cb = GetRtPhoneCallback(
            provider="smspool",
            smspool_api_key="...",
        )
        phone = cb()      # → "+12345678901"
        otp   = cb()      # → "456789"
        cb.cleanup()      # 释放号码
    """

    def __init__(
        self,
        *,
        provider: str = "smspool",
        smspool_api_key: str = "",
        smspool_max_price: str = "0.13",
        smsapi_phone: str = "",
        smsapi_url: str = "",
        log_fn=None,
    ):
        self._provider = str(provider or "smspool").strip().lower()
        self._smspool_api_key = str(smspool_api_key or "").strip()
        self._smspool_max_price = str(smspool_max_price or "0.13").strip()
        self._smsapi_phone = str(smsapi_phone or "").strip()
        self._smsapi_url = str(smsapi_url or "").strip()
        self.log = log_fn or (lambda _: None)

        self._channel = None
        self._aid: str = ""          # activation ID / order ID
        self._phone: str = ""        # E.164 phone number
        self._phase = "need_number"
        self._completed = False
        self._resend_callback = None
        self._last_error = ""

    # ── public lifecycle (mirrors PhoneCallbackController) ─────

    @property
    def phase(self):
        return self._phase

    @phase.setter
    def phase(self, value):
        self._phase = str(value or "")

    @property
    def activation(self):
        return None  # not used; kept for compatibility

    @activation.setter
    def activation(self, value):
        pass

    @property
    def completed(self):
        return self._completed

    @completed.setter
    def completed(self, value):
        self._completed = bool(value)

    def set_resend_callback(self, cb):
        self._resend_callback = cb

    def mark_send_failed(self, reason: str = ""):
        self._last_error = str(reason or "")
        self.log(f"  [phone-cb] send failed: {self._last_error[:120]}")

    def mark_send_succeeded(self):
        self.log("  [phone-cb] send succeeded")

    def mark_code_failed(self, reason: str = ""):
        self._last_error = str(reason or "")
        self.log(f"  [phone-cb] code failed: {self._last_error[:120]}")

    def report_success(self):
        if not self._completed:
            self._completed = True
            self._phase = "done"
            self.log(f"  [phone-cb] success, phone={self._phone}")
        if self._channel and self._aid and hasattr(self._channel, "done"):
            try:
                self._channel.done(self._aid)
            except Exception:
                pass

    def cleanup(self):
        if not self._completed and self._channel and self._aid:
            try:
                self._channel.cancel(self._aid)
                self.log(f"  [phone-cb] cleaned up: {self._aid}")
            except Exception:
                pass

    # ── __call__ ──────────────────────────────────────────────

    def __call__(self) -> str:
        if self._phase == "need_number":
            return self._rent_number()
        if self._phase == "need_code":
            return self._wait_code()
        return ""

    # ── internal ──────────────────────────────────────────────

    def _rent_number(self) -> str:
        if self._provider == "smsapi":
            self._channel, self._phone, self._aid = self._build_smsapi()
        else:
            self._channel, self._phone, self._aid = self._build_smspool()

        if not self._phone:
            raise RuntimeError(f"获取rt: {self._provider} 获取手机号失败")
        self._phase = "need_code"
        self.log(f"  [phone-cb] 手机号已获取: {self._phone} (aid={self._aid})")
        return self._phone

    def _wait_code(self) -> str:
        import time as _time
        deadline = _time.monotonic() + 180
        while _time.monotonic() < deadline:
            try:
                code = self._channel.wait_code(self._aid, timeout=30)
                if code:
                    self.log(f"  [phone-cb] 收到验证码: {code}")
                    return code
            except Exception as exc:
                self.log(f"  [phone-cb] wait_code 异常: {exc}")
            _time.sleep(3)
        raise RuntimeError(f"获取rt: {self._provider} 等短信验证码超时 (3min)")

    def _build_smspool(self):
        from platforms.gopay.sms_channel import SmsPoolChannel, SMSPOOL_DEFAULT_API_KEY

        api_key = self._smspool_api_key or SMSPOOL_DEFAULT_API_KEY
        channel = SmsPoolChannel(
            api_key=api_key,
            country="1",                  # United States
            service="671",                # OpenAI / ChatGPT
            max_price=self._smspool_max_price,
        )
        self.log(f"  [phone-cb] SMSPool 购号: country=1 service=671 max_price={self._smspool_max_price}")
        phone, aid = channel.get_number()
        if not phone or not aid:
            raise RuntimeError(
                f"SMSPool 购号失败 (service=671 country=1 max_price={self._smspool_max_price})"
            )
        return channel, phone, aid

    def _build_smsapi(self):
        from platforms.gopay.sms_channel import SmsApiChannel

        if "----" in self._smsapi_phone:
            phone_part, url_part = self._smsapi_phone.split("----", 1)
            phone = phone_part.strip()
            url = url_part.strip() or self._smsapi_url
        else:
            phone = self._smsapi_phone
            url = self._smsapi_url

        if not phone:
            raise RuntimeError("smsapi 手机号为空")
        if not url:
            raise RuntimeError("smsapi 查询 URL 为空")

        channel = SmsApiChannel(url=url, phone=phone)
        channel.prime()  # 基线当前最新短信时间
        aid = phone  # smsapi 用 phone 本身当 aid
        return channel, phone, aid


def build_get_rt_phone_callback(
    *,
    sms_provider: str = "",
    smspool_api_key: str = "",
    smspool_max_price: str = "0.13",
    smsapi_phone: str = "",
    smsapi_url: str = "",
    log_fn=None,
):
    """便捷工厂：从 SMS 配置参数构建 GetRtPhoneCallback，未配置时返回 (None, reason)。"""
    provider = str(sms_provider or "").strip().lower()

    if provider == "smspool":
        from platforms.gopay.sms_channel import SMSPOOL_DEFAULT_API_KEY
        key = smspool_api_key.strip() or SMSPOOL_DEFAULT_API_KEY
        if not key:
            return None, "smspool API key 为空"
        return GetRtPhoneCallback(
            provider="smspool",
            smspool_api_key=key,
            smspool_max_price=str(smspool_max_price or "0.13").strip(),
            log_fn=log_fn,
        ), ""

    if provider == "smsapi":
        phone = str(smsapi_phone or "").strip()
        url = str(smsapi_url or "").strip()
        if "----" in phone:
            phone_part, url_part = phone.split("----", 1)
            phone = phone_part.strip()
            url = url_part.strip() or url
        if not phone:
            return None, "smsapi 手机号为空"
        if not url:
            return None, "smsapi 查询 URL 为空"
        return GetRtPhoneCallback(
            provider="smsapi",
            smsapi_phone=phone,
            smsapi_url=url,
            log_fn=log_fn,
        ), ""

    # 无配置：不提供 phone callback，add_phone 将报错
    return None, "未配置 SMS（sms_provider 为空）"


def _parse_smsapi_phone_entries(smsapi_phone: str, smsapi_url: str = "") -> list[str]:
    entries: list[str] = []
    default_url = str(smsapi_url or "").strip()
    for raw_line in re.split(r"[\r\n]+", str(smsapi_phone or "")):
        line = raw_line.strip()
        if not line:
            continue
        if "----" in line:
            phone_part, url_part = line.split("----", 1)
            phone = phone_part.strip()
            url = url_part.strip() or default_url
            if phone and url:
                entries.append(f"{phone}----{url}")
            elif phone:
                entries.append(phone)
            continue
        if default_url:
            entries.append(f"{line}----{default_url}")
        else:
            entries.append(line)
    return entries


class _GetRtPhoneLease:
    def __init__(self, *, lease_id: int, provider: str, channel, phone: str, aid: str, max_uses: int):
        self.lease_id = lease_id
        self.provider = provider
        self.channel = channel
        self.phone = phone
        self.aid = aid
        self.max_uses = max_uses
        self.completed_uses = 0
        self.in_use = False
        self.retired = False
        self.last_code = ""

    @property
    def next_use_no(self) -> int:
        return self.completed_uses + 1

    def prepare_for_use(self, log: Callable[[str], None]) -> None:
        if self.completed_uses <= 0 or not hasattr(self.channel, "request_another"):
            return
        try:
            ok = bool(self.channel.request_another(self.aid))
        except Exception as exc:
            log(f"  [phone-pool] request another failed phone={self.phone}: {exc}")
            ok = False
        if ok:
            log(f"  [phone-pool] reuse phone={self.phone} use={self.next_use_no}/{self.max_uses}")
        else:
            log(
                f"  [phone-pool] reuse phone={self.phone} without resend ack "
                f"use={self.next_use_no}/{self.max_uses}"
            )

    def wait_code(self, log: Callable[[str], None]) -> str:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                try:
                    code = self.channel.wait_code(
                        self.aid,
                        timeout=30,
                        ignore_code=self.last_code or None,
                    )
                except TypeError:
                    code = self.channel.wait_code(self.aid, timeout=30)
                if code:
                    self.last_code = str(code)
                    log(f"  [phone-pool] received code phone={self.phone} code={code}")
                    return str(code)
            except Exception as exc:
                log(f"  [phone-pool] wait_code failed phone={self.phone}: {exc}")
            time.sleep(3)
        raise RuntimeError(f"get_rt: {self.provider} wait sms otp timeout (3min)")

    def close_success(self) -> None:
        if hasattr(self.channel, "done"):
            try:
                self.channel.done(self.aid)
            except Exception:
                pass

    def close_failure(self) -> None:
        if self.completed_uses > 0:
            self.close_success()
            return
        if hasattr(self.channel, "cancel"):
            try:
                self.channel.cancel(self.aid)
            except Exception:
                pass


class GetRtPhoneReusePool:
    """Task-level phone lease pool for batch get_rt.

    A lease is assigned to one account at a time. After a successful account,
    the same phone can be reused by the next account until ``reuse_count``
    successes are reached, then the lease is closed and a fresh phone is used.
    """

    def __init__(
        self,
        *,
        provider: str,
        reuse_count: int = 3,
        smspool_api_key: str = "",
        smspool_max_price: str = "0.13",
        smsapi_phone: str = "",
        smsapi_url: str = "",
        log_fn=None,
    ):
        self.provider = str(provider or "").strip().lower()
        self.reuse_count = max(int(reuse_count or 3), 3)
        self.smspool_api_key = str(smspool_api_key or "").strip()
        self.smspool_max_price = str(smspool_max_price or "0.13").strip()
        self.smsapi_entries = _parse_smsapi_phone_entries(smsapi_phone, smsapi_url)
        self.smsapi_url = str(smsapi_url or "").strip()
        self.log = log_fn or (lambda _: None)
        self._lock = threading.RLock()
        self._leases: list[_GetRtPhoneLease] = []
        self._next_lease_id = 1
        self._next_smsapi_index = 0

    def make_callback(self, *, label: str = ""):
        return GetRtReusablePhoneCallback(self, label=label)

    def acquire(self, *, label: str = "") -> _GetRtPhoneLease:
        with self._lock:
            lease = self._find_available_locked()
            if lease is None:
                lease = self._create_lease_locked()
                self._leases.append(lease)
            lease.in_use = True
            use_no = lease.next_use_no

        try:
            lease.prepare_for_use(self.log)
        except Exception:
            self.report_failure(lease)
            raise

        self.log(
            f"  [phone-pool] assigned phone={lease.phone} "
            f"use={use_no}/{lease.max_uses} task={label or '-'}"
        )
        return lease

    def report_success(self, lease: _GetRtPhoneLease | None) -> None:
        if lease is None:
            return
        close_lease = False
        with self._lock:
            if lease.retired:
                return
            lease.completed_uses += 1
            lease.in_use = False
            if lease.completed_uses >= lease.max_uses:
                lease.retired = True
                close_lease = True
        self.log(
            f"  [phone-pool] success phone={lease.phone} "
            f"count={lease.completed_uses}/{lease.max_uses}"
        )
        if close_lease:
            lease.close_success()
            self.log(f"  [phone-pool] phone exhausted, closed: {lease.phone}")

    def report_failure(self, lease: _GetRtPhoneLease | None) -> None:
        if lease is None:
            return
        should_close = False
        with self._lock:
            if not lease.retired:
                lease.retired = True
                should_close = True
            lease.in_use = False
        if should_close:
            lease.close_failure()
            self.log(f"  [phone-pool] phone retired after failure: {lease.phone}")

    def cleanup(self) -> None:
        leases_to_close: list[_GetRtPhoneLease] = []
        with self._lock:
            for lease in self._leases:
                if lease.retired:
                    continue
                lease.retired = True
                lease.in_use = False
                leases_to_close.append(lease)
        for lease in leases_to_close:
            if lease.completed_uses > 0:
                lease.close_success()
            else:
                lease.close_failure()
            self.log(f"  [phone-pool] cleanup phone={lease.phone}")

    def _find_available_locked(self) -> _GetRtPhoneLease | None:
        for lease in self._leases:
            if lease.retired or lease.in_use:
                continue
            if lease.completed_uses >= lease.max_uses:
                lease.retired = True
                continue
            return lease
        return None

    def _create_lease_locked(self) -> _GetRtPhoneLease:
        lease_id = self._next_lease_id
        self._next_lease_id += 1
        if self.provider == "smsapi":
            if not self.smsapi_entries:
                raise RuntimeError("smsapi phone list is empty")
            if self._next_smsapi_index >= len(self.smsapi_entries):
                raise RuntimeError(
                    "smsapi phone list exhausted; add more +phone----URL lines "
                    f"or lower concurrency/total accounts (reuse_count={self.reuse_count})"
                )
            entry = self.smsapi_entries[self._next_smsapi_index]
            self._next_smsapi_index += 1
            builder = GetRtPhoneCallback(
                provider="smsapi",
                smsapi_phone=entry,
                smsapi_url=self.smsapi_url,
                log_fn=self.log,
            )
            channel, phone, aid = builder._build_smsapi()
        else:
            builder = GetRtPhoneCallback(
                provider="smspool",
                smspool_api_key=self.smspool_api_key,
                smspool_max_price=self.smspool_max_price,
                log_fn=self.log,
            )
            channel, phone, aid = builder._build_smspool()
        if not phone or not aid:
            raise RuntimeError(f"get_rt: {self.provider} failed to get phone")
        self.log(f"  [phone-pool] new phone lease#{lease_id}: {phone} (aid={aid})")
        return _GetRtPhoneLease(
            lease_id=lease_id,
            provider=self.provider,
            channel=channel,
            phone=phone,
            aid=aid,
            max_uses=self.reuse_count,
        )


class GetRtReusablePhoneCallback:
    def __init__(self, pool: GetRtPhoneReusePool, *, label: str = ""):
        self._pool = pool
        self._label = label
        self._lease: _GetRtPhoneLease | None = None
        self._phase = "need_number"
        self._completed = False
        self._resend_callback = None
        self._last_error = ""

    @property
    def phase(self):
        return self._phase

    @phase.setter
    def phase(self, value):
        self._phase = str(value or "")
        if self._phase == "need_number":
            self._lease = None
            self._completed = False

    @property
    def activation(self):
        return None

    @activation.setter
    def activation(self, value):
        pass

    @property
    def completed(self):
        return self._completed

    @completed.setter
    def completed(self, value):
        self._completed = bool(value)

    def set_resend_callback(self, cb):
        self._resend_callback = cb

    def mark_send_failed(self, reason: str = ""):
        self._last_error = str(reason or "")
        self._pool.log(f"  [phone-pool] send failed: {self._last_error[:120]}")

    def mark_send_succeeded(self):
        self._pool.log("  [phone-pool] send succeeded")

    def mark_code_failed(self, reason: str = ""):
        self._last_error = str(reason or "")
        self._pool.log(f"  [phone-pool] code failed: {self._last_error[:120]}")

    def __call__(self) -> str:
        if self._phase == "need_number":
            self._lease = self._pool.acquire(label=self._label)
            self._phase = "need_code"
            return self._lease.phone
        if self._phase == "need_code":
            if not self._lease:
                raise RuntimeError("get_rt phone lease missing")
            return self._lease.wait_code(self._pool.log)
        return ""

    def report_success(self):
        if self._completed:
            return
        self._completed = True
        self._phase = "done"
        self._pool.report_success(self._lease)

    def cleanup(self):
        if self._completed:
            return
        self._pool.report_failure(self._lease)
        self._lease = None
        self._phase = "need_number"


def build_get_rt_phone_reuse_pool(
    *,
    sms_provider: str = "",
    smspool_api_key: str = "",
    smspool_max_price: str = "0.13",
    smsapi_phone: str = "",
    smsapi_url: str = "",
    reuse_count: int = 3,
    log_fn=None,
):
    provider = str(sms_provider or "").strip().lower()
    if not provider:
        return None, "sms_provider is empty"
    if provider == "smspool":
        from platforms.gopay.sms_channel import SMSPOOL_DEFAULT_API_KEY

        key = str(smspool_api_key or "").strip() or SMSPOOL_DEFAULT_API_KEY
        if not key:
            return None, "smspool API key is empty"
        return GetRtPhoneReusePool(
            provider="smspool",
            reuse_count=reuse_count,
            smspool_api_key=key,
            smspool_max_price=str(smspool_max_price or "0.13").strip(),
            log_fn=log_fn,
        ), ""
    if provider == "smsapi":
        entries = _parse_smsapi_phone_entries(smsapi_phone, smsapi_url)
        if not entries:
            return None, "smsapi phone is empty"
        missing_url = [
            entry for entry in entries
            if "----" not in entry and not str(smsapi_url or "").strip()
        ]
        if missing_url:
            return None, "smsapi query URL is empty"
        return GetRtPhoneReusePool(
            provider="smsapi",
            reuse_count=reuse_count,
            smsapi_phone="\n".join(entries),
            smsapi_url=str(smsapi_url or "").strip(),
            log_fn=log_fn,
        ), ""
    return None, f"unsupported sms_provider: {provider}"
