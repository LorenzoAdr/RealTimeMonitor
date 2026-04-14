#!/usr/bin/env bash
# Empaqueta entrega web_monitor_version/: layout bin/, data/, include/ + JS minificado (opcional),
# varmon_sidecar, libvarmonitor.so (CMake), varmonitor-web (PyInstaller).
# Requisitos: toolchain C++, Python/venv para PyInstaller, Node/npx para JS (o VARMON_SKIP_JS=1).
# Config: scripts/simple_config.sh (p. ej. VARMON_BUILD_DIR)
#
# Release con módulos externos (wheel Python + static/plugins/build/ con plugins-loader.js + chunks/):
#   VARMON_PLUGINS_RELEASE=1 ./scripts/varmon/generate_webmonitor_version.sh
# Antes: ./tool_plugins/scripts/build_all.sh  (wheel + tool_plugins/dist/plugins-browser/)
# Opcional: VARMON_PLUGINS_WHEEL=/ruta/wheel.whl  VARMON_PLUGINS_JS_DIR=/ruta/plugins-browser
# Sin VARMON_PLUGINS_RELEASE: empaquetado OSS (solo dependencias docker; sin wheel de plugins).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
OUT="$ROOT/web_monitor_version"
WM="$ROOT/web_monitor"
BUILD="${VARMON_BUILD_DIR:-$ROOT/build}"
LIBVM_DIR="$BUILD/libvarmonitor"

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
cmake -S "$ROOT" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DVARMON_LIB_SHARED=ON
cmake --build "$BUILD" --target varmon_sidecar varmonitor -j"$(nproc 2>/dev/null || echo 4)"

if [[ "${VARMON_PLUGINS_RELEASE:-0}" == "1" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/varmon/prepare_plugins_release_artifacts.sh"
  export VARMON_PLUGINS_RELEASE=1
  export VARMON_PLUGINS_WHEEL
else
  export VARMON_PLUGINS_RELEASE=0
  unset VARMON_PLUGINS_WHEEL || true
fi

"$ROOT/scripts/varmon/build_varmonitor_web.sh"

SIDECAR=$(find "$BUILD" -type f \( -name varmon_sidecar -o -name varmon_sidecar.exe \) -executable 2>/dev/null | head -1 || true)
if [[ -z "${SIDECAR}" ]]; then
  echo "No se encontró el binario varmon_sidecar bajo $BUILD" >&2
  exit 1
fi

if [[ ! -d "$LIBVM_DIR" ]] || ! compgen -G "$LIBVM_DIR"/libvarmonitor.so* >/dev/null; then
  echo "No se encontró libvarmonitor.so* bajo $LIBVM_DIR (¿cmake con -DVARMON_LIB_SHARED=ON?)" >&2
  exit 1
fi

rm -rf "${OUT:?}"
mkdir -p "$OUT/bin" "$OUT/data" "$OUT/include"

cp -a "$WM/dist/varmonitor-web" "$OUT/bin/"
cp -a "$SIDECAR" "$OUT/bin/varmon_sidecar"
cp -a "$LIBVM_DIR"/libvarmonitor.so* "$OUT/bin/"

cp -a "$ROOT/libvarmonitor/include/"*.hpp "$OUT/include/"

if [[ -f "$ROOT/data/varmon.conf" ]]; then
  cp -a "$ROOT/data/varmon.conf" "$OUT/data/varmon.conf"
fi

GIT_DESCRIBE="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo unknown)"
echo "$GIT_DESCRIBE" >"$OUT/VERSION"

_README_PLUGINS_NOTE=""
if [[ "${VARMON_PLUGINS_RELEASE:-0}" == "1" ]]; then
  _README_PLUGINS_NOTE="
Esta entrega incluye módulos externos opcionales (wheel Python embebida en varmonitor-web + JS en static/plugins/build/).
"
fi

cat >"$OUT/README.txt" <<EOF
VarMonitor — paquete de entrega (generado con scripts/varmon/generate_webmonitor_version.sh)
${_README_PLUGINS_NOTE}
Estructura:
  bin/             varmonitor-web (PyInstaller), varmon_sidecar, libvarmonitor.so*
  data/            varmon.conf (ejemplo)
  include/         Cabeceras C++ para enlazar frente a libvarmonitor.so (SDK)
  VERSION          git describe

Instalación típica (INSTALL_DIR = este árbol):
  INSTALL_DIR/bin/varmonitor-web
  INSTALL_DIR/bin/varmon_sidecar
  INSTALL_DIR/data/varmon.conf   →  export VARMON_CONFIG=.../data/varmon.conf
  INSTALL_DIR/data/recordings/   (creado al vuelo)
  INSTALL_DIR/data/server_state/

Grabación Parquet (opcional, si el wheel incluye el plugin parquet + pyarrow):
  En data/varmon.conf poner: parquet_recording_allowed = true
  Sin eso, las grabaciones son solo TSV aunque pyarrow esté en el binario.

Variables de entorno útiles:
  VARMON_CONFIG=/ruta/absoluta/data/varmon.conf
  VARMON_SIDECAR_BIN=/ruta/a/bin/varmon_sidecar
  VARMON_DATA_DIR=/ruta/a/data   (opcional; por defecto INSTALL_DIR/data con el backend empaquetado)

SDK C++ (otro CMake que consuma esta entrega): añade
  -IINSTALL_DIR/include -LINSTALL_DIR/bin -lvarmonitor -Wl,-rpath,INSTALL_DIR/bin
  (o LD_LIBRARY_PATH=INSTALL_DIR/bin al ejecutar el binario enlazado).

Versión: ${GIT_DESCRIBE}
EOF

echo "Listo: $OUT"
find "$OUT" -maxdepth 2 -type f -o -type d | head -40
ls -la "$OUT/bin" "$OUT/data" "$OUT/include"
