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

/**
 * Build the full system prompt the AI model should receive.
 *
 * Design philosophy: the assistant should feel like a *general-purpose*
 * intelligent chatbot that happens to know the user's app. So:
 *
 *   • We always lead with a general-assistant persona — no "you are a
 *     documentation reader" framing.
 *   • Retrieved knowledge is only appended when BM25 actually finds
 *     something confident (top score above `minScore`). For generic
 *     questions ("what is 2+2", "write a haiku") nothing is injected
 *     and the model answers from its own world knowledge.
 *   • When relevant knowledge IS injected, it's framed as "background
 *     knowledge" the model owns — not as "documentation to cite". The
 *     model synthesizes it in its own words instead of parroting.
 *
 *   - `userSystem`   : the user's own system prompt (never dropped).
 *   - `query`        : the current user message driving retrieval.
 *   - `history`      : last N user messages for richer retrieval context.
 *   - `budgetChars`  : soft ceiling for injected context (default 2400).
 *   - `k`            : max chunks to consider (default 4).
 *   - `minScore`     : BM25 score below which we treat retrieval as
 *                      noise and inject nothing (default 1.5).
 *
 * Returns `{ prompt, sources, augmented }`.
 */
export function buildAugmentedSystemPrompt({
    userSystem,
    query,
    history = [],
    budgetChars = 2400,
    k = 4,
    minScore = 1.5,
} = {}) {
    const retrievalQuery = [query, ...history.slice(-2)].filter(Boolean).join(' \n ');
    const rawHits = retrieveContext(retrievalQuery, { k });

    /* Relevance gate: BM25 scores are unbounded, but for this corpus
       (~40 sections) a score above ~1.5 reliably means the query
       actually mentions something in the docs. Below that we're just
       matching stop-word-ish tokens and we'd be polluting the prompt
       with unrelated sections — exactly the behaviour that made the
       assistant feel like a "documentation reader" on generic chat. */
    const hits = rawHits.filter((h) => h.score >= minScore);

    const basePrompt = (userSystem || '').trim() || DEFAULT_PERSONA;

    if (hits.length === 0) {
        return { prompt: basePrompt, sources: [], augmented: false };
    }

    // Budget chars across the retrieved chunks proportional to score.
    const totalScore = hits.reduce((s, h) => s + h.score, 0) || 1;
    const injected = hits.map((h) => {
        const share = Math.max(300, Math.floor((h.score / totalScore) * budgetChars));
        return {
            ...h,
            clipped: clipText(h.text, Math.min(share, 1200)),
        };
    });

    const contextBlock = injected
        .map((h) => `• ${h.title} (${h.source}):\n${h.clipped}`)
        .join('\n\n');

    const prompt = [
        basePrompt,
        '',
        '— Background knowledge about NozePlot (the app the user is using) —',
        'The notes below are things you, the assistant, already know about the app. Use them naturally when the user asks about the app, but write answers in your own words — do NOT quote, cite, or paste these notes verbatim. If the user asks a general question unrelated to the app, ignore this background entirely and answer from your general knowledge.',
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
