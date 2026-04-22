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

/**
 * Retrieve the top-k most relevant chunks for a query.
 * Returns an array of `{ id, title, source, anchor, text, score }`.
 */
export function retrieveContext(query, { k = 4 } = {}) {
    return INDEX.search(query, k);
}

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
    budgetChars = 1800,
    k = 3,
    minScore = 0.6,
} = {}) {
    const retrievalQuery = [query, ...history.slice(-2)].filter(Boolean).join(' \n ');
    const rawHits = retrieveContext(retrievalQuery, { k });
    const hits = rawHits.filter((h) => h.score >= minScore);

    const basePrompt = (userSystem || '').trim() || DEFAULT_PERSONA;

    // Primer-only path: the model still knows the app end-to-end.
    if (hits.length === 0) {
        const prompt = [
            basePrompt,
            '',
            '— What you know about NozePlot (the app the user is in) —',
            APP_PRIMER,
        ].join('\n');
        return { prompt, sources: [], augmented: true };
    }

    // Budget chars across the retrieved chunks proportional to score.
    const totalScore = hits.reduce((s, h) => s + h.score, 0) || 1;
    const injected = hits.map((h) => {
        const share = Math.max(250, Math.floor((h.score / totalScore) * budgetChars));
        return {
            ...h,
            clipped: clipText(h.text, Math.min(share, 900)),
        };
    });

    const contextBlock = injected
        .map((h) => `• ${h.title} (${h.source}):\n${h.clipped}`)
        .join('\n\n');

    const prompt = [
        basePrompt,
        '',
        '— What you know about NozePlot (the app the user is in) —',
        APP_PRIMER,
        '',
        '— Extra detail relevant to this specific question —',
        'These notes come straight from the in-app Help guide. Use them to give a more specific, accurate answer, but write in your own words — do NOT quote or paste them verbatim.',
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

/**
 * Default persona used when the user hasn't customised the system
 * prompt. Intentionally plain — a normal, intelligent assistant.
 * Conversation-memory instructions are added by the caller via the
 * user-supplied system prompt, since they apply regardless of whether
 * KB is injected.
 */
const DEFAULT_PERSONA =
    'You are NozeAssistant, a friendly, knowledgeable AI assistant. Answer the user accurately and helpfully — general knowledge, reasoning, coding, writing, chit-chat, anything they ask. Be concise, specific, and think step by step when a question is non-trivial.';
