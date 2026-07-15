"""Hero-SMS 号码 20 分钟有效期 PhoneTTLGuard 测试。"""
from __future__ import annotations

import pytest

from application.gopay_pay_chatgpt import PhoneTTLGuard


def test_phone_ttl_guard_raises_after_deadline(monkeypatch):
    import application.gopay_pay_chatgpt as mod

    now = {"v": 1000.0}
    monkeypatch.setattr(mod.time, "monotonic", lambda: now["v"])

    g = PhoneTTLGuard(ttl_seconds=1200)
    g.check()  # 刚开始不抛

    now["v"] = 1000.0 + 1201
    with pytest.raises(RuntimeError, match="号码有效期"):
        g.check()


def test_phone_ttl_guard_ok_within_window(monkeypatch):
    import application.gopay_pay_chatgpt as mod

    now = {"v": 0.0}
    monkeypatch.setattr(mod.time, "monotonic", lambda: now["v"])

    g = PhoneTTLGuard(ttl_seconds=1200)
    now["v"] = 1199
    g.check()  # 不抛


def test_phone_ttl_guard_zero_disables(monkeypatch):
    """ttl_seconds=0 表示禁用，永不抛。"""
    import application.gopay_pay_chatgpt as mod

    now = {"v": 0.0}
    monkeypatch.setattr(mod.time, "monotonic", lambda: now["v"])

    g = PhoneTTLGuard(ttl_seconds=0)
    now["v"] = 99999
    g.check()  # 不抛
