import { describe, it, expect } from "vitest";
import {
    ARINC_REGISTRY_VERSION,
    labelOctFromCell,
    normalizeLabelEntry,
} from "../../web_monitor/static/js/modules/arinc-registry.mjs";

describe("arinc-registry (web_monitor module)", () => {
    it("exports version constant", () => {
        expect(ARINC_REGISTRY_VERSION).toBe(1);
    });

    it("labelOctFromCell normalizes octal/hex/dec to 3-digit oct", () => {
        expect(labelOctFromCell("310", "oct")).toBe("310");
        expect(labelOctFromCell("0xC8", "hex")).toBe("310");
        expect(labelOctFromCell("200", "dec")).toBe("310");
        expect(labelOctFromCell("", "oct")).toBeNull();
    });

    it("normalizeLabelEntry builds stable label from minimal input", () => {
        const e = normalizeLabelEntry({
            group: "General",
            labelOct: "310",
            name: "IAS",
            encoding: "bnr",
            bits: 19,
        });
        expect(e).not.toBeNull();
        expect(e.labelOct).toBe("310");
        expect(e.name).toBe("IAS");
        expect(e.encoding).toBe("bnr");
    });

    it("normalizeLabelEntry returns null for null input", () => {
        expect(normalizeLabelEntry(null)).toBeNull();
    });
});
