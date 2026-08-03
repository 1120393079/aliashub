import threading
import time

from application.tasks import (
    TASK_STATUS_CANCEL_REQUESTED,
    TASK_STATUS_CANCELLED,
    TASK_STATUS_INTERRUPTED,
    TASK_STATUS_PAUSED,
    TASK_STATUS_PENDING,
    TASK_STATUS_RUNNING,
    TaskLogger,
    claim_next_runnable_task,
    create_register_task,
    get_task,
    mark_incomplete_tasks_interrupted,
    pause_registration_queue,
    registration_queue_control,
    request_cancel,
    request_pause,
    request_resume,
    resume_registration_queue,
)


def _register_task(count: int = 3):
    return create_register_task({
        "platform": "chatgpt",
        "count": count,
        "concurrency": 1,
        "executor_type": "headed",
        "extra": {"identity_provider": "mailbox"},
    })


def test_pending_registration_can_pause_resume_and_cancel():
    task = _register_task()
    assert task["status"] == TASK_STATUS_PENDING
    assert task["pausable"] is True

    paused = request_pause(task["id"])
    assert paused["status"] == TASK_STATUS_PAUSED
    assert paused["resumable"] is True
    assert paused["cancellable"] is True
    assert claim_next_runnable_task() is None

    resumed = request_resume(task["id"])
    assert resumed["status"] == TASK_STATUS_PENDING
    assert resumed["pausable"] is True

    paused_again = request_pause(task["id"])
    assert paused_again["status"] == TASK_STATUS_PAUSED
    cancelled = request_cancel(task["id"])
    assert cancelled["status"] == TASK_STATUS_CANCELLED
    assert cancelled["terminal"] is True


def test_running_registration_waits_while_paused_and_resumes_in_place():
    task = _register_task()
    claimed = claim_next_runnable_task()
    assert claimed["id"] == task["id"]

    logger = TaskLogger(task["id"])
    logger.mark_running()
    assert get_task(task["id"])["status"] == TASK_STATUS_RUNNING
    assert request_pause(task["id"])["status"] == TASK_STATUS_PAUSED

    result = {}
    waiter = threading.Thread(
        target=lambda: result.setdefault("continued", logger.wait_if_paused(0.01)),
        daemon=True,
    )
    waiter.start()
    time.sleep(0.05)
    assert waiter.is_alive()

    resumed = request_resume(task["id"])
    assert resumed["status"] == TASK_STATUS_RUNNING
    waiter.join(timeout=1)
    assert waiter.is_alive() is False
    assert result["continued"] is True

    request_pause(task["id"])
    cancelling = request_cancel(task["id"])
    assert cancelling["status"] == TASK_STATUS_CANCEL_REQUESTED
    assert logger.wait_if_paused(0.01) is False


def test_restart_preserves_unstarted_pause_but_interrupts_started_pause():
    unstarted = _register_task()
    request_pause(unstarted["id"])

    started = _register_task()
    claimed = claim_next_runnable_task()
    assert claimed["id"] == started["id"]
    logger = TaskLogger(started["id"])
    logger.mark_running()
    request_pause(started["id"])

    mark_incomplete_tasks_interrupted()

    assert get_task(unstarted["id"])["status"] == TASK_STATUS_PAUSED
    assert get_task(started["id"])["status"] == TASK_STATUS_INTERRUPTED


def test_global_queue_pause_holds_existing_and_new_registration_tasks():
    existing = _register_task()

    control = pause_registration_queue()
    assert control["paused"] is True
    assert control["changed"] == 1
    assert get_task(existing["id"])["status"] == TASK_STATUS_PAUSED

    created_while_paused = _register_task()
    assert created_while_paused["status"] == TASK_STATUS_PAUSED
    assert claim_next_runnable_task() is None
    assert registration_queue_control()["counts"]["paused"] == 2

    request_cancel(existing["id"])
    resumed = resume_registration_queue()
    assert resumed["paused"] is False
    assert resumed["changed"] == 1
    assert get_task(created_while_paused["id"])["status"] == TASK_STATUS_PENDING


def test_registration_pause_control_api(client):
    paused = client.post("/api/tasks/register/pause-all")
    assert paused.status_code == 200
    assert paused.json()["paused"] is True

    created = client.post("/api/tasks/register", json={
        "platform": "chatgpt",
        "count": 2,
        "concurrency": 1,
        "executor_type": "headed",
        "extra": {"identity_provider": "mailbox"},
    })
    assert created.status_code == 200
    task = created.json()
    assert task["status"] == TASK_STATUS_PAUSED

    held = client.post(f"/api/tasks/{task['id']}/resume")
    assert held.status_code == 200
    assert held.json()["status"] == TASK_STATUS_PAUSED

    cancelled = client.post(f"/api/tasks/{task['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == TASK_STATUS_CANCELLED

    resumed = client.post("/api/tasks/register/resume-all")
    assert resumed.status_code == 200
    assert resumed.json()["paused"] is False
