from __future__ import annotations

from types import SimpleNamespace

import pytest

from core.base_platform import RegisterConfig
from platforms.chatgpt import browser_register as browser_register_module
from platforms.chatgpt.plugin import (
    ChatGPTPlatform,
    _assert_complete_oauth_callback,
    _generate_chatgpt_registration_password,
)


class _SessionApiResponse:
    status = 200

    def text(self):
        return (
            '{"accessToken":"at_123","user":{"email":"user@example.com"},'
            '"expires":"2026-05-20T12:00:00Z"}'
        )


class _UnreadableSessionApiResponse:
    status = 200

    def text(self):
        raise RuntimeError("Response body is unavailable for redirect responses")


def test_assert_complete_oauth_callback_accepts_complete_payload():
    _assert_complete_oauth_callback({
        "account_id": "acct_123",
        "access_token": "at_123",
        "refresh_token": "rt_123",
        "id_token": "id_123",
    })


def test_assert_complete_oauth_callback_rejects_partial_payload():
    with pytest.raises(RuntimeError, match="OAuth callback"):
        _assert_complete_oauth_callback({
            "account_id": "acct_123",
            "access_token": "",
            "refresh_token": "",
            "id_token": "",
        })


def test_generate_chatgpt_registration_password_meets_openai_strength_requirements():
    for _ in range(8):
        password = _generate_chatgpt_registration_password()
        assert len(password) >= 12
        assert any(ch.islower() for ch in password)
        assert any(ch.isupper() for ch in password)
        assert any(ch.isdigit() for ch in password)
        assert any(ch in ",._!@#" for ch in password)


def test_auth_timeout_retry_text_detects_openai_retry_page():
    text = "Oops, an error occurred! Operation timed out Try again Terms of Use"

    assert browser_register_module._is_auth_timeout_retry_text(text) is True


def test_auth_timeout_retry_text_ignores_plain_try_again_copy():
    assert browser_register_module._is_auth_timeout_retry_text("Try again later") is False


def test_chatgpt_platform_preserves_user_supplied_password():
    platform = object.__new__(ChatGPTPlatform)
    assert platform._prepare_registration_password("Secret123!") == "Secret123!"


def test_chatgpt_platform_does_not_pre_generate_password():
    platform = object.__new__(ChatGPTPlatform)
    assert platform._prepare_registration_password(None) is None


def test_codex_oauth_empty_password_uses_mailbox_otp_passwordless_login(monkeypatch):
    from platforms.chatgpt import oauth as oauth_module

    oauth_start = SimpleNamespace(
        auth_url="https://auth.openai.com/oauth/authorize?state=state_test",
        state="state_test",
    )
    page = SimpleNamespace(
        url=oauth_start.auth_url,
        evaluate=lambda script: "Mozilla/5.0 Test",
    )
    phase = {"value": "password"}
    events = []

    def otp_callback():
        events.append("otp")
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: events.append(("baseline", strict))

    monkeypatch.setattr(oauth_module, "generate_oauth_url", lambda **kwargs: oauth_start)
    monkeypatch.setattr(
        browser_register_module,
        "_goto_with_retry",
        lambda page, url, **kwargs: setattr(page, "url", url),
    )
    monkeypatch.setattr(browser_register_module, "_get_page_oauth_url", lambda page: "")

    def derive_state(page):
        if phase["value"] == "password":
            return {"page_type": "login_password", "continue_url": "", "current_url": page.url}
        return {"page_type": "email_otp_verification", "continue_url": "", "current_url": page.url}

    monkeypatch.setattr(browser_register_module, "_derive_oauth_state_from_page", derive_state)

    def click_passwordless(page, log, *, context):
        events.append(("passwordless", context))
        phase["value"] = "otp"
        page.url = "https://auth.openai.com/email-verification"
        return True

    monkeypatch.setattr(
        browser_register_module,
        "_click_passwordless_login_if_available",
        click_passwordless,
    )
    monkeypatch.setattr(
        browser_register_module,
        "_submit_oauth_password_direct",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("empty password was submitted")),
    )

    def submit_otp(page, code, log):
        events.append(("submit", code))
        page.url = "http://localhost:1455/auth/callback?code=code_test&state=state_test"
        return {"ok": True, "status": 200, "url": page.url, "data": None, "text": ""}

    monkeypatch.setattr(browser_register_module, "_submit_otp_via_page", submit_otp)
    monkeypatch.setattr(
        browser_register_module,
        "_submit_callback_result",
        lambda callback_url, oauth_start, proxy: {
            "access_token": "at_test",
            "account_id": "acct_test",
        },
    )

    result = browser_register_module._do_codex_oauth(
        page,
        {},
        "passwordless@test.com",
        "",
        otp_callback,
        None,
        None,
        lambda message: None,
    )

    assert result["access_token"] == "at_test"
    assert events == [
        ("baseline", True),
        ("passwordless", "OAuth 密码页"),
        "otp",
        ("submit", "123456"),
    ]


def test_protocol_mailbox_mapper_rejects_partial_oauth_result():
    platform = object.__new__(ChatGPTPlatform)
    platform.mailbox = None
    platform.config = RegisterConfig()
    adapter = ChatGPTPlatform.build_protocol_mailbox_adapter(platform)
    ctx = SimpleNamespace(password="Secret123!", proxy=None, log=lambda message: None)
    result = SimpleNamespace(
        email="user@example.com",
        password="Secret123!",
        account_id="acct_123",
        access_token="",
        refresh_token="",
        id_token="",
        session_token="sess_123",
        workspace_id="",
    )

    with pytest.raises(RuntimeError, match="OAuth callback"):
        adapter.result_mapper(ctx, result)


def test_browser_registration_mapper_accepts_completed_registration_without_codex_tokens():
    platform = object.__new__(ChatGPTPlatform)

    mapped = platform._map_chatgpt_result({
        "email": "user@example.com",
        "password": "Secret123!",
        "password_set": True,
        "password_status": "configured",
        "password_source": "signup_required",
        "account_id": "",
        "access_token": "",
        "refresh_token": "",
        "id_token": "",
        "session_token": "",
        "workspace_id": "",
        "cookies": "{\"login_session\":\"yes\"}",
        "profile": {},
    })

    assert mapped.email == "user@example.com"
    assert mapped.password == "Secret123!"
    assert mapped.user_id == ""
    assert mapped.token == ""
    assert mapped.extra["access_token"] == ""
    assert mapped.extra["cookies"] == "{\"login_session\":\"yes\"}"


def test_browser_oauth_adapter_still_requires_complete_oauth_result():
    platform = object.__new__(ChatGPTPlatform)
    adapter = ChatGPTPlatform.build_browser_registration_adapter(platform)
    ctx = SimpleNamespace(identity=SimpleNamespace(identity_provider="oauth_browser"))

    with pytest.raises(RuntimeError, match="OAuth callback"):
        adapter.result_mapper(ctx, {
            "email": "user@example.com",
            "account_id": "",
            "access_token": "",
        })


def test_fetch_chatgpt_session_opens_session_api_directly():
    calls = []

    class FakePage:
        context = SimpleNamespace(cookies=lambda: [
            {"name": "__Secure-next-auth.session-token", "value": "sess_123"},
            {"name": "oai-did", "value": "did_123"},
        ])

        def goto(self, url, **kwargs):
            calls.append((url, kwargs))
            return _SessionApiResponse()

    logs = []

    result = browser_register_module._fetch_chatgpt_session_from_page(
        FakePage(),
        {"login_session": "yes"},
        logs.append,
        timeout=5,
    )

    assert calls[0][0] == "https://chatgpt.com/api/auth/session"
    assert "chatgpt.com/api/auth/session" in logs[0]
    assert result["access_token"] == "at_123"
    assert result["session_token"] == "sess_123"
    assert result["cookies"] == "login_session=yes; __Secure-next-auth.session-token=sess_123; oai-did=did_123"


def test_fetch_chatgpt_session_uses_same_origin_fetch_before_navigation():
    calls = {"evaluate": 0, "goto": 0}

    class FakePage:
        url = "https://chatgpt.com/"
        context = SimpleNamespace(cookies=lambda: [
            {"name": "__Secure-next-auth.session-token", "value": "sess_123"},
        ])

        def evaluate(self, script, arg=None):
            calls["evaluate"] += 1
            assert arg == "https://chatgpt.com/api/auth/session"
            return {
                "status": 200,
                "url": "https://chatgpt.com/api/auth/session",
                "text": (
                    '{"accessToken":"at_fetch","user":{"email":"user@example.com"},'
                    '"expires":"2026-05-20T12:00:00Z"}'
                ),
            }

        def goto(self, url, **kwargs):
            calls["goto"] += 1
            raise AssertionError("same-origin session fetch should avoid navigation")

    result = browser_register_module._fetch_chatgpt_session_from_page(
        FakePage(),
        {},
        lambda message: None,
        timeout=5,
    )

    assert calls == {"evaluate": 1, "goto": 0}
    assert result["access_token"] == "at_fetch"
    assert result["session_token"] == "sess_123"


def test_fetch_chatgpt_session_falls_back_to_page_body_when_response_text_unavailable(monkeypatch):
    times = iter([100.0, 101.0, 106.0])
    monkeypatch.setattr(browser_register_module.time, "time", lambda: next(times))
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda seconds: None)

    class FakeBody:
        def inner_text(self, timeout=3000):
            return (
                '{"accessToken":"at_from_body","user":{"email":"user@example.com"},'
                '"expires":"2026-05-20T12:00:00Z"}'
            )

    class FakePage:
        url = "https://chatgpt.com/api/auth/session"
        context = SimpleNamespace(cookies=lambda: [
            {"name": "__Secure-next-auth.session-token", "value": "sess_123"},
        ])

        def goto(self, url, **kwargs):
            self.url = url
            return _UnreadableSessionApiResponse()

        def locator(self, selector):
            assert selector == "body"
            return FakeBody()

    result = browser_register_module._fetch_chatgpt_session_from_page(
        FakePage(),
        {},
        lambda message: None,
        timeout=5,
    )

    assert result["access_token"] == "at_from_body"
    assert result["session_token"] == "sess_123"


def test_browser_registration_flow_starts_from_chatgpt_nextauth(monkeypatch):
    calls = {}

    class FakePage:
        url = "about:blank"
        context = SimpleNamespace(cookies=lambda: [
            {"name": "login_session", "value": "yes"},
        ])

        def evaluate(self, script, *args):
            return "Mozilla/5.0"

    def start_via_authorize(page, email, device_id, log):
        calls["authorize"] = (email, device_id)
        page.url = "https://chatgpt.com/api/auth/callback/openai?code=abc"
        return {"page_type": "oauth_callback", "current_url": page.url}

    def fail_via_page(*args, **kwargs):
        calls["page"] = True
        raise AssertionError("browser registration should start from ChatGPT NextAuth")

    monkeypatch.setattr(browser_register_module, "_seed_browser_device_id", lambda page, device_id: calls.setdefault("seed", device_id))
    monkeypatch.setattr(browser_register_module, "_start_browser_signup_via_authorize", start_via_authorize)
    monkeypatch.setattr(browser_register_module, "_start_browser_signup_via_page", fail_via_page)
    monkeypatch.setattr(
        browser_register_module,
        "_handle_post_signup_onboarding",
        lambda page, log: {"post_signup_ready": True},
    )

    state = browser_register_module._browser_registration_flow(
        FakePage(),
        "user@example.com",
        "Secret123!",
        otp_callback=None,
        phone_callback=None,
        log=lambda message: None,
    )

    assert calls["authorize"][0] == "user@example.com"
    assert calls["authorize"][1] == calls["seed"]
    assert "page" not in calls
    assert state["page_type"] == "oauth_callback"
    assert state["post_signup_ready"] is True


@pytest.mark.parametrize(
    "dom_error",
    [
        "验证码页未找到可填写输入框",
        "验证码页未找到 Continue 按钮",
    ],
)
def test_browser_registration_otp_dom_failure_uses_same_context_api_fallback(
    monkeypatch,
    dom_error,
):
    class FakePage:
        def __init__(self):
            self.url = "https://auth.openai.com/email-verification"
            self.context = SimpleNamespace(
                cookies=lambda: [{"name": "login_session", "value": "yes"}],
            )

        def evaluate(self, script, *args):
            return "Mozilla/5.0 Test"

    page = FakePage()
    logs = []
    dumps = []
    fallback_calls = []
    monkeypatch.setattr(browser_register_module, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(
        browser_register_module,
        "_start_browser_signup_via_authorize",
        lambda *args: {
            "page_type": "email_otp_verification",
            "current_url": page.url,
        },
    )
    monkeypatch.setattr(
        browser_register_module,
        "_submit_otp_via_page",
        lambda *args, **kwargs: {
            "ok": False,
            "status": 0,
            "url": page.url,
            "data": None,
            "text": dom_error,
        },
    )

    def validate(page_arg, code, device_id, user_agent, referer):
        fallback_calls.append((page_arg, code, device_id, user_agent, referer))
        return {
            "ok": True,
            "status": 200,
            "url": "https://auth.openai.com/api/accounts/email-otp/validate",
            "data": {
                "page": {"type": "about_you"},
                "continue_url": "/about-you",
            },
            "text": "",
        }

    monkeypatch.setattr(browser_register_module, "_validate_browser_email_otp", validate)
    monkeypatch.setattr(
        browser_register_module,
        "_dump_debug",
        lambda page_arg, prefix: dumps.append((page_arg, prefix)),
    )
    monkeypatch.setattr(
        browser_register_module,
        "_goto_with_retry",
        lambda page_arg, url, **kwargs: setattr(page_arg, "url", url),
    )

    def submit_about(page_arg, log):
        page_arg.url = "https://chatgpt.com/"
        return {"ok": True, "status": 200, "url": page_arg.url, "data": None, "text": ""}

    monkeypatch.setattr(browser_register_module, "_submit_about_you_via_page", submit_about)
    monkeypatch.setattr(
        browser_register_module,
        "_handle_post_signup_onboarding",
        lambda *args, **kwargs: {"post_signup_ready": True},
    )

    result = browser_register_module._browser_registration_flow(
        page,
        "user@example.com",
        "",
        otp_callback=lambda: "123456",
        phone_callback=None,
        log=logs.append,
    )

    assert result["page_type"] == "chatgpt_home"
    assert fallback_calls[0][0] is page
    assert fallback_calls[0][1] == "123456"
    assert fallback_calls[0][3] == "Mozilla/5.0 Test"
    assert fallback_calls[0][4] == "https://auth.openai.com/email-verification"
    assert dumps == [(page, "chatgpt_registration_otp_dom_missing")]
    assert any("同一浏览器会话 API" in message for message in logs)
    assert any("page=about_you" in message for message in logs)


def test_browser_registration_otp_api_fallback_requires_a_later_state(monkeypatch):
    page = SimpleNamespace(
        url="https://auth.openai.com/email-verification",
        context=SimpleNamespace(cookies=lambda: []),
        evaluate=lambda *args: "Mozilla/5.0 Test",
    )
    monkeypatch.setattr(browser_register_module, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(
        browser_register_module,
        "_start_browser_signup_via_authorize",
        lambda *args: {
            "page_type": "email_otp_verification",
            "current_url": page.url,
        },
    )
    monkeypatch.setattr(
        browser_register_module,
        "_submit_otp_via_page",
        lambda *args, **kwargs: {
            "ok": False,
            "status": 0,
            "url": page.url,
            "data": None,
            "text": "验证码页未找到可填写输入框",
        },
    )
    monkeypatch.setattr(
        browser_register_module,
        "_validate_browser_email_otp",
        lambda *args, **kwargs: {
            "ok": True,
            "status": 200,
            "url": "https://auth.openai.com/api/accounts/email-otp/validate",
            "data": {},
            "text": "",
        },
    )
    monkeypatch.setattr(browser_register_module, "_dump_debug", lambda *args: None)

    with pytest.raises(RuntimeError, match="校验响应未返回后续注册状态"):
        browser_register_module._browser_registration_flow(
            page,
            "user@example.com",
            "",
            otp_callback=lambda: "123456",
            phone_callback=None,
            log=lambda message: None,
        )


def test_browser_registration_otp_rejection_does_not_use_api_fallback(monkeypatch):
    page = SimpleNamespace(
        url="https://auth.openai.com/email-verification",
        context=SimpleNamespace(cookies=lambda: []),
        evaluate=lambda *args: "Mozilla/5.0 Test",
    )
    fallback_calls = []
    monkeypatch.setattr(browser_register_module, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(
        browser_register_module,
        "_start_browser_signup_via_authorize",
        lambda *args: {
            "page_type": "email_otp_verification",
            "current_url": page.url,
        },
    )
    monkeypatch.setattr(
        browser_register_module,
        "_submit_otp_via_page",
        lambda *args, **kwargs: {
            "ok": False,
            "status": 400,
            "url": page.url,
            "data": {"error": {"message": "Invalid code"}},
            "text": "Invalid code",
        },
    )
    monkeypatch.setattr(
        browser_register_module,
        "_validate_browser_email_otp",
        lambda *args, **kwargs: fallback_calls.append(True),
    )

    with pytest.raises(RuntimeError, match="Invalid code"):
        browser_register_module._browser_registration_flow(
            page,
            "user@example.com",
            "",
            otp_callback=lambda: "123456",
            phone_callback=None,
            log=lambda message: None,
        )

    assert fallback_calls == []


def test_post_signup_legal_gate_clicks_language_independent_button_and_waits_for_app(monkeypatch):
    clicks = []
    snapshots = [
        {
            "legal_gate": True,
            "app_ready": False,
            "questionnaire": False,
            "body_text": "準備が完了しました",
        },
        {
            "legal_gate": False,
            "app_ready": True,
            "questionnaire": False,
            "app_marker": "#prompt-textarea",
            "body_text": "",
        },
    ]

    class FakePage:
        url = "https://chatgpt.com/"

        def evaluate(self, script):
            if "const explicit" in script:
                assert "innerText" not in script
                clicks.append("continue")
                return "button"
            return snapshots.pop(0) if len(snapshots) > 1 else snapshots[0]

    logs = []
    monkeypatch.setattr(browser_register_module, "_click_first", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda seconds: None)

    result = browser_register_module._handle_post_signup_onboarding(FakePage(), logs.append, timeout=2)

    assert clicks == ["continue"]
    assert result == {
        "post_signup_ready": True,
        "post_signup_gate_handled": True,
        "post_signup_app_marker": "#prompt-textarea",
    }
    assert any("准备完成页面继续按钮" in message for message in logs)


def test_post_signup_legal_gate_must_disappear_after_continue(monkeypatch):
    class FakePage:
        url = "https://chatgpt.com/"

        def evaluate(self, script):
            if "const explicit" in script:
                return "button"
            return {
                "legal_gate": True,
                "app_ready": False,
                "questionnaire": False,
                "body_text": "Ready gate still visible",
            }

    dumped = []
    monkeypatch.setattr(browser_register_module, "_click_first", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(browser_register_module, "_dump_debug", lambda page, prefix: dumped.append(prefix))

    with pytest.raises(RuntimeError, match="点击继续后未消失"):
        browser_register_module._handle_post_signup_onboarding(FakePage(), lambda message: None, timeout=2)

    assert dumped == ["chatgpt_post_signup_gate_stuck"]


def test_browser_registration_email_only_stops_when_phone_is_required(monkeypatch):
    class FakePage:
        url = "https://auth.openai.com/add-phone"
        context = SimpleNamespace(cookies=lambda: [{"name": "login_session", "value": "yes"}])

        def evaluate(self, script, *args):
            return "Mozilla/5.0"

    monkeypatch.setattr(browser_register_module, "_seed_browser_device_id", lambda page, device_id: None)
    monkeypatch.setattr(
        browser_register_module,
        "_start_browser_signup_via_authorize",
        lambda page, email, device_id, log: {
            "page_type": "add_phone",
            "current_url": page.url,
        },
    )

    with pytest.raises(RuntimeError, match="仅邮箱注册模式停止"):
        browser_register_module._browser_registration_flow(
            FakePage(),
            "user@example.com",
            "Secret123!",
            otp_callback=None,
            phone_callback=None,
            log=lambda message: None,
        )


def test_browser_register_run_returns_after_registration_without_codex_oauth(monkeypatch):
    class FakePage:
        def __init__(self):
            self.url = "about:blank"
            self.context = None

        def goto(self, url, **kwargs):
            self.url = url

    class FakeContext:
        def cookies(self):
            return []

        def clear_cookies(self):
            return None

        def new_page(self):
            page = FakePage()
            page.context = self
            return page

    class FakeBrowser:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def new_context(self, **kwargs):
            assert kwargs == {"no_viewport": True}
            return FakeContext()

    called = {"oauth": False}

    def fail_if_oauth_runs(self, email, password):
        called["oauth"] = True
        raise AssertionError("Codex OAuth should not run after browser registration")

    monkeypatch.setattr(browser_register_module, "Camoufox", lambda **kwargs: FakeBrowser())
    monkeypatch.setattr(
        browser_register_module,
        "_browser_registration_flow",
        lambda *args, **kwargs: {"page_type": "chatgpt_home", "post_signup_ready": True},
    )
    monkeypatch.setattr(browser_register_module, "_click_first", lambda page, selectors, timeout=3: setattr(page, "url", "https://auth.openai.com/log-in") or selectors[0])
    monkeypatch.setattr(
        browser_register_module,
        "_get_cookies",
        lambda page: {"login_session": "yes", "__Secure-next-auth.session-token": "sess_123"},
    )
    monkeypatch.setattr(
        browser_register_module,
        "_fetch_chatgpt_session_from_page",
        lambda page, cookies, log: {
            "access_token": "at_123",
            "refresh_token": "",
            "id_token": "",
            "session_token": "sess_123",
            "account_id": "acct_123",
            "workspace_id": "",
            "profile": {"email": "user@example.com"},
            "expires_at": "2026-05-20T12:00:00Z",
            "cookies": "__Secure-next-auth.session-token=sess_123; login_session=yes",
        },
        raising=False,
    )
    monkeypatch.setattr(browser_register_module, "_do_codex_oauth", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module.ChatGPTBrowserRegister, "_retry_oauth_fresh_browser", fail_if_oauth_runs)
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        browser_register_module,
        "_apply_regional_fingerprint",
        lambda launch_opts, proxy, log: {
            "ip": "203.0.113.9",
            "country_code": "US",
            "country_name": "United States",
            "locale": "en-US",
            "language": "en",
            "timezone": "America/New_York",
        },
    )

    worker = browser_register_module.ChatGPTBrowserRegister(
        headless=True,
        proxy=None,
        otp_callback=None,
        log_fn=lambda message: None,
    )

    result = worker.run(email="user@example.com", password="Secret123!")

    assert called["oauth"] is False
    assert result["email"] == "user@example.com"
    assert result["password"] == ""
    assert result["password_set"] is False
    assert result["password_status"] == "not_configured"
    assert result["password_source"] == "none"
    assert result["access_token"] == "at_123"
    assert result["account_id"] == "acct_123"
    assert result["session_token"] == "sess_123"
    assert result["cookies"] == "__Secure-next-auth.session-token=sess_123; login_session=yes"


def test_browser_register_patches_playwright_before_opening_camoufox(monkeypatch):
    from platforms.chatgpt import payment as payment_module

    events = []
    monkeypatch.setattr(
        payment_module,
        "_patch_playwright_firefox_pageerror_location_bug",
        lambda **kwargs: events.append("patch"),
    )
    monkeypatch.setattr(
        browser_register_module,
        "open_browser_backend",
        lambda **kwargs: events.append("open") or object(),
    )
    worker = browser_register_module.ChatGPTBrowserRegister(
        headless=True,
        log_fn=lambda message: None,
    )

    worker._open_browser({"headless": True})

    assert events == ["patch", "open"]


def test_about_you_ukrainian_age_field_is_classified_by_stable_dom_attributes():
    entries = [
        {
            "visibleIndex": 0,
            "type": "text",
            "name": "name",
            "id": "name",
            "labels": ["Повне ім’я"],
        },
        {
            "visibleIndex": 1,
            "type": "number",
            "name": "age",
            "id": "age",
            "labels": ["Вік"],
        },
    ]

    name_entry = browser_register_module._pick_best_about_you_input(entries, "name")
    age_entry = browser_register_module._pick_best_about_you_input(
        entries,
        "age",
        exclude_visible_indices={0},
    )

    assert name_entry["visibleIndex"] == 0
    assert age_entry["visibleIndex"] == 1
    assert browser_register_module._classify_about_you_mode(
        has_age_label=False,
        has_birthday_label=False,
        has_age_field=bool(age_entry),
        has_birthday_field=False,
        has_birthday_select=False,
    ) == "age"


def test_about_you_age_uses_completed_birthday_not_only_birth_year():
    today = browser_register_module.date(2026, 7, 13)
    assert browser_register_module._age_on_date("2000-07-12", today) == 26
    assert browser_register_module._age_on_date("2000-07-14", today) == 25


def test_reallocated_japan_proxy_uses_actual_country_locale_not_registered_owner(monkeypatch):
    class _Reader:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def city(self, ip):
            assert ip == "203.0.113.12"
            return SimpleNamespace(
                country=SimpleNamespace(iso_code="JP", name="Japan"),
                registered_country=SimpleNamespace(iso_code="UA", name="Ukraine"),
                location=SimpleNamespace(
                    time_zone="Asia/Tokyo",
                    latitude=35.68,
                    longitude=139.76,
                ),
            )

    import geoip2.database

    monkeypatch.setattr(geoip2.database, "Reader", lambda _path: _Reader())
    monkeypatch.setattr(
        browser_register_module,
        "_dominant_locale_for_country",
        lambda _country_code: ("ja-JP", "ja"),
    )

    profile = browser_register_module._region_profile_for_ip("203.0.113.12")

    assert profile["country_code"] == "JP"
    assert profile["locale"] == "ja-JP"
    assert profile["language"] == "ja"
    assert profile["timezone"] == "Asia/Tokyo"


def test_regional_fingerprint_uses_specific_exit_ip_and_matching_locale(monkeypatch):
    monkeypatch.setattr(browser_register_module, "_detect_public_ip", lambda proxy: "203.0.113.9")
    monkeypatch.setattr(
        browser_register_module,
        "_region_profile_for_ip",
        lambda ip: {
            "ip": ip,
            "country_code": "JP",
            "country_name": "Japan",
            "locale": "ja-JP",
            "language": "ja",
            "timezone": "Asia/Tokyo",
            "latitude": 35.68,
            "longitude": 139.76,
        },
    )
    logs = []
    proxy = {"server": "http://proxy.example:8080", "username": "user", "password": "secret"}
    launch_opts = {"block_webrtc": True}

    profile = browser_register_module._apply_regional_fingerprint(launch_opts, proxy, logs.append)

    assert profile["country_code"] == "JP"
    assert launch_opts["proxy"] == proxy
    assert launch_opts["geoip"] == "203.0.113.9"
    assert launch_opts["locale"] == ["ja-JP", "ja"]
    assert all("secret" not in message for message in logs)
