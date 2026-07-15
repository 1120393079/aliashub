"""anything.com 注册、登录、状态查询与支付链接封装。"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from typing import Any, Callable
from urllib.parse import unquote, urlparse

from curl_cffi.requests import Session

from core.base_platform import Account

ANYTHING_BASE = "https://www.anything.com"
ANYTHING_GRAPHQL = f"{ANYTHING_BASE}/api/graphql"
ANYTHING_REFRESH_TOKEN_URL = f"{ANYTHING_BASE}/api/refresh_token"

# 来自 HAR 的默认 lookup，可通过 action 参数覆盖。
ANYTHING_CHECKOUT_LOOKUPS = {
    "pro_20_monthly": "usage_pro_price_20_monthly",
}

# 来自 HAR 的默认 referral code，可通过注册额外参数覆盖或置空。
ANYTHING_DEFAULT_REFERRAL_CODE = "y6xx8d3a"

QUERY_ME = """
query Me {
  me {
    id
    email
    roles
    badges
    displayName
    username
    profile {
      firstName
      lastName
      photoURL
      xUsername
      instagramUsername
      facebookUsername
      githubUsername
      linkedinUsername
      tiktokUsername
      __typename
    }
    createdAt
    completedSurvey
    __typename
  }
}
""".strip()

QUERY_GET_ORGANIZATIONS = """
query GetOrganizations {
  organizations(order: {createdAt: "ASC"}) {
    edges {
      node {
        id
        name
        plan
        planId
        planCredits
        stripeProductId
        stripeSubscriptionInterval
        revenueCatProductId
        __typename
      }
      __typename
    }
    __typename
  }
}
""".strip()

MUTATION_SIGN_UP_WITH_APP_PROMPT = """
mutation SignUpWithAppPrompt($input: SignUpWithAppPromptInput!) {
  signUpAndStartAgent(input: $input) {
    ... on SignUpWithoutAppPromptPayload {
      success
      accessToken
      project {
        id
        projectGroup {
          id
          __typename
        }
        __typename
      }
      projectGroup {
        id
        __typename
      }
      user {
        id
        email
        roles
        badges
        displayName
        username
        __typename
      }
      organization {
        id
        __typename
      }
      __typename
    }
    ... on SignUpAndStartAgentErrorResult {
      success
      errors {
        kind
        message
        __typename
      }
      __typename
    }
    __typename
  }
}
""".strip()

MUTATION_SIGN_IN_WITH_MAGIC_LINK_CODE = """
mutation SignInWithMagicLinkCode($input: SignInWithMagicLinkCodeInput!) {
  signInWithMagicLinkCode(input: $input) {
    user {
      id
      email
      roles
      badges
      displayName
      username
      __typename
    }
    accessToken
    __typename
  }
}
""".strip()

MUTATION_CREATE_CHECKOUT_SESSION_WITH_LOOKUP = """
mutation CreateCheckoutSessionWithLookup($input: CreateCheckoutSessionWithPriceLookupInput!) {
  createCheckoutSessionWithPriceLookup(input: $input) {
    url
    __typename
  }
}
""".strip()

QUERY_GET_AGGREGATED_USAGE_BY_ORGANIZATION_ID = """
query GetAggregatedUsageByOrganizationId($id: ID!, $startDate: DateTimeISO!, $endDate: DateTimeISO!) {
  organizationById(id: $id) {
    id
    aggregatedIntegrationCreditUsageBySubType(
      startDate: $startDate
      endDate: $endDate
    ) {
      total
      usages {
        amount
        average
        type
        subType
        __typename
      }
      __typename
    }
    aggregatedCreditUsageByType(startDate: $startDate, endDate: $endDate) {
      total
      usages {
        amount
        average
        type
        subType
        __typename
      }
      __typename
    }
    __typename
  }
}
""".strip()


def _clip(value: str, left: int = 12, right: int = 8) -> str:
    value = str(value or "").strip()
    if len(value) <= left + right + 3:
        return value
    return f"{value[:left]}...{value[-right:]}"


def _extract_refresh_token_from_set_cookie(response: Any) -> str:
    header_items = []
    try:
        header_items = response.headers.items()
    except Exception:
        header_items = []
    for name, value in header_items:
        if str(name).lower() != "set-cookie":
            continue
        cookie = SimpleCookie()
        cookie.load(value)
        morsel = cookie.get("refresh_token")
        if morsel and morsel.value:
            return morsel.value
    return ""


def _organization_nodes(payload: dict[str, Any]) -> list[dict[str, Any]]:
    edges = (((payload or {}).get("organizations") or {}).get("edges") or [])
    result: list[dict[str, Any]] = []
    for edge in edges:
        node = dict((edge or {}).get("node") or {})
        if node:
            result.append(node)
    return result


def _safe_int(value: Any) -> int:
    try:
        return int(str(value or "0").strip())
    except Exception:
        return 0


def _current_billing_window_iso() -> tuple[str, str]:
    china_tz = timezone(timedelta(hours=8))
    now_local = datetime.now(china_tz)
    start_local = now_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start_local.month == 12:
        next_month_local = start_local.replace(year=start_local.year + 1, month=1)
    else:
        next_month_local = start_local.replace(month=start_local.month + 1)
    end_local = next_month_local - timedelta(milliseconds=1)
    return (
        start_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        end_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    )


def summarize_anything_account_state(state: dict[str, Any], *, fallback_email: str = "") -> dict[str, Any]:
    me = dict(state.get("me") or {})
    organizations = list(state.get("organizations") or [])
    primary_org = dict(organizations[0] if organizations else {})
    plan = str(primary_org.get("plan") or "").strip()
    plan_id = str(primary_org.get("planId") or "").strip()
    stripe_product_id = str(primary_org.get("stripeProductId") or "").strip()
    plan_state = "subscribed" if plan and plan != "FREE" else "registered"
    usage = dict(state.get("usage") or {})
    aggregated_credit_usage = dict(usage.get("aggregated_credit_usage") or {})
    usage_total = _safe_int(aggregated_credit_usage.get("total"))
    plan_credits = _safe_int(primary_org.get("planCredits"))
    remaining_credits = max(plan_credits - usage_total, 0) if plan_credits else 0
    cashier_url = str(state.get("cashier_url") or "").strip()
    return {
        "valid": bool(me.get("id") and (state.get("access_token") or state.get("refresh_token"))),
        "email": str(me.get("email") or fallback_email or "").strip(),
        "user_id": str(me.get("id") or "").strip(),
        "organization_id": str(primary_org.get("id") or "").strip(),
        "organization_name": str(primary_org.get("name") or "").strip(),
        "plan": plan,
        "plan_id": plan_id,
        "plan_state": plan_state,
        "plan_credits": str(primary_org.get("planCredits") or "").strip(),
        "usage_total": str(usage_total),
        "remaining_credits": str(remaining_credits) if plan_credits else "",
        "stripe_product_id": stripe_product_id,
        "stripe_subscription_interval": str(primary_org.get("stripeSubscriptionInterval") or "").strip(),
        "revenue_cat_product_id": str(primary_org.get("revenueCatProductId") or "").strip(),
        "project_group_id": str(state.get("project_group_id") or "").strip(),
        "checkout_lookup": ANYTHING_CHECKOUT_LOOKUPS.get("pro_20_monthly", ""),
        "cashier_url": cashier_url,
        "usage": usage,
        "account_overview": {
            "plan": plan,
            "plan_id": plan_id,
            "plan_state": plan_state,
            "plan_credits": str(primary_org.get("planCredits") or "").strip(),
            "usage_total": str(usage_total),
            "remaining_credits": str(remaining_credits) if plan_credits else "",
            "organization_id": str(primary_org.get("id") or "").strip(),
            "organization_name": str(primary_org.get("name") or "").strip(),
            "stripe_product_id": stripe_product_id,
            "stripe_subscription_interval": str(primary_org.get("stripeSubscriptionInterval") or "").strip(),
            "project_group_id": str(state.get("project_group_id") or "").strip(),
            "cashier_url": cashier_url,
        },
    }


def extract_anything_account_context(account: Account | Any) -> dict[str, str]:
    extra = dict(getattr(account, "extra", {}) or {})
    return {
        "access_token": str(extra.get("access_token") or "").strip(),
        "refresh_token": str(extra.get("refresh_token") or getattr(account, "token", "") or "").strip(),
        "user_id": str(extra.get("user_id") or getattr(account, "user_id", "") or "").strip(),
        "organization_id": str(extra.get("organization_id") or "").strip(),
        "project_group_id": str(extra.get("project_group_id") or "").strip(),
        "email": str(extra.get("email") or getattr(account, "email", "") or "").strip(),
    }


class AnythingClient:
    def __init__(self, *, proxy: str | None = None, log_fn: Callable[[str], None] = print):
        self._log = log_fn
        proxies = {"http": proxy, "https": proxy} if proxy else None
        self.s = Session(impersonate="chrome", proxies=proxies, timeout=30)
        self.s.headers.update(
            {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
                "content-type": "application/json",
                "origin": ANYTHING_BASE,
                "user-agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
                ),
            }
        )

    def log(self, message: str) -> None:
        self._log(message)

    def _resolve_referer(self, referer: str | None) -> str:
        raw = str(referer or ANYTHING_BASE).strip() or ANYTHING_BASE
        if raw.startswith("http://") or raw.startswith("https://"):
            return raw
        if not raw.startswith("/"):
            raw = f"/{raw}"
        return f"{ANYTHING_BASE}{raw}"

    def _graphql(self, payload: dict[str, Any] | list[dict[str, Any]], *, access_token: str = "", referer: str | None = None) -> Any:
        headers = {
            "referer": self._resolve_referer(referer),
        }
        if access_token:
            headers["authorization"] = access_token
        response = self.s.post(ANYTHING_GRAPHQL, headers=headers, data=json.dumps(payload))
        self.log(f"POST /api/graphql -> {response.status_code}")
        if response.status_code != 200:
            raise RuntimeError(f"anything graphql 请求失败: {response.status_code} {response.text[:200]}")
        try:
            return response.json()
        except Exception as exc:
            raise RuntimeError(f"anything graphql 响应不是 JSON: {exc}") from exc

    def _fetch_state_once(
        self,
        *,
        access_token: str,
        project_group_id: str = "",
        referer: str | None = None,
    ) -> dict[str, Any]:
        batch_payload = [
            {
                "operationName": "Me",
                "variables": {},
                "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
                "query": QUERY_ME,
            },
            {
                "operationName": "GetOrganizations",
                "variables": {},
                "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
                "query": QUERY_GET_ORGANIZATIONS,
            },
        ]
        batch_result = self._graphql(batch_payload, access_token=access_token, referer=referer or "/")
        if not isinstance(batch_result, list) or len(batch_result) < 2:
            raise RuntimeError(f"anything 账号状态返回异常: {json.dumps(batch_result, ensure_ascii=False)[:300]}")
        me = (((batch_result[0] or {}).get("data") or {}).get("me") or {})
        organizations_payload = ((batch_result[1] or {}).get("data") or {})
        return {
            "access_token": access_token,
            "me": dict(me or {}),
            "organizations": _organization_nodes(organizations_payload),
            "project_group_id": str(project_group_id or "").strip(),
        }

    def _bind_refresh_token(self, refresh_token: str) -> None:
        token = str(refresh_token or "").strip()
        if not token:
            return
        parsed = urlparse(ANYTHING_BASE)
        self.s.cookies.set(
            "refresh_token",
            token,
            domain=parsed.hostname,
            path="/",
        )

    def sign_up_with_prompt(
        self,
        *,
        email: str,
        referral_code: str = "",
        language: str = "zh-CN",
        post_login_redirect: str | None = None,
    ) -> dict[str, Any]:
        referral = str(referral_code).strip()
        self.log(f"Step1: 发起注册 {email}")
        payload = {
            "operationName": "SignUpWithAppPrompt",
            "variables": {
                "input": {
                    "email": email,
                    "postLoginRedirect": post_login_redirect,
                    "language": language,
                    "referralCode": referral,
                }
            },
            "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
            "query": MUTATION_SIGN_UP_WITH_APP_PROMPT,
        }
        data = self._graphql(payload, referer=f"/signup?rid={referral}" if referral else "/signup")
        result = ((data or {}).get("data") or {}).get("signUpAndStartAgent") or {}
        if not result or not result.get("success"):
            raise RuntimeError(f"anything 注册失败: {json.dumps(result, ensure_ascii=False)[:300]}")
        return dict(result)

    def sign_in_with_magic_link_code(self, *, email: str, code: str, referer: str | None = None) -> dict[str, Any]:
        self.log(f"Step2: 使用 magic link code 登录 {email}")
        payload = {
            "operationName": "SignInWithMagicLinkCode",
            "variables": {"input": {"email": email, "codeAttempt": code}},
            "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
            "query": MUTATION_SIGN_IN_WITH_MAGIC_LINK_CODE,
        }
        response = self.s.post(
            ANYTHING_GRAPHQL,
            headers={
                "referer": self._resolve_referer(referer or "/"),
            },
            data=json.dumps(payload),
        )
        self.log(f"POST /api/graphql SignInWithMagicLinkCode -> {response.status_code}")
        if response.status_code != 200:
            raise RuntimeError(f"anything magic link 登录失败: {response.status_code} {response.text[:200]}")
        body = response.json()
        data = ((body or {}).get("data") or {}).get("signInWithMagicLinkCode") or {}
        access_token = str(data.get("accessToken") or "").strip()
        refresh_token = _extract_refresh_token_from_set_cookie(response)
        if not access_token:
            raise RuntimeError(f"anything 未返回 accessToken: {json.dumps(body, ensure_ascii=False)[:300]}")
        if refresh_token:
            self._bind_refresh_token(refresh_token)
        self.log(f"  access_token={_clip(access_token)} refresh_token={_clip(refresh_token)}")
        return {
            "user": dict(data.get("user") or {}),
            "access_token": access_token,
            "refresh_token": refresh_token,
        }

    def resolve_magic_link(self, raw_link: str, *, referer: str | None = None) -> str:
        candidate = str(raw_link or "").strip()
        if not candidate:
            raise RuntimeError("空 magic link")
        if "/auth/magic-link" in candidate:
            return candidate

        headers = {
            "referer": self._resolve_referer(referer or "/"),
        }
        response = self.s.get(candidate, headers=headers, allow_redirects=True)
        self.log(f"GET magic-link redirect -> {response.status_code} {response.url}")
        final_url = str(getattr(response, "url", "") or "").strip()
        if "/auth/magic-link" in final_url:
            return final_url

        text = str(getattr(response, "text", "") or "")
        decoded = unquote(text)
        for source in (text, decoded):
            idx = source.find("/auth/magic-link?")
            if idx >= 0:
                prefix = ANYTHING_BASE if source[idx] == "/" else ""
                tail = source[idx:]
                tail = tail.split('"', 1)[0].split("'", 1)[0].split("&amp;", 1)[0]
                return f"{prefix}{tail}"
            idx = source.find("https://www.anything.com/auth/magic-link?")
            if idx >= 0:
                tail = source[idx:]
                tail = tail.split('"', 1)[0].split("'", 1)[0].split("&amp;", 1)[0]
                return tail
        raise RuntimeError(f"无法解析 anything 魔法链接跳转: {candidate[:200]}")

    def refresh_access_token(self, refresh_token: str, *, referer: str | None = None) -> dict[str, Any]:
        self._bind_refresh_token(refresh_token)
        response = self.s.post(
            ANYTHING_REFRESH_TOKEN_URL,
            headers={
                "referer": self._resolve_referer(referer or "/"),
            },
        )
        self.log(f"POST /api/refresh_token -> {response.status_code}")
        if response.status_code != 200:
            raise RuntimeError(f"anything refresh_token 请求失败: {response.status_code} {response.text[:200]}")
        payload = response.json()
        if not payload.get("ok"):
            raise RuntimeError(f"anything refresh_token 失败: {json.dumps(payload, ensure_ascii=False)[:200]}")
        new_access = str(payload.get("accessToken") or "").strip()
        new_refresh = str(payload.get("refreshToken") or refresh_token or "").strip()
        if not new_access:
            raise RuntimeError("anything refresh_token 成功但未返回 accessToken")
        if new_refresh:
            self._bind_refresh_token(new_refresh)
        return {
            "access_token": new_access,
            "refresh_token": new_refresh,
        }

    def fetch_account_state(
        self,
        *,
        access_token: str = "",
        refresh_token: str = "",
        project_group_id: str = "",
        referer: str | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        current_access = str(access_token or "").strip()
        current_refresh = str(refresh_token or "").strip()
        if current_refresh:
            self._bind_refresh_token(current_refresh)
        if force_refresh and current_refresh:
            refreshed = self.refresh_access_token(current_refresh, referer=referer)
            current_access = refreshed["access_token"]
            current_refresh = refreshed["refresh_token"]
        if not current_access and current_refresh:
            refreshed = self.refresh_access_token(current_refresh, referer=referer)
            current_access = refreshed["access_token"]
            current_refresh = refreshed["refresh_token"]
        if not current_access:
            raise RuntimeError("缺少 anything access_token")
        try:
            state = self._fetch_state_once(
                access_token=current_access,
                project_group_id=project_group_id,
                referer=referer,
            )
        except Exception:
            if not current_refresh:
                raise
            refreshed = self.refresh_access_token(current_refresh, referer=referer)
            current_access = refreshed["access_token"]
            current_refresh = refreshed["refresh_token"]
            state = self._fetch_state_once(
                access_token=current_access,
                project_group_id=project_group_id,
                referer=referer,
            )
        state["refresh_token"] = current_refresh
        organizations = list(state.get("organizations") or [])
        if organizations:
            organization_id = str((organizations[0] or {}).get("id") or "").strip()
            if organization_id:
                try:
                    state["usage"] = self.fetch_aggregated_usage_by_organization(
                        access_token=current_access,
                        organization_id=organization_id,
                        referer=f"/dashboard/team/{organization_id}/subscription",
                    )
                except Exception as exc:
                    self.log(f"获取 usage 摘要失败，忽略并继续: {exc}")
        return state

    def fetch_aggregated_usage_by_organization(
        self,
        *,
        access_token: str,
        organization_id: str,
        referer: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any]:
        start_iso, end_iso = _current_billing_window_iso()
        payload = {
            "operationName": "GetAggregatedUsageByOrganizationId",
            "variables": {
                "id": organization_id,
                "startDate": start_date or start_iso,
                "endDate": end_date or end_iso,
            },
            "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
            "query": QUERY_GET_AGGREGATED_USAGE_BY_ORGANIZATION_ID,
        }
        body = self._graphql(
            payload,
            access_token=access_token,
            referer=referer or f"/dashboard/team/{organization_id}/subscription",
        )
        org = ((body or {}).get("data") or {}).get("organizationById") or {}
        return {
            "organization_id": str(org.get("id") or organization_id or "").strip(),
            "start_date": payload["variables"]["startDate"],
            "end_date": payload["variables"]["endDate"],
            "aggregated_integration_usage": dict(org.get("aggregatedIntegrationCreditUsageBySubType") or {}),
            "aggregated_credit_usage": dict(org.get("aggregatedCreditUsageByType") or {}),
        }

    def create_checkout_session_with_lookup(
        self,
        *,
        access_token: str,
        organization_id: str,
        lookup: str,
        redirect_url: str = ANYTHING_BASE,
        referral: str = "",
        referer: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "operationName": "CreateCheckoutSessionWithLookup",
            "variables": {
                "input": {
                    "lookup": lookup,
                    "organizationId": organization_id,
                    "referral": str(referral or ""),
                    "redirectURL": redirect_url,
                }
            },
            "extensions": {"clientLibrary": {"name": "@apollo/client", "version": "4.1.6"}},
            "query": MUTATION_CREATE_CHECKOUT_SESSION_WITH_LOOKUP,
        }
        body = self._graphql(
            payload,
            access_token=access_token,
            referer=referer or f"/dashboard/team/{organization_id}/subscription/plans",
        )
        data = ((body or {}).get("data") or {}).get("createCheckoutSessionWithPriceLookup") or {}
        url = str(data.get("url") or "").strip()
        if not url:
            raise RuntimeError(f"anything 未返回 checkout url: {json.dumps(body, ensure_ascii=False)[:300]}")
        return {
            "url": url,
            "lookup": lookup,
            "organization_id": organization_id,
        }


def load_anything_account_state(
    account: Any,
    *,
    proxy: str | None = None,
    log_fn: Callable[[str], None] = print,
    force_refresh: bool = False,
) -> dict[str, Any]:
    context = extract_anything_account_context(account)
    client = AnythingClient(proxy=proxy, log_fn=log_fn)
    state = client.fetch_account_state(
        access_token=context["access_token"],
        refresh_token=context["refresh_token"],
        project_group_id=context["project_group_id"],
        referer="/dashboard",
        force_refresh=force_refresh,
    )
    state["summary"] = summarize_anything_account_state(state, fallback_email=context["email"])
    return state
