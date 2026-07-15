from __future__ import annotations

from fastapi import APIRouter

from application.platform_capabilities import PlatformCapabilitiesService

router = APIRouter(prefix="/platforms", tags=["platform-capabilities"])
service = PlatformCapabilitiesService()


@router.put("/{name}/capabilities")
def update_platform_capabilities(name: str, body: dict):
    return service.update(name, body)


@router.delete("/{name}/capabilities")
def reset_platform_capabilities(name: str):
    return service.reset(name)
