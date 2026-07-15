"""
本地生成 Luhn 合规的虚拟 Visa 卡号 / 有效期 / CVV。

用途：CTF sandbox checkout 与 PayPal sandbox 注册（仅做格式 + Luhn + BIN
形式校验），不能用于真实商户授权。

设计要点：
- BIN 取自常见美国消费信用卡 Visa 真实 BIN，避免 ``4242424242424242`` 等
  公开测试 BIN 触发风控。
- 默认生成 16 位卡号；保留 13 位生成路径以备极少数旧产品需要。
- 有效期默认 2~4 年后，月份 01~12，避免 "已过期" 与 "首月即到期"。
- CVV 固定 3 位数字字符串。
- 接受可选 ``rng`` 注入，便于测试或种子复现。
"""

from __future__ import annotations

import random
from datetime import date
from typing import Optional


# PayPal 通过验卡风控对常规消费信用卡 BIN 越来越严格——生成的卡号即便
# Luhn 合规也会因为"BIN 在黑名单"被 PayPal 拒付（实战 reason 串
# ``CARD_GENERIC_ERROR``）。
#
# 用户指定 BIN 白名单（按优先级）：
#   - 4859    用户指定的预付卡卡头（4 位通配，length=16 时随机补齐）
#   - 424631  Capital One Quicksilver（曾为预付卡白名单实证可过）
#   - 414709  JPMorgan Chase Sapphire（同上）
#
# 如果发现某条 BIN 被 PayPal 拉黑，从此元组里删一条即可，不影响其它生成路径。
_VISA_BIN_PREFIXES = (
    "4859",
    "424631",
    "414709",
)


def _luhn_check_digit(partial: str) -> str:
    """根据无校验位的卡号字符串计算 Luhn 校验位。"""
    digits = [int(c) for c in partial]
    digits.reverse()
    total = 0
    for index, digit in enumerate(digits):
        # 完整卡号中校验位位于位置 0；当前 partial 反向后，位置 0 的数字
        # 在完整卡号里位于位置 1，应当被翻倍。即 partial 反向后偶数位翻倍。
        if index % 2 == 0:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return str((10 - total % 10) % 10)


def is_luhn_valid(card_number: str) -> bool:
    """校验给定字符串是否为 Luhn 合规的卡号。"""
    digits = [int(c) for c in str(card_number) if c.isdigit()]
    if len(digits) < 12:
        return False
    digits.reverse()
    total = 0
    for index, digit in enumerate(digits):
        if index % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def generate_visa_card(
    *,
    length: int = 16,
    years_ahead_min: int = 2,
    years_ahead_max: int = 4,
    today: Optional[date] = None,
    rng: Optional[random.Random] = None,
) -> dict:
    """生成一张 Luhn 合规的虚拟 Visa 卡，返回 ``card_*`` 字段字典。

    Args:
        length: 卡号长度，仅支持 13 或 16，默认 16。
        years_ahead_min: 有效期年份最少向后偏移。
        years_ahead_max: 有效期年份最多向后偏移。
        today: 当前日期，仅供测试注入。
        rng: 随机源，仅供测试注入。

    Returns:
        字典：``card_number``/``card_exp_month``/``card_exp_year``/``card_cvv``。
    """
    if length not in (13, 16):
        raise ValueError("Visa card length must be 13 or 16")
    if years_ahead_min < 1 or years_ahead_max < years_ahead_min:
        raise ValueError("invalid years_ahead range")

    rng = rng or random
    bin_prefix = rng.choice(_VISA_BIN_PREFIXES)
    if length == 13 and len(bin_prefix) > 6:
        bin_prefix = bin_prefix[:6]

    body_length = length - len(bin_prefix) - 1  # -1 给校验位
    body = "".join(str(rng.randint(0, 9)) for _ in range(body_length))
    partial = bin_prefix + body
    card_number = partial + _luhn_check_digit(partial)

    today_value = today or date.today()
    years_ahead = rng.randint(years_ahead_min, years_ahead_max)
    exp_year = today_value.year + years_ahead
    exp_month = rng.randint(1, 12)
    cvv = "".join(str(rng.randint(0, 9)) for _ in range(3))

    return {
        "card_number": card_number,
        "card_exp_month": str(exp_month).zfill(2),
        "card_exp_year": str(exp_year),
        "card_cvv": cvv,
    }


__all__ = (
    "generate_visa_card",
    "is_luhn_valid",
)
