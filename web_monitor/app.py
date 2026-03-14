"""FastAPI backend for VarMonitor web interface."""

import asyncio
import json
import os
import resource
import socket
import time
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from tcp_client import TcpBridge

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

DEFAULTS = {
    "tcp_port": 9100,
    "web_port": 8080,
    "host": "localhost",
    "lan_ip": "",
    "bind_host": "",  # Si se define (ej. IP de Red1), solo se escucha en esa interfaz; vacío = 0.0.0.0
    "auth_password": "",  # Si se define, el WebSocket exige ?password=... correcto
    "poll_interval_min_ms": 5,   # Mínimo permitido para Poll (ms) en el monitor
    "poll_interval_ms": 200,     # Valor por defecto de Poll (ms) si el usuario no tiene preferencia guardada
}


def load_config() -> dict:
    """Read varmon.conf (key = value). No external dependencies."""
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
                if key in ("tcp_port", "web_port", "poll_interval_min_ms", "poll_interval_ms"):
                    cfg[key] = int(val)
                elif key in ("host", "lan_ip", "bind_host", "auth_password"):
                    cfg[key] = val
        print(f"[VarMonitor Web] Config cargada desde {os.path.abspath(path)}")
        if (cfg.get("auth_password") or "").strip():
            print(f"[VarMonitor Web] Auth: activada (se requiere contraseña en el WebSocket)")
        else:
            print(f"[VarMonitor Web] Auth: desactivada")
    except FileNotFoundError:
        print(f"[VarMonitor Web] AVISO: No se encontro el archivo de configuracion.")
        print(f"  Buscado en: {os.path.abspath(path)}")
        print(f"  Usando valores por defecto (tcp_port={cfg['tcp_port']}, web_port={cfg['web_port']}, host={cfg['host']})")
        print(f"  Para cambiar la ruta:")
        print(f"    - Variable de entorno: VARMON_CONFIG=/ruta/a/varmon.conf")
        print(f"    - Colocar varmon.conf en el directorio de trabajo actual")
    return cfg


_config = load_config()

TCP_HOST_DEFAULT = _config["host"]
TCP_PORT_DEFAULT = _config["tcp_port"]


def get_default_tcp_port():
    """Puerto C++ por defecto: el preferido (último en rango al arrancar) si está definido, sino base de config."""
    return getattr(app.state, "preferred_tcp_port", None) or _config["tcp_port"]

# Numero de conexiones WebSocket activas
ACTIVE_WS = 0

# Intentos fallidos de contraseña; tras MAX_FAILED_AUTH el proceso se cierra
MAX_FAILED_AUTH = 3
FAILED_AUTH_ATTEMPTS = 0


# Tiempo sin C++ ni clientes tras el cual se cierra el proceso (segundos)
WATCHDOG_IDLE_SEC = 300  # 5 minutos

async def _watchdog_no_cpp():
    """Cierra el proceso si durante WATCHDOG_IDLE_SEC no hay C++ accesible ni clientes activos."""
    global ACTIVE_WS
    last_ok = time.monotonic()
    while True:
        await asyncio.sleep(5.0)
        # Si hay clientes conectados, no hacemos nada radical:
        # el usuario puede estar esperando a que arranque el C++.
        if ACTIVE_WS > 0:
            # Si hay al menos un cliente, intentamos actualizar last_ok si hay C++
            try:
                b = TcpBridge(TCP_HOST_DEFAULT, get_default_tcp_port(), timeout=0.5)
                _ = b.list_names()
                b.disconnect()
                last_ok = time.monotonic()
            except Exception:
                pass
            continue

        # Sin clientes: comprobamos si hay C++ accesible
        try:
            b = TcpBridge(TCP_HOST_DEFAULT, get_default_tcp_port(), timeout=0.5)
            _ = b.list_names()
            b.disconnect()
            last_ok = time.monotonic()
        except Exception:
            pass

        if time.monotonic() - last_ok > WATCHDOG_IDLE_SEC and ACTIVE_WS == 0:
            print(f"[VarMonitor Web] No se detecto ningun servidor C++ durante {WATCHDOG_IDLE_SEC}s y no hay clientes activos. Cerrando proceso.")
            os._exit(0)


def _scan_tcp_ports_max(host: str, start_port: int, max_offset: int = 10, timeout: float = 0.3) -> int | None:
    """Escanea [start_port, start_port+max_offset] y devuelve el mayor puerto activo (C++ VarMonitor), o None."""
    active: list[int] = []
    for offset in range(max_offset + 1):
        p = start_port + offset
        try:
            b = TcpBridge(host, p, timeout=timeout)
            _ = b.list_names()
            b.disconnect()
            active.append(p)
        except Exception:
            continue
    return max(active) if active else None


def _scan_tcp_ports_preferred_by_uptime(
    host: str, start_port: int, max_offset: int = 10, timeout: float = 0.4
) -> int | None:
    """Devuelve el puerto C++ con menor uptime (más reciente). Si ninguno expone uptime, fallback a mayor puerto."""
    candidates: list[tuple[int, float]] = []
    for offset in range(max_offset + 1):
        p = start_port + offset
        try:
            b = TcpBridge(host, p, timeout=timeout)
            uptime = b.get_uptime_seconds()
            b.disconnect()
            candidates.append((p, uptime if uptime is not None else float("inf")))
        except Exception:
            continue
    if not candidates:
        return None
    # Menor uptime = más reciente; desempate por puerto mayor
    return min(candidates, key=lambda x: (x[1], -x[0]))[0]


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
    ports_in_use = _scan_web_ports_list(base_web)
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
    # Puerto C++ por defecto = mismo índice que nuestro puerto web (8080→9100, 8081→9101, ...)
    if not hasattr(app.state, "preferred_tcp_port"):
        actual = getattr(app.state, "actual_web_port", None)
        base_web = _config["web_port"]
        base_tcp = _config["tcp_port"]
        if actual is not None:
            app.state.preferred_tcp_port = base_tcp + (actual - base_web)
    default_tcp = getattr(app.state, "preferred_tcp_port", None) or TCP_PORT_DEFAULT
    print(f"[VarMonitor Web] Config TCP por defecto: host={TCP_HOST_DEFAULT}, port={default_tcp}")
    # Lanzar watchdog en segundo plano
    asyncio.create_task(_watchdog_no_cpp())
    yield


app = FastAPI(title="VarMonitor", lifespan=lifespan)


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/vars")
async def api_list_vars():
    try:
        b = TcpBridge(TCP_HOST_DEFAULT, get_default_tcp_port())
        data = b.list_vars()
        b.disconnect()
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/var/{name:path}")
async def api_get_var(name: str):
    try:
        b = TcpBridge(TCP_HOST_DEFAULT, get_default_tcp_port())
        result = b.get_var(name)
        b.disconnect()
        if result is None:
            return JSONResponse({"error": "Variable no encontrada"}, status_code=404)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/var/{name:path}")
async def api_set_var(name: str, value: float = Query(...), var_type: str = Query("double")):
    try:
        b = TcpBridge(TCP_HOST_DEFAULT, get_default_tcp_port())
        ok = b.set_var(name, value, var_type)
        b.disconnect()
        return JSONResponse({"success": ok})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/history/{name:path}")
async def api_get_history(name: str):
    try:
        b = TcpBridge(TCP_HOST_DEFAULT, get_default_tcp_port())
        result = b.get_history(name)
        b.disconnect()
        if result is None:
            return JSONResponse({"error": "Variable no encontrada"}, status_code=404)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


def _do_scan_ports(host: str, start: int, end: int) -> dict:
    """Escaneo síncrono de puertos C++; se ejecuta en thread."""
    active: list[int] = []
    for p in range(start, end + 1):
        try:
            b = TcpBridge(host, p, timeout=0.3)
            _ = b.list_names()
            b.disconnect()
            active.append(p)
        except Exception:
            continue
    return {"host": host, "ports": active, "range": [start, end]}


@app.get("/api/scan_ports")
async def api_scan_ports(
    host: str = Query(TCP_HOST_DEFAULT),
    start: int | None = Query(None),
    end: int | None = Query(None),
    port: int | None = Query(None, description="Puerto actual; si se pasa, se escanea [port, port+10]"),
):
    """Escanea un rango de puertos para encontrar instancias activas de VarMonitor."""
    if start is not None and end is not None:
        pass
    elif port is not None and 1 <= port <= 65535:
        start = port
        end = min(65535, port + 10)
    else:
        start = TCP_PORT_DEFAULT
        end = TCP_PORT_DEFAULT + 10
    return await asyncio.to_thread(_do_scan_ports, host, start, end)


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


def _fetch_cpp_stats_sync(host: str, port: int, timeout: float = 1.0) -> tuple[float | None, float | None]:
    """Conecta al C++, pide server_info; devuelve (ram_mb, cpu_percent). (None, None) si falla."""
    try:
        bridge = TcpBridge(host, port, timeout=timeout)
        info = bridge.get_server_info()
        bridge.disconnect()
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
async def api_advanced_stats(
    request: Request,
    host: str | None = Query(None),
    port: int | None = Query(None),
):
    """RAM y CPU % del proceso Python; RAM del C++ (si se puede conectar). Para el panel Adv info."""
    state = request.app.state
    h = host or TCP_HOST_DEFAULT
    try:
        p = int(port) if port is not None else get_default_tcp_port()
    except (TypeError, ValueError):
        p = get_default_tcp_port()
    python_ram_mb = _get_process_ram_mb()
    python_cpu_percent = _get_python_cpu_percent(state)
    cpp_ram_mb, cpp_cpu_percent = await asyncio.to_thread(_fetch_cpp_stats_sync, h, p)
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
    """Devuelve puertos base y real del backend para detectar multi-instancia y comprobar coherencia web/C++."""
    state = request.app.state
    actual = getattr(state, "actual_web_port", None)
    if actual is None:
        actual = _config["web_port"]
    base_web = _config["web_port"]
    base_tcp = _config["tcp_port"]

    # Mayor puerto web en uso (cacheado); en thread para no bloquear el event loop
    max_web = getattr(state, "max_web_port_in_range", None)
    if max_web is None:
        max_web = await asyncio.to_thread(_scan_web_ports_max, base_web)
        if max_web is not None:
            state.max_web_port_in_range = max_web

    uptime = None
    if hasattr(state, "startup_time"):
        uptime = time.monotonic() - state.startup_time

    # Puerto sugerido = mayor en rango (evitamos HTTP a otros backends para no bloquear/cerrar conexiones)
    suggested_web_port = max_web if max_web is not None else actual

    out = {
        "base_web_port": base_web,
        "actual_web_port": actual,
        "base_tcp_port": base_tcp,
        "max_web_port_in_range": max_web,
        "suggested_web_port": suggested_web_port,
        "uptime_seconds": uptime,
        "poll_interval_min_ms": _config.get("poll_interval_min_ms", 5),
        "poll_interval_ms": _config.get("poll_interval_ms", 200),
    }
    preferred = getattr(state, "preferred_tcp_port", None)
    if preferred is not None:
        out["preferred_tcp_port"] = preferred
    return out


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

    interval = 0.2
    names_refresh_interval = 30.0
    monitored_names: set[str] = set()
    last_names_send = 0.0
    names_sent_once = False

    # Host y puerto seleccionados para esta conexion (por defecto: C++ preferido = último en rango)
    query_host = ws.query_params.get("host") or TCP_HOST_DEFAULT
    query_port = ws.query_params.get("port")
    try:
        tcp_port = int(query_port) if query_port is not None else get_default_tcp_port()
    except ValueError:
        tcp_port = get_default_tcp_port()

    try:
        bridge = TcpBridge(query_host, tcp_port)
    except Exception as e:
        print(f"[VarMonitor Web] No se pudo conectar al C++ {query_host}:{tcp_port}: {e}", flush=True)
        await ws.send_json({"type": "error", "message": f"No se pudo conectar a {query_host}:{tcp_port}: {e}"})
        await ws.close()
        ACTIVE_WS -= 1
        return

    print(f"[VarMonitor Web] WebSocket conectado a C++ {query_host}:{tcp_port}", flush=True)
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

                if monitored_names:
                    mon_data = []
                    for name in monitored_names:
                        vinfo = await asyncio.to_thread(bridge.get_var, name)
                        if vinfo:
                            mon_data.append(vinfo)
                    await ws.send_json({"type": "vars_update", "data": mon_data})

            except Exception as e:
                print(f"[VarMonitor Web] WebSocket error (C++ {query_host}:{tcp_port}): {e}", flush=True)
                import traceback
                traceback.print_exc()
                try:
                    await ws.send_json({"type": "error", "message": str(e)})
                except Exception as send_err:
                    print(f"[VarMonitor Web] No se pudo enviar error al cliente: {send_err}", flush=True)
                    # No hacer break: mantener conexión viva por si el cliente sigue ahí

            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=interval)
                cmd = json.loads(msg)
                action = cmd.get("action")

                if action == "set_interval":
                    min_sec = _config.get("poll_interval_min_ms", 5) / 1000.0
                    interval = max(min_sec, float(cmd["value"]))
                elif action == "set_monitored":
                    monitored_names = set(cmd.get("names", []))
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
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        print(f"[VarMonitor Web] WebSocket desconectado por el cliente (C++ {query_host}:{tcp_port})", flush=True)
    finally:
        ACTIVE_WS -= 1
        bridge.disconnect()
        print(f"[VarMonitor Web] WebSocket cerrado (C++ {query_host}:{tcp_port})", flush=True)


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


if __name__ == "__main__":
    import uvicorn

    base_port = _config["web_port"]
    lan_ip = _config["lan_ip"]
    bind_host = (_config.get("bind_host") or "").strip()
    listen_host = bind_host if bind_host else "0.0.0.0"

    port = _find_available_port(listen_host, base_port)
    app.state.actual_web_port = port
    app.state.startup_time = time.monotonic()
    # C++ preferente = mismo índice que nuestro puerto web (8080→base_tcp, 8081→base_tcp+1, ...)
    base_tcp = _config["tcp_port"]
    app.state.preferred_tcp_port = base_tcp + (port - base_port)

    print(f"[VarMonitor Web] Servidor escuchando en puerto {port} (tcp_port base={base_tcp} -> C++ preferido {app.state.preferred_tcp_port})")
    print(f"  http://localhost:{port}         (local)")
    if bind_host:
        print(f"  Escuchando solo en {bind_host} (bind_host)")
    elif lan_ip:
        print(f"  http://{lan_ip}:{port}    (red)")
    uvicorn.run(app, host=listen_host, port=port)
