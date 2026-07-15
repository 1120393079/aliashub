from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import inspect
import threading
from typing import Any, Callable

from domain.accounts import AccountExportSelection, AccountRecord, AccountUpdateCommand
from infrastructure.accounts_repository import AccountsRepository


MAX_ACCOUNTS_PER_PHONE = 3


@dataclass(frozen=True, slots=True)
class PhoneBindEntry:
    phone: str
    sms_api: str


Binder = Callable[..., dict[str, Any]]


def _normalize_phone(value: str) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if not digits:
        return ""
    if len(digits) == 10:
        return f"+1{digits}"
    return f"+{digits}"


def parse_phone_bind_lines(raw: str) -> list[PhoneBindEntry]:
    entries: list[PhoneBindEntry] = []
    for line in str(raw or "").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        if "----" not in text:
            raise ValueError(f"invalid phone line: {text}")
        phone_raw, sms_api = text.split("----", 1)
        phone = _normalize_phone(phone_raw)
        sms_api = sms_api.strip()
        if not phone or not sms_api.startswith(("http://", "https://")):
            raise ValueError(f"invalid phone line: {text}")
        entries.append(PhoneBindEntry(phone=phone, sms_api=sms_api))
    if not entries:
        raise ValueError("phone_lines is empty")
    return entries


def is_phone_bound(account: AccountRecord) -> bool:
    binding = account.overview.get("phone_binding") if isinstance(account.overview, dict) else None
    return isinstance(binding, dict) and binding.get("status") == "bound"


def default_phone_binder(
    account: AccountRecord,
    phone_entry: PhoneBindEntry,
    *,
    browser_mode: str = "camoufox_headed",
    bit_profile_id: str = "",
    log_fn: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    log = log_fn or (lambda _message: None)
    acquired_profile_id = ""
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
        callback = SmsApiPhoneCallback(phone_entry)
        log(f"准备为 {account.email} 绑定手机号 {phone_entry.phone}，浏览器模式 {browser_mode}")
        worker = ChatGPTBrowserRegister(
            headless=backend_config.is_headless,
            phone_callback=callback,
            log_fn=log,
            backend_config=backend_config,
        )
        result = worker._retry_oauth_fresh_browser(account.email, account.password)
        if not isinstance(result, dict) or not result.get("access_token"):
            return {
                "ok": False,
                "error": "Codex OAuth phone binding did not return tokens",
                "account_id": account.id,
                "phone": phone_entry.phone,
            }
        return {
            "ok": True,
            "phone": phone_entry.phone,
            **result,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "account_id": account.id,
            "phone": phone_entry.phone,
        }
    finally:
        if acquired_profile_id:
            release_acquired_profile(acquired_profile_id, log_fn=log)


def _fetch_phone_sms_code(entry: PhoneBindEntry, *, excluded_pins: set[str] | None = None) -> str:
    from platforms.chatgpt.payment import _fetch_ctf_relay_code

    return _fetch_ctf_relay_code(
        url=entry.sms_api,
        timeout_seconds=30,
        poll_interval_seconds=3,
        log=lambda _message: None,
        excluded_pins=excluded_pins or set(),
    )


class SmsApiPhoneCallback:
    def __init__(self, entry: PhoneBindEntry):
        self.entry = entry
        self.phase = "need_number"
        self.completed = False
        self.activation = None
        self._resend_callback: Callable[[], Any] | None = None
        self._used_codes: set[str] = set()

    def __call__(self) -> str:
        if self.phase == "need_number":
            self.phase = "need_code"
            return self.entry.phone
        code = _fetch_phone_sms_code(self.entry, excluded_pins=self._used_codes)
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
    ) -> dict[str, Any]:
        entries = parse_phone_bind_lines(phone_lines)
        targets = self._resolve_targets(
            ids=[int(item) for item in ids or [] if int(item or 0) > 0],
            fallback_ids=[int(item) for item in fallback_ids or [] if int(item or 0) > 0],
            platform=platform,
        )
        capacity = len(entries) * MAX_ACCOUNTS_PER_PHONE
        if len(targets) > capacity:
            raise ValueError(f"selected account count exceeds phone capacity: accounts={len(targets)} capacity={capacity}")

        phone_stats = {
            entry.phone: {"phone": entry.phone, "sms_api": entry.sms_api, "used": 0, "success": 0, "failed": 0}
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

        def run_assignment(index: int, account: AccountRecord, entry: PhoneBindEntry) -> dict[str, Any]:
            try:
                if hasattr(task_logger, "set_subtask"):
                    task_logger.set_subtask(f"worker_{index + 1}", f"{account.email}")
                with stats_lock:
                    phone_stats[entry.phone]["used"] += 1
                if log_fn:
                    log_fn(f"[{index + 1}/{len(targets)}] 开始绑定 {account.email} -> {entry.phone}")
                try:
                    # A single phone/SMS inbox is shared across up to 3 accounts.
                    # Serialize per phone so verification codes do not get consumed
                    # by another account's in-flight auth flow.
                    with phone_locks[entry.phone]:
                        bind_result = self._call_binder(
                            account,
                            entry,
                            browser_mode=browser_mode,
                            bit_profile_id=bit_profile_id,
                            log_fn=log_fn,
                        )
                    ok = bool(bind_result.get("ok"))
                    error = str(bind_result.get("error") or "")
                except Exception as exc:
                    ok = False
                    error = str(exc)

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
                results[index] = run_assignment(index, account, entry)
        else:
            with ThreadPoolExecutor(max_workers=worker_count) as pool:
                future_map = {
                    pool.submit(run_assignment, index, account, entry): index
                    for index, account, entry in assignments
                }
                for future in as_completed(future_map):
                    index = future_map[future]
                    results[index] = future.result()

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
        }

    def _call_binder(
        self,
        account: AccountRecord,
        entry: PhoneBindEntry,
        *,
        browser_mode: str,
        bit_profile_id: str,
        log_fn: Callable[[str], Any] | None,
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
                        "sms_api": entry.sms_api,
                        "bound_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    }
                }
            ),
        )
