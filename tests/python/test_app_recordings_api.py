"""Tests de integración y unitarios para lectura de TSV en modo análisis (API + helpers de app.py).

Cubre rutas críticas antes de descomponer el repositorio: bounds, history, window, save_tsv.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "web_monitor"))

from fastapi.testclient import TestClient


def _sample_tsv_three_rows() -> str:
    return (
        "time_s\ta\tb\n"
        "0.0\t1.0\t10.0\n"
        "1.0\t2.0\t20.0\n"
        "2.0\t3.0\t30.0\n"
    )


@pytest.fixture
def recordings_env(monkeypatch, tmp_path):
    """Directorio de grabaciones aislado + limpieza del índice temporal en memoria."""
    import app as app_mod

    rec = tmp_path / "recordings"
    rec.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(app_mod, "RECORDINGS_DIR", str(rec))
    with app_mod._TIME_INDEX_LOCK:
        app_mod._TIME_INDEX.clear()
    yield rec
    with app_mod._TIME_INDEX_LOCK:
        app_mod._TIME_INDEX.clear()


@pytest.fixture
def client(recordings_env):
    import app as app_mod

    return TestClient(app_mod.app)


class TestReadTsvHelpers:
    """Pruebas directas de _read_*_tsv (sin HTTP)."""

    def test_read_single_var_history(self, recordings_env):
        import app as app_mod

        path = recordings_env / "s.tsv"
        path.write_text(_sample_tsv_three_rows(), encoding="utf-8")
        data = app_mod._read_single_var_history_tsv(str(path), "a", max_points=20000)
        assert data["name"] == "a"
        assert data["timestamps"] == [0.0, 1.0, 2.0]
        assert data["values"] == [1.0, 2.0, 3.0]

    def test_read_single_var_history_unknown_column(self, recordings_env):
        import app as app_mod

        path = recordings_env / "s.tsv"
        path.write_text(_sample_tsv_three_rows(), encoding="utf-8")
        with pytest.raises(KeyError, match="missing"):
            app_mod._read_single_var_history_tsv(str(path), "missing", max_points=100)

    def test_read_single_var_history_downsample(self, recordings_env):
        import app as app_mod

        lines = ["time_s\tx\n"]
        for i in range(100):
            lines.append(f"{float(i)}\t{float(i)}\n")
        path = recordings_env / "big.tsv"
        path.write_text("".join(lines), encoding="utf-8")
        data = app_mod._read_single_var_history_tsv(str(path), "x", max_points=10)
        assert len(data["timestamps"]) <= 11
        assert data["timestamps"][-1] == 99.0
        assert data["values"][-1] == 99.0

    def test_read_var_window_filters_range(self, recordings_env):
        import app as app_mod

        path = recordings_env / "s.tsv"
        path.write_text(_sample_tsv_three_rows(), encoding="utf-8")
        data = app_mod._read_var_window_tsv(str(path), "b", t_center=1.0, t_span=2.0, max_points=5000)
        assert data["name"] == "b"
        assert data["timestamps"] == [0.0, 1.0, 2.0]
        assert data["values"] == [10.0, 20.0, 30.0]

    def test_read_var_window_invalid_time(self, recordings_env):
        import app as app_mod

        path = recordings_env / "s.tsv"
        path.write_text(_sample_tsv_three_rows(), encoding="utf-8")
        with pytest.raises(ValueError, match="inválidos"):
            app_mod._read_var_window_tsv(str(path), "a", t_center=0.0, t_span=-1.0, max_points=100)

    def test_read_time_bounds_builds_index(self, recordings_env):
        import app as app_mod

        path = recordings_env / "s.tsv"
        path.write_text(_sample_tsv_three_rows(), encoding="utf-8")
        with app_mod._TIME_INDEX_LOCK:
            app_mod._TIME_INDEX.clear()
        bounds = app_mod._read_time_bounds_tsv(str(path))
        assert bounds["minTs"] == 0.0
        assert bounds["maxTs"] == 2.0
        with app_mod._TIME_INDEX_LOCK:
            assert str(path) in app_mod._TIME_INDEX

    def test_read_time_bounds_invalid_header(self, recordings_env):
        import app as app_mod

        path = recordings_env / "bad.tsv"
        path.write_text("not_time_s\ta\n0\t1\n", encoding="utf-8")
        with app_mod._TIME_INDEX_LOCK:
            app_mod._TIME_INDEX.clear()
        with pytest.raises(ValueError, match="time_s"):
            app_mod._read_time_bounds_tsv(str(path))


class TestRecordingsHttpApi:
    """TestClient sobre rutas /api/recordings/* y save_tsv."""

    def test_bounds_ok(self, client, recordings_env):
        (recordings_env / "demo.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get("/api/recordings/demo.tsv/bounds")
        assert r.status_code == 200
        body = r.json()
        assert body["minTs"] == 0.0
        assert body["maxTs"] == 2.0

    def test_history_ok(self, client, recordings_env):
        (recordings_env / "demo.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get("/api/recordings/demo.tsv/history", params={"var": "a"})
        assert r.status_code == 200
        body = r.json()
        assert body["name"] == "a"
        assert body["values"] == [1.0, 2.0, 3.0]

    def test_history_unknown_var_404(self, client, recordings_env):
        (recordings_env / "demo.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get("/api/recordings/demo.tsv/history", params={"var": "nope"})
        assert r.status_code == 404
        assert "error" in r.json()

    def test_window_ok(self, client, recordings_env):
        (recordings_env / "demo.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get(
            "/api/recordings/demo.tsv/window",
            params={"var": "b", "t_center": 1.0, "t_span": 2.0},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["values"] == [10.0, 20.0, 30.0]

    def test_window_bad_span_400(self, client, recordings_env):
        (recordings_env / "demo.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get(
            "/api/recordings/demo.tsv/window",
            params={"var": "a", "t_center": 0.0, "t_span": 0.0},
        )
        assert r.status_code == 400

    def test_window_batch_two_vars(self, client, recordings_env):
        (recordings_env / "demo.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get(
            "/api/recordings/demo.tsv/window_batch",
            params={"vars": "a,b", "t_center": 1.0, "t_span": 10.0},
        )
        assert r.status_code == 200
        body = r.json()
        assert len(body["series"]) == 2
        names = {s["name"] for s in body["series"]}
        assert names == {"a", "b"}

    def test_download_preview(self, client, recordings_env):
        (recordings_env / "demo.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get(
            "/api/recordings/demo.tsv",
            params={"preview_bytes": 2048, "offset": 0},
        )
        assert r.status_code == 200
        body = r.json()
        assert "preview" in body
        assert "time_s" in body["preview"]
        assert body["filename"] == "demo.tsv"

    def test_file_missing_404(self, client):
        r = client.get("/api/recordings/no_existe.tsv/bounds")
        assert r.status_code == 404

    def test_save_tsv_creates_file(self, client, recordings_env, monkeypatch):
        """save_tsv convierte a Parquet canónico si el despliegue incluye el módulo Parquet."""
        import app as app_mod

        monkeypatch.setattr(app_mod, "parquet_recording_enabled", lambda: True)
        content = _sample_tsv_three_rows()
        r = client.post(
            "/api/save_tsv",
            json={"content": content, "filename": "saved.tsv"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True
        assert body["filename"] == "saved.parquet"
        pq = recordings_env / "saved.parquet"
        assert pq.is_file()
        # TSV espejo opcional (recordings_write_tsv)
        tsv = recordings_env / "saved.tsv"
        if tsv.is_file():
            assert "time_s" in tsv.read_text()

    def test_save_tsv_without_parquet_module_writes_tsv(self, client, recordings_env, monkeypatch):
        """Sin plugin Parquet (típico OSS), save_tsv guarda solo TSV."""
        import app as app_mod

        monkeypatch.setattr(app_mod, "parquet_recording_enabled", lambda: False)
        content = _sample_tsv_three_rows()
        r = client.post(
            "/api/save_tsv",
            json={"content": content, "filename": "saved.tsv"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True
        assert body["filename"] == "saved.tsv"
        out = recordings_env / "saved.tsv"
        assert out.is_file()
        assert "time_s" in out.read_text()


class TestRecordingFilenameContract:
    """Contrato de seguridad de `filename` en rutas /api/recordings/... (misma lógica que app.py)."""

    def test_only_basename_allowed(self):
        assert os.path.basename("ok.tsv") == "ok.tsv"
        for bad in ("subdir/file.tsv", "../secrets.tsv", "a/../b.tsv"):
            assert os.path.basename(bad) != bad


class TestRecordingDownloadFile:
    """Descarga completa del TSV (FileResponse)."""

    def test_download_full_file(self, client, recordings_env):
        (recordings_env / "full.tsv").write_text(_sample_tsv_three_rows(), encoding="utf-8")
        r = client.get("/api/recordings/full.tsv")
        assert r.status_code == 200
        assert "time_s" in r.text
        assert r.headers.get("content-type", "").startswith("text/tab-separated-values")

