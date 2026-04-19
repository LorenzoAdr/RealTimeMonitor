#!/usr/bin/env bash
# Lanza el emisor MAVLink por UDP hacia el puerto donde escucha corenexus (por defecto 127.0.0.1:14550).
# Punto de entrada recomendado: ./scripts/launch_mavlink_udp.sh (desde la raíz del repo).
#
# Entorno: VARMON_PYTHON3 → intérprete con pymavlink (por defecto web_monitor/.venv si existe).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${VARMON_PYTHON3:-}" && -x "$MONITOR_ROOT/web_monitor/.venv/bin/python" ]]; then
  export VARMON_PYTHON3="$MONITOR_ROOT/web_monitor/.venv/bin/python"
fi
PYTHON="${VARMON_PYTHON3:-python3}"

export VARMON_MAVLINK_TEST="${VARMON_MAVLINK_TEST:-emitter}"

exec "$PYTHON" "$SCRIPT_DIR/mavlink_test_emitter.py" --mode udp "$@"
