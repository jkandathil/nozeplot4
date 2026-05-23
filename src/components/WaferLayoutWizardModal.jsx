import React, { useCallback, useMemo, useState } from 'react';
import { X, Disc, LayoutGrid, Upload } from 'lucide-react';
import { buildWaferLayoutDocument, WAFER_PRESETS_MM } from '../mems/memsWaferLayout.js';
import './WaferLayoutWizardModal.css';

/**
 * Interactive wafer map wizard: diameter, edge exclusion, GDS device optional, dicing + grid.
 */
export default function WaferLayoutWizardModal({ open, onClose, onApply }) {
    const [step, setStep] = useState(0);
    const [waferMm, setWaferMm] = useState(150);
    const [edgeMm, setEdgeMm] = useState(3);
    const [streetUm, setStreetUm] = useState(80);
    const [hasGds, setHasGds] = useState(false);
    const [gdsFile, setGdsFile] = useState(null);
    const [gdsBuffer, setGdsBuffer] = useState(null);
    const [structureName, setStructureName] = useState('');
    const [manualW, setManualW] = useState(5000);
    const [manualH, setManualH] = useState(5000);
    const [includeAlignmentMarks, setIncludeAlignmentMarks] = useState(true);
    const [alignmentHalfUm, setAlignmentHalfUm] = useState(150);
    const [alignmentInsetUm, setAlignmentInsetUm] = useState(5000);
    const [busy, setBusy] = useState(false);

    const resetForm = useCallback(() => {
        setStep(0);
        setWaferMm(150);
        setEdgeMm(3);
        setStreetUm(80);
        setHasGds(false);
        setGdsFile(null);
        setGdsBuffer(null);
        setStructureName('');
        setManualW(5000);
        setManualH(5000);
        setIncludeAlignmentMarks(true);
        setAlignmentHalfUm(150);
        setAlignmentInsetUm(5000);
        setBusy(false);
    }, []);

    const handleClose = useCallback(() => {
        resetForm();
        onClose();
    }, [onClose, resetForm]);

    const onPickGds = useCallback((ev) => {
        const f = ev.target.files?.[0];
        setGdsFile(f || null);
        setGdsBuffer(null);
        setStructureName('');
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            const buf = result instanceof ArrayBuffer ? result : new Uint8Array(result).buffer;
            setGdsBuffer(buf);
        };
        reader.readAsArrayBuffer(f);
    }, []);

    const canGenerate = useMemo(() => {
        if (waferMm <= 0 || edgeMm < 0 || streetUm < 0) return false;
        if (hasGds && !gdsBuffer) return false;
        if (!hasGds && (manualW <= 0 || manualH <= 0)) return false;
        return true;
    }, [waferMm, edgeMm, streetUm, hasGds, gdsBuffer, manualW, manualH]);

    const runGenerate = useCallback(() => {
        if (!canGenerate || busy) return;
        setBusy(true);
        try {
            const { doc, warnings, stats } = buildWaferLayoutDocument({
                waferDiameterMm: waferMm,
                edgeExclusionMm: edgeMm,
                streetUm,
                gdsBytes: hasGds ? gdsBuffer : null,
                deviceStructureName: structureName.trim() || null,
                manualDieWidthUm: manualW,
                manualDieHeightUm: manualH,
                projectLabel: `Wafer ${waferMm} mm`,
                includeAlignmentMarks,
                alignmentMarkHalfUm: alignmentHalfUm,
                alignmentInsetUm: alignmentInsetUm,
            });
            onApply(doc, { warnings, stats });
            handleClose();
        } catch (e) {
            window.alert(String(e?.message || e));
        } finally {
            setBusy(false);
        }
    }, [
        canGenerate,
        busy,
        waferMm,
        edgeMm,
        streetUm,
        hasGds,
        gdsBuffer,
        structureName,
        manualW,
        manualH,
        includeAlignmentMarks,
        alignmentHalfUm,
        alignmentInsetUm,
        onApply,
        handleClose,
    ]);

    if (!open) return null;

    const steps = ['Wafer size', 'Device source', 'Streets & review'];

    return (
        <div className="wafer-wizard-backdrop" role="presentation" onClick={handleClose}>
            <div
                className="wafer-wizard"
                role="dialog"
                aria-labelledby="wafer-wizard-title"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="wafer-wizard__head">
                    <div className="wafer-wizard__title-row">
                        <Disc size={20} aria-hidden />
                        <h2 id="wafer-wizard-title">Wafer layout wizard</h2>
                    </div>
                    <button type="button" className="wafer-wizard__close" onClick={handleClose} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>

                <div className="wafer-wizard__steps" aria-hidden>
                    {steps.map((s, i) => (
                        <button
                            key={s}
                            type="button"
                            className={`wafer-wizard__step${i === step ? ' wafer-wizard__step--active' : ''}`}
                            onClick={() => setStep(i)}
                        >
                            {i + 1}. {s}
                        </button>
                    ))}
                </div>

                <div className="wafer-wizard__body">
                    {step === 0 && (
                        <>
                            <p className="wafer-wizard__lead">
                                Choose wafer diameter and edge exclusion (keep-out from the wafer edge). The outline is
                                drawn on the <strong>Wafer (guide)</strong> layer; usable die sites stay inside the edge
                                zone.
                            </p>
                            <div className="wafer-wizard__presets">
                                {WAFER_PRESETS_MM.map((p) => (
                                    <button
                                        key={p.mm}
                                        type="button"
                                        className={`wafer-wizard__chip${waferMm === p.mm ? ' wafer-wizard__chip--on' : ''}`}
                                        onClick={() => setWaferMm(p.mm)}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                            <label className="wafer-wizard__field">
                                Custom diameter (mm)
                                <input
                                    type="number"
                                    min={25}
                                    max={450}
                                    step={1}
                                    value={waferMm}
                                    onChange={(e) => setWaferMm(Number(e.target.value) || 150)}
                                />
                            </label>
                            <label className="wafer-wizard__field">
                                Edge exclusion (mm)
                                <input
                                    type="number"
                                    min={0}
                                    max={50}
                                    step={0.5}
                                    value={edgeMm}
                                    onChange={(e) => setEdgeMm(Number(e.target.value) || 0)}
                                />
                                <span className="wafer-wizard__hint-inline">
                                    Flat zone / chuck margin — dies must fit inside this inset circle.
                                </span>
                            </label>
                        </>
                    )}

                    {step === 1 && (
                        <>
                            <p className="wafer-wizard__lead">
                                Optional: load a <strong>GDSII</strong> file with your device structure. Each{' '}
                                <strong>layer / datatype</strong> in that structure becomes a separate{' '}
                                <strong>mask layer</strong> on the wafer layout (named “Mask · …”), keeping lithography
                                layers aligned. One <strong>instance grid</strong> references the whole device cell so
                                every mask stays registered. Without GDS, a single rectangular placeholder mask is used.
                            </p>
                            <label className="wafer-wizard__check">
                                <input
                                    type="checkbox"
                                    checked={hasGds}
                                    onChange={(e) => setHasGds(e.target.checked)}
                                />
                                I have a GDS file for one device instance
                            </label>
                            {hasGds && (
                                <>
                                    <label className="wafer-wizard__file">
                                        <Upload size={16} aria-hidden />
                                        <span>{gdsFile ? gdsFile.name : 'Choose .gds file'}</span>
                                        <input type="file" accept=".gds,.gdsii" onChange={onPickGds} />
                                    </label>
                                    {gdsBuffer && (
                                        <label className="wafer-wizard__field">
                                            Structure name (optional)
                                            <input
                                                type="text"
                                                placeholder="Match GDS structure name; leave blank for auto"
                                                value={structureName}
                                                onChange={(e) => setStructureName(e.target.value)}
                                            />
                                        </label>
                                    )}
                                </>
                            )}
                            {!hasGds && (
                                <div className="wafer-wizard__manual-die">
                                    <label className="wafer-wizard__field">
                                        Placeholder die width (µm)
                                        <input
                                            type="number"
                                            min={100}
                                            step={100}
                                            value={manualW}
                                            onChange={(e) => setManualW(Number(e.target.value) || 5000)}
                                        />
                                    </label>
                                    <label className="wafer-wizard__field">
                                        Placeholder die height (µm)
                                        <input
                                            type="number"
                                            min={100}
                                            step={100}
                                            value={manualH}
                                            onChange={(e) => setManualH(Number(e.target.value) || 5000)}
                                        />
                                    </label>
                                </div>
                            )}
                        </>
                    )}

                    {step === 2 && (
                        <>
                            <p className="wafer-wizard__lead">
                                <strong>Street</strong> is the gap between adjacent die footprints (scribe / dicing
                                lane). Scribe lines go on the <strong>Dicing</strong> layer. Die placements live on the
                                first mask layer but resolve into every <strong>Mask · …</strong> layer in lockstep.
                                Use the Layers panel to show one mask at a time or compare overlays.
                            </p>
                            <label className="wafer-wizard__field">
                                Street width / dicing lane (µm)
                                <input
                                    type="number"
                                    min={0}
                                    step={5}
                                    value={streetUm}
                                    onChange={(e) => setStreetUm(Number(e.target.value) || 0)}
                                />
                            </label>
                            <label className="wafer-wizard__check">
                                <input
                                    type="checkbox"
                                    checked={includeAlignmentMarks}
                                    onChange={(e) => setIncludeAlignmentMarks(e.target.checked)}
                                />
                                Add photolithography alignment crosses on the <strong>Alignment</strong> layer (rim)
                            </label>
                            {includeAlignmentMarks && (
                                <div className="wafer-wizard__manual-die">
                                    <label className="wafer-wizard__field">
                                        Cross half-arm (µm)
                                        <input
                                            type="number"
                                            min={20}
                                            step={10}
                                            value={alignmentHalfUm}
                                            onChange={(e) => setAlignmentHalfUm(Number(e.target.value) || 150)}
                                        />
                                    </label>
                                    <label className="wafer-wizard__field">
                                        Inset from wafer edge (µm)
                                        <input
                                            type="number"
                                            min={100}
                                            step={100}
                                            value={alignmentInsetUm}
                                            onChange={(e) => setAlignmentInsetUm(Number(e.target.value) || 5000)}
                                        />
                                    </label>
                                </div>
                            )}
                            <div className="wafer-wizard__summary">
                                <LayoutGrid size={16} aria-hidden />
                                <div>
                                    <strong>Summary</strong>
                                    <ul>
                                        <li>
                                            Wafer: <strong>{waferMm} mm</strong> Ø · edge −{edgeMm} mm
                                        </li>
                                        <li>
                                            Device: {hasGds ? (gdsFile?.name ?? 'GDS') : `Placeholder ${manualW}×${manualH} µm`}
                                        </li>
                                        <li>
                                            Street: <strong>{streetUm} µm</strong> — grid &amp; scribe lines computed
                                            automatically
                                        </li>
                                        <li>
                                            Alignment crosses:{' '}
                                            <strong>{includeAlignmentMarks ? `yes (${alignmentHalfUm} µm arm)` : 'no'}</strong>
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <div className="wafer-wizard__foot">
                    {step > 0 && (
                        <button type="button" className="wafer-wizard__btn" onClick={() => setStep((s) => s - 1)}>
                            Back
                        </button>
                    )}
                    <div className="wafer-wizard__foot-spacer" />
                    {step < 2 && (
                        <button type="button" className="wafer-wizard__btn wafer-wizard__btn--primary" onClick={() => setStep((s) => s + 1)}>
                            Next
                        </button>
                    )}
                    {step === 2 && (
                        <button
                            type="button"
                            className="wafer-wizard__btn wafer-wizard__btn--primary"
                            disabled={!canGenerate || busy}
                            onClick={runGenerate}
                        >
                            {busy ? 'Building…' : 'Create wafer layout'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
