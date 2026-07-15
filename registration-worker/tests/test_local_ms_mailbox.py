import pytest

from core.base_mailbox import MailboxAccount
from core.local_ms_mailbox import LocalMicrosoftMailboxPool, parse_local_ms_pool_rows


def test_parse_local_ms_pool_rows_accepts_gujumpgate_hotmail_format():
    rows = parse_local_ms_pool_rows(
        "\n".join(
            [
                "account----password----ID----Token",
                "user@example.com----mail-pass----client-id-123----refresh-token-456",
            ]
        )
    )

    assert len(rows) == 1
    entry = rows[0]
    assert entry.email == "user@example.com"
    assert entry.password == "mail-pass"
    assert entry.login_account == "user@example.com"
    assert entry.client_id == "client-id-123"
    assert entry.refresh_token == "refresh-token-456"
    assert entry.source_format == "gujumpgate_hotmail"
    assert entry.graph_ready is True
    assert entry.imap_ready is False


def test_local_ms_pool_records_gujumpgate_source_metadata(tmp_path):
    pool = LocalMicrosoftMailboxPool(
        pool_text="user@example.com----mail-pass----client-id-123----refresh-token-456",
        state_file=str(tmp_path / "state.json"),
    )

    account = pool.get_email()
    provider_account = account.extra["provider_account"]
    provider_resource = account.extra["provider_resource"]

    assert provider_account["credentials"]["client_id"] == "client-id-123"
    assert provider_account["credentials"]["refresh_token"] == "refresh-token-456"
    assert provider_account["metadata"]["source"] == "gujumpgate_hotmail"
    assert provider_resource["metadata"]["source"] == "gujumpgate_hotmail"


def test_graph_access_token_tries_fallback_endpoint(monkeypatch):
    calls = []

    class FakeResponse:
        def __init__(self, status_code, payload=None, text=""):
            self.status_code = status_code
            self._payload = payload or {}
            self.text = text

        def json(self):
            return self._payload

    def fake_post(url, data, proxies=None, timeout=None):
        calls.append((url, data))
        if len(calls) == 1:
            return FakeResponse(400, text='{"error":"invalid_request"}')
        return FakeResponse(200, {"access_token": "access-token-ok"})

    monkeypatch.setattr("core.local_ms_mailbox.requests.post", fake_post)
    pool = LocalMicrosoftMailboxPool()
    account = MailboxAccount(
        email="user@example.com",
        account_id="user@example.com",
        extra={
            "provider_account": {
                "credentials": {
                    "email": "user@example.com",
                    "client_id": "client-id-123",
                    "refresh_token": "refresh-token-456",
                }
            }
        },
    )
    entry = pool._entry_for_account(account)

    assert pool._graph_access_token(entry) == "access-token-ok"
    assert len(calls) == 2
    assert calls[0][0] == "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    assert calls[1][0] == "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"


def test_local_ms_strict_snapshot_propagates_provider_failure(monkeypatch):
    pool = LocalMicrosoftMailboxPool()
    account = MailboxAccount(email="user@example.com")
    monkeypatch.setattr(
        pool,
        "_messages",
        lambda _account: (_ for _ in ()).throw(RuntimeError("mailbox unavailable")),
    )

    assert pool.get_current_ids(account) == set()
    with pytest.raises(RuntimeError, match="mailbox unavailable"):
        pool.get_current_ids_strict(account)
