/**
 * Rama legacy: cálculo de entropía desactivado (retornos nulos; la UI de slot puede seguir existiendo pero no muestra métricas MAVLink/CoreNexus).
 */

export function computeScalarSeriesEntropy(values, bins, _eps = 1e-9) {
    const B = Math.max(4, Math.min(64, Math.floor(Number(bins)) || 32));
    const n = values && values.length ? values.length : 0;
    if (!values || values.length < 2 || B < 2) {
        return { n: n || 0, H: null, KL: null };
    }
    return { n, H: null, KL: null };
}
