#!/bin/bash
set -e

echo "=== Instalando dependencias del sistema ==="
sudo apt-get update -qq
sudo apt-get install -y build-essential cmake g++ python3-pip python3-venv

echo "=== Creando entorno virtual Python ==="
cd "$(dirname "$0")/../web_monitor"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "=== Dependencias instaladas correctamente ==="
echo ""
echo "Para compilar el proyecto:"
echo "  cd $(dirname "$0")/.."
echo "  mkdir -p build && cd build"
echo "  cmake .. && make -j$(nproc)"
echo ""
echo "Para arrancar:"
echo "  1. ./build/demo_app/demo_server"
echo "  2. cd web_monitor && source .venv/bin/activate && python app.py"
echo "  3. Abrir http://localhost:8080"
