"""GoPay Midtrans 网页付款 —— 浏览器脚本驱动（不走协议）。

抓到 ``app.midtrans.com/.../redirection/<snap>`` 付款页后，在同一个 Playwright
page 上把 GoPay tokenization 付款 5 步走完：

  1. Link 页    ：输入手机号 -> 点继续（Lanjut/Hubungkan/Link）
  2. Consent 页 ：点 ``button[data-testid="consent-button"]``（Hubungkan）
  3. OTP 页     ：``input[data-testid="pin-input-field"]`` 输 6 位 OTP（接码平台）
  4. PIN 页     ：``input[data-testid="pin-input-0..5"]`` 输 6 位 GoPay PIN
  5. Pay 页     ：点 "Pay now"

DOM 选择器来自真实抓包（_gopay_capture 的 1-5.txt）。页面是 SPA（hash 路由），
各步出现顺序/是否已 linked 不固定，所以用"当前出现了哪一步的元素"的状态机
驱动，而不是写死顺序。
"""

from __future__ import annotations

import re
import time
from typing import Callable, Optional


def gopay_browser_pay(
    page,
    *,
    phone: str,
    pin: str,
    wait_otp: Callable[..., Optional[str]],
    timeout_seconds: int = 240,
    wa_wait_seconds: int = 62,
    log: Callable[[str], None] = print,
) -> dict:
    """在已停在 Midtrans GoPay 付款页的 ``page`` 上用浏览器脚本走完整付款。

    Args:
        page: 已在 app.midtrans.com 付款页的 Playwright page
        phone: GoPay 手机号（可带 +62 / 62 / local，内部统一成 local）
        pin: 6 位 GoPay PIN
        wait_otp: 拿付款 OTP 的回调 (phone, timeout) -> code|None（接码平台）
        timeout_seconds: 整个付款流程总超时秒数

    Returns:
        {"success": bool, "detail": str, "progress": dict}
    """
    local = re.sub(r"\D", "", str(phone or ""))
    if local.startswith("62"):
        local = local[2:]
    pin = re.sub(r"\D", "", str(pin or ""))

    deadline = time.time() + max(int(timeout_seconds or 240), 30)
    done = {"phone": False, "consent": False, "otp": False, "pin": False, "pay": False}
    otp_submitted = ""

    def _visible(selector: str) -> bool:
        try:
            loc = page.locator(selector).first
            return loc.count() > 0 and loc.is_visible()
        except Exception:
            return False

    def _click(selector: str) -> bool:
        try:
            loc = page.locator(selector).first
            if loc.count() > 0 and loc.is_visible():
                loc.click(timeout=5000)
                return True
        except Exception as exc:
            log(f"[pay] 点击失败 {selector}: {exc}")
        return False

    def _click_button_by_text(*patterns: str) -> bool:
        for pat in patterns:
            try:
                loc = page.get_by_role("button", name=re.compile(pat, re.I)).first
                if loc.count() > 0 and loc.is_visible() and loc.is_enabled():
                    loc.click(timeout=5000)
                    return True
            except Exception:
                pass
        try:
            btns = page.locator("button")
            n = min(btns.count(), 25)
            for i in range(n):
                b = btns.nth(i)
                try:
                    txt = (b.inner_text(timeout=1000) or "").strip()
                    cls = (b.get_attribute("class") or "")
                    # 跳过 disabled/inactive（midtrans 按钮用 class 标禁用态）
                    if "disabled" in cls or "inactive" in cls:
                        continue
                    if txt and any(re.search(p, txt, re.I) for p in patterns) and b.is_visible() and b.is_enabled():
                        b.click(timeout=5000)
                        return True
                except Exception:
                    continue
        except Exception:
            pass
        return False

    def _body_text() -> str:
        try:
            return page.locator("body").inner_text(timeout=5000) or ""
        except Exception:
            return ""

    def _click_sms_switch() -> bool:
        """找并点「发送/改用 SMS 验证码」的可点元素（button 或 link）。

        倒计时结束后才出现，文案大概率含 "SMS"（印尼语如 "Kirim lewat SMS"
        / "Kirim kode lewat SMS" / "Gunakan SMS"），所以按"可见可点 + 文本含
        SMS"匹配，不写死完整文案。
        """
        # 先试 button / link 角色 + 含 SMS
        for getter in ("button", "link"):
            try:
                loc = page.get_by_role(getter, name=re.compile(r"SMS", re.I)).first
                if loc.count() > 0 and loc.is_visible() and loc.is_enabled():
                    loc.click(timeout=4000)
                    return True
            except Exception:
                pass
        # 兜底：扫所有 button / a，文本含 SMS 且可点
        for sel in ("button", "a"):
            try:
                els = page.locator(sel)
                n = min(els.count(), 30)
                for i in range(n):
                    el = els.nth(i)
                    try:
                        txt = (el.inner_text(timeout=800) or "").strip()
                        cls = (el.get_attribute("class") or "")
                        if "disabled" in cls or "inactive" in cls:
                            continue
                        if re.search(r"SMS", txt, re.I) and el.is_visible():
                            el.click(timeout=4000)
                            return True
                    except Exception:
                        continue
            except Exception:
                pass
        return False

    def _wait_and_click_sms(deadline_ts: float, max_wait: int) -> bool:
        """等 WA 倒计时结束、出现 SMS 切换按钮就点；提前出现就提前点。"""
        wait_until = time.time() + max(int(max_wait or 0), 0)
        while time.time() < wait_until and time.time() < deadline_ts:
            if _click_sms_switch():
                return True
            time.sleep(3)
        # 倒计时刚到，再试一次（按钮可能此刻才渲染）
        return _click_sms_switch()

    log(f"[pay] 浏览器付款开始：phone=+62{local} pin={pin[:2] if pin else ''}****")

    while time.time() < deadline:
        # === Step 5: Pay 页（余额页，"Pay now"）===
        if (done["pin"] or done["consent"]) and _click_button_by_text(r"^\s*Pay now\s*$", r"Pay now", r"Bayar sekarang", r"Bayar"):
            done["pay"] = True
            log("[pay] Step5 点击 Pay now，等待支付结果…")
            time.sleep(5)
            txt = _body_text()
            if re.search(r"berhasil|success|paid|selesai|sukses|completed", txt, re.I):
                log("[pay] 支付成功")
                return {"success": True, "detail": "payment success", "progress": done}
            # 异步结果，再等一轮
            continue

        # === Step 4: PIN 页 ===
        if not done["pin"] and _visible('input[data-testid="pin-input-0"]'):
            if not pin or len(pin) < 6:
                return {"success": False, "detail": f"PIN 非法: {pin!r}", "progress": done}
            try:
                for i in range(6):
                    box = page.locator(f'input[data-testid="pin-input-{i}"]').first
                    box.click(timeout=3000)
                    box.fill(pin[i], timeout=3000)
                done["pin"] = True
                log("[pay] Step4 已输入 6 位 PIN")
                time.sleep(3)
                continue
            except Exception as exc:
                log(f"[pay] Step4 输入 PIN 失败: {exc}")

        # === Step 3: OTP 页 ===
        # GoPay 默认先发 WhatsApp OTP（接码平台收不到），要等约 60 秒倒计时后
        # 出现"发送 SMS 验证码"按钮，点它改用 SMS 发码，才能从接码平台拿到。
        if not done["otp"] and _visible('input[data-testid="pin-input-field"]'):
            if not done.get("otp_switched_sms"):
                log(f"[pay] Step3 OTP 页（默认 WhatsApp），等待 {wa_wait_seconds}s 倒计时后切 SMS…")
                switched = _wait_and_click_sms(deadline, wa_wait_seconds)
                done["otp_switched_sms"] = True
                if switched:
                    log("[pay] Step3 已点「发送 SMS 验证码」，改用 SMS 发码")
                    time.sleep(3)
                else:
                    log("[pay] Step3 未找到 SMS 切换按钮，仍按当前渠道等接码（可能拿不到 WA 码）")

            log("[pay] Step3 等待接码平台 SMS 验证码…")
            remaining = max(int(deadline - time.time()), 30)
            code = None
            try:
                code = wait_otp(f"+62{local}", min(remaining, 150))
            except Exception as exc:
                log(f"[pay] 拿 OTP 异常: {exc}")
            if not code:
                return {"success": False, "detail": "OTP 超时/未拿到", "progress": done}
            code = re.sub(r"\D", "", str(code))
            if code and code != otp_submitted:
                try:
                    box = page.locator('input[data-testid="pin-input-field"]').first
                    box.click(timeout=3000)
                    box.fill(code, timeout=3000)
                    otp_submitted = code
                    done["otp"] = True
                    log(f"[pay] Step3 已输入 OTP {code}")
                    time.sleep(4)
                    continue
                except Exception as exc:
                    log(f"[pay] Step3 输入 OTP 失败: {exc}")
            time.sleep(3)
            continue

        # === Step 2: Consent 页 ===
        if not done["consent"] and _visible('button[data-testid="consent-button"]'):
            if _click('button[data-testid="consent-button"]'):
                done["consent"] = True
                log("[pay] Step2 已点同意授权（Hubungkan）")
                time.sleep(4)
                continue

        # === Step 1: Link 页（输手机号）===
        if not done["phone"] and _visible('input[type="tel"]'):
            try:
                box = page.locator('input[type="tel"]').first
                box.click(timeout=3000)
                box.fill(local, timeout=3000)
                done["phone"] = True
                log(f"[pay] Step1 已输入手机号 {local}")
                time.sleep(1)
                _click_button_by_text(
                    r"Link and pay", r"Link & pay", r"Lanjut", r"Continue",
                    r"Hubungkan", r"Link", r"Next", r"Kirim",
                )
                time.sleep(4)
                continue
            except Exception as exc:
                log(f"[pay] Step1 输入手机号失败: {exc}")

        time.sleep(2)

    return {"success": False, "detail": f"付款超时，进度={done}", "progress": done}
