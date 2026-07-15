"""TestmailMailbox — register into unified registry."""
from core.base_mailbox import TestmailMailbox  # noqa: F401
from providers.registry import register_provider

register_provider("mailbox", "testmail_api")(TestmailMailbox)
