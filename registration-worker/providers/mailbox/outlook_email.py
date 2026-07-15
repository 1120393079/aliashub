"""outlookEmail mailbox provider registration."""
from core.outlook_email_mailbox import OutlookEmailMailbox  # noqa: F401
from providers.registry import register_provider

register_provider("mailbox", "outlook_email_api")(OutlookEmailMailbox)
