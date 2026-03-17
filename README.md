# VarMonitor - Monitor de Variables en Tiempo Real

Sistema de monitorización de variables en tiempo real para aplicaciones C++20. La comunicación entre la aplicación C++ y el monitor web usa **Unix Domain Sockets (UDS)** y **memoria compartida (SHM)** con semáforos POSIX. Interfaz web para visualización, gráficos, alarmas, grabación TSV y más.

## Arquitectura general

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Aplicación C++ (tu proceso)                                             │
│  ┌─────────────────┐   ┌──────────────────┐   ┌─────────────────────────┐ │
│  │ VarMonitor       │   │ shm_publisher    │   │ uds_server_loop()      │ │
│  │ (variables)      │──►│ /dev/shm/varmon-  │   │ /tmp/varmon-user-pid   │ │
│  │ write_shm_       │   │   user-pid        │   │ .sock                  │ │
│  │ snapshot()       │   │ sem: /varmon-... │   │ (JSON length-prefixed)  │ │
│  └─────────────────┘   └────────┬─────────┘   └────────────┬────────────┘ │
└─────────────────────────────────┼────────────────────────────┼─────────────┘
                                  │ sem_post cada ciclo        │ UDS
                                  ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Backend Python (FastAPI)                                                 │
│  ┌─────────────────┐   ┌──────────────────┐   ┌────────────────────────┐│
│  │ ShmReader        │   │ UdsBridge         │   │ WebSocket / HTTP       ││
│  │ sem_timedwait →  │   │ conecta a          │   │ vars_update, alarmas,  ││
│  │ read snapshot →  │   │ /tmp/varmon-*.sock│   │ record_finished, etc.  ││
│  │ Queue            │   │ (comandos JSON)   │   │                         ││
│  └────────┬────────┘   └───────────────────┘   └────────────┬─────────────┘│
└────────────┼─────────────────────────────────────────────────┼────────────┘
             │                                                  │
             └──────────────────────┬───────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Frontend (navegador)                                                     │
│  Plotly.js, selector de instancia UDS, Rel act (tasa visual), alarmas,   │
│  grabación, opción “Enviar fichero al terminar”, toast con ruta guardada  │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Sin TCP**: no hay puertos de red entre C++ y Python. Todo es local (UDS + SHM).
- **web_port** en `varmon.conf` es solo el puerto HTTP/WebSocket del servidor web (Python).

---

## Descubrimiento de instancias (“explorar la red”)

No se explora la red por IP/puerto. Las instancias C++ se descubren por **sockets Unix** en `/tmp`:

1. **Patrón de nombres**: `/tmp/varmon-<user>-<pid>.sock`
   - `user`: usuario del sistema (getenv `USER` o `getpwuid(geteuid())` en C++).
   - `pid`: PID del proceso C++.

2. **Cómo las lista el backend Python** (`_list_uds_instances` en `app.py`):
   - `glob.glob("/tmp/varmon-*.sock")` o, si se filtra por usuario, `glob.glob("/tmp/varmon-<user>-*.sock")`.
   - Para cada path se abre una conexión UDS temporal (`UdsBridge(path, timeout=0.6)`), se llama a `get_server_info()` (comando `server_info`) y se cierra.
   - Solo se consideran instancias que responden correctamente a `server_info`.
   - Del nombre del fichero se extrae `user` y `pid` (por ejemplo `varmon-juan-12345.sock` → user=`juan`, pid=`12345`).
   - **Orden**: se ordenan por **mtime del socket** (más reciente primero), para que la instancia “por defecto” sea la que se creó más recientemente.

3. **API REST**: `GET /api/uds_instances?user=<opcional>` devuelve `{"instances": [{ "uds_path", "pid", "uptime_seconds", "user" }, ...]}`.

4. **Frontend**: el selector “Instancia” rellena un `<select>` con las instancias devueltas; cada opción tiene `value="uds:<uds_path>"`. Si el usuario no elige una, el backend usa la primera de la lista (la más reciente por mtime) al aceptar el WebSocket.

---

## Conexión inicial y primeros mensajes

### 1. Navegador → Backend (WebSocket)

- El frontend abre `ws://<host>/ws` (opcionalmente `?uds_path=<path>&password=...`).
- Si no se envía `uds_path`, el backend llama a `_list_uds_instances(None)` y toma la primera instancia (más reciente) como `uds_path`.

### 2. Backend → C++ (UDS)

- Se crea un `UdsBridge(uds_path, timeout=5.0)` y se conecta al socket Unix.
- **Primer mensaje imprescindible**: `get_server_info()` → envía comando `server_info` por UDS y recibe la respuesta.
- En la respuesta vienen:
  - `uds_path`: path del socket (por si el backend quiere guardarlo).
  - `shm_name`, `sem_name`: nombres del segmento SHM y del semáforo POSIX (solo si SHM está activo).
  - `uptime_seconds`, `memory_rss_kb`, `cpu_percent` (si están disponibles).

### 3. Asociación del segmento de memoria a “cada Python”

- **No hay “un segmento por Python”**. Hay **un segmento por proceso C++** (por instancia VarMonitor). El nombre es `varmon-<user>-<pid>` (el mismo `user`/`pid` que el del socket UDS de esa instancia).
- El backend Python, **por cada conexión WebSocket**, elige **una** instancia UDS (una app C++). De esa instancia obtiene un único `shm_name` y `sem_name` vía `server_info`. Con eso:
  - Crea **un** `ShmReader` (un hilo que lee ese segmento y ese semáforo y mete snapshots en una cola).
  - Ese WebSocket usa solo ese segmento/semáforo para `vars_update` (y para alarmas/grabación en backend).
- Si hay varios procesos C++ (varios PIDs), hay varios sockets UDS y varios segmentos SHM distintos; cada cliente WebSocket se asocia a **una** instancia (la que elija en el selector o la primera por defecto).

### 4. Flujo de datos en vivo (SHM)

- C++: cada ciclo (por ejemplo cada 10 ms) llama a `write_shm_snapshot()` → escribe en SHM y hace `sem_post(sem)`.
- Python: el hilo `ShmReader` hace `sem_timedwait(sem, timeout)`; cuando recibe la señal, lee el snapshot del SHM, lo parsea y lo pone en una cola. El bucle del WebSocket drena esa cola, evalúa alarmas, rellena buffers de grabación y, a tasa visual (Rel act), envía `vars_update` al navegador.

---

## Protocolo UDS: formato de mensajes

Todos los mensajes entre Python y C++ por UDS siguen el mismo esquema:

1. **Longitud (4 bytes, big-endian, unsigned)**  
   Longitud en bytes del JSON que sigue (sin incluir estos 4 bytes).

2. **Cuerpo (JSON)**  
   Objeto JSON en UTF-8.

- **Máximo**: 10 MiB por mensaje (límite en C++ y en `uds_client.py`).

### Envío desde Python (UdsBridge)

- Se construye un `dict` y se serializa con `json.dumps(..., separators=(",", ":"))`.
- Se envía `struct.pack("!I", len(raw)) + raw`.

### Recepción en C++ (uds_server)

- `recv_message()`: lee 4 bytes, hace `ntohl` → `len`, luego lee `len` bytes (JSON).
- Se parsea el JSON a mano (no hay librería JSON en el C++ del repo) para extraer `cmd` y parámetros.

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
| `set_shm_subscription`| `"names": ["a","b",...]`       | Suscripción SHM: solo escribir esas variables en SHM (vacío = todas) |

Los antiguos comandos `get_history`, `get_histories`, `get_histories_since` existían solo en el cliente Python; ahora el histórico se construye exclusivamente desde SHM (en vivo) y desde las grabaciones TSV en disco.

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

### Nombres de segmentos y semáforos

- **Segmento SHM** (en `/dev/shm/`):
  - **Nombre**: `varmon-<user>-<pid>` (sin barra delante en el nombre del objeto; la ruta completa es `/dev/shm/varmon-<user>-<pid>`).
  - **user**: mismo que para el socket UDS (`USER` o getpwuid).
  - **pid**: PID del proceso C++ que llama a `shm_publisher::init()`.

- **Semáforo POSIX**:
  - **Nombre**: `/varmon-<user>-<pid>` (con barra inicial; es el nombre “global” del semáforo).
  - Mismo `<user>` y `<pid>` que el segmento.

Así, **cada proceso C++** (cada PID) tiene exactamente un segmento y un semáforo asociados, y el mismo par user/pid identifica tanto el socket UDS como el SHM.

### Creación y destrucción en C++

- **init()** (al arrancar VarMonitor, tras `cleanup_stale_shm_for_user()`):
  - `shm_open("/varmon-<user>-<pid>", O_CREAT|O_RDWR|O_EXCL, 0666)`.
  - `ftruncate` al tamaño del segmento (header + máximo de entradas).
  - `mmap` del segmento.
  - `sem_open("/varmon-<user>-<pid>", O_CREAT|O_EXCL, 0666, 0)`.
  - Si algo falla, se cierran y desvinculan los recursos ya creados.

- **shutdown()** (al parar):
  - `sem_close` y `sem_unlink` del semáforo.
  - `munmap` y `close` del fd del SHM.
  - `shm_unlink("/varmon-<user>-<pid>")`.

### Limpieza de segmentos “zombie”

- **cleanup_stale_shm_for_user()** (en `shm_publisher.cpp`):
  - Se listan entradas en `/dev/shm` con prefijo `varmon-<user>-`.
  - Para cada nombre se extrae el PID del sufijo.
  - Se comprueba si ese PID sigue vivo con `kill(pid, 0)`; si devuelve ESRCH el proceso ya no existe.
  - Entonces se hace `shm_unlink("/" + name)` y `sem_unlink("/" + name)` para ese nombre.
  - Se llama al inicio de `init()` para evitar reutilizar segmentos de procesos muertos.

### Layout del segmento (C++ y Python)

- **Header (32 bytes)**:
  - 0–3:   magic (0x4D524156, "VARM" LE).
  - 4–7:   version (1).
  - 8–15:  seq (contador de snapshots).
  - 16–19: count (número de entradas en este snapshot).
  - 20–23: padding.
  - 24–31: timestamp (double, tiempo Unix).

- **Entradas**: hasta 512 entradas; cada una:
  - 128 bytes: nombre de variable (C string, relleno con ceros).
  - 1 byte: tipo (0=double, 1=int32, 2=bool, 3=string, 4=array).
  - 8 bytes: valor (double; para bool/int se convierte a double).

Solo se escriben variables **escalares** (no arrays ni strings) en SHM. La **suscripción** (`set_shm_subscription`) restringe qué variables se escriben; si la lista está vacía, se escriben todas las escalares.

### Flujo de escritura (C++)

- En cada ciclo de la aplicación (por ejemplo 100 Hz): `write_shm_snapshot(mon)`.
  - Actualiza seq, count, timestamp y las entradas en el buffer compartido.
  - Filtra por suscripción si no está vacía.
  - Al final hace `sem_post(g_sem)` para avisar al lector.

### Flujo de lectura (Python, ShmReader)

- Abre el segmento con `os.open("/dev/shm/"+shm_name)` y `mmap.mmap(..., MAP_SHARED, PROT_READ)`.
- Abre el semáforo con `sem_open(sem_name, O_RDWR)` (ctypes; `restype = c_void_p` para 64 bits).
- En un hilo: en bucle, `sem_timedwait(sem, timeout)`; si recibe señal, `buf.seek(0)`, lee header + entradas, construye lista de dicts `{name, type, value}` y la pone en una `Queue`. El bucle del WebSocket consume esa cola.

### Si el semáforo no abre (WSL / ENOENT / EACCES)

En algunos entornos (p. ej. **WSL**) el backend puede no poder abrir el semáforo POSIX creado por el C++. El mensaje del backend incluirá el **errno** (p. ej. `ENOENT` o `EACCES`).

- **ENOENT**: el archivo del semáforo no existe para el proceso Python. En Linux el semáforo está en `/dev/shm/sem.<nombre_sin_barra>` (ej. `/dev/shm/sem.varmon-lariasr-10229`). Compruebe desde la misma sesión/usuario que el C++:
  - `ls /dev/shm/sem.*` — debe aparecer el semáforo mientras el proceso C++ esté en marcha.
  - Que el backend Python se ejecute con el **mismo usuario** que el proceso C++ y, en WSL, preferiblemente desde el mismo tipo de sesión (misma terminal o mismo WSL distro).
- **EACCES**: permisos. El C++ crea el semáforo con `0666`; si aun así falla, compruebe que no haya restricciones de namespace o montajes distintos de `/dev/shm`.
- **Fallback**: si el semáforo no se puede abrir, el backend usa **modo polling**: lee el segmento SHM cada ~5 ms y detecta datos nuevos por el campo `seq` del header. La grabación sigue siendo a tasa real; solo se pierde la señalización bloqueante (ligero aumento de CPU en el hilo lector).

---

## Dos tasas: visual vs monitorización

- **Tasa visual (baja)**: cuántas veces se envía `vars_update` al navegador. Controlada por **Rel act** (1 = cada ciclo de backend, 5 por defecto = más espaciado). Solo afecta al envío al navegador.
- **Tasa interna (alta)**: el backend procesa **cada** snapshot que llega por SHM (o cada respuesta UDS si no hay SHM): evalúa alarmas, rellena buffers de grabación y de alarma (10 s + 1 s). Así no se pierden ciclos para alarmas ni grabación.
- **Rel act 1**: “mándame todo” a la tasa máxima de envío al navegador cuando el usuario lo necesita.

---

## Alarmas y grabación en backend

- **Alarmas**: el frontend envía `set_alarms` con `{ name: { lo, hi } }`. El backend evalúa cada snapshot; si un valor cruza umbral envía `alarm_triggered`; si vuelve a rango envía `alarm_cleared`. Se mantiene un buffer rodante de 10 s + 1 s; al disparar una alarma, 1 s después se escribe un TSV y se notifica con `alarm_recording_ready` (path siempre; fichero opcional si “Enviar fichero al terminar” está activado).
- **Grabación**: el frontend envía `start_recording` y `stop_recording`. El backend va encolando snapshots (desde SHM o desde UDS si no hay SHM). Al parar, escribe TSV en `web_monitor/recordings/`, envía `record_finished` con `path` (y opcionalmente `file_base64`). La ruta se muestra siempre en un toast; el fichero se envía solo si el usuario tiene activada la opción “Enviar fichero al terminar” (por defecto desactivada).

---

## Requisitos

- Linux (UDS y SHM en `/dev/shm` y semáforos POSIX).
- CMake 3.16+, GCC 11+ (C++20).
- Python 3.10+.

## Instalación rápida

```bash
# 1. Instalar dependencias
chmod +x scripts/setup.sh
./scripts/setup.sh

# 2. Compilar
mkdir -p build && cd build
cmake .. && make -j$(nproc)

# 3. Lanzar el servidor demo (C++)
./demo_app/demo_server

# 4. En otra terminal, lanzar el monitor web (Python)
cd web_monitor
source .venv/bin/activate
python app.py

# 5. Abrir http://localhost:8080
```

## Configuración: varmon.conf

Ejemplo mínimo:

```
# Puerto del monitor web (solo Python)
web_port = 8080
```

Opcional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`.  
Ruta del archivo: variable de entorno `VARMON_CONFIG` o en C++ `varmon::set_config_path(...)`.

## Integración en tu proyecto C++

```cmake
add_subdirectory(libvarmonitor)
target_link_libraries(tu_app PRIVATE varmonitor)
```

```cpp
#include <var_monitor.hpp>

varmon::VarMonitor monitor;
monitor.register_var("sensors.temperatura", &temperatura);
monitor.start(100);  // 100 ms entre muestreos; arranca UDS y SHM

// En tu lazo de control (ej. 100 Hz):
monitor.write_shm_snapshot();
```

Con macros: `var_monitor_macros.hpp`, `VARMON_WATCH`, `VARMON_START`, etc.

## Funcionalidades del monitor web

- Tres columnas: variables disponibles, monitor en vivo, gráficos.
- Gráficos dinámicos (Plotly), alarmas Hi/Lo, grabación TSV (backend), notificaciones, variables computadas, guardar/cargar configuración, acceso remoto por web_port, atajos de teclado (R grabación, S screenshot, etc.).

## Estructura del proyecto

```
monitor/
├── varmon.conf
├── libvarmonitor/       # C++: VarMonitor, shm_publisher, uds_server
├── demo_app/
├── web_monitor/        # Python FastAPI, UdsBridge, ShmReader
│   ├── recordings/     # TSV de grabaciones y alarmas (generado)
│   └── static/
└── scripts/
```
