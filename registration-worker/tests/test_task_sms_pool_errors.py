from application import tasks as tasks_module


def test_current_phone_exhausted_does_not_mean_global_sms_pool_exhausted():
    assert tasks_module._is_current_sms_phone_exhausted_error(
        "ChatGPT Plus 支付链接生成失败: SMS_PHONE_EXHAUSTED: 当前号码 30s 未收到新验证码"
    )
    assert not tasks_module._is_global_sms_pool_exhausted_error(
        "ChatGPT Plus 支付链接生成失败: SMS_PHONE_EXHAUSTED: 当前号码 30s 未收到新验证码"
    )


def test_global_sms_pool_exhausted_error_still_stops_launching():
    assert tasks_module._is_global_sms_pool_exhausted_error(
        "ChatGPT Plus 支付链接生成失败: SMS_POOL_EXHAUSTED: 全局号码池已耗尽"
    )
