#!/usr/bin/env bash
# Arranca app.py y abre la UI en ventana nativa (pywebview). Ver run_desktop.py.
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
