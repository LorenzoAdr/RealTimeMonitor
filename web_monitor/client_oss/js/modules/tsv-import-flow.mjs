/**
 * Modal corto (auto vs manual) y asistente de importación tabular → TSV canónico en servidor.
 */
import {
    buildCanonicalVarMonitorTsv,
    previewSplitLines,
    validatePreviewColumnWidths,
    safeBasenameStem,
    buildDelimiterRegex,
} from "./tsv-import-normalize.mjs";

function escHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function mapError(err, tr) {
    const code = err && err.code ? err.code : "";
    if (code === "tsvImportDelimNone") return tr.tsvImportErrDelimNone || String(err.message);
    if (code === "tsvImportEmpty") return tr.tsvImportErrEmpty || String(err.message);
    if (code === "tsvImportHeaderShort") return tr.tsvImportErrHeaderShort || String(err.message);
    if (code === "tsvImportTimeMissing") return tr.tsvImportErrTimeMissing || String(err.message);
    if (code === "tsvImportTimeDeltaInvalid") return tr.tsvImportErrTimeDeltaInvalid || String(err.message);
    if (code === "tsvImportColMismatch") {
        const row = err.row != null ? err.row : "?";
        const exp = err.expected != null ? err.expected : "?";
        const act = err.actual != null ? err.actual : "?";
        return (tr.tsvImportErrColMismatch || "")
            .replace("%row%", String(row))
            .replace("%exp%", String(exp))
            .replace("%act%", String(act));
    }
    if (code === "tsvImportNoValidRows") return tr.tsvImportErrNoValidRows || String(err.message);
    if (code === "tsvImportCellHasTab") return tr.tsvImportErrCellTab || String(err.message);
    return (tr.tsvImportErrGeneric || "%s").replace("%s", err && err.message ? err.message : String(err));
}

/**
 * @param {object} tr — I18N bundle
 * @returns {Promise<"auto"|"manual"|"cancel">}
 */
export function openTsvImportChooser(tr) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "vm-tsv-import-overlay";
        overlay.innerHTML = `
<div class="vm-tsv-import-dialog vm-tsv-import-dialog--small" role="dialog" aria-modal="true" aria-labelledby="vmTsvChooserTitle">
  <h2 id="vmTsvChooserTitle" class="vm-tsv-import-title">${escHtml(tr.tsvImportChooserTitle)}</h2>
  <p class="vm-tsv-import-hint">${escHtml(tr.tsvImportChooserHint)}</p>
  <div class="vm-tsv-import-actions">
    <button type="button" class="btn-small vm-tsv-import-btn-auto">${escHtml(tr.tsvImportChooserAuto)}</button>
    <button type="button" class="btn-small vm-tsv-import-btn-manual">${escHtml(tr.tsvImportChooserManual)}</button>
    <button type="button" class="btn-small vm-tsv-import-btn-cancel">${escHtml(tr.tsvImportChooserCancel)}</button>
  </div>
</div>`;
        const close = (v) => {
            overlay.remove();
            resolve(v);
        };
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close("cancel");
        });
        overlay.querySelector(".vm-tsv-import-btn-auto").addEventListener("click", () => close("auto"));
        overlay.querySelector(".vm-tsv-import-btn-manual").addEventListener("click", () => close("manual"));
        overlay.querySelector(".vm-tsv-import-btn-cancel").addEventListener("click", () => close("cancel"));
        document.body.appendChild(overlay);
    });
}

async function postSaveConverted(basenameStem, content) {
    const r = await fetch("/api/recordings/save_converted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basename: basenameStem, content }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText || String(r.status));
    if (!j.filename) throw new Error("Respuesta sin filename");
    return j.filename;
}

/**
 * @param {object} opts
 * @param {object} opts.tr
 * @param {string} opts.originalFilename
 * @param {() => Promise<string>} opts.getPreviewText — muestra inicial (p. ej. primeros MB)
 * @param {() => Promise<string>} opts.getFullText — archivo completo
 * @param {(filename: string) => Promise<void>} opts.onSaved — tras POST (p. ej. refresh + load)
 */
export async function openTsvConvertWizard(opts) {
    const { tr, originalFilename, getPreviewText, getFullText, onSaved } = opts;
    let previewCache = "";
    try {
        previewCache = await getPreviewText();
    } catch {
        previewCache = "";
    }

    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "vm-tsv-import-overlay";
        overlay.innerHTML = `
<div class="vm-tsv-import-dialog vm-tsv-import-dialog--large" role="dialog" aria-modal="true" aria-labelledby="vmTsvWizardTitle">
  <h2 id="vmTsvWizardTitle" class="vm-tsv-import-title">${escHtml(tr.tsvImportWizardTitle)}</h2>
  <p class="vm-tsv-import-note">${escHtml(tr.tsvImportWizardNote)}</p>
  <fieldset class="vm-tsv-import-fieldset">
    <legend>${escHtml(tr.tsvImportDelimitersLabel)}</legend>
    <label><input type="checkbox" data-d="tab" checked/> ${escHtml(tr.tsvImportDelimTab)}</label>
    <label><input type="checkbox" data-d="space"/> ${escHtml(tr.tsvImportDelimSpace)}</label>
    <label><input type="checkbox" data-d="semicolon"/> ${escHtml(tr.tsvImportDelimSemi)}</label>
    <label><input type="checkbox" data-d="comma"/> ${escHtml(tr.tsvImportDelimComma)}</label>
  </fieldset>
  <fieldset class="vm-tsv-import-fieldset">
    <legend>${escHtml(tr.tsvImportDecimalLabel)}</legend>
    <label><input type="radio" name="vmTsvDec" value="dot" checked/> ${escHtml(tr.tsvImportDecimalDot)}</label>
    <label><input type="radio" name="vmTsvDec" value="comma"/> ${escHtml(tr.tsvImportDecimalComma)}</label>
  </fieldset>
  <div class="vm-tsv-import-row">
    <label>${escHtml(tr.tsvImportTimeModeLabel || "Origen de tiempo")}
      <select data-time-mode class="vm-tsv-import-select">
        <option value="column">${escHtml(tr.tsvImportTimeModeFromColumn || "En grabación")}</option>
        <option value="synthetic">${escHtml(tr.tsvImportTimeModeSynthetic || "Crear")}</option>
      </select>
    </label>
    <label data-time-col-wrap>${escHtml(tr.tsvImportTimeColLabel)}
      <select data-time-col class="vm-tsv-import-select"></select>
    </label>
    <label data-time-delta-wrap style="display:none">${escHtml(tr.tsvImportTimeDeltaLabel || "Delta time_s")}
      <input data-time-delta class="vm-tsv-import-select" type="number" min="0.000001" step="0.000001" value="0.01" />
    </label>
  </div>
  <div class="vm-tsv-import-actions">
    <button type="button" class="btn-small" data-preview>${escHtml(tr.tsvImportPreviewBtn)}</button>
  </div>
  <div data-preview-host class="vm-tsv-import-preview-host">${escHtml(tr.tsvImportPreviewEmpty)}</div>
  <p data-err class="vm-tsv-import-err" hidden></p>
  <div class="vm-tsv-import-actions vm-tsv-import-actions--footer">
    <button type="button" class="btn-small vm-tsv-import-btn-convert" data-convert disabled>${escHtml(tr.tsvImportConvertBtn)}</button>
    <button type="button" class="btn-small" data-cancel-w>${escHtml(tr.tsvImportWizardCancel)}</button>
  </div>
</div>`;

        const errEl = overlay.querySelector("[data-err]");
        const previewHost = overlay.querySelector("[data-preview-host]");
        const timeSel = overlay.querySelector("[data-time-col]");
        const timeModeSel = overlay.querySelector("[data-time-mode]");
        const timeColWrap = overlay.querySelector("[data-time-col-wrap]");
        const timeDeltaWrap = overlay.querySelector("[data-time-delta-wrap]");
        const timeDeltaInput = overlay.querySelector("[data-time-delta]");
        const btnConvert = overlay.querySelector("[data-convert]");
        let previewOk = false;
        const readTimeMode = () => (timeModeSel?.value === "synthetic" ? "synthetic" : "column");
        const syncTimeModeUi = () => {
            const synthetic = readTimeMode() === "synthetic";
            if (timeColWrap) timeColWrap.style.display = synthetic ? "none" : "";
            if (timeDeltaWrap) timeDeltaWrap.style.display = synthetic ? "" : "none";
            if (timeSel) timeSel.disabled = synthetic;
            if (timeDeltaInput) timeDeltaInput.disabled = !synthetic;
        };

        const readDelims = () => ({
            tab: !!overlay.querySelector('[data-d="tab"]').checked,
            space: !!overlay.querySelector('[data-d="space"]').checked,
            semicolon: !!overlay.querySelector('[data-d="semicolon"]').checked,
            comma: !!overlay.querySelector('[data-d="comma"]').checked,
        });

        const readDecimal = () =>
            overlay.querySelector('input[name="vmTsvDec"]:checked')?.value === "comma" ? "comma" : "dot";

        const showErr = (msg) => {
            errEl.textContent = msg || "";
            errEl.hidden = !msg;
        };

        const finish = (v) => {
            overlay.remove();
            resolve(v);
        };

        overlay.querySelector("[data-preview]").addEventListener("click", () => {
            showErr("");
            previewOk = false;
            btnConvert.disabled = true;
            let delims;
            try {
                delims = readDelims();
                buildDelimiterRegex(delims);
            } catch (e) {
                showErr(mapError(e, tr));
                previewHost.textContent = tr.tsvImportPreviewEmpty;
                return;
            }
            const text = previewCache || "";
            let pr;
            try {
                pr = previewSplitLines(text, delims, 18);
            } catch (e) {
                showErr(mapError(e, tr));
                previewHost.textContent = tr.tsvImportPreviewEmpty;
                return;
            }
            const { header, rows } = pr;
            if (!header.length) {
                showErr(tr.tsvImportErrEmpty);
                previewHost.textContent = tr.tsvImportPreviewEmpty;
                return;
            }
            const check = validatePreviewColumnWidths(header, rows, 80);
            const colCount = Math.max(header.length, ...rows.map((r) => r.length), 1);
            const prevHtml = ["<table class='vm-tsv-import-preview-table'><thead><tr>"];
            for (let i = 0; i < colCount; i++) {
                const h = i < header.length ? header[i] : "";
                const thLabel = h || (i >= header.length ? `[${i + 1}]` : "");
                prevHtml.push(`<th>${escHtml(thLabel)}</th>`);
            }
            prevHtml.push("</tr></thead><tbody>");
            for (const row of rows) {
                const mismatch = row.length !== header.length;
                prevHtml.push(
                    `<tr${mismatch ? ' class="vm-tsv-import-preview-row-mismatch"' : ""}>`,
                );
                for (let i = 0; i < colCount; i++) {
                    prevHtml.push(`<td>${escHtml(row[i] ?? "")}</td>`);
                }
                prevHtml.push("</tr>");
            }
            prevHtml.push("</tbody></table>");
            previewHost.innerHTML = prevHtml.join("");
            timeSel.innerHTML = "";
            for (const h of header) {
                const o = document.createElement("option");
                o.value = h;
                o.textContent = h || "(vacío)";
                timeSel.appendChild(o);
            }
            const def = header.indexOf("time_s");
            timeSel.selectedIndex = timeSel.options.length ? (def >= 0 ? def : 0) : 0;
            syncTimeModeUi();
            if (!check.ok) {
                showErr(
                    (tr.tsvImportErrColMismatch || "")
                        .replace("%row%", String(check.row))
                        .replace("%exp%", String(check.expected))
                        .replace("%act%", String(check.actual)),
                );
                previewOk = false;
                btnConvert.disabled = true;
                return;
            }
            previewOk = true;
            btnConvert.disabled = false;
        });

        overlay.querySelector("[data-convert]").addEventListener("click", async () => {
            if (!previewOk) return;
            showErr("");
            let delims;
            try {
                delims = readDelims();
            } catch (e) {
                showErr(mapError(e, tr));
                return;
            }
            const decimalSeparator = readDecimal();
            const timeMode = readTimeMode();
            const timeColumn = (timeSel.value || "").trim();
            const timeStepSec = Number(timeDeltaInput?.value || 0.01);
            if (timeMode === "column" && !timeColumn) {
                showErr(tr.tsvImportErrTimeMissing);
                return;
            }
            if (timeMode === "synthetic" && (!Number.isFinite(timeStepSec) || timeStepSec <= 0)) {
                showErr(tr.tsvImportErrTimeDeltaInvalid || "Delta time_s inválido.");
                return;
            }
            btnConvert.disabled = true;
            btnConvert.textContent = tr.tsvImportSaving || "…";
            let fullText;
            try {
                fullText = await getFullText();
            } catch (e) {
                showErr(mapError(e, tr));
                btnConvert.disabled = false;
                btnConvert.textContent = tr.tsvImportConvertBtn;
                return;
            }
            let tsv;
            try {
                tsv = buildCanonicalVarMonitorTsv(fullText, {
                    delimiters: delims,
                    decimalSeparator,
                    timeMode,
                    timeColumn,
                    timeStepSec,
                });
            } catch (e) {
                showErr(mapError(e, tr));
                btnConvert.disabled = false;
                btnConvert.textContent = tr.tsvImportConvertBtn;
                return;
            }
            const stem = safeBasenameStem(originalFilename);
            try {
                const filename = await postSaveConverted(stem, tsv);
                await onSaved(filename);
            } catch (e) {
                showErr((tr.tsvImportErrSave || "%s").replace("%s", e.message || String(e)));
                btnConvert.disabled = false;
                btnConvert.textContent = tr.tsvImportConvertBtn;
                return;
            }
            finish("done");
        });

        overlay.querySelector("[data-cancel-w]").addEventListener("click", () => finish("cancel"));
        if (timeModeSel) {
            timeModeSel.addEventListener("change", () => {
                syncTimeModeUi();
                previewOk = false;
                btnConvert.disabled = true;
            });
        }
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) finish("cancel");
        });

        document.body.appendChild(overlay);
        syncTimeModeUi();
    });
}

/**
 * @param {object} o
 * @param {object} o.tr
 * @param {string} o.originalFilename
 * @param {() => Promise<string>} o.getPreviewText
 * @param {() => Promise<string>} o.getFullText
 * @param {() => Promise<void>} o.onAuto
 * @param {(convertedFilename: string) => Promise<void>} o.onManualSuccess
 */
export async function runTsvChooserAndMaybeWizard(o) {
    const mode = await openTsvImportChooser(o.tr);
    if (mode === "cancel") return;
    if (mode === "auto") {
        await o.onAuto();
        return;
    }
    const w = await openTsvConvertWizard({
        tr: o.tr,
        originalFilename: o.originalFilename,
        getPreviewText: o.getPreviewText,
        getFullText: o.getFullText,
        onSaved: (fn) => o.onManualSuccess(fn),
    });
    if (w !== "done") return;
}
