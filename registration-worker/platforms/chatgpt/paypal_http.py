"""PayPal Checkout (www.paypal.com) 协议层 —— Phase 8 入口。

当前覆盖范围：

* **Stage P1** ``GET /agreements/approve?ba_token=BA-XXX`` —— 落地建 cookies +
  从首页 HTML 抓 ``_csrf`` / ``_sessionID`` / ``ec_token`` 三件套。
* 纯函数辅助：URL query token 抽取、HTML token 抽取，便于上层 stage 复用。

后续 Phase 会在此基础上追加：

* Stage P2 ``/pay`` 三连（仅在确认需要走 addCard 时才发；正确 $0 流程会跳过）
* Stage P3 captcha 三连（``/auth/validatecaptcha`` + ``/auth/verifyhcaptchapassive``
  + ``hcaptcha.paypal.com/checksiteconfig``）
* Stage P5 GraphQL 元数据查询（``CheckoutSessionDataQuery`` / ``GriffinMetadataQuery``）
* Stage P6 ``InitiateRiskBasedTwoFactorPhoneConfirmationMutation`` SMS 双因素
* Stage P7 ``SignUpNewMemberMutation`` 一键注册 + 卡片授权
"""

from __future__ import annotations

import logging
import pathlib
import re
import secrets
from typing import Any, Mapping, Optional
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)


PAYPAL_BASE = "https://www.paypal.com"
PAYPAL_APPROVE_PATH = "/agreements/approve"
PAYPAL_GRAPHQL_URL = f"{PAYPAL_BASE}/graphql"
# SignUp 走 ``?SignUpNewMemberMutation`` query string；与 hermes batch 的 ``/graphql/``
# 是两个不同的 endpoint，PayPal 服务器路由不一样。
PAYPAL_SIGNUP_URL = f"{PAYPAL_GRAPHQL_URL}?SignUpNewMemberMutation"
# OTP 子链两步走的 endpoint，都是 ?<OperationName> query 形式的 single-op POST，
# 与 SignUp 同源同路由，但 mutation 名不同。
PAYPAL_OTP_INITIATE_URL = f"{PAYPAL_GRAPHQL_URL}?InitiateRiskBasedTwoFactorPhoneConfirmationMutation"
PAYPAL_OTP_CONFIRM_URL = f"{PAYPAL_GRAPHQL_URL}?ConfirmRiskBasedTwoFactorPhoneConfirmationMutation"
# OTP_CHALLENGE 预热 endpoint —— HAR 实采里浏览器在 OTP initiate 之前会先 POST
# 这个 ``/idapps/graphql`` 上报 `clientInfo` (含设备指纹 rData + ctxId + csrfNonce)
# 把 SignUp 主链与 OTP 子链关联到同一个 session。**协议模式如果跳过这个请求**，
# PayPal 在 OTP confirm 后的 SignUp retry 阶段会判定 "OTP 阶段没注册设备指纹"
# → 直接 ``OAS_ERROR (createMemberAccount)``。
PAYPAL_OTP_CHALLENGE_URL = f"{PAYPAL_BASE}/idapps/graphql"

# PayPal weasley SDK 加载完成时会发的 metric/logger 请求。**关键作用**：响应里
# Set-Cookie ``tsrce=checkoutuinodeweb_weasley`` —— 后续 OTP_CHALLENGE /
# OTP_INITIATE / OTP_CONFIRM 三个请求都依赖这条 cookie 让 PayPal 服务端把它们
# 识别为 "weasley SDK 内部 fetch"，否则会返回嵌入 ``pa.js`` 的 HTML 容器页（pa.js
# 是 PayPal 全站身份/防爬 SDK；当请求**不被识别为合法 weasley fetch** 时会被
# 当成"页面访问"返回这种容器），客户端 JSONDecodeError 之外，更糟的是 PayPal
# 服务端**根本不会建立 OTP fraud session**——这就是协议模式过去看到的
# "OTP_INITIATE state=PENDING 但 OTP_CONFIRM 报 ``PHONE_CONFIRMATION_NOT_INITIATED``"
# 的真正根因。HAR 实采里这个请求重复发了 10+ 次（每个 weasley UI 元素的
# start_application / impression / click 都各打一次），但**首次**响应的
# ``Set-Cookie tsrce`` 就够了，所以协议模式只发一次即可。
PAYPAL_WEASLEY_LOGGER_URL = f"{PAYPAL_BASE}/xoplatform/logger/api/logger/"

# OTP 两步走的 GraphQL mutation 字符串。直接内嵌（约 0.4 KB）：
# - 它们都不在 SignUp 的 .gql 文件里
# - 都没用 fragment / persisted query，纯 inline mutation，对压缩/缩进不敏感
# - 不像 SignUp 那样巨长（几百行 fragment），所以**不需要**单独 .gql 文件
_OTP_INITIATE_QUERY = (
    "mutation InitiateRiskBasedTwoFactorPhoneConfirmationMutation"
    "($phoneNumber: String!, $locale: LocaleInput!, $phoneCountry: CountryCodes!, $token: String!) {\n"
    "  initiateRiskBasedTwoFactorPhoneConfirmation(\n"
    "    locale: $locale\n"
    "    phoneCountry: $phoneCountry\n"
    "    phoneNumber: $phoneNumber\n"
    "    token: $token\n"
    "  ) {\n"
    "    authId\n"
    "    challengeId\n"
    "    state\n"
    "    __typename\n"
    "  }\n"
    "}\n"
)

_OTP_CONFIRM_QUERY = (
    "mutation ConfirmRiskBasedTwoFactorPhoneConfirmationMutation"
    "($pin: String!, $authId: String!, $challengeId: String!, $token: String!) {\n"
    "  confirmRiskBasedTwoFactorPhoneConfirmation(\n"
    "    pin: $pin\n"
    "    authId: $authId\n"
    "    challengeId: $challengeId\n"
    "    token: $token\n"
    "  ) {\n"
    "    authId\n"
    "    challengeId\n"
    "    state\n"
    "    __typename\n"
    "  }\n"
    "}\n"
)

# SignUp mutation 的完整 GraphQL 文本（4.6 KB），从 HAR 1:1 抽出。PayPal 服务器
# 有 query hash / persisted query 缓存，``query`` 字段必须与浏览器抓到的完全一致，
# 不能压缩、不能改空白。我们把它放在独立 ``.gql`` 文件里以便可读性。
_SIGNUP_QUERY_PATH = pathlib.Path(__file__).with_name("paypal_signup_query.gql")
try:
    PAYPAL_SIGNUP_QUERY = _SIGNUP_QUERY_PATH.read_text(encoding="utf-8")
except OSError:  # pragma: no cover - 部署残缺时给个明确兜底
    PAYPAL_SIGNUP_QUERY = ""

# PayPal SignUp ``contentIdentifier`` —— HAR 跨多次抓包都是这个固定值，
# 是 ``compliance.signupTerms`` 的内容哈希。如果未来变了，从落地 HTML 抽。
PAYPAL_SIGNUP_CONTENT_ID = "US:en:a82b9b13c8467984669e58998312d14b:compliance.signupTerms"

# x-app-name 默认值。HAR 跨多次抓包对应阶段差异显著：
# * SignUp / OTP initiate / OTP confirm → ``checkoutuinodeweb_weasley``
#   （PayPal 新版 A/B 桶，**风控通过率高**，HAR 实采的成功 SignUp 全部用这个）
# * hermes ``cardTypes`` / ``authorize`` → ``checkoutuinodeweb``（旧版稳定）
#
# 旧实现统一用 ``checkoutuinodeweb`` → SignUp 端 PayPal 风控立刻识别"非 weasley 桶"
# 直接报 ``OAS_ERROR (createMemberAccount)``。所以现在分两个常量。
PAYPAL_X_APP_NAME = "checkoutuinodeweb"  # hermes 后段沿用（保持向后兼容）
PAYPAL_X_APP_NAME_SIGNUP = "checkoutuinodeweb_weasley"  # SignUp / OTP 三段必须用这个

# 静态 sitekey / publicKey —— HAR 里观察到这两个常量不随会话变化
HCAPTCHA_SITEKEY_PAYPAL = "bf07db68-5c2e-42e8-8779-ea8384890eea"
HCAPTCHA_PUBLIC_KEY = "884d15d9-b649-4bbb-8d1c-2d6f0eed75eb"


# ----- URL query 抽取 -----------------------------------------------------------


def extract_token_from_url(url: str, name: str) -> str:
    """从 URL query 抽指定 token（``ba_token`` / ``token`` / ``ec_token`` 等）。

    缺字段或值为空时抛 ``ValueError``。``name`` 严格匹配 query 字段名。
    """
    if not url:
        raise ValueError(f"无法从空 URL 抽取 {name}")
    parsed = urlparse(str(url))
    query = parse_qs(parsed.query)
    values = query.get(name) or []
    value = (values[0] if values else "").strip()
    if not value:
        raise ValueError(f"URL query 中缺少 {name}: {url!r}")
    return value


def extract_ba_token(url: str) -> str:
    """便捷封装：从 PayPal approve URL 抽 ``ba_token=BA-XXX``。"""
    return extract_token_from_url(url, "ba_token")


def extract_ec_token(url: str) -> str:
    """便捷封装：从 PayPal guest signup URL 抽 ``token=EC-XXX``（Express Checkout token）。"""
    return extract_token_from_url(url, "token")


# ----- HTML token 抽取 ---------------------------------------------------------


# PayPal 落地页里 _csrf / _sessionID 的常见出现形式。PayPal 在 2025-2026 改了
# Next.js SPA 序列化方式，字段名也变了；我们按观察到的形态按优先级匹配。
#
# csrf 真实形态（按出现概率排序）：
# 1) React server component 序列化里：``"x-csrf-token":"VALUE"`` （新形态，PayPal SPA）
# 2) inline JS / JSON：``"_csrf":"VALUE"``                       （旧形态）
# 3) meta 标签：``<meta name="_csrf" content="VALUE">``           （罕见）
# 4) data 属性：``data-csrf="VALUE"``                             （罕见）
# 注意：PayPal 把这些字段写在 React Server Component 序列化里（即 HTML body 里
# 的 ``self.__next_f.push(...)`` 调用），里面的 JSON 字符串会**再次被转义**，
# 所以原始 HTML 字节流里实际形态是 ``\"x-csrf-token\":\"VALUE\"``，引号前面
# 有一个 ``\``。正则用 ``\\?"`` 同时兼容字面引号（旧形态）和转义引号（新形态）。
_CSRF_PATTERNS = (
    re.compile(r'\\?"x-csrf-token\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
    re.compile(r'\\?"_csrf\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
    re.compile(r'<meta\s+name=["\']_csrf["\']\s+content=["\']([^"\']+)["\']', re.IGNORECASE),
    re.compile(r'data-csrf=["\']([^"\']+)["\']', re.IGNORECASE),
    re.compile(r'name=["\']_csrf["\']\s+value=["\']([^"\']+)["\']', re.IGNORECASE),
)

# ec_token（Express Checkout token, EC-XXX）的 HTML 兜底形态：
# 当 final_url 跟随 302 后**不带 token= query**（比如落到了 /pay 顶层而非
# /checkoutweb/signup），就从 HTML 里的 React server component 序列化抽。
# 实际形态：``\"ecToken\":\"EC-TEST-FIXTURE\"``（带转义引号）。
_EC_TOKEN_PATTERNS = (
    re.compile(r'\\?"ecToken\\?"\s*:\s*\\?"(EC-[A-Z0-9]+)\\?"'),
    re.compile(r'[?&]token=(EC-[A-Z0-9]+)'),
)


# sessionID（_sessionID / Nsid）真实形态：
# 1) hcaptchapassive.js script URL query：``..?_sessionID=VALUE`` （新形态最常见）
# 2) React server component 序列化里：``\"PayPal-Nsid\":\"VALUE\"`` （带转义引号）
# 3) inline JS / JSON：``"_sessionID":"VALUE"``                    （旧形态）
# 4) meta / data 属性                                              （罕见）
_SESSION_ID_PATTERNS = (
    re.compile(r'[?&]_sessionID=([A-Za-z0-9_\-]+)'),
    re.compile(r'\\?"PayPal-Nsid\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
    re.compile(r'\\?"_sessionID\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
    re.compile(r'<meta\s+name=["\']_sessionID["\']\s+content=["\']([^"\']+)["\']', re.IGNORECASE),
    re.compile(r'data-session-id=["\']([^"\']+)["\']', re.IGNORECASE),
    re.compile(r'name=["\']_sessionID["\']\s+value=["\']([^"\']+)["\']', re.IGNORECASE),
)


# OTP_CHALLENGE (getOtpChallengeOperation) 需要的两个 PayPal 服务端 token：
#   * ``csrfNonce``: ``AAH9...`` 风格，OTP 通道专用的 csrf
#   * ``ctxId``: ``AAEH...`` 风格，OTP context id（关联 SignUp / OTP 子链）
# 浏览器版从落地 HTML 的 React Server Component 序列化里读出来，原始形态有
# 转义反斜杠。我们按 csrf 的相同模式抽取（兼容旧/新两种形态）。
_CSRF_NONCE_PATTERNS = (
    re.compile(r'\\?"csrfNonce\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
    re.compile(r'\\?"otpCsrfNonce\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
)
_CTX_ID_PATTERNS = (
    re.compile(r'\\?"ctxId\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
    re.compile(r'\\?"otpCtxId\\?"\s*:\s*\\?"([^"\\]+)\\?"'),
)


def _first_match(html: str, patterns) -> str:
    for pat in patterns:
        m = pat.search(html or "")
        if m:
            value = (m.group(1) or "").strip()
            if value:
                return value
    return ""


def extract_paypal_csrf(html: str) -> str:
    """从 PayPal 落地 HTML 抽 ``_csrf``；找不到时抛 ``ValueError``。"""
    value = _first_match(html or "", _CSRF_PATTERNS)
    if not value:
        raise ValueError("HTML 中未找到 _csrf token")
    return value


def extract_paypal_session_id(html: str) -> str:
    """从 PayPal 落地 HTML 抽 ``_sessionID``；找不到时抛 ``ValueError``。"""
    value = _first_match(html or "", _SESSION_ID_PATTERNS)
    if not value:
        raise ValueError("HTML 中未找到 _sessionID")
    return value


def extract_otp_csrf_nonce(html: str) -> str:
    """从 PayPal 落地 HTML 抽 OTP 专用 ``csrfNonce`` (``AAH9...`` 风格)。

    没找到时返回空字符串（不抛异常）—— OTP_CHALLENGE 是协议链的可选预热步骤，
    抽不到时调用方可以选择跳过这一步走传统 OTP 链路。
    """
    return _first_match(html or "", _CSRF_NONCE_PATTERNS)


def extract_otp_ctx_id(html: str) -> str:
    """从 PayPal 落地 HTML 抽 OTP 专用 ``ctxId`` (``AAEH...`` 风格)。

    与 ``extract_otp_csrf_nonce`` 一样找不到时返回空（不抛异常）。
    """
    return _first_match(html or "", _CTX_ID_PATTERNS)


def extract_paypal_ec_token_from_html(html: str) -> str:
    """从 PayPal 落地 HTML 抽 ``ecToken``（EC-XXX 形式）；找不到返回空串。

    当 ``final_url`` 不带 ``token=`` query 时（比如 PayPal 跟随 302 落到了
    ``/pay`` 顶层 SPA 而不是 ``/checkoutweb/signup``），就要从 SSR HTML 里抽。
    """
    return _first_match(html or "", _EC_TOKEN_PATTERNS)


# ----- HTTP helpers ------------------------------------------------------------


def _paypal_headers(extra: Optional[dict] = None) -> dict:
    """PayPal 浏览器风格的基础 header。后续 stage 可在此基础上叠加。"""
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-User": "?1",
    }
    if extra:
        headers.update(extra)
    return headers


def paypal_get_approve(
    session,
    *,
    ba_token: str = "",
    redirect_url: str = "",
    referer: Optional[str] = None,
    timeout: int = 30,
) -> dict:
    """执行 PayPal Stage P1 落地 GET。

    支持两种入口（生产 vs 测试，二选一）：

    1. ``redirect_url`` —— **生产路径**。Stripe ``/confirm`` 返回的
       ``redirect_to_url.url`` 是 ``pm-redirects.stripe.com/authorize/...`` 这种
       中转 URL，**本身不含 ba_token**；必须 GET 它让 curl_cffi 跟随 302 chain
       一路落到 ``www.paypal.com/agreements/approve?ba_token=BA-XXX``，再到
       ``checkoutweb/signup?token=EC-XXX``。``ba_token`` 由本函数从 ``final_url``
       回写到结果字典里。
    2. ``ba_token`` —— **测试路径** / 已知 ba_token 的快路径。直接 GET
       ``/agreements/approve?ba_token=BA-XXX``。

    两者必须至少传一个。返回字段：

    * ``status_code`` — 最终响应码（通常 200，curl_cffi 已跟随 302）
    * ``final_url``  — 跟随完跳转后的最终 URL（可能附带 ``token=EC-XXX``）
    * ``html``       — 响应正文文本
    * ``ba_token``   — 优先 ``final_url`` 抽到的；否则回显入参；都拿不到为空串
    * ``ec_token``   — 若 ``final_url`` 携带 ``token=`` 则填入，否则空串

    任何异常都向上抛出，由 stage 层捕获。
    """
    if not ba_token and not redirect_url:
        raise ValueError("paypal_get_approve 需要 redirect_url 或 ba_token 二选一")

    headers = _paypal_headers({"Referer": referer} if referer else None)
    if redirect_url:
        # 生产路径：直接 GET pm-redirects 中转 URL，依赖 curl_cffi 跟随 302
        resp = session.get(
            redirect_url,
            headers=headers,
            timeout=timeout,
            allow_redirects=True,
        )
    else:
        # 快路径：已经知道 ba_token，直接打 paypal.com
        resp = session.get(
            f"{PAYPAL_BASE}{PAYPAL_APPROVE_PATH}",
            params={"ba_token": ba_token},
            headers=headers,
            timeout=timeout,
            allow_redirects=True,
        )
    if hasattr(resp, "raise_for_status"):
        try:
            resp.raise_for_status()
        except Exception as exc:
            # PayPal/Stripe 在 403 时通常返回 datadome challenge / WAF 拒绝页，body
            # 是 HTML。``raise_for_status`` 默认丢掉 body，这里改成把 status / final
            # URL（跟到哪一跳被拒的）/ content-type / body 前 512 字 / set-cookie
            # 重要 header 包进异常 args，便于 stage 层日志 dump 出来定位是 pm-redirects
            # 拦的还是 paypal.com 拦的。
            status = getattr(resp, "status_code", None)
            final_url_dbg = str(getattr(resp, "url", "") or redirect_url or "")
            text_attr = getattr(resp, "text", "") or ""
            body_text = text_attr if isinstance(text_attr, str) else ""
            headers_attr = getattr(resp, "headers", None) or {}
            content_type = ""
            paypal_debug_id = ""
            if hasattr(headers_attr, "get"):
                content_type = str(headers_attr.get("content-type") or headers_attr.get("Content-Type") or "")
                paypal_debug_id = str(
                    headers_attr.get("paypal-debug-id")
                    or headers_attr.get("Paypal-Debug-Id")
                    or ""
                )
            raise RuntimeError(
                f"PayPal approve HTTP {status} @ final_url={final_url_dbg[:160]!r} "
                f"content-type={content_type!r} paypal-debug-id={paypal_debug_id!r} "
                f"body_preview={body_text[:512]!r}"
            ) from exc

    final_url = str(getattr(resp, "url", "") or redirect_url or "")
    html = ""
    text_attr = getattr(resp, "text", None)
    if isinstance(text_attr, str):
        html = text_attr
    elif callable(text_attr):
        try:
            html = text_attr() or ""
        except Exception:
            html = ""

    # final_url 是 PayPal 落地后的 URL，里面通常同时带 ba_token 和 token=EC-XXX
    if not ba_token:
        try:
            ba_token = extract_ba_token(final_url)
        except ValueError:
            ba_token = ""

    # ec_token：优先从 final_url 的 ``token=`` query 抽；若 PayPal 跟随 302 后
    # 落到了不带 query 的 SPA 顶层（``/pay`` 等），就再从 SSR HTML 抽 ``ecToken``。
    ec_token = ""
    try:
        ec_token = extract_ec_token(final_url)
    except ValueError:
        ec_token = ""
    if not ec_token:
        ec_token = extract_paypal_ec_token_from_html(html)

    return {
        "status_code": getattr(resp, "status_code", 0),
        "final_url": final_url,
        "html": html,
        "ba_token": ba_token,
        "ec_token": ec_token,
    }


# ----- Stage P8: Hermes 兜底 URL ---------------------------------------------


# `Q0FSRF9HRU5FUklDX0VSUk9S` = base64.b64encode(b"CARD_GENERIC_ERROR")
# PayPal 服务器 SignUp addCard 失败后追加在 redirect URL 上，协议层直接复用。
_HERMES_REASON_CARD_GENERIC_ERROR = "Q0FSRF9HRU5FUklDX0VSUk9S"
_HERMES_PATH = "/webapps/hermes"


def build_hermes_url(
    *,
    ba_token: str,
    ec_token: str,
    locale: str = "en_US",
    country: str = "US",
    reason: str = _HERMES_REASON_CARD_GENERIC_ERROR,
) -> str:
    """构造 Hermes 兜底支付页 URL（Stage P8）。

    格式严格对齐 HAR 实采的 PayPal SignUp addCard 失败重定向：

        /webapps/hermes?ul=1&modxo_redirect_reason=guest_user
                      &ba_token=BA-XXX&locale.x=en_US&country.x=US
                      &token=EC-XXX&rcache=1&cookieBannerVariant=hidden
                      &fromSignupLite=true&addFIContingency=noretry
                      &redirectToHermes=true&fallback=1&reason=Q0FSRF...

    协议层直接 GET 这个 URL，PayPal 后端会用 Stage P1 落地建立的 cookies 识别
    出 EC token 对应的 BA，然后让前端继续 Stage P9 的 GraphQL 调用。
    """
    if not ba_token or not ec_token:
        raise ValueError("build_hermes_url 需要 ba_token 和 ec_token")
    # 顺序对 PayPal 服务器无所谓，但保持与 HAR 一致便于调试
    qs = (
        "ul=1"
        "&modxo_redirect_reason=guest_user"
        f"&ba_token={ba_token}"
        f"&locale.x={locale}"
        f"&country.x={country}"
        f"&token={ec_token}"
        "&rcache=1"
        "&cookieBannerVariant=hidden"
        "&fromSignupLite=true"
        "&addFIContingency=noretry"
        "&redirectToHermes=true"
        "&fallback=1"
        f"&reason={reason}"
    )
    return f"{PAYPAL_BASE}{_HERMES_PATH}?{qs}"


def paypal_get_hermes(
    session,
    *,
    hermes_url: str,
    referer: Optional[str] = None,
    timeout: int = 30,
) -> dict:
    """GET Hermes 兜底页，返回 ``{status_code, final_url, html}``。

    协议层不需要解析 HTML（Stage P9 的 GraphQL 调用并不依赖 hermes 页面里的 token，
    复用 Stage P1 拿到的 _csrf / _sessionID 即可），但仍要 GET 这次以触发 PayPal
    服务器初始化 hermes 上下文。
    """
    headers = _paypal_headers({"Referer": referer} if referer else None)
    resp = session.get(hermes_url, headers=headers, timeout=timeout, allow_redirects=True)
    if hasattr(resp, "raise_for_status"):
        resp.raise_for_status()

    final_url = str(getattr(resp, "url", "") or hermes_url)
    text_attr = getattr(resp, "text", "")
    html = text_attr if isinstance(text_attr, str) else ""
    return {
        "status_code": getattr(resp, "status_code", 0),
        "final_url": final_url,
        "html": html,
    }


# ----- Stage P9: GraphQL batch helpers (cardTypes / authorize) ---------------


# Hermes 走的是 ``/graphql/`` （**带尾斜杠**），与 SignUp 流的 ``/graphql`` 不同。
PAYPAL_GRAPHQL_BATCH_URL = f"{PAYPAL_BASE}/graphql/"


_CARD_TYPES_QUERY = (
    "query cardTypes($billingAgreementId: String!, $country: String!) "
    "{ billing { cardTypes(billingAgreementId: $billingAgreementId, country: $country) "
    "{ allowed subTypes __typename } __typename } }"
)


_AUTHORIZE_MUTATION = (
    "mutation authorize($billingAgreementId: String!, $addressId: String, "
    "$fundingPreference: billingFundingPreferenceInput, "
    "$legalAgreements: billingLegalAgreementsInput) "
    "{ billing { authorize(billingAgreementId: $billingAgreementId addressId: $addressId "
    "fundingPreference: $fundingPreference legalAgreements: $legalAgreements) "
    "{ billingAgreementToken paymentAction returnURL { href __typename } "
    "buyer { userId __typename } __typename } __typename } }"
)


def build_card_types_request(*, ec_token: str, country: str = "US") -> list:
    """构造 ``[ {operationName: cardTypes, variables, query} ]`` body。"""
    if not ec_token:
        raise ValueError("build_card_types_request 需要 ec_token")
    return [
        {
            "operationName": "cardTypes",
            "variables": {"billingAgreementId": ec_token, "country": country},
            "query": _CARD_TYPES_QUERY,
        }
    ]


def build_authorize_request(*, ec_token: str) -> list:
    """构造 hermes ``mutation authorize`` 的 batch body。``OPT_OUT`` 即纯 $0 授权。"""
    if not ec_token:
        raise ValueError("build_authorize_request 需要 ec_token")
    return [
        {
            "operationName": "authorize",
            "variables": {
                "billingAgreementId": ec_token,
                "fundingPreference": {"balancePreference": "OPT_OUT"},
                "legalAgreements": {},
            },
            "query": _AUTHORIZE_MUTATION,
        }
    ]


def _paypal_api_headers_base(referer: str) -> dict:
    """SignUp + hermes batch 两类 PayPal API 调用共用的浏览器风格 header 基线。"""
    return {
        "Origin": PAYPAL_BASE,
        "Referer": referer,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "X-Requested-With": "fetch",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }


def _graphql_headers(
    referer: str,
    *,
    euat: str = "",
    csrf: str = "",
    nsid: str = "",
    client_metadata_id: str = "",
    app_name: str = PAYPAL_X_APP_NAME,
    country: str = "US",
    locale: str = "en_US",
) -> dict:
    """构造 hermes ``/graphql/`` batch endpoint 用的 header。

    PayPal hermes endpoint 强校验以下 header（缺则 403 / 401）：

    * ``x-paypal-internal-euat`` —— 来自 SignUp 响应的 ``accessToken``
    * ``x-csrf-token`` / ``PayPal-Nsid`` —— 来自落地 HTML
    * ``PAYPAL-CLIENT-METADATA-ID`` —— 用 EC token 即可（HAR 实采）
    * ``x-app-name`` —— ``checkoutuinodeweb``

    任意 token 为空时不带该 header（保留向后兼容；离线测试时方便构造 mock）。
    """
    headers = _paypal_api_headers_base(referer)
    if euat:
        headers["x-paypal-internal-euat"] = euat
    if csrf:
        headers["x-csrf-token"] = csrf
    if nsid:
        headers["PayPal-Nsid"] = nsid
    if client_metadata_id:
        headers["PAYPAL-CLIENT-METADATA-ID"] = client_metadata_id
    if app_name:
        headers["x-app-name"] = app_name
    headers["x-country"] = country
    headers["x-locale"] = locale
    return headers


def paypal_graphql_batch(
    session,
    *,
    body: list,
    referer: str,
    euat: str = "",
    csrf: str = "",
    nsid: str = "",
    client_metadata_id: str = "",
    app_name: str = PAYPAL_X_APP_NAME,
    country: str = "US",
    locale: str = "en_US",
    timeout: int = 30,
) -> list:
    """POST 到 ``/graphql/``（hermes 用的批量端点），返回响应数组。

    PayPal 这条端点接收的是 GraphQL 批量数组（每元素一组 operation），响应也是
    数组。协议层把数组的第一个元素当主响应。
    """
    if not isinstance(body, list) or not body:
        raise ValueError("paypal_graphql_batch 需要非空数组 body")
    headers = _graphql_headers(
        referer,
        euat=euat,
        csrf=csrf,
        nsid=nsid,
        client_metadata_id=client_metadata_id,
        app_name=app_name,
        country=country,
        locale=locale,
    )
    resp = session.post(
        PAYPAL_GRAPHQL_BATCH_URL,
        json=body,
        headers=headers,
        timeout=timeout,
    )
    if hasattr(resp, "raise_for_status"):
        resp.raise_for_status()
    payload = resp.json() if hasattr(resp, "json") else None
    if not isinstance(payload, list) or not payload:
        raise ValueError(f"PayPal /graphql/ 响应不是非空数组: {type(payload).__name__}")
    return payload


def parse_authorize_response(payload: list) -> dict:
    """从 ``mutation authorize`` 批量响应里抽 ``returnURL.href`` 等关键字段。

    返回 ``{return_url, billing_agreement_token, payment_action, buyer_user_id}``。
    任何字段缺失都抛 ``ValueError``，调用方负责转 fallback。
    """
    if not isinstance(payload, list) or not payload:
        raise ValueError("authorize 响应必须是非空数组")
    first = payload[0] or {}
    errors = first.get("errors")
    if errors:
        # PayPal GraphQL 错误体形态：[{"message": "...", "errorData": {...}}]
        msgs = ", ".join(str((e or {}).get("message") or "") for e in errors if isinstance(e, dict))
        raise ValueError(f"authorize GraphQL 返回错误: {msgs}")
    auth = (((first.get("data") or {}).get("billing") or {}).get("authorize")) or {}
    return_url = str(((auth.get("returnURL") or {}).get("href") or "")).strip()
    if not return_url:
        raise ValueError("authorize 响应缺少 data.billing.authorize.returnURL.href")
    return {
        "return_url": return_url,
        "billing_agreement_token": str(auth.get("billingAgreementToken") or ""),
        "payment_action": str(auth.get("paymentAction") or ""),
        "buyer_user_id": str(((auth.get("buyer") or {}).get("userId") or "")),
    }


def parse_card_types_response(payload: list) -> list:
    """从 ``cardTypes`` 响应抽 ``allowed`` 列表；失败时返回空列表（这步对协议层不关键）。"""
    try:
        if not isinstance(payload, list) or not payload:
            return []
        types = (((payload[0].get("data") or {}).get("billing") or {}).get("cardTypes")) or {}
        allowed = types.get("allowed") or []
        return [str(t) for t in allowed if t]
    except Exception:
        return []


# ----- Stage P7: SignUpNewMemberMutation ------------------------------------
#
# PayPal $0 trial 流程里，``hermes`` / ``cardTypes`` / ``authorize`` 都需要
# ``x-paypal-internal-euat`` header。这个 token 唯一来源是 SignUp 调用响应：
# 即使卡 decline（``CARD_GENERIC_ERROR``），服务器仍然会下发 ``accessToken``
# 用于让 guest 用户继续走 hermes fallback。
#
# 因此协议层在 ``paypal_approve`` 之后必须显式触发 SignUp，把 fake card / email
# / billing 提交一次，从响应里抽 ``accessToken``。后续 stage 全用这个 euat。


def _signup_referer(*, ec_token: str, ba_token: str = "", locale: str = "en_US", country: str = "US") -> str:
    """构造 SignUp POST 用的 ``Referer``：``/checkoutweb/signup?...``。

    PayPal 服务器对 Referer 做来源校验，必须指向 SignUp SPA 页面（带 ec_token /
    ba_token），否则**会把请求路由成"页面访问"返回 SPA HTML 容器**（``content-type=
    text/html`` + 嵌入 ``pa.js``），而不是 GraphQL JSON。下游 ``resp.json()``
    解析失败抛 :class:`PaypalSignupResponseError`。

    实战证据：dump ``tools/captures/paypal_signup_rejected_1779717292.json``
    里 ``referer=https://www.paypal.com/agreements/approve?ba_token=...``（即
    ``paypal_approve`` 落地页的 URL）→ PayPal 回 SPA shell。换成本 helper 构造
    的 ``/checkoutweb/signup?...`` 才能让 PayPal 认为是合法的 SignUp 页内 fetch。
    """
    parts = [
        "ssrt=1",  # 不影响校验，给个占位避免空 query
        "ul=1",
        "modxo_redirect_reason=guest_user",
    ]
    if ba_token:
        parts.append(f"ba_token={ba_token}")
    parts.append(f"locale.x={locale}")
    parts.append(f"country.x={country}")
    parts.append(f"token={ec_token}")
    parts.append("rcache=1")
    parts.append("cookieBannerVariant=hidden")
    return f"{PAYPAL_BASE}/checkoutweb/signup?" + "&".join(parts)


# 公共别名：协议层（payment_protocol）需要在 SignUp 之前显式构造 referer，
# 避免误用 ``paypal_approve`` 阶段的 ``landing_url``（``/agreements/approve?...``）
# 当 SignUp Referer——那会触发 PayPal 路由成页面访问回 SPA HTML 容器。
build_signup_referer = _signup_referer


def paypal_get_signup_page(
    session,
    *,
    ec_token: str,
    ba_token: str = "",
    referer: str = "",
    locale: str = "en_US",
    country: str = "US",
    timeout: int = 30,
) -> dict:
    """GET PayPal SignUp 页面 (``/checkoutweb/signup?token=...&ba_token=...``)。

    **HAR 实采的浏览器从不直接 POST SignUp**——必先 GET 这一页让 PayPal 在
    response 里 ``Set-Cookie`` 关键 session-level cookies::

        ts_c=<77 chars>           # 时间戳锚 (PayPal 强校验)
        ts=<138 chars>            # 主时间戳 / 风控指纹
        x-pp-s=<50 chars>         # PayPal session 锚
        datadome=<128 chars>      # DataDome bot protection token
        ddgl=<1 char>             # DataDome ground level
        l7_az=<9 chars>           # PayPal layer-7 路由
        tsrce=...                 # tracking source（PayPal 重发 3 次）
        LANG=<10 chars>
        enforce_policy

    **跳过这次 GET** 直接 POST ``/graphql?SignUpNewMemberMutation`` 时，session
    里没有这批 cookie，PayPal WAF 路由成"页面访问"返回 SPA shell HTML
    （``content-type=text/html`` + 嵌入 ``pa.js``），下游 ``resp.json()`` 抛
    :class:`PaypalSignupResponseError`，paypal-debug-id 是新的（每次都不一样）。

    实战证据（按时间序）：

    * ``tools/captures/paypal_signup_rejected_1779717292.json`` —— Referer 错
      （``/agreements/approve?...``）+ 缺这次 GET。修 Referer 后还失败:
    * ``tools/captures/paypal_signup_rejected_1779718544.json`` —— Referer 已
      改对（``/checkoutweb/signup?...``），但仍回 SPA shell——证明 Referer 是
      必要但不充分条件，**还差这次 GET 来 set cookies**。
    * Sanitized ``checkout-example.har`` —— 浏览器在 ``/agreements/approve``
      之后 ``02:25:57`` 立刻 GET ``/checkoutweb/signup?ssrt=...&token=...``，
      response 里设了上述 11 个 cookie，之后所有 API 调用才能通过。

    返回 ``{status_code, final_url, set_cookies}``——``set_cookies`` 是 PayPal
    在响应里 set 的 cookie 名字列表，便于上层日志确认拿到了哪些关键 cookie。
    """
    url = _signup_referer(ec_token=ec_token, ba_token=ba_token, locale=locale, country=country)
    extra = {"Referer": referer} if referer else None
    headers = _paypal_headers(extra)
    resp = session.get(url, headers=headers, timeout=timeout, allow_redirects=True)
    if hasattr(resp, "raise_for_status"):
        resp.raise_for_status()

    # 收集 set-cookie 头里的 cookie 名（用于诊断），不存 value 避免 PII。
    # ``resp.cookies`` 是只包含**这次响应**新 set 的 cookie 的 jar（不是整个
    # session jar），刚好是我们要的"PayPal 这次 GET 给我们 set 了什么"。
    set_cookies: list[str] = []
    resp_cookies = getattr(resp, "cookies", None)
    if resp_cookies is not None:
        try:
            set_cookies = sorted({str(k) for k in resp_cookies.keys()})
        except Exception:
            set_cookies = []

    return {
        "status_code": int(getattr(resp, "status_code", 0) or 0),
        "final_url": str(getattr(resp, "url", "") or url),
        "set_cookies": set_cookies,
    }


def generate_paypal_cmid() -> str:
    """生成一个 PayPal ``paypal-client-metadata-id`` (CMID) 风格的随机 ID。

    真实浏览器里这个值由 PayPal ``fpti.js`` SDK 在 client 端动态生成，
    形态是 32 字节 hex（典型: ``a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6``）。
    每次刷新页面 / 每次新 session 都不一样，但**同一 session 内多次请求
    复用同一个 cmid**，对应 PayPal 风控里的 "device fingerprint scope"。

    协议模式没有浏览器 SDK，所以这里用 ``secrets`` 生成一个等长等格式的
    随机 ID。这样比直接复用 ``ec_token``（PayPal 风控很容易识别
    "cmid==ec_token" 这种字面相同的偷懒模式）有明显改善：单次 SignUp
    流程内的所有 GraphQL 请求都会带同一个稳定的 cmid，看起来像一个
    "页面级会话"。

    注意：单纯换 cmid 不一定能 100% 绕过风控（PayPal 还会通过 IP / cookie
    一致性 / TLS / UA 等多维度判断），但能消除 "cmid 字面与 ec_token
    完全一致" 这一最显著的协议特征。
    """
    return secrets.token_hex(16)


# HAR 实采里 OTP_CHALLENGE 用的 csrfNonce / ctxId 都是以 ``AA`` 开头的
# 88 字符 base64url-like 串。
# 第一位通常是 ``A``（前导 base64 的 ``0x00`` byte）—— PayPal 内部 token 都长这样。
# 88 字符 base64url ≈ 66 字节 entropy，但实际上前 2-3 字节经常是固定 type marker。
_OTP_NONCE_BYTES = 66  # 66 字节 → base64url 88 字符（无 padding）
_OTP_NONCE_LEADING = "AA"  # PayPal 实采前缀，配合后面 86 字符随机 base64url


def generate_otp_challenge_tokens() -> tuple[str, str]:
    """生成 ``(csrfNonce, ctxId)`` 一对 88 字符 base64url-like 占位 token。

    Background：
    HAR 实采里 ``getOtpChallengeOperation`` 的 ``csrfNonce`` / ``ctxId`` 是
    PayPal weasley JS bundle 在浏览器内存里**自生成**的 token，不会出现在任何
    HTTP 响应里——协议模式没办法复刻"真"值。但 entry 505 的服务端响应
    ``data.otp.getOtpChallenge.* = null`` + HTTP 200 表明 PayPal 服务器并**不
    严格校验**这两个 token 的内容，只校验存在性 / 长度（用来给 OTP context
    打 fraud 标记）。所以协议模式用随机 88 字符 base64url 占位即可让预热
    成功，进而让 OTP-Confirm 找到 challenge 而不报 PHONE_CONFIRMATION_NOT_INITIATED。

    返回的两个 token 各自独立随机（HAR 实采里 ``csrfNonce`` 与 ``ctxId`` 是
    不同值），前缀都是 ``AA`` 以贴近 HAR 实采的字符模式。
    """
    # 把 secrets.token_urlsafe 的结果裁到 88 字符；HAR 实采前缀 "AA" 配合 86
    # 字符随机 base64url，刚好 88 字符整。
    def _one() -> str:
        raw = secrets.token_urlsafe(_OTP_NONCE_BYTES)  # ≈ 88 字符
        # 把可能的 '=' 填充剥掉（token_urlsafe 不带 padding，但稳一手）
        raw = raw.rstrip("=")
        # 拼成稳定 88 字符 ``AA`` + 86 char random
        return (_OTP_NONCE_LEADING + raw)[:88]

    return _one(), _one()


def _signup_headers(
    *,
    referer: str,
    ec_token: str,
    client_metadata_id: str = "",
    app_name: str = PAYPAL_X_APP_NAME_SIGNUP,
    country: str = "US",
    locale: str = "en_US",
) -> dict:
    """SignUp ``POST /graphql?SignUpNewMemberMutation`` 专用 header（HAR 1:1）。

    ``client_metadata_id`` 显式传入时使用其值；为空时回退到 ``ec_token``
    （保持向后兼容，老调用 / 单元测试不受影响）。**协议模式建议总是显式
    传一个 ``generate_paypal_cmid()`` 的随机 cmid**，不要走 fallback，
    否则 PayPal 风控会立刻把请求归类为 "脚本伪装"。
    """
    headers = _paypal_api_headers_base(referer)
    cmid_value = (client_metadata_id or "").strip() or ec_token
    headers.update({
        "paypal-client-context": ec_token,
        "paypal-client-metadata-id": cmid_value,
        "x-app-name": app_name,
        "x-country": country,
        "x-locale": locale,
    })
    return headers


def build_signup_request(
    *,
    ec_token: str,
    card_number: str,
    card_expiration: str,
    card_cvc: str,
    email: str,
    first_name: str,
    last_name: str,
    phone_number: str,
    billing_line1: str,
    billing_line2: str,
    billing_city: str,
    billing_state: str,
    billing_postal_code: str,
    password: str,
    card_type: str = "VISA",
    phone_country_code: str = "1",
    country: str = "US",
    content_identifier: str = PAYPAL_SIGNUP_CONTENT_ID,
) -> dict:
    """构造 ``SignUpNewMemberMutation`` 的 POST body（含 variables + query）。

    返回的是单 GraphQL operation dict（不是 batch 数组），因为 SignUp endpoint
    走的是 ``/graphql?SignUpNewMemberMutation`` 而非 hermes 的 ``/graphql/``。

    所有字段都按 HAR 实采的浏览器 SignUp 表单 1:1 构造。``billingAddress`` 和
    ``shippingAddress`` 里的 ``familyName`` / ``givenName`` 与表单 ``firstName`` /
    ``lastName`` 同源，``shippingAddress`` 即使留空也要发（保留全部字段）。

    ``firstName`` 字段在浏览器 HAR 实际是 ``"FirstName LastName"`` 拼接（即同时
    含名+姓），``lastName`` 单独是姓；这里复用同样格式让 PayPal 校验稳定通过。
    """
    if not ec_token or not ec_token.startswith("EC-"):
        raise ValueError(f"ec_token 必须形如 EC-XXX: {ec_token!r}")
    if not PAYPAL_SIGNUP_QUERY:
        raise ValueError("PAYPAL_SIGNUP_QUERY 未加载（paypal_signup_query.gql 缺失）")

    # firstName 实际上是 "First Last"（HAR 验证），lastName 单独
    full_first_name = f"{first_name} {last_name}".strip()
    given_name = full_first_name

    variables: dict = {
        "card": {
            "cardNumber": card_number,
            "expirationDate": card_expiration,
            "securityCode": card_cvc,
            "type": card_type,
        },
        "country": country,
        "email": email,
        "firstName": full_first_name,
        "lastName": last_name,
        "phone": {
            "countryCode": phone_country_code,
            "number": phone_number,
            "type": "MOBILE",
        },
        "supportedThreeDsExperiences": ["IFRAME"],
        "token": ec_token,
        "billingAddress": {
            "line1": billing_line1,
            "line2": billing_line2,
            "city": billing_city,
            "state": billing_state,
            "postalCode": billing_postal_code,
            "accountQuality": {
                "autoCompleteType": "MANUAL",
                "isUserModified": True,
            },
            "country": country,
            "familyName": last_name,
            "givenName": given_name,
        },
        "shippingAddress": {
            "line1": "",
            "city": "",
            "state": "",
            "postalCode": "",
            "accountQuality": {
                "autoCompleteType": "MANUAL",
                "isUserModified": False,
            },
            "country": country,
            "familyName": last_name,
            "givenName": given_name,
        },
        "contentIdentifier": content_identifier,
        "marketingOptOut": False,
        "password": password,
        "crsData": None,
        "legalAgreements": {},
    }
    return {
        "operationName": "SignUpNewMemberMutation",
        "variables": variables,
        "query": PAYPAL_SIGNUP_QUERY,
    }


class PaypalSignupResponseError(RuntimeError):
    """``SignUpNewMemberMutation`` 收到非 JSON / 4xx / 空响应时抛出，携带诊断信息。

    PayPal 的 SignUp endpoint 在 challenge / device / cookie / beacon 链路不完整
    时**不会**返回标准 GraphQL 错误，而是回 HTML 页面（风控墙 / captcha 页 /
    login 页 / datadome challenge）。早期版本直接 ``resp.json()`` 抛
    ``JSONDecodeError("unexpected character: line 1 column 1 (char 0)")``，把
    所有诊断字段都丢了。

    这个异常类把 ``status / text 前 512 字 / paypal-debug-id / content-type``
    都包进来——配合上层的 dump 逻辑，能从用户日志反向定位"PayPal 到底拒了什么"
    （是风控页？captcha？login 跳转？datadome？）。

    设计上与 :class:`PaypalOtpChallengeRejected` 一致，方便上层统一处理。
    """

    def __init__(
        self,
        *,
        status: Optional[int],
        text: str,
        content_type: str,
        paypal_debug_id: str,
        cause: Optional[BaseException] = None,
        request_headers: Optional[dict] = None,
        response_headers: Optional[dict] = None,
    ) -> None:
        self.status = status
        self.text = text
        self.content_type = content_type
        self.paypal_debug_id = paypal_debug_id
        self.cause = cause
        # 我们发出去的请求头（让 dump 能看到 Referer / Sec-Fetch-* / x-app-name 等）
        self.request_headers: dict = dict(request_headers or {})
        # PayPal 响应头（包含 ``Set-Cookie`` —— 关键诊断！）
        self.response_headers: dict = dict(response_headers or {})
        super().__init__(
            f"SignUp rejected: status={status} "
            f"content_type={content_type!r} paypal-debug-id={paypal_debug_id!r} "
            f"text_preview={text[:160]!r}"
        )


def paypal_post_signup(
    session,
    *,
    body: dict,
    ec_token: str,
    ba_token: str = "",
    referer: str = "",
    client_metadata_id: str = "",
    app_name: str = PAYPAL_X_APP_NAME_SIGNUP,
    country: str = "US",
    locale: str = "en_US",
    timeout: int = 30,
) -> dict:
    """POST SignUp mutation 到 ``/graphql?SignUpNewMemberMutation``，返回 JSON 响应。

    ``referer`` 不传时会自动构造 ``/checkoutweb/signup?...`` 形式。
    ``client_metadata_id`` 显式传入即作为 ``paypal-client-metadata-id``
    header，**强烈推荐协议模式传一个 ``generate_paypal_cmid()`` 的随机值**
    以避免被 PayPal 风控通过 cmid==ec_token 的字面模式识别。

    返回服务器解析后的 JSON dict（非空）。

    PayPal 拒绝时（4xx / 200 + HTML / 空 body / 非 dict JSON）抛
    :class:`PaypalSignupResponseError`，携带 ``status / text 前 512 字 /
    paypal-debug-id / content-type``，便于上层日志 dump 定位 "PayPal 到底拒了
    什么"（早期版本直接 ``resp.json()`` 抛 ``JSONDecodeError`` 丢失所有诊断）。
    """
    if not isinstance(body, Mapping) or not body:
        raise ValueError("paypal_post_signup 需要非空 dict body")
    if not referer:
        referer = _signup_referer(ec_token=ec_token, ba_token=ba_token, locale=locale, country=country)
    headers = _signup_headers(
        referer=referer,
        ec_token=ec_token,
        client_metadata_id=client_metadata_id,
        app_name=app_name,
        country=country,
        locale=locale,
    )
    resp = session.post(PAYPAL_SIGNUP_URL, json=body, headers=headers, timeout=timeout)

    # 先采集诊断信息（无论是否要抛异常都会用到）。模式与 paypal_post_otp_challenge
    # 一致——PayPal 在 challenge/device/cookie 链路不完整时会回 HTML 风控页，
    # ``status / content-type / paypal-debug-id / text_preview`` 是定位"哪个
    # 链路缺失"的关键四元组。
    status = getattr(resp, "status_code", None)
    raw_text = getattr(resp, "text", "") or ""
    headers_attr = getattr(resp, "headers", None) or {}
    if hasattr(headers_attr, "get"):
        content_type = str(headers_attr.get("content-type") or headers_attr.get("Content-Type") or "")
        debug_id = str(headers_attr.get("paypal-debug-id") or headers_attr.get("Paypal-Debug-Id") or "")
    else:
        content_type, debug_id = "", ""

    # 诊断：把完整响应头抓下来（含 ``Set-Cookie``）。指针块设计上不包含 cookie value
    # 本身，由上层 protocol 代码从 session.cookies 快照取名字。
    resp_headers_dict: dict = {}
    if hasattr(headers_attr, "items"):
        try:
            resp_headers_dict = {str(k): str(v) for k, v in headers_attr.items()}
        except Exception:
            resp_headers_dict = {}

    if hasattr(resp, "raise_for_status"):
        try:
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001 — HTTP 4xx/5xx
            raise PaypalSignupResponseError(
                status=status, text=raw_text[:512],
                content_type=content_type, paypal_debug_id=debug_id, cause=exc,
                request_headers=headers, response_headers=resp_headers_dict,
            ) from exc

    try:
        payload = resp.json() if hasattr(resp, "json") else None
    except Exception as exc:  # noqa: BLE001 — JSONDecodeError（HTML 风控页 / 空 body）
        raise PaypalSignupResponseError(
            status=status, text=raw_text[:512],
            content_type=content_type, paypal_debug_id=debug_id, cause=exc,
            request_headers=headers, response_headers=resp_headers_dict,
        ) from exc
    if not isinstance(payload, dict) or not payload:
        raise PaypalSignupResponseError(
            status=status, text=raw_text[:512],
            content_type=content_type, paypal_debug_id=debug_id,
            cause=ValueError(f"PayPal SignUp 响应不是非空 dict: {type(payload).__name__}"),
            request_headers=headers, response_headers=resp_headers_dict,
        )
    return payload


def parse_signup_access_token(payload: dict) -> str:
    """从 SignUp 响应抽 ``accessToken`` （即 ``x-paypal-internal-euat``）。

    HAR 实采响应形态（卡 decline 但仍下发 token）::

        {
          "errors": [{
            "message": "ISSUER_DECLINE",
            "errorData": {
              "0": {"code": "CARD_GENERIC_ERROR"},
              "accessToken": "S23AAM..."          ← 我们要的
            },
            "contingency": true,
            ...
          }],
          "data": {"onboardAccount": null}
        }

    PayPal 也可能在 ``data.signUpNewMember.accessToken`` 里给（卡真过的情况），
    我们两条路径都尝试，找到非空就返回。找不到抛 ``ValueError``。
    """
    if not isinstance(payload, dict):
        raise ValueError("SignUp 响应不是 dict")

    # 路径 1：errors[].errorData.accessToken（HAR 卡 decline 路径）
    for err in payload.get("errors") or []:
        if not isinstance(err, dict):
            continue
        token = ((err.get("errorData") or {}).get("accessToken") or "").strip()
        if token:
            return token

    # 路径 2：data.signUpNewMember.accessToken / data.onboardAccount.accessToken
    data = payload.get("data") or {}
    for key in ("signUpNewMember", "onboardAccount"):
        node = data.get(key) or {}
        token = (node.get("accessToken") or "").strip() if isinstance(node, dict) else ""
        if token:
            return token

    raise ValueError("SignUp 响应里未找到 accessToken（errors[].errorData.accessToken / data.*.accessToken 都为空）")


# ----- Stage P7-OTP: InitiateRiskBasedTwoFactorPhoneConfirmationMutation -----
#
# 流程参考 HAR `tests/fixtures/paypal_otp_initiate_har.json`：
# - URL: POST /graphql?InitiateRiskBasedTwoFactorPhoneConfirmationMutation
# - 同 SignUp 一样走 single-op POST（不是 hermes 的 array batch）
# - variables: {locale: {country, lang}, phoneCountry, phoneNumber, token: ec_token}
# - 响应: data.initiateRiskBasedTwoFactorPhoneConfirmation = {authId, challengeId, state="PENDING"}


def build_otp_initiate_request(
    *,
    ec_token: str,
    phone_number_local: str,
    phone_country: str = "US",
    locale_country: str = "US",
    locale_lang: str = "en",
) -> dict:
    """构造 ``InitiateRiskBasedTwoFactorPhoneConfirmationMutation`` 的 POST body。

    ``phone_number_local`` 必须是**不含国家码**的本地号码；调用方需要先从
    E.164 号码里剥掉国家码。
    """
    if not ec_token or not ec_token.startswith("EC-"):
        raise ValueError(f"ec_token 必须形如 EC-XXX: {ec_token!r}")
    if not phone_number_local or not str(phone_number_local).isdigit():
        raise ValueError(f"phone_number_local 必须是纯数字本地号码: {phone_number_local!r}")
    return {
        "operationName": "InitiateRiskBasedTwoFactorPhoneConfirmationMutation",
        "variables": {
            "locale": {"country": locale_country, "lang": locale_lang},
            "phoneCountry": phone_country,
            "phoneNumber": str(phone_number_local),
            "token": ec_token,
        },
        "query": _OTP_INITIATE_QUERY,
    }


def paypal_post_otp_initiate(
    session,
    *,
    body: dict,
    ec_token: str,
    ba_token: str = "",
    referer: str = "",
    client_metadata_id: str = "",
    app_name: str = PAYPAL_X_APP_NAME_SIGNUP,
    country: str = "US",
    locale: str = "en_US",
    timeout: int = 30,
) -> dict:
    """POST OTP initiate 到 PayPal，返回 JSON dict 响应。

    复用 ``_signup_headers``（headers 完全一致：同源 endpoint），仅 URL / body 不同。
    协议模式建议显式传 ``client_metadata_id``（同一 session 内的 SignUp / OTP
    应当共享同一个 cmid，模拟浏览器内 SDK 行为）。
    """
    if not isinstance(body, Mapping) or not body:
        raise ValueError("paypal_post_otp_initiate 需要非空 dict body")
    if not referer:
        referer = _signup_referer(ec_token=ec_token, ba_token=ba_token, locale=locale, country=country)
    headers = _signup_headers(
        referer=referer, ec_token=ec_token, client_metadata_id=client_metadata_id,
        app_name=app_name, country=country, locale=locale,
    )
    resp = session.post(PAYPAL_OTP_INITIATE_URL, json=body, headers=headers, timeout=timeout)
    if hasattr(resp, "raise_for_status"):
        resp.raise_for_status()
    payload = resp.json() if hasattr(resp, "json") else None
    if not isinstance(payload, dict) or not payload:
        raise ValueError(f"PayPal OTP initiate 响应不是非空 dict: {type(payload).__name__}")
    return payload


def parse_otp_initiate_response(payload: dict) -> tuple[str, str, str]:
    """从 initiate 响应里抽 ``(authId, challengeId, state)``。

    响应结构示例::

        {"data": {"initiateRiskBasedTwoFactorPhoneConfirmation": {
            "authId": "example-auth-id",
            "challengeId": "example-challenge-id",
            "state": "PENDING"
        }}}

    缺字段或不是 dict 时抛 ``ValueError`` 把响应摘要带回给调用方。
    """
    if not isinstance(payload, dict):
        raise ValueError("OTP initiate 响应不是 dict")
    data = (payload.get("data") or {}).get("initiateRiskBasedTwoFactorPhoneConfirmation") or {}
    auth_id = str(data.get("authId") or "").strip()
    challenge_id = str(data.get("challengeId") or "").strip()
    state = str(data.get("state") or "").strip()
    if not auth_id or not challenge_id:
        # 把可能的 errors 信息一起带回，便于排查 PayPal 风控拒绝
        errs = payload.get("errors") or []
        first_err = ""
        if errs and isinstance(errs[0], dict):
            first_err = str(errs[0].get("message") or "")
        raise ValueError(
            f"OTP initiate 响应缺 authId/challengeId; first_error={first_err!r}; "
            f"raw_data={data!r}"
        )
    return auth_id, challenge_id, state


# ----- Stage P7-OTP: ConfirmRiskBasedTwoFactorPhoneConfirmationMutation ------


def build_otp_confirm_request(
    *,
    ec_token: str,
    auth_id: str,
    challenge_id: str,
    pin: str,
) -> dict:
    """构造 ``ConfirmRiskBasedTwoFactorPhoneConfirmationMutation`` 的 POST body。

    ``pin`` 是从 SMS API 拉到的 6 位数字 OTP code。
    """
    if not ec_token or not ec_token.startswith("EC-"):
        raise ValueError(f"ec_token 必须形如 EC-XXX: {ec_token!r}")
    if not auth_id or not challenge_id:
        raise ValueError(f"auth_id / challenge_id 不能为空: {auth_id!r}, {challenge_id!r}")
    pin = str(pin or "").strip()
    if not pin.isdigit() or not (4 <= len(pin) <= 8):
        raise ValueError(f"pin 必须是 4-8 位纯数字: {pin!r}")
    return {
        "operationName": "ConfirmRiskBasedTwoFactorPhoneConfirmationMutation",
        "variables": {
            "authId": str(auth_id),
            "challengeId": str(challenge_id),
            "pin": pin,
            "token": ec_token,
        },
        "query": _OTP_CONFIRM_QUERY,
    }


def paypal_post_otp_confirm(
    session,
    *,
    body: dict,
    ec_token: str,
    ba_token: str = "",
    referer: str = "",
    client_metadata_id: str = "",
    app_name: str = PAYPAL_X_APP_NAME_SIGNUP,
    country: str = "US",
    locale: str = "en_US",
    timeout: int = 30,
) -> dict:
    """POST OTP confirm 到 PayPal，返回 JSON dict 响应。复用 ``_signup_headers``。

    协议模式建议显式传 ``client_metadata_id`` 与同 session 的 SignUp / OTP initiate
    保持一致。
    """
    if not isinstance(body, Mapping) or not body:
        raise ValueError("paypal_post_otp_confirm 需要非空 dict body")
    if not referer:
        referer = _signup_referer(ec_token=ec_token, ba_token=ba_token, locale=locale, country=country)
    headers = _signup_headers(
        referer=referer, ec_token=ec_token, client_metadata_id=client_metadata_id,
        app_name=app_name, country=country, locale=locale,
    )
    resp = session.post(PAYPAL_OTP_CONFIRM_URL, json=body, headers=headers, timeout=timeout)
    if hasattr(resp, "raise_for_status"):
        resp.raise_for_status()
    payload = resp.json() if hasattr(resp, "json") else None
    if not isinstance(payload, dict) or not payload:
        raise ValueError(f"PayPal OTP confirm 响应不是非空 dict: {type(payload).__name__}")
    return payload


def parse_otp_confirm_response(payload: dict) -> str:
    """从 confirm 响应抽 ``state`` 字段（成功应为 ``"CONFIRMED"``）。

    HAR 实采响应::

        {"data": {"confirmRiskBasedTwoFactorPhoneConfirmation": {
            "authId": null,         ← 注意此时已清空
            "challengeId": null,
            "state": "CONFIRMED"    ← 关键
        }}}

    state 不是 ``"CONFIRMED"`` 时抛 ``ValueError`` 让调用方决定是否重试 / fallback。
    """
    if not isinstance(payload, dict):
        raise ValueError("OTP confirm 响应不是 dict")
    data = (payload.get("data") or {}).get("confirmRiskBasedTwoFactorPhoneConfirmation") or {}
    state = str(data.get("state") or "").strip()
    if state != "CONFIRMED":
        errs = payload.get("errors") or []
        first_err = ""
        if errs and isinstance(errs[0], dict):
            first_err = str(errs[0].get("message") or "")
        raise ValueError(
            f"OTP confirm 未通过；state={state!r} first_error={first_err!r}"
        )
    return state


# ----- Stage P6-PREHEAT: getOtpChallengeOperation (OTP_CHALLENGE) -------------
#
# HAR 实采里浏览器在 OTP initiate 之前会**先发**这个请求到 ``/idapps/graphql``。
# 服务端响应里通常都是 ``publicCredential / nonce / challenges`` 全空，但**这
# 个请求本身就是风控关键**：它向 PayPal 注册 "我准备做 OTP 了，这是我的设备
# 指纹 (rData)，这是 OTP context (ctxId)"，让 PayPal 把 SignUp 主链与 OTP
# 子链关联起来。
#
# 协议模式漏发这个请求时，PayPal 在 OTP confirm 之后的 SignUp retry 阶段会
# 判定 "OTP 阶段没有设备指纹注册" → 直接报 ``OAS_ERROR (createMemberAccount)``。

# 浏览器版 rData 里 fn_sync_data 的字段，绝大多数是固定模板（HAR 跨多次抓包不变）。
# 这里复用 HAR 实采的浏览器风格，但 ``f`` (=ec_token) / ``ts`` (=当前毫秒时间戳)
# 必须按 session 动态填。
_OTP_CHALLENGE_FN_SYNC_TEMPLATE = {
    "SC_VERSION": "2.0.4",
    "syncStatus": "data",
    "f": "",                       # 由调用方填 ec_token
    "s": "IWC_LOGIN_APP",
    "chk": {
        "ts": 0,                   # 由调用方填当前毫秒
        "eteid": [None, None, None, None, None, None, None, None],
        "tts": 0,
    },
    # `dc` 字段在 HAR 里是再次 JSON-stringify 的 device context（screen / ua）。
    # 这里默认 1080p Firefox 135 桌面（与 ``_DEFAULT_USER_AGENT`` 一致）。
    "dc": (
        '{"screen":{"colorDepth":24,"pixelDepth":24,"height":1080,"width":1920,'
        '"availHeight":1040,"availWidth":1920},'
        '"ua":"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) '
        'Gecko/20100101 Firefox/135.0"}'
    ),
    "wv": False,
    "web_integration_type": "WEB_REDIRECT",
    "cookie_enabled": True,
}


def build_otp_challenge_request(
    *,
    ec_token: str,
    email: str,
    csrf_nonce: str,
    ctx_id: str,
    timestamp_ms: Optional[int] = None,
) -> dict:
    """构造 ``getOtpChallengeOperation`` 的 POST body。

    HAR 1:1 复刻：``clientInfo.rData`` 是 url-encoded JSON（fn_sync_data 内还有
    一层 JSON）。``csrfNonce`` 和 ``ctxId`` 必须从落地页 HTML 抽出来 —— 这两个
    字段是 PayPal 服务端给的 token，协议模式构造不出，**抽不到只能跳过预热**。

    ``timestamp_ms`` 不传时用当前时间。
    """
    import json
    import time
    from urllib.parse import quote

    if not ec_token or not ec_token.startswith("EC-"):
        raise ValueError(f"ec_token 必须形如 EC-XXX: {ec_token!r}")
    if not email or "@" not in email:
        raise ValueError(f"email 必须是有效邮箱: {email!r}")
    if not csrf_nonce:
        raise ValueError("csrfNonce 不能为空（OTP_CHALLENGE 必须的 PayPal 服务端 token）")
    if not ctx_id:
        raise ValueError("ctxId 不能为空（OTP_CHALLENGE 必须的 PayPal 服务端 token）")

    ts = int(timestamp_ms or (time.time() * 1000))
    fn_sync = dict(_OTP_CHALLENGE_FN_SYNC_TEMPLATE)
    fn_sync["f"] = ec_token
    fn_sync["chk"] = dict(fn_sync["chk"])
    fn_sync["chk"]["ts"] = ts
    fn_sync_json = json.dumps(fn_sync, separators=(",", ":"))

    # rData 是一个外层 JSON，里面有 fn_sync_data 字段（再次 url-encoded JSON 字符串）。
    # HAR 里 rData 整体被 url-encode **两次**（外层一次、内层 fn_sync_data 内再嵌套
    # 一次）。这里我们按照同样的双层编码生成。
    rdata_dict = {"fn_sync_data": fn_sync_json}
    rdata_json = json.dumps(rdata_dict, separators=(",", ":"))
    rdata = quote(rdata_json, safe="")

    return {
        "operationName": "getOtpChallengeOperation",
        "query": "",
        "csrfNonce": csrf_nonce,
        "variables": {
            "clientInfo": {
                "fnId": ec_token,
                "ctxId": ctx_id,
                "rData": rdata,
            },
            "credentials": {
                "credentialValue": email,
                "credentialType": "EMAIL",
            },
            "challengeInfo": {"autoSmsOtp": False},
        },
        "fn_sync_data": quote(fn_sync_json, safe=""),
    }


class PaypalOtpChallengeRejected(RuntimeError):
    """OTP_CHALLENGE 预热被 PayPal 拒绝时抛出，携带响应诊断信息。

    协议模式发的 ``getOtpChallengeOperation`` 预热请求里 ``csrfNonce`` / ``ctxId``
    是占位 token，PayPal 服务端可能：

    * 直接 4xx + JSON 错误（``raise_for_status`` 抛）
    * 返回 200 但 body 非 JSON（datadome challenge HTML / 空 body / fraud 拒绝页）
    * 返回 200 + JSON，但 ``data.otp.getOtpChallenge`` 全 null（HAR 实采的正常成功）

    这个异常类把 ``status / text 前 512 字 / paypal-debug-id / content-type``
    都包进来，方便上层日志 dump 出来定位"PayPal 到底拒了什么"。
    """

    def __init__(
        self,
        *,
        status: Optional[int],
        text: str,
        content_type: str,
        paypal_debug_id: str,
        cause: Optional[BaseException] = None,
        request_headers: Optional[dict] = None,
        response_headers: Optional[dict] = None,
    ) -> None:
        self.status = status
        self.text = text
        self.content_type = content_type
        self.paypal_debug_id = paypal_debug_id
        self.cause = cause
        # 我们发出去的请求头（含 Origin / x-app-name / **应当 pop 掉的 Referer**
        # —— dump 时反查能确认 referer 真的没漏带）
        self.request_headers: dict = dict(request_headers or {})
        # PayPal 响应头（含 ``Set-Cookie`` —— 看 PayPal 想给我们 set 哪些
        # cookie，能判定它认为我们当前是哪种 session state）
        self.response_headers: dict = dict(response_headers or {})
        super().__init__(
            f"OTP_CHALLENGE rejected: status={status} "
            f"content_type={content_type!r} paypal-debug-id={paypal_debug_id!r} "
            f"text_preview={text[:160]!r}"
        )


def paypal_post_weasley_logger(
    session,
    *,
    referer: str,
    timeout: int = 15,
    flow: str = "guest-xo-signup",
    page: str = "main:xo:lite:weasley:billing",
    release_date: str = "5/13",
) -> bool:
    """POST 一次 weasley metric/logger，让 PayPal 下发 ``tsrce=checkoutuinodeweb_weasley`` cookie。

    这是协议模式跑通 OTP_CHALLENGE/INITIATE/CONFIRM 的**必要前置**：没有这个
    cookie，PayPal 会把 ``/idapps/graphql`` 的 OTP_CHALLENGE 当页面访问返回 HTML，
    后续 OTP_CONFIRM 必报 ``PHONE_CONFIRMATION_NOT_INITIATED``。

    请求 body 是 weasley SDK 内部 ``start_application`` 埋点（HAR 实采 1:1 复刻），
    PayPal 服务端**不校验 body 内容**——只要请求落地到这个 endpoint + 带正确的
    ``x-app-name: checkoutuinodeweb_weasley`` header，响应就会 Set-Cookie。

    返回 ``True`` 表示请求成功（``status 2xx``，cookie 已写入 session）。异常时
    返回 ``False``，不抛——这是非阻塞的"尽力而为"预热步骤，失败不应中断 OTP 流程。
    """
    body = {
        "metrics": [
            {
                "dimensions": {
                    "clientApp": "weasley",
                    "errorReason": "None",
                    "flow": flow,
                    "interaction": "start_application",
                    "page": page,
                    "releaseDate": release_date,
                    "status": "Start",
                },
                "metricEventName": "n/a",
                "metricNamespace": "pp.xo.ci.count",
            }
        ]
    }
    headers = _paypal_api_headers_base(referer)
    headers.update({
        "Content-Type": "application/json",
        "x-app-name": PAYPAL_X_APP_NAME_SIGNUP,  # "checkoutuinodeweb_weasley"
        "Origin": PAYPAL_BASE,
    })
    try:
        resp = session.post(
            PAYPAL_WEASLEY_LOGGER_URL, json=body, headers=headers, timeout=timeout,
        )
        status = getattr(resp, "status_code", 0)
        return 200 <= status < 300
    except Exception:  # noqa: BLE001
        return False


def paypal_post_otp_challenge(
    session,
    *,
    body: dict,
    referer: str,
    timeout: int = 30,
) -> dict:
    """POST OTP_CHALLENGE 预热到 ``/idapps/graphql``，返回 JSON dict 响应。

    headers 与 SignUp 系不同（这是 idapps 子域），但仍走同一个 ``Origin``。
    响应里通常 ``data.otp.getOtpChallenge`` 各字段都是 null —— 这是正常的，
    服务器只是登记 "客户端正在做 OTP"，不下发额外 challenge。

    PayPal 拒绝预热时抛 :class:`PaypalOtpChallengeRejected`（携带状态码 / 响应
    文本前 512 字 / paypal-debug-id），便于上层 dump 诊断。
    """
    if not isinstance(body, Mapping) or not body:
        raise ValueError("paypal_post_otp_challenge 需要非空 dict body")

    headers = _paypal_api_headers_base(referer)
    headers.update({
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
        "Origin": PAYPAL_BASE,
    })
    # 关键：``/idapps/graphql`` endpoint 对 Referer 路径敏感。HAR 实采的浏览器
    # 成功请求（entry 505）**没有 Referer header**——浏览器内 PayPal weasley
    # SDK 显式以 ``Referrer-Policy: no-referrer`` 发起 fetch。如果带上指向
    # ``/checkoutweb/signup?...`` 的 Referer，PayPal 会把请求识别为"页面访问"
    # 而不是 API 调用，返回嵌入 ``pa.js`` 的 HTML 容器（content-type=text/html），
    # 客户端 JSONDecodeError，且服务端不会建立 OTP fraud context（导致后续
    # OTP-Confirm 报 ``VALIDATION_FAILED``）。所以这里**显式删掉 Referer**。
    headers.pop("Referer", None)
    resp = session.post(PAYPAL_OTP_CHALLENGE_URL, json=body, headers=headers, timeout=timeout)

    # 提取诊断信息（无论后面是不是要抛异常，都先采集）
    status = getattr(resp, "status_code", None)
    raw_text = getattr(resp, "text", "") or ""
    headers_attr = getattr(resp, "headers", None) or {}
    if hasattr(headers_attr, "get"):
        content_type = str(headers_attr.get("content-type") or headers_attr.get("Content-Type") or "")
        debug_id = str(headers_attr.get("paypal-debug-id") or headers_attr.get("Paypal-Debug-Id") or "")
    else:
        content_type, debug_id = "", ""

    # 诊断：响应头快照（含 ``Set-Cookie``，让 dump 能读出 PayPal 想 set 哪些 cookie）。
    resp_headers_dict: dict = {}
    if hasattr(headers_attr, "items"):
        try:
            resp_headers_dict = {str(k): str(v) for k, v in headers_attr.items()}
        except Exception:
            resp_headers_dict = {}

    if hasattr(resp, "raise_for_status"):
        try:
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            raise PaypalOtpChallengeRejected(
                status=status, text=raw_text[:512],
                content_type=content_type, paypal_debug_id=debug_id, cause=exc,
                request_headers=headers, response_headers=resp_headers_dict,
            ) from exc

    try:
        payload = resp.json() if hasattr(resp, "json") else None
    except Exception as exc:  # noqa: BLE001 — JSONDecodeError etc.
        raise PaypalOtpChallengeRejected(
            status=status, text=raw_text[:512],
            content_type=content_type, paypal_debug_id=debug_id, cause=exc,
            request_headers=headers, response_headers=resp_headers_dict,
        ) from exc
    if not isinstance(payload, dict) or not payload:
        raise PaypalOtpChallengeRejected(
            status=status, text=raw_text[:512],
            content_type=content_type, paypal_debug_id=debug_id,
            cause=ValueError(f"PayPal OTP challenge 响应不是非空 dict: {type(payload).__name__}"),
            request_headers=headers, response_headers=resp_headers_dict,
        )
    return payload
