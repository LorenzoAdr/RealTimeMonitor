#!/usr/bin/env bash
# Quita *.map y la línea //# sourceMappingURL=… de los chunks bajo static/plugins/build/chunks/
# (esbuild a veces emitía .map sin "sources" → aviso en Firefox). Uso tras copiar plugins a web_monitor:
#   bash scripts/varmon/strip_plugin_chunks_sourcemaps.sh
#   bash scripts/varmon/strip_plugin_chunks_sourcemaps.sh /ruta/a/static/plugins/build/chunks
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${1:-$ROOT/web_monitor/static/plugins/build/chunks}"
if [[ ! -d "$DIR" ]]; then
  echo "[strip_plugin_chunks_sourcemaps] No existe: $DIR" >&2
  exit 1
fi
find "$DIR" -maxdepth 1 -name '*.map' -type f -delete
shopt -s nullglob
for f in "$DIR"/*.js; do
  sed -i '/sourceMappingURL/d' "$f"
done
echo "[strip_plugin_chunks_sourcemaps] OK → $DIR"
