from __future__ import annotations

from types import SimpleNamespace

from platforms.chatgpt.constants import OPENAI_PAGE_TYPES
from platforms.chatgpt.register import RegistrationEngine, SignupFormResult


class _JsonResponse:
    status_code = 200
    text = '{"page":{"type":"email_otp_verification"}}'

    def json(self):
        return {"page": {"type": OPENAI_PAGE_TYPES["EMAIL_OTP_VERIFICATION"]}}


class _FakeSession:
    def __init__(self):
        self.posts = []

    def post(self, url, headers=None, data=None, timeout=None):
        self.posts.append((url, headers or {}, data))
        return _JsonResponse()


class _SendOtpResponse:
    status_code = 200
    text = '{"ok":true}'


class _EmailVerificationPageResponse:
    status_code = 200
    text = "<html>Email verification</html>"


def _bare_engine() -> RegistrationEngine:
    engine = object.__new__(RegistrationEngine)
    engine.email = "new@example.com"
    engine.password = "Secret123!"
    engine.email_info = {"service_id": "mailbox-1"}
    engine.session = _FakeSession()
    engine.logs = []
    engine.callback_logger = None
    engine.task_uuid = None
    engine.proxy_url = None
    engine._otp_sent_at = None
    engine._is_existing_account = False
    engine._device_id = None
    engine._sentinel_token = None
    engine._signup_sentinel = None
    engine._password_sentinel = None
    engine._create_account_continue_url = None
    engine._email_otp_continue_url = ""
    engine._email_otp_page_loaded = False
    engine._otp_continue_url = None
    engine._otp_page_type = None
    return engine


def test_signup_email_otp_page_is_not_treated_as_existing_account():
    engine = _bare_engine()

    result = engine._submit_signup_form("device-id", None)

    assert result.success is True
    assert result.page_type == "email_otp_verification"
    assert result.is_existing_account is False
    assert engine._is_existing_account is False


def test_protocol_email_otp_signup_sends_otp_without_password_step():
    engine = _bare_engine()
    calls = {"password": 0, "send": 0}

    def create_email():
        engine.email = "new@example.com"
        engine.email_info = {"service_id": "mailbox-1"}
        return True

    def register_password():
        calls["password"] += 1
        return False, None

    def send_otp():
        calls["send"] += 1
        return True

    engine._check_ip_location = lambda: (True, "JP")
    engine._create_email = create_email
    engine._init_session = lambda: True
    engine._start_oauth = lambda: True
    engine._get_device_id = lambda: "device-id"
    engine._check_sentinel = lambda did: None
    engine._submit_signup_form = lambda did, sen: SignupFormResult(
        success=True,
        page_type=OPENAI_PAGE_TYPES["EMAIL_OTP_VERIFICATION"],
        response_data={"page": {"type": OPENAI_PAGE_TYPES["EMAIL_OTP_VERIFICATION"]}},
    )
    engine._register_password = register_password
    engine._send_verification_code = send_otp
    engine._get_verification_code = lambda: None

    result = engine.run()

    assert result.success is False
    assert result.error_message == "获取验证码失败"
    assert calls == {"password": 0, "send": 1}


def test_protocol_password_is_marked_only_after_successful_password_submission():
    engine = _bare_engine()
    engine.password_was_set = False
    engine.http_client = SimpleNamespace(default_headers={"User-Agent": "Chrome/136.0"})
    candidates = iter(["GeneratedOne1!", "GeneratedTwo2!", "GeneratedThree3!"])
    engine._generate_password = lambda: next(candidates)
    engine._load_create_account_password_page = lambda: True

    ok, password = engine._register_password()

    assert ok is True
    assert password == "GeneratedOne1!"
    assert engine.password_was_set is True


def test_send_verification_code_uses_email_verification_referer():
    engine = _bare_engine()
    calls = []

    class SendSession:
        def get(self, url, headers=None, timeout=None):
            calls.append((url, headers or {}))
            return _SendOtpResponse()

    engine.session = SendSession()

    assert engine._send_verification_code() is True
    assert calls[-1][0].endswith("/api/accounts/email-otp/send")
    assert calls[-1][1]["referer"] == "https://auth.openai.com/email-verification"


def test_send_verification_code_visits_email_verification_page_before_send():
    engine = _bare_engine()
    engine._email_otp_continue_url = "https://auth.openai.com/email-verification"
    calls = []

    class SendSession:
        def get(self, url, headers=None, timeout=None):
            calls.append((url, headers or {}))
            if len(calls) == 1:
                return _EmailVerificationPageResponse()
            return _SendOtpResponse()

    engine.session = SendSession()

    assert engine._send_verification_code() is True
    assert calls[0][0] == "https://auth.openai.com/email-verification"
    assert calls[1][0].endswith("/api/accounts/email-otp/send")
    assert engine._email_otp_page_loaded is True
