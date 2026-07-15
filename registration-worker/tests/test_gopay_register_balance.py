"""GoPay 注册后写 balance_rp 字段的测试。

需求：plugin.register() 成功后立即调一次 _check_balance(client)，把余额
（IDR）写进 Account.extra.balance_rp。让后续自动挑号（pick_available_gopay_account）
能拿到这个号。
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest


def _make_register_one_result(*, phone="+62811234567", local="811234567", aid="AID_X", pin="147258"):
    """构造 ``_register_one`` 的成功返回值。"""
    fake_client = SimpleNamespace()
    return {
        "phone": phone,
        "local": local,
        "aid": aid,
        "pin": pin,
        "client": fake_client,
    }


def test_register_writes_balance_rp_to_account_extra(monkeypatch):
    """注册成功后 Account.extra 必须包含 ``balance_rp``，值来自 ``_check_balance``。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    from platforms.gopay import plugin as gopay_plugin
    from core.base_platform import RegisterConfig

    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: _make_register_one_result())
    monkeypatch.setattr(_w, "_check_balance", lambda client: 12345)

    plat = gopay_plugin.GoPayPlatform(
        config=RegisterConfig(
            executor_type="protocol",
            extra={
                "identity_provider": "phone",
                "herosms_api_key": "K",
                "gopay_pin": "147258",
            },
        ),
    )
    account = plat.register()

    assert account.extra.get("balance_rp") == 12345


def test_register_balance_rp_is_zero_when_check_fails(monkeypatch):
    """``_check_balance`` 返回 -1（失败）时，``balance_rp`` 写 0 而不是 -1。
    因为下游 ``pick_available_gopay_account`` 比较 ``>= 1``，写 -1 会让号被选中。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    from platforms.gopay import plugin as gopay_plugin
    from core.base_platform import RegisterConfig

    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: _make_register_one_result())
    monkeypatch.setattr(_w, "_check_balance", lambda client: -1)

    plat = gopay_plugin.GoPayPlatform(
        config=RegisterConfig(
            executor_type="protocol",
            extra={
                "identity_provider": "phone",
                "herosms_api_key": "K",
                "gopay_pin": "147258",
            },
        ),
    )
    account = plat.register()

    assert account.extra.get("balance_rp") == 0


def test_register_swallows_check_balance_exception(monkeypatch):
    """``_check_balance`` 抛异常不能让整个注册失败——号已经注好了，只是查余额不行。
    ``balance_rp`` 写 0，注册仍然返回成功。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    from platforms.gopay import plugin as gopay_plugin
    from core.base_platform import RegisterConfig

    def _raise(client):
        raise RuntimeError("token invalid")

    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: _make_register_one_result())
    monkeypatch.setattr(_w, "_check_balance", _raise)

    plat = gopay_plugin.GoPayPlatform(
        config=RegisterConfig(
            executor_type="protocol",
            extra={
                "identity_provider": "phone",
                "herosms_api_key": "K",
                "gopay_pin": "147258",
            },
        ),
    )
    account = plat.register()

    assert account.extra.get("balance_rp") == 0
    assert account.email.startswith("+62")


def test_register_extra_keeps_pin_phone_aid_alongside_balance(monkeypatch):
    """加了 ``balance_rp`` 不能影响其它已经在 ``extra`` 里的关键字段
    （phone / phone_local / pin / herosms_activation_id 等）。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    from platforms.gopay import plugin as gopay_plugin
    from core.base_platform import RegisterConfig

    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: _make_register_one_result(
        phone="+62888", local="888", aid="AID_KEEP", pin="135790",
    ))
    monkeypatch.setattr(_w, "_check_balance", lambda client: 50000)

    plat = gopay_plugin.GoPayPlatform(
        config=RegisterConfig(
            executor_type="protocol",
            extra={
                "identity_provider": "phone",
                "herosms_api_key": "K_TEST",
                "gopay_pin": "135790",
            },
        ),
    )
    account = plat.register()

    e = account.extra
    assert e.get("phone") == "+62888"
    assert e.get("phone_local") == "888"
    assert e.get("pin") == "135790"
    assert e.get("herosms_activation_id") == "AID_KEEP"
    assert e.get("balance_rp") == 50000
    # Hero-SMS API key 不能持久化到账号 extra（前端会拿到 overview，
    # 不暴露全局 API key）；付款步骤改从 task payload 或环境变量读。
    assert e.get("herosms_api_key") is None



# -- end-to-end: register → save_account → pick_available_gopay_account ----

def test_register_then_pick_available_picks_the_freshly_registered(monkeypatch):
    """端到端：plugin.register 成功 → save_account 入库 →
    pick_available_gopay_account 必须能挑到这个号。

    这是 register 写 balance_rp 字段的真正回归保护——之前没这个字段时
    UI 上"自动挑号"永远找不到任何 GoPay 号。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    from platforms.gopay import plugin as gopay_plugin
    from core.base_platform import RegisterConfig
    from core.db import save_account
    from application import gopay_pay_chatgpt as orch

    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: _make_register_one_result(
        phone="+62888888888", local="888888888", aid="AID_E2E", pin="135790",
    ))
    monkeypatch.setattr(_w, "_check_balance", lambda client: 25000)

    plat = gopay_plugin.GoPayPlatform(
        config=RegisterConfig(
            executor_type="protocol",
            extra={
                "identity_provider": "phone",
                "herosms_api_key": "K_E2E",
                "gopay_pin": "135790",
            },
        ),
    )
    account = plat.register()
    save_account(account)

    picked = orch.pick_available_gopay_account(min_balance_rp=1)
    assert picked is not None
    assert picked.email == "+62888888888"


def test_register_with_zero_balance_not_picked_until_balance_arrives(monkeypatch):
    """红包还没到账时 balance_rp=0，pick_available_gopay_account 不该挑出来；
    后续 check_valid 把 balance_rp 改成 ≥ 1 后才能被挑。"""
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    from platforms.gopay import plugin as gopay_plugin
    from core.base_platform import RegisterConfig
    from core.db import save_account, AccountModel, engine
    from sqlmodel import Session, select
    from core.account_graph import patch_account_graph
    from application import gopay_pay_chatgpt as orch

    monkeypatch.setattr(_w, "_register_one", lambda *a, **k: _make_register_one_result(
        phone="+6299990001", local="99990001", aid="AID_NB", pin="111222",
    ))
    monkeypatch.setattr(_w, "_check_balance", lambda client: 0)  # 红包没到

    plat = gopay_plugin.GoPayPlatform(
        config=RegisterConfig(
            executor_type="protocol",
            extra={
                "identity_provider": "phone",
                "herosms_api_key": "K_NB",
                "gopay_pin": "111222",
            },
        ),
    )
    account = plat.register()
    save_account(account)

    # 还没钱 → 挑不出来
    assert orch.pick_available_gopay_account(min_balance_rp=1) is None

    # 模拟红包到账：把 balance_rp 改大
    with Session(engine) as session:
        m = session.exec(
            select(AccountModel).where(AccountModel.email == "+6299990001")
        ).first()
        assert m is not None
        patch_account_graph(session, m, summary_updates={"balance_rp": 30000})
        session.commit()

    # 现在能挑出来
    picked = orch.pick_available_gopay_account(min_balance_rp=1)
    assert picked is not None
    assert picked.email == "+6299990001"
