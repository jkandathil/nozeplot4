import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    MousePointer2, Cable, Hand, Trash2, RotateCw, ZoomIn, ZoomOut, Maximize2,
    AlertTriangle, AlertCircle,
} from 'lucide-react';
import { SYMBOLS } from '../../circuit/symbols.js';
import {
    GRID, snap, componentPins,
    addWirePath, removeComponent, rotateComponent,
    translateComponent, translateWire,
    translateComponentRubber, translateWireRubber,
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
    validation,
    onUndo,
    onRedo,
    onEditComponent,
    onOpenScope,
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
    // Wheel zooms the canvas around the cursor position. Holding Shift
    // gives finer (slower) zoom steps for precise positioning. Modifier-
    // free scroll is intentional: it's the de-facto standard in KiCad /
    // LTspice / Eagle, and matches how most users expect a CAD-like
    // canvas to behave.
    //
    // The listener is attached as a native, non-passive event so we can
    // call preventDefault() and stop the page behind the canvas from
    // scrolling — React's synthetic onWheel is passive by default.
    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return undefined;
        const handler = (ev) => {
            ev.preventDefault();
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect) return;
            const cx = ev.clientX - rect.left;
            const cy = ev.clientY - rect.top;
            const speed = ev.shiftKey ? 0.0003 : 0.001;
            const dz = Math.exp(-ev.deltaY * speed);
            const newZoom = Math.min(8, Math.max(0.1, zoom * dz));
            if (newZoom === zoom) return;
            // Keep the point under the cursor fixed in world space.
            const worldX = cx / zoom - pan.x;
            const worldY = cy / zoom - pan.y;
            const newPanX = cx / newZoom - worldX;
            const newPanY = cy / newZoom - worldY;
            setZoom(newZoom);
            setPan({ x: newPanX, y: newPanY });
        };
        el.addEventListener('wheel', handler, { passive: false });
        return () => el.removeEventListener('wheel', handler);
    }, [zoom, pan.x, pan.y]);

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
            // Localized drag: the component moves, and any wire
            // vertex that was sitting on one of its pin coords
            // (either as an endpoint or spliced into a segment)
            // follows along. Holding Ctrl/Cmd is the escape hatch
            // to tear the component out without stretching wires.
            const wireFollow = ev.ctrlKey || ev.metaKey
                ? null
                : computeComponentFollow(doc, hit.id);
            setDragState({
                kind: 'drag-comp',
                id: hit.id,
                startWorld: world,
                wireFollow,
            });
            setDragDelta({ dx: 0, dy: 0 });
            return;
        }
        const wireHit = wireAt(world);
        if (wireHit) {
            onSelect({ kind: 'wire', id: wireHit.id });
            // Localized wire drag: only this wire translates, and any
            // endpoint that was anchored to a component pin stays
            // locked (we'll insert a bend on commit). Ctrl/Cmd skips
            // the anchoring so the wire moves rigidly.
            const anchors = ev.ctrlKey || ev.metaKey
                ? { first: false, last: false }
                : computeWireAnchors(doc, wireHit.id);
            setDragState({
                kind: 'drag-wire',
                id: wireHit.id,
                startWorld: world,
                anchors,
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
        // Commit drags — one history entry per drag, no matter how
        // far the pointer travelled. Localized behaviour: components
        // move and stretch their connected wires; wires translate
        // while staying anchored to any pins on their endpoints.
        // Ctrl/Cmd disables the stretching (see onPointerDown) and
        // falls back to the legacy single-element translators.
        if (dragState?.kind === 'drag-comp' && dragDelta) {
            const { dx, dy } = dragDelta;
            if (dx !== 0 || dy !== 0) {
                const { id, wireFollow } = dragState;
                if (wireFollow) {
                    onDocChange((d) => { translateComponentRubber(d, id, dx, dy); });
                } else {
                    onDocChange((d) => { translateComponent(d, id, dx, dy); });
                }
            }
        } else if (dragState?.kind === 'drag-wire' && dragDelta) {
            const { dx, dy } = dragDelta;
            if (dx !== 0 || dy !== 0) {
                const { id, anchors } = dragState;
                if (anchors && (anchors.first || anchors.last)) {
                    onDocChange((d) => { translateWireRubber(d, id, dx, dy); });
                } else {
                    onDocChange((d) => { translateWire(d, id, dx, dy); });
                }
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
        const z = Math.min(8, Math.max(0.1, Math.min(zx, zy)));
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
            if (key === '+' || key === '=') { setZoom((z) => Math.min(8, z * 1.2)); return; }
            if (key === '-') { setZoom((z) => Math.max(0.1, z / 1.2)); return; }
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
    // Pull the validator's pre-built Sets when available; otherwise
    // fall back to re-deriving floating pins from nets so the canvas
    // still draws its original warning rings if a caller forgets to
    // pass validation in.
    const floatingIds = useMemo(() => {
        if (validation?.floatingPinKeys) return validation.floatingPinKeys;
        if (!nets) return new Set();
        return new Set(nets.floatingPins.map((fp) => `${fp.comp.id}|${fp.pinId}`));
    }, [validation, nets]);
    const flaggedComponentIds = validation?.flaggedComponentIds || new Set();
    const flaggedWireIds = validation?.flaggedWireIds || new Set();
    const danglingEndpoints = validation?.danglingEndpoints || [];
    const errorCount = validation?.errorCount || 0;
    const warnCount = validation?.warnCount || 0;

    // Connection dots — a green filled circle rendered wherever a
    // component pin physically coincides with a wire (endpoint or
    // mid-segment). Gives the user an at-a-glance "pin is wired" cue
    // without needing to run the simulator. Floating pins get their
    // own dashed-warn marker on the component itself, so any pin that
    // isn't showing a green dot OR a warn ring is literally unreachable.
    const connectionDots = useMemo(() => {
        if (!doc) return [];
        const out = [];
        const seen = new Set(); // de-dupe coords across pins/components
        // Precompute wire geometry once.
        const wires = doc.wires || [];
        const onWire = (x, y) => {
            for (const w of wires) {
                const pts = w.points;
                // Exact vertex hit
                for (let i = 0; i < pts.length; i++) {
                    if (pts[i][0] === x && pts[i][1] === y) return true;
                }
                // Mid-segment hit (axis-aligned only; matches the same
                // logic resolveNets uses for T-junctions).
                for (let s = 1; s < pts.length; s++) {
                    const [x1, y1] = pts[s - 1];
                    const [x2, y2] = pts[s];
                    if (y1 === y2 && y === y1
                        && x > Math.min(x1, x2) && x < Math.max(x1, x2)) return true;
                    if (x1 === x2 && x === x1
                        && y > Math.min(y1, y2) && y < Math.max(y1, y2)) return true;
                }
            }
            return false;
        };
        for (const c of doc.components) {
            // Ground symbol is itself the terminator, not a "connected pin".
            if (c.elementType === 'GND') continue;
            const pins = componentPins(c);
            for (const p of pins) {
                if (!onWire(p.x, p.y)) continue;
                const key = `${p.x}|${p.y}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ x: p.x, y: p.y });
            }
        }
        return out;
    }, [doc]);

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
                <ToolButton onClick={() => setZoom((z) => Math.max(0.1, z / 1.2))} title="Zoom out (- or scroll down)">
                    <ZoomOut size={14} />
                </ToolButton>
                <span className="cs-canvas-zoomlabel">{Math.round(zoom * 100)}%</span>
                <ToolButton onClick={() => setZoom((z) => Math.min(8, z * 1.2))} title="Zoom in (+ or scroll up)">
                    <ZoomIn size={14} />
                </ToolButton>
                <ToolButton onClick={fitToContent} title="Fit to view (0)">
                    <Maximize2 size={14} />
                </ToolButton>
                {(errorCount + warnCount) > 0 && (
                    <IssueBadge
                        errorCount={errorCount}
                        warnCount={warnCount}
                        issues={validation?.issues || []}
                        onSelectComponent={(id) => onSelect && onSelect({ kind: 'component', id })}
                        onSelectWire={(id) => onSelect && onSelect({ kind: 'wire', id })}
                    />
                )}
                <div className="cs-canvas-toolbar-spacer" />
                <div className="cs-canvas-hint">
                    {tool === 'wire' && (wireStart ? 'Click a pin or empty cell to finish. Esc to cancel.' : 'Click a pin to start a wire.')}
                    {tool === 'select' && (selectedId ? 'Drag to move just this part — connected wires stretch to follow. Hold Ctrl to detach. Double-click to edit. R rotate · Del delete.' : 'Drag parts from the palette. Click to select, drag to move. Wires stretch with connected pins. Double-click to edit a property.')}
                    {tool === 'pan' && 'Drag to pan. Scroll wheel to zoom (Shift = finer).'}
                </div>
            </div>

            <svg
                ref={svgRef}
                className="cs-canvas-svg"
                data-cs-canvas-svg=""
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={(ev) => {
                    const world = clientToWorld(ev);
                    const hit = componentAt(world);
                    if (!hit) return;
                    // Oscilloscope: pop the waveform viewer instead
                    // of the property popup.
                    if (hit.elementType === 'SCOPE') {
                        onSelect({ kind: 'component', id: hit.id });
                        if (onOpenScope) onOpenScope({ compId: hit.id });
                        ev.stopPropagation();
                        return;
                    }
                    // Fixed parts with nothing meaningful to edit.
                    if (hit.elementType === 'GND' || hit.elementType === 'VP') return;
                    if (!onEditComponent) return;
                    onSelect({ kind: 'component', id: hit.id });
                    onEditComponent({
                        compId: hit.id,
                        clientX: ev.clientX,
                        clientY: ev.clientY,
                    });
                    ev.stopPropagation();
                }}
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
                        const flagged = flaggedWireIds.has(w.id);
                        let stroke = 'var(--sch-wire)';
                        if (selected) stroke = 'var(--cs-accent)';
                        else if (flagged) stroke = 'var(--cs-danger, #ef4444)';

                        // Localized drag preview: compute the point
                        // list this wire should render *right now*.
                        // Base case is the committed polyline; we
                        // rewrite it below if this wire is involved
                        // in the active drag.
                        const pts = previewWirePoints(w, dragState, dragDelta);
                        const dragging = pts !== w.points;

                        return (
                            <polyline
                                key={`wire-${w.id}`}
                                points={pts.map((p) => `${p[0]},${p[1]}`).join(' ')}
                                fill="none"
                                stroke={stroke}
                                strokeWidth={selected ? 2.4 : 1.8}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                opacity={dragging ? 0.85 : 1}
                            />
                        );
                    })}

                    {/* Dangling wire endpoint markers — dashed red X so the
                        eye is drawn to the exact spot that needs a connection. */}
                    {danglingEndpoints.map((e) => {
                        const r = 5;
                        return (
                            <g key={`dangle-${e.wireId}-${e.pointIndex}`} pointerEvents="none">
                                <circle
                                    cx={e.x} cy={e.y} r={r + 1}
                                    fill="none"
                                    stroke="var(--cs-danger, #ef4444)"
                                    strokeWidth={1.4}
                                    strokeDasharray="2 2"
                                />
                                <line
                                    x1={e.x - r} y1={e.y - r}
                                    x2={e.x + r} y2={e.y + r}
                                    stroke="var(--cs-danger, #ef4444)"
                                    strokeWidth={1.4}
                                />
                                <line
                                    x1={e.x - r} y1={e.y + r}
                                    x2={e.x + r} y2={e.y - r}
                                    stroke="var(--cs-danger, #ef4444)"
                                    strokeWidth={1.4}
                                />
                            </g>
                        );
                    })}

                    {/* Junctions (≥3-way) — drawn in the wire color so
                        T-intersections read as part of the net. */}
                    {nets?.junctions?.map((j, i) => (
                        <circle key={`jx-${i}`} cx={j.x} cy={j.y} r={3.2} fill="var(--sch-wire)" />
                    ))}

                    {/* Pin-on-wire connection dots — bright green so a
                        successful connection is unmistakable. Hidden
                        briefly while the user is actively dragging
                        something so we don't paint dots at stale pin
                        coords mid-drag. */}
                    {!dragDelta && connectionDots.map((d, i) => (
                        <g key={`cd-${i}`} pointerEvents="none">
                            <circle cx={d.x} cy={d.y} r={4.2}
                                fill="var(--sch-connection)"
                                stroke="var(--sch-paper)" strokeWidth={1} />
                        </g>
                    ))}

                    {/* Visible net labels */}
                    {doc.labels.filter((l) => l.visible).map((l) => {
                        // A label only follows a drag if it was
                        // attached to a pin of the component being
                        // dragged (i.e. its id is in the follow set).
                        const followSet = dragState?.wireFollow?.labelIds;
                        const follows = !!(dragDelta && followSet && followSet.has(l.id));
                        const tx = follows ? dragDelta.dx : 0;
                        const ty = follows ? dragDelta.dy : 0;
                        return (
                            <g key={`lab-${l.id}`} transform={`translate(${l.x + tx}, ${l.y + ty})`} opacity={follows ? 0.85 : 1}>
                                <text
                                    x={8} y={-6} fontSize={10}
                                    fill="var(--cs-label)"
                                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                                >{l.name}</text>
                            </g>
                        );
                    })}

                    {/* Components */}
                    {doc.components.map((c) => {
                        // Only the dragged component itself moves
                        // during a component drag — everything else
                        // stays put while its connected wires stretch.
                        const dragging = !!(
                            dragDelta
                            && dragState?.kind === 'drag-comp'
                            && dragState.id === c.id
                        );
                        return (
                            <CanvasComponent
                                key={`comp-${c.id}`}
                                comp={c}
                                selected={selectedId?.kind === 'component' && selectedId.id === c.id}
                                flagged={flaggedComponentIds.has(c.id)}
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

/**
 * Issue counter shown in the canvas toolbar. Click expands a dropdown
 * listing every design-rule violation; clicking an issue row selects
 * the offending component or wire so the user can jump straight to
 * the problem. Severity tint is driven by whether any errors exist —
 * a single error flips the whole badge red even when warnings dominate.
 */
function IssueBadge({ errorCount, warnCount, issues, onSelectComponent, onSelectWire }) {
    const [open, setOpen] = useState(false);
    const hasErrors = errorCount > 0;
    const total = errorCount + warnCount;
    const Icon = hasErrors ? AlertCircle : AlertTriangle;
    const tint = hasErrors ? 'var(--cs-danger, #ef4444)' : 'var(--cs-warn, #eab308)';
    return (
        <div className="cs-canvas-issues">
            <button
                type="button"
                className="cs-canvas-issues-btn"
                onClick={() => setOpen((v) => !v)}
                title={`${errorCount} error${errorCount === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'}`}
                style={{ color: tint, borderColor: tint }}
            >
                <Icon size={14} />
                <span>{total}</span>
            </button>
            {open && (
                <div className="cs-canvas-issues-panel" onMouseLeave={() => setOpen(false)}>
                    <div className="cs-canvas-issues-title">Design-rule issues</div>
                    <ul>
                        {issues.map((iss) => (
                            <li
                                key={iss.id}
                                className={`cs-canvas-issue cs-canvas-issue-${iss.severity}`}
                                onClick={() => {
                                    if (iss.componentIds?.length) onSelectComponent(iss.componentIds[0]);
                                    else if (iss.wireIds?.length) onSelectWire(iss.wireIds[0]);
                                    setOpen(false);
                                }}
                            >
                                <span className="cs-canvas-issue-dot" />
                                <span>{iss.message}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

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

function CanvasComponent({ comp, selected, flagged = false, floatingIds, dx = 0, dy = 0, ghost = false }) {
    if (comp.elementType === 'GND') {
        return <GroundMarker x={comp.pos.x + dx} y={comp.pos.y + dy} selected={selected} />;
    }
    const sym = SYMBOLS[comp.symbolKey] || SYMBOLS[comp.elementType];
    if (!sym) return null;
    const labelPos = pickRefLabelPosition(sym, comp.rot);
    const valueText = formatValueLabel(comp);
    const pins = componentPins(comp);
    const cx = comp.pos.x + dx;
    const cy = comp.pos.y + dy;
    return (
        <g className={`cs-canvas-comp cs-comp-${comp.elementType}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}${flagged ? ' is-flagged' : ''}`}
           opacity={ghost ? 0.85 : 1}>
            <g transform={`translate(${cx}, ${cy}) rotate(${comp.rot})`}>
                {sym.shapes.map((s, i) => renderShape(s, i))}
                {/* Flagged outline — drawn beneath the selection rect so a
                    selected-and-flagged part shows both cues. */}
                {flagged && !selected && (
                    <rect
                        x={-sym.width / 2 - 5} y={-sym.height / 2 - 5}
                        width={sym.width + 10} height={sym.height + 10}
                        fill="none"
                        stroke="var(--cs-danger, #ef4444)"
                        strokeWidth={1.2}
                        strokeDasharray="3 2"
                        opacity={0.9}
                    />
                )}
                {selected && (
                    <rect
                        x={-sym.width / 2 - 4} y={-sym.height / 2 - 4}
                        width={sym.width + 8} height={sym.height + 8}
                        fill="none" stroke="var(--cs-accent)"
                        strokeWidth={1.2} strokeDasharray="3 3"
                    />
                )}
            </g>
            {/* Ref + value text. Anchor position rotates with the part so the
                labels stay next to the same face of the symbol, but the text
                itself is drawn upright in screen space (no flipped text). */}
            <text
                x={cx + labelPos.dx}
                y={cy + labelPos.dy}
                textAnchor={labelPos.anchor}
                fontSize={11} fontWeight={600}
                fill="var(--sch-label)"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                pointerEvents="none"
            >
                {comp.ref}
            </text>
            {valueText ? (
                <text
                    x={cx + labelPos.dx}
                    y={cy + labelPos.dy + 12}
                    textAnchor={labelPos.anchor}
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

/**
 * Decide where the ref / value text block should sit, given the symbol's
 * natural orientation and the component's current rotation.
 *
 * We compute the anchor in the symbol's local frame (unrotated) and then
 * rotate that offset into world space, so the labels follow the part as it
 * spins. The text itself is NOT rotated — it always reads left-to-right so
 * values like "10k" stay legible at every orientation.
 *
 * `textAnchor` is picked from the sign of the rotated offset so the text
 * lines up flush against the correct face of the symbol (start / middle /
 * end ≈ left / centered / right of the anchor point).
 */
/**
 * Compute the point list to render for a wire given the current
 * drag state. Returns the original `w.points` when nothing relevant
 * is happening, or a new array with vertices shifted / spliced for
 * the preview. The result is never committed to the doc — pointer-up
 * calls the proper `translate*Rubber` helpers instead.
 */
function previewWirePoints(w, dragState, dragDelta) {
    if (!dragDelta || !dragState) return w.points;
    const { dx, dy } = dragDelta;

    // --- Wire drag: this wire is the one being dragged.
    if (dragState.kind === 'drag-wire' && dragState.id === w.id) {
        const { anchors } = dragState;
        const n = w.points.length;
        const out = w.points.map(([x, y], i) => {
            if (i === 0 && anchors?.first) return [x, y];
            if (i === n - 1 && anchors?.last) return [x, y];
            return [x + dx, y + dy];
        });
        // Insert a preview bend next to each anchored endpoint so
        // the polyline looks manhattan in real time (matches what
        // translateWireRubber will commit on pointerUp).
        if (anchors?.first && out.length >= 2) {
            const [ax, ay] = out[0];
            const [bx, by] = out[1];
            if (ax !== bx && ay !== by) out.splice(1, 0, [bx, ay]);
        }
        if (anchors?.last && out.length >= 2) {
            const m = out.length;
            const [px, py] = out[m - 2];
            const [qx, qy] = out[m - 1];
            if (px !== qx && py !== qy) out.splice(m - 1, 0, [px, qy]);
        }
        return out;
    }

    // --- Component drag: shift any vertex of this wire that's
    //     anchored to a pin of the moving component, and splice in
    //     a new coord for mid-segment pass-throughs.
    if (dragState.kind === 'drag-comp') {
        const follow = dragState.wireFollow;
        if (!follow) return w.points;
        const hit = follow.wireHits.find((h) => h.wireId === w.id);
        if (!hit) return w.points;
        const out = w.points.map(([x, y]) => [x, y]);
        // Remap real vertices at old pin coords.
        for (const idx of hit.vertexIndices) {
            if (idx >= 0) {
                out[idx] = [out[idx][0] + dx, out[idx][1] + dy];
            }
        }
        // Splice in a preview vertex for mid-segment follows. We
        // walk from the end so splice indices stay valid.
        const spliceSegments = hit.vertexIndices
            .filter((i) => i < 0)
            .map((i) => -i)
            .sort((a, b) => b - a);
        for (const s of spliceSegments) {
            // Find which pin coord lies on this segment (original).
            const [x1, y1] = w.points[s - 1];
            const [x2, y2] = w.points[s];
            const horiz = y1 === y2;
            const vert  = x1 === x2;
            for (const [px, py] of follow.pinCoords) {
                const onSeg = (horiz && py === y1 && px > Math.min(x1, x2) && px < Math.max(x1, x2))
                           || (vert  && px === x1 && py > Math.min(y1, y2) && py < Math.max(y1, y2));
                if (!onSeg) continue;
                out.splice(s, 0, [px + dx, py + dy]);
                break;
            }
        }
        return out;
    }

    return w.points;
}

/**
 * Pre-compute, at drag-start, which wire vertices and labels should
 * "follow" a component as it's being dragged. We store the indices
 * captured at the moment the pointer went down so the preview render
 * doesn't have to re-walk the doc on every pointermove.
 *
 * Shape:
 *   {
 *     pinCoords: Array<[x, y]>,             // component's pin coords
 *     wireHits:  Array<{ wireId, vertexIndices: number[] }>,
 *     labelIds:  Set<labelId>,
 *   }
 */
function computeComponentFollow(doc, compId) {
    const comp = doc.components.find((c) => c.id === compId);
    if (!comp) return null;
    const pins = componentPins(comp);
    const pinCoords = pins.map((p) => [p.x, p.y]);
    const pinKeys = new Set(pinCoords.map(([x, y]) => `${x}|${y}`));

    const wireHits = [];
    for (const w of doc.wires) {
        const idxs = [];
        for (let i = 0; i < w.points.length; i++) {
            if (pinKeys.has(`${w.points[i][0]}|${w.points[i][1]}`)) idxs.push(i);
        }
        // Mid-segment pass-through: record a "virtual" follow so the
        // preview splices the new coord in. We tag these with a
        // negative segment index to distinguish them from real
        // vertices during render.
        for (let s = 1; s < w.points.length; s++) {
            const [x1, y1] = w.points[s - 1];
            const [x2, y2] = w.points[s];
            const horiz = y1 === y2;
            const vert  = x1 === x2;
            if (!horiz && !vert) continue;
            for (const [px, py] of pinCoords) {
                const onSeg = (horiz && py === y1 && px > Math.min(x1, x2) && px < Math.max(x1, x2))
                           || (vert  && px === x1 && py > Math.min(y1, y2) && py < Math.max(y1, y2));
                if (!onSeg) continue;
                idxs.push(-s); // negative marks a splice-before-index
            }
        }
        if (idxs.length > 0) wireHits.push({ wireId: w.id, vertexIndices: idxs });
    }

    const labelIds = new Set();
    for (const lab of doc.labels) {
        if (pinKeys.has(`${lab.x}|${lab.y}`)) labelIds.add(lab.id);
    }
    return { pinCoords, pinKeys, wireHits, labelIds };
}

/**
 * At drag-start of a wire, figure out which endpoints are anchored
 * to component pins. Those stay locked during the drag; other
 * endpoints translate with the rest of the wire.
 */
function computeWireAnchors(doc, wireId) {
    const w = doc.wires.find((x) => x.id === wireId);
    if (!w || w.points.length < 2) return { first: false, last: false };
    const pinKeys = new Set();
    for (const c of doc.components) {
        for (const p of componentPins(c)) pinKeys.add(`${p.x}|${p.y}`);
    }
    const [fx, fy] = w.points[0];
    const [lx, ly] = w.points[w.points.length - 1];
    return {
        first: pinKeys.has(`${fx}|${fy}`),
        last:  pinKeys.has(`${lx}|${ly}`),
    };
}

function pickRefLabelPosition(sym, rot = 0) {
    const w = sym.width, h = sym.height;
    // Local-frame offset from the symbol's center. For tall symbols we place
    // labels to the right of the body; for wide symbols, above it. A small
    // margin (pad) keeps text off the stroke.
    const pad = 8;
    let lx;
    let ly;
    if (h >= w) {
        lx = w / 2 + pad;
        ly = -4;
    } else {
        lx = 0;
        ly = -h / 2 - pad;
    }
    // Rotate the anchor offset into world space.
    const r = ((rot % 360) + 360) % 360;
    const rad = (r * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = lx * cos - ly * sin;
    const dy = lx * sin + ly * cos;
    // Pick the SVG text-anchor based on where we landed relative to the
    // symbol center. A tiny epsilon avoids flip-flop at exact verticals.
    const eps = 0.5;
    let anchor = 'middle';
    if (dx > eps) anchor = 'start';
    else if (dx < -eps) anchor = 'end';
    return { dx, dy, anchor };
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
