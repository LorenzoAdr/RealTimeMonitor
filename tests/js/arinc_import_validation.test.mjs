import { describe, it, expect } from "vitest";
import {
    validateArincTabularImport,
    listArincImportConflicts,
    labelOctFromCell,
} from "../../tool_plugins/js/src/arinc_import_validation.mjs";

describe("labelOctFromCell", () => {
    it("normaliza octal 3 dígitos", () => {
        expect(labelOctFromCell("310", "oct")).toBe("310");
        expect(labelOctFromCell("0xC8", "hex")).toBe("310");
        expect(labelOctFromCell("200", "dec")).toBe("310");
    });
});

describe("validateArincTabularImport", () => {
    it("detecta fila label sin octal válido", () => {
        const r = validateArincTabularImport({
            headers: ["label_oct", "name", "encoding"],
            rows: [{ label_oct: "999", name: "X", encoding: "bnr" }],
            mapping: { label_oct: "label_oct", name: "name", encoding: "encoding" },
            rowKinds: ["label"],
            targetGroup: "General",
        });
        expect(r.issues.some((i) => i.code === "missing_label_oct")).toBe(true);
    });

    it("cuenta filas de etiqueta válidas", () => {
        const r = validateArincTabularImport({
            headers: ["label_oct", "name"],
            rows: [{ label_oct: "310", name: "IAS" }],
            mapping: { label_oct: "label_oct", name: "name" },
            rowKinds: ["label"],
            targetGroup: "General",
        });
        expect(r.labelRowCount).toBe(1);
        expect(r.issues.filter((i) => i.severity === "error").length).toBe(0);
    });

    it("marca bitDIS huérfano", () => {
        const r = validateArincTabularImport({
            headers: ["dis_bit_index", "dis_bit_name"],
            rows: [{ dis_bit_index: "0", dis_bit_name: "WOW" }],
            mapping: {
                dis_bit_index: "dis_bit_index",
                dis_bit_name: "dis_bit_name",
            },
            rowKinds: ["bitdis"],
            targetGroup: "General",
        });
        expect(r.orphanBitDis).toBeGreaterThan(0);
    });
});

describe("listArincImportConflicts", () => {
    it("lista conflicto cuando grupo+oct coinciden", () => {
        const existing = { "Nav::310": { group: "Nav", labelOct: "310", name: "OLD", encoding: "bnr" } };
        const incoming = { "Nav::310": { group: "Nav", labelOct: "310", name: "NEW", encoding: "bnr" } };
        const c = listArincImportConflicts(incoming, existing);
        expect(c.length).toBe(1);
        expect(c[0].fieldsChanged).toContain("name");
    });
});
