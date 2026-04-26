import React from 'react';
import { renderShape } from './renderShape.jsx';

/**
 * Renders a single SYMBOLS entry as a self-contained <svg>. Used by
 * both the palette (tiles) and the Inspector's preview thumbnail.
 *
 * Props:
 *   symbol   — a SYMBOL entry ({ width, height, pins, shapes, … })
 *   size     — pixel size of the bounding box (square)
 *   partType — element type letter; used only for GND fallback
 *   partId   — original symbol key, e.g. 'GND' for a non-SYMBOL part
 */
export function SymbolGlyph({ symbol, size = 52, partType, partId }) {
    if (!symbol) {
        // GND + anything else without a real SYMBOL entry gets a
        // simple glyph rather than an empty tile.
        if (partId === 'GND' || partType === 'GND') return <GroundGlyph size={size} />;
        return <div style={{ fontSize: 12, color: 'var(--cs-muted)' }}>{partType || '?'}</div>;
    }
    const pad = 6;
    const w = symbol.width + pad * 2;
    const h = (symbol.height || symbol.width) + pad * 2;
    return (
        <svg
            viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`}
            width={size}
            height={size}
            style={{ display: 'block' }}
        >
            <g>{symbol.shapes.map((s, i) => renderShape(s, i))}</g>
        </svg>
    );
}

function GroundGlyph({ size = 52 }) {
    return (
        <svg viewBox="-20 -20 40 40" width={size} height={size} style={{ display: 'block' }}>
            <line x1={0} y1={-16} x2={0} y2={-2} stroke="var(--sch-stroke)" strokeWidth={1.8} />
            <line x1={-12} y1={-2} x2={12} y2={-2} stroke="var(--sch-stroke)" strokeWidth={2.2} />
            <line x1={-8} y1={3} x2={8} y2={3} stroke="var(--sch-stroke)" strokeWidth={1.8} />
            <line x1={-4} y1={8} x2={4} y2={8} stroke="var(--sch-stroke)" strokeWidth={1.8} />
        </svg>
    );
}

/** Ground marker rendered directly on the canvas. */
export function GroundMarker({ x, y, selected, crossLinked = false }) {
    return (
        <g transform={`translate(${x}, ${y})`} className={`cs-gnd cs-comp-GND cs-canvas-comp ${selected ? 'is-selected' : ''}${crossLinked ? ' is-cross-link' : ''}`}>
            {crossLinked && !selected ? (
                <rect
                    x={-16}
                    y={-14}
                    width={32}
                    height={38}
                    rx={3}
                    ry={3}
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth={1.6}
                    strokeDasharray="4 3"
                    pointerEvents="none"
                />
            ) : null}
            {selected ? (
                <rect
                    x={-16} y={-14} width={32} height={38} rx={3} ry={3}
                    fill="color-mix(in srgb, var(--cs-accent) 12%, transparent)"
                    stroke="var(--cs-accent)" strokeWidth={2} strokeDasharray="4 3"
                    pointerEvents="none"
                />
            ) : null}
            <line x1={0} y1={-10} x2={0} y2={0} stroke="var(--sch-stroke)" strokeWidth={1.8} />
            <line x1={-10} y1={0} x2={10} y2={0} stroke="var(--sch-stroke)" strokeWidth={2.2} />
            <line x1={-7} y1={4} x2={7} y2={4} stroke="var(--sch-stroke)" strokeWidth={1.8} />
            <line x1={-4} y1={8} x2={4} y2={8} stroke="var(--sch-stroke)" strokeWidth={1.8} />
            <text x={0} y={22} fontSize={10} textAnchor="middle" fill="var(--sch-gnd-label)">GND</text>
        </g>
    );
}
