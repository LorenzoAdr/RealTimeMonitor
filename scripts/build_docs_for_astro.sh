#!/usr/bin/env bash
# Genera la documentación MkDocs (ES + EN) y la copia a astro/public/docs/{es,en}/ para que
# el sitio Astro (p. ej. GitHub Pages) sirva las mismas rutas que el monitor: /docs/es/ y /docs/en/.
#
# Requisitos: pip install mkdocs mkdocs-material pymdown-extensions
# (coincide con web_monitor/requirements.txt para construir docs.)
#
# Uso (desde la raíz del repo):
#   ./scripts/build_docs_for_astro.sh
# Luego: cd astro && npm run build
#
# Opcional: STRICT=1 activa `mkdocs build --strict` (falla ante avisos).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VENV_MKDOCS="$ROOT/web_monitor/.venv/bin/mkdocs"
if [[ -x "$VENV_MKDOCS" ]]; then
	MKDOCS=("$VENV_MKDOCS")
elif command -v mkdocs >/dev/null 2>&1; then
	MKDOCS=(mkdocs)
elif command -v python3 >/dev/null 2>&1 && python3 -m mkdocs --version >/dev/null 2>&1; then
	MKDOCS=(python3 -m mkdocs)
else
	echo "No se encontró mkdocs. Opciones:" >&2
	echo "  - Activa el venv del proyecto: source web_monitor/.venv/bin/activate && pip install -r web_monitor/requirements.txt" >&2
	echo "  - O instala en tu entorno: pip install mkdocs mkdocs-material pymdown-extensions" >&2
	exit 1
fi

STRICT_FLAG=()
if [[ "${STRICT:-0}" == "1" ]]; then
	STRICT_FLAG=(--strict)
fi

echo "==> mkdocs build (español) -> site/"
"${MKDOCS[@]}" build "${STRICT_FLAG[@]}"

echo "==> mkdocs build (inglés) -> site_en/"
"${MKDOCS[@]}" build -f mkdocs.en.yml "${STRICT_FLAG[@]}"

DEST="$ROOT/astro/public/docs"
rm -rf "$DEST/es" "$DEST/en"
mkdir -p "$DEST/es" "$DEST/en"

cp -a "$ROOT/site/." "$DEST/es/"
cp -a "$ROOT/site_en/." "$DEST/en/"

echo "==> Copiado a astro/public/docs/es/ y astro/public/docs/en/"
echo "    Próximo paso: (cd astro && npm run build)"
