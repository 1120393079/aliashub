from __future__ import annotations

from sqlmodel import Session, select

from core.db import ProxyModel, engine
from domain.proxies import ProxyCreateCommand, ProxyRecord


def _to_record(model: ProxyModel) -> ProxyRecord:
    return ProxyRecord(
        id=int(model.id or 0),
        url=model.url,
        region=model.region,
        success_count=model.success_count,
        fail_count=model.fail_count,
        is_active=bool(model.is_active),
        last_checked=model.last_checked,
    )


class ProxiesRepository:
    def list(self) -> list[ProxyRecord]:
        with Session(engine) as session:
            items = session.exec(select(ProxyModel)).all()
        return [_to_record(item) for item in items]

    def create(self, command: ProxyCreateCommand) -> ProxyRecord | None:
        with Session(engine) as session:
            existing = session.exec(select(ProxyModel).where(ProxyModel.url == command.url)).first()
            if existing:
                return None
            model = ProxyModel(url=command.url, region=command.region)
            session.add(model)
            session.commit()
            session.refresh(model)
            return _to_record(model)

    def bulk_create(self, urls: list[str], region: str = "") -> int:
        added = 0
        with Session(engine) as session:
            for raw in urls:
                url = raw.strip()
                if not url:
                    continue
                existing = session.exec(select(ProxyModel).where(ProxyModel.url == url)).first()
                if existing:
                    continue
                session.add(ProxyModel(url=url, region=region))
                added += 1
            session.commit()
        return added

    def delete(self, proxy_id: int) -> bool:
        with Session(engine) as session:
            model = session.get(ProxyModel, proxy_id)
            if not model:
                return False
            session.delete(model)
            session.commit()
            return True

    def toggle(self, proxy_id: int) -> bool | None:
        with Session(engine) as session:
            model = session.get(ProxyModel, proxy_id)
            if not model:
                return None
            model.is_active = not model.is_active
            session.add(model)
            session.commit()
            session.refresh(model)
            return bool(model.is_active)
