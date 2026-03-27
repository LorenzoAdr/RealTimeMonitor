"""Persistencia SQLite para el registro ARINC (multi-registro lógico)."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
from typing import Any


DEFAULT_GROUP_NAME = "General"


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(r["name"]) for r in rows}


def _ensure_column(conn: sqlite3.Connection, table: str, col_name: str, col_def: str) -> None:
    cols = _table_columns(conn, table)
    if col_name in cols:
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_def}")


def ensure_db_schema(db_path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    with _connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS registries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                registry_id INTEGER NOT NULL,
                group_name TEXT NOT NULL DEFAULT 'General',
                label_oct TEXT NOT NULL,
                name TEXT NOT NULL,
                encoding TEXT NOT NULL,
                bits INTEGER,
                lsb REAL,
                scale REAL,
                signed INTEGER NOT NULL DEFAULT 0,
                units TEXT,
                min REAL,
                max REAL,
                ssm_json TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (registry_id) REFERENCES registries(id) ON DELETE CASCADE,
                UNIQUE (registry_id, group_name, label_oct)
            );

            CREATE TABLE IF NOT EXISTS dis_bits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label_id INTEGER NOT NULL,
                bit_index INTEGER NOT NULL,
                bit_name TEXT NOT NULL,
                FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE,
                UNIQUE (label_id, bit_index)
            );

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_labels_registry_group ON labels(registry_id, group_name);
            CREATE INDEX IF NOT EXISTS idx_labels_registry_name ON labels(registry_id, name);
            CREATE INDEX IF NOT EXISTS idx_dis_bits_label ON dis_bits(label_id);
            """
        )
        _ensure_column(conn, "labels", "group_name", "TEXT NOT NULL DEFAULT 'General'")
        legacy_sql_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='labels'"
        ).fetchone()
        legacy_sql = str(legacy_sql_row["sql"] or "") if legacy_sql_row else ""
        if "UNIQUE (registry_id, label_oct)" in legacy_sql and "UNIQUE (registry_id, group_name, label_oct)" not in legacy_sql:
            conn.executescript(
                """
                CREATE TABLE labels_v2 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    registry_id INTEGER NOT NULL,
                    group_name TEXT NOT NULL DEFAULT 'General',
                    label_oct TEXT NOT NULL,
                    name TEXT NOT NULL,
                    encoding TEXT NOT NULL,
                    bits INTEGER,
                    lsb REAL,
                    scale REAL,
                    signed INTEGER NOT NULL DEFAULT 0,
                    units TEXT,
                    min REAL,
                    max REAL,
                    ssm_json TEXT,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (registry_id) REFERENCES registries(id) ON DELETE CASCADE,
                    UNIQUE (registry_id, group_name, label_oct)
                );
                INSERT INTO labels_v2(
                    id, registry_id, group_name, label_oct, name, encoding, bits, lsb, scale,
                    signed, units, min, max, ssm_json, updated_at
                )
                SELECT
                    id, registry_id, COALESCE(group_name, 'General'), label_oct, name, encoding, bits, lsb, scale,
                    signed, units, min, max, ssm_json, updated_at
                FROM labels;
                DROP TABLE labels;
                ALTER TABLE labels_v2 RENAME TO labels;
                """
            )
            conn.executescript(
                """
                CREATE INDEX IF NOT EXISTS idx_labels_registry_group ON labels(registry_id, group_name);
                CREATE INDEX IF NOT EXISTS idx_labels_registry_name ON labels(registry_id, name);
                """
            )
        conn.commit()


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _set_meta(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    conn.execute(
        """
        INSERT INTO metadata(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        (key, value),
    )


def _get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
    if not row:
        return None
    return row["value"]


def list_registries(db_path: str) -> list[dict[str, Any]]:
    ensure_db_schema(db_path)
    with _connect(db_path) as conn:
        active_raw = _get_meta(conn, "active_registry_id")
        active_id = int(active_raw) if active_raw and str(active_raw).isdigit() else None
        rows = conn.execute(
            """
            SELECT
                r.id,
                r.name,
                r.created_at,
                r.updated_at,
                COUNT(l.id) AS label_count
            FROM registries r
            LEFT JOIN labels l ON l.registry_id = r.id
            GROUP BY r.id
            ORDER BY LOWER(r.name)
            """
        ).fetchall()
        out = []
        for r in rows:
            out.append(
                {
                    "id": int(r["id"]),
                    "name": str(r["name"]),
                    "created_at": str(r["created_at"]),
                    "updated_at": str(r["updated_at"]),
                    "label_count": int(r["label_count"] or 0),
                    "is_active": active_id is not None and int(r["id"]) == active_id,
                }
            )
        return out


def get_active_registry(db_path: str) -> dict[str, Any] | None:
    ensure_db_schema(db_path)
    with _connect(db_path) as conn:
        active_raw = _get_meta(conn, "active_registry_id")
        active_id = int(active_raw) if active_raw and str(active_raw).isdigit() else None
        if active_id is None:
            return None
        row = conn.execute(
            """
            SELECT id, name, created_at, updated_at
            FROM registries
            WHERE id = ?
            """,
            (active_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": int(row["id"]),
            "name": str(row["name"]),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }


def create_registry(db_path: str, name: str, activate: bool = True) -> dict[str, Any]:
    ensure_db_schema(db_path)
    reg_name = str(name or "").strip()
    if not reg_name:
        raise ValueError("Nombre de registro vacío")
    now = _iso_now()
    with _connect(db_path) as conn:
        cur = conn.execute(
            "INSERT INTO registries(name, created_at, updated_at) VALUES(?, ?, ?)",
            (reg_name, now, now),
        )
        rid = int(cur.lastrowid)
        if activate:
            _set_meta(conn, "active_registry_id", str(rid))
        conn.commit()
        return {"id": rid, "name": reg_name, "created_at": now, "updated_at": now}


def activate_registry(db_path: str, registry_id: int | None = None, name: str | None = None) -> dict[str, Any]:
    ensure_db_schema(db_path)
    if registry_id is None and not name:
        raise ValueError("Debe indicar registry_id o name")
    with _connect(db_path) as conn:
        row = None
        if registry_id is not None:
            row = conn.execute(
                "SELECT id, name, created_at, updated_at FROM registries WHERE id = ?",
                (int(registry_id),),
            ).fetchone()
        if row is None and name:
            row = conn.execute(
                "SELECT id, name, created_at, updated_at FROM registries WHERE name = ?",
                (str(name),),
            ).fetchone()
        if row is None:
            raise ValueError("Registro no encontrado")
        _set_meta(conn, "active_registry_id", str(int(row["id"])))
        conn.commit()
        return {
            "id": int(row["id"]),
            "name": str(row["name"]),
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }


def unload_active_registry(db_path: str) -> None:
    ensure_db_schema(db_path)
    with _connect(db_path) as conn:
        _set_meta(conn, "active_registry_id", None)
        conn.commit()


def _normalize_label_oct(v: Any) -> str | None:
    t = str(v or "").strip()
    if len(t) == 3 and all(ch in "01234567" for ch in t):
        return t
    return None


def _normalize_group(v: Any) -> str:
    t = str(v or "").strip()
    return t or DEFAULT_GROUP_NAME


def _float_or_none(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    t = str(v).strip()
    if not t:
        return None
    try:
        return float(t.replace(",", "."))
    except ValueError:
        return None


def _int_or_none(v: Any) -> int | None:
    f = _float_or_none(v)
    if f is None:
        return None
    return int(f)


def _normalize_encoding(v: Any) -> str:
    t = str(v or "").strip().lower()
    if t in ("dis", "disc", "discrete"):
        return "discrete"
    if t in ("bnr", "bcd"):
        return t
    return "bnr"


def _normalize_ssm(v: Any) -> list[int]:
    if isinstance(v, list):
        out: list[int] = []
        for item in v:
            try:
                out.append(int(item))
            except (TypeError, ValueError):
                pass
        return out
    if isinstance(v, str):
        out = []
        for tok in v.replace(";", ",").split(","):
            tok = tok.strip()
            if not tok:
                continue
            try:
                out.append(int(tok))
            except ValueError:
                pass
        return out
    return [0, 1, 2, 3]


def _normalize_dis_bits(v: Any) -> list[dict[str, Any]]:
    if not isinstance(v, list):
        return []
    out: list[dict[str, Any]] = []
    for item in v:
        if not isinstance(item, dict):
            continue
        idx = _int_or_none(item.get("index"))
        name = str(item.get("name") or "").strip()
        if idx is None or idx < 0 or idx > 18 or not name:
            continue
        out.append({"index": int(idx), "name": name})
    out.sort(key=lambda x: x["index"])
    dedup: dict[int, str] = {}
    for item in out:
        dedup[item["index"]] = item["name"]
    return [{"index": k, "name": v} for k, v in sorted(dedup.items(), key=lambda x: x[0])]


def load_active_labels(db_path: str) -> dict[str, Any]:
    ensure_db_schema(db_path)
    with _connect(db_path) as conn:
        active_raw = _get_meta(conn, "active_registry_id")
        active_id = int(active_raw) if active_raw and str(active_raw).isdigit() else None
        if active_id is None:
            raise ValueError("No hay registro activo")
        label_rows = conn.execute(
            """
            SELECT id, label_oct, group_name, name, encoding, bits, lsb, scale, signed, units, min, max, ssm_json
            FROM labels
            WHERE registry_id = ?
            ORDER BY group_name, label_oct
            """,
            (active_id,),
        ).fetchall()
        out: dict[str, Any] = {}
        for row in label_rows:
            bits_rows = conn.execute(
                "SELECT bit_index, bit_name FROM dis_bits WHERE label_id = ? ORDER BY bit_index",
                (int(row["id"]),),
            ).fetchall()
            dis_bits = [{"index": int(b["bit_index"]), "name": str(b["bit_name"])} for b in bits_rows]
            ssm_raw = row["ssm_json"]
            try:
                ssm_allowed = json.loads(ssm_raw) if ssm_raw else [0, 1, 2, 3]
            except Exception:
                ssm_allowed = [0, 1, 2, 3]
            group_name = str(row["group_name"] or DEFAULT_GROUP_NAME)
            octal = str(row["label_oct"])
            out_key = f"{group_name}::{octal}"
            out[out_key] = {
                "group": str(row["group_name"] or DEFAULT_GROUP_NAME),
                "labelOct": octal,
                "name": str(row["name"] or ""),
                "encoding": str(row["encoding"] or "bnr"),
                "bits": int(row["bits"]) if row["bits"] is not None else 19,
                "lsb": float(row["lsb"]) if row["lsb"] is not None else None,
                "scale": float(row["scale"]) if row["scale"] is not None else 1,
                "signed": bool(int(row["signed"] or 0)),
                "units": str(row["units"] or ""),
                "min": float(row["min"]) if row["min"] is not None else None,
                "max": float(row["max"]) if row["max"] is not None else None,
                "ssmAllowed": ssm_allowed,
                "discreteBits": dis_bits,
            }
        return out


def save_active_labels(db_path: str, labels: dict[str, Any]) -> dict[str, Any]:
    ensure_db_schema(db_path)
    if not isinstance(labels, dict):
        raise ValueError("Se requiere objeto labels")
    with _connect(db_path) as conn:
        active_raw = _get_meta(conn, "active_registry_id")
        active_id = int(active_raw) if active_raw and str(active_raw).isdigit() else None
        if active_id is None:
            raise ValueError("No hay registro activo")
        now = _iso_now()
        conn.execute("DELETE FROM labels WHERE registry_id = ?", (active_id,))
        total = 0
        for raw_key, raw_def in labels.items():
            if not isinstance(raw_def, dict):
                continue
            oct_key = _normalize_label_oct(raw_key)
            if not oct_key:
                oct_key = _normalize_label_oct(raw_def.get("labelOct") or raw_def.get("label_oct"))
            if not oct_key:
                m = str(raw_key).split("::")
                if len(m) == 2:
                    oct_key = _normalize_label_oct(m[1])
            if not oct_key:
                continue
            group_name = _normalize_group(raw_def.get("group") or raw_def.get("group_name"))
            name = str(raw_def.get("name") or "UNNAMED").strip() or "UNNAMED"
            enc = _normalize_encoding(raw_def.get("encoding"))
            bits = _int_or_none(raw_def.get("bits"))
            bits = max(1, min(19, bits if bits is not None else 19))
            lsb = _float_or_none(raw_def.get("lsb"))
            scale = _float_or_none(raw_def.get("scale"))
            if scale is None:
                scale = 1.0
            signed = bool(raw_def.get("signed"))
            units = str(raw_def.get("units") or "").strip()
            min_v = _float_or_none(raw_def.get("min"))
            max_v = _float_or_none(raw_def.get("max"))
            ssm_allowed = _normalize_ssm(raw_def.get("ssmAllowed"))
            dis_bits = _normalize_dis_bits(raw_def.get("discreteBits"))
            cur = conn.execute(
                """
                INSERT INTO labels(
                    registry_id, group_name, label_oct, name, encoding, bits, lsb, scale,
                    signed, units, min, max, ssm_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    active_id,
                    group_name,
                    oct_key,
                    name,
                    enc,
                    bits,
                    lsb,
                    scale,
                    1 if signed else 0,
                    units,
                    min_v,
                    max_v,
                    json.dumps(ssm_allowed, ensure_ascii=False),
                    now,
                ),
            )
            label_id = int(cur.lastrowid)
            if enc == "discrete":
                for bit in dis_bits:
                    conn.execute(
                        "INSERT INTO dis_bits(label_id, bit_index, bit_name) VALUES (?, ?, ?)",
                        (label_id, int(bit["index"]), str(bit["name"])),
                    )
            total += 1
        conn.execute("UPDATE registries SET updated_at = ? WHERE id = ?", (now, active_id))
        conn.commit()
        return {"saved_labels": total, "registry_id": active_id}


def import_database_file(src_path: str, db_path: str) -> dict[str, Any]:
    src = os.path.abspath(src_path)
    dst = os.path.abspath(db_path)
    if not os.path.isfile(src):
        raise ValueError("Fichero de base de datos no encontrado")
    if os.path.abspath(src) != os.path.abspath(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    ensure_db_schema(dst)
    with _connect(dst) as conn:
        # Si no hay activo pero sí registros, activar el primero alfabéticamente.
        active_raw = _get_meta(conn, "active_registry_id")
        active_ok = False
        if active_raw and str(active_raw).isdigit():
            row = conn.execute("SELECT id FROM registries WHERE id = ?", (int(active_raw),)).fetchone()
            active_ok = row is not None
        if not active_ok:
            first = conn.execute("SELECT id FROM registries ORDER BY LOWER(name), id LIMIT 1").fetchone()
            if first:
                _set_meta(conn, "active_registry_id", str(int(first["id"])))
        conn.commit()
    return {"path": dst}

