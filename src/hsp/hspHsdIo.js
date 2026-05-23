/**
 * HSPiP-compatible HSD / CSV import and export.
 * Tab-separated HSD is the interchange format used by HSPiPy and legacy HSPiP.
 */

import { hspRED } from './hspMath.js';

function parseMetaLine(line) {
    const trimmed = String(line || '').replace(/^#+\s*/, '').trim();
    if (!trimmed) return null;
    const cells = trimmed.split(/\t|,/).map((c) => c.trim());
    const key = (cells[0] || '').toLowerCase();
    if (!key) return null;

    if (key === 'sphere' || key.startsWith('sphere ')) {
        const dD = parseFloat(cells[1]);
        const dP = parseFloat(cells[2]);
        const dH = parseFloat(cells[3]);
        let R = parseFloat(cells[4]);
        const rMatch = String(cells[4] || '').match(/R\s*=\s*([\d.]+)/i);
        if (rMatch) R = parseFloat(rMatch[1]);
        if (!Number.isFinite(R) && cells[5]) {
            const r2 = String(cells[5]).match(/R\s*=\s*([\d.]+)/i);
            if (r2) R = parseFloat(r2[1]);
        }
        if (!Number.isFinite(dD)) return null;
        return {
            type: 'sphere',
            sphere: {
                dD,
                dP: Number.isFinite(dP) ? dP : 0,
                dH: Number.isFinite(dH) ? dH : 0,
                R: Number.isFinite(R) ? R : 8,
            },
        };
    }
    if (key === 'r_outer' || key === 'r outer') {
        const Ro = parseFloat(cells[1]);
        return Number.isFinite(Ro) ? { type: 'r_outer', value: Ro } : null;
    }
    if (key === 'material' || key === 'polymer') {
        return { type: 'material', value: cells.slice(1).join('\t') || cells[1] || '' };
    }
    if (key === 'temperaturec' || key === 'temperature') {
        const t = parseFloat(cells[1]);
        return Number.isFinite(t) ? { type: 'temperatureC', value: t } : null;
    }
    if (key === 'fitmode') return { type: 'fitMode', value: cells[1] || 'single' };
    if (key === 'fitengine') return { type: 'fitEngine', value: cells[1] || 'gradient' };
    if (key === 'spherename') return { type: 'sphereName', value: cells.slice(1).join('\t') || '' };
    return null;
}

/**
 * Parse tab- or comma-separated HSP data file content.
 * Expected columns (flexible header): Solvent, D/dD, P/dP, H/dH, Score, CAS, SMILES
 *
 * @param {string} text
 * @returns {{ solvents: Array<object>, spheres: Array<object>, meta: object, rawRows: number }}
 */
export function parseHsdText(text) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) {
        return { solvents: [], spheres: [], meta: {}, rawRows: 0 };
    }

    const meta = {};
    let sphere = null;
    const dataLines = [];

    for (const line of lines) {
        if (/^\s*#/.test(line)) {
            const parsed = parseMetaLine(line);
            if (!parsed) continue;
            if (parsed.type === 'sphere') {
                sphere = { ...parsed.sphere };
            } else if (parsed.type === 'r_outer' && sphere) {
                sphere.R_outer = parsed.value;
            } else if (parsed.type === 'material') {
                meta.material = parsed.value;
            } else if (parsed.type === 'temperatureC') {
                meta.temperatureC = parsed.value;
            } else if (parsed.type === 'fitMode') {
                meta.fitMode = parsed.value;
            } else if (parsed.type === 'fitEngine') {
                meta.fitEngine = parsed.value;
            } else if (parsed.type === 'sphereName' && sphere) {
                sphere.name = parsed.value;
                meta.material = meta.material || parsed.value;
            }
            continue;
        }
        dataLines.push(line);
    }

    if (dataLines.length === 0) {
        return {
            solvents: [],
            spheres: sphere ? [sphere] : [],
            meta,
            rawRows: lines.length,
        };
    }

    const delim = dataLines[0].includes('\t') ? '\t' : ',';
    const header = dataLines[0].split(delim).map((h) => h.trim().toLowerCase());
    const col = (names) => header.findIndex((h) => names.some((n) => h.includes(n)));

    const iName = col(['solvent', 'name', 'chemical']);
    const iD = col(['δd', 'dd', 'd']);
    const iP = col(['δp', 'dp', 'p']);
    const iH = col(['δh', 'dh', 'h', 'h-bond']);
    const iScore = col(['score']);
    const iCas = col(['cas']);
    const iSmiles = col(['smiles']);
    const iMvol = col(['mvol', 'volume']);

    const solvents = [];
    const startRow = header.some((h) => h.includes('solvent') || h === 'd') ? 1 : 0;

    for (let r = startRow; r < dataLines.length; r++) {
        const cells = dataLines[r].split(delim);
        const name = cells[iName >= 0 ? iName : 0]?.trim();
        const dD = parseFloat(cells[iD >= 0 ? iD : 1]);
        const dP = parseFloat(cells[iP >= 0 ? iP : 2]);
        const dH = parseFloat(cells[iH >= 0 ? iH : 3]);
        if (!name || !Number.isFinite(dD)) continue;
        solvents.push({
            name,
            dD,
            dP: Number.isFinite(dP) ? dP : 0,
            dH: Number.isFinite(dH) ? dH : 0,
            score: iScore >= 0 ? parseFloat(cells[iScore]) : undefined,
            cas: iCas >= 0 ? cells[iCas]?.trim() : '',
            smiles: iSmiles >= 0 ? cells[iSmiles]?.trim() : '',
            molarVolume: iMvol >= 0 ? parseFloat(cells[iMvol]) : undefined,
            category: 'imported',
            source: 'hsd',
        });
    }

    if (sphere && meta.material && !sphere.name) sphere.name = meta.material;

    return {
        solvents,
        spheres: sphere ? [sphere] : [],
        meta,
        rawRows: lines.length,
    };
}

/** Parse simple HSDX-like XML subset. */
export function parseHsdxText(text) {
    const solvents = [];
    let sphere = null;
    const meta = {};
    const blocks = String(text || '').match(/<Chemical>[\s\S]*?<\/Chemical>/gi) || [];
    for (const block of blocks) {
        const tag = (name) => {
            const m = block.match(new RegExp(`<${name}[^>]*>([^<]*)`, 'i'));
            return m ? m[1].trim() : '';
        };
        const name = tag('Solvent') || tag('Name');
        const dD = parseFloat(tag('δD') || tag('D'));
        const dP = parseFloat(tag('δP') || tag('P'));
        const dH = parseFloat(tag('δH') || tag('H'));
        const score = parseFloat(tag('Score'));
        if (!name || !Number.isFinite(dD)) continue;
        solvents.push({
            name, dD, dP: dP || 0, dH: dH || 0,
            score: Number.isFinite(score) ? score : undefined,
            category: 'imported',
            source: 'hsdx',
        });
    }

    const sphereBlock = String(text || '').match(/<Sphere>[\s\S]*?<\/Sphere>/i)?.[0];
    if (sphereBlock) {
        const tag = (name) => {
            const m = sphereBlock.match(new RegExp(`<${name}[^>]*>([^<]*)`, 'i'));
            return m ? m[1].trim() : '';
        };
        const dD = parseFloat(tag('δD') || tag('D'));
        const dP = parseFloat(tag('δP') || tag('P'));
        const dH = parseFloat(tag('δH') || tag('H'));
        const R = parseFloat(tag('R'));
        const Ro = parseFloat(tag('R_outer') || tag('Ro'));
        if (Number.isFinite(dD)) {
            sphere = {
                dD, dP: dP || 0, dH: dH || 0,
                R: Number.isFinite(R) ? R : 8,
                R_outer: Number.isFinite(Ro) ? Ro : undefined,
                name: tag('Name') || tag('Material') || 'Imported sphere',
            };
            meta.material = sphere.name;
        }
    }

    return {
        solvents,
        spheres: sphere ? [sphere] : [],
        meta,
        rawRows: blocks.length,
    };
}

/**
 * Export solvents + sphere + project metadata to HSD tab-separated text.
 *
 * @param {Array<object>} solvents
 * @param {object|null} sphere
 * @param {Array<object>|null} fitRows
 * @param {object} [meta]
 */
export function exportHsdText(solvents, sphere = null, fitRows = null, meta = {}) {
    const lines = [];

    const material = meta.material ?? sphere?.name ?? '';
    if (material) lines.push(`# Material\t${material}`);
    if (meta.temperatureC != null && Number.isFinite(meta.temperatureC)) {
        lines.push(`# TemperatureC\t${meta.temperatureC}`);
    }
    if (meta.fitMode) lines.push(`# FitMode\t${meta.fitMode}`);
    if (meta.fitEngine) lines.push(`# FitEngine\t${meta.fitEngine}`);
    if (sphere) {
        lines.push(`# Sphere\t${sphere.dD}\t${sphere.dP}\t${sphere.dH}\tR=${sphere.R}`);
        if (sphere.R_outer && sphere.R_outer > sphere.R) {
            lines.push(`# R_outer\t${sphere.R_outer}`);
        }
        if (sphere.name && sphere.name !== material) {
            lines.push(`# SphereName\t${sphere.name}`);
        }
    }

    lines.push('Solvent\tD\tP\tH\tScore\tRED\tCAS\tSMILES');

    const rows = fitRows?.length
        ? fitRows.map((r) => {
            const s = solvents.find((x) => x.name === r.name) || r;
            return { ...s, score: r.score, dD: r.dD ?? s.dD, dP: r.dP ?? s.dP, dH: r.dH ?? s.dH };
        })
        : solvents;

    for (const s of rows) {
        const pt = { dD: s.dD, dP: s.dP, dH: s.dH };
        const RED = sphere?.R ? hspRED(pt, sphere).toFixed(3) : '-';
        lines.push([
            s.name,
            (s.dD ?? 0).toFixed(2),
            (s.dP ?? 0).toFixed(2),
            (s.dH ?? 0).toFixed(2),
            s.score ?? '',
            RED,
            s.cas ?? '',
            s.smiles ?? '',
        ].join('\t'));
    }

    if (fitRows?.length && !rows.some((r) => r.score != null)) {
        lines.push('');
        lines.push('# Note: fit rows exported without scores — re-tag in Sphere Fit tab');
    }

    return lines.join('\n');
}

/** Export full project as JSON (HSP Studio native). */
export function exportProjectJson(state) {
    return JSON.stringify({ version: 2, ...state }, null, 2);
}

export function parseProjectJson(text) {
    try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object') return obj;
    } catch { /* ignore */ }
    return null;
}
