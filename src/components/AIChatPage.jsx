import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Brain,
    Download,
    Send,
    Square,
    Trash2,
    RefreshCw,
    Cpu,
    Zap,
    Plus,
    Bot,
    User,
    Settings,
    ChevronDown,
    ChevronRight,
    AlertTriangle,
    CheckCircle2,
    Loader2,
    Sparkles,
    BookOpen,
} from 'lucide-react';
import './AIChatPage.css';
import {
    buildAugmentedSystemPrompt,
    KNOWLEDGE_SIZE,
} from '../ai/kb/knowledgeBase.js';
import {
    packHistory,
    buildRetrievalQuery,
    computeHistoryBudget,
} from '../ai/chatContext.js';

/* ------------------------------------------------------------------ */
/* Curated models — all hosted on the HF hub as ONNX, known to work   */
/* with @huggingface/transformers v4 `text-generation` pipeline.      */
/*                                                                     */
/* Users can still type any HF model id in the "Custom model" field.  */
/*                                                                     */
/* `dtypeWebGPU` / `dtypeWasm` are the recommended precisions: WebGPU */
/* likes fp16-based variants, WASM is happiest on plain `q4`/`q8`.    */
/* `sizeMB` is a rough upper bound on on-device footprint, used to    */
/* warn users before committing to a slow download on CPU-only.       */
/* ------------------------------------------------------------------ */
/* Quality tiers set the user's expectation *up-front*. Sub-500M-param
   models produce plausible-sounding but incoherent output on anything
   complex (RAG, multi-step reasoning) — they hallucinate APIs and
   drop garbage tokens. Tiers:
     'experimental' — novelty-only, <= 400M params. Chat only, no RAG.
     'basic'        — usable for simple Q&A, 400–700M params.
     'good'         — reliable general assistant, 700M–1.5B params.
     'great'        — best quality we can run in the browser, 1.5B+.  */
const CURATED_MODELS = [
    {
        id: 'onnx-community/Llama-3.2-1B-Instruct-q4f16',
        label: 'Llama 3.2 1B · Instruct',
        family: 'Llama',
        size: '~750 MB',
        sizeMB: 750,
        quality: 'good',
        dtypeWebGPU: 'q4f16',
        dtypeWasm: 'q4f16',
        description: 'Meta Llama 3.2 1B — recommended default. Strong general chat and follows RAG instructions well.',
    },
    {
        id: 'onnx-community/Qwen2.5-0.5B-Instruct',
        label: 'Qwen 2.5 0.5B · Instruct',
        family: 'Qwen',
        size: '~380 MB',
        sizeMB: 380,
        quality: 'basic',
        dtypeWebGPU: 'q4f16',
        dtypeWasm: 'q4',
        description: 'Alibaba Qwen 2.5 — fast, passable for simple Q&A, may struggle with RAG synthesis.',
    },
    {
        id: 'onnx-community/gemma-3-1b-it-ONNX',
        label: 'Gemma 3 1B · Instruct',
        family: 'Gemma',
        size: '~800 MB',
        sizeMB: 800,
        quality: 'good',
        dtypeWebGPU: 'q4f16',
        dtypeWasm: 'q4',
        description: 'Google Gemma 3 1B. Good quality, WebGPU recommended.',
    },
    {
        id: 'onnx-community/SmolLM2-1.7B-Instruct',
        label: 'SmolLM2 1.7B · Instruct',
        family: 'SmolLM',
        size: '~1.4 GB',
        sizeMB: 1400,
        quality: 'great',
        dtypeWebGPU: 'q4f16',
        dtypeWasm: 'q4',
        description: 'SmolLM2 1.7B — best SmolLM quality tier. WebGPU recommended.',
    },
    {
        id: 'onnx-community/Phi-3.5-mini-instruct-onnx-web',
        label: 'Phi-3.5 mini · Instruct (WebGPU)',
        family: 'Phi',
        size: '~2.2 GB',
        sizeMB: 2200,
        quality: 'great',
        dtypeWebGPU: 'q4f16',
        dtypeWasm: null,
        description: 'Microsoft Phi-3.5 mini. WebGPU + fp16 only — not practical on CPU.',
    },
    {
        id: 'onnx-community/SmolLM2-360M-Instruct',
        label: 'SmolLM2 360M · Instruct',
        family: 'SmolLM',
        size: '~290 MB',
        sizeMB: 290,
        quality: 'experimental',
        dtypeWebGPU: 'q4f16',
        dtypeWasm: 'q4',
        description: 'Tiny, snappy — but hallucinates and cannot use RAG well.',
    },
    {
        id: 'onnx-community/gemma-3-270m-it-ONNX',
        label: 'Gemma 3 270M · Instruct',
        family: 'Gemma',
        size: '~230 MB',
        sizeMB: 230,
        quality: 'experimental',
        dtypeWebGPU: 'q4f16',
        dtypeWasm: 'q4',
        description: 'Ultra-small — produces incoherent output with RAG. Demo/speed test only.',
    },
];

const QUALITY_LABELS = {
    experimental: { label: 'Experimental', tone: 'warn' },
    basic: { label: 'Basic', tone: 'neutral' },
    good: { label: 'Good', tone: 'ok' },
    great: { label: 'Great', tone: 'great' },
};

const DTYPE_OPTIONS = [
    { value: 'q4', label: 'q4 (4-bit · smallest)' },
    { value: 'q4f16', label: 'q4f16 (4-bit · fp16 · WebGPU)' },
    { value: 'q8', label: 'q8 (8-bit)' },
    { value: 'fp16', label: 'fp16 (WebGPU)' },
    { value: 'fp32', label: 'fp32 (full precision)' },
];

const DEFAULT_SYSTEM_PROMPT = [
    'You are NozeAssistant, a friendly, knowledgeable AI assistant.',
    '',
    'Answer any question the user asks — general knowledge, technical, creative, conversational, coding, math, writing, everyday life. Think it through and give a clear, specific, helpful answer. Use simple language by default, and be concise unless the user asks for depth.',
    '',
    'You are embedded inside NozePlot, an analytics app for sensor / aroma data. If the user asks about NozePlot or its features, you have background knowledge about it that will be added to your context when relevant — use it naturally and synthesize it in your own words, don\'t read it back to them. For anything not about NozePlot, just answer from your own knowledge.',
    '',
    'You remember the conversation. Prior messages in this chat are real — use them to resolve references ("that plot", "what I said", "the previous answer"), stay consistent with earlier explanations, and build on previous answers when the user follows up. Do not ask the user to repeat things they already told you.',
].join('\n');

// Default character budget for retrieved help snippets grafted into the
// system prompt. Tuned so a 4-chunk retrieval + user system prompt + chat
// history fits comfortably within typical 4k-context small models.
const DEFAULT_KB_BUDGET = 2400;
const DEFAULT_KB_K = 4;

/* ------------------------------------------------------------------ */
/* LocalStorage keys                                                   */
/* ------------------------------------------------------------------ */
const LS_MODEL = 'ai-chat:selected-model';
const LS_CUSTOM = 'ai-chat:custom-model';
const LS_DEVICE = 'ai-chat:device';
const LS_DTYPE = 'ai-chat:dtype';
const LS_PARAMS = 'ai-chat:params';
const LS_SYSTEM = 'ai-chat:system-prompt';
const LS_CHATS = 'ai-chat:conversations:v1';
const LS_ACTIVE_CHAT = 'ai-chat:active-conversation';
const LS_KB_ENABLED = 'ai-chat:kb-enabled';

function loadLS(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        if (typeof fallback === 'object') return JSON.parse(raw);
        return raw;
    } catch {
        return fallback;
    }
}
function saveLS(key, value) {
    try {
        if (value == null) {
            localStorage.removeItem(key);
            return;
        }
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch { /* ignore */ }
}

function makeChatId() {
    return 'chat_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function newConversation(modelId = '') {
    return {
        id: makeChatId(),
        title: 'New chat',
        modelId,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

/* ------------------------------------------------------------------ */

export default function AIChatPage() {
    const workerRef = useRef(null);
    const scrollRef = useRef(null);
    const inputRef = useRef(null);
    /* Always-fresh pointer to the currently active chat id so the
       worker message handler (registered once with [] deps) can route
       streamed tokens + final text into the CURRENT conversation,
       never a stale one. */
    const activeChatIdRef = useRef(null);

    /* -------- Model / device state -------- */
    const [selectedModel, setSelectedModel] = useState(
        () => loadLS(LS_MODEL, CURATED_MODELS[0].id)
    );
    const [customModel, setCustomModel] = useState(() => loadLS(LS_CUSTOM, ''));
    const [device, setDevice] = useState(() => loadLS(LS_DEVICE, 'webgpu'));
    const [dtype, setDtype] = useState(() => loadLS(LS_DTYPE, 'q4'));

    const [webgpuAvailable, setWebgpuAvailable] = useState(null);
    const [status, setStatus] = useState('idle'); // idle | loading | ready | generating
    const [loadedModelId, setLoadedModelId] = useState('');
    const [downloadProgress, setDownloadProgress] = useState({}); // { file: {progress, loaded, total} }
    const [lastStats, setLastStats] = useState(null);
    const [errorMsg, setErrorMsg] = useState('');
    const [errorStack, setErrorStack] = useState('');

    /* Generation-time instrumentation so the UI never looks "stuck":
       we show elapsed time from Send, plus how long it took the
       streamer to flush the first visible chunk. Big models on WASM
       can take 15–40 s for that first chunk — we want that visible. */
    const [genStartedAt, setGenStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [firstTokenMs, setFirstTokenMs] = useState(null);

    /* Snapshot of what we sent to the model on the last handleSend,
       so users can see that the assistant genuinely has memory of the
       conversation (turns kept, turns dropped, estimated token cost). */
    const [contextInfo, setContextInfo] = useState(null);

    /* Raw payload (system prompt + packed history + new user turn) sent
       to the worker on the last generate. Surfaced to the UI via the
       "Show last prompt" button so users can inspect exactly what the
       model received — indispensable when diagnosing "it's not using my
       earlier turn". */
    const [lastPayload, setLastPayload] = useState(null);
    const [showPayloadModal, setShowPayloadModal] = useState(false);

    /* -------- Generation params -------- */
    const [params, setParams] = useState(() => ({
        max_new_tokens: 512,
        temperature: 0.7,
        top_p: 0.9,
        ...loadLS(LS_PARAMS, {}),
    }));
    const [systemPrompt, setSystemPrompt] = useState(
        () => loadLS(LS_SYSTEM, DEFAULT_SYSTEM_PROMPT)
    );

    /* -------- App knowledge base toggle --------
       When on, every send runs a BM25 retrieval over the Help guide,
       FlowLab technical reference, and telemetry docs, then grafts the
       best-matching sections into the system prompt. That turns the
       generic local LLM into a NozePlot-aware assistant. */
    const [useKnowledgeBase, setUseKnowledgeBase] = useState(
        () => loadLS(LS_KB_ENABLED, 'true') !== 'false'
    );

    /* -------- Conversations -------- */
    const [conversations, setConversations] = useState(() => {
        const stored = loadLS(LS_CHATS, null);
        if (Array.isArray(stored) && stored.length) return stored;
        return [newConversation(loadLS(LS_MODEL, CURATED_MODELS[0].id))];
    });
    const [activeChatId, setActiveChatId] = useState(() => {
        const stored = loadLS(LS_ACTIVE_CHAT, null);
        return stored || null;
    });
    const activeChat = useMemo(() => {
        if (!conversations.length) return null;
        return conversations.find((c) => c.id === activeChatId) || conversations[0];
    }, [conversations, activeChatId]);

    const [input, setInput] = useState('');
    const [streamingText, setStreamingText] = useState('');
    const [sidebarExpanded, setSidebarExpanded] = useState(true);
    const [paramsOpen, setParamsOpen] = useState(false);
    const [systemOpen, setSystemOpen] = useState(false);

    /* Mirror the resolved active chat id into a ref so async callbacks
       (worker messages, streaming writes) always target the live chat.
       We prefer activeChat?.id over activeChatId because the memo
       falls back to conversations[0] when the stored id is stale, so
       activeChat?.id is the id users are ACTUALLY looking at. */
    useEffect(() => {
        activeChatIdRef.current = activeChat?.id || activeChatId || null;
    }, [activeChat, activeChatId]);

    /* ============ Worker wiring ============ */
    useEffect(() => {
        const w = new Worker(new URL('../ai/aiChatWorker.js', import.meta.url), { type: 'module' });
        workerRef.current = w;

        /* Closure-free finalize: reads the CURRENT active chat id from
           the ref at call time (not the one captured when the worker
           was wired). This is what actually writes the assistant reply
           into the visible conversation, so it MUST see fresh state. */
        const finalizeAssistantMessageByRef = (finalText, stats, wasStopped) => {
            setStreamingText('');
            setLastStats(stats || null);
            const targetId = activeChatIdRef.current;
            setConversations((prev) =>
                prev.map((c) => {
                    if (c.id !== targetId) return c;
                    const msgs = [...c.messages];
                    const lastIdx = msgs.length - 1;
                    if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].streaming) {
                        msgs[lastIdx] = {
                            ...msgs[lastIdx],
                            content:
                                finalText ||
                                msgs[lastIdx].content ||
                                (wasStopped ? '⏹ stopped' : ''),
                            streaming: false,
                            stats: stats || null,
                            stopped: !!wasStopped,
                        };
                    } else if (finalText) {
                        // Defensive: placeholder was lost (chat switch /
                        // clear race) — still surface the reply instead
                        // of dropping it silently.
                        msgs.push({
                            role: 'assistant',
                            content: finalText,
                            streaming: false,
                            stats: stats || null,
                            ts: Date.now(),
                        });
                    }
                    return { ...c, messages: msgs, updatedAt: Date.now() };
                })
            );
        };

        w.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            switch (msg.type) {
                case 'status':
                    setStatus(msg.status);
                    if (msg.status === 'ready') setErrorMsg('');
                    if (msg.status !== 'generating') {
                        setGenStartedAt(0);
                    }
                    break;
                case 'progress':
                    if (msg.file) {
                        setDownloadProgress((prev) => ({
                            ...prev,
                            [msg.file]: {
                                status: msg.status,
                                progress: msg.progress ?? 0,
                                loaded: msg.loaded ?? 0,
                                total: msg.total ?? 0,
                            },
                        }));
                    }
                    break;
                case 'ready':
                    setLoadedModelId(msg.modelId);
                    setDownloadProgress({});
                    setErrorMsg('');
                    setErrorStack('');
                    break;
                case 'generation-started':
                    setGenStartedAt(Date.now());
                    setFirstTokenMs(null);
                    break;
                case 'first-token':
                    setFirstTokenMs(msg.delayMs);
                    break;
                case 'token':
                    setStreamingText((prev) => prev + (msg.text || ''));
                    break;
                case 'complete':
                    finalizeAssistantMessageByRef(msg.text, msg.stats, false);
                    setGenStartedAt(0);
                    break;
                case 'stopped':
                    finalizeAssistantMessageByRef('', null, true);
                    setGenStartedAt(0);
                    break;
                case 'error':
                    setErrorMsg(String(msg.message || 'Unknown error'));
                    setErrorStack(String(msg.stack || ''));
                    setGenStartedAt(0);
                    break;
                case 'log':
                    // Already logged inside the worker — the tap here is
                    // intentionally a no-op so future UIs can surface it.
                    break;
                default:
                    break;
            }
        };
        return () => {
            try { w.terminate(); } catch { /* ignore */ }
            workerRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* ============ WebGPU probe ============ */
    useEffect(() => {
        (async () => {
            if (typeof navigator === 'undefined' || !navigator.gpu) {
                setWebgpuAvailable(false);
                return;
            }
            try {
                const adapter = await navigator.gpu.requestAdapter();
                setWebgpuAvailable(!!adapter);
            } catch {
                setWebgpuAvailable(false);
            }
        })();
    }, []);

    // If WebGPU is unavailable and the user's stored device is 'webgpu', fall back.
    useEffect(() => {
        if (webgpuAvailable === false && device === 'webgpu') {
            setDevice('wasm');
        }
    }, [webgpuAvailable, device]);

    /* Keep elapsed time fresh while the model is generating so "stuck?"
       moments (slow first-chunk on WASM) are visibly progressing. */
    useEffect(() => {
        if (!genStartedAt) {
            setElapsedMs(0);
            return undefined;
        }
        setElapsedMs(Date.now() - genStartedAt);
        const id = setInterval(() => {
            setElapsedMs(Date.now() - genStartedAt);
        }, 200);
        return () => clearInterval(id);
    }, [genStartedAt]);

    /* ============ Persistence ============ */
    useEffect(() => { saveLS(LS_MODEL, selectedModel); }, [selectedModel]);
    useEffect(() => { saveLS(LS_CUSTOM, customModel); }, [customModel]);
    useEffect(() => { saveLS(LS_DEVICE, device); }, [device]);
    useEffect(() => { saveLS(LS_DTYPE, dtype); }, [dtype]);
    useEffect(() => { saveLS(LS_PARAMS, params); }, [params]);
    useEffect(() => { saveLS(LS_SYSTEM, systemPrompt); }, [systemPrompt]);
    useEffect(() => { saveLS(LS_KB_ENABLED, useKnowledgeBase ? 'true' : 'false'); }, [useKnowledgeBase]);
    useEffect(() => { saveLS(LS_CHATS, conversations); }, [conversations]);
    useEffect(() => { saveLS(LS_ACTIVE_CHAT, activeChatId); }, [activeChatId]);

    /* ============ Ensure activeChatId actually points at a real chat ============
       The activeChat memo falls back to conversations[0] when activeChatId
       doesn't match any conversation, so the UI looks fine. But the stored
       id stays null/stale, and handleSend / finalize filter by it — meaning
       setConversations((prev) => prev.map(c => c.id !== activeChatId ...))
       finds no match and SILENTLY drops the user's message and the assistant
       reply, leaving a stats chip on an empty chat. Self-correct here. */
    useEffect(() => {
        if (!conversations.length) return;
        const matches = activeChatId && conversations.some((c) => c.id === activeChatId);
        if (!matches) {
            setActiveChatId(conversations[0].id);
        }
    }, [activeChatId, conversations]);

    /* ============ Auto-scroll to latest message ============
       ChatGPT-style "sticky scroll": only auto-scroll if the user is
       already near the bottom. If they scrolled up to re-read an
       earlier reply, we must NOT yank them back down every time a new
       streamed token arrives. */
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 120) {
            el.scrollTop = el.scrollHeight;
        }
    }, [activeChat?.messages, streamingText]);

    /* ============ Helpers ============ */
    const currentModelId = useMemo(() => {
        if (customModel.trim()) return customModel.trim();
        return selectedModel;
    }, [customModel, selectedModel]);

    const currentModelMeta = useMemo(
        () => CURATED_MODELS.find((m) => m.id === currentModelId) || null,
        [currentModelId]
    );

    const isLoaded = !!loadedModelId && loadedModelId === currentModelId && status !== 'loading';
    const isLoading = status === 'loading';
    const isGenerating = status === 'generating';

    /* ============ Actions ============ */
    const handleLoadModel = useCallback(() => {
        if (!currentModelId) return;
        setErrorMsg('');
        setDownloadProgress({});
        workerRef.current?.postMessage({
            type: 'load',
            modelId: currentModelId,
            device,
            dtype,
        });
    }, [currentModelId, device, dtype]);

    /* Finalize is now defined inside the worker-wiring effect as
       `finalizeAssistantMessageByRef` so it ALWAYS reads the current
       chat id via a ref at call time. The old useCallback version had
       a stale-closure footgun: the worker's onmessage was registered
       once and kept pointing at the initial render's callback, which
       captured the original activeChatId — so a generation completing
       on a newly-created chat would silently no-op and leave the user
       staring at an empty bubble / empty chat with tok/s stats. */

    // Keep streamingText mirrored into the in-progress assistant message so
    // closing / re-opening the tab shows partial output too.
    useEffect(() => {
        if (!streamingText) return;
        setConversations((prev) =>
            prev.map((c) => {
                if (c.id !== activeChatId) return c;
                const msgs = [...c.messages];
                const lastIdx = msgs.length - 1;
                if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].streaming) {
                    msgs[lastIdx] = { ...msgs[lastIdx], content: streamingText };
                }
                return { ...c, messages: msgs, updatedAt: Date.now() };
            })
        );
    // Only update when streamingText actually changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streamingText]);

    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text) return;
        if (!isLoaded) {
            setErrorMsg('Load a model first.');
            return;
        }
        if (isGenerating) return;

        setInput('');
        setErrorMsg('');
        setStreamingText('');

        /* Resolve the CURRENT conversation id, preferring activeChat?.id
           because activeChatId may be null/stale at first render. This
           is the single source of truth for writes this turn, and we
           also sync state + ref so downstream async callbacks agree. */
        const targetChatId = activeChat?.id || activeChatId;
        if (!targetChatId) {
            setErrorMsg('No active chat — try clicking + New chat.');
            return;
        }
        if (targetChatId !== activeChatId) {
            setActiveChatId(targetChatId);
        }
        activeChatIdRef.current = targetChatId;

        const history = activeChat?.messages || [];

        /* ---------- 1. Retrieval-augmented system prompt ----------
           A short follow-up like "why?" won't retrieve anything on its
           own; buildRetrievalQuery fuses the new turn with recent
           history so BM25 keeps pulling the right help sections even
           deep in a conversation. */
        let effectiveSystem = systemPrompt || '';
        let usedSources = [];
        if (useKnowledgeBase) {
            const retrievalQuery = buildRetrievalQuery(text, history);
            const recentUserTurns = history
                .filter((m) => m.role === 'user')
                .slice(-2)
                .map((m) => m.content);
            const { prompt, sources } = buildAugmentedSystemPrompt({
                userSystem: systemPrompt,
                query: retrievalQuery,
                history: recentUserTurns,
                budgetChars: DEFAULT_KB_BUDGET,
                k: DEFAULT_KB_K,
                /* Thread the loaded model's capability tier through so
                   tiny experimental models get a minimal prompt (no
                   primer, no rule list) — otherwise they hallucinate. */
                modelTier: currentModelMeta?.quality || 'good',
            });
            effectiveSystem = prompt;
            usedSources = sources;
        }

        /* ---------- 2. Context-aware history packing ----------
           Small local models almost always have a 2–4k token window.
           If we don't trim ourselves, the tokenizer will truncate from
           the END of the prompt — i.e. from the user's latest question
           — and the assistant will silently answer a stale turn.
           packHistory keeps the most recent user/assistant pairs within
           a budget computed from the system prompt + reply size. */
        const budget = computeHistoryBudget({
            systemPromptChars: effectiveSystem.length,
            maxNewTokens: params.max_new_tokens || 512,
            targetPromptTokens: 3200,
        });
        const packed = packHistory(history, { budgetChars: budget, minKeepTurns: 2 });

        const newUserMsg = { role: 'user', content: text, ts: Date.now() };
        const newAssistantMsg = {
            role: 'assistant',
            content: '',
            streaming: true,
            ts: Date.now(),
            sources: usedSources,
        };

        setConversations((prev) =>
            prev.map((c) => {
                if (c.id !== targetChatId) return c;
                const msgs = [...c.messages, newUserMsg, newAssistantMsg];
                const title =
                    c.title === 'New chat' || !c.title
                        ? text.slice(0, 40)
                        : c.title;
                return { ...c, messages: msgs, title, modelId: currentModelId, updatedAt: Date.now() };
            })
        );

        const payload = [
            ...(effectiveSystem ? [{ role: 'system', content: effectiveSystem }] : []),
            ...packed.messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: text },
        ];

        setContextInfo({
            turnsSent: packed.messages.length,
            turnsDropped: packed.droppedTurns,
            historyTokens: packed.tokens,
            systemTokens: Math.ceil(effectiveSystem.length / 3.8),
            kb: useKnowledgeBase,
            sourcesUsed: usedSources.length,
        });

        // Snapshot the exact payload for the inspector + console,
        // so you can verify conversation memory end-to-end.
        setLastPayload({
            messages: payload,
            ts: Date.now(),
            question: text,
        });
        try {
            console.log('[AIChat] sending to model:', {
                turns: payload.length,
                roles: payload.map((m) => m.role),
                payload,
            });
        } catch { /* ignore */ }

        /* Tiny 'experimental' models (270–360M params) sample way off
           distribution at the default temperature, producing garbled
           tokens ("眷", "iyev") and hallucinated jargon. Clamp temp
           and repetition_penalty for them so output stays coherent. */
        const effectiveParams = currentModelMeta?.quality === 'experimental'
            ? {
                ...params,
                temperature: Math.min(params.temperature ?? 0.7, 0.4),
                top_p: Math.min(params.top_p ?? 0.9, 0.85),
                repetition_penalty: Math.min(params.repetition_penalty ?? 1.1, 1.05),
                max_new_tokens: Math.min(params.max_new_tokens ?? 512, 300),
            }
            : params;

        workerRef.current?.postMessage({
            type: 'generate',
            messages: payload,
            params: effectiveParams,
        });
    }, [
        input,
        isLoaded,
        isGenerating,
        activeChat,
        activeChatId,
        systemPrompt,
        params,
        currentModelId,
        useKnowledgeBase,
    ]);

    const handleStop = useCallback(() => {
        workerRef.current?.postMessage({ type: 'stop' });
    }, []);

    const handleNewChat = useCallback(() => {
        const chat = newConversation(currentModelId);
        setConversations((prev) => [chat, ...prev]);
        setActiveChatId(chat.id);
        setStreamingText('');
        setContextInfo(null);
    }, [currentModelId]);

    const handleDeleteChat = useCallback((id) => {
        setConversations((prev) => {
            const next = prev.filter((c) => c.id !== id);
            if (!next.length) return [newConversation(currentModelId)];
            return next;
        });
        setActiveChatId((prev) => {
            if (prev !== id) return prev;
            const remaining = conversations.filter((c) => c.id !== id);
            return remaining[0]?.id || null;
        });
    }, [conversations, currentModelId]);

    const handleClearCurrent = useCallback(() => {
        /* Always usable escape hatch. If a generation is in flight (or
           got stuck in 'generating' because the worker silently stalled
           on WASM), we forcibly tell the worker to stop AND locally
           reset UI state so the user is never trapped. */
        try { workerRef.current?.postMessage({ type: 'stop' }); } catch { /* ignore */ }

        setConversations((prev) =>
            prev.map((c) =>
                c.id === activeChatId
                    ? { ...c, messages: [], title: 'New chat', updatedAt: Date.now() }
                    : c
            )
        );
        setStreamingText('');
        setContextInfo(null);
        setLastPayload(null);
        setErrorMsg('');
        setErrorStack('');
        setGenStartedAt(0);
        // If the worker was genuinely hung the 'stop' may never resolve;
        // locally snap the status back to something interactive so the
        // rest of the UI (Send button, Clear button, New chat) unblocks.
        setStatus((prev) => (prev === 'generating' ? (isLoaded ? 'ready' : 'idle') : prev));
    }, [activeChatId, isLoaded]);

    // When the user switches model via dropdown, auto-fill the recommended
    // dtype for the currently-selected device. WebGPU likes q4f16, WASM
    // prefers plain q4/q8 — picking the wrong one is a very common reason
    // for "load succeeds but generation hangs".
    const handleSelectModel = useCallback((id) => {
        setSelectedModel(id);
        setCustomModel('');
        const meta = CURATED_MODELS.find((m) => m.id === id);
        if (!meta) return;
        const next = device === 'webgpu' ? meta.dtypeWebGPU : meta.dtypeWasm;
        if (next) setDtype(next);
    }, [device]);

    // Re-align dtype when the user flips device, if a curated model is picked.
    const handleSelectDevice = useCallback((nextDevice) => {
        setDevice(nextDevice);
        if (customModel.trim()) return;
        const meta = CURATED_MODELS.find((m) => m.id === selectedModel);
        if (!meta) return;
        const next = nextDevice === 'webgpu' ? meta.dtypeWebGPU : meta.dtypeWasm;
        if (next) setDtype(next);
    }, [selectedModel, customModel]);

    /* ============ Derived UI values ============ */
    const activeMessages = activeChat?.messages || [];
    const overallProgress = useMemo(() => {
        const files = Object.values(downloadProgress);
        if (!files.length) return null;
        const totalLoaded = files.reduce((s, f) => s + (f.loaded || 0), 0);
        const totalBytes = files.reduce((s, f) => s + (f.total || 0), 0);
        const pct =
            totalBytes > 0
                ? (totalLoaded / totalBytes) * 100
                : files.reduce((s, f) => s + (f.progress || 0), 0) / files.length;
        return { pct, files: files.length, totalLoaded, totalBytes };
    }, [downloadProgress]);

    return (
        <div className="ai-chat-page">
            {/* ================= Left rail ================= */}
            <aside className={`ai-rail ${sidebarExpanded ? '' : 'ai-rail--collapsed'}`}>
                <div className="ai-rail-head">
                    <div className="ai-rail-title">
                        <Brain size={16} />
                        <span>AI Agents</span>
                    </div>
                    <button
                        type="button"
                        className="ai-rail-collapse"
                        onClick={() => setSidebarExpanded((s) => !s)}
                        title={sidebarExpanded ? 'Collapse' : 'Expand'}
                    >
                        {sidebarExpanded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                </div>

                {sidebarExpanded && (
                    <div className="ai-rail-body">
                        {/* ===== Model card ===== */}
                        <div className="ai-card">
                            <div className="ai-card-title">
                                <Sparkles size={14} /> Model
                            </div>

                            <label className="ai-field-label">Curated</label>
                            <select
                                className="ai-select"
                                value={CURATED_MODELS.some((m) => m.id === selectedModel) ? selectedModel : ''}
                                onChange={(e) => handleSelectModel(e.target.value)}
                                disabled={isLoading}
                            >
                                {CURATED_MODELS.map((m) => {
                                    const q = QUALITY_LABELS[m.quality] || {};
                                    return (
                                        <option key={m.id} value={m.id}>
                                            {m.label} · {m.size}
                                            {q.label ? ` · ${q.label}` : ''}
                                        </option>
                                    );
                                })}
                            </select>
                            {currentModelMeta && !customModel.trim() && (
                                <p className="ai-field-hint">
                                    {currentModelMeta.quality && (
                                        <span className={`ai-quality-badge ai-quality-${QUALITY_LABELS[currentModelMeta.quality]?.tone || 'neutral'}`}>
                                            {QUALITY_LABELS[currentModelMeta.quality]?.label || currentModelMeta.quality}
                                        </span>
                                    )}
                                    {currentModelMeta.description}
                                </p>
                            )}
                            {isLoaded && currentModelMeta?.quality === 'experimental' && (
                                <div className="ai-tier-warning">
                                    <strong>Heads up:</strong> this model only has ~200M parameters.
                                    Expect incoherent answers, hallucinated APIs, and occasional
                                    garbled characters — especially with NozePlot awareness on.
                                    For actual Q&A, load <em>Llama 3.2 1B</em> or <em>Gemma 3 1B</em> instead.
                                </div>
                            )}

                            <label className="ai-field-label" style={{ marginTop: 10 }}>
                                Custom HF model id
                            </label>
                            <input
                                className="ai-input"
                                type="text"
                                placeholder="e.g. onnx-community/Qwen2.5-0.5B-Instruct"
                                value={customModel}
                                onChange={(e) => setCustomModel(e.target.value)}
                                disabled={isLoading}
                            />

                            <div className="ai-grid-2" style={{ marginTop: 10 }}>
                                <div>
                                    <label className="ai-field-label">Device</label>
                                    <select
                                        className="ai-select"
                                        value={device}
                                        onChange={(e) => handleSelectDevice(e.target.value)}
                                        disabled={isLoading}
                                    >
                                        <option value="webgpu" disabled={webgpuAvailable === false}>
                                            WebGPU {webgpuAvailable === false ? '(unavailable)' : ''}
                                        </option>
                                        <option value="wasm">WASM (CPU)</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="ai-field-label">Precision</label>
                                    <select
                                        className="ai-select"
                                        value={dtype}
                                        onChange={(e) => setDtype(e.target.value)}
                                        disabled={isLoading}
                                    >
                                        {DTYPE_OPTIONS.map((d) => (
                                            <option key={d.value} value={d.value}>
                                                {d.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <button
                                type="button"
                                className="ai-btn ai-btn-primary ai-btn-block"
                                onClick={handleLoadModel}
                                disabled={isLoading || isGenerating}
                                style={{ marginTop: 12 }}
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 size={14} className="ai-spin" /> Downloading…
                                    </>
                                ) : isLoaded ? (
                                    <>
                                        <CheckCircle2 size={14} /> Reload
                                    </>
                                ) : (
                                    <>
                                        <Download size={14} /> Download & Load
                                    </>
                                )}
                            </button>

                            {/* Download progress */}
                            {overallProgress && (
                                <div className="ai-progress-wrap">
                                    <div className="ai-progress-track">
                                        <div
                                            className="ai-progress-fill"
                                            style={{ width: `${Math.min(100, overallProgress.pct)}%` }}
                                        />
                                    </div>
                                    <div className="ai-progress-meta">
                                        {overallProgress.totalBytes > 0
                                            ? `${(overallProgress.totalLoaded / 1e6).toFixed(1)} / ${(overallProgress.totalBytes / 1e6).toFixed(1)} MB`
                                            : `${overallProgress.pct.toFixed(0)}%`}
                                        <span className="ai-progress-files">
                                            · {overallProgress.files} file{overallProgress.files !== 1 ? 's' : ''}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {/* WASM + large-model perf advisory */}
                            {device === 'wasm' &&
                                currentModelMeta?.sizeMB &&
                                currentModelMeta.sizeMB >= 700 && (
                                    <div className="ai-status-warn">
                                        <AlertTriangle size={12} /> {currentModelMeta.label} on CPU
                                        (WASM) can take 20–60 s for the first reply. Switch to WebGPU
                                        or pick a smaller model for smoother chats.
                                    </div>
                                )}
                            {device === 'wasm' && currentModelMeta?.dtypeWasm === null && (
                                <div className="ai-status-warn">
                                    <AlertTriangle size={12} /> This model is not practical on CPU
                                    (WASM). Pick a smaller model or enable WebGPU.
                                </div>
                            )}

                            {/* Context-memory chip: shows that the assistant
                                actually has conversation memory, and how
                                much of it fits in the current model window. */}
                            {contextInfo && (
                                <div className="ai-context-chip-row">
                                    <div
                                        className="ai-context-chip"
                                        title={
                                            `${contextInfo.turnsSent} prior turn${contextInfo.turnsSent === 1 ? '' : 's'} sent to the model\n` +
                                            `${contextInfo.turnsDropped} older pair${contextInfo.turnsDropped === 1 ? '' : 's'} dropped to fit context window\n` +
                                            `~${contextInfo.historyTokens} history + ~${contextInfo.systemTokens} system tokens` +
                                            (contextInfo.kb ? `\n${contextInfo.sourcesUsed} doc section${contextInfo.sourcesUsed === 1 ? '' : 's'} grafted into system prompt` : '')
                                        }
                                    >
                                        <Brain size={11} /> Memory: {contextInfo.turnsSent} turn{contextInfo.turnsSent === 1 ? '' : 's'}
                                        <span className="ai-context-chip-sub">
                                            ~{(contextInfo.historyTokens + contextInfo.systemTokens)} tok
                                            {contextInfo.turnsDropped > 0 && ` · ${contextInfo.turnsDropped} dropped`}
                                        </span>
                                    </div>
                                    {lastPayload && (
                                        <button
                                            type="button"
                                            className="ai-inspect-btn"
                                            onClick={() => setShowPayloadModal(true)}
                                            title="See the exact messages sent to the model"
                                        >
                                            Show last prompt
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* Status line */}
                            <div className="ai-status-line" data-status={status}>
                                {status === 'idle' && <><Cpu size={12} /> Idle</>}
                                {status === 'loading' && <><Loader2 size={12} className="ai-spin" /> Loading model…</>}
                                {status === 'ready' && <><CheckCircle2 size={12} /> Ready · {loadedModelId.split('/').pop()}</>}
                                {status === 'generating' && (
                                    <>
                                        <Zap size={12} /> Generating… {Math.max(0, elapsedMs / 1000).toFixed(1)} s
                                        {firstTokenMs != null && (
                                            <span className="ai-status-sub">
                                                · first chunk @ {(firstTokenMs / 1000).toFixed(1)} s
                                            </span>
                                        )}
                                    </>
                                )}
                                {errorMsg && (
                                    <div className="ai-status-err">
                                        <AlertTriangle size={12} /> {errorMsg}
                                        {errorStack && (
                                            <details className="ai-status-err-details">
                                                <summary>stack</summary>
                                                <pre>{errorStack}</pre>
                                            </details>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ===== Params ===== */}
                        <div className="ai-card">
                            <button
                                type="button"
                                className="ai-card-title ai-card-toggle"
                                onClick={() => setParamsOpen((v) => !v)}
                            >
                                {paramsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <Settings size={14} /> Generation params
                            </button>
                            {paramsOpen && (
                                <div className="ai-params">
                                    <NumField
                                        label="Max new tokens"
                                        value={params.max_new_tokens}
                                        min={16} max={4096} step={16}
                                        onChange={(v) => setParams((p) => ({ ...p, max_new_tokens: v }))}
                                    />
                                    <NumField
                                        label="Temperature"
                                        value={params.temperature}
                                        min={0} max={2} step={0.05}
                                        onChange={(v) => setParams((p) => ({ ...p, temperature: v }))}
                                    />
                                    <NumField
                                        label="top_p"
                                        value={params.top_p}
                                        min={0} max={1} step={0.05}
                                        onChange={(v) => setParams((p) => ({ ...p, top_p: v }))}
                                    />
                                </div>
                            )}
                        </div>

                        {/* ===== App knowledge base ===== */}
                        <div className="ai-card">
                            <div className="ai-card-title">
                                <BookOpen size={14} /> NozePlot awareness
                            </div>
                            <label className="ai-kb-toggle">
                                <input
                                    type="checkbox"
                                    checked={useKnowledgeBase}
                                    onChange={(e) => setUseKnowledgeBase(e.target.checked)}
                                />
                                <span>
                                    Let the assistant know about this app
                                    <span className="ai-kb-hint">
                                        Adds background knowledge from the Help guide only when your
                                        question is actually about NozePlot. General questions are
                                        unaffected.
                                    </span>
                                </span>
                            </label>
                        </div>

                        {/* ===== System prompt ===== */}
                        <div className="ai-card">
                            <div className="ai-card-title-row">
                                <button
                                    type="button"
                                    className="ai-card-title ai-card-toggle"
                                    onClick={() => setSystemOpen((v) => !v)}
                                >
                                    {systemOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    <Bot size={14} /> System prompt
                                </button>
                                {systemOpen && systemPrompt !== DEFAULT_SYSTEM_PROMPT && (
                                    <button
                                        type="button"
                                        className="ai-inline-link"
                                        onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
                                        title="Restore the default general-assistant prompt"
                                    >
                                        Reset
                                    </button>
                                )}
                            </div>
                            {systemOpen && (
                                <textarea
                                    className="ai-textarea ai-textarea--system"
                                    rows={7}
                                    value={systemPrompt}
                                    onChange={(e) => setSystemPrompt(e.target.value)}
                                />
                            )}
                        </div>

                        {/* ===== Chat list ===== */}
                        <div className="ai-card">
                            <div className="ai-card-title ai-chat-list-title">
                                <span><Bot size={14} /> Conversations</span>
                                <button
                                    type="button"
                                    className="ai-chiplink"
                                    onClick={handleNewChat}
                                    title="New chat"
                                >
                                    <Plus size={12} /> New
                                </button>
                            </div>
                            <div className="ai-chat-list">
                                {conversations.map((c) => (
                                    <div
                                        key={c.id}
                                        className={`ai-chat-item ${c.id === activeChatId ? 'ai-chat-item--active' : ''}`}
                                        onClick={() => { setActiveChatId(c.id); setContextInfo(null); }}
                                    >
                                        <div className="ai-chat-item-title" title={c.title}>
                                            {c.title || 'New chat'}
                                        </div>
                                        <div className="ai-chat-item-meta">
                                            {c.messages.length} msg
                                            {c.modelId ? ` · ${c.modelId.split('/').pop()}` : ''}
                                        </div>
                                        <button
                                            type="button"
                                            className="ai-chat-item-del"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDeleteChat(c.id);
                                            }}
                                            title="Delete chat"
                                        >
                                            <Trash2 size={11} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </aside>

            {/* ================= Main chat area ================= */}
            <section className="ai-main">
                <header className="ai-main-head">
                    <div className="ai-main-head-left">
                        <h1 className="ai-main-title">
                            {activeChat?.title || 'New chat'}
                        </h1>
                        <span className="ai-main-sub">
                            {isLoaded ? (
                                <>
                                    <Cpu size={11} /> {loadedModelId.split('/').pop()} · {device} · {dtype}
                                </>
                            ) : (
                                <>Pick a model on the left, then Download & Load to start chatting.</>
                            )}
                            {lastStats && status !== 'generating' && (
                                <span className="ai-main-sub-stats">
                                    {' '}· {lastStats.tokens} tok · {lastStats.seconds.toFixed(1)} s
                                    {lastStats.tps ? ` · ${lastStats.tps.toFixed(1)} tok/s` : ''}
                                </span>
                            )}
                        </span>
                    </div>
                    <div className="ai-main-head-actions">
                        <button
                            type="button"
                            className="ai-btn ai-btn-ghost"
                            onClick={handleClearCurrent}
                            title={isGenerating
                                ? 'Stop generation and clear this chat'
                                : 'Clear this chat'}
                        >
                            <RefreshCw size={13} /> Clear
                        </button>
                    </div>
                </header>

                <div className="ai-scroll" ref={scrollRef}>
                    {activeMessages.length === 0 && (
                        <div className="ai-empty">
                            <div className="ai-empty-badge"><Brain size={24} /></div>
                            <p className="ai-empty-line">
                                {isLoaded ? 'Ask anything.' : 'Load a model to start chatting.'}
                            </p>
                        </div>
                    )}
                    {activeMessages.map((m, i) => {
                        const isLiveStream =
                            m.streaming &&
                            isGenerating &&
                            i === activeMessages.length - 1;
                        return (
                            <MessageBubble
                                key={i}
                                role={m.role}
                                content={m.content}
                                streaming={m.streaming}
                                stopped={m.stopped}
                                sources={m.sources}
                                waitingNote={
                                    isLiveStream && !m.content
                                        ? `Warming up… ${(elapsedMs / 1000).toFixed(1)} s elapsed`
                                        : null
                                }
                                onSourceClick={(anchor) => {
                                    if (!anchor) return;
                                    // Fire a global event the App shell can
                                    // intercept to navigate to Help + scroll
                                    // to the anchor; we also best-effort try
                                    // same-page scroll for users already on
                                    // the Help tab.
                                    try {
                                        window.dispatchEvent(
                                            new CustomEvent('nozeplot-navigate-help', {
                                                detail: { anchor },
                                            })
                                        );
                                        const el = document.getElementById(`help-${anchor}`);
                                        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                    } catch { /* ignore */ }
                                }}
                            />
                        );
                    })}
                </div>

                <footer className="ai-composer">
                    <textarea
                        ref={inputRef}
                        className="ai-textarea ai-composer-input"
                        rows={3}
                        placeholder={
                            isLoaded
                                ? 'Ask anything… (Enter to send · Shift+Enter for newline)'
                                : 'Load a model first to start chatting…'
                        }
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                        disabled={!isLoaded || isGenerating}
                    />
                    <div className="ai-composer-actions">
                        {isGenerating ? (
                            <button
                                type="button"
                                className="ai-btn ai-btn-danger"
                                onClick={handleStop}
                            >
                                <Square size={13} /> Stop
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="ai-btn ai-btn-primary"
                                onClick={handleSend}
                                disabled={!isLoaded || !input.trim()}
                            >
                                <Send size={13} /> Send
                            </button>
                        )}
                    </div>
                </footer>
            </section>

            {showPayloadModal && lastPayload && (
                <PayloadInspector
                    payload={lastPayload}
                    onClose={() => setShowPayloadModal(false)}
                />
            )}
        </div>
    );
}

/* -------------------- Sub-components -------------------- */

function PayloadInspector({ payload, onClose }) {
    const { messages, question, ts } = payload;
    const roleCounts = messages.reduce((acc, m) => {
        acc[m.role] = (acc[m.role] || 0) + 1;
        return acc;
    }, {});
    const totalChars = messages.reduce((s, m) => s + (m.content?.length || 0), 0);
    const totalTokens = Math.ceil(totalChars / 3.8);
    return (
        <div className="ai-inspector-backdrop" onClick={onClose}>
            <div
                className="ai-inspector-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-label="Last prompt sent to the model"
            >
                <header className="ai-inspector-head">
                    <div>
                        <div className="ai-inspector-title">
                            Last prompt sent to the model
                        </div>
                        <div className="ai-inspector-sub">
                            Question: <em>&ldquo;{question}&rdquo;</em> ·{' '}
                            {new Date(ts).toLocaleTimeString()}
                        </div>
                        <div className="ai-inspector-stats">
                            {messages.length} messages · ~{totalChars.toLocaleString()} chars
                            · ~{totalTokens.toLocaleString()} tokens ·{' '}
                            {Object.entries(roleCounts)
                                .map(([r, n]) => `${n} ${r}`)
                                .join(' · ')}
                        </div>
                    </div>
                    <button type="button" className="ai-inspector-close" onClick={onClose}>
                        ✕
                    </button>
                </header>
                <div className="ai-inspector-body">
                    {messages.map((m, i) => (
                        <div key={i} className={`ai-inspector-msg ai-inspector-msg--${m.role}`}>
                            <div className="ai-inspector-msg-head">
                                <span className="ai-inspector-msg-role">{m.role}</span>
                                <span className="ai-inspector-msg-meta">
                                    {m.content.length.toLocaleString()} chars · ~
                                    {Math.ceil(m.content.length / 3.8).toLocaleString()} tokens
                                </span>
                            </div>
                            <pre className="ai-inspector-msg-body">{m.content}</pre>
                        </div>
                    ))}
                </div>
                <footer className="ai-inspector-foot">
                    <span className="ai-inspector-hint">
                        If the history above does NOT show your earlier turns, something upstream
                        is wrong — please share a screenshot of this view.
                    </span>
                    <button
                        type="button"
                        className="ai-btn"
                        onClick={() => {
                            try {
                                navigator.clipboard?.writeText(JSON.stringify(messages, null, 2));
                            } catch { /* ignore */ }
                        }}
                    >
                        Copy JSON
                    </button>
                </footer>
            </div>
        </div>
    );
}

function MessageBubble({
    role,
    content,
    streaming,
    stopped,
    waitingNote,
    sources,
    onSourceClick,
}) {
    const isUser = role === 'user';
    const hasSources = !isUser && Array.isArray(sources) && sources.length > 0;
    return (
        <div className={`ai-msg ai-msg--${role}`}>
            <div className="ai-msg-avatar">
                {isUser ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className="ai-msg-body">
                <div className="ai-msg-role">{isUser ? 'You' : 'Assistant'}</div>
                <div className={`ai-msg-content ${streaming ? 'ai-msg-content--streaming' : ''}`}>
                    {content || (
                        streaming ? (
                            <em className="ai-msg-wait">
                                {waitingNote || 'thinking…'}
                            </em>
                        ) : ''
                    )}
                    {streaming && <span className="ai-msg-caret" />}
                </div>
                {stopped && <div className="ai-msg-stopped">⏹ stopped</div>}
                {hasSources && (
                    <div className="ai-msg-sources">
                        <span className="ai-msg-sources-label">
                            <BookOpen size={11} /> Drew on
                        </span>
                        {sources.map((s) => (
                            <button
                                key={s.id}
                                type="button"
                                className="ai-msg-source-chip"
                                title={`${s.source} · score ${s.score?.toFixed(2)}`}
                                onClick={() => onSourceClick?.(s.anchor)}
                                disabled={!s.anchor}
                            >
                                {s.title}
                                <span className="ai-msg-source-origin">· {s.source}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function NumField({ label, value, min, max, step, onChange }) {
    return (
        <div className="ai-numfield">
            <div className="ai-numfield-head">
                <span>{label}</span>
                <span className="ai-numfield-val">
                    {Number.isFinite(step) && step < 1 ? Number(value).toFixed(2) : value}
                </span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
            />
        </div>
    );
}
