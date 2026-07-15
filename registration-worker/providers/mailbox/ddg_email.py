"""DuckDuckGo Email Protection — register into unified registry."""
from core.base_mailbox import DDGEmailMailbox  # noqa: F401
from providers.registry import register_provider

register_provider("mailbox", "ddg_email")(DDGEmailMailbox)
