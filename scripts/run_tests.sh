#!/usr/bin/env bash
# Ejecuta la batería completa de tests unitarios (Python, C++, JavaScript).
# Uso: ./scripts/run_tests.sh [--python] [--cpp] [--js] [--coverage]
#   Sin argumentos: ejecuta las tres capas.
#   --python    solo tests Python
#   --cpp       solo tests C++
#   --js        solo tests JavaScript
#   --coverage  añade informe de cobertura a los tests Python
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -euo pipefail

RUN_PY=0
RUN_CPP=0
RUN_JS=0
COVERAGE=0

if [[ $# -eq 0 ]]; then
  RUN_PY=1; RUN_CPP=1; RUN_JS=1
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)   RUN_PY=1;   shift ;;
    --cpp)      RUN_CPP=1;  shift ;;
    --js)       RUN_JS=1;   shift ;;
    --coverage) COVERAGE=1; shift ;;
    *) echo "Opción desconocida: $1"; exit 1 ;;
  esac
done

TOTAL_OK=0
TOTAL_FAIL=0

# Encuentra un gestor para instalar tests/js (npm junto a node, yarn, pnpm).
_js_pkg_manager() {
  if command -v npm >/dev/null 2>&1; then
    echo "npm"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    local _nd _bin
    _nd=$(command -v node)
    _bin=$(dirname "$_nd")
    if [[ -x "$_bin/npm" ]]; then
      echo "$_bin/npm"
      return 0
    fi
  fi
  if command -v yarn >/dev/null 2>&1; then
    echo "yarn"
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    echo "bun"
    return 0
  fi
  return 1
}

_js_install_deps() {
  local d="$1"
  local pm
  pm=$(_js_pkg_manager) || return 1
  case "$pm" in
    yarn)  (cd "$d" && yarn install --silent) ;;
    pnpm)  (cd "$d" && pnpm install --silent) ;;
    bun)   (cd "$d" && bun install) ;;
    npm|*) (cd "$d" && "$pm" install --silent) ;;
  esac
}

# ── Python ──
if [[ "$RUN_PY" -eq 1 ]]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Python tests (pytest)"
  echo "═══════════════════════════════════════════════════"
  VENV="$ROOT/web_monitor/.venv/bin/activate"
  if [[ ! -f "$VENV" ]]; then
    echo "[run_tests] ERROR: no existe el venv ($VENV)." >&2
    echo "  Ejecuta: ./scripts/varmon/setup.sh" >&2
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  else
    # shellcheck disable=SC1090
    source "$VENV"
    # Paquete Pro (ARINC/M1553/Parquet/Git/Terminal/GDB): necesario para rutas y tests en tool_plugins/python/tests.
    pip install -q -e "$ROOT/tool_plugins/python" 2>/dev/null || true
    COV_ARGS=()
    if [[ "$COVERAGE" -eq 1 ]]; then
      # Incluye módulos con tests dedicados y el backend app.
      # Requiere: pip install -r web_monitor/requirements.txt (pytest-cov).
      COV_ARGS=(
        --cov=perf_agg
        --cov=uds_client
        --cov=shm_reader
        --cov=varmonitor_plugins
        --cov=app
        --cov-report=term-missing
      )
    fi
    PY_FAIL=0
    # Tests Pro primero: test_plugin_registry puede sustituir sys.modules["varmonitor_plugins"] temporalmente.
    if ! python -m pytest "$ROOT/tool_plugins/python/tests/" -v "${COV_ARGS[@]}"; then
      PY_FAIL=1
    fi
    if ! python -m pytest "$ROOT/tests/python/" -v "${COV_ARGS[@]}"; then
      PY_FAIL=1
    fi
    if [[ "$PY_FAIL" -eq 0 ]]; then
      TOTAL_OK=$((TOTAL_OK + 1))
    else
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi
  fi
fi

# ── C++ ──
if [[ "$RUN_CPP" -eq 1 ]]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  C++ tests (GoogleTest)"
  echo "═══════════════════════════════════════════════════"
  CPP_BIN="$ROOT/tests/cpp/build/varmonitor_tests"
  if [[ ! -x "$CPP_BIN" ]]; then
    echo "[run_tests] C++ tests no compilados. Compilando..." >&2
    mkdir -p "$ROOT/tests/cpp/build"
    cmake -S "$ROOT/tests/cpp" -B "$ROOT/tests/cpp/build" \
      -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ 2>&1 | tail -3
    cmake --build "$ROOT/tests/cpp/build" -j"$(nproc)" 2>&1 | tail -5
  fi
  if "$CPP_BIN" --gtest_print_time=0; then
    TOTAL_OK=$((TOTAL_OK + 1))
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
fi

# ── JavaScript ──
if [[ "$RUN_JS" -eq 1 ]]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  JavaScript tests (vitest)"
  echo "═══════════════════════════════════════════════════"
  JS_DIR="$ROOT/tests/js"
  NPM_MISSING=0
  if [[ ! -d "$JS_DIR/node_modules" ]]; then
    echo "[run_tests] Instalando dependencias JS..." >&2
    if ! _js_install_deps "$JS_DIR"; then
      echo "[run_tests] ERROR: no se pudieron instalar dependencias JS." >&2
      echo "  Instala Node.js con npm (p. ej. paquete «npm» o Node desde nodejs.org/nvm)" >&2
      echo "  o ejecuta manualmente: cd tests/js && npm install   (o yarn / pnpm)" >&2
      NPM_MISSING=1
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi
  fi
  if [[ "$NPM_MISSING" -eq 0 ]]; then
    VITEST_BIN="$JS_DIR/node_modules/.bin/vitest"
    if [[ ! -x "$VITEST_BIN" ]]; then
      echo "[run_tests] ERROR: no se encontró vitest en $VITEST_BIN (¿npm install en tests/js?)." >&2
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    elif (cd "$JS_DIR" && "$VITEST_BIN" run); then
      TOTAL_OK=$((TOTAL_OK + 1))
    else
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi
  fi
fi

# ── Resumen ──
echo ""
echo "═══════════════════════════════════════════════════"
if [[ "$TOTAL_FAIL" -eq 0 ]]; then
  echo "  ✅ Todos los tests pasaron ($TOTAL_OK suite(s))"
else
  echo "  ❌ $TOTAL_FAIL suite(s) fallaron, $TOTAL_OK OK"
fi
echo "═══════════════════════════════════════════════════"

exit "$TOTAL_FAIL"
