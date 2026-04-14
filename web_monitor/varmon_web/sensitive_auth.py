"""Contraseña adicional para modos sensibles (editor de archivos, BD protocolos)."""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

# GET sin contraseña de ingeniería: estado SQLite y registro activo (solo lectura; monitor en vivo).
_PUBLIC_PROTOCOL_GET_PATHS = frozenset(
    {
        "/api/arinc_db/status",
        "/api/arinc_registry/active",
        "/api/m1553_db/status",
        "/api/m1553_registry/active",
    },
)


def path_requires_sensitive_auth(path: str, method: str = "GET") -> bool:
    """Rutas que requieren X-VarMon-Sensitive-Password si está configurada."""
    if not path.startswith("/api/"):
        return False
    m = (method or "GET").upper()
    if m == "GET" and path in _PUBLIC_PROTOCOL_GET_PATHS:
        return False
    # Públicas (sin contraseña de ingeniería)
    public = (
        "/api/auth_status",
        "/api/auth_required",
        "/api/connection_info",
        "/api/uds_instances",
        "/api/plugins/features",
        "/api/log",
        "/api/perf",
        "/api/advanced_stats",
    )
    if path.startswith(public):
        return False
    if path == "/api/terminal/status" or path.startswith("/api/terminal/status"):
        return False
    if path == "/api/gdb_debug/status":
        return False
    if path.startswith("/api/terminal"):
        return True
    if path.startswith("/api/gdb_debug"):
        return True
    if path.startswith("/api/browse"):
        return True
    if path.startswith("/api/file_edit"):
        return True
    if path.startswith("/api/git_ui"):
        return True
    if path.startswith("/api/arinc_db"):
        return True
    if path.startswith("/api/arinc_registry"):
        return True
    if path.startswith("/api/m1553"):
        return True
    if path.startswith("/api/arinc_registries"):
        return True
    if path.startswith("/api/avionics_registry"):
        return True
    return False


def verify_sensitive_request(request: Request, config: dict[str, Any], path: str) -> JSONResponse | None:
    """Contraseña de ingeniería (si existe) y/o contraseña global en rutas sensibles."""
    sp = (config.get("sensitive_modes_password") or "").strip()
    ap = (config.get("auth_password") or "").strip()
    if sp:
        given = (request.headers.get("X-VarMon-Sensitive-Password") or "").strip()
        if given != sp:
            return JSONResponse(
                {"error": "Se requiere contraseña de ingeniería", "code": "sensitive_auth_required"},
                status_code=401,
            )
        if ap:
            gp = (request.headers.get("X-VarMon-Password") or "").strip()
            if gp != ap:
                return JSONResponse(
                    {"error": "Se requiere contraseña global", "code": "global_auth_required"},
                    status_code=401,
                )
        return None
    if ap and path_requires_sensitive_auth(path, request.method):
        gp = (request.headers.get("X-VarMon-Password") or "").strip()
        if gp != ap:
            return JSONResponse(
                {"error": "Se requiere contraseña global", "code": "global_auth_required"},
                status_code=401,
            )
    return None
