from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import inspect
import re
import threading
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from domain.accounts import AccountExportSelection, AccountRecord, AccountUpdateCommand
from infrastructure.accounts_repository import AccountsRepository


MAX_ACCOUNTS_PER_PHONE = 3


@dataclass(frozen=True, slots=True)
class PhoneBindEntry:
    phone: str
    sms_api: str


Binder = Callable[..., dict[str, Any]]


def _mask_phone(value: str) -> str:
    digits = "".join(char for char in str(value or "") if char.isdigit())
    return f"{'*' * max(len(digits) - 4, 3)}{digits[-4:]}" if digits else "***"


def _sanitize_phone_bind_error(value: Any, *secrets_to_redact: str) -> str:
    text = str(value or "")
    for secret in secrets_to_redact:
        if secret:
            text = text.replace(str(secret), "[redacted-secret]")
    text = re.sub(r"https?://[^\s'\"<>]+", "[redacted-url]", text, flags=re.I)
    text = re.sub(r"(?<!\d)\d{6}(?!\d)", "******", text)
    return text[:500]


def _normalize_phone(value: str) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if not digits:
        return ""
    if len(digits) == 10:
        return f"+1{digits}"
    return f"+{digits}"


def parse_phone_bind_lines(raw: str) -> list[PhoneBindEntry]:
    entries: list[PhoneBindEntry] = []
    for line_number, line in enumerate(str(raw or "").splitlines(), start=1):
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        if "----" not in text:
            raise ValueError(f"invalid phone line at line {line_number}")
        phone_raw, sms_api = text.split("----", 1)
        phone = _normalize_phone(phone_raw)
        sms_api = sms_api.strip()
        if not phone or not sms_api.startswith(("http://", "https://")):
            raise ValueError(f"invalid phone line at line {line_number}")
        entries.append(PhoneBindEntry(phone=phone, sms_api=sms_api))
    if not entries:
        raise ValueError("phone_lines is empty")
    return entries


def is_phone_bound(account: AccountRecord) -> bool:
    binding = account.overview.get("phone_binding") if isinstance(account.overview, dict) else None
    return isinstance(binding, dict) and binding.get("status") == "bound"


def _platform_account_from_record(account: AccountRecord):
    from core.base_platform import Account, AccountStatus

    try:
        status = AccountStatus(str(account.lifecycle_status or AccountStatus.REGISTERED.value))
    except ValueError:
        status = AccountStatus.REGISTERED
    credentials = [dict(item) for item in account.credentials if isinstance(item, dict)]
    extra: dict[str, Any] = {
        "account_overview": dict(account.overview or {}),
        "overview": dict(account.overview or {}),
        "credentials": credentials,
        "provider_accounts": [dict(item) for item in account.provider_accounts if isinstance(item, dict)],
        "provider_resources": [dict(item) for item in account.provider_resources if isinstance(item, dict)],
    }
    for item in credentials:
        key = str(item.get("key") or "").strip()
        value = item.get("value")
        if key and value not in (None, ""):
            extra[key] = value
    return Account(
        platform=account.platform,
        email=account.email,
        password=account.password,
        user_id=account.user_id,
        token=account.primary_token,
        status=status,
        trial_end_time=account.trial_end_time,
        extra=extra,
    )


def _build_mailbox_otp_callback(
    account: AccountRecord,
    *,
    log_fn: Callable[[str], Any],
    cancel_check: Callable[[], bool] | None,
):
    if not account.provider_resources:
        return None, "账号没有绑定邮箱 provider 资源"
    from core.base_platform import RegisterConfig
    from platforms.chatgpt.plugin import ChatGPTPlatform

    platform = ChatGPTPlatform(RegisterConfig())
    platform.set_logger(log_fn)
    platform.set_cancel_checker(cancel_check)
    return platform._build_get_rt_mailbox_otp_callback(
        _platform_account_from_record(account),
        log_fn,
        None,
        purpose="绑定手机号",
        require_account_email=True,
    )


def default_phone_binder(
    account: AccountRecord,
    phone_entry: PhoneBindEntry,
    *,
    browser_mode: str = "camoufox_headed",
    bit_profile_id: str = "",
    log_fn: Callable[[str], Any] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    sms_wait_seconds: int = 30,
) -> dict[str, Any]:
    log = log_fn or (lambda _message: None)
    acquired_profile_id = ""
    callback: SmsApiPhoneCallback | None = None
    otp_callback = None
    try:
        from application.bitbrowser_profiles import acquire_profile_for_browser_mode, release_acquired_profile
        from platforms._browser_backend import parse_checkout_mode
        from platforms.chatgpt.browser_register import ChatGPTBrowserRegister

        if str(browser_mode or "").startswith("bitbrowser_"):
            bit_profile_id, acquired_profile_id = acquire_profile_for_browser_mode(
                browser_mode,
                fallback=bit_profile_id,
                log_fn=log,
            )
        backend_config = parse_checkout_mode(browser_mode, bit_profile_id=bit_profile_id)
        if callable(cancel_check) and cancel_check():
            return {
                "ok": False,
                "error": "任务已取消",
                "account_id": account.id,
                "phone": phone_entry.phone,
                "cancelled": True,
            }
        otp_error = ""
        try:
            otp_callback, otp_error = _build_mailbox_otp_callback(
                account,
                log_fn=log,
                cancel_check=cancel_check,
            )
        except Exception as exc:
            otp_error = _sanitize_phone_bind_error(exc, phone_entry.sms_api)
            otp_callback = None
        if not account.password and not callable(otp_callback):
            return {
                "ok": False,
                "error": f"账号缺少密码且无法读取原邮箱 OTP: {otp_error or '邮箱 callback 不可用'}",
                "account_id": account.id,
                "phone": phone_entry.phone,
            }
        callback = SmsApiPhoneCallback(
            phone_entry,
            cancel_check=cancel_check,
            wait_seconds=sms_wait_seconds,
        )
        log(f"准备为 {account.email} 绑定手机号 {_mask_phone(phone_entry.phone)}，浏览器模式 {browser_mode}")
        worker = ChatGPTBrowserRegister(
            headless=backend_config.is_headless,
            otp_callback=otp_callback,
            phone_callback=callback,
            log_fn=log,
            backend_config=backend_config,
            cancel_check=cancel_check,
            phone_binding_mode=True,
        )
        result = worker._retry_oauth_fresh_browser(account.email, account.password)
        if callback.completed and isinstance(result, dict) and result.get("access_token"):
            return {
                "ok": True,
                "phone": phone_entry.phone,
                **result,
            }
        if callable(cancel_check) and cancel_check() and not callback.completed:
            return {
                "ok": False,
                "error": "任务已取消",
                "account_id": account.id,
                "phone": phone_entry.phone,
                "cancelled": True,
            }
        if not isinstance(result, dict) or not result.get("access_token"):
            oauth_error = ""
            if isinstance(result, dict):
                oauth_error = _sanitize_phone_bind_error(
                    result.get("error") or result.get("detail") or "",
                    phone_entry.sms_api,
                ).strip()
            return {
                "ok": False,
                "error": oauth_error or "Codex OAuth phone binding did not return tokens",
                "account_id": account.id,
                "phone": phone_entry.phone,
            }
        if (
            isinstance(result, dict)
            and result.get("phone_verification_failed")
            and result.get("error")
        ):
            error = _sanitize_phone_bind_error(result.get("error"), phone_entry.sms_api)
        elif isinstance(result, dict) and result.get("phone_challenge_present") is False:
            error = (
                "OpenAI 登录成功，但未出现手机号验证页；"
                "账号可能已绑定手机号，或当前账号不要求再次验证"
            )
        else:
            error = "OpenAI phone verification challenge was not completed"
        return {
            "ok": False,
            "error": error,
            "account_id": account.id,
            "phone": phone_entry.phone,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": _sanitize_phone_bind_error(exc, phone_entry.sms_api),
            "account_id": account.id,
            "phone": phone_entry.phone,
        }
    finally:
        cancel_otp_wait = getattr(otp_callback, "cancel_wait", None)
        if callable(cancel_otp_wait):
            try:
                cancel_otp_wait()
            except Exception:
                pass
        if callback is not None:
            try:
                callback.cleanup()
            except Exception:
                pass
        if acquired_profile_id:
            release_acquired_profile(acquired_profile_id, log_fn=log)


def _fetch_phone_sms_code(
    entry: PhoneBindEntry,
    *,
    excluded_pins: set[str] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    wait_seconds: int = 30,
) -> str:
    from platforms.chatgpt.payment import _fetch_ctf_relay_code

    relay_url = entry.sms_api
    if excluded_pins:
        parsed = urlsplit(relay_url)
        query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != "resend"]
        query.append(("resend", "1"))
        relay_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
    return _fetch_ctf_relay_code(
        url=relay_url,
        timeout_seconds=min(max(int(wait_seconds or 30), 30), 1800),
        poll_interval_seconds=3,
        log=lambda _message: None,
        cancel_check=cancel_check,
        excluded_pins=excluded_pins or set(),
    )


class SmsApiPhoneCallback:
    def __init__(
        self,
        entry: PhoneBindEntry,
        *,
        cancel_check: Callable[[], bool] | None = None,
        wait_seconds: int = 30,
    ):
        self.entry = entry
        self.cancel_check = cancel_check
        self.wait_seconds = min(max(int(wait_seconds or 30), 30), 1800)
        self.phase = "need_number"
        self.completed = False
        self.activation = None
        self._resend_callback: Callable[[], Any] | None = None
        self._used_codes: set[str] = set()

    def __call__(self) -> str:
        if callable(self.cancel_check) and self.cancel_check():
            raise RuntimeError("任务已取消")
        if self.phase == "need_number":
            self.phase = "need_code"
            return self.entry.phone
        code = _fetch_phone_sms_code(
            self.entry,
            excluded_pins=self._used_codes,
            cancel_check=self.cancel_check,
            wait_seconds=self.wait_seconds,
        )
        if code:
            self._used_codes.add(code)
        return code

    def set_resend_callback(self, callback: Callable[[], Any]) -> None:
        self._resend_callback = callback

    def mark_send_failed(self, _reason: str) -> None:
        self.phase = "need_number"

    def mark_send_succeeded(self) -> None:
        self.phase = "need_code"

    def mark_code_failed(self, _reason: str) -> None:
        if callable(self._resend_callback):
            self._resend_callback()

    def report_success(self) -> None:
        self.completed = True

    def cleanup(self) -> None:
        self.activation = None


def _token_updates(bind_result: dict[str, Any]) -> dict[str, str]:
    updates: dict[str, str] = {}
    for source_key, target_key in (
        ("access_token", "access_token"),
        ("accessToken", "access_token"),
        ("refresh_token", "refresh_token"),
        ("refreshToken", "refresh_token"),
        ("id_token", "id_token"),
        ("idToken", "id_token"),
        ("account_id", "account_id"),
        ("accountId", "account_id"),
        ("chatgpt_account_id", "account_id"),
    ):
        value = str(bind_result.get(source_key) or "").strip()
        if value:
            updates[target_key] = value
    return updates


class PhoneBindingService:
    def __init__(
        self,
        repository: AccountsRepository | None = None,
        binder: Binder | None = None,
    ):
        self.repository = repository or AccountsRepository()
        self.binder = binder or default_phone_binder

    def bind(
        self,
        *,
        ids: list[int] | None = None,
        fallback_ids: list[int] | None = None,
        phone_lines: str,
        platform: str = "chatgpt",
        browser_mode: str = "camoufox_headed",
        bit_profile_id: str = "",
        concurrency: int = 1,
        log_fn: Callable[[str], Any] | None = None,
        cancel_check: Callable[[], bool] | None = None,
        sms_wait_seconds: int = 30,
    ) -> dict[str, Any]:
        entries = parse_phone_bind_lines(phone_lines)
        selected_ids = [int(item) for item in ids or [] if int(item or 0) > 0]
        if len(set(selected_ids)) != len(selected_ids):
            raise ValueError("selected account ids contain duplicates")
        targets = self._resolve_targets(
            ids=selected_ids,
            fallback_ids=[int(item) for item in fallback_ids or [] if int(item or 0) > 0],
            platform=platform,
        )
        if selected_ids and {item.id for item in targets} != set(selected_ids):
            raise ValueError("one or more selected accounts do not exist on the requested platform")
        capacity = len(entries) * MAX_ACCOUNTS_PER_PHONE
        if len(targets) > capacity:
            raise ValueError(f"selected account count exceeds phone capacity: accounts={len(targets)} capacity={capacity}")

        phone_stats = {
            entry.phone: {"phone": entry.phone, "sms_source": "relay", "used": 0, "success": 0, "failed": 0}
            for entry in entries
        }
        assignments: list[tuple[int, AccountRecord, PhoneBindEntry]] = []
        for index, account in enumerate(targets):
            entry = entries[index // MAX_ACCOUNTS_PER_PHONE]
            assignments.append((index, account, entry))

        results: list[dict[str, Any] | None] = [None] * len(assignments)
        stats_lock = threading.Lock()
        phone_locks = {entry.phone: threading.Lock() for entry in entries}
        worker_count = min(max(int(concurrency or 1), 1), len(assignments) or 1)
        task_logger = getattr(log_fn, "__self__", None)

        def cancel_requested() -> bool:
            try:
                return bool(callable(cancel_check) and cancel_check())
            except Exception:
                return False

        def cancelled_result(account: AccountRecord, entry: PhoneBindEntry) -> dict[str, Any]:
            return {
                "account_id": account.id,
                "email": account.email,
                "phone": entry.phone,
                "ok": False,
                "error": "任务已取消",
                "cancelled": True,
            }

        def run_assignment(index: int, account: AccountRecord, entry: PhoneBindEntry) -> dict[str, Any]:
            try:
                if hasattr(task_logger, "set_subtask"):
                    task_logger.set_subtask(f"worker_{index + 1}", f"{account.email}")
                if cancel_requested():
                    return cancelled_result(account, entry)
                if log_fn:
                    log_fn(f"[{index + 1}/{len(targets)}] 开始绑定 {account.email} -> {_mask_phone(entry.phone)}")
                try:
                    # A single phone/SMS inbox is shared across up to 3 accounts.
                    # Serialize per phone so verification codes do not get consumed
                    # by another account's in-flight auth flow.
                    with phone_locks[entry.phone]:
                        if cancel_requested():
                            return cancelled_result(account, entry)
                        with stats_lock:
                            phone_stats[entry.phone]["used"] += 1
                        bind_result = self._call_binder(
                            account,
                            entry,
                            browser_mode=browser_mode,
                            bit_profile_id=bit_profile_id,
                            log_fn=log_fn,
                            cancel_check=cancel_check,
                            sms_wait_seconds=sms_wait_seconds,
                        )
                    ok = bool(bind_result.get("ok"))
                    error = _sanitize_phone_bind_error(bind_result.get("error") or "", entry.sms_api)
                except Exception as exc:
                    ok = False
                    error = _sanitize_phone_bind_error(exc, entry.sms_api)

                if ok:
                    with stats_lock:
                        phone_stats[entry.phone]["success"] += 1
                    self._mark_bound(account, entry, bind_result)
                    if log_fn:
                        log_fn(f"[{index + 1}/{len(targets)}] 绑定成功 {account.email}")
                else:
                    with stats_lock:
                        phone_stats[entry.phone]["failed"] += 1
                    if log_fn:
                        log_fn(f"[{index + 1}/{len(targets)}] 绑定失败 {account.email}: {error}")

                return {
                    "account_id": account.id,
                    "email": account.email,
                    "phone": entry.phone,
                    "ok": ok,
                    "error": error,
                }
            finally:
                if hasattr(task_logger, "clear_subtask"):
                    task_logger.clear_subtask()

        if worker_count <= 1:
            for index, account, entry in assignments:
                if cancel_requested():
                    break
                results[index] = run_assignment(index, account, entry)
        else:
            with ThreadPoolExecutor(max_workers=worker_count) as pool:
                future_map = {}
                next_assignment = 0

                def submit_available() -> None:
                    nonlocal next_assignment
                    while (
                        next_assignment < len(assignments)
                        and len(future_map) < worker_count
                        and not cancel_requested()
                    ):
                        index, account, entry = assignments[next_assignment]
                        future = pool.submit(run_assignment, index, account, entry)
                        future_map[future] = index
                        next_assignment += 1

                submit_available()
                while future_map:
                    completed, _pending = wait(tuple(future_map), return_when=FIRST_COMPLETED)
                    for future in completed:
                        index = future_map.pop(future)
                        results[index] = future.result()
                    submit_available()

        final_results = [item for item in results if item is not None]
        success_count = sum(1 for item in final_results if item["ok"])
        return {
            "total": len(final_results),
            "success_count": success_count,
            "failure_count": len(final_results) - success_count,
            "target_ids": [item.id for item in targets],
            "phones": list(phone_stats.values()),
            "results": final_results,
            "concurrency": worker_count,
            "cancelled": cancel_requested(),
            "skipped_count": len(assignments) - len(final_results),
        }

    def _call_binder(
        self,
        account: AccountRecord,
        entry: PhoneBindEntry,
        *,
        browser_mode: str,
        bit_profile_id: str,
        log_fn: Callable[[str], Any] | None,
        cancel_check: Callable[[], bool] | None,
        sms_wait_seconds: int,
    ) -> dict[str, Any]:
        try:
            signature = inspect.signature(self.binder)
        except (TypeError, ValueError):
            return self.binder(account, entry) or {}
        if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in signature.parameters.values()):
            return self.binder(
                account,
                entry,
                browser_mode=browser_mode,
                bit_profile_id=bit_profile_id,
                log_fn=log_fn,
                cancel_check=cancel_check,
                sms_wait_seconds=sms_wait_seconds,
            ) or {}
        accepted = {
            name
            for name, param in signature.parameters.items()
            if param.kind in {inspect.Parameter.KEYWORD_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
        }
        kwargs: dict[str, Any] = {}
        if "browser_mode" in accepted:
            kwargs["browser_mode"] = browser_mode
        if "bit_profile_id" in accepted:
            kwargs["bit_profile_id"] = bit_profile_id
        if "log_fn" in accepted:
            kwargs["log_fn"] = log_fn
        if "cancel_check" in accepted:
            kwargs["cancel_check"] = cancel_check
        if "sms_wait_seconds" in accepted:
            kwargs["sms_wait_seconds"] = sms_wait_seconds
        return self.binder(account, entry, **kwargs) or {}

    def _resolve_targets(self, *, ids: list[int], fallback_ids: list[int], platform: str) -> list[AccountRecord]:
        if ids:
            items = [self.repository.get(account_id) for account_id in ids]
            return [item for item in items if item is not None and item.platform == platform]
        if fallback_ids:
            items = [self.repository.get(account_id) for account_id in fallback_ids]
            return [item for item in items if item is not None and item.platform == platform and not is_phone_bound(item)]
        return [
            item
            for item in self.repository.select_for_export(
                AccountExportSelection(platform=platform, select_all=True, status_filter="subscribed")
            )
            if not is_phone_bound(item)
        ]

    def _mark_bound(self, account: AccountRecord, entry: PhoneBindEntry, bind_result: dict[str, Any]) -> None:
        token_updates = _token_updates(bind_result)
        self.repository.update(
            account.id,
            AccountUpdateCommand(
                user_id=token_updates.get("account_id") or None,
                credentials=token_updates or None,
                primary_token=token_updates.get("access_token") or None,
                overview={
                    "phone_binding": {
                        "status": "bound",
                        "phone": entry.phone,
                        "sms_source": "relay",
                        "bound_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    }
                }
            ),
        )
