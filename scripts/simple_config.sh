#!/usr/bin/env bash
# =============================================================================
# VarMonitor — configuración central (se hace source desde los lanzadores)
#
# Edita solo la sección «Usuario» más abajo. Modo:
#   code    — desarrollo: python web_monitor/app.py, rutas por defecto en repo
#   package — instalación generada: binarios en VARMON_INSTALL_DIR
#
# Tras editar:   source scripts/simple_config.sh   (o simplemente usa ./scripts/launch_*.sh)
# Depuración:    export VARMON_CONFIG_VERBOSE=1
# =============================================================================

# --- Usuario: edita debajo ---
# Modo de ejecución: code | package
VARMON_RUN_MODE="${VARMON_RUN_MODE:-code}"

# Con package: directorio INSTALL_DIR con bin/, data/, include/ (entrega generate_webmonitor_version.sh).
# Déjalo vacío para usar por defecto: <repo>/web_monitor_version/
# export VARMON_INSTALL_DIR=/opt/varmonitor

# Opcional: forzar rutas (descomenta y ajusta). Si están vacías, se aplican según el modo.
#export VARMON_CONFIG=
#export VARMON_PACKAGED_WEB_BIN=
# En modo code se hace unset de VARMON_SIDECAR_BIN para no arrastrar rutas del modo package.
# El backend elige el sidecar así: recording_sidecar_bin en varmon.conf → build/varmon_sidecar del repo → PATH.
#export VARMON_SIDECAR_BIN=
#export VARMON_DATA_DIR=
#export VARMON_WEB_APP_JS=
# Trazas despliegue GUI en consola del backend (ficheros bajo static/, script inyectado):
#export VARMON_DEBUG_GUI_DEPLOY=1

# --- Fin usuario ---

if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  _SIMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  _SIMPLE_DIR="$(cd "$(dirname "$0")" && pwd)"
fi
export VARMON_REPO_ROOT="$(cd "$_SIMPLE_DIR/.." && pwd)"

: "${VARMON_INSTALL_DIR:=$VARMON_REPO_ROOT/web_monitor_version}"

_apply_simple_config() {
  case "${VARMON_RUN_MODE}" in
    code)
      export VARMON_CONFIG="${VARMON_CONFIG:-$VARMON_REPO_ROOT/data/varmon.conf}"
      unset VARMON_PACKAGED_WEB_BIN 2>/dev/null || true
      unset VARMON_SIDECAR_BIN 2>/dev/null || true
      unset VARMON_CORENEXUS_BIN 2>/dev/null || true
      ;;
    package)
      export VARMON_CONFIG="${VARMON_CONFIG:-$VARMON_INSTALL_DIR/data/varmon.conf}"
      export VARMON_PACKAGED_WEB_BIN="${VARMON_PACKAGED_WEB_BIN:-$VARMON_INSTALL_DIR/bin/varmonitor-web}"
      export VARMON_SIDECAR_BIN="${VARMON_SIDECAR_BIN:-$VARMON_INSTALL_DIR/bin/varmon_sidecar}"
      export VARMON_CORENEXUS_BIN="${VARMON_CORENEXUS_BIN:-$VARMON_INSTALL_DIR/bin/corenexus}"
      export VARMON_DATA_DIR="${VARMON_DATA_DIR:-$VARMON_INSTALL_DIR/data}"
      ;;
    *)
      echo "[simple_config] VARMON_RUN_MODE inválido: ${VARMON_RUN_MODE} (usa code o package)" >&2
      export VARMON_CONFIG="${VARMON_CONFIG:-$VARMON_REPO_ROOT/data/varmon.conf}"
      unset VARMON_PACKAGED_WEB_BIN 2>/dev/null || true
      ;;
  esac
}

_apply_simple_config

if [[ "${VARMON_CONFIG_VERBOSE:-0}" =~ ^(1|true|yes)$ ]]; then
  echo "[simple_config] RUN_MODE=${VARMON_RUN_MODE} REPO=${VARMON_REPO_ROOT}" >&2
  echo "[simple_config] VARMON_CONFIG=${VARMON_CONFIG:-}" >&2
  if [[ "${VARMON_RUN_MODE}" == "package" ]]; then
    echo "[simple_config] VARMON_INSTALL_DIR=${VARMON_INSTALL_DIR}" >&2
    echo "[simple_config] VARMON_PACKAGED_WEB_BIN=${VARMON_PACKAGED_WEB_BIN:-}" >&2
    echo "[simple_config] VARMON_SIDECAR_BIN=${VARMON_SIDECAR_BIN:-}" >&2
    echo "[simple_config] VARMON_CORENEXUS_BIN=${VARMON_CORENEXUS_BIN:-}" >&2
    echo "[simple_config] VARMON_DATA_DIR=${VARMON_DATA_DIR:-}" >&2
  fi
  echo "[simple_config] VARMON_WEB_APP_JS=${VARMON_WEB_APP_JS:-<no>}" >&2
fi

unset -f _apply_simple_config 2>/dev/null || true
