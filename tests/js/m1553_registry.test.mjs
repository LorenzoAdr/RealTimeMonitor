import { describe, it, expect } from "vitest";
import {
    parseM1553VarName,
    m1553EntryKey,
    findM1553Definition,
    decodeM1553FromVarName,
    parseM1553CsvToLabels,
    m1553DetailedDecode,
    DEFAULT_M1553_VAR_NAME_RE,
} from "../../web_monitor/static/js/modules/m1553-registry.mjs";

describe("parseM1553VarName", () => {
    it("parses RT{n}_W{k}_suffix", () => {
        const p = parseM1553VarName("RT1_W3_ALT", DEFAULT_M1553_VAR_NAME_RE);
        expect(p).toEqual({ rt: 1, wordKind: 3, suffix: "ALT", raw: "RT1_W3_ALT" });
    });
    it("returns null on mismatch", () => {
        expect(parseM1553VarName("FOO_BAR", DEFAULT_M1553_VAR_NAME_RE)).toBeNull();
    });
});

describe("m1553EntryKey + findM1553Definition", () => {
    it("finds by composite key", () => {
        const labels = {
            [m1553EntryKey(1, 3, "ALT")]: { rt: 1, wordKind: 3, suffix: "ALT", name: "X" },
        };
        const def = findM1553Definition(labels, 1, 3, "ALT");
        expect(def && def.name).toBe("X");
    });
});

describe("decodeM1553FromVarName", () => {
    it("formats without convention message", () => {
        const s = decodeM1553FromVarName("BAD_NAME", 100, {});
        expect(s).toContain("sin convención");
    });
    it("decodes bnr with definition", () => {
        const labels = {
            [m1553EntryKey(1, 3, "ALT")]: {
                rt: 1,
                wordKind: 3,
                suffix: "ALT",
                name: "Alt",
                encoding: "bnr",
                bits: 16,
                scale: 0.1,
                signed: false,
                units: "m",
            },
        };
        const s = decodeM1553FromVarName("RT1_W3_ALT", 1234, labels);
        expect(s).toContain("123.4000");
        expect(s).toContain("m");
    });
});

describe("parseM1553CsvToLabels", () => {
    it("parses sample-style CSV", () => {
        const csv =
            "rt,word_kind,suffix,name,encoding,bits,scale,signed,units\n" +
            "1,3,ALT,X,bnr,16,0.1,false,ft\n";
        const r = parseM1553CsvToLabels(csv);
        expect(r.errors.length).toBe(0);
        const k = m1553EntryKey(1, 3, "ALT");
        expect(r.labels[k]).toBeTruthy();
        expect(r.labels[k].scale).toBe(0.1);
    });
});

describe("m1553DetailedDecode", () => {
    it("returns structured fields for bnr", () => {
        const labels = {
            [m1553EntryKey(1, 3, "ALT")]: {
                rt: 1,
                wordKind: 3,
                suffix: "ALT",
                name: "Alt",
                encoding: "bnr",
                bits: 16,
                scale: 0.1,
                signed: false,
                units: "ft",
            },
        };
        const d = m1553DetailedDecode("RT1_W3_ALT", 1234, labels);
        expect(d.ok).toBe(true);
        expect(d.fromDb).toBe(true);
        expect(d.engineeringStr).toContain("123");
        expect(d.rawHex).toMatch(/^0x/);
    });
});
