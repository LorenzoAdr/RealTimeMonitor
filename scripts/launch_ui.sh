#!/usr/bin/env bash
# Abre navegador / ventana embebida en el puerto más alto del rango varmon.conf con backend respondiendo.
# Config: scripts/simple_config.sh
# --web-app-js: override puntual (misma opción que launch_web).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
WEB_APP_JS=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --web-app-js) shift; WEB_APP_JS="${1:-}"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [[ -n "${WEB_APP_JS}" ]]; then
  export VARMON_WEB_APP_JS="${WEB_APP_JS}"
  echo "[launch_ui] VARMON_WEB_APP_JS=${WEB_APP_JS}" >&2
else
  unset VARMON_WEB_APP_JS 2>/dev/null || true
fi
exec python3 "$ROOT/scripts/varmon/launch_ui.py" "${ARGS[@]}"
