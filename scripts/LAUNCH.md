# Lanzadores (VarMonitor)

En **`scripts/`** solo hay **cinco** scripts ejecutables en la raíz; el código Python y el resto de utilidades están en **`scripts/varmon/`** (excepto este `LAUNCH.md`).

## `scripts/simple_config.sh` (modo y rutas)

Un solo sitio para elegir **desarrollo** (`code`) o **binarios generados** (`package`) y las rutas (`VARMON_CONFIG`, `VARMON_PACKAGED_WEB_BIN`, `VARMON_SIDECAR_BIN`, `VARMON_DATA_DIR`, etc.). Los lanzadores hacen `source` de este archivo al inicio.

- Edita `VARMON_RUN_MODE` y, en `package`, `VARMON_INSTALL_DIR` (por defecto `<repo>/web_monitor_version/`).
- Depuración: `export VARMON_CONFIG_VERBOSE=1` antes de lanzar para ver en stderr los valores aplicados.
- En shell interactivo: `source scripts/simple_config.sh` y luego los comandos que quieras.

## Los scripts (`scripts/*.sh`)

| Script | Rol |
|--------|-----|
| `./scripts/launch_demo.sh` | Solo el binario **demo_server** (C++). Implementación: `scripts/varmon/launch_demo.py`. |
| `./scripts/launch_web.sh` | Solo el **backend web**: `web_monitor/.venv` + `app.py`, o **`VARMON_PACKAGED_WEB_BIN`** (PyInstaller). Implementación: `scripts/varmon/launch_web.py`. Opción `--web-app-js` (o env **`VARMON_WEB_APP_JS`**) para servir el JS minificado generado por `build_web_static_js.sh`. |
| `./scripts/launch_ui.sh` | Solo la **interfaz** (puerto más alto del rango en `varmon.conf` que responda). `scripts/varmon/launch_ui.py`. Acepta el mismo `--web-app-js` (solo alinea el entorno; el backend debe haberse arrancado con el mismo valor). |
| `./scripts/stop_varmonitor.sh` | Detiene procesos VarMonitor del **usuario actual** (patrones acotados). |
| `./scripts/build_docs_pdf.sh` | PDF desde el nav de MkDocs. `scripts/varmon/build_docs_pdf.py`. |
| `./scripts/run_tests.sh` | Ejecuta todos los **tests unitarios** (Python, C++, JS). Opciones: `--python`, `--cpp`, `--js` (solo esa capa), `--coverage` (cobertura Python con `pytest-cov`: `perf_agg`, `uds_client`, `shm_reader`, `varmonitor_plugins`, `app`). Instala `pip install -e tool_plugins/python` antes de pytest. |

## `scripts/varmon/` (auxiliar)

Incluye: `simple_config.sh` (modo `code`/`package` y exports), `setup.sh`, `docker-run.sh`, `build_varmonitor_web.sh`, `build_web_static_js.sh` (minifica `static/app.js` con esbuild/npx), `generate_webmonitor_version.sh` (empaqueta `web_monitor_version/` con sidecar + PyInstaller + opcionalmente JS), `gui_plugins_deploy.py` (GUI tkinter: checkboxes de plugins, `build_all.sh` + `generate_webmonitor_version.sh`; requiere `python3-tk` en muchos Linux), `patch_pywebview_qt.py`, módulos `varmon_*.py`, `launch_*.py`, `build_docs_pdf.py`.

Ejemplos:

```bash
./scripts/varmon/setup.sh
./scripts/varmon/docker-run.sh
./scripts/varmon/build_varmonitor_web.sh
./scripts/varmon/build_web_static_js.sh   # opcional: genera static/dist/app.bundle.min.js
./scripts/varmon/generate_webmonitor_version.sh   # entrega: web_monitor_version/{bin,data,include}/ (+ libvarmonitor.so)
python3 scripts/varmon/gui_plugins_deploy.py      # GUI: selección de plugins y despliegue (desde raíz del repo)
```

**Release con módulos externos (wheel Python + `static/plugins/build/` con `plugins-loader.js` y `chunks/`):** primero `./tool_plugins/scripts/build_all.sh`, luego `VARMON_PLUGINS_RELEASE=1 ./scripts/varmon/generate_webmonitor_version.sh`. Busca el `.whl` en `web_monitor/vendor/` o `tool_plugins/dist/` y sincroniza el directorio JS (`tool_plugins/dist/plugins-browser/` o `VARMON_PLUGINS_JS_DIR`) a `web_monitor/static/plugins/build/` antes de PyInstaller. Sin `VARMON_PLUGINS_RELEASE`, el empaquetado sigue siendo el núcleo OSS mínimo (`requirements-docker.txt`).

### JS minificado (`VARMON_WEB_APP_JS`)

1. `scripts/varmon/build_web_static_js.sh` (requiere Node.js / `npx`) escribe `web_monitor/static/dist/app.bundle.min.js`.
2. Arranca el backend con **`VARMON_WEB_APP_JS=dist/app.bundle.min.js`** o **`./scripts/launch_web.sh --web-app-js dist/app.bundle.min.js`** (ruta bajo `/static/`).
3. Si empaquetas con PyInstaller, ejecuta el paso 1 **antes** del build para incluir `static/dist/` en el onefile.

## `VARMON_CONFIG` (Python y binario empaquetado)

Tanto **`python app.py`** como el **ejecutable PyInstaller** leen la configuración con la misma lógica en `app.py`:

1. Si **`VARMON_CONFIG`** está definida (ruta al fichero, **recomendado absoluta**), se usa esa ruta (tras `.strip()`).
2. Si no, se busca `varmon.conf` en el cwd, luego `data/varmon.conf` en la raíz del repo, luego `varmon.conf` en la raíz (legado).

`launch_web.sh` **hereda** el entorno: basta con `export VARMON_CONFIG=/ruta/varmon.conf` antes de lanzar. Con el binario empaquetado, si no encuentras el fichero, el log sugiere fijar `VARMON_CONFIG` con ruta absoluta.

`launch_ui.sh` usa la misma prioridad para saber qué `varmon.conf` leer (puertos); opción `--config` o `VARMON_CONFIG`.

## Orden típico

1. `launch_demo.sh` (o tu C++).
2. `launch_web.sh`.
3. `launch_ui.sh`.

## Java: ¿se puede “compilar” para ocultar código?

Java no se suele distribuir como fuente: va en **bytecode** (`.class` / JAR), que es reversible con decompiladores. Para dificultar la lectura se usa **ofuscación** (ProGuard, R8, etc.). Otra opción es **GraalVM Native Image** / **jpackage**, que genera un **binario nativo** sin JVM embebida como tal; igualmente se puede analizar en ensamblador. No existe ocultación total; solo se elevaba la barrera.

## `scripts/_legacy_launch/` (gitignored)

Copias locales opcionales de lanzadores antiguos; no se versiona. Ver historial git si hace falta recuperarlos.
