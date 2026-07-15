"""SMS 号码池黑名单仓储。

- 用于持久化已被多次 OTP 验证测试 / 触发 PayPal 风控（如 OAS_ERROR）的号码；
- 后续从前端 sms_pool 文本拉到运行时号码池时，会先经过 :meth:`SmsPoolBlacklistRepository.filter_pool`
  过滤掉黑名单中的号码；
- 由 API 路由 /api/sms-pool/blacklist 暴露查询、手动新增、恢复等操作。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import urlparse

from sqlmodel import Session, select

from core.db import SmsPoolBlacklistModel, engine


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _extract_host(url: str) -> str:
    try:
        parsed = urlparse((url or "").strip())
        return (parsed.hostname or "").lower()
    except Exception:
        return ""


def _normalize_phone(phone: str) -> str:
    """统一 phone 表示：保留 + 前缀，仅保留数字。"""
    raw = (phone or "").strip()
    if not raw:
        return ""
    has_plus = raw.startswith("+")
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return ""
    return ("+" + digits) if has_plus else digits


@dataclass
class SmsBlacklistRecord:
    id: int
    phone_e164: str
    relay_url: str
    relay_host: str
    reason: str
    error_code: str
    task_id: str
    fail_count: int
    last_error_message: str
    created_at: datetime
    last_attempted_at: datetime

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "phone_e164": self.phone_e164,
            "relay_url": self.relay_url,
            "relay_host": self.relay_host,
            "reason": self.reason,
            "error_code": self.error_code,
            "task_id": self.task_id,
            "fail_count": self.fail_count,
            "last_error_message": self.last_error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_attempted_at": (
                self.last_attempted_at.isoformat() if self.last_attempted_at else None
            ),
        }


def _to_record(model: SmsPoolBlacklistModel) -> SmsBlacklistRecord:
    return SmsBlacklistRecord(
        id=int(model.id or 0),
        phone_e164=model.phone_e164,
        relay_url=model.relay_url or "",
        relay_host=model.relay_host or "",
        reason=model.reason or "",
        error_code=model.error_code or "",
        task_id=model.task_id or "",
        fail_count=int(model.fail_count or 0),
        last_error_message=model.last_error_message or "",
        created_at=model.created_at,
        last_attempted_at=model.last_attempted_at,
    )


class SmsPoolBlacklistRepository:
    """SMS 号码池黑名单的轻量仓储；线程安全依赖底层 SQLModel/SQLAlchemy session。"""

    def list(self) -> list[SmsBlacklistRecord]:
        with Session(engine) as session:
            items = session.exec(
                select(SmsPoolBlacklistModel).order_by(
                    SmsPoolBlacklistModel.last_attempted_at.desc()
                )
            ).all()
        return [_to_record(item) for item in items]

    def get(self, phone: str) -> SmsBlacklistRecord | None:
        phone_norm = _normalize_phone(phone)
        if not phone_norm:
            return None
        with Session(engine) as session:
            model = session.exec(
                select(SmsPoolBlacklistModel).where(
                    SmsPoolBlacklistModel.phone_e164 == phone_norm
                )
            ).first()
        return _to_record(model) if model else None

    def is_blacklisted(self, phone: str) -> bool:
        return self.get(phone) is not None

    def blacklisted_phones(self) -> set[str]:
        """返回当前所有黑名单 phone 集合（含 + 前缀）。"""
        with Session(engine) as session:
            items = session.exec(
                select(SmsPoolBlacklistModel.phone_e164)
            ).all()
        return {_normalize_phone(str(item)) for item in items if item}

    def add(
        self,
        *,
        phone: str,
        relay_url: str = "",
        reason: str = "manual",
        error_code: str = "",
        task_id: str = "",
        error_message: str = "",
    ) -> SmsBlacklistRecord | None:
        """新增或更新一条黑名单记录。

        - 已存在相同 phone 时：fail_count +1、刷新 last_attempted_at、合并最新 reason/error_code。
        """
        phone_norm = _normalize_phone(phone)
        if not phone_norm:
            return None
        now = _utcnow()
        with Session(engine) as session:
            existing = session.exec(
                select(SmsPoolBlacklistModel).where(
                    SmsPoolBlacklistModel.phone_e164 == phone_norm
                )
            ).first()
            if existing is None:
                model = SmsPoolBlacklistModel(
                    phone_e164=phone_norm,
                    relay_url=(relay_url or "").strip(),
                    relay_host=_extract_host(relay_url),
                    reason=(reason or "").strip() or "manual",
                    error_code=(error_code or "").strip(),
                    task_id=(task_id or "").strip(),
                    fail_count=1,
                    last_error_message=(error_message or "").strip()[:500],
                    created_at=now,
                    last_attempted_at=now,
                )
                session.add(model)
                session.commit()
                session.refresh(model)
                return _to_record(model)
            existing.fail_count = int(existing.fail_count or 0) + 1
            existing.last_attempted_at = now
            if relay_url:
                existing.relay_url = relay_url.strip()
                existing.relay_host = _extract_host(relay_url)
            if reason:
                existing.reason = reason.strip()
            if error_code:
                existing.error_code = error_code.strip()
            if task_id:
                existing.task_id = task_id.strip()
            if error_message:
                existing.last_error_message = error_message.strip()[:500]
            session.add(existing)
            session.commit()
            session.refresh(existing)
            return _to_record(existing)

    def remove(self, phone: str) -> bool:
        phone_norm = _normalize_phone(phone)
        if not phone_norm:
            return False
        with Session(engine) as session:
            model = session.exec(
                select(SmsPoolBlacklistModel).where(
                    SmsPoolBlacklistModel.phone_e164 == phone_norm
                )
            ).first()
            if not model:
                return False
            session.delete(model)
            session.commit()
            return True

    def clear(self) -> int:
        with Session(engine) as session:
            items = session.exec(select(SmsPoolBlacklistModel)).all()
            count = 0
            for item in items:
                session.delete(item)
                count += 1
            session.commit()
        return count

    def filter_pool(
        self,
        pool: Iterable[dict],
    ) -> tuple[list[dict], list[dict]]:
        """从 ``pool`` 中过滤掉已被黑名单的条目。

        ``pool`` 每项形如 ``{"phone_e164": "+1xxx", ...}`` （parse_sms_pool 的返回结构）。
        返回 ``(kept, skipped)``：保持 ``pool`` 中原始顺序，``skipped`` 项会附上对应的 blacklist 记录摘要。
        """
        blacklist = self.blacklisted_phones()
        if not blacklist:
            return list(pool), []
        kept: list[dict] = []
        skipped: list[dict] = []
        for entry in pool:
            phone = _normalize_phone(str(entry.get("phone_e164") or entry.get("phone") or ""))
            if phone and phone in blacklist:
                skipped.append({**entry, "skipped_reason": "blacklisted"})
            else:
                kept.append(entry)
        return kept, skipped
