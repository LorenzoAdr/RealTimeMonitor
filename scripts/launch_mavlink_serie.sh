#!/usr/bin/env bash
# Crea un par de PTYs con socat y arranca el emisor en un extremo.
# Punto de entrada recomendado: ./scripts/launch_mavlink_serie.sh (desde la raíz del repo).
#
# IMPORTANTE: corenexus debe abrir el extremo ..._test_a_... (el primero que se muestra).
# El emisor escribe en ..._test_b_.... Si inviertes las rutas, no verás datos en corenexus.
#
# Orden recomendado: 1) este script (socat + espera), 2) corenexus en otra terminal en la ruta A,
# 3) el emisor arranca solo tras la espera (o use --wait en el emisor).
#
# Requisitos: socat, pymavlink, pyserial (mismo criterio que launch_mavlink_udp.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v socat >/dev/null 2>&1; then
  echo "[launch_mavlink_serie] Instale socat (p. ej. apt install socat)." >&2
  exit 1
fi

if [[ -z "${VARMON_PYTHON3:-}" && -x "$MONITOR_ROOT/web_monitor/.venv/bin/python" ]]; then
  export VARMON_PYTHON3="$MONITOR_ROOT/web_monitor/.venv/bin/python"
fi
PYTHON="${VARMON_PYTHON3:-python3}"

# Mismo criterio que launch_corenexus.sh --mavlink-both: $$ cambia por terminal; usar UID (o VARMON_MAVLINK_PTY_TAG).
_PTY_TAG="${VARMON_MAVLINK_PTY_TAG:-${UID}}"
A="${VARMON_MAVLINK_TEST_PTY_A:-${TMPDIR:-/tmp}/corenexus_mavlink_test_a_${_PTY_TAG}}"
B="${VARMON_MAVLINK_TEST_PTY_B:-${TMPDIR:-/tmp}/corenexus_mavlink_test_b_${_PTY_TAG}}"
# Un solo socat por tag: si launch_corenexus_both ya levantó el par, no reutilizar el mismo tag.
LOCKFILE="${TMPDIR:-/tmp}/corenexus_mavlink_pty_${_PTY_TAG}.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -n 9; then
    echo "[launch_mavlink_serie] Ya hay otro proceso usando el par PTY (tag=${_PTY_TAG})." >&2
    echo "[launch_mavlink_serie] No ejecute a la vez ./scripts/launch_corenexus_both.sh (tiene su propio socat): son dos pares distintos aunque las rutas se llamen igual." >&2
    echo "[launch_mavlink_serie] Cierre el otro script o use: export VARMON_MAVLINK_PTY_TAG=otro" >&2
    exit 1
  fi
fi
rm -f "$A" "$B"
BAUD="${VARMON_MAVLINK_TEST_BAUD:-57600}"
WAIT_SEC="${VARMON_MAVLINK_SERIE_WAIT_SEC:-3}"

cleanup() {
  if [[ -n "${SOCAT_PID:-}" ]] && kill -0 "$SOCAT_PID" 2>/dev/null; then
    kill -TERM "$SOCAT_PID" 2>/dev/null || true
    wait "$SOCAT_PID" 2>/dev/null || true
  fi
  rm -f "$A" "$B"
}
trap cleanup EXIT INT TERM

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
  echo "[launch_mavlink_serie] socat no creó los enlaces (¿socat antiguo sin link=?)." >&2
  exit 1
fi

echo "" >&2
echo "[launch_mavlink_serie] --- Serie simulada (socat) ---" >&2
echo "[launch_mavlink_serie] LEER aquí → corenexus (misma velocidad ${BAUD}):" >&2
echo "  corenexus --mavlink-serial $A --mavlink-baud $BAUD" >&2
echo "[launch_mavlink_serie] ESCRIBE el emisor en (no abrir con corenexus):" >&2
echo "  $B" >&2
echo "[launch_mavlink_serie] Esperando ${WAIT_SEC}s para que arranques corenexus en la ruta de arriba…" >&2
sleep "$WAIT_SEC"

export VARMON_MAVLINK_TEST=emitter
exec "$PYTHON" "$SCRIPT_DIR/mavlink_test_emitter.py" --mode serial --serial "$B" --baud "$BAUD" "$@"
