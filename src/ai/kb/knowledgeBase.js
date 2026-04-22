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
 * Build the full system prompt the AI model should receive, combining
 * the user's custom system prompt with retrieved documentation snippets.
 *
 *   - `userSystem`   : the user's own system prompt (never dropped).
 *   - `query`        : the current user message driving retrieval.
 *   - `history`      : last N user messages for richer retrieval context.
 *   - `budgetChars`  : soft ceiling for injected context (default 2400).
 *   - `k`            : number of retrieved chunks (default 4).
 *
 * Returns `{ prompt, sources }` where `sources` is the list of chunks
 * actually cited, suitable for rendering as reference chips.
 */
export function buildAugmentedSystemPrompt({
    userSystem,
    query,
    history = [],
    budgetChars = 2400,
    k = 4,
} = {}) {
    const retrievalQuery = [query, ...history.slice(-2)].filter(Boolean).join(' \n ');
    const hits = retrieveContext(retrievalQuery, { k });

    if (hits.length === 0) {
        return { prompt: userSystem || '', sources: [] };
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
        .map((h, i) => `### [${i + 1}] ${h.title} — ${h.source}\n${h.clipped}`)
        .join('\n\n');

    const basePrompt = (userSystem || '').trim();
    const prompt = [
        basePrompt,
        basePrompt ? '' : null,
        'You are the NozePlot in-app assistant.',
        '',
        'CONVERSATION MEMORY — you can and SHOULD use it:',
        '• The messages that follow this system prompt are the real chat history between the user and you. Treat them as authoritative context.',
        '• When the user references something earlier ("that plot", "what I said", "the previous answer"), resolve it from the prior turns — do not ask them to repeat themselves.',
        '• Stay consistent with explanations and naming you used in earlier turns.',
        '• If the user asks a follow-up that is a clear continuation, build on the previous answer rather than restarting from scratch.',
        '',
        'USING THE APP DOCUMENTATION BELOW:',
        '• It is reference material retrieved just for this question. It is NOT the conversation.',
        '• If the docs and the conversation disagree, prefer the conversation for what the user meant, and the docs for factual app details.',
        '• If the answer is not supported by the documentation, say so honestly.',
        '• Prefer step-by-step instructions when the user asks how to do something.',
        '',
        '## App documentation (retrieved for this question)',
        contextBlock,
    ].filter((x) => x !== null).join('\n');

    return {
        prompt,
        sources: hits.map((h) => ({
            id: h.id,
            title: h.title,
            source: h.source,
            anchor: h.anchor,
            score: h.score,
        })),
    };
}
