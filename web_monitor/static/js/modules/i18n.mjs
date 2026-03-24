/** Traducciones ES/EN y guías de ayuda HTML. */
export function createI18n() {
const I18N = {
    es: {
        colBrowserTitle: "Variables disponibles",
        colMonitorTitle: "Monitorizando",
        colPlotTitle: "Gráficos",
        helpTitle: "Ayuda",
        instanceLabel: "Instancia:",
        pollLabel: "Rel act:",
        settingsTitle: "Ajustes",
        langLabel: "Idioma:",
        themeLabel: "Tema:",
        reconnectBtn: "Conectar",
        reconnectTitle: "Reconectar con la instancia seleccionada",
        recordBtn: "● REC",
        resetConfigTitle: "Eliminar toda la configuración",
        clearAlarmsTitle: "Quitar todas las alarmas",
        resetPlotsTitle: "Quitar asignaciones de variables a gráficos",
        resetPlotsBtn: "Limpiar",
        pausePlay: "▶ Play",
        pausePause: "⏸ Pause",
        screenshotTitle: "Capturar gráficos como PNG",
        windowLabel: "Ventana:",
        bufferLabel: "Buffer:",
        bufferVisualLabel: "Buffer visual:",
        filterPlaceholder: "Filtrar variables...",
        selectAll: "Sel. todo",
        selectNone: "Ninguno",
        addToMonitor: "+ Monitorizar",
        hideLevelsLabel: "Niveles:",
        statusConnected: "Conectado",
        statusDisconnected: "Desconectado",
        statusNoInstances: "No hay instancias VarMonitor (UDS)",
        graphTitle: "Gráfico",
        plotPendingData: "Esperando datos del servidor…",
        plotPendingHistory: "Cargando historial de la serie…",
        newGraphDropText: "Nuevo gráfico: suelta aquí para crear uno",
        removeGraphTitle: "Eliminar gráfico",
        monitorMenuTitle: "Más opciones",
        monitorGridLinesLabel: "Mostrar cuadrícula",
        monitorGridLinesTitle: "Bordes de celda alrededor de cada variable (fondo opaco para que no se mezcle con el panel).",
        timeAxisTitle: "t (s)",
        resetTimeBtn: "Reset tiempo",
        resetTimeTitle: "Reiniciar origen de tiempo y borrar historial de gráficos",
        smoothPlotsLabel: "Suavizado",
        smoothPlotsTitle: "Ventana de media móvil para suavizar curvas (1 = sin suavizado)",
        smoothOff: "No",
        smooth3: "Suave (3)",
        smooth5: "Medio (5)",
        smooth7: "Fuerte (7)",
        smooth11: "Muy fuerte (11)",
        authTitle: "Contraseña",
        authPrompt: "El monitor requiere contraseña para conectar.",
        authWrongAttempts: "Contraseña incorrecta. Intentos restantes: %d de 3.",
        authLastAttempt: "Último intento. Si falla, el servidor se cerrará por seguridad.",
        authServerClosed: "El servidor se ha cerrado por seguridad (3 intentos fallidos).",
        authPlaceholder: "Contraseña",
        authSubmit: "Entrar",
        multiInstanceWarn: "Más de 1 proceso en ejecución. Elija correctamente los puertos de conexión (normalmente el más alto).",
        multiInstanceMismatch: "El puerto web actual (%d) y el C++ seleccionado (%d) no corresponden al mismo índice (base+N). Compruebe que está en el backend y C++ correctos.",
        notLatestPortWarn: "Te has conectado a un backend que no es el más reciente. ¿Estás seguro de que es el tuyo?",
        backendUptimeMinutes: "Este backend lleva %d min ejecutándose.",
        suggestedPortPrefix: "El más reciente es el puerto",
        connectingToPortUser: "Te estás conectando al puerto %d del usuario %s.",
        suggestedPortLine: "En el %d está el puerto %d del usuario %s.",
        suggestedPortSuffixUser: " usuario %s.",
        suggestedPortPrefixBefore: "En el ",
        modeLabel: "Modo:",
        modeLive: "Live",
        modeOffline: "Análisis",
        offlineLoadLocal: "Cargar TSV local",
        offlineLoadServer: "Cargar",
        offlineRecordingLabel: "Grabación:",
        offlineNoRecordings: "(sin grabaciones)",
        offlineDatasetNone: "Sin archivo cargado",
        offlineDatasetLoaded: "Cargado:",
        offlineDatasetSafeMode: "Modo seguro",
        offlineDatasetLoading: "Cargando datos…",
        offlineDatasetLoadingFile: "Cargando archivo…",
        analyzePromptBtn: "Analizar este archivo",
        offlinePlaybackPlay: "▶ Play",
        offlinePlaybackPause: "⏸ Pause",
        statusOffline: "Modo análisis (offline)",
        statusReplay: "Modo replay",
        modeReplay: "Replay",
        sendFileOnFinishLabel: "Enviar fichero al terminar",
        recordPathLabel: "Guardado en:",
        advInfoLabel: "Adv info",
        docsTitle: "Abrir documentación completa (MkDocs)",
        docsModalTitle: "Documentación",
        docsModalChoose: "Elija el idioma. Se abrirá en una pestaña nueva.",
        docsLangEs: "Español",
        docsLangEn: "English",
        docsNotBuiltMsg: "No hay documentación generada. En la raíz del proyecto ejecute: mkdocs build  y  mkdocs build -f mkdocs.en.yml  luego reinicie el servidor.",
        fmtModeLabel: "Formato:",
        fmtModeOff: "Apagado",
        fmtModeUnits: "Unidades",
        fmtModeArinc: "ARINC",
        fmtOriShort: "Ori:",
        fmtSalShort: "Sal:",
        physBlockTitle: "Unidades físicas",
        convBlockTitle: "Conversión en monitor",
        convTypeLabel: "Tipo:",
        convTypeNumeric: "Base",
        physCatLabel: "Magnitud:",
        physCatNone: "— ninguna —",
        physCatLength: "Longitud",
        physCatMass: "Masa",
        physCatSpeed: "Velocidad",
        physCatDms: "Base hexa",
        physCatAngle: "Ángulo",
        physFromLabel: "Origen (valor SHM):",
        physToLabel: "Destino (monitor):",
        physHintNm: "Milla náutica (nm)",
    },
    en: {
        colBrowserTitle: "Available variables",
        colMonitorTitle: "Monitoring",
        colPlotTitle: "Plots",
        helpTitle: "Help",
        instanceLabel: "Instance:",
        pollLabel: "Rel act:",
        settingsTitle: "Settings",
        langLabel: "Language:",
        themeLabel: "Theme:",
        reconnectBtn: "Connect",
        reconnectTitle: "Reconnect with selected instance",
        recordBtn: "● REC",
        resetConfigTitle: "Delete all configuration",
        clearAlarmsTitle: "Clear all alarms",
        resetPlotsTitle: "Clear variable assignments from plots",
        resetPlotsBtn: "Clear",
        pausePlay: "▶ Play",
        pausePause: "⏸ Pause",
        screenshotTitle: "Capture plots as PNG",
        windowLabel: "Window:",
        bufferLabel: "Buffer:",
        bufferVisualLabel: "Visual buffer:",
        filterPlaceholder: "Filter variables...",
        selectAll: "Select all",
        selectNone: "None",
        addToMonitor: "+ Monitor",
        hideLevelsLabel: "Levels:",
        statusConnected: "Connected",
        statusDisconnected: "Disconnected",
        statusNoInstances: "No VarMonitor instances (UDS)",
        graphTitle: "Plot",
        plotPendingData: "Waiting for server data…",
        plotPendingHistory: "Loading series history…",
        newGraphDropText: "New plot: drop here to create one",
        removeGraphTitle: "Remove plot",
        monitorMenuTitle: "More options",
        monitorGridLinesLabel: "Show grid",
        monitorGridLinesTitle: "Cell borders around each variable (opaque fill so the panel grid does not show through).",
        timeAxisTitle: "t (s)",
        resetTimeBtn: "Reset time",
        resetTimeTitle: "Reset time origin and clear all graph history",
        smoothPlotsLabel: "Smooth",
        smoothPlotsTitle: "Moving average window for smoothing curves (1 = off)",
        smoothOff: "Off",
        smooth3: "Light (3)",
        smooth5: "Medium (5)",
        smooth7: "Strong (7)",
        smooth11: "Heavy (11)",
        authTitle: "Password",
        authPrompt: "The monitor requires a password to connect.",
        authWrongAttempts: "Wrong password. Attempts left: %d of 3.",
        authLastAttempt: "Last attempt. If it fails, the server will shut down for security.",
        authServerClosed: "The server has shut down for security (3 failed attempts).",
        authPlaceholder: "Password",
        authSubmit: "Enter",
        multiInstanceWarn: "More than 1 process running. Choose the correct connection ports (usually the highest).",
        multiInstanceMismatch: "Current web port (%d) and selected C++ port (%d) do not match the same instance (base+N). Ensure you are on the correct backend and C++.",
        notLatestPortWarn: "You have connected to a backend that is not the newest. Are you sure it is yours?",
        backendUptimeMinutes: "This backend has been running for %d min.",
        suggestedPortPrefix: "The newest is port",
        connectingToPortUser: "You are connecting to port %d of user %s.",
        suggestedPortLine: "On %d is port %d of user %s.",
        suggestedPortSuffixUser: " user %s.",
        suggestedPortPrefixBefore: "On ",
        modeLabel: "Mode:",
        modeLive: "Live",
        modeOffline: "Analysis",
        offlineLoadLocal: "Load local TSV",
        offlineLoadServer: "Load",
        offlineRecordingLabel: "Recording:",
        offlineNoRecordings: "(no recordings)",
        offlineDatasetNone: "No file loaded",
        offlineDatasetLoaded: "Loaded:",
        offlineDatasetSafeMode: "Safe mode",
        offlineDatasetLoading: "Loading data…",
        offlineDatasetLoadingFile: "Loading file…",
        analyzePromptBtn: "Analyze this file",
        offlinePlaybackPlay: "▶ Play",
        offlinePlaybackPause: "⏸ Pause",
        statusOffline: "Analysis mode (offline)",
        statusReplay: "Replay mode",
        modeReplay: "Replay",
        sendFileOnFinishLabel: "Send file when finished",
        recordPathLabel: "Saved at:",
        advInfoLabel: "Adv info",
        docsTitle: "Open full documentation (MkDocs)",
        docsModalTitle: "Documentation",
        docsModalChoose: "Choose a language. Opens in a new tab.",
        docsLangEs: "Spanish",
        docsLangEn: "English",
        docsNotBuiltMsg: "Documentation is not built. From the project root run: mkdocs build  and  mkdocs build -f mkdocs.en.yml  then restart the server.",
        fmtModeLabel: "Format:",
        fmtModeOff: "Off",
        fmtModeUnits: "Units",
        fmtModeArinc: "ARINC",
        fmtOriShort: "In:",
        fmtSalShort: "Out:",
        physBlockTitle: "Physical units",
        convBlockTitle: "Monitor conversion",
        convTypeLabel: "Type:",
        convTypeNumeric: "Base",
        physCatLabel: "Quantity:",
        physCatNone: "— none —",
        physCatLength: "Length",
        physCatMass: "Mass",
        physCatSpeed: "Speed",
        physCatDms: "Hex base",
        physCatAngle: "Angle",
        physFromLabel: "Source (SHM value):",
        physToLabel: "Display:",
        physHintNm: "Nautical mile (nm)",
    }
};

I18N.es.helpGuideTitle = "Guía de uso — VarMonitor";
I18N.es.helpGuideHtml = `
<p class="help-intro">VarMonitor muestra y, en vivo, modifica variables publicadas por tu aplicación C++. El backend Python usa <strong>SHM</strong> y <strong>UDS</strong> frente al proceso C++; el navegador habla con Python por HTTP/WebSocket. Hay <strong>tres modos</strong> (selector <strong>Modo</strong> en cabecera), cada uno con capacidades distintas.</p>

<h3 class="help-mode-title">1. Modo Live (tiempo real)</h3>
<ul>
<li><strong>Datos en vivo</strong>: WebSocket conectado; valores y gráficos se alimentan del C++ vía backend.</li>
<li><strong>Cabecera</strong>: instancia UDS (<code>/tmp/varmon-&lt;usuario&gt;-&lt;pid&gt;.sock</code>), <strong>Rel act</strong> (cada cuántos ciclos se envía <code>vars_update</code>), estado de conexión.</li>
<li><strong>Variables</strong>: botón <strong>+</strong> abre el cajón; lista <strong>plana</strong> por defecto; <strong>Agrupar</strong> muestra árbol (al activarlo, grupos colapsados por defecto). Arrastra al panel de monitor o usa <strong>+ Monitorizar</strong>.</li>
<li><strong>Monitorización</strong>: botón <strong>☰</strong> expande la barra del monitor con filtro, selección por lotes y ordenación. Doble clic en el valor para escribir en C++ (donde el tipo lo permita). Clic en el nombre: detalles (min/max, alarmas, generador, formato).</li>
<li><strong>Gráficos</strong>: arrastra variables a un gráfico. Sin gráficos, toda el área es zona de creación. Con gráficos: rejilla hasta <strong>3 columnas × 3 filas</strong> (9 gráficos). <strong>Nueva columna</strong> a la derecha; fila inferior <strong>Abajo C1/C2/C3</strong> añade fila en esa columna. Cada traza tiene color propio; el mismo color resalta la fila en monitorización.</li>
<li><strong>REC / snapshot / PNG</strong>, pausa de gráficos, buffer visual (ajustes), variables computadas <strong>fx+</strong>, exportar/importar JSON, alarmas y notificaciones del sistema.</li>
</ul>

<h3 class="help-mode-title">2. Modo Análisis (offline)</h3>
<ul>
<li><strong>Sin datos en vivo del C++</strong> para la sesión de análisis: trabajas sobre un <strong>TSV</strong> cargado (local o del servidor). No hay conexión WebSocket de datos en este modo.</li>
<li><strong>Carga y reproducción</strong>: barra temporal, velocidad, Play/Pausa. Flechas <strong>◀ / ▶</strong> junto a Suavizado: avance/retroceso <strong>muestra a muestra</strong>.</li>
<li><strong>Marcadores A y B</strong>: comparación entre instantes; la lista de monitor puede reordenarse por magnitud de cambio.</li>
<li><strong>Gráficos</strong>: mismas herramientas de zoom/pan; clic en la curva puede posicionar el tiempo en análisis.</li>
<li><strong>Opciones avanzadas</strong> (esquina inferior derecha de la zona de gráficos): anomalías, segmentos, notas, informe PDF, etc. (ocultas por defecto).</li>
</ul>

<h3 class="help-mode-title">3. Modo Replay (híbrido TSV + C++)</h3>
<ul>
<li><strong>WebSocket activo</strong> y además una <strong>grabación TSV de referencia</strong>: al entrar en Replay se limpia la referencia anterior; debes <strong>cargar el archivo manualmente</strong>.</li>
<li><strong>Listado de variables</strong>: unión de nombres del TSV y del catálogo del backend; etiqueta verde <strong>TSV</strong> en el navegador. Puedes buscar con la palabra <code>tsv</code> en los filtros donde esté soportado.</li>
<li><strong>Imposición</strong>: solo variables presentes en el TSV. Si marcas <strong>imponer</strong>, el valor se toma del TSV (con offsets Δt/Δv en el panel de detalles) y se bloquean actualizaciones SHM para esa señal en la vista. Si no impones, la variable se comporta como en Live.</li>
<li><strong>Gráficos</strong>: eje X acotado al rango temporal del TSV; opción de trazar frente a referencia donde aplique. Controles de monitor específicos (p. ej. ordenación “En TSV primero”) solo en Replay.</li>
</ul>

<h3 class="help-mode-title">Referencia común</h3>
<ul>
<li><strong>Atajos</strong>: Espacio (pausa gráficos), R (REC), S (captura PNG), H o ? (esta ayuda), Escape (cerrar).</li>
<li><strong>Arquitectura</strong>: C++ ↔ Python (UDS + SHM); navegador ↔ Python (HTTP + WebSocket en <code>web_port</code>).</li>
<li><strong>varmon.conf</strong>: p. ej. <code>web_port</code>. Ruta alternativa: <code>VARMON_CONFIG</code> o <code>varmon::set_config_path</code> en C++.</li>
<li><strong>Acceso remoto al navegador</strong>: <code>http://&lt;IP&gt;:&lt;web_port&gt;</code>. El binario C++ y el backend Python deben estar en la <strong>misma máquina</strong> (UDS/SHM locales).</li>
</ul>
<p class="help-footer"><a href="https://github.com/LorenzoAdr/RealTimeMonitor" target="_blank" rel="noopener noreferrer">VarMonitor en GitHub</a></p>
`;

I18N.en.helpGuideTitle = "User guide — VarMonitor";
I18N.en.helpGuideHtml = `
<p class="help-intro">VarMonitor displays and, in real time, edits variables published by your C++ application. The Python backend uses <strong>SHM</strong> and <strong>UDS</strong> to the C++ process; the browser talks to Python over HTTP/WebSocket. There are <strong>three modes</strong> (the <strong>Mode</strong> selector in the header), each with different capabilities.</p>

<h3 class="help-mode-title">1. Live mode</h3>
<ul>
<li><strong>Live data</strong>: WebSocket connected; values and plots are driven by the C++ process through the backend.</li>
<li><strong>Header</strong>: UDS instance (<code>/tmp/varmon-&lt;user&gt;-&lt;pid&gt;.sock</code>), <strong>Rel act</strong> (how often <code>vars_update</code> is sent), connection status.</li>
<li><strong>Variables</strong>: <strong>+</strong> opens the drawer; <strong>flat</strong> list by default; <strong>Group</strong> shows a tree (when enabled, groups start collapsed). Drag to the monitor column or use <strong>+ Monitor</strong>.</li>
<li><strong>Monitoring</strong>: <strong>☰</strong> expands the monitor header bar with filter, batch selection, and sorting. Double-click the value to write to C++ (where the type allows). Click the name for details (min/max, alarms, generator, format).</li>
<li><strong>Plots</strong>: drag variables onto a plot. With no plots, the whole area is a drop target. With plots: grid up to <strong>3 columns × 3 rows</strong> (9 plots). <strong>New column</strong> on the right; bottom row <strong>Below C1/C2/C3</strong> adds a row in that column. Each trace has its own color; the same color highlights the row in the monitor list.</li>
<li><strong>REC / snapshot / PNG</strong>, plot pause, visual buffer (settings), computed variables <strong>fx+</strong>, JSON export/import, alarms and system notifications.</li>
</ul>

<h3 class="help-mode-title">2. Analysis mode (offline)</h3>
<ul>
<li><strong>No live C++ stream</strong> for this session: you work from a loaded <strong>TSV</strong> (local or server). There is no WebSocket data connection in this mode.</li>
<li><strong>Load and playback</strong>: time scrubber, speed, Play/Pause. <strong>◀ / ▶</strong> next to Smoothing: step <strong>sample by sample</strong>.</li>
<li><strong>A and B markers</strong>: compare two instants; the monitor list can reorder by change magnitude.</li>
<li><strong>Plots</strong>: same zoom/pan tools; clicking the curve can seek time in analysis.</li>
<li><strong>Advanced options</strong> (bottom-right of the plot area): anomalies, segments, notes, PDF report, etc. (collapsed by default).</li>
</ul>

<h3 class="help-mode-title">3. Replay mode (TSV + C++ hybrid)</h3>
<ul>
<li><strong>WebSocket stays on</strong> plus a <strong>reference TSV</strong>: entering Replay clears the previous reference; you must <strong>load a file manually</strong>.</li>
<li><strong>Variable list</strong>: union of TSV names and backend catalog; green <strong>TSV</strong> badge in the browser. You can filter with the word <code>tsv</code> where supported.</li>
<li><strong>Imposition</strong>: only variables that exist in the TSV. If <strong>impose</strong> is checked, values come from the TSV (with Δt/Δv offsets in the detail panel) and SHM updates for that signal are blocked in the UI. If not imposed, the variable behaves like Live.</li>
<li><strong>Plots</strong>: X axis spans the TSV time range; optional plot vs reference where applicable. Replay-only monitor controls (e.g. “TSV first” sort).</li>
</ul>

<h3 class="help-mode-title">Common reference</h3>
<ul>
<li><strong>Shortcuts</strong>: Space (toggle plot pause), R (REC), S (PNG capture), H or ? (this help), Escape (close).</li>
<li><strong>Architecture</strong>: C++ ↔ Python (UDS + SHM); browser ↔ Python (HTTP + WebSocket on <code>web_port</code>).</li>
<li><strong>varmon.conf</strong>: e.g. <code>web_port</code>. Alternate path: <code>VARMON_CONFIG</code> or <code>varmon::set_config_path</code> in C++.</li>
<li><strong>Remote browser access</strong>: <code>http://&lt;IP&gt;:&lt;web_port&gt;</code>. The C++ binary and Python backend must run on the <strong>same host</strong> (local UDS/SHM).</li>
</ul>
<p class="help-footer"><a href="https://github.com/LorenzoAdr/RealTimeMonitor" target="_blank" rel="noopener noreferrer">VarMonitor on GitHub</a></p>
`;
    return I18N;
}
