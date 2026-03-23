#!/usr/bin/env bash
# Empaqueta entrega web_monitor_version/: JS minificado (opcional), varmon_sidecar (CMake), varmonitor-web (PyInstaller).
# Requisitos: toolchain C++, Python/venv para PyInstaller, Node/npx para JS (o VARMON_SKIP_JS=1).
# Config: scripts/simple_config.sh (p. ej. VARMON_BUILD_DIR)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
OUT="$ROOT/web_monitor_version"
WM="$ROOT/web_monitor"
BUILD="${VARMON_BUILD_DIR:-$ROOT/build}"

# JS minificado: opcional (requiere Node.js; el onefile ya incluye static/app.js sin minificar).
if [[ "${VARMON_SKIP_JS:-0}" == "1" ]]; then
  echo "[generate_webmonitor_version] VARMON_SKIP_JS=1: sin minificar JS." >&2
elif command -v npx >/dev/null 2>&1; then
  "$ROOT/scripts/varmon/build_web_static_js.sh" || {
    echo "[generate_webmonitor_version] AVISO: falló build_web_static_js.sh; continúa con app.js sin minificar." >&2
  }
else
  echo "[generate_webmonitor_version] Node/npx no está en PATH: se omite el minificado JS (instala Node.js o exporta VARMON_SKIP_JS=1 para silenciar). El PyInstaller seguirá empaquetando static/app.js tal cual." >&2
fi

mkdir -p "$BUILD"
cmake -S "$ROOT" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" --target varmon_sidecar -j"$(nproc 2>/dev/null || echo 4)"

"$ROOT/scripts/varmon/build_varmonitor_web.sh"

SIDECAR=$(find "$BUILD" -type f \( -name varmon_sidecar -o -name varmon_sidecar.exe \) -executable 2>/dev/null | head -1 || true)
if [[ -z "${SIDECAR}" ]]; then
  echo "No se encontró el binario varmon_sidecar bajo $BUILD" >&2
  exit 1
fi

rm -rf "${OUT:?}"
mkdir -p "$OUT"
cp -a "$WM/dist/varmonitor-web" "$OUT/"
cp -a "$SIDECAR" "$OUT/varmon_sidecar"
if [[ -f "$ROOT/data/varmon.conf" ]]; then
  cp -a "$ROOT/data/varmon.conf" "$OUT/varmon.conf"
fi

GIT_DESCRIBE="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo unknown)"
echo "$GIT_DESCRIBE" >"$OUT/VERSION"

cat >"$OUT/README.txt" <<EOF
VarMonitor — paquete de entrega (generado con scripts/varmon/generate_webmonitor_version.sh)

Contenido:
  varmonitor-web   Backend web (PyInstaller onefile)
  varmon_sidecar   Grabación/alarmas SHM (CMake)
  varmon.conf      Ejemplo de configuración (copia junto a los binarios en el destino)
  VERSION          git describe

Instalación típica (mismo directorio INSTALL_DIR):
  INSTALL_DIR/varmonitor-web
  INSTALL_DIR/varmon_sidecar
  INSTALL_DIR/varmon.conf
  INSTALL_DIR/data/recordings/    (creado al vuelo)
  INSTALL_DIR/data/server_state/  (plantillas, sesiones)

Variables de entorno útiles:
  VARMON_CONFIG=/ruta/absoluta/varmon.conf
  VARMON_SIDECAR_BIN=/ruta/a/varmon_sidecar
  VARMON_DATA_DIR=/ruta/a/data   (opcional; por defecto INSTALL_DIR/data en ejecutable empaquetado)

Versión: ${GIT_DESCRIBE}
EOF

echo "Listo: $OUT"
ls -la "$OUT"
