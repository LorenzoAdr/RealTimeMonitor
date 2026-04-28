"""Tests del emisor multi-flujo MAVLink (escenario drone). Requiere pymavlink."""
from __future__ import annotations

import os
import sys

import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_SCRIPTS = os.path.join(_REPO, "scripts")
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)


def test_drone_streams_count_and_nominal_hz() -> None:
    from mavlink_robustness_streams import build_drone_stream_table, stream_nominal_hz_total

    st = build_drone_stream_table()
    assert len(st) >= 130
    assert stream_nominal_hz_total(st) >= 800.0


def test_scheduler_emits_many_decodable_messages() -> None:
    from pymavlink.dialects.v20 import common as p

    from mavlink_robustness_streams import build_drone_stream_table, make_drone_scheduler

    m = p.MAVLink(None, srcSystem=1, srcComponent=200)
    st = build_drone_stream_table()
    pop, _nxt = make_drone_scheduler(m, st, 1.0, 37.2, -6.0)
    bufs = pop(0.05)
    assert len(bufs) > 50

    parser = p.MAVLink(None, srcSystem=1, srcComponent=200)
    msgids: set[int] = set()
    for b in bufs[:200]:
        for msg in parser.parse_buffer(b):
            msgids.add(msg.get_msgId())
    assert len(msgids) >= 15


def test_traffic_scale_reduces_rate() -> None:
    from pymavlink.dialects.v20 import common as p

    from mavlink_robustness_streams import build_drone_stream_table, make_drone_scheduler

    m = p.MAVLink(None, srcSystem=1, srcComponent=200)
    st = build_drone_stream_table()
    pop_full, _ = make_drone_scheduler(m, st, 1.0, 37.2, -6.0)
    pop_half, _ = make_drone_scheduler(m, st, 0.5, 37.2, -6.0)
    assert len(pop_full(0.1)) >= len(pop_half(0.1))
