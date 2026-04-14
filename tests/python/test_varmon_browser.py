"""Tests unitarios para scripts/varmon/varmon_browser.py — detección WSL y URLs."""

from __future__ import annotations

import os
from unittest.mock import patch, MagicMock

import pytest

import varmon_browser
from varmon_browser import (
    is_wsl,
    prefer_wsl_embedded_window,
    windows_browser_url,
    wsl_primary_ipv4,
)


class TestIsWsl:
    def test_wsl_distro_name_set(self, monkeypatch):
        monkeypatch.setenv("WSL_DISTRO_NAME", "Ubuntu")
        monkeypatch.delenv("WSL_INTEROP", raising=False)
        assert is_wsl() is True

    def test_wsl_interop_set(self, monkeypatch):
        monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
        monkeypatch.setenv("WSL_INTEROP", "/run/WSL/1")
        assert is_wsl() is True

    def test_not_wsl_no_env(self, monkeypatch):
        monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
        monkeypatch.delenv("WSL_INTEROP", raising=False)
        with patch("builtins.open", side_effect=OSError("no file")):
            assert is_wsl() is False


class TestPreferWslEmbedded:
    def test_enabled(self, monkeypatch):
        monkeypatch.setenv("VARMON_WSL_EMBEDDED", "1")
        assert prefer_wsl_embedded_window() is True

    def test_true_string(self, monkeypatch):
        monkeypatch.setenv("VARMON_WSL_EMBEDDED", "true")
        assert prefer_wsl_embedded_window() is True

    def test_disabled(self, monkeypatch):
        monkeypatch.setenv("VARMON_WSL_EMBEDDED", "0")
        assert prefer_wsl_embedded_window() is False

    def test_empty(self, monkeypatch):
        monkeypatch.delenv("VARMON_WSL_EMBEDDED", raising=False)
        assert prefer_wsl_embedded_window() is False


class TestWslPrimaryIpv4:
    def test_valid_ip(self):
        mock_result = MagicMock()
        mock_result.stdout = "172.20.0.5 fe80::1\n"
        with patch("subprocess.run", return_value=mock_result):
            assert wsl_primary_ipv4() == "172.20.0.5"

    def test_skips_localhost(self):
        mock_result = MagicMock()
        mock_result.stdout = "127.0.0.1 192.168.1.5\n"
        with patch("subprocess.run", return_value=mock_result):
            assert wsl_primary_ipv4() == "192.168.1.5"

    def test_no_valid_ip(self):
        mock_result = MagicMock()
        mock_result.stdout = "fe80::1\n"
        with patch("subprocess.run", return_value=mock_result):
            assert wsl_primary_ipv4() is None

    def test_os_error(self):
        with patch("subprocess.run", side_effect=OSError("fail")):
            assert wsl_primary_ipv4() is None


class TestWindowsBrowserUrl:
    def test_template(self, monkeypatch):
        monkeypatch.setenv("VARMON_WSL_BROWSER_URL", "http://myhost:{port}/")
        with patch.object(varmon_browser, "wsl_primary_ipv4", return_value=None):
            url = windows_browser_url(8080)
        assert url == "http://myhost:8080/"

    def test_template_with_wsl_ip(self, monkeypatch):
        monkeypatch.setenv("VARMON_WSL_BROWSER_URL", "http://{wsl_ip}:{port}/app")
        with patch.object(varmon_browser, "wsl_primary_ipv4", return_value="10.0.0.1"):
            url = windows_browser_url(9090)
        assert url == "http://10.0.0.1:9090/app"

    def test_no_template_with_ip(self, monkeypatch):
        monkeypatch.delenv("VARMON_WSL_BROWSER_URL", raising=False)
        with patch.object(varmon_browser, "wsl_primary_ipv4", return_value="172.20.0.5"):
            url = windows_browser_url(8080)
        assert url == "http://172.20.0.5:8080/"

    def test_no_template_no_ip(self, monkeypatch):
        monkeypatch.delenv("VARMON_WSL_BROWSER_URL", raising=False)
        with patch.object(varmon_browser, "wsl_primary_ipv4", return_value=None):
            url = windows_browser_url(8080)
        assert url == "http://127.0.0.1:8080/"
