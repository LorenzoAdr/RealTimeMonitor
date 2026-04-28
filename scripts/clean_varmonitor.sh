#!/usr/bin/env bash
# Elimina artefactos de compilación y preparación del monitor (static, build C++, salidas tool_plugins,
# entregas locales, wheels en vendor, etc.). No borra el venv de web_monitor salvo --venv.
#
# Uso (desde la raíz del repo):
#   ./scripts/clean_varmonitor.sh
#   ./scripts/clean_varmonitor.sh --dry-run
#   ./scripts/clean_varmonitor.sh --venv          # incluye web_monitor/.venv
#
# Ver también: scripts/LAUNCH.md, AGENTS.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0
WITH_VENV=0

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat <<'EOF'
Uso: ./scripts/clean_varmonitor.sh [--dry-run] [--venv]

  --dry-run   Solo lista lo que se borraría (no elimina).
  --venv      Incluye web_monitor/.venv (hay que recrearlo después).

Borra entre otros: build/, CoreNexus/build/, web_monitor/static/, vendor/,
web_monitor_version/, tool_plugins/{dist,python/dist,.venv-build}, js/node_modules, etc.
EOF
      exit 0
      ;;
    -n|--dry-run) DRY=1 ;;
    --venv) WITH_VENV=1 ;;
    *)
      echo "Opción desconocida: $arg (usa --help)" >&2
      exit 1
      ;;
  esac
done

# Rutas bajo ROOT que son seguras de borrar como artefactos
PATHS=(
  "$ROOT/build"
  "$ROOT/CoreNexus/build"
  "$ROOT/web_monitor/static"
  "$ROOT/web_monitor/dist"
  "$ROOT/web_monitor/build"
  "$ROOT/web_monitor/.venv-build"
  "$ROOT/web_monitor/vendor"
  "$ROOT/web_monitor_version"
  "$ROOT/web_monitor_version_old"
  "$ROOT/build-judge"
  "$ROOT/build-plan-verify"
  "$ROOT/build-sidecar"
  "$ROOT/dist-docs"
  "$ROOT/tool_plugins/dist"
  "$ROOT/tool_plugins/python/dist"
  "$ROOT/tool_plugins/python/.venv-build"
  "$ROOT/tool_plugins/js/node_modules"
  "$ROOT/tool_plugins/js/dist"
  "$ROOT/tests/js/node_modules"
)

if [[ "$WITH_VENV" -eq 1 ]]; then
  PATHS+=("$ROOT/web_monitor/.venv")
fi

rm_one() {
  local p="$1"
  if [[ ! -e "$p" ]]; then
    return 0
  fi
  if [[ "$DRY" -eq 1 ]]; then
    echo "[dry-run] rm -rf $p"
  else
    echo "rm -rf $p" >&2
    rm -rf "$p"
  fi
}

echo "[clean_varmonitor] Raíz: $ROOT (dry-run=$DRY, incluye .venv=$WITH_VENV)" >&2
for p in "${PATHS[@]}"; do
  rm_one "$p"
done

if [[ "$DRY" -eq 1 ]]; then
  echo "[clean_varmonitor] Fin (dry-run; no se borró nada)." >&2
else
  echo "[clean_varmonitor] Fin. Recrea venv con: cd web_monitor && python3 -m venv .venv && ..." >&2
fi
