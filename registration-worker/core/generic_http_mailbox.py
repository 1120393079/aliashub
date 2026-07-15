"""通用 HTTP 邮箱驱动 —— 所有步骤通过 DB 配置描述，零代码新增邮箱类型。

步骤管道:
  auth_steps[]  →  create_email  →  list_emails  →  get_detail
   (可选)           (可选)           (必需)          (可选)

配置存储在 provider_definitions.metadata_json 中，
用户填写的值存在 provider_settings.config_json / auth_json 中。
"""
from __future__ import annotations

import re
import time
from copy import deepcopy
from urllib.parse import urlencode

import requests

from core.base_mailbox import BaseMailbox, MailboxAccount, _extract_verification_link
from core.tls import mark_session_insecure, suppress_insecure_request_warning


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _deep_get(data, path: str, default=None):
    """简化 dot-path 取值: 'data.list' → data["data"]["list"]"""
    if not path:
        return data
    keys = path.split(".")
    current = data
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key)
        elif isinstance(current, (list, tuple)) and key.isdigit():
            idx = int(key)
            current = current[idx] if 0 <= idx < len(current) else None
        else:
            return default
        if current is None:
            return default
    return current


def _render(template, variables: dict) -> str:
    """替换模板中的 {var} 占位符"""
    if not isinstance(template, str):
        return template
    result = template
    for key, value in variables.items():
        result = result.replace(f"{{{key}}}", str(value or ""))
    return result


def _render_dict(template: dict | None, variables: dict) -> dict:
    """递归替换 dict 中的 {var} 占位符"""
    if not template:
        return {}
    result = {}
    for key, value in template.items():
        if isinstance(value, str):
            result[key] = _render(value, variables)
        elif isinstance(value, dict):
            result[key] = _render_dict(value, variables)
        else:
            result[key] = value
    return result


# ---------------------------------------------------------------------------
# 通用 HTTP 邮箱驱动
# ---------------------------------------------------------------------------

class GenericHttpMailbox(BaseMailbox):
    """数据驱动的通用邮箱，所有端点和认证通过配置描述。

    配置来源（按优先级合并）:
      1. pipeline_config: 高级步骤管道（来自 provider_definitions.metadata_json）
      2. settings: 用户 UI 填写的 flat 字段（api_url, list_path, auth_type, …）

    当 pipeline_config 为空时，自动从 settings 的 flat 字段构建管道。
    """

    def __init__(
        self,
        pipeline_config: dict,
        settings: dict,
        proxy: str = None,
    ):
        self._settings = dict(settings or {})
        self._proxy = {"http": proxy, "https": proxy} if proxy else None

        # 从 metadata 管道 + flat settings 合并出最终管道
        self._pipeline = self._build_pipeline(pipeline_config)

        # 运行时变量池：用户配置 + 步骤提取值
        self._vars: dict[str, str] = dict(self._settings)

        # HTTP session（带 cookie jar，支持多步认证）
        self._session: requests.Session | None = None
        self._email: str | None = None
        self._authenticated = False

    def _build_pipeline(self, raw: dict | None) -> dict:
        """从 metadata 管道和 flat settings 合并构建最终管道配置。"""
        pipeline = deepcopy(raw or {})
        s = self._settings

        # flat settings 中的值作为默认，metadata 中的值优先
        pipeline.setdefault("email_mode", s.get("email_mode", "fixed"))
        pipeline.setdefault("response_list_path", s.get("response_list_path", ""))
        pipeline.setdefault("response_id_field", s.get("response_id_field", "id"))

        # 正文字段：逗号分隔字符串 → list
        if "response_body_fields" not in pipeline:
            raw_fields = s.get("response_body_fields", "subject,content,html,text,body,preview")
            pipeline["response_body_fields"] = [f.strip() for f in raw_fields.split(",") if f.strip()]

        # 从 flat settings 构建 list_emails 步骤（如果 metadata 里没有）
        if "list_emails" not in pipeline:
            list_path = s.get("list_path", "")
            if list_path:
                step: dict = {
                    "method": s.get("list_method", "GET"),
                    "path": list_path,
                }
                raw_params = s.get("list_params", "").strip()
                if raw_params:
                    try:
                        import json
                        step["params"] = json.loads(raw_params)
                    except Exception:
                        pass
                pipeline["list_emails"] = step

        # 从 flat settings 构建 create_email 步骤
        if "create_email" not in pipeline:
            create_method = s.get("create_method", "").strip()
            create_path = s.get("create_path", "").strip()
            if create_method and create_path:
                step = {"method": create_method, "path": create_path}
                raw_body = s.get("create_body", "").strip()
                if raw_body:
                    try:
                        import json
                        step["body"] = json.loads(raw_body)
                    except Exception:
                        pass
                email_field = s.get("create_email_field", "").strip()
                if email_field:
                    step["extract"] = {"email": email_field}
                pipeline["create_email"] = step

        # 从 flat settings 构建 get_detail 步骤
        if "get_detail" not in pipeline:
            detail_path = s.get("detail_path", "").strip()
            if detail_path:
                pipeline["get_detail"] = {"method": "GET", "path": detail_path}

        return pipeline

    # ── HTTP session 管理 ──────────────────────────────────────────────

    def _get_session(self) -> requests.Session:
        if self._session is None:
            s = requests.Session()
            s.proxies = self._proxy or {}
            mark_session_insecure(s)
            ua = self._settings.get("user_agent") or (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/145.0.0.0 Safari/537.36"
            )
            s.headers.update({"user-agent": ua})

            # 根据 auth_type 自动注入认证 header
            auth_type = self._settings.get("auth_type", "none")
            token = self._settings.get("auth_token", "")
            if token:
                if auth_type == "bearer":
                    s.headers["authorization"] = f"Bearer {token}"
                elif auth_type == "header":
                    header_name = self._settings.get("auth_header_name", "authorization")
                    s.headers[header_name] = token
                elif auth_type == "api_key_param":
                    # api_key 作为查询参数，在每次请求时注入
                    pass

            self._session = s
        return self._session

    # ── 步骤执行引擎 ──────────────────────────────────────────────────

    def _execute_step(self, step_config: dict) -> dict | list | None:
        """执行单个 HTTP 步骤，返回响应 JSON。"""
        session = self._get_session()
        api_url = self._vars.get("api_url", "").rstrip("/")

        method = _render(step_config.get("method", "GET"), self._vars).upper()
        path = _render(step_config.get("path", ""), self._vars)
        url = f"{api_url}{path}" if not path.startswith("http") else path

        # headers
        headers = _render_dict(step_config.get("headers"), self._vars)

        # query params
        params = _render_dict(step_config.get("params"), self._vars)

        # api_key 作为查询参数注入
        if self._settings.get("auth_type") == "api_key_param" and self._settings.get("auth_token"):
            key_name = self._settings.get("auth_header_name", "apikey")
            params[key_name] = self._settings["auth_token"]

        # body
        content_type = step_config.get("content_type", "json")
        body_template = step_config.get("body")
        body = _render_dict(body_template, self._vars) if body_template else None

        kwargs: dict = {"timeout": int(step_config.get("timeout", 15))}
        if headers:
            kwargs["headers"] = headers
        if params:
            kwargs["params"] = params

        if body and method in ("POST", "PUT", "PATCH"):
            if content_type == "form":
                kwargs["data"] = urlencode(body)
                kwargs.setdefault("headers", {})["content-type"] = "application/x-www-form-urlencoded"
            else:
                kwargs["json"] = body

        with suppress_insecure_request_warning():
            resp = session.request(method, url, **kwargs)

        resp_data = None
        try:
            resp_data = resp.json()
        except Exception:
            resp_data = {"_text": resp.text}

        # 提取变量
        extract_map = step_config.get("extract") or {}
        for var_name, json_path in extract_map.items():
            extracted = _deep_get(resp_data, json_path)
            if extracted is not None:
                self._vars[var_name] = str(extracted)

        # 提取 cookie
        cookie_name = step_config.get("extract_cookie")
        if cookie_name:
            for cookie in session.cookies:
                if cookie_name in cookie.name:
                    self._vars["session_token"] = cookie.value
                    break

        return resp_data

    def _run_auth(self) -> None:
        """执行认证步骤链（如果有）。"""
        if self._authenticated:
            return
        auth_steps = self._pipeline.get("auth_steps") or []
        for step in auth_steps:
            self._execute_step(step)
        self._authenticated = True

    # ── BaseMailbox 接口 ──────────────────────────────────────────────

    def get_email(self) -> MailboxAccount:
        self._run_auth()

        email_mode = self._pipeline.get("email_mode", "fixed")

        if email_mode == "fixed":
            email = self._vars.get("email", "")
            if not email:
                raise RuntimeError("通用邮箱驱动: email_mode=fixed 但未配置 email")
            self._email = email
            return MailboxAccount(
                email=email,
                account_id=self._vars.get("account_id", ""),
            )

        if email_mode == "namespace_tag":
            import random
            import string
            namespace = self._vars.get("namespace", "")
            tag_prefix = self._vars.get("tag_prefix", "")
            suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
            tag = f"{tag_prefix}.{suffix}" if tag_prefix else suffix
            email = f"{namespace}.{tag}@inbox.testmail.app"
            self._email = email
            self._vars["email"] = email
            self._vars["tag"] = tag
            return MailboxAccount(email=email)

        # email_mode == "generate"
        create_step = self._pipeline.get("create_email")
        if not create_step:
            raise RuntimeError("通用邮箱驱动: email_mode=generate 但未配置 create_email 步骤")

        # 多步创建（list of steps）
        steps = create_step if isinstance(create_step, list) else [create_step]
        for step in steps:
            self._execute_step(step)

        email = self._vars.get("email", "")
        if not email:
            raise RuntimeError("通用邮箱驱动: create_email 执行完成但未提取到 email")
        self._email = email
        return MailboxAccount(
            email=email,
            account_id=self._vars.get("account_id", ""),
        )

    def get_current_ids(self, account: MailboxAccount) -> set:
        self._run_auth()
        self._vars["email"] = account.email
        if account.account_id:
            self._vars["account_id"] = account.account_id

        list_step = self._pipeline.get("list_emails")
        if not list_step:
            return set()

        resp = self._execute_step(list_step)

        list_path = self._pipeline.get("response_list_path", "")
        id_field = self._pipeline.get("response_id_field", "id")

        items = _deep_get(resp, list_path) if list_path else resp
        if not isinstance(items, list):
            return set()

        return {str(item.get(id_field, "")) for item in items if item.get(id_field)}

    def wait_for_code(
        self,
        account: MailboxAccount,
        keyword: str = "",
        timeout: int = 120,
        before_ids: set = None,
        code_pattern: str = None,
    ) -> str:
        self._run_auth()
        self._vars["email"] = account.email
        if account.account_id:
            self._vars["account_id"] = account.account_id

        list_step = self._pipeline.get("list_emails")
        if not list_step:
            raise RuntimeError("通用邮箱驱动: 未配置 list_emails 步骤")

        list_path = self._pipeline.get("response_list_path", "")
        id_field = self._pipeline.get("response_id_field", "id")
        body_fields = self._pipeline.get("response_body_fields", ["subject", "content", "html", "text", "body", "preview"])

        seen = set(before_ids or [])
        start = time.time()

        while time.time() - start < timeout:
            try:
                resp = self._execute_step(list_step)
                items = _deep_get(resp, list_path) if list_path else resp
                if not isinstance(items, list):
                    items = []

                # 如果有 get_detail 步骤，需要逐个获取详情
                detail_step = self._pipeline.get("get_detail")

                for item in items:
                    mid = str(item.get(id_field, ""))
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)

                    # 拼接正文
                    if detail_step:
                        self._vars["message_id"] = mid
                        detail_resp = self._execute_step(detail_step)
                        detail_data = detail_resp if isinstance(detail_resp, dict) else {}
                    else:
                        detail_data = item

                    text_parts = []
                    for field in body_fields:
                        val = detail_data.get(field)
                        if val:
                            text_parts.append(str(val))

                    # 也检查特殊字段
                    code_val = detail_data.get("verification_code")
                    if code_val and str(code_val) != "None":
                        return str(code_val)

                    combined = " ".join(text_parts)
                    if not combined.strip():
                        continue

                    # 正则提取验证码
                    pattern = code_pattern or r'(?<!\d)(\d{6})(?!\d)'
                    m = re.search(pattern, combined)
                    if m:
                        return m.group(1) if m.groups() else m.group(0)

            except Exception:
                pass
            time.sleep(3)

        raise TimeoutError(f"等待验证码超时 ({timeout}s)")

    def wait_for_link(
        self,
        account: MailboxAccount,
        keyword: str = "",
        timeout: int = 120,
        before_ids: set = None,
    ) -> str:
        self._run_auth()
        self._vars["email"] = account.email
        if account.account_id:
            self._vars["account_id"] = account.account_id

        list_step = self._pipeline.get("list_emails")
        if not list_step:
            raise RuntimeError("通用邮箱驱动: 未配置 list_emails 步骤")

        list_path = self._pipeline.get("response_list_path", "")
        id_field = self._pipeline.get("response_id_field", "id")
        body_fields = self._pipeline.get("response_body_fields", ["subject", "content", "html", "text", "body", "preview"])

        seen = set(before_ids or [])
        start = time.time()

        while time.time() - start < timeout:
            try:
                resp = self._execute_step(list_step)
                items = _deep_get(resp, list_path) if list_path else resp
                if not isinstance(items, list):
                    items = []

                detail_step = self._pipeline.get("get_detail")

                for item in items:
                    mid = str(item.get(id_field, ""))
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)

                    if detail_step:
                        self._vars["message_id"] = mid
                        detail_resp = self._execute_step(detail_step)
                        detail_data = detail_resp if isinstance(detail_resp, dict) else {}
                    else:
                        detail_data = item

                    text_parts = []
                    for field in body_fields:
                        val = detail_data.get(field)
                        if val:
                            text_parts.append(str(val))

                    combined = " ".join(text_parts)
                    link = _extract_verification_link(combined, keyword)
                    if link:
                        return link

            except Exception:
                pass
            time.sleep(3)

        raise TimeoutError(f"等待验证链接超时 ({timeout}s)")
