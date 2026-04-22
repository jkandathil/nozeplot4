/**
 * Chat-context manager for the in-app AI assistant.
 *
 * Local instruct-tuned models we run (Qwen 0.5B, Gemma 270M/1B, Llama
 * 3.2 1B, SmolLM2 360M…) almost all ship with a 2k-4k token context
 * window. If we naively dump the entire chat history into `generate`
 * the tokenizer silently truncates from the END of the prompt — which
 * happens to be the user's latest question. The model then cheerfully
 * answers a stale turn and the UX feels amnesiac.
 *
 * This module:
 *   1. Sanitises history (drops empty / in-flight / stopped-with-no-text
 *      assistant turns so the model never sees corrupted pairs).
 *   2. Applies a char-budget that leaves head-room for system prompt,
 *      retrieved knowledge chunks, and the model's own reply.
 *   3. Always keeps the latest user turn — we drop the oldest pairs
 *      first, pair-wise, so the conversation stays coherent.
 *   4. Builds a smarter retrieval query that leans on previous turns
 *      whenever the new message is too short to retrieve well on its
 *      own ("why?", "and then?", "show me an example").
 */

/**
 * Rough char→token estimate. Most BPE tokenizers for English chat
 * models land around 3.5–4 chars per token; we use 3.8 as a safe
 * middle-ground and bump budgets slightly to avoid the truncation
 * cliff.
 */
export function estimateTokens(str) {
    if (!str) return 0;
    return Math.ceil(String(str).length / 3.8);
}

/**
 * Drop messages that would confuse the model:
 *   - empty assistant placeholders from still-in-flight sends
 *   - empty stopped assistants (nothing was actually generated)
 *   - system messages (we rebuild those ourselves on every send)
 * We keep stopped assistant messages that DID produce text — they
 * carry useful context even if the user interrupted generation.
 */
export function sanitizeHistory(messages = []) {
    if (!Array.isArray(messages)) return [];
    return messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
        .filter((m) => !(m.role === 'assistant' && m.streaming === true));
}

/**
 * Turn a flat message list into user→assistant pairs so we can drop
 * the oldest pair cleanly when we need to trim. Trailing solo user
 * messages (the one that triggered this generation, if already in the
 * array) are kept separately and always preserved.
 */
function pairTurns(messages) {
    const pairs = [];
    let leadingSolo = [];
    let i = 0;

    while (i < messages.length && messages[i].role === 'assistant') {
        leadingSolo.push(messages[i]);
        i += 1;
    }

    while (i < messages.length) {
        const u = messages[i];
        if (u.role !== 'user') {
            i += 1;
            continue;
        }
        const a = messages[i + 1]?.role === 'assistant' ? messages[i + 1] : null;
        pairs.push({ user: u, assistant: a });
        i += a ? 2 : 1;
    }
    return { leadingSolo, pairs };
}

function flatten({ leadingSolo, pairs }) {
    const out = [...leadingSolo];
    for (const p of pairs) {
        if (p.user) out.push(p.user);
        if (p.assistant) out.push(p.assistant);
    }
    return out;
}

function totalChars(messages) {
    return messages.reduce((s, m) => s + (m?.content?.length || 0), 0);
}

/**
 * Fit a sanitised history into `budgetChars`, dropping the oldest
 * complete user/assistant pair first. Mutating-free: returns a new
 * array plus a summary of how much was dropped so the UI can surface
 * it if needed.
 */
export function packHistory(messages, { budgetChars = 6000, minKeepTurns = 2 } = {}) {
    const clean = sanitizeHistory(messages);
    if (clean.length === 0) {
        return { messages: [], droppedTurns: 0, chars: 0, tokens: 0 };
    }

    let { leadingSolo, pairs } = pairTurns(clean);
    let dropped = 0;

    // Never drop below a minimum of recent pairs — context collapses
    // otherwise and follow-ups ("explain more") lose all meaning.
    while (
        totalChars(flatten({ leadingSolo, pairs })) > budgetChars &&
        pairs.length > minKeepTurns
    ) {
        pairs.shift();
        dropped += 1;
    }

    // If we're still over budget because even the kept pairs are huge,
    // last-resort soft-clip individual assistant contents (from the
    // oldest kept first). This preserves the conversational flow while
    // avoiding a hard truncation of the latest user turn.
    const packed = flatten({ leadingSolo, pairs });
    let chars = totalChars(packed);
    for (let i = 0; i < packed.length - 1 && chars > budgetChars; i += 1) {
        const m = packed[i];
        if (m.role !== 'assistant') continue;
        const overshoot = chars - budgetChars;
        if (m.content.length <= 200) continue;
        const keep = Math.max(200, m.content.length - overshoot - 40);
        if (keep < m.content.length) {
            packed[i] = {
                ...m,
                content: m.content.slice(0, keep).trimEnd() + ' …[truncated for context]',
            };
            chars = totalChars(packed);
        }
    }

    return {
        messages: packed,
        droppedTurns: dropped,
        chars,
        tokens: estimateTokens(packed.map((m) => m.content).join(' ')),
    };
}

/**
 * Build a retrieval query that works well even for short follow-ups.
 * If the new turn is short (< ~40 chars or very few content words),
 * we fold in the last couple of user turns verbatim plus the latest
 * assistant reply's first sentence, so BM25 has something to chew on.
 */
export function buildRetrievalQuery(newUserText, history = []) {
    const t = (newUserText || '').trim();
    const shouldAugment = t.length < 40 || t.split(/\s+/).filter(Boolean).length < 5;

    if (!shouldAugment) return t;

    const clean = sanitizeHistory(history);
    const prevUsers = clean
        .filter((m) => m.role === 'user')
        .slice(-2)
        .map((m) => m.content);
    const lastAssistant = [...clean].reverse().find((m) => m.role === 'assistant');
    const assistantSnippet = lastAssistant
        ? String(lastAssistant.content).split(/(?<=[.?!])\s+/)[0] // first sentence
        : '';

    return [t, ...prevUsers, assistantSnippet]
        .filter(Boolean)
        .join(' \n ')
        .slice(0, 600);
}

/**
 * Compute a char budget for history that adapts to the current
 * system prompt + the max_new_tokens the model will generate. We
 * target a conservative 3500-token total prompt for 4k-context
 * models (leaving ~500 tokens of safety margin).
 */
export function computeHistoryBudget({
    systemPromptChars = 0,
    maxNewTokens = 512,
    targetPromptTokens = 3200,
} = {}) {
    const sysTok = Math.ceil(systemPromptChars / 3.8);
    const replyBudget = Math.ceil(maxNewTokens * 0.9); // safety margin
    const historyTokens = Math.max(400, targetPromptTokens - sysTok - replyBudget);
    return Math.max(1200, historyTokens * 3.8);
}
