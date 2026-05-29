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

/** For very complex programs: keep generating across token limits. */
const MAX_CONTINUATIONS = 8;
const CONTINUE_PROMPT =
    'Continue the previous response from exactly where it stopped. Do NOT repeat any text already sent. ' +
    'If you stopped inside a code block, keep writing inside it and remember to close it with ```. ' +
    'Output only the continuation.';

const FALLBACK_SYSTEM_PROMPT = [
    'You are NozeMCU, an embedded-systems engineer in the NozePlot Arduino & ESP32 Programmer.',
    'You design, build and debug complete Arduino-framework C/C++ projects for AVR (Uno/Nano) and ESP32/ESP8266.',
    '',
    'WORKFLOW for non-trivial / complex programs:',
    '1. Start with a short "## Plan": list the files you will create and each file\'s responsibility.',
    '2. Then output EVERY file as its own fenced block whose info string is the FILENAME, e.g.',
    '   ```cpp main.ino  …  ```   ```cpp net.h  …  ```   ```cpp net.cpp  …  ```',
    '3. Split large apps into focused modules (header + implementation) plus the main `.ino` with setup()/loop().',
    '',
    'OUTPUT RULES (the editor parses these):',
    '- The filename MUST be on the code-fence info line (```cpp <filename>).',
    '- Always include a main `.ino` containing setup() and loop().',
    '- Emit each changed file IN FULL — never abbreviate with "// ..." or "rest unchanged".',
    '- Keep every file complete and compilable. If you run out of space, stop mid-file; you will be asked to continue.',
    '- Name any external libraries needed (Arduino Library Manager names) so the user can add them.',
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
        max_new_tokens: 1024,
        temperature: 0.35,
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

/** A reply is "truncated" if the model hit the length cap or left a code fence open. */
function isTruncated(text, finishReason) {
    if (finishReason && /max.?tokens|length/i.test(finishReason)) return true;
    const fences = (String(text).match(/```/g) || []).length;
    return fences % 2 === 1;
}

/** Append a continuation, removing any overlap the model repeated. */
function stitchContinuation(prev, cont) {
    if (!cont) return '';
    const maxOverlap = Math.min(400, prev.length, cont.length);
    for (let n = maxOverlap; n >= 24; n -= 1) {
        if (prev.slice(-n) === cont.slice(0, n)) return cont.slice(n);
    }
    return cont;
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
    const [busy, setBusy] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [workerStatus, setWorkerStatus] = useState('idle');
    const [loadedModelId, setLoadedModelId] = useState('');
    const [autoAgent, setAutoAgent] = useState(() => loadLS(LS_AUTO_AGENT, 'false') === 'true');
    const [agentRunning, setAgentRunning] = useState(false);
    const [genPart, setGenPart] = useState(0);

    const workerRef = useRef(null);
    const abortRef = useRef(null);
    const scrollRef = useRef(null);
    const messagesRef = useRef([]);
    const assembledRef = useRef('');
    const genCtlRef = useRef(null); // { resolve, reject, assembled, live }

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

    const setAssistant = useCallback((content, streaming) => {
        setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') next[next.length - 1] = { ...last, content, streaming };
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
                /* observations captured */
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
            const ctl = genCtlRef.current;
            switch (msg.type) {
                case 'status':
                    setWorkerStatus(msg.status);
                    break;
                case 'ready':
                    setLoadedModelId(msg.modelId);
                    setWorkerStatus('ready');
                    break;
                case 'token':
                    if (ctl) {
                        ctl.live += msg.text || '';
                        setAssistant(ctl.assembled + ctl.live, true);
                    }
                    break;
                case 'complete':
                    setWorkerStatus('ready');
                    if (ctl?.resolve) {
                        const resolve = ctl.resolve;
                        ctl.resolve = null;
                        resolve({ text: msg.text || ctl.live });
                    }
                    break;
                case 'stopped':
                    setWorkerStatus('ready');
                    if (ctl?.resolve) {
                        const resolve = ctl.resolve;
                        ctl.resolve = null;
                        resolve({ text: ctl.live, stopped: true });
                    }
                    break;
                case 'error':
                    setWorkerStatus('ready');
                    if (ctl?.reject) {
                        const reject = ctl.reject;
                        ctl.reject = null;
                        reject(new Error(String(msg.message || 'Model error')));
                    } else {
                        setErrorMsg(String(msg.message || 'Model error'));
                    }
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
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    const handleStop = useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        workerRef.current?.postMessage({ type: 'stop' });
    }, []);

    const handleClear = useCallback(() => {
        handleStop();
        setMessages([]);
        setErrorMsg('');
    }, [handleStop]);

    /** One generation round. Resolves with { text, finishReason?, stopped? }. */
    const runRound = useCallback(
        async (payload, p) => {
            if (p.isGeminiBackend) {
                const ac = new AbortController();
                abortRef.current = ac;
                const live = { v: '' };
                try {
                    const result = await streamGeminiChat({
                        apiKey: p.effectiveGeminiKey,
                        model: p.geminiModel,
                        messages: payload,
                        params: {
                            temperature: p.params.temperature,
                            top_p: p.params.top_p,
                            max_new_tokens: Math.min(p.params.max_new_tokens || 8192, 8192),
                        },
                        signal: ac.signal,
                        onChunk: (chunk) => {
                            live.v += chunk;
                            setAssistant(assembledRef.current + live.v, true);
                        },
                    });
                    return { text: result.text, finishReason: result.finishReason };
                } finally {
                    abortRef.current = null;
                }
            }
            // local worker
            return new Promise((resolve, reject) => {
                genCtlRef.current = { resolve, reject, assembled: assembledRef.current, live: '' };
                workerRef.current?.postMessage({ type: 'generate', messages: payload, params: p.params });
            });
        },
        [setAssistant]
    );

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
                maxNewTokens: p.isGeminiBackend ? 8192 : p.params.max_new_tokens || 1024,
                targetPromptTokens: p.isGeminiBackend ? 120000 : 3200,
            });
            const packed = packHistory(sanitizeHistory(history), {
                budgetChars: budget,
                minKeepTurns: p.isGeminiBackend ? 8 : 3,
            });

            const basePayload = [
                { role: 'system', content: effectiveSystem },
                ...packed.messages.map((m) => ({ role: m.role, content: m.content })),
                { role: 'user', content: text },
            ];

            setErrorMsg('');
            setMessages((prev) => [
                ...prev,
                { role: 'user', content: text, ts: Date.now() },
                { role: 'assistant', content: '', streaming: true, ts: Date.now() },
            ]);
            setBusy(true);
            assembledRef.current = '';
            let round = 0;
            let stopped = false;
            let payload = basePayload;

            try {
                while (true) {
                    setGenPart(round + 1);
                    let r;
                    try {
                        r = await runRound(payload, p);
                    } catch (err) {
                        if (err?.name === 'AbortError') {
                            stopped = true;
                            break;
                        }
                        throw err;
                    }
                    if (round === 0) assembledRef.current = r.text || '';
                    else assembledRef.current += stitchContinuation(assembledRef.current, r.text || '');
                    setAssistant(assembledRef.current, true);
                    round += 1;
                    if (r.stopped) {
                        stopped = true;
                        break;
                    }
                    if (!isTruncated(assembledRef.current, r.finishReason) || round >= MAX_CONTINUATIONS) break;
                    payload = [
                        ...basePayload,
                        { role: 'assistant', content: assembledRef.current },
                        { role: 'user', content: CONTINUE_PROMPT },
                    ];
                }
            } catch (err) {
                const msg = err?.message || String(err);
                setErrorMsg(msg);
                setAssistant(assembledRef.current ? `${assembledRef.current}\n\n**Error:** ${msg}` : `**Error:** ${msg}`, false);
                setBusy(false);
                setGenPart(0);
                return;
            }

            setAssistant(assembledRef.current || (stopped ? '⏹ stopped' : ''), false);
            setBusy(false);
            setGenPart(0);
            if (!stopped) void runAgentPipeline(assembledRef.current);
        },
        [boardName, getProject, getConsole, loadedModelId, workerStatus, runRound, setAssistant, runAgentPipeline]
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
                Same backend/keys as <strong>AI Agents</strong>. Builds complete multi-file Arduino/ESP32 apps and keeps writing past
                token limits for large programs.
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
                            Ask for a whole app (e.g. “build a Wi-Fi weather station: read BME280, serve a JSON API and a web dashboard,
                            split into files”). The agent plans, writes every file, and continues automatically if the program is long.
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
                    placeholder="Describe the app or the fix you want…"
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
            {busy && genPart > 1 ? (
                <p className="code-studio-ai-foot">Writing large program… part {genPart}</p>
            ) : !prefs.isGeminiBackend && workerStatus === 'loading' ? (
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
