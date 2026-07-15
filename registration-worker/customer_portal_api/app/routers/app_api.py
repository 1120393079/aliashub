from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from customer_portal_api.app.deps import get_current_user, get_db_session
from customer_portal_api.app.models import PortalUser
from customer_portal_api.app.services.portal import PortalService


router = APIRouter(prefix="/app", tags=["app"])


class RegisterTaskRequest(BaseModel):
    platform: str
    email: str | None = None
    password: str | None = None
    count: int = 1
    concurrency: int = 1
    proxy: str | None = None
    executor_type: str = "protocol"
    captcha_solver: str = "auto"
    extra: dict = Field(default_factory=dict)


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None
    email: str | None = None
    mobile: str | None = None


class CreateOrderRequest(BaseModel):
    product_code: str
    quantity: int = 1


class SubmitPaymentRequest(BaseModel):
    channel_code: str = "mock"


@router.get("/platforms")
def list_platforms(
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_app_platforms(user)


@router.get("/config/options")
def get_config_options(
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_app_config_options(user)


@router.get("/products")
def list_products(
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_products(user)


@router.post("/tasks/register")
def create_register_task(
    body: RegisterTaskRequest,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).create_app_register_task(user, body.model_dump())


@router.get("/tasks")
def list_tasks(
    platform: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 50,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_app_tasks(user, platform=platform, status=status, page=page, page_size=page_size)


@router.get("/tasks/{task_id}")
def get_task(
    task_id: str,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_app_task(user, task_id)


@router.get("/tasks/{task_id}/events")
def list_task_events(
    task_id: str,
    since: int = 0,
    limit: int = 200,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_app_task_events(user, task_id, since=since, limit=limit)


@router.get("/tasks/{task_id}/logs/stream")
async def stream_task_events(
    task_id: str,
    since: int = 0,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    service = PortalService(session)
    return StreamingResponse(
        await service.stream_app_task_events(user, task_id, since=since),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/orders")
def list_orders(
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_orders(user)


@router.post("/orders")
def create_order(
    body: CreateOrderRequest,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).create_order(user, body.model_dump())


@router.get("/orders/{order_no}")
def get_order(
    order_no: str,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_order(user, order_no)


@router.post("/payments/{order_no}/submit")
def submit_payment(
    order_no: str,
    body: SubmitPaymentRequest,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).submit_payment(user, order_no, body.model_dump())


@router.get("/subscriptions")
def list_subscriptions(
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_subscriptions(user)


@router.get("/profile")
def get_profile(
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_profile(user)


@router.patch("/profile")
def update_profile(
    body: ProfileUpdateRequest,
    user: PortalUser = Depends(get_current_user),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).update_profile(user, body.model_dump(exclude_unset=True))
