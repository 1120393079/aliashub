from __future__ import annotations

from application.tasks import _resolve_sms_provider_for_task
from application.tasks import _resolve_registration_proxy_for_platform
from infrastructure.provider_definitions_repository import ProviderDefinitionsRepository
from infrastructure.provider_settings_repository import ProviderSettingsRepository


def test_resolve_sms_provider_for_task_uses_saved_herosms_default():
    ProviderDefinitionsRepository().ensure_seeded()
    repo = ProviderSettingsRepository()
    repo.save(
        setting_id=None,
        provider_type="sms",
        provider_key="herosms_api",
        display_name="HeroSMS",
        auth_mode="api_key",
        enabled=True,
        is_default=True,
        config={
            "sms_service": "dr",
            "sms_country": "187",
            "register_phone_extra_max": "3",
        },
        auth={"herosms_api_key": "hero123"},
        metadata={},
    )

    provider_key, settings = _resolve_sms_provider_for_task({})

    assert provider_key == "herosms_api"
    assert settings["herosms_api_key"] == "hero123"
    assert settings["sms_service"] == "dr"


def test_resolve_sms_provider_for_task_allows_inline_override():
    provider_key, settings = _resolve_sms_provider_for_task({
        "sms_provider": "herosms",
        "herosms_api_key": "inline",
        "sms_country": "52",
    })

    assert provider_key == "herosms"
    assert settings["herosms_api_key"] == "inline"
    assert settings["sms_country"] == "52"


def test_chatgpt_registration_does_not_use_proxy_pool_or_explicit_proxy():
    calls = []

    proxy = _resolve_registration_proxy_for_platform(
        "chatgpt",
        explicit_proxy="http://explicit-proxy.example:8080",
        proxy_getter=lambda: calls.append("called") or "http://pool-proxy.example:8080",
    )

    assert proxy is None
    assert calls == []


def test_chatgpt_registration_can_use_explicit_proxy_when_opted_in():
    proxy = _resolve_registration_proxy_for_platform(
        "chatgpt",
        explicit_proxy="http://proxy.example:8080",
        proxy_getter=lambda: "http://pool.example:8080",
        allow_chatgpt_proxy=True,
    )

    assert proxy == "http://proxy.example:8080"


def test_non_chatgpt_registration_still_uses_proxy_pool():
    proxy = _resolve_registration_proxy_for_platform(
        "windsurf",
        explicit_proxy="",
        proxy_getter=lambda: "http://pool-proxy.example:8080",
    )

    assert proxy == "http://pool-proxy.example:8080"
