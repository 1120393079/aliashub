from __future__ import annotations


class ExtractionError(RuntimeError):
    """Base class for expected extraction failures."""


class ConfigurationError(ExtractionError, ValueError):
    """Raised when caller-supplied configuration is invalid."""


class NetworkError(ExtractionError):
    """Raised when a request fails before an HTTP response is received."""

    def __init__(self, stage: str, detail: str):
        self.stage = str(stage or "request")
        self.detail = str(detail or "network request failed")
        super().__init__(f"{self.stage}: {self.detail}")


class ProtocolError(ExtractionError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class ProviderRequiresApproval(ExtractionError):
    pass


class CheckoutApprovalBlocked(ExtractionError):
    """The provider explicitly rejected ChatGPT manual approval as blocked.

    This is deliberately separate from :class:`ProtocolError`: callers may
    recover from it only by creating a *new* Checkout. Replaying confirm or
    approve on the same Checkout is not a valid recovery strategy.
    """

    def __init__(
        self,
        detail: str = "ChatGPT manual approval blocked",
        *,
        result: str = "blocked",
        status_code: int | None = None,
        attempts: int | None = None,
    ) -> None:
        self.detail = str(detail or "ChatGPT manual approval blocked")
        self.result = str(result or "blocked").strip().lower() or "blocked"
        self.status_code = status_code
        self.attempts = attempts
        super().__init__(self.detail)


# Keep descriptive aliases available to older integrations that used one of
# these names while the standalone extractor was being migrated.
ChatGPTApprovalBlocked = CheckoutApprovalBlocked
PaypalApprovalBlocked = CheckoutApprovalBlocked
OpllChatgptApproveBlocked = CheckoutApprovalBlocked


class ExtractionCancelled(ExtractionError):
    """Raised when a cooperative task cancellation is observed."""


# Backward-compatible name for code that used the old exception spelling.
PaypalRequiresApproval = ProviderRequiresApproval
