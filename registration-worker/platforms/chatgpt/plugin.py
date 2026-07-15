"""ChatGPT / Codex CLI 平台插件"""
import os
import re
import secrets
import threading
import time
from core.base_platform import BasePlatform, Account, AccountStatus, RegisterConfig
from core.base_mailbox import BaseMailbox
from core.registration import BrowserRegistrationAdapter, OtpSpec, ProtocolMailboxAdapter, ProtocolOAuthAdapter, RegistrationCapability, RegistrationResult
from core.registration.helpers import resolve_timeout
from core.registry import register
from core.proxy_pool import proxy_pool
from platforms._browser_backend import BrowserBackendConfig


def _result_text(result, key: str) -> str:
    if isinstance(result, dict):
        return str(result.get(key, "") or "")
    return str(getattr(result, key, "") or "")


def _assert_complete_oauth_callback(result) -> None:
    # NextAuth 流程只返回 account_id + access_token (+ session_token)
    # 传统 Codex CLI 流程返回全部 4 个字段
    required = ("account_id", "access_token")
    missing = [key for key in required if not _result_text(result, key)]
    if missing:
        raise RuntimeError(
            "ChatGPT 注册未完成完整 OAuth callback，缺少: " + ", ".join(missing)
        )


def _bool_param(params: dict, key: str, default: bool) -> bool:
    value = params.get(key)
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off", "否"}


def _int_param(params: dict, key: str, default: int) -> int:
    try:
        return int(params.get(key, default))
    except (TypeError, ValueError):
        return default


def _optional_int_param(params: dict, key: str) -> int | None:
    value = params.get(key)
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _mask_proxy(proxy: str | None) -> str:
    value = str(proxy or "").strip()
    if not value or "@" not in value:
        return value
    prefix, _, host = value.rpartition("@")
    scheme, sep, _credentials = prefix.partition("://")
    return f"{scheme}{sep}***@{host}" if sep else f"***@{host}"


def _build_checkout_har_path(email: str) -> str:
    """为 Camoufox checkout 生成 HAR 文件路径：tools/captures/checkout-<ts>-<email-slug>.har"""
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    capture_dir = os.path.join(project_root, "tools", "captures")
    os.makedirs(capture_dir, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(email or "anon")).strip("_") or "anon"
    return os.path.join(capture_dir, f"checkout-{timestamp}-{slug}.har")


def _build_get_rt_har_path(email: str) -> str:
    """Build a HAR output path for get_rt Camoufox OAuth captures."""
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    capture_dir = os.path.join(project_root, "tools", "captures")
    os.makedirs(capture_dir, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "_", str(email or "anon")).strip("_") or "anon"
    return os.path.join(capture_dir, f"get-rt-{timestamp}-{slug}.har")


def _run_sync_checkout_isolated(checkout_fn, **kwargs):
    """把 checkout 函数丢进独立线程跑，避免阻塞外层 asyncio loop / 任务线程。

    **subtask 标签透传**：外层 ``logger.log`` 用 thread-local 标签把日志
    分组到对应的 worker（前端按这个折叠）。子线程是新线程，thread-local
    天然是空的，所以这里在父线程从 ``log_fn`` 上抠出当前绑定的
    subtask（如果是 ``TaskLogger.log``），子线程进去再 set 一遍，最后
    finally 清掉。
    """
    result_box = {}
    error_box = {}

    # 尝试从 log_fn 上抠出 TaskLogger 实例和当前 subtask（best-effort）
    log_fn = kwargs.get("log_fn")
    parent_logger = getattr(log_fn, "__self__", None)
    parent_subtask: tuple[str, str] | None = None
    if parent_logger is not None and hasattr(parent_logger, "_current_subtask"):
        try:
            parent_subtask = parent_logger._current_subtask()
        except Exception:
            parent_subtask = None

    def _target():
        # 把父线程的 subtask 标签复制到子线程的 thread-local，确保子线程里
        # 调 ``logger.log`` 也能正确分组。
        if parent_logger is not None and parent_subtask and parent_subtask[0]:
            try:
                parent_logger.set_subtask(parent_subtask[0], parent_subtask[1])
            except Exception:
                pass
        try:
            result_box["result"] = checkout_fn(**kwargs)
        except BaseException as exc:
            error_box["error"] = exc
        finally:
            if parent_logger is not None and parent_subtask and parent_subtask[0]:
                try:
                    parent_logger.clear_subtask()
                except Exception:
                    pass

    thread = threading.Thread(target=_target, name="chatgpt-paypal-checkout")
    thread.start()
    thread.join()
    if error_box:
        raise error_box["error"]
    return result_box.get("result")


def _generate_chatgpt_registration_password(length: int = 16) -> str:
    """生成更稳定通过 OpenAI 注册页校验的密码。

    旧协议流已经验证过：至少带小写、数字、符号时，成功率明显更稳。
    这里再补一个大写字符，避免浏览器流随机生成出“看起来够长但组合不够强”的密码。
    """
    specials = ",._!@#"
    minimum_length = 12
    size = max(int(length or minimum_length), minimum_length)
    required = [
        secrets.choice("abcdefghijklmnopqrstuvwxyz"),
        secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        secrets.choice("0123456789"),
        secrets.choice(specials),
    ]
    pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + specials
    required.extend(secrets.choice(pool) for _ in range(size - len(required)))
    secrets.SystemRandom().shuffle(required)
    return "".join(required)


def _validate_password_action_candidate(value: str) -> str:
    password = str(value or "")
    if password != password.strip():
        raise ValueError("密码首尾不能包含空白字符")
    if not 12 <= len(password) <= 128:
        raise ValueError("密码长度必须为 12 到 128 个字符")
    if any(ord(char) < 32 or ord(char) == 127 for char in password):
        raise ValueError("密码不能包含控制字符")
    return password


@register
class ChatGPTPlatform(BasePlatform):
    name = "chatgpt"
    display_name = "ChatGPT"
    version = "1.0.0"
    supported_executors = ["protocol", "headless", "headed"]
    supported_identity_modes = ["mailbox", "oauth_browser"]
    supported_oauth_providers = ["google", "microsoft"]
    protocol_captcha_order = ("yescaptcha_api", "twocaptcha_api", "local_solver")

    # Declarative capabilities
    capabilities = [
        "query_state",      # Query account state/quota
        "refresh_token",    # Refresh auth token
        "generate_link",    # Generate payment link
        "switch_desktop",   # Switch to Codex desktop
        "upload_cpa",       # Upload to CPA system
        "upload_tm",        # Upload to Team Manager
    ]

    def __init__(self, config: RegisterConfig = None, mailbox: BaseMailbox = None):
        super().__init__(config)
        self.mailbox = mailbox

    def check_valid(self, account: Account) -> bool:
        self._last_check_overview = {}
        last_error: Exception | None = None
        try:
            from platforms.chatgpt.payment import fetch_subscription_status_details
            from core.proxy_pool import proxy_pool
            class _A: pass
            a = _A()
            extra = account.extra or {}
            a.access_token = extra.get("access_token") or account.token
            a.id_token = extra.get("id_token", "")
            a.cookies = extra.get("cookies", "")
            a.extra = extra

            region = str(getattr(account, "region", "") or extra.get("region", "") or "").strip()
            configured_proxy = self.config.proxy if self.config else None
            proxy_candidates: list[tuple[str | None, bool]] = []
            if configured_proxy:
                proxy_candidates.append((configured_proxy, False))
            else:
                pooled_proxy = proxy_pool.get_next(region=region)
                if pooled_proxy:
                    proxy_candidates.append((pooled_proxy, True))
            proxy_candidates.append((None, False))

            for proxy, should_report in proxy_candidates:
                try:
                    details = fetch_subscription_status_details(a, proxy=proxy)
                    if should_report and proxy:
                        proxy_pool.report_success(proxy)
                    status = details.get("status")
                    # 把订阅状态同步映射成前端能用的 plan_state / chips
                    # 来源（避免老 chips 还带 "Plus" 但实际已 free）。
                    if status == "plus":
                        plan_state = "subscribed"
                        chips = ["Plus"]
                    elif status == "team":
                        plan_state = "subscribed"
                        chips = ["Team"]
                    elif status == "free":
                        plan_state = "free"
                        chips = ["Free"]
                    elif status in ("expired", "invalid", "banned"):
                        plan_state = "expired"
                        chips = []
                    else:
                        plan_state = "unknown"
                        chips = []
                    overview = {
                        "plan": status,
                        "plan_name": status,
                        "plan_state": plan_state,
                        "chips": chips,
                        "check_source": details.get("source"),
                    }
                    if isinstance(details.get("usage"), dict):
                        overview["chatgpt_usage"] = details["usage"]
                    self._last_check_overview = overview
                    return status not in ("expired", "invalid", "banned", None)
                except Exception as exc:
                    last_error = exc
                    if should_report and proxy:
                        proxy_pool.report_fail(proxy)
                    continue
        except Exception as exc:
            last_error = exc
        raise RuntimeError("ChatGPT 账号状态检测失败，未更新有效性") from last_error

    def get_last_check_overview(self) -> dict:
        return dict(getattr(self, "_last_check_overview", {}) or {})

    def _prepare_registration_password(self, password: str | None) -> str | None:
        value = str(password or "").strip()
        return value or None

    def _map_chatgpt_result(
        self,
        result: dict,
        *,
        password: str = "",
        user_id: str = "",
        require_oauth: bool = False,
    ) -> RegistrationResult:
        if require_oauth:
            _assert_complete_oauth_callback(result)
        reported_password_set = bool(result.get("password_set"))
        candidate_password = str(result.get("password") or "").strip()
        password_status = str(
            result.get("password_status")
            or ("configured" if reported_password_set and candidate_password else "not_configured")
        )
        password_source = str(
            result.get("password_source")
            or ("signup_required" if reported_password_set and candidate_password else "none")
        )
        if password_status not in {"configured", "not_configured", "failed"}:
            password_status = "failed" if reported_password_set else "not_configured"
        password_set = bool(
            reported_password_set
            and password_status == "configured"
            and candidate_password
        )
        configured_password = candidate_password if password_set else ""
        if password_status == "configured" and not password_set:
            password_status = "failed"
        if password_source not in {"signup_required", "settings", "none"}:
            password_source = "none"
        if password_status == "not_configured":
            password_source = "none"
        password_error = str(result.get("password_error") or "").strip()
        password_overview = {
            "password_status": password_status,
            "password_source": password_source,
        }
        if password_error:
            password_overview["password_error"] = password_error
        return RegistrationResult(
            email=result.get("email", ""),
            password=configured_password if password_set else "",
            user_id=user_id or result.get("account_id", ""),
            token=result.get("access_token", ""),
            status=AccountStatus.REGISTERED,
            extra={
                "account_id": result.get("account_id", ""),
                "access_token": result.get("access_token", ""),
                "refresh_token": result.get("refresh_token", ""),
                "id_token": result.get("id_token", ""),
                "session_token": result.get("session_token", ""),
                "workspace_id": result.get("workspace_id", ""),
                "cookies": result.get("cookies", ""),
                "profile": result.get("profile", {}),
                "expires_at": result.get("expires_at", ""),
                "account_overview": password_overview,
                # 短链物理复用：浏览器内 PayPal checkout 结果透传给上层任务判定。
                "_shortlink_checkout": result.get("_shortlink_checkout", None),
                "workspace_join": result.get("workspace_join", None),
            },
        )

    def _run_protocol_oauth(self, ctx) -> dict:
        from platforms.chatgpt.browser_oauth import register_with_browser_oauth

        return register_with_browser_oauth(
            proxy=ctx.proxy,
            oauth_provider=ctx.identity.oauth_provider,
            email_hint=ctx.identity.email,
            timeout=resolve_timeout(ctx.extra, ("browser_oauth_timeout", "manual_oauth_timeout"), 300),
            log_fn=ctx.log,
            headless=(ctx.executor_type == "headless"),
            chrome_user_data_dir=ctx.identity.chrome_user_data_dir,
            chrome_cdp_url=ctx.identity.chrome_cdp_url,
        )

    def _build_post_register_in_browser_callback(self, ctx):
        extra = dict(ctx.extra or {})
        downstream = extra.get("_post_register_in_browser")

        workspace_options = dict(extra.get("chatgpt_workspace_join") or {})
        if not extra.get("auto_chatgpt_workspace_join") and not workspace_options.get("enabled"):
            return downstream

        from platforms.chatgpt.workspace_join import (
            run_workspace_join_flow,
            workspace_join_config,
            workspace_join_enabled,
        )

        if not workspace_join_enabled(extra):
            return downstream

        mailbox = getattr(self, "mailbox", None)
        mailbox_account = getattr(ctx.identity, "mailbox_account", None)
        cfg = workspace_join_config(extra)
        log_fn = ctx.log

        def _post_register(page, session_info: dict) -> dict:
            merged: dict = {}
            try:
                log_fn("注册完成，开始在当前 ChatGPT 页面执行 Workspace Join Request")
                workspace_result = run_workspace_join_flow(
                    page,
                    dict(session_info or {}),
                    mailbox=mailbox,
                    mailbox_account=mailbox_account,
                    config=cfg,
                    log=log_fn,
                )
                merged.update(workspace_result)
            except Exception as exc:
                log_fn(f"Workspace Join 后续流程异常（不影响账号注册结果）: {exc}")
                merged["workspace_join"] = {"ok": False, "error": str(exc)}

            if callable(downstream):
                try:
                    downstream_result = downstream(page, session_info)
                    if isinstance(downstream_result, dict):
                        merged.update(downstream_result)
                except Exception as exc:
                    log_fn(f"浏览器内后续流程异常（不影响账号注册结果）: {exc}")
            return merged

        return _post_register

    def build_browser_registration_adapter(self):
        def _build_browser_worker(ctx, artifacts):
            from platforms.chatgpt.browser_register import ChatGPTBrowserRegister

            extra = dict(ctx.extra or {})
            set_password_after_registration = _bool_param(
                extra,
                "set_password_after_registration",
                False,
            ) or _bool_param(extra, "set_password_after_register", False)
            auto_continue_post_signup = _bool_param(
                extra,
                "auto_continue_post_signup",
                True,
            )

            return ChatGPTBrowserRegister(
                headless=(ctx.executor_type == "headless"),
                proxy=ctx.proxy,
                otp_callback=artifacts.otp_callback,
                phone_callback=artifacts.phone_callback,
                log_fn=ctx.log,
                backend_config=(ctx.extra or {}).get("_reuse_backend_config"),
                post_register_in_browser=self._build_post_register_in_browser_callback(ctx),
                set_password_after_registration=set_password_after_registration,
                password_generator=_generate_chatgpt_registration_password,
                cancel_check=ctx.platform.is_cancel_requested,
                auto_continue_post_signup=auto_continue_post_signup,
            )

        return BrowserRegistrationAdapter(
            result_mapper=lambda ctx, result: self._map_chatgpt_result(
                result,
                require_oauth=getattr(ctx.identity, "identity_provider", "") == "oauth_browser",
            ),
            browser_worker_builder=_build_browser_worker,
            browser_register_runner=lambda worker, ctx, artifacts: worker.run(
                email=ctx.identity.email or "",
                password=ctx.password or "",
            ),
            oauth_runner=self._run_protocol_oauth,
            capability=RegistrationCapability(oauth_headless_requires_browser_reuse=True),
            otp_spec=OtpSpec(wait_message="等待验证码...", timeout=600),
        )

    def build_protocol_oauth_adapter(self):
        return ProtocolOAuthAdapter(
            oauth_runner=self._run_protocol_oauth,
            result_mapper=lambda ctx, result: self._map_chatgpt_result(
                result,
                user_id=result.get("account_id", ""),
                require_oauth=True,
            ),
        )

    def build_protocol_mailbox_adapter(self):
        def _build_worker(ctx, artifacts):
            from platforms.chatgpt.protocol_mailbox import ChatGPTProtocolMailboxWorker

            return ChatGPTProtocolMailboxWorker(
                mailbox=self.mailbox,
                mailbox_account=ctx.identity.mailbox_account,
                provider=(self.config.extra or {}).get("mail_provider", ""),
                proxy_url=ctx.proxy,
                log_fn=ctx.log,
                cancel_check=ctx.platform.is_cancel_requested,
            )

        def _map_result(ctx, result):
            _assert_complete_oauth_callback(result)
            access_token = result.access_token or ""
            refresh_token = result.refresh_token or ""
            session_token = result.session_token or ""
            metadata = getattr(result, "metadata", None) or {}
            candidate_password = str(result.password or "").strip()
            reported_password_set = bool(metadata.get("password_set", bool(candidate_password)))
            password_status = str(
                metadata.get("password_status")
                or ("configured" if reported_password_set and candidate_password else "not_configured")
            )
            password_source = str(
                metadata.get("password_source")
                or ("signup_required" if reported_password_set and candidate_password else "none")
            )
            if password_status not in {"configured", "not_configured", "failed"}:
                password_status = "failed" if reported_password_set else "not_configured"
            password_set = bool(
                reported_password_set
                and password_status == "configured"
                and candidate_password
            )
            configured_password = candidate_password if password_set else ""
            if password_status == "configured" and not password_set:
                password_status = "failed"
            if password_source not in {"signup_required", "settings", "none"}:
                password_source = "none"
            if password_status == "not_configured":
                password_source = "none"
            password_error = str(metadata.get("password_error") or "").strip()
            password_overview = {
                "password_status": password_status,
                "password_source": password_source,
            }
            if password_error:
                password_overview["password_error"] = password_error

            return RegistrationResult(
                email=result.email,
                password=configured_password,
                user_id=result.account_id,
                token=access_token,
                status=AccountStatus.REGISTERED,
                extra={
                    "access_token": access_token,
                    "refresh_token": refresh_token,
                    "id_token": result.id_token,
                    "session_token": session_token,
                    "workspace_id": result.workspace_id,
                    "cookies": metadata.get("cookies", ""),
                    "profile": metadata.get("profile", {}),
                    "expires_at": metadata.get("expires_at", ""),
                    "session": metadata.get("session", {}),
                    "account_overview": password_overview,
                },
            )

        return ProtocolMailboxAdapter(
            result_mapper=_map_result,
            worker_builder=_build_worker,
            register_runner=lambda worker, ctx, artifacts: worker.run(
                email=ctx.identity.email,
                password=ctx.password,
            ),
        )

    def get_platform_actions(self) -> list:
        return [
            {"id": "switch_account", "label": "切换到 Codex 桌面端", "params": []},
            {"id": "get_account_state", "label": "查询账号状态/订阅", "params": []},
            {"id": "refresh_token", "label": "刷新 Token", "params": []},
            {"id": "set_password", "label": "设置账号密码",
             "params": [
                 {"key": "password", "label": "密码（留空自动生成）", "type": "password"},
                 {"key": "proxy", "label": "本次任务代理（留空直连）", "type": "text"},
             ]},
            {"id": "get_rt", "label": "获取rt",
             "params": [
                 {"key": "browser_mode", "label": "浏览器模式", "type": "select",
                  "options": ["camoufox_headed", "camoufox_headless"]},
             ]},
            {"id": "get_rt_bypass", "label": "获取rt(绕过手机号)",
             "params": [
                 {"key": "browser_mode", "label": "浏览器模式", "type": "select",
                  "options": ["camoufox_headed", "camoufox_headless"]},
             ]},
            {"id": "payment_link", "label": "打开支付链接",
             "params": [
                 {"key": "country", "label": "地区", "type": "select",
                  "options": ["ID","US","SG","TR","HK","JP","GB","AU","CA","IN","BR","MX","EU"]},
                 {"key": "currency", "label": "币种", "type": "select",
                  "options": ["IDR","USD","SGD","TRY","HKD","JPY","GBP","AUD","CAD","INR","BRL","MXN","EUR"]},
                 {"key": "plan", "label": "套餐", "type": "select",
                  "options": ["plus", "team"]},
                 {"key": "auto_checkout", "label": "自动提交 PayPal", "type": "select",
                  "options": ["true", "false"]},
                 {"key": "use_stripe_init", "label": "Stripe协议长链(accessToken直生成)", "type": "select",
                  "options": ["false", "true"]},
                 {"key": "use_short_link", "label": "短链(checkout_ui_mode=custom)", "type": "select",
                  "options": ["false", "true"]},
                 {"key": "payment_method", "label": "支付方式", "type": "select",
                  "options": ["paypal"]},
                 {"key": "headless", "label": "后台模式", "type": "select",
                  "options": ["false", "true"]},
                 # checkout_mode 决定 PayPal checkout 浏览器后端：
                 #   - protocol: 走 Stripe API 协议链，无浏览器
                 #   - camoufox_headed / camoufox_headless: 老 Camoufox 路径
                 #   - bitbrowser_headed / bitbrowser_hidden / bitbrowser_headless:
                 #     新 BitBrowser 路径，profile ID 通过 bit_profile_id 字段传入
                 {"key": "checkout_mode", "label": "Checkout 后端模式", "type": "select",
                  "options": [
                      "",
                      "protocol",
                      "camoufox_headed",
                      "camoufox_headless",
                      "bitbrowser_headed",
                      "bitbrowser_hidden",
                      "bitbrowser_headless",
                  ]},
                 # bitbrowser_* 模式下必填：BitBrowser 客户端里手工创建好的 profile ID
                 # （比特浏览器 → 浏览器列表 → 编辑那一栏看到的 ID 字符串）。
                 # 留空时回退到 BIT_PROFILE_ID 环境变量。
                 {"key": "bit_profile_id", "label": "BitBrowser Profile ID", "type": "text",
                  "placeholder": "比特浏览器 profile ID（仅 bitbrowser_* 模式下生效）"},
                 {"key": "checkout_timeout", "label": "结账超时秒数", "type": "number"},
                 {"key": "checkout_hold_seconds", "label": "前台保留秒数", "type": "number"},
                 # SMS 号码池：批量手机号 + 短信中转 URL，PayPal OTP 用
                 # 每行 `+phone----relay_url`，多行批量。空行 / # 注释行自动忽略。
                 {"key": "sms_pool", "label": "SMS 号码池 (+phone----relay_url 每行一条)",
                  "type": "textarea", "placeholder": "+12025550101----https://relay.example.invalid/api/text-relay/TEST_RELAY_KEY_A"},
             ]},
            {"id": "upload_cpa", "label": "上传 CPA",
             "params": [
                 {"key": "api_url", "label": "CPA API URL", "type": "text"},
                 {"key": "api_key", "label": "CPA API Key", "type": "text"},
             ]},
            {"id": "upload_tm", "label": "上传 Team Manager",
             "params": [
                 {"key": "api_url", "label": "TM API URL", "type": "text"},
                 {"key": "api_key", "label": "TM API Key", "type": "text"},
             ]},
        ]

    def get_desktop_state(self) -> dict:
        from platforms.chatgpt.switch import get_codex_desktop_state

        return get_codex_desktop_state()

    def execute_action(self, action_id: str, account: Account, params: dict) -> dict:
        if action_id == "set_password":
            return self._handle_set_password(account, params)
        if action_id == "payment_link":
            return self._handle_generate_link(account, params)
        if action_id == "get_rt":
            return self._handle_get_rt(account, params)
        if action_id == "get_rt_bypass":
            return self._handle_get_rt_bypass(account, params)
        return super().execute_action(action_id, account, params)

    def _execute_platform_action(self, action_id: str, account: Account, params: dict) -> dict:
        """Handle ChatGPT-specific actions."""
        proxy = self.config.proxy if self.config else None
        extra = account.extra or {}

        class _A: pass
        a = _A()
        a.email = account.email
        a.access_token = extra.get("access_token") or account.token
        a.refresh_token = extra.get("refresh_token", "")
        a.id_token = extra.get("id_token", "")
        a.session_token = extra.get("session_token", "")
        from .constants import OAUTH_CLIENT_ID
        a.client_id = extra.get("client_id", OAUTH_CLIENT_ID)
        a.cookies = extra.get("cookies", "")
        a.user_id = account.user_id or ""
        a.account_id = account.user_id or ""

        if action_id == "switch_desktop":
            from platforms.chatgpt.switch import (
                close_codex_app,
                extract_session_token,
                fetch_chatgpt_account_state,
                get_codex_desktop_state,
                read_current_codex_account,
                restart_codex_app,
                switch_codex_account,
            )

            session_token = extract_session_token(a.session_token, a.cookies)
            if not session_token:
                return {"ok": False, "error": "Switch to Codex desktop requires session_token"}

            close_ok, close_msg = close_codex_app()
            switch_ok, switch_data = switch_codex_account(session_token=session_token, cookies=a.cookies)
            if not switch_ok:
                return {"ok": False, "error": switch_data.get("error", "Switch failed")}

            remote_state = fetch_chatgpt_account_state(
                access_token=a.access_token,
                session_token=session_token,
                cookies=a.cookies,
                proxy=proxy,
            )
            local_state = read_current_codex_account()
            restart_ok, restart_msg = restart_codex_app()
            message_parts = [switch_data.get("message", "Codex credentials written")]
            if close_msg:
                message_parts.append(close_msg)
            if restart_msg:
                message_parts.append(restart_msg)
            data = {
                "message": ".".join(part for part in message_parts if part),
                "close": {"ok": close_ok, "message": close_msg},
                "restart": {"ok": restart_ok, "message": restart_msg},
                "local_app_account": local_state,
                "desktop_app_state": get_codex_desktop_state(),
                "remote_state": remote_state,
                "switch_details": switch_data,
            }
            if remote_state.get("access_token"):
                data["access_token"] = remote_state["access_token"]
            if remote_state.get("refresh_token"):
                data["refresh_token"] = remote_state["refresh_token"]
            return {"ok": True, "data": data}

        if action_id == "upload_cpa":
            from platforms.chatgpt.cpa_upload import upload_to_cpa, generate_token_json
            token_data = generate_token_json(a)
            ok, msg = upload_to_cpa(token_data, api_url=params.get("api_url"),
                                    api_key=params.get("api_key"))
            return {"ok": ok, "data": msg}

        if action_id == "upload_tm":
            from platforms.chatgpt.cpa_upload import upload_to_team_manager
            ok, msg = upload_to_team_manager(a, api_url=params.get("api_url"),
                                             api_key=params.get("api_key"))
            return {"ok": ok, "data": msg}

        if action_id == "payment_link":
            return self._handle_generate_link(account, params)

        raise NotImplementedError(f"Unknown action: {action_id}")

    # Override specific capability handlers
    def _handle_query_state(self, account: Account, params: dict) -> dict:
        """Handle query_state capability for ChatGPT."""
        proxy = self.config.proxy if self.config else None
        extra = account.extra or {}

        class _A: pass
        a = _A()
        a.access_token = extra.get("access_token") or account.token
        a.session_token = extra.get("session_token", "")
        a.cookies = extra.get("cookies", "")

        from platforms.chatgpt.switch import fetch_chatgpt_account_state, get_codex_desktop_state, read_current_codex_account

        data = fetch_chatgpt_account_state(
            access_token=a.access_token,
            session_token=a.session_token,
            cookies=a.cookies,
            proxy=proxy,
        )
        data["local_app_account"] = read_current_codex_account()
        data["desktop_app_state"] = get_codex_desktop_state()
        return {"ok": True, "data": data}

    def _handle_refresh_token(self, account: Account, params: dict) -> dict:
        """Handle refresh_token capability for ChatGPT."""
        proxy = self.config.proxy if self.config else None
        extra = account.extra or {}

        class _A: pass
        a = _A()
        a.access_token = extra.get("access_token") or account.token
        a.refresh_token = extra.get("refresh_token", "")
        a.session_token = extra.get("session_token", "")
        a.cookies = extra.get("cookies", "")

        from platforms.chatgpt.token_refresh import TokenRefreshManager
        manager = TokenRefreshManager(proxy_url=proxy)
        result = manager.refresh_account(a)
        if result.success:
            data = {"access_token": result.access_token, "refresh_token": result.refresh_token}
            try:
                from platforms.chatgpt.switch import fetch_chatgpt_account_state
                data["account_state"] = fetch_chatgpt_account_state(
                    access_token=result.access_token,
                    session_token=a.session_token,
                    cookies=a.cookies,
                    proxy=proxy,
                )
            except Exception:
                pass
            return {"ok": True, "data": data}
        return {"ok": False, "error": result.error_message}

    def _handle_set_password(self, account: Account, params: dict) -> dict:
        from platforms.chatgpt.browser_register import (
            BrowserTaskCancelled,
            ChatGPTBrowserRegister,
            _sanitize_password_error,
        )

        params = dict(params or {})
        supplied_password = params.get("password")
        try:
            candidate_password = _validate_password_action_candidate(
                _generate_chatgpt_registration_password()
                if supplied_password in (None, "")
                else str(supplied_password)
            )
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        proxy = str(params.get("proxy") or "").strip() or None
        raw_log_fn = getattr(self, "log", print)

        def log_fn(message):
            raw_log_fn(
                _sanitize_password_error(
                    message,
                    candidate_password,
                    sensitive_values=[str(account.email or ""), str(proxy or "")],
                )
            )

        log_fn(
            "设置密码 action 使用显式代理: " + _mask_proxy(proxy)
            if proxy
            else "设置密码 action 已显式选择直连"
        )

        otp_callback, otp_error = self._build_get_rt_mailbox_otp_callback(
            account,
            log_fn,
            proxy,
            purpose="设置密码",
            require_account_email=True,
        )
        if not otp_callback:
            error = _sanitize_password_error(otp_error, candidate_password)
            return {
                "ok": False,
                "error": error,
                "data": {
                    "password_status": "failed",
                    "password_source": "settings",
                    "password_verification": "failed",
                    "password_error": error,
                },
            }

        extra = dict(account.extra or {})
        cookies = extra.get("cookies") or extra.get("cookie") or ""
        session_token = str(extra.get("session_token") or extra.get("sessionToken") or "").strip()
        if not cookies and session_token:
            cookies = f"__Secure-next-auth.session-token={session_token}"
        expected_account_id = str(
            extra.get("account_id")
            or extra.get("accountId")
            or account.user_id
            or ""
        ).strip()

        worker = ChatGPTBrowserRegister(
            headless=False,
            proxy=proxy,
            otp_callback=otp_callback,
            log_fn=log_fn,
            backend_config=BrowserBackendConfig.camoufox(headless=False),
            cancel_check=getattr(self, "_cancel_check_fn", None),
        )
        try:
            result = worker.set_password_for_existing_account(
                email=account.email,
                password=candidate_password,
                cookies=cookies,
                expected_account_id=expected_account_id,
            )
        except BrowserTaskCancelled:
            return {"ok": False, "error": "任务已取消"}
        except Exception as exc:
            error = _sanitize_password_error(
                exc,
                candidate_password,
                sensitive_values=[str(proxy or ""), str(cookies or "")],
            )
            return {"ok": False, "error": error}

        success = bool(
            result.get("password_set")
            and result.get("password_status") == "configured"
            and result.get("password_verification")
            in {"success_url", "password_login_reconciled"}
            and result.get("password") == candidate_password
        )
        if not success:
            error = _sanitize_password_error(
                result.get("password_error") or "ChatGPT 密码设置未完成",
                candidate_password,
                sensitive_values=[str(proxy or ""), str(cookies or "")],
            )
            failure_data = {
                "password_status": "failed",
                "password_source": "settings",
                "password_verification": "failed",
                "password_error": error,
            }
            return {"ok": False, "error": error, "data": failure_data}

        return {"ok": True, "data": result}

    def _build_get_rt_mailbox_otp_callback(
        self,
        account: Account,
        log_fn,
        proxy: str | None,
        *,
        purpose: str = "获取rt",
        require_account_email: bool = False,
    ):
        """Build an OTP callback from the mailbox resource attached to account."""
        from core.base_mailbox import MailboxAccount, create_mailbox

        def _text(value) -> str:
            return str(value or "").strip()

        def _safe_dict(value) -> dict:
            return dict(value) if isinstance(value, dict) else {}

        def _safe_list(value) -> list:
            return list(value) if isinstance(value, (list, tuple)) else []

        def _mailbox_provider_key(value: str, metadata: dict | None = None) -> str:
            raw = _text(value)
            api_mode = _text((metadata or {}).get("api_mode")).lower()
            if raw in {"cloud_mail", "cfworker"} or api_mode in {"cloud_mail", "cfworker"}:
                return "cfworker_admin_api"
            return {
                "outlook_email": "outlook_email_api",
                "local_ms": "local_ms_pool",
                "laoudo": "laoudo_api",
            }.get(raw, raw)

        def _apply_provider_compat_settings(provider_key: str, runtime_extra: dict, metadata: dict) -> None:
            if provider_key == "cfworker_admin_api":
                if metadata.get("api_url") and not runtime_extra.get("cfworker_api_url"):
                    runtime_extra["cfworker_api_url"] = metadata.get("api_url")
                if metadata.get("domain") and not runtime_extra.get("cfworker_domain"):
                    runtime_extra["cfworker_domain"] = metadata.get("domain")
                token = (
                    metadata.get("admin_token")
                    or metadata.get("public_token")
                    or metadata.get("api_token")
                    or metadata.get("token")
                )
                if token and not runtime_extra.get("cfworker_admin_token"):
                    runtime_extra["cfworker_admin_token"] = token
            if provider_key == "outlook_email_api":
                if metadata.get("api_url"):
                    runtime_extra["outlook_email_api_url"] = metadata.get("api_url")
                runtime_extra["outlook_email_fixed_email"] = _text(account.email)

        extra = _safe_dict(account.extra)
        resources = [dict(item) for item in _safe_list(extra.get("provider_resources")) if isinstance(item, dict)]
        mailbox_resources = []
        for item in resources:
            if _text(item.get("resource_type") or "mailbox").lower() == "mailbox":
                mailbox_resources.append(item)

        if not mailbox_resources:
            mailbox = _safe_dict(extra.get("verification_mailbox"))
            if not mailbox:
                mailbox = _safe_dict(_safe_dict(extra.get("identity")).get("mailbox"))
            if mailbox:
                mailbox_resources.append({
                    "provider_type": "mailbox",
                    "provider_name": mailbox.get("provider"),
                    "resource_type": "mailbox",
                    "resource_identifier": mailbox.get("account_id"),
                    "handle": mailbox.get("email"),
                    "display_name": mailbox.get("email"),
                    "metadata": {
                        "account_id": mailbox.get("account_id"),
                        "email": mailbox.get("email"),
                    },
                })

        if not mailbox_resources:
            return None, "账号没有绑定邮箱 provider 资源，无法自动读取真实邮箱 OTP"

        provider_accounts = [
            dict(item) for item in _safe_list(extra.get("provider_accounts")) if isinstance(item, dict)
        ]
        last_error = ""
        selected_provider_name = ""
        mailbox = None
        mailbox_account = None

        for mailbox_resource in mailbox_resources:
            metadata = _safe_dict(mailbox_resource.get("metadata"))
            raw_provider_name = _text(mailbox_resource.get("provider_name") or mailbox_resource.get("provider"))
            provider_name = _mailbox_provider_key(raw_provider_name, metadata)
            mailbox_email = _text(
                mailbox_resource.get("handle")
                or mailbox_resource.get("display_name")
                or metadata.get("email")
                or account.email
            )
            account_id = _text(
                mailbox_resource.get("resource_identifier")
                or metadata.get("account_id")
                or metadata.get("id")
                or mailbox_email
            )

            if not provider_name:
                last_error = "账号邮箱资源缺少 provider_name"
                continue
            if not mailbox_email:
                last_error = "账号邮箱资源缺少 email"
                continue
            if require_account_email and mailbox_email.casefold() != _text(account.email).casefold():
                last_error = "账号绑定邮箱资源与原注册邮箱不一致"
                continue

            accepted_providers = {provider_name, raw_provider_name}
            if provider_name == "cfworker_admin_api":
                accepted_providers.update({"cloud_mail", "cfworker"})
            if provider_name == "outlook_email_api":
                accepted_providers.add("outlook_email")
            if provider_name == "local_ms_pool":
                accepted_providers.add("local_ms")
            if provider_name == "laoudo_api":
                accepted_providers.add("laoudo")
            accepted_providers = {item for item in accepted_providers if item}

            same_provider_account = None
            matched_provider_account = None
            email_lc = mailbox_email.lower()
            account_id_lc = account_id.lower()
            for item in provider_accounts:
                item_provider = _mailbox_provider_key(
                    _text(item.get("provider_name") or item.get("provider")),
                    _safe_dict(item.get("metadata")),
                )
                raw_item_provider = _text(item.get("provider_name") or item.get("provider"))
                if (item_provider or raw_item_provider) and not ({item_provider, raw_item_provider} & accepted_providers):
                    continue
                if same_provider_account is None:
                    same_provider_account = item
                item_metadata = _safe_dict(item.get("metadata"))
                item_credentials = _safe_dict(item.get("credentials"))
                candidates = {
                    _text(item.get("login_identifier")).lower(),
                    _text(item.get("display_name")).lower(),
                    _text(item_metadata.get("email")).lower(),
                    _text(item_metadata.get("account_id")).lower(),
                    _text(item_credentials.get("email")).lower(),
                    _text(item_credentials.get("login_account")).lower(),
                    _text(item.get("id")).lower(),
                }
                if email_lc in candidates or (account_id_lc and account_id_lc in candidates):
                    matched_provider_account = item
                    break

            provider_account = matched_provider_account or same_provider_account
            runtime_extra = dict(metadata)
            _apply_provider_compat_settings(provider_name, runtime_extra, metadata)
            runtime_extra["provider_resource"] = mailbox_resource
            if provider_account:
                runtime_extra["provider_account"] = provider_account

            mailbox_account_extra = dict(runtime_extra)
            mailbox_account_extra["mailbox_provider_key"] = provider_name
            mailbox_account = MailboxAccount(
                email=mailbox_email,
                account_id=account_id,
                extra=mailbox_account_extra,
            )
            try:
                mailbox = create_mailbox(provider_name, extra=runtime_extra, proxy=proxy)
            except Exception as exc:
                last_error = f"{raw_provider_name or provider_name} -> {provider_name}: {exc}"
                log_fn(f"  {purpose}: 跳过不可用邮箱资源 {last_error}")
                mailbox = None
                mailbox_account = None
                continue
            selected_provider_name = provider_name
            if raw_provider_name and raw_provider_name != provider_name:
                log_fn(f"  {purpose}: 邮箱 provider 兼容映射 {raw_provider_name} -> {provider_name}")
            break

        if mailbox is None or mailbox_account is None:
            return None, f"无法初始化账号邮箱 provider: {last_error or '没有可用邮箱资源'}"

        before_ids: set = set()
        stop_wait = threading.Event()

        def _refresh_baseline(*, strict: bool = False):
            if stop_wait.is_set():
                return set(before_ids)
            self.raise_if_cancelled()
            getter_name = "get_current_ids_strict" if strict else "get_current_ids"
            getter = getattr(mailbox, getter_name, None)
            if not callable(getter):
                if strict:
                    raise RuntimeError("刷新原邮箱 OTP 基线失败: mailbox 不支持严格邮件快照")
                return set(before_ids)
            try:
                before_ids.update(set(getter(mailbox_account) or set()))
            except Exception as exc:
                if strict:
                    raise RuntimeError(f"刷新原邮箱 OTP 基线失败: {exc}") from exc
                log_fn(f"  {purpose}: 邮箱 OTP 基线读取失败，继续使用现有基线")
            if stop_wait.is_set():
                return set(before_ids)
            self.raise_if_cancelled()
            return set(before_ids)

        _refresh_baseline(strict=False)
        log_fn(
            f"  {purpose}: 原邮箱 OTP 基线已读取 provider={selected_provider_name} "
            f"before_ids={len(before_ids)}"
        )

        def _otp_callback():
            log_fn(f"  {purpose}: 等待原邮箱 OTP provider={selected_provider_name}")
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                if stop_wait.is_set():
                    return ""
                self.raise_if_cancelled()
                try:
                    code = mailbox.wait_for_code(
                        mailbox_account,
                        keyword="",
                        timeout=min(5, max(1, int(deadline - time.monotonic()))),
                        before_ids=set(before_ids),
                    )
                except TimeoutError:
                    code = ""
                if stop_wait.is_set():
                    return ""
                self.raise_if_cancelled()
                if code:
                    log_fn(f"  {purpose}: 原邮箱 OTP 已获取")
                    _refresh_baseline(strict=False)
                    return code
            return ""

        _otp_callback.refresh_baseline = _refresh_baseline
        _otp_callback.cancel_wait = stop_wait.set

        return _otp_callback, ""

    def _handle_get_rt(self, account: Account, params: dict) -> dict:
        """通过浏览器 OAuth 获取 refresh_token（真实邮箱 OTP + 真实手机号 OTP）。

        参数：
          browser_mode: 浏览器模式
          sms_provider: 手机接码渠道（smspool / smsapi，空=不启用手机验证）
          smspool_api_key: SMSPool API key
          smspool_max_price: SMSPool 价格上限 USD
          smsapi_phone: smsapi 固定手机号
          smsapi_url: smsapi 查询短信 API URL
        """
        log_fn = getattr(self, "log", print)
        cancel_fn = getattr(self, "_cancel_check_fn", None)

        browser_mode = str(params.get("browser_mode") or "camoufox_headed")
        record_har = _bool_param(params, "record_har", False)
        proxy = self.config.proxy if self.config else None

        if not account.password:
            return {"ok": False, "error": "账号缺少密码，无法进行 OAuth 登录"}

        acquired_profile_id = ""
        bit_profile_id = ""

        try:
            from platforms._browser_backend import parse_checkout_mode
            from platforms.chatgpt.browser_register import (
                ChatGPTBrowserRegister,
                _build_proxy_config,
                _do_codex_oauth,
            )
            from platforms.chatgpt.browser_get_rt import (
                setup_oauth_state_capture,
                build_get_rt_phone_callback,
            )

            # ★ BitBrowser 模式：自动从 Profile 池获取可用的 profile ID
            if str(browser_mode or "").startswith("bitbrowser_"):
                from application.bitbrowser_profiles import (
                    acquire_profile_for_browser_mode,
                )
                bit_profile_id, acquired_profile_id = acquire_profile_for_browser_mode(
                    browser_mode,
                    fallback=bit_profile_id,
                    log_fn=log_fn,
                )

            backend_config = parse_checkout_mode(browser_mode, bit_profile_id=bit_profile_id)
            record_har_path = _build_get_rt_har_path(account.email) if record_har else None
            if record_har and not backend_config.is_camoufox:
                log_fn(
                    f"  get_rt HAR capture skipped: browser_mode={browser_mode} "
                    "does not support Playwright record_har_path"
                )
                record_har_path = None
            otp_callback, otp_error = self._build_get_rt_mailbox_otp_callback(account, log_fn, proxy)
            if not otp_callback:
                return {"ok": False, "error": f"获取rt失败: {otp_error}"}

            # ★ 手机号 OTP 回调（可选）
            phone_callback = None
            sms_provider = str(params.get("sms_provider") or "").strip().lower()
            supplied_phone_callback = params.get("phone_callback")
            if callable(supplied_phone_callback):
                phone_callback = supplied_phone_callback
                log_fn(f"  获取rt: 使用任务级手机号复用 callback provider={sms_provider or '(unknown)'}")
            elif sms_provider:
                phone_callback, phone_error = build_get_rt_phone_callback(
                    sms_provider=sms_provider,
                    smspool_api_key=str(params.get("smspool_api_key") or ""),
                    smspool_max_price=str(params.get("smspool_max_price") or "0.13"),
                    smsapi_phone=str(params.get("smsapi_phone") or ""),
                    smsapi_url=str(params.get("smsapi_url") or ""),
                    log_fn=log_fn,
                )
                if not phone_callback:
                    log_fn(f"  获取rt: 手机 OTP 回调创建失败: {phone_error}，继续仅邮箱流程")
                else:
                    log_fn(f"  获取rt: 手机 OTP 已就绪 provider={sms_provider}")

            log_fn(f"获取rt: {account.email}, browser_mode={browser_mode}, sms={sms_provider or '(无)'}")

            # 创建一个只用于 get_rt 的轻量 register 实例
            reg = ChatGPTBrowserRegister(
                headless=backend_config.is_headless,
                proxy=proxy,
                log_fn=log_fn,
                backend_config=backend_config,
            )

            if reg.backend_config.is_bitbrowser:
                launch_opts = {"headless": reg.backend_config.is_headless}
            else:
                cam_proxy = _build_proxy_config(reg.proxy)
                launch_opts = {"headless": reg.headless}
                if cam_proxy:
                    launch_opts["proxy"] = cam_proxy

            with reg._open_browser(launch_opts) as browser:
                har_context = None
                if record_har_path:
                    try:
                        os.makedirs(os.path.dirname(record_har_path), exist_ok=True)
                        har_context = browser.new_context(
                            record_har_path=record_har_path,
                            record_har_url_filter="**/*",
                        )
                        page = har_context.new_page()
                        log_fn(f"  get_rt HAR capture enabled: {record_har_path}")
                    except Exception as exc:
                        log_fn(f"  get_rt HAR capture init failed, continue without HAR: {exc}")
                        record_har_path = None
                        har_context = None
                        page = browser.new_page()
                else:
                    page = browser.new_page()

                try:
                    setup_oauth_state_capture(page, log=log_fn)
                    log_fn("  获取rt: 浏览器已打开，开始 OAuth...")

                    if callable(cancel_fn) and cancel_fn():
                        return {"ok": False, "error": "任务已取消"}

                    result = _do_codex_oauth(
                        page, {}, account.email, account.password,
                        otp_callback,
                        phone_callback,
                        proxy, log_fn,
                    )

                    if not isinstance(result, dict) or not result.get("access_token"):
                        error_detail = "OAuth 未返回 token"
                        if isinstance(result, dict):
                            error_detail = str(result.get("error") or result.get("detail") or error_detail)
                        return {"ok": False, "error": f"获取rt失败: {error_detail}"}

                    refresh_token = str(result.get("refresh_token") or "")
                    access_token = str(result.get("access_token") or "")
                    log_fn(
                        f"  获取rt成功: {account.email}"
                        f" access_token={access_token[:20]}..."
                        f" refresh_token={'有' if refresh_token else '无'}"
                    )

                    return {
                        "ok": True,
                        "data": {
                            "access_token": access_token,
                            "refresh_token": refresh_token,
                            "id_token": str(result.get("id_token") or ""),
                            "account_id": str(result.get("account_id") or ""),
                            "email": account.email,
                            "record_har_path": record_har_path or "",
                            "message": "refresh_token 获取成功" if refresh_token else "access_token 获取成功（无 refresh_token）",
                        },
                    }
                finally:
                    if har_context is not None:
                        try:
                            har_context.close()
                            log_fn(f"  get_rt HAR saved: {record_har_path}")
                        except Exception as exc:
                            log_fn(f"  get_rt HAR context close failed: {exc}")

        except Exception as exc:
            log_fn(f"  获取rt异常: {exc}")
            return {"ok": False, "error": f"获取rt异常: {exc}"}
        finally:
            if acquired_profile_id:
                try:
                    from application.bitbrowser_profiles import release_acquired_profile
                    release_acquired_profile(acquired_profile_id, log_fn=log_fn)
                except Exception:
                    pass

    def _handle_get_rt_bypass(self, account: Account, params: dict) -> dict:
        """通过浏览器 OAuth 获取 refresh_token（session/select 拦截绕过手机验证）。

        与 _handle_get_rt 的区别：
          - 不接真实手机号，不调 smspool/smsapi
          - 用 Playwright route 拦截 POST session/select 响应，
            把 phone_otp_* 替换为 consent 类型，让浏览器直接跳 consent
          - 邮箱 OTP 仍需真实接码

        参数：
          browser_mode: 浏览器模式
        """
        log_fn = getattr(self, "log", print)
        cancel_fn = getattr(self, "_cancel_check_fn", None)

        browser_mode = str(params.get("browser_mode") or "camoufox_headed")
        proxy = self.config.proxy if self.config else None

        if not account.password:
            return {"ok": False, "error": "账号缺少密码，无法进行 OAuth 登录"}

        acquired_profile_id = ""
        bit_profile_id = ""

        try:
            from platforms._browser_backend import parse_checkout_mode
            from platforms.chatgpt.browser_register import (
                ChatGPTBrowserRegister,
                _build_proxy_config,
                _do_codex_oauth,
            )
            from platforms.chatgpt.browser_get_rt import setup_phone_otp_skip_interception
            from platforms.chatgpt.oauth import generate_oauth_url
            from platforms.chatgpt.constants import CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CODEX_SCOPE

            # 预生成 OAuth 参数（curl fallback 用）
            oauth_start = generate_oauth_url(
                redirect_uri=CODEX_REDIRECT_URI,
                scope=CODEX_SCOPE,
                client_id=CODEX_CLIENT_ID,
            )

            if str(browser_mode or "").startswith("bitbrowser_"):
                from application.bitbrowser_profiles import (
                    acquire_profile_for_browser_mode,
                )
                bit_profile_id, acquired_profile_id = acquire_profile_for_browser_mode(
                    browser_mode,
                    fallback=bit_profile_id,
                    log_fn=log_fn,
                )

            backend_config = parse_checkout_mode(browser_mode, bit_profile_id=bit_profile_id)
            otp_callback, otp_error = self._build_get_rt_mailbox_otp_callback(account, log_fn, proxy)
            if not otp_callback:
                return {"ok": False, "error": f"获取rt失败: {otp_error}"}

            log_fn(f"获取rt(绕过): {account.email}, browser_mode={browser_mode}")

            reg = ChatGPTBrowserRegister(
                headless=backend_config.is_headless,
                proxy=proxy,
                log_fn=log_fn,
                backend_config=backend_config,
            )

            if reg.backend_config.is_bitbrowser:
                launch_opts = {"headless": reg.backend_config.is_headless}
            else:
                cam_proxy = _build_proxy_config(reg.proxy)
                launch_opts = {"headless": reg.headless}
                if cam_proxy:
                    launch_opts["proxy"] = cam_proxy

            with reg._open_browser(launch_opts) as browser:
                page = browser.new_page()
                setup_phone_otp_skip_interception(page, log=log_fn)
                log_fn("  获取rt(绕过): session/select 拦截器已就绪（phone_otp→consent）")

                if callable(cancel_fn) and cancel_fn():
                    return {"ok": False, "error": "任务已取消"}

                result = _do_codex_oauth(
                    page, {}, account.email, account.password,
                    otp_callback,
                    None,
                    proxy, log_fn,
                    oauth_start=oauth_start,
                )

                # ★ Fallback: curl 补全会话 (workspace/select → callback)
                if not isinstance(result, dict) or not result.get("access_token"):
                    import time as _time, json as _json, re as _re
                    from platforms.chatgpt.browser_register import _get_cookies
                    cookies_dict = _get_cookies(page)
                    log_fn("  获取rt(绕过): _do_codex_oauth 退出，curl 补全...")
                    try:
                        import curl_cffi.requests as _curl_requests
                        s = _curl_requests.Session()
                        cookie_parts = [f'{k}={v}' for k, v in cookies_dict.items() if v]
                        cookie_header = '; '.join(cookie_parts)
                        headers = {
                            "accept": "application/json",
                            "origin": "https://auth.openai.com",
                            "referer": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
                            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "cookie": cookie_header,
                        }
                        workspace_id = ""
                        # Try 1: client_auth_session_dump
                        dump_resp = s.get("https://auth.openai.com/api/accounts/client_auth_session_dump",
                            headers=headers, timeout=30, impersonate="chrome")
                        log_fn(f"  获取rt(绕过): client_auth_session_dump -> {dump_resp.status_code}")
                        if dump_resp.status_code < 400:
                            dump_data = dump_resp.json() if dump_resp.text else {}
                            workspaces = dump_data.get("workspaces") or []
                            if workspaces:
                                workspace_id = str(workspaces[0].get("id") or "")
                            log_fn(f"  获取rt(绕过): dump workspaces={len(workspaces)}")

                        # Try 2: use account's user_id as workspace_id
                        if not workspace_id and account.user_id:
                            workspace_id = account.user_id
                            log_fn(f"  获取rt(绕过): 尝试 user_id={workspace_id[:20]}...")

                        # Try 3: POST workspace/select with each candidate
                        for ws_candidate in [workspace_id] if workspace_id else []:
                            ws_resp = s.post(
                                "https://auth.openai.com/api/accounts/workspace/select",
                                data=_json.dumps({"workspace_id": ws_candidate}),
                                headers={**headers, "content-type": "application/json"},
                                allow_redirects=False, timeout=30, impersonate="chrome",
                            )
                            log_fn(f"  获取rt(绕过): workspace/select({ws_candidate[:16]}...) -> {ws_resp.status_code}")
                            if ws_resp.status_code < 400:
                                ws_data = ws_resp.json() if ws_resp.text else {}
                                cb_url = str(ws_data.get("continue_url") or "")
                                # Also check Location header
                                if not cb_url:
                                    cb_url = str(ws_resp.headers.get("Location") or "")
                                if "code=" in cb_url or "localhost:1455" in cb_url:
                                    m = _re.search(r'state=([^&\s]+)', cb_url)
                                    cb_state = m.group(1) if m else oauth_start.state
                                    from platforms.chatgpt.oauth import submit_callback_url
                                    result_json = submit_callback_url(
                                        callback_url=cb_url, expected_state=cb_state,
                                        code_verifier=oauth_start.code_verifier,
                                        redirect_uri=oauth_start.redirect_uri,
                                        client_id=oauth_start.client_id, proxy_url=proxy,
                                    )
                                    result = _json.loads(result_json)
                                    log_fn("  获取rt(绕过): curl workspace/select 补全成功!")
                                    break
                    except Exception as curl_exc:
                        log_fn(f"  获取rt(绕过): curl 补全异常: {curl_exc}")

                if not isinstance(result, dict) or not result.get("access_token"):
                    error_detail = "OAuth 未返回 token"
                    if isinstance(result, dict):
                        error_detail = str(result.get("error") or result.get("detail") or error_detail)
                    return {"ok": False, "error": f"获取rt失败: {error_detail}"}

                refresh_token = str(result.get("refresh_token") or "")
                access_token = str(result.get("access_token") or "")
                id_token = str(result.get("id_token") or "")
                result_data = dict(result)
                id_token_claims = {}
                try:
                    from platforms.chatgpt.oauth import _jwt_claims_no_verify
                    id_token_claims = _jwt_claims_no_verify(id_token)
                    if id_token_claims:
                        result_data["id_token_claims"] = id_token_claims
                except Exception:
                    id_token_claims = {}
                profile = {}
                try:
                    from platforms.chatgpt.browser_oauth import _fetch_profile
                    profile = _fetch_profile(access_token, proxy=proxy)
                    if profile:
                        result_data["profile"] = profile
                        result_data["remote_user"] = profile
                except Exception as exc:
                    log_fn(f"  获取rt: profile 拉取失败（忽略）: {exc}")
                resolved_email = str(
                    result_data.get("email")
                    or (profile.get("email") if isinstance(profile, dict) else "")
                    or account.email
                )
                result_data.update(
                    {
                        "access_token": access_token,
                        "refresh_token": refresh_token,
                        "id_token": id_token,
                        "account_id": str(result.get("account_id") or ""),
                        "email": resolved_email,
                        "message": "refresh_token 获取成功" if refresh_token else "access_token 获取成功（无 refresh_token）",
                    }
                )
                log_fn(
                    f"  获取rt成功: {account.email}"
                    f" access_token={access_token[:20]}..."
                    f" refresh_token={'有' if refresh_token else '无'}"
                )

                return {
                    "ok": True,
                    "data": result_data,
                }

        except Exception as exc:
            log_fn(f"  获取rt异常: {exc}")
            return {"ok": False, "error": f"获取rt异常: {exc}"}
        finally:
            if acquired_profile_id:
                try:
                    from application.bitbrowser_profiles import release_acquired_profile
                    release_acquired_profile(acquired_profile_id, log_fn=log_fn)
                except Exception:
                    pass

    def _build_turnstile_solver_for_checkout(self):
        """构造给 Camoufox checkout 用的验证码求解回调。

        PayPal security challenge 只使用 YesCaptcha；如未配置可用 YesCaptcha，则返回
        None，让 checkout 流程退化为人工等待。
        """
        log_fn = getattr(self, "_log_fn", print)
        try:
            if not self._has_configured_captcha("yescaptcha_api"):
                log_fn("未启用验证码自动求解（YesCaptcha 未配置）")
                return None
            captcha_solver = self._make_captcha(provider_key="yescaptcha_api")
        except Exception as exc:
            log_fn(f"未启用验证码自动求解（YesCaptcha 初始化失败: {exc}）")
            return None
        log_fn("已启用验证码自动求解，provider: YesCaptcha")

        def _solver(page_url: str, site_key: str, challenge_type: str = "turnstile") -> str:
            if challenge_type == "recaptcha_v2":
                return captcha_solver.solve_recaptcha_v2(page_url, site_key)
            # A sanitized ``checkout-example.har`` flow shows that the
            # ``paypal.com/pay/`` risk page is hCaptcha (iframe src includes
            # ``hcaptcha_fph.html?siteKey=...``)，必须走 ``solve_hcaptcha`` 才能拿到
            # 可注入到 ``form[name=challenge]`` 里的 ``g-recaptcha-response`` token。
            if challenge_type == "hcaptcha":
                return captcha_solver.solve_hcaptcha(page_url, site_key)
            return captcha_solver.solve_turnstile(page_url, site_key)

        return _solver

    def _handle_generate_link(self, account: Account, params: dict) -> dict:
        """Handle generate_link capability for ChatGPT.

        **行为变更**（"打开支付链接"语义）：账号 ``extra`` 里已存了
        ``cashier_url`` 时优先把它**直接返回**——前端拿到 URL 就在新标签
        页打开。这样"打开支付链接"按钮就跟字面意思一致了：注册阶段已生成
        过的链接直接复用，不再每次都重新打 ChatGPT 后端 API 创建新会话。

        ``params`` 里若显式传 ``regenerate=true`` 则跳过这条路径，强制重新
        生成（用于链接过期 / 想要换 country/currency 等场景）。
        """
        self.raise_if_cancelled()
        proxy = self.config.proxy if self.config else None
        extra = account.extra or {}

        regenerate = _bool_param(params, "regenerate", False)
        if not regenerate:
            existing_url = str(
                extra.get("cashier_url")
                or (extra.get("account_overview") or {}).get("cashier_url")
                or ""
            ).strip()
            if existing_url:
                getattr(self, "_log_fn", print)(
                    f"复用账号已有 cashier_url（不重新生成）: {existing_url}"
                )
                return {
                    "ok": True,
                    "data": {
                        "url": existing_url,
                        "checkout_url": existing_url,
                        "cashier_url": existing_url,
                        "plan": params.get("plan", "plus"),
                        "auto_checkout": False,
                        "message": "支付链接已存在，直接打开",
                        "reused": True,
                    },
                }

        class _A: pass
        a = _A()
        a.email = account.email
        a.password = account.password
        a.access_token = extra.get("access_token") or account.token
        a.refresh_token = extra.get("refresh_token", "")
        a.id_token = extra.get("id_token", "")
        a.session_token = extra.get("session_token", "")
        a.cookies = extra.get("cookies", "")

        from platforms.chatgpt import payment as payment_module
        plan = params.get("plan", "plus")
        country = params.get("country", "ID")
        currency = params.get("currency") or None
        # 用 Stripe payment_pages/init 协议生成 cashier_url（accessToken →
        # pay.openai.com 长链，纯协议、不开浏览器拿 cashier 链）。仅 plus 生效。
        use_stripe_init = _bool_param(params, "use_stripe_init", False)
        # 短链：checkout_ui_mode=custom → chatgpt.com/checkout/openai_llc 短链。仅 plus。
        use_short_link = _bool_param(params, "use_short_link", False)
        # 账单地址来源（meiguodizhi.com 接口）："US" 走 ``/``，"JP" 走 ``/jp-address``。
        # 默认 US 保持向下兼容；其它值在 fetch_billing_address 里 fallback US。
        address_region = str(params.get("address_region") or "US").strip().upper() or "US"
        auto_checkout = _bool_param(params, "auto_checkout", True)
        payment_method = str(params.get("payment_method") or "paypal").strip().lower()
        headless = _bool_param(params, "headless", False)
        checkout_timeout = _int_param(params, "checkout_timeout", 180)
        checkout_hold_seconds = _optional_int_param(params, "checkout_hold_seconds")
        record_har = _bool_param(params, "record_har", False)
        record_har_path = _build_checkout_har_path(account.email) if record_har else None
        checkout_mode = str(params.get("checkout_mode") or "").strip().lower()
        if not checkout_mode:
            checkout_mode = "camoufox_headless" if headless else "camoufox_headed"
        # bitbrowser_* 模式下必须有 profile ID。表单输入优先于环境变量。
        bit_profile_id = str(params.get("bit_profile_id") or "").strip()
        if not bit_profile_id:
            bit_profile_id = os.environ.get("BIT_PROFILE_ID", "").strip()
        # 把 checkout_mode 翻成 BrowserBackendConfig；protocol 模式不需要 backend
        # （这里给 None，下游 _run_camoufox 不会被调用到）。
        backend_config: BrowserBackendConfig | None = None
        # acquired_profile_id 记录"是从池里 acquire 出来的"，跑完要 release。
        # 表单/环境变量传进来的不在池里，不需要 release。
        acquired_profile_id: str = ""
        if checkout_mode.startswith("bitbrowser_"):
            window_mode = checkout_mode[len("bitbrowser_"):]
            # 优先从 BitBrowser profile 池里 acquire 一个最少使用的 profile。
            # 池为空时回落到表单/环境变量提供的单一 ID（保持向后兼容）。
            from application.bitbrowser_profiles import (
                bitbrowser_profile_pool,
                BitBrowserProfilePoolEmpty,
            )
            try:
                resolved_profile_id = bitbrowser_profile_pool.acquire_or(
                    fallback=bit_profile_id
                )
                # 判断是不是真的从池里 acquire 的（影响 release）：池里有这个
                # ID 就视为"从池里出来的"，否则视为 fallback。
                pool_ids = {
                    item["profile_id"]
                    for item in bitbrowser_profile_pool.list_profiles()
                }
                if resolved_profile_id in pool_ids:
                    acquired_profile_id = resolved_profile_id
            except BitBrowserProfilePoolEmpty:
                # 池空 + 没 fallback → fail-fast，避免下到 BitBrowser API 才报错
                return {
                    "ok": False,
                    "error": (
                        "checkout_mode=bitbrowser_* 需要在「设置 → BitBrowser」"
                        "里添加 profile ID，或在表单里填写 BitBrowser Profile ID"
                        "（也可设置 BIT_PROFILE_ID 环境变量）"
                    ),
                }
            backend_config = BrowserBackendConfig.bitbrowser(
                profile_id=resolved_profile_id,
                window_mode=window_mode,
                api_url=os.environ.get("BIT_API_URL", "").strip() or None,
                api_token=os.environ.get("BIT_API_TOKEN", "").strip() or None,
            )
            getattr(self, "_log_fn", print)(
                f"BitBrowser profile 已选择: {resolved_profile_id} "
                f"(window_mode={window_mode}, "
                f"来源={'profile 池' if acquired_profile_id else '表单/环境变量'})"
            )
        elif checkout_mode in ("camoufox_headless", "camoufox_headed"):
            backend_config = BrowserBackendConfig.camoufox(
                headless=(checkout_mode == "camoufox_headless"),
            )
        # 解析 SMS 号码池：多行 +phone----relay_url。失败行会被静默忽略，
        # 这里只保留结构化后的非空列表，避免后续 stage / camoufox 反复字符串处理。
        sms_pool_raw = str(params.get("sms_pool") or "")
        try:
            sms_pool = payment_module.parse_sms_pool(sms_pool_raw)
        except Exception as exc:  # 防御性：解析失败也不应阻塞 checkout
            sms_pool = []
            getattr(self, "_log_fn", print)(f"SMS 号码池解析失败（忽略）: {exc}")
        if sms_pool_raw and not sms_pool:
            getattr(self, "_log_fn", print)(
                "警告：sms_pool 提供了内容但没解析出任何条目，请按 `+phone----relay_url` 格式排查"
            )
        elif sms_pool:
            getattr(self, "_log_fn", print)(f"SMS 号码池已加载 {len(sms_pool)} 条")
        checkout_proxy = None

        # Manually construct basic cookie in case old accounts don't have complete cookie string
        if not a.cookies and a.session_token:
            a.cookies = f"__Secure-next-auth.session-token={a.session_token}"

        getattr(self, "_log_fn", print)("生成 ChatGPT 测试支付链接不使用代理")
        if plan == "plus":
            if use_short_link:
                getattr(self, "_log_fn", print)(
                    "cashier_url 走短链模式（checkout_ui_mode=custom → chatgpt.com/checkout/openai_llc）"
                )
            elif use_stripe_init:
                getattr(self, "_log_fn", print)(
                    "cashier_url 走 Stripe init 协议长链（accessToken → pay.openai.com，纯协议）"
                )
            generate_kwargs = {}
            if use_stripe_init or use_short_link:
                generate_kwargs["use_stripe_init"] = use_stripe_init
                generate_kwargs["use_short_link"] = use_short_link
            url = payment_module.generate_plus_link(
                a, proxy=None, country=country, currency=currency, **generate_kwargs
            )
        else:
            url = payment_module.generate_team_link(a, proxy=None, country=country, currency=currency)
        self.raise_if_cancelled()

        cashier_url = url
        paypal_authorize_url = ""
        paypal_protocol_extract = None
        checkout_automation = None
        if url and auto_checkout:
            checkout_proxy = proxy
            if not checkout_proxy:
                proxy_region = str(params.get("proxy_region") or country or getattr(account, "region", "") or "").strip().upper()
                checkout_proxy = proxy_pool.get_next(region=proxy_region)
            if checkout_proxy:
                getattr(self, "_log_fn", print)(f"Camoufox checkout 使用代理: {_mask_proxy(checkout_proxy)}")
            else:
                getattr(self, "_log_fn", print)("Camoufox checkout 未配置代理")
            getattr(self, "_log_fn", print)("支付链接已生成，开始自动 PayPal checkout")
            getattr(self, "_log_fn", print)(f"checkout 模式: {checkout_mode}")
            # 是否启用 YesCaptcha 远端求解（前端弹窗里的开关）。
            # 关闭时 turnstile_solver 强制为 None，payment 模块的 captcha
            # 路径会退化为"代码鼠标点击 + 10s 等待跳转"，避免反复在
            # YesCaptcha 不识别的 sitekey 上烧配额。
            use_captcha_service = _bool_param(params, "use_captcha_service", True)
            if use_captcha_service:
                turnstile_solver = self._build_turnstile_solver_for_checkout()
            else:
                getattr(self, "_log_fn", print)(
                    "已禁用 YesCaptcha 求解（弹窗开关），captcha 出现时仅自动点击 + 等 10s"
                )
                turnstile_solver = None
            log_fn = getattr(self, "_log_fn", print)

            protocol_extract_failed = False
            if plan == "plus" and use_stripe_init and checkout_mode != "protocol":
                gateway_url = os.environ.get("PAYPAL_PROTOCOL_GATEWAY_URL", "").strip()
                if gateway_url:
                    paypal_protocol_extract = payment_module.extract_paypal_authorize_link_go(
                        access_token=a.access_token,
                        proxy=checkout_proxy,
                        gateway_url=gateway_url,
                        timeout=checkout_timeout,
                        log_fn=log_fn,
                    )
                else:
                    gateway_error = (
                        "未配置 PAYPAL_PROTOCOL_GATEWAY_URL，协议长链模式需要先启动 Go gateway；"
                        "当前不会回落 Python Stripe direct confirm"
                    )
                    log_fn(f"协议长链模式：{gateway_error}")
                    paypal_protocol_extract = {
                        "ok": False,
                        "status": "failed",
                        "paypal_authorize_url": "",
                        "error": gateway_error,
                        "protocol_backend": "go",
                    }
                if paypal_protocol_extract.get("ok"):
                    paypal_authorize_url = str(paypal_protocol_extract.get("paypal_authorize_url") or "")
                    if paypal_authorize_url:
                        url = paypal_authorize_url
                        log_fn("协议长链模式：已生成 PayPal 授权长链接，交给浏览器自动填写流程")
                    else:
                        protocol_extract_failed = True
                        checkout_automation = {
                            "ok": False,
                            "status": "failed",
                            "error": "协议提取成功但未返回 PayPal 授权长链接",
                            "protocol_extract": paypal_protocol_extract,
                        }
                else:
                    protocol_extract_failed = True
                    checkout_automation = paypal_protocol_extract
                    log_fn(
                        "协议长链模式提取 PayPal 授权长链接失败: "
                        + str(paypal_protocol_extract.get("error", "") or "unknown error")
                    )

            def _run_camoufox(headless_flag: bool):
                # 名字保留 _run_camoufox 兼容老日志/调用方，实际后端由
                # backend_config 决定（Camoufox / BitBrowser）。
                backend_label = (
                    f"BitBrowser({backend_config.window_mode})"
                    if backend_config and backend_config.is_bitbrowser
                    else f"Camoufox(headless={headless_flag})"
                )
                log_fn(
                    f"切换到独立线程执行 checkout backend={backend_label}"
                )
                return _run_sync_checkout_isolated(
                    payment_module.complete_paypal_checkout,
                    checkout_url=url,
                    cookies_str=a.cookies,
                    proxy=checkout_proxy,
                    email=account.email,
                    payment_method=payment_method,
                    headless=headless_flag,
                    timeout=checkout_timeout,
                    hold_seconds=checkout_hold_seconds,
                    log_fn=log_fn,
                    cancel_check=self.is_cancel_requested,
                    turnstile_solver=turnstile_solver,
                    record_har_path=record_har_path,
                    sms_pool=sms_pool,
                    backend_config=backend_config,
                    phone_swap_callback=params.get("phone_swap_callback"),
                    address_region=address_region,
                )

            def _run_protocol():
                log_fn("启动协议模式 checkout")
                return _run_sync_checkout_isolated(
                    payment_module.complete_paypal_checkout_protocol,
                    checkout_url=url,
                    cookies_str=a.cookies,
                    proxy=checkout_proxy,
                    email=account.email,
                    payment_method=payment_method,
                    timeout=checkout_timeout,
                    log_fn=log_fn,
                    cancel_check=self.is_cancel_requested,
                    turnstile_solver=turnstile_solver,
                    sms_pool=sms_pool,
                    address_region=address_region,
                )

            if checkout_mode == "protocol":
                # 协议模式失败时**直接报错**，不再自动回落 camoufox。
                # 理由：camoufox 兜底会掩盖协议链的真实失败原因，让调试变难；
                # 而且每次跑都要等 camoufox 启动 + 浏览器自动化，浪费时间。
                # 真要 fallback 的话，由前端在外层切换 checkout_mode 重新发起。
                checkout_automation = _run_protocol()
                if checkout_automation and not checkout_automation.get("ok"):
                    proto_err = str(checkout_automation.get("error", "") or "").strip()
                    log_fn(
                        "协议模式 checkout 失败（stage="
                        + str(checkout_automation.get("stage", "?"))
                        + "），不再回落 camoufox（便于排查）"
                        + (f"；原因: {proto_err}" if proto_err else "")
                    )
            else:
                try:
                    if not protocol_extract_failed:
                        checkout_automation = _run_camoufox(
                            headless_flag=(checkout_mode == "camoufox_headless")
                        )
                finally:
                    # BitBrowser 池里 acquire 出来的 profile，跑完后释放计数，
                    # 让下一次并发能挑到当前没在用的 profile。表单/环境变量
                    # 传的 ID 不在池里，acquired_profile_id 是空字符串，
                    # release 是 no-op。
                    if acquired_profile_id:
                        try:
                            from application.bitbrowser_profiles import (
                                bitbrowser_profile_pool,
                            )
                            bitbrowser_profile_pool.release(acquired_profile_id)
                            log_fn(
                                f"BitBrowser profile 池已释放: {acquired_profile_id}"
                            )
                        except Exception as exc:
                            log_fn(f"BitBrowser profile 池释放失败（忽略）: {exc}")
            self.raise_if_cancelled()
            if checkout_automation.get("ok"):
                getattr(self, "_log_fn", print)("PayPal checkout 自动流程已提交")
            else:
                checkout_error = str(checkout_automation.get("error", "") or "PayPal checkout automation failed")
                getattr(self, "_log_fn", print)(f"PayPal checkout 自动流程失败: {checkout_error}")

        checkout_ok = bool(checkout_automation and checkout_automation.get("ok"))
        action_ok = bool(url) if not auto_checkout else bool(url and checkout_ok)
        action_error = ""
        if url and auto_checkout and not checkout_ok:
            action_error = str(
                (checkout_automation or {}).get("error", "")
                or "PayPal checkout automation failed"
            )

        data = {
            "url": url,
            "checkout_url": url,
            "cashier_url": cashier_url,
            "paypal_authorize_url": paypal_authorize_url,
            "plan": plan,
            "country": country,
            "currency": currency or "",
            "payment_method": payment_method,
            "auto_checkout": auto_checkout,
            "headless": headless,
            "checkout_mode": checkout_mode,
            "proxy_used": checkout_proxy or "",
            "record_har_path": record_har_path or "",
            "message": (
                "Payment link generated, PayPal checkout automation submitted."
                if checkout_ok
                else (
                    "Payment link generated, but PayPal checkout automation failed."
                    if url and auto_checkout
                    else "Payment link generated."
                )
            ),
        }
        if paypal_protocol_extract is not None:
            data["paypal_protocol_extract"] = paypal_protocol_extract
        if checkout_automation is not None:
            data["checkout_automation"] = checkout_automation

        return {
            "ok": action_ok,
            "data": data,
            "error": action_error,
        }
