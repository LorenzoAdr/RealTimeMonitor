#!/usr/bin/env bash
# Solo el binario C++ demo_server (VarMonitor de ejemplo). Ver scripts/launch_demo.py.
# Config: scripts/simple_config.sh (VARMON_CONFIG, etc.)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
exec python3 "$ROOT/scripts/varmon/launch_demo.py" "$@"
