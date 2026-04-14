#!/usr/bin/env python3
"""
Une los .md del nav de MkDocs (ES y EN) y genera PDF con pandoc.
Requisitos: pandoc en PATH; para PDF suele hacer falta un motor (p. ej. pdflatex, xelatex, wkhtmltopdf).
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def _parse_docs_dir_and_nav(mkdocs_path: Path) -> tuple[str, list[str]]:
    text = mkdocs_path.read_text(encoding="utf-8", errors="replace")
    docs_dir = "docs"
    m = re.search(r"^docs_dir:\s*(\S+)", text, re.MULTILINE)
    if m:
        docs_dir = m.group(1).strip()
    nav_m = re.search(r"^nav:\s*$", text, re.MULTILINE)
    if not nav_m:
        raise ValueError(f"No se encontró nav: en {mkdocs_path}")
    start = nav_m.end()
    rest = text[start:]
    lines_out: list[str] = []
    for line in rest.splitlines():
        if line.strip() and not line.startswith(" ") and not line.startswith("\t"):
            break
        m2 = re.match(r"\s*-\s+[^:]+:\s*(\S+)\s*$", line)
        if m2:
            lines_out.append(m2.group(1))
    if not lines_out:
        raise ValueError(f"nav vacío o no parseable en {mkdocs_path}")
    return docs_dir, lines_out


def _merge_markdown(root: Path, docs_dir: str, files: list[str]) -> str:
    parts: list[str] = []
    base = root / docs_dir
    for name in files:
        p = base / name
        if not p.is_file():
            print(f"[build_docs_pdf] Aviso: falta {p}", file=sys.stderr)
            continue
        body = p.read_text(encoding="utf-8", errors="replace")
        parts.append(body.rstrip())
        parts.append("\n\n\\newpage\n\n")
    return "\n".join(parts).rstrip() + "\n"


def _pick_pdf_engine() -> list[str]:
    env = os.environ.get("VARMON_PDF_ENGINE", "").strip()
    if env:
        path = shutil.which(env) or (env if os.path.isfile(env) and os.access(env, os.X_OK) else None)
        if path:
            return ["--pdf-engine", path]
        print(f"[build_docs_pdf] VARMON_PDF_ENGINE={env!r} no es un ejecutable válido.", file=sys.stderr)
        sys.exit(1)
    for exe in ("wkhtmltopdf", "xelatex", "lualatex", "pdflatex"):
        if shutil.which(exe):
            return ["--pdf-engine", exe]
    return []


def _run_pandoc(merged: str, out_pdf: Path, title: str) -> None:
    if not shutil.which("pandoc"):
        print("[build_docs_pdf] pandoc no está en PATH (sudo apt install pandoc).", file=sys.stderr)
        sys.exit(1)
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    engine = _pick_pdf_engine()
    cmd = [
        "pandoc",
        "-f",
        "markdown",
        "-N",
        "--toc",
        "-V",
        "geometry:margin=2cm",
        "--metadata",
        f"title={title}",
        "-o",
        str(out_pdf),
    ]
    if not engine:
        print(
            "[build_docs_pdf] No hay motor PDF en PATH (wkhtmltopdf, xelatex, lualatex o pdflatex).\n"
            "  Instala p. ej.: sudo apt install pandoc texlive-xetex\n"
            "  o: sudo apt install pandoc wkhtmltopdf\n"
            "  Override: VARMON_PDF_ENGINE=/usr/bin/xelatex",
            file=sys.stderr,
        )
        sys.exit(1)
    cmd.extend(engine)
    try:
        subprocess.run(cmd, input=merged.encode("utf-8"), check=True, timeout=600)
    except FileNotFoundError:
        print("[build_docs_pdf] pandoc no está instalado (sudo apt install pandoc).", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"[build_docs_pdf] pandoc falló (código {e.returncode}).", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Generar PDF desde nav MkDocs.")
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Directorio de salida (por defecto: dist-docs/pdf en la raíz del repo)",
    )
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent.parent
    out_dir = args.out_dir or (root / "dist-docs" / "pdf")
    out_dir = out_dir.resolve()

    for cfg, slug, title in (
        (root / "mkdocs.yml", "es", "VarMonitor — documentación (ES)"),
        (root / "mkdocs.en.yml", "en", "VarMonitor — documentation (EN)"),
    ):
        if not cfg.is_file():
            print(f"[build_docs_pdf] Omitido (no existe): {cfg}", file=sys.stderr)
            continue
        docs_dir, files = _parse_docs_dir_and_nav(cfg)
        merged = _merge_markdown(root, docs_dir, files)
        out_pdf = out_dir / f"VarMonitor-docs-{slug}.pdf"
        print(f"[build_docs_pdf] Generando {out_pdf} desde {cfg} ({len(files)} páginas nav)...", flush=True)
        _run_pandoc(merged, out_pdf, title)
        print(f"[build_docs_pdf] OK: {out_pdf}", flush=True)


if __name__ == "__main__":
    main()
