/**
 * Promise que resuelve cuando `globalThis.Plotly` está disponible.
 * Usado por plugins (MAVLink health, informe análisis) y por el cliente OSS al cargar gráficos.
 * Si el cliente principal ya inyectó Plotly, se resuelve al instante; si no, carga un bundle público.
 */
function ensurePlotlyScript() {
    if (typeof globalThis !== "undefined" && globalThis.Plotly) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const existing = document.querySelector("script[data-varmon-plotly-bootstrap]");
        if (existing) {
            existing.addEventListener("load", () => resolve());
            existing.addEventListener("error", () => reject(new Error("Plotly script error")));
            return;
        }
        const s = document.createElement("script");
        s.setAttribute("data-varmon-plotly-bootstrap", "1");
        s.src = "https://cdn.plot.ly/plotly-2.35.3.min.js";
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("No se pudo cargar Plotly desde CDN"));
        (document.head || document.documentElement).appendChild(s);
    });
}

export const plotlyReady = ensurePlotlyScript();
