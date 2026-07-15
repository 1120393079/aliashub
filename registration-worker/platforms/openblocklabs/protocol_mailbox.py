"""OpenBlockLabs 协议邮箱注册 worker。"""
from __future__ import annotations

import random
import string
from typing import Callable, Optional

from platforms.openblocklabs.core import OpenBlockLabsRegister, _rand_password


class OpenBlockLabsProtocolMailboxWorker:
    def __init__(self, *, proxy: str | None = None, log_fn: Callable[[str], None] = print):
        self.client = OpenBlockLabsRegister(proxy=proxy)
        self.client.log = lambda msg: log_fn(msg)
        self.log = log_fn

    def run(
        self,
        *,
        email: str,
        password: str | None = None,
        first_name: str | None = None,
        last_name: str | None = None,
        otp_callback: Optional[Callable[[], str]] = None,
    ) -> dict:
        use_password = password or _rand_password()
        use_first_name = first_name or "".join(random.choices(string.ascii_lowercase, k=5)).capitalize()
        use_last_name = last_name or "".join(random.choices(string.ascii_lowercase, k=5)).capitalize()

        if not self.client.step1_initiate_signup():
            raise RuntimeError("initiate_signup failed")
        if not self.client.step2_get_signup_page():
            raise RuntimeError("get_signup_page failed")
        if not self.client.step3_submit_signup(email, use_first_name, use_last_name):
            raise RuntimeError("submit_signup failed")
        if not self.client.step4_get_password_page():
            raise RuntimeError("get_password_page failed")

        pending_token = self.client.step5_submit_password(email, use_password, use_first_name, use_last_name)
        if pending_token is None:
            raise RuntimeError("submit_password failed (email may already be registered)")

        if not self.client.step6_get_email_verification_page():
            raise RuntimeError("get_email_verification_page failed")

        if not otp_callback:
            raise RuntimeError("otp_callback is required")
        otp = otp_callback()
        if not otp:
            raise RuntimeError("OTP timeout")

        auth_code = self.client.step7_submit_otp(email, otp, pending_token)
        if not auth_code:
            raise RuntimeError("submit_otp failed / no auth_code")

        session_token = self.client.step8_exchange_callback(auth_code)
        if not session_token:
            raise RuntimeError("exchange_callback failed / no wos-session")

        self.client.step9_create_personal_org()

        result = {
            "success": True,
            "email": email,
            "password": use_password,
            "wos_session": session_token,
        }
        self.log(f"注册成功: {email}")
        return result
