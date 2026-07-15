from __future__ import annotations

from types import SimpleNamespace

from core.base_platform import Account, RegisterConfig
from infrastructure.provider_settings_repository import ProviderSettingsRepository
from providers.captcha.local_solver import LocalSolverCaptcha
from platforms.windsurf.plugin import WindsurfPlatform
from platforms.windsurf.browser_register import WindsurfBrowserRegister
from platforms.windsurf.browser_register import WindsurfStripeCheckoutBrowser
from platforms.windsurf.browser_register import _extract_stripe_redirect_url
from platforms.windsurf.core import (
    WINDSURF_BASE,
    WindsurfClient,
    _field_bytes,
    _field_string,
    _field_varint,
    build_account_overview,
    parse_current_user_response,
    parse_plan_status_response,
    parse_post_auth_response,
    parse_subscribe_to_plan_response,
)
from platforms.windsurf.plugin import _default_name


def _plan_message(name: str = "Free") -> bytes:
    return b"".join([
        _field_varint(1, 19),
        _field_string(2, name),
        _field_varint(3, 1),
        _field_varint(7, 4096),
        _field_varint(8, 100),
        _field_varint(9, 2),
        _field_varint(10, 5000),
        _field_varint(12, 2500),
        _field_varint(13, 500),
    ])


def test_windsurf_post_auth_parser_extracts_session_context():
    payload = b"".join([
        _field_string(1, "devin-session-token$session"),
        _field_string(3, "auth1_result"),
        _field_string(4, "account-123"),
        _field_string(5, "org-456"),
    ])

    parsed = parse_post_auth_response(payload)

    assert parsed["session_token"] == "devin-session-token$session"
    assert parsed["auth_token"] == "auth1_result"
    assert parsed["account_id"] == "account-123"
    assert parsed["org_id"] == "org-456"


def test_windsurf_current_user_and_plan_status_parsers_build_quota_overview():
    user_message = b"".join([
        _field_string(2, "Windsurf User"),
        _field_string(3, "user@example.com"),
        _field_string(6, "user-123"),
        _field_string(7, "devin-team$account-123"),
    ])
    team_message = b"".join([
        _field_string(1, "devin-team$account-123"),
        _field_string(2, "My Team"),
    ])
    current_user_payload = b"".join([
        _field_bytes(1, user_message),
        _field_bytes(4, team_message),
        _field_bytes(6, _plan_message()),
    ])
    plan_status_payload = _field_bytes(
        1,
        b"".join([
            _field_bytes(1, _plan_message()),
            _field_varint(8, 2500),
            _field_varint(9, 500),
            _field_varint(14, 100),
            _field_varint(15, 80),
            _field_varint(18, 1777190400),
        ]),
    )

    current_user = parse_current_user_response(current_user_payload)
    plan_status = parse_plan_status_response(plan_status_payload)
    overview = build_account_overview(current_user=current_user, plan_status=plan_status)

    assert overview["valid"] is True
    assert overview["remote_email"] == "user@example.com"
    assert overview["plan_name"] == "Free"
    assert overview["plan_state"] == "free"
    assert overview["remaining_credits"] == "Prompt 100% / Flow 80%"
    assert overview["plan_credits"] == "Prompt 2500 / Flow 500"
    assert overview["usage_breakdowns"][0]["display_name"] == "Prompt Credits"
    assert overview["usage_breakdowns"][1]["remaining_usage"] == "80%"


def test_windsurf_subscribe_to_plan_parser_extracts_checkout_url():
    payload = _field_string(1, "https://checkout.stripe.com/c/pay/cs_live_test")

    parsed = parse_subscribe_to_plan_response(payload)

    assert parsed["checkout_url"] == "https://checkout.stripe.com/c/pay/cs_live_test"


def test_extract_stripe_redirect_url_prefers_alipay_redirect():
    payload = {
        "setup_intent": {
            "next_action": {
                "alipay_handle_redirect": {
                    "url": "https://pm-redirects.stripe.com/authorize/test",
                    "native_url": "alipay://native",
                }
            }
        }
    }

    assert _extract_stripe_redirect_url(payload) == "https://pm-redirects.stripe.com/authorize/test"


def test_extract_stripe_redirect_url_falls_back_to_redirect_to_url():
    payload = {
        "setup_intent": {
            "next_action": {
                "redirect_to_url": {
                    "url": "https://example.com/redirect",
                }
            }
        }
    }

    assert _extract_stripe_redirect_url(payload) == "https://example.com/redirect"


def test_windsurf_alipay_url_classification_distinguishes_intermediate_and_cashier():
    assert WindsurfStripeCheckoutBrowser._is_final_alipay_cashier_url("https://payauth.alipay.com/authorize.htm")
    assert WindsurfStripeCheckoutBrowser._is_final_alipay_cashier_url("https://mobilecodec.alipay.com/show.htm?foo=bar")
    assert not WindsurfStripeCheckoutBrowser._is_final_alipay_cashier_url("https://pm-redirects.stripe.com/authorize/test")
    assert not WindsurfStripeCheckoutBrowser._is_final_alipay_cashier_url("https://openapi.alipay.com/gateway.do?foo=bar")
    assert WindsurfStripeCheckoutBrowser._is_stripe_checkout_url("https://checkout.stripe.com/c/pay/cs_test")

    assert (
        WindsurfStripeCheckoutBrowser._next_intermediate_alipay_url(
            redirect_url="https://pm-redirects.stripe.com/authorize/test",
            gateway_url="",
            fallback_url="",
        )
        == "https://pm-redirects.stripe.com/authorize/test"
    )
    assert (
        WindsurfStripeCheckoutBrowser._next_intermediate_alipay_url(
            redirect_url="https://payauth.alipay.com/authorize.htm",
            gateway_url="https://openapi.alipay.com/gateway.do?foo=bar",
            fallback_url="",
        )
        == "https://openapi.alipay.com/gateway.do?foo=bar"
    )


def test_windsurf_subscribe_to_plan_uses_turnstile_token_in_referer(monkeypatch):
    captured: dict[str, object] = {}
    client = WindsurfClient(log_fn=lambda message: None)

    def _fake_proto_post(method: str, body: bytes, **kwargs):
        captured["method"] = method
        captured["body"] = body
        captured["kwargs"] = kwargs
        return _field_string(1, "https://checkout.stripe.com/c/pay/cs_test_windsurf")

    monkeypatch.setattr(client, "_proto_post", _fake_proto_post)

    client.subscribe_to_plan(
        "devin-session-token",
        account_id="account-123",
        org_id="org-456",
        turnstile_token="token.with+/symbols",
    )

    assert captured["method"] == "SubscribeToPlan"
    assert captured["kwargs"]["referer"].startswith("/billing/individual?plan=9&turnstile_token=")
    assert "token.with%2B%2Fsymbols" in captured["kwargs"]["referer"]
    assert WINDSURF_BASE


def test_protocol_captcha_candidates_include_local_solver_default(monkeypatch):
    monkeypatch.setattr(
        ProviderSettingsRepository,
        "list_enabled",
        lambda self, provider_type: [
            SimpleNamespace(provider_key="local_solver"),
            SimpleNamespace(provider_key="yescaptcha"),
            SimpleNamespace(provider_key="2captcha"),
        ],
    )
    monkeypatch.setattr(
        WindsurfPlatform,
        "_has_configured_captcha",
        lambda self, solver_name: solver_name in {"local_solver", "yescaptcha", "2captcha"},
    )

    platform = WindsurfPlatform(RegisterConfig(executor_type="protocol"))

    assert platform._get_captcha_solver_candidates() == ["local_solver", "yescaptcha", "2captcha"]


def test_windsurf_generate_trial_link_falls_back_to_next_turnstile_provider(monkeypatch):
    attempted: list[str] = []

    class FailingSolver:
        def solve_turnstile(self, page_url: str, site_key: str) -> str:
            raise RuntimeError("ERROR_ZERO_BALANCE")

    class WorkingSolver:
        def solve_turnstile(self, page_url: str, site_key: str) -> str:
            return "cf-turnstile-token"

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def check_pro_trial_eligibility(self, session_token: str, *, account_id: str = "", org_id: str = "") -> bool:
            return True

        def subscribe_to_plan(
            self,
            session_token: str,
            *,
            account_id: str = "",
            org_id: str = "",
            turnstile_token: str,
            success_url: str = "",
            cancel_url: str = "",
        ) -> dict[str, str]:
            assert turnstile_token == "cf-turnstile-token"
            return {"checkout_url": "https://checkout.stripe.com/c/pay/cs_test_windsurf"}

    monkeypatch.setattr(
        WindsurfPlatform,
        "_get_captcha_solver_candidates",
        lambda self: ["yescaptcha", "local_solver"],
    )

    def _fake_make_captcha(self, **kwargs):
        provider_key = str(kwargs.get("provider_key") or "")
        attempted.append(provider_key)
        if provider_key == "yescaptcha":
            return FailingSolver()
        if provider_key == "local_solver":
            return WorkingSolver()
        raise AssertionError(f"unexpected provider: {provider_key}")

    monkeypatch.setattr(WindsurfPlatform, "_make_captcha", _fake_make_captcha)

    import platforms.windsurf.core as windsurf_core

    monkeypatch.setattr(
        windsurf_core,
        "extract_windsurf_account_context",
        lambda account: {
            "session_token": "devin-session-token",
            "account_id": "account-123",
            "org_id": "org-456",
        },
    )
    monkeypatch.setattr(windsurf_core, "WindsurfClient", FakeClient)

    platform = WindsurfPlatform(RegisterConfig(executor_type="protocol"))
    account = Account(platform="windsurf", email="user@example.com", password="", token="devin-session-token")

    result = platform.execute_action("generate_trial_link", account, {})

    assert result["ok"] is True
    assert result["data"]["checkout_url"] == "https://checkout.stripe.com/c/pay/cs_test_windsurf"
    assert result["data"]["trial_eligible"] is True
    assert result["data"]["session_token"] == "devin-session-token"
    assert result["data"]["account_id"] == "account-123"
    assert attempted == ["yescaptcha", "local_solver"]


def test_windsurf_generate_trial_link_refreshes_session_after_subscribe_401(monkeypatch):
    calls: list[tuple[str, str]] = []

    class Solver:
        def solve_turnstile(self, page_url: str, site_key: str) -> str:
            return "cf-turnstile-token"

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def check_pro_trial_eligibility(self, session_token: str, *, account_id: str = "", org_id: str = "") -> bool:
            return True

        def post_auth(self, auth_token: str) -> dict[str, str]:
            assert auth_token == "auth1-old"
            return {
                "session_token": "devin-session-token-refreshed",
                "auth_token": "auth1-refreshed",
                "account_id": "account-refreshed",
                "org_id": "org-refreshed",
            }

        def subscribe_to_plan(
            self,
            session_token: str,
            *,
            account_id: str = "",
            org_id: str = "",
            turnstile_token: str,
            success_url: str = "",
            cancel_url: str = "",
        ) -> dict[str, str]:
            calls.append((session_token, account_id))
            if len(calls) == 1:
                raise RuntimeError('SubscribeToPlan 失败: HTTP 401 {"code":"unauthenticated"}')
            assert session_token == "devin-session-token-refreshed"
            assert account_id == "account-refreshed"
            assert org_id == "org-refreshed"
            return {"checkout_url": "https://checkout.stripe.com/c/pay/cs_test_refreshed"}

    monkeypatch.setattr(WindsurfPlatform, "_get_captcha_solver_candidates", lambda self: ["local_solver"])
    monkeypatch.setattr(WindsurfPlatform, "_make_captcha", lambda self, **kwargs: Solver())

    import platforms.windsurf.core as windsurf_core

    monkeypatch.setattr(
        windsurf_core,
        "extract_windsurf_account_context",
        lambda account: {
            "session_token": "devin-session-token-old",
            "auth_token": "auth1-old",
            "account_id": "account-old",
            "org_id": "org-old",
        },
    )
    monkeypatch.setattr(windsurf_core, "WindsurfClient", FakeClient)

    platform = WindsurfPlatform(RegisterConfig(executor_type="protocol"))
    account = Account(platform="windsurf", email="user@example.com", password="", token="devin-session-token-old")

    result = platform.execute_action("generate_trial_link", account, {})

    assert result["ok"] is True
    assert result["data"]["checkout_url"] == "https://checkout.stripe.com/c/pay/cs_test_refreshed"
    assert result["data"]["session_refreshed"] is True
    assert result["data"]["session_token"] == "devin-session-token-refreshed"
    assert result["data"]["account_id"] == "account-refreshed"
    assert calls == [("devin-session-token-old", "account-old"), ("devin-session-token-refreshed", "account-refreshed")]


def test_windsurf_payment_link_returns_checkout_only(monkeypatch):
    class Solver:
        def solve_turnstile(self, page_url: str, site_key: str) -> str:
            return "cf-turnstile-token"

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def check_pro_trial_eligibility(self, session_token: str, *, account_id: str = "", org_id: str = "") -> bool:
            return True

        def subscribe_to_plan(
            self,
            session_token: str,
            *,
            account_id: str = "",
            org_id: str = "",
            turnstile_token: str,
            success_url: str = "",
            cancel_url: str = "",
        ) -> dict[str, str]:
            return {"checkout_url": "https://checkout.stripe.com/c/pay/cs_test_windsurf"}

    import platforms.windsurf.core as windsurf_core
    monkeypatch.setattr(WindsurfPlatform, "_get_captcha_solver_candidates", lambda self: ["local_solver"])
    monkeypatch.setattr(WindsurfPlatform, "_make_captcha", lambda self, **kwargs: Solver())
    monkeypatch.setattr(
        windsurf_core,
        "extract_windsurf_account_context",
        lambda account: {
            "session_token": "devin-session-token",
            "auth_token": "auth1-token",
            "account_id": "account-123",
            "org_id": "org-456",
        },
    )
    monkeypatch.setattr(windsurf_core, "WindsurfClient", FakeClient)

    platform = WindsurfPlatform(RegisterConfig(executor_type="protocol"))
    account = Account(
        platform="windsurf",
        email="user@example.com",
        password="",
        token="devin-session-token",
        extra={"name": "User Example"},
    )

    result = platform.execute_action("payment_link", account, {})

    assert result["ok"] is True
    assert result["data"]["payment_channel"] == "checkout"
    assert result["data"]["cashier_url"] == "https://checkout.stripe.com/c/pay/cs_test_windsurf"
    assert result["data"]["checkout_url"] == "https://checkout.stripe.com/c/pay/cs_test_windsurf"
    assert result["data"]["trial_eligible"] is True


def test_windsurf_payment_link_browser_uses_checkout_ui_flow(monkeypatch):
    class Solver:
        def solve_turnstile(self, page_url: str, site_key: str) -> str:
            return "cf-turnstile-token"

    import platforms.windsurf.browser_register as browser_register

    monkeypatch.setattr(WindsurfPlatform, "_get_captcha_solver_candidates", lambda self: ["local_solver"])
    monkeypatch.setattr(WindsurfPlatform, "_make_captcha", lambda self, **kwargs: Solver())
    monkeypatch.setattr(
        browser_register,
        "generate_checkout_link_via_windsurf_ui",
        lambda **kwargs: {
            "checkout_url": "https://checkout.stripe.com/c/pay/cs_test_ui",
            "cashier_url": "https://checkout.stripe.com/c/pay/cs_test_ui",
            "url": "https://checkout.stripe.com/c/pay/cs_test_ui",
            "payment_channel": "checkout",
        },
    )

    platform = WindsurfPlatform(RegisterConfig(executor_type="protocol"))
    account = Account(
        platform="windsurf",
        email="user@example.com",
        password="secret-password",
        token="devin-session-token",
    )

    result = platform.execute_action("payment_link_browser", account, {})

    assert result["ok"] is True
    assert result["data"]["payment_channel"] == "checkout"
    assert result["data"]["cashier_url"] == "https://checkout.stripe.com/c/pay/cs_test_ui"
    assert result["data"]["checkout_url"] == "https://checkout.stripe.com/c/pay/cs_test_ui"
    assert result["data"]["message"] == "Windsurf Pro Trial Stripe 链接已生成"


def test_windsurf_payment_link_browser_can_return_checkout_only(monkeypatch):
    import platforms.windsurf.browser_register as browser_register

    monkeypatch.setattr(
        browser_register,
        "generate_checkout_link_via_windsurf_ui",
        lambda **kwargs: {
            "checkout_url": "https://checkout.stripe.com/c/pay/cs_test_checkout_only",
            "cashier_url": "https://checkout.stripe.com/c/pay/cs_test_checkout_only",
            "url": "https://checkout.stripe.com/c/pay/cs_test_checkout_only",
            "payment_channel": "checkout",
        },
    )

    platform = WindsurfPlatform(RegisterConfig(executor_type="protocol"))
    account = Account(
        platform="windsurf",
        email="user@example.com",
        password="secret-password",
        token="devin-session-token",
    )

    result = platform.execute_action("payment_link_browser", account, {"payment_channel": "checkout"})

    assert result["ok"] is True
    assert result["data"]["payment_channel"] == "checkout"
    assert result["data"]["cashier_url"] == "https://checkout.stripe.com/c/pay/cs_test_checkout_only"
    assert result["data"]["message"] == "Windsurf Pro Trial Stripe 链接已生成"


def test_local_solver_surfaces_unsolvable_error(monkeypatch):
    class FakeResponse:
        def __init__(self, payload: dict):
            self._payload = payload
            self.status_code = 200
            self.text = str(payload)

        def raise_for_status(self):
            pass

        def json(self):
            return self._payload

    calls = {"count": 0}

    def fake_get(url, params=None, timeout=0):
        calls["count"] += 1
        if url.endswith("/turnstile"):
            return FakeResponse({"taskId": "task-123"})
        return FakeResponse({
            "errorId": 1,
            "errorCode": "ERROR_CAPTCHA_UNSOLVABLE",
            "errorDescription": "Workers could not solve the Captcha",
        })

    import requests as requests_module
    import time as time_module

    monkeypatch.setattr(requests_module, "get", fake_get)
    monkeypatch.setattr(time_module, "sleep", lambda seconds: None)

    solver = LocalSolverCaptcha("http://localhost:8889")

    try:
        solver.solve_turnstile("https://windsurf.com/billing/individual?plan=9", "sitekey")
    except RuntimeError as exc:
        assert "Workers could not solve the Captcha" in str(exc)
    else:
        raise AssertionError("expected LocalSolver error")
    assert calls["count"] == 2


def test_windsurf_default_name_strips_digits_from_email_localpart():
    assert _default_name("SampleUser1@example.com") == "Sampleuser"
    assert _default_name("123456@test.com") == "Windsurf User"


def test_windsurf_browser_split_name_sanitizes_non_letters():
    assert WindsurfBrowserRegister._split_name("SampleUser1") == ("Sampleuser", "User")
    assert WindsurfBrowserRegister._split_name("a1b2 c3d4") == ("Ab", "Cd")
    assert WindsurfBrowserRegister._split_name("1234") == ("Windsurf", "User")
