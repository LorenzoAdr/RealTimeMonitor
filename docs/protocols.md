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
| `server_info`         | (ninguno)                      | Info del servidor, uptime, shm_name, sem_name, uds_path, RAM/CPU |
| `list_names`          | (ninguno)                      | Lista de nombres de variables |
| `list_vars`           | (ninguno)                      | Lista de variables con tipo y valor actual |
| `get_var`             | `"name": "<nombre>"`           | Valor actual de una variable |
| `set_var`             | `"name", "value", "type"`      | Escribir variable (double, int32, bool, etc.) |
| `set_array_element`   | `"name", "index", "value"`     | Escribir un elemento de un array |
| `unregister_var`      | `"name"`                       | Desregistrar variable en caliente |
| `set_shm_subscription`| `"names": ["a","b",...]`       | Suscripción SHM: solo escribir esas variables en SHM; vacío = no escribir entradas (solo cabecera) |

El histórico se construye desde SHM (en vivo) y desde grabaciones TSV en disco; no hay comandos `get_history` / `get_histories` en el protocolo actual.

### Respuestas del C++ (response)

El C++ devuelve siempre un JSON con al menos `"type"`:

- `server_info`: `type`, `uptime_seconds`, `shm_name`, `sem_name`, `uds_path`, opcionalmente `memory_rss_kb`, `cpu_percent`.
- `list_names`: `type: "names"`, `data: ["nombre1", ...]`.
- `list_vars`: `type: "vars"`, `data: [{ "name", "type", "value", "timestamp" }, ...]`.
- `get_var`: `type: "var"`, `data: <objeto var o null>`.
- `set_var` / `set_array_element`: `type: "set_result", "ok": true|false`.
- `unregister_var`: `type: "unregister_result", "ok": true|false`.
- `set_shm_subscription`: `type: "shm_subscription_result", "ok": true`.
- Error: `type: "error", "message": "..."`.

---

## Memoria compartida (SHM): nombres, layout y limpieza

### Nombres

- **Segmento SHM** (en `/dev/shm/`): nombre `varmon-<user>-<pid>` (ruta completa `/dev/shm/varmon-<user>-<pid>`).
- **Semáforo POSIX**: nombre `/varmon-<user>-<pid>` (con barra inicial). Mismo `<user>` y `<pid>` que el segmento.

Cada proceso C++ tiene un segmento y un semáforo; el mismo par user/pid identifica UDS y SHM.

### Creación y destrucción en C++

- **init()** (tras `cleanup_stale_shm_for_user()`): `shm_open`, `ftruncate`, `mmap`, `sem_open`. Si falla, se desvinculan recursos.
- **shutdown()**: `sem_close`/`sem_unlink`, `munmap`/`close`, `shm_unlink`.

### Limpieza de segmentos zombie

- **cleanup_stale_shm_for_user()** (en `shm_publisher.cpp`): lista entradas en `/dev/shm` con prefijo `varmon-<user>-`, extrae PID, comprueba con `kill(pid, 0)`; si el proceso no existe, `shm_unlink` y `sem_unlink`. Se llama al inicio de `init()`.

### Layout del segmento (C++ y Python)

- **Header (32 bytes)**:
  - 0–3:   magic (0x4D524156, "VARM" LE).
  - 4–7:   version (1).
  - 8–15:  seq (contador de snapshots).
  - 16–19: count (número de entradas).
  - 20–23: padding.
  - 24–31: timestamp (double, tiempo Unix).

- **Entradas**: hasta 512; cada una: 128 bytes nombre (C string), 1 byte tipo (0=double, 1=int32, 2=bool, 3=string, 4=array), 8 bytes valor (double).

Solo variables **escalares** en SHM. La suscripción `set_shm_subscription` restringe qué variables se escriben: si no está vacía, solo esas; si está vacía, el C++ no escribe ninguna entrada (solo cabecera con `count = 0`). Ver más abajo el sistema de actualización de variables monitorizadas.

### Funcionamiento detallado del segmento SHM

El segmento es un **buffer de tamaño fijo** en `/dev/shm/`: `HEADER_SIZE + MAX_VARS * ENTRY_SIZE` (32 + 512×137 bytes). C++ y Python acuerdan el mismo layout para poder leer/escribir sin protocolo adicional.

**Serialización de variables**

- **Cabecera**: los primeros 32 bytes se interpretan con estructuras de tamaño fijo (en C++ con `memcpy` a `char*`; en Python con `struct.unpack(HEADER_FMT, ...)` y lectura del timestamp en el offset 24). El campo `count` indica cuántas entradas válidas hay en este snapshot.
- **Cada entrada** tiene tamaño fijo **137 bytes**:
  - **Nombre**: 128 bytes, C-string (terminado en `\0`); el resto relleno a cero. Python lee hasta el primer `\0` y decodifica como UTF-8.
  - **Tipo**: 1 byte. Códigos: 0=double, 1=int32, 2=bool, 3=string, 4=array. Solo los tipos escalares (0, 1, 2) se escriben en SHM; string y array se omiten.
  - **Valor**: 8 bytes, un `double` en little-endian. Para bool se usa 0.0/1.0; para int32 se convierte a double. Python interpreta según el byte de tipo (bool → true/false, int32 → entero, double → número).

**Dónde leen C++ y Python**

- **Dirección base**: C++ obtiene el puntero con `mmap` en `init()`; Python abre el fichero en `/dev/shm/<nombre>` y hace `mmap(..., MAP_SHARED, PROT_READ)`.
- **Cabecera**: siempre en el offset **0**, 32 bytes. C++ escribe aquí `magic`, `version`, `seq`, `count`, `timestamp`; Python lee los mismos campos para validar (`magic`), saber cuántas entradas leer (`count`) y en qué posición empiezan (inmediatamente después del header).
- **Entradas**: empiezan en el offset **32** (`HEADER_SIZE`). La entrada *i* está en `32 + i * 137`. C++ recorre sus variables, escribe cada una en `ent`, y hace `ent += ENTRY_SIZE`. Python hace `buf.seek(0)`, lee la cabecera, luego en un bucle `for _ in range(count)` lee `ENTRY_SIZE` bytes con `buf.read(137)` y parsea nombre/tipo/valor.

El **semáforo POSIX** se usa para señalizar “nuevo snapshot disponible”: C++ hace `sem_post` tras escribir; Python hace `sem_wait` (o `sem_timedwait`) y luego lee. Así ambos saben que el contenido del segmento es consistente en el momento de la lectura.

**Esquema del layout del segmento**

```mermaid
block-beta
  columns 1
  block:Segmento SHM (/dev/shm/varmon-user-pid)
    block:Header 32 bytes
      H1["0-3: magic"]
      H2["4-7: version"]
      H3["8-15: seq"]
      H4["16-19: count"]
      H5["20-23: padding"]
      H6["24-31: timestamp (double)"]
    end
    block:Entrada 0 (137 bytes)
      E0a["nombre[128]"]
      E0b["tipo[1]"]
      E0c["valor double[8]"]
    end
    block:Entrada 1 (137 bytes)
      E1["..."]
    end
    block:...
      E2["... hasta count entradas"]
    end
  end
end
```

En memoria (bytes):

| Offset   | Tamaño | Contenido |
|----------|--------|-----------|
| 0        | 4      | magic (0x4D524156) |
| 4        | 4      | version (1) |
| 8        | 8      | seq (contador de ciclo) |
| 16       | 4      | count (número de entradas en este snapshot) |
| 20       | 4      | padding |
| 24       | 8      | timestamp (double, Unix) |
| 32       | 137    | entrada 0: name[128], type[1], value[8] |
| 169      | 137    | entrada 1 |
| …        | …      | hasta `count` entradas (máx. 512) |

### Flujo de escritura (C++)

- Cada ciclo: `write_shm_snapshot(mon)` → actualiza seq y timestamp en la cabecera. Si la suscripción está vacía, escribe `count = 0` y hace `sem_post` (no escribe entradas). Si la suscripción tiene nombres, escribe count, las entradas correspondientes y hace `sem_post`.

### Flujo de lectura (Python, ShmReader)

- Abre segmento con `os.open("/dev/shm/"+shm_name)` y `mmap.mmap(..., MAP_SHARED, PROT_READ)`.
- Abre semáforo con `sem_open(sem_name, O_RDWR)` (ctypes).
- En un hilo: bucle `sem_timedwait(sem, timeout)`; al recibir señal, lee header + entradas, construye lista de dicts `{name, type, value}` y la pone en una `Queue`. El bucle del WebSocket consume la cola.

### Sistema de actualización de variables monitorizadas

Solo se actualizan y envían al navegador las **variables monitorizadas**; el resto no se escribe en SHM (cuando hay suscripción) y no se envía por WebSocket.

1. **En el frontend**: el usuario selecciona qué variables quiere ver (gráficas, tabla, alarmas). Esa lista se envía al backend con la acción `set_monitored` (`names`).

2. **Suscripción SHM (C++)**: el backend llama a `set_shm_subscription(list(monitored_names))` por UDS.
   - **Si la suscripción no está vacía**: `write_shm_snapshot()` solo escribe en el segmento las variables cuyo nombre está en esa lista; las demás se omiten.
   - **Si la suscripción está vacía**: el C++ **no escribe ninguna entrada** de variables en el segmento. Solo actualiza la cabecera (`seq`, `count = 0`, `timestamp`) y hace `sem_post`. Así se evita el coste de volcar todas las variables en cada ciclo cuando nadie está monitorizando. La lista de **variables disponibles** (qué se puede monitorizar) no viene del SHM en ese caso: el backend la obtiene por **UDS** (`list_names` / `list_vars`) cuando hace falta (al abrir el panel de variables o en el refresco periódico) y envía `vars_names` al frontend. Es más eficiente que escribir todos los nombres y valores en SHM cada ciclo.

3. **Backend (Python)**: el `ShmReader` lee el snapshot que haya en SHM (con `count` entradas; si la suscripción estaba vacía, recibe `data: []`). Al enviar al navegador por WebSocket, el backend filtra: solo incluye en `vars_update` las variables cuyo nombre está en `monitored_names`. Así el cliente solo recibe las que le interesan.

4. **Rel act (periodo de envío)**: el backend no envía un `vars_update` en cada ciclo de SHM; respeta un intervalo mínimo entre envíos (configurable en la UI). Eso reduce tráfico y carga en el navegador sin perder coherencia para el usuario.

Resumen: **variables no monitorizadas** no se envían al navegador. Con suscripción vacía el C++ no escribe datos en SHM (solo cabecera con `count = 0`); con suscripción fijada, solo se escriben las variables suscritas, reduciendo trabajo en C++ y tamaño del snapshot.

---

## Alarmas y grabación en backend

- **Alarmas**: el frontend envía `set_alarms` con `{ name: { lo, hi } }`. El backend evalúa cada snapshot; si un valor cruza umbral envía `alarm_triggered`; si vuelve a rango `alarm_cleared`. Buffer rodante 10 s + 1 s; al disparar, 1 s después se escribe TSV y se notifica `alarm_recording_ready`.
- **Grabación**: el frontend envía `start_recording` y `stop_recording`. El backend encola snapshots. Al parar, escribe TSV en `web_monitor/recordings/`, envía `record_finished` con `path` (y opcionalmente `file_base64`). La ruta se muestra en un toast; el fichero se envía solo si está activada la opción "Enviar fichero al terminar".
