from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session

from customer_portal_api.app.deps import get_current_user, get_db_session
from customer_portal_api.app.models import PortalUser
from customer_portal_api.app.services.auth import AuthService


router = APIRouter(tags=["auth"])


class LoginRequest(BaseModel):
    account: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


@router.post("/auth/login")
def login(body: LoginRequest, session: Session = Depends(get_db_session)):
    return AuthService(session).login(body.account, body.password)


@router.post("/auth/refresh")
def refresh(body: RefreshRequest, session: Session = Depends(get_db_session)):
    return AuthService(session).refresh(body.refresh_token)


@router.post("/auth/logout")
def logout(body: LogoutRequest, session: Session = Depends(get_db_session)):
    return AuthService(session).logout(body.refresh_token)


@router.get("/auth/me")
def me(user: PortalUser = Depends(get_current_user), session: Session = Depends(get_db_session)):
    return AuthService(session).get_me(user)
