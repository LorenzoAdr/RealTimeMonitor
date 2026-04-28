import { describe, it, expect } from "vitest";
import { replayRefAlarmComputeAlarming } from "../../web_monitor/static/js/modules/replay_ref_alarm_eval.mjs";

describe("replayRefAlarmComputeAlarming", () => {
    it("dispara cuando err > tol (sin histéresis previa)", () => {
        expect(replayRefAlarmComputeAlarming(false, 1.1, 1.0, 0).alarming).toBe(true);
        expect(replayRefAlarmComputeAlarming(false, 0.9, 1.0, 0).alarming).toBe(false);
    });

    it("con prevActive, limpia cuando err <= tol - hys", () => {
        expect(replayRefAlarmComputeAlarming(true, 2.0, 4.0, 1.0).alarming).toBe(false);
    });

    it("con prevActive, mantiene zona de disparo con err > tol - hys", () => {
        expect(replayRefAlarmComputeAlarming(true, 3.5, 4.0, 1.0).alarming).toBe(true);
    });

    it("NaN no dispara", () => {
        expect(replayRefAlarmComputeAlarming(false, NaN, 1, 0).alarming).toBe(false);
    });
});
