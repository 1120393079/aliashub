from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from sqlmodel import Session, select

from application.tasks import (
    _run_single_account_check,
    create_account_check_all_task,
    create_account_check_task,
)
from core.db import AccountModel, engine
from services.task_runtime import task_runtime
from infrastructure.accounts_repository import AccountsRepository


class AccountChecksService:
    def __init__(self, repository: AccountsRepository | None = None):
        self.repository = repository or AccountsRepository()

    def check_all_async(self, platform: str = "") -> dict:
        task = create_account_check_all_task(platform or "")
        task_runtime.wake_up()
        return task

    def check_one_async(self, account_id: int) -> dict | None:
        if not self.repository.get(account_id):
            return None
        task = create_account_check_task(account_id)
        task_runtime.wake_up()
        return task

    def refresh_plan_sync(
        self,
        platform: str = "",
        *,
        account_ids: list[int] | None = None,
        max_workers: int = 20,
        timeout_seconds: int = 120,
    ) -> dict[str, Any]:
        """**同步**并发批量刷新账号订阅状态（plus / free / expired）。

        参考 router-for-me/CLIProxyAPI 的 ``/v0/management/api-call`` 思路：
        直接用账号 access_token 打 ``chatgpt.com/backend-api/me`` +
        ``/wham/usage`` 拿 ``plan_type``，每个账号一次 HTTP（毫秒级），
        线程池并发，整体几秒内完成 N 个账号的状态刷新。

        跟 ``check_all_async`` 的区别：
            - check_all_async 创建一个长任务后台串行跑，前端要轮询 SSE
              事件等任务完成；UX 卡顿明显。
            - refresh_plan_sync 同步并发，直接返回所有账号最新状态，前端
              立刻看到结果。适合中等规模（< 500 个账号）的"刷新配额"按钮。

        **超时容错**：用 ``try/except TimeoutError`` 包住 ``as_completed``，
        超时时把未完成的 future 标 ``timeout`` 占位返回。

        Args:
            platform: 只刷新指定平台的账号；空串 = 全部。
            account_ids: **白名单**——只刷新这些 ID 对应的账号。空列表 /
                None 视为"不过滤跑全部"。前端"刷新配额"按钮按勾选传 ids，
                让用户精确控制刷哪些（避免大批量号一次 refresh 跑几分钟还
                烧 ChatGPT 限流）。
            max_workers: 并发数。chatgpt 后端对单 IP 限流较严，20 个并发
                跑得稳；高于这数容易被 429。
            timeout_seconds: 整体超时；超时未完成的账号在 items 里标 ok=False。

        Returns:
            {"updated": <int>, "items": [{account_id, email, valid, ok,
            error}, ...], "timed_out": <int>}
        """
        with Session(engine) as session:
            query = select(AccountModel)
            if platform:
                query = query.where(AccountModel.platform == platform)
            if account_ids:
                wanted = {int(x) for x in account_ids if x}
                if wanted:
                    query = query.where(AccountModel.id.in_(wanted))  # type: ignore[attr-defined]
            query = query.order_by(AccountModel.id.desc())
            resolved_ids = [int(m.id or 0) for m in session.exec(query).all() if m.id]

        if not resolved_ids:
            return {"updated": 0, "items": [], "timed_out": 0}

        results: list[dict[str, Any]] = []
        updated = 0
        timed_out = 0

        def _refresh(account_id: int) -> dict[str, Any]:
            try:
                valid, payload = _run_single_account_check(account_id)
                return {
                    "account_id": account_id,
                    "email": payload.get("email", ""),
                    "platform": payload.get("platform", ""),
                    "valid": bool(valid),
                    "ok": True,
                }
            except Exception as exc:
                return {
                    "account_id": account_id,
                    "ok": False,
                    "error": str(exc),
                }

        with ThreadPoolExecutor(max_workers=max(int(max_workers), 1)) as pool:
            futures = {pool.submit(_refresh, aid): aid for aid in resolved_ids}
            try:
                for future in as_completed(futures, timeout=timeout_seconds):
                    try:
                        item = future.result()
                    except Exception as exc:
                        item = {
                            "account_id": futures[future],
                            "ok": False,
                            "error": str(exc),
                        }
                    if item.get("ok"):
                        updated += 1
                    results.append(item)
            except TimeoutError:
                # 整体超时：把未完成的 future 标占位返回。pool 退出时已完成
                # 的会被自然 join；未完成的虽然 cancel 不掉（线程已起跑），
                # 但 HTTP 请求至少不再 500。前端拿到 ``timed_out > 0``
                # 可提示用户"号太多没刷新完，再点一次"。
                completed_ids = {item.get("account_id") for item in results}
                for fut, aid in futures.items():
                    if aid in completed_ids:
                        continue
                    if fut.done():
                        try:
                            item = fut.result(timeout=0)
                            if item.get("ok"):
                                updated += 1
                            results.append(item)
                        except Exception as exc:
                            results.append({
                                "account_id": aid,
                                "ok": False,
                                "error": str(exc),
                            })
                    else:
                        timed_out += 1
                        results.append({
                            "account_id": aid,
                            "ok": False,
                            "error": "timeout",
                        })

        return {
            "updated": updated,
            "items": results,
            "timed_out": timed_out,
        }
