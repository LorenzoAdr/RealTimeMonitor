#!/bin/bash
set -e

echo "=== Instalando dependencias del sistema ==="
sudo apt-get update -qq
sudo apt-get install -y build-essential cmake g++ python3-pip python3-venv

echo "=== Creando entorno virtual Python ==="
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
cd "$ROOT/web_monitor"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install -r requirements-desktop.txt
python "$(dirname "$0")/patch_pywebview_qt.py"

echo "=== Dependencias instaladas correctamente ==="
echo ""
echo "Para compilar el proyecto:"
echo "  cd $ROOT"
echo "  mkdir -p build && cd build"
echo "  cmake .. && make -j$(nproc)"
echo ""
echo "Para arrancar (tres terminales o el orden que prefieras):"
echo "  ./scripts/launch_demo.sh     # solo C++ demo_server"
echo "  ./scripts/launch_web.sh      # solo backend FastAPI (venv o VARMON_PACKAGED_WEB_BIN)"
echo "  ./scripts/launch_ui.sh       # abre navegador / pywebview (puerto más alto del rango en varmon.conf)"
echo ""
echo "Copia local opcional de lanzadores antiguos: scripts/_legacy_launch/ (gitignored). Ver scripts/LAUNCH.md"
