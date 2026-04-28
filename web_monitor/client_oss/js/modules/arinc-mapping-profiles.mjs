/**
 * Perfiles de mapeo CSV → campos ARINC (reutilizable y testeable).
 * @module arinc-mapping-profiles
 */

import { guessMappingFromHeaders } from "./arinc-registry.mjs";

export const ARINC_PROFILE_NAME_MAX = 64;
export const ARINC_PROFILES_MAX = 48;

/** @param {string} name */
export function sanitizeArincProfileName(name) {
    const t = String(name || "").trim().slice(0, ARINC_PROFILE_NAME_MAX);
    return t.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Combina el mapa de sesión con el de un perfil (el perfil tiene prioridad en claves coincidentes).
 * @param {Record<string,string>} sessionMap
 * @param {Record<string,string>|null|undefined} profileMap
 */
export function mergeColumnMapsForImport(sessionMap, profileMap) {
    const s = sessionMap && typeof sessionMap === "object" ? { ...sessionMap } : {};
    const p = profileMap && typeof profileMap === "object" ? profileMap : {};
    return { ...s, ...p };
}

/**
 * @param {string[]} headers
 * @param {Record<string,string>} sessionColumnMap
 * @param {Record<string,string>|null|undefined} profileColumnMap
 */
export function buildImportMapping(headers, sessionColumnMap, profileColumnMap) {
    const merged = mergeColumnMapsForImport(sessionColumnMap, profileColumnMap);
    return guessMappingFromHeaders(headers, merged);
}

/**
 * @param {Record<string, { columnMap?: Record<string,string> }>} profiles
 * @param {string} name
 */
export function clipProfiles(profiles, max = ARINC_PROFILES_MAX) {
    const keys = Object.keys(profiles || {});
    if (keys.length <= max) return { ...profiles };
    keys.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const drop = keys.slice(0, keys.length - max);
    const out = { ...profiles };
    for (const k of drop) delete out[k];
    return out;
}
