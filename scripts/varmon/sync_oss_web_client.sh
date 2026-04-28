#!/usr/bin/env bash
# Copia el cliente web OSS versionado en el repo sobre web_monitor/static/.
# Fuente canónica: web_monitor/client_oss/ (misma estructura que static/: index.html,
# js/entry.mjs, js/app-legacy.mjs, css/, etc.).
#
# Uso: desde la raíz del repo:
#   ./scripts/varmon/sync_oss_web_client.sh
# Opcional: MIT_ROOT=/ruta/al/repo
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIT_ROOT="${MIT_ROOT:-$ROOT}"
SRC="$MIT_ROOT/web_monitor/client_oss"
STA="$MIT_ROOT/web_monitor/static"
SRC_MOD="$SRC/js/modules"
STA_MOD="$STA/js/modules"
LEGACY_MOD="$MIT_ROOT/web_monitor/js_modules"

if [[ ! -d "$SRC" ]]; then
  exit 0
fi

if [[ ! -f "$SRC/js/entry.mjs" ]] && [[ ! -f "$SRC/js/app-legacy.mjs" ]] && [[ ! -f "$SRC/index.html" ]]; then
  echo "[sync_oss_web_client] Aviso: $SRC existe pero no contiene index.html ni js/entry.mjs ni js/app-legacy.mjs; no se sincroniza." >&2
  exit 0
fi

mkdir -p "$STA"
# Fusionar sin borrar plugins/ ni js/modules ya generados por copy_to_mit.
rsync -a "$SRC/" "$STA/"

# Retirar restos del cliente monolítico legado si existían en static/.
_legacy_stub="app"
_legacy_ext=".js"
rm -f "$STA/${_legacy_stub}${_legacy_ext}" "$STA/js/${_legacy_stub}${_legacy_ext}"

# Módulos ESM: fuente prioritaria en client_oss/js/modules; fallback en web_monitor/js_modules.
mkdir -p "$STA_MOD"
if [[ -d "$SRC_MOD" ]]; then
  rsync -a "$SRC_MOD/" "$STA_MOD/"
elif [[ -d "$LEGACY_MOD" ]]; then
  rsync -a "$LEGACY_MOD/" "$STA_MOD/"
fi

echo "[sync_oss_web_client] OK: $SRC/ → $STA/" >&2
