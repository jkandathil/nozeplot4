import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronLeft, ChevronRight, Cpu, Loader2, Send, Sparkles, Square, Trash2, Zap } from 'lucide-react';
import { buildAugmentedSystemPrompt } from '../ai/kb/knowledgeBase.js';
import { packHistory, buildRetrievalQuery, computeHistoryBudget, sanitizeHistory } from '../ai/chatContext.js';
import {
    DEFAULT_GEMINI_MODEL,
    normalizeGeminiModelId,
    resolveGeminiApiKey,
    streamGeminiChat,
} from '../ai/geminiChat.js';
import { CURATED_MODELS } from '../ai/curatedChatModels.js';
import { renderMarkdown } from '../utils/miniMarkdown.jsx';
import {
    getArduinoAgentActions,
    isApplyCodeToArduinoEnabled,
    tryApplyAssistantMarkdownToArduino,
} from '../utils/arduinoStudioBridge.js';

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
const LS_AUTO_AGENT = 'arduino:auto-agent';

const BACKEND_GEMINI = 'gemini';

const FALLBACK_SYSTEM_PROMPT = [
    'You are NozeMCU, an embedded-systems assistant in the NozePlot Arduino & ESP32 Programmer.',
    'You build and debug Arduino-framework C/C++ projects for AVR (Uno/Nano) and ESP32/ESP8266 boards.',
    '',
    'OUTPUT RULES (important — the editor parses these):',
    '- Return each file as its own fenced code block whose info string is the FILENAME, e.g.',
    '  ```cpp main.ino  …  ```   and   ```cpp sensors.h  …  ```   and   ```cpp sensors.cpp  …  ```',
    '- Always include the main sketch as a `.ino` file containing setup() and loop().',
    '- For larger apps, SPLIT the code into multiple files (headers + implementation + the .ino). Emit every file you change as a full file (not a diff).',
    '- Keep each file complete and compilable; do not abbreviate with "// ...".',
    '- If external libraries are needed, name them in prose (e.g. "Add library: ArduinoJson") so the user can install them.',
    'Prefer Arduino core APIs; for ESP32 use the ESP32 Arduino core. Keep pin choices explicit and safe.',
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

function readAllPrefs() {
    const backend = loadLS(LS_BACKEND, 'local');
    const selectedModel = loadLS(LS_MODEL, CURATED_MODELS[0].id);
    const customModel = loadLS(LS_CUSTOM, '');
    const currentModelId = customModel.trim() || selectedModel;
    const currentModelMeta = CURATED_MODELS.find((m) => m.id === currentModelId) || null;
    const params = {
        max_new_tokens: 700,
        temperature: 0.4,
        top_p: 0.9,
        top_k: 50,
        repetition_penalty: 1.08,
        no_repeat_ngram_size: 0,
        ...loadLS(LS_PARAMS, {}),
    };
    const systemPrompt = loadLS(LS_SYSTEM, '') || FALLBACK_SYSTEM_PROMPT;
    const useKnowledgeBase = loadLS(LS_KB_ENABLED, 'true') !== 'false';
    const geminiModel = normalizeGeminiModelId(loadLS(LS_GEMINI_MODEL, DEFAULT_GEMINI_MODEL));
    const effectiveGeminiKey = resolveGeminiApiKey(loadLS(LS_GEMINI_KEY, ''));
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
    return t.length <= max ? t : `${t.slice(0, max)}\n\n… [truncated]`;
}

function buildProjectContextBlock({ board, project, console: consoleLog, isCloud }) {
    const totalBudget = isCloud ? 60000 : 11000;
    const files = project?.files || [];
    const perFile = Math.max(800, Math.floor(totalBudget / Math.max(1, files.length)));
    const fileBlocks = files.map((f) => {
        const lang = /\.c$/i.test(f.name) ? 'c' : 'cpp';
        return [`### ${f.name}${f.isMain ? '  *(main)*' : ''} (\`${lang}\`)`, '```' + lang, clip(f.content || '// (empty)', perFile), '```'].join('\n');
    });
    return [
        '## Project',
        `- **Board:** ${board || '(none selected)'}`,
        `- **Project:** ${project?.name || '(untitled)'} — ${files.length} file(s)`,
        project?.libraries?.length ? `- **Libraries:** ${project.libraries.join(', ')}` : '- **Libraries:** (none)',
        '',
        ...fileBlocks,
        consoleLog?.trim() ? `\n### Recent compile/flash/serial log\n\`\`\`text\n${clip(consoleLog, 4000)}\n\`\`\`` : '',
    ].join('\n');
}

/**
 * @param {object} props
 * @param {string} props.boardName
 * @param {() => { name: string, files: {name:string,content:string,isMain:boolean}[], libraries: string[] }} props.getProject
 * @param {() => string} [props.getConsole]
 */
export default function ArduinoAiPanel({ boardName, getProject, getConsole }) {
    const [collapsed, setCollapsed] = useState(false);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [streamingText, setStreamingText] = useState('');
    const [busy, setBusy] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [workerStatus, setWorkerStatus] = useState('idle');
    const [loadedModelId, setLoadedModelId] = useState('');
    const [autoAgent, setAutoAgent] = useState(() => loadLS(LS_AUTO_AGENT, 'false') === 'true');
    const [agentRunning, setAgentRunning] = useState(false);
    const workerRef = useRef(null);
    const abortRef = useRef(null);
    const scrollRef = useRef(null);
    const messagesRef = useRef([]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        try {
            localStorage.setItem(LS_AUTO_AGENT, autoAgent ? 'true' : 'false');
        } catch {
            /* ignore */
        }
    }, [autoAgent]);

    const [settingsTick, setSettingsTick] = useState(0);
    useEffect(() => {
        const bump = () => setSettingsTick((t) => t + 1);
        window.addEventListener('focus', bump);
        window.addEventListener('storage', bump);
        const id = setInterval(bump, 3000);
        return () => {
            window.removeEventListener('focus', bump);
            window.removeEventListener('storage', bump);
            clearInterval(id);
        };
    }, []);

    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read prefs when settings change (tick)
    const prefs = useMemo(() => readAllPrefs(), [settingsTick]);

    const isLoaded = prefs.isGeminiBackend
        ? !!prefs.effectiveGeminiKey
        : !!loadedModelId && loadedModelId === prefs.currentModelId && workerStatus !== 'loading';

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

    const finalizeAssistant = useCallback((text) => {
        setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant' && last.streaming) {
                next[next.length - 1] = { ...last, content: text || last.content, streaming: false };
            }
            return next;
        });
    }, []);

    const runAgentPipeline = useCallback(
        async (assistantText) => {
            const actions = getArduinoAgentActions();
            if (!actions) return;
            if (isApplyCodeToArduinoEnabled() && assistantText) {
                await tryApplyAssistantMarkdownToArduino(assistantText, {});
            }
            if (!autoAgent) return;
            const state = actions.getState?.() || {};
            setAgentRunning(true);
            const observations = [];
            try {
                if (state.compileConfigured) {
                    const c = await actions.compile();
                    observations.push(`Compile: ${c.ok ? 'OK' : 'FAILED'}\n${clip(c.log, 1500)}`);
                    if (!c.ok) throw new Error('compile-failed');
                }
                if (state.portConnected) {
                    const f = await actions.flash();
                    observations.push(`Flash: ${f.ok ? 'OK' : 'FAILED'}\n${clip(f.log, 1200)}`);
                    if (f.ok) {
                        const serial = await actions.readSerial(4000);
                        observations.push(`Serial (4s):\n${clip(serial || '(no output)', 1500)}`);
                    }
                } else {
                    observations.push('Flash: skipped (no serial port selected — connect a board first).');
                }
            } catch {
                /* observations already captured */
            } finally {
                setAgentRunning(false);
            }
            if (observations.length) {
                const obs = ['## Agent observations', ...observations].join('\n\n');
                setMessages((prev) => [
                    ...prev,
                    { role: 'assistant', content: `🤖 **Agent ran the pipeline.**\n\n${obs}`, ts: Date.now(), streaming: false },
                ]);
            }
        },
        [autoAgent]
    );

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
                    finalizeAssistant(text);
                    setWorkerStatus('ready');
                    void runAgentPipeline(text);
                    break;
                }
                case 'stopped':
                    setStreamingText('');
                    setBusy(false);
                    finalizeAssistant('⏹ stopped');
                    setWorkerStatus('ready');
                    break;
                case 'error':
                    setErrorMsg(String(msg.message || 'Model error'));
                    setStreamingText('');
                    setBusy(false);
                    finalizeAssistant(`**Error:** ${String(msg.message || 'Unknown')}`);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when HF settings change
    }, [prefs.isGeminiBackend, prefs.currentModelId, prefs.device, prefs.dtype]);

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
        if (el) el.scrollTop = el.scrollHeight;
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

    const sendToModel = useCallback(
        async (text) => {
            const p = readAllPrefs();
            const loadedOk = p.isGeminiBackend
                ? !!p.effectiveGeminiKey
                : !!loadedModelId && loadedModelId === p.currentModelId && workerStatus !== 'loading';
            if (!loadedOk) {
                setErrorMsg(
                    p.isGeminiBackend
                        ? 'Add your Cloud API key under AI Agents (or VITE_GEMINI_API_KEY at build time).'
                        : 'Local model is still loading — wait, or open AI Agents and pick a smaller model.'
                );
                return;
            }

            const snapshot = buildProjectContextBlock({
                board: boardName,
                project: getProject?.() ?? { name: '', files: [], libraries: [] },
                console: getConsole?.() ?? '',
                isCloud: p.isGeminiBackend,
            });

            let effectiveSystem = [p.systemPrompt, FALLBACK_SYSTEM_PROMPT].join('\n\n');
            const history = messagesRef.current.filter((m) => !m.observation);
            if (p.useKnowledgeBase) {
                const retrievalQuery = buildRetrievalQuery(text, history);
                const recentUserTurns = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content);
                const { prompt } = buildAugmentedSystemPrompt({
                    userSystem: effectiveSystem,
                    query: retrievalQuery,
                    history: recentUserTurns,
                    budgetChars: 1800,
                    k: 3,
                    modelTier: p.isGeminiBackend ? 'great' : p.currentModelMeta?.quality || 'good',
                    ragStyle: p.isGeminiBackend ? 'cloud' : 'local',
                });
                effectiveSystem = prompt;
            }
            effectiveSystem = [effectiveSystem, snapshot].join('\n\n');

            const budget = computeHistoryBudget({
                systemPromptChars: effectiveSystem.length,
                maxNewTokens: p.isGeminiBackend ? Math.min(p.params.max_new_tokens || 2048, 8192) : p.params.max_new_tokens || 700,
                targetPromptTokens: p.isGeminiBackend ? 120000 : 3200,
            });
            const packed = packHistory(sanitizeHistory(history), {
                budgetChars: budget,
                minKeepTurns: p.isGeminiBackend ? 8 : 3,
            });

            const payload = [
                { role: 'system', content: effectiveSystem },
                ...packed.messages.map((m) => ({ role: m.role, content: m.content })),
                { role: 'user', content: text },
            ];

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
                    const result = await streamGeminiChat({
                        apiKey: p.effectiveGeminiKey,
                        model: p.geminiModel,
                        messages: payload,
                        params: {
                            temperature: p.params.temperature,
                            top_p: p.params.top_p,
                            max_new_tokens: Math.min(p.params.max_new_tokens || 2048, 8192),
                        },
                        signal: ac.signal,
                        onChunk: (chunk) => setStreamingText((prev) => prev + chunk),
                    });
                    setStreamingText('');
                    finalizeAssistant(result.text || '');
                    void runAgentPipeline(result.text || '');
                } catch (err) {
                    if (err?.name === 'AbortError') {
                        finalizeAssistant('⏹ stopped');
                    } else {
                        const msg = err?.message || String(err);
                        setErrorMsg(msg);
                        finalizeAssistant(`**Cloud API error:** ${msg}`);
                    }
                } finally {
                    abortRef.current = null;
                    setBusy(false);
                }
                return;
            }

            workerRef.current?.postMessage({ type: 'generate', messages: payload, params: p.params });
        },
        [boardName, getProject, getConsole, loadedModelId, workerStatus, finalizeAssistant, runAgentPipeline]
    );

    const handleSend = useCallback(() => {
        const text = input.trim();
        if (!text || busy) return;
        setInput('');
        void sendToModel(text);
    }, [input, busy, sendToModel]);

    const handleManualAgent = useCallback(async () => {
        const actions = getArduinoAgentActions();
        if (!actions || agentRunning || busy) return;
        const state = actions.getState?.() || {};
        setAgentRunning(true);
        const observations = [];
        try {
            if (state.compileConfigured) {
                const c = await actions.compile();
                observations.push(`Compile: ${c.ok ? 'OK' : 'FAILED'}\n${clip(c.log, 1500)}`);
                if (!c.ok) throw new Error('compile-failed');
            }
            const f = await actions.flash();
            observations.push(`Flash: ${f.ok ? 'OK' : 'FAILED'}\n${clip(f.log, 1200)}`);
            if (f.ok) {
                const serial = await actions.readSerial(4000);
                observations.push(`Serial (4s):\n${clip(serial || '(no output)', 1500)}`);
            }
        } catch {
            /* captured */
        } finally {
            setAgentRunning(false);
        }
        const obs = ['## Agent observations', ...observations].join('\n\n');
        setMessages((prev) => [
            ...prev,
            { role: 'user', content: '▶ Build, flash & observe the current sketch.', ts: Date.now() },
            { role: 'assistant', content: obs, ts: Date.now(), streaming: false, observation: true },
        ]);
    }, [agentRunning, busy]);

    const railBody = (
        <>
            <div className="code-studio-ai-head">
                <div className="code-studio-ai-head-title">
                    <Cpu size={16} aria-hidden />
                    <span>MCU agent</span>
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
                Same backend/keys as <strong>AI Agents</strong>. Writes complete Arduino/ESP32 sketches and applies them to the editor.
            </p>
            <label className="arduino-ai-agent-toggle" title="After each reply: compile (if server set), flash, then read serial and report back">
                <input type="checkbox" checked={autoAgent} onChange={(e) => setAutoAgent(e.target.checked)} />
                Auto build &amp; flash after replies
            </label>
            {errorMsg ? <div className="code-studio-ai-error">{errorMsg}</div> : null}
            <div className="code-studio-ai-messages" ref={scrollRef}>
                {messages.length === 0 ? (
                    <div className="code-studio-ai-empty">
                        <Bot size={28} aria-hidden />
                        <p>
                            Ask for a sketch or a whole app (e.g. “read DHT22 and serve JSON over Wi-Fi, split into files”). The full
                            project (all files + libraries), board, and recent log are sent each time. Multi-file replies are applied
                            across the project.
                        </p>
                    </div>
                ) : (
                    messages.map((m, i) => (
                        <div key={m.ts ? `${m.ts}-${i}` : i} className={`code-studio-ai-msg code-studio-ai-msg--${m.role}`}>
                            {m.role === 'assistant' ? (
                                <div className="code-studio-ai-md">{renderMarkdown(m.content || (m.streaming ? '…' : ''))}</div>
                            ) : (
                                <div className="code-studio-ai-user">{m.content}</div>
                            )}
                        </div>
                    ))
                )}
            </div>
            <button
                type="button"
                className="arduino-ai-agent-run"
                disabled={agentRunning || busy}
                onClick={() => void handleManualAgent()}
                title="Build (if compile server set), flash the current sketch, then read serial"
            >
                {agentRunning ? <Loader2 className="code-studio-ai-spin" size={14} /> : <Zap size={14} />}
                {agentRunning ? 'Running pipeline…' : 'Build ▶ Flash ▶ Observe'}
            </button>
            <div className="code-studio-ai-input-row">
                <textarea
                    className="code-studio-ai-input"
                    rows={2}
                    placeholder="Describe the sketch or the fix you want…"
                    value={input}
                    disabled={busy}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
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
                            onClick={handleSend}
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
                <button type="button" className="code-studio-ai-collapse-tab" title="Open MCU agent" onClick={() => setCollapsed(false)}>
                    <Sparkles size={18} />
                </button>
            </div>
        );
    }

    return <div className="code-studio-ai">{railBody}</div>;
}
