from __future__ import annotations

import threading
import time

from core.proxy_pool import proxy_pool
from core.proxy_urls import ProxyUrlError, build_proxy_config, canonicalize_ip
from domain.proxies import ProxyBulkCreateCommand, ProxyCheckSummary, ProxyCreateCommand, ProxyRecord
from infrastructure.proxies_repository import ProxiesRepository
from platforms.chatgpt.browser_register import (
    _detect_public_ip,
    _region_profile_for_ip,
)


class ProxyInspectionError(RuntimeError):
    pass


PROXY_INSPECTION_DEADLINE_SECONDS = 90.0


class ProxiesService:
    def __init__(self, repository: ProxiesRepository | None = None):
        self.repository = repository or ProxiesRepository()

    def list_proxies(self) -> list[dict]:
        return [self._serialize(item) for item in self.repository.list()]

    def create_proxy(self, command: ProxyCreateCommand) -> dict | None:
        item = self.repository.create(command)
        return self._serialize(item) if item else None

    def bulk_create_proxies(self, command: ProxyBulkCreateCommand) -> dict:
        added = self.repository.bulk_create(command.proxies, command.region)
        return {"added": added}

    def delete_proxy(self, proxy_id: int) -> dict:
        return {"ok": self.repository.delete(proxy_id)}

    def toggle_proxy(self, proxy_id: int) -> dict | None:
        value = self.repository.toggle(proxy_id)
        if value is None:
            return None
        return {"is_active": value}

    def trigger_check(self) -> dict:
        threading.Thread(target=proxy_pool.check_all, daemon=True, name="proxy-check").start()
        return {"message": "检测任务已启动"}

    def inspect_proxy(self, *, url: str, samples: int, delay_ms: int) -> dict:
        value = str(url or "")
        if not value.strip():
            raise ValueError("代理地址不能为空")

        try:
            proxy = build_proxy_config(value)
        except ProxyUrlError:
            raise ValueError("代理地址无效") from None
        if not proxy:
            raise ValueError("代理地址不能为空")

        results: list[dict] = []
        deadline = time.monotonic() + PROXY_INSPECTION_DEADLINE_SECONDS
        try:
            for index in range(samples):
                if time.monotonic() >= deadline:
                    raise TimeoutError("代理出口检测超时")
                # _detect_public_ip deliberately performs a fresh request instead
                # of using Camoufox's per-proxy lru_cache.
                ip = canonicalize_ip(_detect_public_ip(proxy, deadline=deadline))
                if time.monotonic() > deadline:
                    raise TimeoutError("代理出口检测超时")
                profile = _region_profile_for_ip(ip)
                results.append({
                    "ip": profile["ip"],
                    "country_code": profile["country_code"],
                    "country_name": profile["country_name"],
                    "locale": profile["locale"],
                    "timezone": profile["timezone"],
                    "latitude": profile["latitude"],
                    "longitude": profile["longitude"],
                })
                if index + 1 < samples and delay_ms:
                    delay_seconds = delay_ms / 1000
                    if time.monotonic() + delay_seconds >= deadline:
                        raise TimeoutError("代理出口检测超时")
                    time.sleep(delay_seconds)
        except Exception:
            # Upstream proxy exceptions can embed the authenticated proxy URL.
            # Keep the public error stable and credential-free.
            raise ProxyInspectionError("代理出口检测失败") from None

        distinct_ips = list(dict.fromkeys(item["ip"] for item in results))
        return {
            "dynamic": len(distinct_ips) > 1,
            "distinct_ips": distinct_ips,
            "samples": results,
        }

    @staticmethod
    def _serialize(item: ProxyRecord) -> dict:
        return {
            "id": item.id,
            "url": item.url,
            "region": item.region,
            "success_count": item.success_count,
            "fail_count": item.fail_count,
            "is_active": item.is_active,
            "last_checked": item.last_checked,
        }
