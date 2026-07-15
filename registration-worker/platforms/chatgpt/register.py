"""

注册流程引擎

从 main.py 中提取并重构的注册流程

"""



import re

import json

import time

import uuid

import base64

import random

import logging

import secrets

import string

from typing import Optional, Dict, Any, Tuple, Callable

from dataclasses import dataclass

from datetime import datetime, timezone



from curl_cffi import requests as cffi_requests



from .oauth import OAuthManager, OAuthStart, generate_oauth_url, submit_callback_url

from .http_client import OpenAIHTTPClient, HTTPClientError

# from ..services import EmailServiceFactory, BaseEmailService, EmailServiceType  # removed: external dep

# from ..database import crud  # removed: external dep

# from ..database.session import get_db  # removed: external dep

from .constants import (

    OPENAI_API_ENDPOINTS,

    OPENAI_PAGE_TYPES,

    generate_random_user_info,

    OTP_CODE_PATTERN,

    DEFAULT_PASSWORD_LENGTH,

    PASSWORD_CHARSET,

    AccountStatus,

    TaskStatus,

    SENTINEL_SDK_URL,

    OAUTH_REDIRECT_URI,

    OAUTH_CLIENT_ID,

)

# from ..config.settings import get_settings  # removed: external dep





logger = logging.getLogger(__name__)





@dataclass

class RegistrationResult:

    """注册结果"""

    success: bool

    email: str = ""

    password: str = ""  # 注册密码

    account_id: str = ""

    workspace_id: str = ""

    access_token: str = ""

    refresh_token: str = ""

    id_token: str = ""

    session_token: str = ""  # 会话令牌

    error_message: str = ""

    logs: list = None

    metadata: dict = None

    source: str = "register"  # 'register' 或 'login'，区分账号来源



    def to_dict(self) -> Dict[str, Any]:

        """转换为字典"""

        return {

            "success": self.success,

            "email": self.email,

            "password": self.password,

            "account_id": self.account_id,

            "workspace_id": self.workspace_id,

            "access_token": self.access_token[:20] + "..." if self.access_token else "",

            "refresh_token": self.refresh_token[:20] + "..." if self.refresh_token else "",

            "id_token": self.id_token[:20] + "..." if self.id_token else "",

            "session_token": self.session_token[:20] + "..." if self.session_token else "",

            "error_message": self.error_message,

            "logs": self.logs or [],

            "metadata": self.metadata or {},

            "source": self.source,

        }





@dataclass

class SignupFormResult:

    """提交注册表单的结果"""

    success: bool

    page_type: str = ""  # 响应中的 page.type 字段

    is_existing_account: bool = False  # 是否为已注册账号

    response_data: Dict[str, Any] = None  # 完整的响应数据

    error_message: str = ""





@dataclass

class SentinelPayload:

    """Sentinel 请求结果。"""

    p: str

    c: str

    flow: str

    t: str = ""





# ─── Sentinel helpers (ported from browser_register.py) ──────────



def _generate_datadog_trace_headers() -> dict:

    trace_hex = secrets.token_hex(8).rjust(16, "0")

    parent_hex = secrets.token_hex(8).rjust(16, "0")

    trace_id = str(int(trace_hex, 16))

    parent_id = str(int(parent_hex, 16))

    return {

        "traceparent": f"00-0000000000000000{trace_hex}-{parent_hex}-01",

        "tracestate": "dd=s:1;o:rum",

        "x-datadog-origin": "rum",

        "x-datadog-parent-id": parent_id,

        "x-datadog-sampling-priority": "1",

        "x-datadog-trace-id": trace_id,

    }





class _SentinelTokenGenerator:

    """Dynamic sentinel token generator – mirrors browser_register._SentinelTokenGenerator."""



    def __init__(self, device_id: str, user_agent: str):

        self.device_id = device_id or str(uuid.uuid4())

        self.user_agent = user_agent

        self.sid = str(uuid.uuid4())



    @staticmethod

    def _fnv1a32(text: str) -> str:

        h = 2166136261

        for ch in text:

            h ^= ord(ch)

            h = (h * 16777619) & 0xFFFFFFFF

        h ^= (h >> 16)

        h = (h * 2246822507) & 0xFFFFFFFF

        h ^= (h >> 13)

        h = (h * 3266489909) & 0xFFFFFFFF

        h ^= (h >> 16)

        return f"{h & 0xFFFFFFFF:08x}"



    @staticmethod

    def _b64(data) -> str:

        return base64.b64encode(json.dumps(data, separators=(",", ":")).encode("utf-8")).decode("ascii")



    def _config(self) -> list:

        perf_now = 1000 + random.random() * 49000

        return [

            "1920x1080",

            time.strftime("%a, %d %b %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime()),

            4294705152,

            random.random(),

            self.user_agent,

            SENTINEL_SDK_URL,

            None,

            None,

            "en-US",

            "en-US,en",

            random.random(),

            "webkitTemporaryStorage\u2212undefined",

            "location",

            "Object",

            perf_now,

            self.sid,

            "",

            random.choice([4, 8, 12, 16]),

            int(time.time() * 1000 - perf_now),

        ]



    def generate_requirements_token(self) -> str:

        cfg = self._config()

        cfg[3] = 1

        cfg[9] = round(5 + random.random() * 45)

        return "gAAAAAC" + self._b64(cfg)



    def generate_token(self, seed: str, difficulty: str) -> str:

        max_attempts = 500000

        cfg = self._config()

        start_ms = int(time.time() * 1000)

        diff = str(difficulty or "0")

        for nonce in range(max_attempts):

            cfg[3] = nonce

            cfg[9] = round(int(time.time() * 1000) - start_ms)

            encoded = self._b64(cfg)

            digest = self._fnv1a32((seed or "") + encoded)

            if digest[: len(diff)] <= diff:

                return "gAAAAAB" + encoded + "~S"

        return "gAAAAAB" + self._b64(None)





class RegistrationEngine:

    """

    注册引擎

    负责协调邮箱服务、OAuth 流程和 OpenAI API 调用

    """



    def __init__(

        self,

        email_service: Any,

        proxy_url: Optional[str] = None,

        callback_logger: Optional[Callable[[str], None]] = None,

        task_uuid: Optional[str] = None

    ):

        """

        初始化注册引擎



        Args:

            email_service: 邮箱服务实例

            proxy_url: 代理 URL

            callback_logger: 日志回调函数

            task_uuid: 任务 UUID（用于数据库记录）

        """

        self.email_service = email_service

        self.proxy_url = proxy_url

        self.callback_logger = callback_logger or (lambda msg: logger.info(msg))

        self.task_uuid = task_uuid



        # 创建 HTTP 客户端

        self.http_client = OpenAIHTTPClient(proxy_url=proxy_url)



        # 创建 OAuth 管理器

        from .constants import OAUTH_CLIENT_ID, OAUTH_AUTH_URL, OAUTH_TOKEN_URL, OAUTH_REDIRECT_URI, OAUTH_SCOPE

        self.oauth_manager = OAuthManager(

            client_id=OAUTH_CLIENT_ID,

            auth_url=OAUTH_AUTH_URL,

            token_url=OAUTH_TOKEN_URL,

            redirect_uri=OAUTH_REDIRECT_URI,

            scope=OAUTH_SCOPE,

            proxy_url=proxy_url  # 传递代理配置

        )



        # 状态变量

        self.email: Optional[str] = None

        self.password: Optional[str] = None  # 注册密码

        self.password_was_set: bool = False

        self.email_info: Optional[Dict[str, Any]] = None

        self.oauth_start: Optional[OAuthStart] = None

        self.session: Optional[cffi_requests.Session] = None

        self.session_token: Optional[str] = None  # 会话令牌

        self.logs: list = []

        self._otp_sent_at: Optional[float] = None  # OTP 发送时间戳

        self._is_existing_account: bool = False  # 是否为已注册账号（用于自动登录）

        self._device_id: Optional[str] = None

        self._sentinel_token: Optional[str] = None

        self._signup_sentinel: Optional[SentinelPayload] = None

        self._password_sentinel: Optional[SentinelPayload] = None

        self._create_account_continue_url: Optional[str] = None

        self._email_otp_continue_url: Optional[str] = None

        self._email_otp_page_loaded: bool = False

        self._otp_continue_url: Optional[str] = None

        self._otp_page_type: Optional[str] = None



    def _log(self, message: str, level: str = "info"):

        """记录日志"""

        timestamp = datetime.now(timezone.utc).astimezone().strftime("%H:%M:%S")

        log_message = f"[{timestamp}] {message}"



        # 添加到日志列表

        self.logs.append(log_message)



        # 调用回调函数

        if self.callback_logger:

            self.callback_logger(message)



        # 记录到数据库（如果有关联任务）

        if self.task_uuid:

            try:

                with get_db() as db:

                    crud.append_task_log(db, self.task_uuid, message)

            except Exception as e:

                logger.warning(f"记录任务日志失败: {e}")



        # 根据级别记录到日志系统

        if level == "error":

            logger.error(message)

        elif level == "warning":

            logger.warning(message)

        else:

            logger.info(message)



    def _generate_password(self, length: int = DEFAULT_PASSWORD_LENGTH) -> str:

        """生成随机密码"""

        # OpenAI 注册页对纯字母数字密码存在更高概率拒绝，补一个符号位更稳。

        specials = ",._!@#"

        if length < 10:

            length = 10

        core = ''.join(secrets.choice(PASSWORD_CHARSET) for _ in range(length - 2))

        return (

            secrets.choice("abcdefghijklmnopqrstuvwxyz")

            + secrets.choice("0123456789")

            + secrets.choice(specials)

            + core

        )[:length]



    def _load_create_account_password_page(self) -> bool:

        """预加载 create-account/password 页面，拿到页面阶段 cookie。"""

        try:

            response = self.session.get(

                "https://auth.openai.com/create-account/password",

                headers={

                    "referer": "https://chatgpt.com/",

                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                },

                timeout=20,

            )

            self._log(f"加载密码页状态: {response.status_code}")

            return response.status_code == 200

        except Exception as e:

            self._log(f"加载密码页失败: {e}", "warning")

            return False



    def _check_ip_location(self) -> Tuple[bool, Optional[str]]:

        """检查 IP 地理位置"""

        try:

            return self.http_client.check_ip_location()

        except Exception as e:

            self._log(f"检查 IP 地理位置失败: {e}", "error")

            return False, None



    def _create_email(self) -> bool:

        """创建邮箱"""

        try:

            self._log(f"正在创建 {self.email_service.service_type.value} 邮箱...")

            self.email_info = self.email_service.create_email()



            if not self.email_info or "email" not in self.email_info:

                self._log("创建邮箱失败: 返回信息不完整", "error")

                return False



            self.email = self.email_info["email"]

            self._log(f"成功创建邮箱: {self.email}")

            return True



        except Exception as e:

            self._log(f"创建邮箱失败: {e}", "error")

            return False



    def _start_oauth(self) -> bool:

        """通过 chatgpt.com NextAuth 发起 OAuth 流程"""

        try:

            from .constants import CHATGPT_APP

            self._log("通过 chatgpt.com NextAuth 发起 OAuth...")



            # 1. 访问 chatgpt.com 获取基础 cookie

            self.session.get(f"{CHATGPT_APP}/", timeout=15)

            oai_did = self.session.cookies.get("oai-did", "")

            self._log(f"chatgpt.com oai-did: {oai_did[:20]}...")



            # 2. 获取 CSRF token

            csrf_resp = self.session.get(f"{CHATGPT_APP}/api/auth/csrf", timeout=15)

            csrf_data = csrf_resp.json()

            csrf_token = csrf_data.get("csrfToken", "")

            if not csrf_token:

                # 从 cookie 中提取

                csrf_cookie = self.session.cookies.get("__Host-next-auth.csrf-token", "")

                csrf_token = csrf_cookie.split("%7C")[0] if "%7C" in csrf_cookie else csrf_cookie.split("|")[0]

            self._log(f"CSRF token: {csrf_token[:20]}...")



            # 3. 调用 signin/openai 获取 authorize URL

            signin_url = f"{CHATGPT_APP}/api/auth/signin/openai"

            if oai_did:

                signin_url += f"?prompt=login&ext-oai-did={oai_did}"



            signin_resp = self.session.post(

                signin_url,

                headers={

                    "content-type": "application/x-www-form-urlencoded",

                    "origin": CHATGPT_APP,

                    "referer": f"{CHATGPT_APP}/",

                },

                data=f"callbackUrl={CHATGPT_APP}%2F&csrfToken={csrf_token}&json=true",

                timeout=15,

            )

            self._log(f"signin/openai 状态: {signin_resp.status_code}")



            if signin_resp.status_code != 200:

                self._log(f"signin/openai 失败: {signin_resp.text[:200]}", "error")

                return False



            signin_data = signin_resp.json()

            auth_url = signin_data.get("url", "")

            if not auth_url:

                self._log("signin/openai 未返回 authorize URL", "error")

                return False



            self._log(f"OAuth URL: {auth_url[:80]}...")



            # 存储为 OAuthStart (不需要 code_verifier，由 chatgpt.com 后端处理)

            self.oauth_start = OAuthStart(

                auth_url=auth_url,

                state="",  # state 由 NextAuth 管理

                code_verifier="",  # 不需要

                redirect_uri="",  # 不需要

            )

            return True



        except Exception as e:

            self._log(f"NextAuth OAuth 流程失败: {e}", "error")

            return False



    def _init_session(self) -> bool:

        """初始化会话"""

        try:

            self.session = self.http_client.session

            return True

        except Exception as e:

            self._log(f"初始化会话失败: {e}", "error")

            return False



    def _get_device_id(self) -> Optional[str]:

        """获取 Device ID"""

        try:

            if not self.oauth_start:

                return None



            response = self.session.get(

                self.oauth_start.auth_url,

                timeout=15

            )

            did = self.session.cookies.get("oai-did")

            self._log(f"Device ID: {did}")

            return did



        except Exception as e:

            self._log(f"获取 Device ID 失败: {e}", "error")

            return None



    def _check_sentinel(self, did: str, *, flow: str = "authorize_continue") -> Optional[SentinelPayload]:

        """检查 Sentinel 拦截（动态生成 token + 处理 PoW）"""

        try:

            ua = self.http_client.default_headers.get("User-Agent", "")

            generator = _SentinelTokenGenerator(did, ua)

            sent_p = generator.generate_requirements_token()

            sen_req_body = json.dumps({"p": sent_p, "id": did, "flow": flow}, separators=(",", ":"))



            from .constants import SENTINEL_FRAME_URL

            response = self.http_client.post(

                OPENAI_API_ENDPOINTS["sentinel"],

                headers={

                    "origin": "https://sentinel.openai.com",

                    "referer": SENTINEL_FRAME_URL,

                    "content-type": "text/plain;charset=UTF-8",

                },

                data=sen_req_body,

            )



            if response.status_code == 200:

                data = response.json()

                sen_token = str(data.get("token") or "")

                turnstile = data.get("turnstile") or {}



                # Handle proofofwork challenge if required

                initial_p = sent_p  # keep for dx decryption

                pow_meta = data.get("proofofwork") or {}

                if pow_meta.get("required") and pow_meta.get("seed"):

                    sent_p = generator.generate_token(

                        str(pow_meta.get("seed") or ""),

                        str(pow_meta.get("difficulty") or "0"),

                    )

                    self._log(f"Sentinel PoW solved: flow={flow}")



                # Solve turnstile dx with VM

                t_value = ""

                dx_b64 = str(turnstile.get("dx") or "")

                if dx_b64:

                    try:

                        from .sentinel_vm import solve_turnstile_dx

                        from .constants import SENTINEL_SDK_URL

                        t_value = solve_turnstile_dx(dx_b64, initial_p, user_agent=ua, sdk_url=SENTINEL_SDK_URL)

                        self._log(f"Sentinel VM solved: t_len={len(t_value)} flow={flow}")

                    except Exception as vm_err:

                        self._log(f"Sentinel VM failed: {vm_err}", "warning")



                payload = SentinelPayload(

                    p=sent_p,

                    c=sen_token,

                    flow=flow,

                    t=t_value,

                )

                self._log(f"Sentinel token 获取成功: flow={flow}")

                return payload

            else:

                self._log(f"Sentinel 检查失败: flow={flow} status={response.status_code}", "warning")

                return None



        except Exception as e:

            self._log(f"Sentinel 检查异常: flow={flow} {e}", "warning")

            return None



    def _submit_signup_form(self, did: str, sen_payload: Optional[SentinelPayload]) -> SignupFormResult:

        """

        提交注册表单（通过 authorize/continue 建立 session）



        Returns:

            SignupFormResult: 提交结果，包含账号状态判断

        """

        try:

            self._device_id = did

            self._signup_sentinel = sen_payload

            self._sentinel_token = sen_payload.c if sen_payload else None

            signup_body = json.dumps({"username": {"value": self.email, "kind": "email"}, "screen_hint": "signup"})



            headers = {

                "referer": "https://auth.openai.com/create-account",

                "accept": "application/json",

                "content-type": "application/json",

                "sec-fetch-site": "same-origin",

                **_generate_datadog_trace_headers(),

            }



            if did:

                headers["oai-device-id"] = did



            if sen_payload:

                sentinel = json.dumps({

                    "p": sen_payload.p,

                    "t": sen_payload.t,

                    "c": sen_payload.c,

                    "id": did,

                    "flow": sen_payload.flow,

                }, separators=(",", ":"))

                headers["openai-sentinel-token"] = sentinel



            response = self.session.post(

                OPENAI_API_ENDPOINTS["signup"],

                headers=headers,

                data=signup_body,
                timeout=15,

            )



            self._log(f"提交注册表单状态: {response.status_code}")



            if response.status_code != 200:

                return SignupFormResult(

                    success=False,

                    error_message=f"HTTP {response.status_code}: {response.text[:200]}"

                )



            try:

                response_data = response.json()

            except Exception as parse_error:

                self._log(f"signup 响应非 JSON: {parse_error}, body={response.text[:200]}", "warning")

                return SignupFormResult(

                    success=False,

                    error_message=f"signup 返回非 JSON: {response.text[:200]}",

                    response_data={},

                )



            if isinstance(response_data, dict):

                err = response_data.get("error") or response_data.get("detail") or ""

                if err:

                    err_msg = err if isinstance(err, str) else json.dumps(err)

                    self._log(f"signup 返回错误: {err_msg}", "warning")



            page_type = response_data.get("page", {}).get("type", "")

            continue_url = str(response_data.get("continue_url") or "")

            self._log(f"响应页面类型: {page_type}")



            is_existing = False

            if page_type == OPENAI_PAGE_TYPES["EMAIL_OTP_VERIFICATION"]:

                self._email_otp_continue_url = continue_url or "https://auth.openai.com/email-verification"

                self._log("已进入邮箱 OTP 验证流程，将显式发送验证码")



            return SignupFormResult(

                success=True,

                page_type=page_type,

                is_existing_account=is_existing,

                response_data=response_data

            )



        except Exception as e:

            self._log(f"提交注册表单失败: {e}", "error")

            return SignupFormResult(success=False, error_message=str(e))



    def _register_password(self) -> Tuple[bool, Optional[str]]:

        """注册密码"""

        try:

            ua = self.http_client.default_headers.get("User-Agent", "")

            chrome_match = re.search(r"Chrome/(\d+)", ua)

            chrome_major = str(chrome_match.group(1) if chrome_match else "136")

            sec_ch_ua = f'"Chromium";v="{chrome_major}", "Google Chrome";v="{chrome_major}", "Not.A/Brand";v="99"'



            candidates = []

            while len(candidates) < 3:

                pwd = self._generate_password()

                if pwd not in candidates:

                    candidates.append(pwd)



            for index, password in enumerate(candidates, start=1):

                self.password = password



                # Reload page + refresh sentinel for each attempt (tokens are single-use)

                self._load_create_account_password_page()

                if self._device_id:

                    self._password_sentinel = self._check_sentinel(self._device_id, flow="username_password_create")

                    if self._password_sentinel:

                        self._log(

                            f"密码阶段 Sentinel 已刷新: flow={self._password_sentinel.flow} "

                            f"turnstile={'yes' if self._password_sentinel.t else 'no'}"

                        )



                self._log(f"已为必填密码页生成候选密码[{index}/{len(candidates)}]")



                register_body = json.dumps({

                    "password": password,

                    "username": self.email

                })



                register_headers = {

                    "origin": "https://auth.openai.com",

                    "referer": "https://auth.openai.com/create-account/password",

                    "accept": "application/json",

                    "content-type": "application/json",

                    "accept-language": "en-US,en;q=0.9",

                    "sec-ch-ua": sec_ch_ua,

                    "sec-ch-ua-mobile": "?0",

                    "sec-ch-ua-platform": '"Windows"',

                    "sec-fetch-dest": "empty",

                    "sec-fetch-mode": "cors",

                    "sec-fetch-site": "same-origin",

                    **_generate_datadog_trace_headers(),

                }

                if self._device_id:

                    register_headers["oai-device-id"] = self._device_id

                if self._password_sentinel and self._device_id:

                    register_headers["openai-sentinel-token"] = json.dumps({

                        "p": self._password_sentinel.p,

                        "t": self._password_sentinel.t,

                        "c": self._password_sentinel.c,

                        "id": self._device_id,

                        "flow": self._password_sentinel.flow,

                    }, separators=(",", ":"))



                response = self.session.post(

                    OPENAI_API_ENDPOINTS["register"],

                    headers=register_headers,

                    data=register_body,

                    timeout=15,

                )



                self._log(f"提交密码状态[{index}/{len(candidates)}]: {response.status_code}")



                if response.status_code == 200:

                    # 解析响应，检测已注册账号

                    try:

                        resp_data = response.json()

                        page_type = resp_data.get("page", {}).get("type", "")

                        continue_url = str(resp_data.get("continue_url") or "")

                        self._log(f"注册响应页面类型: {page_type}")

                        if page_type == OPENAI_PAGE_TYPES.get("EMAIL_OTP_VERIFICATION", "email_otp_verification"):

                            self._log("密码提交后进入邮箱 OTP 验证流程")

                            if continue_url:

                                self._email_otp_continue_url = continue_url

                                self._log(f"密码响应 continue_url: {continue_url[:100]}")

                    except Exception:

                        pass

                    self.password_was_set = True

                    return True, password



                error_text = response.text[:500]

                self._log(f"密码注册失败[{index}/{len(candidates)}]: {error_text}", "warning")



                try:

                    error_json = response.json()

                    error_msg = error_json.get("error", {}).get("message", "")

                    error_code = error_json.get("error", {}).get("code", "")



                    if "already" in error_msg.lower() or "exists" in error_msg.lower() or error_code == "user_exists":

                        self._log(f"邮箱 {self.email} 可能已在 OpenAI 注册过", "error")

                        self._mark_email_as_registered()

                        return False, None

                except Exception:

                    pass



            return False, None



        except Exception as e:

            self._log(f"密码注册失败: {e}", "error")

            return False, None



    def _mark_email_as_registered(self):

        """标记邮箱为已注册状态（用于防止重复尝试）"""

        try:

            with get_db() as db:

                # 检查是否已存在该邮箱的记录

                existing = crud.get_account_by_email(db, self.email)

                if not existing:

                    # 创建一个失败记录，标记该邮箱已注册过

                    crud.create_account(

                        db,

                        email=self.email,

                        password="",  # 空密码表示未成功注册

                        email_service=self.email_service.service_type.value,

                        email_service_id=self.email_info.get("service_id") if self.email_info else None,

                        status="failed",

                        extra_data={"register_failed_reason": "email_already_registered_on_openai"}

                    )

                    self._log(f"已在数据库中标记邮箱 {self.email} 为已注册状态")

        except Exception as e:

            logger.warning(f"标记邮箱状态失败: {e}")



    def _send_verification_code(self) -> bool:

        """发送验证码"""

        try:

            email_verification_url = self._email_otp_continue_url or "https://auth.openai.com/email-verification"

            self._log(f"邮箱验证页 URL: {email_verification_url[:120]}")

            csrf_token = ""

            if not self._email_otp_page_loaded:

                page_resp = self.session.get(

                    email_verification_url,

                    headers={

                        "referer": "https://auth.openai.com/create-account",

                        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                    },

                    timeout=15,

                )

                self._email_otp_page_loaded = True

                page_status = getattr(page_resp, 'status_code', 0)

                self._log(f"邮箱验证码页加载状态: {page_status}, body_len={len(getattr(page_resp, 'text', '') or '')}")

                if page_status not in (200, 304):

                    self._log(f"邮箱验证码页加载异常，状态码: {page_status}", "warning")

                    return False



                # 从页面提取 CSRF token（Next.js 的 __NEXT_DATA__ 或 meta 标签）

                page_text = getattr(page_resp, 'text', '') or ''

                csrf_match = re.search(r'"csrfToken"\s*:\s*"([^"]+)"', page_text)

                if csrf_match:

                    csrf_token = csrf_match.group(1)

                    self._log(f"从页面提取到 CSRF token: {csrf_token[:20]}...")



                # 给页面资源加载留一点时间（模拟浏览器行为，避免连续请求被风控）

                time.sleep(1.5)



            # 记录发送时间戳

            self._otp_sent_at = time.time()



            send_headers = {

                "referer": email_verification_url,

                "accept": "application/json, text/plain, */*",

                "sec-fetch-site": "same-origin",

                "sec-fetch-mode": "cors",

                "sec-fetch-dest": "empty",

                **_generate_datadog_trace_headers(),

            }

            if self._device_id:

                send_headers["oai-device-id"] = self._device_id

            if csrf_token:

                send_headers["x-csrf-token"] = csrf_token



            last_error = ""

            for attempt in range(2):

                try:

                    response = self.session.get(

                        OPENAI_API_ENDPOINTS["send_otp"],

                        headers=send_headers,

                        timeout=15,

                    )

                except Exception as req_err:

                    last_error = str(req_err)

                    self._log(f"验证码发送请求异常 (attempt {attempt+1}): {req_err}", "warning")

                    if attempt == 0:

                        time.sleep(2)

                    continue



                status = response.status_code

                resp_text = response.text[:300]

                self._log(f"验证码发送状态: {status} (attempt {attempt+1})")

                self._log(f"验证码发送响应: {resp_text}")



                if status == 200:

                    try:

                        body = response.json()

                        if isinstance(body, dict):

                            detail = body.get("detail") or body.get("error") or body.get("message") or ""

                            if detail:

                                self._log(f"验证码发送API返回消息: {detail}")

                    except Exception:

                        pass

                    return True



                if status == 429 or (400 <= status < 500):

                    last_error = f"HTTP {status}: {resp_text}"

                    self._log(f"验证码发送失败 ({last_error})，{'等待重试' if attempt == 0 else '放弃'}",

                              "warning" if attempt == 0 else "error")

                    if attempt == 0:

                        time.sleep(3)

                    continue



                # 如果 GET 返回 405/404，尝试 POST

                if status in (405, 404) and attempt == 0:

                    self._log("GET 失败，尝试 POST 方式发送验证码...")

                    try:

                        response = self.session.post(

                            OPENAI_API_ENDPOINTS["send_otp"],

                            headers={**send_headers, "content-type": "application/json"},

                            json={},

                            timeout=15,

                        )

                        self._log(f"POST 验证码发送状态: {response.status_code}")

                        self._log(f"POST 验证码发送响应: {response.text[:200]}")

                        if response.status_code == 200:

                            return True

                    except Exception as post_err:

                        self._log(f"POST 验证码发送异常: {post_err}", "warning")



                last_error = f"HTTP {status}: {resp_text}"

                if attempt == 0:

                    time.sleep(2)



            if last_error:

                self._log(f"验证码发送最终失败: {last_error}", "error")



            return False



        except Exception as e:

            self._log(f"发送验证码失败: {e}", "error")

            return False



    def _get_verification_code(self) -> Optional[str]:

        """获取验证码"""

        try:

            email_id = self.email_info.get("service_id") if self.email_info else None

            import os as _os_otp_timeout

            try:

                otp_timeout = int((_os_otp_timeout.environ.get("CHATGPT_OTP_TIMEOUT_SECONDS", "") or "300").strip())

            except Exception:

                otp_timeout = 300

            if otp_timeout < 30:

                otp_timeout = 30



            elapsed_since_send = "?"

            if self._otp_sent_at:

                elapsed_since_send = f"{time.time() - self._otp_sent_at:.0f}s"



            self._log(f"正在等待邮箱 {self.email} 的验证码 (超时: {otp_timeout}s, OTP已发送: {elapsed_since_send}前)...")



            code = self.email_service.get_verification_code(

                email=self.email,

                email_id=email_id,

                timeout=otp_timeout,

                pattern=OTP_CODE_PATTERN,

                otp_sent_at=self._otp_sent_at,

            )



            if code:

                self._log(f"成功获取验证码: {code}")

                return code

            else:

                self._log("等待验证码超时", "error")

                return None



        except TimeoutError as e:

            self._log(f"等待验证码超时: {e}", "error")

            return None

        except Exception as e:

            self._log(f"获取验证码失败: {e}", "error")

            return None



    def _validate_verification_code(self, code: str) -> bool:

        """验证验证码"""

        try:

            code_body = f'{{"code":"{code}"}}'



            response = self.session.post(

                OPENAI_API_ENDPOINTS["validate_otp"],

                headers={

                    "referer": "https://auth.openai.com/email-verification",

                    "accept": "application/json",

                    "content-type": "application/json",

                },

                data=code_body,

            )



            self._log(f"验证码校验状态: {response.status_code}")

            if response.status_code != 200:

                self._log(f"验证码校验响应: {response.text[:300]}", "warning")

                return False



            # 解析响应，存储 continue_url 和 page_type

            try:

                resp_data = response.json()

                self._otp_continue_url = resp_data.get("continue_url", "")

                self._otp_page_type = resp_data.get("page", {}).get("type", "")

                self._log(f"验证码校验 -> page_type={self._otp_page_type}")

            except Exception:

                self._otp_continue_url = ""

                self._otp_page_type = ""

            return True



        except Exception as e:

            self._log(f"验证验证码失败: {e}", "error")

            return False



    def _create_user_account(self) -> bool:

        """创建用户账户"""

        try:

            user_info = generate_random_user_info()

            self._log(f"生成用户信息: {user_info['name']}, 生日: {user_info['birthdate']}")

            create_account_body = json.dumps(user_info)



            # 调 client_auth_session_dump 推进服务器 auth 状态机

            try:

                dump_resp = self.session.get(

                    "https://auth.openai.com/api/accounts/client_auth_session_dump",

                    headers={

                        "referer": "https://auth.openai.com/email-verification",

                        "accept": "application/json",

                    },

                    timeout=20,

                )

                self._log(f"client_auth_session_dump 状态: {dump_resp.status_code}")

            except Exception as e:

                self._log(f"client_auth_session_dump 异常: {e}", "warning")



            create_headers = {

                "referer": "https://auth.openai.com/about-you",

                "accept": "application/json",

                "content-type": "application/json",

                "origin": "https://auth.openai.com",

                "sec-fetch-site": "same-origin",

                **_generate_datadog_trace_headers(),

            }

            if self._device_id:

                create_headers["oai-device-id"] = self._device_id



            # create_account 也需要 sentinel token (flow=oauth_create_account)

            if self._device_id:

                ca_sentinel = self._check_sentinel(self._device_id, flow="oauth_create_account")

                if ca_sentinel:

                    create_headers["openai-sentinel-token"] = json.dumps({

                        "p": ca_sentinel.p,

                        "t": ca_sentinel.t,

                        "c": ca_sentinel.c,

                        "id": self._device_id,

                        "flow": ca_sentinel.flow,

                    }, separators=(",", ":"))

                    self._log(f"create_account Sentinel 已获取: flow={ca_sentinel.flow}")



            response = self.session.post(

                OPENAI_API_ENDPOINTS["create_account"],

                headers=create_headers,

                data=create_account_body,

            )



            self._log(f"账户创建状态: {response.status_code}")



            if response.status_code != 200:

                self._log(f"账户创建失败: {response.text[:200]}", "warning")

                return False



            # 提取 continue_url（ChatGPT Web 流程直接返回 OAuth callback URL）

            try:

                resp_data = response.json()

                self._create_account_continue_url = resp_data.get("continue_url", "")

                if self._create_account_continue_url:

                    self._log(f"create_account continue_url: {self._create_account_continue_url[:100]}...")

            except Exception:

                pass



            return True



        except Exception as e:

            self._log(f"创建账户失败: {e}", "error")

            return False



    def _acquire_codex_callback(self) -> Optional[str]:

        """

        注册完成后，通过 Codex CLI OAuth 完整登录流程获取 callback URL。

        使用新 session，走 authorize → authorize/continue → OTP → callback 流程。

        """

        try:

            from .constants import (

                CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CODEX_SCOPE,

                OPENAI_AUTH, OPENAI_API_ENDPOINTS,

            )

            import urllib.parse



            self._log("开始 Codex CLI 登录流程...")



            # 1. 创建新 HTTP client + session

            login_client = OpenAIHTTPClient(proxy_url=self.proxy_url)

            login_session = login_client.session



            # 2. 生成 Codex CLI OAuth URL (Hydra)

            codex_oauth = generate_oauth_url(

                redirect_uri=CODEX_REDIRECT_URI,

                scope=CODEX_SCOPE,

                client_id=CODEX_CLIENT_ID,

            )

            self._codex_oauth = codex_oauth



            # 3. 访问 authorize URL 获取 device_id + session cookies

            response = login_session.get(codex_oauth.auth_url, timeout=15)

            did = login_session.cookies.get("oai-did")

            self._log(f"Codex login device_id: {did}")

            if not did:

                self._log("Codex login 获取 device_id 失败", "error")

                return None



            # 4. 获取 Sentinel token

            sen_payload = None

            try:

                ua = login_client.default_headers.get("User-Agent", "")

                generator = _SentinelTokenGenerator(did, ua)

                sent_p = generator.generate_requirements_token()

                sen_req_body = json.dumps({"p": sent_p, "id": did, "flow": "authorize_continue"}, separators=(",", ":"))



                from .constants import SENTINEL_FRAME_URL

                sen_resp = login_client.post(

                    OPENAI_API_ENDPOINTS["sentinel"],

                    headers={

                        "origin": "https://sentinel.openai.com",

                        "referer": SENTINEL_FRAME_URL,

                        "content-type": "text/plain;charset=UTF-8",

                    },

                    data=sen_req_body,

                )

                if sen_resp.status_code == 200:

                    data = sen_resp.json()

                    turnstile = data.get("turnstile") or {}

                    pow_meta = data.get("proofofwork") or {}

                    if pow_meta.get("required") and pow_meta.get("seed"):

                        sent_p = generator.generate_token(

                            str(pow_meta.get("seed") or ""),

                            str(pow_meta.get("difficulty") or "0"),

                        )

                    t_raw = turnstile.get("dx", "")

                    t_val = ""

                    if t_raw:

                        try:

                            t_val = generator.decrypt_turnstile(t_raw, sent_p)

                        except Exception:

                            pass

                    sen_payload = SentinelPayload(p=sent_p, t=t_val, c=str(data.get("token") or ""), flow="authorize_continue")

                    self._log("Codex login Sentinel 已获取")

            except Exception as e:

                self._log(f"Codex login Sentinel 失败: {e}", "warning")



            # 5. authorize/continue 提交邮箱（登录已有账号）

            signup_body = f'{{"username":{{"value":"{self.email}","kind":"email"}},"screen_hint":"login"}}'

            headers = {

                "referer": "https://auth.openai.com/log-in",

                "accept": "application/json",

                "content-type": "application/json",

            }

            if sen_payload:

                headers["openai-sentinel-token"] = json.dumps({

                    "p": sen_payload.p, "t": sen_payload.t, "c": sen_payload.c,

                    "id": did, "flow": sen_payload.flow,

                }, separators=(",", ":"))



            resp = login_session.post(OPENAI_API_ENDPOINTS["signup"], headers=headers, data=signup_body)

            self._log(f"Codex login authorize/continue: {resp.status_code}")

            if resp.status_code != 200:

                self._log(f"Codex login authorize/continue 失败: {resp.text[:200]}", "error")

                return None



            resp_data = resp.json()

            page_type = resp_data.get("page", {}).get("type", "")

            self._log(f"Codex login page_type: {page_type}")



            # 6. 如果需要 OTP，等待第二次验证码

            if page_type == "email_otp_verification":

                login_session.get(OPENAI_API_ENDPOINTS["send_otp"], headers={

                    "referer": f"{OPENAI_AUTH}/email-verification",

                }, timeout=15)

                self._log("Codex login OTP 已显式发送")

                self._log("等待第二次验证码...")

                self._otp_sent_at = time.time()

                code = self._get_verification_code()

                if not code:

                    self._log("Codex login 获取验证码失败", "error")

                    return None



                # 验证 OTP

                code_body = f'{{"code":"{code}"}}'

                otp_resp = login_session.post(

                    OPENAI_API_ENDPOINTS["validate_otp"],

                    headers={

                        "referer": "https://auth.openai.com/email-verification",

                        "accept": "application/json",

                        "content-type": "application/json",

                    },

                    data=code_body,

                )

                self._log(f"Codex login OTP 校验: {otp_resp.status_code}")

                if otp_resp.status_code != 200:

                    self._log(f"Codex login OTP 失败: {otp_resp.text[:200]}", "error")

                    return None



                otp_data = otp_resp.json()

                otp_page = otp_data.get("page", {}).get("type", "")

                self._log(f"Codex login OTP -> page_type={otp_page}")



                if otp_page == "add_phone":

                    self._log("Codex CLI 登录仍需 add_phone，无法跳过", "error")

                    return None



            # 7. 需要密码登录

            elif page_type in ("login_password", "create_account_password"):

                self._log(f"Codex login 提交密码...")

                if not self.password:

                    self._log("无密码可用", "error")

                    return None



                # 加载密码页获取 sentinel

                login_session.get(f"{OPENAI_AUTH}/log-in/password", timeout=15)

                pwd_sentinel = None

                try:

                    ua2 = login_client.default_headers.get("User-Agent", "")

                    gen2 = _SentinelTokenGenerator(did, ua2)

                    sp2 = gen2.generate_requirements_token()

                    sr2 = json.dumps({"p": sp2, "id": did, "flow": "login_password"}, separators=(",", ":"))

                    from .constants import SENTINEL_FRAME_URL as SF2

                    sr2_resp = login_client.post(

                        OPENAI_API_ENDPOINTS["sentinel"],

                        headers={"origin": "https://sentinel.openai.com", "referer": SF2, "content-type": "text/plain;charset=UTF-8"},

                        data=sr2,

                    )

                    if sr2_resp.status_code == 200:

                        d2 = sr2_resp.json()

                        pm2 = d2.get("proofofwork") or {}

                        if pm2.get("required") and pm2.get("seed"):

                            sp2 = gen2.generate_token(str(pm2.get("seed") or ""), str(pm2.get("difficulty") or "0"))

                        tr2 = (d2.get("turnstile") or {}).get("dx", "")

                        tv2 = ""

                        if tr2:

                            try: tv2 = gen2.decrypt_turnstile(tr2, sp2)

                            except: pass

                        pwd_sentinel = SentinelPayload(p=sp2, t=tv2, c=str(d2.get("token") or ""), flow="login_password")

                        self._log("Codex login 密码 Sentinel 已获取")

                except Exception as e:

                    self._log(f"Codex login 密码 Sentinel 失败: {e}", "warning")



                pwd_headers = {

                    "origin": OPENAI_AUTH,

                    "referer": f"{OPENAI_AUTH}/log-in/password",

                    "accept": "application/json",

                    "content-type": "application/json",

                }

                if did:

                    pwd_headers["oai-device-id"] = did

                if pwd_sentinel:

                    pwd_headers["openai-sentinel-token"] = json.dumps({

                        "p": pwd_sentinel.p, "t": pwd_sentinel.t, "c": pwd_sentinel.c,

                        "id": did, "flow": pwd_sentinel.flow,

                    }, separators=(",", ":"))



                pwd_body = json.dumps({"password": self.password, "username": self.email})

                pwd_resp = login_session.post(OPENAI_API_ENDPOINTS["register"], headers=pwd_headers, data=pwd_body)

                self._log(f"Codex login 密码提交: {pwd_resp.status_code}")

                if pwd_resp.status_code != 200:

                    self._log(f"Codex login 密码失败: {pwd_resp.text[:200]}", "error")

                    return None



                pwd_data = pwd_resp.json()

                pwd_page = pwd_data.get("page", {}).get("type", "")

                self._log(f"Codex login 密码 -> page_type={pwd_page}")



                # 密码后可能需要 OTP

                if pwd_page == "email_otp_verification" or pwd_page == "email_otp_send":

                    login_session.get(OPENAI_API_ENDPOINTS["send_otp"], headers={

                        "referer": f"{OPENAI_AUTH}/email-verification",

                    }, timeout=15)

                    self._log("Codex login OTP 已显式发送")

                    self._log("Codex login: 等待验证码...")

                    self._otp_sent_at = time.time()

                    code = self._get_verification_code()

                    if not code:

                        self._log("Codex login 获取验证码失败", "error")

                        return None

                    code_body = f'{{"code":"{code}"}}'

                    otp_resp = login_session.post(

                        OPENAI_API_ENDPOINTS["validate_otp"],

                        headers={"referer": f"{OPENAI_AUTH}/email-verification", "accept": "application/json", "content-type": "application/json"},

                        data=code_body,

                    )

                    self._log(f"Codex login OTP: {otp_resp.status_code}")

                    if otp_resp.status_code != 200:

                        self._log(f"Codex login OTP 失败: {otp_resp.text[:200]}", "error")

                        return None

                    otp_data = otp_resp.json()

                    otp_page = otp_data.get("page", {}).get("type", "")

                    self._log(f"Codex login OTP -> page_type={otp_page}")

                    if otp_page == "add_phone":

                        self._log("Codex CLI 登录仍需 add_phone", "error")

                        return None



            # 8. 重新访问 authorize URL 获取回调

            self._log("Codex login: 重新访问 OAuth URL 获取回调...")

            response = login_session.get(codex_oauth.auth_url, allow_redirects=False, timeout=15)

            max_redirects = 10

            current_url = codex_oauth.auth_url

            for i in range(max_redirects):

                if response.status_code not in (301, 302, 303, 307, 308):

                    break

                location = response.headers.get("Location", "")

                if not location:

                    break

                next_url = urllib.parse.urljoin(current_url, location)

                self._log(f"Codex login 重定向 {i+1}: {next_url[:80]}...")

                if "code=" in next_url and "state=" in next_url:

                    self._log("找到 Codex CLI 回调 URL")

                    return next_url

                current_url = next_url

                response = login_session.get(current_url, allow_redirects=False, timeout=15)



            self._log(f"Codex login 最终: status={response.status_code}, url={current_url[:100]}", "warning")

            return None



        except Exception as e:

            self._log(f"Codex CLI 登录流程失败: {e}", "error")

            return None



    def _get_workspace_id(self) -> Optional[str]:

        """获取 Workspace ID"""

        try:

            auth_cookie = self.session.cookies.get("oai-client-auth-session")

            if not auth_cookie:

                self._log("未能获取到授权 Cookie", "error")

                return None



            # 解码 JWT

            import base64

            import json as json_module



            try:

                segments = auth_cookie.split(".")

                if len(segments) < 1:

                    self._log("授权 Cookie 格式错误", "error")

                    return None



                # 解码第一个 segment

                payload = segments[0]

                pad = "=" * ((4 - (len(payload) % 4)) % 4)

                decoded = base64.urlsafe_b64decode((payload + pad).encode("ascii"))

                auth_json = json_module.loads(decoded.decode("utf-8"))



                workspaces = auth_json.get("workspaces") or []

                if not workspaces:

                    self._log("授权 Cookie 里没有 workspace 信息", "error")

                    return None



                workspace_id = str((workspaces[0] or {}).get("id") or "").strip()

                if not workspace_id:

                    self._log("无法解析 workspace_id", "error")

                    return None



                self._log(f"Workspace ID: {workspace_id}")

                return workspace_id



            except Exception as e:

                self._log(f"解析授权 Cookie 失败: {e}", "error")

                return None



        except Exception as e:

            self._log(f"获取 Workspace ID 失败: {e}", "error")

            return None



    def _select_workspace(self, workspace_id: str) -> Optional[str]:

        """选择 Workspace"""

        try:

            select_body = f'{{"workspace_id":"{workspace_id}"}}'



            response = self.session.post(

                OPENAI_API_ENDPOINTS["select_workspace"],

                headers={

                    "referer": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",

                    "content-type": "application/json",

                },

                data=select_body,

            )



            if response.status_code != 200:

                self._log(f"选择 workspace 失败: {response.status_code}", "error")

                self._log(f"响应: {response.text[:200]}", "warning")

                return None



            continue_url = str((response.json() or {}).get("continue_url") or "").strip()

            if not continue_url:

                self._log("workspace/select 响应里缺少 continue_url", "error")

                return None



            self._log(f"Continue URL: {continue_url[:100]}...")

            return continue_url



        except Exception as e:

            self._log(f"选择 Workspace 失败: {e}", "error")

            return None



    def _follow_redirects(self, start_url: str) -> Optional[str]:

        """跟随重定向链，寻找回调 URL"""

        try:

            current_url = start_url

            max_redirects = 6



            for i in range(max_redirects):

                self._log(f"重定向 {i+1}/{max_redirects}: {current_url[:100]}...")



                response = self.session.get(

                    current_url,

                    allow_redirects=False,

                    timeout=15

                )



                location = response.headers.get("Location") or ""



                # 如果不是重定向状态码，停止

                if response.status_code not in [301, 302, 303, 307, 308]:

                    self._log(f"非重定向状态码: {response.status_code}")

                    break



                if not location:

                    self._log("重定向响应缺少 Location 头")

                    break



                # 构建下一个 URL

                import urllib.parse

                next_url = urllib.parse.urljoin(current_url, location)



                # 检查是否包含回调参数

                if "code=" in next_url and "state=" in next_url:

                    self._log(f"找到回调 URL: {next_url[:100]}...")

                    return next_url



                current_url = next_url



            self._log("未能在重定向链中找到回调 URL", "error")

            return None



        except Exception as e:

            self._log(f"跟随重定向失败: {e}", "error")

            return None



    def _handle_oauth_callback(self, callback_url: str) -> Optional[Dict[str, Any]]:

        """处理 OAuth 回调"""

        try:

            if not self.oauth_start:

                self._log("OAuth 流程未初始化", "error")

                return None



            self._log("处理 OAuth 回调...")

            token_info = self.oauth_manager.handle_callback(

                callback_url=callback_url,

                expected_state=self.oauth_start.state,

                code_verifier=self.oauth_start.code_verifier

            )



            self._log("OAuth 授权成功")

            return token_info



        except Exception as e:

            self._log(f"处理 OAuth 回调失败: {e}", "error")

            return None



    def run(self) -> RegistrationResult:

        """

        执行完整的注册流程



        支持已注册账号自动登录：

        - 如果检测到邮箱已注册，自动切换到登录流程

        - 已注册账号跳过：设置密码、发送验证码、创建用户账户

        - 共用步骤：获取验证码、验证验证码、Workspace 和 OAuth 回调



        Returns:

            RegistrationResult: 注册结果

        """

        result = RegistrationResult(success=False, logs=self.logs)

        self.password_was_set = False



        try:

            self._log("=" * 60)

            self._log("开始注册流程")

            self._log("=" * 60)



            # 1. 检查 IP 地理位置

            self._log("1. 检查 IP 地理位置...")

            ip_ok, location = self._check_ip_location()

            if not ip_ok:

                result.error_message = f"IP 地理位置不支持: {location}"

                self._log(f"IP 检查失败: {location}", "error")

                return result



            self._log(f"IP 位置: {location}")



            # 2. 创建邮箱

            self._log("2. 创建邮箱...")

            if not self._create_email():

                result.error_message = "创建邮箱失败"

                return result



            result.email = self.email



            # 3. 初始化会话

            self._log("3. 初始化会话...")

            if not self._init_session():

                result.error_message = "初始化会话失败"

                return result



            # 4. 开始 OAuth 流程

            self._log("4. 开始 OAuth 授权流程...")

            if not self._start_oauth():

                result.error_message = "开始 OAuth 流程失败"

                return result



            # 5. 获取 Device ID

            self._log("5. 获取 Device ID...")

            did = self._get_device_id()

            if not did:

                result.error_message = "获取 Device ID 失败"

                return result



            # 6. 检查 Sentinel 拦截

            self._log("6. 检查 Sentinel 拦截...")

            sen_payload = self._check_sentinel(did)

            if sen_payload:

                self._log("Sentinel 检查通过")

            else:

                self._log("Sentinel 检查失败或未启用", "warning")



            # 7. 提交注册表单 + 解析响应判断账号状态

            self._log("7. 提交注册表单...")

            signup_result = self._submit_signup_form(did, sen_payload)

            if not signup_result.success:

                result.error_message = f"提交注册表单失败: {signup_result.error_message}"

                return result



            signup_page_type = signup_result.page_type or ""



            # 8. 根据授权页状态决定是否需要密码步骤

            if signup_page_type == OPENAI_PAGE_TYPES["EMAIL_OTP_VERIFICATION"]:

                self._log("8. 已进入邮箱验证码流程，跳过密码设置")

            elif self._is_existing_account:

                self._log("8. [已注册账号] 跳过密码设置")

            else:

                self._log("8. 注册密码...")

                password_ok, password = self._register_password()

                if not password_ok:

                    result.error_message = "注册密码失败"

                    return result



            # 9. 发送验证码（协议模式没有浏览器 JS 自动触发，必须显式调用 API）

            if self._is_existing_account:

                self._log("9. [已注册账号] 发送登录验证码...")

            else:

                self._log("9. 发送验证码...")

            if not self._send_verification_code():

                result.error_message = "发送验证码失败"

                return result



            # 10. 获取验证码

            self._log("10. 等待验证码...")

            code = self._get_verification_code()

            if not code:

                result.error_message = "获取验证码失败"

                return result



            # 11. 验证验证码

            self._log("11. 验证验证码...")

            if not self._validate_verification_code(code):

                result.error_message = "验证验证码失败"

                return result



            # 12. 根据 OTP 响应决定下一步

            if self._otp_page_type == "about_you" and not self._is_existing_account:

                # 正常注册流程: about_you → create_account

                self._log("12. 创建用户账户...")

                if not self._create_user_account():

                    result.error_message = "创建用户账户失败"

                    return result

            elif self._is_existing_account:

                self._log("12. [已注册账号] 跳过创建用户账户")

            else:

                self._log(f"12. OTP page_type={self._otp_page_type}，尝试创建账户...")

                if not self._create_user_account():

                    result.error_message = "创建用户账户失败"

                    return result



            # 13. 跟随 callback URL 到 chatgpt.com 获取 session

            callback_url = self._create_account_continue_url

            if not callback_url or "code=" not in str(callback_url):

                result.error_message = "create_account 未返回有效的 callback URL"

                return result



            self._log("13. 跟随 callback URL 到 chatgpt.com...")

            cb_resp = self.session.get(callback_url, timeout=20)

            self._log(f"callback 状态: {cb_resp.status_code}")



            # 提取 session cookie

            session_token = self.session.cookies.get("__Secure-next-auth.session-token")

            account_cookie = self.session.cookies.get("_account", "")

            if session_token:

                self._log(f"获取到 session-token: {session_token[:30]}...")

            if account_cookie:

                self._log(f"获取到 _account: {account_cookie}")



            # 14. 从 chatgpt.com/api/auth/session 获取 access_token

            from .constants import CHATGPT_APP

            self._log("14. 获取 session 信息...")

            session_resp = self.session.get(

                f"{CHATGPT_APP}/api/auth/session",

                headers={"accept": "application/json"},

                timeout=15,

            )

            self._log(f"session API 状态: {session_resp.status_code}")

            self._log(f"session API 响应: {session_resp.text[:500]}")



            session_data = session_resp.json()

            access_token = session_data.get("accessToken", "")

            user_data = session_data.get("user", {})

            self._log(f"session keys: {list(session_data.keys())}")

            self._log(f"accessToken 长度: {len(access_token)}")



            if not access_token:

                result.error_message = "chatgpt.com session 未返回 accessToken"

                return result



            self._log("NextAuth session 获取成功")



            # 15. Codex CLI OTP 登录获取 refresh_token + id_token

            codex_token_info = None

            try:

                self._log("15. Codex CLI OTP 登录...")

                from .constants import (

                    CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CODEX_SCOPE,

                    OPENAI_AUTH, SENTINEL_FRAME_URL,

                )

                import urllib.parse



                codex_oauth = generate_oauth_url(

                    redirect_uri=CODEX_REDIRECT_URI,

                    scope=CODEX_SCOPE,

                    client_id=CODEX_CLIENT_ID,

                )



                # 用全新 session（Hydra 需要干净 session）

                login_client = OpenAIHTTPClient(proxy_url=self.proxy_url)

                login_session = login_client.session



                # 访问 Codex OAuth URL，跟随重定向到 /log-in

                login_session.get(codex_oauth.auth_url, timeout=15)

                did2 = login_session.cookies.get("oai-did", "")

                self._log(f"Codex login did: {did2[:20]}...")



                # 获取 sentinel（用 login_client）

                sen2 = None

                try:

                    ua2 = login_client.default_headers.get("User-Agent", "")

                    gen2 = _SentinelTokenGenerator(did2, ua2)

                    sp2 = gen2.generate_requirements_token()

                    sr2 = json.dumps({"p": sp2, "id": did2, "flow": "authorize_continue"}, separators=(",", ":"))

                    sr2_resp = login_client.post(

                        OPENAI_API_ENDPOINTS["sentinel"],

                        headers={"origin": "https://sentinel.openai.com", "referer": SENTINEL_FRAME_URL, "content-type": "text/plain;charset=UTF-8"},

                        data=sr2,

                    )

                    if sr2_resp.status_code == 200:

                        d2 = sr2_resp.json()

                        pm2 = d2.get("proofofwork") or {}

                        if pm2.get("required") and pm2.get("seed"):

                            sp2 = gen2.generate_token(str(pm2.get("seed") or ""), str(pm2.get("difficulty") or "0"))

                        tr2 = (d2.get("turnstile") or {}).get("dx", "")

                        tv2 = ""

                        if tr2:

                            try: tv2 = gen2.decrypt_turnstile(tr2, sp2)

                            except: pass

                        sen2 = SentinelPayload(p=sp2, t=tv2, c=str(d2.get("token") or ""), flow="authorize_continue")

                        self._log("Codex sentinel 获取成功")

                except Exception as e:

                    self._log(f"Codex sentinel 失败: {e}", "warning")



                # authorize/continue 提交邮箱（不带 screen_hint，让 codex_cli_simplified_flow 决定）

                signup_headers = {

                    "referer": f"{OPENAI_AUTH}/log-in",

                    "accept": "application/json",

                    "content-type": "application/json",

                }

                if sen2 and did2:

                    signup_headers["openai-sentinel-token"] = json.dumps({

                        "p": sen2.p, "t": sen2.t, "c": sen2.c,

                        "id": did2, "flow": sen2.flow,

                    }, separators=(",", ":"))



                signup_body = json.dumps({"username": {"value": self.email, "kind": "email"}, "screen_hint": "signup"})

                signup_resp = login_session.post(

                    OPENAI_API_ENDPOINTS["signup"], headers=signup_headers, data=signup_body

                )

                self._log(f"Codex authorize/continue: {signup_resp.status_code}")

                if signup_resp.status_code != 200:

                    raise RuntimeError(f"authorize/continue 失败: {signup_resp.text[:200]}")



                page_type = signup_resp.json().get("page", {}).get("type", "")

                self._log(f"Codex page_type: {page_type}")



                # 如果返回 email_otp_send 或 email_otp_verification，走 OTP 流程

                if page_type in ("email_otp_send", "email_otp_verification"):

                    # email_otp_verification 也不保证邮件已自动发出，统一显式发送。

                    login_session.get(OPENAI_API_ENDPOINTS["send_otp"], headers={

                        "referer": f"{OPENAI_AUTH}/email-verification",

                    }, timeout=15)

                    self._log("Codex OTP 已显式发送")



                    # 等待 OTP

                    self._otp_sent_at = time.time()

                    code = self._get_verification_code()

                    if not code:

                        raise RuntimeError("Codex OTP 获取失败")

                    self._log(f"Codex OTP: {code}")



                    # 验证 OTP

                    otp_resp = login_session.post(

                        OPENAI_API_ENDPOINTS["validate_otp"],

                        headers={

                            "referer": f"{OPENAI_AUTH}/email-verification",

                            "accept": "application/json",

                            "content-type": "application/json",

                        },

                        data=json.dumps({"code": code}),

                    )

                    self._log(f"Codex OTP validate: {otp_resp.status_code}")

                    if otp_resp.status_code != 200:

                        raise RuntimeError(f"Codex OTP 验证失败: {otp_resp.text[:200]}")



                    otp_data = otp_resp.json()

                    otp_page = otp_data.get("page", {}).get("type", "")

                    self._log(f"Codex OTP -> page_type={otp_page}")



                    if otp_page == "add_phone":

                        self._log("Codex CLI 仍需 add_phone，跳过", "warning")

                        raise RuntimeError("add_phone required")



                    # OTP 成功后，重新访问 OAuth URL 获取 callback

                    self._log("Codex: 重新访问 OAuth URL...")

                    resp = login_session.get(codex_oauth.auth_url, allow_redirects=False, timeout=15)

                    codex_callback = None

                    current_url = codex_oauth.auth_url

                    for i in range(15):

                        if resp.status_code not in (301, 302, 303, 307, 308):

                            break

                        location = resp.headers.get("Location", "")

                        if not location:

                            break

                        next_url = urllib.parse.urljoin(current_url, location)

                        self._log(f"Codex 重定向 {i+1}: {next_url[:80]}...")

                        if "code=" in next_url and "state=" in next_url:

                            codex_callback = next_url

                            break

                        current_url = next_url

                        resp = login_session.get(current_url, allow_redirects=False, timeout=15)



                    if codex_callback:

                        self._log("Codex CLI callback 获取成功")

                        token_json = submit_callback_url(

                            callback_url=codex_callback,

                            expected_state=codex_oauth.state,

                            code_verifier=codex_oauth.code_verifier,

                            redirect_uri=CODEX_REDIRECT_URI,

                            client_id=CODEX_CLIENT_ID,

                            proxy_url=self.proxy_url,

                        )

                        codex_token_info = json.loads(token_json)

                        self._log(f"Codex token 成功: keys={list(codex_token_info.keys())}")

                    else:

                        self._log(f"Codex callback 未获取 (status={resp.status_code})", "warning")

                else:

                    self._log(f"Codex 非 OTP 流程 ({page_type})，跳过", "warning")

            except Exception as e:

                self._log(f"Codex CLI 登录失败: {e}", "warning")



            # 提取账户信息（优先 Codex token，fallback 到 NextAuth session）

            if codex_token_info and codex_token_info.get("access_token"):

                self._log("使用 Codex CLI token（完整 refresh_token + id_token）")

                result.account_id = codex_token_info.get("account_id", "") or account_cookie or ""

                result.access_token = codex_token_info.get("access_token", "")

                result.refresh_token = codex_token_info.get("refresh_token", "")

                result.id_token = codex_token_info.get("id_token", "")

            else:

                self._log("使用 NextAuth session token", "warning")

                result.account_id = account_cookie or ""

                result.access_token = access_token

                result.refresh_token = ""

                # access_token JWT 包含 chatgpt_account_id 等同于 id_token 的 claims

                result.id_token = access_token



            result.password = (self.password or "") if self.password_was_set else ""

            result.source = "login" if self._is_existing_account else "register"



            if session_token:

                self.session_token = session_token

                result.session_token = session_token

                self._log(f"获取到 Session Token")



            # 17. 完成

            self._log("=" * 60)

            if self._is_existing_account:

                self._log("登录成功! (已注册账号)")

            else:

                self._log("注册成功!")

            self._log(f"邮箱: {result.email}")

            self._log(f"Account ID: {result.account_id}")

            self._log(f"Workspace ID: {result.workspace_id}")

            self._log("=" * 60)



            result.success = True

            result.metadata = {

                "email_service": self.email_service.service_type.value,

                "proxy_used": self.proxy_url,

                "registered_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),

                "is_existing_account": self._is_existing_account,

                "password_set": self.password_was_set,

                "password_status": "configured" if self.password_was_set else "not_configured",

                "password_source": "signup_required" if self.password_was_set else "none",

            }



            return result



        except Exception as e:

            self._log(f"注册过程中发生未预期错误: {e}", "error")

            result.error_message = str(e)

            return result



    def save_to_database(self, result: RegistrationResult) -> bool:

        """

        保存注册结果到数据库



        Args:

            result: 注册结果



        Returns:

            是否保存成功

        """

        if not result.success:

            return False



        return True  # 由 account_manager 统一处理存库
