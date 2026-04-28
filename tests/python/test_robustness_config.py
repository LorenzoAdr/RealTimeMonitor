"""Smoke: fragmento de config de robustez contiene claves esperadas (SHM v2, sidecar)."""
from __future__ import annotations

import re
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def test_robustness_frag_has_required_keys() -> None:
    frag = _repo_root() / "scripts" / "robustness" / "varmon_robustness.frag"
    text = frag.read_text(encoding="utf-8")
    required = {
        "shm_layout_version": "2",
        "shm_ring_depth": "16",
        "cycle_interval_ms": "50",
        "recording_backend": "sidecar_cpp",
        "recordings_write_tsv": "1",
    }
    for key, expected in required.items():
        m = re.search(rf"^\s*{re.escape(key)}\s*=\s*(\S+)", text, re.MULTILINE)
        assert m is not None, f"falta clave {key} en {frag}"
        assert m.group(1) == expected, f"{key}: esperado {expected}, got {m.group(1)}"
