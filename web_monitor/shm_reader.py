"""Lector de SHM + semáforo POSIX para VarMonitor (fase 1). Solo Linux."""

import ctypes
import mmap
import os
import struct
import sys
import threading
import time
from queue import Queue

# Avisos de retraso / pérdida (stderr); colores solo si es TTY.
_C_RED = "\033[91m"
_C_YELLOW = "\033[93m"
_C_RESET = "\033[0m"


def _stderr_tty() -> bool:
    try:
        return sys.stderr.isatty()
    except Exception:
        return False


def _shm_trace_warn(msg: str, rate_key: str, next_allowed: dict, interval_sec: float) -> None:
    now = time.monotonic()
    if now < next_allowed.get(rate_key, 0.0):
        return
    next_allowed[rate_key] = now + interval_sec
    if _stderr_tty():
        print(f"{_C_YELLOW}[VarMonitor SHM] WARNING: {msg}{_C_RESET}", file=sys.stderr, flush=True)
    else:
        print(f"[VarMonitor SHM] WARNING: {msg}", file=sys.stderr, flush=True)


def _shm_trace_loss(msg: str, rate_key: str, next_allowed: dict, interval_sec: float) -> None:
    now = time.monotonic()
    if now < next_allowed.get(rate_key, 0.0):
        return
    next_allowed[rate_key] = now + interval_sec
    if _stderr_tty():
        print(f"{_C_RED}[VarMonitor SHM] PÉRDIDA DE DATOS: {msg}{_C_RESET}", file=sys.stderr, flush=True)
    else:
        print(f"[VarMonitor SHM] PÉRDIDA DE DATOS: {msg}", file=sys.stderr, flush=True)


class _SemTimespec(ctypes.Structure):
    """Una sola definición; crear la clase dentro de _sem_wait() por llamada acumulaba ~10 MiB (tracemalloc)."""

    _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]


def _ensure_libc_sem_timedwait(libc) -> None:
    if getattr(libc, "_varmon_sem_timedwait_abi", False):
        return
    libc.sem_timedwait.argtypes = [ctypes.c_void_p, ctypes.POINTER(_SemTimespec)]
    libc.sem_timedwait.restype = ctypes.c_int
    libc._varmon_sem_timedwait_abi = True


def _ensure_libc_sem_trywait(libc) -> None:
    if getattr(libc, "_varmon_sem_trywait_abi", False):
        return
    libc.sem_trywait.argtypes = [ctypes.c_void_p]
    libc.sem_trywait.restype = ctypes.c_int
    libc._varmon_sem_trywait_abi = True

# Layout C++: v1 HEADER 32 + ENTRY 137; v2 HEADER 64 + fila 176 + arena anillos.
# Debe coincidir con shm_publisher.cpp y shm_max_vars en varmon.conf.
MAX_VARS = 2048
MAGIC = 0x4D524156  # VARM little-endian
VERSION_V1 = 1
VERSION_V2 = 2
HEADER_V1_SIZE = 32  # magic, version, seq, count, pad, timestamp
HEADER_V2_SIZE = 64  # + table_off, stride, cap, ring_off, slot_b, depth, pad
NAME_MAX_LEN = 128
ENTRY_SIZE_V1 = NAME_MAX_LEN + 1 + 8  # v1: name + type_byte + value double
TABLE_ROW_V2 = 176
# Primeros 32 bytes: igual que v1
HEADER_FMT = "<IIQI"  # 0-20: magic, version, seq, count
TIMESTAMP_OFF = 24
# v2: double en +52, periodo entre publicaciones (seg), escrito por C++ (antes padding a 0).
HEADER_PUBLISH_PERIOD_SEC_OFF = 52

ROW_MODE_OFF = 128
ROW_TYPE_OFF = 129
# uint32 LE: último seq SHM en que C++ escribió la fila (troceo / skip → sin tocar = reutilizar en Python)
ROW_PUB_SEQ_OFF = 130
ROW_VALUE_OFF = 136
ROW_MIRROR_OFF = 168
ROW_RING_CAP_OFF = 148
ROW_WRITE_IDX_OFF = 152
ROW_READ_IDX_OFF = 160
MODE_EXPORT_SNAPSHOT = 0
MODE_IMPORT_SNAPSHOT = 1
MODE_EXPORT_RING = 2

# El backend escribe IMPORT desde el hilo WS mientras ShmReader parsea snapshots en otro hilo.
# Este lock evita leer filas a medio escribir dentro del mismo proceso Python.
_SHM_RW_LOCK = threading.Lock()

TYPE_STR = ["double", "int32", "bool", "string", "array"]


def _open_shm(shm_name: str, write: bool = False):
    """Abre el segmento SHM en /dev/shm. Devuelve (fd, mmap) o (None, None)."""
    path = f"/dev/shm/{shm_name}"
    try:
        flags = os.O_RDWR if write else os.O_RDONLY
        prot = mmap.PROT_READ | mmap.PROT_WRITE if write else mmap.PROT_READ
        fd = os.open(path, flags)
        size = os.path.getsize(path)
        if size < HEADER_V1_SIZE:
            os.close(fd)
            return None, None
        buf = mmap.mmap(fd, size, mmap.MAP_SHARED, prot)
        return fd, buf
    except (OSError, FileNotFoundError):
        return None, None


def open_shm_rw(shm_name: str):
    """Mmap RW del mismo segmento (import one-shot v2). Devuelve (fd, mmap) o (None, None)."""
    return _open_shm(shm_name, write=True)


def _type_str_to_byte(var_type: str) -> int:
    t = (var_type or "double").lower()
    if t == "int32":
        return 1
    if t == "bool":
        return 2
    return 0


def write_shm_import_row(
    buf: mmap.mmap,
    row_index: int,
    name: str,
    var_type: str,
    value,
    *,
    table_off: int = HEADER_V2_SIZE,
    row_stride: int = TABLE_ROW_V2,
) -> bool:
    """Marca la fila row_index como IMPORT_SNAPSHOT con nombre/tipo/valor (v2)."""
    if buf is None or row_index < 0:
        return False
    if buf.size() < HEADER_V2_SIZE + (row_index + 1) * row_stride:
        return False
    off = table_off + row_index * row_stride
    with _SHM_RW_LOCK:
        # Preservar metadatos de fila (mirror, índices ring...) y solo actualizar campos IMPORT.
        buf.seek(off)
        raw_prev = buf.read(row_stride)
        row = bytearray(raw_prev if len(raw_prev) == row_stride else (b"\x00" * row_stride))
        row[0:NAME_MAX_LEN] = b"\x00" * NAME_MAX_LEN
        nb = name.encode("utf-8", errors="replace")[:NAME_MAX_LEN]
        row[0 : len(nb)] = nb
        row[ROW_MODE_OFF] = MODE_IMPORT_SNAPSHOT
        tb = _type_str_to_byte(var_type)
        row[ROW_TYPE_OFF] = tb
        if tb == 2:
            dv = 1.0 if value else 0.0
        elif tb == 1:
            dv = float(int(value))
        else:
            dv = float(value)
        struct.pack_into("<d", row, ROW_VALUE_OFF, dv)
        # Fuerza al parser incremental a releer la fila tras IMPORT.
        struct.pack_into("<I", row, ROW_PUB_SEQ_OFF, 0)
        buf.seek(off)
        buf.write(bytes(row))
        buf.flush()
    return True


def _open_sem(sem_name: str) -> tuple[object | None, str | None]:
    """Abre semáforo POSIX existente. Devuelve (handle, None) o (None, mensaje_errno)."""
    try:
        # use_errno=True para que ctypes.get_errno() refleje el errno de sem_open
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.sem_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
        libc.sem_open.restype = ctypes.c_void_p
        libc.sem_wait.argtypes = [ctypes.c_void_p]
        libc.sem_close.argtypes = [ctypes.c_void_p]
        # O_RDWR = 2: necesario en muchos sistemas para abrir un semáforo existente
        O_RDWR = 2
        SEM_FAILED_VAL = ctypes.c_void_p(-1).value
        name_bytes = sem_name.encode("utf-8")
        sem = libc.sem_open(name_bytes, O_RDWR)
        errno_val = ctypes.get_errno()
        if sem is None or getattr(sem, "value", sem) == SEM_FAILED_VAL:
            errno_names = {
                2: "ENOENT — no existe /dev/shm/sem.<nombre> (compruebe 'ls /dev/shm/sem.*')",
                13: "EACCES — permiso denegado (mismo usuario que el proceso C++)",
                20: "ENOTDIR",
                24: "EMFILE (demasiados descriptores abiertos)",
            }
            err_str = errno_names.get(errno_val, f"errno={errno_val}")
            return (None, err_str)
        return ((libc, sem), None)
    except Exception as e:
        return (None, str(e))


def _sem_trywait(libc, sem) -> bool:
    """Intenta decrementar el semáforo sin bloquear. True si había un post pendiente."""
    _ensure_libc_sem_trywait(libc)
    sem_ptr = sem if isinstance(sem, ctypes.c_void_p) else ctypes.c_void_p(sem)
    return libc.sem_trywait(sem_ptr) == 0


def _sem_wait(libc, sem, timeout_sec: float | None = None):
    """Espera al semáforo. Si timeout_sec es None, espera indefinidamente. True si se obtuvo, False si timeout."""
    sem_ptr = sem if isinstance(sem, ctypes.c_void_p) else ctypes.c_void_p(sem)
    if timeout_sec is None:
        libc.sem_wait(sem_ptr)
        return True
    _ensure_libc_sem_timedwait(libc)
    # sem_timedwait espera tiempo ABSOLUTO (CLOCK_REALTIME), no relativo.
    deadline = time.time() + max(0.0, float(timeout_sec))
    tv_sec = int(deadline)
    tv_nsec = int((deadline - tv_sec) * 1_000_000_000)
    ts = _SemTimespec(tv_sec, tv_nsec)
    ret = libc.sem_timedwait(sem_ptr, ctypes.byref(ts))
    return ret == 0


def _sem_close(libc, sem):
    sem_ptr = sem if isinstance(sem, ctypes.c_void_p) else ctypes.c_void_p(sem)
    libc.sem_close(sem_ptr)


def _decode_scalar_row(type_byte: int, value: float) -> tuple[str, object]:
    type_str = TYPE_STR[type_byte] if 0 <= type_byte < len(TYPE_STR) else "double"
    if type_str == "bool":
        val_out: object = bool(int(value))
    elif type_str == "int32":
        val_out = int(value)
    else:
        val_out = value
    return type_str, val_out


def _decode_v2_row_entry(raw_ent: bytes) -> dict | None:
    """Una fila v2 → {name, type, value} o None si nombre vacío."""
    if len(raw_ent) < TABLE_ROW_V2:
        return None
    name_b = raw_ent[:NAME_MAX_LEN]
    mode = raw_ent[ROW_MODE_OFF] if len(raw_ent) > ROW_MODE_OFF else MODE_EXPORT_SNAPSHOT
    type_byte = raw_ent[ROW_TYPE_OFF]
    value, = struct.unpack_from("<d", raw_ent, ROW_VALUE_OFF)
    mirror, = struct.unpack_from("<d", raw_ent, ROW_MIRROR_OFF)
    name = name_b.split(b"\x00")[0].decode("utf-8", errors="replace").strip()
    if not name:
        return None
    disp = mirror if mode == MODE_EXPORT_RING else value
    type_str, val_out = _decode_scalar_row(type_byte, disp)
    return {"name": name, "type": type_str, "value": val_out}


def _read_snapshot_v2_incremental(
    buf: mmap.mmap,
    cap: int,
    seq: int,
    count: int,
    timestamp: float,
    table_off: int,
    stride: int,
    state: dict,
    publish_period_sec: float | None = None,
) -> dict | None:
    """Reutiliza filas cuyo ROW_PUB_SEQ_OFF no cambió (misma semántica que lectura completa)."""
    stamps: list = state.setdefault("stamps", [])
    rows: list = state.setdefault("rows", [])
    if stride < TABLE_ROW_V2:
        stride = TABLE_ROW_V2
    if count > cap:
        count = cap
    if len(stamps) != count or len(rows) != count:
        stamps.clear()
        rows.clear()
        stamps.extend([-1] * count)
        rows.extend([None] * count)

    result: list[dict] = []
    for i in range(count):
        off = table_off + i * stride
        if off + stride > buf.size():
            break
        try:
            row_stamp = struct.unpack_from("<I", buf, off + ROW_PUB_SEQ_OFF)[0]
        except struct.error:
            break
        reuse = (
            row_stamp != 0
            and row_stamp == stamps[i]
            and rows[i] is not None
        )
        if not reuse:
            buf.seek(off)
            raw_ent = buf.read(stride)
            if len(raw_ent) < TABLE_ROW_V2:
                break
            row_stamp = struct.unpack_from("<I", raw_ent, ROW_PUB_SEQ_OFF)[0]
            ent = _decode_v2_row_entry(raw_ent)
            stamps[i] = row_stamp
            rows[i] = ent
        else:
            ent = rows[i]
        if ent and ent.get("name"):
            result.append(ent)
    out = {"timestamp": float(timestamp), "data": result, "seq": seq, "shm_version": VERSION_V2}
    if publish_period_sec is not None and publish_period_sec > 0.0:
        out["publish_period_sec"] = float(publish_period_sec)
    return out


def read_snapshot(
    buf: mmap.mmap, max_vars: int | None = None, row_parse_state: dict | None = None
) -> dict | None:
    """Lee header + entradas del buffer SHM (v1 o v2).

    Devuelve {"timestamp", "data", "seq", "shm_version"?} o None si magic inválido.
    """
    with _SHM_RW_LOCK:
        cap = max_vars if max_vars is not None else MAX_VARS
        if buf.size() < HEADER_V1_SIZE:
            return None
        buf.seek(0)
        need = min(HEADER_V2_SIZE, buf.size())
        raw = buf.read(need)
        if len(raw) < HEADER_V1_SIZE:
            return None
        magic, version, seq, count = struct.unpack(HEADER_FMT, raw[:20])
        if len(raw) >= TIMESTAMP_OFF + 8:
            timestamp, = struct.unpack("<d", raw[TIMESTAMP_OFF : TIMESTAMP_OFF + 8])
        else:
            timestamp = 0.0
        if magic != MAGIC:
            return None
        if count > cap:
            count = cap

        if version == VERSION_V1:
            buf.seek(HEADER_V1_SIZE)
            result = []
            for _ in range(count):
                if buf.tell() + ENTRY_SIZE_V1 > buf.size():
                    break
                raw_ent = buf.read(ENTRY_SIZE_V1)
                if len(raw_ent) < ENTRY_SIZE_V1:
                    break
                name_b = raw_ent[:NAME_MAX_LEN]
                type_byte = raw_ent[NAME_MAX_LEN]
                value, = struct.unpack_from("<d", raw_ent, NAME_MAX_LEN + 1)
                name = name_b.split(b"\x00")[0].decode("utf-8", errors="replace").strip()
                if not name:
                    continue
                type_str, val_out = _decode_scalar_row(type_byte, value)
                result.append({"name": name, "type": type_str, "value": val_out})
            return {"timestamp": float(timestamp), "data": result, "seq": seq, "shm_version": VERSION_V1}

        if version >= VERSION_V2:
            if buf.size() < HEADER_V2_SIZE or len(raw) < HEADER_V2_SIZE:
                return None
            publish_period_sec: float | None = None
            if len(raw) >= HEADER_PUBLISH_PERIOD_SEC_OFF + 8:
                pp, = struct.unpack_from("<d", raw, HEADER_PUBLISH_PERIOD_SEC_OFF)
                if pp > 0.0 and pp < 3600.0:
                    publish_period_sec = float(pp)
            table_off, stride = struct.unpack_from("<II", raw, 32)
            if stride < TABLE_ROW_V2:
                stride = TABLE_ROW_V2
            if row_parse_state is not None:
                return _read_snapshot_v2_incremental(
                    buf,
                    cap,
                    seq,
                    count,
                    timestamp,
                    table_off,
                    stride,
                    row_parse_state,
                    publish_period_sec=publish_period_sec,
                )
            result = []
            for i in range(count):
                off = table_off + i * stride
                if off + stride > buf.size():
                    break
                buf.seek(off)
                raw_ent = buf.read(stride)
                ent = _decode_v2_row_entry(raw_ent)
                if ent:
                    result.append(ent)
            out_v2 = {"timestamp": float(timestamp), "data": result, "seq": seq, "shm_version": VERSION_V2}
            if publish_period_sec is not None:
                out_v2["publish_period_sec"] = publish_period_sec
            return out_v2

        return None


def sync_v2_ring_read_idx(buf: mmap.mmap, max_vars: int | None) -> bool:
    """Actualiza read_idx = write_idx en filas modo anillo (v2). Requiere mmap PROT_WRITE.

    Devuelve True si en alguna fila write_idx - read_idx superó ring_capacity (muestras sobrescritas).
    """
    cap_m = max_vars if max_vars is not None else MAX_VARS
    if buf.size() < HEADER_V2_SIZE:
        return False
    buf.seek(0)
    raw = buf.read(HEADER_V2_SIZE)
    if len(raw) < HEADER_V2_SIZE:
        return False
    magic, version, _seq, count = struct.unpack(HEADER_FMT, raw[:20])
    if magic != MAGIC or version < VERSION_V2:
        return False
    if count > cap_m:
        count = cap_m
    table_off, stride = struct.unpack_from("<II", raw, 32)
    if stride < TABLE_ROW_V2:
        stride = TABLE_ROW_V2
    had_overflow = False
    for i in range(count):
        off = table_off + i * stride
        if off + TABLE_ROW_V2 > buf.size():
            break
        # Solo leer modo + metadatos de anillo; evita 176 B/fila en exports snapshot (miles de vars).
        if buf[off + ROW_MODE_OFF] != MODE_EXPORT_RING:
            continue
        ring_cap = struct.unpack_from("<I", buf, off + ROW_RING_CAP_OFF)[0]
        if ring_cap == 0:
            continue
        w, r = struct.unpack_from("<QQ", buf, off + ROW_WRITE_IDX_OFF)
        pending = w - r
        if pending > ring_cap:
            had_overflow = True
        buf.seek(off + ROW_READ_IDX_OFF)
        buf.write(struct.pack("<Q", w))
    try:
        buf.flush()
    except Exception:
        pass
    return had_overflow


def peek_shm_seq(buf: mmap.mmap) -> int | None:
    """Solo seq del header (barato). Para polling: no parsear 2048 entradas si C++ no escribió ciclo nuevo."""
    if buf.size() < HEADER_V1_SIZE:
        return None
    buf.seek(0)
    raw = buf.read(HEADER_V1_SIZE)
    if len(raw) < 20:
        return None
    magic, _version, seq, _count = struct.unpack(HEADER_FMT, raw[:20])
    if magic != MAGIC:
        return None
    return int(seq)


class ShmReader:
    """Lee SHM en un hilo: sem_wait (o polling si el semáforo no abre) -> lee snapshot -> pone en queue."""

    def __init__(
        self,
        shm_name: str,
        sem_name: str,
        queue: Queue,
        poll_interval: float = 0.5,
        max_vars: int | None = None,
        parse_max_hz: float | None = None,
        sample_interval_ms: int | None = None,
    ):
        self.shm_name = shm_name
        self.sem_name = sem_name
        self.queue = queue
        self.poll_interval = poll_interval
        self._max_vars = max_vars  # None = usar MAX_VARS del módulo (debe coincidir con C++)
        # Ciclo del monitor C++ (server_info.sample_interval_ms). Solo modo polling: espaciar lecturas de seq.
        self._sample_interval_ms = int(sample_interval_ms) if (sample_interval_ms is not None and sample_interval_ms > 0) else None
        # Tope opcional de read_snapshot/s cuando set_full_parse_rate(False); None = sin tope (ritmo del semáforo).
        self._parse_max_hz = float(parse_max_hz) if (parse_max_hz is not None and parse_max_hz > 0) else None
        self._full_parse_rate = False
        self._last_parse_mono = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._fd = None
        self._buf: mmap.mmap | None = None
        self._sem_handle = None
        self._last_error: str | None = None
        self._polling_only: bool = False
        # True: no parsear SHM (ahorra RAM/CPU en live sin monitor/alarmas/grabación).
        self._reads_paused: bool = False
        # Grabación sidecar: sin parsear mmap; solo dormir y vaciar el sem principal (evita competir por CPU con varmon_sidecar).
        self._sidecar_sem_pump_only: bool = False
        self._sidecar_sem_pump_interval: float = 0.2
        self._last_seen_seq: int | None = None
        self._rate_limit_until: dict[str, float] = {}
        self._warn_interval_sec = 2.0
        self._loss_interval_sec = 1.5
        # Cache por índice de fila v2: evita decodificar miles de vars si C++ no tocó la fila (troceo).
        self._row_parse_state: dict = {"stamps": [], "rows": []}

    def set_reads_paused(self, paused: bool) -> None:
        was = self._reads_paused
        self._reads_paused = bool(paused)
        if was and not self._reads_paused:
            self._last_seen_seq = None
            self._row_parse_state["stamps"].clear()
            self._row_parse_state["rows"].clear()
        elif not was and paused:
            self._row_parse_state["stamps"].clear()
            self._row_parse_state["rows"].clear()

    def reads_paused(self) -> bool:
        return self._reads_paused

    def set_full_parse_rate(self, full: bool) -> None:
        """True: sin tope Hz (grabación/alarmas). False: aplicar parse_max_hz."""
        self._full_parse_rate = bool(full)

    def set_parse_max_hz(self, hz: float | None) -> None:
        """Límite de read_snapshot/s si full_parse_rate es False; None = sin límite (ritmo del sem/polling)."""
        self._parse_max_hz = float(hz) if (hz is not None and hz > 0) else None

    def set_sidecar_sem_pump_only(self, on: bool, interval_sec: float = 0.2) -> None:
        """True: no leer SHM; solo espaciar tiempo y sem_trywait el sem principal (posts del C++)."""
        self._sidecar_sem_pump_only = bool(on)
        self._sidecar_sem_pump_interval = max(0.05, float(interval_sec))

    def _enqueue_snapshot(self, snapshot) -> None:
        """FIFO: encola cada snapshot parseado. Si la cola tiene maxsize, put() bloquea (backpressure al hilo lector)."""
        self.queue.put(snapshot)

    def start(self) -> bool:
        """Abre SHM (y sem si es posible), arranca hilo. False solo si SHM no se pudo abrir. Ver last_error."""
        self._last_error = None
        # RW: avanzar read_idx en filas anillo v2 sin segundo mmap.
        fd, buf = _open_shm(self.shm_name, write=True)
        if fd is None or buf is None:
            path = f"/dev/shm/{self.shm_name}"
            try:
                exists = os.path.exists(path)
            except OSError:
                exists = False
            if not exists:
                self._last_error = f"segmento SHM no existe: {path} (¿proceso C++ con SHM iniciado y mismo usuario?)"
            else:
                self._last_error = f"no se pudo abrir o mapear {path} (tamaño o permisos)"
            return False
        sem_handle, sem_err = _open_sem(self.sem_name)
        if sem_handle is None:
            self._polling_only = True
            self._last_error = f"semáforo no disponible ({sem_err or 'desconocido'}), usando modo polling"
        else:
            self._sem_handle = sem_handle
        self._fd = fd
        self._buf = buf
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return True

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._buf:
            try:
                self._buf.close()
            except Exception:
                pass
            self._buf = None
        if self._fd is not None:
            try:
                os.close(self._fd)
            except Exception:
                pass
            self._fd = None
        if self._sem_handle:
            libc, sem = self._sem_handle
            _sem_close(libc, sem)
            self._sem_handle = None

    def _process_shm_wake(self, buf: mmap.mmap) -> None:
        """Tras drenar el semáforo: sincronizar anillos v2, leer snapshot, avisar retraso/pérdida."""
        try:
            ring_loss = sync_v2_ring_read_idx(buf, self._max_vars)
            if ring_loss:
                _shm_trace_loss(
                    "buffer anillo SHM desbordado (write_idx - read_idx > capacidad); "
                    "muestras intermedias perdidas; posible jittering en variables en modo anillo.",
                    "ring_overflow",
                    self._rate_limit_until,
                    self._loss_interval_sec,
                )
            buf.seek(0)
            snapshot = read_snapshot(buf, self._max_vars, row_parse_state=self._row_parse_state)
            if snapshot is None:
                return
            seq = int(snapshot.get("seq", 0))
            prev = self._last_seen_seq
            # Con shm_parse_max_hz activo (solo monitorización) solo leemos un snapshot por intervalo:
            # el semáforo acumula varios ciclos del C++ a propósito → salto de seq esperado, no es “pérdida” anómala.
            parse_throttled = (
                not self._full_parse_rate
                and self._parse_max_hz is not None
                and self._parse_max_hz > 0
            )
            # Solo monitorización (full_parse_rate=False): la UI se queda con el último snapshot; drenar varios
            # sem_post y leer una vez implica saltos de seq normales — no avisar “retraso”.
            # Avisar solo en REC/alarmas (full_parse_rate=True), donde importa no perder ciclos en el lector Python.
            if (
                prev is not None
                and seq > prev + 1
                and not parse_throttled
                and self._full_parse_rate
            ):
                skipped = seq - prev - 1
                _shm_trace_warn(
                    f"lector retrasado: se perdieron {skipped} ciclo(s) SHM entre lecturas "
                    f"(seq {prev} → {seq}); el proceso C++ avanzó más rápido que este hilo.",
                    "seq_gap",
                    self._rate_limit_until,
                    self._warn_interval_sec,
                )
            elif prev is not None and seq < prev:
                self._last_seen_seq = None
            self._last_seen_seq = seq
            self._enqueue_snapshot(snapshot)
        except Exception:
            pass
        finally:
            self._last_parse_mono = time.monotonic()

    def _run(self):
        buf = self._buf
        if self._sem_handle is not None:
            libc, sem = self._sem_handle
            while not self._stop.is_set():
                if self._reads_paused:
                    got = _sem_wait(libc, sem, timeout_sec=1.0)
                    if self._stop.is_set():
                        break
                    if got:
                        while _sem_trywait(libc, sem):
                            pass
                    # Sin monitor activo no parseamos snapshot, pero sí mantenemos read_idx en anillos v2
                    # (C++ sigue publicando; si no avanzamos aquí, el anillo SHM desborda).
                    try:
                        sync_v2_ring_read_idx(buf, self._max_vars)
                    except Exception:
                        pass
                    continue
                if self._sidecar_sem_pump_only:
                    time.sleep(self._sidecar_sem_pump_interval)
                    while _sem_trywait(libc, sem):
                        pass
                    # Igual que en pausa: el C++ sigue publicando; sin sync el anillo v2 desborda.
                    try:
                        sync_v2_ring_read_idx(buf, self._max_vars)
                    except Exception:
                        pass
                    continue
                got = _sem_wait(libc, sem, timeout_sec=self.poll_interval)
                if self._stop.is_set():
                    break
                if not got:
                    continue
                # Drenar posts extra (un solo read_snapshot); no avisar aquí: con _last_seen_seq == None
                # es habitual tras conectar (lector en pausa mientras el C++ sigue en ciclo).
                while _sem_trywait(libc, sem):
                    pass
                if (
                    not self._full_parse_rate
                    and self._parse_max_hz is not None
                    and self._parse_max_hz > 0
                ):
                    min_iv = 1.0 / self._parse_max_hz
                    elapsed = time.monotonic() - self._last_parse_mono
                    if elapsed < min_iv:
                        time.sleep(min_iv - elapsed)
                        while _sem_trywait(libc, sem):
                            pass
                self._process_shm_wake(buf)
        else:
            last_seq: int | None = None
            # Alinear con el ciclo real del VarMonitor (mismo criterio que sample_interval_ms en C++).
            _ms = self._sample_interval_ms if self._sample_interval_ms is not None else 100
            poll_s = max(0.001, min(0.5, _ms / 1000.0))
            while not self._stop.is_set():
                if self._reads_paused:
                    try:
                        sync_v2_ring_read_idx(buf, self._max_vars)
                    except Exception:
                        pass
                    time.sleep(1.0)
                    continue
                if self._sidecar_sem_pump_only:
                    try:
                        sync_v2_ring_read_idx(buf, self._max_vars)
                    except Exception:
                        pass
                    time.sleep(self._sidecar_sem_pump_interval)
                    continue
                time.sleep(poll_s)
                if self._stop.is_set():
                    break
                try:
                    seq = peek_shm_seq(buf)
                    if seq is None or seq == last_seq:
                        continue
                    if (
                        not self._full_parse_rate
                        and self._parse_max_hz is not None
                        and self._parse_max_hz > 0
                    ):
                        min_iv = 1.0 / self._parse_max_hz
                        elapsed = time.monotonic() - self._last_parse_mono
                        if elapsed < min_iv:
                            time.sleep(min_iv - elapsed)
                    self._process_shm_wake(buf)
                    if self._last_seen_seq is not None:
                        last_seq = self._last_seen_seq
                except Exception:
                    pass
