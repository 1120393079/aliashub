from core.base_platform import Account, RegisterConfig
from platforms.chatgpt import browser_get_rt as browser_get_rt_module
from platforms.chatgpt import browser_register as browser_register_module
from platforms.chatgpt import plugin as plugin_module
from platforms.chatgpt.plugin import ChatGPTPlatform


class _FakePage:
    def __init__(self, context):
        self.context = context


class _FakeContext:
    def __init__(self):
        self.closed = False
        self.pages = []

    def new_page(self):
        page = _FakePage(self)
        self.pages.append(page)
        return page

    def close(self):
        self.closed = True


class _FakeBrowser:
    def __init__(self):
        self.new_context_kwargs = None
        self.context = _FakeContext()
        self.new_page_called = False

    def new_context(self, **kwargs):
        self.new_context_kwargs = dict(kwargs)
        return self.context

    def new_page(self):
        self.new_page_called = True
        return _FakePage(_FakeContext())


class _FakeBrowserManager:
    def __init__(self, browser):
        self.browser = browser

    def __enter__(self):
        return self.browser

    def __exit__(self, exc_type, exc, tb):
        return False


def test_get_rt_record_har_creates_camoufox_context_and_returns_path(monkeypatch, tmp_path):
    fake_browser = _FakeBrowser()
    expected_har_path = str(tmp_path / "get-rt-user_example.com.har")

    monkeypatch.setattr(
        ChatGPTPlatform,
        "_build_get_rt_mailbox_otp_callback",
        lambda self, account, log_fn, proxy: (lambda: "123456", ""),
    )
    monkeypatch.setattr(
        browser_get_rt_module,
        "setup_oauth_state_capture",
        lambda page, log=None: None,
    )
    monkeypatch.setattr(
        browser_register_module.ChatGPTBrowserRegister,
        "_open_browser",
        lambda self, launch_opts: _FakeBrowserManager(fake_browser),
    )
    monkeypatch.setattr(
        browser_register_module,
        "_do_codex_oauth",
        lambda *args, **kwargs: {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "id_token": "id-token",
            "account_id": "acct-123",
        },
    )
    monkeypatch.setattr(
        plugin_module,
        "_build_get_rt_har_path",
        lambda email: expected_har_path,
        raising=False,
    )

    platform = ChatGPTPlatform(RegisterConfig())
    result = platform._handle_get_rt(
        Account(
            platform="chatgpt",
            email="user@example.com",
            password="Secret123!",
        ),
        {"browser_mode": "camoufox_headed", "record_har": "true"},
    )

    assert result["ok"] is True
    assert fake_browser.new_page_called is False
    assert fake_browser.new_context_kwargs == {
        "record_har_path": expected_har_path,
        "record_har_url_filter": "**/*",
    }
    assert fake_browser.context.closed is True
    assert result["data"]["record_har_path"] == expected_har_path


def test_get_rt_uses_supplied_phone_callback(monkeypatch):
    fake_browser = _FakeBrowser()
    supplied_phone_callback = lambda: "+15550000001"
    seen = {}

    monkeypatch.setattr(
        ChatGPTPlatform,
        "_build_get_rt_mailbox_otp_callback",
        lambda self, account, log_fn, proxy: (lambda: "123456", ""),
    )
    monkeypatch.setattr(
        browser_get_rt_module,
        "setup_oauth_state_capture",
        lambda page, log=None: None,
    )
    monkeypatch.setattr(
        browser_get_rt_module,
        "build_get_rt_phone_callback",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("should use supplied callback")),
    )
    monkeypatch.setattr(
        browser_register_module.ChatGPTBrowserRegister,
        "_open_browser",
        lambda self, launch_opts: _FakeBrowserManager(fake_browser),
    )

    def fake_oauth(*args, **kwargs):
        seen["phone_callback"] = args[5]
        return {
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "id_token": "id-token",
            "account_id": "acct-123",
        }

    monkeypatch.setattr(browser_register_module, "_do_codex_oauth", fake_oauth)

    platform = ChatGPTPlatform(RegisterConfig())
    result = platform._handle_get_rt(
        Account(
            platform="chatgpt",
            email="user@example.com",
            password="Secret123!",
        ),
        {
            "browser_mode": "camoufox_headed",
            "sms_provider": "smspool",
            "phone_callback": supplied_phone_callback,
        },
    )

    assert result["ok"] is True
    assert seen["phone_callback"] is supplied_phone_callback
