#!/usr/bin/env bash
# Empaqueta web_monitor/static/js/entry.mjs (+ módulos) → static/dist/app.bundle.min.js (esbuild IIFE).
# Requiere Node.js con npx. Ejecutar antes de PyInstaller si quieres servir el bundle.
# Uso en runtime: export VARMON_WEB_APP_JS=dist/app.bundle.min.js
# Config: scripts/simple_config.sh
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
WM="$ROOT/web_monitor"
IN="$WM/static/js/entry.mjs"
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
# Bundle browser IIFE (sin type=module en index); minificar.
npx --yes esbuild "$IN" \
  --bundle \
  --format=iife \
  --platform=browser \
  --minify \
  --legal-comments=none \
  --outfile="$OUT"
echo "Listo: $OUT"
echo "  Arranque: VARMON_WEB_APP_JS=dist/app.bundle.min.js ./scripts/launch_web.sh"
