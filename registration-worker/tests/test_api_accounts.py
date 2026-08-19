"""Account CRUD endpoint tests."""
from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone

import pytest

from application.account_exports import AccountExportsService
from application.phone_binding import (
    PhoneBindEntry,
    PhoneBindingService,
    SmsApiPhoneCallback,
    _fetch_phone_sms_code,
    _platform_account_from_record,
    default_phone_binder,
    parse_phone_bind_lines,
)
from core.base_platform import Account
from core.db import save_account
from domain.accounts import AccountCreateCommand, AccountExportSelection, AccountRecord
from infrastructure.accounts_repository import AccountsRepository


def _make_jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.sig"


def _create_account(client, **overrides):
    payload = {
        "platform": "chatgpt",
        "email": "test@example.com",
        "password": "TestPass123!",
        **overrides,
    }
    return client.post("/api/accounts", json=payload)


def _password_state_account(
    *,
    email: str,
    password: str,
    status: str,
    source: str,
    platform: str = "chatgpt",
    password_error: str = "",
) -> Account:
    overview = {
        "password_status": status,
        "password_source": source,
    }
    if password_error:
        overview["password_error"] = password_error
    return Account(
        platform=platform,
        email=email,
        password=password,
        extra={"account_overview": overview},
    )


def _account_by_email(client, email: str) -> dict:
    response = client.get("/api/accounts", params={"email": email})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    return payload["items"][0]


def test_create_account(client):
    resp = _create_account(client)
    assert resp.status_code == 200
    data = resp.json()
    assert data["platform"] == "chatgpt"
    assert data["email"] == "test@example.com"
    assert "id" in data


def test_list_accounts_empty(client):
    resp = client.get("/api/accounts")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []


def test_list_accounts_after_create(client):
    _create_account(client)
    resp = client.get("/api/accounts")
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["email"] == "test@example.com"


def test_get_account_by_id(client):
    create_resp = _create_account(client)
    account_id = create_resp.json()["id"]
    resp = client.get(f"/api/accounts/{account_id}")
    assert resp.status_code == 200
    assert resp.json()["email"] == "test@example.com"


def test_get_account_not_found(client):
    resp = client.get("/api/accounts/99999")
    assert resp.status_code == 404


def test_delete_account(client):
    create_resp = _create_account(client)
    account_id = create_resp.json()["id"]
    del_resp = client.delete(f"/api/accounts/{account_id}")
    assert del_resp.status_code == 200
    assert del_resp.json()["ok"] is True
    # Verify it's gone
    get_resp = client.get(f"/api/accounts/{account_id}")
    assert get_resp.status_code == 404


def test_update_account(client):
    create_resp = _create_account(client)
    account_id = create_resp.json()["id"]
    patch_resp = client.patch(
        f"/api/accounts/{account_id}",
        json={"password": "NewPass456!"},
    )
    assert patch_resp.status_code == 200


def test_save_account_password_state_round_trips_new_chatgpt_passwordless_account(client):
    save_account(_password_state_account(
        email="passwordless@example.com",
        password="",
        status="not_configured",
        source="none",
    ))

    detail = _account_by_email(client, "passwordless@example.com")

    assert detail["password"] == ""
    assert detail["overview"]["password_status"] == "not_configured"
    assert detail["overview"]["password_source"] == "none"


def test_save_account_password_state_preserves_configured_chatgpt_password_for_empty_result(client):
    save_account(_password_state_account(
        email="configured@example.com",
        password="ExistingSecret123!",
        status="configured",
        source="settings",
    ))
    save_account(_password_state_account(
        email="configured@example.com",
        password="",
        status="not_configured",
        source="none",
    ))

    detail = _account_by_email(client, "configured@example.com")

    assert detail["password"] == "ExistingSecret123!"
    assert detail["overview"]["password_status"] == "configured"
    assert detail["overview"]["password_source"] == "settings"


def test_save_account_password_state_rejects_unverified_chatgpt_password_replacement(client):
    save_account(_password_state_account(
        email="unverified@example.com",
        password="ExistingSecret123!",
        status="configured",
        source="signup_required",
    ))
    save_account(_password_state_account(
        email="unverified@example.com",
        password="UnverifiedSecret456!",
        status="failed",
        source="settings",
        password_error="password settings verification failed",
    ))

    detail = _account_by_email(client, "unverified@example.com")

    assert detail["password"] == "ExistingSecret123!"
    assert detail["overview"]["password_status"] == "configured"
    assert detail["overview"]["password_source"] == "signup_required"
    assert "password_error" not in detail["overview"]
    assert detail["overview"]["password_last_error"] == "password settings verification failed"


def test_save_account_password_state_protects_chatgpt_password_without_existing_configured_status(client):
    save_account(_password_state_account(
        email="legacy@example.com",
        password="LegacySecret123!",
        status="unknown",
        source="none",
    ))
    save_account(_password_state_account(
        email="legacy@example.com",
        password="",
        status="not_configured",
        source="none",
    ))

    detail = _account_by_email(client, "legacy@example.com")

    assert detail["password"] == "LegacySecret123!"
    assert detail["overview"]["password_status"] == "unknown"
    assert detail["overview"]["password_source"] == "none"


def test_save_account_password_state_defaults_missing_existing_status_to_unknown(client):
    save_account(Account(
        platform="chatgpt",
        email="legacy-missing-status@example.com",
        password="LegacySecret123!",
        extra={},
    ))
    save_account(_password_state_account(
        email="legacy-missing-status@example.com",
        password="",
        status="not_configured",
        source="none",
    ))

    detail = _account_by_email(client, "legacy-missing-status@example.com")

    assert detail["password"] == "LegacySecret123!"
    assert detail["overview"]["password_status"] == "unknown"
    assert detail["overview"]["password_source"] == "none"


def test_save_account_password_state_replaces_chatgpt_password_when_configured(client):
    save_account(_password_state_account(
        email="replacement@example.com",
        password="ExistingSecret123!",
        status="configured",
        source="signup_required",
    ))
    save_account(_password_state_account(
        email="replacement@example.com",
        password="ReplacementSecret456!",
        status="configured",
        source="settings",
    ))

    detail = _account_by_email(client, "replacement@example.com")

    assert detail["password"] == "ReplacementSecret456!"
    assert detail["overview"]["password_status"] == "configured"
    assert detail["overview"]["password_source"] == "settings"


def test_save_account_password_state_keeps_other_platform_update_semantics(client):
    save_account(_password_state_account(
        platform="cursor",
        email="cursor@example.com",
        password="ExistingSecret123!",
        status="configured",
        source="settings",
    ))
    save_account(_password_state_account(
        platform="cursor",
        email="cursor@example.com",
        password="",
        status="not_configured",
        source="none",
    ))

    detail = _account_by_email(client, "cursor@example.com")

    assert detail["password"] == ""


def test_filter_accounts_by_platform(client):
    _create_account(client, platform="chatgpt", email="a@test.com")
    _create_account(client, platform="cursor", email="b@test.com")
    resp = client.get("/api/accounts", params={"platform": "cursor"})
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["platform"] == "cursor"


def test_account_stats(client):
    _create_account(client)
    resp = client.get("/api/accounts/stats")
    assert resp.status_code == 200


def test_export_kiro_go(client):
    # Create a kiro account first
    client.post("/api/accounts", json={
        "platform": "kiro",
        "email": "kiro@test.com",
        "password": "",
    })
    resp = client.post("/api/accounts/export/kiro-go", json={
        "platform": "kiro",
        "select_all": True,
    })
    assert resp.status_code == 200
    assert "kiro_go_config" in resp.headers.get("content-disposition", "")


def test_export_any2api_multi_platform(client):
    client.post("/api/accounts", json={"platform": "kiro", "email": "k@test.com", "password": ""})
    client.post("/api/accounts", json={"platform": "grok", "email": "g@test.com", "password": ""})
    client.post("/api/accounts", json={"platform": "cursor", "email": "c@test.com", "password": ""})
    resp = client.post("/api/accounts/export/any2api", json={"select_all": True})
    assert resp.status_code == 200
    assert "any2api_admin" in resp.headers.get("content-disposition", "")


def test_export_cpa_uses_standard_payload_schema():
    exp_timestamp = 1777166030
    expected_expired = datetime.fromtimestamp(
        exp_timestamp, tz=timezone(timedelta(hours=8))
    ).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    access_token = _make_jwt({
        "exp": exp_timestamp,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-standard",
        },
    })
    id_token = _make_jwt({
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-standard",
        },
    })
    repository = AccountsRepository()
    repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="cpa@test.com",
            password="TestPass123!",
            user_id="acct-standard",
            credentials={
                "access_token": access_token,
                "refresh_token": "rt_standard",
                "id_token": id_token,
            },
        )
    )
    service = AccountExportsService(repository)

    artifact = service.export_chatgpt_cpa(AccountExportSelection(platform="chatgpt", select_all=True))
    payload = json.loads(artifact.content)
    assert list(payload.keys()) == [
        "access_token",
        "account_id",
        "email",
        "expired",
        "id_token",
        "last_refresh",
        "refresh_token",
        "type",
    ]
    assert payload["access_token"] == access_token
    assert payload["account_id"] == "acct-standard"
    assert payload["email"] == "cpa@test.com"
    assert payload["expired"] == expected_expired
    assert payload["id_token"] == id_token
    assert payload["last_refresh"].endswith("+08:00")
    assert payload["refresh_token"] == "rt_standard"
    assert payload["type"] == "codex"


def test_export_cpa_falls_back_to_stored_user_id_for_account_id():
    repository = AccountsRepository()
    repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="fallback@test.com",
            password="TestPass123!",
            user_id="acct-from-user-id",
            credentials={
                "access_token": _make_jwt({"exp": 1777166030}),
                "refresh_token": "rt_fallback",
            },
        )
    )
    service = AccountExportsService(repository)

    artifact = service.export_chatgpt_cpa(AccountExportSelection(platform="chatgpt", select_all=True))
    payload = json.loads(artifact.content)
    assert payload["account_id"] == "acct-from-user-id"
    assert payload["refresh_token"] == "rt_fallback"


def test_export_email_txt_uses_selected_chatgpt_accounts():
    repository = AccountsRepository()
    created = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="mailapi@test.com",
            password="TestPass123!",
        )
    )
    repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="other@test.com",
            password="TestPass123!",
        )
    )
    service = AccountExportsService(repository)

    artifact = service.export_chatgpt_email_api_txt(
        AccountExportSelection(platform="chatgpt", ids=[created.id])
    )

    assert artifact.media_type == "text/plain"
    assert artifact.filename.endswith(".txt")
    assert artifact.content == "mailapi@test.com"

def test_export_cockpit_uses_flat_codex_token_schema(client):
    access_token = _make_jwt({
        "exp": 1777166030,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-cockpit",
        },
    })
    id_token = _make_jwt({
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-cockpit",
        },
    })
    create_resp = client.post(
        "/api/accounts",
        json={
            "platform": "chatgpt",
            "email": "cockpit@test.com",
            "password": "TestPass123!",
            "user_id": "acct-cockpit",
            "credentials": {
                "access_token": access_token,
                "refresh_token": "rt_cockpit",
                "id_token": id_token,
            },
        },
    )
    account_id = create_resp.json()["id"]

    resp = client.post(
        "/api/accounts/export/cockpit",
        json={"platform": "chatgpt", "ids": [account_id]},
    )

    assert resp.status_code == 200
    assert "cockpit" in resp.headers.get("content-disposition", "")
    payload = resp.json()
    assert payload == {
        "type": "codex",
        "id_token": id_token,
        "access_token": access_token,
        "refresh_token": "rt_cockpit",
        "account_id": "acct-cockpit",
        "last_refresh": payload["last_refresh"],
        "email": "cockpit@test.com",
        "expired": payload["expired"],
        "account_note": "",
    }
    assert payload["expired"].endswith("Z")


def test_parse_phone_bind_lines_accepts_multiple_phone_api_pairs():
    entries = parse_phone_bind_lines(
        "\n".join(
            [
                "2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
                "+12025550105 ---- https://relay.example.invalid/api/sms/recordText?key=def",
            ]
        )
    )

    assert [entry.phone for entry in entries] == ["+12025550104", "+12025550105"]
    assert entries[0].sms_api.endswith("key=abc")


def test_sms_api_phone_callback_returns_phone_then_unique_codes(monkeypatch):
    entry = parse_phone_bind_lines(
        "2025550104----https://relay.example.invalid/api/sms/recordText?key=abc"
    )[0]
    calls: list[set[str]] = []

    def fake_fetch(phone_entry, *, excluded_pins=None, cancel_check=None, wait_seconds=30):
        calls.append((set(excluded_pins or set()), cancel_check, wait_seconds))
        return "123456" if not excluded_pins else "654321"

    import application.phone_binding as phone_binding_module

    monkeypatch.setattr(phone_binding_module, "_fetch_phone_sms_code", fake_fetch)
    cancel_check = lambda: False
    callback = SmsApiPhoneCallback(entry, cancel_check=cancel_check, wait_seconds=900)

    assert callback() == "+12025550104"
    assert callback() == "123456"
    assert callback() == "654321"
    assert calls == [
        (set(), cancel_check, 900),
        ({"123456"}, cancel_check, 900),
    ]


def test_phone_sms_callback_requests_resend_only_after_a_rejected_code(monkeypatch):
    captured_urls = []

    def fake_fetch(*, url, **_kwargs):
        captured_urls.append(url)
        return "654321"

    monkeypatch.setattr("platforms.chatgpt.payment._fetch_ctf_relay_code", fake_fetch)
    entry = PhoneBindEntry(
        "+12025550104",
        "https://relay.example.invalid/openai/token?source=test",
    )

    assert _fetch_phone_sms_code(entry, excluded_pins=set()) == "654321"
    assert _fetch_phone_sms_code(entry, excluded_pins={"123456"}) == "654321"
    assert captured_urls == [
        "https://relay.example.invalid/openai/token?source=test",
        "https://relay.example.invalid/openai/token?source=test&resend=1",
    ]


def test_phone_binding_marks_selected_accounts_and_reports_phone_usage():
    repository = AccountsRepository()
    first = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="bind1@test.com",
            password="TestPass123!",
            overview={"plan": "plus"},
        )
    )
    second = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="bind2@test.com",
            password="TestPass123!",
            overview={"plan": "plus"},
        )
    )
    calls: list[tuple[str, str]] = []

    def fake_binder(account, phone_entry):
        calls.append((account.email, phone_entry.phone))
        return {"ok": True}

    service = PhoneBindingService(repository=repository, binder=fake_binder)
    result = service.bind(
        ids=[first.id, second.id],
        phone_lines="2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
    )

    assert result["total"] == 2
    assert result["success_count"] == 2
    assert result["failure_count"] == 0
    assert result["phones"][0]["phone"] == "+12025550104"
    assert result["phones"][0]["used"] == 2
    assert calls == [
        ("bind1@test.com", "+12025550104"),
        ("bind2@test.com", "+12025550104"),
    ]
    updated = repository.get(first.id)
    assert updated is not None
    assert updated.overview["phone_binding"]["status"] == "bound"
    assert updated.overview["phone_binding"]["phone"] == "+12025550104"
    assert updated.overview["phone_binding"]["sms_source"] == "relay"
    assert "sms_api" not in updated.overview["phone_binding"]
    assert "key=abc" not in str(result)


def test_phone_bind_parser_does_not_echo_relay_token_on_invalid_input():
    relay_token = "super-secret-relay-token"

    with pytest.raises(ValueError) as exc_info:
        parse_phone_bind_lines(f"not-a-phone----https://relay.invalid/sms?token={relay_token}")

    assert relay_token not in str(exc_info.value)


def test_phone_binding_stops_before_later_accounts_after_cancel():
    repository = AccountsRepository()
    accounts = [
        repository.create(
            AccountCreateCommand(
                platform="chatgpt",
                email=f"cancel-bind-{index}@test.com",
                password="TestPass123!",
            )
        )
        for index in range(3)
    ]
    state = {"cancelled": False}
    calls: list[int] = []

    def fake_binder(account, phone_entry, *, cancel_check=None):
        calls.append(account.id)
        state["cancelled"] = True
        return {"ok": True}

    result = PhoneBindingService(repository=repository, binder=fake_binder).bind(
        ids=[item.id for item in accounts],
        phone_lines="2025550104----https://relay.example.invalid/sms?token=secret",
        concurrency=1,
        cancel_check=lambda: state["cancelled"],
    )

    assert calls == [accounts[0].id]
    assert result["cancelled"] is True
    assert result["total"] == 1
    assert result["skipped_count"] == 2
    assert result["success_count"] == 1
    assert repository.get(accounts[0].id).overview["phone_binding"]["status"] == "bound"


def test_platform_account_adapter_preserves_mailbox_graph_for_passwordless_login():
    record = AccountRecord(
        id=7,
        platform="chatgpt",
        email="passwordless@test.com",
        password="",
        overview={"plan": "free"},
        credentials=[{"scope": "platform", "key": "refresh_token", "value": "rt_test"}],
        provider_accounts=[{"provider_name": "dispose_inbox_link", "id": "mail-account"}],
        provider_resources=[{"provider_name": "dispose_inbox_link", "resource_type": "mailbox"}],
    )

    adapted = _platform_account_from_record(record)

    assert adapted.password == ""
    assert adapted.extra["overview"] == {"plan": "free"}
    assert adapted.extra["account_overview"] == {"plan": "free"}
    assert adapted.extra["credentials"] == record.credentials
    assert adapted.extra["refresh_token"] == "rt_test"
    assert adapted.extra["provider_accounts"] == record.provider_accounts
    assert adapted.extra["provider_resources"] == record.provider_resources


def test_default_phone_binder_passes_mailbox_otp_callback_for_passwordless_account(monkeypatch):
    repository = AccountsRepository()
    account = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="passwordless-bind@test.com",
            password="",
            provider_resources=[
                {
                    "provider_name": "dispose_inbox_link",
                    "resource_type": "mailbox",
                    "handle": "passwordless-bind@test.com",
                }
            ],
        )
    )
    seen = {}

    def otp_callback():
        return "123456"

    import application.phone_binding as phone_binding_module
    import platforms.chatgpt.browser_register as browser_register_module

    monkeypatch.setattr(
        phone_binding_module,
        "_build_mailbox_otp_callback",
        lambda account, **kwargs: (otp_callback, ""),
    )

    class FakeBrowserRegister:
        def __init__(self, **kwargs):
            seen.update(kwargs)

        def _retry_oauth_fresh_browser(self, email, password):
            seen["phone_callback"].report_success()
            return {"access_token": "at_test", "account_id": "acct_test"}

    monkeypatch.setattr(browser_register_module, "ChatGPTBrowserRegister", FakeBrowserRegister)
    cancel_check = lambda: False

    result = default_phone_binder(
        account,
        PhoneBindEntry("+12025550104", "https://relay.invalid/sms"),
        cancel_check=cancel_check,
    )

    assert result["ok"] is True
    assert seen["otp_callback"] is otp_callback
    assert seen["cancel_check"] is cancel_check


def test_default_phone_binder_requires_completed_phone_callback_and_always_cleans_up(monkeypatch):
    repository = AccountsRepository()
    account = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="incomplete-bind@test.com",
            password="TestPass123!",
        )
    )
    state = {"cleaned": False}

    import application.phone_binding as phone_binding_module
    import platforms.chatgpt.browser_register as browser_register_module

    class TrackingCallback:
        def __init__(self, entry, **kwargs):
            self.completed = False

        def cleanup(self):
            state["cleaned"] = True

    class FakeBrowserRegister:
        def __init__(self, **kwargs):
            pass

        def _retry_oauth_fresh_browser(self, email, password):
            return {"access_token": "at_without_phone", "account_id": "acct_test"}

    monkeypatch.setattr(phone_binding_module, "SmsApiPhoneCallback", TrackingCallback)
    monkeypatch.setattr(browser_register_module, "ChatGPTBrowserRegister", FakeBrowserRegister)

    result = default_phone_binder(
        account,
        PhoneBindEntry("+12025550104", "https://relay.invalid/sms"),
    )

    assert result["ok"] is False
    assert "was not completed" in result["error"]
    assert state["cleaned"] is True


def test_phone_binding_persists_auth_tokens_returned_by_binder():
    repository = AccountsRepository()
    account = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="authbind@test.com",
            password="TestPass123!",
            overview={"plan": "plus"},
            credentials={"access_token": "old_access"},
        )
    )

    def fake_binder(account, phone_entry):
        return {
            "ok": True,
            "access_token": "new_access",
            "refresh_token": "new_refresh",
            "id_token": "new_id",
            "account_id": "acct-from-auth",
        }

    service = PhoneBindingService(repository=repository, binder=fake_binder)
    result = service.bind(
        ids=[account.id],
        phone_lines="2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
    )

    assert result["success_count"] == 1
    updated = repository.get(account.id)
    assert updated is not None
    credentials = {
        item["key"]: item["value"]
        for item in updated.credentials
        if item.get("key") in {"access_token", "refresh_token", "id_token", "account_id"}
    }
    assert credentials["access_token"] == "new_access"
    assert credentials["refresh_token"] == "new_refresh"
    assert credentials["id_token"] == "new_id"
    assert credentials["account_id"] == "acct-from-auth"
    assert updated.user_id == "acct-from-auth"


def test_phone_binding_accepts_uncapped_concurrency():
    repository = AccountsRepository()
    accounts = [
        repository.create(
            AccountCreateCommand(
                platform="chatgpt",
                email=f"concurrent{index}@test.com",
                password="TestPass123!",
                overview={"plan": "plus"},
            )
        )
        for index in range(2)
    ]
    calls: list[int] = []

    def fake_binder(account, phone_entry):
        calls.append(account.id)
        return {"ok": True}

    service = PhoneBindingService(repository=repository, binder=fake_binder)
    result = service.bind(
        ids=[item.id for item in accounts],
        phone_lines="\n".join(
            [
                "2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
                "2025550105----https://relay.example.invalid/api/sms/recordText?key=def",
            ]
        ),
        concurrency=99,
    )

    assert sorted(calls) == sorted(item.id for item in accounts)
    assert result["success_count"] == 2
    assert result["concurrency"] == 2


def test_phone_binding_uses_fallback_unbound_accounts_when_no_ids_selected():
    repository = AccountsRepository()
    bound = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="already@test.com",
            password="TestPass123!",
            overview={
                "plan": "plus",
                "phone_binding": {"status": "bound", "phone": "+10000000000"},
            },
        )
    )
    unbound = repository.create(
        AccountCreateCommand(
            platform="chatgpt",
            email="unbound@test.com",
            password="TestPass123!",
            overview={"plan": "plus"},
        )
    )
    calls: list[str] = []

    def fake_binder(account, phone_entry):
        calls.append(account.email)
        return {"ok": True}

    service = PhoneBindingService(repository=repository, binder=fake_binder)
    result = service.bind(
        ids=[],
        fallback_ids=[bound.id, unbound.id],
        phone_lines="2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
    )

    assert result["target_ids"] == [unbound.id]
    assert result["success_count"] == 1
    assert calls == ["unbound@test.com"]


def test_phone_binding_rejects_accounts_over_phone_capacity():
    repository = AccountsRepository()
    accounts = [
        repository.create(
            AccountCreateCommand(
                platform="chatgpt",
                email=f"capacity{index}@test.com",
                password="TestPass123!",
                overview={"plan": "plus"},
            )
        )
        for index in range(4)
    ]
    service = PhoneBindingService(repository=repository, binder=lambda account, phone_entry: {"ok": True})

    try:
        service.bind(
            ids=[item.id for item in accounts],
            phone_lines="2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
        )
    except ValueError as exc:
        assert "capacity" in str(exc)
    else:
        raise AssertionError("expected capacity error")


def test_phone_bind_api_returns_batch_result(client, monkeypatch):
    class FakePhoneBindingService:
        def bind(self, **kwargs):
            return {
                "total": 1,
                "success_count": 1,
                "failure_count": 0,
                "target_ids": kwargs["ids"],
                "phones": [{"phone": "+12025550104", "used": 1, "success": 1, "failed": 0}],
                "results": [],
            }

    import api.accounts as accounts_api

    monkeypatch.setattr(accounts_api, "phone_binding_service", FakePhoneBindingService())
    resp = client.post(
        "/api/accounts/phone-bind",
        json={
            "ids": [123],
            "fallback_ids": [],
            "phone_lines": "2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
        },
    )

    assert resp.status_code == 200
    assert resp.json()["success_count"] == 1


def test_ctf_gpt_plus_export_status_marks_accounts(client):
    create_resp = client.post(
        "/api/accounts",
        json={
            "platform": "chatgpt",
            "email": "exported@test.com",
            "password": "TestPass123!",
            "overview": {"plan": "plus"},
        },
    )
    account_id = create_resp.json()["id"]

    resp = client.post(
        "/api/accounts/ctf-gpt-plus/export-status",
        json={"ids": [account_id], "exported": True},
    )

    assert resp.status_code == 200
    assert resp.json()["updated_ids"] == [account_id]
    detail = client.get(f"/api/accounts/{account_id}").json()
    assert detail["overview"]["ctf_gpt_plus"]["exported"] is True
    assert detail["overview"]["ctf_gpt_plus"]["exported_at"]


def test_codex_oauth_complete_url_updates_tokens(client):
    create_resp = client.post(
        "/api/accounts",
        json={
            "platform": "chatgpt",
            "email": "oauth@test.com",
            "password": "TestPass123!",
            "overview": {"plan": "plus"},
        },
    )
    account_id = create_resp.json()["id"]
    callback_url = (
        "http://localhost:1455/auth/callback#"
        "access_token=at_new&refresh_token=rt_new&id_token=id_new&"
        "account_id=acct_new&email=oauth@test.com&expired=2026-06-06T03:47:30.000Z"
    )

    resp = client.post(
        f"/api/accounts/{account_id}/codex-oauth/complete",
        json={"callback_url": callback_url},
    )

    assert resp.status_code == 200
    detail = client.get(f"/api/accounts/{account_id}").json()
    credentials = {
        item["key"]: item["value"]
        for item in detail["credentials"]
        if item["key"] in {"access_token", "refresh_token", "id_token", "account_id"}
    }
    assert credentials == {
        "access_token": "at_new",
        "refresh_token": "rt_new",
        "id_token": "id_new",
        "account_id": "acct_new",
    }
    assert detail["user_id"] == "acct_new"


def test_codex_oauth_start_uses_existing_oauth_generator(client):
    create_resp = client.post(
        "/api/accounts",
        json={
            "platform": "chatgpt",
            "email": "fixed-oauth@test.com",
            "password": "TestPass123!",
            "overview": {"plan": "plus"},
        },
    )
    account_id = create_resp.json()["id"]

    resp = client.post(f"/api/accounts/{account_id}/codex-oauth/start")

    assert resp.status_code == 200
    data = resp.json()
    assert data["auth_url"].startswith("https://auth.openai.com/oauth/authorize?")
    assert "client_id=app_EMoamEEZ73f0CkXaXp7hrann" in data["auth_url"]
    assert "codex_cli_simplified_flow=true" in data["auth_url"]
    assert "code_challenge=" in data["auth_url"]
    assert data["state"]
