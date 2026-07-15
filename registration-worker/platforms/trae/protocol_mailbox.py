"""Trae 协议邮箱注册 worker。"""
from __future__ import annotations

from typing import Callable, Optional

from platforms.trae.core import TraeRegister, _rand_password


class TraeProtocolMailboxWorker:
    def __init__(self, *, executor, log_fn: Callable[[str], None] = print):
        self.client = TraeRegister(executor=executor, log_fn=log_fn)
        self.log = log_fn

    def run(
        self,
        *,
        email: str,
        password: str | None = None,
        otp_callback: Optional[Callable[[], str]] = None,
    ) -> dict:
        use_password = password or _rand_password()
        self.client.step1_region()
        self.client.step2_send_code(email)
        otp = otp_callback() if otp_callback else input("OTP: ")
        if not otp:
            raise RuntimeError("未获取到验证码")
        self.log(f"验证码: {otp}")
        user_id = self.client.step3_register(email, use_password, otp)
        self.client.step4_trae_login()
        token = self.client.step5_get_token()
        result = self.client.step6_check_login()
        cashier_url = self.client.step7_create_order(token)
        return {
            "email": email,
            "password": use_password,
            "user_id": user_id,
            "token": token,
            "region": result.get("Region", ""),
            "cashier_url": cashier_url,
            "ai_pay_host": result.get("AIPayHost", ""),
        }
