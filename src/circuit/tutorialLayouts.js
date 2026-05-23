/**
 * Hand-tuned schematic layouts for Circuit Studio tutorials (post netlist import).
 * Electrical connectivity stays on net labels; wires are cosmetic only.
 */

import {
    translateComponent,
    addWirePath,
    manhattanPath,
    snap,
    componentPins,
} from './schematicDoc.js';
import { symbolForSchematic, SYMBOLS } from './symbols.js';

/**
 * Rotate a component AND drag any net labels stamped on its old pin
 * coordinates over to the matching new pin coordinates.
 *
 * `rotateComponent` in schematicDoc.js only flips the geometry — it
 * doesn't move labels — so the cosmetic-wire router (which connects
 * same-named labels) would dangle wires off the rotated body.  Tutorial
 * layouts rely on labels following the body, so this helper is the
 * label-aware version.
 *
 * @param {import('./schematicDoc.js').SchematicDoc} doc
 * @param {string} compId
 * @param {0|90|180|270} newRot
 */
function setRotationKeepingLabels(doc, compId, newRot) {
    const c = doc.components.find((cc) => cc.id === compId);
    if (!c) return false;
    const oldRot = c.rot;
    if (oldRot === newRot) return false;

    // Snapshot pin positions BEFORE the rotation, paired by pin id.
    const oldPins = componentPins(c).map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) }));
    c.rot = newRot;
    const newPins = componentPins(c).map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) }));

    // Determine each label's destination IN ONE PASS before mutating.
    // (A naive in-place loop would double-move labels on a 180° flip
    // because the pre-existing label at the *swapped* pin position
    // would be picked up by the second iteration after the first
    // iteration deposited a label there.)
    const moves = []; // { lab, nx, ny }
    for (let i = 0; i < oldPins.length; i++) {
        const op = oldPins[i];
        const np = newPins.find((p) => p.id === op.id);
        if (!np || (op.x === np.x && op.y === np.y)) continue;
        for (const lab of doc.labels) {
            if (lab.x === op.x && lab.y === op.y) {
                // First match wins — a label can only belong to one pin.
                if (!moves.some((m) => m.lab === lab)) {
                    moves.push({ lab, nx: np.x, ny: np.y });
                }
            }
        }
    }
    for (const { lab, nx, ny } of moves) {
        lab.x = nx;
        lab.y = ny;
    }
    return true;
}

/**
 * Force a two-terminal component (R/C/L) into one of four canonical
 * orientations, choosing rotation so that the named pin id lands on the
 * requested side ('T'/'B'/'L'/'R').  `pinId` defaults to 'n1' (the
 * first node in the SPICE element line).
 *
 * @param {import('./schematicDoc.js').SchematicDoc} doc
 * @param {string} compId
 * @param {'T'|'B'|'L'|'R'} side
 * @param {string} [pinId]
 */
function orientTwoTerm(doc, compId, side, pinId = 'n1') {
    const c = doc.components.find((cc) => cc.id === compId);
    if (!c) return false;
    // Map (default-orientation pin local position) + desired side → rotation.
    // Default horizontal: n1 at -X (left), n2 at +X (right).
    // After rot 0   → n1 left,  n2 right
    // After rot 90  → n1 top,   n2 bottom
    // After rot 180 → n1 right, n2 left
    // After rot 270 → n1 bottom,n2 top
    const table = {
        n1: { L: 0,   T: 90,  R: 180, B: 270 },
        n2: { R: 0,   B: 90,  L: 180, T: 270 },
    };
    const rot = table[pinId]?.[side];
    if (rot == null) return false;
    return setRotationKeepingLabels(doc, compId, rot);
}

/** @param {import('./schematicDoc.js').SchematicDoc} doc */
function clearCosmeticWires(doc) {
    if (doc.wires) doc.wires.length = 0;
}

/** @typedef {{ left: number, right: number, top: number, bottom: number }} Obstacle */

/**
 * Axis-aligned bounds of a component in world px (padding keeps wires off glyphs).
 * @param {import('./schematicDoc.js').SchematicDoc['components'][0]} comp
 * @param {number} pad
 * @returns {Obstacle | null}
 */
function paddedBounds(comp, pad = 12) {
    const sym = symbolForSchematic(comp) || SYMBOLS[comp.symbolKey] || SYMBOLS[comp.elementType];
    const cx = comp.pos.x;
    const cy = comp.pos.y;
    if (!sym) {
        const s = 28 + pad;
        return { left: cx - s, right: cx + s, top: cy - s, bottom: cy + s };
    }
    const w = (comp.rot === 90 || comp.rot === 270) ? sym.height : sym.width;
    const h = (comp.rot === 90 || comp.rot === 270) ? sym.width : sym.height;
    return {
        left: cx - w / 2 - pad,
        right: cx + w / 2 + pad,
        top: cy - h / 2 - pad,
        bottom: cy + h / 2 + pad,
    };
}

/** @param {number} px @param {number} py @param {Obstacle} b */
function pointInObstacle(px, py, b) {
    return px >= b.left && px <= b.right && py >= b.top && py <= b.bottom;
}

/** True if (px,py) is one of this component's pin locations (wire may leave from here). */
function pinTouchesComp(comp, px, py, tol = 8) {
    for (const p of componentPins(comp)) {
        if (Math.abs(p.x - px) <= tol && Math.abs(p.y - py) <= tol) return true;
    }
    return false;
}

/** Horizontal segment (axis-aligned) vs obstacle; ignores segment if an endpoint lies inside `b`. */
function horizSegHitsObstacle(ax, bx, y, b) {
    const x1 = Math.min(ax, bx);
    const x2 = Math.max(ax, bx);
    if (pointInObstacle(ax, y, b) || pointInObstacle(bx, y, b)) return false;
    if (y < b.top || y > b.bottom) return false;
    return !(x2 < b.left || x1 > b.right);
}

/** Vertical segment vs obstacle */
function vertSegHitsObstacle(ay, by, x, b) {
    const y1 = Math.min(ay, by);
    const y2 = Math.max(ay, by);
    if (pointInObstacle(x, ay, b) || pointInObstacle(x, by, b)) return false;
    if (x < b.left || x > b.right) return false;
    return !(y2 < b.top || y1 > b.bottom);
}

/**
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by
 * @param {Obstacle[]} obstacles
 */
function segmentHitsObstacles(ax, ay, bx, by, obstacles) {
    let hits = 0;
    for (const b of obstacles) {
        if (ay === by) {
            if (horizSegHitsObstacle(ax, bx, ay, b)) hits++;
        } else if (ax === bx) {
            if (vertSegHitsObstacle(ay, by, ax, b)) hits++;
        }
    }
    return hits;
}

/** @param {number[][]} path @param {Obstacle[]} obstacles */
function pathObstacleScore(path, obstacles) {
    let s = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const [ax, ay] = path[i];
        const [bx, by] = path[i + 1];
        s += segmentHitsObstacles(ax, ay, bx, by, obstacles);
    }
    return s;
}

/** Polyline length (Manhattan). */
function pathLength(path) {
    let L = 0;
    for (let i = 0; i < path.length - 1; i++) {
        L += Math.abs(path[i + 1][0] - path[i][0]) + Math.abs(path[i + 1][1] - path[i][1]);
    }
    return L;
}

/** Remove collinear middle vertices. */
function collapseOrthogonalPath(path) {
    if (path.length <= 2) return path;
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const [x0, y0] = out[out.length - 1];
        const [x1, y1] = path[i];
        const [x2, y2] = path[i + 1];
        const col = (x0 === x1 && x1 === x2) || (y0 === y1 && y1 === y2);
        if (!col) out.push(path[i]);
    }
    out.push(path[path.length - 1]);
    return out;
}

/**
 * Manhattan / jogged routes from (x1,y1) to (x2,y2), scored against obstacles.
 * Components touched only at an endpoint pin are skipped so leads can exit the symbol;
 * all other bodies still block routing through the interior.
 * @param {{ box: Obstacle, comp: import('./schematicDoc.js').SchematicDoc['components'][0] }[]} records
 */
function bestRoutedPath(x1, y1, x2, y2, records) {
    const active = records
        .filter(
            ({ comp }) => !pinTouchesComp(comp, x1, y1) && !pinTouchesComp(comp, x2, y2),
        )
        .map((r) => r.box);

    /** @type {number[][][]} */
    const candidates = [];
    // Endpoints (label / pin coordinates) must stay EXACT — BJT
    // collector pins live at x±14, capacitor pins at ±30, inductor
    // pins at ±38, none of which align to the 20-px grid.  Snapping
    // those would leave a several-pixel dangle and the canvas
    // dangling-wire validator would flag it.  Intermediate bend
    // points (which are router-chosen, not pin-anchored) DO get
    // snapped so the trace runs cleanly along grid lines.  A bend
    // coordinate that already equals an endpoint coordinate stays
    // off-grid too, because changing it would break orthogonality.
    const push = (p) => {
        if (p.length < 2) return;
        const sx = p[0][0], sy = p[0][1];
        const ex = p[p.length - 1][0], ey = p[p.length - 1][1];
        const fixedX = new Set([sx, ex]);
        const fixedY = new Set([sy, ey]);
        const out = p.map(([x, y]) => [
            fixedX.has(x) ? Math.round(x) : snap(x),
            fixedY.has(y) ? Math.round(y) : snap(y),
        ]);
        const q = collapseOrthogonalPath(out);
        if (q.length >= 2) candidates.push(q);
    };

    push(manhattanPath(x1, y1, x2, y2, 'H'));
    push(manhattanPath(x1, y1, x2, y2, 'V'));

    const yLo = Math.min(y1, y2);
    const yHi = Math.max(y1, y2);
    const xLo = Math.min(x1, x2);
    const xHi = Math.max(x1, x2);
    const yExtras = new Set([
        snap(yLo - 100), snap(yLo - 80), snap(yLo - 60), snap(yLo - 40),
        snap(yHi + 40), snap(yHi + 60), snap(yHi + 80), snap(yHi + 100),
        snap((y1 + y2) / 2),
        40, 80, 140, 220, 300, 380, 460,
    ]);
    for (const ym of yExtras) {
        if (ym === y1 || ym === y2) continue;
        push([[x1, y1], [x1, ym], [x2, ym], [x2, y2]]);
    }

    const xExtras = new Set([
        snap(xLo - 100), snap(xLo - 60), snap(xLo - 40),
        snap(xHi + 40), snap(xHi + 60), snap(xHi + 100),
        snap((x1 + x2) / 2),
        80, 160, 240, 400, 520, 640, 800, 1000, 1160,
    ]);
    for (const xm of xExtras) {
        if (xm === x1 || xm === x2) continue;
        push([[x1, y1], [xm, y1], [xm, y2], [x2, y2]]);
    }

    let best = candidates[0];
    let bestScore = pathObstacleScore(best, active);
    let bestLen = pathLength(best);
    for (let i = 1; i < candidates.length; i++) {
        const p = candidates[i];
        const sc = pathObstacleScore(p, active);
        const len = pathLength(p);
        if (sc < bestScore || (sc === bestScore && len < bestLen)) {
            best = p;
            bestScore = sc;
            bestLen = len;
        }
    }
    return best;
}

/**
 * Minimum spanning tree (Prim) on point indices; Manhattan distance as weight.
 * @param {{ x: number, y: number }[]} pts
 * @returns {[number, number][]} edges as [i, j]
 */
function mstEdges(pts) {
    const n = pts.length;
    if (n < 2) return [];
    let root = 0;
    for (let i = 1; i < n; i++) {
        const a = pts[root];
        const b = pts[i];
        if (b.x < a.x || (b.x === a.x && b.y < a.y)) root = i;
    }
    const inTree = new Set([root]);
    /** @type {[number, number][]} */
    const edges = [];
    while (inTree.size < n) {
        let bestI = -1;
        let bestJ = -1;
        let bestD = Infinity;
        for (const i of inTree) {
            const pi = pts[i];
            for (let j = 0; j < n; j++) {
                if (inTree.has(j)) continue;
                const pj = pts[j];
                const d = Math.abs(pi.x - pj.x) + Math.abs(pi.y - pj.y);
                if (d < bestD || (d === bestD && j < bestJ)) {
                    bestD = d;
                    bestI = i;
                    bestJ = j;
                }
            }
        }
        if (bestJ < 0) break;
        inTree.add(bestJ);
        edges.push([bestI, bestJ]);
    }
    return edges;
}

/**
 * Cosmetic wires: MST per net + obstacle-aware Manhattan so traces do not cut through bodies.
 * @param {import('./schematicDoc.js').SchematicDoc} doc
 */
function obstacleRecords(doc) {
    return (doc.components || [])
        .map((comp) => {
            const box = paddedBounds(comp);
            return box ? { box, comp } : null;
        })
        .filter(Boolean);
}

/** Merge labels that landed on the same pixel (same electrical node). */
function dedupePinPoints(pts) {
    const seen = new Map();
    const out = [];
    for (const p of pts) {
        const k = `${p.x}|${p.y}`;
        if (seen.has(k)) continue;
        seen.set(k, true);
        out.push(p);
    }
    return out;
}

/**
 * Supply / return nets: horizontal spine + vertical stubs (clear of passives).
 * @param {'top'|'bottom'} kind
 */
function addSupplyReturnRail(doc, uniq, kind) {
    if (uniq.length < 2) return;
    const ys = uniq.map((p) => p.y);
    const xs = uniq.map((p) => p.x);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    let yRail;
    if (kind === 'top') {
        yRail = snap(minY - 52);
        if (yRail < 24) yRail = 24;
    } else {
        yRail = snap(maxY + 48);
    }
    const x1 = snap(minX);
    const x2 = snap(maxX);
    if (x1 !== x2) {
        addWirePath(doc, [
            [x1, yRail],
            [x2, yRail],
        ]);
    }
    for (const p of uniq) {
        const px = snap(p.x);
        const py = snap(p.y);
        if (py === yRail) continue;
        addWirePath(doc, [
            [px, py],
            [px, yRail],
        ]);
    }
}

function rebuildCosmeticWiresFromLabels(doc) {
    clearCosmeticWires(doc);
    const records = obstacleRecords(doc);

    const byNet = new Map();
    for (const lab of doc.labels || []) {
        const raw = String(lab.name || '').trim();
        if (!raw) continue;
        const k = raw.toLowerCase();
        if (!byNet.has(k)) byNet.set(k, []);
        byNet.get(k).push({ x: lab.x, y: lab.y });
    }

    for (const [netKey, pts] of byNet) {
        if (pts.length < 2) continue;
        const uniq = dedupePinPoints(pts);
        if (uniq.length < 2) continue;

        const nk = netKey.toLowerCase();
        if (nk === 'vcc') {
            addSupplyReturnRail(doc, uniq, 'top');
            continue;
        }
        if (nk === 'gnd' || nk === '0') {
            addSupplyReturnRail(doc, uniq, 'bottom');
            continue;
        }

        const edges = mstEdges(uniq);
        for (const [ia, ib] of edges) {
            const a = uniq[ia];
            const b = uniq[ib];
            const path = bestRoutedPath(a.x, a.y, b.x, b.y, records);
            addWirePath(doc, path);
        }
    }
}

/**
 * Left-to-right signal flow + top supply / bottom ground (matches textbook amp).
 * Centers are in **world px** (same space as `comp.pos` after import offset).
 *
 * Layout layers (top → bottom):
 *   y=60   Vcc rail  (Vcc symbol + horizontal supply trace)
 *   y=100  Rb on the supply rail (filters Vcc → nbias for stage 1)
 *   y=140  Collector load resistors  (R1, R4, RL) — one column per stage
 *   y=240  Decoupling caps           (C4 on nbias, C5 on Vcc bulk)
 *   y=260  Base–collector feedback   (R2, R3, R5) — same column as their stage
 *   y=400  Transistor row            (Q1, Q2, Q3) and signal-path caps (C1–C3)
 *   y=480  Ground reference
 *
 * Stage columns are spaced 280 px apart so signal-path traces never collide
 * with the bias network on the left (Rb / C4) or the bulk cap on the right (C5).
 *
 * @param {import('./schematicDoc.js').SchematicDoc} doc
 */
export function applyLowPowerThreeStageTutorialLayout(doc) {
    /** @type {Record<string, [number, number]>} ref (case-insensitive) → centre [x,y] */
    const targets = {
        // --- Input source -------------------------------------------------
        Vin: [60, 400],

        // --- Supply rail --------------------------------------------------
        // Vcc voltage source sits on the FAR RIGHT of the schematic,
        // top-corner style.  Placing it here keeps its bottom (gnd) pin
        // out of the supply-rail row at y=100 — otherwise the symbol's
        // gnd pin would land on top of R4's vcc pin and the cosmetic-
        // wire router would draw a vcc/gnd short across the page.
        Vcc: [1140, 140],

        // --- Bias filter (left) & bulk decoupling (right) ----------------
        Rb:  [200, 100],   // 2.2k between Vcc rail (left pin) and nbias (right pin)
        C4:  [120, 240],   // 100u  nbias → GND  (far left, off the signal path)
        C5:  [1080, 240],  // 220u  Vcc   → GND  (far right, off the signal path)

        // --- Collector load resistors (one per stage) --------------------
        R1:  [320, 140],   // 5.6k  Q1 collector → nbias
        R4:  [600, 140],   // 3.3k  Q2 collector → Vcc
        RL:  [880, 140],   // 64Ω   Q3 collector → Vcc  ("speaker")

        // --- B–C feedback resistors (one per stage) ----------------------
        R2:  [320, 260],   // 560k  Q1
        R3:  [600, 260],   // 270k  Q2
        R5:  [880, 260],   // 15k   Q3

        // --- Transistor row ----------------------------------------------
        Q1:  [320, 400],
        Q2:  [600, 400],
        Q3:  [880, 400],

        // --- Signal-path coupling caps -----------------------------------
        C1:  [180, 400],   // input  → Q1 base
        C2:  [460, 400],   // Q1 col → Q2 base
        C3:  [740, 400],   // Q2 col → Q3 base

        // --- Ground reference --------------------------------------------
        0:   [600, 480],   // GND symbol ref in imported doc
    };

    const byRef = new Map();
    for (const c of doc.components || []) {
        const r = String(c.ref || '').trim();
        if (r) byRef.set(r.toLowerCase(), c);
    }

    // Pin-id polarity reminder (matches the netlist):
    //   R1 nc1 nbias       → n1 = nc1   (collector node)
    //   R4 vcc nc2         → n1 = vcc
    //   RL vcc nc3         → n1 = vcc
    //   R2 nc1 nb1         → n1 = nc1, n2 = nb1
    //   R3 nc2 nb2         →   "
    //   R5 nc3 nb3         →   "
    //   Rb vcc nbias       → n1 = vcc
    //   C1 nin nb1         → n1 = nin
    //   C2 nc1 nb2         → n1 = nc1
    //   C3 nc2 nb3         → n1 = nc2
    //   C4 nbias 0         → n1 = nbias
    //   C5 vcc 0           → n1 = vcc
    //
    // Side parameter says where the *named* pin should land in screen
    // space.  Helper picks the rotation that makes that true.
    /** @type {Record<string, ['T'|'B'|'L'|'R', 'n1'|'n2']>} */
    const orientations = {
        // Load resistors: supply pin must be on TOP so the wire to the
        // top rail is short and the wire to the collector goes straight
        // down without piercing the resistor body.
        R1: ['T', 'n2'],   // n2 = nbias on top
        R4: ['T', 'n1'],   // n1 = vcc   on top
        RL: ['T', 'n1'],   // n1 = vcc   on top

        // Feedback resistors: collector pin on the right (it is closer
        // to the BJT's collector, which sits at +14 in the body), base
        // pin on the left (toward the BJT base lead at -30).
        R2: ['R', 'n1'],   // n1 = nc1 on right → forces 180° flip
        R3: ['R', 'n1'],
        R5: ['R', 'n1'],

        // Series bias dropper, horizontal: vcc on the right (next to
        // the supply rail running along the top centre), nbias on the
        // left (where it spurs down through C4 and over to R1).
        Rb: ['R', 'n1'],

        // Decoupling caps: vertical, top pin = the decoupled node,
        // bottom pin = ground.
        C4: ['T', 'n1'],   // nbias on top
        C5: ['T', 'n1'],   // vcc   on top

        // Signal-path coupling caps: horizontal, signal flows left → right.
        C1: ['L', 'n1'],   // nin (input) on left
        C2: ['L', 'n1'],   // nc1 on left  → nb2 on right
        C3: ['L', 'n1'],   // nc2 on left  → nb3 on right
    };

    // 1. Translate FIRST, then rotate.  Order matters here because
    //    `translateComponent` skips moving a label if some other
    //    component still has a pin at the old coord (its
    //    "sharedElsewhere" rule guards genuine net junctions).  If we
    //    rotated first, an intermediate rotated pin coord could
    //    accidentally land on top of another component's still-old
    //    pin coord, and that component's later translate would find
    //    the foreign label there and either drag it the wrong way or
    //    refuse to move it.  Translating each component to its final
    //    spot first means the transient pin geometry during rotation
    //    only ever overlaps with already-final neighbours.
    for (const [ref, [tx, ty]] of Object.entries(targets)) {
        const c = byRef.get(ref.toLowerCase());
        if (!c) continue;
        const dx = tx - c.pos.x;
        const dy = ty - c.pos.y;
        translateComponent(doc, c.id, dx, dy);
    }

    // 2. Now rotate any two-terminal parts whose canonical orientation
    //    differs from what auto-import gave us.  `orientTwoTerm` moves
    //    each label by pin id (not position), so a 180° flip on R/C
    //    correctly swaps which side each net label lives on.
    for (const [ref, [side, pinId]] of Object.entries(orientations)) {
        const c = byRef.get(ref.toLowerCase());
        if (!c) continue;
        orientTwoTerm(doc, c.id, side, pinId);
    }

    rebuildCosmeticWiresFromLabels(doc);
}
