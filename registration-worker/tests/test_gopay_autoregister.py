"""没有可用 GoPay 号时自动注册新号的测试。"""
from __future__ import annotations

import pytest
from sqlmodel import Session

from application import gopay_pay_chatgpt as orch
from core.db import AccountModel, AccountOverviewModel, engine


def _seed_chatgpt_account(*, email: str = "ct@x.com", access_token: str = "at_x") -> int:
    with Session(engine) as session:
        m = AccountModel(platform="chatgpt", email=email, password="pw", user_id="u")
        session.add(m); session.commit(); session.refresh(m)
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({"plan_state": "free"})
        session.add(ov); session.commit()
        from core.account_graph import patch_account_graph
        patch_account_graph(session, m, primary_token=access_token)
        session.commit()
        return int(m.id)


def test_register_gopay_account_creates_db_row(monkeypatch):
    """register_gopay_account 调 GoPay plugin 注册 + 入库，返回 AccountModel。"""
    from core.base_platform import Account, AccountStatus

    def fake_register(self, email=None, password=None):
        return Account(
            platform="gopay",
            email="+62811111111",
            password="147258",
            user_id="+62811111111",
            region="ID",
            token="811111111",
            status=AccountStatus.REGISTERED,
            extra={
                "phone": "+62811111111",
                "phone_local": "811111111",
                "pin": "147258",
                "herosms_activation_id": "AID_NEW",
                "balance_rp": 0,
                "account_overview": {
                    "balance_rp": 0,
                    "phone": "+62811111111",
                    "phone_local": "811111111",
                    "pin": "147258",
                    "herosms_activation_id": "AID_NEW",
                },
            },
        )

    from platforms.gopay import plugin as gopay_plugin
    monkeypatch.setattr(gopay_plugin.GoPayPlatform, "register", fake_register)

    model = orch.register_gopay_account(
        herosms_api_key="K_TEST",
        pin="147258",
        proxy="",
        log=lambda _: None,
    )
    assert model is not None
    assert model.platform == "gopay"
    assert model.email == "+62811111111"


def test_register_gopay_account_claims_envelope_when_balance_zero(monkeypatch):
    """注册后余额 0 + 给红包链接 → 领红包补余额，写回 balance_rp。"""
    from core.base_platform import Account, AccountStatus

    def fake_register(self, email=None, password=None):
        return Account(
            platform="gopay", email="+62822222222", password="147258",
            user_id="+62822222222", region="ID", token="822222222",
            status=AccountStatus.REGISTERED,
            extra={
                "phone": "+62822222222", "phone_local": "822222222",
                "pin": "147258", "herosms_activation_id": "AID2", "balance_rp": 0,
                "register_proxy": "",
                "account_overview": {
                    "balance_rp": 0, "phone": "+62822222222",
                    "phone_local": "822222222", "pin": "147258",
                    "herosms_activation_id": "AID2",
                },
            },
        )

    from platforms.gopay import plugin as gopay_plugin
    monkeypatch.setattr(gopay_plugin.GoPayPlatform, "register", fake_register)

    # 领红包 + resume + check_balance（领后 30000）
    monkeypatch.setattr(orch, "claim_envelope_for_account", lambda *a, **k: True)
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_resume_account", lambda phone, proxy="": {"client": object(), "phone": phone})
    monkeypatch.setattr(_w, "_check_balance", lambda client: 30000)

    model = orch.register_gopay_account(
        herosms_api_key="K_TEST",
        pin="147258",
        proxy="",
        envelope_url="https://app.gopay.co.id/NF8p/qps2s1y0",
        log=lambda _: None,
    )
    assert model is not None
    # 余额应被写回 30000
    from application.gopay_pay_chatgpt import _account_extra
    extra = _account_extra(model)
    assert int(extra.get("balance_rp") or 0) == 30000


def test_execute_auto_registers_gopay_when_none_available(monkeypatch):
    """端到端：没有可用 GoPay 号 + auto_register_gopay=True → 自动注册新号再付款。"""
    cid = _seed_chatgpt_account(email="auto@x.com", access_token="at_auto")
    # 没有任何 gopay 号

    created = {}

    def fake_register_gopay(*, herosms_api_key, pin, proxy, envelope_url="", log=print, **_kw):
        # 模拟注册并入库一个余额够的号
        with Session(engine) as session:
            m = AccountModel(platform="gopay", email="+62999", password=pin, user_id="+62999")
            session.add(m); session.commit(); session.refresh(m)
            ov = AccountOverviewModel(account_id=m.id)
            ov.set_summary({
                "balance_rp": 20000, "phone": "+62999", "phone_local": "999",
                "pin": pin, "herosms_activation_id": "AID_AUTO",
            })
            session.add(ov); session.commit()
            created["id"] = int(m.id)
            return session.get(AccountModel, int(m.id))

    monkeypatch.setattr(orch, "register_gopay_account", fake_register_gopay)

    class FakePayment:
        def __init__(self, proxy: str = ""):
            pass
        def pay(self, **_):
            return {"success": True, "detail": "OK"}

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_payment_protocol as _gpp
    from opai.core import sms_helpers as _sh
    monkeypatch.setattr(_gpp, "GoPayPayment", FakePayment)
    monkeypatch.setattr(_sh, "sms_request_another", lambda *a, **k: True)
    monkeypatch.setattr(_sh, "sms_wait_code", lambda *a, **k: "999999")
    monkeypatch.setattr(_sh, "sms_api", lambda *a, **k: "")

    out = orch.execute_gopay_pay_chatgpt(
        chatgpt_account_id=cid,
        midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/auto1234-1111-2222-3333-444455556666",
        auto_register_gopay=True,
        herosms_api_key_override="K_AUTO",
        gopay_pin="147258",
        envelope_url="https://app.gopay.co.id/NF8p/qps2s1y0",
        log=lambda _: None,
    )
    assert out["payment"]["success"] is True
    assert out["gopay_account_id"] == created["id"]


def test_execute_no_autoregister_still_fails_when_disabled(monkeypatch):
    """auto_register_gopay=False（默认）时，没号仍然失败，不触发注册。"""
    cid = _seed_chatgpt_account(email="noauto@x.com", access_token="at_noauto")

    called = {"n": 0}
    monkeypatch.setattr(orch, "register_gopay_account", lambda **k: called.__setitem__("n", called["n"] + 1))

    with pytest.raises(RuntimeError, match="没有可用的 GoPay 账号"):
        orch.execute_gopay_pay_chatgpt(
            chatgpt_account_id=cid,
            midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/x-uuid",
            herosms_api_key_override="K",
            log=lambda _: None,
        )
    assert called["n"] == 0


def _seed_gopay_pool_account(*, email: str = "+62700", balance_rp: int = 50000) -> int:
    """在号池里塞一个余额够的 gopay 号，模拟"已有可用号"。"""
    with Session(engine) as session:
        m = AccountModel(platform="gopay", email=email, password="147258", user_id=email)
        session.add(m); session.commit(); session.refresh(m)
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({
            "balance_rp": balance_rp, "phone": email, "phone_local": email.lstrip("+62"),
            "pin": "147258", "herosms_activation_id": "AID_POOL",
        })
        session.add(ov); session.commit()
        return int(m.id)


def test_execute_register_source_forces_new_even_with_account_id(monkeypatch):
    """gopay_source=register 时，即使传了 gopay_account_id（号池里的号），
    也必须强制注册新号，不复用指定号。"""
    cid = _seed_chatgpt_account(email="force@x.com", access_token="at_force")
    pool_id = _seed_gopay_pool_account(email="+62700", balance_rp=50000)

    created = {}

    def fake_register_gopay(*, herosms_api_key, pin, proxy, envelope_url="", log=print, **_kw):
        with Session(engine) as session:
            m = AccountModel(platform="gopay", email="+62NEW", password=pin, user_id="+62NEW")
            session.add(m); session.commit(); session.refresh(m)
            ov = AccountOverviewModel(account_id=m.id)
            ov.set_summary({
                "balance_rp": 20000, "phone": "+62NEW", "phone_local": "NEW",
                "pin": pin, "herosms_activation_id": "AID_FORCE",
            })
            session.add(ov); session.commit()
            created["id"] = int(m.id)
            return session.get(AccountModel, int(m.id))

    monkeypatch.setattr(orch, "register_gopay_account", fake_register_gopay)

    class FakePayment:
        def __init__(self, proxy: str = ""):
            pass
        def pay(self, **_):
            return {"success": True, "detail": "OK"}

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_payment_protocol as _gpp
    from opai.core import sms_helpers as _sh
    monkeypatch.setattr(_gpp, "GoPayPayment", FakePayment)
    monkeypatch.setattr(_sh, "sms_request_another", lambda *a, **k: True)
    monkeypatch.setattr(_sh, "sms_wait_code", lambda *a, **k: "999999")
    monkeypatch.setattr(_sh, "sms_api", lambda *a, **k: "")

    out = orch.execute_gopay_pay_chatgpt(
        chatgpt_account_id=cid,
        gopay_account_id=pool_id,  # 故意传号池里的号
        gopay_source="register",   # 但强制注册应优先
        midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/force123-1111-2222-3333-444455556666",
        herosms_api_key_override="K_FORCE",
        gopay_pin="147258",
        log=lambda _: None,
    )
    # 必须用新注册的号，而不是号池里的 pool_id
    assert out["gopay_account_id"] == created["id"]
    assert out["gopay_account_id"] != pool_id
