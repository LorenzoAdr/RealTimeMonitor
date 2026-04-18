#!/usr/bin/env bash
# Compila el ejecutable coreNexus (repo CoreNexus/) enlazando libvarmonitor del árbol principal.
# Uso: desde la raíz del repo VarMonitor:
#   ./scripts/varmon/build_corenexus.sh
# Variables: CORENEXUS_BUILD (directorio build), CMAKE_BUILD_TYPE, CXX.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail

CORENEXUS_SRC="$ROOT/CoreNexus"
CORENEXUS_BUILD="${CORENEXUS_BUILD:-$ROOT/CoreNexus/build}"
export CORENEXUS_BUILD

if [[ ! -f "$CORENEXUS_SRC/CMakeLists.txt" ]]; then
  echo "[build_corenexus] No existe $CORENEXUS_SRC/CMakeLists.txt" >&2
  exit 1
fi

mkdir -p "$CORENEXUS_BUILD"
CMAKE_EXTRA=()
if [[ -n "${VARMON_PYTHON3:-}" ]]; then
  CMAKE_EXTRA+=(-DPython3_EXECUTABLE="${VARMON_PYTHON3}")
  echo "[build_corenexus] Python3_EXECUTABLE=${VARMON_PYTHON3}" >&2
fi
cmake -S "$CORENEXUS_SRC" -B "$CORENEXUS_BUILD" \
  -DCMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE:-Release}" \
  -DVARMON_LIB_ROOT="$ROOT/libvarmonitor" \
  -DVARMON_LIB_SHARED=ON \
  -DCMAKE_CXX_COMPILER="${CXX:-g++}" \
  "${CMAKE_EXTRA[@]}"
cmake --build "$CORENEXUS_BUILD" -j"$(nproc 2>/dev/null || echo 4)"
echo "[build_corenexus] OK: $CORENEXUS_BUILD/corenexus (y targets MAVLink si CORENEXUS_WITH_MAVLINK=ON)"
