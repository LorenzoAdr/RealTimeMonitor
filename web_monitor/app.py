"""FastAPI backend for VarMonitor web interface."""

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from tcp_client import TcpBridge

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

DEFAULTS = {"tcp_port": 9100, "web_port": 8080, "host": "localhost", "lan_ip": ""}


def load_config() -> dict:
    """Read varmon.conf (key = value). No external dependencies."""
    cfg = dict(DEFAULTS)
    path = os.environ.get("VARMON_CONFIG", "varmon.conf")
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
                if key in ("tcp_port", "web_port"):
                    cfg[key] = int(val)
                elif key in ("host", "lan_ip"):
                    cfg[key] = val
        print(f"[VarMonitor Web] Config cargada desde {path}")
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

# Numero de conexiones WebSocket activas
ACTIVE_WS = 0


async def _watchdog_no_cpp():
    """Cierra el proceso si durante ~60s no hay C++ accesible ni clientes activos."""
    global ACTIVE_WS
    last_ok = time.monotonic()
    while True:
        await asyncio.sleep(5.0)
        # Si hay clientes conectados, no hacemos nada radical:
        # el usuario puede estar esperando a que arranque el C++.
        if ACTIVE_WS > 0:
            # Si hay al menos un cliente, intentamos actualizar last_ok si hay C++
            try:
                b = TcpBridge(TCP_HOST_DEFAULT, TCP_PORT_DEFAULT, timeout=0.5)
                _ = b.list_names()
                b.disconnect()
                last_ok = time.monotonic()
            except Exception:
                pass
            continue

        # Sin clientes: comprobamos si hay C++ accesible
        try:
            b = TcpBridge(TCP_HOST_DEFAULT, TCP_PORT_DEFAULT, timeout=0.5)
            _ = b.list_names()
            b.disconnect()
            last_ok = time.monotonic()
        except Exception:
            pass

        if time.monotonic() - last_ok > 60.0 and ACTIVE_WS == 0:
            print("[VarMonitor Web] No se detecto ningun servidor C++ durante 60s y no hay clientes activos. Cerrando proceso.")
            os._exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # No creamos conexion TCP global; cada peticion/WS crea su propio TcpBridge.
    print(f"[VarMonitor Web] Config TCP por defecto: host={TCP_HOST_DEFAULT}, port={TCP_PORT_DEFAULT}")
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
        b = TcpBridge(TCP_HOST_DEFAULT, TCP_PORT_DEFAULT)
        data = b.list_vars()
        b.disconnect()
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/var/{name:path}")
async def api_get_var(name: str):
    try:
        b = TcpBridge(TCP_HOST_DEFAULT, TCP_PORT_DEFAULT)
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
        b = TcpBridge(TCP_HOST_DEFAULT, TCP_PORT_DEFAULT)
        ok = b.set_var(name, value, var_type)
        b.disconnect()
        return JSONResponse({"success": ok})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/history/{name:path}")
async def api_get_history(name: str):
    try:
        b = TcpBridge(TCP_HOST_DEFAULT, TCP_PORT_DEFAULT)
        result = b.get_history(name)
        b.disconnect()
        if result is None:
            return JSONResponse({"error": "Variable no encontrada"}, status_code=404)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/scan_ports")
async def api_scan_ports(
    host: str = Query(TCP_HOST_DEFAULT),
    start: int | None = Query(None),
    end: int | None = Query(None),
):
    """Escanea un rango de puertos para encontrar instancias activas de VarMonitor."""
    # Si no se especifica rango, usar [TCP_PORT_DEFAULT, TCP_PORT_DEFAULT + 10]
    if start is None or end is None:
        start = TCP_PORT_DEFAULT
        end = TCP_PORT_DEFAULT + 10

    active: list[int] = []
    for port in range(start, end + 1):
        try:
            b = TcpBridge(host, port, timeout=0.3)
            # Prueba ligera: pedir nombres
            _ = b.list_names()
            active.append(port)
            b.disconnect()
        except Exception:
            continue
    return {"host": host, "ports": active, "range": [start, end]}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    global ACTIVE_WS
    ACTIVE_WS += 1
    interval = 0.2
    names_refresh_interval = 30.0
    monitored_names: set[str] = set()
    last_names_send = 0.0
    names_sent_once = False

    # Host y puerto seleccionados para esta conexion
    query_host = ws.query_params.get("host") or TCP_HOST_DEFAULT
    query_port = ws.query_params.get("port")
    try:
        tcp_port = int(query_port) if query_port is not None else TCP_PORT_DEFAULT
    except ValueError:
        tcp_port = TCP_PORT_DEFAULT

    try:
        bridge = TcpBridge(query_host, tcp_port)
    except Exception as e:
        await ws.send_json({"type": "error", "message": f"No se pudo conectar a {query_host}:{tcp_port}: {e}"})
        await ws.close()
        return

    try:
        while True:
            try:
                now = time.monotonic()

                if not names_sent_once or (now - last_names_send >= names_refresh_interval):
                    names_list = bridge.list_names()
                    if not names_list:
                        names_list = [v["name"] for v in bridge.list_vars()]
                    await ws.send_json({"type": "vars_names", "data": names_list})
                    last_names_send = now
                    names_sent_once = True

                if monitored_names:
                    mon_data = []
                    for name in monitored_names:
                        vinfo = bridge.get_var(name)
                        if vinfo:
                            mon_data.append(vinfo)
                    await ws.send_json({"type": "vars_update", "data": mon_data})

            except Exception as e:
                try:
                    await ws.send_json({"type": "error", "message": str(e)})
                except Exception:
                    break

            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=interval)
                cmd = json.loads(msg)
                action = cmd.get("action")

                if action == "set_interval":
                    interval = max(0.1, float(cmd["value"]))
                elif action == "set_monitored":
                    monitored_names = set(cmd.get("names", []))
                elif action == "get_history":
                    hist = bridge.get_history(cmd["name"])
                    await ws.send_json({"type": "history", "data": hist})
                elif action == "get_histories":
                    since_seq = cmd.get("since_seq")
                    if since_seq is not None:
                        result = bridge.get_histories_since(cmd.get("names", []), int(since_seq))
                        await ws.send_json({"type": "histories", "seq": result["seq"], "data": result["data"]})
                    else:
                        hists = bridge.get_histories(cmd.get("names", []))
                        await ws.send_json({"type": "histories", "data": hists})
                elif action == "set_var":
                    ok = bridge.set_var(cmd["name"], cmd["value"], cmd.get("var_type", "double"))
                    await ws.send_json({"type": "set_result", "success": ok, "name": cmd["name"]})
                elif action == "set_array_element":
                    ok = bridge.set_array_element(cmd["name"], int(cmd["index"]), float(cmd["value"]))
                    await ws.send_json({"type": "set_result", "success": ok, "name": cmd["name"]})
                elif action == "refresh_names":
                    names_list = bridge.list_names()
                    if not names_list:
                        names_list = [v["name"] for v in bridge.list_vars()]
                    await ws.send_json({"type": "vars_names", "data": names_list})
                    last_names_send = time.monotonic()
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        ACTIVE_WS -= 1
        bridge.disconnect()


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

if __name__ == "__main__":
    import uvicorn

    port = _config["web_port"]
    lan_ip = _config["lan_ip"]
    print(f"[VarMonitor Web] Iniciando en:")
    print(f"  http://localhost:{port}         (local)")
    if lan_ip:
        print(f"  http://{lan_ip}:{port}    (red)")
    uvicorn.run(app, host="0.0.0.0", port=port)
