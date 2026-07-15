"""
Windsurf 桌面应用账号切换 —— 纯协议实现
支持 macOS / Windows / Linux

切换流程（无需浏览器、无需操作 Electron safeStorage）：
1. 用 session_token 调 GetOneTimeAuthToken API 获取一次性 OTT
2. 通过 windsurf:// deep link 将 OTT 传给 Windsurf 桌面端
3. Windsurf 内部用 OTT 完成认证并切换账号

Windsurf 认证信息缓存在 state.vscdb SQLite 数据库中:
  macOS:   ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
  Windows: %APPDATA%/Windsurf/User/globalStorage/state.vscdb
  Linux:   ~/.config/Windsurf/User/globalStorage/state.vscdb
"""

import json
import logging
import os
import platform
import sqlite3
import subprocess
import time
from typing import Tuple
from urllib.parse import quote

from core.desktop_apps import build_desktop_app_state

logger = logging.getLogger(__name__)

_DB_KEY = "windsurfAuthStatus"


def _get_windsurf_config_dir() -> str:
    """获取 Windsurf 配置目录路径"""
    system = platform.system()

    if system == "Darwin":
        home = os.path.expanduser("~")
        return os.path.join(home, "Library", "Application Support", "Windsurf", "User")

    elif system == "Windows":
        appdata = os.environ.get("APPDATA", "")
        return os.path.join(appdata, "Windsurf", "User")

    else:  # Linux
        home = os.path.expanduser("~")
        config_home = os.environ.get("XDG_CONFIG_HOME", os.path.join(home, ".config"))
        return os.path.join(config_home, "Windsurf", "User")


def _get_windsurf_db_path() -> str:
    """获取 Windsurf state.vscdb 路径"""
    config_dir = _get_windsurf_config_dir()
    return os.path.join(config_dir, "globalStorage", "state.vscdb")


def _windsurf_install_paths() -> list[str]:
    system = platform.system()
    if system == "Darwin":
        home = os.path.expanduser("~")
        return [
            "/Applications/Windsurf.app",
            os.path.join(home, "Applications", "Windsurf.app"),
        ]
    if system == "Windows":
        localappdata = os.environ.get("LOCALAPPDATA", "")
        return [os.path.join(localappdata, "Programs", "Windsurf", "Windsurf.exe")]
    return ["/usr/bin/windsurf", os.path.expanduser("~/.local/bin/windsurf")]


def _windsurf_process_patterns() -> list[str]:
    system = platform.system()
    if system == "Darwin":
        return [
            "/Applications/Windsurf.app/Contents/MacOS/Electron",
            os.path.join(os.path.expanduser("~"), "Applications", "Windsurf.app", "Contents", "MacOS", "Electron"),
        ]
    if system == "Windows":
        return ["Windsurf.exe"]
    return ["windsurf"]


def _read_db_key(db_path: str, key: str) -> str | None:
    """从 state.vscdb 读取指定 key 的值"""
    if not os.path.exists(db_path):
        return None
    try:
        conn = sqlite3.connect(db_path, timeout=10)
        try:
            row = conn.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"读取 state.vscdb 失败: {e}")
        return None


def _write_db_key(db_path: str, key: str, value: str):
    """写入 state.vscdb 指定 key 的值（INSERT OR REPLACE）"""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)",
        )
        conn.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()


def _clear_old_auth_keys(db_path: str):
    """清除 state.vscdb 中旧账号的加密 session 和 auth 缓存"""
    if not os.path.exists(db_path):
        return
    # 需要删除的 key 模式：
    # - secret://...windsurf_auth.sessions  (Electron safeStorage 加密的 session)
    # - secret://...windsurf_auth.apiServerUrl
    # - codeium.windsurf-windsurf_auth      (当前用户名)
    # - codeium.windsurf-windsurf_auth-     (session UUID)
    # - windsurf_auth-*                     (用户 session 引用)
    # - windsurf.settings.cachedPlanInfo    (缓存的套餐信息)
    try:
        conn = sqlite3.connect(db_path, timeout=10)
        try:
            conn.execute("DELETE FROM ItemTable WHERE key LIKE 'secret://%windsurf_auth%'")
            conn.execute("DELETE FROM ItemTable WHERE key LIKE 'codeium.windsurf-windsurf_auth%'")
            conn.execute("DELETE FROM ItemTable WHERE key LIKE 'windsurf_auth-%'")
            conn.execute("DELETE FROM ItemTable WHERE key = 'windsurf.settings.cachedPlanInfo'")
            conn.commit()
            logger.info("已清除 Windsurf 旧 session 缓存")
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"清除旧 auth key 失败（非致命）: {e}")


def _get_one_time_auth_token(session_token: str, proxy: str | None = None) -> str:
    """用 session_token 调 GetOneTimeAuthToken 获取一次性认证 token"""
    from platforms.windsurf.core import WindsurfClient, _field_string

    api_key = session_token
    if not api_key.startswith("devin-session-token$"):
        api_key = f"devin-session-token${session_token}"

    client = WindsurfClient(proxy=proxy, log_fn=lambda x: None)
    raw = client._proto_post("GetOneTimeAuthToken", _field_string(1, api_key))
    # protobuf field 1 (wire type 2): tag=0x0a, next byte=length, then string
    if len(raw) < 3 or raw[0] != 0x0A:
        raise RuntimeError(f"GetOneTimeAuthToken 返回格式异常: {raw[:20].hex()}")
    length = raw[1]
    ott = raw[2 : 2 + length].decode("utf-8")
    if not ott:
        raise RuntimeError("GetOneTimeAuthToken 返回空 OTT")
    return ott


def _open_deep_link(ott: str) -> bool:
    """通过 windsurf:// deep link 将 OTT 传给 Windsurf 桌面端"""
    deep_link = f"windsurf://codeium.windsurf#state=switch&access_token={quote(ott, safe='')}"
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(["open", deep_link], timeout=5)
        elif system == "Windows":
            os.startfile(deep_link)
        else:
            subprocess.run(["xdg-open", deep_link], timeout=5)
        return True
    except Exception as e:
        logger.error(f"打开 deep link 失败: {e}")
        return False


def switch_windsurf_account(
    *,
    session_token: str,
    proxy: str | None = None,
) -> Tuple[bool, str]:
    """
    切换 Windsurf 桌面应用账号（纯协议，无需浏览器）

    流程:
    1. 用 session_token 调 GetOneTimeAuthToken API → 获取 OTT
    2. 通过 windsurf:// deep link 传给 Windsurf → 完成认证切换

    Returns:
        (success, message)
    """
    if not session_token:
        return False, "缺少 session_token，无法切换"

    try:
        ott = _get_one_time_auth_token(session_token, proxy=proxy)
        logger.info(f"获取 OTT 成功: {ott[:20]}...")

        if not _open_deep_link(ott):
            return False, "获取 OTT 成功但无法打开 deep link，请手动打开 Windsurf"

        return True, "Windsurf 账号切换指令已发送，请在 Windsurf 中确认"

    except Exception as e:
        logger.error(f"Windsurf 账号切换失败: {e}")
        return False, f"切换失败: {str(e)}"


def restart_windsurf_ide() -> Tuple[bool, str]:
    """关闭并重启 Windsurf IDE"""
    system = platform.system()

    try:
        if system == "Darwin":
            subprocess.run(
                ["osascript", "-e", 'quit app "Windsurf"'],
                capture_output=True,
                timeout=5,
            )
            time.sleep(2.0)

            for app_path in _windsurf_install_paths():
                if app_path.endswith(".app") and os.path.exists(app_path):
                    subprocess.Popen(["open", "-a", app_path])
                    return True, "Windsurf IDE 已重启"
            return True, "已关闭 Windsurf IDE（未找到应用路径，请手动启动）"

        elif system == "Windows":
            subprocess.run(
                ["taskkill", "/IM", "Windsurf.exe", "/F"],
                capture_output=True,
                creationflags=0x08000000,
                timeout=5,
            )
            time.sleep(1.5)

            for exe_path in _windsurf_install_paths():
                if os.path.exists(exe_path):
                    subprocess.Popen([exe_path])
                    return True, "Windsurf IDE 已重启"
            return True, "已关闭 Windsurf IDE（未找到应用路径，请手动启动）"

        else:  # Linux
            subprocess.run(["pkill", "-f", "windsurf"], capture_output=True, timeout=5)
            time.sleep(1.5)

            for path in ["/usr/bin/windsurf", os.path.expanduser("~/.local/bin/windsurf")]:
                if os.path.exists(path):
                    subprocess.Popen([path])
                    return True, "Windsurf IDE 已重启"

            try:
                subprocess.Popen(["windsurf"])
                return True, "Windsurf IDE 已重启"
            except FileNotFoundError:
                return True, "已关闭 Windsurf IDE（未找到应用路径，请手动启动）"

    except Exception as e:
        logger.error(f"Windsurf IDE 重启失败: {e}")
        return False, f"重启失败: {str(e)}"


def read_current_windsurf_account() -> dict | None:
    """读取当前 Windsurf IDE 正在使用的账号信息"""
    db_path = _get_windsurf_db_path()
    raw = _read_db_key(db_path, _DB_KEY)
    if not raw:
        return None

    try:
        auth_data = json.loads(raw)
    except Exception:
        return None

    api_key = str(auth_data.get("apiKey") or "")
    if not api_key:
        return None

    # apiKey 格式: "devin-session-token$<JWT>"
    session_token = api_key
    if api_key.startswith("devin-session-token$"):
        session_token = api_key[len("devin-session-token$"):]

    return {
        "session_token": session_token,
        "api_key_raw": api_key,
    }


def get_windsurf_desktop_state() -> dict:
    """获取 Windsurf 桌面应用状态"""
    current = read_current_windsurf_account() or {}
    db_path = _get_windsurf_db_path()
    config_dir = _get_windsurf_config_dir()
    state = build_desktop_app_state(
        app_id="windsurf",
        app_name="Windsurf",
        process_patterns=_windsurf_process_patterns(),
        install_paths=_windsurf_install_paths(),
        binary_names=["windsurf"],
        config_paths=[config_dir, db_path],
        current_account_present=bool(current.get("session_token")),
        extra={
            "db_path": db_path,
        },
    )
    state["available"] = True
    return state
