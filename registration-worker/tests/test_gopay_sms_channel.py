"""SMSPool 接码渠道测试（需求 4）。"""
from __future__ import annotations

import json

import pytest


class _FakeResp:
    def __init__(self, data, status=200, text=None):
        self._data = data
        self.status_code = status
        self.text = text if text is not None else json.dumps(data)

    def json(self):
        return self._data


class _FakeSession:
    """模拟 tls_client.Session，按 url 后缀路由返回预设响应。"""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        for suffix, resp in self.routes.items():
            if url.endswith(suffix):
                if callable(resp):
                    return resp(kwargs)
                return resp
        return _FakeResp({"success": 0, "message": "no route"}, status=404)

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.post(url, **kwargs)


def test_smspool_get_number_parses_order_and_number(monkeypatch):
    from platforms.gopay import sms_channel

    routes = {
        "/purchase/sms": _FakeResp({
            "success": 1, "number": "6281234567890", "cc": "62",
            "order_id": "ORDER123", "phonenumber": "6281234567890",
        }),
    }
    monkeypatch.setattr(sms_channel, "_new_session", lambda: _FakeSession(routes))

    ch = sms_channel.SmsPoolChannel(api_key="KEY", country="ID", service="gojek")
    phone, order_id = ch.get_number()
    assert order_id == "ORDER123"
    assert phone == "+6281234567890"


def test_smspool_get_number_sends_max_price_and_pricing_option(monkeypatch):
    """对齐官方文档：购号带 max_price / pricing_option 控价。"""
    captured = {}

    def purchase_route(kwargs):
        captured.update(kwargs.get("data") or {})
        return _FakeResp({"success": 1, "number": "6288", "order_id": "OID"})

    routes = {"/purchase/sms": purchase_route}
    monkeypatch.setattr(sms_channel_mod(), "_new_session", lambda: _FakeSession(routes))

    from platforms.gopay import sms_channel
    ch = sms_channel.SmsPoolChannel(
        api_key="KEY", country="ID", service="gojek",
        max_price="0.5", pricing_option="1",
    )
    ch.get_number()
    assert captured.get("max_price") == "0.5"
    assert captured.get("pricing_option") == "1"
    assert captured.get("country") == "ID"
    assert captured.get("service") == "gojek"


def test_smspool_get_number_defaults_max_price_to_011(monkeypatch):
    """未显式传 max_price 时用默认 0.11；service 默认 GoJek=392。"""
    captured = {}

    def purchase_route(kwargs):
        captured.update(kwargs.get("data") or {})
        return _FakeResp({"success": 1, "number": "6288", "order_id": "OID"})

    routes = {"/purchase/sms": purchase_route}
    from platforms.gopay import sms_channel
    monkeypatch.setattr(sms_channel, "_new_session", lambda: _FakeSession(routes))

    ch = sms_channel.SmsPoolChannel(api_key="KEY")
    ch.get_number()
    assert captured.get("max_price") == "0.11"
    assert captured.get("pricing_option") == "0"
    # GoJek service id 默认 392
    assert captured.get("service") == "392"
    assert captured.get("country") == "9"


def sms_channel_mod():
    from platforms.gopay import sms_channel
    return sms_channel


def test_smspool_get_number_returns_none_on_failure(monkeypatch):
    from platforms.gopay import sms_channel

    routes = {"/purchase/sms": _FakeResp({"success": 0, "message": "no stock"})}
    monkeypatch.setattr(sms_channel, "_new_session", lambda: _FakeSession(routes))

    ch = sms_channel.SmsPoolChannel(api_key="KEY")
    phone, order_id = ch.get_number()
    assert phone is None and order_id is None


def test_smspool_wait_code_polls_until_complete(monkeypatch):
    from platforms.gopay import sms_channel

    states = [
        _FakeResp({"status": 1, "sms": ""}),       # pending
        _FakeResp({"status": 1, "sms": ""}),       # pending
        _FakeResp({"status": 3, "sms": "123456"}),  # done
    ]
    idx = {"i": 0}

    def check_route(kwargs):
        r = states[min(idx["i"], len(states) - 1)]
        idx["i"] += 1
        return r

    routes = {"/sms/check": check_route}
    monkeypatch.setattr(sms_channel, "_new_session", lambda: _FakeSession(routes))
    monkeypatch.setattr(sms_channel.time, "sleep", lambda s: None)

    ch = sms_channel.SmsPoolChannel(api_key="KEY")
    code = ch.wait_code("ORDER123", timeout=60)
    assert code == "123456"


def test_smspool_wait_code_timeout_returns_none(monkeypatch):
    from platforms.gopay import sms_channel

    routes = {"/sms/check": _FakeResp({"status": 1, "sms": ""})}
    monkeypatch.setattr(sms_channel, "_new_session", lambda: _FakeSession(routes))

    # monotonic 立即超时
    ticker = {"v": 0.0}

    def fake_mono():
        v = ticker["v"]
        ticker["v"] += 100.0
        return v

    monkeypatch.setattr(sms_channel.time, "monotonic", fake_mono)
    monkeypatch.setattr(sms_channel.time, "sleep", lambda s: None)

    ch = sms_channel.SmsPoolChannel(api_key="KEY")
    code = ch.wait_code("ORDER123", timeout=1)
    assert code is None


def test_smspool_resend_and_cancel(monkeypatch):
    from platforms.gopay import sms_channel

    routes = {
        "/sms/resend": _FakeResp({"success": 1}),
        "/sms/cancel": _FakeResp({"success": 1}),
    }
    sess = _FakeSession(routes)
    monkeypatch.setattr(sms_channel, "_new_session", lambda: sess)

    ch = sms_channel.SmsPoolChannel(api_key="KEY")
    ch.request_another("ORDER123")
    ch.cancel("ORDER123")
    posted = [c for c in sess.calls if c[0] == "POST"]
    assert any("/sms/resend" in c[1] for c in posted)
    assert any("/sms/cancel" in c[1] for c in posted)


def test_patch_smspool_replaces_worker_sms_functions(monkeypatch):
    """patch 后 worker 模块的 sms_get_number 等走 smspool 实现。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from platforms.gopay import sms_channel
    from opai.core import gopay_protocol_worker as _w

    routes = {
        "/purchase/sms": _FakeResp({"success": 1, "number": "6288899", "order_id": "OID9"}),
        "/sms/check": _FakeResp({"status": 3, "sms": "445566"}),
    }
    monkeypatch.setattr(sms_channel, "_new_session", lambda: _FakeSession(routes))
    monkeypatch.setattr(sms_channel.time, "sleep", lambda s: None)

    sms_channel.patch_worker_with_smspool(api_key="KEY", country="ID", service="gojek")

    phone, oid = _w.sms_get_number("IGNORED_KEY")
    assert phone == "+6288899"
    assert oid == "OID9"
    code = _w.sms_wait_code("IGNORED_KEY", oid, timeout=30)
    assert code == "445566"



def test_plugin_register_uses_smspool_when_provider_smspool(monkeypatch):
    """plugin.register 在 extra.sms_provider=smspool 时走 SMSPool patch，
    不调 Hero-SMS maxPrice patch。"""
    from platforms.gopay import plugin as gopay_plugin
    from platforms.gopay import sms_channel
    from core.base_platform import RegisterConfig

    patched = {"smspool": 0, "herosms": 0}

    def fake_smspool_patch(*, api_key, country="", service="", pool="", **_kw):
        patched["smspool"] += 1
        patched["smspool_key"] = api_key

    monkeypatch.setattr(sms_channel, "patch_worker_with_smspool", fake_smspool_patch)
    monkeypatch.setattr(
        gopay_plugin, "_patch_sms_get_number_with_max_price",
        lambda *a, **k: patched.__setitem__("herosms", patched["herosms"] + 1),
    )

    # mock _register_one + _check_balance
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: {
        "phone": "+62888", "local": "888", "aid": "OID1", "pin": "147258", "client": object(),
    })
    monkeypatch.setattr(_w, "_check_balance", lambda client: 0)

    cfg = RegisterConfig(
        executor_type="protocol",
        extra={
            "identity_provider": "phone",
            "sms_provider": "smspool",
            "smspool_api_key": "SMSPOOL_KEY_X",
            "gopay_pin": "147258",
        },
    )
    plat = gopay_plugin.GoPayPlatform(config=cfg)
    account = plat.register()

    assert patched["smspool"] == 1
    assert patched["herosms"] == 0
    assert patched["smspool_key"] == "SMSPOOL_KEY_X"
    assert account.email == "+62888"


def test_plugin_register_uses_herosms_by_default(monkeypatch):
    """默认 sms_provider=herosms 走 maxPrice patch，不碰 smspool。"""
    from platforms.gopay import plugin as gopay_plugin
    from platforms.gopay import sms_channel
    from core.base_platform import RegisterConfig

    patched = {"smspool": 0, "herosms": 0}
    monkeypatch.setattr(
        sms_channel, "patch_worker_with_smspool",
        lambda *a, **k: patched.__setitem__("smspool", patched["smspool"] + 1),
    )
    monkeypatch.setattr(
        gopay_plugin, "_patch_sms_get_number_with_max_price",
        lambda *a, **k: patched.__setitem__("herosms", patched["herosms"] + 1),
    )

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: {
        "phone": "+62999", "local": "999", "aid": "AID1", "pin": "147258", "client": object(),
    })
    monkeypatch.setattr(_w, "_check_balance", lambda client: 0)

    cfg = RegisterConfig(
        executor_type="protocol",
        extra={
            "identity_provider": "phone",
            "herosms_api_key": "HERO_KEY",
            "gopay_pin": "147258",
        },
    )
    plat = gopay_plugin.GoPayPlatform(config=cfg)
    plat.register()

    assert patched["herosms"] == 1
    assert patched["smspool"] == 0
