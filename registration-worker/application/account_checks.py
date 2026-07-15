from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import re
from typing import Any

from sqlmodel import Session, select

from application.tasks import (
    _run_single_account_check,
    create_account_check_all_task,
    create_account_check_task,
)
from core.db import AccountModel, engine
from core.proxy_urls import build_proxy_config
from services.task_runtime import task_runtime
from infrastructure.accounts_repository import AccountsRepository


def _checked_at() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _exception_chain(error: Exception) -> list[Exception]:
    result: list[Exception] = []
    seen: set[int] = set()
    current: Exception | None = error
    while isinstance(current, Exception) and id(current) not in seen:
        seen.add(id(current))
        result.append(current)
        current = current.__cause__ or current.__context__
    return result


def _public_check_failure(error: Exception, *, proxy_configured: bool = False) -> dict[str, Any]:
    chain = _exception_chain(error)
    for item in reversed(chain):
        code = str(getattr(item, "code", "") or "").strip().lower()
        reason = str(getattr(item, "reason", "") or "").strip()
        if code and reason:
            return {
                "ok": False,
                "valid": None,
                "availability": "unchecked",
                "detection_result": "inconclusive",
                "type_observed": False,
                "plan_detection_result": "inconclusive",
                "plan_authority": "last_known",
                "account_type_confidence": "none",
                "status_code": code[:80],
                "status_reason": reason[:240],
                "status_retryable": bool(getattr(item, "retryable", True)),
                "status_source": str(getattr(item, "source", "") or "")[:100],
                "status_http": int(getattr(item, "http_status", 0) or 0),
                "status_evidence_path": str(getattr(item, "evidence_path", "") or "")[:120],
                "status_checked_at": _checked_at(),
                "error": reason[:240],
            }

    text = " ".join(str(item) for item in chain).lower()
    if re.search(r"timeout|timed out|超时|abort", text):
        code, reason, retryable = "check_timeout", "状态检测超时，已保留上次结果", True
    elif re.search(r"429|rate.?limit|too many|限流|请求过多", text):
        code, reason, retryable = "rate_limited", "状态检测请求频率受限，已保留上次结果", True
    elif re.search(r"cloudflare|challenge|captcha|<!doctype|<html", text):
        code, reason, retryable = "challenge_page", "上游返回了验证页面，已保留上次结果", True
    elif proxy_configured and re.search(r"proxy|代理|connect|socket|dns|tls|ssl", text):
        code, reason, retryable = "proxy_unavailable", "账号代理暂时不可用，已保留上次结果", True
    elif re.search(r"401|403|unauthori|forbidden|授权", text):
        code, reason, retryable = "auth_unauthorized_unconfirmed", "授权失败但证据不足，已保留上次结果", True
    elif re.search(r"5\d\d|upstream|service unavailable", text):
        code, reason, retryable = "upstream_unavailable", "上游服务暂时不可用，已保留上次结果", True
    elif re.search(r"network|connect|socket|dns|tls|ssl|网络", text):
        code, reason, retryable = "network_error", "状态检测网络异常，已保留上次结果", True
    else:
        code, reason, retryable = "check_inconclusive", "状态检测未得出可靠结论，已保留上次结果", True
    return {
        "ok": False,
        "valid": None,
        "availability": "unchecked",
        "detection_result": "inconclusive",
        "type_observed": False,
        "plan_detection_result": "inconclusive",
        "plan_authority": "last_known",
        "account_type_confidence": "none",
        "status_code": code,
        "status_reason": reason,
        "status_retryable": retryable,
        "status_source": "account-check",
        "status_http": 0,
        "status_evidence_path": "",
        "status_checked_at": _checked_at(),
        "error": reason,
    }


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
        account_proxies: dict[int, str] | None = None,
        max_workers: int = 20,
        timeout_seconds: int = 120,
    ) -> dict[str, Any]:
        """同步并发刷新账号可用性、凭据状态和完整订阅类型。

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
            account_proxies: 可选的账号 ID → 原注册代理映射。每个账号先走其
                原代理，失败后平台检测逻辑仍会回退直连；代理不会写入响应。
            max_workers: 并发数。chatgpt 后端对单 IP 限流较严，20 个并发
                跑得稳；高于这数容易被 429。
            timeout_seconds: 整体超时；超时未完成的账号在 items 里标 ok=False。

        Returns:
            每个 item 包含独立的账号、凭据、订阅、套餐字段，以及稳定的
            ``status_code`` / ``status_reason``。``ok=False`` 表示本次检测无
            结论，原状态不会被覆盖。
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
                proxy_url = str((account_proxies or {}).get(account_id) or "").strip()
                if proxy_url:
                    build_proxy_config(proxy_url)
                valid, payload = _run_single_account_check(account_id, proxy_url=proxy_url or None)
                public_payload = {
                    "account_id": account_id,
                    "valid": bool(valid),
                    "ok": True,
                }
                for key in (
                    "email", "platform", "availability", "detection_result", "type_observed",
                    "plan_detection_result", "plan_authority", "account_type_confidence", "account_status",
                    "credential_status", "subscription_status", "account_type", "account_type_raw",
                    "account_type_source", "status_code", "status_reason", "status_retryable",
                    "status_http", "status_evidence_path", "status_source", "status_checked_at",
                ):
                    public_payload[key] = payload.get(key)
                return public_payload
            except Exception as exc:
                failure = {
                    "account_id": account_id,
                    **_public_check_failure(exc, proxy_configured=bool(proxy_url)),
                }
                previous = self.repository.get(account_id)
                if previous:
                    overview = previous.overview if isinstance(previous.overview, dict) else {}
                    if previous.validity_status == "valid":
                        failure["availability"] = "available"
                    elif previous.validity_status == "invalid":
                        failure["availability"] = "unavailable"
                    failure.update({
                        "email": previous.email,
                        "platform": previous.platform,
                        "account_status": str(overview.get("account_status") or "unknown"),
                        "credential_status": str(overview.get("credential_status") or "unknown"),
                        "subscription_status": str(
                            overview.get("subscription_status") or previous.plan_state or "unknown"
                        ),
                        "account_type": str(
                            overview.get("account_type") or previous.plan_name or "unknown"
                        ),
                        "account_type_raw": str(
                            overview.get("account_type_raw") or previous.plan_name or ""
                        ),
                        "account_type_source": str(
                            overview.get("account_type_source")
                            or overview.get("plan_source")
                            or "last_confirmed"
                        ),
                    })
                return failure

        with ThreadPoolExecutor(max_workers=max(int(max_workers), 1)) as pool:
            futures = {pool.submit(_refresh, aid): aid for aid in resolved_ids}
            try:
                for future in as_completed(futures, timeout=timeout_seconds):
                    try:
                        item = future.result()
                    except Exception as exc:
                        item = {
                            "account_id": futures[future],
                            **_public_check_failure(exc),
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
                                **_public_check_failure(exc),
                            })
                    else:
                        timed_out += 1
                        results.append({
                            "account_id": aid,
                            "ok": False,
                            "valid": None,
                            "availability": "unchecked",
                            "detection_result": "inconclusive",
                            "type_observed": False,
                            "plan_detection_result": "inconclusive",
                            "plan_authority": "last_known",
                            "account_type_confidence": "none",
                            "status_code": "check_timeout",
                            "status_reason": "状态检测超时，已保留上次结果",
                            "status_retryable": True,
                            "status_source": "account-check/timeout",
                            "status_http": 0,
                            "status_evidence_path": "",
                            "status_checked_at": _checked_at(),
                            "error": "状态检测超时，已保留上次结果",
                        })

        return {
            "updated": updated,
            "items": results,
            "timed_out": timed_out,
        }
