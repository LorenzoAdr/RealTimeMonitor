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

bridge: TcpBridge | None = None
TCP_HOST = _config["host"]
TCP_PORT = _config["tcp_port"]


def get_bridge() -> TcpBridge:
    global bridge
    if bridge is None:
        bridge = TcpBridge(TCP_HOST, TCP_PORT)
    return bridge


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        get_bridge()
        print(f"[VarMonitor Web] Conectado al servidor TCP en {TCP_HOST}:{TCP_PORT}")
    except Exception as e:
        print(f"[VarMonitor Web] AVISO: No se pudo conectar: {e}")
        print("  Asegurate de que demo_server esta corriendo.")
    yield
    global bridge
    if bridge:
        bridge.disconnect()
        bridge = None


app = FastAPI(title="VarMonitor", lifespan=lifespan)


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/vars")
async def api_list_vars():
    try:
        b = get_bridge()
        return JSONResponse(b.list_vars())
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/var/{name:path}")
async def api_get_var(name: str):
    try:
        b = get_bridge()
        result = b.get_var(name)
        if result is None:
            return JSONResponse({"error": "Variable no encontrada"}, status_code=404)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/var/{name:path}")
async def api_set_var(name: str, value: float = Query(...), var_type: str = Query("double")):
    try:
        b = get_bridge()
        ok = b.set_var(name, value, var_type)
        return JSONResponse({"success": ok})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/history/{name:path}")
async def api_get_history(name: str):
    try:
        b = get_bridge()
        result = b.get_history(name)
        if result is None:
            return JSONResponse({"error": "Variable no encontrada"}, status_code=404)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    interval = 0.2
    names_refresh_interval = 30.0
    monitored_names: set[str] = set()
    last_names_send = 0.0
    names_sent_once = False

    try:
        while True:
            try:
                b = get_bridge()
                now = time.monotonic()

                if not names_sent_once or (now - last_names_send >= names_refresh_interval):
                    names_list = b.list_names()
                    if not names_list:
                        names_list = [v["name"] for v in b.list_vars()]
                    await ws.send_json({"type": "vars_names", "data": names_list})
                    last_names_send = now
                    names_sent_once = True

                if monitored_names:
                    mon_data = []
                    for name in monitored_names:
                        vinfo = b.get_var(name)
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
                    interval = max(0.05, float(cmd["value"]))
                elif action == "set_monitored":
                    monitored_names = set(cmd.get("names", []))
                elif action == "get_history":
                    b = get_bridge()
                    hist = b.get_history(cmd["name"])
                    await ws.send_json({"type": "history", "data": hist})
                elif action == "get_histories":
                    b = get_bridge()
                    hists = b.get_histories(cmd.get("names", []))
                    await ws.send_json({"type": "histories", "data": hists})
                elif action == "set_var":
                    b = get_bridge()
                    ok = b.set_var(cmd["name"], cmd["value"], cmd.get("var_type", "double"))
                    await ws.send_json({"type": "set_result", "success": ok, "name": cmd["name"]})
                elif action == "set_array_element":
                    b = get_bridge()
                    ok = b.set_array_element(cmd["name"], int(cmd["index"]), float(cmd["value"]))
                    await ws.send_json({"type": "set_result", "success": ok, "name": cmd["name"]})
                elif action == "refresh_names":
                    b = get_bridge()
                    names_list = b.list_names()
                    if not names_list:
                        names_list = [v["name"] for v in b.list_vars()]
                    await ws.send_json({"type": "vars_names", "data": names_list})
                    last_names_send = time.monotonic()
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        pass


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
