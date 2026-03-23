#!/usr/bin/env python3
"""Arranca solo el backend web (python app.py o binario PyInstaller)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

ROOT = Path(__file__).resolve().parent.parent.parent
WEB = ROOT / "web_monitor"
APP = WEB / "app.py"

from varmon_launch_util import (
    PACKAGED_WEB_ENV,
    python_exe_for_web,
    resolve_packaged_web_bin,
    resolve_taskset_affinities,
    wrap_with_taskset,
)


def main() -> None:
    os.chdir(WEB)
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    vc = os.environ.get("VARMON_CONFIG", "").strip()
    if vc:
        print(f"[launch_web] VARMON_CONFIG={vc}", flush=True)

    packaged = resolve_packaged_web_bin()
    if packaged is not None:
        print(f"[launch_web] Backend empaquetado: {packaged}", flush=True)
    else:
        if not APP.is_file():
            print(
                f"No se encuentra {APP}. Crea el venv (./scripts/varmon/setup.sh) o define {PACKAGED_WEB_ENV}.",
                file=sys.stderr,
            )
            sys.exit(1)

    _, py_aff = resolve_taskset_affinities()
    if packaged is not None:
        cmd = wrap_with_taskset(py_aff, [str(packaged)])
    else:
        py = python_exe_for_web(WEB)
        cmd = wrap_with_taskset(py_aff, [str(py), str(APP)])

    import shutil

    if py_aff and shutil.which("taskset"):
        print(f"[launch_web] taskset -c {py_aff}", flush=True)
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
