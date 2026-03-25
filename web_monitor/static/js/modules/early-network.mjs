/**
 * Arranque de red antes de importar app-legacy.mjs (~470KB).
 * Sin esto, el WebSocket queda "en cola" en DevTools hasta que termina de evaluarse todo el módulo.
 */
const STORAGE_KEY = "varmon_config";

function readConfigModeAndInstance() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { mode: "live", instance: "" };
        const cfg = JSON.parse(raw);
        const mode = cfg.appMode === "offline" || cfg.appMode === "replay" || cfg.appMode === "live" || cfg.appMode === "arinc_registry"
            ? cfg.appMode
            : "live";
        const instance = typeof cfg.instance === "string" ? cfg.instance.trim() : "";
        return { mode, instance };
    } catch {
        return { mode: "live", instance: "" };
    }
}

function pickUdsPath(instances, savedInstance) {
    if (!Array.isArray(instances) || instances.length === 0) return "";
    if (savedInstance.startsWith("uds:")) {
        const p = savedInstance.slice(4);
        if (instances.some((i) => i && i.uds_path === p)) return p;
    }
    // Sin instancia guardada: mismo criterio que effectiveUdsPathForWs() con select vacío (sin query uds_path).
    return "";
}

/**
 * Intenta abrir el WebSocket en el mismo tick que termina entry.mjs (microtareas)
 * antes del setTimeout(0) que carga app-legacy.
 */
export async function startEarlyWebSocketIfLive() {
    const { mode, instance } = readConfigModeAndInstance();
    if (mode === "offline") return;

    try {
        const ar = await fetch("/api/auth_required");
        const auth = await ar.json();
        if (auth && auth.auth_required && !sessionStorage.getItem("varmon_password")) {
            return;
        }
    } catch {
        return;
    }

    let ci = null;
    try {
        const r = await fetch("/api/connection_info");
        ci = r.ok ? await r.json() : null;
    } catch {
        ci = null;
    }
    const user = (ci && ci.current_user) ? encodeURIComponent(ci.current_user) : "";
    const udsUrl = user ? `/api/uds_instances?user=${user}` : "/api/uds_instances";
    let instances = [];
    try {
        const r = await fetch(udsUrl);
        const u = r.ok ? await r.json() : null;
        instances = (u && Array.isArray(u.instances)) ? u.instances : [];
        if (instances.length === 0 && user) {
            const r2 = await fetch("/api/uds_instances");
            const u2 = r2.ok ? await r2.json() : null;
            instances = (u2 && Array.isArray(u2.instances)) ? u2.instances : [];
        }
    } catch {
        instances = [];
    }

    const path = pickUdsPath(instances, instance);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams();
    if (path) qs.set("uds_path", path);
    const storedPass = sessionStorage.getItem("varmon_password");
    if (storedPass) qs.set("password", storedPass);
    const qp = qs.toString();
    const url = qp ? `${proto}//${location.host}/ws?${qp}` : `${proto}//${location.host}/ws`;

    const messageBuffer = [];
    const socket = new WebSocket(url);
    socket.onmessage = (e) => {
        const d = typeof e.data === "string" ? e.data : "";
        messageBuffer.push(d);
    };
    socket.onerror = () => {
        try { socket.close(); } catch (err) { /* ignore */ }
    };

    globalThis.__varmonWsPendingAdopt = {
        socket,
        udsPath: path || null,
        messageBuffer,
    };
}
