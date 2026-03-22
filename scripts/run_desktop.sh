#!/usr/bin/env bash
# Arranca demo_server (C++) en segundo plano, app.py y la UI (pywebview). Ver run_desktop.py.
#
# En Linux, si existe `taskset`, se fija afinidad por defecto: núcleos distintos para
# el demo C++ y para el proceso Python (menos interferencia en pruebas). Personalizar:
#   export VARMON_TASKSET_CPP=0-1
#   export VARMON_TASKSET_PY=2-3
# No arrancar el binario de demo (p. ej. ya tienes otro VarMonitor):
#   export VARMON_SKIP_DEMO=1
# Ruta al ejecutable C++:
export VARMON_DEMO_SERVER_BIN=../build/demo_app/demo_server
#
# Opciones:
#   --memtrace   Activa VARMON_MEMTRACE=1 en el backend (tracemalloc; top asignaciones en consola ~cada 30s).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${ROOT}/web_monitor/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "No hay venv en web_monitor/.venv. Ejecuta primero: ./scripts/setup.sh" >&2
  exit 1
fi
MEMTRACE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --memtrace|-memtrace) MEMTRACE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
if [[ "$MEMTRACE" -eq 1 ]]; then
  export VARMON_MEMTRACE=1
  echo "[run_desktop] VARMON_MEMTRACE=1 — tracemalloc en el log del servidor (ver consola)." >&2
fi
exec "$PY" "${ROOT}/scripts/run_desktop.py" "${ARGS[@]}"
