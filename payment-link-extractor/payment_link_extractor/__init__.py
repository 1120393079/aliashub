"""Typed service API for extracting payment-provider checkout links."""

from .application import extract_payment_link
from .errors import (
    ConfigurationError,
    CheckoutApprovalBlocked,
    ChatGPTApprovalBlocked,
    ExtractionCancelled,
    ExtractionError,
    NetworkError,
    ProtocolError,
    ProviderRequiresApproval,
    PaypalApprovalBlocked,
)
from .models import BillingProfile, ExtractionConfig, PaymentLinkResult

__all__ = [
    "BillingProfile",
    "ConfigurationError",
    "CheckoutApprovalBlocked",
    "ChatGPTApprovalBlocked",
    "ExtractionCancelled",
    "ExtractionConfig",
    "ExtractionError",
    "NetworkError",
    "PaymentLinkResult",
    "ProtocolError",
    "ProviderRequiresApproval",
    "PaypalApprovalBlocked",
    "extract_payment_link",
]
