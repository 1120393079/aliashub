"""SMSBower provider — register into unified registry.

SMSBower uses the same SMS-Activate compatible API as HeroSMS,
just with a different base URL (smsbower.page).
"""
from core.base_sms import SmsBowerProvider  # noqa: F401
from providers.registry import register_provider

register_provider("sms", "smsbower_api")(SmsBowerProvider)
