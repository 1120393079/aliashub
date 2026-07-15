"""``platforms.chatgpt.paypal_fraudnet`` 模块的单元测试。

覆盖：

1. deterministic synthetic baseline JSON 能正常加载、模块级缓存生效
2. ``register_fraudnet_session`` 按顺序发出 GET p3 → POST p1 → POST p2 → POST pa
3. ``correlationId`` / ``URL`` / ``time`` / ``corrId`` 这几个字段确实被替换成
   实时值，其他字段保留明确标记为 TEST 的合成 schema
4. 单步 HTTP 失败不抛异常、不阻塞后续 step
5. 无效 ec_token 时 graceful 退路（返回 ``ok=False``，不发任何请求）
6. baseline JSON 缺失时 graceful 退路
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import List
from unittest.mock import patch

import pytest

from platforms.chatgpt import paypal_fraudnet


# ----- 测试辅助 ---------------------------------------------------------------


class _StubResponse:
    def __init__(self, status_code: int = 200, body: str = ""):
        self.status_code = status_code
        self.text = body


class _StubSession:
    """记录所有 .get / .post 调用的极简 session 替身。"""

    def __init__(
        self,
        *,
        get_status: int = 200,
        post_status: int = 200,
        raise_on: set | None = None,
    ):
        self.calls: List[dict] = []
        self._get_status = get_status
        self._post_status = post_status
        self._raise_on = raise_on or set()

    def get(self, url, *, params=None, headers=None, timeout=None, **kw):
        if "get" in self._raise_on:
            raise RuntimeError("stub get failure")
        self.calls.append({
            "method": "GET", "url": url, "params": params,
            "headers": headers, "timeout": timeout,
        })
        return _StubResponse(self._get_status)

    def post(self, url, *, json=None, headers=None, timeout=None, **kw):
        # 通过 url 关键字判断是否抛
        if any(key in url for key in self._raise_on):
            raise RuntimeError(f"stub post failure on {url}")
        self.calls.append({
            "method": "POST", "url": url, "json": json,
            "headers": headers, "timeout": timeout,
        })
        return _StubResponse(self._post_status)


# ----- 测试 ------------------------------------------------------------------


def test_synthetic_baseline_loads_and_caches():
    """合成 baseline 能从模块同目录加载，且不含实采会话数据。"""
    # 清缓存确保从盘读
    paypal_fraudnet._BASELINE_CACHE = None
    b1 = paypal_fraudnet._load_baseline()
    assert "p1" in b1 and "p2" in b1 and "pa" in b1
    assert b1["fixture"] == {
        "kind": "TEST_DETERMINISTIC_SYNTHETIC",
        "version": 1,
        "containsObservedData": False,
    }
    assert b1["p1"]["body"]["appId"] == "IWC_LOGIN_APP"
    assert b1["p1"]["body"]["correlationId"] == "TEST_EC_TOKEN"
    assert b1["p1"]["body"]["payload"]["time"] == 0
    assert (
        b1["p1"]["body"]["payload"]["navigator"]["userAgent"]
        == "TEST_SYNTHETIC_USER_AGENT"
    )
    dfp = b1["pa"]["body"]["payload"][0]["dfp"][0]
    assert dfp["corrId"] == "TEST_EC_TOKEN"
    assert dfp["d"]["fixtureMarker"] == "TEST_SYNTHETIC_DFP"
    # 二次调用应该命中缓存（同对象）
    b2 = paypal_fraudnet._load_baseline()
    assert b1 is b2


def test_register_fraudnet_session_emits_correct_sequence():
    """正常注册：发出 GET p3 + POST p1 + POST p2 + POST pa 共 4 个请求，按顺序。"""
    session = _StubSession()
    logs: List[str] = []

    result = paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-TEST123",
        ba_token="BA-TEST456",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-TEST123",
        log=logs.append,
    )

    assert result["ok"] is True, f"errors={result['errors']}"
    assert result["steps"] == ["p3", "p1", "p2", "pa"]
    # 4 个网络调用按序：GET p3, POST p1, POST p2, POST pa
    methods_urls = [(c["method"], c["url"]) for c in session.calls]
    assert methods_urls == [
        ("GET", paypal_fraudnet.FRAUDNET_P3_URL_TMPL),
        ("POST", paypal_fraudnet.FRAUDNET_P1_URL),
        ("POST", paypal_fraudnet.FRAUDNET_P2_URL),
        ("POST", paypal_fraudnet.FRAUDNET_PA_URL),
    ]


def test_p3_handshake_carries_correct_query_params():
    """GET p3 必须带 ``f=ec_token`` 和 ``s=app_id``。"""
    session = _StubSession()
    paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-ABCDEF",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-ABCDEF",
        log=lambda m: None,
    )
    p3_call = session.calls[0]
    assert p3_call["method"] == "GET"
    assert p3_call["params"] == {"f": "EC-ABCDEF", "s": "IWC_LOGIN_APP"}


def test_p1_body_has_correct_correlation_and_url(monkeypatch):
    """POST p1 body：``correlationId`` / ``payload.URL`` 被替换；``payload.time``
    更新为当前 ms timestamp；其余字段保留合成 baseline。"""
    monkeypatch.setattr(paypal_fraudnet.time, "time", lambda: 2_000_000_000)
    session = _StubSession()
    referer = "https://www.paypal.com/checkoutweb/signup?token=EC-NEW999&ba_token=BA-X"
    paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-NEW999",
        signup_referer=referer,
        log=lambda m: None,
    )
    p1_call = next(c for c in session.calls if c["url"] == paypal_fraudnet.FRAUDNET_P1_URL)
    body = p1_call["json"]
    assert body["appId"] == "IWC_LOGIN_APP"
    assert body["correlationId"] == "EC-NEW999"
    assert body["payload"]["URL"] == referer
    # baseline 的 0 被当前合成时钟替换为 ms。
    assert body["payload"]["time"] == 2_000_000_000_000
    # 合成 schema 字段必须保留且不被修改。
    assert "navigator" in body["payload"]
    assert "screen" in body["payload"]
    assert body["payload"]["navigator"]["userAgent"] == "TEST_SYNTHETIC_USER_AGENT"


def test_p2_body_has_correct_correlation_and_url():
    """POST p2 同样替换 correlationId / URL，并保留合成 data schema。"""
    session = _StubSession()
    paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-P2TEST",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-P2TEST",
        log=lambda m: None,
    )
    p2_call = next(c for c in session.calls if c["url"] == paypal_fraudnet.FRAUDNET_P2_URL)
    body = p2_call["json"]
    assert body["correlationId"] == "EC-P2TEST"
    assert body["payload"]["URL"].endswith("token=EC-P2TEST")
    # data 子结构保留（plugins / fts 等）
    assert "data" in body["payload"]
    assert isinstance(body["payload"]["data"], dict)
    assert body["payload"]["data"]["plugins"][0]["n"] == "TEST_PLUGIN"


def test_pa_body_replaces_dfp_corrid_and_sourceid():
    """POST pa：``payload[0].dfp[*].corrId`` 替换为 ec_token、``sourceId`` 替换为 app_id。"""
    session = _StubSession()
    paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-PATEST",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-PATEST",
        log=lambda m: None,
    )
    pa_call = next(c for c in session.calls if c["url"] == paypal_fraudnet.FRAUDNET_PA_URL)
    body = pa_call["json"]
    assert body["correlationId"] == "EC-PATEST"
    # payload 是 list，第一项是 {"dfp": [...]}
    dfp_container = body["payload"][0]
    assert "dfp" in dfp_container
    dfp = dfp_container["dfp"]
    if isinstance(dfp, list):
        for d in dfp:
            assert d["corrId"] == "EC-PATEST"
            assert d["sourceId"] == "IWC_LOGIN_APP"
            assert d["d"]["fixtureMarker"] == "TEST_SYNTHETIC_DFP"
    else:
        assert dfp["corrId"] == "EC-PATEST"
        assert dfp["sourceId"] == "IWC_LOGIN_APP"


def test_post_headers_use_fraudnet_collector_referer():
    """POST 必须使用 collector 协议要求的 Referer / Origin。"""
    session = _StubSession()
    paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-HDR",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-HDR",
        log=lambda m: None,
    )
    for c in session.calls:
        if c["method"] != "POST":
            continue
        assert c["headers"]["Origin"] == paypal_fraudnet.FRAUDNET_HOST
        assert c["headers"]["Referer"] == paypal_fraudnet.FRAUDNET_REFERER
        assert c["headers"]["Content-Type"] == "application/json"


def test_register_continues_when_p3_get_fails():
    """GET p3 失败不应阻塞 P1/P2/PA 三个 POST。"""
    session = _StubSession(raise_on={"get"})
    logs: List[str] = []
    result = paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-RECOVER",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-RECOVER",
        log=logs.append,
    )
    # ok 整体为 False（因为有 error），但 p1/p2/pa 都已执行
    assert result["ok"] is False
    assert "p3" not in result["steps"]
    assert result["steps"] == ["p1", "p2", "pa"]
    # logs 包含错误提示
    assert any("p3 handshake 失败" in m for m in logs)


def test_register_continues_when_p1_post_fails():
    """POST p1 失败时 p2/pa 仍要发，主流程不阻断。"""
    session = _StubSession(raise_on={"/v1/r/d/b/p1"})
    result = paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-PARTIAL",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-PARTIAL",
        log=lambda m: None,
    )
    assert "p3" in result["steps"]
    assert "p1" not in result["steps"]
    assert "p2" in result["steps"]
    assert "pa" in result["steps"]
    assert any(e.startswith("p1:") for e in result["errors"])


def test_invalid_ec_token_short_circuits():
    """无效 ec_token（空 / 不是 EC-XXX 形式）：不发任何请求，直接返回 failure。"""
    session = _StubSession()
    result = paypal_fraudnet.register_fraudnet_session(
        session, ec_token="", log=lambda m: None,
    )
    assert result["ok"] is False
    assert session.calls == []  # 一个请求都不发

    result2 = paypal_fraudnet.register_fraudnet_session(
        session, ec_token="not-ec-format", log=lambda m: None,
    )
    assert result2["ok"] is False
    assert session.calls == []


def test_baseline_missing_short_circuits_gracefully(monkeypatch, tmp_path):
    """baseline JSON 缺失时不抛异常，返回 ok=False 让上层日志可见。"""
    # 清缓存 + 把模块 _BASELINE_PATH 指到不存在的路径
    paypal_fraudnet._BASELINE_CACHE = None
    fake_path = tmp_path / "no_such.json"
    monkeypatch.setattr(paypal_fraudnet, "_BASELINE_PATH", fake_path)

    session = _StubSession()
    logs: List[str] = []
    result = paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-OK",
        signup_referer="https://www.paypal.com/checkoutweb/signup?token=EC-OK",
        log=logs.append,
    )
    assert result["ok"] is False
    assert any("baseline 加载失败" in m for m in logs)
    # 缺 baseline 时一个请求都不发（避免发出无效 body）
    assert session.calls == []

    # 测试完成后恢复缓存以免影响其他测试
    paypal_fraudnet._BASELINE_CACHE = None


def test_signup_url_falls_back_when_referer_empty():
    """signup_referer 留空时回落到一个含 ec_token / ba_token 的最小合法 URL。"""
    session = _StubSession()
    paypal_fraudnet.register_fraudnet_session(
        session,
        ec_token="EC-NOREF",
        ba_token="BA-NOREF",
        signup_referer="",  # 显式空
        log=lambda m: None,
    )
    p1_call = next(c for c in session.calls if c["url"] == paypal_fraudnet.FRAUDNET_P1_URL)
    url = p1_call["json"]["payload"]["URL"]
    assert "checkoutweb/signup" in url
    assert "token=EC-NOREF" in url
    assert "ba_token=BA-NOREF" in url


def test_personalize_body_does_not_mutate_baseline():
    """``_personalize_body`` 必须深拷贝模板，否则反复调用会污染 baseline 缓存。"""
    paypal_fraudnet._BASELINE_CACHE = None
    baseline = paypal_fraudnet._load_baseline()
    p1_template = baseline["p1"]["body"]
    original_corr = p1_template["correlationId"]
    original_url = p1_template["payload"]["URL"]

    out = paypal_fraudnet._personalize_body(
        p1_template, ec_token="EC-MUT", signup_url="https://test.example/url",
        app_id="IWC_LOGIN_APP",
    )
    assert out["correlationId"] == "EC-MUT"
    assert out["payload"]["URL"] == "https://test.example/url"
    # 模板本身一字未动
    assert p1_template["correlationId"] == original_corr
    assert p1_template["payload"]["URL"] == original_url
