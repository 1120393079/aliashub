from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from application.account_checks import AccountChecksService

router = APIRouter(prefix="/accounts", tags=["account-checks"])
service = AccountChecksService()


class _RefreshPlanBody(BaseModel):
    """``POST /accounts/refresh-plan`` 请求体。

    ``ids`` 为空时跑该 platform 全部账户；非空只跑指定 ID。
    前端"刷新配额"按钮按勾选传 ids 实现"勾哪个刷哪个"。
    """

    ids: list[int] = Field(default_factory=list)


@router.post("/check-all")
def check_all_accounts(platform: str = ""):
    return service.check_all_async(platform)


@router.post("/refresh-plan")
def refresh_plan(
    platform: str = "",
    body: _RefreshPlanBody | None = None,
):
    """**同步**并发批量刷新订阅状态（plus / free / expired）。

    参考 router-for-me/CLIProxyAPI ``/v0/management/api-call`` 思路：
    直接用账号 access_token 调 ``chatgpt.com/backend-api/me`` +
    ``/wham/usage`` 拿 ``plan_type``，20 线程并发，秒级返回。

    Body 里传 ``{"ids": [1, 2, 3]}`` 只刷指定账号；空数组 / 不传 body
    时回退到"该 platform 全部账号"——保持向后兼容。
    """
    ids = body.ids if body else []
    return service.refresh_plan_sync(platform, account_ids=ids or None)


@router.post("/{account_id}/check")
def check_account(account_id: int):
    result = service.check_one_async(account_id)
    if not result:
        raise HTTPException(404, "账号不存在")
    return result
