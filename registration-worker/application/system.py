from __future__ import annotations

from infrastructure.system_runtime import SystemRuntime


class SystemService:
    def __init__(self, runtime: SystemRuntime | None = None):
        self.runtime = runtime or SystemRuntime()

    def solver_status(self) -> dict:
        return self.runtime.solver_status()

    def restart_solver(self) -> dict:
        return self.runtime.restart_solver()
