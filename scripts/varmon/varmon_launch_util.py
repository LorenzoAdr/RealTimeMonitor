"""Utilidades compartidas: demo_server, taskset, backend empaquetado."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

PACKAGED_WEB_ENV = "VARMON_PACKAGED_WEB_BIN"


def find_demo_server(root: Path) -> Path | None:
    raw = os.environ.get("VARMON_DEMO_SERVER_BIN", "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.is_file() and os.access(p, os.X_OK):
            return p.resolve()
    for rel in ("build/demo_app/demo_server", "build/demo_server"):
        c = root / rel
        if c.is_file() and os.access(c, os.X_OK):
            return c
    return None


def resolve_taskset_affinities() -> tuple[str | None, str | None]:
    cpp = os.environ.get("VARMON_TASKSET_CPP", "").strip() or None
    py_aff = os.environ.get("VARMON_TASKSET_PY", "").strip() or None
    if cpp is not None or py_aff is not None:
        return cpp, py_aff
    n = os.cpu_count() or 1
    if n >= 8:
        return "0-1", "4-5"
    if n >= 4:
        return "0", "2"
    if n == 3:
        return "0", "2"
    if n == 2:
        return "0", "1"
    return None, None


def wrap_with_taskset(affinity: str | None, argv: list[str]) -> list[str]:
    if not affinity or not shutil.which("taskset"):
        return argv
    return ["taskset", "-c", affinity, *argv]


def resolve_packaged_web_bin() -> Path | None:
    raw = os.environ.get(PACKAGED_WEB_ENV, "").strip()
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_file():
        print(f"[launch_web] {PACKAGED_WEB_ENV} no existe: {p}", file=sys.stderr)
        sys.exit(1)
    if not os.access(p, os.X_OK):
        print(f"[launch_web] Sin permiso de ejecución: {p}", file=sys.stderr)
        sys.exit(1)
    return p.resolve()


def chdir_for_packaged_web(packaged: Path, *, install_dir_env: str = "VARMON_INSTALL_DIR") -> None:
    """Cwd típico para el onefile: directorio de instalación si existe; si no, el del binario."""
    raw = os.environ.get(install_dir_env, "").strip()
    if raw:
        d = Path(raw).expanduser()
        if d.is_dir():
            os.chdir(d)
            return
    os.chdir(str(packaged.parent))


def python_exe_for_web(web_dir: Path) -> Path:
    """Preferir web_monitor/.venv; si no existe, repo/.venv (mismo layout que setup.sh vs venv manual en raíz)."""
    venv_py = web_dir / ".venv" / "bin" / "python"
    if venv_py.is_file():
        return venv_py
    root_venv = web_dir.parent / ".venv" / "bin" / "python"
    if root_venv.is_file():
        return root_venv
    return Path(sys.executable)
