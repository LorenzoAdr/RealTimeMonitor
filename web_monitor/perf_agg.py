"""Agregación ligera de tiempos por fase (solo cuando el lease de perf está activo). Thread-safe."""

from __future__ import annotations

import threading
import time
from typing import Any

_EMA_ALPHA = 0.15
_lock = threading.Lock()
_rows: dict[str, list[float]] = {}  # id -> [last_us, ema_us, samples]


def record_phase_us(phase_id: str, duration_us: float) -> None:
    if duration_us < 0:
        duration_us = 0.0
    with _lock:
        if phase_id not in _rows:
            _rows[phase_id] = [duration_us, duration_us, 1.0]
            return
        r = _rows[phase_id]
        r[0] = duration_us
        r[1] = r[1] * (1.0 - _EMA_ALPHA) + duration_us * _EMA_ALPHA
        r[2] += 1.0


def record_phase_sec(phase_id: str, duration_sec: float) -> None:
    record_phase_us(phase_id, duration_sec * 1e6)


def snapshot_phases() -> list[dict[str, Any]]:
    with _lock:
        out = []
        for k in sorted(_rows.keys()):
            r = _rows[k]
            out.append(
                {
                    "id": k,
                    "last_us": round(r[0], 3),
                    "ema_us": round(r[1], 3),
                    "samples": int(r[2]),
                }
            )
        return out


def clear_phases() -> None:
    with _lock:
        _rows.clear()
