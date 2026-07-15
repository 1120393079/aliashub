from __future__ import annotations

from domain.platform_caps import PlatformCapabilitiesUpdate
from infrastructure.platform_caps_repository import PlatformCapabilitiesRepository


class PlatformCapabilitiesService:
    def __init__(self, repository: PlatformCapabilitiesRepository | None = None):
        self.repository = repository or PlatformCapabilitiesRepository()

    def list_platforms(self) -> list[dict]:
        return self.repository.list_platforms()

    def update(self, name: str, payload: dict) -> dict:
        update = PlatformCapabilitiesUpdate(
            supported_executors=list(payload.get("supported_executors", []) or []),
            supported_identity_modes=list(payload.get("supported_identity_modes", []) or []),
            supported_oauth_providers=list(payload.get("supported_oauth_providers", []) or []),
            capabilities=list(payload.get("capabilities", []) or []),
        )
        return self.repository.update(name, update)

    def reset(self, name: str) -> dict:
        return self.repository.reset(name)
