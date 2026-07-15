"""红包领取 claim_envelope_for_account 测试。"""
from __future__ import annotations

from application import gopay_pay_chatgpt as orch


def test_claim_envelope_calls_envelope_manager(monkeypatch):
    calls = {}

    class FakeMgr:
        def __init__(self, *a, **k):
            pass

        def add_url(self, url):
            calls["added"] = url
            return object()

        def claim_one(self, client):
            calls["claimed"] = True
            return {"status": 200}

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import envelope_manager as em
    monkeypatch.setattr(em, "EnvelopeManager", FakeMgr)

    ok = orch.claim_envelope_for_account(
        client=object(),
        envelope_url="https://app.gopay.co.id/NF8p/qps2s1y0",
        log=lambda _: None,
    )
    assert ok is True
    assert calls["added"] == "https://app.gopay.co.id/NF8p/qps2s1y0"
    assert calls["claimed"] is True


def test_claim_envelope_empty_url_returns_false():
    assert orch.claim_envelope_for_account(
        client=object(), envelope_url="", log=lambda _: None
    ) is False


def test_claim_envelope_swallows_exception(monkeypatch):
    class BoomMgr:
        def __init__(self, *a, **k):
            pass

        def add_url(self, url):
            raise RuntimeError("network down")

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import envelope_manager as em
    monkeypatch.setattr(em, "EnvelopeManager", BoomMgr)

    assert orch.claim_envelope_for_account(
        client=object(),
        envelope_url="https://app.gopay.co.id/NF8p/qps2s1y0",
        log=lambda _: None,
    ) is False


def test_claim_envelope_returns_false_when_no_envelope_available(monkeypatch):
    """claim_one 返回 None（红包已抢完）时返回 False。"""
    class FakeMgr:
        def __init__(self, *a, **k):
            pass

        def add_url(self, url):
            return object()

        def claim_one(self, client):
            return None

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import envelope_manager as em
    monkeypatch.setattr(em, "EnvelopeManager", FakeMgr)

    assert orch.claim_envelope_for_account(
        client=object(),
        envelope_url="https://app.gopay.co.id/NF8p/x",
        log=lambda _: None,
    ) is False
