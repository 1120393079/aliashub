from __future__ import annotations

import pytest

from application import tasks as tasks_module
from core.base_platform import Account
from domain.actions import ActionExecutionResult
from domain.actions import ActionExecutionCommand
from infrastructure import platform_runtime as runtime_module


class _FakeLogger:
    def __init__(self):
        self.events = []
        self.result_data = None
        self.finished = None
        self.cancel_requested = False

    def log(self, message, **kwargs):
        self.events.append(("log", message, kwargs))

    def record_error(self, error):
        self.events.append(("error", error, {}))

    def record_success(self):
        self.events.append(("success", "", {}))

    def set_result_data(self, data):
        self.result_data = data

    def set_progress(self, current, total):
        self.events.append(("progress", current, {"total": total}))

    def is_cancel_requested(self):
        return self.cancel_requested

    def set_subtask(self, subtask_id, label=""):
        self.events.append(("subtask", subtask_id, {"label": label}))

    def clear_subtask(self):
        self.events.append(("clear_subtask", "", {}))

    def finish(self, status, *, error=""):
        self.finished = (status, error)

    def finish_irreversible_success(self, data, *, warning):
        self.result_data = data
        self.events.append(("warning", warning, {}))
        self.finished = (tasks_module.TASK_STATUS_SUCCEEDED, "")
        return True


def test_platform_action_task_passes_task_logger_to_runtime(monkeypatch):
    seen = {}

    class FakeRuntime:
        def execute_action(self, command, *, log_fn=None, cancel_check):
            seen["log_fn"] = log_fn
            seen["cancel_check"] = cancel_check
            if log_fn:
                log_fn("checkout step log")
            return ActionExecutionResult(ok=True, data={"message": "summary"})

    monkeypatch.setattr(tasks_module, "PlatformRuntime", FakeRuntime)
    logger = _FakeLogger()

    tasks_module._execute_platform_action_task(
        {
            "platform": "chatgpt",
            "account_id": 123,
            "action_id": "payment_link",
            "params": {"auto_checkout": "true"},
        },
        logger,
    )

    assert getattr(seen["log_fn"], "__self__", None) is logger
    assert getattr(seen["log_fn"], "__name__", "") == "log"
    assert getattr(seen["cancel_check"], "__self__", None) is logger
    assert getattr(seen["cancel_check"], "__name__", "") == "is_cancel_requested"
    assert seen["cancel_check"]() is False
    assert ("log", "checkout step log", {}) in logger.events
    assert logger.result_data == {"message": "summary"}
    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")


def test_platform_action_task_ignores_cancel_after_confirmed_password_commit(monkeypatch):
    logger = _FakeLogger()

    class FakeRuntime:
        def execute_action(self, command, *, log_fn=None, cancel_check=None):
            logger.cancel_requested = True
            return ActionExecutionResult(
                ok=True,
                data={
                    "password_status": "configured",
                    "password_source": "settings",
                    "password_verification": "success_url",
                    "message": "密码已设置，迟到取消请求未回滚已生效密码",
                },
            )

    monkeypatch.setattr(tasks_module, "PlatformRuntime", FakeRuntime)

    tasks_module._execute_platform_action_task(
        {
            "platform": "chatgpt",
            "account_id": 123,
            "action_id": "set_password",
            "params": {},
        },
        logger,
    )

    assert logger.result_data["password_status"] == "configured"
    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")
    assert any(event[0] == "warning" for event in logger.events)


def test_task_logger_finishes_irreversible_success_after_cancel_request():
    task = tasks_module.create_platform_action_task(
        {
            "platform": "chatgpt",
            "account_id": 123,
            "action_id": "set_password",
            "params": {},
        }
    )
    logger = tasks_module.TaskLogger(task["id"])
    logger.mark_running()
    tasks_module.request_cancel(task["id"])

    changed = logger.finish_irreversible_success(
        {
            "password_status": "configured",
            "password_source": "settings",
            "password_verification": "success_url",
        },
        warning="密码已设置，迟到取消请求未回滚已生效密码",
    )

    saved = tasks_module.get_task(task["id"])
    assert changed is True
    assert saved["status"] == tasks_module.TASK_STATUS_SUCCEEDED
    assert saved["data"]["password_status"] == "configured"
    assert saved["progress"] == "1/1"
    assert saved["error"] == ""


def test_chatgpt_register_task_succeeds_after_successful_registration(monkeypatch):
    class FakePlatform:
        def register(self, email=None, password=None):
            return Account(
                platform="chatgpt",
                email=email or "registered@example.com",
                password=password or "Secret123!",
                user_id="acct_123",
                extra={"access_token": "access-token"},
            )

    monkeypatch.setattr(tasks_module, "get", lambda platform_name: object)
    monkeypatch.setattr(
        tasks_module,
        "_resolve_registration_proxy_for_platform",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        tasks_module,
        "_build_platform_instance",
        lambda *args, **kwargs: FakePlatform(),
    )
    monkeypatch.setattr(tasks_module, "_auto_upload_cpa", lambda *args, **kwargs: None)
    monkeypatch.setattr(tasks_module, "_auto_push_any2api", lambda *args, **kwargs: None)

    logger = _FakeLogger()

    tasks_module._execute_register_task(
        {
            "platform": "chatgpt",
            "count": 1,
            "concurrency": 1,
            "email": "registered@example.com",
            "password": "Secret123!",
            "extra": {
                "identity_provider": "oauth_browser",
                "auto_chatgpt_plus_payment": False,
            },
        },
        logger,
    )

    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")
    assert any(event[0] == "success" for event in logger.events)
    assert not any(
        "cannot access local variable 'extra'" in str(event)
        for event in logger.events
    )


def test_chatgpt_register_task_fails_when_workspace_join_fails(monkeypatch):
    class FakePlatform:
        def register(self, email=None, password=None):
            return Account(
                platform="chatgpt",
                email=email or "registered@example.com",
                password=password or "Secret123!",
                user_id="acct_123",
                extra={
                    "access_token": "access-token",
                    "workspace_join": {
                        "ok": False,
                        "error": "invite button not clicked",
                        "accept_result": {"error": "invite button not clicked"},
                    },
                },
            )

    monkeypatch.setattr(tasks_module, "get", lambda platform_name: object)
    monkeypatch.setattr(
        tasks_module,
        "_resolve_registration_proxy_for_platform",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        tasks_module,
        "_build_platform_instance",
        lambda *args, **kwargs: FakePlatform(),
    )
    monkeypatch.setattr(tasks_module, "_auto_upload_cpa", lambda *args, **kwargs: None)
    monkeypatch.setattr(tasks_module, "_auto_push_any2api", lambda *args, **kwargs: None)

    logger = _FakeLogger()

    tasks_module._execute_register_task(
        {
            "platform": "chatgpt",
            "count": 1,
            "concurrency": 1,
            "email": "registered@example.com",
            "password": "Secret123!",
            "extra": {
                "identity_provider": "oauth_browser",
                "auto_chatgpt_workspace_join": True,
                "auto_chatgpt_plus_payment": False,
            },
        },
        logger,
    )

    assert logger.finished == (
        tasks_module.TASK_STATUS_FAILED,
        "Workspace Join 失败: invite button not clicked",
    )
    assert not any(event[0] == "success" for event in logger.events)


def test_phone_bind_task_passes_logger_and_browser_mode(monkeypatch):
    seen = {}

    class FakePhoneBindingService:
        def bind(self, **kwargs):
            seen.update(kwargs)
            kwargs["log_fn"]("phone bind step")
            return {"success_count": 1, "failure_count": 0, "phones": []}

    monkeypatch.setattr(tasks_module, "PhoneBindingService", FakePhoneBindingService, raising=False)
    logger = _FakeLogger()

    tasks_module._execute_phone_bind_task(
        {
            "platform": "chatgpt",
            "ids": [123],
            "fallback_ids": [],
            "phone_lines": "2025550104----https://relay.example.invalid/api/sms/recordText?key=abc",
            "browser_mode": "camoufox_headed",
            "bit_profile_id": "profile-1",
            "concurrency": 7,
        },
        logger,
    )

    assert seen["ids"] == [123]
    assert seen["browser_mode"] == "camoufox_headed"
    assert seen["bit_profile_id"] == "profile-1"
    assert seen["concurrency"] == 7
    assert getattr(seen["log_fn"], "__self__", None) is logger
    assert ("log", "phone bind step", {}) in logger.events
    assert logger.result_data == {"success_count": 1, "failure_count": 0, "phones": []}
    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")


def test_codex_oauth_task_passes_logger_and_browser_mode(monkeypatch):
    seen = []

    class FakeCtfPlusAccountsService:
        def run_codex_oauth_browser(self, **kwargs):
            seen.append(kwargs)
            kwargs["log_fn"]("oauth step")
            return {"ok": True, "account_id": kwargs["account_id"], "email": "oauth@test.com"}

    monkeypatch.setattr(tasks_module, "CtfPlusAccountsService", FakeCtfPlusAccountsService, raising=False)
    logger = _FakeLogger()

    tasks_module._execute_codex_oauth_task(
        {
            "ids": [456],
            "browser_mode": "bitbrowser_hidden",
            "bit_profile_id": "profile-2",
            "concurrency": 9,
        },
        logger,
    )

    assert seen[0]["account_id"] == 456
    assert seen[0]["browser_mode"] == "bitbrowser_hidden"
    assert seen[0]["bit_profile_id"] == "profile-2"
    assert getattr(seen[0]["log_fn"], "__self__", None) is logger
    assert any(event[0] == "log" and event[1] == "oauth step" for event in logger.events)
    assert logger.result_data["success_count"] == 1
    assert logger.result_data["concurrency"] == 1
    assert logger.result_data["results"][0]["account_id"] == 456
    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")


def test_codex_oauth_task_runs_multiple_accounts_without_capping_concurrency(monkeypatch):
    seen = []

    class FakeCtfPlusAccountsService:
        def run_codex_oauth_browser(self, **kwargs):
            seen.append(kwargs["account_id"])
            return {"ok": True, "account_id": kwargs["account_id"], "email": f"{kwargs['account_id']}@test.com"}

    monkeypatch.setattr(tasks_module, "CtfPlusAccountsService", FakeCtfPlusAccountsService, raising=False)
    logger = _FakeLogger()

    tasks_module._execute_codex_oauth_task(
        {
            "ids": [1, 2, 3],
            "browser_mode": "camoufox_headed",
            "concurrency": 99,
        },
        logger,
    )

    assert sorted(seen) == [1, 2, 3]
    assert logger.result_data["total"] == 3
    assert logger.result_data["success_count"] == 3
    assert logger.result_data["failure_count"] == 0
    assert logger.result_data["concurrency"] == 3
    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")


def test_platform_action_task_finishes_cancelled_without_starting_runtime(monkeypatch):
    class FakeRuntime:
        def execute_action(self, *args, **kwargs):
            raise AssertionError("runtime should not start after cancellation")

    monkeypatch.setattr(tasks_module, "PlatformRuntime", FakeRuntime)
    logger = _FakeLogger()
    logger.cancel_requested = True

    tasks_module._execute_platform_action_task(
        {
            "platform": "chatgpt",
            "account_id": 123,
            "action_id": "payment_link",
            "params": {"auto_checkout": "true"},
        },
        logger,
    )

    assert logger.finished == (tasks_module.TASK_STATUS_CANCELLED, "任务已取消")


def test_platform_action_task_marks_cancelled_after_runtime_cancel(monkeypatch):
    class FakeRuntime:
        def execute_action(self, command, *, log_fn=None, cancel_check):
            assert cancel_check() is False
            logger.cancel_requested = True
            return ActionExecutionResult(ok=False, error="任务已取消")

    monkeypatch.setattr(tasks_module, "PlatformRuntime", FakeRuntime)
    logger = _FakeLogger()

    tasks_module._execute_platform_action_task(
        {
            "platform": "chatgpt",
            "account_id": 123,
            "action_id": "payment_link",
            "params": {"auto_checkout": "true"},
        },
        logger,
    )

    assert logger.finished == (tasks_module.TASK_STATUS_CANCELLED, "任务已取消")


def test_chatgpt_auto_plus_followup_generates_payment_link(monkeypatch):
    saved_accounts = []

    class FakeLogger(_FakeLogger):
        def add_cashier_url(self, url):
            self.events.append(("cashier_url", url, {}))

    class FakeAccount:
        platform = "chatgpt"
        email = "ctf@example.com"
        password = "Secret123!"
        extra = {"access_token": "access-token"}

    class FakePlatform:
        def __init__(self):
            self.calls = []

        def execute_action(self, action_id, account, params):
            self.calls.append((action_id, params))
            return {
                "ok": True,
                "data": {
                    "cashier_url": "https://checkout.example/plus",
                    "checkout_url": "https://checkout.example/plus",
                    "message": "Payment link generated.",
                },
            }

    monkeypatch.setattr(tasks_module, "save_account", lambda account: saved_accounts.append(dict(account.extra)))
    logger = FakeLogger()
    platform = FakePlatform()
    account = FakeAccount()

    error = tasks_module._auto_followup_chatgpt_plus_payment(
        platform_name="chatgpt",
        payload={
            "extra": {
                "auto_chatgpt_plus_payment": True,
                "chatgpt_payment": {
                    "country": "US",
                    "currency": "USD",
                    "headless": "true",
                    "checkout_hold_seconds": 0,
                },
            }
        },
        platform=platform,
        account=account,
        logger=logger,
    )

    assert error == ""
    assert platform.calls == [
        (
            "payment_link",
            {
                "plan": "plus",
                "country": "US",
                "currency": "USD",
                "auto_checkout": "true",
                "payment_method": "paypal",
                "headless": "true",
                "checkout_timeout": 180,
                "checkout_hold_seconds": 0,
            },
        )
    ]
    assert account.extra["cashier_url"] == "https://checkout.example/plus"
    assert saved_accounts[-1]["cashier_url"] == "https://checkout.example/plus"
    assert ("cashier_url", "https://checkout.example/plus", {}) in logger.events
    assert account.status == tasks_module.AccountStatus.SUBSCRIBED
    assert account.extra["account_overview"]["plan_state"] == "subscribed"
    assert account.extra["account_overview"]["plan_name"] == "Plus"
    assert "Plus" in account.extra["account_overview"]["chips"]


def test_chatgpt_auto_plus_followup_logs_paypal_authorize_url_when_available(monkeypatch):
    class FakeLogger(_FakeLogger):
        def add_cashier_url(self, url):
            self.events.append(("cashier_url", url, {}))

    class FakeAccount:
        platform = "chatgpt"
        email = "ctf@example.com"
        password = "Secret123!"
        extra = {"access_token": "access-token"}

    class FakePlatform:
        def execute_action(self, action_id, account, params):
            return {
                "ok": True,
                "data": {
                    "cashier_url": "https://pay.openai.com/c/pay/cs_live_demo",
                    "checkout_url": "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
                    "paypal_authorize_url": "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
                    "paypal_protocol_extract": {"ok": True},
                },
            }

    monkeypatch.setattr(tasks_module, "save_account", lambda account: None)
    logger = FakeLogger()
    account = FakeAccount()

    error = tasks_module._auto_followup_chatgpt_plus_payment(
        platform_name="chatgpt",
        payload={"extra": {"auto_chatgpt_plus_payment": True}},
        platform=FakePlatform(),
        account=account,
        logger=logger,
    )

    assert error == ""
    assert (
        "cashier_url",
        "https://pm-redirects.stripe.com/authorize/acct_x/sa_nonce_y",
        {},
    ) in logger.events
    assert any(
        event[0] == "log" and "原始 cashier_url: https://pay.openai.com/c/pay/cs_live_demo" in event[1]
        for event in logger.events
    )
    assert account.extra["cashier_url"] == "https://pay.openai.com/c/pay/cs_live_demo"


def test_chatgpt_auto_plus_followup_forwards_checkout_mode_and_record_har(monkeypatch):
    class FakeAccount:
        platform = "chatgpt"
        email = "ctf@example.com"
        password = "Secret123!"
        extra = {"access_token": "access-token"}

    class FakeLogger(_FakeLogger):
        def add_cashier_url(self, url):
            self.events.append(("cashier_url", url, {}))

    class FakePlatform:
        def __init__(self):
            self.calls = []

        def execute_action(self, action_id, account, params):
            self.calls.append((action_id, dict(params)))
            return {"ok": True, "data": {"cashier_url": "https://checkout.example/plus"}}

    monkeypatch.setattr(tasks_module, "save_account", lambda account: None)
    logger = FakeLogger()
    platform = FakePlatform()
    account = FakeAccount()

    tasks_module._auto_followup_chatgpt_plus_payment(
        platform_name="chatgpt",
        payload={
            "extra": {
                "auto_chatgpt_plus_payment": True,
                "chatgpt_payment": {
                    "country": "US",
                    "currency": "USD",
                    "headless": "false",
                    "checkout_mode": "camoufox_headed",
                    "record_har": "true",
                },
            }
        },
        platform=platform,
        account=account,
        logger=logger,
    )

    assert len(platform.calls) == 1
    forwarded = platform.calls[0][1]
    assert forwarded["checkout_mode"] == "camoufox_headed"
    assert forwarded["record_har"] == "true"


def test_chatgpt_auto_plus_followup_omits_unset_checkout_mode_and_record_har(monkeypatch):
    class FakeAccount:
        platform = "chatgpt"
        email = "ctf@example.com"
        password = "Secret123!"
        extra = {}

    class FakePlatform:
        def __init__(self):
            self.calls = []

        def execute_action(self, action_id, account, params):
            self.calls.append((action_id, dict(params)))
            return {"ok": True, "data": {}}

    monkeypatch.setattr(tasks_module, "save_account", lambda account: None)
    logger = _FakeLogger()
    platform = FakePlatform()
    account = FakeAccount()

    tasks_module._auto_followup_chatgpt_plus_payment(
        platform_name="chatgpt",
        payload={
            "extra": {
                "auto_chatgpt_plus_payment": True,
                "chatgpt_payment": {"country": "US", "currency": "USD"},
            }
        },
        platform=platform,
        account=account,
        logger=logger,
    )

    forwarded = platform.calls[0][1]
    assert "checkout_mode" not in forwarded
    assert "record_har" not in forwarded


def test_get_rt_task_forwards_record_har_to_platform_action(monkeypatch):
    seen_params = []

    class FakeRuntime:
        def execute_action(self, command, *, log_fn=None, cancel_check=None):
            seen_params.append(dict(command.params))
            return ActionExecutionResult(ok=True, data={"message": "ok"})

    monkeypatch.setattr(runtime_module, "PlatformRuntime", FakeRuntime)
    logger = _FakeLogger()

    tasks_module._execute_get_rt_task(
        {
            "ids": [123],
            "browser_mode": "camoufox_headed",
            "record_har": "true",
            "concurrency": 1,
        },
        logger,
    )

    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")
    assert seen_params[0]["record_har"] == "true"


def test_get_rt_task_uses_shared_phone_reuse_pool(monkeypatch):
    from platforms.chatgpt import browser_get_rt as browser_get_rt_module

    built = []
    callbacks = []

    class FakePhonePool:
        def __init__(self):
            self.cleaned = False

        def make_callback(self, *, label=""):
            callback = lambda: f"phone-for-{label}"
            callbacks.append((label, callback))
            return callback

        def cleanup(self):
            self.cleaned = True

    fake_pool = FakePhonePool()

    def fake_build_pool(**kwargs):
        built.append(dict(kwargs))
        return fake_pool, ""

    class FakeRuntime:
        def execute_action(self, command, *, log_fn=None, cancel_check=None):
            assert callable(command.params["phone_callback"])
            assert command.params["phone_reuse_count"] == "3"
            return ActionExecutionResult(ok=True, data={"phone": command.params["phone_callback"]()})

    monkeypatch.setattr(browser_get_rt_module, "build_get_rt_phone_reuse_pool", fake_build_pool)
    monkeypatch.setattr(runtime_module, "PlatformRuntime", FakeRuntime)
    logger = _FakeLogger()

    tasks_module._execute_get_rt_task(
        {
            "ids": [101, 102, 103],
            "browser_mode": "camoufox_headed",
            "sms_provider": "smspool",
            "smspool_api_key": "KEY",
            "phone_reuse_count": 2,
            "concurrency": 1,
        },
        logger,
    )

    assert logger.finished == (tasks_module.TASK_STATUS_SUCCEEDED, "")
    assert len(built) == 1
    assert built[0]["reuse_count"] == 3
    assert len(callbacks) == 3
    assert callbacks[0][0] == "1/3"
    assert callbacks[-1][0] == "3/3"
    assert fake_pool.cleaned is True


def test_chatgpt_auto_plus_followup_returns_error_when_payment_link_fails(monkeypatch):
    class FakeLogger(_FakeLogger):
        def add_cashier_url(self, url):
            self.events.append(("cashier_url", url, {}))

    class FakeAccount:
        platform = "chatgpt"
        email = "ctf@example.com"
        password = "Secret123!"
        extra = {}

    class FakePlatform:
        def execute_action(self, action_id, account, params):
            return {
                "ok": False,
                "error": "checkout failed",
                "data": {
                    "cashier_url": "https://checkout.example/partial",
                },
            }

    saved_accounts = []
    monkeypatch.setattr(tasks_module, "save_account", lambda account: saved_accounts.append(dict(account.extra)))
    logger = FakeLogger()
    account = FakeAccount()

    error = tasks_module._auto_followup_chatgpt_plus_payment(
        platform_name="chatgpt",
        payload={"extra": {"auto_chatgpt_plus_payment": True}},
        platform=FakePlatform(),
        account=account,
        logger=logger,
    )

    assert error == "ChatGPT Plus 支付链接生成失败: checkout failed"
    assert account.extra["cashier_url"] == "https://checkout.example/partial"
    assert saved_accounts[-1]["cashier_url"] == "https://checkout.example/partial"
    assert ("cashier_url", "https://checkout.example/partial", {}) in logger.events


def test_chatgpt_auto_plus_followup_does_not_output_pay_url_when_protocol_extract_fails(monkeypatch):
    class FakeLogger(_FakeLogger):
        def add_cashier_url(self, url):
            self.events.append(("cashier_url", url, {}))

    class FakeAccount:
        platform = "chatgpt"
        email = "ctf@example.com"
        password = "Secret123!"
        extra = {}

    class FakePlatform:
        def execute_action(self, action_id, account, params):
            return {
                "ok": False,
                "error": "Stripe /confirm 响应缺少 pm-redirects.stripe.com/authorize URL",
                "data": {
                    "cashier_url": "https://pay.openai.com/c/pay/cs_live_demo",
                    "checkout_url": "https://pay.openai.com/c/pay/cs_live_demo",
                    "paypal_authorize_url": "",
                    "paypal_protocol_extract": {"ok": False, "error": "missing authorize"},
                },
            }

    monkeypatch.setattr(tasks_module, "save_account", lambda account: None)
    logger = FakeLogger()

    error = tasks_module._auto_followup_chatgpt_plus_payment(
        platform_name="chatgpt",
        payload={"extra": {"auto_chatgpt_plus_payment": True}},
        platform=FakePlatform(),
        account=FakeAccount(),
        logger=logger,
    )

    assert error.startswith("ChatGPT Plus 支付链接生成失败:")
    assert not any(event[0] == "cashier_url" for event in logger.events)
    assert not any(
        event[0] == "log" and "ChatGPT Plus 测试支付链接已生成: https://pay.openai.com" in event[1]
        for event in logger.events
    )


def test_platform_runtime_wires_log_fn_to_platform(monkeypatch):
    logs = []
    seen = {}

    class FakeSession:
        def __init__(self, engine):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, model_cls, account_id):
            return type("Model", (), {"platform": "chatgpt"})()

    class FakePlatform:
        def __init__(self, config=None):
            self._log_fn = print

        def set_logger(self, logger):
            self._log_fn = logger

        def set_cancel_checker(self, checker):
            seen["cancel_check"] = checker

        def execute_action(self, action_id, account, params):
            self._log_fn("runtime platform log")
            assert self.is_cancel_requested() is False
            return {"ok": True, "data": {"message": "ok"}}

        def is_cancel_requested(self):
            return seen["cancel_check"]()

    monkeypatch.setattr(runtime_module, "Session", FakeSession)
    monkeypatch.setattr(runtime_module, "load_all", lambda: None)
    monkeypatch.setattr(runtime_module, "get", lambda platform: FakePlatform)
    monkeypatch.setattr(runtime_module, "build_platform_account", lambda session, model: object())

    result = runtime_module.PlatformRuntime().execute_action(
        ActionExecutionCommand(
            platform="chatgpt",
            account_id=123,
            action_id="payment_link",
            params={"auto_checkout": "true"},
        ),
        log_fn=logs.append,
        cancel_check=lambda: False,
    )

    assert result.ok is True
    assert logs == ["runtime platform log"]
    assert seen["cancel_check"]() is False


def test_platform_runtime_persists_cashier_url_even_when_action_fails_after_link(monkeypatch):
    patched = {}

    class FakeSession:
        def __init__(self, engine):
            self.added = []
            self.committed = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, model_cls, account_id):
            return type("Model", (), {"id": account_id, "platform": "chatgpt", "updated_at": None})()

        def add(self, model):
            self.added.append(model)

        def commit(self):
            self.committed = True

    class FakePlatform:
        def __init__(self, config=None):
            pass

        def execute_action(self, action_id, account, params):
            return {
                "ok": False,
                "error": "checkout failed",
                "data": {
                    "cashier_url": "https://checkout.stripe.com/c/pay/cs_test_link",
                    "message": "Payment link generated, but checkout failed.",
                },
            }

    def fake_patch_account_graph(session, model, **kwargs):
        patched.update(kwargs)

    monkeypatch.setattr(runtime_module, "Session", FakeSession)
    monkeypatch.setattr(runtime_module, "load_all", lambda: None)
    monkeypatch.setattr(runtime_module, "get", lambda platform: FakePlatform)
    monkeypatch.setattr(runtime_module, "build_platform_account", lambda session, model: object())
    monkeypatch.setattr(runtime_module, "patch_account_graph", fake_patch_account_graph)

    result = runtime_module.PlatformRuntime().execute_action(
        ActionExecutionCommand(
            platform="chatgpt",
            account_id=123,
            action_id="payment_link",
            params={"auto_checkout": "true"},
        )
    )

    assert result.ok is False
    assert result.error == "checkout failed"
    assert patched["cashier_url"] == "https://checkout.stripe.com/c/pay/cs_test_link"
    assert patched["summary_updates"]["cashier_url"] == "https://checkout.stripe.com/c/pay/cs_test_link"


def test_platform_runtime_persists_get_rt_tokens_and_user_info(monkeypatch):
    patched = {}

    class FakeSession:
        def __init__(self, engine):
            self.added = []
            self.committed = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, model_cls, account_id):
            return type("Model", (), {"id": account_id, "platform": "chatgpt", "updated_at": None})()

        def add(self, model):
            self.added.append(model)

        def commit(self):
            self.committed = True

    class FakePlatform:
        def __init__(self, config=None):
            pass

        def execute_action(self, action_id, account, params):
            return {
                "ok": True,
                "data": {
                    "access_token": "access-token",
                    "refresh_token": "refresh-token",
                    "id_token": "id-token",
                    "account_id": "acct-123",
                    "email": "real@example.com",
                    "expired": "2026-06-10T15:00:00Z",
                    "last_refresh": "2026-06-10T14:00:00Z",
                    "type": "codex",
                    "profile": {"email": "real@example.com", "name": "Real User"},
                    "id_token_claims": {"email": "real@example.com", "sub": "auth0|abc"},
                },
            }

    def fake_patch_account_graph(session, model, **kwargs):
        patched.update(kwargs)

    monkeypatch.setattr(runtime_module, "Session", FakeSession)
    monkeypatch.setattr(runtime_module, "load_all", lambda: None)
    monkeypatch.setattr(runtime_module, "get", lambda platform: FakePlatform)
    monkeypatch.setattr(runtime_module, "build_platform_account", lambda session, model: object())
    monkeypatch.setattr(runtime_module, "patch_account_graph", fake_patch_account_graph)

    result = runtime_module.PlatformRuntime().execute_action(
        ActionExecutionCommand(
            platform="chatgpt",
            account_id=123,
            action_id="get_rt",
            params={},
        )
    )

    assert result.ok is True
    assert patched["credential_updates"]["access_token"] == "access-token"
    assert patched["credential_updates"]["refresh_token"] == "refresh-token"
    assert patched["credential_updates"]["id_token"] == "id-token"
    assert patched["credential_updates"]["account_id"] == "acct-123"
    summary = patched["summary_updates"]
    assert summary["remote_email"] == "real@example.com"
    assert summary["codex_oauth"]["account_id"] == "acct-123"
    assert summary["codex_oauth"]["profile"]["name"] == "Real User"
    assert summary["codex_oauth"]["id_token_claims"]["sub"] == "auth0|abc"


@pytest.mark.parametrize(
    "proof",
    ["success_url", "password_login_reconciled"],
)
def test_platform_runtime_persists_only_confirmed_settings_password(monkeypatch, proof):
    patched = {}
    model = type(
        "Model",
        (),
        {"id": 123, "platform": "chatgpt", "password": "", "updated_at": None},
    )()

    class FakeSession:
        def __init__(self, engine):
            self.committed = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, model_cls, account_id):
            return model

        def add(self, item):
            pass

        def commit(self):
            self.committed = True

    class FakePlatform:
        def __init__(self, config=None):
            pass

        def execute_action(self, action_id, account, params):
            return {
                "ok": True,
                "data": {
                    "password": "Configured123!",
                    "password_status": "configured",
                    "password_source": "settings",
                    "password_verification": proof,
                    "cookies": "__Secure-next-auth.session-token=secret-cookie",
                    "session_token": "secret-session",
                    "access_token": "secret-access",
                    "message": "密码设置成功",
                },
            }

    monkeypatch.setattr(runtime_module, "Session", FakeSession)
    monkeypatch.setattr(runtime_module, "load_all", lambda: None)
    monkeypatch.setattr(runtime_module, "get", lambda platform: FakePlatform)
    monkeypatch.setattr(
        runtime_module,
        "build_platform_account",
        lambda session, item: type("Account", (), {"extra": {"account_overview": {}}})(),
    )
    monkeypatch.setattr(
        runtime_module,
        "patch_account_graph",
        lambda session, item, **kwargs: patched.update(kwargs),
    )

    result = runtime_module.PlatformRuntime().execute_action(
        ActionExecutionCommand(
            platform="chatgpt",
            account_id=123,
            action_id="set_password",
            params={"password": "Configured123!"},
        )
    )

    assert result.ok is True
    assert model.password == "Configured123!"
    assert patched["summary_updates"]["password_status"] == "configured"
    assert patched["summary_updates"]["password_source"] == "settings"
    assert patched["credential_updates"]["cookies"].endswith("secret-cookie")
    assert patched["credential_updates"]["session_token"] == "secret-session"
    assert result.data == {
        "password_status": "configured",
        "password_source": "settings",
        "password_verification": proof,
        "message": "密码设置成功",
    }


def test_platform_runtime_rejects_password_action_pseudo_success(monkeypatch):
    patched = {}
    model = type(
        "Model",
        (),
        {"id": 123, "platform": "chatgpt", "password": "", "updated_at": None},
    )()

    class FakeSession:
        def __init__(self, engine):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, model_cls, account_id):
            return model

        def add(self, item):
            pass

        def commit(self):
            pass

    class FakePlatform:
        def __init__(self, config=None):
            pass

        def execute_action(self, action_id, account, params):
            return {
                "ok": True,
                "data": {
                    "password": "MustNotPersist123!",
                    "password_status": "configured",
                    "password_source": "settings",
                    "cookies": "secret-cookie",
                },
            }

    monkeypatch.setattr(runtime_module, "Session", FakeSession)
    monkeypatch.setattr(runtime_module, "load_all", lambda: None)
    monkeypatch.setattr(runtime_module, "get", lambda platform: FakePlatform)
    monkeypatch.setattr(
        runtime_module,
        "build_platform_account",
        lambda session, item: type("Account", (), {"extra": {"account_overview": {}}})(),
    )
    monkeypatch.setattr(
        runtime_module,
        "patch_account_graph",
        lambda session, item, **kwargs: patched.update(kwargs),
    )

    result = runtime_module.PlatformRuntime().execute_action(
        ActionExecutionCommand(
            platform="chatgpt",
            account_id=123,
            action_id="set_password",
            params={"password": "MustNotPersist123!"},
        )
    )

    assert result.ok is False
    assert model.password == ""
    assert "credential_updates" not in patched or not patched["credential_updates"]
    assert patched["summary_updates"]["password_status"] == "failed"
    assert "password" not in (result.data or {})
    assert "cookies" not in (result.data or {})


def test_platform_runtime_late_cancellation_preserves_confirmed_password(monkeypatch):
    state = {"action_finished": False, "committed": False}
    patch_calls = []
    model = type(
        "Model",
        (),
        {"id": 123, "platform": "chatgpt", "password": "", "updated_at": None},
    )()

    class FakeSession:
        def __init__(self, engine):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, model_cls, account_id):
            return model

        def add(self, item):
            pass

        def commit(self):
            state["committed"] = True

    class FakePlatform:
        def __init__(self, config=None):
            pass

        def set_cancel_checker(self, checker):
            self.checker = checker

        def execute_action(self, action_id, account, params):
            state["action_finished"] = True
            return {
                "ok": True,
                "data": {
                    "password": "Configured123!",
                    "password_status": "configured",
                    "password_source": "settings",
                    "password_verification": "success_url",
                },
            }

    monkeypatch.setattr(runtime_module, "Session", FakeSession)
    monkeypatch.setattr(runtime_module, "load_all", lambda: None)
    monkeypatch.setattr(runtime_module, "get", lambda platform: FakePlatform)
    monkeypatch.setattr(
        runtime_module,
        "build_platform_account",
        lambda session, item: type("Account", (), {"extra": {"account_overview": {}}})(),
    )
    monkeypatch.setattr(runtime_module, "patch_account_graph", lambda *args, **kwargs: patch_calls.append(kwargs))

    result = runtime_module.PlatformRuntime().execute_action(
        ActionExecutionCommand(
            platform="chatgpt",
            account_id=123,
            action_id="set_password",
            params={},
        ),
        cancel_check=lambda: state["action_finished"],
    )

    assert result.ok is True
    assert result.error == ""
    assert model.password == "Configured123!"
    assert state["committed"] is True
    assert len(patch_calls) == 1
    assert patch_calls[0]["summary_updates"]["password_status"] == "configured"
    assert "迟到取消" in result.data["message"]


def test_password_action_public_text_is_sanitized_twice():
    password = "Configured123!"
    proxy = "http://proxy-user:proxy-secret@proxy.example.test:8080"
    public = runtime_module._password_action_public_data(
        {
            "password_status": "failed",
            "password_error": (
                f"{password} {proxy} otp=123456 "
                "__Secure-next-auth.session-token=cookie-secret"
            ),
            "message": f"retry {password} with 654321",
            "cookies": "must-not-be-public",
        },
        {"password": password, "proxy": proxy},
    )

    serialized = str(public)
    assert password not in serialized
    assert proxy not in serialized
    assert "123456" not in serialized
    assert "654321" not in serialized
    assert "cookie-secret" not in serialized
    assert "must-not-be-public" not in serialized
