/**
 * Evaluación pura de alarma «error vs tolerancia» con histéresis (replay |live−ref| vs tol).
 * Misma semántica que un umbral alto en checkAlarmEntry (solo Hi, sin Lo).
 */

/**
 * @param {boolean} prevActive — si la alarma ya estaba activa (histéresis de desactivación)
 * @param {number} err — |live − ref| (≥ 0)
 * @param {number} tol — tolerancia máxima admitida sin disparar
 * @param {number} hys — histéresis (no negativa)
 * @returns {{ alarming: boolean }}
 */
export function replayRefAlarmComputeAlarming(prevActive, err, tol, hys) {
    const h = Number.isFinite(hys) ? Math.max(0, hys) : 0;
    if (!Number.isFinite(err) || !Number.isFinite(tol)) {
        return { alarming: false };
    }
    let over = err > tol;
    if (prevActive) {
        if (err <= tol - h) {
            return { alarming: false };
        }
        over = err > tol - h;
    }
    return { alarming: over };
}
