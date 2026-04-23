/**
 * Builds the in-app knowledge base consumed by the AI chat assistant.
 *
 * Sources (all bundled at build time — no network at runtime):
 *   • `GUIDE_SECTIONS` from Help page — single source of truth for the
 *     user guide, so the assistant never drifts from what users can
 *     actually read in the Help tab.
 *   • FlowLab.md — technical reference for the Flow Lab LBM solver.
 *   • Telemetry.md — serial / telemetry command reference.
 *   • README.md   — project-level overview.
 *
 * Each source is normalised into a flat list of `{ id, title, source,
 * anchor, text }` chunks and wrapped in a BM25 index. At chat time we
 * run `.search(query)` to pull the most relevant 2–4 chunks and graft
 * them into the system prompt under a `## App documentation` heading.
 */

import { GUIDE_SECTIONS } from '../../components/HelpPage.jsx';
import flowLabMd from '../../../FlowLab.md?raw';
import telemetryMd from '../../../Telemetry.md?raw';
import readmeMd from '../../../README.md?raw';
import { buildBM25, clipText } from './retriever.js';

/* ---------- Help page sections ------------------------------------ */

function stripBold(s) {
    // Remove `**bold**` emphasis, keep the word.
    return String(s || '').replace(/\*\*(.+?)\*\*/g, '$1');
}

function helpSectionToChunk(section) {
    const parts = [];
    if (section.intro) parts.push(stripBold(section.intro));
    if (section.fundamentals?.length) {
        parts.push('Fundamentals:');
        for (const f of section.fundamentals) parts.push('• ' + stripBold(f));
    }
    if (section.implemented?.length) {
        parts.push('Features:');
        for (const f of section.implemented) parts.push('• ' + stripBold(f));
    }
    if (section.steps?.length) {
        parts.push('How to use:');
        section.steps.forEach((s, i) => parts.push(`${i + 1}. ${stripBold(s)}`));
    }
    return {
        id: `help:${section.id}`,
        title: section.title + (section.subtitle ? ` — ${section.subtitle}` : ''),
        source: 'User guide',
        anchor: section.id,
        text: parts.join('\n'),
    };
}

const HELP_CHUNKS = GUIDE_SECTIONS.map(helpSectionToChunk);

/* Lookup so the grounded-answer engine can recover the original
   structured fields (intro / fundamentals / implemented / steps) for
   help-page sections, instead of working off the flattened text blob. */
const HELP_SECTIONS_BY_ID = new Map();
for (const section of GUIDE_SECTIONS) {
    HELP_SECTIONS_BY_ID.set(`help:${section.id}`, section);
}

/* ---------- Markdown splitter ------------------------------------- */

/**
 * Split a markdown document into section-sized chunks. We split on
 * `##` headings (or `###` when a `##` block is long) so each chunk is
 * coherent and self-contained. Too-large chunks are further sliced on
 * paragraph boundaries to stay under ~1200 chars.
 */
function splitMarkdown(md, sourceLabel, idPrefix) {
    if (!md) return [];
    const lines = md.split('\n');
    const sections = [];
    let currentTitle = '';
    let currentBuf = [];

    const flush = () => {
        const text = currentBuf.join('\n').trim();
        if (text) sections.push({ title: currentTitle || sourceLabel, text });
        currentBuf = [];
    };

    for (const line of lines) {
        const m = /^(#{1,3})\s+(.+)$/.exec(line);
        if (m && m[1].length <= 2) {
            flush();
            currentTitle = m[2].trim();
        } else {
            currentBuf.push(line);
        }
    }
    flush();

    // Secondary split for oversized blocks: break on blank lines.
    const MAX = 1400;
    const out = [];
    sections.forEach((s, idx) => {
        if (s.text.length <= MAX) {
            out.push({ ...s, idx });
            return;
        }
        const paras = s.text.split(/\n\s*\n/);
        let buf = '';
        let partIdx = 0;
        for (const p of paras) {
            if (buf.length + p.length + 2 > MAX && buf) {
                out.push({
                    title: `${s.title} (part ${partIdx + 1})`,
                    text: buf.trim(),
                    idx,
                });
                partIdx += 1;
                buf = '';
            }
            buf += (buf ? '\n\n' : '') + p;
        }
        if (buf.trim()) {
            out.push({
                title: partIdx > 0 ? `${s.title} (part ${partIdx + 1})` : s.title,
                text: buf.trim(),
                idx,
            });
        }
    });

    return out.map((s, i) => ({
        id: `${idPrefix}:${i}`,
        title: s.title,
        source: sourceLabel,
        anchor: null,
        text: s.text,
    }));
}

const FLOWLAB_CHUNKS = splitMarkdown(flowLabMd, 'Flow Lab reference', 'flowlab');
const TELEMETRY_CHUNKS = splitMarkdown(telemetryMd, 'Telemetry commands', 'telemetry');
const README_CHUNKS = splitMarkdown(readmeMd, 'Project README', 'readme');

/* ---------- Combine + index --------------------------------------- */

export const KNOWLEDGE_CHUNKS = [
    ...HELP_CHUNKS,
    ...FLOWLAB_CHUNKS,
    ...TELEMETRY_CHUNKS,
    ...README_CHUNKS,
].filter((c) => c.text && c.text.length > 30);

const INDEX = buildBM25(KNOWLEDGE_CHUNKS);

export const KNOWLEDGE_SIZE = KNOWLEDGE_CHUNKS.length;

/* ------------- Query expansion -------------------------------------
   Users ask natural questions but our corpus uses specific terms
   ("sensitivity map", "drift map", "aroma analysis"). Expanding the
   query with common synonyms / related terms dramatically improves
   recall on short queries, without needing a real embedder. Each entry
   maps a trigger phrase → extra terms we append to the query before
   retrieval. Case-insensitive substring match on the question.
--------------------------------------------------------------------*/
const QUERY_EXPANSIONS = [
    [['plot', 'graph', 'chart'], ['se analysis', 'dashboard', 'visualization']],
    [['classify', 'classifier', 'train', 'training', 'model'], ['ml studio', 'machine learning']],
    [['cluster', 'tsne', 't-sne', 'embed'], ['tsne explorer', 'embedding']],
    [['capture', 'record', 'measure', 'measurement'], ['au capture', 'aroma unit capture', 'device']],
    [['serial', 'usb', 'uart'], ['serial monitor', 'code studio', 'webserial']],
    [['normalise', 'normalize', 'baseline', 'drift'], ['normalize', 'drift map']],
    [['simulate', 'simulation', 'cfd', 'flow', 'fluid'], ['flow lab', 'lbm', 'lattice boltzmann']],
    [['python', 'script', 'code', 'pyodide'], ['code studio']],
    [['save', 'session', 'project'], ['workspace', '.noze']],
    [['help', 'guide', 'tutorial', 'learn'], ['help page']],
    [['csv', 'excel', 'xlsx', 'import'], ['workspace', 'file viewer']],
    [['spreadsheet', 'formula', 'cell', 'hyperformula'], ['spreadsheet']],
    [['polymer', 'carbon black', 'composite'], ['polymer cb']],
    [['dilution', 'headspace', 'gas'], ['dilution', 'gas design']],
    [['recovery'], ['recovery analysis']],
    [['manufacturing', 'variation', 'qc'], ['manufacturing variation']],
    [['feno', 'nitric oxide', 'breath'], ['fenose', 'aroma analysis']],
    [['aroma', 'pulse', 'peak', 'feature'], ['aroma analysis']],
    [['sensitivity'], ['sensitivity map']],
    [['separability'], ['separability']],
];

function expandQuery(query) {
    const q = String(query || '').toLowerCase();
    const extras = new Set();
    for (const [triggers, additions] of QUERY_EXPANSIONS) {
        if (triggers.some((t) => q.includes(t))) {
            for (const a of additions) extras.add(a);
        }
    }
    if (extras.size === 0) return query;
    return `${query} ${[...extras].join(' ')}`;
}

/**
 * Retrieve the top-k most relevant chunks for a query, with MMR
 * diversity reranking so the model sees *complementary* passages
 * instead of near-duplicates. Returns an array of
 * `{ id, title, source, anchor, text, score }`.
 */
export function retrieveContext(query, { k = 4 } = {}) {
    const expanded = expandQuery(query);
    return INDEX.searchWithDiversity(expanded, k);
}

function sentenceize(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
}

function pickQueryTerms(query) {
    return String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4)
        .slice(0, 8);
}

function uniquePush(out, seen, value) {
    const v = sentenceize(value);
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
}

/* Detect what *kind* of answer the user wants so we can pick the
   right structural template — howto vs concept vs overview vs list.
   Cheap regex-based intent classifier — sufficient for top-of-funnel
   routing and avoids spinning up the model just to choose a layout. */
function detectIntent(query) {
    const q = String(query || '').toLowerCase();
    if (/\b(how (do|to|can)|step by step|guide me|walk me through|where do i|use the|set up|configure)\b/.test(q)) return 'howto';
    if (/\b(why|theory|principle|how does .* work|under the hood|fundamental|concept|background|what is the (idea|principle))\b/.test(q)) return 'concept';
    if (/\b(list|all features|capabilities|what can|everything)\b/.test(q)) return 'capabilities';
    return 'overview';
}

function fmtList(items) {
    return items
        .map((s) => stripBold(String(s || '')).trim())
        .filter(Boolean)
        .map((s) => `- ${s.replace(/[.!?]+$/, '')}.`)
        .join('\n');
}

function fmtSteps(items) {
    return items
        .map((s) => stripBold(String(s || '')).trim())
        .filter(Boolean)
        .map((s, i) => `${i + 1}. ${s.replace(/[.!?]+$/, '')}.`)
        .join('\n');
}

/* Render a structured Help section as Markdown using the original
   schema fields (intro / fundamentals / implemented / steps) so the
   answer reads like a properly authored doc page rather than a flat
   bullet dump. The intent picks WHICH fields lead the response. */
function renderStructuredHelpAnswer(section, intent) {
    const lines = [];
    const subtitle = section.subtitle ? ` — ${section.subtitle}` : '';
    lines.push(`## ${section.title}${subtitle}`);
    if (section.intro) {
        lines.push('', stripBold(section.intro));
    }

    const hasSteps = Array.isArray(section.steps) && section.steps.length > 0;
    const hasFeatures = Array.isArray(section.implemented) && section.implemented.length > 0;
    const hasFundamentals = Array.isArray(section.fundamentals) && section.fundamentals.length > 0;

    if (intent === 'howto') {
        if (hasSteps) lines.push('', '### How to use it', fmtSteps(section.steps.slice(0, 8)));
        else if (hasFeatures) lines.push('', '### What you can do here', fmtList(section.implemented.slice(0, 6)));
        if (hasFeatures && hasSteps) lines.push('', '### Useful features', fmtList(section.implemented.slice(0, 4)));
    } else if (intent === 'concept') {
        if (hasFundamentals) lines.push('', '### Key concepts', fmtList(section.fundamentals.slice(0, 6)));
        if (hasFeatures) lines.push('', '### How it shows up in NozePlot', fmtList(section.implemented.slice(0, 4)));
    } else if (intent === 'capabilities') {
        if (hasFeatures) lines.push('', '### Capabilities', fmtList(section.implemented.slice(0, 8)));
        if (hasSteps) lines.push('', '### Typical workflow', fmtSteps(section.steps.slice(0, 6)));
    } else {
        // overview
        if (hasFeatures) lines.push('', '### What it does', fmtList(section.implemented.slice(0, 5)));
        if (hasSteps) lines.push('', '### How to use it', fmtSteps(section.steps.slice(0, 5)));
        if (hasFundamentals) lines.push('', '### Background', fmtList(section.fundamentals.slice(0, 3)));
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* Tidy a chunk title for display: drops leading "9.", "9.1", trailing
   "(part 2)", etc. so a chunk like "9. Sensor probe methodology
   (part 2)" surfaces as "Sensor probe methodology". */
function cleanChunkTitle(title) {
    const cleaned = String(title || '')
        .replace(/^\d+(?:\.\d+)*\s*[\.\):\-]?\s*/, '')
        .replace(/\s*\(part\s+\d+\)\s*$/i, '')
        .trim();
    return cleaned || String(title || 'this section').trim();
}

/* Aggressively scrub a single line from a markdown reference doc so
   it can be presented as a clean bullet. Returns '' if the line is
   noise (math, headings, table separators, code fences, citations,
   too-short, mostly punctuation). */
function cleanChunkLine(raw) {
    let s = String(raw || '')
        .replace(/^>\s*/, '')                  // blockquote
        .replace(/^[-•*+]\s*/, '')             // bullet marker
        .replace(/^\d+(?:\.\d+)*[\.\):]\s*/, '') // numbered list / "9.1"
        .trim();

    if (!s) return '';
    if (/^#{1,6}\s/.test(s)) return '';        // markdown heading
    if (/^[\|\-\:\s]+$/.test(s)) return '';    // table separator row
    if (/^\|.*\|$/.test(s)) return '';         // table data row
    if (/^```/.test(s)) return '';             // code fence
    if (/^!\[/.test(s)) return '';             // image
    if (/^figure\s*\d+/i.test(s)) return '';   // figure caption
    if (/^equation\s*\(?\d+/i.test(s)) return '';

    // Reject lines saturated with LaTeX math.
    const dollars = (s.match(/\$/g) || []).length;
    const backslashes = (s.match(/\\/g) || []).length;
    if (dollars >= 4 || backslashes >= 4) return '';

    // Strip inline math tokens for display.
    s = s.replace(/\$\$[^$]+\$\$/g, '').replace(/\$[^$\n]+\$/g, '').trim();
    // Strip leftover backslash macros.
    s = s.replace(/\\[a-zA-Z]+\{[^}]*\}/g, '').replace(/\\[a-zA-Z]+/g, '').trim();
    // Collapse whitespace.
    s = s.replace(/\s+/g, ' ').trim();

    if (s.length < 24 || s.length > 260) return '';

    // Reject if mostly punctuation / symbols (after math removal).
    const letters = (s.match(/[a-zA-Z]/g) || []).length;
    if (letters < s.length * 0.55) return '';

    // Reject lines that are obviously a sub-heading carried as text
    // ("What is recorded", "Definitions", etc.) — too short and end
    // with no terminal punctuation, often <= 4 words.
    const wordCount = s.split(/\s+/).length;
    if (wordCount <= 4 && !/[.!?]$/.test(s)) return '';

    return s;
}

/* Reassemble hard-wrapped prose into proper sentences before we look
   at it. Markdown reference docs in this codebase tend to wrap at
   ~80 columns, so a single sentence ends up on 2-3 physical lines.
   Naïvely bulleting each physical line is what produced the broken
   "Flow Lab solves 2-D incompressible viscous flow (Navier–." output. */
function joinWrappedProse(text) {
    const lines = String(text || '').split('\n');
    const merged = [];
    let buf = '';
    const flush = () => {
        const t = buf.trim();
        if (t) merged.push(t);
        buf = '';
    };
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { flush(); continue; }
        // Block-level markers always start a fresh logical line.
        if (/^(#{1,6}\s|[-•*+]\s|\d+\.\s|>\s|\||```)/.test(line)) {
            flush();
            merged.push(line);
            continue;
        }
        buf = buf ? `${buf} ${line.trim()}` : line.trim();
        // If the line clearly ends a sentence, flush so the next line
        // becomes its own sentence rather than joining with this one.
        if (/[.!?][\)"']?$/.test(line)) flush();
    }
    flush();
    return merged;
}

/* Split a long prose blob into individual sentences (handling common
   abbreviations crudely — "e.g.", "i.e.", "Dr.", "Fig.", "Eq."). */
function splitSentences(s) {
    return String(s || '')
        .replace(/\b(e\.g|i\.e|cf|vs|fig|eq|dr|mr|mrs|ms|st|approx)\.\s/gi, '$1<DOT> ')
        .split(/(?<=[.!?])\s+(?=[A-Z(])/)
        .map((x) => x.replace(/<DOT>/g, '.').trim())
        .filter(Boolean);
}

/* Fallback for chunks that came from a markdown reference document
   (FlowLab.md, Telemetry.md, README.md). Pipeline:
     1. Re-flow hard-wrapped prose so a paragraph is one logical unit.
     2. Scrub each unit (drops math/headings/table noise).
     3. If the chunk leads with a meaty paragraph, present that
        paragraph verbatim and add a few supporting bullets afterwards.
     4. Otherwise extract query-relevant sentences as bullets. */
function renderTextChunkAnswer(top, query) {
    const terms = pickQueryTerms(query);
    const reflowed = joinWrappedProse(top.text);

    // Pick the first non-trivial paragraph as the lead, if it survives
    // scrubbing and contains at least one query term (or terms are empty).
    let lead = '';
    let leadIdx = -1;
    for (let i = 0; i < Math.min(reflowed.length, 5); i++) {
        const candidate = cleanChunkLine(reflowed[i]);
        if (!candidate) continue;
        const wordCount = candidate.split(/\s+/).length;
        if (wordCount < 14) continue;
        const lower = candidate.toLowerCase();
        if (!terms.length || terms.some((t) => lower.includes(t))) {
            // If the paragraph is long, trim it to its first 2 sentences
            // for a tight, readable lead.
            const sents = splitSentences(candidate);
            lead = sents.slice(0, 2).join(' ').trim() || candidate;
            leadIdx = i;
            break;
        }
    }

    // Build a bullet pool from everything *except* the lead paragraph.
    const seen = new Set();
    if (lead) seen.add(lead.toLowerCase());
    const prioritized = [];
    const general = [];

    for (let i = 0; i < reflowed.length; i++) {
        if (i === leadIdx) continue;
        const unit = reflowed[i];
        // A reflowed unit may itself be multiple sentences — split so
        // each bullet is one digestible idea.
        const sents = splitSentences(unit);
        for (const sent of sents) {
            const clean = cleanChunkLine(sent);
            if (!clean) continue;
            const key = clean.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const lower = key;
            if (terms.some((t) => lower.includes(t))) prioritized.push(clean);
            else general.push(clean);
        }
    }

    const bullets = [...prioritized, ...general].slice(0, 5);
    if (!lead && !bullets.length) return '';

    const title = cleanChunkTitle(top.title);
    const lines = [`## ${title}`];
    if (lead) lines.push('', lead);
    if (bullets.length) lines.push('', '### Key points', fmtList(bullets));
    return lines.join('\n');
}

/**
 * Deterministic grounded answer builder for NozePlot app questions.
 *
 * Pipeline:
 *  1. BM25 retrieval (already MMR-diversified upstream).
 *  2. Drop hits below `minScore` so we never speak with low confidence.
 *  3. If the top hit is a Help-page section, render its STRUCTURED
 *     fields (intro / steps / features / fundamentals) into clean
 *     Markdown using the user's intent (howto / concept / etc.).
 *  4. Otherwise fall back to a deduped highlights list extracted
 *     from the chunk body.
 *  5. Append a "Related sections" footer so users can pivot.
 *
 * Returns `{ text, intent, sources }` or null on weak retrieval.
 */
export function buildGroundedAppAnswer({
    query,
    k = 5,
    minScore = 1.6,
} = {}) {
    const hits = retrieveContext(query, { k }).filter((h) => h.score >= minScore);
    if (!hits.length) return null;

    const intent = detectIntent(query);

    /* Source preference:
       Help-page sections are CURATED user-facing content (intro, steps,
       implemented features, fundamentals) — they are exactly what we
       want to surface for "explain X" / "what is X" / "how do I X"
       questions. Markdown reference docs (FlowLab.md, Telemetry.md)
       are deep technical write-ups; their intro paragraphs are
       hard-wrapped prose that fragments badly when bulletised.

       So: for overview / howto / capabilities intents, prefer a
       Help-section hit even if a markdown ref scored slightly higher.
       Only let the markdown ref win when the user is asking a
       deep-dive concept question, OR when no Help section is in the
       top-k retrieval at all. */
    let top = hits[0];
    if (intent !== 'concept') {
        const helpHit = hits.find((h) => HELP_SECTIONS_BY_ID.has(h.id));
        if (helpHit && helpHit !== top && helpHit.score >= top.score * 0.55) {
            top = helpHit;
        }
    }

    const structured = HELP_SECTIONS_BY_ID.get(top.id);
    const text = structured
        ? renderStructuredHelpAnswer(structured, intent)
        : renderTextChunkAnswer(top, query);

    if (!text) return null;

    /* Reorder sources so the chosen lead source appears first in the
       chip row too (otherwise the user sees `Flow Lab — Technical
       Reference` chip first while the bubble talks about the Help
       section, which is confusing). */
    const orderedHits = [top, ...hits.filter((h) => h !== top)];
    const related = orderedHits.slice(1, 3).map((h) => h.title).filter(Boolean);
    const tail = related.length ? `\n\n_Related sections:_ ${related.join(' · ')}` : '';

    return {
        text: text + tail,
        intent,
        sources: orderedHits.map((h) => ({
            id: h.id,
            title: h.title,
            source: h.source,
            anchor: h.anchor,
            score: h.score,
        })),
    };
}

/* uniquePush kept around in case we want to compose multi-section
   answers later. Currently unused. */
void uniquePush;

/* ================================================================
 *  App Primer — always-on knowledge about NozePlot
 * ================================================================
 * Small local LLMs like Gemma-270M cannot be fine-tuned on a user's
 * data in-browser. The next best thing is a *curated, compact*
 * summary of the app that we ALWAYS include in the system prompt,
 * so the model behaves as if it had been trained on the docs. BM25
 * retrieval still runs on top to pull deeper chunks for specific
 * questions, but the primer guarantees the model can answer "what
 * is NozePlot?", "how do I use FlowLab?", "where do I find X?"
 * without any retrieval luck.
 *
 * Keep this under ~1500 chars so it never dominates tiny context
 * windows. Hand-written so it's dense — not raw docs.
 * ================================================================ */
const APP_PRIMER = `
NozePlot (a.k.a. NozePlot4, FeNOze, Noze Analytics) is a browser-first analytics workspace for "Digital Olfaction" — turning chemical sensor signals into insights. Everything runs locally in the user's browser; no data is uploaded to the cloud.

Hardware context: the companion device FeNOse is a breath-analysis instrument with 64 metal-oxide (MOx) gas sensors in an 8×8 grid (columns A–H, rows 1–8, so "A1" through "H8"). It captures exhaled breath to measure FeNO (fractional exhaled nitric oxide) and other markers. Data is stored as CSV with one row per timestep and 64 sensor columns.

Key pages the user can navigate to from the sidebar:
- Workspace: file manager for CSV/Excel/.noze session files.
- Dashboard: raw time-series plots of every sensor.
- SE Analysis: general-purpose CSV plotting (pick X column, pick Y columns).
- Normalize: baseline / noise / drift correction pipelines.
- Aroma Analysis: pulse-response metrics, peak detection, feature extraction.
- Drift Map / Separability / Sensitivity: array-quality diagnostics.
- ML Studio: train classifiers on captured data (includes t-SNE Explorer).
- Manufacturing Variation, Recovery, Dilution, Gas Design, Polymer–CB: R&D calculators and analyses.
- AU Capture: live USB-serial capture from the FeNOse device (Chrome/Edge, WebSerial).
- Serial Monitor: raw UART console for any USB serial device.
- Code Studio: Monaco editor, runs Python in-browser via Pyodide.
- Flow Lab: 2D Lattice-Boltzmann fluid/aroma simulator with live visualization and Data Visualizer.
- Spreadsheet: grid with HyperFormula formulas.
- File Viewer: code / JSON / PDF / Word / images.
- Help: full user guide with theory sections.
- AI Agents (this page): local LLM chat with an "app-awareness" toggle.

Typical workflow: upload CSVs → select a main file and optional comparison files → open the relevant module (Dashboard, Normalize, Aroma, ML Studio, etc.). Sessions save as .noze files and restore the full workspace.

When the user asks anything about NozePlot — features, where something lives, how to do X — answer from the primer above plus any retrieved section below. When the user asks something unrelated (math, general knowledge, coding, chit-chat), just be a normal helpful assistant.
`.trim();

/**
 * Build the full system prompt the AI model should receive.
 *
 * Design:
 *   1. Persona (user-supplied or default).
 *   2. APP_PRIMER — always included when `useKnowledgeBase` is on,
 *      so the model is always app-aware without relying on BM25
 *      getting lucky with the query wording.
 *   3. BM25-retrieved sections — only when scores clear `minScore`,
 *      and only as *extra detail* on top of the primer.
 *
 *   - `userSystem`   : the user's own system prompt (never dropped).
 *   - `query`        : the current user message driving retrieval.
 *   - `history`      : last N user messages for richer retrieval context.
 *   - `budgetChars`  : soft ceiling for injected context (default 1800).
 *   - `k`            : max chunks to consider (default 3).
 *   - `minScore`     : BM25 score below which retrieved chunks are
 *                      skipped. Kept low (0.6) because the primer
 *                      already handles generic app questions; retrieval
 *                      is now a *supplement*, not the primary path.
 *
 * Returns `{ prompt, sources, augmented }`.
 */
export function buildAugmentedSystemPrompt({
    userSystem,
    query,
    history = [],
    budgetChars = 2200,
    k = 4,
    /* Absolute floor: below this, the top hit is so weak we'd just be
       polluting the prompt with unrelated sections (e.g. the user
       asks "what is ALAAC library?" — BM25 finds the word "library"
       in three help pages and injects them). Tuned against our
       hybrid scorer: real matches land ≥ 1.5, tangential noise < 1.0. */
    minScore = 1.2,
    /* Relative floor: once we have a real top hit, additional hits
       must score within `relativeFloor` × top_score to qualify. Stops
       one great hit from dragging along three irrelevant neighbours. */
    relativeFloor = 0.45,
    /* `modelTier` lets the caller tell us how capable the currently
       loaded LLM is. Sub-500M-param 'experimental' models can't follow
       a multi-rule RAG prompt — they hallucinate jargon and drop
       garbage tokens. For those we fall back to a drastically reduced
       prompt with no primer and only a couple of passages, so the
       model has a fighting chance to at least paraphrase the docs
       correctly. Tier order: experimental < basic < good < great. */
    modelTier = 'good',
} = {}) {
    const isTinyModel = modelTier === 'experimental';
    const effectiveK = isTinyModel ? 2 : k;
    const effectiveBudget = isTinyModel ? 900 : budgetChars;

    const retrievalQuery = [query, ...history.slice(-2)].filter(Boolean).join(' \n ');
    const rawHits = retrieveContext(retrievalQuery, { k: effectiveK });

    /* Two-stage relevance gate:
       1. Top hit must clear the absolute floor — otherwise the whole
          corpus had basically zero overlap with the query and we
          should inject NOTHING.
       2. Remaining hits must clear a relative floor vs the top hit —
          otherwise we'd drag one-keyword-overlap sections into the
          prompt and display misleading source chips. */
    let hits = [];
    if (rawHits.length > 0 && rawHits[0].score >= minScore) {
        const topScore = rawHits[0].score;
        hits = rawHits.filter((h) => h.score >= Math.max(minScore, topScore * relativeFloor));
    }

    const basePrompt = (userSystem || '').trim() || DEFAULT_PERSONA;

    // Primer-only path: the model still knows the app end-to-end.
    if (hits.length === 0) {
        if (isTinyModel) {
            // Skip the primer entirely — a 270M-param model chokes on
            // the long primer and output devolves into hallucinated
            // APIs. Just answer from its own capacity.
            return { prompt: basePrompt, sources: [], augmented: false };
        }
        const prompt = [
            basePrompt,
            '',
            '— What you know about NozePlot (the app the user is in) —',
            APP_PRIMER,
            '',
            RAG_POLICY_NO_HITS,
        ].join('\n');
        return { prompt, sources: [], augmented: true };
    }

    // Budget chars across the retrieved chunks proportional to score.
    const totalScore = hits.reduce((s, h) => s + h.score, 0) || 1;
    const injected = hits.map((h, idx) => {
        const share = Math.max(
            isTinyModel ? 300 : 400,
            Math.floor((h.score / totalScore) * effectiveBudget)
        );
        return {
            ...h,
            index: idx + 1,
            clipped: clipText(h.text, Math.min(share, isTinyModel ? 600 : 1000)),
        };
    });

    // Tiny-model path: minimal prompt, no primer, no rule list, no
    // passage numbering. Just: notes → question. This is the only way
    // tiny models stay coherent.
    if (isTinyModel) {
        const simpleBlock = injected
            .map((h) => `From ${h.title}:\n${h.clipped}`)
            .join('\n\n');
        const prompt = [
            basePrompt,
            '',
            'Here are notes from the app\'s Help guide that may help:',
            '',
            simpleBlock,
            '',
            'Answer the user\'s question in your own words, briefly.',
        ].join('\n');
        return {
            prompt,
            sources: hits.map((h) => ({
                id: h.id,
                title: h.title,
                source: h.source,
                anchor: h.anchor,
                score: h.score,
            })),
            augmented: true,
        };
    }

    // Regular path: numbered passages + full RAG policy. The numbering
    // and explicit rules are what let 1B+ models actually synthesise
    // across chunks rather than paraphrasing the first one.
    const contextBlock = injected
        .map(
            (h) =>
                `[Passage ${h.index} — ${h.title} (${h.source})]\n${h.clipped}`
        )
        .join('\n\n');

    const prompt = [
        basePrompt,
        '',
        '— What you know about NozePlot (the app the user is in) —',
        APP_PRIMER,
        '',
        '— Relevant passages from the in-app Help guide —',
        RAG_POLICY_WITH_HITS,
        '',
        contextBlock,
    ].join('\n');

    return {
        prompt,
        sources: hits.map((h) => ({
            id: h.id,
            title: h.title,
            source: h.source,
            anchor: h.anchor,
            score: h.score,
        })),
        augmented: true,
    };
}

/* Behaviour policy injected ABOVE the retrieved passages. Written as
   direct instructions to the model because small local LLMs (Gemma-
   270M, Llama-3.2-1B) follow explicit imperative rules much better
   than implicit "you should" framing. Kept deliberately short so it
   doesn't eat the tiny context window. */
const RAG_POLICY_WITH_HITS = [
    'The passages below are excerpts from NozePlot\'s own Help guide.',
    'Rules for using them:',
    '• Read ALL passages before answering — the best answer often combines two or three.',
    '• Connect the dots: if one passage explains a feature and another shows how to access it, merge them into a single practical answer.',
    '• Answer in your own natural voice. Do NOT say "the passage says", "according to the docs", or paste text verbatim.',
    '• Do NOT mention passage numbers or titles in your reply. The user sees linked source chips below the answer.',
    '• If the passages don\'t cover the question, say what you do know from the primer and offer a reasonable next step (e.g. open the Help page).',
    '• Stay specific, practical, and action-oriented — prefer "click X, then Y" over abstract description.',
    '',
    'FORMAT (Markdown — render cleanly in a chat bubble):',
    '• Open with one short summary sentence (no heading).',
    '• Then use a `### Heading` for each grouping (e.g. `### What it does`, `### How to use it`, `### Tips`).',
    '• Under each heading use `- ` bullets, or `1.` numbered steps for sequential procedures.',
    '• Use **bold** for UI labels, settings, and tab names. Use `inline code` for file paths or exact identifiers.',
    '• Keep TIGHT: 3–7 bullets or 3–6 steps total. Stop as soon as the question is answered. No filler, no apologies, no recap.',
].join('\n');

const RAG_POLICY_NO_HITS = [
    'No specific Help-guide passage strongly matched this question.',
    'If it\'s about NozePlot, answer from the primer above. If it\'s a general question, answer normally from your own knowledge.',
    '',
    'FORMAT (Markdown — render cleanly in a chat bubble):',
    '• Lead with one direct sentence answering the question.',
    '• Use `### Heading` sections only when the answer naturally has 2+ groupings.',
    '• Use `- ` bullets for lists, `1.` for ordered steps, **bold** for key terms, and `inline code` for technical identifiers.',
    '• Keep it concise — depth over length.',
].join('\n');

/**
 * Default persona used when the user hasn't customised the system
 * prompt. Intentionally plain — a normal, intelligent assistant.
 * Conversation-memory instructions are added by the caller via the
 * user-supplied system prompt, since they apply regardless of whether
 * KB is injected.
 */
const DEFAULT_PERSONA = [
    'You are NozeAssistant, a friendly, knowledgeable AI assistant.',
    'Answer the user accurately and helpfully — general knowledge, reasoning, coding, writing, chit-chat, anything they ask.',
    'Be concise, specific, and think step by step when a question is non-trivial.',
    '',
    'Response style (Markdown — rendered live in the chat):',
    '• Lead with the direct answer in 1 short sentence.',
    '• Use `### Heading` sections only when the answer has 2+ natural groupings.',
    '• Use `- ` bullets for lists, `1.` for ordered steps, **bold** for key terms, and `inline code` for code, paths, or identifiers.',
    '• Use ```fenced code blocks``` for any multi-line code.',
    '• No filler, no recap, no "I hope this helps". Stop as soon as the question is answered.',
].join('\n');
