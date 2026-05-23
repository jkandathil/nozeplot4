/**
 * Download helpers used by the Circuit Studio File menu.
 *
 * Everything here is client-side: we blob the payload, synthesise an
 * <a download>, click it, then revoke the object URL. No network,
 * no libraries. Safe to call from any React handler.
 *
 * Filename sanitisation keeps exported files portable across the
 * macOS / Windows filesystem zoo and avoids surprises when users
 * rename projects with punctuation.
 */

import { toExportEnvelope } from './projects.js';

/** Slugify a project name into a safe filesystem fragment. */
export function safeFilename(name, fallback = 'untitled') {
    const s = String(name || '').trim();
    if (!s) return fallback;
    return s
        .replace(/[^a-z0-9_\- ]+/gi, '')
        .replace(/\s+/g, '_')
        .slice(0, 64)
        .toLowerCase() || fallback;
}

/**
 * Trigger a browser download of `content` with the given filename.
 * Works for plain text, JSON, CSV, SVG, etc.
 */
export function downloadBlob(content, filename, mime = 'application/octet-stream') {
    if (typeof document === 'undefined') return;
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation so Safari actually writes the file.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ----------------------- project exports --------------------- */

/** Export a full project as a self-describing `.noze.json` envelope. */
export function exportProjectJson(project) {
    const env = toExportEnvelope(project);
    const text = JSON.stringify(env, null, 2);
    downloadBlob(text, `${safeFilename(project.name)}.noze.json`, 'application/json');
}

/** Export just the SPICE netlist text for the current project. */
export function exportSpiceNetlist(netlistText, projectName) {
    if (!netlistText) return;
    downloadBlob(netlistText, `${safeFilename(projectName)}.cir`, 'text/plain');
}

/* ----------------------- result exports ---------------------- */

/**
 * Dump a simulation result to CSV. Writes one column per selected
 * signal with the primary x axis (time / frequency / DC sweep var)
 * in the first column.
 *
 * For AC we export magnitude; callers that want phase can add a
 * "<signal>_phase" entry alongside the signal name.
 */
export function exportResultsCsv(result, selectedSignals, projectName) {
    if (!result || !result.signals) return;
    const sigMap = new Map(result.signals.map((s) => [s.name, s]));

    let xLabel, xs;
    if (result.kind === 'tran') { xLabel = 'time(s)';  xs = result.t || []; }
    else if (result.kind === 'ac') { xLabel = 'freq(Hz)'; xs = result.f || []; }
    else if (result.kind === 'dc') { xLabel = 'x';       xs = result.x || []; }
    else if (result.kind === 'op') {
        const sw = result.opSweep;
        if (sw?.rows?.length && sw.stepValues?.length) {
            const head = ['node', ...sw.stepValues.map((v) => `${sw.target}=${v}`)];
            const rows = [head.map(csvEsc).join(',')];
            for (const row of sw.rows) {
                rows.push([row.name, ...row.values].map(csvEsc).join(','));
            }
            downloadBlob(rows.join('\n'), `${safeFilename(projectName)}_op.csv`, 'text/csv');
            return;
        }
        const rows = ['node,value'];
        for (const nv of result.nodeVals || []) {
            rows.push(`${csvEsc(nv.name)},${nv.value}`);
        }
        downloadBlob(rows.join('\n'), `${safeFilename(projectName)}_op.csv`, 'text/csv');
        return;
    } else {
        xLabel = 'x'; xs = [];
    }

    const cols = (selectedSignals && selectedSignals.length > 0)
        ? selectedSignals
        : result.signals.map((s) => s.name);

    // For AC sweeps, append a phase column after each selected trace so
    // spreadsheets get both |V| (linear) and phase (degrees).
    const colDefs = [];
    for (const name of cols) {
        colDefs.push({ header: name, sigName: name, part: 'main' });
        const sig = sigMap.get(name);
        if (result.kind === 'ac' && sig?.phase?.length && sig.yMode !== 'noiseV2') {
            colDefs.push({
                header: `${name}_phase_deg`,
                sigName: name,
                part: 'phase',
            });
        }
    }

    const header = [xLabel, ...colDefs.map((c) => c.header)].map(csvEsc).join(',');
    const rows = [header];
    const N = xs.length;
    for (let i = 0; i < N; i++) {
        const row = [xs[i]];
        for (const c of colDefs) {
            const sig = sigMap.get(c.sigName);
            let v;
            if (c.part === 'phase') {
                v = sig?.phase?.[i];
            } else {
                v = sig?.y?.[i] ?? sig?.mag?.[i] ?? '';
            }
            row.push(Number.isFinite(v) ? v : '');
        }
        rows.push(row.join(','));
    }
    downloadBlob(rows.join('\n'), `${safeFilename(projectName)}_${result.kind}.csv`, 'text/csv');
}

function csvEsc(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/* ----------------------- canvas export ----------------------- */

/**
 * Find the Circuit Studio canvas SVG in the DOM (see Canvas.jsx —
 * the root <svg> carries a `data-cs-canvas-svg` attribute) and
 * serialise it to a standalone `.svg` file the user can open in any
 * vector editor.
 */
export function exportCanvasSvg(projectName) {
    if (typeof document === 'undefined') return;
    const svg = document.querySelector('[data-cs-canvas-svg]');
    if (!svg) throw new Error('Canvas not ready for export.');
    const clone = svg.cloneNode(true);
    // Strip interactive hover/focus-only elements so the export looks
    // like the "rested" state of the schematic.
    clone.querySelectorAll('.cs-canvas-preview, .cs-canvas-marquee').forEach((el) => el.remove());
    // Inline the namespace so raw SVG opens everywhere.
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    const xml = new XMLSerializer().serializeToString(clone);
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
    downloadBlob(text, `${safeFilename(projectName)}.svg`, 'image/svg+xml');
}

/**
 * Rasterise the current canvas SVG to a PNG and download it. We
 * render via the <img> + <canvas> trick rather than pulling in a
 * heavy dependency.
 */
export async function exportCanvasPng(projectName) {
    if (typeof document === 'undefined') return;
    const svg = document.querySelector('[data-cs-canvas-svg]');
    if (!svg) throw new Error('Canvas not ready for export.');
    const clone = svg.cloneNode(true);
    clone.querySelectorAll('.cs-canvas-preview, .cs-canvas-marquee').forEach((el) => el.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const rect = svg.getBoundingClientRect();
    const w = Math.max(64, Math.round(rect.width));
    const h = Math.max(64, Math.round(rect.height));
    // Preserve the visible aspect in the exported PNG by pinning the
    // clone's pixel width/height attributes to the on-screen size.
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));

    const xml = new XMLSerializer().serializeToString(clone);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);

    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    const scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    // Paint the studio's dark body behind the transparent SVG so the
    // PNG actually looks like the app and not a ghost schematic.
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${safeFilename(projectName)}.png`, 'image/png');
    }, 'image/png');
}
