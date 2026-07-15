"""Tavily 协议邮箱注册 worker。"""
from __future__ import annotations

from typing import Callable, Optional

from platforms.tavily.core import TavilyRegister


class TavilyProtocolMailboxWorker:
    def __init__(self, *, executor, captcha, log_fn: Callable[[str], None] = print):
        self.client = TavilyRegister(executor=executor, captcha=captcha, log_fn=log_fn)
        self.log = log_fn

    def run(
        self,
        *,
        email: str,
        password: str,
        otp_callback: Optional[Callable[[], str]] = None,
    ) -> dict:
        state = self.client.step1_authorize()
        captcha_token = self.client.step2_solve_captcha()
        challenge_state = self.client.step3_submit_email(email, state, captcha_token)
        otp = otp_callback() if otp_callback else input("OTP: ")
        if not otp:
            raise RuntimeError("未获取到验证码")
        self.log(f"验证码: {otp}")
        pw_state = self.client.step4_submit_otp(otp, challenge_state)
        resume_state = self.client.step5_submit_password(email, password, pw_state)
        api_key = self.client.step6_resume_and_get_key(resume_state)
        self.log(f"API Key: {api_key[:20]}..." if api_key else "未获取到 API Key")
        return {"email": email, "password": password, "api_key": api_key}
