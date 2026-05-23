/**
 * Vector CAD templates for the thermal studio. These build a list of thermal
 * entities (rect / circle / polyline arc / etc.) that get rasterised by the
 * solver — rather than baking pixels directly the way `templates.js` did.
 *
 * Coordinate system: µm, origin at the centre of the domain,
 * x ∈ [-domainUm/2, +domainUm/2], y same.
 */

import {
    createThermalRect,
    createThermalCircle,
    createThermalEllipse,
    createThermalPolygon,
    createThermalPolyline,
    createThermalArc,
} from './thermalEntity.js';

/**
 * Suspended membrane micro-hotplate template (vector form).
 * Layers (z-order, bottom → top):
 *   1. Si frame (full domain)
 *   2. Si3N4 membrane (centre square)
 *   3. Pt meander heater (open polyline, traced)
 *   4. Au bond pads (left + right tabs)
 */
export function membraneHotplateEntities(domainUm) {
    const half = domainUm / 2;
    const frameInsetUm = domainUm * 0.12;
    const memHalf = half - frameInsetUm;

    /* Si frame as a square ring built via subtract is overkill — just stack
       a Si rect under the membrane Si3N4 rect. The frame Dirichlet pin on
       the solver edges takes care of the cold-boundary physics. */
    const frame = createThermalRect(-half, -half, half, half, {
        materialId: 'silicon',
        thermalRole: 'frame',
    });
    const membrane = createThermalRect(-memHalf, -memHalf, memHalf, memHalf, {
        materialId: 'si3n4',
        thermalRole: 'membrane',
    });

    /* Pt meander, 4 horizontal arms covering the central 60% of the
       membrane, joined alternately on each side. Drawn as a single open
       polyline → rasterizer paints a stroke band of width `traceWidthUm`. */
    const traceWidthUm = Math.max(8, domainUm * 0.012);
    const heaterX0 = -domainUm * 0.25;
    const heaterX1 = domainUm * 0.25;
    const heaterY0 = -domainUm * 0.18;
    const heaterY1 = domainUm * 0.18;
    const armCount = 4;
    const armDy = (heaterY1 - heaterY0) / armCount;
    const meanderPts = [];
    for (let a = 0; a < armCount; a++) {
        const yc = heaterY0 + (a + 0.5) * armDy;
        if (a % 2 === 0) {
            meanderPts.push({ x: heaterX0, y: yc });
            meanderPts.push({ x: heaterX1, y: yc });
        } else {
            meanderPts.push({ x: heaterX1, y: yc });
            meanderPts.push({ x: heaterX0, y: yc });
        }
    }
    const heater = createThermalPolyline(meanderPts, {
        materialId: 'platinum',
        isHeater: true,
        thermalRole: 'heater',
        openTraceWidthUm: traceWidthUm,
    });

    /* Bond pads (gold) — small tabs on the frame for visualisation. */
    const padW = domainUm * 0.025;
    const padH = domainUm * 0.05;
    const padInset = -half + frameInsetUm * 0.5;
    const padL = createThermalRect(-half + 1, -padH / 2, -half + padW, padH / 2, {
        materialId: 'gold',
        thermalRole: 'bond pad L',
    });
    const padR = createThermalRect(half - padW, -padH / 2, half - 1, padH / 2, {
        materialId: 'gold',
        thermalRole: 'bond pad R',
    });
    void padInset;

    return [frame, membrane, heater, padL, padR];
}

/**
 * Disk hotplate with spiral heater (vector form).
 */
export function diskHotplateEntities(domainUm) {
    const half = domainUm / 2;
    const memR = half * 0.7;
    const heaterRMin = memR * 0.18;
    const heaterRMax = memR * 0.78;
    const turns = 4;
    const samples = 280;
    const traceWidthUm = Math.max(6, domainUm * 0.01);

    const frame = createThermalRect(-half, -half, half, half, {
        materialId: 'silicon',
        thermalRole: 'frame',
    });
    const membrane = createThermalCircle(0, 0, memR, {
        materialId: 'si3n4',
        thermalRole: 'membrane',
    });

    const pts = [];
    for (let s = 0; s < samples; s++) {
        const u = s / (samples - 1);
        const theta = u * turns * Math.PI * 2;
        const r = heaterRMin + (heaterRMax - heaterRMin) * u;
        pts.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
    }
    const heater = createThermalPolyline(pts, {
        materialId: 'platinum',
        isHeater: true,
        thermalRole: 'heater (spiral)',
        openTraceWidthUm: traceWidthUm,
    });

    return [frame, membrane, heater];
}

/**
 * Cantilever beam hotplate — rectangular beam with a serpentine heater.
 */
export function cantileverHotplateEntities(domainUm) {
    const half = domainUm / 2;
    const frame = createThermalRect(-half, -half, half, half, {
        materialId: 'silicon',
        thermalRole: 'frame',
    });
    const beam = createThermalRect(-half, -domainUm * 0.06, half * 0.6, domainUm * 0.06, {
        materialId: 'si3n4',
        thermalRole: 'cantilever',
    });
    const traceW = Math.max(5, domainUm * 0.008);
    const arms = 3;
    const armDy = (domainUm * 0.1) / arms;
    const x0 = -half * 0.55;
    const x1 = half * 0.45;
    const pts = [];
    for (let a = 0; a < arms; a++) {
        const yc = -domainUm * 0.05 + (a + 0.5) * armDy;
        if (a % 2 === 0) {
            pts.push({ x: x0, y: yc });
            pts.push({ x: x1, y: yc });
        } else {
            pts.push({ x: x1, y: yc });
            pts.push({ x: x0, y: yc });
        }
    }
    const heater = createThermalPolyline(pts, {
        materialId: 'platinum',
        isHeater: true,
        thermalRole: 'heater',
        openTraceWidthUm: traceW,
    });
    return [frame, beam, heater];
}

/** Empty silicon block — start drawing your own. */
export function blankEntities(domainUm) {
    const half = domainUm / 2;
    return [
        createThermalRect(-half, -half, half, half, {
            materialId: 'silicon',
            thermalRole: 'substrate',
        }),
    ];
}

export const THERMAL_CAD_TEMPLATES = [
    {
        id: 'membrane',
        label: 'Suspended membrane',
        description: 'Si frame · Si₃N₄ membrane · Pt meander heater · Au pads',
        build: membraneHotplateEntities,
    },
    {
        id: 'disk',
        label: 'Disk hotplate (spiral)',
        description: 'Circular Si₃N₄ disc with a spiral platinum heater',
        build: diskHotplateEntities,
    },
    {
        id: 'cantilever',
        label: 'Cantilever beam',
        description: 'Suspended Si₃N₄ beam with a small serpentine heater',
        build: cantileverHotplateEntities,
    },
    {
        id: 'blank',
        label: 'Blank silicon block',
        description: 'Solid Si — draw your own membrane / heater / etc.',
        build: blankEntities,
    },
];

/* Re-export the helpers a few places dropdown into. */
export {
    createThermalRect,
    createThermalCircle,
    createThermalEllipse,
    createThermalPolygon,
    createThermalPolyline,
    createThermalArc,
};
