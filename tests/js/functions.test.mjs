import { describe, it, expect } from "vitest";
import {
    reverseBits8, popcount32, decodeBcd,
    formatBytes, trimTextToFullLines, parseCell, formatAdvNum,
    escapeLogHtml, logLineClass,
    binarySearchSampleIndex, movingAverage, downsampleSeries, rangesAlmostEqual,
    buildTree, collectLeaves, collectGroupPaths,
    computeGenValue,
    lengthToMeters, metersToLength, massToKg, speedToMs, angleToRad, dmsRawToDecimalDegrees,
    hslToHex,
} from "./extracted_functions.mjs";


// ── ARINC / bit manipulation ──

describe("reverseBits8", () => {
    it("reverses 0x00", () => expect(reverseBits8(0x00)).toBe(0x00));
    it("reverses 0x01 to 0x80", () => expect(reverseBits8(0x01)).toBe(0x80));
    it("reverses 0x80 to 0x01", () => expect(reverseBits8(0x80)).toBe(0x01));
    it("roundtrip", () => expect(reverseBits8(reverseBits8(0xA5))).toBe(0xA5));
    it("reverses 0xFF to 0xFF", () => expect(reverseBits8(0xFF)).toBe(0xFF));
});

describe("popcount32", () => {
    it("0 bits", () => expect(popcount32(0)).toBe(0));
    it("1 bit", () => expect(popcount32(1)).toBe(1));
    it("all bits", () => expect(popcount32(0xFFFFFFFF)).toBe(32));
    it("0xAAAAAAAA = 16 bits", () => expect(popcount32(0xAAAAAAAA)).toBe(16));
});

describe("decodeBcd", () => {
    it("simple BCD 0x1234 12 bits => 234", () => expect(decodeBcd(0x234, 12)).toBe(234));
    it("invalid nibble > 9 returns NaN", () => expect(decodeBcd(0xF, 4)).toBeNaN());
    it("single digit", () => expect(decodeBcd(5, 4)).toBe(5));
    it("zero", () => expect(decodeBcd(0, 8)).toBe(0));
});


// ── Format utilities ──

describe("formatBytes", () => {
    it("0 bytes", () => expect(formatBytes(0)).toBe("0 B"));
    it("negative", () => expect(formatBytes(-10)).toBe("0 B"));
    it("500 B", () => expect(formatBytes(500)).toBe("500 B"));
    it("1024 => 1.0 KB", () => expect(formatBytes(1024)).toBe("1.0 KB"));
    it("1.5 MB", () => expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB"));
    it("1 GB", () => expect(formatBytes(1024 ** 3)).toBe("1.0 GB"));
    it("NaN", () => expect(formatBytes(NaN)).toBe("0 B"));
});

describe("formatAdvNum", () => {
    it("null returns dash", () => expect(formatAdvNum(null)).toBe("—"));
    it("undefined returns dash", () => expect(formatAdvNum(undefined)).toBe("—"));
    it("NaN returns dash", () => expect(formatAdvNum(NaN)).toBe("—"));
    it("large number, 0 decimals", () => expect(formatAdvNum(123.456)).toBe("123"));
    it("medium number, 2 decimals", () => expect(formatAdvNum(5.678)).toBe("5.68"));
    it("small number, 3 decimals", () => expect(formatAdvNum(0.12345)).toBe("0.123"));
});

describe("escapeLogHtml", () => {
    it("escapes < and >", () => expect(escapeLogHtml("<script>")).toBe("&lt;script&gt;"));
    it("escapes &", () => expect(escapeLogHtml("a & b")).toBe("a &amp; b"));
    it("escapes quotes", () => expect(escapeLogHtml('"hi"')).toBe("&quot;hi&quot;"));
    it("plain text unchanged", () => expect(escapeLogHtml("hello")).toBe("hello"));
});

describe("logLineClass", () => {
    it("200 OK", () => expect(logLineClass("GET /api 200 OK")).toBe("log-line-ok"));
    it("500 error", () => expect(logLineClass("Internal error 500")).toBe("log-line-error"));
    it("warning", () => expect(logLineClass("WARNING: something")).toBe("log-line-warn"));
    it("SHM loss", () => expect(logLineClass("[VarMonitor SHM] PÉRDIDA de datos")).toBe("log-line-error"));
    it("SHM warning", () => expect(logLineClass("[VarMonitor SHM] WARNING: lento")).toBe("log-line-warn"));
    it("req line", () => expect(logLineClass("[req] GET /api")).toBe("log-line-req"));
    it("normal line", () => expect(logLineClass("Just a normal message")).toBe(""));
});


// ── TSV parsing ──

describe("parseCell", () => {
    it("number", () => expect(parseCell("3.14")).toBe(3.14));
    it("integer", () => expect(parseCell("42")).toBe(42));
    it("true", () => expect(parseCell("True")).toBe(true));
    it("false", () => expect(parseCell("false")).toBe(false));
    it("NaN", () => expect(parseCell("nan")).toBeNaN());
    it("inf", () => expect(parseCell("inf")).toBe(Infinity));
    it("-inf", () => expect(parseCell("-inf")).toBe(-Infinity));
    it("string", () => expect(parseCell("hello")).toBe("hello"));
    it("empty", () => expect(parseCell("")).toBeNull());
    it("null input", () => expect(parseCell(null)).toBeNull());
    it("whitespace trimmed", () => expect(parseCell("  42  ")).toBe(42));
});

describe("trimTextToFullLines", () => {
    it("trims to last newline", () => expect(trimTextToFullLines("a\nb\npartial")).toBe("a\nb\n"));
    it("no newline returns original", () => expect(trimTextToFullLines("no newline")).toBe("no newline"));
    it("empty string", () => expect(trimTextToFullLines("")).toBe(""));
    it("ends with newline unchanged", () => expect(trimTextToFullLines("a\nb\n")).toBe("a\nb\n"));
});


// ── Math / data ──

describe("binarySearchSampleIndex", () => {
    const samples = [{ ts: 1 }, { ts: 3 }, { ts: 5 }, { ts: 7 }, { ts: 9 }];
    it("exact match", () => expect(binarySearchSampleIndex(samples, 5)).toBe(2));
    it("between values", () => expect(binarySearchSampleIndex(samples, 4)).toBe(1));
    it("before first", () => expect(binarySearchSampleIndex(samples, 0)).toBe(0));
    it("after last", () => expect(binarySearchSampleIndex(samples, 100)).toBe(4));
});

describe("movingAverage", () => {
    it("window 1 returns copy", () => {
        const v = [1, 2, 3];
        const result = movingAverage(v, 1);
        expect(result).toEqual([1, 2, 3]);
        expect(result).not.toBe(v);
    });
    it("window 3 smooths", () => {
        const result = movingAverage([1, 2, 3, 4, 5], 3);
        expect(result[0]).toBeCloseTo(1.5);   // avg(1,2)
        expect(result[2]).toBeCloseTo(3);     // avg(2,3,4)
        expect(result[4]).toBeCloseTo(4.5);   // avg(4,5)
    });
    it("empty array", () => expect(movingAverage([], 3)).toEqual([]));
});

describe("downsampleSeries", () => {
    it("no downsample if under limit", () => {
        const xs = [1, 2, 3], ys = [10, 20, 30];
        const result = downsampleSeries(xs, ys, 5);
        expect(result.x).toEqual(xs);
    });
    it("downsamples large arrays", () => {
        const xs = Array.from({ length: 100 }, (_, i) => i);
        const ys = xs.map(x => x * 2);
        const result = downsampleSeries(xs, ys, 10);
        expect(result.x.length).toBeLessThanOrEqual(15);
        expect(result.x[result.x.length - 1]).toBe(99);
    });
    it("always includes last point", () => {
        const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        const ys = xs.map(x => x);
        const result = downsampleSeries(xs, ys, 3);
        expect(result.x[result.x.length - 1]).toBe(9);
    });
});

describe("rangesAlmostEqual", () => {
    it("equal ranges", () => expect(rangesAlmostEqual([0, 10], [0, 10])).toBe(true));
    it("close ranges", () => expect(rangesAlmostEqual([0, 10], [1e-8, 10 + 1e-8])).toBe(true));
    it("different ranges", () => expect(rangesAlmostEqual([0, 10], [0, 20])).toBe(false));
    it("non-arrays", () => expect(rangesAlmostEqual(null, [0, 10])).toBe(false));
    it("wrong length", () => expect(rangesAlmostEqual([1], [1, 2])).toBe(false));
});


// ── Tree building ──

describe("buildTree + collectLeaves", () => {
    it("flat names", () => {
        const tree = buildTree(["a", "b", "c"]);
        expect(collectLeaves(tree)).toEqual(["a", "b", "c"]);
    });
    it("nested names", () => {
        const tree = buildTree(["sensors.temp", "sensors.pressure", "system.flag"]);
        const leaves = collectLeaves(tree);
        expect(leaves).toHaveLength(3);
        expect(leaves).toContain("sensors.temp");
    });
    it("deep nesting", () => {
        const tree = buildTree(["a.b.c.d"]);
        expect(collectLeaves(tree)).toEqual(["a.b.c.d"]);
    });
});

describe("collectGroupPaths", () => {
    it("returns intermediate paths", () => {
        const tree = buildTree(["a.b.c", "a.b.d", "x.y"]);
        const paths = collectGroupPaths(tree, "", []);
        expect(paths).toContain("a");
        expect(paths).toContain("a.b");
        expect(paths).toContain("x");
    });
});


// ── Generator computeGenValue ──

describe("computeGenValue", () => {
    it("sine at t=0", () => {
        const v = computeGenValue("sine", { amp: 1, freq: 1, offset: 0 }, 0);
        expect(v).toBeCloseTo(0, 5);
    });
    it("sine at t=0.25 (quarter period)", () => {
        const v = computeGenValue("sine", { amp: 1, freq: 1, offset: 0 }, 0.25);
        expect(v).toBeCloseTo(1, 5);
    });
    it("step before delay", () => {
        expect(computeGenValue("step", { delay: 1, v0: 0, v1: 10 }, 0.5)).toBe(0);
    });
    it("step after delay", () => {
        expect(computeGenValue("step", { delay: 1, v0: 0, v1: 10 }, 1.5)).toBe(10);
    });
    it("ramp at start", () => {
        expect(computeGenValue("ramp", { v0: 0, v1: 100, dur: 10 }, 0)).toBe(0);
    });
    it("ramp at end", () => {
        expect(computeGenValue("ramp", { v0: 0, v1: 100, dur: 10 }, 10)).toBe(100);
    });
    it("ramp midpoint", () => {
        expect(computeGenValue("ramp", { v0: 0, v1: 100, dur: 10 }, 5)).toBe(50);
    });
    it("pulse active", () => {
        expect(computeGenValue("pulse", { delay: 1, dur: 2, base: 0, amp: 5 }, 1.5)).toBe(5);
    });
    it("pulse inactive", () => {
        expect(computeGenValue("pulse", { delay: 1, dur: 2, base: 0, amp: 5 }, 0.5)).toBe(0);
    });
    it("unknown type returns 0", () => {
        expect(computeGenValue("unknown", {}, 0)).toBe(0);
    });
});


// ── Physical unit conversions ──

describe("unit conversions", () => {
    it("feet to meters", () => expect(lengthToMeters(1, "ft")).toBeCloseTo(0.3048));
    it("nmi to meters", () => expect(lengthToMeters(1, "nmi")).toBe(1852));
    it("meters passthrough", () => expect(lengthToMeters(100, "m")).toBe(100));
    it("meters to feet", () => expect(metersToLength(0.3048, "ft")).toBeCloseTo(1));
    it("lb to kg", () => expect(massToKg(1, "lb")).toBeCloseTo(0.4536, 3));
    it("kg passthrough", () => expect(massToKg(1, "kg")).toBe(1));
    it("kmh to m/s", () => expect(speedToMs(36, "kmh")).toBe(10));
    it("knot to m/s", () => expect(speedToMs(1, "knot")).toBeCloseTo(0.5144, 3));
    it("deg to rad", () => expect(angleToRad(180, "deg")).toBeCloseTo(Math.PI));
    it("rad passthrough", () => expect(angleToRad(1, "rad")).toBe(1));
    it("dms minutes to degrees", () => expect(dmsRawToDecimalDegrees(60, "min")).toBe(1));
    it("dms seconds to degrees", () => expect(dmsRawToDecimalDegrees(3600, "sec")).toBe(1));
});


// ── hslToHex ──

describe("hslToHex", () => {
    it("red", () => expect(hslToHex(0, 100, 50)).toBe("#ff0000"));
    it("green", () => expect(hslToHex(120, 100, 50)).toBe("#00ff00"));
    it("blue", () => expect(hslToHex(240, 100, 50)).toBe("#0000ff"));
    it("white", () => expect(hslToHex(0, 0, 100)).toBe("#ffffff"));
    it("black", () => expect(hslToHex(0, 0, 0)).toBe("#000000"));
});
