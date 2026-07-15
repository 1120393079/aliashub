"""
Trae.ai 账号切换 —— 写入本地配置文件，Trae IDE 自动识别
支持 macOS / Windows / Linux
"""

import os
import json
import logging
import tempfile
import platform
import subprocess
import time
from typing import Tuple

logger = logging.getLogger(__name__)


def _get_trae_config_dir() -> str:
    """获取 Trae 配置目录路径"""
    system = platform.system()

    if system == "Darwin":  # macOS
        home = os.path.expanduser("~")
        return os.path.join(home, "Library", "Application Support", "Trae", "User")

    elif system == "Windows":
        appdata = os.environ.get("APPDATA", "")
        return os.path.join(appdata, "Trae", "User")

    else:  # Linux
        home = os.path.expanduser("~")
        config_home = os.environ.get("XDG_CONFIG_HOME", os.path.join(home, ".config"))
        return os.path.join(config_home, "Trae", "User")


def _get_trae_storage_path() -> str:
    """获取 Trae storage.json 路径"""
    config_dir = _get_trae_config_dir()
    return os.path.join(config_dir, "globalStorage", "storage.json")


def _atomic_write(filepath: str, content: str):
    """原子写入：先写临时文件，再 rename"""
    dir_path = os.path.dirname(filepath)
    os.makedirs(dir_path, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
    try:
        os.write(fd, content.encode("utf-8"))
        os.close(fd)
        os.replace(tmp_path, filepath)
    except Exception:
        try:
            os.close(fd)
        except:
            pass
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def switch_trae_account(
    token: str,
    user_id: str = "",
    email: str = "",
    region: str = ""
) -> Tuple[bool, str]:
    """
    切换 Trae 账号（写入 storage.json，需要重启 Trae）

    Args:
        token: Trae API token
        user_id: 用户 ID
        email: 邮箱
        region: 区域

    Returns:
        (success, message)
    """
    try:
        storage_path = _get_trae_storage_path()

        # 读取现有配置
        storage_data = {}
        if os.path.exists(storage_path):
            try:
                with open(storage_path, "r", encoding="utf-8") as f:
                    storage_data = json.load(f)
            except Exception as e:
                logger.warning(f"读取现有配置失败，将创建新配置: {e}")

        # 更新 token 和用户信息
        storage_data["trae.token"] = token
        if user_id:
            storage_data["trae.userId"] = user_id
        if email:
            storage_data["trae.email"] = email
        if region:
            storage_data["trae.region"] = region

        # 原子写入
        content = json.dumps(storage_data, indent=2, ensure_ascii=False)
        _atomic_write(storage_path, content)

        return True, "切换成功，请重启 Trae IDE 使新账号生效"

    except Exception as e:
        logger.error(f"Trae 账号切换失败: {e}")
        return False, f"切换失败: {str(e)}"


def restart_trae_ide() -> Tuple[bool, str]:
    """关闭并重启 Trae IDE"""
    system = platform.system()

    try:
        if system == "Darwin":  # macOS
            # 关闭 Trae
            subprocess.run(
                ["osascript", "-e", 'quit app "Trae"'],
                capture_output=True,
                timeout=5
            )
            time.sleep(2.0)

            # 启动 Trae
            trae_app = "/Applications/Trae.app"
            if os.path.exists(trae_app):
                subprocess.Popen(["open", "-a", "Trae"])
                return True, "Trae IDE 已重启"
            return True, "已关闭 Trae IDE（未找到应用路径，请手动启动）"

        elif system == "Windows":
            # 关闭 Trae
            subprocess.run(
                ["taskkill", "/IM", "Trae.exe", "/F"],
                capture_output=True,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
                timeout=5
            )
            time.sleep(1.5)

            # 启动 Trae
            localappdata = os.environ.get("LOCALAPPDATA", "")
            trae_exe = os.path.join(localappdata, "Programs", "Trae", "Trae.exe")
            if os.path.exists(trae_exe):
                subprocess.Popen([trae_exe])
                return True, "Trae IDE 已重启"
            return True, "已关闭 Trae IDE（未找到应用路径，请手动启动）"

        else:  # Linux
            # 关闭 Trae
            subprocess.run(["pkill", "-f", "trae"], capture_output=True, timeout=5)
            time.sleep(1.5)

            # 启动 Trae
            for path in ["/usr/bin/trae", os.path.expanduser("~/.local/bin/trae")]:
                if os.path.exists(path):
                    subprocess.Popen([path])
                    return True, "Trae IDE 已重启"

            try:
                subprocess.Popen(["trae"])
                return True, "Trae IDE 已重启"
            except FileNotFoundError:
                return True, "已关闭 Trae IDE（未找到应用路径，请手动启动）"

    except Exception as e:
        logger.error(f"Trae IDE 重启失败: {e}")
        return False, f"重启失败: {str(e)}"


def read_current_trae_account() -> dict | None:
    """读取当前 Trae IDE 正在使用的账号信息"""
    storage_path = _get_trae_storage_path()

    if not os.path.exists(storage_path):
        return None

    try:
        with open(storage_path, "r", encoding="utf-8") as f:
            storage_data = json.load(f)

        token = storage_data.get("trae.token")
        if token:
            return {
                "token": token,
                "user_id": storage_data.get("trae.userId", ""),
                "email": storage_data.get("trae.email", ""),
                "region": storage_data.get("trae.region", "")
            }
        return None

    except Exception as e:
        logger.error(f"读取 Trae 配置失败: {e}")
        return None


def get_trae_user_info(token: str) -> dict | None:
    """通过 token 获取用户信息"""
    from curl_cffi import requests as curl_req

    try:
        r = curl_req.post(
            "https://api-sg-central.trae.ai/cloudide/api/v3/common/GetUserToken",
            headers={
                "Authorization": f"Cloud-IDE-JWT {token}",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                             "AppleWebKit/537.36 (KHTML, like Gecko) "
                             "Chrome/145.0.0.0 Safari/537.36"
            },
            json={},
            impersonate="chrome124",
            timeout=15,
        )

        if r.status_code == 200:
            return r.json()
        return None

    except Exception as e:
        logger.error(f"获取 Trae 用户信息失败: {e}")
        return None
