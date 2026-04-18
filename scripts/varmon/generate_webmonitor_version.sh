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

if [[ "${VARMON_BUILD_DEMO_SERVER:-0}" == "1" ]]; then
  echo "[generate_webmonitor_version] VARMON_BUILD_DEMO_SERVER=1: compilando demo_server…" >&2
  cmake --build "$BUILD" --target demo_server -j"$(nproc 2>/dev/null || echo 4)"
fi

if [[ "${VARMON_BUILD_CORENEXUS:-0}" == "1" ]]; then
  echo "[generate_webmonitor_version] VARMON_BUILD_CORENEXUS=1: compilando corenexus…" >&2
  export CORENEXUS_BUILD="${CORENEXUS_BUILD:-$ROOT/CoreNexus/build}"
  bash "$ROOT/scripts/varmon/build_corenexus.sh"
fi

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

if [[ "${VARMON_BUILD_DEMO_SERVER:-0}" == "1" ]]; then
  DEMO=$(find "$BUILD" -path "*/demo_server" -type f -executable 2>/dev/null | head -1 || true)
  if [[ -n "${DEMO}" ]]; then
    cp -a "$DEMO" "$OUT/bin/demo_server"
    echo "[generate_webmonitor_version] Copiado demo_server → $OUT/bin/demo_server" >&2
  else
    echo "[generate_webmonitor_version] AVISO: no se encontró demo_server bajo $BUILD" >&2
  fi
fi

CORENEXUS_BIN="$ROOT/CoreNexus/build/corenexus"
CORENEXUS_SO="$ROOT/CoreNexus/build/libcorenexus_core.so"
CORENEXUS_ING_SO="$ROOT/CoreNexus/build/libcorenexus_ingestor_mavlink.so"
if [[ "${VARMON_BUILD_CORENEXUS:-0}" == "1" ]]; then
  if [[ -x "$CORENEXUS_BIN" ]]; then
    cp -a "$CORENEXUS_BIN" "$OUT/bin/corenexus"
    echo "[generate_webmonitor_version] Copiado corenexus → $OUT/bin/corenexus" >&2
  else
    echo "[generate_webmonitor_version] AVISO: no ejecutable: $CORENEXUS_BIN" >&2
  fi
  if [[ -f "$CORENEXUS_SO" ]]; then
    cp -a "$CORENEXUS_SO" "$OUT/bin/"
    echo "[generate_webmonitor_version] Copiado libcorenexus_core.so → $OUT/bin/" >&2
  else
    echo "[generate_webmonitor_version] AVISO: no se encontró $CORENEXUS_SO (enlace dinámico)" >&2
  fi
  if [[ -f "$CORENEXUS_ING_SO" ]]; then
    cp -a "$CORENEXUS_ING_SO" "$OUT/bin/"
    echo "[generate_webmonitor_version] Copiado libcorenexus_ingestor_mavlink.so → $OUT/bin/" >&2
  fi
  if [[ -d "$ROOT/CoreNexus/testing" ]]; then
    mkdir -p "$OUT/testing"
    cp -a "$ROOT/CoreNexus/testing/." "$OUT/testing/"
    echo "[generate_webmonitor_version] Copiado CoreNexus/testing → $OUT/testing/" >&2
  fi
fi

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
                   (opcional) demo_server; corenexus + libcorenexus_core.so + libcorenexus_ingestor_mavlink.so
                   — si se compilaron con la GUI o VARMON_BUILD_*=1
  testing/         (opcional, si VARMON_BUILD_CORENEXUS=1) scripts MAVLink de prueba (launch_mavlink_*.sh, emisor Python)
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
  VARMON_CORENEXUS_BIN=/ruta/a/bin/corenexus   (modo package; launch_corenexus.sh)
  VARMON_DATA_DIR=/ruta/a/data   (opcional; por defecto INSTALL_DIR/data con el backend empaquetado)
  VARMON_BUILD_CORENEXUS=1 / VARMON_BUILD_DEMO_SERVER=1   (entrega: añaden bin/corenexus y/o bin/demo_server)

SDK C++ (otro CMake que consuma esta entrega): añade
  -IINSTALL_DIR/include -LINSTALL_DIR/bin -lvarmonitor -Wl,-rpath,INSTALL_DIR/bin
  (o LD_LIBRARY_PATH=INSTALL_DIR/bin al ejecutar el binario enlazado).

Versión: ${GIT_DESCRIBE}
EOF

echo "Listo: $OUT"
find "$OUT" -maxdepth 2 -type f -o -type d | head -40
ls -la "$OUT/bin" "$OUT/data" "$OUT/include"
