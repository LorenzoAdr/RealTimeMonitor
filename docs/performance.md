# Performance

La herramienta está orientada a **máxima performance**: minimizar latencia y uso de CPU y red entre el proceso C++ que publica variables y el navegador que las visualiza.

## Comunicación de bajo coste: SHM y UDS

- **C++ ↔ Python**: no hay TCP. La comunicación es local mediante:
  - **Memoria compartida (SHM)**: el proceso C++ escribe snapshots en un segmento en `/dev/shm/` y señaliza con un semáforo POSIX. Python mapea el mismo segmento y lee sin copias adicionales ni serialización por red.
  - **Unix Domain Sockets (UDS)**: comandos (listar variables, leer/escribir una variable, suscribir SHM) van por un socket local. Menor overhead que TCP y sin pasar por la pila de red.

Con esto se evita sobrecarga de red y de CPU en el camino crítico de datos en vivo.

## Publicador C++ (`libvarmonitor` / `shm_publisher`)

Además de SHM+UDS, el binario que enlaza **libvarmonitor** aplica varias optimizaciones en **`write_snapshot`** (publicación por ciclo). Claves en `varmon.conf` (solo C++; reiniciar proceso tras cambios):

### Modo dirty (`shm_publish_dirty_mode`, por defecto 1)

- Las variables marcadas con **`mark_dirty(nombre)`** (p. ej. tras `set_var` por UDS o tras aplicar un **import** SHM one-shot) entran en un conjunto **dirty** en memoria.
- Entre **refrescos completos**, el publicador puede construir una máscara y **omitir getters** (`get_var` / lectura de punteros rápidos) para filas no dirty y no incluidas en el troceo del ciclo, reduciendo trabajo cuando muchas variables no cambian.
- **`shm_publish_full_refresh_cycles`** (por defecto **1**): cada cuántos ciclos de publicación se fuerza un refresco completo de todas las filas export. Con **1**, *cada* ciclo es refresco completo: comportamiento seguro y compatible con aplicaciones que **no** llaman a `mark_dirty` al mutar datos por detrás. Si subes este valor (p. ej. 5 o 10) **y** tu aplicación marca dirty solo donde corresponde, reduces lecturas de variables en ciclos intermedios.

### Skip unchanged (`shm_publish_skip_unchanged`, por defecto 1)

- Tras obtener el valor escalar de una fila, si **tipo y valor double** coinciden con la última publicación en esa fila, se **omite la escritura** en el mmap (menos ancho de banda de memoria y menos invalidación de caché).
- La fila puede conservar el **`row_pub_seq`** anterior: el lector Python puede **reutilizar** la entrada ya decodificada si compara secuencias (coherente con troceo parcial).

### Troceo de export (`shm_publish_slice_count` + UDS `set_shm_publish_slice`)

- Ya descrito en [Protocolos](protocols.md): en modo parcial, solo un subconjunto de índices de suscripción se actualiza por ciclo; la cabecera (`seq`, `timestamp`) sí se actualiza siempre. El backend alinea a menudo este **N** con **Rel act** en monitorización pasiva.

### Publicación SHM en hilo dedicado (`shm_async_publish`)

- Con **1**, `write_shm_snapshot()` desde el hilo RT solo **enciende** una señal (`condition_variable`); un **hilo dedicado** ejecuta `write_snapshot` real. Objetivo: **menor jitter** en el lazo que llama al monitor (p. ej. control a tiempo real).
- Con **0**, la publicación es **síncrona** en el llamador (comportamiento clásico).

### Afinidad de CPU

- **libvarmonitor** no fija afinidad del proceso C++ del usuario: eso queda a `taskset`/política del sistema.
- El backend Python puede fijar **`sidecar_cpu_affinity`** para los procesos **`varmon_sidecar`** (grabación y alarmas) mediante `sched_setaffinity` en Linux, aislando núcleos para E/S y formato TSV sin robar del núcleo del RT del usuario. Ver [Instalación y configuración](setup.md).

### Otras piezas

- **Caché de suscripción** en el publicador: copia de la lista de nombres solo cuando cambia la generación de suscripción, evitando miles de copias de `std::string` por ciclo.
- **Buffers reutilizados** (`write_snapshot`): vectores estáticos para máscaras, índices de export y batch de escalares, para reducir reservas en el camino caliente.

## Medidas para evitar sobrecarga de red y de máquina

Además del uso de SHM y UDS, se aplican varias medidas para no saturar ni la red ni el navegador ni el backend.

### Variables monitorizadas únicamente

- Solo las variables que el usuario ha elegido **monitorizar** se envían por WebSocket al navegador.
- El C++ solo escribe en SHM las variables suscritas (`set_shm_subscription`): si la suscripción tiene nombres, escribe solo esas (iterando por nombre con `get_var`, no por todas las variables registradas); si está **vacía**, no escribe ninguna entrada (solo actualiza la cabecera con `count = 0` y hace `sem_post`), evitando volcar todas las variables en cada ciclo cuando nadie está monitorizando. La lista de variables disponibles se obtiene entonces por UDS (`list_names` / `list_vars`) bajo demanda.
- Las variables no monitorizadas se ignoran en el envío al cliente; no se transmite todo el conjunto de variables en cada actualización.
- El número máximo de variables que caben en el segmento SHM es **shm_max_vars** (configurable en `varmon.conf`; C++ y Python deben usar el mismo valor). Si monitorizas más que ese límite, solo las primeras reciben valor; el resto muestran "--". Véase [Resolución de problemas — Algunas variables muestran "--"](troubleshooting.md#algunas-variables-muestran-al-monitorizar-muchas).

Ver [Protocolos — Sistema de actualización de variables monitorizadas](protocols.md#sistema-de-actualización-de-variables-monitorizadas).

### Rel act (periodo de actualización al navegador)

- El backend no envía un mensaje `vars_update` en cada ciclo de SHM.
- Se respeta un intervalo mínimo entre envíos al WebSocket (configurable en la UI como **Rel act**). Así se limita la tasa de mensajes y de re-renderizado en el navegador sin perder utilidad para el usuario.

### Listas virtualizables en el navegador de variables

- El panel para **añadir variables** (browser) puede mostrar cientos o miles de nombres.
- La lista es **virtualizable**: solo se renderizan las filas visibles (y un pequeño overscan). Con muchas variables se evita crear miles de nodos DOM y se mantiene la UI fluida.

### Downsample en gráficas

- En las gráficas de series temporales no se dibujan todos los puntos del historial.
- Se aplica **downsample** (p. ej. límite configurable de puntos máximos por serie) para reducir el trabajo de renderizado del canvas y mantener tiempos de dibujo acotados incluso con buffers largos.

### Carga adaptativa (adaptive load)

- Si la pestaña del navegador no está visible (`document.hidden`), el frontend puede **omitir** o espaciar actualizaciones de gráficas y tablas.
- Así se reduce el uso de CPU y GPU cuando el usuario no está mirando el monitor.

### Gestión de grandes archivos (análisis offline)

- Al cargar grabaciones TSV muy grandes para análisis offline, se evita leer todo el fichero en memoria de una vez:
  - **Vista previa**: se lee solo una porción inicial para estimar tamaño y número de filas.
  - **Estimación de riesgo**: según tamaño y número de columnas/filas se decide si conviene usar **modo seguro**.
  - **Modo seguro**: en lugar de cargar el archivo completo, se trabaja por **segmentos** (rangos de bytes). El usuario puede navegar por el archivo (avanzar/retroceder) y solo se cargan los segmentos necesarios, manteniendo un tamaño de datos acotado en memoria.

### Buffer visual e historial

- El historial en el frontend (`historyCache`) usa la misma ventana que el selector **Buffer visual** de la cabecera (y el valor avanzado “Buffer visual por defecto”): recorte por tiempo, presupuesto de muestras proporcional a esos segundos, y eje X de los gráficos en vivo. El servidor puede fijar un valor inicial con `visual_buffer_sec` en `varmon.conf` (véase `docs/setup.md`) cuando el usuario no tiene preferencia guardada.

---

En conjunto, estas medidas permiten usar VarMonitor con muchas variables y alta frecuencia de actualización sin sobrecargar la red ni la máquina.

## Panel «Perf» y API `/api/perf`

![Panel Perf en la interfaz](images/perf.png){ width="100%" }

- **UI**: En la cabecera, el botón **Perf** abre un panel que hace *polling* de `GET /api/perf` mientras está visible. Muestra tres capas en tablas y barras apiladas:
  - **Python** (`perf_agg`): fases del backend (p. ej. manejo de snapshots SHM, empaquetado/envío de `vars_update`).
  - **C++** (`server_info.shm_perf_us`): tiempos de CPU dentro de `write_shm_snapshot` cuando la medición está activa en el publicador.
  - **Sidecar**: fases del proceso `varmon_sidecar` durante la grabación **`sidecar_cpp`**, leídas del fichero JSON escrito con **`--perf-file`** (p. ej. `*.part.sidecar_perf.json`).
- **Lease**: Abrir el panel o la tira de estadísticas avanzadas con `?perf=1` en `GET /api/advanced_stats` **renueva un lease** en el servidor; sin lease, el C++ deja de rellenar `shm_perf_us` tras ~1 s para no medir en vacío.
- **Respuesta JSON** (resumen): `ts`, `lease_active`, `layers.python|cpp|sidecar`, cada una con `phases: [{ id, last_us, ema_us, samples }, ...]`. Los tiempos del sidecar y de Python suelen estar en **microsegundos**; la UI los muestra en **milisegundos**.

## Grabación nativa (`varmon_sidecar`): optimizaciones de coste

Con miles de variables en SHM (`shm_max_vars` alto) y pocas columnas en el TSV, el coste dominante solía ser **recorrer toda la tabla** en cada `sem_post` y construir mapas por nombre. El sidecar aplica entre otras:

1. **Caché de layout (`RecordingLayoutCache`)**: Tras validar cabecera (`version`, `count`, `table_off`, `stride`, tamaño del mmap) y los nombres en las filas cacheadas, una sola pasada O(N) rellena `name_to_row_off` y los offsets por columna del `names-file`. Mientras el layout sea válido, la lectura de **snapshot** para grabar es **O(k)** en el número de columnas TSV (`read_recording_snapshot_columns`), no O(N).
2. **Replay de anillo v2 sin mapa por muestra**: Si todas las columnas son modo anillo y los índices encajan, se emiten líneas TSV **directamente** desde las ranuras (`v2_ring_replay_extract_lines`); solo si hay **reglas de alarma** en el sidecar se reconstruye un mapa nombre→valor por fila para evaluarlas.
3. **Reutilización del mapa nombre→offset**: Con caché válida, la resolución de columnas para el anillo evita re-escanear las N filas (la fase de perf `sidecar.ring_col_resolve_scan` pasa a ser esencialmente O(k)).
4. **Formateo TSV**: Celdas escalares con `std::to_chars` donde el estándar lo permite; menos `ostringstream` y menos strings temporales por celda.
5. **Fichero de perf del sidecar**: `VARMON_SIDECAR_PERF_FLUSH_EVERY` (1–512, por defecto interno 4) reduce la frecuencia de `fopen`/`fwrite` del JSON de diagnóstico cuando se usa `--perf-file`.

Los identificadores de fase (`sidecar.*`) están definidos en el fuente de `varmon_sidecar` (`kSidecarPerfIds`); incluyen por ejemplo `sem_wait`, `parse_snapshot` / cuerpo parse, `ring_extract`, `ring_replay_build_rows`, `snap_format`, `cycle_wall_wake_to_fwrite_done`, etc. La suma documentada en el JSON (`sum_to_fwrite_us`, …) encaja con el desglose del ciclo de grabación.

## Python durante REC `sidecar_cpp`

- **`shm_parse_hz_sidecar_recording`** (por defecto **30** Hz en `app.py`): tope de parseos SHM en el hilo lector para mantener **`latest_snapshot`** y los valores en pantalla; el TSV lo escribe el sidecar en el sem dedicado (`sem_sidecar_name`).
- **`0`**: el lector solo **drena** el sem principal (`sem_name`) por intervalos (`shm_sidecar_sem_drain_interval_sec`) sin parsear mmap: la UI deja de actualizar variables C++ desde SHM (telemetría y progreso de grabación siguen).
