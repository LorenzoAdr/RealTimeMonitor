import { describe, it, expect, beforeEach } from "vitest";
import {
    registerPlugin,
    registerHook,
    registerAppMode,
    hasRegisteredAppMode,
    getRegisteredAppModeIds,
    fireHook,
    fireHookChain,
    hasPlugin,
    getRegisteredPluginIds,
    getPluginMeta,
    getHooks,
    _reset,
} from "../../web_monitor/static/js/modules/plugin_api.mjs";


beforeEach(() => {
    _reset();
});


describe("registerPlugin + hasPlugin", () => {
    it("registers and finds plugin", () => {
        registerPlugin("arinc", { version: "1.0" });
        expect(hasPlugin("arinc")).toBe(true);
    });

    it("returns false for missing plugin", () => {
        expect(hasPlugin("missing")).toBe(false);
    });
});

describe("getRegisteredPluginIds", () => {
    it("returns sorted plugin IDs", () => {
        registerPlugin("parquet");
        registerPlugin("arinc");
        registerPlugin("segments");
        expect(getRegisteredPluginIds()).toEqual(["arinc", "parquet", "segments"]);
    });

    it("returns empty when no plugins", () => {
        expect(getRegisteredPluginIds()).toEqual([]);
    });
});

describe("getPluginMeta", () => {
    it("returns meta", () => {
        registerPlugin("x", { author: "test", version: "2.0" });
        expect(getPluginMeta("x")).toEqual({ author: "test", version: "2.0" });
    });

    it("returns null for missing", () => {
        expect(getPluginMeta("missing")).toBeNull();
    });
});

describe("registerHook + fireHook", () => {
    it("fires registered hook", () => {
        const results = [];
        registerHook("test", (x) => results.push(x));
        fireHook("test", 42);
        expect(results).toEqual([42]);
    });

    it("fires multiple callbacks in order", () => {
        const calls = [];
        registerHook("h", () => calls.push("a"));
        registerHook("h", () => calls.push("b"));
        fireHook("h");
        expect(calls).toEqual(["a", "b"]);
    });

    it("returns results from all callbacks", () => {
        registerHook("double", (x) => x * 2);
        registerHook("double", (x) => x * 3);
        const results = fireHook("double", 5);
        expect(results).toEqual([10, 15]);
    });

    it("nonexistent hook returns empty array", () => {
        expect(fireHook("nope", 1, 2)).toEqual([]);
    });

    it("exception in callback does not break others", () => {
        const calls = [];
        registerHook("err", () => { throw new Error("boom"); });
        registerHook("err", () => calls.push("ok"));
        fireHook("err");
        expect(calls).toEqual(["ok"]);
    });

    it("ignores non-function", () => {
        registerHook("bad", "not a function");
        expect(fireHook("bad")).toEqual([]);
    });
});

describe("fireHookChain", () => {
    it("chains transformations", () => {
        registerHook("transform", (v) => v + 10);
        registerHook("transform", (v) => v * 2);
        expect(fireHookChain("transform", 5)).toBe(30);
    });

    it("null return preserves value", () => {
        registerHook("maybe", () => null);
        expect(fireHookChain("maybe", 42)).toBe(42);
    });

    it("undefined return preserves value", () => {
        registerHook("undef", () => undefined);
        expect(fireHookChain("undef", 42)).toBe(42);
    });

    it("no hooks returns original", () => {
        expect(fireHookChain("empty", { key: "val" })).toEqual({ key: "val" });
    });

    it("exception preserves value and continues", () => {
        registerHook("err_chain", () => { throw new Error("fail"); });
        registerHook("err_chain", (v) => v + 1);
        expect(fireHookChain("err_chain", 10)).toBe(11);
    });

    it("passes extra args", () => {
        registerHook("ctx", (v, a, b) => v + a + b);
        expect(fireHookChain("ctx", 1, 10, 100)).toBe(111);
    });
});

describe("getHooks", () => {
    it("returns hook summary", () => {
        registerHook("a", () => {});
        registerHook("a", () => {});
        registerHook("b", () => {});
        expect(getHooks()).toEqual({ a: 2, b: 1 });
    });

    it("empty when no hooks", () => {
        expect(getHooks()).toEqual({});
    });
});

describe("registerAppMode", () => {
    it("registers app mode and lists ids", () => {
        registerAppMode("file_edit", { labelFallback: "Files", bodyClass: "mode-file-edit" });
        expect(hasRegisteredAppMode("file_edit")).toBe(true);
        expect(getRegisteredAppModeIds()).toContain("file_edit");
    });
});

describe("_reset", () => {
    it("clears everything", () => {
        registerPlugin("p");
        registerHook("h", () => {});
        registerAppMode("x", { labelFallback: "X" });
        _reset();
        expect(hasPlugin("p")).toBe(false);
        expect(getRegisteredPluginIds()).toEqual([]);
        expect(hasRegisteredAppMode("x")).toBe(false);
        expect(getHooks()).toEqual({});
        expect(fireHook("h")).toEqual([]);
    });
});
