#!/usr/bin/env python3
import base64
import hashlib
import hmac
import http.cookiejar
import json
import os
import re
import secrets
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email import policy
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import parseaddr, parsedate_to_datetime
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener

from cryptography.fernet import Fernet, InvalidToken


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
EMAIL_RE = re.compile(r"^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,127}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$", re.IGNORECASE)
EMAIL_FIND_RE = re.compile(r"[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,127}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", re.IGNORECASE)
TOKEN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MESSAGE_ROUTE_RE = re.compile(r"^/api/public/mailbox/([^/]+)/messages/(\d+)$")
MAILBOX_ROUTE_RE = re.compile(r"^/api/public/mailbox/([^/]+)$")
LATEST_MESSAGE_ROUTE_RE = re.compile(r"^/api/public/mailbox/([^/]+)/(?:latest|first)$")
ADMIN_MAILBOX_ROUTE_RE = re.compile(r"^/api/admin/mailboxes/(\d+)$")
ADMIN_ROTATE_ROUTE_RE = re.compile(r"^/api/admin/mailboxes/(\d+)/rotate$")
ADMIN_LDXP_CARDS_ROUTE_RE = re.compile(r"^/api/admin/ldxp/cards$")
PICKUP_PATH_RE = re.compile(r"^/p/([^/]+)$")
PICKUP_QUERY_TOKEN_RE = re.compile(r"(?:[?&]token=)([^&#\s\"'<>]+)", re.IGNORECASE)

LDXP_DEFAULT_GOODS_ID = os.environ.get("PICKUP_LDXP_GOODS_ID", "0").strip() or "0"
LDXP_CARD_TEXT_FIELDS = (
    "card_content",
    "cardContent",
    "card_text",
    "cardText",
    "delivery_content",
    "deliveryContent",
    "delivery_text",
    "deliveryText",
    "card_info",
    "cardInfo",
    "card",
    "secret",
)
LDXP_CARD_LIST_FIELDS = ("cards", "card_list", "cardList", "goods_cards", "goodsCards", "details")
LDXP_CARD_ITEM_TEXT_FIELDS = LDXP_CARD_TEXT_FIELDS + ("content", "value", "secret")
LDXP_CARD_ID_FIELDS = ("card_id", "cardId", "id", "card_no", "cardNo")
LDXP_ORDER_ID_FIELDS = ("trade_no", "tradeNo", "order_id", "orderId", "order_no", "orderNo", "order_sn", "orderSn")
LDXP_GOODS_ID_FIELDS = ("goods_id", "goodsId", "product_id", "productId")
LDXP_SOLD_AT_FIELDS = ("success_time", "successTime", "paid_at", "paidAt", "pay_time", "payTime", "sold_at", "soldAt", "created_at", "createdAt")
BEIJING_TIMEZONE = timezone(timedelta(hours=8))


class LdxpAccessError(ValueError):
    pass


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def isoformat(value):
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return str(value)


def parse_datetime(value, naive_timezone=timezone.utc):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError, OverflowError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=naive_timezone)
    return parsed.astimezone(timezone.utc)


def parse_query_timestamp(value):
    text = str(value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"[0-9]{10}|[0-9]{13}", text):
        try:
            seconds = int(text) / (1000 if len(text) == 13 else 1)
            return datetime.fromtimestamp(seconds, timezone.utc)
        except (OverflowError, OSError, ValueError) as error:
            raise ValueError("timestamp 无效") from error
    parsed = parse_datetime(text, naive_timezone=BEIJING_TIMEZONE)
    if not parsed:
        raise ValueError("timestamp 无效")
    return parsed


def parse_api_datetime(value):
    try:
        return parse_query_timestamp(value)
    except ValueError:
        return None


def beijing_api_time(value, key=""):
    if value in (None, ""):
        return value
    parsed = parse_datetime(value, naive_timezone=BEIJING_TIMEZONE)
    if not parsed:
        return value
    localized = parsed.astimezone(BEIJING_TIMEZONE).replace(microsecond=0)
    if str(key) == "saved_at":
        return localized.strftime("%Y-%m-%d %H:%M:%S")
    return localized.isoformat()


def api_beijing_times(value, key=""):
    if isinstance(value, dict):
        return {item_key: api_beijing_times(item, item_key) for item_key, item in value.items()}
    if isinstance(value, list):
        return [api_beijing_times(item, key) for item in value]
    name = str(key or "")
    if name in {"time", "saved_at"} or name.endswith(("_at", "_time", "At", "Time")):
        return beijing_api_time(value, name)
    return value


def parse_ldxp_datetime(value):
    text = str(value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"[0-9]{10,13}", text):
        try:
            seconds = int(text)
            if len(text) == 13:
                seconds /= 1000
            return datetime.fromtimestamp(seconds, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        for pattern in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
            try:
                parsed = datetime.strptime(text, pattern)
                break
            except ValueError:
                parsed = None
        if parsed is None:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BEIJING_TIMEZONE)
    return parsed.astimezone(timezone.utc)


def decode_mime(value):
    try:
        return str(make_header(decode_header(str(value or ""))))
    except Exception:
        return str(value or "")


EMAIL_INVISIBLE_RE = re.compile(
    "[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f"
    "\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]"
)
EMAIL_WIDE_SPACE_RE = re.compile("[\u2000-\u200a\u202f\u205f\u3000]+")
EMAIL_IMAGE_MARKER_RE = re.compile(
    r"(?im)^[ \t]*\[(?:https?://|cid:)[^\]\r\n]+\.(?:avif|gif|jpe?g|png|svg|webp)"
    r"(?:\?[^\]\r\n]*)?\][ \t]*$"
)
EMAIL_URL_RE = re.compile(r"[<\[]?https?://[^\s<>\]]+[>\]]?", re.IGNORECASE)


def clean_email_text(value):
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    text = EMAIL_INVISIBLE_RE.sub("", text)
    text = EMAIL_WIDE_SPACE_RE.sub(" ", text)
    text = EMAIL_IMAGE_MARKER_RE.sub("", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def email_preview(value, limit=180):
    text = EMAIL_URL_RE.sub(" ", clean_email_text(value))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def b64url(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


class TextExtractor(HTMLParser):
    BREAK_TAGS = {"br", "div", "p", "li", "tr", "h1", "h2", "h3", "h4", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, _attrs):
        tag = tag.lower()
        if tag in {"script", "style", "svg", "form"}:
            self.skip_depth += 1
        elif not self.skip_depth and tag in self.BREAK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "style", "svg", "form"} and self.skip_depth:
            self.skip_depth -= 1
        elif not self.skip_depth and tag in self.BREAK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)

    def text(self):
        value = "".join(self.parts).replace("\r", "")
        value = re.sub(r"[ \t]+", " ", value)
        value = re.sub(r"\n[ \t]+", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip()


def html_to_text(value):
    parser = TextExtractor()
    try:
        parser.feed(str(value or ""))
        parser.close()
        return parser.text()
    except Exception:
        return re.sub(r"<[^>]+>", " ", str(value or "")).strip()


def message_text(message):
    plain_parts = []
    html_parts = []
    for part in message.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        content_type = part.get_content_type().lower()
        if content_type not in {"text/plain", "text/html"}:
            continue
        try:
            content = part.get_content()
        except Exception:
            payload = part.get_payload(decode=True) or b""
            content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        if content_type == "text/plain":
            plain_parts.append(str(content))
        else:
            html_parts.append(str(content))
    plain = "\n\n".join(plain_parts).strip()
    html = "\n".join(html_parts).strip()
    return clean_email_text(plain or html_to_text(html))


def parse_raw_message(raw_message, fallback_subject="", fallback_received_at=""):
    raw = str(raw_message or "")
    message = BytesParser(policy=policy.default).parsebytes(raw.encode("utf-8", errors="replace"))
    sender_name, sender_address = parseaddr(decode_mime(message.get("from", "")))
    received_at = parse_api_datetime(fallback_received_at) or parse_datetime(message.get("date")) or utc_now()
    return {
        "subject": decode_mime(message.get("subject", "")) or str(fallback_subject or ""),
        "sender_name": decode_mime(sender_name),
        "sender_address": str(sender_address or "").lower(),
        "text_body": message_text(message),
        "received_at": isoformat(received_at),
    }


def normalize_ldxp_goods_id(value):
    text = str(value or "").strip()
    if not re.fullmatch(r"[0-9]{1,64}", text):
        raise ValueError("链动小铺商品 ID 无效")
    return text


def normalize_external_source(value):
    text = str(value or "").strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", text):
        raise ValueError("外部库存来源无效")
    return text


def normalize_external_id(value):
    text = str(value or "").strip()
    if not text or len(text) > 160 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", text):
        raise ValueError("外部库存编号无效")
    return text


def normalize_ldxp_proxy_url(value):
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) > 2048:
        raise ValueError("访问代理地址过长")
    parsed = urlparse(text)
    if parsed.scheme.lower() not in {"http", "https", "socks5", "socks5h"} or not parsed.hostname:
        raise ValueError("访问代理地址无效")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("访问代理端口无效") from error
    if not port or port < 1 or port > 65535:
        raise ValueError("访问代理端口无效")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("访问代理地址无效")
    return text


def playwright_proxy_configuration(proxy_url):
    text = normalize_ldxp_proxy_url(proxy_url)
    if not text:
        return None
    parsed = urlparse(text)
    scheme = "socks5" if parsed.scheme.lower() == "socks5h" else parsed.scheme.lower()
    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    result = {"server": f"{scheme}://{host}:{parsed.port}"}
    if parsed.username is not None:
        result["username"] = unquote(parsed.username)
    if parsed.password is not None:
        result["password"] = unquote(parsed.password)
    return result


def ldxp_chromium_launch_options(profile_dir, headless, proxy_url=""):
    result = {
        "user_data_dir": str(profile_dir),
        "headless": bool(headless),
        "executable_path": os.environ.get("LDXP_CHROME_EXECUTABLE", "").strip(),
        "args": ["--disable-dev-shm-usage"],
        "user_agent": os.environ.get(
            "LDXP_BROWSER_USER_AGENT",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        ),
    }
    if not result["executable_path"]:
        result.pop("executable_path")
    proxy = playwright_proxy_configuration(proxy_url)
    if proxy:
        result["proxy"] = proxy
    return result


def validate_ldxp_success_payload(payload):
    if isinstance(payload, dict) and "code" in payload and payload.get("code") not in {1, "1", True}:
        raise LdxpAccessError("链动小铺授权失效或接口被拒绝，请检查 Merchant-Token、访问代理或白名单")
    return payload


def fernet_from_token_secret(token_secret):
    material = hashlib.sha256(str(token_secret).encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(material))


def _bounded_text(value, limit=100_000):
    if not isinstance(value, (str, int, float)):
        return ""
    return str(value).strip()[:limit]


def _first_text(mapping, names):
    if not isinstance(mapping, dict):
        return ""
    for name in names:
        text = _bounded_text(mapping.get(name))
        if text:
            return text
    return ""


def _remote_identifier(value, limit=200):
    text = _bounded_text(value, limit)
    return re.sub(r"\s+", " ", text)


def ldxp_order_id(order):
    return _remote_identifier(_first_text(order, LDXP_ORDER_ID_FIELDS))


def ldxp_order_goods_id(order):
    return _remote_identifier(_first_text(order, LDXP_GOODS_ID_FIELDS), 64)


def ldxp_card_digest(card_text):
    return hashlib.sha256(_bounded_text(card_text).encode("utf-8")).hexdigest()


def ldxp_card_summary(card_digest):
    return f"sha256:{str(card_digest)[:16]}"


def ldxp_order_sale_time(order):
    value = _first_text(order, LDXP_SOLD_AT_FIELDS)
    return isoformat(parse_ldxp_datetime(value) or utc_now())


def ldxp_order_card_details(order):
    if not isinstance(order, dict):
        return []
    details = []
    seen = set()

    def append_detail(content, card_id=""):
        text = _bounded_text(content)
        if not text:
            return
        remote_card_id = _remote_identifier(card_id)
        digest = ldxp_card_digest(text)
        key = remote_card_id or digest
        if key in seen:
            return
        seen.add(key)
        details.append({"remote_card_id": remote_card_id, "card_text": text, "card_digest": digest})

    for field in LDXP_CARD_LIST_FIELDS:
        value = order.get(field)
        if isinstance(value, (list, tuple)):
            for item in value:
                if isinstance(item, dict):
                    append_detail(
                        _first_text(item, LDXP_CARD_ITEM_TEXT_FIELDS),
                        _first_text(item, LDXP_CARD_ID_FIELDS),
                    )
                else:
                    append_detail(item)
        elif isinstance(value, str):
            append_detail(value)

    for field in LDXP_CARD_TEXT_FIELDS:
        append_detail(order.get(field), _first_text(order, LDXP_CARD_ID_FIELDS))
    return details


def extract_ldxp_orders(payload):
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for name in ("orders", "items", "list", "rows"):
        value = payload.get(name)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    data = payload.get("data")
    if isinstance(data, (dict, list)):
        nested = extract_ldxp_orders(data)
        if nested:
            return nested
    return [payload] if ldxp_order_id(payload) else []


def match_ldxp_card_detail(card_text, mailboxes, token_validator):
    by_id = {}
    by_token = {}
    by_email = {}
    for mailbox in mailboxes:
        mailbox_id = int(mailbox["id"])
        by_id[mailbox_id] = mailbox
        token_id = str(mailbox["token_id"] or "")
        email = str(mailbox["email"] or "").lower()
        if token_id:
            by_token[token_id] = mailbox_id
        if email:
            by_email[email] = mailbox_id

    matches = set()
    for raw_token in PICKUP_QUERY_TOKEN_RE.findall(str(card_text or "")):
        token_id = token_validator(unquote(raw_token))
        if token_id and token_id in by_token:
            matches.add(by_token[token_id])
    for candidate in EMAIL_FIND_RE.findall(str(card_text or "")):
        email = candidate.lower()
        if EMAIL_RE.fullmatch(email) and email in by_email:
            matches.add(by_email[email])
    if not matches:
        return {"match_status": "unknown", "mailbox": None}
    if len(matches) != 1:
        return {"match_status": "ambiguous", "mailbox": None}
    return {"match_status": "matched", "mailbox": by_id[matches.pop()]}


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    database_path: str
    domain: str
    public_base_url: str
    inbound_token: str
    token_secret: str
    admin_username: str
    admin_password: str
    alias_hub_database_path: str = "/var/lib/alias-hub/outlook-alias-hub.db"
    alias_hub_url: str = "http://127.0.0.1:4180"
    alias_hub_scan_seconds: int = 15
    retention_days: int = 30
    max_messages_per_mailbox: int = 200
    max_raw_bytes: int = 10 * 1024 * 1024

    @classmethod
    def from_env(cls):
        domain = os.environ.get("PICKUP_EMAIL_DOMAIN", "example.com").strip().lower()
        public_base_url = os.environ.get("PICKUP_PUBLIC_BASE_URL", "http://127.0.0.1:4190").rstrip("/")
        config = cls(
            host=os.environ.get("PICKUP_HOST", "127.0.0.1"),
            port=int(os.environ.get("PICKUP_PORT", "4190")),
            database_path=os.environ.get("PICKUP_DATABASE_PATH", "/var/lib/mail-pickup/mail-pickup.db"),
            domain=domain,
            public_base_url=public_base_url,
            inbound_token=os.environ.get("PICKUP_INBOUND_TOKEN") or os.environ.get("NF_EMAIL_RECORD_TOKEN", ""),
            token_secret=os.environ.get("PICKUP_TOKEN_SECRET") or os.environ.get("DATA_ENCRYPTION_KEY", ""),
            admin_username=os.environ.get("PICKUP_ADMIN_USERNAME") or os.environ.get("ADMIN_USERNAME", "admin"),
            admin_password=os.environ.get("PICKUP_ADMIN_PASSWORD") or os.environ.get("ADMIN_PASSWORD", ""),
            alias_hub_database_path=os.environ.get(
                "PICKUP_ALIAS_HUB_DATABASE_PATH", "/var/lib/alias-hub/outlook-alias-hub.db"
            ),
            alias_hub_url=os.environ.get(
                "PICKUP_ALIAS_HUB_URL", "http://127.0.0.1:4180"
            ).rstrip("/"),
            alias_hub_scan_seconds=max(5, int(os.environ.get("PICKUP_ALIAS_HUB_SCAN_SECONDS", "15"))),
            retention_days=max(1, int(os.environ.get("PICKUP_RETENTION_DAYS", "30"))),
            max_messages_per_mailbox=max(10, int(os.environ.get("PICKUP_MAX_MESSAGES", "200"))),
        )
        missing = []
        if len(config.inbound_token) < 20:
            missing.append("PICKUP_INBOUND_TOKEN/NF_EMAIL_RECORD_TOKEN")
        if len(config.token_secret) < 24:
            missing.append("PICKUP_TOKEN_SECRET/DATA_ENCRYPTION_KEY")
        if not config.admin_password:
            missing.append("PICKUP_ADMIN_PASSWORD/ADMIN_PASSWORD")
        if missing:
            raise RuntimeError("missing required configuration: " + ", ".join(missing))
        return config


class PickupStore:
    def __init__(self, config):
        self.config = config
        self.database_path = Path(config.database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._cleanup_lock = threading.Lock()
        self._last_cleanup = datetime.min.replace(tzinfo=timezone.utc)
        self._initialize()

    def connect(self):
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def _initialize(self):
        with self.connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS pickup_mailboxes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    token_id TEXT NOT NULL UNIQUE,
                    source_account_id INTEGER,
                    source_provider TEXT NOT NULL DEFAULT '',
                    source_email TEXT NOT NULL DEFAULT '',
                    account_password TEXT NOT NULL DEFAULT '',
                    access_token TEXT NOT NULL DEFAULT '',
                    label TEXT NOT NULL DEFAULT '',
                    extra TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'ready'
                        CHECK(status IN ('ready', 'sold', 'disabled')),
                    expires_at TEXT,
                    last_message_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_pickup_mailboxes_status
                    ON pickup_mailboxes(status, created_at DESC);

                CREATE TABLE IF NOT EXISTS pickup_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mailbox_id INTEGER NOT NULL REFERENCES pickup_mailboxes(id) ON DELETE CASCADE,
                    fingerprint TEXT NOT NULL UNIQUE,
                    sender_name TEXT NOT NULL DEFAULT '',
                    sender_address TEXT NOT NULL DEFAULT '',
                    subject TEXT NOT NULL DEFAULT '',
                    text_body TEXT NOT NULL DEFAULT '',
                    received_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_pickup_messages_mailbox_received
                    ON pickup_messages(mailbox_id, received_at DESC, id DESC);

                CREATE TABLE IF NOT EXISTS pickup_message_tombstones (
                    fingerprint TEXT PRIMARY KEY,
                    mailbox_id INTEGER NOT NULL REFERENCES pickup_mailboxes(id) ON DELETE CASCADE,
                    deleted_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_pickup_message_tombstones_mailbox
                    ON pickup_message_tombstones(mailbox_id);

                CREATE TABLE IF NOT EXISTS pickup_ldxp_config (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    goods_id TEXT NOT NULL DEFAULT '0',
                    merchant_token_encrypted TEXT NOT NULL DEFAULT '',
                    proxy_url_encrypted TEXT NOT NULL DEFAULT '',
                    poll_seconds INTEGER NOT NULL DEFAULT 30,
                    last_sync_at TEXT,
                    last_sync_status TEXT NOT NULL DEFAULT 'idle',
                    last_sync_error TEXT NOT NULL DEFAULT '',
                    last_sync_summary TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS pickup_sales (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL DEFAULT 'ldxp',
                    ldxp_card_id TEXT NOT NULL,
                    ldxp_trade_no TEXT NOT NULL DEFAULT '',
                    goods_id TEXT NOT NULL DEFAULT '',
                    mailbox_id INTEGER REFERENCES pickup_mailboxes(id) ON DELETE SET NULL,
                    card_digest TEXT NOT NULL,
                    card_summary TEXT NOT NULL,
                    match_status TEXT NOT NULL
                        CHECK(match_status IN ('matched', 'unknown', 'ambiguous', 'already_sold', 'disabled')),
                    sold_at TEXT,
                    received_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(provider, ldxp_card_id)
                );

                CREATE TABLE IF NOT EXISTS pickup_ldxp_uploads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mailbox_id INTEGER NOT NULL REFERENCES pickup_mailboxes(id) ON DELETE CASCADE,
                    goods_id TEXT NOT NULL,
                    goods_name TEXT NOT NULL DEFAULT '',
                    goods_category TEXT NOT NULL DEFAULT '',
                    card_digest TEXT NOT NULL,
                    remote_message TEXT NOT NULL DEFAULT '',
                    uploaded_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(mailbox_id, goods_id)
                );

                CREATE INDEX IF NOT EXISTS idx_pickup_ldxp_uploads_mailbox
                    ON pickup_ldxp_uploads(mailbox_id, uploaded_at DESC, id DESC);

                CREATE TABLE IF NOT EXISTS pickup_ldxp_external_cards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    external_id TEXT NOT NULL,
                    goods_id TEXT NOT NULL,
                    goods_name TEXT NOT NULL DEFAULT '',
                    goods_category TEXT NOT NULL DEFAULT '',
                    card_digest TEXT NOT NULL,
                    card_summary TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'listed'
                        CHECK(status IN ('listed', 'sold', 'disabled')),
                    ldxp_card_id TEXT NOT NULL DEFAULT '',
                    ldxp_trade_no TEXT NOT NULL DEFAULT '',
                    remote_message TEXT NOT NULL DEFAULT '',
                    listed_at TEXT NOT NULL,
                    sold_at TEXT,
                    updated_at TEXT NOT NULL,
                    UNIQUE(source, external_id, goods_id)
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_pickup_ldxp_external_card_digest
                    ON pickup_ldxp_external_cards(source, goods_id, card_digest);

                CREATE INDEX IF NOT EXISTS idx_pickup_ldxp_external_card_status
                    ON pickup_ldxp_external_cards(source, status, updated_at DESC);

                CREATE INDEX IF NOT EXISTS idx_pickup_sales_mailbox
                    ON pickup_sales(mailbox_id, sold_at DESC, id DESC);

                CREATE INDEX IF NOT EXISTS idx_pickup_sales_trade
                    ON pickup_sales(ldxp_trade_no, id DESC);

                CREATE TRIGGER IF NOT EXISTS prevent_deleted_pickup_message_restore
                BEFORE INSERT ON pickup_messages
                WHEN EXISTS (
                    SELECT 1 FROM pickup_message_tombstones
                    WHERE fingerprint = NEW.fingerprint
                )
                BEGIN
                    SELECT RAISE(IGNORE);
                END;
                """
            )
            columns = {row["name"] for row in db.execute("PRAGMA table_info(pickup_mailboxes)").fetchall()}
            for name, definition in {
                "source_account_id": "INTEGER",
                "source_provider": "TEXT NOT NULL DEFAULT ''",
                "source_email": "TEXT NOT NULL DEFAULT ''",
                "access_token": "TEXT NOT NULL DEFAULT ''",
                "sold_at": "TEXT",
                "ldxp_trade_no": "TEXT NOT NULL DEFAULT ''",
                "ldxp_card_digest": "TEXT NOT NULL DEFAULT ''",
                "hidden_at": "TEXT",
            }.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE pickup_mailboxes ADD COLUMN {name} {definition}")
            config_columns = {row["name"] for row in db.execute("PRAGMA table_info(pickup_ldxp_config)").fetchall()}
            for name, definition in {
                "poll_seconds": "INTEGER NOT NULL DEFAULT 30",
                "last_sync_at": "TEXT",
                "last_sync_status": "TEXT NOT NULL DEFAULT 'idle'",
                "last_sync_error": "TEXT NOT NULL DEFAULT ''",
                "last_sync_summary": "TEXT NOT NULL DEFAULT '{}'",
                "updated_at": "TEXT NOT NULL DEFAULT ''",
                "proxy_url_encrypted": "TEXT NOT NULL DEFAULT ''",
            }.items():
                if name not in config_columns:
                    db.execute(f"ALTER TABLE pickup_ldxp_config ADD COLUMN {name} {definition}")
            upload_columns = {row["name"] for row in db.execute("PRAGMA table_info(pickup_ldxp_uploads)").fetchall()}
            if "goods_category" not in upload_columns:
                db.execute("ALTER TABLE pickup_ldxp_uploads ADD COLUMN goods_category TEXT NOT NULL DEFAULT ''")
            db.execute(
                """
                INSERT OR IGNORE INTO pickup_ldxp_config
                    (id, goods_id, merchant_token_encrypted, proxy_url_encrypted, poll_seconds, last_sync_status,
                     last_sync_error, last_sync_summary, updated_at)
                VALUES (1, ?, '', '', 30, 'idle', '', '{}', ?)
                """,
                (LDXP_DEFAULT_GOODS_ID, isoformat(utc_now())),
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_pickup_mailboxes_ldxp_trade ON pickup_mailboxes(ldxp_trade_no)"
            )
            db.execute(
                """
                UPDATE pickup_mailboxes
                SET source_provider = 'cloudflare', source_email = email
                WHERE source_account_id IS NULL AND source_provider = ''
                  AND lower(email) LIKE ?
                """,
                (f"%@{self.config.domain}",),
            )

    def _ldxp_config_row(self, db):
        row = db.execute("SELECT * FROM pickup_ldxp_config WHERE id = 1").fetchone()
        if row:
            return row
        now = isoformat(utc_now())
        db.execute(
            """
            INSERT INTO pickup_ldxp_config
                (id, goods_id, merchant_token_encrypted, proxy_url_encrypted, poll_seconds, last_sync_status,
                 last_sync_error, last_sync_summary, updated_at)
            VALUES (1, ?, '', '', 30, 'idle', '', '{}', ?)
            """,
            (LDXP_DEFAULT_GOODS_ID, now),
        )
        return db.execute("SELECT * FROM pickup_ldxp_config WHERE id = 1").fetchone()

    def _ldxp_decrypt_secret(self, encrypted):
        text = str(encrypted or "")
        if not text:
            return ""
        try:
            return fernet_from_token_secret(self.config.token_secret).decrypt(text.encode("utf-8")).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError, ValueError):
            return ""

    def _ldxp_merchant_token(self, encrypted):
        return self._ldxp_decrypt_secret(encrypted)

    def _ldxp_proxy_url(self, encrypted):
        text = self._ldxp_decrypt_secret(encrypted)
        if not text:
            return ""
        try:
            return normalize_ldxp_proxy_url(text)
        except ValueError:
            return ""

    def _ldxp_sync_summary(self, value):
        if isinstance(value, dict):
            result = value
        else:
            try:
                result = json.loads(str(value or "{}"))
            except (TypeError, ValueError, json.JSONDecodeError):
                result = {}
        if not isinstance(result, dict):
            return {}
        allowed = {
            "fetched",
            "processed",
            "matched",
            "unknown",
            "ambiguous",
            "already_sold",
            "disabled",
            "duplicates",
            "skipped_other_goods",
            "skipped_without_cards",
            "detail_failures",
        }
        return {name: int(result.get(name) or 0) for name in allowed if isinstance(result.get(name), (int, float))}

    def _ldxp_public_configuration(self, row):
        token = self._ldxp_merchant_token(row["merchant_token_encrypted"])
        proxy_url = self._ldxp_proxy_url(row["proxy_url_encrypted"])
        return {
            "goods_id": str(row["goods_id"] or LDXP_DEFAULT_GOODS_ID),
            "poll_seconds": int(row["poll_seconds"] or 30),
            "merchant_token_configured": bool(token),
            "proxy_configured": bool(proxy_url),
            "browser_profile_configured": Path(
                os.environ.get("LDXP_PLAYWRIGHT_PROFILE_DIR", "/var/lib/mail-pickup/ldxp-browser")
            ).is_dir(),
            "inventory_endpoint": "https://www.ldxp.cn/merchantApi/goodsCardStorage/list",
            "order_info_endpoint": "https://www.ldxp.cn/merchantApi/Order/orderInfo",
            "last_sync_at": str(row["last_sync_at"] or ""),
            "last_sync_status": str(row["last_sync_status"] or "idle"),
            "last_sync_error": str(row["last_sync_error"] or ""),
            "last_sync_summary": self._ldxp_sync_summary(row["last_sync_summary"]),
            "updated_at": str(row["updated_at"] or ""),
        }

    def ldxp_configuration(self):
        with self.connect() as db:
            row = self._ldxp_config_row(db)
            return self._ldxp_public_configuration(row)

    def ldxp_private_configuration(self):
        with self.connect() as db:
            row = self._ldxp_config_row(db)
            token = self._ldxp_merchant_token(row["merchant_token_encrypted"])
            proxy_url = self._ldxp_proxy_url(row["proxy_url_encrypted"])
            goods_ids = [str(row["goods_id"] or LDXP_DEFAULT_GOODS_ID)]
            for item in db.execute(
                "SELECT DISTINCT goods_id FROM pickup_ldxp_uploads WHERE goods_id != '' ORDER BY goods_id"
            ).fetchall():
                goods_id = str(item["goods_id"] or "")
                if goods_id and goods_id not in goods_ids:
                    goods_ids.append(goods_id)
            for item in db.execute(
                "SELECT DISTINCT goods_id FROM pickup_ldxp_external_cards WHERE goods_id != '' ORDER BY goods_id"
            ).fetchall():
                goods_id = str(item["goods_id"] or "")
                if goods_id and goods_id not in goods_ids:
                    goods_ids.append(goods_id)
        if not token:
            raise ValueError("请先配置链动小铺 Merchant-Token")
        return {
            "goods_id": str(row["goods_id"] or LDXP_DEFAULT_GOODS_ID),
            "goods_ids": goods_ids,
            "poll_seconds": int(row["poll_seconds"] or 30),
            "merchant_token": token,
            "proxy_url": proxy_url,
        }

    def update_ldxp_configuration(self, values):
        if not isinstance(values, dict):
            raise ValueError("链动小铺配置无效")
        assignments = []
        params = []
        if "goods_id" in values:
            assignments.append("goods_id = ?")
            params.append(normalize_ldxp_goods_id(values.get("goods_id")))
        if "poll_seconds" in values:
            try:
                poll_seconds = int(values.get("poll_seconds"))
            except (TypeError, ValueError) as error:
                raise ValueError("同步间隔无效") from error
            if poll_seconds < 10 or poll_seconds > 3600:
                raise ValueError("同步间隔需在 10 到 3600 秒之间")
            assignments.append("poll_seconds = ?")
            params.append(poll_seconds)
        if bool(values.get("clear_merchant_token")):
            assignments.append("merchant_token_encrypted = ''")
        elif "merchant_token" in values:
            token = _bounded_text(values.get("merchant_token"), 8192)
            if token:
                encrypted = fernet_from_token_secret(self.config.token_secret).encrypt(token.encode("utf-8")).decode("utf-8")
                assignments.append("merchant_token_encrypted = ?")
                params.append(encrypted)
        if bool(values.get("clear_proxy_url")):
            assignments.append("proxy_url_encrypted = ''")
        elif "proxy_url" in values:
            proxy_url = normalize_ldxp_proxy_url(values.get("proxy_url"))
            if proxy_url:
                encrypted = fernet_from_token_secret(self.config.token_secret).encrypt(proxy_url.encode("utf-8")).decode("utf-8")
                assignments.append("proxy_url_encrypted = ?")
                params.append(encrypted)
        if assignments:
            assignments.append("updated_at = ?")
            params.append(isoformat(utc_now()))
            with self.connect() as db:
                self._ldxp_config_row(db)
                db.execute(f"UPDATE pickup_ldxp_config SET {', '.join(assignments)} WHERE id = 1", params)
        return self.ldxp_status()

    def set_ldxp_sync_state(self, status, summary=None, error=""):
        safe_status = str(status or "idle")[:32]
        safe_error = str(error or "")[:160]
        safe_summary = self._ldxp_sync_summary(summary or {})
        with self.connect() as db:
            self._ldxp_config_row(db)
            db.execute(
                """
                UPDATE pickup_ldxp_config
                SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?,
                    last_sync_summary = ?, updated_at = ?
                WHERE id = 1
                """,
                (
                    isoformat(utc_now()),
                    safe_status,
                    safe_error,
                    json.dumps(safe_summary, ensure_ascii=True, separators=(",", ":")),
                    isoformat(utc_now()),
                ),
            )

    def ldxp_status(self):
        with self.connect() as db:
            row = self._ldxp_config_row(db)
            counts = {
                "total": 0,
                "matched": 0,
                "unknown": 0,
                "ambiguous": 0,
                "already_sold": 0,
                "disabled": 0,
            }
            for item in db.execute("SELECT match_status, COUNT(*) AS count FROM pickup_sales WHERE provider = 'ldxp' GROUP BY match_status"):
                counts[item["match_status"]] = int(item["count"])
                counts["total"] += int(item["count"])
            upload = db.execute(
                """
                SELECT goods_id, goods_name, goods_category, COUNT(*) AS count,
                       MAX(uploaded_at) AS last_uploaded_at
                FROM pickup_ldxp_uploads
                GROUP BY goods_id, goods_name, goods_category
                ORDER BY MAX(uploaded_at) DESC
                LIMIT 1
                """
            ).fetchone()
        uploads = {
            "count": int(upload["count"]) if upload else 0,
            "goods_id": str(upload["goods_id"] or "") if upload else "",
            "goods_name": str(upload["goods_name"] or "") if upload else "",
            "goods_category": str(upload["goods_category"] or "") if upload else "",
            "last_uploaded_at": str(upload["last_uploaded_at"] or "") if upload else "",
        }
        return {**self._ldxp_public_configuration(row), "sales": counts, "uploads": uploads}

    def ldxp_upload_candidates(self, ids, goods_id):
        if not isinstance(ids, list):
            raise ValueError("请选择要上货的账号")
        normalized_ids = sorted({int(value) for value in ids if str(value).isdigit()})
        if not normalized_ids:
            raise ValueError("请选择要上货的账号")
        if len(normalized_ids) > 500:
            raise ValueError("单次最多上货 500 个账号")
        normalized_goods_id = normalize_ldxp_goods_id(goods_id)
        placeholders = ",".join("?" for _ in normalized_ids)
        with self.connect() as db:
            rows = db.execute(
                f"""
                SELECT m.*
                FROM pickup_mailboxes m
                LEFT JOIN pickup_ldxp_uploads u
                  ON u.mailbox_id = m.id AND u.goods_id = ?
                WHERE m.id IN ({placeholders})
                  AND m.hidden_at IS NULL
                  AND m.status = 'ready'
                  AND u.id IS NULL
                ORDER BY m.id
                """,
                [normalized_goods_id, *normalized_ids],
            ).fetchall()
        items = [self.serialize_admin_mailbox(row) for row in rows]
        return {"items": items, "selected": len(normalized_ids), "skipped": len(normalized_ids) - len(items)}

    def record_ldxp_uploads(self, mailbox_ids, goods_id, goods_name="", goods_category="", remote_message=""):
        normalized_ids = sorted({int(value) for value in mailbox_ids if str(value).isdigit()})
        if not normalized_ids:
            return 0
        normalized_goods_id = normalize_ldxp_goods_id(goods_id)
        safe_goods_name = _bounded_text(goods_name, 300)
        safe_goods_category = _bounded_text(goods_category, 300)
        safe_message = _bounded_text(remote_message, 1000)
        now = isoformat(utc_now())
        recorded = 0
        with self.connect() as db:
            for mailbox_id in normalized_ids:
                row = db.execute(
                    "SELECT * FROM pickup_mailboxes WHERE id = ? AND hidden_at IS NULL",
                    (mailbox_id,),
                ).fetchone()
                if not row:
                    continue
                digest = ldxp_card_digest(self._delivery_line(row))
                cursor = db.execute(
                    """
                    INSERT INTO pickup_ldxp_uploads
                        (mailbox_id, goods_id, goods_name, goods_category, card_digest,
                         remote_message, uploaded_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(mailbox_id, goods_id) DO NOTHING
                    """,
                    (
                        mailbox_id,
                        normalized_goods_id,
                        safe_goods_name,
                        safe_goods_category,
                        digest,
                        safe_message,
                        now,
                        now,
                    ),
                )
                recorded += int(cursor.rowcount or 0)
        return recorded

    def record_external_card_uploads(
        self,
        source,
        items,
        goods_id,
        goods_name="",
        goods_category="",
        remote_message="",
    ):
        normalized_source = normalize_external_source(source)
        normalized_goods_id = normalize_ldxp_goods_id(goods_id)
        safe_goods_name = _bounded_text(goods_name, 300)
        safe_goods_category = _bounded_text(goods_category, 300)
        safe_message = _bounded_text(remote_message, 1000)
        now = isoformat(utc_now())
        recorded = 0
        with self.connect() as db:
            for item in items:
                external_id = normalize_external_id(item.get("external_id"))
                content = _bounded_text(item.get("content"), 50_000)
                if not content:
                    raise ValueError("上货卡密内容不能为空")
                digest = ldxp_card_digest(content)
                cursor = db.execute(
                    """
                    INSERT INTO pickup_ldxp_external_cards
                        (source, external_id, goods_id, goods_name, goods_category,
                         card_digest, card_summary, status, remote_message, listed_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'listed', ?, ?, ?)
                    ON CONFLICT(source, external_id, goods_id) DO NOTHING
                    """,
                    (
                        normalized_source,
                        external_id,
                        normalized_goods_id,
                        safe_goods_name,
                        safe_goods_category,
                        digest,
                        ldxp_card_summary(digest),
                        safe_message,
                        now,
                        now,
                    ),
                )
                recorded += int(cursor.rowcount or 0)
        return recorded

    def list_external_cards(self, source, goods_id="", status=""):
        normalized_source = normalize_external_source(source)
        clauses = ["source = ?"]
        params = [normalized_source]
        if goods_id:
            clauses.append("goods_id = ?")
            params.append(normalize_ldxp_goods_id(goods_id))
        if status:
            if status not in {"listed", "sold", "disabled"}:
                raise ValueError("库存状态无效")
            clauses.append("status = ?")
            params.append(status)
        with self.connect() as db:
            rows = db.execute(
                f"""
                SELECT source, external_id, goods_id, goods_name, goods_category, status,
                       ldxp_card_id, ldxp_trade_no, listed_at, sold_at, updated_at
                FROM pickup_ldxp_external_cards
                WHERE {' AND '.join(clauses)}
                ORDER BY id DESC
                LIMIT 5000
                """,
                params,
            ).fetchall()
        return {"items": [dict(row) for row in rows]}

    def _external_card_by_digest(self, db, goods_id, card_digest):
        rows = db.execute(
            """
            SELECT * FROM pickup_ldxp_external_cards
            WHERE goods_id = ? AND card_digest = ?
            ORDER BY id
            LIMIT 2
            """,
            (normalize_ldxp_goods_id(goods_id), card_digest),
        ).fetchall()
        return rows[0] if len(rows) == 1 else None

    def _ldxp_mailboxes(self, db):
        return db.execute(
            "SELECT id, email, token_id, status, sold_at, ldxp_trade_no, ldxp_card_digest FROM pickup_mailboxes"
        ).fetchall()

    def _record_ldxp_sale(self, *, ldxp_card_id, card_text, goods_id, ldxp_trade_no="", sold_at=""):
        card_digest = ldxp_card_digest(card_text)
        card_id = _remote_identifier(ldxp_card_id) or f"sha256:{card_digest}"
        trade_no = _remote_identifier(ldxp_trade_no)
        normalized_goods_id = normalize_ldxp_goods_id(goods_id or LDXP_DEFAULT_GOODS_ID)
        normalized_sold_at = isoformat(parse_ldxp_datetime(sold_at) or utc_now())
        now = isoformat(utc_now())
        with self.connect() as db:
            mailboxes = self._ldxp_mailboxes(db)
            match = match_ldxp_card_detail(card_text, mailboxes, self.validate_token)
            mailbox = match["mailbox"]
            match_status = match["match_status"]
            mailbox_id = int(mailbox["id"]) if mailbox else None
            external_card = None
            if not mailbox:
                external_card = self._external_card_by_digest(db, normalized_goods_id, card_digest)
                if external_card:
                    match_status = "matched"
            if mailbox:
                if mailbox["status"] == "sold":
                    match_status = "already_sold"
                elif mailbox["status"] == "disabled":
                    match_status = "disabled"
            existing = db.execute(
                "SELECT * FROM pickup_sales WHERE provider = 'ldxp' AND ldxp_card_id = ?",
                (card_id,),
            ).fetchone()
            if existing:
                if existing["match_status"] == "matched":
                    match_status = "matched"
                    mailbox_id = existing["mailbox_id"]
                elif existing["mailbox_id"]:
                    mailbox_id = existing["mailbox_id"]
                db.execute(
                    """
                    UPDATE pickup_sales
                    SET ldxp_trade_no = COALESCE(NULLIF(?, ''), ldxp_trade_no),
                        goods_id = ?, mailbox_id = ?, card_digest = ?, card_summary = ?,
                        match_status = ?, sold_at = COALESCE(sold_at, ?), updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        trade_no,
                        normalized_goods_id,
                        mailbox_id,
                        card_digest,
                        ldxp_card_summary(card_digest),
                        match_status,
                        normalized_sold_at,
                        now,
                        existing["id"],
                    ),
                )
                duplicate = True
            else:
                db.execute(
                    """
                    INSERT INTO pickup_sales
                        (provider, ldxp_card_id, ldxp_trade_no, goods_id, mailbox_id,
                         card_digest, card_summary, match_status, sold_at, received_at, updated_at)
                    VALUES ('ldxp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        card_id,
                        trade_no,
                        normalized_goods_id,
                        mailbox_id,
                        card_digest,
                        ldxp_card_summary(card_digest),
                        match_status,
                        normalized_sold_at,
                        now,
                        now,
                    ),
                )
                duplicate = False
            if match_status == "matched" and mailbox_id:
                db.execute(
                    """
                    UPDATE pickup_mailboxes
                    SET status = 'sold', sold_at = ?, ldxp_trade_no = ?, ldxp_card_digest = ?, updated_at = ?
                    WHERE id = ? AND status = 'ready'
                    """,
                    (normalized_sold_at, trade_no, card_digest, now, mailbox_id),
                )
            elif mailbox_id and trade_no:
                db.execute(
                    """
                    UPDATE pickup_mailboxes
                    SET ldxp_trade_no = COALESCE(NULLIF(ldxp_trade_no, ''), ?),
                        ldxp_card_digest = COALESCE(NULLIF(ldxp_card_digest, ''), ?),
                        sold_at = COALESCE(sold_at, ?), updated_at = ?
                    WHERE id = ?
                    """,
                    (trade_no, card_digest, normalized_sold_at, now, mailbox_id),
                )
            if external_card:
                db.execute(
                    """
                    UPDATE pickup_ldxp_external_cards
                    SET status = 'sold', ldxp_card_id = ?,
                        ldxp_trade_no = COALESCE(NULLIF(?, ''), ldxp_trade_no),
                        sold_at = COALESCE(sold_at, ?), updated_at = ?
                    WHERE id = ? AND status != 'disabled'
                    """,
                    (card_id, trade_no, normalized_sold_at, now, external_card["id"]),
                )
        return {
            "match_status": match_status,
            "duplicate": duplicate,
            "ldxp_card_id": card_id,
            "ldxp_trade_no": trade_no,
            "card_digest": card_digest,
        }

    def record_ldxp_inventory_card(self, card, goods_id=None):
        if not isinstance(card, dict):
            return {"match_status": "unknown", "duplicate": False, "skipped": True}
        status = _first_text(card, ("status",))
        if status != "1":
            return {"match_status": "unknown", "duplicate": False, "skipped": True}
        card_text = _first_text(card, ("secret",) + LDXP_CARD_ITEM_TEXT_FIELDS)
        if not card_text:
            return {"match_status": "unknown", "duplicate": False, "skipped": True}
        sold_at = _first_text(card, ("success_time", "successTime", "sold_at", "soldAt", "create_time", "createTime"))
        return self._record_ldxp_sale(
            ldxp_card_id=_first_text(card, LDXP_CARD_ID_FIELDS),
            card_text=card_text,
            goods_id=goods_id or _first_text(card, LDXP_GOODS_ID_FIELDS) or LDXP_DEFAULT_GOODS_ID,
            ldxp_trade_no=_first_text(card, ("trade_no", "tradeNo", "order_no", "orderNo")),
            sold_at=sold_at,
        )

    def record_ldxp_order(self, order, goods_id=None):
        order_id = ldxp_order_id(order)
        if not order_id:
            return {"processed": 0, "skipped_without_cards": 1}
        expected_goods_id = normalize_ldxp_goods_id(goods_id or LDXP_DEFAULT_GOODS_ID)
        order_goods_id = ldxp_order_goods_id(order)
        if order_goods_id and order_goods_id != expected_goods_id:
            return {"processed": 0, "skipped_other_goods": 1}
        details = ldxp_order_card_details(order)
        if not details:
            return {"processed": 0, "skipped_without_cards": 1}
        result = {
            "processed": 0,
            "matched": 0,
            "unknown": 0,
            "ambiguous": 0,
            "already_sold": 0,
            "disabled": 0,
            "duplicates": 0,
        }
        sold_at = ldxp_order_sale_time(order)
        for detail in details:
            outcome = self._record_ldxp_sale(
                ldxp_card_id=detail["remote_card_id"] or f"{order_id}:{detail['card_digest']}",
                card_text=detail["card_text"],
                goods_id=expected_goods_id,
                ldxp_trade_no=order_id,
                sold_at=sold_at,
            )
            result["processed"] += 1
            result[outcome["match_status"]] += 1
            result["duplicates"] += int(outcome["duplicate"])
        return result

    def record_ldxp_orders(self, orders, goods_id=None):
        result = {
            "processed": 0,
            "matched": 0,
            "unknown": 0,
            "ambiguous": 0,
            "already_sold": 0,
            "disabled": 0,
            "duplicates": 0,
            "skipped_other_goods": 0,
            "skipped_without_cards": 0,
        }
        for order in orders:
            outcome = self.record_ldxp_order(order, goods_id)
            for key in result:
                result[key] += int(outcome.get(key) or 0)
        return result

    def normalize_email(self, value):
        text = str(value or "").strip().lower()
        if len(text) > 320 or not EMAIL_RE.fullmatch(text):
            raise ValueError("邮箱格式无效")
        return text

    def alias_hub_connect(self):
        path = Path(self.config.alias_hub_database_path)
        if not path.is_file():
            raise ValueError("AliasHub 数据库不存在")
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def resolve_source_account(self, email):
        normalized = self.normalize_email(email)
        if normalized.endswith(f"@{self.config.domain}"):
            return None
        local, domain = normalized.rsplit("@", 1)
        candidates = [normalized]
        if "+" in local:
            candidates.append(f"{local.split('+', 1)[0]}@{domain}")
        with self.alias_hub_connect() as db:
            for candidate in candidates:
                row = db.execute(
                    """
                    SELECT s.id, s.provider, s.email, s.status
                    FROM source_accounts s
                    LEFT JOIN addresses a ON a.account_id = s.id
                    WHERE lower(s.email) = lower(?) OR lower(a.address) = lower(?)
                    ORDER BY CASE WHEN s.status = 'connected' THEN 0 ELSE 1 END, s.id
                    LIMIT 1
                    """,
                    (candidate, candidate),
                ).fetchone()
                if row:
                    if row["status"] != "connected":
                        raise ValueError(f"源邮箱 {row['email']} 当前未连接")
                    return dict(row)
            provider = "icloud" if domain in {"icloud.com", "me.com", "mac.com"} else ""
            if provider:
                rows = db.execute(
                    "SELECT id, provider, email, status FROM source_accounts WHERE provider = ? AND status = 'connected'",
                    (provider,),
                ).fetchall()
                if len(rows) == 1:
                    return dict(rows[0])
        raise ValueError(f"邮箱 {normalized} 不在 AliasHub 地址仓库中，无法同步验证码")

    def _token_signature(self, token_id):
        digest = hmac.new(self.config.token_secret.encode("utf-8"), token_id.encode("ascii"), hashlib.sha256).digest()
        return b64url(digest)

    def make_token(self, token_id):
        return f"{token_id}.{self._token_signature(token_id)}"

    def validate_token(self, token):
        text = str(token or "")
        if text.count(".") != 1:
            return ""
        token_id, signature = text.split(".", 1)
        if not TOKEN_ID_RE.fullmatch(token_id):
            return ""
        if not hmac.compare_digest(signature, self._token_signature(token_id)):
            return ""
        return token_id

    def pickup_url(self, token_id):
        return f"{self.config.public_base_url}/?token={quote(self.make_token(token_id), safe='._-')}"

    def pickup_api_url(self, token_id, email):
        return (
            f"{self.config.public_base_url}/api/query.php"
            f"?mail={quote(str(email), safe='')}"
            f"&pwd={quote(self.make_token(token_id), safe='._-')}&limit=1"
        )

    def _delivery_line(self, row):
        pickup_url = self.pickup_url(row["token_id"])
        password = str(row["account_password"] or "")
        if not password:
            return f"{row['email']} {pickup_url}"
        return f"账号：{row['email']}----密码：{password}----取件链接：{pickup_url}"

    def serialize_admin_mailbox(self, row):
        result = dict(row)
        result["pickup_url"] = self.pickup_url(row["token_id"])
        result["pickup_api_url"] = self.pickup_api_url(row["token_id"], row["email"])
        result["delivery_line"] = self._delivery_line(row)
        return result

    def create_mailboxes(
        self,
        items=None,
        count=0,
        prefix="account",
        expires_days=0,
        upsert=False,
        clear_credentials=False,
        allow_unbound=False,
        relist=False,
    ):
        if relist and not upsert:
            raise ValueError("重新上架必须同时启用 upsert")
        normalized = []
        items = items or []
        if count:
            count = min(max(int(count), 1), 500)
            safe_prefix = re.sub(r"[^a-z0-9_-]+", "-", str(prefix or "account").lower()).strip("-_")[:20] or "account"
            for _ in range(count):
                local = f"{safe_prefix}-{secrets.token_hex(5)}"
                normalized.append({"email": f"{local}@{self.config.domain}", "password": "", "access_token": "", "label": "", "extra": ""})
        else:
            if not isinstance(items, list) or not items:
                raise ValueError("请至少提供一个邮箱或生成数量")
            if len(items) > 500:
                raise ValueError("单次最多创建 500 个邮箱")
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("邮箱记录格式无效")
                normalized.append(
                    {
                        "email": self.normalize_email(item.get("email")),
                        "password": str(item.get("password") or "")[:500],
                        "access_token": str(item.get("access_token") or "")[:100_000],
                        "label": str(item.get("label") or "")[:200],
                        "extra": str(item.get("extra") or "")[:2000],
                    }
                )
        emails = [self.normalize_email(item["email"]) for item in normalized]
        if len(set(emails)) != len(emails):
            raise ValueError("提交内容中存在重复邮箱")
        sources = []
        for email in emails:
            try:
                sources.append(self.resolve_source_account(email))
            except ValueError:
                if not allow_unbound:
                    raise
                sources.append({"id": None, "provider": "unbound", "email": email})
        now = utc_now()
        expires_at = isoformat(now + timedelta(days=int(expires_days))) if int(expires_days or 0) > 0 else None
        created_ids = []
        try:
            with self.connect() as db:
                for item, email, source in zip(normalized, emails, sources):
                    existing = db.execute("SELECT * FROM pickup_mailboxes WHERE email = ?", (email,)).fetchone()
                    if existing and upsert:
                        restore_archived = False
                        if relist and existing["hidden_at"]:
                            if existing["status"] != "sold":
                                raise ValueError(f"邮箱 {email} 的归档状态异常，不能自动重新上架")
                            sale_evidence = any(
                                str(existing[field] or "").strip()
                                for field in ("sold_at", "ldxp_trade_no", "ldxp_card_digest")
                            )
                            if sale_evidence:
                                raise ValueError(f"邮箱 {email} 已有销售记录，不能自动重新上架")
                            restore_archived = True
                        elif relist and existing["status"] in {"sold", "disabled"}:
                            raise ValueError(f"邮箱 {email} 当前状态为 {existing['status']}，不能自动重新上架")
                        account_password = "" if clear_credentials else item["password"] or existing["account_password"]
                        access_token = "" if clear_credentials else item["access_token"] or existing["access_token"]
                        preserve_source = source and source["provider"] == "unbound" and existing["source_account_id"]
                        db.execute(
                            """
                            UPDATE pickup_mailboxes SET
                                source_account_id = ?, source_provider = ?, source_email = ?,
                                account_password = ?, access_token = ?, label = ?, extra = ?,
                                expires_at = COALESCE(?, expires_at), updated_at = ?
                            WHERE id = ?
                            """,
                            (
                                existing["source_account_id"] if preserve_source else source["id"] if source else None,
                                existing["source_provider"] if preserve_source else source["provider"] if source else "cloudflare",
                                existing["source_email"] if preserve_source else source["email"] if source else email,
                                account_password,
                                access_token,
                                item["label"] or existing["label"],
                                item["extra"] or existing["extra"],
                                expires_at,
                                isoformat(now),
                                existing["id"],
                            ),
                        )
                        if restore_archived:
                            db.execute(
                                """
                                UPDATE pickup_mailboxes
                                SET status = 'ready', sold_at = NULL, ldxp_trade_no = '',
                                    ldxp_card_digest = '', hidden_at = NULL, updated_at = ?
                                WHERE id = ?
                                """,
                                (isoformat(now), existing["id"]),
                            )
                        created_ids.append(existing["id"])
                        continue
                    cursor = db.execute(
                        """
                        INSERT INTO pickup_mailboxes
                            (email, token_id, source_account_id, source_provider, source_email,
                             account_password, access_token, label, extra, status, expires_at, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
                        """,
                        (
                            email,
                            secrets.token_urlsafe(18),
                            source["id"] if source else None,
                            source["provider"] if source else "cloudflare",
                            source["email"] if source else email,
                            item["password"],
                            item["access_token"],
                            item["label"],
                            item["extra"],
                            expires_at,
                            isoformat(now),
                            isoformat(now),
                        ),
                    )
                    created_ids.append(cursor.lastrowid)
                placeholders = ",".join("?" for _ in created_ids)
                rows = db.execute(
                    f"""
                    SELECT m.*, 0 AS message_count
                    FROM pickup_mailboxes m
                    WHERE m.id IN ({placeholders})
                    ORDER BY m.id
                    """,
                    created_ids,
                ).fetchall()
        except sqlite3.IntegrityError as error:
            if "email" in str(error).lower() or "unique" in str(error).lower():
                raise ValueError("邮箱已存在") from error
            raise
        return [self.serialize_admin_mailbox(row) for row in rows]

    def list_mailboxes(self, query="", status=""):
        clauses = ["m.hidden_at IS NULL"]
        values = []
        query = str(query or "").strip()
        status = str(status or "").strip()
        if query:
            clauses.append("(m.email LIKE ? OR m.label LIKE ? OR m.extra LIKE ?)")
            wildcard = f"%{query}%"
            values.extend([wildcard, wildcard, wildcard])
        if status in {"ready", "sold", "disabled"}:
            clauses.append("m.status = ?")
            values.append(status)
        where = "WHERE " + " AND ".join(clauses) if clauses else ""
        with self.connect() as db:
            rows = db.execute(
                f"""
                SELECT m.*, COUNT(msg.id) AS message_count,
                       (SELECT u.goods_id FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_goods_id,
                       (SELECT u.goods_name FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_goods_name,
                       (SELECT u.goods_category FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_goods_category,
                       (SELECT u.uploaded_at FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_at
                FROM pickup_mailboxes m
                LEFT JOIN pickup_messages msg ON msg.mailbox_id = m.id
                {where}
                GROUP BY m.id
                ORDER BY m.id DESC
                LIMIT 1000
                """,
                values,
            ).fetchall()
            stats_rows = db.execute(
                "SELECT status, COUNT(*) AS count FROM pickup_mailboxes WHERE hidden_at IS NULL GROUP BY status"
            ).fetchall()
        stats = {"total": 0, "ready": 0, "sold": 0, "disabled": 0}
        for item in stats_rows:
            stats[item["status"]] = item["count"]
            stats["total"] += item["count"]
        return {"items": [self.serialize_admin_mailbox(row) for row in rows], "stats": stats}

    def get_admin_mailbox(self, mailbox_id, db=None):
        owns_connection = db is None
        connection = db or self.connect()
        try:
            row = connection.execute(
                """
                SELECT m.*, COUNT(msg.id) AS message_count,
                       (SELECT u.goods_id FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_goods_id,
                       (SELECT u.goods_name FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_goods_name,
                       (SELECT u.goods_category FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_goods_category,
                       (SELECT u.uploaded_at FROM pickup_ldxp_uploads u
                        WHERE u.mailbox_id = m.id ORDER BY u.uploaded_at DESC, u.id DESC LIMIT 1)
                           AS ldxp_listed_at
                FROM pickup_mailboxes m
                LEFT JOIN pickup_messages msg ON msg.mailbox_id = m.id
                WHERE m.id = ?
                GROUP BY m.id
                """,
                (int(mailbox_id),),
            ).fetchone()
            if not row:
                raise KeyError("邮箱不存在")
            return self.serialize_admin_mailbox(row)
        finally:
            if owns_connection:
                connection.close()

    def update_mailbox(self, mailbox_id, values):
        allowed = {
            "password": ("account_password", 500),
            "access_token": ("access_token", 100_000),
            "label": ("label", 200),
            "extra": ("extra", 2000),
            "expires_at": ("expires_at", 64),
        }
        assignments = []
        params = []
        for key, (column, limit) in allowed.items():
            if key in values:
                assignments.append(f"{column} = ?")
                normalized = str(values.get(key) or "")[:limit]
                if key == "expires_at" and normalized:
                    parsed = parse_api_datetime(normalized)
                    if not parsed:
                        raise ValueError("expires_at 无效；无时区时间按北京时间处理")
                    normalized = isoformat(parsed)
                params.append(normalized or None if key == "expires_at" else normalized)
        if "status" in values:
            status = str(values.get("status") or "")
            if status not in {"ready", "sold", "disabled"}:
                raise ValueError("状态无效")
            assignments.append("status = ?")
            params.append(status)
            if status == "ready":
                assignments.extend(["sold_at = NULL", "ldxp_trade_no = ''", "ldxp_card_digest = ''"])
        if not assignments:
            raise ValueError("没有可更新的字段")
        assignments.append("updated_at = ?")
        params.append(isoformat(utc_now()))
        params.append(int(mailbox_id))
        with self.connect() as db:
            cursor = db.execute(f"UPDATE pickup_mailboxes SET {', '.join(assignments)} WHERE id = ?", params)
            if not cursor.rowcount:
                raise KeyError("邮箱不存在")
        return self.get_admin_mailbox(mailbox_id)

    def delete_mailbox(self, mailbox_id):
        with self.connect() as db:
            cursor = db.execute("DELETE FROM pickup_mailboxes WHERE id = ?", (int(mailbox_id),))
            if not cursor.rowcount:
                raise KeyError("邮箱不存在")
        return {"ok": True}

    def update_mailbox_statuses(self, ids, status):
        if not isinstance(ids, list):
            raise ValueError("请选择要编辑状态的邮箱")
        normalized_ids = sorted({int(value) for value in ids if str(value).isdigit()})
        if not normalized_ids:
            raise ValueError("请选择要编辑状态的邮箱")
        if len(normalized_ids) > 500:
            raise ValueError("单次最多处理 500 条记录")
        status = str(status or "")
        if status not in {"ready", "sold", "disabled"}:
            raise ValueError("状态无效")

        placeholders = ",".join("?" for _ in normalized_ids)
        assignments = ["status = ?", "updated_at = ?"]
        if status == "ready":
            assignments.extend(["sold_at = NULL", "ldxp_trade_no = ''", "ldxp_card_digest = ''"])
        with self.connect() as db:
            cursor = db.execute(
                f"UPDATE pickup_mailboxes SET {', '.join(assignments)} "
                f"WHERE id IN ({placeholders}) AND hidden_at IS NULL",
                [status, isoformat(utc_now()), *normalized_ids],
            )
        return {
            "ok": True,
            "updated": cursor.rowcount,
            "skipped": len(normalized_ids) - cursor.rowcount,
            "status": status,
        }

    def archive_sold_mailboxes(self, ids):
        if not isinstance(ids, list):
            raise ValueError("请选择要本地删除的已售记录")
        normalized_ids = sorted({int(value) for value in ids if str(value).isdigit()})
        if not normalized_ids:
            raise ValueError("请选择要本地删除的已售记录")
        if len(normalized_ids) > 500:
            raise ValueError("单次最多处理 500 条记录")
        placeholders = ",".join("?" for _ in normalized_ids)
        now = isoformat(utc_now())
        with self.connect() as db:
            eligible = db.execute(
                f"""
                SELECT id FROM pickup_mailboxes
                WHERE id IN ({placeholders}) AND status = 'sold' AND hidden_at IS NULL
                """,
                normalized_ids,
            ).fetchall()
            eligible_ids = [int(row["id"]) for row in eligible]
            if eligible_ids:
                eligible_placeholders = ",".join("?" for _ in eligible_ids)
                db.execute(
                    f"UPDATE pickup_mailboxes SET hidden_at = ?, updated_at = ? WHERE id IN ({eligible_placeholders})",
                    [now, now, *eligible_ids],
                )
        return {
            "ok": True,
            "archived": len(eligible_ids),
            "skipped": len(normalized_ids) - len(eligible_ids),
        }

    def rotate_token(self, mailbox_id):
        with self.connect() as db:
            cursor = db.execute(
                "UPDATE pickup_mailboxes SET token_id = ?, updated_at = ? WHERE id = ?",
                (secrets.token_urlsafe(18), isoformat(utc_now()), int(mailbox_id)),
            )
            if not cursor.rowcount:
                raise KeyError("邮箱不存在")
        return self.get_admin_mailbox(mailbox_id)

    def export_lines(self, ids=None):
        params = []
        where = "WHERE status != 'disabled' AND hidden_at IS NULL"
        if ids:
            normalized_ids = sorted({int(value) for value in ids if str(value).isdigit()})
            if not normalized_ids:
                return ""
            placeholders = ",".join("?" for _ in normalized_ids)
            where += f" AND id IN ({placeholders})"
            params.extend(normalized_ids)
        with self.connect() as db:
            rows = db.execute(f"SELECT * FROM pickup_mailboxes {where} ORDER BY id", params).fetchall()
        return "\n".join(self._delivery_line(row) for row in rows) + ("\n" if rows else "")

    def _public_mailbox_by_token(self, token, db):
        token_id = self.validate_token(token)
        if not token_id:
            raise KeyError("取件链接无效")
        row = db.execute("SELECT * FROM pickup_mailboxes WHERE token_id = ?", (token_id,)).fetchone()
        if not row or row["status"] == "disabled":
            raise KeyError("取件链接无效或已停用")
        expires_at = parse_datetime(row["expires_at"])
        if expires_at and expires_at <= utc_now():
            raise KeyError("取件链接已过期")
        return row

    def public_messages(self, token):
        with self.connect() as db:
            mailbox = self._public_mailbox_by_token(token, db)
            rows = db.execute(
                """
                SELECT id, sender_name, sender_address, subject, text_body, received_at
                FROM pickup_messages
                WHERE mailbox_id = ?
                ORDER BY received_at DESC, id DESC
                LIMIT 200
                """,
                (mailbox["id"],),
            ).fetchall()
        messages = []
        for row in rows:
            item = dict(row)
            item["preview"] = email_preview(item.pop("text_body", ""))
            messages.append(item)
        return {
            "email": mailbox["email"],
            "expires_at": mailbox["expires_at"],
            "messages": messages,
        }

    def public_message(self, token, message_id):
        with self.connect() as db:
            mailbox = self._public_mailbox_by_token(token, db)
            row = db.execute(
                """
                SELECT id, sender_name, sender_address, subject, text_body, received_at
                FROM pickup_messages
                WHERE id = ? AND mailbox_id = ?
                """,
                (int(message_id), mailbox["id"]),
            ).fetchone()
            if not row:
                raise KeyError("邮件不存在")
        message = dict(row)
        message["text_body"] = clean_email_text(message["text_body"])
        return {**message, "recipient": mailbox["email"]}

    def public_latest_message(self, token):
        with self.connect() as db:
            mailbox = self._public_mailbox_by_token(token, db)
            row = db.execute(
                """
                SELECT id, sender_name, sender_address, subject, text_body, received_at
                FROM pickup_messages
                WHERE mailbox_id = ?
                ORDER BY received_at DESC, id DESC
                LIMIT 1
                """,
                (mailbox["id"],),
            ).fetchone()
        message = None
        if row:
            message = dict(row)
            message["text_body"] = clean_email_text(message["text_body"])
            message["recipient"] = mailbox["email"]
        return {
            "ok": True,
            "email": mailbox["email"],
            "has_message": message is not None,
            "message": message,
        }

    def public_query(self, email, password, limit=1, timestamp=""):
        try:
            normalized_email = self.normalize_email(email)
            bounded_limit = int(limit)
        except (TypeError, ValueError) as error:
            raise ValueError("请求参数无效") from error
        if bounded_limit < 1 or bounded_limit > 200:
            raise ValueError("limit 必须是 1 到 200 的整数")
        received_after = parse_query_timestamp(timestamp)
        with self.connect() as db:
            try:
                mailbox = self._public_mailbox_by_token(password, db)
            except KeyError as error:
                raise PermissionError("Authentication failed.") from error
            if not hmac.compare_digest(str(mailbox["email"]).lower(), normalized_email):
                raise PermissionError("Authentication failed.")
            time_filter = "AND julianday(received_at) > julianday(?)" if received_after else ""
            params = [mailbox["id"]]
            if received_after:
                params.append(isoformat(received_after))
            params.append(bounded_limit)
            order_by = "received_at ASC, id ASC" if received_after else "received_at DESC, id DESC"
            rows = db.execute(
                f"""
                SELECT sender_name, sender_address, subject, text_body, received_at
                FROM pickup_messages
                WHERE mailbox_id = ?
                {time_filter}
                ORDER BY {order_by}
                LIMIT ?
                """,
                params,
            ).fetchall()
        data = []
        for row in rows:
            sender_name = clean_email_text(row["sender_name"])
            sender_address = str(row["sender_address"] or "").strip()
            sender = f"{sender_name} <{sender_address}>" if sender_name and sender_address else sender_address or sender_name
            received_at = parse_datetime(row["received_at"])
            data.append({
                "body": clean_email_text(row["text_body"]),
                "from": sender,
                "saved_at": received_at.astimezone(BEIJING_TIMEZONE).strftime("%Y-%m-%d %H:%M:%S") if received_at else str(row["received_at"]),
                "subject": str(row["subject"] or ""),
                "to": mailbox["email"],
            })
        return {"status": "success", "data": data}

    def delete_public_message(self, token, message_id):
        with self.connect() as db:
            mailbox = self._public_mailbox_by_token(token, db)
            row = db.execute(
                """
                SELECT fingerprint
                FROM pickup_messages
                WHERE id = ? AND mailbox_id = ?
                """,
                (int(message_id), mailbox["id"]),
            ).fetchone()
            if not row:
                raise KeyError("邮件不存在")
            db.execute(
                """
                INSERT OR IGNORE INTO pickup_message_tombstones
                    (fingerprint, mailbox_id, deleted_at)
                VALUES (?, ?, ?)
                """,
                (row["fingerprint"], mailbox["id"], isoformat(utc_now())),
            )
            db.execute(
                "DELETE FROM pickup_messages WHERE id = ? AND mailbox_id = ?",
                (int(message_id), mailbox["id"]),
            )
        return {"ok": True}

    def record_message(self, payload):
        raw_message = str(payload.get("raw_message") or payload.get("raw") or "")
        if len(raw_message.encode("utf-8", errors="ignore")) > self.config.max_raw_bytes:
            raise ValueError("邮件内容过大")
        try:
            recipient = self.normalize_email(payload.get("email") or payload.get("recipient"))
        except ValueError:
            return {"ok": True, "ignored": True, "reason": "unsupported_recipient"}
        if not recipient.endswith(f"@{self.config.domain}"):
            return {"ok": True, "ignored": True, "reason": "not_a_cloudflare_mailbox"}
        with self.connect() as db:
            mailbox = db.execute("SELECT id FROM pickup_mailboxes WHERE email = ?", (recipient,)).fetchone()
            if not mailbox:
                return {"ok": True, "ignored": True, "reason": "mailbox_not_registered"}
        if raw_message:
            parsed = parse_raw_message(raw_message, payload.get("subject"), payload.get("received_at"))
        else:
            sender_name, sender_address = parseaddr(str(payload.get("from") or payload.get("sender") or ""))
            body = str(payload.get("body") or payload.get("text") or payload.get("content") or "")
            parsed = {
                "subject": str(payload.get("subject") or ""),
                "sender_name": sender_name,
                "sender_address": sender_address.lower(),
                "text_body": body,
                "received_at": isoformat(parse_api_datetime(payload.get("received_at")) or utc_now()),
            }
        parsed["subject"] = parsed["subject"][:1000]
        parsed["sender_name"] = parsed["sender_name"][:500]
        parsed["sender_address"] = parsed["sender_address"][:500]
        parsed["text_body"] = clean_email_text(parsed["text_body"])[:2_000_000]
        fingerprint_source = raw_message or json.dumps(
            {"recipient": recipient, **parsed}, ensure_ascii=False, sort_keys=True
        )
        fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8", errors="replace")).hexdigest()
        created_at = isoformat(utc_now())
        with self.connect() as db:
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO pickup_messages
                    (mailbox_id, fingerprint, sender_name, sender_address, subject, text_body, received_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mailbox["id"],
                    fingerprint,
                    parsed["sender_name"],
                    parsed["sender_address"],
                    parsed["subject"],
                    parsed["text_body"],
                    parsed["received_at"],
                    created_at,
                ),
            )
            inserted = bool(cursor.rowcount)
            db.execute(
                "UPDATE pickup_mailboxes SET last_message_at = ?, updated_at = ? WHERE id = ?",
                (parsed["received_at"], created_at, mailbox["id"]),
            )
            db.execute(
                """
                DELETE FROM pickup_messages
                WHERE mailbox_id = ? AND id NOT IN (
                    SELECT id FROM pickup_messages
                    WHERE mailbox_id = ?
                    ORDER BY received_at DESC, id DESC
                    LIMIT ?
                )
                """,
                (mailbox["id"], mailbox["id"], self.config.max_messages_per_mailbox),
            )
        self.cleanup_if_due()
        return {"ok": True, "stored": inserted, "email": recipient}

    def source_accounts_in_use(self):
        with self.connect() as db:
            rows = db.execute(
                """
                SELECT DISTINCT source_account_id
                FROM pickup_mailboxes
                WHERE source_account_id IS NOT NULL AND status != 'disabled'
                ORDER BY source_account_id
                """
            ).fetchall()
        return [int(row["source_account_id"]) for row in rows]

    def sync_alias_hub_messages(self):
        with self.connect() as db:
            mailboxes = db.execute(
                """
                SELECT id, email, source_account_id
                FROM pickup_mailboxes
                WHERE source_account_id IS NOT NULL AND status != 'disabled'
                ORDER BY id
                """
            ).fetchall()
        if not mailboxes:
            return 0
        added = 0
        with self.alias_hub_connect() as source_db, self.connect() as target_db:
            for mailbox in mailboxes:
                escaped = (
                    mailbox["email"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                )
                rows = source_db.execute(
                    """
                    SELECT m.id, m.sender_name, m.sender_address, m.subject, m.body,
                           m.preview, m.received_at
                    FROM mail_messages m
                    LEFT JOIN addresses a ON a.id = m.address_id
                    WHERE m.account_id = ? AND (
                        lower(m.recipient_address) = lower(?) OR
                        lower(a.address) = lower(?) OR
                        lower(m.to_recipients) LIKE lower(?) ESCAPE '\\' OR
                        lower(m.cc_recipients) LIKE lower(?) ESCAPE '\\'
                    )
                    ORDER BY m.received_at DESC, m.id DESC
                    LIMIT 500
                    """,
                    (
                        mailbox["source_account_id"],
                        mailbox["email"],
                        mailbox["email"],
                        f"%{escaped}%",
                        f"%{escaped}%",
                    ),
                ).fetchall()
                newest = ""
                for row in rows:
                    fingerprint = hashlib.sha256(
                        f"aliashub:{mailbox['id']}:{row['id']}".encode("utf-8")
                    ).hexdigest()
                    cursor = target_db.execute(
                        """
                        INSERT OR IGNORE INTO pickup_messages
                            (mailbox_id, fingerprint, sender_name, sender_address,
                             subject, text_body, received_at, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            mailbox["id"],
                            fingerprint,
                            row["sender_name"] or "",
                            row["sender_address"] or "",
                            row["subject"] or "(无主题)",
                            clean_email_text(row["body"] or row["preview"] or "")[:2_000_000],
                            row["received_at"] or isoformat(utc_now()),
                            isoformat(utc_now()),
                        ),
                    )
                    added += int(bool(cursor.rowcount))
                    if not newest or str(row["received_at"] or "") > newest:
                        newest = str(row["received_at"] or "")
                if newest:
                    target_db.execute(
                        "UPDATE pickup_mailboxes SET last_message_at = ?, updated_at = ? WHERE id = ?",
                        (newest, isoformat(utc_now()), mailbox["id"]),
                    )
                target_db.execute(
                    """
                    DELETE FROM pickup_messages
                    WHERE mailbox_id = ? AND id NOT IN (
                        SELECT id FROM pickup_messages
                        WHERE mailbox_id = ?
                        ORDER BY received_at DESC, id DESC
                        LIMIT ?
                    )
                    """,
                    (mailbox["id"], mailbox["id"], self.config.max_messages_per_mailbox),
                )
        self.cleanup_if_due()
        return added

    def cleanup_if_due(self):
        now = utc_now()
        if now - self._last_cleanup < timedelta(hours=1):
            return
        if not self._cleanup_lock.acquire(blocking=False):
            return
        try:
            cutoff = isoformat(now - timedelta(days=self.config.retention_days))
            with self.connect() as db:
                db.execute("DELETE FROM pickup_messages WHERE received_at < ?", (cutoff,))
            self._last_cleanup = now
        finally:
            self._cleanup_lock.release()


class AliasHubBridge:
    def __init__(self, store):
        self.store = store
        self.config = store.config
        self.stop_event = threading.Event()
        self.thread = None
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookie_jar))
        self.authenticated = False

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self.run, name="alias-hub-pickup-bridge", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)

    def request(self, path, payload=None, retry_auth=True):
        body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8") if payload is not None else None
        request = Request(
            f"{self.config.alias_hub_url}{path}",
            data=body,
            method="POST" if payload is not None else "GET",
            headers={"Accept": "application/json", **({"Content-Type": "application/json"} if body else {})},
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                return response.status, json.loads(response.read().decode("utf-8") or "{}")
        except HTTPError as error:
            if error.code == 401 and retry_auth:
                self.login()
                return self.request(path, payload, retry_auth=False)
            try:
                result = json.loads(error.read().decode("utf-8") or "{}")
            except Exception:
                result = {"error": str(error)}
            return error.code, result

    def login(self):
        self.cookie_jar.clear()
        status, result = self.request(
            "/api/auth/login",
            {"username": self.config.admin_username, "password": self.config.admin_password},
            retry_auth=False,
        )
        if status != 200:
            raise RuntimeError(result.get("error") or "AliasHub 登录失败")
        self.authenticated = True

    def scan_sources(self):
        source_ids = self.store.source_accounts_in_use()
        if not source_ids:
            return
        if not self.authenticated:
            self.login()
        for source_id in source_ids:
            status, _result = self.request(f"/api/accounts/{source_id}/scan-inbox", {})
            if status not in {202, 409}:
                self.authenticated = False

    def run_once(self):
        self.store.sync_alias_hub_messages()
        self.scan_sources()

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.run_once()
            except (OSError, RuntimeError, sqlite3.Error, URLError) as error:
                print(f"[pickup-bridge] {error}", flush=True)
                self.authenticated = False
            except Exception as error:
                print(f"[pickup-bridge] unexpected error: {error}", flush=True)
            self.stop_event.wait(self.config.alias_hub_scan_seconds)


def ldxp_inventory_rows(payload, require_list=False):
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        if require_list:
            raise RuntimeError("LDXP_INVENTORY_SCHEMA_INVALID")
        return []
    data = payload.get("data")
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        for name in ("list", "items", "rows"):
            value = data.get(name)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    for name in ("list", "items", "rows"):
        value = payload.get(name)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    if require_list:
        raise RuntimeError("LDXP_INVENTORY_SCHEMA_INVALID")
    return []


def ldxp_order_detail_mapping(payload):
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    return data if isinstance(data, dict) else payload


def ldxp_order_detail_card(payload, ldxp_card_id):
    expected = _remote_identifier(ldxp_card_id)
    if not expected:
        return None
    details = ldxp_order_detail_mapping(payload)
    for field in LDXP_CARD_LIST_FIELDS:
        value = details.get(field)
        if not isinstance(value, (list, tuple)):
            continue
        for item in value:
            if isinstance(item, dict) and _remote_identifier(_first_text(item, LDXP_CARD_ID_FIELDS)) == expected:
                return {"order": details, "card": item}
    return None


class LdxpSyncBridge:
    inventory_url = "https://www.ldxp.cn/merchantApi/goodsCardStorage/list"
    order_info_url = "https://www.ldxp.cn/merchantApi/Order/orderInfo"
    goods_list_url = "https://www.ldxp.cn/merchantApi/Goods/list"
    goods_category_url = "https://www.ldxp.cn/merchantApi/GoodsCategory/listAll"
    storage_add_url = "https://www.ldxp.cn/merchantApi/GoodsCardStorage/add"
    safe_mode_url = "https://www.ldxp.cn/merchantApi/user/checkSafeMode"
    login_url = "https://www.ldxp.cn/merchantApi/user/login"

    def __init__(self, store, inventory_fetcher=None, order_detail_fetcher=None):
        self.store = store
        self.inventory_fetcher = inventory_fetcher
        self.order_detail_fetcher = order_detail_fetcher
        self._sync_lock = threading.Lock()
        self._upload_lock = threading.Lock()
        self._catalog_lock = threading.Lock()
        self._browser_lock = threading.Lock()
        self._catalog_cache = []
        self._catalog_cached_at = None
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._thread = None

    def status(self):
        return {
            **self.store.ldxp_status(),
            "sync_in_progress": self._sync_lock.locked(),
            "upload_in_progress": self._upload_lock.locked(),
            "catalog_in_progress": self._catalog_lock.locked(),
        }

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self.run, name="ldxp-sales-sync", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        self._wake_event.set()
        if self._thread:
            self._thread.join(timeout=5)

    def wake(self):
        self._wake_event.set()

    def _browser_profile_dir(self):
        return Path(os.environ.get("LDXP_PLAYWRIGHT_PROFILE_DIR", "/var/lib/mail-pickup/ldxp-browser"))

    def _browser_headless(self):
        return str(os.environ.get("LDXP_PLAYWRIGHT_HEADLESS", "1")).strip().lower() not in {"0", "false", "no"}

    def _proxy_candidates(self, config):
        candidates = []
        configured = str(config.get("proxy_url") or "").strip()
        if configured:
            candidates.append(configured)
        for value in str(os.environ.get("LDXP_PROXY_POOL", "")).split(","):
            value = value.strip()
            if value and value not in candidates:
                candidates.append(value)
        return candidates or [""]

    def _fetch_json_with_page(self, page, url, payload, merchant_token, validate=True):
        result = page.evaluate(
            """
            async ({ url, payload, merchantToken }) => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 30000);
              try {
                const response = await fetch(url, {
                  method: "POST",
                  credentials: "include",
                  headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Merchant-Token": merchantToken,
                  },
                  body: JSON.stringify(payload),
                  signal: controller.signal,
                });
                return { ok: response.ok, status: response.status, text: await response.text() };
              } catch (error) {
                return { ok: false, status: 0, aborted: error && error.name === "AbortError", text: "" };
              } finally {
                clearTimeout(timeout);
              }
            }
            """,
            {"url": url, "payload": payload, "merchantToken": merchant_token},
        )
        if not isinstance(result, dict):
            raise RuntimeError("LDXP_RESPONSE_INVALID")
        text = str(result.get("text") or "")
        if not result.get("ok"):
            if result.get("aborted"):
                raise RuntimeError("LDXP_REQUEST_TIMEOUT")
            if int(result.get("status") or 0) in {401, 403}:
                raise LdxpAccessError("链动小铺拒绝当前服务器出口，请配置访问代理或申请白名单")
            raise RuntimeError("LDXP_REQUEST_FAILED")
        if len(text.encode("utf-8", errors="ignore")) > 5 * 1024 * 1024:
            raise RuntimeError("LDXP_RESPONSE_TOO_LARGE")
        if "denied by http_bot" in text.lower() or text.lstrip().lower().startswith("<html"):
            raise LdxpAccessError("链动小铺拒绝当前服务器出口，请配置访问代理或申请白名单")
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError("LDXP_RESPONSE_INVALID") from error
        if not isinstance(parsed, (dict, list)):
            raise RuntimeError("LDXP_RESPONSE_INVALID")
        return validate_ldxp_success_payload(parsed) if validate else parsed

    def _with_cdp_page(self, playwright, cdp_url, operation):
        try:
            browser = playwright.chromium.connect_over_cdp(cdp_url, timeout=10_000)
            context = browser.contexts[0] if browser.contexts else None
            if context is None:
                raise RuntimeError("LDXP_CDP_CONTEXT_UNAVAILABLE")
            page = context.pages[0] if context.pages else context.new_page()
            if not str(page.url or "").startswith("https://www.ldxp.cn/"):
                page.goto("https://www.ldxp.cn/", wait_until="domcontentloaded", timeout=30_000)
            try:
                page.wait_for_load_state("domcontentloaded", timeout=5_000)
            except Exception:
                pass
            if page.locator("#aliyunCaptcha-sliding-slider, #captcha-element").count():
                raise LdxpAccessError("联动小铺需要人工滑块验证，请先点击“人工验证”完成滑块")
            try:
                return operation(page)
            except LdxpAccessError:
                try:
                    page.goto("https://www.ldxp.cn/", wait_until="domcontentloaded", timeout=30_000)
                except Exception:
                    pass
                raise
        except LdxpAccessError:
            raise
        except Exception as error:
            raise RuntimeError("LDXP_CDP_UNAVAILABLE") from error

    def _with_persistent_page(self, config, operation, profile_name="sync"):
        safe_profile_name = re.sub(r"[^a-z0-9_-]+", "-", str(profile_name or "sync").lower()).strip("-")
        profile_dir = self._browser_profile_dir() / (safe_profile_name or "sync")
        try:
            profile_dir.mkdir(parents=True, exist_ok=True)
            from playwright.sync_api import sync_playwright
        except (ImportError, OSError) as error:
            raise RuntimeError("LDXP_BROWSER_UNAVAILABLE") from error
        cdp_url = str(os.environ.get("LDXP_CDP_URL", "")).strip()
        if cdp_url:
            with self._browser_lock:
                with sync_playwright() as playwright:
                    return self._with_cdp_page(playwright, cdp_url, operation)
        last_error = None
        try:
            route_attempts = max(1, min(10, int(os.environ.get("LDXP_ROUTE_ATTEMPTS", "3"))))
        except (TypeError, ValueError):
            route_attempts = 3
        with sync_playwright() as playwright:
            for proxy_url in self._proxy_candidates(config):
                for _route_attempt in range(route_attempts):
                    context = None
                    try:
                        launch_options = ldxp_chromium_launch_options(
                            profile_dir,
                            self._browser_headless(),
                            proxy_url,
                        )
                        context = playwright.chromium.launch_persistent_context(**launch_options)
                        page = context.pages[0] if context.pages else context.new_page()
                        page.goto("https://www.ldxp.cn/", wait_until="domcontentloaded", timeout=30_000)
                        return operation(page)
                    except LdxpAccessError as error:
                        last_error = error
                    except ValueError:
                        raise
                    except Exception as error:
                        last_error = error
                    finally:
                        if context:
                            context.close()
        raise last_error or RuntimeError("LDXP_BROWSER_UNAVAILABLE")

    def _goods_rows(self, payload):
        value = payload
        if isinstance(value, dict) and isinstance(value.get("data"), dict):
            value = value["data"]
        if isinstance(value, dict):
            for name in ("list", "items", "rows"):
                if isinstance(value.get(name), list):
                    value = value[name]
                    break
        if not isinstance(value, list):
            raise RuntimeError("LDXP_GOODS_SCHEMA_INVALID")
        return [item for item in value if isinstance(item, dict)]

    def _category_mapping(self, payload):
        value = payload.get("data") if isinstance(payload, dict) else payload
        if isinstance(value, dict):
            value = value.get("list") or value.get("items") or value.get("rows")
        if not isinstance(value, list):
            return {}
        result = {}
        for item in value:
            if not isinstance(item, dict):
                continue
            category_id = _first_text(item, ("value", "id", "category_id", "categoryId"))
            category_name = _first_text(item, ("label", "name", "title"))
            if category_id and category_name:
                result[category_id] = category_name[:300]
        return result

    def _goods_summary(self, goods, categories=None):
        goods_id = normalize_ldxp_goods_id(_first_text(goods, ("id",) + LDXP_GOODS_ID_FIELDS))
        name = _first_text(goods, ("name", "goods_name", "goodsName", "title")) or f"商品 {goods_id}"
        category = _first_text(
            goods,
            ("category_name", "categoryName", "goods_category_name", "goodsCategoryName", "group_name", "groupName"),
        )
        if not category:
            nested = goods.get("category") or goods.get("goods_category")
            category = _first_text(nested, ("name", "title"))
        if not category and categories:
            category_id = _first_text(goods, ("category_id", "categoryId", "goods_category_id", "goodsCategoryId"))
            category = str(categories.get(category_id) or "")
        extend = goods.get("extend") if isinstance(goods.get("extend"), dict) else {}
        try:
            stock_count = max(0, int(extend.get("stock_count") or goods.get("stock_count") or 0))
        except (TypeError, ValueError):
            stock_count = 0
        return {"id": goods_id, "name": name[:300], "category": category[:300], "stock_count": stock_count}

    def _catalog_with_browser(self, config):
        def operation(page):
            goods_payload = {
                "goods_type": "card",
                "is_proxy": 0,
                "current": 1,
                "pageSize": 10_000,
                "status": 999,
            }
            goods_response = self._fetch_json_with_page(
                page,
                self.goods_list_url,
                goods_payload,
                config["merchant_token"],
            )
            rows = self._goods_rows(goods_response)
            category_response = self._fetch_json_with_page(
                page,
                self.goods_category_url,
                {"goods_type": "card"},
                config["merchant_token"],
            )
            categories = self._category_mapping(category_response)
            items = {summary["id"]: summary for summary in (self._goods_summary(row, categories) for row in rows)}
            uncategorized = {goods_id for goods_id, item in items.items() if not item["category"]}
            for category_id, category_name in list(categories.items())[:100]:
                if not uncategorized:
                    break
                category_payload = {
                    **goods_payload,
                    "category_id": int(category_id) if category_id.isdigit() else category_id,
                }
                category_goods_response = self._fetch_json_with_page(
                    page,
                    self.goods_list_url,
                    category_payload,
                    config["merchant_token"],
                )
                for row in self._goods_rows(category_goods_response):
                    goods_id = _first_text(row, ("id",) + LDXP_GOODS_ID_FIELDS)
                    if goods_id in uncategorized:
                        items[goods_id]["category"] = category_name
                        uncategorized.discard(goods_id)
            return sorted(items.values(), key=lambda item: (item["category"], item["name"], int(item["id"])))

        return self._with_persistent_page(config, operation, "catalog")

    def list_goods(self, refresh=False):
        now = utc_now()
        if (
            not refresh
            and self._catalog_cache
            and self._catalog_cached_at
            and now - self._catalog_cached_at < timedelta(minutes=5)
        ):
            return {
                "items": [dict(item) for item in self._catalog_cache],
                "fetched_at": isoformat(self._catalog_cached_at),
            }
        with self._catalog_lock:
            now = utc_now()
            if (
                not refresh
                and self._catalog_cache
                and self._catalog_cached_at
                and now - self._catalog_cached_at < timedelta(minutes=5)
            ):
                return {
                    "items": [dict(item) for item in self._catalog_cache],
                    "fetched_at": isoformat(self._catalog_cached_at),
                }
            try:
                items = self._catalog_with_browser(self.store.ldxp_private_configuration())
            except LdxpAccessError as error:
                raise ValueError(str(error)) from error
            except ValueError:
                raise
            except Exception as error:
                raise ValueError("读取联动小铺商品失败，请稍后重试") from error
            self._catalog_cache = [dict(item) for item in items]
            self._catalog_cached_at = utc_now()
            return {"items": items, "fetched_at": isoformat(self._catalog_cached_at)}

    def ensure_card_goods(self, products, category_name="Mail Pickup"):
        if not isinstance(products, list) or not products or len(products) > 10:
            raise ValueError("商品配置无效")
        normalized_products = []
        for product in products:
            if not isinstance(product, dict):
                raise ValueError("商品配置无效")
            sku = normalize_external_id(product.get("sku"))
            name = _bounded_text(product.get("name"), 120)
            description = _bounded_text(product.get("description"), 2000)
            try:
                price = round(float(product.get("price")), 2)
            except (TypeError, ValueError) as error:
                raise ValueError("商品价格无效") from error
            if not name or price < 0 or price > 99_999:
                raise ValueError("商品名称或价格无效")
            normalized_products.append(
                {"sku": sku, "name": name, "description": description, "price": price}
            )
        safe_category_name = _bounded_text(category_name, 60) or "Mail Pickup"
        image_url = os.environ.get("PICKUP_LDXP_IMAGE_URL", "").strip()
        config = self.store.ldxp_private_configuration()

        def operation(page):
            def request(url, payload):
                response = self._fetch_json_with_page(
                    page,
                    url,
                    payload,
                    config["merchant_token"],
                    validate=False,
                )
                if not isinstance(response, dict) or response.get("code") not in {1, "1", True}:
                    message = _first_text(response, ("msg", "message")) if isinstance(response, dict) else ""
                    raise ValueError(message or "联动小铺商品配置失败")
                return response

            category_response = request(
                self.goods_category_url,
                {"goods_type": "card"},
            )
            categories = category_response.get("data")
            if isinstance(categories, dict):
                categories = categories.get("list") or categories.get("items") or categories.get("rows")
            categories = categories if isinstance(categories, list) else []
            category = next(
                (
                    item
                    for item in categories
                    if isinstance(item, dict)
                    and _first_text(item, ("label", "name", "title")) == safe_category_name
                ),
                None,
            )
            if not category:
                request(
                    "https://www.ldxp.cn/merchantApi/GoodsCategory/update",
                    {
                        "id": 0,
                        "name": safe_category_name,
                        "image": image_url,
                        "sort": 0,
                        "goods_type": "card",
                    },
                )
                category_response = request(self.goods_category_url, {"goods_type": "card"})
                categories = category_response.get("data")
                if isinstance(categories, dict):
                    categories = categories.get("list") or categories.get("items") or categories.get("rows")
                categories = categories if isinstance(categories, list) else []
                category = next(
                    (
                        item
                        for item in categories
                        if isinstance(item, dict)
                        and _first_text(item, ("label", "name", "title")) == safe_category_name
                    ),
                    None,
                )
            category_id = _first_text(category or {}, ("value", "id", "category_id", "categoryId"))
            if not category_id:
                raise ValueError("联动小铺 NFVPN 商品分类创建失败")

            goods_payload = {
                "goods_type": "card",
                "is_proxy": 0,
                "current": 1,
                "pageSize": 10_000,
                "status": 999,
            }
            goods_response = request(self.goods_list_url, goods_payload)
            rows = self._goods_rows(goods_response)
            result = []
            for product in normalized_products:
                existing = next(
                    (
                        item
                        for item in rows
                        if _first_text(item, ("name", "goods_name", "goodsName", "title")) == product["name"]
                    ),
                    None,
                )
                existing_id = _first_text(existing or {}, ("id",) + LDXP_GOODS_ID_FIELDS)
                payload = {
                    "goods_type": "card",
                    "id": int(existing_id) if existing_id.isdigit() else 0,
                    "name": product["name"],
                    "image": image_url,
                    "category_id": int(category_id) if category_id.isdigit() else category_id,
                    "price": product["price"],
                    "market_price": product["price"],
                    "description": product["description"],
                    "sort": 0,
                    "coupon_status": 1,
                    "status": 1,
                    "fee_payer": -1,
                    "show": 1,
                    "contact_format": "any",
                    "agent_status": 0,
                    "agent_price1": 0,
                    "agent_price2": 0,
                    "agent_price3": 0,
                    "agent_price_limit": 0,
                    "description_sync": 0,
                    "name_sync": 0,
                    "parent_id": 0,
                    "cost_price": 0,
                    "add_type": 1,
                    "add_rate": 0,
                    "add_price": 0,
                    "extend": {
                        "instructions": "付款后自动取得客户端 Token，首次使用开始计算有效期。",
                        "stock_notice": 1,
                        "lock_card": 0,
                        "limit_count": 1,
                        "limit_count_max": 1,
                        "show_stock_type": 0,
                        "send_order": 0,
                        "query_password_status": 0,
                    },
                }
                request("https://www.ldxp.cn/merchantApi/Goods/update", payload)
                result.append({**product, "id": existing_id})

            goods_response = request(self.goods_list_url, goods_payload)
            rows = self._goods_rows(goods_response)
            final = []
            for product in normalized_products:
                goods = next(
                    (
                        item
                        for item in rows
                        if _first_text(item, ("name", "goods_name", "goodsName", "title")) == product["name"]
                    ),
                    None,
                )
                if not goods:
                    raise ValueError(f"联动小铺商品创建后未找到：{product['name']}")
                summary = self._goods_summary(goods, {str(category_id): safe_category_name})
                final.append({**summary, "sku": product["sku"], "price": product["price"]})
            return final

        try:
            items = self._with_persistent_page(config, operation, "mail-pickup-setup")
        except LdxpAccessError as error:
            raise ValueError(str(error)) from error
        self._catalog_cache = []
        self._catalog_cached_at = None
        return {"items": items, "updated_at": isoformat(utc_now())}

    def _match_goods(self, rows, config, mailboxes, categories=None):
        expected_id = str(config.get("goods_id") or LDXP_DEFAULT_GOODS_ID)
        for goods in rows:
            if _first_text(goods, ("id",) + LDXP_GOODS_ID_FIELDS) == expected_id:
                return self._goods_summary(goods, categories)

        keywords = []
        for mailbox in mailboxes:
            for value in (mailbox.get("label"), mailbox.get("extra")):
                keywords.extend(re.findall(r"[A-Za-z0-9+]+|[\u4e00-\u9fff]{2,}", str(value or "").lower()))
        scored = []
        for goods in rows:
            summary = self._goods_summary(goods, categories)
            haystack = f"{summary['name']} {summary['category']}".lower()
            score = sum(1 for keyword in set(keywords) if keyword and keyword in haystack)
            scored.append((score, summary))
        scored.sort(key=lambda item: (item[0], item[1]["id"] == LDXP_DEFAULT_GOODS_ID), reverse=True)
        if scored and scored[0][0] > 0:
            return scored[0][1]
        raise ValueError(f"店铺中未找到目标商品 {expected_id}")

    def _upload_with_browser(self, config, mailboxes):
        def operation(page):
            goods_payload = {
                "goods_type": "card",
                "is_proxy": 0,
                "current": 1,
                "pageSize": 10_000,
                "status": 999,
            }
            goods_response = self._fetch_json_with_page(
                page,
                self.goods_list_url,
                goods_payload,
                config["merchant_token"],
            )
            category_response = self._fetch_json_with_page(
                page,
                self.goods_category_url,
                {"goods_type": "card"},
                config["merchant_token"],
            )
            categories = self._category_mapping(category_response)
            goods = self._match_goods(self._goods_rows(goods_response), config, mailboxes, categories)
            if not goods["category"]:
                for category_id, category_name in list(categories.items())[:100]:
                    category_payload = {**goods_payload, "category_id": int(category_id) if category_id.isdigit() else category_id}
                    category_goods_response = self._fetch_json_with_page(
                        page,
                        self.goods_list_url,
                        category_payload,
                        config["merchant_token"],
                    )
                    if any(
                        _first_text(item, ("id",) + LDXP_GOODS_ID_FIELDS) == goods["id"]
                        for item in self._goods_rows(category_goods_response)
                    ):
                        goods["category"] = category_name
                        break
            upload_response = self._fetch_json_with_page(
                page,
                self.storage_add_url,
                {
                    "goods_id": int(goods["id"]),
                    "content": "\n".join(item["delivery_line"] for item in mailboxes),
                    "first": 0,
                    "remove_repeat": 1,
                },
                config["merchant_token"],
            )
            return goods, upload_response

        return self._with_persistent_page(config, operation, "upload")

    def connect_shop(self, username, password):
        safe_username = _bounded_text(username, 300)
        safe_password = _bounded_text(password, 500)
        if not safe_username or not safe_password:
            raise ValueError("请输入联动小铺账号和密码")

        def operation(page):
            credentials = {"username": safe_username, "password": safe_password}
            safe_mode_response = self._fetch_json_with_page(
                page,
                self.safe_mode_url,
                credentials,
                "",
                validate=False,
            )
            if not isinstance(safe_mode_response, dict) or safe_mode_response.get("code") not in {1, "1", True}:
                raise ValueError(_first_text(safe_mode_response, ("msg", "message")) or "联动小铺登录失败")
            data = safe_mode_response.get("data") if isinstance(safe_mode_response.get("data"), dict) else {}
            try:
                safe_mode = int(data.get("safe_mode") or 0)
            except (TypeError, ValueError):
                safe_mode = 0
            if safe_mode:
                raise ValueError("该店铺开启了二次验证，请先在联动小铺关闭登录二次验证")
            login_response = self._fetch_json_with_page(
                page,
                self.login_url,
                credentials,
                "",
                validate=False,
            )
            if not isinstance(login_response, dict) or login_response.get("code") not in {1, "1", True}:
                raise ValueError(_first_text(login_response, ("msg", "message")) or "联动小铺账号或密码错误")
            login_data = login_response.get("data") if isinstance(login_response.get("data"), dict) else {}
            merchant_token = _bounded_text(login_data.get("merchant_token"), 8192)
            if not merchant_token:
                raise ValueError("联动小铺未返回登录凭证")
            return merchant_token

        try:
            token = self._with_persistent_page({"proxy_url": ""}, operation, "connect")
            result = self.store.update_ldxp_configuration(
                {"poll_seconds": 20, "merchant_token": token}
            )
            self._catalog_cache = []
            self._catalog_cached_at = None
            self.wake()
            return {**result, "sync_in_progress": self._sync_lock.locked(), "upload_in_progress": False}
        except LdxpAccessError as error:
            raise ValueError(str(error)) from error
        except ValueError:
            raise
        except Exception as error:
            raise ValueError("联动小铺连接失败，请稍后重试") from error

    def upload_mailboxes(self, ids, goods_id=None):
        if not self._upload_lock.acquire(blocking=False):
            raise ValueError("一键上货正在进行")
        try:
            config = self.store.ldxp_private_configuration()
            selected_goods_id = normalize_ldxp_goods_id(goods_id or config["goods_id"])
            config = {**config, "goods_id": selected_goods_id}
            selection = self.store.ldxp_upload_candidates(ids, config["goods_id"])
            mailboxes = selection["items"]
            if not mailboxes:
                raise ValueError("所选账号均已上货、已售出或不可上货")
            goods, response = self._upload_with_browser(config, mailboxes)
            message = _first_text(response, ("msg", "message")) if isinstance(response, dict) else ""
            recorded = self.store.record_ldxp_uploads(
                [item["id"] for item in mailboxes],
                goods["id"],
                goods["name"],
                goods["category"],
                message,
            )
            self.wake()
            return {
                "ok": True,
                "uploaded": recorded,
                "skipped": selection["skipped"],
                "goods": goods,
                "message": message or "上货成功",
                "uploaded_at": isoformat(utc_now()),
            }
        except LdxpAccessError as error:
            raise ValueError(str(error)) from error
        except ValueError:
            raise
        except Exception as error:
            raise ValueError("一键上货失败，请稍后重试") from error
        finally:
            self._upload_lock.release()

    def upload_external_cards(self, source, goods_id, items):
        if not self._upload_lock.acquire(blocking=False):
            raise ValueError("一键上货正在进行")
        try:
            normalized_source = normalize_external_source(source)
            normalized_goods_id = normalize_ldxp_goods_id(goods_id)
            if not isinstance(items, list) or not items or len(items) > 500:
                raise ValueError("上货内容数量需在 1 到 500 之间")
            normalized_items = []
            seen = set()
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("上货内容无效")
                external_id = normalize_external_id(item.get("external_id"))
                content = _bounded_text(item.get("content"), 50_000)
                if not content:
                    raise ValueError("上货卡密内容不能为空")
                if external_id in seen:
                    raise ValueError("上货编号不能重复")
                seen.add(external_id)
                normalized_items.append({"external_id": external_id, "content": content})

            config = {**self.store.ldxp_private_configuration(), "goods_id": normalized_goods_id}
            upload_items = [
                {"delivery_line": item["content"], "label": normalized_source, "extra": item["external_id"]}
                for item in normalized_items
            ]
            goods, response = self._upload_with_browser(config, upload_items)
            message = _first_text(response, ("msg", "message")) if isinstance(response, dict) else ""
            recorded = self.store.record_external_card_uploads(
                normalized_source,
                normalized_items,
                goods["id"],
                goods["name"],
                goods["category"],
                message,
            )
            self.wake()
            return {
                "ok": True,
                "uploaded": recorded,
                "submitted": len(normalized_items),
                "goods": goods,
                "message": message or "上货成功",
                "uploaded_at": isoformat(utc_now()),
            }
        except LdxpAccessError as error:
            raise ValueError(str(error)) from error
        except ValueError:
            raise
        except Exception as error:
            raise ValueError("一键上货失败，请稍后重试") from error
        finally:
            self._upload_lock.release()

    def _fetch_inventory_with_browser(self, config):
        page_size = 100

        def operation(page):
            rows = []
            for goods_id in config.get("goods_ids") or [config["goods_id"]]:
                for current in range(1, 101):
                    payload = {
                        "goods_id": goods_id,
                        "current": current,
                        "pageSize": page_size,
                        "keywords": "",
                        "status": "1",
                        "first": "",
                    }
                    response = self._fetch_json_with_page(
                        page,
                        self.inventory_url,
                        payload,
                        config["merchant_token"],
                        validate=False,
                    )
                    if isinstance(response, dict) and response.get("code") not in {1, "1", True}:
                        message = _first_text(response, ("msg", "message"))
                        if "商品不存在" in message:
                            break
                    response = validate_ldxp_success_payload(response)
                    page_rows = ldxp_inventory_rows(response, require_list=True)
                    rows.extend({**row, "_pickup_goods_id": goods_id} for row in page_rows)
                    if len(page_rows) < page_size:
                        break
            return rows

        return self._with_persistent_page(config, operation)

    def _fetch_order_detail_with_browser(self, config, trade_no):
        return self._with_persistent_page(
            config,
            lambda page: self._fetch_json_with_page(
                page,
                self.order_info_url,
                {"trade_no": trade_no},
                config["merchant_token"],
            ),
        )

    def _fetch_inventory(self, config):
        if self.inventory_fetcher:
            return self.inventory_fetcher(config)
        return self._fetch_inventory_with_browser(config)

    def _fetch_order_detail(self, config, trade_no):
        if self.order_detail_fetcher:
            return self.order_detail_fetcher(config, trade_no)
        return self._fetch_order_detail_with_browser(config, trade_no)

    def _backfill_order_detail(self, config, card, outcome, goods_id):
        trade_no = _remote_identifier(outcome.get("ldxp_trade_no"))
        if not trade_no:
            return False
        detail = self._fetch_order_detail(config, trade_no)
        matched = ldxp_order_detail_card(detail, outcome.get("ldxp_card_id"))
        if not matched:
            return False
        order = matched["order"]
        detail_card = matched["card"]
        card_text = _first_text(detail_card, ("secret",) + LDXP_CARD_ITEM_TEXT_FIELDS)
        if not card_text:
            card_text = _first_text(card, ("secret",) + LDXP_CARD_ITEM_TEXT_FIELDS)
        if not card_text:
            return False
        sold_at = _first_text(detail_card, LDXP_SOLD_AT_FIELDS) or _first_text(order, LDXP_SOLD_AT_FIELDS)
        self.store._record_ldxp_sale(
            ldxp_card_id=outcome["ldxp_card_id"],
            card_text=card_text,
            goods_id=goods_id,
            ldxp_trade_no=trade_no,
            sold_at=sold_at,
        )
        return True

    def _record_inventory_rows(self, rows, config):
        goods_ids = {str(value) for value in (config.get("goods_ids") or [config["goods_id"]])}
        result = {
            "fetched": len(rows),
            "processed": 0,
            "matched": 0,
            "unknown": 0,
            "ambiguous": 0,
            "already_sold": 0,
            "disabled": 0,
            "duplicates": 0,
            "skipped_other_goods": 0,
            "skipped_without_cards": 0,
            "detail_failures": 0,
        }
        for card in rows:
            card_goods_id = _first_text(card, ("_pickup_goods_id",) + LDXP_GOODS_ID_FIELDS) or config["goods_id"]
            if card_goods_id not in goods_ids:
                result["skipped_other_goods"] += 1
                continue
            outcome = self.store.record_ldxp_inventory_card(card, card_goods_id)
            if outcome.get("skipped"):
                result["skipped_without_cards"] += 1
                continue
            result["processed"] += 1
            result[outcome["match_status"]] += 1
            result["duplicates"] += int(outcome["duplicate"])
            if (
                outcome["ldxp_trade_no"]
                and not outcome["duplicate"]
                and (self.order_detail_fetcher or str(os.environ.get("LDXP_FETCH_ORDER_DETAILS", "")).strip() == "1")
            ):
                try:
                    self._backfill_order_detail(config, card, outcome, card_goods_id)
                except Exception:
                    result["detail_failures"] += 1
        return result

    def sync_now(self):
        if not self._sync_lock.acquire(blocking=False):
            raise ValueError("链动小铺同步正在进行")
        try:
            config = self.store.ldxp_private_configuration()
            rows = ldxp_inventory_rows(validate_ldxp_success_payload(self._fetch_inventory(config)), require_list=True)
            result = self._record_inventory_rows(rows, config)
            result.update({"ok": True, "goods_id": config["goods_id"], "synced_at": isoformat(utc_now())})
            self.store.set_ldxp_sync_state("success", result)
            return result
        except LdxpAccessError as error:
            self.store.set_ldxp_sync_state("blocked", error=str(error))
            raise error
        except ValueError as error:
            self.store.set_ldxp_sync_state("not_configured", error="链动小铺授权未配置")
            raise error
        except Exception as error:
            self.store.set_ldxp_sync_state("failed", error="链动小铺同步失败")
            raise ValueError("链动小铺同步失败，请检查授权状态") from error
        finally:
            self._sync_lock.release()

    def run(self):
        while not self._stop_event.is_set():
            self._wake_event.clear()
            try:
                config = self.store.ldxp_configuration()
                if config["merchant_token_configured"]:
                    try:
                        self.sync_now()
                    except ValueError:
                        pass
                poll_seconds = max(10, int(config["poll_seconds"]))
            except (OSError, sqlite3.Error, ValueError, TypeError):
                poll_seconds = 10
            self._wake_event.wait(poll_seconds)


class PickupHandler(BaseHTTPRequestHandler):
    server_version = "MailPickup/1.0"

    @property
    def store(self):
        return self.server.store

    @property
    def config(self):
        return self.store.config

    @property
    def ldxp(self):
        return self.server.ldxp_bridge

    def log_message(self, _format, *_args):
        return

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; "
            "connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
        )
        super().end_headers()

    def send_bytes(self, status, body, content_type, extra_headers=None):
        self.send_response(int(status))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, payload):
        localized = api_beijing_times(payload)
        self.send_bytes(status, json.dumps(localized, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def send_error_json(self, status, message):
        self.send_json(status, {"error": str(message)})

    def require_admin(self):
        authorization = str(self.headers.get("Authorization") or "")
        if authorization.startswith("Basic "):
            try:
                username, password = base64.b64decode(authorization[6:]).decode("utf-8").split(":", 1)
            except (ValueError, UnicodeDecodeError):
                username, password = "", ""
            if hmac.compare_digest(username, self.config.admin_username) and hmac.compare_digest(
                password, self.config.admin_password
            ):
                return True
        self.send_bytes(
            HTTPStatus.UNAUTHORIZED,
            "需要管理员登录".encode("utf-8"),
            "text/plain; charset=utf-8",
            {"WWW-Authenticate": 'Basic realm="Cloudflare Pickup", charset="UTF-8"'},
        )
        return False

    def read_json(self, max_bytes=1024 * 1024):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as error:
            raise ValueError("Content-Length 无效") from error
        if length <= 0 or length > max_bytes:
            raise ValueError("请求内容为空或过大")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("JSON 内容无效") from error
        if not isinstance(value, dict):
            raise ValueError("JSON 内容必须是对象")
        return value

    def serve_static(self, filename):
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }
        path = STATIC_DIR / filename
        if not path.is_file():
            self.send_error_json(404, "页面不存在")
            return
        self.send_bytes(200, path.read_bytes(), content_types.get(path.suffix, "application/octet-stream"))

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path == "/health":
                self.send_json(200, {"ok": True, "service": "mail-pickup", "time": isoformat(utc_now())})
                return
            if path in {"/", "/pickup", "/pickup.html"} or PICKUP_PATH_RE.fullmatch(path):
                self.serve_static("pickup.html")
                return
            if path == "/static/style.css":
                self.serve_static("style.css")
                return
            if path == "/static/pickup.js":
                self.serve_static("pickup.js")
                return
            if path == "/static/admin.js":
                self.serve_static("admin.js")
                return
            if path in {"/admin", "/admin/", "/admin.html"}:
                if self.require_admin():
                    self.serve_static("admin.html")
                return
            if path == "/api/admin/auth-check":
                if self.require_admin():
                    self.send_json(200, {"ok": True})
                return
            if path in {"/api/query", "/api/query.php"}:
                email = (query.get("mail") or [""])[0]
                password = (query.get("pwd") or [""])[0]
                limit = (query.get("limit") or ["1"])[0]
                timestamp = next((
                    (query.get(name) or [""])[0]
                    for name in ("timestamp", "after", "since", "start_time")
                    if (query.get(name) or [""])[0]
                ), "")
                if not email or not password:
                    self.send_json(400, {"status": "error", "message": "Missing parameters."})
                    return
                try:
                    result = self.store.public_query(email, password, limit, timestamp)
                except PermissionError as error:
                    self.send_json(401, {"status": "error", "message": str(error)})
                    return
                except ValueError as error:
                    self.send_json(400, {"status": "error", "message": str(error)})
                    return
                self.send_json(200, result)
                return
            if path in {"/api/latest", "/api/first"}:
                token = (query.get("token") or [""])[0]
                if not token:
                    raise ValueError("缺少 token")
                self.send_json(200, self.store.public_latest_message(token))
                return
            match = LATEST_MESSAGE_ROUTE_RE.fullmatch(path)
            if match:
                self.send_json(200, self.store.public_latest_message(unquote(match.group(1))))
                return
            match = MAILBOX_ROUTE_RE.fullmatch(path)
            if match:
                self.send_json(200, self.store.public_messages(unquote(match.group(1))))
                return
            match = MESSAGE_ROUTE_RE.fullmatch(path)
            if match:
                self.send_json(200, self.store.public_message(unquote(match.group(1)), int(match.group(2))))
                return
            if path in {"/api/admin/ldxp", "/api/admin/ldxp/config", "/api/admin/ldxp/status"}:
                if not self.require_admin():
                    return
                self.send_json(200, self.ldxp.status())
                return
            if path == "/api/admin/ldxp/goods":
                if not self.require_admin():
                    return
                refresh = (query.get("refresh") or [""])[0] in {"1", "true", "yes"}
                self.send_json(200, self.ldxp.list_goods(refresh=refresh))
                return
            if ADMIN_LDXP_CARDS_ROUTE_RE.fullmatch(path):
                if not self.require_admin():
                    return
                self.send_json(
                    200,
                    self.store.list_external_cards(
                        (query.get("source") or [""])[0],
                        (query.get("goods_id") or [""])[0],
                        (query.get("status") or [""])[0],
                    ),
                )
                return
            if path == "/api/admin/mailboxes":
                if not self.require_admin():
                    return
                self.send_json(200, self.store.list_mailboxes((query.get("q") or [""])[0], (query.get("status") or [""])[0]))
                return
            if path == "/api/admin/export.txt":
                if not self.require_admin():
                    return
                ids = [item for value in query.get("ids", []) for item in value.split(",")]
                content = self.store.export_lines(ids or None).encode("utf-8")
                self.send_bytes(
                    200,
                    content,
                    "text/plain; charset=utf-8",
                    {"Content-Disposition": 'attachment; filename="liandong-card-keys.txt"'},
                )
                return
            match = ADMIN_MAILBOX_ROUTE_RE.fullmatch(path)
            if match:
                if not self.require_admin():
                    return
                self.send_json(200, self.store.get_admin_mailbox(int(match.group(1))))
                return
            self.send_error_json(404, "接口或页面不存在")
        except KeyError as error:
            self.send_error_json(404, error.args[0])
        except ValueError as error:
            self.send_error_json(400, error)
        except Exception:
            self.send_error_json(500, "服务器处理请求失败")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/inbound":
                expected = f"Bearer {self.config.inbound_token}"
                if not hmac.compare_digest(str(self.headers.get("Authorization") or ""), expected):
                    self.send_error_json(401, "unauthorized")
                    return
                payload = self.read_json(self.config.max_raw_bytes + 1024 * 1024)
                self.send_json(200, self.store.record_message(payload))
                return
            if path == "/api/admin/ldxp/sync":
                if not self.require_admin():
                    return
                self.send_json(200, self.ldxp.sync_now())
                return
            if path == "/api/admin/ldxp/upload":
                if not self.require_admin():
                    return
                payload = self.read_json()
                self.send_json(200, self.ldxp.upload_mailboxes(payload.get("ids"), payload.get("goods_id")))
                return
            if path == "/api/admin/ldxp/cards/upload":
                if not self.require_admin():
                    return
                payload = self.read_json(25 * 1024 * 1024)
                self.send_json(
                    200,
                    self.ldxp.upload_external_cards(
                        payload.get("source"),
                        payload.get("goods_id"),
                        payload.get("items"),
                    ),
                )
                return
            if path == "/api/admin/ldxp/goods/ensure":
                if not self.require_admin():
                    return
                payload = self.read_json()
                self.send_json(
                    200,
                    self.ldxp.ensure_card_goods(
                        payload.get("products"),
                        payload.get("category_name") or "Mail Pickup",
                    ),
                )
                return
            if path == "/api/admin/ldxp/connect":
                if not self.require_admin():
                    return
                payload = self.read_json()
                self.send_json(200, self.ldxp.connect_shop(payload.get("username"), payload.get("password")))
                return
            if path == "/api/admin/mailboxes":
                if not self.require_admin():
                    return
                payload = self.read_json()
                items = self.store.create_mailboxes(
                    items=payload.get("items"),
                    count=payload.get("count") or 0,
                    prefix=payload.get("prefix") or "account",
                    expires_days=payload.get("expires_days") or 0,
                    upsert=bool(payload.get("upsert")),
                    clear_credentials=bool(payload.get("clear_credentials")),
                    allow_unbound=bool(payload.get("allow_unbound")),
                    relist=payload.get("relist") is True,
                )
                self.send_json(201, {"items": items})
                return
            if path == "/api/admin/mailboxes/archive-sold":
                if not self.require_admin():
                    return
                payload = self.read_json()
                self.send_json(200, self.store.archive_sold_mailboxes(payload.get("ids")))
                return
            match = ADMIN_ROTATE_ROUTE_RE.fullmatch(path)
            if match:
                if not self.require_admin():
                    return
                self.send_json(200, self.store.rotate_token(int(match.group(1))))
                return
            self.send_error_json(404, "接口不存在")
        except KeyError as error:
            self.send_error_json(404, error.args[0])
        except ValueError as error:
            self.send_error_json(400, error)
        except Exception:
            self.send_error_json(500, "服务器处理请求失败")

    def do_PATCH(self):
        path = urlparse(self.path).path
        if path in {"/api/admin/ldxp", "/api/admin/ldxp/config"}:
            if not self.require_admin():
                return
            try:
                payload = self.read_json()
                result = self.store.update_ldxp_configuration(payload)
                self.ldxp.wake()
                self.send_json(200, {**result, "sync_in_progress": self.ldxp.status()["sync_in_progress"]})
            except KeyError as error:
                self.send_error_json(404, error.args[0])
            except ValueError as error:
                self.send_error_json(400, error)
            except Exception:
                self.send_error_json(500, "服务器处理请求失败")
            return
        if path == "/api/admin/mailboxes/status":
            if not self.require_admin():
                return
            try:
                payload = self.read_json()
                self.send_json(200, self.store.update_mailbox_statuses(payload.get("ids"), payload.get("status")))
            except ValueError as error:
                self.send_error_json(400, error)
            except Exception:
                self.send_error_json(500, "服务器处理请求失败")
            return
        match = ADMIN_MAILBOX_ROUTE_RE.fullmatch(path)
        if not match:
            self.send_error_json(404, "接口不存在")
            return
        if not self.require_admin():
            return
        try:
            payload = self.read_json()
            self.send_json(200, self.store.update_mailbox(int(match.group(1)), payload))
        except KeyError as error:
            self.send_error_json(404, error.args[0])
        except ValueError as error:
            self.send_error_json(400, error)
        except Exception:
            self.send_error_json(500, "服务器处理请求失败")

    def do_DELETE(self):
        path = urlparse(self.path).path
        match = MESSAGE_ROUTE_RE.fullmatch(path)
        if match:
            try:
                self.send_json(
                    200,
                    self.store.delete_public_message(unquote(match.group(1)), int(match.group(2))),
                )
            except KeyError as error:
                self.send_error_json(404, error.args[0])
            except Exception:
                self.send_error_json(500, "服务器处理请求失败")
            return
        match = ADMIN_MAILBOX_ROUTE_RE.fullmatch(path)
        if not match:
            self.send_error_json(404, "接口不存在")
            return
        if not self.require_admin():
            return
        try:
            self.send_json(200, self.store.delete_mailbox(int(match.group(1))))
        except KeyError as error:
            self.send_error_json(404, error.args[0])
        except Exception:
            self.send_error_json(500, "服务器处理请求失败")


class PickupServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, store, ldxp_inventory_fetcher=None, ldxp_order_detail_fetcher=None):
        self.store = store
        self.bridge = AliasHubBridge(store)
        self.ldxp_bridge = LdxpSyncBridge(store, ldxp_inventory_fetcher, ldxp_order_detail_fetcher)
        super().__init__(address, PickupHandler)

    def start_bridge(self):
        self.bridge.start()
        self.ldxp_bridge.start()

    def server_close(self):
        self.bridge.stop()
        self.ldxp_bridge.stop()
        super().server_close()


def create_server(config, ldxp_inventory_fetcher=None, ldxp_order_detail_fetcher=None):
    server = PickupServer(
        (config.host, config.port),
        PickupStore(config),
        ldxp_inventory_fetcher,
        ldxp_order_detail_fetcher,
    )
    server.start_bridge()
    return server


def main():
    config = Config.from_env()
    server = create_server(config)
    print(f"Cloudflare mail pickup listening on http://{config.host}:{config.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
