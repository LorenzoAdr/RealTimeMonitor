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
| `GET /api/recordings` | `api_recordings()` | Lista de grabaciones (TSV y/o **Parquet** si el plugin está instalado). |
| `GET /api/recordings/{filename}` | `api_recording_download()` | Descarga TSV o Parquet según extensión. |
| `GET /api/recordings/{filename}/history` | `api_recording_var_history()` | Histórico de una variable (TSV o Parquet vía pyarrow). |
| `GET /api/recordings/{filename}/window` | `api_recording_var_window()` | Ventana de tiempo para una variable. |
| `GET /api/recordings/{filename}/window_batch` | `api_recording_var_window_batch()` | Varias variables en una ventana (batch). |
| `GET /api/recordings/{filename}/bounds` | `api_recording_time_bounds()` | Límites de tiempo del fichero. |
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
| `GET /api/advanced_stats` | `api_advanced_stats()` | RAM/CPU (HTML, Python, C++). Query `perf=1` renueva el lease de medición de fases (misma sesión que el panel Perf). |
| `GET /api/perf` | `api_perf()` | JSON: `ts`, `lease_active`, `layers.python\|cpp\|sidecar` con listas `phases[{id,last_us,ema_us,samples}]`. Python = `perf_agg`; C++ = `shm_perf_us` del publicador; sidecar = lectura del JSON de `--perf-file` durante REC `sidecar_cpp`. **Renueva el lease** de medición; sin panel ni `advanced_stats?perf=1`, C++ deja de medir ~1 s. |
| `WebSocket /ws` | `websocket_endpoint()` | Conexión en vivo (vars_update, alarmas, grabación). |

### Paquete opcional `varmonitor_plugins` (Pro)

Las rutas y la lógica de **registros ARINC / MIL-STD-1553** (SQLite), **Git UI**, **terminal restringida**, **GDB**, **vista previa Parquet por subida** (`POST /api/recordings/parquet_preview_upload`) y la implementación Python de lectura/escritura Parquet asociada al plugin viven en el paquete instalable bajo [`tool_plugins/python/`](../tool_plugins/python/) (p. ej. `pip install -e tool_plugins/python`, opcional `[parquet]` para pyarrow). El núcleo MIT las registra en el arranque vía `plugin_registry` si el paquete está instalado; sin él, el backend sigue sirviendo monitorización, TSV y rutas core anteriores.

## Configuración

- **load_config()**: Lee `varmon.conf` (o ruta en `VARMON_CONFIG`). Devuelve un dict con `web_port`, `auth_password`, `cycle_interval_ms`, **`shm_max_vars`**, etc. Se invoca al arrancar y el resultado se guarda en `_config`. El valor `shm_max_vars` (defecto 2048) se pasa al **ShmReader** para que lea del segmento SHM hasta ese número de entradas; si no se incluye en la config, el backend usaría 2048 y truncaría snapshots con más variables (las que quedan después de la 2048 mostrarían "--" en el frontend).

## Descubrimiento de instancias UDS

- **_list_uds_instances(user_filter)**: Lista sockets en `/tmp/varmon-*.sock` (o `varmon-<user>-*.sock` si se pasa `user_filter`). Para cada path abre un `UdsBridge(path, timeout=0.6)`, llama a `get_server_info()` y cierra. Solo devuelve instancias que responden. Orden: por **mtime** del socket (más reciente primero). Devuelve lista de dicts con `uds_path`, `pid`, `uptime_seconds`, `user`.

## WebSocket: flujo en websocket_endpoint()

1. **Aceptar y autenticar**: `ws.accept()`. Si `auth_password` está configurado, se exige `?password=...` en la URL; si falla, se envía `error` con `message: "auth_required"` y se cierra.
2. **Elegir instancia UDS**: Si no viene `uds_path` en la query, se llama a `_list_uds_instances(None)` y se toma la primera. Si no hay instancias, se envía `error` y se cierra.
3. **Conectar UDS y server_info**: Se crea `UdsBridge(query_uds, 5.0)` y se llama a `bridge.get_server_info()`. Con la respuesta se obtienen `shm_name` y `sem_name`.
4. **ShmReader**: Si hay `shm_name` y `sem_name`, se crea una `Queue` y un `ShmReader(...)` con `max_vars` desde config y `sample_interval_ms` desde `server_info` del C++. Se llama a `shm_reader.start()`. Con semáforo operativo, cada `post` del publicador SHM despierta al lector y se parsea un snapshot (ritmo del monitor). Si el semáforo no abre (ej. WSL), modo polling: espaciado de lecturas alineado a `sample_interval_ms` (no un fijo de 5 ms). Opcionalmente `shm_parse_max_hz` > 0 limita parseos/s en monitorización (por defecto 0 = sin límite). Con **`recording_backend = sidecar_cpp`** y el sidecar activo, **`shm_parse_hz_sidecar_recording`** (por defecto **30** en `DEFAULTS`) limita parseos/s del mmap para **`vars_update`**: el TSV lo escribe el sidecar en **`sem_sidecar_name`**; Python usa **`sem_name`** como siempre. Con valor **0**, el lector solo **drena** el sem principal por intervalos (`shm_sidecar_sem_drain_interval_sec`) sin parsear: las variables C++ en pantalla **no** se actualizan desde SHM (telemetría y progreso de grabación siguen).
5. **Bucle principal**: Se crea una tarea `_shm_drain_loop()` que drena la cola SHM (FIFO; tamaño configurable `shm_queue_max_size`, 0 = ilimitada; si está llena el hilo lector bloquea en `put`). Por cada snapshot: se actualiza `latest_snapshot`, se evalúan alarmas (`_evaluate_alarms`), se rellena `alarm_buffer` (ventana corta ~1 s + 1 s, snapshots completos) y, si hay grabación activa en modo **Python**, se encola el snapshot para el hilo de escritura TSV. En modo **sidecar_cpp** la escritura la hace un proceso aparte (véase abajo). A **tasa visual** (cada `update_ratio` ciclos) se envía `vars_update` al navegador con el snapshot actual.

### Telemetría `shm_cycle_ms` vs troceo SHM

La variable de telemetría **`varmon.telemetry.shm_cycle_ms`** (y el valor que muestra la UI) es una **EMA del tiempo entre snapshots consecutivos** que llegan al backend (delta de reloj entre un `sem_post` y el siguiente vistos por el lector). Refleja la **cadencia** del lazo RT del C++ (`write_shm_snapshot` + `sem_post`), no el tiempo de CPU gastado dentro del publicador. El **troceo** (`shm_publish_slice_partial` en `server_info` cuando `shm_publish_slice_n > 1` y `shm_publish_slice_force_full` es false) reduce getters/escrituras por ciclo en C++, pero **no** cambia cuántas veces por segundo se señaliza el semáforo; por tanto **no debe esperarse que `shm_cycle_ms` baje** solo por el troceo.

**Lector Python (`ShmReader`):** aun con troceo, cada `sem_post` antes implicaba decodificar **todas** las filas del snapshot (`count` × ~176 B), lo que con miles de variables domina la CPU del backend y provoca retrasos/“timeouts” percibidos. A partir del layout v2 con **`row_pub_seq`** (bytes 130–133 por fila), si C++ no ha reescrito la fila en ese ciclo el sello no cambia y **`read_snapshot` reutiliza la entrada en caché** (solo lee el `uint32` por fila y salta el parseo completo). Así el troceo + parseo incremental atacan **C++ y Python** a la vez. Con binarios C++ antiguos (sello siempre 0) el lector sigue haciendo lectura completa. Variables en **modo anillo** no tocadas en el troceo de ese ciclo pueden mostrar el último `mirror` hasta que la fase les toque de nuevo (coherente con monitorización a Rel act alto).
6. **Mensajes del cliente**: En paralelo se reciben mensajes JSON del frontend: `monitored`, `set_alarms`, `start_recording`, `stop_recording`, `update_ratio`, `send_file_on_finish`, etc. Según el tipo se actualizan `monitored_names`, `alarms_config`, `recording`, etc.
7. **Alarmas**: Tras `set_shm_subscription`, el C++ publica en SHM la **unión** de variables monitorizadas y variables que tienen alarma (`_shm_subscription_real_names`). Con `alarms_backend = sidecar_cpp` (por defecto) y reglas **solo** sobre variables SHM (no telemetría sintética), se lanza **`varmon_sidecar --alarm-monitor`**: espera **`sem_sidecar_name`** (`sem_timedwait` + drenaje; si `sem_open` falla, polling por `seq`), igual que la grabación sidecar, sin competir con el `ShmReader` que usa solo **`sem_name`**. Mantiene la ventana ~2,2 s, evalúa umbrales en C++ y escribe el TSV `alarm_*.tsv` tras 1 s más de contexto. Con `alarms_backend = python` o si hay alarmas de telemetría, se usa el camino en Python (`_evaluate_alarms`, `alarm_buffer`, `_write_snapshots_tsv`). El fallback por UDS (`get_var` cada ~0,2 s) solo se usa si el lector SHM está en pausa. Durante **grabación** el sidecar de alarmas se detiene y se reanuda al parar.
8. **Grabación**: Por defecto (`recording_backend = python`), al `start_recording` se arranca `_recording_writer_thread` que escribe filas TSV desde la cola. Con `recording_backend = sidecar_cpp` y SHM activo, el backend lanza **`varmon_sidecar`** con el mismo `shm_name` que `ShmReader` y **`sem_sidecar_name`** de `server_info` (sem dedicado: un `sem_post` por snapshot solo para el sidecar; el Python sigue con `sem_name`). Monitores antiguos sin `sem_sidecar_name`: fallback a `sem_name`. Lee el segmento en C++, escribe el TSV temporal y un `.stat` con el número de filas para `recording_progress`. Al `stop_recording` se envía SIGTERM al sidecar, se renombra el TSV y se envía `record_finished`. Si hay **alarmas configuradas** sobre variables C++ (no telemetría sintética), el backend escribe un TSV de reglas (`*.alarms.tsv`) y el sidecar evalúa umbrales en cada snapshot (misma lógica que `_evaluate_alarms`); al **primer disparo confirmado** cierra el TSV, escribe `*.alarm_exit` (JSON) y termina: el bucle WebSocket detecta `poll()` y envía `alarm_triggered` + `record_finished` sin SIGTERM. Las alarmas solo de telemetría siguen evaluándose en Python durante esa grabación. El ejecutable se busca en `VARMON_SIDECAR_BIN`, `recording_sidecar_bin` en `varmon.conf`, `PATH` o rutas típicas `build-sidecar/varmon_sidecar/varmon_sidecar` / `build/...` relativas a `web_monitor/`. En Linux, **`sidecar_cpu_affinity`** (p. ej. `3` o `2,5` o `4-7`) aplica `sched_setaffinity` al proceso sidecar de grabación y al de alarmas, para aislarlo del backend Python en otro núcleo.

## Ejecutable `varmon_sidecar` (grabación nativa)

- **CMake**: objetivo `varmon_sidecar` en [varmon_sidecar/CMakeLists.txt](../varmon_sidecar/CMakeLists.txt); compilación: `cmake -S . -B build && cmake --build build --target varmon_sidecar`.
- **Layout SHM**: [web_monitor/shm_reader.py](../web_monitor/shm_reader.py) — v2: cabecera 64 B, filas 176 B, arena de anillos; sigue leyendo v1 (137 B) si `version` = 1.
- **Argumentos**: **Grabación:** `--shm-name`, `--sem-name` (sem **sidecar** de `server_info`), `--output` (`.part`), `--names-file`, `--max-vars`, opcional `--status-file`, opcional `--alarms-file` / `--alarm-exit-file`, opcional `--shm-health-file` (NDJSON: saltos de `seq`, overflow anillo v2), opcional **`--perf-file`** (JSON sobrescrito por ciclo para el panel **Perf** → capa sidecar en `/api/perf`). **Alarmas en vivo:** `--alarm-monitor` (mismo `--sem-name`; fallback polling si no hay sem).
- **Replay SHM v2 (anillo)**: Si **todas** las columnas del `names-file` están en modo anillo y hay muestras pendientes sin overflow, el sidecar emite **varias filas TSV** y avanza `read_idx`. La implementación formatea líneas **directamente** desde las ranuras cuando no hace falta mapa intermedio por muestra; con alarmas en sidecar se rellena un mapa mínimo por fila solo para evaluar reglas.
- **Caché de layout en grabación**: Tras validar cabecera y nombres, se evita escanear las N filas SHM en cada ciclo si solo grabas k columnas; lectura snapshot O(k). Ver [Rendimiento](performance.md).
- **Entorno**: `VARMON_SIDECAR_PERF_FLUSH_EVERY` (1–512) modula la frecuencia de escritura del JSON de `--perf-file` (menos I/O en caliente).
- **Columna `time_s`**: Timestamp C++ en SHM menos el de la primera fila (cabecera +24 en snapshot; por ranura en replay anillo v2).
- **libvarmonitor** no participa en la grabación; el sidecar solo **consume** SHM en el mismo host que el monitor web.

## Módulos auxiliares

- **uds_client.py**: Clase `UdsBridge`. Conexión al socket Unix, envío de comandos (longitud 4 bytes big-endian + JSON), recepción de respuestas. Métodos: `get_server_info()`, `list_names`, `list_vars`, `get_var(name)`, `set_var(...)`, etc.
- **shm_reader.py**: Clase `ShmReader`. Abre el segmento `/dev/shm/<shm_name>` con `mmap` y el semáforo con ctypes. Hilo que hace `sem_timedwait` (o polling si el semáforo falla), lee header + entradas del segmento, construye listas `{name, type, value}` y las pone en la cola. El WebSocket consume esa cola en `_shm_drain_loop`.

## Funciones clave para alarmas y grabación

- **_evaluate_alarms(...)**: Evalúa umbrales lo/hi por variable; devuelve estados actualizados y listas `triggered` y `cleared`.
- **_write_snapshots_tsv(filepath, snapshots, var_names)**: Escribe un TSV con los snapshots (para alarmas o grabaciones legacy).
- **_flush_record_buffer_to_tsv**, **_recording_writer_thread**, **_finalize_recording_temp_file**: Escritura de grabaciones en streaming a fichero temporal y renombrado final.
