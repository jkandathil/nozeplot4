import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronLeft, ChevronRight, Loader2, Send, Sparkles, Square, Trash2 } from 'lucide-react';
import { buildAugmentedSystemPrompt } from '../ai/kb/knowledgeBase.js';
import {
    packHistory,
    buildRetrievalQuery,
    computeHistoryBudget,
    sanitizeHistory,
} from '../ai/chatContext.js';
import {
    DEFAULT_GEMINI_MODEL,
    normalizeGeminiModelId,
    resolveGeminiApiKey,
    streamGeminiChat,
} from '../ai/geminiChat.js';
import { CURATED_MODELS } from '../ai/curatedChatModels.js';
import { renderMarkdown } from '../utils/miniMarkdown.jsx';
import { CODES_WORKSPACE_FOLDER_NAME } from '../utils/workspaceFilename.js';

const LS_MODEL = 'ai-chat:selected-model';
const LS_CUSTOM = 'ai-chat:custom-model';
const LS_DEVICE = 'ai-chat:device';
const LS_DTYPE = 'ai-chat:dtype';
const LS_PARAMS = 'ai-chat:params:v3';
const LS_SYSTEM = 'ai-chat:system-prompt:v3';
const LS_KB_ENABLED = 'ai-chat:kb-enabled';
const LS_BACKEND = 'ai-chat:backend';
const LS_GEMINI_KEY = 'ai-chat:gemini-api-key';
const LS_GEMINI_MODEL = 'ai-chat:gemini-model';

const BACKEND_LOCAL = 'local';
const BACKEND_GEMINI = 'gemini';

const DEFAULT_KB_BUDGET = 2400;
const DEFAULT_KB_K = 4;

const FALLBACK_SYSTEM_PROMPT = [
    'You are NozeAssistant, embedded in NozePlot Code Studio.',
    'Help with code, debugging, Pyodide / browser Python limits, and NozePlot workspace questions.',
    'Use Markdown; use fenced code blocks with a language tag for any multi-line code.',
    'Be concise and practical.',
].join('\n');

const CODE_STUDIO_INSTRUCTIONS = [
    '## Code Studio context',
    `You are assisting inside **Code Studio**. User scripts live in the workspace folder **${CODES_WORKSPACE_FOLDER_NAME}**.`,
    '- Python runs in the **browser via Pyodide** (not CPython on the server). `pip` is not available; use **micropip** for pure-Python wheels compatible with Pyodide.',
    '- `time.sleep` is bridged so short sleeps yield; prefer small sleeps for responsiveness.',
    '- When suggesting changes, prefer **complete** minimal snippets the user can paste, and mention the file name when relevant.',
].join('\n');

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

/** Snapshot of AI Agents settings (read fresh so same-tab changes apply on send). */
function readAllPrefs() {
    const backend = loadLS(LS_BACKEND, BACKEND_LOCAL);
    const selectedModel = loadLS(LS_MODEL, CURATED_MODELS[0].id);
    const customModel = loadLS(LS_CUSTOM, '');
    const currentModelId = customModel.trim() || selectedModel;
    const currentModelMeta = CURATED_MODELS.find((m) => m.id === currentModelId) || null;
    const params = {
        max_new_tokens: 500,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 50,
        repetition_penalty: 1.08,
        no_repeat_ngram_size: 0,
        ...loadLS(LS_PARAMS, {}),
    };
    const systemPrompt = loadLS(LS_SYSTEM, '') || FALLBACK_SYSTEM_PROMPT;
    const useKnowledgeBase = loadLS(LS_KB_ENABLED, 'true') !== 'false';
    const geminiModel = normalizeGeminiModelId(loadLS(LS_GEMINI_MODEL, DEFAULT_GEMINI_MODEL));
    const geminiKeyInput = loadLS(LS_GEMINI_KEY, '');
    const effectiveGeminiKey = resolveGeminiApiKey(geminiKeyInput);
    const isGeminiBackend = backend === BACKEND_GEMINI;
    const device = loadLS(LS_DEVICE, 'webgpu');
    const dtype = loadLS(LS_DTYPE, 'q4');
    return {
        backend,
        isGeminiBackend,
        currentModelId,
        currentModelMeta,
        params,
        systemPrompt,
        useKnowledgeBase,
        geminiModel,
        effectiveGeminiKey,
        device,
        dtype,
    };
}

function clip(s, max) {
    const t = String(s || '');
    if (t.length <= max) return t;
    return `${t.slice(0, max)}\n\n… [truncated]`;
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

function applyLocalParamTiers(params, tier, isAppFeatureQuestion) {
    const clamp = (v, ceil) => (v == null ? ceil : Math.min(v, ceil));
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
    return effectiveParams;
}

function buildEditorContextBlock({ fileName, language, code, output, isCloud }) {
    const maxCode = isCloud ? 56000 : 10000;
    const body = clip(code || '', maxCode);
    const fenceLang = language === 'python' ? 'python' : 'text';
    const out = output?.trim()
        ? `\n\n### Last run output (excerpt)\n\`\`\`text\n${clip(output, 4000)}\n\`\`\``
        : '';
    return [
        '## Active editor',
        `- **File:** ${fileName || '(untitled)'}`,
        `- **Language:** ${language}`,
        '',
        `### Contents (\`${fenceLang}\`)`,
        '```' + fenceLang,
        body,
        '```',
        out,
    ].join('\n');
}

/**
 * @param {object} props
 * @param {string} props.fileName
 * @param {string} props.language
 * @param {() => string} props.getCode
 * @param {() => string} [props.getOutput]
 */
export default function CodeStudioAiPanel({ fileName, language, getCode, getOutput }) {
    const [collapsed, setCollapsed] = useState(false);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [streamingText, setStreamingText] = useState('');
    const [busy, setBusy] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [workerStatus, setWorkerStatus] = useState('idle');
    const [loadedModelId, setLoadedModelId] = useState('');
    const workerRef = useRef(null);
    const abortRef = useRef(null);
    const scrollRef = useRef(null);
    const messagesRef = useRef([]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const [settingsTick, setSettingsTick] = useState(0);

    useEffect(() => {
        const bump = () => setSettingsTick((t) => t + 1);
        window.addEventListener('focus', bump);
        window.addEventListener('storage', bump);
        return () => {
            window.removeEventListener('focus', bump);
            window.removeEventListener('storage', bump);
        };
    }, []);

    useEffect(() => {
        const id = setInterval(() => setSettingsTick((t) => t + 1), 3000);
        return () => clearInterval(id);
    }, []);

    const prefs = useMemo(() => readAllPrefs(), [settingsTick]);

    const isLoaded = prefs.isGeminiBackend
        ? !!prefs.effectiveGeminiKey
        : !!loadedModelId &&
          loadedModelId === prefs.currentModelId &&
          workerStatus !== 'loading';

    useEffect(() => {
        if (!prefs.isGeminiBackend) return;
        if (prefs.effectiveGeminiKey) {
            setWorkerStatus('ready');
            setLoadedModelId(`gemini/${prefs.geminiModel}`);
        } else {
            setWorkerStatus('idle');
            setLoadedModelId('');
        }
    }, [prefs.isGeminiBackend, prefs.effectiveGeminiKey, prefs.geminiModel]);

    useEffect(() => {
        if (prefs.isGeminiBackend) return;
        const w = new Worker(new URL('../ai/aiChatWorker.js', import.meta.url), { type: 'module' });
        workerRef.current = w;
        w.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            switch (msg.type) {
                case 'status':
                    setWorkerStatus(msg.status);
                    break;
                case 'ready':
                    setLoadedModelId(msg.modelId);
                    setWorkerStatus('ready');
                    break;
                case 'token':
                    setStreamingText((prev) => prev + (msg.text || ''));
                    break;
                case 'complete': {
                    const text = msg.text || '';
                    setStreamingText('');
                    setBusy(false);
                    setMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant' && last.streaming) {
                            next[next.length - 1] = {
                                ...last,
                                content: text || last.content,
                                streaming: false,
                            };
                        }
                        return next;
                    });
                    setWorkerStatus('ready');
                    break;
                }
                case 'stopped':
                    setStreamingText('');
                    setBusy(false);
                    setMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant' && last.streaming) {
                            next[next.length - 1] = {
                                ...last,
                                content: last.content || '⏹ stopped',
                                streaming: false,
                            };
                        }
                        return next;
                    });
                    setWorkerStatus('ready');
                    break;
                case 'error':
                    setErrorMsg(String(msg.message || 'Model error'));
                    setStreamingText('');
                    setBusy(false);
                    setMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant' && last.streaming) {
                            next[next.length - 1] = {
                                ...last,
                                content: `**Error:** ${String(msg.message || 'Unknown')}`,
                                streaming: false,
                            };
                        }
                        return next;
                    });
                    setWorkerStatus('ready');
                    break;
                default:
                    break;
            }
        };
        const { currentModelId, device, dtype } = prefs;
        if (currentModelId) {
            setWorkerStatus('loading');
            w.postMessage({ type: 'load', modelId: currentModelId, device, dtype });
        }
        return () => {
            try {
                w.terminate();
            } catch {
                /* ignore */
            }
            workerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reload model when HF settings change
    }, [
        prefs.isGeminiBackend,
        prefs.currentModelId,
        prefs.device,
        prefs.dtype,
    ]);

    useEffect(() => {
        if (!streamingText) return;
        setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant' && last.streaming) {
                next[next.length - 1] = { ...last, content: streamingText };
            }
            return next;
        });
    }, [streamingText]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages, streamingText]);

    const handleStop = useCallback(() => {
        const p = readAllPrefs();
        if (p.isGeminiBackend && abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
            setBusy(false);
            return;
        }
        workerRef.current?.postMessage({ type: 'stop' });
    }, []);

    const handleClear = useCallback(() => {
        handleStop();
        setMessages([]);
        setStreamingText('');
        setErrorMsg('');
    }, [handleStop]);

    const handleSend = useCallback(async () => {
        const text = input.trim();
        if (!text || busy) return;

        const p = readAllPrefs();
        const loadedOk = p.isGeminiBackend
            ? !!p.effectiveGeminiKey
            : !!loadedModelId &&
              loadedModelId === p.currentModelId &&
              workerStatus !== 'loading';

        if (!loadedOk) {
            setErrorMsg(
                p.isGeminiBackend
                    ? 'Add your Cloud API key under AI Agents (or VITE_GEMINI_API_KEY at build time).'
                    : 'Local model is still loading — wait for the worker to finish, or open AI Agents and pick a smaller model.'
            );
            return;
        }

        const code = getCode?.() ?? '';
        const output = getOutput?.() ?? '';
        const snapshot = buildEditorContextBlock({
            fileName,
            language,
            code,
            output,
            isCloud: p.isGeminiBackend,
        });

        let effectiveSystem = [p.systemPrompt, CODE_STUDIO_INSTRUCTIONS].join('\n\n');
        let usedSources = [];
        const history = messagesRef.current;

        if (p.useKnowledgeBase) {
            const retrievalQuery = buildRetrievalQuery(text, history);
            const recentUserTurns = history
                .filter((m) => m.role === 'user')
                .slice(-2)
                .map((m) => m.content);
            const { prompt, sources } = buildAugmentedSystemPrompt({
                userSystem: effectiveSystem,
                query: retrievalQuery,
                history: recentUserTurns,
                budgetChars: DEFAULT_KB_BUDGET,
                k: DEFAULT_KB_K,
                modelTier: p.isGeminiBackend ? 'great' : (p.currentModelMeta?.quality || 'good'),
                ragStyle: p.isGeminiBackend ? 'cloud' : 'local',
            });
            effectiveSystem = prompt;
            usedSources = sources;
        }

        const isLikelyAppQuestion = looksLikeNozePlotQuestion(text);
        const topSourceScore = usedSources.length ? (usedSources[0].score || 0) : 0;
        const hasStrongGrounding = usedSources.length > 0 && topSourceScore >= 1.6;
        const isUngroundedAppQuestion = p.useKnowledgeBase && isLikelyAppQuestion && !hasStrongGrounding;

        if (isUngroundedAppQuestion) {
            setInput('');
            setErrorMsg('');
            setMessages((prev) => [
                ...prev,
                { role: 'user', content: text, ts: Date.now() },
                {
                    role: 'assistant',
                    content: [
                        'I can help, but I cannot verify that from the app knowledge loaded right now.',
                        'Please ask with the exact tab or page name (e.g. Flow Lab, SE Analysis), or ask a coding question about your open file.',
                    ].join(' '),
                    ts: Date.now(),
                    streaming: false,
                },
            ]);
            return;
        }

        effectiveSystem = [effectiveSystem, snapshot].join('\n\n');

        const priorTurns = sanitizeHistory(history);
        if (priorTurns.length > 0) {
            effectiveSystem = [
                effectiveSystem,
                '',
                '## Conversation memory',
                'Earlier turns in this Code Studio chat are authoritative for follow-ups.',
            ].join('\n');
        }

        const isAppFeatureQuestion = p.useKnowledgeBase && usedSources.length > 0;
        if (isAppFeatureQuestion) {
            effectiveSystem = [
                effectiveSystem,
                '',
                'When answering NozePlot UI questions: short, practical steps; plain English.',
            ].join('\n');
        }

        const budget = computeHistoryBudget({
            systemPromptChars: effectiveSystem.length,
            maxNewTokens: p.isGeminiBackend
                ? Math.min(p.params.max_new_tokens || 2048, 8192)
                : (p.params.max_new_tokens || 512),
            targetPromptTokens: p.isGeminiBackend ? 120000 : 3200,
        });
        const packed = packHistory(history, {
            budgetChars: budget,
            minKeepTurns: p.isGeminiBackend ? 8 : 3,
        });

        const payload = [
            ...(effectiveSystem ? [{ role: 'system', content: effectiveSystem }] : []),
            ...packed.messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: text },
        ];

        setInput('');
        setErrorMsg('');
        setStreamingText('');
        setMessages((prev) => [
            ...prev,
            { role: 'user', content: text, ts: Date.now() },
            { role: 'assistant', content: '', streaming: true, ts: Date.now() },
        ]);
        setBusy(true);

        if (p.isGeminiBackend) {
            const ac = new AbortController();
            abortRef.current = ac;
            try {
                const geminiParams = isAppFeatureQuestion
                    ? {
                          temperature: 0.2,
                          top_p: 0.9,
                          max_new_tokens: Math.min(p.params.max_new_tokens || 2048, 8192),
                      }
                    : {
                          temperature: p.params.temperature,
                          top_p: p.params.top_p,
                          max_new_tokens: Math.min(p.params.max_new_tokens || 2048, 8192),
                      };
                const result = await streamGeminiChat({
                    apiKey: p.effectiveGeminiKey,
                    model: p.geminiModel,
                    messages: payload,
                    params: geminiParams,
                    signal: ac.signal,
                    onChunk: (chunk) => setStreamingText((prev) => prev + chunk),
                });
                setStreamingText('');
                setMessages((prev) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (last?.role === 'assistant' && last.streaming) {
                        next[next.length - 1] = {
                            ...last,
                            content: result.text || '',
                            streaming: false,
                        };
                    }
                    return next;
                });
            } catch (err) {
                if (err?.name === 'AbortError') {
                    setMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant' && last.streaming) {
                            next[next.length - 1] = {
                                ...last,
                                content: last.content || '⏹ stopped',
                                streaming: false,
                            };
                        }
                        return next;
                    });
                } else {
                    const msg = err?.message || String(err);
                    setErrorMsg(msg);
                    setMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === 'assistant' && last.streaming) {
                            next[next.length - 1] = {
                                ...last,
                                content: `**Cloud API error:** ${msg}`,
                                streaming: false,
                            };
                        }
                        return next;
                    });
                }
            } finally {
                abortRef.current = null;
                setBusy(false);
            }
            return;
        }

        const tier = p.currentModelMeta?.quality || 'good';
        const effectiveParams = applyLocalParamTiers(p.params, tier, isAppFeatureQuestion);
        workerRef.current?.postMessage({
            type: 'generate',
            messages: payload,
            params: effectiveParams,
        });
    }, [
        input,
        busy,
        loadedModelId,
        workerStatus,
        fileName,
        language,
        getCode,
        getOutput,
    ]);

    const railBody = (
        <>
            <div className="code-studio-ai-head">
                <div className="code-studio-ai-head-title">
                    <Sparkles size={16} aria-hidden />
                    <span>Code assistant</span>
                </div>
                <div className="code-studio-ai-head-actions">
                    <button type="button" className="code-studio-ai-icon-btn" title="Clear chat" onClick={handleClear}>
                        <Trash2 size={15} />
                    </button>
                    <button
                        type="button"
                        className="code-studio-ai-icon-btn"
                        title={collapsed ? 'Expand' : 'Collapse'}
                        onClick={() => setCollapsed((c) => !c)}
                    >
                        {collapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
                    </button>
                </div>
            </div>
            <p className="code-studio-ai-hint">
                Uses the same backend and keys as <strong>AI Agents</strong> (Cloud API or local model). Each open page may load its own local model instance.
            </p>
            {errorMsg ? <div className="code-studio-ai-error">{errorMsg}</div> : null}
            <div className="code-studio-ai-messages" ref={scrollRef}>
                {messages.length === 0 ? (
                    <div className="code-studio-ai-empty">
                        <Bot size={28} aria-hidden />
                        <p>
                            Ask for refactors, bug fixes, or explanations. The <strong>open file</strong> and optional run output are sent with each message (truncated for very large files).
                        </p>
                    </div>
                ) : (
                    messages.map((m, i) => (
                        <div
                            key={m.ts ? `${m.ts}-${i}` : i}
                            className={`code-studio-ai-msg code-studio-ai-msg--${m.role}`}
                        >
                            {m.role === 'assistant' ? (
                                <div className="code-studio-ai-md">{renderMarkdown(m.content || (m.streaming ? '…' : ''))}</div>
                            ) : (
                                <div className="code-studio-ai-user">{m.content}</div>
                            )}
                        </div>
                    ))
                )}
            </div>
            <div className="code-studio-ai-input-row">
                <textarea
                    className="code-studio-ai-input"
                    rows={2}
                    placeholder="Ask about this file or Python in Pyodide…"
                    value={input}
                    disabled={busy}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void handleSend();
                        }
                    }}
                />
                <div className="code-studio-ai-send-col">
                    {busy ? (
                        <button type="button" className="code-studio-ai-stop" title="Stop" onClick={handleStop}>
                            <Square size={14} fill="currentColor" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="code-studio-ai-send"
                            title="Send"
                            disabled={!input.trim() || !isLoaded}
                            onClick={() => void handleSend()}
                        >
                            <Send size={16} />
                        </button>
                    )}
                    {busy ? <Loader2 className="code-studio-ai-spin" size={16} /> : null}
                </div>
            </div>
            {!prefs.isGeminiBackend && workerStatus === 'loading' ? (
                <p className="code-studio-ai-foot">Loading local model…</p>
            ) : !isLoaded ? (
                <p className="code-studio-ai-foot code-studio-ai-foot--warn">Not ready — configure AI Agents.</p>
            ) : (
                <p className="code-studio-ai-foot">
                    {prefs.isGeminiBackend ? 'Cloud API' : `Local: ${prefs.currentModelId.split('/').pop()}`}
                </p>
            )}
        </>
    );

    if (collapsed) {
        return (
            <div className="code-studio-ai code-studio-ai--collapsed">
                <button
                    type="button"
                    className="code-studio-ai-collapse-tab"
                    title="Open Code assistant"
                    onClick={() => setCollapsed(false)}
                >
                    <Sparkles size={18} />
                </button>
            </div>
        );
    }

    return <div className="code-studio-ai">{railBody}</div>;
}
