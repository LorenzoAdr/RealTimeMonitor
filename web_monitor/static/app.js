(function () {
    "use strict";

    const GRAPH_ACCENT = [
        "#6c8cff", "#4ade80", "#fb923c", "#f472b6",
        "#a78bfa", "#fbbf24", "#2dd4bf", "#f87171",
    ];
    const TRACE_COLORS = [
        "#6c8cff", "#f87171", "#4ade80", "#fbbf24", "#f472b6",
        "#38bdf8", "#fb923c", "#a78bfa", "#34d399", "#f97316",
        "#e879f9", "#22d3ee", "#facc15", "#818cf8", "#fb7185",
    ];
    const MAX_GRAPH_COLUMNS = 3;
    const MAX_GRAPH_ROWS = 3;
    const MAX_GRAPHS = MAX_GRAPH_COLUMNS * MAX_GRAPH_ROWS;
    const DEFAULT_OFFLINE_FULL_LOAD_MAX_MB = 40;
    const DEFAULT_OFFLINE_PREVIEW_MB = 2;
    const DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_ROWS = 10000;
    const DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_SPAN_SEC = 45;

    let ws = null;
    let appMode = "live"; // live | offline | replay
    let varsByName = {};
    let baseKnownVarNames = [];
    let knownVarNames = [];
    let monitoredNames = new Set();
    /** Orden de visualización de variables monitorizadas (permite reordenar por drag-and-drop) */
    let monitoredOrder = [];
    /** Filtro de texto en la columna de monitorización (solo muestra filas cuyo nombre coincida). */
    let monitorFilterText = "";
    /** Preselección para acciones por lote: arrastrar una al gráfico asigna todas; cruz elimina todas. */
    let monitorSelectedNames = new Set();
    /** En modo replay: variables marcadas para imposición a SHM (checkboxes; lógica de escritura en fases posteriores). */
    let impositionNames = new Set();
    /** Offset temporal (s) y numérico por variable para imposición en replay. */
    let impositionTimeOffset = {};
    let impositionValueOffset = {};
    /** En replay: graficar variables frente a la ref (eje Y relativo). */
    let plotVsRef = false;
    /** Nombres de variables que están en el TSV cargado (scalares y bases de array); vacío si no hay dataset. */
    let varNamesInTsv = new Set();
    let varGraphAssignment = {};
    let seriesColorByName = {};
    let seriesHueByName = {};
    let historyCache = {};
    let graphList = [];
    let graphColumns = [];
    let plotInstances = {};

    let arrayElemAssignment = {};
    let arrayElemHistory = {};
    const ARRAY_HIST_MAX = 2000;

    let plotRafPending = false;
    let localHistMaxSec = 30;
    /** Origen de tiempo compartido para todos los gráficos (segundos Unix). Se fija con el primer historial recibido. */
    let sessionStartTime = null;

    const MAX_RECORD_SEC = 300;
    let isRecording = false;
    let isLocalRecording = false;
    let localRecordSamples = [];
    let recordBuffer = [];
    let recordColumns = [];
    let recordStartTime = null;
    let recordTimerInterval = null;
    let recordStopFallbackTimer = null;
    let recordSizeBytes = 0;
    let isRecordingStopping = false;
    let pendingRecordingRestart = false;

    let savedInstance = ""; // instancia UDS preferida (guardada/cargada en config)
    const statusEl = document.getElementById("connectionStatus");
    const varCountEl = document.getElementById("varCount");
    const intervalInput = document.getElementById("intervalInput");
    const portSelect = document.getElementById("portSelect");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const modeSelect = document.getElementById("modeSelect");
    const offlineControls = document.getElementById("offlineControls");
    const loadLocalTsvBtn = document.getElementById("loadLocalTsvBtn");
    const localTsvInput = document.getElementById("localTsvInput");
    const recordingSelect = document.getElementById("recordingSelectA");
    const loadServerRecordingBtn = document.getElementById("loadServerRecordingBtn");
    const setMarkerABtn = document.getElementById("setMarkerABtn");
    const setMarkerBBtn = document.getElementById("setMarkerBBtn");
    const clearMarkersBtn = document.getElementById("clearMarkersBtn");
    const markerInfoLabel = document.getElementById("markerInfoLabel");
    const anomalyPanel = document.getElementById("anomalyPanel");
    const toggleAdvancedPlotBtn = document.getElementById("toggleAdvancedPlotBtn");
    const anomalyJumpInput = document.getElementById("anomalyJumpInput");
    const anomalyLoInput = document.getElementById("anomalyLoInput");
    const anomalyHiInput = document.getElementById("anomalyHiInput");
    const runAnomalyScanBtn = document.getElementById("runAnomalyScanBtn");
    const clearAnomalyScanBtn = document.getElementById("clearAnomalyScanBtn");
    const anomalyListEl = document.getElementById("anomalyList");
    const notesListEl = document.getElementById("notesList");
    const prevEventBtn = document.getElementById("prevEventBtn");
    const nextEventBtn = document.getElementById("nextEventBtn");
    const addNoteBtn = document.getElementById("addNoteBtn");
    const exportPdfReportBtn = document.getElementById("exportPdfReportBtn");
    const segStartBtn = document.getElementById("segStartBtn");
    const segEndBtn = document.getElementById("segEndBtn");
    const segSaveBtn = document.getElementById("segSaveBtn");
    const segCutBtn = document.getElementById("segCutBtn");
    const segmentSelectEl = document.getElementById("segmentSelect");
    const segmentGoBtn = document.getElementById("segmentGoBtn");
    const downsampleMaxPointsInput = document.getElementById("downsampleMaxPointsInput");
    const arincBusHealthPanel = document.getElementById("arincBusHealthPanel");
    const offlineDatasetStatus = document.getElementById("offlineDatasetStatus");
    const varFilter = document.getElementById("varFilter");
    const varBrowserList = document.getElementById("varBrowserList");
    const addToMonitorBtn = document.getElementById("addToMonitor");
    const selectAllBtn = document.getElementById("selectAll");
    const selectNoneBtn = document.getElementById("selectNone");
    const refreshNamesBtn = document.getElementById("refreshNames");
    const monitorListEl = document.getElementById("monitorList");
    const monitorFilterInput = document.getElementById("monitorFilterInput");
    const monitorSelectAllBtn = document.getElementById("monitorSelectAllBtn");
    const monitorDeselectAllBtn = document.getElementById("monitorDeselectAllBtn");
    const monitorSortSep = document.getElementById("monitorSortSep");
    const monitorSortByNameBtn = document.getElementById("monitorSortByNameBtn");
    const monitorSortByGraphBtn = document.getElementById("monitorSortByGraphBtn");
    const monitorSortByTsvBtn = document.getElementById("monitorSortByTsvBtn");
    const timeWindowSelect = document.getElementById("timeWindow");
    const plotEmpty = document.getElementById("plotEmpty");
    const plotArea = document.getElementById("plotArea");
    const recordBtn = document.getElementById("recordBtn");
    const localRecordBtn = document.getElementById("localRecordBtn");
    const recordTimerEl = document.getElementById("recordTimer");
    const screenshotBtn = document.getElementById("screenshotBtn");
    const resetPlotsBtn = document.getElementById("resetPlotsBtn");
    const resetTimeBtn = document.getElementById("resetTimeBtn");
    const offlineStepPrevBtn = document.getElementById("offlineStepPrevBtn");
    const offlineStepNextBtn = document.getElementById("offlineStepNextBtn");
    const pauseBtn = document.getElementById("pauseBtn");
    const offlinePlaybackControls = document.getElementById("offlinePlaybackControls");
    const offlinePlayPauseBtn = document.getElementById("offlinePlayPauseBtn");
    const offlineScrubber = document.getElementById("offlineScrubber");
    const offlineSpeedSelect = document.getElementById("offlineSpeedSelect");
    const offlineTimeLabel = document.getElementById("offlineTimeLabel");
    const resetConfigBtn = document.getElementById("resetConfigBtn");
    const hideLevelsInput = document.getElementById("hideLevelsInput");
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsPanel = document.getElementById("settingsPanel");
    const alarmPanel = document.getElementById("alarmPanel");
    const multiInstanceWarningEl = document.getElementById("multiInstanceWarning");
    const multiInstanceWarningText = document.getElementById("multiInstanceWarningText");
    const multiInstanceWarningSuggestedWrap = document.getElementById("multiInstanceWarningSuggestedWrap");
    const multiInstanceWarningSuggestedPrefix = document.getElementById("multiInstanceWarningSuggestedPrefix");
    const multiInstanceWarningLink = document.getElementById("multiInstanceWarningLink");
    const langSelect = document.getElementById("langSelect");
    const themeSelect = document.getElementById("themeSelect");
    const authOverlay = document.getElementById("authOverlay");
    const authPasswordInput = document.getElementById("authPasswordInput");
    const authSubmitBtn = document.getElementById("authSubmitBtn");
    const advInfoCheckbox = document.getElementById("advInfoCheckbox");
    const advancedStatsStrip = document.getElementById("advancedStatsStrip");
    const advRamHtml = document.getElementById("advRamHtml");
    const advRamPython = document.getElementById("advRamPython");
    const advRamCpp = document.getElementById("advRamCpp");
    const advCpuPython = document.getElementById("advCpuPython");
    const advCpuCpp = document.getElementById("advCpuCpp");
    const advNetMbMsg = document.getElementById("advNetMbMsg");
    const advNetMsgS = document.getElementById("advNetMsgS");
    const advNetMbS = document.getElementById("advNetMbS");
    const advInfoLabel = document.getElementById("advInfoLabel");
    const sendFileOnFinishCheckbox = document.getElementById("sendFileOnFinishCheckbox");
    const recordPathAnalyzeBtn = document.getElementById("recordPathAnalyzeBtn");
    const monitorResizeHandle = document.getElementById("monitorResizeHandle");
    const compactMonitorSlider = document.getElementById("compactMonitorSlider");
    const adaptiveLoadCheckbox = document.getElementById("adaptiveLoadCheckbox");
    const layoutUndoBtn = document.getElementById("layoutUndoBtn");
    const layoutRedoBtn = document.getElementById("layoutRedoBtn");
    const dashboardTemplateSelect = document.getElementById("dashboardTemplateSelect");
    const templateSaveBtn = document.getElementById("templateSaveBtn");
    const templateLoadBtn = document.getElementById("templateLoadBtn");
    const snapshotFramesInput = document.getElementById("snapshotFramesInput");
    const offlineFullLoadMaxMbInput = document.getElementById("offlineFullLoadMaxMbInput");
    const offlinePreviewMbInput = document.getElementById("offlinePreviewMbInput");
    const offlinePreviewRowsInput = document.getElementById("offlinePreviewRowsInput");
    const offlinePreviewSpanSecInput = document.getElementById("offlinePreviewSpanSecInput");
    const offlineAllowForceFullLoadCheckbox = document.getElementById("offlineAllowForceFullLoadCheckbox");
    const snapshotBtn = document.getElementById("snapshotBtn");
    const adminStorageBtn = document.getElementById("adminStorageBtn");
    const adminStorageOverlay = document.getElementById("adminStorageOverlay");
    const remoteFileBrowserOverlay = document.getElementById("remoteFileBrowserOverlay");
    const remoteFileListOverlay = document.getElementById("remoteFileListOverlay");
    const remoteBrowserOverlayPathInput = document.getElementById("remoteBrowserOverlayPathInput");
    const remoteBrowserOverlayUpBtn = document.getElementById("remoteBrowserOverlayUpBtn");
    const remoteBrowserOverlayMkdirBtn = document.getElementById("remoteBrowserOverlayMkdirBtn");
    const remoteBrowserOverlayCloseBtn = document.getElementById("remoteBrowserOverlayCloseBtn");
    const openRemoteBrowserForAnalysisBtn = document.getElementById("openRemoteBrowserForAnalysisBtn");
    const adminConfigPathBrowseBtn = document.getElementById("adminConfigPathBrowseBtn");
    const adminRecordingsPathBrowseBtn = document.getElementById("adminRecordingsPathBrowseBtn");
    const adminStatePathBrowseBtn = document.getElementById("adminStatePathBrowseBtn");
    const adminStorageCloseBtn = document.getElementById("adminStorageCloseBtn");
    const adminConfigPath = document.getElementById("adminConfigPath");
    const adminRecordingsPath = document.getElementById("adminRecordingsPath");
    const adminStatePath = document.getElementById("adminStatePath");
    const adminBasePortInput = document.getElementById("adminBasePortInput");
    const adminPortRangeInput = document.getElementById("adminPortRangeInput");
    const adminApplyRuntimeBtn = document.getElementById("adminApplyRuntimeBtn");
    const adminDeleteAllRecordingsBtn = document.getElementById("adminDeleteAllRecordingsBtn");
    const adminDeleteAllTemplatesBtn = document.getElementById("adminDeleteAllTemplatesBtn");
    const adminRecordingsList = document.getElementById("adminRecordingsList");
    const adminTemplatesList = document.getElementById("adminTemplatesList");
    const expandAllMonBtn = document.getElementById("expandAllMonBtn");
    const collapseAllMonBtn = document.getElementById("collapseAllMonBtn");
    const monitorLoadingIndicator = document.getElementById("monitorLoadingIndicator");
    const offlineWindowSpanInput = document.getElementById("offlineWindowSpanInput");
    const offlineSafeModeBadge = document.getElementById("offlineSafeModeBadge");
    const defaultVisualBufferInput = document.getElementById("defaultVisualBufferInput");
    const segStartLabel = document.getElementById("segStartLabel");
    const segEndLabel = document.getElementById("segEndLabel");
    const advUiRenderMs = document.getElementById("advUiRenderMs");
    const advUiFps = document.getElementById("advUiFps");
    const advUiPts = document.getElementById("advUiPts");
    const advShmCycle = document.getElementById("advShmCycle");

    const ADV_INFO_STORAGE_KEY = "varmon_adv_info";
    const SEND_FILE_ON_FINISH_KEY = "varmon_send_file_on_finish";
    const WS_BUFFER_MAX_AGE_MS = 10000;
    let advStatsPollInterval = null;
    const wsMessageBuffer = [];

    let lastConnectionError = null;

    if (offlineWindowSpanInput) {
        offlineWindowSpanInput.addEventListener("change", () => {
            const v = Number(offlineWindowSpanInput.value);
            if (!Number.isFinite(v) || v <= 0) return;
            WINDOW_SPAN_SEC = Math.max(1, Math.min(20, v));
        });
    }

    if (defaultVisualBufferInput && timeWindowSelect) {
        defaultVisualBufferInput.addEventListener("change", () => {
            const v = Number(defaultVisualBufferInput.value);
            if (!Number.isFinite(v) || v <= 0) return;
            let closest = timeWindowSelect.options[0]?.value || "10";
            let bestDiff = Infinity;
            for (let i = 0; i < timeWindowSelect.options.length; i++) {
                const opt = timeWindowSelect.options[i];
                const val = Number(opt.value);
                if (!Number.isFinite(val) || val <= 0) continue;
                const d = Math.abs(val - v);
                if (d < bestDiff) {
                    bestDiff = d;
                    closest = opt.value;
                }
            }
            timeWindowSelect.value = closest;
            const sec = parseInt(closest, 10);
            localHistMaxSec = (Number.isFinite(sec) && sec > 0) ? sec : 60;
            if (isLiveMode()) trimLocalHistory();
            saveConfig();
            schedulePlotRender();
        });
    }

    if (offlineSafeModeBadge) {
        offlineSafeModeBadge.addEventListener("click", async () => {
            if (!offlineRecordingName || !offlineSafetyInfo || !offlineSafetyInfo.safeMode) return;
            const ok = window.confirm("Salir de modo seguro y cargar el archivo completo (también se descargará localmente)?");
            if (!ok) return;
            try {
                const filename = offlineRecordingName;
                const url = "/api/recordings/" + encodeURIComponent(filename);
                const resp = await fetch(url);
                if (!resp.ok) {
                    alert("No se pudo descargar la grabación completa.");
                    return;
                }
                const text = await resp.text();
                // Disparar descarga local del TSV completo.
                try {
                    const blob = new Blob([text], { type: "text/tab-separated-values" });
                    const dlUrl = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = dlUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(dlUrl);
                } catch (e) {
                    console.warn("No se pudo iniciar descarga automática del TSV:", e);
                }
                // Entrar en análisis normal con el archivo completo (sin modo seguro).
                const dsFull = parseTsvDataset(text, filename);
                await loadOfflineDataset(dsFull, { recordingName: filename, safeInfo: null, preserveLayout: true });
            } catch (e) {
                console.error("Error saliendo de modo seguro:", e);
                alert("Error al salir de modo seguro y cargar el archivo completo.");
            }
        });
    }

    let browserSelection = new Set();
    let browserListDirty = true;
    let plotsPaused = false;
    let alarms = {};
    let activeAlarms = new Set();
    let prevAlarmState = {};
    let alarmPendingSince = {};
    let hideLevels = 0;
    let lastAutoTsvTime = 0;
    const AUTO_TSV_COOLDOWN_MS = 10000;
    const AUTO_TSV_HISTORY_SEC = 10;
    const AUTO_TSV_DELAY_MS = 1000;
    let expandedStats = new Set();
    let activeGenerators = {};
    let pendingGeneratorRestore = [];
    const GEN_RATE_MS = 50;
    let computedVars = [];
    let computedHistories = {};
    const COMPUTED_MAX_HISTORY = 1000;
    let varFormat = {};  // { name: { ori: "dec", sal: "dec" } }
    let currentLang = "es";
    let currentTheme = "dark";
    let monitorColumnsCount = 1;
    let monitorPaneWidthPx = null;
    let sharedZoomXRange = null; // [min, max] en tiempo relativo para todos los gráficos
    let syncingSharedZoom = false;
    let pendingSharedZoomSync = null;
    let pendingSharedZoomAutorange = false;
    let sharedZoomSyncTimer = null;
    let offlineDataset = null; // Run A
    let offlineRecordingName = "";
    // Referencia global de tiempo para la grabación offline actual (no se resetea por tramo).
    let offlineRecordingGlobalMinTs = null;
    let offlineRecordingGlobalMaxTs = null;
    // Offset acumulado (en segundos) aplicado a los tramos sucesivos de una misma
    // grabación grande en modo seguro (Fase 1). Cada tramo nuevo se desplaza en
    // tiempo para que el eje X sea continuo (0..N) aunque solo tengamos un
    // segmento cargado en memoria.
    let offlineSegmentOffsetSec = 0;
    let markerA = null;
    let markerB = null;
    let deltaByName = {};
    let anomalyResults = [];
    let eventCursorIndex = -1;
    let notesByTs = [];
    let segmentDraft = { start: null, end: null };
    let offlineSegments = [];
    let advancedPlotOpen = false;
    let compactMonitorLevel = 0;
    let adaptiveLoadEnabled = true;
    let downsampleMaxPoints = 2000;
    let renderStats = { lastMs: 0, avgMs: 0, fps: 0, traces: 0, points: 0, ticks: 0, lastTick: 0 };
    let nextAllowedRenderAt = 0;
    let layoutHistoryPast = [];
    let layoutHistoryFuture = [];
    let applyingLayoutHistory = false;
    let lastLayoutSnapshot = "";
    let browserVirtualEnabled = false;
    let browserVirtualRowPx = 24;
    let browserVirtualOverscan = 10;
    let browserVirtualRows = [];
    let arincBusHealth = { totalWords: 0, parityErrors: 0, ssmErrors: 0, unknownLabels: 0, labels: {}, parityByLabel: {}, unknownByLabel: {} };
    let offlineSafetyInfo = null;
    let recordingsMetaByName = new Map();
    // Historial completo por variable en análisis offline; se mantiene al cambiar de tramo
    // dentro de la misma grabación.
    let fullHistoryByName = {};
    let offlineFullLoadMaxMb = DEFAULT_OFFLINE_FULL_LOAD_MAX_MB;
    let offlinePreviewMb = DEFAULT_OFFLINE_PREVIEW_MB;
    let offlineSafePreviewMaxRows = DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_ROWS;
    let offlineSafePreviewMaxSpanSec = DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_SPAN_SEC;
    let offlineAllowForceFullLoad = false;

    const ARINC_SUFFIXES = ["label", "sdi", "data", "ssm", "parity", "value"];

    // Historial completo por variable (modo análisis offline).
    const fullHistoryPending = new Set();

    async function fetchFullHistoryIfNeeded(varName) {
        if (!isPlaybackMode()) return;
        if (!offlineRecordingName) return;
        const key = String(varName || "");
        if (!key) return;
        // En replay híbrido, una variable TSV no impuesta no debe usar histórico TSV.
        if (isReplayMode() && isVarInTsv(key) && !impositionNames.has(key)) {
            delete historyCache[key];
            delete fullHistoryByName[key];
            schedulePlotRender();
            return;
        }
        if (fullHistoryPending.has(key)) return;
        fullHistoryPending.add(key);
        try {
            const resp = await fetch(
                `/api/recordings/${encodeURIComponent(offlineRecordingName)}/history?` +
                new URLSearchParams({ var: key }).toString()
            );
            if (!resp.ok) return;
            const data = await resp.json();
            const ts = Array.isArray(data.timestamps) ? data.timestamps : [];
            const vals = Array.isArray(data.values) ? data.values : [];
            if (ts.length === 0 || vals.length === 0 || ts.length !== vals.length) return;
            const hist = { timestamps: ts, values: vals };
            historyCache[key] = hist;
            fullHistoryByName[key] = hist;
            schedulePlotRender();
        } catch (e) {
            // Silencioso: si falla, seguimos con el tramo actual.
        } finally {
            fullHistoryPending.delete(key);
        }
    }

    function restoreFullHistoriesForPlottedVars() {
        if (!isPlaybackMode()) return;
        if (!fullHistoryByName || typeof fullHistoryByName !== "object") return;
        if (!Array.isArray(graphList) || graphList.length === 0) return;
        for (const gid of graphList) {
            const varsInGraph = getVarsForGraph(gid);
            for (const name of varsInGraph) {
                if (!name || isArrayElem(name)) continue;
                const full = fullHistoryByName[name];
                if (full && Array.isArray(full.timestamps) && Array.isArray(full.values) && full.timestamps.length > 1 && full.values.length === full.timestamps.length) {
                    historyCache[name] = full;
                }
            }
        }
    }

    async function fetchWindowHistoryBatch(names, centerTs) {
        if (!isPlaybackMode() || !offlineRecordingName) return;
        const cleanNames = (names || []).map((n) => String(n || "")).filter((n) => n);
        if (cleanNames.length === 0) return;
        const span = WINDOW_SPAN_SEC;
        cleanNames.forEach((key) => {
            const meta = windowMetaByName[key] || {};
            windowMetaByName[key] = { center: centerTs, span: meta.span || span };
        });
        try {
            windowFetchInFlight++;
            windowFetchLastStart = performance.now();
            const params = new URLSearchParams({
                vars: cleanNames.join(","),
                t_center: String(centerTs),
                t_span: String(span),
            });
            const resp = await fetch(
                `/api/recordings/${encodeURIComponent(offlineRecordingName)}/window_batch?` + params.toString()
            );
            if (!resp.ok) return;
            const data = await resp.json();
            const series = Array.isArray(data.series) ? data.series : [];
            for (let i = 0; i < series.length; i++) {
                const s = series[i];
                const name = String(s.name || "");
                if (!name) continue;
                if (isReplayMode() && isVarInTsv(name) && !impositionNames.has(name)) {
                    delete historyCache[name];
                    continue;
                }
                const ts = Array.isArray(s.timestamps) ? s.timestamps : [];
                const vals = Array.isArray(s.values) ? s.values : [];
                if (ts.length === 0 || vals.length === 0 || ts.length !== vals.length) continue;
                historyCache[name] = { timestamps: ts, values: vals };
            }
            if (series.length > 0) {
                schedulePlotRender();
            }
        } catch (e) {
            // Silencioso
        } finally {
            windowFetchInFlight = Math.max(0, windowFetchInFlight - 1);
        }
    }

    function scheduleWindowFetchAroundTime(centerTs) {
        // Ventanas cortas solo tienen sentido en modo seguro (grabaciones grandes).
        if (!isPlaybackMode() || !offlineDataset || !offlineSafetyInfo || !offlineSafetyInfo.safeMode) return;
        if (!Number.isFinite(centerTs)) return;

        const runFetch = () => {
            const tNow = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : centerTs;
            const batchNames = [];
            for (const name of monitoredNames) {
                if (isArrayElem(name)) continue;
                if (isReplayMode() && isVarInTsv(name) && !impositionNames.has(name)) continue;
                // Si la variable está ploteada y ya tiene histórico completo, no pedimos ventana corta.
                const assigned = varGraphAssignment[name] || "";
                if (assigned && fullHistoryByName[name]) continue;
                const meta = windowMetaByName[name];
                const span = (meta && meta.span) || WINDOW_SPAN_SEC;
                const lastCenter = meta && Number.isFinite(meta.center) ? meta.center : null;
                if (lastCenter !== null) {
                    const threshold = span * WINDOW_REQUERY_FRACTION;
                    if (Math.abs(tNow - lastCenter) < threshold) continue;
                }
                batchNames.push(name);
            }
            if (batchNames.length > 0) fetchWindowHistoryBatch(batchNames, tNow);
        };

        // Si estamos en Play, no usamos debounce: las ventanas deben seguir al tiempo en movimiento.
        if (offlinePlayback.isPlaying) {
            runFetch();
            return;
        }

        // Movimiento manual (scrubber / click): usar debounce para no spamear.
        if (windowFetchDebounceTimer) {
            clearTimeout(windowFetchDebounceTimer);
            windowFetchDebounceTimer = null;
        }
        windowFetchDebounceTimer = setTimeout(() => {
            windowFetchDebounceTimer = null;
            runFetch();
        }, 250);
    }
    const ARINC_LABEL_DEFS = {
        // Ejemplos demo para validar rápidamente la interpretación ARINC en UI.
        "203": { name: "PITCH_ANGLE_DEMO", encoding: "bnr", signed: true, bits: 19, scale: 1, units: "deg", min: -90, max: 90, ssmAllowed: [0, 3] },
        "310": { name: "IAS_DEMO", encoding: "bnr", signed: false, bits: 19, scale: 1, units: "kt", min: 0, max: 450, ssmAllowed: [0, 3] },
        "271": { name: "ALTITUDE_BCD_DEMO", encoding: "bcd", signed: false, bits: 19, scale: 1, units: "ft", min: -1000, max: 60000, ssmAllowed: [0, 3] },
        "default": { name: "GENERIC_ARINC", encoding: "bnr", signed: false, bits: 19, scale: 1, units: "", min: null, max: null, ssmAllowed: [0, 1, 2, 3] },
    };
    let offlinePlayback = {
        isPlaying: false,
        timer: null,
        speed: 1,
        currentTs: 0,
        currentIndex: 0,
        lastTickMs: 0,
    };

    /** Tiempo actual en replay/offline (scrubber o playback); para que generadores funcionen sin dar a Play. */
    function getReplayCurrentTs() {
        if (offlinePlayback && Number.isFinite(offlinePlayback.currentTs)) return offlinePlayback.currentTs;
        if (offlineDataset && offlineScrubber) {
            const ratio = (parseInt(offlineScrubber.value, 10) || 0) / 1000;
            const minT = Number.isFinite(offlineRecordingGlobalMinTs) ? offlineRecordingGlobalMinTs : offlineDataset.minTs;
            const maxT = Number.isFinite(offlineRecordingGlobalMaxTs) ? offlineRecordingGlobalMaxTs : offlineDataset.maxTs;
            return minT + ratio * (maxT - minT);
        }
        return (offlineDataset && Number.isFinite(offlineDataset.minTs)) ? offlineDataset.minTs : 0;
    }

    // Gestión de ventanas cortas por variable monitorizada (solo monitorización, no ploteadas).
    let WINDOW_SPAN_SEC = 3.0;
    const WINDOW_REQUERY_FRACTION = 0.5;
    const windowMetaByName = {}; // name -> { center: number, span: number }
    let windowFetchDebounceTimer = null;
    let windowFetchInFlight = 0;
    let windowFetchLastStart = 0;
    let windowFetchSlow = false;

    const GEN_TYPES = {
        sine:     { label: "Seno",       fields: [{k:"amp",l:"A",d:1},{k:"freq",l:"Hz",d:1},{k:"offset",l:"Off",d:0},{k:"phase",l:"Fase\u00B0",d:0}] },
        step:     { label: "Escalon",    fields: [{k:"v0",l:"Ini",d:0},{k:"v1",l:"Fin",d:1},{k:"delay",l:"Delay s",d:2}] },
        ramp:     { label: "Rampa",      fields: [{k:"v0",l:"Ini",d:0},{k:"v1",l:"Fin",d:1},{k:"dur",l:"Dur s",d:5}] },
        square:   { label: "Cuadrada",   fields: [{k:"lo",l:"Lo",d:0},{k:"hi",l:"Hi",d:1},{k:"freq",l:"Hz",d:1}] },
        triangle: { label: "Triangular", fields: [{k:"lo",l:"Lo",d:0},{k:"hi",l:"Hi",d:1},{k:"freq",l:"Hz",d:0.5}] },
        chirp:    { label: "Chirp",      fields: [{k:"amp",l:"A",d:1},{k:"offset",l:"Off",d:0},{k:"f1",l:"f1 Hz",d:0.1},{k:"f2",l:"f2 Hz",d:5},{k:"dur",l:"Dur s",d:10}] },
        pulse:    { label: "Pulso",      fields: [{k:"base",l:"Base",d:0},{k:"amp",l:"A",d:1},{k:"delay",l:"Delay s",d:1},{k:"dur",l:"Dur s",d:0.5}] },
        noise:    { label: "Ruido",      fields: [{k:"min",l:"Min",d:-1},{k:"max",l:"Max",d:1}] },
    };

    function computeGenValue(type, p, t) {
        switch (type) {
            case "sine":
                return p.amp * Math.sin(2 * Math.PI * p.freq * t + (p.phase || 0) * Math.PI / 180) + p.offset;
            case "step":
                return t >= p.delay ? p.v1 : p.v0;
            case "ramp": {
                if (t >= p.dur) return p.v1;
                return p.v0 + (p.v1 - p.v0) * (t / p.dur);
            }
            case "square": {
                const period = 1 / p.freq;
                return ((t % period) / period) < 0.5 ? p.hi : p.lo;
            }
            case "triangle": {
                const period = 1 / p.freq;
                const phase = (t % period) / period;
                return phase < 0.5
                    ? p.lo + (p.hi - p.lo) * (phase * 2)
                    : p.hi - (p.hi - p.lo) * ((phase - 0.5) * 2);
            }
            case "chirp": {
                const tc = Math.min(t, p.dur);
                const f = p.f1 + (p.f2 - p.f1) * (tc / p.dur);
                return p.amp * Math.sin(2 * Math.PI * f * tc) + p.offset;
            }
            case "pulse": {
                return (t >= p.delay && t < p.delay + p.dur) ? p.base + p.amp : p.base;
            }
            case "noise":
                return p.min + Math.random() * (p.max - p.min);
            default:
                return 0;
        }
    }

    function startGenerator(name, type, params) {
        if (!isLiveMode() && !isPlaybackMode()) return;
        stopGenerator(name);
        const startTime = Date.now();
        const arrElem = isArrayElem(name);
        let arrName, arrIdx;
        if (arrElem) {
            const br = name.lastIndexOf("[");
            arrName = name.substring(0, br);
            arrIdx = parseInt(name.substring(br + 1));
        }
        const vd = arrElem ? null : varsByName[name];
        const varType = vd ? (vd.type === "int32" ? "int32" : vd.type === "bool" ? "bool" : "double") : "double";
        const playbackOnly = isPlaybackMode() && !isLiveMode();

        const intervalId = setInterval(() => {
            const t = (Date.now() - startTime) / 1000;
            const val = computeGenValue(type, params, t);

            if (playbackOnly) {
                const now = getReplayCurrentTs();
                if (arrElem) {
                    if (!arrayElemHistory[name]) arrayElemHistory[name] = { timestamps: [], values: [] };
                    const h = arrayElemHistory[name];
                    h.timestamps.push(now);
                    h.values.push(val);
                    if (h.timestamps.length > ARRAY_HIST_MAX) {
                        h.timestamps.shift();
                        h.values.shift();
                    }
                    const arrVd = varsByName[arrName];
                    if (arrVd && Array.isArray(arrVd.value) && arrIdx >= 0 && arrIdx < arrVd.value.length) {
                        arrVd.value[arrIdx] = val;
                    }
                } else {
                    if (!varsByName[name]) varsByName[name] = { name, value: val, type: varType || "double" };
                    else varsByName[name].value = val;
                    if (!historyCache[name]) historyCache[name] = { timestamps: [], values: [] };
                    const h = historyCache[name];
                    h.timestamps.push(now);
                    h.values.push(val);
                    if (h.timestamps.length > (localHistMaxSec || 30) * 100) {
                        h.timestamps.shift();
                        h.values.shift();
                    }
                }
                schedulePlotRender();
                const wrap = monitorListEl.querySelector(`.monitor-item-wrap[data-name="${CSS.escape(arrElem ? arrName : name)}"]`);
                if (wrap) {
                    if (arrElem) {
                        const row = wrap.querySelector(`.arr-row[data-idx="${arrIdx}"]`);
                        const valEl = row && row.querySelector(".arr-val");
                        if (valEl) valEl.textContent = typeof val === "number" ? val.toFixed(4) : String(val);
                    } else {
                        const valEl = wrap.querySelector(".mon-value");
                        if (valEl) valEl.textContent = typeof val === "number" ? val.toFixed(4) : String(val);
                    }
                }
            } else {
                if (!isLiveMode() || !ws || ws.readyState !== WebSocket.OPEN) return;
                if (arrElem) {
                    sendWsAction({ action: "set_array_element", name: arrName, index: arrIdx, value: val });
                } else {
                    sendWsAction({ action: "set_var", name: name, value: val, var_type: varType });
                }
            }

            const isDone = (type === "step" && t > params.delay + 0.5) ||
                           (type === "ramp" && t > params.dur + 0.2) ||
                           (type === "pulse" && t > params.delay + params.dur + 0.2) ||
                           (type === "chirp" && t > params.dur + 0.2);
            if (isDone) {
                stopGenerator(name);
                if (expandedStats.has(name)) {
                    const w = monitorListEl.querySelector(`.monitor-item-wrap[data-name="${CSS.escape(name)}"]`);
                    if (w) updateStatsPanel(w, name);
                }
            }
        }, GEN_RATE_MS);

        activeGenerators[name] = { type, params, intervalId, startTime };
    }

    function stopGenerator(name) {
        const gen = activeGenerators[name];
        if (gen) {
            clearInterval(gen.intervalId);
            delete activeGenerators[name];
        }
    }

    function stopAllGenerators() {
        for (const name in activeGenerators) stopGenerator(name);
    }

    function restorePendingGeneratorsIfPossible() {
        if (!isLiveMode() || !ws || ws.readyState !== WebSocket.OPEN) return;
        if (!Array.isArray(pendingGeneratorRestore) || pendingGeneratorRestore.length === 0) return;
        const rows = pendingGeneratorRestore.slice();
        pendingGeneratorRestore = [];
        rows.forEach((g) => {
            if (!g || !g.name || !g.type || !g.params) return;
            try { startGenerator(g.name, g.type, g.params); } catch (e) {}
        });
    }

    // --- Computed variables ---

    function addComputedVar(name, expr) {
        if (computedVars.find(c => c.name === name)) return "duplicate";
        let fn;
        try {
            fn = new Function("$", `with($){return (${expr});}`);
        } catch (e) {
            return e.message || "syntax";
        }
        computedVars.push({ name, expr, fn });
        computedHistories[name] = { timestamps: [], values: [] };
        monitoredNames.add(name);
        monitoredOrder.push(name);
        return true;
    }

    function removeComputedVar(name) {
        computedVars = computedVars.filter(c => c.name !== name);
        delete computedHistories[name];
        delete varsByName[name];
        delete historyCache[name];
        monitoredNames.delete(name);
        monitoredOrder = monitoredOrder.filter(n => n !== name);
        delete varGraphAssignment[name];
        expandedStats.delete(name);
    }

    function isComputed(name) {
        return computedVars.some(c => c.name === name);
    }

    function evalComputedVars() {
        const vals = {};
        for (const [k, v] of Object.entries(varsByName)) {
            if (isComputed(k)) continue;
            vals[k.replace(/\./g, "_")] = v.value;
            const parts = k.split(".");
            let node = vals;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
                node = node[parts[i]];
            }
            node[parts[parts.length - 1]] = v.value;
        }
        const now = Date.now() / 1000;
        for (const cv of computedVars) {
            try {
                const val = cv.fn(vals);
                const num = Number(val);
                if (!isFinite(num)) continue;
                vals[cv.name.replace(/\./g, "_")] = num;
                vals[cv.name] = num;
                varsByName[cv.name] = { name: cv.name, type: "double", value: num, timestamp: now };
                const hist = computedHistories[cv.name];
                if (hist) {
                    hist.timestamps.push(now);
                    hist.values.push(num);
                    if (hist.timestamps.length > COMPUTED_MAX_HISTORY) {
                        hist.timestamps.shift();
                        hist.values.shift();
                    }
                    historyCache[cv.name] = hist;
                }
            } catch (e) { /* expression references unavailable vars */ }
        }
    }

    function ensureVarFormatEntry(name) {
        if (!varFormat[name] || typeof varFormat[name] !== "object") {
            varFormat[name] = { ori: "dec", sal: "dec" };
        } else {
            if (!varFormat[name].ori) varFormat[name].ori = "dec";
            if (!varFormat[name].sal) varFormat[name].sal = "dec";
        }
        return varFormat[name];
    }

    function getArincConfig(name) {
        const vf = ensureVarFormatEntry(name);
        if (!vf.arinc || typeof vf.arinc !== "object") {
            vf.arinc = { lsb: 1, encodingOverride: "" };
        }
        const lsbNum = Number(vf.arinc.lsb);
        vf.arinc.lsb = Number.isFinite(lsbNum) && lsbNum !== 0 ? lsbNum : 1;
        if (typeof vf.arinc.encodingOverride !== "string") vf.arinc.encodingOverride = "";
        return vf.arinc;
    }

    function isArincEnabled(name) {
        if (!name || isArincDerivedName(name)) return false;
        const f = varFormat[name];
        return !!(f && f.sal === "arinc429");
    }

    function getArincDerivedNames(baseName) {
        return ARINC_SUFFIXES.map((s) => `${baseName}.arinc.${s}`);
    }

    function isArincDerivedName(name) {
        return typeof name === "string" && /\.arinc\.(label|sdi|data|ssm|parity|value)$/.test(name);
    }

    function getArincBaseName(derivedName) {
        return String(derivedName).replace(/\.arinc\.(label|sdi|data|ssm|parity|value)$/, "");
    }

    function reverseBits8(x) {
        let v = x & 0xFF;
        let r = 0;
        for (let i = 0; i < 8; i++) {
            r = (r << 1) | (v & 1);
            v >>= 1;
        }
        return r & 0xFF;
    }

    function popcount32(x) {
        let v = x >>> 0;
        let c = 0;
        while (v) {
            v &= (v - 1);
            c++;
        }
        return c;
    }

    function decodeBcd(raw, bits) {
        const nibbles = Math.max(1, Math.floor(bits / 4));
        let out = "";
        for (let i = nibbles - 1; i >= 0; i--) {
            const d = (raw >>> (i * 4)) & 0xF;
            if (d > 9) return Number.NaN;
            out += String(d);
        }
        return Number(out);
    }

    function decodeArinc429(wordNumber, cfg = {}, labelDef = null) {
        const word = (Math.round(Number(wordNumber)) >>> 0);
        const rawLabel = word & 0xFF;
        const label = reverseBits8(rawLabel);
        const labelOct = label.toString(8).padStart(3, "0");
        const sdi = (word >>> 8) & 0x3;
        const data = (word >>> 10) & 0x7FFFF;
        const ssm = (word >>> 29) & 0x3;
        const parity = (word >>> 31) & 0x1;
        const parityOk = (popcount32(word) % 2) === 1; // ARINC usa paridad impar

        const baseDef = labelDef || ARINC_LABEL_DEFS[labelOct] || ARINC_LABEL_DEFS.default;
        const def = { ...baseDef };
        if (cfg && typeof cfg.encodingOverride === "string" && cfg.encodingOverride) {
            def.encoding = cfg.encodingOverride;
        }
        const bits = Math.max(1, Math.min(19, Number(def.bits) || 19));
        const mask = (1 << bits) - 1;
        let valueRaw;
        if (def.encoding === "bcd") {
            valueRaw = decodeBcd(data & mask, bits);
        } else if (def.encoding === "discrete") {
            valueRaw = data & mask;
        } else {
            let signedVal = data & mask;
            if (def.signed) {
                const signBit = 1 << (bits - 1);
                if (signedVal & signBit) signedVal = signedVal - (1 << bits);
            }
            valueRaw = signedVal;
        }
        const lsb = Number.isFinite(Number(cfg.lsb)) && Number(cfg.lsb) !== 0 ? Number(cfg.lsb) : 1;
        const scale = Number.isFinite(Number(def.scale)) ? Number(def.scale) : 1;
        const value = Number.isFinite(valueRaw) ? valueRaw * lsb * scale : Number.NaN;
        const min = Number.isFinite(Number(def.min)) ? Number(def.min) : null;
        const max = Number.isFinite(Number(def.max)) ? Number(def.max) : null;
        const rangeOk = Number.isFinite(value) ? ((min == null || value >= min) && (max == null || value <= max)) : false;
        const ssmOk = isSsmOkForEncoding({ encoding: def.encoding, ssm }, cfg);
        const labelKnown = !!ARINC_LABEL_DEFS[labelOct];

        return {
            label,
            labelOct,
            sdi,
            data,
            ssm,
            parity,
            parityOk,
            valueRaw,
            value,
            labelName: def.name || "GENERIC_ARINC",
            units: def.units || "",
            encoding: def.encoding || "bnr",
            rangeOk,
            ssmOk,
            labelKnown,
        };
    }

    function isSsmOkForEncoding(decoded, cfg = {}) {
        if (!decoded) return true;
        const enc = String((cfg && cfg.encodingOverride) || decoded.encoding || "bnr").toLowerCase();
        const ssm = Number(decoded.ssm);
        if (!Number.isFinite(ssm)) return true;
        if (enc === "bcd") return true; // Por ahora, SSM no se evalua en BCD.
        if (enc === "discrete") return ssm === 0;
        return ssm === 3; // BNR por defecto.
    }

    function rebuildKnownVarNamesWithDerived() {
        // Modo simplificado: no exponer subcanales ARINC como variables visibles en browser.
        knownVarNames = baseKnownVarNames.slice().sort();
    }

    function removeArincDerivedForBase(baseName) {
        const derived = getArincDerivedNames(baseName);
        for (let i = 0; i < derived.length; i++) {
            const n = derived[i];
            delete varsByName[n];
            delete historyCache[n];
            monitoredNames.delete(n);
            monitoredOrder = monitoredOrder.filter((x) => x !== n);
            delete varGraphAssignment[n];
            expandedStats.delete(n);
        }
    }

    function pushArincDerivedSample(baseName, ts, word, appendHistory) {
        const cfg = getArincConfig(baseName);
        const decoded = decodeArinc429(word, cfg);
        arincBusHealth.totalWords += 1;
        if (!decoded.parityOk) arincBusHealth.parityErrors += 1;
        if (!isSsmOkForEncoding(decoded, cfg)) arincBusHealth.ssmErrors += 1;
        if (!decoded.labelKnown) arincBusHealth.unknownLabels += 1;
        arincBusHealth.labels[decoded.labelOct] = (arincBusHealth.labels[decoded.labelOct] || 0) + 1;
        if (!decoded.parityOk) arincBusHealth.parityByLabel[decoded.labelOct] = (arincBusHealth.parityByLabel[decoded.labelOct] || 0) + 1;
        if (!decoded.labelKnown) arincBusHealth.unknownByLabel[decoded.labelOct] = (arincBusHealth.unknownByLabel[decoded.labelOct] || 0) + 1;
        const vals = {
            label: decoded.label,
            sdi: decoded.sdi,
            data: decoded.data,
            ssm: decoded.ssm,
            parity: decoded.parity,
            value: decoded.value,
        };
        for (const suffix of ARINC_SUFFIXES) {
            const dName = `${baseName}.arinc.${suffix}`;
            const v = vals[suffix];
            varsByName[dName] = { name: dName, type: "double", value: v, timestamp: ts };
            if (!appendHistory || !Number.isFinite(v)) continue;
            if (!historyCache[dName]) historyCache[dName] = { timestamps: [], values: [] };
            historyCache[dName].timestamps.push(ts);
            historyCache[dName].values.push(v);
        }
        return decoded;
    }

    function rebuildArincDerivedHistoryForBase(baseName) {
        if (!isArincEnabled(baseName)) return;
        const baseHist = historyCache[baseName];
        if (!baseHist || !baseHist.timestamps || !baseHist.values) return;
        const derived = getArincDerivedNames(baseName);
        for (let i = 0; i < derived.length; i++) {
            historyCache[derived[i]] = { timestamps: [], values: [] };
        }
        for (let i = 0; i < baseHist.timestamps.length; i++) {
            const ts = baseHist.timestamps[i];
            const w = baseHist.values[i];
            if (!Number.isFinite(w)) continue;
            pushArincDerivedSample(baseName, ts, w, true);
        }
    }

    function rebuildAllArincDerivedHistories() {
        for (const base of baseKnownVarNames) {
            if (!isArincEnabled(base)) continue;
            rebuildArincDerivedHistoryForBase(base);
        }
    }

    function parseNumericWithFormat(raw, ori) {
        const t = String(raw || "").trim();
        if (!t) return 0;
        const baseOri = ori || "dec";
        if (baseOri === "hex") {
            const cleaned = t.toLowerCase().startsWith("0x") ? t.slice(2) : t;
            return parseInt(cleaned, 16);
        }
        if (baseOri === "bin") {
            const cleaned = t.toLowerCase().startsWith("0b") ? t.slice(2) : t;
            return parseInt(cleaned, 2);
        }
        if (baseOri === "arinc429") {
            if (/^0x/i.test(t)) return parseInt(t.slice(2), 16);
            if (/^0b/i.test(t)) return parseInt(t.slice(2), 2);
            if (/^[01]{8,32}$/.test(t)) return parseInt(t, 2);
            return parseInt(t, 10);
        }
        return parseFloat(t);
    }

    function normalizeVarFormatConfig(input) {
        const out = {};
        if (!input || typeof input !== "object") return out;
        for (const [name, cfg] of Object.entries(input)) {
            if (!cfg || typeof cfg !== "object") continue;
            const ori = cfg.ori || "dec";
            const sal = cfg.sal || "dec";
            out[name] = { ori, sal };
            if (cfg.arinc && typeof cfg.arinc === "object") {
                const lsbNum = Number(cfg.arinc.lsb);
                out[name].arinc = { lsb: Number.isFinite(lsbNum) && lsbNum !== 0 ? lsbNum : 1 };
            }
        }
        return out;
    }

    // --- I18N y tema ---

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
            newGraphDropText: "Nuevo gráfico: suelta aquí para crear uno",
            removeGraphTitle: "Eliminar gráfico",
            monitorMenuTitle: "Más opciones",
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
            newGraphDropText: "New plot: drop here to create one",
            removeGraphTitle: "Remove plot",
            monitorMenuTitle: "More options",
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

    function getPlotLayoutColors() {
        const isLight = currentTheme === "light";
        return isLight
            ? {
                paper_bgcolor: "#ffffff",
                plot_bgcolor: "#f4f5fb",
                fontColor: "#4b5563",
                gridcolor: "#e5e7eb",
                legendBg: "rgba(0,0,0,0)"
            }
            : {
                paper_bgcolor: "#1a1d27",
                plot_bgcolor: "#0f1117",
                fontColor: "#8b8fa3",
                gridcolor: "#2a2e3a",
                legendBg: "rgba(0,0,0,0)"
            };
    }

    function applyTheme(theme) {
        currentTheme = (theme === "light") ? "light" : "dark";
        document.body.classList.toggle("theme-light", currentTheme === "light");
        document.body.classList.toggle("theme-dark", currentTheme === "dark");
        if (themeSelect) themeSelect.value = currentTheme;
        schedulePlotRender();
    }

    function applyLanguage(lang) {
        currentLang = I18N[lang] ? lang : "es";
        const tr = I18N[currentLang];
        document.documentElement.lang = currentLang;

        const colBrowserTitle = document.getElementById("colBrowserTitle");
        const colMonitorTitle = document.getElementById("colMonitorTitle");
        const colPlotTitle = document.getElementById("colPlotTitle");
        const instanceLabelEl = document.getElementById("instanceLabel");
        const pollLabel = document.getElementById("pollLabel");
        const langLabel = document.getElementById("langLabel");
        const themeLabel = document.getElementById("themeLabel");

        if (colBrowserTitle) colBrowserTitle.textContent = tr.colBrowserTitle;
        if (colMonitorTitle) colMonitorTitle.textContent = tr.colMonitorTitle;
        if (colPlotTitle) colPlotTitle.textContent = tr.colPlotTitle;
        if (instanceLabelEl) instanceLabelEl.firstChild.nodeValue = (tr.instanceLabel || "Instancia:") + " ";
        if (pollLabel) pollLabel.firstChild.nodeValue = tr.pollLabel + " ";
        if (langLabel) langLabel.textContent = tr.langLabel;
        if (themeLabel) themeLabel.textContent = tr.themeLabel;

        const helpBtn = document.getElementById("helpBtn");
        if (helpBtn) helpBtn.title = tr.helpTitle;

        if (reconnectBtn) {
            reconnectBtn.textContent = tr.reconnectBtn;
            reconnectBtn.title = tr.reconnectTitle;
        }
        const modeLabelTextEl = document.getElementById("modeLabelText");
        if (modeLabelTextEl) modeLabelTextEl.textContent = tr.modeLabel || "Modo:";
        if (modeSelect && modeSelect.options.length >= 3) {
            modeSelect.options[0].textContent = tr.modeLive || "Live";
            modeSelect.options[1].textContent = tr.modeOffline || "Análisis";
            modeSelect.options[2].textContent = tr.modeReplay || "Replay";
        }
        if (loadLocalTsvBtn) loadLocalTsvBtn.textContent = tr.offlineLoadLocal || "Cargar TSV local";
        if (loadServerRecordingBtn) loadServerRecordingBtn.textContent = tr.offlineLoadServer || "Cargar";
        const recordingSelectLabelEl = document.getElementById("recordingSelectLabel");
        if (recordingSelectLabelEl && recordingSelectLabelEl.firstChild && recordingSelectLabelEl.firstChild.nodeType === Node.TEXT_NODE) {
            recordingSelectLabelEl.firstChild.nodeValue = (tr.offlineRecordingLabel || "Grabación:") + " ";
        }
        updateOfflineDatasetStatus();
        updateMarkerInfoLabel();
        if (recordBtn) recordBtn.textContent = tr.recordBtn;

        if (resetConfigBtn) resetConfigBtn.title = tr.resetConfigTitle;
        const clearAlarmsBtn = document.getElementById("clearAlarmsBtn");
        if (clearAlarmsBtn) clearAlarmsBtn.title = tr.clearAlarmsTitle;

        if (resetPlotsBtn) {
            resetPlotsBtn.title = tr.resetPlotsTitle;
            resetPlotsBtn.textContent = "\uD83D\uDDD1 " + (tr.resetPlotsBtn || "Limpiar");
        }
        const smoothPlotsLabelEl = document.getElementById("smoothPlotsLabel");
        const smoothPlotsSelectEl = document.getElementById("smoothPlotsSelect");
        if (smoothPlotsLabelEl && smoothPlotsLabelEl.firstChild) smoothPlotsLabelEl.firstChild.nodeValue = tr.smoothPlotsLabel + ": ";
        if (smoothPlotsSelectEl) smoothPlotsSelectEl.title = tr.smoothPlotsTitle;
        ["1", "3", "5", "7", "11"].forEach((v, i) => {
            const opt = document.getElementById("smoothOpt" + v);
            if (opt) opt.textContent = [tr.smoothOff, tr.smooth3, tr.smooth5, tr.smooth7, tr.smooth11][i];
        });
        if (resetTimeBtn) { resetTimeBtn.textContent = "\u27F3 " + tr.resetTimeBtn; resetTimeBtn.title = tr.resetTimeTitle; }
        if (screenshotBtn) screenshotBtn.title = tr.screenshotTitle;

        const authTitleEl = document.getElementById("authTitle");
        const authPromptEl = document.getElementById("authPrompt");
        if (authTitleEl) authTitleEl.textContent = tr.authTitle;
        if (authPromptEl) authPromptEl.textContent = tr.authPrompt;
        if (authPasswordInput) authPasswordInput.placeholder = tr.authPlaceholder;
        if (authSubmitBtn) authSubmitBtn.textContent = tr.authSubmit;

        const visualBufferLabelEl = document.getElementById("visualBufferLabel");
        if (visualBufferLabelEl && visualBufferLabelEl.tagName === "LABEL" && visualBufferLabelEl.firstChild) {
            visualBufferLabelEl.childNodes[0].nodeValue = tr.bufferVisualLabel + " ";
        }

        if (varFilter) varFilter.placeholder = tr.filterPlaceholder;
        if (selectAllBtn) selectAllBtn.textContent = tr.selectAll;
        if (selectNoneBtn) selectNoneBtn.textContent = tr.selectNone;
        if (addToMonitorBtn) addToMonitorBtn.textContent = tr.addToMonitor;

        const hideLevelsLabelEl = document.getElementById("hideLevelsLabel");
        if (hideLevelsLabelEl && hideLevelsLabelEl.firstChild && hideLevelsLabelEl.firstChild.nodeType === Node.TEXT_NODE) {
            hideLevelsLabelEl.firstChild.nodeValue = tr.hideLevelsLabel + " ";
        }

        if (statusEl) {
            if (isReplayMode()) {
                statusEl.textContent = tr.statusReplay || "Modo replay";
            } else if (isOfflineMode()) {
                statusEl.textContent = tr.statusOffline || "Modo análisis (offline)";
            } else {
                statusEl.textContent = statusEl.classList.contains("connected") ? tr.statusConnected : tr.statusDisconnected;
            }
        }
        if (settingsBtn) settingsBtn.title = tr.settingsTitle;
        const sendFileOnFinishLabelEl = document.getElementById("sendFileOnFinishLabel");
        if (sendFileOnFinishLabelEl) sendFileOnFinishLabelEl.textContent = tr.sendFileOnFinishLabel || "Enviar fichero al terminar";
        const recordPathLabelEl = document.getElementById("recordPathLabel");
        if (recordPathLabelEl) recordPathLabelEl.textContent = tr.recordPathLabel || "Guardado en:";
        if (recordPathAnalyzeBtn) {
            recordPathAnalyzeBtn.textContent = tr.analyzePromptBtn || "Analizar este archivo";
            recordPathAnalyzeBtn.title = "Abrir este archivo en modo análisis manteniendo el layout";
        }
        if (advInfoLabel) advInfoLabel.textContent = tr.advInfoLabel || "Adv info";
        const monitorMenuBtnEl = document.getElementById("monitorMenuBtn");
        if (monitorMenuBtnEl) monitorMenuBtnEl.title = tr.monitorMenuTitle;
        const monitorFilterMenuBtnEl = document.getElementById("monitorFilterMenuBtn");
        if (monitorFilterMenuBtnEl) {
            monitorFilterMenuBtnEl.title = currentLang === "en"
                ? "Monitor filter/selection menu"
                : "Menú de filtro/selección de monitorización";
        }
        if (localRecordBtn) {
            localRecordBtn.title = currentLang === "en"
                ? "Local frontend recording (includes virtual vars)"
                : "Grabación local en frontend (incluye virtuales)";
            updateLocalRecordBtnUi();
        }
        const browserToggleBtnEl = document.getElementById("browserToggleBtn");
        if (browserToggleBtnEl) browserToggleBtnEl.title = currentLang === "en" ? "Add variables to monitor" : "Añadir variables a monitorizar";

        document.querySelectorAll(".plot-slot-header .plot-slot-title").forEach((el, i) => {
            el.textContent = " " + tr.graphTitle + " " + (i + 1);
        });
        document.querySelectorAll(".plot-add-slot").forEach((el) => {
            if (el.classList.contains("plot-add-slot-right")) {
                el.textContent = currentLang === "en" ? "New column" : "Nueva columna";
            } else if (el.classList.contains("plot-add-slot-under-col")) {
                const idx = Number(el.dataset.colIndex);
                const n = Number.isFinite(idx) ? (idx + 1) : "";
                el.textContent = currentLang === "en" ? `Below C${n}` : `Abajo C${n}`;
            } else {
                el.textContent = tr.newGraphDropText;
            }
        });

        // Actualizar texto del boton de pausa segun estado
        if (pauseBtn) {
            pauseBtn.textContent = plotsPaused ? tr.pausePlay : tr.pausePause;
        }
        if (offlinePlayPauseBtn) {
            offlinePlayPauseBtn.textContent = (offlinePlayback && offlinePlayback.isPlaying)
                ? (tr.offlinePlaybackPause || "⏸ Pause")
                : (tr.offlinePlaybackPlay || "▶ Play");
        }

        const helpModalTitle = document.getElementById("helpModalTitle");
        const helpModalBody = document.getElementById("helpModalBody");
        if (helpModalTitle) helpModalTitle.textContent = tr.helpGuideTitle || tr.helpTitle || "VarMonitor";
        if (helpModalBody && tr.helpGuideHtml) helpModalBody.innerHTML = tr.helpGuideHtml;

        const docsBtnEl = document.getElementById("docsBtn");
        if (docsBtnEl && tr.docsTitle) docsBtnEl.title = tr.docsTitle;
        const docsLangModalTitle = document.getElementById("docsLangModalTitle");
        const docsLangChoose = document.getElementById("docsLangChoose");
        const docsLangNotBuilt = document.getElementById("docsLangNotBuilt");
        if (docsLangModalTitle) docsLangModalTitle.textContent = tr.docsModalTitle || "Docs";
        if (docsLangChoose) docsLangChoose.textContent = tr.docsModalChoose || "";
        const docsOpenEsBtn = document.getElementById("docsOpenEsBtn");
        const docsOpenEnBtn = document.getElementById("docsOpenEnBtn");
        if (docsOpenEsBtn && tr.docsLangEs) docsOpenEsBtn.textContent = tr.docsLangEs;
        if (docsOpenEnBtn && tr.docsLangEn) docsOpenEnBtn.textContent = tr.docsLangEn;
        if (docsLangNotBuilt && tr.docsNotBuiltMsg) docsLangNotBuilt.textContent = tr.docsNotBuiltMsg;
    }

    function applyMonitorColumns() {
        document.documentElement.style.setProperty("--monitor-columns", String(monitorColumnsCount));
        applyMonitorPaneWidth();
    }

    function updateCompactMonitorUi() {
        document.body.classList.toggle("monitor-compact", compactMonitorLevel > 0);
        document.documentElement.style.setProperty("--monitor-compact-level", String(Math.max(0, Math.min(100, compactMonitorLevel))));
        if (compactMonitorSlider) compactMonitorSlider.value = String(Math.max(0, Math.min(100, compactMonitorLevel)));
    }

    function renderPerfTelemetry() {
        const r = renderStats;
        if (advUiRenderMs) advUiRenderMs.textContent = `render: ${r.lastMs.toFixed(1)}ms (${r.avgMs.toFixed(1)}ms avg)`;
        if (advUiFps) advUiFps.textContent = `fps: ${r.fps.toFixed(1)} ${adaptiveLoadEnabled ? "A" : ""}`;
        if (advUiPts) advUiPts.textContent = `pts: ${r.points}`;
    }

    function renderNotesList() {
        if (!notesListEl) return;
        notesListEl.innerHTML = "";
        if (!Array.isArray(notesByTs) || notesByTs.length === 0) return;
        const rows = notesByTs.slice().sort((a, b) => a.ts - b.ts).slice(-120);
        for (let i = 0; i < rows.length; i++) {
            const n = rows[i];
            const row = document.createElement("div");
            row.className = "note-item";
            const txt = document.createElement("span");
            const relTs = (offlineDataset && Number.isFinite(offlineDataset.minTs))
                ? Math.max(0, n.ts - offlineDataset.minTs) : n.ts;
            txt.textContent = `${relTs.toFixed(3)}s | ${n.text}`;
            const go = document.createElement("button");
            go.className = "btn-small";
            go.textContent = "Ir";
            go.addEventListener("click", () => {
                applyOfflineTime(n.ts);
                schedulePlotRender();
            });
            const del = document.createElement("button");
            del.className = "btn-small";
            del.textContent = "✕";
            del.title = "Borrar nota";
            del.addEventListener("click", () => {
                const idx = notesByTs.indexOf(n);
                if (idx >= 0) {
                    notesByTs.splice(idx, 1);
                    renderNotesList();
                    saveConfig();
                }
            });
            row.appendChild(txt);
            row.appendChild(go);
            row.appendChild(del);
            notesListEl.appendChild(row);
        }
    }

    function renderSegmentsUi() {
        if (!segmentSelectEl) return;
        const fmtDraft = (v) => {
            if (!Number.isFinite(v)) return "--";
            if (offlineDataset && Number.isFinite(offlineDataset.minTs)) return `${(v - offlineDataset.minTs).toFixed(3)}s`;
            return `${v.toFixed(3)}s`;
        };
        if (segStartLabel) segStartLabel.textContent = `S: ${fmtDraft(segmentDraft.start)}`;
        if (segEndLabel) segEndLabel.textContent = `E: ${fmtDraft(segmentDraft.end)}`;
        segmentSelectEl.innerHTML = "";
        const list = Array.isArray(offlineSegments) ? offlineSegments : [];
        if (list.length === 0) {
            const op = document.createElement("option");
            op.value = "";
            op.textContent = "(sin segmentos)";
            segmentSelectEl.appendChild(op);
            return;
        }
        for (let i = 0; i < list.length; i++) {
            const seg = list[i];
            const op = document.createElement("option");
            op.value = String(i);
            const s = (offlineDataset && Number.isFinite(offlineDataset.minTs)) ? seg.start - offlineDataset.minTs : seg.start;
            const e = (offlineDataset && Number.isFinite(offlineDataset.minTs)) ? seg.end - offlineDataset.minTs : seg.end;
            op.textContent = `${seg.name || ("Seg " + (i + 1))} [${s.toFixed(2)}-${e.toFixed(2)}s]`;
            segmentSelectEl.appendChild(op);
        }
    }

    function buildLayoutSnapshot() {
        return JSON.stringify({
            monitoredOrder: monitoredOrder.slice(),
            varGraphAssignment: varGraphAssignment,
            arrayElemAssignment: arrayElemAssignment,
            graphList: graphList.slice(),
            graphColumns: graphColumns.map((col) => col.slice()),
            monitorColumnsCount,
            monitorPaneWidthPx,
            hideLevels,
            compactMonitorLevel,
        });
    }

    function applyLayoutSnapshot(snapshotRaw) {
        try {
            const s = JSON.parse(snapshotRaw);
            applyingLayoutHistory = true;
            monitoredNames.clear();
            monitoredOrder = Array.isArray(s.monitoredOrder) ? s.monitoredOrder.slice() : [];
            monitoredOrder.forEach((n) => monitoredNames.add(n));
            varGraphAssignment = (s.varGraphAssignment && typeof s.varGraphAssignment === "object") ? { ...s.varGraphAssignment } : {};
            arrayElemAssignment = (s.arrayElemAssignment && typeof s.arrayElemAssignment === "object") ? { ...s.arrayElemAssignment } : {};
            graphList = Array.isArray(s.graphList) ? s.graphList.slice() : [];
            graphColumns = Array.isArray(s.graphColumns) ? s.graphColumns.map((col) => Array.isArray(col) ? col.slice() : []) : [];
            normalizeGraphLayout();
            if (typeof s.monitorColumnsCount === "number") monitorColumnsCount = Math.max(1, Math.min(3, s.monitorColumnsCount));
            monitorPaneWidthPx = (typeof s.monitorPaneWidthPx === "number" && Number.isFinite(s.monitorPaneWidthPx)) ? s.monitorPaneWidthPx : null;
            if (typeof s.hideLevels === "number") hideLevels = s.hideLevels;
            if (typeof s.compactMonitorLevel === "number") compactMonitorLevel = Math.max(0, Math.min(100, s.compactMonitorLevel));
            if (hideLevelsInput) hideLevelsInput.value = String(hideLevels);
            applyMonitorColumns();
            updateCompactMonitorUi();
            rebuildMonitorList();
            rebuildPlotArea();
            renderBrowserList();
            schedulePlotRender();
            saveConfig();
        } catch (e) {
            console.error("No se pudo aplicar snapshot layout:", e);
        } finally {
            applyingLayoutHistory = false;
        }
    }

    function maybePushLayoutHistory() {
        if (applyingLayoutHistory) return;
        const snap = buildLayoutSnapshot();
        if (snap === lastLayoutSnapshot) return;
        layoutHistoryPast.push(snap);
        if (layoutHistoryPast.length > 80) layoutHistoryPast.shift();
        layoutHistoryFuture = [];
        lastLayoutSnapshot = snap;
    }

    function doLayoutUndo() {
        if (layoutHistoryPast.length <= 1) return;
        const current = layoutHistoryPast.pop();
        layoutHistoryFuture.push(current);
        const prev = layoutHistoryPast[layoutHistoryPast.length - 1];
        if (prev) applyLayoutSnapshot(prev);
    }

    function doLayoutRedo() {
        if (layoutHistoryFuture.length === 0) return;
        const next = layoutHistoryFuture.pop();
        if (!next) return;
        layoutHistoryPast.push(next);
        applyLayoutSnapshot(next);
    }

    function renderArincBusHealth() {
        if (!arincBusHealthPanel) return;
        if (isPlaybackMode()) {
            arincBusHealthPanel.innerHTML =
                `<div>ARINC bus health</div>` +
                `<div>Words: ${arincBusHealth.totalWords} | Parity err: ${arincBusHealth.parityErrors} | SSM err: ${arincBusHealth.ssmErrors}</div>`;
            return;
        }
        const labels = Object.entries(arincBusHealth.labels || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const top = labels.length ? labels.map(([k, v]) => `${k}:${v}`).join(" | ") : "—";
        const topParity = Object.entries(arincBusHealth.parityByLabel || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
        const topParityTxt = topParity.length ? topParity.map(([k, v]) => `${k}:${v}`).join(" | ") : "—";
        arincBusHealthPanel.innerHTML =
            `<div>ARINC bus health</div>` +
            `<div>Words: ${arincBusHealth.totalWords} | Parity err: ${arincBusHealth.parityErrors} | SSM err: ${arincBusHealth.ssmErrors} | Unknown label: ${arincBusHealth.unknownLabels}</div>` +
            `<div>Top labels (trafico): ${top}</div>` +
            `<div>Top labels (paridad): ${topParityTxt}</div>`;
    }

    function clampMonitorPaneWidth(px) {
        const mainEl = document.querySelector("main");
        const mainW = mainEl ? mainEl.getBoundingClientRect().width : window.innerWidth;
        const minW = 240 * monitorColumnsCount;
        const maxW = Math.max(minW + 80, mainW - 320);
        return Math.max(minW, Math.min(maxW, px));
    }

    function applyMonitorPaneWidth() {
        const monitorEl = document.querySelector(".col-monitor");
        if (!monitorEl) return;
        if (window.matchMedia("(max-width: 900px)").matches) {
            monitorEl.style.width = "";
            return;
        }
        if (Number.isFinite(monitorPaneWidthPx) && monitorPaneWidthPx > 0) {
            monitorPaneWidthPx = clampMonitorPaneWidth(monitorPaneWidthPx);
            monitorEl.style.width = `${monitorPaneWidthPx}px`;
        } else {
            monitorEl.style.width = "";
        }
    }

    // --- Config persistence (localStorage) ---

    const STORAGE_KEY = "varmon_config";

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                monitored: monitoredOrder.slice(),
                graphs: varGraphAssignment,
                graphList: graphList,
                graphColumns: graphColumns.map((col) => col.slice()),
                timeWindow: timeWindowSelect.value,
                smoothPlots: document.getElementById("smoothPlotsSelect")?.value || "5",
                instance: portSelect ? portSelect.value : "",
                hideLevels: hideLevels,
                update_ratio: intervalInput.value,
                alarms: alarms,
                computedVars: computedVars.map(c => ({ name: c.name, expr: c.expr })),
                varFormat: varFormat,
                arrayElemAssignment: arrayElemAssignment,
                lang: currentLang,
                theme: currentTheme,
                monitorColumns: monitorColumnsCount,
                monitorPaneWidth: monitorPaneWidthPx,
                appMode: appMode,
                offlineRecordingName: offlineRecordingName || "",
                offlineSpeed: offlineSpeedSelect ? offlineSpeedSelect.value : "1",
                compactMonitor: compactMonitorLevel,
                adaptiveLoad: adaptiveLoadEnabled,
                downsampleMaxPoints: downsampleMaxPoints,
                notesByTs: notesByTs,
                offlineSegments: offlineSegments,
                snapshotFrames: snapshotFramesInput ? Number(snapshotFramesInput.value || 40) : 40,
                offlineFullLoadMaxMb: offlineFullLoadMaxMb,
                offlinePreviewMb: offlinePreviewMb,
                offlineSafePreviewMaxRows: offlineSafePreviewMaxRows,
                offlineSafePreviewMaxSpanSec: offlineSafePreviewMaxSpanSec,
                offlineAllowForceFullLoad: !!offlineAllowForceFullLoad,
                impositionNames: Array.from(impositionNames),
                impositionTimeOffset: { ...impositionTimeOffset },
                impositionValueOffset: { ...impositionValueOffset },
                plotVsRef: !!plotVsRef,
                seriesColors: { ...seriesColorByName },
            }));
            maybePushLayoutHistory();
        } catch (e) { /* quota exceeded or private mode */ }
    }

    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const cfg = JSON.parse(raw);
            if (Array.isArray(cfg.monitored)) {
                monitoredOrder = cfg.monitored.slice();
                monitoredOrder.forEach(n => monitoredNames.add(n));
                enforceArincMonitoringDependencies();
                pruneArincDerivedFromMonitored();
            }
            if (cfg.graphs && typeof cfg.graphs === "object") {
                varGraphAssignment = cfg.graphs;
            }
            if (Array.isArray(cfg.graphList)) {
                graphList = cfg.graphList;
            }
            if (Array.isArray(cfg.graphColumns)) {
                graphColumns = cfg.graphColumns.map((col) => Array.isArray(col) ? col.slice() : []);
            }
            normalizeGraphLayout();
            if (cfg.timeWindow) {
                timeWindowSelect.value = cfg.timeWindow;
                const v = parseInt(cfg.timeWindow, 10);
                localHistMaxSec = (Number.isFinite(v) && v > 0) ? v : 60;
            } else if (cfg.historyBuffer) {
                timeWindowSelect.value = cfg.historyBuffer;
                const v = parseInt(cfg.historyBuffer, 10);
                localHistMaxSec = (Number.isFinite(v) && v > 0) ? v : 60;
            }
            const smoothPlotsSelect = document.getElementById("smoothPlotsSelect");
            if (smoothPlotsSelect && cfg.smoothPlots && /^[1-9][0-9]*$/.test(String(cfg.smoothPlots))) {
                const v = String(cfg.smoothPlots);
                if (["1", "3", "5", "7", "11"].includes(v)) smoothPlotsSelect.value = v;
            }
            if (typeof cfg.hideLevels === "number") {
                hideLevels = cfg.hideLevels;
                if (hideLevelsInput) hideLevelsInput.value = String(hideLevels);
            }
            if (cfg.instance && typeof cfg.instance === "string") {
                savedInstance = cfg.instance.trim();
                if (portSelect && Array.from(portSelect.options).some(o => o.value === savedInstance)) {
                    portSelect.value = savedInstance;
                }
            }
            if (cfg.update_ratio != null) {
                const r = parseInt(cfg.update_ratio, 10);
                if (r >= 1 && intervalInput) intervalInput.value = Math.min(r, parseInt(intervalInput.max, 10) || 100);
            } else if (cfg.interval != null) {
                const r = parseInt(cfg.interval, 10);
                if (r >= 1 && intervalInput) intervalInput.value = Math.min(r, parseInt(intervalInput.max, 10) || 100);
            }
            if (cfg.alarms && typeof cfg.alarms === "object") alarms = cfg.alarms;
            if (Array.isArray(cfg.computedVars)) {
                for (const cv of cfg.computedVars) {
                    if (cv.name && cv.expr) addComputedVar(cv.name, cv.expr);
                }
            }
            if (cfg.varFormat && typeof cfg.varFormat === "object") varFormat = normalizeVarFormatConfig(cfg.varFormat);
            if (cfg.seriesColors && typeof cfg.seriesColors === "object") {
                seriesColorByName = { ...cfg.seriesColors };
                seriesHueByName = {};
            }
            if (cfg.arrayElemAssignment && typeof cfg.arrayElemAssignment === "object") arrayElemAssignment = cfg.arrayElemAssignment;
            if (cfg.lang) {
                currentLang = cfg.lang;
            }
            if (cfg.theme) {
                currentTheme = cfg.theme;
            }
            if (typeof cfg.monitorColumns === "number" && cfg.monitorColumns >= 1 && cfg.monitorColumns <= 3) {
                monitorColumnsCount = cfg.monitorColumns;
            }
            if (typeof cfg.monitorPaneWidth === "number" && Number.isFinite(cfg.monitorPaneWidth) && cfg.monitorPaneWidth > 0) {
                monitorPaneWidthPx = cfg.monitorPaneWidth;
            }
            if (typeof cfg.compactMonitor === "boolean") compactMonitorLevel = cfg.compactMonitor ? 70 : 0;
            if (typeof cfg.compactMonitor === "number") compactMonitorLevel = Math.max(0, Math.min(100, cfg.compactMonitor));
            if (typeof cfg.adaptiveLoad === "boolean") adaptiveLoadEnabled = cfg.adaptiveLoad;
            if (typeof cfg.downsampleMaxPoints === "number" && Number.isFinite(cfg.downsampleMaxPoints)) {
                downsampleMaxPoints = Math.max(200, Math.floor(cfg.downsampleMaxPoints));
            }
            if (Array.isArray(cfg.notesByTs)) notesByTs = cfg.notesByTs;
            if (Array.isArray(cfg.offlineSegments)) offlineSegments = cfg.offlineSegments;
            if (cfg.appMode === "offline" || cfg.appMode === "live" || cfg.appMode === "replay") {
                appMode = cfg.appMode;
            }
            if (typeof cfg.offlineRecordingName === "string") offlineRecordingName = cfg.offlineRecordingName;
            if (offlineSpeedSelect && cfg.offlineSpeed != null) {
                offlineSpeedSelect.value = String(cfg.offlineSpeed);
            }
            if (snapshotFramesInput && Number.isFinite(Number(cfg.snapshotFrames))) {
                snapshotFramesInput.value = String(Math.max(2, Math.floor(Number(cfg.snapshotFrames))));
            }
            if (Number.isFinite(Number(cfg.offlineFullLoadMaxMb))) {
                offlineFullLoadMaxMb = Math.max(5, Math.floor(Number(cfg.offlineFullLoadMaxMb)));
            }
            if (Number.isFinite(Number(cfg.offlinePreviewMb))) {
                offlinePreviewMb = Math.max(1, Math.min(8, Math.floor(Number(cfg.offlinePreviewMb))));
            }
            if (Number.isFinite(Number(cfg.offlineSafePreviewMaxRows))) {
                offlineSafePreviewMaxRows = Math.max(500, Math.floor(Number(cfg.offlineSafePreviewMaxRows)));
            }
            if (Number.isFinite(Number(cfg.offlineSafePreviewMaxSpanSec))) {
                offlineSafePreviewMaxSpanSec = Math.max(5, Math.floor(Number(cfg.offlineSafePreviewMaxSpanSec)));
            }
            if (typeof cfg.offlineAllowForceFullLoad === "boolean") {
                offlineAllowForceFullLoad = cfg.offlineAllowForceFullLoad;
            }
            if (Array.isArray(cfg.impositionNames)) {
                impositionNames = new Set(cfg.impositionNames);
            }
            if (cfg.impositionTimeOffset && typeof cfg.impositionTimeOffset === "object") {
                impositionTimeOffset = { ...cfg.impositionTimeOffset };
            }
            if (cfg.impositionValueOffset && typeof cfg.impositionValueOffset === "object") {
                impositionValueOffset = { ...cfg.impositionValueOffset };
            }
            if (typeof cfg.plotVsRef === "boolean") plotVsRef = cfg.plotVsRef;
            if (offlineFullLoadMaxMbInput) offlineFullLoadMaxMbInput.value = String(offlineFullLoadMaxMb);
            if (offlinePreviewMbInput) offlinePreviewMbInput.value = String(offlinePreviewMb);
            if (offlinePreviewRowsInput) offlinePreviewRowsInput.value = String(offlineSafePreviewMaxRows);
            if (offlinePreviewSpanSecInput) offlinePreviewSpanSecInput.value = String(offlineSafePreviewMaxSpanSec);
            if (offlineAllowForceFullLoadCheckbox) offlineAllowForceFullLoadCheckbox.checked = !!offlineAllowForceFullLoad;
        } catch (e) { /* corrupt data */ }
    }

    function resetConfig() {
        localStorage.removeItem(STORAGE_KEY);
        monitoredNames.clear();
        monitoredOrder = [];
        varGraphAssignment = {};
        historyCache = {};
        graphList = [];
        graphColumns = [];
        alarms = {};
        activeAlarms.clear();
        computedVars = [];
        computedHistories = {};
        varFormat = {};
        seriesColorByName = {};
        seriesHueByName = {};
        arrayElemAssignment = {};
        arrayElemHistory = {};
        monitorPaneWidthPx = null;
        notesByTs = [];
        offlineSegments = [];
        compactMonitorLevel = 0;
        adaptiveLoadEnabled = true;
        downsampleMaxPoints = 2000;
        offlineFullLoadMaxMb = DEFAULT_OFFLINE_FULL_LOAD_MAX_MB;
        offlinePreviewMb = DEFAULT_OFFLINE_PREVIEW_MB;
        offlineSafePreviewMaxRows = DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_ROWS;
        offlineSafePreviewMaxSpanSec = DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_SPAN_SEC;
        offlineAllowForceFullLoad = false;
        arincBusHealth = { totalWords: 0, parityErrors: 0, ssmErrors: 0, unknownLabels: 0, labels: {}, parityByLabel: {}, unknownByLabel: {} };
        layoutHistoryPast = [];
        layoutHistoryFuture = [];
        updateCompactMonitorUi();
        if (adaptiveLoadCheckbox) adaptiveLoadCheckbox.checked = true;
        if (downsampleMaxPointsInput) downsampleMaxPointsInput.value = "2000";
        if (offlineFullLoadMaxMbInput) offlineFullLoadMaxMbInput.value = String(offlineFullLoadMaxMb);
        if (offlinePreviewMbInput) offlinePreviewMbInput.value = String(offlinePreviewMb);
        if (offlinePreviewRowsInput) offlinePreviewRowsInput.value = String(offlineSafePreviewMaxRows);
        if (offlinePreviewSpanSecInput) offlinePreviewSpanSecInput.value = String(offlineSafePreviewMaxSpanSec);
        if (offlineAllowForceFullLoadCheckbox) offlineAllowForceFullLoadCheckbox.checked = !!offlineAllowForceFullLoad;
        renderNotesList();
        renderSegmentsUi();
        renderArincBusHealth();
        applyMonitorPaneWidth();
        sendMonitored();
        renderBrowserList();
        rebuildPlotArea();
        rebuildMonitorList();
        renderPlots();
    }

    loadConfig();
    pruneArincDerivedFromMonitored();
    applyTheme(currentTheme);
    applyLanguage(currentLang);
    applyMonitorColumns();
    updateCompactMonitorUi();
    if (adaptiveLoadCheckbox) adaptiveLoadCheckbox.checked = !!adaptiveLoadEnabled;
    if (compactMonitorSlider) compactMonitorSlider.value = String(compactMonitorLevel);
    if (downsampleMaxPointsInput) downsampleMaxPointsInput.value = String(downsampleMaxPoints);
    renderSegmentsUi();
    renderNotesList();
    renderPerfTelemetry();
    renderArincBusHealth();
    setModeUi();
    (async () => {
        if (appMode !== "offline" || !offlineRecordingName) return;
        try {
            await refreshServerRecordings();
            await loadRecordingFromServer(offlineRecordingName, { preserveLayout: true });
        } catch (e) {
            console.warn("No se pudo restaurar TSV guardado:", offlineRecordingName, e);
        }
    })();
    lastLayoutSnapshot = buildLayoutSnapshot();
    layoutHistoryPast = [lastLayoutSnapshot];

    try {
        const saved = localStorage.getItem(ADV_INFO_STORAGE_KEY) === "1";
        if (advInfoCheckbox) advInfoCheckbox.checked = saved;
        setAdvInfoEnabled(saved);
    } catch (e) {}

    if (advInfoCheckbox) {
        advInfoCheckbox.addEventListener("change", () => {
            setAdvInfoEnabled(advInfoCheckbox.checked);
        });
    }

    try {
        const sendFileSaved = localStorage.getItem(SEND_FILE_ON_FINISH_KEY) === "1";
        if (sendFileOnFinishCheckbox) sendFileOnFinishCheckbox.checked = sendFileSaved;
    } catch (e) {}
    if (sendFileOnFinishCheckbox) {
        sendFileOnFinishCheckbox.addEventListener("change", () => {
            try { localStorage.setItem(SEND_FILE_ON_FINISH_KEY, sendFileOnFinishCheckbox.checked ? "1" : "0"); } catch (e) {}
            sendSendFileOnFinish();
        });
    }

    if (modeSelect) {
        modeSelect.value = appMode;
        modeSelect.addEventListener("change", async () => {
            const v = (modeSelect.value || "").trim();
            const nextMode = v === "offline" ? "offline" : (v === "replay" ? "replay" : "live");
            setAppMode(nextMode);
            if (nextMode === "offline" || nextMode === "replay") {
                await refreshServerRecordings();
            }
        });
    }
    if (loadLocalTsvBtn && localTsvInput) {
        loadLocalTsvBtn.addEventListener("click", () => localTsvInput.click());
        localTsvInput.addEventListener("change", async () => {
            const f = localTsvInput.files && localTsvInput.files[0];
            if (!f) return;
            try {
                let ds;
                let safeInfo = null;
                if (shouldUseSafeOfflineLoad(f.size)) {
                    const previewBytes = Math.max(1, Math.floor(offlinePreviewMb * 1024 * 1024));
                    const previewRaw = await f.slice(0, previewBytes).text();
                    const previewText = trimTextToFullLines(previewRaw);
                    const risk = estimateTsvLoadRisk(previewText, Number(f.size) || 0);
                    const forceFull = shouldForceFullLoadWithConfirmation(f.name, Number(f.size) || 0, risk.estRamBytes);
                    if (forceFull) {
                        const text = await f.text();
                        ds = parseTsvDataset(text, f.name);
                    } else {
                        const safe = await loadLargeLocalFileInSafeMode(f);
                        ds = safe.ds;
                        safeInfo = safe.safeInfo;
                    }
                } else {
                    const text = await f.text();
                    ds = parseTsvDataset(text, f.name);
                }
                if (!isPlaybackMode()) setAppMode("offline", { keepData: true });
                loadOfflineDataset(ds, { target: "A", recordingName: "", safeInfo });
            } catch (e) {
                alert("Error cargando TSV: " + (e && e.message ? e.message : String(e)));
            } finally {
                localTsvInput.value = "";
            }
        });
    }
    if (loadServerRecordingBtn && recordingSelect) {
        loadServerRecordingBtn.addEventListener("click", async () => {
            const fn = (recordingSelect.value || "").trim();
            if (!fn) return;
            try {
                if (!isPlaybackMode()) setAppMode("offline", { keepData: true });
                await loadRecordingFromServer(fn, { preserveLayout: false, target: "A" });
            } catch (e) {
                alert("Error cargando grabación: " + (e && e.message ? e.message : String(e)));
            }
        });
    }
    const offlineChunkPrevBtn = document.getElementById("offlineChunkPrevBtn");
    const offlineChunkNextBtn = document.getElementById("offlineChunkNextBtn");
    if (offlineChunkPrevBtn) {
        offlineChunkPrevBtn.addEventListener("click", () => {
            if (!offlineSafetyInfo || !offlineSafetyInfo.safeMode) return;
            const previewBytes = Math.max(1, Math.floor(offlinePreviewMb * 1024 * 1024));
            const nextOffset = Math.max(0, (offlineSafetyInfo.segmentStartByte || 0) - previewBytes);
            loadRecordingChunkAtOffset(nextOffset);
        });
    }
    if (offlineChunkNextBtn) {
        offlineChunkNextBtn.addEventListener("click", () => {
            if (!offlineSafetyInfo || !offlineSafetyInfo.safeMode) return;
            const nextOffset = offlineSafetyInfo.segmentEndByte || 0;
            if (nextOffset >= (offlineSafetyInfo.totalBytes || 0)) return;
            loadRecordingChunkAtOffset(nextOffset);
        });
    }
    if (offlineSpeedSelect) {
        offlineSpeedSelect.addEventListener("change", () => {
            const v = Number(offlineSpeedSelect.value);
            offlinePlayback.speed = Number.isFinite(v) && v > 0 ? v : 1;
            saveConfig();
        });
    }
    if (offlineScrubber) {
        offlineScrubber.addEventListener("input", () => {
            if (!offlineDataset) return;
            const ratio = (parseInt(offlineScrubber.value, 10) || 0) / 1000;
            const minTs = Number.isFinite(offlineRecordingGlobalMinTs)
                ? offlineRecordingGlobalMinTs
                : offlineDataset.minTs;
            const maxTs = Number.isFinite(offlineRecordingGlobalMaxTs)
                ? offlineRecordingGlobalMaxTs
                : offlineDataset.maxTs;
            const span = Math.max(1e-9, maxTs - minTs);
            const ts = minTs + span * ratio;
            applyOfflineTime(ts);
            schedulePlotRender();
        });
    }
    if (offlineStepPrevBtn) {
        offlineStepPrevBtn.addEventListener("click", () => stepOfflineBySample(-1));
    }
    if (offlineStepNextBtn) {
        offlineStepNextBtn.addEventListener("click", () => stepOfflineBySample(1));
    }
    if (offlinePlayPauseBtn) {
        offlinePlayPauseBtn.addEventListener("click", () => {
            if (!offlineDataset) return;
            if (offlinePlayback.isPlaying) {
                stopOfflinePlayback();
            } else {
                startOfflinePlayback();
            }
        });
    }
    if (setMarkerABtn) {
        setMarkerABtn.addEventListener("click", () => {
            markerA = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : null;
            recomputeDeltaByName();
            updateMarkerInfoLabel();
            updateMonitorValues();
            rebuildMonitorList();
            schedulePlotRender();
        });
    }
    if (setMarkerBBtn) {
        setMarkerBBtn.addEventListener("click", () => {
            markerB = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : null;
            recomputeDeltaByName();
            updateMarkerInfoLabel();
            updateMonitorValues();
            rebuildMonitorList();
            schedulePlotRender();
        });
    }
    if (clearMarkersBtn) {
        clearMarkersBtn.addEventListener("click", () => {
            markerA = null;
            markerB = null;
            deltaByName = {};
            updateMarkerInfoLabel();
            updateMonitorValues();
            rebuildMonitorList();
            schedulePlotRender();
        });
    }
    if (toggleAdvancedPlotBtn) {
        toggleAdvancedPlotBtn.addEventListener("click", () => {
            advancedPlotOpen = !advancedPlotOpen;
            updateAdvancedPlotPanelVisibility();
        });
    }
    if (runAnomalyScanBtn) {
        runAnomalyScanBtn.addEventListener("click", () => {
            runAnomalyScan();
            schedulePlotRender();
        });
    }
    if (clearAnomalyScanBtn) {
        clearAnomalyScanBtn.addEventListener("click", () => {
            anomalyResults = [];
            renderAnomalyList();
            schedulePlotRender();
        });
    }
    if (prevEventBtn) {
        prevEventBtn.addEventListener("click", () => {
            if (!anomalyResults.length) return;
            eventCursorIndex = Math.max(0, eventCursorIndex <= 0 ? anomalyResults.length - 1 : eventCursorIndex - 1);
            const ev = anomalyResults[eventCursorIndex];
            if (ev) { applyOfflineTime(ev.ts); schedulePlotRender(); }
        });
    }
    if (nextEventBtn) {
        nextEventBtn.addEventListener("click", () => {
            if (!anomalyResults.length) return;
            eventCursorIndex = (eventCursorIndex + 1) % anomalyResults.length;
            const ev = anomalyResults[eventCursorIndex];
            if (ev) { applyOfflineTime(ev.ts); schedulePlotRender(); }
        });
    }
    if (addNoteBtn) {
        addNoteBtn.addEventListener("click", () => {
            if (!offlineDataset || !Number.isFinite(offlinePlayback.currentTs)) return;
            const txt = prompt("Nota para este timestamp:");
            if (!txt) return;
            notesByTs.push({ ts: offlinePlayback.currentTs, text: txt.trim() });
            if (notesByTs.length > 300) notesByTs = notesByTs.slice(-300);
            renderNotesList();
            saveConfig();
        });
    }
    function getOfflineValueFromSample(sample, name) {
        if (!sample || !Array.isArray(sample.data)) return "";
        const arrMatch = /^(.+)\[(\d+)\]$/.exec(String(name || ""));
        if (arrMatch) {
            const base = arrMatch[1];
            const idx = parseInt(arrMatch[2], 10);
            const entry = sample.data.find((e) => e && e.name === base && Array.isArray(e.value));
            if (!entry || !Array.isArray(entry.value) || idx < 0 || idx >= entry.value.length) return "";
            const v = entry.value[idx];
            return v == null ? "" : String(v);
        }
        const entry = sample.data.find((e) => e && e.name === name);
        if (!entry) return "";
        if (Array.isArray(entry.value)) return entry.value.map((v) => (v == null ? "" : String(v))).join(",");
        return entry.value == null ? "" : String(entry.value);
    }

    function buildColumnsSpecFromOfflineSamples(samples, names) {
        const specs = [];
        for (const name of names) {
            const arrMatch = /^(.+)\[(\d+)\]$/.exec(String(name || ""));
            if (arrMatch) {
                specs.push({ type: "scalar", name });
                continue;
            }
            let maxLen = 0;
            for (const s of samples) {
                if (!s || !Array.isArray(s.data)) continue;
                const e = s.data.find((it) => it && it.name === name && Array.isArray(it.value));
                if (e && Array.isArray(e.value) && e.value.length > maxLen) maxLen = e.value.length;
            }
            if (maxLen > 0) specs.push({ type: "array", name, size: maxLen });
            else specs.push({ type: "scalar", name });
        }
        return specs;
    }

    function buildTsvFromOfflineSamples(samples, names) {
        const safeSamples = Array.isArray(samples) ? samples : [];
        if (!safeSamples.length || !Array.isArray(names) || !names.length) return null;
        const specs = buildColumnsSpecFromOfflineSamples(safeSamples, names);
        const t0 = Number(safeSamples[0] && safeSamples[0].ts);
        const header = ["time_s"];
        specs.forEach((sp) => {
            if (sp.type === "array") {
                for (let i = 0; i < sp.size; i++) header.push(`${sp.name}_${i}`);
            } else {
                header.push(sp.name);
            }
        });
        const lines = [header.join("\t")];
        for (const s of safeSamples) {
            const ts = Number(s && s.ts);
            if (!Number.isFinite(ts)) continue;
            const rel = Number.isFinite(t0) ? Math.max(0, ts - t0) : ts;
            const row = [rel.toFixed(6)];
            for (const sp of specs) {
                if (sp.type === "array") {
                    const arrEntry = (s.data || []).find((e) => e && e.name === sp.name && Array.isArray(e.value));
                    const arr = arrEntry && Array.isArray(arrEntry.value) ? arrEntry.value : [];
                    for (let i = 0; i < sp.size; i++) {
                        const v = i < arr.length ? arr[i] : "";
                        row.push(v == null ? "" : String(v));
                    }
                } else {
                    row.push(getOfflineValueFromSample(s, sp.name));
                }
            }
            lines.push(row.join("\t"));
        }
        return lines.join("\n") + "\n";
    }

    function buildTsvFromLiveHistory(frameCount, names) {
        const scalarNames = [];
        const arraySpecs = [];
        for (const name of names) {
            const arrMatch = /^(.+)\[(\d+)\]$/.exec(String(name || ""));
            if (arrMatch) {
                scalarNames.push(name);
                continue;
            }
            const vd = varsByName[name];
            let size = Array.isArray(vd?.value) ? vd.value.length : 0;
            for (const key of Object.keys(arrayElemHistory)) {
                const m = /^(.+)\[(\d+)\]$/.exec(key);
                if (!m || m[1] !== name) continue;
                size = Math.max(size, Number(m[2]) + 1);
            }
            if (size > 0) arraySpecs.push({ name, size });
            else scalarNames.push(name);
        }
        const header = ["time_s"];
        scalarNames.forEach((n) => header.push(n));
        arraySpecs.forEach((sp) => { for (let i = 0; i < sp.size; i++) header.push(`${sp.name}_${i}`); });
        const lines = [header.join("\t")];

        let refTs = null;
        for (const n of scalarNames) {
            const h = historyCache[n];
            if (h && Array.isArray(h.timestamps) && h.timestamps.length) { refTs = h.timestamps; break; }
        }
        if (!refTs) {
            for (const sp of arraySpecs) {
                const h0 = arrayElemHistory[`${sp.name}[0]`];
                if (h0 && Array.isArray(h0.timestamps) && h0.timestamps.length) { refTs = h0.timestamps; break; }
            }
        }
        if (!refTs || refTs.length === 0) return lines.join("\n") + "\n";

        const start = Math.max(0, refTs.length - Math.max(2, frameCount));
        const t0 = Number(refTs[start]);
        for (let i = start; i < refTs.length; i++) {
            const ts = Number(refTs[i]);
            const rel = (Number.isFinite(ts) && Number.isFinite(t0)) ? Math.max(0, ts - t0) : ts;
            const row = [Number.isFinite(rel) ? rel.toFixed(6) : ""];
            for (const n of scalarNames) {
                const h = historyCache[n];
                const v = (h && Array.isArray(h.values) && i < h.values.length) ? h.values[i] : "";
                row.push(v == null ? "" : String(v));
            }
            for (const sp of arraySpecs) {
                for (let k = 0; k < sp.size; k++) {
                    const h = arrayElemHistory[`${sp.name}[${k}]`];
                    const v = (h && Array.isArray(h.values) && i < h.values.length) ? h.values[i] : "";
                    row.push(v == null ? "" : String(v));
                }
            }
            lines.push(row.join("\t"));
        }
        return lines.join("\n") + "\n";
    }

    function buildSnapshotTsv(frameCount) {
        const names = monitoredOrder.slice();
        if (!names.length) return null;
        if (isPlaybackMode() && offlineDataset && Array.isArray(offlineDataset.samples) && offlineDataset.samples.length) {
            const idx = Math.max(0, Math.min(offlineDataset.samples.length - 1, binarySearchSampleIndex(offlineDataset.samples, offlinePlayback.currentTs || offlineDataset.minTs)));
            const half = Math.floor(frameCount / 2);
            const start = Math.max(0, idx - half);
            const end = Math.min(offlineDataset.samples.length - 1, start + frameCount - 1);
            const subset = offlineDataset.samples.slice(start, end + 1);
            return buildTsvFromOfflineSamples(subset, names);
        } else {
            return buildTsvFromLiveHistory(frameCount, names);
        }
    }

    function buildLocalFrontendSample(ts) {
        const row = [];
        for (const name of monitoredOrder) {
            if (isArrayElem(name)) {
                const v = getNumericValueForAlarmName(name);
                if (Number.isFinite(v)) row.push({ name, type: "double", value: v, timestamp: ts });
                continue;
            }
            const vd = varsByName[name];
            if (!vd) continue;
            if (Array.isArray(vd.value)) row.push({ name, type: "array", value: vd.value.slice(), timestamp: ts });
            else row.push({ name, type: vd.type || "double", value: vd.value, timestamp: ts });
        }
        return { ts, data: row };
    }

    function updateLocalRecordBtnUi() {
        if (!localRecordBtn) return;
        localRecordBtn.textContent = isLocalRecording ? "■ Stop local" : "● Rec local";
        localRecordBtn.classList.toggle("recording", !!isLocalRecording);
    }

    async function stopLocalRecording(saveFile = true) {
        if (!isLocalRecording && localRecordSamples.length === 0) return;
        isLocalRecording = false;
        updateLocalRecordBtnUi();
        if (!saveFile) { localRecordSamples = []; return; }
        const names = monitoredOrder.slice();
        const tsv = buildTsvFromOfflineSamples(localRecordSamples, names);
        localRecordSamples = [];
        if (!tsv) return;
        const d = new Date();
        const fname = `localrec_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}.tsv`;
        try {
            await saveTsvToServer(tsv, { kind: "snapshot", filename: fname });
        } catch (e) {
            alert("No se pudo guardar REC local: " + (e && e.message ? e.message : String(e)));
        }
    }

    function startLocalRecording() {
        if (!isLiveMode()) return;
        isLocalRecording = true;
        localRecordSamples = [];
        updateLocalRecordBtnUi();
    }
    async function saveTsvToServer(tsvContent, opts = {}) {
        const kind = opts.kind || "snapshot";
        const filename = opts.filename || "";
        const download = (sendFileOnFinishCheckbox && sendFileOnFinishCheckbox.checked) ? 1 : 0;
        const r = await fetch(`/api/save_tsv?kind=${encodeURIComponent(kind)}&download=${download}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: tsvContent, filename }),
        });
        if (!r.ok) {
            let msg = "No se pudo guardar TSV en servidor";
            try {
                const err = await r.json();
                if (err && err.error) msg += `: ${err.error}`;
            } catch (e) {}
            throw new Error(msg);
        }
        const isDownloadResponse = (r.headers.get("content-type") || "").includes("tab-separated-values");
        let d = null;
        if (isDownloadResponse) {
            const blob = await r.blob();
            const disp = r.headers.get("content-disposition") || "";
            let dlName = filename || `${kind}.tsv`;
            const m = /filename="?([^"]+)"?/i.exec(disp);
            if (m && m[1]) dlName = m[1];
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = dlName;
            a.click();
            URL.revokeObjectURL(a.href);
            d = { filename: dlName, path: dlName };
        } else {
            d = await r.json();
            if (download && d && d.filename) {
                const dl = await fetch("/api/recordings/" + encodeURIComponent(d.filename));
                if (dl.ok) {
                    const blob = await dl.blob();
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = d.filename;
                    a.click();
                    URL.revokeObjectURL(a.href);
                }
            }
        }
        if (d && d.path) showRecordPathToast(d.path, { filename: d.filename || "" });
        return d;
    }
    if (snapshotBtn) {
        snapshotBtn.addEventListener("click", async () => {
            const frameCount = Math.max(2, Math.floor(Number(snapshotFramesInput ? snapshotFramesInput.value : 40) || 40));
            if (snapshotFramesInput) snapshotFramesInput.value = String(frameCount);
            const d = new Date();
            const defaultName = `snapshot_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}.tsv`;
            const tsv = buildSnapshotTsv(frameCount);
            if (!tsv) return;
            try { await saveTsvToServer(tsv, { kind: "snapshot", filename: defaultName }); }
            catch (e) { alert("No se pudo guardar snapshot: " + (e && e.message ? e.message : String(e))); }
            saveConfig();
        });
    }
    if (localRecordBtn) {
        localRecordBtn.addEventListener("click", async () => {
            if (!isLiveMode()) return;
            if (isLocalRecording) await stopLocalRecording(true);
            else startLocalRecording();
        });
        updateLocalRecordBtnUi();
    }
    if (exportPdfReportBtn) {
        exportPdfReportBtn.addEventListener("click", async () => {
            const prevExpanded = new Set(expandedStats);
            try {
                for (const n of monitoredOrder) expandedStats.add(n);
                rebuildMonitorList();
                updateMonitorValues();
                const rows = anomalyResults.slice(0, 200).map((a) => {
                    const rel = offlineDataset ? (a.ts - offlineDataset.minTs) : a.ts;
                    return `<tr><td>${rel.toFixed(3)}s</td><td>${a.name}</td><td>${a.type}</td><td>${a.detail}</td></tr>`;
                }).join("");
                const monitorRows = Array.from(monitorListEl.querySelectorAll(".monitor-item-wrap")).map((w) => {
                    const nm = w.querySelector(".mon-name")?.textContent?.trim() || "";
                    const vv = w.querySelector(".mon-value")?.textContent?.trim() || "";
                    const stats = w.querySelector(".stats-panel")?.innerText?.trim() || "";
                    return `<tr><td>${nm}</td><td>${vv}</td><td><pre style="margin:0;white-space:pre-wrap">${stats || "-"}</pre></td></tr>`;
                }).join("");
                const imgs = [];
                const plotEls = Array.from(plotArea.querySelectorAll(".js-plotly-plot"));
                for (const el of plotEls) {
                    try {
                        const img = await Plotly.toImage(el, { format: "png", width: 1200, height: 420, scale: 1 });
                        imgs.push(`<img src="${img}" style="width:100%;max-width:1200px;display:block;margin:8px 0;">`);
                    } catch (e) {}
                }
                const w = window.open("", "_blank");
                if (!w) return;
                w.document.write(`<html><head><title>VarMonitor Report</title></head><body><h2>Reporte VarMonitor</h2><h3>Monitor actual</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>Variable</th><th>Valor</th><th>Detalle</th></tr>${monitorRows}</table><h3>Graficas actuales</h3>${imgs.join("") || "<p>(sin graficas)</p>"}<h3>Anomalias</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>t</th><th>Var</th><th>Tipo</th><th>Detalle</th></tr>${rows}</table><script>window.print();<\/script></body></html>`);
                w.document.close();
            } finally {
                expandedStats.clear();
                prevExpanded.forEach((n) => expandedStats.add(n));
                rebuildMonitorList();
                updateMonitorValues();
            }
        });
    }
    if (segStartBtn) {
        segStartBtn.addEventListener("click", () => {
            if (!offlineDataset) return;
            segmentDraft.start = offlinePlayback.currentTs;
            renderSegmentsUi();
        });
    }
    if (segEndBtn) {
        segEndBtn.addEventListener("click", () => {
            if (!offlineDataset) return;
            segmentDraft.end = offlinePlayback.currentTs;
            renderSegmentsUi();
        });
    }
    if (segSaveBtn) {
        segSaveBtn.addEventListener("click", () => {
            if (!Number.isFinite(segmentDraft.start) || !Number.isFinite(segmentDraft.end)) return;
            const start = Math.min(segmentDraft.start, segmentDraft.end);
            const end = Math.max(segmentDraft.start, segmentDraft.end);
            const name = prompt("Nombre del segmento:", `Seg ${offlineSegments.length + 1}`) || `Seg ${offlineSegments.length + 1}`;
            offlineSegments.push({ name, start, end });
            if (offlineSegments.length > 200) offlineSegments = offlineSegments.slice(-200);
            renderSegmentsUi();
            saveConfig();
        });
    }
    if (segCutBtn) {
        segCutBtn.addEventListener("click", async () => {
            if (!offlineDataset) { alert("No hay dataset offline cargado."); return; }
            let start = Number.NaN;
            let end = Number.NaN;
            if (Number.isFinite(segmentDraft.start) && Number.isFinite(segmentDraft.end)) {
                start = Math.min(segmentDraft.start, segmentDraft.end);
                end = Math.max(segmentDraft.start, segmentDraft.end);
            } else {
                const idxSel = parseInt(segmentSelectEl?.value || "-1", 10);
                if (Number.isFinite(idxSel) && idxSel >= 0 && idxSel < offlineSegments.length) {
                    const seg = offlineSegments[idxSel];
                    start = Math.min(Number(seg.start), Number(seg.end));
                    end = Math.max(Number(seg.start), Number(seg.end));
                }
            }
            if (!Number.isFinite(start) || !Number.isFinite(end)) { alert("Marca Inicio y Fin o selecciona un segmento guardado."); return; }
            const names = Array.isArray(offlineDataset.names) ? offlineDataset.names.slice() : [];
            if (!names.length || !Array.isArray(offlineDataset.samples) || !offlineDataset.samples.length) { alert("No hay datos para cortar."); return; }
            let i0 = Math.max(0, Math.min(offlineDataset.samples.length - 1, binarySearchSampleIndex(offlineDataset.samples, start)));
            let i1 = Math.max(0, Math.min(offlineDataset.samples.length - 1, binarySearchSampleIndex(offlineDataset.samples, end)));
            if (i0 > i1) { const t = i0; i0 = i1; i1 = t; }
            while (i0 > 0 && Number(offlineDataset.samples[i0].ts) > start) i0 -= 1;
            while (i1 < offlineDataset.samples.length - 1 && Number(offlineDataset.samples[i1].ts) < end) i1 += 1;
            let selected = [];
            for (let i = i0; i <= i1; i++) {
                const s = offlineDataset.samples[i];
                const t = Number(s.ts);
                if (!Number.isFinite(t)) continue;
                selected.push(s);
            }
            if (selected.length <= 0) {
                const frameCount = Math.max(2, Math.floor(Number(snapshotFramesInput ? snapshotFramesInput.value : 40) || 40));
                const centerIdx = Math.max(0, Math.min(offlineDataset.samples.length - 1, binarySearchSampleIndex(offlineDataset.samples, offlinePlayback.currentTs || start)));
                const from = Math.max(0, centerIdx - Math.floor(frameCount / 2));
                const to = Math.min(offlineDataset.samples.length - 1, from + frameCount - 1);
                for (let i = from; i <= to; i++) {
                    const s = offlineDataset.samples[i];
                    const t = Number(s.ts);
                    if (!Number.isFinite(t)) continue;
                    selected.push(s);
                }
            }
            const tsvOut = buildTsvFromOfflineSamples(selected, names);
            if (!tsvOut || tsvOut.trim().split("\n").length <= 1) { alert("No hay muestras dentro del rango seleccionado."); return; }
            const base = offlineRecordingName || (offlineDataset.sourceName || "dataset.tsv");
            const fname = `segment_${base.replace(/\.tsv$/i, "")}_${Math.max(0, start - offlineDataset.minTs).toFixed(3)}_${Math.max(0, end - offlineDataset.minTs).toFixed(3)}.tsv`.replace(/[^\w.\-]+/g, "_");
            try {
                await saveTsvToServer(tsvOut, { kind: "segment", filename: fname });
                await refreshServerRecordings();
            } catch (e) {
                alert("No se pudo cortar segmento: " + (e && e.message ? e.message : String(e)));
            }
        });
    }
    if (segmentGoBtn) {
        segmentGoBtn.addEventListener("click", () => {
            const idx = parseInt(segmentSelectEl?.value || "-1", 10);
            if (!Number.isFinite(idx) || idx < 0 || idx >= offlineSegments.length) return;
            applyOfflineTime(offlineSegments[idx].start);
            schedulePlotRender();
        });
    }
    const handleOfflineArrowSeek = (e) => {
        if (!isPlaybackMode() || !offlineDataset || !Array.isArray(offlineDataset.samples) || offlineDataset.samples.length < 2) return;
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const tag = (document.activeElement && document.activeElement.tagName) ? document.activeElement.tagName.toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        e.preventDefault();
        const idx = Math.max(0, Math.min(offlineDataset.samples.length - 1, binarySearchSampleIndex(offlineDataset.samples, offlinePlayback.currentTs || offlineDataset.minTs)));
        const nextIdx = e.key === "ArrowLeft" ? Math.max(0, idx - 1) : Math.min(offlineDataset.samples.length - 1, idx + 1);
        applyOfflineTime(offlineDataset.samples[nextIdx].ts);
        schedulePlotRender();
    };
    window.addEventListener("keydown", handleOfflineArrowSeek, true);
    if (downsampleMaxPointsInput) {
        downsampleMaxPointsInput.addEventListener("change", () => {
            const v = Number(downsampleMaxPointsInput.value);
            downsampleMaxPoints = Number.isFinite(v) ? Math.max(200, Math.floor(v)) : 2000;
            downsampleMaxPointsInput.value = String(downsampleMaxPoints);
            renderPerfTelemetry();
            saveConfig();
            schedulePlotRender();
        });
    }

    resetConfigBtn.addEventListener("click", resetConfig);

    // --- Help modal ---
    const helpOverlay = document.getElementById("helpOverlay");
    document.getElementById("helpBtn").addEventListener("click", () => {
        helpOverlay.style.display = "flex";
    });
    const docsBtn = document.getElementById("docsBtn");
    const docsLangOverlay = document.getElementById("docsLangOverlay");
    const docsLangCloseBtn = document.getElementById("docsLangCloseBtn");
    const docsOpenEsBtn = document.getElementById("docsOpenEsBtn");
    const docsOpenEnBtn = document.getElementById("docsOpenEnBtn");
    const docsLangNotBuilt = document.getElementById("docsLangNotBuilt");

    function closeDocsLangModal() {
        if (docsLangOverlay) docsLangOverlay.style.display = "none";
    }

    async function refreshDocsLangAvailability() {
        const tr = I18N[currentLang] || I18N.es;
        let es = false;
        let en = false;
        try {
            const r = await fetch("/api/docs_languages");
            if (r.ok) {
                const j = await r.json();
                es = !!j.es;
                en = !!j.en;
            }
        } catch (err) {
            console.warn("docs_languages:", err);
        }
        if (docsOpenEsBtn) {
            docsOpenEsBtn.style.display = es ? "" : "none";
            docsOpenEsBtn.disabled = !es;
        }
        if (docsOpenEnBtn) {
            docsOpenEnBtn.style.display = en ? "" : "none";
            docsOpenEnBtn.disabled = !en;
        }
        if (docsLangNotBuilt) {
            const none = !es && !en;
            docsLangNotBuilt.style.display = none ? "block" : "none";
            if (none && tr.docsNotBuiltMsg) docsLangNotBuilt.textContent = tr.docsNotBuiltMsg;
        }
    }

    if (docsBtn && docsLangOverlay) {
        docsBtn.addEventListener("click", async () => {
            docsLangOverlay.style.display = "flex";
            await refreshDocsLangAvailability();
        });
    }
    if (docsLangCloseBtn) {
        docsLangCloseBtn.addEventListener("click", closeDocsLangModal);
    }
    if (docsLangOverlay) {
        docsLangOverlay.addEventListener("click", (e) => {
            if (e.target === docsLangOverlay) closeDocsLangModal();
        });
    }
    if (docsOpenEsBtn) {
        docsOpenEsBtn.addEventListener("click", () => {
            window.open("/docs/es/", "_blank", "noopener,noreferrer");
            closeDocsLangModal();
        });
    }
    if (docsOpenEnBtn) {
        docsOpenEnBtn.addEventListener("click", () => {
            window.open("/docs/en/", "_blank", "noopener,noreferrer");
            closeDocsLangModal();
        });
    }
    document.getElementById("helpCloseBtn").addEventListener("click", () => {
        helpOverlay.style.display = "none";
    });
    helpOverlay.addEventListener("click", (e) => {
        if (e.target === helpOverlay) helpOverlay.style.display = "none";
    });

    // --- Toolbar lista de monitorización (filtro, seleccionar todas) ---
    if (monitorFilterInput) {
        monitorFilterInput.addEventListener("input", () => {
            monitorFilterText = (monitorFilterInput.value || "").trim();
            rebuildMonitorList();
        });
    }
    if (monitorSelectAllBtn) {
        monitorSelectAllBtn.addEventListener("click", () => {
            getVisibleMonitorNames().forEach(n => monitorSelectedNames.add(n));
            rebuildMonitorList();
        });
    }
    if (monitorDeselectAllBtn) {
        monitorDeselectAllBtn.addEventListener("click", () => {
            monitorSelectedNames.clear();
            rebuildMonitorList();
        });
    }
    if (monitorSortByNameBtn) {
        monitorSortByNameBtn.addEventListener("click", () => {
            monitoredOrder.sort((a, b) => (a || "").localeCompare(b || ""));
            rebuildMonitorList();
            saveConfig();
        });
    }
    if (monitorSortByGraphBtn) {
        monitorSortByGraphBtn.addEventListener("click", () => {
            monitoredOrder.sort((a, b) => {
                const aHas = !!(varGraphAssignment[a] && graphList.includes(varGraphAssignment[a]));
                const bHas = !!(varGraphAssignment[b] && graphList.includes(varGraphAssignment[b]));
                if (aHas && !bHas) return -1;
                if (!aHas && bHas) return 1;
                return (a || "").localeCompare(b || "");
            });
            rebuildMonitorList();
            saveConfig();
        });
    }
    if (monitorSortByTsvBtn) {
        monitorSortByTsvBtn.addEventListener("click", () => {
            monitoredOrder.sort((a, b) => {
                const aIn = isVarInTsv(a);
                const bIn = isVarInTsv(b);
                if (aIn && !bIn) return -1;
                if (!aIn && bIn) return 1;
                return (a || "").localeCompare(b || "");
            });
            rebuildMonitorList();
            saveConfig();
        });
    }

    // --- Visor de log del servidor ---
    const logBtn = document.getElementById("logBtn");
    const logOverlay = document.getElementById("logOverlay");
    const logCloseBtn = document.getElementById("logCloseBtn");
    const logRefreshBtn = document.getElementById("logRefreshBtn");
    const logAutoRefreshCheckbox = document.getElementById("logAutoRefreshCheckbox");
    const logSourceSelect = document.getElementById("logSourceSelect");
    const logViewerContent = document.getElementById("logViewerContent");
    const logFilterInput = document.getElementById("logFilterInput");
    const logSaveBtn = document.getElementById("logSaveBtn");
    let logAutoRefreshInterval = null;
    let logViewerRawLines = [];

    function escapeLogHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function logLineClass(line) {
        const l = line.toLowerCase();
        if (/\b(200|ok|success)\b/.test(l) || /-> 200\b/.test(line)) return "log-line-ok";
        if (/\b(500|404|503|error|exception|failed|fail|incorrecta|denied)\b/.test(l) || /-> (4|5)\d{2}\b/.test(line)) return "log-line-error";
        if (/\b(4\d{2}|warn|warning|aviso)\b/.test(l)) return "log-line-warn";
        if (/\[req\]/.test(l)) return "log-line-req";
        return "";
    }

    function applyLogViewerFilter() {
        if (!logViewerContent) return;
        const q = (logFilterInput && logFilterInput.value) ? logFilterInput.value.trim().toLowerCase() : "";
        const lines = q
            ? logViewerRawLines.filter((line) => line.toLowerCase().includes(q))
            : logViewerRawLines;
        if (lines.length === 0) {
            logViewerContent.textContent = q ? "(ninguna línea coincide con el filtro)" : "(vacío)";
            logViewerContent.className = "log-viewer-content";
            return;
        }
        const cls = "log-viewer-content";
        const html = lines
            .map((line) => {
                const c = logLineClass(line);
                return '<span class="log-line ' + (c ? c : "") + '">' + escapeLogHtml(line) + "</span>\n";
            })
            .join("");
        logViewerContent.innerHTML = html;
        logViewerContent.className = cls;
        logViewerContent.scrollTop = logViewerContent.scrollHeight;
    }

    async function fetchLogViewer() {
        if (!logViewerContent) return;
        const source = (logSourceSelect && logSourceSelect.value) || "python";
        try {
            const r = await fetch(`/api/log?tail=2000&source=${encodeURIComponent(source)}`);
            if (!r.ok) {
                logViewerRawLines = [`Error ${r.status}: ${r.statusText}`];
                applyLogViewerFilter();
                return;
            }
            const contentType = r.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
                const data = await r.json();
                logViewerRawLines = (data.lines || []).map((x) =>
                    (x.ts ? x.ts + " " : "") + (x.msg || "")
                );
            } else {
                const text = await r.text() || "";
                logViewerRawLines = text ? text.split("\n") : [];
            }
            applyLogViewerFilter();
        } catch (e) {
            logViewerRawLines = ["Error al cargar el registro: " + (e.message || String(e))];
            applyLogViewerFilter();
        }
    }

    function downloadLogViewer() {
        const text = logViewerContent ? logViewerContent.textContent : "";
        if (!text) return;
        const now = new Date();
        const stamp =
            now.getFullYear() +
            String(now.getMonth() + 1).padStart(2, "0") +
            String(now.getDate()).padStart(2, "0") +
            "_" +
            String(now.getHours()).padStart(2, "0") +
            String(now.getMinutes()).padStart(2, "0") +
            String(now.getSeconds()).padStart(2, "0");
        const name = "varmon_log_" + stamp + ".txt";
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }

    if (logBtn && logOverlay) {
        logBtn.addEventListener("click", () => {
            logOverlay.style.display = "flex";
            fetchLogViewer();
        });
    }
    if (logCloseBtn && logOverlay) {
        logCloseBtn.addEventListener("click", () => {
            logOverlay.style.display = "none";
            if (logAutoRefreshInterval) {
                clearInterval(logAutoRefreshInterval);
                logAutoRefreshInterval = null;
            }
            if (logAutoRefreshCheckbox) logAutoRefreshCheckbox.checked = false;
        });
    }
    logOverlay.addEventListener("click", (e) => {
        if (e.target === logOverlay) {
            logOverlay.style.display = "none";
            if (logAutoRefreshInterval) {
                clearInterval(logAutoRefreshInterval);
                logAutoRefreshInterval = null;
            }
            if (logAutoRefreshCheckbox) logAutoRefreshCheckbox.checked = false;
        }
    });
    if (logRefreshBtn) {
        logRefreshBtn.addEventListener("click", () => fetchLogViewer());
    }
    if (logAutoRefreshCheckbox) {
        logAutoRefreshCheckbox.addEventListener("change", () => {
            if (logAutoRefreshCheckbox.checked) {
                if (logAutoRefreshInterval) clearInterval(logAutoRefreshInterval);
                logAutoRefreshInterval = setInterval(() => {
                    if (logOverlay && logOverlay.style.display === "flex") fetchLogViewer();
                }, 4000);
            } else {
                if (logAutoRefreshInterval) {
                    clearInterval(logAutoRefreshInterval);
                    logAutoRefreshInterval = null;
                }
            }
        });
    }
    if (logSourceSelect) {
        logSourceSelect.addEventListener("change", () => fetchLogViewer());
    }
    if (logFilterInput) {
        logFilterInput.addEventListener("input", () => applyLogViewerFilter());
        logFilterInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                logFilterInput.value = "";
                applyLogViewerFilter();
            }
        });
    }
    if (logSaveBtn) {
        logSaveBtn.addEventListener("click", () => downloadLogViewer());
    }

    // --- Variable browser drawer (columna 1 como panel lateral derecho) ---

    const browserToggleBtn = document.getElementById("browserToggleBtn");
    const varDrawer = document.getElementById("varDrawer");
    const browserCloseBtn = document.getElementById("browserCloseBtn");
    const colMonitorEl = document.querySelector(".col-monitor");
    let varDrawerMeasureEl = null;

    function estimateVarDrawerDesiredWidth() {
        const baseWidth = 300;
        if (!Array.isArray(knownVarNames) || knownVarNames.length === 0) return baseWidth;
        let longest = "";
        for (let i = 0; i < knownVarNames.length; i++) {
            const n = String(knownVarNames[i] || "");
            if (n.length > longest.length) longest = n;
        }
        if (!longest) return baseWidth;
        if (!varDrawerMeasureEl) {
            varDrawerMeasureEl = document.createElement("span");
            varDrawerMeasureEl.className = "tree-leaf-name";
            varDrawerMeasureEl.style.position = "fixed";
            varDrawerMeasureEl.style.left = "-99999px";
            varDrawerMeasureEl.style.top = "0";
            varDrawerMeasureEl.style.visibility = "hidden";
            varDrawerMeasureEl.style.whiteSpace = "nowrap";
            document.body.appendChild(varDrawerMeasureEl);
        }
        varDrawerMeasureEl.textContent = longest;
        // Texto + checkbox + badge TSV + paddings/márgenes del item.
        const measured = Math.ceil(varDrawerMeasureEl.getBoundingClientRect().width + 110);
        return Math.max(280, Math.min(820, measured));
    }

    function positionVarDrawer() {
        if (!varDrawer || !colMonitorEl) return;
        const rect = colMonitorEl.getBoundingClientRect();
        const margin = 8;
        const desiredWidth = estimateVarDrawerDesiredWidth();
        const availableRight = Math.max(220, window.innerWidth - rect.right - margin);
        const width = Math.min(desiredWidth, availableRight);
        const left = Math.min(rect.right + margin, window.innerWidth - width - margin);
        const top = Math.max(0, rect.top);
        const height = Math.max(200, rect.height);
        varDrawer.style.left = `${Math.max(margin, left)}px`;
        varDrawer.style.top = `${top}px`;
        varDrawer.style.height = `${height}px`;
        varDrawer.style.width = `${width}px`;
    }

    function openVarDrawer() {
        if (varDrawer) {
            positionVarDrawer();
            varDrawer.style.display = "flex";
        }
    }

    function closeVarDrawer() {
        if (varDrawer) varDrawer.style.display = "none";
    }

    if (browserToggleBtn && varDrawer) {
        browserToggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const visible = varDrawer.style.display === "flex";
            if (visible) closeVarDrawer(); else openVarDrawer();
        });
    }
    if (browserCloseBtn) {
        browserCloseBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            closeVarDrawer();
        });
    }
    window.addEventListener("resize", () => {
        applyMonitorPaneWidth();
        if (varDrawer && varDrawer.style.display === "flex") positionVarDrawer();
    });

    if (monitorResizeHandle && colMonitorEl) {
        let dragState = null;
        const onMove = (e) => {
            if (!dragState) return;
            const dx = e.clientX - dragState.startX;
            monitorPaneWidthPx = clampMonitorPaneWidth(dragState.startWidth + dx);
            applyMonitorPaneWidth();
            positionVarDrawer();
        };
        const onUp = () => {
            if (!dragState) return;
            dragState = null;
            monitorResizeHandle.classList.remove("dragging");
            document.body.style.cursor = "";
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            saveConfig();
        };
        monitorResizeHandle.addEventListener("mousedown", (e) => {
            if (window.matchMedia("(max-width: 900px)").matches) return;
            e.preventDefault();
            const rect = colMonitorEl.getBoundingClientRect();
            dragState = { startX: e.clientX, startWidth: rect.width };
            monitorResizeHandle.classList.add("dragging");
            document.body.style.cursor = "col-resize";
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    // --- Panel de ajustes (host/puerto/idioma/tema) ---

    if (settingsBtn && settingsPanel) {
        function toggleSettingsPanel() {
            const isVisible = settingsPanel.style.display === "flex";
            settingsPanel.style.display = isVisible ? "none" : "flex";
        }
        settingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleSettingsPanel();
        });
        document.addEventListener("click", (e) => {
            if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
                settingsPanel.style.display = "none";
            }
        });
    }

    const monitorMenuBtn = document.getElementById("monitorMenuBtn");
    const monitorMenuPanel = document.getElementById("monitorMenuPanel");
    const monitorFilterMenuBtn = document.getElementById("monitorFilterMenuBtn");
    const monitorFilterPanel = document.getElementById("monitorFilterPanel");
    const monitorColsAddBtn = document.getElementById("monitorColsAddBtn");
    const monitorColsRemoveBtn = document.getElementById("monitorColsRemoveBtn");
    if (monitorMenuBtn && monitorMenuPanel) {
        monitorMenuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const isVisible = monitorMenuPanel.style.display === "flex";
            monitorMenuPanel.style.display = isVisible ? "none" : "flex";
            if (monitorFilterPanel && !isVisible) {
                monitorFilterPanel.style.display = "none";
                if (monitorFilterMenuBtn) monitorFilterMenuBtn.setAttribute("aria-expanded", "false");
            }
            if (!isVisible) refreshAlarmListPanel();
        });
        document.addEventListener("click", (e) => {
            if (!monitorMenuPanel.contains(e.target) && e.target !== monitorMenuBtn) {
                monitorMenuPanel.style.display = "none";
            }
        });
        const alarmClearAllBtn = document.getElementById("alarmClearAllBtn");
        if (alarmClearAllBtn) {
            alarmClearAllBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                clearAllAlarms();
                refreshAlarmListPanel();
            });
        }
    }
    if (monitorFilterMenuBtn && monitorFilterPanel) {
        monitorFilterMenuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const isVisible = monitorFilterPanel.style.display === "block";
            monitorFilterPanel.style.display = isVisible ? "none" : "block";
            monitorFilterMenuBtn.setAttribute("aria-expanded", isVisible ? "false" : "true");
            if (monitorMenuPanel && !isVisible) monitorMenuPanel.style.display = "none";
            if (!isVisible && monitorFilterInput) {
                try { monitorFilterInput.focus(); } catch (err) {}
            }
        });
        document.addEventListener("click", (e) => {
            if (!monitorFilterPanel.contains(e.target) && e.target !== monitorFilterMenuBtn) {
                monitorFilterPanel.style.display = "none";
                monitorFilterMenuBtn.setAttribute("aria-expanded", "false");
            }
        });
    }

    if (monitorColsAddBtn) {
        monitorColsAddBtn.addEventListener("click", () => {
            monitorColumnsCount = Math.min(3, monitorColumnsCount + 1);
            applyMonitorColumns();
            positionVarDrawer();
            saveConfig();
        });
    }
    if (monitorColsRemoveBtn) {
        monitorColsRemoveBtn.addEventListener("click", () => {
            monitorColumnsCount = Math.max(1, monitorColumnsCount - 1);
            applyMonitorColumns();
            positionVarDrawer();
            saveConfig();
        });
    }
    if (compactMonitorSlider) {
        compactMonitorSlider.addEventListener("input", () => {
            const v = Number(compactMonitorSlider.value);
            compactMonitorLevel = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
            updateCompactMonitorUi();
            saveConfig();
        });
    }
    if (expandAllMonBtn) {
        expandAllMonBtn.addEventListener("click", () => {
            for (const n of monitoredOrder) expandedStats.add(n);
            rebuildMonitorList();
            updateMonitorValues();
        });
    }
    if (collapseAllMonBtn) {
        collapseAllMonBtn.addEventListener("click", () => {
            expandedStats.clear();
            rebuildMonitorList();
            updateMonitorValues();
            monitorListEl.querySelectorAll(".stats-panel").forEach((p) => p.remove());
            monitorListEl.querySelectorAll(".monitor-item.expanded").forEach((el) => el.classList.remove("expanded"));
        });
    }
    if (adaptiveLoadCheckbox) {
        adaptiveLoadCheckbox.addEventListener("change", () => {
            adaptiveLoadEnabled = !!adaptiveLoadCheckbox.checked;
            renderPerfTelemetry();
            saveConfig();
        });
    }
    if (layoutUndoBtn) layoutUndoBtn.addEventListener("click", doLayoutUndo);
    if (layoutRedoBtn) layoutRedoBtn.addEventListener("click", doLayoutRedo);

    async function refreshTemplateUi() {
        if (!dashboardTemplateSelect) return;
        let keys = [];
        try {
            const r = await fetch("/api/templates");
            if (r.ok) {
                const d = await r.json();
                keys = Array.isArray(d.templates) ? d.templates : [];
            }
        } catch (e) {}
        dashboardTemplateSelect.innerHTML = "";
        if (keys.length === 0) {
            const op = document.createElement("option");
            op.value = "";
            op.textContent = "(sin plantillas)";
            dashboardTemplateSelect.appendChild(op);
            return;
        }
        keys.forEach((k) => {
            const op = document.createElement("option");
            op.value = k;
            op.textContent = k;
            dashboardTemplateSelect.appendChild(op);
        });
    }
    refreshTemplateUi();
    if (templateSaveBtn) {
        templateSaveBtn.addEventListener("click", async () => {
            const name = prompt("Nombre de plantilla:");
            if (!name) return;
            const payload = buildFullConfig();
            const dl = (sendFileOnFinishCheckbox && sendFileOnFinishCheckbox.checked) ? "?download=1" : "";
            await fetch("/api/templates/" + encodeURIComponent(name) + dl, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: payload }),
            });
            await refreshTemplateUi();
            dashboardTemplateSelect.value = name;
        });
    }
    if (templateLoadBtn) {
        templateLoadBtn.addEventListener("click", async () => {
            const key = dashboardTemplateSelect ? dashboardTemplateSelect.value : "";
            if (!key) return;
            const r = await fetch("/api/templates/" + encodeURIComponent(key));
            if (!r.ok) return;
            const d = await r.json();
            if (!d || typeof d.data !== "object") return;
            await applyImportedConfig(d.data, { autoLoadOffline: true });
        });
    }

    if (langSelect) {
        langSelect.addEventListener("change", () => {
            applyLanguage(langSelect.value);
            saveConfig();
        });
    }

    if (themeSelect) {
        themeSelect.addEventListener("change", () => {
            applyTheme(themeSelect.value);
            saveConfig();
        });
    }

    // --- Export / Import config to file ---

    function buildFullConfig() {
        return {
            monitored: monitoredOrder.slice(),
            graphs: varGraphAssignment,
            graphList: graphList,
            graphColumns: graphColumns.map((col) => col.slice()),
            seriesColors: { ...seriesColorByName },
            timeWindow: timeWindowSelect.value,
            smoothPlots: document.getElementById("smoothPlotsSelect")?.value || "5",
            instance: portSelect ? portSelect.value : "",
            hideLevels: hideLevels,
            update_ratio: intervalInput.value,
            alarms: alarms,
            computedVars: computedVars.map(c => ({ name: c.name, expr: c.expr })),
            varFormat: varFormat,
            arrayElemAssignment: arrayElemAssignment,
            lang: currentLang,
            theme: currentTheme,
            monitorColumns: monitorColumnsCount,
            monitorPaneWidth: monitorPaneWidthPx,
            compactMonitor: compactMonitorLevel,
            adaptiveLoad: adaptiveLoadEnabled,
            downsampleMaxPoints: downsampleMaxPoints,
            notesByTs: notesByTs,
            offlineSegments: offlineSegments,
            appMode: appMode,
            offlineRecordingName: offlineRecordingName || "",
            snapshotFrames: snapshotFramesInput ? Number(snapshotFramesInput.value || 40) : 40,
            offlineFullLoadMaxMb: offlineFullLoadMaxMb,
            offlinePreviewMb: offlinePreviewMb,
            offlineSafePreviewMaxRows: offlineSafePreviewMaxRows,
            offlineSafePreviewMaxSpanSec: offlineSafePreviewMaxSpanSec,
            offlineAllowForceFullLoad: !!offlineAllowForceFullLoad,
            generators: Object.entries(activeGenerators).map(([name, g]) => ({
                name,
                type: g.type,
                params: { ...(g.params || {}) },
            })),
        };
    }

    async function applyImportedConfig(cfg, opts = {}) {
        monitoredNames.clear();
        monitoredOrder = [];
        if (Array.isArray(cfg.monitored)) {
            monitoredOrder = cfg.monitored.slice();
            monitoredOrder.forEach(n => monitoredNames.add(n));
            enforceArincMonitoringDependencies();
            pruneArincDerivedFromMonitored();
        }
        if (cfg.graphs && typeof cfg.graphs === "object") varGraphAssignment = cfg.graphs;
        if (Array.isArray(cfg.graphList)) graphList = cfg.graphList;
        if (Array.isArray(cfg.graphColumns)) graphColumns = cfg.graphColumns.map((col) => Array.isArray(col) ? col.slice() : []);
        if (cfg.seriesColors && typeof cfg.seriesColors === "object") {
            seriesColorByName = { ...cfg.seriesColors };
            seriesHueByName = {};
        }
        normalizeGraphLayout();
        if (cfg.timeWindow) {
            timeWindowSelect.value = cfg.timeWindow;
            const v = parseInt(cfg.timeWindow, 10);
            localHistMaxSec = (Number.isFinite(v) && v > 0) ? v : 60;
        } else if (cfg.historyBuffer) {
            timeWindowSelect.value = cfg.historyBuffer;
            const v = parseInt(cfg.historyBuffer, 10);
            localHistMaxSec = (Number.isFinite(v) && v > 0) ? v : 60;
        }
        const smoothSel = document.getElementById("smoothPlotsSelect");
        if (smoothSel && cfg.smoothPlots && /^[1-9][0-9]*$/.test(String(cfg.smoothPlots))) {
            const v = String(cfg.smoothPlots);
            if (["1", "3", "5", "7", "11"].includes(v)) smoothSel.value = v;
        }
        if (typeof cfg.hideLevels === "number") {
            hideLevels = cfg.hideLevels;
            if (hideLevelsInput) hideLevelsInput.value = String(hideLevels);
        }
        if (cfg.instance && typeof cfg.instance === "string") {
            savedInstance = cfg.instance.trim();
            if (portSelect && Array.from(portSelect.options).some(o => o.value === savedInstance)) portSelect.value = savedInstance;
        }
        if (cfg.update_ratio != null) {
            const r = parseInt(cfg.update_ratio, 10);
            if (r >= 1 && intervalInput) intervalInput.value = Math.min(r, parseInt(intervalInput.max, 10) || 100);
        } else if (cfg.interval != null) {
            const r = parseInt(cfg.interval, 10);
            if (r >= 1 && intervalInput) intervalInput.value = Math.min(r, parseInt(intervalInput.max, 10) || 100);
        }
        if (cfg.alarms && typeof cfg.alarms === "object") alarms = cfg.alarms;
        stopAllGenerators();
        pendingGeneratorRestore = [];
        if (Array.isArray(cfg.generators)) {
            pendingGeneratorRestore = cfg.generators
                .filter((g) => g && typeof g.name === "string" && typeof g.type === "string" && g.params && typeof g.params === "object")
                .map((g) => ({ name: g.name, type: g.type, params: { ...g.params } }));
        }
        computedVars = [];
        computedHistories = {};
        if (Array.isArray(cfg.computedVars)) {
            for (const cv of cfg.computedVars) if (cv.name && cv.expr) addComputedVar(cv.name, cv.expr);
        }
        if (cfg.varFormat && typeof cfg.varFormat === "object") varFormat = normalizeVarFormatConfig(cfg.varFormat);
        if (cfg.arrayElemAssignment && typeof cfg.arrayElemAssignment === "object") arrayElemAssignment = cfg.arrayElemAssignment;
        if (cfg.lang) currentLang = cfg.lang;
        if (cfg.theme) currentTheme = cfg.theme;
        if (typeof cfg.monitorColumns === "number" && cfg.monitorColumns >= 1 && cfg.monitorColumns <= 3) monitorColumnsCount = cfg.monitorColumns;
        if (typeof cfg.monitorPaneWidth === "number" && Number.isFinite(cfg.monitorPaneWidth) && cfg.monitorPaneWidth > 0) monitorPaneWidthPx = cfg.monitorPaneWidth; else monitorPaneWidthPx = null;
        if (typeof cfg.compactMonitor === "boolean") compactMonitorLevel = cfg.compactMonitor ? 70 : 0;
        if (typeof cfg.compactMonitor === "number") compactMonitorLevel = Math.max(0, Math.min(100, cfg.compactMonitor));
        if (typeof cfg.adaptiveLoad === "boolean") adaptiveLoadEnabled = cfg.adaptiveLoad;
        if (typeof cfg.downsampleMaxPoints === "number" && Number.isFinite(cfg.downsampleMaxPoints)) downsampleMaxPoints = Math.max(200, Math.floor(cfg.downsampleMaxPoints));
        if (Array.isArray(cfg.notesByTs)) notesByTs = cfg.notesByTs;
        if (Array.isArray(cfg.offlineSegments)) offlineSegments = cfg.offlineSegments;
        if (snapshotFramesInput && Number.isFinite(Number(cfg.snapshotFrames))) snapshotFramesInput.value = String(Math.max(2, Math.floor(Number(cfg.snapshotFrames))));
        if (Number.isFinite(Number(cfg.offlineFullLoadMaxMb))) offlineFullLoadMaxMb = Math.max(5, Math.floor(Number(cfg.offlineFullLoadMaxMb)));
        if (Number.isFinite(Number(cfg.offlinePreviewMb))) offlinePreviewMb = Math.max(1, Math.min(8, Math.floor(Number(cfg.offlinePreviewMb))));
        if (Number.isFinite(Number(cfg.offlineSafePreviewMaxRows))) offlineSafePreviewMaxRows = Math.max(500, Math.floor(Number(cfg.offlineSafePreviewMaxRows)));
        if (Number.isFinite(Number(cfg.offlineSafePreviewMaxSpanSec))) offlineSafePreviewMaxSpanSec = Math.max(5, Math.floor(Number(cfg.offlineSafePreviewMaxSpanSec)));
        if (typeof cfg.offlineAllowForceFullLoad === "boolean") offlineAllowForceFullLoad = cfg.offlineAllowForceFullLoad;
        if (offlineFullLoadMaxMbInput) offlineFullLoadMaxMbInput.value = String(offlineFullLoadMaxMb);
        if (offlinePreviewMbInput) offlinePreviewMbInput.value = String(offlinePreviewMb);
        if (offlinePreviewRowsInput) offlinePreviewRowsInput.value = String(offlineSafePreviewMaxRows);
        if (offlinePreviewSpanSecInput) offlinePreviewSpanSecInput.value = String(offlineSafePreviewMaxSpanSec);
        if (offlineAllowForceFullLoadCheckbox) offlineAllowForceFullLoadCheckbox.checked = !!offlineAllowForceFullLoad;
        if (cfg.appMode === "offline" || cfg.appMode === "live" || cfg.appMode === "replay") setAppMode(cfg.appMode, { keepData: true });
        const rec = (cfg.offlineRecordingName || "").trim();
        if (opts.autoLoadOffline && cfg.appMode === "offline" && rec) {
            try {
                await loadRecordingFromServer(rec, { preserveLayout: true });
            } catch (e) {
                console.warn("No se pudo autocargar TSV de la sesion:", rec, e);
                alert(`Sesion cargada, pero no se encontro TSV: ${rec}`);
            }
        }
        saveConfig();
        rebuildKnownVarNamesWithDerived();
        sendMonitored();
        sendUpdateRatio();
        rebuildPlotArea();
        rebuildMonitorList();
        renderBrowserList();
        renderPlots();
        applyTheme(currentTheme);
        applyLanguage(currentLang);
        applyMonitorColumns();
        restorePendingGeneratorsIfPossible();
    }

    function exportConfigToFile() {
        const cfg = buildFullConfig();
        const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
        const d = new Date();
        const pad2 = n => String(n).padStart(2, "0");
        const fname = "varmon_config_" +
            d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "_" +
            pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds()) + ".json";
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function importConfigFromFile() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.addEventListener("change", () => {
            const file = input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const cfg = JSON.parse(reader.result);
                    await applyImportedConfig(cfg, { autoLoadOffline: true });
                } catch (e) {
                    console.error("Error al importar config:", e);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    }

    const exportConfigBtnEl = document.getElementById("exportConfigBtn");
    const importConfigBtnEl = document.getElementById("importConfigBtn");
    if (exportConfigBtnEl) exportConfigBtnEl.addEventListener("click", exportConfigToFile);
    if (importConfigBtnEl) importConfigBtnEl.addEventListener("click", importConfigFromFile);
    if (plotArea) {
        plotArea.addEventListener("mousedown", () => {
            try { plotArea.focus(); } catch (e) {}
        });
    }
    async function refreshAdminStorageUi() {
        if (!adminRecordingsList || !adminTemplatesList) return;
        const r = await fetch("/api/admin/storage");
        if (!r.ok) return;
        const d = await r.json();
        if (adminConfigPath) adminConfigPath.value = d?.paths?.config_file || "";
        if (adminRecordingsPath) adminRecordingsPath.value = d?.paths?.recordings_dir || "";
        if (adminStatePath) adminStatePath.value = d?.paths?.server_state_dir || "";
        if (adminBasePortInput) adminBasePortInput.value = String(d?.runtime?.web_port ?? 8080);
        if (adminPortRangeInput) adminPortRangeInput.value = String(d?.runtime?.web_port_scan_max ?? 10);
        adminRuntimeBaseline = {
            web_port: Number(adminBasePortInput?.value || 8080),
            web_port_scan_max: Number(adminPortRangeInput?.value || 10),
        };
        updateAdminApplyButtonState();
        const fillList = (el, rows, kind) => {
            el.innerHTML = "";
            if (!rows || rows.length === 0) {
                const empty = document.createElement("div");
                empty.className = "note-item";
                empty.textContent = "(vacío)";
                el.appendChild(empty);
                return;
            }
            rows.forEach((row) => {
                const name = typeof row === "string" ? row : row.name;
                const extra = typeof row === "string" ? "" : ` [${row.kind || ""}]`;
                const item = document.createElement("div");
                item.className = "note-item";
                const txt = document.createElement("span");
                txt.textContent = `${name}${extra}`;
                const del = document.createElement("button");
                del.className = "btn-small";
                del.textContent = "Borrar";
                del.addEventListener("click", async () => {
                    if (!confirm(`¿Borrar '${name}'?`)) return;
                    const rr = await fetch("/api/admin/storage/delete", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ kind, name }),
                    });
                    if (!rr.ok) {
                        let msg = "No se pudo borrar";
                        try { const ej = await rr.json(); if (ej?.error) msg += `: ${ej.error}`; } catch (e) {}
                        alert(msg);
                        return;
                    }
                    await refreshAdminStorageUi();
                    await refreshTemplateUi();
                    await refreshServerRecordings();
                });
                item.appendChild(txt);
                item.appendChild(del);
                el.appendChild(item);
            });
        };
        fillList(adminRecordingsList, d.recordings || [], "recording");
        fillList(adminTemplatesList, d.templates || [], "template");
    }

    let adminRuntimeBaseline = { web_port: 8080, web_port_scan_max: 10 };

    function updateAdminApplyButtonState() {
        if (!adminApplyRuntimeBtn) return;
        const base = Number(adminBasePortInput?.value || 8080);
        const rng = Number(adminPortRangeInput?.value || 10);
        const hasChanges = base !== adminRuntimeBaseline.web_port || rng !== adminRuntimeBaseline.web_port_scan_max;
        adminApplyRuntimeBtn.classList.toggle("admin-apply-has-changes", !!hasChanges);
    }

    if (adminBasePortInput) {
        adminBasePortInput.addEventListener("input", updateAdminApplyButtonState);
        adminBasePortInput.addEventListener("change", updateAdminApplyButtonState);
    }
    if (adminPortRangeInput) {
        adminPortRangeInput.addEventListener("input", updateAdminApplyButtonState);
        adminPortRangeInput.addEventListener("change", updateAdminApplyButtonState);
    }

    if (adminStorageBtn && adminStorageOverlay) {
        adminStorageBtn.addEventListener("click", async () => {
            await refreshAdminStorageUi();
            adminStorageOverlay.style.display = "flex";
        });
    }
    if (adminStorageCloseBtn && adminStorageOverlay) {
        adminStorageCloseBtn.addEventListener("click", () => {
            adminStorageOverlay.style.display = "none";
        });
    }
    if (adminStorageOverlay) {
        adminStorageOverlay.addEventListener("click", (e) => {
            if (e.target === adminStorageOverlay) adminStorageOverlay.style.display = "none";
        });
    }

    // --- Navegador de archivos remoto ---
    let remoteBrowserCurrentPath = "";
    let remoteBrowserPickForAnalysis = false;
    /** Cuando se abre desde admin: "config" | "recordings" | "state". Null si es análisis o solo explorar. */
    let remoteBrowserAdminTarget = null;
    let remoteBrowserSelectedPath = null;
    /** Raíz absoluta del proyecto (viene del API /api/browse). */
    let remoteBrowserRoot = "";
    const remoteBrowserSelectFooter = document.getElementById("remoteBrowserSelectFooter");
    const remoteBrowserSelectedPathLabel = document.getElementById("remoteBrowserSelectedPathLabel");
    const remoteBrowserConfirmSelectBtn = document.getElementById("remoteBrowserConfirmSelectBtn");

    async function loadRemotePath(path) {
        const listEl = remoteFileListOverlay;
        const pathInput = remoteBrowserOverlayPathInput;
        if (!listEl || !pathInput) return;
        listEl.innerHTML = "<span class=\"remote-browser-loading\">Cargando…</span>";
        pathInput.value = path || "(raíz)";
        try {
            const params = new URLSearchParams();
            if (path) params.set("path", path);
            const resp = await fetch("/api/browse?" + params.toString());
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                listEl.innerHTML = "<span class=\"remote-browser-error\">" + (err.error || resp.status) + "</span>";
                return;
            }
            const data = await resp.json();
            remoteBrowserCurrentPath = data.path || "";
            if (data.root != null) remoteBrowserRoot = String(data.root);
            pathInput.value = remoteBrowserCurrentPath || "(raíz)";
            if (remoteBrowserOverlayUpBtn) remoteBrowserOverlayUpBtn.disabled = !remoteBrowserCurrentPath;
            if (remoteBrowserAdminTarget) {
                remoteBrowserSelectedPath = null;
                const selLabel = document.getElementById("remoteBrowserSelectedPathLabel");
                if (selLabel) selLabel.textContent = "";
            }
            const entries = Array.isArray(data.entries) ? data.entries : [];
            listEl.innerHTML = "";
            entries.forEach((ent) => {
                const row = document.createElement("div");
                row.className = "remote-file-row " + (ent.is_dir ? "remote-file-dir" : "remote-file-file");
                row.dataset.name = ent.name;
                row.dataset.isDir = ent.is_dir ? "1" : "0";
                const icon = document.createElement("span");
                icon.className = "remote-file-icon";
                icon.textContent = ent.is_dir ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
                const nameSpan = document.createElement("span");
                nameSpan.className = "remote-file-name";
                nameSpan.textContent = ent.name;
                const meta = document.createElement("span");
                meta.className = "remote-file-meta";
                if (!ent.is_dir && ent.size != null) meta.textContent = formatBytes(ent.size);
                if (ent.mtime != null) meta.textContent = (meta.textContent ? meta.textContent + " \u2022 " : "") + new Date(ent.mtime * 1000).toLocaleString();
                row.appendChild(icon);
                row.appendChild(nameSpan);
                row.appendChild(meta);
                listEl.appendChild(row);
            });
        } catch (e) {
            listEl.innerHTML = "<span class=\"remote-browser-error\">" + (e.message || "Error") + "</span>";
        }
    }

    function formatBytes(n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

    function openRemoteFileBrowser(initialPath, pickForAnalysisMode, adminTarget) {
        remoteBrowserPickForAnalysis = !!pickForAnalysisMode;
        remoteBrowserAdminTarget = adminTarget || null;
        remoteBrowserSelectedPath = null;
        remoteBrowserCurrentPath = (initialPath || "").trim();
        if (remoteFileBrowserOverlay) remoteFileBrowserOverlay.style.display = "flex";
        if (remoteBrowserOverlayUpBtn) remoteBrowserOverlayUpBtn.disabled = !remoteBrowserCurrentPath;
        const titleEl = document.getElementById("remoteBrowserOverlayTitle");
        if (titleEl) titleEl.textContent = remoteBrowserPickForAnalysis ? "Seleccionar archivo para análisis" : "Explorador de archivos";
        const footer = document.getElementById("remoteBrowserSelectFooter");
        const selLabel = document.getElementById("remoteBrowserSelectedPathLabel");
        if (footer) footer.style.display = remoteBrowserAdminTarget ? "flex" : "none";
        if (selLabel) selLabel.textContent = "";
        loadRemotePath(remoteBrowserCurrentPath);
    }

    function closeRemoteFileBrowser() {
        if (remoteFileBrowserOverlay) remoteFileBrowserOverlay.style.display = "none";
        remoteBrowserPickForAnalysis = false;
        remoteBrowserAdminTarget = null;
        remoteBrowserSelectedPath = null;
    }

    if (remoteFileListOverlay) {
        remoteFileListOverlay.addEventListener("click", async (e) => {
            const row = e.target.closest(".remote-file-row");
            if (!row) return;
            const name = row.dataset.name;
            const isDir = row.dataset.isDir === "1";
            const pathRel = remoteBrowserCurrentPath ? remoteBrowserCurrentPath + "/" + name : name;
            if (remoteBrowserAdminTarget) {
                const absPath = remoteBrowserRoot
                    ? (pathRel ? remoteBrowserRoot.replace(/\/$/, "") + "/" + pathRel.replace(/^\/+/, "") : remoteBrowserRoot)
                    : pathRel;
                remoteBrowserSelectedPath = absPath;
                remoteFileListOverlay.querySelectorAll(".remote-file-row").forEach((r) => r.classList.remove("remote-file-selected"));
                row.classList.add("remote-file-selected");
                const selLabel = document.getElementById("remoteBrowserSelectedPathLabel");
                if (selLabel) selLabel.textContent = "Seleccionado: " + absPath;
                return;
            }
            const path = pathRel;
            if (isDir) {
                loadRemotePath(path);
                return;
            }
            if (remoteBrowserPickForAnalysis && name.toLowerCase().endsWith(".tsv")) {
                try {
                    const params = new URLSearchParams({ path });
                    const resp = await fetch("/api/browse/download?" + params.toString());
                    if (!resp.ok) throw new Error(resp.statusText);
                    const text = await resp.text();
                    const filename = path.split("/").pop() || name;
                    const ds = parseTsvDataset(text, filename);
                    if (!ds || !ds.names) throw new Error("TSV inválido");
                    await loadOfflineDataset(ds, { recordingName: filename, preserveLayout: true });
                    refreshServerRecordings();
                    closeRemoteFileBrowser();
                } catch (err) {
                    alert("No se pudo cargar el archivo: " + (err.message || String(err)));
                }
                return;
            }
            window.open("/api/browse/download?" + new URLSearchParams({ path }).toString(), "_blank");
        });
    }

    if (remoteBrowserOverlayUpBtn) {
        remoteBrowserOverlayUpBtn.addEventListener("click", () => {
            if (!remoteBrowserCurrentPath) return;
            const parts = remoteBrowserCurrentPath.replace(/\\/g, "/").split("/").filter(Boolean);
            parts.pop();
            loadRemotePath(parts.join("/"));
        });
    }

    if (remoteBrowserOverlayMkdirBtn) {
        remoteBrowserOverlayMkdirBtn.addEventListener("click", async () => {
            const name = window.prompt("Nombre de la nueva carpeta:");
            if (!name || !name.trim()) return;
            try {
                const resp = await fetch("/api/browse/mkdir", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: remoteBrowserCurrentPath, name: name.trim() }),
                });
                if (resp.status === 409) {
                    alert("Ya existe una carpeta o archivo con ese nombre.");
                    return;
                }
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.error || resp.statusText);
                }
                loadRemotePath(remoteBrowserCurrentPath);
            } catch (e) {
                alert("Error: " + (e.message || String(e)));
            }
        });
    }

    if (remoteBrowserOverlayCloseBtn) remoteBrowserOverlayCloseBtn.addEventListener("click", closeRemoteFileBrowser);
    if (remoteFileBrowserOverlay) {
        remoteFileBrowserOverlay.addEventListener("click", (e) => {
            if (e.target === remoteFileBrowserOverlay) closeRemoteFileBrowser();
        });
    }

    if (remoteBrowserConfirmSelectBtn) {
        remoteBrowserConfirmSelectBtn.addEventListener("click", () => {
            if (!remoteBrowserAdminTarget || remoteBrowserSelectedPath == null) return;
            const target = remoteBrowserAdminTarget;
            if (target === "config" && adminConfigPath) adminConfigPath.value = remoteBrowserSelectedPath;
            else if (target === "recordings" && adminRecordingsPath) adminRecordingsPath.value = remoteBrowserSelectedPath;
            else if (target === "state" && adminStatePath) adminStatePath.value = remoteBrowserSelectedPath;
            closeRemoteFileBrowser();
        });
    }

    if (openRemoteBrowserForAnalysisBtn) {
        openRemoteBrowserForAnalysisBtn.addEventListener("click", () => openRemoteFileBrowser("", true));
    }
    if (adminConfigPathBrowseBtn) {
        adminConfigPathBrowseBtn.addEventListener("click", () => openRemoteFileBrowser("", false, "config"));
    }
    if (adminRecordingsPathBrowseBtn) {
        adminRecordingsPathBrowseBtn.addEventListener("click", () => openRemoteFileBrowser("web_monitor/recordings", false, "recordings"));
    }
    if (adminStatePathBrowseBtn) {
        adminStatePathBrowseBtn.addEventListener("click", () => openRemoteFileBrowser("web_monitor/server_state", false, "state"));
    }

    if (adminApplyRuntimeBtn) {
        adminApplyRuntimeBtn.addEventListener("click", async () => {
            const base = Math.max(1, Math.min(65535, Number(adminBasePortInput?.value || 8080)));
            const rng = Math.max(0, Math.min(100, Number(adminPortRangeInput?.value || 10)));
            const r = await fetch("/api/admin/runtime_config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ web_port: Math.floor(base), web_port_scan_max: Math.floor(rng) }),
            });
            if (!r.ok) {
                let msg = "No se pudo aplicar la configuración";
                try { const e = await r.json(); if (e?.error) msg += `: ${e.error}`; } catch (_) {}
                alert(msg);
                return;
            }
            await refreshAdminStorageUi();
            adminApplyRuntimeBtn.classList.remove("admin-apply-has-changes");
            alert("Configuración guardada. El puerto base aplica en el siguiente arranque.");
        });
    }
    if (adminDeleteAllRecordingsBtn) {
        adminDeleteAllRecordingsBtn.addEventListener("click", async () => {
            if (!confirm("¿Borrar TODOS los recordings/snapshots/segmentos?")) return;
            const r = await fetch("/api/admin/storage");
            if (!r.ok) { alert("No se pudo cargar la lista de recordings."); return; }
            const d = await r.json();
            const rows = Array.isArray(d.recordings) ? d.recordings : [];
            for (const row of rows) {
                const name = typeof row === "string" ? row : row.name;
                if (!name) continue;
                await fetch("/api/admin/storage/delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind: "recording", name }),
                });
            }
            await refreshAdminStorageUi();
            await refreshServerRecordings();
        });
    }
    if (adminDeleteAllTemplatesBtn) {
        adminDeleteAllTemplatesBtn.addEventListener("click", async () => {
            if (!confirm("¿Borrar TODAS las plantillas?")) return;
            const r = await fetch("/api/admin/storage");
            if (!r.ok) { alert("No se pudo cargar la lista de plantillas."); return; }
            const d = await r.json();
            const rows = Array.isArray(d.templates) ? d.templates : [];
            for (const name of rows) {
                if (!name) continue;
                await fetch("/api/admin/storage/delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind: "template", name }),
                });
            }
            await refreshAdminStorageUi();
            await refreshTemplateUi();
        });
    }

    // --- Pause/Play ---

    function updatePauseBtn() {
        const tr = I18N[currentLang] || I18N.es;
        pauseBtn.textContent = plotsPaused ? tr.pausePlay : tr.pausePause;
        pauseBtn.classList.toggle("paused", plotsPaused);
    }
    pauseBtn.addEventListener("click", () => {
        plotsPaused = !plotsPaused;
        updatePauseBtn();
        if (!plotsPaused) schedulePlotRender();
    });
    updatePauseBtn();

    // --- Reset graficos (equivalente al antiguo "Quitar sel.") ---

    function resetPlots() {
        // Quitar asignaciones de grafico pero mantener variables monitorizadas
        for (const name of monitoredNames) {
            varGraphAssignment[name] = "";
        }
        for (const key of Object.keys(arrayElemAssignment)) {
            delete arrayElemAssignment[key];
            delete arrayElemHistory[key];
        }
        rebuildMonitorList();
        saveConfig();
        pruneEmptyGraphs();
        updateMonitorItemStyles();
        renderPlots();
    }

    resetPlotsBtn.addEventListener("click", resetPlots);

    const smoothPlotsSelect = document.getElementById("smoothPlotsSelect");
    if (smoothPlotsSelect) {
        smoothPlotsSelect.addEventListener("change", () => { saveConfig(); schedulePlotRender(); });
    }
    const plotVsRefCheckbox = document.getElementById("plotVsRefCheckbox");
    if (plotVsRefCheckbox) {
        plotVsRefCheckbox.addEventListener("change", () => {
            plotVsRef = !!plotVsRefCheckbox.checked;
            saveConfig();
            schedulePlotRender();
        });
    }

    if (resetTimeBtn) resetTimeBtn.addEventListener("click", () => {
        if (isPlaybackMode()) return;
        // Primero borrar todos los buffers (gráficos y grabación); después restablecer el offset.
        for (const name of Object.keys(historyCache)) {
            historyCache[name] = { timestamps: [], values: [] };
        }
        for (const key of Object.keys(arrayElemHistory)) {
            arrayElemHistory[key] = { timestamps: [], values: [] };
        }
        for (const cv of computedVars) {
            if (computedHistories[cv.name]) {
                computedHistories[cv.name] = { timestamps: [], values: [] };
            }
        }
        recordBuffer = [];
        localRecordSamples = [];
        if (isRecording) recordStartTime = Date.now();
        sessionStartTime = Date.now() / 1000;
        sharedZoomXRange = null;
        schedulePlotRender();
    });

    // --- WebSocket ---

    let connectionId = 0;
    let connectionInfo = null;
    let udsInstances = [];
    let warningDismissed = false;

    function fetchConnectionInfo() {
        return fetch("/api/connection_info")
            .then((r) => r.ok ? r.json() : null)
            .then(async (data) => {
                connectionInfo = data;
                const user = (data && data.current_user) ? encodeURIComponent(data.current_user) : "";
                const udsUrl = user ? `/api/uds_instances?user=${user}` : "/api/uds_instances";
                try {
                    const u = await fetch(udsUrl).then((r) => r.ok ? r.json() : null);
                    udsInstances = (u && Array.isArray(u.instances)) ? u.instances : [];
                } catch (e) {
                    udsInstances = [];
                }
                if (data && typeof data.update_ratio_max === "number" && intervalInput) {
                    intervalInput.max = Math.max(1, data.update_ratio_max);
                }
                updateMultiInstanceWarning();
                return data;
            })
            .catch(() => null);
    }

    function fillPortSelectWithUds() {
        portSelect.innerHTML = "";
        for (const inst of udsInstances) {
            const opt = document.createElement("option");
            opt.value = "uds:" + inst.uds_path;
            opt.textContent = (inst.user || "?") + " — PID " + (inst.pid != null ? inst.pid : "?");
            portSelect.appendChild(opt);
        }
        if (portSelect.options.length > 0) {
            if (savedInstance && Array.from(portSelect.options).some(o => o.value === savedInstance)) {
                portSelect.value = savedInstance;
            } else {
                portSelect.value = portSelect.options[0].value;
            }
        }
    }

    function updateMultiInstanceWarning() {
        if (!multiInstanceWarningEl || !multiInstanceWarningText) return;
        const tr = (I18N[currentLang] || I18N.es);
        const parts = [];
        let showSuggestedLink = false;
        let suggestedPort = null;
        let suggestedUrl = null;

        const actualWeb = connectionInfo && connectionInfo.actual_web_port != null ? connectionInfo.actual_web_port : null;
        const suggestedWeb = connectionInfo && connectionInfo.suggested_web_port != null ? connectionInfo.suggested_web_port : null;
        if (connectionInfo && actualWeb != null && suggestedWeb != null && actualWeb !== suggestedWeb) {
            const uptimeSec = connectionInfo.uptime_seconds;
            if (uptimeSec != null && uptimeSec >= 0) {
                const min = Math.floor(uptimeSec / 60);
                parts.push((tr.backendUptimeMinutes || "This backend has been running for %d min.").replace("%d", String(min)));
            }
            showSuggestedLink = true;
            suggestedPort = suggestedWeb;
            suggestedUrl = window.location.protocol + "//" + window.location.hostname + ":" + suggestedWeb;
        }

        const suggestedSuffixEl = document.getElementById("multiInstanceWarningSuggestedSuffix");
        if (suggestedSuffixEl) suggestedSuffixEl.textContent = "";

        if (parts.length === 0) {
            warningDismissed = false;
            multiInstanceWarningEl.style.display = "none";
            if (multiInstanceWarningSuggestedWrap) multiInstanceWarningSuggestedWrap.style.display = "none";
        } else if (!warningDismissed) {
            multiInstanceWarningText.textContent = parts.join(" ");
            if (multiInstanceWarningSuggestedWrap && multiInstanceWarningLink && multiInstanceWarningSuggestedPrefix) {
                if (showSuggestedLink && suggestedPort != null && suggestedUrl) {
                    multiInstanceWarningSuggestedPrefix.textContent = (tr.suggestedPortPrefixBefore !== undefined ? tr.suggestedPortPrefixBefore : "En el ");
                    multiInstanceWarningLink.href = suggestedUrl;
                    multiInstanceWarningLink.textContent = String(suggestedPort);
                    multiInstanceWarningSuggestedWrap.style.display = "inline";
                    fetch(suggestedUrl + "/api/instance_info")
                        .then((r) => r.ok ? r.json() : null)
                        .then((info) => {
                            const suf = document.getElementById("multiInstanceWarningSuggestedSuffix");
                            if (suf && info && info.user) {
                                const fmt = tr.suggestedPortSuffixUser || " usuario %s.";
                                suf.textContent = fmt.replace("%s", info.user);
                            }
                        })
                        .catch(() => {});
                } else {
                    multiInstanceWarningSuggestedWrap.style.display = "none";
                }
            }
            multiInstanceWarningEl.style.display = "flex";
        }
    }

    function hideMultiInstanceWarning() {
        warningDismissed = true;
        if (multiInstanceWarningEl) multiInstanceWarningEl.style.display = "none";
    }

    function formatAdvNum(v) {
        if (v == null || typeof v !== "number" || isNaN(v)) return "—";
        if (v >= 100) return v.toFixed(0);
        if (v >= 1) return v.toFixed(2);
        return v.toFixed(3);
    }

    async function updateAdvancedStatsStrip() {
        if (!advancedStatsStrip || advancedStatsStrip.style.display !== "flex") return;
        if (advRamHtml) {
            let htmlMb = null;
            try {
                const mem = typeof performance !== "undefined" && performance.memory;
                if (mem && typeof mem.usedJSHeapSize === "number") {
                    htmlMb = mem.usedJSHeapSize / (1024 * 1024);
                }
            } catch (err) { /* performance.memory no disponible (solo Chrome/Chromium) */ }
            advRamHtml.textContent = "HTML: " + (htmlMb != null ? formatAdvNum(htmlMb) + " MB" : "—");
            advRamHtml.title = htmlMb != null ? "Heap JS del navegador" : "No disponible en Firefox (solo Chrome/Chromium expone performance.memory)";
        }
        try {
            const r = await fetch("/api/advanced_stats");
            if (r.ok) {
                const d = await r.json();
                if (advRamPython) advRamPython.textContent = "Py: " + formatAdvNum(d.python_ram_mb) + " MB";
                if (advRamCpp) advRamCpp.textContent = "C++: " + formatAdvNum(d.cpp_ram_mb) + " MB";
                if (advCpuPython)
                    advCpuPython.textContent = (d.python_cpu_percent != null && !isNaN(d.python_cpu_percent))
                        ? "Py: " + formatAdvNum(d.python_cpu_percent) + "%"
                        : "Py: —";
                if (advCpuCpp)
                    advCpuCpp.textContent = (d.cpp_cpu_percent != null && !isNaN(d.cpp_cpu_percent))
                        ? "C++: " + formatAdvNum(d.cpp_cpu_percent) + "%"
                        : "C++: —";
                if (advShmCycle)
                    advShmCycle.textContent = (d.shm_cycle_ms != null && !isNaN(d.shm_cycle_ms))
                        ? "shm: " + formatAdvNum(d.shm_cycle_ms) + " ms"
                        : "shm: —";
            }
        } catch (e) {
            if (advRamPython) advRamPython.textContent = "Py: —";
            if (advRamCpp) advRamCpp.textContent = "C++: —";
            if (advCpuPython) advCpuPython.textContent = "Py: —";
            if (advCpuCpp) advCpuCpp.textContent = "C++: —";
            if (advShmCycle) advShmCycle.textContent = "shm: —";
        }
        const now = Date.now();
        const cutoff = now - WS_BUFFER_MAX_AGE_MS;
        const recent = wsMessageBuffer.filter((x) => x.t >= cutoff);
        const n = recent.length;
        const totalBytes = recent.reduce((s, x) => s + x.size, 0);
        const spanSec = (recent.length ? (now - Math.min(...recent.map((x) => x.t))) / 1000 : 0) || 1;
        const msgPerS = n / spanSec;
        const mbPerS = totalBytes / (1024 * 1024) / spanSec;
        const mbPerMsg = n > 0 ? totalBytes / (1024 * 1024) / n : 0;
        if (advNetMbMsg) advNetMbMsg.textContent = "MB/msg: " + formatAdvNum(mbPerMsg);
        if (advNetMsgS) advNetMsgS.textContent = "msg/s: " + formatAdvNum(msgPerS);
        if (advNetMbS) advNetMbS.textContent = "MB/s: " + formatAdvNum(mbPerS);
    }

    function setAdvInfoEnabled(enabled) {
        try { localStorage.setItem(ADV_INFO_STORAGE_KEY, enabled ? "1" : "0"); } catch (e) {}
        if (advancedStatsStrip) {
            advancedStatsStrip.style.display = enabled ? "flex" : "none";
            advancedStatsStrip.setAttribute("aria-hidden", !enabled);
        }
        if (advStatsPollInterval) {
            clearInterval(advStatsPollInterval);
            advStatsPollInterval = null;
        }
        if (enabled) {
            updateAdvancedStatsStrip();
            advStatsPollInterval = setInterval(updateAdvancedStatsStrip, 5000);
        }
    }

    function isOfflineMode() { return appMode === "offline"; }
    function isLiveMode() { return appMode === "live"; }
    function isReplayMode() { return appMode === "replay"; }
    /** Modo análisis o replay: sin conexión en vivo, se usa grabación y controles de reproducción */
    function isPlaybackMode() { return isOfflineMode() || isReplayMode(); }
    /** Modos que requieren conexión al backend (WS): live y replay híbrido. */
    function hasBackendConnectionMode() { return isLiveMode() || isReplayMode(); }

    function sendWsAction(payload) {
        if (!hasBackendConnectionMode()) return false;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
            return true;
        }
        return false;
    }

    function setOfflineStatus() {
        if (!statusEl) return;
        const tr = I18N[currentLang] || I18N.es;
        statusEl.textContent = isReplayMode() ? (tr.statusReplay || "Modo replay") : (tr.statusOffline || "Modo análisis (offline)");
        statusEl.className = "status disconnected";
        statusEl.title = "";
    }

    function updateOfflineDatasetStatus() {
        if (!offlineDatasetStatus) return;
        const tr = I18N[currentLang] || I18N.es;
        if (offlineDataset && offlineDataset.sourceName) {
            const safeSuffix = (offlineSafetyInfo && offlineSafetyInfo.safeMode)
                ? ` | ${tr.offlineDatasetSafeMode || "Modo seguro"}`
                : "";
            const loadingSuffix = windowFetchSlow ? ` | ${tr.offlineDatasetLoading || "Cargando datos..."}` : "";
            offlineDatasetStatus.textContent = `${tr.offlineDatasetLoaded || "Cargado:"} A: ${offlineDataset.sourceName}${safeSuffix}${loadingSuffix}`;
            offlineDatasetStatus.classList.remove("offline-empty");
            offlineDatasetStatus.classList.add("offline-loaded");
            offlineDatasetStatus.classList.toggle("offline-safe", !!(offlineSafetyInfo && offlineSafetyInfo.safeMode));
        } else {
            offlineDatasetStatus.textContent = tr.offlineDatasetNone || "Sin archivo cargado";
            offlineDatasetStatus.classList.remove("offline-loaded");
            offlineDatasetStatus.classList.remove("offline-safe");
            offlineDatasetStatus.classList.add("offline-empty");
        }
        if (offlineSafeModeBadge) {
            offlineSafeModeBadge.style.display = (offlineSafetyInfo && offlineSafetyInfo.safeMode) ? "inline-flex" : "none";
        }
    }

    function updateMarkerInfoLabel() {
        if (!markerInfoLabel) return;
        const fmt = (v) => {
            if (!Number.isFinite(v)) return "--";
            if (offlineDataset && Number.isFinite(offlineDataset.minTs)) {
                return Math.max(0, v - offlineDataset.minTs).toFixed(3) + "s";
            }
            return v.toFixed(3) + "s";
        };
        markerInfoLabel.textContent = `A: ${fmt(markerA)} | B: ${fmt(markerB)}`;
    }

    function clearDataBuffers() {
        varsByName = {};
        baseKnownVarNames = [];
        knownVarNames = [];
        offlineSafetyInfo = null;
        offlineRecordingGlobalMinTs = null;
        offlineSegmentOffsetSec = 0;
        sessionStartTime = null;
        sharedZoomXRange = null;
        historyCache = {};
        arrayElemHistory = {};
        deltaByName = {};
        varNamesInTsv = new Set();
        anomalyResults = [];
        eventCursorIndex = -1;
        arincBusHealth = { totalWords: 0, parityErrors: 0, ssmErrors: 0, unknownLabels: 0, labels: {}, parityByLabel: {}, unknownByLabel: {} };
        plotInstances = {};
        expandedStats.clear();
        prevAlarmState = {};
        computedHistories = {};
        browserSelection.clear();
        browserListDirty = true;
        varCountEl.textContent = "";
        monitorListEl.innerHTML = "";
        if (plotArea) {
            while (plotArea.firstChild) plotArea.removeChild(plotArea.firstChild);
            if (plotEmpty) {
                plotEmpty.style.display = "flex";
                plotArea.appendChild(plotEmpty);
            }
            if (toggleAdvancedPlotBtn) plotArea.appendChild(toggleAdvancedPlotBtn);
        }
        if (anomalyListEl) anomalyListEl.innerHTML = "";
        renderArincBusHealth();
    }

    function clearUserLayout() {
        monitoredNames.clear();
        monitoredOrder = [];
        varGraphAssignment = {};
        graphList = [];
        graphColumns = [];
        arrayElemAssignment = {};
        alarms = {};
        activeAlarms.clear();
        computedVars = [];
        for (const name in activeGenerators) stopGenerator(name);
    }

    function stopOfflinePlayback() {
        offlinePlayback.isPlaying = false;
        if (offlinePlayback.timer) {
            clearInterval(offlinePlayback.timer);
            offlinePlayback.timer = null;
        }
        if (offlinePlayPauseBtn) {
            const tr = I18N[currentLang] || I18N.es;
            offlinePlayPauseBtn.textContent = tr.offlinePlaybackPlay || "▶ Play";
        }
    }

    function updateAdvancedPlotPanelVisibility() {
        const playback = isPlaybackMode();
        if (anomalyPanel) anomalyPanel.style.display = (playback && advancedPlotOpen) ? "block" : "none";
        if (toggleAdvancedPlotBtn) {
            toggleAdvancedPlotBtn.style.display = playback ? "" : "none";
            toggleAdvancedPlotBtn.textContent = advancedPlotOpen ? "Ocultar avanzadas" : "Opciones avanzadas";
        }
    }

    function setModeUi() {
        const offline = isOfflineMode();
        const replay = isReplayMode();
        const playback = isPlaybackMode(); // offline o replay: controles de carga/reproducción
        const portControl = settingsPanel ? settingsPanel.querySelector(".port-control") : null;
        document.body.classList.toggle("mode-live", !playback);
        document.body.classList.toggle("mode-analysis", offline);
        document.body.classList.toggle("mode-replay", replay);
        if (offlineControls) offlineControls.style.display = playback ? "flex" : "none";
        if (offlinePlaybackControls) offlinePlaybackControls.style.display = playback ? "flex" : "none";
        const setMarkerABtn = document.getElementById("setMarkerABtn");
        const setMarkerBBtn = document.getElementById("setMarkerBBtn");
        const clearMarkersBtn = document.getElementById("clearMarkersBtn");
        const markerInfoLabel = document.getElementById("markerInfoLabel");
        if (replay) {
            if (setMarkerABtn) setMarkerABtn.style.display = "none";
            if (setMarkerBBtn) setMarkerBBtn.style.display = "none";
            if (clearMarkersBtn) clearMarkersBtn.style.display = "none";
            if (markerInfoLabel) markerInfoLabel.style.display = "none";
        } else {
            if (setMarkerABtn) setMarkerABtn.style.display = "";
            if (setMarkerBBtn) setMarkerBBtn.style.display = "";
            if (clearMarkersBtn) clearMarkersBtn.style.display = "";
            if (markerInfoLabel) markerInfoLabel.style.display = "";
        }
        if (alarmPanel) alarmPanel.style.display = playback ? "none" : "";
        const spanLabel = document.getElementById("offlineWindowSpanLabel");
        if (spanLabel) spanLabel.style.display = playback ? "flex" : "none";
        if (recordBtn) recordBtn.style.display = playback ? "none" : "";
        if (refreshNamesBtn) refreshNamesBtn.style.display = playback ? "none" : "";
        if (reconnectBtn) reconnectBtn.style.display = playback ? "none" : "";
        if (pauseBtn) pauseBtn.style.display = playback ? "none" : "";
        if (offlineStepPrevBtn) offlineStepPrevBtn.style.display = offline ? "" : "none";
        if (offlineStepNextBtn) offlineStepNextBtn.style.display = offline ? "" : "none";
        if (portControl) portControl.style.display = playback ? "none" : "";
        if (resetTimeBtn) resetTimeBtn.style.display = playback ? "none" : "";
        if (sendFileOnFinishCheckbox) {
            sendFileOnFinishCheckbox.disabled = playback;
            if (sendFileOnFinishCheckbox.parentElement) sendFileOnFinishCheckbox.parentElement.style.opacity = playback ? "0.55" : "1";
        }
        if (modeSelect) modeSelect.value = appMode;
        if (monitorSortSep) monitorSortSep.style.display = replay ? "" : "none";
        if (monitorSortByNameBtn) monitorSortByNameBtn.style.display = replay ? "" : "none";
        if (monitorSortByGraphBtn) monitorSortByGraphBtn.style.display = replay ? "" : "none";
        if (monitorSortByTsvBtn) monitorSortByTsvBtn.style.display = replay ? "" : "none";
        const plotVsRefWrap = document.getElementById("plotVsRefWrap");
        const plotVsRefCheckbox = document.getElementById("plotVsRefCheckbox");
        if (plotVsRefWrap) plotVsRefWrap.style.display = replay ? "" : "none";
        if (plotVsRefCheckbox) plotVsRefCheckbox.checked = !!plotVsRef;
        updateAdvancedPlotPanelVisibility();
        updateOfflineDatasetStatus();
        updateMarkerInfoLabel();
        renderSegmentsUi();
        renderNotesList();
        renderArincBusHealth();
        rebuildMonitorList();
    }

    function setAppMode(mode, opts = {}) {
        const desired = mode === "offline" ? "offline" : (mode === "replay" ? "replay" : "live");
        const changed = desired !== appMode;
        appMode = desired;
        if (desired === "replay") {
            // Al entrar en replay siempre obligamos a cargar referencia manualmente.
            offlineDataset = null;
            offlineRecordingName = "";
            offlineRecordingGlobalMinTs = null;
            offlineRecordingGlobalMaxTs = null;
        }
        setModeUi();
        if (changed) {
            stopOfflinePlayback();
            if (isLocalRecording) stopLocalRecording(false);
            if (desired === "offline") {
                if (ws) {
                    try { ws.close(); } catch (e) {}
                    ws = null;
                }
                setOfflineStatus();
                if (!opts.keepData) clearDataBuffers();
            } else if (desired === "replay") {
                // Modo híbrido: mantener conexión al backend para tener vars_names + vars_update (C++/SHM).
                setOfflineStatus();
                clearDataBuffers();
                checkAuthThenStart();
            } else {
                resetStateForNewTarget();
                checkAuthThenStart();
            }
        }
        saveConfig();
    }

    function formatBytes(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return "0 B";
        const units = ["B", "KB", "MB", "GB"];
        let val = v;
        let ui = 0;
        while (val >= 1024 && ui < units.length - 1) {
            val /= 1024;
            ui += 1;
        }
        return `${val.toFixed(ui === 0 ? 0 : 1)} ${units[ui]}`;
    }

    function trimTextToFullLines(text) {
        const src = String(text || "");
        const idx = src.lastIndexOf("\n");
        if (idx < 0) return src;
        return src.slice(0, idx + 1);
    }

    function estimateTsvLoadRisk(textSample, rawBytes) {
        const lines = String(textSample || "").split(/\r?\n/).filter((ln) => ln.length > 0);
        const header = lines.length ? lines[0].split("\t") : [];
        const columns = Math.max(1, header.length);
        const sampledRows = Math.max(1, lines.length - 1);
        const sampleBytes = Math.max(1, new Blob([textSample || ""]).size);
        const rowBytesAvg = Math.max(8, sampleBytes / sampledRows);
        const estRows = Math.max(1, Math.floor((Number(rawBytes) || sampleBytes) / rowBytesAvg));
        const estValues = estRows * columns;
        // Heurística conservadora para objetos JS + arrays + historial.
        const estRamBytes = estValues * 48;
        return { columns, estRows, estValues, estRamBytes };
    }

    function parseCell(raw) {
        const t = String(raw ?? "").trim();
        if (!t) return null;
        const low = t.toLowerCase();
        if (low === "nan") return Number.NaN;
        if (low === "inf" || low === "+inf" || low === "infinity" || low === "+infinity") return Number.POSITIVE_INFINITY;
        if (low === "-inf" || low === "-infinity") return Number.NEGATIVE_INFINITY;
        const n = Number(t);
        if (Number.isFinite(n)) return n;
        if (low === "true") return true;
        if (low === "false") return false;
        return t;
    }

    function parseTsvDataset(text, sourceName, opts = {}) {
        const lines = String(text || "").split(/\r?\n/).filter((ln) => ln.length > 0);
        if (lines.length < 2) throw new Error("TSV vacío o incompleto");
        const header = lines[0].split("\t");
        if (header[0] !== "time_s") throw new Error("Cabecera inválida: primera columna debe ser time_s");
        const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0 ? Math.floor(opts.maxRows) : 0;
        const maxSpanSec = Number.isFinite(opts.maxSpanSec) && opts.maxSpanSec > 0 ? Number(opts.maxSpanSec) : 0;

        const scalarCols = [];
        const arrayCols = new Map(); // base -> [{idx, col}]
        for (let c = 1; c < header.length; c++) {
            const col = header[c];
            const m = col.match(/^(.*)_(\d+)$/);
            if (m) {
                const base = m[1];
                const idx = parseInt(m[2], 10);
                if (!arrayCols.has(base)) arrayCols.set(base, []);
                arrayCols.get(base).push({ idx, col: c });
            } else {
                scalarCols.push({ name: col, col: c });
            }
        }
        for (const v of arrayCols.values()) v.sort((a, b) => a.idx - b.idx);

        const samples = [];
        let firstTs = null;
        let stoppedEarly = false;
        for (let r = 1; r < lines.length; r++) {
            const parts = lines[r].split("\t");
            const ts = Number(parts[0]);
            if (!Number.isFinite(ts)) continue;
            if (!Number.isFinite(firstTs)) firstTs = ts;
            const data = [];
            for (const s of scalarCols) {
                const val = parseCell(parts[s.col] ?? "");
                if (val === null) continue;
                data.push({ name: s.name, type: typeof val === "boolean" ? "bool" : "double", value: val, timestamp: ts });
            }
            for (const [base, cols] of arrayCols.entries()) {
                const arr = [];
                let hasAny = false;
                for (let i = 0; i < cols.length; i++) {
                    const val = parseCell(parts[cols[i].col] ?? "");
                    if (val === null) {
                        arr.push(null);
                    } else {
                        arr.push(typeof val === "number" ? val : Number(val));
                        hasAny = hasAny || Number.isFinite(arr[arr.length - 1]);
                    }
                }
                if (hasAny) {
                    const nums = arr.map((v) => Number.isFinite(v) ? v : 0);
                    data.push({ name: base, type: "array", value: nums, timestamp: ts });
                }
            }
            samples.push({ ts, data });
            if (maxRows > 0 && samples.length >= maxRows) {
                stoppedEarly = true;
                break;
            }
            if (maxSpanSec > 0 && Number.isFinite(firstTs) && (ts - firstTs) >= maxSpanSec) {
                stoppedEarly = true;
                break;
            }
        }
        if (samples.length === 0) throw new Error("No hay filas válidas en el TSV");
        samples.sort((a, b) => a.ts - b.ts);
        const namesSet = new Set();
        for (const s of samples) for (const e of s.data) namesSet.add(e.name);
        const names = Array.from(namesSet).sort();
        const minTs = samples[0].ts;
        const maxTs = samples[samples.length - 1].ts;
        return {
            sourceName: sourceName || "dataset.tsv",
            samples,
            names,
            minTs,
            maxTs,
            isEpoch: minTs > 1e9,
            isPreview: !!opts.isPreview,
            truncated: !!opts.isPreview && (stoppedEarly || lines.length > samples.length + 1),
        };
    }

    function binarySearchSampleIndex(samples, ts) {
        let lo = 0, hi = samples.length - 1, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (samples[mid].ts <= ts) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return ans;
    }

    function buildHistoriesFromDataset(ds) {
        const hCache = {};
        const arrCache = {};
        for (let i = 0; i < ds.samples.length; i++) {
            const s = ds.samples[i];
            for (let j = 0; j < s.data.length; j++) {
                const v = s.data[j];
                if (Array.isArray(v.value)) {
                    for (let k = 0; k < v.value.length; k++) {
                        const eName = arrayElemName(v.name, k);
                        if (!arrCache[eName]) arrCache[eName] = { timestamps: [], values: [] };
                        arrCache[eName].timestamps.push(s.ts);
                        arrCache[eName].values.push(Number(v.value[k]) || 0);
                    }
                } else {
                    const num = typeof v.value === "number" ? v.value : (v.value === true ? 1 : v.value === false ? 0 : Number(v.value));
                    if (!Number.isFinite(num)) continue;
                    if (!hCache[v.name]) hCache[v.name] = { timestamps: [], values: [] };
                    hCache[v.name].timestamps.push(s.ts);
                    hCache[v.name].values.push(num);
                }
            }
        }
        return { historyCache: hCache, arrayElemHistory: arrCache };
    }

    function rebuildHistoriesFromOffline(ds) {
        const built = buildHistoriesFromDataset(ds);
        historyCache = built.historyCache;
        arrayElemHistory = built.arrayElemHistory;
        // Fase 0: en modo seguro no construir autoderivados ARINC al inicio; se construyen on-demand al activar ARINC en una variable.
        if (!offlineSafetyInfo || !offlineSafetyInfo.safeMode) {
            rebuildAllArincDerivedHistories();
        }
    }

    function buildInitialOfflineSnapshot(ds) {
        const firstSeen = new Map(); // name -> entry
        for (let i = 0; i < ds.samples.length; i++) {
            const s = ds.samples[i];
            for (let j = 0; j < s.data.length; j++) {
                const e = s.data[j];
                if (!firstSeen.has(e.name)) {
                    firstSeen.set(e.name, e);
                }
            }
            if (firstSeen.size >= ds.names.length) break;
        }
        return Array.from(firstSeen.values());
    }

    function updateOfflineTimeLabel(ts) {
        if (!offlineTimeLabel || !offlineDataset) return;
        // Si tenemos referencia global de grabación, usarla para que los tramos
        // sucesivos no vuelvan a 0s.
        const base = Number.isFinite(offlineRecordingGlobalMinTs)
            ? offlineRecordingGlobalMinTs
            : offlineDataset.minTs;
        const rel = Math.max(0, ts - base);
        offlineTimeLabel.textContent = "t=" + rel.toFixed(3) + "s";
    }

    function updateOfflineScrubberFromTs(ts) {
        if (!offlineScrubber || !offlineDataset) return;
        const minTs = Number.isFinite(offlineRecordingGlobalMinTs) ? offlineRecordingGlobalMinTs : offlineDataset.minTs;
        const maxTs = Number.isFinite(offlineRecordingGlobalMaxTs) ? offlineRecordingGlobalMaxTs : offlineDataset.maxTs;
        const span = Math.max(1e-9, maxTs - minTs);
        const ratio = (ts - minTs) / span;
        offlineScrubber.value = String(Math.max(0, Math.min(1000, Math.round(ratio * 1000))));
    }

    function applyOfflineTime(ts) {
        if (!offlineDataset || offlineDataset.samples.length === 0) return;
        const minTs = Number.isFinite(offlineRecordingGlobalMinTs) ? offlineRecordingGlobalMinTs : offlineDataset.minTs;
        const maxTs = Number.isFinite(offlineRecordingGlobalMaxTs) ? offlineRecordingGlobalMaxTs : offlineDataset.maxTs;
        const clamped = Math.max(minTs, Math.min(maxTs, ts));
        offlinePlayback.currentTs = clamped;
        // Mientras solo tengamos cargado un tramo, el índice se limita al rango
        // disponible en offlineDataset; las ventanas cortas e históricos completos
        // se encargan de mostrar datos fuera de este tramo si existen.
        const idx = binarySearchSampleIndex(offlineDataset.samples, clamped);
        offlinePlayback.currentIndex = idx;
        const sample = offlineDataset.samples[idx];
        const replayData = (isReplayMode() && Array.isArray(sample.data))
            ? sample.data.filter((it) => it && it.name && impositionNames.has(it.name) && isVarInTsv(it.name))
            : sample.data;
        onVarsUpdate(replayData, { timestamp: sample.ts, appendHistory: false });
        updateOfflineScrubberFromTs(clamped);
        updateOfflineTimeLabel(clamped);
        // Pedir ventanas cortas para variables solo monitorizadas alrededor del nuevo tiempo.
        scheduleWindowFetchAroundTime(clamped);
        // En replay híbrido, imponer continuamente sobre SHM los valores marcados.
        applyReplayImpositions(clamped);
    }

    function stepOfflineBySample(direction) {
        if (!isOfflineMode() || !offlineDataset || !Array.isArray(offlineDataset.samples) || offlineDataset.samples.length === 0) return;
        const dir = direction < 0 ? -1 : 1;
        stopOfflinePlayback();
        const samples = offlineDataset.samples;
        const curTs = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : offlineDataset.minTs;
        let idx = binarySearchSampleIndex(samples, curTs);
        idx = Math.max(0, Math.min(samples.length - 1, idx));
        const tsAtIdx = Number(samples[idx] && samples[idx].ts);
        const eps = 1e-9;
        let targetIdx = idx;
        if (dir > 0) {
            targetIdx = (Number.isFinite(tsAtIdx) && curTs < (tsAtIdx - eps)) ? idx : (idx + 1);
        } else {
            targetIdx = (Number.isFinite(tsAtIdx) && Math.abs(curTs - tsAtIdx) <= eps) ? (idx - 1) : idx;
        }
        targetIdx = Math.max(0, Math.min(samples.length - 1, targetIdx));
        const targetTs = Number(samples[targetIdx] && samples[targetIdx].ts);
        if (!Number.isFinite(targetTs)) return;
        applyOfflineTime(targetTs);
        updateMonitorValues();
        schedulePlotRender();
    }

    function getReplayImposedValueAtTs(name, ts) {
        if (!name || !Number.isFinite(ts)) return null;
        if (!offlineDataset || !Array.isArray(offlineDataset.samples) || offlineDataset.samples.length === 0) return null;
        const idx = binarySearchSampleIndex(offlineDataset.samples, ts);
        const sample = offlineDataset.samples[idx];
        if (!sample || !Array.isArray(sample.data)) return null;
        const entry = sample.data.find((it) => it && it.name === name);
        if (entry) {
            const n = (typeof entry.value === "number") ? entry.value : Number(entry.value);
            if (Number.isFinite(n)) return n;
        }
        const hist = historyCache[name];
        const vHist = getValueAtTs(hist, ts);
        if (vHist != null) return vHist;
        return null;
    }

    function applyReplayImpositions(currentTs) {
        if (!isReplayMode() || !offlineDataset || !Number.isFinite(currentTs)) return;
        if (impositionNames.size === 0) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        impositionNames.forEach((name) => {
            if (!isVarInTsv(name)) return;
            const dt = Number(impositionTimeOffset[name]);
            const dv = Number(impositionValueOffset[name]);
            const tImpose = currentTs + (Number.isFinite(dt) ? dt : 0);
            const baseVal = getReplayImposedValueAtTs(name, tImpose);
            if (baseVal == null) return;
            const vd = varsByName[name];
            const varType = vd
                ? (vd.type === "int32" ? "int32" : vd.type === "bool" ? "bool" : "double")
                : "double";
            let sendVal = baseVal + (Number.isFinite(dv) ? dv : 0);
            if (varType === "bool") sendVal = sendVal ? 1 : 0;
            else if (varType === "int32") sendVal = (Math.trunc(sendVal) | 0);
            sendWsAction({
                action: "set_var",
                name: name,
                value: sendVal,
                var_type: varType,
            });
        });
    }

    function syncReplayTsvHistoryForName(name) {
        if (!isReplayMode() || !name || !isVarInTsv(name) || isArrayVar(name)) return;
        if (impositionNames.has(name)) {
            const series = getRefSeriesFromOfflineDataset(name);
            if (series && Array.isArray(series.timestamps) && Array.isArray(series.values)) {
                historyCache[name] = {
                    timestamps: series.timestamps.slice(),
                    values: series.values.slice(),
                };
                fullHistoryByName[name] = {
                    timestamps: series.timestamps.slice(),
                    values: series.values.slice(),
                };
            }
        } else {
            delete historyCache[name];
            delete fullHistoryByName[name];
        }
    }

    /** Serie de referencia desde el TSV (solo replay); para plotVsRef con etiqueta _ref. */
    function getRefSeriesFromOfflineDataset(name) {
        if (!offlineDataset || !Array.isArray(offlineDataset.samples) || offlineDataset.samples.length === 0) return null;
        const isArrElem = name.includes("[") && name.endsWith("]");
        let base, idx;
        if (isArrElem) {
            const br = name.lastIndexOf("[");
            base = name.substring(0, br);
            idx = parseInt(name.substring(br + 1), 10);
            if (!Number.isFinite(idx)) return null;
        }
        const timestamps = [];
        const values = [];
        for (let i = 0; i < offlineDataset.samples.length; i++) {
            const s = offlineDataset.samples[i];
            if (!s || !Array.isArray(s.data)) continue;
            let v = null;
            if (isArrElem) {
                const e = s.data.find((it) => it && it.name === base && Array.isArray(it.value));
                if (e && idx >= 0 && idx < e.value.length) v = e.value[idx];
            } else {
                const e = s.data.find((it) => it && it.name === name);
                if (e) v = e.value;
            }
            if (v !== null && v !== undefined) {
                timestamps.push(Number(s.ts));
                values.push(typeof v === "number" ? v : Number(v));
            }
        }
        if (timestamps.length === 0) return null;
        return { timestamps, values };
    }

    function getValueAtTs(hist, ts) {
        if (!hist || !hist.timestamps || hist.timestamps.length === 0 || !Number.isFinite(ts)) return null;
        const xs = hist.timestamps;
        let lo = 0, hi = xs.length - 1, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (xs[mid] <= ts) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        const v = hist.values[ans];
        return Number.isFinite(v) ? v : null;
    }

    function getOfflineScalarValueAtTs(name, ts) {
        if (!offlineDataset || !Array.isArray(offlineDataset.samples) || offlineDataset.samples.length === 0) return null;
        if (!name || !Number.isFinite(ts)) return null;
        const idx = binarySearchSampleIndex(offlineDataset.samples, ts);
        const s = offlineDataset.samples[idx];
        if (!s || !Array.isArray(s.data)) return null;
        const e = s.data.find((it) => it && it.name === name && !Array.isArray(it.value));
        if (!e) return null;
        const n = (typeof e.value === "number") ? e.value : Number(e.value);
        return Number.isFinite(n) ? n : null;
    }

    function recomputeDeltaByName() {
        deltaByName = {};
        if (!Number.isFinite(markerA) || !Number.isFinite(markerB)) return;
        for (const name of monitoredNames) {
            if (isArrayVar(name)) continue;
            const hist = historyCache[name];
            let vA = getValueAtTs(hist, markerA);
            let vB = getValueAtTs(hist, markerB);
            if (isPlaybackMode() && (vA == null || vB == null)) {
                if (vA == null) vA = getOfflineScalarValueAtTs(name, markerA);
                if (vB == null) vB = getOfflineScalarValueAtTs(name, markerB);
            }
            if (vA == null || vB == null) continue;
            deltaByName[name] = vB - vA;
        }
        if (monitoredOrder.length > 1) {
            monitoredOrder.sort((a, b) => {
                const da = Number.isFinite(deltaByName[a]) ? Math.abs(deltaByName[a]) : 0;
                const db = Number.isFinite(deltaByName[b]) ? Math.abs(deltaByName[b]) : 0;
                const aChanged = da > 1e-9;
                const bChanged = db > 1e-9;
                if (aChanged && !bChanged) return -1;
                if (!aChanged && bChanged) return 1;
                if (aChanged && bChanged && db !== da) return db - da;
                return 0;
            });
        }
    }

    function renderAnomalyList() {
        if (!anomalyListEl) return;
        anomalyListEl.innerHTML = "";
        if (!anomalyResults.length) {
            const empty = document.createElement("div");
            empty.className = "stats-empty";
            empty.textContent = "Sin anomalías detectadas";
            anomalyListEl.appendChild(empty);
            return;
        }
        const maxRows = 150;
        const rows = anomalyResults.slice(0, maxRows);
        for (let i = 0; i < rows.length; i++) {
            const a = rows[i];
            const row = document.createElement("div");
            row.className = "anomaly-item";
            const txt = document.createElement("span");
            const relTs = (offlineDataset && Number.isFinite(offlineDataset.minTs))
                ? Math.max(0, a.ts - offlineDataset.minTs)
                : a.ts;
            const typeLabel = a.type === "lo_cross"
                ? "Lo-cross"
                : a.type === "hi_cross"
                    ? "Hi-cross"
                    : a.type;
            txt.textContent = `${relTs.toFixed(3)}s | ${a.name} | ${typeLabel} | ${a.detail}`;
            const go = document.createElement("button");
            go.className = "btn-small";
            go.textContent = "Ir";
            go.addEventListener("click", () => {
                applyOfflineTime(a.ts);
                schedulePlotRender();
            });
            row.appendChild(txt);
            row.appendChild(go);
            anomalyListEl.appendChild(row);
        }
    }

    function runAnomalyScan() {
        anomalyResults = [];
        if (!offlineDataset) {
            renderAnomalyList();
            return;
        }
        const jumpThr = Math.max(0, Number(anomalyJumpInput?.value) || 1.0);
        const globalLo = anomalyLoInput && anomalyLoInput.value !== "" ? Number(anomalyLoInput.value) : null;
        const globalHi = anomalyHiInput && anomalyHiInput.value !== "" ? Number(anomalyHiInput.value) : null;
        const plottedSet = new Set();
        for (let gi = 0; gi < graphList.length; gi++) {
            const varsInGraph = getVarsForGraph(graphList[gi]);
            for (let vi = 0; vi < varsInGraph.length; vi++) plottedSet.add(varsInGraph[vi]);
        }
        const names = Array.from(plottedSet);
        if (names.length === 0) {
            renderAnomalyList();
            return;
        }
        if (window.Worker) {
            try {
                const payload = [];
                for (let i = 0; i < names.length; i++) {
                    const n = names[i];
                    const h = isArrayElem(n) ? arrayElemHistory[n] : historyCache[n];
                    if (!h || !h.timestamps || !h.values) continue;
                    payload.push({ name: n, timestamps: h.timestamps, values: h.values });
                }
                const workerSrc = `
                    self.onmessage = (ev) => {
                      const { series, jumpThr, lo, hi } = ev.data;
                      const out = [];
                      for (const s of series) {
                        const xs = s.timestamps || [];
                        const ys = s.values || [];
                        for (let i = 1; i < ys.length; i++) {
                          const d = ys[i] - ys[i - 1];
                          if (Math.abs(d) >= jumpThr) out.push({ ts: xs[i], name: s.name, type: "jump", detail: "Δ=" + d.toFixed(4) });
                          if (lo != null && ys[i - 1] > lo && ys[i] <= lo) out.push({ ts: xs[i], name: s.name, type: "lo_cross", detail: "v=" + ys[i].toFixed(4) });
                          if (hi != null && ys[i - 1] < hi && ys[i] >= hi) out.push({ ts: xs[i], name: s.name, type: "hi_cross", detail: "v=" + ys[i].toFixed(4) });
                        }
                      }
                      out.sort((a,b)=>a.ts-b.ts);
                      self.postMessage(out);
                    };`;
                const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" })));
                worker.onmessage = (ev) => {
                    anomalyResults = Array.isArray(ev.data) ? ev.data : [];
                    eventCursorIndex = anomalyResults.length > 0 ? 0 : -1;
                    renderAnomalyList();
                    renderArincBusHealth();
                    worker.terminate();
                };
                worker.postMessage({
                    series: payload,
                    jumpThr: Math.max(0, Number(anomalyJumpInput?.value) || 1.0),
                    lo: anomalyLoInput && anomalyLoInput.value !== "" ? Number(anomalyLoInput.value) : null,
                    hi: anomalyHiInput && anomalyHiInput.value !== "" ? Number(anomalyHiInput.value) : null,
                });
                return;
            } catch (e) {
                // Fallback a ejecución local.
            }
        }
        const plottedScalarNames = new Set();
        const plottedArrayElems = [];
        for (let i = 0; i < names.length; i++) {
            const n = names[i];
            if (isArrayElem(n)) {
                const br = n.lastIndexOf("[");
                const base = n.slice(0, br);
                const idx = parseInt(n.slice(br + 1, -1), 10);
                if (Number.isFinite(idx)) plottedArrayElems.push({ name: n, base, idx });
            } else {
                plottedScalarNames.add(n);
            }
        }
        for (let ni = 0; ni < names.length; ni++) {
            const name = names[ni];
            const hist = isArrayElem(name) ? arrayElemHistory[name] : historyCache[name];
            if (!hist || !hist.values || hist.values.length < 2) continue;
            const xs = hist.timestamps;
            const ys = hist.values;
            for (let i = 1; i < ys.length; i++) {
                const d = ys[i] - ys[i - 1];
                if (Math.abs(d) >= jumpThr) {
                    anomalyResults.push({ ts: xs[i], name, type: "jump", detail: `Δ=${d.toFixed(4)}` });
                }
            }
            if ((globalLo != null && Number.isFinite(globalLo)) || (globalHi != null && Number.isFinite(globalHi))) {
                for (let i = 1; i < ys.length; i++) {
                    const prev = ys[i - 1];
                    const curr = ys[i];
                    const crossLo = (globalLo != null && Number.isFinite(globalLo) && prev > globalLo && curr <= globalLo);
                    const crossHi = (globalHi != null && Number.isFinite(globalHi) && prev < globalHi && curr >= globalHi);
                    if (crossLo) anomalyResults.push({ ts: xs[i], name, type: "lo_cross", detail: `v=${curr.toFixed(4)}` });
                    if (crossHi) anomalyResults.push({ ts: xs[i], name, type: "hi_cross", detail: `v=${curr.toFixed(4)}` });
                }
            }
        }
        // Detección NaN/inf directamente de muestras A (por si en history fueron filtradas).
        for (let si = 0; si < offlineDataset.samples.length; si++) {
            const s = offlineDataset.samples[si];
            for (let j = 0; j < s.data.length; j++) {
                const e = s.data[j];
                if (!Array.isArray(e.value)) {
                    if (!plottedScalarNames.has(e.name)) continue;
                    if (typeof e.value === "number" && !Number.isFinite(e.value)) {
                        anomalyResults.push({ ts: s.ts, name: e.name, type: "nan_inf", detail: String(e.value) });
                    }
                    continue;
                }
                for (let ai = 0; ai < plottedArrayElems.length; ai++) {
                    const it = plottedArrayElems[ai];
                    if (it.base !== e.name) continue;
                    const v = e.value[it.idx];
                    if (typeof v === "number" && !Number.isFinite(v)) {
                        anomalyResults.push({ ts: s.ts, name: it.name, type: "nan_inf", detail: String(v) });
                    }
                }
            }
        }
        anomalyResults.sort((a, b) => a.ts - b.ts);
        eventCursorIndex = anomalyResults.length > 0 ? 0 : -1;
        renderAnomalyList();
        renderArincBusHealth();
    }

    function startOfflinePlayback() {
        if (!offlineDataset || offlineDataset.samples.length === 0 || !isPlaybackMode()) return;
        if (offlinePlayback.isPlaying) return;
        // Si estamos al final del tramo actual, solo entonces reiniciamos al inicio
        // de este tramo. Si no, respetamos la posición actual (por ejemplo, al
        // cambiar de tramo en análisis de grabaciones grandes).
        const minTs = Number.isFinite(offlineRecordingGlobalMinTs) ? offlineRecordingGlobalMinTs : offlineDataset.minTs;
        const maxTs = Number.isFinite(offlineRecordingGlobalMaxTs) ? offlineRecordingGlobalMaxTs : offlineDataset.maxTs;
        if (!Number.isFinite(offlinePlayback.currentTs) ||
            offlinePlayback.currentTs >= (maxTs - 1e-9)) {
            applyOfflineTime(minTs);
            schedulePlotRender();
        }
        offlinePlayback.isPlaying = true;
        offlinePlayback.lastTickMs = Date.now();
        const tr = I18N[currentLang] || I18N.es;
        if (offlinePlayPauseBtn) offlinePlayPauseBtn.textContent = tr.offlinePlaybackPause || "⏸ Pause";
        offlinePlayback.timer = setInterval(() => {
            if (!offlinePlayback.isPlaying || !offlineDataset) return;
            const now = Date.now();
            const dt = (now - offlinePlayback.lastTickMs) / 1000;
            offlinePlayback.lastTickMs = now;
            const nextTs = offlinePlayback.currentTs + dt * (offlinePlayback.speed || 1);
            const maxTs = Number.isFinite(offlineRecordingGlobalMaxTs) ? offlineRecordingGlobalMaxTs : offlineDataset.maxTs;
            if (nextTs >= maxTs) {
                applyOfflineTime(maxTs);
                schedulePlotRender();
                stopOfflinePlayback();
                // Al terminar no forzamos volver al inicio automáticamente, para
                // que el usuario pueda seguir navegando entre tramos sin que el
                // eje X se reseteé.
                return;
            }
            applyOfflineTime(nextTs);
            schedulePlotRender();
        }, 40);
    }

    function shouldUseSafeOfflineLoad(sizeBytes) {
        const mb = Number(sizeBytes) / (1024 * 1024);
        return Number.isFinite(mb) && mb > offlineFullLoadMaxMb;
    }

    function shouldForceFullLoadWithConfirmation(label, sizeBytes, estRamBytes) {
        if (!offlineAllowForceFullLoad) return false;
        const tr = I18N[currentLang] || I18N.es;
        return window.confirm(
            `${tr.offlineDatasetSafeMode || "Modo seguro"} recomendado para ${label}.\n` +
            `Tamaño archivo: ${formatBytes(sizeBytes)}\n` +
            `RAM estimada en carga completa: ~${formatBytes(estRamBytes)}\n\n` +
            `¿Forzar carga completa igualmente?`
        );
    }

    async function loadLargeLocalFileInSafeMode(file) {
        const tr = I18N[currentLang] || I18N.es;
        const sizeBytes = Number(file && file.size) || 0;
        const previewBytes = Math.max(1, Math.floor(offlinePreviewMb * 1024 * 1024));
        const previewRaw = await file.slice(0, previewBytes).text();
        const previewText = trimTextToFullLines(previewRaw);
        const risk = estimateTsvLoadRisk(previewText, sizeBytes);
        const ds = parseTsvDataset(previewText, file.name, {
            isPreview: true,
            maxRows: offlineSafePreviewMaxRows,
            maxSpanSec: offlineSafePreviewMaxSpanSec,
        });
        const safeInfo = {
            safeMode: true,
            totalBytes: sizeBytes,
            estRamBytes: risk.estRamBytes,
            columns: risk.columns,
            estRows: risk.estRows,
            reason: "size",
        };
        alert(
            `${tr.offlineDatasetSafeMode || "Modo seguro"}: ${file.name}\n` +
            `Tamaño: ${formatBytes(sizeBytes)}\n` +
            `Estimación RAM carga completa: ~${formatBytes(risk.estRamBytes)}\n` +
            `Se carga solo un tramo inicial (${offlineSafePreviewMaxRows} filas máx / ${offlineSafePreviewMaxSpanSec}s).`
        );
        return { ds, safeInfo };
    }

    async function loadLargeServerFileInSafeMode(filename, sizeBytes, byteOffset = 0) {
        const tr = I18N[currentLang] || I18N.es;
        const previewBytes = Math.max(1, Math.floor(offlinePreviewMb * 1024 * 1024));
        const url = byteOffset > 0
            ? `/api/recordings/${encodeURIComponent(filename)}?preview_bytes=${previewBytes}&offset=${byteOffset}`
            : `/api/recordings/${encodeURIComponent(filename)}?preview_bytes=${previewBytes}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error("No se pudo descargar preview de la grabación");
        const payload = await r.json();
        const previewText = trimTextToFullLines(payload && payload.preview ? payload.preview : "");
        const totalBytes = Number(sizeBytes) || Number(payload && payload.size) || 0;
        const risk = estimateTsvLoadRisk(previewText, totalBytes);
        const ds = parseTsvDataset(previewText, filename, {
            isPreview: true,
            maxRows: offlineSafePreviewMaxRows,
            maxSpanSec: offlineSafePreviewMaxSpanSec,
        });
        const segmentStart = Number(payload.segment_start) || 0;
        const segmentEnd = segmentStart + (Number(payload.preview_bytes) || 0);
        const segmentSpanSec = Math.max(0, ds.maxTs - ds.minTs);
        const safeInfo = {
            safeMode: true,
            totalBytes,
            segmentStartByte: segmentStart,
            segmentEndByte: segmentEnd,
            segmentSpanSec,
            estRamBytes: risk.estRamBytes,
            columns: risk.columns,
            estRows: risk.estRows,
            reason: "size",
        };
        if (byteOffset === 0) {
            // Nuevo ciclo de análisis seguro para esta grabación: reiniciar offset acumulado.
            offlineSegmentOffsetSec = 0;
            alert(
                `${tr.offlineDatasetSafeMode || "Modo seguro"}: ${filename}\n` +
                `Tamaño: ${formatBytes(safeInfo.totalBytes)}\n` +
                `Estimación RAM carga completa: ~${formatBytes(risk.estRamBytes)}\n` +
                `Se carga solo un tramo inicial (${offlineSafePreviewMaxRows} filas máx / ${offlineSafePreviewMaxSpanSec}s).`
            );
        }
        return { ds, safeInfo };
    }

    /** Fase 1: cargar otro tramo de la misma grabación (solo servidor, modo seguro). */
    async function loadRecordingChunkAtOffset(byteOffset) {
        const filename = (offlineRecordingName || "").trim();
        if (!filename || !offlineSafetyInfo || !offlineSafetyInfo.safeMode) return;
        const totalBytes = offlineSafetyInfo.totalBytes || 0;
        if (byteOffset < 0 || byteOffset >= totalBytes) return;
        try {
            // Cargar el tramo tal cual viene en el TSV: la columna time_s ya es
            // tiempo absoluto desde 0, no hay que aplicar offsets adicionales.
            // Solo usamos offlineRecordingGlobalMinTs como referencia de origen.
            const globalBaseTs = Number.isFinite(offlineRecordingGlobalMinTs)
                ? offlineRecordingGlobalMinTs
                : null;

            const safe = await loadLargeServerFileInSafeMode(filename, totalBytes, byteOffset);
            loadOfflineDataset(safe.ds, { recordingName: filename, safeInfo: safe.safeInfo, preserveLayout: true });

            // Mantener la referencia global del primer tramo (suele ser 0s).
            if (globalBaseTs !== null && Number.isFinite(globalBaseTs)) {
                offlineRecordingGlobalMinTs = globalBaseTs;
            }

            // Seguimos actualizando la info de tramos solo para UI de botones,
            // pero sin tocar los timestamps reales.
            if (safe.safeInfo && Number.isFinite(safe.safeInfo.segmentSpanSec)) {
                const baseOffset = Number.isFinite(offlineSegmentOffsetSec) ? offlineSegmentOffsetSec : 0;
                offlineSegmentOffsetSec = baseOffset + safe.safeInfo.segmentSpanSec;
            }
            updateOfflineChunkButtons();
        } catch (e) {
            alert("Error cargando tramo: " + (e && e.message ? e.message : String(e)));
        }
    }

    function updateOfflineChunkButtons() {
        const prevBtn = document.getElementById("offlineChunkPrevBtn");
        const nextBtn = document.getElementById("offlineChunkNextBtn");
        if (!prevBtn || !nextBtn) return;
        const canChunk = !!(offlineSafetyInfo && offlineSafetyInfo.safeMode && offlineRecordingName);
        prevBtn.style.display = canChunk ? "" : "none";
        nextBtn.style.display = canChunk ? "" : "none";
        if (!canChunk) return;
        const start = offlineSafetyInfo.segmentStartByte || 0;
        const end = offlineSafetyInfo.segmentEndByte || 0;
        const total = offlineSafetyInfo.totalBytes || 0;
        const previewBytes = Math.max(1, Math.floor(offlinePreviewMb * 1024 * 1024));
        prevBtn.disabled = start <= 0;
        nextBtn.disabled = end >= total;
    }

    async function refreshServerRecordings() {
        if (!recordingSelect) return;
        try {
            const resp = await fetch("/api/recordings");
            if (!resp.ok) throw new Error("no recordings");
            const data = await resp.json();
            const tr = I18N[currentLang] || I18N.es;
            recordingSelect.innerHTML = "";
            recordingsMetaByName = new Map();
            const rows = Array.isArray(data.recordings) ? data.recordings : [];
            if (rows.length === 0) {
                const op = document.createElement("option");
                op.value = "";
                op.textContent = tr.offlineNoRecordings || "(sin grabaciones)";
                recordingSelect.appendChild(op);
                return;
            }
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const op = document.createElement("option");
                op.value = r.filename;
                op.textContent = r.filename;
                recordingSelect.appendChild(op);
                recordingsMetaByName.set(r.filename, r);
            }
        } catch (e) {
            recordingSelect.innerHTML = "";
            recordingsMetaByName = new Map();
            const op = document.createElement("option");
            op.value = "";
            op.textContent = "(error cargando lista)";
            recordingSelect.appendChild(op);
        }
    }

    async function loadOfflineDataset(ds, opts = {}) {
        const preserveLayout = !!opts.preserveLayout;
        stopOfflinePlayback();
        const prevRecording = offlineRecordingName || "";
        // En replay (modo híbrido) conservar nombres del backend para unir con los del TSV.
        const liveVarNamesForMerge = isReplayMode() ? baseKnownVarNames.slice() : [];
        if (!preserveLayout) clearUserLayout();
        clearDataBuffers();
        // Si cambiamos de grabación, el historial completo por variable ya no es válido.
        if (opts.recordingName && opts.recordingName !== prevRecording) {
            fullHistoryByName = {};
        }
        // Si conservamos layout (monitorizadas + asignación de gráficos),
        // hay que reconstruir los slots visuales tras limpiar buffers/DOM.
        if (preserveLayout) {
            rebuildPlotArea();
            rebuildMonitorList();
        }
        offlineDataset = ds;
        varNamesInTsv = new Set(ds && Array.isArray(ds.names) ? ds.names : []);
        // Mantener una referencia global de tiempo por grabación para que
        // los tramos sucesivos no reinicien el eje temporal a 0. Solo se
        // inicializa una vez (aunque ds.minTs pueda ser 0, que es válido).
        if (ds && Number.isFinite(ds.minTs) && !Number.isFinite(offlineRecordingGlobalMinTs)) {
            offlineRecordingGlobalMinTs = ds.minTs;
        }
        offlineSafetyInfo = opts.safeInfo && opts.safeInfo.safeMode ? { ...opts.safeInfo } : null;
        if (typeof opts.recordingName === "string") {
            offlineRecordingName = opts.recordingName;
        } else if (!offlineRecordingName && ds && ds.sourceName && recordingSelect && Array.from(recordingSelect.options).some((o) => o.value === ds.sourceName)) {
            offlineRecordingName = ds.sourceName;
        }
        // Si conocemos el nombre de la grabación y aún no tenemos maxTs global,
        // pedirlo al backend para que el scrubber y el playback trabajen sobre
        // el tiempo completo en lugar de solo el primer tramo.
        if (offlineRecordingName && !Number.isFinite(offlineRecordingGlobalMaxTs)) {
            try {
                const resp = await fetch(
                    `/api/recordings/${encodeURIComponent(offlineRecordingName)}/bounds`
                );
                if (resp.ok) {
                    const bd = await resp.json();
                    const minB = Number(bd.minTs);
                    const maxB = Number(bd.maxTs);
                    if (Number.isFinite(minB)) offlineRecordingGlobalMinTs = minB;
                    if (Number.isFinite(maxB)) offlineRecordingGlobalMaxTs = maxB;
                }
            } catch (e) {
                // Si falla, seguimos usando los min/max del tramo actual.
            }
        }
        markerA = null;
        markerB = null;
        deltaByName = {};
        if (timeWindowSelect) timeWindowSelect.value = "120"; // 2 min en modo análisis (máx. buffer visual)
        if (isReplayMode() && liveVarNamesForMerge.length > 0) {
            const merged = [...new Set([...(ds && ds.names ? ds.names : []), ...liveVarNamesForMerge])].sort();
            onVarNames(merged);
        } else {
            onVarNames(ds.names);
        }
        rebuildHistoriesFromOffline(ds);
        if (isReplayMode() && ds && Array.isArray(ds.names)) {
            ds.names.forEach((n) => syncReplayTsvHistoryForName(n));
        }
        // Si ya teníamos históricos completos de variables (cargados bajo demanda),
        // reinyectarlos tras cambiar de tramo para que los gráficos sigan usando
        // el espectro total de tiempo.
        restoreFullHistoriesForPlottedVars();
        // restoreFullHistoriesForPlottedVars puede reinyectar histórico TSV completo:
        // volver a sincronizar para limpiar las TSV NO impuestas.
        if (isReplayMode() && ds && Array.isArray(ds.names)) {
            ds.names.forEach((n) => syncReplayTsvHistoryForName(n));
        }
        // Inicializar valores visibles con el primer valor disponible de cada variable.
        const initialSnapshot = buildInitialOfflineSnapshot(ds);
        if (initialSnapshot.length > 0) {
            onVarsUpdate(initialSnapshot, { appendHistory: false });
        }
        offlinePlayback.currentTs = ds.minTs;
        offlinePlayback.currentIndex = 0;
        if (offlineSpeedSelect) {
            const sp = Number(offlineSpeedSelect.value);
            offlinePlayback.speed = Number.isFinite(sp) && sp > 0 ? sp : 1;
        } else {
            offlinePlayback.speed = 1;
        }
        applyOfflineTime(ds.minTs);
        recomputeDeltaByName();
        setOfflineStatus();
        if (!preserveLayout) rebuildMonitorList();
        updateOfflineDatasetStatus();
        updateMarkerInfoLabel();
        updateOfflineChunkButtons();
        renderSegmentsUi();
        renderNotesList();
        schedulePlotRender();
    }

    async function loadRecordingFromServer(filename, opts = {}) {
        if (!filename) return;
        const meta = recordingsMetaByName.get(filename) || null;
        const sizeBytes = Number(meta && meta.size);
        if (shouldUseSafeOfflineLoad(sizeBytes)) {
            let forceFull = false;
            try {
                const previewBytes = Math.max(1, Math.floor(offlinePreviewMb * 1024 * 1024));
                const rMeta = await fetch(`/api/recordings/${encodeURIComponent(filename)}?preview_bytes=${previewBytes}`);
                if (rMeta.ok) {
                    const p = await rMeta.json();
                    const previewText = trimTextToFullLines(p && p.preview ? p.preview : "");
                    const risk = estimateTsvLoadRisk(previewText, sizeBytes || Number(p && p.size) || 0);
                    forceFull = shouldForceFullLoadWithConfirmation(filename, sizeBytes || Number(p && p.size) || 0, risk.estRamBytes);
                }
            } catch (e) { /* si falla, seguimos en modo seguro */ }
            if (forceFull) {
                const rFull = await fetch("/api/recordings/" + encodeURIComponent(filename));
                if (!rFull.ok) throw new Error("No se pudo descargar la grabación");
                const textFull = await rFull.text();
                const dsFull = parseTsvDataset(textFull, filename);
                loadOfflineDataset(dsFull, { ...opts, recordingName: filename, safeInfo: null });
                return;
            }
            const safe = await loadLargeServerFileInSafeMode(filename, sizeBytes);
            // Primer tramo en modo seguro: timestamps tal cual (offset 0). Después
            // de cargarlo, guardamos cuánto dura para poder desplazar los tramos
            // siguientes y que el tiempo sea continuo.
            loadOfflineDataset(safe.ds, { ...opts, recordingName: filename, safeInfo: safe.safeInfo });
            if (safe.safeInfo && Number.isFinite(safe.safeInfo.segmentSpanSec)) {
                offlineSegmentOffsetSec = safe.safeInfo.segmentSpanSec;
                // La referencia global arranca en el primer timestamp real de la grabación.
                offlineRecordingGlobalMinTs = safe.ds.minTs;
            }
            return;
        }
        const r = await fetch("/api/recordings/" + encodeURIComponent(filename));
        if (!r.ok) throw new Error("No se pudo descargar la grabación");
        const text = await r.text();
        const ds = parseTsvDataset(text, filename);
        loadOfflineDataset(ds, { ...opts, recordingName: filename, safeInfo: null });
    }

    function connect() {
        if (!hasBackendConnectionMode()) {
            setOfflineStatus();
            return;
        }
        connectionId += 1;
        const thisId = connectionId;
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const sel = (portSelect && portSelect.value) ? (portSelect.value || "").trim() : "";
        const qs = new URLSearchParams();
        if (sel.startsWith("uds:")) {
            qs.set("uds_path", sel.slice(4));
        }
        const storedPass = sessionStorage.getItem("varmon_password");
        if (storedPass) qs.set("password", storedPass);
        const qp = qs.toString();
        const url = qp ? `${proto}//${location.host}/ws?${qp}` : `${proto}//${location.host}/ws`;
        const socket = new WebSocket(url);
        ws = socket;
        socket.onopen = () => {
            if (thisId !== connectionId) return;
            clearConnectionError();
            statusEl.textContent = (I18N[currentLang] || I18N.es).statusConnected;
            statusEl.className = "status connected";
            clearReconnectPending();
            sendUpdateRatio();
            sendMonitored();
            sendAlarmsToBackend();
            sendSendFileOnFinish();
            restorePendingGeneratorsIfPossible();
        };
        socket.onclose = () => {
            if (thisId !== connectionId) return;
            ws = null;
            statusEl.textContent = (I18N[currentLang] || I18N.es).statusDisconnected;
            statusEl.className = "status disconnected";
            statusEl.title = lastConnectionError || "";
            isRecording = false;
            isRecordingStopping = false;
            pendingRecordingRestart = false;
            if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }
            if (recordBtn) {
                recordBtn.disabled = false;
                recordBtn.textContent = "\u25CF REC";
                recordBtn.classList.remove("recording");
            }
            if (recordTimerEl) recordTimerEl.style.display = "none";
            recordSizeBytes = 0;
        };
        socket.onerror = () => socket.close();
        socket.onmessage = (e) => {
            if (thisId !== connectionId) return;
            const now = Date.now();
            const size = typeof e.data === "string" ? new Blob([e.data]).size : (e.data && e.data.size) || 0;
            wsMessageBuffer.push({ t: now, size });
            const cutoff = now - WS_BUFFER_MAX_AGE_MS;
            while (wsMessageBuffer.length > 0 && wsMessageBuffer[0].t < cutoff) wsMessageBuffer.shift();
            const msg = JSON.parse(e.data);
            if (msg.type === "error") {
                if (msg.message === "auth_required") {
                    sessionStorage.removeItem("varmon_password");
                    showAuthModal(msg.attempts_left, msg.attempt);
                    return;
                }
                setConnectionError(msg.message);
                return;
            }
            clearConnectionError();
            if (msg.type === "vars_names") onVarNames(msg.data);
            else if (msg.type === "vars_update") onVarsUpdate(msg.data);
            else if (msg.type === "set_result") onSetResult(msg);
            else if (msg.type === "alarm_triggered") onAlarmTriggeredFromBackend(msg.triggered);
            else if (msg.type === "alarm_cleared") onAlarmClearedFromBackend(msg.names);
            else if (msg.type === "recording_progress") onRecordingProgress(msg);
            else if (msg.type === "record_finished") onRecordFinished(msg);
            else if (msg.type === "alarm_recording_ready") onAlarmRecordingReady(msg);
        };
    }

    function showAuthModal(attemptsLeft, attempt) {
        if (authOverlay) {
            const tr = I18N[currentLang] || I18N.es;
            const promptEl = document.getElementById("authPrompt");
            if (promptEl) {
                if (attempt !== undefined && attempt > 0) {
                    if (attemptsLeft === 0)
                        promptEl.textContent = tr.authServerClosed || "El servidor se ha cerrado por seguridad.";
                    else if (attemptsLeft === 1)
                        promptEl.textContent = tr.authLastAttempt || "Último intento. Si falla, el servidor se cerrará.";
                    else
                        promptEl.textContent = (tr.authWrongAttempts || "Intentos restantes: %d de 3.").replace("%d", attemptsLeft);
                } else {
                    promptEl.textContent = tr.authPrompt;
                }
            }
            authOverlay.style.display = "flex";
            if (authPasswordInput) {
                authPasswordInput.value = "";
                authPasswordInput.focus();
            }
        }
    }

    function hideAuthModal() {
        if (authOverlay) authOverlay.style.display = "none";
    }

    function setConnectionError(message) {
        lastConnectionError = message || null;
        if (statusEl) {
            statusEl.textContent = (message && message.length <= 60) ? message : ((I18N[currentLang] || I18N.es).statusDisconnected + (message ? ": " + message.substring(0, 50) + "…" : ""));
            statusEl.title = message || "";
        }
    }

    function clearConnectionError() {
        lastConnectionError = null;
        if (statusEl) statusEl.title = "";
    }

    function sendUpdateRatio() {
        sendWsAction({
            action: "set_update_ratio",
            value: parseInt(intervalInput.value, 10) || 5,
        });
    }

    intervalInput.addEventListener("change", () => { sendUpdateRatio(); saveConfig(); });

    function sendMonitored() {
        const realNames = monitoredOrder.filter((n) => !isComputed(n) && !isArincDerivedName(n));
        sendWsAction({
            action: "set_monitored",
            names: realNames,
        });
    }

    function ensureMonitoredName(name) {
        if (!name || monitoredNames.has(name)) return;
        monitoredNames.add(name);
        monitoredOrder.push(name);
        if (!(name in varGraphAssignment)) varGraphAssignment[name] = "";
    }

    function ensureArincBaseMonitored(name) {
        if (!isArincDerivedName(name)) return;
        const base = getArincBaseName(name);
        if (base && knownVarNames.includes(base)) ensureMonitoredName(base);
    }

    function enforceArincMonitoringDependencies() {
        const current = monitoredOrder.slice();
        for (let i = 0; i < current.length; i++) {
            const n = current[i];
            if (!isArincDerivedName(n)) continue;
            const base = getArincBaseName(n);
            if (!base || monitoredNames.has(base)) continue;
            monitoredNames.add(base);
            monitoredOrder.unshift(base);
            if (!(base in varGraphAssignment)) varGraphAssignment[base] = "";
        }
    }

    function pruneArincDerivedFromMonitored() {
        const keep = [];
        for (let i = 0; i < monitoredOrder.length; i++) {
            const n = monitoredOrder[i];
            if (isArincDerivedName(n)) {
                monitoredNames.delete(n);
                continue;
            }
            keep.push(n);
        }
        monitoredOrder = keep;
    }

    function sendRefreshNames() {
        sendWsAction({ action: "refresh_names" });
    }

    refreshNamesBtn.addEventListener("click", sendRefreshNames);

    function isArrayVar(name) {
        const vd = varsByName[name];
        return vd && vd.type === "array";
    }

    function isVarInTsv(name) {
        if (!name) return false;
        const idx = name.indexOf("[");
        const base = idx >= 0 && name.endsWith("]") ? name.substring(0, idx) : name;
        return varNamesInTsv.has(base);
    }

    function formatValue(v, type, name) {
        if (type === "array") {
            if (Array.isArray(v)) return "[" + v.length + "]";
            return "[?]";
        }
        if (type === "bool") return v ? "true" : "false";
        if (typeof v !== "number") return String(v);
        const f = name ? varFormat[name] : undefined;
        const sal = f ? f.sal || "dec" : "dec";
        if (sal === "arinc429") {
            const cfg = name ? getArincConfig(name) : { lsb: 1 };
            const d = decodeArinc429(v, cfg);
            const valueTxt = Number.isFinite(d.value) ? d.value.toFixed(3) : "NaN";
            const unitsTxt = d.units ? ` ${d.units}` : "";
            return `${valueTxt}${unitsTxt}`;
        }
        if (sal === "sci") return v.toExponential(4);
        if (sal === "hex") return "0x" + (Math.round(v) >>> 0).toString(16).toUpperCase();
        if (sal === "bin") return "0b" + (Math.round(v) >>> 0).toString(2);
        return v.toFixed(4);
    }

    function hslToHex(h, s, l) {
        const hue = ((Number(h) % 360) + 360) % 360;
        const sat = Math.max(0, Math.min(100, Number(s))) / 100;
        const lig = Math.max(0, Math.min(100, Number(l))) / 100;
        const c = (1 - Math.abs(2 * lig - 1)) * sat;
        const hp = hue / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        let r = 0, g = 0, b = 0;
        if (hp >= 0 && hp < 1) { r = c; g = x; b = 0; }
        else if (hp < 2) { r = x; g = c; b = 0; }
        else if (hp < 3) { r = 0; g = c; b = x; }
        else if (hp < 4) { r = 0; g = x; b = c; }
        else if (hp < 5) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        const m = lig - c / 2;
        const toHex = (v) => {
            const n = Math.round((v + m) * 255);
            return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
        };
        return "#" + toHex(r) + toHex(g) + toHex(b);
    }

    function ensureSeriesColor(name, forceNew = false) {
        const key = String(name || "").trim();
        if (!key) return TRACE_COLORS[0];
        if (!forceNew && seriesColorByName[key]) return seriesColorByName[key];
        if (forceNew) {
            delete seriesColorByName[key];
            delete seriesHueByName[key];
        }
        const usedHues = Object.entries(seriesHueByName)
            .filter(([n]) => n !== key)
            .map(([, h]) => Number(h))
            .filter((h) => Number.isFinite(h));
        let pickedHue = null;
        for (let i = 0; i < 80; i++) {
            const h = Math.floor(Math.random() * 360);
            const farEnough = usedHues.every((uh) => {
                const d = Math.abs(h - uh);
                return Math.min(d, 360 - d) >= 22;
            });
            if (!farEnough) continue;
            pickedHue = h;
            break;
        }
        if (!Number.isFinite(pickedHue)) {
            pickedHue = Math.floor(Math.random() * 360);
        }
        const color = hslToHex(pickedHue, 78, 58);
        seriesColorByName[key] = color;
        seriesHueByName[key] = pickedHue;
        return color;
    }

    function getSeriesColor(name) {
        return ensureSeriesColor(name, false);
    }

    // --- History polling ---

    function isArrayElem(name) { return name.includes("[") && name.endsWith("]"); }

    function getArrayElemValue(eName) {
        const br = eName.lastIndexOf("[");
        const arrName = eName.substring(0, br);
        const idx = parseInt(eName.substring(br + 1));
        const vd = varsByName[arrName];
        if (!vd || !Array.isArray(vd.value) || idx >= vd.value.length) return undefined;
        return vd.value[idx];
    }

    // --- Column 1: Variable browser (tree view) ---

    let collapsedGroups = new Set();
    let treeInitialized = false;
    let groupVariables = false; // por defecto lista plana sin categorías

    function buildTree(names) {
        const root = { _children: new Map(), _leaves: [] };
        for (const name of names) {
            const parts = name.split(".");
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!node._children.has(parts[i])) {
                    node._children.set(parts[i], { _children: new Map(), _leaves: [] });
                }
                node = node._children.get(parts[i]);
            }
            node._leaves.push(name);
        }
        return root;
    }

    function collectLeaves(node) {
        const result = [];
        for (const name of node._leaves) result.push(name);
        for (const child of node._children.values()) {
            result.push(...collectLeaves(child));
        }
        return result;
    }

    function collectGroupPaths(node, prefix, out) {
        for (const [key, child] of node._children) {
            const fullPath = prefix ? prefix + "." + key : key;
            out.push(fullPath);
            collectGroupPaths(child, fullPath, out);
        }
    }

    function collapseAll() {
        const tree = buildTree(knownVarNames);
        const paths = [];
        collectGroupPaths(tree, "", paths);
        paths.forEach(p => collapsedGroups.add(p));
        renderBrowserList();
    }

    function expandAll() {
        collapsedGroups.clear();
        renderBrowserList();
    }

    function renderBrowserList() {
        const filterText = varFilter.value;
        const filtered = knownVarNames.filter(n => nameMatchesFilter(n, filterText));
        if (!groupVariables && filtered.length > 350) {
            renderBrowserListVirtualFlat(filtered);
            browserVirtualEnabled = true;
            return;
        }
        browserVirtualEnabled = false;
        let tree = buildTree(filtered);

        if (groupVariables) {
            if (!treeInitialized && knownVarNames.length > 0) {
                treeInitialized = true;
            }
        } else {
            // Lista plana: mismo árbol pero sin grupos, solo hojas en la raíz
            tree = { _children: new Map(), _leaves: filtered.slice().sort() };
        }

        const frag = document.createDocumentFragment();
        renderTreeNode(frag, tree, "", 0);

        varBrowserList.innerHTML = "";
        varBrowserList.appendChild(frag);
        browserListDirty = false;
    }

    function renderBrowserListVirtualFlat(filtered) {
        browserVirtualRows = filtered.slice().sort();
        const rows = browserVirtualRows;
        const rowH = browserVirtualRowPx;
        const viewH = Math.max(120, varBrowserList.clientHeight || 420);
        const scrollTop = varBrowserList.scrollTop || 0;
        const from = Math.max(0, Math.floor(scrollTop / rowH) - browserVirtualOverscan);
        const maxCount = Math.ceil(viewH / rowH) + browserVirtualOverscan * 2;
        const to = Math.min(rows.length, from + maxCount);

        const root = document.createElement("div");
        root.className = "browser-virtual-window";

        const topSpacer = document.createElement("div");
        topSpacer.className = "browser-virtual-spacer";
        topSpacer.style.height = `${from * rowH}px`;
        root.appendChild(topSpacer);

        for (let i = from; i < to; i++) {
            const name = rows[i];
            const inMonitor = monitoredNames.has(name);
            const selected = browserSelection.has(name);
            const el = document.createElement("div");
            el.className = "var-list-item" + (selected ? " selected" : "") + (inMonitor ? " in-monitor" : "");
            el.style.paddingLeft = "8px";
            el.style.height = `${rowH}px`;
            el.style.display = "flex";
            el.style.alignItems = "center";
            el.draggable = true;
            el.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/plain", name);
                e.dataTransfer.setData("application/x-var-name", name);
                e.dataTransfer.effectAllowed = "copy";
            });
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = selected;
            cb.disabled = inMonitor;
            el.appendChild(cb);
            if (isVarInTsv(name)) {
                const tsvBadge = document.createElement("span");
                tsvBadge.className = "var-tsv-badge";
                tsvBadge.textContent = "TSV";
                tsvBadge.title = "Variable en la grabación TSV cargada";
                el.appendChild(tsvBadge);
            }
            const label = document.createElement("span");
            label.className = "tree-leaf-name";
            label.textContent = name;
            label.title = name;
            el.appendChild(label);
            if (!inMonitor) {
                el.addEventListener("click", (e) => {
                    if (e.target === cb) {
                        if (cb.checked) browserSelection.add(name); else browserSelection.delete(name);
                    } else {
                        if (browserSelection.has(name)) browserSelection.delete(name); else browserSelection.add(name);
                    }
                    renderBrowserListVirtualFlat(filtered);
                });
            }
            root.appendChild(el);
        }

        const bottomSpacer = document.createElement("div");
        bottomSpacer.className = "browser-virtual-spacer";
        bottomSpacer.style.height = `${Math.max(0, (rows.length - to) * rowH)}px`;
        root.appendChild(bottomSpacer);

        varBrowserList.innerHTML = "";
        varBrowserList.appendChild(root);
        if (!varBrowserList._virtualScrollHooked) {
            varBrowserList._virtualScrollHooked = true;
            varBrowserList.addEventListener("scroll", () => {
                if (browserVirtualEnabled) renderBrowserListVirtualFlat(browserVirtualRows);
            });
        }
        browserListDirty = false;
    }

    function renderTreeNode(parent, node, prefix, depth) {
        if (!groupVariables && depth > 0) return; // en modo plano solo pintamos las hojas de la raíz
        const sortedGroups = Array.from(node._children.keys()).sort();
        for (const key of sortedGroups) {
            const child = node._children.get(key);
            const fullPath = prefix ? prefix + "." + key : key;
            const allLeaves = collectLeaves(child);
            const leafCount = allLeaves.length;
            const isCollapsed = collapsedGroups.has(fullPath);

            const allSelected = allLeaves.every(n => browserSelection.has(n) || monitoredNames.has(n));
            const someSelected = allLeaves.some(n => browserSelection.has(n));

            const groupEl = document.createElement("div");
            groupEl.className = "var-tree-group";
            groupEl.style.paddingLeft = (depth * 16 + 8) + "px";

            const arrow = document.createElement("span");
            arrow.className = "tree-arrow" + (isCollapsed ? " collapsed" : "");
            arrow.textContent = isCollapsed ? "\u25B6" : "\u25BC";
            arrow.addEventListener("click", (e) => {
                e.stopPropagation();
                if (collapsedGroups.has(fullPath)) collapsedGroups.delete(fullPath);
                else collapsedGroups.add(fullPath);
                renderBrowserList();
            });

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = allSelected;
            cb.indeterminate = !allSelected && someSelected;
            cb.addEventListener("click", (e) => {
                e.stopPropagation();
                if (cb.checked) {
                    allLeaves.forEach(n => { if (!monitoredNames.has(n)) browserSelection.add(n); });
                } else {
                    allLeaves.forEach(n => browserSelection.delete(n));
                }
                renderBrowserList();
            });

            const label = document.createElement("span");
            label.className = "tree-group-label";
            label.textContent = key;

            const count = document.createElement("span");
            count.className = "tree-group-count";
            count.textContent = leafCount;

            groupEl.appendChild(arrow);
            groupEl.appendChild(cb);
            groupEl.appendChild(label);
            groupEl.appendChild(count);

            groupEl.addEventListener("click", () => {
                if (collapsedGroups.has(fullPath)) collapsedGroups.delete(fullPath);
                else collapsedGroups.add(fullPath);
                renderBrowserList();
            });

            parent.appendChild(groupEl);

            if (!isCollapsed) {
                renderTreeNode(parent, child, fullPath, depth + 1);
            }
        }

        const sortedLeaves = node._leaves.slice().sort();
        for (const name of sortedLeaves) {
            const inMonitor = monitoredNames.has(name);
            const selected = browserSelection.has(name);
            const leafName = groupVariables ? name.split(".").pop() : name;

            const el = document.createElement("div");
            el.className = "var-list-item" +
                (selected ? " selected" : "") +
                (inMonitor ? " in-monitor" : "");
            el.style.paddingLeft = (depth * 16 + 8) + "px";

            // Drag & drop: permitir arrastrar variables desde Columna 1 a Columna 2
            el.draggable = true;
            el.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/plain", name);
                e.dataTransfer.setData("application/x-var-name", name);
                e.dataTransfer.effectAllowed = "copy";
            });

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = selected;
            cb.disabled = inMonitor;

            el.appendChild(cb);
            if (isVarInTsv(name)) {
                const tsvBadge = document.createElement("span");
                tsvBadge.className = "var-tsv-badge";
                tsvBadge.textContent = "TSV";
                tsvBadge.title = "Variable en la grabación TSV cargada";
                el.appendChild(tsvBadge);
            }
            const label = document.createElement("span");
            label.className = "tree-leaf-name";
            label.textContent = leafName;
            label.title = name;

            el.appendChild(label);

            if (varsByName[name] && varsByName[name].type === "array") {
                const arrBdg = document.createElement("span");
                arrBdg.className = "array-badge-browser";
                const vv = varsByName[name].value;
                arrBdg.textContent = Array.isArray(vv) ? "[" + vv.length + "]" : "[ ]";
                el.appendChild(arrBdg);
            } else if (isArincDerivedName(name)) {
                const arincBdg = document.createElement("span");
                arincBdg.className = "arinc-badge-browser";
                arincBdg.textContent = "ARINC";
                el.appendChild(arincBdg);
            }

            if (!inMonitor) {
                el.addEventListener("click", (e) => {
                    if (e.target === cb) {
                        if (cb.checked) browserSelection.add(name);
                        else browserSelection.delete(name);
                    } else {
                        if (browserSelection.has(name)) browserSelection.delete(name);
                        else browserSelection.add(name);
                    }
                    renderBrowserList();
                });
            }
            parent.appendChild(el);
        }
    }

    varFilter.addEventListener("input", renderBrowserList);

    const groupVarsCheckbox = document.getElementById("groupVarsCheckbox");
    const collapseAllBtn = document.getElementById("collapseAll");
    const expandAllBtn = document.getElementById("expandAll");
    groupVarsCheckbox.addEventListener("change", () => {
        groupVariables = groupVarsCheckbox.checked;
        collapseAllBtn.style.display = groupVariables ? "" : "none";
        expandAllBtn.style.display = groupVariables ? "" : "none";
        if (groupVariables) {
            collapseAll();
            return;
        }
        collapsedGroups.clear();
        renderBrowserList();
    });
    groupVarsCheckbox.checked = groupVariables;
    collapseAllBtn.style.display = groupVariables ? "" : "none";
    expandAllBtn.style.display = groupVariables ? "" : "none";

    collapseAllBtn.addEventListener("click", collapseAll);
    expandAllBtn.addEventListener("click", expandAll);

    selectAllBtn.addEventListener("click", () => {
        knownVarNames.forEach(name => {
            if (!monitoredNames.has(name) && nameMatchesFilter(name, varFilter.value))
                browserSelection.add(name);
        });
        renderBrowserList();
    });

    selectNoneBtn.addEventListener("click", () => {
        browserSelection.clear();
        renderBrowserList();
    });

    addToMonitorBtn.addEventListener("click", () => {
        browserSelection.forEach(name => {
            ensureArincBaseMonitored(name);
            ensureMonitoredName(name);
        });
        browserSelection.clear();
        sendMonitored();
        saveConfig();
        renderBrowserList();
        rebuildMonitorList();
        if (isPlaybackMode() && offlineDataset) {
            const tNow = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : offlineDataset.minTs;
            applyOfflineTime(tNow);
        }
        updateMonitorValues();
    });

    // --- Column 2: Monitored variables ---

    let editingName = null;

    function computeStats(name) {
        const hist = historyCache[name];
        if (!hist || !hist.values || hist.values.length < 2) return null;
        const vals = hist.values;
        const n = vals.length;
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < n; i++) {
            const v = vals[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return { min, max, count: n };
    }

    function nameMatchesFilter(name, filterText) {
        const t = (filterText || "").trim().toLowerCase();
        if (!t) return true;
        const parts = t.split(/\s+/).filter(Boolean);
        const requireTsv = parts.includes("tsv");
        const nameParts = parts.filter(p => p !== "tsv");
        if (requireTsv && !isVarInTsv(name)) return false;
        const nameLower = (name || "").toLowerCase();
        if (nameParts.length === 0) return true;
        return nameParts.every(p => nameLower.includes(p));
    }

    function getVisibleMonitorNames() {
        return monitoredOrder.filter(n => nameMatchesFilter(n, monitorFilterText));
    }

    function hasActiveDeltaMarkers() {
        return Number.isFinite(markerA) && Number.isFinite(markerB);
    }

    function isDeltaChangedForName(name) {
        const d = deltaByName[name];
        return Number.isFinite(d) && Math.abs(d) > 1e-9;
    }

    function getMonitorRenderOrder() {
        const order = monitoredOrder.slice();
        if (!hasActiveDeltaMarkers()) return order;
        order.sort((a, b) => {
            const aChanged = isDeltaChangedForName(a);
            const bChanged = isDeltaChangedForName(b);
            if (aChanged && !bChanged) return -1;
            if (!aChanged && bChanged) return 1;
            if (aChanged && bChanged) {
                const da = Math.abs(deltaByName[a] || 0);
                const db = Math.abs(deltaByName[b] || 0);
                if (db !== da) return db - da;
            }
            return 0;
        });
        return order;
    }

    function buildGraphSelectOptions() {
        let html = '<option value="">—</option>';
        graphList.forEach((gid, idx) => {
            html += `<option value="${gid}">G${idx + 1}</option>`;
        });
        if (graphList.length < MAX_GRAPHS) {
            html += '<option value="__new__">+ Nuevo</option>';
        }
        return html;
    }

    function syncMonitorImpositionVisual(wrap, name) {
        if (!wrap) return;
        const isImposing = isReplayMode() && isVarInTsv(name) && impositionNames.has(name);
        wrap.classList.toggle("monitor-item-imposing", isImposing);
        const rowEl = wrap.querySelector(".monitor-item");
        if (!rowEl) return;
        let badge = rowEl.querySelector(".mon-impose-badge");
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "mon-impose-badge";
            badge.textContent = "IMP";
            badge.title = "Imponiendo valor desde TSV a SHM";
            const nameNode = rowEl.querySelector(".mon-name");
            if (nameNode) rowEl.insertBefore(badge, nameNode);
            else rowEl.appendChild(badge);
        }
        badge.style.display = isImposing ? "inline-flex" : "none";
    }

    function rebuildMonitorList() {
        const existing = monitorListEl.querySelectorAll(".monitor-item-wrap");
        const existingMap = {};
        existing.forEach(el => { existingMap[el.dataset.name] = el; });

        let visibleCount = 0;
        const renderOrder = getMonitorRenderOrder();
        for (const name of renderOrder) {
            if (!nameMatchesFilter(name, monitorFilterText)) {
                if (existingMap[name]) {
                    existingMap[name].remove();
                }
                delete existingMap[name];
                continue;
            }
            visibleCount++;

            if (existingMap[name]) {
                const wrap = existingMap[name];
                wrap.classList.toggle("monitor-item-selected", monitorSelectedNames.has(name));
                const hasMarkers = hasActiveDeltaMarkers();
                const changed = hasMarkers && isDeltaChangedForName(name);
                wrap.classList.toggle("monitor-item-delta-changed", changed);
                wrap.classList.toggle("monitor-item-delta-unchanged", hasMarkers && !changed);
                if (!wrap._selectionClickAttached) {
                    wrap._selectionClickAttached = true;
                    wrap.addEventListener("click", (e) => {
                        if (e.target.closest(".btn-mon-remove") || e.target.closest(".monitor-impose-wrap")) return;
                        if (monitorSelectedNames.has(name)) monitorSelectedNames.delete(name);
                        else monitorSelectedNames.add(name);
                        rebuildMonitorList();
                    });
                }
                const nameSpan = wrap.querySelector(".mon-name");
                if (nameSpan) {
                    nameSpan.textContent = formatNameWithHiddenLevels(name, hideLevels);
                }
                syncMonitorImpositionVisual(wrap, name);
                if (isReplayMode() && !isArrayVar(name) && isVarInTsv(name)) {
                    const rowEl = wrap.querySelector(".monitor-item");
                    let imposeWrap = wrap.querySelector(".monitor-impose-wrap");
                    if (!imposeWrap && rowEl) {
                        imposeWrap = document.createElement("span");
                        imposeWrap.className = "monitor-impose-wrap";
                        const lab = document.createElement("label");
                        const cb = document.createElement("input");
                        cb.type = "checkbox";
                        cb.className = "monitor-impose-cb";
                        cb.title = "Imponer a SHM (replay)";
                        cb.addEventListener("change", (e) => {
                            e.stopPropagation();
                            const checked = cb.checked;
                            const toApply = monitorSelectedNames.size && monitorSelectedNames.has(name) ? [...monitorSelectedNames] : [name];
                            toApply.forEach(n => {
                                if (checked) impositionNames.add(n);
                                else impositionNames.delete(n);
                                syncReplayTsvHistoryForName(n);
                            });
                            saveConfig();
                            rebuildMonitorList();
                        });
                        lab.appendChild(cb);
                        imposeWrap.appendChild(lab);
                        rowEl.insertBefore(imposeWrap, rowEl.querySelector(".mon-name"));
                    }
                    const cb = imposeWrap && imposeWrap.querySelector(".monitor-impose-cb");
                    if (cb) cb.checked = impositionNames.has(name);
                } else {
                    const imposeWrap = wrap.querySelector(".monitor-impose-wrap");
                    if (imposeWrap) imposeWrap.remove();
                }
                delete existingMap[name];
                continue;
            }

            const wrap = document.createElement("div");
            wrap.className = "monitor-item-wrap";
            wrap.dataset.name = name;
            if (monitorSelectedNames.has(name)) wrap.classList.add("monitor-item-selected");
            if (hasActiveDeltaMarkers()) {
                if (isDeltaChangedForName(name)) wrap.classList.add("monitor-item-delta-changed");
                else wrap.classList.add("monitor-item-delta-unchanged");
            }
            wrap.addEventListener("click", (e) => {
                if (e.target.closest(".btn-mon-remove") || e.target.closest(".monitor-impose-wrap")) return;
                if (monitorSelectedNames.has(name)) monitorSelectedNames.delete(name);
                else monitorSelectedNames.add(name);
                rebuildMonitorList();
            });

            const el = document.createElement("div");
            el.className = "monitor-item";
            el.dataset.name = name;

            // Drag & drop: permitir arrastrar hacia graficos y reordenar dentro de la lista
            el.draggable = true;
            el.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/plain", name);
                e.dataTransfer.setData("application/x-monitor-reorder", name);
                e.dataTransfer.effectAllowed = "copyMove";
                ensureNewGraphDropTarget();
            });
            el.addEventListener("dragend", () => {
                plotArea.querySelectorAll(".plot-add-slot").forEach((slot) => {
                    slot.classList.remove("plot-add-over");
                    slot.style.display = "none";
                });
                if (graphList.length === 0 && plotEmpty) {
                    plotEmpty.classList.remove("plot-add-over");
                    if (plotEmpty.dataset.defaultText) plotEmpty.textContent = plotEmpty.dataset.defaultText;
                }
                monitorListEl.querySelectorAll(".monitor-item-wrap").forEach(w => {
                    w.classList.remove("monitor-drop-before", "monitor-drop-after");
                    delete w.dataset.dropPosition;
                });
            });

            if (isReplayMode() && !isArrayVar(name) && isVarInTsv(name)) {
                const imposeWrap = document.createElement("span");
                imposeWrap.className = "monitor-impose-wrap";
                const lab = document.createElement("label");
                const imposeCb = document.createElement("input");
                imposeCb.type = "checkbox";
                imposeCb.className = "monitor-impose-cb";
                imposeCb.title = "Imponer a SHM (replay)";
                imposeCb.checked = impositionNames.has(name);
                imposeCb.addEventListener("change", (e) => {
                    e.stopPropagation();
                    const checked = imposeCb.checked;
                    const toApply = monitorSelectedNames.size && monitorSelectedNames.has(name) ? [...monitorSelectedNames] : [name];
                    toApply.forEach(n => {
                        if (checked) impositionNames.add(n);
                        else impositionNames.delete(n);
                        syncReplayTsvHistoryForName(n);
                    });
                    saveConfig();
                    rebuildMonitorList();
                });
                lab.appendChild(imposeCb);
                imposeWrap.appendChild(lab);
                el.appendChild(imposeWrap);
            }

            const nameEl = document.createElement("span");
            nameEl.className = "mon-name";
            nameEl.textContent = formatNameWithHiddenLevels(name, hideLevels);
            nameEl.title = name;
            nameEl.addEventListener("click", () => {
                if (expandedStats.has(name)) expandedStats.delete(name);
                else expandedStats.add(name);
                updateStatsPanel(wrap, name);
            });

            let valEl = null;
            if (!isArrayVar(name)) {
                valEl = document.createElement("span");
                valEl.className = "mon-value";
                const vdInit = varsByName[name];
                if (vdInit) {
                    valEl.textContent = formatValue(vdInit.value, vdInit.type, name);
                } else if (isPlaybackMode() && offlineDataset && isVarInTsv(name)) {
                    const tNow = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : offlineDataset.minTs;
                    const vAtT = getOfflineScalarValueAtTs(name, tNow);
                    valEl.textContent = (vAtT == null) ? "--" : formatValue(vAtT, "double", name);
                } else {
                    valEl.textContent = "--";
                }
                valEl.addEventListener("dblclick", () => startInlineEdit(el, name));
            }

            if (isArrayVar(name)) {
                const badge = document.createElement("span");
                badge.className = "array-badge";
                const vd = varsByName[name];
                badge.textContent = vd && Array.isArray(vd.value) ? "[" + vd.value.length + "]" : "[ ]";
                badge.title = "Variable tipo array";
                el.appendChild(badge);
            } else if (isArincDerivedName(name)) {
                const badge = document.createElement("span");
                badge.className = "arinc-badge";
                badge.textContent = "ARINC";
                badge.title = "Subcanal ARINC derivado";
                el.appendChild(badge);
            } else if (isComputed(name)) {
                const badge = document.createElement("span");
                badge.className = "comp-badge";
                badge.textContent = "fx";
                badge.title = computedVars.find(c => c.name === name)?.expr || "";
                el.appendChild(badge);
            }
            const alarmIcon = document.createElement("span");
            alarmIcon.className = "mon-alarm-icon";
            alarmIcon.textContent = "\u26A0";
            alarmIcon.title = "Alarma configurada";
            if (!alarms[name]) alarmIcon.style.display = "none";

            const imposeBadge = document.createElement("span");
            imposeBadge.className = "mon-impose-badge";
            imposeBadge.textContent = "IMP";
            imposeBadge.title = "Imponiendo valor desde TSV a SHM";
            imposeBadge.style.display = "none";

            el.appendChild(imposeBadge);
            el.appendChild(nameEl);
            el.appendChild(alarmIcon);
            if (valEl) el.appendChild(valEl);

            const removeBtn = document.createElement("button");
            removeBtn.className = "btn-mon-remove";
            removeBtn.textContent = "\u00D7";
            removeBtn.title = "Quitar de monitorizacion";
            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const toRemove = monitorSelectedNames.has(name) ? [...monitorSelectedNames] : [name];
                for (const n of toRemove) {
                    if (isComputed(n)) removeComputedVar(n);
                    else {
                        monitoredNames.delete(n);
                        monitoredOrder = monitoredOrder.filter(o => o !== n);
                        delete varGraphAssignment[n];
                        delete historyCache[n];
                        expandedStats.delete(n);
                        monitorSelectedNames.delete(n);
                        if (!isArincDerivedName(n) && isArincEnabled(n)) {
                            removeArincDerivedForBase(n);
                        }
                        if (isArrayVar(n)) {
                            for (const key of Object.keys(arrayElemAssignment)) {
                                if (key.startsWith(n + "[")) {
                                    delete arrayElemAssignment[key];
                                    delete arrayElemHistory[key];
                                }
                            }
                        }
                    }
                }
                saveConfig();
                sendMonitored();
                pruneEmptyGraphs();
                renderBrowserList();
                rebuildMonitorList();
                renderPlots();
            });
            el.appendChild(removeBtn);
            wrap.appendChild(el);
            monitorListEl.appendChild(wrap);
            syncMonitorImpositionVisual(wrap, name);
        }

        const statusEl = document.getElementById("monitorFilterStatus");
        if (statusEl) {
            const total = monitoredOrder.length;
            if ((monitorFilterText || "").trim()) {
                statusEl.textContent = "Mostrando " + visibleCount + " de " + total;
                statusEl.style.display = "";
            } else {
                statusEl.textContent = "";
                statusEl.style.display = "none";
            }
        }

        Object.values(existingMap).forEach(el => el.remove());
        // Reordenar DOM para que coincida con monitoredOrder (p. ej. tras "Por nombre" / "Con gráfico primero")
        monitoredOrder.forEach(n => {
            const w = monitorListEl.querySelector(`.monitor-item-wrap[data-name="${CSS.escape(n)}"]`);
            if (w) monitorListEl.appendChild(w);
        });
        monitorListEl.classList.toggle("monitor-virtualized", monitoredOrder.length > 300);
        updateMonitorItemStyles();
    }

    function arrayElemName(arrName, idx) { return arrName + "[" + idx + "]"; }

    function updateArrayStatsPanel(panel, name) {
        const vd = varsByName[name];
        const arr = vd && Array.isArray(vd.value) ? vd.value : [];

        let statsRow = panel.querySelector(".stats-row");
        if (!statsRow) {
            statsRow = document.createElement("div");
            statsRow.className = "stats-row";
            panel.appendChild(statsRow);
        }

        if (arr.length === 0) {
            statsRow.innerHTML = '<span class="stats-empty">Array vacio</span>';
        } else {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < arr.length; i++) {
                if (arr[i] < min) min = arr[i];
                if (arr[i] > max) max = arr[i];
            }
            statsRow.innerHTML =
                `<span class="stat-item">Len <b>${arr.length}</b></span>` +
                `<span class="stat-item">Min <b>${min.toFixed(3)}</b></span>` +
                `<span class="stat-item">Max <b>${max.toFixed(3)}</b></span>`;
        }

        let tableWrap = panel.querySelector(".array-table-wrap");
        if (!tableWrap) {
            tableWrap = document.createElement("div");
            tableWrap.className = "array-table-wrap";
            panel.appendChild(tableWrap);
        }
        updateArrayTable(tableWrap, name, arr);
    }

    function updateArrayTable(wrap, name, arr) {
        const editing = wrap.querySelector(".arr-cell-edit");
        const editingIdx = editing ? parseInt(editing.dataset.idx) : -1;

        let table = wrap.querySelector(".array-table");
        if (!table) {
            table = document.createElement("div");
            table.className = "array-table";
            wrap.appendChild(table);
        }

        let rows = table.querySelectorAll(".arr-row");
        const needRebuild = rows.length !== arr.length;

        function attachArrayElemDrag(row, eName) {
            row.draggable = true;
            const onDragStart = (e) => {
                if (!e.dataTransfer) return;
                e.dataTransfer.setData("text/plain", eName);
                e.dataTransfer.effectAllowed = "copy";
                ensureNewGraphDropTarget();
            };
            const onDragEnd = () => {
                plotArea.querySelectorAll(".plot-add-slot").forEach((slot) => {
                    slot.classList.remove("plot-add-over");
                    slot.style.display = "none";
                });
                if (graphList.length === 0 && plotEmpty) {
                    plotEmpty.classList.remove("plot-add-over");
                    if (plotEmpty.dataset.defaultText) plotEmpty.textContent = plotEmpty.dataset.defaultText;
                }
            };
            if (row._arrDragStart) row.removeEventListener("dragstart", row._arrDragStart);
            if (row._arrDragEnd) row.removeEventListener("dragend", row._arrDragEnd);
            row._arrDragStart = onDragStart;
            row._arrDragEnd = onDragEnd;
            row.addEventListener("dragstart", onDragStart);
            row.addEventListener("dragend", onDragEnd);
        }

        if (needRebuild) {
            table.innerHTML = "";
            for (let i = 0; i < arr.length; i++) {
                const eName = arrayElemName(name, i);
                const row = document.createElement("div");
                row.className = "arr-row";
                row.dataset.idx = i;
                attachArrayElemDrag(row, eName);

                const idx = document.createElement("span");
                idx.className = "arr-idx-label";
                idx.textContent = "[" + i + "]";

                const val = document.createElement("span");
                val.className = "arr-val";
                val.textContent = arr[i].toFixed(4);
                val.title = "Doble-clic para editar";
                val.addEventListener("dblclick", (e) => {
                    e.stopPropagation();
                    startArrayCellEdit(wrap, name, i, val);
                });

                const alarmBtn = document.createElement("span");
                alarmBtn.className = "arr-alarm-btn" + (alarms[eName] ? " arr-alarm-active" : "");
                alarmBtn.textContent = "\u26A0";
                alarmBtn.title = alarms[eName]
                    ? `Alarma: Lo:${alarms[eName].lo ?? "-"} Hi:${alarms[eName].hi ?? "-"} (clic para quitar)`
                    : "Configurar alarma";
                alarmBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (alarms[eName]) {
                        delete alarms[eName];
                        delete prevAlarmState[eName];
                        alarmBtn.className = "arr-alarm-btn";
                        alarmBtn.title = "Configurar alarma";
                    } else {
                        showArrayElemAlarmForm(row, eName, alarmBtn);
                    }
                    saveConfig();
                    sendAlarmsToBackend();
                });

                const genBtn = document.createElement("span");
                genBtn.className = "arr-gen-btn" + (activeGenerators[eName] ? " arr-gen-active" : "");
                genBtn.textContent = "fx";
                genBtn.title = activeGenerators[eName] ? "Generador activo (clic para parar)" : "Generador de señal";
                genBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (activeGenerators[eName]) {
                        stopGenerator(eName);
                        genBtn.className = "arr-gen-btn";
                        genBtn.title = "Generador de señal";
                    } else {
                        showArrayElemGenForm(row, eName, genBtn);
                    }
                });

                row.appendChild(idx);
                row.appendChild(val);
                if (isLiveMode() || isPlaybackMode()) {
                    row.appendChild(alarmBtn);
                    row.appendChild(genBtn);
                }
                table.appendChild(row);
            }
        } else {
            rows.forEach(row => {
                const i = parseInt(row.dataset.idx);
                if (i === editingIdx) return;
                const eName = arrayElemName(name, i);
                attachArrayElemDrag(row, eName);
                const valEl = row.querySelector(".arr-val");
                if (valEl && i < arr.length) valEl.textContent = arr[i].toFixed(4);
                const ab = row.querySelector(".arr-alarm-btn");
                if (ab) {
                    const hasAlarm = !!alarms[eName];
                    ab.className = "arr-alarm-btn" + (hasAlarm ? " arr-alarm-active" : "");
                    if (activeAlarms.has(eName)) ab.classList.add("arr-alarm-firing");
                }
                const gb = row.querySelector(".arr-gen-btn");
                if (gb) {
                    gb.className = "arr-gen-btn" + (activeGenerators[eName] ? " arr-gen-active" : "");
                }
            });
        }
    }

    function startArrayCellEdit(wrap, name, index, cell) {
        if (!isLiveMode()) return;
        if (cell.querySelector(".arr-cell-edit")) return;
        const oldText = cell.textContent;
        cell.textContent = "";

        const input = document.createElement("input");
        input.className = "arr-cell-edit";
        input.type = "text";
        input.value = oldText;
        input.dataset.idx = index;

        function commit() {
            const val = parseFloat(input.value);
            if (!isNaN(val)) {
                sendWsAction({
                    action: "set_array_element",
                    name: name,
                    index: index,
                    value: val,
                });
            }
            cell.textContent = isNaN(val) ? oldText : val.toFixed(3);
        }

        function cancel() {
            cell.textContent = oldText;
        }

        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
        });
        input.addEventListener("blur", commit);
        input.addEventListener("click", (e) => e.stopPropagation());

        cell.appendChild(input);
        input.focus();
        input.select();
    }

    function showArrayElemAlarmForm(row, eName, alarmBtn) {
        if (row.querySelector(".arr-alarm-form")) return;
        const form = document.createElement("span");
        form.className = "arr-alarm-form";

        const loIn = document.createElement("input");
        loIn.type = "text";
        loIn.placeholder = "Lo";
        loIn.className = "arr-alarm-input";
        const hiIn = document.createElement("input");
        hiIn.type = "text";
        hiIn.placeholder = "Hi";
        hiIn.className = "arr-alarm-input";

        const ok = document.createElement("button");
        ok.className = "arr-alarm-ok";
        ok.textContent = "\u2713";
        ok.addEventListener("click", (e) => {
            e.stopPropagation();
            const lo = loIn.value.trim() ? parseFloat(loIn.value) : null;
            const hi = hiIn.value.trim() ? parseFloat(hiIn.value) : null;
            if (lo === null && hi === null) {
                delete alarms[eName];
            } else {
                alarms[eName] = { lo, hi };
            }
            form.remove();
            alarmBtn.className = "arr-alarm-btn" + (alarms[eName] ? " arr-alarm-active" : "");
            alarmBtn.title = alarms[eName]
                ? `Alarma: Lo:${alarms[eName].lo ?? "-"} Hi:${alarms[eName].hi ?? "-"} (clic para quitar)`
                : "Configurar alarma";
            saveConfig();
            sendAlarmsToBackend();
        });

        const cancel = document.createElement("button");
        cancel.className = "arr-alarm-cancel";
        cancel.textContent = "\u00D7";
        cancel.addEventListener("click", (e) => { e.stopPropagation(); form.remove(); });

        [loIn, hiIn, ok, cancel].forEach(el => el.addEventListener("click", (e) => e.stopPropagation()));
        loIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ok.click(); if (e.key === "Escape") cancel.click(); });
        hiIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ok.click(); if (e.key === "Escape") cancel.click(); });

        form.appendChild(loIn);
        form.appendChild(hiIn);
        form.appendChild(ok);
        form.appendChild(cancel);
        row.appendChild(form);
        loIn.focus();
    }

    function showArrayElemGenForm(row, eName, genBtn) {
        const next = row.nextSibling;
        if (next && next.classList && next.classList.contains("arr-gen-form")) return;
        const form = document.createElement("div");
        form.className = "arr-gen-form";

        const sel = document.createElement("select");
        sel.className = "arr-gen-type-select";
        const optNone = document.createElement("option");
        optNone.value = "";
        optNone.textContent = "Tipo...";
        sel.appendChild(optNone);
        for (const [key, def] of Object.entries(GEN_TYPES)) {
            const o = document.createElement("option");
            o.value = key;
            o.textContent = def.label;
            sel.appendChild(o);
        }

        const paramsDiv = document.createElement("div");
        paramsDiv.className = "arr-gen-params";

        sel.addEventListener("change", () => {
            paramsDiv.innerHTML = "";
            const def = GEN_TYPES[sel.value];
            if (!def) return;
            for (const f of def.fields) {
                const wrap = document.createElement("span");
                wrap.className = "arr-gen-field";
                const lbl = document.createElement("span");
                lbl.className = "arr-gen-field-label";
                lbl.textContent = f.l;
                const inp = document.createElement("input");
                inp.type = "text";
                inp.className = "arr-gen-input";
                inp.value = f.d;
                inp.dataset.key = f.k;
                inp.addEventListener("click", (e) => e.stopPropagation());
                inp.addEventListener("keydown", (e) => e.stopPropagation());
                wrap.appendChild(lbl);
                wrap.appendChild(inp);
                paramsDiv.appendChild(wrap);
            }
        });
        sel.addEventListener("click", (e) => e.stopPropagation());

        const okBtn = document.createElement("button");
        okBtn.className = "arr-alarm-ok";
        okBtn.textContent = "\u25B6";
        okBtn.title = "Iniciar generador";
        okBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const type = sel.value;
            if (!type) return;
            const params = {};
            paramsDiv.querySelectorAll(".arr-gen-input").forEach(inp => {
                params[inp.dataset.key] = parseFloat(inp.value) || 0;
            });
            startGenerator(eName, type, params);
            genBtn.className = "arr-gen-btn arr-gen-active";
            genBtn.title = "Generador activo (clic para parar)";
            form.remove();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "arr-alarm-cancel";
        cancelBtn.textContent = "\u00D7";
        cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); form.remove(); });

        form.addEventListener("click", (e) => e.stopPropagation());

        const topRow = document.createElement("div");
        topRow.className = "arr-gen-top";
        topRow.appendChild(sel);
        topRow.appendChild(okBtn);
        topRow.appendChild(cancelBtn);
        form.appendChild(topRow);
        form.appendChild(paramsDiv);
        row.parentNode.insertBefore(form, row.nextSibling);
    }

    function trackArrayElementHistories(appendHistory = true) {
        if (!appendHistory) return false;
        let tracked = false;
        for (const name of monitoredNames) {
            if (!isArrayVar(name)) continue;
            const vd = varsByName[name];
            if (!vd || !Array.isArray(vd.value)) continue;
            const arr = vd.value;
            const now = isReplayMode()
                ? getReplayCurrentTs()
                : (vd.timestamp || (Date.now() / 1000));
            for (let i = 0; i < arr.length; i++) {
                const eName = arrayElemName(name, i);
                if (!arrayElemAssignment[eName]) continue;
                tracked = true;
                if (!arrayElemHistory[eName]) arrayElemHistory[eName] = { timestamps: [], values: [] };
                const h = arrayElemHistory[eName];
                h.timestamps.push(now);
                h.values.push(arr[i]);
                if (h.timestamps.length > ARRAY_HIST_MAX) {
                    const trim = Math.floor(ARRAY_HIST_MAX * 0.75);
                    h.timestamps = h.timestamps.slice(-trim);
                    h.values = h.values.slice(-trim);
                }
            }
        }
        return tracked;
    }

    function updateStatsPanel(wrap, name) {
        let panel = wrap.querySelector(".stats-panel");
        if (!expandedStats.has(name)) {
            if (panel) panel.remove();
            return;
        }
        if (!panel) {
            panel = document.createElement("div");
            panel.className = "stats-panel";
            wrap.appendChild(panel);
        }

        if (isArrayVar(name)) {
            updateArrayStatsPanel(panel, name);
            return;
        }

        let exprRow = panel.querySelector(".expr-row");
        const cv = computedVars.find(c => c.name === name);
        if (cv && !exprRow) {
            exprRow = document.createElement("div");
            exprRow.className = "expr-row";

            const eqSign = document.createElement("span");
            eqSign.className = "expr-eq";
            eqSign.textContent = "= ";

            const exprInput = document.createElement("input");
            exprInput.className = "expr-input";
            exprInput.type = "text";
            exprInput.value = cv.expr;
            exprInput.title = "Editar expresion (Enter para confirmar)";

            const exprOk = document.createElement("button");
            exprOk.className = "btn-expr-ok";
            exprOk.textContent = "\u2713";
            exprOk.title = "Aplicar cambio";

            const exprErr = document.createElement("span");
            exprErr.className = "expr-err";

            function applyExpr() {
                const newExpr = exprInput.value.trim();
                if (!newExpr) return;
                let fn;
                try {
                    fn = new Function("$", `with($){return (${newExpr});}`);
                } catch (e) {
                    exprErr.textContent = e.message;
                    exprErr.style.display = "inline";
                    setTimeout(() => { exprErr.style.display = "none"; }, 3000);
                    return;
                }
                cv.expr = newExpr;
                cv.fn = fn;
                computedHistories[name] = { timestamps: [], values: [] };
                historyCache[name] = computedHistories[name];
                exprErr.style.display = "none";
                saveConfig();
            }

            exprOk.addEventListener("click", (e) => { e.stopPropagation(); applyExpr(); });
            exprInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.stopPropagation(); applyExpr(); }
            });
            exprInput.addEventListener("click", (e) => e.stopPropagation());

            exprRow.appendChild(eqSign);
            exprRow.appendChild(exprInput);
            exprRow.appendChild(exprOk);
            exprRow.appendChild(exprErr);
            panel.appendChild(exprRow);
        } else if (!cv && exprRow) {
            exprRow.remove();
        }

        const statsRow = panel.querySelector(".stats-row") || document.createElement("div");
        statsRow.className = "stats-row";
        const s = computeStats(name);
        if (!s) {
            statsRow.innerHTML = '<span class="stats-empty">Sin datos suficientes</span>';
        } else {
            statsRow.innerHTML =
                `<span class="stat-item">Min <b>${s.min.toFixed(3)}</b></span>` +
                `<span class="stat-item">Max <b>${s.max.toFixed(3)}</b></span>`;
        }
        if (!statsRow.parentNode) panel.appendChild(statsRow);

        const deltaRow = panel.querySelector(".delta-row") || document.createElement("div");
        deltaRow.className = "delta-row";
        const dVal = deltaByName[name];
        const hasMarkers = Number.isFinite(markerA) && Number.isFinite(markerB);
        if (Number.isFinite(dVal) || hasMarkers) {
            deltaRow.innerHTML = "";
            if (Number.isFinite(dVal)) {
                const span = document.createElement("span");
                span.className = "stat-item";
                span.innerHTML = `Δ valor <b>${dVal >= 0 ? "+" : ""}${dVal.toFixed(4)}</b>`;
                deltaRow.appendChild(span);
            }
            if (hasMarkers) {
                const dt = markerB - markerA;
                const tSpan = document.createElement("span");
                tSpan.className = "stat-item";
                tSpan.innerHTML = `Δt <b>${dt.toFixed(3)}</b> s`;
                deltaRow.appendChild(tSpan);
            }
            if (!deltaRow.parentNode) panel.appendChild(deltaRow);
        } else {
            if (deltaRow.parentNode) deltaRow.remove();
        }

        if (isArincDerivedName(name)) {
            let hint = panel.querySelector(".arinc-derived-hint");
            if (!hint) {
                hint = document.createElement("div");
                hint.className = "arinc-derived-hint";
                panel.appendChild(hint);
            }
            hint.textContent = "Subcanal ARINC derivado: no requiere reinterpretación ARINC.";
            const fmtOld = panel.querySelector(".fmt-row");
            if (fmtOld) fmtOld.remove();
            const alarmOld = panel.querySelector(".alarm-row");
            if (alarmOld) alarmOld.remove();
            const genOld = panel.querySelector(".gen-row");
            if (genOld) genOld.remove();
            const arincOld = panel.querySelector(".arinc-row");
            if (arincOld) arincOld.remove();
            const arincSubs = panel.querySelector(".arinc-subvars");
            if (arincSubs) arincSubs.remove();
            return;
        }

        const replayImposed = isReplayMode() && impositionNames.has(name) && isVarInTsv(name);
        if (replayImposed) {
            const fmtOld = panel.querySelector(".fmt-row");
            if (fmtOld) fmtOld.remove();
            const genOld = panel.querySelector(".gen-row");
            if (genOld) genOld.remove();
        }

        const vf = ensureVarFormatEntry(name);
        const canUseArincMode = !isArincDerivedName(name) && !isComputed(name);
        if (!canUseArincMode && vf.sal === "arinc429") vf.sal = "dec";
        let fmtRow = panel.querySelector(".fmt-row");
        if (!replayImposed && !fmtRow) {
            fmtRow = document.createElement("div");
            fmtRow.className = "fmt-row";
            const fmtOpts = canUseArincMode
                ? '<option value="dec">Dec</option><option value="sci">Sci</option><option value="hex">Hex</option><option value="bin">Bin</option><option value="arinc429">ARINC 429</option>'
                : '<option value="dec">Dec</option><option value="sci">Sci</option><option value="hex">Hex</option><option value="bin">Bin</option>';

            const oriLbl = document.createElement("span");
            oriLbl.className = "fmt-label";
            oriLbl.textContent = "Ori:";
            const oriSel = document.createElement("select");
            oriSel.className = "fmt-select";
            oriSel.innerHTML = fmtOpts;
            oriSel.value = vf.ori || "dec";
            oriSel.addEventListener("change", (e) => {
                e.stopPropagation();
                ensureVarFormatEntry(name).ori = oriSel.value;
                saveConfig();
            });

            const salLbl = document.createElement("span");
            salLbl.className = "fmt-label";
            salLbl.textContent = "Sal:";
            const salSel = document.createElement("select");
            salSel.className = "fmt-select";
            salSel.innerHTML = fmtOpts;
            salSel.value = vf.sal || "dec";
            salSel.addEventListener("change", (e) => {
                e.stopPropagation();
                const prevSal = ensureVarFormatEntry(name).sal || "dec";
                ensureVarFormatEntry(name).sal = salSel.value;
                if (!canUseArincMode && salSel.value === "arinc429") {
                    ensureVarFormatEntry(name).sal = "dec";
                    salSel.value = "dec";
                }
                if (prevSal === "arinc429" && salSel.value !== "arinc429") {
                    removeArincDerivedForBase(name);
                }
                if (salSel.value === "arinc429") {
                    rebuildArincDerivedHistoryForBase(name);
                    const cur = varsByName[name];
                    const num = cur && typeof cur.value === "number" ? cur.value : Number(cur?.value);
                    if (cur && Number.isFinite(num)) {
                        const ts = cur.timestamp || (Date.now() / 1000);
                        pushArincDerivedSample(name, ts, num, false);
                    }
                }
                rebuildKnownVarNamesWithDerived();
                saveConfig();
                rebuildMonitorList();
                renderBrowserList();
                schedulePlotRender();
                updateStatsPanel(wrap, name);
            });

            fmtRow.appendChild(oriLbl);
            fmtRow.appendChild(oriSel);
            fmtRow.appendChild(salLbl);
            fmtRow.appendChild(salSel);
            panel.appendChild(fmtRow);
        } else if (fmtRow && !replayImposed) {
            const sels = fmtRow.querySelectorAll(".fmt-select");
            if (sels[0]) sels[0].value = vf.ori || "dec";
            if (sels[1]) sels[1].value = vf.sal || "dec";
        }
        let imposeOffsetsRow = panel.querySelector(".impose-offsets-row");
        if (isReplayMode() && !isArrayVar(name) && isVarInTsv(name)) {
            if (!imposeOffsetsRow) {
                imposeOffsetsRow = document.createElement("div");
                imposeOffsetsRow.className = "impose-offsets-row";
                panel.appendChild(imposeOffsetsRow);
            }
            imposeOffsetsRow.innerHTML = "";
            const dtLabel = document.createElement("label");
            dtLabel.className = "monitor-offset-label";
            dtLabel.textContent = "Δt:";
            const dtInput = document.createElement("input");
            dtInput.type = "number";
            dtInput.className = "monitor-offset-input";
            dtInput.step = "any";
            dtInput.placeholder = "0";
            dtInput.title = "Offset temporal (s)";
            dtInput.value = impositionTimeOffset[name] != null ? String(impositionTimeOffset[name]) : "";
            dtInput.addEventListener("click", (e) => e.stopPropagation());
            dtInput.addEventListener("change", (e) => {
                e.stopPropagation();
                const v = parseFloat(dtInput.value);
                impositionTimeOffset[name] = Number.isFinite(v) ? v : 0;
                saveConfig();
            });
            dtLabel.appendChild(dtInput);
            const dvLabel = document.createElement("label");
            dvLabel.className = "monitor-offset-label";
            dvLabel.textContent = "Δv:";
            const dvInput = document.createElement("input");
            dvInput.type = "number";
            dvInput.className = "monitor-offset-input";
            dvInput.step = "any";
            dvInput.placeholder = "0";
            dvInput.title = "Offset numérico";
            dvInput.value = impositionValueOffset[name] != null ? String(impositionValueOffset[name]) : "";
            dvInput.addEventListener("click", (e) => e.stopPropagation());
            dvInput.addEventListener("change", (e) => {
                e.stopPropagation();
                const v = parseFloat(dvInput.value);
                impositionValueOffset[name] = Number.isFinite(v) ? v : 0;
                saveConfig();
            });
            dvLabel.appendChild(dvInput);
            imposeOffsetsRow.appendChild(dtLabel);
            imposeOffsetsRow.appendChild(dvLabel);
        } else if (imposeOffsetsRow) {
            imposeOffsetsRow.remove();
        }

        let arincRow = panel.querySelector(".arinc-row");
        if (canUseArincMode && vf.sal === "arinc429") {
            if (!arincRow) {
                arincRow = document.createElement("div");
                arincRow.className = "arinc-row";
                panel.appendChild(arincRow);
            }
            const cfg = getArincConfig(name);
            const vd = varsByName[name];
            const num = vd && typeof vd.value === "number" ? vd.value : Number(vd?.value);
            const d = Number.isFinite(num) ? decodeArinc429(num, cfg) : null;
            arincRow.innerHTML = "";
            const lsbLbl = document.createElement("span");
            lsbLbl.className = "fmt-label";
            lsbLbl.textContent = "LSB:";
            const lsbIn = document.createElement("input");
            lsbIn.className = "arinc-lsb-input";
            lsbIn.type = "number";
            lsbIn.step = "any";
            lsbIn.value = String(cfg.lsb ?? 1);
            lsbIn.addEventListener("click", (e) => e.stopPropagation());
            lsbIn.addEventListener("change", (e) => {
                e.stopPropagation();
                const nv = Number(lsbIn.value);
                getArincConfig(name).lsb = Number.isFinite(nv) && nv !== 0 ? nv : 1;
                rebuildArincDerivedHistoryForBase(name);
                if (varsByName[name] && Number.isFinite(Number(varsByName[name].value))) {
                    const ts = varsByName[name].timestamp || (Date.now() / 1000);
                    pushArincDerivedSample(name, ts, Number(varsByName[name].value), false);
                }
                saveConfig();
                updateMonitorValues();
                schedulePlotRender();
                updateStatsPanel(wrap, name);
            });
            const encLbl = document.createElement("span");
            encLbl.className = "fmt-label";
            encLbl.textContent = "Enc:";
            const encSel = document.createElement("select");
            encSel.className = "fmt-select";
            encSel.innerHTML = '<option value="">auto</option><option value="bnr">BNR</option><option value="bcd">BCD</option><option value="discrete">DIS</option>';
            encSel.value = cfg.encodingOverride || "";
            encSel.addEventListener("click", (e) => e.stopPropagation());
            encSel.addEventListener("change", (e) => {
                e.stopPropagation();
                getArincConfig(name).encodingOverride = encSel.value || "";
                rebuildArincDerivedHistoryForBase(name);
                if (varsByName[name] && Number.isFinite(Number(varsByName[name].value))) {
                    const ts = varsByName[name].timestamp || (Date.now() / 1000);
                    pushArincDerivedSample(name, ts, Number(varsByName[name].value), false);
                }
                saveConfig();
                updateMonitorValues();
                schedulePlotRender();
                updateStatsPanel(wrap, name);
            });
            const info = document.createElement("span");
            info.className = "arinc-info";
            info.textContent = d
                ? `Label ${d.labelOct} (${d.labelName}) | PAR:${d.parityOk ? "OK" : "ERR"} SSM:${d.ssmOk ? "OK" : "WARN"} RNG:${d.rangeOk ? "OK" : "WARN"}`
                : "ARINC: sin dato numérico";
            arincRow.appendChild(info);
            arincRow.appendChild(lsbLbl);
            arincRow.appendChild(lsbIn);
            arincRow.appendChild(encLbl);
            arincRow.appendChild(encSel);

            let arincSubvars = panel.querySelector(".arinc-subvars");
            if (!arincSubvars) {
                arincSubvars = document.createElement("div");
                arincSubvars.className = "arinc-subvars";
                panel.appendChild(arincSubvars);
            }
            arincSubvars.innerHTML = "";
            const subTitle = document.createElement("div");
            subTitle.className = "arinc-subvars-title";
            subTitle.textContent = "Subcanales ploteables ARINC";
            arincSubvars.appendChild(subTitle);
            const subSpecs = [
                { suffix: "label", label: "Label", value: d ? d.label : null },
                { suffix: "sdi", label: "SDI", value: d ? d.sdi : null },
                { suffix: "data", label: "Data", value: d ? d.data : null },
                { suffix: "ssm", label: "SSM", value: d ? d.ssm : null },
                { suffix: "parity", label: "Parity", value: d ? d.parity : null },
                { suffix: "value", label: "Value", value: d ? d.value : null },
            ];
            const optionsHtml = buildGraphSelectOptions();
            for (let i = 0; i < subSpecs.length; i++) {
                const spec = subSpecs[i];
                const dName = `${name}.arinc.${spec.suffix}`;

                const row = document.createElement("div");
                row.className = "arinc-subvar-row";
                row.draggable = true;
                row.addEventListener("dragstart", (e) => {
                    e.dataTransfer.setData("text/plain", dName);
                    e.dataTransfer.effectAllowed = "copy";
                    ensureNewGraphDropTarget();
                });
                row.addEventListener("dragend", () => {
                    plotArea.querySelectorAll(".plot-add-slot").forEach((slot) => {
                        slot.classList.remove("plot-add-over");
                        slot.style.display = "none";
                    });
                    if (graphList.length === 0 && plotEmpty) {
                        plotEmpty.classList.remove("plot-add-over");
                        if (plotEmpty.dataset.defaultText) plotEmpty.textContent = plotEmpty.dataset.defaultText;
                    }
                });

                const lbl = document.createElement("span");
                lbl.className = "arinc-subvar-name";
                lbl.textContent = spec.label;
                lbl.title = dName;

                const val = document.createElement("span");
                val.className = "arinc-subvar-value";
                val.textContent = Number.isFinite(spec.value)
                    ? (spec.suffix === "value" ? spec.value.toFixed(4) : String(spec.value))
                    : "--";

                const sel = document.createElement("select");
                sel.className = "arinc-subvar-select";
                sel.innerHTML = optionsHtml;
                const assigned = varGraphAssignment[dName] || "";
                if (assigned && graphList.includes(assigned)) {
                    sel.value = assigned;
                } else {
                    sel.value = "";
                    varGraphAssignment[dName] = "";
                }
                updateSelectStyle(sel);
                sel.addEventListener("change", (e) => {
                    e.stopPropagation();
                    if (sel.value === "__new__") {
                        addGraph();
                        const newGid = graphList[graphList.length - 1];
                        varGraphAssignment[dName] = newGid;
                        ensureSeriesColor(dName, true);
                    } else {
                        varGraphAssignment[dName] = sel.value || "";
                        if (sel.value) ensureSeriesColor(dName, true);
                        pruneEmptyGraphs();
                    }
                    if (isPlaybackMode() && sel.value && sel.value !== "__new__") {
                        fetchFullHistoryIfNeeded(dName);
                    }
                    updateSelectStyle(sel);
                    saveConfig();
                    schedulePlotRender();
                });
                sel.addEventListener("click", (e) => e.stopPropagation());
                let alarmBtn = null;
                if (isLiveMode()) {
                    alarmBtn = document.createElement("span");
                    alarmBtn.className = "arr-alarm-btn" + (alarms[dName] ? " arr-alarm-active" : "");
                    if (activeAlarms.has(dName)) alarmBtn.classList.add("alarm-firing");
                    alarmBtn.textContent = "⚠";
                    alarmBtn.dataset.elemName = dName;
                    alarmBtn.title = alarms[dName]
                        ? `Alarma: Lo:${alarms[dName].lo ?? "-"} Hi:${alarms[dName].hi ?? "-"} (clic para quitar)`
                        : "Configurar alarma";
                    alarmBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        if (alarms[dName]) {
                            delete alarms[dName];
                            delete prevAlarmState[dName];
                            alarmBtn.className = "arr-alarm-btn";
                            alarmBtn.textContent = "⚠";
                            alarmBtn.title = "Configurar alarma";
                            saveConfig();
                            sendAlarmsToBackend();
                            updateMonitorItemStyles();
                            refreshAllStats();
                        } else {
                            showArrayElemAlarmForm(row, dName, alarmBtn);
                        }
                    });
                }

                row.appendChild(lbl);
                row.appendChild(val);
                row.appendChild(sel);
                if (alarmBtn) row.appendChild(alarmBtn);
                arincSubvars.appendChild(row);
            }
        } else if (arincRow) {
            arincRow.remove();
            const arincSubvars = panel.querySelector(".arinc-subvars");
            if (arincSubvars) arincSubvars.remove();
        }

        // En modo no-live ocultamos alarmas (solo tienen sentido en vivo). Generadores sí en replay/offline.
        if (!isLiveMode()) {
            const alarmRowOffline = panel.querySelector(".alarm-row");
            if (alarmRowOffline) alarmRowOffline.remove();
            if (!isPlaybackMode()) {
                const genRowOffline = panel.querySelector(".gen-row");
                if (genRowOffline) genRowOffline.remove();
                return;
            }
        }

        let alarmRow = panel.querySelector(".alarm-row");
        const a = alarms[name];

        if (a) {
            if (!alarmRow) {
                alarmRow = document.createElement("div");
                alarmRow.className = "alarm-row alarm-row-active";
                panel.appendChild(alarmRow);
            }
            alarmRow.innerHTML = "";
            alarmRow.className = "alarm-row alarm-row-active";

            const label = document.createElement("span");
            label.className = "alarm-label-active";
            let txt = "\u26A0 ";
            if (a.lo !== null) txt += "Lo:" + a.lo + " ";
            if (a.hi !== null) txt += "Hi:" + a.hi;
            if (a.hys) txt += " Hys:" + a.hys;
            if (a.delayMs) txt += " Dly:" + a.delayMs + "ms";
            label.textContent = txt;

            const removeBtn = document.createElement("button");
            removeBtn.className = "btn-alarm-remove";
            removeBtn.textContent = "\u00D7";
            removeBtn.title = "Eliminar alarma";
            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                delete alarms[name];
                delete prevAlarmState[name];
                saveConfig();
                sendAlarmsToBackend();
                updateMonitorItemStyles();
                updateStatsPanel(wrap, name);
            });

            alarmRow.appendChild(label);
            alarmRow.appendChild(removeBtn);
        } else {
            if (!alarmRow) {
                alarmRow = document.createElement("div");
                alarmRow.className = "alarm-row";
                panel.appendChild(alarmRow);
            }

            if (!alarmRow.querySelector(".alarm-form")) {
                alarmRow.innerHTML = "";
                alarmRow.className = "alarm-row";

                const addBtn = document.createElement("button");
                addBtn.className = "btn-alarm-add";
                addBtn.textContent = "+ Alarma";
                addBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    showAlarmForm(alarmRow, name, wrap);
                });
                alarmRow.appendChild(addBtn);
            }
        }

        if (!replayImposed) {
            let genRow = panel.querySelector(".gen-row");
            const gen = activeGenerators[name];

            if (gen) {
                if (!genRow) {
                    genRow = document.createElement("div");
                    genRow.className = "gen-row gen-row-active";
                    panel.appendChild(genRow);
                }
                if (!genRow.classList.contains("gen-row-active") || !genRow.querySelector(".btn-gen-stop")) {
                    genRow.innerHTML = "";
                    genRow.className = "gen-row gen-row-active";

                    const label = document.createElement("span");
                    label.className = "gen-label-active";
                    label.textContent = "\u25B6 " + (GEN_TYPES[gen.type] ? GEN_TYPES[gen.type].label : gen.type);
                    genRow.appendChild(label);

                    const stopBtn = document.createElement("button");
                    stopBtn.className = "btn-gen-stop";
                    stopBtn.textContent = "\u25A0 Stop";
                    stopBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        stopGenerator(name);
                        updateStatsPanel(wrap, name);
                    });
                    genRow.appendChild(stopBtn);
                }
            } else {
                if (!genRow) {
                    genRow = document.createElement("div");
                    genRow.className = "gen-row";
                    panel.appendChild(genRow);
                }

                if (!genRow.querySelector(".gen-form") && !genRow.querySelector(".gen-select")) {
                    genRow.innerHTML = "";
                    genRow.className = "gen-row";
                    buildGenSelector(genRow, name, wrap);
                }
            }
        } else {
            const genRow = panel.querySelector(".gen-row");
            if (genRow) genRow.remove();
        }
    }

    function buildGenSelector(genRow, name, wrap) {
        const sel = document.createElement("select");
        sel.className = "gen-select";
        const optNone = document.createElement("option");
        optNone.value = "";
        optNone.textContent = "Generador...";
        sel.appendChild(optNone);

        for (const [key, def] of Object.entries(GEN_TYPES)) {
            const o = document.createElement("option");
            o.value = key;
            o.textContent = def.label;
            sel.appendChild(o);
        }

        sel.addEventListener("change", (e) => {
            e.stopPropagation();
            const type = sel.value;
            const formArea = genRow.querySelector(".gen-form");
            if (formArea) formArea.remove();
            if (type) showGenForm(genRow, name, wrap, type);
        });

        genRow.appendChild(sel);
    }

    function showGenForm(genRow, name, wrap, type) {
        const def = GEN_TYPES[type];
        if (!def) return;
        const form = document.createElement("div");
        form.className = "gen-form";

        const inputs = {};
        for (const f of def.fields) {
            const group = document.createElement("div");
            group.className = "gen-field";
            const lbl = document.createElement("span");
            lbl.className = "gen-field-label";
            lbl.textContent = f.l;
            const inp = document.createElement("input");
            inp.type = "number";
            inp.step = "any";
            inp.className = "gen-input";
            inp.value = f.d;
            inputs[f.k] = inp;
            group.appendChild(lbl);
            group.appendChild(inp);
            form.appendChild(group);
        }

        const playBtn = document.createElement("button");
        playBtn.className = "btn-gen-play";
        playBtn.textContent = "\u25B6";
        playBtn.title = "Iniciar generador";
        playBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const params = {};
            for (const f of def.fields) {
                params[f.k] = parseFloat(inputs[f.k].value) || f.d;
            }
            startGenerator(name, type, params);
            updateStatsPanel(wrap, name);
        });
        form.appendChild(playBtn);

        genRow.appendChild(form);
    }

    function showAlarmForm(alarmRow, name, wrap) {
        alarmRow.innerHTML = "";
        const form = document.createElement("div");
        form.className = "alarm-form";

        const loInput = document.createElement("input");
        loInput.type = "number";
        loInput.step = "any";
        loInput.placeholder = "Lo";
        loInput.className = "alarm-input";
        loInput.title = "Umbral bajo";

        const hiInput = document.createElement("input");
        hiInput.type = "number";
        hiInput.step = "any";
        hiInput.placeholder = "Hi";
        hiInput.className = "alarm-input";
        hiInput.title = "Umbral alto";

        const hysInput = document.createElement("input");
        hysInput.type = "number";
        hysInput.step = "any";
        hysInput.placeholder = "Hys";
        hysInput.className = "alarm-input";
        hysInput.title = "Histéresis";

        const delayInput = document.createElement("input");
        delayInput.type = "number";
        delayInput.step = "1";
        delayInput.placeholder = "Delay ms";
        delayInput.className = "alarm-input";
        delayInput.title = "Retardo de disparo (ms)";

        const okBtn = document.createElement("button");
        okBtn.className = "btn-alarm-ok";
        okBtn.textContent = "\u2713";
        okBtn.title = "Confirmar alarma";
        okBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const lo = loInput.value.trim() !== "" ? parseFloat(loInput.value) : null;
            const hi = hiInput.value.trim() !== "" ? parseFloat(hiInput.value) : null;
            const hys = hysInput.value.trim() !== "" ? Math.max(0, parseFloat(hysInput.value)) : 0;
            const delayMs = delayInput.value.trim() !== "" ? Math.max(0, parseInt(delayInput.value, 10) || 0) : 0;
            if (lo === null && hi === null) {
                delete alarms[name];
            } else {
                alarms[name] = { lo, hi, hys, delayMs };
            }
            saveConfig();
            sendAlarmsToBackend();
            updateMonitorItemStyles();
            updateStatsPanel(wrap, name);
            refreshAlarmListPanel();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn-alarm-cancel";
        cancelBtn.textContent = "\u00D7";
        cancelBtn.title = "Cancelar";
        cancelBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            updateStatsPanel(wrap, name);
        });

        form.appendChild(loInput);
        form.appendChild(hiInput);
        form.appendChild(hysInput);
        form.appendChild(delayInput);
        form.appendChild(okBtn);
        form.appendChild(cancelBtn);
        alarmRow.appendChild(form);

        loInput.focus();
    }

    function refreshAllStats() {
        const active = document.activeElement;
        for (const name of expandedStats) {
            const wrap = monitorListEl.querySelector(`.monitor-item-wrap[data-name="${CSS.escape(name)}"]`);
            if (!wrap) continue;
            // Evita reconstruir el panel mientras se interactua con sus controles
            // (selects/inputs ARINC, alarmas, etc.) para que no se cierre el desplegable activo.
            if (active && wrap.contains(active)) continue;
            updateStatsPanel(wrap, name);
        }
    }

    function checkAlarmEntry(name, value, newActive, triggered) {
        const a = alarms[name];
        if (!a || typeof value !== "number") return;
        const hys = Number.isFinite(Number(a.hys)) ? Math.max(0, Number(a.hys)) : 0;
        const delayMs = Number.isFinite(Number(a.delayMs)) ? Math.max(0, Number(a.delayMs)) : 0;
        const prev = !!prevAlarmState[name];
        let overHi = (a.hi !== null && value > a.hi);
        let underLo = (a.lo !== null && value < a.lo);
        if (prev) {
            const clearHi = (a.hi === null) || value <= ((a.hi ?? value) - hys);
            const clearLo = (a.lo === null) || value >= ((a.lo ?? value) + hys);
            if (clearHi && clearLo) {
                delete alarmPendingSince[name];
                return;
            }
            overHi = a.hi !== null && value > (a.hi - hys);
            underLo = a.lo !== null && value < (a.lo + hys);
        }
        const alarming = overHi || underLo;
        if (!alarming) {
            delete alarmPendingSince[name];
            return;
        }
        const nowMs = Date.now();
        if (!alarmPendingSince[name]) alarmPendingSince[name] = nowMs;
        const elapsed = nowMs - alarmPendingSince[name];
        if (elapsed < delayMs) return;
        let reason = "";
        if (overHi && a.hi !== null) reason = `${name} = ${value.toFixed(4)} > Hi:${a.hi}`;
        if (underLo && a.lo !== null) reason = `${name} = ${value.toFixed(4)} < Lo:${a.lo}`;
        newActive.add(name);
        if (!prev) triggered.push({ name, reason, value });
    }

    function getNumericValueForAlarmName(name) {
        if (!name) return null;
        if (isArrayElem(name)) {
            const br = name.lastIndexOf("[");
            const base = name.substring(0, br);
            const idx = parseInt(name.substring(br + 1), 10);
            const vd = varsByName[base];
            if (!vd || !Array.isArray(vd.value) || !Number.isFinite(idx) || idx < 0 || idx >= vd.value.length) return null;
            const v = vd.value[idx];
            return typeof v === "number" ? v : Number(v);
        }
        const vd = varsByName[name];
        if (!vd) return null;
        if (Array.isArray(vd.value)) return null;
        return typeof vd.value === "number" ? vd.value : (vd.value === true ? 1 : vd.value === false ? 0 : Number(vd.value));
    }

    function evaluateLocalAlarmsNow() {
        if (!isLiveMode()) return;
        const newActive = new Set();
        const triggered = [];
        for (const name of Object.keys(alarms || {})) {
            // Backend evalua alarmas de variables reales por ciclo.
            // Frontend solo mantiene temporalmente las virtuales (array elem / ARINC derivadas).
            if (!isArrayElem(name) && !isArincDerivedName(name)) continue;
            const val = getNumericValueForAlarmName(name);
            if (!Number.isFinite(val)) continue;
            checkAlarmEntry(name, val, newActive, triggered);
        }
        // Conserva alarmas activas notificadas por backend y añade las virtuales locales.
        const merged = new Set(Array.from(activeAlarms).filter((n) => !isArrayElem(n) && !isArincDerivedName(n)));
        newActive.forEach((n) => merged.add(n));
        activeAlarms = merged;
        const nextPrev = {};
        for (const name of Object.keys(alarms || {})) {
            if (isArrayElem(name) || isArincDerivedName(name)) nextPrev[name] = newActive.has(name);
        }
        // Mantener estado previo de reales controlado por backend.
        for (const [k, v] of Object.entries(prevAlarmState)) {
            if (!isArrayElem(k) && !isArincDerivedName(k)) nextPrev[k] = !!v;
        }
        prevAlarmState = nextPrev;
        updateAlarmActiveDOM();
        if (triggered.length > 0) {
            const reasons = triggered.map(t => `[LOCAL] ${t.reason}`).join(" | ");
            sendAlarmNotification(reasons);
            showAlarmBanner(reasons);
            plotsPaused = true;
            updatePauseBtn();
        }
    }

    function sendAlarmsToBackend() {
        const payload = {};
        for (const [name, cfg] of Object.entries(alarms)) {
            if (cfg && (cfg.lo != null || cfg.hi != null)) {
                payload[name] = {
                    lo: cfg.lo ?? null,
                    hi: cfg.hi ?? null,
                    hys: Number.isFinite(Number(cfg.hys)) ? Number(cfg.hys) : 0,
                    delayMs: Number.isFinite(Number(cfg.delayMs)) ? Number(cfg.delayMs) : 0,
                };
            }
        }
        sendWsAction({ action: "set_alarms", alarms: payload });
    }

    function sendSendFileOnFinish() {
        const val = sendFileOnFinishCheckbox ? sendFileOnFinishCheckbox.checked : false;
        sendWsAction({ action: "set_send_file_on_finish", value: val });
    }

    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }

    function sendAlarmNotification(reasons) {
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        if (document.hasFocus()) return;
        const n = new Notification("VarMonitor — Alarma", {
            body: reasons,
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚠</text></svg>",
            tag: "varmon-alarm",
        });
        n.addEventListener("click", () => { window.focus(); n.close(); });
        setTimeout(() => n.close(), 8000);
    }

    function updateAlarmActiveDOM() {
        if (!monitorListEl) return;
        monitorListEl.querySelectorAll(".monitor-item[data-name]").forEach(el => {
            el.classList.toggle("alarm-active", activeAlarms.has(el.dataset.name));
        });
        monitorListEl.querySelectorAll(".arr-alarm-btn").forEach(el => {
            const eName = el.closest("[data-name]")?.dataset?.name || el.dataset?.elemName;
            if (eName) el.classList.toggle("alarm-firing", activeAlarms.has(eName));
        });
    }

    function onAlarmTriggeredFromBackend(triggered) {
        if (!Array.isArray(triggered)) return;
        triggered.forEach(t => activeAlarms.add(t.name));
        updateAlarmActiveDOM();
        const reasons = triggered.map(t => t.reason).join(" | ");
        sendAlarmNotification(reasons);
        showAlarmBanner(reasons);
        plotsPaused = true;
        updatePauseBtn();
    }

    function onAlarmClearedFromBackend(names) {
        if (!Array.isArray(names)) return;
        names.forEach(n => {
            activeAlarms.delete(n);
            delete alarmPendingSince[n];
        });
        updateAlarmActiveDOM();
    }

    function basenameFromPath(path) {
        const p = String(path || "").trim();
        if (!p) return "";
        const norm = p.replace(/\\/g, "/");
        const i = norm.lastIndexOf("/");
        return i >= 0 ? norm.slice(i + 1) : norm;
    }

    async function enterAnalysisForRecordedFile(path, filename) {
        const fn = (filename || basenameFromPath(path)).trim();
        if (!fn) return;
        try {
            if (!isPlaybackMode()) setAppMode("offline", { keepData: true });
            await refreshServerRecordings();
            if (recordingSelect) {
                const has = Array.from(recordingSelect.options).some(o => o.value === fn);
                if (has) recordingSelect.value = fn;
            }
            // En el flujo desde toast mantenemos monitorizadas y asignaciones de gráficos.
            await loadRecordingFromServer(fn, { preserveLayout: true });
        } catch (e) {
            alert("No se pudo abrir el archivo en modo análisis: " + (e && e.message ? e.message : String(e)));
        }
    }

    function showRecordPathToast(path, opts = {}) {
        const el = document.getElementById("recordPathToast");
        const textEl = document.getElementById("recordPathText");
        if (el && textEl) {
            textEl.textContent = path || "";
            el.style.display = path ? "block" : "none";
            if (recordPathAnalyzeBtn) {
                const fn = (opts.filename || basenameFromPath(path)).trim();
                const showAnalyze = !!(fn && fn.toLowerCase().endsWith(".tsv"));
                recordPathAnalyzeBtn.style.display = showAnalyze ? "" : "none";
                if (showAnalyze) {
                    recordPathAnalyzeBtn.onclick = () => { enterAnalysisForRecordedFile(path, fn); };
                } else {
                    recordPathAnalyzeBtn.onclick = null;
                }
            }
            if (path) setTimeout(() => { el.style.display = "none"; }, 12000);
        }
    }

    function onRecordFinished(msg) {
        const path = (msg.path || msg.filename || "").trim();
        const text = path ? path : (msg.message || "Grabación finalizada.");
        showRecordPathToast(text, { filename: msg.filename || "" });
        if (msg.file_base64) {
            try {
                const bin = atob(msg.file_base64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const isTsv = (msg.filename || "").toLowerCase().endsWith(".tsv");
                const blob = new Blob([bytes], { type: isTsv ? "text/tab-separated-values" : "text/csv" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = msg.filename || "record.tsv";
                a.click();
                URL.revokeObjectURL(a.href);
            } catch (e) { /* ignore */ }
        }
        isRecording = false;
        isRecordingStopping = false;
        if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }
        if (recordStopFallbackTimer) { clearTimeout(recordStopFallbackTimer); recordStopFallbackTimer = null; }
        recordBtn.disabled = false;
        recordBtn.textContent = "\u25CF REC";
        recordBtn.classList.remove("recording");
        if (recordTimerEl) recordTimerEl.style.display = "none";
        recordSizeBytes = 0;
        if (pendingRecordingRestart && isLiveMode()) {
            pendingRecordingRestart = false;
            startRecording();
        } else {
            pendingRecordingRestart = false;
        }
    }

    function onAlarmRecordingReady(msg) {
        const path = msg.path || msg.filename || "";
        showRecordPathToast(path, { filename: msg.filename || "" });
        if (msg.file_base64) {
            try {
                const bin = atob(msg.file_base64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const isTsv = (msg.filename || "").toLowerCase().endsWith(".tsv");
                const blob = new Blob([bytes], { type: isTsv ? "text/tab-separated-values" : "text/csv" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = msg.filename || "alarm.tsv";
                a.click();
                URL.revokeObjectURL(a.href);
            } catch (e) { /* ignore */ }
        }
    }

    function onAlarmTriggered(triggers) {
        const now = Date.now();
        if (now - lastAutoTsvTime < AUTO_TSV_COOLDOWN_MS) return;
        lastAutoTsvTime = now;

        const reasons = triggers.map(t => t.reason).join(" | ");
        const triggerNames = triggers.map(t => t.name);

        sendAlarmNotification(reasons);

        setTimeout(() => {
            generateAlarmTsv(triggerNames);

            plotsPaused = true;
            updatePauseBtn();

            showAlarmBanner(reasons);
        }, AUTO_TSV_DELAY_MS);
    }

    function generateAlarmTsv(triggerNames) {
        const cols = Array.from(monitoredNames);
        if (cols.length === 0) return;

        const nowEpoch = Date.now() / 1000;
        const tMin = nowEpoch - AUTO_TSV_HISTORY_SEC - 1;
        const tMax = nowEpoch;

        const allTimestamps = new Set();
        const colData = {};

        for (const name of cols) {
            const hist = historyCache[name];
            colData[name] = {};
            if (!hist || !hist.timestamps) continue;
            for (let i = 0; i < hist.timestamps.length; i++) {
                const t = hist.timestamps[i];
                if (t >= tMin && t <= tMax) {
                    allTimestamps.add(t);
                    colData[name][t] = hist.values[i];
                }
            }
        }

        const sortedTs = Array.from(allTimestamps).sort((a, b) => a - b);
        if (sortedTs.length === 0) return;

        const t0 = sortedTs[0];
        const header = ["time_s"].concat(cols).join("\t");
        const lines = [header];
        for (const t of sortedTs) {
            const row = [(t - t0).toFixed(4)];
            for (const name of cols) {
                const v = colData[name][t];
                row.push(v !== undefined ? String(v) : "");
            }
            lines.push(row.join("\t"));
        }

        const content = lines.join("\n");
        const blob = new Blob([content], { type: "text/tab-separated-values" });

        const d = new Date();
        const pad2 = n => String(n).padStart(2, "0");
        const trigLabel = triggerNames.slice(0, 2).join("_").replace(/\./g, "-");
        const fname = "alarm_" + trigLabel + "_" +
            d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "_" +
            pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds()) + ".tsv";

        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    const alarmBanner = document.getElementById("alarmBanner");
    const alarmBannerText = document.getElementById("alarmBannerText");
    document.getElementById("alarmBannerDismiss").addEventListener("click", dismissAlarmBanner);

    function showAlarmBanner(message) {
        alarmBannerText.textContent = message;
        alarmBanner.style.display = "flex";
        alarmBanner.classList.add("alarm-banner-visible");
    }

    function dismissAlarmBanner() {
        alarmBanner.style.display = "none";
        alarmBanner.classList.remove("alarm-banner-visible");
    }

    function startInlineEdit(itemEl, name) {
        if (!isLiveMode()) return;
        if (editingName === name) return;
        const vd = varsByName[name];
        if (!vd) return;
        if (vd.type === "string" || vd.type === "array") return;
        if (isArincDerivedName(name)) return;

        editingName = name;
        const valEl = itemEl.querySelector(".mon-value");
        const currentText = valEl.textContent;

        const input = document.createElement("input");
        const ori = (varFormat[name] && varFormat[name].ori) ? varFormat[name].ori : "dec";
        const needsTextInput = vd.type === "bool" || ori === "hex" || ori === "bin" || ori === "arinc429";
        input.type = needsTextInput ? "text" : "number";
        input.className = "mon-edit-input";
        if (vd.type === "bool") {
            input.value = vd.value ? "true" : "false";
        } else if (ori === "hex") {
            input.value = "0x" + ((Math.round(Number(vd.value)) >>> 0).toString(16).toUpperCase());
        } else if (ori === "bin" || ori === "arinc429") {
            input.value = "0b" + ((Math.round(Number(vd.value)) >>> 0).toString(2));
        } else {
            input.value = vd.value;
        }
        if (vd.type === "double") input.step = "any";

        valEl.textContent = "";
        valEl.appendChild(input);
        input.focus();
        input.select();

        let done = false;

        function commit() {
            if (done) return;
            done = true;
            let sendVal, varType;
            const raw = input.value.trim();
            const fmt = varFormat[name];
            const ori = fmt ? (fmt.ori || "dec") : "dec";

            if (vd.type === "bool") {
                sendVal = (raw === "1" || raw.toLowerCase() === "true") ? 1 : 0;
                varType = "bool";
            } else if (vd.type === "int32") {
                const parsed = parseNumericWithFormat(raw, ori);
                sendVal = Number.isFinite(parsed) ? (Math.trunc(parsed) | 0) : 0;
                varType = "int32";
            } else {
                const parsed = parseNumericWithFormat(raw, ori);
                sendVal = Number.isFinite(parsed) ? parsed : 0;
                varType = "double";
            }

            sendWsAction({
                action: "set_var",
                name: name,
                value: sendVal,
                var_type: varType,
            });
            finish();
        }

        function cancel() {
            if (done) return;
            done = true;
            finish();
        }

        function finish() {
            editingName = null;
            valEl.textContent = currentText;
        }

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        });
        input.addEventListener("blur", cancel);
    }

    function onSetResult(msg) {
        // Visual feedback could be added here if needed
    }

    function updateMonitorValues() {
        const items = monitorListEl.querySelectorAll(".monitor-item");
        recomputeDeltaByName();
        for (let i = 0; i < items.length; i++) {
            const el = items[i];
            if (el.dataset.name === editingName) continue;
            const name = el.dataset.name;
            const monVal = el.querySelector(".mon-value");
            const vd = varsByName[name];
            let usedHistory = false;
            // En replay: SOLO las variables TSV impuestas usan valor del TSV;
            // las no impuestas se comportan como variables normales (SHM/C++).
            if (isPlaybackMode() && offlineRecordingName && isVarInTsv(name) && impositionNames.has(name) && monVal) {
                const tNow = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : null;
                if (tNow != null) {
                    const vHist = getReplayImposedValueAtTs(name, tNow);
                    if (vHist != null) {
                        monVal.textContent = formatValue(vHist, "double", name);
                        usedHistory = true;
                    }
                }
            }
            if (vd && monVal && !usedHistory) {
                monVal.textContent = formatValue(vd.value, vd.type, name);
                const arrBadge = el.querySelector(".array-badge");
                if (arrBadge && Array.isArray(vd.value)) {
                    arrBadge.textContent = "[" + vd.value.length + "]";
                }
            }
            const wrap = el.closest(".monitor-item-wrap");
            if (wrap && expandedStats.has(name)) updateStatsPanel(wrap, name);
        }
        sendAlarmsToBackend();
        refreshAllStats();
    }

    // Vigilar peticiones de ventanas cortas lentas y activar modo \"pensativo\".
    const WINDOW_SLOW_THRESHOLD_MS = 1200;
    setInterval(() => {
        // Solo considerar modo pensativo en análisis + modo seguro.
        if (!isPlaybackMode() || !offlineSafetyInfo || !offlineSafetyInfo.safeMode) {
            if (windowFetchSlow) {
                windowFetchSlow = false;
                if (monitorLoadingIndicator) monitorLoadingIndicator.style.display = "none";
                updateOfflineDatasetStatus();
            }
            return;
        }
        const now = performance.now();
        // Si hay una petición de ventana en curso desde hace demasiado tiempo.
        if (windowFetchInFlight > 0 && (now - windowFetchLastStart) >= WINDOW_SLOW_THRESHOLD_MS) {
            if (!windowFetchSlow) {
                windowFetchSlow = true;
                // Pausar automáticamente la reproducción para no seguir avanzando
                // mientras el backend está cargando datos.
                if (offlinePlayback.isPlaying) {
                    stopOfflinePlayback();
                }
                if (monitorLoadingIndicator) monitorLoadingIndicator.style.display = "inline-flex";
                updateOfflineDatasetStatus();
            }
        } else {
            if (windowFetchSlow && windowFetchInFlight === 0) {
                windowFetchSlow = false;
                if (monitorLoadingIndicator) monitorLoadingIndicator.style.display = "none";
                updateOfflineDatasetStatus();
            }
        }
    }, 500);

    function getGraphAccent(gid) {
        const idx = graphList.indexOf(gid);
        if (idx < 0) return null;
        return GRAPH_ACCENT[idx % GRAPH_ACCENT.length];
    }

    function updateSelectStyle(sel) {
        for (let i = 0; i < MAX_GRAPHS; i++) sel.classList.remove("g" + (i + 1));
        sel.style.borderColor = "";
        sel.style.color = "";
        sel.style.backgroundColor = "";
        if (sel.value) {
            const idx = graphList.indexOf(sel.value);
            if (idx >= 0) {
                const c = GRAPH_ACCENT[idx % GRAPH_ACCENT.length];
                sel.style.borderColor = c;
                sel.style.color = c;
                sel.style.backgroundColor = c + "1a";
            }
        }
    }

    function updateMonitorItemStyles() {
        monitorListEl.querySelectorAll(".monitor-item[data-name]").forEach(el => {
            el.style.borderColor = "";
            el.style.backgroundColor = "";
            const name = el.dataset.name;
            const g = varGraphAssignment[name] || "";
            if (g) {
                const c = getSeriesColor(name);
                el.style.borderColor = c;
                el.style.backgroundColor = c + "1a";
            }
            const icon = el.querySelector(".mon-alarm-icon");
            if (icon) icon.style.display = alarms[name] ? "" : "none";
        });
    }

    // Nota: el antiguo botón "Quitar sel." se ha eliminado; su funcionalidad
    // ahora la asume el botón de Reset de gráficos.

    function clearAllAlarms() {
        alarms = {};
        prevAlarmState = {};
        activeAlarms.clear();
        monitorListEl.querySelectorAll(".monitor-item.alarm-active").forEach(el => {
            el.classList.remove("alarm-active");
        });
        saveConfig();
        sendAlarmsToBackend();
        updateMonitorItemStyles();
        refreshAllStats();
        dismissAlarmBanner();
    }

    function refreshAlarmListPanel() {
        const listEl = document.getElementById("alarmList");
        if (!listEl) return;
        listEl.innerHTML = "";
        const names = Object.keys(alarms);
        if (names.length === 0) {
            const empty = document.createElement("div");
            empty.className = "alarm-list-empty";
            empty.textContent = currentLang === "en" ? "No alarms" : "Sin alarmas";
            listEl.appendChild(empty);
            return;
        }
        names.sort().forEach(name => {
            const row = document.createElement("div");
            row.className = "alarm-list-item";
            const label = document.createElement("span");
            label.className = "alarm-list-name";
            const isLocalVirtual = isArrayElem(name) || isArincDerivedName(name);
            label.textContent = isLocalVirtual ? `${name} [LOCAL]` : name;
            const btn = document.createElement("button");
            btn.className = "alarm-list-remove";
            btn.textContent = "×";
            btn.title = currentLang === "en" ? "Remove alarm" : "Quitar alarma";
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                delete alarms[name];
                saveConfig();
                sendAlarmsToBackend();
                updateMonitorItemStyles();
                refreshAllStats();
                refreshAlarmListPanel();
            });
            row.appendChild(label);
            row.appendChild(btn);
            listEl.appendChild(row);
        });
    }

    // ===== COMPUTED VARS UI =====

    let computedFormVisible = false;

    document.getElementById("addComputedBtn").addEventListener("click", () => {
        computedFormVisible = !computedFormVisible;
        let form = document.getElementById("computedForm");
        if (computedFormVisible) {
            if (!form) {
                form = document.createElement("div");
                form.id = "computedForm";
                form.className = "computed-form";
                form.innerHTML =
                    '<div class="comp-row">' +
                    '<input id="compName" class="comp-input comp-name" placeholder="nombre" title="Nombre de la variable computada">' +
                    '<span class="comp-eq">=</span>' +
                    '<input id="compExpr" class="comp-input comp-expr" placeholder="ej: waves.sine * 2 + 1" title="Expresion JS. Usa nombres con puntos (waves.sine) o guiones bajos (waves_sine)">' +
                    '<button id="compOk" class="btn-comp-ok">&#10003;</button>' +
                    '<button id="compCancel" class="btn-comp-cancel">&times;</button>' +
                    '</div>' +
                    '<div id="compError" class="comp-error" style="display:none"></div>';
                monitorListEl.parentNode.insertBefore(form, monitorListEl);
                document.getElementById("compOk").addEventListener("click", submitComputed);
                document.getElementById("compCancel").addEventListener("click", () => {
                    computedFormVisible = false;
                    form.remove();
                });
                document.getElementById("compExpr").addEventListener("keydown", (e) => {
                    if (e.key === "Enter") submitComputed();
                    else if (e.key === "Escape") { computedFormVisible = false; form.remove(); }
                });
                document.getElementById("compName").focus();
            }
        } else {
            if (form) form.remove();
        }
    });

    function submitComputed() {
        const nameEl = document.getElementById("compName");
        const exprEl = document.getElementById("compExpr");
        const errEl = document.getElementById("compError");
        const name = nameEl.value.trim();
        const expr = exprEl.value.trim();
        if (!name) { showCompError(errEl, "Falta el nombre"); nameEl.focus(); return; }
        if (!expr) { showCompError(errEl, "Falta la expresion"); exprEl.focus(); return; }
        const result = addComputedVar(name, expr);
        if (result === "duplicate") { showCompError(errEl, "Ya existe '" + name + "'"); nameEl.focus(); return; }
        if (result !== true) { showCompError(errEl, "Error de sintaxis: " + result); exprEl.focus(); return; }
        saveConfig();
        sendMonitored();
        rebuildMonitorList();
        computedFormVisible = false;
        const form = document.getElementById("computedForm");
        if (form) form.remove();
    }

    function showCompError(el, msg) {
        if (!el) return;
        el.textContent = msg;
        el.style.display = "block";
        setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    // ===== RECORD =====

    recordBtn.addEventListener("click", () => {
        if (isRecordingStopping) return;
        if (isRecording) {
            stopRecording(true);
        } else {
            startRecording();
        }
    });

    function buildRecordColumns() {
        const cols = [];
        for (const name of monitoredNames) {
            if (isArrayVar(name)) {
                const vd = varsByName[name];
                const len = vd && Array.isArray(vd.value) ? vd.value.length : 0;
                for (let i = 0; i < len; i++) cols.push(arrayElemName(name, i));
            } else {
                cols.push(name);
            }
        }
        return cols;
    }

    function formatRecordingSize(bytes) {
        const mb = (Math.max(0, Number(bytes) || 0) / (1024 * 1024));
        return `${mb.toFixed(2)} MB`;
    }

    function updateRecordTimerDisplay() {
        if (!recordTimerEl) return;
        const elapsed = Math.max(0, Math.floor((Date.now() - recordStartTime) / 1000));
        const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
        const ss = String(elapsed % 60).padStart(2, "0");
        recordTimerEl.textContent = `${mm}:${ss} | ${formatRecordingSize(recordSizeBytes)}`;
    }

    function onRecordingProgress(msg) {
        if (!isRecording) return;
        if (msg) {
            const b = Number(msg.bytes);
            const s = Number(msg.samples);
            if (Number.isFinite(b) && b > 0) {
                recordSizeBytes = Math.max(0, b);
            } else if (Number.isFinite(s) && s > 0) {
                // Fallback de estimación cuando backend aún no reporta bytes reales.
                const cols = Math.max(1, Array.isArray(recordColumns) ? recordColumns.length : 1);
                const estPerRow = Math.max(24, cols * 14);
                const est = s * estPerRow;
                if (est > recordSizeBytes) recordSizeBytes = est;
            }
            updateRecordTimerDisplay();
        }
    }

    function startRecording() {
        if (isRecordingStopping) return;
        if (monitoredNames.size === 0 || !isLiveMode()) return;
        if (recordStopFallbackTimer) { clearTimeout(recordStopFallbackTimer); recordStopFallbackTimer = null; }
        sendWsAction({ action: "start_recording" });
        isRecording = true;
        recordColumns = buildRecordColumns();
        recordBuffer = [];
        recordStartTime = Date.now();
        recordSizeBytes = 0;

        recordBtn.textContent = "\u25A0 STOP";
        recordBtn.classList.add("recording");
        recordTimerEl.style.display = "inline";
        updateRecordTimerDisplay();

        recordTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
            updateRecordTimerDisplay();

            if (elapsed >= MAX_RECORD_SEC) {
                stopRecording(false, { autoRestart: true });
            }
        }, 500);
    }

    function stopRecording(download, opts = {}) {
        if (isRecordingStopping) return;
        pendingRecordingRestart = !!opts.autoRestart;
        if (isLiveMode()) sendWsAction({ action: "stop_recording" });
        isRecording = false;
        isRecordingStopping = true;
        if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }

        recordBtn.disabled = true;
        recordBtn.textContent = "...";
        recordBtn.classList.add("recording");
        recordTimerEl.style.display = "inline";
        recordTimerEl.textContent = "Procesando grabacion...";
        recordBuffer = [];
        if (recordStopFallbackTimer) clearTimeout(recordStopFallbackTimer);
        recordStopFallbackTimer = setTimeout(() => {
            if (!isRecordingStopping) return;
            isRecording = false;
            isRecordingStopping = false;
            pendingRecordingRestart = false;
            recordBtn.disabled = false;
            recordBtn.textContent = "\u25CF REC";
            recordBtn.classList.remove("recording");
            if (recordTimerEl) recordTimerEl.style.display = "none";
            showRecordPathToast("Grabación finalizada (timeout de confirmación).", {});
            recordStopFallbackTimer = null;
        }, 8000);
    }

    function recordSample() {
        if (!isRecording || recordColumns.length === 0) return;
        const elapsed = ((Date.now() - recordStartTime) / 1000).toFixed(4);
        const row = [elapsed];
        for (const col of recordColumns) {
            if (isArrayElem(col)) {
                const val = getArrayElemValue(col);
                row.push(val !== undefined ? String(val) : "");
            } else {
                const vd = varsByName[col];
                row.push(vd ? String(vd.value) : "");
            }
        }
        recordBuffer.push(row);
    }

    function downloadTSV() {
        const header = ["time_s"].concat(recordColumns).join("\t");
        const lines = [header];
        for (const row of recordBuffer) {
            lines.push(row.join("\t"));
        }
        const content = lines.join("\n");
        const blob = new Blob([content], { type: "text/tab-separated-values" });

        const d = new Date(recordStartTime);
        const pad2 = n => String(n).padStart(2, "0");
        const fname = "record_" +
            d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "_" +
            pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds()) + ".tsv";

        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ===== SCREENSHOT =====

    screenshotBtn.addEventListener("click", captureScreenshot);

    async function captureScreenshot() {
        const activeGids = graphList.filter(gid => plotInstances[gid]);
        if (activeGids.length === 0) return;

        screenshotBtn.disabled = true;
        screenshotBtn.textContent = "...";

        try {
            const images = [];
            const LABEL_H = 28;

            for (const gid of activeGids) {
                const containerEl = document.getElementById("plotContainer_" + gid);
                if (!containerEl) continue;
                const rect = containerEl.getBoundingClientRect();
                const w = Math.round(rect.width * 2);
                const h = Math.round(rect.height * 2);

                const dataUrl = await Plotly.toImage(containerEl, {
                    format: "png", width: w, height: h, scale: 1,
                });

                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = dataUrl;
                });

                images.push({ gid, img, w, h });
            }

            const totalW = Math.max(...images.map(i => i.w));
            const totalH = images.reduce((s, i) => s + i.h + LABEL_H, 0);

            const canvas = document.createElement("canvas");
            canvas.width = totalW;
            canvas.height = totalH;
            const ctx = canvas.getContext("2d");

            ctx.fillStyle = "#1a1d27";
            ctx.fillRect(0, 0, totalW, totalH);

            let y = 0;
            for (const { gid, img, w, h } of images) {
                const gIdx = graphList.indexOf(gid);
                const color = GRAPH_ACCENT[gIdx % GRAPH_ACCENT.length];

                ctx.fillStyle = "#1a1d27";
                ctx.fillRect(0, y, totalW, LABEL_H);

                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(16, y + LABEL_H / 2, 6, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = "#8b8fa3";
                ctx.font = "bold 20px sans-serif";
                ctx.textBaseline = "middle";
                ctx.fillText((I18N[currentLang] || I18N.es).graphTitle + " " + (gIdx + 1), 30, y + LABEL_H / 2);

                y += LABEL_H;
                ctx.drawImage(img, 0, y, w, h);
                y += h;
            }

            canvas.toBlob((blob) => {
                const d = new Date();
                const pad2 = n => String(n).padStart(2, "0");
                const fname = "graphs_" +
                    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "_" +
                    pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds()) + ".png";
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = fname;
                a.click();
                URL.revokeObjectURL(a.href);
            }, "image/png");

        } catch (err) {
            console.error("Screenshot error:", err);
        } finally {
            screenshotBtn.disabled = false;
            screenshotBtn.textContent = "\uD83D\uDCF7 PNG";
        }
    }

    // --- Column 3: Dynamic plots ---

    function getVarsForGraph(gid) {
        const names = [];
        for (const name of monitoredNames) {
            if (varGraphAssignment[name] === gid) names.push(name);
        }
        for (const [name, g] of Object.entries(varGraphAssignment)) {
            if (g !== gid) continue;
            if (!isArincDerivedName(name)) continue;
            if (!names.includes(name)) names.push(name);
        }
        for (const [eName, g] of Object.entries(arrayElemAssignment)) {
            if (g === gid) names.push(eName);
        }
        return names;
    }

    function schedulePlotRender() {
        if (plotsPaused) return;
        if (adaptiveLoadEnabled && document.hidden) return;
        if (adaptiveLoadEnabled) {
            const now = performance.now();
            if (now < nextAllowedRenderAt) return;
        }
        if (!plotRafPending) {
            plotRafPending = true;
            requestAnimationFrame(() => {
                plotRafPending = false;
                if (!plotsPaused) renderPlots();
            });
        }
    }

    function trimLocalHistory() {
        // Usar el máximo timestamp presente en los datos (misma base que el servidor) para evitar
        // desfase con Date.now() y el salto/discontinuidad al llegar al límite del buffer.
        let maxTs = null;
        for (const name in historyCache) {
            const h = historyCache[name];
            if (!h || !h.timestamps || h.timestamps.length === 0 || isComputed(name)) continue;
            const m = h.timestamps[h.timestamps.length - 1];
            if (maxTs === null || m > maxTs) maxTs = m;
        }
        for (const key of Object.keys(arrayElemHistory)) {
            const h = arrayElemHistory[key];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            const m = h.timestamps[h.timestamps.length - 1];
            if (maxTs === null || m > maxTs) maxTs = m;
        }
        if (maxTs === null) return;
        const cutoff = maxTs - localHistMaxSec;
        for (const name in historyCache) {
            const h = historyCache[name];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            if (isComputed(name)) continue;
            let lo = 0;
            while (lo < h.timestamps.length && h.timestamps[lo] < cutoff) lo++;
            if (lo > 0) {
                h.timestamps = h.timestamps.slice(lo);
                h.values = h.values.slice(lo);
            }
        }
        for (const key of Object.keys(arrayElemHistory)) {
            const h = arrayElemHistory[key];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            let lo = 0;
            while (lo < h.timestamps.length && h.timestamps[lo] < cutoff) lo++;
            if (lo > 0) {
                h.timestamps = h.timestamps.slice(lo);
                h.values = h.values.slice(lo);
            }
        }
        for (const cv of computedVars) {
            const h = computedHistories[cv.name];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            let lo = 0;
            while (lo < h.timestamps.length && h.timestamps[lo] < cutoff) lo++;
            if (lo > 0) {
                h.timestamps = h.timestamps.slice(lo);
                h.values = h.values.slice(lo);
            }
        }
        // Actualizar el origen de sesión al mínimo que queda: así el eje X sigue mostrando
        // 0..buffer segundos y no se produce el salto cada vez que se recorta.
        let newMin = null;
        for (const name in historyCache) {
            const h = historyCache[name];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            const m = h.timestamps[0];
            if (newMin === null || m < newMin) newMin = m;
        }
        for (const key of Object.keys(arrayElemHistory)) {
            const h = arrayElemHistory[key];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            const m = h.timestamps[0];
            if (newMin === null || m < newMin) newMin = m;
        }
        for (const cv of computedVars) {
            const h = computedHistories[cv.name];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            const m = h.timestamps[0];
            if (newMin === null || m < newMin) newMin = m;
        }
        // En live los timestamps ya son relativos (0, 0.1, ...); sessionStartTime debe seguir
        // siendo el Unix del inicio de sesión. Solo actualizar en modo offline (tiempos absolutos).
        if (!isLiveMode() && newMin !== null) sessionStartTime = newMin;
    }

    /** Elimina puntos con timestamp anterior al origen de sesión (tras "Reset tiempo"). */
    function trimHistoryToSessionStart() {
        if (sessionStartTime == null) return;
        const cutoff = sessionStartTime;
        for (const name in historyCache) {
            const h = historyCache[name];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            let lo = 0;
            while (lo < h.timestamps.length && h.timestamps[lo] < cutoff) lo++;
            if (lo > 0) {
                h.timestamps = h.timestamps.slice(lo);
                h.values = h.values.slice(lo);
            }
        }
        for (const key of Object.keys(arrayElemHistory)) {
            const h = arrayElemHistory[key];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            let lo = 0;
            while (lo < h.timestamps.length && h.timestamps[lo] < cutoff) lo++;
            if (lo > 0) {
                h.timestamps = h.timestamps.slice(lo);
                h.values = h.values.slice(lo);
            }
        }
        for (const cv of computedVars) {
            const h = computedHistories[cv.name];
            if (!h || !h.timestamps || h.timestamps.length === 0) continue;
            let lo = 0;
            while (lo < h.timestamps.length && h.timestamps[lo] < cutoff) lo++;
            if (lo > 0) {
                h.timestamps = h.timestamps.slice(lo);
                h.values = h.values.slice(lo);
            }
        }
    }

    function nextGraphId() {
        for (let i = 1; i <= MAX_GRAPHS + 20; i++) {
            const id = "g" + i;
            if (!graphList.includes(id)) return id;
        }
        return "g" + (graphList.length + 1);
    }

    function flattenGraphColumns() {
        const flat = [];
        const seen = new Set();
        for (const col of graphColumns) {
            if (!Array.isArray(col)) continue;
            for (const gid of col) {
                if (!gid || seen.has(gid)) continue;
                seen.add(gid);
                flat.push(gid);
            }
        }
        return flat;
    }

    function normalizeGraphLayout() {
        // Normalizar IDs válidos (únicos) y capacidad global.
        const orderedIds = [];
        const seenInput = new Set();
        for (const gid of Array.isArray(graphList) ? graphList : []) {
            if (!gid || seenInput.has(gid)) continue;
            seenInput.add(gid);
            orderedIds.push(gid);
            if (orderedIds.length >= MAX_GRAPHS) break;
        }
        const validSet = new Set(orderedIds);

        // Importante: preservar la topología existente de columnas y filas
        // (no reempaquetar), para que "derecha" siga significando "nueva columna".
        const normalizedCols = [];
        const seenPlaced = new Set();
        if (Array.isArray(graphColumns)) {
            for (const rawCol of graphColumns) {
                if (normalizedCols.length >= MAX_GRAPH_COLUMNS) break;
                if (!Array.isArray(rawCol)) continue;
                const col = [];
                for (const gid of rawCol) {
                    if (!validSet.has(gid) || seenPlaced.has(gid)) continue;
                    col.push(gid);
                    seenPlaced.add(gid);
                    if (col.length >= MAX_GRAPH_ROWS) break;
                }
                if (col.length > 0) normalizedCols.push(col);
            }
        }

        // Si vienen IDs en graphList que no están en columnas, anexarlos sin
        // romper la topología existente (rellenando al final).
        for (const gid of orderedIds) {
            if (seenPlaced.has(gid)) continue;
            let col = normalizedCols[normalizedCols.length - 1];
            if (!col || col.length >= MAX_GRAPH_ROWS) {
                if (normalizedCols.length >= MAX_GRAPH_COLUMNS) break;
                col = [];
                normalizedCols.push(col);
            }
            col.push(gid);
            seenPlaced.add(gid);
        }

        graphColumns = normalizedCols;
        graphList = flattenGraphColumns();
    }

    function addGraphAt(mode, columnIndex) {
        normalizeGraphLayout();
        if (graphList.length >= MAX_GRAPHS) return null;
        const gid = nextGraphId();
        if (mode === "right") {
            if (graphColumns.length >= MAX_GRAPH_COLUMNS) return null;
            graphColumns.push([gid]);
        } else {
            if (graphColumns.length === 0) graphColumns.push([]);
            let targetCol = Number.isFinite(columnIndex) ? Math.max(0, Math.min(graphColumns.length - 1, columnIndex)) : (graphColumns.length - 1);
            if (!Array.isArray(graphColumns[targetCol])) graphColumns[targetCol] = [];
            // Inserción inferior estricta: solo en la columna objetivo.
            // Si está llena, no se crea gráfica en otra columna automáticamente.
            if (graphColumns[targetCol].length >= MAX_GRAPH_ROWS) return null;
            graphColumns[targetCol].push(gid);
        }
        graphList = flattenGraphColumns();
        return gid;
    }

    function addGraph() {
        const gid = addGraphAt("bottom", graphColumns.length - 1);
        if (!gid) return;
        saveConfig();
        rebuildPlotArea();
        rebuildMonitorList();
        renderPlots();
    }

    function handleNewGraphDrop(name, opts = {}) {
        if (!name) return;
        const namesToAssign = monitorSelectedNames.has(name) ? [...monitorSelectedNames].filter(n => !isArrayVar(n) && !isArrayElem(n)) : [name];
        for (const n of namesToAssign) {
            if (!monitoredNames.has(n) && !isArrayElem(n) && !isArincDerivedName(n)) {
                ensureArincBaseMonitored(n);
                ensureMonitoredName(n);
            }
        }
        if (namesToAssign.length) sendMonitored();
        if (graphList.length >= MAX_GRAPHS) return;
        const mode = opts.mode === "right" ? "right" : "bottom";
        const newGid = addGraphAt(mode, opts.columnIndex);
        if (!newGid) return;
        for (const n of namesToAssign) {
            if (isArrayElem(n)) {
                arrayElemAssignment[n] = newGid;
                ensureSeriesColor(n, true);
            } else {
                varGraphAssignment[n] = newGid;
                ensureSeriesColor(n, true);
                if (isPlaybackMode()) fetchFullHistoryIfNeeded(n);
            }
            browserSelection.delete(n);
        }
        rebuildPlotArea();
        pruneEmptyGraphs();
        rebuildMonitorList();
        saveConfig();
        schedulePlotRender();
    }

    function ensureNewGraphDropTarget() {
        plotArea.querySelectorAll(".plot-add-slot").forEach((slot) => {
            slot.style.display = slot.dataset.addEnabled === "1" ? "flex" : "none";
        });
        if (!plotEmpty._dropZoneAttached) {
            plotEmpty._dropZoneAttached = true;
            plotEmpty.ondragover = (e) => {
                if (!e.dataTransfer) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                plotEmpty.classList.add("plot-add-over");
                if (!plotEmpty.dataset.defaultText) plotEmpty.dataset.defaultText = plotEmpty.textContent;
                plotEmpty.textContent = (I18N[currentLang] || I18N.es).newGraphDropText;
            };
            plotEmpty.ondragleave = () => {
                plotEmpty.classList.remove("plot-add-over");
                if (plotEmpty.dataset.defaultText) plotEmpty.textContent = plotEmpty.dataset.defaultText;
            };
            plotEmpty.ondrop = (e) => {
                if (!e.dataTransfer) return;
                e.preventDefault();
                plotEmpty.classList.remove("plot-add-over");
                if (plotEmpty.dataset.defaultText) plotEmpty.textContent = plotEmpty.dataset.defaultText;
                const name = e.dataTransfer.getData("text/plain");
                handleNewGraphDrop(name, { mode: "bottom", columnIndex: 0 });
            };
        }
    }

    function removeGraph(gid) {
        normalizeGraphLayout();
        graphColumns = graphColumns
            .map((col) => col.filter((g) => g !== gid))
            .filter((col) => col.length > 0);
        graphList = flattenGraphColumns();
        for (const name of monitoredNames) {
            if (varGraphAssignment[name] === gid) varGraphAssignment[name] = "";
        }
        for (const [eName, g] of Object.entries(arrayElemAssignment)) {
            if (g === gid) delete arrayElemAssignment[eName];
        }
        const containerEl = document.getElementById("plotContainer_" + gid);
        if (containerEl && plotInstances[gid]) Plotly.purge(containerEl);
        delete plotInstances[gid];
        saveConfig();
        rebuildPlotArea();
        rebuildMonitorList();
        renderPlots();
    }

    function rebuildPlotArea() {
        normalizeGraphLayout();
        Object.keys(plotInstances).forEach((gid) => {
            const el = document.getElementById("plotContainer_" + gid);
            if (el) Plotly.purge(el);
        });
        plotInstances = {};

        Array.from(plotArea.children).forEach((child) => {
            const id = child && child.id ? child.id : "";
            if (id === "plotEmpty" || id === "toggleAdvancedPlotBtn") return;
            plotArea.removeChild(child);
        });
        const tr = I18N[currentLang] || I18N.es;
        const totalGraphs = graphList.length;
        const canAddMore = totalGraphs < MAX_GRAPHS;

        // Sin gráficos: no insertar grid vacío (ocuparía flex:1 y dejaría plotEmpty a media altura).
        if (totalGraphs === 0) {
            if (toggleAdvancedPlotBtn && toggleAdvancedPlotBtn.parentElement !== plotArea) {
                plotArea.appendChild(toggleAdvancedPlotBtn);
            }
            if (plotEmpty) plotEmpty.style.display = "flex";
            return;
        }

        const grid = document.createElement("div");
        grid.id = "plotGrid";
        grid.className = "plot-grid";
        const mainRow = document.createElement("div");
        mainRow.className = "plot-grid-main";

        graphColumns.forEach((col, colIdx) => {
            const colEl = document.createElement("div");
            colEl.className = "plot-column";
            colEl.dataset.colIndex = String(colIdx);

            col.forEach((gid) => {
                const idx = graphList.indexOf(gid);
                const slot = document.createElement("div");
                slot.id = "plotSlot_" + gid;
                slot.className = "plot-slot";
                slot.style.display = "flex";

                const header = document.createElement("div");
                header.className = "plot-slot-header";

                const dot = document.createElement("span");
                dot.className = "plot-dot";
                dot.style.backgroundColor = GRAPH_ACCENT[Math.max(0, idx) % GRAPH_ACCENT.length];

                const label = document.createElement("span");
                label.className = "plot-slot-title";
                label.textContent = " " + tr.graphTitle + " " + (Math.max(0, idx) + 1);

                const removeBtn = document.createElement("button");
                removeBtn.className = "btn-plot-remove";
                removeBtn.textContent = "\u00D7";
                removeBtn.title = tr.removeGraphTitle;
                removeBtn.addEventListener("click", () => removeGraph(gid));

                header.appendChild(dot);
                header.appendChild(label);
                header.appendChild(removeBtn);

                const container = document.createElement("div");
                container.className = "plot-container";
                container.id = "plotContainer_" + gid;

                slot.appendChild(header);
                slot.appendChild(container);
                colEl.appendChild(slot);

                slot.addEventListener("dragover", (e) => {
                    if (!e.dataTransfer) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    slot.classList.add("plot-drop-over");
                });
                slot.addEventListener("dragleave", () => {
                    slot.classList.remove("plot-drop-over");
                });
                slot.addEventListener("drop", (e) => {
                    if (!e.dataTransfer) return;
                    e.preventDefault();
                    slot.classList.remove("plot-drop-over");
                    const name = e.dataTransfer.getData("text/plain");
                    if (!name) return;
                    const namesToAssign = monitorSelectedNames.has(name) ? [...monitorSelectedNames].filter(n => !isArrayVar(n) && !isArrayElem(n)) : [name];
                    for (const n of namesToAssign) {
                        if (!monitoredNames.has(n) && !isArrayElem(n) && !isArincDerivedName(n)) {
                            ensureArincBaseMonitored(n);
                            ensureMonitoredName(n);
                        }
                    }
                    if (namesToAssign.length) sendMonitored();
                    for (const n of namesToAssign) {
                        if (isArrayElem(n)) {
                            arrayElemAssignment[n] = gid;
                            ensureSeriesColor(n, true);
                        } else {
                            varGraphAssignment[n] = gid;
                            ensureSeriesColor(n, true);
                            if (isPlaybackMode()) fetchFullHistoryIfNeeded(n);
                        }
                        browserSelection.delete(n);
                    }
                    pruneEmptyGraphs();
                    rebuildMonitorList();
                    saveConfig();
                    schedulePlotRender();
                });
            });

            mainRow.appendChild(colEl);
        });

        if (canAddMore && graphColumns.length > 0 && graphColumns.length < MAX_GRAPH_COLUMNS) {
            const addRight = document.createElement("div");
            addRight.className = "plot-add-slot plot-add-slot-right";
            addRight.dataset.addEnabled = "1";
            addRight.textContent = "Nueva columna";
            addRight.addEventListener("dragover", (e) => {
                if (!e.dataTransfer) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                addRight.classList.add("plot-add-over");
            });
            addRight.addEventListener("dragleave", () => addRight.classList.remove("plot-add-over"));
            addRight.addEventListener("drop", (e) => {
                if (!e.dataTransfer) return;
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
                addRight.classList.remove("plot-add-over");
                const name = e.dataTransfer.getData("text/plain");
                handleNewGraphDrop(name, { mode: "right" });
            });
            mainRow.appendChild(addRight);
        }

        grid.appendChild(mainRow);

        if (canAddMore && graphColumns.length > 0) {
            const bottomRow = document.createElement("div");
            bottomRow.className = "plot-add-bottom-row";
            graphColumns.forEach((col, colIdx) => {
                const addBottom = document.createElement("div");
                addBottom.className = "plot-add-slot plot-add-slot-bottom plot-add-slot-under-col";
                addBottom.dataset.colIndex = String(colIdx);
                addBottom.textContent = `Abajo C${colIdx + 1}`;
                if (col.length >= MAX_GRAPH_ROWS) {
                    addBottom.dataset.addEnabled = "0";
                    addBottom.style.display = "none";
                } else {
                    addBottom.dataset.addEnabled = "1";
                    addBottom.addEventListener("dragover", (e) => {
                        if (!e.dataTransfer) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                        addBottom.classList.add("plot-add-over");
                    });
                    addBottom.addEventListener("dragleave", () => addBottom.classList.remove("plot-add-over"));
                    addBottom.addEventListener("drop", (e) => {
                        if (!e.dataTransfer) return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
                        addBottom.classList.remove("plot-add-over");
                        const name = e.dataTransfer.getData("text/plain");
                        handleNewGraphDrop(name, { mode: "bottom", columnIndex: colIdx });
                    });
                }
                bottomRow.appendChild(addBottom);
            });
            if (graphColumns.length < MAX_GRAPH_COLUMNS) {
                const spacer = document.createElement("div");
                spacer.className = "plot-add-bottom-spacer";
                bottomRow.appendChild(spacer);
            }
            grid.appendChild(bottomRow);
        }

        plotArea.insertBefore(grid, plotEmpty);
        if (toggleAdvancedPlotBtn && toggleAdvancedPlotBtn.parentElement !== plotArea) {
            plotArea.appendChild(toggleAdvancedPlotBtn);
        }

        if (plotEmpty) plotEmpty.style.display = graphList.length > 0 ? "none" : "flex";
    }

    function pruneEmptyGraphs() {
        normalizeGraphLayout();
        const empty = graphList.filter(gid => getVarsForGraph(gid).length === 0);
        if (empty.length === 0) return;
        for (const gid of empty) {
            graphColumns = graphColumns
                .map((col) => col.filter((g) => g !== gid))
                .filter((col) => col.length > 0);
            graphList = flattenGraphColumns();
            const cEl = document.getElementById("plotContainer_" + gid);
            if (cEl && plotInstances[gid]) Plotly.purge(cEl);
            delete plotInstances[gid];
        }
        saveConfig();
        rebuildPlotArea();
        rebuildMonitorList();
    }

    /** Media móvil centrada para suavizar series (ventana impar). */
    function movingAverage(values, windowSize) {
        if (windowSize <= 1 || values.length === 0) return values.slice();
        const half = Math.floor(windowSize / 2);
        const out = [];
        for (let i = 0; i < values.length; i++) {
            const lo = Math.max(0, i - half);
            const hi = Math.min(values.length - 1, i + half);
            let sum = 0;
            for (let j = lo; j <= hi; j++) sum += values[j];
            out.push(sum / (hi - lo + 1));
        }
        return out;
    }

    function downsampleSeries(xs, ys, maxPoints) {
        if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length <= maxPoints) {
            return { x: xs, y: ys };
        }
        const step = Math.max(1, Math.ceil(xs.length / maxPoints));
        const x = [];
        const y = [];
        for (let i = 0; i < xs.length; i += step) {
            x.push(xs[i]);
            y.push(ys[i]);
        }
        if (x[x.length - 1] !== xs[xs.length - 1]) {
            x.push(xs[xs.length - 1]);
            y.push(ys[ys.length - 1]);
        }
        return { x, y };
    }

    function applySharedZoomToOtherPlots(sourceGid, range, autorange) {
        for (const gid of graphList) {
            if (gid === sourceGid || !plotInstances[gid]) continue;
            const el = document.getElementById("plotContainer_" + gid);
            if (!el) continue;
            try {
                if (autorange) {
                    el._varmonApplyingSharedZoom = true;
                    Plotly.relayout(el, { "xaxis.autorange": true }).finally(() => {
                        el._varmonApplyingSharedZoom = false;
                    });
                } else if (Array.isArray(range) && range.length === 2) {
                    el._varmonApplyingSharedZoom = true;
                    Plotly.relayout(el, { "xaxis.range": range, "xaxis.autorange": false }).finally(() => {
                        el._varmonApplyingSharedZoom = false;
                    });
                }
            } catch (e) { /* ignore sync errors */ }
        }
    }

    function scheduleSharedZoomSync(sourceGid, range, autorange) {
        pendingSharedZoomSync = { sourceGid, range };
        pendingSharedZoomAutorange = !!autorange;
        if (sharedZoomSyncTimer) return;
        sharedZoomSyncTimer = setTimeout(() => {
            sharedZoomSyncTimer = null;
            const job = pendingSharedZoomSync;
            if (!job) return;
            pendingSharedZoomSync = null;
            syncingSharedZoom = true;
            applySharedZoomToOtherPlots(job.sourceGid, job.range, pendingSharedZoomAutorange);
            syncingSharedZoom = false;
        }, 20);
    }

    function rangesAlmostEqual(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) return false;
        return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
    }

    function attachSharedZoomHandler(containerEl, gid) {
        if (!containerEl || containerEl._varmonRelayoutHooked) return;
        containerEl._varmonRelayoutHooked = true;
        containerEl.on("plotly_relayout", (evt) => {
            if (syncingSharedZoom || containerEl._varmonApplyingSharedZoom || !evt) return;
            if (evt["xaxis.autorange"]) {
                sharedZoomXRange = null;
                scheduleSharedZoomSync(gid, null, true);
                return;
            }
            let r0 = Number(evt["xaxis.range[0]"]);
            let r1 = Number(evt["xaxis.range[1]"]);
            if (!Number.isFinite(r0) || !Number.isFinite(r1)) {
                const rr = evt["xaxis.range"];
                if (Array.isArray(rr) && rr.length === 2) {
                    r0 = Number(rr[0]);
                    r1 = Number(rr[1]);
                } else {
                    return;
                }
            }
            if (!Number.isFinite(r0) || !Number.isFinite(r1) || r1 <= r0) return;
            const newRange = [r0, r1];
            if (rangesAlmostEqual(sharedZoomXRange, newRange)) return;
            sharedZoomXRange = newRange;
            scheduleSharedZoomSync(gid, sharedZoomXRange, false);
        });
    }

    function removeSeriesAssignmentFromLegend(varName) {
        if (!varName) return;
        if (isArrayElem(varName)) {
            delete arrayElemAssignment[varName];
            delete arrayElemHistory[varName];
        } else if (Object.prototype.hasOwnProperty.call(varGraphAssignment, varName)) {
            if (monitoredNames.has(varName)) varGraphAssignment[varName] = "";
            else delete varGraphAssignment[varName];
        }
        pruneEmptyGraphs();
        rebuildMonitorList();
        saveConfig();
        schedulePlotRender();
    }

    function attachLegendRemoveHandler(containerEl) {
        if (!containerEl || containerEl._varmonLegendHooked) return;
        containerEl._varmonLegendHooked = true;
        containerEl.on("plotly_legendclick", (evt) => {
            if (!evt) return false;
            const idx = Number(evt.curveNumber);
            const dataArr = evt.data || [];
            const trace = Number.isFinite(idx) ? dataArr[idx] : null;
            const varName = trace && trace.meta ? trace.meta.varName : null;
            if (varName) removeSeriesAssignmentFromLegend(varName);
            return false; // Evita toggle por defecto; click en leyenda = quitar serie.
        });
    }

    function attachOfflineClickSeekHandler(containerEl) {
        if (!containerEl || containerEl._varmonClickSeekHooked) return;
        containerEl._varmonClickSeekHooked = true;
        containerEl.on("plotly_click", (evt) => {
            if (!isPlaybackMode() || !offlineDataset || !evt || !Array.isArray(evt.points) || evt.points.length === 0) return;
            const p = evt.points[0];
            const x = Number(p && p.x);
            if (!Number.isFinite(x)) return;
            // En modo análisis las X ya están en tiempo real (segundos desde el
            // inicio de la grabación), así que no sumamos ningún origen extra.
            const absTs = x;
            applyOfflineTime(absTs);
            schedulePlotRender();
        });
    }

    function renderPlots() {
        const tRender0 = performance.now();
        const windowSec = parseInt(timeWindowSelect.value);
        const activeSlots = [];
        // Origen = mínimo timestamp real en los datos mostrados, para que al recortar el buffer
        // el eje X no salte (siempre 0 = borde izquierdo de lo que hay).
        let dataOrigin = null;
        let globalTMax = null;
        for (const gid of graphList) {
            const varsInGraph = getVarsForGraph(gid);
            for (const name of varsInGraph) {
                const isArrElem = name.includes("[") && name.endsWith("]");
                const hist = isArrElem ? arrayElemHistory[name] : historyCache[name];
                if (!hist || !hist.timestamps || hist.timestamps.length === 0) continue;
                const xs = hist.timestamps;
                const tMax = xs[xs.length - 1];
                const tMin = windowSec > 0 ? Math.max(xs[0], tMax - windowSec) : xs[0];
                if (dataOrigin === null || tMin < dataOrigin) dataOrigin = tMin;
                if (globalTMax === null || tMax > globalTMax) globalTMax = tMax;
            }
        }
        const win = windowSec > 0 ? windowSec : 60;
        let defaultXRange;
        let liveUseAutorange = false;
        if (isReplayMode() && offlineDataset) {
            const minTs = Number.isFinite(offlineRecordingGlobalMinTs) ? offlineRecordingGlobalMinTs : offlineDataset.minTs;
            const maxTs = Number.isFinite(offlineRecordingGlobalMaxTs) ? offlineRecordingGlobalMaxTs : offlineDataset.maxTs;
            const safeMin = Number.isFinite(minTs) ? minTs : 0;
            const safeMax = Number.isFinite(maxTs) ? maxTs : (safeMin + 0.1);
            defaultXRange = [safeMin, Math.max(safeMin + 0.1, safeMax)];
        } else if (isPlaybackMode()) {
            const endAbs = globalTMax != null ? globalTMax : (dataOrigin != null ? dataOrigin + win : win);
            const startAbs = (windowSec > 0 && dataOrigin != null)
                ? Math.max(dataOrigin, endAbs - win)
                : (dataOrigin != null ? dataOrigin : Math.max(0, endAbs - win));
            defaultXRange = [startAbs, Math.max(startAbs + 0.1, endAbs)];
        } else {
            // En live ventana deslizante: mostrar siempre los últimos 'win' segundos.
            // Si hay datos, [tMax - win, tMax]; si no, [0, win].
            if (globalTMax != null) {
                defaultXRange = [Math.max(0, globalTMax - win), Math.max(globalTMax, win)];
            } else {
                defaultXRange = [0, win];
            }
        }
        const sharedXRange = isReplayMode()
            ? defaultXRange
            : ((Array.isArray(sharedZoomXRange) && sharedZoomXRange.length === 2)
                ? sharedZoomXRange
                : defaultXRange);

        for (const gid of graphList) {
            const varsInGraph = getVarsForGraph(gid);
            const slotEl = document.getElementById("plotSlot_" + gid);
            const containerEl = document.getElementById("plotContainer_" + gid);
            if (!slotEl || !containerEl) continue;

            slotEl.style.display = "flex";
            activeSlots.push(gid);

            if (containerEl.querySelector(".plot-empty-inner")) {
                containerEl.innerHTML = "";
            }

            const gIdx = graphList.indexOf(gid);
            const traces = [];
            let yMin = Infinity;
            let yMax = -Infinity;
            const useVsRef = plotVsRef && isReplayMode() && offlineDataset && offlineDataset.samples && offlineDataset.samples.length > 0;

            function addTraceFromHist(hist, displayName, rawVarName, dash) {
                if (!hist || !hist.timestamps || hist.timestamps.length === 0) return;
                let xs = hist.timestamps.slice();
                let ys = hist.values.slice();
                const tMax = xs[xs.length - 1];
                if (windowSec > 0 && !isReplayMode()) {
                    const tMin = tMax - windowSec;
                    let lo = 0, hi = xs.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (xs[mid] < tMin) lo = mid + 1; else hi = mid;
                    }
                    if (lo > 0) {
                        xs = xs.slice(lo);
                        ys = ys.slice(lo);
                    }
                }
                const smoothWindow = Math.max(1, parseInt(document.getElementById("smoothPlotsSelect")?.value, 10) || 1);
                const ySmooth = smoothWindow > 1 ? movingAverage(ys, smoothWindow) : ys;
                const ds = downsampleSeries(xs, ySmooth, downsampleMaxPoints);
                for (let yi = 0; yi < ds.y.length; yi++) {
                    const yv = Number(ds.y[yi]);
                    if (!Number.isFinite(yv)) continue;
                    if (yv < yMin) yMin = yv;
                    if (yv > yMax) yMax = yv;
                }
                traces.push({
                    x: ds.x,
                    y: ds.y,
                    type: "scatter",
                    mode: "lines",
                    name: displayName,
                    meta: { varName: rawVarName || displayName },
                    line: {
                        color: getSeriesColor(rawVarName || displayName),
                        width: 1.5,
                        shape: smoothWindow > 1 ? "linear" : "hv",
                        dash: dash || null,
                    },
                });
            }

            varsInGraph.forEach((name, idx) => {
                const isArrElem = name.includes("[") && name.endsWith("]");
                const hist = isArrElem ? arrayElemHistory[name] : historyCache[name];

                if (useVsRef) {
                    const isImposed = impositionNames.has(name);
                    const refSeries = getRefSeriesFromOfflineDataset(name);
                    if (refSeries && !isImposed) {
                        addTraceFromHist(refSeries, name + "_ref", name, "dash");
                    }
                    if (hist && hist.timestamps && hist.timestamps.length > 0) {
                        addTraceFromHist(hist, name + " ✕", name, null);
                    } else {
                        if (isPlaybackMode()) fetchFullHistoryIfNeeded(name);
                    }
                } else {
                    if (!hist || !hist.timestamps || hist.timestamps.length === 0) {
                        if (isPlaybackMode()) fetchFullHistoryIfNeeded(name);
                        return;
                    }
                    addTraceFromHist(hist, `${name} ✕`, name, null);
                }
            });

            const alarmShapes = [];
            varsInGraph.forEach(name => {
                const a = alarms[name];
                if (!a) return;
                if (a.hi !== null) {
                    alarmShapes.push({
                        type: "line", xref: "paper", x0: 0, x1: 1,
                        yref: "y", y0: a.hi, y1: a.hi,
                        line: { color: "rgba(248,113,113,0.6)", width: 1.5, dash: "dash" },
                    });
                }
                if (a.lo !== null) {
                    alarmShapes.push({
                        type: "line", xref: "paper", x0: 0, x1: 1,
                        yref: "y", y0: a.lo, y1: a.lo,
                        line: { color: "rgba(251,191,36,0.6)", width: 1.5, dash: "dash" },
                    });
                }
            });
            // Cursor temporal offline: raya vertical común en todos los gráficos.
            // En modo análisis el eje X usa tiempo absoluto (mismo que offlinePlayback.currentTs).
            if (isPlaybackMode() && offlineDataset && Number.isFinite(offlinePlayback.currentTs)) {
                const xCursor = offlinePlayback.currentTs;
                alarmShapes.push({
                    type: "line",
                    xref: "x",
                    x0: xCursor,
                    x1: xCursor,
                    yref: "paper",
                    y0: 0,
                    y1: 1,
                    line: { color: "rgba(56,189,248,0.95)", width: 2, dash: "dot" },
                    layer: "above",
                });
                if (Number.isFinite(markerA)) {
                    alarmShapes.push({
                        type: "line",
                        xref: "x",
                        x0: markerA,
                        x1: markerA,
                        yref: "paper",
                        y0: 0,
                        y1: 1,
                        line: { color: "rgba(74,222,128,0.85)", width: 1.3, dash: "dash" },
                    });
                }
                if (Number.isFinite(markerB)) {
                    alarmShapes.push({
                        type: "line",
                        xref: "x",
                        x0: markerB,
                        x1: markerB,
                        yref: "paper",
                        y0: 0,
                        y1: 1,
                        line: { color: "rgba(248,113,113,0.9)", width: 1.3, dash: "dash" },
                    });
                }
                if (anomalyResults.length > 0) {
                    const maxMarks = 120;
                    for (let ai = 0; ai < anomalyResults.length && ai < maxMarks; ai++) {
                        alarmShapes.push({
                            type: "line",
                            xref: "x",
                            x0: anomalyResults[ai].ts,
                            x1: anomalyResults[ai].ts,
                            yref: "paper",
                            y0: 0,
                            y1: 1,
                            line: { color: "rgba(251,191,36,0.35)", width: 1, dash: "dot" },
                        });
                    }
                }
            }

            const cRect = containerEl.getBoundingClientRect();
            const colors = getPlotLayoutColors();
            let yAxisCfg = isReplayMode()
                ? { gridcolor: colors.gridcolor, zerolinecolor: colors.gridcolor, autorange: true, fixedrange: false }
                : { gridcolor: colors.gridcolor, zerolinecolor: colors.gridcolor };
            if (Number.isFinite(yMin) && Number.isFinite(yMax)) {
                const span = Math.max(1, yMax - yMin);
                const center = (yMax + yMin) / 2;
                const pad = span * 0.1;
                yAxisCfg = {
                    gridcolor: colors.gridcolor,
                    zerolinecolor: colors.gridcolor,
                    range: [center - (span / 2) - pad, center + (span / 2) + pad],
                    autorange: false,
                    fixedrange: false,
                };
            }
            const layout = {
                paper_bgcolor: colors.paper_bgcolor,
                plot_bgcolor: colors.plot_bgcolor,
                font: { color: colors.fontColor, family: "Segoe UI, system-ui, sans-serif", size: 10 },
                margin: { t: 8, r: 10, b: 28, l: 60 },
                dragmode: "zoom",
                width: Math.max(cRect.width, 200),
                height: Math.max(cRect.height, 80),
                hovermode: "x unified",
                xaxis: {
                    title: (I18N[currentLang] || I18N.es).timeAxisTitle,
                    ...(liveUseAutorange ? { autorange: true } : { range: sharedXRange, autorange: false }),
                    gridcolor: colors.gridcolor,
                    zerolinecolor: colors.gridcolor,
                },
                yaxis: yAxisCfg,
                shapes: alarmShapes,
                legend: {
                    bgcolor: colors.legendBg,
                    font: { size: 9 },
                    orientation: "h",
                    y: 1.05,
                    yanchor: "bottom",
                },
                showlegend: true,
            };

            const config = {
                responsive: false,
                displayModeBar: true,
                scrollZoom: true,
                modeBarButtonsToRemove: [
                    "select2d", "lasso2d", "toImage",
                    "sendDataToCloud", "toggleSpikelines",
                    "resetScale2d",
                ],
                displaylogo: false,
            };

            if (!plotInstances[gid]) {
                Plotly.newPlot(containerEl, traces, layout, config);
                plotInstances[gid] = true;
                attachSharedZoomHandler(containerEl, gid);
                attachLegendRemoveHandler(containerEl);
                attachOfflineClickSeekHandler(containerEl);
            } else {
                Plotly.react(containerEl, traces, layout, config);
                attachSharedZoomHandler(containerEl, gid);
                attachLegendRemoveHandler(containerEl);
                attachOfflineClickSeekHandler(containerEl);
            }
        }

        plotEmpty.style.display = graphList.length > 0 ? "none" : "flex";
        const elapsed = performance.now() - tRender0;
        const tracesCount = graphList.reduce((acc, gid) => acc + getVarsForGraph(gid).length, 0);
        let points = 0;
        for (const h of Object.values(historyCache)) points += (h && h.values ? h.values.length : 0);
        for (const h of Object.values(arrayElemHistory)) points += (h && h.values ? h.values.length : 0);
        renderStats.lastMs = elapsed;
        renderStats.avgMs = renderStats.avgMs <= 0 ? elapsed : (renderStats.avgMs * 0.85 + elapsed * 0.15);
        renderStats.traces = tracesCount;
        renderStats.points = points;
        const now = performance.now();
        if (renderStats.lastTick > 0) {
            const dt = (now - renderStats.lastTick) / 1000;
            if (dt > 0) renderStats.fps = 1 / dt;
        }
        renderStats.lastTick = now;
        renderStats.ticks += 1;
        if (adaptiveLoadEnabled) {
            const penalty = Math.min(180, Math.max(0, renderStats.avgMs * 1.25));
            nextAllowedRenderAt = performance.now() + penalty;
        } else {
            nextAllowedRenderAt = 0;
        }
        renderPerfTelemetry();

        // Tras F5 el primer render puede ser sin datos; forzar un segundo pintado cuando ya haya llegado algo.
        if (graphList.length > 0 && !window.__plotSecondPaintScheduled) {
            window.__plotSecondPaintScheduled = true;
            setTimeout(() => { schedulePlotRender(); }, 500);
        }
    }

    timeWindowSelect.addEventListener("change", () => {
        const v = parseInt(timeWindowSelect.value, 10);
        localHistMaxSec = (Number.isFinite(v) && v > 0) ? v : 60;
        if (isLiveMode()) trimLocalHistory();
        saveConfig();
        schedulePlotRender();
    });

    if (offlineFullLoadMaxMbInput) {
        offlineFullLoadMaxMbInput.addEventListener("change", () => {
            const v = Math.max(5, Math.floor(Number(offlineFullLoadMaxMbInput.value) || DEFAULT_OFFLINE_FULL_LOAD_MAX_MB));
            offlineFullLoadMaxMb = v;
            offlineFullLoadMaxMbInput.value = String(v);
            saveConfig();
        });
    }
    if (offlinePreviewMbInput) {
        offlinePreviewMbInput.addEventListener("change", () => {
            const v = Math.max(1, Math.min(8, Math.floor(Number(offlinePreviewMbInput.value) || DEFAULT_OFFLINE_PREVIEW_MB)));
            offlinePreviewMb = v;
            offlinePreviewMbInput.value = String(v);
            saveConfig();
        });
    }
    if (offlinePreviewRowsInput) {
        offlinePreviewRowsInput.addEventListener("change", () => {
            const v = Math.max(500, Math.floor(Number(offlinePreviewRowsInput.value) || DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_ROWS));
            offlineSafePreviewMaxRows = v;
            offlinePreviewRowsInput.value = String(v);
            saveConfig();
        });
    }
    if (offlinePreviewSpanSecInput) {
        offlinePreviewSpanSecInput.addEventListener("change", () => {
            const v = Math.max(5, Math.floor(Number(offlinePreviewSpanSecInput.value) || DEFAULT_OFFLINE_SAFE_PREVIEW_MAX_SPAN_SEC));
            offlineSafePreviewMaxSpanSec = v;
            offlinePreviewSpanSecInput.value = String(v);
            saveConfig();
        });
    }
    if (offlineAllowForceFullLoadCheckbox) {
        offlineAllowForceFullLoadCheckbox.addEventListener("change", () => {
            offlineAllowForceFullLoad = !!offlineAllowForceFullLoadCheckbox.checked;
            saveConfig();
        });
    }

    function markReconnectPending() {
        if (!reconnectBtn.classList.contains("btn-pending")) {
            reconnectBtn.classList.add("btn-pending");
        }
    }

    function clearReconnectPending() {
        reconnectBtn.classList.remove("btn-pending");
    }

    portSelect.addEventListener("change", () => { markReconnectPending(); updateMultiInstanceWarning(); });

    const multiInstanceWarningCloseBtn = document.getElementById("multiInstanceWarningClose");
    if (multiInstanceWarningCloseBtn) {
        multiInstanceWarningCloseBtn.addEventListener("click", hideMultiInstanceWarning);
    }

    reconnectBtn.addEventListener("click", async () => {
        if (ws) {
            try { ws.close(); } catch (e) { /* ignore */ }
            ws = null;
        }
        try {
            const [connResp, udsResp] = await Promise.all([
                fetch("/api/connection_info").then((r) => r.ok ? r.json() : null),
                fetch("/api/uds_instances").then((r) => r.ok ? r.json() : null)
            ]);
            if (connResp) connectionInfo = connResp;
            udsInstances = (udsResp && Array.isArray(udsResp.instances)) ? udsResp.instances : [];
            if (udsInstances.length > 0) {
                fillPortSelectWithUds();
                updateMultiInstanceWarning();
                resetStateForNewTarget();
                connect();
            } else {
                resetStateForNewTarget();
                statusEl.textContent = (I18N[currentLang] || I18N.es).statusNoInstances || "No hay instancias VarMonitor (UDS)";
                statusEl.className = "status disconnected";
            }
        } catch (e) { resetStateForNewTarget(); }
    });

    if (hideLevelsInput) {
        hideLevelsInput.addEventListener("change", () => {
            const v = parseInt(hideLevelsInput.value || "0", 10);
            hideLevels = isNaN(v) ? 0 : Math.max(0, Math.min(8, v));
            hideLevelsInput.value = String(hideLevels);
            rebuildMonitorList();
            saveConfig();
        });
    }

    function formatNameWithHiddenLevels(name, levels) {
        const lvl = Math.max(0, Math.min(8, levels | 0));
        if (lvl <= 0) return name;
        const parts = name.split(".");
        if (parts.length <= 1) return name;
        const lastIdx = parts.length - 1;
        const toHide = Math.min(lvl, lastIdx);
        for (let i = 0; i < toHide; i++) {
            const p = parts[i];
            if (p.length > 0) parts[i] = p[0];
        }
        return parts.join(".");
    }

    function resetStateForNewTarget() {
        clearUserLayout();
        clearDataBuffers();
        offlineDataset = null;
        offlineRecordingName = "";
        markerA = null;
        markerB = null;
        updateOfflineDatasetStatus();
        updateMarkerInfoLabel();
        stopOfflinePlayback();

        // Parar grabacion si estaba activa
        isRecording = false;
        isRecordingStopping = false;
        pendingRecordingRestart = false;
        recordBuffer = [];
        recordColumns = [];
        recordSizeBytes = 0;
        recordStartTime = null;
        if (recordTimerInterval) {
            clearInterval(recordTimerInterval);
            recordTimerInterval = null;
        }
        recordBtn.disabled = false;
        recordTimerEl.style.display = "none";
        recordBtn.classList.remove("btn-record-active");
    }

    // --- Drag & drop: Columna 2 como zona de drop desde Columna 1 ---

    monitorListEl.addEventListener("dragover", (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        const isReorder = e.dataTransfer.types.includes("application/x-monitor-reorder");
        if (isReorder) {
            e.dataTransfer.dropEffect = "move";
            monitorListEl.classList.remove("mon-drop-over");
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const wrap = under && under.closest ? under.closest(".monitor-item-wrap") : null;
            monitorListEl.querySelectorAll(".monitor-item-wrap").forEach(w => {
                w.classList.remove("monitor-drop-before", "monitor-drop-after");
                delete w.dataset.dropPosition;
            });
            if (wrap) {
                const rect = wrap.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                const before = e.clientY < mid;
                wrap.classList.add(before ? "monitor-drop-before" : "monitor-drop-after");
                wrap.dataset.dropPosition = before ? "before" : "after";
            }
        } else {
            e.dataTransfer.dropEffect = "copy";
            monitorListEl.classList.add("mon-drop-over");
        }
    });

    monitorListEl.addEventListener("dragleave", (e) => {
        if (!monitorListEl.contains(e.relatedTarget)) {
            monitorListEl.classList.remove("mon-drop-over");
            monitorListEl.querySelectorAll(".monitor-item-wrap").forEach(w => {
                w.classList.remove("monitor-drop-before", "monitor-drop-after");
                delete w.dataset.dropPosition;
            });
        }
    });

    function addDroppedVarToMonitorByName(nameRaw) {
        const name = String(nameRaw || "").trim();
        if (!name) return false;
        if (!knownVarNames.includes(name)) return false;
        if (!monitoredNames.has(name)) {
            ensureArincBaseMonitored(name);
            ensureMonitoredName(name);
            sendMonitored();
        }
        browserSelection.delete(name);
        saveConfig();
        rebuildMonitorList();
        if (isPlaybackMode() && offlineDataset) {
            const tNow = Number.isFinite(offlinePlayback.currentTs) ? offlinePlayback.currentTs : offlineDataset.minTs;
            applyOfflineTime(tNow);
        }
        updateMonitorValues();
        renderBrowserList();
        return true;
    }

    monitorListEl.addEventListener("drop", (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        monitorListEl.classList.remove("mon-drop-over");
        monitorListEl.querySelectorAll(".monitor-item-wrap").forEach(w => {
            w.classList.remove("monitor-drop-before", "monitor-drop-after");
            delete w.dataset.dropPosition;
        });

        const reorderName = e.dataTransfer.getData("application/x-monitor-reorder");
        if (reorderName) {
            const wrap = e.target.closest ? e.target.closest(".monitor-item-wrap") : null;
            const targetName = wrap ? wrap.dataset.name : null;
            const pos = wrap ? (wrap.dataset.dropPosition || "after") : "after";
            const fromIdx = monitoredOrder.indexOf(reorderName);
            if (fromIdx === -1) return;
            let toIdx = targetName ? monitoredOrder.indexOf(targetName) : monitoredOrder.length;
            if (toIdx === -1) toIdx = monitoredOrder.length;
            if (pos === "after") toIdx += 1;
            if (toIdx > fromIdx) toIdx -= 1;
            if (fromIdx === toIdx) return;
            monitoredOrder.splice(fromIdx, 1);
            monitoredOrder.splice(toIdx, 0, reorderName);
            const draggedWrap = monitorListEl.querySelector(`.monitor-item-wrap[data-name="${CSS.escape(reorderName)}"]`);
            if (draggedWrap && wrap && draggedWrap !== wrap) {
                if (pos === "before") {
                    monitorListEl.insertBefore(draggedWrap, wrap);
                } else {
                    if (wrap.nextSibling) monitorListEl.insertBefore(draggedWrap, wrap.nextSibling);
                    else monitorListEl.appendChild(draggedWrap);
                }
            } else if (draggedWrap && !wrap) {
                monitorListEl.appendChild(draggedWrap);
            }
            saveConfig();
            return;
        }

        addDroppedVarToMonitorByName(
            e.dataTransfer.getData("application/x-var-name") ||
            e.dataTransfer.getData("text/plain")
        );
    });

    if (colMonitorEl) {
        colMonitorEl.addEventListener("dragover", (e) => {
            if (!e.dataTransfer) return;
            const isReorder = e.dataTransfer.types.includes("application/x-monitor-reorder");
            if (isReorder) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            monitorListEl.classList.add("mon-drop-over");
        });
        colMonitorEl.addEventListener("dragleave", (e) => {
            if (!colMonitorEl.contains(e.relatedTarget)) {
                monitorListEl.classList.remove("mon-drop-over");
            }
        });
        colMonitorEl.addEventListener("drop", (e) => {
            if (!e.dataTransfer) return;
            const isReorder = e.dataTransfer.types.includes("application/x-monitor-reorder");
            if (isReorder) return;
            e.preventDefault();
            monitorListEl.classList.remove("mon-drop-over");
            addDroppedVarToMonitorByName(
                e.dataTransfer.getData("application/x-var-name") ||
                e.dataTransfer.getData("text/plain")
            );
        });
    }

    async function initialScanAndConnect() {
        if (isOfflineMode()) {
            setOfflineStatus();
            await refreshServerRecordings();
            return;
        }
        if (isReplayMode()) {
            await refreshServerRecordings();
            setOfflineStatus();
        }
        if (udsInstances.length > 0) {
            fillPortSelectWithUds();
            updateMultiInstanceWarning();
            connect();
            return;
        }
        statusEl.textContent = (I18N[currentLang] || I18N.es).statusNoInstances || "No hay instancias VarMonitor (UDS)";
        statusEl.className = "status disconnected";
    }

    // --- Data handlers ---

    function onVarNames(names) {
        if (!Array.isArray(names)) return;
        // Evitar vaciados transitorios: si llega [] pero ya teníamos catálogo, no borrar UI.
        if (names.length === 0 && baseKnownVarNames.length > 0 && (isLiveMode() || isReplayMode())) {
            return;
        }
        // En replay con TSV cargado: unir siempre con las del archivo para no perder unas u otras.
        if (isReplayMode() && offlineDataset && Array.isArray(offlineDataset.names) && offlineDataset.names.length > 0) {
            names = [...new Set([...names, ...offlineDataset.names])].sort();
        }
        const sorted = names.slice().sort();
        const key = sorted.join(",");
        const oldKey = baseKnownVarNames.join(",");

        varCountEl.textContent = `${sorted.length} vars`;

        if (key !== oldKey) {
            baseKnownVarNames = sorted;
            rebuildKnownVarNamesWithDerived();
            browserListDirty = true;
            renderBrowserList();
            if (varDrawer && varDrawer.style.display === "flex") positionVarDrawer();
        } else {
            const prev = knownVarNames.join(",");
            rebuildKnownVarNamesWithDerived();
            const now = knownVarNames.join(",");
            if (prev !== now) {
                browserListDirty = true;
                renderBrowserList();
                if (varDrawer && varDrawer.style.display === "flex") positionVarDrawer();
            }
        }
    }

    function onVarsUpdate(data, opts = {}) {
        if (!Array.isArray(data)) return;
        const appendHistory = opts.appendHistory !== false;
        const forcedTs = (typeof opts.timestamp === "number" && Number.isFinite(opts.timestamp)) ? opts.timestamp : null;
        const isOfflineSnapshot = forcedTs != null && opts.appendHistory === false;
        const changedNames = new Set();
        const accepted = [];

        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            if (!item || !item.name) continue;
            // En replay, si una variable del TSV está impuesta, ignorar cualquier valor entrante de SHM.
            if (isReplayMode() && !isOfflineSnapshot && impositionNames.has(item.name) && isVarInTsv(item.name)) {
                continue;
            }
            accepted.push(item);
            varsByName[item.name] = item;
            changedNames.add(item.name);
        }
        if (accepted.length === 0) return;

        if (computedVars.length > 0) evalComputedVars();
        const nowTs = forcedTs != null
            ? forcedTs
            : (isReplayMode() ? getReplayCurrentTs() : (Date.now() / 1000));
        // En modo live usamos tiempo relativo desde el inicio de sesión para los
        // historiales de las gráficas, así evitamos timestamps absolutos enormes.
        if (isLiveMode()) {
            if (sessionStartTime == null) sessionStartTime = nowTs;
        }
        const tsForHistBase = (isLiveMode() && sessionStartTime != null)
            ? (nowTs - sessionStartTime)
            : nowTs;
        changedNames.forEach((baseName) => {
            if (!isArincEnabled(baseName)) return;
            if (isArincDerivedName(baseName)) return;
            if (isReplayMode() && isVarInTsv(baseName) && impositionNames.has(baseName)) return;
            const vd = varsByName[baseName];
            if (!vd || Array.isArray(vd.value)) return;
            const num = typeof vd.value === "number" ? vd.value : Number(vd.value);
            if (!Number.isFinite(num)) return;
            let ts = (vd.timestamp && Number.isFinite(vd.timestamp)) ? vd.timestamp : nowTs;
            if (isLiveMode() && sessionStartTime != null) {
                ts = ts - sessionStartTime;
            }
            pushArincDerivedSample(baseName, ts, num, appendHistory);
        });
        const hadArrayElems = trackArrayElementHistories(appendHistory);

        // Acumular buffer para gráficos desde el poll de monitorización (solo escalares; arrays en arrayElemHistory, computed en evalComputedVars).
        if (appendHistory) {
            const now = tsForHistBase;
            for (let i = 0; i < accepted.length; i++) {
                const v = accepted[i];
                if (isComputed(v.name)) continue;
                if (isArincDerivedName(v.name)) continue;
                if (Array.isArray(v.value)) continue;
                // En replay, solo bloqueamos histórico SHM para variables TSV impuestas.
                if (isReplayMode() && isVarInTsv(v.name) && impositionNames.has(v.name)) continue;
                const num = typeof v.value === "number" ? v.value : (v.value === true ? 1 : v.value === false ? 0 : Number(v.value));
                if (!isFinite(num)) continue;
                if (!historyCache[v.name]) historyCache[v.name] = { timestamps: [], values: [] };
                historyCache[v.name].timestamps.push(now);
                historyCache[v.name].values.push(num);
            }
            if (!isReplayMode()) trimLocalHistory();
        }
        if (isLocalRecording && isLiveMode()) {
            localRecordSamples.push(buildLocalFrontendSample(nowTs));
            if (localRecordSamples.length > 120000) localRecordSamples = localRecordSamples.slice(-120000);
        }
        schedulePlotRender();

        updateMonitorValues();
        evaluateLocalAlarmsNow();
        renderArincBusHealth();
    }

    // --- Resize ---
    let resizeTimer = null;
    const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            for (const gid of graphList) {
                if (!plotInstances[gid]) continue;
                const el = document.getElementById("plotContainer_" + gid);
                if (!el) continue;
                const rect = el.getBoundingClientRect();
                Plotly.relayout(el, {
                    width: Math.max(rect.width, 200),
                    height: Math.max(rect.height, 80),
                });
            }
        }, 100);
    });
    resizeObserver.observe(plotArea);

    rebuildPlotArea();

    if (monitoredNames.size > 0) {
        rebuildMonitorList();
    }

    // --- Keyboard shortcuts ---
    document.addEventListener("keydown", (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        const isInput = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
        if (isInput && e.key !== "Escape" && !(e.ctrlKey || e.metaKey)) return;

        if (e.key === "Escape") {
            if (helpOverlay.style.display === "flex") { helpOverlay.style.display = "none"; return; }
            if (docsLangOverlay && docsLangOverlay.style.display === "flex") {
                closeDocsLangModal();
                return;
            }
            dismissAlarmBanner();
            return;
        }
        if (e.key === " ") {
            e.preventDefault();
            plotsPaused = !plotsPaused;
            updatePauseBtn();
            if (!plotsPaused) schedulePlotRender();
            return;
        }
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) {
            e.preventDefault();
            doLayoutUndo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) {
            e.preventDefault();
            doLayoutRedo();
            return;
        }
        if (k === "r" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            recordBtn.click();
            return;
        }
        if (k === "s" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            screenshotBtn.click();
            return;
        }
        if (k === "h" || k === "?") {
            e.preventDefault();
            helpOverlay.style.display = helpOverlay.style.display === "flex" ? "none" : "flex";
            return;
        }
    });

    async function checkAuthThenStart() {
        // En modo análisis puro (offline) no se abre WS.
        // En replay sí necesitamos WS para el modo híbrido (variables SHM/C++).
        if (isOfflineMode()) {
            await refreshServerRecordings();
            setOfflineStatus();
            return;
        }
        try {
            const r = await fetch("/api/auth_required");
            const d = await r.json();
            if (d.auth_required && !sessionStorage.getItem("varmon_password")) {
                showAuthModal();
                return;
            }
        } catch (e) { /* ignorar */ }
        await fetchConnectionInfo();
        initialScanAndConnect();
    }

    if (authSubmitBtn && authPasswordInput) {
        authSubmitBtn.addEventListener("click", () => {
            const p = authPasswordInput.value.trim();
            if (!p) return;
            sessionStorage.setItem("varmon_password", p);
            hideAuthModal();
            initialScanAndConnect();
        });
        authPasswordInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") authSubmitBtn.click();
        });
    }

    checkAuthThenStart();
})();
