/**
 * Guía del modal «?» (rama legacy): núcleo + solo módulos replay/alias/alarmas ref/anomalías/segmentos.
 */

/**
 * @param {"es"|"en"} lang
 * @param {(id: string) => boolean} hasPlugin
 * @param {{ hasAppMode?: (id: string) => boolean, listActivePlugins?: () => string[] }} [opts]
 */
export function buildHelpGuideHtml(lang, hasPlugin, opts = {}) {
    const listActivePlugins = typeof opts.listActivePlugins === "function" ? opts.listActivePlugins : () => [];
    const en = lang === "en";
    const H = en ? STR.en : STR.es;
    const parts = [];

    const roadmapSteps = [H.roadmap1, H.roadmap2, H.roadmap3];

    parts.push(`<section class="help-map-section" aria-label="${H.ariaMap}">
<p class="help-intro roadmap-intro">${H.mapIntro}</p>
<div class="roadmap-flow" aria-label="${H.ariaFlow}">
  <div class="roadmap-step"><span class="roadmap-num">1</span><span class="roadmap-label">${H.flow1Label}</span><span class="roadmap-hint">${H.flow1Hint}</span></div>
  <span class="roadmap-arrow" aria-hidden="true">→</span>
  <div class="roadmap-step"><span class="roadmap-num">2</span><span class="roadmap-label">${H.flow2Label}</span><span class="roadmap-hint">${H.flow2Hint}</span></div>
  <span class="roadmap-arrow" aria-hidden="true">→</span>
  <div class="roadmap-step"><span class="roadmap-num">3</span><span class="roadmap-label">${H.flow3Label}</span><span class="roadmap-hint">${H.flow3Hint}</span></div>
</div>
<h3 class="help-mode-title">${H.suggestedTitle}</h3>
<ol class="roadmap-list">
${roadmapSteps.map((t) => `  <li>${t}</li>`).join("\n")}
</ol>
<h3 class="help-mode-title">${H.headerBitsTitle}</h3>
<ul class="roadmap-mini">
${H.headerBits.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>
</section>
<hr class="help-roadmap-sep">
<p class="help-intro">${H.coreIntro}</p>`);

    parts.push(`<h3 class="help-mode-title">${H.hLive}</h3>
<ul>
${H.liveCore.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);

    parts.push(`<h4 class="help-subtitle">${H.hLiveReplayEmbed}</h4>
<ul>
${H.liveReplayEmbed.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);

    parts.push(`<h3 class="help-mode-title">${H.hAnalysis}</h3>
<ul>
${H.analysisCore.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);

    parts.push(`<h3 class="help-mode-title">${H.hReplay}</h3>
<ul>
${H.replayCore.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);

    if (hasPlugin("replay_alias")) {
        parts.push(`<h4 class="help-subtitle">${H.hReplayAlias}</h4>
<ul>
${H.replayAlias.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);
    }

    if (hasPlugin("replay_ref_alarms")) {
        parts.push(`<h4 class="help-subtitle">${H.hReplayRefAlarms}</h4>
<ul>
${H.replayRefAlarms.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);
    }

    if (hasPlugin("anomaly")) {
        parts.push(`<h4 class="help-subtitle">${H.hAnomaly}</h4>
<ul>
${H.anomaly.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);
    }

    if (hasPlugin("segments")) {
        parts.push(`<h4 class="help-subtitle">${H.hSegments}</h4>
<ul>
${H.segments.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);
    }

    parts.push(`<h3 class="help-mode-title">${H.hCommon}</h3>
<ul>
${H.common.map((t) => `  <li>${t}</li>`).join("\n")}
</ul>`);

    const ids = listActivePlugins().filter((id) =>
        ["replay_alias", "replay_ref_alarms", "anomaly", "segments"].includes(id),
    );
    if (ids.length > 0) {
        const lis = ids.map((id) => `  <li><code>${escapeHtml(id)}</code></li>`).join("\n");
        parts.push(`<section class="help-plugins-active" aria-label="${H.ariaPlugins}">
<h3 class="help-mode-title">${H.activePluginsTitle}</h3>
<p class="help-intro help-plugins-active-hint">${H.activePluginsHint}</p>
<ul class="help-plugin-id-list">
${lis}
</ul>
</section>`);
    }

    parts.push(`<p class="help-footer"><a href="https://github.com/LorenzoAdr/RealTimeMonitor" target="_blank" rel="noopener noreferrer">${H.github}</a></p>`);

    return parts.join("\n");
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const STR = {
    es: {
        ariaMap: "Mapa de la aplicación",
        ariaFlow: "Flujo de datos",
        ariaPlugins: "Extensiones activas",
        mapIntro:
            "Vista rápida del <strong>flujo de datos</strong> y del <strong>orden típico de uso</strong>. La documentación detallada (MkDocs) está en <strong>Docs</strong> en la cabecera.",
        flow1Label: "App C++",
        flow1Hint: "publica variables (SHM)",
        flow2Label: "Backend Python",
        flow2Hint: "UDS + lectura SHM",
        flow3Label: "Navegador",
        flow3Hint: "HTTP + WebSocket",
        suggestedTitle: "Recorrido sugerido",
        roadmap1: "<strong>Live</strong> — Elegir instancia UDS, explorar variables, monitorizar y graficar en tiempo real.",
        roadmap2: "<strong>Análisis</strong> — Cargar <strong>TSV</strong> (local o servidor), reproducir y analizar sin depender del ciclo en vivo.",
        roadmap3: "<strong>Replay</strong> — Referencia cargada + datos del backend; imposición y comparación con la grabación.",
        headerBitsTitle: "Cabecera útil",
        headerBits: [
            "<strong>Modo</strong> — Cambiar entre live, análisis y replay.",
            "<strong>Docs / Log / Perf</strong> — Documentación integrada, registro del servidor, telemetría de rendimiento.",
            "<strong>Ajustes</strong> — Plantillas de layout, instancia, idioma, tema, buffer visual y opciones avanzadas.",
        ],
        coreIntro:
            "VarMonitor muestra y, en vivo, puede modificar variables publicadas por tu aplicación C++. El backend Python usa <strong>memoria compartida (SHM)</strong> y <strong>socket Unix (UDS)</strong> frente al proceso C++; el navegador habla con Python por HTTP y WebSocket (puerto <code>web_port</code> en <code>varmon.conf</code>).",

        hLive: "1. Modo Live (tiempo real)",
        liveCore: [
            "<strong>Datos en vivo</strong>: con el WebSocket conectado, valores y gráficos se alimentan del proceso C++ vía backend.",
            "<strong>Cabecera</strong>: selector de instancia UDS, <strong>Rel act</strong>, estado de conexión y controles de grabación.",
            "<strong>Variables</strong>: el botón <strong>+</strong> abre el cajón; lista plana o agrupada. Arrastra a la columna monitor o usa <strong>+ Monitorizar</strong>.",
            "<strong>Gráficos</strong>: arrastra variables a un gráfico; rejilla hasta 3×3; colores enlazados al monitor.",
            "<strong>REC</strong>, snapshot, <strong>PNG</strong>, pausa de gráficos, buffer visual, variables computadas, exportar/importar layout JSON.",
        ],
        hLiveReplayEmbed: "Replay en vivo (referencia + SHM)",
        liveReplayEmbed: [
            "Botón de <strong>replay en vivo</strong>: carga una grabación de referencia, imposición de columnas, <strong>alias</strong> si los activa el flujo de replay, <strong>alarmas frente a referencia</strong> y tabla de muestras.",
            "Chip <strong>Grafic replay</strong> en cabecera de gráficos para mezclar referencia con datos en vivo.",
        ],
        hAnalysis: "2. Modo Análisis (offline)",
        analysisCore: [
            "<strong>Sin stream en vivo del C++</strong>: trabaja sobre un fichero <strong>TSV</strong> cargado.",
            "<strong>Carga y reproducción</strong>: barra temporal, velocidad, Play/Pausa; avance muestra a muestra.",
            "<strong>Marcadores A y B</strong> para comparar instantes.",
            "<strong>Gráficos</strong>: zoom, pan; panel avanzado con <strong>anomalías</strong> y <strong>segmentos</strong> cuando correspondan.",
        ],
        hReplay: "3. Modo Replay (híbrido TSV + C++)",
        replayCore: [
            "<strong>WebSocket activo</strong> y <strong>grabación de referencia</strong>; al entrar en Replay debe cargarse el fichero.",
            "<strong>Imposición</strong>: valores desde el TSV de referencia donde aplique.",
            "<strong>Gráficos</strong>: eje X acotado al rango temporal de la referencia.",
        ],
        hReplayAlias: "Alias de columnas",
        replayAlias: [
            "Asigna columnas del TSV a <strong>nombres canónicos</strong> del monitor; perfiles reutilizables y comprobación de diferencias.",
        ],
        hReplayRefAlarms: "Alarmas vs referencia en replay",
        replayRefAlarms: [
            "Comparan señal en vivo con la referencia en el mismo instante (|live−ref|).",
        ],
        hAnomaly: "Detección de anomalías",
        anomaly: ["Reglas de salto, umbrales y rachas sobre series en análisis."],
        hSegments: "Segmentos",
        segments: ["Define tramos en la línea de tiempo y compáralos entre sesiones."],
        hCommon: "Referencia común",
        common: [
            "<strong>Atajos</strong>: Espacio (pausa de gráficos), R (REC), S (PNG), H o ? (esta ayuda), Escape (cerrar modales).",
            "<strong>Arquitectura</strong>: C++ ↔ Python (UDS + SHM); navegador ↔ Python (HTTP + WebSocket).",
            "<strong>varmon.conf</strong>: clave <code>web_port</code>; variable <code>VARMON_CONFIG</code> opcional.",
        ],
        activePluginsTitle: "Extensiones de análisis/replay activas",
        activePluginsHint: "Solo se listan ids admitidos en esta entrega (replay, alias, alarmas de referencia, anomalías, segmentos).",
        github: "VarMonitor en GitHub",
    },
    en: {
        ariaMap: "Application map",
        ariaFlow: "Data flow",
        ariaPlugins: "Active extensions",
        mapIntro:
            "Quick view of the <strong>data flow</strong> and <strong>typical usage order</strong>. Full documentation is under <strong>Docs</strong> in the header.",
        flow1Label: "C++ app",
        flow1Hint: "publishes vars (SHM)",
        flow2Label: "Python backend",
        flow2Hint: "UDS + SHM read",
        flow3Label: "Browser",
        flow3Hint: "HTTP + WebSocket",
        suggestedTitle: "Suggested path",
        roadmap1: "<strong>Live</strong> — Pick the UDS instance, browse variables, monitor and plot in real time.",
        roadmap2: "<strong>Analysis</strong> — Load a <strong>TSV</strong> file (local or server), playback without the live loop.",
        roadmap3: "<strong>Replay</strong> — Reference recording plus backend stream; impose and compare.",
        headerBitsTitle: "Header shortcuts",
        headerBits: [
            "<strong>Mode</strong> — Switch between live, analysis, and replay.",
            "<strong>Docs / Log / Perf</strong> — Embedded docs, server log, performance telemetry.",
            "<strong>Settings</strong> — Layout templates, instance, language, theme, visual buffer, advanced options.",
        ],
        coreIntro:
            "VarMonitor displays and can edit variables from your C++ app in real time. The Python backend uses <strong>shared memory (SHM)</strong> and a <strong>Unix domain socket (UDS)</strong>; the browser uses HTTP and WebSocket (<code>web_port</code> in <code>varmon.conf</code>).",

        hLive: "1. Live mode",
        liveCore: [
            "<strong>Live data</strong> via WebSocket from the C++ process through the backend.",
            "<strong>Header</strong>: UDS instance, <strong>Rel act</strong>, connection status, recording controls.",
            "<strong>Variables</strong>: <strong>+</strong> opens the drawer; flat or grouped list; drag to monitor column.",
            "<strong>Plots</strong>: drag variables; up to a 3×3 grid; colours tied to the monitor.",
            "<strong>REC</strong>, snapshot, <strong>PNG</strong>, plot pause, visual buffer, computed vars, layout JSON.",
        ],
        hLiveReplayEmbed: "Live replay (reference + SHM)",
        liveReplayEmbed: [
            "<strong>Live replay</strong> loads a reference recording, column imposition, <strong>aliases</strong>, <strong>reference alarms</strong>, sample table.",
            "<strong>Graphic replay</strong> chip mixes reference series with live data.",
        ],
        hAnalysis: "2. Analysis mode (offline)",
        analysisCore: [
            "<strong>No live C++ stream</strong>: work from a loaded <strong>TSV</strong> file.",
            "<strong>Playback</strong>: scrubber, speed, Play/Pause; step sample-by-sample.",
            "<strong>A and B markers</strong> to compare instants.",
            "<strong>Advanced panel</strong>: <strong>anomalies</strong> and <strong>segments</strong> where applicable.",
        ],
        hReplay: "3. Replay mode (TSV + C++ hybrid)",
        replayCore: [
            "<strong>WebSocket on</strong> plus a <strong>reference recording</strong>; reload the file when entering Replay.",
            "<strong>Imposition</strong> from the reference TSV where applicable.",
            "<strong>Plots</strong>: X axis spans the reference time range.",
        ],
        hReplayAlias: "Column aliases",
        replayAlias: [
            "Map TSV columns to <strong>canonical monitor names</strong>; reusable profiles and diff views.",
        ],
        hReplayRefAlarms: "Replay reference alarms",
        replayRefAlarms: ["Compare live signal to the reference at the same time (|live−ref|)."],
        hAnomaly: "Anomaly detection",
        anomaly: ["Jump rules, thresholds, runs on analysis series."],
        hSegments: "Segments",
        segments: ["Define timeline segments and compare across sessions."],
        hCommon: "Common reference",
        common: [
            "<strong>Shortcuts</strong>: Space (plot pause), R (REC), S (PNG), H or ? (help), Escape (close modals).",
            "<strong>Architecture</strong>: C++ ↔ Python (UDS + SHM); browser ↔ Python (HTTP + WebSocket).",
            "<strong>varmon.conf</strong>: <code>web_port</code>; optional <code>VARMON_CONFIG</code>.",
        ],
        activePluginsTitle: "Analysis/replay extensions active",
        activePluginsHint: "Only ids supported in this build (replay, alias, reference alarms, anomalies, segments).",
        github: "VarMonitor on GitHub",
    },
};
