/**
 * Shared SPICE line preprocessing and tokenisation (netlist + expanders).
 */

/** Strip comments and blank lines, and fold '+'-continuation lines into the previous entry. */
export function preprocess(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let line of raw) {
        const semi = line.indexOf(';');
        if (semi >= 0) line = line.slice(0, semi);
        const slash = line.indexOf('//');
        if (slash >= 0) line = line.slice(0, slash);
        line = line.trimEnd();
        if (line.length === 0) { out.push(''); continue; }
        const first = line.trimStart()[0];
        if (first === '*') { out.push(''); continue; }
        if (first === '+' && out.length > 0) {
            out[out.length - 1] = `${out[out.length - 1]} ${line.trimStart().slice(1)}`;
        } else {
            out.push(line);
        }
    }
    return out;
}

/**
 * Split a line into tokens, preserving parenthesised groups like
 * SIN(0 1 1k) as a single token.
 */
export function tokenize(line) {
    const out = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
        while (i < n && /\s/.test(line[i])) i++;
        if (i >= n) break;
        let start = i;
        let depth = 0;
        while (i < n) {
            const ch = line[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (depth === 0 && /\s/.test(ch)) break;
            i++;
        }
        out.push(line.slice(start, i));
    }
    return out;
}
