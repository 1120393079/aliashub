"""Cerebras 协议邮箱注册 worker。"""
from __future__ import annotations

from typing import Callable, Optional

from platforms.cerebras.core import CerebrasRegister


class CerebrasProtocolMailboxWorker:
    def __init__(self, *, executor, log_fn: Callable[[str], None] = print):
        self.client = CerebrasRegister(executor=executor, log_fn=log_fn)
        self.log = log_fn

    def run(
        self,
        *,
        email: str,
        password: str,
        otp_callback: Optional[Callable[[], str]] = None,
    ) -> dict:
        method_id = self.client.step1_send_otp(email)

        otp = otp_callback() if otp_callback else input("OTP: ")
        if not otp:
            raise RuntimeError("未获取到验证码")
        self.log(f"验证码: {otp}")

        session = self.client.step2_verify_otp(email, otp, method_id)
        api_key = self.client.step3_get_or_create_api_key()

        self.log(f"API Key: {api_key[:20]}..." if api_key else "未获取到 API Key")
        return {
            "email": email,
            "password": "",
            "api_key": api_key,
            "user_id": session.get("user_id", ""),
            "session_token": session.get("session_token", ""),
            "session_jwt": session.get("session_jwt", ""),
        }
