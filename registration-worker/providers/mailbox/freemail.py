"""FreemailMailbox — register into unified registry."""
from core.base_mailbox import FreemailMailbox  # noqa: F401
from providers.registry import register_provider

register_provider("mailbox", "freemail_api")(FreemailMailbox)
