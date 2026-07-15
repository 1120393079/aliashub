"""outlookEmail mailbox provider tests."""
from __future__ import annotations

import json

from core.base_mailbox import create_mailbox
from core.outlook_email_mailbox import OutlookEmailMailbox
from infrastructure.provider_definitions_repository import ProviderDefinitionsRepository


class FakeResponse:
    def __init__(self, payload, *, status_code: int = 200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.headers = {}
        self.proxies = {}
        self.verify = True
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append({"url": url, "kwargs": kwargs, "headers": dict(self.headers)})
        if not self.responses:
            raise AssertionError(f"unexpected request: {url}")
        return self.responses.pop(0)

    def post(self, url, **kwargs):
        self.calls.append({"url": url, "kwargs": kwargs, "headers": dict(self.headers), "method": "POST"})
        if not self.responses:
            raise AssertionError(f"unexpected request: {url}")
        return self.responses.pop(0)


def test_outlook_email_fixed_email_does_not_expose_provider_secrets():
    mailbox = OutlookEmailMailbox(
        api_url="mail.example.test",
        api_key="fake-api-key",
        admin_password="fake-admin-password",
        fixed_email="fixed@outlook.com",
    )

    account = mailbox.get_email()

    serialized_extra = json.dumps(account.extra, ensure_ascii=False)
    assert mailbox.api == "https://mail.example.test"
    assert account.email == "fixed@outlook.com"
    assert account.account_id == "fixed@outlook.com"
    assert account.extra["provider_account"]["credentials"] == {}
    assert "fake-api-key" not in serialized_extra
    assert "fake-admin-password" not in serialized_extra


def test_outlook_email_selects_first_usable_account_from_external_accounts(monkeypatch):
    session = FakeSession(
        [
            FakeResponse(
                {
                    "success": True,
                    "accounts": [
                        {"id": 1, "email": "bad@outlook.com", "status": "disabled"},
                        {
                            "id": 2,
                            "email": "ok@hotmail.com",
                            "status": "active",
                            "group_id": 7,
                            "group_name": "default",
                        },
                    ],
                }
            )
        ]
    )
    monkeypatch.setattr("requests.Session", lambda: session)

    mailbox = OutlookEmailMailbox(
        api_url="https://mail.example.test",
        api_key="fake-api-key",
        group_id="7",
        account_limit="2",
        account_sort_by="email",
        account_sort_order="asc",
        account_tag_ids="3,5",
        account_include_untagged="true",
    )

    account = mailbox.get_email()

    assert account.email == "ok@hotmail.com"
    assert account.account_id == "2"
    assert session.calls[0]["url"] == "https://mail.example.test/api/external/accounts"
    assert session.calls[0]["headers"]["X-API-Key"] == "fake-api-key"
    assert session.calls[0]["kwargs"]["params"] == {
        "limit": 2,
        "offset": 0,
        "group_id": "7",
        "sort_by": "email",
        "sort_order": "asc",
        "tag_ids": "3,5",
        "include_untagged": "true",
    }


def test_outlook_email_skips_accounts_with_custom_tag(monkeypatch):
    session = FakeSession(
        [
            FakeResponse(
                {
                    "success": True,
                    "accounts": [
                        {
                            "id": 1,
                            "email": "registered@outlook.com",
                            "status": "active",
                            "tags": [{"id": 9, "name": "已注册"}],
                        },
                        {
                            "id": 2,
                            "email": "fresh@outlook.com",
                            "status": "active",
                            "tags": [{"id": 10, "name": "可用"}],
                        },
                    ],
                }
            )
        ]
    )
    monkeypatch.setattr("requests.Session", lambda: session)

    mailbox = OutlookEmailMailbox(
        api_url="https://mail.example.test",
        api_key="fake-api-key",
        skip_tag_names="已注册",
    )

    assert mailbox.get_email().email == "fresh@outlook.com"


def test_outlook_email_filters_before_ids_and_extracts_code(monkeypatch):
    session = FakeSession(
        [
            FakeResponse(
                {
                    "success": True,
                    "emails": [
                        {
                            "id": "old",
                            "subject": "OpenAI verification",
                            "body_preview": "Old code 000000",
                            "folder": "inbox",
                        }
                    ],
                }
            ),
            FakeResponse(
                {
                    "success": True,
                    "emails": [
                        {
                            "id": "old",
                            "subject": "OpenAI verification",
                            "body_preview": "Old code 000000",
                            "folder": "inbox",
                        },
                        {
                            "id": "new",
                            "subject": "OpenAI verification code",
                            "body_preview": "Your code is 123456",
                            "folder": "junkemail",
                        },
                    ],
                }
            ),
        ]
    )
    monkeypatch.setattr("requests.Session", lambda: session)

    mailbox = OutlookEmailMailbox(
        api_url="https://mail.example.test",
        api_key="fake-api-key",
        fixed_email="user@outlook.com",
        email_folder="all",
        email_top="10",
    )
    account = mailbox.get_email()
    before_ids = mailbox.get_current_ids_strict(account)

    code = mailbox.wait_for_code(account, keyword="OpenAI", before_ids=before_ids, timeout=1)

    assert before_ids == {"old"}
    assert code == "123456"
    assert session.calls[1]["url"] == "https://mail.example.test/api/external/emails"
    assert session.calls[1]["kwargs"]["params"] == {
        "email": "user@outlook.com",
        "folder": "all",
        "top": 10,
        "keyword": "OpenAI",
    }


def test_outlook_email_adds_registration_success_tag_via_admin_api(monkeypatch):
    session = FakeSession(
        [
            FakeResponse({"success": True, "message": "ok"}),
            FakeResponse({"csrf_token": "csrf-token"}),
            FakeResponse({"success": True, "tags": []}),
            FakeResponse({"success": True, "tag": {"id": 8, "name": "已注册", "color": "#1a1a1a"}}),
            FakeResponse({"success": True, "message": "成功处理 1 个账号"}),
        ]
    )
    monkeypatch.setattr("requests.Session", lambda: session)

    mailbox = OutlookEmailMailbox(
        api_url="https://mail.example.test",
        api_key="fake-api-key",
        admin_password="fake-admin-password",
        register_success_tag_names="已注册",
    )
    account = mailbox._build_account(
        email="fresh@outlook.com",
        account_id="2",
        source="account_list",
        raw={"id": 2, "email": "fresh@outlook.com"},
    )

    assert mailbox.mark_registration_success(account) == ["已注册"]
    assert session.calls[0]["url"] == "https://mail.example.test/login"
    assert session.calls[0]["kwargs"]["json"] == {"password": "fake-admin-password"}
    assert session.calls[3]["url"] == "https://mail.example.test/api/tags"
    assert session.calls[4]["url"] == "https://mail.example.test/api/accounts/tags"
    assert session.calls[4]["kwargs"]["json"] == {"account_ids": [2], "tag_id": 8, "action": "add"}
    assert session.calls[4]["headers"]["X-CSRFToken"] == "csrf-token"


def test_outlook_email_provider_definition_and_factory_are_wired():
    ProviderDefinitionsRepository().ensure_seeded()

    definition = ProviderDefinitionsRepository().get_by_key("mailbox", "outlook_email_api")
    mailbox = create_mailbox(
        "outlook_email_api",
        extra={
            "outlook_email_api_url": "https://mail.example.test",
            "outlook_email_api_key": "fake-api-key",
            "outlook_email_fixed_email": "fixed@outlook.com",
        },
    )

    assert definition is not None
    assert definition.driver_type == "outlook_email_api"
    assert isinstance(mailbox, OutlookEmailMailbox)
    assert mailbox.get_email().email == "fixed@outlook.com"
