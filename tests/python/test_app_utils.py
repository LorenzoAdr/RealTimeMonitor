"""Tests unitarios para funciones puras/utilidades de app.py."""

from __future__ import annotations

import logging
import math
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "web_monitor"))

from app import (
    _merge_names_with_telemetry,
    _parse_cpu_affinity_spec,
    _safe_json_name,
    _json_path,
    _telemetry_float,
    _var_signature_equal,
    _var_update_signature,
    _SuppressAdvancedStatsAccessLog,
)


# ── _parse_cpu_affinity_spec ──


class TestParseCpuAffinitySpec:
    def test_single_cpu(self):
        assert _parse_cpu_affinity_spec("3") == frozenset({3})

    def test_comma_separated(self):
        assert _parse_cpu_affinity_spec("2,3") == frozenset({2, 3})

    def test_range(self):
        assert _parse_cpu_affinity_spec("1-3") == frozenset({1, 2, 3})

    def test_mixed(self):
        assert _parse_cpu_affinity_spec("0,4-5,7") == frozenset({0, 4, 5, 7})

    def test_reversed_range_swapped(self):
        assert _parse_cpu_affinity_spec("5-2") == frozenset({2, 3, 4, 5})

    def test_negative_skipped(self):
        result = _parse_cpu_affinity_spec("-1,3")
        assert 3 in result
        assert -1 not in result

    def test_empty_string_returns_none(self):
        assert _parse_cpu_affinity_spec("") is None

    def test_none_returns_none(self):
        assert _parse_cpu_affinity_spec(None) is None

    def test_whitespace_only(self):
        assert _parse_cpu_affinity_spec("   ") is None

    def test_invalid_text(self):
        assert _parse_cpu_affinity_spec("abc") is None

    def test_partial_invalid(self):
        result = _parse_cpu_affinity_spec("2,abc,4")
        assert result == frozenset({2, 4})

    def test_spaces_around(self):
        assert _parse_cpu_affinity_spec(" 1 - 3 , 5 ") == frozenset({1, 2, 3, 5})


# ── _safe_json_name ──


class TestSafeJsonName:
    def test_simple_name(self):
        assert _safe_json_name("my_template") == "my_template"

    def test_strips_json_extension(self):
        assert _safe_json_name("config.json") == "config"

    def test_empty_string(self):
        assert _safe_json_name("") is None

    def test_none(self):
        assert _safe_json_name(None) is None

    def test_only_json_extension(self):
        assert _safe_json_name(".json") is None

    def test_path_traversal_basename(self):
        assert _safe_json_name("../../secret") == "secret"

    def test_whitespace_stripped(self):
        assert _safe_json_name("  my_name  ") == "my_name"

    def test_nested_path_uses_basename(self):
        assert _safe_json_name("foo/bar/baz") == "baz"


# ── _json_path ──


class TestJsonPath:
    def test_valid_name(self, tmp_path):
        base = str(tmp_path)
        result = _json_path(base, "config")
        assert result is not None
        assert result.endswith("config.json")
        assert result.startswith(base)

    def test_traversal_stripped_to_basename(self, tmp_path):
        base = str(tmp_path)
        result = _json_path(base, "../../etc/passwd")
        assert result is not None
        assert result.endswith("passwd.json")
        assert result.startswith(base)

    def test_empty_name(self, tmp_path):
        result = _json_path(str(tmp_path), "")
        assert result is None

    def test_none_name(self, tmp_path):
        result = _json_path(str(tmp_path), None)
        assert result is None

    def test_json_in_name_stripped(self, tmp_path):
        base = str(tmp_path)
        result = _json_path(base, "test.json")
        assert result.endswith("test.json")


# ── _telemetry_float ──


class TestTelemetryFloat:
    def test_none_returns_zero(self):
        assert _telemetry_float(None) == 0.0

    def test_finite_int(self):
        assert _telemetry_float(42) == 42.0

    def test_finite_float(self):
        assert _telemetry_float(3.14) == 3.14

    def test_inf_returns_zero(self):
        assert _telemetry_float(float("inf")) == 0.0

    def test_neg_inf_returns_zero(self):
        assert _telemetry_float(float("-inf")) == 0.0

    def test_nan_returns_zero(self):
        assert _telemetry_float(float("nan")) == 0.0

    def test_string_returns_zero(self):
        assert _telemetry_float("hello") == 0.0

    def test_zero(self):
        assert _telemetry_float(0) == 0.0

    def test_negative_finite(self):
        assert _telemetry_float(-5.5) == -5.5


# ── _merge_names_with_telemetry ──


class TestMergeNamesWithTelemetry:
    def test_dedup_preserves_order(self):
        result = _merge_names_with_telemetry(["a", "b", "a", "c"])
        assert result[:3] == ["a", "b", "c"]

    def test_appends_telemetry_names(self):
        result = _merge_names_with_telemetry(["x"])
        assert "varmon.telemetry.python_ram_mb" in result
        assert result[0] == "x"

    def test_telemetry_not_duplicated(self):
        result = _merge_names_with_telemetry(["varmon.telemetry.python_ram_mb", "x"])
        count = result.count("varmon.telemetry.python_ram_mb")
        assert count == 1

    def test_empty_input(self):
        result = _merge_names_with_telemetry([])
        assert len(result) >= 7  # al menos las telemetry names

    def test_empty_strings_filtered(self):
        result = _merge_names_with_telemetry(["", "a", ""])
        assert "" not in result


# ── _var_update_signature ──


class TestVarUpdateSignature:
    def test_double_float(self):
        sig = _var_update_signature({"type": "double", "value": 3.14})
        assert sig == ("double", 3.14)

    def test_double_int_coerced(self):
        sig = _var_update_signature({"type": "double", "value": 42})
        assert sig == ("double", 42.0)
        assert isinstance(sig[1], float)

    def test_double_bool_coerced(self):
        sig = _var_update_signature({"type": "double", "value": True})
        assert sig == ("double", 1.0)

    def test_double_bool_false_coerced(self):
        sig = _var_update_signature({"type": "double", "value": False})
        assert sig == ("double", 0.0)

    def test_int32_type(self):
        sig = _var_update_signature({"type": "int32", "value": 5})
        assert sig == ("int32", 5)

    def test_bool_type(self):
        sig = _var_update_signature({"type": "bool", "value": True})
        assert sig == ("bool", True)

    def test_no_type_defaults_double(self):
        sig = _var_update_signature({"value": 1.5})
        assert sig[0] == "double"

    def test_string_value_for_double_coerced(self):
        sig = _var_update_signature({"type": "double", "value": "3.14"})
        assert sig == ("double", 3.14)

    def test_non_numeric_string_for_double(self):
        sig = _var_update_signature({"type": "double", "value": "hello"})
        assert sig == ("double", "hello")


# ── _var_signature_equal ──


class TestVarSignatureEqual:
    def test_same_values(self):
        assert _var_signature_equal(("double", 1.0), ("double", 1.0)) is True

    def test_different_types(self):
        assert _var_signature_equal(("double", 1.0), ("int32", 1)) is False

    def test_different_values(self):
        assert _var_signature_equal(("double", 1.0), ("double", 2.0)) is False

    def test_close_floats(self):
        a = ("double", 1.0)
        b = ("double", 1.0 + 1e-10)
        assert _var_signature_equal(a, b) is True

    def test_not_close_floats(self):
        a = ("double", 1.0)
        b = ("double", 1.001)
        assert _var_signature_equal(a, b) is False

    def test_int_values(self):
        assert _var_signature_equal(("int32", 5), ("int32", 5)) is True

    def test_bool_values(self):
        assert _var_signature_equal(("bool", True), ("bool", True)) is True

    def test_string_values(self):
        assert _var_signature_equal(("string", "a"), ("string", "a")) is True

    def test_string_different(self):
        assert _var_signature_equal(("string", "a"), ("string", "b")) is False


# ── _SuppressAdvancedStatsAccessLog ──


class TestSuppressAdvancedStatsAccessLog:
    def _make_record(self, msg: str) -> logging.LogRecord:
        record = logging.LogRecord(
            name="uvicorn.access", level=logging.INFO,
            pathname="", lineno=0, msg=msg, args=(), exc_info=None,
        )
        return record

    def test_suppresses_advanced_stats_200(self):
        f = _SuppressAdvancedStatsAccessLog()
        record = self._make_record('GET /api/advanced_stats 200 OK')
        assert f.filter(record) is False

    def test_suppresses_perf_200(self):
        f = _SuppressAdvancedStatsAccessLog()
        record = self._make_record('GET /api/perf 200 OK')
        assert f.filter(record) is False

    def test_does_not_suppress_other_routes(self):
        f = _SuppressAdvancedStatsAccessLog()
        record = self._make_record('GET /api/vars 200 OK')
        assert f.filter(record) is True

    def test_does_not_suppress_non_200(self):
        f = _SuppressAdvancedStatsAccessLog()
        record = self._make_record('GET /api/advanced_stats 500 Error')
        assert f.filter(record) is True

    def test_does_not_suppress_unrelated(self):
        f = _SuppressAdvancedStatsAccessLog()
        record = self._make_record('Some other log message')
        assert f.filter(record) is True
