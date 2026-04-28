"""Abrir la UI web (pywebview, WSL→Windows, o navegador del sistema). Usado por launch_ui."""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

_WSL_CMD = Path("/mnt/c/Windows/System32/cmd.exe")
_WSL_POWERSHELL = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")


def is_wsl() -> bool:
    if os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"):
        return True
    try:
        with open("/proc/version", encoding="utf-8", errors="replace") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def prefer_wsl_embedded_window() -> bool:
    v = os.environ.get("VARMON_WSL_EMBEDDED", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def wsl_primary_ipv4() -> str | None:
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


def windows_browser_url(port: int) -> str:
    tpl = os.environ.get("VARMON_WSL_BROWSER_URL", "").strip()
    wsl_ip = wsl_primary_ipv4()
    if tpl:
        return tpl.replace("{port}", str(port)).replace(
            "{wsl_ip}", wsl_ip or "127.0.0.1"
        )
    if wsl_ip:
        return f"http://{wsl_ip}:{port}/"
    return f"http://127.0.0.1:{port}/"


def wsl_windows_chromium_exes() -> list[Path]:
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


def open_url_on_windows_host(url: str) -> bool:
    for exe in wsl_windows_chromium_exes():
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


def open_url_on_linux_host(url: str) -> bool:
    debug = os.environ.get("VARMON_DEBUG_BROWSER", "").strip().lower() in ("1", "true", "yes")

    def _launch(cmd: list[str], label: str) -> bool:
        try:
            subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            if debug:
                print(f"[launch_ui] lanzado ({label}): {' '.join(cmd)}", flush=True)
            return True
        except OSError as e:
            if debug:
                print(f"[launch_ui] fallo ({label}): {e}", file=sys.stderr, flush=True)
            return False

    env_cmd = os.environ.get("VARMON_LINUX_BROWSER", "").strip()
    if env_cmd:
        try:
            parts = shlex.split(env_cmd)
            if parts:
                exe = parts[0]
                if not os.path.isfile(exe):
                    w = shutil.which(exe)
                    exe = w if w else ""
                if exe:
                    cmd = [exe] + parts[1:] + [url]
                    if _launch(cmd, "VARMON_LINUX_BROWSER"):
                        return True
        except ValueError:
            pass

    for bin_name in (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "brave-browser",
        "brave",
    ):
        exe = shutil.which(bin_name)
        if exe and _launch([exe, f"--app={url}"], bin_name):
            return True

    ff_tried: set[str] = set()
    for ff in (
        shutil.which("firefox"),
        "/snap/bin/firefox",
        "/usr/bin/firefox",
    ):
        if not ff or ff in ff_tried or not os.path.isfile(ff):
            continue
        ff_tried.add(ff)
        if _launch([ff, "-new-window", url], "firefox"):
            return True
        if _launch([ff, url], "firefox"):
            return True

    if shutil.which("flatpak"):
        if _launch(
            ["flatpak", "run", "org.mozilla.firefox", url],
            "flatpak firefox",
        ):
            return True

    xdg = shutil.which("xdg-open")
    if xdg and _launch([xdg, url], "xdg-open"):
        return True

    gio = shutil.which("gio")
    if gio and _launch([gio, "open", url], "gio open"):
        return True

    try:
        if webbrowser.open(url):
            return True
    except Exception:
        pass
    return False


def open_varmonitor_ui(port: int) -> None:
    """
    Abre la interfaz para un backend ya en marcha en `port`.
    WSL: navegador de Windows por defecto; Linux: pywebview si hay requirements-desktop.
    """
    wsl = is_wsl()
    local_url = f"http://127.0.0.1:{port}/"

    if wsl and not prefer_wsl_embedded_window():
        wurl = windows_browser_url(port)
        print("[launch_ui] WSL: abriendo en el navegador de Windows.", flush=True)
        print(f"  → {wurl}", flush=True)
        if not open_url_on_windows_host(wurl):
            print(f"No se pudo abrir automáticamente. Prueba: {wurl}", file=sys.stderr)
            if wurl.rstrip("/") != local_url.rstrip("/"):
                print(f"  O: {local_url}", file=sys.stderr)
        return

    os.environ.setdefault("QT_API", "pyside6")
    os.environ.setdefault("PYWEBVIEW_GUI", "qt")
    try:
        import webview
        from webview.errors import WebViewException
    except ImportError:
        if wsl:
            print("[launch_ui] Sin pywebview; usando navegador de Windows.", file=sys.stderr)
            wurl = windows_browser_url(port)
            open_url_on_windows_host(wurl)
        else:
            print("[launch_ui] Sin pywebview; usando navegador del sistema.", file=sys.stderr)
            if not open_url_on_linux_host(local_url):
                print(f"Abre manualmente: {local_url}", file=sys.stderr)
        return

    webview.create_window("VarMonitor", local_url, width=1280, height=800)
    try:
        webview.start(gui="qt")
    except WebViewException as e:
        print(f"[launch_ui] pywebview falló ({e}); usando navegador.", file=sys.stderr)
        if wsl:
            open_url_on_windows_host(windows_browser_url(port))
        else:
            open_url_on_linux_host(local_url)
    except Exception as e:
        print(f"[launch_ui] ventana embebida: {e}", file=sys.stderr)
        if wsl:
            open_url_on_windows_host(windows_browser_url(port))
        else:
            open_url_on_linux_host(local_url)
