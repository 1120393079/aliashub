from __future__ import annotations

from infrastructure.provider_definitions_repository import ProviderDefinitionsRepository


class ProviderDefinitionsService:
    def __init__(self, repository: ProviderDefinitionsRepository | None = None):
        self.repository = repository or ProviderDefinitionsRepository()

    def list_definitions(self, provider_type: str, *, enabled_only: bool = False) -> list[dict]:
        return [self._serialize(item) for item in self.repository.list_by_type(provider_type, enabled_only=enabled_only)]

    def list_driver_templates(self, provider_type: str) -> list[dict]:
        return self.repository.list_driver_templates(provider_type)

    def save_definition(self, payload: dict) -> dict:
        item = self.repository.save(
            definition_id=payload.get("id"),
            provider_type=str(payload.get("provider_type") or ""),
            provider_key=str(payload.get("provider_key") or ""),
            label=str(payload.get("label") or ""),
            description=str(payload.get("description") or ""),
            driver_type=str(payload.get("driver_type") or ""),
            enabled=bool(payload.get("enabled", True)),
            default_auth_mode=str(payload.get("default_auth_mode") or ""),
            metadata=dict(payload.get("metadata") or {}),
        )
        return {"ok": True, "item": self._serialize(item)}

    def delete_definition(self, definition_id: int) -> dict:
        return {"ok": self.repository.delete(definition_id)}

    def get_definition(self, provider_type: str, provider_key: str) -> dict | None:
        item = self.repository.get_by_key(provider_type, provider_key)
        return self._serialize(item) if item else None

    def _serialize(self, item) -> dict:
        return {
            "id": int(item.id or 0),
            "provider_type": item.provider_type,
            "provider_key": item.provider_key,
            "value": item.provider_key,
            "label": item.label,
            "description": item.description,
            "driver_type": item.driver_type,
            "default_auth_mode": item.default_auth_mode,
            "auth_modes": item.get_auth_modes(),
            "fields": item.get_fields(),
            "enabled": bool(item.enabled),
            "is_builtin": bool(getattr(item, "is_builtin", False)),
            "category": str(getattr(item, "category", "") or ""),
            "metadata": item.get_metadata(),
        }
