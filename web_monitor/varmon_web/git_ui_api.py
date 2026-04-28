"""API REST para el modo Git (status, diff, stage, commit, push, pull, log) bajo GIT_WORKSPACE_ROOT."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from varmon_web.paths import GIT_WORKSPACE_ROOT
from varmon_web.settings import CONFIG, CONFIG_ABS_PATH

router = APIRouter(prefix="/api/git_ui", tags=["git_ui"])


def _git_workspace_root() -> Path:
    """Raíz para operaciones Git: env (prioridad) o `git_workspace_root` de varmon.conf."""
    for key in ("VARMON_GIT_WORKSPACE_ROOT", "GIT_WORKSPACE_ROOT"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            try:
                return Path(os.path.abspath(os.path.expanduser(raw))).resolve()
            except OSError:
                pass
    try:
        return GIT_WORKSPACE_ROOT.resolve()
    except OSError:
        return Path.cwd()

_MAX_DIFF_BYTES = 512 * 1024
# Tope duro del parámetro HTTP `limit` (el tope efectivo viene de git_log_max_commits en varmon.conf).
_GIT_LOG_QUERY_MAX = 500
_GIT_TIMEOUT = 120
_REV_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")
_FULL_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")


def _git_log_max_commits() -> int:
    """Máximo de commits en el historial Git (UI); configurable en varmon.conf."""
    try:
        v = int(CONFIG.get("git_log_max_commits", 80))
    except (TypeError, ValueError):
        v = 80
    return max(1, min(v, _GIT_LOG_QUERY_MAX))


def _effective_git_log_limit(requested: int) -> tuple[int, int]:
    """Devuelve (límite aplicado a git log, tope desde config)."""
    cap = _git_log_max_commits()
    try:
        r = int(requested)
    except (TypeError, ValueError):
        r = cap
    r = max(1, min(r, _GIT_LOG_QUERY_MAX))
    return min(r, cap), cap


def _parse_git_log_graph_entries(out: str) -> list[dict[str, Any]]:
    """Parse `git log --graph --format=...` output (incl. líneas solo ASCII del grafo)."""
    entries: list[dict[str, Any]] = []
    for raw in out.splitlines():
        line = raw.strip("\r\n")
        if not line:
            continue
        if "\x01" not in line:
            entries.append(
                {
                    "graph": line,
                    "id": None,
                    "parents": [],
                    "subject": "",
                    "author": "",
                    "date": "",
                    "refs": "",
                },
            )
            continue
        parts = line.split("\x01")
        if len(parts) < 6:
            continue
        head = parts[0]
        if len(head) < 40:
            continue
        hid = head[-40:]
        if not _FULL_SHA_RE.match(hid):
            continue
        # Sin rstrip: los espacios tras * o | alinean columnas como en `git log --graph`.
        graph = head[:-40]
        parents, subj, author, date, refs = parts[1], parts[2], parts[3], parts[4], parts[5]
        entries.append(
            {
                "graph": graph,
                "id": hid,
                "parents": [p for p in parents.split() if p],
                "subject": subj,
                "author": author,
                "date": date,
                "refs": refs.strip(),
            },
        )
    return entries


def _resolve_repo_path(relative_path: str) -> Path | None:
    """Directorio bajo la raíz Git (vacío = raíz configurada para Git)."""
    root = _git_workspace_root()
    rel = (relative_path or "").strip().replace("\\", "/").strip("/")
    try:
        path = (root / rel).resolve()
        if not path.is_relative_to(root):
            return None
        if not path.is_dir():
            return None
        return path
    except (ValueError, OSError):
        return None


def _is_git_work_tree(repo: Path) -> bool:
    try:
        r = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return r.returncode == 0 and (r.stdout or "").strip().lower() == "true"
    except (OSError, subprocess.TimeoutExpired):
        return False


def _repo_rel_str(abs_path: Path) -> str:
    """Ruta relativa a la raíz Git (vacío = raíz del árbol Git)."""
    root = _git_workspace_root()
    try:
        ap = abs_path.resolve()
        if ap == root:
            return ""
        return str(ap.relative_to(root)).replace("\\", "/")
    except (ValueError, OSError):
        return ""


def _git_workdir_from_repo_rel(rel: str) -> tuple[Path | None, JSONResponse | None]:
    """Resuelve el directorio real del trabajo Git con `git rev-parse --show-toplevel`."""
    base = _resolve_repo_path(rel)
    if base is None:
        return None, JSONResponse({"error": "Ruta de repositorio inválida"}, status_code=400)
    code, out, err = _run_git(base, ["rev-parse", "--show-toplevel"])
    if code != 0:
        msg = (err or out or "").strip() or "git rev-parse falló"
        return None, JSONResponse(
            {"error": f"No es un repositorio git o git no disponible: {msg}"},
            status_code=400,
        )
    line = (out or "").strip().splitlines()
    if not line:
        return None, JSONResponse({"error": "No es un repositorio git"}, status_code=400)
    top = Path(line[0]).resolve()
    root = _git_workspace_root().resolve()
    try:
        # Antes se exigía top ⊆ root; eso falla si el .git está en un padre (p. ej. monorepo en /opt/workspace
        # y git_workspace_root en /opt/workspace/monitor). Válido: mismo toplevel, o workspace dentro del árbol.
        if top != root and not root.is_relative_to(top):
            return None, JSONResponse({"error": "Repositorio fuera del directorio permitido"}, status_code=400)
    except ValueError:
        return None, JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if not top.is_dir():
        return None, JSONResponse({"error": "Ruta inválida"}, status_code=400)
    return top, None


def _validate_path_in_repo(repo: Path, rel_file: str) -> Path | None:
    raw = (rel_file or "").strip().replace("\\", "/")
    if not raw or ".." in raw.split("/"):
        return None
    try:
        # Rutas relativas al repo (como devuelve git)
        cand = (repo / raw).resolve()
        if not cand.is_relative_to(repo.resolve()):
            return None
        return cand
    except (ValueError, OSError):
        return None


def _run_git(repo: Path, args: list[str], *, timeout: int = _GIT_TIMEOUT) -> tuple[int, str, str]:
    cmd = ["git", "-C", str(repo), *args]
    try:
        p = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", "git: tiempo de espera agotado"
    except OSError as e:
        return 1, "", str(e)


def _git_ui_routes_already_registered(app: Any) -> bool:
    for r in app.routes:
        p = getattr(r, "path", None)
        if p is not None and str(p).startswith("/api/git_ui"):
            return True
    return False


def register_git_ui_routes(app: Any) -> None:
    """Registra rutas; el id `git_ui` ya lo declara `pro_backend.register_pro_extensions`."""
    if _git_ui_routes_already_registered(app):
        return
    app.include_router(router)


@router.get("/debug_roots")
async def git_debug_roots() -> dict[str, Any]:
    """Rutas Git efectivas vs config (diagnóstico). Requiere contraseña de modo sensible si está activa."""
    eff = _git_workspace_root()
    try:
        cfg_root = GIT_WORKSPACE_ROOT.resolve()
    except OSError:
        cfg_root = Path.cwd()
    return {
        "from_config_git_workspace_root": str(cfg_root),
        "effective_root": str(eff),
        "effective_is_dir": eff.is_dir(),
        "dot_git_at_effective_root": (eff / ".git").exists(),
        "env_VARMON_GIT_WORKSPACE_ROOT": (os.environ.get("VARMON_GIT_WORKSPACE_ROOT") or "").strip(),
        "env_GIT_WORKSPACE_ROOT": (os.environ.get("GIT_WORKSPACE_ROOT") or "").strip(),
        "varmon_config_path": CONFIG_ABS_PATH or "",
        "config_key_git_workspace_root": (CONFIG.get("git_workspace_root") or "").strip(),
    }


def _git_toplevel_from_path(start: Path) -> Path | None:
    """`git rev-parse --show-toplevel` desde un directorio (p. ej. subcarpeta de un repo sin .git propio)."""
    if not start.is_dir():
        return None
    code, out, _err = _run_git(start, ["rev-parse", "--show-toplevel"])
    if code != 0 or not (out or "").strip():
        return None
    line = (out or "").strip().splitlines()
    if not line:
        return None
    try:
        return Path(line[0]).resolve()
    except OSError:
        return None


def _list_git_repos_under_browser_root() -> list[dict[str, str]]:
    """Raíz Git (`git_workspace_root` / env) y subcarpetas con `.git` propio (hasta profundidad fija)."""
    root = _git_workspace_root().resolve()
    repos: list[dict[str, str]] = []
    seen: set[str] = set()
    has_main = False
    if (root / ".git").exists():
        has_main = True
    else:
        gt = _git_toplevel_from_path(root)
        if gt is not None and (gt == root or root.is_relative_to(gt)):
            has_main = True
    if has_main:
        repos.append({"rel": "", "label": "main"})
        seen.add("")
    max_depth = 10
    skip = {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        ".cursor",
        "target",
        ".next",
    }
    try:
        for dirpath, dirnames, _ in os.walk(str(root), topdown=True):
            p = Path(dirpath)
            try:
                rel = p.relative_to(root)
            except ValueError:
                continue
            depth = len(rel.parts)
            if depth == 0:
                continue
            if depth > max_depth:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if d not in skip]
            if (p / ".git").exists():
                s = str(rel).replace("\\", "/")
                if s not in seen:
                    seen.add(s)
                    repos.append({"rel": s, "label": s})
    except OSError:
        pass
    repos.sort(key=lambda x: (x["rel"] != "", x["rel"]))
    return repos


@router.get("/repos")
async def git_repos() -> dict[str, Any]:
    """Lista repositorios Git bajo GIT_WORKSPACE_ROOT (main + subrepositorios)."""
    return {"repos": _list_git_repos_under_browser_root()}


@router.get("/discover")
async def git_discover() -> dict[str, Any]:
    """Indica si bajo la raíz del explorador hay un repo Git y la ruta relativa sugerida."""
    rpath, err = _git_workdir_from_repo_rel("")
    if err is not None or rpath is None:
        return {"ok": False, "git_repo_relative": ""}
    return {"ok": True, "git_repo_relative": _repo_rel_str(rpath)}


@router.get("/head_file")
async def git_head_file(
    repo: str = Query("", description="Ruta relativa al repo bajo el proyecto"),
    path: str = Query(..., description="Ruta del archivo relativa al toplevel del repo"),
) -> dict[str, Any]:
    """Contenido del archivo en HEAD para comparar el editor con el último commit (líneas «sucias»).

    Si el archivo no está en el índice, o existe pero no en HEAD (p. ej. añadido y aún sin commit),
    devuelve ``in_head: false`` y ``text`` vacío (la comparación trata el archivo como nuevo).
    """
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    vf = _validate_path_in_repo(rpath, path)
    if vf is None:
        return JSONResponse({"error": "Ruta de archivo inválida"}, status_code=400)
    rel = str(vf.relative_to(rpath.resolve())).replace("\\", "/")
    code_tracked, _, _ = _run_git(rpath, ["ls-files", "--error-unmatch", "--", rel])
    if code_tracked != 0:
        return {"ok": True, "in_head": False, "text": ""}
    code, out, _err = _run_git(rpath, ["show", f"HEAD:{rel}"])
    if code != 0:
        return {"ok": True, "in_head": False, "text": ""}
    raw = out or ""
    if len(raw.encode("utf-8", errors="replace")) > _MAX_DIFF_BYTES:
        raw = raw[:_MAX_DIFF_BYTES] + "\n\n[… truncado …]\n"
    return {"ok": True, "in_head": True, "text": raw}


@router.get("/status")
async def git_status(repo: str = Query("", description="Ruta relativa al repo bajo el proyecto")) -> dict[str, Any]:
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)

    code, out, err = _run_git(rpath, ["diff", "--name-only"])
    if code != 0:
        return JSONResponse({"error": err or out or "git diff"}, status_code=500)
    unstaged = [ln.strip() for ln in out.splitlines() if ln.strip()]

    code, out2, err2 = _run_git(rpath, ["diff", "--cached", "--name-only"])
    if code != 0:
        return JSONResponse({"error": err2 or out2 or "git diff --cached"}, status_code=500)
    staged = [ln.strip() for ln in out2.splitlines() if ln.strip()]

    code, out3, err3 = _run_git(rpath, ["ls-files", "--others", "--exclude-standard"])
    if code != 0:
        return JSONResponse({"error": err3 or out3 or "git ls-files"}, status_code=500)
    untracked = [ln.strip() for ln in out3.splitlines() if ln.strip()]

    resolved = _repo_rel_str(rpath)
    return {
        "repo": repo.strip().replace("\\", "/"),
        "resolved_repo": resolved,
        "unstaged": unstaged,
        "staged": staged,
        "untracked": untracked,
    }


@router.get("/diff")
async def git_diff(
    repo: str = Query(""),
    path: str = Query(..., description="Ruta relativa al repo"),
    staged: bool = Query(False, description="Si true, diff del índice (staged)"),
) -> dict[str, Any]:
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    vf = _validate_path_in_repo(rpath, path)
    if vf is None:
        return JSONResponse({"error": "Ruta de archivo inválida"}, status_code=400)

    rel = str(vf.relative_to(rpath.resolve())).replace("\\", "/")
    code_tracked, _, _ = _run_git(rpath, ["ls-files", "--error-unmatch", "--", rel])
    if code_tracked != 0 and not staged and vf.is_file():
        try:
            text = vf.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        if len(text.encode("utf-8", errors="replace")) > _MAX_DIFF_BYTES:
            text = text[:_MAX_DIFF_BYTES] + "\n\n[… truncado …]\n"
        return {
            "path": rel,
            "staged": False,
            "text": "--- archivo sin seguimiento (vista previa) ---\n\n" + text,
        }

    args = ["diff"]
    if staged:
        args.append("--cached")
    args.extend(["--", rel])

    code, out, err = _run_git(rpath, args)
    if code != 0 and code != 1:
        return JSONResponse({"error": err or out or "git diff"}, status_code=500)
    raw = out
    if len(raw.encode("utf-8", errors="replace")) > _MAX_DIFF_BYTES:
        raw = raw[:_MAX_DIFF_BYTES] + "\n\n[… diff truncado …]\n"
    return {"path": rel, "staged": staged, "text": raw}


@router.get("/show")
async def git_show_commit(
    repo: str = Query(""),
    rev: str = Query(..., description="SHA del commit (7–40 hex)"),
) -> dict[str, Any]:
    rev = (rev or "").strip()
    if not _REV_RE.match(rev):
        return JSONResponse({"error": "SHA de commit inválido"}, status_code=400)
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    code, out, err = _run_git(rpath, ["show", "--no-color", rev])
    if code != 0:
        return JSONResponse({"error": err or out or "git show"}, status_code=500)
    raw = out or ""
    if len(raw.encode("utf-8", errors="replace")) > _MAX_DIFF_BYTES:
        raw = raw[:_MAX_DIFF_BYTES] + "\n\n[… salida truncada …]\n"
    return {"rev": rev, "text": raw}


@router.post("/stage")
async def git_stage(request: Request) -> dict[str, Any]:
    body = await request.json()
    repo = (body.get("repo") or "").strip()
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        return JSONResponse({"error": "paths requerido"}, status_code=400)
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    rels: list[str] = []
    for p in paths:
        if not isinstance(p, str):
            continue
        vf = _validate_path_in_repo(rpath, p)
        if vf is None:
            return JSONResponse({"error": f"Ruta inválida: {p}"}, status_code=400)
        rels.append(str(vf.relative_to(rpath.resolve())).replace("\\", "/"))
    if not rels:
        return JSONResponse({"error": "Sin rutas válidas"}, status_code=400)
    code, out, err = _run_git(rpath, ["add", "--", *rels])
    if code != 0:
        return JSONResponse({"error": err or out or "git add"}, status_code=500)
    return {"ok": True}


@router.post("/unstage")
async def git_unstage(request: Request) -> dict[str, Any]:
    body = await request.json()
    repo = (body.get("repo") or "").strip()
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        return JSONResponse({"error": "paths requerido"}, status_code=400)
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    rels: list[str] = []
    for p in paths:
        if not isinstance(p, str):
            continue
        vf = _validate_path_in_repo(rpath, p)
        if vf is None:
            return JSONResponse({"error": f"Ruta inválida: {p}"}, status_code=400)
        rels.append(str(vf.relative_to(rpath.resolve())).replace("\\", "/"))
    if not rels:
        return JSONResponse({"error": "Sin rutas válidas"}, status_code=400)
    code, out, err = _run_git(rpath, ["restore", "--staged", "--", *rels])
    if code != 0:
        code, out, err = _run_git(rpath, ["reset", "HEAD", "--", *rels])
    if code != 0:
        return JSONResponse({"error": err or out or "git unstage"}, status_code=500)
    return {"ok": True}


@router.post("/commit")
async def git_commit(request: Request) -> dict[str, Any]:
    body = await request.json()
    repo = (body.get("repo") or "").strip()
    message = (body.get("message") or "").strip()
    if not message:
        return JSONResponse({"error": "Mensaje vacío"}, status_code=400)
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    code, out, err = _run_git(rpath, ["commit", "-m", message])
    if code != 0:
        return JSONResponse({"error": err or out or "git commit"}, status_code=500)
    return {"ok": True, "out": (out or "").strip()}


@router.post("/push")
async def git_push(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        body = {}
    repo = ((body or {}).get("repo") or "").strip()
    remote = ((body or {}).get("remote") or "origin").strip() or "origin"
    branch = ((body or {}).get("branch") or "").strip()
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if branch:
        args = ["push", remote, branch]
    else:
        args = ["push", remote]
    code, out, err = _run_git(rpath, args, timeout=300)
    text = (out or "") + (err or "")
    if code != 0:
        return JSONResponse({"error": text or "git push falló", "code": code}, status_code=500)
    return {"ok": True, "out": text.strip()}


@router.post("/pull")
async def git_pull(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        body = {}
    repo = ((body or {}).get("repo") or "").strip()
    remote = ((body or {}).get("remote") or "origin").strip() or "origin"
    branch = ((body or {}).get("branch") or "").strip()
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    if branch:
        args = ["pull", remote, branch]
    else:
        args = ["pull", remote]
    code, out, err = _run_git(rpath, args, timeout=300)
    text = (out or "") + (err or "")
    if code != 0:
        return JSONResponse({"error": text or "git pull falló", "code": code}, status_code=500)
    return {"ok": True, "out": text.strip()}


@router.get("/log")
async def git_log(
    repo: str = Query(""),
    limit: int = Query(
        80,
        ge=1,
        description="Solicitud de cliente; el servidor aplica git_log_max_commits (varmon.conf) y tope 500.",
    ),
) -> dict[str, Any]:
    rpath, err = _git_workdir_from_repo_rel(repo)
    if err is not None or rpath is None:
        return err or JSONResponse({"error": "Ruta inválida"}, status_code=400)
    eff, log_max = _effective_git_log_limit(limit)
    # %x01 evita conflictos con tabuladores en el asunto. --graph añade líneas ASCII y prefijo al %H.
    fmt = "%H%x01%P%x01%s%x01%an%x01%ci%x01%D"
    code, out, err = _run_git(
        rpath,
        ["log", "--graph", f"-{int(eff)}", f"--format={fmt}", "--topo-order"],
    )
    if code != 0:
        return JSONResponse({"error": err or out or "git log"}, status_code=500)
    commits = _parse_git_log_graph_entries(out or "")
    return {
        "repo": repo.strip().replace("\\", "/"),
        "resolved_repo": _repo_rel_str(rpath),
        "commits": commits,
        "log_max_commits": log_max,
        "limit_applied": eff,
    }
