/**
 * Drop-cast program model, persistence, and execution engine for the Andrew
 * robot. A "program" is an ordered list of high-level steps that reference
 * taught "locations" (joint-space poses). The engine drives an AndrewRobot
 * instance step-by-step with pause / stop / E-stop support.
 */

const LS_LOCATIONS = 'dropcast:locations:v1';
const LS_PROGRAMS = 'dropcast:programs:v1';
const LS_CONFIG = 'dropcast:config:v1';

export const LOCATION_TYPES = {
    home: { label: 'Home', tint: '#38bdf8' },
    safe: { label: 'Safe point', tint: '#22d3ee' },
    pipetteSlot: { label: 'Pipette slot', tint: '#f59e0b' },
    sourceWell: { label: 'Ink / source well', tint: '#a855f7' },
    substrate: { label: 'Substrate spot', tint: '#22c55e' },
    eject: { label: 'Eject / release', tint: '#ef4444' },
    waste: { label: 'Waste', tint: '#94a3b8' },
};

export const STEP_TYPES = {
    home: { label: 'Home', icon: 'home', tint: '#38bdf8', desc: 'Move to the taught home pose.' },
    grabPipette: { label: 'Grab pipette', icon: 'grip', tint: '#f59e0b', desc: 'Pick up the pipette from a slot.' },
    setVolume: { label: 'Set volume', icon: 'beaker', tint: '#c084fc', desc: 'Set / note the pipette volume (µL).' },
    aspirate: { label: 'Aspirate', icon: 'down', tint: '#a855f7', desc: 'Draw liquid from a source well.' },
    dispense: { label: 'Dispense drop', icon: 'drop', tint: '#22c55e', desc: 'Deposit a drop at a substrate spot.' },
    moveTo: { label: 'Move to', icon: 'move', tint: '#60a5fa', desc: 'Move above a location at safe height, then lower.' },
    wait: { label: 'Wait', icon: 'clock', tint: '#fbbf24', desc: 'Pause for a fixed time.' },
    led: { label: 'Light', icon: 'bulb', tint: '#eab308', desc: 'Set arm / body LED brightness.' },
    ejectPipette: { label: 'Eject pipette', icon: 'eject', tint: '#ef4444', desc: 'Eject the tip and release the pipette.' },
};

export const DEFAULT_CONFIG = {
    SAFE_HEIGHT: 1600,
    GRAB_HEIGHT: 2035,
    GRIPPER_OPEN_POSITION: 2531,
    GRIPPER_CLOSED_POSITION: 2100,
    THUMB_NEUTRAL_POSITION: 1700,
    THUMB_DEPRESS_FIRST_POSITION: 2970,
    THUMB_DEPRESS_SECOND_POSITION: 3050,
    THUMB_EJECT_POSITION: 1498,
    MAX_SPEED: 60,
    deck: { pipetteSlots: 5, sourceRows: 2, sourceCols: 4, substrateRows: 4, substrateCols: 6 },
};

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeParse(raw, fallback) {
    try {
        const v = JSON.parse(raw);
        return v ?? fallback;
    } catch {
        return fallback;
    }
}

// ---- persistence --------------------------------------------------------

export function loadLocations() {
    if (typeof localStorage === 'undefined') return [];
    return safeParse(localStorage.getItem(LS_LOCATIONS), []);
}

export function saveLocations(locations) {
    try {
        localStorage.setItem(LS_LOCATIONS, JSON.stringify(locations));
    } catch {
        /* quota */
    }
}

export function loadPrograms() {
    if (typeof localStorage === 'undefined') return [];
    return safeParse(localStorage.getItem(LS_PROGRAMS), []);
}

export function savePrograms(programs) {
    try {
        localStorage.setItem(LS_PROGRAMS, JSON.stringify(programs));
    } catch {
        /* quota */
    }
}

export function loadConfig() {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG };
    const stored = safeParse(localStorage.getItem(LS_CONFIG), {});
    return { ...DEFAULT_CONFIG, ...stored, deck: { ...DEFAULT_CONFIG.deck, ...(stored.deck || {}) } };
}

export function saveConfig(config) {
    try {
        localStorage.setItem(LS_CONFIG, JSON.stringify(config));
    } catch {
        /* quota */
    }
}

// ---- factories ----------------------------------------------------------

export function makeLocation(type, name, pose = null) {
    return { id: uid(), type, name: name || LOCATION_TYPES[type]?.label || 'Location', pose };
}

export function makeStep(type, params = {}) {
    return { id: uid(), type, params };
}

export function makeProgram(name = 'New deposition program') {
    return { id: uid(), name, steps: [], createdAt: Date.now() };
}

/** A friendly starter program for drop-casting onto a sensor substrate. */
export function makeStarterProgram() {
    const p = makeProgram('Drop-cast routine');
    p.steps = [
        makeStep('home', {}),
        makeStep('grabPipette', { slotLocationId: null }),
        makeStep('setVolume', { volumeUl: 2 }),
        makeStep('aspirate', { sourceLocationId: null, dwellMs: 800 }),
        makeStep('dispense', { targetLocationId: null, blowout: true, dwellMs: 600 }),
        makeStep('home', {}),
        makeStep('ejectPipette', { releaseLocationId: null }),
    ];
    return p;
}

export function poseIsComplete(pose, joints = ['shoulder', 'elbow', 'wrist', 'linear']) {
    if (!pose) return false;
    return joints.every((j) => Number.isFinite(Number(pose[j])));
}

// ---- execution ----------------------------------------------------------

/**
 * Run a program. Cooperative pause/stop via callbacks.
 *
 * @param {import('./andrewRobot.js').AndrewRobot} robot
 * @param {object} program
 * @param {Array} locations
 * @param {object} cbs
 * @param {(i:number, step:object)=>void} [cbs.onStep]   step about to run
 * @param {(msg:string)=>void} [cbs.onLog]
 * @param {()=>boolean} [cbs.shouldStop]                 return true to abort
 * @param {()=>boolean} [cbs.isPaused]                   return true to hold
 * @param {object} cfg  resolved config (SAFE_HEIGHT, etc.)
 */
export async function runProgram(robot, program, locations, cbs = {}, cfg = DEFAULT_CONFIG) {
    const log = (m) => cbs.onLog?.(m);
    const byId = new Map(locations.map((l) => [l.id, l]));
    const loc = (id) => byId.get(id) || null;

    const guard = async () => {
        // honor pause
        while (cbs.isPaused?.()) {
            if (cbs.shouldStop?.()) throw new Error('Stopped');
            await sleep(120);
        }
        if (cbs.shouldStop?.()) throw new Error('Stopped');
    };

    const xy = (pose) => ({ shoulder: pose.shoulder, elbow: pose.elbow, wrist: pose.wrist });

    const moveAbove = async (pose) => {
        await robot.moveServos({ ...xy(pose), linear: cfg.SAFE_HEIGHT });
    };
    const lowerInto = async (pose) => {
        if (Number.isFinite(Number(pose.linear))) await robot.moveServos({ linear: pose.linear });
    };
    const raiseSafe = async () => {
        await robot.moveServos({ linear: cfg.SAFE_HEIGHT });
    };

    robot.clearAbort();

    for (let i = 0; i < program.steps.length; i += 1) {
        await guard();
        const step = program.steps[i];
        cbs.onStep?.(i, step);

        switch (step.type) {
            case 'home': {
                const home = locations.find((l) => l.type === 'home' && poseIsComplete(l.pose));
                if (!home) {
                    log('[run] No home pose taught — skipping Home.');
                    break;
                }
                log('[run] Homing…');
                await robot.moveServos({ ...home.pose });
                break;
            }
            case 'grabPipette': {
                const slot = loc(step.params.slotLocationId);
                if (!slot || !poseIsComplete(slot.pose)) {
                    throw new Error('Grab pipette: pick a taught pipette-slot location first.');
                }
                log(`[run] Grabbing pipette from "${slot.name}"…`);
                await robot.grabPipette(xy(slot.pose), { ...slot.pose });
                break;
            }
            case 'setVolume': {
                const v = Number(step.params.volumeUl);
                log(`[run] Set volume: ${Number.isFinite(v) ? v : '?'} µL`);
                // Physical volume is set by the pipette dial; recorded here for the
                // run log. (Twister-based auto-set can be added once calibrated.)
                break;
            }
            case 'aspirate': {
                const src = loc(step.params.sourceLocationId);
                if (!src || !poseIsComplete(src.pose)) throw new Error('Aspirate: pick a taught source well.');
                log(`[run] Aspirating from "${src.name}"…`);
                await moveAbove(src.pose);
                await lowerInto(src.pose);
                await robot.thumbDepressFirst();
                await sleep(Number(step.params.dwellMs) || 600);
                await guard();
                await robot.thumbNeutral();
                await sleep(400);
                await raiseSafe();
                break;
            }
            case 'dispense': {
                const tgt = loc(step.params.targetLocationId);
                if (!tgt || !poseIsComplete(tgt.pose)) throw new Error('Dispense: pick a taught substrate spot.');
                log(`[run] Dispensing drop at "${tgt.name}"…`);
                await moveAbove(tgt.pose);
                await lowerInto(tgt.pose);
                await robot.thumbDepressFirst();
                await sleep(Number(step.params.dwellMs) || 500);
                await guard();
                if (step.params.blowout) {
                    await robot.thumbDepressSecond();
                    await sleep(400);
                }
                await raiseSafe();
                await robot.thumbNeutral();
                break;
            }
            case 'moveTo': {
                const l = loc(step.params.locationId);
                if (!l || !poseIsComplete(l.pose)) throw new Error('Move to: pick a taught location.');
                log(`[run] Moving to "${l.name}"…`);
                await moveAbove(l.pose);
                await lowerInto(l.pose);
                break;
            }
            case 'wait': {
                const ms = Number(step.params.ms) || 1000;
                log(`[run] Waiting ${ms} ms…`);
                const until = Date.now() + ms;
                while (Date.now() < until) {
                    await guard();
                    await sleep(Math.min(150, until - Date.now()));
                }
                break;
            }
            case 'led': {
                const power = Number(step.params.power) || 0;
                if (step.params.target === 'body') await robot.ledBody(power);
                else await robot.ledArm(power);
                log(`[run] LED ${step.params.target || 'arm'} → ${power}`);
                break;
            }
            case 'ejectPipette': {
                const rel = loc(step.params.releaseLocationId);
                log('[run] Ejecting pipette…');
                await robot.ejectPipette(rel && poseIsComplete(rel.pose) ? { ...rel.pose } : null);
                break;
            }
            default:
                log(`[run] Unknown step "${step.type}" — skipped.`);
        }
    }
    log('[run] Program complete.');
}

/** A concise human summary of a step for the program list. */
export function describeStep(step, locations) {
    const byId = new Map(locations.map((l) => [l.id, l]));
    const nm = (id) => byId.get(id)?.name || '— pick —';
    switch (step.type) {
        case 'home':
            return 'Move to home pose';
        case 'grabPipette':
            return `Grab pipette from ${nm(step.params.slotLocationId)}`;
        case 'setVolume':
            return `Set volume ${step.params.volumeUl ?? '?'} µL`;
        case 'aspirate':
            return `Aspirate from ${nm(step.params.sourceLocationId)}`;
        case 'dispense':
            return `Dispense at ${nm(step.params.targetLocationId)}${step.params.blowout ? ' (blow-out)' : ''}`;
        case 'moveTo':
            return `Move to ${nm(step.params.locationId)}`;
        case 'wait':
            return `Wait ${step.params.ms ?? 1000} ms`;
        case 'led':
            return `${step.params.target === 'body' ? 'Body' : 'Arm'} LED → ${step.params.power ?? 0}`;
        case 'ejectPipette':
            return `Eject pipette${step.params.releaseLocationId ? ` at ${nm(step.params.releaseLocationId)}` : ''}`;
        default:
            return step.type;
    }
}
