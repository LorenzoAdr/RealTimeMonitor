# Frontend

El frontend es una SPA en [web_monitor/static/](../web_monitor/static/): `index.html`, hoja de estilos y cliente **modular ES** (`js/entry.mjs` → `app-legacy.mjs`, módulos `constants` / `i18n`; opcionalmente bundle IIFE vía esbuild). Usa **Plotly.js** para los gráficos.

## Vista general de la interfaz

Cabecera con estado de conexión, selector de **modo** (Live / Análisis / Replay), **Rel act**, tema e idioma; tres columnas (variables, monitor, gráficos).

![Interfaz en tema claro](images/general_claro.png){ width="100%" }

![Interfaz en tema oscuro](images/general_oscuro2.png){ width="100%" }

## Estructura del código cliente

- **Módulos ES**: el punto de entrada [`entry.mjs`](../web_monitor/static/js/entry.mjs) importa la lógica principal; las constantes y traducciones viven en [`js/modules/`](../web_monitor/static/js/modules/). Sin bundler, el navegador carga los `.mjs` con `type="module"`.
- **Estado y DOM**: la lógica principal mantiene el estado en el ámbito del módulo (equivalente al antiguo IIFE de un único `app.js`) y manipula el DOM con callbacks; no hay framework (React/Vue).
- **Estado global** (ámbito del módulo principal): `monitoredNames`, `monitoredOrder`, `varGraphAssignment`, `arrayElemAssignment`, `graphList`, `historyCache`, `arrayElemHistory`, `plotInstances`, `alarms`, `computedVars`, `appMode`, `offlineDataset`, etc.
- **Inicialización**: Tras cargar el módulo se ejecutan `loadConfig()`, `pruneArincDerivedFromMonitored()`, `applyTheme()`, `applyLanguage()`, listeners, `ResizeObserver` del área de gráficos y `rebuildPlotArea()`.

## Tres columnas

1. **Columna 1 (navegador de variables)**: Lista de variables conocidas (`knownVarNames`), filtro, agrupación opcional, checkboxes para añadir a “monitor” o seleccionar para arrastrar. Drag & drop para llevar variables a la columna 2 o a un gráfico.
2. **Columna 2 (monitor)**: Variables en vivo con valor actual. Orden según `monitoredOrder`. Cada fila puede tener un selector para asignar la variable a un gráfico (`varGraphAssignment[name] = gid`). Aquí se envían al backend las variables “monitorizadas” (`monitored` por WebSocket).
3. **Columna 3 (gráficos)**: Área de gráficos Plotly. Slots por gráfico (`graphList`: lista de IDs `g1`, `g2`, ...). Cada slot tiene un contenedor `#plotContainer_<gid>`. Las variables asignadas a un gráfico vienen de `varGraphAssignment` y `arrayElemAssignment`; la función **getVarsForGraph(gid)** devuelve los nombres asignados a ese `gid`.

## Flujo de datos en vivo (WebSocket)

- Al conectar, el frontend envía la lista de variables a monitorizar (`monitored`) y el backend envía `vars_update` con snapshots.
- El manejador del mensaje recibe el payload, actualiza `historyCache` y `arrayElemHistory` (histórico por variable para los gráficos), y llama a **schedulePlotRender()**.
- **schedulePlotRender()**: Si no está pausado y pasa el throttle (adaptive load), encola un **requestAnimationFrame** que llama a **renderPlots()**.

## Gráficos: funciones clave

- **rebuildPlotArea()**: Purgar todos los Plotly de los contenedores existentes, vaciar el área (excepto el nodo `#plotEmpty`), y para cada `gid` en `graphList` crear un slot (cabecera + contenedor `#plotContainer_<gid>`). Insertar los slots antes de `plotEmpty`. Si hay al menos un gráfico, ocultar `plotEmpty` (`display: none`) para que el cajetín ocupe todo el alto; si no hay gráficos, mostrar `plotEmpty` (zona de “suelta aquí para crear gráfico”).
- **renderPlots()**: Para cada `gid` en `graphList`, obtener las variables del gráfico con **getVarsForGraph(gid)**, construir las trazas desde `historyCache` / `arrayElemHistory` (ventana de tiempo según `timeWindowSelect`), aplicar suavizado opcional, y llamar a `Plotly.newPlot` (primera vez) o `Plotly.react` (actualizaciones). También actualiza la visibilidad de `plotEmpty` y las estadísticas de render. **Segundo pintado tras F5**: la primera vez que termina `renderPlots()` con `graphList.length > 0`, se programa un único **schedulePlotRender()** a los 500 ms (`__plotSecondPaintScheduled`), para que cuando los datos ya hayan llegado por WebSocket se vuelvan a dibujar las curvas y no quede el cajetín vacío.
- **getVarsForGraph(gid)**: Devuelve los nombres de variables asignados al gráfico `gid`: los que están en `monitoredNames` con `varGraphAssignment[name] === gid`, más los de `varGraphAssignment` que son derivados ARINC y apuntan a `gid`, más los de `arrayElemAssignment` que apuntan a `gid`.

## Persistencia (localStorage)

- **saveConfig()** / **loadConfig()**: Guardan y cargan en `localStorage` (clave `varmon_config`) la lista de variables monitorizadas, `varGraphAssignment`, `graphList`, ventana de tiempo, tema, idioma, modo (live/offline), rutas de grabación, etc. Al cargar la página, `loadConfig()` restaura el estado y luego se llama a `rebuildPlotArea()` al final del init, de modo que los slots de gráficos existan desde el principio.

## Modos: live, análisis y replay híbrido

- **Live**: Datos por WebSocket desde el backend (SHM/UDS). Selector de instancia UDS, Rel act (update_ratio), grabación, alarmas.
- **Offline (análisis)**: Se cargan grabaciones TSV (desde servidor o fichero local). El frontend pide ventanas de tiempo por API (`/api/recordings/{filename}/window` o `window_batch`) y rellena `historyCache` / `arrayElemHistory` para pintar los mismos gráficos. `offlineDataset`, `offlineRecordingName`, segmentos, scrubber y controles de reproducción son específicos de este modo.
- **Replay (híbrido)**: Mantiene WebSocket activo para recibir `vars_names`/`vars_update` de SHM y, a la vez, usa una grabación TSV como referencia temporal. La lista de variables es la unión de backend + TSV. Solo las variables TSV marcadas como **imponer** escriben continuamente a SHM siguiendo el valor del TSV (con offsets `Δt`/`Δv`); las TSV no impuestas se comportan como variables normales de SHM.

![Modo análisis — TSV y controles offline](images/analisis.png){ width="100%" }

![Modo replay — referencia TSV + datos en vivo](images/replay.png){ width="100%" }

## Opciones avanzadas en la zona de gráficos

Panel colapsable (esquina inferior derecha) con anomalías, segmentos, notas, informe PDF, etc.

![Opciones avanzadas junto a los gráficos](images/avanzado.png){ width="100%" }

## Ayuda integrada y visor de log

- **Ayuda** (`H` / `?`): modal con guía por modos (Live, análisis, replay) y enlaces a documentación MkDocs si está generada.

![Ventana de ayuda integrada](images/manual.png){ width="100%" }

- **Log**: panel con el registro del backend (y opcionalmente C++ vía `log_file_cpp`); véase [Instalación — Visor de log](setup.md#visor-de-log-integrado).

![Visor de log en la cabecera](images/log.png){ width="100%" }

## Resize de gráficos

- Un **ResizeObserver** observa el nodo `#plotArea`. Cuando cambia el tamaño del área (p. ej. redimensionar ventana), se hace **Plotly.relayout** de cada contenedor de gráfico con el tamaño actual (`getBoundingClientRect()`), para que los gráficos se adapten al espacio disponible.

## Panel Perf

- Botón **Perf** en la cabecera: overlay a pantalla completa que consulta periódicamente **`GET /api/perf`** mientras está abierto.
- Tres bloques: fases **Python**, **C++** (`write_shm_snapshot`) y **sidecar** (solo si hay grabación `sidecar_cpp` activa y el binario escribe el JSON de `--perf-file`). Tablas con último tiempo, EMA y número de muestras; barras apiladas por capa.

![Panel Perf — capas Python, C++ y sidecar](images/perf.png){ width="100%" }
- La primera petición **renueva el lease** de medición en el servidor (igual que `GET /api/advanced_stats?perf=1` desde la tira de estadísticas). Si el lease expira, el panel muestra un aviso hasta que se vuelva a abrir o se use estadísticas avanzadas.
- Detalle de fases y optimizaciones del sidecar: [Rendimiento](performance.md).

## Atajos y otros

- Teclado: Escape (cerrar overlays), Espacio (pausar/reanudar gráficos), Ctrl+Z / Ctrl+Y (deshacer/rehacer layout), R (grabación), S (screenshot), etc.
- Administración avanzada: overlay con rutas de config, grabaciones, estado del servidor; botón “Guardar cambios” aplica `web_port` y `web_port_scan_max` al backend (`/api/admin/runtime_config`). Si se cambian los campos de puerto base o incremento, el botón se resalta en verde hasta guardar.
