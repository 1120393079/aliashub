"""SMS 号码池黑名单 HTTP 路由。

提供给前端 "账户 > 短信号码池" 子页使用：
- ``GET /sms-pool/blacklist``           列出全部
- ``POST /sms-pool/blacklist``          手动新增 / 累计 fail_count
- ``DELETE /sms-pool/blacklist/{phone}`` 把号码移出黑名单（恢复可用）
- ``DELETE /sms-pool/blacklist``        清空所有
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from infrastructure.sms_pool_repository import SmsPoolBlacklistRepository

router = APIRouter(prefix="/sms-pool", tags=["sms-pool"])
_repo = SmsPoolBlacklistRepository()


class BlacklistAddRequest(BaseModel):
    phone: str
    relay_url: str = ""
    reason: str = "manual"
    error_code: str = ""
    task_id: str = ""
    error_message: str = ""


@router.get("/blacklist")
def list_blacklist():
    items = [item.to_dict() for item in _repo.list()]
    return {"items": items, "total": len(items)}


@router.post("/blacklist")
def add_blacklist(body: BlacklistAddRequest):
    record = _repo.add(
        phone=body.phone,
        relay_url=body.relay_url,
        reason=body.reason or "manual",
        error_code=body.error_code,
        task_id=body.task_id,
        error_message=body.error_message,
    )
    if not record:
        raise HTTPException(400, "phone 不可为空 / 格式无效")
    return record.to_dict()


@router.delete("/blacklist/{phone}")
def remove_blacklist(phone: str):
    ok = _repo.remove(phone)
    if not ok:
        raise HTTPException(404, "号码不在黑名单中")
    return {"ok": True, "phone": phone}


@router.delete("/blacklist")
def clear_blacklist():
    removed = _repo.clear()
    return {"ok": True, "removed": removed}
