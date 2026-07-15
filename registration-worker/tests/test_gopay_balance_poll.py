"""余额不足时轮询等红包/充值的测试（需求 1）。"""
from __future__ import annotations

import pytest

from application import gopay_pay_chatgpt as orch
from application.gopay_pay_chatgpt import PhoneTTLGuard


def test_wait_for_balance_polls_until_positive(monkeypatch):
    """前两次余额 0，第三次 20000 → 返回 20000。"""
    balances = [0, 0, 20000]
    calls = {"n": 0}

    def fake_check(client):
        i = calls["n"]
        calls["n"] += 1
        return balances[min(i, len(balances) - 1)]

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_check_balance", fake_check)

    # 不真 sleep
    import application.gopay_pay_chatgpt as mod
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)

    guard = PhoneTTLGuard(ttl_seconds=1200)
    bal = orch.wait_for_balance(
        client=object(),
        envelope_url="",
        ttl_guard=guard,
        poll_interval=0,
        log=lambda _: None,
    )
    assert bal == 20000
    assert calls["n"] >= 3


def test_wait_for_balance_claims_envelope_each_round(monkeypatch):
    """有红包链接时每轮先尝试领红包。"""
    claim_calls = {"n": 0}
    monkeypatch.setattr(orch, "claim_envelope_for_account",
                        lambda *a, **k: claim_calls.__setitem__("n", claim_calls["n"] + 1) or True)

    balances = [0, 50000]
    calls = {"n": 0}

    def fake_check(client):
        i = calls["n"]; calls["n"] += 1
        return balances[min(i, len(balances) - 1)]

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_check_balance", fake_check)
    import application.gopay_pay_chatgpt as mod
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)

    guard = PhoneTTLGuard(ttl_seconds=1200)
    bal = orch.wait_for_balance(
        client=object(),
        envelope_url="https://app.gopay.co.id/NF8p/x",
        ttl_guard=guard,
        poll_interval=0,
        log=lambda _: None,
    )
    assert bal == 50000
    assert claim_calls["n"] >= 1


def test_wait_for_balance_raises_on_ttl_timeout(monkeypatch):
    """余额一直 0 且 TTL 超时 → 抛错。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_check_balance", lambda client: 0)

    import application.gopay_pay_chatgpt as mod
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)

    # 让 ttl_guard 立刻判超时
    now = {"v": 0.0}
    monkeypatch.setattr(mod.time, "monotonic", lambda: now["v"])
    guard = PhoneTTLGuard(ttl_seconds=1200)
    now["v"] = 1300  # 超过 ttl

    with pytest.raises(RuntimeError, match="号码有效期"):
        orch.wait_for_balance(
            client=object(),
            envelope_url="",
            ttl_guard=guard,
            poll_interval=0,
            log=lambda _: None,
        )
