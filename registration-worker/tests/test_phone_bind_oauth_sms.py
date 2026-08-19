from __future__ import annotations

from types import SimpleNamespace

import pytest

from application.phone_binding import PhoneBindEntry, default_phone_binder
from domain.accounts import AccountRecord
from platforms.chatgpt import browser_register as browser_register_module


@pytest.mark.parametrize(
    ("phone_number", "expected"),
    [
        ("+231770001686", ("231", "770001686", "Liberia")),
        ("+244923001234", ("244", "923001234", "Angola")),
    ],
)
def test_add_phone_parser_supports_herosms_realtime_countries(phone_number, expected):
    assert browser_register_module._parse_phone_country_and_local(phone_number) == expected


def test_add_phone_dom_submit_does_not_reference_removed_select_variable():
    captured = {}

    class FakePage:
        url = "https://auth.openai.com/add-phone"

        def evaluate(self, script, payload):
            captured["script"] = script
            captured["payload"] = payload
            return {
                "ok": True,
                "url": self.url,
                "selectedCountry": payload["isoCode"],
                "channel": "sms",
                "visibleValue": payload["nationalPhoneNumber"],
                "hiddenValue": payload["phoneNumber"],
            }

    result = browser_register_module._submit_add_phone_dom(
        FakePage(),
        phone_number="+231770001686",
        dial_code="231",
        local_number="770001686",
        country_name="Liberia",
        log=lambda _message: None,
    )

    assert result["ok"] is True
    assert captured["payload"] == {
        "phoneNumber": "+231770001686",
        "nationalPhoneNumber": "770001686",
        "dialCode": "231",
        "countryLabel": "Liberia",
        "isoCode": "LR",
    }
    assert "selectedCountry: select ?" not in captured["script"]


def test_phone_otp_dom_wins_over_stale_email_verification_url():
    class FakePage:
        url = "https://auth.openai.com/email-verification"

        def evaluate(self, _script):
            return {
                "url": self.url,
                "addPhoneReady": False,
                "phoneVerificationReady": True,
                "addPhoneError": "",
                "verifyError": "",
                "text": "输入我们刚刚向 +52 55 3196 6476 发送的验证码",
            }

    state = browser_register_module._derive_oauth_state_from_page(FakePage())

    assert state["page_type"] == "add_phone"
    assert state["current_url"] == "https://auth.openai.com/email-verification"


def test_existing_phone_otp_page_starts_sms_polling_without_resubmitting(monkeypatch):
    events = []

    class FakePage:
        url = "https://auth.openai.com/email-verification"

    class FixedPhoneCallback:
        def __init__(self):
            self.calls = 0
            self.completed = False

        def __call__(self):
            self.calls += 1
            if self.calls == 1:
                events.append(("number", "+525531966476"))
                return "+525531966476"
            if self.calls == 2:
                events.append(("sms_code", "received"))
                return "654321"
            raise AssertionError("unexpected phone callback call")

        def set_resend_callback(self, callback):
            self.resend_callback = callback

        def mark_send_succeeded(self):
            events.append("send_succeeded")

        def report_success(self):
            self.completed = True

    ready = {
        "phoneVerificationReady": True,
        "addPhoneError": "",
        "url": "https://auth.openai.com/email-verification",
        "text": "sent a code to +52 55 3196 6476",
    }
    monkeypatch.setattr(browser_register_module, "_phone_page_status", lambda page: dict(ready))
    monkeypatch.setattr(
        browser_register_module,
        "_wait_for_phone_verification_ready",
        lambda page, timeout: dict(ready),
    )
    monkeypatch.setattr(browser_register_module, "_extract_auth_error_text", lambda page: "")
    monkeypatch.setattr(
        browser_register_module,
        "_goto_with_retry",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not navigate back to add-phone")),
    )
    monkeypatch.setattr(
        browser_register_module,
        "_submit_phone_number_with_ui_retry",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not resubmit the phone number")),
    )
    monkeypatch.setattr(
        browser_register_module,
        "_submit_phone_otp_dom",
        lambda page, code, log: {
            "ok": True,
            "status": 200,
            "url": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
            "data": None,
        },
    )
    monkeypatch.setattr(
        browser_register_module,
        "_extract_flow_state",
        lambda data, url: {"page_type": "consent", "current_url": url},
    )
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda _seconds: None)

    callback = FixedPhoneCallback()
    result = browser_register_module._do_add_phone_attempt(
        FakePage(),
        callback,
        device_id="device-test",
        user_agent="Mozilla/5.0 Test",
        log=lambda message: events.append(message),
    )

    assert callback.calls == 2
    assert callback.completed is True
    assert ("sms_code", "received") in events
    assert "send_succeeded" in events
    assert any("直接开始接码" in str(event) for event in events)
    assert result["page_type"] == "consent"


def test_add_phone_ui_retries_same_number_without_recalling_number_callback(monkeypatch):
    events = []
    selections = iter([False, False, True])

    class FakePage:
        url = "https://auth.openai.com/add-phone"

    class FixedPhoneCallback:
        def __init__(self):
            self.calls = 0
            self.completed = False

        def __call__(self):
            self.calls += 1
            if self.calls == 1:
                events.append(("number", "+231770001686"))
                return "+231770001686"
            if self.calls == 2:
                events.append(("code", "received"))
                return "123456"
            raise AssertionError("UI retry must not request the phone callback again")

        def set_resend_callback(self, callback):
            self.resend_callback = callback

        def mark_send_succeeded(self):
            events.append("send_succeeded")

        def report_success(self):
            self.completed = True

    def select_country(page, dial_code, country_name, log):
        selected = next(selections)
        events.append(("select", dial_code, country_name, selected))
        return selected

    def goto(page, url, **kwargs):
        events.append(("goto", url))
        page.url = url

    def submit_phone(page, **kwargs):
        events.append(("submit", kwargs["phone_number"], kwargs["local_number"]))
        return {"ok": True, "selectedCountry": "LR", "channel": "sms"}

    monkeypatch.setattr(browser_register_module, "_select_phone_country_ui", select_country)
    monkeypatch.setattr(browser_register_module, "_goto_with_retry", goto)
    monkeypatch.setattr(browser_register_module, "_submit_add_phone_dom", submit_phone)
    monkeypatch.setattr(browser_register_module, "_browser_pause", lambda *args, **kwargs: None)
    monkeypatch.setattr(browser_register_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        browser_register_module,
        "_wait_for_phone_verification_ready",
        lambda page, timeout: {
            "phoneVerificationReady": True,
            "url": "https://auth.openai.com/phone-verification",
        },
    )
    monkeypatch.setattr(browser_register_module, "_extract_auth_error_text", lambda page: "")
    monkeypatch.setattr(
        browser_register_module,
        "_submit_phone_otp_dom",
        lambda page, code, log: {
            "ok": True,
            "status": 200,
            "url": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
            "data": None,
        },
    )
    monkeypatch.setattr(
        browser_register_module,
        "_extract_flow_state",
        lambda data, url: {"page_type": "consent", "current_url": url},
    )

    callback = FixedPhoneCallback()
    result = browser_register_module._do_add_phone_attempt(
        FakePage(),
        callback,
        device_id="device-test",
        user_agent="Mozilla/5.0 Test",
        log=lambda _message: None,
    )

    assert callback.calls == 2
    assert callback.completed is True
    assert [event for event in events if event[0] == "goto"] == [
        ("goto", "https://auth.openai.com/add-phone"),
        ("goto", "https://auth.openai.com/add-phone"),
    ]
    assert [event for event in events if event[0] == "submit"] == [
        ("submit", "+231770001686", "770001686")
    ]
    assert result["page_type"] == "consent"


def test_codex_oauth_returns_specific_phone_challenge_failure(monkeypatch):
    oauth_start = SimpleNamespace(
        auth_url="https://auth.openai.com/oauth/authorize?state=state-test",
        state="state-test",
    )
    page = SimpleNamespace(
        url=oauth_start.auth_url,
        evaluate=lambda script: "Mozilla/5.0 Test",
    )

    monkeypatch.setattr(
        browser_register_module,
        "_goto_with_retry",
        lambda page, url, **kwargs: setattr(page, "url", url),
    )
    monkeypatch.setattr(
        browser_register_module,
        "_derive_oauth_state_from_page",
        lambda page: {
            "page_type": "add_phone",
            "continue_url": "",
            "current_url": page.url,
        },
    )
    monkeypatch.setattr(browser_register_module, "_get_page_oauth_url", lambda page: "")
    monkeypatch.setattr(
        browser_register_module,
        "_handle_add_phone_challenge",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            RuntimeError("手机号 UI 提交失败（同一号码已自动尝试 3 次）")
        ),
    )

    result = browser_register_module._do_codex_oauth(
        page,
        {},
        "phone-failure@test.com",
        "TestPass123!",
        None,
        object(),
        None,
        lambda _message: None,
        oauth_start=oauth_start,
    )

    assert result == {
        "error": (
            "OpenAI 手机号验证失败: "
            "手机号 UI 提交失败（同一号码已自动尝试 3 次）"
        ),
        "phone_verification_failed": True,
    }


def test_phone_binder_preserves_specific_oauth_phone_failure(monkeypatch):
    class TrackingPhoneCallback:
        def __init__(self, entry, **kwargs):
            self.completed = False

        def cleanup(self):
            pass

    class FakeBrowserRegister:
        def __init__(self, **kwargs):
            pass

        def _retry_oauth_fresh_browser(self, email, password):
            return {
                "error": "OpenAI 手机号验证失败: 手机号国家选择失败: Liberia (+231)",
                "phone_verification_failed": True,
            }

    monkeypatch.setattr("application.phone_binding.SmsApiPhoneCallback", TrackingPhoneCallback)
    monkeypatch.setattr("platforms.chatgpt.browser_register.ChatGPTBrowserRegister", FakeBrowserRegister)
    monkeypatch.setattr(
        "platforms._browser_backend.parse_checkout_mode",
        lambda *args, **kwargs: SimpleNamespace(is_headless=False),
    )

    result = default_phone_binder(
        AccountRecord(
            id=11,
            platform="chatgpt",
            email="phone-failure@test.com",
            password="TestPass123!",
        ),
        PhoneBindEntry(
            "+231770001686",
            "https://relay.example.invalid/openai/relay-secret",
        ),
    )

    assert result["ok"] is False
    assert result["error"] == (
        "OpenAI 手机号验证失败: "
        "手机号国家选择失败: Liberia (+231)"
    )
