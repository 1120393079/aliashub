from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from application.provider_definitions import ProviderDefinitionsService

router = APIRouter(prefix="/provider-definitions", tags=["provider-definitions"])
service = ProviderDefinitionsService()


class ProviderDefinitionUpsertRequest(BaseModel):
    id: int | None = None
    provider_type: str
    provider_key: str
    label: str
    description: str = ""
    driver_type: str
    enabled: bool = True
    default_auth_mode: str = ""
    metadata: dict = Field(default_factory=dict)


@router.get("")
def list_provider_definitions(provider_type: str, enabled_only: bool = False):
    return service.list_definitions(provider_type, enabled_only=enabled_only)


@router.get("/drivers")
def list_provider_drivers(provider_type: str):
    return service.list_driver_templates(provider_type)


@router.put("")
def save_provider_definition(body: ProviderDefinitionUpsertRequest):
    return service.save_definition(body.model_dump())


@router.post("")
def create_provider_definition(body: ProviderDefinitionUpsertRequest):
    return service.save_definition(body.model_dump())


@router.delete("/{definition_id}")
def delete_provider_definition(definition_id: int):
    try:
        result = service.delete_definition(definition_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not result["ok"]:
        raise HTTPException(404, "provider definition 不存在")
    return result
