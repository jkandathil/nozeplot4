import React from 'react';

/** Renders a single SYMBOLS.shapes entry — shared by the palette tile,
 * the inspector thumbnail and the main canvas. Split into its own
 * module so the React Fast Refresh rule (components-only exports) is
 * satisfied for SymbolGlyph.jsx. */
export function renderShape(s, key) {
    const strokeColor = 'var(--sch-stroke)';
    const strokeWidth = s.strokeWidth ?? 1.6;
    switch (s.kind) {
        case 'line':
            return (
                <line
                    key={key}
                    x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    strokeDasharray={s.strokeDasharray}
                    strokeLinecap="round"
                    opacity={s.opacity}
                />
            );
        case 'rect':
            return (
                <rect
                    key={key}
                    x={s.x} y={s.y} width={s.w} height={s.h}
                    rx={s.rx} ry={s.ry}
                    fill={s.fill === 'var(--sch-body)' ? 'var(--sch-body)'
                        : s.fill === 'var(--sch-stroke)' ? 'var(--sch-stroke)'
                        : s.fill || 'none'}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    opacity={s.opacity}
                />
            );
        case 'path':
            return (
                <path
                    key={key}
                    d={s.d}
                    fill={s.fill === 'var(--sch-stroke)' ? 'var(--sch-stroke)'
                        : s.fill === 'var(--sch-body)' ? 'var(--sch-body)'
                        : s.fill || 'none'}
                    stroke={s.fill === 'var(--sch-stroke)' ? 'none' : strokeColor}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            );
        case 'circle':
            return (
                <circle
                    key={key}
                    cx={s.cx} cy={s.cy} r={s.r}
                    fill={s.fill || 'none'}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                />
            );
        case 'polarity':
            return (
                <text
                    key={key}
                    x={s.x} y={s.y}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={13} fontWeight={700}
                    fill={strokeColor} fontFamily="serif"
                >
                    {s.sign}
                </text>
            );
        case 'text':
            return (
                <text
                    key={key}
                    x={s.x} y={s.y}
                    textAnchor={s.anchor || 'middle'}
                    dominantBaseline={s.baseline || 'middle'}
                    fontSize={s.fontSize || 11}
                    fontWeight={s.fontWeight || 500}
                    fill={strokeColor}
                    fontFamily={s.fontFamily || 'ui-sans-serif, system-ui, sans-serif'}
                >
                    {s.text}
                </text>
            );
        case 'arrow': {
            const size = s.size || 6;
            const dx = s.dir === 'R' ? size : s.dir === 'L' ? -size : 0;
            const dy = s.dir === 'D' ? size : s.dir === 'U' ? -size : 0;
            const perpX = -dy, perpY = dx;
            const points = [
                [s.x, s.y],
                [s.x - dx + perpX * 0.5, s.y - dy + perpY * 0.5],
                [s.x - dx - perpX * 0.5, s.y - dy - perpY * 0.5],
            ].map((p) => p.join(',')).join(' ');
            return (
                <polygon key={key} points={points} fill={strokeColor} />
            );
        }
        default:
            return null;
    }
}
