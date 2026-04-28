# -*- mode: python ; coding: utf-8 -*-
# Build: ../../scripts/varmon/build_varmonitor_web.sh   o   python3 -m PyInstaller varmonitor-web.spec
# Requiere: pip install -r requirements-docker.txt -r requirements-build.txt
# Con VARMON_PLUGINS_RELEASE=1: wheel varmonitor_plugins instalado + requirements-plugins-release.txt

import os

from PyInstaller.utils.hooks import collect_all

block_cipher = None

PLUGINS_RELEASE = os.environ.get("VARMON_PLUGINS_RELEASE", "0").strip().lower() in ("1", "true", "yes")

datas = [("static", "static")]
binaries = []
hiddenimports = [
    "varmon_web",
    "varmon_web.settings",
    "varmon_web.paths",
    "varmon_web.log_buffer",
    "varmon_web.uds_discovery",
    "uds_client",
    "shm_reader",
    "perf_agg",
    "websockets",
    "websockets.legacy",
    "websockets.legacy.server",
    "uvloop",
    "httptools",
    "h11",
    "pydantic",
    "pydantic_core",
    "pydantic_core._pydantic_core",
    "plugin_registry",
]

if PLUGINS_RELEASE:
    hiddenimports += [
        "varmonitor_plugins",
        "varmonitor_plugins.parquet_recording",
        "varmonitor_plugins.recordings_parquet",
        "varmonitor_plugins.arinc_sqlite",
        "varmonitor_plugins.m1553_sqlite",
        "varmonitor_plugins.git_ui_api",
        "varmonitor_plugins.terminal_api",
        "varmonitor_plugins.gdb_debug",
        "varmonitor_plugins.pro_http",
        "varmonitor_plugins.pro_backend",
        "varmonitor_plugins.pro_recordings_routes",
    ]
    try:
        d, b, h = collect_all("varmonitor_plugins")
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as e:
        print(f"[varmonitor-web.spec] collect_all(varmonitor_plugins): {e}")
    try:
        d2, b2, h2 = collect_all("pyarrow")
        datas += d2
        binaries += b2
        hiddenimports += h2
    except Exception as e:
        print(f"[varmonitor-web.spec] collect_all(pyarrow): {e}")

for pkg in ("uvicorn", "starlette", "fastapi"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="varmonitor-web",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
