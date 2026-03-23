#!/usr/bin/env bash
# Minifica web_monitor/static/app.js → static/dist/app.bundle.min.js (esbuild).
# Requiere Node.js con npx. Ejecutar antes de PyInstaller si quieres servir el bundle.
# Uso en runtime: export VARMON_WEB_APP_JS=dist/app.bundle.min.js
# Config: scripts/simple_config.sh
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
WM="$ROOT/web_monitor"
IN="$WM/static/app.js"
OUT="$WM/static/dist/app.bundle.min.js"
mkdir -p "$(dirname "$OUT")"
if [[ ! -f "$IN" ]]; then
  echo "No existe $IN" >&2
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "npx no encontrado; instala Node.js (https://nodejs.org/) para minificar el JS." >&2
  exit 1
fi
# Un solo fichero (IIFE): minificar; sin comentarios legales para reducir tamaño.
npx --yes esbuild "$IN" --minify --legal-comments=none --outfile="$OUT"
echo "Listo: $OUT"
echo "  Arranque: VARMON_WEB_APP_JS=dist/app.bundle.min.js ./scripts/launch_web.sh"
