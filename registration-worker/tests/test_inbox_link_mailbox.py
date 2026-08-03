from concurrent.futures import ThreadPoolExecutor

import pytest
import requests

from core.inbox_link_mailbox import (
    DisposeInboxLinkMailboxPool,
    mask_inbox_link,
    parse_inbox_link_pool,
)


POOL_TEXT = """
alpha@example.com https://dispose.lol/ib/testInboxKeyAlpha001
beta@example.com https://dispose.lol/ib/testInboxKeyBeta0002
"""


def test_parse_inbox_link_pool_accepts_crlf_and_deduplicates_exact_rows():
    text = (
        "alpha@example.com https://dispose.lol/ib/testInboxKeyAlpha001\r\n"
        "\r\n"
        "alpha@example.com   https://dispose.lol/ib/testInboxKeyAlpha001\r\n"
        "beta@example.com https://dispose.lol/ib/testInboxKeyBeta0002\r\n"
    )

    entries = parse_inbox_link_pool(text)

    assert [entry.email for entry in entries] == [
        "alpha@example.com",
        "beta@example.com",
    ]


@pytest.mark.parametrize(
    "text, expected",
    [
        ("not-an-email https://dispose.lol/ib/testInboxKeyAlpha001", "邮箱格式无效"),
        ("a@example.com http://dispose.lol/ib/testInboxKeyAlpha001", "必须使用"),
        ("a@example.com https://example.com/ib/testInboxKeyAlpha001", "必须使用"),
        ("a@example.com https://dispose.lol/not-ib/testInboxKeyAlpha001", "链接格式无效"),
        ("a@example.com", "格式错误"),
    ],
)
def test_parse_inbox_link_pool_rejects_invalid_rows_without_echoing_key(text, expected):
    with pytest.raises(ValueError) as exc_info:
        parse_inbox_link_pool(text)

    assert expected in str(exc_info.value)
    assert "testInboxKeyAlpha001" not in str(exc_info.value)


def test_parse_inbox_link_pool_rejects_conflicting_duplicates():
    with pytest.raises(ValueError, match="邮箱.*重复"):
        parse_inbox_link_pool(
            "same@example.com https://dispose.lol/ib/testInboxKeyAlpha001\n"
            "same@example.com https://dispose.lol/ib/testInboxKeyOther004"
        )
    with pytest.raises(ValueError, match="取件链接.*重复"):
        parse_inbox_link_pool(
            "one@example.com https://dispose.lol/ib/testInboxKeyAlpha001\n"
            "two@example.com https://dispose.lol/ib/testInboxKeyAlpha001"
        )


def test_concurrent_allocations_are_unique_and_exhaust_the_pool():
    mailbox = DisposeInboxLinkMailboxPool(pool_text=POOL_TEXT, poll_interval=0.01)

    with ThreadPoolExecutor(max_workers=2) as executor:
        accounts = list(executor.map(lambda _: mailbox.get_email(), range(2)))

    assert {account.email for account in accounts} == {
        "alpha@example.com",
        "beta@example.com",
    }
    assert mailbox.available_count == 2
    with pytest.raises(RuntimeError, match="已用尽"):
        mailbox.get_email()


def test_snapshot_and_wait_for_code_only_use_new_message_details():
    mailbox = DisposeInboxLinkMailboxPool(pool_text=POOL_TEXT, poll_interval=0.01)
    account = mailbox.get_email()
    state = {"new": False}

    def fake_request(entry, path, *, params=None):
        assert entry.email == account.email
        if path == "messages":
            messages = [{"id": "old", "subject": "Old message", "hasDetail": False}]
            if state["new"]:
                messages.insert(0, {"id": "new", "subject": "OpenAI verification", "hasDetail": True})
            return {"address": account.email, "messages": messages, "syncOk": True}
        assert path == "message"
        assert params == {"id": "new"}
        return {
            "address": account.email,
            "message": {
                "id": "new",
                "subject": "OpenAI verification",
                "htmlBody": "<style>.x{color:#123456}</style><p>Your code is <b>804219</b></p>",
                "textBody": "",
            },
        }

    mailbox._request_json = fake_request
    before_ids = mailbox.get_current_ids_strict(account)
    state["new"] = True

    assert before_ids == {"old"}
    assert mailbox.wait_for_code(
        account,
        keyword="OpenAI",
        timeout=0.2,
        before_ids=before_ids,
    ) == "804219"


def test_wait_for_link_preserves_html_href():
    mailbox = DisposeInboxLinkMailboxPool(pool_text=POOL_TEXT, poll_interval=0.01)
    account = mailbox.get_email()
    mailbox._request_json = lambda entry, path, params=None: {
        "address": account.email,
        "messages": [{
            "id": "new",
            "subject": "Verify account",
            "htmlBody": '<a href="https://example.test/verify?id=123">Continue</a>',
            "hasDetail": False,
        }],
        "syncOk": True,
    }

    assert mailbox.wait_for_link(account, keyword="Verify", timeout=0.2) == "https://example.test/verify?id=123"


def test_wait_for_code_ignores_old_messages():
    mailbox = DisposeInboxLinkMailboxPool(pool_text=POOL_TEXT, poll_interval=0.01)
    account = mailbox.get_email()
    mailbox._request_json = lambda entry, path, params=None: {
        "address": account.email,
        "messages": [{"id": "old", "subject": "Your code is 123456", "hasDetail": False}],
        "syncOk": True,
    }

    with pytest.raises(TimeoutError):
        mailbox.wait_for_code(account, timeout=0.05, before_ids={"old"})


def test_http_errors_never_include_the_full_inbox_key(monkeypatch):
    mailbox = DisposeInboxLinkMailboxPool(pool_text=POOL_TEXT, poll_interval=0.01)
    account = mailbox.get_email()

    def fail_request(*args, **kwargs):
        raise requests.RequestException(
            "failed at https://dispose.lol/api/inbox-link/testInboxKeyAlpha001/messages"
        )

    monkeypatch.setattr("core.inbox_link_mailbox.requests.get", fail_request)
    with pytest.raises(RuntimeError) as exc_info:
        mailbox.get_current_ids_strict(account)

    assert "testInboxKeyAlpha001" not in str(exc_info.value)


def test_stored_resource_uses_masked_link_and_runtime_credentials_can_rebuild_pool():
    mailbox = DisposeInboxLinkMailboxPool(pool_text=POOL_TEXT)
    account = mailbox.get_email()
    resource = account.extra["provider_resource"]

    assert resource["metadata"]["inbox_link"] == mask_inbox_link("testInboxKeyAlpha001")
    assert "testInboxKeyAlpha001" not in str(resource)

    rebuilt = DisposeInboxLinkMailboxPool.from_config(
        {"provider_account": account.extra["provider_account"]}
    )
    assert rebuilt.get_email().email == account.email
