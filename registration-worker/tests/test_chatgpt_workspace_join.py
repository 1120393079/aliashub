from core.base_mailbox import _extract_verification_link
from platforms.chatgpt.workspace_join import (
    DEFAULT_WORKSPACE_IDS,
    open_workspace_invite_in_browser,
    parse_workspace_ids,
    run_workspace_join_flow,
)


def test_parse_workspace_ids_uses_default_when_blank():
    assert parse_workspace_ids("") == [DEFAULT_WORKSPACE_IDS]


def test_parse_workspace_ids_accepts_commas_and_lines():
    assert parse_workspace_ids(" one,\ntwo \n\n three ") == ["one", "two", "three"]


def test_extract_verification_link_accepts_chatgpt_workspace_invite():
    html = """
    <a href="https://chatgpt.com/k12-invite?inv_ws_name=w&amp;wId=d1869eec-4d2d-4fce-967f-a1a6b906d51e&amp;aiId=abc">
      Join workspace
    </a>
    """

    assert _extract_verification_link(html, "k12-invite") == (
        "https://chatgpt.com/k12-invite?inv_ws_name=w"
        "&wId=d1869eec-4d2d-4fce-967f-a1a6b906d51e&aiId=abc"
    )


def test_open_workspace_invite_requires_clicking_invite_button():
    class FakePage:
        def __init__(self):
            self.url = ""

        def goto(self, url, **_kwargs):
            self.url = url

        def wait_for_timeout(self, _ms):
            return None

        def evaluate(self, _script):
            return {"clicked": False, "text": "", "url": self.url}

    result = open_workspace_invite_in_browser(
        FakePage(),
        "https://chatgpt.com/k12-invite?wId=workspace-1&aiId=invite-1",
    )

    assert result["ok"] is False
    assert result["clicked"] is False
    assert "invite" in result["error"]


def test_open_workspace_invite_recognizes_go_to_teachers_button():
    button_text = "\u8f6c\u81f3 ChatGPT for Teachers"

    class FakePage:
        def __init__(self):
            self.url = ""

        def goto(self, url, **_kwargs):
            self.url = url

        def wait_for_timeout(self, _ms):
            return None

        def evaluate(self, script):
            clicked = "\u8f6c\u81f3\\s*ChatGPT\\s*for\\s*Teachers" in script
            return {
                "clicked": clicked,
                "text": button_text if clicked else "",
                "url": self.url,
            }

    result = open_workspace_invite_in_browser(
        FakePage(),
        "https://chatgpt.com/k12-invite?wId=workspace-1&aiId=invite-1",
    )

    assert result["ok"] is True
    assert result["clicked"] is True
    assert result["clicked_text"] == button_text


def test_open_workspace_invite_waits_for_late_invite_button():
    class FakePage:
        def __init__(self):
            self.url = ""
            self.evaluate_calls = 0

        def goto(self, url, **_kwargs):
            self.url = url

        def wait_for_timeout(self, _ms):
            return None

        def evaluate(self, _script):
            self.evaluate_calls += 1
            if self.evaluate_calls < 3:
                return {"clicked": False, "text": "", "url": self.url}
            return {
                "clicked": True,
                "text": "转至 ChatGPT for Teachers",
                "url": self.url,
            }

    page = FakePage()
    result = open_workspace_invite_in_browser(
        page,
        "https://chatgpt.com/k12-invite?wId=workspace-1&aiId=invite-1",
    )

    assert result["ok"] is True
    assert result["clicked"] is True
    assert page.evaluate_calls == 3


def test_workspace_join_flow_exports_cpa_and_returns_workspace_credentials(monkeypatch, tmp_path):
    import platforms.chatgpt.workspace_join as workspace_join

    class FakeMailbox:
        def get_current_ids(self, _account):
            return set()

        def wait_for_link(self, *_args, **_kwargs):
            return "https://chatgpt.com/k12-invite?wId=workspace-1&aiId=invite-1"

    monkeypatch.setattr(
        workspace_join,
        "request_workspace_join_in_browser",
        lambda *_args, **_kwargs: [{"ok": True, "workspace_id": "workspace-1"}],
    )
    monkeypatch.setattr(
        workspace_join,
        "open_workspace_invite_in_browser",
        lambda *_args, **_kwargs: {"ok": True, "clicked": True},
    )
    monkeypatch.setattr(
        workspace_join,
        "export_workspace_cpa_session_from_browser",
        lambda *_args, **_kwargs: {
            "ok": True,
            "path": str(tmp_path / "member.json"),
            "email": "member@example.com",
            "account_id": "workspace-account",
            "expired": "2026-07-01T00:00:00Z",
            "access_token": "workspace-access",
            "refresh_token": "",
            "id_token": "workspace-id",
            "session_token": "workspace-session",
        },
        raising=False,
    )

    result = run_workspace_join_flow(
        object(),
        {"access_token": "registration-access"},
        mailbox=FakeMailbox(),
        mailbox_account=object(),
        config={
            "workspace_ids": "workspace-1",
            "accept_invite": True,
            "export_cpa_json": True,
            "cpa_output_dir": str(tmp_path),
        },
    )

    assert result["access_token"] == "workspace-access"
    assert result["id_token"] == "workspace-id"
    assert result["session_token"] == "workspace-session"
    assert result["account_id"] == "workspace-account"
    assert result["workspace_join"]["cpa_export"]["path"].endswith("member.json")


def test_workspace_join_flow_fails_when_cpa_export_fails(monkeypatch, tmp_path):
    import platforms.chatgpt.workspace_join as workspace_join

    class FakeMailbox:
        def get_current_ids(self, _account):
            return set()

        def wait_for_link(self, *_args, **_kwargs):
            return "https://chatgpt.com/k12-invite?wId=workspace-1&aiId=invite-1"

    logs: list[str] = []
    monkeypatch.setattr(
        workspace_join,
        "request_workspace_join_in_browser",
        lambda *_args, **_kwargs: [{"ok": True, "workspace_id": "workspace-1"}],
    )
    monkeypatch.setattr(
        workspace_join,
        "open_workspace_invite_in_browser",
        lambda *_args, **_kwargs: {"ok": True, "clicked": True},
    )

    def fail_export(*_args, **_kwargs):
        raise RuntimeError("workspace switch failed")

    monkeypatch.setattr(
        workspace_join,
        "export_workspace_cpa_session_from_browser",
        fail_export,
        raising=False,
    )

    result = run_workspace_join_flow(
        object(),
        {"access_token": "registration-access"},
        mailbox=FakeMailbox(),
        mailbox_account=object(),
        config={
            "workspace_ids": "workspace-1",
            "accept_invite": True,
            "export_cpa_json": True,
            "cpa_output_dir": str(tmp_path),
        },
        log=logs.append,
    )

    assert result["workspace_join"]["ok"] is False
    assert result["workspace_join"]["error"] == (
        "CPA JSON export failed: workspace switch failed"
    )
    assert result["workspace_join"]["cpa_export"] == {
        "ok": False,
        "error": "workspace switch failed",
    }
    assert any("CPA JSON export failed" in item for item in logs)
