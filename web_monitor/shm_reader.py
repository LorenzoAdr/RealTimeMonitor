"""Lector de SHM + semáforo POSIX para VarMonitor (fase 1). Solo Linux."""

import mmap
import os
import struct
import threading
from queue import Queue, Empty

# Layout C++: HEADER 32 bytes (magic, version, seq, count, padding, timestamp), ENTRY 137 (name[128], type, double)
# Debe coincidir con MAX_VARS en libvarmonitor/src/shm_publisher.cpp
MAX_VARS = 2048
MAGIC = 0x4D524156  # VARM little-endian
HEADER_SIZE = 4 + 4 + 8 + 4 + 4 + 8  # magic, version, seq, count, padding, timestamp = 32
NAME_MAX_LEN = 128
ENTRY_SIZE = NAME_MAX_LEN + 1 + 8  # name + type_byte + value double
# C++ escribe: 0 magic, 4 version, 8 seq, 16 count, 20-23 padding, 24 timestamp (32 total)
HEADER_FMT = "<IIQI"   # 0-20: magic, version, seq, count
TIMESTAMP_OFF = 24     # timestamp 8 bytes en 24

TYPE_STR = ["double", "int32", "bool", "string", "array"]


def _open_shm(shm_name: str):
    """Abre el segmento SHM en /dev/shm. Devuelve (fd, mmap) o (None, None)."""
    path = f"/dev/shm/{shm_name}"
    try:
        fd = os.open(path, os.O_RDONLY)
        size = os.path.getsize(path)
        if size < HEADER_SIZE:
            os.close(fd)
            return None, None
        buf = mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_READ)
        return fd, buf
    except (OSError, FileNotFoundError):
        return None, None


def _open_sem(sem_name: str) -> tuple[object | None, str | None]:
    """Abre semáforo POSIX existente. Devuelve (handle, None) o (None, mensaje_errno)."""
    try:
        import ctypes
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


def _sem_wait(libc, sem, timeout_sec: float | None = None):
    """Espera al semáforo. Si timeout_sec es None, espera indefinidamente. True si se obtuvo, False si timeout."""
    import ctypes
    import time
    sem_ptr = sem if isinstance(sem, ctypes.c_void_p) else ctypes.c_void_p(sem)
    if timeout_sec is None:
        libc.sem_wait(sem_ptr)
        return True
    class timespec(ctypes.Structure):
        _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]
    libc.sem_timedwait.argtypes = [ctypes.c_void_p, ctypes.POINTER(timespec)]
    # sem_timedwait espera tiempo ABSOLUTO (CLOCK_REALTIME), no relativo.
    deadline = time.time() + max(0.0, float(timeout_sec))
    tv_sec = int(deadline)
    tv_nsec = int((deadline - tv_sec) * 1_000_000_000)
    ts = timespec(tv_sec, tv_nsec)
    ret = libc.sem_timedwait(sem_ptr, ctypes.byref(ts))
    return ret == 0


def _sem_close(libc, sem):
    import ctypes
    sem_ptr = sem if isinstance(sem, ctypes.c_void_p) else ctypes.c_void_p(sem)
    libc.sem_close(sem_ptr)


def read_snapshot(buf: mmap.mmap, max_vars: int | None = None) -> dict | None:
    """Lee header + entradas del buffer SHM.

    Devuelve {"timestamp": <sec>, "data": [vars...]} o None si magic inválido.
    max_vars: límite de entradas a leer (por defecto MAX_VARS del módulo; debe coincidir con C++).
    """
    cap = max_vars if max_vars is not None else MAX_VARS
    if buf.size() < HEADER_SIZE:
        return None
    raw = buf.read(HEADER_SIZE)
    if len(raw) < HEADER_SIZE:
        return None
    magic, version, seq, count = struct.unpack(HEADER_FMT, raw[:20])
    if len(raw) >= TIMESTAMP_OFF + 8:
        timestamp, = struct.unpack("<d", raw[TIMESTAMP_OFF:TIMESTAMP_OFF + 8])
    else:
        timestamp = 0.0
    if magic != MAGIC:
        return None
    if count > cap:
        count = cap
    result = []
    for _ in range(count):
        if buf.tell() + ENTRY_SIZE > buf.size():
            break
        raw_ent = buf.read(ENTRY_SIZE)
        if len(raw_ent) < ENTRY_SIZE:
            break
        name_b = raw_ent[:NAME_MAX_LEN]
        type_byte = raw_ent[NAME_MAX_LEN]
        value, = struct.unpack_from("<d", raw_ent, NAME_MAX_LEN + 1)
        name = name_b.split(b"\x00")[0].decode("utf-8", errors="replace").strip()
        if not name:
            continue
        type_str = TYPE_STR[type_byte] if 0 <= type_byte < len(TYPE_STR) else "double"
        # Frontend espera value numérico o bool; para bool enviamos 0/1 como número o true/false
        if type_str == "bool":
            val_out = bool(int(value))
        elif type_str == "int32":
            val_out = int(value)
        else:
            val_out = value
        result.append({"name": name, "type": type_str, "value": val_out})
    return {"timestamp": float(timestamp), "data": result, "seq": seq}


class ShmReader:
    """Lee SHM en un hilo: sem_wait (o polling si el semáforo no abre) -> lee snapshot -> pone en queue."""

    def __init__(
        self,
        shm_name: str,
        sem_name: str,
        queue: Queue,
        poll_interval: float = 0.5,
        max_vars: int | None = None,
    ):
        self.shm_name = shm_name
        self.sem_name = sem_name
        self.queue = queue
        self.poll_interval = poll_interval
        self._max_vars = max_vars  # None = usar MAX_VARS del módulo (debe coincidir con C++)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._fd = None
        self._buf: mmap.mmap | None = None
        self._sem_handle = None
        self._last_error: str | None = None
        self._polling_only: bool = False

    def start(self) -> bool:
        """Abre SHM (y sem si es posible), arranca hilo. False solo si SHM no se pudo abrir. Ver last_error."""
        self._last_error = None
        fd, buf = _open_shm(self.shm_name)
        if fd is None or buf is None:
            path = f"/dev/shm/{self.shm_name}"
            try:
                exists = os.path.exists(path)
            except Exception:
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

    def _run(self):
        import time
        buf = self._buf
        if self._sem_handle is not None:
            libc, sem = self._sem_handle
            while not self._stop.is_set():
                got = _sem_wait(libc, sem, timeout_sec=self.poll_interval)
                if self._stop.is_set():
                    break
                if not got:
                    continue
                try:
                    buf.seek(0)
                    snapshot = read_snapshot(buf, self._max_vars)
                    if snapshot is not None:
                        self.queue.put(snapshot)
                except Exception:
                    pass
        else:
            last_seq: int | None = None
            poll_s = max(0.001, min(0.5, self.poll_interval))
            if poll_s > 0.01:
                poll_s = 0.005
            while not self._stop.is_set():
                time.sleep(poll_s)
                if self._stop.is_set():
                    break
                try:
                    buf.seek(0)
                    snapshot = read_snapshot(buf, self._max_vars)
                    if snapshot is not None:
                        seq = snapshot.get("seq")
                        if seq is not None and seq != last_seq:
                            last_seq = seq
                            self.queue.put(snapshot)
                except Exception:
                    pass
