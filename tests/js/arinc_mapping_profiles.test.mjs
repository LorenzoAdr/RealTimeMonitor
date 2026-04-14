import { describe, it, expect } from "vitest";
import {
    buildImportMapping,
    mergeColumnMapsForImport,
    sanitizeArincProfileName,
    clipProfiles,
} from "../../web_monitor/static/js/modules/arinc-mapping-profiles.mjs";

describe("sanitizeArincProfileName", () => {
    it("recorta y elimina control chars", () => {
        expect(sanitizeArincProfileName("  mi_icd  ")).toBe("mi_icd");
        expect(sanitizeArincProfileName("a\u0000b")).toBe("ab");
    });
});

describe("mergeColumnMapsForImport", () => {
    it("el perfil sobrescribe claves coincidentes", () => {
        const m = mergeColumnMapsForImport(
            { A: "name", B: "ignore" },
            { B: "label_oct" },
        );
        expect(m.A).toBe("name");
        expect(m.B).toBe("label_oct");
    });
});

describe("buildImportMapping", () => {
    it("fusiona saved + perfil y aplica guess", () => {
        const headers = ["oct", "nombre"];
        const mapping = buildImportMapping(
            headers,
            {},
            { oct: "label_oct" },
        );
        expect(mapping.oct).toBe("label_oct");
        expect(mapping.nombre).toBeTruthy();
    });
});

describe("clipProfiles", () => {
    it("recorta al máximo de claves", () => {
        const many = {};
        for (let i = 0; i < 60; i++) many[`p${i}`] = { columnMap: {} };
        const c = clipProfiles(many, 5);
        expect(Object.keys(c).length).toBe(5);
    });
});
