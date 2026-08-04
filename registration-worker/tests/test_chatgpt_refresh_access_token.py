from core.base_platform import Account, RegisterConfig
from platforms.chatgpt import plugin as chatgpt_plugin
from platforms.chatgpt.plugin import ChatGPTPlatform


def test_refresh_access_token_uses_only_authenticated_web_session(monkeypatch):
    calls = []

    def fetch_session(account, proxy=None):
        calls.append((account.email, proxy))
        return {"_credential_updates": {"access_token": "fresh-at"}}

    monkeypatch.setattr(
        chatgpt_plugin,
        "_fetch_authenticated_session_status_details",
        fetch_session,
    )
    monkeypatch.setattr(
        ChatGPTPlatform,
        "_access_token_rejected_by_upstream",
        lambda _self, _account, _access_token, _proxy: False,
    )
    platform = ChatGPTPlatform(RegisterConfig(proxy="http://proxy.example:8080"))
    account = Account(
        platform="chatgpt",
        email="at-only@example.com",
        password="",
        user_id="workspace-at-only",
        extra={
            "session_token": "web-session",
            "refresh_token": "must-not-be-used",
        },
    )

    result = platform.execute_action("refresh_access_token", account, {})

    assert result == {
        "ok": True,
        "data": {
            "access_token": "fresh-at",
            "message": "AT 刷新成功（仅使用网页登录 Session）",
        },
    }
    assert calls == [("at-only@example.com", "http://proxy.example:8080")]


def test_refresh_access_token_relogs_with_email_otp_when_session_at_is_rejected(monkeypatch):
    calls = []

    monkeypatch.setattr(
        chatgpt_plugin,
        "_fetch_authenticated_session_status_details",
        lambda _account, proxy=None: {
            "_credential_updates": {"access_token": "rejected-session-at"},
        },
    )
    monkeypatch.setattr(
        ChatGPTPlatform,
        "_access_token_rejected_by_upstream",
        lambda _self, _account, access_token, _proxy: access_token == "rejected-session-at",
    )

    def refresh_by_email_otp(_self, account, params, proxy):
        calls.append((account.email, params, proxy))
        return {
            "access_token": "fresh-email-otp-at",
            "session_token": "fresh-web-session",
            "cookies": "fresh-web-cookies",
            "account_id": "workspace-email-otp",
            "message": "AT 已通过原邮箱 OTP 重新登录刷新（未获取 RT）",
        }

    monkeypatch.setattr(
        ChatGPTPlatform,
        "_refresh_access_token_by_email_otp",
        refresh_by_email_otp,
    )
    platform = ChatGPTPlatform(RegisterConfig())
    account = Account(
        platform="chatgpt",
        email="email-otp@example.com",
        password="",
        extra={
            "session_token": "stale-web-session",
            "refresh_token": "must-not-be-used",
        },
    )

    result = platform.execute_action(
        "refresh_access_token",
        account,
        {"browser_mode": "camoufox_headless", "proxy": "http://proxy.example:8080"},
    )

    assert result["ok"] is True
    assert result["data"]["access_token"] == "fresh-email-otp-at"
    assert "refresh_token" not in result["data"]
    assert calls == [(
        "email-otp@example.com",
        {"browser_mode": "camoufox_headless", "proxy": "http://proxy.example:8080"},
        "http://proxy.example:8080",
    )]


def test_refresh_access_token_relogs_when_session_returns_the_saved_token(monkeypatch):
    monkeypatch.setattr(
        chatgpt_plugin,
        "_fetch_authenticated_session_status_details",
        lambda _account, proxy=None: {
            "_credential_updates": {"access_token": "unchanged-session-at"},
        },
    )
    monkeypatch.setattr(
        ChatGPTPlatform,
        "_access_token_rejected_by_upstream",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        ChatGPTPlatform,
        "_refresh_access_token_by_email_otp",
        lambda _self, _account, _params, _proxy: {
            "access_token": "rotated-email-otp-at",
            "message": "AT 已通过原邮箱 OTP 重新登录刷新（未获取 RT）",
        },
    )
    platform = ChatGPTPlatform(RegisterConfig())
    account = Account(
        platform="chatgpt",
        email="unchanged-session@example.com",
        password="",
        token="unchanged-session-at",
        extra={"access_token": "unchanged-session-at", "session_token": "web-session"},
    )

    result = platform.execute_action("refresh_access_token", account, {})

    assert result["ok"] is True
    assert result["data"]["access_token"] == "rotated-email-otp-at"


def test_refresh_access_token_never_falls_back_to_rt_or_oauth(monkeypatch):
    def failed_session(_account, proxy=None):
        raise ValueError("账号缺少 session_token")

    monkeypatch.setattr(
        chatgpt_plugin,
        "_fetch_authenticated_session_status_details",
        failed_session,
    )

    def failed_email_otp(_self, _account, _params, _proxy):
        raise RuntimeError("原邮箱 OTP 登录失败")

    monkeypatch.setattr(
        ChatGPTPlatform,
        "_refresh_access_token_by_email_otp",
        failed_email_otp,
    )
    monkeypatch.setattr(
        ChatGPTPlatform,
        "_handle_get_rt",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("不得进入 RT/OAuth")),
    )
    platform = ChatGPTPlatform(RegisterConfig())
    account = Account(
        platform="chatgpt",
        email="no-session@example.com",
        password="",
        extra={"refresh_token": "must-not-be-used"},
    )

    result = platform.execute_action("refresh_access_token", account, {})

    assert result["ok"] is False
    assert "原邮箱 OTP 登录失败" in result["error"]
    assert "refresh_token" not in result
