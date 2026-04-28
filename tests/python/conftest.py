"""Fixtures compartidos para los tests unitarios de VarMonitor."""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

WEB_MONITOR = Path(__file__).resolve().parent.parent.parent / "web_monitor"
if str(WEB_MONITOR) not in sys.path:
    sys.path.insert(0, str(WEB_MONITOR))

SCRIPTS_VARMON = Path(__file__).resolve().parent.parent.parent / "scripts" / "varmon"
if str(SCRIPTS_VARMON) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_VARMON))


# ── Constantes SHM duplicadas para construir buffers de test ──

MAGIC = 0x4D524156
VERSION_V1 = 1
VERSION_V2 = 2
HEADER_V1_SIZE = 32
HEADER_V2_SIZE = 64
NAME_MAX_LEN = 128
ENTRY_SIZE_V1 = NAME_MAX_LEN + 1 + 8  # 137
TABLE_ROW_V2 = 176

ROW_MODE_OFF = 128
ROW_TYPE_OFF = 129
ROW_PUB_SEQ_OFF = 130
ROW_VALUE_OFF = 136
ROW_MIRROR_OFF = 168
ROW_RING_CAP_OFF = 148
ROW_WRITE_IDX_OFF = 152
ROW_READ_IDX_OFF = 160

MODE_EXPORT_SNAPSHOT = 0
MODE_IMPORT_SNAPSHOT = 1
MODE_EXPORT_RING = 2


def build_v1_header(seq: int = 1, count: int = 0, timestamp: float = 100.0) -> bytearray:
    """Construye un header SHM v1 de 32 bytes."""
    buf = bytearray(HEADER_V1_SIZE)
    struct.pack_into("<I", buf, 0, MAGIC)
    struct.pack_into("<I", buf, 4, VERSION_V1)
    struct.pack_into("<Q", buf, 8, seq)
    struct.pack_into("<I", buf, 16, count)
    struct.pack_into("<d", buf, 24, timestamp)
    return buf


def build_v1_entry(name: str, type_byte: int, value: float) -> bytearray:
    """Construye una entrada SHM v1 de 137 bytes."""
    ent = bytearray(ENTRY_SIZE_V1)
    nb = name.encode("utf-8")[:NAME_MAX_LEN]
    ent[:len(nb)] = nb
    ent[NAME_MAX_LEN] = type_byte
    struct.pack_into("<d", ent, NAME_MAX_LEN + 1, value)
    return ent


def build_v2_header(
    seq: int = 1,
    count: int = 0,
    timestamp: float = 100.0,
    table_off: int = HEADER_V2_SIZE,
    stride: int = TABLE_ROW_V2,
    cap: int | None = None,
    ring_off: int = 0,
    ring_depth: int = 0,
    publish_period: float = 0.0,
) -> bytearray:
    """Construye un header SHM v2 de 64 bytes."""
    if cap is None:
        cap = count
    buf = bytearray(HEADER_V2_SIZE)
    struct.pack_into("<I", buf, 0, MAGIC)
    struct.pack_into("<I", buf, 4, VERSION_V2)
    struct.pack_into("<Q", buf, 8, seq)
    struct.pack_into("<I", buf, 16, count)
    struct.pack_into("<d", buf, 24, timestamp)
    struct.pack_into("<I", buf, 32, table_off)
    struct.pack_into("<I", buf, 36, stride)
    struct.pack_into("<I", buf, 40, cap)
    struct.pack_into("<I", buf, 44, ring_off)
    struct.pack_into("<H", buf, 48, 16)  # slot bytes
    struct.pack_into("<H", buf, 50, ring_depth)
    struct.pack_into("<d", buf, 52, publish_period)
    return buf


def build_v2_row(
    name: str,
    type_byte: int = 0,
    value: float = 0.0,
    mode: int = MODE_EXPORT_SNAPSHOT,
    mirror: float = 0.0,
    pub_seq: int = 1,
    ring_cap: int = 0,
    write_idx: int = 0,
    read_idx: int = 0,
) -> bytearray:
    """Construye una fila SHM v2 de TABLE_ROW_V2 bytes."""
    row = bytearray(TABLE_ROW_V2)
    nb = name.encode("utf-8")[:NAME_MAX_LEN]
    row[:len(nb)] = nb
    row[ROW_MODE_OFF] = mode
    row[ROW_TYPE_OFF] = type_byte
    struct.pack_into("<I", row, ROW_PUB_SEQ_OFF, pub_seq)
    struct.pack_into("<d", row, ROW_VALUE_OFF, value)
    struct.pack_into("<I", row, ROW_RING_CAP_OFF, ring_cap)
    struct.pack_into("<Q", row, ROW_WRITE_IDX_OFF, write_idx)
    struct.pack_into("<Q", row, ROW_READ_IDX_OFF, read_idx)
    struct.pack_into("<d", row, ROW_MIRROR_OFF, mirror)
    return row


class FakeMmap:
    """Wrapper sobre bytearray que simula la interfaz mmap necesaria para los tests.

    Soporta el buffer protocol para que struct.unpack_from funcione directamente
    sobre esta instancia (igual que un mmap real).
    """

    def __init__(self, data: bytearray | bytes):
        self._data = bytearray(data)
        self._pos = 0

    def size(self) -> int:
        return len(self._data)

    def seek(self, pos: int) -> None:
        self._pos = pos

    def tell(self) -> int:
        return self._pos

    def read(self, n: int) -> bytes:
        end = min(self._pos + n, len(self._data))
        result = bytes(self._data[self._pos:end])
        self._pos = end
        return result

    def write(self, data: bytes) -> int:
        end = self._pos + len(data)
        self._data[self._pos:end] = data
        self._pos = end
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        pass

    def __getitem__(self, idx):
        return self._data[idx]

    def __setitem__(self, idx, val):
        self._data[idx] = val

    def __buffer__(self, flags: int) -> memoryview:
        return memoryview(self._data)
