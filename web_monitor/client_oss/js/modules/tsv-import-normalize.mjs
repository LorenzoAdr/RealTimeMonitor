/**
 * Normalización de texto delimitado → TSV canónico VarMonitor (tab, columna time_s).
 */

/** @typedef {{ tab: boolean, space: boolean, semicolon: boolean, comma: boolean }} DelimiterFlags */

/**
 * @param {DelimiterFlags} d
 * @returns {RegExp}
 */
export function buildDelimiterRegex(d) {
    const chars = [];
    if (d.tab) chars.push("\t");
    if (d.space) {
        chars.push(" ");
        chars.push("\u00a0");
    }
    if (d.semicolon) chars.push(";");
    if (d.comma) chars.push(",");
    if (chars.length === 0) {
        const err = new Error("tsvImportDelimNone");
        err.code = "tsvImportDelimNone";
        throw err;
    }
    const esc = chars.map((c) => {
        if (c === "\t") return "\\t";
        if (c === " ") return " ";
        if (c === "\u00a0") return "\\u00a0";
        if (c === ";") return ";";
        if (c === ",") return ",";
        return c;
    });
    // Un carácter o más de cualquier delimitador elegido → un solo separador entre campos.
    return new RegExp(`[${esc.join("")}]+`);
}

/**
 * @param {string} line
 * @param {RegExp} re
 * @returns {string[]}
 */
export function splitRow(line, re) {
    const parts = String(line ?? "")
        .trim()
        .split(re)
        .map((s) => s.trim());
    // Evita columnas fantasma por delimitadores iniciales/finales (p. ej. ",a,b," → no forzar "" al principio/final).
    while (parts.length && parts[0] === "") parts.shift();
    while (parts.length && parts[parts.length - 1] === "") parts.pop();
    return parts;
}

/**
 * @param {string} raw
 * @param {"dot"|"comma"} decimalSep
 */
export function parseNumberWithDecimal(raw, decimalSep) {
    let t = String(raw ?? "").trim();
    if (!t) return Number.NaN;
    const low = t.toLowerCase();
    if (low === "nan") return Number.NaN;
    if (low === "inf" || low === "+inf" || low === "infinity") return Number.POSITIVE_INFINITY;
    if (low === "-inf" || low === "-infinity") return Number.NEGATIVE_INFINITY;
    if (decimalSep === "comma") {
        t = t.replace(/,/g, ".");
    }
    return Number(t);
}

function formatOutNumber(n) {
    if (!Number.isFinite(n)) return String(n);
    if (Math.abs(n) >= 1e6 || (Math.abs(n) > 0 && Math.abs(n) < 1e-6)) return n.toExponential(12).replace(/\.?0+e/, "e");
    return String(n);
}

function formatOutCell(raw, decimalSep) {
    const t = String(raw ?? "").trim();
    if (!t) return "";
    const n = parseNumberWithDecimal(t, decimalSep);
    if (Number.isFinite(n)) return formatOutNumber(n);
    const low = t.toLowerCase();
    if (low === "true") return "1";
    if (low === "false") return "0";
    if (t.includes("\t") || t.includes("\n") || t.includes("\r")) {
        const err = new Error("tsvImportCellHasTab");
        err.code = "tsvImportCellHasTab";
        throw err;
    }
    return t;
}

/**
 * @param {string} text
 * @param {{
 *   delimiters: DelimiterFlags,
 *   decimalSeparator: "dot"|"comma",
 *   timeMode?: "column"|"synthetic",
 *   timeColumn?: string,
 *   timeStepSec?: number,
 * }} opts
 * @returns {string} TSV canónico terminado en \n
 */
export function buildCanonicalVarMonitorTsv(text, opts) {
    const re = buildDelimiterRegex(opts.delimiters);
    const lines = String(text ?? "")
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+$/, ""))
        .filter((ln) => ln.length > 0);
    if (lines.length < 2) {
        const err = new Error("tsvImportEmpty");
        err.code = "tsvImportEmpty";
        throw err;
    }
    const header = splitRow(lines[0], re);
    const H = header.length;
    const timeMode = opts.timeMode === "synthetic" ? "synthetic" : "column";
    if ((timeMode === "column" && H < 2) || (timeMode === "synthetic" && H < 1)) {
        const err = new Error("tsvImportHeaderShort");
        err.code = "tsvImportHeaderShort";
        throw err;
    }
    let timeIdx = -1;
    let timeStepSec = 0.01;
    if (timeMode === "column") {
        const timeCol = String(opts.timeColumn || "").trim();
        timeIdx = header.indexOf(timeCol);
        if (timeIdx < 0) {
            const err = new Error("tsvImportTimeMissing");
            err.code = "tsvImportTimeMissing";
            throw err;
        }
    } else {
        const dt = Number(opts.timeStepSec);
        if (!Number.isFinite(dt) || dt <= 0) {
            const err = new Error("tsvImportTimeDeltaInvalid");
            err.code = "tsvImportTimeDeltaInvalid";
            throw err;
        }
        timeStepSec = dt;
    }
    const otherIdx = [];
    if (timeMode === "column") {
        for (let i = 0; i < H; i++) {
            if (i !== timeIdx) otherIdx.push(i);
        }
    } else {
        for (let i = 0; i < H; i++) otherIdx.push(i);
    }
    const usedHeaderNames = new Set(["time_s"]);
    const outHeader = ["time_s"];
    for (const i of otherIdx) {
        const raw = String(header[i] ?? "").trim();
        // Evita vacíos y colisiones (p. ej. fuente ya tiene "time_s"): no pisar columnas de referencia.
        let base = raw || `col_${i + 1}`;
        if (base === "time_s") base = "time_s_src";
        let name = base;
        let suffix = 2;
        while (usedHeaderNames.has(name)) {
            name = `${base}_${suffix}`;
            suffix += 1;
        }
        usedHeaderNames.add(name);
        outHeader.push(name);
    }
    const dec = opts.decimalSeparator === "comma" ? "comma" : "dot";
    const outRows = [];
    for (let r = 1; r < lines.length; r++) {
        const parts = splitRow(lines[r], re);
        if (parts.length !== H) {
            const err = new Error(`tsvImportColMismatch:${r + 1}:${H}:${parts.length}`);
            err.code = "tsvImportColMismatch";
            err.row = r + 1;
            err.expected = H;
            err.actual = parts.length;
            throw err;
        }
        let ts;
        if (timeMode === "column") {
            ts = parseNumberWithDecimal(parts[timeIdx], dec);
            if (!Number.isFinite(ts)) continue;
        } else {
            ts = (r - 1) * timeStepSec;
        }
        const cells = [formatOutNumber(ts), ...otherIdx.map((ci) => formatOutCell(parts[ci], dec))];
        outRows.push(cells.join("\t"));
    }
    if (outRows.length === 0) {
        const err = new Error("tsvImportNoValidRows");
        err.code = "tsvImportNoValidRows";
        throw err;
    }
    return `${outHeader.join("\t")}\n${outRows.join("\n")}\n`;
}

/**
 * Primera línea no vacía como cabecera y filas para preview HTML.
 * @param {string} text
 * @param {DelimiterFlags} delimiters
 * @param {number} maxDataRows
 */
export function previewSplitLines(text, delimiters, maxDataRows = 15) {
    const re = buildDelimiterRegex(delimiters);
    const lines = String(text ?? "")
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+$/, ""))
        .filter((ln) => ln.length > 0);
    if (lines.length === 0) return { header: [], rows: [] };
    const header = splitRow(lines[0], re);
    const rows = [];
    for (let r = 1; r < lines.length && rows.length < maxDataRows; r++) {
        const parts = splitRow(lines[r], re);
        rows.push(parts);
    }
    return { header, rows, delimiterRegex: re };
}

/**
 * Valida que las primeras `checkRows` filas tengan el mismo ancho que la cabecera.
 */
export function validatePreviewColumnWidths(header, rowArrays, checkRows = 50) {
    const H = header.length;
    for (let r = 0; r < Math.min(rowArrays.length, checkRows); r++) {
        const parts = rowArrays[r];
        if (parts.length !== H) {
            return {
                ok: false,
                row: r + 2,
                expected: H,
                actual: parts.length,
            };
        }
    }
    return { ok: true };
}

/**
 * Stem seguro para basename en servidor.
 * @param {string} filename
 */
export function safeBasenameStem(filename) {
    const base = String(filename || "").replace(/^.*[/\\]/, "");
    const stem = base.replace(/\.[^.]+$/, "") || "recording";
    return stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 120) || "recording";
}
