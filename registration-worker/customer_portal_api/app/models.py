from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel

from app.db import utcnow


class PortalRole(SQLModel, table=True):
    __tablename__ = "portal_roles"

    id: Optional[int] = Field(default=None, primary_key=True)
    role_code: str = Field(index=True, unique=True)
    role_name: str
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalPermission(SQLModel, table=True):
    __tablename__ = "portal_permissions"

    id: Optional[int] = Field(default=None, primary_key=True)
    permission_code: str = Field(index=True, unique=True)
    permission_name: str
    created_at: datetime = Field(default_factory=utcnow)


class PortalRolePermission(SQLModel, table=True):
    __tablename__ = "portal_role_permissions"
    __table_args__ = (UniqueConstraint("role_id", "permission_id", name="uq_portal_role_permission"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    role_id: int = Field(index=True, foreign_key="portal_roles.id")
    permission_id: int = Field(index=True, foreign_key="portal_permissions.id")
    created_at: datetime = Field(default_factory=utcnow)


class PortalUser(SQLModel, table=True):
    __tablename__ = "portal_users"

    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    email: Optional[str] = Field(default=None, index=True, unique=True)
    mobile: Optional[str] = Field(default=None, index=True, unique=True)
    password_hash: str
    display_name: str = ""
    avatar_url: str = ""
    role_code: str = Field(default="user", index=True)
    status: str = Field(default="active", index=True)
    last_login_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class RefreshToken(SQLModel, table=True):
    __tablename__ = "portal_refresh_tokens"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True, foreign_key="portal_users.id")
    token_hash: str = Field(index=True, unique=True)
    expires_at: datetime
    revoked_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)


class PortalPlatform(SQLModel, table=True):
    __tablename__ = "portal_platforms"

    id: Optional[int] = Field(default=None, primary_key=True)
    platform_code: str = Field(index=True, unique=True)
    display_name: str
    version: str = "1.0.0"
    status: str = Field(default="active", index=True)
    supported_executors_json: str = "[]"
    supported_identity_modes_json: str = "[]"
    supported_oauth_providers_json: str = "[]"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalConfig(SQLModel, table=True):
    __tablename__ = "portal_configs"

    id: Optional[int] = Field(default=None, primary_key=True)
    config_key: str = Field(index=True, unique=True)
    config_value: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class UserPlatformAccess(SQLModel, table=True):
    __tablename__ = "portal_user_platform_access"
    __table_args__ = (UniqueConstraint("user_id", "platform_code", name="uq_portal_user_platform_access"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True, foreign_key="portal_users.id")
    platform_code: str = Field(index=True)
    source_type: str = Field(default="manual", index=True)
    source_ref: str = ""
    is_active: bool = True
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalProduct(SQLModel, table=True):
    __tablename__ = "portal_products"

    id: Optional[int] = Field(default=None, primary_key=True)
    product_code: str = Field(index=True, unique=True)
    platform_code: str = Field(index=True)
    product_name: str
    amount: float = 0.0
    duration_days: int = 30
    status: str = Field(default="active", index=True)
    metadata_json: str = "{}"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalOrder(SQLModel, table=True):
    __tablename__ = "portal_orders"

    id: Optional[int] = Field(default=None, primary_key=True)
    order_no: str = Field(index=True, unique=True)
    user_id: int = Field(index=True, foreign_key="portal_users.id")
    product_code: str = Field(index=True)
    platform_code: str = Field(index=True)
    product_name: str
    amount: float = 0.0
    status: str = Field(default="pending", index=True)
    metadata_json: str = "{}"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalPaymentRecord(SQLModel, table=True):
    __tablename__ = "portal_payment_records"

    id: Optional[int] = Field(default=None, primary_key=True)
    payment_no: str = Field(index=True, unique=True)
    order_no: str = Field(index=True)
    user_id: int = Field(index=True, foreign_key="portal_users.id")
    channel_code: str = Field(index=True)
    amount: float = 0.0
    status: str = Field(default="pending", index=True)
    channel_trade_no: str = ""
    payload_json: str = "{}"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalSubscription(SQLModel, table=True):
    __tablename__ = "portal_subscriptions"

    id: Optional[int] = Field(default=None, primary_key=True)
    subscription_no: str = Field(index=True, unique=True)
    user_id: int = Field(index=True, foreign_key="portal_users.id")
    platform_code: str = Field(index=True)
    product_code: str = Field(index=True)
    product_name: str
    status: str = Field(default="active", index=True)
    effective_at: datetime = Field(default_factory=utcnow)
    expired_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalTask(SQLModel, table=True):
    __tablename__ = "portal_tasks"

    id: str = Field(primary_key=True)
    owner_user_id: Optional[int] = Field(default=None, index=True, foreign_key="portal_users.id")
    source_channel: str = Field(default="system", index=True)
    type: str = Field(index=True)
    platform_code: str = Field(default="", index=True)
    status: str = Field(default="pending", index=True)
    payload_json: str = "{}"
    result_json: str = "{}"
    progress_current: int = 0
    progress_total: int = 0
    success_count: int = 0
    error_count: int = 0
    error: str = ""
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalTaskEvent(SQLModel, table=True):
    __tablename__ = "portal_task_events"

    id: Optional[int] = Field(default=None, primary_key=True)
    task_id: str = Field(index=True, foreign_key="portal_tasks.id")
    type: str = Field(default="log", index=True)
    level: str = "info"
    message: str = ""
    detail_json: str = "{}"
    created_at: datetime = Field(default_factory=utcnow)


class PortalTaskLog(SQLModel, table=True):
    __tablename__ = "portal_task_logs"

    id: Optional[int] = Field(default=None, primary_key=True)
    platform_code: str = Field(default="", index=True)
    email: str = ""
    status: str = Field(default="pending", index=True)
    error: str = ""
    detail_json: str = "{}"
    created_at: datetime = Field(default_factory=utcnow)


class PortalAccount(SQLModel, table=True):
    __tablename__ = "portal_accounts"

    id: Optional[int] = Field(default=None, primary_key=True)
    platform_code: str = Field(index=True)
    email: str = Field(index=True)
    password: str
    user_id: str = ""
    primary_token: str = ""
    trial_end_time: int = 0
    cashier_url: str = ""
    lifecycle_status: str = Field(default="registered", index=True)
    validity_status: str = Field(default="unknown", index=True)
    plan_state: str = Field(default="unknown", index=True)
    plan_name: str = ""
    display_status: str = Field(default="registered", index=True)
    overview_json: str = "{}"
    credentials_json: str = "{}"
    provider_accounts_json: str = "[]"
    provider_resources_json: str = "[]"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PortalProxy(SQLModel, table=True):
    __tablename__ = "portal_proxies"

    id: Optional[int] = Field(default=None, primary_key=True)
    url: str = Field(index=True, unique=True)
    region: str = ""
    success_count: int = 0
    fail_count: int = 0
    is_active: bool = True
    last_checked: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
