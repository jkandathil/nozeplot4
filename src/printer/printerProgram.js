/**
 * Printer program model + executor.
 *
 * A "program" is an ordered list of steps the pump performs unattended,
 * captured by the UI as a list of cards. Step kinds:
 *
 *   • initialize             — W4R; safe homing of plunger
 *   • valve                  — switch valve to 'input' or 'output'
 *   • aspirate               — fill the syringe with N µL from the input port
 *   • dispenseAll            — push the entire syringe out through the output
 *   • drop                   — dispense one or more discrete drops of
 *                              `volumeNl` (100–500 nL by default), separated
 *                              by `delayMs`. Used for printing.
 *   • wait                   — pause for `delayMs` ms
 *   • speed                  — set the plunger top speed (S0..S34)
 *
 * The executor receives a {@link PrinterSession} and walks the steps in order,
 * updating the caller via the provided `onProgress` callback. It is cancellable
 * via the `cancelled()` predicate so the UI's STOP button can pull the
 * emergency brake.
 */

import { roundSteps } from './kloehnProtocol.js';
import { getSyringePreset } from './syringePresets.js';

let nextId = 1;
const mkId = () => `step_${Date.now().toString(36)}_${nextId++}`;

/** @typedef {{
 *   id: string,
 *   kind: 'initialize' | 'valve' | 'aspirate' | 'dispenseAll' | 'drop' | 'wait' | 'speed',
 *   enabled: boolean,
 *   // kind-specific:
 *   valve?: 'input' | 'output',
 *   volumeUl?: number,           aspirate / dispenseAll
 *   volumeNl?: number,           drop volume per single drop
 *   count?: number,              drop count
 *   delayMs?: number,            wait, or inter-drop spacing
 *   speedSps?: number,           V<n> command in sps (40..10000)
 *   label?: string,              free-form name
 * }} ProgramStep
 */

export function makeStep(kind, fields = {}) {
    const base = { id: mkId(), kind, enabled: true, label: '' };
    if (kind === 'initialize') return { ...base, ...fields };
    if (kind === 'valve') return { valve: 'input', ...base, ...fields };
    if (kind === 'aspirate') return { volumeUl: 10, speedSps: 2000, ...base, ...fields };
    if (kind === 'dispenseAll') return { speedSps: 200, ...base, ...fields };
    if (kind === 'drop') {
        /* Drops are tiny moves (~10-100 steps); 200 sps gives smooth, quiet
           motion. Override via fields if a custom step config is supplied. */
        return { volumeNl: 200, count: 5, delayMs: 250, speedSps: 200, ...base, ...fields };
    }
    if (kind === 'wait') return { delayMs: 1000, ...base, ...fields };
    if (kind === 'speed') return { speedSps: 2000, ...base, ...fields };
    /* Loop primitives — a `loopStart` carries a `count` (iteration count),
       and the matching `loopEnd` marks where the executor jumps back. The
       UI inserts them as a pair; nested loops are supported via a stack. */
    if (kind === 'loopStart') return { count: 5, ...base, ...fields };
    if (kind === 'loopEnd') return { ...base, ...fields };
    /* Priming: full-syringe aspirate→dispense cycles repeated until the
       total volume moved exceeds the combined tube volume × (1+safety). */
    if (kind === 'prime') {
        return {
            inputTubeLengthMm: 200,
            inputTubeIdMm: 1.0,
            outputTubeLengthMm: 100,
            outputTubeIdMm: 0.5,
            safetyPct: 25,
            speedSps: 4000,
            ...base,
            ...fields,
        };
    }
    /* Cleaning: same as prime, but with a higher default cycle count and a
       built-in user prompt asking them to swap to a cleaning solvent. */
    if (kind === 'clean') {
        return {
            inputTubeLengthMm: 200,
            inputTubeIdMm: 1.0,
            outputTubeLengthMm: 100,
            outputTubeIdMm: 0.5,
            safetyPct: 50,
            speedSps: 4000,
            /* `cycles` overrides the auto-computed cycle count. 5 is a
               thorough flush for water/IPA-style solvents. Set to 0 to fall
               back to the tube-volume calculation like prime. */
            cycles: 5,
            promptMessage:
                'Remove the ink reservoir and replace it with cleaning solvent (e.g. DI water). ' +
                'Make sure the dispense tip is over a waste container. Click OK to start flushing.',
            promptTitle: 'Cleaning — solvent setup',
            ...base,
            ...fields,
        };
    }
    /* Standalone prompt: pause program until the user confirms. */
    if (kind === 'prompt') {
        return {
            message: 'Continue with the next step?',
            promptTitle: 'Continue',
            ...base,
            ...fields,
        };
    }
    return { ...base, ...fields };
}

/** Volume (µL) of a tube modelled as a perfect cylinder. mm³ = µL. */
export function tubeVolumeUl(lengthMm, idMm) {
    const L = Math.max(0, Number(lengthMm) || 0);
    const r = Math.max(0, Number(idMm) || 0) / 2;
    return Math.PI * r * r * L;
}

/** Compute the priming plan for a `prime` step + the active syringe preset. */
export function planPriming(step, preset) {
    const vIn = tubeVolumeUl(step.inputTubeLengthMm, step.inputTubeIdMm);
    const vOut = tubeVolumeUl(step.outputTubeLengthMm, step.outputTubeIdMm);
    const safety = Math.max(0, Number(step.safetyPct) || 0) / 100;
    const targetUl = (vIn + vOut) * (1 + safety);
    const cycles = Math.max(1, Math.ceil(targetUl / preset.syringeUl));
    const totalMovedUl = cycles * preset.syringeUl;
    return { vIn, vOut, targetUl, cycles, totalMovedUl };
}

/** Short status text for a step (used by the program card UI). */
export function describeStep(step) {
    switch (step.kind) {
        case 'initialize':
            return 'Initialize (W4R)';
        case 'valve':
            return `Valve → ${step.valve === 'output' ? 'output' : 'input'}`;
        case 'aspirate':
            return `Aspirate ${Number(step.volumeUl).toFixed(1)} µL @ ${step.speedSps} sps`;
        case 'dispenseAll':
            return `Dispense all @ ${step.speedSps} sps`;
        case 'drop': {
            const total = (Number(step.volumeNl) || 0) * (Number(step.count) || 0);
            const totalLbl = total >= 1000 ? `${(total / 1000).toFixed(2)} µL` : `${total} nL`;
            return `Print ${step.count} × ${step.volumeNl} nL drops (${totalLbl}, +${step.delayMs} ms gap)`;
        }
        case 'wait':
            return `Wait ${step.delayMs} ms`;
        case 'speed':
            return `Set speed = ${step.speedSps} sps`;
        case 'loopStart':
            return `Repeat ${step.count} × ▽`;
        case 'loopEnd':
            return `End repeat △`;
        case 'prime': {
            const vIn = tubeVolumeUl(step.inputTubeLengthMm, step.inputTubeIdMm);
            const vOut = tubeVolumeUl(step.outputTubeLengthMm, step.outputTubeIdMm);
            return `Prime tubes (in ${vIn.toFixed(1)} µL · out ${vOut.toFixed(1)} µL · +${step.safetyPct ?? 25}%)`;
        }
        case 'clean': {
            const cyc = step.cycles || '?';
            return `Clean tubes · ${cyc} cycle${cyc === 1 ? '' : 's'} · prompts user`;
        }
        case 'prompt':
            return `Prompt: "${String(step.message ?? '').slice(0, 48)}"`;
        default:
            return step.kind;
    }
}

/** Single-step cost in seconds; loop primitives are zero-cost themselves. */
function stepCostSeconds(s, preset) {
    if (!s.enabled) return 0;
    switch (s.kind) {
        case 'initialize':
            return 6;
        case 'valve':
            return 0.5;
        case 'aspirate': {
            const stepsForMove = Math.max(1, ((Number(s.volumeUl) || 0) * 1000) / preset.nlPerStep);
            return stepsForMove / Math.max(40, s.speedSps || 2000) + 0.4;
        }
        case 'dispenseAll':
            return preset.stroke / Math.max(40, s.speedSps || 200) + 0.4;
        case 'drop': {
            const stepsPerDrop = Math.max(1, (Number(s.volumeNl) || 0) / preset.nlPerStep);
            const perDrop = stepsPerDrop / Math.max(40, s.speedSps || 200) + (s.delayMs || 0) / 1000;
            return perDrop * Math.max(1, s.count || 0);
        }
        case 'wait':
            return (s.delayMs || 0) / 1000;
        case 'prime': {
            const { cycles } = planPriming(s, preset);
            /* Each cycle = one full stroke aspirate + one full stroke dispense
               at the prime speed, plus ~1.5 s of valve/wait overhead. */
            const moveSec = preset.stroke / Math.max(40, s.speedSps || 4000);
            return cycles * (2 * moveSec + 1.5);
        }
        case 'clean': {
            const { cycles: autoCycles } = planPriming(s, preset);
            const cycles = Math.max(1, Number(s.cycles) || autoCycles);
            const moveSec = preset.stroke / Math.max(40, s.speedSps || 4000);
            return cycles * (2 * moveSec + 1.5);
        }
        case 'prompt':
        case 'speed':
        case 'loopStart':
        case 'loopEnd':
        default:
            return 0;
    }
}

/**
 * Estimate run time for a program, in seconds. Walks the step list once and
 * unrolls loop blocks by multiplying the inner-block cost by the iteration
 * count. Unmatched / nested loops are handled by a simple stack.
 */
export function estimateProgramSeconds(steps, presetId) {
    const preset = getSyringePreset(presetId);
    /* For loops we accumulate inner cost separately so we can multiply it
       by the iteration count when we hit the matching loopEnd. The stack
       carries one entry per currently-open loop. */
    const stack = [{ acc: 0, multiplier: 1 }];
    for (const s of steps) {
        if (!s.enabled) continue;
        if (s.kind === 'loopStart') {
            stack.push({ acc: 0, multiplier: Math.max(1, Number(s.count) | 0) });
            continue;
        }
        if (s.kind === 'loopEnd') {
            /* Never pop the root frame — an unmatched loopEnd would empty the
               stack and crash the next line with stack[-1].acc undefined. */
            if (stack.length > 1) {
                const top = stack.pop();
                stack[stack.length - 1].acc += top.acc * top.multiplier;
            }
            continue;
        }
        if (!stack.length) stack.push({ acc: 0, multiplier: 1 });
        stack[stack.length - 1].acc += stepCostSeconds(s, preset);
    }
    /* Any unmatched loopStart frames collapse with their own multipliers. */
    while (stack.length > 1) {
        const top = stack.pop();
        stack[stack.length - 1].acc += top.acc * top.multiplier;
    }
    return (stack[0] ?? { acc: 0 }).acc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute the program against a live {@link PrinterSession}.
 *
 * @param {object} session       PrinterSession instance
 * @param {ProgramStep[]} steps
 * @param {{
 *   presetId: string,
 *   onProgress?: (info: { stepIdx, totalSteps, message, drops?: number, dropsTotal?: number }) => void,
 *   isCancelled?: () => boolean,
 *   stepTimeoutMs?: number,
 * }} opts
 */
export async function runProgram(session, steps, opts) {
    const preset = getSyringePreset(opts.presetId);
    /* For the progress bar we count enabled non-loop steps multiplied by
       their enclosing loop counts — this gives the total *executions* the
       user will see, which is what they intuitively expect. */
    const totalSteps = countExecutions(steps);
    let idx = 0;
    const log = (message, extra = {}) => {
        opts.onProgress?.({ stepIdx: idx, totalSteps, message, ...extra });
    };

    /* Loop runtime: stack of { startSi, totalIters, doneIters } per active
       loop. We use array indices rather than the React step.id so jump-back
       is just `si = frame.startSi + 1`. */
    const loopStack = [];

    let si = 0;
    while (si < steps.length) {
        const step = steps[si];
        if (!step.enabled) { si++; continue; }
        if (opts.isCancelled?.()) {
            log('Program cancelled.');
            return { ok: false, reason: 'cancelled' };
        }

        /* ── Loop control primitives ───────────────────────────────────── */
        if (step.kind === 'loopStart') {
            const iters = Math.max(1, Number(step.count) | 0);
            loopStack.push({ startSi: si, totalIters: iters, doneIters: 1 });
            log(`Loop ${step.label || `× ${iters}`} — iteration 1/${iters}`);
            si++;
            continue;
        }
        if (step.kind === 'loopEnd') {
            const top = loopStack[loopStack.length - 1];
            if (!top) {
                log('Unmatched "End repeat" — skipping.');
                si++;
                continue;
            }
            if (top.doneIters < top.totalIters) {
                top.doneIters++;
                log(`Loop iteration ${top.doneIters}/${top.totalIters}`);
                si = top.startSi + 1; /* jump just past loopStart so we don't re-push */
                continue;
            }
            loopStack.pop();
            si++;
            continue;
        }

        idx++;
        log(`Step ${idx}/${totalSteps}: ${step.label || step.kind}`);

        try {
            switch (step.kind) {
                case 'initialize': {
                    log('Initializing syringe (motion defaults reset)…');
                    /* Reset L<accel> + V<top speed> *before* W4R so the homing
                       move uses a brisk speed regardless of what the previous
                       step left in the pump's motion registers (e.g. a Drop
                       step at 200 sps would otherwise drag W4R out to 2+
                       minutes). Equivalent to the manual toolbar Init button. */
                    await session.safeInitialize(preset.defaultFastSps || 4000);
                    await session.waitUntilReady({ timeoutMs: opts.stepTimeoutMs ?? 60000 });
                    break;
                }
                case 'valve': {
                    if (step.valve === 'output') await session.valveOutput();
                    else await session.valveInput();
                    await session.waitUntilReady({ timeoutMs: 6000 });
                    break;
                }
                case 'speed': {
                    await session.setTopSpeedSps(Math.max(40, Math.min(10000, step.speedSps || 2000)));
                    break;
                }
                case 'aspirate': {
                    if (step.speedSps) await session.setTopSpeedSps(step.speedSps);
                    await session.valveInput();
                    await session.waitUntilReady({ timeoutMs: 4000 });
                    const stepsToMove = roundSteps((Number(step.volumeUl) || 0) * 1000 / preset.nlPerStep);
                    const res = await session.aspirateBy(stepsToMove, preset.stroke);
                    if (res.skipped) log('Aspirate: already at full stroke — skipping.');
                    else if (res.delta < stepsToMove) {
                        log(
                            `Aspirate clamped to ${res.delta}/${stepsToMove} steps (stroke limit).`
                        );
                    }
                    await session.waitUntilReady({ timeoutMs: opts.stepTimeoutMs ?? 60000 });
                    break;
                }
                case 'dispenseAll': {
                    if (step.speedSps) await session.setTopSpeedSps(step.speedSps);
                    await session.valveOutput();
                    await session.waitUntilReady({ timeoutMs: 4000 });
                    await session.moveAbsolute(0);
                    await session.waitUntilReady({ timeoutMs: opts.stepTimeoutMs ?? 120000 });
                    break;
                }
                case 'drop': {
                    const volNl = Math.max(1, Number(step.volumeNl) || 0);
                    const count = Math.max(1, Math.floor(Number(step.count) || 0));
                    const gap = Math.max(0, Number(step.delayMs) || 0);
                    if (step.speedSps) await session.setTopSpeedSps(step.speedSps);
                    await session.valveOutput();
                    await session.waitUntilReady({ timeoutMs: 4000 });

                    /* Cumulative-rounding-corrected drop train.
                     *
                     * A single drop has to round to an integer step count, which
                     * loses up to half a step (~2.6 nL on a 250 µL / 48 k pump).
                     * Repeated identical drops accumulate the SAME rounding
                     * error each time, so N × 200 nL drifts by N × 2 nL — bad
                     * for printing arrays.
                     *
                     * Instead, on each iteration we compute the IDEAL fractional
                     * step count for the cumulative target (i × volNl) and emit
                     * the integer increment from "where we've actually stepped
                     * to so far". This dithers the per-drop step count between
                     * floor and ceil so the running total never drifts more
                     * than 1 step (~5 nL) regardless of sequence length.
                     *
                     * We also use a relative dispense `D<n>R` per drop instead
                     * of reading position before each move: that saves one `?`
                     * query per drop (faster, quieter) and is safe because the
                     * starting position is read once before the loop and we
                     * keep an exact running counter.
                     */
                    const startPosSteps = (await session.readPositionSteps()) ?? 0;
                    if (startPosSteps <= 0) {
                        log('Syringe is empty — aspirate before printing drops.');
                        break;
                    }
                    let cumActualSteps = 0;
                    let firstDropStepsLogged = false;

                    for (let d = 0; d < count; d++) {
                        if (opts.isCancelled?.()) {
                            log('Drop sequence cancelled.');
                            return { ok: false, reason: 'cancelled' };
                        }
                        const cumDesiredSteps = ((d + 1) * volNl) / preset.nlPerStep;
                        const thisStepCount = Math.max(0, Math.round(cumDesiredSteps - cumActualSteps));
                        if (thisStepCount === 0) {
                            log(`Drop ${d + 1}/${count} · 0 steps required (volume below resolution) — skipping`);
                            continue;
                        }
                        /* Make sure we still have fluid in the syringe before
                           we issue the relative dispense. */
                        const remainingPos = startPosSteps - cumActualSteps;
                        if (remainingPos < thisStepCount) {
                            log(
                                `Drop ${d + 1}/${count}: only ${remainingPos} steps left in syringe — stopping (target needed ${thisStepCount}).`
                            );
                            break;
                        }
                        if (!firstDropStepsLogged || thisStepCount !== Math.round(volNl / preset.nlPerStep)) {
                            log(`Drop ${d + 1}/${count} · ${volNl} nL (${thisStepCount} steps)`, {
                                drops: d + 1,
                                dropsTotal: count,
                            });
                            firstDropStepsLogged = true;
                        } else {
                            opts.onProgress?.({
                                stepIdx: idx,
                                totalSteps,
                                message: `Drop ${d + 1}/${count}`,
                                drops: d + 1,
                                dropsTotal: count,
                            });
                        }
                        await session.dispenseRelative(thisStepCount);
                        cumActualSteps += thisStepCount;
                        await session.waitUntilReady({ timeoutMs: 6000 });
                        if (gap > 0 && d < count - 1) await sleep(gap);
                    }
                    /* Cumulative-accuracy report at end of train. */
                    const deliveredNl = cumActualSteps * preset.nlPerStep;
                    const targetNl = count * volNl;
                    log(
                        `Drop train done: ${cumActualSteps} steps delivered = ${deliveredNl.toFixed(2)} nL ` +
                            `(target ${targetNl} nL · err ${(deliveredNl - targetNl).toFixed(2)} nL · ` +
                            `${((deliveredNl / targetNl - 1) * 100).toFixed(2)} %)`
                    );
                    break;
                }
                case 'wait': {
                    await sleep(Math.max(0, Number(step.delayMs) || 0));
                    break;
                }
                case 'prime': {
                    await runPrimeStep(session, step, preset, opts, log);
                    break;
                }
                case 'clean': {
                    /* Ask the user to swap to cleaning solvent first if a
                       prompt is configured. */
                    if (step.promptMessage && opts.requestConfirm) {
                        const ok = await opts.requestConfirm({
                            title: step.promptTitle || 'Cleaning',
                            message: step.promptMessage,
                            okLabel: 'Start cleaning',
                        });
                        if (!ok) {
                            log('Cleaning cancelled by user.');
                            return { ok: false, reason: 'cancelled' };
                        }
                    }
                    await runFlushStep(session, step, preset, opts, log, 'Clean');
                    break;
                }
                case 'prompt': {
                    if (opts.requestConfirm) {
                        const ok = await opts.requestConfirm({
                            title: step.promptTitle || 'Continue',
                            message: step.message || 'Continue with the next step?',
                            okLabel: 'Continue',
                        });
                        if (!ok) {
                            log('Program paused by user.');
                            return { ok: false, reason: 'cancelled' };
                        }
                    } else {
                        log('Prompt step skipped — no UI confirm handler.');
                    }
                    break;
                }
                default:
                    log(`Unknown step kind: ${step.kind} — skipping.`);
            }
        } catch (err) {
            log(`Error on step ${idx}: ${err?.message ?? err}`);
            return { ok: false, reason: 'error', error: err };
        }
        si++;
    }
    log('Program complete.');
    return { ok: true };
}

/**
 * Run one priming step: full aspirate → full dispense cycles until the total
 * fluid moved exceeds the user-supplied tube volumes × (1 + safety margin).
 *
 * Empties the syringe first so the cycle count plan is meaningful regardless
 * of what the previous step left behind.
 */
async function runPrimeStep(session, step, preset, opts, log) {
    return runFlushStep(session, step, preset, opts, log, 'Prime');
}

/**
 * Generic flush-tubes runner used by both `prime` and `clean`. Pulls full
 * syringes of fluid from the input port and pushes them out the output port
 * until enough volume has moved through both tubes. The `label` argument
 * controls the wording in the log so the user can distinguish prime vs clean
 * runs in the console.
 */
async function runFlushStep(session, step, preset, opts, log, label = 'Flush') {
    const plan = planPriming(step, preset);
    /* `step.cycles` (Clean step) overrides the auto-computed cycle count. */
    const overrideCycles = Number(step.cycles);
    const cycles = overrideCycles > 0 ? Math.floor(overrideCycles) : plan.cycles;
    const speed = Math.max(40, Math.min(10000, Number(step.speedSps) || preset.defaultFastSps || 4000));
    log(
        `${label} — input ${plan.vIn.toFixed(1)} µL, output ${plan.vOut.toFixed(1)} µL · ` +
            `target ${plan.targetUl.toFixed(1)} µL · ${cycles} cycle(s) of ${preset.syringeUl} µL @ ${speed} sps`
    );
    /* Make sure the syringe is empty before counting cycles. */
    await session.setTopSpeedSps(speed);
    await session.valveOutput();
    await session.waitUntilReady({ timeoutMs: 4000 });
    await session.moveAbsolute(0);
    await session.waitUntilReady({ timeoutMs: 60000 });

    for (let c = 0; c < cycles; c++) {
        if (opts.isCancelled?.()) return;
        log(`${label} cycle ${c + 1}/${cycles}: aspirate ${preset.syringeUl} µL from input`, {
            drops: c + 1,
            dropsTotal: cycles,
        });
        await session.valveInput();
        await session.waitUntilReady({ timeoutMs: 4000 });
        await session.moveAbsolute(preset.stroke);
        await session.waitUntilReady({ timeoutMs: 60000 });

        if (opts.isCancelled?.()) return;
        log(`${label} cycle ${c + 1}/${cycles}: dispense ${preset.syringeUl} µL out output`);
        await session.valveOutput();
        await session.waitUntilReady({ timeoutMs: 4000 });
        await session.moveAbsolute(0);
        await session.waitUntilReady({ timeoutMs: 60000 });
    }
    log(`${label} done — ${cycles * preset.syringeUl} µL moved through both tubes.`);
}

/** Count how many step EXECUTIONS the program produces (loops unrolled). */
function countExecutions(steps) {
    const stack = [{ acc: 0, multiplier: 1 }];
    for (const s of steps) {
        if (!s.enabled) continue;
        if (s.kind === 'loopStart') {
            stack.push({ acc: 0, multiplier: Math.max(1, Number(s.count) | 0) });
            continue;
        }
        if (s.kind === 'loopEnd') {
            if (stack.length > 1) {
                const top = stack.pop();
                stack[stack.length - 1].acc += top.acc * top.multiplier;
            }
            continue;
        }
        if (!stack.length) stack.push({ acc: 0, multiplier: 1 });
        stack[stack.length - 1].acc += 1;
    }
    while (stack.length > 1) {
        const top = stack.pop();
        stack[stack.length - 1].acc += top.acc * top.multiplier;
    }
    return (stack[0] ?? { acc: 0 }).acc;
}

/** Default starter program: init + aspirate 10 µL + print 5 drops of 200 nL. */
export function defaultPrinterProgram() {
    return [
        makeStep('initialize', { label: 'Home' }),
        makeStep('aspirate', { volumeUl: 10, speedSps: 2000, label: 'Aspirate ink' }),
        makeStep('drop', { volumeNl: 200, count: 5, delayMs: 250, speedSps: 200, label: 'Print 5 drops' }),
    ];
}
