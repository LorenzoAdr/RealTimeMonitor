#!/usr/bin/env bash
# Emisor MAVLink por serie hacia el extremo _b_ por defecto (mismo criterio que
# launch_corenexus.sh --mavlink-both). No hace falta invocar python a mano.
#
# Uso (tras arrancar ./scripts/launch_corenexus_both.sh en otra terminal):
#   ./scripts/launch_mavlink_emitter_serial.sh
#   ./scripts/launch_mavlink_emitter_serial.sh --hz 10 --wait 2
#
# Entorno: VARMON_MAVLINK_PTY_TAG, VARMON_MAVLINK_TEST_PTY_B, VARMON_MAVLINK_TEST_BAUD,
#          VARMON_PYTHON3 (por defecto web_monitor/.venv si existe).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${VARMON_PYTHON3:-}" && -x "$MONITOR_ROOT/web_monitor/.venv/bin/python" ]]; then
  export VARMON_PYTHON3="$MONITOR_ROOT/web_monitor/.venv/bin/python"
fi
PYTHON="${VARMON_PYTHON3:-python3}"

_PTY_TAG="${VARMON_MAVLINK_PTY_TAG:-${UID}}"
B="${VARMON_MAVLINK_TEST_PTY_B:-${TMPDIR:-/tmp}/corenexus_mavlink_test_b_${_PTY_TAG}}"
BAUD="${VARMON_MAVLINK_TEST_BAUD:-57600}"

export VARMON_MAVLINK_TEST="${VARMON_MAVLINK_TEST:-emitter}"

echo "[launch_mavlink_emitter_serial] --serial $B @ ${BAUD} (debe coincidir con el _b_ de launch_corenexus_both)" >&2

exec "$PYTHON" "$SCRIPT_DIR/mavlink_test_emitter.py" --mode serial --serial "$B" --baud "$BAUD" "$@"
