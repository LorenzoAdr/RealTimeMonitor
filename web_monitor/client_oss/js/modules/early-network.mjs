/**
 * Calentamiento ligero de red al arrancar en modo live.
 * No abre WebSocket aquí para evitar efectos colaterales con intentos de auth.
 */

function readAppMode() {
  try {
    const raw = globalThis.localStorage?.getItem("varmon_config");
    if (!raw) return "";
    const cfg = JSON.parse(raw);
    return String(cfg?.appMode || "").toLowerCase();
  } catch (_) {
    return "";
  }
}

function isLiveLikeMode() {
  const mode = readAppMode();
  return mode === "live" || mode === "replay" || mode === "";
}

export async function startEarlyWebSocketIfLive() {
  if (typeof fetch !== "function") return null;
  if (!isLiveLikeMode()) return null;
  const opts = { cache: "no-store" };
  const tasks = [
    fetch("/api/auth_status", opts).catch(() => null),
    fetch("/api/connection_info", opts).catch(() => null),
  ];
  try {
    await Promise.all(tasks);
  } catch (_) {
    /* ignore */
  }
  return null;
}
