"""``platforms.chatgpt.paypal_http`` 纯单元测试 —— Phase 8。

不联网；URL/HTML 抽取覆盖正常/异常分支，``paypal_get_approve`` 走 stub session
验证 params/headers 与响应解析。
"""

from __future__ import annotations

import pytest

from platforms.chatgpt import paypal_http


# ---------- URL query token 抽取 ----------------------------------------------


def test_extract_token_from_url_handles_ba_and_ec_tokens():
    url = (
        "https://www.paypal.com/agreements/approve"
        "?ba_token=BA-TEST-APPROVAL&token=EC-TEST-APPROVAL&ulOnboardRedirect=true"
    )
    assert paypal_http.extract_token_from_url(url, "ba_token") == "BA-TEST-APPROVAL"
    assert paypal_http.extract_token_from_url(url, "token") == "EC-TEST-APPROVAL"
    assert paypal_http.extract_ba_token(url) == "BA-TEST-APPROVAL"
    assert paypal_http.extract_ec_token(url) == "EC-TEST-APPROVAL"


def test_extract_token_from_url_raises_when_field_missing():
    with pytest.raises(ValueError):
        paypal_http.extract_token_from_url(
            "https://www.paypal.com/agreements/approve?ulOnboardRedirect=true",
            "ba_token",
        )
    with pytest.raises(ValueError):
        paypal_http.extract_token_from_url("", "ba_token")
    with pytest.raises(ValueError):
        paypal_http.extract_token_from_url(
            "https://www.paypal.com/agreements/approve?ba_token=",
            "ba_token",
        )


# ---------- HTML token 抽取 ---------------------------------------------------


def test_extract_paypal_csrf_supports_inline_json():
    html = (
        "<html><head><script>window.__INITIAL_DATA__ = "
        '{"_csrf":"abc-xyz-123","_sessionID":"sess-987"};</script></head></html>'
    )
    assert paypal_http.extract_paypal_csrf(html) == "abc-xyz-123"
    assert paypal_http.extract_paypal_session_id(html) == "sess-987"


def test_extract_paypal_csrf_supports_meta_tag():
    html = (
        '<html><head>'
        '<meta name="_csrf" content="meta-token-001">'
        '<meta name="_sessionID" content="meta-sess-001">'
        '</head></html>'
    )
    assert paypal_http.extract_paypal_csrf(html) == "meta-token-001"
    assert paypal_http.extract_paypal_session_id(html) == "meta-sess-001"


def test_extract_paypal_csrf_supports_data_attribute():
    html = '<body data-csrf="data-token-77" data-session-id="data-sess-77"></body>'
    assert paypal_http.extract_paypal_csrf(html) == "data-token-77"
    assert paypal_http.extract_paypal_session_id(html) == "data-sess-77"


def test_extract_paypal_csrf_prefers_inline_json_when_multiple_present():
    """同一页面 inline JSON + meta 同时存在时，inline JSON 优先（HAR 实采的形式）。"""
    html = (
        '<html><head>'
        '<meta name="_csrf" content="meta-token">'
        '<script>{"_csrf":"json-token"}</script>'
        '</head></html>'
    )
    assert paypal_http.extract_paypal_csrf(html) == "json-token"


def test_extract_paypal_csrf_raises_when_missing():
    with pytest.raises(ValueError):
        paypal_http.extract_paypal_csrf("<html><body>no csrf here</body></html>")
    with pytest.raises(ValueError):
        paypal_http.extract_paypal_csrf("")


def test_extract_paypal_session_id_raises_when_missing():
    with pytest.raises(ValueError):
        paypal_http.extract_paypal_session_id("<html><body>no session id</body></html>")


# ---------- paypal_get_approve ------------------------------------------------


class _StubResp:
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


class _StubSession:
    def __init__(self, resp: _StubResp):
        self._resp = resp
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
        return self._resp


def test_paypal_get_approve_calls_endpoint_with_expected_params():
    resp = _StubResp(
        '<html>{"_csrf":"csrf-1","_sessionID":"sess-1"}</html>',
        url=(
            "https://www.paypal.com/checkoutweb/signup"
            "?token=EC-0123456789ABCDEFG&ba_token=BA-XYZ"
        ),
    )
    session = _StubSession(resp)
    result = paypal_http.paypal_get_approve(
        session, ba_token="BA-XYZ", referer="https://pm-redirects.stripe.com/", timeout=45
    )

    call = session.calls[0]
    assert call["url"] == "https://www.paypal.com/agreements/approve"
    assert call["params"] == {"ba_token": "BA-XYZ"}
    assert call["headers"].get("Referer") == "https://pm-redirects.stripe.com/"
    assert "text/html" in call["headers"].get("Accept", "")
    assert call["allow_redirects"] is True
    assert call["timeout"] == 45

    assert result["status_code"] == 200
    assert result["ba_token"] == "BA-XYZ"
    assert result["ec_token"] == "EC-0123456789ABCDEFG"
    assert "csrf-1" in result["html"]
    assert result["final_url"].startswith("https://www.paypal.com/checkoutweb/signup")


def test_paypal_get_approve_handles_missing_ec_token_gracefully():
    resp = _StubResp(
        '<html>{"_csrf":"c","_sessionID":"s"}</html>',
        url="https://www.paypal.com/agreements/approve?ba_token=BA-XYZ",
    )
    session = _StubSession(resp)
    result = paypal_http.paypal_get_approve(session, ba_token="BA-XYZ")

    assert result["ec_token"] == ""  # 没 token query 不报错，置空让上层判断
    assert result["ba_token"] == "BA-XYZ"


def test_paypal_get_approve_requires_redirect_url_or_ba_token():
    """ba_token 和 redirect_url 全空时抛 ValueError，避免误发空请求。"""
    with pytest.raises(ValueError):
        paypal_http.paypal_get_approve(_StubSession(_StubResp("")))


def test_paypal_get_approve_propagates_http_errors():
    session = _StubSession(_StubResp("forbidden", status=403))
    with pytest.raises(RuntimeError):
        paypal_http.paypal_get_approve(session, ba_token="BA-XYZ")


def test_paypal_get_approve_with_redirect_url_follows_302_and_extracts_ba_token():
    """生产路径：传入 pm-redirects URL（无 ba_token），由 paypal.com 落地后从
    final_url 反抽 ba_token 回填到结果字典里。"""
    pm_redirect = "https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_Y"
    final_url = (
        "https://www.paypal.com/checkoutweb/signup"
        "?token=EC-PRODUCTION&ba_token=BA-PRODUCTION&cookieBannerVariant=hidden"
    )
    resp = _StubResp(
        '<html>{"_csrf":"c","_sessionID":"s"}</html>',
        url=final_url,
    )
    session = _StubSession(resp)

    result = paypal_http.paypal_get_approve(session, redirect_url=pm_redirect)

    # 调用形态：直接 GET pm-redirects URL（不带 params），让 curl_cffi 跟随 302
    call = session.calls[0]
    assert call["url"] == pm_redirect
    assert call["params"] is None  # 不再传 params；URL 本身就是完整的
    assert call["allow_redirects"] is True
    # ba_token 路径传 params dict，redirect_url 路径传 None。反向验证 referer 默认 None
    assert "params" in call

    # final_url 反向抽到的 ba_token + ec_token
    assert result["ba_token"] == "BA-PRODUCTION"
    assert result["ec_token"] == "EC-PRODUCTION"
    assert result["final_url"] == final_url


def test_paypal_get_approve_with_redirect_url_returns_empty_ba_token_when_final_url_lacks_it():
    """跟随 302 后 final_url 里仍然没有 ba_token（异常路径），ba_token 字段应为空串。"""
    resp = _StubResp("<html>nope</html>", url="https://www.paypal.com/some/page")
    session = _StubSession(resp)
    result = paypal_http.paypal_get_approve(
        session, redirect_url="https://pm-redirects.stripe.com/authorize/x/y"
    )
    assert result["ba_token"] == ""
    assert result["ec_token"] == ""


# ---------- Stage P8: build_hermes_url + paypal_get_hermes -------------------


def test_build_hermes_url_includes_all_required_query_params():
    url = paypal_http.build_hermes_url(ba_token="BA-TEST-FIXTURE", ec_token="EC-TEST-FIXTURE")
    # 严格比对 HAR 实采字段，避免日后悄悄漂移
    assert url.startswith("https://www.paypal.com/webapps/hermes?")
    for fragment in (
        "ul=1",
        "modxo_redirect_reason=guest_user",
        "ba_token=BA-TEST-FIXTURE",
        "locale.x=en_US",
        "country.x=US",
        "token=EC-TEST-FIXTURE",
        "rcache=1",
        "cookieBannerVariant=hidden",
        "fromSignupLite=true",
        "addFIContingency=noretry",
        "redirectToHermes=true",
        "fallback=1",
        "reason=Q0FSRF9HRU5FUklDX0VSUk9S",  # base64('CARD_GENERIC_ERROR')
    ):
        assert fragment in url, f"{fragment!r} 应该出现在 hermes URL 里"


def test_build_hermes_url_validates_inputs():
    with pytest.raises(ValueError):
        paypal_http.build_hermes_url(ba_token="", ec_token="EC-1")
    with pytest.raises(ValueError):
        paypal_http.build_hermes_url(ba_token="BA-1", ec_token="")


def test_paypal_get_hermes_calls_endpoint_and_returns_payload():
    hermes_url = paypal_http.build_hermes_url(ba_token="BA-1", ec_token="EC-2")
    resp = _StubResp("<html>hermes spa</html>", url=hermes_url + "&extra=1")
    session = _StubSession(resp)
    result = paypal_http.paypal_get_hermes(
        session, hermes_url=hermes_url, referer="https://www.paypal.com/checkoutweb/signup"
    )
    call = session.calls[0]
    assert call["url"] == hermes_url
    assert call["headers"].get("Referer") == "https://www.paypal.com/checkoutweb/signup"
    assert call["allow_redirects"] is True
    assert result["status_code"] == 200
    assert "hermes spa" in result["html"]


# ---------- Stage P9: GraphQL batch helpers ----------------------------------


class _StubJsonResp:
    def __init__(self, payload, status: int = 200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class _StubJsonSession:
    def __init__(self, payload, *, exc: Exception | None = None):
        self._payload = payload
        self._exc = exc
        self.calls: list[dict] = []

    def post(self, url, *, json=None, headers=None, timeout=None):
        self.calls.append(
            {"url": url, "json": json, "headers": dict(headers or {}), "timeout": timeout}
        )
        if self._exc is not None:
            raise self._exc
        return _StubJsonResp(self._payload)


def test_build_card_types_request_shape_matches_har():
    body = paypal_http.build_card_types_request(ec_token="EC-XYZ", country="US")
    assert isinstance(body, list) and len(body) == 1
    op = body[0]
    assert op["operationName"] == "cardTypes"
    assert op["variables"] == {"billingAgreementId": "EC-XYZ", "country": "US"}
    assert "query cardTypes" in op["query"]
    assert "billing" in op["query"]
    assert "cardTypes" in op["query"]


def test_build_authorize_request_carries_opt_out_funding_preference():
    body = paypal_http.build_authorize_request(ec_token="EC-XYZ")
    assert isinstance(body, list) and len(body) == 1
    op = body[0]
    assert op["operationName"] == "authorize"
    assert op["variables"]["billingAgreementId"] == "EC-XYZ"
    # OPT_OUT 是关键 —— 表达「不走任何资金渠道，纯 $0 授权」
    assert op["variables"]["fundingPreference"] == {"balancePreference": "OPT_OUT"}
    assert op["variables"]["legalAgreements"] == {}
    assert "mutation authorize" in op["query"]
    assert "returnURL" in op["query"]


def test_build_card_types_and_authorize_request_validate_ec_token():
    with pytest.raises(ValueError):
        paypal_http.build_card_types_request(ec_token="")
    with pytest.raises(ValueError):
        paypal_http.build_authorize_request(ec_token="")


def test_paypal_graphql_batch_posts_to_slash_graphql_with_correct_headers():
    payload = [{"data": {"billing": {"cardTypes": {"allowed": ["VISA"]}}}}]
    session = _StubJsonSession(payload)
    result = paypal_http.paypal_graphql_batch(
        session,
        body=paypal_http.build_card_types_request(ec_token="EC-1"),
        referer="https://www.paypal.com/webapps/hermes?token=EC-1",
    )

    call = session.calls[0]
    assert call["url"] == "https://www.paypal.com/graphql/"  # 注意尾斜杠
    assert call["headers"]["Content-Type"] == "application/json"
    assert call["headers"]["Origin"] == "https://www.paypal.com"
    assert call["headers"]["X-Requested-With"] == "fetch"
    assert call["headers"]["Sec-Fetch-Site"] == "same-origin"
    assert isinstance(call["json"], list) and call["json"][0]["operationName"] == "cardTypes"
    assert result == payload


def test_paypal_graphql_batch_rejects_empty_body():
    with pytest.raises(ValueError):
        paypal_http.paypal_graphql_batch(_StubJsonSession([]), body=[], referer="https://x")


def test_paypal_graphql_batch_rejects_non_list_response():
    session = _StubJsonSession({"unexpected": "dict"})
    with pytest.raises(ValueError):
        paypal_http.paypal_graphql_batch(session, body=[{"a": 1}], referer="https://x")


def test_paypal_graphql_batch_propagates_http_errors():
    session = _StubJsonSession([], exc=RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        paypal_http.paypal_graphql_batch(session, body=[{"a": 1}], referer="https://x")


def test_parse_authorize_response_extracts_return_url_and_metadata():
    payload = [
        {
            "data": {
                "billing": {
                    "authorize": {
                        "billingAgreementToken": "BA-TEST-FIXTURE",
                        "paymentAction": "SALE",
                        "returnURL": {
                            "href": "https://pm-redirects.stripe.com/return/acct_X/sa_nonce_Y/?status=success&token=EC-1"
                        },
                        "buyer": {"userId": "TEST_BUYER_ID"},
                    }
                }
            }
        }
    ]
    info = paypal_http.parse_authorize_response(payload)
    assert info["return_url"].startswith("https://pm-redirects.stripe.com/return/")
    assert info["return_url"].endswith("status=success&token=EC-1")
    assert info["billing_agreement_token"] == "BA-TEST-FIXTURE"
    assert info["payment_action"] == "SALE"
    assert info["buyer_user_id"] == "TEST_BUYER_ID"


def test_parse_authorize_response_raises_on_graphql_errors():
    payload = [{"errors": [{"message": "AUTH_FAIL"}], "data": None}]
    with pytest.raises(ValueError) as exc_info:
        paypal_http.parse_authorize_response(payload)
    assert "AUTH_FAIL" in str(exc_info.value)


def test_parse_authorize_response_raises_on_missing_return_url():
    payload = [{"data": {"billing": {"authorize": {"paymentAction": "SALE"}}}}]
    with pytest.raises(ValueError):
        paypal_http.parse_authorize_response(payload)


def test_parse_authorize_response_raises_on_empty_payload():
    with pytest.raises(ValueError):
        paypal_http.parse_authorize_response([])
    with pytest.raises(ValueError):
        paypal_http.parse_authorize_response("not a list")  # type: ignore[arg-type]


def test_parse_card_types_response_returns_allowed_list_or_empty():
    assert paypal_http.parse_card_types_response(
        [{"data": {"billing": {"cardTypes": {"allowed": ["VISA", "MASTERCARD"]}}}}]
    ) == ["VISA", "MASTERCARD"]
    assert paypal_http.parse_card_types_response([]) == []
    assert paypal_http.parse_card_types_response([{"data": None}]) == []
    assert paypal_http.parse_card_types_response([{"data": {"billing": {}}}]) == []


# ---------- Stage P7: SignUpNewMemberMutation --------------------------------


def _make_signup_kwargs(**overrides) -> dict:
    """构造 build_signup_request 的标准参数 dict（便于单测覆盖）。"""
    base = dict(
        ec_token="EC-TEST-FIXTURE",
        card_number="4242424242424242",
        card_expiration="12/2030",
        card_cvc="123",
        email="test.buyer@example.com",
        first_name="Test",
        last_name="User",
        phone_number="2025550142",
        billing_line1="123 Test Avenue",
        billing_line2="Suite TEST-1",
        billing_city="Testville",
        billing_state="CA",
        billing_postal_code="94105",
        password="TEST_Password_123!",
    )
    base.update(overrides)
    return base


def test_build_signup_request_matches_protocol_field_layout():
    """build_signup_request 应当从纯合成 fixture 生成协议要求的 body 结构。"""
    body = paypal_http.build_signup_request(**_make_signup_kwargs())

    assert isinstance(body, dict)
    assert body["operationName"] == "SignUpNewMemberMutation"
    assert "query" in body and "mutation SignUpNewMemberMutation" in body["query"]
    vars_ = body["variables"]
    # 核心字段
    assert vars_["card"] == {
        "cardNumber": "4242424242424242",
        "expirationDate": "12/2030",
        "securityCode": "123",
        "type": "VISA",
    }
    assert vars_["country"] == "US"
    assert vars_["email"] == "test.buyer@example.com"
    # firstName 必须按协议使用 "First Last" 拼接。
    assert vars_["firstName"] == "Test User"
    assert vars_["lastName"] == "User"
    assert vars_["phone"] == {
        "countryCode": "1",
        "number": "2025550142",
        "type": "MOBILE",
    }
    assert vars_["supportedThreeDsExperiences"] == ["IFRAME"]
    assert vars_["token"] == "EC-TEST-FIXTURE"
    # billingAddress 完整字段
    ba = vars_["billingAddress"]
    assert ba["line1"] == "123 Test Avenue"
    assert ba["line2"] == "Suite TEST-1"
    assert ba["city"] == "Testville"
    assert ba["state"] == "CA"
    assert ba["postalCode"] == "94105"
    assert ba["country"] == "US"
    assert ba["familyName"] == "User"
    assert ba["givenName"] == "Test User"
    assert ba["accountQuality"] == {"autoCompleteType": "MANUAL", "isUserModified": True}
    # shippingAddress 空字段但保留全部 keys
    sa = vars_["shippingAddress"]
    assert sa["line1"] == "" and sa["city"] == "" and sa["postalCode"] == ""
    assert sa["country"] == "US"
    assert sa["familyName"] == "User"
    assert sa["givenName"] == "Test User"
    assert sa["accountQuality"] == {"autoCompleteType": "MANUAL", "isUserModified": False}
    # 常量字段
    assert vars_["contentIdentifier"] == paypal_http.PAYPAL_SIGNUP_CONTENT_ID
    assert vars_["marketingOptOut"] is False
    assert vars_["crsData"] is None
    assert vars_["legalAgreements"] == {}
    assert vars_["password"] == "TEST_Password_123!"


def test_build_signup_request_rejects_missing_ec_token():
    with pytest.raises(ValueError):
        paypal_http.build_signup_request(**_make_signup_kwargs(ec_token=""))
    with pytest.raises(ValueError):
        paypal_http.build_signup_request(**_make_signup_kwargs(ec_token="not-an-ec-token"))


def test_paypal_signup_query_loaded_from_gql_file():
    """paypal_signup_query.gql 必须随包发布；否则 build_signup_request 会立即 ValueError。"""
    assert paypal_http.PAYPAL_SIGNUP_QUERY, "PAYPAL_SIGNUP_QUERY 未加载（gql 文件缺失）"
    assert "mutation SignUpNewMemberMutation" in paypal_http.PAYPAL_SIGNUP_QUERY
    # query 大小至少 4 KB，避免被意外截断
    assert len(paypal_http.PAYPAL_SIGNUP_QUERY) > 4000


# ---------- paypal_get_signup_page (HAR 真实流程的关键缺失步骤) -------------


class _StubSignupPageResp:
    """``GET /checkoutweb/signup`` 的响应 stub，带 ``cookies`` jar（``CookieJar``-like）。"""

    def __init__(
        self,
        *,
        url: str = "https://www.paypal.com/checkoutweb/signup?token=EC-A&ba_token=BA-X",
        status: int = 200,
        cookies: dict | None = None,
        text: str = "<!DOCTYPE html>...",
    ):
        self.url = url
        self.status_code = status
        self.text = text
        # 模拟 requests/curl_cffi 的 RequestsCookieJar：keys() 给 cookie 名
        self.cookies = _CookieJar(cookies or {})

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _CookieJar:
    """最简 RequestsCookieJar 替身——只支持 ``.keys()``（够 helper 用）。"""

    def __init__(self, data: dict):
        self._data = dict(data)

    def keys(self):
        return list(self._data.keys())


class _StubGetSession:
    """支持 ``.get()`` 的 session stub，记录调用参数。"""

    def __init__(self, resp: _StubSignupPageResp):
        self._resp = resp
        self.calls: list[dict] = []

    def get(self, url, *, headers=None, timeout=None, allow_redirects=None):
        self.calls.append({
            "url": url,
            "headers": dict(headers or {}),
            "timeout": timeout,
            "allow_redirects": allow_redirects,
        })
        return self._resp


def test_paypal_get_signup_page_uses_correct_url_and_returns_set_cookies():
    """``paypal_get_signup_page`` 应该 GET 正确的 ``/checkoutweb/signup?...`` URL，
    带 page-navigation header（Accept: text/html / Sec-Fetch-Mode: navigate），
    并把响应里 set 的 cookie 名以列表返回（用于上层 log 诊断）。

    HAR 实采的 PayPal SignUp 页响应里 set 这 11 个 cookie::

        ts_c, ts, x-pp-s, datadome, ddgl, l7_az, tsrce, LANG, enforce_policy

    这些是 PayPal 后续 GraphQL 调用的强校验项。helper 拿到 cookie names
    后上层日志 cookies_set=[...] 字段能直接显示是否拿到这些关键 cookie。
    """
    # 模拟 PayPal 实战响应里的 11 个 cookie（HAR 里实采的具体名字）
    real_cookies = {
        "ts": "<138>", "ts_c": "<77>", "x-pp-s": "<50>",
        "datadome": "<128>", "ddgl": "x", "l7_az": "<9>",
        "tsrce": "<17>", "LANG": "<10>", "enforce_policy": "ccpa",
    }
    resp = _StubSignupPageResp(cookies=real_cookies)
    session = _StubGetSession(resp)

    result = paypal_http.paypal_get_signup_page(
        session,
        ec_token="EC-TEST-FIXTURE",
        ba_token="BA-TEST-FIXTURE",
        referer="https://www.paypal.com/agreements/approve?ba_token=BA-TEST-FIXTURE",
        timeout=45,
    )

    # GET 调用参数
    assert len(session.calls) == 1
    call = session.calls[0]
    # URL 形态：``/checkoutweb/signup?...&token=...&ba_token=...&country.x=US&locale.x=en_US``
    assert call["url"].startswith("https://www.paypal.com/checkoutweb/signup?")
    assert "token=EC-TEST-FIXTURE" in call["url"]
    assert "ba_token=BA-TEST-FIXTURE" in call["url"]
    # Page-navigation header（PayPal WAF 看这些区分"页面访问"和"API 调用"）
    hdrs = call["headers"]
    assert "text/html" in hdrs.get("Accept", "")  # 不是 application/json
    assert hdrs.get("Sec-Fetch-Mode") == "navigate"
    assert hdrs.get("Sec-Fetch-Dest") == "document"
    assert hdrs.get("Upgrade-Insecure-Requests") == "1"
    # 上一步是 paypal_approve 落地页 → Referer 应当是 /agreements/approve URL
    assert hdrs["Referer"] == (
        "https://www.paypal.com/agreements/approve?ba_token=BA-TEST-FIXTURE"
    )
    assert call["allow_redirects"] is True
    assert call["timeout"] == 45

    # 返回值
    assert result["status_code"] == 200
    assert result["final_url"].startswith("https://www.paypal.com/checkoutweb/signup")
    # set_cookies 应包含 PayPal 真实下发的所有 11 项关键 cookie 名
    set_cookies = set(result["set_cookies"])
    expected = {"ts", "ts_c", "x-pp-s", "datadome", "ddgl", "l7_az",
                "tsrce", "LANG", "enforce_policy"}
    assert expected.issubset(set_cookies), (
        f"set_cookies 缺少关键 cookie: 缺={expected - set_cookies}, "
        f"实际={sorted(set_cookies)}"
    )


def test_paypal_get_signup_page_no_referer_falls_back_to_no_header():
    """不传 ``referer`` 时不应当生成空字符串 Referer header（避免 PayPal WAF
    把 ``Referer:`` 空头识别为异常请求）。"""
    resp = _StubSignupPageResp()
    session = _StubGetSession(resp)
    paypal_http.paypal_get_signup_page(
        session, ec_token="EC-A", ba_token="BA-X",
    )
    hdrs = session.calls[0]["headers"]
    assert "Referer" not in hdrs and "referer" not in hdrs


def test_paypal_get_signup_page_handles_missing_cookies_jar():
    """如果 response 没有 ``cookies`` 属性（极端的 mock / 老 lib），返回空列表，
    而不是 raise——helper 是非阻塞 best-effort 步骤。"""
    class _RawResp:
        url = "https://www.paypal.com/checkoutweb/signup?token=EC-A"
        status_code = 200
        text = "<!DOCTYPE html>"
        # 故意不设 .cookies 属性

        def raise_for_status(self):
            return None

    class _RawSession:
        def get(self, url, *, headers=None, timeout=None, allow_redirects=None):
            return _RawResp()

    result = paypal_http.paypal_get_signup_page(
        _RawSession(), ec_token="EC-A", ba_token="BA-X",
    )
    assert result["set_cookies"] == []
    assert result["status_code"] == 200


def test_paypal_post_signup_uses_correct_endpoint_and_headers():
    payload = {
        "errors": [{
            "message": "ISSUER_DECLINE",
            "errorData": {"0": {"code": "CARD_GENERIC_ERROR"}, "accessToken": "S23AAM_TEST"},
        }],
        "data": {"onboardAccount": None},
    }
    session = _StubJsonSession(payload)
    body = paypal_http.build_signup_request(**_make_signup_kwargs())

    resp = paypal_http.paypal_post_signup(
        session,
        body=body,
        ec_token="EC-TEST-FIXTURE",
        ba_token="BA-TEST-FIXTURE",
    )

    assert resp == payload
    call = session.calls[0]
    assert call["url"] == "https://www.paypal.com/graphql?SignUpNewMemberMutation"
    hdrs = call["headers"]
    # 核心 PayPal-specific headers
    assert hdrs["Content-Type"] == "application/json"
    assert hdrs["paypal-client-context"] == "EC-TEST-FIXTURE"
    assert hdrs["paypal-client-metadata-id"] == "EC-TEST-FIXTURE"
    # SignUp 默认 x-app-name 必须是 weasley A/B 桶（HAR 实采的成功 SignUp 都是
    # 这个后缀）。旧版 ``checkoutuinodeweb`` 会被 PayPal 风控拒签。
    assert hdrs["x-app-name"] == "checkoutuinodeweb_weasley"
    assert hdrs["x-country"] == "US"
    assert hdrs["x-locale"] == "en_US"
    assert hdrs["X-Requested-With"] == "fetch"
    assert hdrs["Origin"] == "https://www.paypal.com"
    # Referer 没传时应自动构造 /checkoutweb/signup?...
    referer = hdrs["Referer"]
    assert referer.startswith("https://www.paypal.com/checkoutweb/signup?")
    assert "token=EC-TEST-FIXTURE" in referer
    assert "ba_token=BA-TEST-FIXTURE" in referer


def test_paypal_post_signup_honors_explicit_referer():
    """如果调用方传 referer，header 应直接用它，不自动构造。"""
    session = _StubJsonSession({"data": {}})
    body = paypal_http.build_signup_request(**_make_signup_kwargs())
    paypal_http.paypal_post_signup(
        session,
        body=body,
        ec_token="EC-A",
        referer="https://www.paypal.com/agreements/approve?ba_token=BA-Z",
    )
    assert session.calls[0]["headers"]["Referer"] == (
        "https://www.paypal.com/agreements/approve?ba_token=BA-Z"
    )


def test_paypal_post_signup_rejects_invalid_body():
    with pytest.raises(ValueError):
        paypal_http.paypal_post_signup(_StubJsonSession({}), body={}, ec_token="EC-X")
    with pytest.raises(ValueError):
        paypal_http.paypal_post_signup(_StubJsonSession({}), body="not-a-dict", ec_token="EC-X")  # type: ignore[arg-type]


def test_paypal_post_signup_rejects_non_dict_response():
    """非 dict JSON 响应（数组 / null / int）应当抛 :class:`PaypalSignupResponseError`，
    而不是裸 ``ValueError``——保持与 HTML 拒绝路径同款诊断字段。"""
    session = _StubJsonSession([1, 2, 3])  # 数组而不是 dict
    body = paypal_http.build_signup_request(**_make_signup_kwargs())
    with pytest.raises(paypal_http.PaypalSignupResponseError) as excinfo:
        paypal_http.paypal_post_signup(session, body=body, ec_token="EC-A")
    # cause 是原始的 ValueError（"响应不是非空 dict"）
    assert isinstance(excinfo.value.cause, ValueError)


def test_paypal_post_signup_raises_typed_error_on_html_response():
    """**协议模式实战回归**：PayPal 用 HTML 风控页 / 200+text/html 拒绝 SignUp 时，
    应当抛 :class:`PaypalSignupResponseError` 携带 ``status / content-type /
    paypal-debug-id / text_512`` 四元组，而不是早期版本的裸 ``JSONDecodeError(
    "unexpected character: line 1 column 1 (char 0)")``——后者会让上层日志只剩
    "OTP 子链 pool[0] 失败: unexpected character"，丢失所有诊断信息，没法反查。

    Sanitized failure-response fixture shape:
    ``status=200, content-type=text/html, body=<!DOCTYPE html>...``。
    """

    class _HtmlResp:
        status_code = 200
        text = (
            "<!DOCTYPE html>\n<html><head><title>PayPal</title></head>"
            "<body><script src=\"https://www.paypalobjects.com/pa/js/pa.js\">"
            "</script></body></html>"
        )
        headers = {
            "content-type": "text/html; charset=utf-8",
            "paypal-debug-id": "f2514256c2bd1",
        }

        def raise_for_status(self):
            return None

        def json(self):
            raise ValueError("Expecting value: line 1 column 1 (char 0)")

    class _HtmlSession:
        def __init__(self):
            self.calls = []

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "headers": dict(headers or {})})
            return _HtmlResp()

    session = _HtmlSession()
    body = paypal_http.build_signup_request(**_make_signup_kwargs())
    with pytest.raises(paypal_http.PaypalSignupResponseError) as excinfo:
        paypal_http.paypal_post_signup(session, body=body, ec_token="EC-A")
    exc = excinfo.value
    assert exc.status == 200
    assert "text/html" in exc.content_type
    assert exc.paypal_debug_id == "f2514256c2bd1"
    assert "<!DOCTYPE html>" in exc.text
    assert "pa.js" in exc.text
    # cause 链回到原始的 JSONDecode-style ValueError
    assert isinstance(exc.cause, ValueError)


def test_paypal_post_signup_raises_typed_error_on_http_4xx():
    """4xx HTTP 错应当也抛 :class:`PaypalSignupResponseError`（不是裸 HTTPError）。

    与 HTML 拒绝路径走同款异常类型，让上层只用 catch 一种异常就能 dump 诊断。
    """

    class _BadResp:
        status_code = 401
        text = '{"errors":[{"message":"Unauthorized"}]}'
        headers = {
            "content-type": "application/json",
            "paypal-debug-id": "deadbeef401",
        }

        def raise_for_status(self):
            raise RuntimeError("401 Client Error: Unauthorized")

        def json(self):
            return {"errors": [{"message": "Unauthorized"}]}

    class _BadSession:
        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            return _BadResp()

    body = paypal_http.build_signup_request(**_make_signup_kwargs())
    with pytest.raises(paypal_http.PaypalSignupResponseError) as excinfo:
        paypal_http.paypal_post_signup(_BadSession(), body=body, ec_token="EC-A")
    exc = excinfo.value
    assert exc.status == 401
    assert exc.paypal_debug_id == "deadbeef401"
    assert "Unauthorized" in exc.text


def test_parse_signup_access_token_from_error_path():
    """HAR 实采路径：卡 decline 但 errorData 里给 accessToken。"""
    payload = {
        "errors": [{
            "message": "ISSUER_DECLINE",
            "errorData": {
                "0": {"field": "cardNumber", "code": "CARD_GENERIC_ERROR"},
                "accessToken": "S23AAM_TEST_ACCESS",
            },
        }],
        "data": {"onboardAccount": None},
    }
    assert paypal_http.parse_signup_access_token(payload) == "S23AAM_TEST_ACCESS"


def test_parse_signup_access_token_from_data_path():
    """卡片真过的兜底路径：data.signUpNewMember.accessToken。"""
    payload = {
        "errors": None,
        "data": {"signUpNewMember": {"accessToken": "S23AAP_REAL_ACCESS"}},
    }
    assert paypal_http.parse_signup_access_token(payload) == "S23AAP_REAL_ACCESS"


def test_parse_signup_access_token_raises_when_missing():
    """response 完全没 accessToken 时抛 ValueError，调用方负责标 fallback。"""
    with pytest.raises(ValueError):
        paypal_http.parse_signup_access_token({"errors": [], "data": {}})
    with pytest.raises(ValueError):
        paypal_http.parse_signup_access_token({"data": {"signUpNewMember": {}}})
    with pytest.raises(ValueError):
        paypal_http.parse_signup_access_token({"errors": [{"message": "boom"}], "data": {}})


def test_parse_signup_access_token_rejects_non_dict_input():
    with pytest.raises(ValueError):
        paypal_http.parse_signup_access_token("not a dict")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        paypal_http.parse_signup_access_token([])  # type: ignore[arg-type]


# ----- Stage P7-OTP: Initiate ------------------------------------------------


def test_build_otp_initiate_request_matches_protocol_layout():
    """variables 严格按协议字段排列，值使用纯合成 fixture。"""
    body = paypal_http.build_otp_initiate_request(
        ec_token="EC-TEST-OTP",
        phone_number_local="2025550142",
        phone_country="US",
    )
    assert body["operationName"] == "InitiateRiskBasedTwoFactorPhoneConfirmationMutation"
    assert "mutation InitiateRiskBasedTwoFactorPhoneConfirmation" in body["query"]
    vars_ = body["variables"]
    assert vars_["locale"] == {"country": "US", "lang": "en"}
    assert vars_["phoneCountry"] == "US"
    # 协议字段使用不带国家码的 10 位本地号。
    assert vars_["phoneNumber"] == "2025550142"
    assert vars_["token"] == "EC-TEST-OTP"


def test_build_otp_initiate_request_validates_inputs():
    """ec_token 非 EC- 前缀、phone_number 非纯数字 → ValueError。"""
    with pytest.raises(ValueError):
        paypal_http.build_otp_initiate_request(ec_token="", phone_number_local="2025550142")
    with pytest.raises(ValueError):
        paypal_http.build_otp_initiate_request(ec_token="bogus", phone_number_local="2025550142")
    with pytest.raises(ValueError):
        paypal_http.build_otp_initiate_request(ec_token="EC-A", phone_number_local="")
    with pytest.raises(ValueError):
        paypal_http.build_otp_initiate_request(ec_token="EC-A", phone_number_local="+1656228")


def test_paypal_post_otp_initiate_uses_correct_endpoint_and_headers():
    payload = {"data": {"initiateRiskBasedTwoFactorPhoneConfirmation": {
        "authId": "TEST_AUTH_ID",
        "challengeId": "TEST_CHALLENGE_ID",
        "state": "PENDING",
    }}}
    session = _StubJsonSession(payload)
    body = paypal_http.build_otp_initiate_request(
        ec_token="EC-A", phone_number_local="2025550142",
    )
    resp = paypal_http.paypal_post_otp_initiate(
        session, body=body, ec_token="EC-A", ba_token="BA-X",
    )
    assert resp == payload
    call = session.calls[0]
    assert call["url"] == "https://www.paypal.com/graphql?InitiateRiskBasedTwoFactorPhoneConfirmationMutation"
    hdrs = call["headers"]
    assert hdrs["paypal-client-context"] == "EC-A"
    assert hdrs["paypal-client-metadata-id"] == "EC-A"
    # OTP initiate 默认也是 weasley（HAR）
    assert hdrs["x-app-name"] == "checkoutuinodeweb_weasley"
    assert hdrs["Referer"].startswith("https://www.paypal.com/checkoutweb/signup?")


def test_parse_otp_initiate_response_extracts_auth_challenge_state():
    payload = {"data": {"initiateRiskBasedTwoFactorPhoneConfirmation": {
        "authId": "AID-1", "challengeId": "CID-1", "state": "PENDING",
    }}}
    auth_id, challenge_id, state = paypal_http.parse_otp_initiate_response(payload)
    assert (auth_id, challenge_id, state) == ("AID-1", "CID-1", "PENDING")


def test_parse_otp_initiate_response_raises_when_ids_missing():
    """字段缺失或为 null → ValueError，且把可能的 errors 信息带回。"""
    with pytest.raises(ValueError) as exc:
        paypal_http.parse_otp_initiate_response({"data": {"initiateRiskBasedTwoFactorPhoneConfirmation": {
            "authId": None, "challengeId": None, "state": "DENIED",
        }}, "errors": [{"message": "PHONE_INVALID"}]})
    assert "PHONE_INVALID" in str(exc.value)
    with pytest.raises(ValueError):
        paypal_http.parse_otp_initiate_response({})


# ----- Stage P7-OTP: Confirm -------------------------------------------------


def test_build_otp_confirm_request_matches_protocol_layout():
    body = paypal_http.build_otp_confirm_request(
        ec_token="EC-TEST-OTP",
        auth_id="TEST_AUTH_ID",
        challenge_id="TEST_CHALLENGE_ID",
        pin="000000",
    )
    assert body["operationName"] == "ConfirmRiskBasedTwoFactorPhoneConfirmationMutation"
    assert "mutation ConfirmRiskBasedTwoFactorPhoneConfirmation" in body["query"]
    vars_ = body["variables"]
    assert vars_ == {
        "authId": "TEST_AUTH_ID",
        "challengeId": "TEST_CHALLENGE_ID",
        "pin": "000000",
        "token": "EC-TEST-OTP",
    }


def test_build_otp_confirm_request_validates_inputs():
    with pytest.raises(ValueError):
        paypal_http.build_otp_confirm_request(
            ec_token="", auth_id="x", challenge_id="y", pin="000000",
        )
    with pytest.raises(ValueError):
        paypal_http.build_otp_confirm_request(
            ec_token="EC-A", auth_id="", challenge_id="y", pin="000000",
        )
    with pytest.raises(ValueError):
        paypal_http.build_otp_confirm_request(
            ec_token="EC-A", auth_id="x", challenge_id="y", pin="abc",
        )
    with pytest.raises(ValueError):  # 太长
        paypal_http.build_otp_confirm_request(
            ec_token="EC-A", auth_id="x", challenge_id="y", pin="123456789",
        )


def test_paypal_post_otp_confirm_uses_correct_endpoint_and_headers():
    payload = {"data": {"confirmRiskBasedTwoFactorPhoneConfirmation": {
        "authId": None, "challengeId": None, "state": "CONFIRMED",
    }}}
    session = _StubJsonSession(payload)
    body = paypal_http.build_otp_confirm_request(
        ec_token="EC-A", auth_id="AID-1", challenge_id="CID-1", pin="000000",
    )
    paypal_http.paypal_post_otp_confirm(
        session, body=body, ec_token="EC-A", ba_token="BA-X",
    )
    call = session.calls[0]
    assert call["url"] == "https://www.paypal.com/graphql?ConfirmRiskBasedTwoFactorPhoneConfirmationMutation"
    assert call["headers"]["paypal-client-context"] == "EC-A"


def test_parse_otp_confirm_response_returns_confirmed():
    payload = {"data": {"confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "CONFIRMED"}}}
    assert paypal_http.parse_otp_confirm_response(payload) == "CONFIRMED"


def test_parse_otp_confirm_response_raises_when_not_confirmed():
    """state 不是 CONFIRMED（如 DENIED / EXPIRED / null）→ ValueError 带 first_error。"""
    with pytest.raises(ValueError) as exc:
        paypal_http.parse_otp_confirm_response({
            "data": {"confirmRiskBasedTwoFactorPhoneConfirmation": {"state": "DENIED"}},
            "errors": [{"message": "PIN_INCORRECT"}],
        })
    assert "DENIED" in str(exc.value)
    assert "PIN_INCORRECT" in str(exc.value)

    with pytest.raises(ValueError):
        paypal_http.parse_otp_confirm_response({"data": {}})

    with pytest.raises(ValueError):
        paypal_http.parse_otp_confirm_response({})


# ---------- paypal-client-metadata-id (CMID) 风险控制 -------------------------


def test_generate_paypal_cmid_returns_32_hex_and_is_random():
    """``generate_paypal_cmid`` 应当返回 32 字节 hex 字符串，且每次调用都不同。"""
    a = paypal_http.generate_paypal_cmid()
    b = paypal_http.generate_paypal_cmid()
    assert isinstance(a, str) and isinstance(b, str)
    assert len(a) == 32 and len(b) == 32
    assert all(ch in "0123456789abcdef" for ch in a)
    assert all(ch in "0123456789abcdef" for ch in b)
    # 概率上应当不同（碰撞概率 1/2^128）
    assert a != b


def test_paypal_post_weasley_logger_targets_correct_endpoint_and_app_name():
    """``paypal_post_weasley_logger`` 必须 POST 到 ``/xoplatform/logger/api/logger/`` 并带
    ``x-app-name: checkoutuinodeweb_weasley``。返回值反映 HTTP 状态码 2xx。"""
    captured: dict = {}

    class _Resp:
        status_code = 200
        text = '{"ok":1}'
        headers = {"Content-Type": "application/json"}

    class _Session:
        def post(self, url, *, json=None, headers=None, timeout=None):  # noqa: A002
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = dict(headers or {})
            return _Resp()

    ok = paypal_http.paypal_post_weasley_logger(_Session(), referer="https://x")
    assert ok is True
    assert captured["url"].endswith("/xoplatform/logger/api/logger/")
    # 关键校验：x-app-name 必须是 checkoutuinodeweb_weasley，否则 PayPal 不会
    # Set-Cookie tsrce=checkoutuinodeweb_weasley
    assert captured["headers"]["x-app-name"] == "checkoutuinodeweb_weasley"
    assert captured["headers"]["Origin"] == "https://www.paypal.com"
    # body 必须是 metrics 数组结构，HAR 实采 1:1
    body = captured["json"]
    assert isinstance(body, dict) and "metrics" in body
    assert body["metrics"][0]["dimensions"]["clientApp"] == "weasley"
    assert body["metrics"][0]["dimensions"]["interaction"] == "start_application"


def test_paypal_post_weasley_logger_returns_false_on_5xx_without_raising():
    """非阻塞契约：5xx 时 logger 不抛，返回 False（保留旧行为，不中断 OTP 流程）。"""
    class _Resp:
        status_code = 503
        text = ""
        headers = {}

    class _Session:
        def post(self, *_a, **_k):  # noqa: ANN002, ANN003
            return _Resp()

    assert paypal_http.paypal_post_weasley_logger(_Session(), referer="https://x") is False


def test_paypal_post_weasley_logger_returns_false_on_exception():
    """网络异常也不抛——同样契约：尽力而为，失败继续。"""
    class _Session:
        def post(self, *_a, **_k):  # noqa: ANN002, ANN003
            raise RuntimeError("network down")

    assert paypal_http.paypal_post_weasley_logger(_Session(), referer="https://x") is False


def test_generate_otp_challenge_tokens_returns_88_chars_each_independent():
    """``generate_otp_challenge_tokens`` 应返回两个 88 字符 base64url-like token，
    且两次调用 / 一次调用内的 csrfNonce vs ctxId 互不相同（防止把同一随机值
    复用两次）。HAR 实采里 PayPal 接受的 ``csrfNonce`` 都长这样：88 字符、
    前导 ``AA``、字符集 ``A-Za-z0-9_-``。"""
    csrf, ctx = paypal_http.generate_otp_challenge_tokens()
    assert isinstance(csrf, str) and isinstance(ctx, str)
    assert len(csrf) == 88 and len(ctx) == 88
    assert csrf.startswith("AA") and ctx.startswith("AA")
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    assert all(ch in allowed for ch in csrf)
    assert all(ch in allowed for ch in ctx)
    # 同一次调用里 csrf 与 ctx 应当独立随机
    assert csrf != ctx
    # 两次调用之间也应该不同（碰撞概率 1/2^(8*64)）
    csrf2, ctx2 = paypal_http.generate_otp_challenge_tokens()
    assert csrf != csrf2 and ctx != ctx2


def test_paypal_post_signup_uses_explicit_cmid_when_provided():
    """显式传 ``client_metadata_id`` 时 header 应使用该值，而**不是** ec_token。

    这是协议模式绕过 PayPal OAS_ERROR (createMemberAccount) 的关键修复点。
    """
    session = _StubJsonSession({"data": {"onboardAccount": None}})
    body = paypal_http.build_signup_request(**_make_signup_kwargs())
    explicit_cmid = "abcdef1234567890fedcba0987654321"

    paypal_http.paypal_post_signup(
        session,
        body=body,
        ec_token="EC-TEST-FIXTURE",
        ba_token="BA-TEST-FIXTURE",
        client_metadata_id=explicit_cmid,
    )

    hdrs = session.calls[0]["headers"]
    assert hdrs["paypal-client-metadata-id"] == explicit_cmid
    # paypal-client-context 仍然是 ec_token（这部分不变）
    assert hdrs["paypal-client-context"] == "EC-TEST-FIXTURE"
    # 关键反向断言：cmid 不再是 ec_token（消除 cmid==ec_token 字面相同的风控特征）
    assert hdrs["paypal-client-metadata-id"] != hdrs["paypal-client-context"]


def test_paypal_post_signup_falls_back_to_ec_token_when_cmid_omitted():
    """不传 ``client_metadata_id`` 时仍 fallback 到 ec_token，保持向后兼容。

    避免破坏老调用 / 已有测试，但协议模式应当总是显式传 cmid。
    """
    session = _StubJsonSession({"data": {"onboardAccount": None}})
    body = paypal_http.build_signup_request(**_make_signup_kwargs())

    paypal_http.paypal_post_signup(
        session, body=body, ec_token="EC-TEST-FIXTURE", ba_token="BA-X",
    )

    hdrs = session.calls[0]["headers"]
    assert hdrs["paypal-client-metadata-id"] == "EC-TEST-FIXTURE"


# ---------- OTP_CHALLENGE 预热 -----------------------------------------------


def test_extract_otp_csrf_nonce_and_ctx_id_from_react_server_component():
    """落地 HTML 里 React Server Component 序列化里的 csrfNonce / ctxId 应当能抽。"""
    html = (
        '<script>self.__next_f.push([1,'
        '"...\\"csrfNonce\\":\\"AAH9_TEST_CSRF_NONCE_0001\\",'
        '\\"ctxId\\":\\"AAEH_TEST_CONTEXT_ID_0001\\",..."])</script>'
    )
    assert paypal_http.extract_otp_csrf_nonce(html) == "AAH9_TEST_CSRF_NONCE_0001"
    assert paypal_http.extract_otp_ctx_id(html) == "AAEH_TEST_CONTEXT_ID_0001"


def test_extract_otp_csrf_nonce_returns_empty_when_not_found():
    """没找到时返回空字符串（不抛异常），便于 OTP 子链 fallback。"""
    assert paypal_http.extract_otp_csrf_nonce("<html></html>") == ""
    assert paypal_http.extract_otp_ctx_id("<html></html>") == ""


def test_build_otp_challenge_request_matches_har_field_layout():
    body = paypal_http.build_otp_challenge_request(
        ec_token="EC-TEST-OTP",
        email="buyer@example.com",
        csrf_nonce="AAH9_TEST_CSRF_NONCE_0001",
        ctx_id="AAEH_TEST_CONTEXT_ID_0001",
        timestamp_ms=1779549520070,
    )
    assert body["operationName"] == "getOtpChallengeOperation"
    assert body["query"] == ""
    assert body["csrfNonce"] == "AAH9_TEST_CSRF_NONCE_0001"
    ci = body["variables"]["clientInfo"]
    assert ci["fnId"] == "EC-TEST-OTP"
    assert ci["ctxId"] == "AAEH_TEST_CONTEXT_ID_0001"
    # rData 是 url-encoded 的 JSON，里面应包含 fn_sync_data
    assert "fn_sync_data" in ci["rData"]
    assert "EC-TEST-OTP" in ci["rData"]  # ec_token 应嵌入指纹
    cred = body["variables"]["credentials"]
    assert cred["credentialValue"] == "buyer@example.com"
    assert cred["credentialType"] == "EMAIL"
    assert body["variables"]["challengeInfo"] == {"autoSmsOtp": False}
    # 顶层 fn_sync_data 也存在（HAR 里有这个字段）
    assert "fn_sync_data" in body


def test_build_otp_challenge_request_rejects_missing_csrf_nonce_or_ctx_id():
    common = dict(
        ec_token="EC-A", email="a@b.com",
    )
    with pytest.raises(ValueError):
        paypal_http.build_otp_challenge_request(**common, csrf_nonce="", ctx_id="X")
    with pytest.raises(ValueError):
        paypal_http.build_otp_challenge_request(**common, csrf_nonce="Y", ctx_id="")


def test_paypal_post_otp_challenge_uses_correct_endpoint_and_origin():
    payload = {"data": {"otp": {"getOtpChallenge": {
        "publicCredential": None, "nonce": None, "isPomaUser": None,
        "countryCode": None, "challenges": None,
    }}}}
    session = _StubJsonSession(payload)
    body = paypal_http.build_otp_challenge_request(
        ec_token="EC-A", email="a@b.com",
        csrf_nonce="NONCE1", ctx_id="CTX1",
    )
    resp = paypal_http.paypal_post_otp_challenge(
        session, body=body,
        referer="https://www.paypal.com/checkoutweb/signup?token=EC-A",
    )
    assert resp == payload
    call = session.calls[0]
    assert call["url"] == "https://www.paypal.com/idapps/graphql"
    hdrs = call["headers"]
    assert hdrs["Content-Type"] == "application/json"
    assert hdrs["X-Requested-With"] == "fetch"
    assert hdrs["Origin"] == "https://www.paypal.com"
    # 关键回归断言：``/idapps/graphql`` 必须**不带** Referer，否则 PayPal 会把
    # 请求识别为页面访问返回 HTML 容器（content-type=text/html），客户端
    # JSONDecodeError + 后续 OTP-Confirm 报 VALIDATION_FAILED。
    assert "Referer" not in hdrs, f"OTP_CHALLENGE 不应带 Referer: {hdrs!r}"
    assert "referer" not in hdrs, f"OTP_CHALLENGE 不应带 referer: {hdrs!r}"


def test_paypal_post_otp_challenge_raises_typed_error_on_non_json_response():
    """PayPal 返回 HTML 时应抛 ``PaypalOtpChallengeRejected``，并带上 status /
    content-type / paypal-debug-id / text_512 摘要（用户日志里的诊断数据）。

    实采的失败响应：``status=200, content-type=text/html``，body 是
    ``<!DOCTYPE html>...<script src=pa.js>...``。"""

    class _HtmlResp:
        status_code = 200
        text = "<!DOCTYPE html>\n<script src=\"https://www.paypalobjects.com/pa/js/pa.js\"></script>"
        headers = {"content-type": "text/html; charset=utf-8", "paypal-debug-id": "f222073d00a00"}

        def raise_for_status(self):
            return None

        def json(self):
            raise ValueError("Expecting value: line 1 column 1 (char 0)")

    class _HtmlSession:
        def __init__(self):
            self.calls = []

        def post(self, url, *, json=None, headers=None, timeout=None, data=None):
            self.calls.append({"url": url, "headers": dict(headers or {})})
            return _HtmlResp()

    session = _HtmlSession()
    body = paypal_http.build_otp_challenge_request(
        ec_token="EC-A", email="a@b.com", csrf_nonce="N1", ctx_id="X1",
    )
    with pytest.raises(paypal_http.PaypalOtpChallengeRejected) as excinfo:
        paypal_http.paypal_post_otp_challenge(session, body=body, referer="")
    exc = excinfo.value
    assert exc.status == 200
    assert "text/html" in exc.content_type
    assert exc.paypal_debug_id == "f222073d00a00"
    assert "<!DOCTYPE html>" in exc.text
    assert "pa.js" in exc.text


def test_paypal_post_otp_initiate_and_confirm_share_explicit_cmid():
    """OTP initiate 和 confirm 都应当接收同一个显式 cmid，模拟浏览器内 SDK
    在 session 内复用同一个设备指纹 ID 的行为。"""
    cmid = paypal_http.generate_paypal_cmid()

    init_session = _StubJsonSession({"data": {"initiateRiskBasedTwoFactorPhoneConfirmation": {
        "authId": "A1", "challengeId": "C1", "state": "PENDING",
    }}})
    paypal_http.paypal_post_otp_initiate(
        init_session,
        body=paypal_http.build_otp_initiate_request(ec_token="EC-A", phone_number_local="2025550142"),
        ec_token="EC-A",
        ba_token="BA-X",
        client_metadata_id=cmid,
    )
    assert init_session.calls[0]["headers"]["paypal-client-metadata-id"] == cmid

    confirm_session = _StubJsonSession({"data": {"confirmRiskBasedTwoFactorPhoneConfirmation": {
        "authId": None, "challengeId": None, "state": "CONFIRMED",
    }}})
    paypal_http.paypal_post_otp_confirm(
        confirm_session,
        body=paypal_http.build_otp_confirm_request(
            ec_token="EC-A", auth_id="A1", challenge_id="C1", pin="123456",
        ),
        ec_token="EC-A",
        ba_token="BA-X",
        client_metadata_id=cmid,
    )
    assert confirm_session.calls[0]["headers"]["paypal-client-metadata-id"] == cmid
