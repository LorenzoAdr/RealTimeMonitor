#!/usr/bin/env bash
# Arranca corenexus (VarMonitor hub): deja SHM/UDS activos; en otra terminal usa ./scripts/launch_web.sh
# Config: scripts/simple_config.sh (VARMON_CONFIG, modo code|package).
# Opciones: --build  compila antes con scripts/varmon/build_corenexus.sh
#           --help
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail

DO_BUILD=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) DO_BUILD=1; shift ;;
    -h|--help)
      echo "Uso: $0 [--build] [--config /ruta/varmon.conf] [--sample-ms N] [args pasados a corenexus]"
      echo "  --build   Ejecuta scripts/varmon/build_corenexus.sh antes de lanzar."
      exit 0
      ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

if [[ "$DO_BUILD" -eq 1 ]]; then
  "$ROOT/scripts/varmon/build_corenexus.sh"
fi

CORENEXUS_BUILD="${CORENEXUS_BUILD:-$ROOT/CoreNexus/build}"
BIN_CODE="$CORENEXUS_BUILD/corenexus"
if [[ "${VARMON_RUN_MODE:-code}" == "package" && -n "${VARMON_CORENEXUS_BIN:-}" && -x "${VARMON_CORENEXUS_BIN}" ]]; then
  BIN="${VARMON_CORENEXUS_BIN}"
else
  BIN="$BIN_CODE"
fi

if [[ ! -x "$BIN" ]]; then
  echo "[launch_corenexus] No hay ejecutable en $BIN — compilando…" >&2
  "$ROOT/scripts/varmon/build_corenexus.sh"
  BIN="$BIN_CODE"
fi

export VARMON_CONFIG="${VARMON_CONFIG:-$VARMON_REPO_ROOT/data/varmon.conf}"
echo "[launch_corenexus] VARMON_CONFIG=${VARMON_CONFIG}" >&2
echo "[launch_corenexus] Binario: $BIN" >&2
echo "[launch_corenexus] En otra terminal (backend web): $ROOT/scripts/launch_web.sh" >&2
exec "$BIN" "${ARGS[@]}"
