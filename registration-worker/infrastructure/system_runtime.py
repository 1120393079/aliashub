from __future__ import annotations

from services.solver_manager import get_status, restart


class SystemRuntime:
    def solver_status(self) -> dict:
        return get_status()

    def restart_solver(self) -> dict:
        import threading
        threading.Thread(target=restart, daemon=True).start()
        return {"message": "重启中"}
