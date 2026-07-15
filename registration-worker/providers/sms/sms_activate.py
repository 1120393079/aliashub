"""SMS-Activate provider — register into unified registry.

The actual implementation stays in ``core.base_sms`` to preserve shared
state with ``PhoneCallbackController``.  This module simply imports and
registers it so that ``providers.registry.load_all()`` picks it up.
"""
from core.base_sms import SmsActivateProvider  # noqa: F401 – re-export
from providers.registry import register_provider

register_provider("sms", "sms_activate_api")(SmsActivateProvider)
