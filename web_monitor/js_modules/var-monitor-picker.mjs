function normalizeNames(extraNameSet) {
    const out = [];
    const seen = new Set();
    const fromGlobal =
        typeof globalThis !== "undefined" && Array.isArray(globalThis.__VARMON_KNOWN_VAR_NAMES__)
            ? globalThis.__VARMON_KNOWN_VAR_NAMES__
            : [];
    const merged = [];
    for (const n of fromGlobal) merged.push(n);
    for (const n of extraNameSet || []) merged.push(n);
    for (const raw of merged) {
        const n = String(raw || "").trim();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
}

/**
 * Selector de nombre de variable con buscador y desplegable propio.
 * Evita depender de <datalist>, que en algunos navegadores no despliega de forma fiable.
 *
 * @param {{
 *   labelText: string,
 *   roleKey: string,
 *   initial: string,
 *   extraNameSet: Iterable<string>,
 *   inputClassName?: string,
 *   showLabel?: boolean,
 *   onPick?: ((name: string) => void) | null,
 *   maxItems?: number,
 * }} opt
 * @returns {{ row: HTMLElement, input: HTMLInputElement, dispose: () => void, getValue: () => string, setValue: (v: string) => void }}
 */
export function createSearchableVarPickerField(opt = {}) {
    const getNames = () => normalizeNames(opt.extraNameSet);

    const row = document.createElement(opt.showLabel === false ? "div" : "label");
    row.className = "flight-viz-modal-row";
    if (opt.showLabel !== false) row.textContent = String(opt.labelText || "");

    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "6px";

    const inp = document.createElement("input");
    inp.type = "text";
    inp.dataset.role = String(opt.roleKey || "");
    inp.value = String(opt.initial || "");
    inp.className = opt.inputClassName || "flight-viz-var-field-input";
    inp.setAttribute("autocomplete", "off");
    inp.spellcheck = false;
    inp.style.flex = "1 1 auto";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-small";
    btn.setAttribute("aria-label", "Filtrar catálogo");
    btn.title = "Filtrar catálogo";
    btn.textContent = "🔍";
    btn.style.flex = "0 0 auto";
    btn.style.padding = "0.18rem 0.45rem";

    const list = document.createElement("div");
    list.style.position = "absolute";
    list.style.left = "0";
    list.style.top = "calc(100% + 4px)";
    list.style.right = "34px";
    list.style.maxHeight = "180px";
    list.style.overflow = "auto";
    list.style.zIndex = "40";
    list.style.background = "var(--surface, #111827)";
    list.style.border = "1px solid var(--border, rgba(148,163,184,0.35))";
    list.style.borderRadius = "8px";
    list.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    list.style.display = "none";

    const closeList = () => {
        list.style.display = "none";
    };

    const pickValue = (name) => {
        inp.value = name;
        closeList();
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        // Comportamiento compartido: si la variable no estaba monitorizada, se da de alta al seleccionarla.
        document.dispatchEvent(new CustomEvent("varmonEnsureMonitored", { detail: { names: [name] } }));
        if (typeof opt.onPick === "function") opt.onPick(name);
    };

    const renderList = () => {
        const q = (inp.value || "").trim().toLowerCase();
        list.replaceChildren();
        let shown = 0;
        const names = getNames();
        for (const n of names) {
            if (q && !n.toLowerCase().includes(q)) continue;
            const item = document.createElement("button");
            item.type = "button";
            item.className = "btn-small";
            item.textContent = n;
            item.title = n;
            item.style.display = "block";
            item.style.width = "100%";
            item.style.textAlign = "left";
            item.style.border = "0";
            item.style.borderRadius = "0";
            item.style.borderBottom = "1px solid var(--border, rgba(148,163,184,0.2))";
            item.style.background = "transparent";
            item.style.padding = "0.32rem 0.5rem";
            item.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                pickValue(n);
            });
            list.appendChild(item);
            shown += 1;
            if (shown >= Math.max(8, Number(opt.maxItems) || 80)) break;
        }
        if (shown === 0) {
            const empty = document.createElement("div");
            empty.textContent = "Sin coincidencias";
            empty.style.padding = "0.36rem 0.5rem";
            empty.style.fontSize = "0.78rem";
            empty.style.opacity = "0.8";
            list.appendChild(empty);
        }
        list.style.display = "block";
    };

    const onInput = () => renderList();
    const onFocus = () => renderList();
    const onDocDown = (ev) => {
        if (row.contains(ev.target)) return;
        closeList();
    };

    inp.addEventListener("input", onInput);
    inp.addEventListener("focus", onFocus);
    btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        inp.focus();
        renderList();
    });
    document.addEventListener("mousedown", onDocDown);

    wrap.appendChild(inp);
    wrap.appendChild(btn);
    wrap.appendChild(list);
    row.appendChild(wrap);

    return {
        row,
        input: inp,
        dispose() {
            inp.removeEventListener("input", onInput);
            inp.removeEventListener("focus", onFocus);
            document.removeEventListener("mousedown", onDocDown);
            closeList();
        },
        getValue: () => inp.value,
        setValue: (v) => {
            inp.value = String(v ?? "");
        },
    };
}
