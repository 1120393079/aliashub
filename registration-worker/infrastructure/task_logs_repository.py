from __future__ import annotations

import json

from sqlmodel import Session, select, func

from core.db import TaskLog, engine
from domain.task_logs import TaskLogRecord


def _to_record(model: TaskLog) -> TaskLogRecord:
    try:
        detail = json.loads(model.detail_json or "{}")
    except Exception:
        detail = {}
    return TaskLogRecord(
        id=int(model.id or 0),
        platform=model.platform,
        email=model.email,
        status=model.status,
        error=model.error,
        detail=detail,
        created_at=model.created_at,
    )


class TaskLogsRepository:
    def list(self, *, platform: str = "", page: int = 1, page_size: int = 50) -> tuple[int, list[TaskLogRecord]]:
        page = max(page, 1)
        page_size = min(max(page_size, 1), 200)
        with Session(engine) as session:
            query = select(TaskLog)
            total_query = select(func.count()).select_from(TaskLog)
            if platform:
                query = query.where(TaskLog.platform == platform)
                total_query = total_query.where(TaskLog.platform == platform)
            query = query.order_by(TaskLog.id.desc())
            total = int(session.exec(total_query).one() or 0)
            items = session.exec(query.offset((page - 1) * page_size).limit(page_size)).all()
        return total, [_to_record(item) for item in items]
