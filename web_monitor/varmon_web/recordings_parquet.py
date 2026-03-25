"""Lectura/escritura de grabaciones VarMonitor en Parquet (columnas time_s + escalares/array plano como TSV)."""

from __future__ import annotations

import math
import os
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

try:
    _PQ_COMPRESSION = "zstd"
    _ = pq.Compression.from_name("zstd")
except Exception:
    _PQ_COMPRESSION = "snappy"


def is_parquet_path(path: str) -> bool:
    return str(path).lower().endswith(".parquet")


def sibling_tsv_for_parquet(parquet_path: str) -> str:
    """Misma ruta base que el .parquet pero con extensión .tsv (sin asumir longitud de `.parquet`)."""
    root, ext = os.path.splitext(os.path.abspath(str(parquet_path)))
    if ext.lower() == ".parquet":
        return root + ".tsv"
    return str(parquet_path) + ".tsv"


def file_has_parquet_magic(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"PAR1"
    except OSError:
        return False


def _build_col_spec_max_over_snapshots(
    snapshots: list[tuple[float, list[dict]]],
    var_names: list[str],
) -> list[tuple[str, int]]:
    max_len: dict[str, int] = dict.fromkeys(var_names, 1)
    for _, data in snapshots:
        for e in data:
            if not isinstance(e, dict):
                continue
            n = e.get("name")
            if n not in max_len:
                continue
            v = e.get("value")
            if isinstance(v, (list, tuple)) and len(v) > max_len[n]:
                max_len[n] = len(v)
    return [(name, max_len[name]) for name in var_names]


def _record_row_layout(col_spec: list[tuple[str, int]]) -> tuple[dict[str, tuple[int, int]], int]:
    layout: dict[str, tuple[int, int]] = {}
    off = 0
    for name, size in col_spec:
        sz = max(1, int(size))
        layout[name] = (off, sz)
        off += sz
    return layout, off


def _build_record_col_spec(var_names: list[str], snapshot: list[dict]) -> list[tuple[str, int]]:
    snap_map = {e.get("name"): e.get("value") for e in snapshot if isinstance(e, dict)}
    spec: list[tuple[str, int]] = []
    for name in var_names:
        v = snap_map.get(name)
        if isinstance(v, (list, tuple)) and len(v) > 1:
            spec.append((name, len(v)))
        else:
            spec.append((name, 1))
    return spec


def _row_floats(
    t_rel: float,
    snapshot: list[dict],
    col_spec: list[tuple[str, int]],
    row_layout: tuple[dict[str, tuple[int, int]], int],
) -> list[float]:
    layout, nvals = row_layout
    vals = [float("nan")] * nvals
    for e in snapshot:
        if not isinstance(e, dict):
            continue
        n = e.get("name")
        if n is None or n not in layout:
            continue
        off, size = layout[n]
        v = e.get("value", "")
        if size <= 1:
            if isinstance(v, (list, tuple)):
                x = v[0] if len(v) >= 1 else None
            else:
                x = v
            vals[off] = float(x) if isinstance(x, (int, float)) and math.isfinite(float(x)) else float("nan")
        else:
            if isinstance(v, (list, tuple)):
                for i in range(size):
                    x = v[i] if i < len(v) else None
                    vals[off + i] = (
                        float(x) if isinstance(x, (int, float)) and math.isfinite(float(x)) else float("nan")
                    )
            else:
                x = v
                vals[off] = float(x) if isinstance(x, (int, float)) and math.isfinite(float(x)) else float("nan")
    return [float(t_rel)] + vals


def column_names_from_spec(col_spec: list[tuple[str, int]]) -> list[str]:
    parts = ["time_s"]
    for name, size in col_spec:
        if size <= 1:
            parts.append(name)
        else:
            parts.extend(f"{name}_{i}" for i in range(size))
    return parts


def snapshots_to_table(
    snapshots: list[tuple[float, list[dict]]],
    var_names: list[str] | None = None,
) -> pa.Table:
    if not snapshots:
        raise ValueError("snapshots vacío")
    t0 = float(snapshots[0][0])
    if var_names is None:
        names_set: set[str] = set()
        for _, data in snapshots:
            for e in data:
                if isinstance(e, dict) and e.get("name") is not None:
                    names_set.add(e["name"])
        var_names = sorted(names_set)
    col_spec = _build_col_spec_max_over_snapshots(snapshots, var_names)
    row_layout = _record_row_layout(col_spec)
    col_names = column_names_from_spec(col_spec)
    columns: dict[str, list[float]] = {c: [] for c in col_names}
    for t, data in snapshots:
        t_rel = max(0.0, float(t) - t0)
        floats = _row_floats(t_rel, data, col_spec, row_layout)
        for i, cn in enumerate(col_names):
            columns[cn].append(floats[i])
    arrays = [pa.array(columns[c], type=pa.float64()) for c in col_names]
    return pa.Table.from_arrays(arrays, names=col_names)


def write_snapshots_parquet(path: str, snapshots: list[tuple[float, list[dict]]], var_names: list[str] | None = None) -> None:
    table = snapshots_to_table(snapshots, var_names)
    pq.write_table(table, path, compression=_PQ_COMPRESSION)


def convert_tsv_file_to_parquet(tsv_path: str, parquet_path: str) -> int:
    """Lee TSV completo y escribe Parquet. Devuelve bytes escritos en parquet."""
    parse_options = pacsv.ParseOptions(delimiter="\t")
    convert_options = pacsv.ConvertOptions(strings_can_be_null=True)
    table = pacsv.read_csv(tsv_path, parse_options=parse_options, convert_options=convert_options)
    pq.write_table(table, parquet_path, compression=_PQ_COMPRESSION)
    return int(os.path.getsize(parquet_path))


def export_parquet_to_tsv(parquet_path: str, tsv_path: str) -> None:
    if not file_has_parquet_magic(parquet_path):
        raise ValueError(
            f"Se esperaba Parquet (magic PAR1) en {parquet_path!r}; el fichero parece texto u otro formato."
        )
    table = pq.read_table(parquet_path)
    # PyArrow CSV espera stream binario (evita "binary file expected, got text file" en versiones recientes).
    with open(tsv_path, "wb") as f:
        pacsv.write_csv(table, f, write_options=pacsv.WriteOptions(include_header=True, delimiter="\t"))


def read_parquet_schema_columns(path: str) -> list[str]:
    pf = pq.ParquetFile(path)
    return list(pf.schema_arrow.names)


# Límite de celdas (filas × columnas) para JSON offline: el TSV en texto era ~15–25 B/celda;
# en JSON anidado cada valor puede costar >100 B → acotar filas cuando hay muchas columnas.
_MAX_PREVIEW_CELLS = 300_000


def parquet_num_columns(path: str) -> int:
    return len(pq.ParquetFile(path).schema_arrow)


def cap_parquet_preview_rows(path: str, requested: int) -> int:
    """Reduce filas de preview cuando el esquema es muy ancho (p. ej. miles de variables)."""
    rq = max(1, int(requested))
    try:
        nc = max(1, parquet_num_columns(path))
    except Exception:
        nc = 1
    by_cells = max(50, min(rq, _MAX_PREVIEW_CELLS // nc))
    return int(min(by_cells, 100_000))


def read_time_bounds_parquet(path: str) -> dict[str, float]:
    """Min/max de time_s sin cargar toda la columna (estadísticas por row group o streaming)."""
    pf = pq.ParquetFile(path)
    names = list(pf.schema_arrow.names)
    if not names or names[0] != "time_s":
        raise ValueError("Parquet inválido: primera columna debe ser time_s")
    idx = 0
    g_min: float | None = None
    g_max: float | None = None
    for rg in range(pf.num_row_groups):
        try:
            col = pf.metadata.row_group(rg).column(idx)
            st = col.statistics
            if st is not None and getattr(st, "has_min_max", False):
                mn = float(st.min)
                mx = float(st.max)
                if math.isfinite(mn) and math.isfinite(mx):
                    g_min = mn if g_min is None else min(g_min, mn)
                    g_max = mx if g_max is None else max(g_max, mx)
        except Exception:
            continue
    if g_min is not None and g_max is not None:
        return {"minTs": g_min, "maxTs": g_max}
    # Sin estadísticas útiles: una pasada por lotes (RAM acotada)
    loc_min: float | None = None
    loc_max: float | None = None
    for batch in pf.iter_batches(batch_size=65536, columns=["time_s"]):
        for x in batch.column(0).to_pylist():
            try:
                fx = float(x)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(fx):
                continue
            loc_min = fx if loc_min is None else min(loc_min, fx)
            loc_max = fx if loc_max is None else max(loc_max, fx)
    if loc_min is None or loc_max is None:
        raise ValueError("No se encontraron tiempos válidos en Parquet")
    return {"minTs": float(loc_min), "maxTs": float(loc_max)}


def _time_s_column_index(pf: pq.ParquetFile) -> int:
    names = list(pf.schema_arrow.names)
    try:
        return names.index("time_s")
    except ValueError:
        return 0


def _row_group_indices_overlapping_time(
    pf: pq.ParquetFile,
    t_start: float,
    t_end: float,
) -> list[int]:
    """Índices de row group a leer: estadísticas min/max de time_s; si no hay stats, incluye el RG."""
    ti = _time_s_column_index(pf)
    out: list[int] = []
    for rg in range(pf.num_row_groups):
        try:
            col = pf.metadata.row_group(rg).column(ti)
            st = col.statistics
            if st is not None and getattr(st, "has_min_max", False):
                mn = float(st.min)
                mx = float(st.max)
                if mx < t_start or mn > t_end:
                    continue
        except Exception:
            pass
        out.append(rg)
    return out


def _downsample(ts: list[float], vals: list[float], max_points: int) -> tuple[list[float], list[float]]:
    n = len(ts)
    if n <= max_points:
        return ts, vals
    step = max(1, math.ceil(n / max_points))
    ds_ts = ts[0:n:step]
    ds_vals = vals[0:n:step]
    if ds_ts[-1] != ts[-1]:
        ds_ts.append(ts[-1])
        ds_vals.append(vals[-1])
    return ds_ts, ds_vals


def read_single_var_history_parquet(path: str, var_name: str, max_points: int = 20000) -> dict[str, Any]:
    """Una pasada por lotes: no cargar columnas enteras en RAM."""
    pf = pq.ParquetFile(path)
    if var_name not in pf.schema_arrow.names:
        raise KeyError(f"Variable '{var_name}' no encontrada en Parquet")
    ts_list: list[float] = []
    val_list: list[float] = []
    try:
        for batch in pf.iter_batches(batch_size=65536, columns=["time_s", var_name]):
            tab = pa.Table.from_batches([batch])
            tcol = tab.column(0).to_pylist()
            vcol = tab.column(1).to_pylist()
            for t, v in zip(tcol, vcol):
                if v is None:
                    continue
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(fv):
                    continue
                try:
                    tf = float(t)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(tf):
                    continue
                ts_list.append(tf)
                val_list.append(fv)
    except Exception as e:
        raise KeyError(f"Variable '{var_name}' no encontrada en Parquet") from e
    ds_ts, ds_vals = _downsample(ts_list, val_list, max_points)
    return {"name": var_name, "timestamps": ds_ts, "values": ds_vals}


def read_var_window_parquet(
    path: str,
    var_name: str,
    t_center: float,
    t_span: float,
    max_points: int = 5000,
) -> dict[str, Any]:
    """Ventana temporal: solo row groups que solapan [t_start,t_end] (stats time_s), no escanear todo el fichero."""
    if not math.isfinite(t_center) or t_span <= 0:
        raise ValueError("Parámetros de tiempo inválidos")
    half = t_span / 2.0
    t_start = t_center - half
    t_end = t_center + half
    if t_end < t_start:
        t_start, t_end = t_end, t_start
    pf = pq.ParquetFile(path)
    if var_name not in pf.schema_arrow.names:
        raise KeyError(f"Variable '{var_name}' no encontrada en Parquet")
    rg_list = _row_group_indices_overlapping_time(pf, t_start, t_end)
    ts_list: list[float] = []
    val_list: list[float] = []
    for rg_i in rg_list:
        try:
            tab = pf.read_row_group(rg_i, columns=["time_s", var_name])
        except Exception as e:
            raise KeyError(f"Variable '{var_name}' no encontrada en Parquet") from e
        t_arr = pc.cast(tab.column(0), pa.float64())
        mask = pc.and_(pc.greater_equal(t_arr, pa.scalar(t_start)), pc.less_equal(t_arr, pa.scalar(t_end)))
        filt = tab.filter(mask)
        for t, v in zip(filt.column(0).to_pylist(), filt.column(1).to_pylist()):
            if v is None:
                continue
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(fv):
                continue
            tf = float(t)
            if not math.isfinite(tf):
                continue
            ts_list.append(tf)
            val_list.append(fv)
    ds_ts, ds_vals = _downsample(ts_list, val_list, max_points)
    return {"name": var_name, "timestamps": ds_ts, "values": ds_vals}


def read_var_window_batch_parquet(
    path: str,
    var_names: list[str],
    t_center: float,
    t_span: float,
    max_points: int,
) -> list[dict[str, Any]]:
    """Varias variables en una pasada por row group (misma ventana temporal)."""
    if not math.isfinite(t_center) or t_span <= 0:
        raise ValueError("Parámetros de tiempo inválidos")
    half = t_span / 2.0
    t_start = t_center - half
    t_end = t_center + half
    if t_end < t_start:
        t_start, t_end = t_end, t_start
    pf = pq.ParquetFile(path)
    schema_names = set(pf.schema_arrow.names)
    wanted = [v for v in var_names if v and v in schema_names]
    if not wanted:
        return []
    rg_list = _row_group_indices_overlapping_time(pf, t_start, t_end)
    cols = ["time_s"] + wanted
    acc: dict[str, tuple[list[float], list[float]]] = {v: ([], []) for v in wanted}
    for rg_i in rg_list:
        try:
            tab = pf.read_row_group(rg_i, columns=cols)
        except Exception:
            continue
        t_arr = pc.cast(tab.column("time_s"), pa.float64())
        mask = pc.and_(pc.greater_equal(t_arr, pa.scalar(t_start)), pc.less_equal(t_arr, pa.scalar(t_end)))
        filt = tab.filter(mask)
        tcol = filt.column("time_s").to_pylist()
        for vn in wanted:
            vcol = filt.column(vn).to_pylist()
            ts_l, vl = acc[vn]
            for t, v in zip(tcol, vcol):
                if v is None:
                    continue
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(fv):
                    continue
                try:
                    tf = float(t)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(tf):
                    continue
                ts_l.append(tf)
                vl.append(fv)
    out: list[dict[str, Any]] = []
    for vn in wanted:
        ts_l, vl = acc[vn]
        ds_ts, ds_vals = _downsample(ts_l, vl, max_points)
        out.append({"name": vn, "timestamps": ds_ts, "values": ds_vals})
    return out


def parquet_num_rows(path: str) -> int:
    return int(pq.ParquetFile(path).metadata.num_rows)


def read_parquet_row_range(path: str, row_start: int, row_count: int) -> tuple[pa.Table, int, int]:
    """Lee [row_start, row_start + row_count) filas. Devuelve (table, total_rows, actual_count)."""
    pf = pq.ParquetFile(path)
    total_rows = int(pf.metadata.num_rows)
    row_start = max(0, min(int(row_start), total_rows))
    row_count = max(1, int(row_count))
    need = min(row_count, max(0, total_rows - row_start))
    if need <= 0:
        raise ValueError("Rango de filas vacío")
    col_names = list(pf.schema_arrow.names)
    skip = row_start
    batches_out: list[pa.RecordBatch] = []
    taken = 0
    for batch in pf.iter_batches(batch_size=65536, columns=col_names):
        nr = batch.num_rows
        if skip >= nr:
            skip -= nr
            continue
        b = batch.slice(skip) if skip > 0 else batch
        skip = 0
        remain = need - taken
        if b.num_rows > remain:
            b = b.slice(0, remain)
        batches_out.append(b)
        taken += b.num_rows
        if taken >= need:
            break
    if not batches_out:
        raise ValueError("No se pudieron leer filas del Parquet")
    return pa.Table.from_batches(batches_out), total_rows, taken


def parquet_slice_to_offline_payload(
    path: str,
    row_start: int,
    row_count: int,
    *,
    is_preview: bool = False,
    source_name: str = "dataset.parquet",
) -> dict[str, Any]:
    """Genera payload alineado con lo que el cliente espera tras parseTsvDataset (samples, names, minTs, maxTs)."""
    table, total_rows, actual_count = read_parquet_row_range(path, row_start, row_count)
    col_names = table.column_names
    if not col_names or col_names[0] != "time_s":
        raise ValueError("Parquet inválido: primera columna debe ser time_s")
    header = table.column_names

    scalar_cols: list[tuple[str, int]] = []
    array_cols: dict[str, list[tuple[int, int]]] = {}
    import re

    for c in range(1, len(header)):
        col = header[c]
        m = re.match(r"^(.*)_(\d+)$", col)
        if m:
            base = m.group(1)
            idx = int(m.group(2))
            array_cols.setdefault(base, []).append((idx, c))
        else:
            scalar_cols.append((col, c))
    for v in array_cols.values():
        v.sort(key=lambda x: x[0])

    samples: list[dict[str, Any]] = []
    n = table.num_rows
    for r in range(n):
        ts_raw = table.column(0)[r].as_py()
        try:
            ts = float(ts_raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(ts):
            continue
        data: list[dict[str, Any]] = []
        for name, ci in scalar_cols:
            cell = table.column(ci)[r].as_py()
            if cell is None:
                continue
            if isinstance(cell, float) and math.isnan(cell):
                continue
            if isinstance(cell, (int, float)) and math.isfinite(float(cell)):
                data.append(
                    {"name": name, "type": "double", "value": float(cell), "timestamp": ts}
                )
            elif isinstance(cell, bool):
                data.append({"name": name, "type": "bool", "value": cell, "timestamp": ts})
        for base, cols in array_cols.items():
            arr: list[float | None] = []
            has_any = False
            for _i, ci in cols:
                cell = table.column(ci)[r].as_py()
                if cell is None or (isinstance(cell, float) and math.isnan(cell)):
                    arr.append(None)
                else:
                    try:
                        fv = float(cell)
                        if math.isfinite(fv):
                            arr.append(fv)
                            has_any = True
                        else:
                            arr.append(None)
                    except (TypeError, ValueError):
                        arr.append(None)
            if has_any:
                nums = [float(x) if x is not None and math.isfinite(x) else 0.0 for x in arr]
                data.append({"name": base, "type": "array", "value": nums, "timestamp": ts})
        samples.append({"ts": ts, "data": data})

    if not samples:
        raise ValueError("No hay filas válidas en el tramo Parquet")
    samples.sort(key=lambda s: s["ts"])
    names_set: set[str] = set()
    for s in samples:
        for e in s["data"]:
            names_set.add(e["name"])
    names = sorted(names_set)
    min_ts = samples[0]["ts"]
    max_ts = samples[-1]["ts"]
    truncated = is_preview and (row_start + actual_count < total_rows or total_rows > len(samples))
    return {
        "sourceName": source_name,
        "samples": samples,
        "names": names,
        "minTs": min_ts,
        "maxTs": max_ts,
        "isEpoch": min_ts > 1e9,
        "isPreview": is_preview,
        "truncated": truncated,
        "total_rows": total_rows,
        "row_start": row_start,
        "row_count": actual_count,
    }


class RecordingParquetAppender:
    """Acumula filas y escribe a disco en batches para grabación incremental."""

    def __init__(self, path: str, batch_rows: int = 512) -> None:
        self.path = path
        self.batch_rows = max(64, int(batch_rows))
        self.col_spec: list[tuple[str, int]] | None = None
        self.row_layout: tuple[dict[str, tuple[int, int]], int] | None = None
        self.col_names: list[str] | None = None
        self.buffers: dict[str, list[float]] | None = None
        self._writer: pq.ParquetWriter | None = None
        self.rows_in_batch = 0
        self.total_rows = 0

    def _ensure_open(self) -> None:
        if self._writer is not None:
            return
        if not self.col_names:
            raise RuntimeError("schema no inicializado")
        fields = [(n, pa.float64()) for n in self.col_names]
        schema = pa.schema(fields)
        self._writer = pq.ParquetWriter(self.path, schema, compression=_PQ_COMPRESSION)

    def append_row(self, t_rel: float, snapshot: list[dict], var_names: list[str] | None) -> None:
        if self.col_spec is None:
            names = var_names or sorted(
                {e.get("name") for e in snapshot if isinstance(e, dict) and e.get("name") is not None}
            )
            self.col_spec = _build_record_col_spec(names, snapshot)
            self.row_layout = _record_row_layout(self.col_spec)
            self.col_names = column_names_from_spec(self.col_spec)
            self.buffers = {c: [] for c in self.col_names}
        assert self.col_spec is not None and self.row_layout is not None and self.buffers is not None
        floats = _row_floats(t_rel, snapshot, self.col_spec, self.row_layout)
        for i, c in enumerate(self.col_names):
            self.buffers[c].append(floats[i])
        self.rows_in_batch += 1
        self.total_rows += 1
        if self.rows_in_batch >= self.batch_rows:
            self._flush_batch()

    def _flush_batch(self) -> None:
        if not self.buffers or self.rows_in_batch == 0:
            return
        self._ensure_open()
        assert self._writer is not None and self.col_names is not None
        arrays = [pa.array(self.buffers[c], type=pa.float64()) for c in self.col_names]
        batch_tbl = pa.Table.from_arrays(arrays, names=self.col_names)
        self._writer.write_table(batch_tbl)
        for c in self.col_names:
            self.buffers[c].clear()
        self.rows_in_batch = 0

    def close(self) -> None:
        self._flush_batch()
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:
                pass
            self._writer = None
