#!/usr/bin/env bash
# Arranca el monitor web en Docker desde la raíz del repositorio.
#
# Uso:
#   ./scripts/varmon/docker-run.sh              # red Docker + puerto 8080→8080 (análisis / sin C++ en host)
#   ./scripts/varmon/docker-run.sh host         # network_mode + ipc host + /tmp (Linux, live con C++ en el host)
#   ./scripts/varmon/docker-run.sh host -d      # igual, en segundo plano
#
# Config: scripts/simple_config.sh (opcional)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
cd "$ROOT"

if [[ "${1:-}" == "host" || "${1:-}" == "live" ]]; then
  shift
  exec docker compose -f docker-compose.host.yml up --build "$@"
else
  exec docker compose up --build "$@"
fi
