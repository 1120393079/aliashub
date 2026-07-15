"""HeroSMS provider — register into unified registry.

The actual implementation stays in ``core.base_sms`` to preserve shared
state (``_HERO_SMS_VERIFY_LOCK``, ``_HERO_SMS_CACHE``) with
``PhoneCallbackController``.  This module simply imports and registers it
so that ``providers.registry.load_all()`` picks it up.

Re-exports commonly used symbols for convenience.
"""
from core.base_sms import (  # noqa: F401 – re-exports
    HERO_SMS_DEFAULT_COUNTRY,
    HERO_SMS_DEFAULT_SERVICE,
    HeroSmsProvider,
    is_herosms_phone_cache_alive,
)
from providers.registry import register_provider

register_provider("sms", "herosms_api")(HeroSmsProvider)
