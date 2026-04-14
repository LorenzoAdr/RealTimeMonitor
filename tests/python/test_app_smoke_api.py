"""Smoke tests HTTP: listado de grabaciones, browse del proyecto, plantillas y sesiones."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "web_monitor"))

from fastapi.testclient import TestClient


@pytest.fixture
def isolated_state(monkeypatch, tmp_path: Path):
    """Directorios de estado y grabaciones bajo tmp_path."""
    import app as app_mod

    # Sin contraseñas de entorno: rutas sensibles (/api/browse, etc.) deben responder en tests.
    monkeypatch.setitem(app_mod._config, "sensitive_modes_password", "")
    monkeypatch.setitem(app_mod._config, "auth_password", "")

    rec = tmp_path / "recordings"
    state = tmp_path / "server_state"
    templates = state / "templates"
    sessions = state / "sessions"
    rec.mkdir(parents=True, exist_ok=True)
    templates.mkdir(parents=True, exist_ok=True)
    sessions.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(app_mod, "RECORDINGS_DIR", str(rec))
    monkeypatch.setattr(app_mod, "TEMPLATES_DIR", str(templates))
    monkeypatch.setattr(app_mod, "SESSIONS_DIR", str(sessions))
    monkeypatch.setattr(app_mod, "BROWSER_ROOT", tmp_path)

    return {
        "recordings": rec,
        "templates": templates,
        "sessions": sessions,
        "root": tmp_path,
    }


@pytest.fixture
def smoke_client(isolated_state):
    import app as app_mod

    return TestClient(app_mod.app)


class TestApiRecordingsList:
    def test_list_includes_parquet_with_rows(self, smoke_client, isolated_state):
        tsv = isolated_state["recordings"] / "demo.tsv"
        tsv.write_text(
            "time_s\tx\n0.0\t1\n1.0\t2\n",
            encoding="utf-8",
        )
        from varmonitor_plugins.recordings_parquet import convert_tsv_file_to_parquet

        pq = isolated_state["recordings"] / "demo.parquet"
        convert_tsv_file_to_parquet(str(tsv), str(pq))
        try:
            tsv.unlink()
        except OSError:
            pass

        r = smoke_client.get("/api/recordings")
        assert r.status_code == 200
        data = r.json()
        recs = data.get("recordings") or []
        names = {row.get("filename") for row in recs}
        assert "demo.parquet" in names
        row = next(x for x in recs if x.get("filename") == "demo.parquet")
        assert row.get("format") == "parquet"
        assert "rows" in row


class TestApiBrowse:
    def test_browse_root_ok(self, smoke_client, isolated_state):
        sub = isolated_state["root"] / "pkg"
        sub.mkdir()
        (sub / "readme.txt").write_text("hi", encoding="utf-8")

        r = smoke_client.get("/api/browse", params={"path": ""})
        assert r.status_code == 200
        body = r.json()
        names = {e["name"] for e in body.get("entries", [])}
        assert "pkg" in names

    def test_browse_invalid_returns_400(self, smoke_client):
        r = smoke_client.get("/api/browse", params={"path": "../../../etc"})
        assert r.status_code == 400


class TestApiTemplatesSessions:
    def test_templates_crud(self, smoke_client, isolated_state):
        r = smoke_client.get("/api/templates")
        assert r.status_code == 200
        assert r.json().get("templates") == []

        r = smoke_client.put(
            "/api/templates/mine",
            json={"data": {"vars": ["a"]}},
        )
        assert r.status_code == 200

        r = smoke_client.get("/api/templates")
        assert r.status_code == 200
        assert "mine" in r.json().get("templates", [])

        r = smoke_client.get("/api/templates/mine")
        assert r.status_code == 200
        assert r.json().get("data") == {"vars": ["a"]}

        r = smoke_client.delete("/api/templates/mine")
        assert r.status_code == 200
        r = smoke_client.get("/api/templates/mine")
        assert r.status_code == 404

    def test_sessions_crud(self, smoke_client, isolated_state):
        r = smoke_client.get("/api/sessions")
        assert r.status_code == 200
        assert r.json().get("sessions") == []

        r = smoke_client.put(
            "/api/sessions/s1",
            json={"data": {"ui": {"k": 1}}},
        )
        assert r.status_code == 200

        r = smoke_client.get("/api/sessions")
        assert r.status_code == 200
        assert "s1" in r.json().get("sessions", [])

        r = smoke_client.get("/api/sessions/s1")
        assert r.status_code == 200
        assert r.json().get("data", {}).get("ui", {}).get("k") == 1

        r = smoke_client.delete("/api/sessions/s1")
        assert r.status_code == 200
        r = smoke_client.get("/api/sessions/s1")
        assert r.status_code == 404
