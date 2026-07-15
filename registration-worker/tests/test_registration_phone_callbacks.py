from __future__ import annotations

from types import SimpleNamespace

from core.base_platform import RegisterConfig
from core.registration import BrowserRegistrationAdapter, BrowserRegistrationFlow, RegistrationContext, RegistrationResult
from core.registration.helpers import build_phone_callbacks
import core.registration.flows as flows_module


def test_browser_flow_wires_phone_callback_and_runs_cleanup(monkeypatch):
    events = []

    def fake_build_phone_callbacks(ctx, *, service=None):
        events.append(("build", service))
        return (lambda: "18885551234", lambda: events.append(("cleanup", service)))

    monkeypatch.setattr(flows_module, "build_phone_callbacks", fake_build_phone_callbacks)

    ctx = RegistrationContext(
        platform_name="chatgpt",
        platform_display_name="ChatGPT",
        platform=SimpleNamespace(mailbox=None),
        identity=SimpleNamespace(
            email="user@example.com",
            has_mailbox=True,
            identity_provider="mailbox",
        ),
        config=RegisterConfig(executor_type="headless", extra={}),
        email="user@example.com",
        password="Secret123!",
        log_fn=lambda message: None,
    )

    def build_worker(ctx, artifacts):
        assert callable(artifacts.phone_callback)
        return SimpleNamespace(phone_callback=artifacts.phone_callback)

    def run_worker(worker, ctx, artifacts):
        events.append(("callback", worker.phone_callback()))
        return {"email": ctx.identity.email, "password": ctx.password}

    adapter = BrowserRegistrationAdapter(
        result_mapper=lambda ctx, raw: RegistrationResult(email=raw["email"], password=raw["password"]),
        browser_worker_builder=build_worker,
        browser_register_runner=run_worker,
    )

    result = BrowserRegistrationFlow(adapter).run(ctx)

    assert result.email == "user@example.com"
    assert ("build", "chatgpt") in events
    assert ("callback", "18885551234") in events
    assert ("cleanup", "chatgpt") in events


def test_email_only_registration_does_not_resolve_global_sms_provider(monkeypatch):
    class FailSettingsRepository:
        def get_default_provider_key(self, category):
            raise AssertionError("email-only registration must not read the global SMS provider")

    monkeypatch.setattr(
        "infrastructure.provider_settings_repository.ProviderSettingsRepository",
        FailSettingsRepository,
    )
    messages = []
    ctx = SimpleNamespace(
        extra={"phone_verification_policy": "forbid"},
        log=messages.append,
    )

    callback, cleanup = build_phone_callbacks(ctx, service="chatgpt")

    assert callback is None
    assert cleanup is None
    assert any("仅邮箱注册模式" in message for message in messages)
