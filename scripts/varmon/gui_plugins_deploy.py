#!/usr/bin/env python3
"""
Interfaz gráfica ligera: selección de plugins (plugin-selection.json), build y empaquetado.

Opción «Generar entrega final»: si está desmarcada, solo se ejecuta build_all.sh (wheel + JS);
no se llama a generate_webmonitor_version.sh (CMake, PyInstaller, carpeta web_monitor_version/).

Requisito en muchos Linux: paquete del sistema `python3-tk` (p. ej. apt install python3-tk).

Uso:
  ./scripts/varmon/launch_gui_plugins_deploy.sh
  # o: python3 scripts/varmon/gui_plugins_deploy.py
"""
from __future__ import annotations

import json
import os
import queue
import re
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

try:
    import tkinter as tk
    from tkinter import messagebox, scrolledtext, ttk
except ImportError as e:
    print(
        "Error: tkinter no está disponible. En Debian/Ubuntu: sudo apt install python3-tk",
        file=sys.stderr,
    )
    print(e, file=sys.stderr)
    raise SystemExit(1) from e

# Raíz del repo: .../scripts/varmon/este_fichero.py -> parents[2]
ROOT = Path(__file__).resolve().parents[2]
SELECTION_PATH = ROOT / "tool_plugins" / "plugin-selection.json"

# Paleta (fondo claro, inclusión = acento verde inequívoco)
BG_APP = "#e8edf3"
BG_CARD_OFF = "#f8fafc"
BORDER_CARD = "#d1d9e6"
ACCENT_ON = "#16a34a"
ACCENT_ON_LIGHT = "#dcfce7"
TEXT_MAIN = "#0f172a"
TEXT_MUTED = "#64748b"

DEFAULTS: dict[str, dict[str, bool]] = {
    "ids": {
        "arinc": True,
        "m1553": True,
        "replay_alias": True,
        "anomaly": True,
        "segments": True,
        "parquet": True,
        "replay_ref_alarms": True,
        "analysis_report": True,
    },
    "hooks": {
        "arincImportValidation": True,
        "replayAlias": True,
        "m1553Api": True,
        "arincFormatExtras": True,
    },
    "ui": {
        "fileEdit": True,
        "gitWorkspace": True,
        "terminal": True,
        "flightViz": True,
        "protocolRegistry": True,
    },
}

LABELS: dict[str, str] = {
    "arinc": "ARINC 429 (ids)",
    "m1553": "MIL-STD-1553",
    "replay_alias": "Replay / alias de columnas",
    "anomaly": "Detección de anomalías",
    "segments": "Segmentos",
    "parquet": "Parquet (grabación / análisis)",
    "replay_ref_alarms": "Alarmas replay vs referencia",
    "analysis_report": "Informe PDF (modo análisis)",
    "arincImportValidation": "Validación importación ARINC tabular",
    "replayAlias": "Hook replay alias",
    "m1553Api": "Hook API MIL-STD-1553",
    "arincFormatExtras": "Formato ARINC extras (BD)",
    "fileEdit": "Editor de ficheros",
    "gitWorkspace": "Workspace Git",
    "terminal": "Terminal embebida",
    "flightViz": "Visualización de vuelo",
    "protocolRegistry": "BD protocolos (ARINC / 1553)",
}

TAB_TITLES = {"ids": "Módulos (ids)", "hooks": "Hooks", "ui": "UI"}


def load_selection() -> dict[str, dict[str, bool]]:
    if not SELECTION_PATH.is_file():
        return json.loads(json.dumps(DEFAULTS))
    try:
        data = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return json.loads(json.dumps(DEFAULTS))
    out = json.loads(json.dumps(DEFAULTS))
    for sec in ("ids", "hooks", "ui"):
        if isinstance(data.get(sec), dict):
            for k, v in data[sec].items():
                if k in out[sec] and isinstance(v, bool):
                    out[sec][k] = v
    return out


def verify_root() -> bool:
    return (
        (ROOT / "tool_plugins" / "scripts" / "build_all.sh").is_file()
        and (ROOT / "scripts" / "varmon" / "generate_webmonitor_version.sh").is_file()
    )


def run_bash(script_rel: str, extra_env: dict[str, str] | None = None) -> tuple[int, str]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    cmd = ["bash", str(ROOT / script_rel)]
    r = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        env=env,
        timeout=None,
    )
    out = (r.stdout or "") + ("\n" if r.stdout and r.stderr else "") + (r.stderr or "")
    tail = "\n".join(out.splitlines()[-50:])
    return r.returncode, tail


def _wheel_has_required_modules(whl: Path) -> tuple[bool, list[str]]:
    required = {
        "varmonitor_plugins/gdb_debug.py",
        "varmonitor_plugins/terminal_api.py",
        "varmonitor_plugins/pro_http.py",
    }
    try:
        with zipfile.ZipFile(whl) as zf:
            names = set(zf.namelist())
    except Exception:
        return False, ["wheel_unreadable"]
    missing = sorted(m for m in required if m not in names)
    return (len(missing) == 0), missing


def _latest_valid_dist_wheel() -> tuple[Path | None, str]:
    dist = ROOT / "tool_plugins" / "dist"
    cands = sorted(dist.glob("varmonitor_plugins-*.whl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not cands:
        return None, f"No hay wheels en {dist}"
    for whl in cands:
        ok, missing = _wheel_has_required_modules(whl)
        if ok:
            return whl, ""
        miss = ", ".join(missing)
        print(f"[gui_plugins_deploy] wheel descartada (incompleta): {whl} | faltan: {miss}", file=sys.stderr)
    return None, "Todas las wheels de tool_plugins/dist están incompletas para backend Pro (gdb/terminal/pro_http)."


def _clean_release_workspace() -> None:
    """Limpieza agresiva para release desde cero (sin reutilizar artefactos previos)."""
    targets = [
        ROOT / "web_monitor" / ".venv-build",
        ROOT / "web_monitor" / "dist",
        ROOT / "web_monitor" / "build",
        ROOT / "web_monitor_version",
        ROOT / "tool_plugins" / "dist",
        ROOT / "tool_plugins" / "python" / ".venv-build",
        ROOT / "tool_plugins" / "python" / "dist",
        ROOT / "tool_plugins" / "js" / "dist",
    ]
    for p in targets:
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)


def _pick_free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(s.getsockname()[1])


def _write_probe_config(base_cfg: Path, port: int) -> Path:
    text = base_cfg.read_text(encoding="utf-8")
    lines = text.splitlines()
    replaced = False
    out_lines: list[str] = []
    for ln in lines:
        if re.match(r"^\s*web_port\s*=", ln):
            out_lines.append(f"web_port = {port}")
            replaced = True
        else:
            out_lines.append(ln)
    if not replaced:
        out_lines.append(f"web_port = {port}")
    tmp = tempfile.NamedTemporaryFile("w", delete=False, suffix=".conf", encoding="utf-8")
    try:
        tmp.write("\n".join(out_lines) + "\n")
    finally:
        tmp.close()
    return Path(tmp.name)


def _probe_packaged_features(timeout_s: float = 20.0) -> tuple[bool, str]:
    exe = ROOT / "web_monitor_version" / "bin" / "varmonitor-web"
    cfg = ROOT / "web_monitor_version" / "data" / "varmon.conf"
    if not exe.is_file():
        return False, f"No existe binario empaquetado: {exe}"
    if not cfg.is_file():
        return False, f"No existe config empaquetada: {cfg}"

    port = _pick_free_local_port()
    probe_cfg = _write_probe_config(cfg, port)
    env = os.environ.copy()
    env["VARMON_CONFIG"] = str(probe_cfg)
    proc: subprocess.Popen[str] | None = None
    url = f"http://127.0.0.1:{port}/api/plugins/features"
    deadline = time.time() + timeout_s
    last_err = "sin respuesta"
    try:
        proc = subprocess.Popen(
            [str(exe)],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
        )
        while time.time() < deadline:
            if proc.poll() is not None:
                return False, f"El binario terminó prematuramente durante la validación (código {proc.returncode})."
            try:
                with urllib.request.urlopen(url, timeout=1.5) as resp:
                    if resp.status != 200:
                        last_err = f"HTTP {resp.status}"
                        time.sleep(0.2)
                        continue
                    data = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
                    feats = data.get("features")
                    if not isinstance(feats, list):
                        return False, "Respuesta inválida en /api/plugins/features (sin lista features)."
                    if "file_edit" not in feats:
                        return False, (
                            "Release generada sin plugin file_edit en runtime. "
                            f"features={sorted(str(x) for x in feats)}"
                        )
                    return True, f"OK runtime plugins en puerto {port}: {sorted(str(x) for x in feats)}"
            except urllib.error.URLError as e:
                last_err = str(e)
                time.sleep(0.25)
            except Exception as e:  # noqa: BLE001
                last_err = str(e)
                time.sleep(0.25)
        return False, f"Timeout validando /api/plugins/features en {url}: {last_err}"
    finally:
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            probe_cfg.unlink(missing_ok=True)
        except Exception:
            pass


def _setup_ttk_style() -> ttk.Style:
    st = ttk.Style()
    try:
        st.theme_use("clam")
    except tk.TclError:
        pass
    st.configure("App.TFrame", background=BG_APP)
    st.configure("Header.TLabel", background=BG_APP, foreground=TEXT_MAIN, font=("Segoe UI", 13, "bold"))
    st.configure("Sub.TLabel", background=BG_APP, foreground=TEXT_MUTED, font=("Segoe UI", 9))
    st.configure("Path.TLabel", background=BG_APP, foreground=TEXT_MUTED, font=("Consolas", 8))
    st.configure("Status.TLabel", background=BG_APP, foreground=TEXT_MAIN, font=("Segoe UI", 9))
    st.configure("TNotebook", background=BG_APP, borderwidth=0)
    st.configure("TNotebook.Tab", padding=(14, 8), font=("Segoe UI", 10))
    st.configure("TButton", font=("Segoe UI", 10), padding=(14, 8))
    st.configure("Accent.TButton", font=("Segoe UI", 10, "bold"), padding=(16, 9))
    st.map("Accent.TButton", background=[("active", "#1d4ed8")])
    try:
        st.configure("Accent.TButton", background="#2563eb", foreground="white")
    except tk.TclError:
        st.configure("Accent.TButton", background="#2563eb")
    st.configure("Horizontal.TProgressbar", thickness=8)
    return st


def _add_option_row(parent: tk.Widget, label: str, var: tk.BooleanVar) -> None:
    """Fila tipo tarjeta: banda de color + etiqueta Incluido/Excluido + checkbox con selectcolor verde."""
    row = tk.Frame(parent, bg=BG_CARD_OFF, highlightthickness=1, highlightbackground=BORDER_CARD)
    row.pack(fill=tk.X, pady=4, padx=2)

    stripe = tk.Frame(row, width=5, bg="#94a3b8")
    stripe.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 10), pady=0)

    inner = tk.Frame(row, bg=BG_CARD_OFF)
    inner.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 10), pady=8)

    badge = tk.Label(inner, text="", font=("Segoe UI", 8, "bold"), bg=BG_CARD_OFF)
    badge.pack(anchor=tk.W)

    cb = tk.Checkbutton(
        inner,
        text=label,
        variable=var,
        font=("Segoe UI", 10),
        fg=TEXT_MAIN,
        anchor=tk.W,
        highlightthickness=0,
        selectcolor=ACCENT_ON,
        indicatoron=True,
    )

    def sync(*_a: Any) -> None:
        on = var.get()
        bg = ACCENT_ON_LIGHT if on else BG_CARD_OFF
        stripe_bg = ACCENT_ON if on else "#94a3b8"
        row.configure(bg=bg, highlightbackground=(ACCENT_ON if on else BORDER_CARD))
        stripe.configure(bg=stripe_bg)
        inner.configure(bg=bg)
        badge.configure(
            text="Incluido" if on else "Excluido",
            fg=ACCENT_ON if on else TEXT_MUTED,
            bg=bg,
        )
        cb.configure(
            bg=bg,
            activebackground=bg,
            activeforeground=TEXT_MAIN,
            selectcolor=ACCENT_ON,
        )

    cb.config(command=sync)
    cb.pack(anchor=tk.W, fill=tk.X)
    try:
        var.trace_add("write", lambda *_: sync())
    except AttributeError:
        var.trace("w", lambda *_: sync())
    sync()


class App:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("VarMonitor — empaquetado de plugins")
        self.root.minsize(560, 520)
        self.root.configure(bg=BG_APP)

        self._vars: dict[str, dict[str, tk.BooleanVar]] = {
            "ids": {},
            "hooks": {},
            "ui": {},
        }
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._busy = False

        _setup_ttk_style()

        if not verify_root():
            messagebox.showerror(
                "Error",
                f"No se encontró el repositorio esperado junto a:\n{ROOT}",
            )
            self.root.after(100, self.root.destroy)
            return

        outer = ttk.Frame(self.root, style="App.TFrame", padding=16)
        outer.pack(fill=tk.BOTH, expand=True)

        ttk.Label(outer, text="Plugins y entrega web_monitor_version", style="Header.TLabel").pack(anchor=tk.W)
        ttk.Label(
            outer,
            text="Marca qué incluir en el wheel y el bundle JS; luego build y paquete.",
            style="Sub.TLabel",
        ).pack(anchor=tk.W, pady=(2, 0))
        ttk.Label(outer, text=str(ROOT), style="Path.TLabel").pack(anchor=tk.W, pady=(6, 0))

        self._var_full_package = tk.BooleanVar(value=True)
        pkg_hint = ttk.Frame(outer, style="App.TFrame")
        pkg_hint.pack(fill=tk.X, pady=(10, 0))
        self._cb_full_package = ttk.Checkbutton(
            pkg_hint,
            text="Generar entrega final (generate_webmonitor_version: CMake, PyInstaller → web_monitor_version/)",
            variable=self._var_full_package,
        )
        self._cb_full_package.pack(anchor=tk.W)
        ttk.Label(
            pkg_hint,
            text="Desmarcar solo para trabajo local: build del wheel y JS, sin empaquetado ni binario varmonitor-web.",
            style="Sub.TLabel",
        ).pack(anchor=tk.W, pady=(4, 0))

        nb = ttk.Notebook(outer)
        nb.pack(fill=tk.BOTH, expand=True, pady=(14, 10))

        for sec, tab_title in (
            ("ids", TAB_TITLES["ids"]),
            ("hooks", TAB_TITLES["hooks"]),
            ("ui", TAB_TITLES["ui"]),
        ):
            tab_outer = tk.Frame(nb, bg=BG_APP)
            nb.add(tab_outer, text=tab_title)
            canvas = tk.Canvas(tab_outer, bg=BG_APP, highlightthickness=0, borderwidth=0)
            scroll_y = ttk.Scrollbar(tab_outer, orient=tk.VERTICAL, command=canvas.yview)
            tab = tk.Frame(canvas, bg=BG_APP)
            inner_win = canvas.create_window((0, 0), window=tab, anchor=tk.NW)

            def _on_tab_configure(_event: tk.Event, c=canvas) -> None:
                c.configure(scrollregion=c.bbox("all"))

            def _on_canvas_configure(event: tk.Event, c=canvas, wid=inner_win) -> None:
                c.itemconfigure(wid, width=event.width)

            tab.bind("<Configure>", _on_tab_configure)
            canvas.bind("<Configure>", _on_canvas_configure)
            canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
            scroll_y.pack(side=tk.RIGHT, fill=tk.Y)
            canvas.configure(yscrollcommand=scroll_y.set)

            def _wheel(event: tk.Event, c=canvas) -> str | None:
                if event.delta:
                    c.yview_scroll(int(-event.delta / 120), "units")
                return "break"

            def _wheel_linux_up(_event: tk.Event, c=canvas) -> None:
                c.yview_scroll(-3, "units")

            def _wheel_linux_down(_event: tk.Event, c=canvas) -> None:
                c.yview_scroll(3, "units")

            canvas.bind("<MouseWheel>", _wheel)
            canvas.bind("<Button-4>", _wheel_linux_up)
            canvas.bind("<Button-5>", _wheel_linux_down)

            data = load_selection()[sec]
            for key in DEFAULTS[sec]:
                var = tk.BooleanVar(value=data.get(key, DEFAULTS[sec][key]))
                self._vars[sec][key] = var
                label = LABELS.get(key, key)
                _add_option_row(tab, label, var)

        btn_row = ttk.Frame(outer, style="App.TFrame")
        btn_row.pack(fill=tk.X, pady=(0, 8))
        self._btn_save = ttk.Button(btn_row, text="Guardar selección", command=self._save_only)
        self._btn_save.pack(side=tk.LEFT, padx=(0, 10))
        self._btn_deploy = ttk.Button(btn_row, text="Build y desplegar", command=self._deploy, style="Accent.TButton")
        self._btn_deploy.pack(side=tk.LEFT)

        self._status = ttk.Label(outer, text="Listo.", style="Status.TLabel")
        self._status.pack(anchor=tk.W)

        self._progress = ttk.Progressbar(outer, mode="determinate", maximum=4, length=400)
        self._progress_full_max = 4
        self._progress_local_max = 3
        self._progress.pack(fill=tk.X, pady=8)
        self._progress["value"] = 0

        log_frame = tk.Frame(outer, bg=BORDER_CARD, padx=1, pady=1)
        log_frame.pack(fill=tk.BOTH, expand=True)
        self._log = scrolledtext.ScrolledText(
            log_frame,
            height=10,
            state=tk.DISABLED,
            wrap=tk.WORD,
            font=("Consolas", 9),
            bg="#f1f5f9",
            fg=TEXT_MAIN,
            insertbackground=TEXT_MAIN,
            relief=tk.FLAT,
        )
        self._log.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        self.root.after(150, self._poll_queue)

    def _append_log(self, text: str) -> None:
        self._log.configure(state=tk.NORMAL)
        self._log.delete("1.0", tk.END)
        self._log.insert(tk.END, text)
        self._log.configure(state=tk.DISABLED)

    def _selection_dict(self) -> dict[str, dict[str, bool]]:
        return {
            "ids": {k: self._vars["ids"][k].get() for k in DEFAULTS["ids"]},
            "hooks": {k: self._vars["hooks"][k].get() for k in DEFAULTS["hooks"]},
            "ui": {k: self._vars["ui"][k].get() for k in DEFAULTS["ui"]},
        }

    def _save_only(self) -> None:
        if self._busy:
            return
        SELECTION_PATH.parent.mkdir(parents=True, exist_ok=True)
        SELECTION_PATH.write_text(
            json.dumps(self._selection_dict(), indent=2) + "\n",
            encoding="utf-8",
        )
        self._status.configure(text=f"Guardado: {SELECTION_PATH}")
        messagebox.showinfo("Guardado", str(SELECTION_PATH))

    def _set_busy(self, busy: bool) -> None:
        self._busy = busy
        state = tk.DISABLED if busy else tk.NORMAL
        self._btn_save.configure(state=state)
        self._btn_deploy.configure(state=state)
        self._cb_full_package.configure(state=state)

    def _deploy(self) -> None:
        if self._busy:
            return
        self._set_busy(True)
        self._progress["value"] = 0
        do_full = self._var_full_package.get()
        self._progress["maximum"] = self._progress_full_max if do_full else self._progress_local_max
        self._status.configure(text="Trabajando…")
        self._append_log("")

        do_full_package = do_full

        def worker() -> None:
            try:
                doc = self._selection_dict()
                if do_full_package:
                    self._queue.put(("status", "Limpiando artefactos previos (release desde cero)…"))
                    _clean_release_workspace()
                self._queue.put(("progress", 1))
                self._queue.put(("status", "Escribiendo plugin-selection.json…"))
                SELECTION_PATH.parent.mkdir(parents=True, exist_ok=True)
                SELECTION_PATH.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

                self._queue.put(("progress", 2))
                self._queue.put(("status", "Ejecutando build_all.sh (puede tardar varios minutos)…"))
                code, tail = run_bash("tool_plugins/scripts/build_all.sh")
                self._queue.put(("log", tail))
                if code != 0:
                    self._queue.put(("error", ("build_all.sh", f"Código {code}\n\n{tail}")))
                    return

                if not do_full_package:
                    self._queue.put(("progress", 3))
                    self._queue.put(("status", "Hecho (solo build de plugins; sin web_monitor_version)."))
                    self._queue.put(("done_local", None))
                    return

                self._queue.put(("progress", 3))
                self._queue.put(("status", "Ejecutando generate_webmonitor_version.sh (CMake + PyInstaller)…"))
                wheel, err = _latest_valid_dist_wheel()
                if wheel is None:
                    self._queue.put(("error", ("Wheel Pro inválida", err)))
                    return
                env = {
                    "VARMON_PLUGINS_RELEASE": "1",
                    "VARMON_RELEASE_CLEAN": "1",
                    # Forzar la wheel recién generada en tool_plugins/dist; no usar vendor ni cachés.
                    "VARMON_PLUGINS_WHEEL": str(wheel),
                }
                code, tail = run_bash("scripts/varmon/generate_webmonitor_version.sh", extra_env=env)
                self._queue.put(("log", tail))
                if code != 0:
                    self._queue.put(("error", ("generate_webmonitor_version.sh", f"Código {code}\n\n{tail}")))
                    return

                self._queue.put(("status", "Validando runtime empaquetado (/api/plugins/features)…"))
                ok_probe, msg_probe = _probe_packaged_features()
                if not ok_probe:
                    self._queue.put(("error", ("Validación post-build", msg_probe)))
                    return
                self._queue.put(("log", msg_probe))

                self._queue.put(("progress", 4))
                self._queue.put(("status", "Hecho. Salida: web_monitor_version/{bin,data,include}/"))
                self._queue.put(("done", None))
            except Exception as ex:  # noqa: BLE001
                self._queue.put(("error", ("Error", str(ex))))

        threading.Thread(target=worker, daemon=True).start()

    def _poll_queue(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == "progress":
                    self._progress["value"] = int(payload)
                elif kind == "status":
                    self._status.configure(text=str(payload))
                elif kind == "log":
                    self._append_log(str(payload))
                elif kind == "error":
                    title, msg = payload
                    messagebox.showerror(title, msg[:8000])
                    self._status.configure(text="Error.")
                    self._progress["value"] = 0
                    self._set_busy(False)
                elif kind == "done_local":
                    self._set_busy(False)
                    messagebox.showinfo(
                        "Build (local)",
                        "Completado: wheel, bundle JS y sincronización a web_monitor/static/plugins/\n"
                        "(copy_to_mit al final de build_all.sh).\n"
                        "No se ha ejecutado generate_webmonitor_version (sin CMake/PyInstaller ni carpeta web_monitor_version).",
                    )
                elif kind == "done":
                    self._set_busy(False)
                    messagebox.showinfo(
                        "Despliegue",
                        f"Completado.\nEntrega: {ROOT / 'web_monitor_version'}\n"
                        f"(bin/, data/, include/, libvarmonitor.so)",
                    )
        except queue.Empty:
            pass
        self.root.after(200, self._poll_queue)

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    if not verify_root():
        print(f"ERROR: raíz de repo no válida: {ROOT}", file=sys.stderr)
        return 1
    App().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
