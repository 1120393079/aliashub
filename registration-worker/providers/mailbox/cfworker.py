"""CFWorkerMailbox — register into unified registry."""
from core.base_mailbox import CFWorkerMailbox  # noqa: F401
from providers.registry import register_provider

register_provider("mailbox", "cfworker_admin_api")(CFWorkerMailbox)
