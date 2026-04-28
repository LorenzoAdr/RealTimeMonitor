#!/usr/bin/env python3
"""Arranca solo el demo_server (C++), con taskset opcional."""
from __future__ import annotations

import os
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

ROOT = Path(__file__).resolve().parent.parent.parent

from varmon_launch_util import find_demo_server, resolve_taskset_affinities, wrap_with_taskset


def main() -> None:
    exe = find_demo_server(ROOT)
    if exe is None:
        print(
            "[launch_demo] No hay demo_server. Compila (cmake --build build --target demo_server) "
            "o define VARMON_DEMO_SERVER_BIN.",
            file=sys.stderr,
        )
        sys.exit(1)
    cpp_aff, _ = resolve_taskset_affinities()
    cmd = wrap_with_taskset(cpp_aff, [str(exe)])
    os.chdir(ROOT)
    import shutil

    if cpp_aff and shutil.which("taskset"):
        print(f"[launch_demo] taskset -c {cpp_aff}", flush=True)
    print(f"[launch_demo] {exe}", flush=True)
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
