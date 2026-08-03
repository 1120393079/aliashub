"""Mailbox pool backed by dispose.lol inbox links."""

from __future__ import annotations

import hashlib
import html
import re
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlparse

import requests

from core.base_mailbox import BaseMailbox, MailboxAccount, _extract_verification_link


DEFAULT_DISPOSE_API_BASE = "https://dispose.lol/api/inbox-link"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_INBOX_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


@dataclass(frozen=True)
class InboxLinkEntry:
    email: str
    inbox_key: str

    @property
    def email_key(self) -> str:
        return self.email.casefold()

    @property
    def resource_id(self) -> str:
        material = f"{self.email_key}\n{self.inbox_key}".encode("utf-8")
        return hashlib.sha256(material).hexdigest()[:20]

    @property
    def masked_link(self) -> str:
        return mask_inbox_link(self.inbox_key)


def mask_inbox_link(inbox_key: str) -> str:
    key = str(inbox_key or "")
    if len(key) <= 8:
        masked = "*" * len(key)
    else:
        masked = f"{key[:4]}...{key[-4:]}"
    return f"https://dispose.lol/ib/{masked}"


def _parse_inbox_link(raw_url: str, *, line_number: int) -> str:
    try:
        parsed = urlparse(str(raw_url or "").strip())
        port = parsed.port
    except Exception as exc:
        raise ValueError(f"第 {line_number} 行取件链接无效") from exc
    if (
        parsed.scheme.lower() != "https"
        or (parsed.hostname or "").lower() != "dispose.lol"
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"第 {line_number} 行必须使用 https://dispose.lol/ib/... 取件链接")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2 or parts[0] != "ib" or not _INBOX_KEY_RE.fullmatch(parts[1]):
        raise ValueError(f"第 {line_number} 行取件链接格式无效")
    return parts[1]


def parse_inbox_link_pool(text: str) -> list[InboxLinkEntry]:
    entries: list[InboxLinkEntry] = []
    seen_pairs: set[tuple[str, str]] = set()
    email_keys: dict[str, int] = {}
    inbox_keys: dict[str, int] = {}

    for line_number, raw_line in enumerate(str(text or "").splitlines(), start=1):
        line = raw_line.strip().strip("\ufeff")
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        parts = re.split(r"\s+", line)
        if len(parts) != 2:
            raise ValueError(f"第 {line_number} 行格式错误，应为：邮箱 空格 取件链接")
        email = parts[0].strip()
        if not _EMAIL_RE.fullmatch(email):
            raise ValueError(f"第 {line_number} 行邮箱格式无效")
        inbox_key = _parse_inbox_link(parts[1], line_number=line_number)
        pair = (email.casefold(), inbox_key)
        if pair in seen_pairs:
            continue
        if pair[0] in email_keys:
            raise ValueError(
                f"第 {line_number} 行邮箱与第 {email_keys[pair[0]]} 行重复，但取件链接不同"
            )
        if inbox_key in inbox_keys:
            raise ValueError(
                f"第 {line_number} 行取件链接与第 {inbox_keys[inbox_key]} 行重复，但邮箱不同"
            )
        seen_pairs.add(pair)
        email_keys[pair[0]] = line_number
        inbox_keys[inbox_key] = line_number
        entries.append(InboxLinkEntry(email=email, inbox_key=inbox_key))

    if not entries:
        raise ValueError("链接取件邮箱池为空，请按“邮箱 空格 取件链接”每行填写一组")
    return entries


class DisposeInboxLinkMailboxPool(BaseMailbox):
    """Allocate one dispose.lol inbox link to each registration worker."""

    def __init__(
        self,
        *,
        pool_text: str,
        poll_interval: float = 3,
        proxy: str | None = None,
        api_base: str = DEFAULT_DISPOSE_API_BASE,
    ):
        self._entries = parse_inbox_link_pool(pool_text)
        self._next_index = 0
        self._allocation_lock = threading.Lock()
        self._allocated: dict[str, InboxLinkEntry] = {}
        self.poll_interval = max(float(poll_interval or 3), 0.1)
        self.proxy = {"http": proxy, "https": proxy} if proxy else None
        self.api_base = str(api_base or DEFAULT_DISPOSE_API_BASE).rstrip("/")

    @classmethod
    def from_config(cls, config: dict) -> "DisposeInboxLinkMailboxPool":
        pool_text = str(config.get("dispose_inbox_link_pool_text") or "")
        if not pool_text.strip():
            provider_account = dict(config.get("provider_account") or {})
            credentials = dict(provider_account.get("credentials") or {})
            email = str(credentials.get("email") or provider_account.get("login_identifier") or "").strip()
            inbox_key = str(credentials.get("inbox_key") or "").strip()
            if email and _INBOX_KEY_RE.fullmatch(inbox_key):
                pool_text = f"{email} https://dispose.lol/ib/{inbox_key}"
        return cls(
            pool_text=pool_text,
            poll_interval=config.get("dispose_inbox_link_poll_interval", 3),
            proxy=config.get("proxy") or None,
        )

    @property
    def available_count(self) -> int:
        return len(self._entries)

    def get_email(self) -> MailboxAccount:
        with self._allocation_lock:
            if self._next_index >= len(self._entries):
                raise RuntimeError(f"链接取件邮箱池已用尽: total={len(self._entries)}")
            entry = self._entries[self._next_index]
            self._next_index += 1
            self._allocated[entry.email_key] = entry

        provider_name = "dispose_inbox_link"
        return MailboxAccount(
            email=entry.email,
            account_id=entry.resource_id,
            extra={
                "provider_account": {
                    "provider_type": "mailbox",
                    "provider_name": provider_name,
                    "login_identifier": entry.email,
                    "display_name": entry.email,
                    "credentials": {
                        "email": entry.email,
                        "inbox_key": entry.inbox_key,
                    },
                    "metadata": {
                        "source": "dispose_inbox_link",
                        "inbox_link": entry.masked_link,
                    },
                },
                "provider_resource": {
                    "provider_type": "mailbox",
                    "provider_name": provider_name,
                    "resource_type": "mailbox",
                    "resource_identifier": entry.resource_id,
                    "handle": entry.email,
                    "display_name": entry.email,
                    "metadata": {
                        "email": entry.email,
                        "source": "dispose_inbox_link",
                        "inbox_link": entry.masked_link,
                    },
                },
            },
        )

    def _entry_for_account(self, account: MailboxAccount) -> InboxLinkEntry:
        email_key = str(getattr(account, "email", "") or "").strip().casefold()
        entry = self._allocated.get(email_key)
        if entry is not None:
            return entry
        extra = dict(getattr(account, "extra", {}) or {})
        provider_account = dict(extra.get("provider_account") or {})
        credentials = dict(provider_account.get("credentials") or {})
        email = str(credentials.get("email") or getattr(account, "email", "") or "").strip()
        inbox_key = str(credentials.get("inbox_key") or "").strip()
        if _EMAIL_RE.fullmatch(email) and _INBOX_KEY_RE.fullmatch(inbox_key):
            return InboxLinkEntry(email=email, inbox_key=inbox_key)
        raise RuntimeError(f"链接取件邮箱缺少收件凭据: {getattr(account, 'email', '')}")

    def _request_json(self, entry: InboxLinkEntry, path: str, *, params: dict | None = None) -> dict:
        url = f"{self.api_base}/{entry.inbox_key}/{path.lstrip('/')}"
        try:
            response = requests.get(
                url,
                params=params,
                headers={"accept": "application/json"},
                proxies=self.proxy,
                timeout=20,
            )
        except requests.RequestException as exc:
            raise RuntimeError(
                f"链接取件服务请求失败 ({exc.__class__.__name__})"
            ) from None
        if response.status_code == 404:
            raise RuntimeError("链接取件地址不存在或已失效")
        if response.status_code == 410:
            raise RuntimeError("链接取件地址已过期")
        if response.status_code == 429:
            raise RuntimeError("链接取件服务请求过于频繁")
        if response.status_code >= 400:
            raise RuntimeError(f"链接取件服务返回 HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError:
            raise RuntimeError("链接取件服务返回了无效 JSON") from None
        if not isinstance(payload, dict):
            raise RuntimeError("链接取件服务返回格式无效")
        return payload

    def _messages(self, entry: InboxLinkEntry) -> list[dict]:
        payload = self._request_json(entry, "messages")
        address = str(payload.get("address") or "").strip()
        if address and address.casefold() != entry.email_key:
            raise RuntimeError("取件链接返回的邮箱与配置邮箱不一致")
        if payload.get("syncOk") is False:
            raise RuntimeError("链接取件服务同步邮箱失败")
        messages = payload.get("messages") or []
        if not isinstance(messages, list):
            raise RuntimeError("链接取件服务邮件列表格式无效")
        return [item for item in messages if isinstance(item, dict)]

    def _message_detail(self, entry: InboxLinkEntry, message_id: str) -> dict:
        payload = self._request_json(entry, "message", params={"id": message_id})
        message = payload.get("message") or {}
        if not isinstance(message, dict):
            raise RuntimeError("链接取件服务邮件详情格式无效")
        return message

    @staticmethod
    def _message_id(message: dict) -> str:
        return str(message.get("id") or "").strip()

    @staticmethod
    def _message_content(message: dict) -> str:
        return " ".join(
            str(message.get(key) or "")
            for key in ("subject", "sender", "from", "textBody", "htmlBody")
        )

    @classmethod
    def _message_text(cls, message: dict) -> str:
        combined = html.unescape(cls._message_content(message))
        combined = re.sub(r"<style[^>]*>.*?</style>", " ", combined, flags=re.I | re.S)
        combined = re.sub(r"<script[^>]*>.*?</script>", " ", combined, flags=re.I | re.S)
        combined = re.sub(r"<[^>]+>", " ", combined)
        combined = re.sub(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", " ", combined)
        return re.sub(r"\s+", " ", combined).strip()

    def _complete_message(self, entry: InboxLinkEntry, message: dict) -> dict:
        message_id = self._message_id(message)
        if message_id and message.get("hasDetail"):
            detail = self._message_detail(entry, message_id)
            merged = dict(message)
            merged.update(detail)
            return merged
        return message

    def get_current_ids_strict(self, account: MailboxAccount) -> set:
        entry = self._entry_for_account(account)
        return {
            message_id
            for message in self._messages(entry)
            if (message_id := self._message_id(message))
        }

    def get_current_ids(self, account: MailboxAccount) -> set:
        return self.get_current_ids_strict(account)

    def wait_for_code(
        self,
        account: MailboxAccount,
        keyword: str = "",
        timeout: int = 120,
        before_ids: set | None = None,
        code_pattern: str | None = None,
    ) -> str:
        entry = self._entry_for_account(account)
        seen = {str(item) for item in (before_ids or set())}
        pattern = re.compile(code_pattern or r"(?<!#)(?<!\d)(\d{6})(?!\d)")
        deadline = time.monotonic() + max(float(timeout or 0), 0.1)
        while time.monotonic() < deadline:
            for summary in self._messages(entry):
                message_id = self._message_id(summary)
                if message_id and message_id in seen:
                    continue
                message = self._complete_message(entry, summary)
                text = self._message_text(message)
                if message_id:
                    seen.add(message_id)
                if keyword and keyword.casefold() not in text.casefold():
                    continue
                match = pattern.search(text)
                if match:
                    return match.group(1) if match.groups() else match.group(0)
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(self.poll_interval, remaining))
        raise TimeoutError(f"等待验证码超时 ({timeout}s)")

    def wait_for_link(
        self,
        account: MailboxAccount,
        keyword: str = "",
        timeout: int = 120,
        before_ids: set | None = None,
    ) -> str:
        entry = self._entry_for_account(account)
        seen = {str(item) for item in (before_ids or set())}
        deadline = time.monotonic() + max(float(timeout or 0), 0.1)
        while time.monotonic() < deadline:
            for summary in self._messages(entry):
                message_id = self._message_id(summary)
                if message_id and message_id in seen:
                    continue
                message = self._complete_message(entry, summary)
                if message_id:
                    seen.add(message_id)
                link = _extract_verification_link(self._message_content(message), keyword)
                if link:
                    return link
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(self.poll_interval, remaining))
        raise TimeoutError(f"等待验证链接超时 ({timeout}s)")
