"""Tests unitarios para la evaluación de alarmas en app.py — _evaluate_alarms."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "web_monitor"))

from app import _evaluate_alarms


def _snap(entries: dict[str, float | int | bool | str]) -> list[dict]:
    """Helper: crea snapshot de vars como lista de dicts."""
    return [{"name": n, "type": "double", "value": v} for n, v in entries.items()]


class TestEvaluateAlarmsHi:
    def test_hi_trigger(self):
        snap = _snap({"temp": 101.0})
        config = {"temp": {"hi": 100.0}}
        state, pending, triggered, cleared = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is True
        assert len(triggered) == 1
        assert triggered[0]["name"] == "temp"
        assert "Hi:100" in triggered[0]["reason"]

    def test_hi_no_trigger_below(self):
        snap = _snap({"temp": 99.0})
        config = {"temp": {"hi": 100.0}}
        state, pending, triggered, cleared = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is False
        assert triggered == []

    def test_hi_exact_value_no_trigger(self):
        snap = _snap({"temp": 100.0})
        config = {"temp": {"hi": 100.0}}
        state, pending, triggered, cleared = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is False


class TestEvaluateAlarmsLo:
    def test_lo_trigger(self):
        snap = _snap({"temp": 4.0})
        config = {"temp": {"lo": 5.0}}
        state, pending, triggered, cleared = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is True
        assert len(triggered) == 1
        assert "Lo:5" in triggered[0]["reason"]

    def test_lo_no_trigger_above(self):
        snap = _snap({"temp": 6.0})
        config = {"temp": {"lo": 5.0}}
        state, pending, triggered, cleared = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is False

    def test_lo_exact_value_no_trigger(self):
        snap = _snap({"temp": 5.0})
        config = {"temp": {"lo": 5.0}}
        state, pending, triggered, cleared = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is False


class TestEvaluateAlarmsHysteresis:
    def test_hysteresis_keeps_alarm_active(self):
        config = {"temp": {"hi": 100.0, "hys": 5.0}}
        snap_high = _snap({"temp": 101.0})
        state, pending, triggered, _ = _evaluate_alarms(snap_high, config, {}, {}, 0)
        assert state["temp"] is True

        snap_within_hys = _snap({"temp": 97.0})
        state2, _, _, cleared = _evaluate_alarms(snap_within_hys, config, state, pending, 100)
        assert state2["temp"] is True
        assert cleared == []

    def test_hysteresis_clears_below_threshold(self):
        config = {"temp": {"hi": 100.0, "hys": 5.0}}
        snap_high = _snap({"temp": 101.0})
        state, pending, _, _ = _evaluate_alarms(snap_high, config, {}, {}, 0)

        snap_clear = _snap({"temp": 94.0})
        state2, _, _, cleared = _evaluate_alarms(snap_clear, config, state, pending, 100)
        assert state2["temp"] is False
        assert "temp" in cleared

    def test_hysteresis_lo(self):
        config = {"temp": {"lo": 10.0, "hys": 3.0}}
        snap_low = _snap({"temp": 9.0})
        state, pending, triggered, _ = _evaluate_alarms(snap_low, config, {}, {}, 0)
        assert state["temp"] is True

        snap_within_hys = _snap({"temp": 12.0})
        state2, _, _, cleared = _evaluate_alarms(snap_within_hys, config, state, pending, 100)
        assert state2["temp"] is True

        snap_clear = _snap({"temp": 14.0})
        state3, _, _, cleared2 = _evaluate_alarms(snap_clear, config, state2, pending, 200)
        assert state3["temp"] is False
        assert "temp" in cleared2


class TestEvaluateAlarmsDelay:
    def test_delay_not_triggered_before_deadline(self):
        config = {"temp": {"hi": 100.0, "delayMs": 1000}}
        snap = _snap({"temp": 101.0})
        state, pending, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is False
        assert triggered == []
        assert "temp" in pending

    def test_delay_triggers_after_deadline(self):
        config = {"temp": {"hi": 100.0, "delayMs": 1000}}
        snap = _snap({"temp": 101.0})
        state, pending, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)

        state2, pending2, triggered2, _ = _evaluate_alarms(snap, config, state, pending, 1000)
        assert state2["temp"] is True
        assert len(triggered2) == 1

    def test_delay_resets_if_value_returns_to_normal(self):
        config = {"temp": {"hi": 100.0, "delayMs": 1000}}
        snap_hi = _snap({"temp": 101.0})
        state, pending, _, _ = _evaluate_alarms(snap_hi, config, {}, {}, 0)

        snap_ok = _snap({"temp": 99.0})
        state2, pending2, triggered, _ = _evaluate_alarms(snap_ok, config, state, pending, 500)
        assert state2["temp"] is False
        assert "temp" not in pending2

    def test_delay_zero_triggers_immediately(self):
        config = {"temp": {"hi": 100.0, "delayMs": 0}}
        snap = _snap({"temp": 101.0})
        state, _, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["temp"] is True
        assert len(triggered) == 1


class TestEvaluateAlarmsBothHiLo:
    def test_hi_and_lo_configured(self):
        config = {"temp": {"hi": 100.0, "lo": 10.0}}

        snap_hi = _snap({"temp": 101.0})
        state, pending, triggered, _ = _evaluate_alarms(snap_hi, config, {}, {}, 0)
        assert state["temp"] is True
        assert "Hi" in triggered[0]["reason"]

    def test_lo_after_hi_cleared(self):
        config = {"temp": {"hi": 100.0, "lo": 10.0}}
        snap_hi = _snap({"temp": 101.0})
        state, pending, _, _ = _evaluate_alarms(snap_hi, config, {}, {}, 0)

        snap_ok = _snap({"temp": 50.0})
        state2, pending2, _, cleared = _evaluate_alarms(snap_ok, config, state, pending, 100)
        assert state2["temp"] is False

        snap_lo = _snap({"temp": 9.0})
        state3, _, triggered, _ = _evaluate_alarms(snap_lo, config, state2, pending2, 200)
        assert state3["temp"] is True
        assert "Lo" in triggered[0]["reason"]


class TestEvaluateAlarmsEdgeCases:
    def test_non_numeric_value_skipped(self):
        snap = [{"name": "label", "type": "string", "value": "hello"}]
        config = {"label": {"hi": 10.0}}
        state, _, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)
        assert triggered == []

    def test_no_config_no_alarms(self):
        snap = _snap({"temp": 50.0})
        state, _, triggered, cleared = _evaluate_alarms(snap, {}, {}, {}, 0)
        assert triggered == []
        assert cleared == []

    def test_missing_var_in_snapshot(self):
        snap = _snap({"other": 50.0})
        config = {"temp": {"hi": 100.0}}
        state, _, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)
        assert triggered == []

    def test_cleared_event_emitted(self):
        config = {"temp": {"hi": 100.0}}
        snap_hi = _snap({"temp": 101.0})
        state, pending, _, _ = _evaluate_alarms(snap_hi, config, {}, {}, 0)
        assert state["temp"] is True

        snap_ok = _snap({"temp": 99.0})
        state2, _, _, cleared = _evaluate_alarms(snap_ok, config, state, pending, 100)
        assert "temp" in cleared

    def test_multiple_vars_independent(self):
        config = {"a": {"hi": 10.0}, "b": {"lo": 5.0}}
        snap = _snap({"a": 11.0, "b": 4.0})
        state, _, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["a"] is True
        assert state["b"] is True
        assert len(triggered) == 2

    def test_non_dict_entries_in_snapshot_ignored(self):
        snap = [None, "invalid", {"name": "temp", "type": "double", "value": 101.0}]
        config = {"temp": {"hi": 100.0}}
        state, _, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)
        assert len(triggered) == 1

    def test_bool_value_treated_as_numeric(self):
        snap = [{"name": "flag", "type": "bool", "value": True}]
        config = {"flag": {"hi": 0.5}}
        state, _, triggered, _ = _evaluate_alarms(snap, config, {}, {}, 0)
        assert state["flag"] is True
