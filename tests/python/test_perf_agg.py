"""Tests unitarios para web_monitor/perf_agg.py — agregación EMA de tiempos por fase."""

from __future__ import annotations

import threading

import perf_agg


class TestRecordPhaseUs:
    def setup_method(self):
        perf_agg.clear_phases()

    def teardown_method(self):
        perf_agg.clear_phases()

    def test_first_sample_initializes(self):
        perf_agg.record_phase_us("p1", 500.0)
        phases = perf_agg.snapshot_phases()
        assert len(phases) == 1
        p = phases[0]
        assert p["id"] == "p1"
        assert p["last_us"] == 500.0
        assert p["ema_us"] == 500.0
        assert p["samples"] == 1

    def test_ema_calculation(self):
        alpha = 0.15
        perf_agg.record_phase_us("p1", 100.0)
        perf_agg.record_phase_us("p1", 200.0)
        expected_ema = 100.0 * (1.0 - alpha) + 200.0 * alpha
        phases = perf_agg.snapshot_phases()
        assert phases[0]["last_us"] == 200.0
        assert phases[0]["ema_us"] == round(expected_ema, 3)
        assert phases[0]["samples"] == 2

    def test_ema_convergence_after_many_samples(self):
        for _ in range(100):
            perf_agg.record_phase_us("stable", 1000.0)
        phases = perf_agg.snapshot_phases()
        assert abs(phases[0]["ema_us"] - 1000.0) < 0.01

    def test_negative_duration_clamped_to_zero(self):
        perf_agg.record_phase_us("neg", -50.0)
        phases = perf_agg.snapshot_phases()
        assert phases[0]["last_us"] == 0.0
        assert phases[0]["ema_us"] == 0.0

    def test_multiple_phases_independent(self):
        perf_agg.record_phase_us("a", 100.0)
        perf_agg.record_phase_us("b", 200.0)
        perf_agg.record_phase_us("c", 300.0)
        phases = perf_agg.snapshot_phases()
        assert len(phases) == 3
        ids = [p["id"] for p in phases]
        assert ids == ["a", "b", "c"]


class TestRecordPhaseSec:
    def setup_method(self):
        perf_agg.clear_phases()

    def teardown_method(self):
        perf_agg.clear_phases()

    def test_sec_to_us_conversion(self):
        perf_agg.record_phase_sec("s1", 0.001)  # 1 ms = 1000 µs
        phases = perf_agg.snapshot_phases()
        assert phases[0]["last_us"] == 1000.0

    def test_sec_fractional(self):
        perf_agg.record_phase_sec("s2", 0.0005)  # 500 µs
        phases = perf_agg.snapshot_phases()
        assert phases[0]["last_us"] == 500.0


class TestSnapshotPhases:
    def setup_method(self):
        perf_agg.clear_phases()

    def teardown_method(self):
        perf_agg.clear_phases()

    def test_empty_snapshot(self):
        assert perf_agg.snapshot_phases() == []

    def test_sorted_by_id(self):
        perf_agg.record_phase_us("z_phase", 1.0)
        perf_agg.record_phase_us("a_phase", 2.0)
        perf_agg.record_phase_us("m_phase", 3.0)
        phases = perf_agg.snapshot_phases()
        ids = [p["id"] for p in phases]
        assert ids == ["a_phase", "m_phase", "z_phase"]

    def test_rounding_precision(self):
        perf_agg.record_phase_us("r", 123.45678)
        phases = perf_agg.snapshot_phases()
        assert phases[0]["last_us"] == 123.457
        assert phases[0]["ema_us"] == 123.457

    def test_samples_is_int(self):
        perf_agg.record_phase_us("x", 10.0)
        perf_agg.record_phase_us("x", 20.0)
        phases = perf_agg.snapshot_phases()
        assert isinstance(phases[0]["samples"], int)
        assert phases[0]["samples"] == 2


class TestClearPhases:
    def test_clear_removes_all(self):
        perf_agg.record_phase_us("a", 1.0)
        perf_agg.record_phase_us("b", 2.0)
        perf_agg.clear_phases()
        assert perf_agg.snapshot_phases() == []

    def test_record_after_clear(self):
        perf_agg.record_phase_us("a", 100.0)
        perf_agg.clear_phases()
        perf_agg.record_phase_us("a", 200.0)
        phases = perf_agg.snapshot_phases()
        assert phases[0]["last_us"] == 200.0
        assert phases[0]["ema_us"] == 200.0
        assert phases[0]["samples"] == 1


class TestThreadSafety:
    def setup_method(self):
        perf_agg.clear_phases()

    def teardown_method(self):
        perf_agg.clear_phases()

    def test_concurrent_writes_no_corruption(self):
        n_threads = 8
        n_per_thread = 500
        errors = []

        def writer(tid: int):
            try:
                for i in range(n_per_thread):
                    perf_agg.record_phase_us(f"thread_{tid}", float(i))
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        phases = perf_agg.snapshot_phases()
        assert len(phases) == n_threads
        for p in phases:
            assert p["samples"] == n_per_thread
