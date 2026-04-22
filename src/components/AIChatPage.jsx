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
} from 'lucide-react';
import './AIChatPage.css';

/* ------------------------------------------------------------------ */
/* Curated models — all hosted on the HF hub as ONNX, known to work   */
/* with @huggingface/transformers v4 `text-generation` pipeline.      */
/*                                                                     */
/* Users can still type any HF model id in the "Custom model" field.  */
/* ------------------------------------------------------------------ */
const CURATED_MODELS = [
    {
        id: 'onnx-community/gemma-3-270m-it-ONNX',
        label: 'Gemma 3 270M · Instruct',
        family: 'Gemma',
        size: '~230 MB',
        dtype: 'q4',
        description: 'Google Gemma 3 ultra-small. Fast on CPU, instant on WebGPU.',
    },
    {
        id: 'onnx-community/gemma-3-1b-it-ONNX',
        label: 'Gemma 3 1B · Instruct',
        family: 'Gemma',
        size: '~800 MB',
        dtype: 'q4',
        description: 'Google Gemma 3 1B. Great general quality. WebGPU recommended.',
    },
    {
        id: 'onnx-community/Qwen2.5-0.5B-Instruct',
        label: 'Qwen 2.5 0.5B · Instruct',
        family: 'Qwen',
        size: '~380 MB',
        dtype: 'q4',
        description: 'Alibaba Qwen 2.5 — strong reasoning for its size.',
    },
    {
        id: 'onnx-community/Llama-3.2-1B-Instruct',
        label: 'Llama 3.2 1B · Instruct',
        family: 'Llama',
        size: '~800 MB',
        dtype: 'q4',
        description: 'Meta Llama 3.2 1B. Versatile general-purpose chat.',
    },
    {
        id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
        label: 'SmolLM2 360M · Instruct',
        family: 'SmolLM',
        size: '~290 MB',
        dtype: 'q4',
        description: 'HuggingFaceTB SmolLM2 — tiny, snappy, surprisingly capable.',
    },
    {
        id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
        label: 'SmolLM2 1.7B · Instruct',
        family: 'SmolLM',
        size: '~1.4 GB',
        dtype: 'q4',
        description: 'HuggingFaceTB SmolLM2 1.7B — best SmolLM quality tier.',
    },
    {
        id: 'onnx-community/Phi-3.5-mini-instruct-onnx-web',
        label: 'Phi-3.5 mini · Instruct',
        family: 'Phi',
        size: '~2.2 GB',
        dtype: 'q4f16',
        description: 'Microsoft Phi-3.5 mini — strong reasoning. WebGPU + fp16 strongly recommended.',
    },
];

const DTYPE_OPTIONS = [
    { value: 'q4', label: 'q4 (4-bit · smallest)' },
    { value: 'q4f16', label: 'q4f16 (4-bit · fp16 · WebGPU)' },
    { value: 'q8', label: 'q8 (8-bit)' },
    { value: 'fp16', label: 'fp16 (WebGPU)' },
    { value: 'fp32', label: 'fp32 (full precision)' },
];

const DEFAULT_SYSTEM_PROMPT = 'You are NozeAssistant, a concise, helpful assistant embedded inside NozePlot. Prefer clear, accurate, data-aware answers. If a user asks about sensor or aroma data that you cannot see, say so and explain what they would need to share.';

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
                    break;
                case 'token':
                    setStreamingText((prev) => prev + (msg.text || ''));
                    break;
                case 'complete':
                    finalizeAssistantMessage(msg.text, msg.stats);
                    break;
                case 'stopped':
                    finalizeAssistantMessage('', null, true);
                    break;
                case 'error':
                    setErrorMsg(String(msg.message || 'Unknown error'));
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

    /* ============ Persistence ============ */
    useEffect(() => { saveLS(LS_MODEL, selectedModel); }, [selectedModel]);
    useEffect(() => { saveLS(LS_CUSTOM, customModel); }, [customModel]);
    useEffect(() => { saveLS(LS_DEVICE, device); }, [device]);
    useEffect(() => { saveLS(LS_DTYPE, dtype); }, [dtype]);
    useEffect(() => { saveLS(LS_PARAMS, params); }, [params]);
    useEffect(() => { saveLS(LS_SYSTEM, systemPrompt); }, [systemPrompt]);
    useEffect(() => { saveLS(LS_CHATS, conversations); }, [conversations]);
    useEffect(() => { saveLS(LS_ACTIVE_CHAT, activeChatId); }, [activeChatId]);

    /* ============ Ensure an active chat ============ */
    useEffect(() => {
        if (!activeChat && conversations.length) {
            setActiveChatId(conversations[0].id);
        }
    }, [activeChat, conversations]);

    /* ============ Auto-scroll to latest message ============ */
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
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

    const finalizeAssistantMessage = useCallback((finalText, stats, wasStopped = false) => {
        setStreamingText('');
        setLastStats(stats || null);
        setConversations((prev) =>
            prev.map((c) => {
                if (c.id !== activeChatId) return c;
                const msgs = [...c.messages];
                // We already appended a placeholder assistant at send time.
                // Replace its content with the final text (using streamingText
                // is less reliable when the run ended without a 'complete').
                const lastIdx = msgs.length - 1;
                if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].streaming) {
                    msgs[lastIdx] = {
                        ...msgs[lastIdx],
                        content: finalText || msgs[lastIdx].content || (wasStopped ? '⏹ stopped' : ''),
                        streaming: false,
                        stats: stats || null,
                        stopped: wasStopped,
                    };
                }
                return { ...c, messages: msgs, updatedAt: Date.now() };
            })
        );
    }, [activeChatId]);

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

        // Build full message list: system + chat history + new user turn.
        const history = activeChat?.messages || [];
        const newUserMsg = { role: 'user', content: text, ts: Date.now() };
        const newAssistantMsg = {
            role: 'assistant',
            content: '',
            streaming: true,
            ts: Date.now(),
        };

        setConversations((prev) =>
            prev.map((c) => {
                if (c.id !== activeChatId) return c;
                const msgs = [...c.messages, newUserMsg, newAssistantMsg];
                const title =
                    c.title === 'New chat' || !c.title
                        ? text.slice(0, 40)
                        : c.title;
                return { ...c, messages: msgs, title, modelId: currentModelId, updatedAt: Date.now() };
            })
        );

        const payload = [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            ...history.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: text },
        ];

        workerRef.current?.postMessage({
            type: 'generate',
            messages: payload,
            params,
        });
    }, [input, isLoaded, isGenerating, activeChat, activeChatId, systemPrompt, params, currentModelId]);

    const handleStop = useCallback(() => {
        workerRef.current?.postMessage({ type: 'stop' });
    }, []);

    const handleNewChat = useCallback(() => {
        const chat = newConversation(currentModelId);
        setConversations((prev) => [chat, ...prev]);
        setActiveChatId(chat.id);
        setStreamingText('');
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
        setConversations((prev) =>
            prev.map((c) =>
                c.id === activeChatId
                    ? { ...c, messages: [], title: 'New chat', updatedAt: Date.now() }
                    : c
            )
        );
        setStreamingText('');
    }, [activeChatId]);

    // When the user switches model via dropdown, auto-fill the recommended dtype.
    const handleSelectModel = useCallback((id) => {
        setSelectedModel(id);
        setCustomModel('');
        const meta = CURATED_MODELS.find((m) => m.id === id);
        if (meta?.dtype) setDtype(meta.dtype);
    }, []);

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
                                {CURATED_MODELS.map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {m.label} · {m.size}
                                    </option>
                                ))}
                            </select>
                            {currentModelMeta && !customModel.trim() && (
                                <p className="ai-field-hint">{currentModelMeta.description}</p>
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
                                        onChange={(e) => setDevice(e.target.value)}
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

                            {/* Status line */}
                            <div className="ai-status-line" data-status={status}>
                                {status === 'idle' && <><Cpu size={12} /> Idle</>}
                                {status === 'loading' && <><Loader2 size={12} className="ai-spin" /> Loading model…</>}
                                {status === 'ready' && <><CheckCircle2 size={12} /> Ready · {loadedModelId.split('/').pop()}</>}
                                {status === 'generating' && <><Zap size={12} /> Generating…</>}
                                {errorMsg && (
                                    <div className="ai-status-err">
                                        <AlertTriangle size={12} /> {errorMsg}
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

                        {/* ===== System prompt ===== */}
                        <div className="ai-card">
                            <button
                                type="button"
                                className="ai-card-title ai-card-toggle"
                                onClick={() => setSystemOpen((v) => !v)}
                            >
                                {systemOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <Bot size={14} /> System prompt
                            </button>
                            {systemOpen && (
                                <textarea
                                    className="ai-textarea ai-textarea--system"
                                    rows={5}
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
                                        onClick={() => setActiveChatId(c.id)}
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
                            disabled={!activeMessages.length || isGenerating}
                            title="Clear this chat"
                        >
                            <RefreshCw size={13} /> Clear
                        </button>
                    </div>
                </header>

                <div className="ai-scroll" ref={scrollRef}>
                    {activeMessages.length === 0 && (
                        <div className="ai-empty">
                            <div className="ai-empty-badge"><Brain size={28} /></div>
                            <h2>Run powerful open models locally</h2>
                            <p>
                                Download any Hugging Face ONNX chat-instruct model (Gemma, Llama, Qwen, Phi, SmolLM…) and
                                run it <strong>entirely in your browser</strong>. Models are cached after the first download,
                                so everything stays available — and private — on your machine.
                            </p>
                            <div className="ai-empty-tips">
                                <Tip icon={<Zap size={13} />} title="WebGPU acceleration">
                                    Use the Device selector to flip between WebGPU (fastest) and WASM (CPU fallback).
                                </Tip>
                                <Tip icon={<Download size={13} />} title="Persisted downloads">
                                    First run downloads the weights to your browser cache. Subsequent loads are near-instant.
                                </Tip>
                                <Tip icon={<Bot size={13} />} title="Multi-tasking">
                                    The chat keeps running while you work elsewhere in NozePlot — flow sims, analysis, ML Studio.
                                </Tip>
                            </div>
                        </div>
                    )}
                    {activeMessages.map((m, i) => (
                        <MessageBubble
                            key={i}
                            role={m.role}
                            content={m.content}
                            streaming={m.streaming}
                            stopped={m.stopped}
                        />
                    ))}
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
        </div>
    );
}

/* -------------------- Sub-components -------------------- */

function MessageBubble({ role, content, streaming, stopped }) {
    const isUser = role === 'user';
    return (
        <div className={`ai-msg ai-msg--${role}`}>
            <div className="ai-msg-avatar">
                {isUser ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className="ai-msg-body">
                <div className="ai-msg-role">{isUser ? 'You' : 'Assistant'}</div>
                <div className={`ai-msg-content ${streaming ? 'ai-msg-content--streaming' : ''}`}>
                    {content || (streaming ? <em className="ai-msg-wait">thinking…</em> : '')}
                    {streaming && <span className="ai-msg-caret" />}
                </div>
                {stopped && <div className="ai-msg-stopped">⏹ stopped</div>}
            </div>
        </div>
    );
}

function Tip({ icon, title, children }) {
    return (
        <div className="ai-tip">
            <div className="ai-tip-head">{icon} <strong>{title}</strong></div>
            <div className="ai-tip-body">{children}</div>
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
