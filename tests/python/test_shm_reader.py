"""Tests unitarios para web_monitor/shm_reader.py — decodificación SHM y parsing de snapshots."""

from __future__ import annotations

import struct

import pytest

import shm_reader
from conftest import (
    ENTRY_SIZE_V1,
    HEADER_V1_SIZE,
    HEADER_V2_SIZE,
    MAGIC,
    MODE_EXPORT_RING,
    MODE_EXPORT_SNAPSHOT,
    MODE_IMPORT_SNAPSHOT,
    NAME_MAX_LEN,
    ROW_MIRROR_OFF,
    ROW_MODE_OFF,
    ROW_PUB_SEQ_OFF,
    ROW_READ_IDX_OFF,
    ROW_RING_CAP_OFF,
    ROW_TYPE_OFF,
    ROW_VALUE_OFF,
    ROW_WRITE_IDX_OFF,
    TABLE_ROW_V2,
    VERSION_V1,
    VERSION_V2,
    FakeMmap,
    build_v1_entry,
    build_v1_header,
    build_v2_header,
    build_v2_row,
)


# ── _type_str_to_byte ──


class TestTypeStrToByte:
    def test_int32(self):
        assert shm_reader._type_str_to_byte("int32") == 1

    def test_int32_case_insensitive(self):
        assert shm_reader._type_str_to_byte("INT32") == 1

    def test_bool(self):
        assert shm_reader._type_str_to_byte("bool") == 2

    def test_double_explicit(self):
        assert shm_reader._type_str_to_byte("double") == 0

    def test_unknown_defaults_to_double(self):
        assert shm_reader._type_str_to_byte("custom") == 0

    def test_none_defaults_to_double(self):
        assert shm_reader._type_str_to_byte(None) == 0

    def test_empty_defaults_to_double(self):
        assert shm_reader._type_str_to_byte("") == 0


# ── _decode_scalar_row ──


class TestDecodeScalarRow:
    def test_double(self):
        ts, val = shm_reader._decode_scalar_row(0, 3.14)
        assert ts == "double"
        assert val == 3.14

    def test_int32(self):
        ts, val = shm_reader._decode_scalar_row(1, 42.0)
        assert ts == "int32"
        assert val == 42
        assert isinstance(val, int)

    def test_bool_true(self):
        ts, val = shm_reader._decode_scalar_row(2, 1.0)
        assert ts == "bool"
        assert val is True

    def test_bool_false(self):
        ts, val = shm_reader._decode_scalar_row(2, 0.0)
        assert ts == "bool"
        assert val is False

    def test_string_type(self):
        ts, val = shm_reader._decode_scalar_row(3, 0.0)
        assert ts == "string"

    def test_out_of_range_type_defaults_to_double(self):
        ts, val = shm_reader._decode_scalar_row(99, 1.5)
        assert ts == "double"
        assert val == 1.5


# ── _decode_v2_row_entry ──


class TestDecodeV2RowEntry:
    def test_valid_double_snapshot(self):
        raw = build_v2_row("temperature", type_byte=0, value=25.5, mode=MODE_EXPORT_SNAPSHOT)
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent is not None
        assert ent["name"] == "temperature"
        assert ent["type"] == "double"
        assert ent["value"] == 25.5

    def test_valid_int32(self):
        raw = build_v2_row("counter", type_byte=1, value=100.0, mode=MODE_EXPORT_SNAPSHOT)
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent["name"] == "counter"
        assert ent["type"] == "int32"
        assert ent["value"] == 100
        assert isinstance(ent["value"], int)

    def test_valid_bool_true(self):
        raw = build_v2_row("flag", type_byte=2, value=1.0, mode=MODE_EXPORT_SNAPSHOT)
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent["type"] == "bool"
        assert ent["value"] is True

    def test_valid_bool_false(self):
        raw = build_v2_row("flag", type_byte=2, value=0.0, mode=MODE_EXPORT_SNAPSHOT)
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent["value"] is False

    def test_empty_name_returns_none(self):
        raw = build_v2_row("", type_byte=0, value=1.0)
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent is None

    def test_ring_mode_uses_mirror(self):
        raw = build_v2_row(
            "ring_var", type_byte=0,
            value=10.0, mirror=99.0,
            mode=MODE_EXPORT_RING,
        )
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent["value"] == 99.0  # mirror, no value

    def test_snapshot_mode_uses_value(self):
        raw = build_v2_row(
            "snap_var", type_byte=0,
            value=10.0, mirror=99.0,
            mode=MODE_EXPORT_SNAPSHOT,
        )
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent["value"] == 10.0  # value, no mirror

    def test_truncated_bytes_returns_none(self):
        ent = shm_reader._decode_v2_row_entry(b"\x00" * 50)
        assert ent is None

    def test_utf8_name(self):
        raw = build_v2_row("señal_α", type_byte=0, value=1.0)
        ent = shm_reader._decode_v2_row_entry(bytes(raw))
        assert ent["name"] == "señal_α"


# ── read_snapshot (v1) ──


class TestReadSnapshotV1:
    def test_basic_v1(self):
        header = build_v1_header(seq=42, count=2, timestamp=123.456)
        e1 = build_v1_entry("var_a", 0, 1.5)
        e2 = build_v1_entry("var_b", 1, 7.0)
        buf = FakeMmap(header + e1 + e2)
        snap = shm_reader.read_snapshot(buf)
        assert snap is not None
        assert snap["seq"] == 42
        assert snap["timestamp"] == 123.456
        assert snap["shm_version"] == VERSION_V1
        assert len(snap["data"]) == 2
        assert snap["data"][0]["name"] == "var_a"
        assert snap["data"][0]["value"] == 1.5
        assert snap["data"][1]["name"] == "var_b"
        assert snap["data"][1]["value"] == 7

    def test_empty_name_skipped(self):
        header = build_v1_header(seq=1, count=2)
        e1 = build_v1_entry("valid", 0, 1.0)
        e2 = build_v1_entry("", 0, 2.0)
        buf = FakeMmap(header + e1 + e2)
        snap = shm_reader.read_snapshot(buf)
        assert len(snap["data"]) == 1

    def test_count_clamped_to_max_vars(self):
        header = build_v1_header(seq=1, count=5000)
        entries = build_v1_entry("x", 0, 1.0) * 3
        buf = FakeMmap(header + entries)
        snap = shm_reader.read_snapshot(buf, max_vars=2)
        assert snap is not None
        assert len(snap["data"]) <= 2

    def test_bool_type_in_v1(self):
        header = build_v1_header(seq=1, count=1)
        e = build_v1_entry("flag", 2, 1.0)
        buf = FakeMmap(header + e)
        snap = shm_reader.read_snapshot(buf)
        assert snap["data"][0]["type"] == "bool"
        assert snap["data"][0]["value"] is True


# ── read_snapshot (v2) ──


class TestReadSnapshotV2:
    def test_basic_v2(self):
        header = build_v2_header(seq=10, count=2, timestamp=200.0, cap=10)
        r1 = build_v2_row("temp", type_byte=0, value=22.5, pub_seq=1)
        r2 = build_v2_row("flag", type_byte=2, value=1.0, pub_seq=1)
        buf = FakeMmap(header + r1 + r2)
        snap = shm_reader.read_snapshot(buf)
        assert snap is not None
        assert snap["seq"] == 10
        assert snap["timestamp"] == 200.0
        assert snap["shm_version"] == VERSION_V2
        assert len(snap["data"]) == 2
        assert snap["data"][0]["name"] == "temp"
        assert snap["data"][1]["name"] == "flag"

    def test_count_clamped_to_cap(self):
        header = build_v2_header(seq=1, count=100, cap=5)
        rows = b""
        for i in range(5):
            rows += build_v2_row(f"v{i}", value=float(i), pub_seq=1)
        buf = FakeMmap(header + rows)
        snap = shm_reader.read_snapshot(buf, max_vars=5)
        assert snap is not None
        assert len(snap["data"]) == 5

    def test_publish_period_valid(self):
        header = build_v2_header(seq=1, count=1, publish_period=0.01)
        r = build_v2_row("x", value=1.0, pub_seq=1)
        buf = FakeMmap(header + r)
        snap = shm_reader.read_snapshot(buf)
        assert "publish_period_sec" in snap
        assert snap["publish_period_sec"] == pytest.approx(0.01)

    def test_publish_period_out_of_range_excluded(self):
        header = build_v2_header(seq=1, count=1, publish_period=5000.0)
        r = build_v2_row("x", value=1.0, pub_seq=1)
        buf = FakeMmap(header + r)
        snap = shm_reader.read_snapshot(buf)
        assert "publish_period_sec" not in snap

    def test_publish_period_negative_excluded(self):
        header = build_v2_header(seq=1, count=1, publish_period=-1.0)
        r = build_v2_row("x", value=1.0, pub_seq=1)
        buf = FakeMmap(header + r)
        snap = shm_reader.read_snapshot(buf)
        assert "publish_period_sec" not in snap

    def test_publish_period_zero_excluded(self):
        header = build_v2_header(seq=1, count=1, publish_period=0.0)
        r = build_v2_row("x", value=1.0, pub_seq=1)
        buf = FakeMmap(header + r)
        snap = shm_reader.read_snapshot(buf)
        assert "publish_period_sec" not in snap

    def test_empty_name_skipped_v2(self):
        header = build_v2_header(seq=1, count=2, cap=2)
        r1 = build_v2_row("valid", value=1.0, pub_seq=1)
        r2 = build_v2_row("", value=2.0, pub_seq=1)
        buf = FakeMmap(header + r1 + r2)
        snap = shm_reader.read_snapshot(buf)
        assert len(snap["data"]) == 1


# ── read_snapshot (v2 incremental) ──


class TestReadSnapshotV2Incremental:
    def test_incremental_first_read(self):
        header = build_v2_header(seq=1, count=2, cap=10)
        r1 = build_v2_row("a", value=1.0, pub_seq=5)
        r2 = build_v2_row("b", value=2.0, pub_seq=5)
        buf = FakeMmap(header + r1 + r2)
        state = {}
        snap = shm_reader.read_snapshot(buf, row_parse_state=state)
        assert snap is not None
        assert len(snap["data"]) == 2
        assert state["stamps"] == [5, 5]

    def test_incremental_reuse_unchanged(self):
        header = build_v2_header(seq=2, count=1, cap=10)
        r = build_v2_row("a", value=1.0, pub_seq=5)
        buf = FakeMmap(header + r)
        state = {}
        snap1 = shm_reader.read_snapshot(buf, row_parse_state=state)

        struct.pack_into("<Q", buf._data, 8, 3)
        snap2 = shm_reader.read_snapshot(buf, row_parse_state=state)
        assert snap2 is not None
        assert snap2["data"][0]["name"] == "a"
        assert snap2["data"][0]["value"] == 1.0

    def test_incremental_updated_row(self):
        header = build_v2_header(seq=1, count=1, cap=10)
        r = build_v2_row("a", value=1.0, pub_seq=5)
        buf = FakeMmap(header + r)
        state = {}
        shm_reader.read_snapshot(buf, row_parse_state=state)

        struct.pack_into("<Q", buf._data, 8, 2)
        struct.pack_into("<d", buf._data, HEADER_V2_SIZE + ROW_VALUE_OFF, 99.0)
        struct.pack_into("<I", buf._data, HEADER_V2_SIZE + ROW_PUB_SEQ_OFF, 6)
        snap2 = shm_reader.read_snapshot(buf, row_parse_state=state)
        assert snap2["data"][0]["value"] == 99.0
        assert state["stamps"][0] == 6


# ── read_snapshot bad magic / small buffer ──


class TestReadSnapshotInvalid:
    def test_bad_magic_returns_none(self):
        buf_data = bytearray(HEADER_V1_SIZE)
        struct.pack_into("<I", buf_data, 0, 0xDEADBEEF)
        buf = FakeMmap(buf_data)
        assert shm_reader.read_snapshot(buf) is None

    def test_buffer_too_small_returns_none(self):
        buf = FakeMmap(bytearray(10))
        assert shm_reader.read_snapshot(buf) is None

    def test_unknown_version_returns_none(self):
        buf_data = bytearray(HEADER_V2_SIZE)
        struct.pack_into("<I", buf_data, 0, MAGIC)
        struct.pack_into("<I", buf_data, 4, 0)  # version 0
        buf = FakeMmap(buf_data)
        assert shm_reader.read_snapshot(buf) is None


# ── write_shm_import_row ──


class TestWriteShmImportRow:
    def _make_buf(self, n_rows: int = 1) -> FakeMmap:
        size = HEADER_V2_SIZE + n_rows * TABLE_ROW_V2
        return FakeMmap(bytearray(size))

    def test_write_double(self):
        buf = self._make_buf()
        ok = shm_reader.write_shm_import_row(buf, 0, "temp", "double", 25.5)
        assert ok is True
        buf.seek(HEADER_V2_SIZE)
        raw = buf.read(TABLE_ROW_V2)
        name = raw[:NAME_MAX_LEN].split(b"\x00")[0].decode()
        assert name == "temp"
        assert raw[ROW_MODE_OFF] == MODE_IMPORT_SNAPSHOT
        assert raw[ROW_TYPE_OFF] == 0
        val, = struct.unpack_from("<d", raw, ROW_VALUE_OFF)
        assert val == 25.5

    def test_write_bool_true(self):
        buf = self._make_buf()
        ok = shm_reader.write_shm_import_row(buf, 0, "flag", "bool", True)
        assert ok is True
        buf.seek(HEADER_V2_SIZE + ROW_VALUE_OFF)
        val, = struct.unpack("<d", buf.read(8))
        assert val == 1.0

    def test_write_bool_false(self):
        buf = self._make_buf()
        ok = shm_reader.write_shm_import_row(buf, 0, "flag", "bool", False)
        assert ok is True
        buf.seek(HEADER_V2_SIZE + ROW_VALUE_OFF)
        val, = struct.unpack("<d", buf.read(8))
        assert val == 0.0

    def test_write_int32(self):
        buf = self._make_buf()
        ok = shm_reader.write_shm_import_row(buf, 0, "cnt", "int32", 42)
        assert ok is True
        buf.seek(HEADER_V2_SIZE + ROW_VALUE_OFF)
        val, = struct.unpack("<d", buf.read(8))
        assert val == 42.0

    def test_name_truncation(self):
        long_name = "x" * 200
        buf = self._make_buf()
        ok = shm_reader.write_shm_import_row(buf, 0, long_name, "double", 1.0)
        assert ok is True
        buf.seek(HEADER_V2_SIZE)
        raw = buf.read(NAME_MAX_LEN)
        name = raw.split(b"\x00")[0].decode()
        assert len(name) <= NAME_MAX_LEN

    def test_out_of_bounds_row(self):
        buf = self._make_buf(n_rows=1)
        ok = shm_reader.write_shm_import_row(buf, 5, "x", "double", 1.0)
        assert ok is False

    def test_negative_row_index(self):
        buf = self._make_buf()
        ok = shm_reader.write_shm_import_row(buf, -1, "x", "double", 1.0)
        assert ok is False

    def test_none_buf_returns_false(self):
        ok = shm_reader.write_shm_import_row(None, 0, "x", "double", 1.0)
        assert ok is False


# ── peek_shm_seq ──


class TestPeekShmSeq:
    def test_valid_v1_header(self):
        header = build_v1_header(seq=42)
        buf = FakeMmap(header)
        assert shm_reader.peek_shm_seq(buf) == 42

    def test_valid_v2_header(self):
        header = build_v2_header(seq=99)
        buf = FakeMmap(header)
        assert shm_reader.peek_shm_seq(buf) == 99

    def test_bad_magic_returns_none(self):
        data = bytearray(HEADER_V1_SIZE)
        struct.pack_into("<I", data, 0, 0x12345678)
        struct.pack_into("<Q", data, 8, 10)
        buf = FakeMmap(data)
        assert shm_reader.peek_shm_seq(buf) is None

    def test_small_buffer_returns_none(self):
        buf = FakeMmap(bytearray(4))
        assert shm_reader.peek_shm_seq(buf) is None

    def test_seq_zero(self):
        header = build_v1_header(seq=0)
        buf = FakeMmap(header)
        assert shm_reader.peek_shm_seq(buf) == 0


# ── sync_v2_ring_read_idx ──


class TestSyncV2RingReadIdx:
    def test_advances_read_idx(self):
        header = build_v2_header(seq=1, count=1, cap=1)
        row = build_v2_row(
            "ring", mode=MODE_EXPORT_RING,
            ring_cap=64, write_idx=100, read_idx=50,
        )
        buf = FakeMmap(header + row)
        overflow = shm_reader.sync_v2_ring_read_idx(buf, max_vars=1)
        assert overflow is False  # pending=50 < cap=64
        read_idx, = struct.unpack_from("<Q", buf._data, HEADER_V2_SIZE + ROW_READ_IDX_OFF)
        assert read_idx == 100

    def test_no_overflow_when_within_cap(self):
        header = build_v2_header(seq=1, count=1, cap=1)
        row = build_v2_row(
            "ring", mode=MODE_EXPORT_RING,
            ring_cap=64, write_idx=60, read_idx=10,
        )
        buf = FakeMmap(header + row)
        overflow = shm_reader.sync_v2_ring_read_idx(buf, max_vars=1)
        assert overflow is False
        read_idx, = struct.unpack_from("<Q", buf._data, HEADER_V2_SIZE + ROW_READ_IDX_OFF)
        assert read_idx == 60

    def test_overflow_detected(self):
        header = build_v2_header(seq=1, count=1, cap=1)
        row = build_v2_row(
            "ring", mode=MODE_EXPORT_RING,
            ring_cap=10, write_idx=100, read_idx=0,
        )
        buf = FakeMmap(header + row)
        overflow = shm_reader.sync_v2_ring_read_idx(buf, max_vars=1)
        assert overflow is True
        read_idx, = struct.unpack_from("<Q", buf._data, HEADER_V2_SIZE + ROW_READ_IDX_OFF)
        assert read_idx == 100

    def test_skips_snapshot_mode_rows(self):
        header = build_v2_header(seq=1, count=1, cap=1)
        row = build_v2_row(
            "snap", mode=MODE_EXPORT_SNAPSHOT,
            ring_cap=64, write_idx=100, read_idx=0,
        )
        buf = FakeMmap(header + row)
        overflow = shm_reader.sync_v2_ring_read_idx(buf, max_vars=1)
        assert overflow is False
        read_idx, = struct.unpack_from("<Q", buf._data, HEADER_V2_SIZE + ROW_READ_IDX_OFF)
        assert read_idx == 0  # unchanged

    def test_bad_magic_returns_false(self):
        data = bytearray(HEADER_V2_SIZE + TABLE_ROW_V2)
        struct.pack_into("<I", data, 0, 0xDEAD)
        buf = FakeMmap(data)
        assert shm_reader.sync_v2_ring_read_idx(buf, max_vars=1) is False

    def test_v1_version_returns_false(self):
        header = build_v1_header(seq=1, count=1)
        row = build_v2_row("x", mode=MODE_EXPORT_RING, ring_cap=10, write_idx=50)
        buf = FakeMmap(header + row)
        assert shm_reader.sync_v2_ring_read_idx(buf, max_vars=1) is False

    def test_zero_ring_cap_skipped(self):
        header = build_v2_header(seq=1, count=1, cap=1)
        row = build_v2_row(
            "ring", mode=MODE_EXPORT_RING,
            ring_cap=0, write_idx=100, read_idx=0,
        )
        buf = FakeMmap(header + row)
        overflow = shm_reader.sync_v2_ring_read_idx(buf, max_vars=1)
        assert overflow is False
