from __future__ import annotations

import inspect

from platforms.chatgpt import browser_get_rt


class _FakePage:
    def __init__(self):
        self.routes = []

    def route(self, pattern, handler):
        self.routes.append((pattern, handler))


class _FakeRequest:
    url = "https://auth.openai.com/oauth/authorize?state=state_123&client_id=test"


class _FakeRoute:
    request = _FakeRequest()

    def __init__(self):
        self.fallback_called = False

    def fallback(self):
        self.fallback_called = True


def test_get_rt_route_handlers_are_sync_playwright_handlers():
    page = _FakePage()
    browser_get_rt._state_store.clear()

    browser_get_rt.setup_phone_otp_skip_interception(page, log=lambda _message: None)

    assert page.routes
    for _pattern, handler in page.routes:
        assert not inspect.iscoroutinefunction(handler)

    pattern, oauth_handler = page.routes[-1]
    assert pattern == "**/oauth/authorize*"

    route = _FakeRoute()
    result = oauth_handler(route)

    assert not inspect.isawaitable(result)
    assert route.fallback_called is True
    assert browser_get_rt._state_store["oauth_state"] == "state_123"


def test_oauth_state_capture_is_sync_and_does_not_rewrite_responses():
    page = _FakePage()
    browser_get_rt._state_store.clear()

    browser_get_rt.setup_oauth_state_capture(page, log=lambda _message: None)

    assert len(page.routes) == 1
    pattern, oauth_handler = page.routes[0]
    assert pattern == "**/oauth/authorize*"
    assert not inspect.iscoroutinefunction(oauth_handler)

    route = _FakeRoute()
    result = oauth_handler(route)

    assert not inspect.isawaitable(result)
    assert route.fallback_called is True
    assert browser_get_rt._state_store["oauth_state"] == "state_123"
