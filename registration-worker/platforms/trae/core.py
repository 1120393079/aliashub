"""Trae.ai 注册协议核心实现"""
import os, random, secrets, string
from typing import Optional, Callable

BASE_URL = "https://ug-normal.trae.ai"
API_SG   = "https://api-sg-central.trae.ai"
AID      = "677332"
SDK_VER  = "2.1.10-tiktok"


def _new_verify_fp() -> str:
    prefix = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    suffix = "".join(secrets.choice(string.ascii_letters + string.digits + "_-") for _ in range(40))
    return f"verify_{prefix}_{suffix}"


VERIFY_FP = os.environ.get("TRAE_VERIFY_FP", "").strip() or _new_verify_fp()


def _rand_password(n=14):
    chars = string.ascii_letters + string.digits + "!@#"
    return "".join(random.choices(chars, k=n))


def _base_params():
    return {
        "aid": AID,
        "account_sdk_source": "web",
        "sdk_version": SDK_VER,
        "language": "en",
        "verifyFp": VERIFY_FP,
    }


class TraeRegister:
    def __init__(self, executor, log_fn: Callable = print):
        self.ex = executor
        self.log = log_fn

    def step1_region(self):
        self.ex.post(f"{BASE_URL}/passport/web/region/",
                     params=_base_params(), data={"type": "2"})

    def step2_send_code(self, email: str):
        self.log("发送验证码...")
        r = self.ex.post(f"{BASE_URL}/passport/web/email/send_code/",
                         params=_base_params(),
                         data={"type": "1", "email": email,
                               "password": "", "email_logic_type": "2"})
        if r.json().get("message") != "success":
            raise RuntimeError(f"send_code 失败: {r.text}")
        self.log("验证码已发送，等待邮件...")

    def step3_register(self, email: str, password: str, otp: str):
        self.log(f"提交注册... otp={otp}")
        r = self.ex.post(f"{BASE_URL}/passport/web/email/register_verify_login/",
                         params=_base_params(),
                         data={"type": "1", "email": email, "password": password,
                               "code": otp, "email_logic_type": "2"})
        j = r.json()
        if j.get("message") != "success" and not j.get("data", {}).get("user_id_str"):
            raise RuntimeError(f"register 失败: {r.text}")
        return j["data"]["user_id_str"]

    def step4_trae_login(self):
        self.ex.post(f"{BASE_URL}/cloudide/api/v3/trae/Login",
                     params={"type": "email"},
                     json={"UtmSource": "", "UtmMedium": "", "UtmCampaign": "",
                           "UtmTerm": "", "UtmContent": "", "BDVID": "",
                           "LoginChannel": "ide_platform"})

    def step5_get_token(self):
        r = self.ex.post(f"{API_SG}/cloudide/api/v3/common/GetUserToken", json={})
        return r.json().get("Result", {}).get("Token", "")

    def step6_check_login(self):
        r = self.ex.post(f"{BASE_URL}/cloudide/api/v3/trae/CheckLogin",
                         json={"GetAIPayHost": True, "GetNickNameEditStatus": True})
        return r.json().get("Result", {})

    def step7_create_order(self, token: str):
        try:
            r = self.ex.post(f"{API_SG}/trae/api/v1/pay/create_order",
                             headers={"Authorization": f"Cloud-IDE-JWT {token}"},
                             json={"product_ids": ["2"],
                                   "result_url": "https://www.trae.ai/account-setting"
                                                 "?type=upgrade&identity=1#subscription"})
            self.log(f"  create_order status={r.status_code} resp={r.text[:200]}")
            return r.json().get("order_info", {}).get("cashier_url", "")
        except Exception as e:
            self.log(f"  create_order 失败: {e}")
            return ""
