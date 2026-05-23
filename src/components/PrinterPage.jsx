/**
 * Printer — control panel for a Kloehn / Cavro syringe pump over Web Serial.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Toolbar (Connect / Init / Halt + status pill)                 │
 *   ├──────────┬─────────────────────────────────┬───────────────────┤
 *   │ Syringe  │   Live syringe gauge (SVG)      │  Program builder  │
 *   │ presets, │   + jog / aspirate / dispense   │  + step editor    │
 *   │ speeds   │                                 │                   │
 *   ├──────────┴─────────────────────────────────┴───────────────────┤
 *   │  Console log (TX/RX)                                           │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The user picks a syringe preset (250 µL / 24k or 500 µL / 48k, etc.), which
 * defines the nL/step calibration. Then they can either (a) jog manually using
 * the Aspirate / Dispense / Drop buttons, or (b) build a printing program of
 * steps (aspirate → drop × N → wait → …) and Run it.
 *
 * Drop volume slider is clamped to 100–500 nL per the user requirement, but the
 * underlying machinery supports anything within the nL/step resolution.
 */

import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    Plug,
    PlugZap,
    Play,
    Pause,
    Square as StopIcon,
    RotateCcw,
    Activity,
    Droplet,
    ArrowDown,
    ArrowUp,
    Plus,
    Trash2,
    Copy as CopyIcon,
    ChevronUp,
    ChevronDown,
    ChevronRight,
    Settings2,
    HelpCircle,
    Syringe as SyringeIcon,
    Sigma,
    Zap,
    Gauge,
    AlertTriangle,
    Eraser,
} from 'lucide-react';
import {
    PrinterSession,
    isWebSerialSupported,
    DEFAULT_SERIAL_OPTS,
    listGrantedSerialPorts,
    requestNewSerialPort,
    forgetSerialPort,
} from '../printer/printerSession.js';
import {
    SYRINGE_PRESETS,
    DEFAULT_PRESET_ID,
    DROP_VOLUME_MIN_NL,
    DROP_VOLUME_MAX_NL,
    getSyringePreset,
    formatVolume,
    stepsToFillPercent,
} from '../printer/syringePresets.js';
import {
    makeStep,
    describeStep,
    runProgram,
    defaultPrinterProgram,
    estimateProgramSeconds,
    tubeVolumeUl,
    planPriming,
} from '../printer/printerProgram.js';
import { roundSteps, stepsToNl } from '../printer/kloehnProtocol.js';
import './PrinterPage.css';

const COMMON_BAUDS = [1200, 2400, 4800, 9600, 19200, 38400];

export default function PrinterPage() {
    /* ---------- connection state ---------- */
    const sessionRef = useRef(null);
    const [connected, setConnected] = useState(false);
    const [opening, setOpening] = useState(false);
    const [pumpAddress, setPumpAddress] = useState(1);
    const [baudRate, setBaudRate] = useState(DEFAULT_SERIAL_OPTS.baudRate);
    const [initialised, setInitialised] = useState(false);
    const [statusPill, setStatusPill] = useState('disconnected');
    const [pumpReady, setPumpReady] = useState(null); // null | true | false
    const [pumpError, setPumpError] = useState(null);

    /* ---------- port picker state ----------
       The previous version of this page silently reused the first port the
       browser had ever granted. If the user accidentally paired the wrong
       device (e.g. a printer instead of the pump), there was no way to
       change it. We now expose every granted USB-to-serial port in a
       dropdown so they can:
         • pick a different already-granted port,
         • add a new one (`requestPort()` chooser), or
         • forget a port whose permission is no longer wanted.
       Bluetooth SPP ports are filtered out by `listGrantedSerialPorts()`
       since they're virtually never the right answer for a benchtop pump. */
    const [availablePorts, setAvailablePorts] = useState([]); // [{ port, key, label, info }]
    const [selectedPortKey, setSelectedPortKey] = useState('');
    const [portsLoading, setPortsLoading] = useState(false);

    /* ---------- syringe + position ---------- */
    const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
    const preset = useMemo(() => getSyringePreset(presetId), [presetId]);
    const [positionSteps, setPositionSteps] = useState(0);

    /* ---------- jog parameters ---------- */
    const [jogVolumeUl, setJogVolumeUl] = useState(5);
    const [dropVolumeNl, setDropVolumeNl] = useState(200);
    const [dropCount, setDropCount] = useState(5);
    const [dropDelayMs, setDropDelayMs] = useState(250);
    const [topSpeedSps, setTopSpeedSps] = useState(2000);
    /* Drops are tiny moves (10–100 steps) so they should run at a much
       slower top speed than aspirate — otherwise the motor accelerates and
       decelerates within a few ms which sounds like a sharp click on every
       drop. Defaults to ~200 sps which feels smooth. */
    const [dropSpeedSps, setDropSpeedSps] = useState(200);

    /* ───── Priming config (persists across runs in this session) ─────
       The physical tubing — input tube goes from reservoir to the valve
       upper port; output tube goes from the valve lower port to the
       dispense tip. Volumes are computed from the cylinder formula
       (V = π·r²·L). The priming step aspirates and dispenses a full
       syringe per cycle until total volume moved >= tube volume × (1+s). */
    const [primeInputLenMm, setPrimeInputLenMm] = useState(200);
    const [primeInputIdMm, setPrimeInputIdMm] = useState(1.0);
    const [primeOutputLenMm, setPrimeOutputLenMm] = useState(100);
    const [primeOutputIdMm, setPrimeOutputIdMm] = useState(0.5);
    const [primeSafetyPct, setPrimeSafetyPct] = useState(25);
    const [primeSpeedSps, setPrimeSpeedSps] = useState(4000);

    /* ---------- program builder ---------- */
    const [programSteps, setProgramSteps] = useState(() => defaultPrinterProgram());
    const [selectedStepId, setSelectedStepId] = useState(() => null);
    const [programRunning, setProgramRunning] = useState(false);
    const [programProgress, setProgramProgress] = useState({ stepIdx: 0, totalSteps: 0, message: '' });
    const cancelFlagRef = useRef(false);

    /* ---------- pending user-confirm modal ----------
       The program executor pauses on `prompt` / `clean` steps and calls back
       via `requestConfirm()`. We capture the resolver in state so the
       confirm-modal in the render tree can show the message + resolve when
       the user clicks OK / Cancel. */
    const [pendingPrompt, setPendingPrompt] = useState(null);
    const handleConfirmResolve = useCallback((ok) => {
        setPendingPrompt((prev) => {
            try { prev?.resolve(!!ok); } catch { /* ignore */ }
            return null;
        });
    }, []);
    const requestConfirm = useCallback(
        ({ title = 'Continue', message = '', okLabel = 'OK' } = {}) =>
            new Promise((resolve) => {
                setPendingPrompt({ title, message, okLabel, resolve });
            }),
        []
    );

    /* ---------- cleaning panel (left palette) state ---------- */
    const [cleanCycles, setCleanCycles] = useState(5);
    const [cleanSafetyPct, setCleanSafetyPct] = useState(50);
    const [cleanSpeedSps, setCleanSpeedSps] = useState(4000);
    const [cleanPromptMessage, setCleanPromptMessage] = useState(
        'Remove the ink reservoir and replace it with cleaning solvent (e.g. DI water). ' +
            'Make sure the dispense tip is over a waste container. Click OK to start flushing.'
    );

    /* ---------- log ---------- */
    const [logLines, setLogLines] = useState([]);
    const pushLog = useCallback((level, text) => {
        setLogLines((prev) => {
            const next = [...prev, { ts: Date.now(), level, text }];
            if (next.length > 600) next.splice(0, next.length - 600);
            return next;
        });
    }, []);

    /* ---------- helpers ---------- */
    const liveSession = sessionRef.current;
    const supported = isWebSerialSupported();

    /* ---------- connection wiring ---------- */
    const attachListeners = useCallback(
        (s) => {
            const onLog = (ev) => pushLog(ev.detail.level, ev.detail.message);
            const onOpen = () => {
                setConnected(true);
                setStatusPill('connected · idle');
            };
            const onClose = () => {
                setConnected(false);
                setInitialised(false);
                setPumpReady(null);
                setStatusPill('disconnected');
            };
            /* Live position stream — every time the worker polls the pump
               with `?` during a move, the session emits a 'position' event.
               We mirror that into React state so the gauge animates in
               real time as the plunger physically travels. */
            const onPosition = (ev) => {
                const n = ev?.detail?.steps;
                if (Number.isFinite(n)) setPositionSteps(n);
            };
            s.addEventListener('log', onLog);
            s.addEventListener('open', onOpen);
            s.addEventListener('close', onClose);
            s.addEventListener('position', onPosition);
            return () => {
                s.removeEventListener('log', onLog);
                s.removeEventListener('open', onOpen);
                s.removeEventListener('close', onClose);
                s.removeEventListener('position', onPosition);
            };
        },
        [pushLog]
    );

    /** Refresh the list of granted USB-to-serial ports the browser knows about. */
    const refreshPortList = useCallback(async () => {
        if (!supported) return [];
        setPortsLoading(true);
        try {
            const list = await listGrantedSerialPorts();
            setAvailablePorts(list);
            setSelectedPortKey((prev) => {
                if (prev && list.some((p) => p.key === prev)) return prev;
                return list[0]?.key ?? '';
            });
            return list;
        } finally {
            setPortsLoading(false);
        }
    }, [supported]);

    /**
     * Open the currently-selected port. If nothing is selected (the page has
     * never been granted any USB-to-serial port yet) we transparently fall
     * back to the OS chooser via `requestNewSerialPort()`.
     */
    const handleConnect = useCallback(async () => {
        if (!supported) {
            window.alert(
                'Web Serial is not available. Use Chrome or Edge over HTTPS or localhost, then approve the prompt.'
            );
            return;
        }
        try {
            setOpening(true);
            const list = availablePorts.length > 0
                ? availablePorts
                : await refreshPortList();
            let target = list.find((p) => p.key === selectedPortKey)?.port ?? list[0]?.port ?? null;
            if (!target) {
                /* Nothing granted yet — open the chooser. */
                target = await requestNewSerialPort();
                if (!target) { setOpening(false); return; }
                /* Re-list so the new port shows up in the dropdown for next time. */
                await refreshPortList();
            }
            const s = new PrinterSession({ baudRate, address: pumpAddress });
            sessionRef.current = s;
            const detach = attachListeners(s);
            await s.openGranted(target);
            /* Best-effort: query status & position so the gauge reflects reality. */
            try {
                const status = await s.queryStatus();
                setPumpReady(status?.ready ?? null);
                setPumpError(status?.errorName ?? null);
                if (status?.errorCode === 7) {
                    setStatusPill('connected · needs initialise');
                }
                const pos = await s.queryPosition();
                const n = parseInt((pos?.data || '').trim(), 10);
                if (Number.isFinite(n)) setPositionSteps(n);
            } catch {
                /* ignore handshake noise */
            }
            sessionRef.current._detach = detach;
        } catch (err) {
            pushLog('error', `Connect failed: ${err?.message ?? err}`);
            sessionRef.current = null;
        } finally {
            setOpening(false);
        }
    }, [supported, baudRate, pumpAddress, attachListeners, pushLog, availablePorts, selectedPortKey, refreshPortList]);

    /** Open the OS chooser to add a fresh USB-to-serial port to the page's
     *  permissions list, then make it the active selection. */
    const handleAddPort = useCallback(async () => {
        if (!supported) return;
        try {
            const port = await requestNewSerialPort();
            if (!port) return; /* user cancelled */
            const list = await refreshPortList();
            /* Try to auto-select the just-added port by reference equality. */
            const added = list.find((p) => p.port === port);
            if (added) setSelectedPortKey(added.key);
        } catch (err) {
            pushLog('error', `Add port failed: ${err?.message ?? err}`);
        }
    }, [supported, refreshPortList, pushLog]);

    /** Revoke the page's permission for the currently-selected port. */
    const handleForgetPort = useCallback(async () => {
        if (!supported) return;
        const entry = availablePorts.find((p) => p.key === selectedPortKey);
        if (!entry) return;
        if (connected) {
            window.alert('Disconnect first, then forget the port.');
            return;
        }
        const ok = window.confirm(`Forget "${entry.label}"? You'll be re-prompted next time.`);
        if (!ok) return;
        const did = await forgetSerialPort(entry.port);
        if (!did) {
            pushLog('warn', 'This browser does not support port.forget(). Use chrome://settings/content/serialPorts to revoke.');
        }
        await refreshPortList();
    }, [supported, availablePorts, selectedPortKey, connected, pushLog, refreshPortList]);

    const handleDisconnect = useCallback(async () => {
        const s = sessionRef.current;
        if (!s) return;
        try {
            await s.close('user');
        } finally {
            try {
                s._detach?.();
            } catch { /* ignore */ }
            sessionRef.current = null;
        }
    }, []);

    useEffect(() => {
        return () => {
            const s = sessionRef.current;
            if (s) {
                s.close('unmount').catch(() => {});
            }
        };
    }, []);

    /* Load granted ports on mount and refresh whenever USB devices come or
       go. `navigator.serial` fires `connect`/`disconnect` events for any
       previously-granted port that gets plugged in or unplugged. */
    useEffect(() => {
        if (!supported) return undefined;
        refreshPortList();
        const onConnect = () => { refreshPortList(); };
        const onDisconnect = () => { refreshPortList(); };
        try {
            navigator.serial.addEventListener('connect', onConnect);
            navigator.serial.addEventListener('disconnect', onDisconnect);
        } catch { /* older browsers ignore */ }
        return () => {
            try {
                navigator.serial.removeEventListener('connect', onConnect);
                navigator.serial.removeEventListener('disconnect', onDisconnect);
            } catch { /* ignore */ }
        };
    }, [supported, refreshPortList]);

    /* ---------- syringe ops ---------- */
    const refreshPosition = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) return;
        const r = await s.queryPosition();
        const n = parseInt((r?.data || '').trim(), 10);
        if (Number.isFinite(n)) setPositionSteps(n);
    }, []);

    const handleInitialize = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) return;
        try {
            setStatusPill('initialising…');
            /* Reset motion-control state BEFORE issuing W4R. The pump
               remembers the last `V<n>` top speed and `L<n>` acceleration
               between commands — if a slow drop step (e.g. 200 sps) ran
               previously, W4R would home the plunger at 200 sps, taking
               over a minute and making lots of motor noise. Manual section
               4.1.2 calls for L7 (default accel) + V5000 (default top
               speed) before any long move; we use the preset's fast speed
               so it matches the syringe sizing. */
            /* `safeInitialize` resets L<accel> + V<top speed> before W4R so
               homing is fast even if a previous step (e.g. a slow drop) left
               the pump's top speed at 200 sps. */
            await s.safeInitialize(preset.defaultFastSps || 4000);
            await s.waitUntilReady({ timeoutMs: 60000 });
            setInitialised(true);
            await refreshPosition();
            setStatusPill('ready');
            setPumpReady(true);
            setPumpError(null);
        } catch (err) {
            pushLog('error', `Init failed: ${err?.message ?? err}`);
            setStatusPill('error');
        }
    }, [pushLog, refreshPosition, preset.defaultFastSps]);

    /**
     * Probe the pump for a 24 000 vs 48 000 step plunger and switch the
     * preset to the matching size for the user's currently-selected syringe
     * volume. We only have a choice of two presets per syringe (24 k vs 48 k),
     * so the auto-detect simply rewrites the stroke half of the id.
     */
    const handleDetectStroke = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) return;
        try {
            setStatusPill('detecting plunger stroke…');
            const stroke = await s.detectStroke();
            if (!stroke) {
                window.alert('Pump rejected the probe — please click Init first, then try again.');
                setStatusPill('stroke detect needs init first');
                return;
            }
            /* Try to keep the same syringe volume, swap only the stroke. */
            const cur = getSyringePreset(presetId);
            const wanted = `${cur.syringeUl}ul-${stroke === 48000 ? '48k' : '24k'}`;
            const matched = SYRINGE_PRESETS.find((p) => p.id === wanted);
            if (matched) {
                setPresetId(matched.id);
                setStatusPill(
                    `detected ${stroke.toLocaleString()} step stroke · preset → ${matched.label}`
                );
                pushLog('info', `Stroke ${stroke}. Preset updated to "${matched.label}".`);
            } else {
                setStatusPill(`detected ${stroke.toLocaleString()} step stroke (no matching preset)`);
                pushLog('info', `Stroke ${stroke} detected — pick a matching preset manually.`);
            }
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Stroke detect failed: ${err?.message ?? err}`);
            setStatusPill('stroke detect failed');
        }
    }, [presetId, pushLog, refreshPosition]);

    const handleHalt = useCallback(async () => {
        cancelFlagRef.current = true;
        const s = sessionRef.current;
        if (!s?.isOpen) return;
        try {
            await s.halt();
            setStatusPill('halted');
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Halt failed: ${err?.message ?? err}`);
        }
    }, [pushLog, refreshPosition]);

    const jogAspirate = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) return;
        const stepsToMove = roundSteps((Number(jogVolumeUl) || 0) * 1000 / preset.nlPerStep);
        if (stepsToMove <= 0) return;
        try {
            await s.setTopSpeedSps(topSpeedSps);
            await s.valveInput();
            await s.waitUntilReady({ timeoutMs: 4000 });
            /* Use a clamped absolute move so requesting 250 µL on a 250 µL
               syringe always lands at exactly position = full stroke,
               regardless of where the plunger started (e.g. parked at ~100
               steps after Init). */
            const res = await s.aspirateBy(stepsToMove, preset.stroke);
            if (res.skipped) {
                pushLog('warn', 'Already at upper stroke limit — nothing to aspirate.');
            } else if (res.delta < stepsToMove) {
                pushLog(
                    'warn',
                    `Aspirate clamped: requested ${stepsToMove} steps, only ${res.delta} steps room before full stroke.`
                );
            }
            await s.waitUntilReady({ timeoutMs: 60000 });
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Aspirate failed: ${err?.message ?? err}`);
        }
    }, [jogVolumeUl, preset.nlPerStep, preset.stroke, topSpeedSps, refreshPosition, pushLog]);

    const jogDispense = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) return;
        const stepsToMove = roundSteps((Number(jogVolumeUl) || 0) * 1000 / preset.nlPerStep);
        if (stepsToMove <= 0) return;
        try {
            await s.setTopSpeedSps(topSpeedSps);
            await s.valveOutput();
            await s.waitUntilReady({ timeoutMs: 4000 });
            const res = await s.dispenseBy(stepsToMove);
            if (res.skipped) {
                pushLog('warn', 'Plunger already at 0 — nothing to dispense.');
            } else if (res.delta < stepsToMove) {
                pushLog(
                    'warn',
                    `Dispense clamped: requested ${stepsToMove} steps, only ${res.delta} steps left in syringe.`
                );
            }
            await s.waitUntilReady({ timeoutMs: 60000 });
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Dispense failed: ${err?.message ?? err}`);
        }
    }, [jogVolumeUl, preset.nlPerStep, topSpeedSps, refreshPosition, pushLog]);

    const jogSingleDrop = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) return;
        const stepsPerDrop = roundSteps((Number(dropVolumeNl) || 0) / preset.nlPerStep);
        if (stepsPerDrop <= 0) {
            pushLog('warn', `Drop volume rounds to 0 steps — increase volume or use a finer syringe.`);
            return;
        }
        try {
            /* Use the dedicated drop speed (much lower than jog speed) so the
               motor doesn't snap the plunger over a few-millisecond move. */
            await s.setTopSpeedSps(Math.max(40, Math.min(10000, dropSpeedSps)));
            await s.valveOutput();
            await s.waitUntilReady({ timeoutMs: 4000 });
            const res = await s.dispenseBy(stepsPerDrop);
            if (res.skipped) {
                pushLog('warn', 'No fluid left in syringe — aspirate first.');
            }
            await s.waitUntilReady({ timeoutMs: 6000 });
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Drop failed: ${err?.message ?? err}`);
        }
    }, [dropVolumeNl, preset.nlPerStep, dropSpeedSps, refreshPosition, pushLog]);

    /* ---------- program builder ---------- */
    const updateStep = useCallback((id, patch) => {
        setProgramSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    }, []);

    /** Insert one or more new steps right after the currently-selected step
     *  (or at the end of the list if nothing is selected). This is how
     *  loop blocks stay coherent — when the user selects "Repeat 5x" and
     *  clicks "+ Aspirate", the aspirate lands inside the loop. */
    const insertSteps = useCallback(
        (...newSteps) => {
            setProgramSteps((prev) => {
                const insertAt = (() => {
                    if (!selectedStepId) return prev.length;
                    const idx = prev.findIndex((s) => s.id === selectedStepId);
                    return idx < 0 ? prev.length : idx + 1;
                })();
                const next = [...prev];
                next.splice(insertAt, 0, ...newSteps);
                return next;
            });
            setSelectedStepId(newSteps[0]?.id ?? null);
        },
        [selectedStepId]
    );
    const removeStep = useCallback((id) => {
        setProgramSteps((prev) => prev.filter((s) => s.id !== id));
        setSelectedStepId((cur) => (cur === id ? null : cur));
    }, []);
    const duplicateStep = useCallback((id) => {
        setProgramSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === id);
            if (idx < 0) return prev;
            const copy = makeStep(prev[idx].kind, { ...prev[idx] });
            const next = [...prev];
            next.splice(idx + 1, 0, copy);
            return next;
        });
    }, []);
    const moveStep = useCallback((id, delta) => {
        setProgramSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === id);
            if (idx < 0) return prev;
            const target = idx + delta;
            if (target < 0 || target >= prev.length) return prev;
            const next = [...prev];
            const [taken] = next.splice(idx, 1);
            next.splice(target, 0, taken);
            return next;
        });
    }, []);
    const addStep = useCallback((kind) => {
        const newStep = makeStep(kind);
        if (kind === 'drop') {
            newStep.volumeNl = dropVolumeNl;
            newStep.count = dropCount;
            newStep.delayMs = dropDelayMs;
            /* Use the dedicated, slow `dropSpeedSps` rather than the global jog
               top-speed — fast aspirate speeds applied to a few-ms drop move
               cause harsh clicks. */
            newStep.speedSps = dropSpeedSps;
        } else if (kind === 'aspirate') {
            newStep.volumeUl = jogVolumeUl;
            newStep.speedSps = topSpeedSps;
        } else if (kind === 'dispenseAll') {
            newStep.speedSps = topSpeedSps;
        }
        insertSteps(newStep);
    }, [dropVolumeNl, dropCount, dropDelayMs, topSpeedSps, dropSpeedSps, jogVolumeUl, insertSteps]);

    /** Drop a paired loopStart + loopEnd into the program so the user can
     *  later move/insert other steps between them. The loopStart is left
     *  selected so the next `+ Step` click drops inside the loop. */
    const addLoopBlock = useCallback(() => {
        const start = makeStep('loopStart', { count: 5 });
        const end = makeStep('loopEnd');
        insertSteps(start, end);
        setSelectedStepId(start.id);
    }, [insertSteps]);

    /** Live preview of how many full-syringe cycles the current priming
     *  config will require, computed from the cylinder volume formula. */
    const primePlan = useMemo(
        () =>
            planPriming(
                {
                    inputTubeLengthMm: primeInputLenMm,
                    inputTubeIdMm: primeInputIdMm,
                    outputTubeLengthMm: primeOutputLenMm,
                    outputTubeIdMm: primeOutputIdMm,
                    safetyPct: primeSafetyPct,
                    speedSps: primeSpeedSps,
                },
                preset
            ),
        [
            primeInputLenMm,
            primeInputIdMm,
            primeOutputLenMm,
            primeOutputIdMm,
            primeSafetyPct,
            primeSpeedSps,
            preset,
        ]
    );
    /** Rough seconds per prime cycle = aspirate + dispense at speed + ~1.5 s
     *  valve / status overhead. */
    const primeEtaSec = useMemo(() => {
        const moveSec = preset.stroke / Math.max(40, primeSpeedSps);
        return primePlan.cycles * (2 * moveSec + 1.5);
    }, [preset.stroke, primeSpeedSps, primePlan.cycles]);

    /** Build a Prime step preconfigured with the current panel settings. */
    const buildPrimeStep = useCallback(
        () =>
            makeStep('prime', {
                inputTubeLengthMm: primeInputLenMm,
                inputTubeIdMm: primeInputIdMm,
                outputTubeLengthMm: primeOutputLenMm,
                outputTubeIdMm: primeOutputIdMm,
                safetyPct: primeSafetyPct,
                speedSps: primeSpeedSps,
                label: 'Prime tubes',
            }),
        [primeInputLenMm, primeInputIdMm, primeOutputLenMm, primeOutputIdMm, primeSafetyPct, primeSpeedSps]
    );

    const addPrimeStep = useCallback(() => {
        insertSteps(buildPrimeStep());
    }, [insertSteps, buildPrimeStep]);

    /** "Prime now" — directly run a one-step program built from the panel
     *  settings, without adding it to the user's main program. */
    const handlePrimeNow = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) {
            window.alert('Connect to the pump before priming.');
            return;
        }
        if (programRunning) return;
        cancelFlagRef.current = false;
        setProgramRunning(true);
        setProgramProgress({ stepIdx: 0, totalSteps: 1, message: 'Priming…' });
        try {
            const step = buildPrimeStep();
            const res = await runProgram(s, [step], {
                presetId,
                onProgress: (info) => {
                    setProgramProgress(info);
                    if (info.message) pushLog('info', info.message);
                },
                isCancelled: () => cancelFlagRef.current,
                requestConfirm,
            });
            setStatusPill(res.ok ? 'priming complete' : res.reason);
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Prime error: ${err?.message ?? err}`);
        } finally {
            setProgramRunning(false);
            setPendingPrompt(null);
        }
    }, [presetId, programRunning, buildPrimeStep, refreshPosition, pushLog, requestConfirm]);

    /** Build a Clean step preconfigured with the current panel settings and
     *  the SAME tube geometry as the priming panel (so the same physical
     *  setup parameters drive both). */
    const buildCleanStep = useCallback(
        () =>
            makeStep('clean', {
                inputTubeLengthMm: primeInputLenMm,
                inputTubeIdMm: primeInputIdMm,
                outputTubeLengthMm: primeOutputLenMm,
                outputTubeIdMm: primeOutputIdMm,
                safetyPct: cleanSafetyPct,
                speedSps: cleanSpeedSps,
                cycles: cleanCycles,
                promptMessage: cleanPromptMessage,
                promptTitle: 'Cleaning — solvent setup',
                label: 'Clean tubes',
            }),
        [
            primeInputLenMm,
            primeInputIdMm,
            primeOutputLenMm,
            primeOutputIdMm,
            cleanCycles,
            cleanSafetyPct,
            cleanSpeedSps,
            cleanPromptMessage,
        ]
    );
    const addCleanStep = useCallback(() => {
        insertSteps(buildCleanStep());
    }, [insertSteps, buildCleanStep]);

    /** "Clean now" — runs a one-step cleaning sequence using the panel
     *  config. The user gets the swap-solvent prompt first. */
    const handleCleanNow = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) {
            window.alert('Connect to the pump before cleaning.');
            return;
        }
        if (programRunning) return;
        cancelFlagRef.current = false;
        setProgramRunning(true);
        setProgramProgress({ stepIdx: 0, totalSteps: 1, message: 'Cleaning…' });
        try {
            const step = buildCleanStep();
            const res = await runProgram(s, [step], {
                presetId,
                onProgress: (info) => {
                    setProgramProgress(info);
                    if (info.message) pushLog('info', info.message);
                },
                isCancelled: () => cancelFlagRef.current,
                requestConfirm,
            });
            setStatusPill(res.ok ? 'cleaning complete' : res.reason);
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Clean error: ${err?.message ?? err}`);
        } finally {
            setProgramRunning(false);
            setPendingPrompt(null);
        }
    }, [presetId, programRunning, buildCleanStep, refreshPosition, pushLog, requestConfirm]);

    const addPromptStep = useCallback(() => {
        const ms = window.prompt(
            'Prompt message shown to the user during the program:',
            'Place DI water at the input port. Click OK to continue.'
        );
        if (!ms) return;
        insertSteps(makeStep('prompt', { message: ms, promptTitle: 'Continue' }));
    }, [insertSteps]);

    const programEtaSec = useMemo(
        () => estimateProgramSeconds(programSteps, presetId),
        [programSteps, presetId]
    );

    /** Pre-compute nesting depth for each step so cards can be indented
     *  inside loop blocks. `loopEnd` itself sits at the loop's own depth so
     *  it visually closes the bracket. */
    const stepsWithDepth = useMemo(() => {
        const result = [];
        let depth = 0;
        for (const s of programSteps) {
            const isEnd = s.kind === 'loopEnd';
            if (isEnd && depth > 0) depth--;
            result.push({ step: s, depth });
            if (s.kind === 'loopStart') depth++;
        }
        return result;
    }, [programSteps]);

    const handleRunProgram = useCallback(async () => {
        const s = sessionRef.current;
        if (!s?.isOpen) {
            window.alert('Connect to the pump before running a program.');
            return;
        }
        if (!programSteps.some((step) => step.enabled)) return;
        cancelFlagRef.current = false;
        setProgramRunning(true);
        setProgramProgress({ stepIdx: 0, totalSteps: programSteps.filter((s) => s.enabled).length, message: 'Starting…' });
        try {
            const res = await runProgram(s, programSteps, {
                presetId,
                onProgress: (info) => {
                    setProgramProgress(info);
                    if (info.message) pushLog('info', info.message);
                },
                isCancelled: () => cancelFlagRef.current,
                requestConfirm,
            });
            setStatusPill(res.ok ? 'program complete' : res.reason);
            await refreshPosition();
        } catch (err) {
            pushLog('error', `Program error: ${err?.message ?? err}`);
        } finally {
            setProgramRunning(false);
            /* Clear any leftover pending modal if program errored out mid-prompt. */
            setPendingPrompt(null);
        }
    }, [programSteps, presetId, refreshPosition, pushLog, requestConfirm]);

    const handleStopProgram = useCallback(async () => {
        cancelFlagRef.current = true;
        const s = sessionRef.current;
        if (s?.isOpen) {
            try { await s.halt(); } catch { /* ignore */ }
        }
    }, []);

    /* ---------- derived ---------- */
    const fillPct = useMemo(
        () => stepsToFillPercent(positionSteps, preset.stroke),
        [positionSteps, preset.stroke]
    );
    const fillVolumeUl = useMemo(
        () => (positionSteps * preset.nlPerStep) / 1000,
        [positionSteps, preset.nlPerStep]
    );
    const dropStepsPerDrop = useMemo(
        () => roundSteps(dropVolumeNl / preset.nlPerStep),
        [dropVolumeNl, preset.nlPerStep]
    );
    const actualDropNl = useMemo(
        () => stepsToNl(dropStepsPerDrop, preset.syringeUl, preset.stroke),
        [dropStepsPerDrop, preset.syringeUl, preset.stroke]
    );
    /** Volume delivered after `dropCount` drops with cumulative-dither correction
     *  (matches what the program executor does in printerProgram.js). */
    const ditheredTrainNl = useMemo(() => {
        if (!(dropCount > 0)) return 0;
        let cumSteps = 0;
        for (let i = 0; i < dropCount; i++) {
            const cumDesiredSteps = ((i + 1) * dropVolumeNl) / preset.nlPerStep;
            cumSteps += Math.max(0, Math.round(cumDesiredSteps - cumSteps));
        }
        return cumSteps * preset.nlPerStep;
    }, [dropVolumeNl, dropCount, preset.nlPerStep]);
    const naiveTrainNl = useMemo(
        () => dropStepsPerDrop * dropCount * preset.nlPerStep,
        [dropStepsPerDrop, dropCount, preset.nlPerStep]
    );
    const targetTrainNl = dropVolumeNl * dropCount;

    /* ---------- render ---------- */
    return (
        <div className="pr-page">
            {/* TOP TOOLBAR */}
            <div className="pr-toolbar">
                <div className="pr-tg">
                    <div className="pr-tg-label">App</div>
                    <div className="pr-tg-body">
                        <span className="pr-mode-pill">
                            <SyringeIcon size={14} aria-hidden /> Printer
                        </span>
                    </div>
                </div>
                <div className="pr-sep" />
                <div className="pr-tg">
                    <div className="pr-tg-label">Connection</div>
                    <div className="pr-tg-body">
                        {!connected ? (
                            <button
                                className="pr-toolbtn pr-toolbtn--primary"
                                onClick={handleConnect}
                                disabled={opening || !supported}
                                title={
                                    supported
                                        ? availablePorts.length > 0
                                            ? 'Open the port selected in the dropdown'
                                            : 'Pick a USB-to-serial port for the pump'
                                        : 'Web Serial requires Chrome/Edge over HTTPS or localhost'
                                }
                            >
                                <Plug size={14} /> {opening ? 'Opening…' : availablePorts.length > 0 ? 'Connect' : 'Pick port…'}
                            </button>
                        ) : (
                            <button className="pr-toolbtn pr-toolbtn--warn" onClick={handleDisconnect}>
                                <PlugZap size={14} /> Disconnect
                            </button>
                        )}
                        <select
                            className="pr-select"
                            value={selectedPortKey}
                            onChange={(e) => setSelectedPortKey(e.target.value)}
                            disabled={connected || portsLoading || availablePorts.length === 0}
                            title="USB-to-serial port (Bluetooth ports are hidden)"
                            style={{ minWidth: 180 }}
                        >
                            {availablePorts.length === 0 && (
                                <option value="">{portsLoading ? 'Scanning…' : 'No ports — click Pick port…'}</option>
                            )}
                            {availablePorts.map((p, idx) => (
                                <option key={p.key} value={p.key}>
                                    {`${idx + 1}. ${p.label}`}
                                </option>
                            ))}
                        </select>
                        <button
                            className="pr-toolbtn"
                            onClick={handleAddPort}
                            disabled={!supported || connected}
                            title="Add a new USB-to-serial device (system chooser)"
                        >
                            <Plus size={14} /> Add port
                        </button>
                        <button
                            className="pr-toolbtn"
                            onClick={handleForgetPort}
                            disabled={!supported || connected || !selectedPortKey || availablePorts.length === 0}
                            title="Revoke this page's permission for the selected port"
                        >
                            <Trash2 size={14} /> Forget
                        </button>
                        <select
                            className="pr-select"
                            value={baudRate}
                            onChange={(e) => setBaudRate(Number(e.target.value))}
                            disabled={connected}
                            title="Serial baud rate (default 9600 for Kloehn V6/V15C)"
                        >
                            {COMMON_BAUDS.map((b) => (
                                <option key={b} value={b}>
                                    {b} baud
                                </option>
                            ))}
                        </select>
                        <label className="pr-inline-label" title="Pump DIP-switch address (1–15)">
                            addr
                            <input
                                type="number"
                                min={1}
                                max={15}
                                value={pumpAddress}
                                onChange={(e) =>
                                    setPumpAddress(Math.max(1, Math.min(15, parseInt(e.target.value || '1', 10))))
                                }
                                disabled={connected}
                            />
                        </label>
                    </div>
                </div>
                <div className="pr-sep" />
                <div className="pr-tg">
                    <div className="pr-tg-label">Pump</div>
                    <div className="pr-tg-body">
                        <button
                            className="pr-toolbtn pr-toolbtn--primary"
                            onClick={handleInitialize}
                            disabled={!connected || programRunning}
                            title="Send W4R (homing). Required after power-on before any move."
                        >
                            <RotateCcw size={14} /> Init
                        </button>
                        <button
                            className="pr-toolbtn pr-toolbtn--danger"
                            onClick={handleHalt}
                            disabled={!connected}
                            title="Terminate buffered moves immediately (T)."
                        >
                            <StopIcon size={14} /> Halt
                        </button>
                        <button
                            className="pr-toolbtn"
                            onClick={refreshPosition}
                            disabled={!connected}
                            title="Re-read current syringe position"
                        >
                            <Activity size={14} /> Status
                        </button>
                    </div>
                </div>
                <div className="pr-spacer" />
                <div className="pr-status-pill" data-state={pumpReady === false ? 'busy' : connected ? 'ok' : 'idle'}>
                    <span className="pr-status-dot" />
                    {statusPill}
                </div>
                {pumpError && (
                    <div className="pr-status-pill pr-status-pill--warn">
                        <AlertTriangle size={12} /> {pumpError}
                    </div>
                )}
                <div className="pr-tg">
                    <div className="pr-tg-label">Help</div>
                    <div className="pr-tg-body">
                        <span
                            className="pr-help"
                            title={
                                'Printer talks to a Kloehn / Cavro VersaPump over Web Serial (Chrome/Edge over HTTPS or localhost).\n\n' +
                                'Workflow:\n' +
                                '  1) Connect → pick the USB-to-serial port for your pump.\n' +
                                '  2) Init   → homes the syringe (W4R). Required after power-on.\n' +
                                '  3) Pick syringe preset → calibrates nL/step.\n' +
                                '  4) Aspirate ink, then build a program of drops to print.\n\n' +
                                'Drop volume range: 100 nL → 500 nL. The pump prints discrete drops by issuing D<steps>R commands separated by your chosen delay.'
                            }
                        >
                            <HelpCircle size={14} />
                        </span>
                    </div>
                </div>
            </div>

            {!supported && (
                <div className="pr-banner pr-banner--warn">
                    <AlertTriangle size={14} /> Web Serial is not available in this browser. Use Chrome or Edge on HTTPS or localhost.
                </div>
            )}

            <div className="pr-main">
                {/* LEFT — syringe + jog */}
                <aside className="pr-side">
                    <div className="pr-section">
                        <div className="pr-section-title">
                            <Gauge size={13} aria-hidden /> Syringe
                        </div>
                        <select
                            className="pr-select pr-select--block"
                            value={presetId}
                            onChange={(e) => setPresetId(e.target.value)}
                        >
                            {SYRINGE_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.label}
                                </option>
                            ))}
                        </select>
                        <div className="pr-info-grid">
                            <div><span>Size</span><strong>{formatVolume(preset.syringeUl)}</strong></div>
                            <div><span>Stroke</span><strong>{preset.stroke.toLocaleString()} steps</strong></div>
                            <div><span>nL / step</span><strong>{preset.nlPerStep.toFixed(2)}</strong></div>
                            <div><span>Position</span><strong>{positionSteps.toLocaleString()} steps</strong></div>
                        </div>
                        <button
                            className="pr-toolbtn pr-toolbtn--xs"
                            onClick={handleDetectStroke}
                            disabled={!connected || programRunning}
                            title="Move plunger fully out and see whether the pump accepts position 48 000. If it rejects with err 3 the stroke is 24 000, otherwise 48 000."
                        >
                            <Sigma size={11} /> Auto-detect stroke (24 k / 48 k)
                        </button>
                    </div>

                    <div className="pr-section">
                        <div className="pr-section-title">
                            <Sigma size={13} aria-hidden /> Jog
                        </div>
                        <label className="pr-row">
                            <span>Top speed</span>
                            <input
                                type="number"
                                min={40}
                                max={10000}
                                value={topSpeedSps}
                                onChange={(e) => setTopSpeedSps(Math.max(40, Math.min(10000, Number(e.target.value) || 40)))}
                            />
                            <span className="pr-unit">sps</span>
                        </label>
                        <label className="pr-row">
                            <span>Jog volume</span>
                            <input
                                type="number"
                                step={0.1}
                                min={0.1}
                                value={jogVolumeUl}
                                onChange={(e) => setJogVolumeUl(Math.max(0.05, Number(e.target.value) || 0))}
                            />
                            <span className="pr-unit">µL</span>
                        </label>
                        <div className="pr-jog-row">
                            <button className="pr-toolbtn pr-toolbtn--primary" onClick={jogAspirate} disabled={!connected || programRunning}>
                                <ArrowUp size={14} /> Aspirate
                            </button>
                            <button className="pr-toolbtn" onClick={jogDispense} disabled={!connected || programRunning}>
                                <ArrowDown size={14} /> Dispense
                            </button>
                        </div>
                    </div>

                    <div className="pr-section">
                        <div className="pr-section-title">
                            <Droplet size={13} aria-hidden /> Drop preview
                        </div>
                        <label className="pr-row pr-row--col">
                            <span>
                                Drop volume:{' '}
                                <strong className="pr-drop-num">{dropVolumeNl} nL</strong>{' '}
                                <span className="pr-faint">
                                    = {dropStepsPerDrop} step{dropStepsPerDrop === 1 ? '' : 's'} ·
                                    actual {actualDropNl.toFixed(2)} nL
                                    {Math.abs(actualDropNl - dropVolumeNl) > 0.01 && (
                                        <>
                                            {' '}
                                            ({(actualDropNl - dropVolumeNl > 0 ? '+' : '') +
                                                (actualDropNl - dropVolumeNl).toFixed(2)}{' '}
                                            nL ·{' '}
                                            {((actualDropNl - dropVolumeNl) / dropVolumeNl * 100).toFixed(2)} %)
                                        </>
                                    )}
                                </span>
                            </span>
                            <input
                                type="range"
                                min={DROP_VOLUME_MIN_NL}
                                max={DROP_VOLUME_MAX_NL}
                                step={10}
                                value={dropVolumeNl}
                                onChange={(e) => setDropVolumeNl(parseInt(e.target.value, 10))}
                                className="pr-slider"
                            />
                            <div className="pr-slider-ticks">
                                <span>{DROP_VOLUME_MIN_NL} nL</span>
                                <span>300 nL</span>
                                <span>{DROP_VOLUME_MAX_NL} nL</span>
                            </div>
                        </label>
                        <label className="pr-row">
                            <span>Drops</span>
                            <input
                                type="number"
                                min={1}
                                value={dropCount}
                                onChange={(e) => setDropCount(Math.max(1, parseInt(e.target.value || '1', 10)))}
                            />
                            <span className="pr-unit">×</span>
                        </label>
                        <label className="pr-row">
                            <span>Gap</span>
                            <input
                                type="number"
                                min={0}
                                value={dropDelayMs}
                                onChange={(e) => setDropDelayMs(Math.max(0, parseInt(e.target.value || '0', 10)))}
                            />
                            <span className="pr-unit">ms</span>
                        </label>
                        <label className="pr-row">
                            <span>Drop speed</span>
                            <input
                                type="number"
                                min={40}
                                max={10000}
                                value={dropSpeedSps}
                                onChange={(e) =>
                                    setDropSpeedSps(Math.max(40, Math.min(10000, Number(e.target.value) || 40)))
                                }
                                title="Top speed for drop moves only. Keep low (~100–400 sps) — drops are tiny moves so high speed = harsh acceleration clicks."
                            />
                            <span className="pr-unit">sps</span>
                        </label>
                        <div className="pr-jog-row">
                            <button className="pr-toolbtn pr-toolbtn--accent" onClick={jogSingleDrop} disabled={!connected || programRunning}>
                                <Droplet size={14} /> Single drop
                            </button>
                            <button
                                className="pr-toolbtn"
                                onClick={() =>
                                    addStep('drop')
                                }
                                title="Add this drop config as a step in the program →"
                            >
                                <Plus size={14} /> Add to program
                            </button>
                        </div>
                        <div className="pr-precision">
                            <div className="pr-precision-title">Precision audit · {dropCount} × {dropVolumeNl} nL</div>
                            <div className="pr-precision-row">
                                <span>target</span>
                                <strong>{targetTrainNl} nL</strong>
                            </div>
                            <div className="pr-precision-row">
                                <span>without correction</span>
                                <strong>{naiveTrainNl.toFixed(2)} nL <span className="pr-faint">({((naiveTrainNl - targetTrainNl) / targetTrainNl * 100).toFixed(2)} %)</span></strong>
                            </div>
                            <div className="pr-precision-row pr-precision-row--ok">
                                <span>with dither (program)</span>
                                <strong>
                                    {ditheredTrainNl.toFixed(2)} nL{' '}
                                    <span className="pr-faint">
                                        ({((ditheredTrainNl - targetTrainNl) / targetTrainNl * 100).toFixed(3)} %)
                                    </span>
                                </strong>
                            </div>
                        </div>
                    </div>

                    <div className="pr-section">
                        <div className="pr-section-title">
                            <Droplet size={13} aria-hidden /> Priming
                        </div>
                        <div className="pr-faint" style={{ marginBottom: 2 }}>
                            Tube dimensions for the cylinder-volume estimate.
                            <em> Input</em> = reservoir → valve upper port; <em> output</em> = valve lower port → dispense tip.
                        </div>
                        <label className="pr-row">
                            <span>Input L</span>
                            <input
                                type="number"
                                step={1}
                                min={0}
                                value={primeInputLenMm}
                                onChange={(e) => setPrimeInputLenMm(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="pr-unit">mm</span>
                        </label>
                        <label className="pr-row">
                            <span>Input ID</span>
                            <input
                                type="number"
                                step={0.1}
                                min={0}
                                value={primeInputIdMm}
                                onChange={(e) => setPrimeInputIdMm(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="pr-unit">mm</span>
                        </label>
                        <label className="pr-row">
                            <span>Output L</span>
                            <input
                                type="number"
                                step={1}
                                min={0}
                                value={primeOutputLenMm}
                                onChange={(e) => setPrimeOutputLenMm(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="pr-unit">mm</span>
                        </label>
                        <label className="pr-row">
                            <span>Output ID</span>
                            <input
                                type="number"
                                step={0.1}
                                min={0}
                                value={primeOutputIdMm}
                                onChange={(e) => setPrimeOutputIdMm(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="pr-unit">mm</span>
                        </label>
                        <label className="pr-row">
                            <span>Safety</span>
                            <input
                                type="number"
                                min={0}
                                max={500}
                                step={5}
                                value={primeSafetyPct}
                                onChange={(e) => setPrimeSafetyPct(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="pr-unit">%</span>
                        </label>
                        <label className="pr-row">
                            <span>Speed</span>
                            <input
                                type="number"
                                min={40}
                                max={10000}
                                value={primeSpeedSps}
                                onChange={(e) =>
                                    setPrimeSpeedSps(Math.max(40, Math.min(10000, Number(e.target.value) || 40)))
                                }
                            />
                            <span className="pr-unit">sps</span>
                        </label>

                        <div className="pr-precision">
                            <div className="pr-precision-title">Plan</div>
                            <div className="pr-precision-row">
                                <span>Input tube volume</span>
                                <strong>{primePlan.vIn.toFixed(1)} µL</strong>
                            </div>
                            <div className="pr-precision-row">
                                <span>Output tube volume</span>
                                <strong>{primePlan.vOut.toFixed(1)} µL</strong>
                            </div>
                            <div className="pr-precision-row">
                                <span>Target volume (+{primeSafetyPct}%)</span>
                                <strong>{primePlan.targetUl.toFixed(1)} µL</strong>
                            </div>
                            <div className="pr-precision-row pr-precision-row--ok">
                                <span>Cycles needed</span>
                                <strong>
                                    {primePlan.cycles} × {preset.syringeUl} µL ={' '}
                                    {primePlan.totalMovedUl.toFixed(0)} µL moved
                                </strong>
                            </div>
                            <div className="pr-precision-row">
                                <span>Estimated time</span>
                                <strong>{formatSeconds(primeEtaSec)}</strong>
                            </div>
                        </div>

                        <div className="pr-jog-row">
                            <button
                                className="pr-toolbtn pr-toolbtn--primary"
                                onClick={handlePrimeNow}
                                disabled={!connected || programRunning}
                                title="Run priming directly: aspirate + dispense full syringe N times until tubes are filled."
                            >
                                <Play size={14} /> Prime now
                            </button>
                            <button
                                className="pr-toolbtn"
                                onClick={addPrimeStep}
                                disabled={programRunning}
                                title="Insert this priming configuration as a step in the program →"
                            >
                                <Plus size={14} /> Add to program
                            </button>
                        </div>
                    </div>

                    <div className="pr-section">
                        <div className="pr-section-title">
                            <Eraser size={13} aria-hidden /> Cleaning
                        </div>
                        <div className="pr-faint" style={{ marginBottom: 2 }}>
                            Flush the same tube geometry as Priming with a solvent (DI water, IPA, …).
                            The user is prompted to swap reservoir / waste container before the cycles start.
                        </div>
                        <label className="pr-row">
                            <span>Cycles</span>
                            <input
                                type="number"
                                min={1}
                                max={50}
                                value={cleanCycles}
                                onChange={(e) => setCleanCycles(Math.max(1, parseInt(e.target.value || '1', 10)))}
                                title="Full-syringe aspirate→dispense cycles. 5 is a thorough rinse; bump to 8–10 for stubborn inks."
                            />
                            <span className="pr-unit">×</span>
                        </label>
                        <label className="pr-row">
                            <span>Safety</span>
                            <input
                                type="number"
                                min={0}
                                max={500}
                                step={5}
                                value={cleanSafetyPct}
                                onChange={(e) => setCleanSafetyPct(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="pr-unit">%</span>
                        </label>
                        <label className="pr-row">
                            <span>Speed</span>
                            <input
                                type="number"
                                min={40}
                                max={10000}
                                value={cleanSpeedSps}
                                onChange={(e) =>
                                    setCleanSpeedSps(Math.max(40, Math.min(10000, Number(e.target.value) || 40)))
                                }
                            />
                            <span className="pr-unit">sps</span>
                        </label>
                        <label className="pr-row pr-row--col">
                            <span>Prompt</span>
                            <textarea
                                className="pr-textarea"
                                rows={3}
                                value={cleanPromptMessage}
                                onChange={(e) => setCleanPromptMessage(e.target.value)}
                                placeholder="Message shown to the user before flushing starts."
                            />
                        </label>
                        <div className="pr-precision">
                            <div className="pr-precision-title">Plan</div>
                            <div className="pr-precision-row">
                                <span>Cycles × Syringe</span>
                                <strong>{cleanCycles} × {preset.syringeUl} µL = {cleanCycles * preset.syringeUl} µL</strong>
                            </div>
                            <div className="pr-precision-row pr-precision-row--ok">
                                <span>Estimated time</span>
                                <strong>
                                    {formatSeconds(cleanCycles * (2 * preset.stroke / Math.max(40, cleanSpeedSps) + 1.5))}
                                </strong>
                            </div>
                        </div>
                        <div className="pr-jog-row">
                            <button
                                className="pr-toolbtn pr-toolbtn--primary"
                                onClick={handleCleanNow}
                                disabled={!connected || programRunning}
                                title="Run cleaning directly. You will be prompted to swap the reservoir to solvent first."
                            >
                                <Play size={14} /> Clean now
                            </button>
                            <button
                                className="pr-toolbtn"
                                onClick={addCleanStep}
                                disabled={programRunning}
                                title="Insert this cleaning configuration as a step in the program →"
                            >
                                <Plus size={14} /> Add to program
                            </button>
                        </div>
                        <div className="pr-faint">
                            Typical end‑of‑day sequence: <strong>Clean</strong> (DI water) →{' '}
                            <strong>Clean</strong> (IPA) → <strong>Clean</strong> (air — remove the input tube
                            when prompted) to dry the path.
                        </div>
                    </div>
                </aside>

                {/* CENTER — gauge */}
                <div className="pr-center">
                    <SyringeGauge
                        syringeUl={preset.syringeUl}
                        stroke={preset.stroke}
                        positionSteps={positionSteps}
                        connected={connected}
                        running={programRunning}
                    />
                    <div className="pr-gauge-info">
                        <div className="pr-gauge-tile">
                            <div className="pr-gauge-tile-label">Volume in syringe</div>
                            <div className="pr-gauge-tile-value">{formatVolume(fillVolumeUl)}</div>
                            <div className="pr-gauge-tile-sub">{fillPct.toFixed(1)} % of stroke</div>
                        </div>
                        <div className="pr-gauge-tile">
                            <div className="pr-gauge-tile-label">Configured drop</div>
                            <div className="pr-gauge-tile-value">{dropVolumeNl} nL</div>
                            <div className="pr-gauge-tile-sub">
                                {dropStepsPerDrop} steps · resolution {preset.nlPerStep.toFixed(2)} nL/step
                            </div>
                        </div>
                        <div className="pr-gauge-tile">
                            <div className="pr-gauge-tile-label">Program ETA</div>
                            <div className="pr-gauge-tile-value">{formatSeconds(programEtaSec)}</div>
                            <div className="pr-gauge-tile-sub">
                                {programSteps.filter((s) => s.enabled).length} step(s)
                            </div>
                        </div>
                    </div>
                </div>

                {/* RIGHT — program */}
                <aside className="pr-side pr-side--right">
                    <div className="pr-section">
                        <div className="pr-section-title pr-section-title--row">
                            <span><Settings2 size={13} aria-hidden /> Print program</span>
                            <div className="pr-program-actions">
                                {!programRunning ? (
                                    <button
                                        className="pr-toolbtn pr-toolbtn--primary"
                                        onClick={handleRunProgram}
                                        disabled={!connected}
                                        title="Run the program in order"
                                    >
                                        <Play size={14} /> Run
                                    </button>
                                ) : (
                                    <button
                                        className="pr-toolbtn pr-toolbtn--danger"
                                        onClick={handleStopProgram}
                                    >
                                        <Pause size={14} /> Stop
                                    </button>
                                )}
                            </div>
                        </div>

                        {programRunning && (
                            <div className="pr-progress">
                                <div className="pr-progress-bar">
                                    <div
                                        className="pr-progress-fill"
                                        style={{
                                            width: `${programProgress.totalSteps
                                                ? Math.min(100, (100 * programProgress.stepIdx) / programProgress.totalSteps)
                                                : 0}%`,
                                        }}
                                    />
                                </div>
                                <div className="pr-progress-text">
                                    Step {programProgress.stepIdx}/{programProgress.totalSteps} · {programProgress.message}
                                </div>
                            </div>
                        )}

                        <div className="pr-add-row">
                            <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => addStep('initialize')}>
                                <Plus size={12} /> Init
                            </button>
                            <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => addStep('valve')}>
                                <Plus size={12} /> Valve
                            </button>
                            <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => addStep('aspirate')}>
                                <Plus size={12} /> Aspirate
                            </button>
                            <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => addStep('drop')}>
                                <Plus size={12} /> Drop
                            </button>
                            <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => addStep('wait')}>
                                <Plus size={12} /> Wait
                            </button>
                            <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => addStep('dispenseAll')}>
                                <Plus size={12} /> Dispense all
                            </button>
                            <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => addStep('speed')}>
                                <Plus size={12} /> Set speed
                            </button>
                            <button
                                className="pr-toolbtn pr-toolbtn--xs"
                                onClick={addPrimeStep}
                                title="Insert a tube-priming step using the current Priming panel config"
                            >
                                <Plus size={12} /> Prime
                            </button>
                            <button
                                className="pr-toolbtn pr-toolbtn--xs"
                                onClick={addCleanStep}
                                title="Insert a cleaning step (prompts user to swap to solvent first)"
                            >
                                <Plus size={12} /> Clean
                            </button>
                            <button
                                className="pr-toolbtn pr-toolbtn--xs"
                                onClick={addPromptStep}
                                title="Pause the program until the user clicks OK on a custom message"
                            >
                                <Plus size={12} /> Prompt
                            </button>
                            <button
                                className="pr-toolbtn pr-toolbtn--xs pr-toolbtn--accent"
                                onClick={addLoopBlock}
                                title="Insert a Repeat / End repeat block. Click '+ Aspirate' etc. while the Repeat card is selected to drop new steps INSIDE the loop."
                            >
                                <Plus size={12} /> Loop
                            </button>
                        </div>

                        <ul className="pr-steps">
                            {stepsWithDepth.map(({ step, depth }, i) => (
                                <li
                                    key={step.id}
                                    className={`pr-step pr-step--${step.kind}${selectedStepId === step.id ? ' is-selected' : ''}${!step.enabled ? ' is-disabled' : ''}${
                                        programRunning && programProgress.stepIdx - 1 === i ? ' is-running' : ''
                                    }`}
                                    style={{ marginLeft: `${depth * 16}px` }}
                                    onClick={() => setSelectedStepId(step.id)}
                                >
                                    <div className="pr-step-head">
                                        <span className="pr-step-idx">{i + 1}</span>
                                        <span className="pr-step-kind">{step.kind}</span>
                                        <span className="pr-step-grow">{describeStep(step)}</span>
                                        <button
                                            className="pr-icon-btn"
                                            onClick={(e) => { e.stopPropagation(); updateStep(step.id, { enabled: !step.enabled }); }}
                                            title={step.enabled ? 'Disable this step' : 'Enable this step'}
                                        >
                                            {step.enabled ? '◉' : '○'}
                                        </button>
                                        <button className="pr-icon-btn" onClick={(e) => { e.stopPropagation(); moveStep(step.id, -1); }} title="Move up">
                                            <ChevronUp size={11} />
                                        </button>
                                        <button className="pr-icon-btn" onClick={(e) => { e.stopPropagation(); moveStep(step.id, 1); }} title="Move down">
                                            <ChevronDown size={11} />
                                        </button>
                                        <button className="pr-icon-btn" onClick={(e) => { e.stopPropagation(); duplicateStep(step.id); }} title="Duplicate">
                                            <CopyIcon size={11} />
                                        </button>
                                        <button className="pr-icon-btn pr-icon-btn--danger" onClick={(e) => { e.stopPropagation(); removeStep(step.id); }} title="Delete">
                                            <Trash2 size={11} />
                                        </button>
                                    </div>
                                    {selectedStepId === step.id && (
                                        <StepEditor step={step} update={(patch) => updateStep(step.id, patch)} />
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                </aside>
            </div>

            {/* USER-CONFIRM MODAL (shown when the executor pauses on a clean / prompt step) */}
            {pendingPrompt && (
                <div className="pr-modal-backdrop" role="alertdialog" aria-modal="true">
                    <div className="pr-modal">
                        <div className="pr-modal-title">{pendingPrompt.title}</div>
                        <div className="pr-modal-body">{pendingPrompt.message}</div>
                        <div className="pr-modal-actions">
                            <button className="pr-toolbtn pr-toolbtn--warn" onClick={() => handleConfirmResolve(false)}>
                                Cancel
                            </button>
                            <button
                                className="pr-toolbtn pr-toolbtn--primary"
                                onClick={() => handleConfirmResolve(true)}
                                autoFocus
                            >
                                {pendingPrompt.okLabel || 'OK'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* CONSOLE */}
            <div className="pr-console">
                <div className="pr-console-head">
                    <span><ChevronRight size={12} aria-hidden /> Console</span>
                    <button className="pr-toolbtn pr-toolbtn--xs" onClick={() => setLogLines([])}>
                        clear
                    </button>
                </div>
                <div className="pr-console-body">
                    {logLines.slice(-200).map((l, i) => (
                        <div key={i} className={`pr-log pr-log--${l.level}`}>
                            <span className="pr-log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
                            <span className="pr-log-text">{l.text}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/* ─────────────────────────────────────────────────────────────
 * Step editor — kind-specific inputs for the currently selected step
 * ───────────────────────────────────────────────────────────── */
function StepEditor({ step, update }) {
    if (step.kind === 'initialize') {
        return <div className="pr-step-edit pr-faint">Homes the plunger. No parameters.</div>;
    }
    if (step.kind === 'valve') {
        return (
            <div className="pr-step-edit">
                <div className="pr-step-edit-row">
                    <button
                        className={`pr-toolbtn${step.valve === 'input' ? ' is-active' : ''}`}
                        onClick={() => update({ valve: 'input' })}
                    >
                        Valve → input
                    </button>
                    <button
                        className={`pr-toolbtn${step.valve === 'output' ? ' is-active' : ''}`}
                        onClick={() => update({ valve: 'output' })}
                    >
                        Valve → output
                    </button>
                </div>
            </div>
        );
    }
    if (step.kind === 'aspirate') {
        return (
            <div className="pr-step-edit">
                <label className="pr-row">
                    <span>Volume</span>
                    <input
                        type="number"
                        step={0.1}
                        min={0.1}
                        value={step.volumeUl ?? 10}
                        onChange={(e) => update({ volumeUl: Math.max(0.05, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">µL</span>
                </label>
                <label className="pr-row">
                    <span>Top speed</span>
                    <input
                        type="number"
                        min={40}
                        max={10000}
                        value={step.speedSps ?? 2000}
                        onChange={(e) => update({ speedSps: Math.max(40, Math.min(10000, Number(e.target.value) || 40)) })}
                    />
                    <span className="pr-unit">sps</span>
                </label>
            </div>
        );
    }
    if (step.kind === 'dispenseAll') {
        return (
            <div className="pr-step-edit">
                <label className="pr-row">
                    <span>Top speed</span>
                    <input
                        type="number"
                        min={40}
                        max={10000}
                        value={step.speedSps ?? 200}
                        onChange={(e) => update({ speedSps: Math.max(40, Math.min(10000, Number(e.target.value) || 40)) })}
                    />
                    <span className="pr-unit">sps</span>
                </label>
            </div>
        );
    }
    if (step.kind === 'drop') {
        return (
            <div className="pr-step-edit">
                <label className="pr-row pr-row--col">
                    <span>Drop volume: <strong>{step.volumeNl} nL</strong></span>
                    <input
                        type="range"
                        min={DROP_VOLUME_MIN_NL}
                        max={DROP_VOLUME_MAX_NL}
                        step={10}
                        value={step.volumeNl ?? 200}
                        onChange={(e) => update({ volumeNl: parseInt(e.target.value, 10) })}
                        className="pr-slider"
                    />
                    <div className="pr-slider-ticks">
                        <span>{DROP_VOLUME_MIN_NL} nL</span>
                        <span>{DROP_VOLUME_MAX_NL} nL</span>
                    </div>
                </label>
                <label className="pr-row">
                    <span>Count</span>
                    <input
                        type="number"
                        min={1}
                        value={step.count ?? 1}
                        onChange={(e) => update({ count: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                    />
                    <span className="pr-unit">×</span>
                </label>
                <label className="pr-row">
                    <span>Gap</span>
                    <input
                        type="number"
                        min={0}
                        value={step.delayMs ?? 0}
                        onChange={(e) => update({ delayMs: Math.max(0, parseInt(e.target.value || '0', 10)) })}
                    />
                    <span className="pr-unit">ms</span>
                </label>
                <label className="pr-row">
                    <span>Top speed</span>
                    <input
                        type="number"
                        min={40}
                        max={10000}
                        value={step.speedSps ?? 200}
                        onChange={(e) => update({ speedSps: Math.max(40, Math.min(10000, Number(e.target.value) || 40)) })}
                    />
                    <span className="pr-unit">sps</span>
                </label>
            </div>
        );
    }
    if (step.kind === 'wait') {
        return (
            <div className="pr-step-edit">
                <label className="pr-row">
                    <span>Duration</span>
                    <input
                        type="number"
                        min={0}
                        value={step.delayMs ?? 0}
                        onChange={(e) => update({ delayMs: Math.max(0, parseInt(e.target.value || '0', 10)) })}
                    />
                    <span className="pr-unit">ms</span>
                </label>
            </div>
        );
    }
    if (step.kind === 'speed') {
        return (
            <div className="pr-step-edit">
                <label className="pr-row">
                    <span>Top speed</span>
                    <input
                        type="number"
                        min={40}
                        max={10000}
                        value={step.speedSps ?? 2000}
                        onChange={(e) => update({ speedSps: Math.max(40, Math.min(10000, Number(e.target.value) || 40)) })}
                    />
                    <span className="pr-unit">sps</span>
                </label>
            </div>
        );
    }
    if (step.kind === 'loopStart') {
        return (
            <div className="pr-step-edit">
                <label className="pr-row">
                    <span>Repeat</span>
                    <input
                        type="number"
                        min={1}
                        max={9999}
                        value={step.count ?? 1}
                        onChange={(e) => update({ count: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                    />
                    <span className="pr-unit">×</span>
                </label>
                <div className="pr-faint">
                    All enabled steps between this card and the matching{' '}
                    <strong>End repeat</strong> are executed this many times. Nested
                    Repeat blocks are supported. Select this card and click any{' '}
                    <em>+&nbsp;Step</em> button to add steps inside the loop.
                </div>
            </div>
        );
    }
    if (step.kind === 'loopEnd') {
        return (
            <div className="pr-step-edit pr-faint">
                Closes the matching <strong>Repeat</strong> block above. No parameters.
            </div>
        );
    }
    if (step.kind === 'clean') {
        const vIn = tubeVolumeUl(step.inputTubeLengthMm, step.inputTubeIdMm);
        const vOut = tubeVolumeUl(step.outputTubeLengthMm, step.outputTubeIdMm);
        return (
            <div className="pr-step-edit">
                <label className="pr-row">
                    <span>Cycles</span>
                    <input
                        type="number"
                        min={1}
                        max={50}
                        value={step.cycles ?? 5}
                        onChange={(e) => update({ cycles: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                    />
                    <span className="pr-unit">×</span>
                </label>
                <label className="pr-row">
                    <span>Input L</span>
                    <input
                        type="number"
                        min={0}
                        value={step.inputTubeLengthMm ?? 0}
                        onChange={(e) => update({ inputTubeLengthMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Input ID</span>
                    <input
                        type="number"
                        step={0.1}
                        min={0}
                        value={step.inputTubeIdMm ?? 0}
                        onChange={(e) => update({ inputTubeIdMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Output L</span>
                    <input
                        type="number"
                        min={0}
                        value={step.outputTubeLengthMm ?? 0}
                        onChange={(e) => update({ outputTubeLengthMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Output ID</span>
                    <input
                        type="number"
                        step={0.1}
                        min={0}
                        value={step.outputTubeIdMm ?? 0}
                        onChange={(e) => update({ outputTubeIdMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Speed</span>
                    <input
                        type="number"
                        min={40}
                        max={10000}
                        value={step.speedSps ?? 4000}
                        onChange={(e) => update({ speedSps: Math.max(40, Math.min(10000, Number(e.target.value) || 40)) })}
                    />
                    <span className="pr-unit">sps</span>
                </label>
                <label className="pr-row pr-row--col">
                    <span>Prompt</span>
                    <textarea
                        className="pr-textarea"
                        rows={3}
                        value={step.promptMessage ?? ''}
                        onChange={(e) => update({ promptMessage: e.target.value })}
                        placeholder="Message shown to the user before flushing. Leave blank to skip the prompt."
                    />
                </label>
                <div className="pr-faint">
                    Will move {(step.cycles || 5) * 250} µL (assuming 250 µL syringe) — tubes hold{' '}
                    {(vIn + vOut).toFixed(1)} µL combined.
                </div>
            </div>
        );
    }
    if (step.kind === 'prompt') {
        return (
            <div className="pr-step-edit">
                <label className="pr-row pr-row--col">
                    <span>Title</span>
                    <input
                        type="text"
                        value={step.promptTitle ?? ''}
                        onChange={(e) => update({ promptTitle: e.target.value })}
                        placeholder="Continue"
                    />
                </label>
                <label className="pr-row pr-row--col">
                    <span>Message</span>
                    <textarea
                        className="pr-textarea"
                        rows={3}
                        value={step.message ?? ''}
                        onChange={(e) => update({ message: e.target.value })}
                        placeholder="e.g. Place DI water at the input port. Click OK to continue."
                    />
                </label>
                <div className="pr-faint">
                    Program execution pauses on this step until the user clicks OK. Clicking Cancel stops the program.
                </div>
            </div>
        );
    }
    if (step.kind === 'prime') {
        const vIn = tubeVolumeUl(step.inputTubeLengthMm, step.inputTubeIdMm);
        const vOut = tubeVolumeUl(step.outputTubeLengthMm, step.outputTubeIdMm);
        const safetyPct = step.safetyPct ?? 25;
        const target = (vIn + vOut) * (1 + safetyPct / 100);
        return (
            <div className="pr-step-edit">
                <label className="pr-row">
                    <span>Input L</span>
                    <input
                        type="number"
                        min={0}
                        value={step.inputTubeLengthMm ?? 0}
                        onChange={(e) => update({ inputTubeLengthMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Input ID</span>
                    <input
                        type="number"
                        step={0.1}
                        min={0}
                        value={step.inputTubeIdMm ?? 0}
                        onChange={(e) => update({ inputTubeIdMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Output L</span>
                    <input
                        type="number"
                        min={0}
                        value={step.outputTubeLengthMm ?? 0}
                        onChange={(e) => update({ outputTubeLengthMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Output ID</span>
                    <input
                        type="number"
                        step={0.1}
                        min={0}
                        value={step.outputTubeIdMm ?? 0}
                        onChange={(e) => update({ outputTubeIdMm: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">mm</span>
                </label>
                <label className="pr-row">
                    <span>Safety</span>
                    <input
                        type="number"
                        min={0}
                        max={500}
                        step={5}
                        value={step.safetyPct ?? 25}
                        onChange={(e) => update({ safetyPct: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="pr-unit">%</span>
                </label>
                <label className="pr-row">
                    <span>Speed</span>
                    <input
                        type="number"
                        min={40}
                        max={10000}
                        value={step.speedSps ?? 4000}
                        onChange={(e) =>
                            update({ speedSps: Math.max(40, Math.min(10000, Number(e.target.value) || 40)) })
                        }
                    />
                    <span className="pr-unit">sps</span>
                </label>
                <div className="pr-faint">
                    Tubes are modelled as perfect cylinders (V = π·r²·L).
                    Estimated target: <strong>{target.toFixed(1)} µL</strong>{' '}
                    (input {vIn.toFixed(1)} µL + output {vOut.toFixed(1)} µL + {safetyPct}% margin).
                </div>
            </div>
        );
    }
    return null;
}

/* ─────────────────────────────────────────────────────────────
 * Animated syringe gauge (SVG)
 *
 * Compact, slender layout that fits inside the centre column:
 *   y=0  ┃───── label "syringe (µL)"
 *        ┃  ░  ← thumb flange      ┐
 *        ┃  │  ← rod (rigid)       │ moves as one
 *        ┃  ●  ← plunger seal      ┘
 *        ┃══════ barrel top flange
 *        ┃ ░░░  barrel (glass) + ink fill (animated)
 *        ┃══════ taper
 *        ┃   |  needle
 *        ┃───── label "dispense tip"
 *   y=420
 *
 * The plunger + rod + thumb assembly translates as a single `<g>` with a CSS
 * transform transition, so the piston smoothly slides when the pump moves.
 * The ink-fill rect uses CSS transitions on `y` + `height` (supported in
 * modern Chromium / WebKit / Gecko for SVG geometry attributes).
 * ───────────────────────────────────────────────────────────── */

/* Geometry constants for the syringe drawing (viewBox units). */
const SG_W = 220;
const SG_H = 420;
const SG_BARREL_X = 60;
const SG_BARREL_Y = 170;
const SG_BARREL_W = 100;
const SG_BARREL_H = 170;
const SG_SEAL_H = 14;
const SG_ROD_W = 16;
const SG_THUMB_W = 70;
const SG_THUMB_H = 9;
const SG_ROD_LEN = SG_BARREL_H - SG_SEAL_H; // rod fits exactly so empty → thumb at barrel top
const SG_TIP_H = 28;

function SyringeGauge({ syringeUl, stroke, positionSteps, connected, running }) {
    const pct = stepsToFillPercent(positionSteps, stroke);
    /* dy_seal = how far the seal moves down from its top-most (full) pose. */
    const dy = (1 - pct / 100) * (SG_BARREL_H - SG_SEAL_H);

    /* Anchors when the plunger is at the top of its travel (full). */
    const sealTopFull = SG_BARREL_Y; // seal top is at barrel top
    const rodTopFull = sealTopFull - SG_ROD_LEN; // rod stops just below thumb
    const thumbTopFull = rodTopFull - SG_THUMB_H;

    /* Live (animated) anchors. */
    const sealTop = sealTopFull + dy;
    const fillY = sealTop + SG_SEAL_H;
    const fillH = SG_BARREL_Y + SG_BARREL_H - fillY;

    const barrelBottom = SG_BARREL_Y + SG_BARREL_H;
    const tipY = barrelBottom;
    const cx = SG_W / 2;

    return (
        <svg
            className="pr-gauge"
            viewBox={`0 0 ${SG_W} ${SG_H}`}
            aria-hidden
            preserveAspectRatio="xMidYMid meet"
        >
            <defs>
                <linearGradient id="prInk" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#7dd3fc" stopOpacity="0.95" />
                    <stop offset="60%" stopColor="#38bdf8" stopOpacity="0.85" />
                    <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.7" />
                </linearGradient>
                <linearGradient id="prBarrelGlass" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="rgba(15,23,42,0.9)" />
                    <stop offset="35%" stopColor="rgba(15,23,42,0.55)" />
                    <stop offset="55%" stopColor="rgba(15,23,42,0.35)" />
                    <stop offset="78%" stopColor="rgba(15,23,42,0.55)" />
                    <stop offset="100%" stopColor="rgba(15,23,42,0.9)" />
                </linearGradient>
                <linearGradient id="prPlunger" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#475569" />
                    <stop offset="48%" stopColor="#94a3b8" />
                    <stop offset="100%" stopColor="#334155" />
                </linearGradient>
                <linearGradient id="prRod" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#334155" />
                    <stop offset="50%" stopColor="#94a3b8" />
                    <stop offset="100%" stopColor="#1e293b" />
                </linearGradient>
                <filter id="prInkBlur" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="0.4" />
                </filter>
                {/* Clip everything inside the barrel so the ink fill never bleeds. */}
                <clipPath id="prBarrelClip">
                    <rect
                        x={SG_BARREL_X + 2}
                        y={SG_BARREL_Y + 4}
                        width={SG_BARREL_W - 4}
                        height={SG_BARREL_H - 6}
                        rx={3}
                    />
                </clipPath>
            </defs>

            {/* Top label */}
            <text x={cx} y={18} fill="#94a3b8" fontSize="10" textAnchor="middle">
                syringe (µL)
            </text>

            {/* Barrel glass body (drawn first so plunger sits *inside* it visually) */}
            <rect
                x={SG_BARREL_X}
                y={SG_BARREL_Y}
                width={SG_BARREL_W}
                height={SG_BARREL_H}
                rx={6}
                ry={6}
                fill="url(#prBarrelGlass)"
                stroke="rgba(148,163,184,0.55)"
                strokeWidth={1.2}
            />

            {/* Ink fill — clipped to barrel interior, animates via CSS on y/height */}
            <g clipPath="url(#prBarrelClip)">
                <rect
                    className="pr-gauge-fill"
                    x={SG_BARREL_X + 2}
                    y={fillY}
                    width={SG_BARREL_W - 4}
                    height={Math.max(0, fillH)}
                    fill="url(#prInk)"
                    opacity={connected ? 0.95 : 0.55}
                    filter="url(#prInkBlur)"
                />
                {/* Meniscus highlight */}
                <rect
                    className="pr-gauge-fill"
                    x={SG_BARREL_X + 2}
                    y={fillY}
                    width={SG_BARREL_W - 4}
                    height={Math.min(3, Math.max(0, fillH))}
                    fill="rgba(255,255,255,0.35)"
                />
            </g>

            {/* Glass highlights on the barrel (vertical streaks for the curved-cylinder look) */}
            <rect
                x={SG_BARREL_X + 6}
                y={SG_BARREL_Y + 6}
                width={5}
                height={SG_BARREL_H - 12}
                fill="rgba(255,255,255,0.08)"
                rx={2}
                pointerEvents="none"
            />
            <rect
                x={SG_BARREL_X + SG_BARREL_W - 11}
                y={SG_BARREL_Y + 6}
                width={3}
                height={SG_BARREL_H - 12}
                fill="rgba(255,255,255,0.05)"
                rx={2}
                pointerEvents="none"
            />

            {/* Plunger assembly (animated as one rigid group) */}
            <g
                className={`pr-gauge-plunger${running ? ' is-running' : ''}`}
                style={{ transform: `translate(0px, ${dy}px)` }}
            >
                {/* Thumb flange */}
                <rect
                    x={cx - SG_THUMB_W / 2}
                    y={thumbTopFull}
                    width={SG_THUMB_W}
                    height={SG_THUMB_H}
                    rx={3}
                    fill="url(#prPlunger)"
                    stroke="rgba(15,23,42,0.6)"
                    strokeWidth={0.8}
                />
                <rect
                    x={cx - SG_THUMB_W / 2 + 4}
                    y={thumbTopFull + 1.5}
                    width={SG_THUMB_W - 8}
                    height={1.5}
                    fill="rgba(255,255,255,0.35)"
                />
                {/* Rod */}
                <rect
                    x={cx - SG_ROD_W / 2}
                    y={rodTopFull}
                    width={SG_ROD_W}
                    height={SG_ROD_LEN}
                    rx={2}
                    fill="url(#prRod)"
                    stroke="rgba(15,23,42,0.55)"
                    strokeWidth={0.6}
                />
                {/* Specular line down the rod */}
                <rect
                    x={cx - SG_ROD_W / 2 + 2}
                    y={rodTopFull + 1}
                    width={2}
                    height={SG_ROD_LEN - 2}
                    fill="rgba(255,255,255,0.18)"
                />
                {/* Plunger seal (with rim shading) */}
                <rect
                    x={SG_BARREL_X + 3}
                    y={sealTopFull}
                    width={SG_BARREL_W - 6}
                    height={SG_SEAL_H}
                    rx={3}
                    fill="url(#prPlunger)"
                    stroke="rgba(15,23,42,0.6)"
                    strokeWidth={0.7}
                />
                <rect
                    x={SG_BARREL_X + 4}
                    y={sealTopFull + 2}
                    width={SG_BARREL_W - 8}
                    height={2}
                    fill="rgba(255,255,255,0.25)"
                />
                <rect
                    x={SG_BARREL_X + 4}
                    y={sealTopFull + SG_SEAL_H - 4}
                    width={SG_BARREL_W - 8}
                    height={2}
                    fill="rgba(15,23,42,0.5)"
                />
            </g>

            {/* Barrel top flange (drawn after plunger so it overlaps the rod entering the barrel) */}
            <rect
                x={SG_BARREL_X - 14}
                y={SG_BARREL_Y - 5}
                width={SG_BARREL_W + 28}
                height={9}
                rx={3}
                fill="url(#prPlunger)"
                stroke="rgba(15,23,42,0.65)"
                strokeWidth={0.8}
            />

            {/* Scale ticks on the right wall */}
            {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                const y = SG_BARREL_Y + t * SG_BARREL_H;
                const label = `${Math.round(syringeUl * (1 - t))}`;
                return (
                    <g key={t}>
                        <line
                            x1={SG_BARREL_X + SG_BARREL_W - 12}
                            y1={y}
                            x2={SG_BARREL_X + SG_BARREL_W - 3}
                            y2={y}
                            stroke="rgba(255,255,255,0.45)"
                            strokeWidth={0.8}
                        />
                        <text
                            x={SG_BARREL_X + SG_BARREL_W + 6}
                            y={y + 3}
                            fill="#94a3b8"
                            fontSize="9"
                        >
                            {label}
                        </text>
                    </g>
                );
            })}

            {/* Tapered tip */}
            <polygon
                points={`${SG_BARREL_X + SG_BARREL_W * 0.22},${tipY}
                         ${SG_BARREL_X + SG_BARREL_W * 0.78},${tipY}
                         ${cx + 4},${tipY + SG_TIP_H * 0.7}
                         ${cx - 4},${tipY + SG_TIP_H * 0.7}`}
                fill="url(#prPlunger)"
                stroke="rgba(15,23,42,0.65)"
                strokeWidth={0.8}
            />
            {/* Needle */}
            <rect
                x={cx - 1.4}
                y={tipY + SG_TIP_H * 0.7}
                width={2.8}
                height={SG_TIP_H * 0.5}
                fill="#cbd5e1"
                stroke="rgba(15,23,42,0.5)"
                strokeWidth={0.3}
            />

            {/* Bottom label */}
            <text x={cx} y={tipY + SG_TIP_H + 18} fill="#94a3b8" fontSize="10" textAnchor="middle">
                dispense tip
            </text>

            {/* Live activity: pulsing drop + glow at the needle when running */}
            {running && (
                <g pointerEvents="none">
                    <circle cx={cx} cy={tipY + SG_TIP_H + 4} r={6} fill="rgba(56,189,248,0.5)">
                        <animate attributeName="r" values="3;10;3" dur="0.9s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.9;0;0.9" dur="0.9s" repeatCount="indefinite" />
                    </circle>
                    <circle cx={cx} cy={tipY + SG_TIP_H + 4} r={2.5} fill="#38bdf8">
                        <animate attributeName="cy"
                                 values={`${tipY + SG_TIP_H + 4};${tipY + SG_TIP_H + 16};${tipY + SG_TIP_H + 4}`}
                                 dur="0.9s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="1;0;1" dur="0.9s" repeatCount="indefinite" />
                    </circle>
                </g>
            )}
        </svg>
    );
}

/* ─────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────── */
function formatSeconds(s) {
    if (!Number.isFinite(s) || s <= 0) return '—';
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}m ${r}s`;
}
