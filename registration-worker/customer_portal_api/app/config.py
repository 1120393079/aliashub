from __future__ import annotations

import os


def _required_secret(name: str, *, minimum_length: int) -> str:
    value = os.getenv(name, "").strip()
    if len(value) < minimum_length:
        raise RuntimeError(f"{name} must be set to at least {minimum_length} characters")
    return value


class Settings:
    app_name: str = os.getenv("PORTAL_APP_NAME", "Customer Portal API")
    app_version: str = "0.2.0"
    jwt_secret: str = _required_secret("PORTAL_JWT_SECRET", minimum_length=32)
    access_token_ttl_seconds: int = int(os.getenv("PORTAL_ACCESS_TOKEN_TTL_SECONDS", "7200"))
    refresh_token_ttl_seconds: int = int(os.getenv("PORTAL_REFRESH_TOKEN_TTL_SECONDS", str(30 * 24 * 3600)))
    seed_admin_username: str = os.getenv("PORTAL_ADMIN_USERNAME", "admin")
    seed_admin_password: str = _required_secret("PORTAL_ADMIN_PASSWORD", minimum_length=12)
    seed_admin_email: str = os.getenv("PORTAL_ADMIN_EMAIL", "admin@example.com")
    cors_origins: list[str] = [
        item.strip()
        for item in os.getenv("PORTAL_CORS_ORIGINS", "http://127.0.0.1:8100").split(",")
        if item.strip()
    ]


settings = Settings()
