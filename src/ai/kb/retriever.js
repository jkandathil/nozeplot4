/**
 * Lightweight hybrid retriever for the NozePlot help corpus.
 *
 * Three signals combine into a single score per chunk:
 *   1. BM25 on unigram tokens — standard IR baseline, captures rare
 *      technical words well (e.g. "LBM", "HyperFormula", "Pyodide").
 *   2. Bigram phrase bonus — boosts chunks that contain the user's
 *      actual word PAIRS ("flow lab", "drift map", "aroma pulse"),
 *      which BM25 alone undervalues since it treats each word
 *      independently.
 *   3. Title/anchor boost — chunks whose title matches query terms
 *      jump to the top. Users ask "how do I use Flow Lab?" expecting
 *      the Flow Lab section, not a tangential mention.
 *
 * After the initial top-N, we run Maximal Marginal Relevance (MMR)
 * to pick a diverse top-k — so the model sees, e.g., the Flow Lab
 * overview + the Flow Lab solver reference, not three copies of the
 * same section. This is what lets the model "connect the dots"
 * across the docs instead of paraphrasing one chunk.
 *
 * Everything is in-memory, zero-network, sub-millisecond for our
 * corpus (~100 chunks). Safe to run synchronously on every send.
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
        .split(/[^a-z0-9_\-]+/)
        .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}

/* Keep stopwords in when extracting bigrams, so phrases like
   "how to plot" still yield ("to","plot") → useful when the user
   asks a natural-language question. But drop leading/trailing
   stopword-only bigrams (e.g. "the","an"). */
function tokenizeForBigrams(text) {
    if (!text) return [];
    return String(text)
        .toLowerCase()
        .split(/[^a-z0-9_\-]+/)
        .filter((t) => t && t.length > 1);
}

function bigrams(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length - 1; i++) {
        out.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return out;
}

/**
 * Build a hybrid (BM25 + phrase + title) index over an array of
 * `{ id, title, text, anchor, source, ...rest }` chunks.
 * Returned object exposes:
 *   - `search(query, k)`                → top-k by combined score
 *   - `searchWithDiversity(query, k)`   → top-N then MMR reranked to k
 *   - `size`                            → corpus size
 */
export function buildBM25(chunks, { k1 = 1.5, b = 0.75 } = {}) {
    const docs = chunks.map((c, i) => {
        const titleTerms = tokenize(c.title || '');
        // Title terms weighted by triplication at index time.
        const body = `${c.title || ''} ${c.title || ''} ${c.title || ''} ${c.text || ''}`;
        const toks = tokenize(body);
        const tf = new Map();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);

        // Lowercased raw text + bigram set for phrase matching.
        const fullLower = `${c.title || ''} ${c.text || ''}`.toLowerCase();
        const bodyBigrams = new Set(bigrams(tokenizeForBigrams(`${c.title || ''} ${c.text || ''}`)));

        return {
            i,
            id: c.id ?? i,
            len: toks.length,
            tf,
            raw: c,
            titleTerms: new Set(titleTerms),
            fullLower,
            bodyBigrams,
        };
    });

    const N = docs.length || 1;
    const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;

    const df = new Map();
    for (const d of docs) {
        for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }

    const idf = new Map();
    for (const [t, n] of df.entries()) {
        idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }

    function bm25Score(doc, qTerms) {
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

    function titleBoost(doc, qTerms) {
        let n = 0;
        for (const t of qTerms) if (doc.titleTerms.has(t)) n += 1;
        // Each matching title term adds a flat 0.8 to the score — enough
        // to float a directly-titled section above tangential mentions.
        return n * 0.8;
    }

    function phraseBoost(doc, qBigrams, qPhrase) {
        let s = 0;
        for (const bg of qBigrams) if (doc.bodyBigrams.has(bg)) s += 0.6;
        // Exact full-phrase substring match gets a big boost.
        if (qPhrase && qPhrase.length > 4 && doc.fullLower.includes(qPhrase)) s += 1.5;
        return s;
    }

    function score(doc, qTerms, qBigrams, qPhrase) {
        return (
            bm25Score(doc, qTerms) +
            titleBoost(doc, qTerms) +
            phraseBoost(doc, qBigrams, qPhrase)
        );
    }

    function scoreAll(query) {
        const qPhrase = String(query || '').toLowerCase().trim();
        const qTerms = tokenize(query);
        const qBigrams = bigrams(tokenizeForBigrams(query));
        if (qTerms.length === 0 && qBigrams.length === 0) return [];
        return docs
            .map((d) => ({ doc: d, score: score(d, qTerms, qBigrams, qPhrase) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score);
    }

    function search(query, k = 4) {
        return scoreAll(query).slice(0, k).map((r) => ({ ...r.doc.raw, score: r.score }));
    }

    /* MMR diversity reranker:
       Given candidates C ranked by relevance and λ = 0.65, iteratively
       pick the candidate that maximises:
          λ * rel(c) − (1 − λ) * max_sim(c, already_picked)
       Similarity is Jaccard over token sets. This removes near-dupes
       (e.g. "Flow Lab" vs "Flow Lab (part 2)") so the model sees
       actually-different perspectives in the context window.    */
    function searchWithDiversity(query, k = 4, { candidateN = 12, lambda = 0.65 } = {}) {
        const ranked = scoreAll(query);
        if (ranked.length === 0) return [];
        const candidates = ranked.slice(0, Math.max(candidateN, k));

        const tokenSets = new Map();
        for (const r of candidates) {
            const set = new Set(tokenize(`${r.doc.raw.title || ''} ${r.doc.raw.text || ''}`));
            tokenSets.set(r.doc.i, set);
        }
        const jaccard = (a, b) => {
            if (!a.size || !b.size) return 0;
            let inter = 0;
            const [small, big] = a.size < b.size ? [a, b] : [b, a];
            for (const t of small) if (big.has(t)) inter += 1;
            return inter / (a.size + b.size - inter);
        };

        const picked = [];
        const pool = [...candidates];
        // Pre-normalise relevance to [0, 1] for a stable MMR tradeoff.
        const maxRel = Math.max(...pool.map((p) => p.score), 1);

        while (picked.length < k && pool.length) {
            let bestIdx = 0;
            let bestScore = -Infinity;
            for (let i = 0; i < pool.length; i++) {
                const cand = pool[i];
                const rel = cand.score / maxRel;
                let maxSim = 0;
                for (const p of picked) {
                    const sim = jaccard(tokenSets.get(cand.doc.i), tokenSets.get(p.doc.i));
                    if (sim > maxSim) maxSim = sim;
                }
                const mmr = lambda * rel - (1 - lambda) * maxSim;
                if (mmr > bestScore) {
                    bestScore = mmr;
                    bestIdx = i;
                }
            }
            picked.push(pool.splice(bestIdx, 1)[0]);
        }
        return picked.map((r) => ({ ...r.doc.raw, score: r.score }));
    }

    return { search, searchWithDiversity, size: docs.length };
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
