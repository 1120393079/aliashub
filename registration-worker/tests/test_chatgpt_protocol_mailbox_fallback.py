from __future__ import annotations



import pytest



from platforms.chatgpt.register import RegistrationResult as ProtocolRegistrationResult





class _MailboxAccount:

    email = "new@example.com"

    account_id = "mailbox-1"





class _Mailbox:

    def __init__(self):

        self.before_ids_seen = None



    def get_current_ids(self, account):

        assert account is not None

        return {"old-message"}



    def wait_for_code(self, account, keyword="", timeout=600, code_pattern=None, before_ids=None):

        assert account is not None

        self.before_ids_seen = before_ids

        return "123456"





def test_protocol_mailbox_falls_back_to_browser_on_otp_timeout(monkeypatch):

    import platforms.chatgpt.browser_register as browser_register

    import platforms.chatgpt.protocol_mailbox as protocol_mailbox



    logs = []

    mailbox = _Mailbox()



    class FakeEngine:

        def __init__(self, **kwargs):

            self.email = ""

            self.password = ""



        def run(self):

            return ProtocolRegistrationResult(

                success=False,

                email=self.email,

                password=self.password,

                error_message="获取验证码失败",

            )



    class FakeBrowserRegister:

        def __init__(self, *, headless, proxy, otp_callback, phone_callback, log_fn):

            assert headless is True

            assert proxy == "http://proxy.local"

            assert phone_callback is None

            self.otp_callback = otp_callback



        def run(self, *, email, password):

            assert self.otp_callback() == "123456"

            return {

                "email": email,

                "password": password,

                "account_id": "acct_123",

                "workspace_id": "ws_123",

                "access_token": "access-token",

                "refresh_token": "refresh-token",

                "id_token": "id-token",

                "session_token": "session-token",

                "cookies": "session=abc",

                "profile": {"email": email},

                "expires_at": "2026-05-20T00:00:00Z",

            }



    monkeypatch.setattr(protocol_mailbox, "RegistrationEngine", FakeEngine)

    monkeypatch.setattr(browser_register, "ChatGPTBrowserRegister", FakeBrowserRegister)



    worker = protocol_mailbox.ChatGPTProtocolMailboxWorker(

        mailbox=mailbox,

        mailbox_account=_MailboxAccount(),

        provider="cfworker_admin_api",

        proxy_url="http://proxy.local",

        log_fn=logs.append,

    )



    result = worker.run(email="new@example.com", password="Secret123!")



    assert result.success is True

    assert result.account_id == "acct_123"

    assert result.access_token == "access-token"

    assert result.metadata["fallback"] == "browser"

    assert result.metadata["cookies"] == "session=abc"

    assert mailbox.before_ids_seen == {"old-message"}

    assert any("浏览器模式" in line for line in logs)





def test_protocol_mailbox_keeps_non_otp_errors(monkeypatch):

    import platforms.chatgpt.protocol_mailbox as protocol_mailbox



    class FakeEngine:

        def __init__(self, **kwargs):

            self.email = ""

            self.password = ""



        def run(self):

            return ProtocolRegistrationResult(

                success=False,

                email=self.email,

                password=self.password,

                error_message="IP 位置不支持",

            )



    monkeypatch.setattr(protocol_mailbox, "RegistrationEngine", FakeEngine)



    worker = protocol_mailbox.ChatGPTProtocolMailboxWorker(

        mailbox=_Mailbox(),

        mailbox_account=_MailboxAccount(),

        provider="cfworker_admin_api",

        log_fn=lambda message: None,

    )



    with pytest.raises(RuntimeError, match="IP 位置不支持"):

        worker.run(email="new@example.com", password="Secret123!")





def test_protocol_mailbox_mapper_preserves_browser_fallback_metadata():

    from platforms.chatgpt.plugin import ChatGPTPlatform



    class Ctx:

        password = "Secret123!"



    result = ProtocolRegistrationResult(

        success=True,

        email="new@example.com",

        password="Secret123!",

        account_id="acct_123",

        workspace_id="ws_123",

        access_token="access-token",

        refresh_token="refresh-token",

        id_token="id-token",

        session_token="session-token",

        metadata={

            "cookies": "session=abc",

            "profile": {"email": "new@example.com"},

            "expires_at": "2026-05-20T00:00:00Z",

        },

    )



    mapped = ChatGPTPlatform().build_protocol_mailbox_adapter().result_mapper(Ctx(), result)



    assert mapped.extra["cookies"] == "session=abc"

    assert mapped.extra["profile"] == {"email": "new@example.com"}

    assert mapped.extra["expires_at"] == "2026-05-20T00:00:00Z"
