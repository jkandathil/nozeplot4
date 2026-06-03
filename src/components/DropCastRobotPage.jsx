import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Bot, Plug, OctagonX, Crosshair, Hand, Lightbulb, Play, Pause,
    Square, Plus, Trash2, ChevronUp, ChevronDown, Save, Wand2,
    Target, RotateCcw, Power, Gauge, CircleDot, Eraser, Download,
} from 'lucide-react';
import './DropCastRobotPage.css';
import { isWebSerialSupported, SerialIO } from '../arduino/serialIO.js';
import { AndrewRobot } from '../robot/andrewRobot.js';
import {
    LOCATION_TYPES, STEP_TYPES,
    loadLocations, saveLocations, loadPrograms, savePrograms, loadConfig, saveConfig,
    makeStep, makeProgram, makeStarterProgram, describeStep, poseIsComplete,
    runProgram,
} from '../robot/dropProgram.js';

const SERVO_BAUD = 250000;
const LED_BAUD = 9600;

const JOG_JOINTS = [
    { key: 'shoulder', label: 'Shoulder' },
    { key: 'elbow', label: 'Elbow' },
    { key: 'wrist', label: 'Wrist' },
    { key: 'linear', label: 'Linear (Z)' },
    { key: 'thumb', label: 'Thumb' },
    { key: 'gripper', label: 'Gripper' },
];

const rowLetter = (i) => String.fromCharCode(65 + i);
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export default function DropCastRobotPage() {
    const supported = isWebSerialSupported();

    // ── serial / robot refs ────────────────────────────────────────────
    const servoPortRef = useRef(null);
    const servoIORef = useRef(null);
    const ledPortRef = useRef(null);
    const ledIORef = useRef(null);
    const robotRef = useRef(null);
    const stopFlag = useRef(false);
    const pauseFlag = useRef(false);

    const [servoConnected, setServoConnected] = useState(false);
    const [ledConnected, setLedConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [running, setRunning] = useState(false);
    const [paused, setPaused] = useState(false);
    const [currentStep, setCurrentStep] = useState(-1);
    const [freeMove, setFreeMove] = useState(false);
    const [positions, setPositions] = useState({});
    const [jogStep, setJogStep] = useState(25);

    // ── persisted state ─────────────────────────────────────────────────
    const [config, setConfig] = useState(() => loadConfig());
    const [locations, setLocations] = useState(() => loadLocations());
    const [programs, setPrograms] = useState(() => {
        const p = loadPrograms();
        return p.length ? p : [makeStarterProgram()];
    });
    const [activeProgramId, setActiveProgramId] = useState(() => null);
    const [selectedKey, setSelectedKey] = useState(null);
    const [log, setLog] = useState([]);

    const logRef = useRef(null);
    const appendLog = useCallback((msg) => {
        const line = typeof msg === 'string' ? msg : String(msg);
        setLog((prev) => [...prev.slice(-400), line]);
    }, []);

    useEffect(() => {
        if (!activeProgramId && programs.length) setActiveProgramId(programs[0].id);
    }, [programs, activeProgramId]);

    useEffect(() => saveLocations(locations), [locations]);
    useEffect(() => savePrograms(programs), [programs]);
    useEffect(() => saveConfig(config), [config]);
    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [log]);

    const activeProgram = useMemo(
        () => programs.find((p) => p.id === activeProgramId) || null,
        [programs, activeProgramId],
    );

    // ── location helpers ───────────────────────────────────────────────
    const locByKey = useCallback((key) => locations.find((l) => l.key === key) || null, [locations]);

    const upsertLocation = useCallback((key, type, name, pose) => {
        setLocations((prev) => {
            const idx = prev.findIndex((l) => l.key === key);
            if (idx >= 0) {
                const next = [...prev];
                next[idx] = { ...next[idx], type, name, ...(pose !== undefined ? { pose } : {}) };
                return next;
            }
            return [...prev, { id: uid(), key, type, name, pose: pose ?? null }];
        });
    }, []);

    const clearLocationPose = useCallback((key) => {
        setLocations((prev) => prev.map((l) => (l.key === key ? { ...l, pose: null } : l)));
    }, []);

    // Deck cell descriptors derived from config
    const deck = config.deck;
    const slotCells = useMemo(
        () => Array.from({ length: deck.pipetteSlots }, (_, i) => ({ key: `slot-${i + 1}`, type: 'pipetteSlot', name: `Slot ${i + 1}` })),
        [deck.pipetteSlots],
    );
    const wellCells = useMemo(() => {
        const out = [];
        for (let r = 0; r < deck.sourceRows; r += 1)
            for (let c = 0; c < deck.sourceCols; c += 1)
                out.push({ key: `well-${r}-${c}`, type: 'sourceWell', name: `Well ${rowLetter(r)}${c + 1}`, r, c });
        return out;
    }, [deck.sourceRows, deck.sourceCols]);
    const spotCells = useMemo(() => {
        const out = [];
        for (let r = 0; r < deck.substrateRows; r += 1)
            for (let c = 0; c < deck.substrateCols; c += 1)
                out.push({ key: `spot-${r}-${c}`, type: 'substrate', name: `Spot ${r + 1},${c + 1}`, r, c });
        return out;
    }, [deck.substrateRows, deck.substrateCols]);

    const locationsByType = useCallback(
        (type) => locations.filter((l) => l.type === type),
        [locations],
    );

    // ── connection ─────────────────────────────────────────────────────
    const ensureRobot = useCallback(() => {
        if (!robotRef.current) {
            robotRef.current = new AndrewRobot({
                servoIO: servoIORef.current,
                ledIO: ledIORef.current,
                config,
                onLog: appendLog,
            });
        } else {
            robotRef.current.cfg = { ...robotRef.current.cfg, ...config };
            robotRef.current.ledIO = ledIORef.current;
        }
        return robotRef.current;
    }, [config, appendLog]);

    const connectServo = useCallback(async () => {
        if (!supported) return;
        try {
            setBusy(true);
            const port = await navigator.serial.requestPort();
            const io = new SerialIO(port);
            await io.open(SERVO_BAUD);
            servoPortRef.current = port;
            servoIORef.current = io;
            const robot = ensureRobot();
            robot.dxl.io = io;
            appendLog('[conn] Servo bus opened @ 250000 baud. Pinging servos…');
            const present = await robot.ping();
            const found = Object.entries(present).filter(([, ok]) => ok).map(([j]) => j);
            appendLog(`[conn] Servos responding: ${found.length ? found.join(', ') : 'none (check wiring / VCP driver)'}`);
            await robot.setMaxSpeed(config.MAX_SPEED);
            setServoConnected(true);
        } catch (e) {
            if (e?.name !== 'NotFoundError') appendLog(`[conn] Servo connect failed: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    }, [supported, ensureRobot, appendLog, config.MAX_SPEED]);

    const connectLed = useCallback(async () => {
        if (!supported) return;
        try {
            setBusy(true);
            const port = await navigator.serial.requestPort();
            const io = new SerialIO(port);
            await io.open(LED_BAUD);
            ledPortRef.current = port;
            ledIORef.current = io;
            ensureRobot().ledIO = io;
            setLedConnected(true);
            appendLog('[conn] LED controller opened @ 9600 baud.');
        } catch (e) {
            if (e?.name !== 'NotFoundError') appendLog(`[conn] LED connect failed: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    }, [supported, ensureRobot, appendLog]);

    const disconnectAll = useCallback(async () => {
        stopFlag.current = true;
        try {
            await robotRef.current?.disableAllTorque();
        } catch {
            /* ignore */
        }
        try {
            await servoIORef.current?.close();
        } catch {
            /* ignore */
        }
        try {
            await ledIORef.current?.close();
        } catch {
            /* ignore */
        }
        servoIORef.current = null;
        ledIORef.current = null;
        servoPortRef.current = null;
        ledPortRef.current = null;
        robotRef.current = null;
        setServoConnected(false);
        setLedConnected(false);
        appendLog('[conn] Disconnected.');
    }, [appendLog]);

    // E-STOP: kill torque immediately and abort any motion / program.
    const eStop = useCallback(async () => {
        stopFlag.current = true;
        pauseFlag.current = false;
        setPaused(false);
        try {
            robotRef.current?.abort();
            await robotRef.current?.disableAllTorque();
            appendLog('[E-STOP] Torque disabled on all servos.');
        } catch (e) {
            appendLog(`[E-STOP] ${e?.message || e}`);
        }
        setRunning(false);
        setFreeMove(true);
    }, [appendLog]);

    // ── live position polling (idle only) ───────────────────────────────
    useEffect(() => {
        if (!servoConnected) return undefined;
        let cancelled = false;
        const tick = async () => {
            if (cancelled || running || !robotRef.current) return;
            try {
                const pos = await robotRef.current.readAllPositions(
                    ['shoulder', 'elbow', 'wrist', 'linear', 'thumb', 'gripper'],
                );
                if (!cancelled) setPositions(pos);
            } catch {
                /* ignore */
            }
        };
        const id = setInterval(tick, 700);
        tick();
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [servoConnected, running]);

    // ── teaching / jog ──────────────────────────────────────────────────
    const toggleFreeMove = useCallback(async () => {
        const robot = robotRef.current;
        if (!robot) return;
        try {
            setBusy(true);
            if (!freeMove) {
                await robot.disableAllTorque();
                appendLog('[teach] Torque OFF — move the arm by hand, then Capture.');
                setFreeMove(true);
            } else {
                await robot.enableAllTorque();
                appendLog('[teach] Torque ON — arm holds position.');
                setFreeMove(false);
            }
        } catch (e) {
            appendLog(`[teach] ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    }, [freeMove, appendLog]);

    const jog = useCallback(async (joint, dir) => {
        const robot = robotRef.current;
        if (!robot) return;
        try {
            const cur = await robot.readPosition(joint);
            if (cur == null) return;
            const target = Math.max(0, Math.min(4095, cur + dir * jogStep));
            await robot.moveUnsafe({ [joint]: target }, { wait: false });
            setPositions((p) => ({ ...p, [joint]: target }));
        } catch (e) {
            appendLog(`[jog] ${e?.message || e}`);
        }
    }, [jogStep, appendLog]);

    const capturePose = useCallback(async () => {
        const robot = robotRef.current;
        if (!robot || !selectedKey) return;
        const cell = [...slotCells, ...wellCells, ...spotCells,
            { key: 'home', type: 'home', name: 'Home' },
            { key: 'safe', type: 'safe', name: 'Safe point' },
            { key: 'eject', type: 'eject', name: 'Eject / release' },
        ].find((c) => c.key === selectedKey);
        if (!cell) return;
        try {
            setBusy(true);
            const pose = await robot.readAllPositions(['shoulder', 'elbow', 'wrist', 'linear', 'thumb', 'gripper']);
            upsertLocation(cell.key, cell.type, cell.name, pose);
            appendLog(`[teach] Captured "${cell.name}": S${pose.shoulder} E${pose.elbow} W${pose.wrist} Z${pose.linear}`);
        } catch (e) {
            appendLog(`[teach] capture failed: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    }, [selectedKey, slotCells, wellCells, spotCells, upsertLocation, appendLog]);

    const gotoLocation = useCallback(async (key) => {
        const robot = robotRef.current;
        const l = locByKey(key);
        if (!robot || !l || !poseIsComplete(l.pose)) return;
        try {
            setBusy(true);
            robot.clearAbort();
            stopFlag.current = false;
            appendLog(`[move] Going to "${l.name}"…`);
            await robot.moveServos({ shoulder: l.pose.shoulder, elbow: l.pose.elbow, wrist: l.pose.wrist, linear: config.SAFE_HEIGHT });
            await robot.moveServos({ linear: l.pose.linear });
        } catch (e) {
            appendLog(`[move] ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    }, [locByKey, appendLog, config.SAFE_HEIGHT]);

    // Manual actuator tests
    const manual = useCallback(async (fn, label) => {
        const robot = robotRef.current;
        if (!robot) return;
        try {
            setBusy(true);
            robot.clearAbort();
            await fn(robot);
        } catch (e) {
            appendLog(`[manual] ${label}: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    }, [appendLog]);

    // ── program editing ─────────────────────────────────────────────────
    const updateProgram = useCallback((updater) => {
        setPrograms((prev) => prev.map((p) => (p.id === activeProgramId ? updater(p) : p)));
    }, [activeProgramId]);

    const addStep = useCallback((type) => {
        const defaults = {
            setVolume: { volumeUl: 2 },
            aspirate: { sourceLocationId: null, dwellMs: 800 },
            dispense: { targetLocationId: null, blowout: true, dwellMs: 600 },
            grabPipette: { slotLocationId: null },
            moveTo: { locationId: null },
            wait: { ms: 1000 },
            led: { target: 'arm', power: 0 },
            ejectPipette: { releaseLocationId: null },
        };
        updateProgram((p) => ({ ...p, steps: [...p.steps, makeStep(type, defaults[type] || {})] }));
    }, [updateProgram]);

    const updateStep = useCallback((stepId, params) => {
        updateProgram((p) => ({
            ...p,
            steps: p.steps.map((s) => (s.id === stepId ? { ...s, params: { ...s.params, ...params } } : s)),
        }));
    }, [updateProgram]);

    const removeStep = useCallback((stepId) => {
        updateProgram((p) => ({ ...p, steps: p.steps.filter((s) => s.id !== stepId) }));
    }, [updateProgram]);

    const moveStep = useCallback((stepId, dir) => {
        updateProgram((p) => {
            const idx = p.steps.findIndex((s) => s.id === stepId);
            const j = idx + dir;
            if (idx < 0 || j < 0 || j >= p.steps.length) return p;
            const steps = [...p.steps];
            [steps[idx], steps[j]] = [steps[j], steps[idx]];
            return { ...p, steps };
        });
    }, [updateProgram]);

    const newProgram = useCallback(() => {
        const p = makeProgram(`Program ${programs.length + 1}`);
        setPrograms((prev) => [...prev, p]);
        setActiveProgramId(p.id);
    }, [programs.length]);

    const deleteProgram = useCallback(() => {
        if (!activeProgram) return;
        if (!window.confirm(`Delete program "${activeProgram.name}"?`)) return;
        setPrograms((prev) => prev.filter((p) => p.id !== activeProgram.id));
        setActiveProgramId(null);
    }, [activeProgram]);

    // Auto-build a grid drop-cast routine over every captured substrate spot.
    const autoBuildGrid = useCallback(() => {
        const slot = locationsByType('pipetteSlot').find((l) => poseIsComplete(l.pose));
        const source = locationsByType('sourceWell').find((l) => poseIsComplete(l.pose));
        const spots = locationsByType('substrate').filter((l) => poseIsComplete(l.pose));
        if (!spots.length) {
            appendLog('[build] Teach at least one substrate spot first.');
            return;
        }
        const steps = [makeStep('home', {})];
        if (slot) steps.push(makeStep('grabPipette', { slotLocationId: slot.id }));
        steps.push(makeStep('setVolume', { volumeUl: 2 }));
        for (const spot of spots) {
            if (source) steps.push(makeStep('aspirate', { sourceLocationId: source.id, dwellMs: 800 }));
            steps.push(makeStep('dispense', { targetLocationId: spot.id, blowout: true, dwellMs: 600 }));
        }
        steps.push(makeStep('home', {}));
        const eject = locationsByType('eject')[0];
        steps.push(makeStep('ejectPipette', { releaseLocationId: eject?.id || null }));
        const p = makeProgram(`Grid drop-cast (${spots.length} spots)`);
        p.steps = steps;
        setPrograms((prev) => [...prev, p]);
        setActiveProgramId(p.id);
        appendLog(`[build] Built grid routine for ${spots.length} substrate spots.`);
    }, [locationsByType, appendLog]);

    // ── run control ──────────────────────────────────────────────────────
    const run = useCallback(async () => {
        const robot = robotRef.current;
        if (!robot || !activeProgram || running) return;
        stopFlag.current = false;
        pauseFlag.current = false;
        setPaused(false);
        setRunning(true);
        setFreeMove(false);
        appendLog(`[run] ▶ "${activeProgram.name}" (${activeProgram.steps.length} steps)`);
        try {
            await robot.enableAllTorque();
            await robot.setMaxSpeed(config.MAX_SPEED);
            await runProgram(robot, activeProgram, locations, {
                onStep: (i) => setCurrentStep(i),
                onLog: appendLog,
                shouldStop: () => stopFlag.current,
                isPaused: () => pauseFlag.current,
            }, config);
        } catch (e) {
            appendLog(`[run] ⏹ ${e?.message || e}`);
        } finally {
            setRunning(false);
            setCurrentStep(-1);
            setPaused(false);
            pauseFlag.current = false;
        }
    }, [activeProgram, running, locations, config, appendLog]);

    const togglePause = useCallback(() => {
        pauseFlag.current = !pauseFlag.current;
        setPaused(pauseFlag.current);
        appendLog(pauseFlag.current ? '[run] ⏸ paused' : '[run] ▶ resumed');
    }, [appendLog]);

    const stop = useCallback(() => {
        stopFlag.current = true;
        robotRef.current?.abort();
        appendLog('[run] stopping…');
    }, [appendLog]);

    useEffect(() => () => {
        // cleanup on unmount
        stopFlag.current = true;
        servoIORef.current?.close().catch(() => {});
        ledIORef.current?.close().catch(() => {});
    }, []);

    // ── derived ──────────────────────────────────────────────────────────
    const taughtCount = useMemo(() => locations.filter((l) => poseIsComplete(l.pose)).length, [locations]);
    const selectedLoc = selectedKey ? locByKey(selectedKey) : null;
    const selectedName = useMemo(() => {
        const cell = [...slotCells, ...wellCells, ...spotCells].find((c) => c.key === selectedKey);
        if (cell) return cell.name;
        if (selectedKey === 'home') return 'Home';
        if (selectedKey === 'safe') return 'Safe point';
        if (selectedKey === 'eject') return 'Eject / release';
        return null;
    }, [selectedKey, slotCells, wellCells, spotCells]);

    const exportProgram = useCallback(() => {
        if (!activeProgram) return;
        const blob = new Blob([JSON.stringify({ program: activeProgram, locations, config }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${activeProgram.name.replace(/[^\w.-]+/g, '_')}.dropcast.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [activeProgram, locations, config]);

    // ── render helpers ────────────────────────────────────────────────────
    const renderCell = (cell) => {
        const l = locByKey(cell.key);
        const taught = poseIsComplete(l?.pose);
        const active = selectedKey === cell.key;
        const tint = LOCATION_TYPES[cell.type]?.tint || '#64748b';
        return (
            <button
                key={cell.key}
                type="button"
                className={`dcr-cell${active ? ' is-active' : ''}${taught ? ' is-taught' : ''}`}
                style={{ '--cell-tint': tint }}
                onClick={() => setSelectedKey(cell.key)}
                onDoubleClick={() => taught && gotoLocation(cell.key)}
                title={`${cell.name}${taught ? ' — taught (double-click to go there)' : ' — not taught'}`}
            >
                <span className="dcr-cell-label">{cell.name.replace(/^Slot |^Well |^Spot /, '')}</span>
                {taught && <CircleDot size={9} className="dcr-cell-dot" />}
            </button>
        );
    };

    if (!supported) {
        return (
            <div className="dcr-page">
                <div className="dcr-unsupported">
                    <Bot size={42} />
                    <h2>Drop-Cast Robot</h2>
                    <p>This feature needs the <strong>Web Serial API</strong>, available in Chrome, Edge, or Opera on desktop. Open this app there to connect the Andrew robot over USB.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="dcr-page">
            {/* Header */}
            <header className="dcr-header">
                <div className="dcr-title">
                    <span className="dcr-title-icon"><Bot size={20} /></span>
                    <div>
                        <h1>Drop-Cast Robot</h1>
                        <p>Program the Andrew pipetting robot for deposition on sensor substrates — fully in-browser over USB.</p>
                    </div>
                </div>
                <div className="dcr-header-actions">
                    <span className={`dcr-chip${servoConnected ? ' ok' : ''}`}>
                        <span className="dcr-dot" /> Servo bus {servoConnected ? 'online' : 'offline'}
                    </span>
                    <span className={`dcr-chip${ledConnected ? ' ok' : ''}`}>
                        <span className="dcr-dot" /> LEDs {ledConnected ? 'online' : 'off'}
                    </span>
                    {!servoConnected ? (
                        <button className="dcr-btn primary" disabled={busy} onClick={connectServo}>
                            <Plug size={15} /> Connect servos
                        </button>
                    ) : (
                        <>
                            {!ledConnected && (
                                <button className="dcr-btn" disabled={busy} onClick={connectLed}>
                                    <Lightbulb size={15} /> Connect LEDs
                                </button>
                            )}
                            <button className="dcr-btn ghost" disabled={busy} onClick={disconnectAll}>
                                <Power size={15} /> Disconnect
                            </button>
                        </>
                    )}
                    <button className="dcr-estop" onClick={eStop} title="Emergency stop — cut torque on all servos">
                        <OctagonX size={16} /> E-STOP
                    </button>
                </div>
            </header>

            <div className="dcr-body">
                {/* LEFT: deck + teaching */}
                <section className="dcr-col dcr-col-left">
                    <div className="dcr-card dcr-deck">
                        <div className="dcr-card-head">
                            <h3><Target size={15} /> Deck layout</h3>
                            <span className="dcr-muted">{taughtCount} taught · click a cell, then Capture</span>
                        </div>

                        <div className="dcr-deck-section">
                            <div className="dcr-deck-label">Pipette rack</div>
                            <div className="dcr-rack">{slotCells.map(renderCell)}</div>
                        </div>

                        <div className="dcr-deck-section">
                            <div className="dcr-deck-label">Ink / source plate</div>
                            <div className="dcr-grid" style={{ gridTemplateColumns: `repeat(${deck.sourceCols}, 1fr)` }}>
                                {wellCells.map(renderCell)}
                            </div>
                        </div>

                        <div className="dcr-deck-section">
                            <div className="dcr-deck-label">Sensor substrate</div>
                            <div className="dcr-grid substrate" style={{ gridTemplateColumns: `repeat(${deck.substrateCols}, 1fr)` }}>
                                {spotCells.map(renderCell)}
                            </div>
                        </div>

                        <div className="dcr-deck-section dcr-special-row">
                            {[
                                { key: 'home', name: 'Home', type: 'home' },
                                { key: 'safe', name: 'Safe', type: 'safe' },
                                { key: 'eject', name: 'Eject', type: 'eject' },
                            ].map(renderCell)}
                        </div>

                        <div className="dcr-deck-config">
                            <DeckNum label="Slots" value={deck.pipetteSlots} min={1} max={8} onChange={(v) => setConfig((c) => ({ ...c, deck: { ...c.deck, pipetteSlots: v } }))} />
                            <DeckNum label="Well rows" value={deck.sourceRows} min={1} max={8} onChange={(v) => setConfig((c) => ({ ...c, deck: { ...c.deck, sourceRows: v } }))} />
                            <DeckNum label="Well cols" value={deck.sourceCols} min={1} max={12} onChange={(v) => setConfig((c) => ({ ...c, deck: { ...c.deck, sourceCols: v } }))} />
                            <DeckNum label="Spot rows" value={deck.substrateRows} min={1} max={12} onChange={(v) => setConfig((c) => ({ ...c, deck: { ...c.deck, substrateRows: v } }))} />
                            <DeckNum label="Spot cols" value={deck.substrateCols} min={1} max={12} onChange={(v) => setConfig((c) => ({ ...c, deck: { ...c.deck, substrateCols: v } }))} />
                        </div>
                    </div>

                    <div className="dcr-card dcr-teach">
                        <div className="dcr-card-head">
                            <h3><Crosshair size={15} /> Teach &amp; jog</h3>
                            <button className={`dcr-btn sm${freeMove ? ' warn' : ''}`} disabled={!servoConnected || busy} onClick={toggleFreeMove}>
                                <Hand size={14} /> {freeMove ? 'Torque OFF (free move)' : 'Free move'}
                            </button>
                        </div>

                        <div className="dcr-selected">
                            {selectedName ? (
                                <>
                                    <span>Selected: <strong>{selectedName}</strong> {poseIsComplete(selectedLoc?.pose) ? '· taught' : '· not taught'}</span>
                                    <div className="dcr-selected-actions">
                                        <button className="dcr-btn sm primary" disabled={!servoConnected || busy} onClick={capturePose}>
                                            <Save size={13} /> Capture here
                                        </button>
                                        <button className="dcr-btn sm" disabled={!servoConnected || busy || !poseIsComplete(selectedLoc?.pose)} onClick={() => gotoLocation(selectedKey)}>
                                            <Play size={13} /> Go
                                        </button>
                                        {poseIsComplete(selectedLoc?.pose) && (
                                            <button className="dcr-btn sm ghost" onClick={() => clearLocationPose(selectedKey)} title="Clear taught pose">
                                                <Eraser size={13} />
                                            </button>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <span className="dcr-muted">Select a deck cell to teach its position.</span>
                            )}
                        </div>

                        <div className="dcr-jog-step">
                            <span>Jog step</span>
                            {[5, 25, 100].map((s) => (
                                <button key={s} className={`dcr-pill${jogStep === s ? ' is-active' : ''}`} onClick={() => setJogStep(s)}>{s}</button>
                            ))}
                            <span className="dcr-muted">ticks</span>
                        </div>

                        <div className="dcr-jog-grid">
                            {JOG_JOINTS.map((j) => (
                                <div className="dcr-jog-row" key={j.key}>
                                    <span className="dcr-jog-label">{j.label}</span>
                                    <button className="dcr-jog-btn" disabled={!servoConnected || busy} onClick={() => jog(j.key, -1)}><ChevronDown size={14} /></button>
                                    <span className="dcr-jog-val">{positions[j.key] ?? '—'}</span>
                                    <button className="dcr-jog-btn" disabled={!servoConnected || busy} onClick={() => jog(j.key, +1)}><ChevronUp size={14} /></button>
                                </div>
                            ))}
                        </div>

                        <div className="dcr-manual">
                            <button className="dcr-btn sm" disabled={!servoConnected || busy} onClick={() => manual((r) => r.openGripper(), 'open gripper')}>Open grip</button>
                            <button className="dcr-btn sm" disabled={!servoConnected || busy} onClick={() => manual((r) => r.closeGripper(), 'close gripper')}>Close grip</button>
                            <button className="dcr-btn sm" disabled={!servoConnected || busy} onClick={() => manual((r) => r.thumbDepressFirst(), 'thumb 1')}>Thumb ▼1</button>
                            <button className="dcr-btn sm" disabled={!servoConnected || busy} onClick={() => manual((r) => r.thumbDepressSecond(), 'thumb 2')}>Thumb ▼2</button>
                            <button className="dcr-btn sm" disabled={!servoConnected || busy} onClick={() => manual((r) => r.thumbNeutral(), 'thumb neutral')}>Thumb ↺</button>
                            <button className="dcr-btn sm" disabled={!servoConnected || busy} onClick={() => manual((r) => r.thumbEject(), 'thumb eject')}>Eject tip</button>
                            <button className="dcr-btn sm" disabled={!ledConnected || busy} onClick={() => manual((r) => r.ledArm(255), 'arm led')}>Arm LED</button>
                            <button className="dcr-btn sm" disabled={!ledConnected || busy} onClick={() => manual((r) => r.ledBody(255), 'body led')}>Body LED</button>
                            <button className="dcr-btn sm ghost" disabled={!ledConnected || busy} onClick={() => manual(async (r) => { await r.ledArm(0); await r.ledBody(0); }, 'leds off')}>LEDs off</button>
                        </div>

                        <div className="dcr-speed">
                            <Gauge size={14} />
                            <span>Max speed</span>
                            <input
                                type="range" min={10} max={300} value={config.MAX_SPEED}
                                onChange={(e) => setConfig((c) => ({ ...c, MAX_SPEED: Number(e.target.value) }))}
                                onMouseUp={() => robotRef.current?.setMaxSpeed(config.MAX_SPEED)}
                            />
                            <strong>{config.MAX_SPEED}</strong>
                        </div>
                    </div>
                </section>

                {/* RIGHT: program builder */}
                <section className="dcr-col dcr-col-right">
                    <div className="dcr-card dcr-program">
                        <div className="dcr-card-head">
                            <h3><Bot size={15} /> Deposition program</h3>
                            <div className="dcr-prog-select">
                                <select value={activeProgramId || ''} onChange={(e) => setActiveProgramId(e.target.value)}>
                                    {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                                <button className="dcr-btn sm" onClick={newProgram} title="New program"><Plus size={14} /></button>
                                <button className="dcr-btn sm" onClick={autoBuildGrid} title="Auto-build a grid drop-cast routine"><Wand2 size={14} /></button>
                                <button className="dcr-btn sm" onClick={exportProgram} title="Export program JSON"><Download size={14} /></button>
                                <button className="dcr-btn sm ghost" onClick={deleteProgram} title="Delete program"><Trash2 size={14} /></button>
                            </div>
                        </div>

                        {activeProgram && (
                            <input
                                className="dcr-prog-name"
                                value={activeProgram.name}
                                onChange={(e) => updateProgram((p) => ({ ...p, name: e.target.value }))}
                            />
                        )}

                        {/* Run controls */}
                        <div className="dcr-run-bar">
                            {!running ? (
                                <button className="dcr-btn primary" disabled={!servoConnected || !activeProgram?.steps.length} onClick={run}>
                                    <Play size={15} /> Run
                                </button>
                            ) : (
                                <>
                                    <button className="dcr-btn" onClick={togglePause}>
                                        {paused ? <><Play size={15} /> Resume</> : <><Pause size={15} /> Pause</>}
                                    </button>
                                    <button className="dcr-btn warn" onClick={stop}><Square size={15} /> Stop</button>
                                </>
                            )}
                            <span className="dcr-muted dcr-run-status">
                                {running ? (paused ? 'Paused' : `Running step ${currentStep + 1}/${activeProgram?.steps.length || 0}`) : 'Idle'}
                            </span>
                        </div>

                        {/* Step list */}
                        <div className="dcr-steps">
                            {activeProgram?.steps.length ? activeProgram.steps.map((step, i) => (
                                <StepRow
                                    key={step.id}
                                    step={step}
                                    index={i}
                                    active={running && currentStep === i}
                                    locations={locations}
                                    locationsByType={locationsByType}
                                    onChange={(params) => updateStep(step.id, params)}
                                    onRemove={() => removeStep(step.id)}
                                    onMove={(dir) => moveStep(step.id, dir)}
                                />
                            )) : (
                                <div className="dcr-empty">No steps yet. Add steps below or click the wand to auto-build a grid routine.</div>
                            )}
                        </div>

                        {/* Add step palette */}
                        <div className="dcr-palette">
                            {Object.entries(STEP_TYPES).map(([type, meta]) => (
                                <button
                                    key={type}
                                    className="dcr-add-step"
                                    style={{ '--step-tint': meta.tint }}
                                    onClick={() => addStep(type)}
                                    title={meta.desc}
                                    disabled={!activeProgram}
                                >
                                    <Plus size={12} /> {meta.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Console */}
                    <div className="dcr-card dcr-console">
                        <div className="dcr-card-head">
                            <h3>Console</h3>
                            <button className="dcr-btn sm ghost" onClick={() => setLog([])}><RotateCcw size={13} /> Clear</button>
                        </div>
                        <div className="dcr-log" ref={logRef}>
                            {log.length ? log.map((l, i) => <div key={i} className="dcr-log-line">{l}</div>) : <div className="dcr-muted">Connect the robot to begin. Teach positions, build a program, then Run.</div>}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}

function DeckNum({ label, value, min, max, onChange }) {
    return (
        <label className="dcr-decknum">
            <span>{label}</span>
            <input
                type="number" min={min} max={max} value={value}
                onChange={(e) => {
                    const v = Math.max(min, Math.min(max, Number(e.target.value) || min));
                    onChange(v);
                }}
            />
        </label>
    );
}

function LocPicker({ value, onChange, options }) {
    return (
        <select className="dcr-locpicker" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">— pick —</option>
            {options.map((l) => (
                <option key={l.id} value={l.id}>{l.name}{poseIsComplete(l.pose) ? '' : ' (not taught)'}</option>
            ))}
        </select>
    );
}

function StepRow({ step, index, active, locations, locationsByType, onChange, onRemove, onMove }) {
    const meta = STEP_TYPES[step.type] || { label: step.type, tint: '#64748b' };
    return (
        <div className={`dcr-step${active ? ' is-active' : ''}`} style={{ '--step-tint': meta.tint }}>
            <div className="dcr-step-index">{index + 1}</div>
            <div className="dcr-step-main">
                <div className="dcr-step-title">{meta.label}</div>
                <div className="dcr-step-body">
                    {step.type === 'grabPipette' && (
                        <LocPicker value={step.params.slotLocationId} onChange={(v) => onChange({ slotLocationId: v })} options={locationsByType('pipetteSlot')} />
                    )}
                    {step.type === 'aspirate' && (
                        <>
                            <LocPicker value={step.params.sourceLocationId} onChange={(v) => onChange({ sourceLocationId: v })} options={locationsByType('sourceWell')} />
                            <NumField label="dwell ms" value={step.params.dwellMs} onChange={(v) => onChange({ dwellMs: v })} />
                        </>
                    )}
                    {step.type === 'dispense' && (
                        <>
                            <LocPicker value={step.params.targetLocationId} onChange={(v) => onChange({ targetLocationId: v })} options={locationsByType('substrate')} />
                            <NumField label="dwell ms" value={step.params.dwellMs} onChange={(v) => onChange({ dwellMs: v })} />
                            <label className="dcr-check">
                                <input type="checkbox" checked={!!step.params.blowout} onChange={(e) => onChange({ blowout: e.target.checked })} /> blow-out
                            </label>
                        </>
                    )}
                    {step.type === 'moveTo' && (
                        <LocPicker value={step.params.locationId} onChange={(v) => onChange({ locationId: v })} options={locations} />
                    )}
                    {step.type === 'setVolume' && (
                        <NumField label="µL" value={step.params.volumeUl} step="0.1" onChange={(v) => onChange({ volumeUl: v })} />
                    )}
                    {step.type === 'wait' && (
                        <NumField label="ms" value={step.params.ms} onChange={(v) => onChange({ ms: v })} />
                    )}
                    {step.type === 'led' && (
                        <>
                            <select value={step.params.target || 'arm'} onChange={(e) => onChange({ target: e.target.value })}>
                                <option value="arm">Arm</option>
                                <option value="body">Body</option>
                            </select>
                            <NumField label="power" value={step.params.power} onChange={(v) => onChange({ power: v })} />
                        </>
                    )}
                    {step.type === 'ejectPipette' && (
                        <LocPicker value={step.params.releaseLocationId} onChange={(v) => onChange({ releaseLocationId: v })} options={[...locationsByType('eject'), ...locationsByType('waste')]} />
                    )}
                    {step.type === 'home' && <span className="dcr-muted">{describeStep(step, locations)}</span>}
                </div>
            </div>
            <div className="dcr-step-actions">
                <button onClick={() => onMove(-1)} title="Move up"><ChevronUp size={13} /></button>
                <button onClick={() => onMove(+1)} title="Move down"><ChevronDown size={13} /></button>
                <button onClick={onRemove} title="Delete step" className="danger"><Trash2 size={13} /></button>
            </div>
        </div>
    );
}

function NumField({ label, value, onChange, step = '1' }) {
    return (
        <label className="dcr-numfield">
            <input type="number" step={step} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))} />
            <span>{label}</span>
        </label>
    );
}
