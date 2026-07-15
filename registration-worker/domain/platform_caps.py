from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class PlatformCapabilitiesUpdate:
    supported_executors: list[str] = field(default_factory=list)
    supported_identity_modes: list[str] = field(default_factory=list)
    supported_oauth_providers: list[str] = field(default_factory=list)
    capabilities: list[str] = field(default_factory=list)
