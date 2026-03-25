/**
 * Registro ARINC importable (JSON/CSV/XML) y utilidades de fusión / lookup.
 * @module arinc-registry
 */

export const ARINC_REGISTRY_VERSION = 1;

/** Plantilla mínima para importación (una fila por label). */
export const ARINC_CSV_TEMPLATE =
    "label_oct,name,encoding,bits,lsb,scale,signed,units,min,max,ssm\n" +
    '310,IAS_EXAMPLE,bnr,19,,1,false,kt,0,450,"0,3"\n';

/** Definiciones demo integradas (mismo contrato que el registro de usuario). */
export const ARINC_BUILTIN_LABEL_DEFS = {
    "203": { name: "PITCH_ANGLE_DEMO", encoding: "bnr", signed: true, bits: 19, scale: 1, units: "deg", min: -90, max: 90, ssmAllowed: [0, 3] },
    "310": { name: "IAS_DEMO", encoding: "bnr", signed: false, bits: 19, scale: 1, units: "kt", min: 0, max: 450, ssmAllowed: [0, 3] },
    "271": { name: "ALTITUDE_BCD_DEMO", encoding: "bcd", signed: false, bits: 19, scale: 1, units: "ft", min: -1000, max: 60000, ssmAllowed: [0, 3] },
    default: { name: "GENERIC_ARINC", encoding: "bnr", signed: false, bits: 19, scale: 1, units: "", min: null, max: null, ssmAllowed: [0, 1, 2, 3] },
};

/** Campos lógicos para el modal de mapeo (valor = id guardado en arincImportColumnMap). */
export const ARINC_IMPORT_FIELD_IDS = [
    { id: "", key: "ignore", labelEs: "— Ignorar —", labelEn: "— Ignore —" },
    { id: "label_oct", key: "label_oct", labelEs: "Label (octal)", labelEn: "Label (octal)" },
    { id: "label_hex", key: "label_hex", labelEs: "Label (hexadecimal)", labelEn: "Label (hex)" },
    { id: "label_dec", key: "label_dec", labelEs: "Label (decimal)", labelEn: "Label (decimal)" },
    { id: "name", key: "name", labelEs: "Nombre señal", labelEn: "Signal name" },
    { id: "encoding", key: "encoding", labelEs: "Codificación (bnr/bcd/dis)", labelEn: "Encoding" },
    { id: "bits", key: "bits", labelEs: "Bits de datos", labelEn: "Data bits" },
    { id: "lsb", key: "lsb", labelEs: "LSB / resolución", labelEn: "LSB / resolution" },
    { id: "scale", key: "scale", labelEs: "Escala", labelEn: "Scale" },
    { id: "signed", key: "signed", labelEs: "Con signo (sí/no)", labelEn: "Signed" },
    { id: "units", key: "units", labelEs: "Unidades", labelEn: "Units" },
    { id: "min", key: "min", labelEs: "Mínimo", labelEn: "Min" },
    { id: "max", key: "max", labelEs: "Máximo", labelEn: "Max" },
    { id: "ssm", key: "ssm", labelEs: "SSM permitidos (lista)", labelEn: "SSM allowed" },
    { id: "dis_bit_index", key: "dis_bit_index", labelEs: "Índice bit DIS (formato largo)", labelEn: "DIS bit index" },
    { id: "dis_bit_name", key: "dis_bit_name", labelEs: "Nombre bit DIS (formato largo)", labelEn: "DIS bit name" },
];

function normEncoding(s) {
    const t = String(s || "").trim().toLowerCase();
    if (t === "dis" || t === "disc" || t === "discrete") return "discrete";
    if (t === "bcd") return "bcd";
    if (t === "bnr") return "bnr";
    return t || "bnr";
}

function parseBoolish(s) {
    const t = String(s || "").trim().toLowerCase();
    if (t === "1" || t === "true" || t === "yes" || t === "sí" || t === "si" || t === "y") return true;
    if (t === "0" || t === "false" || t === "no" || t === "n") return false;
    return null;
}

function parseNum(s) {
    if (s === null || s === undefined) return null;
    const t = String(s).trim();
    if (!t) return null;
    const n = Number(t.replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

function parseSsmList(s) {
    const t = String(s || "").trim();
    if (!t) return null;
    const parts = t.split(/[,;\s]+/).filter(Boolean);
    const out = [];
    for (const p of parts) {
        const n = parseInt(p, 10);
        if (Number.isFinite(n)) out.push(n);
    }
    return out.length ? out : null;
}

/** Normaliza octal 3 dígitos desde texto (oct / hex / dec). */
export function labelOctFromCell(val, radix) {
    const t = String(val ?? "").trim();
    if (!t) return null;
    let n;
    if (radix === "hex") {
        n = parseInt(t.replace(/^0x/i, ""), 16);
    } else if (radix === "dec") {
        n = parseInt(t, 10);
    } else {
        const o = t.replace(/^0o/i, "");
        if (/^[0-7]+$/.test(o)) n = parseInt(o, 8);
        else n = parseInt(t, 10);
    }
    if (!Number.isFinite(n) || n < 0 || n > 0xff) return null;
    return n.toString(8).padStart(3, "0");
}

/** Normaliza una entrada de label (import, formulario manual, fusión). */
export function normalizeLabelEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const enc = normEncoding(raw.encoding || "bnr");
    const bits = Math.max(1, Math.min(19, parseNum(raw.bits) ?? 19));
    const scale = parseNum(raw.scale);
    const min = parseNum(raw.min);
    const max = parseNum(raw.max);
    const lsb = parseNum(raw.lsb);
    let signed = raw.signed;
    if (typeof signed === "string") {
        const b = parseBoolish(signed);
        signed = b === null ? !!raw.signed : b;
    } else {
        signed = !!signed;
    }
    let ssmAllowed = raw.ssmAllowed;
    if (typeof ssmAllowed === "string") ssmAllowed = parseSsmList(ssmAllowed);
    if (!Array.isArray(ssmAllowed)) ssmAllowed = ARINC_BUILTIN_LABEL_DEFS.default.ssmAllowed;

    let discreteBits = raw.discreteBits;
    if (!Array.isArray(discreteBits)) discreteBits = [];
    discreteBits = discreteBits
        .map((b) => ({
            index: Math.max(0, Math.min(18, Math.floor(parseNum(b.index) ?? 0))),
            name: String(b.name || "").trim() || `bit_${b.index}`,
        }))
        .filter((b) => b.name)
        .sort((a, b) => a.index - b.index);

    const name = String(raw.name || "").trim() || "UNNAMED";

    return {
        name,
        encoding: enc,
        bits,
        scale: scale != null ? scale : 1,
        signed,
        units: String(raw.units || "").trim(),
        min: min != null ? min : null,
        max: max != null ? max : null,
        ssmAllowed,
        lsb: lsb != null && lsb !== 0 ? lsb : null,
        discreteBits,
    };
}

export function getArincLabelDef(userRegistry, labelOct) {
    const u = userRegistry && typeof userRegistry === "object" ? userRegistry[labelOct] : null;
    const b = ARINC_BUILTIN_LABEL_DEFS[labelOct];
    const base = {
        ...ARINC_BUILTIN_LABEL_DEFS.default,
        ...(b || {}),
        ...(u || {}),
    };
    return normalizeLabelEntry(base);
}

export function isArincLabelKnown(userRegistry, labelOct) {
    return !!((userRegistry && userRegistry[labelOct]) || ARINC_BUILTIN_LABEL_DEFS[labelOct]);
}

/** Normaliza el objeto raíz de un JSON de registro (p. ej. respuesta GET /api/avionics_registry). */
export function registryFromLabelsRoot(data) {
    if (!data || typeof data !== "object") throw new Error("JSON inválido");
    const v = data.version ?? data.registryVersion;
    if (v != null && Number(v) > ARINC_REGISTRY_VERSION) {
        throw new Error(`Versión de registro no soportada: ${v}`);
    }
    const labels = data.labels && typeof data.labels === "object" ? data.labels : data;
    if (typeof labels !== "object" || labels === null) throw new Error("JSON sin objeto labels");
    const out = {};
    for (const [k, raw] of Object.entries(labels)) {
        if (k === "default") continue;
        const oct = labelOctFromCell(k, "oct") || (k.length === 3 && /^[0-7]+$/.test(k) ? k : null);
        if (!oct) continue;
        const n = normalizeLabelEntry({ ...raw, name: raw.name || k });
        if (n) out[oct] = n;
    }
    return out;
}

export function parseRegistryJson(text) {
    return registryFromLabelsRoot(JSON.parse(text));
}

function isDisImportStub(inc, octKey) {
    if (!inc || normEncoding(inc.encoding) !== "discrete") return false;
    const n = String(inc.name || "").trim();
    return n === `DIS_${octKey}` || /^DIS_[0-7]{3}$/.test(n);
}

export function serializeRegistryJson(labels, opts = {}) {
    const { includeBuiltins = false } = opts;
    const merged = { ...labels };
    if (includeBuiltins) {
        for (const [k, v] of Object.entries(ARINC_BUILTIN_LABEL_DEFS)) {
            if (k === "default") continue;
            if (!merged[k]) merged[k] = v;
        }
    }
    return JSON.stringify(
        { version: ARINC_REGISTRY_VERSION, labels: merged, exportedAt: new Date().toISOString() },
        null,
        2
    );
}

export function mergeRegistries(existing, incoming, mode) {
    const ex = existing && typeof existing === "object" ? { ...existing } : {};
    if (mode === "replace") {
        return { ...incoming };
    }
    for (const [oct, inc] of Object.entries(incoming || {})) {
        if (!inc || typeof inc !== "object") continue;
        const prev = ex[oct] || {};
        const merged = { ...prev, ...inc };
        if (Array.isArray(inc.discreteBits) && inc.discreteBits.length > 0) {
            const byIdx = new Map();
            for (const b of prev.discreteBits || []) byIdx.set(b.index, b);
            for (const b of inc.discreteBits) byIdx.set(b.index, b);
            merged.discreteBits = [...byIdx.values()].sort((a, b) => a.index - b.index);
        }
        if (
            Object.keys(prev).length > 0 &&
            isDisImportStub(inc, oct) &&
            normEncoding(prev.encoding) !== "discrete"
        ) {
            merged.name = prev.name;
            merged.encoding = prev.encoding;
            merged.bits = prev.bits;
            merged.scale = prev.scale;
            merged.signed = prev.signed;
            merged.units = prev.units;
            merged.min = prev.min;
            merged.max = prev.max;
            merged.lsb = prev.lsb;
            merged.ssmAllowed = prev.ssmAllowed;
        }
        ex[oct] = normalizeLabelEntry(merged);
    }
    return ex;
}

export function detectDelimiter(headerLine) {
    const tab = (headerLine.match(/\t/g) || []).length;
    const com = (headerLine.match(/,/g) || []).length;
    return tab >= com ? "\t" : ",";
}

function parseCsvLine(line, delim) {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (q && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                q = !q;
            }
        } else if (!q && c === delim) {
            out.push(cur);
            cur = "";
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

/** Devuelve { headers, rows } donde cada fila es objeto header->valor. */
export function parseDelimitedText(text) {
    const lines = String(text || "").split(/\r?\n/).filter((ln) => ln.length > 0);
    if (lines.length < 2) throw new Error("CSV vacío o sin datos");
    const delim = detectDelimiter(lines[0]);
    const headers = parseCsvLine(lines[0], delim).map((h) => h.replace(/^\ufeff/, ""));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = parseCsvLine(lines[i], delim);
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = cells[j] != null ? cells[j] : "";
        }
        rows.push(row);
    }
    return { headers, rows, delim };
}

/**
 * Convierte XML con hijos homogéneos del root en tabla { headers, rows }.
 * Cada elemento hijo con subelementos → una fila; columnas = nombres de tag.
 */
export function xmlToTabularRows(xmlString) {
    const doc = new DOMParser().parseFromString(String(xmlString || ""), "application/xml");
    const perr = doc.querySelector("parsererror");
    if (perr) return { error: "xml_parse" };
    const root = doc.documentElement;
    if (!root) return { error: "xml_empty" };
    const children = [...root.children].filter((c) => c.children && c.children.length > 0);
    if (children.length === 0) return { error: "no_rows" };
    const keySet = new Set();
    for (const el of children) {
        for (const ch of el.children) keySet.add(ch.tagName);
    }
    const headers = [...keySet];
    const rows = children.map((el) => {
        const row = Object.fromEntries(headers.map((h) => [h, ""]));
        for (const ch of el.children) {
            if (row[ch.tagName] !== undefined) row[ch.tagName] = ch.textContent?.trim() ?? "";
        }
        return row;
    });
    return { headers, rows };
}

function rowGet(row, headerName) {
    if (!headerName) return "";
    return row[headerName] != null ? String(row[headerName]) : "";
}

/**
 * importMode: 'labels' | 'dis_bits'
 * mapping: { [csvHeader]: fieldId }
 * labelRadix: 'oct'|'hex'|'dec' — columna label_* según mapping
 */
export function buildRegistryFromMappedRows(headers, rows, mapping, importMode, labelRadix) {
    const inv = {};
    for (const [csvCol, fieldId] of Object.entries(mapping || {})) {
        if (fieldId) inv[fieldId] = csvCol;
    }

    function labelOctFromRow(row) {
        if (inv.label_oct) {
            return labelOctFromCell(rowGet(row, inv.label_oct), "oct");
        }
        if (inv.label_hex) {
            return labelOctFromCell(rowGet(row, inv.label_hex), "hex");
        }
        if (inv.label_dec) {
            return labelOctFromCell(rowGet(row, inv.label_dec), "dec");
        }
        return null;
    }

    if (importMode === "dis_bits") {
        const bitsByLabel = {};
        for (const row of rows) {
            const oct = labelOctFromRow(row);
            if (!oct) continue;
            const bi = parseNum(rowGet(row, inv.dis_bit_index));
            const bn = String(rowGet(row, inv.dis_bit_name) || "").trim();
            if (!Number.isFinite(bi) || !bn) continue;
            if (!bitsByLabel[oct]) bitsByLabel[oct] = [];
            bitsByLabel[oct].push({ index: Math.floor(bi), name: bn });
        }
        const out = {};
        for (const [oct, bits] of Object.entries(bitsByLabel)) {
            out[oct] = normalizeLabelEntry({
                name: `DIS_${oct}`,
                encoding: "discrete",
                bits: 19,
                discreteBits: bits,
            });
        }
        return out;
    }

    const out = {};
    for (const row of rows) {
        const oct = labelOctFromRow(row);
        if (!oct) continue;
        const partial = {};
        if (inv.name) partial.name = rowGet(row, inv.name);
        if (inv.encoding) partial.encoding = rowGet(row, inv.encoding);
        if (inv.bits) partial.bits = rowGet(row, inv.bits);
        if (inv.lsb) partial.lsb = rowGet(row, inv.lsb);
        if (inv.scale) partial.scale = rowGet(row, inv.scale);
        if (inv.signed) partial.signed = rowGet(row, inv.signed);
        if (inv.units) partial.units = rowGet(row, inv.units);
        if (inv.min) partial.min = rowGet(row, inv.min);
        if (inv.max) partial.max = rowGet(row, inv.max);
        if (inv.ssm) partial.ssmAllowed = rowGet(row, inv.ssm);
        const prev = out[oct] || {};
        out[oct] = normalizeLabelEntry({ ...prev, ...partial });
    }
    return out;
}

export function guessMappingFromHeaders(headers, savedMap) {
    const lower = (h) => String(h || "").toLowerCase().replace(/\s+/g, "_");
    const patterns = [
        { id: "label_oct", keys: ["label_oct", "octal", "oct_label", "label_o", "l_oct", "lbl_oct"] },
        { id: "label_hex", keys: ["label_hex", "label_h"] },
        { id: "label_dec", keys: ["label_dec", "lbl_dec"] },
        { id: "name", keys: ["name", "nombre", "signal", "signal_name", "parametro", "parameter"] },
        { id: "encoding", keys: ["encoding", "codificacion", "codificación", "enc", "type"] },
        { id: "bits", keys: ["bits", "nbits", "n_bits"] },
        { id: "lsb", keys: ["lsb", "resolution", "resolucion", "resolución", "lsb_weight"] },
        { id: "scale", keys: ["scale", "escala"] },
        { id: "signed", keys: ["signed", "sign", "con_signo"] },
        { id: "units", keys: ["units", "unidades", "unit"] },
        { id: "min", keys: ["min", "minimum", "minimo"] },
        { id: "max", keys: ["max", "maximum", "maximo"] },
        { id: "ssm", keys: ["ssm", "ssm_allowed", "ssmallow"] },
        { id: "dis_bit_index", keys: ["bit_index", "bit_idx", "bit_number"] },
        { id: "dis_bit_name", keys: ["bit_name", "bitname", "discrete_name"] },
    ];
    const map = {};
    for (const h of headers) {
        if (savedMap && Object.prototype.hasOwnProperty.call(savedMap, h) && savedMap[h]) {
            map[h] = savedMap[h];
            continue;
        }
        const lu = lower(h);
        let m = "";
        outer: for (const p of patterns) {
            for (const k of p.keys) {
                if (lu === k || lu.endsWith("_" + k) || lu.startsWith(k + "_")) {
                    m = p.id;
                    break outer;
                }
            }
        }
        map[h] = m;
    }
    return map;
}
