"""Persistent task runtime for single-process execution."""
from __future__ import annotations

from dataclasses import dataclass, field
import threading
import time

from application.tasks import (
    claim_next_runnable_task,
    execute_task,
    force_release_task,
    mark_incomplete_tasks_interrupted,
)


@dataclass(slots=True)
class TaskWorkerState:
    thread: threading.Thread
    runtime_lane: str = ""
    account_keys: set[str] = field(default_factory=set)


class TaskRuntime:
    def __init__(
        self,
        *,
        max_parallel_tasks: int = 20,
        max_parallel_per_platform: int = 1,
        max_parallel_at_recovery: int = 2,
        poll_interval: float = 0.5,
    ):
        self.max_parallel_tasks = max_parallel_tasks
        self.max_parallel_per_platform = max_parallel_per_platform
        self.max_parallel_at_recovery = max(int(max_parallel_at_recovery), 1)
        self.poll_interval = poll_interval
        self._running = False
        self._dispatcher: threading.Thread | None = None
        self._workers: dict[str, TaskWorkerState] = {}
        self._lock = threading.Lock()
        self._wake_event = threading.Event()

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            mark_incomplete_tasks_interrupted()
            self._dispatcher = threading.Thread(target=self._loop, daemon=True, name="task-runtime")
            self._dispatcher.start()
            print("[TaskRuntime] 已启动")

    def stop(self) -> None:
        with self._lock:
            self._running = False
        self._wake_event.set()
        print("[TaskRuntime] 停止中")

    def wake_up(self) -> None:
        self._wake_event.set()

    def release_task(self, task_id: str) -> dict | None:
        task = force_release_task(task_id)
        if not task:
            return None
        self.wake_up()
        return task

    def _loop(self) -> None:
        while self._running:
            self._reap_workers()
            with self._lock:
                available_slots = self.max_parallel_tasks - len(self._workers)
                running_platform_counts: dict[str, int] = {}
                busy_account_keys: set[str] = set()
                for state in self._workers.values():
                    if state.runtime_lane:
                        running_platform_counts[state.runtime_lane] = running_platform_counts.get(state.runtime_lane, 0) + 1
                    busy_account_keys.update(state.account_keys)
            while available_slots > 0 and self._running:
                task_info = claim_next_runnable_task(
                    running_platform_counts=running_platform_counts,
                    busy_account_keys=busy_account_keys,
                    max_parallel_per_platform=self.max_parallel_per_platform,
                    max_parallel_by_lane={
                        "chatgpt:at_recovery": min(
                            self.max_parallel_at_recovery,
                            self.max_parallel_tasks,
                        ),
                    },
                )
                if not task_info:
                    break
                task_id = task_info["id"]
                worker = threading.Thread(
                    target=self._run_task,
                    args=(task_id,),
                    daemon=True,
                    name=f"task-worker-{task_id}",
                )
                with self._lock:
                    runtime_lane = str(
                        task_info.get("runtime_lane") or task_info.get("platform", "") or ""
                    )
                    self._workers[task_id] = TaskWorkerState(
                        thread=worker,
                        runtime_lane=runtime_lane,
                        account_keys=set(task_info.get("account_keys") or []),
                    )
                    if runtime_lane:
                        running_platform_counts[runtime_lane] = running_platform_counts.get(runtime_lane, 0) + 1
                    busy_account_keys.update(set(task_info.get("account_keys") or []))
                worker.start()
                available_slots -= 1
            self._wake_event.wait(self.poll_interval)
            self._wake_event.clear()
        self._reap_workers()

    def _run_task(self, task_id: str) -> None:
        try:
            execute_task(task_id)
        finally:
            with self._lock:
                self._workers.pop(task_id, None)

    def _reap_workers(self) -> None:
        with self._lock:
            finished = [task_id for task_id, worker in self._workers.items() if not worker.thread.is_alive()]
            for task_id in finished:
                self._workers.pop(task_id, None)


task_runtime = TaskRuntime()
