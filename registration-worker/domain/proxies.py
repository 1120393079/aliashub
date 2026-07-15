from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(slots=True)
class ProxyRecord:
    id: int
    url: str
    region: str = ""
    success_count: int = 0
    fail_count: int = 0
    is_active: bool = True
    last_checked: Optional[datetime] = None


@dataclass(slots=True)
class ProxyCreateCommand:
    url: str
    region: str = ""


@dataclass(slots=True)
class ProxyBulkCreateCommand:
    proxies: list[str]
    region: str = ""


@dataclass(slots=True)
class ProxyCheckSummary:
    ok: int = 0
    fail: int = 0
