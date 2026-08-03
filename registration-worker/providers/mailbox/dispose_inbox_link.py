"""Register the dispose.lol inbox-link mailbox provider."""

from core.inbox_link_mailbox import DisposeInboxLinkMailboxPool
from providers.registry import register_provider


register_provider("mailbox", "dispose_inbox_link")(DisposeInboxLinkMailboxPool)
