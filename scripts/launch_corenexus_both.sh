#!/usr/bin/env bash
# Arranca corenexus con ingestores MAVLink UDP + serie (un solo socat + PTY).
#
# Es un delegador sobre launch_corenexus.sh: la lógica (rutas PTY por UID,
# VARMON_MAVLINK_PTY_TAG, --debug-mavlink, trap de socat, etc.) está ahí.
#
# Ejemplos:
#   ./scripts/launch_corenexus_both.sh
#   ./scripts/launch_corenexus_both.sh --debug-mavlink
#   ./scripts/launch_corenexus_both.sh --build
# Emisor serie (otra terminal, sin abrir python a mano):
#   ./scripts/launch_mavlink_emitter_serial.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/launch_corenexus.sh" --mavlink-both "$@"
