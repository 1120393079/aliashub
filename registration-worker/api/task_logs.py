from __future__ import annotations

from fastapi import APIRouter

from application.task_logs import TaskLogsService

router = APIRouter(prefix="/tasks", tags=["task-logs"])
service = TaskLogsService()


@router.get("/logs")
def list_task_logs(platform: str = "", page: int = 1, page_size: int = 50):
    return service.list_logs(platform=platform, page=page, page_size=page_size)
