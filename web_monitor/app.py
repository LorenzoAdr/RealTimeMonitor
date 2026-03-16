"""FastAPI backend for VarMonitor web interface."""

import asyncio
import getpass
import logging
import json
import os
import resource
import socket
import time
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

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
                elif key in ("lan_ip", "bind_host", "auth_password", "server_state_dir"):
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
                    _ = await asyncio.to_thread(b.list_names)
                    b.disconnect()
                    last_ok = time.monotonic()
            except Exception:
                pass
            continue
        try:
            inst = await asyncio.to_thread(_list_uds_instances, None)
            if inst:
                b = await asyncio.to_thread(UdsBridge, inst[0]["uds_path"], 0.5)
                _ = await asyncio.to_thread(b.list_names)
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not hasattr(app.state, "startup_time"):
        app.state.startup_time = time.monotonic()
    asyncio.create_task(_watchdog_no_cpp())
    yield


app = FastAPI(title="VarMonitor", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/vars")
async def api_list_vars():
    try:
        b = await asyncio.to_thread(_first_uds_bridge)
        if b is None:
            return JSONResponse({"error": "No hay instancias VarMonitor (UDS)"}, status_code=503)
        data = await asyncio.to_thread(b.list_vars)
        b.disconnect()
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/var/{name:path}")
async def api_get_var(name: str):
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
    try:
        b = await asyncio.to_thread(_first_uds_bridge)
        if b is None:
            return JSONResponse({"error": "No hay instancias VarMonitor (UDS)"}, status_code=503)
        result = await asyncio.to_thread(b.get_history, name)
        b.disconnect()
        if result is None:
            return JSONResponse({"error": "Variable no encontrada"}, status_code=404)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


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
TEMPLATES_DIR = os.path.join(STATE_ROOT_DIR, "templates")
SESSIONS_DIR = os.path.join(STATE_ROOT_DIR, "sessions")
ALARM_BUFFER_SEC = 11.0  # 10 s + 1 s para registro en alarma


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
            row_parts = [f"{t:.6f}"]
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
    var_by_name = {e["name"]: e for e in snapshot}
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


@app.get("/api/recordings/{filename}")
async def api_recording_download(filename: str):
    """Descarga segura de una grabación dentro de recordings/."""
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
    return FileResponse(path, media_type="text/tab-separated-values", filename=safe_name)


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


def _fetch_cpp_stats_sync(timeout: float = 1.0) -> tuple[float | None, float | None]:
    """Conecta al C++ por UDS, pide server_info; devuelve (ram_mb, cpu_percent). (None, None) si falla."""
    try:
        b = _first_uds_bridge()
        if b is None:
            return (None, None)
        info = b.get_server_info()
        b.disconnect()
        if info is None:
            return (None, None)
        ram_mb = None
        rss_kb = info.get("memory_rss_kb")
        if rss_kb is not None and rss_kb >= 0:
            ram_mb = rss_kb / 1024.0
        cpu_percent = info.get("cpu_percent")
        if cpu_percent is not None and isinstance(cpu_percent, (int, float)):
            cpu_percent = float(cpu_percent)
        else:
            cpu_percent = None
        return (ram_mb, cpu_percent)
    except Exception:
        pass
    return (None, None)


@app.get("/api/advanced_stats")
async def api_advanced_stats(request: Request):
    """RAM y CPU % del proceso Python; RAM del C++ (si se puede conectar por UDS)."""
    state = request.app.state
    python_ram_mb = _get_process_ram_mb()
    python_cpu_percent = _get_python_cpu_percent(state)
    cpp_ram_mb, cpp_cpu_percent = await asyncio.to_thread(_fetch_cpp_stats_sync)
    return {
        "python_ram_mb": python_ram_mb,
        "python_cpu_percent": python_cpu_percent,
        "cpp_ram_mb": cpp_ram_mb,
        "cpp_cpu_percent": cpp_cpu_percent,
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
    monitored_names: set[str] = set()
    last_names_send = 0.0
    names_sent_once = False
    # Alarmas y grabación (plan dos tasas)
    alarms_config: dict = {}  # { name: { lo, hi } }
    prev_alarm_state: dict = {}
    alarm_pending_since_ms: dict = {}
    recording = False
    record_buffer: list[tuple[float, list[dict]]] = []
    alarm_buffer: list[tuple[float, list[dict]]] = []  # ventana rodante ALARM_BUFFER_SEC
    latest_snapshot: list[dict] | None = None
    send_file_on_finish = False  # por defecto no enviar fichero al navegador
    recording_var_names: list[str] | None = None  # columnas para CSV (monitored al start)

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
        shm_queue = Queue()
        shm_reader = ShmReader(
            info["shm_name"], info["sem_name"], shm_queue, poll_interval=0.5
        )
        if shm_reader.start():
            print(f"[VarMonitor Web] SHM activo: {info['shm_name']} (vars_update por SHM)", flush=True)
        else:
            shm_reader = None
            shm_queue = None

    print(f"[VarMonitor Web] WebSocket conectado a C++ {connection_label}", flush=True)
    await ws.send_json({"type": "vars_names", "data": []})

    try:
        while True:
            try:
                now = time.monotonic()

                if not names_sent_once or (now - last_names_send >= names_refresh_interval):
                    names_list = await asyncio.to_thread(bridge.list_names)
                    if not names_list:
                        names_list = [v["name"] for v in await asyncio.to_thread(bridge.list_vars)]
                    await ws.send_json({"type": "vars_names", "data": names_list})
                    last_names_send = now
                    names_sent_once = True

                # Procesar cada snapshot de la cola (alarmas + buffers); envío visual a tasa baja
                if shm_reader and shm_queue is not None:
                    while True:
                        try:
                            snapshot = shm_queue.get_nowait()
                        except Empty:
                            break
                        if not snapshot:
                            continue
                        t_snap = time.time()
                        latest_snapshot = snapshot
                        # Buffer de alarma (ventana rodante 10s+1)
                        if alarms_config:
                            alarm_buffer.append((t_snap, snapshot))
                            cutoff = t_snap - ALARM_BUFFER_SEC
                            while alarm_buffer and alarm_buffer[0][0] < cutoff:
                                alarm_buffer.pop(0)
                        # Evaluar alarmas
                        if alarms_config:
                            prev_alarm_state, alarm_pending_since_ms, triggered, cleared = _evaluate_alarms(
                                snapshot, alarms_config, prev_alarm_state, alarm_pending_since_ms, int(t_snap * 1000)
                            )
                            if cleared:
                                try:
                                    await ws.send_json({"type": "alarm_cleared", "names": cleared})
                                except Exception:
                                    pass
                            if triggered:
                                await ws.send_json({
                                    "type": "alarm_triggered",
                                    "triggered": [{"name": t["name"], "reason": t["reason"], "value": t["value"]} for t in triggered],
                                })
                                # Programar escritura y notificación del fichero de alarma 1 s después (10s antes + 1s después)
                                async def send_alarm_file_later():
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
                                asyncio.create_task(send_alarm_file_later())
                        # Buffer de grabación manual
                        if recording:
                            record_buffer.append((t_snap, snapshot))
                    # Envío visual a tasa baja (throttle)
                    interval_between_updates = update_ratio * cycle_interval_sec
                    if monitored_names and latest_snapshot is not None and (now - last_vars_update_at >= interval_between_updates):
                        last_vars_update_at = now
                        name_set = set(monitored_names)
                        mon_data = [v for v in latest_snapshot if v["name"] in name_set]
                        await ws.send_json({"type": "vars_update", "data": mon_data})
                else:
                    # Sin SHM: tomar snapshot completo cada ciclo (backend-first para alarmas/grabación).
                    if monitored_names:
                        snapshot_now: list[dict] = []
                        for name in monitored_names:
                            vinfo = await asyncio.to_thread(bridge.get_var, name)
                            if vinfo:
                                snapshot_now.append(vinfo)
                        if snapshot_now:
                            t_snap = time.time()
                            latest_snapshot = snapshot_now
                            if alarms_config:
                                alarm_buffer.append((t_snap, snapshot_now))
                                cutoff = t_snap - ALARM_BUFFER_SEC
                                while alarm_buffer and alarm_buffer[0][0] < cutoff:
                                    alarm_buffer.pop(0)
                                prev_alarm_state, alarm_pending_since_ms, triggered, cleared = _evaluate_alarms(
                                    snapshot_now, alarms_config, prev_alarm_state, alarm_pending_since_ms, int(t_snap * 1000)
                                )
                                if cleared:
                                    try:
                                        await ws.send_json({"type": "alarm_cleared", "names": cleared})
                                    except Exception:
                                        pass
                                if triggered:
                                    await ws.send_json({
                                        "type": "alarm_triggered",
                                        "triggered": [{"name": t["name"], "reason": t["reason"], "value": t["value"]} for t in triggered],
                                    })
                                    # Programar escritura y notificación del fichero de alarma 1 s después.
                                    async def send_alarm_file_later_fallback():
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
                                    asyncio.create_task(send_alarm_file_later_fallback())
                            if recording:
                                record_buffer.append((t_snap, snapshot_now))
                    # Envío visual a tasa reducida.
                    interval_between_updates = update_ratio * cycle_interval_sec
                    if monitored_names and latest_snapshot is not None and (now - last_vars_update_at >= interval_between_updates):
                        last_vars_update_at = now
                        await ws.send_json({"type": "vars_update", "data": latest_snapshot})

            except Exception as e:
                print(f"[VarMonitor Web] WebSocket error (C++ {connection_label}): {e}", flush=True)
                import traceback
                traceback.print_exc()
                try:
                    await ws.send_json({"type": "error", "message": str(e)})
                except Exception as send_err:
                    print(f"[VarMonitor Web] No se pudo enviar error al cliente: {send_err}", flush=True)
                    # No hacer break: mantener conexión viva por si el cliente sigue ahí

            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=cycle_interval_sec)
                cmd = json.loads(msg)
                action = cmd.get("action")

                if action == "set_update_ratio":
                    max_r = _config.get("update_ratio_max", 100)
                    v = int(cmd.get("value", 1))
                    update_ratio = max(1, min(max_r, v))
                elif action == "set_monitored":
                    monitored_names = set(cmd.get("names", []))
                    # Fase 2: suscripción SHM para que C++ solo escriba estas vars
                    try:
                        await asyncio.to_thread(bridge.set_shm_subscription, list(monitored_names))
                    except Exception:
                        pass
                elif action == "get_history":
                    hist = await asyncio.to_thread(bridge.get_history, cmd["name"])
                    await ws.send_json({"type": "history", "data": hist})
                elif action == "get_histories":
                    since_seq = cmd.get("since_seq")
                    if since_seq is not None:
                        result = await asyncio.to_thread(
                            bridge.get_histories_since, cmd.get("names", []), int(since_seq)
                        )
                        await ws.send_json({"type": "histories", "seq": result["seq"], "data": result["data"]})
                    else:
                        hists = await asyncio.to_thread(bridge.get_histories, cmd.get("names", []))
                        await ws.send_json({"type": "histories", "data": hists})
                elif action == "set_var":
                    ok = await asyncio.to_thread(
                        bridge.set_var, cmd["name"], cmd["value"], cmd.get("var_type", "double")
                    )
                    await ws.send_json({"type": "set_result", "success": ok, "name": cmd["name"]})
                elif action == "set_array_element":
                    ok = await asyncio.to_thread(
                        bridge.set_array_element, cmd["name"], int(cmd["index"]), float(cmd["value"])
                    )
                    await ws.send_json({"type": "set_result", "success": ok, "name": cmd["name"]})
                elif action == "refresh_names":
                    names_list = await asyncio.to_thread(bridge.list_names)
                    if not names_list:
                        names_list = [v["name"] for v in await asyncio.to_thread(bridge.list_vars)]
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
                elif action == "set_send_file_on_finish":
                    send_file_on_finish = bool(cmd.get("value", False))
                elif action == "start_recording":
                    recording = True
                    record_buffer.clear()
                    recording_var_names = list(monitored_names) if monitored_names else None
                elif action == "stop_recording":
                    recording = False
                    path_saved = None
                    fn_saved = None
                    if record_buffer:
                        _ensure_recordings_dir()
                        from datetime import datetime
                        fn_saved = f"record_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tsv"
                        path_saved = os.path.join(RECORDINGS_DIR, fn_saved)
                        var_names = recording_var_names or sorted(set(e["name"] for _, data in record_buffer for e in data))
                        _write_snapshots_tsv(path_saved, record_buffer, var_names)
                    msg = {"type": "record_finished", "path": path_saved or "", "filename": fn_saved or ""}
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
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        print(f"[VarMonitor Web] WebSocket desconectado por el cliente (C++ {connection_label})", flush=True)
    finally:
        if shm_reader:
            shm_reader.stop()
        ACTIVE_WS -= 1
        bridge.disconnect()
        print(f"[VarMonitor Web] WebSocket cerrado (C++ {connection_label})", flush=True)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

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
