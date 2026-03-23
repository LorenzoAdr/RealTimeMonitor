#!/usr/bin/env bash
# Genera PDF de la documentación Markdown (nav de mkdocs.yml y mkdocs.en.yml) → dist-docs/pdf/
# Requiere: pandoc; recomendado: texlive-xetex o wkhtmltopdf (sudo apt install pandoc texlive-xetex)
# Config opcional: scripts/simple_config.sh (VARMON_REPO_ROOT)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
exec python3 "$ROOT/scripts/varmon/build_docs_pdf.py" "$@"
