import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { libraryByCategory, searchAllLibraryParts } from '../../circuit/library.js';
import { SYMBOLS } from '../../circuit/symbols.js';
import { SymbolGlyph } from './SymbolGlyph.jsx';

/**
 * Component palette — Flow-Lab-style left rail.
 *
 * Behaviour:
 *   • Search box filters the full library by name / short / description /
 *     element type.
 *   • When the search is empty, **Downloaded parts** lists every device
 *     parsed from SPICE library rows; below that, categorical sections
 *     (Passive, Source, Semiconductor, …). Each section can be collapsed.
 *   • Parts are draggable. We use native HTML5 drag-and-drop with a
 *     plain-text "application/circuit-part" payload carrying the part
 *     id. The canvas listens for this payload on `ondragover` /
 *     `ondrop`.
 *   • Each tile also has an `onClick` that calls `onPick(partId)` —
 *     useful for touch / keyboard users and as a fallback.
 */
export default function Palette({ onPick, userLibraryParts = [] }) {
    const [q, setQ] = useState('');
    const [collapsed, setCollapsed] = useState(() => new Set());

    const searchGroups = useMemo(() => {
        if (!q.trim()) return null;
        return [{
            id: 'search',
            name: 'Search results',
            items: searchAllLibraryParts(q.trim(), userLibraryParts),
        }];
    }, [q, userLibraryParts]);

    const builtinGroups = useMemo(() => libraryByCategory(), []);

    const toggle = (id) => setCollapsed((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const renderGroup = (group) => {
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
                                variant={String(part.id || '').startsWith('ulib:') ? 'downloaded' : 'default'}
                            />
                        ))}
                    </div>
                )}
            </section>
        );
    };

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
                {searchGroups ? (
                    <>
                        {searchGroups.map(renderGroup)}
                        {searchGroups.every((g) => !g.items?.length) && (
                            <div className="cs-palette-empty">
                                No parts match <b>{q}</b>.
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <section className="cs-palette-group cs-palette-group-downloaded">
                            <header
                                className="cs-palette-group-title"
                                onClick={() => toggle('downloaded-parts')}
                                aria-expanded={!collapsed.has('downloaded-parts')}
                            >
                                <span>Downloaded parts</span>
                                <span className="cs-palette-count">{userLibraryParts.length}</span>
                            </header>
                            {!collapsed.has('downloaded-parts') && (
                                <div className="cs-palette-tiles cs-palette-tiles-downloaded">
                                    {userLibraryParts.length === 0 ? (
                                        <p className="cs-palette-downloaded-empty">
                                            None yet — add models from <strong>Netlist source</strong> → <strong>Model library…</strong>
                                        </p>
                                    ) : (
                                        userLibraryParts.map((part) => (
                                            <PaletteTile
                                                key={part.id}
                                                part={part}
                                                onPick={onPick}
                                                variant="downloaded"
                                            />
                                        ))
                                    )}
                                </div>
                            )}
                        </section>
                        {builtinGroups.map(renderGroup)}
                    </>
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

function PaletteTile({ part, onPick, variant = 'default' }) {
    const sym = SYMBOLS[part.symbolKey] || SYMBOLS[part.elementType] || null;
    const isDownloaded = variant === 'downloaded';
    const glyphSize = isDownloaded ? 48 : 56;
    const spiceName = part.spiceModelName || part.modelRef;
    const partNoNorm = String(part.partNumber || part.short || '').replace(/\s+/g, '').toLowerCase();
    const showSpiceName = isDownloaded && spiceName
        && String(spiceName).replace(/\s+/g, '').toLowerCase() !== partNoNorm;
    const onDragStart = (ev) => {
        ev.dataTransfer.setData('application/circuit-part', part.id);
        ev.dataTransfer.setData('text/plain', part.id);
        ev.dataTransfer.effectAllowed = 'copyMove';
    };
    const titleText = isDownloaded
        ? `${part.partNumber || part.short} (${part.spiceModelName || part.modelRef}) — ${part.description || ''}`
        : `${part.name} — ${part.description}`;
    return (
        <button
            type="button"
            className={`cs-palette-tile${isDownloaded ? ' cs-palette-tile--downloaded' : ''}`}
            draggable
            onDragStart={onDragStart}
            onClick={() => onPick && onPick(part.id)}
            title={titleText}
        >
            <div className={`cs-palette-tile-glyph cs-comp-${part.elementType}`}>
                {sym
                    ? (
                        <SymbolGlyph
                            symbol={sym}
                            partType={part.elementType}
                            partId={part.symbolKey}
                            size={glyphSize}
                        />
                    )
                    : (
                        <div className="cs-palette-tile-badge">{part.short}</div>
                    )}
            </div>
            <div className="cs-palette-tile-meta">
                {isDownloaded ? (
                    <>
                        <div className="cs-palette-tile-partno">{part.partNumber || part.short}</div>
                        {showSpiceName ? <div className="cs-palette-tile-model">{spiceName}</div> : null}
                    </>
                ) : (
                    <>
                        <div className="cs-palette-tile-name">{part.name}</div>
                        <div className="cs-palette-tile-sub">{part.short}</div>
                    </>
                )}
            </div>
        </button>
    );
}
