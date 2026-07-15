from __future__ import annotations

import ipaddress
import re
from typing import Any
from urllib.parse import unquote_to_bytes, urlsplit


PROXY_URL_ERROR = "代理地址无效"
SUPPORTED_PROXY_SCHEMES = frozenset({"http", "https", "socks5"})
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class ProxyUrlError(ValueError):
    def __init__(self) -> None:
        super().__init__(PROXY_URL_ERROR)


def _has_control_characters(value: str) -> bool:
    return any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)


def _decode_userinfo(value: str) -> str:
    if _INVALID_PERCENT_ESCAPE.search(value):
        raise ProxyUrlError()
    try:
        decoded = unquote_to_bytes(value).decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        raise ProxyUrlError() from None
    if not decoded or _has_control_characters(decoded):
        raise ProxyUrlError()
    return decoded


def _normalize_proxy_hostname(hostname: str) -> str:
    if not hostname or any(char.isspace() or char == "\\" for char in hostname):
        raise ProxyUrlError()
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if ":" in hostname or "%" in hostname:
            raise ProxyUrlError() from None
        try:
            normalized = hostname.encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise ProxyUrlError() from None
        if not normalized or any(part == "" for part in normalized.rstrip(".").split(".")):
            raise ProxyUrlError()
        return normalized
    return f"[{address.compressed}]" if address.version == 6 else address.compressed


def build_proxy_config(proxy: Any) -> dict[str, str] | None:
    """Parse the proxy URL accepted by both inspection and browser launch."""
    raw_value = str(proxy or "")
    if _has_control_characters(raw_value):
        raise ProxyUrlError()
    value = raw_value.strip()
    if not value:
        return None

    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in SUPPORTED_PROXY_SCHEMES:
            raise ProxyUrlError()
        if not parsed.netloc or value.find("://") <= 0:
            raise ProxyUrlError()

        # Proxy endpoints are origins. Silently dropping any suffix would make
        # inspection and the browser operate on a different URL than supplied.
        authority = value[value.find("://") + 3 :]
        if authority != parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            raise ProxyUrlError()

        hostname = parsed.hostname
        port = parsed.port
        if not hostname or port is None or not 1 <= port <= 65535:
            raise ProxyUrlError()

        has_userinfo = "@" in parsed.netloc
        username: str | None = None
        password: str | None = None
        if has_userinfo:
            if parsed.netloc.count("@") != 1:
                raise ProxyUrlError()
            raw_username = parsed.username
            raw_password = parsed.password
            if raw_username is None or raw_password is None:
                raise ProxyUrlError()
            username = _decode_userinfo(raw_username)
            password = _decode_userinfo(raw_password)
            if parsed.scheme.lower() == "socks5":
                raise ProxyUrlError()
        elif parsed.username is not None or parsed.password is not None:
            raise ProxyUrlError()

        normalized_host = _normalize_proxy_hostname(hostname)
    except ProxyUrlError:
        raise
    except (TypeError, ValueError, UnicodeError):
        raise ProxyUrlError() from None

    config = {"server": f"{parsed.scheme.lower()}://{normalized_host}:{port}"}
    if username is not None and password is not None:
        config.update({"username": username, "password": password})
    return config


def canonicalize_ip(value: Any) -> str:
    try:
        return ipaddress.ip_address(str(value or "").strip()).compressed.lower()
    except ValueError:
        raise ValueError("IP 地址无效") from None


def redact_proxy_url(proxy: Any) -> str:
    try:
        config = build_proxy_config(proxy)
    except ProxyUrlError:
        return "<invalid-proxy>"
    if not config:
        return ""
    server = config["server"]
    if "username" not in config:
        return server
    scheme, separator, endpoint = server.partition("://")
    return f"{scheme}{separator}***@{endpoint}"
