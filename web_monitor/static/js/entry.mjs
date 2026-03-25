/**
 * Punto de entrada:
 * 1) Plotly en paralelo (script async).
 * 2) fetch + WebSocket en microtareas antes de parsear app-legacy.mjs (~470KB), para no dejar el WS "en cola" decenas de s.
 * 3) app-legacy en el siguiente macrotask (import dinámico).
 */
import { plotlyReady } from "./modules/plotly-bootstrap.mjs";
import { startEarlyWebSocketIfLive } from "./modules/early-network.mjs";

plotlyReady.catch((e) => console.error("[VarMonitor] Plotly:", e));
void startEarlyWebSocketIfLive().catch((e) => console.warn("[VarMonitor] early network:", e));

setTimeout(() => {
    import("./app-legacy.mjs").catch((e) => console.error("[VarMonitor] app:", e));
}, 0);
