"""outlookEmail 对外 API 邮箱 provider。"""
from __future__ import annotations

import html
import re
import time
from urllib.parse import urlparse
from typing import Any

import requests

from core.base_mailbox import BaseMailbox, MailboxAccount, _extract_verification_link
from core.tls import mark_session_insecure, suppress_insecure_request_warning


DEFAULT_CODE_PATTERN = r"(?<!#)(?<!\d)(\d{6})(?!\d)"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _truthy(value: Any) -> bool:
    return _text(value).lower() in {"1", "true", "yes", "on", "y"}


def _split_names(value: Any) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        raw_items = [str(item or "") for item in value]
    else:
        raw_items = re.split(r"[,，\n\r]+", str(value or ""))
    result: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        name = item.strip()
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            result.append(name)
    return result


def _normalize_base_url(value: str) -> str:
    raw = _text(value)
    if not raw:
        raise RuntimeError("outlookEmail 未配置服务地址")
    if "://" not in raw:
        raw = f"https://{raw.lstrip('/')}"
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"outlookEmail 服务地址无效: {value!r}")
    return raw.rstrip("/")


def _bounded_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return min(max(number, minimum), maximum)


def _strip_markup(text: str) -> str:
    cleaned = html.unescape(str(text or ""))
    cleaned = re.sub(r"<style[^>]*>.*?</style>", " ", cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"<script[^>]*>.*?</script>", " ", cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


class OutlookEmailMailbox(BaseMailbox):
    """通过 assast/outlookEmail 对外 API 读取 Outlook/Hotmail 邮件。"""

    def __init__(
        self,
        *,
        api_url: str,
        api_key: str,
        admin_password: str = "",
        fixed_email: str = "",
        group_id: str = "",
        account_limit: str | int = "",
        account_offset: str | int = "",
        account_sort_by: str = "",
        account_sort_order: str = "",
        account_tag_ids: str = "",
        account_include_untagged: str | bool = "",
        email_folder: str = "",
        email_top: str | int = "",
        email_subject_contains: str = "",
        email_from_contains: str = "",
        email_keyword: str = "",
        poll_interval: str | int = "",
        skip_tag_names: str | list[str] = "",
        register_success_tag_names: str | list[str] = "",
        plus_success_tag_names: str | list[str] = "",
        proxy: str | None = None,
    ):
        self.api = _normalize_base_url(api_url)
        self.api_key = _text(api_key)
        self.admin_password = _text(admin_password)
        self.fixed_email = _text(fixed_email)
        self.group_id = _text(group_id)
        self.account_limit = _bounded_int(account_limit, default=100, minimum=1, maximum=10000)
        self.account_offset = _bounded_int(account_offset, default=0, minimum=0, maximum=1000000)
        self.account_sort_by = _text(account_sort_by)
        self.account_sort_order = _text(account_sort_order).lower()
        self.account_tag_ids = _text(account_tag_ids)
        self.account_include_untagged = _truthy(account_include_untagged)
        self.email_folder = _text(email_folder).lower() or "all"
        self.email_top = _bounded_int(email_top, default=10, minimum=1, maximum=50)
        self.email_subject_contains = _text(email_subject_contains)
        self.email_from_contains = _text(email_from_contains)
        self.email_keyword = _text(email_keyword)
        self.poll_interval = _bounded_int(poll_interval, default=4, minimum=1, maximum=30)
        self.skip_tag_names = _split_names(skip_tag_names)
        self.register_success_tag_names = _split_names(register_success_tag_names)
        self.plus_success_tag_names = _split_names(plus_success_tag_names)
        self.proxy = {"http": proxy, "https": proxy} if proxy else None
        self._session: requests.Session | None = None
        self._admin_session: requests.Session | None = None
        self._csrf_token: str = ""

        self._assert_ready()

    @classmethod
    def from_config(cls, config: dict) -> "OutlookEmailMailbox":
        return cls(
            api_url=config.get("outlook_email_api_url", ""),
            api_key=config.get("outlook_email_api_key", ""),
            admin_password=config.get("outlook_email_admin_password", ""),
            fixed_email=config.get("outlook_email_fixed_email", ""),
            group_id=config.get("outlook_email_group_id", ""),
            account_limit=config.get("outlook_email_account_limit", ""),
            account_offset=config.get("outlook_email_account_offset", ""),
            account_sort_by=config.get("outlook_email_account_sort_by", ""),
            account_sort_order=config.get("outlook_email_account_sort_order", ""),
            account_tag_ids=config.get("outlook_email_account_tag_ids", ""),
            account_include_untagged=config.get("outlook_email_account_include_untagged", ""),
            email_folder=config.get("outlook_email_folder", ""),
            email_top=config.get("outlook_email_top", ""),
            email_subject_contains=config.get("outlook_email_subject_contains", ""),
            email_from_contains=config.get("outlook_email_from_contains", ""),
            email_keyword=config.get("outlook_email_keyword", ""),
            poll_interval=config.get("outlook_email_poll_interval", ""),
            skip_tag_names=config.get("outlook_email_skip_tag_names", ""),
            register_success_tag_names=config.get("outlook_email_register_success_tag_names", ""),
            plus_success_tag_names=config.get("outlook_email_plus_success_tag_names", ""),
            proxy=config.get("proxy") or config.get("mailbox_proxy"),
        )

    def _assert_ready(self) -> None:
        if not self.api_key:
            raise RuntimeError("outlookEmail 未配置 API Key")

    def _get_session(self) -> requests.Session:
        if self._session is None:
            session = requests.Session()
            session.proxies = self.proxy or {}
            mark_session_insecure(session)
            session.headers.update(
                {
                    "X-API-Key": self.api_key,
                    "user-agent": "aBaiAutoplus/outlookEmail-mailbox",
                    "accept": "application/json",
                }
            )
            self._session = session
        return self._session

    def _get_json(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        session = self._get_session()
        clean_params = {
            key: value
            for key, value in (params or {}).items()
            if value not in (None, "")
        }
        url = f"{self.api}{path}"
        with suppress_insecure_request_warning():
            response = session.get(url, params=clean_params, timeout=15)

        try:
            payload = response.json()
        except Exception as exc:
            raise RuntimeError(f"outlookEmail 响应不是 JSON: HTTP {response.status_code}") from exc

        if response.status_code in {401, 403}:
            raise RuntimeError("outlookEmail API Key 认证失败")
        if response.status_code >= 400:
            message = payload.get("error") or payload.get("message") or f"HTTP {response.status_code}"
            raise RuntimeError(f"outlookEmail 请求失败: {message}")
        if isinstance(payload, dict) and payload.get("success") is False:
            message = payload.get("error") or payload.get("message") or "success=false"
            raise RuntimeError(f"outlookEmail 请求失败: {message}")
        return payload if isinstance(payload, dict) else {"items": payload}

    def _get_admin_session(self) -> requests.Session:
        if self._admin_session is not None:
            return self._admin_session
        if not self.admin_password:
            raise RuntimeError("outlookEmail 未配置管理员密码，无法执行打标签")

        session = requests.Session()
        session.proxies = self.proxy or {}
        mark_session_insecure(session)
        session.headers.update(
            {
                "user-agent": "aBaiAutoplus/outlookEmail-mailbox",
                "accept": "application/json",
            }
        )
        with suppress_insecure_request_warning():
            login_response = session.post(
                f"{self.api}/login",
                json={"password": self.admin_password},
                timeout=15,
            )
        login_payload = self._response_json(login_response, "outlookEmail 登录")
        if login_response.status_code >= 400 or login_payload.get("success") is False:
            message = login_payload.get("error") or login_payload.get("message") or f"HTTP {login_response.status_code}"
            raise RuntimeError(f"outlookEmail 管理端登录失败: {message}")

        with suppress_insecure_request_warning():
            csrf_response = session.get(f"{self.api}/api/csrf-token", timeout=15)
        csrf_payload = self._response_json(csrf_response, "outlookEmail CSRF")
        self._csrf_token = _text(csrf_payload.get("csrf_token"))
        if self._csrf_token:
            session.headers.update({"X-CSRFToken": self._csrf_token})
        self._admin_session = session
        return session

    @staticmethod
    def _response_json(response, label: str) -> dict[str, Any]:
        try:
            payload = response.json()
        except Exception as exc:
            raise RuntimeError(f"{label} 响应不是 JSON: HTTP {response.status_code}") from exc
        return payload if isinstance(payload, dict) else {"items": payload}

    def _admin_get_json(self, path: str) -> dict[str, Any]:
        session = self._get_admin_session()
        with suppress_insecure_request_warning():
            response = session.get(f"{self.api}{path}", timeout=15)
        payload = self._response_json(response, f"outlookEmail GET {path}")
        if response.status_code >= 400 or payload.get("success") is False:
            message = payload.get("error") or payload.get("message") or f"HTTP {response.status_code}"
            raise RuntimeError(f"outlookEmail 管理端请求失败: {message}")
        return payload

    def _admin_post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        session = self._get_admin_session()
        with suppress_insecure_request_warning():
            response = session.post(f"{self.api}{path}", json=body, timeout=15)
        payload = self._response_json(response, f"outlookEmail POST {path}")
        if response.status_code >= 400 or payload.get("success") is False:
            message = payload.get("error") or payload.get("message") or f"HTTP {response.status_code}"
            raise RuntimeError(f"outlookEmail 管理端请求失败: {message}")
        return payload

    def _account_query_params(self) -> dict[str, Any]:
        params: dict[str, Any] = {
            "limit": self.account_limit,
            "offset": self.account_offset,
        }
        if self.group_id:
            params["group_id"] = self.group_id
        if self.account_sort_by:
            params["sort_by"] = self.account_sort_by
        if self.account_sort_order in {"asc", "desc"}:
            params["sort_order"] = self.account_sort_order
        if self.account_tag_ids:
            params["tag_ids"] = self.account_tag_ids
            params["include_untagged"] = "true" if self.account_include_untagged else "false"
        return params

    def _email_query_params(self, account: MailboxAccount, runtime_keyword: str = "") -> dict[str, Any]:
        params: dict[str, Any] = {
            "email": account.email,
            "folder": self.email_folder,
            "top": self.email_top,
        }
        if self.email_subject_contains:
            params["subject_contains"] = self.email_subject_contains
        if self.email_from_contains:
            params["from_contains"] = self.email_from_contains
        api_keyword = self.email_keyword or _text(runtime_keyword)
        if api_keyword:
            params["keyword"] = api_keyword
        return params

    def _list_accounts(self) -> list[dict[str, Any]]:
        payload = self._get_json("/api/external/accounts", self._account_query_params())
        items = payload.get("accounts")
        if not isinstance(items, list):
            items = payload.get("items") if isinstance(payload.get("items"), list) else []
        return [item for item in items if isinstance(item, dict)]

    @staticmethod
    def _account_email(item: dict[str, Any]) -> str:
        return _text(item.get("email") or item.get("address") or item.get("mail"))

    @staticmethod
    def _tag_names(item: dict[str, Any]) -> set[str]:
        tags = item.get("tags") if isinstance(item.get("tags"), list) else []
        result = set()
        for tag in tags:
            if isinstance(tag, dict):
                name = _text(tag.get("name"))
            else:
                name = _text(tag)
            if name:
                result.add(name.lower())
        return result

    def _has_skip_tag(self, item: dict[str, Any]) -> bool:
        if not self.skip_tag_names:
            return False
        account_tags = self._tag_names(item)
        return any(name.lower() in account_tags for name in self.skip_tag_names)

    def _is_usable_account(self, item: dict[str, Any]) -> bool:
        if not OutlookEmailMailbox._account_email(item):
            return False
        if self._has_skip_tag(item):
            return False
        status = _text(item.get("status")).lower()
        refresh_status = _text(item.get("last_refresh_status")).lower()
        disabled_statuses = {"disabled", "deleted", "inactive", "failed", "error", "invalid"}
        if status in disabled_statuses or refresh_status in disabled_statuses:
            return False
        return True

    def _select_account(self) -> dict[str, Any]:
        accounts = self._list_accounts()
        usable = [item for item in accounts if self._is_usable_account(item)]
        if not usable:
            fallback = [item for item in accounts if self._account_email(item) and not self._has_skip_tag(item)]
            usable = fallback
        if not usable:
            raise RuntimeError("outlookEmail 账号列表中没有可用邮箱")
        return usable[0]

    def _build_account(self, *, email: str, account_id: str = "", source: str, raw: dict[str, Any] | None = None) -> MailboxAccount:
        metadata = {
            "email": email,
            "api_url": self.api,
            "source": source,
        }
        raw = raw or {}
        for key in ("id", "group_id", "group_name", "status", "account_type", "provider", "last_refresh_status"):
            value = raw.get(key)
            if value not in (None, ""):
                metadata[key] = value

        resource_id = account_id or _text(raw.get("id")) or email
        return MailboxAccount(
            email=email,
            account_id=resource_id,
            extra={
                "provider_account": {
                    "provider_type": "mailbox",
                    "provider_name": "outlook_email",
                    "login_identifier": email,
                    "display_name": email,
                    "credentials": {},
                    "metadata": metadata,
                },
                "provider_resource": {
                    "provider_type": "mailbox",
                    "provider_name": "outlook_email",
                    "resource_type": "mailbox",
                    "resource_identifier": resource_id,
                    "handle": email,
                    "display_name": email,
                    "metadata": metadata,
                },
            },
        )

    def get_email(self) -> MailboxAccount:
        if self.fixed_email:
            self._assert_fixed_email_not_skipped()
            return self._build_account(email=self.fixed_email, account_id=self.fixed_email, source="fixed")

        item = self._select_account()
        email = self._account_email(item)
        return self._build_account(email=email, account_id=_text(item.get("id")), source="account_list", raw=item)

    def _assert_fixed_email_not_skipped(self) -> None:
        if not self.skip_tag_names:
            return
        target = self.fixed_email.lower()
        for item in self._list_accounts():
            if self._account_email(item).lower() == target and self._has_skip_tag(item):
                raise RuntimeError(f"outlookEmail 固定邮箱带有跳过标签，已跳过: {self.fixed_email}")

    @staticmethod
    def _message_id(mail: dict[str, Any]) -> str:
        explicit = _text(mail.get("id") or mail.get("message_id") or mail.get("internet_message_id"))
        if explicit:
            return explicit
        return "|".join(
            _text(mail.get(key))
            for key in ("folder", "date", "from", "subject", "body_preview")
            if _text(mail.get(key))
        )

    @staticmethod
    def _message_text(mail: dict[str, Any]) -> str:
        fields = (
            "subject",
            "body_preview",
            "preview",
            "summary",
            "text",
            "content",
            "body",
            "html",
            "from",
        )
        return _strip_markup(" ".join(_text(mail.get(field)) for field in fields))

    def _list_emails(self, account: MailboxAccount, runtime_keyword: str = "") -> list[dict[str, Any]]:
        payload = self._get_json("/api/external/emails", self._email_query_params(account, runtime_keyword))
        items = payload.get("emails")
        if not isinstance(items, list):
            items = payload.get("items") if isinstance(payload.get("items"), list) else []
        return [item for item in items if isinstance(item, dict)]

    def get_current_ids_strict(self, account: MailboxAccount) -> set:
        return {self._message_id(mail) for mail in self._list_emails(account) if self._message_id(mail)}

    def get_current_ids(self, account: MailboxAccount) -> set:
        return self.get_current_ids_strict(account)

    def _matches_keyword(self, mail: dict[str, Any], runtime_keyword: str = "") -> bool:
        text = self._message_text(mail).lower()
        for keyword in (self.email_keyword, _text(runtime_keyword)):
            if keyword and keyword.lower() not in text:
                return False
        return True

    def wait_for_code(
        self,
        account: MailboxAccount,
        keyword: str = "",
        timeout: int = 120,
        before_ids: set = None,
        code_pattern: str = None,
    ) -> str:
        seen = set(before_ids or [])
        pattern = re.compile(code_pattern or DEFAULT_CODE_PATTERN)
        started = time.time()
        last_error: Exception | None = None

        while time.time() - started < timeout:
            try:
                for mail in self._list_emails(account, runtime_keyword=keyword):
                    mid = self._message_id(mail)
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)
                    if not self._matches_keyword(mail, keyword):
                        continue
                    text = re.sub(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", " ", self._message_text(mail))
                    match = pattern.search(text)
                    if match:
                        return match.group(1) if match.groups() else match.group(0)
            except Exception as exc:  # noqa: BLE001
                last_error = exc
            time.sleep(self.poll_interval)

        message = f"等待验证码超时 ({timeout}s)"
        if last_error:
            message += f"，最后一次错误: {last_error}"
        raise TimeoutError(message)

    def wait_for_link(
        self,
        account: MailboxAccount,
        keyword: str = "",
        timeout: int = 120,
        before_ids: set = None,
    ) -> str:
        seen = set(before_ids or [])
        started = time.time()
        last_error: Exception | None = None

        while time.time() - started < timeout:
            try:
                for mail in self._list_emails(account, runtime_keyword=keyword):
                    mid = self._message_id(mail)
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)
                    link = _extract_verification_link(self._message_text(mail), keyword)
                    if link:
                        return link
            except Exception as exc:  # noqa: BLE001
                last_error = exc
            time.sleep(self.poll_interval)

        message = f"等待验证链接超时 ({timeout}s)"
        if last_error:
            message += f"，最后一次错误: {last_error}"
        raise TimeoutError(message)

    def _list_tags(self) -> list[dict[str, Any]]:
        payload = self._admin_get_json("/api/tags")
        tags = payload.get("tags")
        return [item for item in tags if isinstance(item, dict)] if isinstance(tags, list) else []

    def _get_or_create_tag_id(self, name: str) -> int:
        normalized = name.strip().lower()
        for tag in self._list_tags():
            if _text(tag.get("name")).lower() == normalized:
                return int(tag.get("id") or 0)
        payload = self._admin_post_json("/api/tags", {"name": name, "color": "#1a1a1a"})
        tag = payload.get("tag") if isinstance(payload.get("tag"), dict) else {}
        tag_id = int(tag.get("id") or 0)
        if tag_id <= 0:
            raise RuntimeError(f"outlookEmail 创建标签后未返回有效 ID: {name}")
        return tag_id

    def _resolve_account_id(self, *, email: str, account_id: str = "") -> int:
        try:
            numeric_id = int(str(account_id or "").strip())
        except (TypeError, ValueError):
            numeric_id = 0
        if numeric_id > 0:
            return numeric_id

        target = email.strip().lower()
        for item in self._list_accounts():
            if self._account_email(item).lower() == target:
                try:
                    return int(item.get("id") or 0)
                except (TypeError, ValueError):
                    return 0
        return 0

    def add_tags_to_account(self, *, email: str, account_id: str = "", tag_names: list[str] | None = None) -> list[str]:
        names = _split_names(tag_names or [])
        if not names:
            return []
        resolved_account_id = self._resolve_account_id(email=email, account_id=account_id)
        if resolved_account_id <= 0:
            raise RuntimeError(f"outlookEmail 未找到可打标签的账号 ID: {email}")

        applied: list[str] = []
        for name in names:
            tag_id = self._get_or_create_tag_id(name)
            if tag_id <= 0:
                continue
            self._admin_post_json(
                "/api/accounts/tags",
                {"account_ids": [resolved_account_id], "tag_id": tag_id, "action": "add"},
            )
            applied.append(name)
        return applied

    def mark_registration_success(self, account: MailboxAccount) -> list[str]:
        return self.add_tags_to_account(
            email=account.email,
            account_id=account.account_id,
            tag_names=self.register_success_tag_names,
        )

    def mark_plus_success(self, account: MailboxAccount) -> list[str]:
        return self.add_tags_to_account(
            email=account.email,
            account_id=account.account_id,
            tag_names=self.plus_success_tag_names,
        )
