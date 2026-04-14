#!/usr/bin/env bash
# Solo el backend web: venv + app.py, o VARMON_PACKAGED_WEB_BIN hacia el exe PyInstaller.
# Config central: edita scripts/simple_config.sh (modo code|package y rutas).
# Opciones útiles: VARMON_MEMTRACE=1, VARMON_TASKSET_PY,
# JS minificado: --web-app-js dist/app.bundle.min.js
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
MEMTRACE=0
WEB_APP_JS=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --memtrace|-memtrace) MEMTRACE=1; shift ;;
    --web-app-js) shift; WEB_APP_JS="${1:-}"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [[ "$MEMTRACE" -eq 1 ]]; then
  export VARMON_MEMTRACE=1
  echo "[launch_web] VARMON_MEMTRACE=1" >&2
fi
# Evitar heredar VARMON_WEB_APP_JS de otra sesión (p. ej. tras build del bundle):
# sin esto el servidor inyecta dist/app.bundle.min.js y la UI falla si falta o está viejo.
if [[ -n "${WEB_APP_JS}" ]]; then
  export VARMON_WEB_APP_JS="${WEB_APP_JS}"
  echo "[launch_web] VARMON_WEB_APP_JS=${WEB_APP_JS}" >&2
else
  unset VARMON_WEB_APP_JS 2>/dev/null || true
fi
exec python3 "$ROOT/scripts/varmon/launch_web.py" "${ARGS[@]}"
