"""BitBrowser Profile 池 REST API。

接口设计走最简风格：GET 列表 / POST 新增单个 / DELETE 单个 / PUT 批量
覆盖。前端"设置"页就能直接增删管理。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from application.bitbrowser_profiles import bitbrowser_profile_pool


router = APIRouter(prefix="/bitbrowser/profiles", tags=["bitbrowser"])


class _ProfileBody(BaseModel):
    profile_id: str


class _ProfilesBatchBody(BaseModel):
    profile_ids: list[str]


@router.get("")
def list_profiles() -> dict:
    """返回当前池内所有 profile + 占用计数。"""
    return {"items": bitbrowser_profile_pool.list_profiles()}


@router.post("")
def add_profile(body: _ProfileBody) -> dict:
    profile_id = body.profile_id.strip()
    if not profile_id:
        raise HTTPException(status_code=400, detail="profile_id 不能为空")
    created = bitbrowser_profile_pool.add(profile_id)
    return {"created": created, "profile_id": profile_id}


@router.delete("/{profile_id}")
def remove_profile(profile_id: str) -> dict:
    removed = bitbrowser_profile_pool.remove(profile_id)
    if not removed:
        raise HTTPException(status_code=404, detail="profile_id 不存在")
    return {"removed": True, "profile_id": profile_id}


@router.put("")
def replace_profiles(body: _ProfilesBatchBody) -> dict:
    """整体覆盖池内容（前端"批量编辑"或"清空"按钮会用）。"""
    final = bitbrowser_profile_pool.replace_all(body.profile_ids)
    return {"items": [{"profile_id": pid, "in_use": 0} for pid in final]}
