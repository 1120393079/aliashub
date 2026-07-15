from __future__ import annotations

import random
from datetime import date

import pytest

from platforms.chatgpt.card_generator import (
    _VISA_BIN_PREFIXES,
    _luhn_check_digit,
    generate_visa_card,
    is_luhn_valid,
)


@pytest.mark.parametrize(
    "known_valid",
    [
        "4242424242424242",   # Stripe test
        "4111111111111111",   # Visa classic test
        "5555555555554444",   # Mastercard test
        "378282246310005",    # Amex test (15 digits)
    ],
)
def test_is_luhn_valid_accepts_known_test_cards(known_valid):
    assert is_luhn_valid(known_valid)


@pytest.mark.parametrize(
    "tampered",
    [
        "4242424242424241",
        "4111111111111112",
        "1234567812345678",
    ],
)
def test_is_luhn_valid_rejects_invalid_numbers(tampered):
    assert not is_luhn_valid(tampered)


def test_is_luhn_valid_rejects_too_short():
    assert not is_luhn_valid("123")
    assert not is_luhn_valid("")


def test_luhn_check_digit_round_trips_for_visa_bins():
    rng = random.Random(0xC0FFEE)
    for bin_prefix in _VISA_BIN_PREFIXES:
        body_length = 16 - len(bin_prefix) - 1
        body = "".join(str(rng.randint(0, 9)) for _ in range(body_length))
        partial = bin_prefix + body
        full = partial + _luhn_check_digit(partial)
        assert is_luhn_valid(full), f"BIN {bin_prefix} 生成的卡号 {full} 未通过 Luhn"
        assert len(full) == 16


def test_generate_visa_card_returns_luhn_valid_16_digit_visa():
    card = generate_visa_card(rng=random.Random(123))

    assert isinstance(card, dict)
    assert set(card) == {"card_number", "card_exp_month", "card_exp_year", "card_cvv"}
    number = card["card_number"]
    assert len(number) == 16
    assert number.startswith("4"), number
    assert number.isdigit()
    assert is_luhn_valid(number)


def test_generate_visa_card_uses_curated_bin():
    card = generate_visa_card(rng=random.Random(7))
    number = card["card_number"]
    matches = [bin_prefix for bin_prefix in _VISA_BIN_PREFIXES if number.startswith(bin_prefix)]
    assert matches, f"卡号 {number} 未匹配任何受管理 BIN"


def test_generate_visa_card_expiry_in_future_window():
    today = date(2025, 6, 1)
    card = generate_visa_card(today=today, rng=random.Random(42))

    month = int(card["card_exp_month"])
    year = int(card["card_exp_year"])
    assert 1 <= month <= 12
    assert 2025 + 2 <= year <= 2025 + 4
    assert len(card["card_exp_month"]) == 2
    assert len(card["card_exp_year"]) == 4


def test_generate_visa_card_cvv_is_three_digits():
    for seed in range(20):
        cvv = generate_visa_card(rng=random.Random(seed))["card_cvv"]
        assert len(cvv) == 3
        assert cvv.isdigit()


def test_generate_visa_card_supports_13_digit_legacy_format():
    card = generate_visa_card(length=13, rng=random.Random(11))
    number = card["card_number"]

    assert len(number) == 13
    assert number.startswith("4")
    assert is_luhn_valid(number)


def test_generate_visa_card_rejects_invalid_length():
    with pytest.raises(ValueError, match="length"):
        generate_visa_card(length=15)


def test_generate_visa_card_rejects_invalid_year_range():
    with pytest.raises(ValueError, match="years_ahead"):
        generate_visa_card(years_ahead_min=0)
    with pytest.raises(ValueError, match="years_ahead"):
        generate_visa_card(years_ahead_min=5, years_ahead_max=3)


def test_generate_visa_card_is_random_across_calls():
    seen_numbers = {generate_visa_card()["card_number"] for _ in range(20)}
    # 20 次调用至少出现 5 个不同卡号即视为足够熵
    assert len(seen_numbers) >= 5


def test_generate_visa_card_seed_is_deterministic():
    card1 = generate_visa_card(rng=random.Random(99), today=date(2025, 1, 1))
    card2 = generate_visa_card(rng=random.Random(99), today=date(2025, 1, 1))
    assert card1 == card2
