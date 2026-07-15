from core.base_platform import Account, RegisterConfig
from platforms.chatgpt.plugin import ChatGPTPlatform


def test_get_rt_mailbox_otp_callback_uses_attached_mailbox_resource(monkeypatch):
    captured = {}

    class FakeMailbox:
        def get_current_ids(self, account):
            captured["baseline_account"] = account
            return {"old-message"}

        def wait_for_code(self, account, keyword="", timeout=120, before_ids=None, code_pattern=None):
            captured["wait_account"] = account
            captured["wait_keyword"] = keyword
            captured["wait_timeout"] = timeout
            captured["wait_before_ids"] = before_ids
            return "654321"

    def fake_create_mailbox(provider, extra=None, proxy=None):
        captured["provider"] = provider
        captured["extra"] = extra
        captured["proxy"] = proxy
        return FakeMailbox()

    import core.base_mailbox as base_mailbox

    monkeypatch.setattr(base_mailbox, "create_mailbox", fake_create_mailbox)

    mailbox_resource = {
        "provider_type": "mailbox",
        "provider_name": "local_ms_pool",
        "resource_type": "mailbox",
        "resource_identifier": "real@example.com",
        "handle": "real@example.com",
        "display_name": "real@example.com",
        "metadata": {"email": "real@example.com", "source": "gujumpgate_hotmail"},
    }
    provider_account = {
        "provider_type": "mailbox",
        "provider_name": "local_ms_pool",
        "login_identifier": "real@example.com",
        "display_name": "real@example.com",
        "credentials": {
            "email": "real@example.com",
            "password": "mail-password",
            "client_id": "client-id",
            "refresh_token": "mail-refresh-token",
        },
        "metadata": {"source": "gujumpgate_hotmail"},
    }
    account = Account(
        platform="chatgpt",
        email="real@example.com",
        password="chatgpt-password",
        extra={
            "provider_resources": [mailbox_resource],
            "provider_accounts": [provider_account],
        },
    )
    platform = ChatGPTPlatform(RegisterConfig())
    logs = []

    callback, error = platform._build_get_rt_mailbox_otp_callback(
        account,
        logs.append,
        proxy="http://proxy.example",
    )

    assert error == ""
    assert callback is not None
    assert captured["provider"] == "local_ms_pool"
    assert captured["proxy"] == "http://proxy.example"
    assert captured["extra"]["provider_resource"] == mailbox_resource
    assert captured["extra"]["provider_account"] == provider_account
    assert callback() == "654321"

    wait_account = captured["wait_account"]
    assert wait_account.email == "real@example.com"
    assert wait_account.account_id == "real@example.com"
    assert wait_account.extra["mailbox_provider_key"] == "local_ms_pool"
    assert wait_account.extra["provider_account"]["credentials"]["refresh_token"] == "mail-refresh-token"
    assert captured["wait_before_ids"] == {"old-message"}
    assert captured["wait_timeout"] == 5


def test_get_rt_mailbox_otp_callback_maps_cloud_mail_to_cfworker(monkeypatch):
    captured = {}

    class FakeMailbox:
        def get_current_ids(self, account):
            captured["baseline_account"] = account
            return set()

        def wait_for_code(self, account, keyword="", timeout=120, before_ids=None, code_pattern=None):
            captured["wait_account"] = account
            return "123456"

    def fake_create_mailbox(provider, extra=None, proxy=None):
        captured["provider"] = provider
        captured["extra"] = extra
        return FakeMailbox()

    import core.base_mailbox as base_mailbox

    monkeypatch.setattr(base_mailbox, "create_mailbox", fake_create_mailbox)

    account = Account(
        platform="chatgpt",
        email="user@mail.example.test",
        password="chatgpt-password",
        extra={
            "provider_resources": [
                {
                    "provider_type": "mailbox",
                    "provider_name": "cloud_mail",
                    "resource_type": "mailbox",
                    "resource_identifier": "user@mail.example.test",
                    "handle": "user@mail.example.test",
                    "display_name": "user@mail.example.test",
                    "metadata": {
                        "email": "user@mail.example.test",
                        "api_url": "https://mail.example.test",
                        "domain": "mail.example.test",
                        "api_mode": "cloud_mail",
                    },
                }
            ],
            "provider_accounts": [
                {
                    "provider_type": "mailbox",
                    "provider_name": "cfworker_admin_api",
                    "login_identifier": "user@mail.example.test",
                    "display_name": "user@mail.example.test",
                    "credentials": {},
                    "metadata": {"account_id": "user@mail.example.test"},
                }
            ],
        },
    )
    platform = ChatGPTPlatform(RegisterConfig())

    callback, error = platform._build_get_rt_mailbox_otp_callback(
        account,
        lambda _message: None,
        proxy=None,
    )

    assert error == ""
    assert callback is not None
    assert captured["provider"] == "cfworker_admin_api"
    assert captured["extra"]["cfworker_api_url"] == "https://mail.example.test"
    assert captured["extra"]["cfworker_domain"] == "mail.example.test"
    assert captured["extra"]["provider_resource"]["provider_name"] == "cloud_mail"
    assert captured["extra"]["provider_account"]["provider_name"] == "cfworker_admin_api"
    assert callback() == "123456"
    assert captured["wait_account"].extra["mailbox_provider_key"] == "cfworker_admin_api"
