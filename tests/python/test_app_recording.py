"""Tests unitarios para funciones de recording, config override, NDJSON y ports de app.py."""

from __future__ import annotations

import json
import os
import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "web_monitor"))

from app import (
    _build_record_col_spec,
    _estimate_record_header_bytes,
    _estimate_record_row_bytes,
    _find_available_port,
    _read_ndjson_lines_from_offset,
    _record_row_layout,
    _save_runtime_config_overrides,
    _write_sidecar_alarms_tsv,
)


# ── _record_row_layout ──


class TestRecordRowLayout:
    def test_scalar_columns(self):
        spec = [("a", 1), ("b", 1), ("c", 1)]
        layout, total = _record_row_layout(spec)
        assert total == 3
        assert layout["a"] == (0, 1)
        assert layout["b"] == (1, 1)
        assert layout["c"] == (2, 1)

    def test_array_column(self):
        spec = [("scalar", 1), ("arr", 4)]
        layout, total = _record_row_layout(spec)
        assert total == 5
        assert layout["scalar"] == (0, 1)
        assert layout["arr"] == (1, 4)

    def test_empty_spec(self):
        layout, total = _record_row_layout([])
        assert total == 0
        assert layout == {}


# ── _build_record_col_spec ──


class TestBuildRecordColSpec:
    def test_scalar_only(self):
        snap = [{"name": "a", "value": 1.0}, {"name": "b", "value": 2.0}]
        spec = _build_record_col_spec(["a", "b"], snap)
        assert spec == [("a", 1), ("b", 1)]

    def test_array_var(self):
        snap = [{"name": "arr", "value": [1.0, 2.0, 3.0]}]
        spec = _build_record_col_spec(["arr"], snap)
        assert spec == [("arr", 3)]

    def test_single_element_array_is_scalar(self):
        snap = [{"name": "x", "value": [5.0]}]
        spec = _build_record_col_spec(["x"], snap)
        assert spec == [("x", 1)]

    def test_missing_var_is_scalar(self):
        snap = [{"name": "a", "value": 1.0}]
        spec = _build_record_col_spec(["a", "missing"], snap)
        assert ("missing", 1) in spec


# ── _estimate_record_header_bytes ──


class TestEstimateRecordHeaderBytes:
    def test_basic(self):
        b = _estimate_record_header_bytes(["temp", "pressure"])
        assert b > 0
        assert b == len("time_s\ttemp\tpressure\n".encode())

    def test_array_expands(self):
        snap = [{"name": "arr", "value": [1.0, 2.0, 3.0]}]
        b = _estimate_record_header_bytes(["arr"], snap)
        assert "arr_0" in "time_s\tarr_0\tarr_1\tarr_2\n"
        assert b == len("time_s\tarr_0\tarr_1\tarr_2\n".encode())

    def test_empty(self):
        b = _estimate_record_header_bytes([])
        assert b == len("time_s\n".encode())


# ── _estimate_record_row_bytes ──


class TestEstimateRecordRowBytes:
    def test_scalar_row(self):
        snap = [{"name": "x", "value": 1.5}]
        b = _estimate_record_row_bytes(100.0, snap, ["x"])
        assert b > 0

    def test_array_row(self):
        snap = [{"name": "arr", "value": [1.0, 2.0, 3.0]}]
        b = _estimate_record_row_bytes(100.0, snap, ["arr"])
        assert b > 0


# ── _read_ndjson_lines_from_offset ──


class TestReadNdjsonLines:
    def test_valid_ndjson(self, tmp_path):
        f = tmp_path / "data.ndjson"
        lines = [
            json.dumps({"kind": "seq_gap", "skipped": 5}),
            json.dumps({"kind": "ring_loss"}),
        ]
        f.write_text("\n".join(lines) + "\n")
        result, offset = _read_ndjson_lines_from_offset(str(f), 0)
        assert len(result) == 2
        assert result[0]["kind"] == "seq_gap"
        assert offset > 0

    def test_skips_bad_lines(self, tmp_path):
        f = tmp_path / "data.ndjson"
        f.write_text('{"ok":true}\nnot json\n{"also":true}\n')
        result, _ = _read_ndjson_lines_from_offset(str(f), 0)
        assert len(result) == 2

    def test_nonexistent_file(self):
        result, off = _read_ndjson_lines_from_offset("/nonexistent", 0)
        assert result == []
        assert off == 0

    def test_reads_from_offset(self, tmp_path):
        f = tmp_path / "data.ndjson"
        f.write_text('{"a":1}\n{"b":2}\n')
        _, offset1 = _read_ndjson_lines_from_offset(str(f), 0)
        f.write_text('{"a":1}\n{"b":2}\n{"c":3}\n')
        result, _ = _read_ndjson_lines_from_offset(str(f), offset1)
        assert len(result) == 1
        assert result[0]["c"] == 3

    def test_empty_file(self, tmp_path):
        f = tmp_path / "empty.ndjson"
        f.write_text("")
        result, off = _read_ndjson_lines_from_offset(str(f), 0)
        assert result == []


# ── _save_runtime_config_overrides ──


class TestSaveRuntimeConfigOverrides:
    def test_creates_new_file(self, tmp_path, monkeypatch):
        import app
        monkeypatch.setattr(app, "CONFIG_ABS_PATH", str(tmp_path / "varmon.conf"))
        _save_runtime_config_overrides({"web_port": 9090})
        content = (tmp_path / "varmon.conf").read_text()
        assert "web_port = 9090" in content

    def test_updates_existing_key(self, tmp_path, monkeypatch):
        import app
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = 8080\n")
        monkeypatch.setattr(app, "CONFIG_ABS_PATH", str(cfg))
        _save_runtime_config_overrides({"web_port": 9090})
        content = cfg.read_text()
        assert "web_port = 9090" in content
        assert "8080" not in content

    def test_preserves_comments(self, tmp_path, monkeypatch):
        import app
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("# My comment\nweb_port = 8080\n")
        monkeypatch.setattr(app, "CONFIG_ABS_PATH", str(cfg))
        _save_runtime_config_overrides({"web_port": 9090})
        content = cfg.read_text()
        assert "# My comment" in content

    def test_disallowed_key_ignored(self, tmp_path, monkeypatch):
        import app
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("")
        monkeypatch.setattr(app, "CONFIG_ABS_PATH", str(cfg))
        _save_runtime_config_overrides({"secret_key": "value"})
        content = cfg.read_text()
        assert "secret_key" not in content

    def test_empty_updates_no_op(self, tmp_path, monkeypatch):
        import app
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = 8080\n")
        monkeypatch.setattr(app, "CONFIG_ABS_PATH", str(cfg))
        _save_runtime_config_overrides({})
        content = cfg.read_text()
        assert "web_port = 8080" in content


# ── _write_sidecar_alarms_tsv ──


class TestWriteSidecarAlarmsTsv:
    def test_basic_alarm(self, tmp_path):
        path = str(tmp_path / "alarms.tsv")
        cfg = {"temp": {"lo": 10.0, "hi": 100.0, "hys": 2.0, "delayMs": 500}}
        n = _write_sidecar_alarms_tsv(path, cfg)
        assert n == 1
        content = (tmp_path / "alarms.tsv").read_text()
        assert content.startswith("temp\tabs\t")
        assert "10.0" in content
        assert "100.0" in content

    def test_compare_to_ref_alarm(self, tmp_path):
        path = str(tmp_path / "alarms.tsv")
        cfg = {
            "sig": {
                "compareToRef": True,
                "tol": 1.5,
                "hys": 0.1,
                "delayMs": 200,
                "refName": "__vm_ref__sig",
            }
        }
        n = _write_sidecar_alarms_tsv(path, cfg)
        assert n == 1
        content = (tmp_path / "alarms.tsv").read_text()
        assert content.startswith("sig\tref\t__vm_ref__sig\t")
        assert "1.5" in content

    def test_skips_telemetry_names(self, tmp_path):
        path = str(tmp_path / "alarms.tsv")
        cfg = {
            "varmon.telemetry.python_ram_mb": {"hi": 1000},
            "real_var": {"hi": 50.0},
        }
        n = _write_sidecar_alarms_tsv(path, cfg)
        assert n == 1
        content = (tmp_path / "alarms.tsv").read_text()
        assert "real_var" in content
        assert "telemetry" not in content

    def test_empty_config(self, tmp_path):
        path = str(tmp_path / "alarms.tsv")
        n = _write_sidecar_alarms_tsv(path, {})
        assert n == 0

    def test_none_values_are_empty_cells(self, tmp_path):
        path = str(tmp_path / "alarms.tsv")
        cfg = {"x": {"hi": 100.0}}
        _write_sidecar_alarms_tsv(path, cfg)
        content = (tmp_path / "alarms.tsv").read_text()
        parts = content.strip().split("\t")
        assert parts[0] == "x"
        assert parts[1] == "abs"
        assert parts[2] == ""  # lo=None → empty


# ── _find_available_port ──


class TestFindAvailablePort:
    def test_finds_free_port(self):
        port = _find_available_port("127.0.0.1", 18000, max_offset=100)
        assert 18000 <= port <= 18100

    def test_all_busy_raises(self):
        socks = []
        base = 19000
        try:
            for i in range(3):
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", base + i))
                s.listen(1)
                socks.append(s)
            with pytest.raises(RuntimeError, match="no hay puertos libres"):
                _find_available_port("127.0.0.1", base, max_offset=2)
        finally:
            for s in socks:
                s.close()
