import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { replaceEntity, findEntity, globalToUserUm, userToGlobalUm } from '../mems/memsMaskDoc.js';
import { displayToUm, umToDisplay } from '../mems/memsUnits.js';
import { setRectRotationDeg, setEllipseRotationDeg } from '../mems/memsGeometry.js';
import { normalizeInstanceArray, cellContentBBoxUm } from '../mems/memsHierarchy.js';
import {
    closingSegmentCrosses,
    minSegmentLengthUm,
    openPolylineSelfIntersects,
} from '../mems/memsPolygonValidate.js';
import { parseCommittedNumberInput } from '../mems/memsInputParse.js';

/**
 * Property editor for a single selected entity. Values shown in display units (µm or mm);
 * commits canonical µm to the document.
 */
function MemsPolygonInspector({
    doc,
    e,
    layer,
    locked,
    displayUnit,
    coordFrame,
    pushReplace,
    polyJsonErr,
    setPolyJsonErr,
}) {
    const [polySegIdx, setPolySegIdx] = useState(0);

    useEffect(() => {
        setPolySegIdx(0);
    }, [e.id]);

    const pts = e.points || [];
    const n = pts.length;
    const nSeg = n >= 2 ? n : 0;

    useEffect(() => {
        setPolySegIdx((prev) => Math.min(prev, Math.max(0, nSeg - 1)));
    }, [nSeg]);

    const validateClosedRing = useCallback((nextPts) => {
        const minL = 0.02;
        if (minSegmentLengthUm(nextPts, true) < minL) {
            window.alert(`Each segment must be at least ${minL.toFixed(3)} µm.`);
            return false;
        }
        if (closingSegmentCrosses(nextPts)) {
            window.alert('The closing edge crosses another edge.');
            return false;
        }
        if (openPolylineSelfIntersects(nextPts)) {
            window.alert('Polygon outline self-intersects.');
            return false;
        }
        return true;
    }, []);

    const jsonStr = JSON.stringify(
        pts.map((p) => {
            let gx = p.x;
            let gy = p.y;
            if (coordFrame === 'user') {
                const rel = globalToUserUm(doc, gx, gy);
                gx = rel.x;
                gy = rel.y;
            }
            return {
                x: umToDisplay(gx, displayUnit),
                y: umToDisplay(gy, displayUnit),
            };
        }),
        null,
        2
    );

    const moveRingVertex = useCallback(
        (vertexIdx, nx, ny) => {
            const next = pts.map((p) => ({ ...p }));
            next[vertexIdx] = { x: nx, y: ny };
            if (!validateClosedRing(next)) return;
            pushReplace({ ...e, points: next });
        },
        [e, pts, pushReplace, validateClosedRing]
    );

    const ax = nSeg ? pts[polySegIdx].x : 0;
    const ay = nSeg ? pts[polySegIdx].y : 0;
    const iB = nSeg ? (polySegIdx + 1) % n : 0;
    const bx = nSeg ? pts[iB].x : 0;
    const by = nSeg ? pts[iB].y : 0;
    const dx = bx - ax;
    const dy = by - ay;
    const lenUm = Math.hypot(dx, dy);
    const angDeg = lenUm > 1e-15 ? (Math.atan2(dy, dx) * 180) / Math.PI : 0;

    return (
        <div className="mems-inspector">
            <h4 className="mems-inspector-title">Polygon</h4>
            <p className="mems-inspector-meta">
                Layer <strong>{layer.name}</strong> · {n} vertices
            </p>
            {nSeg > 0 && (
                <>
                    <div className="mems-line-chain-panel" style={{ marginBottom: 12 }}>
                        <div className="mems-line-chain-panel__title">Segments</div>
                        <p className="mems-inspector-hint">
                            Select an edge. Edits move the end vertex of that edge (wraps: last edge moves the first
                            vertex).
                        </p>
                        <ul className="mems-line-chain-panel__list">
                            {Array.from({ length: nSeg }, (_, idx) => {
                                const p0 = pts[idx];
                                const p1 = pts[(idx + 1) % n];
                                const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
                                const th =
                                    L > 1e-15
                                        ? (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI
                                        : 0;
                                const sel = idx === polySegIdx;
                                return (
                                    <li key={`ring-seg-${idx}`}>
                                        <button
                                            type="button"
                                            className={`mems-line-chain-panel__seg${sel ? ' mems-line-chain-panel__seg--sel' : ''}`}
                                            onClick={() => setPolySegIdx(idx)}
                                            disabled={locked}
                                        >
                                            Segment {idx + 1}: L {L.toFixed(3)} µm · θ {th.toFixed(2)}°
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                    <label className="mems-inspector-field">
                        Length (µm)
                        <input
                            type="number"
                            step={0.001}
                            value={Number(lenUm.toFixed(6))}
                            onChange={(ev) => {
                                const L = parseCommittedNumberInput(ev.target.value);
                                if (L === null || L <= 0) return;
                                const L0 = Math.max(1e-9, lenUm);
                                const ux = dx / L0;
                                const uy = dy / L0;
                                moveRingVertex(iB, ax + ux * L, ay + uy * L);
                            }}
                            disabled={locked}
                        />
                    </label>
                    <label className="mems-inspector-field">
                        Angle from +X (°)
                        <input
                            type="number"
                            step={0.01}
                            value={Number(angDeg.toFixed(6))}
                            onChange={(ev) => {
                                const deg = parseCommittedNumberInput(ev.target.value);
                                if (deg === null) return;
                                const L = Math.max(1e-9, lenUm);
                                const rad = (deg * Math.PI) / 180;
                                moveRingVertex(iB, ax + L * Math.cos(rad), ay + L * Math.sin(rad));
                            }}
                            disabled={locked}
                        />
                    </label>
                    <label className="mems-inspector-field">
                        End X (µm · global)
                        <input
                            type="number"
                            step={displayUnit === 'mm' ? 0.000001 : 0.001}
                            value={Number(umToDisplay(bx, displayUnit).toFixed(6))}
                            onChange={(ev) => {
                                const v = parseCommittedNumberInput(ev.target.value);
                                if (v === null) return;
                                const gx = displayToUm(v, displayUnit);
                                moveRingVertex(iB, gx, by);
                            }}
                            disabled={locked}
                        />
                    </label>
                    <label className="mems-inspector-field">
                        End Y (µm · global)
                        <input
                            type="number"
                            step={displayUnit === 'mm' ? 0.000001 : 0.001}
                            value={Number(umToDisplay(by, displayUnit).toFixed(6))}
                            onChange={(ev) => {
                                const v = parseCommittedNumberInput(ev.target.value);
                                if (v === null) return;
                                const gy = displayToUm(v, displayUnit);
                                moveRingVertex(iB, bx, gy);
                            }}
                            disabled={locked}
                        />
                    </label>
                </>
            )}
            <label className="mems-inspector-field mems-inspector-field--textarea">
                Vertices [{displayUnit === 'mm' ? 'mm' : 'µm'} · {coordFrame === 'user' ? 'user' : 'global'}]
                <textarea
                    rows={8}
                    spellCheck={false}
                    defaultValue={jsonStr}
                    key={`${e.id}-${coordFrame}`}
                    disabled={locked}
                    onBlur={(ev) => {
                        if (locked) return;
                        try {
                            const parsed = JSON.parse(ev.target.value);
                            if (!Array.isArray(parsed)) throw new Error('expected array');
                            const newPts = parsed.map((row) => {
                                let gx = displayToUm(Number(row.x), displayUnit);
                                let gy = displayToUm(Number(row.y), displayUnit);
                                if (coordFrame === 'user') {
                                    const g = userToGlobalUm(doc, gx, gy);
                                    gx = g.x;
                                    gy = g.y;
                                }
                                return { x: gx, y: gy };
                            });
                            if (newPts.length < 3) {
                                setPolyJsonErr('Need at least 3 points');
                                return;
                            }
                            if (!validateClosedRing(newPts)) return;
                            setPolyJsonErr(null);
                            pushReplace({ ...e, points: newPts });
                        } catch {
                            setPolyJsonErr('Invalid JSON');
                        }
                    }}
                />
            </label>
            {polyJsonErr && <p className="mems-inspector-error">{polyJsonErr}</p>}
            <p className="mems-inspector-hint">
                Array of <code>{`{ "x", "y" }`}</code> in {displayUnit === 'mm' ? 'millimetres' : 'micrometres'} (
                {coordFrame === 'user' ? 'user-relative; saved as global' : 'global layout'}).
            </p>
        </div>
    );
}

export default function MemsMaskInspector({
    doc,
    selectedId,
    displayUnit,
    commitDoc,
    onOpenMasterCell,
    coordFrame = 'global',
}) {
    const hit = useMemo(
        () => (selectedId ? findEntity(doc, selectedId) : null),
        [doc, selectedId]
    );

    const locked = hit?.layer?.locked;

    const pushReplace = useCallback(
        (nextEntity) => {
            if (!hit || locked) return;
            commitDoc((d) => replaceEntity(d, hit.layer.id, hit.entity.id, nextEntity), true);
        },
        [hit, locked, commitDoc]
    );

    const [polyJsonErr, setPolyJsonErr] = useState(null);
    /** Gap (µm) around master bbox when using “Set pitch from master outline”. */
    const [waferStreetUm, setWaferStreetUm] = useState(10);

    if (!hit) {
        return (
            <div className="mems-inspector mems-inspector--empty">
                <p>Select one shape to edit coordinates and dimensions.</p>
                <p className="mems-inspector-hint">
                    Stored geometry uses the fixed global frame (fab layout). Use User in Origins to edit
                    relative to the movable design origin.
                </p>
            </div>
        );
    }

    const { entity: e, layer } = hit;

    const numField = (label, umVal, onUm, step = 1) => (
        <label key={label} className="mems-inspector-field">
            {label} ({displayUnit === 'mm' ? 'mm' : 'µm'})
            <input
                type="number"
                step={displayUnit === 'mm' ? step / 1000 : step}
                value={Number(umToDisplay(umVal, displayUnit).toFixed(6))}
                onChange={(ev) => {
                    const v = parseCommittedNumberInput(ev.target.value);
                    if (v === null) return;
                    onUm(displayToUm(v, displayUnit));
                }}
                disabled={locked}
            />
        </label>
    );

    const coordNumField = (label, gx, gy, axis, onPair, step = 1) => {
        const u = coordFrame === 'user' ? globalToUserUm(doc, gx, gy) : { x: gx, y: gy };
        const umVal = axis === 'x' ? u.x : u.y;
        const frameTag = coordFrame === 'user' ? 'user' : 'global';
        return (
            <label key={`${label}-${axis}-${frameTag}`} className="mems-inspector-field">
                {label} ({displayUnit === 'mm' ? 'mm' : 'µm'} · {frameTag})
                <input
                    type="number"
                    step={displayUnit === 'mm' ? step / 1000 : step}
                    value={Number(umToDisplay(umVal, displayUnit).toFixed(6))}
                    onChange={(ev) => {
                        const v = parseCommittedNumberInput(ev.target.value);
                        if (v === null) return;
                        const editedUm = displayToUm(v, displayUnit);
                        let ngx = gx;
                        let ngy = gy;
                        if (coordFrame === 'user') {
                            const cur = globalToUserUm(doc, gx, gy);
                            const nu =
                                axis === 'x'
                                    ? { x: editedUm, y: cur.y }
                                    : { x: cur.x, y: editedUm };
                            const g = userToGlobalUm(doc, nu.x, nu.y);
                            ngx = g.x;
                            ngy = g.y;
                        } else if (axis === 'x') {
                            ngx = editedUm;
                        } else {
                            ngy = editedUm;
                        }
                        onPair(ngx, ngy);
                    }}
                    disabled={locked}
                />
            </label>
        );
    };

    if (e.type === 'rect') {
        return (
            <div className="mems-inspector">
                <h4 className="mems-inspector-title">Rectangle</h4>
                <p className="mems-inspector-meta">
                    {hit.cell ? (
                        <>
                            Cell <strong>{hit.cell.name}</strong>
                            {' · '}
                        </>
                    ) : null}
                    Layer <strong>{layer.name}</strong>
                </p>
                {coordNumField('Origin X', e.x, e.y, 'x', (ngx, ngy) => pushReplace({ ...e, x: ngx, y: ngy }))}
                {coordNumField('Origin Y', e.x, e.y, 'y', (ngx, ngy) => pushReplace({ ...e, x: ngx, y: ngy }))}
                {numField('Width', e.width, (um) => pushReplace({ ...e, width: Math.max(0.01, um) }))}
                {numField('Height', e.height, (um) => pushReplace({ ...e, height: Math.max(0.01, um) }))}
                <label className="mems-inspector-field">
                    Rotation (°)
                    <input
                        type="number"
                        step={0.1}
                        value={e.rotationDeg ?? 0}
                        onChange={(ev) => {
                            const v = parseCommittedNumberInput(ev.target.value);
                            if (v === null) return;
                            pushReplace(setRectRotationDeg(e, v));
                        }}
                        disabled={locked}
                    />
                </label>
            </div>
        );
    }

    if (e.type === 'ellipse') {
        return (
            <div className="mems-inspector">
                <h4 className="mems-inspector-title">Ellipse / circle</h4>
                <p className="mems-inspector-meta">
                    {hit.cell ? (
                        <>
                            Cell <strong>{hit.cell.name}</strong>
                            {' · '}
                        </>
                    ) : null}
                    Layer <strong>{layer.name}</strong>
                </p>
                {coordNumField('Centre X', e.cx, e.cy, 'x', (ngx, ngy) =>
                    pushReplace({ ...e, cx: ngx, cy: ngy })
                )}
                {coordNumField('Centre Y', e.cx, e.cy, 'y', (ngx, ngy) =>
                    pushReplace({ ...e, cx: ngx, cy: ngy })
                )}
                {numField('Radius X', e.rx, (um) => pushReplace({ ...e, rx: Math.max(0.01, um) }))}
                {numField('Radius Y', e.ry, (um) => pushReplace({ ...e, ry: Math.max(0.01, um) }))}
                <label className="mems-inspector-field">
                    Rotation (°)
                    <input
                        type="number"
                        step={0.1}
                        value={e.rotationDeg ?? 0}
                        onChange={(ev) => {
                            const v = parseCommittedNumberInput(ev.target.value);
                            if (v === null) return;
                            pushReplace(setEllipseRotationDeg(e, v));
                        }}
                        disabled={locked}
                    />
                </label>
            </div>
        );
    }

    if (e.type === 'line') {
        const dx = e.x2 - e.x1;
        const dy = e.y2 - e.y1;
        const len = Math.hypot(dx, dy);
        const angleDeg = len > 1e-15 ? (Math.atan2(dy, dx) * 180) / Math.PI : 0;
        return (
            <div className="mems-inspector">
                <h4 className="mems-inspector-title">Line segment</h4>
                <p className="mems-inspector-meta">
                    {hit.cell ? (
                        <>
                            Cell <strong>{hit.cell.name}</strong>
                            {' · '}
                        </>
                    ) : null}
                    Layer <strong>{layer.name}</strong>
                    {' · '}
                    Δ{' '}
                    <strong>
                        {Number(umToDisplay(dx, displayUnit).toFixed(6))}
                    </strong>
                    ,{' '}
                    <strong>
                        {Number(umToDisplay(dy, displayUnit).toFixed(6))}
                    </strong>{' '}
                    {displayUnit === 'mm' ? 'mm' : 'µm'} · L{' '}
                    <strong>{Number(umToDisplay(len, displayUnit).toFixed(6))}</strong>
                    {displayUnit === 'mm' ? ' mm' : ' µm'} · θ{' '}
                    <strong>{angleDeg.toFixed(4)}°</strong>
                </p>
                {coordNumField('X₁', e.x1, e.y1, 'x', (ngx, ngy) =>
                    pushReplace({ ...e, x1: ngx, y1: ngy })
                )}
                {coordNumField('Y₁', e.x1, e.y1, 'y', (ngx, ngy) =>
                    pushReplace({ ...e, x1: ngx, y1: ngy })
                )}
                {coordNumField('X₂', e.x2, e.y2, 'x', (ngx, ngy) =>
                    pushReplace({ ...e, x2: ngx, y2: ngy })
                )}
                {coordNumField('Y₂', e.x2, e.y2, 'y', (ngx, ngy) =>
                    pushReplace({ ...e, x2: ngx, y2: ngy })
                )}
                {numField('Length', len, (umLen) => {
                    const L = Math.max(1e-9, umLen);
                    const ang = Math.atan2(dy, dx);
                    pushReplace({
                        ...e,
                        x2: e.x1 + L * Math.cos(ang),
                        y2: e.y1 + L * Math.sin(ang),
                    });
                })}
                <label className="mems-inspector-field">
                    Angle from +X (°)
                    <input
                        type="number"
                        step={0.01}
                        value={Number(angleDeg.toFixed(6))}
                        onChange={(ev) => {
                            const deg = parseCommittedNumberInput(ev.target.value);
                            if (deg === null) return;
                            const L = Math.max(1e-9, len);
                            const rad = (deg * Math.PI) / 180;
                            pushReplace({
                                ...e,
                                x2: e.x1 + L * Math.cos(rad),
                                y2: e.y1 + L * Math.sin(rad),
                            });
                        }}
                        disabled={locked}
                    />
                </label>
                <p className="mems-inspector-hint">
                    Endpoints use the fixed global frame (fab). Editing length or angle moves point 2 while keeping point 1.
                </p>
            </div>
        );
    }

    if (e.type === 'polygon') {
        return (
            <MemsPolygonInspector
                doc={doc}
                e={e}
                layer={layer}
                locked={locked}
                displayUnit={displayUnit}
                coordFrame={coordFrame}
                pushReplace={pushReplace}
                polyJsonErr={polyJsonErr}
                setPolyJsonErr={setPolyJsonErr}
            />
        );
    }

    if (e.type === 'path') {
        const jsonStr = JSON.stringify(
            (e.points || []).map((p) => {
                let gx = p.x;
                let gy = p.y;
                if (coordFrame === 'user') {
                    const rel = globalToUserUm(doc, gx, gy);
                    gx = rel.x;
                    gy = rel.y;
                }
                return {
                    x: umToDisplay(gx, displayUnit),
                    y: umToDisplay(gy, displayUnit),
                };
            }),
            null,
            2
        );

        return (
            <div className="mems-inspector">
                <h4 className="mems-inspector-title">Path (open)</h4>
                <p className="mems-inspector-meta">
                    Layer <strong>{layer.name}</strong> · {(e.points || []).length} points
                </p>
                <label className="mems-inspector-field">
                    Stroke width (µm, fab path width)
                    <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={e.widthUm ?? ''}
                        placeholder="0 = hairline"
                        onChange={(ev) => {
                            const v = ev.target.value === '' ? undefined : Number(ev.target.value);
                            if (v !== undefined && !Number.isFinite(v)) return;
                            pushReplace({
                                ...e,
                                ...(v != null && v > 0 ? { widthUm: v } : { widthUm: undefined }),
                            });
                        }}
                        disabled={locked}
                    />
                </label>
                <label className="mems-inspector-field mems-inspector-field--textarea">
                    Points [{displayUnit === 'mm' ? 'mm' : 'µm'} · {coordFrame === 'user' ? 'user' : 'global'}]
                    <textarea
                        rows={10}
                        spellCheck={false}
                        defaultValue={jsonStr}
                        key={`${e.id}-${coordFrame}`}
                        disabled={locked}
                        onBlur={(ev) => {
                            if (locked) return;
                            try {
                                const parsed = JSON.parse(ev.target.value);
                                if (!Array.isArray(parsed)) throw new Error('expected array');
                                const pts = parsed.map((row) => {
                                    let gx = displayToUm(Number(row.x), displayUnit);
                                    let gy = displayToUm(Number(row.y), displayUnit);
                                    if (coordFrame === 'user') {
                                        const g = userToGlobalUm(doc, gx, gy);
                                        gx = g.x;
                                        gy = g.y;
                                    }
                                    return { x: gx, y: gy };
                                });
                                if (pts.length < 2) {
                                    setPolyJsonErr('Need at least 2 points');
                                    return;
                                }
                                setPolyJsonErr(null);
                                pushReplace({ ...e, points: pts });
                            } catch {
                                setPolyJsonErr('Invalid JSON');
                            }
                        }}
                    />
                </label>
                {polyJsonErr && <p className="mems-inspector-error">{polyJsonErr}</p>}
                <p className="mems-inspector-hint">
                    Array of <code>{`{ "x", "y" }`}</code> in {displayUnit === 'mm' ? 'millimetres' : 'micrometres'} (
                    {coordFrame === 'user' ? 'user-relative; saved as global' : 'global layout'}).
                </p>
            </div>
        );
    }

    if (e.type === 'text') {
        return (
            <div className="mems-inspector">
                <h4 className="mems-inspector-title">Text label</h4>
                <p className="mems-inspector-meta">
                    Layer <strong>{layer.name}</strong>
                </p>
                {coordNumField('Anchor X', e.x, e.y, 'x', (ngx, ngy) => pushReplace({ ...e, x: ngx, y: ngy }))}
                {coordNumField('Anchor Y', e.x, e.y, 'y', (ngx, ngy) => pushReplace({ ...e, x: ngx, y: ngy }))}
                <label className="mems-inspector-field">
                    Label
                    <input
                        type="text"
                        value={e.text ?? ''}
                        onChange={(ev) => pushReplace({ ...e, text: ev.target.value })}
                        disabled={locked}
                    />
                </label>
                <label className="mems-inspector-field">
                    Height (µm)
                    <input
                        type="number"
                        min={0.1}
                        step={0.5}
                        value={e.heightUm ?? ''}
                        placeholder="default"
                        onChange={(ev) => {
                            const v = ev.target.value === '' ? undefined : Number(ev.target.value);
                            if (v !== undefined && !Number.isFinite(v)) return;
                            pushReplace({
                                ...e,
                                ...(v != null && v > 0 ? { heightUm: v } : { heightUm: undefined }),
                            });
                        }}
                        disabled={locked}
                    />
                </label>
                <label className="mems-inspector-field">
                    Rotation (°)
                    <input
                        type="number"
                        step={0.1}
                        value={e.rotationDeg ?? 0}
                        onChange={(ev) => {
                            const v = parseCommittedNumberInput(ev.target.value);
                            if (v === null) return;
                            pushReplace({ ...e, rotationDeg: v });
                        }}
                        disabled={locked}
                    />
                </label>
            </div>
        );
    }

    if (e.type === 'instance') {
        const arr = normalizeInstanceArray(e.array);
        const masterList = (doc.cells || []).filter((c) => c.id !== doc.activeCellId);
        const masterName =
            (doc.cells || []).find((c) => c.id === e.masterCellId)?.name ?? e.masterCellId;

        return (
            <div className="mems-inspector">
                <h4 className="mems-inspector-title">Cell instance</h4>
                <p className="mems-inspector-meta">
                    {hit.cell ? (
                        <>
                            Placed in <strong>{hit.cell.name}</strong>
                            {' · '}
                        </>
                    ) : null}
                    Layer <strong>{layer.name}</strong>
                </p>
                <label className="mems-inspector-field">
                    Master cell
                    <select
                        className="mems-ui-select"
                        value={e.masterCellId}
                        onChange={(ev) => {
                            const nextId = ev.target.value;
                            if (!nextId || nextId === doc.activeCellId) return;
                            pushReplace({ ...e, masterCellId: nextId });
                        }}
                        disabled={locked || !masterList.length}
                    >
                        <option value={e.masterCellId}>{masterName}</option>
                        {masterList
                            .filter((c) => c.id !== e.masterCellId)
                            .map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.name}
                                </option>
                            ))}
                    </select>
                </label>
                {typeof onOpenMasterCell === 'function' && (
                    <button
                        type="button"
                        className="mems-inspector-open-master"
                        disabled={!e.masterCellId}
                        onClick={() => onOpenMasterCell(e.masterCellId)}
                    >
                        Open master for editing
                    </button>
                )}
                {coordNumField('Anchor X', e.x, e.y, 'x', (ngx, ngy) =>
                    pushReplace({ ...e, x: ngx, y: ngy })
                )}
                {coordNumField('Anchor Y', e.x, e.y, 'y', (ngx, ngy) =>
                    pushReplace({ ...e, x: ngx, y: ngy })
                )}
                <label className="mems-inspector-field">
                    Rotation (°)
                    <input
                        type="number"
                        step={0.1}
                        value={e.rotationDeg ?? 0}
                        onChange={(ev) => {
                            const v = parseCommittedNumberInput(ev.target.value);
                            if (v === null) return;
                            pushReplace({ ...e, rotationDeg: v });
                        }}
                        disabled={locked}
                    />
                </label>
                <label className="mems-inspector-field">
                    Scale X (relative)
                    <input
                        type="number"
                        step={0.01}
                        value={e.scaleX ?? 1}
                        onChange={(ev) => {
                            const v = parseCommittedNumberInput(ev.target.value);
                            if (v === null || v === 0) return;
                            pushReplace({ ...e, scaleX: v });
                        }}
                        disabled={locked}
                    />
                </label>
                <label className="mems-inspector-field">
                    Scale Y (relative)
                    <input
                        type="number"
                        step={0.01}
                        value={e.scaleY ?? 1}
                        onChange={(ev) => {
                            const v = parseCommittedNumberInput(ev.target.value);
                            if (v === null || v === 0) return;
                            pushReplace({ ...e, scaleY: v });
                        }}
                        disabled={locked}
                    />
                </label>
                <label className="mems-inspector-field mems-inspector-field--check">
                    <input
                        type="checkbox"
                        checked={!!e.mirrorX}
                        onChange={(ev) => pushReplace({ ...e, mirrorX: ev.target.checked })}
                        disabled={locked}
                    />{' '}
                    Mirror X
                </label>
                <label className="mems-inspector-field mems-inspector-field--check">
                    <input
                        type="checkbox"
                        checked={!!e.mirrorY}
                        onChange={(ev) => pushReplace({ ...e, mirrorY: ev.target.checked })}
                        disabled={locked}
                    />{' '}
                    Mirror Y
                </label>
                <p className="mems-inspector-sublabel">Wafer / die array</p>
                <p className="mems-inspector-hint" style={{ marginTop: 2, marginBottom: 10 }}>
                    Tile the device cell on a grid in this layout (multiple dies). Anchor X/Y is the first site;
                    pitch steps along +X for columns and +Y for rows.
                </p>
                <label className="mems-inspector-field">
                    Street (µm, pitch helper)
                    <input
                        type="number"
                        min={0}
                        step={1}
                        value={waferStreetUm}
                        onChange={(ev) => {
                            const v = parseCommittedNumberInput(ev.target.value);
                            if (v === null) return;
                            setWaferStreetUm(Math.max(0, v));
                        }}
                        disabled={locked}
                        title="Added around the master cell bounding box when applying pitch from outline"
                    />
                </label>
                <button
                    type="button"
                    className="mems-inspector-open-master"
                    style={{ marginBottom: 12 }}
                    disabled={locked || !e.masterCellId}
                    onClick={() => {
                        const bb = cellContentBBoxUm(doc, e.masterCellId);
                        if (!bb) return;
                        const s = Math.max(0, waferStreetUm);
                        const pw = Math.max(0.01, bb.maxX - bb.minX + s);
                        const ph = Math.max(0.01, bb.maxY - bb.minY + s);
                        pushReplace({
                            ...e,
                            array: normalizeInstanceArray({
                                ...arr,
                                pitchXUm: pw,
                                pitchYUm: ph,
                            }),
                        });
                    }}
                    title="Set pitch X and Y from the master cell content bbox plus street"
                >
                    Set pitch from master outline
                </button>
                <label className="mems-inspector-field">
                    Rows
                    <input
                        type="number"
                        min={1}
                        step={1}
                        value={arr.rows}
                        onChange={(ev) => {
                            const n = parseCommittedNumberInput(ev.target.value);
                            if (n === null) return;
                            const rows = Math.max(1, Math.floor(n));
                            pushReplace({
                                ...e,
                                array: normalizeInstanceArray({ ...arr, rows }),
                            });
                        }}
                        disabled={locked}
                    />
                </label>
                <label className="mems-inspector-field">
                    Columns
                    <input
                        type="number"
                        min={1}
                        step={1}
                        value={arr.cols}
                        onChange={(ev) => {
                            const n = parseCommittedNumberInput(ev.target.value);
                            if (n === null) return;
                            const cols = Math.max(1, Math.floor(n));
                            pushReplace({
                                ...e,
                                array: normalizeInstanceArray({ ...arr, cols }),
                            });
                        }}
                        disabled={locked}
                    />
                </label>
                {numField('Pitch X', arr.pitchXUm, (um) =>
                    pushReplace({
                        ...e,
                        array: normalizeInstanceArray({ ...arr, pitchXUm: um }),
                    })
                )}
                {numField('Pitch Y', arr.pitchYUm, (um) =>
                    pushReplace({
                        ...e,
                        array: normalizeInstanceArray({ ...arr, pitchYUm: um }),
                    })
                )}
                <p className="mems-inspector-hint">
                    One instance references the master — edits there update every replica. Copy, then paste to add
                    another column to the right (spacing = selection width + 10&nbsp;µm per paste). Preview outlines show
                    flattened geometry.
                </p>
            </div>
        );
    }

    return null;
}
