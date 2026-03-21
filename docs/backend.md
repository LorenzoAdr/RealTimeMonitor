# Backend (Python)

El backend está en [web_monitor/app.py](../web_monitor/app.py): FastAPI, WebSocket, integración con UDS y SHM.

## Rutas principales

| Ruta | Función | Uso |
|------|---------|-----|
| `GET /` | `index()` | Sirve la página principal (HTML estático). |
| `GET /api/vars` | `api_list_vars()` | Lista de variables (vía UdsBridge). |
| `GET /api/var/{name}` | `api_get_var()` | Valor actual de una variable. |
| `POST /api/var/{name}` | `api_set_var()` | Escribir variable (query: value, var_type). |
| `GET /api/uds_instances` | `api_uds_instances()` | Lista de instancias UDS (opcional `?user=`). |
| `GET /api/recordings` | `api_recordings()` | Lista de grabaciones TSV. |
| `GET /api/recordings/{filename}` | `api_recording_download()` | Descarga de un TSV. |
| `GET /api/recordings/{filename}/history` | `api_recording_var_history()` | Histórico de una variable en un TSV (análisis offline). |
| `GET /api/recordings/{filename}/window` | `api_recording_var_window()` | Ventana de tiempo para una variable. |
| `GET /api/recordings/{filename}/window_batch` | `api_recording_var_window_batch()` | Varias variables en una ventana (batch). |
| `GET /api/recordings/{filename}/bounds` | `api_recording_time_bounds()` | Límites de tiempo de un TSV. |
| `GET /api/browse` | `api_browse()` | Navegador de archivos remoto (ruta relativa al proyecto). |
| `GET /api/browse/download` | `api_browse_download()` | Descarga de un archivo del proyecto. |
| `POST /api/browse/mkdir` | `api_browse_mkdir()` | Crear carpeta en el proyecto. |
| `GET /api/admin/storage` | `api_admin_storage()` | Rutas y estado para la administración avanzada. |
| `POST /api/admin/storage/delete` | `api_admin_storage_delete()` | Borrar grabación o plantilla. |
| `POST /api/admin/runtime_config` | `api_admin_runtime_config()` | Guardar web_port / web_port_scan_max. |
| `GET /api/auth_required` | `api_auth_required()` | Indica si el servidor exige contraseña. |
| `GET /api/uptime` | `api_uptime()` | Uptime del backend. |
| `GET /api/connection_info` | `api_connection_info()` | Info de conexión (puerto, etc.). |
| `GET /api/instance_info` | `api_instance_info()` | Info de la instancia C++ (pid, user, etc.). |
| `GET /api/advanced_stats` | `api_advanced_stats()` | RAM/CPU (HTML, Python, C++). |
| `WebSocket /ws` | `websocket_endpoint()` | Conexión en vivo (vars_update, alarmas, grabación). |

## Configuración

- **load_config()**: Lee `varmon.conf` (o ruta en `VARMON_CONFIG`). Devuelve un dict con `web_port`, `auth_password`, `cycle_interval_ms`, **`shm_max_vars`**, etc. Se invoca al arrancar y el resultado se guarda en `_config`. El valor `shm_max_vars` (defecto 2048) se pasa al **ShmReader** para que lea del segmento SHM hasta ese número de entradas; si no se incluye en la config, el backend usaría 2048 y truncaría snapshots con más variables (las que quedan después de la 2048 mostrarían "--" en el frontend).

## Descubrimiento de instancias UDS

- **_list_uds_instances(user_filter)**: Lista sockets en `/tmp/varmon-*.sock` (o `varmon-<user>-*.sock` si se pasa `user_filter`). Para cada path abre un `UdsBridge(path, timeout=0.6)`, llama a `get_server_info()` y cierra. Solo devuelve instancias que responden. Orden: por **mtime** del socket (más reciente primero). Devuelve lista de dicts con `uds_path`, `pid`, `uptime_seconds`, `user`.

## WebSocket: flujo en websocket_endpoint()

1. **Aceptar y autenticar**: `ws.accept()`. Si `auth_password` está configurado, se exige `?password=...` en la URL; si falla, se envía `error` con `message: "auth_required"` y se cierra.
2. **Elegir instancia UDS**: Si no viene `uds_path` en la query, se llama a `_list_uds_instances(None)` y se toma la primera. Si no hay instancias, se envía `error` y se cierra.
3. **Conectar UDS y server_info**: Se crea `UdsBridge(query_uds, 5.0)` y se llama a `bridge.get_server_info()`. Con la respuesta se obtienen `shm_name` y `sem_name`.
4. **ShmReader**: Si hay `shm_name` y `sem_name`, se crea una `Queue` y un `ShmReader(shm_name, sem_name, shm_queue, max_vars=_config["shm_max_vars"])`. Se llama a `shm_reader.start()`. El parámetro `max_vars` indica cuántas entradas leer por snapshot (debe coincidir con el C++ para no truncar). Si el semáforo no abre (ej. WSL), el ShmReader puede usar modo polling (lee SHM cada ~5 ms y detecta cambios por `seq`).
5. **Bucle principal**: Se crea una tarea `_shm_drain_loop()` que drena la cola SHM (FIFO; tamaño configurable `shm_queue_max_size`, 0 = ilimitada; si está llena el hilo lector bloquea en `put`). Por cada snapshot: se actualiza `latest_snapshot`, se evalúan alarmas (`_evaluate_alarms`), se rellena `alarm_buffer` (ventana corta ~1 s + 1 s, snapshots completos) y, si hay grabación activa en modo **Python**, se encola el snapshot para el hilo de escritura TSV. En modo **sidecar_cpp** la escritura la hace un proceso aparte (véase abajo). A **tasa visual** (cada `update_ratio` ciclos) se envía `vars_update` al navegador con el snapshot actual.
6. **Mensajes del cliente**: En paralelo se reciben mensajes JSON del frontend: `monitored`, `set_alarms`, `start_recording`, `stop_recording`, `update_ratio`, `send_file_on_finish`, etc. Según el tipo se actualizan `monitored_names`, `alarms_config`, `recording`, etc.
7. **Alarmas**: Tras `set_shm_subscription`, el C++ publica en SHM la **unión** de variables monitorizadas y variables que tienen alarma (`_shm_subscription_real_names`). Con `alarms_backend = sidecar_cpp` (por defecto) y reglas **solo** sobre variables SHM (no telemetría sintética), se lanza **`varmon_sidecar --alarm-monitor`**: lee SHM solo en **polling** (no compite por el semáforo con `ShmReader`), mantiene la ventana ~2,2 s, evalúa umbrales en C++ y escribe el TSV `alarm_*.tsv` tras 1 s más de contexto; los eventos llegan al WebSocket vía un fichero NDJSON (`cleared` / `triggered` / `ready`). Con `alarms_backend = python` o si hay alarmas de telemetría, se usa el camino en Python (`_evaluate_alarms`, `alarm_buffer`, `_write_snapshots_tsv`). El fallback por UDS (`get_var` cada ~0,2 s) solo se usa si el lector SHM está en pausa. Durante **grabación** el sidecar de alarmas se detiene y se reanuda al parar.
8. **Grabación**: Por defecto (`recording_backend = python`), al `start_recording` se arranca `_recording_writer_thread` que escribe filas TSV desde la cola. Con `recording_backend = sidecar_cpp` y SHM activo, el backend lanza el ejecutable **`varmon_sidecar`** (mismo `shm_name` / `sem_name` que `ShmReader`): lee el segmento en C++, escribe el TSV temporal y un fichero `.stat` con el número de filas para `recording_progress`. Al `stop_recording` se envía SIGTERM al sidecar, se renombra el TSV y se envía `record_finished`. Si hay **alarmas configuradas** sobre variables C++ (no telemetría sintética), el backend escribe un TSV de reglas (`*.alarms.tsv`) y el sidecar evalúa umbrales en cada snapshot (misma lógica que `_evaluate_alarms`); al **primer disparo confirmado** cierra el TSV, escribe `*.alarm_exit` (JSON) y termina: el bucle WebSocket detecta `poll()` y envía `alarm_triggered` + `record_finished` sin SIGTERM. Las alarmas solo de telemetría siguen evaluándose en Python durante esa grabación. El ejecutable se busca en `VARMON_SIDECAR_BIN`, `recording_sidecar_bin` en `varmon.conf`, `PATH` o rutas típicas `build-sidecar/varmon_sidecar/varmon_sidecar` / `build/...` relativas a `web_monitor/`.

## Ejecutable `varmon_sidecar` (grabación nativa)

- **CMake**: objetivo `varmon_sidecar` en [varmon_sidecar/CMakeLists.txt](../varmon_sidecar/CMakeLists.txt); compilación: `cmake -S . -B build && cmake --build build --target varmon_sidecar`.
- **Layout SHM**: Igual que [web_monitor/shm_reader.py](../web_monitor/shm_reader.py) (cabecera 32 bytes, entradas de 137 bytes por variable).
- **Argumentos**: **Grabación:** `--shm-name`, `--sem-name`, `--output` (fichero `.part`), `--names-file`, `--max-vars`, opcional `--status-file`, opcional `--alarms-file` (TSV de reglas) y `--alarm-exit-file`. **Solo alarmas en vivo:** `--alarm-monitor` con `--names-file`, `--alarms-file`, `--alarm-events-file` (NDJSON append), `--alarm-output-dir` (directorio de `alarm_*.tsv`); no usa el semáforo SHM (polling por `seq`).
- **libvarmonitor** no participa en la grabación; el sidecar solo **consume** SHM en el mismo host que el monitor web.

## Módulos auxiliares

- **uds_client.py**: Clase `UdsBridge`. Conexión al socket Unix, envío de comandos (longitud 4 bytes big-endian + JSON), recepción de respuestas. Métodos: `get_server_info()`, `list_names`, `list_vars`, `get_var(name)`, `set_var(...)`, etc.
- **shm_reader.py**: Clase `ShmReader`. Abre el segmento `/dev/shm/<shm_name>` con `mmap` y el semáforo con ctypes. Hilo que hace `sem_timedwait` (o polling si el semáforo falla), lee header + entradas del segmento, construye listas `{name, type, value}` y las pone en la cola. El WebSocket consume esa cola en `_shm_drain_loop`.

## Funciones clave para alarmas y grabación

- **_evaluate_alarms(...)**: Evalúa umbrales lo/hi por variable; devuelve estados actualizados y listas `triggered` y `cleared`.
- **_write_snapshots_tsv(filepath, snapshots, var_names)**: Escribe un TSV con los snapshots (para alarmas o grabaciones legacy).
- **_flush_record_buffer_to_tsv**, **_recording_writer_thread**, **_finalize_recording_temp_file**: Escritura de grabaciones en streaming a fichero temporal y renombrado final.
