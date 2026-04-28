"""Tests unitarios para scripts/varmon/varmon_config.py — resolución de config y lectura de puertos."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

import varmon_config
from varmon_config import resolve_varmon_config_path, read_web_port_settings


class TestResolveVarmonConfigPath:
    def test_env_var_takes_priority(self, tmp_path, monkeypatch):
        cfg = tmp_path / "custom.conf"
        cfg.write_text("web_port = 9090\n")
        monkeypatch.setenv("VARMON_CONFIG", str(cfg))
        result = resolve_varmon_config_path(tmp_path)
        assert result == cfg.resolve()

    def test_env_var_even_if_file_missing(self, tmp_path, monkeypatch):
        monkeypatch.setenv("VARMON_CONFIG", "/nonexistent/varmon.conf")
        result = resolve_varmon_config_path(tmp_path)
        assert str(result) == str(Path("/nonexistent/varmon.conf").resolve())

    def test_cwd_varmon_conf(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_CONFIG", raising=False)
        monkeypatch.chdir(tmp_path)
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = 8080\n")
        result = resolve_varmon_config_path(tmp_path / "some_root")
        assert result == cfg.resolve()

    def test_data_dir_fallback(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_CONFIG", raising=False)
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        monkeypatch.chdir(workdir)
        data = tmp_path / "root" / "data"
        data.mkdir(parents=True)
        cfg = data / "varmon.conf"
        cfg.write_text("web_port = 8080\n")
        result = resolve_varmon_config_path(tmp_path / "root")
        assert result == cfg.resolve()

    def test_no_file_returns_default(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_CONFIG", raising=False)
        monkeypatch.chdir(tmp_path)
        result = resolve_varmon_config_path(tmp_path)
        assert "data" in str(result)
        assert result.name == "varmon.conf"


class TestReadWebPortSettings:
    def test_default_values_no_file(self, tmp_path):
        cfg = tmp_path / "missing.conf"
        base, scan = read_web_port_settings(cfg)
        assert base == 8080
        assert scan == 10

    def test_custom_web_port(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = 9090\n")
        base, scan = read_web_port_settings(cfg)
        assert base == 9090
        assert scan == 10

    def test_custom_scan_max(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port_scan_max = 5\n")
        base, scan = read_web_port_settings(cfg)
        assert base == 8080
        assert scan == 5

    def test_both_values(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = 9000\nweb_port_scan_max = 20\n")
        base, scan = read_web_port_settings(cfg)
        assert base == 9000
        assert scan == 20

    def test_comments_and_blank_lines_ignored(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("# Comment\n\nweb_port = 7777\n# Another\n")
        base, _ = read_web_port_settings(cfg)
        assert base == 7777

    def test_port_clamped_low(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = 0\n")
        base, _ = read_web_port_settings(cfg)
        assert base == 1

    def test_port_clamped_high(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = 99999\n")
        base, _ = read_web_port_settings(cfg)
        assert base == 65535

    def test_scan_max_clamped_low(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port_scan_max = -5\n")
        _, scan = read_web_port_settings(cfg)
        assert scan == 0

    def test_scan_max_clamped_high(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port_scan_max = 9999\n")
        _, scan = read_web_port_settings(cfg)
        assert scan == 1000

    def test_invalid_value_uses_default(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("web_port = abc\n")
        base, _ = read_web_port_settings(cfg)
        assert base == 8080

    def test_spaces_around_equals(self, tmp_path):
        cfg = tmp_path / "varmon.conf"
        cfg.write_text("  web_port  =  8888  \n")
        base, _ = read_web_port_settings(cfg)
        assert base == 8888
