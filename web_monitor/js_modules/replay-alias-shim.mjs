/**
 * Subconjunto mínimo para persistencia de config cuando el plugin Pro
 * «replay_alias» no está cargado (migración de mapas legacy).
 * La lógica completa vive en tool_plugins/js/src/replay-alias.mjs.
 */

export const REPLAY_ALIAS_PROFILES_MAX = 32;

export function normalizeReplayAliasMap(raw) {
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        const from = String(k || "").trim();
        const to = String(v ?? "").trim();
        if (!from || !to) continue;
        out[from] = to;
    }
    return out;
}

export function normalizeReplayAliasBindingEntry(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && ("map" in raw || "disabled" in raw || "meta" in raw)) {
        const o = raw;
        return {
            map: normalizeReplayAliasMap(o.map && typeof o.map === "object" ? o.map : {}),
            disabled: !!o.disabled,
            meta: o.meta && typeof o.meta === "object" && !Array.isArray(o.meta) ? { ...o.meta } : {},
        };
    }
    return {
        map: normalizeReplayAliasMap(raw && typeof raw === "object" ? raw : {}),
        disabled: false,
        meta: {},
    };
}

export function migrateReplayAliasBindingsFromConfig(cfgLegacy) {
    if (!cfgLegacy || typeof cfgLegacy !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(cfgLegacy)) {
        out[k] = normalizeReplayAliasBindingEntry(v);
    }
    return out;
}

export function clipReplayAliasProfiles(profiles, max = REPLAY_ALIAS_PROFILES_MAX) {
    if (!profiles || typeof profiles !== "object") return {};
    const keys = Object.keys(profiles).sort((a, b) => {
        const ta = profiles[a] && profiles[a].updatedAt ? String(profiles[a].updatedAt) : "";
        const tb = profiles[b] && profiles[b].updatedAt ? String(profiles[b].updatedAt) : "";
        return tb.localeCompare(ta) || a.localeCompare(b);
    });
    const out = {};
    for (let i = 0; i < keys.length && i < max; i++) {
        const k = keys[i];
        out[k] = profiles[k];
    }
    return out;
}

/** Núcleo compartido con tool_plugins/replay-alias.mjs — offline debe funcionar sin el bundle de plugins. */

export function stampReplaySourceNames(ds) {
    if (!ds || !Array.isArray(ds.samples)) return;
    for (const s of ds.samples) {
        for (const e of s.data || []) {
            if (e && typeof e.name === "string" && e._replaySourceName == null) {
                e._replaySourceName = e.name;
            }
        }
    }
}

function rebuildDatasetNamesFromSamples(ds) {
    const namesSet = new Set();
    for (const s of ds.samples || []) {
        for (const e of s.data || []) {
            if (e && e.name) namesSet.add(e.name);
        }
    }
    ds.names = Array.from(namesSet).sort();
}

export function resetReplayNamesToSource(ds) {
    if (!ds || !Array.isArray(ds.samples)) return;
    stampReplaySourceNames(ds);
    for (const s of ds.samples) {
        for (const e of s.data || []) {
            if (e && typeof e._replaySourceName === "string") {
                e.name = e._replaySourceName;
            }
        }
    }
    rebuildDatasetNamesFromSamples(ds);
}

export function collectUniqueReplaySourceNames(ds) {
    const set = new Set();
    if (!ds || !Array.isArray(ds.samples)) return [];
    for (const s of ds.samples) {
        for (const e of s.data || []) {
            const src = e && (e._replaySourceName != null ? e._replaySourceName : e.name);
            if (typeof src === "string" && src) set.add(src);
        }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function normalizeReplayAliasMapFull(raw) {
    return normalizeReplayAliasMap(raw);
}

function detectReplayAliasCollisionsFull(map) {
    const byTarget = new Map();
    for (const [from, to] of Object.entries(map || {})) {
        if (!byTarget.has(to)) byTarget.set(to, []);
        byTarget.get(to).push(from);
    }
    const duplicateTargets = [];
    for (const [target, sources] of byTarget.entries()) {
        if (sources.length > 1) duplicateTargets.push({ target, sources: sources.slice().sort() });
    }
    return { duplicateTargets };
}

export function applyReplayAliasesInPlace(ds, aliasMap) {
    stampReplaySourceNames(ds);
    const norm = normalizeReplayAliasMapFull(aliasMap);
    const { duplicateTargets } = detectReplayAliasCollisionsFull(norm);
    if (duplicateTargets.length > 0) {
        return { ok: false, duplicateTargets, error: "collision" };
    }
    for (const s of ds.samples || []) {
        for (const e of s.data || []) {
            if (!e || typeof e._replaySourceName !== "string") continue;
            const to = norm[e._replaySourceName];
            e.name = to != null ? to : e._replaySourceName;
        }
    }
    rebuildDatasetNamesFromSamples(ds);
    return { ok: true, duplicateTargets: [] };
}
