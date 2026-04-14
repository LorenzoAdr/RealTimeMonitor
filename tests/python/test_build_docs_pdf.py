"""Tests unitarios para scripts/varmon/build_docs_pdf.py — parsing nav YAML y merge markdown."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

import build_docs_pdf
from build_docs_pdf import _parse_docs_dir_and_nav, _merge_markdown, _pick_pdf_engine


class TestParseDocsAndNav:
    def test_valid_mkdocs(self, tmp_path):
        cfg = tmp_path / "mkdocs.yml"
        cfg.write_text(
            "site_name: Test\n"
            "docs_dir: docs\n"
            "nav:\n"
            "  - Home: index.md\n"
            "  - Setup: setup.md\n"
            "  - API: api.md\n"
        )
        docs_dir, files = _parse_docs_dir_and_nav(cfg)
        assert docs_dir == "docs"
        assert files == ["index.md", "setup.md", "api.md"]

    def test_custom_docs_dir(self, tmp_path):
        cfg = tmp_path / "mkdocs.yml"
        cfg.write_text(
            "docs_dir: docs_en\n"
            "nav:\n"
            "  - Index: index.md\n"
        )
        docs_dir, files = _parse_docs_dir_and_nav(cfg)
        assert docs_dir == "docs_en"
        assert files == ["index.md"]

    def test_no_nav_raises(self, tmp_path):
        cfg = tmp_path / "mkdocs.yml"
        cfg.write_text("site_name: Test\n")
        with pytest.raises(ValueError, match="nav"):
            _parse_docs_dir_and_nav(cfg)

    def test_empty_nav_raises(self, tmp_path):
        cfg = tmp_path / "mkdocs.yml"
        cfg.write_text(
            "nav:\n"
            "# empty below\n"
            "theme:\n"
            "  name: material\n"
        )
        with pytest.raises(ValueError, match="vacío"):
            _parse_docs_dir_and_nav(cfg)

    def test_default_docs_dir(self, tmp_path):
        cfg = tmp_path / "mkdocs.yml"
        cfg.write_text("nav:\n  - Page: page.md\n")
        docs_dir, _ = _parse_docs_dir_and_nav(cfg)
        assert docs_dir == "docs"


class TestMergeMarkdown:
    def test_merges_files(self, tmp_path):
        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "a.md").write_text("# A\nContent A")
        (docs / "b.md").write_text("# B\nContent B")
        merged = _merge_markdown(tmp_path, "docs", ["a.md", "b.md"])
        assert "# A" in merged
        assert "# B" in merged
        assert "\\newpage" in merged

    def test_missing_file_skipped(self, tmp_path):
        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "a.md").write_text("# A")
        merged = _merge_markdown(tmp_path, "docs", ["a.md", "missing.md"])
        assert "# A" in merged

    def test_empty_file_list(self, tmp_path):
        merged = _merge_markdown(tmp_path, "docs", [])
        assert merged.strip() == ""


class TestPickPdfEngine:
    def test_env_var_override(self, monkeypatch):
        monkeypatch.setenv("VARMON_PDF_ENGINE", "xelatex")
        with patch("shutil.which", return_value="/usr/bin/xelatex"):
            result = _pick_pdf_engine()
        assert result == ["--pdf-engine", "/usr/bin/xelatex"]

    def test_fallback_order(self, monkeypatch):
        monkeypatch.delenv("VARMON_PDF_ENGINE", raising=False)
        def mock_which(name):
            return f"/usr/bin/{name}" if name == "pdflatex" else None
        with patch("shutil.which", side_effect=mock_which):
            result = _pick_pdf_engine()
        assert len(result) == 2
        assert result[0] == "--pdf-engine"
        assert "pdflatex" in result[1]

    def test_no_engine_returns_empty(self, monkeypatch):
        monkeypatch.delenv("VARMON_PDF_ENGINE", raising=False)
        with patch("shutil.which", return_value=None):
            result = _pick_pdf_engine()
        assert result == []
