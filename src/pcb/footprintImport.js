/**
 * Import footprints from JSON (Noze format) or pasted KiCad .kicad_mod text.
 * Full KiCad geometry is not supported — we extract SMD/TH pads with (at) + (size).
 */

/**
 * @param {string} text
 * @returns {import('./footprintLib.js').FootprintDef}
 */
export function parseNozeFootprintJson(text) {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') throw new Error('Invalid JSON');
    if (!obj.id || !obj.name) throw new Error('Footprint JSON needs id and name');
    if (!Array.isArray(obj.pads) || obj.pads.length === 0) throw new Error('Footprint JSON needs pads[]');
    for (const p of obj.pads) {
        if (!p.num && !p.id) throw new Error('Each pad needs id or num');
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Pads need numeric x, y (mm)');
        const w = Number(p.w) || Number(p.width);
        const h = Number(p.h) || Number(p.height);
        if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('Pads need w/h (mm)');
    }
    return {
        id: String(obj.id).replace(/\s+/g, '_'),
        name: String(obj.name),
        family: String(obj.family || 'USER'),
        pads: obj.pads.map((p, i) => ({
            id: String(p.id || p.num || i + 1),
            num: String(p.num || p.id || i + 1),
            x: Number(p.x),
            y: Number(p.y),
            w: Number(p.w) || Number(p.width),
            h: Number(p.h) || Number(p.height),
        })),
        silk: Array.isArray(obj.silk) ? obj.silk : [],
    };
}

/**
 * Minimal KiCad 6/7 .kicad_mod pad extractor (rect / roundrect / circle / oval SMD & thru_hole).
 * @param {string} text
 * @param {{ id?: string, name?: string }} [opts]
 */
export function parseKiCadModFootprint(text, opts = {}) {
    const src = String(text || '');
    if (!src.includes('(footprint') && !src.includes('(module')) {
        throw new Error('Paste a footprint module body (should contain (footprint or legacy (module))');
    }
    const idMatch = src.match(/\(footprint\s+"([^"]+)"/) || src.match(/\(module\s+"([^"]+)"/);
    const id = (opts.id || idMatch?.[1] || 'imported_fp').replace(/[^\w\-]+/g, '_');
    const name = opts.name || idMatch?.[1] || id;

    const pads = [];
    const padBlockRe =
        /\(pad\s+(?:"([^"]+)"|(\d+))\s+(\S+)\s+(?:rect|roundrect|circle|oval)\s+\(at\s+([-\d.eE+]+)\s+([-\d.eE+]+)(?:\s+([-\d.eE+]+))?\)\s+\(size\s+([-\d.eE+]+)\s+([-\d.eE+]+)/gi;
    let m;
    while ((m = padBlockRe.exec(src)) !== null) {
        const num = String(m[1] || m[2] || pads.length + 1);
        const kind = String(m[3] || '').toLowerCase();
        const x = parseFloat(m[4]);
        const y = parseFloat(m[5]);
        let w = parseFloat(m[7]);
        let h = parseFloat(m[8]);
        if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
        if (kind === 'circle' || kind === 'oval') {
            w = Math.max(w, h);
            h = w;
        }
        pads.push({ id: num, num, x, y, w, h });
    }

    if (pads.length === 0) {
        throw new Error(
            'No pads parsed. Supported: (pad "N" smd|thru_hole rect|roundrect|circle|oval (at x y) (size w h) …)',
        );
    }

    return {
        id,
        name,
        family: 'Import',
        pads,
        silk: [],
    };
}

/** Fetch text; caller handles CORS (same-origin or permissive CDN only). */
export async function fetchFootprintText(url) {
    const u = String(url || '').trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://');
    }
    const res = await fetch(u, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}
