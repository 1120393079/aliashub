import base64
import json
from datetime import datetime, timezone

from platforms.chatgpt.cpa_session import (
    convert_chatgpt_session_to_cpa_json,
    export_workspace_cpa_session_from_browser,
    parse_jwt_payload,
    save_cpa_json_locally,
    switch_chatgpt_workspace_via_profile_menu,
)


def _jwt(payload: dict) -> str:
    def enc(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return f"{enc({'alg': 'none', 'typ': 'JWT'})}.{enc(payload)}."


def test_convert_chatgpt_session_to_cpa_json_builds_cpa_fields_from_session():
    access_token = _jwt(
        {
            "iat": 1_700_000_000,
            "exp": 1_700_086_400,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acc-workspace",
                "chatgpt_user_id": "user-workspace",
                "chatgpt_plan_type": "workspace",
            },
            "https://api.openai.com/profile": {"email": "user@example.com"},
        }
    )

    cpa_json = convert_chatgpt_session_to_cpa_json(
        {
            "accessToken": access_token,
            "sessionToken": "session-token",
        },
        now=datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc),
    )

    assert cpa_json["type"] == "codex"
    assert cpa_json["account_id"] == "acc-workspace"
    assert cpa_json["chatgpt_account_id"] == "acc-workspace"
    assert cpa_json["email"] == "user@example.com"
    assert cpa_json["plan_type"] == "workspace"
    assert cpa_json["chatgpt_plan_type"] == "workspace"
    assert cpa_json["access_token"] == access_token
    assert cpa_json["refresh_token"] == ""
    assert cpa_json["session_token"] == "session-token"
    assert cpa_json["last_refresh"] == "2026-07-01T00:00:00Z"
    assert cpa_json["expired"] == "2023-11-15T22:13:20Z"
    assert cpa_json["id_token_synthetic"] is True
    assert parse_jwt_payload(cpa_json["id_token"])["https://api.openai.com/auth"] == {
        "chatgpt_account_id": "acc-workspace",
        "chatgpt_plan_type": "workspace",
        "chatgpt_user_id": "user-workspace",
        "user_id": "user-workspace",
    }


def test_save_cpa_json_locally_writes_sanitized_json_file(tmp_path):
    cpa_json = {"type": "codex", "email": "User+One@example.com"}

    saved = save_cpa_json_locally(
        cpa_json,
        email="User+One@example.com",
        output_dir=tmp_path,
        now=datetime(2026, 7, 1, 1, 2, 3, tzinfo=timezone.utc),
    )

    assert saved.name == "user-one-example-com_2026-07-01_01-02-03.json"
    assert json.loads(saved.read_text(encoding="utf-8")) == cpa_json


def test_export_workspace_cpa_session_from_browser_switches_workspace_and_saves(tmp_path):
    access_token = _jwt(
        {
            "iat": 1_700_000_000,
            "exp": 1_700_086_400,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "workspace-account",
                "chatgpt_plan_type": "workspace",
            },
            "https://api.openai.com/profile": {"email": "member@example.com"},
        }
    )

    class FakePage:
        def __init__(self):
            self.gotos = []
            self.evaluate_args = []

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def wait_for_timeout(self, _ms):
            pass

        def evaluate(self, script, arg=None):
            self.evaluate_args.append(arg)
            if arg and arg.get("workspaceId"):
                return {
                    "ok": True,
                    "selectedText": "schools.nyc.gov Workspace #82254",
                    "profileText": "schools.nyc.gov Workspace #82254",
                }
            return json.dumps(
                {
                    "accessToken": access_token,
                    "sessionToken": "workspace-session",
                }
            )

    page = FakePage()
    result = export_workspace_cpa_session_from_browser(
        page,
        workspace_id="d1869eec-4d2d-4fce-967f-a1a6b906d51e",
        output_dir=tmp_path,
        now=datetime(2026, 7, 1, 1, 2, 3, tzinfo=timezone.utc),
    )

    assert page.gotos == [
        "https://chatgpt.com/",
        "https://chatgpt.com/api/auth/session",
    ]
    workspace_args = [arg for arg in page.evaluate_args if isinstance(arg, dict) and arg.get("workspaceId")]
    assert workspace_args[0]["workspaceId"] == "d1869eec-4d2d-4fce-967f-a1a6b906d51e"
    assert result["ok"] is True
    assert result["account_id"] == "workspace-account"
    assert result["email"] == "member@example.com"
    assert result["session_token"] == "workspace-session"
    saved_path = tmp_path / "member-example-com_2026-07-01_01-02-03.json"
    assert result["path"] == str(saved_path.resolve())
    assert json.loads(saved_path.read_text(encoding="utf-8"))["account_id"] == "workspace-account"


def test_switch_chatgpt_workspace_via_profile_menu_uses_profile_menu():
    class FakePage:
        def __init__(self):
            self.gotos = []
            self.evaluate_calls = []

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def evaluate(self, script, arg):
            self.evaluate_calls.append((script, arg))
            return {
                "ok": True,
                "selectedText": "schools.nyc.gov Workspace #82254",
                "profileText": "schools.nyc.gov Workspace #82254",
            }

    page = FakePage()
    result = switch_chatgpt_workspace_via_profile_menu(
        page,
        workspace_id="631e1603-06cf-4f0b-b79b-d09fbfcfe98d",
    )

    assert page.gotos == ["https://chatgpt.com/"]
    script, arg = page.evaluate_calls[0]
    assert "accounts-profile-button" in script
    assert "menuitemradio" in script
    assert arg["workspaceId"] == "631e1603-06cf-4f0b-b79b-d09fbfcfe98d"
    assert result["profileText"] == "schools.nyc.gov Workspace #82254"


def test_switch_chatgpt_workspace_via_profile_menu_waits_for_each_menu_step():
    class FakeMouse:
        def __init__(self, page):
            self.page = page

        def click(self, x, y):
            point = (int(x), int(y))
            self.page.mouse_clicks.append(point)
            if point == (10, 20):
                self.page.profile_clicked = True
            elif point == (30, 40):
                assert self.page.profile_clicked
                self.page.submenu_clicked = True
            elif point == (50, 60):
                assert self.page.submenu_clicked
                self.page.workspace_clicked = True
            else:
                raise AssertionError(f"unexpected click point: {point}")

        def move(self, x, y):
            self.page.mouse_moves.append((int(x), int(y)))

    class FakePage:
        def __init__(self):
            self.gotos = []
            self.mouse_clicks = []
            self.mouse_moves = []
            self.profile_clicked = False
            self.submenu_clicked = False
            self.workspace_clicked = False
            self.mouse = FakeMouse(self)

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def wait_for_function(self, _script, **_kwargs):
            if self.workspace_clicked:
                return True
            raise RuntimeError("not in workspace yet")

        def wait_for_timeout(self, _ms):
            pass

        def evaluate(self, script, arg=None):
            if arg is not None:
                raise AssertionError("workspace switching must not use one in-page chained click")
            if "PROFILE_MENU_TARGET" in script:
                return {"ok": True, "x": 10, "y": 20, "text": "ss Personal Account"}
            if "ACCOUNT_SUBMENU_TARGET" in script:
                if not self.profile_clicked:
                    return {"ok": False, "summary": "profile menu not open"}
                return {"ok": True, "x": 30, "y": 40, "text": "ss Personal Account"}
            if "WORKSPACE_RADIO_TARGET" in script:
                if not self.submenu_clicked:
                    return {"ok": False, "summary": "workspace submenu not open"}
                return {
                    "ok": True,
                    "x": 50,
                    "y": 60,
                    "text": "schools.nyc.gov Workspace #82254",
                }
            if "WORKSPACE_READY_TARGET" in script:
                if not self.workspace_clicked:
                    return {"ok": False, "summary": "workspace not selected"}
                return {
                    "ok": True,
                    "text": "schools.nyc.gov Workspace #82254",
                    "source": "profile",
                }
            return "schools.nyc.gov Workspace #82254" if self.workspace_clicked else "ss Personal Account"

    page = FakePage()
    result = switch_chatgpt_workspace_via_profile_menu(
        page,
        workspace_id="631e1603-06cf-4f0b-b79b-d09fbfcfe98d",
    )

    assert page.gotos == ["https://chatgpt.com/"]
    assert page.mouse_clicks == [(10, 20), (30, 40), (50, 60)]
    assert page.mouse_moves == [(30, 40)]
    assert result["profileText"] == "schools.nyc.gov Workspace #82254"


def test_switch_chatgpt_workspace_via_profile_menu_reclicks_until_next_step_and_accepts_welcome():
    class FakeMouse:
        def __init__(self, page):
            self.page = page

        def click(self, x, y):
            point = (int(x), int(y))
            self.page.mouse_clicks.append(point)
            if point == (10, 20):
                self.page.profile_clicks += 1
            elif point == (30, 40):
                self.page.submenu_clicks += 1
            elif point == (50, 60):
                self.page.workspace_clicks += 1
            else:
                raise AssertionError(f"unexpected click point: {point}")

        def move(self, x, y):
            self.page.mouse_moves.append((int(x), int(y)))

    class FakePage:
        def __init__(self):
            self.gotos = []
            self.mouse_clicks = []
            self.mouse_moves = []
            self.profile_clicks = 0
            self.submenu_clicks = 0
            self.workspace_clicks = 0
            self.mouse = FakeMouse(self)

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def wait_for_function(self, _script, **_kwargs):
            raise RuntimeError("profile text never changes in this UI state")

        def wait_for_timeout(self, _ms):
            pass

        def evaluate(self, script, arg=None):
            if arg is not None:
                raise AssertionError("workspace switching must not fall back to one in-page chained click")
            if "PROFILE_MENU_TARGET" in script:
                return {"ok": True, "x": 10, "y": 20, "text": "Open profile menu"}
            if "ACCOUNT_SUBMENU_TARGET" in script:
                if self.profile_clicks < 2:
                    return {"ok": False, "summary": "account submenu still closed"}
                return {"ok": True, "x": 30, "y": 40, "text": "AL Aurora Lewis Personal account"}
            if "WORKSPACE_RADIO_TARGET" in script:
                if self.submenu_clicks < 2:
                    return {"ok": False, "summary": "workspace radios still closed"}
                return {
                    "ok": True,
                    "x": 50,
                    "y": 60,
                    "text": "schools.nyc.gov Workspace #82254",
                }
            if "WORKSPACE_READY_TARGET" in script:
                if self.workspace_clicks < 1:
                    return {"ok": False, "summary": "welcome not visible"}
                return {
                    "ok": True,
                    "text": "Welcome to the schools.nyc.gov Workspace #82254 workspace",
                    "source": "welcome",
                }
            return "AL Aurora Lewis Personal account"

    page = FakePage()
    result = switch_chatgpt_workspace_via_profile_menu(
        page,
        workspace_id="631e1603-06cf-4f0b-b79b-d09fbfcfe98d",
        timeout_ms=2500,
    )

    assert page.mouse_clicks == [(10, 20), (10, 20), (30, 40), (30, 40), (50, 60)]
    assert result["profileText"] == "Welcome to the schools.nyc.gov Workspace #82254 workspace"
    assert result["readySource"] == "welcome"


def test_switch_chatgpt_workspace_via_profile_menu_waits_for_welcome_after_radio_disappears():
    class FakeMouse:
        def __init__(self, page):
            self.page = page

        def click(self, x, y):
            point = (int(x), int(y))
            self.page.mouse_clicks.append(point)
            if point == (10, 20):
                self.page.profile_clicked = True
            elif point == (30, 40):
                self.page.submenu_clicked = True
            elif point == (50, 60):
                self.page.workspace_clicked = True
            else:
                raise AssertionError(f"unexpected click point: {point}")

        def move(self, x, y):
            self.page.mouse_moves.append((int(x), int(y)))

    class FakePage:
        def __init__(self):
            self.gotos = []
            self.mouse_clicks = []
            self.mouse_moves = []
            self.profile_clicked = False
            self.submenu_clicked = False
            self.workspace_clicked = False
            self.ready_checks = 0
            self.radio_missing_checks = 0
            self.mouse = FakeMouse(self)

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def wait_for_function(self, _script, **_kwargs):
            raise RuntimeError("profile text not updated yet")

        def wait_for_timeout(self, _ms):
            pass

        def evaluate(self, script, arg=None):
            if arg is not None:
                raise AssertionError("workspace switching must not fall back to one in-page chained click")
            if "PROFILE_MENU_TARGET" in script:
                return {"ok": True, "x": 10, "y": 20, "text": "EW"}
            if "ACCOUNT_SUBMENU_TARGET" in script:
                if not self.profile_clicked:
                    return {"ok": False, "summary": "account submenu closed"}
                return {"ok": True, "x": 30, "y": 40, "text": "EW Evelyn White Free"}
            if "WORKSPACE_RADIO_TARGET" in script:
                if not self.submenu_clicked or self.workspace_clicked:
                    if self.workspace_clicked:
                        self.radio_missing_checks += 1
                    return {"ok": False, "summary": "workspace radio not visible; candidates=[]"}
                return {
                    "ok": True,
                    "x": 50,
                    "y": 60,
                    "text": "schools.nyc.gov Workspace #82254",
                }
            if "WORKSPACE_READY_TARGET" in script:
                self.ready_checks += 1
                if self.workspace_clicked and self.radio_missing_checks > 0:
                    return {
                        "ok": True,
                        "text": "Welcome to the schools.nyc.gov Workspace #82254 workspace",
                        "source": "welcome",
                    }
                return {"ok": False, "summary": "welcome not visible yet"}
            return "EW Evelyn White Free"

    page = FakePage()
    result = switch_chatgpt_workspace_via_profile_menu(
        page,
        workspace_id="631e1603-06cf-4f0b-b79b-d09fbfcfe98d",
        timeout_ms=5000,
    )

    assert page.mouse_clicks == [(10, 20), (30, 40), (50, 60)]
    assert result["readySource"] == "welcome"
    assert result["profileText"] == "Welcome to the schools.nyc.gov Workspace #82254 workspace"


def test_switch_chatgpt_workspace_via_profile_menu_recovers_navigation_with_welcome_signal():
    class FakeMouse:
        def __init__(self, page):
            self.page = page

        def click(self, x, y):
            point = (int(x), int(y))
            self.page.mouse_clicks.append(point)
            if point == (10, 20):
                self.page.profile_clicked = True
            elif point == (30, 40):
                self.page.submenu_clicked = True
            elif point == (50, 60):
                self.page.workspace_clicked = True

        def move(self, _x, _y):
            pass

    class FakePage:
        def __init__(self):
            self.gotos = []
            self.mouse_clicks = []
            self.profile_clicked = False
            self.submenu_clicked = False
            self.workspace_clicked = False
            self.ready_checks = 0
            self.post_workspace_ready_checks = 0
            self.mouse = FakeMouse(self)

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def wait_for_function(self, _script, **_kwargs):
            raise RuntimeError("profile text never became workspace")

        def wait_for_timeout(self, _ms):
            pass

        def evaluate(self, script, arg=None):
            if arg is not None:
                raise AssertionError("workspace switching must not fall back to one in-page chained click")
            if "PROFILE_MENU_TARGET" in script:
                return {"ok": True, "x": 10, "y": 20, "text": "SW"}
            if "ACCOUNT_SUBMENU_TARGET" in script:
                if not self.profile_clicked:
                    return {"ok": False, "summary": "account submenu closed"}
                return {"ok": True, "x": 30, "y": 40, "text": "SW Stella Wilson Personal account"}
            if "WORKSPACE_RADIO_TARGET" in script:
                if not self.submenu_clicked:
                    return {"ok": False, "summary": "workspace radio closed"}
                return {
                    "ok": True,
                    "x": 50,
                    "y": 60,
                    "text": "schools.nyc.gov Workspace #82254",
                }
            if "WORKSPACE_READY_TARGET" in script:
                self.ready_checks += 1
                if not self.workspace_clicked:
                    return {"ok": False, "summary": "welcome not visible before workspace click"}
                self.post_workspace_ready_checks += 1
                if self.post_workspace_ready_checks == 1:
                    raise RuntimeError("Execution context was destroyed, most likely because of a navigation")
                return {
                    "ok": True,
                    "text": "Welcome to the schools.nyc.gov Workspace #82254 workspace",
                    "source": "welcome",
                }
            return "SW Stella Wilson Personal account"

    page = FakePage()
    result = switch_chatgpt_workspace_via_profile_menu(
        page,
        workspace_id="631e1603-06cf-4f0b-b79b-d09fbfcfe98d",
        timeout_ms=5000,
    )

    assert page.mouse_clicks == [(10, 20), (30, 40), (50, 60)]
    assert result["navigationRecovered"] is True
    assert result["readySource"] == "welcome"
    assert result["profileText"] == "Welcome to the schools.nyc.gov Workspace #82254 workspace"


def test_switch_chatgpt_workspace_via_profile_menu_skips_menu_when_already_workspace():
    class FakePage:
        def __init__(self):
            self.gotos = []
            self.waited = False
            self.menu_evaluate_called = False

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def wait_for_function(self, _script, **_kwargs):
            self.waited = True

        def evaluate(self, _script, arg=None):
            if arg is not None:
                self.menu_evaluate_called = True
                raise AssertionError("menu switching should be skipped")
            return "schools.nyc.gov Workspace #82254"

    page = FakePage()
    result = switch_chatgpt_workspace_via_profile_menu(
        page,
        workspace_id="631e1603-06cf-4f0b-b79b-d09fbfcfe98d",
    )

    assert page.gotos == ["https://chatgpt.com/"]
    assert page.waited is True
    assert page.menu_evaluate_called is False
    assert result["alreadyWorkspace"] is True
    assert result["profileText"] == "schools.nyc.gov Workspace #82254"


def test_switch_chatgpt_workspace_via_profile_menu_tolerates_navigation_after_click():
    class FakePage:
        def __init__(self):
            self.gotos = []
            self.waited = False
            self.evaluate_count = 0

        def goto(self, url, **_kwargs):
            self.gotos.append(url)

        def wait_for_function(self, _script, **_kwargs):
            self.waited = True

        def evaluate(self, _script, arg=None):
            self.evaluate_count += 1
            if arg and arg.get("workspaceId"):
                raise RuntimeError("Execution context was destroyed, most likely because of a navigation")
            return "schools.nyc.gov Workspace #82254"

    page = FakePage()
    result = switch_chatgpt_workspace_via_profile_menu(
        page,
        workspace_id="631e1603-06cf-4f0b-b79b-d09fbfcfe98d",
    )

    assert page.waited is True
    assert result["profileText"] == "schools.nyc.gov Workspace #82254"
