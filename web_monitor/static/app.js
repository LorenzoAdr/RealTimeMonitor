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
    const MAX_GRAPHS = 8;

    let ws = null;
    let varsByName = {};
    let knownVarNames = [];
    let monitoredNames = new Set();
    let varGraphAssignment = {};
    let historyCache = {};
    let graphList = [];
    let plotInstances = {};

    let arrayElemAssignment = {};
    let arrayElemHistory = {};
    const ARRAY_HIST_MAX = 2000;

    let historyTimer = null;
    const HISTORY_INTERVAL_MS = 500;
    let plotRafPending = false;
    let lastSeq = 0;
    let localHistMaxSec = 30;

    const MAX_RECORD_SEC = 300;
    let isRecording = false;
    let recordBuffer = [];
    let recordColumns = [];
    let recordStartTime = null;
    let recordTimerInterval = null;

    const statusEl = document.getElementById("connectionStatus");
    const varCountEl = document.getElementById("varCount");
    const intervalInput = document.getElementById("intervalInput");
    const hostInput = document.getElementById("hostInput");
    const portInput = document.getElementById("portInput");
    const portSelect = document.getElementById("portSelect");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const varFilter = document.getElementById("varFilter");
    const varBrowserList = document.getElementById("varBrowserList");
    const addToMonitorBtn = document.getElementById("addToMonitor");
    const selectAllBtn = document.getElementById("selectAll");
    const selectNoneBtn = document.getElementById("selectNone");
    const refreshNamesBtn = document.getElementById("refreshNames");
    const removeSelectedBtn = document.getElementById("removeSelected");
    const monitorListEl = document.getElementById("monitorList");
    const timeWindowSelect = document.getElementById("timeWindow");
    const historyBufferSelect = document.getElementById("historyBuffer");
    const plotEmpty = document.getElementById("plotEmpty");
    const plotArea = document.getElementById("plotArea");
    const recordBtn = document.getElementById("recordBtn");
    const recordTimerEl = document.getElementById("recordTimer");
    const screenshotBtn = document.getElementById("screenshotBtn");
    const pauseBtn = document.getElementById("pauseBtn");
    const resetConfigBtn = document.getElementById("resetConfigBtn");
    const hideLevelsInput = document.getElementById("hideLevelsInput");

    let browserSelection = new Set();
    let browserListDirty = true;
    let plotsPaused = false;
    let alarms = {};
    let activeAlarms = new Set();
    let prevAlarmState = {};
    let hideLevels = 0;
    let lastAutoTsvTime = 0;
    const AUTO_TSV_COOLDOWN_MS = 10000;
    const AUTO_TSV_HISTORY_SEC = 10;
    const AUTO_TSV_DELAY_MS = 1000;
    let expandedStats = new Set();
    let activeGenerators = {};
    const GEN_RATE_MS = 50;
    let computedVars = [];
    let computedHistories = {};
    const COMPUTED_MAX_HISTORY = 1000;
    let varFormat = {};  // { name: { ori: "dec", sal: "dec" } }

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

        const intervalId = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const t = (Date.now() - startTime) / 1000;
            const val = computeGenValue(type, params, t);

            if (arrElem) {
                ws.send(JSON.stringify({
                    action: "set_array_element",
                    name: arrName,
                    index: arrIdx,
                    value: val,
                }));
            } else {
                ws.send(JSON.stringify({
                    action: "set_var",
                    name: name,
                    value: val,
                    var_type: varType,
                }));
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
        return true;
    }

    function removeComputedVar(name) {
        computedVars = computedVars.filter(c => c.name !== name);
        delete computedHistories[name];
        delete varsByName[name];
        delete historyCache[name];
        monitoredNames.delete(name);
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

    // --- Config persistence (localStorage) ---

    const STORAGE_KEY = "varmon_config";

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                monitored: Array.from(monitoredNames),
                graphs: varGraphAssignment,
                graphList: graphList,
                timeWindow: timeWindowSelect.value,
                historyBuffer: historyBufferSelect.value,
                host: hostInput.value,
                port: portInput.value || portSelect.value,
                hideLevels: hideLevels,
                interval: intervalInput.value,
                alarms: alarms,
                computedVars: computedVars.map(c => ({ name: c.name, expr: c.expr })),
                varFormat: varFormat,
                arrayElemAssignment: arrayElemAssignment,
            }));
        } catch (e) { /* quota exceeded or private mode */ }
    }

    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const cfg = JSON.parse(raw);
            if (Array.isArray(cfg.monitored)) {
                cfg.monitored.forEach(n => monitoredNames.add(n));
            }
            if (cfg.graphs && typeof cfg.graphs === "object") {
                varGraphAssignment = cfg.graphs;
            }
            if (Array.isArray(cfg.graphList)) {
                graphList = cfg.graphList;
            }
            if (cfg.timeWindow) timeWindowSelect.value = cfg.timeWindow;
            if (cfg.historyBuffer) {
                historyBufferSelect.value = cfg.historyBuffer;
                localHistMaxSec = parseInt(cfg.historyBuffer) || 30;
            }
            if (typeof cfg.hideLevels === "number") {
                hideLevels = cfg.hideLevels;
                if (hideLevelsInput) hideLevelsInput.value = String(hideLevels);
            }
            if (cfg.host) hostInput.value = cfg.host;
            if (cfg.port) {
                portInput.value = cfg.port;
                portSelect.value = cfg.port;
            }
            if (cfg.interval) intervalInput.value = cfg.interval;
            if (cfg.alarms && typeof cfg.alarms === "object") alarms = cfg.alarms;
            if (Array.isArray(cfg.computedVars)) {
                for (const cv of cfg.computedVars) {
                    if (cv.name && cv.expr) addComputedVar(cv.name, cv.expr);
                }
            }
            if (cfg.varFormat && typeof cfg.varFormat === "object") varFormat = cfg.varFormat;
            if (cfg.arrayElemAssignment && typeof cfg.arrayElemAssignment === "object") arrayElemAssignment = cfg.arrayElemAssignment;
        } catch (e) { /* corrupt data */ }
    }

    function resetConfig() {
        localStorage.removeItem(STORAGE_KEY);
        monitoredNames.clear();
        varGraphAssignment = {};
        historyCache = {};
        lastSeq = 0;
        graphList = [];
        alarms = {};
        activeAlarms.clear();
        computedVars = [];
        computedHistories = {};
        varFormat = {};
        arrayElemAssignment = {};
        arrayElemHistory = {};
        sendMonitored();
        renderBrowserList();
        rebuildPlotArea();
        rebuildMonitorList();
        renderPlots();
    }

    loadConfig();

    resetConfigBtn.addEventListener("click", resetConfig);

    // --- Help modal ---
    const helpOverlay = document.getElementById("helpOverlay");
    document.getElementById("helpBtn").addEventListener("click", () => {
        helpOverlay.style.display = "flex";
    });
    document.getElementById("helpCloseBtn").addEventListener("click", () => {
        helpOverlay.style.display = "none";
    });
    helpOverlay.addEventListener("click", (e) => {
        if (e.target === helpOverlay) helpOverlay.style.display = "none";
    });

    // --- Export / Import config to file ---

    function exportConfigToFile() {
        const cfg = {
            monitored: Array.from(monitoredNames),
            graphs: varGraphAssignment,
            graphList: graphList,
            timeWindow: timeWindowSelect.value,
            historyBuffer: historyBufferSelect.value,
            host: hostInput.value,
                port: portInput.value || portSelect.value,
            hideLevels: hideLevels,
            interval: intervalInput.value,
            alarms: alarms,
            computedVars: computedVars.map(c => ({ name: c.name, expr: c.expr })),
            varFormat: varFormat,
        };
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
            reader.onload = () => {
                try {
                    const cfg = JSON.parse(reader.result);
                    monitoredNames.clear();
                    if (Array.isArray(cfg.monitored)) {
                        cfg.monitored.forEach(n => monitoredNames.add(n));
                    }
                    if (cfg.graphs && typeof cfg.graphs === "object") {
                        varGraphAssignment = cfg.graphs;
                    }
                    if (Array.isArray(cfg.graphList)) {
                        graphList = cfg.graphList;
                    }
                    if (cfg.timeWindow) timeWindowSelect.value = cfg.timeWindow;
                    if (cfg.historyBuffer) {
                        historyBufferSelect.value = cfg.historyBuffer;
                        localHistMaxSec = parseInt(cfg.historyBuffer) || 30;
                    }
                    if (typeof cfg.hideLevels === "number") {
                        hideLevels = cfg.hideLevels;
                        if (hideLevelsInput) hideLevelsInput.value = String(hideLevels);
                    }
                    if (cfg.host) hostInput.value = cfg.host;
                    if (cfg.port) {
                        portInput.value = cfg.port;
                        portSelect.value = cfg.port;
                    }
                    if (cfg.interval) intervalInput.value = cfg.interval;
                    if (cfg.alarms && typeof cfg.alarms === "object") {
                        alarms = cfg.alarms;
                    }
                    computedVars = [];
                    computedHistories = {};
                    if (Array.isArray(cfg.computedVars)) {
                        for (const cv of cfg.computedVars) {
                            if (cv.name && cv.expr) addComputedVar(cv.name, cv.expr);
                        }
                    }
                    if (cfg.varFormat && typeof cfg.varFormat === "object") varFormat = cfg.varFormat;
                    if (cfg.arrayElemAssignment && typeof cfg.arrayElemAssignment === "object") arrayElemAssignment = cfg.arrayElemAssignment;
                    saveConfig();
                    sendMonitored();
                    sendInterval();
                    rebuildPlotArea();
                    rebuildMonitorList();
                    renderBrowserList();
                    renderPlots();
                } catch (e) {
                    console.error("Error al importar config:", e);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    }

    document.getElementById("exportConfigBtn").addEventListener("click", exportConfigToFile);
    document.getElementById("importConfigBtn").addEventListener("click", importConfigFromFile);

    // --- Pause/Play ---

    function updatePauseBtn() {
        pauseBtn.textContent = plotsPaused ? "\u25B6 Play" : "\u23F8 Pause";
        pauseBtn.classList.toggle("paused", plotsPaused);
    }
    pauseBtn.addEventListener("click", () => {
        plotsPaused = !plotsPaused;
        updatePauseBtn();
        if (!plotsPaused) schedulePlotRender();
    });
    updatePauseBtn();

    // --- WebSocket ---

    function connect() {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const host = hostInput.value || location.hostname;
        const port = (portInput.value || portSelect.value || "").trim();
        const qs = new URLSearchParams();
        if (host) qs.set("host", host);
        if (port) qs.set("port", port);
        const qp = qs.toString();
        const url = qp ? `${proto}//${location.host}/ws?${qp}` : `${proto}//${location.host}/ws`;
        ws = new WebSocket(url);
        ws.onopen = () => {
            statusEl.textContent = "Conectado";
            statusEl.className = "status connected";
            clearReconnectPending();
            sendInterval();
            sendMonitored();
            startHistoryPolling();
        };
        ws.onclose = () => {
            statusEl.textContent = "Desconectado";
            statusEl.className = "status disconnected";
            stopHistoryPolling();
            lastSeq = 0;
            ws = null;
        };
        ws.onerror = () => ws.close();
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === "vars_names") onVarNames(msg.data);
            else if (msg.type === "vars_update") onVarsUpdate(msg.data);
            else if (msg.type === "history") onHistoryData(msg.data);
            else if (msg.type === "histories") onHistoriesData(msg.data, msg.seq);
            else if (msg.type === "set_result") onSetResult(msg);
        };
    }

    function sendInterval() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                action: "set_interval",
                value: parseInt(intervalInput.value) / 1000,
            }));
        }
    }

    intervalInput.addEventListener("change", () => { sendInterval(); saveConfig(); });

    function sendMonitored() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            const realNames = Array.from(monitoredNames).filter(n => !isComputed(n));
            ws.send(JSON.stringify({
                action: "set_monitored",
                names: realNames,
            }));
        }
    }

    function sendRefreshNames() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "refresh_names" }));
        }
    }

    refreshNamesBtn.addEventListener("click", sendRefreshNames);

    function isArrayVar(name) {
        const vd = varsByName[name];
        return vd && vd.type === "array";
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
        if (sal === "sci") return v.toExponential(4);
        if (sal === "hex") return "0x" + (Math.round(v) >>> 0).toString(16).toUpperCase();
        if (sal === "bin") return "0b" + (Math.round(v) >>> 0).toString(2);
        return v.toFixed(4);
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

    function startHistoryPolling() {
        stopHistoryPolling();
        historyTimer = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const names = new Set();
            for (const gid of graphList) {
                getVarsForGraph(gid).forEach(name => {
                    if (!isComputed(name) && !isArrayVar(name) && !isArrayElem(name)) names.add(name);
                });
            }
            for (const name of expandedStats) {
                if (!isComputed(name) && !isArrayVar(name)) names.add(name);
            }
            if (names.size > 0) {
                ws.send(JSON.stringify({
                    action: "get_histories",
                    names: Array.from(names),
                    since_seq: lastSeq,
                }));
            }
        }, HISTORY_INTERVAL_MS);
    }

    function stopHistoryPolling() {
        if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
    }

    // --- Column 1: Variable browser (tree view) ---

    let collapsedGroups = new Set();
    let treeInitialized = false;

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
        const filter = varFilter.value.toLowerCase();
        const filtered = knownVarNames.filter(n => !filter || n.toLowerCase().includes(filter));
        const tree = buildTree(filtered);

        if (!treeInitialized && knownVarNames.length > 0) {
            treeInitialized = true;
            const paths = [];
            collectGroupPaths(tree, "", paths);
            paths.forEach(p => collapsedGroups.add(p));
        }

        const frag = document.createDocumentFragment();
        renderTreeNode(frag, tree, "", 0);

        varBrowserList.innerHTML = "";
        varBrowserList.appendChild(frag);
        browserListDirty = false;
    }

    function renderTreeNode(parent, node, prefix, depth) {
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
            const leafName = name.split(".").pop();

            const el = document.createElement("div");
            el.className = "var-list-item" +
                (selected ? " selected" : "") +
                (inMonitor ? " in-monitor" : "");
            el.style.paddingLeft = (depth * 16 + 8) + "px";

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = selected;
            cb.disabled = inMonitor;

            const label = document.createElement("span");
            label.className = "tree-leaf-name";
            label.textContent = leafName;
            label.title = name;

            el.appendChild(cb);
            el.appendChild(label);

            if (varsByName[name] && varsByName[name].type === "array") {
                const arrBdg = document.createElement("span");
                arrBdg.className = "array-badge-browser";
                const vv = varsByName[name].value;
                arrBdg.textContent = Array.isArray(vv) ? "[" + vv.length + "]" : "[ ]";
                el.appendChild(arrBdg);
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

    document.getElementById("collapseAll").addEventListener("click", collapseAll);
    document.getElementById("expandAll").addEventListener("click", expandAll);

    selectAllBtn.addEventListener("click", () => {
        const filter = varFilter.value.toLowerCase();
        knownVarNames.forEach(name => {
            if (!monitoredNames.has(name) && (!filter || name.toLowerCase().includes(filter)))
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
            monitoredNames.add(name);
            if (!(name in varGraphAssignment)) varGraphAssignment[name] = "";
        });
        browserSelection.clear();
        sendMonitored();
        saveConfig();
        renderBrowserList();
        rebuildMonitorList();
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

    function rebuildMonitorList() {
        const existing = monitorListEl.querySelectorAll(".monitor-item-wrap");
        const existingMap = {};
        existing.forEach(el => { existingMap[el.dataset.name] = el; });

        const optionsHtml = buildGraphSelectOptions();

        function attachGraphSelectHandler(sel, varName) {
            const handler = () => {
                if (sel.value === "__new__") {
                    addGraph();
                    const newGid = graphList[graphList.length - 1];
                    varGraphAssignment[varName] = newGid;
                    rebuildMonitorList();
                } else {
                    varGraphAssignment[varName] = sel.value;
                    pruneEmptyGraphs();
                }
                updateSelectStyle(sel);
                updateMonitorItemStyles();
                saveConfig();
                schedulePlotRender();
            };
            sel._graphHandler && sel.removeEventListener("change", sel._graphHandler);
            sel._graphHandler = handler;
            sel.addEventListener("change", handler);
        }

        for (const name of monitoredNames) {
            if (existingMap[name]) {
                const sel = existingMap[name].querySelector(".graph-select");
                if (sel && isArrayVar(name)) {
                    sel.remove();
                } else if (sel) {
                    sel.innerHTML = optionsHtml;
                    const assigned = varGraphAssignment[name] || "";
                    if (assigned && graphList.includes(assigned)) {
                        sel.value = assigned;
                    } else {
                        sel.selectedIndex = 0;
                        varGraphAssignment[name] = "";
                    }
                    updateSelectStyle(sel);
                    attachGraphSelectHandler(sel, name);
                }
                // Actualizar el nombre mostrado segun hideLevels
                const nameSpan = existingMap[name].querySelector(".mon-name");
                if (nameSpan) {
                    nameSpan.textContent = formatNameWithHiddenLevels(name, hideLevels);
                }
                delete existingMap[name];
                continue;
            }

            const wrap = document.createElement("div");
            wrap.className = "monitor-item-wrap";
            wrap.dataset.name = name;

            const el = document.createElement("div");
            el.className = "monitor-item";
            el.dataset.name = name;

            let sel = null;
            if (!isArrayVar(name)) {
                sel = document.createElement("select");
                sel.className = "graph-select";
                sel.innerHTML = optionsHtml;
                sel.value = varGraphAssignment[name] || "";
                updateSelectStyle(sel);
                attachGraphSelectHandler(sel, name);
            }

            const nameEl = document.createElement("span");
            nameEl.className = "mon-name";
            nameEl.textContent = formatNameWithHiddenLevels(name, hideLevels);
            nameEl.addEventListener("click", () => {
                if (expandedStats.has(name)) expandedStats.delete(name);
                else expandedStats.add(name);
                updateStatsPanel(wrap, name);
            });

            let valEl = null;
            if (!isArrayVar(name)) {
                valEl = document.createElement("span");
                valEl.className = "mon-value";
                valEl.textContent = "--";
                valEl.addEventListener("dblclick", () => startInlineEdit(el, name));
            }

            if (sel) el.appendChild(sel);
            if (isArrayVar(name)) {
                const badge = document.createElement("span");
                badge.className = "array-badge";
                const vd = varsByName[name];
                badge.textContent = vd && Array.isArray(vd.value) ? "[" + vd.value.length + "]" : "[ ]";
                badge.title = "Variable tipo array";
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

            el.appendChild(nameEl);
            el.appendChild(alarmIcon);
            if (valEl) el.appendChild(valEl);

            const removeBtn = document.createElement("button");
            removeBtn.className = "btn-mon-remove";
            removeBtn.textContent = "\u00D7";
            removeBtn.title = "Quitar de monitorizacion";
            removeBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (isComputed(name)) removeComputedVar(name);
                else {
                    monitoredNames.delete(name);
                    delete varGraphAssignment[name];
                    delete historyCache[name];
                    expandedStats.delete(name);
                    if (isArrayVar(name)) {
                        for (const key of Object.keys(arrayElemAssignment)) {
                            if (key.startsWith(name + "[")) {
                                delete arrayElemAssignment[key];
                                delete arrayElemHistory[key];
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
        }

        Object.values(existingMap).forEach(el => el.remove());
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

        const optionsHtml = buildGraphSelectOptions();
        let rows = table.querySelectorAll(".arr-row");
        const needRebuild = rows.length !== arr.length;

        if (needRebuild) {
            table.innerHTML = "";
            table._prevOptions = optionsHtml;
            for (let i = 0; i < arr.length; i++) {
                const eName = arrayElemName(name, i);
                const row = document.createElement("div");
                row.className = "arr-row";
                row.dataset.idx = i;

                const sel = document.createElement("select");
                sel.className = "arr-graph-select";
                sel.innerHTML = optionsHtml;
                sel.value = arrayElemAssignment[eName] || "";
                updateSelectStyle(sel);
                sel.addEventListener("change", () => {
                    if (sel.value === "__new__") {
                        addGraph();
                        const newGid = graphList[graphList.length - 1];
                        arrayElemAssignment[eName] = newGid;
                        rebuildMonitorList();
                    } else {
                        arrayElemAssignment[eName] = sel.value;
                        if (!sel.value) {
                            delete arrayElemAssignment[eName];
                            delete arrayElemHistory[eName];
                        }
                        pruneEmptyGraphs();
                    }
                    updateSelectStyle(sel);
                    saveConfig();
                    schedulePlotRender();
                });
                sel.addEventListener("click", (e) => e.stopPropagation());

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
                    checkAlarms();
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

                row.appendChild(sel);
                row.appendChild(idx);
                row.appendChild(val);
                row.appendChild(alarmBtn);
                row.appendChild(genBtn);
                table.appendChild(row);
            }
        } else {
            const optionsChanged = table._prevOptions !== optionsHtml;
            if (optionsChanged) table._prevOptions = optionsHtml;

            rows.forEach(row => {
                const i = parseInt(row.dataset.idx);
                if (i === editingIdx) return;
                const valEl = row.querySelector(".arr-val");
                if (valEl && i < arr.length) valEl.textContent = arr[i].toFixed(4);
                if (optionsChanged) {
                    const sel = row.querySelector(".arr-graph-select");
                    if (sel) {
                        const eName = arrayElemName(name, i);
                        sel.innerHTML = optionsHtml;
                        sel.value = arrayElemAssignment[eName] || "";
                        updateSelectStyle(sel);
                    }
                }
                const eName = arrayElemName(name, i);
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
            if (!isNaN(val) && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: "set_array_element",
                    name: name,
                    index: index,
                    value: val,
                }));
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
            checkAlarms();
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

    function trackArrayElementHistories() {
        let tracked = false;
        for (const name of monitoredNames) {
            if (!isArrayVar(name)) continue;
            const vd = varsByName[name];
            if (!vd || !Array.isArray(vd.value)) continue;
            const arr = vd.value;
            const now = vd.timestamp || (Date.now() / 1000);
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

        let fmtRow = panel.querySelector(".fmt-row");
        if (!fmtRow) {
            fmtRow = document.createElement("div");
            fmtRow.className = "fmt-row";
            const fmtOpts = '<option value="dec">Dec</option><option value="sci">Sci</option><option value="hex">Hex</option><option value="bin">Bin</option>';
            if (!varFormat[name]) varFormat[name] = { ori: "dec", sal: "dec" };

            const oriLbl = document.createElement("span");
            oriLbl.className = "fmt-label";
            oriLbl.textContent = "Ori:";
            const oriSel = document.createElement("select");
            oriSel.className = "fmt-select";
            oriSel.innerHTML = fmtOpts;
            oriSel.value = varFormat[name].ori || "dec";
            oriSel.addEventListener("change", (e) => {
                e.stopPropagation();
                if (!varFormat[name]) varFormat[name] = { ori: "dec", sal: "dec" };
                varFormat[name].ori = oriSel.value;
                saveConfig();
            });

            const salLbl = document.createElement("span");
            salLbl.className = "fmt-label";
            salLbl.textContent = "Sal:";
            const salSel = document.createElement("select");
            salSel.className = "fmt-select";
            salSel.innerHTML = fmtOpts;
            salSel.value = varFormat[name].sal || "dec";
            salSel.addEventListener("change", (e) => {
                e.stopPropagation();
                if (!varFormat[name]) varFormat[name] = { ori: "dec", sal: "dec" };
                varFormat[name].sal = salSel.value;
                saveConfig();
            });

            fmtRow.appendChild(oriLbl);
            fmtRow.appendChild(oriSel);
            fmtRow.appendChild(salLbl);
            fmtRow.appendChild(salSel);
            panel.appendChild(fmtRow);
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
                checkAlarms();
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

        const okBtn = document.createElement("button");
        okBtn.className = "btn-alarm-ok";
        okBtn.textContent = "\u2713";
        okBtn.title = "Confirmar alarma";
        okBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const lo = loInput.value.trim() !== "" ? parseFloat(loInput.value) : null;
            const hi = hiInput.value.trim() !== "" ? parseFloat(hiInput.value) : null;
            if (lo === null && hi === null) {
                delete alarms[name];
            } else {
                alarms[name] = { lo, hi };
            }
            saveConfig();
            checkAlarms();
            updateMonitorItemStyles();
            updateStatsPanel(wrap, name);
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
        form.appendChild(okBtn);
        form.appendChild(cancelBtn);
        alarmRow.appendChild(form);

        loInput.focus();
    }

    function refreshAllStats() {
        for (const name of expandedStats) {
            const wrap = monitorListEl.querySelector(`.monitor-item-wrap[data-name="${CSS.escape(name)}"]`);
            if (wrap) updateStatsPanel(wrap, name);
        }
    }

    function checkAlarmEntry(name, value, newActive, triggered) {
        const a = alarms[name];
        if (!a || typeof value !== "number") return;
        let alarming = false;
        let reason = "";
        if (a.hi !== null && value > a.hi) {
            alarming = true;
            reason = `${name} = ${value.toFixed(4)} > Hi:${a.hi}`;
        }
        if (a.lo !== null && value < a.lo) {
            alarming = true;
            reason = `${name} = ${value.toFixed(4)} < Lo:${a.lo}`;
        }
        if (alarming) {
            newActive.add(name);
            if (!(prevAlarmState[name] || false)) {
                triggered.push({ name, reason, value });
            }
        }
    }

    function checkAlarms() {
        const newActive = new Set();
        const triggered = [];

        for (const name of monitoredNames) {
            const vd = varsByName[name];
            if (!vd || typeof vd.value !== "number") continue;
            checkAlarmEntry(name, vd.value, newActive, triggered);
        }

        for (const eName of Object.keys(alarms)) {
            if (!isArrayElem(eName)) continue;
            const val = getArrayElemValue(eName);
            if (val === undefined) continue;
            checkAlarmEntry(eName, val, newActive, triggered);
        }

        for (const name of monitoredNames) {
            prevAlarmState[name] = newActive.has(name);
        }
        for (const eName of Object.keys(alarms)) {
            if (isArrayElem(eName)) prevAlarmState[eName] = newActive.has(eName);
        }

        activeAlarms = newActive;
        monitorListEl.querySelectorAll(".monitor-item[data-name]").forEach(el => {
            el.classList.toggle("alarm-active", activeAlarms.has(el.dataset.name));
        });

        if (triggered.length > 0) {
            onAlarmTriggered(triggered);
        }
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
        if (editingName === name) return;
        const vd = varsByName[name];
        if (!vd) return;
        if (vd.type === "string" || vd.type === "array") return;

        editingName = name;
        const valEl = itemEl.querySelector(".mon-value");
        const currentText = valEl.textContent;

        const input = document.createElement("input");
        input.type = vd.type === "bool" ? "text" : "number";
        input.className = "mon-edit-input";
        input.value = vd.type === "bool" ? (vd.value ? "true" : "false") : vd.value;
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

            if (vd.type === "bool") {
                sendVal = (raw === "1" || raw.toLowerCase() === "true") ? 1 : 0;
                varType = "bool";
            } else if (vd.type === "int32") {
                sendVal = parseInt(raw) || 0;
                varType = "int32";
            } else {
                sendVal = parseFloat(raw) || 0;
                varType = "double";
            }

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: "set_var",
                    name: name,
                    value: sendVal,
                    var_type: varType,
                }));
            }
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
        for (let i = 0; i < items.length; i++) {
            const el = items[i];
            if (el.dataset.name === editingName) continue;
            const vd = varsByName[el.dataset.name];
            if (vd) {
                const monVal = el.querySelector(".mon-value");
                if (monVal) monVal.textContent = formatValue(vd.value, vd.type, el.dataset.name);
                const arrBadge = el.querySelector(".array-badge");
                if (arrBadge && Array.isArray(vd.value)) {
                    arrBadge.textContent = "[" + vd.value.length + "]";
                }
            }
        }
        checkAlarms();
        refreshAllStats();
    }

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
                const idx = graphList.indexOf(g);
                if (idx >= 0) {
                    const c = GRAPH_ACCENT[idx % GRAPH_ACCENT.length];
                    el.style.borderColor = c;
                    el.style.backgroundColor = c + "1a";
                }
            }
            const icon = el.querySelector(".mon-alarm-icon");
            if (icon) icon.style.display = alarms[name] ? "" : "none";
        });
    }

    removeSelectedBtn.addEventListener("click", () => {
        for (const name of monitoredNames) {
            varGraphAssignment[name] = "";
        }
        for (const key of Object.keys(arrayElemAssignment)) {
            delete arrayElemAssignment[key];
            delete arrayElemHistory[key];
        }
        monitorListEl.querySelectorAll(".graph-select, .arr-graph-select").forEach(sel => {
            sel.selectedIndex = 0;
            updateSelectStyle(sel);
        });
        saveConfig();
        pruneEmptyGraphs();
        updateMonitorItemStyles();
        renderPlots();
    });

    document.getElementById("clearAlarmsBtn").addEventListener("click", () => {
        alarms = {};
        prevAlarmState = {};
        activeAlarms.clear();
        monitorListEl.querySelectorAll(".monitor-item.alarm-active").forEach(el => {
            el.classList.remove("alarm-active");
        });
        saveConfig();
        checkAlarms();
        updateMonitorItemStyles();
        refreshAllStats();
        dismissAlarmBanner();
    });

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

    function startRecording() {
        if (monitoredNames.size === 0) return;
        isRecording = true;
        recordColumns = buildRecordColumns();
        recordBuffer = [];
        recordStartTime = Date.now();

        recordBtn.textContent = "\u25A0 STOP";
        recordBtn.classList.add("recording");
        recordTimerEl.style.display = "inline";
        recordTimerEl.textContent = "00:00";

        recordTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
            const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
            const ss = String(elapsed % 60).padStart(2, "0");
            recordTimerEl.textContent = mm + ":" + ss;

            if (elapsed >= MAX_RECORD_SEC) {
                stopRecording(true);
                startRecording();
            }
        }, 500);
    }

    function stopRecording(download) {
        isRecording = false;
        if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }

        recordBtn.textContent = "\u25CF REC";
        recordBtn.classList.remove("recording");
        recordTimerEl.style.display = "none";

        if (download && recordBuffer.length > 0) {
            downloadTSV();
        }
        recordBuffer = [];
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
                ctx.fillText("Grafico " + (gIdx + 1), 30, y + LABEL_H / 2);

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
        for (const [eName, g] of Object.entries(arrayElemAssignment)) {
            if (g === gid) names.push(eName);
        }
        return names;
    }

    function schedulePlotRender() {
        if (plotsPaused) return;
        if (!plotRafPending) {
            plotRafPending = true;
            requestAnimationFrame(() => {
                plotRafPending = false;
                if (!plotsPaused) renderPlots();
            });
        }
    }

    function onHistoryData(data) {
        if (!data || !data.name) return;
        historyCache[data.name] = data;
        schedulePlotRender();
    }

    function onHistoriesData(dataArr, seq) {
        if (!Array.isArray(dataArr)) return;
        if (typeof seq === "number" && seq > 0) lastSeq = seq;
        for (const data of dataArr) {
            if (!data || !data.name) continue;
            const name = data.name;
            const existing = historyCache[name];
            if (existing && existing.timestamps && existing.timestamps.length > 0 && lastSeq > 0) {
                const ts = existing.timestamps;
                const vs = existing.values;
                for (let i = 0; i < data.timestamps.length; i++) {
                    ts.push(data.timestamps[i]);
                    vs.push(data.values[i]);
                }
            } else {
                historyCache[name] = data;
            }
        }
        trimLocalHistory();
        schedulePlotRender();
    }

    function trimLocalHistory() {
        const now = Date.now() / 1000;
        const cutoff = now - localHistMaxSec;
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
    }

    function nextGraphId() {
        for (let i = 1; i <= MAX_GRAPHS + 10; i++) {
            const id = "g" + i;
            if (!graphList.includes(id)) return id;
        }
        return "g" + (graphList.length + 1);
    }

    function addGraph() {
        if (graphList.length >= MAX_GRAPHS) return;
        graphList.push(nextGraphId());
        saveConfig();
        rebuildPlotArea();
        rebuildMonitorList();
        renderPlots();
    }

    function removeGraph(gid) {
        graphList = graphList.filter(g => g !== gid);
        for (const name of monitoredNames) {
            if (varGraphAssignment[name] === gid) varGraphAssignment[name] = "";
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
        Object.keys(plotInstances).forEach(gid => {
            const el = document.getElementById("plotContainer_" + gid);
            if (el) Plotly.purge(el);
        });
        plotInstances = {};

        while (plotArea.firstChild && plotArea.firstChild.id !== "plotEmpty") {
            plotArea.removeChild(plotArea.firstChild);
        }
        const frag = document.createDocumentFragment();

        graphList.forEach((gid, idx) => {
            const slot = document.createElement("div");
            slot.id = "plotSlot_" + gid;
            slot.className = "plot-slot";
            slot.style.display = "flex";

            const header = document.createElement("div");
            header.className = "plot-slot-header";

            const dot = document.createElement("span");
            dot.className = "plot-dot";
            dot.style.backgroundColor = GRAPH_ACCENT[idx % GRAPH_ACCENT.length];

            const label = document.createElement("span");
            label.textContent = " Grafico " + (idx + 1);

            const removeBtn = document.createElement("button");
            removeBtn.className = "btn-plot-remove";
            removeBtn.textContent = "\u00D7";
            removeBtn.title = "Eliminar grafico";
            removeBtn.addEventListener("click", () => removeGraph(gid));

            header.appendChild(dot);
            header.appendChild(label);
            header.appendChild(removeBtn);

            const container = document.createElement("div");
            container.className = "plot-container";
            container.id = "plotContainer_" + gid;

            slot.appendChild(header);
            slot.appendChild(container);
            frag.appendChild(slot);
        });

        plotArea.insertBefore(frag, plotEmpty);

        const addSlot = document.getElementById("plotAddSlot");
        if (addSlot) addSlot.remove();
    }

    function pruneEmptyGraphs() {
        const empty = graphList.filter(gid => getVarsForGraph(gid).length === 0);
        if (empty.length === 0) return;
        for (const gid of empty) {
            graphList = graphList.filter(g => g !== gid);
            const cEl = document.getElementById("plotContainer_" + gid);
            if (cEl && plotInstances[gid]) Plotly.purge(cEl);
            delete plotInstances[gid];
        }
        saveConfig();
        rebuildPlotArea();
        rebuildMonitorList();
    }

    function renderPlots() {
        const windowSec = parseInt(timeWindowSelect.value);
        const activeSlots = [];


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

            varsInGraph.forEach((name, idx) => {
                const isArrElem = name.includes("[") && name.endsWith("]");
                const hist = isArrElem ? arrayElemHistory[name] : historyCache[name];
                if (!hist || !hist.timestamps || hist.timestamps.length === 0) return;

                let xs = hist.timestamps;
                let ys = hist.values;
                const tMax = xs[xs.length - 1];

                if (windowSec > 0) {
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

                const t0 = xs[0];
                traces.push({
                    x: xs.map(t => t - t0),
                    y: ys,
                    type: "scatter",
                    mode: "lines",
                    name: name,
                    line: { color: TRACE_COLORS[idx % TRACE_COLORS.length], width: 1.5 },
                });
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

            const cRect = containerEl.getBoundingClientRect();
            const layout = {
                paper_bgcolor: "#1a1d27",
                plot_bgcolor: "#0f1117",
                font: { color: "#8b8fa3", family: "Segoe UI, system-ui, sans-serif", size: 10 },
                margin: { t: 8, r: 10, b: 28, l: 60 },
                dragmode: "zoom",
                width: Math.max(cRect.width, 200),
                height: Math.max(cRect.height, 80),
                hovermode: "x unified",
                xaxis: {
                    gridcolor: "#2a2e3a",
                    zerolinecolor: "#2a2e3a",
                },
                yaxis: { gridcolor: "#2a2e3a", zerolinecolor: "#2a2e3a" },
                shapes: alarmShapes,
                legend: {
                    bgcolor: "rgba(0,0,0,0)",
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
            } else {
                Plotly.react(containerEl, traces, layout, config);
            }
        }

        plotEmpty.style.display = graphList.length > 0 ? "none" : "flex";
    }

    timeWindowSelect.addEventListener("change", () => { saveConfig(); renderPlots(); });
    historyBufferSelect.addEventListener("change", () => {
        localHistMaxSec = parseInt(historyBufferSelect.value) || 30;
        trimLocalHistory();
        saveConfig();
    });

    function markReconnectPending() {
        if (!reconnectBtn.classList.contains("btn-pending")) {
            reconnectBtn.classList.add("btn-pending");
        }
    }

    function clearReconnectPending() {
        reconnectBtn.classList.remove("btn-pending");
    }

    hostInput.addEventListener("input", markReconnectPending);
    portInput.addEventListener("input", markReconnectPending);
    portSelect.addEventListener("change", () => {
        if (portSelect.value) {
            portInput.value = portSelect.value;
        }
        markReconnectPending();
    });

    reconnectBtn.addEventListener("click", () => {
        if (ws) {
            try { ws.close(); } catch (e) { /* ignore */ }
        }
        // Reset de estado al cambiar de instancia
        resetStateForNewTarget();
        lastSeq = 0;
        connect();
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
        // Limpiar variables internas
        varsByName = {};
        knownVarNames = [];
        monitoredNames.clear();
        varGraphAssignment = {};
        historyCache = {};
        graphList = [];
        plotInstances = {};
        arrayElemAssignment = {};
        arrayElemHistory = {};
        expandedStats.clear();
        alarms = {};
        activeAlarms.clear();
        prevAlarmState = {};
        computedVars = [];
        computedHistories = {};

        // Parar generadores activos
        for (const name in activeGenerators) {
            stopGenerator(name);
        }

        // Parar grabacion si estaba activa
        isRecording = false;
        recordBuffer = [];
        recordColumns = [];
        recordStartTime = null;
        if (recordTimerInterval) {
            clearInterval(recordTimerInterval);
            recordTimerInterval = null;
        }
        recordTimerEl.style.display = "none";
        recordBtn.classList.remove("btn-record-active");

        // Reset UI de listas y graficos
        browserSelection.clear();
        browserListDirty = true;
        varCountEl.textContent = "";
        monitorListEl.innerHTML = "";
        plotArea.innerHTML = "";
        plotInstances = {};
        // Volver a mostrar placeholder vacio de graficos
        if (plotEmpty) {
            plotEmpty.style.display = "flex";
            plotArea.appendChild(plotEmpty);
        }
    }

    async function initialScanAndConnect() {
        // Host por defecto: el hostname de la URL actual
        if (!hostInput.value) {
            hostInput.value = location.hostname || "localhost";
        }
        try {
            const resp = await fetch(`/api/scan_ports?host=${encodeURIComponent(hostInput.value)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            portSelect.innerHTML = "";
            const hasPorts = Array.isArray(data.ports) && data.ports.length > 0;
            if (hasPorts) {
                // Rellenar solo con los puertos encontrados
                for (const p of data.ports) {
                    const opt = document.createElement("option");
                    opt.value = String(p);
                    opt.textContent = String(p);
                    portSelect.appendChild(opt);
                }
            } else if (Array.isArray(data.range) && data.range.length === 2) {
                // Sin instancias activas: usar el rango sugerido por el backend
                const [start, end] = data.range;
                for (let p = start; p <= end; p++) {
                    const opt = document.createElement("option");
                    opt.value = String(p);
                    opt.textContent = String(p);
                    portSelect.appendChild(opt);
                }
            }
            // Si no hay configuracion previa de puerto, usar el primero del selector
            if (!portSelect.value && portSelect.options.length > 0) {
                portSelect.value = portSelect.options[0].value;
            }
            if (!portInput.value && portSelect.value) {
                portInput.value = portSelect.value;
            }
            // Auto-conectar si se ha encontrado al menos una instancia
            if (hasPorts) {
                connect();
            }
        } catch (e) {
            // En caso de error, no tocamos el contenido actual de portSelect ni auto-conectamos.
        }
    }

    // --- Data handlers ---

    function onVarNames(names) {
        if (!Array.isArray(names)) return;
        const sorted = names.slice().sort();
        const key = sorted.join(",");
        const oldKey = knownVarNames.join(",");

        varCountEl.textContent = `${names.length} vars`;

        if (key !== oldKey) {
            knownVarNames = sorted;
            browserListDirty = true;
            renderBrowserList();
        }
    }

    function onVarsUpdate(data) {
        if (!Array.isArray(data)) return;

        for (let i = 0; i < data.length; i++) {
            varsByName[data[i].name] = data[i];
        }

        if (computedVars.length > 0) evalComputedVars();
        const hadArrayElems = trackArrayElementHistories();

        updateMonitorValues();
        recordSample();
        if (hadArrayElems) schedulePlotRender();
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
        if (isInput && e.key !== "Escape") return;

        if (e.key === "Escape") {
            if (helpOverlay.style.display === "flex") { helpOverlay.style.display = "none"; return; }
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

    initialScanAndConnect();
})();
