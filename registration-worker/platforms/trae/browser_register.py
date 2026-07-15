"""Trae.ai 浏览器注册流程（Camoufox）。

注册流程：
  1. 打开 trae.ai/sign-up
  2. 填写邮箱 → 点击 "Send Code"
  3. 等待邮箱验证码（6位）→ 填写
  4. 填写密码 → 点击 "Sign Up"
  5. 等待跳转到 trae.ai 主页
  6. 从 Cookie / localStorage 提取 token

注意：Trae 使用 ByteDance Passport 系统，API 请求带有 X-Bogus/X-Gnarly 签名头，
浏览器模式自动生成这些头，无需额外处理。
"""
import random
import string
import time
from typing import Callable, Optional
from urllib.parse import urlparse

from camoufox.sync_api import Camoufox

TRAE_URL = "https://www.trae.ai"
TRAE_PASSPORT_DOMAIN = "ug-normal.trae.ai"


def _build_proxy_config(proxy: Optional[str]) -> Optional[dict]:
    if not proxy:
        return None
    parsed = urlparse(proxy)
    if not parsed.scheme or not parsed.hostname or not parsed.port:
        return {"server": proxy}
    config = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        config["username"] = parsed.username
    if parsed.password:
        config["password"] = parsed.password
    return config


def _wait_for_url(page, substring: str, timeout: int = 60) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if substring in page.url:
            return True
        time.sleep(1)
    return False


def _click_element(page, *selectors, timeout: int = 10) -> bool:
    """按选择器列表尝试点击第一个可见元素。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for sel in selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el.click()
                    return True
            except Exception:
                pass
        time.sleep(0.5)
    return False


def _get_trae_cloudide_token(page, log_fn=print) -> tuple:
    """注册完成后，用浏览器 session 调用 Trae API 获取 Cloud-IDE JWT token。

    流程同 core.py：
      step4: POST /cloudide/api/v3/trae/Login    （建立 IDE session）
      step5: POST /cloudide/api/v3/common/GetUserToken  →  Result.Token = Cloud-IDE JWT
      step6: POST /cloudide/api/v3/trae/CheckLogin  →  Region / UserId 等
    """
    BASE_URL = "https://ug-normal.trae.ai"
    API_SG = "https://api-sg-central.trae.ai"

    token = ""
    user_id = ""
    region = ""

    # step4: Trae Login（建立 IDE session）
    try:
        log_fn("调用 Trae Login API...")
        page.evaluate(f"""
        async () => {{
            await fetch("{BASE_URL}/cloudide/api/v3/trae/Login?type=email", {{
                method: "POST",
                headers: {{"content-type": "application/json"}},
                credentials: "include",
                body: JSON.stringify({{
                    "UtmSource": "", "UtmMedium": "", "UtmCampaign": "",
                    "UtmTerm": "", "UtmContent": "", "BDVID": "",
                    "LoginChannel": "ide_platform"
                }})
            }});
        }}
        """)
        time.sleep(1)
    except Exception as e:
        log_fn(f"⚠️ Trae Login 失败: {e}")

    # step5: GetUserToken → Cloud-IDE JWT
    try:
        log_fn("获取 Cloud-IDE JWT token...")
        result = page.evaluate(f"""
        async () => {{
            const r = await fetch("{API_SG}/cloudide/api/v3/common/GetUserToken", {{
                method: "POST",
                headers: {{"content-type": "application/json"}},
                credentials: "include",
                body: JSON.stringify({{}})
            }});
            return await r.json();
        }}
        """)
        token = (result or {}).get("Result", {}).get("Token", "") or ""
        if token:
            log_fn(f"✅ 获取到 Cloud-IDE JWT (长度={len(token)})")
    except Exception as e:
        log_fn(f"⚠️ GetUserToken 失败: {e}")

    # step6: CheckLogin → userId / Region
    if token:
        try:
            result2 = page.evaluate(f"""
            async () => {{
                const r = await fetch("{BASE_URL}/cloudide/api/v3/trae/CheckLogin", {{
                    method: "POST",
                    headers: {{
                        "content-type": "application/json",
                        "Authorization": "Cloud-IDE-JWT {token}"
                    }},
                    credentials: "include",
                    body: JSON.stringify({{"GetAIPayHost": true, "GetNickNameEditStatus": true}})
                }});
                return await r.json();
            }}
            """)
            res = (result2 or {}).get("Result", {})
            user_id = str(res.get("UserId", "") or res.get("userId", ""))
            region = res.get("Region", "")
        except Exception as e:
            log_fn(f"⚠️ CheckLogin 失败: {e}")

    # 兜底：从 Cookie 提取 user_id
    if not user_id:
        try:
            cookies = {c["name"]: c["value"] for c in page.context.cookies()}
            user_id = cookies.get("user_id", cookies.get("userId", ""))
        except Exception:
            pass

    # 终极兜底：从 JWT payload 解出 id
    if not user_id and token:
        try:
            import base64, json as _json
            payload = token.split(".")[1]
            payload += "==" * (4 - len(payload) % 4)
            data = _json.loads(base64.urlsafe_b64decode(payload))
            user_id = str(data.get("data", {}).get("id", ""))
        except Exception:
            pass

    return token, user_id, region


class TraeBrowserRegister:
    def __init__(
        self,
        *,
        headless: bool = True,
        proxy: Optional[str] = None,
        otp_callback: Optional[Callable[[], str]] = None,
        log_fn: Callable[[str], None] = print,
    ):
        self.headless = headless
        self.proxy = proxy
        self.otp_callback = otp_callback
        self.log = log_fn

    def run(self, email: str, password: str) -> dict:
        if not self.otp_callback:
            raise RuntimeError("Trae 注册需要邮箱验证码但未提供 otp_callback")

        # 生成密码（如果未提供）
        if not password:
            password = (
                ''.join(random.choices(string.ascii_uppercase, k=2))
                + ''.join(random.choices(string.digits, k=3))
                + ''.join(random.choices(string.ascii_lowercase, k=5))
                + '!'
            )

        proxy = _build_proxy_config(self.proxy)
        launch_opts = {"headless": self.headless}
        if proxy:
            launch_opts["proxy"] = proxy

        with Camoufox(**launch_opts) as browser:
            page = browser.new_page()

            # 1. 打开注册页
            self.log("打开 Trae 注册页")
            page.goto(f"{TRAE_URL}/sign-up", wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)

            # 2. 填写邮箱
            self.log(f"填写邮箱: {email}")
            email_selectors = [
                'input[placeholder="Email"]',
                'input[type="email"]',
                'input[name="email"]',
                'input[placeholder*="email" i]',
            ]
            email_el = None
            deadline_email = time.time() + 20
            while time.time() < deadline_email:
                for sel in email_selectors:
                    try:
                        el = page.query_selector(sel)
                        if el and el.is_visible():
                            email_el = el
                            break
                    except Exception:
                        pass
                if email_el:
                    break
                time.sleep(0.5)

            if not email_el:
                raise RuntimeError(f"未找到邮箱输入框: {page.url}")

            email_el.click()
            email_el.fill(email)
            time.sleep(0.5)

            # 3. 点击 "Send Code" 按钮
            self.log("发送验证码...")
            # 使用 JS 找到包含精确文本的最小 leaf 元素并点击
            send_clicked = False
            deadline_send = time.time() + 15
            while time.time() < deadline_send and not send_clicked:
                try:
                    # Playwright text= 选择器比 CSS has-text 更精确
                    el = page.locator('text="Send Code"').last
                    if el.is_visible():
                        el.click()
                        send_clicked = True
                        self.log("已点击 Send Code")
                        break
                except Exception:
                    pass
                # 备用：JS 遍历找到精确包含 Send Code 文字的元素
                if not send_clicked:
                    try:
                        page.evaluate("""
                        () => {
                            const all = document.querySelectorAll('*');
                            for (const el of all) {
                                if (el.children.length === 0 && el.textContent.trim() === 'Send Code') {
                                    el.click();
                                    return;
                                }
                            }
                        }
                        """)
                        send_clicked = True
                        self.log("已点击 Send Code (JS)")
                    except Exception:
                        pass
                time.sleep(1)

            if not send_clicked:
                self.log("⚠️ 未能点击 Send Code，尝试 Tab+Enter")
                page.keyboard.press("Tab")
                time.sleep(0.3)
                page.keyboard.press("Enter")

            time.sleep(2)

            # 4. 等待 OTP 输入框
            self.log("等待邮箱验证码...")
            otp_selectors = [
                'input[placeholder="Verification code"]',
                'input[placeholder*="verification" i]',
                'input[placeholder*="code" i]',
                'input[name="code"]',
                'input[autocomplete="one-time-code"]',
                'input[inputmode="numeric"]',
            ]
            otp_el = None
            deadline_otp = time.time() + 60
            while time.time() < deadline_otp:
                for sel in otp_selectors:
                    try:
                        el = page.query_selector(sel)
                        if el and el.is_visible():
                            otp_el = el
                            break
                    except Exception:
                        pass
                if otp_el:
                    break
                time.sleep(1)

            if not otp_el:
                raise RuntimeError(f"未出现验证码输入框: {page.url}")

            code = self.otp_callback()
            if not code:
                raise RuntimeError("未获取到邮箱验证码")
            self.log(f"填写验证码: {code}")
            otp_el.click()
            otp_el.fill(str(code).strip())
            time.sleep(0.5)

            # 5. 填写密码
            self.log("填写密码...")
            pwd_selectors = [
                'input[placeholder="Password"]',
                'input[type="password"]',
                'input[name="password"]',
            ]
            for sel in pwd_selectors:
                try:
                    el = page.query_selector(sel)
                    if el and el.is_visible():
                        el.click()
                        el.fill(password)
                        time.sleep(0.3)
                        break
                except Exception:
                    pass

            # 6. 点击 "Sign Up"
            self.log("提交注册...")
            signup_clicked = False
            deadline_signup = time.time() + 10
            while time.time() < deadline_signup and not signup_clicked:
                try:
                    el = page.locator('text="Sign Up"').last
                    if el.is_visible():
                        el.click()
                        signup_clicked = True
                        self.log("已点击 Sign Up")
                        break
                except Exception:
                    pass
                if not signup_clicked:
                    try:
                        page.evaluate("""
                        () => {
                            const all = document.querySelectorAll('*');
                            for (const el of all) {
                                const t = el.textContent.trim();
                                if (el.children.length === 0 && (t === 'Sign Up' || t === 'Sign up')) {
                                    el.click();
                                    return;
                                }
                            }
                        }
                        """)
                        signup_clicked = True
                        self.log("已点击 Sign Up (JS)")
                    except Exception:
                        pass
                time.sleep(0.5)

            if not signup_clicked:
                self.log("⚠️ 未能点击 Sign Up，尝试 Enter")
                page.keyboard.press("Enter")

            time.sleep(3)

            # 7. 等待跳转（离开 sign-up 页）
            self.log("等待注册完成...")
            deadline_done = time.time() + 30
            while time.time() < deadline_done:
                if "sign-up" not in page.url and "trae.ai" in page.url:
                    break
                time.sleep(1)

            time.sleep(2)

            # 8. 提取 token
            self.log("提取 Trae token...")
            token, user_id, region = _get_trae_cloudide_token(page, self.log)

            if not token:
                self.log("⚠️ 未从 Cookie 获取到 token，尝试等待...")
                time.sleep(5)
                token, user_id, region = _get_trae_cloudide_token(page, self.log)

            self.log(f"✓ 注册成功: {email}")
            return {
                "email": email,
                "password": password,
                "token": token,
                "user_id": user_id,
                "region": region,
                "cashier_url": "",
                "ai_pay_host": "",
            }
