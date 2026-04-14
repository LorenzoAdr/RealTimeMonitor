#!/usr/bin/env python3
"""Genera JSON importable por la pestaña MIL-STD-1553 (Importar JSON) desde un CSV.

Uso:
  python scripts/build_m1553_registry_json.py RUTA.csv [merge_discrete.json] > salida.json

Columnas CSV (cabecera obligatoria):
  group,rt,word_kind,suffix,name,encoding,bits,scale,signed,units,discrete_bits

discrete_bits (opcional):
  - Vacío → sin bits DIS.
  - JSON en línea (celda entrecomillada en el CSV) → array
    [{"index":0,"name":"BIT0"}, ...]
  - Referencia a fichero junto al CSV:
    @discrete_status.json   o   file:discrete_status.json
    El fichero debe contener un array JSON (mismo formato que arriba).

merge_discrete.json (2.º argumento, opcional):
  Objeto cuyas claves son las del registro (p. ej. General::2::1::STATUS) y los valores
  son arrays discreteBits. Se fusionan después del CSV (sobrescriben discreteBits).
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path


def load_discrete_bits_field(raw: str, csv_dir: Path) -> list:
    """Parsea la columna discrete_bits: vacío, JSON inline, @fichero o file:fichero."""
    t = (raw or "").strip()
    if not t:
        return []
    if t.startswith("@"):
        path = csv_dir / t[1:].strip()
        return _load_discrete_json_file(path)
    if t.lower().startswith("file:"):
        path = Path(t[5:].strip())
        if not path.is_absolute():
            path = csv_dir / path
        return _load_discrete_json_file(path)
    try:
        data = json.loads(t)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"discrete_bits no es JSON válido ni referencia @/file: ({e}). Valor: {t[:80]}..."
        ) from e
    if not isinstance(data, list):
        raise ValueError("discrete_bits (JSON inline) debe ser un array")
    return data


def _load_discrete_json_file(path: Path) -> list:
    if not path.is_file():
        raise FileNotFoundError(f"No existe el fichero de discrete_bits: {path}")
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path} debe contener un array JSON de {{index,name}}")
    return data


def row_to_label(row: dict[str, str], csv_dir: Path) -> tuple[str, dict]:
    group = (row.get("group") or "General").strip() or "General"
    rt = int(row["rt"])
    wk = int(row["word_kind"])
    suffix = (row["suffix"] or "").strip()
    enc = (row.get("encoding") or "bnr").strip().lower()
    bits = int(row["bits"]) if (row.get("bits") or "").strip() else 16
    scale = float(row["scale"]) if (row.get("scale") or "").strip() else 1.0
    signed = str(row.get("signed") or "").strip().lower() in ("1", "true", "yes", "y", "s", "si")
    units = (row.get("units") or "").strip()
    discrete_bits = load_discrete_bits_field(row.get("discrete_bits") or "", csv_dir)
    key = f"{group}::{rt}::{wk}::{suffix}"
    out = {
        "group": group,
        "rt": rt,
        "wordKind": wk,
        "suffix": suffix,
        "name": (row.get("name") or "UNNAMED").strip() or "UNNAMED",
        "encoding": enc,
        "bits": bits,
        "scale": scale,
        "signed": signed,
        "units": units,
        "discreteBits": discrete_bits,
    }
    return key, out


def apply_merge(labels: dict[str, dict], merge_path: Path) -> None:
    with merge_path.open(encoding="utf-8") as f:
        merge = json.load(f)
    if not isinstance(merge, dict):
        raise ValueError("merge_discrete.json debe ser un objeto {{clave: [bits...]}}")
    for key, bits in merge.items():
        if key not in labels:
            print(f"[aviso] clave en merge ignorada (no está en CSV): {key}", file=sys.stderr)
            continue
        if not isinstance(bits, list):
            raise ValueError(f"merge[{key!r}] debe ser un array")
        labels[key]["discreteBits"] = bits


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"No existe: {path}", file=sys.stderr)
        return 1
    csv_dir = path.parent.resolve()
    merge_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if merge_path is not None and not merge_path.is_file():
        print(f"No existe merge: {merge_path}", file=sys.stderr)
        return 1

    labels: dict[str, dict] = {}
    with path.open(newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            if not row or not any((v or "").strip() for v in row.values()):
                continue
            key, lab = row_to_label({k: (v or "") for k, v in row.items()}, csv_dir)
            labels[key] = lab

    if merge_path is not None:
        apply_merge(labels, merge_path)

    doc = {"version": 1, "labels": labels}
    json.dump(doc, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
