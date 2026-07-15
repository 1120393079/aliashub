"""Lazy loader for the bundled ``gopay-deploy`` SDK.

Background:
    The deploy package lives at ``platforms/gopay-deploy/app/src/opai`` and is
    written to be installed via ``pip install -e .`` so that ``import opai...``
    works. We don't want to require that install step inside the main project,
    so we surgically add ``app/src`` to ``sys.path`` on first import and let
    callers use ``from opai.core.gopay_protocol_worker import _register_one``
    style imports.

The hyphen in the directory name (``gopay-deploy``) makes it impossible to
``import platforms.gopay-deploy``—that's why we do path injection rather than
a relative import.
"""

from __future__ import annotations

import os
import sys
import threading

_LOCK = threading.Lock()
_LOADED = False


def _opai_src_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    # platforms/gopay/_opai_loader.py -> platforms/gopay-deploy/app/src
    deploy_root = os.path.normpath(os.path.join(here, "..", "gopay-deploy"))
    return os.path.join(deploy_root, "app", "src")


def ensure_opai_on_path() -> None:
    """Idempotently add the bundled ``opai`` SDK to ``sys.path``."""
    global _LOADED
    if _LOADED:
        return
    with _LOCK:
        if _LOADED:
            return
        src_dir = _opai_src_dir()
        if os.path.isdir(src_dir) and src_dir not in sys.path:
            sys.path.insert(0, src_dir)
        _LOADED = True
