/**
 * Plotly se carga sin bloquear el HTML ni el primer parseo del bundle de la app.
 * El CDN inyecta `globalThis.Plotly` (script clásico, no ES module).
 */
const PLOTLY_CDN = "https://cdn.plot.ly/plotly-2.27.0.min.js";

let _promise = null;

export function loadPlotly() {
    if (typeof globalThis.Plotly !== "undefined") {
        return Promise.resolve(globalThis.Plotly);
    }
    if (_promise) return _promise;
    _promise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = PLOTLY_CDN;
        s.async = true;
        s.onload = () => {
            if (typeof globalThis.Plotly !== "undefined") {
                resolve(globalThis.Plotly);
            } else {
                reject(new Error("Plotly no está disponible tras cargar el script"));
            }
        };
        s.onerror = () => reject(new Error("No se pudo cargar Plotly desde el CDN"));
        document.head.appendChild(s);
    });
    return _promise;
}

/** Promesa que resuelve cuando `Plotly` está en `globalThis` (empieza al importar este módulo). */
export const plotlyReady = loadPlotly();
