from __future__ import annotations

from types import SimpleNamespace

import pytest

from application.tasks import _coerce_chatgpt_password_settings_executor
from core.base_platform import Account, RegisterConfig
from core.registration.helpers import build_otp_callback
from platforms.chatgpt import browser_register
from platforms.chatgpt.plugin import ChatGPTPlatform
from platforms.chatgpt.protocol_mailbox import ChatGPTProtocolMailboxWorker


class _FlowPage:
    def __init__(self, url: str = "about:blank"):
        self.url = url
        self.context = SimpleNamespace(cookies=lambda: [])

    def evaluate(self, script, *args):
        return "Mozilla/5.0"


def _reauth_evidence(
    email: str = "user@example.com",
    mode: str = "add",
):
    transaction_id = "test-password-reauth-transaction"
    return browser_register._PasswordReauthEvidence(
        original_email=email,
        transaction_id=transaction_id,
        expected_auth_origin=browser_register._url_origin("https://auth.openai.com"),
        button_dispatch_marker=f"password-reauth-button:{transaction_id}",
        mode=mode,
    )


def _session_evidence(
    email: str = "user@example.com",
    account_id: str = "acct_123",
):
    return browser_register._PasswordSessionEvidence(
        original_email=email,
        account_id=account_id,
    )


def _password_row_snapshot(
    *,
    configured: bool = False,
    ready: bool = True,
    row_visible: bool | None = None,
    row_disabled: bool = False,
    testid: str | None = None,
    tag_name: str = "button",
    button_type: str = "button",
):
    return {
        "ready": ready,
        "row_visible": ready if row_visible is None else row_visible,
        "row_disabled": row_disabled,
        "testid": ("password-setting" if ready else "") if testid is None else testid,
        "tag_name": tag_name,
        "button_type": button_type,
        "configured": configured,
        "text": "Password ******" if configured else "Password Add",
    }


def test_otp_only_registration_never_generates_or_returns_password(monkeypatch):
    page = _FlowPage()
    generated = []

    def start(page, email, device_id, log):
        page.url = "https://chatgpt.com/"
        return {"page_type": "chatgpt_home", "current_url": page.url}

    monkeypatch.setattr(browser_register, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(browser_register, "_start_browser_signup_via_authorize", start)
    monkeypatch.setattr(
        browser_register,
        "_handle_post_signup_onboarding",
        lambda page, log: {"post_signup_ready": True},
    )

    result = browser_register._browser_registration_flow(
        page,
        "user@example.com",
        "",
        otp_callback=None,
        phone_callback=None,
        log=lambda message: None,
        password_factory=lambda: generated.append(True) or "Candidate123!",
    )

    assert generated == []
    assert result["password"] == ""
    assert result["password_set"] is False
    assert result["password_status"] == "not_configured"
    assert result["password_source"] == "none"


def test_signup_password_page_generates_and_marks_real_password(monkeypatch):
    page = _FlowPage("https://auth.openai.com/create-account/password")
    generated = []
    submitted = []

    monkeypatch.setattr(browser_register, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(
        browser_register,
        "_start_browser_signup_via_authorize",
        lambda page, email, device_id, log: {
            "page_type": "create_account_password",
            "current_url": page.url,
        },
    )

    def submit_password(page, password, log):
        submitted.append(password)
        page.url = "https://chatgpt.com/"
        return {"ok": True, "status": 200, "url": page.url, "data": None, "text": ""}

    monkeypatch.setattr(browser_register, "_submit_password_via_page", submit_password)
    monkeypatch.setattr(
        browser_register,
        "_extract_flow_state",
        lambda data, url: {"page_type": "chatgpt_home", "current_url": url},
    )
    monkeypatch.setattr(
        browser_register,
        "_handle_post_signup_onboarding",
        lambda page, log: {"post_signup_ready": True},
    )

    result = browser_register._browser_registration_flow(
        page,
        "user@example.com",
        "",
        otp_callback=None,
        phone_callback=None,
        log=lambda message: None,
        password_factory=lambda: generated.append(True) or "Generated123!",
    )

    assert generated == [True]
    assert submitted == ["Generated123!"]
    assert result["password"] == "Generated123!"
    assert result["password_set"] is True
    assert result["password_status"] == "configured"
    assert result["password_source"] == "signup_required"


def test_security_reauth_uses_original_email_before_ui_click(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    events = []

    def otp_callback():
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: events.append(("refresh", strict))

    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: events.append("open") or _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda page, action, **kwargs: action == "add")

    def start_nextauth(page, email, log, **kwargs):
        events.append(("nextauth", email))
        page.url = "https://auth.openai.com/email-verification"
        return _reauth_evidence(email)

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)
    monkeypatch.setattr(
        browser_register,
        "_click_first_no_wait",
        lambda *args, **kwargs: events.append("click") or "unexpected",
    )

    browser_register._trigger_password_settings_reauth(
        page,
        "original-account@example.com",
        otp_callback,
        lambda message: None,
    )

    assert events == [
        ("refresh", True),
        "open",
        ("nextauth", "original-account@example.com"),
    ]


def test_security_reauth_fails_closed_when_nextauth_does_not_start(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    events = []

    def otp_callback():
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: events.append(("refresh", strict))
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda page, action, **kwargs: action == "add")

    def start_nextauth(page, email, log, **kwargs):
        events.append(("nextauth", email))
        return False

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)
    monkeypatch.setattr(
        browser_register,
        "_click_first_no_wait",
        lambda *args, **kwargs: events.append("click") or "unexpected",
    )

    with pytest.raises(RuntimeError, match="按钮点击前未启动"):
        browser_register._trigger_password_settings_reauth(
            page,
            "original-account@example.com",
            otp_callback,
            lambda message: None,
        )

    assert events == [
        ("refresh", True),
        ("nextauth", "original-account@example.com"),
    ]


def test_security_reauth_nextauth_start_still_requires_expected_url(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    clicked = []

    def otp_callback():
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda page, action, **kwargs: action == "add")
    monkeypatch.setattr(
        browser_register,
        "_start_password_reauth_via_nextauth",
        lambda page, email, *args, **kwargs: _reauth_evidence(email),
    )
    monkeypatch.setattr(
        browser_register,
        "_click_first_no_wait",
        lambda *args, **kwargs: clicked.append(True) or "unexpected",
    )
    monkeypatch.setattr(browser_register, "PASSWORD_REAUTH_REDIRECT_TIMEOUT_SECONDS", 0)

    with pytest.raises(RuntimeError, match="Security 密码重新认证启动后未进入"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )

    assert clicked == []


def test_security_reauth_rejects_foreign_terminal_url_without_ui_click(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    clicked = []

    def otp_callback():
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda page, action, **kwargs: action == "add")

    def start_nextauth(page, email, log, **kwargs):
        page.url = "https://auth.openai.com.evil.test/email-verification"
        return _reauth_evidence(email)

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)
    monkeypatch.setattr(
        browser_register,
        "_click_first_no_wait",
        lambda *args, **kwargs: clicked.append(True) or "unexpected",
    )

    with pytest.raises(RuntimeError, match=r"不受信任页面 \(foreign_origin\)"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )

    assert clicked == []


@pytest.mark.parametrize(
    "transition_url",
    [
        "https://auth.openai.com/api/accounts/authorize?state=changed",
        "https://auth.openai.com/api/accounts/reauth?state=changed",
        "https://auth.openai.com/internal/opaque-hop/v4?state=changed",
    ],
)
def test_security_reauth_allows_same_origin_opaque_multi_hop(
    monkeypatch,
    transition_url,
):
    page = _FlowPage("https://chatgpt.com/#settings/Security")

    def otp_callback():
        raise AssertionError("trigger must only wait for the OTP landing")

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda *args, **kwargs: True)

    def start_nextauth(page, email, log, **kwargs):
        page.url = transition_url
        return _reauth_evidence(email)

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)
    monkeypatch.setattr(
        browser_register,
        "_cancelable_sleep",
        lambda *args, **kwargs: setattr(
            page,
            "url",
            "https://auth.openai.com/email-verification",
        ),
    )

    browser_register._trigger_password_settings_reauth(
        page,
        "user@example.com",
        otp_callback,
        lambda message: None,
    )

    assert page.url == "https://auth.openai.com/email-verification"


def test_security_reauth_rejects_direct_new_password_without_second_email_otp(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")

    def otp_callback():
        raise AssertionError("direct new-password must not bypass the second OTP")

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda *args, **kwargs: True)

    def start_nextauth(page, email, log, **kwargs):
        page.url = "https://auth.openai.com/reset-password/new-password"
        return _reauth_evidence(email)

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)

    with pytest.raises(RuntimeError, match="未经原邮箱验证"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )


@pytest.mark.parametrize(
    "drift_url",
    [
        "https://auth.openai.com/oauth/consent",
        "https://auth.openai.com/workspace/select",
        "https://auth.openai.com/api/organization/select",
        "https://auth.openai.com/sign-in-with-chatgpt/consent",
    ],
)
def test_password_reauth_known_drift_fails_before_otp_or_password(
    monkeypatch,
    drift_url,
):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    otp_calls = []
    otp_submits = []
    password_fills = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda *args, **kwargs: True)

    def start_nextauth(page, email, log, **kwargs):
        page.url = drift_url
        return _reauth_evidence(email)

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)
    monkeypatch.setattr(
        browser_register,
        "_submit_otp_via_page",
        lambda *args, **kwargs: otp_submits.append(True),
    )
    monkeypatch.setattr(
        browser_register,
        "_submit_new_password_via_page",
        lambda *args, **kwargs: password_fills.append(True),
    )

    with pytest.raises(RuntimeError, match=r"不受信任页面 \(forbidden\)"):
        browser_register._set_password_from_security_settings(
            page,
            "user@example.com",
            "Configured123!",
            otp_callback,
            lambda message: None,
        )

    assert otp_calls == []
    assert otp_submits == []
    assert password_fills == []


def test_security_reauth_does_not_click_ui_when_nextauth_raises(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    clicked = []

    def otp_callback():
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda page, action, **kwargs: action == "add")
    monkeypatch.setattr(
        browser_register,
        "_start_password_reauth_via_nextauth",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("sensitive upstream detail")),
    )
    monkeypatch.setattr(
        browser_register,
        "_click_first_no_wait",
        lambda *args, **kwargs: clicked.append(True) or "unexpected",
    )

    with pytest.raises(RuntimeError, match="启动状态不确定") as caught:
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )

    assert str(caught.value) == "Security NextAuth 启动状态不确定，已停止 UI 回退"
    assert isinstance(caught.value.__cause__, RuntimeError)
    assert clicked == []


def test_security_reauth_preserves_password_settings_timeout(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    clicked = []

    def otp_callback():
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda page, action, **kwargs: action == "add")
    monkeypatch.setattr(
        browser_register,
        "_start_password_reauth_via_nextauth",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            browser_register.PasswordSettingsTimeout("注册后设置密码超时")
        ),
    )
    monkeypatch.setattr(
        browser_register,
        "_click_first_no_wait",
        lambda *args, **kwargs: clicked.append(True) or "unexpected",
    )

    with pytest.raises(browser_register.PasswordSettingsTimeout, match="注册后设置密码超时"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )

    assert clicked == []


def test_security_reauth_uncertain_exact_button_click_never_retries_or_falls_back(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    button_clicks = []
    fetch_posts = []
    fallback_clicks = []

    def otp_callback():
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda page, action, **kwargs: True,
    )
    def browser_fetch(page, url, **kwargs):
        if kwargs.get("method") == "POST":
            fetch_posts.append(True)
        return {"ok": True, "data": {}}

    monkeypatch.setattr(browser_register, "_browser_fetch", browser_fetch)

    def click(selector, **kwargs):
        button_clicks.append((selector, kwargs))
        raise RuntimeError("click dispatch state unknown")

    page.click = click
    monkeypatch.setattr(
        browser_register,
        "_click_first_no_wait",
        lambda *args, **kwargs: fallback_clicks.append(True) or "unexpected",
    )

    with pytest.raises(RuntimeError, match="启动状态不确定"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )

    assert len(button_clicks) == 1
    assert button_clicks[0][0] == browser_register.PASSWORD_SETTING_SELECTOR
    assert fetch_posts == []
    assert fallback_clicks == []


def test_security_nextauth_official_click_uses_no_fetch_or_form(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    button_clicks = []
    fetch_calls = []
    form_calls = []
    page.click = lambda selector, **kwargs: button_clicks.append((selector, kwargs))
    page.evaluate = lambda *args, **kwargs: form_calls.append(True)
    monkeypatch.setattr(
        browser_register,
        "_browser_fetch",
        lambda *args, **kwargs: fetch_calls.append(True),
    )

    evidence = browser_register._start_password_reauth_via_nextauth(
        page,
        "user@example.com",
        lambda message: None,
    )

    assert isinstance(evidence, browser_register._PasswordReauthEvidence)
    assert len(button_clicks) == 1
    assert button_clicks[0][0] == browser_register.PASSWORD_SETTING_SELECTOR
    assert button_clicks[0][1]["no_wait_after"] is True
    assert fetch_calls == []
    assert form_calls == []


def test_browser_csrf_json_token_has_priority_over_cookie(monkeypatch):
    class Context:
        def cookies(self):
            raise AssertionError("cookie fallback must not run when JSON has a token")

    page = _FlowPage()
    page.context = Context()
    monkeypatch.setattr(
        browser_register,
        "_browser_fetch",
        lambda *args, **kwargs: {
            "ok": True,
            "data": {"csrfToken": "json-csrf-token"},
        },
    )

    assert browser_register._get_browser_csrf_token(page) == "json-csrf-token"


@pytest.mark.parametrize(
    ("cookie_name", "cookie_value", "expected"),
    [
        (
            "__Host-next-auth.csrf-token",
            "host-cookie-token%7Ccookie-hash",
            "host-cookie-token",
        ),
        (
            "__Secure-next-auth.csrf-token",
            "secure-cookie-token|cookie-hash",
            "secure-cookie-token",
        ),
        (
            "next-auth.csrf-token",
            "plain-cookie-token%257Ccookie-hash",
            "plain-cookie-token",
        ),
    ],
)
def test_browser_csrf_uses_same_context_cookie_fallback(
    monkeypatch,
    cookie_name,
    cookie_value,
    expected,
):
    page = _FlowPage()
    page.context = SimpleNamespace(
        cookies=lambda: [{"name": cookie_name, "value": cookie_value}],
    )
    monkeypatch.setattr(
        browser_register,
        "_browser_fetch",
        lambda *args, **kwargs: {"ok": True, "data": {"csrfToken": ""}},
    )

    assert browser_register._get_browser_csrf_token(page) == expected


def test_browser_csrf_cookie_token_helper_has_no_logging_side_effect(monkeypatch):
    secret_token = "secret-cookie-csrf"
    secret_hash = "secret-cookie-hash"
    logs = []
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    page.context = SimpleNamespace(
        cookies=lambda: [
            {
                "name": "__Host-next-auth.csrf-token",
                "value": f"{secret_token}%7C{secret_hash}",
            },
            {"name": "oai-did", "value": "device-id"},
        ],
    )

    def browser_fetch(page, url, **kwargs):
        assert kwargs.get("method") == "GET"
        return {"ok": True, "data": {}}

    monkeypatch.setattr(browser_register, "_browser_fetch", browser_fetch)

    token = browser_register._get_browser_csrf_token(page)

    assert token == secret_token
    assert logs == []
    assert all(secret_token not in message for message in logs)
    assert all(secret_hash not in message for message in logs)


def test_security_nextauth_clicks_exact_password_setting_once(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    clicks = []
    logs = []
    page.click = lambda selector, **kwargs: clicks.append((selector, kwargs))

    evidence = browser_register._start_password_reauth_via_nextauth(
        page,
        "original-account@example.com",
        logs.append,
    )
    assert evidence.original_email == "original-account@example.com"
    assert evidence.transaction_id
    assert evidence.expected_auth_origin == ("https", "auth.openai.com", 443)
    assert evidence.button_dispatch_marker == f"password-reauth-button:{evidence.transaction_id}"
    assert len(clicks) == 1
    selector, kwargs = clicks[0]
    assert selector == '[data-testid="password-setting"]'
    assert kwargs["no_wait_after"] is True
    assert 1 <= kwargs["timeout"] <= 3000
    assert all("original-account@example.com" not in message for message in logs)


def test_security_official_click_follows_dynamic_auth_path_to_email_verification(monkeypatch):
    class Page(_FlowPage):
        def __init__(self):
            super().__init__("https://chatgpt.com/#settings/Security")
            self.handlers = []
            self.clicks = []

        def on(self, event, handler):
            assert event == "response"
            self.handlers.append(handler)

        def remove_listener(self, event, handler):
            self.handlers.remove(handler)

        def click(self, selector, **kwargs):
            self.clicks.append((selector, kwargs))
            response = SimpleNamespace(
                url="https://chatgpt.com/api/auth/signin/openai?secret=query-secret",
                status=200,
                request=SimpleNamespace(method="POST"),
            )
            for handler in list(self.handlers):
                handler(response)
            self.url = "https://auth.openai.com/internal/password-reauth/v3?state=opaque"

        def wait_for_timeout(self, timeout):
            self.url = "https://auth.openai.com/email-verification"

    page = Page()
    logs = []

    def otp_callback():
        raise AssertionError("trigger must stop at the email verification landing")

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda *args, **kwargs: True)

    browser_register._trigger_password_settings_reauth(
        page,
        "original-account@example.com",
        otp_callback,
        logs.append,
    )

    assert len(page.clicks) == 1
    assert page.clicks[0][0] == browser_register.PASSWORD_SETTING_SELECTOR
    assert page.url == "https://auth.openai.com/email-verification"
    assert "Security NextAuth signin POST status=200" in logs
    assert all("query-secret" not in message for message in logs)
    assert page.handlers == []


def test_security_signin_431_fails_safely_after_one_official_click(monkeypatch):
    class Page(_FlowPage):
        def __init__(self):
            super().__init__("https://chatgpt.com/#settings/Security")
            self.handlers = []
            self.clicks = []
            self.form_calls = []

        def on(self, event, handler):
            self.handlers.append(handler)

        def remove_listener(self, event, handler):
            self.handlers.remove(handler)

        def click(self, selector, **kwargs):
            self.clicks.append((selector, kwargs))
            response = SimpleNamespace(
                url="https://chatgpt.com/api/auth/signin/openai?secret=signin-query",
                status=431,
                request=SimpleNamespace(method="POST"),
            )
            for handler in list(self.handlers):
                handler(response)
            self.url = "https://chatgpt.com/"

        def evaluate(self, *args, **kwargs):
            self.form_calls.append(True)

    page = Page()
    logs = []
    otp_calls = []
    fetch_calls = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        browser_register,
        "_browser_fetch",
        lambda *args, **kwargs: fetch_calls.append(True),
    )

    with pytest.raises(RuntimeError, match="signin POST HTTP 431"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            logs.append,
        )

    assert len(page.clicks) == 1
    assert page.clicks[0][0] == browser_register.PASSWORD_SETTING_SELECTOR
    assert otp_calls == []
    assert fetch_calls == []
    assert page.form_calls == []
    assert "Security NextAuth signin POST status=431" in logs
    assert all("signin-query" not in message for message in logs)
    assert page.handlers == []


def test_security_nextauth_button_click_exception_is_not_retried(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    clicks = []
    logs = []

    def click(selector, **kwargs):
        clicks.append((selector, kwargs))
        raise RuntimeError("click failed after uncertain browser state")

    page.click = click

    with pytest.raises(RuntimeError, match="按钮单次点击状态不确定"):
        browser_register._start_password_reauth_via_nextauth(
            page,
            "user@example.com",
            logs.append,
        )

    assert len(clicks) == 1
    assert logs == []


def test_security_reauth_unavailable_eligibility_requires_verified_evidence(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    otp_calls = []
    started = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda page, action, **kwargs: None,
    )
    monkeypatch.setattr(
        browser_register,
        "_start_password_reauth_via_nextauth",
        lambda page, email, *args, **kwargs: started.append(True) or _reauth_evidence(email),
    )

    with pytest.raises(RuntimeError, match="无法确认当前账号具备添加密码资格"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )

    assert started == []
    assert otp_calls == []


def test_security_reauth_allows_unavailable_eligibility_with_verified_evidence(monkeypatch):
    email = "verified-user@example.com"
    account_id = "acct_sensitive_123"
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    logs = []
    starts = []
    otp_calls = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda page, action, **kwargs: None,
    )

    def start_nextauth(page, original_email, log, **kwargs):
        starts.append(original_email)
        page.url = "https://auth.openai.com/email-verification"
        return _reauth_evidence(original_email)

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)

    browser_register._trigger_password_settings_reauth(
        page,
        email,
        otp_callback,
        logs.append,
        session_evidence=_session_evidence(email, account_id),
    )

    assert starts == [email]
    assert otp_calls == []
    assert any("资格接口不可用" in message for message in logs)
    assert all(email not in message for message in logs)
    assert all(account_id not in message for message in logs)


def test_security_reauth_explicit_false_eligibility_still_rejects(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    starts = []
    otp_calls = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda page, action, **kwargs: False,
    )
    monkeypatch.setattr(
        browser_register,
        "_start_password_reauth_via_nextauth",
        lambda *args, **kwargs: starts.append(True),
    )

    with pytest.raises(RuntimeError, match="明确拒绝"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
            session_evidence=_session_evidence(),
        )

    assert starts == []
    assert otp_calls == []


@pytest.mark.parametrize(
    ("snapshot", "error"),
    [
        (_password_row_snapshot(ready=False), "未找到可验证的密码设置项"),
        (
            _password_row_snapshot(row_visible=False),
            "未找到可验证的密码设置项",
        ),
        (
            _password_row_snapshot(row_disabled=True),
            "未找到可验证的密码设置项",
        ),
        (
            _password_row_snapshot(testid="other-setting"),
            "未找到可验证的密码设置项",
        ),
        (
            _password_row_snapshot(tag_name="div"),
            "未找到可验证的密码设置项",
        ),
        (
            _password_row_snapshot(button_type="submit"),
            "未找到可验证的密码设置项",
        ),
    ],
)
def test_security_reauth_unavailable_eligibility_still_requires_valid_row(
    monkeypatch,
    snapshot,
    error,
):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    eligibility_calls = []
    starts = []
    otp_calls = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: dict(snapshot),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda *args, **kwargs: eligibility_calls.append(True),
    )
    monkeypatch.setattr(
        browser_register,
        "_start_password_reauth_via_nextauth",
        lambda *args, **kwargs: starts.append(True),
    )

    with pytest.raises(RuntimeError, match=error):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
            session_evidence=_session_evidence(),
        )

    assert eligibility_calls == []
    assert starts == []
    assert otp_calls == []


def test_security_configured_row_uses_change_mode_and_exact_button(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")
    eligibility_calls = []
    starts = []

    def otp_callback():
        raise AssertionError("trigger must stop at email verification landing")

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(configured=True),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda page, action, **kwargs: eligibility_calls.append(action) or True,
    )

    def start(page, email, log, **kwargs):
        starts.append(kwargs.get("mode"))
        page.url = "https://auth.openai.com/email-verification"
        return _reauth_evidence(email, mode=kwargs.get("mode"))

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start)

    mode = browser_register._trigger_password_settings_reauth(
        page,
        "user@example.com",
        otp_callback,
        lambda message: None,
        session_evidence=_session_evidence(),
    )

    assert mode == "change"
    assert eligibility_calls == ["change"]
    assert starts == ["change"]


def test_security_reauth_rejects_signup_email_verification(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")

    def otp_callback():
        raise AssertionError("generic signup OTP must not be requested")

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda page, action, **kwargs: True,
    )

    def start_nextauth(page, email, log, **kwargs):
        page.url = "https://auth.openai.com/email-verification?screen_hint=signup"
        return _reauth_evidence(email)

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)

    with pytest.raises(RuntimeError, match=r"不受信任页面 \(forbidden\)"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )


def test_security_reauth_rejects_mismatched_transaction_email(monkeypatch):
    page = _FlowPage("https://chatgpt.com/#settings/Security")

    def otp_callback():
        raise AssertionError("mismatched lineage must not request OTP")

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log, **kwargs: _password_row_snapshot(),
    )
    monkeypatch.setattr(
        browser_register,
        "_password_eligibility",
        lambda page, action, **kwargs: True,
    )

    def start_nextauth(page, email, log, **kwargs):
        page.url = "https://auth.openai.com/email-verification"
        return _reauth_evidence("different-account@example.com")

    monkeypatch.setattr(browser_register, "_start_password_reauth_via_nextauth", start_nextauth)

    with pytest.raises(RuntimeError, match="transaction lineage 校验失败"):
        browser_register._trigger_password_settings_reauth(
            page,
            "user@example.com",
            otp_callback,
            lambda message: None,
        )


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://auth.openai.com/authorize", "authorize"),
        ("https://auth.openai.com/oauth/authorize?prompt=login", "authorize"),
        ("https://auth.openai.com/api/accounts/reauth", "reauth"),
        ("https://auth.openai.com/email-verification", "email_verification"),
        ("https://auth.openai.com/reset-password/new-password", "new_password"),
        ("https://auth.openai.com/reset-password/success", "success"),
    ],
)
def test_password_reauth_url_classifier_accepts_exact_auth_paths(url, expected):
    assert browser_register._classify_password_reauth_url(url) == expected


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://auth.openai.com/email-verification", "foreign_origin"),
        ("https://auth.openai.com.evil.test/email-verification", "foreign_origin"),
        ("https://auth.openai.com/create-account/password", "forbidden"),
        ("https://auth.openai.com/about-you", "forbidden"),
        ("https://auth.openai.com/add-phone", "forbidden"),
        ("https://auth.openai.com/phone-verification", "forbidden"),
        ("https://auth.openai.com/login", "forbidden"),
        ("https://auth.openai.com/oauth/consent", "forbidden"),
        ("https://auth.openai.com/oauth/consent-screen", "forbidden"),
        ("https://auth.openai.com/workspace/select", "forbidden"),
        ("https://auth.openai.com/workspace-selection", "forbidden"),
        ("https://auth.openai.com/api/organization/select", "forbidden"),
        ("https://auth.openai.com/api/organization_selection", "forbidden"),
        ("https://auth.openai.com/sign-in-with-chatgpt/consent", "forbidden"),
        ("https://auth.openai.com/sign-in-with-chatgpt-consent", "forbidden"),
        ("https://auth.openai.com/redirect/email-verification", "unknown"),
        ("https://auth.openai.com/authorize?next=/create-account", "forbidden"),
        ("https://auth.openai.com/email-verification?flow=signup", "forbidden"),
    ],
)
def test_password_reauth_url_classifier_rejects_untrusted_paths(url, expected):
    assert browser_register._classify_password_reauth_url(url) == expected


def test_password_security_goto_caps_timeout_and_checks_deadline_after_success(monkeypatch):
    clock = [100.0]
    seen_timeouts = []

    class Page:
        def goto(self, url, *, wait_until, timeout):
            seen_timeouts.append(timeout)
            clock[0] = 102.0
            return object()

    monkeypatch.setattr(browser_register.time, "monotonic", lambda: clock[0])

    with pytest.raises(browser_register.PasswordSettingsTimeout):
        browser_register._goto_with_retry(
            Page(),
            "https://chatgpt.com/open-security-settings",
            timeout=30000,
            deadline=101.0,
        )

    assert seen_timeouts == [1000]


def test_password_security_open_propagates_shared_deadline_and_cancel(monkeypatch):
    page = _FlowPage()
    calls = []
    deadline = browser_register.time.monotonic() + 1

    def goto(page, url, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(browser_register, "_goto_with_retry", goto)
    monkeypatch.setattr(
        browser_register,
        "_password_settings_snapshot",
        lambda page: {"ready": True, "configured": False},
    )

    result = browser_register._open_password_security_settings(
        page,
        lambda message: None,
        cancel_check=lambda: False,
        deadline=deadline,
    )

    assert result["ready"] is True
    assert calls[0]["deadline"] == deadline
    assert callable(calls[0]["cancel_check"])


def test_password_security_open_honors_cancel_before_navigation(monkeypatch):
    calls = []
    monkeypatch.setattr(
        browser_register,
        "_goto_with_retry",
        lambda *args, **kwargs: calls.append(True),
    )

    with pytest.raises(browser_register.BrowserTaskCancelled):
        browser_register._open_password_security_settings(
            _FlowPage(),
            lambda message: None,
            cancel_check=lambda: True,
            deadline=browser_register.time.monotonic() + 10,
        )

    assert calls == []


def test_password_eligibility_caps_fetch_to_shared_deadline(monkeypatch):
    seen = []
    deadline = browser_register.time.monotonic() + 0.5

    def browser_fetch(page, url, **kwargs):
        seen.append(kwargs["timeout_ms"])
        return {"ok": True, "data": {"eligible": True}}

    monkeypatch.setattr(browser_register, "_browser_fetch", browser_fetch)

    assert browser_register._password_eligibility(
        _FlowPage(),
        "add",
        deadline=deadline,
        cancel_check=lambda: False,
    ) is True
    assert 1 <= seen[0] <= 500


def test_password_eligibility_advisory_fetch_is_capped_to_three_seconds(monkeypatch):
    seen = []

    def browser_fetch(page, url, **kwargs):
        seen.append(kwargs["timeout_ms"])
        return {"ok": False, "data": None}

    monkeypatch.setattr(browser_register, "_browser_fetch", browser_fetch)

    assert browser_register._password_eligibility(
        _FlowPage(),
        "add",
        deadline=browser_register.time.monotonic() + 30,
    ) is None
    assert len(seen) == 1
    assert 1 <= seen[0] <= 3000


def test_password_eligibility_does_not_swallow_shared_timeout():
    with pytest.raises(browser_register.PasswordSettingsTimeout):
        browser_register._password_eligibility(
            _FlowPage(),
            "add",
            deadline=browser_register.time.monotonic() - 1,
        )


def test_password_otp_playwright_timeouts_are_capped_by_shared_deadline(monkeypatch):
    seen_timeouts = []

    class Target:
        def __init__(self):
            self.value = ""

        def wait_for(self, *, state, timeout):
            seen_timeouts.append(timeout)

        def click(self, *, timeout):
            seen_timeouts.append(timeout)

        def fill(self, value, **kwargs):
            if "timeout" in kwargs:
                seen_timeouts.append(kwargs["timeout"])
            self.value = value

        def type(self, value, **kwargs):
            if "timeout" in kwargs:
                seen_timeouts.append(kwargs["timeout"])
            self.value = value

        def input_value(self):
            return self.value

    class Locator:
        def __init__(self, target):
            self.first = target

        def count(self):
            return 0

    class Page:
        def __init__(self):
            self.url = "https://auth.openai.com/email-verification"
            self.target = Target()

        def wait_for_load_state(self, state, *, timeout):
            seen_timeouts.append(timeout)

        def locator(self, selector):
            return Locator(self.target)

        def get_by_label(self, *args, **kwargs):
            return Locator(self.target)

        def get_by_role(self, *args, **kwargs):
            return Locator(self.target)

        def query_selector(self, selector):
            return object()

        def click(self, selector, *, timeout, no_wait_after):
            seen_timeouts.append(timeout)
            self.url = "https://auth.openai.com/reset-password/new-password"

    monkeypatch.setattr(browser_register, "_password_step_sleep", lambda *args, **kwargs: None)
    page = Page()
    remaining_ms = 250
    result = browser_register._submit_otp_via_page(
        page,
        "123456",
        lambda message: None,
        deadline=browser_register.time.monotonic() + remaining_ms / 1000,
        expected_url_kind="new_password",
    )

    assert result["ok"] is True
    assert seen_timeouts
    assert all(1 <= timeout <= remaining_ms for timeout in seen_timeouts)


def test_password_otp_submit_rejects_preexisting_new_password_page():
    class Page:
        url = "https://auth.openai.com/reset-password/new-password"

        def wait_for_load_state(self, *args, **kwargs):
            raise AssertionError("OTP UI must not be touched after the page already drifted")

    result = browser_register._submit_otp_via_page(
        Page(),
        "123456",
        lambda message: None,
        expected_url_kind="new_password",
    )

    assert result["ok"] is False
    assert "提交前已离开原邮箱验证页" in result["text"]


def test_new_password_selector_waits_use_shared_deadline(monkeypatch):
    page = _FlowPage("https://auth.openai.com/reset-password/new-password")
    selector_timeouts = []
    propagated_deadlines = []
    deadline = browser_register.time.monotonic() + 0.25

    def wait_selector(page, selectors, timeout, cancel_check=None):
        selector_timeouts.append(timeout)
        return selectors[0]

    def fill_input(page, selector, value, **kwargs):
        propagated_deadlines.append(kwargs.get("deadline"))
        return True

    def click_once(page, selectors, **kwargs):
        propagated_deadlines.append(kwargs.get("deadline"))
        page.url = "https://auth.openai.com/reset-password/success"
        return selectors[0]

    monkeypatch.setattr(browser_register, "_wait_for_any_selector", wait_selector)
    monkeypatch.setattr(browser_register, "_fill_input_like_user", fill_input)
    monkeypatch.setattr(browser_register, "_click_first_once_no_wait", click_once)
    monkeypatch.setattr(browser_register, "_password_step_sleep", lambda *args, **kwargs: None)

    browser_register._submit_new_password_via_page(
        page,
        "Configured123!",
        lambda message: None,
        deadline=deadline,
    )

    assert len(selector_timeouts) == 2
    assert all(0 < timeout <= 0.25 for timeout in selector_timeouts)
    assert propagated_deadlines == [deadline, deadline, deadline]


def test_single_password_submit_prefers_success_url_after_click_timeout():
    class Page:
        def __init__(self):
            self.url = "https://auth.openai.com/reset-password/new-password"
            self.clicks = 0

        def query_selector(self, selector):
            return object()

        def click(self, selector, **kwargs):
            self.clicks += 1
            self.url = "https://auth.openai.com/reset-password/success"
            raise TimeoutError("navigation completed after Playwright timeout")

    page = Page()
    clicked = browser_register._click_first_once_no_wait(
        page,
        ['button[type="submit"]'],
        timeout=1,
        label="新增密码页提交",
        accepted_url_kind="success",
    )

    assert clicked == 'button[type="submit"]'
    assert page.clicks == 1


def test_password_error_sanitizes_current_url_query():
    secret = "callback-secret"
    sanitized = browser_register._sanitize_password_error(
        f"页面已离开: https://chatgpt.com/settings/security?code={secret}&state=private"
    )

    assert secret not in sanitized
    assert "state=private" not in sanitized
    assert sanitized.endswith("https://chatgpt.com/settings/security?[redacted-query]")


def test_strict_mail_baseline_refresh_failure_stops_password_step():
    class Mailbox:
        def get_current_ids(self, account):
            return set()

        def get_current_ids_strict(self, account):
            raise RuntimeError("mailbox unavailable")

        def wait_for_code(self, account, **kwargs):
            raise AssertionError("OTP wait must not start after strict refresh failure")

    ctx = SimpleNamespace(
        platform=SimpleNamespace(mailbox=Mailbox()),
        identity=SimpleNamespace(mailbox_account=object(), before_ids={"old"}),
        log=lambda message: None,
    )
    callback = build_otp_callback(ctx, timeout=10)

    with pytest.raises(RuntimeError, match="刷新验证码邮件基线失败"):
        callback.refresh_baseline(strict=True)


@pytest.mark.parametrize("mode", ["timeout", "cancel"])
def test_password_callback_timeout_or_cancel_stops_background_wait(mode):
    stop_wait = browser_register.threading.Event()
    stopped = browser_register.threading.Event()

    def callback():
        try:
            stop_wait.wait(5)
            return ""
        finally:
            stopped.set()

    callback.cancel_wait = stop_wait.set
    started = browser_register.time.monotonic()
    cancel_check = (
        (lambda: browser_register.time.monotonic() - started >= 0.02)
        if mode == "cancel"
        else None
    )
    expected_error = (
        browser_register.BrowserTaskCancelled
        if mode == "cancel"
        else browser_register.PasswordSettingsTimeout
    )
    deadline = started + (1 if mode == "cancel" else 0.03)

    with pytest.raises(expected_error):
        browser_register._run_password_callback_with_deadline(
            callback,
            deadline=deadline,
            cancel_check=cancel_check,
            label="test callback",
        )

    assert stop_wait.is_set()
    assert stopped.wait(1)


def test_strict_baseline_timeout_uses_original_callback_cancel_hook():
    stop_wait = browser_register.threading.Event()
    stopped = browser_register.threading.Event()

    def otp_callback():
        return "123456"

    def refresh_baseline(*, strict=False):
        assert strict is True
        try:
            stop_wait.wait(5)
        finally:
            stopped.set()

    otp_callback.refresh_baseline = refresh_baseline
    otp_callback.cancel_wait = stop_wait.set

    with pytest.raises(browser_register.PasswordSettingsTimeout):
        browser_register._trigger_password_settings_reauth(
            _FlowPage("https://chatgpt.com/#settings/Security"),
            "user@example.com",
            otp_callback,
            lambda message: None,
            deadline=browser_register.time.monotonic() + 0.03,
        )

    assert stop_wait.is_set()
    assert stopped.wait(1)


def test_security_password_success_requires_success_url_and_security_confirmation(monkeypatch):
    page = _FlowPage()
    otp_calls = []

    def trigger(page, email, otp_callback, log, **kwargs):
        page.url = "https://auth.openai.com/email-verification"

    def submit_otp(page, code, log, **kwargs):
        page.url = "https://auth.openai.com/reset-password/new-password"
        return {"ok": True, "status": 200, "url": page.url, "text": ""}

    def submit_password(page, password, log, **kwargs):
        page.url = "https://auth.openai.com/reset-password/success"

    monkeypatch.setattr(browser_register, "_trigger_password_settings_reauth", trigger)
    monkeypatch.setattr(browser_register, "_submit_otp_via_page", submit_otp)
    monkeypatch.setattr(browser_register, "_submit_new_password_via_page", submit_password)
    monkeypatch.setattr(
        browser_register,
        "_open_password_security_settings",
        lambda page, log: {"ready": True, "configured": True, "text": "Password ******"},
    )
    monkeypatch.setattr(browser_register, "_password_eligibility", lambda page, action: action == "change")

    result = browser_register._set_password_from_security_settings(
        page,
        "user@example.com",
        "Configured123!",
        lambda: otp_calls.append(True) or "123456",
        lambda message: None,
    )

    assert otp_calls == [True]
    assert result["password_set"] is True
    assert result["password_status"] == "configured"
    assert result["password_source"] == "settings"


def test_security_password_success_url_remains_authoritative_when_secondary_check_lags(monkeypatch):
    page = _FlowPage("https://auth.openai.com/email-verification")

    monkeypatch.setattr(
        browser_register,
        "_trigger_password_settings_reauth",
        lambda page, email, otp_callback, log, **kwargs: None,
    )

    def submit_otp(page, code, log, **kwargs):
        page.url = "https://auth.openai.com/reset-password/new-password"
        return {"ok": True, "status": 200, "url": page.url, "text": ""}

    def submit_password(page, password, log, **kwargs):
        page.url = "https://auth.openai.com/reset-password/success"

    monkeypatch.setattr(browser_register, "_submit_otp_via_page", submit_otp)
    monkeypatch.setattr(browser_register, "_submit_new_password_via_page", submit_password)
    monkeypatch.setattr(browser_register, "_confirm_password_in_security", lambda page, log: False)

    result = browser_register._set_password_from_security_settings(
        page,
        "user@example.com",
        "Configured123!",
        lambda: "123456",
        lambda message: None,
    )

    assert result["password_set"] is True
    assert result["password_status"] == "configured"
    assert result["password_verification"] == "success_url"


def test_password_root_requires_candidate_login_and_returns_fresh_session(monkeypatch):
    page = _FlowPage("https://auth.openai.com/email-verification")
    verifier_calls = []

    monkeypatch.setattr(
        browser_register,
        "_trigger_password_settings_reauth",
        lambda *args, **kwargs: "change",
    )

    def submit_otp(page, code, log, **kwargs):
        page.url = "https://auth.openai.com/reset-password/new-password"
        return {"ok": True, "status": 200, "url": page.url, "text": ""}

    def submit_password(page, password, log, **kwargs):
        page.url = "https://chatgpt.com/"
        return "chatgpt_root"

    def verify_candidate(**kwargs):
        verifier_calls.append(kwargs)
        return {
            "candidate_submit_marker": "candidate-password-submit:proof",
            "candidate_submit_count": 1,
            "session_info": {
                "account_id": "acct_123",
                "profile": {"email": "user@example.com"},
                "session": {"user": {"email": "user@example.com"}},
                "cookies": "fresh-cookie=value",
                "access_token": "fresh-access",
            },
        }

    monkeypatch.setattr(browser_register, "_submit_otp_via_page", submit_otp)
    monkeypatch.setattr(browser_register, "_submit_new_password_via_page", submit_password)

    result = browser_register._set_password_from_security_settings(
        page,
        "user@example.com",
        "Configured123!",
        lambda: "123456",
        lambda message: None,
        session_evidence=_session_evidence(),
        candidate_login_verifier=verify_candidate,
    )

    assert result["password_verification"] == "password_login_reconciled"
    assert result["account_id"] == "acct_123"
    assert result["cookies"] == "fresh-cookie=value"
    assert result["access_token"] == "fresh-access"
    assert len(verifier_calls) == 1


@pytest.mark.parametrize(
    "url",
    [
        "http://chatgpt.com/",
        "https://chatgpt.com.evil.test/",
        "https://user@chatgpt.com/",
        "https://chatgpt.com:444/",
        "https://chatgpt.com/?next=1",
        "https://chatgpt.com/#settings/Security",
        "https://chatgpt.com/open-security-settings",
    ],
)
def test_password_post_submit_root_requires_exact_structured_url(url):
    assert browser_register._is_exact_password_post_submit_root(url) is False


def test_candidate_password_proof_rejects_fresh_context_auto_login(monkeypatch):
    context = SimpleNamespace(
        cookies=lambda: [],
        storage_state=lambda: {"cookies": [], "origins": []},
    )
    page = _FlowPage("about:blank")
    page.context = context
    otp_callback = lambda: "123456"
    otp_callback.refresh_baseline = lambda strict=False: None

    monkeypatch.setattr(browser_register, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(
        browser_register,
        "_start_browser_signup_via_authorize",
        lambda *args, **kwargs: {
            "page_type": "chatgpt_home",
            "current_url": "https://chatgpt.com/",
        },
    )

    with pytest.raises(RuntimeError, match="未实际提交"):
        browser_register._verify_existing_account_password_login(
            page,
            source_context=object(),
            email="user@example.com",
            password="Configured123!",
            expected_account_id="acct_123",
            otp_callback=otp_callback,
            log=lambda message: None,
            deadline=browser_register.time.monotonic() + 5,
        )


def test_candidate_password_proof_submits_once_and_validates_identity(monkeypatch):
    context = SimpleNamespace(
        cookies=lambda: [],
        storage_state=lambda: {"cookies": [], "origins": []},
    )
    page = _FlowPage("about:blank")
    page.context = context
    submits = []
    switches = []
    otp_callback = lambda: "123456"
    otp_callback.refresh_baseline = lambda strict=False: None

    monkeypatch.setattr(browser_register, "_seed_browser_device_id", lambda *args: None)

    def start(*args, **kwargs):
        page.url = "https://auth.openai.com/email-verification"
        return {"page_type": "email_otp_verification", "current_url": page.url}

    def submit(page, password, **kwargs):
        submits.append(password)
        page.url = "https://chatgpt.com/"
        return "candidate-password-submit:proof"

    monkeypatch.setattr(browser_register, "_start_browser_signup_via_authorize", start)
    monkeypatch.setattr(
        browser_register,
        "_select_password_login_instead_once",
        lambda page, **kwargs: switches.append(True) or "password-login-instead:proof",
    )
    monkeypatch.setattr(browser_register, "_submit_candidate_password_login_once", submit)

    def transition(page, previous, **kwargs):
        if previous == "email_otp_verification":
            page.url = "https://auth.openai.com/log-in/password"
            return {"page_type": "login_password", "current_url": page.url}
        page.url = "https://chatgpt.com/"
        return {"page_type": "chatgpt_home", "current_url": page.url}

    monkeypatch.setattr(
        browser_register,
        "_wait_for_existing_login_transition",
        transition,
    )
    monkeypatch.setattr(
        browser_register,
        "_fetch_chatgpt_session_from_page",
        lambda *args, **kwargs: _existing_session(),
    )

    proof = browser_register._verify_existing_account_password_login(
        page,
        source_context=object(),
        email="user@example.com",
        password="Configured123!",
        expected_account_id="acct_123",
        otp_callback=otp_callback,
        log=lambda message: None,
        deadline=browser_register.time.monotonic() + 5,
    )

    assert submits == ["Configured123!"]
    assert switches == [True]
    assert proof["candidate_submit_count"] == 1
    assert proof["session_info"]["account_id"] == "acct_123"


def test_password_trigger_race_to_new_password_cannot_bypass_second_otp(monkeypatch):
    page = _FlowPage("https://auth.openai.com/email-verification")
    otp_calls = []
    otp_submits = []
    password_fills = []

    def trigger(page, email, otp_callback, log, **kwargs):
        page.url = "https://auth.openai.com/reset-password/new-password"

    monkeypatch.setattr(browser_register, "_trigger_password_settings_reauth", trigger)
    monkeypatch.setattr(
        browser_register,
        "_submit_otp_via_page",
        lambda *args, **kwargs: otp_submits.append(True),
    )
    monkeypatch.setattr(
        browser_register,
        "_submit_new_password_via_page",
        lambda *args, **kwargs: password_fills.append(True),
    )

    with pytest.raises(RuntimeError, match="未进入原邮箱验证页"):
        browser_register._set_password_from_security_settings(
            page,
            "user@example.com",
            "Configured123!",
            lambda: otp_calls.append(True) or "123456",
            lambda message: None,
        )

    assert otp_calls == []
    assert otp_submits == []
    assert password_fills == []


class _RunPage:
    def __init__(self):
        self.url = "about:blank"
        self.context = None


class _RunContext:
    def __init__(self):
        self.page = _RunPage()
        self.page.context = self

    def cookies(self):
        return []

    def clear_cookies(self):
        return None

    def new_page(self):
        return self.page


class _RunBrowser:
    def __init__(self):
        self.context = _RunContext()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def new_context(self, **kwargs):
        return self.context


def test_settings_failure_keeps_account_but_never_returns_candidate_password(monkeypatch):
    events = []
    browser = _RunBrowser()

    monkeypatch.setattr(
        browser_register,
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
    monkeypatch.setattr(browser_register, "_fingerprint_snapshot", lambda page: {})
    monkeypatch.setattr(
        browser_register,
        "_browser_registration_flow",
        lambda *args, **kwargs: {
            "page_type": "chatgpt_home",
            "post_signup_ready": True,
            "password": "",
            "password_set": False,
            "password_status": "not_configured",
            "password_source": "none",
        },
    )

    def fail_settings(*args, **kwargs):
        events.append("settings")
        assert kwargs["session_evidence"] == _session_evidence()
        raise RuntimeError(
            "Candidate123! failed at "
            "https://auth.openai.com/email-verification?state=secret&nonce=secret"
        )

    monkeypatch.setattr(browser_register, "_set_password_from_security_settings", fail_settings)
    monkeypatch.setattr(browser_register, "_get_cookies", lambda page: {})

    def fetch_session(page, cookies, log):
        events.append("session")
        return {
            "access_token": "at_123",
            "account_id": "acct_123",
            "session_token": "sess_123",
            "profile": {"email": "user@example.com"},
        }

    monkeypatch.setattr(browser_register, "_fetch_chatgpt_session_from_page", fetch_session)

    worker = browser_register.ChatGPTBrowserRegister(
        headless=True,
        otp_callback=lambda: "123456",
        set_password_after_registration=True,
        password_generator=lambda: "Candidate123!",
        log_fn=lambda message: None,
    )
    monkeypatch.setattr(worker, "_open_browser", lambda launch_opts: browser)

    result = worker.run("user@example.com", "")

    assert events == ["session", "settings"]
    assert result["access_token"] == "at_123"
    assert result["password"] == ""
    assert result["password_set"] is False
    assert result["password_status"] == "failed"
    assert result["password_source"] == "settings"
    assert "Candidate123!" not in result["password_error"]
    assert "state=secret" not in result["password_error"]
    assert result["password_error"] == (
        "[redacted-password] failed at "
        "https://auth.openai.com/email-verification?[redacted-query]"
    )


@pytest.mark.parametrize(
    "session_info",
    [
        {
            "access_token": "at_123",
            "account_id": "acct_123",
            "profile": {"email": "other@example.com"},
        },
        {
            "access_token": "at_123",
            "account_id": "",
            "profile": {"email": "user@example.com"},
        },
    ],
)
@pytest.mark.parametrize("set_password_after_registration", [False, True])
def test_registration_session_identity_mismatch_is_core_failure(
    monkeypatch,
    session_info,
    set_password_after_registration,
):
    browser = _RunBrowser()
    otp_calls = []
    settings_calls = []
    monkeypatch.setattr(
        browser_register,
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
    monkeypatch.setattr(browser_register, "_fingerprint_snapshot", lambda page: {})
    monkeypatch.setattr(
        browser_register,
        "_browser_registration_flow",
        lambda *args, **kwargs: {
            "page_type": "chatgpt_home",
            "post_signup_ready": True,
            "password": "",
            "password_set": False,
            "password_status": "not_configured",
            "password_source": "none",
        },
    )
    monkeypatch.setattr(browser_register, "_get_cookies", lambda page: {})
    monkeypatch.setattr(
        browser_register,
        "_fetch_chatgpt_session_from_page",
        lambda page, cookies, log: dict(session_info),
    )
    monkeypatch.setattr(
        browser_register,
        "_set_password_from_security_settings",
        lambda *args, **kwargs: settings_calls.append(True),
    )

    worker = browser_register.ChatGPTBrowserRegister(
        headless=True,
        otp_callback=lambda: otp_calls.append(True) or "123456",
        set_password_after_registration=set_password_after_registration,
        password_generator=lambda: "Candidate123!",
        log_fn=lambda message: None,
    )
    monkeypatch.setattr(worker, "_open_browser", lambda launch_opts: browser)

    with pytest.raises(browser_register.ExistingAccountIdentityMismatch):
        worker.run("user@example.com", "")

    assert settings_calls == []
    assert otp_calls == []


def test_otp_callback_advances_seen_message_ids_between_codes():
    class Mailbox:
        def __init__(self):
            self.current_ids = {"old"}
            self.before_ids = []
            self.codes = iter(["111111", "222222"])

        def get_current_ids(self, account):
            return set(self.current_ids)

        def wait_for_code(self, account, **kwargs):
            self.before_ids.append(set(kwargs["before_ids"]))
            code = next(self.codes)
            self.current_ids.add(f"message-{code}")
            return code

    mailbox = Mailbox()
    ctx = SimpleNamespace(
        platform=SimpleNamespace(mailbox=mailbox),
        identity=SimpleNamespace(mailbox_account=object(), before_ids={"old"}),
        log=lambda message: None,
    )
    callback = build_otp_callback(ctx, timeout=10)

    assert callable(callback.cancel_wait)
    assert callback() == "111111"
    callback.refresh_baseline()
    assert callback() == "222222"
    assert mailbox.before_ids == [
        {"old"},
        {"old", "message-111111"},
    ]


def test_plugin_mapper_only_persists_confirmed_password():
    platform = object.__new__(ChatGPTPlatform)
    unconfigured = platform._map_chatgpt_result(
        {
            "email": "user@example.com",
            "password": "Candidate123!",
            "password_set": False,
            "password_status": "not_configured",
            "password_source": "none",
        }
    )
    configured = platform._map_chatgpt_result(
        {
            "email": "user@example.com",
            "password": "Configured123!",
            "password_set": True,
            "password_status": "configured",
            "password_source": "settings",
        }
    )
    inconsistent = platform._map_chatgpt_result(
        {
            "email": "user@example.com",
            "password": "MustNotLeak123!",
            "password_set": True,
            "password_status": "failed",
            "password_source": "settings",
        }
    )

    assert unconfigured.password == ""
    assert unconfigured.extra["account_overview"] == {
        "password_status": "not_configured",
        "password_source": "none",
    }
    assert configured.password == "Configured123!"
    assert configured.extra["account_overview"]["password_status"] == "configured"
    assert configured.extra["account_overview"]["password_source"] == "settings"
    assert inconsistent.password == ""
    assert inconsistent.extra["account_overview"]["password_status"] == "failed"


def test_protocol_browser_fallback_does_not_restore_candidate_password():
    worker = object.__new__(ChatGPTProtocolMailboxWorker)
    result = worker._browser_result_to_protocol_result(
        {
            "email": "user@example.com",
            "password": "Candidate123!",
            "password_set": False,
            "password_status": "not_configured",
            "password_source": "none",
        },
        email="user@example.com",
        password="Candidate123!",
    )

    assert result.password == ""
    assert result.metadata["password_set"] is False
    assert result.metadata["password_status"] == "not_configured"

    failed = worker._browser_result_to_protocol_result(
        {
            "email": "user@example.com",
            "password": "MustNotLeak123!",
            "password_set": True,
            "password_status": "failed",
            "password_source": "settings",
        },
        email="user@example.com",
        password="Candidate123!",
    )
    assert failed.password == ""
    assert failed.metadata["password_set"] is False
    assert failed.metadata["password_status"] == "failed"


def test_protocol_mapper_rejects_inconsistent_failed_password_payload():
    platform = object.__new__(ChatGPTPlatform)
    platform.mailbox = None
    platform.config = RegisterConfig()
    adapter = platform.build_protocol_mailbox_adapter()
    ctx = SimpleNamespace(password="Candidate123!", proxy=None, log=lambda message: None)
    raw = SimpleNamespace(
        email="user@example.com",
        password="MustNotLeak123!",
        account_id="acct_123",
        access_token="at_123",
        refresh_token="",
        id_token="id_123",
        session_token="sess_123",
        workspace_id="",
        metadata={
            "password_set": True,
            "password_status": "failed",
            "password_source": "invalid-source",
        },
    )

    mapped = adapter.result_mapper(ctx, raw)

    assert mapped.password == ""
    assert mapped.extra["account_overview"]["password_status"] == "failed"
    assert mapped.extra["account_overview"]["password_source"] == "none"


def test_password_settings_checkbox_forces_protocol_registration_to_browser():
    payload = {
        "executor_type": "protocol",
        "extra": {"set_password_after_registration": True},
    }

    coerced, changed = _coerce_chatgpt_password_settings_executor("chatgpt", payload)

    assert changed is True
    assert coerced["executor_type"] == "headed"
    assert payload["executor_type"] == "protocol"


def test_password_settings_checkbox_preserves_existing_browser_executor():
    payload = {
        "executor_type": "headless",
        "extra": {"set_password_after_registration": True},
    }

    coerced, changed = _coerce_chatgpt_password_settings_executor("chatgpt", payload)

    assert changed is False
    assert coerced is payload


def test_flat_account_cookies_are_mapped_to_strict_domains_and_small_chatgpt_header():
    values = {
        "__Secure-next-auth.session-token": "s" * 1800,
        "__Host-next-auth.csrf-token": "c" * 120,
        "__Secure-next-auth.callback-url": "b" * 120,
        "__cf_bm": "f" * 180,
        "cf_clearance": "q" * 180,
        "oai-did": "did-123",
        "oai-client-auth-session": "a" * 700,
        "oai-client-auth-device": "d" * 700,
        "hydra_redirect": "h" * 700,
        "__Secure-oai-is": "i" * 300,
        "oai-login-csrf-state": "l" * 500,
        "oai-sc": "o" * 500,
        "unified_session_manifest": "u" * 700,
        "iss_context": "j" * 500,
        "rg_context": "r" * 500,
        "usc-main": "v" * 500,
        "oai-hlib": "k" * 500,
        "login_session": "g" * 500,
        "intercom-session-unknown": "x" * 1500,
        "analytics-unknown": "y" * 1500,
        "stripe-unknown": "z" * 1500,
        "totally-unknown": "w" * 1500,
    }
    flat_header = "; ".join(f"{name}={value}" for name, value in values.items())

    mapped = browser_register._cookie_header_to_playwright_cookies(flat_header)
    chatgpt_items = [item for item in mapped if item["url"] == "https://chatgpt.com/"]
    auth_items = [item for item in mapped if item["url"] == "https://auth.openai.com/"]
    chatgpt_names = {item["name"] for item in chatgpt_items}
    auth_names = {item["name"] for item in auth_items}
    all_mapped_names = chatgpt_names | auth_names

    assert len(flat_header.encode("utf-8")) > 8192
    assert {
        "__Secure-next-auth.session-token",
        "__Host-next-auth.csrf-token",
        "__Secure-next-auth.callback-url",
        "__cf_bm",
        "cf_clearance",
        "oai-did",
    } <= chatgpt_names
    assert {
        "oai-client-auth-session",
        "oai-client-auth-device",
        "hydra_redirect",
        "__Secure-oai-is",
        "oai-login-csrf-state",
        "oai-sc",
        "unified_session_manifest",
        "iss_context",
        "rg_context",
        "usc-main",
        "oai-hlib",
        "login_session",
        "oai-did",
    } <= auth_names
    assert next(
        item["value"]
        for item in chatgpt_items
        if item["name"] == "__Secure-next-auth.session-token"
    ) == values["__Secure-next-auth.session-token"]
    assert {
        "intercom-session-unknown",
        "analytics-unknown",
        "stripe-unknown",
        "totally-unknown",
    }.isdisjoint(all_mapped_names)
    assert browser_register._estimated_cookie_header_bytes(
        mapped,
        "https://chatgpt.com",
    ) < browser_register.PASSWORD_CHATGPT_COOKIE_HEADER_MAX_BYTES


class _ExistingSessionContext:
    def __init__(self):
        self.added = []
        self.clear_count = 0

    def clear_cookies(self):
        self.clear_count += 1

    def add_cookies(self, cookies):
        self.added.extend(cookies)

    def cookies(self):
        return list(self.added)


class _ExistingSessionPage:
    def __init__(self):
        self.url = "about:blank"
        self.context = _ExistingSessionContext()


def _existing_session(email="user@example.com", account_id="acct_123"):
    return {
        "access_token": "access-token",
        "account_id": account_id,
        "profile": {"email": email},
        "session": {"user": {"email": email}},
    }


def test_existing_account_restore_uses_valid_cookie_without_login(monkeypatch):
    page = _ExistingSessionPage()
    login_started = []

    monkeypatch.setattr(
        browser_register,
        "_goto_with_retry",
        lambda page, url, **kwargs: setattr(page, "url", url),
    )
    monkeypatch.setattr(
        browser_register,
        "_fetch_chatgpt_session_from_page",
        lambda page, cookies, log, timeout=45: _existing_session(),
    )
    monkeypatch.setattr(
        browser_register,
        "_start_browser_signup_via_authorize",
        lambda *args: login_started.append(True),
    )

    result = browser_register._restore_existing_account_session(
        page,
        email="user@example.com",
        cookies="__Host-next-auth.csrf-token=csrf; __Secure-next-auth.session-token=session",
        otp_callback=None,
        expected_account_id="acct_123",
        log=lambda message: None,
    )

    assert result["account_id"] == "acct_123"
    assert login_started == []
    assert page.context.added
    assert all(item["url"] == "https://chatgpt.com/" for item in page.context.added)


def test_existing_account_restore_rejects_cookie_for_other_email(monkeypatch):
    page = _ExistingSessionPage()
    login_started = []

    monkeypatch.setattr(
        browser_register,
        "_goto_with_retry",
        lambda page, url, **kwargs: setattr(page, "url", url),
    )
    monkeypatch.setattr(
        browser_register,
        "_fetch_chatgpt_session_from_page",
        lambda page, cookies, log, timeout=45: _existing_session("other@example.com"),
    )
    monkeypatch.setattr(
        browser_register,
        "_start_browser_signup_via_authorize",
        lambda *args: login_started.append(True),
    )

    with pytest.raises(browser_register.ExistingAccountIdentityMismatch):
        browser_register._restore_existing_account_session(
            page,
            email="user@example.com",
            cookies="__Secure-next-auth.session-token=session",
            otp_callback=lambda: "123456",
            expected_account_id="acct_123",
            log=lambda message: None,
        )

    assert login_started == []


def test_expired_cookie_uses_same_email_passwordless_otp(monkeypatch):
    page = _ExistingSessionPage()
    events = []
    fetch_calls = []

    def fetch_session(page, cookies, log, timeout=45):
        fetch_calls.append(timeout)
        if len(fetch_calls) == 1:
            raise RuntimeError("expired")
        return _existing_session()

    def otp_callback():
        events.append("otp")
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: events.append(("refresh", strict))

    monkeypatch.setattr(
        browser_register,
        "_goto_with_retry",
        lambda page, url, **kwargs: setattr(page, "url", url),
    )
    monkeypatch.setattr(browser_register, "_fetch_chatgpt_session_from_page", fetch_session)
    monkeypatch.setattr(browser_register, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(
        browser_register,
        "_start_browser_signup_via_authorize",
        lambda page, email, device_id, log: {
            "page_type": "login_password",
            "current_url": "https://auth.openai.com/log-in/password",
        },
    )

    def click_passwordless(page, log, context):
        page.url = "https://auth.openai.com/email-verification"
        return True

    monkeypatch.setattr(browser_register, "_click_passwordless_login_if_available", click_passwordless)
    monkeypatch.setattr(
        browser_register,
        "_wait_for_existing_login_transition",
        lambda *args, **kwargs: {
            "page_type": "email_otp_verification",
            "current_url": "https://auth.openai.com/email-verification",
        },
    )

    def submit_otp(page, code, log, cancel_check=None):
        events.append(("submit", code))
        page.url = "https://chatgpt.com/"
        return {"ok": True, "url": page.url, "data": None}

    monkeypatch.setattr(browser_register, "_submit_otp_via_page", submit_otp)

    result = browser_register._restore_existing_account_session(
        page,
        email="user@example.com",
        cookies="__Secure-next-auth.session-token=expired",
        otp_callback=otp_callback,
        expected_account_id="acct_123",
        log=lambda message: None,
    )

    assert result["account_id"] == "acct_123"
    assert events == [("refresh", True), "otp", ("submit", "123456")]
    assert page.context.clear_count == 2


def test_existing_login_fails_closed_on_about_you(monkeypatch):
    page = _ExistingSessionPage()
    otp_calls = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_fetch_chatgpt_session_from_page",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("expired")),
    )
    monkeypatch.setattr(browser_register, "_goto_with_retry", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register, "_seed_browser_device_id", lambda *args: None)
    monkeypatch.setattr(
        browser_register,
        "_start_browser_signup_via_authorize",
        lambda *args: {
            "page_type": "about_you",
            "current_url": "https://auth.openai.com/about-you",
        },
    )

    with pytest.raises(RuntimeError, match="禁止的新注册状态"):
        browser_register._restore_existing_account_session(
            page,
            email="user@example.com",
            cookies="__Secure-next-auth.session-token=expired",
            otp_callback=otp_callback,
            expected_account_id="acct_123",
            log=lambda message: None,
        )

    assert otp_calls == []


def test_existing_login_fails_closed_on_phone_verification(monkeypatch):
    page = _ExistingSessionPage()
    otp_calls = []

    def otp_callback():
        otp_calls.append(True)
        return "123456"

    otp_callback.refresh_baseline = lambda strict=False: None
    monkeypatch.setattr(
        browser_register,
        "_fetch_chatgpt_session_from_page",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("expired")),
    )
    monkeypatch.setattr(browser_register, "_goto_with_retry", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register, "_seed_browser_device_id", lambda *args: None)
    phone_state = browser_register._extract_flow_state(
        None,
        "https://auth.openai.com/phone-verification",
    )
    raw_phone_state = browser_register._extract_flow_state(
        {"page": {"type": "phone-verification"}},
        "https://auth.openai.com/phone-verification",
    )
    conflicting_phone_state = browser_register._extract_flow_state(
        {"page": {"type": "email_otp_verification"}},
        "https://auth.openai.com/phone-verification",
    )
    monkeypatch.setattr(
        browser_register,
        "_start_browser_signup_via_authorize",
        lambda *args: phone_state,
    )

    assert phone_state["page_type"] == "add_phone"
    assert raw_phone_state["page_type"] == "add_phone"
    assert conflicting_phone_state["page_type"] == "add_phone"
    assert browser_register._is_add_phone(conflicting_phone_state) is True
    with pytest.raises(RuntimeError, match="禁止的新注册状态: page=add_phone"):
        browser_register._restore_existing_account_session(
            page,
            email="user@example.com",
            cookies="__Secure-next-auth.session-token=expired",
            otp_callback=otp_callback,
            expected_account_id="acct_123",
            log=lambda message: None,
        )

    assert otp_calls == []


@pytest.mark.parametrize("failure_stage", ["exit", "session", "late_cancel"])
def test_password_success_url_survives_post_commit_failures(
    monkeypatch,
    failure_stage,
):
    browser = _RunBrowser()
    logs = []
    cancel_calls = 0

    def cancel_check():
        nonlocal cancel_calls
        cancel_calls += 1
        return failure_stage == "late_cancel" and cancel_calls >= 4

    worker = browser_register.ChatGPTBrowserRegister(
        headless=True,
        otp_callback=lambda: "123456",
        log_fn=logs.append,
        cancel_check=cancel_check,
    )
    monkeypatch.setattr(worker, "_open_browser", lambda launch_opts: browser)
    monkeypatch.setattr(worker, "_new_isolated_page", lambda _browser: browser.context.page)
    monkeypatch.setattr(
        browser_register,
        "_apply_regional_fingerprint",
        lambda *args, **kwargs: {
            "ip": "198.51.100.7",
            "locale": "en-US",
            "timezone": "America/New_York",
        },
    )
    monkeypatch.setattr(browser_register, "_fingerprint_snapshot", lambda page: {})
    exit_checks = 0

    def verify_exit(*args, **kwargs):
        nonlocal exit_checks
        exit_checks += 1
        if failure_stage == "exit" and exit_checks == 2:
            raise RuntimeError("Configured123! 123456 post-exit-secret")
        return "198.51.100.7"

    monkeypatch.setattr(browser_register, "_verify_browser_exit_for_flow", verify_exit)
    monkeypatch.setattr(
        browser_register,
        "_restore_existing_account_session",
        lambda *args, **kwargs: {
            **_existing_session(),
            "session_token": "existing-session",
            "cookies": "existing-cookie",
        },
    )
    monkeypatch.setattr(
        browser_register,
        "_set_password_from_security_settings",
        lambda *args, **kwargs: {
            "password_set": True,
            "password_status": "configured",
            "password_source": "settings",
            "password_verification": "success_url",
        },
    )
    monkeypatch.setattr(browser_register, "_get_cookies", lambda page: {"cookie": "fresh"})

    def refresh_session(*args, **kwargs):
        if failure_stage == "session":
            raise RuntimeError("Configured123! 123456 post-session-secret")
        return {
            **_existing_session(),
            "session_token": "fresh-session",
            "cookies": "fresh-cookie",
        }

    monkeypatch.setattr(browser_register, "_fetch_chatgpt_session_from_page", refresh_session)

    result = worker.set_password_for_existing_account(
        email="user@example.com",
        password="Configured123!",
        cookies="existing-cookie",
        expected_account_id="acct_123",
    )

    assert result["password"] == "Configured123!"
    assert result["password_set"] is True
    assert result["password_status"] == "configured"
    assert result["password_verification"] == "success_url"
    assert "password_error" not in result
    assert "Configured123!" not in str(result.get("message") or "")
    assert "123456" not in str(result.get("message") or "")
    assert all("Configured123!" not in message for message in logs)
    assert all("123456" not in message for message in logs)


def test_password_action_restores_original_outlook_mailbox(monkeypatch):
    from core import base_mailbox

    captured = {}
    logs = []

    class Mailbox:
        def get_current_ids(self, mailbox_account):
            captured["baseline_email"] = mailbox_account.email
            return {"old-message"}

        def get_current_ids_strict(self, mailbox_account):
            return self.get_current_ids(mailbox_account)

        def wait_for_code(self, mailbox_account, **kwargs):
            captured["wait_email"] = mailbox_account.email
            captured["before_ids"] = set(kwargs["before_ids"])
            return "123456"

    def create_mailbox(provider, extra=None, proxy=None):
        captured["provider"] = provider
        captured["extra"] = dict(extra or {})
        captured["proxy"] = proxy
        return Mailbox()

    monkeypatch.setattr(base_mailbox, "create_mailbox", create_mailbox)
    platform = ChatGPTPlatform(config=RegisterConfig())
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="",
        extra={
            "provider_resources": [
                {
                    "provider_type": "mailbox",
                    "provider_name": "outlook_email",
                    "resource_type": "mailbox",
                    "resource_identifier": "mailbox-id",
                    "handle": "user@example.com",
                    "metadata": {
                        "email": "user@example.com",
                        "api_url": "https://mail.example.test",
                    },
                }
            ],
            "provider_accounts": [
                {
                    "provider_type": "mailbox",
                    "provider_name": "outlook_email",
                    "login_identifier": "user@example.com",
                    "credentials": {},
                    "metadata": {"email": "user@example.com"},
                }
            ],
        },
    )

    callback, error = platform._build_get_rt_mailbox_otp_callback(
        account,
        logs.append,
        "http://proxy.example.test:8080",
        purpose="设置密码",
        require_account_email=True,
    )

    assert error == ""
    assert callback is not None
    assert callable(callback.cancel_wait)
    callback.refresh_baseline(strict=True)
    assert callback() == "123456"
    assert captured["provider"] == "outlook_email_api"
    assert captured["extra"]["outlook_email_fixed_email"] == "user@example.com"
    assert captured["extra"]["outlook_email_api_url"] == "https://mail.example.test"
    assert captured["baseline_email"] == "user@example.com"
    assert captured["wait_email"] == "user@example.com"
    assert captured["before_ids"] == {"old-message"}


def test_set_password_action_exposes_minimal_alias_hub_contract():
    platform = ChatGPTPlatform(config=RegisterConfig())
    action = next(item for item in platform.get_platform_actions() if item["id"] == "set_password")

    assert [item["key"] for item in action["params"]] == ["password", "proxy"]


@pytest.mark.parametrize(
    "proof",
    ["success_url", "password_login_reconciled"],
)
def test_set_password_action_passes_only_existing_account_identity(monkeypatch, proof):
    captured = {}
    logs = []

    class FakeWorker:
        def __init__(self, **kwargs):
            captured["worker_kwargs"] = kwargs

        def set_password_for_existing_account(self, **kwargs):
            captured["call_kwargs"] = kwargs
            return {
                "password": kwargs["password"],
                "password_set": True,
                "password_status": "configured",
                "password_source": "settings",
                "password_verification": proof,
                "cookies": "refreshed-cookie",
            }

    monkeypatch.setattr(browser_register, "ChatGPTBrowserRegister", FakeWorker)
    platform = ChatGPTPlatform(config=RegisterConfig())
    platform.set_logger(logs.append)
    monkeypatch.setattr(
        platform,
        "_build_get_rt_mailbox_otp_callback",
        lambda *args, **kwargs: (lambda: "123456", ""),
    )
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="",
        user_id="acct_123",
        extra={"cookies": "existing-cookie", "account_id": "acct_123"},
    )

    result = platform.execute_action(
        "set_password",
        account,
        {"password": "Configured123!", "proxy": "http://proxy.example.test:8080"},
    )

    assert result["ok"] is True
    assert captured["worker_kwargs"]["proxy"] == "http://proxy.example.test:8080"
    assert captured["call_kwargs"] == {
        "email": "user@example.com",
        "password": "Configured123!",
        "cookies": "existing-cookie",
        "expected_account_id": "acct_123",
    }
