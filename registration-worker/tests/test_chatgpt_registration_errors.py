from platforms.chatgpt.registration_errors import (
    extract_create_account_error,
    format_create_account_error,
)


def test_extracts_structured_create_account_failure():
    details = extract_create_account_error(
        status=400,
        payload={
            "error": {
                "code": "account_creation_blocked",
                "message": "Sorry, we cannot create your account.",
                "request_id": "req_123",
            }
        },
    )

    assert details == {
        "status": 400,
        "code": "account_creation_blocked",
        "message": "Sorry, we cannot create your account.",
        "request_id": "req_123",
        "policy_blocked": True,
    }
    assert format_create_account_error(details) == (
        "error_code: account_creation_blocked request_id: req_123 "
        "Sorry, we cannot create your account."
    )


def test_classifies_localized_terms_rejection_without_upstream_code():
    details = extract_create_account_error(
        status=400,
        fallback_text="利用規約のため、お客様のアカウントを作成できません。",
    )

    assert details["code"] == ""
    assert details["policy_blocked"] is True
    assert "利用規約" in format_create_account_error(details)


def test_does_not_classify_field_validation_as_policy_block():
    details = extract_create_account_error(
        status=400,
        payload={"error": {"code": "invalid_age", "message": "Enter a valid age to continue"}},
    )

    assert details["policy_blocked"] is False
    assert details["code"] == "invalid_age"


def test_classifies_registration_disallowed_as_policy_block():
    details = extract_create_account_error(
        status=400,
        payload={
            "error": {
                "code": "registration_disallowed",
                "message": "Sorry, we cannot create your account with the given information.",
            }
        },
    )

    assert details["policy_blocked"] is True
    assert details["code"] == "registration_disallowed"
