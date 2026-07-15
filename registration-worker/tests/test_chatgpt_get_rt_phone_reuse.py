import pytest

from platforms.chatgpt import browser_get_rt
from platforms.gopay import sms_channel


def test_get_rt_phone_reuse_pool_reuses_smspool_number_three_times(monkeypatch):
    instances = []

    class FakeSmsPoolChannel:
        def __init__(self, **kwargs):
            self.kwargs = dict(kwargs)
            self.index = len(instances) + 1
            self.phone = f"+1555000000{self.index}"
            self.order_id = f"order-{self.index}"
            self.wait_count = 0
            self.ignore_codes = []
            self.resends = []
            self.done_ids = []
            self.cancel_ids = []
            instances.append(self)

        def get_number(self):
            return self.phone, self.order_id

        def wait_code(self, order_id, timeout=30, *, ignore_code=None):
            assert order_id == self.order_id
            self.ignore_codes.append(ignore_code)
            self.wait_count += 1
            return ["111111", "222222", "333333", "444444"][self.wait_count - 1]

        def request_another(self, order_id):
            self.resends.append(order_id)
            return True

        def done(self, order_id):
            self.done_ids.append(order_id)

        def cancel(self, order_id):
            self.cancel_ids.append(order_id)

    monkeypatch.setattr(sms_channel, "SmsPoolChannel", FakeSmsPoolChannel)

    pool, error = browser_get_rt.build_get_rt_phone_reuse_pool(
        sms_provider="smspool",
        smspool_api_key="KEY",
        reuse_count=3,
        log_fn=lambda _message: None,
    )

    assert error == ""
    assert pool is not None

    phones = []
    codes = []
    for index in range(3):
        callback = pool.make_callback(label=str(index + 1))
        phones.append(callback())
        codes.append(callback())
        callback.report_success()

    assert phones == ["+15550000001", "+15550000001", "+15550000001"]
    assert codes == ["111111", "222222", "333333"]
    assert len(instances) == 1
    assert instances[0].resends == ["order-1", "order-1"]
    assert instances[0].ignore_codes == [None, "111111", "222222"]
    assert instances[0].done_ids == ["order-1"]
    assert instances[0].cancel_ids == []

    callback = pool.make_callback(label="4")
    assert callback() == "+15550000002"
    assert callback() == "111111"
    callback.report_success()
    pool.cleanup()

    assert len(instances) == 2
    assert instances[1].done_ids == ["order-2"]
    assert instances[1].cancel_ids == []


def test_get_rt_phone_reuse_pool_uses_smsapi_lines_once(monkeypatch):
    instances = []

    class FakeSmsApiChannel:
        def __init__(self, *, url, phone):
            self.url = url
            self.phone = phone
            self.wait_count = 0
            self.done_ids = []
            instances.append(self)

        def prime(self):
            return None

        def wait_code(self, _id, timeout=30):
            self.wait_count += 1
            return f"{self.wait_count:06d}"

        def request_another(self, _id):
            return True

        def done(self, _id):
            self.done_ids.append(_id)

    monkeypatch.setattr(sms_channel, "SmsApiChannel", FakeSmsApiChannel)

    pool, error = browser_get_rt.build_get_rt_phone_reuse_pool(
        sms_provider="smsapi",
        smsapi_phone="+15550000001----https://sms.example/1\n+15550000002----https://sms.example/2",
        reuse_count=3,
        log_fn=lambda _message: None,
    )

    assert error == ""
    assert pool is not None

    phones = []
    for index in range(6):
        callback = pool.make_callback(label=str(index + 1))
        phones.append(callback())
        callback()
        callback.report_success()

    assert phones == [
        "+15550000001",
        "+15550000001",
        "+15550000001",
        "+15550000002",
        "+15550000002",
        "+15550000002",
    ]
    assert len(instances) == 2

    with pytest.raises(RuntimeError, match="smsapi phone list exhausted"):
        pool.make_callback(label="7")()
