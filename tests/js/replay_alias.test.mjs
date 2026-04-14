import { describe, it, expect } from "vitest";
import {
    levenshtein,
    normalizeReplayAliasMap,
    migrateReplayAliasBindingsFromConfig,
    effectiveReplayAliasMap,
    filterReplayAliasSources,
    replayAliasRowStatus,
    detectReplayAliasCollisions,
    suggestReplayAliasMatches,
    replayAliasStorageKey,
    stampReplaySourceNames,
    resetReplayNamesToSource,
    applyReplayAliasesInPlace,
    collectUniqueReplaySourceNames,
    replayAliasMetaMismatchMessage,
} from "../../tool_plugins/js/src/replay-alias.mjs";

describe("replay-alias", () => {
    it("levenshtein distancias conocidas", () => {
        expect(levenshtein("", "")).toBe(0);
        expect(levenshtein("kitten", "sitting")).toBe(3);
        expect(levenshtein("foo", "foo")).toBe(0);
        expect(levenshtein("a", "b")).toBe(1);
    });

    it("normalizeReplayAliasMap recorta y filtra vacíos", () => {
        expect(normalizeReplayAliasMap({ "  a  ": "  b ", "": "x", c: "" })).toEqual({ a: "b" });
        expect(normalizeReplayAliasMap(null)).toEqual({});
    });

    it("detectReplayAliasCollisions agrupa por destino", () => {
        const { duplicateTargets } = detectReplayAliasCollisions({ x: "A", y: "A", z: "B" });
        expect(duplicateTargets).toHaveLength(1);
        expect(duplicateTargets[0].target).toBe("A");
        expect(duplicateTargets[0].sources.sort()).toEqual(["x", "y"]);
    });

    it("suggestReplayAliasMatches prioriza igualdad sin distinguir mayúsculas", () => {
        const s = suggestReplayAliasMatches("foo_bar", ["FOO_BAR", "foo_baz"], { maxDistance: 2, maxSuggestions: 5 });
        expect(s[0].kind).toBe("exact_ci");
        expect(s[0].name).toBe("FOO_BAR");
    });

    it("suggestReplayAliasMatches fuzzy por Levenshtein", () => {
        const s = suggestReplayAliasMatches("altitude", ["altittude", "pressure"], { maxDistance: 3, maxSuggestions: 5 });
        const names = s.map((x) => x.name);
        expect(names).toContain("altittude");
    });

    it("replayAliasStorageKey usa nombre de fichero o __local__", () => {
        expect(replayAliasStorageKey("run.tsv")).toBe("run.tsv");
        expect(replayAliasStorageKey("", "x.parquet")).toBe("x.parquet");
        expect(replayAliasStorageKey("", "")).toBe("__local__");
    });

    it("applyReplayAliasesInPlace renombra y reconstruye names", () => {
        const ds = {
            samples: [
                {
                    ts: 0,
                    data: [
                        { name: "rec_a", type: "double", value: 1, timestamp: 0 },
                        { name: "rec_b", type: "double", value: 2, timestamp: 0 },
                    ],
                },
            ],
            names: ["rec_a", "rec_b"],
        };
        stampReplaySourceNames(ds);
        const res = applyReplayAliasesInPlace(ds, { rec_a: "pub_a", rec_b: "pub_b" });
        expect(res.ok).toBe(true);
        expect(ds.names.sort()).toEqual(["pub_a", "pub_b"]);
        expect(ds.samples[0].data[0].name).toBe("pub_a");
        expect(ds.samples[0].data[0]._replaySourceName).toBe("rec_a");
    });

    it("applyReplayAliasesInPlace rechaza colisiones", () => {
        const ds = {
            samples: [{ ts: 0, data: [{ name: "a", type: "double", value: 1, timestamp: 0 }, { name: "b", type: "double", value: 2, timestamp: 0 }] }],
            names: ["a", "b"],
        };
        stampReplaySourceNames(ds);
        const res = applyReplayAliasesInPlace(ds, { a: "Z", b: "Z" });
        expect(res.ok).toBe(false);
        expect(res.duplicateTargets.length).toBeGreaterThan(0);
    });

    it("resetReplayNamesToSource restaura nombres originales", () => {
        const ds = {
            samples: [{ ts: 0, data: [{ name: "x", type: "double", value: 1, timestamp: 0 }] }],
            names: ["x"],
        };
        applyReplayAliasesInPlace(ds, { x: "canonical" });
        expect(ds.samples[0].data[0].name).toBe("canonical");
        resetReplayNamesToSource(ds);
        expect(ds.samples[0].data[0].name).toBe("x");
        expect(ds.names).toEqual(["x"]);
    });

    it("collectUniqueReplaySourceNames lista únicos", () => {
        const ds = {
            samples: [
                { ts: 0, data: [{ name: "a", _replaySourceName: "a" }, { name: "b" }] },
            ],
        };
        const u = collectUniqueReplaySourceNames(ds);
        expect(u.sort()).toEqual(["a", "b"]);
    });

    it("migrateReplayAliasBindingsFromConfig acepta mapa plano o objeto con map/disabled", () => {
        const a = migrateReplayAliasBindingsFromConfig({ k1: { x: "y" } });
        expect(a.k1.map).toEqual({ x: "y" });
        expect(a.k1.disabled).toBe(false);
        const b = migrateReplayAliasBindingsFromConfig({ k2: { map: { a: "b" }, disabled: true } });
        expect(b.k2.map).toEqual({ a: "b" });
        expect(b.k2.disabled).toBe(true);
    });

    it("effectiveReplayAliasMap rellena identidad y recorta vacíos", () => {
        const eff = effectiveReplayAliasMap(["a", "b"], { a: "A", b: "" });
        expect(eff).toEqual({ a: "A", b: "b" });
    });

    it("filterReplayAliasSources respeta filtro unknown", () => {
        const canon = new Set(["ok"]);
        const m = { x: "ok", y: "zzz" };
        const r = filterReplayAliasSources(["x", "y"], "", "unknown", m, canon);
        expect(r).toEqual(["y"]);
    });

    it("replayAliasMetaMismatchMessage detecta sha distinto", () => {
        const msgs = replayAliasMetaMismatchMessage(
            { sha256: "aa" },
            { sha256: "bb" },
        );
        expect(msgs.length).toBeGreaterThan(0);
    });
});
