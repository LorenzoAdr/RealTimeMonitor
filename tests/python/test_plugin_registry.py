"""Tests unitarios para web_monitor/plugin_registry.py — sistema de plugins."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "web_monitor"))

import plugin_registry


class TestRegisterHook:
    def setup_method(self):
        plugin_registry._reset()

    def test_register_and_fire(self):
        results = []
        plugin_registry.register_hook("test_hook", lambda x: results.append(x))
        plugin_registry.fire_hook("test_hook", 42)
        assert results == [42]

    def test_multiple_callbacks(self):
        calls = []
        plugin_registry.register_hook("h", lambda: calls.append("a"))
        plugin_registry.register_hook("h", lambda: calls.append("b"))
        plugin_registry.fire_hook("h")
        assert calls == ["a", "b"]

    def test_fire_nonexistent_hook_no_error(self):
        result = plugin_registry.fire_hook("nonexistent", 1, 2, 3)
        assert result == []

    def test_fire_returns_results(self):
        plugin_registry.register_hook("double", lambda x: x * 2)
        plugin_registry.register_hook("double", lambda x: x * 3)
        results = plugin_registry.fire_hook("double", 5)
        assert results == [10, 15]

    def test_callback_exception_does_not_break_others(self):
        calls = []
        plugin_registry.register_hook("err", lambda: 1 / 0)
        plugin_registry.register_hook("err", lambda: calls.append("ok"))
        plugin_registry.fire_hook("err")
        assert calls == ["ok"]


class TestFireHookChain:
    def setup_method(self):
        plugin_registry._reset()

    def test_chain_transforms_value(self):
        plugin_registry.register_hook("transform", lambda v: v + 10)
        plugin_registry.register_hook("transform", lambda v: v * 2)
        result = plugin_registry.fire_hook_chain("transform", 5)
        assert result == 30  # (5 + 10) * 2

    def test_chain_none_preserves_value(self):
        plugin_registry.register_hook("maybe", lambda v: None)
        result = plugin_registry.fire_hook_chain("maybe", 42)
        assert result == 42

    def test_chain_no_hooks_returns_original(self):
        result = plugin_registry.fire_hook_chain("empty", {"key": "value"})
        assert result == {"key": "value"}

    def test_chain_exception_preserves_value(self):
        plugin_registry.register_hook("err_chain", lambda v: 1 / 0)
        plugin_registry.register_hook("err_chain", lambda v: v + 1)
        result = plugin_registry.fire_hook_chain("err_chain", 10)
        assert result == 11


class TestRegisterPlugin:
    def setup_method(self):
        plugin_registry._reset()

    def test_register_and_query(self):
        plugin_registry.register_plugin("arinc", {"version": "1.0"})
        assert plugin_registry.has_plugin("arinc")
        assert not plugin_registry.has_plugin("parquet")

    def test_get_registered_plugin_ids(self):
        plugin_registry.register_plugin("parquet")
        plugin_registry.register_plugin("arinc")
        features = plugin_registry.get_registered_plugin_ids()
        assert features == ["arinc", "parquet"]

    def test_get_plugin_meta(self):
        plugin_registry.register_plugin("x", {"author": "test"})
        meta = plugin_registry.get_plugin_meta("x")
        assert meta == {"author": "test"}

    def test_get_plugin_meta_missing(self):
        assert plugin_registry.get_plugin_meta("missing") is None

    def test_empty_features(self):
        assert plugin_registry.get_registered_plugin_ids() == []


class TestGetHooks:
    def setup_method(self):
        plugin_registry._reset()

    def test_get_hooks_summary(self):
        plugin_registry.register_hook("a", lambda: None)
        plugin_registry.register_hook("a", lambda: None)
        plugin_registry.register_hook("b", lambda: None)
        hooks = plugin_registry.get_hooks()
        assert hooks == {"a": 2, "b": 1}

    def test_empty_hooks(self):
        assert plugin_registry.get_hooks() == {}


class TestDiscoverPlugins:
    def setup_method(self):
        plugin_registry._reset()

    def test_discover_without_plugins_wheel_installed(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "varmonitor_plugins", None)
        monkeypatch.setitem(sys.modules, "varmonitor_plugins_stub", None)
        plugin_registry.discover_plugins()
        assert plugin_registry.get_registered_plugin_ids() == []

    def test_discover_with_mock_plugins_wheel(self, monkeypatch):
        import types
        mock_pkg = types.ModuleType("varmonitor_plugins")
        registered = []

        def mock_register(reg_hook, reg_plugin):
            reg_plugin("mock_feature", {"version": "test"})
            reg_hook("test_hook", lambda: "plugins_result")
            registered.append(True)

        mock_pkg.register = mock_register
        monkeypatch.setitem(sys.modules, "varmonitor_plugins", mock_pkg)
        plugin_registry.discover_plugins()
        assert plugin_registry.has_plugin("mock_feature")
        assert registered == [True]

    def test_discover_plugins_without_register_function(self, monkeypatch):
        import types
        mock_pkg = types.ModuleType("varmonitor_plugins")
        monkeypatch.setitem(sys.modules, "varmonitor_plugins", mock_pkg)
        monkeypatch.setitem(sys.modules, "varmonitor_plugins_stub", None)
        plugin_registry.discover_plugins()
        assert plugin_registry.get_registered_plugin_ids() == []

    def test_discover_plugins_register_raises(self, monkeypatch):
        import types
        mock_pkg = types.ModuleType("varmonitor_plugins")
        mock_pkg.register = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
        monkeypatch.setitem(sys.modules, "varmonitor_plugins", mock_pkg)
        monkeypatch.setitem(sys.modules, "varmonitor_plugins_stub", None)
        plugin_registry.discover_plugins()
        assert plugin_registry.get_registered_plugin_ids() == []


class TestReset:
    def test_reset_clears_all(self):
        plugin_registry.register_hook("h", lambda: None)
        plugin_registry.register_plugin("p")
        plugin_registry._reset()
        assert plugin_registry.get_registered_plugin_ids() == []
        assert plugin_registry.get_hooks() == {}
        assert plugin_registry.fire_hook("h") == []
