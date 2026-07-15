"""``stripe_http`` 错误处理回归测试。

历史 bug：Stripe ``/confirm`` 返回 HTTP 400 时，``raise_for_status`` 默认抛
``HTTPError("HTTP Error 400: ")`` —— **响应 body 完全丢失**，协议模式 stage
日志只能看到 ``/confirm 失败: HTTP Error 400:`` 这种空错误，根本无从定位。

修复：``_request`` 拦截 ``raise_for_status`` 抛 :class:`StripeHttpError`，把
``status / request-id / body 前 1KB`` 包进异常 message。本文件验证：

* 4xx 时抛 ``StripeHttpError``（不是 ``HTTPError``）
* 异常 message / 属性 暴露 status / body / request-id
* 200 但 JSON 解析失败也走同一条诊断路径
"""

from __future__ import annotations

import pytest

from platforms.chatgpt import stripe_http


class _StubResp:
    def __init__(self, *, status_code: int, text: str, headers: dict, json_obj=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers
        self._json = json_obj

    def raise_for_status(self):
        if 400 <= self.status_code < 600:
            import urllib.error
            raise urllib.error.HTTPError(
                url="https://api.stripe.com/test", code=self.status_code,
                msg=f"HTTP Error {self.status_code}: ", hdrs=None, fp=None,  # type: ignore[arg-type]
            )

    def json(self):
        if self._json is not None:
            return self._json
        # 模拟非 JSON body 时 .json() 抛 ValueError
        raise ValueError("Expecting value: line 1 column 1 (char 0)")


class _StubSession:
    def __init__(self, resp: _StubResp):
        self.resp = resp
        self.calls = []

    def post(self, url, *, data=None, headers=None):
        self.calls.append({"method": "POST", "url": url, "data": data})
        return self.resp

    def get(self, url, *, params=None, headers=None):
        self.calls.append({"method": "GET", "url": url, "params": params})
        return self.resp


def test_stripe_post_400_raises_typed_error_with_body_and_request_id():
    """Stripe 400 时应抛 ``StripeHttpError``，message 暴露 status / body / request-id。"""
    body = (
        '{"error":{"code":"payment_intent_unexpected_state",'
        '"message":"The PaymentIntent has an invalid status.",'
        '"type":"invalid_request_error"}}'
    )
    resp = _StubResp(
        status_code=400, text=body,
        headers={"request-id": "req_abc123XYZ", "Content-Type": "application/json"},
    )
    session = _StubSession(resp)
    with pytest.raises(stripe_http.StripeHttpError) as excinfo:
        stripe_http._post(session, "https://api.stripe.com/v1/payment_pages/cs_X/confirm", {"k": "v"})
    err = excinfo.value
    assert err.status == 400
    assert err.request_id == "req_abc123XYZ"
    assert "payment_intent_unexpected_state" in err.body_preview
    # message（即 str(err)）必须把 status / request-id / body preview 全部包含进来，
    # 这是协议模式 stage 日志显示的最终内容。
    msg = str(err)
    assert "status=400" in msg
    assert "req_abc123XYZ" in msg
    assert "payment_intent_unexpected_state" in msg


def test_stripe_post_200_json_decode_error_also_reports_body():
    """Stripe 返回 200 但 body 非 JSON（如 HTML 错误页）时也应抛 ``StripeHttpError``，
    带 body 前缀，方便定位被 CDN/WAF 拦截的场景。"""
    resp = _StubResp(
        status_code=200, text="<!DOCTYPE html><html>blocked by waf</html>",
        headers={"Content-Type": "text/html"},
    )
    session = _StubSession(resp)
    with pytest.raises(stripe_http.StripeHttpError) as excinfo:
        stripe_http._post(session, "https://api.stripe.com/v1/payment_pages/cs_X/init", {"k": "v"})
    err = excinfo.value
    assert err.status == 200
    assert "<!DOCTYPE html>" in err.body_preview
    assert "blocked by waf" in err.body_preview


def test_stripe_get_403_raises_typed_error():
    """``_get`` 也应当走同一条诊断路径。"""
    resp = _StubResp(
        status_code=403, text='{"error":{"code":"forbidden"}}',
        headers={"request-id": "req_get_xyz"},
    )
    session = _StubSession(resp)
    with pytest.raises(stripe_http.StripeHttpError) as excinfo:
        stripe_http._get(session, "https://api.stripe.com/v1/payment_pages/cs_X")
    assert excinfo.value.status == 403
    assert excinfo.value.request_id == "req_get_xyz"


def test_extract_expected_amount_prefers_elements_options_amount():
    """``extract_expected_amount`` 应优先从 ``elements_options.amount`` 取值。

    HAR 实采 entry init 响应里 ``elements_options.amount`` 与 ``invoice.total``
    都是 ``0`` (100% off coupon)。但**非 trial 资格的账号**这两个会是 ``2000``
    (=$20)。/confirm 必须传相同值，否则 Stripe 报 ``checkout_amount_mismatch``。
    """
    # 标准路径：elements_options.amount 取胜
    assert stripe_http.extract_expected_amount({
        "elements_options": {"amount": 2000, "currency": "usd"},
        "invoice": {"total": 0, "amount_due": 0},
    }) == "2000"
    # elements_options.amount = 0 仍是合法值（trial 100% off）
    assert stripe_http.extract_expected_amount({
        "elements_options": {"amount": 0},
        "invoice": {"total": 0},
    }) == "0"


def test_extract_expected_amount_falls_back_to_invoice_amount_due():
    """``elements_options.amount`` 缺失时 fallback 到 ``invoice.amount_due``。"""
    assert stripe_http.extract_expected_amount({
        "invoice": {"amount_due": 1500, "total": 2000},
    }) == "1500"
    # amount_due 缺失再 fallback 到 total
    assert stripe_http.extract_expected_amount({
        "invoice": {"total": 2000},
    }) == "2000"


def test_extract_expected_amount_returns_zero_when_missing():
    """所有候选字段都缺失时返回 ``"0"``，保留旧行为不破坏 trial 路径。"""
    assert stripe_http.extract_expected_amount({}) == "0"
    assert stripe_http.extract_expected_amount(None) == "0"  # type: ignore[arg-type]
    assert stripe_http.extract_expected_amount({"invoice": {}}) == "0"


def test_extract_confirm_expected_amounts_handles_billing_cycle_anchor():
    """Direct confirm should mirror the target extractor's BCA amount split."""
    expected_amount, expected_amount_on_bca = stripe_http.extract_confirm_expected_amounts(
        {
            "total_summary": {"due": 0, "total": 2000, "subtotal": 2000},
            "line_item_group": {"total": 2000},
            "invoice": {
                "amount_due": 2000,
                "billing_cycle_anchor": "2026-07-09T00:00:00Z",
                "has_prorations": False,
            },
        },
        fallback_amount="2000",
    )

    assert expected_amount == "0"
    assert expected_amount_on_bca == "2000"


def test_stripe_confirm_paypal_uses_caller_supplied_expected_amount():
    """``stripe_confirm_paypal`` 必须把 caller 传入的 ``expected_amount`` 写到
    request body 的 ``expected_amount`` 字段——不是硬编码 ``"0"``。"""
    resp = _StubResp(
        status_code=200, text='{"setup_intent":{"next_action":{"redirect_to_url":{"url":"https://x"}}}}',
        headers={"Content-Type": "application/json"},
        json_obj={"setup_intent": {"next_action": {"redirect_to_url": {"url": "https://x"}}}},
    )
    session = _StubSession(resp)
    device = stripe_http.StripeDeviceContext()
    stripe_http.stripe_confirm_paypal(
        session,
        cs_id="cs_test_X",
        payment_method_id="pm_X",
        init_checksum="ck_X",
        device=device,
        expected_amount="2000",
    )
    body = session.calls[0]["data"]
    assert body["expected_amount"] == "2000"


def test_stripe_confirm_paypal_direct_posts_payment_method_data():
    """Direct confirm should match the target extractor path and avoid creating pm_xxx first."""
    resp = _StubResp(
        status_code=200,
        text='{"setup_intent":{"next_action":{"redirect_to_url":{"url":"https://pm-redirects.stripe.com/authorize/x"}}}}',
        headers={"Content-Type": "application/json"},
        json_obj={"setup_intent": {"next_action": {"redirect_to_url": {"url": "https://pm-redirects.stripe.com/authorize/x"}}}},
    )
    session = _StubSession(resp)

    stripe_http.stripe_confirm_paypal_direct(
        session,
        cs_id="cs_test_X",
        init_checksum="ck_X",
        email="user@example.com",
        address={
            "country": "US",
            "line1": "350 5th Ave",
            "line2": "New York",
            "city": "New York",
            "postal_code": "10001",
            "state": "NY",
        },
        return_url="https://pay.openai.com/c/pay/cs_test_X?redirect_pm_type=paypal&ui_mode=hosted",
        expected_amount="0",
        expected_amount_on_bca="2000",
        displayed_amounts={
            "subtotal": "2000",
            "total_exclusive_tax": "0",
            "total_inclusive_tax": "0",
            "total_discount_amount": "2000",
            "shipping_rate_amount": "0",
        },
    )

    body = session.calls[0]["data"]
    assert body["payment_method_data[type]"] == "paypal"
    assert "payment_method" not in body
    assert body["payment_method_data[billing_details][email]"] == "user@example.com"
    assert body["payment_method_data[billing_details][address][country]"] == "US"
    assert body["payment_method_data[billing_details][address][line2]"] == "New York"
    assert body["expected_amount"] == "0"
    assert body["expected_amount_on_bca"] == "2000"
    assert body["last_displayed_line_item_group_details[subtotal]"] == "2000"


def test_extract_paypal_redirect_url_scans_top_level_next_action():
    resp = {
        "next_action": {
            "redirect_to_url": {
                "url": "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
                "return_url": "https://pay.openai.com/c/pay/cs_live_abc?redirect_pm_type=paypal",
            }
        }
    }

    redirect_url, return_url = stripe_http.extract_paypal_redirect_url(resp)

    assert redirect_url.startswith("https://pm-redirects.stripe.com/authorize/")
    assert return_url.startswith("https://pay.openai.com/c/pay/cs_live_abc")


def test_stripe_post_success_200_returns_json_payload():
    """成功路径不应受影响：200 + 合法 JSON 应直接返回 dict。"""
    payload = {"id": "pi_123", "status": "succeeded"}
    resp = _StubResp(status_code=200, text='{"id":"pi_123","status":"succeeded"}',
                     headers={"Content-Type": "application/json"}, json_obj=payload)
    session = _StubSession(resp)
    result = stripe_http._post(session, "https://api.stripe.com/v1/x", {"k": "v"})
    assert result == payload
