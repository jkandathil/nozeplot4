/**
 * Basic Design Rule Check (DRC) Engine for PCB Studio.
 * 
 * Performs O(N^2) clearance checks. In a production build, this would be replaced
 * with an R-Tree (e.g. rbush) for spatial indexing and run in a Web Worker.
 */

// Basic math helpers for distance from a point to a line segment
function sqr(x) { return x * x; }
function dist2(v, w) { return sqr(v[0] - w[0]) + sqr(v[1] - w[1]); }
function distToSegmentSquared(p, v, w) {
    var l2 = dist2(v, w);
    if (l2 === 0) return dist2(p, v);
    var t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
    t = Math.max(0, Math.min(1, t));
    return dist2(p, [ v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1]) ]);
}
function distToSegment(p, v, w) {
    return Math.sqrt(distToSegmentSquared(p, v, w));
}

// Distance between two line segments
function segmentsDistance(p1, p2, p3, p4) {
    // A simplified check: check endpoints to the other segment
    const d1 = distToSegment(p1, p3, p4);
    const d2 = distToSegment(p2, p3, p4);
    const d3 = distToSegment(p3, p1, p2);
    const d4 = distToSegment(p4, p1, p2);
    return Math.min(d1, d2, d3, d4);
}

// Extract pad world coordinates
function rotLocal(x, y, deg) {
    const r = ((Number(deg) || 0) * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [x * c - y * s, x * s + y * c];
}

function padWorld(pl, pad) {
    const [lx, ly] = rotLocal(pad.x, pad.y, pl.rot || 0);
    return [lx + pl.x, ly + pl.y];
}

export function runDRC(doc, getFootprint) {
    const violations = [];
    const minClearanceMm = 0.2; // 0.2mm clearance rule

    // 1. Check Track vs Track Clearance
    const tracks = doc.tracks || [];
    for (let i = 0; i < tracks.length; i++) {
        for (let j = i + 1; j < tracks.length; j++) {
            const t1 = tracks[i];
            const t2 = tracks[j];
            // Only check if on the same layer and NOT the same net
            if (t1.layer !== t2.layer) continue;
            // If nets are defined and they are the same, it's ok. But our basic app might have empty nets.
            // For the demo, let's just warn if they cross at all, unless they share an endpoint exactly.

            const pts1 = t1.points;
            const pts2 = t2.points;
            
            for (let s1 = 0; s1 < pts1.length - 1; s1++) {
                for (let s2 = 0; s2 < pts2.length - 1; s2++) {
                    const dist = segmentsDistance(pts1[s1], pts1[s1+1], pts2[s2], pts2[s2+1]);
                    const requiredClearance = (t1.widthMm / 2) + (t2.widthMm / 2) + minClearanceMm;
                    
                    // Simple endpoint sharing exclusion
                    const shareEndpoint = (
                        (dist2(pts1[s1], pts2[s2]) < 0.001) ||
                        (dist2(pts1[s1], pts2[s2+1]) < 0.001) ||
                        (dist2(pts1[s1+1], pts2[s2]) < 0.001) ||
                        (dist2(pts1[s1+1], pts2[s2+1]) < 0.001)
                    );

                    if (!shareEndpoint && dist < requiredClearance) {
                        violations.push({
                            type: 'track_clearance',
                            message: `Clearance violation between tracks on ${t1.layer} (${dist.toFixed(2)}mm < ${requiredClearance.toFixed(2)}mm)`,
                            x: (pts1[s1][0] + pts2[s2][0]) / 2,
                            y: (pts1[s1][1] + pts2[s2][1]) / 2
                        });
                    }
                }
            }
        }
    }

    // 2. Check Track vs Pads (Demo)
    const placements = doc.placements || [];
    const allPads = [];
    for (const pl of placements) {
        const fp = getFootprint(pl.footprintId);
        if (!fp) continue;
        for (const pad of fp.pads || []) {
            const [px, py] = padWorld(pl, pad);
            allPads.push({ x: px, y: py, r: Math.max(pad.w, pad.h) / 2, layer: 'F.Cu' }); // Simplified pad
        }
    }

    for (const track of tracks) {
        if (track.layer !== 'F.Cu' && track.layer !== 'B.Cu') continue; // Simplified check
        for (let i = 0; i < track.points.length - 1; i++) {
            for (const pad of allPads) {
                if (pad.layer !== track.layer) continue;
                const dist = distToSegment([pad.x, pad.y], track.points[i], track.points[i+1]);
                const requiredClearance = (track.widthMm / 2) + pad.r + minClearanceMm;
                
                // Allow connection if track endpoint is exactly on pad center
                const endpointOnPad = (dist2(track.points[i], [pad.x, pad.y]) < 0.01 || dist2(track.points[i+1], [pad.x, pad.y]) < 0.01);

                if (!endpointOnPad && dist < requiredClearance) {
                    violations.push({
                        type: 'pad_clearance',
                        message: `Track too close to pad on ${track.layer}`,
                        x: pad.x,
                        y: pad.y
                    });
                }
            }
        }
    }

    return violations;
}
