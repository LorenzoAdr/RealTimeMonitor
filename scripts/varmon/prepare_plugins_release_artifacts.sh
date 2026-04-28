#!/usr/bin/env bash
# Prepara wheel Python + directorio JS (plugins-loader.js + chunks/) en static/plugins/build/ antes de PyInstaller.
#
# Uso (desde generate_webmonitor_version.sh):
#   source "$ROOT/scripts/varmon/prepare_plugins_release_artifacts.sh"
#
# Entradas (opcionales):
#   VARMON_PLUGINS_WHEEL       Ruta absoluta al .whl de varmonitor_plugins
#   VARMON_PLUGINS_JS_DIR      Directorio con plugins-loader.js + chunks/ + plugin-manifest.mjs
#
# Si no se definen, se busca:
#   Wheel:  web_monitor/vendor/varmonitor_plugins-*.whl  luego  tool_plugins/dist/varmonitor_plugins-*.whl
#   JS:     tool_plugins/dist/plugins-browser/  luego  web_monitor/static/plugins/build/
#
# Requisito: ejecutar antes ./tool_plugins/scripts/build_all.sh si partís del árbol de plugins.
set -euo pipefail

_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WM="$_ROOT/web_monitor"
TP="$_ROOT/tool_plugins"

_wheel_has_required_modules() {
  # Comprueba en el .whl la presencia de módulos backend Pro críticos.
  local whl="$1"
  python3 - "$whl" <<'PY'
import sys, zipfile
w = sys.argv[1]
required = {
    "varmonitor_plugins/gdb_debug.py",
    "varmonitor_plugins/terminal_api.py",
    "varmonitor_plugins/pro_http.py",
}
try:
    with zipfile.ZipFile(w) as z:
        names = set(z.namelist())
except Exception:
    raise SystemExit(2)
missing = [m for m in sorted(required) if m not in names]
if missing:
    print(",".join(missing))
    raise SystemExit(1)
raise SystemExit(0)
PY
}

# Rellenar web_monitor/static/plugins/ (fuentes .mjs + build/) desde tool_plugins si hay artefactos JS.
# Sin esto, PyInstaller empaqueta una carpeta vacía si el usuario borró static/plugins.
if [[ -f "$TP/scripts/copy_to_mit.sh" ]] && [[ -d "$TP/js/dist/plugins" ]]; then
  MIT_ROOT="$_ROOT" bash "$TP/scripts/copy_to_mit.sh" || {
    echo "[prepare_plugins_release_artifacts] AVISO: copy_to_mit.sh falló (¿falta npm run build en tool_plugins/js?)." >&2
  }
fi

if [[ -n "${VARMON_PLUGINS_WHEEL:-}" && -f "$VARMON_PLUGINS_WHEEL" ]]; then
  VARMON_PLUGINS_WHEEL="$(cd "$(dirname "$VARMON_PLUGINS_WHEEL")" && pwd)/$(basename "$VARMON_PLUGINS_WHEEL")"
  if ! _miss="$(_wheel_has_required_modules "$VARMON_PLUGINS_WHEEL" 2>/dev/null)"; then
    echo "[prepare_plugins_release_artifacts] ERROR: wheel explícita sin módulos Pro requeridos: $VARMON_PLUGINS_WHEEL" >&2
    [[ -n "${_miss:-}" ]] && echo "  Faltan: ${_miss}" >&2
    exit 1
  fi
else
  _w=""
  # Preferir wheel más reciente y válida; evita escoger una vendor antigua con misma versión.
  mapfile -t _cands < <(ls -1t "$TP/dist"/varmonitor_plugins-*.whl "$WM/vendor"/varmonitor_plugins-*.whl 2>/dev/null || true)
  if [[ ${#_cands[@]} -gt 0 ]]; then
    for _cand in "${_cands[@]}"; do
      if _miss="$(_wheel_has_required_modules "$_cand" 2>/dev/null)"; then
        _w="$_cand"
        break
      else
        echo "[prepare_plugins_release_artifacts] AVISO: wheel descartada (incompleta): $_cand" >&2
        [[ -n "${_miss:-}" ]] && echo "  faltan: ${_miss}" >&2
      fi
    done
  fi
  if [[ -z "$_w" ]]; then
    echo "[prepare_plugins_release_artifacts] ERROR: no se encontró varmonitor_plugins-*.whl." >&2
    echo "  Coloque una wheel válida en web_monitor/vendor/ o tool_plugins/dist/, o exporte VARMON_PLUGINS_WHEEL=" >&2
    echo "  Debe incluir: varmonitor_plugins.gdb_debug, terminal_api y pro_http." >&2
    exit 1
  fi
  VARMON_PLUGINS_WHEEL="$(cd "$(dirname "$_w")" && pwd)/$(basename "$_w")"
fi
export VARMON_PLUGINS_WHEEL

_jsdir="${VARMON_PLUGINS_JS_DIR:-}"
if [[ -z "$_jsdir" || ! -d "$_jsdir" || ! -f "$_jsdir/plugins-loader.js" ]]; then
  for _c in "$TP/dist/plugins-browser" "$WM/static/plugins/build"; do
    if [[ -d "$_c" && -f "$_c/plugins-loader.js" ]]; then
      _jsdir="$_c"
      break
    fi
  done
fi
if [[ -z "$_jsdir" || ! -f "$_jsdir/plugins-loader.js" ]]; then
  echo "[prepare_plugins_release_artifacts] ERROR: no se encontró directorio JS (plugins-loader.js)." >&2
  echo "  Ejecute: $_ROOT/tool_plugins/scripts/build_all.sh  o exporte VARMON_PLUGINS_JS_DIR=" >&2
  exit 1
fi
_jsdir="$(cd "$_jsdir" && pwd)"

mkdir -p "$WM/static/plugins/build"
rsync -a --delete "$_jsdir/" "$WM/static/plugins/build/"
echo "[prepare_plugins_release_artifacts] JS plugins -> $WM/static/plugins/build/ (desde $_jsdir)" >&2
echo "[prepare_plugins_release_artifacts] Wheel -> $VARMON_PLUGINS_WHEEL" >&2

export VARMON_PLUGINS_RELEASE=1
