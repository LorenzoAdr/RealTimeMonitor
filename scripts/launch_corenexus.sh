#!/usr/bin/env bash
# Arranca corenexus (VarMonitor hub): deja SHM/UDS activos; en otra terminal usa ./scripts/launch_web.sh
# Config: scripts/simple_config.sh (VARMON_CONFIG, modo code|package).
# Opciones: --build  compila antes con scripts/varmon/build_corenexus.sh
#           --mavlink-both  activa ingestores UDP (escucha) y serie (PTY socat) a la vez
#           --debug-mavlink exporta CORENEXUS_MAVLINK_DEBUG / _HEX (trazas en stderr del binario)
#           --help
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail

DO_BUILD=0
MAVLINK_BOTH=0
DEBUG_MAVLINK=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) DO_BUILD=1; shift ;;
    --mavlink-both) MAVLINK_BOTH=1; shift ;;
    --debug-mavlink) DEBUG_MAVLINK=1; shift ;;
    -h|--help)
      echo "Uso: $0 [--build] [--mavlink-both] [--debug-mavlink] [--config /ruta/varmon.conf] [--sample-ms N] [args pasados a corenexus]"
      echo "  --build          Ejecuta scripts/varmon/build_corenexus.sh antes de lanzar."
      echo "  --mavlink-both   Añade --mavlink-udp y --mavlink-serial en un PTY (socat). Requiere socat."
      echo "                   UDP: opcional VARMON_MAVLINK_UDP_SPEC (ej. :14550 o 0.0.0.0:14551) como argumento de --mavlink-udp."
      echo "                   Serie: VARMON_MAVLINK_TEST_BAUD (57600); PTY por defecto comparten tag VARMON_MAVLINK_PTY_TAG (uid) o rutas VARMON_MAVLINK_TEST_PTY_A/B."
      echo "                   Con --mavlink-both NO use scripts/launch_mavlink_serie.sh (otro socat): emita solo en el _B_ que imprime este script."
      echo "  --debug-mavlink  Equivale a exportar CORENEXUS_MAVLINK_DEBUG=1 y CORENEXUS_MAVLINK_DEBUG_HEX=48 (override con env)."
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

if [[ "$DEBUG_MAVLINK" -eq 1 ]]; then
  export CORENEXUS_MAVLINK_DEBUG="${CORENEXUS_MAVLINK_DEBUG:-1}"
  export CORENEXUS_MAVLINK_DEBUG_HEX="${CORENEXUS_MAVLINK_DEBUG_HEX:-48}"
  echo "[launch_corenexus] Debug MAVLink → stderr: CORENEXUS_MAVLINK_DEBUG=${CORENEXUS_MAVLINK_DEBUG} CORENEXUS_MAVLINK_DEBUG_HEX=${CORENEXUS_MAVLINK_DEBUG_HEX}" >&2
fi

export VARMON_CONFIG="${VARMON_CONFIG:-$VARMON_REPO_ROOT/data/varmon.conf}"
echo "[launch_corenexus] VARMON_CONFIG=${VARMON_CONFIG}" >&2
echo "[launch_corenexus] Binario: $BIN" >&2
echo "[launch_corenexus] En otra terminal (backend web): $ROOT/scripts/launch_web.sh" >&2

MAVLINK_PREFIX=()
if [[ "$MAVLINK_BOTH" -eq 1 ]]; then
  if ! command -v socat >/dev/null 2>&1; then
    echo "[launch_corenexus] --mavlink-both requiere socat (p. ej. apt install socat)." >&2
    exit 1
  fi
  BAUD="${VARMON_MAVLINK_TEST_BAUD:-57600}"
  # No usar $$: cada terminal tiene shell distinto y los extremos A/B no coincidirían entre scripts.
  _PTY_TAG="${VARMON_MAVLINK_PTY_TAG:-${UID}}"
  A="${VARMON_MAVLINK_TEST_PTY_A:-${TMPDIR:-/tmp}/corenexus_mavlink_test_a_${_PTY_TAG}}"
  B="${VARMON_MAVLINK_TEST_PTY_B:-${TMPDIR:-/tmp}/corenexus_mavlink_test_b_${_PTY_TAG}}"
  LOCKFILE="${TMPDIR:-/tmp}/corenexus_mavlink_pty_${_PTY_TAG}.lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCKFILE"
    if ! flock -n 9; then
      echo "[launch_corenexus] Ya hay otro proceso usando el par PTY (tag=${_PTY_TAG})." >&2
      echo "[launch_corenexus] ¿Tiene abierto scripts/launch_mavlink_serie.sh? No lo mezcle con --mavlink-both: dos socat = dos cables distintos; cierre uno o use VARMON_MAVLINK_PTY_TAG distinto." >&2
      exit 1
    fi
  fi
  rm -f "$A" "$B"

  cleanup_socat() {
    if [[ -n "${SOCAT_PID:-}" ]] && kill -0 "$SOCAT_PID" 2>/dev/null; then
      kill -TERM "$SOCAT_PID" 2>/dev/null || true
      wait "$SOCAT_PID" 2>/dev/null || true
    fi
    rm -f "$A" "$B"
  }
  trap cleanup_socat EXIT INT TERM

  # shellcheck disable=SC2094
  env VARMON_MAVLINK_TEST=socat socat -d -d \
    "pty,raw,echo=0,link=$A" \
    "pty,raw,echo=0,link=$B" &
  SOCAT_PID=$!

  for _ in {1..50}; do
    if [[ -e "$B" && -e "$A" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ ! -e "$B" || ! -e "$A" ]]; then
    echo "[launch_corenexus] socat no creó los enlaces PTY (¿socat antiguo sin link=?)." >&2
    exit 1
  fi

  MAVLINK_PREFIX=(--mavlink-udp)
  if [[ -n "${VARMON_MAVLINK_UDP_SPEC:-}" ]]; then
    MAVLINK_PREFIX+=("${VARMON_MAVLINK_UDP_SPEC}")
  fi
  MAVLINK_PREFIX+=(--mavlink-serial "$A" --mavlink-baud "$BAUD")

  echo "" >&2
  echo "[launch_corenexus] --mavlink-both: ingestores UDP + serie activos." >&2
  echo "[launch_corenexus]   Serie — LEER: corenexus → $A | ESCRIBE emisor → $B (mismo baud ${BAUD})" >&2
  echo "[launch_corenexus]   No arranque scripts/launch_mavlink_serie.sh: crearía OTRO par PTY y el emisor no llegaría a este corenexus." >&2
  echo "[launch_corenexus]   Emisor (otra terminal): $ROOT/scripts/launch_mavlink_emitter_serial.sh" >&2
  echo "[launch_corenexus]   UDP: emisor hacia el puerto que escucha corenexus (por defecto 14550), p. ej. $ROOT/scripts/launch_mavlink_udp.sh" >&2
  echo "" >&2
  # No usar exec: hace falta el proceso shell para que el trap mate socat al salir corenexus.
  "$BIN" "${MAVLINK_PREFIX[@]}" "${ARGS[@]}"
  exit $?
fi

exec "$BIN" "${ARGS[@]}"
