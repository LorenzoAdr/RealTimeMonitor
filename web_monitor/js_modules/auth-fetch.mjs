/**
 * Inyecta cabeceras de autenticación en fetch para APIs del backend.
 * - X-VarMon-Password: contraseña global
 * - X-VarMon-Sensitive-Password: contraseña de modos sensibles
 *
 * Este módulo se importa al arrancar (entry.mjs) y es idempotente.
 */

const FETCH_PATCH_FLAG = "__VARMON_AUTH_FETCH_PATCHED__";

function isApiRequest(input) {
  try {
    const raw = typeof input === "string" ? input : input?.url || "";
    if (!raw) return false;
    const u = new URL(raw, globalThis.location?.origin || "http://localhost");
    if (!u.pathname.startsWith("/api/")) return false;
    if (globalThis.location?.origin && u.origin !== globalThis.location.origin) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function readSessionAuthHeaders() {
  let globalPwd = "";
  let sensitivePwd = "";
  try {
    globalPwd = (globalThis.sessionStorage?.getItem("varmon_password") || "").trim();
    sensitivePwd = (globalThis.sessionStorage?.getItem("varmon_sensitive_password") || "").trim();
  } catch (_) {
    /* ignore storage failures */
  }
  const out = {};
  if (globalPwd) out["X-VarMon-Password"] = globalPwd;
  if (sensitivePwd) out["X-VarMon-Sensitive-Password"] = sensitivePwd;
  return out;
}

function patchFetch() {
  if (typeof globalThis.fetch !== "function") return;
  if (globalThis[FETCH_PATCH_FLAG]) return;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const wrapped = (input, init = undefined) => {
    if (!isApiRequest(input)) return nativeFetch(input, init);
    const extra = readSessionAuthHeaders();
    if (!Object.keys(extra).length) return nativeFetch(input, init);
    const mergedInit = { ...(init || {}) };
    const h = new Headers(init?.headers || (input && typeof input !== "string" ? input.headers : undefined) || {});
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    mergedInit.headers = h;
    return nativeFetch(input, mergedInit);
  };
  globalThis.fetch = wrapped;
  globalThis[FETCH_PATCH_FLAG] = true;
}

patchFetch();

export {};
