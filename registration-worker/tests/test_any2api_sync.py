"""Any2API sync unit tests."""
from __future__ import annotations

from unittest.mock import patch, MagicMock
from core.any2api_sync import Any2ApiClient, push_account_to_any2api


class TestAny2ApiClient:
    def test_login_success(self):
        client = Any2ApiClient("http://localhost:8099", "changeme")
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"ok": True, "token": "abc123"}
        mock_resp.cookies = {"newplatform2api_admin_session": "abc123"}

        with patch("core.any2api_sync.requests.post", return_value=mock_resp):
            assert client._login() is True
            assert client._session_cookie == "abc123"

    def test_login_failure(self):
        client = Any2ApiClient("http://localhost:8099", "wrong")
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.json.return_value = {"error": "invalid"}

        with patch("core.any2api_sync.requests.post", return_value=mock_resp):
            assert client._login() is False

    def test_push_kiro(self):
        client = Any2ApiClient("http://localhost:8099", "changeme")
        client._session_cookie = "test-session"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"account": {"id": "123"}}

        with patch("core.any2api_sync.requests.post", return_value=mock_resp):
            assert client.push_kiro("test-token", name="test@test.com") is True

    def test_push_cursor(self):
        client = Any2ApiClient("http://localhost:8099", "changeme")
        client._session_cookie = "test-session"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"config": {}}

        with patch("core.any2api_sync.requests.put", return_value=mock_resp):
            assert client.push_cursor("session-token") is True


class TestPushAccountToAny2api:
    def test_not_configured_returns_false(self):
        # When any2api_url is not configured, should silently return False
        with patch("core.any2api_sync._get_any2api_config", return_value=("", "")):
            account = MagicMock()
            account.platform = "kiro"
            assert push_account_to_any2api(account) is False

    def test_kiro_push(self):
        with patch("core.any2api_sync._get_any2api_config", return_value=("http://localhost:8099", "changeme")):
            account = MagicMock()
            account.platform = "kiro"
            account.email = "test@test.com"
            account.token = "access-token"
            account.extra = {"accessToken": "access-token"}

            with patch.object(Any2ApiClient, "push_kiro", return_value=True):
                assert push_account_to_any2api(account) is True

    def test_unsupported_platform(self):
        with patch("core.any2api_sync._get_any2api_config", return_value=("http://localhost:8099", "changeme")):
            account = MagicMock()
            account.platform = "cerebras"
            account.email = "test@test.com"
            account.extra = {}

            logs = []
            assert push_account_to_any2api(account, log_fn=logs.append) is False
