"""Tests unitarios para scripts/varmon/varmon_launch_util.py — descubrimiento de binarios y taskset."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

import varmon_launch_util
from varmon_launch_util import (
    find_demo_server,
    resolve_taskset_affinities,
    wrap_with_taskset,
    python_exe_for_web,
    chdir_for_packaged_web,
)


class TestFindDemoServer:
    def test_env_var_overrides(self, tmp_path, monkeypatch):
        exe = tmp_path / "my_demo"
        exe.write_text("#!/bin/sh\necho demo\n")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setenv("VARMON_DEMO_SERVER_BIN", str(exe))
        result = find_demo_server(tmp_path)
        assert result == exe.resolve()

    def test_env_var_nonexistent_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.setenv("VARMON_DEMO_SERVER_BIN", "/nonexistent/binary")
        result = find_demo_server(tmp_path)
        assert result is None

    def test_build_dir_found(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_DEMO_SERVER_BIN", raising=False)
        build_dir = tmp_path / "build" / "demo_app"
        build_dir.mkdir(parents=True)
        exe = build_dir / "demo_server"
        exe.write_text("#!/bin/sh\n")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        result = find_demo_server(tmp_path)
        assert result is not None
        assert result.name == "demo_server"

    def test_fallback_build_dir(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_DEMO_SERVER_BIN", raising=False)
        build_dir = tmp_path / "build"
        build_dir.mkdir()
        exe = build_dir / "demo_server"
        exe.write_text("#!/bin/sh\n")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
        result = find_demo_server(tmp_path)
        assert result is not None

    def test_not_found(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_DEMO_SERVER_BIN", raising=False)
        result = find_demo_server(tmp_path)
        assert result is None

    def test_not_executable_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_DEMO_SERVER_BIN", raising=False)
        build_dir = tmp_path / "build" / "demo_app"
        build_dir.mkdir(parents=True)
        exe = build_dir / "demo_server"
        exe.write_text("data")
        exe.chmod(stat.S_IRUSR | stat.S_IWUSR)
        result = find_demo_server(tmp_path)
        assert result is None


class TestResolveTasksetAffinities:
    def test_env_vars_override(self, monkeypatch):
        monkeypatch.setenv("VARMON_TASKSET_CPP", "0-1")
        monkeypatch.setenv("VARMON_TASKSET_PY", "2-3")
        cpp, py = resolve_taskset_affinities()
        assert cpp == "0-1"
        assert py == "2-3"

    def test_single_env_var(self, monkeypatch):
        monkeypatch.setenv("VARMON_TASKSET_CPP", "0")
        monkeypatch.delenv("VARMON_TASKSET_PY", raising=False)
        cpp, py = resolve_taskset_affinities()
        assert cpp == "0"
        assert py is None

    def test_heuristic_8_cpus(self, monkeypatch):
        monkeypatch.delenv("VARMON_TASKSET_CPP", raising=False)
        monkeypatch.delenv("VARMON_TASKSET_PY", raising=False)
        with patch("os.cpu_count", return_value=8):
            cpp, py = resolve_taskset_affinities()
        assert cpp == "0-1"
        assert py == "4-5"

    def test_heuristic_4_cpus(self, monkeypatch):
        monkeypatch.delenv("VARMON_TASKSET_CPP", raising=False)
        monkeypatch.delenv("VARMON_TASKSET_PY", raising=False)
        with patch("os.cpu_count", return_value=4):
            cpp, py = resolve_taskset_affinities()
        assert cpp == "0"
        assert py == "2"

    def test_heuristic_2_cpus(self, monkeypatch):
        monkeypatch.delenv("VARMON_TASKSET_CPP", raising=False)
        monkeypatch.delenv("VARMON_TASKSET_PY", raising=False)
        with patch("os.cpu_count", return_value=2):
            cpp, py = resolve_taskset_affinities()
        assert cpp == "0"
        assert py == "1"

    def test_heuristic_1_cpu(self, monkeypatch):
        monkeypatch.delenv("VARMON_TASKSET_CPP", raising=False)
        monkeypatch.delenv("VARMON_TASKSET_PY", raising=False)
        with patch("os.cpu_count", return_value=1):
            cpp, py = resolve_taskset_affinities()
        assert cpp is None
        assert py is None


class TestWrapWithTaskset:
    def test_with_affinity_and_taskset(self):
        with patch("shutil.which", return_value="/usr/bin/taskset"):
            result = wrap_with_taskset("0-1", ["./demo_server"])
        assert result == ["taskset", "-c", "0-1", "./demo_server"]

    def test_no_affinity(self):
        result = wrap_with_taskset(None, ["./demo_server"])
        assert result == ["./demo_server"]

    def test_empty_affinity(self):
        result = wrap_with_taskset("", ["./demo_server"])
        assert result == ["./demo_server"]

    def test_no_taskset_binary(self):
        with patch("shutil.which", return_value=None):
            result = wrap_with_taskset("0-1", ["./demo_server"])
        assert result == ["./demo_server"]

    def test_preserves_extra_args(self):
        with patch("shutil.which", return_value="/usr/bin/taskset"):
            result = wrap_with_taskset("3", ["python", "app.py", "--debug"])
        assert result == ["taskset", "-c", "3", "python", "app.py", "--debug"]


class TestPythonExeForWeb:
    def test_venv_python_exists(self, tmp_path):
        venv_bin = tmp_path / ".venv" / "bin"
        venv_bin.mkdir(parents=True)
        py = venv_bin / "python"
        py.write_text("#!/bin/sh\n")
        result = python_exe_for_web(tmp_path)
        assert result == py

    def test_no_venv_falls_back_to_sys(self, tmp_path):
        result = python_exe_for_web(tmp_path)
        assert result == Path(sys.executable)


class TestChdirForPackagedWeb:
    def test_install_dir_env(self, tmp_path, monkeypatch):
        install = tmp_path / "install"
        install.mkdir()
        monkeypatch.setenv("VARMON_INSTALL_DIR", str(install))
        packaged = tmp_path / "bin" / "varmonitor-web"
        packaged.parent.mkdir(parents=True)
        packaged.write_text("")
        chdir_for_packaged_web(packaged)
        assert Path.cwd() == install

    def test_falls_back_to_packaged_parent(self, tmp_path, monkeypatch):
        monkeypatch.delenv("VARMON_INSTALL_DIR", raising=False)
        packaged = tmp_path / "bin" / "varmonitor-web"
        packaged.parent.mkdir(parents=True)
        packaged.write_text("")
        chdir_for_packaged_web(packaged)
        assert Path.cwd() == packaged.parent

    def test_custom_env_name(self, tmp_path, monkeypatch):
        install = tmp_path / "custom_install"
        install.mkdir()
        monkeypatch.setenv("MY_INSTALL", str(install))
        packaged = tmp_path / "bin" / "varmonitor-web"
        packaged.parent.mkdir(parents=True)
        packaged.write_text("")
        chdir_for_packaged_web(packaged, install_dir_env="MY_INSTALL")
        assert Path.cwd() == install
