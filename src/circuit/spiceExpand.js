/**
 * SPICE netlist expansion: `.include`, `.lib` (full-file only), and flat
 * `.subckt` / `X` instantiation into primitives the Circuit Studio parser
 * already understands.
 *
 * Limitations (v1):
 *   - Include files must be supplied by the caller as a string map
 *     (browser: user-managed "library" text); there is no filesystem I/O.
 *   - `.lib file section` loads the whole file; section filtering is not
 *     implemented (warning emitted).
 *   - No nested `.subckt` inside another `.subckt`.
 *   - `X` expansion only targets subcircuits collected from the merged
 *     text; BSIM vendor equations are not evaluated — only our existing
 *     D/Q/M/E/G/O/R/C/L/V/I models apply after expansion.
 */

import { preprocess, tokenize } from './spiceLineUtils.js';

/** @typedef {Record<string, string>} IncludeFileMap */

/**
 * @param {IncludeFileMap} fileMap
 * @param {string} requestedPath
 * @returns {string|null}
 */
function lookupIncludeFile(fileMap, requestedPath) {
    const raw = String(requestedPath || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (fileMap[raw] != null) return fileMap[raw];
    if (fileMap[lower] != null) return fileMap[lower];
    const base = raw.split(/[/\\]/).pop().toLowerCase();
    for (const [k, v] of Object.entries(fileMap)) {
        if (!k) continue;
        const kb = k.split(/[/\\]/).pop().toLowerCase();
        if (kb === base) return v;
    }
    return null;
}

function expandIncludesLines(lines, fileMap, depth, stack, warnings, errors) {
    if (depth > 48) {
        errors.push('.include: nesting depth limit exceeded');
        return lines;
    }
    const out = [];
    for (const line of lines) {
        const t = line.trim();
        if (/^\.lib\b/i.test(t)) {
            const rest = t.replace(/^\.lib\b/i, '').trim();
            const parts = tokenize(rest);
            const path = (parts[0] || '').replace(/^["']|["']$/g, '');
            const section = parts[1] || '';
            if (section) {
                warnings.push(`.lib ${path}: section "${section}" ignored — using full file`);
            }
            const content = lookupIncludeFile(fileMap, path);
            if (content == null) {
                errors.push(`.lib file not in library: ${path}`);
                continue;
            }
            const key = path.toLowerCase();
            if (stack.has(key)) {
                errors.push(`Circular .lib / .include: ${path}`);
                continue;
            }
            stack.add(key);
            const inner = expandIncludesLines(preprocess(content), fileMap, depth + 1, stack, warnings, errors);
            stack.delete(key);
            for (const L of inner) out.push(L);
            continue;
        }
        if (/^\.include\b/i.test(t)) {
            const path = t.replace(/^\.include\b/i, '').trim().replace(/^["']|["']$/g, '');
            if (!path) {
                warnings.push('Empty .include line skipped');
                continue;
            }
            const content = lookupIncludeFile(fileMap, path);
            if (content == null) {
                errors.push(`.include file not in library: ${path}`);
                continue;
            }
            const key = path.toLowerCase();
            if (stack.has(key)) {
                errors.push(`Circular .include: ${path}`);
                continue;
            }
            stack.add(key);
            const inner = expandIncludesLines(preprocess(content), fileMap, depth + 1, stack, warnings, errors);
            stack.delete(key);
            for (const L of inner) out.push(L);
            continue;
        }
        out.push(line);
    }
    return out;
}

/**
 * Pull `.subckt … .ends` blocks out of `lines`; return top-level lines
 * without those blocks plus a map name → { ports, body }.
 */
function extractSubcircuits(lines, errors, warnings) {
    /** @type {Map<string, { ports: string[], body: string[] }>} */
    const circuits = new Map();
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        const t = raw.trim();
        if (!t) {
            out.push(raw);
            i++;
            continue;
        }
        if (/^\.subckt\b/i.test(t)) {
            const rest = t.replace(/^\.subckt\s+/i, '');
            const parts = tokenize(rest);
            const name = (parts[0] || '').toLowerCase();
            const ports = parts.slice(1);
            if (!name) {
                errors.push('Invalid .subckt (missing name)');
                i++;
                continue;
            }
            const body = [];
            i++;
            let foundEnds = false;
            while (i < lines.length) {
                const ti = lines[i].trim();
                if (/^\.subckt\b/i.test(ti)) {
                    errors.push(`Nested .subckt inside "${name}" is not supported`);
                    while (i < lines.length && !/^\.ends\b/i.test(lines[i].trim())) i++;
                    if (i < lines.length) i++;
                    body.length = 0;
                    foundEnds = true;
                    break;
                }
                if (/^\.ends\b/i.test(ti)) {
                    i++;
                    foundEnds = true;
                    break;
                }
                body.push(lines[i]);
                i++;
            }
            if (!foundEnds) {
                errors.push(`.subckt "${name}" missing .ends`);
                continue;
            }
            if (body.length === 0) {
                continue;
            }
            if (circuits.has(name)) {
                warnings.push(`Subcircuit "${name}" redefined — last wins`);
            }
            circuits.set(name, { ports, body });
            continue;
        }
        out.push(lines[i]);
        i++;
    }
    return { mainLines: out, circuits };
}

function locRemapNode(tok, portMap, pref) {
    const tl = String(tok).toLowerCase();
    if (tl === '0' || tl === 'gnd') return '0';
    if (portMap.has(tl)) return portMap.get(tl);
    return `${pref}${tok}`;
}

function remapDeviceLine(line, portMap, pref, modelRenames) {
    const toks = tokenize(line.trim());
    if (toks.length === 0) return line;
    const tag = toks[0][0].toUpperCase();
    const head = toks[0];
    const out = [head];
    const mapN = (t) => locRemapNode(t, portMap, pref);
    const mapMdl = (m) => {
        const ml = String(m).toLowerCase();
        return modelRenames.get(ml) || m;
    };

    switch (tag) {
        case 'R':
        case 'C':
        case 'L':
            out.push(mapN(toks[1]), mapN(toks[2]), ...toks.slice(3));
            break;
        case 'V':
        case 'I':
            out.push(mapN(toks[1]), mapN(toks[2]), ...toks.slice(3));
            break;
        case 'D':
            out.push(mapN(toks[1]), mapN(toks[2]), mapMdl(toks[3] || 'default'));
            break;
        case 'E':
        case 'G':
            out.push(mapN(toks[1]), mapN(toks[2]), mapN(toks[3]), mapN(toks[4]), ...toks.slice(5));
            break;
        case 'O':
            out.push(mapN(toks[1]), mapN(toks[2]), mapN(toks[3]));
            break;
        case 'Q': {
            const mIdx = toks.length >= 6 ? 5 : 4;
            for (let j = 1; j < mIdx; j++) out.push(mapN(toks[j]));
            out.push(mapMdl(toks[mIdx] || 'qdefault'), ...toks.slice(mIdx + 1));
            break;
        }
        case 'M': {
            out.push(
                mapN(toks[1]),
                mapN(toks[2]),
                mapN(toks[3]),
                mapN(toks[4] || '0'),
                mapMdl(toks[5] || 'mdefault'),
                ...toks.slice(6),
            );
            break;
        }
        default:
            return line;
    }
    return out.join(' ');
}

function collectModelRenamesFromBody(bodyLines, pref) {
    const renames = new Map();
    for (const bl of bodyLines) {
        const t = bl.trim();
        if (!/^\.model\b/i.test(t)) continue;
        const rest = t.replace(/^\.model\s+/i, '');
        const mname = tokenize(rest)[0];
        if (mname) renames.set(mname.toLowerCase(), `${pref}${mname}`);
    }
    return renames;
}

function rewriteModelDirective(line, modelRenames) {
    const t = line.trim();
    const rest = t.replace(/^\.model\s+/i, '');
    const toks = tokenize(rest);
    const oldName = toks[0];
    if (!oldName) return line;
    const newName = modelRenames.get(oldName.toLowerCase()) || oldName;
    return `.model ${newName} ${toks.slice(1).join(' ')}`;
}

function expandOneXLine(line, circuits, errors) {
    const t = line.trim();
    const toks = tokenize(t);
    const head = toks[0] || '';
    if (head[0].toUpperCase() !== 'X' || toks.length < 3) return { expanded: false, lines: null };
    const cell = toks[toks.length - 1].toLowerCase();
    const sub = circuits.get(cell);
    if (!sub) return { expanded: false, lines: null };

    const ext = toks.slice(1, -1);
    if (ext.length !== sub.ports.length) {
        errors.push(
            `Subcircuit "${cell}": ${head} has ${ext.length} nodes but definition expects ${sub.ports.length}`,
        );
        return { expanded: false, lines: null };
    }
    const portMap = new Map();
    for (let k = 0; k < sub.ports.length; k++) {
        portMap.set(sub.ports[k].toLowerCase(), ext[k]);
    }
    const pref = `_${head.replace(/[^\w]/g, '_')}_`;
    const modelRenames = collectModelRenamesFromBody(sub.body, pref);
    const outLines = [];
    for (const bl of sub.body) {
        const bt = bl.trim();
        if (!bt) continue;
        if (/^\.subckt\b/i.test(bt)) {
            errors.push(`Nested .subckt inside "${cell}"`);
            return { expanded: false, lines: null };
        }
        if (/^\.model\b/i.test(bt)) {
            outLines.push(rewriteModelDirective(bl, modelRenames));
        } else if (/^\.(ends|end)\b/i.test(bt)) {
            continue;
        } else {
            outLines.push(remapDeviceLine(bl, portMap, pref, modelRenames));
        }
    }
    return { expanded: true, lines: outLines };
}

function flattenXInstances(mainLines, circuits, errors, maxPasses = 200) {
    let lines = mainLines.slice();
    for (let pass = 0; pass < maxPasses; pass++) {
        let changed = false;
        const next = [];
        for (const line of lines) {
            const t = line.trim();
            if (!t) {
                next.push(line);
                continue;
            }
            const ex = expandOneXLine(line, circuits, errors);
            if (ex.expanded && ex.lines?.length) {
                for (const L of ex.lines) next.push(L);
                changed = true;
            } else {
                next.push(line);
            }
        }
        lines = next;
        if (!changed) break;
    }
    return lines;
}

/**
 * Expand `.include` / `.lib`, extract `.subckt`, flatten `X` references.
 *
 * @param {string} text
 * @param {IncludeFileMap} includeFiles
 * @returns {{ text: string, warnings: string[], errors: string[] }}
 */
export function expandSpiceForParse(text, includeFiles) {
    const warnings = [];
    const errors = [];
    const map = includeFiles && typeof includeFiles === 'object' ? includeFiles : {};
    let lines = preprocess(text);
    const stack = new Set();
    lines = expandIncludesLines(lines, map, 0, stack, warnings, errors);
    const merged = lines.join('\n');
    lines = preprocess(merged);

    const { mainLines, circuits } = extractSubcircuits(lines, errors, warnings);
    const flat = flattenXInstances(mainLines, circuits, errors);
    return { text: flat.join('\n'), warnings, errors };
}
