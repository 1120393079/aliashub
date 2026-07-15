"""ChatGPT 测试支付 — 协议模式 checkout pipeline 骨架。

将整个 checkout 流程拆为 4 段顺序执行的 stage：

* Stage A `stripe_checkout`     —— Stripe-hosted checkout 提交（选 PayPal + 账单）
* Stage B `paypal_approve`      —— PayPal `/agreements/approve` 同意
* Stage C `ctf_sandbox`         —— CTF sandbox 注册/付款/SCA OTP
* Stage D `paypal_review`       —— PayPal `/webapps/hermes` review 后跳回 chatgpt

当前各 stage 仅有占位实现，统一返回 `fallback_recommended=True`，由
`plugin._handle_generate_link` 自动回落到 Camoufox。后续 Phase 3-7 会逐段填实。
"""

from __future__ import annotations

import logging
import secrets
import string
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

from curl_cffi import requests as cffi_requests

from . import paypal_fraudnet, paypal_http, stripe_http

logger = logging.getLogger(__name__)


# ----- PayPal SignUp fake identity ---------------------------------------------
#
# PayPal SignUp 调用必然返回 ``CARD_GENERIC_ERROR`` 并下发 ``accessToken``，所以
# 这里的 card / email / password / phone 全部是占位 fake：服务器只用来生成 euat
# 不会真正扣款（OPT_OUT 资金渠道在后续 authorize 阶段才决策）。
#
# 字段池与 ``payment.py`` 里的 CTF identity 故意保持一致风格（同源池），让
# 后端日志看起来同种「美国 guest 用户」群体；后续可重构为共享池。

_PAYPAL_SIGNUP_FIRST_NAMES = (
    "Liam", "Mason", "Logan", "Ethan", "Noah",
    "Lucas", "Caleb", "Owen", "Nolan", "Ryan",
)
_PAYPAL_SIGNUP_LAST_NAMES = (
    "Walker", "Bennett", "Morgan", "Parker", "Reed",
    "Cooper", "Hayes", "Sullivan", "Brooks", "Foster",
)
# 多个常用的 VISA BIN（Issuer Identification Number / 前 6 位）。
# 都是 PayPal 受测试 BIN 区段：luhn-valid 即可通过 SignUp 校验，但服务器
# 一定回 ``ISSUER_DECLINE``。**关键是每次 SignUp 用不同的卡号**，否则
# 同号反复用会触发 PayPal OAS_ERROR (createMemberAccount 风控)。
_PAYPAL_FAKE_BINS = (
    "480081", "453210", "434257", "447918", "478173",
    "411111", "424242", "455673", "454742", "498824",
)


def _luhn_check_digit(partial: str) -> str:
    """给前 N-1 位算 Luhn 校验位，返回 0-9 单字符。"""
    total = 0
    # 从右往左，第 1 位是校验位（待计算），从第 2 位起 *2 / 不变 交替
    for i, ch in enumerate(reversed(partial)):
        d = int(ch)
        if i % 2 == 0:  # 第 2、4、... 位（从右数，含校验位左边第一位）
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return str((10 - (total % 10)) % 10)


def _generate_fake_visa_card() -> dict:
    """随机生成 16 位 luhn-valid VISA 卡号。

    每次调用都返回不同卡号，避免**同卡反复 SignUp 触发 PayPal 风控** (OAS_ERROR)。
    号是 luhn-valid 但 BIN 在测试区，PayPal 校验通过 → 正常下发 accessToken
    （响应里仍是 ISSUER_DECLINE / CARD_GENERIC_ERROR，但有我们要的 token）。
    """
    bin_prefix = secrets.choice(_PAYPAL_FAKE_BINS)
    middle = "".join(secrets.choice(string.digits) for _ in range(15 - len(bin_prefix)))
    partial = bin_prefix + middle  # 15 位
    check = _luhn_check_digit(partial)
    number = partial + check  # 16 位
    # 失效日期：当前年份后 2-5 年随机，月份 01-12
    import datetime as _dt
    year_now = _dt.datetime.now(_dt.timezone.utc).year
    exp_year = year_now + secrets.choice(range(2, 6))
    exp_month = secrets.choice(range(1, 13))
    return {
        "number": number,
        "expiration": f"{exp_month:02d}/{exp_year}",
        "cvc": f"{secrets.randbelow(900) + 100}",  # 3 位
    }


# HAR 实采的占位手机号（不会被使用：sms_pool 注入时会覆盖）。
_PAYPAL_SIGNUP_FAKE_PHONE = "2025550100"


def _generate_paypal_signup_identity() -> dict:
    """生成 PayPal SignUp 用的 fake 身份。所有字段都是占位，不会真扣款。

    **关键不变量**：``card_number`` 每次都是新随机 luhn-valid VISA，避免
    PayPal OAS_ERROR (同卡 / 同邮箱反复 SignUp 风控)。
    """
    first = secrets.choice(_PAYPAL_SIGNUP_FIRST_NAMES)
    last = secrets.choice(_PAYPAL_SIGNUP_LAST_NAMES)
    email_digits = "".join(secrets.choice(string.digits) for _ in range(5))
    email_suffix = "".join(secrets.choice(string.ascii_lowercase) for _ in range(3))
    pw_token = secrets.token_hex(4)
    card = _generate_fake_visa_card()
    return {
        "first_name": first,
        "last_name": last,
        "email": f"{first.lower()}{last.lower()}{email_digits}{email_suffix}@gmail.com",
        "password": f"{first}{pw_token}Aa1!",
        "phone": _PAYPAL_SIGNUP_FAKE_PHONE,
        "card_number": card["number"],
        "card_expiration": card["expiration"],
        "card_cvc": card["cvc"],
    }


# 优先选 Firefox 指纹：HAR 实采里浏览器就是 Firefox 135，pm-redirects.stripe.com
# 等服务对浏览器指纹敏感，Firefox 指纹能正常通过；Chrome 指纹会被 403 拒绝。
_DEFAULT_IMPERSONATE = "firefox135"
_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) "
    "Gecko/20100101 Firefox/135.0"
)


@dataclass
class ProtoState:
    """协议流水线共享状态。各 stage 可在原地修改 `current_url`、`address`、`identity` 等字段。

    ``checkout_context`` 是 stage 之间共享非 URL 数据的暂存袋（e.g. Stripe 的
    ``cs_id`` / ``init_checksum`` / PayPal 的 ``ba_token`` / ``ec_token``）。
    """

    session: Any
    current_url: str
    proxy: Optional[str]
    email: str
    cookies_str: str
    address: dict
    identity: dict
    log: Callable[[str], None]
    cancel_check: Optional[Callable[[], bool]]
    turnstile_solver: Optional[Callable[..., str]]
    timeout: int
    last_response: Any = None
    stage_history: List[dict] = field(default_factory=list)
    checkout_context: dict = field(default_factory=dict)
    # 用户在前端弹窗里配的 SMS 号码池，元素形如
    # ``{"phone": "12025550101", "phone_e164": "+12025550101",
    #    "relay_url": "https://relay.example.invalid/api/text-relay/TEST_RELAY_KEY_A"}``。
    # paypal_signup stage 遇到 PHONE_CONFIRMATION_REQUIRED 时会从这里挑一对作为
    # OTP 链的接收手机号和短信轮询端点；为空则视为不允许走 OTP 流程。
    sms_pool: List[dict] = field(default_factory=list)
    # PayPal ``paypal-client-metadata-id`` (CMID)。HAR 实采分析显示这个 header
    # 在浏览器里**直接等于 ec_token**（如 "EC-TEST-FIXTURE"），并不是浏览器
    # SDK 生成的随机指纹。空值时调用方会自动 fallback 到 ec_token，所以默认
    # 留空、单次 checkout 流程内自动统一。如果将来需要强制指定特定 cmid（比如
    # 测试或抓包重放），上层 ProtoState() 构造时显式传入即可。
    paypal_cmid: str = ""

    def raise_if_cancelled(self) -> None:
        if callable(self.cancel_check) and self.cancel_check():
            raise RuntimeError("任务已取消")


@dataclass
class StageResult:
    """单个 stage 的产出。`fallback_recommended` 标记调度层是否可以回落到 camoufox。"""

    ok: bool
    stage: str
    error: str = ""
    fallback_recommended: bool = True
    next_url: str = ""
    detail: dict = field(default_factory=dict)


def _parse_cookies_for_session(cookies_str: str) -> dict:
    """把 `key=val; key2=val2` 解析为 dict。"""
    cookies: dict = {}
    for item in str(cookies_str or "").split(";"):
        item = item.strip()
        if not item or "=" not in item:
            continue
        name, _, value = item.partition("=")
        cookies[name.strip()] = value.strip()
    return cookies


def build_protocol_session(
    *,
    proxy: Optional[str],
    cookies_str: str,
    impersonate: str = _DEFAULT_IMPERSONATE,
):
    """创建一个 curl_cffi Session，注入 chatgpt.com 域 cookie 与代理。

    **重要**：``impersonate`` 和 ``proxy`` 都必须在 ``Session(...)`` 构造时直接传入，
    curl_cffi 需要在创建 session 时一次性把 BoringSSL TLS 指纹与代理上下文绑定好。
    后赋值（``session.impersonate = ...`` / ``session.proxies = {...}``）在某些版本下
    会让 TLS 上下文落到一个不一致的状态，触发 ``curl: (35) invalid library``。
    参考项目里其他可用样例：``token_refresh.py``、``cpa_upload.py`` 都是构造时传。
    """
    session_kwargs: dict = {"impersonate": impersonate}
    if proxy:
        session_kwargs["proxy"] = proxy
    session = cffi_requests.Session(**session_kwargs)
    session.headers.update({
        "User-Agent": _DEFAULT_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
    })
    for name, value in _parse_cookies_for_session(cookies_str).items():
        try:
            secure = name.startswith("__Secure-") or name.startswith("__Host-")
            session.cookies.set(name, value, domain=".chatgpt.com", secure=secure)
        except Exception:
            # 个别 cookie 名称可能与 curl_cffi 的解析冲突，忽略后继续
            continue
    return session


def _snapshot_session_cookies(session) -> list[dict]:
    """把 session 当前所有 cookie 快照成 ``{name, value, domain, path, secure}`` 字典列表。

    用于跨 session 重建时**保留所有跨域 cookie**（chatgpt / pm-redirects /
    paypal / stripe 等域）。``session.cookies`` 是 curl_cffi 的 Cookies 对象，
    遍历它得到 Cookie 实例（与 http.cookiejar.Cookie 兼容的字段集）。
    """
    snapshot: list[dict] = []
    try:
        jar = session.cookies
    except Exception:
        return snapshot
    try:
        for c in jar.jar:  # curl_cffi 的 cookies 对象底层是 cookielib.CookieJar
            try:
                snapshot.append({
                    "name": c.name,
                    "value": c.value,
                    "domain": c.domain or "",
                    "path": c.path or "/",
                    "secure": bool(c.secure),
                })
            except Exception:
                continue
    except Exception:
        pass
    return snapshot


def _snapshot_session_cookie_names(session) -> list[dict]:
    """诊断用：取 session 中所有 cookie 的 ``{name, domain, path}`` 列表（**不含 value**）。

    专用于失败 dump 文件——避免把 cookie value（含 PayPal session token / DataDome
    设备指纹等敏感字段）泄露到 ``tools/captures/`` 里被人误传。我们关心的是
    "session 里有没有 ``ts/ts_c/x-pp-s/datadome/tsrce`` 这几个关键 cookie"，
    name + domain 已经够定位。

    返回 ``[{"name": "ts_c", "domain": ".paypal.com", "path": "/"}, ...]`` 形式
    的列表。读取出错或 jar 为空时返回 ``[]``——绝不抛，dump 不应当因诊断 helper 中断。
    """
    out: list[dict] = []
    try:
        jar = session.cookies
    except Exception:
        return out
    try:
        for c in jar.jar:
            try:
                out.append({
                    "name": str(c.name),
                    "domain": str(c.domain or ""),
                    "path": str(c.path or "/"),
                })
            except Exception:
                continue
    except Exception:
        pass
    # 按 domain + name 排序，dump 内容更稳定（diff 友好）
    out.sort(key=lambda d: (d.get("domain", ""), d.get("name", "")))
    return out


def _restore_session_cookies(session, snapshot: list[dict]) -> None:
    """把 ``_snapshot_session_cookies`` 拍下来的 cookie 列表还原到新 session。"""
    if not snapshot:
        return
    for entry in snapshot:
        try:
            session.cookies.set(
                entry.get("name", ""),
                entry.get("value", ""),
                domain=entry.get("domain", ""),
                path=entry.get("path", "/"),
                secure=bool(entry.get("secure", False)),
            )
        except Exception:
            # 个别 cookie 因 domain 限制可能 set 失败（curl_cffi 内部校验），跳过即可
            continue


def rotate_session_for_new_ip(state: "ProtoState", *, reason: str = "") -> None:
    """**关键反爬措施**：销毁当前 session 并新建一个，强制 kookeey rotating
    gateway 给一个新的出口 IP，但保留所有 cookie 不丢。

    背景：kookeey ``gate-jp.kookeey.info:1000`` 是固定网关 + 旋转出口模式——
    **每个新建 TCP 连接**才会拿到不同的出口 IP。但 curl_cffi 的 Session
    内部通过 libcurl 持久化连接池实现 keep-alive，**整个 session 内同一 host
    的所有请求都复用第一次建立的 TCP 连接** → 整个协议链都走同一个出口 IP
    →  PayPal datadome 累积识别为 bot → 后续请求 HTTP 403 datadome JS challenge。

    Camoufox 浏览器每个请求开独立 TCP 连接（HTTP/2 multiplex + 浏览器并发策略），
    每个请求看到不同 IP，所以从不被 datadome 拦——这就是用户说的
    "camoufox 浏览器模式就是去拿 IP 然后用这个 IP 代理"的本质。

    本函数的工作：
    1. 把旧 session 的所有 cookies 快照下来（含跨域：chatgpt + paypal + stripe）
    2. ``session.close()`` 释放 TCP 连接
    3. 重新创建 session（同 proxy URL → kookeey 新建 TCP 连接 → 新出口 IP）
    4. 把 cookies 还原到新 session

    **不传 cookies_str**：只复用 ``state.cookies_str`` 已经被 stage 1 注入到
    旧 session 后产生的"完整 cookie 集"快照，避免再叠加一次原始 cookies_str。

    **proxy 为空时跳过**：本地测试 / 离线模式没有代理，rotate 不会带来任何
    IP 变化，反而会替换掉测试 stub 的 session（破坏其他测试）。
    """
    if not state.proxy:
        return
    snapshot = _snapshot_session_cookies(state.session)
    cookie_count = len(snapshot)
    try:
        old_session = state.session
        try:
            old_session.close()
        except Exception:
            # close 可能抛 (curl handle 已被 reset 等)，忽略——目的是断 TCP 连接，
            # 即使没显式 close，新 session 一旦构造，旧的也会被 GC 回收。
            pass
    except Exception:
        pass
    new_session = build_protocol_session(proxy=state.proxy, cookies_str="")
    _restore_session_cookies(new_session, snapshot)
    state.session = new_session
    suffix = f" 原因={reason}" if reason else ""
    state.log(
        f"[session_rotate] 重建 session（保留 {cookie_count} 条 cookie）→ "
        f"强制 kookeey 分配新出口 IP{suffix}"
    )


# curl_cffi 在长生命周期进程下的瞬态网络/握手错关键字。当 stage 返回的
# StageResult.error 包含其中任一段时，主循环会 rotate session 重跑该 stage 一次。
#
# 覆盖两类瞬态错（都属于"基础设施抽风"，不属于业务级失败）：
#
# 1) **BoringSSL/TLS 层**——curl_cffi 全局 native 状态污染
#    实战日志样本（uvicorn --reload 跑多个连续 task 后）：
#      curl: (35) TLS connect error: error:00000000:invalid library (0):
#      OPENSSL_internal:invalid library (0). See https://curl.se/libcurl/...
#    孤立 Python 进程跑同代码 + 同代理无法复现，根因是 curl_cffi 的 BoringSSL
#    全局状态在多次 task 之间累积污染（Python `import` reload 不清 native lib）。
#
# 2) **代理隧道层**——kookeey 旋转网关瞬时抽风
#    实战日志样本（task 启动 stripe_checkout /init 第一发就挂）：
#      Failed to perform, curl: (56) Proxy CONNECT aborted.
#    根因是 kookeey 旋转出口在分配/复用 IP 时偶发握手中断（业务侧没法预测，
#    rotate 一次几乎必复活；不 rotate 就只能让整个 pipeline 在第一步就 GG）。
_CURL_TLS_TRANSIENT_KEYWORDS: tuple[str, ...] = (
    # === BoringSSL/TLS 层（curl_cffi 全局状态污染） ===
    "invalid library",
    "OPENSSL_internal",
    "TLS connect error",
    "curl: (35)",
    # === 代理隧道层（kookeey 旋转网关瞬时抽风） ===
    "curl: (56)",  # Proxy CONNECT aborted——代理隧道刚握手就被对端切断
    "curl: (7)",   # Couldn't connect to proxy——代理本身暂时不可达
    "curl: (28)",  # Operation timed out——单发请求超时
    "curl: (52)",  # Empty reply from server——代理回 0 字节
    "Proxy CONNECT aborted",  # 显式文案兜底（curl 错误码文案若变化也能命中）
)


def _is_curl_tls_transient_error(error_text: str) -> bool:
    """判断 stage 错误信息是否是 curl_cffi 的瞬态网络/握手错。

    覆盖 BoringSSL 全局状态污染（TLS 层）和 kookeey 代理网关抽风（代理隧道层）
    两类——都是"基础设施抽风"，rotate session 一次几乎必复活。

    用于 ``run_protocol_checkout`` 主循环识别"应当 rotate session 重跑"
    的失败模式。只在错误明确含上述关键字时返回 True，避免把"号被风控"、
    "captcha 拒绝"等业务级失败也卷入重试，浪费 SMS / 代理配额。
    """
    if not error_text:
        return False
    text = str(error_text)
    return any(kw in text for kw in _CURL_TLS_TRANSIENT_KEYWORDS)


def _execute_stage_with_tls_retry(
    state: "ProtoState",
    stage_fn: Callable[["ProtoState"], "StageResult"],
) -> "StageResult":
    """执行单个 stage，遇到 curl_cffi 瞬态 TLS 握手错时 rotate session 重跑一次。

    重试只**消费一次** retry 配额，二次失败按原结果返回（让上层正常报错），
    避免无限循环。``rotate_session_for_new_ip`` 会保留 cookie 跨重建，所以
    stage 内部已经积累的 ``checkout_context`` / ``identity`` 等业务状态都不丢。

    注意：stage 内部已经统一把异常 catch 成 ``StageResult(ok=False, error=...)``，
    所以这里**不需要再 try/except**——只看 ``result.ok`` 与 ``result.error``。
    """
    result = stage_fn(state)
    if getattr(result, "ok", False):
        return result
    if not _is_curl_tls_transient_error(getattr(result, "error", "")):
        return result

    stage_name = getattr(result, "stage", None) or getattr(stage_fn, "__name__", "unknown")
    state.log(
        f"[{stage_name}] 命中 curl_cffi 瞬态 TLS 握手错 → rotate session 重跑该 stage 一次 "
        f"(原始错误摘要: {str(getattr(result, 'error', ''))[:120]}…)"
    )
    rotate_session_for_new_ip(
        state, reason=f"清理 BoringSSL 全局状态污染（{stage_name} 重试）"
    )
    return stage_fn(state)


def _stub_stage(stage_name: str, message: str) -> Callable[[ProtoState], StageResult]:
    def _runner(state: ProtoState) -> StageResult:
        state.log(f"[{stage_name}] {message}")
        return StageResult(
            ok=False,
            stage=stage_name,
            error=message,
            fallback_recommended=True,
        )

    _runner.__name__ = f"_proto_stage_{stage_name}"
    return _runner


# 默认 stage 实现：Phase 3 起 Stripe checkout 已脱浏览器；其余仍为占位 stub。


def proto_stage_stripe_checkout(state: ProtoState) -> StageResult:
    """Stripe Checkout 协议化阶段：init → 提交税务地址 → direct PayPal confirm。

    成功时把 Stripe 返回的 ``pm-redirects.stripe.com/authorize/...`` 作为下一段
    stage 的 ``next_url``（即 PayPal 跳转入口），并将 ``cs_id`` / ``init_checksum``
    / ``paypal_redirect_url`` 等关键字段写入 ``StageResult.detail``，便于后续
    stage 复用。
    """

    stage = "stripe_checkout"
    try:
        cs_id = stripe_http.extract_checkout_session_id(state.current_url)
    except ValueError as exc:
        state.log(f"[{stage}] 无法解析 checkout session id: {exc}")
        return StageResult(ok=False, stage=stage, error=str(exc), fallback_recommended=False)

    address = dict(state.address or {})
    if not address.get("line1") or not address.get("postal_code") or not address.get("state"):
        return StageResult(
            ok=False,
            stage=stage,
            error="缺少账单地址（line1/postal_code/state），无法走 Stripe 协议",
            fallback_recommended=True,
        )

    state.log(f"[{stage}] cs={cs_id} 调用 /init")
    try:
        init_resp = stripe_http.stripe_init(state.session, cs_id=cs_id)
    except Exception as exc:
        return StageResult(ok=False, stage=stage, error=f"/init 失败: {exc}", fallback_recommended=True)
    init_checksum = str(init_resp.get("init_checksum") or "")
    config_id = str(init_resp.get("config_id") or "")
    expected_amount = stripe_http.extract_expected_amount(init_resp)
    latest_checkout = dict(init_resp)

    # 诊断 dump：把 cs 的关键字段 dump 出来，便于定位 ``checkout_amount_mismatch``
    # 与 ``payment_method_types_mismatch`` 这类 cs 服务端配置错误。``payment_method_types``
    # 是 Stripe 服务端在 ``/confirm`` 时强校验的——如果 OpenAI 后端给我们的 cs
    # 只列了 ``[card]`` 而我们传 PayPal direct confirm，服务端就报
    # ``payment_method_types_mismatch``，与协议代码无关，是 OpenAI 风控行为。
    pm_types_field = init_resp.get("payment_method_types")
    automatic_pm = init_resp.get("automatic_payment_method_types")
    invoice_total = (init_resp.get("invoice") or {}).get("total")
    invoice_amount_due = (init_resp.get("invoice") or {}).get("amount_due")
    state.log(
        f"[{stage}] /init payment_method_types={pm_types_field!r} "
        f"automatic={automatic_pm!r} invoice.total={invoice_total} "
        f"invoice.amount_due={invoice_amount_due}"
    )
    if not init_checksum:
        return StageResult(
            ok=False,
            stage=stage,
            error="/init 响应缺少 init_checksum",
            fallback_recommended=True,
            detail={"init_response_keys": list(init_resp.keys())[:20]},
        )
    state.log(f"[{stage}] /init 响应 expected_amount={expected_amount} (cents)")

    state.raise_if_cancelled()
    try:
        stripe_http.stripe_allowed_origins(state.session, cs_id=cs_id)
    except Exception as exc:
        state.log(f"[{stage}] Stripe allowed_origins 失败（忽略）: {exc}")

    try:
        elements_resp = stripe_http.stripe_elements_session(
            state.session,
            cs_id=cs_id,
            init_resp=latest_checkout,
        )
        latest_checkout = stripe_http.merge_checkout_payload(latest_checkout, elements_resp)
        init_checksum = str(latest_checkout.get("init_checksum") or init_checksum)
        config_id = str(latest_checkout.get("config_id") or config_id)
        state.log(f"[{stage}] Stripe Elements prepare 完成")
        try:
            prepared_redirect_url, prepared_return_url = stripe_http.extract_paypal_redirect_url(elements_resp)
            state.log(f"[{stage}] Elements prepare 已返回 PayPal redirect URL（截断）: {prepared_redirect_url[:90]}")
            state.checkout_context.update(
                {
                    "cs_id": cs_id,
                    "init_checksum": init_checksum,
                    "config_id": config_id,
                    "paypal_redirect_url": prepared_redirect_url,
                    "paypal_return_url": prepared_return_url,
                    "expected_amount": expected_amount,
                    "expected_amount_on_bca": "",
                }
            )
            state.current_url = prepared_redirect_url
            return StageResult(
                ok=True,
                stage=stage,
                next_url=prepared_redirect_url,
                detail={
                    "cs_id": cs_id,
                    "init_checksum": init_checksum,
                    "paypal_redirect_url": prepared_redirect_url,
                    "paypal_return_url": prepared_return_url,
                },
            )
        except ValueError:
            pass
    except Exception as exc:
        state.log(f"[{stage}] Stripe Elements prepare 失败，继续原始 checkout prepare: {exc}")

    state.log(f"[{stage}] 提交税务地址 {address.get('state')}/{address.get('postal_code')}")
    try:
        tax_resp = stripe_http.stripe_update_tax_region(state.session, cs_id=cs_id, address=address)
    except Exception as exc:
        return StageResult(ok=False, stage=stage, error=f"tax_region 提交失败: {exc}", fallback_recommended=True)
    if isinstance(tax_resp, dict):
        latest_checkout = stripe_http.merge_checkout_payload(latest_checkout, tax_resp)
        init_checksum = str(latest_checkout.get("init_checksum") or init_checksum)
        config_id = str(latest_checkout.get("config_id") or config_id)

    # 关键：提交税务地址后 Stripe 会**重新计算 invoice 加税**，
    # ``elements_options.amount`` 和 ``invoice.amount_due`` 都会变成"税后金额"。
    # ``/confirm`` 时 Stripe 服务端用的是税后金额做 ``expected_amount`` 校验，
    # 如果继续用 init 阶段抽出来的"税前金额"，会报 ``checkout_amount_mismatch``。
    # HAR 实采里因为 100% off trial 折扣后 ``invoice.amount_due=0``，无论是否加税
    # 都是 0 所以这个 bug 不暴露；非 trial 账号下立刻炸。
    tax_expected_amount = stripe_http.extract_expected_amount(latest_checkout)
    if tax_expected_amount != expected_amount:
        state.log(
            f"[{stage}] tax_region 后 expected_amount 更新: {expected_amount} → "
            f"{tax_expected_amount} (cents, 含税)"
        )
        expected_amount = tax_expected_amount

    state.raise_if_cancelled()
    expected_amount, expected_amount_on_bca = stripe_http.extract_confirm_expected_amounts(
        latest_checkout,
        fallback_amount=expected_amount,
    )
    displayed_amounts = stripe_http.extract_display_amounts(latest_checkout)
    try:
        pre_confirm_resp = stripe_http.stripe_pre_confirm_paypal(
            state.session,
            cs_id=cs_id,
        )
        latest_checkout = stripe_http.merge_checkout_payload(latest_checkout, pre_confirm_resp)
        init_checksum = str(latest_checkout.get("init_checksum") or init_checksum)
        config_id = str(latest_checkout.get("config_id") or config_id)
        expected_amount, expected_amount_on_bca = stripe_http.extract_confirm_expected_amounts(
            latest_checkout,
            fallback_amount=expected_amount,
        )
        displayed_amounts = stripe_http.extract_display_amounts(latest_checkout)
        state.log(f"[{stage}] /pre_confirm PayPal 完成")
    except Exception as exc:
        state.log(f"[{stage}] /pre_confirm PayPal 失败，继续 confirm: {exc}")

    return_url = stripe_http.build_confirm_return_url(
        latest_checkout,
        cs_id=cs_id,
        fallback_url=state.current_url,
    )
    referrer_url = stripe_http.build_confirm_referrer_url(
        latest_checkout,
        cs_id=cs_id,
        fallback_url=state.current_url,
    )
    confirm_email = str(latest_checkout.get("customer_email") or state.email)
    state.log(
        f"[{stage}] /confirm direct PayPal "
        f"expected_amount={expected_amount} expected_amount_on_bca={expected_amount_on_bca or '-'}"
    )
    redirect_url = ""
    paypal_return_url = ""
    last_confirm_error: Exception | None = None

    direct_return_urls = [return_url]
    stripped_return_url = stripe_http.strip_url_fragment(return_url)
    if stripped_return_url and stripped_return_url != return_url:
        direct_return_urls.append(stripped_return_url)
    address_candidates = stripe_http.confirm_address_candidates(address, latest_checkout)

    for candidate_address in address_candidates:
        if redirect_url:
            break
        for attempt_index, candidate_return_url in enumerate(direct_return_urls, start=1):
            try:
                confirm_resp = stripe_http.stripe_confirm_paypal_direct(
                    state.session,
                    cs_id=cs_id,
                    init_checksum=init_checksum,
                    email=confirm_email,
                    address=candidate_address,
                    return_url=candidate_return_url,
                    expected_amount=expected_amount,
                    expected_amount_on_bca=expected_amount_on_bca,
                    displayed_amounts=displayed_amounts,
                    referrer=referrer_url,
                )
                redirect_url, paypal_return_url = stripe_http.extract_paypal_redirect_url(confirm_resp)
                break
            except ValueError as exc:
                last_confirm_error = exc
                if attempt_index < len(direct_return_urls):
                    state.log(f"[{stage}] /confirm direct 未返回 PayPal authorize URL，重试去掉 return_url fragment")
                    continue
            except Exception as exc:
                last_confirm_error = exc
                break

    if not redirect_url:
        state.log(f"[{stage}] /confirm direct 未拿到 PayPal authorize URL，回落 payment_method confirm")
        try:
            device = stripe_http.StripeDeviceContext()
            for candidate_address in address_candidates:
                pm_resp = stripe_http.stripe_create_paypal_payment_method(
                    state.session,
                    cs_id=cs_id,
                    address=candidate_address,
                    email=confirm_email,
                    device=device,
                    config_id=config_id,
                )
                payment_method_id = str(pm_resp.get("id") or "")
                if not payment_method_id.startswith("pm_"):
                    raise RuntimeError(f"Stripe payment_method 响应缺少 pm_ id: {payment_method_id or pm_resp!r}")
                confirm_resp = stripe_http.stripe_confirm_paypal_with_payment_method(
                    state.session,
                    cs_id=cs_id,
                    payment_method_id=payment_method_id,
                    init_checksum=init_checksum,
                    return_url=stripped_return_url or return_url,
                    expected_amount=expected_amount,
                    expected_amount_on_bca=expected_amount_on_bca,
                    displayed_amounts=displayed_amounts,
                    referrer=referrer_url,
                    config_id=config_id,
                )
                try:
                    redirect_url, paypal_return_url = stripe_http.extract_paypal_redirect_url(confirm_resp)
                    state.checkout_context["payment_method_id"] = payment_method_id
                    break
                except ValueError as exc:
                    last_confirm_error = exc
                    continue
        except Exception as exc:
            first_error = str(last_confirm_error or "").strip()
            fallback_error = str(exc or "").strip()
            joined = (
                f"{first_error}; payment_method fallback failed: {fallback_error}"
                if first_error
                else f"payment_method fallback failed: {fallback_error}"
            )
            return StageResult(ok=False, stage=stage, error=joined, fallback_recommended=True)

    if not redirect_url:
        confirm_error = str(last_confirm_error or "Stripe confirm did not return PayPal authorize URL").strip()
        error = f"{confirm_error}; payment_method fallback returned no PayPal authorize URL"
        state.log(f"[{stage}] PayPal authorize URL 为空，协议提取失败: {error}")
        return StageResult(ok=False, stage=stage, error=error, fallback_recommended=True)

    return_url = paypal_return_url or return_url

    state.log(f"[{stage}] 拿到 PayPal redirect URL（截断）: {redirect_url[:90]}")
    # 把跨 stage 复用的字段写进 checkout_context，供 stripe_poll / paypal_* 使用。
    # ``paypal_redirect_url`` 必须写进 context：生产链路里 Stripe ``/confirm`` 给的是
    # ``pm-redirects.stripe.com/authorize/...`` 中转 URL，本身**不含 ba_token**，
    # paypal_approve stage 需要 GET 这个 URL 跟随 302 才能拿到真正的 ba_token。
    state.checkout_context.update(
        {
            "cs_id": cs_id,
            "init_checksum": init_checksum,
            "config_id": config_id,
            "paypal_redirect_url": redirect_url,
            "paypal_return_url": return_url,
            "expected_amount": expected_amount,
            "expected_amount_on_bca": expected_amount_on_bca,
        }
    )
    return StageResult(
        ok=True,
        stage=stage,
        next_url=redirect_url,
        detail={
            "cs_id": cs_id,
            "init_checksum": init_checksum,
            "config_id": config_id,
            "paypal_redirect_url": redirect_url,
            "paypal_return_url": return_url,
            "expected_amount": expected_amount,
            "expected_amount_on_bca": expected_amount_on_bca,
            "displayed_amounts": displayed_amounts,
        },
    )


def proto_stage_paypal_approve(state: ProtoState) -> StageResult:
    """PayPal Stage P1 协议化：从 Stripe redirect 起点跟随 302 落到 PayPal
    ``/agreements/approve``，抓 ``ba_token`` / ``_csrf`` / ``_sessionID`` /
    ``ec_token`` 写入 ``checkout_context``。

    Stripe ``/confirm`` 返回的 ``redirect_to_url.url`` 长这样：

        https://pm-redirects.stripe.com/authorize/acct_X/sa_nonce_Y

    这是 Stripe 的中转 URL，**本身不含 ba_token**；浏览器（或 curl_cffi）GET
    一次才会经过 302 chain 最终落到：

        https://www.paypal.com/checkoutweb/signup?token=EC-XXX&ba_token=BA-XXX&...

    所以本 stage 的入口逻辑分三种情况：

    1. ``checkout_context['paypal_redirect_url']`` 已被 stripe_checkout 写入（生产链路）
       → 优先用它做 ``redirect_url`` 走 ``paypal_get_approve``
    2. ``state.current_url`` 本身已经带 ``ba_token``（向后兼容老测试 / 已落地场景）
       → 直接走 ba_token 快路径
    3. 都没有 → fail-fast，``fallback_recommended=True``
    """

    stage = "paypal_approve"

    # **不再** rotate session：实战观察到一次 checkout 流程 30 秒内换 3 次 IP
    # 反而是 PayPal 风控（datadome / risk engine）的强信号——同一 ec_token /
    # csrf / sessionID 跨 IP 移动比"稳定一个干净 IP 走全程"更像 bot。整个
    # 协议模式坚持**单 IP 走到底**，让 kookeey 在 stripe_checkout 阶段建好的
    # 出口 IP 一直用到 OTP confirm 结束。

    # 1. 收集所有候选 URL：checkout_context 优先（由 stripe_checkout 写入），
    #    其次 state.current_url（调度层每个 stage 完成后会把 next_url 写到这里）。
    ctx_redirect = str(state.checkout_context.get("paypal_redirect_url") or "")
    current_url = str(state.current_url or "")
    candidates: List[str] = [u for u in (ctx_redirect, current_url) if u]
    if not candidates:
        state.log(
            f"[{stage}] 无可用 URL（checkout_context.paypal_redirect_url / "
            "state.current_url 均为空），无法继续"
        )
        return StageResult(
            ok=False,
            stage=stage,
            error="无法定位 PayPal redirect URL（stripe_checkout 未写入 paypal_redirect_url）",
            fallback_recommended=True,
            detail={"candidates": []},
        )

    # 2. 优先尝试直接抽 ba_token —— 测试场景或已落地 paypal.com 时走这条快路径。
    #    生产场景下 pm-redirects URL 抽不到，会走第 3 步的 redirect_url 路径。
    ba_token = ""
    for url in candidates:
        try:
            ba_token = paypal_http.extract_ba_token(url)
            break
        except ValueError:
            continue

    # 3. 决定调用方式：拿到 ba_token 直接打 paypal.com；否则用 redirect_url 跟 302
    redirect_url = "" if ba_token else candidates[0]
    state.raise_if_cancelled()
    if ba_token:
        state.log(f"[{stage}] 已知 ba_token={ba_token[:16]}… 直接 GET /agreements/approve")
    else:
        state.log(
            f"[{stage}] 通过 Stripe redirect 跟随 302 落地: {redirect_url[:90]}…"
        )

    approve = None
    last_exc = None
    for _attempt in range(2):
        try:
            # Referer 必须是 ``https://pay.openai.com/`` —— HAR 实采里浏览器从
            # ChatGPT 支付页跳到 pm-redirects 时携带的就是这个 Referer。如果错填成
            # ``pm-redirects.stripe.com`` 或 ``checkout.stripe.com``，pm-redirects
            # 会直接返回 ``HTTP 403`` 拒绝请求。
            approve = paypal_http.paypal_get_approve(
                state.session,
                ba_token=ba_token,
                redirect_url=redirect_url,
                referer="https://pay.openai.com/",
                timeout=max(int(state.timeout or 60), 30),
            )
            break
        except Exception as exc:
            last_exc = exc
            error_str = str(exc)
            # DataDome 403 的特征：HTTP 403 + body 里带 "datadome" cookie 脚本。
            # kookeey 某些出口 IP 已被 PayPal DataDome 标记为代理/数据中心 IP，
            # 轮换一次 IP 通常能拿到一个干净的出口。
            is_datadome_403 = (
                "datadome" in error_str.lower()
                and ("403" in error_str or "403" in getattr(exc, "args", [""])[0] if getattr(exc, "args", None) else "")
            )
            if is_datadome_403 and _attempt == 0 and state.proxy:
                state.log(
                    f"[{stage}] PayPal DataDome 403 → 轮换 IP 重试 "
                    f"(paypal-debug-id={error_str[error_str.find('paypal-debug-id=')+16:][:14] if 'paypal-debug-id=' in error_str else '?'})"
                )
                rotate_session_for_new_ip(state, reason="PayPal DataDome 403 触发 IP 轮换")
                continue
            state.log(f"[{stage}] HTTP 请求失败: {exc}")
            return StageResult(
                ok=False,
                stage=stage,
                error=f"PayPal /agreements/approve 请求失败: {exc}",
                fallback_recommended=True,
                detail={"ba_token": ba_token, "redirect_url": redirect_url},
            )
    if approve is None:
        state.log(f"[{stage}] DataDome 403 重试后仍失败: {last_exc}")
        return StageResult(
            ok=False,
            stage=stage,
            error=f"PayPal DataDome 403（IP 轮换后仍失败）: {last_exc}",
            fallback_recommended=True,
            detail={"ba_token": ba_token, "redirect_url": redirect_url},
        )

    html = approve.get("html") or ""
    final_url = approve.get("final_url") or ""
    # paypal_get_approve 走 redirect_url 路径时会从 final_url 反抽 ba_token 回写
    ba_token = approve.get("ba_token") or ba_token
    ec_token = approve.get("ec_token") or ""

    if not ba_token:
        state.log(
            f"[{stage}] 跟随 redirect 后仍无法从 final_url 抽到 ba_token: "
            f"{final_url[:120]}"
        )
        return StageResult(
            ok=False,
            stage=stage,
            error="跟随 Stripe redirect 后未能落地到 PayPal /agreements/approve（ba_token 缺失）",
            fallback_recommended=True,
            detail={
                "redirect_url": redirect_url,
                "final_url": final_url,
                "html_length": len(html),
            },
        )

    csrf = ""
    session_id = ""
    try:
        csrf = paypal_http.extract_paypal_csrf(html)
    except ValueError:
        csrf = ""
    try:
        session_id = paypal_http.extract_paypal_session_id(html)
    except ValueError:
        session_id = ""

    # _csrf / _sessionID 缺一不可，否则后续 captcha / signup 必败；直接 fallback
    if not csrf or not session_id:
        # 协议化排查：把落地 HTML 落盘，便于离线对比 HAR 找抽取规则
        dump_path = ""
        try:
            import pathlib, time as _time
            dump_dir = pathlib.Path("tools/captures")
            dump_dir.mkdir(parents=True, exist_ok=True)
            dump_path = str(dump_dir / f"paypal_landing_{int(_time.time())}.html")
            pathlib.Path(dump_path).write_text(html, encoding="utf-8", errors="replace")
        except Exception:
            dump_path = ""
        state.log(
            f"[{stage}] 落地 HTML 未抽到 _csrf/_sessionID "
            f"(csrf={'yes' if csrf else 'no'}, sessionID={'yes' if session_id else 'no'}, "
            f"html_len={len(html)}, final_url={final_url[:120]}"
            + (f", dump={dump_path}" if dump_path else "")
            + ")"
        )
        return StageResult(
            ok=False,
            stage=stage,
            error="PayPal 落地 HTML 未能抽到 _csrf/_sessionID",
            fallback_recommended=True,
            detail={
                "ba_token": ba_token,
                "ec_token": ec_token,
                "final_url": final_url,
                "html_length": len(html),
                "csrf_found": bool(csrf),
                "session_id_found": bool(session_id),
            },
        )

    # 顺手抽 OTP_CHALLENGE 需要的两个 PayPal 服务端 token —— 抽不到时为空，
    # 不视为致命错误（OTP 子链触发时会再次检查并决定是否跳过预热）。
    otp_csrf_nonce = paypal_http.extract_otp_csrf_nonce(html)
    otp_ctx_id = paypal_http.extract_otp_ctx_id(html)

    state.checkout_context.update(
        {
            "ba_token": ba_token,
            "ec_token": ec_token,
            "paypal_csrf": csrf,
            "paypal_session_id": session_id,
            "paypal_landing_url": final_url,
            "paypal_otp_csrf_nonce": otp_csrf_nonce,
            "paypal_otp_ctx_id": otp_ctx_id,
        }
    )
    state.log(
        f"[{stage}] 落地完成 ba_token={ba_token[:16]}… ec_token={ec_token or '∅'} "
        f"csrf={csrf[:8]}… sessionID={session_id[:8]}…"
    )
    return StageResult(
        ok=True,
        stage=stage,
        next_url=final_url,
        detail={
            "ba_token": ba_token,
            "ec_token": ec_token,
            "paypal_csrf": csrf,
            "paypal_session_id": session_id,
            "final_url": final_url,
        },
    )


# 常见国家呼叫码表（E.164 calling code）。剥本地号 / 选区号下拉都用它。
# **顺序无所谓**：``_calling_code_from_e164`` 内部按长度倒序（最长前缀优先）
# 匹配，避免把 ``81``（日本）误判成 ``8``、把 ``852``（香港）误剥成 ``85``。
# ISO2 用于浏览器电话框区号选择器（``+81 / Japan / JP`` 多种命中形态）。
_E164_CALLING_CODES: tuple[tuple[str, str], ...] = (
    ("1", "US"),     # 北美（US/CA）
    ("44", "GB"),    # 英国
    ("61", "AU"),    # 澳大利亚
    ("81", "JP"),    # 日本 ← 之前缺这个，JP 号剥不掉国家码导致 PayPal 拒号
    ("86", "CN"),    # 中国
    ("65", "SG"),    # 新加坡
    ("852", "HK"),   # 香港
    ("49", "DE"),    # 德国
    ("33", "FR"),    # 法国
    ("91", "IN"),    # 印度
)


def _calling_code_from_e164(phone_e164: str) -> tuple[str, str, str]:
    """从 E.164 解析 ``(calling_code, iso2, local_number)``。

    用最长前缀匹配 ``_E164_CALLING_CODES``，避免 ``81``（日本）被 ``8`` /
    ``1`` 类短码误吞。无法识别国家码时返回 ``("", "", 全部数字)``，调用方
    据此走兜底（保持旧行为）。

    例：
    - ``+8190...`` → ``("81", "JP", "90...")``
    - ``+12025550101`` → ``("1", "US", "2025550101")``
    """
    raw = str(phone_e164 or "").strip()
    if raw.startswith("+"):
        raw = raw[1:]
    if not raw or not raw.isdigit():
        return "", "", ""
    # 最长前缀优先：先比 ``852`` 再比 ``85``/``8``，避免短码误命中
    for code, iso2 in sorted(_E164_CALLING_CODES, key=lambda x: len(x[0]), reverse=True):
        if raw.startswith(code) and len(raw) > len(code):
            return code, iso2, raw[len(code):]
    return "", "", raw


def _local_phone_from_e164(phone_e164: str, *, default_country_digit: str = "1") -> str:
    """从 E.164 格式抽 PayPal 期望的本地号码部分。

    例如:
    - ``+12025550101`` → ``2025550101``（北美 +1 之后是 10 位本地号）
    - ``12025550101`` （无 +）→ ``2025550101``（按 default_country_digit 剥）
    - ``+8613800138000`` → ``13800138000`` （中国 +86 之后 11 位）
    - ``+819012345678`` → ``9012345678`` （日本 +81 之后 10 位移动号）

    PayPal SignUp 的 ``phone.number`` 和 OTP initiate 的 ``phoneNumber`` 都不带
    国家码前缀；电话框旁的区号选择器单独承载国家码。
    """
    raw = str(phone_e164 or "").strip()
    if raw.startswith("+"):
        raw = raw[1:]
    if not raw.isdigit():
        return ""
    # 优先用呼叫码表做最长前缀匹配（覆盖 81/852 等多位国家码）
    _code, _iso2, local = _calling_code_from_e164(phone_e164)
    if local and local != raw:
        return local
    # 兜底：按调用方默认国家码（通常 "1"）剥
    if raw.startswith(default_country_digit) and len(raw) > len(default_country_digit):
        return raw[len(default_country_digit):]
    return raw


def _is_recoverable_otp_error(exc: BaseException) -> bool:
    """判断 OTP 子链异常是否属于"瞬时可恢复"类型，用以决定是否轮换下一号继续重试。

    可恢复（轮换）：
        * HTTP 5xx（如 522 Cloudflare timeout、502/503/504/524）
        * 连接错误 / 超时 / 重置 / 中断
        * curl_cffi 临时 TLS / 解析异常（``invalid library`` / ``Failed to perform``）

    不可恢复（return）：
        * ``RuntimeError("任务已取消")`` —— 上层显式取消，必须立即停
        * 配置类（缺 phone_e164 / relay_url / pool_index 越界 / 拉不到 OTP code）
        * 4xx 客户端错误（参数错或鉴权失效，换号也救不了）

    Note:
        判断仅基于异常字符串 + isinstance，故意保持宽容：检测到 "Connection" /
        "timed out" / "HTTP Error 5" 这类关键词即视作可恢复。这样代码不必依赖
        curl_cffi 异常层级（不同版本可能有出入）。
    """
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return True
    text = str(exc).lower()
    # 上层通过 raise RuntimeError("任务已取消") 主动中断 —— 必须立即停
    if "任务已取消" in str(exc):
        return False
    # 配置类 / 业务类 —— 换号也救不了
    if "缺 phone_e164" in str(exc) or "pool_index=" in str(exc):
        return False
    if "未从验证码邮件" in str(exc) or "未能获取" in str(exc):
        # 邮件轮询超时不算瞬时网络错误（号是发出去了 PayPal 也回了 PENDING，但 relay 可能整个不可达）
        # 视作可恢复：换下一号也许走另一个 relay 或同 relay 此刻已恢复
        return True
    # HTTP 5xx
    if any(token in text for token in (
        "http error 5", "http error: 5",
        "5xx server error", "server error",
        "502 ", "503 ", "504 ", "522 ", "524 ", "520 ",
        "internal server error", "bad gateway", "gateway timeout",
        "connection timed out", "connection refused", "connection reset",
        "connection aborted", "connection error",
        "timed out", "read timeout", "request timed out",
        # curl_cffi 间歇 TLS
        "invalid library", "failed to perform",
    )):
        return True
    return False


def _run_paypal_otp_subchain(
    *,
    state: ProtoState,
    ec_token: str,
    ba_token: str,
    signup_body: dict,
    signup_referer: str,
    pool_index: int = 0,
) -> dict:
    """执行 PayPal OTP 子链并返回**重发 SignUp 后**的响应 dict。

    顺序（HAR `tests/fixtures/paypal_otp_*.json` 实采）：

    1. POST ``InitiateRiskBasedTwoFactorPhoneConfirmationMutation`` —— PayPal 给
       ``identity.phone_e164`` 发 6 位 SMS 验证码，响应给 ``authId`` /
       ``challengeId``。
    2. **轮询** ``identity.sms_relay_url`` —— 复用 ``payment._fetch_ctf_relay_code``
       从中转邮箱拉到 6 位数字 OTP。
    3. POST ``ConfirmRiskBasedTwoFactorPhoneConfirmationMutation`` —— 提交 PIN，
       服务器响应 ``state="CONFIRMED"`` 即代表本号码已通过 PayPal 风控。
    4. **重发** ``SignUpNewMemberMutation`` —— 用同样的 body / headers 再 POST 一次，
       这次 PayPal 不再要求 OTP，直接返回 ``ISSUER_DECLINE`` + ``accessToken``
       （即 euat）。

    ``pool_index`` 选择 ``state.sms_pool`` 中的哪一条号；调用方在重发失败 OAS_ERROR
    时可递增 index 重试下一条号。

    在第 4 步前会更新 ``signup_body.variables.phone.number`` 为本次选中号码的
    本地号，让 PayPal 看到的"本次注册电话"与刚通过 OTP 的电话完全一致。

    任何一步失败都直接 ``raise``，让 stage 层 catch 后给 fallback。
    """
    # 延迟 import 避免循环依赖（payment.py 也 import payment_protocol 间接）
    from . import payment as _payment_module

    pool = state.sms_pool or []
    if not (0 <= pool_index < len(pool)):
        raise RuntimeError(f"pool_index={pool_index} 越界（pool size={len(pool)}）")
    entry = pool[pool_index] or {}
    phone_e164 = str(entry.get("phone_e164") or "").strip()
    relay_url = str(entry.get("relay_url") or "").strip()
    if not phone_e164 or not relay_url:
        raise RuntimeError(
            f"sms_pool[{pool_index}] 缺 phone_e164/relay_url: {entry!r}"
        )

    # 同步到 identity，让后续日志 / 失败兜底拿到本次实际用的号
    identity = state.identity or {}
    identity["phone"] = str(entry.get("phone") or phone_e164.lstrip("+"))
    identity["phone_e164"] = phone_e164
    identity["sms_relay_url"] = relay_url
    state.identity = identity

    phone_local = _local_phone_from_e164(phone_e164)
    if not phone_local:
        raise RuntimeError(f"无法从 phone_e164={phone_e164!r} 抽出本地号码")

    timeout = max(int(state.timeout or 60), 30)
    cmid = state.paypal_cmid or ec_token

    # **不再** rotate session：经验证主动换 IP 反而触发 PayPal 风控（同一
    # ec_token / sessionID 跨 IP 移动 = bot 信号）。OTP 子链复用上游 stage
    # 的 IP，让 PayPal 看到的是"一个真实用户在同一连接里走完整个流程"。

    # -1. weasley logger 预热 —— 让 PayPal 给 session 下发 ``tsrce=checkoutuinodeweb_weasley``
    #
    # 这是协议模式从"OTP_INITIATE 拿到 PENDING 但 OTP_CONFIRM 报 PHONE_CONFIRMATION_NOT_INITIATED"
    # 的根因修复：缺少 weasley tsrce cookie 时，``/idapps/graphql`` 的 OTP_CHALLENGE
    # 会被 PayPal 当成"页面访问"返回 HTML pa.js 容器，PayPal 服务端**不会建立
    # OTP fraud session**；OTP_INITIATE 可以"装"成功（state=PENDING，PayPal 真的发 SMS），
    # 但 OTP_CONFIRM 时按 fraud session 反查找不到 → PHONE_CONFIRMATION_NOT_INITIATED。
    #
    # 修复：在 OTP_CHALLENGE 之前发一次 weasley logger，PayPal 响应 Set-Cookie
    # ``tsrce=checkoutuinodeweb_weasley``。这是非阻塞的——失败也继续走，至少
    # 保留旧行为不退化。
    weasley_ok = paypal_http.paypal_post_weasley_logger(
        state.session, referer=signup_referer or "", timeout=15,
    )
    state.log(
        f"[paypal_signup/otp] weasley logger 预热 {'成功' if weasley_ok else '失败（继续）'} "
        f"(用于下发 tsrce=checkoutuinodeweb_weasley)"
    )

    # 0. OTP_CHALLENGE 预热 (`getOtpChallengeOperation` POST /idapps/graphql)
    #
    # 实证依据：当前协议模式在 sms_pool 非空时，OTP-Initiate 能成功（state=PENDING +
    # PayPal 实际下发 SMS），但 OTP-Confirm 必报 ``PHONE_CONFIRMATION_NOT_INITIATED``。
    # HAR 实采的 Camoufox 浏览器成功流程证明：在 OTP-Initiate **之前**浏览器一定
    # 会先发一次 ``getOtpChallengeOperation`` 预热到 ``/idapps/graphql``，把这次
    # OTP 挑战的 fraud context 在 PayPal 服务端"登记"——没有这一步，PayPal 只
    # 给 Initiate 一个临时 challenge（足以通过 Initiate 的响应校验、足以发短信），
    # 但 Confirm 时按 fraud session 反查就找不到这个 challenge。
    #
    # 历史上这一步被注释掉是因为 ``csrfNonce`` / ``ctxId`` 看起来是浏览器内 SDK
    # 自生成的 token（HAR 全文扫描确认它们不出现在任何前序响应里）。但 HAR 里
    # entry 505 的服务端响应是 ``data.otp.getOtpChallenge.* = null`` 配 HTTP 200，
    # 说明 PayPal 服务器**不严格校验**这两个 token 的内容，只校验存在性。所以
    # 协议模式用 ``generate_otp_challenge_tokens()`` 生成的随机 88 字符 base64url
    # 占位即可。
    #
    # 失败兜底：如果 PayPal 真要严格校验内容（接受规则改了），预热会 4xx /
    # ValueError —— 我们 log 警告并继续走 Initiate，至少行为不退化（与今天的
    # "完全跳过预热" 一致）。
    email_for_otp = ""
    try:
        email_for_otp = str(
            (state.identity or {}).get("email")
            or signup_body["variables"]["email"]
        ).strip()
    except (KeyError, TypeError):
        email_for_otp = ""
    if email_for_otp:
        try:
            challenge_csrf, challenge_ctx = paypal_http.generate_otp_challenge_tokens()
            challenge_body = paypal_http.build_otp_challenge_request(
                ec_token=ec_token,
                email=email_for_otp,
                csrf_nonce=challenge_csrf,
                ctx_id=challenge_ctx,
            )
            state.log(
                "[paypal_signup/otp] 发送 OTP_CHALLENGE 预热 (idapps/graphql, "
                f"placeholder csrfNonce/ctxId len=88)"
            )
            state.raise_if_cancelled()
            paypal_http.paypal_post_otp_challenge(
                state.session,
                body=challenge_body,
                referer=signup_referer or "",
                timeout=timeout,
            )
        except paypal_http.PaypalOtpChallengeRejected as exc:
            # PayPal 显式拒绝预热（4xx / 非 JSON 响应）——把 status / debug-id /
            # body 摘要 dump 到日志，让我们能从用户日志反向定位"PayPal 到底拒了什么"。
            state.log(
                f"[paypal_signup/otp] OTP_CHALLENGE 预热被拒（继续走 Initiate）: "
                f"status={exc.status} content_type={exc.content_type!r} "
                f"paypal-debug-id={exc.paypal_debug_id!r} "
                f"text_preview={exc.text[:240]!r}"
            )
            try:
                import json as _json, pathlib as _pl, time as _t
                dump = _pl.Path(f"tools/captures/paypal_otp_challenge_rejected_{int(_t.time())}.json")
                dump.parent.mkdir(parents=True, exist_ok=True)
                dump.write_text(
                    _json.dumps(
                        {
                            "status": exc.status,
                            "content_type": exc.content_type,
                            "paypal_debug_id": exc.paypal_debug_id,
                            "text_512": exc.text,
                            "request_body": challenge_body,
                            # 诊断：我们发出去的 headers（该 endpoint 应该 pop 掉 Referer）
                            "request_headers": getattr(exc, "request_headers", {}) or {},
                            # 诊断：PayPal 响应头（包含 ``Set-Cookie``——看它想让我们 set 哪些）
                            "response_headers": getattr(exc, "response_headers", {}) or {},
                            # 诊断：session cookie jar 快照（名字列表，不存 value 避免 PII）
                            "session_cookies": _snapshot_session_cookie_names(state.session),
                        },
                        ensure_ascii=False, indent=2,
                    ),
                    encoding="utf-8",
                )
                state.log(f"[paypal_signup/otp] 预热响应已 dump: {dump}")
            except Exception:
                pass
        except Exception as exc:  # noqa: BLE001 — 网络异常 / cancel 等
            state.log(
                f"[paypal_signup/otp] OTP_CHALLENGE 预热失败（继续走 Initiate）: {exc!r}"
            )
    else:
        state.log(
            "[paypal_signup/otp] 缺 email，跳过 OTP_CHALLENGE 预热（仍尝试 Initiate）"
        )

    # 0.5. fraudnet device session 注册 —— 让 ec_token 在 PayPal fraudnet 后端
    #       建立 device fingerprint record，**这是 createMemberAccount 不报
    #       OAS_ERROR 的前提**。
    #
    # PayPal SignUp (createMemberAccount) 在 OAS_ERROR checkpoint 上拒绝的最常见
    # 根因：协议模式之前完全跳过了浏览器会在 SignUp 前自动跑的 fraudnet collect
    # 序列（c.paypal.com/v1/r/d/b/p1+p2+pa），导致 PayPal 后端用 ec_token 反查
    # fraudnet record 时找不到 → SignUp 必报 OAS_ERROR。
    #
    # HAR 实采的真实顺序（2026-05-25 Camoufox 成功抓包）：
    #   1) OTP_CHALLENGE (entry 505) —— 先建立 OTP fraud context
    #   2) fraudnet second set (entries 513-517) —— 再补 device fingerprint
    #   （这与开发初期的认知相反——HAR 证明 fraudnet second set 在 OTP_CHALLENGE
    #   **之后**而非之前。错序会导致 OTP_CHALLENGE 被 PayPal 返回 pa.js HTML）
    #
    # 修复：用一次成功 HAR 抽出的 baseline body 模板（``paypal_fraudnet_baseline.json``），
    # 把 correlationId / URL / time / corrId 替换成当前会话的实时值，按 HAR
    # 真实顺序在 OTP_CHALLENGE 之后发 GET p3 → POST p1 → POST p2 → POST pa。
    #
    # 失败容错：fraudnet 模块所有 step 失败都不抛、只 log；record 建得"不全"
    # 也比"完全空"风控分数低，主流程继续走。
    state.raise_if_cancelled()
    paypal_fraudnet.register_fraudnet_session(
        state.session,
        ec_token=ec_token,
        ba_token=ba_token,
        signup_referer=signup_referer or "",
        log=state.log,
        timeout=15,
    )

    # 1a. baseline：在发 OTP_INITIATE **之前**先拉一次 relay，把当前已有的
    #     所有 6 位数字都记下来。relay 服务（如 relay.example.invalid）可能
    #     缓存了上一次任务的旧 SMS——如果不过滤，新任务会用 ``\b\d{6}\b`` 抓
    #     到旧 pin，PayPal 端 challengeId 已经变了，``OTP_CONFIRM`` 直接
    #     返回 ``VALIDATION_FAILED``（实战日志：两次同号都拿到 ``799466``）。
    #     baseline 失败（网络错 / relay 没历史）按"空集"处理，不阻塞主流程。
    state.raise_if_cancelled()
    baseline_pins: set[str] = set()
    try:
        baseline_text_holder: dict[str, str] = {}

        def _baseline_log(message: str) -> None:
            # 把 baseline 的 "已获取 PayPal 验证码" 这类日志吞掉，避免误导用户
            # 以为已经拿到真正的 SMS——baseline 拿到的恰恰是要被过滤的旧 pin。
            if "已获取 PayPal 验证码" in message:
                return
            state.log(f"[paypal_signup/otp] baseline: {message}")

        baseline_pin = _payment_module._fetch_ctf_relay_code(
            url=relay_url,
            timeout_seconds=10,
            poll_interval_seconds=1,
            initial_burst_attempts=0,
            log=_baseline_log,
            cancel_check=state.cancel_check,
            single_attempt=True,
        )
        # single_attempt 模式下：抓一次 → 如有命中返回首个 pin，否则空字符串。
        # 但我们需要**所有** baseline pin（relay 可能返回多条历史），所以直接
        # 用底层抽取函数过一遍 last 响应。这里简化处理：把 single_attempt
        # 抓到的那一个 pin 当 baseline；如果 relay 返回多个历史 pin 中只过滤
        # 第一个，剩下旧 pin 仍可能被命中——但部分 relay 每次只返回
        # 最新一条 SMS body，所以 baseline 抓一个就足够覆盖"上次残留"场景。
        if baseline_pin:
            baseline_pins.add(baseline_pin)
            state.log(
                f"[paypal_signup/otp] 已建立 baseline，将忽略 relay 中已存在的旧 pin: "
                f"{baseline_pin}"
            )
    except Exception as exc:
        state.log(f"[paypal_signup/otp] baseline 拉取失败（不阻塞）: {exc!r}")

    # 1b. initiate
    state.log(f"[paypal_signup/otp] 发起短信验证码 phone={phone_e164}")
    init_body = paypal_http.build_otp_initiate_request(
        ec_token=ec_token, phone_number_local=phone_local,
    )
    state.raise_if_cancelled()
    init_resp = paypal_http.paypal_post_otp_initiate(
        state.session, body=init_body, ec_token=ec_token, ba_token=ba_token,
        referer=signup_referer or "", client_metadata_id=cmid,
        timeout=timeout,
    )
    auth_id, challenge_id, init_state = paypal_http.parse_otp_initiate_response(init_resp)
    state.log(
        f"[paypal_signup/otp] PayPal 已发送 SMS，state={init_state} "
        f"authId={auth_id[:10]}… challengeId={challenge_id[:10]}…"
    )

    # 2. 轮询 relay_url 拉 6 位 code（带 baseline 排除）
    state.raise_if_cancelled()
    state.log(
        f"[paypal_signup/otp] 轮询 relay_url 拉验证码: {relay_url[:64]}… "
        f"(排除 {len(baseline_pins)} 条旧 pin)"
    )
    pin = _payment_module._fetch_ctf_relay_code(
        url=relay_url,
        timeout_seconds=min(timeout, 180),
        poll_interval_seconds=5,
        log=lambda m: state.log(f"[paypal_signup/otp] {m}"),
        cancel_check=state.cancel_check,
        excluded_pins=baseline_pins or None,
    )
    if not pin:
        raise RuntimeError("轮询 relay_url 超时未能获取 6 位 OTP code")
    state.log(f"[paypal_signup/otp] 拿到 OTP pin={pin}")

    # 3. confirm
    state.raise_if_cancelled()
    confirm_body = paypal_http.build_otp_confirm_request(
        ec_token=ec_token, auth_id=auth_id, challenge_id=challenge_id, pin=pin,
    )
    confirm_resp = paypal_http.paypal_post_otp_confirm(
        state.session, body=confirm_body, ec_token=ec_token, ba_token=ba_token,
        referer=signup_referer or "", client_metadata_id=cmid,
        timeout=timeout,
    )
    confirm_state = paypal_http.parse_otp_confirm_response(confirm_resp)
    state.log(f"[paypal_signup/otp] OTP 验证通过 state={confirm_state}")

    # 4. 重发 SignUp（PayPal 这次不再要求 OTP）。先把 body 里的 phone.number
    # 同步成本次刚通过 OTP 的本地号，避免轮换号时 body / OTP session 不一致。
    state.raise_if_cancelled()
    try:
        signup_body["variables"]["phone"]["number"] = phone_local
    except (KeyError, TypeError):
        pass
    state.log("[paypal_signup/otp] 发起 SignUpNewMemberMutation (OTP 后唯一一次)")
    try:
        retry_payload = paypal_http.paypal_post_signup(
            state.session, body=signup_body, ec_token=ec_token, ba_token=ba_token,
            referer=signup_referer or "", client_metadata_id=cmid,
            timeout=timeout,
        )
    except paypal_http.PaypalSignupResponseError as exc:
        # PayPal 用 HTML 风控页 / 4xx / 空 body 拒绝 SignUp。这是协议模式
        # challenge/device/cookie/beacon 链路某处不完整时的典型反应——把完整
        # 响应 dump 到 tools/captures/，下次实测时反查 PayPal 到底拒了什么
        # （是 datadome challenge？captcha 页？login 跳转？还是单纯 4xx？）。
        state.log(
            f"[paypal_signup/otp] SignUp 被拒: status={exc.status} "
            f"content_type={exc.content_type!r} "
            f"paypal-debug-id={exc.paypal_debug_id!r} "
            f"text_preview={exc.text[:240]!r}"
        )
        try:
            import json as _json, pathlib as _pl, time as _t
            dump = _pl.Path(f"tools/captures/paypal_signup_rejected_{int(_t.time())}.json")
            dump.parent.mkdir(parents=True, exist_ok=True)
            dump.write_text(
                _json.dumps(
                    {
                        "status": exc.status,
                        "content_type": exc.content_type,
                        "paypal_debug_id": exc.paypal_debug_id,
                        "text_512": exc.text,
                        "request_body": signup_body,
                        "request_meta": {
                            "ec_token": ec_token,
                            "ba_token": ba_token,
                            "client_metadata_id": cmid,
                            "referer": signup_referer or "",
                        },
                        # 诊断：我们发出去的完整 headers（含 Referer / Sec-Fetch-* /
                        # x-app-name 等）。dump 反查能确认 referer 真的是 /checkoutweb/signup?...
                        "request_headers": getattr(exc, "request_headers", {}) or {},
                        # 诊断：PayPal 响应头（包含 ``Set-Cookie`` — 表明 PayPal 认为
                        # 我们处于哪种 state）
                        "response_headers": getattr(exc, "response_headers", {}) or {},
                        # 诊断：session cookie 名字快照（不存 value 避免 PII）。
                        # 重点看是否含有 ``ts/ts_c/x-pp-s/datadome/tsrce`` 这几个关键项。
                        "session_cookies": _snapshot_session_cookie_names(state.session),
                    },
                    ensure_ascii=False, indent=2,
                ),
                encoding="utf-8",
            )
            state.log(f"[paypal_signup/otp] 拒绝响应已 dump: {dump}")
        except Exception:
            pass
        raise
    # 重发后 dump 一份，便于"OTP 通过但还是缺 token"这种情况排查
    try:
        import json as _json, pathlib as _pl, time as _t
        dump = _pl.Path(f"tools/captures/paypal_signup_retry_resp_{int(_t.time())}.json")
        dump.parent.mkdir(parents=True, exist_ok=True)
        dump.write_text(_json.dumps(retry_payload, ensure_ascii=False, indent=2), encoding="utf-8")
        state.log(f"[paypal_signup/otp] 重发响应已 dump: {dump}")
    except Exception:
        pass
    return retry_payload


def proto_stage_paypal_signup(state: ProtoState) -> StageResult:
    """PayPal Stage P7 协议化：``SignUpNewMemberMutation``，从响应抽 ``euat``。

    PayPal hermes / cardTypes / authorize 都需要 ``x-paypal-internal-euat`` header，
    这个 token 唯一来源是 SignUp 调用响应。即使卡 ``CARD_GENERIC_ERROR``，PayPal
    仍然下发 ``errors[0].errorData.accessToken`` 用于让 guest 用户继续走 hermes。

    本 stage 用 fake card / email / name + ``state.address`` 当 billingAddress
    提交 SignUp 表单。成功时把 ``euat`` 存入 ``checkout_context["paypal_euat"]``。

    PayPal 服务器对**地址完整性**敏感（line1 / city / state / postalCode），缺
    任意字段都会 401，所以这里在调 SignUp 前先 fail-fast 校验地址。
    """
    stage = "paypal_signup"
    ctx = state.checkout_context
    ec_token = str(ctx.get("ec_token") or "").strip()
    ba_token = str(ctx.get("ba_token") or "").strip()
    landing_url = str(ctx.get("paypal_landing_url") or "")

    # **不再** rotate session：同一 ec_token 跨 IP 移动是 PayPal 风控强信号，
    # 全程坚持单 IP（详见 paypal_approve / OTP 子链入口的同等注释）。

    if not ec_token:
        return StageResult(
            ok=False, stage=stage,
            error="缺少 ec_token；paypal_approve 必须先成功",
            fallback_recommended=True,
        )

    address = state.address or {}
    line1 = str(address.get("line1") or "").strip()
    city = str(address.get("city") or "").strip()
    state_code = str(address.get("state") or "").strip()
    postal = str(address.get("postal_code") or "").strip()
    if not (line1 and city and state_code and postal):
        return StageResult(
            ok=False, stage=stage,
            error=f"地址不完整 (line1/city/state/postal_code): {address!r}",
            fallback_recommended=True,
        )
    line2 = str(address.get("line2") or "").strip()

    # 生成 fake identity（卡号必然 ISSUER_DECLINE，PayPal 仍下发 accessToken）
    identity = state.identity if state.identity else _generate_paypal_signup_identity()
    state.identity = identity

    # 把 sms_pool 第一条 phone / relay_url 注入 identity，让 OTP 子链直接复用。
    # 仅在 identity 还没绑定真号时覆盖，避免上层任意改 identity 后被反复重写。
    if state.sms_pool and not state.identity.get("sms_relay_url"):
        chosen = state.sms_pool[0]
        phone_no_plus = str(chosen.get("phone") or "").strip()
        if phone_no_plus:
            state.identity["phone"] = phone_no_plus
            state.identity["phone_e164"] = str(chosen.get("phone_e164") or f"+{phone_no_plus}")
            state.identity["sms_relay_url"] = str(chosen.get("relay_url") or "")
            state.log(
                f"[{stage}] 使用 sms_pool[0] phone={state.identity['phone_e164']} "
                f"relay={state.identity['sms_relay_url'][:48]}…"
            )

    try:
        body = paypal_http.build_signup_request(
            ec_token=ec_token,
            card_number=identity["card_number"],
            card_expiration=identity["card_expiration"],
            card_cvc=identity["card_cvc"],
            email=identity["email"],
            first_name=identity["first_name"],
            last_name=identity["last_name"],
            phone_number=identity["phone"],
            billing_line1=line1,
            billing_line2=line2,
            billing_city=city,
            billing_state=state_code,
            billing_postal_code=postal,
            password=identity["password"],
        )
    except Exception as exc:
        return StageResult(
            ok=False, stage=stage,
            error=f"SignUp body 构造失败: {exc}",
            fallback_recommended=True,
        )

    # 决定流程：
    #   * sms_pool 非空 → **直接走 OTP 子链**（HAR 实采的成功流程：浏览器从不
    #     在 OTP 之前发 SignUp。协议模式之前在 OTP 之前抢跑一次 SignUp，
    #     PayPal 风控判定"同邮箱短时间两次 SignUp 尝试"，在 OTP 通过后的 retry
    #     SignUp 阶段必定回 OAS_ERROR (createMemberAccount)）。
    #   * sms_pool 为空 → 沿用旧逻辑：先发 SignUp 探测是否 PHONE_CONFIRMATION_REQUIRED；
    #     无 OTP 需求时直接拿 euat；有 OTP 需求时报错让用户去填池子。
    sms_count = len(state.sms_pool or [])
    cmid = state.paypal_cmid or ec_token
    timeout = max(int(state.timeout or 60), 30)

    # **关键**：PayPal 对 SignUp / OTP_CHALLENGE 等 GraphQL endpoint 做 Referer
    # 来源校验，必须指向 ``/checkoutweb/signup?...`` SPA 页（带 ec_token / ba_token）。
    # **不能用 ``landing_url``**——那是 ``paypal_approve`` 阶段的落地 URL
    # ``/agreements/approve?ba_token=...``，PayPal 看到非 SignUp 页 Referer 会
    # 把请求路由成"页面访问"返回 SPA HTML 容器（``content-type=text/html`` +
    # ``pa.js``），下游 ``resp.json()`` 抛 :class:`PaypalSignupResponseError`。
    # 实战证据：``tools/captures/paypal_signup_rejected_1779717292.json``
    # A synthetic regression fixture covers this historical failure.
    signup_referer = paypal_http.build_signup_referer(
        ec_token=ec_token, ba_token=ba_token,
    )

    # **HAR 真实流程的关键缺失步骤**：浏览器在 ``/agreements/approve`` 之后
    # 必先 GET ``/checkoutweb/signup?token=...&ba_token=...`` 让 PayPal 在
    # response 里 ``Set-Cookie`` 关键 session-level cookies（``ts_c`` / ``ts`` /
    # ``x-pp-s`` / ``datadome`` / ``LANG`` / ``tsrce`` 等）。跳过这次 GET 直接
    # POST ``/graphql?SignUpNewMemberMutation``，session jar 里缺这批 cookie，
    # PayPal WAF 路由成"页面访问"返回 SPA shell HTML——这是修了 Referer 之后
    # 仍 fail 的根因（dump ``paypal_signup_rejected_1779718544.json``）。
    # 失败不阻塞——SignUp 真正出错时仍会被 paypal_post_signup 的诊断捕获。
    state.raise_if_cancelled()
    try:
        signup_page = paypal_http.paypal_get_signup_page(
            state.session,
            ec_token=ec_token, ba_token=ba_token,
            referer=landing_url or "",  # 上一步是 /agreements/approve 落地页
            timeout=timeout,
        )
        cookies_summary = ",".join(signup_page.get("set_cookies", []))[:160]
        state.log(
            f"[{stage}] GET /checkoutweb/signup → status={signup_page.get('status_code')}, "
            f"cookies_set=[{cookies_summary}]"
        )
    except Exception as exc:
        # 不阻塞主流程——SignUp 真挂了会被下面的诊断更精确地捕获
        state.log(f"[{stage}] GET /checkoutweb/signup 失败（继续）: {exc}")

    if sms_count > 0:
        # HAR 真实流程：直接 OTP 子链。signup body 只在 OTP confirm 之后单次发送。
        state.log(
            f"[{stage}] sms_pool 已配置（{sms_count} 条），直接走 OTP 子链（跳过首次 SignUp）"
            f" cmid={cmid[:8]}…"
        )
        euat = ""
        last_retry_err = ""
        tried_phones: list[str] = []
        attempt_errors: list[str] = []
        payload: dict = {}
        for pool_index in range(sms_count):
            try:
                payload = _run_paypal_otp_subchain(
                    state=state, ec_token=ec_token, ba_token=ba_token,
                    signup_body=body, signup_referer=signup_referer,
                    pool_index=pool_index,
                )
            except Exception as exc:
                state.log(f"[{stage}] OTP 子链 pool[{pool_index}] 失败: {exc}")
                attempt_errors.append(f"[{pool_index}] {exc}")
                last_retry_err = f"otp_subchain_error: {exc}"
                if _is_recoverable_otp_error(exc) and pool_index + 1 < sms_count:
                    state.log(
                        f"[{stage}] pool[{pool_index}] 错误属于可恢复类型，"
                        f"轮换 pool[{pool_index + 1}] 继续重试"
                    )
                    continue
                return StageResult(
                    ok=False, stage=stage,
                    error=f"OTP 子链失败 (pool[{pool_index}]): {exc}",
                    fallback_recommended=True,
                    detail={
                        "ec_token": ec_token, "needs_otp": True,
                        "sms_pool_size": sms_count,
                        "tried_pool_indexes": list(range(pool_index + 1)),
                        "attempt_errors": attempt_errors,
                    },
                )
            try:
                euat = paypal_http.parse_signup_access_token(payload)
                break
            except ValueError as exc:
                last_retry_err = ""
                if isinstance(payload, dict):
                    errs = payload.get("errors") or []
                    if errs and isinstance(errs[0], dict):
                        last_retry_err = str(errs[0].get("message") or "")
                phone_used = (state.identity or {}).get("phone_e164") or ""
                tried_phones.append(phone_used)
                state.log(
                    f"[{stage}] pool[{pool_index}] SignUp 仍无 token "
                    f"(first_error={last_retry_err!r}, phone={phone_used})"
                )
                if last_retry_err != "OAS_ERROR":
                    attempt_errors.append(
                        f"[{pool_index}] first_error={last_retry_err!r}: {exc}"
                    )
                    break
                attempt_errors.append(f"[{pool_index}] OAS_ERROR phone={phone_used}")

        if not euat:
            if last_retry_err == "OAS_ERROR":
                otp_failed_count = sms_count - len(tried_phones)
                otp_note = (
                    f"（其中 {otp_failed_count} 条在 OTP 阶段就失败、未达 SignUp）"
                    if otp_failed_count > 0 else ""
                )
                msg = (
                    f"OTP 子链耗尽 sms_pool {sms_count} 条号码：{len(tried_phones)} 条"
                    f"在 SignUp 阶段触发 PayPal OAS_ERROR (createMemberAccount 风控)"
                    f"{otp_note}。已尝试号码: {tried_phones}。"
                    f"请提供未在最近用过的全新号码池后重试。"
                )
            else:
                msg = (
                    f"OTP 子链通过但 SignUp 仍无 accessToken "
                    f"(first_error={last_retry_err!r})"
                )
            return StageResult(
                ok=False, stage=stage,
                error=msg,
                fallback_recommended=True,
                detail={
                    "ec_token": ec_token, "needs_otp": True, "post_otp": True,
                    "retry_first_error": last_retry_err,
                    "tried_phones": tried_phones,
                    "attempt_errors": attempt_errors,
                },
            )

        state.checkout_context["paypal_euat"] = euat
        state.log(f"[{stage}] 拿到 euat={euat[:16]}… (len={len(euat)})")
        return StageResult(
            ok=True, stage=stage, next_url=landing_url,
            detail={"ec_token": ec_token, "paypal_euat": euat},
        )

    # sms_pool 为空：旧探测流程，仅用于"用户没填号码池又想试试不需 OTP 的情况"
    state.raise_if_cancelled()
    state.log(
        f"[{stage}] sms_pool 为空，先尝试单次 SignUp 探测 OTP 需求 "
        f"email={identity['email']} cmid={cmid[:8]}…"
    )
    try:
        payload = paypal_http.paypal_post_signup(
            state.session,
            body=body,
            ec_token=ec_token,
            ba_token=ba_token,
            # 必须用 SignUp 页 referer（``/checkoutweb/signup?...``），不能用
            # ``landing_url``（``/agreements/approve?ba_token=...``）——见上方
            # ``signup_referer = paypal_http.build_signup_referer(...)`` 的详细注释。
            referer=signup_referer,
            client_metadata_id=cmid,
            timeout=timeout,
        )
    except Exception as exc:
        return StageResult(
            ok=False, stage=stage,
            error=f"SignUp 调用失败: {exc}",
            fallback_recommended=True,
            detail={"ec_token": ec_token},
        )

    try:
        euat = paypal_http.parse_signup_access_token(payload)
    except ValueError as exc:
        # 服务器没给 accessToken，可能 PayPal 改了响应结构或 OTP 2FA 拦截了。
        # 把响应摘要返给上层便于排查（不打印完整响应避免日志爆量），
        # 同时**dump 完整响应到 ``tools/captures``** 以便事后离线 1:1 对比。
        import json as _json
        import pathlib as _pathlib
        import time as _time
        preview = repr(payload)
        if len(preview) > 400:
            preview = preview[:400] + "…"
        # 把完整 response 写到 tools/captures/paypal_signup_resp_<ts>.json
        dump_path = ""
        try:
            ts = int(_time.time())
            captures = _pathlib.Path("tools/captures")
            captures.mkdir(parents=True, exist_ok=True)
            dump_file = captures / f"paypal_signup_resp_{ts}.json"
            dump_file.write_text(_json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            dump_path = str(dump_file)
        except Exception:
            dump_path = ""
        # 把 errors[0].message + dump path 直接打到 log 方便从 backend 输出排查
        first_err = ""
        if isinstance(payload, dict):
            errs = payload.get("errors") or []
            if errs and isinstance(errs[0], dict):
                first_err = str(errs[0].get("message") or "")
        state.log(
            f"[{stage}] SignUp 响应缺 accessToken; "
            f"first_error={first_err!r}, preview={preview}"
            + (f", dump={dump_path}" if dump_path else "")
        )

        # sms_pool 为空走到这里，PHONE_CONFIRMATION_REQUIRED 必须配置号码池
        # 才能继续。OAS_ERROR 等其他错误直接 fallback。
        if "PHONE_CONFIRMATION_REQUIRED" in first_err.upper() or "PHONE_CONFIRMATION_REQUIRED" in preview.upper():
            return StageResult(
                ok=False, stage=stage,
                error=(
                    "PayPal 要求电话 OTP 验证（PHONE_CONFIRMATION_REQUIRED），"
                    "但 sms_pool 为空。请在支付弹窗里填入 SMS 号码池"
                    "（格式：+phone----relay_url），否则协议模式无法越过这一步。"
                ),
                fallback_recommended=False,
                detail={
                    "ec_token": ec_token, "response_preview": preview,
                    "dump_path": dump_path, "first_error": first_err,
                    "needs_otp": True, "sms_pool_size": 0,
                },
            )
        return StageResult(
            ok=False, stage=stage,
            error=str(exc),
            fallback_recommended=True,
            detail={"ec_token": ec_token, "response_preview": preview, "dump_path": dump_path},
        )

    state.checkout_context["paypal_euat"] = euat
    state.log(f"[{stage}] 拿到 euat={euat[:16]}… (len={len(euat)})")
    return StageResult(
        ok=True, stage=stage,
        detail={"ec_token": ec_token, "euat_prefix": euat[:16]},
    )


def proto_stage_paypal_authorize(state: ProtoState) -> StageResult:
    """PayPal Stage P8+P9 协议化：Hermes ``cardTypes`` + ``authorize`` 完成 $0 trial。

    依赖前一个 stage（``paypal_signup``）写入的 ``paypal_euat``。所有 GraphQL
    POST 必须带 ``x-paypal-internal-euat`` / ``x-csrf-token`` / ``PayPal-Nsid``
    / ``PAYPAL-CLIENT-METADATA-ID`` / ``x-app-name`` 这五个 header，否则 403。

    成功时把 ``returnURL.href`` 作为 ``next_url`` 返回，pipeline 调度层让 Stripe
    `/poll` (Phase 7) 收尾即可。
    """

    stage = "paypal_authorize"
    ctx = state.checkout_context
    ba_token = str(ctx.get("ba_token") or "").strip()
    ec_token = str(ctx.get("ec_token") or "").strip()
    csrf = str(ctx.get("paypal_csrf") or "").strip()
    nsid = str(ctx.get("paypal_session_id") or "").strip()
    euat = str(ctx.get("paypal_euat") or "").strip()
    # hermes 复用与 SignUp / OTP 同一个 paypal_cmid，对应浏览器内 fpti.js SDK
    # "整个 checkout session 共享同一个设备指纹 ID" 的行为。HAR 实采证明这个
    # CMID 在浏览器里**就是 ec_token**，所以没有显式配置时直接 fallback。
    client_md_id = state.paypal_cmid or ec_token

    if not ba_token or not ec_token:
        return StageResult(
            ok=False,
            stage=stage,
            error=(
                "缺少 ba_token / ec_token，请确认 paypal_approve 已成功落地"
                f"（ba_token={ba_token or '∅'}, ec_token={ec_token or '∅'}）"
            ),
            fallback_recommended=True,
            detail={"ba_token": ba_token, "ec_token": ec_token},
        )

    if not euat:
        return StageResult(
            ok=False,
            stage=stage,
            error="缺少 paypal_euat（SignUp accessToken），请确认 paypal_signup 已成功",
            fallback_recommended=True,
            detail={"ba_token": ba_token, "ec_token": ec_token},
        )

    state.raise_if_cancelled()
    hermes_url = paypal_http.build_hermes_url(ba_token=ba_token, ec_token=ec_token)
    state.log(f"[{stage}] GET hermes URL（截断）: {hermes_url[:90]}…")
    try:
        paypal_http.paypal_get_hermes(
            state.session,
            hermes_url=hermes_url,
            referer=str(ctx.get("paypal_landing_url") or "https://www.paypal.com/"),
            timeout=max(int(state.timeout or 60), 30),
        )
    except Exception as exc:
        return StageResult(
            ok=False,
            stage=stage,
            error=f"GET /webapps/hermes 失败: {exc}",
            fallback_recommended=True,
            detail={"ba_token": ba_token, "ec_token": ec_token, "hermes_url": hermes_url},
        )

    state.raise_if_cancelled()
    state.log(f"[{stage}] POST /graphql/ cardTypes (euat={euat[:8]}…)")
    try:
        ct_payload = paypal_http.paypal_graphql_batch(
            state.session,
            body=paypal_http.build_card_types_request(ec_token=ec_token),
            referer=hermes_url,
            euat=euat,
            csrf=csrf,
            nsid=nsid,
            client_metadata_id=client_md_id,
            timeout=max(int(state.timeout or 60), 30),
        )
    except Exception as exc:
        return StageResult(
            ok=False,
            stage=stage,
            error=f"cardTypes 调用失败: {exc}",
            fallback_recommended=True,
            detail={"ba_token": ba_token, "ec_token": ec_token},
        )
    allowed_card_types = paypal_http.parse_card_types_response(ct_payload)
    state.log(f"[{stage}] cardTypes.allowed={allowed_card_types or 'unknown'}")

    state.raise_if_cancelled()
    state.log(f"[{stage}] POST /graphql/ authorize (OPT_OUT)")
    try:
        auth_payload = paypal_http.paypal_graphql_batch(
            state.session,
            body=paypal_http.build_authorize_request(ec_token=ec_token),
            referer=hermes_url,
            euat=euat,
            csrf=csrf,
            nsid=nsid,
            client_metadata_id=client_md_id,
            timeout=max(int(state.timeout or 60), 30),
        )
    except Exception as exc:
        return StageResult(
            ok=False,
            stage=stage,
            error=f"authorize 调用失败: {exc}",
            fallback_recommended=True,
            detail={"ba_token": ba_token, "ec_token": ec_token},
        )

    try:
        auth_info = paypal_http.parse_authorize_response(auth_payload)
    except ValueError as exc:
        return StageResult(
            ok=False,
            stage=stage,
            error=str(exc),
            fallback_recommended=True,
            detail={"ba_token": ba_token, "ec_token": ec_token},
        )

    return_url = auth_info["return_url"]
    state.checkout_context.update(
        {
            "paypal_return_url_final": return_url,
            "paypal_buyer_user_id": auth_info.get("buyer_user_id", ""),
            "paypal_payment_action": auth_info.get("payment_action", ""),
            "paypal_ba_authorized": auth_info.get("billing_agreement_token", ""),
            "paypal_card_types_allowed": allowed_card_types,
        }
    )
    state.log(
        f"[{stage}] authorize 完成 paymentAction={auth_info.get('payment_action')} "
        f"buyer={auth_info.get('buyer_user_id') or '∅'}"
    )
    return StageResult(
        ok=True,
        stage=stage,
        next_url=return_url,
        detail={
            "ba_token": ba_token,
            "ec_token": ec_token,
            "return_url": return_url,
            "payment_action": auth_info.get("payment_action", ""),
            "buyer_user_id": auth_info.get("buyer_user_id", ""),
            "billing_agreement_token": auth_info.get("billing_agreement_token", ""),
            "card_types_allowed": allowed_card_types,
        },
    )


# 为兼容已有 import 路径，保留旧 stub 名作为别名（pipeline 不再使用）。
proto_stage_ctf_sandbox = _stub_stage(
    "ctf_sandbox", "CTF sandbox 注册/付款协议化未实现，回落 camoufox"
)
proto_stage_paypal_review = _stub_stage(
    "paypal_review", "PayPal /webapps/hermes 协议化未实现，回落 camoufox"
)


# 单次 /poll 之间的休眠时间。HAR 里浏览器 SDK 大约 1s 一次轮询。
_STRIPE_POLL_INTERVAL_SECONDS = 1.0
_STRIPE_POLL_MAX_ATTEMPTS = 600  # 兜底，避免 sleep mock 异常时无限循环


def proto_stage_stripe_poll(
    state: ProtoState,
    *,
    sleep_fn: Callable[[float], None] | None = None,
    now_fn: Callable[[], float] | None = None,
) -> StageResult:
    """Stripe ``/payment_pages/{cs}/poll`` 收尾阶段。

    PayPal 协议化阶段把控制权交回来后，调用 Stripe poll 等待 ``state=succeeded``，
    并把 ``success_url`` 作为 pipeline 最终跳转 URL 返回。受 ``state.timeout``
    约束（秒），到时仍 pending 即视为失败并允许 fallback。

    ``sleep_fn`` / ``now_fn`` 仅用于单测注入；生产环境保持默认。
    """

    import time

    stage = "stripe_poll"
    cs_id = str(state.checkout_context.get("cs_id") or "").strip()
    if not cs_id:
        try:
            cs_id = stripe_http.extract_checkout_session_id(state.current_url)
        except ValueError:
            return StageResult(
                ok=False,
                stage=stage,
                error="无法定位 checkout session id（缺少 checkout_context.cs_id 且 current_url 解析失败）",
                fallback_recommended=True,
            )

    sleep = sleep_fn or time.sleep
    now = now_fn or time.monotonic
    deadline = now() + float(state.timeout or 180)

    attempt = 0
    last_state = ""
    while True:
        if attempt >= _STRIPE_POLL_MAX_ATTEMPTS:
            return StageResult(
                ok=False,
                stage=stage,
                error=f"Stripe /poll 超过 {_STRIPE_POLL_MAX_ATTEMPTS} 次仍未终态（last_state={last_state!r}）",
                fallback_recommended=True,
                detail={"cs_id": cs_id, "attempts": attempt, "last_state": last_state},
            )
        state.raise_if_cancelled()
        attempt += 1
        try:
            poll_resp = stripe_http.stripe_poll(state.session, cs_id=cs_id)
        except Exception as exc:
            return StageResult(
                ok=False,
                stage=stage,
                error=f"/poll 第 {attempt} 次请求失败: {exc}",
                fallback_recommended=True,
                detail={"cs_id": cs_id, "attempts": attempt},
            )

        last_state = str((poll_resp or {}).get("state") or "").strip().lower()
        verdict = stripe_http.classify_poll_state(poll_resp)
        if verdict == "success":
            try:
                success_url = stripe_http.extract_poll_success_url(poll_resp)
            except ValueError as exc:
                return StageResult(
                    ok=False,
                    stage=stage,
                    error=str(exc),
                    fallback_recommended=True,
                    detail={"cs_id": cs_id, "attempts": attempt, "last_state": last_state},
                )
            state.log(f"[{stage}] state=succeeded after {attempt} polls; success_url={success_url[:80]}")
            state.checkout_context["success_url"] = success_url
            return StageResult(
                ok=True,
                stage=stage,
                next_url=success_url,
                detail={
                    "cs_id": cs_id,
                    "attempts": attempt,
                    "success_url": success_url,
                    "last_state": last_state,
                },
            )
        if verdict == "failure":
            return StageResult(
                ok=False,
                stage=stage,
                error=f"Stripe /poll 返回失败终态: {last_state}",
                fallback_recommended=False,
                detail={"cs_id": cs_id, "attempts": attempt, "last_state": last_state},
            )
        # pending：还没到终态，按节奏继续，但要在超时前
        if now() >= deadline:
            return StageResult(
                ok=False,
                stage=stage,
                error=f"Stripe /poll 在 {state.timeout}s 内未到终态（last_state={last_state!r}）",
                fallback_recommended=True,
                detail={"cs_id": cs_id, "attempts": attempt, "last_state": last_state},
            )
        sleep(_STRIPE_POLL_INTERVAL_SECONDS)


def default_pipeline() -> List[Callable[[ProtoState], StageResult]]:
    """协议模式 checkout 默认 pipeline。

    pipeline 链：``stripe_checkout`` → ``paypal_approve`` → ``paypal_signup`` →
    ``paypal_authorize`` (hermes + cardTypes + authorize) → ``stripe_poll``。

    Phase 12 起补回了 ``paypal_signup`` 这一段：因为 hermes / cardTypes /
    authorize 必须带 ``x-paypal-internal-euat`` header，而 euat 只能从 SignUp
    响应抽。SignUp 用 fake card 必然 ``ISSUER_DECLINE``，但 PayPal 服务器仍下
    发 ``accessToken``，授权 hermes 短路径继续走完。

    任何 stage 失败时设 ``fallback_recommended=True``；调度层（plugin.py
    Phase 10 起）已经改为不再自动回落 Camoufox，错误向上抛由前端展示。
    """
    return [
        proto_stage_stripe_checkout,
        proto_stage_paypal_approve,
        proto_stage_paypal_signup,
        proto_stage_paypal_authorize,
        proto_stage_stripe_poll,
    ]


def run_protocol_checkout(
    *,
    checkout_url: str,
    cookies_str: Optional[str],
    proxy: Optional[str],
    email: str,
    payment_method: str,
    timeout: int,
    log_fn: Callable[[str], None],
    cancel_check: Optional[Callable[[], bool]],
    turnstile_solver: Optional[Callable[..., str]],
    address: Optional[dict] = None,
    pipeline: Optional[List[Callable[[ProtoState], StageResult]]] = None,
    sms_pool: Optional[List[dict]] = None,
) -> dict:
    """协议模式 checkout 主入口。返回与 `complete_paypal_checkout` 兼容的 dict。"""
    log = log_fn or (lambda message: logger.info(message))

    if str(payment_method or "").strip().lower() != "paypal":
        return {
            "ok": False,
            "status": "failed",
            "final_url": checkout_url,
            "error": f"不支持的支付方式: {payment_method}",
            "fallback_recommended": False,
        }

    stages = pipeline if pipeline is not None else default_pipeline()
    log(f"协议模式 checkout 启动，pipeline {len(stages)} 段")

    session = build_protocol_session(proxy=proxy, cookies_str=cookies_str or "")
    # sms_pool 用 list() 复制一份，避免上层后续修改影响 stage 之间共享的状态
    normalized_pool: list[dict] = []
    for entry in sms_pool or []:
        if isinstance(entry, dict) and entry.get("phone") and entry.get("relay_url"):
            normalized_pool.append(dict(entry))
    if normalized_pool:
        log(f"协议模式启用 SMS 号码池，共 {len(normalized_pool)} 条")
    state = ProtoState(
        session=session,
        current_url=str(checkout_url or ""),
        proxy=proxy,
        email=str(email or ""),
        cookies_str=cookies_str or "",
        address=dict(address or {}),
        identity={},
        log=log,
        cancel_check=cancel_check,
        turnstile_solver=turnstile_solver,
        timeout=max(int(timeout or 180), 30),
        sms_pool=normalized_pool,
    )
    # ProtoState.paypal_cmid 默认空字符串，下游 fallback 会把它替换成 ec_token，
    # 但 paypal_http.paypal_post_signup 的 docstring 明确警告：
    #   "cmid==ec_token 是 PayPal 风控立刻识别为'脚本伪装'的字面模式"
    # 实测协议模式 OTP 通过后重发 SignUp 拿 OAS_ERROR (createMemberAccount 风控)
    # 的根因之一就是这个 fallback。这里在协议模式入口处显式生成一个 32 字节 hex
    # 随机 cmid，模拟真实浏览器 fpti.js SDK 行为：单次 checkout session 内所有
    # PayPal GraphQL 请求复用同一个稳定的设备指纹 ID。
    if not state.paypal_cmid:
        state.paypal_cmid = paypal_http.generate_paypal_cmid()
    # 启动时把 cmid 打到日志，方便对照请求 trace 验证 "整个 session 复用同一
    # 个 cmid" 这件事是否真的发生（同时也方便从 PayPal 后台/网络面板回查）。
    log(f"协议模式生成 paypal-client-metadata-id: {state.paypal_cmid[:8]}… (len={len(state.paypal_cmid)})")

    try:
        for stage_fn in stages:
            state.raise_if_cancelled()
            try:
                # stage 调用包一层瞬态 TLS 错重试：实战观察到 curl_cffi 在长生命
                # 周期 backend 进程里偶发 ``curl: (35) TLS connect error:
                # error:00000000:invalid library (0):OPENSSL_internal:invalid
                # library (0)`` —— 孤立 Python 进程跑同样代码无法复现，根因是
                # curl_cffi 的 BoringSSL 全局状态在多次 task 间累积污染（cffi
                # 的 native lib 不会随 uvicorn --reload 清理）。最稳的兜底是
                # 检测到这类瞬态 TLS 错时**重建 session 重跑 stage 一次**：新
                # session 会重新初始化 BoringSSL 句柄，cookie 通过 rotate_*
                # 保留，对业务无副作用。
                result = _execute_stage_with_tls_retry(state, stage_fn)
            except RuntimeError:
                raise
            except Exception as exc:
                logger.exception("协议 stage 抛出未捕获异常")
                stage_name = getattr(stage_fn, "__name__", "unknown")
                state.stage_history.append({
                    "stage": stage_name,
                    "ok": False,
                    "error": f"unhandled exception: {exc}",
                })
                return {
                    "ok": False,
                    "status": "stage_exception",
                    "final_url": state.current_url,
                    "error": f"stage {stage_name} 抛出异常: {exc}",
                    "fallback_recommended": True,
                    "stage": stage_name,
                    "stage_history": state.stage_history,
                }

            state.stage_history.append({
                "stage": result.stage,
                "ok": result.ok,
                "error": result.error,
                "detail": result.detail,
            })

            if not result.ok:
                return {
                    "ok": False,
                    "status": "stage_failed",
                    "final_url": state.current_url,
                    "error": result.error,
                    "fallback_recommended": bool(result.fallback_recommended),
                    "stage": result.stage,
                    "stage_history": state.stage_history,
                }

            if result.next_url:
                state.current_url = result.next_url

        return {
            "ok": True,
            "status": "completed",
            "final_url": state.current_url,
            "error": "",
            "stage_history": state.stage_history,
        }
    finally:
        try:
            session.close()
        except Exception:
            pass
