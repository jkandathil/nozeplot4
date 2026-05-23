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
    Upload,
    FileJson,
} from 'lucide-react';
import './AIChatPage.css';
import {
    buildAugmentedSystemPrompt,
    buildGroundedAppAnswer,
    setUploadedKnowledgeChunks,
    clearUploadedKnowledgeBase,
    getEffectiveKnowledgeSize,
} from '../ai/kb/knowledgeBase.js';
import {
    packHistory,
    buildRetrievalQuery,
    computeHistoryBudget,
} from '../ai/chatContext.js';
import {
    DEFAULT_GEMINI_MODEL,
    GEMINI_MODEL_OPTIONS,
    resolveGeminiApiKey,
    streamGeminiChat,
} from '../ai/geminiChat.js';

/** Must match `UPLOAD_MODEL_ID` in `src/ai/aiChatWorker.js` (synthetic HF repo for zip uploads). */
const UPLOADED_ONNX_MODEL_ID = 'hf-internal/user-upload';

/**
 * If every entry shares the same path prefix (single root folder in the zip),
 * strip it so paths match Transformers.js hub layouts (`config.json` at root).
 */
function stripZipCommonRoot(files) {
    const keys = Object.keys(files).filter((k) => !k.endsWith('/'));
    if (keys.length <= 1) return files;
    const segments = keys.map((k) => k.split('/').filter(Boolean));
    let depth = 0;
    while (true) {
        const s0 = segments[0][depth];
        if (s0 == null) break;
        if (!segments.every((segs) => segs[depth] === s0)) break;
        depth += 1;
    }
    if (depth === 0) return files;
    const prefix = `${segments[0].slice(0, depth).join('/')}/`;
    const out = {};
    for (const k of keys) {
        out[k.slice(prefix.length)] = files[k];
    }
    return out;
}

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
    'Answer any question the user asks — general knowledge, technical, creative, conversational, coding, math, writing, everyday life. Think it through and give a clear, specific, helpful answer.',
    '',
    'Response style (Markdown — your output is rendered as Markdown in a chat bubble):',
    '- Lead with the direct answer in 1 short sentence.',
    '- Use `### Heading` sections only when the answer has 2+ natural groupings (e.g. "What it does" / "How to use it").',
    '- Use `- ` bullets for lists, `1.` for ordered/sequential steps.',
    '- Use **bold** for UI labels, settings, tab names, or key terms.',
    '- Use `inline code` for file paths, identifiers, or short code; use ```fenced code blocks``` for multi-line code.',
    '- Keep tone warm, confident, practical. No filler, no apologies, no recap, no "I hope this helps".',
    '- Stop as soon as the question is answered. Depth over length.',
    '',
    'You are embedded inside NozePlot, an analytics app for sensor / aroma data. If the user asks about NozePlot or its features, background knowledge will be added to your context when relevant — synthesize it in your own words, do not read it back. For anything not about NozePlot, answer from your own knowledge.',
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
/* v2 because v1 stored creative-writing defaults (temp=0.7, top_p=0.9,
   max_new_tokens=512) that triggered run-on degeneracy in browser-resident
   LLMs. Bumping the key forces a one-time reset to Q&A-friendly defaults. */
const LS_PARAMS = 'ai-chat:params:v3';
/* v2 to roll out the new response style defaults globally. */
const LS_SYSTEM = 'ai-chat:system-prompt:v3';
const LS_CHATS = 'ai-chat:conversations:v1';
const LS_ACTIVE_CHAT = 'ai-chat:active-conversation';
const LS_KB_ENABLED = 'ai-chat:kb-enabled';
const LS_BACKEND = 'ai-chat:backend';
const LS_GEMINI_KEY = 'ai-chat:gemini-api-key';
const LS_GEMINI_MODEL = 'ai-chat:gemini-model';

/** `local` = on-device HF ONNX; `gemini` = Google Gemini Flash API */
const BACKEND_LOCAL = 'local';
const BACKEND_GEMINI = 'gemini';

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

function looksLikeNozePlotQuestion(text) {
    const q = String(text || '').toLowerCase();
    if (!q.trim()) return false;
    const hints = [
        'nozeplot', 'fenoze', 'fenose', 'app', 'tab', 'page', 'module',
        'flow lab', 'aroma', 'se analysis', 'normalize', 'ml studio',
        'dashboard', 'workspace', 'drift map', 'separability', 'sensitivity',
        'serial monitor', 'code studio', 'spreadsheet', 'help',
    ];
    return hints.some((h) => q.includes(h));
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

    /* -------- Generation params --------
       Defaults are tuned for Q&A / assistant use, not creative writing.
       In the latter regime (temp 0.7+, top_p 0.9+, large max_new_tokens)
       browser-resident small/medium LLMs reliably degenerate into
       run-on cadences and thesaurus-style word lists once they exhaust
       their grounded answer ("…cornerstone categorically cardinal
       bedrock bonesback core linchpin…"). The values below match what
       OpenAI/Anthropic use as chat defaults. */
    const [params, setParams] = useState(() => ({
        max_new_tokens: 500,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 50,
        /* 1.08 is the sweet-spot for 'great' tier chat models
           (Phi-3.5, SmolLM2-1.7B). Higher values cause article-dropping
           degeneracy on long general-knowledge answers. The per-tier
           clamps below will raise this for weaker models. */
        repetition_penalty: 1.08,
        no_repeat_ngram_size: 0,
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

    const [backend, setBackend] = useState(() => loadLS(LS_BACKEND, BACKEND_LOCAL));
    const [geminiApiKeyInput, setGeminiApiKeyInput] = useState(() => loadLS(LS_GEMINI_KEY, ''));
    const [geminiModel, setGeminiModel] = useState(
        () => loadLS(LS_GEMINI_MODEL, DEFAULT_GEMINI_MODEL)
    );
    const geminiAbortRef = useRef(null);

    const effectiveGeminiKey = useMemo(
        () => resolveGeminiApiKey(geminiApiKeyInput),
        [geminiApiKeyInput]
    );
    const isGeminiBackend = backend === BACKEND_GEMINI;

    const uploadedOnnxFilesRef = useRef(null);
    const onnxZipInputRef = useRef(null);
    const ragJsonInputRef = useRef(null);
    const [onnxZipName, setOnnxZipName] = useState('');
    const [ragBundleName, setRagBundleName] = useState('');
    const [kbChunkCount, setKbChunkCount] = useState(() => getEffectiveKnowledgeSize());

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

    /* Writes assistant reply into the active chat (ref-based id). */
    const finalizeAssistantMessageByRef = useCallback((finalText, stats, wasStopped) => {
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
    }, []);

    /* ============ Worker wiring ============ */
    useEffect(() => {
        const w = new Worker(new URL('../ai/aiChatWorker.js', import.meta.url), { type: 'module' });
        workerRef.current = w;

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
    }, [finalizeAssistantMessageByRef]);

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
    useEffect(() => { saveLS(LS_BACKEND, backend); }, [backend]);
    useEffect(() => { saveLS(LS_GEMINI_KEY, geminiApiKeyInput); }, [geminiApiKeyInput]);
    useEffect(() => { saveLS(LS_GEMINI_MODEL, geminiModel); }, [geminiModel]);
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

    const effectiveModelId = onnxZipName ? UPLOADED_ONNX_MODEL_ID : currentModelId;

    const currentModelMeta = useMemo(
        () => CURATED_MODELS.find((m) => m.id === currentModelId) || null,
        [currentModelId]
    );

    const isLocalLoaded =
        !!loadedModelId &&
        loadedModelId === effectiveModelId &&
        status !== 'loading';
    const isLoaded = isGeminiBackend
        ? !!effectiveGeminiKey
        : isLocalLoaded;
    const isLoading = !isGeminiBackend && status === 'loading';
    const isGenerating = status === 'generating';

    /* Gemini backend: ready when API key is set (no model download). */
    useEffect(() => {
        if (!isGeminiBackend) return;
        if (isGenerating) return;
        if (effectiveGeminiKey) {
            setStatus('ready');
            setLoadedModelId(`gemini/${geminiModel}`);
            setErrorMsg('');
        } else {
            setStatus('idle');
            setLoadedModelId('');
        }
    }, [isGeminiBackend, effectiveGeminiKey, geminiModel, isGenerating]);

    /* Leaving Gemini: clear cloud "ready" state until a local model loads. */
    useEffect(() => {
        if (isGeminiBackend || isLocalLoaded) return;
        if (loadedModelId.startsWith('gemini/')) {
            setLoadedModelId('');
            setStatus('idle');
        }
    }, [isGeminiBackend, isLocalLoaded, loadedModelId]);

    /* ============ Actions ============ */
    const handleLoadModel = useCallback(() => {
        const uploaded = uploadedOnnxFilesRef.current;
        if (uploaded && Object.keys(uploaded).length > 0) {
            setErrorMsg('');
            setDownloadProgress({});
            workerRef.current?.postMessage({
                type: 'load-uploaded',
                files: uploaded,
                device,
                dtype,
            });
            return;
        }
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

    const handleOnnxZipChange = useCallback(async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        if (!f.name.toLowerCase().endsWith('.zip')) {
            setErrorMsg('Choose a .zip containing ONNX + tokenizer files (Transformers.js layout).');
            return;
        }
        try {
            const { default: JSZip } = await import('jszip');
            const zip = await JSZip.loadAsync(f);
            const raw = {};
            for (const [path, entry] of Object.entries(zip.files)) {
                if (entry.dir) continue;
                if (path.includes('__MACOSX') || path.endsWith('.DS_Store')) continue;
                const norm = path.replace(/\\/g, '/');
                raw[norm] = await entry.async('arraybuffer');
            }
            const cleaned = stripZipCommonRoot(raw);
            uploadedOnnxFilesRef.current = cleaned;
            setOnnxZipName(f.name);
            setErrorMsg('');
        } catch (err) {
            setErrorMsg(`Could not read model zip: ${err?.message || err}`);
        }
    }, []);

    const handleClearOnnxUpload = useCallback(() => {
        uploadedOnnxFilesRef.current = null;
        setOnnxZipName('');
        workerRef.current?.postMessage({ type: 'unload' });
        setLoadedModelId('');
        setStatus('idle');
    }, []);

    const handleRagJsonChange = useCallback(async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
            const text = await f.text();
            const data = JSON.parse(text);
            const chunks = Array.isArray(data.chunks) ? data.chunks : Array.isArray(data) ? data : null;
            if (!chunks) {
                throw new Error('Expected an array or { "chunks": [ ... ] }');
            }
            setUploadedKnowledgeChunks(chunks);
            setRagBundleName(f.name);
            setKbChunkCount(getEffectiveKnowledgeSize());
            setErrorMsg('');
        } catch (err) {
            setErrorMsg(`RAG bundle parse error: ${err?.message || err}`);
        }
    }, []);

    const handleClearRagUpload = useCallback(() => {
        clearUploadedKnowledgeBase();
        setRagBundleName('');
        setKbChunkCount(getEffectiveKnowledgeSize());
    }, []);

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
            setErrorMsg(
                isGeminiBackend
                    ? 'Add your Gemini API key in the sidebar (or set VITE_GEMINI_API_KEY at build time).'
                    : 'Load a model first.'
            );
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

        const isLikelyAppQuestion = looksLikeNozePlotQuestion(text);
        const topSourceScore = usedSources.length ? (usedSources[0].score || 0) : 0;
        const hasStrongGrounding = usedSources.length > 0 && topSourceScore >= 1.6;
        const isUngroundedAppQuestion = useKnowledgeBase && isLikelyAppQuestion && !hasStrongGrounding;

        /* Grounded intelligence path:
           For app-specific questions with strong retrieval, answer
           directly from retrieved knowledge chunks (deterministic
           synthesis) instead of free-form generation. This removes the
           remaining hallucination surface while preserving source chips. */
        if (useKnowledgeBase && isLikelyAppQuestion && hasStrongGrounding) {
            const grounded = buildGroundedAppAnswer({ query: text, minScore: 1.6, k: 5 });
            if (grounded?.text) {
                const newUserMsg = { role: 'user', content: text, ts: Date.now() };
                const newAssistantMsg = {
                    role: 'assistant',
                    content: grounded.text,
                    streaming: false,
                    ts: Date.now(),
                    sources: grounded.sources || usedSources,
                };
                setConversations((prev) =>
                    prev.map((c) => {
                        if (c.id !== targetChatId) return c;
                        const msgs = [...c.messages, newUserMsg, newAssistantMsg];
                        const title =
                            c.title === 'New chat' || !c.title
                                ? text.slice(0, 40)
                                : c.title;
                        return {
                            ...c,
                            messages: msgs,
                            title,
                            modelId: isGeminiBackend ? `gemini/${geminiModel}` : currentModelId,
                            updatedAt: Date.now(),
                        };
                    })
                );
                setContextInfo({
                    turnsSent: 0,
                    turnsDropped: 0,
                    historyTokens: 0,
                    systemTokens: Math.ceil(effectiveSystem.length / 3.8),
                    kb: useKnowledgeBase,
                    sourcesUsed: (grounded.sources || usedSources).length,
                });
                return;
            }
        }

        /* Anti-hallucination guard:
           For app-specific questions, if retrieval cannot find relevant
           grounded context, do NOT let the model improvise page/module
           behavior. Return a clear "can't verify" answer and ask for a
           more specific path/label so retrieval can lock onto docs. */
        if (isUngroundedAppQuestion) {
            const newUserMsg = { role: 'user', content: text, ts: Date.now() };
            const newAssistantMsg = {
                role: 'assistant',
                content: [
                    'I can help, but I cannot verify that from the app knowledge I have loaded right now.',
                    'Please ask with the exact tab/page name (for example: "Flow Lab", "SE Analysis", "Normalize", "Aroma Analysis"), and I will answer using grounded app context only.',
                ].join(' '),
                streaming: false,
                ts: Date.now(),
                sources: [],
            };
            setConversations((prev) =>
                prev.map((c) => {
                    if (c.id !== targetChatId) return c;
                    const msgs = [...c.messages, newUserMsg, newAssistantMsg];
                    const title =
                        c.title === 'New chat' || !c.title
                            ? text.slice(0, 40)
                            : c.title;
                    return {
                        ...c,
                        messages: msgs,
                        title,
                        modelId: isGeminiBackend ? `gemini/${geminiModel}` : currentModelId,
                        updatedAt: Date.now(),
                    };
                })
            );
            setContextInfo({
                turnsSent: 0,
                turnsDropped: 0,
                historyTokens: 0,
                systemTokens: Math.ceil(effectiveSystem.length / 3.8),
                kb: useKnowledgeBase,
                sourcesUsed: 0,
            });
            return;
        }
        const isAppFeatureQuestion = useKnowledgeBase && usedSources.length > 0;
        if (isAppFeatureQuestion) {
            effectiveSystem = [
                effectiveSystem,
                '',
                'When answering NozePlot feature/how-to questions:',
                '- Use plain English.',
                '- Keep it short: max 5 bullets or 3-6 short sentences.',
                '- Prioritize exact UI actions (what to click/open).',
                '- Do not write long run-on paragraphs or filler text.',
            ].join('\n');
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
            targetPromptTokens: isGeminiBackend ? 120000 : 3200,
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
                return {
                    ...c,
                    messages: msgs,
                    title,
                    modelId: isGeminiBackend ? `gemini/${geminiModel}` : currentModelId,
                    updatedAt: Date.now(),
                };
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

        /* Per-tier sampling clamps.
           Small LLMs love to fall into a degeneracy trap: the model
           latches onto a cadence ('circumstantial circumstances
           surrounding dialogue participants ...') and keeps emitting
           off-distribution tokens until max_new_tokens runs out. Two
           counter-measures work together:
             1. Cap max_new_tokens so even if it drifts, it dies fast.
             2. Raise repetition_penalty so the drift is less likely
                to begin in the first place.
           We ONLY override when user's param is looser than the tier
           ceiling — if the user dialled it down manually we respect
           their choice. */
        const tier = currentModelMeta?.quality || 'good';
        const clamp = (v, ceil) => (v == null ? ceil : Math.min(v, ceil));

        /* Tier-aware guardrails.
           LESSON LEARNED: the previous "universal" no_repeat_ngram_size=4
           + repetition_penalty=1.15 combo works great for tiny models
           but actively DAMAGES 'great' tier models. With Phi-3.5, once
           common 4-grams like "one mole of a" or "the number of atoms"
           get blocked, the model drops articles/prepositions to avoid
           any 4-gram repeat and spirals into word salad
           ("count macroscale amounts material science physical sciences
           rely heavily today thanks largely contribution…"). We now
           scale the guardrails to the model's self-regulation ability.

           • experimental: hard clamps — small models absolutely need
             them or they loop ("circumstantial circumstances…").
           • basic/good: moderate clamps.
           • great: disable no_repeat_ngram_size entirely and use a
             gentle repetition penalty (1.08). Phi-3.5 & SmolLM2-1.7B
             self-regulate well enough that heavier clamps do more harm
             than good. */
        let effectiveParams = { ...params };
        if (tier === 'experimental') {
            effectiveParams = {
                ...effectiveParams,
                temperature: clamp(params.temperature, 0.35),
                top_p: clamp(params.top_p, 0.85),
                top_k: clamp(params.top_k ?? 30, 30),
                repetition_penalty: Math.max(params.repetition_penalty ?? 1.1, 1.2),
                no_repeat_ngram_size: params.no_repeat_ngram_size ?? 4,
                max_new_tokens: clamp(params.max_new_tokens, 280),
            };
        } else if (tier === 'basic' || tier === 'good') {
            effectiveParams = {
                ...effectiveParams,
                temperature: clamp(params.temperature, 0.5),
                top_p: clamp(params.top_p, 0.9),
                top_k: params.top_k ?? 40,
                repetition_penalty: Math.max(params.repetition_penalty ?? 1.1, 1.12),
                no_repeat_ngram_size: params.no_repeat_ngram_size ?? 4,
                max_new_tokens: clamp(params.max_new_tokens, 420),
            };
        } else {
            // 'great' tier (Phi-3.5, SmolLM2-1.7B): gentle guards only.
            effectiveParams = {
                ...effectiveParams,
                temperature: clamp(params.temperature, 0.5),
                top_p: clamp(params.top_p, 0.9),
                top_k: params.top_k ?? 50,
                repetition_penalty: Math.max(params.repetition_penalty ?? 1.05, 1.08),
                no_repeat_ngram_size: params.no_repeat_ngram_size ?? 0,
                max_new_tokens: clamp(params.max_new_tokens, 600),
            };
        }

        /* App-feature Q&A should be factual and stable, not creative.
           If retrieval found relevant app passages, force deterministic
           decoding so answers don't drift into verbose nonsense. */
        if (isAppFeatureQuestion) {
            effectiveParams = {
                ...effectiveParams,
                do_sample: false,
                temperature: 0,
                top_p: 1,
                top_k: 0,
                max_new_tokens: clamp(params.max_new_tokens, 220),
                repetition_penalty: Math.max(params.repetition_penalty ?? 1.1, 1.12),
                no_repeat_ngram_size: Math.max(effectiveParams.no_repeat_ngram_size ?? 0, 4),
            };
        }

        if (isGeminiBackend) {
            const genStarted = Date.now();
            setStatus('generating');
            setGenStartedAt(genStarted);
            setFirstTokenMs(null);
            const ac = new AbortController();
            geminiAbortRef.current = ac;
            (async () => {
                try {
                    const geminiParams = isAppFeatureQuestion
                        ? { temperature: 0, top_p: 1, max_new_tokens: 512 }
                        : {
                              temperature: params.temperature,
                              top_p: params.top_p,
                              max_new_tokens: Math.min(params.max_new_tokens || 2048, 8192),
                          };
                    const result = await streamGeminiChat({
                        apiKey: effectiveGeminiKey,
                        model: geminiModel,
                        messages: payload,
                        params: geminiParams,
                        signal: ac.signal,
                        onFirstChunk: () => setFirstTokenMs(Date.now() - genStarted),
                        onChunk: (chunk) => setStreamingText((prev) => prev + chunk),
                    });
                    finalizeAssistantMessageByRef(result.text, result.stats, false);
                } catch (err) {
                    if (err?.name === 'AbortError') {
                        finalizeAssistantMessageByRef('', null, true);
                    } else {
                        const msg = err?.message || String(err);
                        setErrorMsg(msg);
                        finalizeAssistantMessageByRef(`**Gemini error:** ${msg}`, null, false);
                    }
                } finally {
                    geminiAbortRef.current = null;
                    setStatus('ready');
                    setGenStartedAt(0);
                }
            })();
            return;
        }

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
        isGeminiBackend,
        effectiveGeminiKey,
        geminiModel,
        finalizeAssistantMessageByRef,
        currentModelMeta,
    ]);

    const handleStop = useCallback(() => {
        if (isGeminiBackend && geminiAbortRef.current) {
            geminiAbortRef.current.abort();
            geminiAbortRef.current = null;
            return;
        }
        workerRef.current?.postMessage({ type: 'stop' });
    }, [isGeminiBackend]);

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
        try {
            if (geminiAbortRef.current) {
                geminiAbortRef.current.abort();
                geminiAbortRef.current = null;
            }
            workerRef.current?.postMessage({ type: 'stop' });
        } catch { /* ignore */ }

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

                            <label className="ai-field-label">Backend</label>
                            <select
                                className="ai-select"
                                value={backend}
                                onChange={(e) => setBackend(e.target.value)}
                                disabled={isLoading || isGenerating}
                            >
                                <option value={BACKEND_LOCAL}>On-device (Hugging Face ONNX)</option>
                                <option value={BACKEND_GEMINI}>Gemini Flash (Google API)</option>
                            </select>

                            {isGeminiBackend ? (
                                <div className="ai-gemini-panel" style={{ marginTop: 10 }}>
                                    <label className="ai-field-label">Gemini model</label>
                                    <select
                                        className="ai-select"
                                        value={geminiModel}
                                        onChange={(e) => setGeminiModel(e.target.value)}
                                        disabled={isGenerating}
                                    >
                                        {GEMINI_MODEL_OPTIONS.map((m) => (
                                            <option key={m.id} value={m.id}>
                                                {m.label}
                                            </option>
                                        ))}
                                    </select>
                                    <label className="ai-field-label" style={{ marginTop: 8 }}>
                                        API key
                                    </label>
                                    <input
                                        className="ai-input"
                                        type="password"
                                        autoComplete="off"
                                        placeholder="AIza… (from Google AI Studio)"
                                        value={geminiApiKeyInput}
                                        onChange={(e) => setGeminiApiKeyInput(e.target.value)}
                                        disabled={isGenerating}
                                    />
                                    <p className="ai-field-hint">
                                        Get a key at{' '}
                                        <a
                                            href="https://aistudio.google.com/apikey"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            Google AI Studio
                                        </a>
                                        . Stored in this browser only. For team deploys you can set{' '}
                                        <code>VITE_GEMINI_API_KEY</code> at build time instead.
                                    </p>
                                    {!effectiveGeminiKey && (
                                        <div className="ai-status-warn" style={{ marginTop: 8 }}>
                                            <AlertTriangle size={12} /> Paste an API key to chat with Gemini.
                                        </div>
                                    )}
                                    {effectiveGeminiKey && (
                                        <div className="ai-status-ok" style={{ marginTop: 8 }}>
                                            <CheckCircle2 size={12} /> Ready — no download required.
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <>
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

                            <div className="ai-local-upload-card" style={{ marginTop: 12 }}>
                                <div className="ai-card-title ai-card-title--sub">
                                    <Upload size={13} /> Local fine-tuned bundle
                                </div>
                                <p className="ai-field-hint">
                                    Zip must be a <strong>Transformers.js–compatible ONNX</strong> tree (e.g. export
                                    from a fine-tuned Mistral with Optimum; same file layout as huggingface.co
                                    model repos). An uploaded zip <em>overrides</em> the HF id below for Load.
                                </p>
                                <input
                                    ref={onnxZipInputRef}
                                    type="file"
                                    accept=".zip,application/zip"
                                    className="ai-file-input-hidden"
                                    onChange={handleOnnxZipChange}
                                />
                                <div className="ai-local-upload-row">
                                    <button
                                        type="button"
                                        className="ai-btn ai-btn-ghost"
                                        onClick={() => onnxZipInputRef.current?.click()}
                                        disabled={isLoading}
                                    >
                                        <Upload size={14} /> ONNX zip…
                                    </button>
                                    {onnxZipName ? (
                                        <span className="ai-local-upload-name" title={onnxZipName}>
                                            {onnxZipName}
                                        </span>
                                    ) : (
                                        <span className="ai-field-hint">None</span>
                                    )}
                                    {onnxZipName && (
                                        <button
                                            type="button"
                                            className="ai-inline-link"
                                            onClick={handleClearOnnxUpload}
                                            disabled={isLoading}
                                        >
                                            Clear
                                        </button>
                                    )}
                                </div>
                                <input
                                    ref={ragJsonInputRef}
                                    type="file"
                                    accept=".json,application/json"
                                    className="ai-file-input-hidden"
                                    onChange={handleRagJsonChange}
                                />
                                <label className="ai-field-label" style={{ marginTop: 8 }}>
                                    RAG corpus (BM25 JSON)
                                </label>
                                <div className="ai-local-upload-row">
                                    <button
                                        type="button"
                                        className="ai-btn ai-btn-ghost"
                                        onClick={() => ragJsonInputRef.current?.click()}
                                        disabled={isLoading}
                                    >
                                        <FileJson size={14} /> rag-bundle.json…
                                    </button>
                                    {ragBundleName ? (
                                        <span className="ai-local-upload-name" title={ragBundleName}>
                                            {ragBundleName}
                                        </span>
                                    ) : (
                                        <span className="ai-field-hint">Bundled app docs</span>
                                    )}
                                    {ragBundleName && (
                                        <button
                                            type="button"
                                            className="ai-inline-link"
                                            onClick={handleClearRagUpload}
                                            disabled={isLoading}
                                        >
                                            Clear
                                        </button>
                                    )}
                                </div>
                                <p className="ai-field-hint">
                                    Retrieval chunks: <strong>{kbChunkCount}</strong>
                                    {ragBundleName ? ' · uploaded corpus' : ''}
                                </p>
                            </div>

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
                                disabled={
                                    isLoading ||
                                    isGenerating ||
                                    (!uploadedOnnxFilesRef.current &&
                                        !currentModelId)
                                }
                                style={{ marginTop: 12 }}
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 size={14} className="ai-spin" />{' '}
                                        {onnxZipName ? 'Loading…' : 'Downloading…'}
                                    </>
                                ) : isLoaded ? (
                                    <>
                                        <CheckCircle2 size={14} /> Reload
                                    </>
                                ) : onnxZipName ? (
                                    <>
                                        <Upload size={14} /> Load uploaded ONNX
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
                                </>
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
                                {status === 'idle' && (
                                    <>
                                        <Cpu size={12} />{' '}
                                        {isGeminiBackend && !effectiveGeminiKey
                                            ? 'Waiting for Gemini API key'
                                            : 'Idle'}
                                    </>
                                )}
                                {status === 'loading' && <><Loader2 size={12} className="ai-spin" /> Loading model…</>}
                                {status === 'ready' && (
                                    <>
                                        <CheckCircle2 size={12} /> Ready · {loadedModelId.split('/').pop()}
                                        {isGeminiBackend && <span className="ai-status-sub"> · cloud</span>}
                                    </>
                                )}
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
                                isGeminiBackend ? (
                                    <>
                                        <Zap size={11} /> {geminiModel} · Gemini API
                                    </>
                                ) : (
                                    <>
                                        <Cpu size={11} /> {loadedModelId.split('/').pop()} · {device} · {dtype}
                                    </>
                                )
                            ) : isGeminiBackend ? (
                                <>Add your Gemini API key in the sidebar to start chatting.</>
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
                                {isLoaded
                                    ? 'Ask anything.'
                                    : isGeminiBackend
                                      ? 'Add your Gemini API key to start chatting.'
                                      : 'Load a model to start chatting.'}
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
                                : isGeminiBackend
                                  ? 'Add Gemini API key in sidebar…'
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
                    {content
                        ? (isUser
                            ? content
                            : <MarkdownContent text={content} />)
                        : (streaming ? (
                            <em className="ai-msg-wait">
                                {waitingNote || 'thinking…'}
                            </em>
                        ) : '')}
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

/* ---------------- LaTeX → Unicode math transform ----------------
   We don't want to ship KaTeX (300KB+) just for inline math. Instead
   we convert LaTeX math delimiters (\(…\), \[…\], $…$) to readable
   Unicode on the fly. Handles the common cases our models produce:
   Greek letters, ×/·/±/→/≤/≥/≈/∞, \text{}/\mathrm{} wrappers,
   \bar/\hat/\vec accents, _{sub}/^{sup}/\frac{a}{b}, etc. */

const GREEK_MAP = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
    varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
    iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
    xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ',
    varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
    upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε',
    Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ',
    Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο',
    Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ',
    Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
};
const SYMBOL_MAP = {
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
    mapsto: '↦', implies: '⇒', iff: '⇔',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', ne: '≠', neq: '≠',
    approx: '≈', sim: '∼', simeq: '≃', cong: '≅', equiv: '≡',
    propto: '∝', infty: '∞', partial: '∂', nabla: '∇',
    int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    sum: '∑', prod: '∏', sqrt: '√',
    cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
    forall: '∀', exists: '∃', in: '∈', notin: '∉', subset: '⊂',
    supset: '⊃', subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩',
    emptyset: '∅', varnothing: '∅',
    deg: '°', angle: '∠', perp: '⊥', parallel: '∥',
    prime: '′', dagger: '†', star: '⋆', ast: '∗',
    left: '', right: '', big: '', Big: '', bigg: '', Bigg: '',
};
const SUB_MAP = {
    0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ',
    m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ',
    u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};
const SUP_MAP = {
    0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
    a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ',
    h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ',
    o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ',
    w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};

function convertSubSup(chars, map) {
    let out = '';
    for (const ch of chars) {
        const mapped = map[ch];
        if (!mapped) return null;
        out += mapped;
    }
    return out;
}

function formatMathInner(raw) {
    let s = String(raw || '');
    // Strip comment-like %
    s = s.replace(/(^|[^\\])%.*$/gm, '$1');
    // Styling wrappers → keep content only
    s = s.replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|boldsymbol|operatorname)\s*\{([^{}]*)\}/g, '$1');
    // Accents → drop the accent, keep the base
    s = s.replace(/\\(?:bar|hat|vec|tilde|dot|ddot|overline|underline|overrightarrow)\s*\{([^{}]*)\}/g, '$1');
    s = s.replace(/\\(?:bar|hat|vec|tilde|dot|ddot)\s+([A-Za-z])/g, '$1');
    // \frac{a}{b} → (a/b) — non-recursive, handles the common cases
    for (let i = 0; i < 3; i++) {
        const next = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1/$2)');
        if (next === s) break;
        s = next;
    }
    // \sqrt{x} → √(x); \sqrt[n]{x} → ⁿ√(x)
    s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_, n, x) => `${convertSubSup(n, SUP_MAP) || `^${n}`}√(${x})`);
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
    // Named commands → symbol / greek
    s = s.replace(/\\([A-Za-z]+)\s*/g, (match, cmd) => {
        if (GREEK_MAP[cmd]) return GREEK_MAP[cmd];
        if (cmd in SYMBOL_MAP) return SYMBOL_MAP[cmd];
        return match;
    });
    // Subscripts & superscripts with braces
    s = s.replace(/_\{([^{}]*)\}/g, (_, inner) => convertSubSup(inner, SUB_MAP) ?? `_(${inner})`);
    s = s.replace(/\^\{([^{}]*)\}/g, (_, inner) => convertSubSup(inner, SUP_MAP) ?? `^(${inner})`);
    // Single-char _x / ^x
    s = s.replace(/_([A-Za-z0-9+\-=()])/g, (_, c) => SUB_MAP[c] ?? `_${c}`);
    s = s.replace(/\^([A-Za-z0-9+\-=()])/g, (_, c) => SUP_MAP[c] ?? `^${c}`);
    // Cleanup: unescape \{ \} \$ \% \_ \# \&
    s = s.replace(/\\([{}$%_#&])/g, '$1');
    // Remove remaining stray backslashes in front of words (unrecognised cmds)
    s = s.replace(/\\([A-Za-z]+)/g, '$1');
    // Collapse any double spaces we introduced
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

function convertLatexToUnicode(text) {
    if (!text) return text;
    let s = String(text);
    // Display math \[ ... \]
    s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => formatMathInner(inner));
    // Inline math \( ... \)
    s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => formatMathInner(inner));
    // Block math $$ ... $$
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => formatMathInner(inner));
    // Inline math $ ... $  (kept conservative: no newline inside, so prose
    // dollar signs in unrelated text don't get eaten)
    s = s.replace(/\$([^\n$]+?)\$/g, (_, inner) => formatMathInner(inner));
    return s;
}

/* ---------------- Lightweight Markdown renderer ----------------
   Renders the small Markdown subset our agent produces: headings
   (## / ###), bullet & numbered lists, fenced code blocks, inline
   bold (**…**), italics (*…* / _…_), inline code (`…`), and links.
   Done by hand so we don't pull in a 100KB dep just for chat. */

function renderInline(text) {
    const out = [];
    let key = 0;
    const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\n]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const tok = m[0];
        if (tok.startsWith('**')) {
            out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
        } else if (tok.startsWith('`')) {
            out.push(<code key={key++} className="ai-md-code">{tok.slice(1, -1)}</code>);
        } else if (tok.startsWith('[')) {
            const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
            if (linkMatch) {
                out.push(
                    <a
                        key={key++}
                        className="ai-md-link"
                        href={linkMatch[2]}
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        {linkMatch[1]}
                    </a>
                );
            } else {
                out.push(tok);
            }
        } else {
            // *italic* or _italic_
            out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
        }
        last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

function MarkdownContent({ text }) {
    const blocks = useMemo(() => {
        /* Run the LaTeX → Unicode pass BEFORE block parsing so math
           appears as readable symbols inside paragraphs, bullets,
           and headings alike. Fenced code blocks are re-extracted
           below and the transform inside them gets reverted. */
        const src = convertLatexToUnicode(String(text || ''));
        const lines = src.split('\n');
        const out = [];
        let para = [];
        let list = null;        // { type: 'ul'|'ol', items: [] }
        let code = null;        // { lang, lines: [] }

        const flushPara = () => {
            if (para.length) {
                out.push({ type: 'p', text: para.join(' ') });
                para = [];
            }
        };
        const flushList = () => {
            if (list) {
                out.push({ type: list.type, items: list.items });
                list = null;
            }
        };

        for (const raw of lines) {
            const line = raw.replace(/\s+$/, '');

            // Fenced code block
            const fence = /^```(\w+)?\s*$/.exec(line);
            if (code) {
                if (fence) {
                    out.push({ type: 'code', lang: code.lang, text: code.lines.join('\n') });
                    code = null;
                } else {
                    code.lines.push(raw);
                }
                continue;
            }
            if (fence) {
                flushPara(); flushList();
                code = { lang: fence[1] || '', lines: [] };
                continue;
            }

            // Blank line — paragraph / list separator
            if (!line.trim()) {
                flushPara();
                flushList();
                continue;
            }

            // Headings
            const h = /^(#{1,4})\s+(.+)$/.exec(line);
            if (h) {
                flushPara(); flushList();
                out.push({ type: `h${h[1].length}`, text: h[2] });
                continue;
            }

            // Horizontal rule
            if (/^---+$/.test(line.trim())) {
                flushPara(); flushList();
                out.push({ type: 'hr' });
                continue;
            }

            // Unordered list
            const ul = /^[-•*]\s+(.+)$/.exec(line.trim());
            if (ul) {
                flushPara();
                if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
                list.items.push(ul[1]);
                continue;
            }

            // Ordered list
            const ol = /^(\d+)\.\s+(.+)$/.exec(line.trim());
            if (ol) {
                flushPara();
                if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
                list.items.push(ol[2]);
                continue;
            }

            // Plain paragraph line
            flushList();
            para.push(line.trim());
        }
        if (code) out.push({ type: 'code', lang: code.lang, text: code.lines.join('\n') });
        flushPara();
        flushList();
        return out;
    }, [text]);

    return (
        <div className="ai-md">
            {blocks.map((b, i) => {
                switch (b.type) {
                    case 'h1':
                        return <h2 key={i} className="ai-md-h1">{renderInline(b.text)}</h2>;
                    case 'h2':
                        return <h3 key={i} className="ai-md-h2">{renderInline(b.text)}</h3>;
                    case 'h3':
                    case 'h4':
                        return <h4 key={i} className="ai-md-h3">{renderInline(b.text)}</h4>;
                    case 'p':
                        return <p key={i} className="ai-md-p">{renderInline(b.text)}</p>;
                    case 'ul':
                        return (
                            <ul key={i} className="ai-md-ul">
                                {b.items.map((it, j) => (
                                    <li key={j}>{renderInline(it)}</li>
                                ))}
                            </ul>
                        );
                    case 'ol':
                        return (
                            <ol key={i} className="ai-md-ol">
                                {b.items.map((it, j) => (
                                    <li key={j}>{renderInline(it)}</li>
                                ))}
                            </ol>
                        );
                    case 'code':
                        return (
                            <pre key={i} className="ai-md-pre">
                                <code className={`ai-md-pre-code lang-${b.lang || 'text'}`}>
                                    {b.text}
                                </code>
                            </pre>
                        );
                    case 'hr':
                        return <hr key={i} className="ai-md-hr" />;
                    default:
                        return null;
                }
            })}
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
