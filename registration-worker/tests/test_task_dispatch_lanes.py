import pytest
from application import tasks as tasks_module
from sqlmodel import Session

from application.tasks import (
    TASK_STATUS_PENDING,
    _take_phone_bind_secret,
    claim_next_runnable_task,
    create_phone_bind_task,
    create_platform_action_task,
    create_register_task,
    execute_task,
    get_task,
    request_cancel,
)
from core.db import TaskModel, engine
from services.task_runtime import TaskRuntime


def _refresh_at_task(account_id: int):
    return create_platform_action_task(
        {
            "platform": "chatgpt",
            "account_id": account_id,
            "action_id": "refresh_access_token",
            "params": {},
        }
    )


def test_at_recovery_is_prioritized_and_not_blocked_by_registration_lane():
    registration = create_register_task({"platform": "chatgpt", "count": 1})
    recovery = _refresh_at_task(185)

    claimed = claim_next_runnable_task(
        running_platform_counts={"chatgpt:registration": 1},
        max_parallel_per_platform=1,
    )

    assert claimed["id"] == recovery["task_id"]
    assert claimed["runtime_lane"] == "chatgpt:at_recovery"
    assert claimed["account_keys"] == ["account:185"]
    assert get_task(registration["task_id"])["status"] == TASK_STATUS_PENDING


def test_registration_lane_keeps_its_own_parallel_limit():
    registration = create_register_task({"platform": "chatgpt", "count": 1})

    claimed = claim_next_runnable_task(
        running_platform_counts={"chatgpt:registration": 1},
        max_parallel_per_platform=1,
    )

    assert claimed is None
    assert get_task(registration["task_id"])["status"] == TASK_STATUS_PENDING


def test_registration_batch_and_runtime_allow_twenty_workers_but_no_more():
    tasks = [
        create_register_task({
            "platform": "chatgpt",
            "count": 1,
            "extra": {
                "registration_batch_id": "batch-twenty",
                "registration_batch_concurrency": 99,
            },
        })
        for _ in range(2)
    ]
    lane = "chatgpt:registration:batch-twenty"

    claimed = claim_next_runnable_task(
        running_platform_counts={lane: 19},
        max_parallel_per_platform=1,
    )
    blocked = claim_next_runnable_task(
        running_platform_counts={lane: 20},
        max_parallel_per_platform=1,
    )

    assert claimed["id"] == tasks[0]["task_id"]
    assert blocked is None
    assert get_task(tasks[1]["task_id"])["status"] == TASK_STATUS_PENDING
    assert TaskRuntime().max_parallel_tasks == 20


def test_registration_execution_semaphore_has_exactly_twenty_slots():
    acquired = 0
    try:
        results = [
            tasks_module._registration_execution_slots.acquire(blocking=False)
            for _ in range(21)
        ]
        acquired = sum(results)
        assert results == ([True] * 20) + [False]
    finally:
        for _ in range(acquired):
            tasks_module._registration_execution_slots.release()


def test_register_api_accepts_twenty_workers_and_rejects_twenty_one(client, monkeypatch):
    import api.task_commands as task_commands_api

    class FakeCommandService:
        def create_register_task(self, payload):
            return payload

    monkeypatch.setattr(task_commands_api, "command_service", FakeCommandService())
    payload = {"platform": "chatgpt", "count": 20, "concurrency": 20}

    accepted = client.post("/api/tasks/register", json=payload)
    rejected = client.post("/api/tasks/register", json={**payload, "concurrency": 21})

    assert accepted.status_code == 200
    assert accepted.json()["concurrency"] == 20
    assert rejected.status_code == 422


def test_at_recovery_still_respects_same_account_lock():
    recovery = _refresh_at_task(185)

    claimed = claim_next_runnable_task(
        busy_account_keys={"account:185"},
        max_parallel_per_platform=1,
    )

    assert claimed is None
    assert get_task(recovery["task_id"])["status"] == TASK_STATUS_PENDING


def test_at_recovery_lane_can_use_its_dedicated_parallel_limit():
    recovery = _refresh_at_task(186)

    claimed = claim_next_runnable_task(
        running_platform_counts={"chatgpt:at_recovery": 1},
        max_parallel_per_platform=1,
        max_parallel_by_lane={"chatgpt:at_recovery": 2},
    )

    assert claimed["id"] == recovery["task_id"]
    assert claimed["runtime_lane"] == "chatgpt:at_recovery"


def _phone_bind_task(account_id: int):
    return create_phone_bind_task(
        {
            "platform": "chatgpt",
            "ids": [account_id],
            "fallback_ids": [],
            "phone_lines": "+12025550104----https://relay.example.invalid/sms",
        }
    )


def test_phone_bind_uses_dedicated_three_worker_lane_and_account_lock():
    task = _phone_bind_task(201)

    claimed = claim_next_runnable_task(
        running_platform_counts={"chatgpt:phone_bind": 2, "chatgpt": 1},
        max_parallel_per_platform=1,
    )

    assert claimed["id"] == task["task_id"]
    assert claimed["runtime_lane"] == "chatgpt:phone_bind"
    assert claimed["account_keys"] == ["account:201"]


def test_phone_bind_lane_stops_at_three_running_tasks():
    task = _phone_bind_task(202)

    claimed = claim_next_runnable_task(
        running_platform_counts={"chatgpt:phone_bind": 3},
        max_parallel_per_platform=1,
    )

    assert claimed is None
    assert get_task(task["task_id"])["status"] == TASK_STATUS_PENDING


def test_phone_bind_creation_rejects_nonterminal_duplicate_account():
    first = _phone_bind_task(203)

    with pytest.raises(ValueError, match="203"):
        _phone_bind_task(203)

    with Session(engine) as session:
        model = session.get(TaskModel, first["task_id"])
        model.status = "succeeded"
        session.add(model)
        session.commit()

    replacement = _phone_bind_task(203)
    assert replacement["status"] == TASK_STATUS_PENDING


def test_phone_bind_api_maps_duplicate_to_conflict(client, monkeypatch):
    import api.task_commands as task_commands_api

    class FakeCommandService:
        def create_phone_bind_task(self, payload):
            raise ValueError("账号已有进行中的手机绑定任务: 204")

    monkeypatch.setattr(task_commands_api, "command_service", FakeCommandService())

    response = client.post(
        "/api/tasks/phone-bind",
        json={
            "ids": [204],
            "phone_lines": "+12025550104----https://relay.example.invalid/sms",
        },
    )

    assert response.status_code == 409
    assert "204" in response.json()["detail"]


def test_phone_bind_api_validates_sms_wait_seconds(client):
    response = client.post(
        "/api/tasks/phone-bind",
        json={
            "ids": [205],
            "phone_lines": "+12025550104----https://relay.example.invalid/sms",
            "sms_wait_seconds": 29,
        },
    )

    assert response.status_code == 422


def test_phone_bind_persists_only_a_transient_secret_reference():
    relay_url = "https://relay.example.invalid/openai/secret-token-value"
    task = create_phone_bind_task({
        "task_id": "ahpb_0123456789abcdefghijklmnopqrstuv",
        "platform": "chatgpt",
        "ids": [206],
        "fallback_ids": [],
        "phone_lines": f"+12025550104----{relay_url}",
        "browser_mode": "camoufox_headed",
        "concurrency": 1,
        "sms_wait_seconds": 90,
    })

    with Session(engine) as session:
        payload = session.get(TaskModel, task["task_id"]).get_payload()

    assert "phone_lines" not in payload
    assert payload["phone_lines_ref"]
    assert relay_url not in str(payload)
    assert _take_phone_bind_secret(payload["phone_lines_ref"]) == f"+12025550104----{relay_url}"


def test_phone_bind_external_task_id_is_idempotent_and_fingerprint_checked():
    payload = {
        "task_id": "ahpb_1123456789abcdefghijklmnopqrstuv",
        "platform": "chatgpt",
        "ids": [207],
        "fallback_ids": [],
        "phone_lines": "+12025550104----https://relay.example.invalid/first-secret",
        "browser_mode": "camoufox_headed",
        "bit_profile_id": "",
        "concurrency": 1,
        "sms_wait_seconds": 90,
    }
    first = create_phone_bind_task(payload)
    replay = create_phone_bind_task(payload)

    assert replay["task_id"] == first["task_id"]
    with Session(engine) as session:
        assert session.get(TaskModel, first["task_id"]) is not None

    with pytest.raises(ValueError, match="different request"):
        create_phone_bind_task({**payload, "bit_profile_id": "different-profile"})

    request_cancel(first["task_id"])


def test_phone_bind_executor_consumes_secret_without_persisting_it(monkeypatch):
    relay_url = "https://relay.example.invalid/openai/executor-secret"
    captured = {}

    def fake_bind(_self, **kwargs):
        captured.update(kwargs)
        return {
            "total": 1,
            "success_count": 1,
            "failure_count": 0,
            "results": [{
                "account_id": 208,
                "email": "bind@example.test",
                "phone": "+12025550104",
                "ok": True,
                "error": "",
            }],
            "phones": [],
        }

    monkeypatch.setattr("application.tasks.PhoneBindingService.bind", fake_bind)
    task = create_phone_bind_task({
        "task_id": "ahpb_2123456789abcdefghijklmnopqrstuv",
        "platform": "chatgpt",
        "ids": [208],
        "fallback_ids": [],
        "phone_lines": f"+12025550104----{relay_url}",
        "browser_mode": "camoufox_headed",
        "concurrency": 1,
        "sms_wait_seconds": 90,
    })
    with Session(engine) as session:
        secret_ref = session.get(TaskModel, task["task_id"]).get_payload()["phone_lines_ref"]

    execute_task(task["task_id"])

    assert captured["phone_lines"] == f"+12025550104----{relay_url}"
    assert get_task(task["task_id"])["status"] == "succeeded"
    assert _take_phone_bind_secret(secret_ref) == ""
    with Session(engine) as session:
        model = session.get(TaskModel, task["task_id"])
        assert relay_url not in model.payload_json
        assert relay_url not in model.result_json


def test_phone_bind_cancel_and_missing_secret_fail_closed_without_echoing_url():
    relay_url = "https://relay.example.invalid/openai/missing-secret"
    cancelled = create_phone_bind_task({
        "task_id": "ahpb_3123456789abcdefghijklmnopqrstuv",
        "platform": "chatgpt",
        "ids": [209],
        "phone_lines": f"+12025550104----{relay_url}",
    })
    with Session(engine) as session:
        cancelled_ref = session.get(TaskModel, cancelled["task_id"]).get_payload()["phone_lines_ref"]
    request_cancel(cancelled["task_id"])
    assert _take_phone_bind_secret(cancelled_ref) == ""

    missing = create_phone_bind_task({
        "task_id": "ahpb_4123456789abcdefghijklmnopqrstuv",
        "platform": "chatgpt",
        "ids": [210],
        "phone_lines": f"+12025550104----{relay_url}",
    })
    with Session(engine) as session:
        missing_ref = session.get(TaskModel, missing["task_id"]).get_payload()["phone_lines_ref"]
    assert _take_phone_bind_secret(missing_ref)

    execute_task(missing["task_id"])

    result = get_task(missing["task_id"])
    assert result["status"] == "failed"
    assert "临时接码凭据已失效" in result["error"]
    assert relay_url not in str(result)
