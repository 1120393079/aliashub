"""Tests for the gopay_pay_chatgpt task type integration into application/tasks.py."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlmodel import Session

from application import gopay_pay_chatgpt as orch
from application.tasks import (
    TASK_STATUS_FAILED,
    TASK_STATUS_SUCCEEDED,
    TASK_TYPE_GOPAY_REGISTER_ACCOUNT,
    TASK_TYPE_GOPAY_PAY_CHATGPT,
    create_gopay_register_account_task,
    create_gopay_pay_chatgpt_task,
    execute_task,
    get_task,
)
from core.db import AccountModel, AccountOverviewModel, engine


def _seed_chatgpt_account(*, email: str = "ct@example.com") -> int:
    with Session(engine) as session:
        m = AccountModel(platform="chatgpt", email=email, password="pw", user_id="u")
        session.add(m); session.commit(); session.refresh(m)
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({"plan_state": "free"})
        session.add(ov); session.commit()
        from core.account_graph import patch_account_graph
        patch_account_graph(session, m, primary_token="at_x")
        session.commit()
        return int(m.id)


def _seed_gopay_account(*, balance_rp: int = 20000) -> int:
    with Session(engine) as session:
        m = AccountModel(platform="gopay", email="+62811", password="147258", user_id="+62811")
        session.add(m); session.commit(); session.refresh(m)
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({
            "balance_rp": balance_rp,
            "phone": "+62811",
            "phone_local": "811",
            "pin": "147258",
            "herosms_activation_id": "AID_X",
            "register_proxy": "",
        })
        session.add(ov); session.commit()
        return int(m.id)


def test_create_gopay_register_account_task_persists_payload():
    """GoPay 单独注册按钮创建独立任务，不混入 ChatGPT 付款任务。"""
    task = create_gopay_register_account_task({
        "gopay_pin": "654321",
        "sms_provider": "smsapi",
        "smsapi_url": "https://sms.example/latest",
        "smsapi_phone": "+628123456789",
    })
    assert task["type"] == TASK_TYPE_GOPAY_REGISTER_ACCOUNT
    assert task["platform"] == "gopay"
    assert task["progress_detail"]["total"] == 1
    again = get_task(task["task_id"])
    assert again is not None


def test_execute_gopay_register_account_task_succeeds(monkeypatch):
    """执行 GoPay 注册任务：只调 register_gopay_account，返回账号后任务成功。"""
    captured: dict[str, Any] = {}

    def fake_register_gopay_account(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            id=321,
            email="+628123456789",
            user_id="+628123456789",
            extra={"phone": "+628123456789", "balance_rp": 0},
        )

    monkeypatch.setattr(orch, "register_gopay_account", fake_register_gopay_account)

    task = create_gopay_register_account_task({
        "gopay_pin": "654321",
        "sms_provider": "smsapi",
        "smsapi_url": "https://sms.example/latest",
        "smsapi_phone": "+628123456789",
        "envelope_url": "https://app.gopay.co.id/NF8p/test",
        "auto_rebind": True,
        "rebind_provider": "smsbower",
        "rebind_sms_key": "RB_KEY",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_SUCCEEDED, final
    assert final["success"] == 1
    assert final["error_count"] == 0
    assert final["data"]["account_id"] == 321
    assert final["data"]["phone"] == "+628123456789"
    assert captured["pin"] == "654321"
    assert captured["sms_provider"] == "smsapi"
    assert captured["smsapi_url"] == "https://sms.example/latest"
    assert captured["smsapi_phone"] == "+628123456789"
    assert captured["auto_rebind"] is True
    assert captured["rebind_provider"] == "smsbower"
    assert captured["rebind_sms_key"] == "RB_KEY"


def test_execute_gopay_register_account_task_fails_when_registration_returns_none(monkeypatch):
    """协议注册没有产出账号时，任务直接失败并写入错误。"""
    monkeypatch.setattr(orch, "register_gopay_account", lambda **_: None)

    task = create_gopay_register_account_task({
        "gopay_pin": "147258",
        "sms_provider": "herosms",
        "herosms_api_key": "K_TEST",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_FAILED
    assert final["error_count"] == 1
    assert "GoPay" in (final["error"] or "")


def test_create_gopay_pay_chatgpt_task_persists_payload():
    """task 创建必须把 payload 完整存进去，progress_total = 账号数。"""
    cid1 = _seed_chatgpt_account(email="a@x.com")
    cid2 = _seed_chatgpt_account(email="b@x.com")
    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [cid1, cid2],
        "country": "ID",
        "currency": "IDR",
        "headless": True,
    })
    assert task["type"] == TASK_TYPE_GOPAY_PAY_CHATGPT
    assert task["platform"] == "chatgpt"
    assert task["progress_detail"]["total"] == 2
    # 重新读出来确认 payload 持久化了
    again = get_task(task["task_id"])
    assert again is not None


def test_execute_task_dispatches_gopay_pay_chatgpt(monkeypatch):
    """完整：通过 execute_task 分发器路由到 _execute_gopay_pay_chatgpt_task，
    流水线全部走 mock，最终任务状态 = succeeded。"""
    cid = _seed_chatgpt_account()
    _seed_gopay_account(balance_rp=20000)

    # mock 协议付款
    class FakePayment:
        def __init__(self, proxy: str = ""):
            pass
        def pay(self, **_):
            return {"success": True, "detail": "OK", "transaction_status": "settlement"}

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_payment_protocol as _gpp
    from opai.core import sms_helpers as _sh
    monkeypatch.setattr(_gpp, "GoPayPayment", FakePayment)
    monkeypatch.setattr(_sh, "sms_request_another", lambda *a, **k: True)
    monkeypatch.setattr(_sh, "sms_wait_code", lambda *a, **k: "999999")
    monkeypatch.setattr(_sh, "sms_api", lambda *a, **k: "")

    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [cid],
        "midtrans_url_override": "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc",
        "herosms_api_key": "K_TEST",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_SUCCEEDED, final
    assert final["success"] == 1


def test_execute_task_marks_failed_on_missing_chatgpt_account(monkeypatch):
    """ChatGPT 账号不存在 → task 标 failed，error_count=1。"""
    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [99999],
        "midtrans_url_override": "https://app.midtrans.com/snap/v4/redirection/abc-123-456",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_FAILED
    assert final["error_count"] == 1


def test_execute_task_marks_failed_when_no_gopay_available():
    """有 ChatGPT 但没可用 GoPay 号 → failed。"""
    cid = _seed_chatgpt_account()
    _seed_gopay_account(balance_rp=0)  # 余额不足

    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [cid],
        "midtrans_url_override": "https://app.midtrans.com/snap/v4/redirection/abc-x",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_FAILED
    # 错误信息里应明确说"没有可用的 GoPay 账号"
    err_text = (final.get("error") or "") + " ".join(final.get("errors") or [])
    assert "GoPay" in err_text


def test_execute_task_failed_chatgpt_then_succeed_other(monkeypatch):
    """混合场景：账号 1 不存在 → 失败；账号 2 正常 → 成功。task 整体 failed
    （任意一条失败就算 failed），但 success_count=1, failure_count=1。

    多账号场景下 task 会忽略 midtrans_url_override（因为它绑在某一个账号上
    无法广播），所以这里要 mock 浏览器抓 midtrans 这一步。
    """
    # 一个不存在 + 一个存在
    cid_bad = 99999
    cid_good = _seed_chatgpt_account(email="good@x.com")
    _seed_gopay_account(balance_rp=20000)

    # mock 协议拿 cashier_url
    from platforms.chatgpt import payment as chatgpt_payment
    monkeypatch.setattr(
        chatgpt_payment, "generate_plus_link",
        lambda *a, **k: "https://checkout.stripe.com/c/pay/cs_test_yy",
    )
    # mock 浏览器步骤 ②（多账号场景 task 忽略 override，必须打这个 patch）
    from application import gopay_pay_chatgpt as orch
    monkeypatch.setattr(
        orch, "step_grab_midtrans_url",
        lambda *a, **k: "https://app.midtrans.com/snap/v4/redirection/abc-123-456-uuid-1234",
    )

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

    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [cid_bad, cid_good],
        "herosms_api_key": "K_TEST",
    })
    execute_task(task["task_id"])
    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_FAILED
    assert final["success"] == 1
    assert final["error_count"] >= 1



# -- Task 5: 多账户多线程 + checkout_mode 透传 --

def test_task_concurrent_two_accounts(monkeypatch):
    """并发 2 账号：mock 编排器，验证 success_count=2、payload 透传 checkout_mode。"""
    seen = []
    captured = {}

    def fake_exec(**kwargs):
        seen.append(kwargs["chatgpt_account_id"])
        captured["checkout_mode"] = kwargs.get("checkout_mode")
        captured["bit_profile_id"] = kwargs.get("bit_profile_id")
        captured["envelope_url"] = kwargs.get("envelope_url")
        return {
            "chatgpt_account_id": kwargs["chatgpt_account_id"],
            "gopay_account_id": 1,
            "midtrans_url": "x",
            "payment": {"success": True},
        }

    monkeypatch.setattr(orch, "execute_gopay_pay_chatgpt", fake_exec)
    # 隔离 BitBrowser profile 池（本测试只验证并发 + 透传，不验证池）
    import application.tasks as tasks_mod
    monkeypatch.setattr(
        "application.bitbrowser_profiles.acquire_profile_for_browser_mode",
        lambda mode, *, fallback="", log_fn=None: (fallback or "prof_pool", "prof_pool"),
        raising=False,
    )
    monkeypatch.setattr(
        "application.bitbrowser_profiles.release_acquired_profile",
        lambda pid, *, log_fn=None: None,
        raising=False,
    )

    c1 = _seed_chatgpt_account(email="a@x.com")
    c2 = _seed_chatgpt_account(email="b@x.com")
    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [c1, c2],
        "concurrency": 2,
        "checkout_mode": "bitbrowser_hidden",
        "envelope_url": "https://app.gopay.co.id/NF8p/qps2s1y0",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_SUCCEEDED
    assert final["success"] == 2
    assert set(seen) == {c1, c2}
    assert captured["checkout_mode"] == "bitbrowser_hidden"
    # bitbrowser 模式 profile 从池取（不再由前端传），透传给编排器
    assert captured["bit_profile_id"] == "prof_pool"
    assert captured["envelope_url"] == "https://app.gopay.co.id/NF8p/qps2s1y0"


# -- Task 6: 未选 ChatGPT 账号则先注册 --

def test_task_registers_when_no_chatgpt_selected(monkeypatch):
    """chatgpt_account_ids=[] + register_count=2 → 先注册 ChatGPT 拿到 id 再付款。"""
    from application import tasks as tasks_mod

    registered = []

    def fake_register(register_count, register_extra, logger, **kwargs):
        ids = [_seed_chatgpt_account(email=f"new{i}@x.com") for i in range(register_count)]
        registered.extend(ids)
        return ids

    monkeypatch.setattr(tasks_mod, "_register_chatgpt_accounts_for_gopay", fake_register, raising=False)
    monkeypatch.setattr(orch, "execute_gopay_pay_chatgpt", lambda **k: {
        "chatgpt_account_id": k["chatgpt_account_id"],
        "gopay_account_id": 1,
        "midtrans_url": "x",
        "payment": {"success": True},
    })

    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [],
        "register_count": 2,
        "register_extra": {"identity_provider": "mailbox"},
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final is not None
    assert len(registered) == 2
    assert final["success"] == 2


def test_task_fails_when_no_accounts_and_no_register():
    """既没选账号也没设 register_count → 失败。"""
    task = create_gopay_pay_chatgpt_task({"chatgpt_account_ids": []})
    execute_task(task["task_id"])
    final = get_task(task["task_id"])
    assert final is not None
    assert final["status"] == TASK_STATUS_FAILED



def test_task_bitbrowser_acquires_profile_from_pool(monkeypatch):
    """BitBrowser 模式：profile 从池 acquire 并 release，透传给编排器。"""
    acquired = []
    released = []

    def fake_acquire(mode, *, fallback="", log_fn=None):
        acquired.append(mode)
        return ("POOL_PROFILE_1", "POOL_PROFILE_1")

    def fake_release(pid, *, log_fn=None):
        released.append(pid)

    monkeypatch.setattr(
        "application.bitbrowser_profiles.acquire_profile_for_browser_mode",
        fake_acquire, raising=False,
    )
    monkeypatch.setattr(
        "application.bitbrowser_profiles.release_acquired_profile",
        fake_release, raising=False,
    )

    captured = {}

    def fake_exec(**kwargs):
        captured["bit_profile_id"] = kwargs.get("bit_profile_id")
        return {
            "chatgpt_account_id": kwargs["chatgpt_account_id"],
            "gopay_account_id": 1, "midtrans_url": "x", "payment": {"success": True},
        }

    monkeypatch.setattr(orch, "execute_gopay_pay_chatgpt", fake_exec)

    cid = _seed_chatgpt_account(email="bp@x.com")
    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [cid],
        "checkout_mode": "bitbrowser_headless",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final["status"] == TASK_STATUS_SUCCEEDED
    assert captured["bit_profile_id"] == "POOL_PROFILE_1"
    assert acquired == ["bitbrowser_headless"]
    assert released == ["POOL_PROFILE_1"]


def test_task_camoufox_does_not_touch_profile_pool(monkeypatch):
    """camoufox 模式不碰 profile 池。"""
    touched = []
    monkeypatch.setattr(
        "application.bitbrowser_profiles.acquire_profile_for_browser_mode",
        lambda *a, **k: touched.append("acquire") or ("", ""), raising=False,
    )
    monkeypatch.setattr(orch, "execute_gopay_pay_chatgpt", lambda **k: {
        "chatgpt_account_id": k["chatgpt_account_id"], "gopay_account_id": 1,
        "midtrans_url": "x", "payment": {"success": True},
    })
    cid = _seed_chatgpt_account(email="cf@x.com")
    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [cid],
        "checkout_mode": "camoufox_headed",
    })
    execute_task(task["task_id"])
    final = get_task(task["task_id"])
    assert final["status"] == TASK_STATUS_SUCCEEDED
    assert touched == []


def test_register_for_gopay_defaults_to_headless(monkeypatch):
    """需求 2：未选账号注册 ChatGPT 默认走浏览器后台模式（headless）。"""
    import application.tasks as tasks_mod

    captured = {}

    class FakePlatform:
        def register(self, *a, **k):
            from core.base_platform import Account, AccountStatus
            return Account(platform="chatgpt", email="reg@x.com", password="pw",
                           user_id="u", status=AccountStatus.REGISTERED)

    def fake_build(platform_name, payload, logger, resolved_proxy=None, shared_mailbox=None):
        captured["executor_type"] = payload.get("executor_type")
        return FakePlatform()

    monkeypatch.setattr(tasks_mod, "_build_platform_instance", fake_build)
    monkeypatch.setattr(tasks_mod, "_resolve_registration_proxy_for_platform", lambda *a, **k: None)
    # 用真实 save_account 入库（新实现靠 email 重新查拿 id）

    class _L:
        def log(self, *a, **k): pass
        def is_cancel_requested(self): return False
        def set_subtask(self, *a, **k): pass
        def clear_subtask(self): pass

    ids = tasks_mod._register_chatgpt_accounts_for_gopay(1, {}, _L())
    assert len(ids) == 1
    assert captured["executor_type"] == "headless"



def test_register_for_gopay_uses_real_save_account(monkeypatch):
    """回归：用真实 save_account（不 mock），确认拿 id 不抛 DetachedInstanceError。

    之前 register_gopay_account 踩过同样的坑——save_account 返回的 model 出
    session 后访问 .id 触发 DetachedInstanceError。_register_chatgpt_accounts_for_gopay
    必须用稳定方式拿 id。"""
    import application.tasks as tasks_mod
    from core.base_platform import Account, AccountStatus

    class FakePlatform:
        def register(self, *a, **k):
            return Account(
                platform="chatgpt", email="realsave@x.com", password="pw",
                user_id="u", status=AccountStatus.REGISTERED,
            )

    monkeypatch.setattr(
        tasks_mod, "_build_platform_instance",
        lambda *a, **k: FakePlatform(),
    )
    monkeypatch.setattr(tasks_mod, "_resolve_registration_proxy_for_platform", lambda *a, **k: None)

    class _L:
        def log(self, *a, **k): pass
        def is_cancel_requested(self): return False
        def set_subtask(self, *a, **k): pass
        def clear_subtask(self): pass

    ids = tasks_mod._register_chatgpt_accounts_for_gopay(1, {}, _L())
    assert len(ids) == 1
    assert ids[0] > 0
    # 确认账号真的入库了
    from sqlmodel import Session, select
    from core.db import AccountModel, engine
    with Session(engine) as session:
        m = session.exec(
            select(AccountModel).where(AccountModel.email == "realsave@x.com")
        ).first()
        assert m is not None
        assert int(m.id) == ids[0]



# -- 需求 2: 填了 midtrans_url 跳过 ChatGPT 注册直接付款 --

def test_task_with_midtrans_url_skips_chatgpt_register(monkeypatch):
    """payload 有 midtrans_url_override、无账号、register_count=0 →
    不触发 ChatGPT 注册，直接用该 url 付款成功。"""
    import application.tasks as tasks_mod

    register_called = {"n": 0}
    monkeypatch.setattr(
        tasks_mod, "_register_chatgpt_accounts_for_gopay",
        lambda *a, **k: register_called.__setitem__("n", register_called["n"] + 1) or [],
        raising=False,
    )

    _seed_gopay_account(balance_rp=20000)

    exec_args = {}

    def fake_exec(**kwargs):
        exec_args.update(kwargs)
        return {
            "chatgpt_account_id": kwargs["chatgpt_account_id"],
            "gopay_account_id": 1, "midtrans_url": kwargs.get("midtrans_url_override"),
            "payment": {"success": True},
        }

    monkeypatch.setattr(orch, "execute_gopay_pay_chatgpt", fake_exec)

    task = create_gopay_pay_chatgpt_task({
        "chatgpt_account_ids": [],
        "register_count": 0,
        "midtrans_url_override": "https://app.midtrans.com/snap/v4/redirection/skip1234-1111-2222-3333-444455556666",
    })
    execute_task(task["task_id"])

    final = get_task(task["task_id"])
    assert final["status"] == TASK_STATUS_SUCCEEDED
    # 注册没被调用
    assert register_called["n"] == 0
    # execute 用占位 chatgpt_account_id=0 + midtrans_url
    assert exec_args["chatgpt_account_id"] == 0
    assert exec_args["midtrans_url_override"].startswith("https://app.midtrans.com/")


def test_execute_with_zero_chatgpt_id_and_midtrans_pays_directly(monkeypatch):
    """execute 接受 chatgpt_account_id=0 + midtrans_url_override，直接付款，
    不触碰 ChatGPT 账号表。"""
    _seed_gopay_account(balance_rp=20000)

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
        chatgpt_account_id=0,
        midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/direct12-1111-2222-3333-444455556666",
        herosms_api_key_override="K",
        log=lambda _: None,
    )
    assert out["payment"]["success"] is True
    assert out["chatgpt_account_id"] == 0


def test_execute_zero_chatgpt_id_without_midtrans_raises():
    """chatgpt_account_id=0 但没给 midtrans_url → raise。"""
    import pytest
    with pytest.raises(RuntimeError, match="必须提供 midtrans_url_override"):
        orch.execute_gopay_pay_chatgpt(
            chatgpt_account_id=0,
            herosms_api_key_override="K",
            log=lambda _: None,
        )
