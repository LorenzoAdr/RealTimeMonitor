"""Búsqueda find/grep en file_edit (plugin)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tool_plugins" / "python" / "src"))

from varmonitor_plugins import file_edit_api as fe  # noqa: E402


@pytest.fixture()
def file_edit_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(fe, "BROWSER_ROOT", tmp_path)
    app = FastAPI()
    fe.register_routes(app)
    return TestClient(app)


def test_find_files_matches_name(tmp_path: Path, file_edit_app: TestClient) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "hello_world.py").write_text("x", encoding="utf-8")
    r = file_edit_app.get("/api/file_edit/find_files", params={"q": "hello", "base": ""})
    assert r.status_code == 200
    d = r.json()
    assert "src/hello_world.py" in d["files"]


def test_find_files_skips_build_artifacts(tmp_path: Path, file_edit_app: TestClient) -> None:
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "foo.o").write_bytes(b"\x7fELF")
    (tmp_path / "b" / "lib.so").write_bytes(b"\x7fELF")
    (tmp_path / "b" / "foo.d").write_bytes(b"\x7fELF")
    (tmp_path / "b" / "foo.txt").write_text("hello", encoding="utf-8")
    r = file_edit_app.get("/api/file_edit/find_files", params={"q": "foo", "base": ""})
    assert r.status_code == 200
    files = r.json()["files"]
    assert "b/foo.txt" in files
    assert "b/foo.o" not in files
    assert "b/lib.so" not in files
    assert "b/foo.d" not in files


def test_grep_finds_line(tmp_path: Path, file_edit_app: TestClient) -> None:
    (tmp_path / "t").mkdir()
    (tmp_path / "t" / "a.txt").write_text("alpha beta\n", encoding="utf-8")
    r = file_edit_app.get("/api/file_edit/grep", params={"q": "beta", "base": ""})
    assert r.status_code == 200
    d = r.json()
    assert len(d["matches"]) >= 1
    assert d["matches"][0]["path"] == "t/a.txt"
    assert d["matches"][0]["line"] == 1


def test_cpp_index_config_lists_roots(
    tmp_path: Path, file_edit_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(fe.CONFIG, "file_edit_cpp_index_roots", "demo,sdk")
    r = file_edit_app.get("/api/file_edit/cpp_index_config")
    assert r.status_code == 200
    roots = r.json()["roots"]
    assert "demo" in roots and "sdk" in roots


def test_build_cpp_index_extracts_symbols(
    tmp_path: Path, file_edit_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(fe.CONFIG, "file_edit_cpp_index_roots", "demo")
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "a.cpp").write_text(
        "namespace N {\nvoid foo() {}\n}\nclass Bar {};\n",
        encoding="utf-8",
    )
    r = file_edit_app.post("/api/file_edit/build_cpp_index")
    assert r.status_code == 200
    j = r.json()
    assert j["files_scanned"] >= 1
    syms = j["symbols"]
    assert "foo" in syms or "Bar" in syms or "N" in syms


def test_build_cpp_index_extracts_qualified_var_name(
    tmp_path: Path, file_edit_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Variables con tipo `ns::Type name` (p. ej. demo main: varmon::VarMonitor monitor)."""
    monkeypatch.setitem(fe.CONFIG, "file_edit_cpp_index_roots", "demo")
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "b.cpp").write_text(
        "#include <vector>\n"
        "void f() {\n"
        "  std::vector<int> v;\n"
        "  ns::Thing t;\n"
        "}\n",
        encoding="utf-8",
    )
    r = file_edit_app.post("/api/file_edit/build_cpp_index")
    assert r.status_code == 200
    syms = r.json()["symbols"]
    assert "v" in syms and "t" in syms


def test_build_cpp_index_extracts_stdint_variable(
    tmp_path: Path, file_edit_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Variables `uint32_t nombre` sin :: en el tipo (p. ej. demo_app/main.cpp)."""
    monkeypatch.setitem(fe.CONFIG, "file_edit_cpp_index_roots", "demo")
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "c.cpp").write_text(
        "void f() {\n  uint32_t m1553_rt1_w3_status_word = 0u;\n}\n",
        encoding="utf-8",
    )
    r = file_edit_app.post("/api/file_edit/build_cpp_index")
    assert r.status_code == 200
    assert "m1553_rt1_w3_status_word" in r.json()["symbols"]


def test_build_cpp_index_extracts_multiline_init_variable(
    tmp_path: Path, file_edit_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Declaración con inicializador en varias líneas (p. ej. shm_publisher.cpp `double timestamp =`)."""
    monkeypatch.setitem(fe.CONFIG, "file_edit_cpp_index_roots", "demo")
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "d.cpp").write_text(
        "void f() {\n"
        "  double timestamp = std::chrono::duration<double>(\n"
        "      std::chrono::system_clock::now().time_since_epoch()).count();\n"
        "}\n",
        encoding="utf-8",
    )
    r = file_edit_app.post("/api/file_edit/build_cpp_index")
    assert r.status_code == 200
    assert "timestamp" in r.json()["symbols"]


def test_build_cpp_index_without_roots_returns_400(
    file_edit_app: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(fe.CONFIG, "file_edit_cpp_index_roots", "")
    r = file_edit_app.post("/api/file_edit/build_cpp_index")
    assert r.status_code == 400
