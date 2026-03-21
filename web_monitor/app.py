"""FastAPI backend for VarMonitor web interface."""

import asyncio
import collections
import getpass
import logging
import json
import os
import resource
import socket
import sys
import time
import urllib.request
import math
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, HTMLResponse

import threading
from queue import Empty, Queue

from uds_client import UdsBridge
from shm_reader import ShmReader

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

DEFAULTS = {
    "web_port": 8080,
    "web_port_scan_max": 10,
    "lan_ip": "",
    "bind_host": "",
    "auth_password": "",
    "cycle_interval_ms": 100,
    "update_ratio_max": 100,
    "server_state_dir": "",
    "log_buffer_size": 5000,
    "log_file_cpp": "",
    "shm_max_vars": 2048,
    # Máx. parseos SHM/s solo monitorizando (0 = sin tope). Con REC o alarmas no se aplica tope.
    "shm_parse_max_hz": 40,
    # Snapshots en cola reader→drain (0 = ilimitada; >0 = FIFO acotada, put bloquea si llena = backpressure).
    "shm_queue_max_size": 512,
}

CONFIG_ABS_PATH = ""


def load_config() -> dict:
    """Read varmon.conf (key = value). No external dependencies."""
    global CONFIG_ABS_PATH
    cfg = dict(DEFAULTS)
    path = os.environ.get("VARMON_CONFIG")
    if not path:
        # Probar cwd y luego directorio del proyecto (parent del script)
        for candidate in ("varmon.conf", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "varmon.conf")):
            abs_candidate = os.path.abspath(candidate)
            if os.path.isfile(abs_candidate):
                path = abs_candidate
                break
        else:
            path = "varmon.conf"
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key, val = key.strip(), val.strip()
                if key in ("web_port", "web_port_scan_max", "cycle_interval_ms", "update_ratio_max"):
                    cfg[key] = int(val)
                elif key == "log_buffer_size":
                    cfg[key] = max(100, min(50000, int(val)))
                elif key == "shm_max_vars":
                    cfg[key] = max(64, min(100000, int(val)))
                elif key == "shm_parse_max_hz":
                    cfg[key] = max(0.0, min(5000.0, float(val)))
                elif key == "shm_queue_max_size":
                    cfg[key] = max(0, min(100000, int(val)))
                elif key in ("lan_ip", "bind_host", "auth_password", "server_state_dir", "log_file_cpp"):
                    cfg[key] = val
        CONFIG_ABS_PATH = os.path.abspath(path)
        print(f"[VarMonitor Web] Config cargada desde {CONFIG_ABS_PATH}")
        if (cfg.get("auth_password") or "").strip():
            print(f"[VarMonitor Web] Auth: activada (se requiere contraseña en el WebSocket)")
        else:
            print(f"[VarMonitor Web] Auth: desactivada")
    except FileNotFoundError:
        CONFIG_ABS_PATH = os.path.abspath(path)
        print(f"[VarMonitor Web] AVISO: No se encontro el archivo de configuracion.")
        print(f"  Buscado en: {os.path.abspath(path)}")
        print(f"  Usando valores por defecto (web_port={cfg['web_port']})")
        print(f"  Para cambiar la ruta:")
        print(f"    - Variable de entorno: VARMON_CONFIG=/ruta/a/varmon.conf")
        print(f"    - Colocar varmon.conf en el directorio de trabajo actual")
    return cfg


_config = load_config()

# --- Buffer de log para visor integrado ---
_LOG_BUFFER_LOCK = threading.Lock()
_LOG_SEQ = 0  # contador monotónico por línea (para GET /api/log?since_seq=…)
_LOG_BUFFER: collections.deque = collections.deque(
    maxlen=max(100, min(50000, int(_config.get("log_buffer_size", 5000)))),
)


class _LogTee:
    """Escribe en el stream original y duplica cada línea (con timestamp) al buffer de log."""
    def __init__(self, stream):
        self._stream = stream
        self._linebuf: list[str] = []

    def write(self, data: str):
        self._stream.write(data)
        with _LOG_BUFFER_LOCK:
            for ch in data:
                if ch == "\n" or ch == "\r":
                    if self._linebuf:
                        line = "".join(self._linebuf).strip()
                        if line:
                            global _LOG_SEQ
                            _LOG_SEQ += 1
                            _LOG_BUFFER.append({
                                "seq": _LOG_SEQ,
                                "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
                                "level": "info",
                                "msg": line,
                            })
                        self._linebuf.clear()
                else:
                    self._linebuf.append(ch)
        return len(data)

    def flush(self):
        self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


_ORIGINAL_STDOUT = sys.stdout
sys.stdout = _LogTee(_ORIGINAL_STDOUT)

# Numero de conexiones WebSocket activas
ACTIVE_WS = 0

# Intentos fallidos de contraseña; tras MAX_FAILED_AUTH el proceso se cierra
MAX_FAILED_AUTH = 3
FAILED_AUTH_ATTEMPTS = 0


# Tiempo sin C++ ni clientes tras el cual se cierra el proceso (segundos)
WATCHDOG_IDLE_SEC = 300  # 5 minutos

async def _watchdog_no_cpp():
    """Cierra el proceso si durante WATCHDOG_IDLE_SEC no hay C++ (UDS) accesible ni clientes activos."""
    global ACTIVE_WS
    last_ok = time.monotonic()
    while True:
        await asyncio.sleep(5.0)
        if ACTIVE_WS > 0:
            try:
                inst = await asyncio.to_thread(_list_uds_instances, None)
                if inst:
                    b = await asyncio.to_thread(UdsBridge, inst[0]["uds_path"], 0.5)
                    # get_server_info basta para comprobar C++; list_names alocaría miles de strings cada 5 s (RSS).
                    _ = await asyncio.to_thread(b.get_server_info)
                    b.disconnect()
                    last_ok = time.monotonic()
            except Exception:
                pass
            continue
        try:
            inst = await asyncio.to_thread(_list_uds_instances, None)
            if inst:
                b = await asyncio.to_thread(UdsBridge, inst[0]["uds_path"], 0.5)
                _ = await asyncio.to_thread(b.get_server_info)
                b.disconnect()
                last_ok = time.monotonic()
        except Exception:
            pass
        if time.monotonic() - last_ok > WATCHDOG_IDLE_SEC and ACTIVE_WS == 0:
            print(f"[VarMonitor Web] No se detecto ningun servidor C++ (UDS) durante {WATCHDOG_IDLE_SEC}s y no hay clientes activos. Cerrando proceso.")
            os._exit(0)


def _scan_web_ports_max(base_port: int, max_offset: int = 10, timeout: float = 0.2) -> int | None:
    """Prueba conexión TCP a puertos web en [base_port, base_port+max_offset]; devuelve el mayor en uso."""
    in_use = _scan_web_ports_list(base_port, max_offset, timeout)
    return max(in_use) if in_use else None


def _scan_web_ports_list(base_port: int, max_offset: int = 10, timeout: float = 0.2) -> list[int]:
    """Devuelve la lista de puertos web en uso en el rango [base_port, base_port+max_offset]."""
    in_use: list[int] = []
    for offset in range(max_offset + 1):
        port = base_port + offset
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                s.connect(("127.0.0.1", port))
            in_use.append(port)
        except OSError:
            continue
    return in_use


def _fetch_uptime_from_port(port: int, timeout: float = 1.0) -> float | None:
    """Obtiene uptime_seconds de otro backend VarMonitor vía GET /api/uptime (ligero, sin escaneos). None si falla."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/uptime")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
            return data.get("uptime_seconds")
    except Exception:
        return None


def _fetch_instance_info_from_web_port(web_port: int, timeout: float = 0.4) -> dict | None:
    """Obtiene cpp_port y user de otro backend vía GET /api/instance_info. None si falla."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{web_port}/api/instance_info")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


# Cache para suggested_web_port (puerto con menor uptime): (valor, timestamp)
_suggested_web_port_cache: tuple[int | None, float] | None = None
SUGGESTED_WEB_PORT_CACHE_TTL = 20.0  # segundos


def _get_suggested_web_port(
    actual_port: int,
    base_web: int,
    own_uptime: float | None,
) -> int | None:
    """Devuelve el puerto web que probablemente es del usuario actual: el de menor tiempo de vida (más reciente)."""
    global _suggested_web_port_cache
    now = time.monotonic()
    if _suggested_web_port_cache is not None:
        cached_val, cached_at = _suggested_web_port_cache
        if now - cached_at < SUGGESTED_WEB_PORT_CACHE_TTL:
            return cached_val
    ports_in_use = _scan_web_ports_list(base_web, int(_config.get("web_port_scan_max", 10)))
    if not ports_in_use:
        _suggested_web_port_cache = (actual_port, now)
        return actual_port
    # Recoger uptime de cada puerto (el nuestro sin HTTP, el resto vía GET)
    uptimes: list[tuple[int, float]] = []
    for port in ports_in_use:
        if port == actual_port and own_uptime is not None:
            uptimes.append((port, own_uptime))
        else:
            u = _fetch_uptime_from_port(port)
            if u is not None:
                uptimes.append((port, u))
    if not uptimes:
        _suggested_web_port_cache = (actual_port, now)
        return actual_port
    # El de menor uptime (más reciente) es el sugerido; desempate por puerto mayor
    best = min(uptimes, key=lambda x: (x[1], -x[0]))
    suggested = best[0]
    _suggested_web_port_cache = (suggested, now)
    return suggested


async def _memtrace_log_loop():
    """Si VARMON_MEMTRACE=1: imprime cada 30s las líneas con más RAM propia (tracemalloc)."""
    import tracemalloc
    await asyncio.sleep(20.0)
    while True:
        await asyncio.sleep(30.0)
        snap = tracemalloc.take_snapshot()
        lines = snap.statistics("lineno")[:15]
        print("[VarMonitor Web] MEMTRACE top asignaciones (tracemalloc):", flush=True)
        for s in lines:
            print(f"  {s}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not hasattr(app.state, "startup_time"):
        app.state.startup_time = time.monotonic()
    if not hasattr(app.state, "shm_cycle_ms"):
        app.state.shm_cycle_ms = None
    if not hasattr(app.state, "ws_monitored_counts"):
        # id(WebSocket) -> len(monitored_names); para /api/advanced_stats y varmon.telemetry.*
        app.state.ws_monitored_counts = {}
    asyncio.create_task(_watchdog_no_cpp())
    _mt = (os.environ.get("VARMON_MEMTRACE") or "").strip().lower()
    if _mt in ("1", "true", "yes", "on"):
        import tracemalloc
        tracemalloc.start(25)
        print("[VarMonitor Web] MEMTRACE activo (VARMON_MEMTRACE=1); tracemalloc cada ~30s en log.", flush=True)
        asyncio.create_task(_memtrace_log_loop())
    yield


app = FastAPI(title="VarMonitor", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


@app.middleware("http")
async def log_requests_middleware(request: Request, call_next):
    """Registra cada petición HTTP en el buffer de log (visible en el visor integrado)."""
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    path = getattr(request.url, "path", "") or ""
    # Evita bucle de ruido y picos de RAM: el visor hace polling frecuente a /api/log.
    if path != "/api/log":
        query = getattr(request.url, "query", "") or ""
        if query:
            path_display = path + "?" + (query if len(query) <= 100 else query[:100] + "...")
        else:
            path_display = path
        status = getattr(response, "status_code", 0)
        print(f"[Req] {request.method} {path_display} -> {status} ({elapsed_ms:.0f}ms)")
    return response


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/vars")
async def api_list_vars(request: Request):
    try:
        b = await asyncio.to_thread(_first_uds_bridge)
        if b is None:
            return JSONResponse({"error": "No hay instancias VarMonitor (UDS)"}, status_code=503)
        data = await asyncio.to_thread(b.list_vars)
        b.disconnect()
        extra = _telemetry_snapshot_rows(set(VARMON_TELEMETRY_NAMES), request.app.state)
        if isinstance(data, list):
            return JSONResponse(data + extra)
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/var/{name:path}")
async def api_get_var(name: str, request: Request):
    if name in VARMON_TELEMETRY_NAME_SET:
        rows = _telemetry_snapshot_rows({name}, request.app.state)
        if rows:
            return JSONResponse(rows[0])
        return JSONResponse({"error": "telemetría no disponible"}, status_code=404)
    try:
        b = await asyncio.to_thread(_first_uds_bridge)
        if b is None:
            return JSONResponse({"error": "No hay instancias VarMonitor (UDS)"}, status_code=503)
        result = await asyncio.to_thread(b.get_var, name)
        b.disconnect()
        if result is None:
            return JSONResponse({"error": "Variable no encontrada"}, status_code=404)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/var/{name:path}")
async def api_set_var(name: str, value: float = Query(...), var_type: str = Query("double")):
    if name in VARMON_TELEMETRY_NAME_SET:
        return JSONResponse({"success": False})
    try:
        b = await asyncio.to_thread(_first_uds_bridge)
        if b is None:
            return JSONResponse({"error": "No hay instancias VarMonitor (UDS)"}, status_code=503)
        ok = await asyncio.to_thread(b.set_var, name, value, var_type)
        b.disconnect()
        return JSONResponse({"success": ok})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/history/{name:path}")
async def api_get_history(name: str):
    """Ruta legacy eliminada: el historial se construye solo desde SHM/TSV."""
    return JSONResponse(
        {"error": "Historial en vivo no disponible; use grabaciones TSV."},
        status_code=410,
    )


def _list_uds_instances(user_filter: str | None) -> list[dict]:
    """Lista instancias VarMonitor por UDS en /tmp (varmon-*.sock). Orden: más reciente primero (por mtime del socket)."""
    import glob
    candidates: list[tuple[float, dict]] = []
    try:
        pattern = f"/tmp/varmon-{user_filter}-*.sock" if user_filter else "/tmp/varmon-*.sock"
        paths = glob.glob(pattern)
        for path in paths:
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = 0.0
            try:
                b = UdsBridge(path, timeout=0.6)
                info = b.get_server_info()
                b.disconnect()
            except Exception:
                continue
            if not info:
                continue
            name = path.rsplit("/", 1)[-1].replace(".sock", "")
            parts = name.split("-", 2)  # varmon, user, pid
            pid = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else None
            candidates.append((mtime, {
                "uds_path": path,
                "pid": pid,
                "uptime_seconds": info.get("uptime_seconds"),
                "user": parts[1] if len(parts) >= 2 else None,
            }))
        # Más reciente primero (mtime descendente)
        candidates.sort(key=lambda x: -x[0])
        return [d for _, d in candidates]
    except Exception:
        pass
    return []


def _first_uds_bridge():
    """Primera instancia UDS disponible. None si no hay ninguna."""
    inst = _list_uds_instances(None)
    if not inst:
        return None
    try:
        return UdsBridge(inst[0]["uds_path"], timeout=3.0)
    except Exception:
        return None


# Directorio para grabaciones (backend)
RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")
STATE_ROOT_DIR = (_config.get("server_state_dir") or "").strip() or os.path.join(os.path.dirname(os.path.abspath(__file__)), "server_state")
# Raíz del navegador de archivos remoto = directorio principal del proyecto (contiene web_monitor/)
BROWSER_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = os.path.join(STATE_ROOT_DIR, "templates")
SESSIONS_DIR = os.path.join(STATE_ROOT_DIR, "sessions")
ALARM_BUFFER_SEC = 2.2  # ~1 s previos + ~1 s posteriores al contexto de disparo (TSV con snapshot completo)
ALARM_UDS_POLL_SEC = 0.2  # Sin monitor pero con alarmas: get_var solo sobre nombres en alarma (evita snapshots SHM masivos)

# Variables sintéticas (solo backend / UI); no existen en C++. Aparecen en el catálogo y en vars_update si están monitorizadas.
VARMON_TELEMETRY_NAMES: tuple[str, ...] = (
    "varmon.telemetry.python_ram_mb",
    "varmon.telemetry.python_cpu_percent",
    "varmon.telemetry.cpp_ram_mb",
    "varmon.telemetry.cpp_cpu_percent",
    "varmon.telemetry.shm_cycle_ms",
    "varmon.telemetry.browser_js_heap_mb",
    "varmon.telemetry.ws_monitored_count",
)
VARMON_TELEMETRY_NAME_SET: frozenset[str] = frozenset(VARMON_TELEMETRY_NAMES)


def _ws_monitored_count_aggregate(state) -> int:
    """Máximo de |monitored_names| entre WebSockets activos (una pestaña → número exacto)."""
    counts = getattr(state, "ws_monitored_counts", None)
    if not isinstance(counts, dict) or not counts:
        return 0
    return int(max(counts.values()))


def _merge_names_with_telemetry(names_list: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for n in names_list:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    for n in VARMON_TELEMETRY_NAMES:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _telemetry_float(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, (int, float)) and math.isfinite(float(v)):
        return float(v)
    return 0.0


def _telemetry_snapshot_rows(monitored: set[str], app_state) -> list[dict]:
    """Filas compatibles con vars_update para nombres varmon.telemetry.*."""
    need = monitored & VARMON_TELEMETRY_NAME_SET
    if not need:
        return []
    t_snap = time.time()
    py_r = _get_process_ram_mb()
    py_c = _get_python_cpu_percent(app_state)
    now_m = time.monotonic()
    if now_m - getattr(app_state, "varmon_telemetry_cpp_at", 0.0) >= 1.0:
        cpp_ram, cpp_cpu, shm_hint, shm_active = _fetch_cpp_stats_sync()
        app_state.varmon_telemetry_cpp_at = now_m
        app_state.varmon_telemetry_cpp_ram = cpp_ram
        app_state.varmon_telemetry_cpp_cpu = cpp_cpu
        app_state.varmon_telemetry_shm_hint = shm_hint
        app_state.varmon_telemetry_shm_active = shm_active
    else:
        cpp_ram = getattr(app_state, "varmon_telemetry_cpp_ram", None)
        cpp_cpu = getattr(app_state, "varmon_telemetry_cpp_cpu", None)
        shm_hint = getattr(app_state, "varmon_telemetry_shm_hint", None)
        shm_active = bool(getattr(app_state, "varmon_telemetry_shm_active", False))

    shm_ms = getattr(app_state, "shm_cycle_ms", None)
    if isinstance(shm_ms, (int, float)):
        shm_ms = float(shm_ms)
    elif isinstance(shm_hint, (int, float)):
        shm_ms = float(shm_hint)
    elif shm_active:
        try:
            shm_ms = float(_config.get("cycle_interval_ms", 100))
        except Exception:
            shm_ms = 0.0
    else:
        shm_ms = 0.0

    def row(name: str, val: float) -> dict:
        return {"name": name, "type": "double", "value": val, "timestamp": t_snap}

    out: list[dict] = []
    for n in VARMON_TELEMETRY_NAMES:
        if n not in need:
            continue
        if n == "varmon.telemetry.python_ram_mb":
            out.append(row(n, _telemetry_float(py_r)))
        elif n == "varmon.telemetry.python_cpu_percent":
            out.append(row(n, _telemetry_float(py_c)))
        elif n == "varmon.telemetry.cpp_ram_mb":
            out.append(row(n, _telemetry_float(cpp_ram)))
        elif n == "varmon.telemetry.cpp_cpu_percent":
            out.append(row(n, _telemetry_float(cpp_cpu)))
        elif n == "varmon.telemetry.shm_cycle_ms":
            out.append(row(n, _telemetry_float(shm_ms)))
        elif n == "varmon.telemetry.ws_monitored_count":
            out.append(row(n, float(_ws_monitored_count_aggregate(app_state))))
        else:
            out.append(row(n, 0.0))
    return out


def _var_update_signature(entry: dict) -> tuple:
    """Firma (tipo, valor) para comparar snapshots sin serializar JSON completo."""
    typ = entry.get("type") or "double"
    val = entry.get("value")
    if typ == "double":
        if isinstance(val, bool):
            return (typ, 1.0 if val else 0.0)
        if isinstance(val, int):
            return (typ, float(val))
        if isinstance(val, float):
            return (typ, val)
        try:
            return (typ, float(val))
        except (TypeError, ValueError):
            return (typ, val)
    return (typ, val)


def _var_signature_equal(a: tuple, b: tuple) -> bool:
    if a[0] != b[0]:
        return False
    va, vb = a[1], b[1]
    if va == vb:
        return True
    if isinstance(va, float) and isinstance(vb, float):
        return math.isclose(va, vb, rel_tol=0.0, abs_tol=1e-9)
    return False


def _prune_vars_update_sig_cache(cache: dict[str, tuple], allowed_shm_names: set[str]) -> None:
    for k in list(cache.keys()):
        if k not in allowed_shm_names:
            del cache[k]


def _merge_shm_and_telemetry_vars_updates(
    latest_snapshot: list[dict] | None,
    name_set: set[str],
    app_state,
    sig_cache: dict[str, tuple],
    force_full: bool,
) -> tuple[list[dict], bool]:
    """
    vars_update en delta para variables SHM (evita JSON gigante con miles de vars estables).
    La telemetría (pocas filas) se anexa siempre si está monitorizada.
    """
    telemetry_rows = _telemetry_snapshot_rows(name_set, app_state)
    shm_only = {n for n in name_set if n not in VARMON_TELEMETRY_NAME_SET}
    _prune_vars_update_sig_cache(sig_cache, shm_only)
    cand = [v for v in (latest_snapshot or []) if (v.get("name") or "") in shm_only]

    if force_full or not sig_cache:
        for v in cand:
            n = v.get("name")
            if n:
                sig_cache[n] = _var_update_signature(v)
        out = cand + telemetry_rows
        return out, len(out) > 0

    shm_out: list[dict] = []
    for v in cand:
        n = v.get("name")
        if not n:
            continue
        sig = _var_update_signature(v)
        old = sig_cache.get(n)
        if old is None or not _var_signature_equal(old, sig):
            shm_out.append(v)
            sig_cache[n] = sig
    out = shm_out + telemetry_rows
    return out, len(out) > 0


# Índice ligero de tiempos por grabación TSV: path -> [(time_s, byte_offset), ...]
_TIME_INDEX: dict[str, list[tuple[float, int]]] = {}
_TIME_INDEX_LOCK = threading.Lock()


def _ensure_recordings_dir():
    os.makedirs(RECORDINGS_DIR, exist_ok=True)


def _ensure_state_dirs():
    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    os.makedirs(SESSIONS_DIR, exist_ok=True)


def _safe_json_name(name: str) -> str | None:
    safe = os.path.basename((name or "").strip())
    if not safe:
        return None
    safe = safe.replace(".json", "")
    if not safe:
        return None
    return safe


def _json_path(base_dir: str, name: str) -> str | None:
    safe = _safe_json_name(name)
    if not safe:
        return None
    path = os.path.abspath(os.path.join(base_dir, safe + ".json"))
    root = os.path.abspath(base_dir)
    if not path.startswith(root + os.sep):
        return None
    return path


def _save_runtime_config_overrides(updates: dict) -> None:
    """Persist selected runtime config keys into varmon.conf."""
    allowed = {"web_port", "web_port_scan_max", "server_state_dir"}
    clean = {k: updates[k] for k in updates.keys() if k in allowed}
    if not clean:
        return
    path = CONFIG_ABS_PATH or os.path.abspath("varmon.conf")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines: list[str] = []
    existing: dict[str, str] = {}
    if os.path.isfile(path):
        with open(path, "r") as f:
            lines = f.read().splitlines()
        for ln in lines:
            s = ln.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            existing[k.strip()] = v.strip()
    for k, v in clean.items():
        existing[k] = str(v)
    output: list[str] = []
    seen: set[str] = set()
    for ln in lines:
        s = ln.strip()
        if "=" not in s or s.startswith("#"):
            output.append(ln)
            continue
        k = s.split("=", 1)[0].strip()
        if k in existing:
            output.append(f"{k} = {existing[k]}")
            seen.add(k)
        else:
            output.append(ln)
    for k, v in existing.items():
        if k not in seen:
            output.append(f"{k} = {v}")
    with open(path, "w") as f:
        f.write("\n".join(output).rstrip() + "\n")


def _write_snapshots_tsv(filepath: str, snapshots: list[tuple[float, list[dict]]], var_names: list[str] | None = None) -> None:
    """Escribe snapshots a TSV (tabuladores). Arrays expandidos en columnas: name_0, name_1, ..."""
    if not snapshots:
        return
    t0 = float(snapshots[0][0])
    if var_names is None:
        names_set = set()
        for _, data in snapshots:
            for e in data:
                names_set.add(e["name"])
        var_names = sorted(names_set)
    # Para cada variable: si en algún snapshot es lista, columnas name_0, name_1, ... (max len)
    col_spec: list[tuple[str, int]] = []  # (name, size): size 1 = escalar, >1 = array con size columnas
    for name in var_names:
        max_len = 1
        for _, data in snapshots:
            for e in data:
                if e["name"] != name:
                    continue
                v = e.get("value")
                if isinstance(v, (list, tuple)):
                    max_len = max(max_len, len(v))
                break
        col_spec.append((name, max_len))
    # Cabecera: time_s \t col1 \t col2 \t ... (arrays: name_0, name_1, ...)
    header_parts = ["time_s"]
    for name, size in col_spec:
        if size <= 1:
            header_parts.append(name)
        else:
            header_parts.extend(f"{name}_{i}" for i in range(size))
    with open(filepath, "w") as f:
        f.write("\t".join(header_parts) + "\n")
        for t, data in snapshots:
            name_to_val = {e["name"]: e.get("value", "") for e in data}
            t_rel = max(0.0, float(t) - t0)
            row_parts = [f"{t_rel:.6f}"]
            for name, size in col_spec:
                v = name_to_val.get(name, "")
                if size <= 1:
                    row_parts.append(str(v))
                else:
                    if isinstance(v, (list, tuple)):
                        for i in range(size):
                            row_parts.append(str(v[i]) if i < len(v) else "")
                    else:
                        row_parts.extend([str(v)] + [""] * (size - 1))
            f.write("\t".join(row_parts) + "\n")


def _estimate_record_header_bytes(var_names: list[str], snapshot: list[dict] | None = None) -> int:
    """Estimación de bytes de cabecera TSV para progreso de grabación."""
    snap_map = {e.get("name"): e.get("value") for e in (snapshot or []) if isinstance(e, dict)}
    parts = ["time_s"]
    for name in var_names:
        v = snap_map.get(name)
        if isinstance(v, (list, tuple)) and len(v) > 1:
            parts.extend(f"{name}_{i}" for i in range(len(v)))
        else:
            parts.append(name)
    return len(("\t".join(parts) + "\n").encode("utf-8", errors="ignore"))


def _estimate_record_row_bytes(t_snap: float, snapshot: list[dict], var_names: list[str]) -> int:
    """Estimación de bytes de una fila TSV (aprox) para mostrar tamaño en vivo."""
    name_to_val = {e.get("name"): e.get("value", "") for e in snapshot if isinstance(e, dict)}
    row_parts = [f"{t_snap:.6f}"]
    for name in var_names:
        v = name_to_val.get(name, "")
        if isinstance(v, (list, tuple)):
            if len(v) <= 1:
                row_parts.append(str(v[0]) if len(v) == 1 else "")
            else:
                for item in v:
                    row_parts.append(str(item))
        else:
            row_parts.append(str(v))
    return len(("\t".join(row_parts) + "\n").encode("utf-8", errors="ignore"))


def _flush_record_buffer_to_tsv(
    record_buffer: list[tuple[float, list[dict]]],
    recording_var_names: list[str] | None,
) -> tuple[str, str, int]:
    """Vuelca el buffer de grabación a TSV y devuelve (path, filename, size_bytes)."""
    if not record_buffer:
        return "", "", 0
    _ensure_recordings_dir()
    from datetime import datetime
    fn_saved = f"record_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tsv"
    path_saved = os.path.join(RECORDINGS_DIR, fn_saved)
    var_names = recording_var_names or sorted(set(e["name"] for _, data in record_buffer for e in data))
    _write_snapshots_tsv(path_saved, record_buffer, var_names)
    try:
        size_bytes = int(os.path.getsize(path_saved))
    except Exception:
        size_bytes = 0
    return path_saved, fn_saved, size_bytes


def _record_row_layout(col_spec: list[tuple[str, int]]) -> tuple[dict[str, tuple[int, int]], int]:
    """Nombre → (offset, celdas) en la fila TSV de valores; evita dict nombre→valor de todo el snapshot por muestra."""
    layout: dict[str, tuple[int, int]] = {}
    off = 0
    for name, size in col_spec:
        sz = max(1, int(size))
        layout[name] = (off, sz)
        off += sz
    return layout, off


def _build_record_col_spec(var_names: list[str], snapshot: list[dict]) -> list[tuple[str, int]]:
    """Construye especificación de columnas para grabación incremental."""
    snap_map = {e.get("name"): e.get("value") for e in snapshot if isinstance(e, dict)}
    spec: list[tuple[str, int]] = []
    for name in var_names:
        v = snap_map.get(name)
        if isinstance(v, (list, tuple)) and len(v) > 1:
            spec.append((name, len(v)))
        else:
            spec.append((name, 1))
    return spec


def _write_record_header_stream(f, col_spec: list[tuple[str, int]]) -> int:
    parts = ["time_s"]
    for name, size in col_spec:
        if size <= 1:
            parts.append(name)
        else:
            parts.extend(f"{name}_{i}" for i in range(size))
    line = "\t".join(parts) + "\n"
    f.write(line)
    return len(line.encode("utf-8", errors="ignore"))


def _write_record_row_stream(
    f,
    t_snap: float,
    snapshot: list[dict],
    col_spec: list[tuple[str, int]],
    row_layout: tuple[dict[str, tuple[int, int]], int] | None = None,
) -> int:
    if row_layout is None:
        row_layout = _record_row_layout(col_spec)
    layout, nvals = row_layout
    vals = [""] * nvals
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
                vals[off] = str(v[0]) if len(v) >= 1 else ""
            else:
                vals[off] = str(v)
        else:
            if isinstance(v, (list, tuple)):
                for i in range(size):
                    vals[off + i] = str(v[i]) if i < len(v) else ""
            else:
                vals[off] = str(v)
                for i in range(1, size):
                    vals[off + i] = ""
    line = f"{t_snap:.6f}\t" + "\t".join(vals) + "\n"
    f.write(line)
    return len(line.encode("utf-8", errors="ignore"))


def _recording_writer_thread(
    queue: Queue,
    path: str,
    var_names: list[str] | None,
    rows_written_ref: list[int],
) -> None:
    """Hilo que escribe (t_rel, snapshot) a disco; no depende del event loop."""
    _ensure_recordings_dir()
    f = None
    col_spec: list[tuple[str, int]] | None = None
    row_layout: tuple[dict[str, tuple[int, int]], int] | None = None
    try:
        while True:
            item = queue.get()
            if item is None:
                break
            t_rel, snapshot = item
            if not snapshot:
                continue
            if col_spec is None:
                names = var_names or sorted(set(e.get("name") for e in snapshot if isinstance(e, dict)))
                col_spec = _build_record_col_spec(names, snapshot)
                row_layout = _record_row_layout(col_spec)
                f = open(path, "w", buffering=1024 * 1024)
                _write_record_header_stream(f, col_spec)
            _write_record_row_stream(f, t_rel, snapshot, col_spec, row_layout)
            rows_written_ref[0] += 1
    finally:
        if f is not None:
            try:
                f.flush()
                f.close()
            except Exception:
                pass


def _finalize_recording_temp_file(temp_path: str | None, rows_written: int) -> tuple[str, str, int]:
    """Cierra grabación incremental: renombra temporal a record_*.tsv."""
    if not temp_path:
        return "", "", 0
    try:
        if rows_written <= 0:
            if os.path.isfile(temp_path):
                os.remove(temp_path)
            return "", "", 0
        _ensure_recordings_dir()
        from datetime import datetime
        fn_saved = f"record_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tsv"
        path_saved = os.path.join(RECORDINGS_DIR, fn_saved)
        os.replace(temp_path, path_saved)
        try:
            size_saved = int(os.path.getsize(path_saved))
        except Exception:
            size_saved = 0
        return path_saved, fn_saved, size_saved
    except Exception:
        return "", "", 0


def _evaluate_alarms(
    snapshot: list[dict],
    alarms_config: dict,
    prev_state: dict,
    pending_since_ms: dict,
    now_ms: int,
) -> tuple[dict, dict, list[dict], list[str]]:
    """Evalúa umbrales en snapshot.

    Devuelve (nuevo_estado, nuevo_pending_since_ms, triggered [{name, reason, value}], cleared [name]).
    Soporta histéresis y delay de activación por alarma.
    """
    new_state = dict(prev_state)
    new_pending = dict(pending_since_ms)
    triggered = []
    cleared = []
    names_needed = frozenset(alarms_config.keys())
    var_by_name: dict[str, dict] = {}
    for e in snapshot:
        if not isinstance(e, dict):
            continue
        n = e.get("name")
        if n is None or n not in names_needed:
            continue
        var_by_name[n] = e
    for name, cfg in alarms_config.items():
        if name not in var_by_name:
            continue
        e = var_by_name[name]
        val = e.get("value")
        if not isinstance(val, (int, float)):
            continue
        lo = cfg.get("lo")
        hi = cfg.get("hi")
        hys = cfg.get("hys")
        delay_ms = cfg.get("delayMs")
        hys = max(0.0, float(hys)) if isinstance(hys, (int, float)) else 0.0
        delay_ms = max(0, int(delay_ms)) if isinstance(delay_ms, (int, float)) else 0
        alarming = False
        reason = ""
        was = bool(prev_state.get(name, False))

        over_hi = (hi is not None and val > hi)
        under_lo = (lo is not None and val < lo)
        if was:
            clear_hi = (hi is None) or (val <= (float(hi) - hys))
            clear_lo = (lo is None) or (val >= (float(lo) + hys))
            if clear_hi and clear_lo:
                alarming = False
            else:
                alarming = (hi is not None and val > (float(hi) - hys)) or (lo is not None and val < (float(lo) + hys))
        else:
            alarming = over_hi or under_lo

        if not alarming:
            new_pending.pop(name, None)
            new_state[name] = False
        else:
            if name not in new_pending:
                new_pending[name] = now_ms
            if now_ms - int(new_pending[name]) >= delay_ms:
                new_state[name] = True
            else:
                new_state[name] = False

        if new_state[name] and not was:
            if hi is not None and val > hi:
                reason = f"{name} = {val:.4f} > Hi:{hi}"
            elif lo is not None and val < lo:
                reason = f"{name} = {val:.4f} < Lo:{lo}"
            else:
                reason = f"{name} en alarma ({val:.4f})"
            triggered.append({"name": name, "reason": reason, "value": val})
        elif was and not new_state[name]:
            cleared.append(name)
    return new_state, new_pending, triggered, cleared


@app.get("/api/uds_instances")
async def api_uds_instances(user: str | None = Query(None, description="Filtrar por usuario (solo varmon-<user>-*.sock)")):
    """Lista instancias VarMonitor accesibles por UDS en /tmp. Sin TCP."""
    instances = await asyncio.to_thread(_list_uds_instances, user)
    return {"instances": instances}


@app.get("/api/recordings")
async def api_recordings():
    """Lista grabaciones TSV del backend (recordings/), ordenadas por mtime desc."""
    _ensure_recordings_dir()
    rows: list[dict] = []
    try:
        for fn in os.listdir(RECORDINGS_DIR):
            if not fn.lower().endswith(".tsv"):
                continue
            path = os.path.join(RECORDINGS_DIR, fn)
            if not os.path.isfile(path):
                continue
            st = os.stat(path)
            kind = "alarm" if fn.lower().startswith("alarm_") else ("record" if fn.lower().startswith("record_") else "other")
            rows.append({
                "filename": fn,
                "size": int(st.st_size),
                "mtime": float(st.st_mtime),
                "kind": kind,
            })
    except Exception:
        rows = []
    rows.sort(key=lambda x: -x["mtime"])
    return {"recordings": rows}


def _resolve_browse_path(relative_path: str) -> Path | None:
    """Resuelve una ruta relativa bajo BROWSER_ROOT. Devuelve Path o None si es inválida."""
    root = BROWSER_ROOT.resolve()
    path = (root / (relative_path or "").strip().lstrip("/")).resolve()
    try:
        path = path.resolve()
        if not path.is_relative_to(root):
            return None
        return path
    except (ValueError, OSError):
        return None


@app.get("/api/browse")
async def api_browse(path: str = Query("", description="Ruta relativa al root del proyecto")):
    """Lista el contenido de un directorio dentro de la raíz del proyecto."""
    resolved = _resolve_browse_path(path)
    if resolved is None:
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not resolved.is_dir():
        return JSONResponse({"error": "No es un directorio"}, status_code=400)
    entries: list[dict] = []
    try:
        for entry in sorted(resolved.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            name = entry.name
            if name.startswith(".") and name not in (".", ".."):
                continue
            is_dir = entry.is_dir()
            st = entry.stat()
            row = {"name": name, "is_dir": is_dir}
            if not is_dir:
                row["size"] = st.st_size
            row["mtime"] = st.st_mtime
            entries.append(row)
    except OSError as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    rel_path = str(resolved.relative_to(BROWSER_ROOT)) if resolved != BROWSER_ROOT else ""
    return {"path": rel_path, "root": str(BROWSER_ROOT), "entries": entries}


@app.get("/api/browse/download")
async def api_browse_download(path: str = Query(..., description="Ruta relativa al root del proyecto")):
    """Descarga un archivo dentro de la raíz del proyecto."""
    resolved = _resolve_browse_path(path)
    if resolved is None:
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not resolved.is_file():
        return JSONResponse({"error": "No es un archivo"}, status_code=404)
    return FileResponse(
        str(resolved),
        filename=resolved.name,
        media_type="application/octet-stream",
    )


@app.post("/api/browse/mkdir")
async def api_browse_mkdir(request: Request):
    """Crea un directorio dentro de la raíz del proyecto."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Body JSON inválido"}, status_code=400)
    parent_path = (body.get("path") or "").strip()
    name = (body.get("name") or "").strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        return JSONResponse({"error": "Nombre de carpeta inválido"}, status_code=400)
    parent = _resolve_browse_path(parent_path)
    if parent is None:
        return JSONResponse({"error": "Ruta padre inválida"}, status_code=400)
    if not parent.is_dir():
        return JSONResponse({"error": "La ruta padre no es un directorio"}, status_code=400)
    new_dir = parent / name
    try:
        new_dir = new_dir.resolve()
        if not new_dir.is_relative_to(BROWSER_ROOT):
            return JSONResponse({"error": "Ruta fuera del proyecto"}, status_code=400)
    except (ValueError, OSError):
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if new_dir.exists():
        return JSONResponse({"error": "Ya existe"}, status_code=409)
    try:
        new_dir.mkdir(parents=False, exist_ok=False)
    except OSError as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    rel = str(new_dir.relative_to(BROWSER_ROOT))
    return JSONResponse({"path": rel}, status_code=201)


@app.get("/api/recordings/{filename}")
async def api_recording_download(
    filename: str,
    preview_bytes: int = Query(0),
    offset: int = Query(0),
):
    """Descarga segura de una grabación dentro de recordings/.

    Si preview_bytes > 0, devuelve un preview de texto parcial para análisis seguro
    sin transferir el TSV completo. offset (bytes) permite pedir un tramo posterior
    (Fase 1: navegación por tramos en archivos grandes).
    """
    _ensure_recordings_dir()
    safe_name = os.path.basename(filename or "")
    if not safe_name or safe_name != filename:
        return JSONResponse({"error": "Nombre de archivo inválido"}, status_code=400)
    path = os.path.abspath(os.path.join(RECORDINGS_DIR, safe_name))
    root = os.path.abspath(RECORDINGS_DIR)
    if not path.startswith(root + os.sep):
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not os.path.isfile(path):
        return JSONResponse({"error": "Archivo no encontrado"}, status_code=404)
    if int(preview_bytes or 0) > 0:
        try:
            max_bytes = max(1024, min(int(preview_bytes), 8 * 1024 * 1024))
            seek_offset = max(0, int(offset or 0))
            segment_start = 0
            header_raw: bytes
            body_raw: bytes
            with open(path, "rb") as f:
                # Leer siempre la cabecera completa (primera línea) para poder
                # reconstruir un TSV válido en cualquier tramo.
                header_raw = f.readline()
                header_text = header_raw.decode("utf-8", errors="ignore")
                header_len = len(header_raw)
                if seek_offset > 0:
                    # Buscar un inicio de línea cercano al offset solicitado.
                    f.seek(seek_offset)
                    back = min(seek_offset, 8192)
                    f.seek(max(0, seek_offset - back))
                    chunk = f.read(back)
                    last_nl = chunk.rfind(b"\n")
                    segment_start = seek_offset - back + last_nl + 1 if last_nl >= 0 else seek_offset
                    f.seek(segment_start)
                else:
                    # Primer tramo: empezar justo después de la cabecera.
                    segment_start = header_len
                    f.seek(segment_start)
                body_raw = f.read(max_bytes)
            # Siempre devolvemos cabecera + tramo para que el cliente pueda parsear el TSV.
            body_text = body_raw.decode("utf-8", errors="ignore")
            text = header_text + body_text
            st = os.stat(path)
            return {
                "filename": safe_name,
                "size": int(st.st_size),
                "offset": seek_offset,
                "segment_start": segment_start,
                # Solo contabilizamos los bytes de cuerpo para el control de tramos.
                "preview_bytes": len(body_raw),
                "truncated": int(st.st_size) > (segment_start + len(body_raw)),
                "preview": text,
            }
        except Exception as e:
            return JSONResponse({"error": f"No se pudo leer preview: {e}"}, status_code=500)
    return FileResponse(path, media_type="text/tab-separated-values", filename=safe_name)


def _read_single_var_history_tsv(path: str, var_name: str, max_points: int = 20000) -> dict:
    """Lee time_s y una variable concreta de un TSV grande, con downsampling simple."""
    import math

    ts_list: list[float] = []
    val_list: list[float] = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        header = f.readline()
        if not header:
            raise ValueError("TSV vacío")
        cols = header.rstrip("\n").split("\t")
        if not cols or cols[0] != "time_s":
            raise ValueError("Cabecera inválida: primera columna debe ser time_s")
        try:
            idx_var = cols.index(var_name)
        except ValueError:
            raise KeyError(f"Variable '{var_name}' no encontrada en TSV")
        # Primera pasada: recoger todos los puntos (solo dos columnas)
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) <= idx_var:
                continue
            try:
                t = float(parts[0])
            except ValueError:
                continue
            raw = parts[idx_var].strip()
            if raw == "":
                continue
            try:
                v = float(raw)
            except ValueError:
                continue
            ts_list.append(t)
            val_list.append(v)
    n = len(ts_list)
    if n == 0:
        return {"name": var_name, "timestamps": [], "values": []}
    if n <= max_points:
        return {"name": var_name, "timestamps": ts_list, "values": val_list}
    # Downsampling uniforme: step = ceil(n / max_points)
    step = max(1, math.ceil(n / max_points))
    ds_ts = ts_list[0:n:step]
    ds_vals = val_list[0:n:step]
    if ds_ts[-1] != ts_list[-1]:
        ds_ts.append(ts_list[-1])
        ds_vals.append(val_list[-1])
    return {"name": var_name, "timestamps": ds_ts, "values": ds_vals}


def _read_var_window_tsv(
    path: str,
    var_name: str,
    t_center: float,
    t_span: float,
    max_points: int = 5000,
) -> dict:
    """Lee una ventana temporal [t_start, t_end] de time_s + variable concreta, con downsampling.

    Usa un índice ligero de tiempo si está disponible para evitar escanear todo el fichero.
    """
    import math

    if not math.isfinite(t_center) or t_span <= 0:
        raise ValueError("Parámetros de tiempo inválidos")
    half = t_span / 2.0
    t_start = t_center - half
    t_end = t_center + half
    if t_end < t_start:
        t_start, t_end = t_end, t_start

    ts_list: list[float] = []
    val_list: list[float] = []

    # Intentar usar índice de tiempos si existe.
    with _TIME_INDEX_LOCK:
        idx = _TIME_INDEX.get(path)

    start_offset: int | None = None
    if idx:
        # Buscar el primer punto del índice con tiempo >= t_start
        lo, hi = 0, len(idx) - 1
        pos = len(idx) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            tm, off = idx[mid]
            if tm >= t_start:
                pos = mid
                hi = mid - 1
            else:
                lo = mid + 1
        start_offset = idx[pos][1]

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        header = f.readline()
        if not header:
            raise ValueError("TSV vacío")
        cols = header.rstrip("\n").split("\t")
        if not cols or cols[0] != "time_s":
            raise ValueError("Cabecera inválida: primera columna debe ser time_s")
        try:
            idx_var = cols.index(var_name)
        except ValueError:
            raise KeyError(f"Variable '{var_name}' no encontrada en TSV")

        # Si tenemos offset, saltar directamente allí; si no, escanear completo.
        if start_offset is not None:
            f.seek(start_offset)

        while True:
            line = f.readline()
            if not line:
                break
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) <= idx_var:
                continue
            try:
                t = float(parts[0])
            except ValueError:
                continue
            if t < t_start:
                continue
            if t > t_end:
                break
            raw = parts[idx_var].strip()
            if raw == "":
                continue
            try:
                v = float(raw)
            except ValueError:
                continue
            ts_list.append(t)
            val_list.append(v)
    n = len(ts_list)
    if n == 0:
        return {"name": var_name, "timestamps": [], "values": []}
    if n <= max_points:
        return {"name": var_name, "timestamps": ts_list, "values": val_list}
    step = max(1, math.ceil(n / max_points))
    ds_ts = ts_list[0:n:step]
    ds_vals = val_list[0:n:step]
    if ds_ts[-1] != ts_list[-1]:
        ds_ts.append(ts_list[-1])
        ds_vals.append(val_list[-1])
    return {"name": var_name, "timestamps": ds_ts, "values": ds_vals}


def _build_time_index_and_bounds(path: str, min_step_sec: float = 1.0) -> dict:
    """Construye un índice ligero de tiempos (time_s -> offset) y devuelve bounds."""
    min_ts: float | None = None
    max_ts: float | None = None
    index: list[tuple[float, int]] = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        header = f.readline()
        if not header:
            raise ValueError("TSV vacío")
        cols = header.rstrip("\n").split("\t")
        if not cols or cols[0] != "time_s":
            raise ValueError("Cabecera inválida: primera columna debe ser time_s")
        while True:
            offset = f.tell()
            line = f.readline()
            if not line:
                break
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t")
            if not parts:
                continue
            try:
                t = float(parts[0])
            except ValueError:
                continue
            if not math.isfinite(t):
                continue
            if min_ts is None or t < min_ts:
                min_ts = t
            if max_ts is None or t > max_ts:
                max_ts = t
            # Guardar un punto de índice cada min_step_sec aprox.
            if not index or (t - index[-1][0]) >= min_step_sec:
                index.append((t, offset))
    if min_ts is None or max_ts is None:
        raise ValueError("No se encontraron tiempos válidos en el TSV")
    with _TIME_INDEX_LOCK:
        _TIME_INDEX[path] = index
    return {"minTs": float(min_ts), "maxTs": float(max_ts)}


def _read_time_bounds_tsv(path: str) -> dict:
    """Devuelve bounds de tiempo, construyendo el índice si es necesario."""
    with _TIME_INDEX_LOCK:
        idx = _TIME_INDEX.get(path)
    if idx:
        # Si ya hay índice, usar sus extremos como bounds aproximados.
        return {"minTs": float(idx[0][0]), "maxTs": float(idx[-1][0])}
    return _build_time_index_and_bounds(path)


@app.get("/api/recordings/{filename}/history")
async def api_recording_var_history(filename: str, var: str = Query(...), max_points: int = Query(20000)):
    """Histórico completo de una variable concreta desde el TSV (modo análisis offline).

    - Lee solo time_s y la columna de la variable.
    - Aplica downsampling uniforme si el número de puntos supera max_points.
    """
    _ensure_recordings_dir()
    safe_name = os.path.basename(filename or "")
    if not safe_name or safe_name != filename:
        return JSONResponse({"error": "Nombre de archivo inválido"}, status_code=400)
    path = os.path.abspath(os.path.join(RECORDINGS_DIR, safe_name))
    root = os.path.abspath(RECORDINGS_DIR)
    if not path.startswith(root + os.sep):
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not os.path.isfile(path):
        return JSONResponse({"error": "Archivo no encontrado"}, status_code=404)
    var_name = (var or "").strip()
    if not var_name:
        return JSONResponse({"error": "Nombre de variable vacío"}, status_code=400)
    try:
        mp = max(1000, min(int(max_points or 0), 100000))
    except Exception:
        mp = 20000
    try:
        data = await asyncio.to_thread(_read_single_var_history_tsv, path, var_name, mp)
        return JSONResponse(data)
    except KeyError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"No se pudo leer historial: {e}"}, status_code=500)


@app.get("/api/recordings/{filename}/window")
async def api_recording_var_window(
    filename: str,
    var: str = Query(...),
    t_center: float = Query(...),
    t_span: float = Query(20.0),
    max_points: int = Query(5000),
):
    """Ventana corta de una variable concreta desde el TSV (modo análisis offline).

    - Filtra por rango temporal [t_center - t_span/2, t_center + t_span/2].
    - Aplica downsampling uniforme si el número de puntos supera max_points.
    """
    _ensure_recordings_dir()
    safe_name = os.path.basename(filename or "")
    if not safe_name or safe_name != filename:
        return JSONResponse({"error": "Nombre de archivo inválido"}, status_code=400)
    path = os.path.abspath(os.path.join(RECORDINGS_DIR, safe_name))
    root = os.path.abspath(RECORDINGS_DIR)
    if not path.startswith(root + os.sep):
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not os.path.isfile(path):
        return JSONResponse({"error": "Archivo no encontrado"}, status_code=404)
    var_name = (var or "").strip()
    if not var_name:
        return JSONResponse({"error": "Nombre de variable vacío"}, status_code=400)
    try:
        mp = max(500, min(int(max_points or 0), 50000))
    except Exception:
        mp = 5000
    try:
        data = await asyncio.to_thread(
            _read_var_window_tsv,
            path,
            var_name,
            float(t_center),
            float(t_span),
            mp,
        )
        return JSONResponse(data)
    except KeyError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"No se pudo leer ventana: {e}"}, status_code=500)


@app.get("/api/recordings/{filename}/window_batch")
async def api_recording_var_window_batch(
    filename: str,
    vars: str = Query(..., description="Lista separada por comas de nombres de variables"),
    t_center: float = Query(...),
    t_span: float = Query(20.0),
    max_points: int = Query(5000),
):
    """Ventanas cortas para varias variables en una sola pasada (modo análisis offline).

    Devuelve un array de series [{name, timestamps, values}, ...].
    """
    _ensure_recordings_dir()
    safe_name = os.path.basename(filename or "")
    if not safe_name or safe_name != filename:
        return JSONResponse({"error": "Nombre de archivo inválido"}, status_code=400)
    path = os.path.abspath(os.path.join(RECORDINGS_DIR, safe_name))
    root = os.path.abspath(RECORDINGS_DIR)
    if not path.startswith(root + os.sep):
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not os.path.isfile(path):
        return JSONResponse({"error": "Archivo no encontrado"}, status_code=404)
    raw_vars = (vars or "").split(",")
    names = [v.strip() for v in raw_vars if v and v.strip()]
    if not names:
        return JSONResponse({"error": "Sin variables válidas en 'vars'"}, status_code=400)
    try:
        mp = max(500, min(int(max_points or 0), 50000))
    except Exception:
        mp = 5000

    async def _read_one(name: str) -> dict:
        return await asyncio.to_thread(
            _read_var_window_tsv,
            path,
            name,
            float(t_center),
            float(t_span),
            mp,
        )

    series: list[dict] = []
    for name in names:
        try:
            data = await _read_one(name)
            series.append(data)
        except KeyError:
            # Variable no encontrada: se omite en el resultado
            continue
        except Exception:
            continue
    return JSONResponse({
        "t_center": float(t_center),
        "span": float(t_span),
        "series": series,
    })


@app.get("/api/recordings/{filename}/bounds")
async def api_recording_time_bounds(filename: str):
    """Devuelve minTs y maxTs (en segundos) de toda la grabación TSV."""
    _ensure_recordings_dir()
    safe_name = os.path.basename(filename or "")
    if not safe_name or safe_name != filename:
        return JSONResponse({"error": "Nombre de archivo inválido"}, status_code=400)
    path = os.path.abspath(os.path.join(RECORDINGS_DIR, safe_name))
    root = os.path.abspath(RECORDINGS_DIR)
    if not path.startswith(root + os.sep):
        return JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not os.path.isfile(path):
        return JSONResponse({"error": "Archivo no encontrado"}, status_code=404)
    try:
        data = await asyncio.to_thread(_read_time_bounds_tsv, path)
        return JSONResponse(data)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"No se pudieron leer bounds: {e}"}, status_code=500)


@app.post("/api/save_tsv")
@app.post("/api/recordings/save_tsv")
async def api_recording_save_tsv(request: Request, download: int = Query(0), kind: str = Query("snapshot")):
    """Guarda TSV recibido en body JSON {content, filename?}. Devuelve ruta/filename o descarga directa."""
    _ensure_recordings_dir()
    try:
        payload = await request.json()
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip():
            return JSONResponse({"error": "Contenido TSV vacío"}, status_code=400)
        now = time.strftime("%Y%m%d_%H%M%S")
        safe_kind = "segment" if str(kind).strip().lower().startswith("seg") else "snapshot"
        base_name = payload.get("filename")
        if isinstance(base_name, str) and base_name.strip():
            safe_name = os.path.basename(base_name.strip())
            if not safe_name.lower().endswith(".tsv"):
                safe_name += ".tsv"
        else:
            safe_name = f"{safe_kind}_{now}.tsv"
        path = os.path.abspath(os.path.join(RECORDINGS_DIR, safe_name))
        root = os.path.abspath(RECORDINGS_DIR)
        if not path.startswith(root + os.sep):
            return JSONResponse({"error": "Ruta inválida"}, status_code=400)
        with open(path, "w") as f:
            f.write(content if content.endswith("\n") else (content + "\n"))
        if int(download or 0) == 1:
            return FileResponse(path, media_type="text/tab-separated-values", filename=safe_name)
        return {"ok": True, "filename": safe_name, "path": path}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/templates")
async def api_templates():
    _ensure_state_dirs()
    rows: list[str] = []
    try:
        for fn in os.listdir(TEMPLATES_DIR):
            if fn.lower().endswith(".json"):
                rows.append(fn[:-5])
    except Exception:
        rows = []
    rows.sort()
    return {"templates": rows}


@app.get("/api/templates/{name}")
async def api_template_get(name: str):
    _ensure_state_dirs()
    path = _json_path(TEMPLATES_DIR, name)
    if not path:
        return JSONResponse({"error": "Nombre inválido"}, status_code=400)
    if not os.path.isfile(path):
        return JSONResponse({"error": "Plantilla no encontrada"}, status_code=404)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return {"name": _safe_json_name(name), "data": data}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.put("/api/templates/{name}")
async def api_template_put(name: str, request: Request, download: int = Query(0)):
    _ensure_state_dirs()
    path = _json_path(TEMPLATES_DIR, name)
    if not path:
        return JSONResponse({"error": "Nombre inválido"}, status_code=400)
    try:
        payload = await request.json()
        data = payload.get("data")
        with open(path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        if int(download or 0) == 1:
            return FileResponse(path, media_type="application/json", filename=os.path.basename(path))
        return {"ok": True, "name": _safe_json_name(name)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.delete("/api/templates/{name}")
async def api_template_delete(name: str):
    _ensure_state_dirs()
    path = _json_path(TEMPLATES_DIR, name)
    if not path:
        return JSONResponse({"error": "Nombre inválido"}, status_code=400)
    try:
        if os.path.exists(path):
            os.remove(path)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/sessions")
async def api_sessions():
    _ensure_state_dirs()
    rows: list[str] = []
    try:
        for fn in os.listdir(SESSIONS_DIR):
            if fn.lower().endswith(".json"):
                rows.append(fn[:-5])
    except Exception:
        rows = []
    rows.sort()
    return {"sessions": rows}


@app.get("/api/sessions/{name}")
async def api_session_get(name: str):
    _ensure_state_dirs()
    path = _json_path(SESSIONS_DIR, name)
    if not path:
        return JSONResponse({"error": "Nombre inválido"}, status_code=400)
    if not os.path.isfile(path):
        return JSONResponse({"error": "Estado no encontrado"}, status_code=404)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return {"name": _safe_json_name(name), "data": data}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.put("/api/sessions/{name}")
async def api_session_put(name: str, request: Request, download: int = Query(0)):
    _ensure_state_dirs()
    path = _json_path(SESSIONS_DIR, name)
    if not path:
        return JSONResponse({"error": "Nombre inválido"}, status_code=400)
    try:
        payload = await request.json()
        data = payload.get("data")
        with open(path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        if int(download or 0) == 1:
            return FileResponse(path, media_type="application/json", filename=os.path.basename(path))
        return {"ok": True, "name": _safe_json_name(name)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.delete("/api/sessions/{name}")
async def api_session_delete(name: str):
    _ensure_state_dirs()
    path = _json_path(SESSIONS_DIR, name)
    if not path:
        return JSONResponse({"error": "Nombre inválido"}, status_code=400)
    try:
        if os.path.exists(path):
            os.remove(path)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


def _read_cpp_log_tail(path: str, max_lines: int) -> list[dict]:
    """Lee las últimas max_lines líneas del archivo de log C++ (si existe)."""
    out: list[dict] = []
    if not path or not os.path.isfile(path):
        return out
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        for line in lines[-max_lines:]:
            line = line.rstrip("\n\r")
            if line:
                out.append({"ts": "", "level": "info", "msg": f"[C++] {line}"})
    except Exception:
        out.append({"ts": "", "level": "warning", "msg": f"[C++] No se pudo leer {path}"})
    return out


@app.get("/api/log")
async def api_log(
    request: Request,
    tail: int = Query(2000, ge=1, le=20000),
    since_seq: int = Query(0, ge=0, description="Solo source=python: líneas con seq > since_seq"),
    limit: int = Query(500, ge=1, le=2000, description="Máx. líneas en modo incremental"),
    source: str = Query("python", description="python | cpp | all"),
):
    """Devuelve el log del backend (Python) y opcionalmente del proceso C++ (archivo configurado)."""
    source = (source or "python").strip().lower()
    if source not in ("python", "cpp", "all"):
        source = "python"
    want_plain = request.headers.get("accept", "").strip().startswith("text/plain")
    lines: list[dict] = []
    max_seq = 0
    if source in ("python", "all"):
        with _LOG_BUFFER_LOCK:
            max_seq = _LOG_SEQ
            use_incr = (not want_plain) and source == "python" and since_seq > 0
            if use_incr:
                acc: list[dict] = []
                for x in _LOG_BUFFER:
                    if x.get("seq", 0) > since_seq:
                        acc.append(x)
                lines = acc[-limit:]
            else:
                snap = list(_LOG_BUFFER)[-tail:]
                if source == "all":
                    lines = [
                        {"ts": x["ts"], "level": x["level"], "msg": f"[Py] {x['msg']}", "seq": x.get("seq", 0)}
                        for x in snap
                    ]
                else:
                    lines = snap
    if source in ("cpp", "all"):
        cpp_path = (_config.get("log_file_cpp") or "").strip()
        cpp_lines = _read_cpp_log_tail(cpp_path, tail)
        if source == "all":
            lines = list(lines) + cpp_lines
            lines.sort(key=lambda x: (x["ts"], x["msg"]))
        elif source == "cpp":
            lines = cpp_lines
            max_seq = 0
    if want_plain:
        text = "\n".join(
            (f"{x['ts']} {x['msg']}" if x.get("ts") else x["msg"]) for x in lines
        )
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(text)
    out: dict = {"lines": lines, "source": source}
    if source in ("python", "all"):
        out["max_seq"] = max_seq
    return out


@app.get("/api/admin/storage")
async def api_admin_storage():
    _ensure_recordings_dir()
    _ensure_state_dirs()
    recs: list[dict] = []
    try:
        for fn in os.listdir(RECORDINGS_DIR):
            if not fn.lower().endswith(".tsv"):
                continue
            path = os.path.join(RECORDINGS_DIR, fn)
            if not os.path.isfile(path):
                continue
            st = os.stat(path)
            kind = "alarm" if fn.lower().startswith("alarm_") else ("record" if fn.lower().startswith("record_") else ("snapshot" if fn.lower().startswith("snapshot_") else ("segment" if fn.lower().startswith("segment_") else "other")))
            recs.append({"name": fn, "kind": kind, "size": int(st.st_size), "mtime": float(st.st_mtime)})
    except Exception:
        recs = []
    recs.sort(key=lambda x: -x["mtime"])
    templates = sorted([fn[:-5] for fn in os.listdir(TEMPLATES_DIR) if fn.lower().endswith(".json")]) if os.path.isdir(TEMPLATES_DIR) else []
    sessions = sorted([fn[:-5] for fn in os.listdir(SESSIONS_DIR) if fn.lower().endswith(".json")]) if os.path.isdir(SESSIONS_DIR) else []
    return {
        "paths": {
            "config_file": CONFIG_ABS_PATH,
            "recordings_dir": os.path.abspath(RECORDINGS_DIR),
            "server_state_dir": os.path.abspath(STATE_ROOT_DIR),
            "templates_dir": os.path.abspath(TEMPLATES_DIR),
            "sessions_dir": os.path.abspath(SESSIONS_DIR),
        },
        "runtime": {
            "web_port": int(_config.get("web_port", 8080)),
            "web_port_scan_max": int(_config.get("web_port_scan_max", 10)),
        },
        "recordings": recs,
        "templates": templates,
        "sessions": sessions,
    }


@app.post("/api/admin/storage/delete")
async def api_admin_storage_delete(request: Request):
    _ensure_recordings_dir()
    _ensure_state_dirs()
    try:
        payload = await request.json()
        kind = str(payload.get("kind") or "").strip().lower()
        name = str(payload.get("name") or "").strip()
        if not name:
            return JSONResponse({"error": "Nombre vacío"}, status_code=400)
        if kind == "recording":
            safe_name = os.path.basename(name)
            if safe_name != name:
                return JSONResponse({"error": "Nombre inválido"}, status_code=400)
            path = os.path.abspath(os.path.join(RECORDINGS_DIR, safe_name))
            root = os.path.abspath(RECORDINGS_DIR)
            if not path.startswith(root + os.sep):
                return JSONResponse({"error": "Ruta inválida"}, status_code=400)
        elif kind == "template":
            path = _json_path(TEMPLATES_DIR, name)
            if not path:
                return JSONResponse({"error": "Nombre inválido"}, status_code=400)
        elif kind == "session":
            path = _json_path(SESSIONS_DIR, name)
            if not path:
                return JSONResponse({"error": "Nombre inválido"}, status_code=400)
        else:
            return JSONResponse({"error": "Tipo inválido"}, status_code=400)
        if os.path.exists(path):
            os.remove(path)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/admin/runtime_config")
async def api_admin_runtime_config(request: Request):
    global _config
    try:
        payload = await request.json()
        updates: dict = {}
        if "web_port" in payload:
            v = int(payload.get("web_port"))
            if v < 1 or v > 65535:
                return JSONResponse({"error": "web_port inválido"}, status_code=400)
            _config["web_port"] = v
            updates["web_port"] = v
        if "web_port_scan_max" in payload:
            v = int(payload.get("web_port_scan_max"))
            if v < 0 or v > 100:
                return JSONResponse({"error": "web_port_scan_max inválido"}, status_code=400)
            _config["web_port_scan_max"] = v
            updates["web_port_scan_max"] = v
        if hasattr(request.app.state, "max_web_port_in_range"):
            request.app.state.max_web_port_in_range = None
        _save_runtime_config_overrides(updates)
        return {"ok": True, "runtime": {"web_port": int(_config.get("web_port", 8080)), "web_port_scan_max": int(_config.get("web_port_scan_max", 10))}}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/auth_required")
async def api_auth_required():
    """Indica si el WebSocket exige contraseña (para mostrar login antes de conectar)."""
    return {"auth_required": bool(_config.get("auth_password", "").strip())}


def _get_process_ram_mb() -> float | None:
    """RAM del proceso actual en MB. Linux: /proc/self/status VmRSS; otro Unix: resource.getrusage."""
    try:
        if os.path.exists("/proc/self/status"):
            with open("/proc/self/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        parts = line.split()
                        if len(parts) >= 2:
                            return int(parts[1]) / 1024.0  # kB -> MB
                        return None
        if hasattr(resource, "getrusage"):
            # ru_maxrss: Linux en KB, macOS en bytes
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            if rss > 0:
                return (rss / 1024.0) if rss < 2**20 else (rss / (1024.0 * 1024.0))
    except Exception:
        pass
    return None


def _get_python_cpu_percent(state) -> float | None:
    """CPU % del proceso Python (promedio desde la última llamada). Solo Unix, requiere dos muestras."""
    try:
        if not hasattr(resource, "getrusage"):
            return None
        r = resource.getrusage(resource.RUSAGE_SELF)
        now_wall = time.monotonic()
        now_cpu = r.ru_utime + r.ru_stime
        last_wall = getattr(state, "adv_stats_last_wall", None)
        last_cpu = getattr(state, "adv_stats_last_cpu", None)
        state.adv_stats_last_wall = now_wall
        state.adv_stats_last_cpu = now_cpu
        if last_wall is not None and last_cpu is not None:
            delta_wall = now_wall - last_wall
            if delta_wall >= 0.1:  # al menos 100 ms para no dar picos
                delta_cpu = now_cpu - last_cpu
                return min(100.0, max(0.0, (delta_cpu / delta_wall) * 100.0))
    except Exception:
        pass
    return None


def _fetch_cpp_stats_sync(timeout: float = 1.0) -> tuple[float | None, float | None, float | None, bool]:
    """Conecta al C++ por UDS y devuelve (ram_mb, cpu_percent, shm_cycle_hint_ms, shm_active)."""
    try:
        b = _first_uds_bridge()
        if b is None:
            return (None, None, None, False)
        info = b.get_server_info()
        b.disconnect()
        if info is None:
            return (None, None, None, False)
        ram_mb = None
        rss_kb = info.get("memory_rss_kb")
        if rss_kb is not None and rss_kb >= 0:
            ram_mb = rss_kb / 1024.0
        cpu_percent = info.get("cpu_percent")
        if cpu_percent is not None and isinstance(cpu_percent, (int, float)):
            cpu_percent = float(cpu_percent)
        else:
            cpu_percent = None
        shm_active = bool(info.get("shm_name") and info.get("sem_name"))
        shm_hint = info.get("sample_interval_ms")
        if isinstance(shm_hint, (int, float)):
            shm_hint = float(shm_hint)
        else:
            shm_hint = None
        return (ram_mb, cpu_percent, shm_hint, shm_active)
    except Exception:
        pass
    return (None, None, None, False)


@app.get("/api/advanced_stats")
async def api_advanced_stats(request: Request):
    """RAM y CPU % del proceso Python; RAM del C++ (si se puede conectar por UDS)."""
    state = request.app.state
    python_ram_mb = _get_process_ram_mb()
    python_cpu_percent = _get_python_cpu_percent(state)
    cpp_ram_mb, cpp_cpu_percent, shm_cycle_hint_ms, shm_active = await asyncio.to_thread(_fetch_cpp_stats_sync)
    shm_cycle_ms = getattr(state, "shm_cycle_ms", None)
    if shm_cycle_ms is None and isinstance(shm_cycle_hint_ms, (int, float)):
        shm_cycle_ms = float(shm_cycle_hint_ms)
    # Fallback: si SHM está activo pero aún no tenemos medida EMA, mostrar ciclo configurado.
    if shm_cycle_ms is None and shm_active:
        try:
            shm_cycle_ms = float(_config.get("cycle_interval_ms", 100))
        except Exception:
            shm_cycle_ms = None
    return {
        "python_ram_mb": python_ram_mb,
        "python_cpu_percent": python_cpu_percent,
        "cpp_ram_mb": cpp_ram_mb,
        "cpp_cpu_percent": cpp_cpu_percent,
        "shm_cycle_ms": shm_cycle_ms,
        "monitored_var_count": _ws_monitored_count_aggregate(state),
    }


@app.get("/api/uptime")
async def api_uptime(request: Request):
    """Solo uptime y puerto actual; sin escaneos. Para que otros backends pidan nuestro uptime sin provocar ping-pong."""
    state = request.app.state
    actual = getattr(state, "actual_web_port", None)
    if actual is None:
        actual = _config["web_port"]
    uptime = None
    if hasattr(state, "startup_time"):
        uptime = time.monotonic() - state.startup_time
    return {"uptime_seconds": uptime, "actual_web_port": actual}


@app.get("/api/connection_info")
async def api_connection_info(request: Request):
    """Devuelve puertos web y usuario para el frontend."""
    state = request.app.state
    actual = getattr(state, "actual_web_port", None) or _config["web_port"]
    base_web = _config["web_port"]
    scan_max = int(_config.get("web_port_scan_max", 10))
    max_web = getattr(state, "max_web_port_in_range", None)
    if max_web is None:
        max_web = await asyncio.to_thread(_scan_web_ports_max, base_web, scan_max)
        if max_web is not None:
            state.max_web_port_in_range = max_web
    uptime = time.monotonic() - state.startup_time if hasattr(state, "startup_time") else None
    suggested_web_port = max_web if max_web is not None else actual
    out = {
        "base_web_port": base_web,
        "web_port_scan_max": scan_max,
        "actual_web_port": actual,
        "max_web_port_in_range": max_web,
        "suggested_web_port": suggested_web_port,
        "uptime_seconds": uptime,
        "cycle_interval_ms": _config.get("cycle_interval_ms", 100),
        "update_ratio_max": _config.get("update_ratio_max", 100),
    }
    try:
        out["current_user"] = getpass.getuser()
    except Exception:
        out["current_user"] = None
    return out


@app.get("/api/instance_info")
async def api_instance_info(request: Request):
    """Info ligera de esta instancia (puerto web, usuario)."""
    state = request.app.state
    actual = getattr(state, "actual_web_port", None) or _config["web_port"]
    try:
        user = getpass.getuser()
    except Exception:
        user = None
    return {"actual_web_port": actual, "user": user}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    global ACTIVE_WS
    ACTIVE_WS += 1

    # Autenticación por contraseña (query param password)
    global FAILED_AUTH_ATTEMPTS
    auth_password = (_config.get("auth_password") or "").strip()
    if auth_password:
        given = (ws.query_params.get("password") or "").strip()
        if given != auth_password:
            FAILED_AUTH_ATTEMPTS += 1
            # Contador global: no se reinicia hasta que acierten (evita ataques por fuerza bruta)
            attempts_left = max(0, MAX_FAILED_AUTH - FAILED_AUTH_ATTEMPTS)
            await ws.send_json({
                "type": "error",
                "message": "auth_required",
                "attempts_left": attempts_left,
                "attempt": FAILED_AUTH_ATTEMPTS,
            })
            await ws.close()
            ACTIVE_WS -= 1
            print(f"[VarMonitor Web] Contraseña incorrecta. Intentos fallidos: {FAILED_AUTH_ATTEMPTS}/{MAX_FAILED_AUTH}")
            if FAILED_AUTH_ATTEMPTS >= MAX_FAILED_AUTH:
                print("[VarMonitor Web] Cierre por seguridad tras 3 intentos fallidos.")
                os._exit(1)
            return
        FAILED_AUTH_ATTEMPTS = 0  # Contraseña correcta: reiniciar contador

    cycle_interval_sec = _config.get("cycle_interval_ms", 100) / 1000.0
    update_ratio = 5  # enviar vars_update cada N ciclos de tiempo (5 por defecto; 1 = tasa máxima)
    last_vars_update_at = 0.0  # tiempo (monotonic) del último vars_update
    names_refresh_interval = 30.0
    names_refresh_interval_idle = 600.0  # idle: catálogo raro que cambie; evita list_names/list_vars gigantes
    monitored_names: set[str] = set()
    # None = aún no hubo envío exitoso de catálogo desde el bucle; evita martillar list_names/list_vars.
    last_names_send: float | None = None
    # Alarmas y grabación (plan dos tasas)
    alarms_config: dict = {}  # { name: { lo, hi } }
    prev_alarm_state: dict = {}
    alarm_pending_since_ms: dict = {}
    recording = False
    record_buffer: list[tuple[float, list[dict]]] = []  # fallback (legacy)
    alarm_buffer: collections.deque = collections.deque()  # ventana rodante ALARM_BUFFER_SEC
    latest_snapshot: list[dict] | None = None
    # Delta vars_update: evita reenviar miles de variables sin cambio (RSS Python + ancho de banda).
    vars_update_sig_cache: dict[str, tuple] = {}
    force_full_vars_update = False
    send_file_on_finish = False  # por defecto no enviar fichero al navegador
    recording_var_names: list[str] | None = None  # columnas para CSV (monitored al start)
    recording_size_est_bytes = 0
    recording_header_estimated = False
    last_record_progress_send_at = 0.0
    recording_tmp_path: str | None = None
    recording_tmp_fp = None
    recording_col_spec: list[tuple[str, int]] | None = None
    recording_row_layout: tuple[dict[str, tuple[int, int]], int] | None = None
    recording_rows_written = 0
    recording_t0: float | None = None
    shm_last_snap_ts: float | None = None
    shm_cycle_ema_ms: float | None = None
    ws.app.state.shm_cycle_ms = None
    recording_write_queue: Queue | None = None
    recording_writer_thread: threading.Thread | None = None
    recording_rows_written_ref: list[int] | None = None

    # Conexión solo por UDS
    query_uds = ws.query_params.get("uds_path")
    if not query_uds:
        inst = await asyncio.to_thread(_list_uds_instances, None)
        if inst:
            query_uds = inst[0]["uds_path"]
    if not query_uds:
        await ws.send_json({"type": "error", "message": "No hay instancias VarMonitor (UDS). Arranca la aplicación C++."})
        await ws.close()
        ACTIVE_WS -= 1
        return
    try:
        bridge = await asyncio.to_thread(UdsBridge, query_uds, 5.0)
        info = await asyncio.to_thread(bridge.get_server_info)
    except Exception as e:
        print(f"[VarMonitor Web] No se pudo conectar por UDS {query_uds}: {e}", flush=True)
        await ws.send_json({"type": "error", "message": f"No se pudo conectar a {query_uds}: {e}"})
        await ws.close()
        ACTIVE_WS -= 1
        return
    connection_label = query_uds

    shm_reader: ShmReader | None = None
    shm_queue: Queue | None = None
    if info and info.get("shm_name") and info.get("sem_name"):
        qmax = int(_config.get("shm_queue_max_size", 512))
        shm_queue = Queue(0 if qmax <= 0 else qmax)
        shm_max_vars = int(_config.get("shm_max_vars", 2048))
        shm_hz = float(_config.get("shm_parse_max_hz", 40) or 0)
        shm_parse_cap = None if shm_hz <= 0 else shm_hz
        shm_reader = ShmReader(
            info["shm_name"],
            info["sem_name"],
            shm_queue,
            poll_interval=0.5,
            max_vars=shm_max_vars,
            parse_max_hz=shm_parse_cap,
        )
        if shm_reader.start():
            # Hasta update_shm_read_pause() puede pasar mucho tiempo (list_names/list_vars enormes). Si _reads_paused
            # queda False, el hilo parsea SHM a ritmo C++ y dispara RSS; arrancar conservador y luego sincronizar.
            shm_reader.set_reads_paused(True)
            if getattr(shm_reader, "_polling_only", False):
                print(f"[VarMonitor Web] SHM activo (modo polling): {info['shm_name']} — {shm_reader._last_error or ''}", flush=True)
            else:
                qnote = "ilimitada" if qmax <= 0 else f"{qmax} snapshots (FIFO; llena → lector espera)"
                if shm_parse_cap is not None:
                    print(
                        f"[VarMonitor Web] SHM activo: {info['shm_name']} — cola {qnote}; solo monitorización ≤{shm_parse_cap:.0f} parseos/s "
                        f"(REC/alarmas a tasa completa; `shm_parse_max_hz=0` quita el tope)",
                        flush=True,
                    )
                else:
                    print(
                        f"[VarMonitor Web] SHM activo: {info['shm_name']} — cola {qnote} (sin tope Hz de parseo)",
                        flush=True,
                    )
        else:
            reason = getattr(shm_reader, "_last_error", None) or "desconocido"
            print(f"[VarMonitor Web] SHM no disponible: {reason}", flush=True)
            shm_reader = None
            shm_queue = None
    elif info:
        print("[VarMonitor Web] SHM no disponible: el proceso C++ no envió shm_name/sem_name (¿SHM inicializado con monitor.start()?)", flush=True)

    print(f"[VarMonitor Web] WebSocket conectado a C++ {connection_label}", flush=True)
    # Enviar lista real de variables al conectar. Si falla, no enviar [] (evita vaciar la UI);
    # el bucle principal reintentará en breve.
    try:
        names_list = await asyncio.to_thread(bridge.list_names)
        if not names_list:
            names_list = [v["name"] for v in await asyncio.to_thread(bridge.list_vars)]
        names_list = _merge_names_with_telemetry(names_list)
        await ws.send_json({"type": "vars_names", "data": names_list})
        last_names_send = time.monotonic()
    except Exception as e:
        print(f"[VarMonitor Web] Aviso: no se pudo obtener vars_names al conectar: {e}", flush=True)

    shm_drain_task: asyncio.Task | None = None
    last_alarm_uds_poll_at = 0.0

    async def _notify_alarm_events(cleared: list[str], triggered: list[dict]) -> None:
        if cleared:
            try:
                await ws.send_json({"type": "alarm_cleared", "names": cleared})
            except Exception:
                pass
        if not triggered:
            return
        await ws.send_json({
            "type": "alarm_triggered",
            "triggered": [{"name": t["name"], "reason": t["reason"], "value": t["value"]} for t in triggered],
        })

        async def _send_alarm_file_later():
            await asyncio.sleep(1.0)
            buf_now = list(alarm_buffer)
            if not buf_now:
                return
            _ensure_recordings_dir()
            from datetime import datetime
            fn = f"alarm_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tsv"
            path = os.path.join(RECORDINGS_DIR, fn)
            var_names = sorted(set(e["name"] for _, data in buf_now for e in data))
            if not var_names:
                var_names = ["time_s"]
            _write_snapshots_tsv(path, buf_now, var_names)
            msg = {"type": "alarm_recording_ready", "path": path, "filename": fn}
            if send_file_on_finish:
                try:
                    with open(path, "rb") as f:
                        import base64
                        msg["file_base64"] = base64.b64encode(f.read()).decode("ascii")
                except Exception:
                    pass
            try:
                await ws.send_json(msg)
            except Exception:
                pass

        asyncio.create_task(_send_alarm_file_later())

    async def _shm_drain_loop():
        """Task que drena la cola SHM a la frecuencia real (no ligada a receive_text)."""
        nonlocal latest_snapshot, shm_last_snap_ts, shm_cycle_ema_ms
        nonlocal alarm_buffer, prev_alarm_state, alarm_pending_since_ms
        nonlocal recording_tmp_fp, recording_tmp_path, recording_col_spec, recording_row_layout, recording_t0
        nonlocal recording_header_estimated, recording_rows_written, recording_size_est_bytes, last_record_progress_send_at

        async def _handle_snapshot_item(snapshot_item):
            nonlocal latest_snapshot, shm_last_snap_ts, shm_cycle_ema_ms
            nonlocal alarm_buffer, prev_alarm_state, alarm_pending_since_ms
            nonlocal recording_tmp_fp, recording_tmp_path, recording_col_spec, recording_row_layout, recording_t0
            nonlocal recording_header_estimated, recording_rows_written, recording_size_est_bytes, last_record_progress_send_at
            if isinstance(snapshot_item, dict):
                snapshot = snapshot_item.get("data")
                t_snap = float(snapshot_item.get("timestamp") or time.time())
            else:
                snapshot = snapshot_item
                t_snap = time.time()
            if not snapshot:
                return
            if shm_reader is not None and shm_reader.reads_paused():
                return
            if shm_last_snap_ts is not None:
                dt_ms = max(0.0, (t_snap - shm_last_snap_ts) * 1000.0)
                shm_cycle_ema_ms = dt_ms if shm_cycle_ema_ms is None else (shm_cycle_ema_ms * 0.85 + dt_ms * 0.15)
                ws.app.state.shm_cycle_ms = round(shm_cycle_ema_ms, 3)
            shm_last_snap_ts = t_snap
            # No es un buffer histórico: solo el último frame. Con alarmas/REC el snapshot debe ser
            # completo para evaluación y TSV. Si solo monitorizas, recortar a `monitored_names` libera
            # referencias a dicts de variables SHM que no están en el monitor (p. ej. 2048 vs 2000).
            if not alarms_config and not recording and monitored_names:
                mn = monitored_names
                latest_snapshot = [v for v in snapshot if (v.get("name") or "") in mn]
            else:
                latest_snapshot = snapshot
            if alarms_config:
                alarm_buffer.append((t_snap, snapshot))
                cutoff = t_snap - ALARM_BUFFER_SEC
                while alarm_buffer and alarm_buffer[0][0] < cutoff:
                    alarm_buffer.popleft()
            if alarms_config:
                prev_alarm_state, alarm_pending_since_ms, triggered, cleared = _evaluate_alarms(
                    snapshot, alarms_config, prev_alarm_state, alarm_pending_since_ms, int(t_snap * 1000)
                )
                await _notify_alarm_events(cleared, triggered)
            if recording:
                if recording_t0 is None:
                    recording_t0 = t_snap
                t_rel = 0.0 if (recording_rows_written_ref and recording_rows_written_ref[0] == 0) else max(0.0, t_snap - float(recording_t0))
                if recording_write_queue is not None:
                    recording_write_queue.put((t_rel, snapshot))
                    if recording_rows_written_ref and (t_snap - last_record_progress_send_at) >= 0.5:
                        last_record_progress_send_at = t_snap
                        try:
                            est_bytes = 0
                            if recording_tmp_path and os.path.isfile(recording_tmp_path):
                                try:
                                    est_bytes = int(os.path.getsize(recording_tmp_path))
                                except Exception:
                                    est_bytes = 0
                            await ws.send_json({
                                "type": "recording_progress",
                                "bytes": est_bytes,
                                "samples": recording_rows_written_ref[0],
                            })
                        except Exception:
                            pass
                else:
                    if recording_tmp_fp is None:
                        _ensure_recordings_dir()
                        recording_tmp_path = os.path.join(RECORDINGS_DIR, f".recording_{int(time.time() * 1000)}.tsv.part")
                        recording_tmp_fp = open(recording_tmp_path, "w", buffering=1024 * 1024)
                    if recording_col_spec is None:
                        names = recording_var_names or sorted(set(e["name"] for e in snapshot))
                        recording_col_spec = _build_record_col_spec(names, snapshot)
                        recording_row_layout = _record_row_layout(recording_col_spec)
                    if not recording_header_estimated and recording_col_spec:
                        recording_size_est_bytes += _write_record_header_stream(recording_tmp_fp, recording_col_spec)
                        recording_header_estimated = True
                    if recording_col_spec:
                        t_rel_local = 0.0 if recording_rows_written == 0 else max(0.0, t_snap - float(recording_t0))
                        recording_size_est_bytes += _write_record_row_stream(
                            recording_tmp_fp, t_rel_local, snapshot, recording_col_spec, recording_row_layout
                        )
                        recording_rows_written += 1
                    if (t_snap - last_record_progress_send_at) >= 0.5:
                        last_record_progress_send_at = t_snap
                        try:
                            await ws.send_json({
                                "type": "recording_progress",
                                "bytes": int(max(0, recording_size_est_bytes)),
                                "samples": recording_rows_written,
                            })
                        except Exception:
                            pass

        while True:
            batch: list = []
            try:
                while True:
                    batch.append(shm_queue.get_nowait())
            except Empty:
                pass
            if not batch:
                if shm_reader is not None and shm_reader.reads_paused():
                    await asyncio.sleep(15.0)
                else:
                    await asyncio.sleep(0.004)
                continue
            # Solo monitorización: el navegador ya recibe vars_update a tasa baja; procesar toda la
            # cola por frame satura la CPU si C++ publica más rápido que este bucle.
            if not alarms_config and not recording:
                batch = batch[-1:]
            for bi, snapshot_item in enumerate(batch):
                if bi > 0 and (bi & 31) == 0:
                    await asyncio.sleep(0)
                await _handle_snapshot_item(snapshot_item)

    def update_shm_read_pause() -> None:
        """Sin monitor ni grabación: no parsear SHM (las alarmas sin monitor usan get_var acotado en el bucle principal)."""
        nonlocal latest_snapshot
        if not shm_reader:
            return
        idle = not monitored_names and not recording
        shm_reader.set_reads_paused(bool(idle))
        # Grabación y alarmas: sin tope Hz (cada snapshot que entrega el lector SHM). Solo UI usa shm_parse_max_hz.
        shm_reader.set_full_parse_rate(bool(alarms_config or recording))
        if idle:
            latest_snapshot = None

    if shm_reader and shm_queue is not None:
        shm_drain_task = asyncio.create_task(_shm_drain_loop())
        update_shm_read_pause()

    ws_id = id(ws)
    if not hasattr(ws.app.state, "ws_monitored_counts"):
        ws.app.state.ws_monitored_counts = {}
    ws.app.state.ws_monitored_counts[ws_id] = len(monitored_names)

    try:
        while True:
            try:
                now = time.monotonic()

                catalog_idle = not monitored_names and not recording
                refresh_iv = names_refresh_interval_idle if catalog_idle else names_refresh_interval
                # Sesión idle y catálogo ya enviado: no list_names/list_vars periódicos (evita RSS por asignaciones enormes).
                if last_names_send is None:
                    need_catalog = True
                elif catalog_idle:
                    need_catalog = False
                else:
                    need_catalog = now - last_names_send >= refresh_iv
                if need_catalog:
                    try:
                        names_list = await asyncio.to_thread(bridge.list_names)
                        if not names_list:
                            names_list = [v["name"] for v in await asyncio.to_thread(bridge.list_vars)]
                        names_list = _merge_names_with_telemetry(names_list)
                        await ws.send_json({"type": "vars_names", "data": names_list})
                    except Exception as e:
                        print(f"[VarMonitor Web] Aviso: vars_names periódico falló: {e}", flush=True)
                    finally:
                        # Siempre espaciar reintentos (incluso si falla UDS o send_json) para no crecer la RAM.
                        last_names_send = now

                if (
                    shm_reader
                    and shm_queue is not None
                    and alarms_config
                    and not monitored_names
                    and not recording
                    and (now - last_alarm_uds_poll_at >= ALARM_UDS_POLL_SEC)
                ):
                    last_alarm_uds_poll_at = now
                    snapshot_alarm: list[dict] = []
                    for aname in alarms_config:
                        if aname in VARMON_TELEMETRY_NAME_SET:
                            snapshot_alarm.extend(_telemetry_snapshot_rows({aname}, ws.app.state))
                            continue
                        vinfo = await asyncio.to_thread(bridge.get_var, aname)
                        if vinfo:
                            snapshot_alarm.append(vinfo)
                    if snapshot_alarm:
                        t_snap = time.time()
                        alarm_buffer.append((t_snap, snapshot_alarm))
                        cutoff = t_snap - ALARM_BUFFER_SEC
                        while alarm_buffer and alarm_buffer[0][0] < cutoff:
                            alarm_buffer.popleft()
                        prev_alarm_state, alarm_pending_since_ms, triggered, cleared = _evaluate_alarms(
                            snapshot_alarm, alarms_config, prev_alarm_state, alarm_pending_since_ms, int(t_snap * 1000)
                        )
                        await _notify_alarm_events(cleared, triggered)

                if shm_reader and shm_queue is not None:
                    # Cola SHM la drena _shm_drain_loop en segundo plano. Aquí solo envío visual a tasa baja.
                    interval_between_updates = update_ratio * cycle_interval_sec
                    if monitored_names and (now - last_vars_update_at >= interval_between_updates):
                        last_vars_update_at = now
                        name_set = set(monitored_names)
                        pack, should_send = _merge_shm_and_telemetry_vars_updates(
                            latest_snapshot,
                            name_set,
                            ws.app.state,
                            vars_update_sig_cache,
                            force_full_vars_update,
                        )
                        if should_send:
                            await ws.send_json({"type": "vars_update", "data": pack})
                            if force_full_vars_update:
                                shm_only = {n for n in name_set if n not in VARMON_TELEMETRY_NAME_SET}
                                shm_sent = {
                                    v["name"]
                                    for v in pack
                                    if (v.get("name") or "") not in VARMON_TELEMETRY_NAME_SET
                                }
                                if not shm_only or shm_only.issubset(shm_sent):
                                    force_full_vars_update = False
                else:
                    # Sin SHM: tomar snapshot completo cada ciclo (backend-first para alarmas/grabación).
                    if monitored_names:
                        snapshot_now: list[dict] = []
                        for name in monitored_names:
                            if name in VARMON_TELEMETRY_NAME_SET:
                                continue
                            vinfo = await asyncio.to_thread(bridge.get_var, name)
                            if vinfo:
                                snapshot_now.append(vinfo)
                        snapshot_now.extend(_telemetry_snapshot_rows(set(monitored_names), ws.app.state))
                        if snapshot_now:
                            t_snap = time.time()
                            latest_snapshot = snapshot_now
                            if alarms_config:
                                alarm_buffer.append((t_snap, snapshot_now))
                                cutoff = t_snap - ALARM_BUFFER_SEC
                                while alarm_buffer and alarm_buffer[0][0] < cutoff:
                                    alarm_buffer.popleft()
                                prev_alarm_state, alarm_pending_since_ms, triggered, cleared = _evaluate_alarms(
                                    snapshot_now, alarms_config, prev_alarm_state, alarm_pending_since_ms, int(t_snap * 1000)
                                )
                                await _notify_alarm_events(cleared, triggered)
                            if recording:
                                if recording_tmp_fp is None:
                                    _ensure_recordings_dir()
                                    recording_tmp_path = os.path.join(RECORDINGS_DIR, f".recording_{int(time.time() * 1000)}.tsv.part")
                                    recording_tmp_fp = open(recording_tmp_path, "w", buffering=1024 * 1024)
                                if recording_col_spec is None:
                                    names = recording_var_names or sorted(set(e["name"] for e in snapshot_now))
                                    recording_col_spec = _build_record_col_spec(names, snapshot_now)
                                    recording_row_layout = _record_row_layout(recording_col_spec)
                                if recording_t0 is None:
                                    recording_t0 = t_snap
                                if not recording_header_estimated and recording_col_spec:
                                    recording_size_est_bytes += _write_record_header_stream(recording_tmp_fp, recording_col_spec)
                                    recording_header_estimated = True
                                if recording_col_spec:
                                    # Tiempo relativo: primera fila siempre 0.0
                                    t_rel = 0.0 if recording_rows_written == 0 else max(0.0, t_snap - float(recording_t0))
                                    recording_size_est_bytes += _write_record_row_stream(
                                        recording_tmp_fp, t_rel, snapshot_now, recording_col_spec, recording_row_layout
                                    )
                                    recording_rows_written += 1
                                if (t_snap - last_record_progress_send_at) >= 0.5:
                                    last_record_progress_send_at = t_snap
                                    try:
                                        await ws.send_json({
                                            "type": "recording_progress",
                                            "bytes": int(max(0, recording_size_est_bytes)),
                                            "samples": int(max(0, recording_rows_written)),
                                        })
                                    except Exception:
                                        pass
                    # Envío visual a tasa reducida.
                    interval_between_updates = update_ratio * cycle_interval_sec
                    if monitored_names and (now - last_vars_update_at >= interval_between_updates):
                        last_vars_update_at = now
                        name_set = set(monitored_names)
                        pack, should_send = _merge_shm_and_telemetry_vars_updates(
                            latest_snapshot,
                            name_set,
                            ws.app.state,
                            vars_update_sig_cache,
                            force_full_vars_update,
                        )
                        if should_send:
                            await ws.send_json({"type": "vars_update", "data": pack})
                            if force_full_vars_update:
                                shm_only = {n for n in name_set if n not in VARMON_TELEMETRY_NAME_SET}
                                shm_sent = {
                                    v["name"]
                                    for v in pack
                                    if (v.get("name") or "") not in VARMON_TELEMETRY_NAME_SET
                                }
                                if not shm_only or shm_only.issubset(shm_sent):
                                    force_full_vars_update = False

            except Exception as e:
                msg_err = str(e)
                ws_already_closed = (
                    isinstance(e, WebSocketDisconnect)
                    or (isinstance(e, RuntimeError) and (
                        "close message has been sent" in msg_err
                        or "WebSocket is not connected" in msg_err
                    ))
                )
                if ws_already_closed:
                    print(f"[VarMonitor Web] WebSocket cerrado mientras se enviaban datos (C++ {connection_label}).", flush=True)
                    break
                print(f"[VarMonitor Web] WebSocket error (C++ {connection_label}): {e}", flush=True)
                import traceback
                traceback.print_exc()
                try:
                    await ws.send_json({"type": "error", "message": msg_err})
                except Exception as send_err:
                    print(f"[VarMonitor Web] No se pudo enviar error al cliente: {send_err}", flush=True)

            try:
                # Sin monitor/alarmas/REC: receive_text() bloqueante (sin asyncio.wait_for) evita crear/cancelar
                # una tarea interna en cada timeout; con timeouts cortos eso puede inflar RSS del proceso.
                ws_fully_idle = not monitored_names and not recording and not alarms_config
                if ws_fully_idle:
                    msg = await ws.receive_text()
                else:
                    recv_timeout = cycle_interval_sec
                    if recording and shm_reader and shm_queue is not None:
                        recv_timeout = min(cycle_interval_sec, 0.005)  # 5 ms
                    msg = await asyncio.wait_for(ws.receive_text(), timeout=recv_timeout)
                cmd = json.loads(msg)
                action = cmd.get("action")

                if action == "set_update_ratio":
                    max_r = _config.get("update_ratio_max", 100)
                    v = int(cmd.get("value", 1))
                    update_ratio = max(1, min(max_r, v))
                elif action == "set_monitored":
                    monitored_names = set(cmd.get("names", []))
                    force_full_vars_update = True
                    ws.app.state.ws_monitored_counts[ws_id] = len(monitored_names)
                    # Fase 2: suscripción SHM para que C++ solo escriba estas vars
                    try:
                        sub_real = [n for n in monitored_names if n not in VARMON_TELEMETRY_NAME_SET]
                        await asyncio.to_thread(bridge.set_shm_subscription, sub_real)
                    except Exception:
                        pass
                    update_shm_read_pause()
                # Historial en vivo eliminado: se mantiene solo vía SHM y grabaciones TSV.
                elif action == "set_var":
                    sn = cmd.get("name") or ""
                    if sn in VARMON_TELEMETRY_NAME_SET:
                        await ws.send_json({"type": "set_result", "success": False, "name": sn})
                    else:
                        ok = await asyncio.to_thread(
                            bridge.set_var, sn, cmd["value"], cmd.get("var_type", "double")
                        )
                        await ws.send_json({"type": "set_result", "success": ok, "name": sn})
                elif action == "set_array_element":
                    sn = cmd.get("name") or ""
                    if sn in VARMON_TELEMETRY_NAME_SET:
                        await ws.send_json({"type": "set_result", "success": False, "name": sn})
                    else:
                        ok = await asyncio.to_thread(
                            bridge.set_array_element, sn, int(cmd["index"]), float(cmd["value"])
                        )
                        await ws.send_json({"type": "set_result", "success": ok, "name": sn})
                elif action == "refresh_names":
                    names_list = await asyncio.to_thread(bridge.list_names)
                    if not names_list:
                        names_list = [v["name"] for v in await asyncio.to_thread(bridge.list_vars)]
                    names_list = _merge_names_with_telemetry(names_list)
                    await ws.send_json({"type": "vars_names", "data": names_list})
                    last_names_send = time.monotonic()
                elif action == "set_alarms":
                    ac = cmd.get("alarms")
                    if isinstance(ac, dict):
                        alarms_config.clear()
                        prev_alarm_state.clear()
                        alarm_pending_since_ms.clear()
                        for k, v in ac.items():
                            if isinstance(v, dict) and (v.get("lo") is not None or v.get("hi") is not None):
                                alarms_config[k] = {
                                    "lo": v.get("lo"),
                                    "hi": v.get("hi"),
                                    "hys": v.get("hys"),
                                    "delayMs": v.get("delayMs"),
                                }
                    update_shm_read_pause()
                elif action == "set_send_file_on_finish":
                    send_file_on_finish = bool(cmd.get("value", False))
                elif action == "start_recording":
                    recording = True
                    record_buffer.clear()
                    recording_var_names = list(monitored_names) if monitored_names else None
                    recording_size_est_bytes = 0
                    recording_header_estimated = False
                    last_record_progress_send_at = 0.0
                    recording_col_spec = None
                    recording_row_layout = None
                    recording_rows_written = 0
                    recording_t0 = None
                    if recording_writer_thread is not None:
                        if recording_write_queue:
                            recording_write_queue.put(None)
                        recording_writer_thread.join(timeout=2.0)
                        recording_writer_thread = None
                    recording_write_queue = None
                    recording_rows_written_ref = None
                    if recording_tmp_fp is not None:
                        try:
                            recording_tmp_fp.close()
                        except Exception:
                            pass
                    recording_tmp_fp = None
                    if recording_tmp_path and os.path.isfile(recording_tmp_path):
                        try:
                            os.remove(recording_tmp_path)
                        except Exception:
                            pass
                    recording_tmp_path = None
                    if shm_reader and shm_queue is not None:
                        _ensure_recordings_dir()
                        recording_tmp_path = os.path.join(RECORDINGS_DIR, f".recording_{int(time.time() * 1000)}.tsv.part")
                        recording_write_queue = Queue()
                        recording_rows_written_ref = [0]
                        recording_writer_thread = threading.Thread(
                            target=_recording_writer_thread,
                            args=(recording_write_queue, recording_tmp_path, recording_var_names, recording_rows_written_ref),
                            daemon=True,
                        )
                        recording_writer_thread.start()
                    try:
                        await ws.send_json({"type": "recording_progress", "bytes": 0, "samples": 0})
                    except Exception:
                        pass
                    update_shm_read_pause()
                elif action == "stop_recording":
                    recording = False
                    if recording_write_queue is not None and recording_writer_thread is not None:
                        recording_write_queue.put(None)
                        recording_writer_thread.join(timeout=5.0)
                        recording_writer_thread = None
                        if recording_rows_written_ref:
                            recording_rows_written = recording_rows_written_ref[0]
                        recording_write_queue = None
                        recording_rows_written_ref = None
                    if recording_tmp_fp is not None:
                        try:
                            recording_tmp_fp.flush()
                        except Exception:
                            pass
                        try:
                            recording_tmp_fp.close()
                        except Exception:
                            pass
                    recording_tmp_fp = None
                    path_saved, fn_saved, size_saved = _finalize_recording_temp_file(recording_tmp_path, recording_rows_written)
                    if not path_saved and record_buffer:
                        path_saved, fn_saved, size_saved = _flush_record_buffer_to_tsv(record_buffer, recording_var_names)
                    recording_tmp_path = None
                    msg = {"type": "record_finished", "path": path_saved or "", "filename": fn_saved or ""}
                    if path_saved:
                        msg["size_bytes"] = int(size_saved if size_saved > 0 else max(0, recording_size_est_bytes))
                    if path_saved and send_file_on_finish:
                        try:
                            with open(path_saved, "rb") as f:
                                import base64
                                msg["file_base64"] = base64.b64encode(f.read()).decode("ascii")
                        except Exception:
                            pass
                    if not path_saved:
                        msg["message"] = "No se registraron datos (¿C++ con SHM activo?)."
                    try:
                        await ws.send_json(msg)
                    except Exception:
                        pass
                    record_buffer.clear()
                    recording_var_names = None
                    recording_size_est_bytes = 0
                    recording_header_estimated = False
                    last_record_progress_send_at = 0.0
                    recording_col_spec = None
                    recording_row_layout = None
                    recording_rows_written = 0
                    recording_t0 = None
                    update_shm_read_pause()
            except asyncio.TimeoutError:
                pass
            except WebSocketDisconnect:
                print(f"[VarMonitor Web] WebSocket desconectado por el cliente durante receive (C++ {connection_label})", flush=True)
                break
            except RuntimeError as e:
                if "WebSocket is not connected" in str(e):
                    print(f"[VarMonitor Web] WebSocket no conectado durante receive (C++ {connection_label})", flush=True)
                    break
                raise
    except WebSocketDisconnect:
        print(f"[VarMonitor Web] WebSocket desconectado por el cliente (C++ {connection_label})", flush=True)
    finally:
        if shm_drain_task is not None:
            shm_drain_task.cancel()
            try:
                await shm_drain_task
            except asyncio.CancelledError:
                pass
        if recording_write_queue is not None and recording_writer_thread is not None:
            try:
                recording_write_queue.put(None)
                recording_writer_thread.join(timeout=5.0)
            except Exception:
                pass
            if recording_rows_written_ref:
                recording_rows_written = recording_rows_written_ref[0]
            recording_write_queue = None
            recording_writer_thread = None
            recording_rows_written_ref = None
        if recording and (record_buffer or recording_rows_written > 0 or recording_tmp_path):
            try:
                if recording_tmp_fp is not None:
                    try:
                        recording_tmp_fp.flush()
                    except Exception:
                        pass
                    try:
                        recording_tmp_fp.close()
                    except Exception:
                        pass
                    recording_tmp_fp = None
                path_saved, fn_saved, size_saved = _finalize_recording_temp_file(recording_tmp_path, recording_rows_written)
                if not path_saved:
                    path_saved, fn_saved, size_saved = _flush_record_buffer_to_tsv(record_buffer, recording_var_names)
                print(
                    f"[VarMonitor Web] REC salvado por cierre de WS: {fn_saved} "
                    f"({size_saved} bytes) en {path_saved}",
                    flush=True,
                )
            except Exception as e:
                print(f"[VarMonitor Web] No se pudo salvar REC al cerrar WS: {e}", flush=True)
        if shm_reader:
            shm_reader.stop()
        counts = getattr(ws.app.state, "ws_monitored_counts", None)
        if isinstance(counts, dict):
            counts.pop(ws_id, None)
        ACTIVE_WS -= 1
        bridge.disconnect()
        print(f"[VarMonitor Web] WebSocket cerrado (C++ {connection_label})", flush=True)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Documentación MkDocs: site/ (ES) y site_en/ (EN) en la raíz del proyecto
_DOCS_ES_DIR = os.path.join(os.path.dirname(__file__), "..", "site")
_DOCS_EN_DIR = os.path.join(os.path.dirname(__file__), "..", "site_en")
_DOCS_HAS_ES = os.path.isdir(_DOCS_ES_DIR)
_DOCS_HAS_EN = os.path.isdir(_DOCS_EN_DIR)

_DOCS_NOT_BUILT_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>Documentation</title></head><body style="font-family:sans-serif;padding:2rem;max-width:640px">
    <h1>Documentation not built</h1>
    <p>From the project root, run:</p>
    <pre>pip install mkdocs mkdocs-material
mkdocs build
mkdocs build -f mkdocs.en.yml</pre>
    <p>Then restart the monitor. Spanish will be at <a href="/docs/es/">/docs/es/</a>, English at <a href="/docs/en/">/docs/en/</a>.</p>
    </body></html>"""


@app.get("/api/docs_languages", include_in_schema=False)
async def api_docs_languages():
    """Which MkDocs site folders exist (for the Docs language picker in the UI)."""
    return {"es": _DOCS_HAS_ES, "en": _DOCS_HAS_EN}


if _DOCS_HAS_ES or _DOCS_HAS_EN:
    if _DOCS_HAS_ES:
        app.mount("/docs/es", StaticFiles(directory=_DOCS_ES_DIR, html=True), name="docs_es")
    if _DOCS_HAS_EN:
        app.mount("/docs/en", StaticFiles(directory=_DOCS_EN_DIR, html=True), name="docs_en")

    @app.get("/docs", include_in_schema=False)
    @app.get("/docs/", include_in_schema=False)
    async def _docs_redirect_root():
        if _DOCS_HAS_ES:
            return RedirectResponse(url="/docs/es/", status_code=302)
        return RedirectResponse(url="/docs/en/", status_code=302)

else:

    @app.get("/docs")
    async def _docs_not_built_root():
        return HTMLResponse(_DOCS_NOT_BUILT_HTML)

    @app.get("/docs/{full_path:path}")
    async def _docs_not_built(full_path: str):
        return HTMLResponse(_DOCS_NOT_BUILT_HTML)

def _find_available_port(host: str, start_port: int, max_offset: int = 10) -> int:
    """Intenta bind en start_port, start_port+1, ... hasta start_port+max_offset. Devuelve el primero libre."""
    for offset in range(max_offset + 1):
        port = start_port + offset
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((host, port))
                return port
        except OSError:
            continue
    raise RuntimeError(
        f"[VarMonitor Web] Error: no hay puertos libres en rango [{start_port}, {start_port + max_offset}]"
    )


class _SuppressAdvancedStatsAccessLog(logging.Filter):
    """No registrar en access log las peticiones OK a /api/advanced_stats (solo errores)."""
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "/api/advanced_stats" in msg and " 200 " in msg:
            return False
        return True


# Aplicar filtro al cargar el módulo para que funcione con "python app.py" y "uvicorn app:app"
logging.getLogger("uvicorn.access").addFilter(_SuppressAdvancedStatsAccessLog())

if __name__ == "__main__":
    import uvicorn

    base_port = _config["web_port"]
    lan_ip = _config["lan_ip"]
    bind_host = (_config.get("bind_host") or "").strip()
    listen_host = bind_host if bind_host else "0.0.0.0"

    port = _find_available_port(listen_host, base_port, int(_config.get("web_port_scan_max", 10)))
    app.state.actual_web_port = port
    app.state.startup_time = time.monotonic()

    print(f"[VarMonitor Web] Servidor escuchando en puerto {port}")
    print(f"  http://localhost:{port}         (local)")
    if bind_host:
        print(f"  Escuchando solo en {bind_host} (bind_host)")
    elif lan_ip:
        print(f"  http://{lan_ip}:{port}    (red)")
    uvicorn.run(app, host=listen_host, port=port)
