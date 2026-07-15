from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from customer_portal_api.app.deps import get_db_session, require_admin
from customer_portal_api.app.models import PortalUser
from customer_portal_api.app.services.portal import PortalService


router = APIRouter(tags=["admin"])


class ConfigUpdateRequest(BaseModel):
    data: dict[str, str] = Field(default_factory=dict)


class RegisterTaskRequest(BaseModel):
    platform: str
    email: str | None = None
    password: str | None = None
    count: int = 1
    concurrency: int = 1
    proxy: str | None = None
    executor_type: str = "protocol"
    captcha_solver: str = "auto"
    extra: dict = Field(default_factory=dict)


class AccountCreateRequest(BaseModel):
    platform: str
    email: str
    password: str
    user_id: str = ""
    lifecycle_status: str = "registered"
    overview: dict = Field(default_factory=dict)
    credentials: dict = Field(default_factory=dict)
    provider_accounts: list[dict] = Field(default_factory=list)
    provider_resources: list[dict] = Field(default_factory=list)
    primary_token: str = ""
    cashier_url: str = ""
    region: str = ""
    trial_end_time: int = 0


class AccountUpdateRequest(BaseModel):
    password: str | None = None
    user_id: str | None = None
    lifecycle_status: str | None = None
    overview: dict | None = None
    credentials: dict | None = None
    provider_accounts: list[dict] | None = None
    provider_resources: list[dict] | None = None
    replace_provider_accounts: bool = False
    replace_provider_resources: bool = False
    primary_token: str | None = None
    cashier_url: str | None = None
    region: str | None = None
    trial_end_time: int | None = None


class ImportAccountsRequest(BaseModel):
    platform: str
    lines: list[str]


class BatchExportRequest(BaseModel):
    platform: str = "chatgpt"
    ids: list[int] = Field(default_factory=list)
    select_all: bool = False
    status_filter: str | None = None
    search_filter: str | None = None


class ProxyCreateRequest(BaseModel):
    url: str
    region: str = ""


class ProxyBulkCreateRequest(BaseModel):
    proxies: list[str]
    region: str = ""


class UserCreateRequest(BaseModel):
    username: str
    password: str
    email: str | None = None
    mobile: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    role_code: str = "user"
    status: str = "active"
    platform_codes: list[str] = Field(default_factory=list)


class UserUpdateRequest(BaseModel):
    password: str | None = None
    email: str | None = None
    mobile: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    role_code: str | None = None
    status: str | None = None
    platform_codes: list[str] | None = None


class PlatformAccessUpdateRequest(BaseModel):
    platform_codes: list[str] = Field(default_factory=list)


class ActionRequest(BaseModel):
    params: dict = Field(default_factory=dict)


@router.get("/admin/users")
def list_users(
    keyword: str = "",
    role_code: str = "",
    status: str = "",
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_users(keyword=keyword, role_code=role_code, status_value=status)


@router.post("/admin/users")
def create_user(
    body: UserCreateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).create_user(body.model_dump())


@router.patch("/admin/users/{user_id}")
def update_user(
    user_id: int,
    body: UserUpdateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).update_user(user_id, body.model_dump(exclude_unset=True))


@router.get("/admin/users/{user_id}/platform-access")
def get_user_platform_access(
    user_id: int,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_user_platform_access(user_id)


@router.post("/admin/users/{user_id}/platform-access")
def set_user_platform_access(
    user_id: int,
    body: PlatformAccessUpdateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).set_user_platform_access(user_id, body.platform_codes)


@router.delete("/admin/users/{user_id}/platform-access/{platform_code}")
def remove_user_platform_access(
    user_id: int,
    platform_code: str,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).remove_user_platform_access(user_id, platform_code)


@router.get("/admin/roles")
def list_roles(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_roles()


@router.get("/admin/permissions")
def list_permissions(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_permissions()


@router.get("/admin/products")
def list_products(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_products()


@router.get("/platforms")
def list_platforms(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_platforms()


@router.get("/platforms/{platform}/desktop-state")
def get_desktop_state(
    platform: str,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_desktop_state(platform)


@router.get("/config")
def get_config(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_config()


@router.get("/config/options")
def get_config_options(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_config_options()


@router.put("/config")
def update_config(
    body: ConfigUpdateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).update_config(body.data)


@router.post("/tasks/register")
def create_register_task(
    body: RegisterTaskRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).create_admin_register_task(body.model_dump())


@router.get("/tasks/logs")
def list_task_logs(
    platform: str = "",
    page: int = 1,
    page_size: int = 50,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_task_logs(platform=platform, page=page, page_size=page_size)


@router.get("/tasks")
def list_tasks(
    platform: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 50,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_tasks(platform=platform, status=status, page=page, page_size=page_size)


@router.get("/tasks/{task_id}")
def get_task(
    task_id: str,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_task(task_id)


@router.get("/tasks/{task_id}/events")
def list_task_events(
    task_id: str,
    since: int = 0,
    limit: int = 200,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_task_events(task_id, since=since, limit=limit)


@router.get("/tasks/{task_id}/logs/stream")
async def stream_task_events(
    task_id: str,
    since: int = 0,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    service = PortalService(session)
    return StreamingResponse(
        await service.stream_task_events(task_id, since=since),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/tasks/{task_id}/cancel")
def cancel_task(
    task_id: str,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).cancel_task(task_id)


@router.get("/accounts")
def list_accounts(
    platform: str = "",
    status: str = "",
    email: str = "",
    page: int = 1,
    page_size: int = 20,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_accounts(platform=platform, status_value=status, email=email, page=page, page_size=page_size)


@router.post("/accounts")
def create_account(
    body: AccountCreateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).create_account(body.model_dump())


@router.get("/accounts/stats")
def get_account_stats(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_account_stats()


@router.post("/accounts/import")
def import_accounts(
    body: ImportAccountsRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).import_accounts(body.platform, body.lines)


@router.get("/accounts/export")
def export_accounts(
    platform: str = "",
    status: str = "",
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).export_accounts_csv_stream(platform=platform, status_value=status)


@router.post("/accounts/export/json")
def export_accounts_json(
    body: BatchExportRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).export_accounts_json(body.model_dump())


@router.post("/accounts/export/csv")
def export_accounts_csv(
    body: BatchExportRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).export_accounts_csv_zip(body.model_dump())


@router.post("/accounts/export/sub2api")
def export_accounts_sub2api(
    body: BatchExportRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).export_accounts_sub2api(body.model_dump())


@router.post("/accounts/export/cpa")
def export_accounts_cpa(
    body: BatchExportRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).export_accounts_cpa(body.model_dump())


@router.get("/accounts/{account_id}")
def get_account(
    account_id: int,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).get_account(account_id)


@router.patch("/accounts/{account_id}")
def update_account(
    account_id: int,
    body: AccountUpdateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).update_account(account_id, body.model_dump(exclude_unset=True))


@router.delete("/accounts/{account_id}")
def delete_account(
    account_id: int,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).delete_account(account_id)


@router.get("/actions/{platform}")
def list_actions(
    platform: str,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_actions(platform)


@router.post("/actions/{platform}/{account_id}/{action_id}")
def execute_action(
    platform: str,
    account_id: int,
    action_id: str,
    body: ActionRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).execute_action(platform, account_id, action_id, body.params)


@router.get("/proxies")
def list_proxies(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).list_proxies()


@router.post("/proxies")
def create_proxy(
    body: ProxyCreateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).create_proxy(body.url, body.region)


@router.post("/proxies/bulk")
def bulk_create_proxies(
    body: ProxyBulkCreateRequest,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).bulk_create_proxies(body.proxies, body.region)


@router.delete("/proxies/{proxy_id}")
def delete_proxy(
    proxy_id: int,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).delete_proxy(proxy_id)


@router.patch("/proxies/{proxy_id}/toggle")
def toggle_proxy(
    proxy_id: int,
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).toggle_proxy(proxy_id)


@router.post("/proxies/check")
def check_proxies(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).check_proxies()


@router.get("/solver/status")
def solver_status(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).solver_status()


@router.post("/solver/restart")
def solver_restart(
    _: PortalUser = Depends(require_admin),
    session: Session = Depends(get_db_session),
):
    return PortalService(session).restart_solver()
