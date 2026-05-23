/**
 * Interactive 3-D Hansen Solubility Parameter viewer.
 *
 * Plots solvent points and any number of "spheres" (polymer solubility
 * spheres or fitted user spheres) in the canonical (δD, δP, δH) coordinate
 * system. Implemented with plain `<canvas>` + a small orthographic
 * projection so we avoid pulling in three.js (the bundle is already large).
 *
 * Controls:
 *   - Click + drag        ⇒  orbit camera around the centre of the box
 *   - Shift + drag        ⇒  pan
 *   - Mouse wheel         ⇒  zoom
 *   - Double click        ⇒  reset to default isometric view
 *   - Hover a solvent dot ⇒  tooltip with name + (dD, dP, dH)
 *
 * Drawing order is back-to-front by projected depth so transparent
 * spheres composite correctly with the points.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_AXIS_RANGE = { dD: [10, 25], dP: [0, 20], dH: [0, 45] };

/** Build a rotation matrix from yaw / pitch (radians). */
function buildRotation(yaw, pitch) {
    const cy = Math.cos(yaw),   sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    /* R = Rx(pitch) * Ry(yaw); column-major as 9-array */
    return [
        cy,        0,    -sy,
        sy * sp,   cp,    cy * sp,
        sy * cp,  -sp,    cy * cp,
    ];
}

/** Multiply a 3-vector by a 3x3 matrix stored row-major in 9 elements. */
function applyRot(m, v) {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
}

export default function HspSphereView({
    /** Array of `{ name, dD, dP, dH, color?, score? }` to render as dots. */
    points = [],
    /** Array of `{ name, dD, dP, dH, R, color? }` rendered as wire spheres. */
    spheres = [],
    /** Override the (min, max) range for each axis if your data is unusual. */
    axisRange,
    /** Highlight one solvent by name (drawn larger + ringed). */
    highlightName = null,
    /** Render at this CSS pixel size; the canvas auto-DPRs for retina. */
    height = 460,
}) {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [hover, setHover] = useState(null);
    const [view, setView] = useState({ yaw: -0.7, pitch: 0.45, zoom: 1.0, panX: 0, panY: 0 });
    const viewRef = useRef(view);
    viewRef.current = view;

    const range = useMemo(() => ({
        dD: axisRange?.dD || DEFAULT_AXIS_RANGE.dD,
        dP: axisRange?.dP || DEFAULT_AXIS_RANGE.dP,
        dH: axisRange?.dH || DEFAULT_AXIS_RANGE.dH,
    }), [axisRange]);

    /* ---------------- mouse interaction ---------------- */
    const dragState = useRef(null);
    const onMouseDown = useCallback((e) => {
        dragState.current = {
            x: e.clientX,
            y: e.clientY,
            yaw: viewRef.current.yaw,
            pitch: viewRef.current.pitch,
            panX: viewRef.current.panX,
            panY: viewRef.current.panY,
            shift: e.shiftKey,
        };
        e.preventDefault();
    }, []);
    const onMouseMove = useCallback((e) => {
        const st = dragState.current;
        if (!st) {
            /* Hover detection: walk through projected points and find the
               closest within 8 px. Tooltip data is the matched point. */
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const proj = projectAll(points, spheres, range, viewRef.current, rect.width, rect.height);
            let bestIdx = -1, bestD = 64;
            for (let i = 0; i < proj.points.length; i++) {
                const p = proj.points[i];
                const dx = p.x - mx, dy = p.y - my;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD) { bestD = d2; bestIdx = i; }
            }
            setHover(bestIdx >= 0 ? { ...points[bestIdx], x: proj.points[bestIdx].x, y: proj.points[bestIdx].y } : null);
            return;
        }
        const dx = (e.clientX - st.x) / 200;
        const dy = (e.clientY - st.y) / 200;
        if (st.shift) {
            setView((v) => ({ ...v, panX: st.panX + (e.clientX - st.x), panY: st.panY + (e.clientY - st.y) }));
        } else {
            setView((v) => ({
                ...v,
                yaw: st.yaw + dx,
                pitch: Math.max(-1.4, Math.min(1.4, st.pitch + dy)),
            }));
        }
    }, [points, spheres, range]);
    const onMouseUp = useCallback(() => { dragState.current = null; }, []);
    const onWheel = useCallback((e) => {
        e.preventDefault();
        setView((v) => {
            const z = v.zoom * (e.deltaY > 0 ? 0.9 : 1.1);
            return { ...v, zoom: Math.max(0.3, Math.min(4, z)) };
        });
    }, []);
    const onDoubleClick = useCallback(() => {
        setView({ yaw: -0.7, pitch: 0.45, zoom: 1.0, panX: 0, panY: 0 });
    }, []);

    /* ---------------- render loop ---------------- */
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const wrapper = wrapperRef.current;
        const cssW = wrapper?.clientWidth || 600;
        const cssH = height;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, 0, cssW, cssH);

        const proj = projectAll(points, spheres, range, view, cssW, cssH);
        drawAxes(ctx, range, view, cssW, cssH);
        /* Render order: spheres first (as wireframes), then points so they
           pop on top of the polymer sphere outline. */
        for (const s of proj.sphereWires) drawSphereWire(ctx, s);
        for (let i = 0; i < proj.points.length; i++) {
            const pp = proj.points[i];
            const src = points[i];
            const isHl = highlightName && src?.name === highlightName;
            drawPoint(ctx, pp, src, isHl);
        }
    }, [points, spheres, view, range, height, highlightName]);

    return (
        <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
            <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={() => { dragState.current = null; setHover(null); }}
                onWheel={onWheel}
                onDoubleClick={onDoubleClick}
                style={{
                    width: '100%', height,
                    borderRadius: 8,
                    cursor: dragState.current ? 'grabbing' : 'grab',
                    display: 'block',
                }}
            />
            {hover && (
                <div
                    style={{
                        position: 'absolute',
                        left: Math.min(hover.x + 12, (wrapperRef.current?.clientWidth || 400) - 220),
                        top: Math.max(8, hover.y - 14),
                        background: 'rgba(15, 23, 42, 0.95)',
                        color: '#e2e8f0',
                        border: '1px solid rgba(56,189,248,0.35)',
                        borderRadius: 6,
                        padding: '6px 8px',
                        fontSize: 11,
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                        boxShadow: '0 4px 10px rgba(0,0,0,0.4)',
                    }}
                >
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{hover.name}</div>
                    <div style={{ fontVariantNumeric: 'tabular-nums', color: '#94a3b8' }}>
                        δD {hover.dD?.toFixed(1)} · δP {hover.dP?.toFixed(1)} · δH {hover.dH?.toFixed(1)}
                    </div>
                </div>
            )}
            <div style={{
                position: 'absolute', right: 8, bottom: 8,
                fontSize: 10, color: '#64748b',
                background: 'rgba(15,23,42,0.6)', padding: '2px 6px', borderRadius: 4,
            }}>
                drag·orbit · shift-drag·pan · wheel·zoom · dbl-click·reset
            </div>
        </div>
    );
}

/* -------- projection helpers (module-private) -------- */

function makeAxisMap(range) {
    const span = (r) => Math.max(1e-3, r[1] - r[0]);
    return {
        toUnitX: (dD) => (dD - range.dD[0]) / span(range.dD),
        toUnitY: (dP) => (dP - range.dP[0]) / span(range.dP),
        toUnitZ: (dH) => (dH - range.dH[0]) / span(range.dH),
    };
}

function projectAll(points, spheres, range, view, w, h) {
    const ax = makeAxisMap(range);
    const m = buildRotation(view.yaw, view.pitch);
    const cx = w / 2 + view.panX;
    const cy = h / 2 + view.panY;
    const scale = Math.min(w, h) * 0.35 * view.zoom;

    const projectXYZ = (dD, dP, dH) => {
        /* Map data → unit cube centred on origin so rotation looks natural. */
        const x = ax.toUnitX(dD) - 0.5;
        const y = ax.toUnitY(dP) - 0.5;
        const z = ax.toUnitZ(dH) - 0.5;
        const r = applyRot(m, [x, y, z]);
        return { x: cx + r[0] * scale, y: cy - r[1] * scale, depth: r[2] };
    };

    const pts = points.map((p) => projectXYZ(p.dD, p.dP, p.dH));
    /* Sort indices by depth for back-to-front draw, but keep original
       caller index mapping so hover detection stays aligned. */
    const sphereWires = spheres.map((s) => {
        /* Sample a spherical surface as circles in three orthogonal planes —
           cheaper than a full mesh and renders to a wire look. The HSP
           sphere is in 4·δD-corrected space, so the dispersion radius is
           half the requested R (because Ra² uses 4·(δD-δD0)²). */
        const samples = 36;
        const rings = [];
        for (const plane of ['xy', 'yz', 'xz']) {
            const ring = [];
            for (let i = 0; i <= samples; i++) {
                const t = (2 * Math.PI * i) / samples;
                const ct = Math.cos(t), st = Math.sin(t);
                let dx = 0, dy = 0, dz = 0;
                if (plane === 'xy') { dx = ct; dy = st; }
                else if (plane === 'yz') { dy = ct; dz = st; }
                else { dx = ct; dz = st; }
                /* `dx` is along the dispersion axis in unit space; the
                   physical δD-radius is R/2 (because of the factor-of-4
                   in Ra²); the other two axes use R directly. */
                const dD = s.dD + dx * s.R / 2;
                const dP = s.dP + dy * s.R;
                const dH = s.dH + dz * s.R;
                ring.push(projectXYZ(dD, dP, dH));
            }
            rings.push(ring);
        }
        return { color: s.color || '#fbbf24', name: s.name, rings };
    });

    return { points: pts, sphereWires };
}

function drawAxes(ctx, range, view, w, h) {
    ctx.save();
    ctx.font = '11px ui-sans-serif, system-ui';
    const m = buildRotation(view.yaw, view.pitch);
    const cx = w / 2 + view.panX;
    const cy = h / 2 + view.panY;
    const scale = Math.min(w, h) * 0.35 * view.zoom;
    const project = (x, y, z) => {
        const r = applyRot(m, [x, y, z]);
        return { x: cx + r[0] * scale, y: cy - r[1] * scale };
    };
    /* Draw a unit cube wireframe to give depth cues. */
    const corners = [];
    for (const z of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const x of [-0.5, 0.5]) {
        corners.push(project(x, y, z));
    }
    const edges = [
        [0, 1], [1, 3], [3, 2], [2, 0],
        [4, 5], [5, 7], [7, 6], [6, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.45)';
    ctx.lineWidth = 1;
    for (const [a, b] of edges) {
        ctx.beginPath();
        ctx.moveTo(corners[a].x, corners[a].y);
        ctx.lineTo(corners[b].x, corners[b].y);
        ctx.stroke();
    }
    /* Axis ticks at min, mid, max + labels. */
    const ticks = [
        { label: 'δD', axis: 'x', span: range.dD, color: '#60a5fa' },
        { label: 'δP', axis: 'y', span: range.dP, color: '#f472b6' },
        { label: 'δH', axis: 'z', span: range.dH, color: '#34d399' },
    ];
    ctx.lineWidth = 1.4;
    for (const t of ticks) {
        ctx.strokeStyle = t.color;
        ctx.fillStyle = t.color;
        let a, b, end;
        if (t.axis === 'x') { a = project(-0.5, -0.5, -0.5); b = project(0.5, -0.5, -0.5); end = b; }
        else if (t.axis === 'y') { a = project(-0.5, -0.5, -0.5); b = project(-0.5, 0.5, -0.5); end = b; }
        else { a = project(-0.5, -0.5, -0.5); b = project(-0.5, -0.5, 0.5); end = b; }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.fillText(`${t.label}  ${t.span[0]}–${t.span[1]}`, end.x + 4, end.y - 2);
    }
    ctx.restore();
}

function drawPoint(ctx, projPt, src, isHighlight) {
    ctx.save();
    /* Score-aware colouring: green for good (1), red for bad (0), neutral
       blue otherwise. Caller may override via `src.color`. */
    let fill = src.color;
    if (!fill) {
        if (src.score === 1 || src.score === true) fill = '#34d399';
        else if (src.score === 0 || src.score === false) fill = '#f87171';
        else fill = '#38bdf8';
    }
    const baseRadius = isHighlight ? 7 : 4;
    /* A subtle size-by-depth so closer points look slightly bigger. */
    const depthScale = 1 + (projPt.depth || 0) * 0.4;
    const radius = baseRadius * Math.max(0.6, Math.min(1.4, depthScale));
    ctx.fillStyle = fill;
    ctx.strokeStyle = isHighlight ? '#fde68a' : 'rgba(15,23,42,0.85)';
    ctx.lineWidth = isHighlight ? 2 : 1;
    ctx.beginPath();
    ctx.arc(projPt.x, projPt.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

function drawSphereWire(ctx, s) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.65;
    for (const ring of s.rings) {
        ctx.beginPath();
        ring.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
    }
    ctx.restore();
}
