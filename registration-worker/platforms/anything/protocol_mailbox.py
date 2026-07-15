"""anything.com 协议邮箱注册 worker。"""
from __future__ import annotations

import re
from typing import Callable, Optional
from urllib.parse import parse_qs, unquote, urlparse

from platforms.anything.core import (
    ANYTHING_BASE,
    ANYTHING_CHECKOUT_LOOKUPS,
    ANYTHING_DEFAULT_REFERRAL_CODE,
    AnythingClient,
    summarize_anything_account_state,
)


class AnythingProtocolMailboxWorker:
    def __init__(self, *, proxy: str | None = None, log_fn: Callable[[str], None] = print):
        self.client = AnythingClient(proxy=proxy, log_fn=log_fn)
        self.log = log_fn

    def run(
        self,
        *,
        email: str,
        link_callback: Optional[Callable[[], str]] = None,
        referral_code: str = ANYTHING_DEFAULT_REFERRAL_CODE,
        language: str = "zh-CN",
        post_login_redirect: str | None = None,
    ) -> dict:
        signup = self.client.sign_up_with_prompt(
            email=email,
            referral_code=referral_code,
            language=language,
            post_login_redirect=post_login_redirect,
        )
        if not link_callback:
            raise RuntimeError("link_callback is required")

        self.log("等待 anything 魔法链接...")
        raw = link_callback()
        if not raw:
            raise RuntimeError("获取 anything 魔法链接超时")

        resolved = self._resolve_magic_link(raw)
        parsed = self._extract_magic_link(resolved)
        resolved_email = parsed["email"] or email
        signin = self.client.sign_in_with_magic_link_code(
            email=resolved_email,
            code=parsed["code"],
            referer=parsed["referer"],
        )
        state = self.client.fetch_account_state(
            access_token=signin["access_token"],
            refresh_token=signin["refresh_token"],
            project_group_id=str((signup.get("projectGroup") or {}).get("id") or ""),
            referer="/dashboard",
        )
        cashier_url = ""
        organizations = list(state.get("organizations") or [])
        organization_id = str((organizations[0] or {}).get("id") or "").strip() if organizations else ""
        if organization_id:
            try:
                checkout = self.client.create_checkout_session_with_lookup(
                    access_token=state.get("access_token", ""),
                    organization_id=organization_id,
                    lookup=ANYTHING_CHECKOUT_LOOKUPS.get("pro_20_monthly", ""),
                    redirect_url=ANYTHING_BASE,
                )
                cashier_url = str(checkout.get("url") or "").strip()
                state["cashier_url"] = cashier_url
            except Exception as exc:
                self.log(f"自动生成支付链接失败，忽略并继续: {exc}")
        summary = summarize_anything_account_state(state, fallback_email=resolved_email)
        overview = dict(summary.get("account_overview") or {})
        result = {
            "success": True,
            "email": summary.get("email") or resolved_email,
            "password": "",
            "user_id": summary.get("user_id") or str((signin.get("user") or {}).get("id") or ""),
            "access_token": state.get("access_token", ""),
            "refresh_token": state.get("refresh_token", ""),
            "organization_id": summary.get("organization_id", ""),
            "project_group_id": summary.get("project_group_id", ""),
            "cashier_url": cashier_url,
            "usage": summary.get("usage", {}),
            "account_overview": overview,
            "signup_payload": signup,
        }
        self.log(
            f"anything 注册成功: {result['email']} "
            f"org={result['organization_id']} plan={overview.get('plan', '') or 'UNKNOWN'}"
        )
        if cashier_url:
            self.log(f"自动生成支付链接: {cashier_url}")
        return result

    def _resolve_magic_link(self, raw: str) -> str:
        candidate = str(raw or "").strip()
        if not candidate:
            raise RuntimeError("空 magic link")
        if "/auth/magic-link" in candidate:
            return candidate
        self.log(f"收到邮件追踪链接，尝试解析跳转: {candidate[:120]}")
        return self.client.resolve_magic_link(candidate, referer="/")

    @staticmethod
    def _extract_magic_link(raw: str) -> dict[str, str]:
        candidate = str(raw or "").strip()
        if not candidate:
            raise RuntimeError("空 magic link")
        candidate = unquote(candidate)
        if candidate.startswith("http://") or candidate.startswith("https://"):
            parsed = urlparse(candidate)
            query = parse_qs(parsed.query)
            code = str((query.get("code") or [""])[0]).strip()
            email = str((query.get("email") or [""])[0]).strip()
            referer = parsed.path or "/"
            if parsed.query:
                referer = f"{referer}?{parsed.query}"
            if code:
                return {"code": code, "email": email, "referer": referer}

        match = re.search(r"[?&]code=([^&]+)", candidate)
        if not match:
            code_only = candidate.strip()
            if re.fullmatch(r"\d{4,8}", code_only):
                return {"code": code_only, "email": "", "referer": "/"}
            raise RuntimeError(f"无法从 anything 魔法链接中提取 code: {candidate[:200]}")
        code = match.group(1).strip()
        email_match = re.search(r"[?&]email=([^&]+)", candidate)
        email = unquote(email_match.group(1).strip()) if email_match else ""
        return {"code": code, "email": email, "referer": "/"}
