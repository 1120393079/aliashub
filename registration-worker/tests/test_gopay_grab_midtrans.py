"""步骤②：浏览器选 GoPay 渠道 + 抓 midtrans URL 的测试。"""
from __future__ import annotations

import pytest

from application import gopay_pay_chatgpt as orch


def test_grab_midtrans_accepts_checkout_mode_string(monkeypatch):
    """step_grab_midtrans_url 接受 checkout_mode 字符串，解析成 backend_config
    并透传给 select_gopay_and_grab_midtrans。"""
    captured = {}

    def fake_select(cashier_url, *, backend_config, proxy, timeout_seconds, capture_dir, after_grab, cancel_check, log):
        captured["backend"] = backend_config.backend
        captured["window_mode"] = backend_config.window_mode
        captured["capture_dir"] = capture_dir
        return "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc"

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(payment_module, "select_gopay_and_grab_midtrans", fake_select)

    url = orch.step_grab_midtrans_url(
        "https://checkout.stripe.com/c/pay/cs_x",
        checkout_mode="bitbrowser_hidden",
        bit_profile_id="prof_123",
        log=lambda _: None,
    )
    assert url.startswith("https://app.midtrans.com/")
    assert captured["backend"] == "bitbrowser"
    assert captured["window_mode"] == "hidden"
    assert captured["capture_dir"] == ""


def test_grab_midtrans_default_camoufox(monkeypatch):
    """checkout_mode 缺省走 camoufox_headed。"""
    captured = {}

    def fake_select(cashier_url, *, backend_config, proxy, timeout_seconds, capture_dir, after_grab, cancel_check, log):
        captured["backend"] = backend_config.backend
        captured["window_mode"] = backend_config.window_mode
        return "https://app.midtrans.com/snap/v4/redirection/abc-uuid-1234"

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(payment_module, "select_gopay_and_grab_midtrans", fake_select)

    url = orch.step_grab_midtrans_url(
        "https://checkout.stripe.com/c/pay/cs_x",
        log=lambda _: None,
    )
    assert url.startswith("https://app.midtrans.com/")
    assert captured["backend"] == "camoufox"
    assert captured["window_mode"] == "headed"



# -- Task 2: _grab_midtrans_from_ready_page (选 GoPay + 填表 + 点订阅 + 抓 URL) --

def test_select_gopay_clicks_radio_fills_and_grabs_url(monkeypatch):
    """在已 goto 的 page 上：校验金额 → 点 GoPay radio → 填账单 → 点订阅 →
    轮询 page.url 命中 midtrans。"""
    from platforms.chatgpt import payment as payment_module

    events = []

    class FakeLoc:
        def __init__(self, sel):
            self.sel = sel
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **k):
            events.append(("click", self.sel))

        def check(self, **k):
            events.append(("check", self.sel))

        def fill(self, v, **k):
            events.append(("fill", self.sel, v))

    class FakePage:
        def __init__(self):
            self._n = 0

        @property
        def url(self):
            self._n += 1
            return (
                "https://checkout.stripe.com/c/pay/cs_x"
                if self._n < 3
                else "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc"
            )

        def locator(self, sel):
            return FakeLoc(sel)

        def get_by_role(self, *a, **k):
            return FakeLoc("role")

        def get_by_text(self, *a, **k):
            return FakeLoc("text")

        def get_by_label(self, *a, **k):
            return FakeLoc("label")

        def wait_for_timeout(self, ms):
            pass

        def evaluate(self, s):
            return "interactive"

    # 金额校验 / 页面 ready 是已测过的独立函数，这里 stub 掉只验证编排
    monkeypatch.setattr(payment_module, "_verify_checkout_amount_nonzero", lambda p, *, log: None)
    monkeypatch.setattr(payment_module, "_wait_checkout_page_ready", lambda p, *, timeout_ms, log: None)

    url = payment_module._grab_midtrans_from_ready_page(
        FakePage(),
        checkout_url="https://checkout.stripe.com/c/pay/cs_x",
        address={
            "email": "a@b.com", "name": "X", "line1": "1 St",
            "city": "NY", "state": "NY", "postal_code": "10001", "phone": "12345",
        },
        timeout_seconds=10,
        log=lambda _: None,
    )
    assert url.startswith("https://app.midtrans.com/")
    # GoPay radio 被点过
    assert any(
        e[0] in ("click", "check") and "gopay" in e[1].lower()
        for e in events
    ), events


def test_grab_midtrans_raises_when_no_gopay_option(monkeypatch):
    """页面没有 GoPay 支付方式选项时 raise。"""
    from platforms.chatgpt import payment as payment_module

    class EmptyLoc:
        first = None

        def __init__(self):
            self.first = self

        def count(self):
            return 0

        def is_visible(self):
            return False

        def is_enabled(self):
            return False

    class FakePage:
        url = "https://checkout.stripe.com/c/pay/cs_x"

        def locator(self, sel):
            return EmptyLoc()

        def get_by_role(self, *a, **k):
            return EmptyLoc()

        def get_by_text(self, *a, **k):
            return EmptyLoc()

        def get_by_label(self, *a, **k):
            return EmptyLoc()

        def wait_for_timeout(self, ms):
            pass

        def evaluate(self, s):
            return "interactive"

    monkeypatch.setattr(payment_module, "_verify_checkout_amount_nonzero", lambda p, *, log: None)
    monkeypatch.setattr(payment_module, "_wait_checkout_page_ready", lambda p, *, timeout_ms, log: None)

    with pytest.raises(RuntimeError, match="没有 GoPay 支付方式"):
        payment_module._grab_midtrans_from_ready_page(
            FakePage(),
            checkout_url="https://checkout.stripe.com/c/pay/cs_x",
            address={},
            timeout_seconds=2,
            log=lambda _: None,
        )
