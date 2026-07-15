"""Tests for application/gopay_pay_chatgpt.py orchestrator (3-step pipeline)."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlmodel import Session

from application import gopay_pay_chatgpt as orch
from core.db import AccountModel, AccountOverviewModel, engine


# -- helpers ------------------------------------------------------------------

def _seed_chatgpt_account(*, email: str = "ct@example.com", access_token: str = "at_x") -> int:
    with Session(engine) as session:
        m = AccountModel(platform="chatgpt", email=email, password="pw", user_id="user_x")
        session.add(m)
        session.commit()
        session.refresh(m)
        # 给一个 overview，避免 build_platform_account 报错
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({"plan_state": "free"})
        session.add(ov)
        session.commit()
        # Set primary token credential
        from core.account_graph import patch_account_graph
        patch_account_graph(session, m, primary_token=access_token)
        session.commit()
        return int(m.id)


def _seed_gopay_account(
    *,
    email: str = "+6281234567890",
    pin: str = "147258",
    aid: str = "AID_TEST",
    phone_local: str = "81234567890",
    balance_rp: int = 10000,
) -> int:
    with Session(engine) as session:
        m = AccountModel(platform="gopay", email=email, password=pin, user_id=email)
        session.add(m)
        session.commit()
        session.refresh(m)
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({
            "balance_rp": balance_rp,
            "phone": email,
            "phone_local": phone_local,
            "pin": pin,
            "herosms_activation_id": aid,
            "register_proxy": "",
        })
        session.add(ov)
        session.commit()
        return int(m.id)


# -- step ① generate_cashier_url ---------------------------------------------

def test_step_generate_cashier_url_calls_chatgpt_payment(monkeypatch):
    """Step ① 必须调 chatgpt.payment.generate_plus_link，country/currency 透传。

    覆盖关键行为：把 build_platform_account 返回的 Account 适配成有
    ``access_token`` / ``cookies`` 字段的对象（generate_plus_link 期望的接口）。
    """
    captured: dict[str, Any] = {}

    def fake_generate_plus_link(account, **kwargs):
        captured["access_token"] = getattr(account, "access_token", "")
        captured["country"] = kwargs.get("country")
        captured["currency"] = kwargs.get("currency")
        captured["proxy"] = kwargs.get("proxy")
        return "https://checkout.stripe.com/c/pay/cs_test_xxx"

    from platforms.chatgpt import payment as chatgpt_payment
    monkeypatch.setattr(chatgpt_payment, "generate_plus_link", fake_generate_plus_link)

    aid = _seed_chatgpt_account(email="alice@x.com", access_token="at_alice")
    chatgpt = orch.find_chatgpt_account(aid)

    # 即便传入 proxy，也必须强制 None（生成支付链接不走代理）
    url = orch.step_generate_cashier_url(
        chatgpt, country="ID", currency="IDR", proxy="http://1.2.3.4:8080", log=lambda _: None,
    )

    assert url == "https://checkout.stripe.com/c/pay/cs_test_xxx"
    assert captured["access_token"] == "at_alice"
    assert captured["country"] == "ID"
    assert captured["currency"] == "IDR"
    assert captured["proxy"] is None


def test_step_generate_cashier_url_raises_on_empty_response(monkeypatch):
    from platforms.chatgpt import payment as chatgpt_payment
    monkeypatch.setattr(chatgpt_payment, "generate_plus_link", lambda *a, **k: "")

    aid = _seed_chatgpt_account(access_token="at_x")
    chatgpt = orch.find_chatgpt_account(aid)
    with pytest.raises(RuntimeError, match="未返回 cashier URL"):
        orch.step_generate_cashier_url(chatgpt, log=lambda _: None)


def test_step_generate_cashier_url_raises_when_account_missing_access_token(monkeypatch):
    """ChatGPT 账号没有 access_token 时立即 raise，不去发 HTTP 请求。"""
    from platforms.chatgpt import payment as chatgpt_payment

    called = {"n": 0}

    def fake_post(*a, **k):
        called["n"] += 1
        return None

    monkeypatch.setattr(chatgpt_payment.cffi_requests, "post", fake_post)

    # 故意不调 patch_account_graph 给 primary_token 写值
    from sqlmodel import Session
    from core.db import AccountModel, AccountOverviewModel, engine

    with Session(engine) as session:
        m = AccountModel(platform="chatgpt", email="bare@x.com", password="pw", user_id="u")
        session.add(m); session.commit(); session.refresh(m)
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({})
        session.add(ov); session.commit()
        bare_id = int(m.id)

    chatgpt = orch.find_chatgpt_account(bare_id)
    with pytest.raises(RuntimeError, match="缺少 access_token"):
        orch.step_generate_cashier_url(chatgpt, log=lambda _: None)
    assert called["n"] == 0, "缺 token 时不应发 HTTP 请求"


# -- step ③ pay_with_gopay ---------------------------------------------------

def test_step_pay_with_gopay_passes_phone_pin_aid(monkeypatch):
    """Step ③ 必须用 GoPay 账号 extra 里的 phone_local/pin/aid 调 GoPayPayment.pay。"""
    captured: dict[str, Any] = {}

    class FakePayment:
        def __init__(self, proxy: str = ""):
            captured["proxy"] = proxy

        def pay(self, *, midtrans_url, phone, country_code, pin, wait_otp, **_kwargs):
            captured["midtrans_url"] = midtrans_url
            captured["phone"] = phone
            captured["country_code"] = country_code
            captured["pin"] = pin
            captured["wait_otp_callable"] = callable(wait_otp)
            return {"success": True, "detail": "OK", "transaction_status": "settlement"}

    # patch 进 opai 命名空间。该模块需要先确保 sys.path 加载好
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_payment_protocol as _gpp
    from opai.core import sms_helpers as _sh

    monkeypatch.setattr(_gpp, "GoPayPayment", FakePayment)
    monkeypatch.setattr(_sh, "sms_request_another", lambda *a, **k: True)
    monkeypatch.setattr(_sh, "sms_wait_code", lambda *a, **k: "999999")
    monkeypatch.setattr(_sh, "sms_api", lambda *a, **k: "")

    gid = _seed_gopay_account()
    with Session(engine) as session:
        gopay = session.get(AccountModel, gid)

    result = orch.step_pay_with_gopay(
        "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc",
        gopay,
        herosms_api_key_override="HEROSMS_KEY_FROM_TASK",
        log=lambda _: None,
    )

    assert result["success"] is True
    assert captured["midtrans_url"].startswith("https://app.midtrans.com/")
    assert captured["phone"] == "81234567890"
    assert captured["country_code"] == "62"
    assert captured["pin"] == "147258"
    assert captured["wait_otp_callable"] is True


def test_step_pay_with_gopay_uses_env_var_when_override_not_supplied(monkeypatch):
    """没传 override 时回退到 OPAI_HEROSMS_API_KEY 环境变量。"""

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
    monkeypatch.setenv("OPAI_HEROSMS_API_KEY", "HEROSMS_KEY_FROM_ENV")

    gid = _seed_gopay_account()
    with Session(engine) as session:
        gopay = session.get(AccountModel, gid)
    result = orch.step_pay_with_gopay(
        "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc",
        gopay,
        log=lambda _: None,
    )
    assert result["success"] is True


def test_step_pay_with_gopay_raises_when_no_api_key_anywhere(monkeypatch):
    """既没传 override 也没设环境变量时立即 raise。"""

    class FakePayment:
        def __init__(self, proxy: str = ""):
            pass
        def pay(self, **_):
            return {"success": True}

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_payment_protocol as _gpp
    monkeypatch.setattr(_gpp, "GoPayPayment", FakePayment)
    monkeypatch.delenv("OPAI_HEROSMS_API_KEY", raising=False)

    gid = _seed_gopay_account()
    with Session(engine) as session:
        gopay = session.get(AccountModel, gid)

    with pytest.raises(RuntimeError, match="缺少 Hero-SMS API key"):
        orch.step_pay_with_gopay(
            "https://app.midtrans.com/snap/v4/redirection/abc-uuid",
            gopay,
            log=lambda _: None,
        )


def test_step_pay_with_gopay_raises_when_extra_missing(monkeypatch):
    """缺 phone_local / pin / aid 时直接 raise，不去调协议层（避免烧 Hero-SMS）。"""
    with Session(engine) as session:
        m = AccountModel(platform="gopay", email="+6280000", password="", user_id="+6280000")
        session.add(m)
        session.commit()
        session.refresh(m)
        ov = AccountOverviewModel(account_id=m.id)
        ov.set_summary({})  # 故意空
        session.add(ov)
        session.commit()
        gid = int(m.id)
        gopay = session.get(AccountModel, gid)

    with pytest.raises(RuntimeError, match="phone_local / pin / herosms_activation_id"):
        orch.step_pay_with_gopay(
            "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc",
            gopay,
            herosms_api_key_override="K",
            log=lambda _: None,
        )


def test_step_pay_with_gopay_raises_on_pay_failure(monkeypatch):
    """pay() 返回 success=False 时必须 raise，让上层 task 标 failed。"""

    class FakePayment:
        def __init__(self, proxy: str = ""):
            pass

        def pay(self, **_kwargs):
            return {"success": False, "detail": "linking 429 rate limited"}

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_payment_protocol as _gpp
    from opai.core import sms_helpers as _sh

    monkeypatch.setattr(_gpp, "GoPayPayment", FakePayment)
    monkeypatch.setattr(_sh, "sms_request_another", lambda *a, **k: True)
    monkeypatch.setattr(_sh, "sms_wait_code", lambda *a, **k: None)
    monkeypatch.setattr(_sh, "sms_api", lambda *a, **k: "")

    gid = _seed_gopay_account()
    with Session(engine) as session:
        gopay = session.get(AccountModel, gid)

    with pytest.raises(RuntimeError, match="GoPay 付款失败"):
        orch.step_pay_with_gopay(
            "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc",
            gopay,
            herosms_api_key_override="K",
            log=lambda _: None,
        )


# -- pick_available_gopay_account --------------------------------------------

def test_pick_available_gopay_account_filters_by_balance():
    """余额 < 1 IDR 的号必须被过滤掉。"""
    _seed_gopay_account(email="+6281111", aid="AID1", phone_local="81111", balance_rp=0)
    _seed_gopay_account(email="+6282222", aid="AID2", phone_local="82222", balance_rp=15000)

    picked = orch.pick_available_gopay_account(min_balance_rp=1)
    assert picked is not None
    assert picked.email == "+6282222"


def test_pick_available_gopay_account_returns_none_when_no_balance():
    _seed_gopay_account(email="+6281111", balance_rp=0)
    assert orch.pick_available_gopay_account(min_balance_rp=1) is None


# -- execute_gopay_pay_chatgpt (orchestrator full flow) ----------------------

def test_execute_gopay_pay_chatgpt_full_pipeline_with_midtrans_override(monkeypatch):
    """提供 midtrans_url_override 时跳过步骤 ① 和 ②，直接到协议付款。
    完整链路：编排器读 ChatGPT、自动挑 GoPay、调付款、最后把 ChatGPT 标 subscribed。
    """
    cid = _seed_chatgpt_account(email="ct1@x.com")
    gid = _seed_gopay_account(email="+62811", balance_rp=20000)

    # 拦截协议付款
    class FakePayment:
        def __init__(self, proxy: str = ""):
            pass
        def pay(self, **_kwargs):
            return {"success": True, "detail": "OK", "transaction_status": "settlement"}

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
        midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/abcd1234-1111-2222-3333-444455556666",
        herosms_api_key_override="K_FOR_TEST",
        log=lambda _: None,
    )

    assert out["chatgpt_account_id"] == cid
    assert out["gopay_account_id"] == gid
    assert out["midtrans_url"].startswith("https://app.midtrans.com/")
    assert out["payment"]["success"] is True

    # ChatGPT 账号应被标 subscribed
    from core.account_graph import load_account_graphs

    with Session(engine) as session:
        graph = load_account_graphs(session, [cid]).get(cid, {})
    assert graph.get("lifecycle_status") == "subscribed"
    overview = graph.get("overview") or {}
    assert overview.get("paid_via") == "gopay"
    assert overview.get("paid_via_gopay_account_id") == gid


def test_execute_gopay_pay_chatgpt_raises_when_chatgpt_account_missing():
    """不存在的 chatgpt id 必须立即 raise。"""
    with pytest.raises(RuntimeError, match="不存在或不是 chatgpt 平台"):
        orch.execute_gopay_pay_chatgpt(
            chatgpt_account_id=99999,
            midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/abc-123",
            log=lambda _: None,
        )


def test_execute_gopay_pay_chatgpt_raises_when_no_gopay_at_all(monkeypatch):
    """完全没有 GoPay 号 + 未开自动注册 → raise（无法自动注册）。"""
    cid = _seed_chatgpt_account()
    # 不 seed 任何 gopay 号

    with pytest.raises(RuntimeError, match="无法自动注册"):
        orch.execute_gopay_pay_chatgpt(
            chatgpt_account_id=cid,
            midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/abc-123",
            auto_register_gopay=False,
            log=lambda _: None,
        )


def test_midtrans_url_regex_matches_v3_and_v4():
    """编排器内部抓 URL 用的 regex 必须同时支持 v3 / v4 redirection。"""
    samples = [
        "https://app.midtrans.com/snap/v3/redirection/abc12345-1234-1234-1234-123456789abc",
        "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc",
        # 末尾带 query string
        "https://app.midtrans.com/snap/v4/redirection/abc12345-1234-1234-1234-123456789abc?lang=id",
    ]
    for s in samples:
        m = orch._MIDTRANS_URL_RE.search(s)
        assert m is not None, f"应匹配: {s}"
        # 抓到的 URL 不带 query string
        assert "?" not in m.group(0)


def test_midtrans_url_regex_rejects_non_midtrans_urls():
    rejects = [
        "https://checkout.stripe.com/c/pay/cs_test_xx",
        "https://app.midtrans.com/snap/v2/redirection/abc",          # 不支持 v2
        "https://other.midtrans.com/snap/v4/redirection/abc-123",    # 子域不对
        "",
        "garbage",
    ]
    for s in rejects:
        assert orch._MIDTRANS_URL_RE.search(s) is None, f"不应匹配: {s}"



# -- Task 8: 余额不足时领红包补余额 --

def test_execute_claims_envelope_when_no_balance(monkeypatch):
    """没有余额够的号 + 传 envelope_url → 领红包补余额后挑到号付款成功。"""
    cid = _seed_chatgpt_account(email="env@x.com", access_token="at_env")
    # 唯一的 gopay 号余额=0
    gid = _seed_gopay_account(email="+62envelope", balance_rp=0)

    # mock 红包领取 + resume + check_balance（领后变 20000）
    monkeypatch.setattr(orch, "claim_envelope_for_account", lambda *a, **k: True)

    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_resume_account", lambda phone, proxy="": {"client": object(), "phone": phone})
    monkeypatch.setattr(_w, "_check_balance", lambda client: 20000)

    # mock 协议付款
    class FakePayment:
        def __init__(self, proxy: str = ""):
            pass
        def pay(self, **_):
            return {"success": True, "detail": "OK"}

    from opai.core import gopay_payment_protocol as _gpp
    from opai.core import sms_helpers as _sh
    monkeypatch.setattr(_gpp, "GoPayPayment", FakePayment)
    monkeypatch.setattr(_sh, "sms_request_another", lambda *a, **k: True)
    monkeypatch.setattr(_sh, "sms_wait_code", lambda *a, **k: "999999")
    monkeypatch.setattr(_sh, "sms_api", lambda *a, **k: "")

    out = orch.execute_gopay_pay_chatgpt(
        chatgpt_account_id=cid,
        midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/aaaa1111-2222-3333-4444-555566667777",
        envelope_url="https://app.gopay.co.id/NF8p/qps2s1y0",
        herosms_api_key_override="K",
        log=lambda _: None,
    )
    assert out["payment"]["success"] is True
    assert out["gopay_account_id"] == gid


def test_execute_polls_balance_until_ttl_when_no_balance_no_envelope(monkeypatch):
    """需求 1：余额 0 + 没红包 → 不直接失败，轮询等到 TTL 超时才失败。"""
    cid = _seed_chatgpt_account(email="nb@x.com", access_token="at_nb")
    _seed_gopay_account(email="+62nobalance", balance_rp=0)

    # resume 拿到 client，但余额一直 0
    from platforms.gopay._opai_loader import ensure_opai_on_path
    ensure_opai_on_path()
    from opai.core import gopay_protocol_worker as _w
    monkeypatch.setattr(_w, "_resume_account", lambda phone, proxy="": {"client": object(), "phone": phone})
    monkeypatch.setattr(_w, "_check_balance", lambda client: 0)

    import application.gopay_pay_chatgpt as mod
    monkeypatch.setattr(mod.time, "sleep", lambda s: None)
    # 单调时钟每次调用 +600s：PhoneTTLGuard.start 取第一次（小），
    # 后续 check 取递增值，第 2~3 次 check 即超过 1200s TTL。
    ticker = {"v": 0.0}

    def fake_monotonic():
        v = ticker["v"]
        ticker["v"] += 600.0
        return v

    monkeypatch.setattr(mod.time, "monotonic", fake_monotonic)

    with pytest.raises(RuntimeError, match="号码有效期"):
        orch.execute_gopay_pay_chatgpt(
            chatgpt_account_id=cid,
            midtrans_url_override="https://app.midtrans.com/snap/v4/redirection/bbbb-uuid-1234",
            herosms_api_key_override="K",
            phone_ttl_seconds=1200,
            log=lambda _: None,
        )
