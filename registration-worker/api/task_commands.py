from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from application.task_commands import TaskCommandsService
from application.tasks_query import TasksQueryService

router = APIRouter(prefix="/tasks", tags=["task-commands"])
command_service = TaskCommandsService()
query_service = TasksQueryService()


class RegisterTaskRequest(BaseModel):
    platform: str
    email: Optional[str] = None
    password: Optional[str] = None
    count: int = 1
    concurrency: int = Field(default=1, ge=1, le=20)
    proxy: Optional[str] = None
    executor_type: str = "protocol"
    captcha_solver: str = "auto"
    extra: dict = Field(default_factory=dict)


class PhoneBindTaskRequest(BaseModel):
    task_id: str = Field(default="", max_length=69)
    platform: str = Field(default="chatgpt", max_length=64)
    ids: list[int] = Field(default_factory=list, max_length=100)
    fallback_ids: list[int] = Field(default_factory=list, max_length=100)
    phone_lines: str = Field(min_length=1, max_length=50_000)
    browser_mode: str = Field(default="camoufox_headed", max_length=64)
    bit_profile_id: str = Field(default="", max_length=200)
    concurrency: int = Field(default=1, ge=1, le=3)
    sms_wait_seconds: int = Field(default=30, ge=30, le=1800)


class CodexOAuthTaskRequest(BaseModel):
    platform: str = "chatgpt"
    account_id: int = 0
    ids: list[int] = Field(default_factory=list)
    browser_mode: str = "camoufox_headed"
    bit_profile_id: str = ""
    concurrency: int = 1


class GoPayPayChatGptTaskRequest(BaseModel):
    """GoPay 协议付款 ChatGPT Plus。

    chatgpt_account_ids: 必填，要付款的 ChatGPT 账号 id 列表（串行处理）
    gopay_account_id: 可选，指定 GoPay 号；为空则自动从池里挑余额 ≥ 1 的
    cashier_url_override: 可选，跳过 generate_plus_link 协议步骤
    midtrans_url_override: 可选，跳过浏览器抓 URL 步骤（直接用这个）
    country/currency: 默认 ID/IDR
    headless: 浏览器无头（建议 false 让用户看见进度）
    grab_timeout: 浏览器等用户跳到 Midtrans 的最大秒数
    herosms_api_key: Hero-SMS 接码平台 API key，付款 OTP 用；不传则回退环境变量 OPAI_HEROSMS_API_KEY
    """

    chatgpt_account_ids: list[int] = Field(default_factory=list)
    gopay_account_id: int = 0
    cashier_url_override: str = ""
    midtrans_url_override: str = ""
    country: str = "ID"
    currency: str = "IDR"
    headless: bool = False
    checkout_mode: str = "camoufox_headed"
    bit_profile_id: str = ""
    envelope_url: str = ""
    concurrency: int = 1
    register_count: int = 0
    register_extra: dict = Field(default_factory=dict)
    proxy: Optional[str] = None
    grab_timeout: int = 300
    phone_ttl_seconds: int = 1200
    auto_register_gopay: bool = True
    gopay_pin: str = "147258"
    sms_provider: str = "herosms"
    smspool_api_key: str = ""
    smsbower_api_key: str = ""
    # smsapi（固定手机号 + 查最新短信 API）渠道
    smsapi_url: str = ""
    smsapi_phone: str = ""
    herosms_api_key: str = ""
    # 拿号价格上限（USD），herosms 与 smspool 共用。空串走插件默认（0.11）。
    max_price: str = ""
    # GoPay 号来源开关：auto（先池后注册）/ pool（只用号池，没号失败）/
    # register（强制现注册新号，忽略号池/指定号）。
    gopay_source: str = "auto"
    # #2：付款成功后自动换绑（买临时外国号绑上去，释放当前印尼号）。
    auto_rebind: bool = False
    # 换绑专用接码渠道（独立于注册渠道）：herosms / smsbower。
    rebind_provider: str = "herosms"
    rebind_sms_key: str = ""
    rebind_country: str = ""
    rebind_service: str = ""
    # 调试抓包开关：开启后抓到 midtrans_url 不关浏览器，停在付款页让人工手动
    # 走完 GoPay 网页付款，全程录 HAR + dump 每页 HTML，不跑协议付款。
    capture_payment: bool = False
    # 抓包产物目录（可选）；留空则用工作目录下 _gopay_capture/<时间戳>/。
    capture_dir: str = ""
    # 用 Stripe payment_pages/init 协议生成 cashier_url（accessToken →
    # pay.openai.com 长链，纯协议、不开浏览器拿 cashier 链）。默认 False 沿用
    # 原有 generate_plus_link 行为。
    use_stripe_init: bool = False
    # 短链：checkout_ui_mode=custom + all_plans_pricing_modal 入口，无 promo，
    # 返回 chatgpt.com/checkout/openai_llc/<cs_id> 短链。
    use_short_link: bool = False


class GoPayRegisterAccountTaskRequest(BaseModel):
    """协议注册 GoPay 账户并设置 PIN。"""

    gopay_pin: str = "147258"
    proxy: Optional[str] = None
    envelope_url: str = ""
    sms_provider: str = "herosms"
    smspool_api_key: str = ""
    smsbower_api_key: str = ""
    smsapi_url: str = ""
    smsapi_phone: str = ""
    herosms_api_key: str = ""
    max_price: str = ""
    auto_rebind: bool = False
    rebind_provider: str = "herosms"
    rebind_sms_key: str = ""
    rebind_country: str = ""
    rebind_service: str = ""


@router.get("/register/control")
def registration_queue_control():
    return command_service.registration_queue_control()


@router.post("/register/pause-all")
def pause_registration_queue():
    return command_service.pause_registration_queue()


@router.post("/register/resume-all")
def resume_registration_queue():
    return command_service.resume_registration_queue()


@router.post("/register/cancel-all")
def cancel_registration_queue():
    return command_service.cancel_registration_queue()


@router.post("/register")
def create_register_task(body: RegisterTaskRequest):
    return command_service.create_register_task(body.model_dump())


@router.post("/phone-bind")
def create_phone_bind_task(body: PhoneBindTaskRequest):
    try:
        return command_service.create_phone_bind_task(body.model_dump())
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/codex-oauth")
def create_codex_oauth_task(body: CodexOAuthTaskRequest):
    return command_service.create_codex_oauth_task(body.model_dump())


class GetRtTaskRequest(BaseModel):
    platform: str = "chatgpt"
    account_id: int = 0
    ids: list[int] = Field(default_factory=list)
    browser_mode: str = "camoufox_headed"
    concurrency: int = 1
    record_har: str = ""
    sms_provider: str = ""
    smspool_api_key: str = ""
    smspool_max_price: str = "0.13"
    smsapi_phone: str = ""
    smsapi_url: str = ""
    phone_reuse_count: int = 3


@router.post("/get-rt")
def create_get_rt_task(body: GetRtTaskRequest):
    return command_service.create_get_rt_task(body.model_dump())


class GetRtBypassTaskRequest(BaseModel):
    platform: str = "chatgpt"
    account_id: int = 0
    ids: list[int] = Field(default_factory=list)
    browser_mode: str = "camoufox_headed"
    concurrency: int = 1


@router.post("/get-rt-bypass")
def create_get_rt_bypass_task(body: GetRtBypassTaskRequest):
    return command_service.create_get_rt_bypass_task(body.model_dump())


@router.post("/gopay-pay-chatgpt")
def create_gopay_pay_chatgpt_task(body: GoPayPayChatGptTaskRequest):
    return command_service.create_gopay_pay_chatgpt_task(body.model_dump())


@router.post("/gopay-register-account")
def create_gopay_register_account_task(body: GoPayRegisterAccountTaskRequest):
    return command_service.create_gopay_register_account_task(body.model_dump())


@router.post("/{task_id}/cancel")
def cancel_task(task_id: str):
    task = command_service.cancel_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


@router.post("/{task_id}/pause")
def pause_task(task_id: str):
    task = command_service.pause_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


@router.post("/{task_id}/resume")
def resume_task(task_id: str):
    task = command_service.resume_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


@router.post("/{task_id}/release")
def release_task(task_id: str):
    task = command_service.release_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task


@router.get("/{task_id}/logs/stream")
async def stream_logs(task_id: str, since: int = 0):
    if not query_service.get_task(task_id):
        raise HTTPException(404, "任务不存在")
    return StreamingResponse(
        command_service.stream_task_events(task_id, since=since),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
