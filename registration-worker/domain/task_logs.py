from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(slots=True)
class TaskLogRecord:
    id: int
    platform: str
    email: str
    status: str
    error: str = ""
    detail: dict | None = None
    created_at: Optional[datetime] = None
