# Protocolos

## Protocolo UDS: formato de mensajes

Todos los mensajes entre Python y C++ por UDS siguen el mismo esquema:

1. **Longitud (4 bytes, big-endian, unsigned)**  
   Longitud en bytes del JSON que sigue (sin incluir estos 4 bytes).

2. **Cuerpo (JSON)**  
   Objeto JSON en UTF-8.

**Límite**: 10 MiB por mensaje (en C++ y en `uds_client.py`).

### Esquema de un paquete UDS

Cada mensaje es un único paquete con cabecera de longitud y cuerpo:

```mermaid
block-beta
  columns 2
  block:Paquete UDS
    block:Cabecera 4 bytes
      A["Longitud (big-endian uint32)\nbytes del JSON"]
    end
    block:Cuerpo N bytes
      B["JSON UTF-8\n{ \"cmd\": \"...\", ... }"]
    end
  end
end
```

En memoria, el paquete se ve así:

| Offset | Tamaño | Contenido |
|--------|--------|-----------|
| 0      | 4      | Longitud del JSON (network byte order, big-endian `!I`) |
| 4      | N      | Bytes del JSON (UTF-8); N = valor de los 4 primeros bytes |

### Envío desde Python (UdsBridge)

- Se construye un `dict` y se serializa con `json.dumps(..., separators=(",", ":"))`.
- Se envía `struct.pack("!I", len(raw)) + raw`.

### Recepción en C++ (uds_server)

- `recv_message()`: lee 4 bytes, hace `ntohl` → `len`, luego lee `len` bytes (JSON).
- Se parsea el JSON a mano para extraer `cmd` y parámetros.

### Comandos enviados por Python (request)

| Comando               | Parámetros (en el JSON)        | Uso |
|-----------------------|--------------------------------|-----|
| `server_info`         | (ninguno)                      | Info del servidor, uptime, shm_name, sem_name, sem_sidecar_name, uds_path, RAM/CPU |
| `list_names`          | (ninguno)                      | Lista de nombres de variables |
| `list_vars`           | (ninguno)                      | Lista de variables con tipo y valor actual |
| `get_var`             | `"name": "<nombre>"`           | Valor actual de una variable |
| `set_var`             | `"name", "value", "type"`      | Escribir variable (double, int32, bool, etc.) |
| `set_array_element`   | `"name", "index", "value"`     | Escribir un elemento de un array |
| `unregister_var`      | `"name"`                       | Desregistrar variable en caliente |
| `set_shm_subscription`| `"names": ["a","b",...]`       | Suscripción SHM: solo escribir esas variables en SHM; vacío = no escribir entradas (solo cabecera) |
| `set_shm_publish_slice` | `"count": N`, `"force_full": bool` | Troceo de **export** SHM: con `force_full: false` y `N>1`, cada ciclo C++ solo actualiza filas cuyo índice en la suscripción cumple `i % N == fase` (rotación por ciclo). `force_full: true` o `N=1` = todas las filas export cada ciclo. Las filas **IMPORT** (modo 1) se procesan siempre todas. `count` se acota a `update_ratio_max` en `varmon.conf`. |

El histórico se construye desde SHM (en vivo) y desde grabaciones TSV en disco; no hay comandos `get_history` / `get_histories` en el protocolo actual.

### Respuestas del C++ (response)

El C++ devuelve siempre un JSON con al menos `"type"`:

- `server_info`: `type`, `uptime_seconds`, `shm_name`, `sem_name`, **`sem_sidecar_name`** (segundo sem POSIX: el C++ hace un `sem_post` en cada uno por snapshot; el lector Python usa solo `sem_name`; **varmon_sidecar** debe usar `sem_sidecar_name` para no competir con Python), `uds_path`, opcionalmente `memory_rss_kb`, `cpu_percent`; si hay SHM activo, `shm_layout_version`: **2** (layout v2), y además `shm_publish_slice_n` (entero ≥ 1), `shm_publish_slice_force_full` (bool), `shm_publish_slice_partial` (true solo si `n > 1` y no `force_full`: el C++ publica ~1/n filas export por ciclo). **Nota:** el periodo entre pares de `sem_post` sigue siendo el del lazo RT; el troceo reduce trabajo *dentro* de cada ciclo, no la cadencia de snapshots.
- `list_names`: `type: "names"`, `data: ["nombre1", ...]`.
- `list_vars`: `type: "vars"`, `data: [{ "name", "type", "value", "timestamp" }, ...]`.
- `get_var`: `type: "var"`, `data: <objeto var o null>`.
- `set_var` / `set_array_element`: `type: "set_result", "ok": true|false`.
- `unregister_var`: `type: "unregister_result", "ok": true|false`.
- `set_shm_subscription`: `type: "shm_subscription_result", "ok": true`.
- `set_shm_publish_slice`: `type: "shm_publish_slice_result", "ok": true`.
- Error: `type: "error", "message": "..."`.

---

## Memoria compartida (SHM): nombres, layout y limpieza

### Nombres

- **Segmento SHM** (en `/dev/shm/`): nombre `varmon-<user>-<pid>` (ruta completa `/dev/shm/varmon-<user>-<pid>`).
- **Semáforo POSIX (lector principal)**: nombre `/varmon-<user>-<pid>` (con barra inicial). Lo espera el hilo **`ShmReader`** de Python para cada snapshot publicado.
- **Segundo semáforo POSIX (sidecar)**: nombre **`/varmon-<user>-<pid>-sc`**. Mismo `<user>` y `<pid>`. Lo espera **`varmon_sidecar`** (grabación nativa y, si aplica, monitor de alarmas en C++).

Cada proceso C++ tiene **un segmento SHM y dos semáforos**; el par user/pid identifica UDS y SHM. Ver [segundo semáforo y consumidores](#segundo-semáforo-y-consumidores-independientes).

### Creación y destrucción en C++

- **init()** (tras `cleanup_stale_shm_for_user()`): `shm_open`, `ftruncate`, `mmap`, `sem_open` del sem principal **y** `sem_open` del sem **`-sc`**. Si falla, se desvinculan recursos.
- **shutdown()**: `sem_close`/`sem_unlink` de **ambos** semáforos, `munmap`/`close`, `shm_unlink`.

### Limpieza de segmentos zombie

- **cleanup_stale_shm_for_user()** (en `shm_publisher.cpp`): lista entradas en `/dev/shm` con prefijo `varmon-<user>-`, extrae PID, comprueba con `kill(pid, 0)`; si el proceso no existe, `shm_unlink` y `sem_unlink`. Se llama al inicio de `init()`.

### Layout del segmento (C++ y Python)

**Versión 2 (actual):** `magic` igual; `version` = **2**. Los primeros **32 bytes** coinciden con la cabecera v1 (seq, count, timestamp en los mismos offsets). Cabecera extendida **64 bytes**; tabla de **N = min(|suscripción|, shm_max_vars)** filas de **176 bytes**; a continuación, **arena de anillos**: `shm_max_vars × shm_ring_depth × 16` bytes (doble `double` por muestra: tiempo + valor).

- **Cabecera v2 (64 B)**: 0–31 como arriba; 32–35 `table_offset` (típ. 64); 36–39 `table_stride` (176); 40–43 capacidad de filas (`shm_max_vars`); 44–47 offset del arena de anillos; 48–49 tamaño de slot (16); 50–51 `shm_ring_depth`. **52–59**: `double` LE **`publish_period_sec`**: tiempo en segundos entre esta publicación y la anterior (mismo reloj que el `timestamp` en +24); lo escribe el C++ en cada `write_snapshot`; el backend puede mostrar el ciclo SHM sin calcular Δt al ritmo del consumidor Python.

- **Fila de tabla (176 B)**: `name[128]`; offset 128 **modo** (0 = export snapshot, 1 = import snapshot one-shot, 2 = export anillo); 129 tipo (0/1/2 escalares); **130–133** `uint32` LE **`row_pub_seq`**: copia del `seq` global de la cabecera en el último ciclo en que C++ escribió esa fila (troceo / `skip_unchanged` dejan el valor anterior → el lector Python puede reutilizar la entrada decodificada); 136 valor `double`; 144 `ring_rel_off`; 148 `ring_capacity`; 152 `write_idx`; 160 `read_idx` (reservado consumidor); 168 `mirror_value` (último valor para UI/alarmas en modo anillo).

El **orden de filas** es el de `set_shm_subscription` (lista ordenada sin duplicados). Con suscripción vacía, `count = 0` y solo cabecera + `sem_post`.

**Import one-shot (modo 1):** un productor (p. ej. el backend con `mmap` RW) rellena nombre/tipo/valor y modo 1; en el siguiente `write_shm_snapshot`, C++ aplica `set_var`, restaura el modo por defecto (`shm_default_export_mode` en `varmon.conf`: 0 snapshot o 2 anillo) y **no** reexporta esa fila en el mismo ciclo más allá del reset.

**Compatibilidad v1:** segmentos antiguos con `version` = 1: cabecera 32 B y entradas de 137 B; Python y `varmon_sidecar` siguen leyendo esa disposición.

**Tamaño (v2):** `64 + shm_max_vars × 176 + shm_max_vars × shm_ring_depth × 16` bytes. `shm_ring_depth` y `shm_default_export_mode` las lee solo el proceso C++ desde `varmon.conf`.

### Arena de anillos (ring buffer): qué es y para qué sirve

Tras la **tabla de filas** (una fila por variable suscrita, hasta `shm_max_vars`), el segmento incluye una **arena contigua** reservada para los **anillos por variable**.

- **Partición lógica**: para cada índice de fila en modo **export anillo** (`mode = 2`), la fila guarda `ring_rel_off` y `ring_capacity` (= `shm_ring_depth`). Ese offset apunta dentro del arena a un bloque de **`ring_depth × 16` bytes** (16 = dos `double` en little-endian: instante de muestra + valor escalar).
- **Productor (C++)**: en cada publicación, si la variable está en modo anillo, además del valor en la fila se hace **push** en la ranura `(write_idx % depth)` y se incrementa `write_idx`. El campo **`mirror_value`** mantiene el **último** valor escrito: sirve para UI, alarmas y lectores que solo necesitan el escalar actual sin recorrer el anillo.
- **Objetivo**:
  1. **Historial corto embebido** sin asignaciones dinámicas ni otro segmento: todo el layout es predecible y se mapea una sola vez.
  2. **Grabación y análisis**: el sidecar puede **reproducir** líneas TSV a partir de las ranuras nuevas desde la última lectura (replay de anillo), en lugar de depender solo del valor instantáneo.
  3. **Coherencia con snapshot**: las filas en modo **snapshot** siguen siendo un único valor por ciclo; el anillo es opcional por variable según `shm_default_export_mode` y transiciones automáticas desde snapshot cuando el defecto es anillo.

Si `shm_ring_depth` es 0 o la fila no está en modo anillo, esa variable no usa ranuras en el arena para datos de serie (la capacidad en fila puede ser 0).

### Segundo semáforo y consumidores independientes

En cada snapshot válido, el C++ ejecuta **`post_shm_readers()`**: hace **`sem_post`** en el semáforo **principal** y otro **`sem_post`** en el semáforo **sidecar** (`…-sc`).

- Un único semáforo compartido entre **Python** y **sidecar** sería problemático: ambos harían `sem_wait`. El contador POSIX mezclaría señales; un consumidor podría **consumir** un `post` destinado al otro, o habría que drenar artificialmente posts “extra”, complicando la semántica **un snapshot → un despertar por consumidor**.
- Con **dos semáforos**, el productor incrementa **independientemente** el contador de cada lector. Tras un snapshot hay **un post para Python** y **un post para el sidecar**: cada uno hace `sem_wait` en **su** sem sin competir con el otro.
- **`ShmReader`** (monitor web) usa solo **`sem_name`**. **`varmon_sidecar`** debe usar **`sem_sidecar_name`** (lo devuelve `server_info`). Así la grabación nativa y el bucle de alarmas en C++ no roban ciclos de espera al backend Python.

La limpieza de segmentos zombie en `cleanup_stale_shm_for_user()` debe desvincular **ambos** nombres de semáforo asociados al prefijo del usuario cuando el PID ya no existe (comportamiento actual del publicador).

### Proceso sidecar (`varmon_sidecar`)

El **sidecar** es un binario C++ **aparte** del proceso que ejecuta `VarMonitor` y el lazo RT. Comparte con el monitor web **solo** el segmento SHM (solo lectura/escritura según caso) y el **semáforo `-sc`**, no el socket UDS del servidor de variables.

- **Grabación `sidecar_cpp`**: el backend Python lanza el sidecar con `shm_name`, lista de columnas (`names-file`) y **`sem_sidecar_name`**. El sidecar espera un `sem_post` por snapshot, lee el mmap con el mismo layout que `shm_reader.py`, formatea filas TSV y las escribe a disco. Python puede limitar cuántas veces por segundo **parsea** el mmap para la UI (`shm_parse_hz_sidecar_recording`), sin frenar la escritura del TSV en el sidecar.
- **Alarmas nativas**: con reglas definidas en TSV, puede ejecutarse en modo `--alarm-monitor`, evaluando umbrales en cada despertar del sem **sidecar** y emitiendo eventos/salidas configuradas.
- **Motivación**: sacar del proceso Python el trabajo intensivo de barrido de tablas SHM grandes y de formateo TSV, y evitar que el lector web compita por un único semáforo con ese consumidor. Más detalle en [Rendimiento](performance.md) (grabación nativa y fases del sidecar).

### Flujo de escritura (C++)

- Cada ciclo: `write_shm_snapshot(mon)` → seq, timestamp; filas según suscripción (import → aplicar y reset; snapshot/anillo → rellenar desde `get_var`); `sem_post`.
- **Snapshot parcial (troceo):** si `set_shm_publish_slice` dejó `force_full: false` y `count = N > 1`, en ese ciclo solo se ejecutan getters y mmap para el subconjunto de filas **export** con `índice_en_suscripción % N == fase` (la fase avanza cada ciclo). El resto de filas export conservan el último valor escrito. La cabecera (`seq`, `timestamp`) se actualiza siempre; el lector debe asumir que no todas las filas cambian en cada `sem_post`. Con grabación o alarmas el backend Python envía `force_full: true` para no retrasar variables críticas.

### Flujo de lectura (Python, ShmReader)

- Abre segmento con `os.open("/dev/shm/"+shm_name)` y `mmap.mmap(..., MAP_SHARED, PROT_READ)`.
- Abre el semáforo del monitor con `sem_open(sem_name, O_RDWR)` (ctypes). Grabación/alarmas nativas: `sem_open(sem_sidecar_name, …)` si existe en `server_info`.
- En un hilo: bucle `sem_timedwait(sem, timeout)`; al recibir señal, lee header + entradas, construye lista de dicts `{name, type, value}` y la pone en una `Queue`. El bucle del WebSocket consume la cola.

### Sistema de actualización de variables monitorizadas

Solo se actualizan y envían al navegador las **variables monitorizadas**; el resto no se escribe en SHM (cuando hay suscripción) y no se envía por WebSocket.

1. **En el frontend**: el usuario selecciona qué variables quiere ver (gráficas, tabla, alarmas). Esa lista se envía al backend con la acción `set_monitored` (`names`).

2. **Suscripción SHM (C++)**: el backend llama a `set_shm_subscription(list(...))` por UDS (orden conservado).
   - **Si la suscripción no está vacía** (v2): hay una **fila fija por índice** (0…N−1) en el orden de la lista; cada fila corresponde a un nombre suscrito.
   - **Si la suscripción está vacía**: el C++ **no escribe ninguna entrada** de variables en el segmento. Solo actualiza la cabecera (`seq`, `count = 0`, `timestamp`) y hace `sem_post`. Así se evita el coste de volcar todas las variables en cada ciclo cuando nadie está monitorizando. La lista de **variables disponibles** (qué se puede monitorizar) no viene del SHM en ese caso: el backend la obtiene por **UDS** (`list_names` / `list_vars`) cuando hace falta (al abrir el panel de variables o en el refresco periódico) y envía `vars_names` al frontend. Es más eficiente que escribir todos los nombres y valores en SHM cada ciclo.

3. **Backend (Python)**: el `ShmReader` lee el snapshot que haya en SHM (con `count` entradas; si la suscripción estaba vacía, recibe `data: []`). Al enviar al navegador por WebSocket, el backend filtra: solo incluye en `vars_update` las variables cuyo nombre está en `monitored_names`. Así el cliente solo recibe las que le interesan.

4. **Rel act (periodo de envío)**: el backend no envía un `vars_update` en cada ciclo de SHM; respeta un intervalo mínimo entre envíos (configurable en la UI). Eso reduce tráfico y carga en el navegador sin perder coherencia para el usuario. El mismo factor **N** se propaga al C++ como `set_shm_publish_slice` en monitorización pasiva (lista no vacía, sin REC ni alarmas), de modo que el coste por ciclo del productor RT también baja; con REC o reglas de alarma activas se fuerza publicación completa en SHM.

Resumen: **variables no monitorizadas** no se envían al navegador. Con suscripción vacía el C++ no escribe datos en SHM (solo cabecera con `count = 0`); con suscripción fijada, solo se escriben las variables suscritas, reduciendo trabajo en C++ y tamaño del snapshot.

---

## Alarmas y grabación en backend

- **Alarmas**: el frontend envía `set_alarms` con `{ name: { lo, hi } }`. El backend evalúa cada snapshot; si un valor cruza umbral envía `alarm_triggered`; si vuelve a rango `alarm_cleared`. Buffer rodante corto (~1 s + 1 s) con **snapshot completo** por muestra; al disparar, 1 s después se escribe TSV y se notifica `alarm_recording_ready`.
- **Grabación**: el frontend envía `start_recording` y `stop_recording`. Con **`recording_backend = python`**, el backend encola snapshots y un hilo escribe el TSV. Con **`sidecar_cpp`**, se lanza **`varmon_sidecar`** (mismo `shm_name`, sem **`sem_sidecar_name`**); el TSV lo escribe ese proceso. Al parar, `record_finished` con `path`, etc. La ruta se muestra en un toast; el fichero opcional en base64 si está activada la opción correspondiente.
- **`GET /api/perf`**: JSON con capas `python`, `cpp`, `sidecar`. La capa sidecar lee el fichero que el binario actualiza cuando se pasa **`--perf-file`** al lanzar la grabación (convive como `*.part.sidecar_perf.json` junto al TSV temporal); no es parte del protocolo UDS/SHM, solo convención local entre sidecar y backend.
