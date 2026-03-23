# -*- mode: python ; coding: utf-8 -*-
# Build: ../../scripts/varmon/build_varmonitor_web.sh   o   python3 -m PyInstaller varmonitor-web.spec
# Requiere: pip install -r requirements-docker.txt -r requirements-build.txt

from PyInstaller.utils.hooks import collect_all

block_cipher = None

datas = [("static", "static")]
binaries = []
hiddenimports = [
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
]

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
