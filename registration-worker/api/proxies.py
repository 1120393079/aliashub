from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from application.proxies import ProxiesService, ProxyInspectionError
from domain.proxies import ProxyBulkCreateCommand, ProxyCreateCommand

router = APIRouter(prefix="/proxies", tags=["proxies"])
service = ProxiesService()


class ProxyCreateRequest(BaseModel):
    url: str
    region: str = ""


class ProxyBulkCreateRequest(BaseModel):
    proxies: list[str]
    region: str = ""


class ProxyInspectRequest(BaseModel):
    url: str
    samples: int = Field(default=3, ge=1, le=5)
    delay_ms: int = Field(default=0, ge=0, le=2000)


@router.get("")
def list_proxies():
    return service.list_proxies()


@router.post("")
def create_proxy(body: ProxyCreateRequest):
    item = service.create_proxy(ProxyCreateCommand(url=body.url, region=body.region))
    if not item:
        raise HTTPException(400, "代理已存在")
    return item


@router.post("/bulk")
def bulk_create_proxies(body: ProxyBulkCreateRequest):
    return service.bulk_create_proxies(ProxyBulkCreateCommand(proxies=body.proxies, region=body.region))


@router.post("/inspect")
def inspect_proxy(body: ProxyInspectRequest):
    try:
        return service.inspect_proxy(url=body.url, samples=body.samples, delay_ms=body.delay_ms)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    except ProxyInspectionError:
        raise HTTPException(502, "代理出口检测失败") from None


@router.delete("/{proxy_id}")
def delete_proxy(proxy_id: int):
    result = service.delete_proxy(proxy_id)
    if not result["ok"]:
        raise HTTPException(404, "代理不存在")
    return result


@router.patch("/{proxy_id}/toggle")
def toggle_proxy(proxy_id: int):
    result = service.toggle_proxy(proxy_id)
    if not result:
        raise HTTPException(404, "代理不存在")
    return result


@router.post("/check")
def check_proxies():
    return service.trigger_check()
