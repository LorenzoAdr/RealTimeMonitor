/**
 * Registro / decodificación MIL-STD-1553 en cliente (convención RT{n}_W{k}_suffix).
 * Fuente versionada en repo: misma ruta en runtime bajo static/js/modules/.
 */

export const DEFAULT_M1553_VAR_NAME_RE = /^RT(\d+)_W(\d+)_([^_]+(?:_[^_]+)*)$/;

/**
 * @param {string} raw
 * @param {RegExp} [re]
 * @returns {{ rt: number, wordKind: number, suffix: string, raw: string } | null}
 */
export function parseM1553VarName(raw, re = DEFAULT_M1553_VAR_NAME_RE) {
    const m = String(raw).match(re);
    if (!m) return null;
    return {
        rt: Number(m[1]),
        wordKind: Number(m[2]),
        suffix: m[3],
        raw: String(raw),
    };
}

export function m1553EntryKey(rt, wordKind, suffix) {
    return `RT${rt}_W${wordKind}_${suffix}`;
}

export function findM1553Definition(labels, rt, wordKind, suffix) {
    const k = m1553EntryKey(rt, wordKind, suffix);
    return labels[k] ?? null;
}

/**
 * @param {string} varName
 * @param {number} rawValue
 * @param {Record<string, object>} labels
 */
export function decodeM1553FromVarName(varName, rawValue, labels) {
    const p = parseM1553VarName(varName);
    if (!p) {
        return "Valor sin convención MIL-STD-1553 reconocible (nombre de variable).";
    }
    const def = findM1553Definition(labels, p.rt, p.wordKind, p.suffix);
    if (!def) {
        return `${rawValue} (sin definición en registro para ${varName})`;
    }
    if (def.encoding === "bnr") {
        const bits = Math.max(1, Number(def.bits) || 16);
        const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
        const u = Number(rawValue) >>> 0;
        const masked = u & mask;
        const scale = Number(def.scale) || 1;
        const engineering = masked * scale;
        const ustr = `${engineering.toFixed(4)}`;
        const units = def.units ? ` ${def.units}` : "";
        return `${ustr}${units}`;
    }
    return String(rawValue);
}

/**
 * @param {string} csv
 * @returns {{ labels: Record<string, object>, errors: string[] }}
 */
export function parseM1553CsvToLabels(csv) {
    const errors = [];
    const labels = {};
    const lines = String(csv).split(/\r?\n/).filter((l) => l.trim().length);
    if (lines.length < 2) {
        errors.push("CSV vacío o sin datos");
        return { labels, errors };
    }
    const head = lines[0].split(",").map((s) => s.trim().toLowerCase());
    const idx = (name) => head.indexOf(name);
    const ir = idx("rt");
    const iw = idx("word_kind");
    const isu = idx("suffix");
    const ina = idx("name");
    const ienc = idx("encoding");
    const ibits = idx("bits");
    const isc = idx("scale");
    const isigned = idx("signed");
    const iu = idx("units");
    if (ir < 0 || iw < 0 || isu < 0 || ina < 0) {
        errors.push("Cabecera CSV incompleta (rt, word_kind, suffix, name)");
        return { labels, errors };
    }
    for (let li = 1; li < lines.length; li++) {
        const cols = lines[li].split(",").map((s) => s.trim());
        const rt = Number(cols[ir]);
        const wordKind = Number(cols[iw]);
        const suffix = cols[isu];
        const name = cols[ina];
        if (!Number.isFinite(rt) || !Number.isFinite(wordKind) || !suffix) continue;
        const row = {
            rt,
            wordKind,
            suffix,
            name,
            encoding: ienc >= 0 ? cols[ienc] : undefined,
            bits: ibits >= 0 ? Number(cols[ibits]) : undefined,
            scale: isc >= 0 ? Number(cols[isc]) : undefined,
            signed: isigned >= 0 ? cols[isigned].toLowerCase() === "true" : undefined,
            units: iu >= 0 ? cols[iu] : undefined,
        };
        labels[m1553EntryKey(rt, wordKind, suffix)] = row;
    }
    return { labels, errors };
}

/**
 * @param {string} varName
 * @param {number} rawValue
 * @param {Record<string, object>} labels
 */
export function m1553DetailedDecode(varName, rawValue, labels) {
    const p = parseM1553VarName(varName);
    if (!p) {
        return {
            ok: false,
            fromDb: false,
            engineeringStr: "",
            rawHex: `0x${(Number(rawValue) >>> 0).toString(16)}`,
        };
    }
    const def = findM1553Definition(labels, p.rt, p.wordKind, p.suffix);
    const u = Number(rawValue) >>> 0;
    const rawHex = `0x${u.toString(16)}`;
    if (!def) {
        return { ok: false, fromDb: false, engineeringStr: "", rawHex };
    }
    if (def.encoding === "bnr") {
        const bits = Math.max(1, Number(def.bits) || 16);
        const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
        const masked = u & mask;
        const scale = Number(def.scale) || 1;
        const engineering = masked * scale;
        return {
            ok: true,
            fromDb: true,
            engineeringStr: `${engineering.toFixed(4)}${def.units ? ` ${def.units}` : ""}`,
            rawHex,
        };
    }
    return { ok: true, fromDb: true, engineeringStr: String(rawValue), rawHex };
}

// Compat exports esperados por app-legacy recuperado (backup 2026-04-14).
export const M1553_IMPORT_FIELD_IDS = [
    { id: "", labelEs: "— Ignorar —", labelEn: "— Ignore —" },
    { id: "group", labelEs: "Grupo / bus", labelEn: "Group / bus" },
    { id: "rt", labelEs: "RT", labelEn: "RT" },
    { id: "word_kind", labelEs: "Tipo de palabra (W)", labelEn: "Word kind (W)" },
    { id: "suffix", labelEs: "Sufijo ICD", labelEn: "ICD suffix" },
    { id: "name", labelEs: "Nombre señal", labelEn: "Signal name" },
    { id: "encoding", labelEs: "Codificación", labelEn: "Encoding" },
    { id: "bits", labelEs: "Bits datos", labelEn: "Data bits" },
    { id: "scale", labelEs: "Escala", labelEn: "Scale" },
    { id: "signed", labelEs: "Con signo", labelEn: "Signed" },
    { id: "units", labelEs: "Unidades", labelEn: "Units" },
    { id: "discrete_bits_json", labelEs: "Bits DIS (JSON)", labelEn: "Discrete bits (JSON)" },
    { id: "packed_fields_json", labelEs: "Subcampos empaquetados (JSON)", labelEn: "Packed fields (JSON)" },
];

export function normalizeM1553LabelRow(row) {
    if (!row || typeof row !== "object") return null;
    const rt = parseInt(row.rt, 10);
    const wordKind = parseInt(row.wordKind ?? row.word_kind, 10);
    const suffix = String(row.suffix || "").trim();
    if (!Number.isFinite(rt) || !Number.isFinite(wordKind) || !suffix) return null;
    return {
        group: String(row.group || "General").trim() || "General",
        rt,
        wordKind,
        suffix,
        name: String(row.name || "").trim(),
        encoding: String(row.encoding || "bnr").toLowerCase(),
        bits: parseInt(row.bits, 10) || 16,
        scale: parseFloat(row.scale) || 1,
        signed: !!row.signed,
        units: String(row.units || "").trim(),
        discreteBits: Array.isArray(row.discreteBits) ? row.discreteBits : [],
        packedFields: Array.isArray(row.packedFields) ? row.packedFields : [],
    };
}

export function migrateM1553LabelsKeys(labels) {
    const out = {};
    for (const [k, v] of Object.entries(labels || {})) {
        const n = normalizeM1553LabelRow(v);
        if (!n) continue;
        const kk = m1553EntryKey(n.rt, n.wordKind, n.suffix);
        out[kk || k] = n;
    }
    return out;
}

export function buildM1553ImportMapping(headers, mapping, overrides) {
    const map = { ...(mapping || {}), ...(overrides || {}) };
    for (const h of headers || []) {
        if (Object.prototype.hasOwnProperty.call(map, h)) continue;
        const n = String(h || "").toLowerCase().replace(/\s+/g, "_");
        if (n.includes("word_kind") || n === "wk" || n === "w") map[h] = "word_kind";
        else if (n === "rt") map[h] = "rt";
        else if (n.includes("suffix")) map[h] = "suffix";
        else if (n.includes("group") || n.includes("bus")) map[h] = "group";
        else if (n.includes("name")) map[h] = "name";
        else if (n.includes("encoding") || n === "enc") map[h] = "encoding";
        else if (n.includes("bits")) map[h] = "bits";
        else if (n.includes("scale")) map[h] = "scale";
        else if (n.includes("signed")) map[h] = "signed";
        else if (n.includes("unit")) map[h] = "units";
        else if (n.includes("discrete")) map[h] = "discrete_bits_json";
        else if (n.includes("packed")) map[h] = "packed_fields_json";
        else map[h] = "";
    }
    return map;
}

export function guessM1553RowImportKind(_row, _mapping) {
    return "default";
}

export function buildM1553LabelsFromMappedRows(rows, headers, mapping, rowKinds = []) {
    const labels = {};
    const errors = [];
    const warnings = [];
    const rowDiagnostics = [];
    const map = buildM1553ImportMapping(headers || [], mapping || {}, {});
    const parseBool = (v) => ["1", "true", "yes", "y", "s", "si"].includes(String(v ?? "").trim().toLowerCase());
    const parseJsonSafe = (raw, label) => {
        const t = String(raw ?? "").trim();
        if (!t) return [];
        try {
            const x = JSON.parse(t);
            return Array.isArray(x) ? x : [];
        } catch (e) {
            errors.push(`${label}: ${e?.message || String(e)}`);
            return [];
        }
    };
    for (let i = 0; i < (rows || []).length; i++) {
        if ((rowKinds[i] || "default") !== "default") {
            rowDiagnostics.push({ row: i + 1, ok: true, detail: rowKinds[i] || "default" });
            continue;
        }
        const row = rows[i] || {};
        const pick = (id) => {
            const src = Object.keys(map).find((k) => map[k] === id);
            return src ? String(row[src] ?? "").trim() : "";
        };
        const n = normalizeM1553LabelRow({
            group: pick("group"),
            rt: pick("rt"),
            wordKind: pick("word_kind"),
            suffix: pick("suffix"),
            name: pick("name"),
            encoding: pick("encoding"),
            bits: pick("bits"),
            scale: pick("scale"),
            signed: parseBool(pick("signed")),
            units: pick("units"),
            discreteBits: parseJsonSafe(pick("discrete_bits_json"), `fila ${i + 1} discrete_bits_json`),
            packedFields: parseJsonSafe(pick("packed_fields_json"), `fila ${i + 1} packed_fields_json`),
        });
        if (!n) {
            rowDiagnostics.push({ row: i + 1, ok: false, detail: "faltan RT/W/sufijo" });
            continue;
        }
        const key = `${n.group}::${n.rt}::${n.wordKind}::${n.suffix}`;
        labels[key] = n;
        rowDiagnostics.push({ row: i + 1, ok: true, detail: "ok", key });
    }
    return { labels, errors, warnings, rowDiagnostics, orphanRelCount: 0 };
}
