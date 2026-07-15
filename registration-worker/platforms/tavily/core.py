"""Tavily 注册协议核心实现 (Auth0 流程)"""
import re, json, secrets, hashlib, base64, urllib.parse
from typing import Optional, Callable

AUTH0_CLIENT_ID   = "RRIAvvXNFxpfTWIozX1mXqLnyUmYSTrQ"
AUTH0_BASE        = "https://auth.tavily.com"
APP_BASE          = "https://app.tavily.com"
REDIRECT_URI      = "https://app.tavily.com/api/auth/callback"
TURNSTILE_SITEKEY = "0x4AAAAAAAQFNSW6xordsuIq"


class TavilyRegister:
    def __init__(self, executor, captcha, log_fn: Callable = print):
        self.ex = executor
        self.captcha = captcha
        self.log = log_fn

    def step1_authorize(self) -> str:
        """GET /authorize → 返回 state"""
        nonce = secrets.token_urlsafe(32)
        code_verifier = secrets.token_urlsafe(43)
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).rstrip(b'=').decode()
        state_val = base64.urlsafe_b64encode(
            json.dumps({"returnTo": f"{APP_BASE}/home"}).encode()
        ).rstrip(b'=').decode()
        params = {
            "client_id": AUTH0_CLIENT_ID, "scope": "openid profile email",
            "response_type": "code", "redirect_uri": REDIRECT_URI,
            "nonce": nonce, "state": state_val,
            "screen_hint": "signup", "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        r = self.ex.get(f"{AUTH0_BASE}/authorize", params=params)
        m = re.search(r'[?&]state=([^&]+)', r.headers.get("location", "") or str(r.text[:500]))
        return urllib.parse.unquote(m.group(1)) if m else state_val

    def step2_solve_captcha(self) -> str:
        self.log("获取 Turnstile token...")
        token = self.captcha.solve_turnstile(AUTH0_BASE, TURNSTILE_SITEKEY)
        self.log("Turnstile OK")
        return token

    def step3_submit_email(self, email: str, state: str, captcha_token: str) -> str:
        self.log(f"提交邮箱: {email}")
        r = self.ex.post(
            f"{AUTH0_BASE}/u/signup/identifier",
            params={"state": state},
            data={"state": state, "email": email, "captcha": captcha_token},
        )
        loc = r.headers.get("location", "")
        m = re.search(r'[?&]state=([^&]+)', loc)
        return urllib.parse.unquote(m.group(1)) if m else state

    def step4_submit_otp(self, otp: str, challenge_state: str) -> str:
        self.log("提交验证码...")
        r = self.ex.post(
            f"{AUTH0_BASE}/u/email-identifier/challenge",
            params={"state": challenge_state},
            data={"state": challenge_state, "code": otp},
        )
        loc = r.headers.get("location", "")
        m = re.search(r'[?&]state=([^&]+)', loc)
        return urllib.parse.unquote(m.group(1)) if m else challenge_state

    def step5_submit_password(self, email: str, password: str, pw_state: str) -> str:
        self.log("设置密码...")
        r = self.ex.post(
            f"{AUTH0_BASE}/u/signup/password",
            params={"state": pw_state},
            data={"state": pw_state, "email": email, "password": password,
                  "passwordPolicy.isFlexible": "false",
                  "strengthPolicy": "good", "complexityOptions.minLength": "8"},
        )
        loc = r.headers.get("location", "")
        m = re.search(r'[?&]state=([^&]+)', loc)
        return urllib.parse.unquote(m.group(1)) if m else pw_state

    def step6_resume_and_get_key(self, resume_state: str) -> str:
        self.log("完成授权流程...")
        self.ex.get(f"{AUTH0_BASE}/authorize/resume", params={"state": resume_state})
        r = self.ex.get(f"{APP_BASE}/api/keys", headers={"accept": "application/json"})
        try:
            keys = r.json()
            if keys and isinstance(keys, list):
                return keys[0].get("key", "")
        except Exception:
            pass
        return ""
