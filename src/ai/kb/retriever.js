/**
 * Tiny BM25 retriever.
 *
 * Given a corpus of chunks (each with `title` and `text`), we build an
 * inverted index and rank chunks against a user query. No ML model, no
 * network — retrieval is sub-millisecond for a few thousand chunks, so
 * it's safe to run synchronously on every send.
 */

const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
    'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'as', 'into',
    'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
    'it', 'its', 'we', 'you', 'your', 'i', 'my', 'me', 'our', 'they', 'them',
    'do', 'does', 'did', 'done', 'doing', 'have', 'has', 'had', 'having',
    'can', 'could', 'should', 'would', 'will', 'may', 'might', 'must',
    'not', 'no', 'yes', 'so', 'too', 'very', 'just', 'about', 'how', 'what',
    'when', 'where', 'who', 'why', 'which', 'there', 'here',
]);

function tokenize(text) {
    if (!text) return [];
    return String(text)
        .toLowerCase()
        // split on anything that isn't a letter, digit, or a few symbols we
        // want to keep intact (dash, underscore keep compound tokens).
        .split(/[^a-z0-9_\-]+/)
        .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build a BM25 index over an array of `{ id, title, text, ...rest }`.
 * Returned object exposes `search(query, k)` → ranked chunk hits with scores.
 */
export function buildBM25(chunks, { k1 = 1.5, b = 0.75 } = {}) {
    const docs = chunks.map((c, i) => {
        // Title terms carry more weight by duplicating them at index time.
        const body = `${c.title || ''} ${c.title || ''} ${c.text || ''}`;
        const toks = tokenize(body);
        const tf = new Map();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        return { i, id: c.id ?? i, len: toks.length, tf, raw: c };
    });

    const N = docs.length || 1;
    const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;

    // Document frequency per term.
    const df = new Map();
    for (const d of docs) {
        for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }

    const idf = new Map();
    for (const [t, n] of df.entries()) {
        // BM25+ style smoothing: avoids negative IDF for very common terms.
        idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }

    function score(doc, qTerms) {
        let s = 0;
        for (const t of qTerms) {
            const tf = doc.tf.get(t);
            if (!tf) continue;
            const w = idf.get(t) || 0;
            const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (doc.len / (avgdl || 1))));
            s += w * norm;
        }
        return s;
    }

    function search(query, k = 4) {
        const qTerms = tokenize(query);
        if (qTerms.length === 0) return [];
        const scored = docs
            .map((d) => ({ doc: d, score: score(d, qTerms) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
        return scored.map((r) => ({ ...r.doc.raw, score: r.score }));
    }

    return { search, size: docs.length };
}

/**
 * Clip a chunk body to an approximate character budget while preserving
 * leading sentences — so retrieved context never balloons the prompt.
 */
export function clipText(text, maxChars) {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    const slice = text.slice(0, maxChars);
    const lastStop = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('\n'),
    );
    return (lastStop > maxChars * 0.6 ? slice.slice(0, lastStop + 1) : slice).trimEnd() + '…';
}
