from __future__ import annotations

import asyncio
import re
import threading
from types import SimpleNamespace

import pytest

from core.base_platform import Account, RegisterConfig
from platforms.chatgpt import payment as payment_module
from platforms.chatgpt import payment_protocol
from platforms.chatgpt.plugin import ChatGPTPlatform


@pytest.fixture(autouse=True)
def _configure_hosted_checkout_test_values(monkeypatch):
    """Keep hosted-checkout tests explicit while production defaults stay empty."""
    values = {
        "CTF_RELAY_CODE_URL": "https://relay.example.invalid/code",
        "CTF_PHONE_NUMBER": "555010" + "2000",
        "CTF_CARD_NUMBER": "4" + ("2" * 15),
        "CTF_CARD_EXP_MONTH": "12",
        "CTF_CARD_EXP_YEAR": "2099",
        "CTF_CARD_CVV": "000",
        "CTF_ADDRESS_LINE1": "1 Example Street",
        "CTF_ADDRESS_LINE2": "Suite 2",
        "CTF_CITY": "Example City",
        "CTF_STATE": "EX",
        "CTF_STATE_NAME": "Example State",
        "CTF_POSTAL_CODE": "00000",
        "CTF_DATE_OF_BIRTH": "01/01/1990",
    }
    for name, value in values.items():
        monkeypatch.setattr(payment_module, name, value)


class _Response:
    def __init__(self, data: dict, status_code: int = 200):
        self._data = data
        self.status_code = status_code
        self.text = str(data)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._data


def test_generate_plus_link_posts_hosted_checkout_payload(monkeypatch):
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return _Response({
            "url": "https://checkout.stripe.com/c/pay/cs_test_plus",
            "checkout_session_id": "cs_test_plus",
            "processor_entity": "stripe",
        })

    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)
    account = SimpleNamespace(
        access_token="at_123",
        cookies="__Secure-next-auth.session-token=sess_123; oai-did=did_123",
    )

    url = payment_module.generate_plus_link(account, country="ID", currency="IDR")

    assert url == "https://checkout.stripe.com/c/pay/cs_test_plus"
    assert captured["url"] == payment_module.PAYMENT_CHECKOUT_URL
    assert captured["headers"]["Authorization"] == "Bearer at_123"
    assert captured["headers"]["oai-device-id"] == "did_123"
    assert captured["json"] == {
        "plan_name": "chatgptplusplan",
        "billing_details": {"country": "ID", "currency": "IDR"},
        "cancel_url": "https://chatgpt.com/#pricing",
        "promo_campaign": {
            "promo_campaign_id": "plus-1-month-free",
            "is_coupon_from_query_param": False,
        },
        "checkout_ui_mode": "hosted",
    }


_MEIGUODIZHI_FAKE_RESPONSE = {
    "status": "ok",
    "address": {
        "Full_Name": "TEST USER",
        "Address": "123 Test Avenue",
        "City": "Testville",
        "State": "CA",
        "Zip_Code": "94105",
        "Telephone": "202-555-0142",
        "Credit_Card_Number": "4242424242424242",
        "Expires": "12/2030",
        "CVV2": "123",
    },
}


def test_normalize_us_billing_address_extracts_card_fields():
    normalized = payment_module._normalize_us_billing_address(_MEIGUODIZHI_FAKE_RESPONSE)

    assert normalized == {
        "name": "TEST USER",
        "line1": "123 Test Avenue",
        "city": "Testville",
        "state": "CA",
        "postal_code": "94105",
        "phone": "202-555-0142",
        "country": "US",
        "email": "",
        "card_number": "4242424242424242",
        "card_exp_month": "12",
        "card_exp_year": "2030",
        "card_cvv": "123",
    }


def test_fetch_us_billing_address_overrides_card_with_local_generator(monkeypatch):
    from platforms.chatgpt.card_generator import is_luhn_valid

    def fake_post(url, **kwargs):
        assert url == payment_module.MEIGUODIZHI_ADDRESS_URL
        assert kwargs["json"] == {"path": "/", "method": "address"}
        return _Response(_MEIGUODIZHI_FAKE_RESPONSE)

    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)

    address = payment_module.fetch_us_billing_address()

    # 地址字段保持来自 meiguodizhi
    assert address["name"] == "TEST USER"
    assert address["postal_code"] == "94105"
    # 卡片三件套被本地生成器覆盖
    assert address["card_number"] != "4242424242424242"
    assert address["card_number"].startswith("4"), address["card_number"]
    assert len(address["card_number"]) == 16
    assert is_luhn_valid(address["card_number"])
    assert 1 <= int(address["card_exp_month"]) <= 12
    assert int(address["card_exp_year"]) > 2027
    assert len(address["card_cvv"]) == 3 and address["card_cvv"].isdigit()


def test_fetch_us_billing_address_can_keep_remote_card_when_disabled(monkeypatch):
    def fake_post(url, **kwargs):
        return _Response(_MEIGUODIZHI_FAKE_RESPONSE)

    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)

    address = payment_module.fetch_us_billing_address(use_local_card=False)

    assert address["card_number"] == "4242424242424242"
    assert address["card_exp_year"] == "2030"
    assert address["card_cvv"] == "123"


def test_fetch_billing_address_falls_back_to_local_jp_seed_on_remote_tls_error(monkeypatch):
    calls = {"post": 0}

    def fake_post(url, **kwargs):
        calls["post"] += 1
        raise RuntimeError(
            "Failed to perform, curl: (35) TLS connect error: "
            "OPENSSL_internal:invalid library"
        )

    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)

    address = payment_module.fetch_billing_address("JP", use_local_card=False)

    assert calls["post"] == 3
    assert address["country"] == "JP"
    assert address["name"] == "James Smith"
    assert address["line1"] == "Marunouchi 1-1"
    assert address["city"] == "Chiyoda-ku"
    assert address["state"] == "Tokyo"
    assert address["postal_code"] == "100-0005"


def test_fetch_ctf_relay_code_extracts_six_digit_code(monkeypatch):
    def fake_get(url, **kwargs):
        assert url == payment_module.CTF_RELAY_CODE_URL
        return _Response({"code": 200, "msg": "OK", "data": "PayPal: 214849 is your security code. Don't share it."})

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)

    assert payment_module._fetch_ctf_relay_code() == "214849"


def test_fetch_ctf_relay_code_stops_when_cancel_requested(monkeypatch):
    calls = {"get": 0}

    def fake_get(url, **kwargs):
        calls["get"] += 1
        return _Response({"code": 200, "msg": "OK", "data": ""})

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)

    try:
        payment_module._fetch_ctf_relay_code(
            timeout_seconds=30,
            poll_interval_seconds=1,
            cancel_check=lambda: calls["get"] >= 1,
        )
    except RuntimeError as exc:
        assert str(exc) == "任务已取消"
    else:
        raise AssertionError("expected cancellation error")

    assert calls["get"] == 1


def test_fetch_ctf_relay_code_fails_closed_without_relay(monkeypatch):
    monkeypatch.setattr(payment_module, "CTF_RELAY_CODE_URL", "")

    with pytest.raises(RuntimeError, match="OTP relay 未配置"):
        payment_module._fetch_ctf_relay_code()


def test_fetch_ctf_relay_code_uses_burst_then_steady_interval(monkeypatch):
    """前 4 次未命中 → 用 1.5s 间隔（密集）；之后回到 5s（稳态）。
    避免短信抖动期间整轮等 5 秒才下一次轮询。"""
    sleeps: list[float] = []
    counter = {"get": 0}

    def fake_get(url, **kwargs):
        counter["get"] += 1
        # 第 7 次 GET 才返回真正的验证码
        if counter["get"] >= 7:
            return _Response({"code": 200, "msg": "OK", "data": "PayPal code: 998877"})
        return _Response({"code": 200, "msg": "OK", "data": ""})

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.time, "sleep", lambda s: sleeps.append(float(s)))

    code = payment_module._fetch_ctf_relay_code(
        timeout_seconds=300,
        poll_interval_seconds=5,
        initial_burst_attempts=4,
        initial_burst_interval=1.5,
    )

    assert code == "998877"
    # 6 次未命中 → 6 次 sleep；前 4 次都应是 1.5；最后 2 次应回到 5。
    assert len(sleeps) == 6
    assert sleeps[:4] == [1.5, 1.5, 1.5, 1.5]
    assert sleeps[4:] == [5.0, 5.0]


def test_fetch_ctf_relay_code_handles_non_json_text_responses(monkeypatch):
    """relay endpoint 可能直接返回纯 text/html（如 /sms-record / /api/get_sms），
    不再抛 ``json.JSONDecodeError("unexpected character: line 1 column 1")``，
    应当降级到 ``resp.text`` 上 grep 6 位数字。"""
    class _RawTextResp:
        def __init__(self, text: str):
            self.text = text
        def raise_for_status(self): pass
        def json(self):
            raise ValueError("not JSON: " + self.text[:20])

    def fake_get(url, **kwargs):
        return _RawTextResp("Your verification code is 778899. Don't share")

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.time, "sleep", lambda s: None)

    code = payment_module._fetch_ctf_relay_code(
        timeout_seconds=10, poll_interval_seconds=1, initial_burst_attempts=0,
    )
    assert code == "778899"


def test_fetch_ctf_relay_code_treats_network_error_as_miss_and_keeps_polling(monkeypatch):
    """relay 临时 5xx/网络抖动时应当吃异常继续轮询，不能把整次 OTP 拖死。"""
    counter = {"get": 0}

    def fake_get(url, **kwargs):
        counter["get"] += 1
        if counter["get"] == 1:
            raise RuntimeError("HTTP Error 522: connection timed out")
        return _Response({"code": 200, "data": "code 445566 ok"})

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.time, "sleep", lambda s: None)

    code = payment_module._fetch_ctf_relay_code(
        timeout_seconds=10, poll_interval_seconds=1, initial_burst_attempts=2,
    )
    assert code == "445566"
    assert counter["get"] == 2


def test_fetch_ctf_relay_code_picks_up_alternative_json_fields(monkeypatch):
    """不同 endpoint 用不同字段名（code/sms/message/text/content）盛放短信内容。"""
    samples = [
        ({"code": "123456"}, "123456"),
        ({"sms": "OTP 234567 valid 5min"}, "234567"),
        ({"message": "Verification: 345678"}, "345678"),
        ({"text": "Use code 456789"}, "456789"),
        ({"content": "Your PayPal pin is 567890."}, "567890"),
    ]
    for payload, expected in samples:
        monkeypatch.setattr(payment_module.cffi_requests, "get",
                            lambda url, p=payload, **kwargs: _Response(p))
        code = payment_module._fetch_ctf_relay_code(
            timeout_seconds=2, poll_interval_seconds=1,
            initial_burst_attempts=0, single_attempt=True,
        )
        assert code == expected, f"payload={payload} expected={expected} got={code}"


def test_fetch_ctf_relay_code_burst_disabled_with_zero_attempts(monkeypatch):
    """initial_burst_attempts=0 时应直接走 poll_interval_seconds，保持向后兼容。"""
    sleeps: list[float] = []
    counter = {"get": 0}

    def fake_get(url, **kwargs):
        counter["get"] += 1
        if counter["get"] >= 3:
            return _Response({"code": 200, "msg": "OK", "data": "code 123456 done"})
        return _Response({"code": 200, "msg": "OK", "data": ""})

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.time, "sleep", lambda s: sleeps.append(float(s)))

    code = payment_module._fetch_ctf_relay_code(
        timeout_seconds=300,
        poll_interval_seconds=4,
        initial_burst_attempts=0,
    )

    assert code == "123456"
    # 2 次未命中 → 2 次 sleep，全部用 poll_interval_seconds=4。
    assert sleeps == [4.0, 4.0]


def test_extract_all_six_digit_codes_returns_unique_in_order():
    """``_extract_all_six_digit_codes`` 必须按出现顺序返回所有 6 位数字串，
    且去重——以便 baseline 模式可以一次拿到 relay 中所有"上次残留 pin"。"""
    text = (
        "PayPal: 799466 is your security code. "
        "Old: 123456. PayPal: 654321 is your code. 123456 again."
    )
    codes = payment_module._extract_all_six_digit_codes(text)
    assert codes == ["799466", "123456", "654321"]


def test_extract_all_six_digit_codes_handles_empty_or_no_digits():
    """空响应 / 不含 6 位数字的响应应返回空列表，绝不抛异常。"""
    assert payment_module._extract_all_six_digit_codes("") == []
    assert payment_module._extract_all_six_digit_codes("no digits here") == []
    assert payment_module._extract_all_six_digit_codes("12345 only 5 digits") == []
    # 7 位数字 ``1234567`` 不应被错认为 6 位（regex ``\b\d{6}\b`` 严格匹配）
    assert payment_module._extract_all_six_digit_codes("1234567") == []


def test_fetch_ctf_relay_code_with_excluded_pins_skips_old_sms(monkeypatch):
    """**核心回归**：部分 relay 服务返回的 payload 包含上一次任务
    的旧 SMS（pin=799466）。``\\b\\d{6}\\b`` regex 匹配第一个数字串导致两次
    任务都拿到同一个 ``799466``，第二次 PayPal challengeId 已经变了 →
    ``OTP_CONFIRM`` 直接 ``VALIDATION_FAILED``。

    传入 ``excluded_pins={"799466"}`` 后，``_fetch_ctf_relay_code`` 必须跳过
    旧 pin、继续轮询直到 relay 出现新 pin。
    """
    payloads = [
        # 第 1 轮：relay 仍然只有上次的旧 SMS → 必须跳过、继续轮询
        {"data": "PayPal: 799466 is your security code."},
        # 第 2 轮：依旧只有旧的 → 继续等
        {"data": "PayPal: 799466 is your security code."},
        # 第 3 轮：新 SMS 到达，relay 同时返回旧 + 新两条 → 应该返回新 pin 654321
        {"data": "PayPal: 799466 is your code. PayPal: 654321 is your code."},
    ]
    counter = {"i": 0}

    def fake_get(url, **kwargs):
        idx = counter["i"]
        counter["i"] += 1
        if idx >= len(payloads):
            raise AssertionError("超出预期轮询次数")
        return _Response(payloads[idx])

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.time, "sleep", lambda s: None)

    code = payment_module._fetch_ctf_relay_code(
        timeout_seconds=300,
        poll_interval_seconds=1,
        initial_burst_attempts=0,
        excluded_pins={"799466"},
    )
    assert code == "654321", f"应返回新 pin，不应是被排除的旧 pin；实际={code}"
    assert counter["i"] == 3, "应正好轮询 3 次（前两次只有旧 pin，第 3 次才有新）"


def test_fetch_ctf_relay_code_excluded_pins_none_preserves_legacy_behavior(monkeypatch):
    """当 ``excluded_pins=None``（旧调用方式）时，行为必须与之前完全一致：
    用 ``_extract_six_digit_code`` 抓第一个 6 位数字立即返回，不去重不过滤。
    """
    monkeypatch.setattr(
        payment_module.cffi_requests, "get",
        lambda url, **kwargs: _Response(
            {"data": "old: 111111. new: 222222. yet another: 333333."}
        ),
    )
    monkeypatch.setattr(payment_module.time, "sleep", lambda s: None)

    code = payment_module._fetch_ctf_relay_code(
        timeout_seconds=10, poll_interval_seconds=1, initial_burst_attempts=0,
    )
    # 旧行为：拿第一个匹配。即使有 222222 / 333333 也无所谓。
    assert code == "111111"


def test_fetch_ctf_relay_code_excluded_pins_empty_set_treated_as_none(monkeypatch):
    """``excluded_pins=set()``（空集）等价于不传——避免一些调用方传"零长 set"
    时意外触发"全 pin 都被排除 → 永远返回空"的退化行为。"""
    monkeypatch.setattr(
        payment_module.cffi_requests, "get",
        lambda url, **kwargs: _Response({"data": "PayPal: 555555 is your code."}),
    )
    monkeypatch.setattr(payment_module.time, "sleep", lambda s: None)

    code = payment_module._fetch_ctf_relay_code(
        timeout_seconds=10, poll_interval_seconds=1, initial_burst_attempts=0,
        excluded_pins=set(),
    )
    assert code == "555555"


# ----- parse_sms_pool ---------------------------------------------------------


def test_parse_sms_pool_extracts_pairs_from_canonical_format():
    """主路径：用户截图给的格式 `+phone----https://...`，多条用换行分隔。"""
    phone_one = "+1" + "2025550101"
    phone_two = "+1" + "2025550102"
    raw = (
        f"{phone_one}----https://relay.example.invalid/first\n"
        f"{phone_two}----https://relay.example.invalid/second\n"
    )
    pool = payment_module.parse_sms_pool(raw)
    assert len(pool) == 2
    assert pool[0] == {
        "phone": phone_one.lstrip("+"),
        "phone_e164": phone_one,
        "relay_url": "https://relay.example.invalid/first",
    }
    assert pool[1]["phone_e164"] == phone_two


def test_parse_sms_pool_ignores_blank_lines_and_comments():
    raw = (
        "\n"
        "# 这一行是注释\n"
        "+12025550142----https://x.example/a\n"
        "   \n"  # 全空白
        "  # 带前导空格的注释也忽略\n"
    )
    pool = payment_module.parse_sms_pool(raw)
    assert len(pool) == 1
    assert pool[0]["phone"] == "12025550142"


def test_parse_sms_pool_tolerates_extra_dashes_and_whitespace():
    """容忍 ---、----- 等任意 ≥3 段破折号，以及两侧多余空白。"""
    raw = "  +12025550142   -----   https://x.example/a  \n+12025550143---https://y.example/b\n"
    pool = payment_module.parse_sms_pool(raw)
    assert len(pool) == 2
    assert pool[0]["phone"] == "12025550142"
    assert pool[1]["phone"] == "12025550143"
    assert pool[1]["relay_url"] == "https://y.example/b"


def test_parse_sms_pool_dedupes_identical_entries():
    raw = (
        "+12025550142----https://x.example/a\n"
        "+12025550142----https://x.example/a\n"  # 完全重复
        "+12025550142----https://x.example/b\n"  # 同号不同 URL，应保留
    )
    pool = payment_module.parse_sms_pool(raw)
    assert len(pool) == 2
    urls = {p["relay_url"] for p in pool}
    assert urls == {"https://x.example/a", "https://x.example/b"}


def test_parse_sms_pool_accepts_phone_without_leading_plus():
    """如果用户漏写 +，自动补上 phone_e164。"""
    raw = "12025550142----https://x.example/a\n"
    pool = payment_module.parse_sms_pool(raw)
    assert len(pool) == 1
    assert pool[0]["phone"] == "12025550142"
    assert pool[0]["phone_e164"] == "+12025550142"


def test_parse_sms_pool_skips_malformed_lines():
    """缺破折号 / 缺 URL / 非数字电话等不合规行被静默忽略，不抛异常。"""
    raw = (
        "garbage line\n"
        "+12025550142 only phone\n"
        "----https://x.example/no-phone\n"
        "+notdigits----https://x.example/non-digit-phone\n"
        "+12025550142----https://x.example/good\n"
    )
    pool = payment_module.parse_sms_pool(raw)
    assert len(pool) == 1
    assert pool[0]["relay_url"] == "https://x.example/good"


def test_parse_sms_pool_returns_empty_list_for_blank_input():
    assert payment_module.parse_sms_pool("") == []
    assert payment_module.parse_sms_pool("   \n   \n") == []
    assert payment_module.parse_sms_pool(None) == []  # type: ignore[arg-type]


def test_generate_ctf_test_identity_uses_natural_random_values():
    identity = payment_module._generate_ctf_test_identity()
    combined = " ".join(str(value) for value in identity.values()).lower()

    assert identity["email"].endswith("@gmail.com")
    assert "ctf.test" not in identity["email"].lower()
    assert "ctf" not in identity["email"].lower()
    assert "test" not in combined
    assert "sandbox" not in combined
    assert re.fullmatch(r"[a-z]+[a-z0-9]*@gmail\.com", identity["email"])
    assert re.fullmatch(r"[A-Z][a-z]+", identity["first_name"])
    assert re.fullmatch(r"[A-Z][a-z]+", identity["last_name"])
    assert identity["name"] == f"{identity['first_name']} {identity['last_name']}"
    assert re.search(r"\d", identity["address_line1"])
    assert re.search(r"[A-Za-z]", identity["address_line1"])
    assert identity["city"]
    assert identity["postal_code"]
    assert identity["date_of_birth"] == payment_module.CTF_DATE_OF_BIRTH


def test_ctf_date_of_birth_comes_from_explicit_test_configuration():
    assert payment_module.CTF_DATE_OF_BIRTH


def test_complete_ctf_sandbox_flow_fails_closed_without_payment_configuration(monkeypatch):
    for name in (
        "CTF_RELAY_CODE_URL",
        "CTF_PHONE_NUMBER",
        "CTF_CARD_NUMBER",
        "CTF_CARD_EXP_MONTH",
        "CTF_CARD_EXP_YEAR",
        "CTF_CARD_CVV",
        "CTF_ADDRESS_LINE1",
        "CTF_ADDRESS_LINE2",
        "CTF_CITY",
        "CTF_STATE",
        "CTF_STATE_NAME",
        "CTF_POSTAL_CODE",
        "CTF_DATE_OF_BIRTH",
    ):
        monkeypatch.setattr(payment_module, name, "")

    with pytest.raises(RuntimeError, match="配置不完整（已安全终止）"):
        payment_module._complete_ctf_sandbox_flow(
            object(),
            timeout_ms=30000,
            log=lambda _message: None,
        )


def test_hold_checkout_browser_exits_early_when_cancel_requested(monkeypatch):
    sleeps = []

    def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(payment_module.time, "sleep", fake_sleep)

    payment_module._hold_checkout_browser(
        None,
        headless=False,
        hold_seconds=10,
        log=lambda message: None,
        cancel_check=lambda: bool(sleeps),
    )

    assert sleeps == [1]


def test_click_subscribe_button_burst_clicks_three_times_when_not_redirected():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            events.append(("click", self.selector, kwargs))

    class FakePage:
        url = "https://checkout.stripe.com/c/pay/cs_test_plus"

        def locator(self, selector):
            return FakeLocator(self, selector)

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))

    payment_module._click_subscribe_button_burst(
        FakePage(),
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        log=lambda message: events.append(("log", message)),
    )

    assert [event[0] for event in events].count("click") == 3
    assert ("wait", 1000) in events


def test_wait_for_manual_security_challenge_does_not_call_captcha_solver(monkeypatch):
    logs = []
    now = {"value": 0.0}

    class FakeBody:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **kwargs):
            self.page.reads += 1
            return "Security challenge" if self.page.reads == 1 else "Create account"

    class FakePage:
        def __init__(self):
            self.reads = 0
            self.url = "https://ctf-sandbox.example/create"

        def locator(self, selector):
            # _has_security_challenge_text 走 body；_click_security_challenge_control
            # 会试更多 selector，本测试场景不关心点击是否成功（FakePage 上
            # 的 locator 不模拟 first/is_visible 接口，会被 _locator_ready 直接
            # 视为 not ready，最终抛 RuntimeError 进 except 分支）。
            return FakeBody(self) if selector == "body" else _NoOpLocator()

        def wait_for_timeout(self, timeout):
            now["value"] += timeout / 1000

    class _NoOpLocator:
        first = property(lambda self: self)

        def count(self):
            return 0

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])

    payment_module._wait_for_manual_security_challenge(
        FakePage(),
        timeout_ms=300000,
        log=logs.append,
    )

    # 新行为：未配置 solver 时不再 5 分钟人工等待，而是"自动点击 + 10s 等转跳"。
    assert any("未启用 captcha solver" in message for message in logs)
    # 不应调用任何远端 captcha 服务（YesCaptcha 等）
    assert not any("YesCaptcha" in message for message in logs)
    assert not any("调用验证码服务" in message for message in logs)


def test_wait_for_security_challenge_retries_solver_until_sitekey_appears(monkeypatch):
    logs = []
    now = {"value": 0.0}
    waits = []
    state = {"challenge_visible": True, "sitekey_checks": 0}
    attempts = []

    class FakePage:
        url = "https://ctf-sandbox.example/create"

        def wait_for_timeout(self, timeout):
            waits.append(timeout)
            now["value"] += timeout / 1000

    def fake_has_challenge(page):
        return state["challenge_visible"]

    def fake_extract_turnstile(page):
        state["sitekey_checks"] += 1
        return "" if state["sitekey_checks"] == 1 else "0xSITEKEY_TEST"

    def fake_inject(page, token):
        state["challenge_visible"] = False
        return True

    def fake_solver(page_url, site_key):
        attempts.append((page_url, site_key))
        return "TURNSTILE_TOKEN_VALUE"

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(payment_module, "_has_security_challenge", fake_has_challenge)
    monkeypatch.setattr(payment_module, "_extract_turnstile_sitekey", fake_extract_turnstile)
    monkeypatch.setattr(payment_module, "_extract_recaptcha_sitekey", lambda page: "")
    monkeypatch.setattr(payment_module, "_inject_turnstile_token", fake_inject)

    assert payment_module._wait_for_manual_security_challenge(
        FakePage(),
        timeout_ms=10000,
        log=logs.append,
        turnstile_solver=fake_solver,
    ) is True

    assert attempts == [("https://ctf-sandbox.example/create", "0xSITEKEY_TEST")]
    assert 3000 in waits
    assert not any("手动完成" in message for message in logs)


def test_wait_page_loaded_polls_ready_state_without_blocking(monkeypatch):
    logs = []
    waits = []
    states = ["loading", "loading", "interactive"]

    class FakePage:
        def evaluate(self, script):
            return states.pop(0)

        def wait_for_timeout(self, timeout):
            waits.append(timeout)

        def wait_for_load_state(self, state, timeout):
            raise AssertionError("should not block on load_state")

        def wait_for_function(self, script, timeout):
            raise AssertionError("should not block on wait_for_function")

    payment_module._wait_page_loaded(FakePage(), timeout_ms=30000, log=logs.append, label="测试页")

    assert waits
    assert any("readyState=interactive" in message for message in logs)


def test_wait_checkout_page_ready_polls_key_elements_without_blocking(monkeypatch):
    logs = []
    waits = []

    class FakeLocator:
        first = None

        def __init__(self, page):
            self.page = page
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return self.page.polls >= 3

        def is_enabled(self):
            return True

        def wait_for(self, state, timeout):
            raise AssertionError("should not block on locator.wait_for")

    class FakePage:
        def __init__(self):
            self.polls = 0

        def evaluate(self, script):
            self.polls += 1
            return "loading" if self.polls < 2 else "interactive"

        def locator(self, selector):
            return FakeLocator(self)

        def wait_for_timeout(self, timeout):
            waits.append(timeout)

        def wait_for_load_state(self, state, timeout):
            raise AssertionError("should not block on load_state")

        def wait_for_function(self, script, timeout):
            raise AssertionError("should not block on wait_for_function")

    payment_module._wait_checkout_page_ready(FakePage(), timeout_ms=30000, log=logs.append)

    assert waits == [250, 250]
    assert any("支付页面" in message and "readyState=interactive" in message for message in logs)


def test_paypal_checkoutweb_signup_url_is_paypal_create_url():
    assert payment_module._is_paypal_pay_create_url(
        "https://www.paypal.com/checkoutweb/signup?ssrt=1&ba_token=BA-09C999&locale.x=en_US&country.x=US"
    ) is True


def test_wait_for_paypal_security_challenge_attempts_turnstile_solver(monkeypatch):
    logs = []
    now = {"value": 0.0}
    attempts = []

    class FakeBody:
        def inner_text(self, **kwargs):
            return "Security challenge"

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-test-token"

        def locator(self, selector):
            assert selector == "body"
            return FakeBody()

        def wait_for_timeout(self, timeout):
            now["value"] += timeout / 1000

    def fake_auto_solve(page, *, solver, log):
        attempts.append(callable(solver))
        return True

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(
        payment_module,
        "_click_security_challenge_control",
        lambda page, *, label: (_ for _ in ()).throw(RuntimeError("not clickable")),
    )
    monkeypatch.setattr(payment_module, "_try_auto_solve_security_challenge", fake_auto_solve)

    assert payment_module._wait_for_manual_security_challenge(
        FakePage(),
        timeout_ms=300000,
        log=logs.append,
        turnstile_solver=lambda page_url, site_key: "token",
    ) is True
    assert attempts == [True]


def test_wait_for_security_challenge_calls_solver_before_clicking(monkeypatch):
    logs = []
    now = {"value": 0.0}

    class FakeBody:
        def inner_text(self, **kwargs):
            return "Security challenge"

    class FakePage:
        url = "https://www.paypal.com/checkoutweb/signup?ba_token=BA-test-token"

        def locator(self, selector):
            assert selector == "body"
            return FakeBody()

        def wait_for_timeout(self, timeout):
            now["value"] += timeout / 1000

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(
        payment_module,
        "_try_complete_ctf_sandbox_click_challenge",
        lambda page, *, log: (_ for _ in ()).throw(AssertionError("should not click challenge")),
    )
    monkeypatch.setattr(payment_module, "_try_auto_solve_security_challenge", lambda page, *, solver, log: True)

    assert payment_module._wait_for_manual_security_challenge(
        FakePage(),
        timeout_ms=300000,
        log=logs.append,
        turnstile_solver=lambda page_url, site_key: "token",
    ) is True


def test_wait_for_security_challenge_uses_solver_without_clicking_sandbox_challenge(monkeypatch):
    logs = []
    now = {"value": 0.0}

    class FakeBody:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **kwargs):
            return "Security challenge" if not self.page.clicked else "Create account"

    class FakeLocator:
        first = None

        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def evaluate(self, script):
            return "BUTTON"

        def click(self, **kwargs):
            self.page.clicked = True

    class FakePage:
        def __init__(self):
            self.clicked = False
            self.url = "https://ctf-sandbox.example/challenge"

        def locator(self, selector):
            if selector == "body":
                return FakeBody(self)
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

        def wait_for_timeout(self, timeout):
            now["value"] += timeout / 1000

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(payment_module, "_try_auto_solve_security_challenge", lambda page, *, solver, log: True)

    page = FakePage()
    assert payment_module._wait_for_manual_security_challenge(
        page,
        timeout_ms=300000,
        log=logs.append,
        turnstile_solver=lambda page_url, site_key: "token",
    ) is True
    assert page.clicked is False


def test_wait_for_security_challenge_uses_solver_without_clicking_paypal_mock(monkeypatch):
    logs = []
    now = {"value": 0.0}

    class FakeBody:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **kwargs):
            return "Security challenge I am human" if not self.page.clicked else "Create account"

    class FakeLocator:
        first = None

        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def evaluate(self, script):
            return "BUTTON"

        def click(self, **kwargs):
            self.page.clicked = True
            self.page.url = "https://ctf-sandbox.example/create"

    class FakePage:
        def __init__(self):
            self.clicked = False
            self.url = "https://www.paypal.com/pay?token=BA-123&ul=1"

        def locator(self, selector):
            if selector == "body":
                return FakeBody(self)
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

        def wait_for_timeout(self, timeout):
            now["value"] += timeout / 1000

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(payment_module, "_try_auto_solve_security_challenge", lambda page, *, solver, log: True)

    page = FakePage()

    assert payment_module._wait_for_manual_security_challenge(
        page,
        timeout_ms=300000,
        log=logs.append,
        turnstile_solver=lambda page_url, site_key: "token",
    ) is True
    assert page.clicked is False
    assert page.url == "https://www.paypal.com/pay?token=BA-123&ul=1"


def test_wait_for_security_challenge_uses_solver_without_clicking_iframe(monkeypatch):
    logs = []
    now = {"value": 0.0}

    class FakeBody:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **kwargs):
            return "Security Challenge" if not self.page.frame_clicked else "Create account"

    class FakeLocator:
        first = None

        def __init__(self, click_target=None, ready=True, tag="BUTTON"):
            self.click_target = click_target
            self.ready = ready
            self.tag = tag
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return self.tag

        def click(self, **kwargs):
            if self.click_target:
                self.click_target()

    class FakeFrame:
        def __init__(self, page):
            self.page = page
            self.url = "https://mock.local/security-challenge-frame"

        def locator(self, selector):
            ready = 'I am human' in selector or "human" in selector.lower()
            return FakeLocator(lambda: setattr(self.page, "frame_clicked", True), ready=ready)

        def get_by_role(self, role, name=None):
            return FakeLocator(lambda: setattr(self.page, "frame_clicked", True), ready=True)

        def get_by_text(self, text):
            return FakeLocator(lambda: setattr(self.page, "frame_clicked", True), ready=True)

    class FakePage:
        def __init__(self):
            self.title_clicked = False
            self.frame_clicked = False
            self.url = "https://www.paypal.com/pay?token=BA-123&ul=1"
            self.frames = [FakeFrame(self)]

        def locator(self, selector):
            if selector == "body":
                return FakeBody(self)
            return FakeLocator(ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(ready=False)

        def get_by_text(self, text):
            return FakeLocator(lambda: setattr(self, "title_clicked", True), ready=True)

        def wait_for_timeout(self, timeout):
            now["value"] += timeout / 1000

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(payment_module, "_try_auto_solve_security_challenge", lambda page, *, solver, log: True)

    page = FakePage()

    assert payment_module._wait_for_manual_security_challenge(
        page,
        timeout_ms=300000,
        log=logs.append,
        turnstile_solver=lambda page_url, site_key: "token",
    ) is True
    assert page.frame_clicked is False
    assert page.title_clicked is False


def test_wait_after_continue_clicks_delayed_paypal_mock_i_am_human(monkeypatch):
    logs = []
    now = {"value": 0.0}

    class FakeBody:
        def __init__(self, page):
            self.page = page

        def inner_text(self, **kwargs):
            if self.page.stage == "challenge":
                return "Security challenge I am human"
            if self.page.stage == "payment":
                return "Pay with debit or credit card"
            return ""

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=True):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "BUTTON"

        def click(self, **kwargs):
            self.page.clicked = True
            self.page.stage = "payment"
            self.page.url = "https://ctf-sandbox.example/create"

    class FakePage:
        def __init__(self):
            self.stage = "loading"
            self.clicked = False
            self.waits = []
            self.url = "https://www.paypal.com/pay?token=BA-123&ul=1"

        def locator(self, selector):
            if selector == "body":
                return FakeBody(self)
            if selector == 'input[type="tel"]':
                return FakeLocator(self, selector, ready=self.stage == "payment")
            return FakeLocator(self, selector, ready=self.stage == "challenge")

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=self.stage == "challenge")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=self.stage == "challenge")

        def wait_for_timeout(self, timeout):
            self.waits.append(timeout)
            now["value"] += timeout / 1000
            if len(self.waits) == 1:
                self.stage = "challenge"

    monkeypatch.setattr(payment_module.time, "monotonic", lambda: now["value"])

    page = FakePage()

    def fake_auto_solve(current_page, *, solver, log):
        current_page.stage = "payment"
        current_page.url = "https://ctf-sandbox.example/create"
        return True

    monkeypatch.setattr(payment_module, "_try_auto_solve_security_challenge", fake_auto_solve)

    payment_module._wait_for_ctf_after_continue_ready(
        page,
        timeout_ms=300000,
        log=logs.append,
        turnstile_solver=lambda page_url, site_key: "token",
    )

    assert page.clicked is False
    assert page.stage == "payment"


def test_run_step_with_retries_retries_current_operation_until_success():
    logs = []
    waits = []
    state = {"calls": 0}

    class FakePage:
        def wait_for_timeout(self, timeout):
            waits.append(timeout)

    def flaky_step():
        state["calls"] += 1
        if state["calls"] < 3:
            raise RuntimeError("transient failure")
        return "ok"

    result = payment_module._run_step_with_retries(
        "测试步骤",
        flaky_step,
        page=FakePage(),
        log=logs.append,
    )

    assert result == "ok"
    assert state["calls"] == 3
    assert waits == [5000, 5000]
    assert any("测试步骤第 1/3 次失败" in message for message in logs)
    assert any("测试步骤第 2/3 次失败" in message for message in logs)


def test_run_step_with_retries_fails_after_three_attempts():
    logs = []
    state = {"calls": 0}

    def always_fails():
        state["calls"] += 1
        raise RuntimeError("still broken")

    try:
        payment_module._run_step_with_retries("测试步骤", always_fails, log=logs.append)
    except RuntimeError as exc:
        assert "still broken" in str(exc)
    else:
        raise AssertionError("expected step to fail after retries")

    assert state["calls"] == 3
    assert any("测试步骤连续 3 次失败" in message for message in logs)


def test_run_step_with_retries_stops_before_retry_when_step_already_progressed():
    logs = []
    waits = []
    state = {"calls": 0, "progressed": False}

    class FakePage:
        def wait_for_timeout(self, timeout):
            waits.append(timeout)
            state["progressed"] = True

    def stale_step():
        state["calls"] += 1
        raise RuntimeError("old step no longer exists")

    result = payment_module._run_step_with_retries(
        "old step",
        stale_step,
        page=FakePage(),
        log=logs.append,
        progressed=lambda: state["progressed"],
        progressed_value=lambda: "next step",
    )

    assert result == "next step"
    assert state["calls"] == 1
    assert waits == [5000]
    assert any("已进入下一步" in message for message in logs)


def test_complete_ctf_sandbox_flow_fills_code_and_waits_for_chatgpt(monkeypatch):
    logs = []
    fills = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=True):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def fill(self, value, **kwargs):
            fills.append((self.selector, value))
            self.page.values[self.selector] = value
            if value == "214849":
                self.page.stage = "code_filled"

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

        def click(self, **kwargs):
            if self.selector.startswith('a[href*="create"'):
                self.page.stage = "create"
                self.page.url = "https://ctf-sandbox.example/create"
            elif "Continue to Payment" in self.selector:
                self.page.stage = "payment"
            elif self.selector == 'button[type="submit"]':
                if self.page.stage == "create":
                    self.page.stage = "payment"
                elif self.page.stage == "payment":
                    self.page.popup = True
                elif self.page.stage == "code_filled":
                    self.page.url = "https://chatgpt.com/"

        def check(self, **kwargs):
            self.click(**kwargs)

        def select_option(self, **kwargs):
            fills.append((self.selector, kwargs.get("value") or kwargs.get("label")))

    class FakeBody:
        def inner_text(self, **kwargs):
            return "Create account"

    class FakePage:
        def __init__(self):
            self.url = "https://ctf-sandbox.example/start"
            self.stage = "start"
            self.popup = False
            self.values = {}

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_function(self, expression, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            if selector == "body":
                return FakeBody()
            popup_selector = "one-time-code" in selector or 'name*="code"' in selector or 'name*="otp"' in selector
            create_selector = selector.startswith('a[href*="create"') or "Create an account" in selector
            signup_selector = selector in {
                'input[type="email"]',
                'input[name="email"]',
                'input[autocomplete="email"]',
                "#email",
                'button:has-text("Continue to Payment")',
            }
            submit_selector = selector == 'button[type="submit"]' or selector == 'input[type="submit"]'
            if popup_selector:
                ready = self.popup
            elif self.stage == "start":
                ready = create_selector
            elif self.stage == "create":
                ready = signup_selector or submit_selector
            elif self.stage in {"payment", "code_filled"}:
                ready = not create_selector
            else:
                ready = False
            return FakeLocator(self, selector, ready=ready)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=self.popup)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", ready=self.stage in {"create", "payment", "code_filled"})

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "214849")
    monkeypatch.setattr(
        payment_module,
        "_fill_paypal_unified_guest_form",
        lambda *args, **kwargs: False,
    )

    result = payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=logs.append)

    assert result["status"] == "ctf_completed"
    assert result["final_url"] == "https://chatgpt.com/"
    assert any(value == "214849" for _, value in fills)
    assert any(value == payment_module.CTF_CARD_NUMBER for _, value in fills)


def test_complete_ctf_sandbox_flow_clicks_resend_when_relay_code_missing(monkeypatch):
    """新行为：拉 code 第 1 次没拿到时**不再**重填表/重 submit，而是点 popup 的 Resend。

    旧版（test_..._resubmits_..._）的预期是 fills=2 / submits=2——那个路径会被 PayPal
    风控判同邮箱二次注册，OAS_ERROR 概率显著上升。新版主循环改为单个号码内只
    fill+submit 1 次，之后所有重试都靠 popup 的 Resend 按钮。
    """
    state = {
        "fills": 0,
        "submits": 0,
        "fetches": 0,
        "resends": 0,
        "codes": [],
    }

    class FakePage:
        url = "https://ctf-sandbox.example/create"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", lambda page, **kwargs: False)
    # **关键**：默认无拒号，让流程走"点 Resend 重试"分支
    monkeypatch.setattr(payment_module, "_detect_ctf_phone_rejected", lambda page: (False, ""))

    def fake_fill_payment(page, identity, **_kwargs):
        state["fills"] += 1

    def fake_submit(page, **kwargs):
        state["submits"] += 1

    def fake_fetch(**kwargs):
        state["fetches"] += 1
        return "" if state["fetches"] == 1 else "214849"

    def fake_resend(page, **_kw):
        state["resends"] += 1
        return True

    def fake_fill_code(page, code, **_kwargs):
        state["codes"].append(code)
        if code:
            page.url = "https://chatgpt.com/"

    def fake_wait_return(page, **kwargs):
        if "chatgpt" not in page.url:
            raise RuntimeError("not returned")
        return page.url

    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", fake_fill_payment)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", fake_submit)
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", fake_fetch)
    monkeypatch.setattr(payment_module, "_click_ctf_resend_in_popup", fake_resend)
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", fake_fill_code)
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", fake_wait_return)

    result = payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=lambda message: None)

    assert result["status"] == "ctf_completed"
    # **新行为核心 assert**：fill+submit 各 1 次（不再有"重新填表+重新 submit"路径）
    assert state["fills"] == 1
    assert state["submits"] == 1
    # 第 1 次 fetch 拿不到 code → 点 1 次 Resend → 第 2 次 fetch 拿到
    assert state["fetches"] == 2
    assert state["resends"] == 1
    assert state["codes"] == ["214849"]


def test_complete_ctf_sandbox_flow_marks_current_phone_exhausted_after_three_resends(monkeypatch):
    state = {
        "fetch_timeouts": [],
        "resends": 0,
        "closed": 0,
    }

    class FakePage:
        url = "https://ctf-sandbox.example/create"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", lambda page, **kwargs: False)
    monkeypatch.setattr(payment_module, "_detect_ctf_phone_rejected", lambda page: (False, ""))
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: None)

    def fake_fetch(**kwargs):
        state["fetch_timeouts"].append(kwargs.get("timeout_seconds"))
        return ""

    def fake_resend(page, **kwargs):
        state["resends"] += 1
        return True

    def fake_close(page, **kwargs):
        state["closed"] += 1
        return True

    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", fake_fetch)
    monkeypatch.setattr(payment_module, "_click_ctf_resend_in_popup", fake_resend)
    monkeypatch.setattr(payment_module, "_close_ctf_popup_if_present", fake_close)

    with pytest.raises(RuntimeError, match="SMS_PHONE_EXHAUSTED"):
        payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=lambda message: None)

    assert state["resends"] == 3
    assert state["closed"] == 1
    assert state["fetch_timeouts"] == [120, 30, 30, 30]


def test_complete_ctf_sandbox_flow_uses_billing_profile_card_details(monkeypatch):
    captured = {}

    class FakePage:
        url = "https://ctf-sandbox.example/create"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "buyer@example.com",
            "password": "AverySecretAa1!",
            "first_name": "Avery",
            "last_name": "Morgan",
            "name": "Avery Morgan",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "214849")
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda page, code, **kwargs: setattr(page, "url", "https://chatgpt.com/"))
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda page, **kwargs: page.url)

    def fake_fill_payment(page, identity, **_kwargs):
        captured.update(identity)

    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", fake_fill_payment)

    result = payment_module._complete_ctf_sandbox_flow(
        FakePage(),
        timeout_ms=30000,
        log=lambda message: None,
        billing_profile={
            "card_number": "4242424242424242",
            "card_exp_month": "12",
            "card_exp_year": "2030",
            "card_cvv": "123",
        },
    )

    assert result["status"] == "ctf_completed"
    assert captured["card_number"] == "4242424242424242"
    assert captured["card_exp_month"] == "12"
    assert captured["card_exp_year"] == "2030"
    assert captured["card_cvv"] == "123"


def test_fill_ctf_payment_form_populates_required_address_fields():
    fills = {}

    class FakeLocator:
        first = None

        def __init__(self, key, ready=True):
            self.key = key
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def fill(self, value, **kwargs):
            fills[self.key] = value

        def select_option(self, **kwargs):
            fills[self.key] = kwargs.get("value") or kwargs.get("label")

    class FakePage:
        def locator(self, selector):
            if selector == "#cardNumber":
                return FakeLocator("card", ready=False)
            lowered = selector.lower()
            if "email" in lowered:
                return FakeLocator("email")
            if "password" in lowered:
                return FakeLocator("password")
            if "first" in lowered:
                return FakeLocator("first")
            if "last" in lowered:
                return FakeLocator("last")
            if "street address" in lowered or "address-line1" in lowered or "streetaddress" in lowered:
                return FakeLocator("street")
            if "apt" in lowered or "address-line2" in lowered:
                return FakeLocator("apt")
            if "city" in lowered or "address-level2" in lowered:
                return FakeLocator("city")
            if "state" in lowered or "address-level1" in lowered:
                return FakeLocator("state")
            if "zip" in lowered or "postal" in lowered:
                return FakeLocator("zip")
            if "phone" in lowered:
                return FakeLocator("phone")
            if "cardnumber" in lowered or "card-number" in lowered or "card_number" in lowered:
                return FakeLocator("card")
            if "exp" in lowered:
                return FakeLocator("exp")
            if "cvv" in lowered or "cvc" in lowered or "securitycode" in lowered or "security_code" in lowered:
                return FakeLocator("cvv")
            return FakeLocator(selector, ready=False)

        def get_by_label(self, name):
            return FakeLocator(str(name), ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(f"{role}:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(f"text:{text}", ready=False)

        def wait_for_timeout(self, timeout):
            pass

    payment_module._fill_ctf_payment_form(
        FakePage(),
        {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
            "address_line1": "123 Test Avenue",
            "address_line2": "Apt 418",
            "city": "Testville",
            "postal_code": "94105",
        },
    )

    assert fills["street"] == "123 Test Avenue"
    assert fills["city"] == "Testville"
    assert fills["state"] == payment_module.CTF_STATE
    assert fills["zip"] == "94105"


def test_fill_ctf_payment_form_populates_paypal_mock_placeholder_fields():
    fills = {}

    class FakeLocator:
        first = None

        def __init__(self, key, ready=True):
            self.key = key
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def fill(self, value, **kwargs):
            fills[self.key] = value

        def select_option(self, **kwargs):
            fills[self.key] = kwargs.get("value") or kwargs.get("label")

        def click(self, **kwargs):
            fills.setdefault("state_clicks", 0)
            fills["state_clicks"] += 1

    class FakePage:
        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            lowered = selector.lower()
            placeholder_map = {
                'placeholder*="email"': "email",
                'placeholder*="phone number"': "phone",
                'placeholder*="card number"': "card",
                'placeholder*="expiration date"': "exp",
                'placeholder*="cvv"': "cvv",
                'placeholder*="first name"': "first",
                'placeholder*="last name"': "last",
                'placeholder*="street address"': "street",
                'placeholder*="apt"': "apt",
                'placeholder*="city"': "city",
                'placeholder*="zip"': "zip",
                'placeholder*="create password"': "password",
            }
            for token, key in placeholder_map.items():
                if token in lowered:
                    return FakeLocator(key)
            if "state" in lowered:
                return FakeLocator("state")
            return FakeLocator(selector, ready=False)

        def get_by_label(self, name):
            return FakeLocator(str(name), ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(f"{role}:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(f"text:{text}", ready=False)

    payment_module._fill_ctf_payment_form(
        FakePage(),
        {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
            "address_line1": "123 Test Avenue",
            "address_line2": "Apt 418",
            "city": "Testville",
            "postal_code": "94105",
        },
    )

    assert fills["email"] == "ctf.test@example.gmail.com"
    assert fills["phone"] == payment_module.CTF_PHONE_NUMBER
    assert fills["card"] == payment_module.CTF_CARD_NUMBER
    assert fills["exp"] == f"{payment_module.CTF_CARD_EXP_MONTH}/{payment_module.CTF_CARD_EXP_YEAR}"
    assert fills["cvv"] == payment_module.CTF_CARD_CVV
    assert fills["first"] == "Test"
    assert fills["last"] == "Sandbox"
    assert fills["street"] == "123 Test Avenue"
    assert fills["apt"] == "Apt 418"
    assert fills["city"] == "Testville"
    assert fills["zip"] == "94105"
    assert fills["password"] == "CtfSecretAa1!"


def test_fill_ctf_payment_form_uses_identity_phone_when_provided():
    """identity 显式提供 phone 字段时，_fill_ctf_payment_form 应使用该 phone，
    不再 fallback 到全局常量 CTF_PHONE_NUMBER。"""
    fills = {}

    class FakeLocator:
        first = None

        def __init__(self, key, ready=True):
            self.key = key
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def fill(self, value, **kwargs):
            fills[self.key] = value

        def select_option(self, **kwargs):
            fills[self.key] = kwargs.get("value") or kwargs.get("label")

        def click(self, **kwargs):
            pass

    class FakePage:
        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            lowered = selector.lower()
            placeholder_map = {
                'placeholder*="email"': "email",
                'placeholder*="phone number"': "phone",
                'placeholder*="card number"': "card",
                'placeholder*="expiration date"': "exp",
                'placeholder*="cvv"': "cvv",
                'placeholder*="first name"': "first",
                'placeholder*="last name"': "last",
                'placeholder*="street address"': "street",
                'placeholder*="apt"': "apt",
                'placeholder*="city"': "city",
                'placeholder*="zip"': "zip",
                'placeholder*="create password"': "password",
            }
            for token, key in placeholder_map.items():
                if token in lowered:
                    return FakeLocator(key)
            if "state" in lowered:
                return FakeLocator("state")
            return FakeLocator(selector, ready=False)

        def get_by_label(self, name):
            return FakeLocator(str(name), ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(f"{role}:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(f"text:{text}", ready=False)

    payment_module._fill_ctf_payment_form(
        FakePage(),
        {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
            "address_line1": "123 Main St",
            "address_line2": "Apt 1",
            "city": "Albany",
            "postal_code": "12207",
            "phone": "2025550144",
        },
    )

    assert fills["phone"] == "2025550144"
    assert fills["phone"] != payment_module.CTF_PHONE_NUMBER


def test_complete_ctf_sandbox_flow_uses_sms_pool_phone_and_relay_url(monkeypatch):
    """camoufox 模式 _complete_ctf_sandbox_flow 收到 sms_pool 时，应把 sms_pool[0] 的
    phone / relay_url 注入 identity，并最终透传给 _fill_ctf_payment_form 与
    _fetch_ctf_relay_code。"""
    captured: dict = {"identity_phone": None, "relay_url": None}

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-test"

    def fake_fill(page, identity, **_kwargs):
        captured["identity_phone"] = identity.get("phone")
        captured["identity_phone_e164"] = identity.get("phone_e164")
        captured["identity_relay"] = identity.get("sms_relay_url")

    def fake_fetch(*, url, **_kwargs):
        captured["relay_url"] = url
        return "112233"

    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda *a, **kw: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda *a, **kw: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda *a, **kw: None)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", fake_fill)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda *a, **kw: None)
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", fake_fetch)
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda *a, **kw: None)
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda *a, **kw: "https://chatgpt.com/")
    monkeypatch.setattr(payment_module, "_advance_paypal_review_if_needed", lambda page, **kw: page.url)

    sms_pool = [{
        "phone": "12025550144",
        "phone_e164": "+12025550144",
        "relay_url": "https://x.example/relay-test-123",
    }]

    result = payment_module._complete_ctf_sandbox_flow(
        FakePage(),
        timeout_ms=30000,
        log=lambda m: None,
        sms_pool=sms_pool,
    )

    assert result["status"] == "ctf_completed"
    # Camoufox 模式期望填入 10 位本地号（剥掉 +1 国家码）。表单旁边自带国家码
    # 下拉，连号 ``12025550144`` 会被表单二次拼成 ``+1 12025550144`` (12 位) 触发
    # PayPal phone 校验失败；HAR 实采 SignUp body 的 ``phone.number`` 也是 10 位。
    assert captured["identity_phone"] == "2025550144"
    # phone_e164 仍保留 ``+`` 前缀的 E.164，供 OTP relay 等不需要剥国家码的下游用。
    assert captured["identity_phone_e164"] == "+12025550144"
    assert captured["identity_relay"] == "https://x.example/relay-test-123"
    # 关键：拉验证码用的 url 必须是 sms_pool[0] 的 relay_url，而不是默认 CTF_RELAY_CODE_URL
    assert captured["relay_url"] == "https://x.example/relay-test-123"
    assert captured["relay_url"] != payment_module.CTF_RELAY_CODE_URL


def test_complete_ctf_sandbox_flow_strips_country_code_from_phone(monkeypatch):
    """Camoufox 模式注入手机号时必须剥掉国家码。

    参数化覆盖几种典型 pool 格式：
    * 仅 ``phone`` 给 11 位带 1 的格式（无 ``phone_e164``）
    * 带 ``phone_e164=+1...`` 的标准格式
    * 国家码 86（中国大陆）
    * 已经是 10 位本地号（保持原样）
    """
    cases = [
        # (pool entry, expected identity_phone, expected identity_phone_e164)
        ({"phone": "12025550145",
          "phone_e164": "+12025550145",
          "relay_url": "https://x.example/rA"},
         "2025550145", "+12025550145"),
        ({"phone": "12025550145",  # 没显式给 phone_e164，应自动补 +
          "relay_url": "https://x.example/rB"},
         "2025550145", "+12025550145"),
        ({"phone": "8613800138000",
          "phone_e164": "+8613800138000",
          "relay_url": "https://x.example/rC"},
         "13800138000", "+8613800138000"),
        ({"phone": "2025550145",  # 已是 10 位本地号
          "phone_e164": "+12025550145",
          "relay_url": "https://x.example/rD"},
         "2025550145", "+12025550145"),
    ]

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-strip"

    for entry, expected_local, expected_e164 in cases:
        captured: dict = {}

        def fake_fill(_page, identity, _captured=captured, **_kwargs):
            _captured["phone"] = identity.get("phone")
            _captured["phone_e164"] = identity.get("phone_e164")
            _captured["relay"] = identity.get("sms_relay_url")

        monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda *a, **kw: None)
        monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda *a, **kw: None)
        monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda *a, **kw: None)
        monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", fake_fill)
        monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda *a, **kw: None)
        monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **_kw: "112233")
        monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda *a, **kw: None)
        monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda *a, **kw: "https://chatgpt.com/")
        monkeypatch.setattr(payment_module, "_advance_paypal_review_if_needed", lambda page, **kw: page.url)

        payment_module._complete_ctf_sandbox_flow(
            FakePage(),
            timeout_ms=30000,
            log=lambda m: None,
            sms_pool=[entry],
        )

        assert captured["phone"] == expected_local, (
            f"entry={entry!r} expected phone={expected_local} got {captured['phone']}"
        )
        assert captured["phone_e164"] == expected_e164, (
            f"entry={entry!r} expected phone_e164={expected_e164} got {captured['phone_e164']}"
        )
        assert captured["relay"] == entry["relay_url"]


def test_fill_ctf_payment_form_uses_identity_card_details():
    fills = {}

    class FakeLocator:
        first = None

        def __init__(self, key, ready=True):
            self.key = key
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def fill(self, value, **kwargs):
            fills[self.key] = value

        def select_option(self, **kwargs):
            fills[self.key] = kwargs.get("value") or kwargs.get("label")

        def click(self, **kwargs):
            pass

    class FakePage:
        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            if selector == "#cardNumber":
                return FakeLocator("card", ready=False)
            lowered = selector.lower()
            if "email" in lowered:
                return FakeLocator("email")
            if "password" in lowered:
                return FakeLocator("password")
            if "first" in lowered:
                return FakeLocator("first")
            if "last" in lowered:
                return FakeLocator("last")
            if "street address" in lowered or "address-line1" in lowered:
                return FakeLocator("street")
            if "city" in lowered or "address-level2" in lowered:
                return FakeLocator("city")
            if "state" in lowered or "address-level1" in lowered:
                return FakeLocator("state")
            if "zip" in lowered or "postal" in lowered:
                return FakeLocator("zip")
            if "phone" in lowered:
                return FakeLocator("phone")
            if "cardnumber" in lowered or "card number" in lowered or "cc-number" in lowered:
                return FakeLocator("card")
            if "exp" in lowered:
                return FakeLocator("exp")
            if "month" in lowered:
                return FakeLocator("month")
            if "year" in lowered:
                return FakeLocator("year")
            if "cvv" in lowered or "cvc" in lowered:
                return FakeLocator("cvv")
            return FakeLocator(selector, ready=False)

        def get_by_label(self, name):
            return FakeLocator(str(name), ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(f"{role}:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(f"text:{text}", ready=False)

    payment_module._fill_ctf_payment_form(
        FakePage(),
        {
            "email": "test.buyer@example.com",
            "password": "TEST_Password_123!",
            "first_name": "Test",
            "last_name": "User",
            "name": "Test User",
            "address_line1": "123 Test Avenue",
            "city": "Testville",
            "postal_code": "94105",
            "card_number": "4242424242424242",
            "card_exp_month": "12",
            "card_exp_year": "2030",
            "card_cvv": "123",
        },
    )

    assert fills["card"] == "4242424242424242"
    assert fills["exp"] == "12/2030"
    assert fills["month"] == "12"
    assert fills["year"] == "2030"
    assert fills["cvv"] == "123"


def test_complete_ctf_sandbox_flow_does_not_submit_when_payment_form_is_unfilled(monkeypatch):
    state = {"submits": 0}

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def count(self):
            return 0

        def is_visible(self):
            return False

        def is_enabled(self):
            return False

    class FakePage:
        url = "https://ctf-sandbox.example/create"

        def locator(self, selector):
            return FakeLocator()

        def get_by_label(self, name):
            return FakeLocator()

        def get_by_role(self, role, name=None):
            return FakeLocator()

        def get_by_text(self, text):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            pass

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", lambda page, **kwargs: False)

    def fake_submit(page, **kwargs):
        state["submits"] += 1

    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", fake_submit)

    try:
        payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=lambda message: None)
    except RuntimeError as exc:
        assert "未填写" in str(exc) or "未找到" in str(exc)
    else:
        raise AssertionError("expected payment form fill failure")

    assert state["submits"] == 0


def test_complete_ctf_sandbox_flow_does_not_wait_for_create_account_page_load(monkeypatch):
    labels = []
    state = {"stage": "start"}

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: labels.append(kwargs["label"]))
    monkeypatch.setattr(
        payment_module,
        "_open_ctf_create_account_and_continue",
        lambda *args, **kwargs: state.update(stage="payment", email_filled="create"),
    )
    monkeypatch.setattr(
        payment_module,
        "_wait_for_ctf_after_continue_ready",
        lambda *args, **kwargs: state.update(after_continue=state["stage"]),
    )
    monkeypatch.setattr(payment_module, "_click_ctf_create_account", lambda page: state.update(stage="create"))
    monkeypatch.setattr(payment_module, "_ctf_signup_form_ready", lambda page: state["stage"] == "create", raising=False)
    monkeypatch.setattr(payment_module, "_ctf_after_continue_ready", lambda page: state["stage"] == "payment", raising=False)
    monkeypatch.setattr(payment_module, "_fill_ctf_signup_email", lambda page, identity: state.update(email_filled=state["stage"]))
    monkeypatch.setattr(payment_module, "_click_ctf_continue_to_payment", lambda page: state.update(stage="payment"))
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda page: False)
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", lambda page, **kwargs: False)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: state.update(payment_filled=True))
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: state.update(submitted=True))
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "214849")
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda page, code, **kwargs: state.update(code=code))
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda page, **kwargs: "https://chatgpt.com/")

    result = payment_module._complete_ctf_sandbox_flow(object(), timeout_ms=30000, log=lambda message: None)

    assert result["status"] == "ctf_completed"
    assert state["email_filled"] == "create"
    assert "create account 页面" not in labels


def test_complete_ctf_sandbox_flow_skips_stale_create_retry_when_email_form_is_visible(monkeypatch):
    state = {"create_calls": 0}

    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_ctf_signup_form_ready", lambda page: True, raising=False)
    monkeypatch.setattr(payment_module, "_ctf_after_continue_ready", lambda page: state.get("continued") is True, raising=False)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda *args, **kwargs: None)

    def stale_create(page):
        state["create_calls"] += 1
        raise RuntimeError("create button is gone")

    monkeypatch.setattr(payment_module, "_click_ctf_create_account", stale_create)
    monkeypatch.setattr(payment_module, "_fill_ctf_signup_email", lambda page, identity: state.update(email_filled=True))
    monkeypatch.setattr(payment_module, "_click_ctf_continue_to_payment", lambda page: state.update(continued=True))
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", lambda page, **kwargs: False)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: state.update(payment_filled=True))
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: state.update(submitted=True))
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "214849")
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda page, code, **kwargs: state.update(code=code))
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda page, **kwargs: "https://chatgpt.com/")

    result = payment_module._complete_ctf_sandbox_flow(object(), timeout_ms=30000, log=lambda message: None)

    assert result["status"] == "ctf_completed"
    assert state["create_calls"] == 0
    assert state["email_filled"] is True


def test_wait_for_ctf_after_continue_follows_paypal_onboarding_redirect(monkeypatch):
    logs = []
    state = {"advanced": False}

    class FakeLocator:
        first = None

        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def inner_text(self, **kwargs):
            return (
                '0:{"a":"$@1"}\n'
                '1:{"isExisting":false,"onboardingRedirectUrl":'
                '"https://www.paypal.com/agreements/approve?ba_token=BA-123&locale.x=en_US&country.x=US"}'
            )

        def count(self):
            return 0

    class FakePage:
        def __init__(self):
            self.url = "https://www.paypal.com/pay?token=BA-123&ul=1"
            self.gotos = []

        def locator(self, selector):
            return FakeLocator(self, selector)

        def goto(self, url, **kwargs):
            self.gotos.append((url, kwargs))
            self.url = url

        def wait_for_timeout(self, timeout):
            pass

    page = FakePage()

    def fake_advance(current_page, **kwargs):
        state["advanced"] = True
        assert current_page.url.startswith("https://www.paypal.com/agreements/approve")
        current_page.url = "https://ctf-sandbox.example/create"
        return current_page.url

    monkeypatch.setattr(payment_module, "_advance_paypal_intermediate_pages", fake_advance)
    monkeypatch.setattr(payment_module, "_ctf_after_continue_ready", lambda current_page: current_page.url.startswith("https://ctf-sandbox.example"), raising=False)

    payment_module._wait_for_ctf_after_continue_ready(page, timeout_ms=30000, log=logs.append)

    assert page.gotos == [
        (
            "https://www.paypal.com/agreements/approve?ba_token=BA-123&locale.x=en_US&country.x=US",
            {"wait_until": "domcontentloaded", "timeout": 30000},
        )
    ]
    assert state["advanced"] is True
    assert any("onboardingRedirectUrl" in message for message in logs)


def test_open_ctf_create_account_clicks_once_when_form_appears():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=True):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def click(self, **kwargs):
            events.append(("click", self.selector))
            if "Create an account" in self.selector:
                self.page.form_ready = True
            if "Continue to Payment" in self.selector:
                self.page.continued = True

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

    class FakePage:
        def __init__(self):
            self.form_ready = False
            self.continued = False
            self.values = {}
            self.waits = []

        def wait_for_timeout(self, timeout):
            self.waits.append(timeout)

        def locator(self, selector):
            if selector == 'button:has-text("Create an account")':
                return FakeLocator(self, selector, ready=True)
            if selector in {'input[type="email"]', 'button:has-text("Continue to Payment")'}:
                return FakeLocator(self, selector, ready=self.form_ready)
            return FakeLocator(self, selector, ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=False)

    page = FakePage()
    identity = {"email": "ctf.test@example.gmail.com"}

    payment_module._open_ctf_create_account_and_continue(
        page,
        identity,
        log=lambda message: None,
    )

    assert [event for event in events if event[0] == "click" and "Create an account" in event[1]] == [
        ("click", 'button:has-text("Create an account")')
    ]
    assert ("fill", 'input[type="email"]', "ctf.test@example.gmail.com") in events
    assert page.waits == [3000]
    assert page.continued is True


def test_open_ctf_create_account_fails_after_three_clicks_without_form():
    state = {"create_clicks": 0, "waits": []}

    class FakeLocator:
        first = None

        def __init__(self, selector, ready):
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "BUTTON"

        def click(self, **kwargs):
            if "Create an account" in self.selector:
                state["create_clicks"] += 1

    class FakePage:
        def wait_for_timeout(self, timeout):
            state["waits"].append(timeout)

        def locator(self, selector):
            return FakeLocator(selector, ready='button:has-text("Create an account")' == selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(f"role:{role}:{name}", ready=False)

        def get_by_label(self, name):
            return FakeLocator(f"label:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(f"text:{text}", ready=False)

    try:
        payment_module._open_ctf_create_account_and_continue(
            FakePage(),
            {"email": "ctf.test@example.gmail.com"},
            log=lambda message: None,
        )
    except RuntimeError as exc:
        assert "create an account" in str(exc).lower()
    else:
        raise AssertionError("expected create-account failure")

    assert state["create_clicks"] == 3
    assert state["waits"] == [3000, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] * 3


def test_open_ctf_create_account_polls_form_for_five_seconds_after_click():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=True):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def click(self, **kwargs):
            events.append(("click", self.selector, self.page.elapsed_ms))
            if "Continue to Payment" in self.selector:
                self.page.continued = True

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value, self.page.elapsed_ms))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

    class FakePage:
        def __init__(self):
            self.elapsed_ms = 0
            self.continued = False
            self.values = {}

        @property
        def form_ready(self):
            return self.elapsed_ms >= 4500

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))
            self.elapsed_ms += timeout

        def locator(self, selector):
            if selector == 'button:has-text("Create an account")':
                return FakeLocator(self, selector, ready=True)
            if selector in {'input[type="email"]', 'button:has-text("Continue to Payment")'}:
                return FakeLocator(self, selector, ready=self.form_ready)
            return FakeLocator(self, selector, ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=False)

    page = FakePage()

    payment_module._open_ctf_create_account_and_continue(
        page,
        {"email": "ctf.test@example.gmail.com"},
        log=lambda message: None,
    )

    create_clicks = [event for event in events if event[0] == "click" and "Create an account" in event[1]]
    assert create_clicks == [("click", 'button:has-text("Create an account")', 0)]
    assert ("wait", 3000) in events
    assert ("wait", 500) in events
    assert ("fill", 'input[type="email"]', "ctf.test@example.gmail.com", 4500) in events
    assert page.continued is True


def test_open_ctf_create_account_clicks_create_even_if_paypal_page_mentions_challenge(monkeypatch):
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=True):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def click(self, **kwargs):
            events.append(("click", self.selector))
            if "Create an account" in self.selector:
                self.page.form_ready = True
            if "Continue to Payment" in self.selector:
                self.page.continued = True

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123"

        def __init__(self):
            self.form_ready = False
            self.continued = False
            self.values = {}

        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            if selector == 'button:has-text("Create an account")':
                return FakeLocator(self, selector, ready=True)
            if selector in {'input[type="email"]', 'button:has-text("Continue to Payment")'}:
                return FakeLocator(self, selector, ready=self.form_ready)
            return FakeLocator(self, selector, ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=False)

    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda page: True)

    page = FakePage()
    payment_module._open_ctf_create_account_and_continue(
        page,
        {"email": "ctf.test@example.gmail.com"},
        log=lambda message: None,
    )

    assert ("click", 'button:has-text("Create an account")') in events
    assert ("fill", 'input[type="email"]', "ctf.test@example.gmail.com") in events
    assert page.continued is True


def test_open_ctf_create_account_prefers_create_button_on_paypal_mock_even_when_form_is_visible():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=True):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def click(self, **kwargs):
            events.append(("click", self.selector))
            if "Create an account" in self.selector:
                self.page.create_clicked = True
            if "Continue to Payment" in self.selector:
                self.page.continued = True

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123"

        def __init__(self):
            self.create_clicked = False
            self.continued = False
            self.values = {}

        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            if selector == 'button:has-text("Create an account")':
                return FakeLocator(self, selector, ready=True)
            if selector in {'input[type="email"]', 'button:has-text("Continue to Payment")'}:
                return FakeLocator(self, selector, ready=True)
            return FakeLocator(self, selector, ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=False)

    page = FakePage()

    payment_module._open_ctf_create_account_and_continue(
        page,
        {"email": "ctf.test@example.gmail.com"},
        log=lambda message: None,
    )

    assert events[0] == ("click", 'button:has-text("Create an account")')
    assert ("fill", 'input[type="email"]', "ctf.test@example.gmail.com") in events[1:]
    assert page.continued is True


def test_complete_ctf_sandbox_flow_skips_initial_page_load_wait_on_paypal_mock(monkeypatch):
    labels = []
    state = {}

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: labels.append(kwargs["label"]))
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: state.update(opened=True))
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: state.update(after_continue=True))
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", lambda page, **kwargs: False)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: state.update(payment_filled=True))
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: state.update(submitted=True))
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "214849")
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda page, code, **kwargs: state.update(code=code))
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda page, **kwargs: "https://chatgpt.com/")

    result = payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=lambda message: None)

    assert result["status"] == "ctf_completed"
    assert len(labels) == 1
    assert "PayPal" not in labels[0]


def test_ctf_verification_popup_ignores_generic_dialog_without_code():
    class FakeLocator:
        first = None

        def __init__(self, ready):
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

    class FakePage:
        def locator(self, selector):
            return FakeLocator(selector == '[role="dialog"]')

        def get_by_text(self, text):
            return FakeLocator(False)

    assert payment_module._ctf_verification_popup_visible(FakePage()) is False


def test_ctf_verification_popup_ignores_payment_form_code_fields():
    class FakeLocator:
        first = None

        def __init__(self, ready):
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

    class FakePage:
        def locator(self, selector):
            return FakeLocator(selector in {
                'input[name*="code" i]',
                'input[autocomplete="postal-code"]',
                'input[autocomplete="cc-csc"]',
            })

        def get_by_text(self, text):
            return FakeLocator("security code" in str(text).lower())

    assert payment_module._ctf_verification_popup_visible(FakePage()) is False


def test_ctf_verification_popup_detects_paypal_sca_multi_field():
    class FakeLocator:
        first = None

        def __init__(self, ready):
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

    class FakePage:
        def locator(self, selector):
            return FakeLocator(selector in {
                '[data-testid="sca-confirm-multi-field"]',
                '[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"]',
                '#ciBasic input[name^="ciBasic-"]',
                'input[name^="ciBasic-"]',
                'input[id^="ci-ciBasic-"]',
            })

        def get_by_text(self, text):
            return FakeLocator("enter.*code" in str(text).lower() or "6" in str(text))

    assert payment_module._ctf_verification_popup_visible(FakePage()) is True


def test_click_ctf_submit_waits_ten_seconds_for_code_popup():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=True):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "BUTTON"

        def click(self, **kwargs):
            events.append(("click", self.selector))
            self.page.submitted = True

    class FakePage:
        def __init__(self):
            self.submitted = False

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))

        def locator(self, selector):
            if selector == 'button[type="submit"]':
                return FakeLocator(self, selector, ready=True)
            if selector == '[data-testid="sca-confirm-multi-field"]':
                return FakeLocator(self, selector, ready=self.submitted)
            return FakeLocator(self, selector, ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=False)

    payment_module._click_ctf_submit_until_code_popup(FakePage(), log=lambda message: None)

    assert ("wait", 10000) in events


def test_fill_ctf_verification_code_populates_paypal_sca_digits():
    fills = []

    class FakeLocator:
        first = None

        def __init__(self, selector, index=None, count_value=6):
            self.selector = selector
            self.index = index
            self.count_value = count_value
            self.first = self

        def count(self):
            return self.count_value

        def nth(self, index):
            return FakeLocator(self.selector, index=index, count_value=1)

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def fill(self, value, **kwargs):
            fills.append((self.index, value))

    class FakePage:
        def locator(self, selector):
            if selector == '[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"]':
                return FakeLocator(selector, count_value=6)
            return FakeLocator(selector, count_value=0)

        def get_by_label(self, name):
            return FakeLocator(f"label:{name}", count_value=0)

        def get_by_role(self, role, name=None):
            return FakeLocator(f"role:{role}:{name}", count_value=0)

        def get_by_text(self, text):
            return FakeLocator(f"text:{text}", count_value=0)

    payment_module._fill_ctf_verification_code(FakePage(), "214849")

    assert fills == [(0, "2"), (1, "1"), (2, "4"), (3, "8"), (4, "4"), (5, "9")]


def test_advance_paypal_review_clicks_agree_and_continue():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready=False):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "BUTTON"

        def click(self, **kwargs):
            events.append(("click", self.selector))
            self.page.url = "https://chatgpt.com/"

    class FakePage:
        def __init__(self):
            self.url = "https://www.paypal.com/webapps/hermes?ba_token=BA-123"

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_function(self, expression, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            return FakeLocator(
                self,
                selector,
                ready=selector == 'button:has-text("Agree and Continue")',
            )

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", ready=False)

    final_url = payment_module._advance_paypal_review_if_needed(
        FakePage(),
        timeout_ms=30000,
        log=lambda message: None,
    )

    assert final_url == "https://chatgpt.com/"
    assert events == [("click", 'button:has-text("Agree and Continue")')]


def test_complete_ctf_sandbox_flow_accepts_paypal_review_before_waiting_return(monkeypatch):
    state = {"order": []}

    class FakePage:
        url = "https://ctf-sandbox.example/create"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "214849")

    def fake_fill_code(page, code, **_kwargs):
        state["order"].append("fill_code")
        page.url = "https://www.paypal.com/webapps/hermes?ba_token=BA-123"

    def fake_review(page, **kwargs):
        state["order"].append("review")
        assert page.url.startswith("https://www.paypal.com/webapps/hermes")
        page.url = "https://chatgpt.com/"
        return page.url

    def fake_wait_return(page, **kwargs):
        state["order"].append("wait_return")
        assert page.url == "https://chatgpt.com/"
        return page.url

    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", fake_fill_code)
    monkeypatch.setattr(payment_module, "_advance_paypal_review_if_needed", fake_review)
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", fake_wait_return)

    result = payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=lambda message: None)

    assert result["status"] == "ctf_completed"
    assert result["final_url"] == "https://chatgpt.com/"
    assert state["order"] == ["fill_code", "review", "wait_return"]


def test_open_ctf_create_account_fills_visible_form_inside_dialog():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

        def click(self, **kwargs):
            events.append(("click", self.selector))
            if "Continue to Payment" in self.selector:
                self.page.continued = True

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123&ul=1"

        def __init__(self):
            self.values = {}
            self.continued = False

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))

        def locator(self, selector):
            ready_selectors = {
                '[role="dialog"]',
                'input[type="email"]',
                'button:has-text("Continue to Payment")',
            }
            return FakeLocator(self, selector, selector in ready_selectors)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", False)

    page = FakePage()

    payment_module._open_ctf_create_account_and_continue(
        page,
        {"email": "ctf.test@example.gmail.com"},
        log=lambda message: None,
    )

    assert ("fill", 'input[type="email"]', "ctf.test@example.gmail.com") in events
    assert ("click", 'button:has-text("Continue to Payment")') in events
    assert page.continued is True


def test_paypal_mock_create_account_does_not_skip_when_payment_fields_exist():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def inner_text(self, **kwargs):
            return "Create a PayPal account"

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

        def click(self, **kwargs):
            events.append(("click", self.selector))
            if "Create an account" in self.selector:
                self.page.form_ready = True
            if self.selector in {'button[type="submit"]', 'button:has-text("Continue to Payment")'}:
                self.page.continued = True

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123&ul=1"

        def __init__(self):
            self.form_ready = False
            self.continued = False
            self.values = {}

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))

        def locator(self, selector):
            if selector == "body":
                return FakeLocator(self, selector, True)
            if selector == 'button:has-text("Create an account")':
                return FakeLocator(self, selector, not self.form_ready)
            if selector in {'input[type="email"]', 'button:has-text("Continue to Payment")', 'button[type="submit"]'}:
                return FakeLocator(self, selector, self.form_ready)
            if selector in {'input[type="tel"]', 'input[type="password"]'}:
                return FakeLocator(self, selector, True)
            return FakeLocator(self, selector, False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", False)

    page = FakePage()

    payment_module._open_ctf_create_account_and_continue(
        page,
        {"email": "ctf.test@example.gmail.com"},
        log=lambda message: None,
    )

    assert ("click", 'button:has-text("Create an account")') in events
    assert ("fill", 'input[type="email"]', "ctf.test@example.gmail.com") in events
    assert page.continued is True


def test_paypal_mock_create_account_continues_when_create_button_disappears_before_form_ready():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, ready):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") else "BUTTON"

        def inner_text(self, **kwargs):
            return "Create a PayPal account"

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

        def click(self, **kwargs):
            events.append(("click", self.selector))
            if self.selector in {'button[type="submit"]', 'button:has-text("Continue to Payment")'}:
                self.page.continued = True

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123&ul=1"

        def __init__(self):
            self.form_ready = False
            self.continued = False
            self.values = {}

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))
            self.form_ready = True

        def locator(self, selector):
            if selector == "body":
                return FakeLocator(self, selector, True)
            if selector in {'input[type="email"]', 'button:has-text("Continue to Payment")', 'button[type="submit"]'}:
                return FakeLocator(self, selector, self.form_ready)
            return FakeLocator(self, selector, False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", False)

    page = FakePage()

    payment_module._open_ctf_create_account_and_continue(
        page,
        {"email": "ctf.test@example.gmail.com"},
        log=lambda message: None,
    )

    assert ("wait", 3000) in events
    assert ("fill", 'input[type="email"]', "ctf.test@example.gmail.com") in events
    assert page.continued is True


def test_paypal_mock_create_account_detects_login_email_dom_after_click_timeout():
    events = []

    class FakeLocator:
        first = None

        def __init__(self, page, selector, visible, enabled=True):
            self.page = page
            self.selector = selector
            self.visible = visible
            self.enabled = enabled
            self.first = self

        def count(self):
            return 1 if self.visible else 0

        def is_visible(self):
            return self.visible

        def is_enabled(self):
            return self.enabled

        def evaluate(self, script):
            return "INPUT" if self.selector.startswith("input") or self.selector.startswith("#login_email") else "BUTTON"

        def inner_text(self, **kwargs):
            return "Create a PayPal account"

        def fill(self, value, **kwargs):
            events.append(("fill", self.selector, value))
            self.page.values[self.selector] = value

        def input_value(self, **kwargs):
            return self.page.values.get(self.selector, "")

        def click(self, **kwargs):
            events.append(("click", self.selector))
            if "Create an account" in self.selector:
                raise RuntimeError("click timed out after transition")
            if self.selector in {
                'button[data-testid="continueButton"]',
                'button[data-atomic-wait-intent="Continue_To_Payment"]',
            }:
                self.page.continued = True

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123&ul=1"

        def __init__(self):
            self.form_ready = False
            self.continued = False
            self.values = {}

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))
            self.form_ready = True

        def locator(self, selector):
            if selector == "body":
                return FakeLocator(self, selector, True)
            if selector == 'button:has-text("Create an account")':
                return FakeLocator(self, selector, not self.form_ready)
            if selector in {
                "#login_email",
                'input[name="login_email"]',
                'input[autocomplete="username"]',
            }:
                return FakeLocator(self, selector, self.form_ready)
            if selector in {
                'button[data-testid="continueButton"]',
                'button[data-atomic-wait-intent="Continue_To_Payment"]',
            }:
                return FakeLocator(self, selector, self.form_ready, enabled=True)
            return FakeLocator(self, selector, False)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", False)

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", False)

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", False)

    page = FakePage()

    payment_module._open_ctf_create_account_and_continue(
        page,
        {"email": "ctf.test@example.gmail.com"},
        log=lambda message: None,
    )

    assert ("wait", 3000) in events
    assert ("fill", "#login_email", "ctf.test@example.gmail.com") in events
    assert page.continued is True


def test_paypal_mock_security_challenge_requires_visible_text(monkeypatch):
    logs = []

    class FakeBody:
        def inner_text(self, **kwargs):
            return "Create a PayPal account"

    class FakeFrame:
        url = "https://captcha.example/challenge"

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def count(self):
            return 0

        def is_visible(self):
            return False

        def is_enabled(self):
            return False

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123&ul=1"
        frames = [FakeFrame()]

        def locator(self, selector):
            if selector == "body":
                return FakeBody()
            return FakeLocator()

        def get_by_role(self, role, name=None):
            return FakeLocator()

        def get_by_label(self, name):
            return FakeLocator()

        def get_by_text(self, text):
            return FakeLocator()

    assert payment_module._wait_for_manual_security_challenge(
        FakePage(),
        timeout_ms=1000,
        log=logs.append,
    ) is False
    assert not any("security challenge" in message.lower() for message in logs)


def test_paypal_mock_security_challenge_triggers_when_real_turnstile_sitekey(monkeypatch):
    """PayPal mock 页面 body 无 challenge 文字，但 frames 里有真实的 Cloudflare
    Turnstile iframe（能抠出 sitekey）→ 应当触发 captcha solver 求解，并最终通过。"""
    logs = []
    solver_calls = []

    class FakeBody:
        def inner_text(self, **kwargs):
            return "Create a PayPal account"  # 主文本没 challenge 字样

    # 真实 Cloudflare Turnstile iframe URL
    cf_url = "https://challenges.cloudflare.com/turnstile/v0/0x4AAAAAAA_real_key"
    state = {"challenge_visible": True}

    class FakeFrame:
        url = cf_url

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123&ul=1"
        frames = [FakeFrame()]

        def locator(self, selector):
            if selector == "body":
                return FakeBody()
            return _FakeNoopLocator()

        def get_by_role(self, role, name=None):
            return _FakeNoopLocator()

        def get_by_label(self, name):
            return _FakeNoopLocator()

        def get_by_text(self, text):
            return _FakeNoopLocator()

        def evaluate(self, _script, *_args, **_kwargs):
            # 模拟 page.evaluate 抠 sitekey 行为：从 iframe URL 抠
            return ""

        def wait_for_timeout(self, _ms):
            # 第一次轮询后让 challenge 消失（模拟求解成功）
            state["challenge_visible"] = False

    def fake_inject(page, token):
        return True

    def fake_solver(page_url, site_key, challenge_type="turnstile"):
        solver_calls.append({"page_url": page_url, "site_key": site_key, "type": challenge_type})
        return "RESOLVED_TOKEN_ABC"

    # 让 _challenge_still_visible 在第一次进入后变 False（依据 state）
    real_extract_turnstile = payment_module._extract_turnstile_sitekey
    real_has_text = payment_module._has_security_challenge_text

    def patched_extract_turnstile(page):
        if not state["challenge_visible"]:
            return ""
        return real_extract_turnstile(page)

    def patched_has_text(page):
        if not state["challenge_visible"]:
            return False
        return real_has_text(page)

    monkeypatch.setattr(payment_module, "_extract_turnstile_sitekey", patched_extract_turnstile)
    monkeypatch.setattr(payment_module, "_has_security_challenge_text", patched_has_text)
    monkeypatch.setattr(payment_module, "_inject_turnstile_token", fake_inject)

    result = payment_module._wait_for_manual_security_challenge(
        FakePage(),
        timeout_ms=5000,
        log=logs.append,
        turnstile_solver=fake_solver,
    )

    assert result is True
    assert len(solver_calls) == 1
    assert solver_calls[0]["site_key"] == "0x4AAAAAAA_real_key"
    assert any("captcha 服务" in m.lower() or "验证码服务" in m for m in logs)


class _FakeNoopLocator:
    first = None

    def __init__(self):
        self.first = self

    def count(self):
        return 0

    def is_visible(self):
        return False

    def is_enabled(self):
        return False


def test_complete_ctf_sandbox_flow_labels_paypal_mock_create_flow(monkeypatch):
    logs = []
    labels = []
    state = {"stage": "start"}

    class FakePage:
        url = "https://www.paypal.com/pay?token=BA-123&ul=1"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: labels.append(kwargs["label"]))
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: state.update(opened=True))
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", lambda page, **kwargs: False)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: state.update(payment_filled=True))
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: state.update(submitted=True))
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "214849")
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda page, code, **kwargs: state.update(code=code))
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda page, **kwargs: "https://chatgpt.com/")

    result = payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=logs.append)

    assert result["status"] == "ctf_completed"
    assert any("PayPal mock" in message for message in logs)
    assert all("PayPal" not in label for label in labels)


def test_patch_playwright_firefox_pageerror_location_bug(tmp_path):
    bundle = tmp_path / "coreBundle.js"
    bundle.write_text(
        """
location: {
  url: pageError.location.url,
  line: pageError.location.lineNumber,
  column: pageError.location.columnNumber
}
location: {
  url: pageError.location.url,
  line: pageError.location.lineNumber,
  column: pageError.location.columnNumber
}
""",
        encoding="utf-8",
    )

    changed = payment_module._patch_playwright_firefox_pageerror_location_bug(
        bundle_path=bundle,
        log_fn=lambda message: None,
    )

    patched = bundle.read_text(encoding="utf-8")
    assert changed is True
    assert "pageError.location.url" not in patched
    assert "pageError.location?.url || \"\"" in patched
    assert "pageError.location?.lineNumber || 0" in patched
    assert "pageError.location?.columnNumber || 0" in patched
    assert payment_module._patch_playwright_firefox_pageerror_location_bug(
        bundle_path=bundle,
        log_fn=lambda message: None,
    ) is False


def test_patch_playwright_firefox_ignores_orphan_websocket_open_event(tmp_path):
    bundle = tmp_path / "coreBundle.js"
    bundle.write_text(
        """
      _onWebSocketOpened(event) {
        const request2 = this._webSocketRequests.get(event.requestId);
        assert(request2);
        const response2 = this._webSocketResponses.get(event.requestId);
        assert(response2);
        this._webSocketRequests.delete(event.requestId);
        this._webSocketResponses.delete(event.requestId);
      }
""",
        encoding="utf-8",
    )

    changed = payment_module._patch_playwright_firefox_pageerror_location_bug(
        bundle_path=bundle,
        log_fn=lambda message: None,
    )

    patched = bundle.read_text(encoding="utf-8")
    assert changed is True
    assert "assert(request2)" not in patched
    assert "assert(response2)" not in patched
    assert "if (!request2 || !response2)" in patched
    assert "this._webSocketRequests.delete(event.requestId)" in patched
    assert "this._webSocketResponses.delete(event.requestId)" in patched
    assert "this._page.frameManager.onWebSocketRequest(webSocketId(event.frameId, event.wsid))" in patched
    assert payment_module._patch_playwright_firefox_pageerror_location_bug(
        bundle_path=bundle,
        log_fn=lambda message: None,
    ) is False


def test_probe_camoufox_proxy_exit_logs_browser_ip():
    logs = []

    class FakeBody:
        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

    class FakePage:
        def __init__(self):
            self.urls = []

        def goto(self, url, **kwargs):
            self.urls.append((url, kwargs))

        def locator(self, selector):
            assert selector == "body"
            return FakeBody()

    result = payment_module._probe_camoufox_proxy_exit(
        FakePage(),
        log=lambda message: logs.append(message),
    )

    assert result == {"ok": True, "ip": "203.0.113.10", "source": "https://api.ipify.org?format=json"}
    assert any("203.0.113.10" in message for message in logs)


def test_build_camoufox_proxy_parses_auth_without_scheme():
    proxy = payment_module._build_camoufox_proxy("user:pass@proxy.example:8080")

    assert proxy == {
        "server": "http://proxy.example:8080",
        "username": "user",
        "password": "pass",
    }


def test_build_camoufox_proxy_parses_host_port_user_pass_format():
    proxy = payment_module._build_camoufox_proxy("proxy.example:8080:user:pass")

    assert proxy == {
        "server": "http://proxy.example:8080",
        "username": "user",
        "password": "pass",
    }


def test_build_camoufox_proxy_defaults_scheme_for_host_port():
    proxy = payment_module._build_camoufox_proxy("proxy.example:8080")

    assert proxy == {"server": "http://proxy.example:8080"}


def test_build_camoufox_proxy_unquotes_encoded_credentials():
    proxy = payment_module._build_camoufox_proxy("http://user:p%40ss%3Aword@proxy.example:8080")

    assert proxy == {
        "server": "http://proxy.example:8080",
        "username": "user",
        "password": "p@ss:word",
    }


def test_chatgpt_payment_link_action_uses_stored_access_token_and_currency(monkeypatch):
    captured = {}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None):
        captured["access_token"] = account_arg.access_token
        captured["cookies"] = account_arg.cookies
        captured["country"] = country
        captured["currency"] = currency
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "open_url_incognito", lambda url, cookies: True)

    platform = ChatGPTPlatform(config=RegisterConfig())
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )

    result = platform.execute_action(
        "payment_link",
        account,
        {"plan": "plus", "country": "ID", "currency": "IDR", "auto_checkout": "false"},
    )

    assert result["ok"] is True
    assert result["data"]["url"] == "https://checkout.stripe.com/c/pay/cs_test_plus"
    assert result["data"]["cashier_url"] == "https://checkout.stripe.com/c/pay/cs_test_plus"
    assert captured == {
        "access_token": "at_123",
        "cookies": "__Secure-next-auth.session-token=sess_123",
        "country": "ID",
        "currency": "IDR",
    }


def test_chatgpt_payment_link_auto_checkout_passes_browser_options(monkeypatch):
    captured = {}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None):
        captured["link_proxy"] = proxy
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    def fake_complete_paypal_checkout(**kwargs):
        captured.update(kwargs)
        return {"ok": True, "status": "submitted", "final_url": "https://paypal.test/done", "error": ""}

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "open_url_incognito", lambda url, cookies: True)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_complete_paypal_checkout, raising=False)

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )

    result = platform.execute_action(
        "payment_link",
        account,
        {
            "plan": "plus",
            "country": "US",
            "currency": "USD",
            "auto_checkout": "true",
            "payment_method": "paypal",
            "headless": "false",
            "checkout_timeout": 90,
            "checkout_hold_seconds": 12,
        },
    )

    assert result["ok"] is True
    assert result["data"]["checkout_automation"]["status"] == "submitted"
    assert captured["link_proxy"] is None
    assert captured["checkout_url"] == "https://checkout.stripe.com/c/pay/cs_test_plus"
    assert captured["cookies_str"] == "__Secure-next-auth.session-token=sess_123"
    assert captured["proxy"] == "http://us-proxy.example:8080"
    assert captured["email"] == "user@example.com"
    assert captured["payment_method"] == "paypal"
    assert captured["headless"] is False
    assert captured["timeout"] == 90
    assert captured["hold_seconds"] == 12


def test_chatgpt_payment_link_action_uses_proxy_pool_only_for_checkout_when_no_direct_proxy(monkeypatch):
    captured = {}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None):
        captured["link_proxy"] = proxy
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    def fake_complete_paypal_checkout(**kwargs):
        captured["checkout_proxy"] = kwargs["proxy"]
        return {"ok": True, "status": "submitted", "final_url": "https://paypal.test/done", "error": ""}

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_complete_paypal_checkout, raising=False)

    from platforms.chatgpt import plugin as plugin_module

    monkeypatch.setattr(plugin_module.proxy_pool, "get_next", lambda region="": f"http://{region.lower()}-proxy.example:8080")

    platform = ChatGPTPlatform(config=RegisterConfig())
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )

    result = platform.execute_action(
        "payment_link",
        account,
        {"plan": "plus", "country": "US", "currency": "USD", "auto_checkout": "true"},
    )

    assert result["ok"] is True
    assert captured["link_proxy"] is None
    assert captured["checkout_proxy"] == "http://us-proxy.example:8080"
    assert result["data"]["proxy_used"] == "http://us-proxy.example:8080"


def test_chatgpt_payment_link_auto_checkout_failure_fails_action(monkeypatch):
    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None):
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    def fake_complete_paypal_checkout(**kwargs):
        return {
            "ok": False,
            "status": "failed",
            "final_url": "https://checkout.stripe.com/c/pay/cs_test_plus",
            "error": "PayPal button not found",
        }

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_complete_paypal_checkout, raising=False)

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )

    result = platform.execute_action(
        "payment_link",
        account,
        {"plan": "plus", "country": "US", "currency": "USD", "auto_checkout": "true"},
    )

    assert result["ok"] is False
    assert "PayPal button not found" in result["error"]
    assert result["data"]["checkout_automation"]["status"] == "failed"
    assert result["data"]["message"] == "Payment link generated, but PayPal checkout automation failed."


def test_chatgpt_payment_link_runs_checkout_in_worker_thread_inside_event_loop(monkeypatch):
    captured = {}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None):
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    def fake_complete_paypal_checkout(**kwargs):
        captured["checkout_thread_id"] = threading.get_ident()
        return {"ok": True, "status": "submitted", "final_url": "https://paypal.test/done", "error": ""}

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_complete_paypal_checkout, raising=False)

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )

    async def run_action():
        captured["event_loop_thread_id"] = threading.get_ident()
        return platform.execute_action(
            "payment_link",
            account,
            {"plan": "plus", "country": "US", "currency": "USD", "auto_checkout": "true"},
        )

    result = asyncio.run(run_action())

    assert result["ok"] is True
    assert captured["checkout_thread_id"] != captured["event_loop_thread_id"]


def test_chatgpt_payment_link_always_runs_checkout_in_worker_thread(monkeypatch):
    captured = {"caller_thread_id": threading.get_ident()}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None):
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    def fake_complete_paypal_checkout(**kwargs):
        captured["checkout_thread_id"] = threading.get_ident()
        return {"ok": True, "status": "submitted", "final_url": "https://paypal.test/done", "error": ""}

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_complete_paypal_checkout, raising=False)

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )

    result = platform.execute_action(
        "payment_link",
        account,
        {"plan": "plus", "country": "US", "currency": "USD", "auto_checkout": "true"},
    )

    assert result["ok"] is True
    assert captured["checkout_thread_id"] != captured["caller_thread_id"]


def test_chatgpt_payment_link_can_skip_auto_checkout(monkeypatch):
    called = {"checkout": False, "legacy_browser": False}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None):
        called["link_proxy"] = proxy
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    def fake_complete_paypal_checkout(**kwargs):
        called["checkout"] = True
        return {"ok": True, "status": "submitted", "final_url": "", "error": ""}

    def fake_open_url_incognito(url, cookies):
        called["legacy_browser"] = True
        return True

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "open_url_incognito", fake_open_url_incognito)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_complete_paypal_checkout, raising=False)
    from platforms.chatgpt import plugin as plugin_module

    monkeypatch.setattr(
        plugin_module.proxy_pool,
        "get_next",
        lambda region="": (_ for _ in ()).throw(AssertionError("proxy pool should not be used without checkout")),
    )

    platform = ChatGPTPlatform(config=RegisterConfig())
    account = Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )

    result = platform.execute_action(
        "payment_link",
        account,
        {"plan": "plus", "country": "US", "currency": "USD", "auto_checkout": "false"},
    )

    assert result["ok"] is True
    assert called == {"checkout": False, "legacy_browser": False, "link_proxy": None}
    assert "checkout_automation" not in result["data"]
    assert result["data"]["proxy_used"] == ""


def test_complete_paypal_checkout_uses_camoufox_and_submits(monkeypatch):
    state = {}
    logs = []

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def input_value(self, **kwargs):
            return ""

        def wait_for(self, **kwargs):
            self.page.events.append(("wait_for_locator", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def __init__(self):
            self.cookies = []

        def add_cookies(self, cookies):
            self.cookies.extend(cookies)

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            self.events.append(("timeout", timeout))

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            self.events.append(("load_state", args, kwargs))

        def wait_for_function(self, expression, **kwargs):
            self.events.append(("wait_for_function", expression, kwargs))

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

        def locator(self, selector):
            self.events.append(("locator", selector))
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            self.events.append(("role", role, str(name)))
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            self.events.append(("label", str(name)))
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            self.events.append(("text", str(text)))
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            state["launch_opts"] = kwargs

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        cookies_str="__Secure-next-auth.session-token=sess_123; oai-did=did_123",
        proxy="http://user:pass@us-proxy.example:8080",
        email="user@example.com",
        payment_method="paypal",
        headless=False,
        timeout=90,
        hold_seconds=0,
        log_fn=logs.append,
    )

    page = state["page"]
    assert result["ok"] is True
    assert result["status"] == "submitted"
    assert result["final_url"] == "https://payments.example/checkout-complete?token=debug"
    assert state["launch_opts"] == {
        "headless": False,
        "addons": [],
        "persistent_context": False,
        "humanize": False,
        "block_webrtc": True,
        "locale": ["en-US", "en"],
        "os": ("windows", "macos"),
        "exclude_addons": [payment_module.DefaultAddons.UBO],
        "proxy": {
            "server": "http://us-proxy.example:8080",
            "username": "user",
            "password": "pass",
        },
        "geoip": True,
    }
    paypal_event_index = next(
        index
        for index, event in enumerate(page.events)
        if event[0] in {"click", "check"} and "paypal" in event[1].lower()
    )
    assert any(event[0] == "locator" for event in page.events[:paypal_event_index])
    assert not any(event[0] in {"load_state", "wait_for_function", "wait_for_locator"} for event in page.events[:paypal_event_index])
    assert page.context.cookies[0]["name"] == "__Secure-next-auth.session-token"
    assert any("账单自动填写已停用" in message for message in logs)
    assert any(event[0] in {"click", "check"} and "paypal" in event[1].lower() for event in page.events)
    terms_index = next(
        index
        for index, event in enumerate(page.events)
        if event[0] in {"click", "check"} and any(token in event[1].lower() for token in ("terms", "agree"))
    )
    submit_index = next(
        index
        for index, event in enumerate(page.events)
        if event[0] == "click" and "submit" in event[1].lower()
    )
    assert terms_index < submit_index
    assert any(event[0] == "click" and "submit" in event[1].lower() for event in page.events)


def test_complete_paypal_checkout_retries_initial_checkout_navigation(monkeypatch):
    state = {"logs": []}

    class FakePage:
        def __init__(self):
            self.context = SimpleNamespace(add_cookies=lambda cookies: None)
            self.url = "about:blank"
            self.goto_calls = 0

        def goto(self, url, **kwargs):
            self.goto_calls += 1
            if self.goto_calls < 3:
                raise RuntimeError(
                    f"Page.goto: net::ERR_CONNECTION_CLOSED at {url}"
                )
            self.url = url

        def wait_for_timeout(self, timeout):
            pass

    class FakeContext:
        def __exit__(self, exc_type, exc, tb):
            return False

    page = FakePage()

    monkeypatch.setattr(
        payment_module,
        "_open_unique_camoufox_page",
        lambda *args, **kwargs: (FakeContext(), object(), page),
    )
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )
    monkeypatch.setattr(payment_module, "_probe_camoufox_proxy_exit", lambda page, *, log: {"ok": True})
    monkeypatch.setattr(payment_module, "_wait_checkout_page_ready", lambda page, *, timeout_ms, log: None)
    monkeypatch.setattr(payment_module, "_verify_checkout_is_free_trial", lambda page, *, log: None)
    monkeypatch.setattr(
        payment_module,
        "detect_paypal_stage",
        lambda page: {"stage": payment_module._STAGE_CHATGPT_SUCCESS},
    )
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://pay.openai.com/c/pay/cs_test_plus",
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert result["status"] == "completed"
    assert page.goto_calls == 3
    assert any("打开 ChatGPT 测试支付链接瞬时网络失败" in message for message in state["logs"])


def test_extract_paypal_authorize_link_protocol_runs_only_stripe_checkout(monkeypatch):
    captured: dict = {}

    def fake_run_protocol_checkout(**kwargs):
        captured.update(kwargs)
        return {
            "ok": True,
            "status": "stage_completed",
            "final_url": "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
            "stage": "stripe_checkout",
        }

    monkeypatch.setattr(
        payment_protocol,
        "run_protocol_checkout",
        fake_run_protocol_checkout,
    )
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "country": "US",
            "line1": "1 Main",
            "city": "New York",
            "state": "NY",
            "postal_code": "10001",
        },
    )

    result = payment_module.extract_paypal_authorize_link_protocol(
        checkout_url="https://pay.openai.com/c/pay/cs_live_demo",
        cookies_str="__Secure-next-auth.session-token=sess",
        proxy="http://proxy.example:8080",
        email="user@example.com",
        timeout=90,
        log_fn=lambda _message: None,
    )

    assert result["ok"] is True
    assert result["paypal_authorize_url"].startswith("https://pm-redirects.stripe.com/authorize/")
    assert captured["pipeline"] == [payment_protocol.proto_stage_stripe_checkout]
    assert captured["proxy"] == "http://proxy.example:8080"
    assert captured["address"]["postal_code"] == "10001"


def test_extract_paypal_authorize_link_go_failure_includes_gateway_code(monkeypatch):
    monkeypatch.setattr(payment_module.cffi_requests, "get", lambda *args, **kwargs: _Response({"ok": True}))

    def fake_post(url, **kwargs):
        return _Response(
            {
                "ok": False,
                "code": "stripe_confirm_network_error",
                "message": "上游网络短暂拥塞，本次未拿到有效 PayPal 授权链接",
            },
            status_code=502,
        )

    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)

    result = payment_module.extract_paypal_authorize_link_go(
        access_token="at_123",
        proxy="http://proxy.example:8080",
        gateway_url="http://127.0.0.1:8787",
        log_fn=lambda _message: None,
    )

    assert result["ok"] is False
    assert result["protocol_backend"] == "go"
    assert "stripe_confirm_network_error" in result["error"]
    assert "上游网络短暂拥塞" in result["error"]


def test_extract_paypal_authorize_link_go_fails_fast_when_gateway_health_unreachable(monkeypatch):
    calls = {"post": 0}

    def fake_get(url, **kwargs):
        raise RuntimeError("connection refused")

    def fake_post(url, **kwargs):
        calls["post"] += 1
        raise AssertionError("extract should not be called when gateway health is down")

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)

    result = payment_module.extract_paypal_authorize_link_go(
        access_token="at_123",
        proxy="http://proxy.example:8080",
        gateway_url="http://127.0.0.1:8787",
        timeout=180,
        log_fn=lambda _message: None,
    )

    assert result["ok"] is False
    assert result["protocol_backend"] == "go"
    assert "Go gateway 未响应" in result["error"]
    assert "127.0.0.1:8787/api/health" in result["error"]
    assert calls["post"] == 0


def test_extract_paypal_authorize_link_go_logs_gateway_health_and_wait(monkeypatch):
    logs = []

    def fake_get(url, **kwargs):
        assert url == "http://127.0.0.1:8787/api/health"
        assert kwargs["timeout"] == 5
        return _Response({"ok": True, "extract_queue_used": 2, "extract_queue_limit": 128})

    def fake_post(url, **kwargs):
        assert kwargs["timeout"] == 90
        return _Response(
            {
                "ok": True,
                "paypal_authorize_url": "https://pm-redirects.stripe.com/authorize/acct_123",
            }
        )

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)

    result = payment_module.extract_paypal_authorize_link_go(
        access_token="at_123",
        gateway_url="http://127.0.0.1:8787/",
        timeout=90,
        log_fn=logs.append,
    )

    assert result["ok"] is True
    assert any("Go gateway 健康检查通过" in item and "2/128" in item for item in logs)
    assert any("最长等待 90s" in item for item in logs)


def test_extract_paypal_authorize_link_go_uses_gateway_extract_timeout_from_health(monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        return _Response({
            "ok": True,
            "extract_queue_used": 0,
            "extract_queue_limit": 128,
            "timeout_seconds": 30,
            "max_attempts": 4,
            "extract_timeout_seconds": 158,
        })

    def fake_post(url, **kwargs):
        captured.update(kwargs)
        return _Response({
            "ok": True,
            "paypal_authorize_url": "https://pm-redirects.stripe.com/authorize/acct_123",
        })

    monkeypatch.setattr(payment_module.cffi_requests, "get", fake_get)
    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)

    result = payment_module.extract_paypal_authorize_link_go(
        access_token="at_123",
        gateway_url="http://127.0.0.1:8787",
        timeout=90,
        log_fn=lambda _message: None,
    )

    assert result["ok"] is True
    assert captured["timeout"] == 168


def test_extract_paypal_authorize_link_go_sanitizes_client_timeout(monkeypatch):
    monkeypatch.setattr(
        payment_module.cffi_requests,
        "get",
        lambda *args, **kwargs: _Response({"ok": True, "extract_timeout_seconds": 158}),
    )

    def fake_post(url, **kwargs):
        raise RuntimeError(
            "Failed to perform, curl: (28) Operation timed out after 168011 milliseconds with 0 bytes received."
        )

    monkeypatch.setattr(payment_module.cffi_requests, "post", fake_post)

    result = payment_module.extract_paypal_authorize_link_go(
        access_token="at_123",
        gateway_url="http://127.0.0.1:8787",
        timeout=90,
        log_fn=lambda _message: None,
    )

    assert result["ok"] is False
    assert result["protocol_backend"] == "go"
    assert result["protocol_result"]["code"] == "go_gateway_timeout"
    assert "Go gateway 提链等待超时" in result["error"]
    assert "curl: (28)" not in result["error"]


def test_complete_paypal_checkout_from_authorize_url_skips_stripe_checkout_page(monkeypatch):
    state = {"logs": []}

    class FakePage:
        def __init__(self):
            self.context = SimpleNamespace(add_cookies=lambda cookies: None)
            self.url = "about:blank"

        def goto(self, url, **kwargs):
            self.url = "https://www.paypal.com/checkoutweb/signup?token=EC-123&ba_token=BA-123"

        def wait_for_timeout(self, timeout):
            pass

    class FakeContext:
        def __exit__(self, exc_type, exc, tb):
            return False

    page = FakePage()
    monkeypatch.setattr(
        payment_module,
        "_open_unique_camoufox_page",
        lambda *args, **kwargs: (FakeContext(), object(), page),
    )
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "country": "US",
            "line1": "1 Main",
            "city": "New York",
            "state": "NY",
            "postal_code": "10001",
        },
    )
    monkeypatch.setattr(payment_module, "_probe_camoufox_proxy_exit", lambda page, *, log: {"ok": True})
    monkeypatch.setattr(
        payment_module,
        "_wait_checkout_page_ready",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should skip pay checkout readiness")),
    )
    monkeypatch.setattr(
        payment_module,
        "_verify_checkout_is_free_trial",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should skip pay amount check")),
    )
    monkeypatch.setattr(
        payment_module,
        "_try_click_paypal",
        lambda page: (_ for _ in ()).throw(AssertionError("should not click PayPal on pay page")),
    )
    monkeypatch.setattr(
        payment_module,
        "_complete_ctf_sandbox_flow",
        lambda *args, **kwargs: {"final_url": "https://chatgpt.com/?plus=ok"},
    )
    monkeypatch.setattr(payment_module, "_hold_checkout_browser", lambda *args, **kwargs: None)

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert result["status"] == "ctf_completed"
    assert result["final_url"] == "https://chatgpt.com/?plus=ok"
    assert any("PayPal 授权长链接" in message for message in state["logs"])


def test_complete_paypal_checkout_reopens_camoufox_for_duplicate_fingerprint(monkeypatch):
    state = {"launches": [], "closed": [], "fingerprints": ["same-browser", "same-browser", "fresh-browser"]}

    class FakePage:
        def __init__(self, fingerprint):
            self.context = SimpleNamespace(add_cookies=lambda cookies: None)
            self.url = ""
            self.fingerprint = fingerprint

        def evaluate(self, script):
            return {
                "userAgent": f"ua-{self.fingerprint}",
                "platform": "Win32",
                "screen": {"width": 1440, "height": 900},
                "webgl": {"vendor": "vendor", "renderer": self.fingerprint},
            }

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url

        def wait_for_timeout(self, timeout):
            pass

    class FakeBrowser:
        def __init__(self, fingerprint):
            self.fingerprint = fingerprint

        def new_page(self):
            return FakePage(self.fingerprint)

    class FakeCamoufox:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.index = len(state["launches"])
            self.fingerprint = state["fingerprints"][self.index]
            state["launches"].append(kwargs)

        def __enter__(self):
            return FakeBrowser(self.fingerprint)

        def __exit__(self, exc_type, exc, tb):
            state["closed"].append(self.index)
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module, "fetch_us_billing_address", lambda *, email="": {"name": "TEST USER"})
    monkeypatch.setattr(payment_module, "_probe_camoufox_proxy_exit", lambda page, *, log: {"ok": True})
    monkeypatch.setattr(payment_module, "_wait_checkout_page_ready", lambda page, *, timeout_ms, log: None)
    monkeypatch.setattr(payment_module, "_try_click_paypal", lambda page: True)
    monkeypatch.setattr(payment_module, "_fill_checkout_billing_details", lambda page, address, **_: None)
    monkeypatch.setattr(payment_module, "_accept_checkout_terms", lambda page: True)
    monkeypatch.setattr(payment_module, "_click_subscribe_button_burst", lambda page, *, checkout_url, log: setattr(page, "url", "https://done.example/success"))
    monkeypatch.setattr(payment_module, "_wait_for_checkout_redirect", lambda page, *, checkout_url, timeout_ms, log: True)

    first = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        proxy="http://user:pass@us-proxy.example:8080",
        headless=True,
        hold_seconds=0,
        log_fn=lambda message: None,
    )
    second = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        proxy="http://user:pass@us-proxy.example:8080",
        headless=True,
        hold_seconds=0,
        log_fn=lambda message: None,
    )

    assert first["ok"] is True
    assert second["ok"] is True
    assert len(state["launches"]) == 3
    assert state["launches"][0]["geoip"] is True
    assert state["launches"][1]["geoip"] is True
    assert state["launches"][2]["geoip"] is True
    assert state["launches"][0]["addons"] == []
    assert state["launches"][0]["persistent_context"] is False
    assert state["launches"][0]["exclude_addons"] == [payment_module.DefaultAddons.UBO]
    assert state["closed"] == [0, 1, 2]


def test_complete_paypal_checkout_retries_submit_until_redirect(monkeypatch):
    state = {"submit_clicks": 0, "logs": []}
    checkout_url = "https://checkout.stripe.com/c/pay/cs_test_plus"
    redirected_url = "https://payments.example/checkout-complete?token=abc"

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                state["submit_clicks"] += 1
                if state["submit_clicks"] >= 3:
                    self.page.url = redirected_url

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def input_value(self, **kwargs):
            return ""

        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

        def wait_for(self, **kwargs):
            self.page.events.append(("wait_for_locator", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_function(self, expression, **kwargs):
            self.events.append(("wait_for_function", expression, kwargs))

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url=checkout_url,
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert result["final_url"] == redirected_url
    assert state["submit_clicks"] == 3
    assert sum(1 for message in state["logs"] if "checkout 操作第" in message) == 1
    assert sum(1 for message in state["logs"] if "点击最终订阅按钮第" in message) == 3


def test_complete_paypal_checkout_approves_paypal_agreement_before_ctf_sandbox(monkeypatch):
    state = {"submit_clicks": 0, "paypal_approve_clicks": 0, "logs": []}
    checkout_url = "https://checkout.stripe.com/c/pay/cs_test_plus"
    paypal_url = "https://www.paypal.com/agreements/approve?ba_token=BA-123"
    sandbox_url = "https://ctf-sandbox.example/create"

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                state["submit_clicks"] += 1
                if state["submit_clicks"] >= 3:
                    self.page.url = paypal_url
            if "paypal-approve" in self.selector.lower() or "agreements" in self.selector.lower():
                state["paypal_approve_clicks"] += 1
                self.page.url = sandbox_url

        def check(self, **kwargs):
            self.click(**kwargs)

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def input_value(self, **kwargs):
            return ""

        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

        def wait_for(self, **kwargs):
            self.page.events.append(("wait_for_locator", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT" if "input" in self.selector.lower() else "BUTTON"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_function(self, expression, **kwargs):
            self.events.append(("wait_for_function", expression, kwargs))

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )
    monkeypatch.setattr(
        payment_module,
        "_complete_ctf_sandbox_flow",
        lambda page, **kwargs: {"ok": True, "status": "ctf_completed", "final_url": "https://chatgpt.com/", "email": "ctf@example.com"},
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url=checkout_url,
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert result["status"] == "ctf_completed"
    assert result["final_url"] == "https://chatgpt.com/"
    assert state["paypal_approve_clicks"] == 1
    assert any("PayPal 协议确认页" in message for message in state["logs"])


def test_complete_paypal_checkout_hands_paypal_pay_page_to_create_flow_without_extra_approval_click(monkeypatch):
    state = {"submit_clicks": 0, "paypal_clicks": 0, "logs": []}
    checkout_url = "https://checkout.stripe.com/c/pay/cs_test_plus"
    paypal_approve_url = "https://www.paypal.com/agreements/approve?ba_token=BA-123"
    paypal_pay_url = "https://www.paypal.com/pay?ssrt=1779296433446&token=BA-123&ul=1"

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                state["submit_clicks"] += 1
                if state["submit_clicks"] >= 3:
                    self.page.url = paypal_approve_url
                return
            if "paypal" in self.page.url:
                state["paypal_clicks"] += 1
                self.page.url = paypal_pay_url

        def check(self, **kwargs):
            self.click(**kwargs)

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def input_value(self, **kwargs):
            return ""

        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

        def wait_for(self, **kwargs):
            self.page.events.append(("wait_for_locator", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT" if "input" in self.selector.lower() else "BUTTON"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_function(self, expression, **kwargs):
            self.events.append(("wait_for_function", expression, kwargs))

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )
    monkeypatch.setattr(
        payment_module,
        "_complete_ctf_sandbox_flow",
        lambda page, **kwargs: state.update(ctf_flow_url=page.url) or {"ok": True, "status": "ctf_completed", "final_url": "https://chatgpt.com/", "email": "ctf@example.com"},
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url=checkout_url,
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert result["status"] == "ctf_completed"
    assert state["paypal_clicks"] == 1
    assert state["ctf_flow_url"] == paypal_pay_url
    assert any(paypal_pay_url in message for message in state["logs"])


def test_complete_paypal_checkout_retries_paypal_selection_exception(monkeypatch):
    state = {"paypal_attempts": 0, "logs": []}

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url

        def wait_for_timeout(self, timeout):
            pass

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    def flaky_paypal(page):
        state["paypal_attempts"] += 1
        if state["paypal_attempts"] < 3:
            raise RuntimeError("paypal temporarily missing")
        return True

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module, "fetch_us_billing_address", lambda *, email="": {"name": "TEST USER"})
    monkeypatch.setattr(payment_module, "_probe_camoufox_proxy_exit", lambda page, *, log: {"ok": True})
    monkeypatch.setattr(payment_module, "_wait_checkout_page_ready", lambda page, *, timeout_ms, log: None)
    monkeypatch.setattr(payment_module, "_try_click_paypal", flaky_paypal)
    monkeypatch.setattr(payment_module, "_fill_checkout_billing_details", lambda page, address, **_: None)
    monkeypatch.setattr(payment_module, "_accept_checkout_terms", lambda page: True)
    monkeypatch.setattr(payment_module, "_click_subscribe_button_burst", lambda page, *, checkout_url, log: setattr(page, "url", "https://done.example/success"))
    monkeypatch.setattr(payment_module, "_wait_for_checkout_redirect", lambda page, *, checkout_url, timeout_ms, log: True)

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert state["paypal_attempts"] == 3
    assert any("选择 PayPal 支付方式第 1/3 次失败" in message for message in state["logs"])


def test_complete_paypal_checkout_skips_paypal_retry_when_page_already_redirected(monkeypatch):
    state = {
        "paypal_attempts": 0,
        "submit_attempts": 0,
        "redirect_waits": 0,
        "logs": [],
    }
    checkout_url = "https://checkout.stripe.com/c/pay/cs_test_plus"
    redirected_url = "https://payments.example/next-step"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url

        def wait_for_timeout(self, timeout):
            pass

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    def paypal_step(page):
        state["paypal_attempts"] += 1
        if state["paypal_attempts"] > 1:
            raise RuntimeError("未找到 PayPal 支付方式")
        return True

    def submit_step(page, *, checkout_url, log):
        state["submit_attempts"] += 1
        page.url = redirected_url

    def wait_redirect(page, *, checkout_url, timeout_ms, log):
        state["redirect_waits"] += 1
        return state["redirect_waits"] >= 2

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module, "fetch_us_billing_address", lambda *, email="": {"name": "TEST USER"})
    monkeypatch.setattr(payment_module, "_probe_camoufox_proxy_exit", lambda page, *, log: {"ok": True})
    monkeypatch.setattr(payment_module, "_wait_checkout_page_ready", lambda page, *, timeout_ms, log: None)
    monkeypatch.setattr(payment_module, "_try_click_paypal", paypal_step)
    def fill_billing(page, address, **_kwargs):
        if page.url == redirected_url:
            raise RuntimeError("billing fields not available")

    def accept_terms(page):
        if page.url == redirected_url:
            raise RuntimeError("terms not available")
        return True

    monkeypatch.setattr(payment_module, "_fill_checkout_billing_details", fill_billing)
    monkeypatch.setattr(payment_module, "_accept_checkout_terms", accept_terms)
    monkeypatch.setattr(payment_module, "_click_subscribe_button_burst", submit_step)
    monkeypatch.setattr(payment_module, "_wait_for_checkout_redirect", wait_redirect)

    result = payment_module.complete_paypal_checkout(
        checkout_url=checkout_url,
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert result["final_url"] == redirected_url
    assert state["paypal_attempts"] == 1
    assert state["submit_attempts"] == 1


def test_complete_paypal_checkout_fails_after_three_submit_attempts_without_redirect(monkeypatch):
    state = {"submit_clicks": 0, "logs": []}
    checkout_url = "https://checkout.stripe.com/c/pay/cs_test_plus"

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                state["submit_clicks"] += 1

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def input_value(self, **kwargs):
            return ""

        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

        def wait_for(self, **kwargs):
            self.page.events.append(("wait_for_locator", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_function(self, expression, **kwargs):
            self.events.append(("wait_for_function", expression, kwargs))

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url=checkout_url,
        headless=True,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["final_url"] == checkout_url
    assert "点击订阅后未检测到测试支付链接跳转" in result["error"]
    assert state["submit_clicks"] == 9


def test_accept_checkout_terms_matches_recurring_charge_notice():
    agreement_text = "我们将按照上述金额和周期向你收费，直到你取消为止。我们可能会更改"

    class FakeLocator:
        def __init__(self, page, selector, ready=False):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def evaluate(self, script):
            return "LABEL"

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"

    class FakePage:
        def __init__(self):
            self.events = []

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}", bool(name and name.search(agreement_text)))

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}", bool(name and name.search(agreement_text)))

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}", bool(text and text.search(agreement_text)))

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

    page = FakePage()

    assert payment_module._accept_checkout_terms(page) is True
    assert any(event[0] == "click" for event in page.events)


def test_complete_paypal_checkout_logs_error_before_debug_hold(monkeypatch):
    logs = []
    sleeps = []

    class FakeLocator:
        def __init__(self, page, selector, ready=False):
            self.page = page
            self.selector = selector
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

        def wait_for(self, **kwargs):
            self.page.events.append(("wait_for_locator", self.selector, kwargs))

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_function(self, expression, **kwargs):
            pass

        def locator(self, selector):
            return FakeLocator(self, selector, selector == "body" or "," in selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            return FakePage()

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        headless=False,
        hold_seconds=5,
        log_fn=logs.append,
    )

    assert result["ok"] is False
    error_log_index = next(index for index, message in enumerate(logs) if "PayPal checkout 自动流程异常" in message)
    hold_log_index = next(index for index, message in enumerate(logs) if "前台调试模式保留浏览器" in message)
    assert error_log_index < hold_log_index
    assert sleeps[-1] == 5
    assert sleeps[:2] == [5.0, 5.0]


# ----------------------------------------------------------------------------
# Regression: `_wait_for_chatgpt_return` 必须在等待期间自动处理 PayPal 的中间页
# 和 security challenge。否则 SMS 验证完成后，浏览器会停在 ``/webapps/hermes``
# 的 "Set up once. Pay faster next time." 再次确认页（用户截图证据），
# 主流程死等 chatgpt URL 5 分钟超时。
# ----------------------------------------------------------------------------


class _WaitReturnFakePage:
    """最小化 stub：``url`` 可写、``wait_for_timeout`` no-op、frames 为空。"""

    def __init__(self, url: str):
        self.url = url
        self.frames = []

    def wait_for_timeout(self, timeout):
        return None


def test_wait_for_chatgpt_return_auto_clicks_paypal_review_page(monkeypatch):
    """SMS 验证完成后被 PayPal 引到 ``/webapps/hermes`` 时，必须自动点
    ``Agree and Continue`` 才能跳回 ChatGPT。"""

    page = _WaitReturnFakePage(
        "https://www.paypal.com/webapps/hermes?ssrt=1779376147572&ul=1"
        "&modxo_redirect_reason=guest_user&ba_token=BA-FAKE&locale.x=en_US"
    )
    advance_calls = []

    def fake_advance_review(page_arg, *, timeout_ms, log, **kwargs):
        # 模拟点完 Agree and Continue 后浏览器跳到 chatgpt
        advance_calls.append({
            "url_before": page_arg.url,
            "turnstile_solver": kwargs.get("turnstile_solver"),
        })
        page_arg.url = "https://chatgpt.com/?paypal_cb=ok"
        return page_arg.url

    # 让 review 页可见检测命中（URL 前缀已经是 hermes 这条会真返回 True，
    # 但保险起见显式 mock 掉，避免 fake page 没有 locator 时走 paypal review
    # 文本判断分支）。
    monkeypatch.setattr(payment_module, "_paypal_review_page_visible", lambda p: "/webapps/hermes" in p.url.lower())
    monkeypatch.setattr(payment_module, "_advance_paypal_review_if_needed", fake_advance_review)
    monkeypatch.setattr(payment_module, "_advance_paypal_intermediate_pages", lambda *a, **kw: None)
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda p: False)
    monkeypatch.setattr(payment_module, "_pick_active_page", lambda p: p)

    solver_calls: list = []

    def fake_solver(page_url, site_key, challenge_type="turnstile"):
        solver_calls.append((page_url, site_key, challenge_type))
        return "fake-token"

    logs: list[str] = []
    final_url = payment_module._wait_for_chatgpt_return(
        page,
        timeout_ms=60000,
        log=logs.append,
        turnstile_solver=fake_solver,
    )

    assert final_url == "https://chatgpt.com/?paypal_cb=ok"
    # ``_advance_paypal_review_if_needed`` 必须被调用过；且 turnstile_solver
    # 被透传下去（这样再次确认页万一又弹 captcha 也能自动求解）。
    assert advance_calls, "应当至少调用一次 _advance_paypal_review_if_needed 处理 hermes 页"
    assert advance_calls[0]["url_before"].lower().startswith("https://www.paypal.com/webapps/hermes")
    assert advance_calls[0]["turnstile_solver"] is fake_solver


def test_wait_for_chatgpt_return_auto_solves_security_challenge_midwait(monkeypatch):
    """等待跳回 ChatGPT 期间随机弹的 security challenge 必须自动调 YesCaptcha
    求解，而不是死等 5 分钟。"""

    page = _WaitReturnFakePage("https://www.paypal.com/pay?token=BA-FAKE&ul=1")
    state = {"challenge_solved": False}

    def fake_has_challenge(page_arg):
        # 第一次返回 True 触发求解，求解完返回 False 模拟通过
        return not state["challenge_solved"]

    def fake_wait_for_manual(page_arg, *, timeout_ms, log, cancel_check, turnstile_solver):
        assert callable(turnstile_solver), "turnstile_solver 必须被透传到 _wait_for_manual_security_challenge"
        state["challenge_solved"] = True
        page_arg.url = "https://chatgpt.com/?after_challenge=ok"
        return True

    monkeypatch.setattr(payment_module, "_paypal_review_page_visible", lambda p: False)
    monkeypatch.setattr(payment_module, "_has_security_challenge", fake_has_challenge)
    monkeypatch.setattr(payment_module, "_wait_for_manual_security_challenge", fake_wait_for_manual)
    monkeypatch.setattr(payment_module, "_advance_paypal_intermediate_pages", lambda *a, **kw: None)
    monkeypatch.setattr(payment_module, "_pick_active_page", lambda p: p)

    logs: list[str] = []
    final_url = payment_module._wait_for_chatgpt_return(
        page,
        timeout_ms=60000,
        log=logs.append,
        turnstile_solver=lambda *a, **kw: "fake-token",
    )

    assert final_url == "https://chatgpt.com/?after_challenge=ok"
    assert state["challenge_solved"] is True


def test_wait_for_chatgpt_return_returns_immediately_when_already_chatgpt(monkeypatch):
    """已在 chatgpt 域时立即返回，不应进入轮询循环。"""
    page = _WaitReturnFakePage("https://chatgpt.com/checkout/done")
    monkeypatch.setattr(payment_module, "_paypal_review_page_visible", lambda p: False)
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda p: False)
    monkeypatch.setattr(payment_module, "_pick_active_page", lambda p: p)

    final_url = payment_module._wait_for_chatgpt_return(
        page,
        timeout_ms=30000,
        log=lambda message: None,
    )
    assert final_url == "https://chatgpt.com/checkout/done"


# ----------------------------------------------------------------------------
# Regression: hCaptcha 完整链路（sitekey 抽取 / token 注入 / solver 路由）
#
# Sanitized regression capture `@tools/captures/paypal-hcaptcha-example.har`
# (entry 347): ``paypal.com/pay/`` Continue to Payment 后被风控弹的页面是
# Security Challenge，里面嵌的是 **hCaptcha**（不是 Turnstile / reCAPTCHA）。
# 之前的 Camoufox 路径只识别 Turnstile / reCAPTCHA，hCaptcha sitekey 抠不到 →
# 自动求解永远不被调用，用户必须手动点验证（用户原话："每次都是我手动去点击验证"）。
# 这组单测锁住 hCaptcha 三条核心：
#   1) sitekey 能从 PayPal hCaptcha wrapper iframe URL 抠出
#   2) token 能注入到 ``form[name=challenge]`` 并 submit
#   3) plugin solver 看到 challenge_type='hcaptcha' 必须路由到 solve_hcaptcha
# ----------------------------------------------------------------------------


def test_hcaptcha_sitekey_from_paypal_wrapper_iframe_url():
    """从实战 HAR entry 347 的 iframe src 里能抠出 sitekey。"""
    real_iframe_src = (
        "https://www.paypalobjects.com/web/res/763/5fb1f0dbc65744ed7c0eb0889575e/"
        "hcaptcha/hcaptcha_fph.html?siteKey=bf07db68-5c2e-42e8-8779-ea8384890eea"
        "&locale.x=en_US&country.x=US&checkConnectionTimeout=10000"
        "&domain=hcaptcha.paypal.com&imgsDomain=imgs.hcaptcha.paypal.com"
    )
    assert (
        payment_module._hcaptcha_sitekey_from_url(real_iframe_src)
        == "bf07db68-5c2e-42e8-8779-ea8384890eea"
    )


def test_hcaptcha_sitekey_from_url_ignores_non_hcaptcha_urls():
    """``challenges.cloudflare.com`` / 普通 PayPal URL 都不应被误识为 hCaptcha。"""
    assert payment_module._hcaptcha_sitekey_from_url("") == ""
    assert payment_module._hcaptcha_sitekey_from_url(
        "https://www.paypal.com/pay?token=BA-XXX"
    ) == ""
    assert payment_module._hcaptcha_sitekey_from_url(
        "https://challenges.cloudflare.com/turnstile/v0/api.js?sitekey=0xCFXXX"
    ) == ""


def test_hcaptcha_sitekey_from_url_supports_lowercase_param():
    """部分 hCaptcha 嵌入用小写 ``sitekey=`` 也要支持。"""
    assert payment_module._hcaptcha_sitekey_from_url(
        "https://hcaptcha.com/captcha/v1/?sitekey=12345678-aaaa-bbbb-cccc-1234567890ab"
    ) == "12345678-aaaa-bbbb-cccc-1234567890ab"


def test_extract_hcaptcha_sitekey_via_iframe_url(monkeypatch):
    """``_extract_hcaptcha_sitekey`` 在主 DOM 抠不到时，必须降级到遍历 frame URL。"""

    class FakeFrame:
        def __init__(self, url):
            self.url = url

        def evaluate(self, script):
            # 让 DOM 评估失败，强制走 URL 兜底
            raise RuntimeError("frame DOM eval not available")

    class FakePage:
        def __init__(self, frames):
            self.frames = frames

        def evaluate(self, script):
            raise RuntimeError("page DOM eval not available")

    page = FakePage([
        FakeFrame("https://www.paypal.com/pay/_next/static/chunks/some-chunk.js"),
        FakeFrame(
            "https://www.paypalobjects.com/web/res/763/abc/hcaptcha/hcaptcha_fph.html"
            "?siteKey=bf07db68-5c2e-42e8-8779-ea8384890eea&locale.x=en_US"
        ),
    ])
    # _iter_page_frames 直接读 page.frames
    monkeypatch.setattr(payment_module, "_iter_page_frames", lambda p: p.frames)

    assert (
        payment_module._extract_hcaptcha_sitekey(page)
        == "bf07db68-5c2e-42e8-8779-ea8384890eea"
    )


def test_inject_hcaptcha_token_appends_response_field_and_submits(monkeypatch):
    """token 注入：必须 evaluate JS 把 ``g-recaptcha-response`` 塞进 form 并 submit。"""

    captured_scripts: list[str] = []

    class FakePage:
        def evaluate(self, script):
            captured_scripts.append(script)
            return True

    page = FakePage()
    ok = payment_module._inject_hcaptcha_token(page, "FAKE_HCAPTCHA_TOKEN_xyz")
    assert ok is True
    assert len(captured_scripts) == 1
    js = captured_scripts[0]
    # 关键不变量：找 form[name=challenge] / 包 paypal_client_cfci 的 form
    assert 'form[name="challenge"]' in js
    assert "paypal_client_cfci" in js
    # 注入 g-recaptcha-response（PayPal authchallenge 后端就读这个字段）
    assert "g-recaptcha-response" in js
    assert "h-captcha-response" in js  # 兼容老分支
    # token 必须被注入脚本（escape 单引号后），用 quoted 形式核对
    assert "FAKE_HCAPTCHA_TOKEN_xyz" in js
    # 必须 form.submit()
    assert "form.submit()" in js


def test_inject_hcaptcha_token_returns_false_when_evaluate_throws():
    """``page.evaluate`` 抛错时必须 graceful 返回 False，不阻塞流程。"""

    class BrokenPage:
        def evaluate(self, script):
            raise RuntimeError("page closed")

    assert payment_module._inject_hcaptcha_token(BrokenPage(), "anything") is False


def test_try_auto_solve_security_challenge_routes_hcaptcha_to_solver(monkeypatch):
    """**已变更**：检测到 hCaptcha 时**不再调** solver（用户诉求 hCaptcha
    永远不走远端验证码服务，避免 ERROR_DOMAIN_NOT_ALLOWED 烧配额）。
    应该改调 ``_click_hcaptcha_anchor_checkbox``，并返回 True 让外层
    走 10s 等待路径。"""

    class FakePage:
        url = "https://www.paypal.com/pay/?token=BA-X&paypal_client_cfci=modxo"
        frames = []

        def wait_for_timeout(self, ms):
            return None

    monkeypatch.setattr(payment_module, "_current_page_url", lambda p, *a, **kw: p.url)
    monkeypatch.setattr(payment_module, "_extract_turnstile_sitekey", lambda p: "")
    monkeypatch.setattr(payment_module, "_extract_recaptcha_sitekey", lambda p: "")
    monkeypatch.setattr(
        payment_module,
        "_extract_hcaptcha_sitekey",
        lambda p: "bf07db68-5c2e-42e8-8779-ea8384890eea",
    )

    click_calls = []

    def fake_click(page_arg, *, log):
        click_calls.append(page_arg)
        return True

    monkeypatch.setattr(payment_module, "_click_hcaptcha_anchor_checkbox", fake_click)

    solver_calls = []

    def fake_solver(page_url, site_key, challenge_type="turnstile"):
        solver_calls.append((page_url, site_key, challenge_type))
        return "RESOLVED_HCAPTCHA_TOKEN"

    page = FakePage()
    logs: list[str] = []
    ok = payment_module._try_auto_solve_security_challenge(
        page, solver=fake_solver, log=logs.append
    )
    assert ok is True
    # 关键：solver 一定不被调用
    assert solver_calls == []
    # 关键：复选框点击被调用一次
    assert click_calls == [page]
    # 日志里要明确写出"不调验证码服务"以便用户理解
    assert any("不调验证码服务" in m for m in logs)


def test_is_permanent_captcha_error_recognizes_class_name():
    """``_is_permanent_captcha_error`` 用 duck-typing 通过类名识别。"""

    class PermanentCaptchaError(RuntimeError):
        pass

    assert payment_module._is_permanent_captcha_error(
        PermanentCaptchaError("nope")
    ) is True


def test_is_permanent_captcha_error_recognizes_error_code_attribute():
    """挂了 ``error_code`` 属性 + 永久错误码也认。"""

    err = RuntimeError("simulated")
    setattr(err, "error_code", "ERROR_DOMAIN_NOT_ALLOWED")
    assert payment_module._is_permanent_captcha_error(err) is True

    err2 = RuntimeError("simulated2")
    setattr(err2, "error_code", "ERROR_IP_BLOCKED_5MIN")
    assert payment_module._is_permanent_captcha_error(err2) is True

    err3 = RuntimeError("simulated3")
    setattr(err3, "error_code", "ERROR_NO_SLOT_AVAILABLE")  # transient
    assert payment_module._is_permanent_captcha_error(err3) is False


def test_is_permanent_captcha_error_ignores_plain_runtime_error():
    """普通 RuntimeError 不应被误识为永久错误。"""
    assert payment_module._is_permanent_captcha_error(RuntimeError("just an error")) is False


def test_try_solve_detected_security_challenge_reraises_permanent_error(monkeypatch):
    """求解抛 PermanentCaptchaError 必须 raise 出去（不能被 catch 转 False）。"""

    class PermanentCaptchaError(RuntimeError):
        def __init__(self, message, *, error_code=""):
            super().__init__(message)
            self.error_code = error_code

    def failing_solver(page_url, site_key, challenge_type):
        raise PermanentCaptchaError(
            "ERROR_DOMAIN_NOT_ALLOWED 此域名无法识别",
            error_code="ERROR_DOMAIN_NOT_ALLOWED",
        )

    page = object()
    logs: list[str] = []
    with pytest.raises(PermanentCaptchaError):
        payment_module._try_solve_detected_security_challenge(
            page,
            solver=failing_solver,
            page_url="https://www.paypal.com/pay/",
            site_key="bf07db68-5c2e-42e8-8779-ea8384890eea",
            challenge_type="hcaptcha",
            label="hCaptcha",
            inject=lambda p, t: True,
            log=logs.append,
        )
    # 关键日志：必须明确说"永久错误，停止自动重试"
    assert any("永久错误" in line and "停止自动重试" in line for line in logs)


def test_try_solve_detected_security_challenge_swallows_transient_error(monkeypatch):
    """普通（非永久）求解错误必须 return False（继续重试），**不能 raise**。"""

    def transient_failing_solver(page_url, site_key, challenge_type):
        raise RuntimeError("ERROR_NO_SLOT_AVAILABLE")

    page = object()
    logs: list[str] = []
    result = payment_module._try_solve_detected_security_challenge(
        page,
        solver=transient_failing_solver,
        page_url="https://www.paypal.com/pay/",
        site_key="bf07db68-5c2e-42e8-8779-ea8384890eea",
        challenge_type="hcaptcha",
        label="hCaptcha",
        inject=lambda p, t: True,
        log=logs.append,
    )
    assert result is False
    # 关键日志：是"失败"而不是"永久错误"
    assert any("失败" in line and "永久错误" not in line for line in logs)


def test_wait_for_manual_security_challenge_falls_back_to_manual_on_permanent_error(monkeypatch):
    """**已变更**：hCaptcha 走"自动点击 + 10s 等"路径，不再调 solver。
    本测试改为验证：solver 永久错误下，遇到 Turnstile/reCAPTCHA 时仍能
    降级到通用"自动点击 + 10s 等"分支。"""

    class PermanentCaptchaError(RuntimeError):
        def __init__(self, message, *, error_code=""):
            super().__init__(message)
            self.error_code = error_code

    class FakePage:
        url = "https://www.paypal.com/pay/?token=BA-X&paypal_client_cfci=modxo"

        def wait_for_timeout(self, ms):
            return None

    page = FakePage()
    monkeypatch.setattr(payment_module, "_current_page_url", lambda p, *a, **kw: p.url)
    monkeypatch.setattr(payment_module, "_is_paypal_pay_create_url", lambda url: True)
    state = {"challenge_active": True}
    # 模拟 Turnstile 命中（避开 hCaptcha 早退路径）；challenge 通过后所有
    # sitekey/text 信号同步消失
    monkeypatch.setattr(
        payment_module,
        "_extract_turnstile_sitekey",
        lambda p: ("0x4AAAAAAA-FAKE-TURNSTILE-KEY" if state["challenge_active"] else ""),
    )
    monkeypatch.setattr(payment_module, "_extract_recaptcha_sitekey", lambda p: "")
    monkeypatch.setattr(payment_module, "_extract_hcaptcha_sitekey", lambda p: "")
    monkeypatch.setattr(
        payment_module,
        "_has_security_challenge_text",
        lambda p: state["challenge_active"],
    )
    monkeypatch.setattr(
        payment_module,
        "_has_security_challenge",
        lambda p: state["challenge_active"],
    )

    auto_solve_calls = {"n": 0}

    def fake_auto_solve(page_arg, *, solver, log):
        auto_solve_calls["n"] += 1
        # 模拟"YesCaptcha 永久错误抛出"——同时翻转 state 让 challenge 已通过，
        # 让降级后的"自动点击 + 10s 等"短轮询第一轮就 return True，避免跑满 timeout。
        state["challenge_active"] = False
        raise PermanentCaptchaError(
            "ERROR_DOMAIN_NOT_ALLOWED",
            error_code="ERROR_DOMAIN_NOT_ALLOWED",
        )

    monkeypatch.setattr(payment_module, "_try_auto_solve_security_challenge", fake_auto_solve)
    # 自动点击 challenge 控件直接返回 True；通用 fallback 路径会调它
    monkeypatch.setattr(
        payment_module,
        "_click_security_challenge_control",
        lambda page_arg, *, label: True,
    )

    logs: list[str] = []
    ok = payment_module._wait_for_manual_security_challenge(
        page,
        timeout_ms=10000,
        log=logs.append,
        cancel_check=None,
        turnstile_solver=lambda u, k, c="turnstile": "TOKEN",
    )
    assert ok is True
    # 只调用了 1 次 auto-solver——永久错误后立刻 break，不再重试
    assert auto_solve_calls["n"] == 1
    # 必须能看到降级日志（停止自动求解）
    assert any("永久不可用" in line for line in logs)


def test_wait_for_manual_security_challenge_hcaptcha_clicks_and_skips_solver(monkeypatch):
    """**用户诉求核心**：检测到 hCaptcha 时**绝对不调** YesCaptcha；改为
    调 ``_click_hcaptcha_anchor_checkbox`` 点复选框，10s 内 challenge 消失即成功，
    超时则 raise。即使 ``turnstile_solver`` 已配置也不用。"""

    class FakePage:
        url = "https://www.paypal.com/pay/?token=BA-X&paypal_client_cfci=modxo"

        def wait_for_timeout(self, ms):
            return None

    page = FakePage()
    monkeypatch.setattr(payment_module, "_current_page_url", lambda p, *a, **kw: p.url)
    monkeypatch.setattr(payment_module, "_is_paypal_pay_create_url", lambda url: True)
    state = {"hcaptcha_active": True}
    # hCaptcha 命中；点击后翻 state，让 short wait 第一轮就见 challenge 消失
    monkeypatch.setattr(
        payment_module,
        "_extract_hcaptcha_sitekey",
        lambda p: ("bf07db68-FAKE" if state["hcaptcha_active"] else ""),
    )
    monkeypatch.setattr(payment_module, "_extract_turnstile_sitekey", lambda p: "")
    monkeypatch.setattr(payment_module, "_extract_recaptcha_sitekey", lambda p: "")
    monkeypatch.setattr(
        payment_module,
        "_has_security_challenge_text",
        lambda p: state["hcaptcha_active"],
    )
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda p: True)

    click_calls = []

    def fake_click(page_arg, *, log):
        click_calls.append(page_arg)
        state["hcaptcha_active"] = False
        return True

    monkeypatch.setattr(payment_module, "_click_hcaptcha_anchor_checkbox", fake_click)

    solver_calls = []

    def fake_solver(page_url, site_key, challenge_type="turnstile"):
        solver_calls.append(challenge_type)
        return "TOKEN_THAT_SHOULD_NEVER_BE_REQUESTED"

    logs: list[str] = []
    ok = payment_module._wait_for_manual_security_challenge(
        page,
        timeout_ms=10000,
        log=logs.append,
        cancel_check=None,
        turnstile_solver=fake_solver,
    )
    assert ok is True
    # 关键：solver **绝对**没被调用
    assert solver_calls == []
    # 关键：hCaptcha checkbox 被点了一次
    assert click_calls == [page]
    # 关键日志
    assert any("跳过验证码服务" in m and "hCaptcha" in m for m in logs)


def test_wait_for_manual_security_challenge_hcaptcha_raises_after_10s_no_progress(monkeypatch):
    """hCaptcha 路径：点击后 10s 内 challenge 仍 visible → 必须 raise。"""

    class FakePage:
        url = "https://www.paypal.com/pay/?token=BA-X"

        def wait_for_timeout(self, ms):
            return None

    page = FakePage()
    monkeypatch.setattr(payment_module, "_current_page_url", lambda p, *a, **kw: p.url)
    monkeypatch.setattr(payment_module, "_is_paypal_pay_create_url", lambda url: True)
    monkeypatch.setattr(
        payment_module, "_extract_hcaptcha_sitekey", lambda p: "bf07db68-FAKE"
    )
    monkeypatch.setattr(payment_module, "_extract_turnstile_sitekey", lambda p: "")
    monkeypatch.setattr(payment_module, "_extract_recaptcha_sitekey", lambda p: "")
    monkeypatch.setattr(
        payment_module, "_has_security_challenge_text", lambda p: True
    )
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda p: True)
    # 点击不抛异常，但 challenge 始终未消失
    monkeypatch.setattr(
        payment_module, "_click_hcaptcha_anchor_checkbox", lambda p, *, log: False
    )
    # time.monotonic 的 wait_for_timeout 不真实推进时间，这里 patch monotonic
    # 让超时立即触发
    times = iter([0, 0.1, 11.0, 11.1, 11.2])

    def fake_monotonic():
        try:
            return next(times)
        except StopIteration:
            return 11.5

    monkeypatch.setattr(payment_module.time, "monotonic", fake_monotonic)

    logs: list[str] = []
    with pytest.raises(RuntimeError, match="hCaptcha 10 秒内未通过"):
        payment_module._wait_for_manual_security_challenge(
            page,
            timeout_ms=10000,
            log=logs.append,
            cancel_check=None,
            turnstile_solver=None,
        )


def test_yescaptcha_solver_routes_hcaptcha_to_solve_hcaptcha(monkeypatch):
    """plugin 层的 ``_build_turnstile_solver_for_checkout`` 拿到 ``challenge_type='hcaptcha'``
    必须调 ``solve_hcaptcha``。这是把 ``_try_auto_solve_security_challenge`` 这边
    抠出的 ``hcaptcha`` 类型透传到 YesCaptcha 的契约接口。"""

    plugin = ChatGPTPlatform()
    plugin._log_fn = lambda msg: None

    monkeypatch.setattr(
        plugin, "_has_configured_captcha", lambda key: True
    )

    class FakeYesCaptcha:
        def __init__(self):
            self.calls = []

        def solve_turnstile(self, page_url, site_key):
            self.calls.append(("turnstile", page_url, site_key))
            return "TS_TOKEN"

        def solve_recaptcha_v2(self, page_url, site_key):
            self.calls.append(("recaptcha_v2", page_url, site_key))
            return "RC_TOKEN"

        def solve_hcaptcha(self, page_url, site_key):
            self.calls.append(("hcaptcha", page_url, site_key))
            return "HC_TOKEN"

    fake = FakeYesCaptcha()
    monkeypatch.setattr(plugin, "_make_captcha", lambda *, provider_key: fake)

    solver = plugin._build_turnstile_solver_for_checkout()
    assert callable(solver)
    # 三种类型都路由到对应方法
    assert solver("https://www.paypal.com/pay/", "0xTS", "turnstile") == "TS_TOKEN"
    assert solver("https://www.paypal.com/pay/", "RC_KEY", "recaptcha_v2") == "RC_TOKEN"
    assert solver("https://www.paypal.com/pay/", "HC_KEY", "hcaptcha") == "HC_TOKEN"
    assert fake.calls == [
        ("turnstile", "https://www.paypal.com/pay/", "0xTS"),
        ("recaptcha_v2", "https://www.paypal.com/pay/", "RC_KEY"),
        ("hcaptcha", "https://www.paypal.com/pay/", "HC_KEY"),
    ]


def test_complete_paypal_checkout_fails_when_geoip_extra_missing(monkeypatch):
    state = {"launches": [], "logs": []}

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def input_value(self, **kwargs):
            return ""

        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            state["launches"].append(kwargs)

        def __enter__(self):
            if self.kwargs.get("geoip"):
                raise RuntimeError("Please install the geoip extra to use this feature: pip install camoufox[geoip]")
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        proxy="http://user:pass@us-proxy.example:8080",
        headless=False,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is False
    assert state["launches"][0]["geoip"] is True
    assert len(state["launches"]) == 1
    assert "camoufox[geoip]" in result["error"].lower()


def test_complete_paypal_checkout_passes_geoip_without_preflight_skip(monkeypatch):
    state = {"launches": [], "logs": []}

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def input_value(self, **kwargs):
            return ""

        def inner_text(self, **kwargs):
            return '{"ip":"203.0.113.10"}'

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            pass

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            assert kwargs["geoip"] is True
            state["launches"].append(kwargs)

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module, "_camoufox_geoip_extra_available", lambda: False, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        proxy="http://user:pass@us-proxy.example:8080",
        headless=False,
        hold_seconds=0,
        log_fn=state["logs"].append,
    )

    assert result["ok"] is True
    assert len(state["launches"]) == 1
    assert state["launches"][0]["geoip"] is True
    assert any("geoip" in message.lower() and "已启用" in message for message in state["logs"])
    assert any("代理认证" in message and "已配置" in message for message in state["logs"])


def test_complete_paypal_checkout_keeps_headed_browser_open_for_debug(monkeypatch):
    state = {"slept": []}

    class FakeLocator:
        first = None

        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            self.events.append(("timeout", timeout))

        def goto(self, url, **kwargs):
            self.url = url
            self.events.append(("goto", url, kwargs))

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            state["closed"] = True
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: state["slept"].append(seconds))
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        headless=False,
        log_fn=lambda message: None,
    )

    assert result["ok"] is True
    assert state["slept"] == [10]
    assert state["closed"] is True


def test_complete_paypal_checkout_does_not_hold_headless_browser(monkeypatch):
    state = {}

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            self.events.append(("wait", timeout))

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            state["launch_opts"] = kwargs

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: state.setdefault("slept", []).append(seconds))
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        headless=True,
        log_fn=lambda message: None,
    )

    assert result["ok"] is True
    assert state["launch_opts"]["headless"] is True
    assert state.get("slept", []) == []
    assert ("wait", 300000) not in state["page"].events


def test_complete_paypal_checkout_hold_survives_closed_page(monkeypatch):
    state = {"slept": []}

    class FakeLocator:
        def __init__(self, page, selector):
            self.page = page
            self.selector = selector
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return True

        def is_enabled(self):
            return True

        def click(self, **kwargs):
            self.page.events.append(("click", self.selector, kwargs))
            if "hosted-payment-submit-button" in self.selector:
                self.page.url = "https://payments.example/checkout-complete?token=debug"

        def check(self, **kwargs):
            self.page.events.append(("check", self.selector, kwargs))

        def fill(self, value, **kwargs):
            self.page.events.append(("fill", self.selector, value, kwargs))

        def select_option(self, **kwargs):
            self.page.events.append(("select", self.selector, kwargs))

        def evaluate(self, script):
            return "INPUT"

    class FakeContext:
        def add_cookies(self, cookies):
            pass

    class FakePage:
        def __init__(self):
            self.context = FakeContext()
            self.events = []
            self.url = ""

        def set_default_timeout(self, timeout):
            pass

        def goto(self, url, **kwargs):
            self.url = url

        def wait_for_load_state(self, *args, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            if timeout == 300000:
                raise RuntimeError("page closed")
            self.events.append(("wait", timeout))

        def locator(self, selector):
            return FakeLocator(self, selector)

        def get_by_role(self, role, name=None):
            return FakeLocator(self, f"role:{role}:{name}")

        def get_by_label(self, name):
            return FakeLocator(self, f"label:{name}")

        def get_by_text(self, text):
            return FakeLocator(self, f"text:{text}")

    class FakeBrowser:
        def new_page(self):
            state["page"] = FakePage()
            return state["page"]

    class FakeCamoufox:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return FakeBrowser()

        def __exit__(self, exc_type, exc, tb):
            state["closed"] = True
            return False

    monkeypatch.setattr(payment_module, "Camoufox", FakeCamoufox, raising=False)
    monkeypatch.setattr(payment_module.time, "sleep", lambda seconds: state["slept"].append(seconds))
    monkeypatch.setattr(
        payment_module,
        "fetch_us_billing_address",
        lambda *, email="": {
            "name": "TEST USER",
            "line1": "123 Test Avenue",
            "city": "Testville",
            "state": "CO",
            "postal_code": "94105",
            "phone": "202-555-0142",
            "country": "US",
            "email": email,
        },
    )

    result = payment_module.complete_paypal_checkout(
        checkout_url="https://checkout.stripe.com/c/pay/cs_test_plus",
        headless=False,
        log_fn=lambda message: None,
    )

    assert result["ok"] is True
    assert state["slept"] == [10]
    assert state["closed"] is True



def test_try_auto_solve_security_challenge_returns_false_without_solver():
    page = SimpleNamespace()
    assert payment_module._try_auto_solve_security_challenge(
        page, solver=None, log=lambda message: None
    ) is False


def test_try_auto_solve_security_challenge_handles_solver_failure(monkeypatch):
    monkeypatch.setattr(payment_module, '_extract_turnstile_sitekey', lambda page: '0xSITEKEY_TEST')
    monkeypatch.setattr(payment_module, '_current_page_url', lambda page: 'https://example.com/checkout')

    def bad_solver(page_url, site_key):
        raise RuntimeError('captcha provider unavailable')

    logs: list[str] = []
    page = SimpleNamespace()
    result = payment_module._try_auto_solve_security_challenge(
        page, solver=bad_solver, log=logs.append
    )
    assert result is False
    assert any('captcha provider unavailable' in line for line in logs)


def test_try_auto_solve_security_challenge_returns_false_when_no_sitekey(monkeypatch):
    monkeypatch.setattr(payment_module, '_extract_turnstile_sitekey', lambda page: '')
    page = SimpleNamespace()
    assert payment_module._try_auto_solve_security_challenge(
        page, solver=lambda u, k: 'token', log=lambda message: None
    ) is False


def test_try_auto_solve_security_challenge_success(monkeypatch):
    monkeypatch.setattr(payment_module, '_extract_turnstile_sitekey', lambda page: '0xSITEKEY_TEST')
    monkeypatch.setattr(payment_module, '_current_page_url', lambda page: 'https://example.com/checkout')

    injected = {}
    def fake_inject(page, token):
        injected['token'] = token
        return True
    monkeypatch.setattr(payment_module, '_inject_turnstile_token', fake_inject)

    visibility = {'visible': True}
    def fake_has_challenge(page):
        if visibility['visible']:
            visibility['visible'] = False
            return True
        return False
    monkeypatch.setattr(payment_module, '_has_security_challenge', fake_has_challenge)

    captured = {}
    def good_solver(page_url, site_key):
        captured['url'] = page_url
        captured['key'] = site_key
        return 'TURNSTILE_TOKEN_VALUE'

    page = SimpleNamespace(wait_for_timeout=lambda ms: None)
    assert payment_module._try_auto_solve_security_challenge(
        page, solver=good_solver, log=lambda message: None
    ) is True
    assert injected['token'] == 'TURNSTILE_TOKEN_VALUE'
    assert captured == {'url': 'https://example.com/checkout', 'key': '0xSITEKEY_TEST'}


def test_extract_recaptcha_sitekey_from_anchor_iframe():
    page = SimpleNamespace(
        frames=[
            SimpleNamespace(
                url="https://www.google.com/recaptcha/api2/anchor?ar=1&k=RECAPTCHA_SITEKEY&co=aHR0cHM6Ly93d3cucGF5cGFsLmNvbTo0NDM."
            )
        ],
        evaluate=lambda script: "",
    )

    assert payment_module._extract_recaptcha_sitekey(page) == "RECAPTCHA_SITEKEY"


def test_turnstile_sitekey_from_url_prefers_query_param():
    """优先解析 query 参数（最稳）。"""
    url = "https://challenges.cloudflare.com/turnstile/v0/api.js?sitekey=0xABC123DEF456&onload=foo"
    assert payment_module._turnstile_sitekey_from_url(url) == "0xABC123DEF456"

    url2 = "https://challenges.cloudflare.com/turnstile/v0/g/abcd/iframe.html?k=0xXYZ_KEY&hl=en"
    assert payment_module._turnstile_sitekey_from_url(url2) == "0xXYZ_KEY"


def test_turnstile_sitekey_from_url_parses_path_when_no_query():
    """没有 query 时回退到路径正则。"""
    url = "https://challenges.cloudflare.com/turnstile/v0/0x4AAAAAAA_real_key"
    assert payment_module._turnstile_sitekey_from_url(url) == "0x4AAAAAAA_real_key"


def test_turnstile_sitekey_from_url_ignores_non_cloudflare():
    """非 cloudflare 域名应该一律返回空字符串。"""
    assert payment_module._turnstile_sitekey_from_url("https://example.com/foo?sitekey=0x123") == ""
    assert payment_module._turnstile_sitekey_from_url("") == ""


def test_extract_turnstile_sitekey_from_cross_origin_frame_dom():
    """PayPal mock 的真实场景：主 DOM 抠不到，但跨域子 frame 的 DOM 里有
    ``<div class="cf-turnstile" data-sitekey="0xYYY">``。新实现应该
    遍历每个 frame 各自 evaluate，从而拿到 sitekey。"""

    def main_evaluate(_script):
        # 主 DOM 没有 sitekey
        return ""

    class CrossOriginFrame:
        url = "https://www.paypal.com/risk/v2/checkout/captcha"

        def evaluate(self, _script):
            # 子 iframe 内部挂了 cf-turnstile div，data-sitekey 是真实 sitekey
            return "0xDEEP_NESTED_KEY"

    page = SimpleNamespace(
        evaluate=main_evaluate,
        frames=[CrossOriginFrame()],
    )

    assert payment_module._extract_turnstile_sitekey(page) == "0xDEEP_NESTED_KEY"


def test_extract_turnstile_sitekey_from_cloudflare_iframe_with_query_sitekey():
    """常见生产场景：主 DOM 没 widget，但有一个 ``challenges.cloudflare.com``
    iframe，sitekey 在 query ``?sitekey=0x...``。新实现应该解析出来。"""

    page = SimpleNamespace(
        evaluate=lambda _script: "",
        frames=[
            SimpleNamespace(
                # 子 frame 没有 evaluate 方法 → 应当走 URL 解析路径
                url=(
                    "https://challenges.cloudflare.com/turnstile/v0/g/abcd/"
                    "iframe.html?sitekey=0xPROD_KEY_PROD&hl=en"
                )
            ),
        ],
    )

    assert payment_module._extract_turnstile_sitekey(page) == "0xPROD_KEY_PROD"


def test_has_real_security_challenge_ignores_paypal_fraud_iframe_keywords():
    """PayPal mock 创建账号页里嵌入的 fraud iframe URL 经常含 ``challenge`` /
    ``captcha`` 等关键字（PayPal 内部风控信号，不是 captcha 控件）。
    `_has_security_challenge` 看 frame URL 关键字会误报；
    `_has_real_security_challenge` 在 paypal_mock 页面下要求 text 命中或
    真 sitekey，应当忽略此类 fraud iframe 关键字。"""
    page = SimpleNamespace(
        url="https://www.paypal.com/pay?ssrt=1&token=BA-FAKE&ul=1",
        evaluate=lambda _script: "",  # 主 DOM 没 widget
        frames=[
            # PayPal 自家 fraud iframe：URL 含 challenge/captcha 但**没有**真 sitekey
            SimpleNamespace(url="https://www.paypal.com/risk/v2/checkout/challenge/abc"),
            SimpleNamespace(url="https://www.paypal.com/risk/v2/captcha/widget"),
        ],
        get_by_text=lambda _pattern: SimpleNamespace(
            count=lambda: 0, first=SimpleNamespace(is_visible=lambda: False)
        ),
        locator=lambda _selector: SimpleNamespace(
            count=lambda: 0, first=SimpleNamespace(is_visible=lambda: False)
        ),
    )
    # 宽松版会误报（当前期望行为）
    assert payment_module._has_security_challenge(page) is True
    # 严格版应当返回 False，让主流程继续推进 create-account 点击
    assert payment_module._has_real_security_challenge(page) is False


def test_has_real_security_challenge_detects_real_turnstile_sitekey_on_paypal_mock():
    """paypal_mock 页面下，子 frame 真有 cf-turnstile 跨域 widget → 应判为真挑战。"""
    real_sitekey_frame = SimpleNamespace(
        url=(
            "https://challenges.cloudflare.com/turnstile/v0/g/abcd/"
            "iframe.html?sitekey=0xPROD_KEY_REAL&hl=en"
        )
    )
    page = SimpleNamespace(
        url="https://www.paypal.com/pay?ssrt=1&token=BA-FAKE&ul=1",
        evaluate=lambda _script: "",
        frames=[real_sitekey_frame],
        get_by_text=lambda _pattern: SimpleNamespace(
            count=lambda: 0, first=SimpleNamespace(is_visible=lambda: False)
        ),
        locator=lambda _selector: SimpleNamespace(
            count=lambda: 0, first=SimpleNamespace(is_visible=lambda: False)
        ),
    )
    assert payment_module._has_real_security_challenge(page) is True


def test_has_real_security_challenge_detects_text_indicator_on_paypal_mock(monkeypatch):
    """paypal_mock 页面下，正文文本明确出现 "security challenge" → 应判为真挑战。"""
    monkeypatch.setattr(
        payment_module, "_page_body_text",
        lambda page: "Please complete this security challenge to continue.",
    )
    page = SimpleNamespace(
        url="https://www.paypal.com/pay?token=BA-X",
        evaluate=lambda _script: "",
        frames=[],
    )
    assert payment_module._has_real_security_challenge(page) is True


def test_has_real_security_challenge_falls_back_to_loose_off_paypal_mock():
    """非 paypal_mock 页面（如 CTF sandbox）应回退到宽松版，仍保留 frame URL
    检测以兼容老流程。"""
    page = SimpleNamespace(
        url="https://www.sandbox.paypal.com/checkoutweb/something",  # 非 /pay?token=BA-
        evaluate=lambda _script: "",
        frames=[SimpleNamespace(url="https://challenges.cloudflare.com/turnstile/iframe")],
        get_by_text=lambda _pattern: SimpleNamespace(
            count=lambda: 0, first=SimpleNamespace(is_visible=lambda: False)
        ),
        locator=lambda _selector: SimpleNamespace(
            count=lambda: 0, first=SimpleNamespace(is_visible=lambda: False)
        ),
    )
    # 在非 paypal_mock 页面回退到宽松实现，frame URL 关键字命中即返回 True
    assert payment_module._has_real_security_challenge(page) is True


def test_try_auto_solve_security_challenge_uses_recaptcha_when_turnstile_missing(monkeypatch):
    monkeypatch.setattr(payment_module, "_extract_turnstile_sitekey", lambda page: "")
    monkeypatch.setattr(payment_module, "_extract_recaptcha_sitekey", lambda page: "RECAPTCHA_SITEKEY", raising=False)
    monkeypatch.setattr(payment_module, "_current_page_url", lambda page: "https://www.paypal.com/checkoutweb/signup")

    injected = {}

    def fake_inject(page, token):
        injected["token"] = token
        return True

    monkeypatch.setattr(payment_module, "_inject_recaptcha_token", fake_inject, raising=False)
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda page: False)

    captured = {}

    def solver(page_url, site_key, challenge_type="turnstile"):
        captured["url"] = page_url
        captured["key"] = site_key
        captured["type"] = challenge_type
        return "RECAPTCHA_TOKEN_VALUE"

    page = SimpleNamespace(wait_for_timeout=lambda ms: None)
    assert payment_module._try_auto_solve_security_challenge(
        page, solver=solver, log=lambda message: None
    ) is True
    assert injected["token"] == "RECAPTCHA_TOKEN_VALUE"
    assert captured == {
        "url": "https://www.paypal.com/checkoutweb/signup",
        "key": "RECAPTCHA_SITEKEY",
        "type": "recaptcha_v2",
    }


def test_chatgpt_platform_recaptcha_fallback_uses_next_provider(monkeypatch):
    attempted = []

    class FailingSolver:
        def solve_recaptcha_v2(self, page_url: str, site_key: str) -> str:
            raise RuntimeError("ERROR_ZERO_BALANCE")

    class WorkingSolver:
        def solve_recaptcha_v2(self, page_url: str, site_key: str) -> str:
            return "recaptcha-token"

    monkeypatch.setattr(
        ChatGPTPlatform,
        "_get_captcha_solver_candidates",
        lambda self: ["yescaptcha_api", "local_solver"],
    )

    def fake_make_captcha(self, **kwargs):
        provider_key = str(kwargs.get("provider_key") or "")
        attempted.append(provider_key)
        if provider_key == "yescaptcha_api":
            return FailingSolver()
        if provider_key == "local_solver":
            return WorkingSolver()
        raise AssertionError(f"unexpected provider: {provider_key}")

    monkeypatch.setattr(ChatGPTPlatform, "_make_captcha", fake_make_captcha)

    platform = ChatGPTPlatform(config=RegisterConfig(executor_type="protocol"))

    assert platform.solve_recaptcha_v2_with_fallback("https://paypal.test/signup", "sitekey") == "recaptcha-token"
    assert attempted == ["yescaptcha_api", "local_solver"]


def test_chatgpt_checkout_solver_uses_yescaptcha_directly(monkeypatch):
    attempted = []

    class YesCaptchaSolver:
        def solve_recaptcha_v2(self, page_url: str, site_key: str) -> str:
            attempted.append(("recaptcha", page_url, site_key))
            return "recaptcha-token"

    platform = ChatGPTPlatform(config=RegisterConfig(executor_type="protocol"))
    monkeypatch.setattr(
        platform,
        "_has_configured_captcha",
        lambda provider_key: provider_key == "yescaptcha_api",
    )
    monkeypatch.setattr(
        platform,
        "_make_captcha",
        lambda **kwargs: YesCaptchaSolver() if kwargs.get("provider_key") == "yescaptcha_api" else (_ for _ in ()).throw(AssertionError("unexpected provider")),
    )

    solver = platform._build_turnstile_solver_for_checkout()

    assert callable(solver)
    assert solver("https://paypal.test/signup", "sitekey", "recaptcha_v2") == "recaptcha-token"
    assert attempted == [("recaptcha", "https://paypal.test/signup", "sitekey")]


def _make_protocol_dispatch_account():
    return Account(
        platform="chatgpt",
        email="user@example.com",
        password="Secret123!",
        token="",
        extra={
            "access_token": "at_123",
            "cookies": "__Secure-next-auth.session-token=sess_123",
        },
    )


def _patch_payment_link_dispatch(monkeypatch, protocol_result, camoufox_result, calls):
    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None, **kwargs):
        return "https://checkout.stripe.com/c/pay/cs_test_plus"

    def fake_protocol(**kwargs):
        calls.setdefault("protocol", []).append(kwargs)
        return protocol_result

    def fake_camoufox(**kwargs):
        calls.setdefault("camoufox", []).append(kwargs)
        return camoufox_result

    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_camoufox, raising=False)
    monkeypatch.setattr(
        payment_module,
        "complete_paypal_checkout_protocol",
        fake_protocol,
        raising=False,
    )


def test_chatgpt_payment_link_protocol_mode_fails_fast_without_camoufox_fallback(monkeypatch):
    """协议模式失败时**不再**自动回落 camoufox：直接把协议失败结果作为最终结果返回。

    这样可以：
    1. 让协议链的真实失败原因（stage、error）不被 camoufox 兜底掩盖
    2. 节省每次失败都要起浏览器跑 camoufox 的时间
    3. 真要 fallback，由前端切换 checkout_mode 重新发起
    """
    calls: dict = {}
    _patch_payment_link_dispatch(
        monkeypatch,
        protocol_result={
            "ok": False,
            "status": "stage_failed",
            "error": "PayPal /agreements/approve TLS error",
            "fallback_recommended": True,
            "stage": "paypal_approve",
        },
        camoufox_result={
            "ok": True,
            "status": "submitted",
            "final_url": "https://paypal.test/done",
            "error": "",
        },
        calls=calls,
    )

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {"plan": "plus", "country": "US", "auto_checkout": "true", "checkout_mode": "protocol"},
    )

    # 协议失败 → 整个 action 也失败，不再用 camoufox 救场
    assert result["ok"] is False
    assert len(calls.get("protocol", [])) == 1
    assert calls.get("camoufox") is None  # ← 关键：没有调用 camoufox
    assert result["data"]["checkout_mode"] == "protocol"
    # 协议失败原因原样透传，便于排查
    assert result["data"]["checkout_automation"]["stage"] == "paypal_approve"
    assert "TLS" in result["data"]["checkout_automation"]["error"]


def test_chatgpt_payment_link_protocol_mode_succeeds_skips_camoufox(monkeypatch):
    calls: dict = {}
    _patch_payment_link_dispatch(
        monkeypatch,
        protocol_result={
            "ok": True,
            "status": "ctf_completed",
            "final_url": "https://chatgpt.com/",
            "error": "",
        },
        camoufox_result={"ok": True, "status": "submitted", "final_url": "", "error": ""},
        calls=calls,
    )

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {"plan": "plus", "country": "US", "auto_checkout": "true", "checkout_mode": "protocol"},
    )

    assert result["ok"] is True
    assert len(calls.get("protocol", [])) == 1
    assert calls.get("camoufox") is None
    assert result["data"]["checkout_automation"]["status"] == "ctf_completed"


def test_chatgpt_payment_link_camoufox_headless_mode_uses_headless_true(monkeypatch):
    calls: dict = {}
    _patch_payment_link_dispatch(
        monkeypatch,
        protocol_result={"ok": False, "error": "unused"},
        camoufox_result={"ok": True, "status": "submitted", "final_url": "", "error": ""},
        calls=calls,
    )

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {"plan": "plus", "country": "US", "auto_checkout": "true", "checkout_mode": "camoufox_headless"},
    )

    assert result["ok"] is True
    assert calls.get("protocol") is None
    assert len(calls["camoufox"]) == 1
    assert calls["camoufox"][0]["headless"] is True


def test_chatgpt_payment_link_protocol_long_link_feeds_authorize_url_to_browser(monkeypatch):
    calls: dict = {}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None, **kwargs):
        calls.setdefault("generate", []).append(kwargs)
        return "https://pay.openai.com/c/pay/cs_live_demo"

    def fake_go_extract(**kwargs):
        calls.setdefault("go_extract", []).append(kwargs)
        return {
            "ok": True,
            "protocol_backend": "go",
            "paypal_authorize_url": "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
        }

    def fake_python_extract(**kwargs):
        raise AssertionError("protocol long-link mode must use Go gateway")

    def fake_camoufox(**kwargs):
        calls.setdefault("camoufox", []).append(kwargs)
        return {
            "ok": True,
            "status": "ctf_completed",
            "final_url": "https://chatgpt.com/",
            "error": "",
        }

    monkeypatch.setenv("PAYPAL_PROTOCOL_GATEWAY_URL", "http://127.0.0.1:8787")
    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "extract_paypal_authorize_link_go", fake_go_extract, raising=False)
    monkeypatch.setattr(payment_module, "extract_paypal_authorize_link_protocol", fake_python_extract, raising=False)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_camoufox, raising=False)

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {
            "plan": "plus",
            "country": "US",
            "auto_checkout": "true",
            "checkout_mode": "camoufox_headless",
            "use_stripe_init": "true",
        },
    )

    assert result["ok"] is True
    assert calls["generate"][0]["use_stripe_init"] is True
    assert calls["go_extract"][0]["access_token"] == "at_123"
    assert calls["go_extract"][0]["proxy"] == "http://us-proxy.example:8080"
    assert calls["camoufox"][0]["checkout_url"] == "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y"
    assert result["data"]["checkout_url"] == "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y"
    assert result["data"]["cashier_url"] == "https://pay.openai.com/c/pay/cs_live_demo"


def test_chatgpt_payment_link_protocol_long_link_requires_go_gateway(monkeypatch):
    calls: dict = {}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None, **kwargs):
        calls.setdefault("generate", []).append(kwargs)
        return "https://pay.openai.com/c/pay/cs_live_demo"

    def fake_python_extract(**kwargs):
        calls.setdefault("python_extract", []).append(kwargs)
        return {
            "ok": True,
            "paypal_authorize_url": "https://pm-redirects.stripe.com/authorize/acct_py/sa_nonce_py",
        }

    def fake_camoufox(**kwargs):
        calls.setdefault("camoufox", []).append(kwargs)
        return {"ok": True, "status": "should_not_run", "final_url": "", "error": ""}

    monkeypatch.delenv("PAYPAL_PROTOCOL_GATEWAY_URL", raising=False)
    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "extract_paypal_authorize_link_protocol", fake_python_extract, raising=False)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_camoufox, raising=False)

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {
            "plan": "plus",
            "country": "US",
            "auto_checkout": "true",
            "checkout_mode": "camoufox_headless",
            "use_stripe_init": "true",
        },
    )

    assert result["ok"] is False
    assert calls["generate"][0]["use_stripe_init"] is True
    assert calls.get("python_extract") is None
    assert calls.get("camoufox") is None
    assert result["data"]["checkout_url"] == "https://pay.openai.com/c/pay/cs_live_demo"
    assert result["data"]["paypal_protocol_extract"]["protocol_backend"] == "go"
    assert "PAYPAL_PROTOCOL_GATEWAY_URL" in result["error"]


def test_chatgpt_payment_link_protocol_long_link_can_use_go_gateway(monkeypatch):
    calls: dict = {}

    def fake_generate_plus_link(account_arg, *, proxy=None, country="SG", currency=None, **kwargs):
        calls.setdefault("generate", []).append(kwargs)
        return "https://pay.openai.com/c/pay/cs_live_demo"

    def fake_go_extract(**kwargs):
        calls.setdefault("go_extract", []).append(kwargs)
        return {
            "ok": True,
            "protocol_backend": "go",
            "paypal_authorize_url": "https://pm-redirects.stripe.com/authorize/acct_go/sa_nonce_go",
        }

    def fake_python_extract(**kwargs):
        raise AssertionError("should use Go gateway when PAYPAL_PROTOCOL_GATEWAY_URL is set")

    def fake_camoufox(**kwargs):
        calls.setdefault("camoufox", []).append(kwargs)
        return {
            "ok": True,
            "status": "ctf_completed",
            "final_url": "https://chatgpt.com/",
            "error": "",
        }

    monkeypatch.setenv("PAYPAL_PROTOCOL_GATEWAY_URL", "http://127.0.0.1:8090")
    monkeypatch.setattr(payment_module, "generate_plus_link", fake_generate_plus_link)
    monkeypatch.setattr(payment_module, "extract_paypal_authorize_link_go", fake_go_extract, raising=False)
    monkeypatch.setattr(payment_module, "extract_paypal_authorize_link_protocol", fake_python_extract, raising=False)
    monkeypatch.setattr(payment_module, "complete_paypal_checkout", fake_camoufox, raising=False)

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {
            "plan": "plus",
            "country": "US",
            "auto_checkout": "true",
            "checkout_mode": "camoufox_headless",
            "use_stripe_init": "true",
        },
    )

    assert result["ok"] is True
    assert calls["go_extract"][0]["access_token"] == "at_123"
    assert calls["go_extract"][0]["gateway_url"] == "http://127.0.0.1:8090"
    assert calls["go_extract"][0]["proxy"] == "http://us-proxy.example:8080"
    assert calls["camoufox"][0]["checkout_url"] == "https://pm-redirects.stripe.com/authorize/acct_go/sa_nonce_go"
    assert result["data"]["paypal_protocol_extract"]["protocol_backend"] == "go"


def test_chatgpt_payment_link_camoufox_headed_mode_uses_headless_false(monkeypatch):
    calls: dict = {}
    _patch_payment_link_dispatch(
        monkeypatch,
        protocol_result={"ok": False, "error": "unused"},
        camoufox_result={"ok": True, "status": "submitted", "final_url": "", "error": ""},
        calls=calls,
    )

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {"plan": "plus", "country": "US", "auto_checkout": "true", "checkout_mode": "camoufox_headed"},
    )

    assert result["ok"] is True
    assert calls.get("protocol") is None
    assert calls["camoufox"][0]["headless"] is False


def test_chatgpt_payment_link_record_har_passes_har_path(monkeypatch):
    calls: dict = {}
    _patch_payment_link_dispatch(
        monkeypatch,
        protocol_result={"ok": False, "error": "unused"},
        camoufox_result={"ok": True, "status": "submitted", "final_url": "", "error": ""},
        calls=calls,
    )

    platform = ChatGPTPlatform(config=RegisterConfig(proxy="http://us-proxy.example:8080"))
    result = platform.execute_action(
        "payment_link",
        _make_protocol_dispatch_account(),
        {"plan": "plus", "country": "US", "auto_checkout": "true", "record_har": "true"},
    )

    assert result["ok"] is True
    har_path = calls["camoufox"][0]["record_har_path"]
    assert har_path and har_path.endswith(".har")
    assert "user_example.com" in har_path
    assert result["data"]["record_har_path"] == har_path


class _FakeContextWithPages:
    def __init__(self):
        self.pages = []


class _FakeBrowserPage:
    def __init__(self, *, url="", closed=False, context=None):
        self.url = url
        self._closed = closed
        self.context = context
        self.wait_calls = 0

    def is_closed(self):
        return self._closed

    def wait_for_function(self, *args, **kwargs):
        self.wait_calls += 1
        if self._closed:
            raise RuntimeError(
                "Page.wait_for_function: Target page, context or browser has been closed"
            )


def test_pick_active_page_returns_original_when_alive():
    page = _FakeBrowserPage(url="https://example.test/", closed=False)
    assert payment_module._pick_active_page(page) is page


def test_pick_active_page_returns_alive_sibling_when_original_closed():
    ctx = _FakeContextWithPages()
    parent = _FakeBrowserPage(
        url="https://checkout.stripe.com/c/pay/cs_test", closed=False, context=ctx
    )
    popup = _FakeBrowserPage(
        url="https://www.paypal.com/checkoutweb/signup", closed=True, context=ctx
    )
    ctx.pages = [parent, popup]

    assert payment_module._pick_active_page(popup) is parent


def test_pick_active_page_raises_when_no_alive_page():
    ctx = _FakeContextWithPages()
    only = _FakeBrowserPage(url="https://example.test/", closed=True, context=ctx)
    ctx.pages = [only]

    import pytest

    with pytest.raises(RuntimeError, match="camoufox 上下文中已无存活的 page"):
        payment_module._pick_active_page(only)


def test_pick_active_page_keeps_fake_page_without_is_closed():
    class _NoIsClosedFake:
        url = "https://example.test/"

    page = _NoIsClosedFake()
    assert payment_module._pick_active_page(page) is page


def test_wait_for_chatgpt_return_recovers_to_alive_sibling_after_popup_closed(monkeypatch):
    """popup 已关闭时切换到 context 中存活的 sibling 页面继续等待。

    新的轮询实现：sibling 一进来就已经在 ``chatgpt.*`` 域 → 第一轮就直接返回，
    不再调 ``wait_for_function``（这个改动只是把"长 wait_for_function + 重试"
    换成"轮询 + 中间页/captcha 自动处理"），契约层面"返回 sibling 的 chatgpt
    URL"仍然成立。
    """
    ctx = _FakeContextWithPages()
    parent = _FakeBrowserPage(
        url="https://chatgpt.com/payment-success", closed=False, context=ctx
    )
    popup = _FakeBrowserPage(
        url="https://www.paypal.com/checkoutweb/signup", closed=True, context=ctx
    )
    ctx.pages = [parent, popup]
    logs = []
    # 屏蔽 review / challenge 检测，避免 _FakeBrowserPage 缺 locator 时走入误判
    monkeypatch.setattr(payment_module, "_paypal_review_page_visible", lambda p: False)
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda p: False)

    final_url = payment_module._wait_for_chatgpt_return(
        popup, timeout_ms=300000, log=logs.append
    )

    assert final_url == "https://chatgpt.com/payment-success"
    # `_pick_active_page` 必须发挥作用 → 日志一定出现 sibling 切换
    assert any("切换到上下文中存活的 page" in message for message in logs)


def test_wait_for_chatgpt_return_raises_when_no_page_navigates_to_chatgpt(monkeypatch):
    """所有页面始终停在 PayPal 域 / about:blank → 超时后必须抛
    ``CTF sandbox 未跳回 chatgpt``。"""
    ctx = _FakeContextWithPages()
    parent = _FakeBrowserPage(
        url="https://www.paypal.com/checkoutweb/signup", closed=False, context=ctx
    )
    popup = _FakeBrowserPage(url="about:blank", closed=True, context=ctx)
    ctx.pages = [parent, popup]
    # 屏蔽中间页 / challenge 检测，让轮询循环空转直到超时
    monkeypatch.setattr(payment_module, "_paypal_review_page_visible", lambda p: False)
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda p: False)
    # 快进 monotonic：第 1 次返回 0 进入循环，第 2 次返回 9999 立刻超时
    clock = {"n": 0}

    def fake_monotonic():
        clock["n"] += 1
        return 0.0 if clock["n"] <= 1 else 1_000_000.0

    monkeypatch.setattr(payment_module.time, "monotonic", fake_monotonic)

    import pytest

    with pytest.raises(RuntimeError, match="CTF sandbox 未跳回 chatgpt"):
        payment_module._wait_for_chatgpt_return(
            popup, timeout_ms=300000, log=lambda m: None
        )


# ====================================================================
# GuJumpgate 兼容 —— PayPal 软 captcha DOM stripper + guest 入口测试
# ====================================================================
#
# 实战背景：FoundZiGu/GuJumpgate Chrome 扩展用 DOM 删除而非 captcha 求解
# 来过 PayPal hosted checkout 软 captcha 浮层，README 自称 100% 通过率。
# 我们的 payment.py 借鉴这条思路，新增两个 helper：
#   1) _install_paypal_captcha_dom_stripper —— 删 #captcha-standalone /
#      .captcha-overlay / .captcha-container + 装 MutationObserver 守 30s。
#   2) _try_click_paypal_pay_with_card_or_guest —— 在 Create-an-account
#      之前先试点 "Pay with card" / "Continue as Guest" 直通 guest 表单。
# 下面 7 个单测锁死这两个 helper 的行为契约，避免回归。


def test_paypal_captcha_dom_stripper_js_contains_three_gujumpgate_selectors():
    """stripper JS 必须包含 GuJumpgate 同款三个选择器，少一个都让 captcha 漏过。"""
    js = payment_module._PAYPAL_CAPTCHA_DOM_STRIPPER_JS
    assert "#captcha-standalone" in js
    assert ".captcha-overlay" in js
    assert ".captcha-container" in js


def test_paypal_captcha_dom_stripper_js_installs_mutation_observer_20min():
    """JS 必须装 MutationObserver + 1s setInterval 双保险，setTimeout 1200000ms
    (20min) 内自动 disconnect/clearInterval。

    20min 覆盖更长的 JP 流程（统一 guest 表单 + SMS OTP 120s 初始 + 多轮
    Resend + 换号，经常超过早期 5min），比 5min 更鲁棒——PayPal NGRL 异常
    检测会在 SMS 等待空窗里异步注入 reCAPTCHA authchallenge 浮层。
    setInterval 主动周期扫补 MutationObserver 漏检（display 切换不触发
    childList 回调的情况）。"""
    js = payment_module._PAYPAL_CAPTCHA_DOM_STRIPPER_JS
    assert "MutationObserver" in js
    assert "observer.disconnect()" in js
    # 周期主动扫（1s ticker）+ 清理
    assert "setInterval" in js
    assert "clearInterval" in js
    # observer/ticker 寿命 20min（1200000ms），不是早期的 5min/30s
    assert "1200000" in js
    # 防重复装的 sentinel
    assert "__MULTIPAGE_PAYPAL_CAPTCHA_STRIPPER__" in js


def test_install_paypal_captcha_dom_stripper_walks_main_page_and_all_frames():
    """stripper 必须既调用主 page.evaluate 又遍历所有 frame.evaluate，
    否则 PayPal 把 captcha 塞在子 frame 里时会漏掉。"""
    calls = {"page": 0, "frames": 0}

    class _Frame:
        def evaluate(self, _js):
            calls["frames"] += 1
            return 1

    class _Page:
        url = "https://www.paypal.com/checkoutweb/signup"
        frames = [_Frame(), _Frame(), _Frame()]

        def evaluate(self, _js):
            calls["page"] += 1
            return 2

    logs: list[str] = []
    total = payment_module._install_paypal_captcha_dom_stripper(_Page(), log=logs.append)

    assert calls["page"] == 1
    assert calls["frames"] == 3
    # 主 page 删 2 + 3 个 frame 各删 1 = 5
    assert total == 5
    # 删了节点要 log 出来便于诊断（"立即删除 5 个节点"）
    assert any("立即删除 5" in m for m in logs)
    # observer 5min 守候要在 log 里说明，让运维知道脚本仍在跑
    assert any("5min" in m or "5 min" in m for m in logs)


def test_install_paypal_captcha_dom_stripper_swallows_page_evaluate_error():
    """主 page evaluate 抛错时打 warn log，不阻塞主流程；frame 异常静默。"""
    calls = {"frames_called": 0}

    class _BadFrame:
        def evaluate(self, _js):
            calls["frames_called"] += 1
            raise RuntimeError("cross-origin frame")

    class _Page:
        url = "https://www.paypal.com/pay/?token=BA-X"
        frames = [_BadFrame()]

        def evaluate(self, _js):
            raise RuntimeError("page closed")

    logs: list[str] = []
    total = payment_module._install_paypal_captcha_dom_stripper(_Page(), log=logs.append)
    assert total == 0
    # 主 page 异常要 log warn，frame 异常静默
    assert any("主 page 装 PayPal captcha DOM stripper 失败" in m for m in logs)
    # frame.evaluate 仍要被尝试调用
    assert calls["frames_called"] == 1


def test_try_click_paypal_pay_with_card_or_guest_returns_false_when_no_button(monkeypatch):
    """找不到 guest 入口按钮时必须返 False，让调用方回退 Create-an-account。"""

    class _NoButtonLocator:
        def __init__(self):
            self._call_count = 0

        def is_visible(self, timeout=0):
            return False

        def is_enabled(self, timeout=0):
            return False

    class _Page:
        url = "https://www.paypal.com/pay/?token=BA-X"

        def get_by_role(self, role, name=None):
            class _Chain:
                first = _NoButtonLocator()

            return _Chain()

        def get_by_text(self, _pattern):
            class _Chain:
                first = _NoButtonLocator()

            return _Chain()

        def locator(self, _selector):
            class _Chain:
                first = _NoButtonLocator()

            return _Chain()

    logs: list[str] = []
    monkeypatch.setattr(payment_module, "_locator_ready", lambda locator: False)
    ok = payment_module._try_click_paypal_pay_with_card_or_guest(_Page(), log=logs.append)
    assert ok is False
    # 不找到按钮是正常情况，不应 log warn
    assert not any("失败" in m for m in logs)


def test_try_click_paypal_pay_with_card_or_guest_clicks_first_ready_button(monkeypatch):
    """命中第一个 ready 的 locator 后调 _click_or_check，并 log 出已点击。"""
    clicked = {"n": 0}

    class _ReadyLocator:
        pass

    class _Page:
        url = "https://www.paypal.com/pay/?token=BA-X"

        def get_by_role(self, role, name=None):
            class _Chain:
                first = _ReadyLocator()

            return _Chain()

        def get_by_text(self, _pattern):
            class _Chain:
                first = _ReadyLocator()

            return _Chain()

        def locator(self, _selector):
            class _Chain:
                first = _ReadyLocator()

            return _Chain()

        def wait_for_timeout(self, _ms):
            return None

    monkeypatch.setattr(payment_module, "_locator_ready", lambda locator: True)

    def _fake_click(locator):
        clicked["n"] += 1

    monkeypatch.setattr(payment_module, "_click_or_check", _fake_click)
    logs: list[str] = []
    ok = payment_module._try_click_paypal_pay_with_card_or_guest(_Page(), log=logs.append)
    assert ok is True
    assert clicked["n"] == 1
    assert any("已点击 PayPal guest 入口" in m for m in logs)


def test_paypal_guest_entry_pattern_matches_english_and_chinese_button_text():
    """正则要覆盖：英文 "Pay with debit or credit card" / "Continue as Guest"
    + 中文 "不创建账户" / "访客"，避免 PayPal 各语言版本漏识别。

    注意：``_try_click_paypal_pay_with_card_or_guest`` 函数本身**不再在
    ChatGPT Plus 订阅 checkout 流程中被调用**（订阅用 BA token，PayPal 不
    提供 guest checkout），但函数 + 正则保留供单测和未来一次性付款场景复用。
    """
    pat = payment_module._PAYPAL_GUEST_ENTRY_BUTTON_PATTERN
    assert pat.search("Pay with debit or credit card")
    assert pat.search("Pay with credit or debit card")
    assert pat.search("Pay with card")
    assert pat.search("Continue as Guest")
    assert pat.search("Guest checkout")
    assert pat.search("不创建账户继续")
    assert pat.search("访客结账")
    # 不应误识 Create-an-account
    assert not pat.search("Create an account")
    assert not pat.search("Log in to PayPal")


def test_install_paypal_captcha_dom_stripper_logs_even_when_zero_nodes_removed():
    """**实战诊断需求**：stripper 实际跑了但没找到节点也要打 log，
    让运维能区分"没跑"和"跑了但目标 DOM 不存在"。早期版本只在 removed>0
    时打 log，运维看不到任何输出会以为函数没被调用——浪费排查时间。"""

    class _Page:
        url = "https://www.paypal.com/checkoutweb/signup"
        frames: list = []

        def evaluate(self, _js):
            return 0  # 啥也没删

    logs: list[str] = []
    total = payment_module._install_paypal_captcha_dom_stripper(_Page(), log=logs.append)
    assert total == 0
    # 即使 0 也要 log，且 log 里必须含具体数字 + observer 守候期声明
    assert any("立即删除 0" in m for m in logs)
    assert any("5min" in m or "5 min" in m for m in logs)


def test_arm_paypal_captcha_stripper_on_navigations_calls_add_init_script():
    """``_arm_paypal_captcha_stripper_on_navigations`` 必须调用 page.add_init_script，
    传入与 _install_paypal_captcha_dom_stripper 同款 JS——这样 Playwright 才
    会在每次 navigate 时**自动**注入脚本（GuJumpgate Chrome 扩展 content
    script ``run_at=document_start`` 同款）。"""
    captured: dict = {}

    class _Page:
        def add_init_script(self, script):
            captured["script"] = script

    logs: list[str] = []
    ok = payment_module._arm_paypal_captcha_stripper_on_navigations(_Page(), log=logs.append)
    assert ok is True
    # 传给 add_init_script 的 JS 必须就是 stripper JS 本身
    assert captured["script"] == payment_module._PAYPAL_CAPTCHA_DOM_STRIPPER_JS
    # arm 成功要 log，让运维知道 init_script 已挂上
    assert any("arm PayPal captcha stripper init_script" in m for m in logs)


def test_arm_paypal_captcha_stripper_swallows_add_init_script_error():
    """add_init_script 抛错（page 已 close / context 失活）时返 False + warn log，
    不能阻塞 checkout 主流程——stripper 失败不应让付款卡死。"""

    class _DeadPage:
        def add_init_script(self, _script):
            raise RuntimeError("Target page, context or browser has been closed")

    logs: list[str] = []
    ok = payment_module._arm_paypal_captcha_stripper_on_navigations(_DeadPage(), log=logs.append)
    assert ok is False
    assert any("arm PayPal captcha stripper init_script 失败" in m for m in logs)


def test_open_unique_camoufox_page_arms_paypal_captcha_stripper(monkeypatch):
    """**集成保险**：``_open_unique_camoufox_page`` 创建 page 后必须立刻调
    ``_arm_paypal_captcha_stripper_on_navigations``——否则 init_script 没装上，
    后续每次 navigate 不会自动跑 stripper，GuJumpgate 同款保护失效。

    这是 hot-path 单测，防止有人 refactor 时不小心删掉那一行。"""
    arm_calls = {"n": 0, "log": None}

    class _Browser:
        def new_page(self):
            class _Page:
                def set_default_timeout(self, _ms):
                    pass

            return _Page()

    def fake_enter(_opts, _log, _backend_config=None):
        return ("ctx", _Browser())

    def fake_arm(_page, *, log):
        arm_calls["n"] += 1
        arm_calls["log"] = log
        return True

    def fake_fingerprint(_page):
        return "abc123def456"  # 任意非空指纹，让 first-attempt 直接返回

    monkeypatch.setattr(payment_module, "_enter_camoufox_browser", fake_enter)
    monkeypatch.setattr(
        payment_module,
        "_arm_paypal_captcha_stripper_on_navigations",
        fake_arm,
    )
    monkeypatch.setattr(payment_module, "_collect_camoufox_fingerprint_hash", fake_fingerprint)
    monkeypatch.setattr(payment_module, "_remember_camoufox_fingerprint_hash", lambda _h: True)

    logs: list[str] = []
    payment_module._open_unique_camoufox_page(
        launch_opts={},
        log=logs.append,
        browser_timeout=30000,
    )
    # arm 必须被调用 ≥1 次，并且 log 通道是 _open_unique_camoufox_page 的 log
    # （bound-method instance 不能用 is 比较，比 __self__ 身份以确保是同一 list）
    assert arm_calls["n"] >= 1
    assert arm_calls["log"].__self__ is logs


def test_open_ctf_create_account_and_continue_does_not_call_guest_entry_for_ba_subscription(monkeypatch):
    """**回归测试**：``_open_ctf_create_account_and_continue`` 在 ChatGPT Plus 订阅
    流程下**不能**调 ``_try_click_paypal_pay_with_card_or_guest``——BA token
    订阅 PayPal 不提供 guest checkout，调它就是浪费 6 个 locator 试探。

    早期版本在 attempt==1 时会调，每次都 silently 返 False 后回退到
    Create-an-account——这次测试锁死"完全不调用"行为。"""
    guest_call_count = {"n": 0}

    def fake_guest_entry(_page, **_kwargs):
        guest_call_count["n"] += 1
        return False

    # 让流程走到第一次创建账号尝试就够了，不需要走完整循环
    monkeypatch.setattr(
        payment_module,
        "_try_click_paypal_pay_with_card_or_guest",
        fake_guest_entry,
    )
    monkeypatch.setattr(payment_module, "_install_paypal_captcha_dom_stripper", lambda *a, **kw: 0)
    monkeypatch.setattr(payment_module, "_is_paypal_pay_create_url", lambda _u: True)
    monkeypatch.setattr(payment_module, "_current_page_url", lambda _p: "https://www.paypal.com/pay/?token=BA-X")
    monkeypatch.setattr(payment_module, "_solve_challenge_if_present", lambda *a, **kw: None, raising=False)
    monkeypatch.setattr(payment_module, "_ctf_create_account_ready", lambda _p: True)
    click_called = {"n": 0}

    def fake_click_create(_p):
        click_called["n"] += 1

    monkeypatch.setattr(payment_module, "_click_ctf_create_account", fake_click_create)
    monkeypatch.setattr(payment_module, "_ctf_signup_form_ready", lambda _p: True)
    monkeypatch.setattr(
        payment_module,
        "_fill_ctf_signup_email",
        lambda _p, _i: None,
    )
    monkeypatch.setattr(
        payment_module,
        "_click_ctf_continue_to_payment",
        lambda _p: None,
    )

    class _Page:
        pass

    payment_module._open_ctf_create_account_and_continue(
        _Page(),
        identity={"email": "x@y.com"},
        log=lambda _m: None,
    )

    # **关键 assert**：guest-entry 函数一次都不能被调用
    assert guest_call_count["n"] == 0
    # Create-an-account 流程要正常跑（至少点了一次）
    assert click_called["n"] >= 1


# === PayPal SMS OTP popup 容错三件套 + 主循环新行为单测 =================================
#
# 覆盖三个新原语：``_click_ctf_resend_in_popup`` / ``_detect_ctf_phone_rejected``
# / ``_close_ctf_popup_if_present``，以及在 ``_complete_ctf_sandbox_flow`` 主
# 循环里的轮换 / Resend 重试 / 拒号关 popup 三条新分支。
# 全部按"用户原话"测试（"号码不行的话会有弹窗直接告诉你换号码"、"点击 Resend
# 继续重试获取验证码"），失败就告诉用户 PayPal popup DOM 改了 / 主循环逻辑跑偏了。

class _FakePopupLocator:
    """辅助函数级单测用：可控的 ready/click。

    **关键**：``first`` 用 ``@property`` 返回 self，而不是老测试常见的
    ``first = None`` class attr。后者会让 ``page.locator(sel).first`` 拿到
    None，下游 ``_click_or_check`` 直接 AttributeError，本测试用于断言成功
    路径必须能跑通真实分支。
    """

    def __init__(self, *, ready: bool, on_click=None, tag: str = "BUTTON"):
        self._ready = ready
        self._on_click = on_click
        self._tag = tag
        self.clicked = False

    @property
    def first(self):
        return self

    def count(self) -> int:
        return 1 if self._ready else 0

    def is_visible(self) -> bool:
        return self._ready

    def is_enabled(self) -> bool:
        return self._ready

    def evaluate(self, _script):
        return self._tag

    def click(self, **_kwargs):
        self.clicked = True
        if callable(self._on_click):
            self._on_click()

    def check(self, **_kwargs):
        self.clicked = True
        if callable(self._on_click):
            self._on_click()


def test_click_ctf_resend_in_popup_clicks_dialog_scoped_button():
    """有 ``[role="dialog"] button:has-text("Resend code")`` 时应点击并返回 True。"""

    resend_locator = _FakePopupLocator(ready=True)
    other_locator = _FakePopupLocator(ready=False)

    class FakePage:
        def locator(self, selector):
            if 'role="dialog"' in selector and "Resend code" in selector:
                return resend_locator
            return other_locator

        def get_by_role(self, _role, name=None):
            return other_locator

        def get_by_text(self, _pattern):
            return other_locator

    logs: list[str] = []
    assert payment_module._click_ctf_resend_in_popup(FakePage(), log=logs.append) is True
    assert resend_locator.clicked is True
    assert any("Resend" in m for m in logs)


def test_click_ctf_resend_in_popup_returns_false_when_no_button():
    """popup 上没有任何可点的 Resend 按钮时返回 False，不抛错。"""

    dead = _FakePopupLocator(ready=False)

    class FakePage:
        def locator(self, _selector):
            return dead

        def get_by_role(self, _role, name=None):
            return dead

        def get_by_text(self, _pattern):
            return dead

    logs: list[str] = []
    assert payment_module._click_ctf_resend_in_popup(FakePage(), log=logs.append) is False


def test_detect_ctf_phone_rejected_matches_english_phone_not_supported(monkeypatch):
    """``Phone number not supported`` 等英文拒号文案要被识别。"""

    monkeypatch.setattr(
        payment_module,
        "_page_body_text",
        lambda page: "Sorry, this phone number is not supported. Please try another phone.",
    )

    class FakePage:
        pass

    rejected, reason = payment_module._detect_ctf_phone_rejected(FakePage())
    assert rejected is True
    assert "supported" in reason.lower() or "another phone" in reason.lower()


def test_detect_ctf_phone_rejected_matches_chinese_phrase(monkeypatch):
    """中文 "无法发送" / "请使用其他号码" 也要匹配，覆盖 PayPal 中文 locale。"""

    monkeypatch.setattr(
        payment_module,
        "_page_body_text",
        lambda page: "我们无法发送验证码，请使用其他号码再试。",
    )

    class FakePage:
        pass

    rejected, reason = payment_module._detect_ctf_phone_rejected(FakePage())
    assert rejected is True
    assert "无法发送" in reason or "其他号码" in reason


def test_detect_ctf_phone_rejected_returns_false_for_neutral_text(monkeypatch):
    """正常的 OTP popup 文案（"Enter the code"）不应被误判为拒号。"""

    monkeypatch.setattr(
        payment_module,
        "_page_body_text",
        lambda page: "Enter the 6-digit security code we sent to your phone.",
    )

    class FakePage:
        pass

    rejected, reason = payment_module._detect_ctf_phone_rejected(FakePage())
    assert rejected is False
    assert reason == ""


def test_close_ctf_popup_if_present_clicks_close_button():
    """popup 上有 ``[role="dialog"] [aria-label="Close"]`` 时应点击它。"""

    close_locator = _FakePopupLocator(ready=True)
    dead = _FakePopupLocator(ready=False)
    waits: list[int] = []

    class FakePage:
        def locator(self, selector):
            if 'role="dialog"' in selector and "Close" in selector:
                return close_locator
            return dead

        def get_by_role(self, _role, name=None):
            return dead

        def wait_for_timeout(self, t):
            waits.append(t)

    class FakeKeyboard:
        def press(self, _key):
            raise AssertionError("不应该走到 ESC 兜底")

    page = FakePage()
    page.keyboard = FakeKeyboard()
    logs: list[str] = []
    assert payment_module._close_ctf_popup_if_present(page, log=logs.append) is True
    assert close_locator.clicked is True
    # **关键**：找到关闭按钮后必须等一小段让 modal 消失，否则下一步看到 modal 残影
    assert waits and waits[0] >= 500


def test_close_ctf_popup_if_present_falls_back_to_escape_key():
    """没有任何关闭按钮时兜底 ESC 键。"""

    dead = _FakePopupLocator(ready=False)
    esc_pressed: list[str] = []
    waits: list[int] = []

    class FakeKeyboard:
        def press(self, key):
            esc_pressed.append(key)

    class FakePage:
        def __init__(self):
            self.keyboard = FakeKeyboard()

        def locator(self, _selector):
            return dead

        def get_by_role(self, _role, name=None):
            return dead

        def wait_for_timeout(self, t):
            waits.append(t)

    logs: list[str] = []
    assert payment_module._close_ctf_popup_if_present(FakePage(), log=logs.append) is True
    assert esc_pressed == ["Escape"]
    assert any("ESC" in m for m in logs)


def test_complete_ctf_sandbox_flow_rotates_pool_on_phone_rejection(monkeypatch):
    """sms_pool 第 0 条号被 PayPal 拒后，主循环应换 sms_pool[1] 重新走 fill+submit 拉 code。"""

    state = {
        "fills": [],          # 每次填表用的 phone
        "submits": 0,
        "closed": 0,
        "rejected_polls": 0,
        "fetches": [],
        "codes": [],
    }

    class FakePage:
        url = "https://ctf-sandbox.example/create"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "Test",
            "last_name": "Sandbox",
            "name": "Test Sandbox",
            "phone": "8005550000",
            "phone_e164": "+18005550000",
            "sms_relay_url": "https://relay.default/sms",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)

    def fake_fill_payment(page, identity, **_kwargs):
        state["fills"].append(identity.get("phone"))

    def fake_submit(page, **kwargs):
        state["submits"] += 1

    def fake_detect_rejected(page):
        # 第 0 条号 fill+submit 完后 PayPal 直接拒号；第 1 条不拒
        state["rejected_polls"] += 1
        if state["rejected_polls"] == 1:
            return True, "Phone number not supported"
        return False, ""

    def fake_close(page, **_kw):
        state["closed"] += 1
        return True

    def fake_fetch(*, url, **_kwargs):
        state["fetches"].append(url)
        return "311997"

    def fake_resend(page, **_kw):  # 不应被调到
        raise AssertionError("拒号路径不应该走 Resend")

    def fake_fill_code(page, code, **_kwargs):
        state["codes"].append(code)
        if code:
            page.url = "https://chatgpt.com/"

    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", fake_fill_payment)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", fake_submit)
    monkeypatch.setattr(payment_module, "_detect_ctf_phone_rejected", fake_detect_rejected)
    monkeypatch.setattr(payment_module, "_close_ctf_popup_if_present", fake_close)
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", fake_fetch)
    monkeypatch.setattr(payment_module, "_click_ctf_resend_in_popup", fake_resend)
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", fake_fill_code)
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda page, **kwargs: page.url)

    result = payment_module._complete_ctf_sandbox_flow(
        FakePage(),
        timeout_ms=30000,
        log=lambda _m: None,
        sms_pool=[
            {"phone": "15555550111", "phone_e164": "+15555550111", "relay_url": "https://relay.pool/0"},
            {"phone": "15555550222", "phone_e164": "+15555550222", "relay_url": "https://relay.pool/1"},
        ],
    )

    assert result["status"] == "ctf_completed"
    # **关键**：fill 调了 2 次，第 1 次用 pool[0] 第 2 次换 pool[1]
    assert len(state["fills"]) == 2
    assert state["fills"][1] != state["fills"][0]
    # 拒号后必须 close popup
    assert state["closed"] >= 1
    # 第 2 个号拉 code 时 relay URL 是 pool[1] 的
    assert state["fetches"] == ["https://relay.pool/1"]
    assert state["codes"] == ["311997"]


def test_complete_ctf_sandbox_flow_raises_with_rejected_indexes_when_pool_exhausted(monkeypatch):
    """全部号都被 PayPal 拒后，应 raise 出"耗尽 sms_pool ... 失败 indexes=[0, 1]"。"""

    class FakePage:
        url = "https://ctf-sandbox.example/create"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "ctf.test@example.gmail.com",
            "password": "CtfSecretAa1!",
            "first_name": "T",
            "last_name": "S",
            "name": "T S",
            "phone": "8005550000",
            "phone_e164": "+18005550000",
            "sms_relay_url": "https://relay.default/sms",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: None)
    # 两条号都直接被 PayPal 拒
    monkeypatch.setattr(payment_module, "_detect_ctf_phone_rejected", lambda page: (True, "Phone unsupported"))
    monkeypatch.setattr(payment_module, "_close_ctf_popup_if_present", lambda page, **kwargs: True)
    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", lambda **kwargs: "")
    monkeypatch.setattr(payment_module, "_click_ctf_resend_in_popup", lambda page, **kwargs: True)

    with pytest.raises(RuntimeError) as excinfo:
        payment_module._complete_ctf_sandbox_flow(
            FakePage(),
            timeout_ms=30000,
            log=lambda _m: None,
            sms_pool=[
                {"phone": "15555550111", "phone_e164": "+15555550111", "relay_url": "https://relay.pool/0"},
                {"phone": "15555550222", "phone_e164": "+15555550222", "relay_url": "https://relay.pool/1"},
            ],
        )

    msg = str(excinfo.value)
    # 错误消息必须带 sms_pool 大小 + 拒号 indexes（让上层日志能定位是哪条号挂的）
    assert "耗尽 sms_pool" in msg
    assert "2" in msg  # pool_size
    assert "[0, 1]" in msg  # rejected_pool_indexes


def test_complete_ctf_sandbox_flow_fetch_uses_polling_not_single_attempt(monkeypatch):
    """新版主循环要把 ``_fetch_ctf_relay_code`` 调成**真正轮询** (timeout_seconds=120 / 60)，

    不能再用 ``single_attempt=True``——旧版那样会一次性查不到就 raise，但 SMS 延迟
    5-30s 抖动下第一次大概率拿不到，等于把 80% 的请求白扔掉。
    """
    captured: list[dict] = []

    class FakePage:
        url = "https://ctf-sandbox.example/create"

    monkeypatch.setattr(
        payment_module,
        "_generate_ctf_test_identity",
        lambda: {
            "email": "x@y.com", "password": "Ab1!aaaa", "first_name": "X",
            "last_name": "Y", "name": "X Y", "phone": "8005550000",
            "phone_e164": "+18005550000", "sms_relay_url": "https://relay.default/sms",
        },
    )
    monkeypatch.setattr(payment_module, "_wait_page_loaded", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_open_ctf_create_account_and_continue", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_wait_for_ctf_after_continue_ready", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_fill_ctf_payment_form", lambda page, identity, **kwargs: None)
    monkeypatch.setattr(payment_module, "_click_ctf_submit_until_code_popup", lambda page, **kwargs: None)
    monkeypatch.setattr(payment_module, "_detect_ctf_phone_rejected", lambda page: (False, ""))

    def fake_fetch(**kwargs):
        captured.append(dict(kwargs))
        return "898989"

    monkeypatch.setattr(payment_module, "_fetch_ctf_relay_code", fake_fetch)
    monkeypatch.setattr(payment_module, "_fill_ctf_verification_code", lambda page, code, **kwargs: setattr(page, "url", "https://chatgpt.com/"))
    monkeypatch.setattr(payment_module, "_wait_for_chatgpt_return", lambda page, **kwargs: page.url)

    result = payment_module._complete_ctf_sandbox_flow(FakePage(), timeout_ms=30000, log=lambda _m: None)
    assert result["status"] == "ctf_completed"

    # **关键 assert**：fetch 调用时**不能**带 single_attempt=True，
    # 而要带显式的 timeout_seconds=120（首次给充足时间等 SMS）
    assert captured, "_fetch_ctf_relay_code 应被调用至少一次"
    first_call = captured[0]
    assert first_call.get("single_attempt") is not True, (
        f"主循环不应再用 single_attempt=True，拿到 kwargs: {first_call}"
    )
    assert first_call.get("timeout_seconds") == 120, (
        f"首次拉 code 应给 120s 等 SMS，拿到 kwargs: {first_call}"
    )


# ============================================================================
# Regression: a hidden-input timeout must not be reported as success.
# ============================================================================
#
# 背景：用户在 ChatGPT Plus checkout 页点 PayPal radio 时 Locator.click 3s
# 超时（hidden input + tabindex=-1，force=True 也救不了），但日志显示
# "ChatGPT Plus 测试支付链接已生成 / 完成: 成功 1 个" —— 实际生成的链接还
# 是原 Stripe URL，用户点开还要从头填表。
#
# 根因：
#   1) ``_checkout_flow_progressed`` 把 ``_has_security_challenge`` 也算
#      "已往下进展"。Stripe 结账页加载的 fraud iframe（URL 含 recaptcha /
#      challenge 关键字）让该函数误返 True。
#   2) ``_has_security_challenge_text`` 关键词 ``"captcha"`` 等子串太松，
#      Stripe / ChatGPT 结账页里随便一句 "verify your billing" 都能命中。
#   3) ``_try_click_paypal`` 单个 locator 点击失败就直接抛错，不会试下一
#      个候选；hidden input 卡 3s 超时后没有 fallback。
#
# 下面三个单测分别锁死三个修复点。


def test_checkout_flow_progressed_only_uses_url_progress(monkeypatch):
    """**核心修复**：``_checkout_flow_progressed`` 只能根据 URL 是否离开
    原 Stripe checkout 来判定"进展"。security challenge / CTF form 启发式
    都不能再算"进展"——它们误报会让 ``_run_step_with_retries`` 直接走
    "假成功"分支。
    """
    checkout_url = "https://checkout.stripe.com/c/pay/cs_test_plus"

    fake_page = SimpleNamespace(url=checkout_url)

    # 把所有"非 URL 启发式"都打开，progressed 仍然必须返 False
    monkeypatch.setattr(payment_module, "_has_security_challenge", lambda page: True)
    monkeypatch.setattr(payment_module, "_ctf_after_continue_ready", lambda page: True)

    assert payment_module._checkout_flow_progressed(fake_page, checkout_url) is False

    # URL 真的跳到 PayPal 中间页 → 才算 progressed
    fake_page.url = (
        "https://www.paypal.com/agreements/approve?ba_token=BA-FAKE&ulOnboardRedirect=true"
    )
    assert payment_module._checkout_flow_progressed(fake_page, checkout_url) is True


def test_has_security_challenge_text_does_not_match_stripe_billing_terms(monkeypatch):
    """``_has_security_challenge_text`` 关键词必须收紧到完整短语，**不能**
    被 Stripe / ChatGPT 结账页里的常规支付术语命中。
    """
    # Stripe 结账页常见文案：包含 "verify"、"verification"、"captcha" 子串
    # 但都不是真正的 captcha 挑战页面
    benign_texts = [
        "Verify your billing address before continuing",
        "Card verification value (CVV)",
        "We'll verify your card",
        "Enter the captcha-protected promo code",  # 文案描述，不是挑战
        "请验证您的账单地址",  # "验证" 单字符不应被误中
    ]
    for text in benign_texts:
        monkeypatch.setattr(payment_module, "_page_body_text", lambda page, t=text: t)
        assert payment_module._has_security_challenge_text(SimpleNamespace()) is False, (
            f"误报: {text!r}"
        )

    # 真正的挑战页面文案：必须能匹配
    challenge_texts = [
        "Security Challenge",
        "Please verify you are human to continue.",
        "Human verification required",
        "Are you human?",
        "I am human",
        "请完成安全验证",
        "人机验证未通过",
    ]
    for text in challenge_texts:
        monkeypatch.setattr(payment_module, "_page_body_text", lambda page, t=text: t)
        assert payment_module._has_security_challenge_text(SimpleNamespace()) is True, (
            f"漏报: {text!r}"
        )


def test_try_click_paypal_falls_through_to_next_candidate_when_click_times_out():
    """``_try_click_paypal`` 必须在某个 locator click 超时后**继续尝试下一
    个候选**，而不是直接抛错。模拟 Stripe hidden radio input 超时但
    label 容器可点的情况——必须命中 label 候选。
    """

    class FakeLocator:
        def __init__(self, ready: bool, click_succeeds: bool, label: str = ""):
            self.ready = ready
            self.click_succeeds = click_succeeds
            self.label = label
            self.first = self
            self.click_attempts = 0
            self.tag_name = "input"

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def click(self, **kwargs):
            self.click_attempts += 1
            if not self.click_succeeds:
                raise RuntimeError(
                    f"Locator.click: Timeout 3000ms exceeded (label={self.label})"
                )

        def check(self, **kwargs):
            self.click_attempts += 1
            if not self.click_succeeds:
                raise RuntimeError("check timeout")

        def evaluate(self, _script):
            return self.tag_name.upper()

    # 第一个候选：label 命中但 click 超时（模拟 hidden input）
    hidden_input = FakeLocator(ready=True, click_succeeds=False, label="hidden-input")
    hidden_input.tag_name = "input"
    # 第二个候选：role=radio，click 也超时
    radio = FakeLocator(ready=True, click_succeeds=False, label="radio")
    # 第三个候选：role=button container，click 成功
    button = FakeLocator(ready=True, click_succeeds=True, label="button-container")
    button.tag_name = "div"

    candidates = iter([hidden_input, radio, button])

    class FakePage:
        def get_by_label(self, _pattern):
            return next(candidates)

        def get_by_role(self, _role, name=None):
            return next(candidates)

        def get_by_text(self, _pattern):
            # 不应走到这里
            raise AssertionError("不应走到 get_by_text—— button 候选已经成功")

        def locator(self, _selector):
            raise AssertionError("不应走到 locator—— button 候选已经成功")

        def wait_for_timeout(self, _ms):
            pass

    page = FakePage()
    assert payment_module._try_click_paypal(page) is True
    # 三个候选都尝试过 click（前两个失败，第三个成功）
    assert hidden_input.click_attempts >= 1
    assert radio.click_attempts >= 1
    assert button.click_attempts == 1


def test_try_click_paypal_raises_when_all_candidates_fail():
    """所有候选都不可点击时仍要抛 RuntimeError，不能静默返回 True。"""

    class DeadLocator:
        first = None

        def __init__(self):
            self.first = self

        def count(self):
            return 0

        def is_visible(self):
            return False

        def is_enabled(self):
            return False

    class FakePage:
        def get_by_label(self, _pattern):
            return DeadLocator()

        def get_by_role(self, _role, name=None):
            return DeadLocator()

        def get_by_text(self, _pattern):
            return DeadLocator()

        def locator(self, _selector):
            return DeadLocator()

        def wait_for_timeout(self, _ms):
            pass

    with pytest.raises(RuntimeError, match=r"PayPal 支付方式"):
        payment_module._try_click_paypal(FakePage())


def test_paypal_signin_offers_signup_detects_create_account():
    """signin 页存在 "新規登録 / Create Account" 入口时应返回 True。"""

    class FakeLocator:
        def __init__(self, ready):
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

    class FakePage:
        def locator(self, selector):
            # 仅"新規登録"链接 ready，模拟日区 signin 页的注册入口
            ready = "create" in selector.lower() or "新規登録" in selector or "signup" in selector.lower()
            return FakeLocator(ready)

        def get_by_role(self, role, name=None):
            return FakeLocator(False)

    assert payment_module._paypal_signin_offers_signup(FakePage()) is True


def test_paypal_signin_offers_signup_false_when_password_only():
    """纯密码登录页（无任何注册入口）应返回 False → 上层硬失败弃号。"""

    class FakeLocator:
        def __init__(self):
            self.first = self

        def count(self):
            return 0

        def is_visible(self):
            return False

        def is_enabled(self):
            return False

    class FakePage:
        def locator(self, selector):
            return FakeLocator()

        def get_by_role(self, role, name=None):
            return FakeLocator()

    assert payment_module._paypal_signin_offers_signup(FakePage()) is False


def test_extract_paypal_tokens_from_url_parses_nested_state():
    """从 signin URL 的二次编码 state 里抽 ba_token / ec_token。"""
    url = (
        "https://www.paypal.com/signin?intent=checkout&ctxId=xo_ctx_EC-ENCODEDTEST"
        "&returnUri=%2Fwebapps%2Fhermes&state=%3Fflow%3D1-P%26ulReturn%3Dtrue"
        "%26ba_token%3DBA-ENCODEDTEST%26token%3DEC-ENCODEDTEST"
        "&locale.x=ja_JP&country.x=JP"
    )
    ba, ec = payment_module._extract_paypal_tokens_from_url(url)
    assert ba == "BA-ENCODEDTEST"
    assert ec == "EC-ENCODEDTEST"


def test_enter_signup_from_paypal_signin_navigates_to_signup_url(monkeypatch):
    """首选从 signin URL 直达 /checkoutweb/signup，goto 后页面就绪 → True。"""
    state = {
        "url": (
            "https://www.paypal.com/signin?intent=checkout"
            "&state=%26ba_token%3DBA-9%26token%3DEC-9"
        ),
        "goto_called": "",
    }

    class FakePage:
        def goto(self, url, **kwargs):
            state["goto_called"] = url
            state["url"] = "https://www.paypal.com/checkoutweb/signup?token=EC-9&ba_token=BA-9"

        def wait_for_timeout(self, timeout):
            pass

    monkeypatch.setattr(payment_module, "_current_page_url", lambda page, *a, **k: state["url"])
    monkeypatch.setattr(payment_module, "_ctf_signup_form_ready", lambda page: False)
    monkeypatch.setattr(payment_module, "_ctf_create_account_ready", lambda page: False)
    monkeypatch.setattr(payment_module, "_ctf_payment_form_ready", lambda page: False)

    ok = payment_module._enter_signup_from_paypal_signin(
        FakePage(), timeout_ms=30000, log=lambda _m: None
    )
    assert ok is True
    assert "checkoutweb/signup" in state["goto_called"]
    assert "token=EC-9" in state["goto_called"]
    assert "ba_token=BA-9" in state["goto_called"]


def test_enter_signup_from_paypal_signin_falls_back_to_button(monkeypatch):
    """无 ec_token 时跳过 URL 直达，点创建按钮后离开 signin → True。"""
    state = {"url": "https://www.paypal.com/signin?intent=checkout"}

    class FakePage:
        def wait_for_timeout(self, timeout):
            state["url"] = "https://www.paypal.com/checkoutweb/signup?token=EC-2"

    monkeypatch.setattr(payment_module, "_current_page_url", lambda page, *a, **k: state["url"])
    monkeypatch.setattr(payment_module, "_click_ctf_create_account", lambda page: None)
    monkeypatch.setattr(payment_module, "_ctf_signup_form_ready", lambda page: False)
    monkeypatch.setattr(payment_module, "_ctf_create_account_ready", lambda page: False)
    monkeypatch.setattr(payment_module, "_ctf_payment_form_ready", lambda page: False)

    ok = payment_module._enter_signup_from_paypal_signin(
        FakePage(), timeout_ms=30000, log=lambda _m: None
    )
    assert ok is True


def test_enter_signup_from_paypal_signin_gives_up_when_stuck(monkeypatch):
    """URL 直达 + 点按钮都没离开 signin 页 → 返回 False（上层硬失败弃号）。"""
    signin_url = "https://www.paypal.com/signin?intent=checkout&state=%26token%3DEC-1"

    class FakePage:
        def goto(self, url, **kwargs):
            pass

        def wait_for_timeout(self, timeout):
            pass

    monkeypatch.setattr(payment_module, "_current_page_url", lambda page, *a, **k: signin_url)
    monkeypatch.setattr(payment_module, "_click_ctf_create_account", lambda page: None)
    monkeypatch.setattr(payment_module, "_ctf_signup_form_ready", lambda page: False)
    monkeypatch.setattr(payment_module, "_ctf_create_account_ready", lambda page: False)
    monkeypatch.setattr(payment_module, "_ctf_payment_form_ready", lambda page: False)

    ok = payment_module._enter_signup_from_paypal_signin(
        FakePage(), timeout_ms=2400, log=lambda _m: None
    )
    assert ok is False


def test_open_ctf_create_account_short_circuits_on_unified_guest_form(monkeypatch):
    """直达 /checkoutweb/signup 出现统一 guest 表单（卡号框已在）时，
    应跳过 Create-account / Continue-to-Payment，直接返回让上层填表。"""
    calls = {"create_clicks": 0, "continue_clicks": 0, "signup_email": 0}

    monkeypatch.setattr(payment_module.time, "sleep", lambda *_a, **_k: None)
    monkeypatch.setattr(payment_module, "_install_paypal_captcha_dom_stripper", lambda page, **kwargs: 0)
    # 卡号框直接就绪 → 统一 guest 表单
    monkeypatch.setattr(payment_module, "_ctf_card_field_ready", lambda page: True)
    # 这些不该被调用
    monkeypatch.setattr(payment_module, "_click_ctf_create_account", lambda page: calls.__setitem__("create_clicks", calls["create_clicks"] + 1))
    monkeypatch.setattr(payment_module, "_click_ctf_continue_to_payment", lambda page: calls.__setitem__("continue_clicks", calls["continue_clicks"] + 1))
    monkeypatch.setattr(payment_module, "_fill_ctf_signup_email", lambda page, identity: calls.__setitem__("signup_email", calls["signup_email"] + 1))

    payment_module._open_ctf_create_account_and_continue(
        object(),
        {"email": "user@example.com", "password": "Aa1!aaaa"},
        log=lambda _m: None,
    )

    assert calls["create_clicks"] == 0
    assert calls["continue_clicks"] == 0
    assert calls["signup_email"] == 0


def test_ctf_card_field_ready_detects_card_number_input():
    """卡号 input 可见时 _ctf_card_field_ready 返回 True。"""

    class FakeLocator:
        def __init__(self, ready):
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

    class FakePage:
        def locator(self, selector):
            ready = "cc-number" in selector.lower() or "cardnumber" in selector.lower() or "カード番号" in selector
            return FakeLocator(ready)

    assert payment_module._ctf_card_field_ready(FakePage()) is True


def test_wait_and_type_dob_uses_formatted_text_when_digit_mask_misgroups():
    state = {"value": "", "typed": []}

    class FakeKeyboard:
        def press(self, key):
            if key == "Delete":
                state["value"] = ""

        def type(self, text, delay=0):
            state["typed"].append(text)
            if text == "06151990":
                state["value"] = "0615/1/9"
            elif text == "06/15/1990":
                state["value"] = "06/15/1990"

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def click(self):
            pass

    class FakePage:
        keyboard = FakeKeyboard()

        def evaluate(self, script, arg=None):
            if "document.getElementById" in script:
                return state["value"]
            return None

        def locator(self, selector):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            pass

    assert payment_module._wait_and_type_dob_by_id(
        FakePage(),
        "dateOfBirth",
        "06/15/1990",
        attempts=1,
        interval_ms=0,
        log=lambda _m: None,
    ) is True
    assert state["typed"] == ["06/15/1990"]
    assert state["value"] == "06/15/1990"


def test_wait_and_type_dob_uses_insert_text_when_slashes_confuse_mask():
    state = {"value": "", "typed": [], "inserted": []}

    class FakeKeyboard:
        def press(self, key):
            if key == "Delete":
                state["value"] = ""

        def type(self, text, delay=0):
            state["typed"].append(text)
            if text == "11/24/1990":
                state["value"] = "11/2/4"

        def insert_text(self, text):
            state["inserted"].append(text)
            if text == "11/24/1990":
                state["value"] = "11/24/1990"

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def click(self):
            pass

    class FakePage:
        keyboard = FakeKeyboard()

        def evaluate(self, script, arg=None):
            if "document.getElementById" in script:
                return state["value"]
            return None

        def locator(self, selector):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            pass

    assert payment_module._wait_and_type_dob_by_id(
        FakePage(),
        "dateOfBirth",
        "11/24/1990",
        attempts=1,
        interval_ms=0,
        log=lambda _m: None,
    ) is True
    assert state["inserted"] == ["11/24/1990"]
    assert state["typed"] == []
    assert state["value"] == "11/24/1990"


def test_wait_and_type_dob_prefers_gujumpgate_style_js_setter():
    state = {"value": "", "typed": [], "inserted": [], "js_sets": []}

    class FakeKeyboard:
        def press(self, key):
            pass

        def type(self, text, delay=0):
            state["typed"].append(text)

        def insert_text(self, text):
            state["inserted"].append(text)

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def click(self):
            pass

    class FakePage:
        keyboard = FakeKeyboard()

        def evaluate(self, script, arg=None):
            if isinstance(arg, dict) and arg.get("id") == "dateOfBirth":
                value = str(arg.get("value") or "")
                state["js_sets"].append(value)
                state["value"] = value
                return f"ok:{value}"
            if "document.getElementById" in script:
                return state["value"]
            return None

        def locator(self, selector):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            pass

    assert payment_module._wait_and_type_dob_by_id(
        FakePage(),
        "dateOfBirth",
        "1990/11/24",
        attempts=1,
        interval_ms=0,
        log=lambda _m: None,
    ) is True
    assert state["js_sets"] == ["1990/11/24"]
    assert state["inserted"] == []
    assert state["typed"] == []
    assert state["value"] == "1990/11/24"


def test_wait_and_type_dob_tries_compact_digits_when_mask_truncates_slashes():
    state = {"value": "", "inserted": [], "js_sets": [], "typed": []}

    class FakeKeyboard:
        def press(self, key):
            if key == "Delete":
                state["value"] = ""

        def insert_text(self, text):
            state["inserted"].append(text)
            if text == "07/27/1990":
                state["value"] = "07/2/7"
            elif text == "07271990":
                state["value"] = "07/27/1990"

        def type(self, text, delay=0):
            state["typed"].append(text)

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def click(self):
            pass

    class FakePage:
        keyboard = FakeKeyboard()

        def evaluate(self, script, arg=None):
            if isinstance(arg, dict) and arg.get("id") == "dateOfBirth":
                value = str(arg.get("value") or "")
                state["js_sets"].append(value)
                if value == "07/27/1990":
                    state["value"] = "07/2/7"
                elif value == "07271990":
                    state["value"] = "07/27/1990"
                else:
                    state["value"] = value
                return f"ok:{state['value']}"
            if "document.getElementById" in script:
                return state["value"]
            return None

        def locator(self, selector):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            pass

    assert payment_module._wait_and_type_dob_by_id(
        FakePage(),
        "dateOfBirth",
        "07/27/1990",
        attempts=1,
        interval_ms=0,
        log=lambda _m: None,
    ) is True
    assert state["js_sets"] == ["07/27/1990", "07271990"]
    assert state["inserted"] == []
    assert state["typed"] == []
    assert state["value"] == "07/27/1990"


def test_wait_and_type_dob_refocuses_before_each_keyboard_candidate():
    state = {
        "active": "dateOfBirth",
        "values": {"dateOfBirth": "", "firstName": "", "lastName": ""},
        "inserted": [],
    }

    class FakeKeyboard:
        def press(self, key):
            if key == "Delete":
                state["values"][state["active"]] = ""
            elif key == "Tab":
                if state["active"] == "dateOfBirth":
                    state["active"] = "firstName"
                elif state["active"] == "firstName":
                    state["active"] = "lastName"

        def insert_text(self, text):
            state["inserted"].append((state["active"], text))
            configured = payment_module.CTF_DATE_OF_BIRTH
            compact = re.sub(r"\D", "", configured)
            if state["active"] == "dateOfBirth" and text == configured:
                state["values"]["dateOfBirth"] = configured[:-1]
            elif state["active"] == "dateOfBirth" and text == compact:
                state["values"]["dateOfBirth"] = configured
            else:
                state["values"][state["active"]] = text

        def type(self, text, delay=0):
            state["values"][state["active"]] = text

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def click(self):
            state["active"] = "dateOfBirth"

    class FakePage:
        keyboard = FakeKeyboard()

        def evaluate(self, script, arg=None):
            if isinstance(arg, dict) and arg.get("id") == "dateOfBirth":
                state["values"]["dateOfBirth"] = "09/05/19"
                return f"ok:{state['values']['dateOfBirth']}"
            if "document.getElementById" in script:
                key = str(arg or "")
                return state["values"].get(key, "__noel__")
            return None

        def locator(self, selector):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            pass

    assert payment_module._wait_and_type_dob_by_id(
        FakePage(),
        "dateOfBirth",
        payment_module.CTF_DATE_OF_BIRTH,
        attempts=1,
        interval_ms=0,
        log=lambda _m: None,
    ) is True
    assert state["values"]["dateOfBirth"] == payment_module.CTF_DATE_OF_BIRTH
    assert state["values"]["firstName"] == ""
    assert state["values"]["lastName"] == ""
    assert all(target == "dateOfBirth" for target, _value in state["inserted"])


def test_wait_and_type_dob_locks_value_when_mask_keeps_two_digit_year():
    state = {"value": "", "locked": [], "inserted": [], "typed": []}

    class FakeKeyboard:
        def press(self, key):
            if key == "Delete":
                state["value"] = ""

        def insert_text(self, text):
            state["inserted"].append(text)
            state["value"] = "9/5/19"

        def type(self, text, delay=0):
            state["typed"].append(text)
            state["value"] = "9/5/19"

    class FakeLocator:
        first = None

        def __init__(self):
            self.first = self

        def click(self):
            pass

    class FakePage:
        keyboard = FakeKeyboard()

        def evaluate(self, script, arg=None):
            if isinstance(arg, dict) and arg.get("id") == "dateOfBirth":
                if "__ctfDobValueLock" in script:
                    value = str(arg.get("value") or "")
                    state["locked"].append(value)
                    state["value"] = value
                    return f"ok:{value}"
                state["value"] = "09/05/19"
                return f"ok:{state['value']}"
            if "document.getElementById" in script:
                return state["value"]
            return None

        def locator(self, selector):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            pass

    assert payment_module._wait_and_type_dob_by_id(
        FakePage(),
        "dateOfBirth",
        payment_module.CTF_DATE_OF_BIRTH,
        attempts=1,
        interval_ms=0,
        log=lambda _m: None,
    ) is True
    assert state["locked"] == [payment_module.CTF_DATE_OF_BIRTH]
    assert state["value"] == payment_module.CTF_DATE_OF_BIRTH


def test_fill_ctf_payment_form_fills_both_kanji_and_kana_names_for_jp():
    """JP 区统一 guest 表单：漢字组(#firstName/#lastName) 和片假名组
    (#countrySpecificFirstName/#countrySpecificLastName) 都要分别填对。"""
    fills = {}
    values = {}
    id_to_key = {
        "firstName": "kanji_first",
        "lastName": "kanji_last",
        "countrySpecificFirstName": "kana_first",
        "countrySpecificLastName": "kana_last",
        "dateOfBirth": "dob",
        "cardNumber": "card",
        "email": "email",
        "password": "password",
        "phone": "phone",
        "cardCvv": "cvv",
        "cardExpiry": "exp",
        "billingPostalCode": "zip",
        "billingState": "state",
        "billingCity": "city",
        "billingLine1": "line1",
        "billingLine2": "line2",
    }

    def key_for_id(element_id):
        return id_to_key.get(str(element_id or ""), str(element_id or ""))

    class FakeLocator:
        def __init__(self, key, ready=True):
            self.key = key
            self.ready = ready
            self.first = self

        def count(self):
            return 1 if self.ready else 0

        def is_visible(self):
            return self.ready

        def is_enabled(self):
            return self.ready

        def input_value(self, timeout=0):
            return values.get(self.key, "")

        def fill(self, value, **kwargs):
            fills[self.key] = value
            values[self.key] = value

        def select_option(self, **kwargs):
            value = kwargs.get("value") or kwargs.get("label")
            fills[self.key] = value
            values[self.key] = value

        def evaluate(self, *a, **k):
            return values.get(self.key, "")

        def click(self):
            pass

        def type(self, value, **kwargs):
            fills[self.key] = value
            values[self.key] = value

    class FakeKeyboard:
        def __init__(self):
            self.active_key = None

        def press(self, key):
            if key == "Delete" and self.active_key:
                fills[self.active_key] = ""
                values[self.active_key] = ""

        def type(self, value, **kwargs):
            if self.active_key:
                fills[self.active_key] = value
                values[self.active_key] = value

    class FakePage:
        def __init__(self):
            self.keyboard = FakeKeyboard()

        def wait_for_timeout(self, timeout):
            pass

        def keyboard_press(self, *a, **k):
            pass

        def evaluate(self, script, arg=None):
            if isinstance(arg, dict) and "id" in arg and "value" in arg:
                key = key_for_id(arg["id"])
                value = str(arg.get("value") or "")
                fills[key] = value
                values[key] = value
                return f"ok:{value}"
            if isinstance(arg, str):
                key = key_for_id(arg)
                if key in values:
                    return values.get(key, "")
                return "" if key in id_to_key.values() else "__noel__"
            return None

        def locator(self, selector):
            s = selector
            sl = selector.lower()
            # 精确 id 优先（漢字组）
            if s in ("#firstName", "input#firstName"):
                return FakeLocator("kanji_first")
            if s in ("#lastName", "input#lastName"):
                return FakeLocator("kanji_last")
            if "countryspecificfirst" in sl:
                return FakeLocator("kana_first")
            if "countryspecificlast" in sl:
                return FakeLocator("kana_last")
            if "dateofbirth" in sl:
                self.keyboard.active_key = "dob"
                return FakeLocator("dob")
            if "cardnumber" in sl or "cc-number" in sl:
                return FakeLocator("card")
            if "email" in sl:
                return FakeLocator("email")
            if "password" in sl:
                return FakeLocator("password")
            if "phone" in sl or "tel" in sl:
                return FakeLocator("phone")
            if "cvv" in sl or "cvc" in sl or "csc" in sl:
                return FakeLocator("cvv")
            if "exp" in sl:
                return FakeLocator("exp")
            if "billingpostalcode" in sl or "postal" in sl or "zip" in sl:
                return FakeLocator("zip")
            if "billingstate" in sl or "administrativearea" in sl or "state" in sl or "billingState".lower() in sl:
                return FakeLocator("state")
            if "billingcity" in sl or "city" in sl or "address-level2" in sl:
                return FakeLocator("city")
            if "billingline1" in sl or "addressline1" in sl or "streetaddress" in sl or "address-line1" in sl:
                return FakeLocator("line1")
            if "billingline2" in sl or "addressline2" in sl or "address-line2" in sl:
                return FakeLocator("line2")
            # first/last 泛匹配（id*=first / name*=first）→ DOM 靠前的片假名框
            if "first" in sl:
                return FakeLocator("kana_first")
            if "last" in sl:
                return FakeLocator("kana_last")
            if "name" in sl:
                return FakeLocator("fullname")
            return FakeLocator(selector, ready=False)

        def get_by_label(self, name):
            return FakeLocator(str(name), ready=False)

        def get_by_role(self, role, name=None):
            return FakeLocator(f"{role}", ready=False)

        def get_by_text(self, text):
            return FakeLocator(f"text", ready=False)

    identity = {
        "region": "JP",
        "email": "test.jp@example.com",
        "password": "TEST_Password_123!",
        "first_name": "試験",
        "last_name": "利用者",
        "first_name_kanji": "試験",
        "last_name_kanji": "利用者",
        "first_name_kana": "テスト",
        "last_name_kana": "ユーザー",
        "name": "利用者 試験",
        "date_of_birth": "2000/01/01",
        "address_line1": "テスト住所 1-2-3",
        "city": "Test City",
        "state": "Tokyo",
        "postal_code": "100-0001",
        "card_number": "4242424242424242",
        "card_exp_month": "12",
        "card_exp_year": "2030",
        "card_cvv": "123",
    }

    payment_module._fill_ctf_payment_form(FakePage(), identity, log=lambda _m: None)

    # 漢字组与片假名组分别命中、值不串
    assert fills.get("kanji_first") == "試験"
    assert fills.get("kanji_last") == "利用者"
    assert fills.get("kana_first") == "テスト"
    assert fills.get("kana_last") == "ユーザー"
    assert fills.get("dob") == identity["date_of_birth"]


def test_fill_checkout_field_selects_hidden_native_select_via_js():
    """Stripe 风格隐藏 select（is_visible=False）：旧逻辑会跳过，
    新逻辑应走 JS 强制设值并命中 option。"""
    state = {"evaluated": 0, "value": None}

    # 模拟页面里 #billingState 这种隐藏 select 的 option 列表
    options = [
        {"value": "東京都", "text": "東京都", "label": "東京都"},
        {"value": "三重県", "text": "三重県", "label": "三重県"},
    ]

    class HiddenSelectLocator:
        def __init__(self):
            self.first = self

        def count(self):
            return 1

        def is_visible(self):
            return False  # 关键：隐藏

        def is_enabled(self):
            return True

        def evaluate(self, script, candidates):
            # 复刻 _force_select_native_option 的 JS 匹配语义（压缩匹配）
            def compact(s):
                import re as _re
                return _re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", str(s or "").lower())
            state["evaluated"] += 1
            cset = [compact(c) for c in candidates if c]
            for o in options:
                if compact(o["value"]) in cset or compact(o["text"]) in cset:
                    state["value"] = o["value"]
                    return o["value"]
            for c in cset:
                for o in options:
                    cv = compact(o["value"])
                    if cv and (cv in c or c in cv):
                        state["value"] = o["value"]
                        return o["value"]
            return ""

    class FakePage:
        def locator(self, selector):
            if "billingstate" in selector.lower() or "administrativearea" in selector.lower() or "state" in selector.lower():
                return HiddenSelectLocator()

            class Empty:
                first = None

                def __init__(self):
                    self.first = self

                def count(self):
                    return 0

                def is_visible(self):
                    return False

                def is_enabled(self):
                    return False

            return Empty()

        def get_by_label(self, name):
            class Empty:
                first = None

                def __init__(self):
                    self.first = self

                def count(self):
                    return 0

                def is_visible(self):
                    return False

            return Empty()

    ok = payment_module._fill_checkout_field(
        FakePage(),
        "三重県",
        selectors=('#billingState', 'select[name="billingState"]'),
        select=True,
    )
    assert ok is True
    assert state["evaluated"] >= 1
    assert state["value"] == "三重県"


def test_force_select_native_option_compact_matches_romaji_to_kanji():
    """压缩匹配：候选 'Tokyo' 命中 option '東京都 — Tokyo'。"""
    picked = {"value": None}

    class Loc:
        def evaluate(self, script, candidates):
            # '東京都 — Tokyo' 含 'tokyo' 压缩后包含候选 'tokyo'
            options = [("東京都", "東京都 — Tokyo"), ("三重県", "三重県 — Mie")]
            import re as _re
            comp = lambda s: _re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", str(s or "").lower())
            for c in candidates:
                cc = comp(c)
                if not cc:
                    continue
                for v, t in options:
                    if comp(t).find(cc) >= 0 or comp(v) == cc:
                        picked["value"] = v
                        return v
            return ""

    ok = payment_module._force_select_native_option(Loc(), ["Tokyo", "東京都"], field_label="state")
    assert ok is True
    assert picked["value"] == "東京都"
