# Binario empaquetado (PyInstaller)

Para máquinas donde **no se puede instalar** dependencias Python con `pip`, puedes generar un **único ejecutable** que incluye el intérprete y las librerías (`fastapi`, `uvicorn`, estáticos, etc.).

## Requisitos

- **Solo en la máquina de build:** Python 3.12+ (recomendado), `python3-venv` si el sistema lo pide.
- El binario debe construirse para el **mismo sistema** que el destino (p. ej. Linux x86_64 → Linux x86_64; no mezclar glibc antiguo/nuevo sin probar).

## Generar el binario

Desde la raíz del repositorio:

```bash
chmod +x scripts/varmon/build_varmonitor_web.sh
./scripts/varmon/build_varmonitor_web.sh
```

Salida: `web_monitor/dist/varmonitor-web` (modo consola, onefile).

El script crea `web_monitor/.venv-build/`, instala `requirements-docker.txt` + `requirements-build.txt` y ejecuta PyInstaller con `web_monitor/varmonitor-web.spec`.

## Uso en el destino

- Copia el ejecutable (y, si aplica, `varmon.conf` junto al binario o define `VARMON_CONFIG`).
- Ejecuta: `./varmonitor-web` (no hace falta Python instalado en el sistema).
- Abre el navegador en la URL que imprime el proceso (puerto según `varmon.conf` / autodetección).

## Lanzamiento con navegador (PyInstaller)

Tras construir el binario, en la máquina donde **sí** tengas `python3` (solo los scripts de arranque) y, si quieres ventana embebida, `requirements-desktop.txt`:

```bash
export VARMON_PACKAGED_WEB_BIN="$PWD/web_monitor/dist/varmonitor-web"
./scripts/launch_web.sh      # solo backend empaquetado
./scripts/launch_ui.sh       # abre pywebview / navegador en el puerto detectado
```

Ver **[scripts/LAUNCH.md](../scripts/LAUNCH.md)** para el flujo completo (`launch_demo` / `launch_web` / `launch_ui`).

## Paquete de entrega (`web_monitor_version/`)

Para generar en un solo paso el JS minificado (si hay `npx`), `varmon_sidecar` y el binario PyInstaller, y copiarlos a `web_monitor_version/`:

```bash
chmod +x scripts/varmon/generate_webmonitor_version.sh
./scripts/varmon/generate_webmonitor_version.sh
```

Opcional: `VARMON_SKIP_JS=1` si no hay Node; `VARMON_BUILD_DIR` para el directorio de build de CMake (por defecto `build/`).

La entrega bajo `web_monitor_version/` tiene el layout:

- `bin/` — `varmonitor-web`, `varmon_sidecar`, `libvarmonitor.so*` (biblioteca C++ para integrar tu demo u otras apps)
- `data/` — `varmon.conf` de ejemplo
- `include/` — cabeceras públicas (`var_monitor.hpp`, etc.) para compilar enlazando contra `libvarmonitor.so`

Con `source scripts/simple_config.sh` en modo `package`, las rutas por defecto apuntan a `INSTALL_DIR/bin/...`, `INSTALL_DIR/data/varmon.conf` y `INSTALL_DIR/data/` para grabaciones y estado (override con `VARMON_DATA_DIR` o claves en `varmon.conf`).

## Notas

- El modo **onefile** extrae el bundle a un directorio temporal al arrancar; el primer arranque puede ser algo más lento.
- `varmon_sidecar` y otros binarios nativos **no** van dentro del ejecutable Python; si los usas, despliega el binario junto al ejecutable y configura rutas en `varmon.conf`.
- Si PyInstaller falla al arrancar por un módulo faltante, amplía `hiddenimports` en `varmonitor-web.spec` y vuelve a construir.
