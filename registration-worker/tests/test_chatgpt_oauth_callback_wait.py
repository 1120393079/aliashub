from types import SimpleNamespace

from platforms.chatgpt import browser_register


class _FakePage:
    url = "http://localhost:1455/auth/callback?code=ac_test&state=state_123"

    def evaluate(self, script):
        return self.url


def test_wait_for_oauth_callback_result_exchanges_callback(monkeypatch):
    calls = {}

    def fake_submit_callback_result(callback_url, oauth_start, proxy):
        calls["callback_url"] = callback_url
        calls["state"] = oauth_start.state
        calls["proxy"] = proxy
        return {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "account_id": "acct-123",
        }

    monkeypatch.setattr(browser_register, "_submit_callback_result", fake_submit_callback_result)

    result = browser_register._wait_for_oauth_callback_result(
        _FakePage(),
        SimpleNamespace(state="state_123"),
        proxy="http://proxy.example",
        log=lambda _message: None,
        timeout_sec=1,
    )

    assert result["access_token"] == "access-token"
    assert calls == {
        "callback_url": _FakePage.url,
        "state": "state_123",
        "proxy": "http://proxy.example",
    }
