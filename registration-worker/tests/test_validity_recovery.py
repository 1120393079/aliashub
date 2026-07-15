from __future__ import annotations

import base64
import json

import pytest
from sqlmodel import Session, select

from application.account_checks import AccountChecksService
from application.tasks import _run_single_account_check
from core.account_graph import patch_account_graph
from core.base_platform import RegisterConfig
from core.db import AccountModel, AccountOverviewModel, engine
from core.lifecycle import check_accounts_validity, refresh_and_sync_cpa
from core.proxy_pool import proxy_pool
from platforms.chatgpt import payment
from platforms.chatgpt.plugin import ChatGPTPlatform, _fetch_authenticated_session_status_details


class _AlwaysValidPlatform:
    def __init__(self, config: RegisterConfig | None = None):
        self.config = config

    def check_valid(self, account) -> bool:
        return True


class _AlwaysInvalidPlatform:
    def __init__(self, config: RegisterConfig | None = None):
        self.config = config

    def check_valid(self, account) -> bool:
        return False


class _InconclusivePlatform:
    def __init__(self, config: RegisterConfig | None = None):
        self.config = config

    def check_valid(self, account) -> bool:
        raise RuntimeError("temporary upstream failure")


def _create_account(*, platform: str = "chatgpt", lifecycle_status: str = "registered") -> int:
    with Session(engine) as session:
        model = AccountModel(platform=platform, email=f"{platform}@example.com", password="secret")
        session.add(model)
        session.commit()
        session.refresh(model)
        patch_account_graph(
            session,
            model,
            lifecycle_status=lifecycle_status,
            summary_updates={"valid": lifecycle_status != "invalid"},
        )
        session.commit()
        return int(model.id or 0)


def _overview(account_id: int):
    with Session(engine) as session:
        return session.exec(
            select(AccountOverviewModel).where(AccountOverviewModel.account_id == account_id)
        ).one()


def _unsigned_jwt(payload: dict) -> str:
    def encode(value: dict) -> str:
        return base64.urlsafe_b64encode(
            json.dumps(value, separators=(",", ":")).encode()
        ).decode().rstrip("=")

    return f"{encode({'alg': 'none'})}.{encode(payload)}.signature"


class _JsonResponse:
    def __init__(self, payload, *, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


def _accounts_check_payload(
    account_id: str,
    *,
    account_plan: str,
    entitlement_plan: str,
    active: bool,
) -> dict:
    return {
        "accounts": {
            account_id: {
                "account": {"plan_type": account_plan},
                "entitlement": {
                    "has_active_subscription": active,
                    "subscription_plan": entitlement_plan,
                },
                "last_active_subscription": {"will_renew": active},
            },
            "default": {"account": {"plan_type": "free"}},
        },
        "account_ordering": [account_id],
    }


def test_single_account_check_recovers_previously_invalid_account(monkeypatch):
    account_id = _create_account(lifecycle_status="invalid")
    monkeypatch.setattr("application.tasks.get", lambda _platform: _AlwaysValidPlatform)

    valid, result = _run_single_account_check(account_id)

    assert valid is True
    assert result["valid"] is True
    overview = _overview(account_id)
    assert overview.lifecycle_status == "registered"
    assert overview.validity_status == "valid"
    assert overview.display_status == "registered"
    assert overview.checked_at


def test_single_account_check_keeps_state_when_detection_is_inconclusive(monkeypatch):
    account_id = _create_account(lifecycle_status="registered")
    before = _overview(account_id)
    monkeypatch.setattr("application.tasks.get", lambda _platform: _InconclusivePlatform)

    with pytest.raises(RuntimeError, match="temporary upstream failure"):
        _run_single_account_check(account_id)

    after = _overview(account_id)
    assert after.lifecycle_status == before.lifecycle_status == "registered"
    assert after.validity_status == before.validity_status == "valid"
    assert after.checked_at == before.checked_at


def test_single_account_check_passes_the_account_proxy_to_the_platform(monkeypatch):
    account_id = _create_account(platform="proxy-aware", lifecycle_status="registered")
    captured = {}

    class ProxyAwarePlatform:
        def __init__(self, config: RegisterConfig | None = None):
            captured["proxy"] = config.proxy if config else None

        def check_valid(self, account) -> bool:
            return True

        def get_last_check_overview(self) -> dict:
            return {"plan_state": "free", "plan_name": "free", "check_source": "test"}

    monkeypatch.setattr("application.tasks.get", lambda _platform: ProxyAwarePlatform)

    valid, _result = _run_single_account_check(
        account_id,
        proxy_url="http://proxy-user:proxy-password@proxy.example:8080",
    )

    assert valid is True
    assert captured["proxy"] == "http://proxy-user:proxy-password@proxy.example:8080"


def test_single_account_check_does_not_persist_unobserved_inferred_plan(monkeypatch):
    account_id = _create_account(lifecycle_status="registered")
    with Session(engine) as session:
        model = session.get(AccountModel, account_id)
        patch_account_graph(
            session,
            model,
            summary_updates={
                "plan": "free",
                "plan_name": "free",
                "plan_state": "free",
                "account_type": "free",
                "account_type_raw": "free",
                "account_type_source": "backend-api/accounts/check+subscriptions",
            },
        )
        session.commit()

    class InferredPlanPlatform:
        def __init__(self, config: RegisterConfig | None = None):
            self.config = config

        def check_valid(self, account) -> bool:
            return True

        def get_last_check_overview(self) -> dict:
            return {
                "plan": "plus",
                "plan_name": "plus",
                "plan_state": "subscribed",
                "account_type": "plus",
                "account_type_raw": "plus",
                "account_type_source": "matching_access_token_claim",
                "type_observed": False,
                "plan_detection_result": "inferred",
                "plan_authority": "jwt",
                "account_type_confidence": "low",
                "detection_result": "confirmed",
            }

    monkeypatch.setattr("application.tasks.get", lambda _platform: InferredPlanPlatform)

    valid, result = _run_single_account_check(account_id)

    assert valid is True
    assert result["account_type"] == "plus"
    assert result["type_observed"] is False
    assert result["plan_detection_result"] == "inferred"
    overview = _overview(account_id)
    assert overview.plan_name == "free"
    assert overview.plan_state == "free"


def test_lifecycle_validity_check_does_not_overwrite_lifecycle_status(monkeypatch):
    account_id = _create_account(lifecycle_status="registered")
    monkeypatch.setattr("core.lifecycle.get", lambda _platform: _AlwaysInvalidPlatform)

    results = check_accounts_validity(platform="chatgpt", limit=10)

    assert results["invalid"] == 1
    overview = _overview(account_id)
    assert overview.lifecycle_status == "registered"
    assert overview.validity_status == "invalid"
    assert overview.display_status == "invalid"
    assert overview.checked_at


@pytest.mark.parametrize(
    ("raw_plan", "family"),
    [
        pytest.param("ChatGPT Free Plan", "free", id="free"),
        pytest.param("chatgpt-go-plan", "go", id="go"),
        pytest.param("ChatGPT Plus Plan", "plus", id="plus"),
        pytest.param("chatgpt_pro_plan", "pro", id="pro"),
        pytest.param("ChatGPT Team Plan", "team", id="team"),
        pytest.param("chatgpt-business-plan", "business", id="business"),
        pytest.param("ChatGPT Enterprise Plan", "enterprise", id="enterprise"),
        pytest.param("chatgpt_edu_plan", "edu", id="edu"),
        pytest.param("trialing", "trial", id="trial"),
    ],
)
def test_chatgpt_plan_family_recognizes_every_supported_type(raw_plan, family):
    assert payment._recognized_subscription_plan(raw_plan) == family


@pytest.mark.parametrize("raw_plan", ["unpaid", "not_paid", "profile", "professional"])
def test_chatgpt_plan_family_does_not_match_paid_word_fragments(raw_plan):
    assert payment._recognized_subscription_plan(raw_plan) is None
    assert payment._normalize_subscription_plan(raw_plan) == "other"


def test_chatgpt_subscription_status_falls_back_to_wham_usage(monkeypatch):
    captured_headers: dict[str, str] = {}

    class _Resp:
        def __init__(self, data=None, error: Exception | None = None):
            self._data = data
            self._error = error

        def raise_for_status(self):
            if self._error:
                raise self._error

        def json(self):
            return self._data

    def _fake_get(url, **kwargs):
        if url.endswith("/backend-api/me"):
            return _Resp(error=RuntimeError("403"))
        if url in {payment.ACCOUNTS_CHECK_URL, payment.SUBSCRIPTIONS_URL}:
            return _JsonResponse({}, status_code=503)
        captured_headers.update(kwargs.get("headers") or {})
        return _Resp(data={"plan_type": "free", "account_id": "acct-123"})

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    account = type(
        "AccountStub",
        (),
        {
            "access_token": "token",
            "cookies": "",
            "id_token": json.dumps({"chatgpt_account_id": "acct-123"}),
            "extra": {},
        },
    )()

    status = payment.check_subscription_status(account)

    assert status == "free"
    assert captured_headers["Authorization"] == "Bearer token"
    assert captured_headers["Chatgpt-Account-Id"] == "acct-123"


def test_chatgpt_subscription_status_prefers_workspace_usage_plan(monkeypatch):
    class _Resp:
        def __init__(self, data):
            self._data = data

        def raise_for_status(self):
            return None

        def json(self):
            return self._data

    def _fake_get(url, **_kwargs):
        if url in {payment.ACCOUNTS_CHECK_URL, payment.SUBSCRIPTIONS_URL}:
            return _JsonResponse({}, status_code=503)
        if url.endswith("/backend-api/me"):
            return _Resp({"plan_type": "free", "orgs": {"data": []}})
        return _Resp({
            "plan_type": "plus",
            "account_id": "acct-plus",
            "rate_limit": {"allowed": True},
        })

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    account = type(
        "AccountStub",
        (),
        {
            "access_token": "token",
            "cookies": "",
            "id_token": json.dumps({"chatgpt_account_id": "acct-plus"}),
            "extra": {},
        },
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["status"] == "plus"
    assert details["source"] == "backend-api/wham/usage"
    assert details["usage"]["plan_type"] == "plus"


def test_chatgpt_accounts_check_active_plus_is_high_authority(monkeypatch):
    account_id = "acct-authoritative-plus"
    calls: list[tuple[str, dict]] = []

    def _fake_get(url, **kwargs):
        calls.append((url, kwargs))
        if url == payment.ACCOUNTS_CHECK_URL:
            return _JsonResponse(_accounts_check_payload(
                account_id,
                account_plan="plus",
                entitlement_plan="chatgptplusplan",
                active=True,
            ))
        if url == payment.SUBSCRIPTIONS_URL:
            return _JsonResponse({
                "id": account_id,
                "plan_type": "plus",
                "will_renew": True,
                "is_delinquent": False,
            })
        raise AssertionError(f"unexpected weaker endpoint: {url}")

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    account = type(
        "AccountStub",
        (),
        {"access_token": "token", "id_token": "", "extra": {"account_id": account_id}},
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["account_type"] == "plus"
    assert details["subscription_status"] == "active"
    assert details["account_type_source"] == "backend-api/accounts/check"
    assert details["type_observed"] is True
    assert details["plan_detection_result"] == "confirmed"
    assert details["plan_authority"] == "authoritative"
    assert details["account_type_confidence"] == "high"
    assert [url for url, _kwargs in calls] == [
        payment.ACCOUNTS_CHECK_URL,
        payment.SUBSCRIPTIONS_URL,
    ]
    for _url, kwargs in calls:
        assert kwargs["headers"]["Chatgpt-Account-Id"] == account_id
        assert kwargs["headers"]["Authorization"] == "Bearer token"


def test_chatgpt_subscriptions_plus_beats_unconfirmed_accounts_free(monkeypatch):
    account_id = "acct-subscription-plus"

    def _fake_get(url, **_kwargs):
        if url == payment.ACCOUNTS_CHECK_URL:
            return _JsonResponse(_accounts_check_payload(
                account_id,
                account_plan="free",
                entitlement_plan="chatgptfreeplan",
                active=False,
            ))
        if url == payment.SUBSCRIPTIONS_URL:
            return _JsonResponse({
                "account_id": account_id,
                "plan_type": "plus",
                "will_renew": True,
                "is_delinquent": False,
            })
        raise AssertionError(f"unexpected endpoint: {url}")

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    account = type(
        "AccountStub",
        (),
        {"access_token": "token", "id_token": "", "extra": {"account_id": account_id}},
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["account_type"] == "plus"
    assert details["account_type_source"] == "backend-api/subscriptions"
    assert details["type_observed"] is True
    assert details["plan_conflict"] is True


def test_chatgpt_free_requires_inactive_entitlement_and_no_subscription(monkeypatch):
    account_id = "acct-authoritative-free"

    def _fake_get(url, **_kwargs):
        if url == payment.ACCOUNTS_CHECK_URL:
            return _JsonResponse(_accounts_check_payload(
                account_id,
                account_plan="free",
                entitlement_plan="chatgptfreeplan",
                active=False,
            ))
        if url == payment.SUBSCRIPTIONS_URL:
            return _JsonResponse(
                {"detail": "No subscription found for account"},
                status_code=404,
            )
        raise AssertionError(f"unexpected endpoint: {url}")

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    account = type(
        "AccountStub",
        (),
        {"access_token": "token", "id_token": "", "extra": {"account_id": account_id}},
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["account_type"] == "free"
    assert details["subscription_status"] == "free"
    assert details["account_type_source"] == "backend-api/accounts/check+subscriptions"
    assert details["type_observed"] is True
    assert details["plan_authority"] == "authoritative"


def test_chatgpt_accounts_check_never_borrows_default_workspace(monkeypatch):
    account_id = "acct-exact-node"

    def _fake_get(url, **_kwargs):
        if url == payment.ACCOUNTS_CHECK_URL:
            return _JsonResponse({
                "accounts": {
                    "default": {
                        "account": {"plan_type": "plus"},
                        "entitlement": {
                            "has_active_subscription": True,
                            "subscription_plan": "chatgptplusplan",
                        },
                    },
                },
            })
        if url == payment.SUBSCRIPTIONS_URL:
            return _JsonResponse({}, status_code=503)
        if url == payment.WHAM_USAGE_URL:
            return _JsonResponse({"account_id": account_id, "plan_type": "free"})
        raise AssertionError(f"unexpected endpoint: {url}")

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    monkeypatch.setattr(payment.time, "sleep", lambda _seconds: None)
    account = type(
        "AccountStub",
        (),
        {"access_token": "token", "id_token": "", "extra": {"account_id": account_id}},
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["account_type"] == "free"
    assert details["account_type_source"] == "backend-api/wham/usage"
    assert details["plan_authority"] == "verified"


def test_chatgpt_wham_retries_then_returns_exact_workspace_plus(monkeypatch):
    account_id = "acct-wham-retry"
    wham_calls = 0
    sleeps: list[float] = []

    def _fake_get(url, **_kwargs):
        nonlocal wham_calls
        if url in {payment.ACCOUNTS_CHECK_URL, payment.SUBSCRIPTIONS_URL}:
            return _JsonResponse({}, status_code=503)
        if url == payment.WHAM_USAGE_URL:
            wham_calls += 1
            if wham_calls < 3:
                return _JsonResponse({}, status_code=503)
            return _JsonResponse({"account_id": account_id, "plan_type": "plus"})
        raise AssertionError(f"unexpected endpoint: {url}")

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    monkeypatch.setattr(payment.time, "sleep", sleeps.append)
    account = type(
        "AccountStub",
        (),
        {"access_token": "token", "id_token": "", "extra": {"account_id": account_id}},
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["account_type"] == "plus"
    assert details["account_type_source"] == "backend-api/wham/usage"
    assert details["type_observed"] is True
    assert wham_calls == 3
    assert sleeps[-2:] == list(payment.WHAM_USAGE_RETRY_DELAYS)


def test_chatgpt_missing_me_plan_and_failed_wham_is_inconclusive(monkeypatch):
    account_id = "acct-no-live-plan"
    wham_calls = 0

    def _fake_get(url, **_kwargs):
        nonlocal wham_calls
        if url in {payment.ACCOUNTS_CHECK_URL, payment.SUBSCRIPTIONS_URL}:
            return _JsonResponse({}, status_code=503)
        if url == payment.WHAM_USAGE_URL:
            wham_calls += 1
            return _JsonResponse({}, status_code=503)
        if url.endswith("/backend-api/me"):
            return _JsonResponse({"plan_type": None, "orgs": {"data": []}})
        raise AssertionError(f"unexpected endpoint: {url}")

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    monkeypatch.setattr(payment.time, "sleep", lambda _seconds: None)
    account = type(
        "AccountStub",
        (),
        {"access_token": "token", "id_token": "", "extra": {"account_id": account_id}},
    )()

    with pytest.raises(payment.StatusCheckInconclusiveError) as caught:
        payment.fetch_subscription_status_details(account)

    assert caught.value.code == "upstream_unavailable"
    assert caught.value.source == "backend-api/wham/usage"
    assert caught.value.retryable is True
    assert wham_calls == payment.WHAM_USAGE_MAX_ATTEMPTS


def test_chatgpt_subscription_status_falls_back_to_me_when_usage_omits_plan(monkeypatch):
    class _Resp:
        def __init__(self, data):
            self._data = data

        def raise_for_status(self):
            return None

        def json(self):
            return self._data

    def _fake_get(url, **_kwargs):
        if url in {payment.ACCOUNTS_CHECK_URL, payment.SUBSCRIPTIONS_URL}:
            return _JsonResponse({}, status_code=503)
        if url.endswith("/backend-api/me"):
            return _Resp({"plan_type": "plus"})
        return _Resp({"account_id": "acct-me-fallback"})

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    account = type(
        "AccountStub",
        (),
        {
            "access_token": "token",
            "cookies": "",
            "id_token": "",
            "extra": {"account_id": "acct-me-fallback"},
        },
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["status"] == "plus"
    assert details["source"] == "backend-api/me"


def test_chatgpt_unknown_plan_preserves_its_raw_code(monkeypatch):
    account_id = "acct-future-plan"

    def _fake_get(url, **_kwargs):
        if url in {payment.ACCOUNTS_CHECK_URL, payment.SUBSCRIPTIONS_URL}:
            return _JsonResponse({}, status_code=503)
        if url == payment.WHAM_USAGE_URL:
            return _JsonResponse({"plan_type": "future_ultra", "account_id": account_id})
        return _JsonResponse({"plan_type": "future_ultra", "orgs": {"data": []}})

    monkeypatch.setattr(
        payment.cffi_requests,
        "get",
        _fake_get,
    )
    account = type(
        "AccountStub",
        (),
        {
            "access_token": "token",
            "id_token": "",
            "extra": {"account_id": account_id},
        },
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["status"] == "other"
    assert details["account_type"] == "other"
    assert details["account_type_raw"] == "future_ultra"
    assert details["subscription_status"] == "unknown"


def test_chatgpt_check_valid_does_not_confirm_free_from_matching_token(monkeypatch):
    monkeypatch.setattr(
        payment,
        "fetch_subscription_status_details",
        lambda *_args, **_kwargs: {
            "status": "unknown",
            "account_type": "unknown",
            "account_type_raw": "",
            "account_status": "active",
            "credential_status": "valid",
            "subscription_status": "unknown",
            "detection_result": "confirmed",
            "status_code": "ok",
            "status_reason": "状态检测成功",
            "source": "backend-api/me",
        },
    )
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": None)
    access_token = _unsigned_jwt({
        "exp": 4_102_444_800,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "workspace-new",
            "chatgpt_plan_type": "free",
        },
    })
    account = type(
        "AccountStub",
        (),
        {
            "token": access_token,
            "email": "new-free@example.com",
            "user_id": "workspace-new",
            "region": "",
            "extra": {"access_token": access_token, "account_id": "workspace-new"},
        },
    )()
    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None

    assert plugin.check_valid(account) is True
    overview = plugin.get_last_check_overview()
    assert overview["account_type"] == "unknown"
    assert overview["account_type_raw"] == ""
    assert overview["type_observed"] is False
    assert overview["plan_detection_result"] == "inconclusive"
    assert overview["subscription_status"] == "unknown"
    assert overview["status_code"] == "plan_not_confirmed"


def test_chatgpt_matching_paid_token_is_inferred_not_observed(monkeypatch):
    monkeypatch.setattr(
        payment,
        "fetch_subscription_status_details",
        lambda *_args, **_kwargs: {
            "status": "unknown",
            "account_type": "unknown",
            "account_type_raw": "",
            "type_observed": False,
            "plan_detection_result": "inconclusive",
            "account_status": "active",
            "credential_status": "valid",
            "subscription_status": "unknown",
            "detection_result": "confirmed",
            "status_code": "ok",
            "source": "backend-api/me",
        },
    )
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": None)
    access_token = _unsigned_jwt({
        "exp": 4_102_444_800,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "workspace-jwt-plus",
            "chatgpt_plan_type": "plus",
        },
    })
    account = type(
        "AccountStub",
        (),
        {
            "token": access_token,
            "email": "jwt-plus@example.com",
            "user_id": "workspace-jwt-plus",
            "region": "",
            "extra": {
                "access_token": access_token,
                "account_id": "workspace-jwt-plus",
            },
        },
    )()
    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None

    assert plugin.check_valid(account) is True
    overview = plugin.get_last_check_overview()
    assert overview["account_type"] == "plus"
    assert overview["account_type_source"] == "matching_access_token_claim"
    assert overview["type_observed"] is False
    assert overview["plan_detection_result"] == "inferred"
    assert overview["plan_authority"] == "jwt"
    assert overview["account_type_confidence"] == "low"
    assert overview["subscription_status"] == "unknown"
    assert overview["status_code"] == "plan_inferred_from_token"


def test_chatgpt_matching_free_claim_does_not_override_confirmed_paid_plan(monkeypatch):
    monkeypatch.setattr(
        payment,
        "fetch_subscription_status_details",
        lambda *_args, **_kwargs: {
            "status": "unknown",
            "account_type": "unknown",
            "account_status": "active",
            "credential_status": "valid",
            "subscription_status": "unknown",
            "status_code": "ok",
            "source": "backend-api/me",
        },
    )
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": None)
    access_token = _unsigned_jwt({
        "exp": 4_102_444_800,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "workspace-paid",
            "chatgpt_plan_type": "free",
        },
    })
    account = type(
        "AccountStub",
        (),
        {
            "token": access_token,
            "email": "paid@example.com",
            "user_id": "workspace-paid",
            "region": "",
            "extra": {
                "access_token": access_token,
                "account_id": "workspace-paid",
                "account_overview": {
                    "plan_override": "plus",
                    "plan_override_source": "user_confirmed",
                    "plan_name": "plus",
                    "account_type": "plus",
                },
            },
        },
    )()
    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None

    assert plugin.check_valid(account) is True
    overview = plugin.get_last_check_overview()
    assert overview["account_type"] == "plus"
    assert overview["account_type_source"] == "last_confirmed_plan"
    assert overview["type_observed"] is False
    assert overview["plan_detection_result"] == "inconclusive"
    assert "plan_override" not in overview


@pytest.mark.parametrize("account_id_source", ["extra", "access-jwt"])
def test_wham_usage_uses_extra_or_access_jwt_account_id_header(monkeypatch, account_id_source):
    expected_account_id = f"acct-{account_id_source}"
    captured_headers = {}

    def _fake_get(_url, **kwargs):
        captured_headers.update(kwargs.get("headers") or {})
        return _JsonResponse({"plan_type": "plus", "account_id": expected_account_id})

    monkeypatch.setattr(payment.cffi_requests, "get", _fake_get)
    access_token = "opaque-token"
    extra = {}
    if account_id_source == "extra":
        extra["account_id"] = expected_account_id
    else:
        access_token = _unsigned_jwt({
            "https://api.openai.com/auth": {"chatgpt_account_id": expected_account_id},
        })
    account = type(
        "AccountStub",
        (),
        {"access_token": access_token, "id_token": "", "extra": extra},
    )()

    result = payment._fetch_usage_data(account)

    assert result["plan_type"] == "plus"
    assert captured_headers["Chatgpt-Account-Id"] == expected_account_id
    assert captured_headers["Authorization"] == f"Bearer {access_token}"


def test_wham_usage_account_id_mismatch_is_inconclusive(monkeypatch):
    monkeypatch.setattr(
        payment.cffi_requests,
        "get",
        lambda *_args, **_kwargs: _JsonResponse(
            {"plan_type": "plus", "account_id": "acct-other"}
        ),
    )
    account = type(
        "AccountStub",
        (),
        {
            "access_token": "token",
            "id_token": "",
            "extra": {"account_id": "acct-expected"},
        },
    )()

    with pytest.raises(payment.StatusCheckInconclusiveError) as caught:
        payment._fetch_usage_data(account)

    assert caught.value.code == "account_identity_mismatch"
    assert caught.value.retryable is False
    assert caught.value.source == "backend-api/wham/usage"
    assert caught.value.evidence_path == "response.account_id"


@pytest.mark.parametrize("paid_plan", ["plus", "pro", "business", "enterprise"])
def test_chatgpt_me_paid_plan_is_used_when_stronger_sources_are_unavailable(monkeypatch, paid_plan):
    monkeypatch.setattr(
        payment.cffi_requests,
        "get",
        lambda url, **_kwargs: _JsonResponse(
            {"plan_type": paid_plan, "orgs": {"data": []}}
            if url.endswith("/backend-api/me")
            else {"plan_type": "free"}
        ),
    )
    account = type(
        "AccountStub",
        (),
        {"access_token": "token", "id_token": "", "extra": {}},
    )()

    details = payment.fetch_subscription_status_details(account)

    assert details["account_type"] == paid_plan
    assert details["account_type_raw"] == paid_plan
    assert details["source"] == "backend-api/me"
    assert details["status_code"] == "ok"
    assert details["type_observed"] is True
    assert details["plan_authority"] == "weak"
    assert details["account_type_confidence"] == "low"


@pytest.mark.parametrize(
    ("code", "account_state", "credential_state"),
    [
        pytest.param("account_disabled", "disabled", "unknown", id="account-disabled"),
        pytest.param("access_token_expired", "unknown", "expired", id="token-expired"),
    ],
)
def test_conclusive_failures_keep_account_and_credential_axes_separate(
    code,
    account_state,
    credential_state,
):
    evidence = payment._conclusive_account_failure(
        _JsonResponse({"error": {"code": code}}, status_code=403),
        source="backend-api/me",
    )

    assert evidence is not None
    assert evidence.code == code
    assert evidence.account_state == account_state
    assert evidence.credential_state == credential_state
    assert evidence.retryable is False


def test_chatgpt_check_valid_uses_proxy_pool_before_direct(monkeypatch):
    calls: list[str | None] = []
    proxy_events: list[tuple[str, str]] = []

    def _fake_status(account, proxy=None):
        calls.append(proxy)
        if proxy != "http://127.0.0.1:7890":
            raise RuntimeError("should use proxy first")
        return {
            "status": "free",
            "source": "backend-api/wham/usage",
            "usage": {"plan_type": "free"},
        }

    monkeypatch.setattr(payment, "fetch_subscription_status_details", _fake_status)
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": "http://127.0.0.1:7890")
    monkeypatch.setattr(proxy_pool, "report_success", lambda url: proxy_events.append(("success", url)))
    monkeypatch.setattr(proxy_pool, "report_fail", lambda url: proxy_events.append(("fail", url)))

    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None
    account = type(
        "AccountStub",
        (),
        {
            "token": "token",
            "region": "",
            "extra": {
                "access_token": "token",
                "id_token": "",
                "cookies": "",
            },
        },
    )()

    assert plugin.check_valid(account) is True
    assert calls == ["http://127.0.0.1:7890"]
    assert proxy_events == [("success", "http://127.0.0.1:7890")]
    assert plugin.get_last_check_overview()["chatgpt_usage"] == {"plan_type": "free"}


def test_expired_subscription_keeps_the_account_valid(monkeypatch):
    monkeypatch.setattr(
        payment,
        "fetch_subscription_status_details",
        lambda *_args, **_kwargs: {
            "status": "plus",
            "account_type": "plus",
            "account_type_raw": "chatgptplusplan",
            "account_type_source": "backend-api/me",
            "account_status": "active",
            "credential_status": "valid",
            "subscription_status": "expired",
            "detection_result": "confirmed",
            "status_code": "subscription_expired",
            "status_reason": "付费订阅已过期，账号登录状态仍有效",
            "status_retryable": False,
            "source": "backend-api/me",
        },
    )
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": None)
    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None
    account = type(
        "AccountStub",
        (),
        {
            "token": "token",
            "email": "expired-plan@example.com",
            "user_id": "workspace-1",
            "region": "",
            "extra": {
                "access_token": "token",
                "account_overview": {"account_type": "plus", "plan_state": "subscribed"},
            },
        },
    )()

    assert plugin.check_valid(account) is True
    overview = plugin.get_last_check_overview()
    assert overview["account_status"] == "active"
    assert overview["credential_status"] == "valid"
    assert overview["subscription_status"] == "expired"
    assert overview["account_type"] == "plus"
    assert overview["plan_state"] == "expired"
    assert overview["status_code"] == "subscription_expired"


def test_chatgpt_check_valid_does_not_turn_proxy_and_direct_errors_into_invalid(monkeypatch):
    calls: list[str | None] = []
    proxy_events: list[tuple[str, str]] = []

    def _failed_status(account, proxy=None):
        calls.append(proxy)
        raise RuntimeError("429 or temporary network failure")

    monkeypatch.setattr(payment, "fetch_subscription_status_details", _failed_status)
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": "http://127.0.0.1:7890")
    monkeypatch.setattr(proxy_pool, "report_fail", lambda url: proxy_events.append(("fail", url)))

    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None
    account = type(
        "AccountStub",
        (),
        {
            "token": "token",
            "region": "",
            "extra": {
                "access_token": "token",
                "id_token": "",
                "cookies": "",
            },
        },
    )()

    with pytest.raises(payment.StatusCheckInconclusiveError, match="频率受限") as caught:
        plugin.check_valid(account)

    assert caught.value.code == "rate_limited"
    assert caught.value.retryable is True
    assert calls == ["http://127.0.0.1:7890", None]
    assert proxy_events == [("fail", "http://127.0.0.1:7890")]
    assert plugin.get_last_check_overview() == {}


def test_chatgpt_check_valid_uses_matching_authenticated_session_as_fallback(monkeypatch):
    monkeypatch.setattr(
        payment,
        "fetch_subscription_status_details",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("bearer API returned 401")),
    )
    monkeypatch.setattr(
        "platforms.chatgpt.plugin._fetch_authenticated_session_status_details",
        lambda account, proxy=None: {
            "status": "free",
            "source": "api/auth/session+jwt",
            "session_valid": True,
        },
    )
    monkeypatch.setattr(proxy_pool, "get_next", lambda region="": None)
    plugin = ChatGPTPlatform.__new__(ChatGPTPlatform)
    plugin.config = RegisterConfig()
    plugin.mailbox = None
    account = type(
        "AccountStub",
        (),
        {
            "token": "token",
            "email": "session@example.com",
            "user_id": "workspace-1",
            "region": "",
            "extra": {
                "access_token": "token",
                "session_token": "session-token",
                "account_id": "workspace-1",
            },
        },
    )()

    assert plugin.check_valid(account) is True
    overview = plugin.get_last_check_overview()
    assert overview["account_status"] == "active"
    assert overview["credential_status"] == "valid"
    assert overview["session_valid"] is True
    assert overview["account_type"] == "unknown"
    assert overview["account_type_raw"] == ""
    assert overview["account_type_source"] == "session_jwt_free_unconfirmed"
    assert overview["type_observed"] is False
    assert overview["plan_detection_result"] == "inconclusive"
    assert overview["status_code"] == "plan_not_confirmed"
    assert overview["status_retryable"] is True


def test_authenticated_session_fallback_requires_exact_email_and_workspace(monkeypatch):
    access_token = _unsigned_jwt({
        "email": "session@example.com",
        "exp": 4_102_444_800,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "workspace-1",
            "chatgpt_plan_type": "free",
        },
    })

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"user": {"email": "session@example.com"}, "accessToken": access_token}

    class Cookies:
        def set(self, *_args, **_kwargs):
            return None

    class Client:
        def __init__(self, **kwargs):
            assert kwargs == {"impersonate": "chrome120", "proxy": "http://proxy.example:8080"}
            self.cookies = Cookies()

        def get(self, url, **kwargs):
            assert url == "https://chatgpt.com/api/auth/session"
            assert kwargs["headers"] == {"accept": "application/json"}
            return Response()

    monkeypatch.setattr("curl_cffi.requests.Session", Client)
    account = type(
        "AccountStub",
        (),
        {
            "email": "session@example.com",
            "user_id": "workspace-1",
            "extra": {"session_token": "session-token", "account_id": "workspace-1"},
        },
    )()

    result = _fetch_authenticated_session_status_details(account, proxy="http://proxy.example:8080")
    assert result["status"] == "unknown"
    assert result["account_type_raw"] == ""
    assert result["account_type_source"] == "session_jwt_free_unconfirmed"
    assert result["account_status"] == "active"
    assert result["credential_status"] == "valid"
    assert result["type_observed"] is False
    assert result["plan_detection_result"] == "inconclusive"
    assert result["status_code"] == "plan_not_confirmed"
    assert result["status_retryable"] is True
    assert result["session_valid"] is True

    account.extra["account_overview"] = {"plan_override": "plus"}
    paid_result = _fetch_authenticated_session_status_details(account, proxy="http://proxy.example:8080")
    assert paid_result["status"] == "plus"
    assert paid_result["account_type_raw"] == "plus"
    assert paid_result["plan_source"] == "last_confirmed_paid_plan"
    assert paid_result["type_observed"] is False
    assert paid_result["plan_detection_result"] == "inconclusive"

    account.email = "other@example.com"
    with pytest.raises(ValueError, match="邮箱不匹配"):
        _fetch_authenticated_session_status_details(account, proxy="http://proxy.example:8080")

    account.email = "session@example.com"
    account.extra["account_id"] = "workspace-2"
    with pytest.raises(ValueError, match="workspace 不匹配"):
        _fetch_authenticated_session_status_details(account, proxy="http://proxy.example:8080")


def test_batch_refresh_returns_status_code_reason_and_account_type(monkeypatch):
    account_id = _create_account(lifecycle_status="registered")

    def _fake_check(selected_id, logger=None, *, proxy_url=None):
        assert selected_id == account_id
        assert logger is None
        assert proxy_url is None
        return False, {
            "account_id": selected_id,
            "email": "chatgpt@example.com",
            "platform": "chatgpt",
            "availability": "unavailable",
            "detection_result": "confirmed",
            "type_observed": True,
            "plan_detection_result": "confirmed",
            "plan_authority": "authoritative",
            "account_type_confidence": "high",
            "account_status": "disabled",
            "credential_status": "unknown",
            "subscription_status": "active",
            "account_type": "business",
            "account_type_raw": "chatgptbusinessplan",
            "account_type_source": "backend-api/me",
            "status_code": "account_disabled",
            "status_reason": "账号已被禁用",
            "status_retryable": False,
            "status_source": "backend-api/me",
            "status_checked_at": "2026-07-15T20:00:00Z",
        }

    monkeypatch.setattr("application.account_checks._run_single_account_check", _fake_check)

    result = AccountChecksService().refresh_plan_sync(
        "chatgpt",
        account_ids=[account_id],
        max_workers=1,
    )

    assert result["updated"] == 1
    assert result["timed_out"] == 0
    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["ok"] is True
    assert item["valid"] is False
    assert item["availability"] == "unavailable"
    assert item["detection_result"] == "confirmed"
    assert item["type_observed"] is True
    assert item["plan_detection_result"] == "confirmed"
    assert item["plan_authority"] == "authoritative"
    assert item["account_type_confidence"] == "high"
    assert item["account_status"] == "disabled"
    assert item["account_type"] == "business"
    assert item["account_type_raw"] == "chatgptbusinessplan"
    assert item["status_code"] == "account_disabled"
    assert item["status_reason"] == "账号已被禁用"
    assert item["status_retryable"] is False


_NO_JSON = object()


class _CpaResponse:
    def __init__(self, status_code: int, payload=_NO_JSON, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is _NO_JSON:
            raise ValueError("not JSON")
        return self._payload


class _CpaCookieJar:
    def set(self, *_args, **_kwargs):
        return None

    def get(self, *_args, **_kwargs):
        return None


class _CpaSession:
    def __init__(self, *_args, **_kwargs):
        self.cookies = _CpaCookieJar()

    def get(self, url: str, **_kwargs):
        assert url == "https://chatgpt.com/api/auth/session"
        return _CpaResponse(200, {"accessToken": "fresh-access-token"})


def _create_cpa_sync_account() -> int:
    with Session(engine) as session:
        model = AccountModel(platform="chatgpt", email="cpa-sync@example.com", password="secret")
        session.add(model)
        session.commit()
        session.refresh(model)
        patch_account_graph(
            session,
            model,
            lifecycle_status="registered",
            credential_updates={"session_token": "session-token"},
            summary_updates={"valid": True},
        )
        session.commit()
        return int(model.id or 0)


@pytest.mark.parametrize(
    ("status_code", "payload", "text", "network_error"),
    [
        pytest.param(403, _NO_JSON, "<html><title>Cloudflare challenge</title></html>", None, id="html-challenge"),
        pytest.param(200, _NO_JSON, "<html><title>Login page</title></html>", None, id="html-success-status"),
        pytest.param(200, {"detail": "Temporary upstream response"}, "", None, id="unknown-success-json"),
        pytest.param(200, {"disabled": True, "status": "disabled"}, "", None, id="generic-top-level-disabled"),
        pytest.param(403, {"detail": "Forbidden"}, "", None, id="generic-forbidden"),
        pytest.param(429, {"error": {"code": "rate_limit_exceeded"}}, "", None, id="rate-limit"),
        pytest.param(503, {"error": {"code": "account_disabled"}}, "", None, id="server-error"),
        pytest.param(401, ["not", "an", "object"], "", None, id="non-structured"),
        pytest.param(0, _NO_JSON, "", TimeoutError("upstream timed out"), id="timeout"),
        pytest.param(0, _NO_JSON, "", ConnectionError("network unavailable"), id="network-error"),
    ],
)
def test_cpa_sync_keeps_account_active_when_liveness_is_inconclusive(
    monkeypatch,
    status_code,
    payload,
    text,
    network_error,
):
    account_id = _create_cpa_sync_account()

    def _liveness_get(*_args, **_kwargs):
        if network_error is not None:
            raise network_error
        return _CpaResponse(status_code, payload, text)

    monkeypatch.setattr("curl_cffi.requests.Session", _CpaSession)
    monkeypatch.setattr("curl_cffi.requests.get", _liveness_get)

    results = refresh_and_sync_cpa(limit=1)

    assert results["refreshed"] == 1
    assert results["dead"] == 0
    assert results["inconclusive"] == 1
    overview = _overview(account_id)
    assert overview.lifecycle_status == "registered"
    assert overview.validity_status == "valid"
    assert overview.display_status == "registered"
    assert overview.checked_at is None
    summary = overview.get_summary()
    assert summary["valid"] is True
    assert summary["liveness_status"] == "inconclusive"
    assert summary["liveness_error"]
    assert not summary.get("deactivated_at")
    assert not summary.get("deactivated_reason")


def test_cpa_sync_confirms_valid_only_for_authenticated_account_json(monkeypatch):
    account_id = _create_cpa_sync_account()

    monkeypatch.setattr("curl_cffi.requests.Session", _CpaSession)
    monkeypatch.setattr(
        "curl_cffi.requests.get",
        lambda *_args, **_kwargs: _CpaResponse(
            200,
            {"id": "user-123", "email": "cpa-sync@example.com", "accounts": {}},
        ),
    )

    results = refresh_and_sync_cpa(limit=1)

    assert results["refreshed"] == 1
    assert results["dead"] == 0
    assert results["inconclusive"] == 0
    overview = _overview(account_id)
    assert overview.lifecycle_status == "registered"
    assert overview.validity_status == "valid"
    assert overview.checked_at is not None
    summary = overview.get_summary()
    assert summary["valid"] is True
    assert summary["check_source"] == "backend-api/me"
    assert summary["liveness_status"] == "valid"
    assert summary["liveness_error"] == ""


def test_cpa_sync_marks_invalid_only_for_structured_account_disable_evidence(monkeypatch):
    account_id = _create_cpa_sync_account()

    monkeypatch.setattr("curl_cffi.requests.Session", _CpaSession)
    monkeypatch.setattr(
        "curl_cffi.requests.get",
        lambda *_args, **_kwargs: _CpaResponse(
            403,
            {"error": {"code": "account_disabled", "message": "This account has been disabled"}},
        ),
    )

    results = refresh_and_sync_cpa(limit=1)

    assert results["refreshed"] == 1
    assert results["dead"] == 1
    assert results["inconclusive"] == 0
    overview = _overview(account_id)
    assert overview.lifecycle_status == "invalid"
    assert overview.validity_status == "invalid"
    assert overview.display_status == "invalid"
    assert overview.checked_at is not None
    summary = overview.get_summary()
    assert summary["valid"] is False
    assert summary["liveness_status"] == "invalid"
    assert summary["deactivated_reason"] == "error.code:account_disabled"
