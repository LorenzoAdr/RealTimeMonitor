/**
 * Sistema de plugins para VarMonitor (frontend).
 *
 * Rama legacy/core-shm-v2-py-js: solo se registran extensiones de análisis/replay
 * (replay_alias, replay_ref_alarms, anomaly, segments). No se carga el bundle
 * `static/plugins/` ni se aceptan otros ids desde la API.
 */

/** @type {Record<string, object>} */
const _plugins = {};
/** @type {Record<string, Function[]>} */
const _hooks = {};
const _pluginAppModes = {};

export const LEGACY_ALLOWED_PLUGIN_IDS = ["replay_alias", "replay_ref_alarms", "anomaly", "segments"];

function _allowedPluginId(id) {
    return typeof id === "string" && LEGACY_ALLOWED_PLUGIN_IDS.includes(id);
}

export function registerPlugin(id, meta = {}) {
    if (!_allowedPluginId(id)) return;
    _plugins[id] = meta;
    console.log(`[VarMonitor] Plugin registrado: ${id}`);
}

export function registerHook(name, fn) {
    if (typeof fn !== "function") return;
    (_hooks[name] ||= []).push(fn);
}

export function registerAppMode(id, meta = {}) {
    if (!_allowedPluginId(id)) return;
    if (!id || typeof id !== "string") return;
    _pluginAppModes[id] = {
        bodyClass: meta.bodyClass || `mode-plugin-${id.replace(/[^a-z0-9_-]/gi, "_")}`,
        labelFallback: meta.labelFallback || id,
        labelKey: meta.labelKey || "",
        needsBackendConnection: !!meta.needsBackendConnection,
        onEnter: typeof meta.onEnter === "function" ? meta.onEnter : null,
        onLeave: typeof meta.onLeave === "function" ? meta.onLeave : null,
    };
    console.log(`[VarMonitor] Modo de app registrado (plugin): ${id}`);
}

export function hasRegisteredAppMode(id) {
    return typeof id === "string" && id in _pluginAppModes;
}

export function getRegisteredAppModeMeta(id) {
    return _pluginAppModes[id] || null;
}

export function getRegisteredAppModeIds() {
    return Object.keys(_pluginAppModes).sort();
}

export function fireHook(name, ...args) {
    const results = [];
    for (const fn of _hooks[name] || []) {
        try {
            results.push(fn(...args));
        } catch (e) {
            console.error(`[VarMonitor] Error en hook ${name}:`, e);
        }
    }
    return results;
}

export function fireHookChain(name, value, ...args) {
    for (const fn of _hooks[name] || []) {
        try {
            const result = fn(value, ...args);
            if (result !== undefined && result !== null) {
                value = result;
            }
        } catch (e) {
            console.error(`[VarMonitor] Error en hook chain ${name}:`, e);
        }
    }
    return value;
}

export function hasPlugin(id) {
    return id in _plugins;
}

export function getRegisteredPluginIds() {
    return Object.keys(_plugins).sort();
}

export function getPluginMeta(id) {
    return _plugins[id] || null;
}

export function getHooks() {
    const out = {};
    for (const [name, fns] of Object.entries(_hooks)) {
        if (fns.length > 0) out[name] = fns.length;
    }
    return out;
}

let _pluginBundleInitialized = false;
let _backendFeaturesAtLoad = [];
let _pluginJsBundleStatus = "skipped";
let _pluginJsBundleSrc = null;

export function getClientPluginDiagnostics() {
    return {
        backendFeaturesAtLoad: _backendFeaturesAtLoad.slice(),
        pluginJsBundleStatus: _pluginJsBundleStatus,
        pluginJsBundleSrc: _pluginJsBundleSrc,
        plugins: Object.entries(_plugins).map(([id, meta]) => ({
            id,
            version: meta.version,
            builtin: !!meta.builtin,
            source: meta.source || (meta.builtin ? "oss" : "external"),
        })),
        hooks: getHooks(),
        initialized: _pluginBundleInitialized,
    };
}

const _FEATURES_FETCH_MS = 5000;

async function fetchFeaturesJson() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), _FEATURES_FETCH_MS);
    try {
        const resp = await fetch("/api/plugins/features", { signal: ctrl.signal });
        clearTimeout(t);
        return resp;
    } catch {
        clearTimeout(t);
        return null;
    }
}

export async function loadExternalPlugins() {
    if (_pluginBundleInitialized) return;
    _pluginBundleInitialized = true;
    _backendFeaturesAtLoad = [];
    _pluginJsBundleSrc = null;
    try {
        const resp = await fetchFeaturesJson();
        if (resp && resp.ok) {
            const data = await resp.json();
            _backendFeaturesAtLoad = Array.isArray(data.features) ? data.features.slice() : [];
        }
    } catch {
        /* ignorar */
    }
    _pluginJsBundleStatus = "legacy_core_only";
    for (const fid of _backendFeaturesAtLoad) {
        if (fid && _allowedPluginId(fid) && !hasPlugin(fid)) {
            registerPlugin(fid, { version: "api", source: "backend" });
        }
    }
    for (const id of LEGACY_ALLOWED_PLUGIN_IDS) {
        if (!hasPlugin(id)) {
            registerPlugin(id, { version: "stub", builtin: true, source: "legacy-core" });
        }
    }
}

export function _reset() {
    for (const k of Object.keys(_plugins)) delete _plugins[k];
    for (const k of Object.keys(_hooks)) delete _hooks[k];
    for (const k of Object.keys(_pluginAppModes)) delete _pluginAppModes[k];
    _pluginBundleInitialized = false;
    _backendFeaturesAtLoad = [];
    _pluginJsBundleStatus = "skipped";
    _pluginJsBundleSrc = null;
}
