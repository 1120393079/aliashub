from __future__ import annotations

from core.datetime_utils import serialize_datetime
from infrastructure.task_logs_repository import TaskLogsRepository


class TaskLogsService:
    def __init__(self, repository: TaskLogsRepository | None = None):
        self.repository = repository or TaskLogsRepository()

    def list_logs(self, *, platform: str = "", page: int = 1, page_size: int = 50) -> dict:
        total, items = self.repository.list(platform=platform, page=page, page_size=page_size)
        return {
            "total": total,
            "page": page,
            "items": [
                {
                    "id": item.id,
                    "platform": item.platform,
                    "email": item.email,
                    "status": item.status,
                    "error": item.error,
                    "detail": item.detail or {},
                    "created_at": serialize_datetime(item.created_at),
                }
                for item in items
            ],
        }
