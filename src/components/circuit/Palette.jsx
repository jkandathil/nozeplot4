import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { CATEGORIES, LIBRARY, libraryByCategory, searchLibrary } from '../../circuit/library.js';
import { SYMBOLS } from '../../circuit/symbols.js';
import { SymbolGlyph } from './SymbolGlyph.jsx';

/**
 * Component palette — Flow-Lab-style left rail.
 *
 * Behaviour:
 *   • Search box filters the full library by name / short / description /
 *     element type.
 *   • When the search is empty, we show a list of categorical sections
 *     (Passive, Source, Semiconductor, …); each section can be
 *     collapsed by clicking its header.
 *   • Parts are draggable. We use native HTML5 drag-and-drop with a
 *     plain-text "application/circuit-part" payload carrying the part
 *     id. The canvas listens for this payload on `ondragover` /
 *     `ondrop`.
 *   • Each tile also has an `onClick` that calls `onPick(partId)` —
 *     useful for touch / keyboard users and as a fallback.
 */
export default function Palette({ onPick }) {
    const [q, setQ] = useState('');
    const [collapsed, setCollapsed] = useState(() => new Set());

    const groups = useMemo(() => {
        if (q.trim()) {
            return [{ id: 'search', name: 'Search results', items: searchLibrary(q.trim()) }];
        }
        return libraryByCategory();
    }, [q]);

    const toggle = (id) => setCollapsed((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    return (
        <div className="cs-palette">
            <div className="cs-palette-search">
                <Search size={14} className="cs-palette-search-icon" />
                <input
                    type="search"
                    placeholder="Search parts…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    aria-label="Search component library"
                />
            </div>

            <div className="cs-palette-scroll">
                {groups.map((group) => {
                    if (!group.items || group.items.length === 0) return null;
                    const isCollapsed = collapsed.has(group.id);
                    return (
                        <section key={group.id} className="cs-palette-group">
                            <header
                                className="cs-palette-group-title"
                                onClick={() => toggle(group.id)}
                                aria-expanded={!isCollapsed}
                            >
                                <span>{group.name}</span>
                                <span className="cs-palette-count">{group.items.length}</span>
                            </header>
                            {!isCollapsed && (
                                <div className="cs-palette-tiles">
                                    {group.items.map((part) => (
                                        <PaletteTile
                                            key={part.id}
                                            part={part}
                                            onPick={onPick}
                                        />
                                    ))}
                                </div>
                            )}
                        </section>
                    );
                })}
                {groups.every((g) => g.items.length === 0) && (
                    <div className="cs-palette-empty">
                        No parts match <b>{q}</b>.
                    </div>
                )}
            </div>

            <footer className="cs-palette-hint">
                Drag any part onto the canvas, or click to select and place.
                Hold <kbd>Shift</kbd> while dropping to keep the next tool
                active for multi-placement.
            </footer>
        </div>
    );
}

function PaletteTile({ part, onPick }) {
    const sym = SYMBOLS[part.symbolKey] || null;
    const onDragStart = (ev) => {
        ev.dataTransfer.setData('application/circuit-part', part.id);
        ev.dataTransfer.setData('text/plain', part.id);
        ev.dataTransfer.effectAllowed = 'copyMove';
    };
    return (
        <button
            type="button"
            className="cs-palette-tile"
            draggable
            onDragStart={onDragStart}
            onClick={() => onPick && onPick(part.id)}
            title={`${part.name} — ${part.description}`}
        >
            <div className="cs-palette-tile-glyph">
                {sym
                    ? <SymbolGlyph symbol={sym} partType={part.elementType} partId={part.symbolKey} size={56} />
                    : <div className="cs-palette-tile-badge">{part.short}</div>}
            </div>
            <div className="cs-palette-tile-meta">
                <div className="cs-palette-tile-name">{part.name}</div>
                <div className="cs-palette-tile-sub">{part.short}</div>
            </div>
        </button>
    );
}
