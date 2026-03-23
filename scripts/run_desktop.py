#!/usr/bin/env python3
"""
Arranca web_monitor/app.py y muestra la interfaz:

• Linux/macOS/Windows “de verdad”: ventana embebida con pywebview + Qt WebEngine
  (pip: requirements-desktop.txt).

• WSL: se abre el navegador de Windows en modo aplicación (`--app=URL`) si existe
  Chrome/Edge/Brave bajo `C:\\Program Files\\...` (visto desde WSL como `/mnt/c/...`).
  Override: `VARMON_WINDOWS_BROWSER` con ruta al .exe. La URL usa la IP virtual de WSL
  (hostname -I), alcanzable desde Windows sin depender solo del reenvío de
  localhost. Opcional: variable VARMON_WSL_BROWSER_URL con {port} y {wsl_ip}.
  El backend debe escuchar en todas las interfaces (bind_host vacío o 0.0.0.0 en
  varmon.conf); si fijas bind_host=127.0.0.1, Windows no podrá usar la IP de WSL.

• El puerto que abre el navegador es siempre el efectivo del proceso: tras leerlo
  del log, se confirma con GET /api/uptime (actual_web_port) por si el backend
  elige otro puerto en el rango de autodescubrimiento.

• Linux: por defecto arranca `build/demo_app/demo_server` en segundo plano y usa
  `taskset` para separar núcleos C++ vs Python (p. ej. 0-1 vs 4-5 si hay ≥8 CPUs).
  `VARMON_SKIP_DEMO=1` no arranca el demo; `VARMON_TASKSET_CPP` / `VARMON_TASKSET_PY`
  sobreescriben las listas `-c` de taskset. Sin `taskset` en PATH se ignora la afinidad.

Instalación escritorio: pip install -r web_monitor/requirements-desktop.txt
En WSL solo hace falta si quieres probar la ventana embebida con WSLg; si no,
puedes abrir la URL en Edge/Chrome sin instalar PySide6.
"""
from __future__ import annotations

import json
import os
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web_monitor"
APP_PY = WEB_DIR / "app.py"
VENV_PYTHON = WEB_DIR / ".venv" / "bin" / "python"

PORT_RE = re.compile(r"Servidor escuchando en puerto (\d+)")
STARTUP_WAIT_S = 2.0
PORT_TIMEOUT_S = 90.0
HTTP_READY_TIMEOUT_S = 45.0
DEMO_START_DELAY_S = 0.35

_WSL_CMD = Path("/mnt/c/Windows/System32/cmd.exe")
_WSL_POWERSHELL = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")


def _is_wsl() -> bool:
    if os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"):
        return True
    try:
        with open("/proc/version", encoding="utf-8", errors="replace") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def _prefer_wsl_embedded_window() -> bool:
    """
    Política por defecto: en WSL abrir navegador de Windows (más estable).
    Permite forzar ventana embebida con VARMON_WSL_EMBEDDED=1.
    """
    v = os.environ.get("VARMON_WSL_EMBEDDED", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _wsl_primary_ipv4() -> str | None:
    """
    Primer IPv4 no loopback de WSL (interfaz virtual hacia Windows).
    Desde Edge/Chrome en Windows suele funcionar mejor que depender solo de 127.0.0.1.
    """
    try:
        r = subprocess.run(
            ["hostname", "-I"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except OSError:
        return None
    for token in r.stdout.split():
        if token.startswith("127."):
            continue
        if token.count(".") == 3 and all(p.isdigit() for p in token.split(".")):
            return token
    return None


def _windows_browser_url(port: int) -> str:
    """
    URL para abrir en el navegador del host Windows.
    Prioriza la IP de WSL; override con VARMON_WSL_BROWSER_URL (placeholders {port}, {wsl_ip}).
    """
    tpl = os.environ.get("VARMON_WSL_BROWSER_URL", "").strip()
    wsl_ip = _wsl_primary_ipv4()
    if tpl:
        return tpl.replace("{port}", str(port)).replace(
            "{wsl_ip}", wsl_ip or "127.0.0.1"
        )
    if wsl_ip:
        return f"http://{wsl_ip}:{port}/"
    return f"http://127.0.0.1:{port}/"


def _python_exe() -> Path:
    if VENV_PYTHON.is_file():
        return VENV_PYTHON
    return Path(sys.executable)


def _find_demo_server() -> Path | None:
    """Binario demo_server (CMake: build/demo_app/demo_server)."""
    raw = os.environ.get("VARMON_DEMO_SERVER_BIN", "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.is_file() and os.access(p, os.X_OK):
            return p.resolve()
    for rel in ("build/demo_app/demo_server", "build/demo_server"):
        c = ROOT / rel
        if c.is_file() and os.access(c, os.X_OK):
            return c
    return None


def _resolve_taskset_affinities() -> tuple[str | None, str | None]:
    """
    Listas de núcleos para `taskset -c` (C++ demo vs Python).
    None = no aplicar taskset para ese proceso.
    """
    cpp = os.environ.get("VARMON_TASKSET_CPP", "").strip() or None
    py_aff = os.environ.get("VARMON_TASKSET_PY", "").strip() or None
    if cpp is not None or py_aff is not None:
        return cpp, py_aff

    n = os.cpu_count() or 1
    if n >= 8:
        return "0-1", "4-5"
    if n >= 4:
        return "0", "2"
    if n == 3:
        return "0", "2"
    if n == 2:
        return "0", "1"
    return None, None


def _wrap_with_taskset(affinity: str | None, argv: list[str]) -> list[str]:
    if not affinity or not shutil.which("taskset"):
        return argv
    return ["taskset", "-c", affinity, *argv]


def _start_demo_server(cpp_affinity: str | None) -> subprocess.Popen[str] | None:
    exe = _find_demo_server()
    if exe is None:
        print(
            "[run_desktop] No hay demo_server (cmake --build build --target demo_server). "
            "Puedes usar tu binario C++ o definir VARMON_DEMO_SERVER_BIN.",
            file=sys.stderr,
            flush=True,
        )
        return None
    if cpp_affinity and not shutil.which("taskset"):
        print(
            "[run_desktop] taskset no encontrado; demo_server sin afinidad de CPU.",
            file=sys.stderr,
            flush=True,
        )
    cmd = _wrap_with_taskset(cpp_affinity, [str(exe)])
    try:
        return subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except OSError as e:
        print(f"[run_desktop] No se pudo arrancar demo_server: {e}", file=sys.stderr, flush=True)
        return None


def _drain_prefixed_stderr(proc: subprocess.Popen[str], prefix: str) -> None:
    if not proc.stderr:
        return

    def go() -> None:
        try:
            for line in proc.stderr:
                sys.stderr.write(f"{prefix}{line}")
                sys.stderr.flush()
        except Exception:
            pass

    threading.Thread(target=go, daemon=True).start()


def _wait_for_port(proc: subprocess.Popen[str], timeout_s: float) -> int | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return None
        line = proc.stdout.readline() if proc.stdout else ""
        if line:
            sys.stdout.write(line)
            sys.stdout.flush()
            m = PORT_RE.search(line)
            if m:
                return int(m.group(1))
        else:
            time.sleep(0.02)
    return None


def _wait_http_ready(port: int, timeout_s: float) -> bool:
    url = f"http://127.0.0.1:{port}/"
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.08)
    return False


def _resolve_actual_web_port(port: int) -> int:
    """
    Confirma el puerto con el backend (app.state.actual_web_port tras el bind).
    Así el navegador usa el mismo puerto que el autodescubrimiento, no solo el texto del log.
    """
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/uptime")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = json.loads(resp.read().decode())
        ap = data.get("actual_web_port")
        if isinstance(ap, int) and 1 <= ap <= 65535:
            if ap != port:
                print(
                    f"[run_desktop] Puerto efectivo (API): {ap} (referencia en log: {port}).",
                    file=sys.stderr,
                )
            return ap
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError, TypeError):
        pass
    return port


def _drain_stdout(proc: subprocess.Popen[str]) -> None:
    if not proc.stdout:
        return
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()


def _wsl_windows_chromium_exes() -> list[Path]:
    """
    Ejecutables de Chrome/Edge/Brave en Windows, accesibles desde WSL vía /mnt/c/.
    Primero VARMON_WINDOWS_BROWSER si apunta a un .exe existente.
    """
    candidates = [
        Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"),
        Path("/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
        Path("/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe"),
        Path("/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
        Path("/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"),
    ]
    custom = os.environ.get("VARMON_WINDOWS_BROWSER", "").strip()
    if custom:
        p = Path(custom).expanduser()
        if p.is_file():
            return [p]
    return [p for p in candidates if p.is_file()]


def _open_url_on_windows_host(url: str) -> bool:
    """Abre http(s) en el Windows anfitrión desde WSL. Prioriza modo aplicación (--app=)."""
    for exe in _wsl_windows_chromium_exes():
        try:
            subprocess.Popen(
                [str(exe), f"--app={url}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except OSError:
            continue
    wslview = shutil.which("wslview")
    if wslview:
        try:
            subprocess.run([wslview, url], check=False, timeout=60)
            return True
        except (OSError, subprocess.TimeoutExpired):
            pass
    if _WSL_CMD.is_file():
        try:
            subprocess.Popen(
                [str(_WSL_CMD), "/c", "start", "", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except OSError:
            pass
    if _WSL_POWERSHELL.is_file():
        try:
            subprocess.Popen(
                [str(_WSL_POWERSHELL), "-NoProfile", "-Command", f"Start-Process '{url}'"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except OSError:
            pass
    return False


def _open_url_on_linux_host(url: str) -> bool:
    """
    Abre URL en Linux local. Intenta primero modo app (menos intrusivo) si hay
    Chromium/Chrome/Edge; fallback a xdg-open.
    """
    app_mode_cmds: list[list[str]] = []
    for bin_name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"):
        exe = shutil.which(bin_name)
        if exe:
            app_mode_cmds.append([exe, f"--app={url}"])
    for cmd in app_mode_cmds:
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except OSError:
            continue
    xdg = shutil.which("xdg-open")
    if xdg:
        try:
            subprocess.Popen([xdg, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except OSError:
            pass
    return False


def _run_linux_browser_fallback(port: int, proc: subprocess.Popen[str]) -> None:
    local_url = f"http://127.0.0.1:{port}/"
    print("[run_desktop] Abriendo la interfaz en navegador local (modo app si está disponible).", flush=True)
    print(f"  → {local_url}", flush=True)
    if not _open_url_on_linux_host(local_url):
        print(
            f"No se pudo lanzar el navegador automáticamente. Abre: {local_url}",
            file=sys.stderr,
            flush=True,
        )
    print("Servidor en marcha. Pulsa Ctrl+C aquí para detenerlo.", flush=True)
    try:
        proc.wait()
    except KeyboardInterrupt:
        pass


def _fail_import_help() -> None:
    print(
        "Faltan dependencias del escritorio. En web_monitor ejecuta:\n"
        "  pip install -r requirements-desktop.txt\n"
        "Necesitas: pywebview, qtpy, PySide6 (Qt WebEngine va dentro del wheel de PySide6).",
        file=sys.stderr,
    )


def _run_wsl_browser_fallback(port: int, proc: subprocess.Popen[str]) -> None:
    windows_url = _windows_browser_url(port)
    local_url = f"http://127.0.0.1:{port}/"
    wsl_ip = _wsl_primary_ipv4()
    print(
        "[run_desktop] WSL: abriendo en el navegador de Windows (modo app --app= si hay Chrome/Edge).",
        flush=True,
    )
    print(f"  → {windows_url}", flush=True)
    if wsl_ip and windows_url.rstrip("/") != local_url.rstrip("/"):
        print(
            f"  (alternativa si hace falta: {local_url} — reenvío de localhost)",
            flush=True,
        )
    elif not wsl_ip:
        print(
            "  (no se detectó IP de WSL; si no carga, ejecuta en Windows: wsl hostname -I)",
            flush=True,
        )
    if not _open_url_on_windows_host(windows_url):
        print(
            f"No se pudo lanzar el navegador automáticamente. Abre: {windows_url}",
            file=sys.stderr,
        )
        if windows_url != local_url:
            print(f"  O prueba: {local_url}", file=sys.stderr)
    print("Servidor en marcha. Pulsa Ctrl+C aquí para detenerlo.", flush=True)
    try:
        proc.wait()
    except KeyboardInterrupt:
        pass


def main() -> None:
    if not APP_PY.is_file():
        print(f"No se encuentra {APP_PY}", file=sys.stderr)
        sys.exit(1)

    wsl = _is_wsl()

    cpp_aff, py_aff = _resolve_taskset_affinities()
    demo_proc: subprocess.Popen[str] | None = None
    skip_demo = os.environ.get("VARMON_SKIP_DEMO", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if not skip_demo:
        demo_proc = _start_demo_server(cpp_aff)
        if demo_proc is not None:
            _drain_prefixed_stderr(demo_proc, "[demo_server] ")
            if cpp_aff and shutil.which("taskset"):
                print(
                    f"[run_desktop] demo_server en segundo plano (taskset -c {cpp_aff}).",
                    flush=True,
                )
            else:
                print("[run_desktop] demo_server en segundo plano.", flush=True)
            time.sleep(DEMO_START_DELAY_S)
    else:
        print(
            "[run_desktop] VARMON_SKIP_DEMO: no se arranca demo_server (usa tu C++ si aplica).",
            flush=True,
        )

    py = _python_exe()
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    if not wsl or _prefer_wsl_embedded_window():
        env.setdefault("QT_API", "pyside6")
        env.setdefault("PYWEBVIEW_GUI", "qt")

    py_argv = [str(py), str(APP_PY)]
    py_cmd = _wrap_with_taskset(py_aff, py_argv)
    if py_aff and shutil.which("taskset"):
        print(f"[run_desktop] Backend Python con taskset -c {py_aff}.", flush=True)
    elif py_aff and not shutil.which("taskset"):
        print(
            "[run_desktop] taskset no encontrado; Python sin afinidad explícita.",
            file=sys.stderr,
            flush=True,
        )

    proc = subprocess.Popen(
        py_cmd,
        cwd=str(WEB_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        bufsize=1,
    )

    def cleanup(*_: object) -> None:
        if proc.poll() is None:
            proc.terminate()
        if demo_proc is not None and demo_proc.poll() is None:
            demo_proc.terminate()
        sys.exit(130)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    port = _wait_for_port(proc, PORT_TIMEOUT_S)
    if port is None:
        if proc.poll() is not None:
            print("El servidor terminó antes de publicar el puerto.", file=sys.stderr)
        else:
            print("Tiempo de espera agotado sin detectar el puerto del servidor.", file=sys.stderr)
        proc.terminate()
        if demo_proc is not None and demo_proc.poll() is None:
            demo_proc.terminate()
        sys.exit(1)

    threading.Thread(target=_drain_stdout, args=(proc,), daemon=True).start()

    if not _wait_http_ready(port, HTTP_READY_TIMEOUT_S):
        print("El servidor no respondió por HTTP a tiempo.", file=sys.stderr)
        proc.terminate()
        if demo_proc is not None and demo_proc.poll() is None:
            demo_proc.terminate()
        sys.exit(1)

    port = _resolve_actual_web_port(port)

    if STARTUP_WAIT_S > 0:
        time.sleep(STARTUP_WAIT_S)

    # Misma máquina: siempre 127.0.0.1 (pywebview); `port` ya es el confirmado por la API.
    local_url = f"http://127.0.0.1:{port}/"

    # WSL: por defecto usar siempre navegador de Windows (más robusto y menos intrusivo).
    # Solo intentar ventana embebida si se fuerza explícitamente:
    #   VARMON_WSL_EMBEDDED=1
    if wsl and not _prefer_wsl_embedded_window():
        try:
            _run_wsl_browser_fallback(port, proc)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
            if demo_proc is not None and demo_proc.poll() is None:
                demo_proc.terminate()
                try:
                    demo_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    demo_proc.kill()
        return

    # Linux nativo o WSL forzado a embebido: intentar pywebview + Qt.
    os.environ.setdefault("QT_API", "pyside6")
    os.environ.setdefault("PYWEBVIEW_GUI", "qt")
    try:
        import webview
        from webview.errors import WebViewException
    except ImportError:
        if wsl:
            print(
                "[run_desktop] Sin paquetes de escritorio; usando navegador de Windows.",
                file=sys.stderr,
            )
            try:
                _run_wsl_browser_fallback(port, proc)
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                if demo_proc is not None and demo_proc.poll() is None:
                    demo_proc.terminate()
                    try:
                        demo_proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        demo_proc.kill()
            return
        print(
            "[run_desktop] Sin backend de ventana embebida; usando navegador local.",
            file=sys.stderr,
        )
        try:
            _run_linux_browser_fallback(port, proc)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
            if demo_proc is not None and demo_proc.poll() is None:
                demo_proc.terminate()
                try:
                    demo_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    demo_proc.kill()
        return

    webview.create_window("VarMonitor", local_url, width=1280, height=800)
    try:
        webview.start(gui="qt")
    except WebViewException as e:
        if wsl:
            print(
                f"[run_desktop] pywebview (Qt) no disponible en este WSL ({e}); "
                "usando navegador de Windows.",
                file=sys.stderr,
            )
            _run_wsl_browser_fallback(port, proc)
        else:
            print(
                f"[run_desktop] pywebview (Qt) no pudo iniciarse ({e}); usando navegador local.",
                file=sys.stderr,
            )
            _run_linux_browser_fallback(port, proc)
    except Exception as e:
        # Cubre errores de backend GTK/gi u otros fallos en tiempo de arranque.
        if wsl:
            print(
                f"[run_desktop] Fallo en ventana embebida ({e}); usando navegador de Windows.",
                file=sys.stderr,
            )
            _run_wsl_browser_fallback(port, proc)
        else:
            print(
                f"[run_desktop] Fallo en ventana embebida ({e}); usando navegador local.",
                file=sys.stderr,
            )
            _run_linux_browser_fallback(port, proc)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
        if demo_proc is not None and demo_proc.poll() is None:
            demo_proc.terminate()
            try:
                demo_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                demo_proc.kill()


if __name__ == "__main__":
    main()
