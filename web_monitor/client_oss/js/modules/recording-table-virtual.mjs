/**
 * Modal de tabla de grabación/referencia con scroll virtualizado.
 * - Memoria: solo monta filas visibles sobre `dataset.samples`.
 * - Servidor: tramos vía GET /api/recordings/.../table_slice (ficheros grandes / modo seguro).
 */

const ROW_PX = 24;
const VIEWPORT_MAX_PX = 520;
const OVERSCAN = 10;
const FETCH_DEBOUNCE_MS = 100;
const SERVER_BATCH = 400;

function cellTextFromSample(sample, name) {
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
    if (Array.isArray(entry.value)) return "[" + entry.value.length + "]";
    return entry.value == null ? "" : String(entry.value);
}

function buildMemoryRow(sample, names) {
    const tr = document.createElement("tr");
    const td0 = document.createElement("td");
    td0.textContent = sample && Number.isFinite(sample.ts) ? String(sample.ts) : "";
    tr.appendChild(td0);
    for (const nm of names) {
        const td = document.createElement("td");
        td.textContent = cellTextFromSample(sample, nm);
        tr.appendChild(td);
    }
    return tr;
}

function buildServerRow(cols, cells) {
    const tr = document.createElement("tr");
    for (let i = 0; i < cols.length; i++) {
        const td = document.createElement("td");
        const v = cells[i];
        td.textContent = v != null && v !== "" ? String(v) : "";
        tr.appendChild(td);
    }
    return tr;
}

async function fetchTableSlice(filename, rowStart, rowLimit) {
    const u = `/api/recordings/${encodeURIComponent(filename)}/table_slice?row_start=${rowStart}&row_limit=${rowLimit}`;
    const r = await fetch(u);
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j && j.error) || r.statusText || "table_slice");
    }
    return r.json();
}

/**
 * @param {object} opts
 * @param {object | null} opts.dataset
 * @param {string} opts.title
 * @param {string} opts.emptyText
 * @param {string} [opts.serverFilename]
 * @param {object | null} [opts.serverMeta]
 * @param {string} [opts.closeLabel]
 */
export function openVirtualRecordingTableModal(opts) {
    const dataset = opts.dataset;
    const emptyAlertText = opts.emptyText || "Sin datos.";
    const serverFilename = (opts.serverFilename || "").trim();
    const serverMeta = opts.serverMeta || null;

    const names = Array.isArray(dataset?.names) ? dataset.names.slice() : [];
    const samples = Array.isArray(dataset?.samples) ? dataset.samples : [];

    const useServer =
        !!serverFilename &&
        !!(
            serverMeta?.safeMode ||
            serverMeta?.parquetMode ||
            (dataset?.isPreview && dataset?.truncated)
        );

    let totalRows = samples.length;
    if (useServer) {
        if (serverMeta?.parquetTotalRows != null) {
            totalRows = Math.max(1, Number(serverMeta.parquetTotalRows) || 1);
        } else if (serverMeta?.estRows != null) {
            totalRows = Math.max(samples.length, Number(serverMeta.estRows) || samples.length);
        } else {
            totalRows = Math.max(samples.length, 1);
        }
    }

    if (!useServer && samples.length === 0) {
        alert(emptyAlertText);
        return;
    }
    if (useServer && totalRows < 1) {
        alert(emptyAlertText);
        return;
    }

    const backdrop = document.createElement("div");
    backdrop.className = "flight-viz-modal-backdrop";
    const dlg = document.createElement("div");
    dlg.className = "flight-viz-modal live-replay-ref-grid-modal live-replay-ref-grid-modal--virtual";
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");

    const title = document.createElement("h3");
    title.className = "flight-viz-modal-title";
    title.textContent = opts.title || "Grabación";

    const sub = document.createElement("p");
    sub.className = "live-replay-ref-grid-sub";

    const wrap = document.createElement("div");
    wrap.className = "live-replay-ref-grid-wrap live-replay-ref-grid-wrap--virtual";

    const scrollBox = document.createElement("div");
    scrollBox.className = "live-replay-ref-grid-virtual-scroll";

    const table = document.createElement("table");
    table.className = "live-replay-ref-grid-table live-replay-ref-grid-table--virtual";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    if (!useServer) {
        const th0 = document.createElement("th");
        th0.textContent = "time_s";
        hr.appendChild(th0);
        for (const nm of names) {
            const th = document.createElement("th");
            th.textContent = nm;
            th.title = nm;
            hr.appendChild(th);
        }
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);

    scrollBox.appendChild(table);
    wrap.appendChild(scrollBox);

    const colCountMem = names.length + 1;

    let fetchTimer = 0;
    let scrollRaf = 0;
    /** @type {string[] | null} */
    let serverCols = null;

    function setSubLabel(extra) {
        const modeLabel = useServer ? " · virtual+API" : " · virtual";
        sub.textContent = `${names.length} columnas · ${totalRows} filas${modeLabel}${extra || ""}`;
    }
    setSubLabel("");

    function renderMemory() {
        const st = scrollBox.scrollTop;
        const vh = scrollBox.clientHeight || VIEWPORT_MAX_PX;
        const first = Math.max(0, Math.floor(st / ROW_PX) - OVERSCAN);
        const nVis = Math.ceil(vh / ROW_PX) + OVERSCAN * 2;
        const last = Math.min(totalRows - 1, first + nVis);

        tbody.innerHTML = "";

        const trTop = document.createElement("tr");
        const tdTop = document.createElement("td");
        tdTop.colSpan = colCountMem;
        tdTop.className = "live-replay-ref-grid-spacer-cell";
        tdTop.style.height = `${first * ROW_PX}px`;
        trTop.appendChild(tdTop);
        tbody.appendChild(trTop);

        for (let i = first; i <= last && i < samples.length; i++) {
            tbody.appendChild(buildMemoryRow(samples[i], names));
        }

        const padBottom = Math.max(0, totalRows - last - 1);
        const trBot = document.createElement("tr");
        const tdBot = document.createElement("td");
        tdBot.colSpan = colCountMem;
        tdBot.className = "live-replay-ref-grid-spacer-cell";
        tdBot.style.height = `${padBottom * ROW_PX}px`;
        trBot.appendChild(tdBot);
        tbody.appendChild(trBot);
    }

    async function renderServer() {
        const st = scrollBox.scrollTop;
        const vh = scrollBox.clientHeight || VIEWPORT_MAX_PX;
        const first = Math.max(0, Math.floor(st / ROW_PX) - OVERSCAN);
        const nVis = Math.ceil(vh / ROW_PX) + OVERSCAN * 2;
        const rowLimit = Math.min(SERVER_BATCH, Math.max(nVis + OVERSCAN, 20));

        try {
            const data = await fetchTableSlice(serverFilename, first, rowLimit);
            serverCols = Array.isArray(data.columns) ? data.columns : [];
            const rows = Array.isArray(data.rows) ? data.rows : [];
            if (Number.isFinite(data.total_rows)) {
                totalRows = Math.max(1, Number(data.total_rows));
                setSubLabel("");
            }

            thead.innerHTML = "";
            const hrn = document.createElement("tr");
            for (const c of serverCols) {
                const th = document.createElement("th");
                th.textContent = c;
                th.title = c;
                hrn.appendChild(th);
            }
            thead.appendChild(hrn);

            tbody.innerHTML = "";
            const rs = Number(data.row_start);
            const sliceStart = Number.isFinite(rs) ? rs : first;

            const trTop = document.createElement("tr");
            const tdTop = document.createElement("td");
            tdTop.colSpan = Math.max(2, serverCols.length);
            tdTop.className = "live-replay-ref-grid-spacer-cell";
            tdTop.style.height = `${sliceStart * ROW_PX}px`;
            trTop.appendChild(tdTop);
            tbody.appendChild(trTop);

            for (let i = 0; i < rows.length; i++) {
                tbody.appendChild(buildServerRow(serverCols, rows[i]));
            }

            const padBottom = Math.max(0, totalRows - sliceStart - rows.length);
            const trBot = document.createElement("tr");
            const tdBot = document.createElement("td");
            tdBot.colSpan = Math.max(2, serverCols.length);
            tdBot.className = "live-replay-ref-grid-spacer-cell";
            tdBot.style.height = `${padBottom * ROW_PX}px`;
            trBot.appendChild(tdBot);
            tbody.appendChild(trBot);
        } catch (e) {
            tbody.innerHTML = "";
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 4;
            td.textContent = "Error: " + (e && e.message ? e.message : String(e));
            tr.appendChild(td);
            tbody.appendChild(tr);
        }
    }

    function onScroll() {
        if (scrollRaf) cancelAnimationFrame(scrollRaf);
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = 0;
            if (useServer) {
                if (fetchTimer) clearTimeout(fetchTimer);
                fetchTimer = setTimeout(() => {
                    fetchTimer = 0;
                    void renderServer();
                }, FETCH_DEBOUNCE_MS);
            } else {
                renderMemory();
            }
        });
    }

    scrollBox.addEventListener("scroll", onScroll, { passive: true });

    if (useServer) {
        void renderServer();
    } else {
        renderMemory();
    }

    const actions = document.createElement("div");
    actions.className = "flight-viz-modal-actions";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-small";
    closeBtn.textContent = opts.closeLabel || "Cerrar";
    const close = () => backdrop.remove();
    closeBtn.addEventListener("click", close);
    actions.appendChild(closeBtn);

    dlg.appendChild(title);
    dlg.appendChild(sub);
    dlg.appendChild(wrap);
    dlg.appendChild(actions);
    backdrop.appendChild(dlg);
    backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close();
    });
    document.body.appendChild(backdrop);
}
