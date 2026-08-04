from application.tasks import (
    TASK_STATUS_PENDING,
    claim_next_runnable_task,
    create_platform_action_task,
    create_register_task,
    get_task,
)


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
