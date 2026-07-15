"""PayPal fraudnet (magnes / DFP) device session 协议化注册。

# 为什么需要这个模块

PayPal SignUp (createMemberAccount) 在 ``OAS_ERROR`` checkpoint 上拒绝的最常见
根因是：PayPal 后端用 ``ec_token`` 作为 fraudnet record 的索引 key，但浏览器
正常流程会在 OTP 之前先向 ``c.paypal.com/v1/r/d/b/*`` 发一系列 device fingerprint
POST 把 record 建好——协议模式跳过这一步，PayPal 后端反查时找不到 record →
``OAS_ERROR``。

本模块用一次性抓到的真实成功 HAR (``paypal_fraudnet_baseline.json``) 作为
device fingerprint 模板，只把 ``correlationId`` / ``URL`` / ``time`` / ``corrId``
这几个跟当前会话强相关的字段替换成实时值，其他指纹（screen / navigator /
canvas / webgl / fonts / dfp）保持 baseline——PayPal fraudnet 后端是统计性收集
而非强校验"每次都不同"，复用一套合理的 Win10 + Firefox 135 指纹够稳。

# 调用时机

在 OTP_CHALLENGE 预热**之前**、weasley logger 预热**之后**调用：

::

    weasley logger 预热              ← 给 session 下发 tsrce cookie
    fraudnet device session 注册     ← **本模块**，把 ec_token 写入后端 fraudnet record
    OTP_CHALLENGE 预热               ← 建立 OTP fraud session
    OTP_INITIATE / CONFIRM
    SignUpNewMemberMutation          ← PayPal 后端反查 fraudnet record → 找到 → 放行

# 容错

fraudnet POST 任何一个失败都不阻塞主流程——device record 建得"不完整"也比
"完全空"强，PayPal 风控可能从 mild risk 降到 partial risk（仍可能 OAS_ERROR
但概率显著降低）。所有错误只 log。
"""
from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Callable, Optional


# ----- 常量 ------------------------------------------------------------------

FRAUDNET_HOST = "https://c.paypal.com"
FRAUDNET_P1_URL = f"{FRAUDNET_HOST}/v1/r/d/b/p1"
FRAUDNET_P2_URL = f"{FRAUDNET_HOST}/v1/r/d/b/p2"
FRAUDNET_PA_URL = f"{FRAUDNET_HOST}/v1/r/d/b/pa"
FRAUDNET_P3_URL_TMPL = f"{FRAUDNET_HOST}/v1/r/d/b/p3"
FRAUDNET_W_URL_TMPL = f"{FRAUDNET_HOST}/v1/r/d/b/w"

# HAR 实采的 Referer，让 PayPal fraudnet 后端认为请求来自 fraudnet collector iframe
FRAUDNET_REFERER = f"{FRAUDNET_HOST}/v1/r/d/i?js_src={FRAUDNET_HOST}/da/r/fb.js"

# IWC_LOGIN_APP 是 guest signup 流程的 fraudnet app id（HAR 实采），不是
# billing 阶段用的 BILLINGUINODEWEB_*。createMemberAccount 风控只认 IWC_LOGIN_APP
# 这套 record，所以**不能改**。
DEFAULT_APP_ID = "IWC_LOGIN_APP"

# baseline JSON 路径（与本模块同目录）
_BASELINE_PATH = Path(__file__).resolve().parent / "paypal_fraudnet_baseline.json"
_BASELINE_CACHE: Optional[dict] = None


# ----- helpers ---------------------------------------------------------------

def _load_baseline() -> dict:
    """加载并缓存 baseline JSON（从一次真实成功 HAR 抽出的 p1/p2/pa body）。

    使用模块级 LRU 缓存（_BASELINE_CACHE），避免每次注册都重新读盘 + json.loads。
    """
    global _BASELINE_CACHE
    if _BASELINE_CACHE is None:
        if not _BASELINE_PATH.exists():
            raise FileNotFoundError(
                f"paypal_fraudnet_baseline.json 缺失: {_BASELINE_PATH}"
            )
        _BASELINE_CACHE = json.loads(_BASELINE_PATH.read_text(encoding="utf-8"))
    return _BASELINE_CACHE


def _build_signup_url(*, ec_token: str, ba_token: str, signup_referer: str) -> str:
    """构造 fraudnet payload 里 ``URL`` 字段的值。

    优先使用上层传入的 ``signup_referer``（来自 paypal_approve 落地的 final_url），
    它通常已经是规范化的 ``/checkoutweb/signup?...`` 形式；都没有时回落到一个
    最小合法 URL（只含必要 query），让 fraudnet 后端能 parse 出 token=EC-XXX。
    """
    if signup_referer:
        return signup_referer
    qs = [f"token={ec_token}"]
    if ba_token:
        qs.append(f"ba_token={ba_token}")
    qs.append("locale.x=en_US")
    qs.append("country.x=US")
    return f"https://www.paypal.com/checkoutweb/signup?{'&'.join(qs)}"


def _personalize_body(
    template: dict,
    *,
    ec_token: str,
    signup_url: str,
    app_id: str,
) -> dict:
    """把 baseline body 模板深拷贝后注入当前会话的实时字段。

    替换列表（**只动这些**，其他字段全保留 baseline——PayPal fraudnet 是统计
    性收集，不强校验指纹每次都新）：

    1. ``body.appId`` → 传入的 app_id（默认 IWC_LOGIN_APP）
    2. ``body.correlationId`` → 当前 ec_token
    3. ``body.payload.URL`` → 当前 checkoutweb signup URL
    4. ``body.payload.time`` (p1 only) → 当前 ms timestamp
    5. ``body.payload[0].dfp[*].corrId`` (pa only) → 当前 ec_token
    6. ``body.payload[0].dfp[*].sourceId`` (pa only) → 当前 app_id
    """
    out = copy.deepcopy(template)
    out["appId"] = app_id
    out["correlationId"] = ec_token

    payload = out.get("payload")
    if isinstance(payload, dict):
        if "URL" in payload:
            payload["URL"] = signup_url
        if "time" in payload:
            # PayPal HAR 用 ms 精度的 timestamp
            payload["time"] = int(time.time() * 1000)
    elif isinstance(payload, list):
        # pa.body.payload 是 [{"dfp": [{...}]}] 形式
        for item in payload:
            if not isinstance(item, dict):
                continue
            dfp = item.get("dfp")
            if isinstance(dfp, list):
                for d in dfp:
                    if isinstance(d, dict):
                        if "corrId" in d:
                            d["corrId"] = ec_token
                        if "sourceId" in d:
                            d["sourceId"] = app_id
            elif isinstance(dfp, dict):
                if "corrId" in dfp:
                    dfp["corrId"] = ec_token
                if "sourceId" in dfp:
                    dfp["sourceId"] = app_id

    return out


def _fraudnet_post_headers(*, signup_referer: str) -> dict:
    """fraudnet POST 共用 header（HAR 1:1）。

    ``Referer`` 用 fraudnet collector iframe URL（``c.paypal.com/v1/r/d/i?...``），
    不是 checkoutweb/signup 页面——这是 HAR 实采的真实行为，因为 fraudnet
    collector 是嵌入在 iframe 里跑的。``Origin`` 也是 c.paypal.com 而非
    www.paypal.com。
    """
    return {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "Origin": FRAUDNET_HOST,
        "Referer": FRAUDNET_REFERER,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }


def _fraudnet_get_headers(*, signup_referer: str) -> dict:
    """fraudnet GET 共用 header（p3 / w / counter.cgi 等 telemetry GET）。"""
    return {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": signup_referer or FRAUDNET_REFERER,
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "image",
    }


# ----- 主入口 ----------------------------------------------------------------

def register_fraudnet_session(
    session,
    *,
    ec_token: str,
    ba_token: str = "",
    signup_referer: str = "",
    app_id: str = DEFAULT_APP_ID,
    timeout: int = 15,
    log: Optional[Callable[[str], None]] = None,
) -> dict:
    """向 PayPal fraudnet 后端注册一个 device fingerprint record，让 ec_token
    在 createMemberAccount 风控时**能被反查到**。

    协议化重放的 HAR 真实顺序（IWC_LOGIN_APP fraudnet 序列）：

    1. ``GET  c.paypal.com/v1/r/d/b/p3?f=EC-XXX&s=IWC_LOGIN_APP`` —— handshake
    2. ``POST c.paypal.com/v1/r/d/b/p1`` —— navigator/screen/window 指纹
    3. ``POST c.paypal.com/v1/r/d/b/p2`` —— plugins/URL/cv/vm/fts
    4. ``POST c.paypal.com/v1/r/d/b/pa`` —— dfp 主指纹包（canvas/webgl/fonts/auCtx）

    返回值：dict 形如 ``{"ok": True, "steps": ["p3","p1","p2","pa"], "errors": []}``。
    任何 step 失败都只 append 到 ``errors``，不抛异常（fraudnet record 不完整
    比完全没有 record 风控分数仍低，主流程必须继续）。

    Args:
        session: curl_cffi.Session 或兼容对象（要求支持 .get / .post）
        ec_token: 当前会话的 EC token（如 ``EC-TEST-FIXTURE``），会被
            写入 ``correlationId`` 和所有 ``corrId`` 字段
        ba_token: 当前 ba_token，仅用于构造 fallback URL；若 ``signup_referer``
            已给则忽略
        signup_referer: checkoutweb/signup 的完整 URL；优先使用，影响 ``payload.URL``
        app_id: fraudnet app id，默认 ``IWC_LOGIN_APP``（guest signup 流程必填，
            不要改成 ``BILLINGUINODEWEB_*``——那是 billing 阶段的）
        timeout: 单个请求 timeout（秒）
        log: 可选 logger，签名 ``(message: str) -> None``
    """
    log_fn = log or (lambda message: None)
    result = {"ok": True, "steps": [], "errors": []}

    if not ec_token or not ec_token.startswith("EC-"):
        result["ok"] = False
        result["errors"].append(f"无效 ec_token: {ec_token!r}")
        log_fn(f"[fraudnet] 跳过：无效 ec_token={ec_token!r}")
        return result

    try:
        baseline = _load_baseline()
    except Exception as exc:
        result["ok"] = False
        result["errors"].append(f"baseline 加载失败: {exc}")
        log_fn(f"[fraudnet] baseline 加载失败（跳过 fraudnet 注册）: {exc!r}")
        return result

    signup_url = _build_signup_url(
        ec_token=ec_token, ba_token=ba_token, signup_referer=signup_referer,
    )
    post_headers = _fraudnet_post_headers(signup_referer=signup_url)
    get_headers = _fraudnet_get_headers(signup_referer=signup_url)

    # Step 1: GET /v1/r/d/b/p3?f=EC-XXX&s=APP_ID —— fraudnet handshake (no body)
    try:
        resp = session.get(
            FRAUDNET_P3_URL_TMPL,
            params={"f": ec_token, "s": app_id},
            headers=get_headers,
            timeout=timeout,
        )
        status = getattr(resp, "status_code", 0)
        log_fn(f"[fraudnet] p3 handshake → status={status}")
        result["steps"].append("p3")
    except Exception as exc:
        log_fn(f"[fraudnet] p3 handshake 失败（继续）: {exc!r}")
        result["errors"].append(f"p3: {exc}")

    # Step 2: POST p1 —— 第一波指纹
    try:
        body = _personalize_body(
            baseline["p1"]["body"], ec_token=ec_token,
            signup_url=signup_url, app_id=app_id,
        )
        resp = session.post(
            FRAUDNET_P1_URL,
            json=body,
            headers=post_headers,
            timeout=timeout,
        )
        status = getattr(resp, "status_code", 0)
        log_fn(f"[fraudnet] p1 collect → status={status}")
        result["steps"].append("p1")
    except Exception as exc:
        log_fn(f"[fraudnet] p1 collect 失败（继续）: {exc!r}")
        result["errors"].append(f"p1: {exc}")

    # Step 3: POST p2 —— 第二波指纹（plugins / URL / cv / vm / fts）
    try:
        body = _personalize_body(
            baseline["p2"]["body"], ec_token=ec_token,
            signup_url=signup_url, app_id=app_id,
        )
        resp = session.post(
            FRAUDNET_P2_URL,
            json=body,
            headers=post_headers,
            timeout=timeout,
        )
        status = getattr(resp, "status_code", 0)
        log_fn(f"[fraudnet] p2 collect → status={status}")
        result["steps"].append("p2")
    except Exception as exc:
        log_fn(f"[fraudnet] p2 collect 失败（继续）: {exc!r}")
        result["errors"].append(f"p2: {exc}")

    # Step 4: POST pa —— dfp 主指纹包（canvas / webgl / fonts / auCtx）
    try:
        body = _personalize_body(
            baseline["pa"]["body"], ec_token=ec_token,
            signup_url=signup_url, app_id=app_id,
        )
        resp = session.post(
            FRAUDNET_PA_URL,
            json=body,
            headers=post_headers,
            timeout=timeout,
        )
        status = getattr(resp, "status_code", 0)
        log_fn(f"[fraudnet] pa dfp → status={status}")
        result["steps"].append("pa")
    except Exception as exc:
        log_fn(f"[fraudnet] pa dfp 失败（继续）: {exc!r}")
        result["errors"].append(f"pa: {exc}")

    # 汇总
    if result["errors"]:
        result["ok"] = False
        log_fn(
            f"[fraudnet] 注册完成（部分失败）: steps={result['steps']} "
            f"errors_count={len(result['errors'])}"
        )
    else:
        log_fn(f"[fraudnet] 注册完成（全部成功）: steps={result['steps']}")
    return result
