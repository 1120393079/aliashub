from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel import Session

from customer_portal_api.app.deps import get_db_session
from customer_portal_api.app.services.portal import PortalService


router = APIRouter(prefix="/payment", tags=["payment"])


class PaymentCallbackRequest(BaseModel):
    payment_no: str | None = None
    order_no: str | None = None
    status: str = "success"
    channel_trade_no: str | None = None
    payload: dict = Field(default_factory=dict)


@router.post("/callback/{channel_code}")
def payment_callback(
    channel_code: str,
    body: PaymentCallbackRequest,
    session: Session = Depends(get_db_session),
):
    data = body.model_dump()
    if data.get("payload") and isinstance(data["payload"], dict):
        merged = dict(data["payload"])
        merged.update({k: v for k, v in data.items() if k != "payload"})
        data = merged
    return PortalService(session).handle_payment_callback(channel_code, data)
