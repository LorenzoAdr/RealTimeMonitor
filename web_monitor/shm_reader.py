"""Lector de SHM + semáforo POSIX para VarMonitor (fase 1). Solo Linux."""

import mmap
import os
import struct
import threading
from queue import Queue, Empty

# Layout C++: HEADER 28 bytes (magic, version, seq, count, timestamp), ENTRY 137 (name[128], type, double)
MAGIC = 0x4D524156  # VARM little-endian
HEADER_SIZE = 4 + 4 + 8 + 4 + 8  # magic, version, seq, count, timestamp
NAME_MAX_LEN = 128
ENTRY_SIZE = NAME_MAX_LEN + 1 + 8  # name + type_byte + value double
# C++ escribe: 0 magic, 4 version, 8 seq, 16 count, 24 timestamp (28 total)
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


def _open_sem(sem_name: str):
    """Abre semáforo POSIX existente. Devuelve handle (ctypes) o None."""
    try:
        import ctypes
        libc = ctypes.CDLL("libc.so.6")
        # En 64 bits el puntero debe ser c_void_p; si restype es int se trunca y sem_wait segfaulta
        libc.sem_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
        libc.sem_open.restype = ctypes.c_void_p
        libc.sem_wait.argtypes = [ctypes.c_void_p]
        libc.sem_close.argtypes = [ctypes.c_void_p]
        SEM_O = 0
        sem = libc.sem_open(sem_name.encode(), SEM_O)
        # SEM_FAILED = (void*)-1; c_void_p(-1).value es 2^64-1 en 64 bits
        if sem is None:
            return None
        v = getattr(sem, "value", None)
        if v is None or v == ctypes.c_void_p(-1).value:
            return None
        return (libc, sem)
    except Exception:
        return None


def _sem_wait(libc, sem, timeout_sec: float | None = None):
    """Espera al semáforo. Si timeout_sec es None, espera indefinidamente. True si se obtuvo, False si timeout."""
    import ctypes
    sem_ptr = sem if isinstance(sem, ctypes.c_void_p) else ctypes.c_void_p(sem)
    if timeout_sec is None:
        libc.sem_wait(sem_ptr)
        return True
    class timespec(ctypes.Structure):
        _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]
    libc.sem_timedwait.argtypes = [ctypes.c_void_p, ctypes.POINTER(timespec)]
    ts = timespec(int(timeout_sec), int((timeout_sec % 1) * 1_000_000_000))
    ret = libc.sem_timedwait(sem_ptr, ctypes.byref(ts))
    return ret == 0


def _sem_close(libc, sem):
    import ctypes
    sem_ptr = sem if isinstance(sem, ctypes.c_void_p) else ctypes.c_void_p(sem)
    libc.sem_close(sem_ptr)


def read_snapshot(buf: mmap.mmap) -> list[dict] | None:
    """Lee header + entradas del buffer SHM. Devuelve lista de dicts {name, type, value} o None si magic inválido."""
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
    if count > 512:
        count = 512
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
    return result


class ShmReader:
    """Lee SHM en un hilo: sem_wait -> lee snapshot -> pone en queue. Para cuando el proceso C++ cierra SHM."""

    def __init__(self, shm_name: str, sem_name: str, queue: Queue, poll_interval: float = 0.5):
        self.shm_name = shm_name
        self.sem_name = sem_name
        self.queue = queue
        self.poll_interval = poll_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._fd = None
        self._buf: mmap.mmap | None = None
        self._sem_handle = None

    def start(self) -> bool:
        """Abre SHM y sem, arranca hilo. False si no se pudo abrir."""
        fd, buf = _open_shm(self.shm_name)
        if fd is None or buf is None:
            return False
        sem_handle = _open_sem(self.sem_name)
        if sem_handle is None:
            try:
                buf.close()
                os.close(fd)
            except Exception:
                pass
            return False
        self._fd = fd
        self._buf = buf
        self._sem_handle = sem_handle
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
        libc, sem = self._sem_handle
        buf = self._buf
        while not self._stop.is_set():
            got = _sem_wait(libc, sem, timeout_sec=self.poll_interval)
            if self._stop.is_set():
                break
            if not got:
                continue
            try:
                buf.seek(0)
                snapshot = read_snapshot(buf)
                if snapshot is not None:
                    self.queue.put(snapshot)
            except Exception:
                pass
