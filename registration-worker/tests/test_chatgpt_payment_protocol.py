"""协议模式 checkout pipeline 骨架的单元测试。

目标：
- pipeline 顺序按 stages 列表执行；遇到失败 stage 后立刻短路并返回 stage 名。
- 每个 stage 失败时携带 `fallback_recommended` 提示，便于上层回落到 camoufox。
- `build_protocol_session` 能注入 chatgpt.com 域 cookie。
- 默认 pipeline 4 段在没有任何实现的情况下，stage A 就 fallback。
- `complete_paypal_checkout_protocol` 委托到 `payment_protocol.run_protocol_checkout`。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import List

import pytest

from platforms.chatgpt import payment as payment_module
from platforms.chatgpt import payment_protocol
from platforms.chatgpt import stripe_http


def _collect_logs() -> tuple[List[str], callable]:
    logs: List[str] = []

    def _log(message: str) -> None:
        logs.append(str(message))

    return logs, _log


def test_default_pipeline_without_address_short_circuits_stripe_checkout():
    """没有提供 address 时，stripe_checkout 立刻短路并建议 fallback。"""
    logs, log = _collect_logs()
    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        cookies_str="__Secure-next-auth.session-token=sess_abc",
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=180,
        log_fn=log,
        cancel_check=None,
        turnstile_solver=None,
    )

    assert result["ok"] is False
    assert result["status"] == "stage_failed"
    assert result["stage"] == "stripe_checkout"
    assert result["fallback_recommended"] is True
    assert "账单地址" in result["error"]
    assert result["final_url"] == "https://checkout.stripe.com/c/pay/cs_test_plus"
    assert result["stage_history"][0]["stage"] == "stripe_checkout"


def test_pipeline_short_circuits_on_first_failure():
    calls: list[str] = []

    def stage_a(state):
        calls.append("A")
        return payment_protocol.StageResult(
            ok=True, stage="A", next_url="https://example.test/b"
        )

    def stage_b(state):
        calls.append("B")
        return payment_protocol.StageResult(
            ok=False, stage="B", error="boom", fallback_recommended=True
        )

    def stage_c(state):
        calls.append("C")
        return payment_protocol.StageResult(ok=True, stage="C")

    logs, log = _collect_logs()
    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str=None,
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=120,
        log_fn=log,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_a, stage_b, stage_c],
    )

    assert calls == ["A", "B"]
    assert result["ok"] is False
    assert result["stage"] == "B"
    assert result["fallback_recommended"] is True
    assert result["final_url"] == "https://example.test/b"
    assert [item["stage"] for item in result["stage_history"]] == ["A", "B"]


def test_pipeline_completes_when_all_stages_succeed():
    def stage_a(state):
        return payment_protocol.StageResult(ok=True, stage="A", next_url="https://example.test/b")

    def stage_b(state):
        return payment_protocol.StageResult(ok=True, stage="B", next_url="https://chatgpt.com/")

    logs, log = _collect_logs()
    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str="",
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=60,
        log_fn=log,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_a, stage_b],
    )

    assert result["ok"] is True
    assert result["status"] == "completed"
    assert result["final_url"] == "https://chatgpt.com/"
    assert result["error"] == ""


def test_run_protocol_checkout_auto_generates_cmid_on_entry():
    """协议模式入口必须自动生成 32 字节 hex 的 paypal-client-metadata-id，
    防止下游 fallback 到 ec_token——后者是 PayPal 风控判定 "脚本伪装" 的字面
    模式，会立刻让 OTP 后的 SignUp 拿 OAS_ERROR (createMemberAccount 风控)。

    单元测试通过 pipeline 注入 stage 来"窥探" run_protocol_checkout 内部
    构造好的 ProtoState，确保 cmid 字段在 stage 拿到 state 时已经被填好。
    """
    captured: dict = {}

    def stage_capture(state):
        captured["paypal_cmid"] = state.paypal_cmid
        return payment_protocol.StageResult(ok=True, stage="capture")

    payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str=None,
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=60,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_capture],
    )

    cmid = captured["paypal_cmid"]
    # generate_paypal_cmid 用 secrets.token_hex(16) → 32 字符 hex
    assert isinstance(cmid, str)
    assert len(cmid) == 32
    assert all(c in "0123456789abcdef" for c in cmid), f"cmid 不是 hex: {cmid!r}"


def test_run_protocol_checkout_does_not_overwrite_explicit_cmid(monkeypatch):
    """如果将来上层主动塞了 paypal_cmid（比如重放固定 fingerprint 抓包用例），
    入口处不应覆盖它。我们保留 "为空才生成" 的语义。

    用 monkeypatch 临时把 ProtoState 的默认 cmid 替换成一个固定值，
    模拟"上层显式注入"。
    """
    fixed_cmid = "deadbeef" * 4  # 32 字符 hex

    captured: dict = {}

    def stage_capture(state):
        captured["paypal_cmid"] = state.paypal_cmid
        return payment_protocol.StageResult(ok=True, stage="capture")

    # 用 ProtoState 默认值机制：把 dataclass field default 改成固定值
    original_init = payment_protocol.ProtoState.__init__

    def patched_init(self, *args, **kwargs):
        kwargs.setdefault("paypal_cmid", fixed_cmid)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(payment_protocol.ProtoState, "__init__", patched_init)

    payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str=None,
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=60,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_capture],
    )

    assert captured["paypal_cmid"] == fixed_cmid


def test_pipeline_rejects_non_paypal_payment_method():
    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str="",
        proxy=None,
        email="user@example.com",
        payment_method="alipay",
        timeout=60,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
    )

    assert result["ok"] is False
    assert result["fallback_recommended"] is False
    assert "alipay" in result["error"].lower()


def test_pipeline_catches_unhandled_exception_and_recommends_fallback():
    def stage_a(state):
        raise ValueError("unexpected")

    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str="",
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=60,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_a],
    )

    assert result["ok"] is False
    assert result["status"] == "stage_exception"
    assert result["fallback_recommended"] is True
    assert "unexpected" in result["error"]


def test_is_curl_tls_transient_error_recognizes_known_keywords():
    """``_is_curl_tls_transient_error`` 必须能识别实战日志里出现的所有 curl_cffi
    瞬态网络/握手错文案，避免漏放重试。

    覆盖两类：
      - **TLS 层**：BoringSSL 全局状态污染（curl 35 / invalid library / OPENSSL_internal）
      - **代理隧道层**：kookeey 旋转网关瞬时抽风（curl 56/7/28/52 / Proxy CONNECT aborted）
    """
    samples = [
        # === TLS 层（BoringSSL 全局状态污染） ===
        "/init 失败: Failed to perform, curl: (35) TLS connect error",
        "OPENSSL_internal:invalid library (0)",
        "curl: (35) TLS connect error: error:00000000:invalid library (0):"
        "OPENSSL_internal:invalid library (0). See https://curl.se/...",
        "/agreements/approve 请求失败: invalid library (0)",
        # === 代理隧道层（kookeey 旋转网关瞬时抽风） ===
        # Synthetic regression: stripe_checkout fails on its first request.
        "/init 失败: Failed to perform, curl: (56) Proxy CONNECT aborted. "
        "See https://curl.se/libcurl/c/libcurl-errors.html first for more details.",
        "Failed to perform, curl: (7) Couldn't connect to proxy",
        "/v1/payment_pages/cs/init: curl: (28) Operation timed out after 30000ms",
        "POST /api/checkout: curl: (52) Empty reply from server",
        # 显式文案兜底（万一 curl 错误码格式变化也能命中）
        "Proxy CONNECT aborted while opening tunnel to gate-us.kookeey.info:1000",
    ]
    for msg in samples:
        assert payment_protocol._is_curl_tls_transient_error(msg), (
            f"应识别为瞬态网络/握手错: {msg!r}"
        )


def test_is_curl_tls_transient_error_skips_business_errors():
    """``_is_curl_tls_transient_error`` 必须**不**把业务级失败（号被风控 /
    captcha 拒绝 / 余额不足等）误判为 TLS 错，避免无意义重试浪费 SMS 配额。"""
    samples = [
        "OAS_ERROR (createMemberAccount 风控)",
        "PHONE_CONFIRMATION_NOT_INITIATED",
        "checkout_amount_mismatch",
        "captcha solve failed",
        "",
        "Stripe POST /v1/payment_pages/cs/init → status=400",  # 普通 4xx 不该重试
    ]
    for msg in samples:
        assert not payment_protocol._is_curl_tls_transient_error(msg), (
            f"不应识别为瞬态 TLS 错: {msg!r}"
        )


def test_pipeline_retries_stage_once_on_curl_tls_transient_error():
    """stage 第一次返回 curl_cffi 瞬态 TLS 错（``invalid library``）时，
    主循环必须 rotate session 后重跑该 stage 一次。重跑成功则 pipeline 继续。
    """
    call_count = {"n": 0}

    def stage_flaky(state):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return payment_protocol.StageResult(
                ok=False,
                stage="flaky",
                error=(
                    "/init 失败: Failed to perform, curl: (35) TLS connect "
                    "error: error:00000000:invalid library (0):"
                    "OPENSSL_internal:invalid library (0)"
                ),
                fallback_recommended=True,
            )
        return payment_protocol.StageResult(ok=True, stage="flaky")

    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str="",
        proxy=None,  # 没有代理，rotate 实际跳过，但 retry 语义不变
        email="user@example.com",
        payment_method="paypal",
        timeout=60,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_flaky],
    )

    assert call_count["n"] == 2, "stage 必须被调用两次（首次失败 + retry 一次）"
    assert result["ok"] is True
    assert result["status"] == "completed"


def test_pipeline_does_not_retry_stage_on_business_error():
    """stage 返回**业务级失败**（如 OAS_ERROR）时，主循环必须**不**重跑——
    重跑会浪费 SMS 配额且改变不了风控判定。
    """
    call_count = {"n": 0}

    def stage_business_fail(state):
        call_count["n"] += 1
        return payment_protocol.StageResult(
            ok=False,
            stage="business_fail",
            error="OAS_ERROR (createMemberAccount 风控)",
            fallback_recommended=True,
        )

    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str="",
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=60,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_business_fail],
    )

    assert call_count["n"] == 1, "业务级失败不应触发重试"
    assert result["ok"] is False
    assert result["status"] == "stage_failed"
    assert "OAS_ERROR" in result["error"]


def test_pipeline_retry_caps_at_one_for_persistent_tls_error():
    """如果 stage **每次**都返回 curl_cffi TLS 错（持续故障），主循环只 retry
    一次后按原结果返回，避免无限循环。"""
    call_count = {"n": 0}

    def stage_always_tls_fail(state):
        call_count["n"] += 1
        return payment_protocol.StageResult(
            ok=False,
            stage="always_tls",
            error="curl: (35) TLS connect error: invalid library (0)",
            fallback_recommended=True,
        )

    result = payment_protocol.run_protocol_checkout(
        checkout_url="https://example.test/start",
        cookies_str="",
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=60,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        pipeline=[stage_always_tls_fail],
    )

    assert call_count["n"] == 2, "持续 TLS 错时应只 retry 一次（合计 2 次调用）"
    assert result["ok"] is False
    assert "invalid library" in result["error"]


def test_pipeline_respects_cancel_check():
    def stage_a(state):
        raise AssertionError("stage A should not run if cancelled before pipeline starts")

    with pytest.raises(RuntimeError, match="任务已取消"):
        payment_protocol.run_protocol_checkout(
            checkout_url="https://example.test/start",
            cookies_str="",
            proxy=None,
            email="user@example.com",
            payment_method="paypal",
            timeout=60,
            log_fn=lambda m: None,
            cancel_check=lambda: True,
            turnstile_solver=None,
            pipeline=[stage_a],
        )


def test_build_protocol_session_injects_chatgpt_cookies():
    session = payment_protocol.build_protocol_session(
        proxy=None,
        cookies_str="__Secure-next-auth.session-token=sess_abc; oai-did=did_xyz",
    )
    try:
        names = {c.name for c in session.cookies.jar}
        assert "__Secure-next-auth.session-token" in names
        assert "oai-did" in names
        for cookie in session.cookies.jar:
            if cookie.name in ("__Secure-next-auth.session-token", "oai-did"):
                assert "chatgpt.com" in str(cookie.domain)
    finally:
        session.close()


def test_rotate_session_for_new_ip_preserves_cookies_across_rebuild():
    """``rotate_session_for_new_ip`` 必须把旧 session 的 cookies 全部搬到新 session
    上，并替换 ``state.session``。这是协议模式跨 stage 拿不同 kookeey IP 的关键。

    **必须传 proxy** 才会触发 rotate；proxy=None 时函数 no-op（保留 stub 行为，
    支持单测里大量用 stub session 的场景）。
    """
    # 1. 起一个 session 并塞几个跨域 cookie
    state = SimpleNamespace(
        session=payment_protocol.build_protocol_session(
            proxy=None, cookies_str="__Secure-next-auth.session-token=sess_abc"
        ),
        # 用一个无效但非空的 proxy URL 触发 rotate；build_protocol_session 不会
        # 真的连出去（curl_cffi 是 lazy connect），只是把 proxy URL 绑定到 session。
        proxy="http://localhost:1",
        log=lambda msg: None,  # 静默 log
    )
    # 模拟 stripe / paypal stages 在跑过后写入的跨域 cookies
    state.session.cookies.set("ts_c", "vr=abc123", domain="paypal.com")
    state.session.cookies.set("__stripe_sid", "stripe_x", domain="checkout.stripe.com")

    old_session = state.session
    cookie_names_before = {c.name for c in old_session.cookies.jar}
    assert "__Secure-next-auth.session-token" in cookie_names_before
    assert "ts_c" in cookie_names_before
    assert "__stripe_sid" in cookie_names_before

    # 2. rotate
    payment_protocol.rotate_session_for_new_ip(state, reason="unit test")

    # 3. session 对象已经替换
    assert state.session is not old_session

    # 4. 所有 cookie 都搬过来了（按 name+domain 比对）
    new_pairs = {
        (c.name, c.domain) for c in state.session.cookies.jar
        if c.name in ("__Secure-next-auth.session-token", "ts_c", "__stripe_sid")
    }
    domain_for = lambda n: next(iter(d for cn, d in new_pairs if cn == n), None)  # noqa: E731
    assert domain_for("__Secure-next-auth.session-token") and "chatgpt.com" in str(
        domain_for("__Secure-next-auth.session-token")
    )
    assert domain_for("ts_c") and "paypal.com" in str(domain_for("ts_c"))
    assert domain_for("__stripe_sid") and "stripe.com" in str(domain_for("__stripe_sid"))

    # cleanup
    try:
        state.session.close()
    except Exception:
        pass


def test_rotate_session_for_new_ip_logs_reason():
    """rotate 应当 log 出 reason 与保留 cookie 数，便于 debug 定位 IP 切换时机。"""
    logs: list[str] = []
    state = SimpleNamespace(
        session=payment_protocol.build_protocol_session(
            proxy=None, cookies_str="ck=v1"
        ),
        proxy="http://localhost:1",  # 必须给 proxy 才触发 rotate
        log=logs.append,
    )

    payment_protocol.rotate_session_for_new_ip(state, reason="进入 paypal_signup stage")
    assert any("session_rotate" in m and "paypal_signup" in m for m in logs)

    try:
        state.session.close()
    except Exception:
        pass


def test_rotate_session_for_new_ip_skips_when_no_proxy():
    """**关键契约**：proxy=None 时 rotate 必须 no-op，不替换 session、不 log。
    这是为了让大量使用 ``_StubSignupSession`` 的单测不被 rotate 破坏。"""
    sentinel = object()  # 假 session
    state = SimpleNamespace(
        session=sentinel,
        proxy=None,  # 关键：没代理
        log=lambda msg: pytest.fail(f"不应该 log: {msg}"),
    )

    payment_protocol.rotate_session_for_new_ip(state, reason="should be skipped")

    # session 没换，proxy=None 时函数立即 return
    assert state.session is sentinel


def test_main_protocol_stages_do_not_actively_rotate_session(monkeypatch):
    """**关键反爬契约**：主链路 stage（``proto_stage_paypal_approve`` /
    ``proto_stage_paypal_signup`` / OTP 子链入口）**禁止**主动调
    ``rotate_session_for_new_ip``。

    实战观察到主动 rotate 反而触发 PayPal 风控（同一 ec_token / sessionID
    跨 IP 移动 = bot 信号），整个协议模式必须坚持**单 IP 走到底**。

    此测试通过对源码做静态扫描来锁住这个契约——任何回归（新加 stage 时再
    手贱来一发 ``rotate_session_for_new_ip(state, reason="进入 xxx stage")``）
    都会立刻被 fail 出来。

    **白名单**：``_execute_stage_with_tls_retry`` 在 curl_cffi 瞬态 TLS 错时
    rotate 兜底是合法的（清理 BoringSSL 全局状态污染，跟反爬完全是两码事）。
    """
    import inspect
    from platforms.chatgpt import payment_protocol as pp

    src = inspect.getsource(pp)
    # 拆出每一个 ``rotate_session_for_new_ip(...)`` 调用所在的函数上下文。
    # 用 ``def `` 切分文件，每段就是一个函数体。
    forbidden_funcs = (
        "proto_stage_paypal_signup",
        "_run_paypal_otp_subchain",
    )
    sections = src.split("\ndef ")
    offenders: list[str] = []
    for section in sections[1:]:  # sections[0] 是 module-level，跳过
        head, _, _ = section.partition("(")
        func_name = head.strip()
        if func_name not in forbidden_funcs:
            continue
        if "rotate_session_for_new_ip(" in section:
            offenders.append(func_name)

    assert not offenders, (
        f"主链路函数禁止主动 rotate session（同一 ec_token 跨 IP = PayPal 风控强信号），"
        f"违规函数: {offenders}。如果确实需要 rotate（比如清理 BoringSSL 污染），"
        f"请放在 ``_execute_stage_with_tls_retry`` 里，并在此测试白名单里说明。"
    )


def test_tls_retry_helper_remains_only_legitimate_rotate_caller():
    """**反爬白名单契约**：协议模块里**唯一**合法的 ``rotate_session_for_new_ip``
    调用方应当只剩 ``_execute_stage_with_tls_retry``——它仅在 curl_cffi 抛
    ``invalid library`` 这类瞬态 TLS 错时 rotate（重建 session 顺带新 IP），
    用来清理 BoringSSL 全局状态污染，跟反爬主动换 IP 完全是两码事。

    任何新增 ``rotate_session_for_new_ip`` 调用都会让此测试 fail——强制写
    新代码的人来修测试 = 强制思考"我真的需要主动 rotate 吗"。
    """
    import inspect
    from platforms.chatgpt import payment_protocol as pp

    src = inspect.getsource(pp)
    sections = src.split("\ndef ")
    callers: list[str] = []
    for section in sections[1:]:
        head, _, _ = section.partition("(")
        func_name = head.strip()
        # 排除函数定义本体（``def rotate_session_for_new_ip``）
        if func_name == "rotate_session_for_new_ip":
            continue
        if "rotate_session_for_new_ip(" in section:
            callers.append(func_name)

    # 合法 caller：TLS 瞬态错 retry + PayPal DataDome 403 IP 轮换
    legitimate_callers = {"_execute_stage_with_tls_retry", "proto_stage_paypal_approve"}
    assert set(callers) == legitimate_callers, (
        f"协议模块只允许 {legitimate_callers} 调用 rotate_session_for_new_ip，"
        f"实际 callers={callers}"
    )


def test_complete_paypal_checkout_protocol_delegates_to_payment_protocol(monkeypatch):
    captured = {}

    def fake_run(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "status": "completed", "final_url": "https://chatgpt.com/", "error": ""}

    monkeypatch.setattr(payment_protocol, "run_protocol_checkout", fake_run)
    monkeypatch.setattr(payment_module, "fetch_us_billing_address", lambda email: {})

    result = payment_module.complete_paypal_checkout_protocol(
        checkout_url="https://checkout.stripe.com/c/pay/cs",
        cookies_str="a=1",
        proxy="http://p:8080",
        email="user@example.com",
        payment_method="paypal",
        timeout=120,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
    )

    assert result["ok"] is True
    assert captured["checkout_url"] == "https://checkout.stripe.com/c/pay/cs"
    assert captured["cookies_str"] == "a=1"
    assert captured["proxy"] == "http://p:8080"
    assert captured["email"] == "user@example.com"
    assert captured["payment_method"] == "paypal"
    assert captured["timeout"] == 120


# ----- stripe_http / proto_stage_stripe_checkout -------------------------------------


class _StubResponse:
    def __init__(self, payload: dict, *, status: int = 200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._payload


class _StubStripeSession:
    """记录请求顺序与 body，按预设响应队列返回。

    每次 ``post``/``get`` 都从 ``responses`` 取出下一个 ``_StubResponse``，便于断言调用次数。
    """

    def __init__(self, responses: list[_StubResponse]):
        self._responses = list(responses)
        self.calls: list[tuple[str, str, dict, dict]] = []

    def _take(self) -> _StubResponse:
        if not self._responses:
            raise AssertionError("StubSession 收到的请求超出了预设响应数量")
        return self._responses.pop(0)

    def post(self, url, data=None, headers=None):
        self.calls.append(("POST", url, dict(data or {}), dict(headers or {})))
        return self._take()

    def get(self, url, params=None, headers=None):
        self.calls.append(("GET", url, dict(params or {}), dict(headers or {})))
        return self._take()

    def close(self) -> None:  # pragma: no cover - 兼容 build_protocol_session 关闭路径
        pass


def test_extract_checkout_session_id_handles_live_and_test_ids():
    assert (
        stripe_http.extract_checkout_session_id(
            "https://pay.openai.com/c/pay/cs_live_TESTFIXTURE1234567890?ui_mode=hosted"
        )
        == "cs_live_TESTFIXTURE1234567890"
    )
    assert (
        stripe_http.extract_checkout_session_id("https://checkout.stripe.com/c/pay/cs_test_abc123")
        == "cs_test_abc123"
    )


def test_extract_checkout_session_id_rejects_invalid_url():
    with pytest.raises(ValueError):
        stripe_http.extract_checkout_session_id("https://example.com/no-cs-id")


def test_stripe_init_builds_form_body_and_headers():
    session = _StubStripeSession([_StubResponse({"id": "ppage_x", "init_checksum": "abc", "config_id": "cfg-1"})])
    resp = stripe_http.stripe_init(session, cs_id="cs_live_xyz")

    assert resp["init_checksum"] == "abc"
    method, url, body, headers = session.calls[0]
    assert method == "POST"
    assert url == f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_xyz/init"
    assert body == {
        "key": stripe_http.STRIPE_PUBLISHABLE_KEY,
        "eid": "NA",
        "browser_locale": "en-US",
        "browser_timezone": "America/Los_Angeles",
        "redirect_type": "url",
    }
    assert headers["Origin"] == "https://pay.openai.com"
    assert headers["Referer"] == "https://pay.openai.com/"
    assert headers["Content-Type"] == "application/x-www-form-urlencoded"
    assert headers["Accept"] == "application/json"


def test_stripe_create_paypal_payment_method_includes_billing_and_device_ids():
    session = _StubStripeSession([_StubResponse({"id": "pm_paypal_42", "type": "paypal"})])
    device = stripe_http.StripeDeviceContext(
        guid="g-fixed",
        muid="m-fixed",
        sid="s-fixed",
        client_session_id="csid-fixed",
    )
    resp = stripe_http.stripe_create_paypal_payment_method(
        session,
        cs_id="cs_live_abc",
        address={
            "country": "US",
            "line1": "2936 Murry Street",
            "city": "Virginia Beach",
            "postal_code": "23454",
            "state": "VA",
        },
        email="user@example.com",
        device=device,
        config_id="cfg-9",
    )

    assert resp["id"] == "pm_paypal_42"
    method, url, body, _ = session.calls[0]
    assert method == "POST"
    assert url == f"{stripe_http.STRIPE_API_BASE}/payment_methods"
    assert body["type"] == "paypal"
    assert body["billing_details[email]"] == "user@example.com"
    assert body["billing_details[address][line1]"] == "2936 Murry Street"
    assert body["billing_details[address][postal_code]"] == "23454"
    assert body["billing_details[address][state]"] == "VA"
    assert body["guid"] == "g-fixed"
    assert body["muid"] == "m-fixed"
    assert body["sid"] == "s-fixed"
    assert body["client_attribution_metadata[client_session_id]"] == "csid-fixed"
    assert body["client_attribution_metadata[checkout_session_id]"] == "cs_live_abc"
    assert body["client_attribution_metadata[checkout_config_id]"] == "cfg-9"
    assert body["_stripe_version"] == stripe_http.STRIPE_VERSION
    assert body["payment_user_agent"] == stripe_http.STRIPE_PAYMENT_USER_AGENT


def test_stripe_confirm_paypal_uses_init_checksum_and_returns_redirect_url():
    confirm_payload = {
        "setup_intent": {
            "next_action": {
                "type": "redirect_to_url",
                "redirect_to_url": {
                    "url": "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
                    "return_url": "https://pay.openai.com/c/pay/cs_live_abc?redirect_pm_type=paypal",
                },
            }
        },
        "state": "active",
    }
    session = _StubStripeSession([_StubResponse(confirm_payload)])
    device = stripe_http.StripeDeviceContext(guid="g", muid="m", sid="s", client_session_id="c")

    resp = stripe_http.stripe_confirm_paypal(
        session,
        cs_id="cs_live_abc",
        payment_method_id="pm_paypal_42",
        init_checksum="checksum-from-init",
        device=device,
    )

    redirect_url, return_url = stripe_http.extract_paypal_redirect_url(resp)
    assert redirect_url.startswith("https://pm-redirects.stripe.com/authorize/")
    assert return_url.startswith("https://pay.openai.com/c/pay/cs_live_abc")

    _, url, body, _ = session.calls[0]
    assert url == f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_abc/confirm"
    assert body["payment_method"] == "pm_paypal_42"
    assert body["init_checksum"] == "checksum-from-init"
    assert body["expected_payment_method_type"] == "paypal"
    assert body["consent[terms_of_service]"] == "accepted"
    assert body["return_url"].startswith("https://pay.openai.com/c/pay/cs_live_abc?redirect_pm_type=paypal")


def test_extract_paypal_redirect_url_raises_when_missing():
    with pytest.raises(ValueError):
        stripe_http.extract_paypal_redirect_url({"setup_intent": {}})


def test_proto_stage_stripe_checkout_full_success(monkeypatch):
    """端到端覆盖 stripe_checkout stage：direct confirm 调用顺序、入参与 detail 输出。"""
    init_resp = {"id": "ppage_1", "init_checksum": "init-cs-token", "config_id": "cfg-7"}
    allowed_origins_resp = {"ok": True}
    elements_resp = {
        "init_checksum": "elements-cs-token",
        "total_summary": {"due": 0, "total": 2000, "subtotal": 2000},
        "invoice": {"amount_due": 2000, "billing_cycle_anchor": "2026-07-09T00:00:00Z"},
    }
    tax_resp = {"id": "ppage_1", "ok": True}
    pre_confirm_resp = {"init_checksum": "preconfirm-cs-token"}
    confirm_resp = {
        "setup_intent": {
            "next_action": {
                "redirect_to_url": {
                    "url": "https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_Y?useWebAuthSession=true",
                    "return_url": "https://pay.openai.com/c/pay/cs_live_demo?redirect_pm_type=paypal&ui_mode=hosted",
                }
            }
        }
    }
    session = _StubStripeSession(
        [
            _StubResponse(init_resp),
            _StubResponse(allowed_origins_resp),
            _StubResponse(elements_resp),
            _StubResponse(tax_resp),
            _StubResponse(pre_confirm_resp),
            _StubResponse(confirm_resp),
        ]
    )

    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_demo?ui_mode=hosted",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={
            "country": "US",
            "line1": "2936 Murry Street",
            "city": "Virginia Beach",
            "postal_code": "23454",
            "state": "VA",
        },
        identity={},
        log=lambda message: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=120,
    )

    result = payment_protocol.proto_stage_stripe_checkout(state)

    assert result.ok is True
    assert result.stage == "stripe_checkout"
    assert result.next_url == confirm_resp["setup_intent"]["next_action"]["redirect_to_url"]["url"]
    assert result.detail["cs_id"] == "cs_live_demo"
    assert result.detail["init_checksum"] == "preconfirm-cs-token"
    assert result.detail["paypal_return_url"].startswith("https://pay.openai.com/c/pay/cs_live_demo")

    # HTTP 顺序为 init → allowed_origins → elements/sessions → tax → pre_confirm → direct confirm.
    urls = [call[1] for call in session.calls]
    assert urls == [
        f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_demo/init",
        f"{stripe_http.STRIPE_API_BASE}/payment_pages/allowed_origins",
        f"{stripe_http.STRIPE_API_BASE}/elements/sessions",
        f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_demo",
        f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_demo/pre_confirm",
        f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_demo/confirm",
    ]
    # /confirm 体里直接携带 PayPal payment_method_data，不再串联 pm_xxx
    elements_params = session.calls[2][2]
    assert elements_params["deferred_intent[payment_method_types][0]"] == "card"
    pre_confirm_body = session.calls[4][2]
    assert pre_confirm_body["payment_method_type"] == "paypal"
    confirm_body = session.calls[5][2]
    assert confirm_body["init_checksum"] == "preconfirm-cs-token"
    assert confirm_body["expected_payment_method_type"] == "paypal"
    assert confirm_body["payment_method_data[type]"] == "paypal"
    assert "payment_method" not in confirm_body
    assert confirm_body["payment_method_data[billing_details][email]"] == "user@example.com"
    assert confirm_body["payment_method_data[billing_details][address][country]"] == "US"


def test_proto_stage_stripe_checkout_retries_direct_confirm_without_fragment():
    init_resp = {
        "id": "ppage_1",
        "init_checksum": "init-cs-token",
        "config_id": "cfg-7",
        "url": "https://pay.openai.com/c/pay/cs_live_demo#fidabc",
    }
    tax_resp = {"id": "ppage_1", "url": "https://pay.openai.com/c/pay/cs_live_demo#fidabc"}
    missing_redirect_resp = {
        "id": "ppage_1",
        "object": "checkout.session",
        "account_settings": {},
        "consent_collection": {},
    }
    confirm_resp = {
        "setup_intent": {
            "next_action": {
                "redirect_to_url": {
                    "url": "https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_Y",
                    "return_url": "https://pay.openai.com/c/pay/cs_live_demo?redirect_pm_type=paypal",
                }
            }
        }
    }
    session = _StubStripeSession(
        [
            _StubResponse(init_resp),
            _StubResponse({"ok": True}),
            _StubResponse({}),
            _StubResponse(tax_resp),
            _StubResponse({}),
            _StubResponse(missing_redirect_resp),
            _StubResponse(confirm_resp),
        ]
    )
    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_demo#fidabc",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={"country": "JP", "line1": "Nara", "city": "Nara", "postal_code": "632-0068", "state": "Nara"},
        identity={},
        log=lambda message: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=120,
    )

    result = payment_protocol.proto_stage_stripe_checkout(state)

    assert result.ok is True
    assert result.next_url.startswith("https://pm-redirects.stripe.com/authorize/")
    assert len(session.calls) == 7
    assert "#" in session.calls[5][2]["return_url"]
    assert "#" not in session.calls[6][2]["return_url"]


def test_proto_stage_stripe_checkout_falls_back_to_payment_method_confirm():
    init_resp = {
        "id": "ppage_1",
        "init_checksum": "init-cs-token",
        "config_id": "cfg-7",
        "url": "https://pay.openai.com/c/pay/cs_live_demo",
    }
    tax_resp = {"id": "ppage_1", "url": "https://pay.openai.com/c/pay/cs_live_demo"}
    missing_redirect_resp = {
        "id": "ppage_1",
        "object": "checkout.session",
        "account_settings": {},
        "consent_collection": {},
    }
    payment_method_resp = {"id": "pm_paypal_123", "type": "paypal"}
    confirm_resp = {
        "payment_intent": {
            "next_action": {
                "redirect_to_url": {
                    "url": "https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_PM",
                    "return_url": "https://pay.openai.com/c/pay/cs_live_demo?redirect_pm_type=paypal",
                }
            }
        }
    }
    session = _StubStripeSession(
        [
            _StubResponse(init_resp),
            _StubResponse({"ok": True}),
            _StubResponse({}),
            _StubResponse(tax_resp),
            _StubResponse({}),
            _StubResponse(missing_redirect_resp),
            _StubResponse(missing_redirect_resp),
            _StubResponse(missing_redirect_resp),
            _StubResponse(payment_method_resp),
            _StubResponse(confirm_resp),
        ]
    )
    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_demo",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={"country": "JP", "line1": "Nara", "city": "Nara", "postal_code": "632-0068", "state": "Nara"},
        identity={},
        log=lambda message: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=120,
    )

    result = payment_protocol.proto_stage_stripe_checkout(state)

    assert result.ok is True
    assert result.next_url.endswith("sa_nonce_PM")
    assert session.calls[8][1] == f"{stripe_http.STRIPE_API_BASE}/payment_methods"
    assert session.calls[9][1] == f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_demo/confirm"
    assert session.calls[9][2]["payment_method"] == "pm_paypal_123"
    assert "payment_method_data[type]" not in session.calls[9][2]


def test_proto_stage_stripe_checkout_continues_elements_after_allowed_origins_403(monkeypatch):
    address = {"country": "JP", "line1": "Nara", "city": "Nara", "postal_code": "632-0068", "state": "Nara"}
    monkeypatch.setattr(stripe_http, "confirm_address_candidates", lambda _address, _checkout: [address])
    init_resp = {
        "id": "ppage_1",
        "init_checksum": "init-cs-token",
        "config_id": "cfg-7",
        "url": "https://pay.openai.com/c/pay/cs_live_demo",
    }
    elements_resp = {
        "init_checksum": "elements-cs-token",
        "invoice": {"amount_due": 2000, "currency": "usd"},
    }
    tax_resp = {
        "id": "ppage_1",
        "init_checksum": "tax-cs-token",
        "invoice": {"amount_due": 2200, "currency": "usd"},
    }
    pre_confirm_resp = {"init_checksum": "preconfirm-cs-token"}
    confirm_resp = {
        "setup_intent": {
            "next_action": {
                "redirect_to_url": {
                    "url": "https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_after_403",
                    "return_url": "https://pay.openai.com/c/pay/cs_live_demo?redirect_pm_type=paypal",
                }
            }
        }
    }
    session = _StubStripeSession(
        [
            _StubResponse(init_resp),
            _StubResponse({"error": {"message": "not authorized"}}, status=403),
            _StubResponse(elements_resp),
            _StubResponse(tax_resp),
            _StubResponse(pre_confirm_resp),
            _StubResponse(confirm_resp),
        ]
    )
    logs, log = _collect_logs()
    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_demo",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address=address,
        identity={},
        log=log,
        cancel_check=None,
        turnstile_solver=None,
        timeout=120,
    )

    result = payment_protocol.proto_stage_stripe_checkout(state)

    assert result.ok is True
    assert result.next_url.endswith("sa_nonce_after_403")
    assert f"{stripe_http.STRIPE_API_BASE}/elements/sessions" in [call[1] for call in session.calls]
    assert any("allowed_origins" in message for message in logs)


def test_proto_stage_stripe_checkout_fails_when_confirm_fallback_returns_no_redirect(monkeypatch):
    address = {"country": "JP", "line1": "Nara", "city": "Nara", "postal_code": "632-0068", "state": "Nara"}
    monkeypatch.setattr(stripe_http, "confirm_address_candidates", lambda _address, _checkout: [address])
    init_resp = {
        "id": "ppage_1",
        "init_checksum": "init-cs-token",
        "config_id": "cfg-7",
        "url": "https://pay.openai.com/c/pay/cs_live_demo",
    }
    missing_redirect_resp = {
        "id": "ppage_1",
        "object": "checkout.session",
        "account_settings": {},
        "consent_collection": {},
    }
    session = _StubStripeSession(
        [
            _StubResponse(init_resp),
            _StubResponse({"ok": True}),
            _StubResponse({}),
            _StubResponse({"id": "ppage_1"}),
            _StubResponse({}),
            _StubResponse(missing_redirect_resp),
            _StubResponse({"id": "pm_paypal_123", "type": "paypal"}),
            _StubResponse(missing_redirect_resp),
        ]
    )
    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_demo",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address=address,
        identity={},
        log=lambda message: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=120,
    )

    result = payment_protocol.proto_stage_stripe_checkout(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert not result.next_url
    assert result.error
    assert "payment_method fallback" in result.error or "PayPal" in result.error


def test_proto_stage_stripe_checkout_fails_when_init_response_missing_checksum():
    session = _StubStripeSession([_StubResponse({"id": "ppage_1"})])
    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_demo",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={
            "country": "US",
            "line1": "2936 Murry Street",
            "city": "Virginia Beach",
            "postal_code": "23454",
            "state": "VA",
        },
        identity={},
        log=lambda message: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=120,
    )

    result = payment_protocol.proto_stage_stripe_checkout(state)

    assert result.ok is False
    assert "init_checksum" in result.error
    assert result.fallback_recommended is True


def test_complete_paypal_checkout_protocol_passes_address(monkeypatch):
    captured = {}

    def fake_run(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "status": "completed", "final_url": "https://chatgpt.com/", "error": ""}

    monkeypatch.setattr(payment_protocol, "run_protocol_checkout", fake_run)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda email: {
            "country": "US",
            "line1": "100 Main",
            "city": "Springfield",
            "postal_code": "12345",
            "state": "IL",
        },
    )

    payment_module.complete_paypal_checkout_protocol(
        checkout_url="https://pay.openai.com/c/pay/cs_live_xyz",
        cookies_str="a=1",
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=120,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
    )

    assert captured["address"]["state"] == "IL"
    assert captured["address"]["postal_code"] == "12345"
    assert captured["email"] == "user@example.com"


def test_complete_paypal_checkout_protocol_runs_pipeline_without_any_env_gate(monkeypatch):
    """Phase 11：拆掉 CHATGPT_PROTOCOL_CHECKOUT_LIVE 闸门后，前端选「协议模式」即生效。

    即便环境变量被显式删掉，complete_paypal_checkout_protocol 也应直接调度
    run_protocol_checkout 而不再短路返回 ``protocol_gate_closed``。"""
    monkeypatch.delenv("CHATGPT_PROTOCOL_CHECKOUT_LIVE", raising=False)

    calls = {"run": 0, "fetch": 0}

    def fake_run(**kwargs):
        calls["run"] += 1
        return {"ok": True, "status": "completed", "final_url": "https://chatgpt.com/", "error": ""}

    def fake_fetch(email):
        calls["fetch"] += 1
        return {"country": "US", "state": "NY"}

    monkeypatch.setattr(payment_protocol, "run_protocol_checkout", fake_run)
    monkeypatch.setattr(payment_module, "fetch_us_billing_address", fake_fetch)

    result = payment_module.complete_paypal_checkout_protocol(
        checkout_url="https://pay.openai.com/c/pay/cs_live_xyz",
        cookies_str="a=1",
        proxy=None,
        email="user@example.com",
        payment_method="paypal",
        timeout=120,
        log_fn=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
    )

    assert calls == {"run": 1, "fetch": 1}
    assert result["ok"] is True
    assert result["status"] == "completed"
    assert result["final_url"] == "https://chatgpt.com/"


def test_payment_module_no_longer_exposes_protocol_gate_helpers():
    """Phase 11：闸门相关 helper 应彻底从 payment_module 移除。"""
    assert not hasattr(payment_module, "_protocol_checkout_live_enabled")
    assert not hasattr(payment_module, "_PROTOCOL_LIVE_TRUE_VALUES")


# ----- Phase 7: proto_stage_stripe_poll -----------------------------------------------


def _build_state_with_cs(cs_id: str, *, session, timeout: int = 60) -> "payment_protocol.ProtoState":
    state = payment_protocol.ProtoState(
        session=session,
        current_url=f"https://pay.openai.com/c/pay/{cs_id}",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={},
        identity={},
        log=lambda message: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=timeout,
    )
    state.checkout_context["cs_id"] = cs_id
    return state


def test_classify_poll_state_categorises_known_values():
    assert stripe_http.classify_poll_state({"state": "succeeded"}) == "success"
    assert stripe_http.classify_poll_state({"state": "complete"}) == "success"
    assert stripe_http.classify_poll_state({"state": "failed"}) == "failure"
    assert stripe_http.classify_poll_state({"state": "cancelled"}) == "failure"
    assert stripe_http.classify_poll_state({"state": "active"}) == "pending"
    assert stripe_http.classify_poll_state({"state": "processing"}) == "pending"
    assert stripe_http.classify_poll_state({"state": ""}) == "pending"
    assert stripe_http.classify_poll_state({}) == "pending"


def test_extract_poll_success_url_requires_field():
    assert stripe_http.extract_poll_success_url({"success_url": "https://chatgpt.com/payments/success"}) == (
        "https://chatgpt.com/payments/success"
    )
    with pytest.raises(ValueError):
        stripe_http.extract_poll_success_url({"success_url": ""})
    with pytest.raises(ValueError):
        stripe_http.extract_poll_success_url({})


def test_proto_stage_stripe_poll_succeeds_immediately():
    """state=succeeded 的第一次响应直接返回 success_url，无 sleep。"""
    success_url = "https://chatgpt.com/payments/success?stripe_session_id=cs_live_demo&plan_type=plus"
    session = _StubStripeSession([_StubResponse({"state": "succeeded", "success_url": success_url})])
    state = _build_state_with_cs("cs_live_demo", session=session)

    sleeps: list[float] = []
    result = payment_protocol.proto_stage_stripe_poll(state, sleep_fn=sleeps.append, now_fn=lambda: 0.0)

    assert result.ok is True
    assert result.stage == "stripe_poll"
    assert result.next_url == success_url
    assert result.detail["attempts"] == 1
    assert result.detail["success_url"] == success_url
    assert state.checkout_context["success_url"] == success_url
    assert sleeps == []  # 终态命中，没必要 sleep


def test_proto_stage_stripe_poll_loops_through_pending_then_succeeds():
    """前两次 pending、第三次 succeeded：累计 2 次 sleep，3 次 HTTP，attempts=3。"""
    success_url = "https://chatgpt.com/payments/success?ok=1"
    session = _StubStripeSession(
        [
            _StubResponse({"state": "active"}),
            _StubResponse({"state": "processing"}),
            _StubResponse({"state": "succeeded", "success_url": success_url}),
        ]
    )
    state = _build_state_with_cs("cs_live_demo", session=session, timeout=30)

    sleeps: list[float] = []
    result = payment_protocol.proto_stage_stripe_poll(state, sleep_fn=sleeps.append, now_fn=lambda: 0.0)

    assert result.ok is True
    assert result.next_url == success_url
    assert result.detail["attempts"] == 3
    assert sleeps == [1.0, 1.0]  # 两次 pending 后才到终态
    # 三次 GET 都打到了 /poll
    urls = [call[1] for call in session.calls]
    assert urls == [f"{stripe_http.STRIPE_API_BASE}/payment_pages/cs_live_demo/poll"] * 3


def test_proto_stage_stripe_poll_returns_failure_on_terminal_failure_state():
    """state=failed 立即终止；不允许 fallback（已经走完支付流程，再 fallback 也无意义）。"""
    session = _StubStripeSession([_StubResponse({"state": "failed"})])
    state = _build_state_with_cs("cs_live_demo", session=session, timeout=30)

    result = payment_protocol.proto_stage_stripe_poll(state, sleep_fn=lambda _t: None, now_fn=lambda: 0.0)

    assert result.ok is False
    assert result.fallback_recommended is False
    assert "failed" in result.error.lower()
    assert result.detail["last_state"] == "failed"


def test_proto_stage_stripe_poll_times_out_when_state_stays_pending():
    """模拟时间不断推进；deadline 一过就以 fallback 退出。"""
    pending_responses = [_StubResponse({"state": "active"}) for _ in range(20)]
    session = _StubStripeSession(pending_responses)
    state = _build_state_with_cs("cs_live_demo", session=session, timeout=5)

    # now_fn 每次推进 2 秒，3 次 poll 之后就过 deadline
    times = iter([0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0])

    def fake_now():
        try:
            return next(times)
        except StopIteration:
            return 100.0

    result = payment_protocol.proto_stage_stripe_poll(state, sleep_fn=lambda _t: None, now_fn=fake_now)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "未到终态" in result.error
    assert result.detail["last_state"] == "active"
    assert result.detail["attempts"] >= 1


def test_proto_stage_stripe_poll_falls_back_to_current_url_for_cs_id():
    """没有 checkout_context.cs_id 时（pipeline 跳过了 stripe_checkout），从 current_url 抽。"""
    success_url = "https://chatgpt.com/payments/success?fallback=1"
    session = _StubStripeSession([_StubResponse({"state": "succeeded", "success_url": success_url})])
    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_recovery?ui_mode=hosted",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={},
        identity={},
        log=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=30,
    )
    # 未注入 checkout_context["cs_id"]，强制走 current_url 解析路径

    result = payment_protocol.proto_stage_stripe_poll(state, sleep_fn=lambda _t: None, now_fn=lambda: 0.0)

    assert result.ok is True
    assert result.detail["cs_id"] == "cs_live_recovery"


def test_proto_stage_stripe_poll_reports_unparseable_url():
    """都拿不到 cs_id 时立刻 fallback。"""
    state = payment_protocol.ProtoState(
        session=_StubStripeSession([]),
        current_url="https://example.com/no-cs-id",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={},
        identity={},
        log=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=30,
    )

    result = payment_protocol.proto_stage_stripe_poll(state, sleep_fn=lambda _t: None, now_fn=lambda: 0.0)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "checkout session id" in result.error


def test_default_pipeline_includes_stripe_poll_as_last_stage():
    pipeline = payment_protocol.default_pipeline()
    assert pipeline[-1] is payment_protocol.proto_stage_stripe_poll
    assert pipeline[0] is payment_protocol.proto_stage_stripe_checkout


def test_proto_stage_stripe_checkout_writes_cs_id_into_checkout_context():
    """stripe_checkout 成功路径必须把 cs_id / PayPal redirect 等写进 checkout_context，
    供 stripe_poll 等下游 stage 复用。"""
    init_resp = {"id": "ppage_1", "init_checksum": "init-cs-token", "config_id": "cfg-7"}
    tax_resp = {"id": "ppage_1"}
    confirm_resp = {
        "setup_intent": {
            "next_action": {
                "redirect_to_url": {
                    "url": "https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_Y",
                    "return_url": "https://pay.openai.com/c/pay/cs_live_demo?redirect_pm_type=paypal",
                }
            }
        }
    }
    session = _StubStripeSession(
        [_StubResponse(init_resp), _StubResponse(tax_resp), _StubResponse(confirm_resp)]
    )

    state = payment_protocol.ProtoState(
        session=session,
        current_url="https://pay.openai.com/c/pay/cs_live_demo",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={
            "country": "US", "line1": "1 Main", "city": "X", "postal_code": "11111", "state": "NY",
        },
        identity={},
        log=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=120,
    )

    result = payment_protocol.proto_stage_stripe_checkout(state)

    assert result.ok is True
    assert state.checkout_context["cs_id"] == "cs_live_demo"
    assert state.checkout_context["init_checksum"] == "init-cs-token"
    assert "payment_method_id" not in state.checkout_context
    assert state.checkout_context["paypal_redirect_url"].startswith("https://pm-redirects.stripe.com/authorize/")
    assert state.checkout_context["paypal_return_url"].startswith("https://pay.openai.com/c/pay/cs_live_demo")


# ----- Phase 8: proto_stage_paypal_approve --------------------------------------------


class _StubPayPalResp:
    def __init__(
        self,
        text: str,
        *,
        url: str = "https://www.paypal.com/agreements/approve?ba_token=BA-XYZ",
        status: int = 200,
    ):
        self.text = text
        self.url = url
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _StubPayPalSession:
    def __init__(self, resp: _StubPayPalResp | None = None, *, exc: Exception | None = None):
        self._resp = resp
        self._exc = exc
        self.calls: list[dict] = []

    def get(self, url, *, params=None, headers=None, timeout=None, allow_redirects=None):
        self.calls.append(
            {
                "url": url,
                # 保留 params 原始值（可能是 None）以区分 ba_token / redirect_url 路径
                "params": params,
                "headers": dict(headers or {}),
                "timeout": timeout,
                "allow_redirects": allow_redirects,
            }
        )
        if self._exc is not None:
            raise self._exc
        return self._resp


def _paypal_state(
    *,
    session,
    current_url: str = "",
    paypal_redirect_url: str = "",
    timeout: int = 60,
) -> "payment_protocol.ProtoState":
    state = payment_protocol.ProtoState(
        session=session,
        current_url=current_url,
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={},
        identity={},
        log=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=timeout,
    )
    if paypal_redirect_url:
        state.checkout_context["paypal_redirect_url"] = paypal_redirect_url
    return state


def test_proto_stage_paypal_approve_happy_path_follows_pm_redirect_to_paypal():
    """生产主路径：stripe_checkout 写入的 paypal_redirect_url 是不带 ba_token 的
    pm-redirects 中转 URL，paypal_approve 需要 GET 它让 curl_cffi 跟随 302 落到
    paypal.com，再从 final_url 反抽 ba_token / ec_token。"""
    pm_redirect = "https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_Y"
    final_url = (
        "https://www.paypal.com/checkoutweb/signup"
        "?token=EC-TEST-APPROVAL&ba_token=BA-TEST-APPROVAL&cookieBannerVariant=hidden"
    )
    html = '<html>{"_csrf":"csrf-LIVE-1","_sessionID":"sess-LIVE-1"}</html>'
    session = _StubPayPalSession(_StubPayPalResp(html, url=final_url))
    state = _paypal_state(
        session=session,
        current_url=pm_redirect,
        paypal_redirect_url=pm_redirect,  # 生产场景：不带 ba_token 的中转 URL
    )

    result = payment_protocol.proto_stage_paypal_approve(state)

    assert result.ok is True
    assert result.stage == "paypal_approve"
    # ba_token / ec_token 都是从 final_url 反抽出来的
    assert state.checkout_context["ba_token"] == "BA-TEST-APPROVAL"
    assert state.checkout_context["ec_token"] == "EC-TEST-APPROVAL"
    assert state.checkout_context["paypal_csrf"] == "csrf-LIVE-1"
    assert state.checkout_context["paypal_session_id"] == "sess-LIVE-1"
    assert state.checkout_context["paypal_landing_url"] == final_url
    assert result.next_url == final_url
    # 验证 HTTP 调用形态：直接 GET pm-redirects URL，不传 params
    call = session.calls[0]
    assert call["url"] == pm_redirect
    assert call["params"] is None  # redirect_url 路径不传 params
    assert call["allow_redirects"] is True


def test_proto_stage_paypal_approve_uses_ba_token_fast_path_when_url_already_carries_it():
    """快路径：checkout_context.paypal_redirect_url 已包含 ba_token（测试/手动调试场景），
    应该直接抽 ba_token 走 paypal.com，不再 GET 中转 URL。"""
    final_url = (
        "https://www.paypal.com/checkoutweb/signup"
        "?token=EC-FAST&ba_token=BA-FAST"
    )
    html = '<html>{"_csrf":"c","_sessionID":"s"}</html>'
    session = _StubPayPalSession(_StubPayPalResp(html, url=final_url))
    state = _paypal_state(
        session=session,
        paypal_redirect_url=(
            "https://www.paypal.com/agreements/approve?ba_token=BA-FAST"
        ),
    )

    result = payment_protocol.proto_stage_paypal_approve(state)

    assert result.ok is True
    call = session.calls[0]
    # 走快路径 → GET /agreements/approve 带 params={"ba_token": ...}
    assert call["url"] == "https://www.paypal.com/agreements/approve"
    assert call["params"] == {"ba_token": "BA-FAST"}


def test_proto_stage_paypal_approve_falls_back_to_current_url_for_ba_token():
    """checkout_context 没注入 redirect_url 时，必须能从 current_url 抽到 ba_token。"""
    final_url = "https://www.paypal.com/agreements/approve?ba_token=BA-FROM-CURRENT"
    session = _StubPayPalSession(
        _StubPayPalResp(
            '<html><meta name="_csrf" content="cc"><meta name="_sessionID" content="ss"></html>',
            url=final_url,
        )
    )
    state = _paypal_state(
        session=session,
        current_url="https://www.paypal.com/agreements/approve?ba_token=BA-FROM-CURRENT",
    )

    result = payment_protocol.proto_stage_paypal_approve(state)

    assert result.ok is True
    assert state.checkout_context["ba_token"] == "BA-FROM-CURRENT"
    assert state.checkout_context["ec_token"] == ""  # final_url 没 token= 字段
    assert state.checkout_context["paypal_csrf"] == "cc"
    assert state.checkout_context["paypal_session_id"] == "ss"


def test_proto_stage_paypal_approve_fails_fast_when_no_url_available_at_all():
    """current_url 和 checkout_context.paypal_redirect_url 都为空时立刻 fail-fast，
    不发 HTTP；错误信息提示 stripe_checkout 未写入 paypal_redirect_url。"""
    session = _StubPayPalSession(_StubPayPalResp(""))
    state = _paypal_state(session=session)  # 两个 URL 字段都为空

    result = payment_protocol.proto_stage_paypal_approve(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "paypal_redirect_url" in result.error or "redirect URL" in result.error
    # 不应发起任何 HTTP（连候选 URL 都没有）
    assert session.calls == []


def test_proto_stage_paypal_approve_fails_when_pm_redirect_does_not_resolve_to_paypal():
    """生产路径错误场景：GET pm-redirects URL 后 final_url 仍然不含 ba_token
    （比如代理拦截了 302 或者 PayPal 返回了错误页），应 fallback。"""
    pm_redirect = "https://pm-redirects.stripe.com/authorize/x/y"
    # final_url 是 some/error 页，没有 ba_token query
    session = _StubPayPalSession(
        _StubPayPalResp("<html>error page</html>", url="https://www.paypal.com/some/error")
    )
    state = _paypal_state(session=session, paypal_redirect_url=pm_redirect)

    result = payment_protocol.proto_stage_paypal_approve(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "ba_token" in result.error
    # HTTP 被发出了，但后续抽取失败
    assert len(session.calls) == 1


def test_proto_stage_paypal_approve_handles_http_exception():
    """HTTP 抛异常时返回 fallback_recommended=True，并保留 ba_token 上下文。"""
    session = _StubPayPalSession(exc=RuntimeError("connection reset"))
    state = _paypal_state(
        session=session,
        current_url="https://www.paypal.com/agreements/approve?ba_token=BA-EXC",
    )

    result = payment_protocol.proto_stage_paypal_approve(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "connection reset" in result.error
    assert result.detail["ba_token"] == "BA-EXC"


def test_proto_stage_paypal_approve_reports_html_token_extraction_failure():
    """落地 HTML 里没有 _csrf/_sessionID 时返回 fallback，
    避免下游 captcha / signup stage 顶着空 token 必败。"""
    final_url = "https://www.paypal.com/agreements/approve?ba_token=BA-NOPE"
    session = _StubPayPalSession(_StubPayPalResp("<html>no tokens at all</html>", url=final_url))
    state = _paypal_state(
        session=session,
        current_url=final_url,
    )

    result = payment_protocol.proto_stage_paypal_approve(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "_csrf" in result.error
    assert result.detail["csrf_found"] is False
    assert result.detail["session_id_found"] is False
    assert result.detail["ba_token"] == "BA-NOPE"


def test_default_pipeline_paypal_approve_position():
    """default_pipeline 顺序（Phase 12 起）：stripe_checkout → paypal_approve →
    paypal_signup → paypal_authorize (hermes + cardTypes + authorize) → stripe_poll。

    Phase 12 起补回了 ``paypal_signup``：因为 hermes / cardTypes / authorize 必须
    带 ``x-paypal-internal-euat`` header，而 euat 唯一来源是 SignUp 响应。
    """
    pipeline = payment_protocol.default_pipeline()
    names = [getattr(fn, "__name__", "") for fn in pipeline]
    assert names == [
        "proto_stage_stripe_checkout",
        "proto_stage_paypal_approve",
        "proto_stage_paypal_signup",
        "proto_stage_paypal_authorize",
        "proto_stage_stripe_poll",
    ]


# ----- Phase 9: proto_stage_paypal_authorize ------------------------------------------


class _StubAuthResp:
    """支持 .json()/.raise_for_status()，用于 hermes GET + GraphQL POST 双场景。"""

    def __init__(self, *, payload=None, text: str = "", url: str = "https://www.paypal.com/", status: int = 200):
        self._payload = payload
        self.text = text
        self.url = url
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class _StubAuthSession:
    """按调用顺序消费一组预设响应，记录 GET / POST 的关键参数。"""

    def __init__(self, responses: list[_StubAuthResp], *, exc_at: int | None = None, exc: Exception | None = None):
        self._responses = list(responses)
        self._exc_at = exc_at
        self._exc = exc
        self.calls: list[dict] = []

    def _next(self) -> _StubAuthResp:
        if not self._responses:
            raise AssertionError("StubAuthSession 收到了超出预设数量的请求")
        return self._responses.pop(0)

    def get(self, url, *, params=None, headers=None, timeout=None, allow_redirects=None):
        idx = len(self.calls)
        self.calls.append(
            {
                "method": "GET",
                "url": url,
                "params": dict(params or {}),
                "headers": dict(headers or {}),
                "timeout": timeout,
                "allow_redirects": allow_redirects,
            }
        )
        if self._exc is not None and self._exc_at == idx:
            raise self._exc
        return self._next()

    def post(self, url, *, json=None, data=None, headers=None, timeout=None):
        idx = len(self.calls)
        self.calls.append(
            {
                "method": "POST",
                "url": url,
                "json": json,
                "data": data,
                "headers": dict(headers or {}),
                "timeout": timeout,
            }
        )
        if self._exc is not None and self._exc_at == idx:
            raise self._exc
        return self._next()


def _authorize_state(
    *,
    session,
    ba_token: str = "BA-TEST-FIXTURE",
    ec_token: str = "EC-TEST-FIXTURE",
    paypal_euat: str = "S23AAM_TEST_EUAT_TOKEN_FOR_UNIT_TESTS",
    paypal_csrf: str = "csrf_test_value",
    paypal_session_id: str = "nsid_test_value",
    timeout: int = 60,
    landing_url: str = "https://www.paypal.com/checkoutweb/signup?token=EC-TEST-FIXTURE",
) -> "payment_protocol.ProtoState":
    state = payment_protocol.ProtoState(
        session=session,
        current_url="",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={},
        identity={},
        log=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=timeout,
    )
    state.checkout_context["ba_token"] = ba_token
    state.checkout_context["ec_token"] = ec_token
    state.checkout_context["paypal_landing_url"] = landing_url
    # Phase 12 起 authorize 强制要求 euat / csrf / nsid，单测默认填 stub 值；
    # 单独测 "缺 euat fail-fast" 时把 paypal_euat="" 传入即可。
    if paypal_euat:
        state.checkout_context["paypal_euat"] = paypal_euat
    if paypal_csrf:
        state.checkout_context["paypal_csrf"] = paypal_csrf
    if paypal_session_id:
        state.checkout_context["paypal_session_id"] = paypal_session_id
    return state


def test_proto_stage_paypal_authorize_happy_path_hits_hermes_then_two_graphql_calls():
    """主路径：GET hermes → POST cardTypes → POST authorize，最后 next_url=returnURL。"""
    return_url = (
        "https://pm-redirects.stripe.com/return/acct_X/sa_nonce_Y/"
        "?status=success&token=EC-TEST-FIXTURE"
    )
    responses = [
        _StubAuthResp(text="<html>hermes</html>", url="https://www.paypal.com/webapps/hermes?..."),
        _StubAuthResp(payload=[{"data": {"billing": {"cardTypes": {"allowed": ["VISA", "DISCOVER", "MASTERCARD", "AMEX"]}}}}]),
        _StubAuthResp(payload=[{
            "data": {
                "billing": {
                    "authorize": {
                        "billingAgreementToken": "BA-TEST-FIXTURE",
                        "paymentAction": "SALE",
                        "returnURL": {"href": return_url},
                        "buyer": {"userId": "TEST_BUYER_ID"},
                    }
                }
            }
        }]),
    ]
    session = _StubAuthSession(responses)
    state = _authorize_state(session=session)

    result = payment_protocol.proto_stage_paypal_authorize(state)

    assert result.ok is True
    assert result.stage == "paypal_authorize"
    assert result.next_url == return_url
    assert state.checkout_context["paypal_return_url_final"] == return_url
    assert state.checkout_context["paypal_buyer_user_id"] == "TEST_BUYER_ID"
    assert state.checkout_context["paypal_payment_action"] == "SALE"
    assert state.checkout_context["paypal_card_types_allowed"] == ["VISA", "DISCOVER", "MASTERCARD", "AMEX"]

    # 三次调用：GET hermes / POST cardTypes / POST authorize
    assert [c["method"] for c in session.calls] == ["GET", "POST", "POST"]
    # POST 都打到 /graphql/（带尾斜杠）
    assert session.calls[1]["url"] == "https://www.paypal.com/graphql/"
    assert session.calls[2]["url"] == "https://www.paypal.com/graphql/"
    assert session.calls[1]["json"][0]["operationName"] == "cardTypes"
    assert session.calls[2]["json"][0]["operationName"] == "authorize"
    # authorize variables 必须包含 OPT_OUT
    assert session.calls[2]["json"][0]["variables"]["fundingPreference"] == {"balancePreference": "OPT_OUT"}


def test_proto_stage_paypal_authorize_requires_tokens_in_context():
    """缺 ba_token / ec_token 立刻 fail-fast，不发请求。"""
    session = _StubAuthSession([])
    state = payment_protocol.ProtoState(
        session=session,
        current_url="",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address={},
        identity={},
        log=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=30,
    )
    # 不注入 checkout_context 任何字段

    result = payment_protocol.proto_stage_paypal_authorize(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "ba_token" in result.error or "ec_token" in result.error
    assert session.calls == []  # fail-fast，零请求


def test_proto_stage_paypal_authorize_fallback_when_hermes_fails():
    """hermes GET 抛异常时返回 fallback；不再触发 GraphQL。"""
    session = _StubAuthSession([], exc_at=0, exc=RuntimeError("hermes 502"))
    state = _authorize_state(session=session)

    result = payment_protocol.proto_stage_paypal_authorize(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "hermes" in result.error.lower()
    # 只发出 1 次（失败的 hermes GET），cardTypes / authorize 都没发
    assert len(session.calls) == 1
    assert session.calls[0]["method"] == "GET"


def test_proto_stage_paypal_authorize_fallback_when_card_types_fails():
    """cardTypes 抛异常时返回 fallback；authorize 不发。"""
    responses = [_StubAuthResp(text="<html>hermes</html>")]  # hermes 成功
    session = _StubAuthSession(responses, exc_at=1, exc=RuntimeError("graphql 500"))
    state = _authorize_state(session=session)

    result = payment_protocol.proto_stage_paypal_authorize(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "cardTypes" in result.error
    # 2 次：GET hermes + 失败的 cardTypes POST
    assert len(session.calls) == 2


def test_proto_stage_paypal_authorize_fallback_on_authorize_graphql_errors():
    """authorize 响应里有 errors 时 fallback，且错误信息透出。"""
    responses = [
        _StubAuthResp(text="<html>hermes</html>"),
        _StubAuthResp(payload=[{"data": {"billing": {"cardTypes": {"allowed": ["VISA"]}}}}]),
        _StubAuthResp(payload=[{"errors": [{"message": "RATE_LIMITED"}], "data": None}]),
    ]
    session = _StubAuthSession(responses)
    state = _authorize_state(session=session)

    result = payment_protocol.proto_stage_paypal_authorize(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "RATE_LIMITED" in result.error


def test_proto_stage_paypal_authorize_fallback_on_missing_return_url():
    """authorize 响应里 returnURL 缺失视为失败。"""
    responses = [
        _StubAuthResp(text="<html>hermes</html>"),
        _StubAuthResp(payload=[{"data": {"billing": {"cardTypes": {"allowed": ["VISA"]}}}}]),
        _StubAuthResp(payload=[{
            "data": {
                "billing": {
                    "authorize": {
                        "billingAgreementToken": "BA-1",
                        "paymentAction": "SALE",
                        # returnURL 缺失
                        "buyer": {"userId": "U-1"},
                    }
                }
            }
        }]),
    ]
    session = _StubAuthSession(responses)
    state = _authorize_state(session=session)

    result = payment_protocol.proto_stage_paypal_authorize(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "returnURL" in result.error


def test_proto_stage_paypal_authorize_propagates_euat_and_metadata_headers_to_graphql():
    """Phase 12 关键回归：cardTypes / authorize POST 都要带 euat / csrf / nsid /
    PAYPAL-CLIENT-METADATA-ID / x-app-name，缺一个 PayPal hermes endpoint 就 403。

    PAYPAL-CLIENT-METADATA-ID 来自 ``state.paypal_cmid``；上层显式赋值时直接
    用赋值结果，未赋值时由 hermes 阶段 fallback 到 ec_token（HAR 实采证明浏览器
    里 cmid 字面就等于 ec_token）。
    """
    return_url = "https://pm-redirects.stripe.com/return/acct_X/sa_nonce_Y/?status=success"
    responses = [
        _StubAuthResp(text="<html>hermes</html>"),
        _StubAuthResp(payload=[{"data": {"billing": {"cardTypes": {"allowed": ["VISA"]}}}}]),
        _StubAuthResp(payload=[{
            "data": {"billing": {"authorize": {
                "billingAgreementToken": "BA-XYZ",
                "paymentAction": "SALE",
                "returnURL": {"href": return_url},
                "buyer": {"userId": "U-1"},
            }}}
        }]),
    ]
    session = _StubAuthSession(responses)
    state = _authorize_state(
        session=session,
        ec_token="EC-PROPAGATE",
        paypal_euat="S23AAM_PROPAGATE",
        paypal_csrf="csrf-prop",
        paypal_session_id="nsid-prop",
    )
    # 显式设一个稳定 cmid 便于断言（默认会随机生成）
    state.paypal_cmid = "abcdef1234567890fedcba0987654321"

    result = payment_protocol.proto_stage_paypal_authorize(state)
    assert result.ok is True

    # session.calls[0] 是 hermes GET（这里只关注 GraphQL POST）
    card_types_call = session.calls[1]
    authorize_call = session.calls[2]
    for call in (card_types_call, authorize_call):
        hdrs = call["headers"]
        assert hdrs["x-paypal-internal-euat"] == "S23AAM_PROPAGATE"
        assert hdrs["x-csrf-token"] == "csrf-prop"
        assert hdrs["PayPal-Nsid"] == "nsid-prop"
        # PAYPAL-CLIENT-METADATA-ID 来自 state.paypal_cmid（不是 ec_token）
        assert hdrs["PAYPAL-CLIENT-METADATA-ID"] == "abcdef1234567890fedcba0987654321"
        assert hdrs["x-app-name"] == "checkoutuinodeweb"
        assert hdrs["x-country"] == "US"
        assert hdrs["x-locale"] == "en_US"


def test_proto_state_defaults_paypal_cmid_to_empty_for_ec_token_fallback():
    """``ProtoState.paypal_cmid`` 默认应当为空字符串。HAR 实采分析显示浏览器内
    ``paypal-client-metadata-id`` 字面就等于 ``ec_token``，所以默认留空、由下游
    paypal_post_* 函数自动 fallback 到 ec_token，确保整个 checkout 流程的所有
    PayPal GraphQL 请求 CMID 完全一致（消除"多请求多 cmid"风险）。
    """
    state = payment_protocol.ProtoState(
        session=None, current_url="", proxy=None, email="", cookies_str="",
        address={}, identity={}, log=lambda m: None, cancel_check=None,
        turnstile_solver=None, timeout=60,
    )
    assert state.paypal_cmid == ""
    # 显式赋值仍然支持（覆盖默认 fallback 行为，便于测试或抓包重放）
    state.paypal_cmid = "EXPLICIT-CMID"
    assert state.paypal_cmid == "EXPLICIT-CMID"


# ----- Phase 12: proto_stage_paypal_signup ------------------------------------------


class _StubSignupResp:
    """支持 .json()/.raise_for_status() 的 SignUp 响应 stub。"""

    def __init__(self, *, payload: dict | None = None, status: int = 200):
        self._payload = payload or {}
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class _StubSignupSession:
    def __init__(self, resp: _StubSignupResp | None = None, *, exc: Exception | None = None):
        self._resp = resp
        self._exc = exc
        self.calls: list[dict] = []

    def post(self, url, *, json=None, data=None, headers=None, timeout=None):
        self.calls.append(
            {
                "method": "POST",
                "url": url,
                "json": json,
                "data": data,
                "headers": dict(headers or {}),
                "timeout": timeout,
            }
        )
        if self._exc is not None:
            raise self._exc
        return self._resp


def _signup_state(
    *,
    session,
    ec_token: str = "EC-TEST-FIXTURE",
    ba_token: str = "BA-TEST-FIXTURE",
    landing_url: str = "https://www.paypal.com/checkoutweb/signup?token=EC-TEST-FIXTURE",
    address: dict | None = None,
    identity: dict | None = None,
    timeout: int = 60,
) -> "payment_protocol.ProtoState":
    state = payment_protocol.ProtoState(
        session=session,
        current_url="",
        proxy=None,
        email="user@example.com",
        cookies_str="",
        address=address if address is not None else {
            "line1": "123 Test Avenue",
            "line2": "Apt 305",
            "city": "Yonkers",
            "state": "NY",
            "postal_code": "10701",
        },
        identity=identity if identity is not None else {},
        log=lambda m: None,
        cancel_check=None,
        turnstile_solver=None,
        timeout=timeout,
    )
    state.checkout_context["ec_token"] = ec_token
    state.checkout_context["ba_token"] = ba_token
    state.checkout_context["paypal_landing_url"] = landing_url
    return state


def test_proto_stage_paypal_signup_happy_path_extracts_euat_into_context():
    """主路径：address 完整、SignUp 响应里有 accessToken → 抽到 euat 存 ctx。"""
    payload = {
        "errors": [{
            "message": "ISSUER_DECLINE",
            "errorData": {
                "0": {"field": "cardNumber", "code": "CARD_GENERIC_ERROR"},
                "accessToken": "S23AAM_HAPPY_PATH",
            },
        }],
        "data": {"onboardAccount": None},
    }
    session = _StubSignupSession(_StubSignupResp(payload=payload))
    state = _signup_state(session=session)

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is True
    assert result.stage == "paypal_signup"
    assert state.checkout_context["paypal_euat"] == "S23AAM_HAPPY_PATH"
    # SignUp 调用的 Referer **必须**由 ``build_signup_referer(ec_token, ba_token)``
    # 构造，**不能**直接复用 ``landing_url``——后者可能是 paypal_approve 阶段的
    # ``/agreements/approve?...``，会触发 PayPal 路由成页面访问回 SPA HTML（详见
    # ``test_proto_stage_paypal_signup_uses_checkoutweb_referer_not_approve_landing``）。
    call = session.calls[0]
    assert call["url"] == "https://www.paypal.com/graphql?SignUpNewMemberMutation"
    referer = call["headers"]["Referer"]
    assert referer.startswith("https://www.paypal.com/checkoutweb/signup?"), referer
    assert "token=EC-TEST-FIXTURE" in referer
    assert "ba_token=BA-TEST-FIXTURE" in referer
    # body 必须含 EC token 和 fake card / email
    body = call["json"]
    assert body["operationName"] == "SignUpNewMemberMutation"
    assert body["variables"]["token"] == "EC-TEST-FIXTURE"
    assert body["variables"]["billingAddress"]["postalCode"] == "10701"
    # identity 应该被写入 state（后续 stage 可复用）
    assert state.identity.get("first_name")
    assert state.identity.get("email", "").endswith("@gmail.com")


def test_proto_stage_paypal_signup_fail_fast_when_ec_token_missing():
    """ec_token 缺失立即 fallback，不发请求。"""
    session = _StubSignupSession()
    state = _signup_state(session=session, ec_token="")

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "ec_token" in result.error
    assert session.calls == []


def test_proto_stage_paypal_signup_fail_fast_when_address_incomplete():
    """billingAddress 必填字段缺一个就 fallback，不发请求（PayPal 服务器对地址敏感）。"""
    session = _StubSignupSession()
    # 缺 postal_code
    state = _signup_state(session=session, address={"line1": "x", "city": "y", "state": "NY"})

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "地址" in result.error or "address" in result.error.lower()
    assert session.calls == []


def test_proto_stage_paypal_signup_fail_when_response_has_no_access_token():
    """SignUp 返回但 accessToken 字段缺失，标记 fallback 并把响应摘要带回。"""
    payload = {
        "errors": [{"message": "OTP_REQUIRED", "errorData": {"0": {"code": "OTP_GATE"}}}],
        "data": {"onboardAccount": None},
    }
    session = _StubSignupSession(_StubSignupResp(payload=payload))
    state = _signup_state(session=session)

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "accessToken" in result.error
    # 摘要应被附在 detail 里方便排查
    assert "response_preview" in result.detail
    # 不应该污染 ctx
    assert "paypal_euat" not in state.checkout_context


def test_proto_stage_paypal_signup_fallback_on_network_error():
    """session.post 抛异常 → fallback；euat 不写入 ctx。"""
    session = _StubSignupSession(exc=RuntimeError("boom 502"))
    state = _signup_state(session=session)

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "boom 502" in result.error or "SignUp 调用失败" in result.error
    assert "paypal_euat" not in state.checkout_context


def test_proto_stage_paypal_signup_pulls_phone_and_relay_from_sms_pool(monkeypatch):
    """sms_pool 第一条应被注入到 identity (phone / phone_e164 / sms_relay_url)。

    sms_pool 非空时协议模式跳过首次 SignUp、直接走 OTP 子链 （HAR 实采的真实
    流程）。最终唯一一次 SignUp 的 phone.number 应该是 sms_pool[0] 的本地号。
    """
    EUAT = "S23AAM_POOL"

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json, "headers": dict(headers or {})})
            if "InitiateRiskBasedTwoFactorPhoneConfirmationMutation" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "A1", "challengeId": "C1", "state": "PENDING",
                    }
                }})
            if "ConfirmRiskBasedTwoFactorPhoneConfirmationMutation" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "CONFIRMED"}
                }})
            if "SignUpNewMemberMutation" in url:
                return _StubSignupResp(payload={
                    "errors": [{"message": "ISSUER_DECLINE", "errorData": {
                        "0": {"code": "CARD_GENERIC_ERROR"}, "accessToken": EUAT,
                    }}],
                    "data": {"onboardAccount": None},
                })
            raise AssertionError(f"未预期的 URL: {url}")

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else "123456",
    )

    session = _RouterSession()
    state = _signup_state(session=session)
    # 用户在弹窗里填的号码池
    state.sms_pool = [
        {
            "phone": "12025550142",
            "phone_e164": "+12025550142",
            "relay_url": "https://relay.example.invalid/messages/TEST_RELAY_KEY_A",
        },
        {
            "phone": "12025550156",
            "phone_e164": "+12025550156",
            "relay_url": "https://relay.example.invalid/messages/TEST_RELAY_KEY_B",
        },
    ]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is True
    # identity 已被池子覆盖
    assert state.identity["phone"] == "12025550142"
    assert state.identity["phone_e164"] == "+12025550142"
    assert state.identity["sms_relay_url"].endswith("TEST_RELAY_KEY_A")
    # 最后一次调用是 SignUp（跳过首次后只发一次）
    signup_calls = [c for c in session.calls if "SignUpNewMemberMutation" in c["url"]]
    assert len(signup_calls) == 1, f"期望唯一一次 SignUp，实际 {len(signup_calls)} 次"
    # SignUp body 的 phone.number 在 OTP 子链里被同步成 OTP 用的本地号（剥 +1）
    assert signup_calls[0]["json"]["variables"]["phone"]["number"] == "2025550142"


def test_proto_stage_paypal_signup_recognizes_phone_confirmation_required():
    """PayPal 返回 PHONE_CONFIRMATION_REQUIRED 时给清晰指引并标 needs_otp=True。"""
    payload = {
        "errors": [{
            "message": "PHONE_CONFIRMATION_REQUIRED",
            "checkpoints": ["signUpNewMember"],
            "contingency": True,
            "path": ["onboardAccount"],
        }],
        "data": {"onboardAccount": None},
    }
    session = _StubSignupSession(_StubSignupResp(payload=payload))
    state = _signup_state(session=session)
    # 没填 sms_pool —— fallback_recommended 应为 False（继续也没用）
    state.sms_pool = []

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert "PHONE_CONFIRMATION_REQUIRED" in result.error or "电话 OTP" in result.error
    assert result.detail.get("needs_otp") is True
    assert result.detail.get("sms_pool_size") == 0
    # 没号码池时不建议 fallback Camoufox 也救不了：camoufox 同样要 OTP，由前端提示用户填池
    assert result.fallback_recommended is False


def test_proto_stage_paypal_signup_full_otp_subchain_yields_euat(monkeypatch):
    """OTP 子链端到端 happy path（HAR 真实流程）：
    1) initiate → authId / challengeId
    2) 轮询 relay_url 拿到 6 位 pin
    3) confirm → CONFIRMED
    4) 唯一一次 SignUp → ISSUER_DECLINE + accessToken
    最终 euat 被写入 ctx，stage 返回 ok=True。
    """
    PIN = "200721"
    EUAT = "S23AAM_AFTER_OTP_FULL"

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []
            self.signup_count = 0

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json, "headers": dict(headers or {})})
            if "SignUpNewMemberMutation" in url:
                self.signup_count += 1
                # HAR 实采的唯一一次 SignUp 返回 ISSUER_DECLINE + accessToken
                return _StubSignupResp(payload={
                    "errors": [{"message": "ISSUER_DECLINE", "errorData": {
                        "0": {"code": "CARD_GENERIC_ERROR"},
                        "accessToken": EUAT,
                    }}],
                    "data": {"onboardAccount": None},
                })
            if "/idapps/graphql" in url:
                # OTP_CHALLENGE 预热 (`getOtpChallengeOperation`)。HAR 实采的服
                # 务端响应所有字段都是 null（PayPal 不在响应里下发 challenge，
                # 仅返回 200 + 设置 fraud cookie）。
                return _StubSignupResp(payload={"data": {"otp": {"getOtpChallenge": {
                    "publicCredential": None, "nonce": None, "isPomaUser": None,
                    "countryCode": None, "challenges": None,
                }}}})
            if "InitiateRiskBasedTwoFactorPhoneConfirmationMutation" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "AID-OTP-FULL", "challengeId": "CID-OTP-FULL",
                        "state": "PENDING",
                    }
                }})
            if "ConfirmRiskBasedTwoFactorPhoneConfirmationMutation" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": None, "challengeId": None, "state": "CONFIRMED",
                    }
                }})
            raise AssertionError(f"未预期的 URL: {url}")

    # mock _fetch_ctf_relay_code 直接返回 pin（避免真的 HTTP）。
    # baseline 调用（single_attempt=True）返回空，避免被加入 excluded_pins。
    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else PIN,
    )

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [{
        "phone": "12025550142",
        "phone_e164": "+12025550142",
        "relay_url": "https://relay.example.invalid/messages/TEST_RELAY_KEY_FULL",
    }]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is True
    # 拿到 OTP 后唯一一次 SignUp 的 accessToken 应被写入 ctx
    assert state.checkout_context["paypal_euat"] == EUAT

    # 新调用顺序（HAR 真实流程）：weasley_logger → fraudnet (best-effort) →
    # OTP_CHALLENGE → Initiate → Confirm → SignUp。
    # - weasley_logger 让 PayPal 下发 ``tsrce=checkoutuinodeweb_weasley`` cookie，
    #   后续 OTP 三步才能被识别为合法 weasley fetch（详见 ``paypal_post_weasley_logger`` doc）
    # - fraudnet (c.paypal.com/v1/r/d/b/p1|p2|pa) 注册设备指纹，避免 SignUp 阶段
    #   OAS_ERROR (createMemberAccount)。fraudnet 是"尽力而为"——失败不阻塞主流程，
    #   所以这个测试里 ``_RouterSession`` 让它走默认 AssertionError 路径，
    #   fraudnet 内部 try/except 吞掉，但 ``session.calls`` 上 ``.append`` 已先
    #   执行（见 _RouterSession.post），所以 fraudnet 的 3 个 POST 仍出现在 calls 列表里。
    # - OTP_CHALLENGE 把 fraud context 注册到 PayPal 服务端，避免 Confirm 报
    #   PHONE_CONFIRMATION_NOT_INITIATED
    # - SignUp 跳过首次（HAR 实采里浏览器从不在 OTP 之前发 SignUp）避免风控判定
    #   "多次 SignUp 尝试" OAS_ERROR。
    #
    # 这里**用 URL 子串查 index** 而不是 hardcoded position，避免后续给协议链路
    # 加任何 best-effort 步骤（比如 fraudnet）时 break 这个测试。

    urls = [c["url"] for c in session.calls]

    def _idx_of(needle: str) -> int:
        for i, u in enumerate(urls):
            if needle in u:
                return i
        raise AssertionError(f"call 列表里没找到 {needle!r}: {urls!r}")

    weasley_idx = _idx_of("/xoplatform/logger/api/logger/")
    challenge_idx = _idx_of("/idapps/graphql")
    initiate_idx = _idx_of("?InitiateRiskBasedTwoFactorPhoneConfirmationMutation")
    confirm_idx = _idx_of("?ConfirmRiskBasedTwoFactorPhoneConfirmationMutation")
    signup_idx = _idx_of("?SignUpNewMemberMutation")

    # 关键顺序契约：weasley → OTP_CHALLENGE → Initiate → Confirm → SignUp，
    # 且 weasley 必须是**最前**的关键步骤（前面只允许 fraudnet 这种 best-effort
    # 步骤——它们对正确性不影响）。
    assert weasley_idx == 0, f"weasley logger 必须是第一个调用: urls={urls!r}"
    assert weasley_idx < challenge_idx < initiate_idx < confirm_idx < signup_idx, (
        f"OTP 子链关键步骤顺序应为 weasley<challenge<initiate<confirm<signup, "
        f"实际 indices=weasley={weasley_idx} challenge={challenge_idx} "
        f"initiate={initiate_idx} confirm={confirm_idx} signup={signup_idx}, urls={urls!r}"
    )
    assert session.signup_count == 1

    # OTP_CHALLENGE body 应当是 idapps/graphql 的 `getOtpChallengeOperation`。
    challenge_body = session.calls[challenge_idx]["json"]
    assert challenge_body["operationName"] == "getOtpChallengeOperation"
    # csrfNonce / ctxId 用 generate_otp_challenge_tokens 占位生成的 88 字符 token
    assert len(challenge_body["csrfNonce"]) == 88
    assert len(challenge_body["variables"]["clientInfo"]["ctxId"]) == 88
    # email 来自 identity / signup body
    assert (
        challenge_body["variables"]["credentials"]["credentialValue"]
        == state.identity["email"]
    )

    # initiate body 用 phone_e164 剥 +1 之后的 10 位本地号
    init_body = session.calls[initiate_idx]["json"]
    assert init_body["variables"]["phoneNumber"] == "2025550142"
    assert init_body["variables"]["token"] == "EC-TEST-FIXTURE"

    # confirm body 用前一步的 authId/challengeId + 拉到的 pin
    confirm_body = session.calls[confirm_idx]["json"]
    assert confirm_body["variables"]["authId"] == "AID-OTP-FULL"
    assert confirm_body["variables"]["challengeId"] == "CID-OTP-FULL"
    assert confirm_body["variables"]["pin"] == PIN

    # SignUp body 中 phone.number 应为池子里号码的本地号
    signup_body = session.calls[signup_idx]["json"]
    assert signup_body["variables"]["phone"]["number"] == "2025550142"


def test_proto_stage_paypal_signup_uses_checkoutweb_referer_not_approve_landing(monkeypatch):
    """SignUp Referer 必须由合成 token 构造为 ``/checkoutweb/signup``，
    不能复用 ``paypal_approve`` 阶段的 ``/agreements/approve`` landing URL。
    """
    EUAT = "TEST_ACCESS_TOKEN_REFERER"

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json, "headers": dict(headers or {})})
            if "SignUpNewMemberMutation" in url:
                return _StubSignupResp(payload={
                    "errors": [{"message": "ISSUER_DECLINE", "errorData": {
                        "0": {"code": "CARD_GENERIC_ERROR"},
                        "accessToken": EUAT,
                    }}],
                    "data": {"onboardAccount": None},
                })
            if "/idapps/graphql" in url:
                return _StubSignupResp(payload={"data": {"otp": {"getOtpChallenge": {
                    "publicCredential": None, "nonce": None, "isPomaUser": None,
                    "countryCode": None, "challenges": None,
                }}}})
            if "InitiateRiskBasedTwoFactorPhoneConfirmationMutation" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "AID-REF", "challengeId": "CID-REF", "state": "PENDING",
                    }
                }})
            if "ConfirmRiskBasedTwoFactorPhoneConfirmationMutation" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": None, "challengeId": None, "state": "CONFIRMED",
                    }
                }})
            raise AssertionError(f"未预期的 URL: {url}")

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else "000000",
    )

    session = _RouterSession()
    # 使用合成 approve landing URL 锁定 Referer 选择逻辑。
    state = _signup_state(
        session=session,
        ec_token="EC-TEST-REFERER",
        ba_token="BA-TEST-REFERER",
        landing_url="https://www.paypal.com/agreements/approve?ba_token=BA-TEST-REFERER",
    )
    state.sms_pool = [{
        "phone": "12025550142",
        "phone_e164": "+12025550142",
        "relay_url": "https://relay.example.test/messages/TEST-REFERER",
    }]

    result = payment_protocol.proto_stage_paypal_signup(state)
    assert result.ok is True, f"修复后应当 SignUp 成功: error={result.error!r}"
    assert state.checkout_context["paypal_euat"] == EUAT

    # 关键回归断言：找到 SignUp 调用的 Referer header，必须是 /checkoutweb/signup
    signup_call = next(
        c for c in session.calls if "SignUpNewMemberMutation" in c["url"]
    )
    referer = signup_call["headers"].get("Referer", "")
    assert referer.startswith("https://www.paypal.com/checkoutweb/signup?"), (
        f"SignUp Referer 必须指向 /checkoutweb/signup SPA 页，实际: {referer!r}"
    )
    assert "/agreements/approve" not in referer, (
        f"SignUp Referer **不应**包含 /agreements/approve, "
        f"实际: {referer!r}"
    )
    # Referer query string 必须带正确的 token / ba_token（PayPal 服务端会校验）
    assert "token=EC-TEST-REFERER" in referer
    assert "ba_token=BA-TEST-REFERER" in referer

    # 顺便锁住：OTP 子链里所有其他 GraphQL 请求的 Referer 也应当是 SignUp 页（不是
    # approve 落地页），避免后续协议层重新引入 landing_url 误用。
    for call in session.calls:
        url = call["url"]
        if "graphql" not in url.lower() and "/idapps/" not in url:
            continue  # weasley_logger / fraudnet 等不在此契约内
        call_referer = call["headers"].get("Referer", "")
        # OTP_CHALLENGE 强制无 Referer（idapps/graphql 路径敏感，由 helper 显式删）
        if "/idapps/graphql" in url:
            assert call_referer == "" or "Referer" not in call["headers"], (
                f"OTP_CHALLENGE 不应带 Referer: url={url} referer={call_referer!r}"
            )
            continue
        assert "/agreements/approve" not in call_referer, (
            f"GraphQL 请求 Referer **不应**包含 /agreements/approve: "
            f"url={url} referer={call_referer!r}"
        )


def test_proto_stage_paypal_signup_oas_error_after_otp_gives_clear_hint(monkeypatch):
    """OTP 通过但重发 SignUp 返回 OAS_ERROR (createMemberAccount 风控) →
    error 文案应明确指出"号码已被风控，请换号"，detail 带 phone_used / retry_first_error。"""

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []
            self.signup_count = 0

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json})
            if "SignUpNewMemberMutation" in url:
                # 新流程：sms_pool 非空 → 跳过首次 SignUp，唯一一次 SignUp 在 OTP
                # 之后发出。这里直接返回 OAS_ERROR 模拟号码被风控。
                self.signup_count += 1
                return _StubSignupResp(payload={
                    "errors": [{"message": "OAS_ERROR", "checkpoints": ["createMemberAccount"]}],
                    "data": {"onboardAccount": None},
                })
            if "Initiate" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "AID-1", "challengeId": "CID-1", "state": "PENDING",
                    }
                }})
            if "Confirm" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "CONFIRMED"}
                }})
            raise AssertionError(url)

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else "200721",
    )

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [{
        "phone": "12025550142", "phone_e164": "+12025550142",
        "relay_url": "https://x.example/relay",
    }]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "OAS_ERROR" in result.error
    assert "+12025550142" in result.error
    # 池子只有 1 条号 → 全部用完 → 给"全新号码池"指引
    assert "号码池" in result.error or "号码" in result.error
    assert result.detail.get("retry_first_error") == "OAS_ERROR"
    assert result.detail.get("tried_phones") == ["+12025550142"]
    assert result.detail.get("post_otp") is True
    assert "paypal_euat" not in state.checkout_context

    # SMS 号码池现在只作为“号码记录”用，checkout 不再自动写入黑名单。
    from infrastructure.sms_pool_repository import SmsPoolBlacklistRepository
    assert SmsPoolBlacklistRepository().get("+12025550142") is None


def test_proto_stage_paypal_signup_rotates_pool_on_oas_error(monkeypatch):
    """sms_pool 第一条号 OAS_ERROR → 自动切换第二条号 → 第二条成功拿到 euat。"""
    EUAT = "S23AAM_AFTER_ROTATION"

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []
            self.signup_count = 0
            self.initiate_count = 0

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json})
            if "SignUpNewMemberMutation" in url:
                # 新流程：跳过首次 SignUp，每个 pool 号只触发一次 SignUp。
                # pool[0] OAS_ERROR → 轮换 pool[1] 成功。
                self.signup_count += 1
                if self.signup_count == 1:
                    return _StubSignupResp(payload={
                        "errors": [{"message": "OAS_ERROR", "checkpoints": ["createMemberAccount"]}],
                        "data": {"onboardAccount": None},
                    })
                return _StubSignupResp(payload={
                    "errors": [{"message": "ISSUER_DECLINE", "errorData": {"accessToken": EUAT}}],
                    "data": {"onboardAccount": None},
                })
            if "Initiate" in url:
                self.initiate_count += 1
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": f"AID-{self.initiate_count}",
                        "challengeId": f"CID-{self.initiate_count}",
                        "state": "PENDING",
                    }
                }})
            if "Confirm" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "CONFIRMED"}
                }})
            raise AssertionError(url)

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else "111111",
    )

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [
        {"phone": "12025550142", "phone_e164": "+12025550142",
         "relay_url": "https://relay.example.test/TEST-A"},
        {"phone": "12025550156", "phone_e164": "+12025550156",
         "relay_url": "https://relay.example.test/TEST-B"},
    ]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is True
    assert state.checkout_context["paypal_euat"] == EUAT
    # 应该跑了 2 次 OTP 子链（pool[0] 失败 + pool[1] 成功）
    assert session.initiate_count == 2
    assert session.signup_count == 2  # 跳过首次后，每个 pool 各 1 次 SignUp
    # 第 2 次 initiate 用的是 pool[1] 的本地号 (去掉 +1)
    initiate_bodies = [c["json"] for c in session.calls if "Initiate" in c["url"]]
    assert initiate_bodies[0]["variables"]["phoneNumber"] == "2025550142"
    assert initiate_bodies[1]["variables"]["phoneNumber"] == "2025550156"
    # 最后一次 SignUp body 的 phone.number 应是 pool[1] 的本地号
    final_signup = [c["json"] for c in session.calls if "SignUp" in c["url"]][-1]
    assert final_signup["variables"]["phone"]["number"] == "2025550156"
    # state.identity 同步成最终成功用的 pool[1]
    assert state.identity["phone_e164"] == "+12025550156"


def test_proto_stage_paypal_signup_otp_subchain_failure_falls_back(monkeypatch):
    """OTP 子链中间失败（如 confirm DENIED）→ stage 返回 ok=False, fallback_recommended=True。"""
    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []
            self.signup_count = 0

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json})
            if "SignUpNewMemberMutation" in url:
                # 新流程：sms_pool 非空时不会触发 SignUp 直到 OTP confirm 通过；
                # 这里 confirm 失败 → 测试期望 stage 早于 SignUp 退出。
                self.signup_count += 1
                raise AssertionError("SignUp 不应被调用（OTP confirm DENIED）")
            if "Initiate" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "AID-X", "challengeId": "CID-X", "state": "PENDING",
                    }
                }})
            if "Confirm" in url:
                # 服务器拒绝 PIN
                return _StubSignupResp(payload={
                    "data": {"confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "DENIED"}},
                    "errors": [{"message": "PIN_INCORRECT"}],
                })
            raise AssertionError(url)

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else "999999",
    )

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [{
        "phone": "12025550142", "phone_e164": "+12025550142",
        "relay_url": "https://x.example/relay",
    }]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert result.fallback_recommended is True
    assert "OTP 子链失败" in result.error
    assert "DENIED" in result.error or "PIN_INCORRECT" in result.error
    assert "paypal_euat" not in state.checkout_context


def test_is_recoverable_otp_error_classifies_correctly():
    """5xx / 连接 / 超时 / TLS 间歇 → True；任务取消 / 配置错 → False。"""
    f = payment_protocol._is_recoverable_otp_error

    # 可恢复
    assert f(Exception("HTTP Error 522: ")) is True
    assert f(Exception("HTTP Error 503: Service Unavailable")) is True
    assert f(Exception("HTTP Error 504: Gateway Timeout")) is True
    assert f(Exception("Connection timed out")) is True
    assert f(Exception("Connection refused")) is True
    assert f(Exception("Connection reset by peer")) is True
    assert f(Exception("Failed to perform, curl: (35) ... invalid library")) is True
    assert f(ConnectionError("network down")) is True
    assert f(TimeoutError("timed out")) is True
    assert f(RuntimeError("未从验证码邮件中提取到 6 位数字验证码: ...")) is True

    # 不可恢复
    assert f(RuntimeError("任务已取消")) is False
    assert f(RuntimeError("sms_pool[2] 缺 phone_e164/relay_url: {}")) is False
    assert f(RuntimeError("pool_index=5 越界（pool size=2）")) is False
    assert f(Exception("HTTP Error 401: Unauthorized")) is False
    assert f(Exception("some random error")) is False


def test_proto_stage_paypal_signup_otp_recovers_via_next_pool_on_relay_5xx(monkeypatch):
    """pool[0] OTP 子链抛 HTTP 522 → 应自动轮换到 pool[1] 并拿到 euat。"""
    EUAT = "S23AAM_RECOVERED_FROM_RELAY_522"

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []
            self.signup_count = 0
            self.initiate_count = 0

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json})
            if "SignUpNewMemberMutation" in url:
                # 新流程：跳过首次后，SignUp 只在 OTP confirm 通过后发一次。
                # pool[0] 的 OTP 被 relay 522 报错，未达 SignUp 阶段 → 达这里的是 pool[1]。
                self.signup_count += 1
                return _StubSignupResp(payload={
                    "errors": [{"message": "ISSUER_DECLINE", "errorData": {"accessToken": EUAT}}],
                    "data": {"onboardAccount": None},
                })
            if "Initiate" in url:
                self.initiate_count += 1
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": f"AID-{self.initiate_count}",
                        "challengeId": f"CID-{self.initiate_count}",
                        "state": "PENDING",
                    }
                }})
            if "Confirm" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "CONFIRMED"}
                }})
            raise AssertionError(url)

    # 让 _fetch_ctf_relay_code 在 pool[0] 时抛 522，pool[1] 时返回正常 OTP
    from platforms.chatgpt import payment as payment_module
    call_state = {"n": 0}

    def fake_relay(**kwargs):
        # baseline 调用（single_attempt=True）一律返回空，不计入 call count，
        # 让 pool[0] 真实轮询能稳定走到第 1 次失败的分支。
        if kwargs.get("single_attempt"):
            return ""
        call_state["n"] += 1
        if call_state["n"] == 1:
            raise Exception("HTTP Error 522: ")
        return "999111"

    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", fake_relay)

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [
        {"phone": "12025550146", "phone_e164": "+12025550146",
         "relay_url": "https://x.example/relay-522"},
        {"phone": "12025550147", "phone_e164": "+12025550147",
         "relay_url": "https://x.example/relay-ok"},
    ]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is True
    assert state.checkout_context["paypal_euat"] == EUAT
    # 第二次 initiate 应该是用 pool[1] 的本地号
    initiate_bodies = [c["json"] for c in session.calls if "Initiate" in c["url"]]
    assert len(initiate_bodies) == 2
    assert initiate_bodies[1]["variables"]["phoneNumber"] == "2025550147"
    # SMS 号码池仅做记录用，checkout 不会写入任何黑名单记录
    from infrastructure.sms_pool_repository import SmsPoolBlacklistRepository
    assert SmsPoolBlacklistRepository().get("+12025550146") is None


def test_proto_stage_paypal_signup_otp_returns_when_single_pool_and_relay_5xx(monkeypatch):
    """单号池 + relay 522 → 没有下一号可换 → 仍 return（保持原行为）。"""

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json})
            if "SignUpNewMemberMutation" in url:
                # 新流程下，relay 522 期间根本到不了 SignUp 阶段，所以这里不应被调用。
                raise AssertionError("SignUp 不应被调用（relay 522 该在 OTP 阶段报错）")
            if "Initiate" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "AID", "challengeId": "CID", "state": "PENDING",
                    }
                }})
            raise AssertionError(url)

    from platforms.chatgpt import payment as payment_module

    def _raise_or_baseline(**kwargs):
        # baseline (single_attempt=True) 走快路径返回空，不抛 522；真实轮询才抛。
        if kwargs.get("single_attempt"):
            return ""
        raise Exception("HTTP Error 522: ")

    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", _raise_or_baseline)

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [{
        "phone": "12025550146", "phone_e164": "+12025550146",
        "relay_url": "https://x.example/relay-only",
    }]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert "OTP 子链失败" in result.error
    assert "522" in result.error
    # 该号未入黑名单（checkout 不再自动写黑名单）
    from infrastructure.sms_pool_repository import SmsPoolBlacklistRepository
    assert SmsPoolBlacklistRepository().get("+12025550146") is None


def test_proto_stage_paypal_signup_does_not_skip_blacklisted_pool_entries(monkeypatch):
    """黑名单仅作为手动记录；checkout 运行时不该读黑名单、不该自动跳过任何号码。
    即使 sms_pool[0] 在黑名单内，仍然应该被使用。"""
    from infrastructure.sms_pool_repository import SmsPoolBlacklistRepository

    SmsPoolBlacklistRepository().add(
        phone="+12025550142",
        relay_url="https://x.example/relay-A",
        reason="oas_error",
        error_code="OAS_ERROR",
    )

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json})
            if "Initiate" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "A", "challengeId": "C", "state": "PENDING",
                    }
                }})
            if "Confirm" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "CONFIRMED"}
                }})
            if "SignUpNewMemberMutation" in url:
                return _StubSignupResp(payload={
                    "errors": [{"message": "ISSUER_DECLINE",
                                "errorData": {"accessToken": "S23AAM_USES_BLACKLISTED"}}],
                    "data": {"onboardAccount": None},
                })
            raise AssertionError(url)

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else "123456",
    )

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [
        {"phone": "12025550142", "phone_e164": "+12025550142",
         "relay_url": "https://x.example/relay-A"},
        {"phone": "12025550147", "phone_e164": "+12025550147",
         "relay_url": "https://x.example/relay-B"},
    ]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is True
    assert state.checkout_context["paypal_euat"] == "S23AAM_USES_BLACKLISTED"
    # **入口不再过滤** — sms_pool 原样不动，黑名单号仍被选中
    assert len(state.sms_pool) == 2
    assert state.identity["phone_e164"] == "+12025550142"


def test_proto_stage_paypal_signup_does_not_blacklist_on_oas_error_rotation(monkeypatch):
    """sms_pool 多条均 OAS_ERROR → 仍会轮换试下一号，但**不**会自动写入黑名单。"""
    from infrastructure.sms_pool_repository import SmsPoolBlacklistRepository

    class _RouterSession:
        def __init__(self):
            self.calls: list[dict] = []
            self.signup_count = 0

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "json": json})
            if "SignUpNewMemberMutation" in url:
                # 新流程：跳过首次 SignUp。每条号只触发一次 SignUp，都返回 OAS_ERROR。
                self.signup_count += 1
                return _StubSignupResp(payload={
                    "errors": [{"message": "OAS_ERROR", "checkpoints": ["createMemberAccount"]}],
                    "data": {"onboardAccount": None},
                })
            if "Initiate" in url:
                return _StubSignupResp(payload={"data": {
                    "initiateRiskBasedTwoFactorPhoneConfirmation": {
                        "authId": "AID", "challengeId": "CID", "state": "PENDING",
                    }
                }})
            if "Confirm" in url:
                return _StubSignupResp(payload={"data": {
                    "confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "CONFIRMED"}
                }})
            raise AssertionError(url)

    from platforms.chatgpt import payment as payment_module
    monkeypatch.setattr(
        payment_module, "_fetch_ctf_relay_code",
        lambda **kwargs: "" if kwargs.get("single_attempt") else "111111",
    )

    session = _RouterSession()
    state = _signup_state(session=session)
    state.sms_pool = [
        {"phone": "12025550142", "phone_e164": "+12025550142",
         "relay_url": "https://x.example/relay-A"},
        {"phone": "12025550156", "phone_e164": "+12025550156",
         "relay_url": "https://x.example/relay-B"},
    ]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    assert "OAS_ERROR" in result.error

    # checkout 不再自动写黑名单，两个号都不会被入库
    repo = SmsPoolBlacklistRepository()
    assert repo.get("+12025550142") is None
    assert repo.get("+12025550156") is None


def test_luhn_check_digit_matches_known_visa_numbers():
    """只用 Stripe 官方测试卡号验算 Luhn 校验位。"""
    f = payment_protocol._luhn_check_digit
    # Stripe 通用成功测试卡 4242424242424242。
    assert f("424242424242424") == "2"
    # Stripe 测试卡 4000000000000077 与 4000000000003220。
    assert f("400000000000007") == "7"
    assert f("400000000000322") == "0"


def test_generate_fake_visa_card_returns_luhn_valid_16_digits():
    """随机生成的卡号必须是 16 位且通过 Luhn 校验。"""
    seen = set()
    for _ in range(20):
        card = payment_protocol._generate_fake_visa_card()
        num = card["number"]
        assert len(num) == 16 and num.isdigit()
        # luhn 自校验：完整 16 位算出的校验位应等于第 16 位
        partial = num[:-1]
        assert payment_protocol._luhn_check_digit(partial) == num[-1]
        # exp 形如 MM/YYYY
        m, y = card["expiration"].split("/")
        assert 1 <= int(m) <= 12 and len(y) == 4
        # cvc 3 位
        assert len(card["cvc"]) == 3 and card["cvc"].isdigit()
        seen.add(num)
    # 20 次至少应有 ≥10 个不同卡号（足够验证随机性）
    assert len(seen) >= 10


def test_generate_paypal_signup_identity_yields_unique_cards_each_call():
    """同进程内连续调用应每次给不同的 card_number，避免风控。"""
    cards = {payment_protocol._generate_paypal_signup_identity()["card_number"] for _ in range(15)}
    # 15 次抽样应该有 ≥10 个不同（极小概率失败但实际几乎不可能）
    assert len(cards) >= 10


def test_local_phone_from_e164_strips_country_code():
    """剥离 +1 (US) / +86 (CN) / +44 (UK) / +61 (AU) / +81 (JP) 等国家码。"""
    f = payment_protocol._local_phone_from_e164
    assert f("+12025550142") == "2025550142"
    assert f("12025550142") == "2025550142"  # 无 +
    assert f("+8613800138000") == "13800138000"
    assert f("+447911123456") == "7911123456"
    assert f("+61412345678") == "412345678"
    # 日本号：之前缺 81 前缀表，整串带 81 填入导致 PayPal JP 区拒号
    assert f("+819012345678") == "9012345678"
    assert f("+85291234567") == "91234567"  # 香港 +852（最长前缀优先，不被 +85/+8 误吞）
    assert f("") == ""
    assert f("+1nope") == ""  # 非纯数字


def test_calling_code_from_e164_resolves_country():
    """E.164 → (calling_code, iso2, local) 最长前缀匹配。"""
    g = payment_protocol._calling_code_from_e164
    assert g("+819012345678") == ("81", "JP", "9012345678")
    assert g("+12025550142") == ("1", "US", "2025550142")
    assert g("+85291234567") == ("852", "HK", "91234567")
    assert g("") == ("", "", "")
    assert g("+1nope") == ("", "", "")


def test_proto_stage_paypal_signup_phone_confirmation_with_sms_pool_invokes_otp_subchain():
    """sms_pool 非空 → 直接走 OTP 子链（跳过首次 SignUp）。所有 POST 返回同一份
    不合适响应 → OTP initiate 解析抛 ValueError，stage catch 后返回
    ok=False, fallback_recommended=True 并保留 needs_otp=True 标志。"""
    payload = {
        "errors": [{"message": "PHONE_CONFIRMATION_REQUIRED", "contingency": True}],
        "data": {"onboardAccount": None},
    }
    session = _StubSignupSession(_StubSignupResp(payload=payload))
    state = _signup_state(session=session)
    state.sms_pool = [{"phone": "12025550142", "phone_e164": "+12025550142",
                       "relay_url": "https://x.example/a"}]

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is False
    # 走的是子链失败分支
    assert "OTP 子链失败" in result.error
    assert result.detail.get("needs_otp") is True
    assert result.detail.get("sms_pool_size") == 1
    assert result.fallback_recommended is True


def test_proto_stage_paypal_signup_reuses_existing_identity_in_state():
    """如果 state.identity 已经被前一个 stage 写过，应直接复用（保持账单连贯）。"""
    fixed = {
        "first_name": "Test",
        "last_name": "Identity",
        "email": "test.identity@example.com",
        "password": "TEST_Password_123!",
        "phone": "2025550142",
        "card_number": "4242424242424242",
        "card_expiration": "12/2030",
        "card_cvc": "123",
    }
    payload = {
        "errors": [{
            "message": "ISSUER_DECLINE",
            "errorData": {"0": {"code": "CARD_GENERIC_ERROR"}, "accessToken": "TEST_ACCESS_TOKEN_REUSED"},
        }],
        "data": {"onboardAccount": None},
    }
    session = _StubSignupSession(_StubSignupResp(payload=payload))
    state = _signup_state(session=session, identity=fixed)

    result = payment_protocol.proto_stage_paypal_signup(state)

    assert result.ok is True
    # 复用 identity 字段，不重新随机
    assert state.identity is fixed
    body = session.calls[0]["json"]
    assert body["variables"]["email"] == "test.identity@example.com"
    assert body["variables"]["firstName"] == "Test Identity"
    assert body["variables"]["lastName"] == "Identity"
