from __future__ import annotations

import io
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from application.account_exports import AccountExportsService, ExportArtifact
from application.accounts import AccountsService
from application.ctf_plus import CtfPlusAccountsService
from application.phone_binding import PhoneBindingService
from domain.accounts import AccountCreateCommand, AccountExportSelection, AccountQuery, AccountUpdateCommand

router = APIRouter(prefix="/accounts", tags=["accounts"])
service = AccountsService()
exports_service = AccountExportsService()
phone_binding_service = PhoneBindingService()
ctf_plus_service = CtfPlusAccountsService()


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
    password: Optional[str] = None
    user_id: Optional[str] = None
    lifecycle_status: Optional[str] = None
    overview: Optional[dict] = None
    credentials: Optional[dict] = None
    provider_accounts: Optional[list[dict]] = None
    provider_resources: Optional[list[dict]] = None
    replace_provider_accounts: bool = False
    replace_provider_resources: bool = False
    primary_token: Optional[str] = None
    cashier_url: Optional[str] = None
    region: Optional[str] = None
    trial_end_time: Optional[int] = None


class ImportRequest(BaseModel):
    platform: str
    lines: list[str]


class BatchExportRequest(BaseModel):
    platform: str = "chatgpt"
    ids: list[int] = Field(default_factory=list)
    select_all: bool = False
    status_filter: Optional[str] = None
    email_service_filter: Optional[str] = None
    search_filter: Optional[str] = None


class PhoneBindRequest(BaseModel):
    platform: str = "chatgpt"
    ids: list[int] = Field(default_factory=list)
    fallback_ids: list[int] = Field(default_factory=list)
    phone_lines: str


class CtfExportStatusRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    exported: bool = True


class CodexOAuthCompleteRequest(BaseModel):
    callback_url: str


def _stream_artifact(artifact: ExportArtifact) -> StreamingResponse:
    if isinstance(artifact.content, io.BytesIO):
        body = artifact.content
    elif isinstance(artifact.content, bytes):
        body = iter([artifact.content])
    else:
        body = iter([artifact.content])
    return StreamingResponse(
        body,
        media_type=artifact.media_type,
        headers={"Content-Disposition": f"attachment; filename={artifact.filename}"},
    )


@router.get("")
def list_accounts(
    platform: str = "",
    status: str = "",
    email: str = "",
    page: int = 1,
    page_size: int = 20,
):
    return service.list_accounts(AccountQuery(platform=platform, status=status, email=email, page=page, page_size=page_size))


@router.post("")
def create_account(body: AccountCreateRequest):
    return service.create_account(AccountCreateCommand(**body.model_dump()))


@router.get("/stats")
def get_stats():
    return service.get_stats()


@router.get("/export")
def export_accounts(platform: str = "", status: str = ""):
    content = service.export_csv(AccountQuery(platform=platform, status=status, page=1, page_size=100000))
    return StreamingResponse(
        iter([content]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=accounts.csv"},
    )


@router.post("/export/json")
def export_accounts_json(body: BatchExportRequest):
    try:
        artifact = exports_service.export_chatgpt_json(
            AccountExportSelection(
                platform=body.platform,
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/export/csv")
def export_accounts_csv(body: BatchExportRequest):
    try:
        artifact = exports_service.export_chatgpt_csv(
            AccountExportSelection(
                platform=body.platform,
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/export/sub2api")
def export_accounts_sub2api(body: BatchExportRequest):
    try:
        artifact = exports_service.export_chatgpt_sub2api(
            AccountExportSelection(
                platform=body.platform,
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/export/cpa")
def export_accounts_cpa(body: BatchExportRequest):
    try:
        artifact = exports_service.export_chatgpt_cpa(
            AccountExportSelection(
                platform=body.platform,
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/export/email-api")
def export_accounts_email_api(body: BatchExportRequest):
    try:
        artifact = exports_service.export_chatgpt_email_api_txt(
            AccountExportSelection(
                platform=body.platform,
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/export/cockpit")
def export_accounts_cockpit(body: BatchExportRequest):
    try:
        artifact = exports_service.export_chatgpt_cockpit(
            AccountExportSelection(
                platform=body.platform,
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/phone-bind")
def phone_bind_accounts(body: PhoneBindRequest):
    try:
        return phone_binding_service.bind(
            platform=body.platform,
            ids=body.ids,
            fallback_ids=body.fallback_ids,
            phone_lines=body.phone_lines,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/ctf-gpt-plus/export-status")
def mark_ctf_gpt_plus_export_status(body: CtfExportStatusRequest):
    return ctf_plus_service.mark_exported(ids=body.ids, exported=body.exported)


@router.post("/{account_id}/codex-oauth/start")
def start_account_codex_oauth(account_id: int):
    try:
        return ctf_plus_service.start_codex_oauth(account_id=account_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/{account_id}/codex-oauth/complete")
def complete_account_codex_oauth(account_id: int, body: CodexOAuthCompleteRequest):
    try:
        return ctf_plus_service.complete_codex_oauth(
            account_id=account_id,
            callback_url=body.callback_url,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/export/kiro-go")
def export_accounts_kiro_go(body: BatchExportRequest):
    try:
        artifact = exports_service.export_kiro_go(
            AccountExportSelection(
                platform="kiro",
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/export/any2api")
def export_accounts_any2api(body: BatchExportRequest):
    try:
        artifact = exports_service.export_any2api(
            AccountExportSelection(
                platform=body.platform,
                ids=body.ids,
                select_all=body.select_all,
                status_filter=body.status_filter or "",
                search_filter=body.search_filter or "",
            )
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _stream_artifact(artifact)


@router.post("/import")
def import_accounts(body: ImportRequest):
    return service.import_accounts(body.platform, body.lines)


@router.get("/{account_id}")
def get_account(account_id: int):
    item = service.get_account(account_id)
    if not item:
        raise HTTPException(404, "账号不存在")
    return item


@router.patch("/{account_id}")
def update_account(account_id: int, body: AccountUpdateRequest):
    item = service.update_account(account_id, AccountUpdateCommand(**body.model_dump()))
    if not item:
        raise HTTPException(404, "账号不存在")
    return item


@router.delete("/{account_id}")
def delete_account(account_id: int):
    result = service.delete_account(account_id)
    if not result["ok"]:
        raise HTTPException(404, "账号不存在")
    return result
