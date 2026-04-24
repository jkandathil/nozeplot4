import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    MousePointer2, Cable, Hand, Trash2, RotateCw, ZoomIn, ZoomOut, Maximize2,
} from 'lucide-react';
import { SYMBOLS } from '../../circuit/symbols.js';
import {
    GRID, snap, componentPins,
    addWirePath, removeComponent, rotateComponent,
    translateComponent, translateWire,
    addLabel, removeWire,
} from '../../circuit/schematicDoc.js';
import { renderShape } from './renderShape.jsx';
import { GroundMarker } from './SymbolGlyph.jsx';

/**
 * Interactive schematic canvas — the centre pane of the editor.
 *
 * Tools:
 *   select  — click to select a component; drag to move it
 *   wire    — click a pin (or grid cell) to start a wire, click another
 *             to end it; polyline is manhattan-snapped
 *   pan     — hold mouse button to drag the view; wheel zooms
 *
 * Keyboard shortcuts (when the canvas has focus):
 *   V        select tool
 *   W        wire tool
 *   H        pan tool
 *   R        rotate selected component by 90°
 *   Del/Back delete selected component (or wire)
 *   +/-      zoom
 *   0        fit to content
 *
 * Drops from the palette arrive as `application/circuit-part` data; we
 * call `onCommand({ type: 'addPart', partId, x, y })` which the page
 * translates into an `addComponent` on the doc.
 */
export default function Canvas({
    doc,
    selectedId,
    onSelect,
    onCommand,
    onDocChange,
    resolvedNets,
    onUndo,
    onRedo,
    fitNonce = 0,
}) {
    const svgRef = useRef(null);
    const [tool, setTool] = useState('select'); // 'select' | 'wire' | 'pan'
    // Default to 2× so freshly-placed 80 px-wide symbols feel like real
    // parts on a ~800-wide canvas (they'd be thumbnail-sized at 1×).
    const [zoom, setZoom] = useState(2);
    const [pan, setPan] = useState({ x: 100, y: 100 });
    const [hoverPin, setHoverPin] = useState(null); // { compId, pinId, x, y }
    const [wireStart, setWireStart] = useState(null); // { x, y }
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 }); // world coords
    const [dragState, setDragState] = useState(null); // { kind: 'drag-comp'|'drag-wire'|'pan', … }
    // Live visual delta for the thing being dragged. We render the
    // component/wire with this offset applied without touching the doc
    // so (a) every drag frame doesn't bloat the undo stack and (b) the
    // preview is perfectly smooth instead of snapped-every-frame.
    const [dragDelta, setDragDelta] = useState(null); // { dx, dy }

    const wrapperRef = useRef(null);

    /* ------------------ coordinate conversion ------------------ */
    const clientToWorld = useCallback((ev) => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        const x = (ev.clientX - rect.left) / zoom - pan.x;
        const y = (ev.clientY - rect.top) / zoom - pan.y;
        return { x, y };
    }, [pan.x, pan.y, zoom]);

    /* ---------------------- drop handling ---------------------- */
    const onDragOver = (ev) => {
        if (ev.dataTransfer.types.includes('application/circuit-part')
            || ev.dataTransfer.types.includes('text/plain')) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
        }
    };
    const onDrop = (ev) => {
        ev.preventDefault();
        const partId = ev.dataTransfer.getData('application/circuit-part')
            || ev.dataTransfer.getData('text/plain');
        if (!partId) return;
        const { x, y } = clientToWorld(ev);
        onCommand({ type: 'addPart', partId, x: snap(x), y: snap(y) });
    };

    /* ---------------------- wheel / zoom ----------------------- */
    const onWheel = (ev) => {
        if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey && tool !== 'pan') return;
        ev.preventDefault();
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cx = ev.clientX - rect.left;
        const cy = ev.clientY - rect.top;
        const dz = Math.exp(-ev.deltaY * 0.001);
        const newZoom = Math.min(4, Math.max(0.25, zoom * dz));
        // keep the point under the cursor fixed
        const worldX = cx / zoom - pan.x;
        const worldY = cy / zoom - pan.y;
        const newPanX = cx / newZoom - worldX;
        const newPanY = cy / newZoom - worldY;
        setZoom(newZoom);
        setPan({ x: newPanX, y: newPanY });
    };

    /* ---------------------- mouse handlers --------------------- */

    const pinAt = useCallback((world, tol = 6) => {
        for (const comp of doc.components) {
            for (const pin of componentPins(comp)) {
                if (Math.abs(pin.x - world.x) <= tol && Math.abs(pin.y - world.y) <= tol) {
                    return { comp, pin };
                }
            }
        }
        return null;
    }, [doc.components]);

    const componentAt = useCallback((world) => {
        // Iterate from last (on top) to first; match by bounding box.
        for (let i = doc.components.length - 1; i >= 0; i--) {
            const comp = doc.components[i];
            const sym = SYMBOLS[comp.symbolKey] || SYMBOLS[comp.elementType];
            const half = sym ? Math.max(sym.width, sym.height) / 2 + 4
                              : 12;
            if (Math.abs(world.x - comp.pos.x) <= half
                && Math.abs(world.y - comp.pos.y) <= half) {
                return comp;
            }
        }
        return null;
    }, [doc.components]);

    const wireAt = useCallback((world, tol = 4) => {
        for (const w of doc.wires) {
            const pts = w.points;
            for (let i = 1; i < pts.length; i++) {
                const [x1, y1] = pts[i - 1];
                const [x2, y2] = pts[i];
                if (x1 === x2) {
                    if (Math.abs(world.x - x1) <= tol
                        && world.y >= Math.min(y1, y2) - tol
                        && world.y <= Math.max(y1, y2) + tol) return w;
                } else if (y1 === y2) {
                    if (Math.abs(world.y - y1) <= tol
                        && world.x >= Math.min(x1, x2) - tol
                        && world.x <= Math.max(x1, x2) + tol) return w;
                }
            }
        }
        return null;
    }, [doc.wires]);

    const onPointerDown = (ev) => {
        ev.currentTarget.setPointerCapture(ev.pointerId);
        if (ev.button === 1 || tool === 'pan' || (ev.button === 0 && ev.altKey)) {
            setDragState({ kind: 'pan', startClient: { x: ev.clientX, y: ev.clientY }, startPan: { ...pan } });
            ev.preventDefault();
            return;
        }
        const world = clientToWorld(ev);
        if (tool === 'wire') {
            const pin = pinAt(world);
            const sx = pin ? pin.pin.x : snap(world.x);
            const sy = pin ? pin.pin.y : snap(world.y);
            if (wireStart) {
                commitWire(wireStart, { x: sx, y: sy });
                setWireStart(null);
            } else {
                setWireStart({ x: sx, y: sy, startPin: pin || null });
            }
            return;
        }
        // select tool
        const pin = pinAt(world);
        if (pin) {
            // Clicking a pin enters wire mode opportunistically.
            setTool('wire');
            setWireStart({ x: pin.pin.x, y: pin.pin.y, startPin: pin });
            return;
        }
        const hit = componentAt(world);
        if (hit) {
            onSelect({ kind: 'component', id: hit.id });
            setDragState({
                kind: 'drag-comp',
                id: hit.id,
                startWorld: world,
            });
            setDragDelta({ dx: 0, dy: 0 });
            return;
        }
        const wireHit = wireAt(world);
        if (wireHit) {
            onSelect({ kind: 'wire', id: wireHit.id });
            setDragState({
                kind: 'drag-wire',
                id: wireHit.id,
                startWorld: world,
            });
            setDragDelta({ dx: 0, dy: 0 });
            return;
        }
        onSelect(null);
    };

    const onPointerMove = (ev) => {
        const world = clientToWorld(ev);
        setMousePos(world);
        if (dragState?.kind === 'pan') {
            const dx = (ev.clientX - dragState.startClient.x) / zoom;
            const dy = (ev.clientY - dragState.startClient.y) / zoom;
            setPan({ x: dragState.startPan.x + dx, y: dragState.startPan.y + dy });
            return;
        }
        if (dragState?.kind === 'drag-comp' || dragState?.kind === 'drag-wire') {
            // Snap the *delta* so the preview stays on the grid instead
            // of floating freely while the cursor moves.
            const dx = snap(world.x - dragState.startWorld.x);
            const dy = snap(world.y - dragState.startWorld.y);
            setDragDelta({ dx, dy });
            return;
        }
        // Pin hover highlight (select/wire tools)
        if (tool === 'select' || tool === 'wire') {
            const pin = pinAt(world, 8);
            setHoverPin(pin ? { compId: pin.comp.id, pinId: pin.pin.id, x: pin.pin.x, y: pin.pin.y } : null);
        }
    };

    const onPointerUp = (ev) => {
        try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        // Commit drags — one history entry per drag, no matter how far
        // the pointer travelled.
        if (dragState?.kind === 'drag-comp' && dragDelta) {
            const { dx, dy } = dragDelta;
            if (dx !== 0 || dy !== 0) {
                const id = dragState.id;
                onDocChange((d) => { translateComponent(d, id, dx, dy); });
            }
        } else if (dragState?.kind === 'drag-wire' && dragDelta) {
            const { dx, dy } = dragDelta;
            if (dx !== 0 || dy !== 0) {
                const id = dragState.id;
                onDocChange((d) => { translateWire(d, id, dx, dy); });
            }
        }
        setDragState(null);
        setDragDelta(null);
    };

    const commitWire = (start, end) => {
        if (start.x === end.x && start.y === end.y) return;
        onDocChange((d) => {
            // Manhattan path with horizontal-first bend.
            const pts = start.x === end.x || start.y === end.y
                ? [[start.x, start.y], [end.x, end.y]]
                : [[start.x, start.y], [end.x, start.y], [end.x, end.y]];
            addWirePath(d, pts);
            // Auto-stamp net labels at both endpoints so co-located pins
            // union correctly in label-authoritative mode. We use the
            // existing net at `start` (if any) otherwise mint a fresh
            // name from the next unused n<k> id.
            const existingAtStart = labelNameAt(d, start.x, start.y, resolvedNets);
            const existingAtEnd   = labelNameAt(d, end.x, end.y, resolvedNets);
            let name = existingAtStart || existingAtEnd;
            if (!name) {
                // Reserve a new name based on current max. We just pick a
                // simple counter off doc.meta (works in geometric mode too).
                d.meta.netCounter = (d.meta.netCounter || 0) + 1;
                name = `n${d.meta.netCounter}`;
            }
            addLabel(d, start.x, start.y, name, false);
            addLabel(d, end.x, end.y, name, false);
        });
    };

    /* --------------------- fit to content ---------------------- */
    const fitToContent = useCallback(() => {
        const bb = docBoundingBox(doc);
        const rect = wrapperRef.current?.getBoundingClientRect();
        if (!rect || !bb) return;
        const w = bb.maxX - bb.minX + 200;
        const h = bb.maxY - bb.minY + 200;
        const zx = rect.width / w;
        const zy = rect.height / h;
        const z = Math.min(4, Math.max(0.25, Math.min(zx, zy)));
        setZoom(z);
        setPan({
            x: -bb.minX + (rect.width / z - w) / 2 + 100,
            y: -bb.minY + (rect.height / z - h) / 2 + 100,
        });
    }, [doc]);

    /* --------------------- keyboard ---------------------------- */
    useEffect(() => {
        const handler = (ev) => {
            if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA'
                || ev.target.isContentEditable)) return;
            if (!wrapperRef.current || (!wrapperRef.current.contains(document.activeElement)
                && !wrapperRef.current.matches(':hover'))) return;
            const key = ev.key.toLowerCase();
            if (ev.ctrlKey || ev.metaKey) {
                if (key === 'z') {
                    ev.preventDefault();
                    if (ev.shiftKey) {
                        if (onRedo) onRedo();
                    } else {
                        if (onUndo) onUndo();
                    }
                    return;
                }
                if (key === 'y') {
                    ev.preventDefault();
                    if (onRedo) onRedo();
                    return;
                }
            }
            if (key === 'escape') { setWireStart(null); return; }
            if (key === 'v') { setTool('select'); return; }
            if (key === 'w') { setTool('wire'); return; }
            if (key === 'h') { setTool('pan'); return; }
            if (key === '0') { fitToContent(); return; }
            if (key === '+' || key === '=') { setZoom((z) => Math.min(4, z * 1.2)); return; }
            if (key === '-') { setZoom((z) => Math.max(0.25, z / 1.2)); return; }
            if (!selectedId) return;
            if (key === 'r' && selectedId.kind === 'component') {
                ev.preventDefault();
                onDocChange((d) => { rotateComponent(d, selectedId.id, 90); });
                return;
            }
            if (key === 'delete' || key === 'backspace') {
                ev.preventDefault();
                onDocChange((d) => {
                    if (selectedId.kind === 'component') removeComponent(d, selectedId.id);
                    else if (selectedId.kind === 'wire') removeWire(d, selectedId.id);
                });
                onSelect(null);
                return;
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [selectedId, onDocChange, onSelect, fitToContent, onUndo, onRedo]);

    // Fit-to-content only on external "load" events (demo import, blank
    // reset, raw-netlist apply) — we don't want the view to snap around
    // while the user is placing parts one at a time.
    useEffect(() => {
        if (fitNonce > 0 && doc.components.length > 0) {
            // Defer so the fresh doc has laid out in the DOM first.
            const t = setTimeout(fitToContent, 0);
            return () => clearTimeout(t);
        }
        return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitNonce]);

    /* --------------------- derived visuals --------------------- */
    const nets = resolvedNets;
    const floatingIds = useMemo(() => {
        if (!nets) return new Set();
        return new Set(nets.floatingPins.map((fp) => `${fp.comp.id}|${fp.pinId}`));
    }, [nets]);

    const wirePreview = (() => {
        if (tool !== 'wire' || !wireStart) return null;
        const pin = hoverPin;
        const ex = pin ? pin.x : snap(mousePos.x);
        const ey = pin ? pin.y : snap(mousePos.y);
        if (ex === wireStart.x && ey === wireStart.y) return null;
        return wireStart.x === ex || wireStart.y === ey
            ? [[wireStart.x, wireStart.y], [ex, ey]]
            : [[wireStart.x, wireStart.y], [ex, wireStart.y], [ex, ey]];
    })();

    /* --------------------- render ------------------------------ */
    return (
        <div
            className={`cs-canvas cs-canvas-tool-${tool}`}
            ref={wrapperRef}
            tabIndex={0}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onWheel={onWheel}
        >
            <div className="cs-canvas-toolbar">
                <ToolButton active={tool === 'select'} onClick={() => setTool('select')} title="Select / move (V)">
                    <MousePointer2 size={14} />
                </ToolButton>
                <ToolButton active={tool === 'wire'} onClick={() => setTool('wire')} title="Wire (W)">
                    <Cable size={14} />
                </ToolButton>
                <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')} title="Pan (H)">
                    <Hand size={14} />
                </ToolButton>
                <div className="cs-canvas-toolbar-sep" />
                <ToolButton
                    onClick={() => selectedId && selectedId.kind === 'component'
                        && onDocChange((d) => rotateComponent(d, selectedId.id, 90))}
                    disabled={!selectedId || selectedId.kind !== 'component'}
                    title="Rotate 90° (R)"
                >
                    <RotateCw size={14} />
                </ToolButton>
                <ToolButton
                    onClick={() => selectedId && onDocChange((d) => {
                        if (selectedId.kind === 'component') removeComponent(d, selectedId.id);
                        else if (selectedId.kind === 'wire') removeWire(d, selectedId.id);
                    }) && onSelect(null)}
                    disabled={!selectedId}
                    title="Delete (Del)"
                >
                    <Trash2 size={14} />
                </ToolButton>
                <div className="cs-canvas-toolbar-sep" />
                <ToolButton onClick={() => setZoom((z) => Math.max(0.25, z / 1.2))} title="Zoom out (-)">
                    <ZoomOut size={14} />
                </ToolButton>
                <span className="cs-canvas-zoomlabel">{Math.round(zoom * 100)}%</span>
                <ToolButton onClick={() => setZoom((z) => Math.min(4, z * 1.2))} title="Zoom in (+)">
                    <ZoomIn size={14} />
                </ToolButton>
                <ToolButton onClick={fitToContent} title="Fit to view (0)">
                    <Maximize2 size={14} />
                </ToolButton>
                <div className="cs-canvas-toolbar-spacer" />
                <div className="cs-canvas-hint">
                    {tool === 'wire' && (wireStart ? 'Click a pin or empty cell to finish. Esc to cancel.' : 'Click a pin to start a wire.')}
                    {tool === 'select' && (selectedId ? 'Drag to move. R to rotate. Del to delete.' : 'Drag parts from the palette. Click + drag a component or wire on the canvas to move it.')}
                    {tool === 'pan' && 'Drag to pan. Wheel to zoom.'}
                </div>
            </div>

            <svg
                ref={svgRef}
                className="cs-canvas-svg"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            >
                <defs>
                    <pattern id="cs-grid-minor" width={GRID} height={GRID} patternUnits="userSpaceOnUse" patternTransform={`scale(${zoom}) translate(${pan.x}, ${pan.y})`}>
                        <circle cx={0.5} cy={0.5} r={0.7} fill="var(--cs-grid-dot)" />
                    </pattern>
                </defs>
                <rect x={0} y={0} width="100%" height="100%" fill="url(#cs-grid-minor)" />

                <g transform={`scale(${zoom}) translate(${pan.x}, ${pan.y})`}>
                    {/* Wires */}
                    {doc.wires.map((w) => {
                        const selected = selectedId?.kind === 'wire' && selectedId.id === w.id;
                        const dragging = dragState?.kind === 'drag-wire' && dragState.id === w.id && dragDelta;
                        const tx = dragging ? dragDelta.dx : 0;
                        const ty = dragging ? dragDelta.dy : 0;
                        return (
                            <polyline
                                key={`wire-${w.id}`}
                                points={w.points.map((p) => `${p[0] + tx},${p[1] + ty}`).join(' ')}
                                fill="none"
                                stroke={selected ? 'var(--cs-accent)' : 'var(--sch-wire)'}
                                strokeWidth={selected ? 2.4 : 1.8}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                opacity={dragging ? 0.85 : 1}
                            />
                        );
                    })}

                    {/* Junctions */}
                    {nets?.junctions?.map((j, i) => (
                        <circle key={`jx-${i}`} cx={j.x} cy={j.y} r={3.2} fill="var(--sch-wire)" />
                    ))}

                    {/* Visible net labels */}
                    {doc.labels.filter((l) => l.visible).map((l) => (
                        <g key={`lab-${l.id}`} transform={`translate(${l.x}, ${l.y})`}>
                            <text
                                x={8} y={-6} fontSize={10}
                                fill="var(--cs-label)"
                                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                            >{l.name}</text>
                        </g>
                    ))}

                    {/* Components */}
                    {doc.components.map((c) => {
                        const dragging = dragState?.kind === 'drag-comp' && dragState.id === c.id && dragDelta;
                        return (
                            <CanvasComponent
                                key={`comp-${c.id}`}
                                comp={c}
                                selected={selectedId?.kind === 'component' && selectedId.id === c.id}
                                floatingIds={floatingIds}
                                dx={dragging ? dragDelta.dx : 0}
                                dy={dragging ? dragDelta.dy : 0}
                                ghost={!!dragging}
                            />
                        );
                    })}

                    {/* Pin hover highlight */}
                    {hoverPin && (
                        <circle cx={hoverPin.x} cy={hoverPin.y} r={6}
                            fill="none" stroke="var(--cs-accent)" strokeWidth={1.5}
                            pointerEvents="none" />
                    )}

                    {/* Wire preview */}
                    {wirePreview && (
                        <polyline
                            points={wirePreview.map((p) => `${p[0]},${p[1]}`).join(' ')}
                            fill="none"
                            stroke="var(--cs-accent)"
                            strokeWidth={1.8}
                            strokeDasharray="4 3"
                            pointerEvents="none"
                        />
                    )}
                    {wireStart && (
                        <circle cx={wireStart.x} cy={wireStart.y} r={3.5}
                            fill="var(--cs-accent)" pointerEvents="none" />
                    )}
                </g>
            </svg>

            {/* Drop-zone hint shown when doc is empty */}
            {doc.components.length === 0 && (
                <div className="cs-canvas-empty">
                    <h3>Empty canvas</h3>
                    <p>Drag components from the left palette, or load a demo circuit.</p>
                </div>
            )}
        </div>
    );
}

/* ---------------- sub-components ------------------------------ */

function ToolButton({ active, disabled, onClick, title, children }) {
    return (
        <button
            type="button"
            className={`cs-canvas-toolbtn${active ? ' is-active' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={title}
        >
            {children}
        </button>
    );
}

function CanvasComponent({ comp, selected, floatingIds, dx = 0, dy = 0, ghost = false }) {
    if (comp.elementType === 'GND') {
        return <GroundMarker x={comp.pos.x + dx} y={comp.pos.y + dy} selected={selected} />;
    }
    const sym = SYMBOLS[comp.symbolKey] || SYMBOLS[comp.elementType];
    if (!sym) return null;
    const labelRef = pickRefAnchor(sym);
    const valueText = formatValueLabel(comp);
    const pins = componentPins(comp);
    const cx = comp.pos.x + dx;
    const cy = comp.pos.y + dy;
    return (
        <g className={`cs-canvas-comp cs-comp-${comp.elementType}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}`}
           opacity={ghost ? 0.85 : 1}>
            <g transform={`translate(${cx}, ${cy}) rotate(${comp.rot})`}>
                {sym.shapes.map((s, i) => renderShape(s, i))}
                {selected && (
                    <rect
                        x={-sym.width / 2 - 4} y={-sym.height / 2 - 4}
                        width={sym.width + 8} height={sym.height + 8}
                        fill="none" stroke="var(--cs-accent)"
                        strokeWidth={1.2} strokeDasharray="3 3"
                    />
                )}
            </g>
            {/* ref + value text */}
            <text
                x={cx + labelRef.dx}
                y={cy + labelRef.dy}
                textAnchor={labelRef.anchor}
                fontSize={11} fontWeight={600}
                fill="var(--sch-label)"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                pointerEvents="none"
            >
                {comp.ref}
            </text>
            {valueText ? (
                <text
                    x={cx + labelRef.dx}
                    y={cy + labelRef.dy + 13}
                    textAnchor={labelRef.anchor}
                    fontSize={10}
                    fill="var(--sch-label-dim)"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    pointerEvents="none"
                >
                    {valueText}
                </text>
            ) : null}
            {/* Floating-pin markers */}
            {pins.map((pin) => {
                const key = `${comp.id}|${pin.id}`;
                if (!floatingIds.has(key)) return null;
                return (
                    <circle
                        key={`fp-${pin.id}`}
                        cx={pin.x + dx} cy={pin.y + dy} r={4}
                        fill="none"
                        stroke="var(--cs-warn)"
                        strokeWidth={1.4}
                        strokeDasharray="1.5 1.5"
                    />
                );
            })}
        </g>
    );
}

function pickRefAnchor(sym) {
    // Put the ref label to the right of tall symbols, above short ones.
    const w = sym.width, h = sym.height;
    if (h >= w) return { dx: w / 2 + 6, dy: -4, anchor: 'start' };
    return { dx: 0, dy: -h / 2 - 8, anchor: 'middle' };
}

function formatValueLabel(comp) {
    const unit = comp.valueUnit;
    switch (comp.elementType) {
        case 'R': return formatSI(comp.value, 'Ω');
        case 'C': return formatSI(comp.value, 'F');
        case 'L': return formatSI(comp.value, 'H');
        case 'E': return `E=${formatSI(comp.value || 1, 'V/V')}`;
        case 'G': return `G=${formatSI(comp.value || 1e-3, 'S')}`;
        case 'V': return summariseSource(comp.sourceSpec, 'V');
        case 'I': return summariseSource(comp.sourceSpec, 'A');
        case 'Q':
        case 'M':
        case 'D': return comp.modelRef || '';
        case 'O': return 'op-amp';
        default:  return unit ? formatSI(comp.value, unit) : '';
    }
}

function summariseSource(spec, unit) {
    if (!spec || spec.length === 0) return '';
    const dc = spec.find((s) => s.kind === 'dc');
    if (spec.length === 1 && dc) return `${formatSI(dc.v, unit)} DC`;
    const labels = spec.map((s) => s.kind.toUpperCase());
    return labels.join(' + ');
}

function formatSI(v, unit) {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return `0 ${unit}`;
    const av = Math.abs(v);
    const prefixes = [
        [1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
        [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
    ];
    for (const [m, s] of prefixes) {
        if (av >= m) {
            const scaled = v / m;
            const text = Math.abs(scaled) >= 100 ? scaled.toFixed(0)
                        : Math.abs(scaled) >= 10  ? scaled.toFixed(1)
                        : scaled.toPrecision(3);
            return `${text}${s}${unit}`;
        }
    }
    return `${v.toExponential(2)}${unit}`;
}

/** Look up the first label name attached to the given coord (if any). */
function labelNameAt(doc, x, y) {
    for (const lab of doc.labels) {
        if (lab.x === x && lab.y === y) return lab.name;
    }
    return null;
}

function docBoundingBox(doc) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of doc.components) {
        const sym = SYMBOLS[c.symbolKey] || SYMBOLS[c.elementType];
        const half = sym ? Math.max(sym.width, sym.height) / 2 + 20 : 20;
        minX = Math.min(minX, c.pos.x - half);
        minY = Math.min(minY, c.pos.y - half);
        maxX = Math.max(maxX, c.pos.x + half);
        maxY = Math.max(maxY, c.pos.y + half);
    }
    for (const w of doc.wires) {
        for (const [x, y] of w.points) {
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
}
