from __future__ import annotations

import csv
import io
import json
import uuid
import zipfile
from datetime import timedelta
from typing import Any

from fastapi import HTTPException, status
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from app.catalog import collect_platform_choice_options, platform_payload
from app.db import utcnow
from app.models import (
    PortalAccount,
    PortalConfig,
    PortalOrder,
    PortalPaymentRecord,
    PortalPermission,
    PortalPlatform,
    PortalProduct,
    PortalProxy,
    PortalRole,
    PortalRolePermission,
    PortalSubscription,
    PortalTask,
    PortalTaskEvent,
    PortalTaskLog,
    PortalUser,
    UserPlatformAccess,
)
from app.security import hash_password


TASK_TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}


class PortalService:
    def __init__(self, session: Session):
        self.session = session

    def list_products(self, user: PortalUser | None = None) -> dict:
        items = self.session.exec(
            select(PortalProduct).where(PortalProduct.status == "active").order_by(PortalProduct.platform_code, PortalProduct.product_code)
        ).all()
        return {"total": len(items), "items": [self._serialize_product(item) for item in items]}

    def list_app_platforms(self, user: PortalUser) -> list[dict]:
        all_platforms = self.list_platforms()
        if user.role_code == "admin":
            return all_platforms
        allowed = set(self._active_platform_codes(user.id))
        return [item for item in all_platforms if item["name"] in allowed]

    def get_app_config_options(self, user: PortalUser) -> dict:
        platforms = self.list_app_platforms(user)
        return {
            "mailbox_providers": [],
            "captcha_providers": [],
            "sms_providers": [],
            "mailbox_drivers": [],
            "captcha_drivers": [],
            "sms_drivers": [],
            "mailbox_settings": [],
            "captcha_settings": [],
            "sms_settings": [],
            "captcha_policy": {
                "protocol_mode": "manual",
                "protocol_order": [],
                "browser_mode": "",
            },
            **collect_platform_choice_options(platforms),
        }

    def create_app_register_task(self, user: PortalUser, payload: dict[str, Any]) -> dict:
        platform = str(payload.get("platform", "") or "")
        if not platform:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="缺少 platform")
        if user.role_code != "admin" and platform not in self._active_platform_codes(user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前用户无该平台注册权限")
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="独立版暂未实现注册任务")

    def create_admin_register_task(self, payload: dict[str, Any]) -> dict:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="独立版暂未实现注册任务")

    def list_app_tasks(self, user: PortalUser, *, platform: str = "", status_value: str = "", page: int = 1, page_size: int = 50) -> dict:
        query = select(PortalTask).where(PortalTask.owner_user_id == int(user.id or 0)).order_by(PortalTask.created_at.desc())
        items = self.session.exec(query).all()
        return self._paginate_tasks(items, platform=platform, status_value=status_value, page=page, page_size=page_size)

    def get_app_task(self, user: PortalUser, task_id: str) -> dict:
        task = self.session.get(PortalTask, task_id)
        if not task or int(task.owner_user_id or 0) != int(user.id or 0):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
        return self._serialize_task(task)

    def list_app_task_events(self, user: PortalUser, task_id: str, *, since: int = 0, limit: int = 200) -> dict:
        self.get_app_task(user, task_id)
        return self.list_task_events(task_id, since=since, limit=limit)

    async def stream_app_task_events(self, user: PortalUser, task_id: str, *, since: int = 0):
        self.get_app_task(user, task_id)
        return self._stream_task_events(task_id, since=since)

    def get_profile(self, user: PortalUser) -> dict:
        return self._serialize_user(user, include_platforms=True)

    def update_profile(self, user: PortalUser, data: dict[str, Any]) -> dict:
        if "display_name" in data and data["display_name"] is not None:
            user.display_name = str(data["display_name"])
        if "avatar_url" in data and data["avatar_url"] is not None:
            user.avatar_url = str(data["avatar_url"])
        if "email" in data:
            self._ensure_unique_fields(email=data["email"] or None, exclude_user_id=int(user.id or 0))
            user.email = data["email"] or None
        if "mobile" in data:
            self._ensure_unique_fields(mobile=data["mobile"] or None, exclude_user_id=int(user.id or 0))
            user.mobile = data["mobile"] or None
        user.updated_at = utcnow()
        self.session.add(user)
        self.session.commit()
        self.session.refresh(user)
        return self._serialize_user(user, include_platforms=True)

    def list_orders(self, user: PortalUser) -> dict:
        items = self.session.exec(
            select(PortalOrder).where(PortalOrder.user_id == int(user.id or 0)).order_by(PortalOrder.created_at.desc())
        ).all()
        return {"total": len(items), "items": [self._serialize_order(item) for item in items]}

    def get_order(self, user: PortalUser, order_no: str) -> dict:
        item = self.session.exec(
            select(PortalOrder).where(PortalOrder.user_id == int(user.id or 0), PortalOrder.order_no == order_no)
        ).first()
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="订单不存在")
        return self._serialize_order(item)

    def list_subscriptions(self, user: PortalUser) -> dict:
        items = self.session.exec(
            select(PortalSubscription).where(PortalSubscription.user_id == int(user.id or 0)).order_by(PortalSubscription.created_at.desc())
        ).all()
        return {"total": len(items), "items": [self._serialize_subscription(item) for item in items]}

    def create_order(self, user: PortalUser, data: dict[str, Any]) -> dict:
        product_code = str(data.get("product_code", "") or "")
        quantity = max(int(data.get("quantity", 1) or 1), 1)
        product = self.session.exec(
            select(PortalProduct).where(PortalProduct.product_code == product_code, PortalProduct.status == "active")
        ).first()
        if not product:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="商品不存在")
        order = PortalOrder(
            order_no=self._make_no("ord"),
            user_id=int(user.id or 0),
            product_code=product.product_code,
            platform_code=product.platform_code,
            product_name=product.product_name,
            amount=round(float(product.amount) * quantity, 2),
            status="pending",
            metadata_json=json.dumps(
                {
                    "product_code": product.product_code,
                    "quantity": quantity,
                    "duration_days": product.duration_days,
                },
                ensure_ascii=False,
            ),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        self.session.add(order)
        self.session.commit()
        self.session.refresh(order)
        return self._serialize_order(order)

    def submit_payment(self, user: PortalUser, order_no: str, data: dict[str, Any]) -> dict:
        order = self.session.exec(
            select(PortalOrder).where(PortalOrder.order_no == order_no, PortalOrder.user_id == int(user.id or 0))
        ).first()
        if not order:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="订单不存在")
        if order.status not in {"pending", "failed"}:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="当前订单状态不允许发起支付")
        payment = PortalPaymentRecord(
            payment_no=self._make_no("pay"),
            order_no=order.order_no,
            user_id=int(user.id or 0),
            channel_code=str(data.get("channel_code", "") or "mock"),
            amount=order.amount,
            status="submitted",
            payload_json=json.dumps({"submitted_by": int(user.id or 0)}, ensure_ascii=False),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        self.session.add(payment)
        self.session.commit()
        self.session.refresh(payment)
        return self._serialize_payment(
            payment,
            extra={"pay_url": f"https://pay.local/{payment.channel_code}/{payment.payment_no}"},
        )

    def handle_payment_callback(self, channel_code: str, data: dict[str, Any]) -> dict:
        payment = None
        payment_no = str(data.get("payment_no", "") or "")
        order_no = str(data.get("order_no", "") or "")
        if payment_no:
            payment = self.session.exec(select(PortalPaymentRecord).where(PortalPaymentRecord.payment_no == payment_no)).first()
        elif order_no:
            payment = self.session.exec(
                select(PortalPaymentRecord).where(PortalPaymentRecord.order_no == order_no).order_by(PortalPaymentRecord.created_at.desc())
            ).first()
        if not payment:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="支付单不存在")
        order = self.session.exec(select(PortalOrder).where(PortalOrder.order_no == payment.order_no)).first()
        if not order:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="订单不存在")
        callback_status = str(data.get("status", "") or "success").lower()
        if payment.status == "success" and callback_status in {"success", "paid"}:
            return {"ok": True, "payment": self._serialize_payment(payment), "order": self._serialize_order(order)}
        payment.channel_code = channel_code or payment.channel_code
        payment.channel_trade_no = str(data.get("channel_trade_no", "") or payment.channel_trade_no)
        payment.payload_json = json.dumps(data or {}, ensure_ascii=False)
        payment.updated_at = utcnow()
        if callback_status in {"success", "paid"}:
            payment.status = "success"
            order.status = "paid"
            self._activate_subscription(order)
        elif callback_status in {"failed", "closed", "cancelled"}:
            payment.status = "failed" if callback_status == "failed" else "closed"
            order.status = "failed" if callback_status == "failed" else "closed"
        else:
            payment.status = callback_status
        order.updated_at = utcnow()
        self.session.add(payment)
        self.session.add(order)
        self.session.commit()
        self.session.refresh(payment)
        self.session.refresh(order)
        return {"ok": True, "payment": self._serialize_payment(payment), "order": self._serialize_order(order)}

    def list_roles(self) -> dict:
        roles = self.session.exec(select(PortalRole).order_by(PortalRole.role_code)).all()
        return {
            "items": [
                {
                    "role_code": item.role_code,
                    "role_name": item.role_name,
                    "permissions": self._permissions_for_role(item.role_code),
                }
                for item in roles
            ]
        }

    def list_permissions(self) -> dict:
        items = self.session.exec(select(PortalPermission).order_by(PortalPermission.permission_code)).all()
        return {
            "items": [
                {
                    "permission_code": item.permission_code,
                    "permission_name": item.permission_name,
                }
                for item in items
            ]
        }

    def list_users(self, *, keyword: str = "", role_code: str = "", status_value: str = "") -> dict:
        items = self.session.exec(select(PortalUser).order_by(PortalUser.created_at.desc())).all()
        result = []
        for item in items:
            if keyword:
                target = " ".join(filter(None, [item.username, item.email or "", item.mobile or "", item.display_name or ""]))
                if keyword.lower() not in target.lower():
                    continue
            if role_code and item.role_code != role_code:
                continue
            if status_value and item.status != status_value:
                continue
            result.append(self._serialize_user(item, include_platforms=True))
        return {"total": len(result), "items": result}

    def create_user(self, data: dict[str, Any]) -> dict:
        username = str(data.get("username", "") or "").strip()
        password = str(data.get("password", "") or "")
        if not username or not password:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="username 和 password 必填")
        if self.session.exec(select(PortalUser).where(PortalUser.username == username)).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="用户名已存在")
        self._ensure_unique_fields(email=data.get("email") or None, mobile=data.get("mobile") or None)
        user = PortalUser(
            username=username,
            email=data.get("email") or None,
            mobile=data.get("mobile") or None,
            password_hash=hash_password(password),
            display_name=str(data.get("display_name") or username),
            avatar_url=str(data.get("avatar_url") or ""),
            role_code=str(data.get("role_code") or "user"),
            status=str(data.get("status") or "active"),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        self.session.add(user)
        self.session.commit()
        self.session.refresh(user)
        self.set_user_platform_access(int(user.id or 0), [str(item) for item in (data.get("platform_codes") or [])])
        return self._serialize_user(user, include_platforms=True)

    def update_user(self, user_id: int, data: dict[str, Any]) -> dict:
        user = self.session.get(PortalUser, user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
        if "email" in data:
            self._ensure_unique_fields(email=data["email"] or None, exclude_user_id=user_id)
            user.email = data["email"] or None
        if "mobile" in data:
            self._ensure_unique_fields(mobile=data["mobile"] or None, exclude_user_id=user_id)
            user.mobile = data["mobile"] or None
        for field in ("display_name", "avatar_url", "role_code", "status"):
            if field in data and data[field] is not None:
                setattr(user, field, data[field] or "")
        if data.get("password"):
            user.password_hash = hash_password(str(data["password"]))
        user.updated_at = utcnow()
        self.session.add(user)
        self.session.commit()
        self.session.refresh(user)
        if "platform_codes" in data and isinstance(data["platform_codes"], list):
            self.set_user_platform_access(user_id, [str(item) for item in data["platform_codes"]])
        return self._serialize_user(user, include_platforms=True)

    def get_user_platform_access(self, user_id: int) -> dict:
        self._require_user(user_id)
        rows = self.session.exec(
            select(UserPlatformAccess).where(UserPlatformAccess.user_id == user_id, UserPlatformAccess.is_active == True).order_by(UserPlatformAccess.platform_code)
        ).all()
        return {"user_id": user_id, "platform_codes": [item.platform_code for item in rows]}

    def set_user_platform_access(self, user_id: int, platform_codes: list[str]) -> dict:
        self._require_user(user_id)
        normalized = sorted({code for code in platform_codes if code})
        existing = self.session.exec(select(UserPlatformAccess).where(UserPlatformAccess.user_id == user_id)).all()
        by_code = {item.platform_code: item for item in existing}
        for code, row in by_code.items():
            if code not in normalized:
                self.session.delete(row)
        for code in normalized:
            row = by_code.get(code)
            if row:
                row.is_active = True
                row.updated_at = utcnow()
                row.source_type = row.source_type or "manual"
                self.session.add(row)
            else:
                self.session.add(
                    UserPlatformAccess(
                        user_id=user_id,
                        platform_code=code,
                        source_type="manual",
                        source_ref="admin",
                        is_active=True,
                        created_at=utcnow(),
                        updated_at=utcnow(),
                    )
                )
        self.session.commit()
        return self.get_user_platform_access(user_id)

    def remove_user_platform_access(self, user_id: int, platform_code: str) -> dict:
        row = self.session.exec(
            select(UserPlatformAccess).where(UserPlatformAccess.user_id == user_id, UserPlatformAccess.platform_code == platform_code)
        ).first()
        if not row:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="平台授权不存在")
        self.session.delete(row)
        self.session.commit()
        return {"ok": True}

    def list_platforms(self) -> list[dict]:
        rows = self.session.exec(select(PortalPlatform).where(PortalPlatform.status == "active").order_by(PortalPlatform.platform_code)).all()
        return [self._serialize_platform(item) for item in rows]

    def get_desktop_state(self, platform: str) -> dict:
        self._require_platform(platform)
        return {"platform": platform, "installed": False, "running": False, "supported": False}

    def get_config(self) -> dict[str, str]:
        rows = self.session.exec(select(PortalConfig).order_by(PortalConfig.config_key)).all()
        return {item.config_key: item.config_value for item in rows}

    def update_config(self, data: dict[str, str]) -> dict:
        updated: dict[str, str] = {}
        for key, value in data.items():
            row = self.session.exec(select(PortalConfig).where(PortalConfig.config_key == key)).first()
            if row:
                row.config_value = str(value)
                row.updated_at = utcnow()
                self.session.add(row)
            else:
                self.session.add(
                    PortalConfig(
                        config_key=key,
                        config_value=str(value),
                        created_at=utcnow(),
                        updated_at=utcnow(),
                    )
                )
            updated[key] = str(value)
        self.session.commit()
        return {"ok": True, "updated": updated}

    def get_config_options(self) -> dict:
        platforms = self.list_platforms()
        return {
            "mailbox_providers": [],
            "captcha_providers": [],
            "sms_providers": [],
            "mailbox_drivers": [],
            "captcha_drivers": [],
            "sms_drivers": [],
            "mailbox_settings": [],
            "captcha_settings": [],
            "sms_settings": [],
            "captcha_policy": {
                "protocol_mode": "manual",
                "protocol_order": [],
                "browser_mode": "",
            },
            **collect_platform_choice_options(platforms),
        }

    def list_tasks(self, *, platform: str = "", status_value: str = "", page: int = 1, page_size: int = 50) -> dict:
        items = self.session.exec(select(PortalTask).order_by(PortalTask.created_at.desc())).all()
        return self._paginate_tasks(items, platform=platform, status_value=status_value, page=page, page_size=page_size)

    def get_task(self, task_id: str) -> dict:
        task = self.session.get(PortalTask, task_id)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
        return self._serialize_task(task)

    def list_task_events(self, task_id: str, *, since: int = 0, limit: int = 200) -> dict:
        self.get_task(task_id)
        rows = self.session.exec(
            select(PortalTaskEvent)
            .where(PortalTaskEvent.task_id == task_id, PortalTaskEvent.id > since)
            .order_by(PortalTaskEvent.id)
            .limit(limit)
        ).all()
        return {"items": [self._serialize_task_event(item) for item in rows]}

    async def stream_task_events(self, task_id: str, *, since: int = 0):
        self.get_task(task_id)
        return self._stream_task_events(task_id, since=since)

    def cancel_task(self, task_id: str) -> dict:
        task = self.session.get(PortalTask, task_id)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务不存在")
        if task.status in TASK_TERMINAL_STATUSES:
            return self._serialize_task(task)
        task.status = "cancelled"
        task.error = task.error or "任务已取消"
        task.finished_at = utcnow()
        task.updated_at = utcnow()
        self.session.add(task)
        self.session.add(
            PortalTaskEvent(
                task_id=task.id,
                type="state",
                level="warning",
                message="任务已取消",
                detail_json="{}",
                created_at=utcnow(),
            )
        )
        self.session.commit()
        self.session.refresh(task)
        return self._serialize_task(task)

    def list_task_logs(self, *, platform: str = "", page: int = 1, page_size: int = 50) -> dict:
        rows = self.session.exec(select(PortalTaskLog).order_by(PortalTaskLog.created_at.desc())).all()
        if platform:
            rows = [item for item in rows if item.platform_code == platform]
        page = max(page, 1)
        page_size = min(max(page_size, 1), 200)
        start = (page - 1) * page_size
        end = start + page_size
        return {
            "total": len(rows),
            "page": page,
            "items": [self._serialize_task_log(item) for item in rows[start:end]],
        }

    def list_accounts(self, *, platform: str = "", status_value: str = "", email: str = "", page: int = 1, page_size: int = 20) -> dict:
        rows = self.session.exec(select(PortalAccount).order_by(PortalAccount.created_at.desc())).all()
        result = []
        for item in rows:
            if platform and item.platform_code != platform:
                continue
            if status_value and item.display_status != status_value and item.lifecycle_status != status_value:
                continue
            if email and email.lower() not in item.email.lower():
                continue
            result.append(self._serialize_account(item))
        page = max(page, 1)
        page_size = min(max(page_size, 1), 200)
        start = (page - 1) * page_size
        end = start + page_size
        return {"total": len(result), "page": page, "items": result[start:end]}

    def get_account(self, account_id: int) -> dict:
        item = self.session.get(PortalAccount, account_id)
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")
        return self._serialize_account(item)

    def create_account(self, data: dict[str, Any]) -> dict:
        platform_code = str(data.get("platform", "") or data.get("platform_code", "") or "")
        email = str(data.get("email", "") or "").strip()
        password = str(data.get("password", "") or "")
        if not platform_code or not email or not password:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="platform、email、password 必填")
        self._require_platform(platform_code)
        item = PortalAccount(
            platform_code=platform_code,
            email=email,
            password=password,
            user_id=str(data.get("user_id", "") or ""),
            primary_token=str(data.get("primary_token", "") or ""),
            trial_end_time=int(data.get("trial_end_time", 0) or 0),
            cashier_url=str(data.get("cashier_url", "") or ""),
            lifecycle_status=str(data.get("lifecycle_status", "registered") or "registered"),
            validity_status=str(data.get("validity_status", "unknown") or "unknown"),
            plan_state=str(data.get("plan_state", "unknown") or "unknown"),
            plan_name=str(data.get("plan_name", "") or ""),
            display_status=str(data.get("display_status", data.get("lifecycle_status", "registered")) or "registered"),
            overview_json=json.dumps(data.get("overview") or {}, ensure_ascii=False),
            credentials_json=json.dumps(data.get("credentials") or {}, ensure_ascii=False),
            provider_accounts_json=json.dumps(data.get("provider_accounts") or [], ensure_ascii=False),
            provider_resources_json=json.dumps(data.get("provider_resources") or [], ensure_ascii=False),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        self.session.add(item)
        self.session.commit()
        self.session.refresh(item)
        return self._serialize_account(item)

    def update_account(self, account_id: int, data: dict[str, Any]) -> dict:
        item = self.session.get(PortalAccount, account_id)
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")
        mapping = {
            "password": "password",
            "user_id": "user_id",
            "primary_token": "primary_token",
            "cashier_url": "cashier_url",
            "lifecycle_status": "lifecycle_status",
            "validity_status": "validity_status",
            "plan_state": "plan_state",
            "plan_name": "plan_name",
            "display_status": "display_status",
            "trial_end_time": "trial_end_time",
        }
        for source_key, target_key in mapping.items():
            if source_key in data and data[source_key] is not None:
                setattr(item, target_key, data[source_key])
        if "overview" in data and data["overview"] is not None:
            item.overview_json = json.dumps(data["overview"], ensure_ascii=False)
        if "credentials" in data and data["credentials"] is not None:
            item.credentials_json = json.dumps(data["credentials"], ensure_ascii=False)
        if "provider_accounts" in data and data["provider_accounts"] is not None:
            item.provider_accounts_json = json.dumps(data["provider_accounts"], ensure_ascii=False)
        if "provider_resources" in data and data["provider_resources"] is not None:
            item.provider_resources_json = json.dumps(data["provider_resources"], ensure_ascii=False)
        item.updated_at = utcnow()
        self.session.add(item)
        self.session.commit()
        self.session.refresh(item)
        return self._serialize_account(item)

    def delete_account(self, account_id: int) -> dict:
        item = self.session.get(PortalAccount, account_id)
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")
        self.session.delete(item)
        self.session.commit()
        return {"ok": True}

    def get_account_stats(self) -> dict:
        rows = self.session.exec(select(PortalAccount)).all()
        by_platform: dict[str, int] = {}
        by_status: dict[str, int] = {}
        by_lifecycle_status: dict[str, int] = {}
        by_plan_state: dict[str, int] = {}
        by_validity_status: dict[str, int] = {}
        by_display_status: dict[str, int] = {}
        for item in rows:
            by_platform[item.platform_code] = by_platform.get(item.platform_code, 0) + 1
            by_status[item.display_status] = by_status.get(item.display_status, 0) + 1
            by_lifecycle_status[item.lifecycle_status] = by_lifecycle_status.get(item.lifecycle_status, 0) + 1
            by_plan_state[item.plan_state] = by_plan_state.get(item.plan_state, 0) + 1
            by_validity_status[item.validity_status] = by_validity_status.get(item.validity_status, 0) + 1
            by_display_status[item.display_status] = by_display_status.get(item.display_status, 0) + 1
        return {
            "total": len(rows),
            "by_platform": by_platform,
            "by_status": by_status,
            "by_lifecycle_status": by_lifecycle_status,
            "by_plan_state": by_plan_state,
            "by_validity_status": by_validity_status,
            "by_display_status": by_display_status,
        }

    def import_accounts(self, platform: str, lines: list[str]) -> dict:
        self._require_platform(platform)
        created = 0
        for raw in lines:
            line = str(raw or "").strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            self.create_account({"platform": platform, "email": parts[0], "password": parts[1]})
            created += 1
        return {"created": created}

    def export_accounts_csv_stream(self, *, platform: str = "", status_value: str = "") -> StreamingResponse:
        rows = self.list_accounts(platform=platform, status_value=status_value, page=1, page_size=100000)["items"]
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["ID", "Platform", "Email", "Password", "Status", "Plan State", "Created At"])
        for item in rows:
            writer.writerow([item["id"], item["platform"], item["email"], item["password"], item["display_status"], item["plan_state"], item["created_at"] or ""])
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=accounts.csv"},
        )

    def export_accounts_json(self, data: dict[str, Any]) -> StreamingResponse:
        rows = self._select_accounts_for_export(data)
        content = json.dumps(rows, ensure_ascii=False, indent=2)
        return self._stream_bytes(content.encode("utf-8"), "application/json", "accounts.json")

    def export_accounts_csv_zip(self, data: dict[str, Any]) -> StreamingResponse:
        rows = self._select_accounts_for_export(data)
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["email", "password", "platform", "user_id", "status"])
        for item in rows:
            writer.writerow([item["email"], item["password"], item["platform"], item["user_id"], item["display_status"]])
        return self._stream_bytes(output.getvalue().encode("utf-8"), "text/csv", "accounts.csv")

    def export_accounts_sub2api(self, data: dict[str, Any]) -> StreamingResponse:
        rows = self._select_accounts_for_export(data)
        if len(rows) == 1:
            item = rows[0]
            content = json.dumps(
                {
                    "accounts": [
                        {
                            "name": item["email"],
                            "platform": item["platform"],
                            "credentials": {
                                "access_token": item["primary_token"],
                            },
                        }
                    ]
                },
                ensure_ascii=False,
                indent=2,
            ).encode("utf-8")
            return self._stream_bytes(content, "application/json", f"{item['email']}_sub2api.json")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for item in rows:
                archive.writestr(
                    f"{item['email']}_sub2api.json",
                    json.dumps({"accounts": [{"name": item["email"], "platform": item["platform"], "credentials": {"access_token": item["primary_token"]}}]}, ensure_ascii=False, indent=2),
                )
        buffer.seek(0)
        return self._stream_buffer(buffer, "application/zip", "sub2api_tokens.zip")

    def export_accounts_cpa(self, data: dict[str, Any]) -> StreamingResponse:
        rows = self._select_accounts_for_export(data)
        if len(rows) == 1:
            item = rows[0]
            content = json.dumps(
                {
                    "email": item["email"],
                    "access_token": item["primary_token"],
                    "refresh_token": "",
                    "id_token": "",
                },
                ensure_ascii=False,
                indent=2,
            ).encode("utf-8")
            return self._stream_bytes(content, "application/json", f"{item['email']}.json")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for item in rows:
                archive.writestr(
                    f"{item['email']}.json",
                    json.dumps({"email": item["email"], "access_token": item["primary_token"], "refresh_token": "", "id_token": ""}, ensure_ascii=False, indent=2),
                )
        buffer.seek(0)
        return self._stream_buffer(buffer, "application/zip", "cpa_tokens.zip")

    def list_actions(self, platform: str) -> dict:
        self._require_platform(platform)
        return {"actions": []}

    def execute_action(self, platform: str, account_id: int, action_id: str, params: dict[str, Any]) -> dict:
        self._require_platform(platform)
        self.get_account(account_id)
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="独立版暂未实现平台动作")

    def list_proxies(self) -> list[dict]:
        rows = self.session.exec(select(PortalProxy).order_by(PortalProxy.created_at.desc())).all()
        return [self._serialize_proxy(item) for item in rows]

    def create_proxy(self, url: str, region: str = "") -> dict:
        existing = self.session.exec(select(PortalProxy).where(PortalProxy.url == url)).first()
        if existing:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="代理已存在")
        item = PortalProxy(url=url, region=region, created_at=utcnow(), updated_at=utcnow())
        self.session.add(item)
        self.session.commit()
        self.session.refresh(item)
        return self._serialize_proxy(item)

    def bulk_create_proxies(self, proxies: list[str], region: str = "") -> dict:
        added = 0
        for url in proxies:
            url = str(url or "").strip()
            if not url:
                continue
            exists = self.session.exec(select(PortalProxy).where(PortalProxy.url == url)).first()
            if exists:
                continue
            self.session.add(PortalProxy(url=url, region=region, created_at=utcnow(), updated_at=utcnow()))
            added += 1
        self.session.commit()
        return {"added": added}

    def delete_proxy(self, proxy_id: int) -> dict:
        item = self.session.get(PortalProxy, proxy_id)
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="代理不存在")
        self.session.delete(item)
        self.session.commit()
        return {"ok": True}

    def toggle_proxy(self, proxy_id: int) -> dict:
        item = self.session.get(PortalProxy, proxy_id)
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="代理不存在")
        item.is_active = not item.is_active
        item.updated_at = utcnow()
        self.session.add(item)
        self.session.commit()
        return {"is_active": item.is_active}

    def check_proxies(self) -> dict:
        return {"message": "独立版未接入实际代理检测，已记录请求"}

    def solver_status(self) -> dict:
        return {"enabled": False, "running": False, "message": "独立版未启用 solver"}

    def restart_solver(self) -> dict:
        return {"ok": True, "message": "独立版未启用 solver，无需重启"}

    def grant_platform_access(self, user_id: int, platform_code: str, *, source_type: str, source_ref: str) -> None:
        row = self.session.exec(
            select(UserPlatformAccess).where(UserPlatformAccess.user_id == user_id, UserPlatformAccess.platform_code == platform_code)
        ).first()
        if row:
            row.is_active = True
            row.source_type = source_type
            row.source_ref = source_ref
            row.updated_at = utcnow()
            self.session.add(row)
        else:
            self.session.add(
                UserPlatformAccess(
                    user_id=user_id,
                    platform_code=platform_code,
                    source_type=source_type,
                    source_ref=source_ref,
                    is_active=True,
                    created_at=utcnow(),
                    updated_at=utcnow(),
                )
            )

    def _active_platform_codes(self, user_id: int | None) -> list[str]:
        if not user_id:
            return []
        rows = self.session.exec(
            select(UserPlatformAccess).where(UserPlatformAccess.user_id == int(user_id), UserPlatformAccess.is_active == True)
        ).all()
        return [item.platform_code for item in rows]

    def _permissions_for_role(self, role_code: str) -> list[str]:
        role = self.session.exec(select(PortalRole).where(PortalRole.role_code == role_code)).first()
        if not role:
            return []
        rows = self.session.exec(
            select(PortalPermission.permission_code)
            .join(PortalRolePermission, PortalRolePermission.permission_id == PortalPermission.id)
            .where(PortalRolePermission.role_id == int(role.id or 0))
        ).all()
        return [str(item) for item in rows]

    def _require_user(self, user_id: int) -> PortalUser:
        user = self.session.get(PortalUser, user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
        return user

    def _require_platform(self, platform_code: str) -> PortalPlatform:
        item = self.session.exec(
            select(PortalPlatform).where(PortalPlatform.platform_code == platform_code, PortalPlatform.status == "active")
        ).first()
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="平台不存在")
        return item

    def _ensure_unique_fields(self, *, email: str | None = None, mobile: str | None = None, exclude_user_id: int | None = None) -> None:
        if email:
            row = self.session.exec(select(PortalUser).where(PortalUser.email == email)).first()
            if row and int(row.id or 0) != int(exclude_user_id or 0):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="邮箱已被占用")
        if mobile:
            row = self.session.exec(select(PortalUser).where(PortalUser.mobile == mobile)).first()
            if row and int(row.id or 0) != int(exclude_user_id or 0):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="手机号已被占用")

    def _select_accounts_for_export(self, data: dict[str, Any]) -> list[dict]:
        platform = str(data.get("platform", "") or "")
        ids = {int(item) for item in (data.get("ids") or [])}
        select_all = bool(data.get("select_all"))
        status_filter = str(data.get("status_filter", "") or "")
        search_filter = str(data.get("search_filter", "") or "").lower()
        rows = self.session.exec(select(PortalAccount).order_by(PortalAccount.created_at.desc())).all()
        result = []
        for item in rows:
            if platform and item.platform_code != platform:
                continue
            if ids and not select_all and int(item.id or 0) not in ids:
                continue
            if status_filter and item.display_status != status_filter and item.lifecycle_status != status_filter:
                continue
            if search_filter and search_filter not in item.email.lower():
                continue
            result.append(self._serialize_account(item))
        return result

    def _paginate_tasks(self, items: list[PortalTask], *, platform: str, status_value: str, page: int, page_size: int) -> dict:
        result = []
        for item in items:
            if platform and item.platform_code != platform:
                continue
            if status_value and item.status != status_value:
                continue
            result.append(self._serialize_task(item))
        page = max(page, 1)
        page_size = min(max(page_size, 1), 200)
        start = (page - 1) * page_size
        end = start + page_size
        return {"total": len(result), "page": page, "items": result[start:end]}

    async def _stream_task_events(self, task_id: str, *, since: int = 0):
        async def generator():
            yield "retry: 5000\n"
            yield ": connected\n\n"
            rows = self.session.exec(
                select(PortalTaskEvent)
                .where(PortalTaskEvent.task_id == task_id, PortalTaskEvent.id > since)
                .order_by(PortalTaskEvent.id)
            ).all()
            for item in rows:
                yield f"data: {json.dumps(self._serialize_task_event(item), ensure_ascii=False)}\n\n"
            task = self.session.get(PortalTask, task_id)
            if task and task.status in TASK_TERMINAL_STATUSES:
                line = "任务已完成" if task.status == "succeeded" else (task.error or "任务结束")
                yield f"data: {json.dumps({'done': True, 'status': task.status, 'line': line}, ensure_ascii=False)}\n\n"

        return generator()

    def _activate_subscription(self, order: PortalOrder) -> None:
        metadata = json.loads(order.metadata_json or "{}")
        duration_days = max(int(metadata.get("duration_days", 30) or 30), 1)
        quantity = max(int(metadata.get("quantity", 1) or 1), 1)
        now = utcnow()
        current = self.session.exec(
            select(PortalSubscription)
            .where(
                PortalSubscription.user_id == order.user_id,
                PortalSubscription.platform_code == order.platform_code,
                PortalSubscription.status == "active",
            )
            .order_by(PortalSubscription.updated_at.desc())
        ).first()
        extension = timedelta(days=duration_days * quantity)
        if current:
            base_time = current.expired_at if current.expired_at and current.expired_at > now else now
            current.expired_at = base_time + extension
            current.updated_at = now
            current.product_name = order.product_name
            current.product_code = order.product_code
            self.session.add(current)
            subscription_no = current.subscription_no
        else:
            sub = PortalSubscription(
                subscription_no=self._make_no("sub"),
                user_id=order.user_id,
                platform_code=order.platform_code,
                product_code=order.product_code,
                product_name=order.product_name,
                status="active",
                effective_at=now,
                expired_at=now + extension,
                created_at=now,
                updated_at=now,
            )
            self.session.add(sub)
            self.session.flush()
            subscription_no = sub.subscription_no
        self.grant_platform_access(order.user_id, order.platform_code, source_type="subscription", source_ref=subscription_no)

    def _serialize_platform(self, item: PortalPlatform) -> dict:
        return platform_payload(
            {
                "platform_code": item.platform_code,
                "display_name": item.display_name,
                "version": item.version,
                "supported_executors": json.loads(item.supported_executors_json or "[]"),
                "supported_identity_modes": json.loads(item.supported_identity_modes_json or "[]"),
                "supported_oauth_providers": json.loads(item.supported_oauth_providers_json or "[]"),
            }
        )

    def _serialize_user(self, item: PortalUser, *, include_platforms: bool = False) -> dict:
        payload = {
            "id": item.id,
            "username": item.username,
            "email": item.email,
            "mobile": item.mobile,
            "display_name": item.display_name or item.username,
            "avatar_url": item.avatar_url,
            "role_code": item.role_code,
            "status": item.status,
            "last_login_at": item.last_login_at.isoformat() if item.last_login_at else None,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }
        if include_platforms:
            payload["platform_codes"] = self._active_platform_codes(item.id)
        return payload

    def _serialize_product(self, item: PortalProduct) -> dict:
        return {
            "product_code": item.product_code,
            "platform_code": item.platform_code,
            "product_name": item.product_name,
            "amount": item.amount,
            "duration_days": item.duration_days,
            "status": item.status,
            "metadata": json.loads(item.metadata_json or "{}"),
        }

    def _serialize_order(self, item: PortalOrder) -> dict:
        return {
            "order_no": item.order_no,
            "product_code": item.product_code,
            "platform_code": item.platform_code,
            "product_name": item.product_name,
            "amount": item.amount,
            "status": item.status,
            "metadata": json.loads(item.metadata_json or "{}"),
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }

    def _serialize_payment(self, item: PortalPaymentRecord, extra: dict[str, Any] | None = None) -> dict:
        payload = {
            "payment_no": item.payment_no,
            "order_no": item.order_no,
            "channel_code": item.channel_code,
            "amount": item.amount,
            "status": item.status,
            "channel_trade_no": item.channel_trade_no,
            "payload": json.loads(item.payload_json or "{}"),
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }
        if extra:
            payload.update(extra)
        return payload

    def _serialize_subscription(self, item: PortalSubscription) -> dict:
        return {
            "subscription_no": item.subscription_no,
            "platform_code": item.platform_code,
            "product_code": item.product_code,
            "product_name": item.product_name,
            "status": item.status,
            "effective_at": item.effective_at.isoformat() if item.effective_at else None,
            "expired_at": item.expired_at.isoformat() if item.expired_at else None,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }

    def _serialize_task(self, item: PortalTask) -> dict:
        result = json.loads(item.result_json or "{}")
        return {
            "id": item.id,
            "task_id": item.id,
            "type": item.type,
            "platform": item.platform_code,
            "status": item.status,
            "terminal": item.status in TASK_TERMINAL_STATUSES,
            "cancellable": item.status not in TASK_TERMINAL_STATUSES,
            "progress": f"{item.progress_current}/{item.progress_total}" if item.progress_total else "0/0",
            "progress_detail": {
                "current": item.progress_current,
                "total": item.progress_total,
                "label": f"{item.progress_current}/{item.progress_total}" if item.progress_total else "0/0",
            },
            "success": item.success_count,
            "error_count": item.error_count,
            "errors": list(result.get("errors", [])),
            "cashier_urls": list(result.get("cashier_urls", [])),
            "result": result,
            "error": item.error,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "started_at": item.started_at.isoformat() if item.started_at else None,
            "finished_at": item.finished_at.isoformat() if item.finished_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }

    def _serialize_task_event(self, item: PortalTaskEvent) -> dict:
        return {
            "id": item.id,
            "task_id": item.task_id,
            "type": item.type,
            "level": item.level,
            "message": item.message,
            "line": item.message,
            "detail": json.loads(item.detail_json or "{}"),
            "created_at": item.created_at.isoformat() if item.created_at else None,
        }

    def _serialize_task_log(self, item: PortalTaskLog) -> dict:
        return {
            "id": item.id,
            "platform": item.platform_code,
            "email": item.email,
            "status": item.status,
            "error": item.error,
            "detail": json.loads(item.detail_json or "{}"),
            "created_at": item.created_at.isoformat() if item.created_at else None,
        }

    def _serialize_account(self, item: PortalAccount) -> dict:
        return {
            "id": item.id,
            "platform": item.platform_code,
            "email": item.email,
            "password": item.password,
            "user_id": item.user_id,
            "primary_token": item.primary_token,
            "trial_end_time": item.trial_end_time,
            "cashier_url": item.cashier_url,
            "lifecycle_status": item.lifecycle_status,
            "validity_status": item.validity_status,
            "plan_state": item.plan_state,
            "plan_name": item.plan_name,
            "display_status": item.display_status,
            "overview": json.loads(item.overview_json or "{}"),
            "credentials": json.loads(item.credentials_json or "{}"),
            "provider_accounts": json.loads(item.provider_accounts_json or "[]"),
            "provider_resources": json.loads(item.provider_resources_json or "[]"),
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }

    def _serialize_proxy(self, item: PortalProxy) -> dict:
        return {
            "id": item.id,
            "url": item.url,
            "region": item.region,
            "success_count": item.success_count,
            "fail_count": item.fail_count,
            "is_active": item.is_active,
            "last_checked": item.last_checked.isoformat() if item.last_checked else None,
        }

    @staticmethod
    def _stream_bytes(content: bytes, media_type: str, filename: str) -> StreamingResponse:
        return StreamingResponse(iter([content]), media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})

    @staticmethod
    def _stream_buffer(buffer: io.BytesIO, media_type: str, filename: str) -> StreamingResponse:
        return StreamingResponse(buffer, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})

    @staticmethod
    def _make_no(prefix: str) -> str:
        return f"{prefix}_{int(utcnow().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}"
