#!/usr/bin/env bash
# Detiene procesos VarMonitor del USUARIO ACTUAL únicamente (no toca otros UID).
# Patrones: demo_server, corenexus (hub VarMonitor), web_monitor/app.py, varmonitor-web (PyInstaller), varmon_sidecar,
# pruebas MAVLink (CoreNexus/testing o web_monitor_version/testing, emisor pymavlink, socat de PTY de prueba).
#
# Opcional: VARMON_STOP_DRY_RUN=1  → solo lista PIDs, no envía señales.
# Opcional: VARMON_STOP_FORCE=1    → tras SIGTERM, SIGKILL a los que sigan vivos.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail

UID_CUR="$(id -u)"
USER_CUR="$(id -un)"

dry_run=0
if [[ "${VARMON_STOP_DRY_RUN:-}" =~ ^(1|true|yes)$ ]]; then
  dry_run=1
fi
force_kill=0
if [[ "${VARMON_STOP_FORCE:-}" =~ ^(1|true|yes)$ ]]; then
  force_kill=1
fi

# Patrones -f (regex) lo bastante específicos para no matar procesos ajenos al repo.
PATTERNS=(
  'build[/]demo_app[/]demo_server|[/]demo_app[/]demo_server'
  'CoreNexus[/]build[/]corenexus|web_monitor_version[/]bin[/]corenexus|\./corenexus'
  'web_monitor[/]app\.py'
  'varmonitor-web'
  'varmon_sidecar'
  '(CoreNexus|web_monitor_version)[/]testing[/].*launch_mavlink_(udp|serie)\.sh|mavlink_test_emitter\.py|corenexus_mavlink_test_[ab]_|VARMON_MAVLINK_TEST=socat'
)

collect_pids() {
  local pat combined=""
  for pat in "${PATTERNS[@]}"; do
    if [[ -n "$combined" ]]; then
      combined="${combined}|"
    fi
    combined="${combined}(${pat})"
  done
  pgrep -u "$UID_CUR" -f "$combined" 2>/dev/null || true
}

sig_term_then_kill() {
  local pids=("$@")
  [[ ${#pids[@]} -eq 0 ]] && return 0
  if [[ "$dry_run" -eq 1 ]]; then
    return 0
  fi
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ "$force_kill" -ne 1 ]]; then
    return 0
  fi
  sleep 1
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

echo "[stop_varmonitor] Usuario: $USER_CUR (uid=$UID_CUR)"

mapfile -t ALL_PIDS < <(collect_pids | sort -nu)
if [[ ${#ALL_PIDS[@]} -eq 0 ]]; then
  echo "[stop_varmonitor] No hay procesos coincidentes."
  exit 0
fi

echo "[stop_varmonitor] PIDs: ${ALL_PIDS[*]}"
if [[ "$dry_run" -eq 1 ]]; then
  # Solo -p (no mezclar con -u: en GNU ps puede listar todo el usuario).
  ps -o pid=,args= -p "${ALL_PIDS[@]}" 2>/dev/null || true
  echo "[stop_varmonitor] VARMON_STOP_DRY_RUN=1 — no se ha enviado señal."
  exit 0
fi

# Mostrar línea de comando antes de matar
ps -o pid=,args= -p "${ALL_PIDS[@]}" 2>/dev/null || true

sig_term_then_kill "${ALL_PIDS[@]}"
echo "[stop_varmonitor] Enviado SIGTERM${VARMON_STOP_FORCE:+; SIGKILL a rezagados con VARMON_STOP_FORCE=1}."
