# Frontend

El frontend es una SPA en [web_monitor/static/](../web_monitor/static/): `index.html`, `app.js` (lógica principal) y `style.css`. Usa **Plotly.js** para los gráficos.

## Estructura general de app.js

- **IIFE**: Todo el código está dentro de una función anónima que se ejecuta al cargar el script, para no contaminar el ámbito global.
- **Estado global** (variables en el ámbito de la IIFE): `monitoredNames`, `monitoredOrder`, `varGraphAssignment`, `arrayElemAssignment`, `graphList`, `historyCache`, `arrayElemHistory`, `plotInstances`, `alarms`, `computedVars`, `appMode`, `offlineDataset`, etc.
- **Inicialización**: Al final del script se llama a `loadConfig()`, `pruneArincDerivedFromMonitored()`, `applyTheme()`, `applyLanguage()`, y más abajo se registran event listeners, se configura el ResizeObserver del área de gráficos y se llama a `rebuildPlotArea()`. No hay framework (React/Vue); todo es DOM y callbacks.

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

## Modos: live y offline (análisis)

- **Live**: Datos por WebSocket desde el backend (SHM/UDS). Selector de instancia UDS, Rel act (update_ratio), grabación, alarmas.
- **Offline (análisis)**: Se cargan grabaciones TSV (desde servidor o fichero local). El frontend pide ventanas de tiempo por API (`/api/recordings/{filename}/window` o `window_batch`) y rellena `historyCache` / `arrayElemHistory` para pintar los mismos gráficos. `offlineDataset`, `offlineRecordingName`, segmentos, scrubber y controles de reproducción son específicos de este modo.

## Resize de gráficos

- Un **ResizeObserver** observa el nodo `#plotArea`. Cuando cambia el tamaño del área (p. ej. redimensionar ventana), se hace **Plotly.relayout** de cada contenedor de gráfico con el tamaño actual (`getBoundingClientRect()`), para que los gráficos se adapten al espacio disponible.

## Atajos y otros

- Teclado: Escape (cerrar overlays), Espacio (pausar/reanudar gráficos), Ctrl+Z / Ctrl+Y (deshacer/rehacer layout), R (grabación), S (screenshot), etc.
- Administración avanzada: overlay con rutas de config, grabaciones, estado del servidor; botón “Guardar cambios” aplica `web_port` y `web_port_scan_max` al backend (`/api/admin/runtime_config`). Si se cambian los campos de puerto base o incremento, el botón se resalta en verde hasta guardar.
