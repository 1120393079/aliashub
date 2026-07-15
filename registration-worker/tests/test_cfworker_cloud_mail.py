"""CF Worker/cloud-mail mailbox compatibility tests."""
from __future__ import annotations

import pytest

from core.base_mailbox import CFWorkerMailbox, MailboxAccount


class FakeResponse:
    def __init__(self, payload=None, *, text="", status_code=200, json_error: Exception | None = None):
        self.payload = payload
        self.text = text
        self.status_code = status_code
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise self._json_error
        return self.payload


def test_cfworker_falls_back_to_cloud_mail_public_api(monkeypatch):
    calls = []

    def fake_get(url, **kwargs):
        return FakeResponse(text="not found", status_code=404, json_error=ValueError("not json"))

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        if url.endswith("/admin/new_address"):
            return FakeResponse(text="<html>not found</html>", status_code=404, json_error=ValueError("not json"))
        if url.endswith("/api/public/addUser"):
            assert kwargs["headers"]["Authorization"] == "public-token"
            email = kwargs["json"]["list"][0]["email"]
            assert email.endswith("@mail.example.test")
            return FakeResponse({"code": 200, "message": "success", "data": None})
        raise AssertionError(f"Unexpected URL: {url}")

    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("requests.post", fake_post)

    mailbox = CFWorkerMailbox(
        api_url="https://mail.mail.example.test",
        admin_token="public-token",
        domain="mail.example.test",
    )

    account = mailbox.get_email()

    assert account.email.endswith("@mail.example.test")
    assert account.account_id == account.email
    assert calls[0][0].endswith("/admin/new_address")
    assert calls[1][0].endswith("/api/public/addUser")


def test_cfworker_detects_cloud_mail_and_skips_legacy_admin_api(monkeypatch):
    calls = []

    def fake_get(url, **kwargs):
        assert url.endswith("/api/setting/websiteConfig")
        return FakeResponse({"code": 200, "data": {"domainList": ["@mail.example.test"]}})

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        assert not url.endswith("/admin/new_address")
        assert url.endswith("/api/public/addUser")
        return FakeResponse({"code": 200, "message": "success", "data": None})

    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("requests.post", fake_post)

    mailbox = CFWorkerMailbox(
        api_url="https://mail.mail.example.test",
        admin_token="public-token",
        domain="mail.example.test",
    )

    account = mailbox.get_email()

    assert account.email.endswith("@mail.example.test")
    assert len(calls) == 1


def test_cfworker_cloud_mail_email_list_is_normalized(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        assert url.endswith("/api/public/emailList")
        assert kwargs["headers"]["Authorization"] == "public-token"
        assert kwargs["json"]["toEmail"] == "user@mail.example.test"
        return FakeResponse(
            {
                "code": 200,
                "message": "success",
                "data": [
                    {
                        "emailId": 42,
                        "subject": "Your code",
                        "content": "<p>Code 654321</p>",
                        "text": "Code 654321",
                    }
                ],
            }
        )

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("time.sleep", lambda _seconds: None)

    mailbox = CFWorkerMailbox(
        api_url="https://mail.mail.example.test",
        admin_token="public-token",
        domain="mail.example.test",
    )
    mailbox._api_mode = "cloud_mail"

    account = MailboxAccount(email="user@mail.example.test", account_id="user@mail.example.test")

    assert mailbox.get_current_ids(account) == {"42"}
    assert mailbox.wait_for_code(account, timeout=1) == "654321"
    assert len(calls) == 2


def test_cfworker_cloud_mail_email_list_falls_back_to_fuzzy_match(monkeypatch):
    calls = []

    def fake_post(url, **kwargs):
        calls.append(kwargs["json"]["toEmail"])
        assert url.endswith("/api/public/emailList")
        if kwargs["json"]["toEmail"] == "user@mail.example.test":
            return FakeResponse({"code": 200, "message": "success", "data": []})
        if kwargs["json"]["toEmail"] == "%user@mail.example.test%":
            return FakeResponse(
                {
                    "code": 200,
                    "message": "success",
                    "data": [
                        {
                            "emailId": 99,
                            "subject": "Your code",
                            "content": "<strong>112233</strong>",
                            "text": "",
                        }
                    ],
                }
            )
        raise AssertionError(f"Unexpected toEmail: {kwargs['json']['toEmail']}")

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("time.sleep", lambda _seconds: None)

    mailbox = CFWorkerMailbox(
        api_url="https://mail.mail.example.test",
        admin_token="public-token",
        domain="mail.example.test",
    )
    mailbox._api_mode = "cloud_mail"

    account = MailboxAccount(email="user@mail.example.test", account_id="user@mail.example.test")

    assert mailbox.get_current_ids(account) == {"99"}
    assert mailbox.wait_for_code(account, timeout=1) == "112233"
    assert calls == [
        "user@mail.example.test",
        "%user@mail.example.test%",
        "user@mail.example.test",
        "%user@mail.example.test%",
    ]


def test_cfworker_strict_snapshot_propagates_provider_failure(monkeypatch):
    mailbox = object.__new__(CFWorkerMailbox)
    account = MailboxAccount(email="user@mail.example.test")
    monkeypatch.setattr(
        mailbox,
        "_get_mails",
        lambda _email: (_ for _ in ()).throw(RuntimeError("mailbox unavailable")),
    )

    assert mailbox.get_current_ids(account) == set()
    with pytest.raises(RuntimeError, match="mailbox unavailable"):
        mailbox.get_current_ids_strict(account)
