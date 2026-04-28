/**
 * Funciones puras extraídas de app-legacy.mjs para unit testing.
 * Se copian aquí porque el monolito no tiene exports y depende de DOM/globals.
 */

export function reverseBits8(x) {
    let v = x & 0xFF;
    let r = 0;
    for (let i = 0; i < 8; i++) {
        r = (r << 1) | (v & 1);
        v >>= 1;
    }
    return r & 0xFF;
}

export function popcount32(x) {
    let v = x >>> 0;
    let c = 0;
    while (v) {
        v &= (v - 1);
        c++;
    }
    return c;
}

export function decodeBcd(raw, bits) {
    const nibbles = Math.max(1, Math.floor(bits / 4));
    let out = "";
    for (let i = nibbles - 1; i >= 0; i--) {
        const d = (raw >>> (i * 4)) & 0xF;
        if (d > 9) return Number.NaN;
        out += String(d);
    }
    return Number(out);
}

export function formatBytes(n) {
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

export function trimTextToFullLines(text) {
    const src = String(text || "");
    const idx = src.lastIndexOf("\n");
    if (idx < 0) return src;
    return src.slice(0, idx + 1);
}

export function parseCell(raw) {
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

export function formatAdvNum(v) {
    if (v == null || typeof v !== "number" || isNaN(v)) return "—";
    if (v >= 100) return v.toFixed(0);
    if (v >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

export function escapeLogHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function logLineClass(line) {
    const l = line.toLowerCase();
    if (/\b(200|ok|success)\b/.test(l) || /-> 200\b/.test(line)) return "log-line-ok";
    if (/\b(500|404|503|error|exception|failed|fail|incorrecta|denied)\b/.test(l) || /-> (4|5)\d{2}\b/.test(line)) return "log-line-error";
    if (/\[varmonitor shm\]/i.test(line)) {
        if (/pérdida|perdida/i.test(line)) return "log-line-error";
        if (/warning/i.test(line)) return "log-line-warn";
    }
    if (/\b(4\d{2}|warn|warning|aviso)\b/.test(l)) return "log-line-warn";
    if (/\[req\]/.test(l)) return "log-line-req";
    return "";
}

export function binarySearchSampleIndex(samples, ts) {
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

export function movingAverage(values, windowSize) {
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

export function downsampleSeries(xs, ys, maxPoints) {
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

export function rangesAlmostEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) return false;
    return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

export function buildTree(names) {
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

export function collectLeaves(node) {
    const result = [];
    for (const name of node._leaves) result.push(name);
    for (const child of node._children.values()) {
        result.push(...collectLeaves(child));
    }
    return result;
}

export function collectGroupPaths(node, prefix, out) {
    for (const [key, child] of node._children) {
        const fullPath = prefix ? prefix + "." + key : key;
        out.push(fullPath);
        collectGroupPaths(child, fullPath, out);
    }
    return out;
}

export function computeGenValue(type, p, t) {
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
        case "pulse": {
            return (t >= p.delay && t < p.delay + p.dur) ? p.base + p.amp : p.base;
        }
        default:
            return 0;
    }
}

export function lengthToMeters(v, unit) {
    if (unit === "ft") return v * 0.3048;
    if (unit === "nmi") return v * 1852;
    return v;
}
export function metersToLength(m, unit) {
    if (unit === "ft") return m / 0.3048;
    if (unit === "nmi") return m / 1852;
    return m;
}
export function massToKg(v, unit) {
    return unit === "lb" ? v * 0.45359237 : v;
}
const KNOT_TO_MS = 1852 / 3600;
export function speedToMs(v, unit) {
    if (unit === "kmh") return v / 3.6;
    if (unit === "knot") return v * KNOT_TO_MS;
    return v;
}
export function angleToRad(v, unit) {
    return unit === "deg" ? v * (Math.PI / 180) : v;
}
export function dmsRawToDecimalDegrees(raw, from) {
    if (from === "min") return raw / 60;
    if (from === "sec") return raw / 3600;
    return raw;
}

export function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
