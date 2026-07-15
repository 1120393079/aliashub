from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from core.proxy_urls import ProxyUrlError
from platforms.chatgpt import browser_register


class _StreamingResponse:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.closed = False

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size=1):
        yield from self._chunks

    def close(self):
        self.closed = True


class _BrowserResponse:
    ok = True

    def __init__(self, ip):
        self.ip = ip
        self.disposed = False

    def json(self):
        return {"ip": self.ip}

    def dispose(self):
        self.disposed = True


def _page_with_ip(ip):
    response = _BrowserResponse(ip)
    page = SimpleNamespace(
        request=SimpleNamespace(get=lambda *args, **kwargs: response),
    )
    return page, response


def test_proxy_request_url_reencodes_decoded_userinfo():
    config = browser_register._build_proxy_config(
        "http://user%40corp:p%3Ass%2Fword@proxy.example:8080"
    )

    assert config == {
        "server": "http://proxy.example:8080",
        "username": "user@corp",
        "password": "p:ss/word",
    }
    assert browser_register._proxy_requests_url(config) == (
        "http://user%40corp:p%3Ass%2Fword@proxy.example:8080"
    )


def test_registration_proxy_parser_error_never_contains_input_credentials():
    value = "http://proxy-user:super-secret@proxy／example:8080"

    with pytest.raises(ProxyUrlError) as raised:
        browser_register._build_proxy_config(value)

    assert str(raised.value) == "代理地址无效"
    assert "proxy-user" not in str(raised.value)
    assert "super-secret" not in str(raised.value)
    assert "proxy" not in str(raised.value)


@pytest.mark.parametrize(
    "value",
    [
        "http://proxy.example:8080\n",
        "\thttp://proxy.example:8080",
        "http://proxy.exa\rmple:8080",
        "http://user:%0Asecret@proxy.example:8080",
    ],
)
def test_registration_proxy_parser_rejects_raw_and_decoded_controls(value):
    with pytest.raises(ProxyUrlError, match="^代理地址无效$"):
        browser_register._build_proxy_config(value)


def test_detect_public_ip_uses_tls_streaming_and_canonicalizes_ipv6(monkeypatch):
    response = _StreamingResponse([
        b"2001:0DB8:0000:0000:0000:0000:0000:0001",
        b"\n",
    ])
    captured = {}

    def get(url, **kwargs):
        captured.update({"url": url, **kwargs})
        return response

    monkeypatch.setattr(browser_register.requests, "get", get)
    deadline = time.monotonic() + 1

    result = browser_register._detect_public_ip(
        {"server": "http://proxy.example:8080"},
        deadline=deadline,
    )

    assert result == "2001:db8::1"
    assert captured["verify"] is True
    assert captured["stream"] is True
    assert captured["timeout"][0] <= 1
    assert captured["timeout"][1] <= 1
    assert response.closed is True


def test_detect_public_ip_outer_deadline_bounds_blocking_request(monkeypatch):
    release = threading.Event()
    calls = []

    def blocking_get(*args, **kwargs):
        calls.append(kwargs)
        release.wait(2)
        raise RuntimeError("blocked request released")

    monkeypatch.setattr(browser_register.requests, "get", blocking_get)
    started = time.monotonic()

    try:
        with pytest.raises(RuntimeError) as raised:
            browser_register._detect_public_ip(
                {
                    "server": "http://proxy.example:8080",
                    "username": "proxy-user",
                    "password": "super-secret",
                },
                deadline=started + 0.1,
            )
    finally:
        release.set()
    elapsed = time.monotonic() - started

    assert str(raised.value) == "无法识别浏览器出口 IP"
    assert "proxy-user" not in str(raised.value)
    assert "super-secret" not in str(raised.value)
    assert len(calls) == 1
    assert elapsed < 0.5


def test_browser_exit_comparison_uses_canonical_ipv6_and_disposes_response():
    page, response = _page_with_ip("2001:db8::1")

    result = browser_register._verify_browser_exit(
        page,
        "2001:0DB8:0000:0000:0000:0000:0000:0001",
    )

    assert result == "2001:db8::1"
    assert response.disposed is True


def test_browser_exit_any_ip_change_is_fatal():
    page, _response = _page_with_ip("198.51.100.8")

    with pytest.raises(
        browser_register.BrowserProxyExitChangedError,
        match="198.51.100.7 -> 198.51.100.8",
    ):
        browser_register._verify_browser_exit(page, "198.51.100.7")


def test_browser_exit_probe_failure_is_closed_when_proxy_is_configured():
    page = SimpleNamespace(
        request=SimpleNamespace(
            get=lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError("http://proxy-user:super-secret@proxy.example:8080")
            )
        )
    )

    with pytest.raises(browser_register.BrowserProxyVerificationError) as raised:
        browser_register._verify_browser_exit_for_flow(
            page,
            "198.51.100.7",
            proxy={"server": "http://proxy.example:8080"},
            log=lambda message: None,
            no_proxy_failure_message="continue",
        )

    assert str(raised.value) == "浏览器代理出口复核失败"
    assert "proxy-user" not in str(raised.value)
    assert "super-secret" not in str(raised.value)


def test_browser_exit_probe_failure_can_continue_without_proxy():
    logs = []
    page = SimpleNamespace(
        request=SimpleNamespace(
            get=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("offline"))
        )
    )

    result = browser_register._verify_browser_exit_for_flow(
        page,
        "198.51.100.7",
        proxy=None,
        log=logs.append,
        no_proxy_failure_message="continue without proxy",
    )

    assert result is None
    assert logs == ["continue without proxy"]


class _FakeBrowser:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_main_registration_stops_before_flow_when_proxy_recheck_fails(monkeypatch):
    flow_called = []
    worker = browser_register.ChatGPTBrowserRegister(
        headless=True,
        proxy="http://proxy.example:8080",
        log_fn=lambda message: None,
    )
    page = SimpleNamespace(context=SimpleNamespace(clear_cookies=lambda: None))
    monkeypatch.setattr(worker, "_open_browser", lambda launch_opts: _FakeBrowser())
    monkeypatch.setattr(worker, "_new_isolated_page", lambda browser: page)
    monkeypatch.setattr(browser_register, "_fingerprint_snapshot", lambda page: {})
    monkeypatch.setattr(
        browser_register,
        "_apply_regional_fingerprint",
        lambda launch_opts, proxy, log: {
            "ip": "198.51.100.7",
            "locale": "en-US",
            "timezone": "America/New_York",
        },
    )
    monkeypatch.setattr(
        browser_register,
        "_verify_browser_exit_for_flow",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            browser_register.BrowserProxyVerificationError("浏览器代理出口复核失败")
        ),
    )
    monkeypatch.setattr(
        browser_register,
        "_browser_registration_flow",
        lambda *args, **kwargs: flow_called.append(True),
    )

    with pytest.raises(browser_register.BrowserProxyVerificationError):
        worker.run("user@example.com", "Secret123!")

    assert flow_called == []


def test_main_registration_stops_when_exit_changes_after_registration_flow(monkeypatch):
    checks = []
    session_fetches = []
    worker = browser_register.ChatGPTBrowserRegister(
        headless=True,
        proxy="http://proxy.example:8080",
        log_fn=lambda message: None,
    )
    page = SimpleNamespace(context=SimpleNamespace(clear_cookies=lambda: None))
    monkeypatch.setattr(worker, "_open_browser", lambda launch_opts: _FakeBrowser())
    monkeypatch.setattr(worker, "_new_isolated_page", lambda browser: page)
    monkeypatch.setattr(browser_register, "_fingerprint_snapshot", lambda page: {})
    monkeypatch.setattr(
        browser_register,
        "_apply_regional_fingerprint",
        lambda launch_opts, proxy, log: {
            "ip": "198.51.100.7",
            "locale": "en-US",
            "timezone": "America/New_York",
        },
    )

    def verify(*args, **kwargs):
        checks.append(True)
        if len(checks) == 1:
            return "198.51.100.7"
        raise browser_register.BrowserProxyExitChangedError(
            "代理出口在浏览器启动后发生变化: 198.51.100.7 -> 198.51.100.8"
        )

    monkeypatch.setattr(browser_register, "_verify_browser_exit_for_flow", verify)
    monkeypatch.setattr(
        browser_register,
        "_browser_registration_flow",
        lambda *args, **kwargs: {
            "page_type": "chatgpt_home",
            "post_signup_ready": True,
        },
    )
    monkeypatch.setattr(
        browser_register,
        "_fetch_chatgpt_session_from_page",
        lambda *args, **kwargs: session_fetches.append(True),
    )

    with pytest.raises(browser_register.BrowserProxyExitChangedError):
        worker.run("user@example.com", "Secret123!")

    assert len(checks) == 2
    assert session_fetches == []


def test_fresh_oauth_stops_before_oauth_when_proxy_recheck_fails(monkeypatch):
    oauth_called = []
    worker = browser_register.ChatGPTBrowserRegister(
        headless=True,
        proxy="http://proxy.example:8080",
        log_fn=lambda message: None,
    )
    monkeypatch.setattr(worker, "_open_browser", lambda launch_opts: _FakeBrowser())
    monkeypatch.setattr(worker, "_new_isolated_page", lambda browser: object())
    monkeypatch.setattr(
        browser_register,
        "_apply_regional_fingerprint",
        lambda launch_opts, proxy, log: {
            "ip": "198.51.100.7",
            "locale": "en-US",
            "timezone": "America/New_York",
        },
    )
    monkeypatch.setattr(
        browser_register,
        "_verify_browser_exit_for_flow",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            browser_register.BrowserProxyVerificationError("浏览器代理出口复核失败")
        ),
    )
    monkeypatch.setattr(
        browser_register,
        "_do_codex_oauth",
        lambda *args, **kwargs: oauth_called.append(True),
    )

    result = worker._retry_oauth_fresh_browser("user@example.com", "Secret123!")

    assert result is None
    assert oauth_called == []


def test_fresh_oauth_discards_result_when_exit_changes_during_oauth(monkeypatch):
    checks = []
    oauth_called = []
    worker = browser_register.ChatGPTBrowserRegister(
        headless=True,
        proxy="http://proxy.example:8080",
        log_fn=lambda message: None,
    )
    monkeypatch.setattr(worker, "_open_browser", lambda launch_opts: _FakeBrowser())
    monkeypatch.setattr(worker, "_new_isolated_page", lambda browser: object())
    monkeypatch.setattr(
        browser_register,
        "_apply_regional_fingerprint",
        lambda launch_opts, proxy, log: {
            "ip": "198.51.100.7",
            "locale": "en-US",
            "timezone": "America/New_York",
        },
    )

    def verify(*args, **kwargs):
        checks.append(True)
        if len(checks) == 1:
            return "198.51.100.7"
        raise browser_register.BrowserProxyExitChangedError(
            "代理出口在浏览器启动后发生变化: 198.51.100.7 -> 198.51.100.8"
        )

    monkeypatch.setattr(browser_register, "_verify_browser_exit_for_flow", verify)
    monkeypatch.setattr(
        browser_register,
        "_do_codex_oauth",
        lambda *args, **kwargs: oauth_called.append(True) or {"access_token": "at"},
    )

    result = worker._retry_oauth_fresh_browser("user@example.com", "Secret123!")

    assert result is None
    assert oauth_called == [True]
    assert len(checks) == 2
