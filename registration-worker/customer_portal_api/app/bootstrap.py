from __future__ import annotations

import json

from sqlmodel import Session, select

from app.catalog import CONFIG_DEFAULTS, PERMISSION_SEEDS, PLATFORM_SEEDS, ROLE_SEEDS
from app.config import settings
from app.db import engine, init_portal_db, utcnow
from app.models import (
    PortalConfig,
    PortalPermission,
    PortalPlatform,
    PortalProduct,
    PortalRole,
    PortalRolePermission,
    PortalUser,
)
from app.security import hash_password


def initialize_runtime() -> None:
    init_portal_db()
    with Session(engine) as session:
        _seed_permissions(session)
        _seed_roles(session)
        _seed_admin(session)
        _seed_platforms(session)
        _seed_configs(session)
        _seed_products(session)
        session.commit()


def shutdown_runtime() -> None:
    return


def _seed_permissions(session: Session) -> None:
    existing = {
        item.permission_code: item
        for item in session.exec(select(PortalPermission)).all()
    }
    for seed in PERMISSION_SEEDS:
        item = existing.get(seed["permission_code"])
        if item:
            item.permission_name = seed["permission_name"]
            session.add(item)
            continue
        session.add(
            PortalPermission(
                permission_code=seed["permission_code"],
                permission_name=seed["permission_name"],
                created_at=utcnow(),
            )
        )


def _seed_roles(session: Session) -> None:
    permissions = {
        item.permission_code: item
        for item in session.exec(select(PortalPermission)).all()
    }
    existing_roles = {
        item.role_code: item
        for item in session.exec(select(PortalRole)).all()
    }
    existing_pairs = {
        (item.role_id, item.permission_id)
        for item in session.exec(select(PortalRolePermission)).all()
    }
    for seed in ROLE_SEEDS:
        role = existing_roles.get(seed["role_code"])
        if role:
            role.role_name = seed["role_name"]
            role.updated_at = utcnow()
            session.add(role)
        else:
            role = PortalRole(
                role_code=seed["role_code"],
                role_name=seed["role_name"],
                created_at=utcnow(),
                updated_at=utcnow(),
            )
            session.add(role)
            session.flush()
        for permission_code in seed["permissions"]:
            permission = permissions.get(permission_code)
            if not permission:
                continue
            pair = (int(role.id or 0), int(permission.id or 0))
            if pair in existing_pairs:
                continue
            session.add(
                PortalRolePermission(
                    role_id=int(role.id or 0),
                    permission_id=int(permission.id or 0),
                    created_at=utcnow(),
                )
            )
            existing_pairs.add(pair)


def _seed_admin(session: Session) -> None:
    admin = session.exec(select(PortalUser).where(PortalUser.username == settings.seed_admin_username)).first()
    if admin:
        return
    session.add(
        PortalUser(
            username=settings.seed_admin_username,
            email=settings.seed_admin_email,
            password_hash=hash_password(settings.seed_admin_password),
            display_name="管理员",
            role_code="admin",
            status="active",
            created_at=utcnow(),
            updated_at=utcnow(),
        )
    )


def _seed_platforms(session: Session) -> None:
    existing = {
        item.platform_code: item
        for item in session.exec(select(PortalPlatform)).all()
    }
    for seed in PLATFORM_SEEDS:
        item = existing.get(seed["platform_code"])
        payload = {
            "display_name": seed["display_name"],
            "version": seed["version"],
            "status": "active",
            "supported_executors_json": json.dumps(seed["supported_executors"], ensure_ascii=False),
            "supported_identity_modes_json": json.dumps(seed["supported_identity_modes"], ensure_ascii=False),
            "supported_oauth_providers_json": json.dumps(seed["supported_oauth_providers"], ensure_ascii=False),
            "updated_at": utcnow(),
        }
        if item:
            for key, value in payload.items():
                setattr(item, key, value)
            session.add(item)
        else:
            session.add(
                PortalPlatform(
                    platform_code=seed["platform_code"],
                    created_at=utcnow(),
                    **payload,
                )
            )


def _seed_configs(session: Session) -> None:
    existing = {
        item.config_key: item
        for item in session.exec(select(PortalConfig)).all()
    }
    for key, value in CONFIG_DEFAULTS.items():
        item = existing.get(key)
        if item:
            continue
        session.add(
            PortalConfig(
                config_key=key,
                config_value=value,
                created_at=utcnow(),
                updated_at=utcnow(),
            )
        )


def _seed_products(session: Session) -> None:
    existing = {
        item.product_code: item
        for item in session.exec(select(PortalProduct)).all()
    }
    for platform in PLATFORM_SEEDS:
        product_code = f"{platform['platform_code']}_monthly"
        if product_code in existing:
            continue
        session.add(
            PortalProduct(
                product_code=product_code,
                platform_code=platform["platform_code"],
                product_name=f"{platform['display_name']} 月度订阅",
                amount=9.9,
                duration_days=30,
                status="active",
                metadata_json=json.dumps({"billing_cycle": "monthly"}, ensure_ascii=False),
                created_at=utcnow(),
                updated_at=utcnow(),
            )
        )
