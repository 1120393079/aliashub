from __future__ import annotations

from dataclasses import replace
import threading
from typing import Any, Callable

from .auth import account_email, normalize_access_token
from .checkout import check_coupon_eligibility, create_checkout, require_country_currency, update_checkout
from .config import (
    DEFAULT_RETRY_COUNT,
    billing_for_country,
    country_config,
    currency_minor_scale,
    normalize_payment_method,
    normalize_retry_count,
)
from .errors import CheckoutApprovalBlocked, ConfigurationError, ExtractionCancelled
from .flows.cs_live import extract_cs_live_provider
from .flows.oaics import extract_oaics_provider
from .logging_utils import emit_log, stage_logger
from .models import ExtractionConfig, PaymentLinkResult
from .transport import DefaultTransportFactory, TransportFactory, safe_close, select_proxy_route
from .stripe_common import checkout_payable_amount


def _normalize_config(config: ExtractionConfig) -> ExtractionConfig:
    token = normalize_access_token(config.access_token)
    if not token:
        raise ConfigurationError("AT is required")
    if not str(config.checkout_proxy or "").strip():
        raise ConfigurationError("checkout proxy is required")
    if config.apply_checkout_update and not str(config.update_proxy or "").strip():
        raise ConfigurationError("update proxy is required")
    country, *_ = country_config(config.country)
    payment_method = normalize_payment_method(config.payment_method)
    retry_count = normalize_retry_count(
        getattr(config, "retry_count", DEFAULT_RETRY_COUNT),
    )
    return replace(
        config,
        access_token=token,
        checkout_proxy=str(config.checkout_proxy).strip(),
        update_proxy=str(config.update_proxy).strip(),
        stripe_hcaptcha_token=str(config.stripe_hcaptcha_token or "").strip(),
        country=country,
        payment_method=payment_method,
        retry_count=retry_count,
    )


def _attempt_limit(config: ExtractionConfig) -> int:
    """Return the number of complete Checkout rounds for this task.

    The zero-price PayPal promotion has one extra recovery floor. A caller
    setting ``retry_count=1`` still gets an initial Checkout plus one fresh
    Checkout if approval is blocked; non-PayPal and non-promo flows retain the
    literal total-round semantics (``retry_count=1`` means one round).
    """
    if config.apply_checkout_update and config.payment_method == "paypal":
        return max(2, config.retry_count)
    return config.retry_count


def extract_payment_link(
    config: ExtractionConfig,
    *,
    transport_factory: TransportFactory | None = None,
    cancel_event: threading.Event | None = None,
    stage_callback: Callable[[str], None] | None = None,
) -> PaymentLinkResult:
    def checkpoint(stage: str) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise ExtractionCancelled("task cancellation requested")
        if stage_callback is not None:
            stage_callback(stage)

    config = _normalize_config(config)
    billing = billing_for_country(config.country).to_dict()
    factory = transport_factory or DefaultTransportFactory()
    attempt_limit = _attempt_limit(config)

    def run_attempt(attempt_config: ExtractionConfig, attempt_number: int) -> PaymentLinkResult:
        """Run exactly one Checkout lifecycle.

        A blocked approval unwinds this function completely. The outer loop
        then creates fresh transport sessions and a new Checkout rather than
        replaying confirm/approve on the old session.
        """
        log = stage_logger(
            attempt_config.verbose,
            checkout_attempt=attempt_number,
            checkout_attempt_limit=attempt_limit,
        )
        chatgpt = None
        stripe = None
        try:
            chatgpt = factory.chatgpt(attempt_config, attempt_config.checkout_proxy)
            if attempt_config.apply_checkout_update:
                checkpoint("eligibility_check")
                check_coupon_eligibility(attempt_config, chatgpt, log)
            checkpoint("checkout")
            checkout = create_checkout(attempt_config, chatgpt, log)
            checkpoint(f"checkout_kind:{checkout['session_kind']}")
            if attempt_config.oaics_only and checkout["session_kind"] == "stripe_checkout":
                raise ConfigurationError("仅 OAICS 模式下检测到 CS Checkout，任务已失败")
            require_country_currency(checkout, attempt_config)
            if attempt_config.apply_checkout_update:
                checkpoint("checkout_update")
                update_checkout(attempt_config, chatgpt, checkout, log)
                require_country_currency(checkout, attempt_config)
            stripe = factory.stripe(attempt_config)
            if checkout["session_kind"] == "stripe_checkout":
                checkpoint("stripe_init")
                provider = extract_cs_live_provider(
                    attempt_config,
                    chatgpt,
                    stripe,
                    checkout,
                    billing,
                    log,
                    stage_callback=checkpoint,
                )
            elif checkout["session_kind"] == "openai_custom_checkout":
                checkpoint("stripe_init")
                provider = extract_oaics_provider(
                    attempt_config,
                    chatgpt,
                    stripe,
                    checkout,
                    billing,
                    log,
                    stage_callback=checkpoint,
                )
            else:
                raise ConfigurationError(f"unsupported checkout session: {checkout.get('cs_id')}")
            require_country_currency(checkout, attempt_config, require_observed_currency=True)
            amount_due_minor, amount_currency = checkout_payable_amount(checkout)
            scale = currency_minor_scale(amount_currency)
            amount_due = amount_due_minor / (10**scale)
            provider_field = f"{attempt_config.payment_method}_url"
            provider_value = str(provider.get(provider_field) or provider.get("provider_url") or "")
            result = PaymentLinkResult(
                checkout_session_id=str(checkout["cs_id"]),
                session_kind=str(checkout["session_kind"]),
                payment_method=attempt_config.payment_method,
                billing_country=attempt_config.country,
                currency=amount_currency,
                amount_due=amount_due,
                amount_due_minor=amount_due_minor,
                billing=billing_for_country(attempt_config.country),
                account_email=account_email(attempt_config.access_token),
                payment_method_id=str(provider.get("payment_method_id") or ""),
                stripe_redirect_url=str(provider.get("stripe_redirect_url") or ""),
                provider_url=str(provider.get("provider_url") or provider_value),
                provider_field=provider_field,
                provider_value=provider_value,
                extra={
                    "checkout_attempt": attempt_number,
                    "checkout_attempt_limit": attempt_limit,
                    "retry_count": config.retry_count,
                },
            )
            checkpoint("completed")
            return result
        finally:
            safe_close(stripe)
            safe_close(chatgpt)

    last_blocked: CheckoutApprovalBlocked | None = None
    for attempt_index in range(attempt_limit):
        if attempt_index:
            checkpoint("checkout_retry")
        attempt_config = replace(
            config,
            checkout_proxy=select_proxy_route(config.checkout_proxy, attempt_index),
            update_proxy=select_proxy_route(config.update_proxy, attempt_index),
        )
        try:
            return run_attempt(attempt_config, attempt_index + 1)
        except CheckoutApprovalBlocked as exc:
            last_blocked = exc
            if attempt_index + 1 >= attempt_limit:
                detail = (
                    f"{exc.detail}; blocked 后已用尽 {attempt_limit} 轮 Checkout，"
                    "未在原 Checkout 上重复 confirm"
                )
                raise CheckoutApprovalBlocked(
                    detail,
                    result=exc.result,
                    status_code=exc.status_code,
                    attempts=attempt_limit,
                ) from exc
            log = stage_logger(config.verbose)
            emit_log(
                log,
                f"ChatGPT approval blocked; discard Checkout and start fresh attempt "
                f"{attempt_index + 2}/{attempt_limit}",
            )
            checkpoint("checkout_retry")

    # The loop always returns or raises. Keep a defensive branch for static
    # type checkers and unusual custom iterables used by integrations.
    if last_blocked is not None:
        raise last_blocked
    raise RuntimeError("payment link extraction ended without a result")
