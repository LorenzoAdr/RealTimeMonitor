# Docker

El backend web (FastAPI + estáticos) puede ejecutarse en contenedor. Hay **dos modos** según necesites conectar al proceso **C++ del host** (UDS + memoria compartida).

## Modo puente (recomendado para análisis sin C++ en el host)

Desde la raíz del repositorio:

```bash
docker compose up --build
# o:
./scripts/varmon/docker-run.sh
```

- Abre **http://localhost:8080** (o el puerto que muestre el log si hay autodescubrimiento).
- El fichero **`data/varmon.conf`** del repo se monta en solo lectura en `/app/varmon.conf`. La carpeta **`web_monitor/recordings`** del host se monta en el contenedor para persistir grabaciones (desarrollo).

## Modo host (Linux: live con el C++ del mismo equipo)

El contenedor comparte la red y el IPC del host para ver los mismos **sockets Unix en `/tmp`** y el **shm** que usa el C++.

```bash
docker compose -f docker-compose.host.yml up --build
# o:
./scripts/varmon/docker-run.sh host
```

Luego abre **http://127.0.0.1:&lt;web_port&gt;** (por defecto `8080` en `varmon.conf`).

**Requisitos:** Linux (no aplica igual en Docker Desktop macOS/Windows). El binario C++ y el backend Python deben usar la misma configuración SHM (`varmon.conf` coherente).

**Seguridad:** Montar `/tmp` del host en el contenedor expone esos ficheros al contenedor; úsalo solo en entornos de desarrollo o confiados.

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `VARMON_CONFIG` | Ruta al `varmon.conf` (en compose ya va a `/app/varmon.conf`). |

## Limitaciones

- **Sidecar / grabación nativa**: el ejecutable `varmon_sidecar` no está en la imagen por defecto; la grabación suele requerir el stack nativo o una imagen extendida que incluya el binario y dependencias.
- **Paquete opcional Pro (`varmonitor_plugins`)**: la imagen mínima (`requirements-docker.txt`) no instala el wheel editable; rutas Pro (registros ARINC/MIL-1553, Parquet en servidor, Git UI, terminal, GDB) solo están disponibles si añades `pip install` de `tool_plugins/python` en una imagen derivada (véase [Backend (Python)](backend.md)).
- **Puerto distinto de 8080**: si el backend elige otro puerto, el `HEALTHCHECK` del `Dockerfile` puede fallar; ajusta o desactiva la capa `HEALTHCHECK` en una imagen derivada.

## Imagen

`web_monitor/Dockerfile` instala solo **`requirements-docker.txt`** (FastAPI, uvicorn, websockets; no MkDocs ni PySide6 / `requirements-desktop.txt`). El navegador se abre en el **host** apuntando a la URL del servicio; **no hace falta** instalar Chromium/Firefox dentro del contenedor.

## Integración en el Dockerfile de otro proyecto

Si este repositorio va como subcarpeta (submódulo o copia) dentro de un proyecto grande, para **solo** levantar el monitor web en la misma imagen:

1. **Dependencias pip (recomendado si usas submódulo Git):** no dependas de un `COPY` de ficheros dentro de `web_monitor/`: si alguien clona sin `--recurse-submodules`, esa ruta no existirá y fallará el build. Instala el runtime mínimo **en el Dockerfile del proyecto padre** con las mismas restricciones de versión (sin MkDocs, sin escritorio):

   ```dockerfile
   RUN pip install --no-cache-dir \
       "fastapi>=0.104.0" \
       "uvicorn[standard]>=0.24.0" \
       "websockets>=12.0"
   ```

   Tras actualizar el submódulo del monitor, conviene revisar que estas líneas sigan alineadas con `web_monitor/requirements-docker.txt` en este repositorio (ahí está la referencia de versiones).

   **Alternativa** (solo si el árbol `web_monitor/` está siempre presente en el contexto de build, p. ej. tras `git submodule update --init`):

   ```dockerfile
   COPY web_monitor/requirements-docker.txt /tmp/requirements-varmon.txt
   RUN pip install --no-cache-dir -r /tmp/requirements-varmon.txt
   ```

2. **No instales** `requirements-desktop.txt` en la imagen salvo que tengas un entorno gráfico real (DISPLAY, etc.); la ventana embebida no es el camino habitual en Docker.

3. **Paquetes apt extra:** con `python:*-slim` suele bastar lo que ya trae `pip` para las wheels de FastAPI/uvicorn/websockets. Solo añade `build-essential` o `gcc` si alguna dependencia futura no tiene wheel y compila desde fuente.

4. **Arranque:** `WORKDIR` donde esté `app.py` y `CMD`/`ENTRYPOINT` equivalente a `python app.py` (o `uvicorn` si lo externalizas). **Expone** el puerto (`EXPOSE` / `-p`) y abre `http://localhost:<puerto>` desde el navegador del **host** (o la IP del host en red).

5. **Live con C++ en el host (Linux):** el mismo patrón que [Modo host](#modo-host-linux-live-con-el-c-del-mismo-equipo): `network_mode: host`, `ipc: host`, montaje de `/tmp` y `varmon.conf` alineado con el binario nativo.
