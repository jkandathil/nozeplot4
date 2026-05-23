/**
 * Interactive HSP Studio tutorial.
 *
 * Renders as a floating panel docked to the bottom-right of the viewport
 * (NOT a full-screen modal) so the user can still click around the page
 * while reading along. Each step has:
 *
 *   - `title`     a short headline
 *   - `body`      what to read (rendered with miniMarkdown for inline links/code)
 *   - `apply()`   an imperative callback that drives HspStudioPage state
 *                 (switch tabs, pick a polymer, load demo data, …). Steps
 *                 without an apply fall back to a plain "Next" button.
 *   - `tip`       optional secondary text appearing under the body
 *
 * The wizard's only dependency on `HspStudioPage` is the `actions` prop —
 * a bag of state setters and helper callbacks that map 1:1 to the
 * features the page already exposes. That keeps the wizard easy to test
 * in isolation and keeps HspStudioPage from getting any messier.
 *
 * Project payload format (load / save .json) — keep it simple and stable
 * so today's saved demo still loads next year:
 *
 *   {
 *     "version": 1,
 *     "customSphere":         { name, dD, dP, dH, R },
 *     "selectedPolymerName":  string,
 *     "blendSolventNames":    string[],
 *     "blendTarget":          { dD, dP, dH },
 *     "fitRows":              [{ name, dD?, dP?, dH?, score }],
 *     "highlightSolventName": string|null
 *   }
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ChevronLeft,
    ChevronRight,
    X as CloseIcon,
    GraduationCap,
    Minus,
    Maximize2,
    Download,
    Upload,
    Sparkles,
    BookOpen,
    RotateCcw,
    CheckCircle2,
    PlayCircle,
} from 'lucide-react';
import { renderMarkdown } from '../utils/miniMarkdown.jsx';

/** Bundled example "polymer-CB VOC sensor" project — what step 2 loads. */
const DEMO_PROJECT = Object.freeze({
    version: 1,
    label: 'Polymer-CB VOC sensor — demo project',
    customSphere: {
        name: 'PMMA (demo)',
        dD: 18.6, dP: 10.5, dH: 7.5, R: 8.6,
    },
    selectedPolymerName: 'Poly(methyl methacrylate) (PMMA)',
    blendSolventNames: ['Ethanol', 'n-Butyl acetate', 'Toluene', 'Acetone'],
    blendTarget: { dD: 18.6, dP: 10.5, dH: 7.5 },
    fitRows: [
        { name: 'Acetone',                          score: 1 },
        { name: 'Methyl ethyl ketone (MEK)',        score: 1 },
        { name: 'Tetrahydrofuran (THF)',            score: 1 },
        { name: 'Dichloromethane (DCM)',            score: 1 },
        { name: 'Ethyl acetate',                    score: 1 },
        { name: 'Chloroform',                       score: 1 },
        { name: 'Toluene',                          score: 0 },
        { name: 'n-Heptane',                        score: 0 },
        { name: 'n-Hexane',                         score: 0 },
        { name: 'Cyclohexane',                      score: 0 },
        { name: 'Water',                            score: 0 },
        { name: 'Methanol',                         score: 1 },
        { name: 'Ethanol',                          score: 1 },
        { name: 'iso-Propanol',                     score: 0 },
    ],
    highlightSolventName: 'Acetone',
});

/* ============================================================
 * Tutorial steps
 * ============================================================ */

function buildSteps(actions) {
    return [
        {
            id: 'welcome',
            title: 'Welcome to HSP Studio',
            body:
                "We'll design a 4-channel polymer / carbon-black chemiresistor array " +
                "for distinguishing **Acetone**, **Ethanol**, **Toluene**, and **Water** — " +
                "the same scenario as the written reference, but you'll *drive* the app " +
                "as we go.\n\nClick **Next** to start.",
            tip: 'This wizard never covers the whole UI — feel free to click around the page while reading.',
        },
        {
            id: 'demo',
            title: 'Step 1 · Load the demo project',
            body:
                "I'll fill in a worked-example project: **PMMA** as the candidate polymer, " +
                "four solvents you'd realistically run through a printing/sensing rig, and " +
                "a pre-tagged Yes/No solubility table for the sphere fitter.\n\n" +
                "You can also **Download** this project as a `.json` file (top of the wizard) " +
                "and re-import it later, or share it with a teammate.",
            applyLabel: 'Load demo project',
            apply: () => actions.loadProject(DEMO_PROJECT),
        },
        {
            id: 'view',
            title: 'Step 2 · Look at HSP space',
            body:
                "Switching to the **3-D View** tab. Each dot is a solvent placed in " +
                "Hansen space `(δD, δP, δH)`; the gold wire is the active polymer's " +
                "solubility sphere.\n\n" +
                "Try this: **drag to orbit**, **wheel to zoom**, **double-click to reset**. " +
                "Hover any dot for its name & HSP triplet.",
            tip: 'Highlight = Acetone (yellow ring). Notice it sits comfortably inside the PMMA sphere — predicted soluble.',
            applyLabel: 'Open 3D View',
            apply: () => { actions.setTab('view'); },
        },
        {
            id: 'polymer',
            title: 'Step 3 · Try a different polymer',
            body:
                "Use the **Sphere** dropdown in the toolbar to switch polymers. Watch the " +
                "solvent dots recolour: **green = inside** (predicted soluble) / **red = outside** " +
                "(insoluble).\n\n" +
                "I'll set us to **LDPE** first — you'll see Toluene swing into the green and " +
                "every polar VOC fall out. That's exactly the *non-polar channel* of a multi-polymer sensor array.",
            applyLabel: 'Switch sphere → LDPE',
            apply: () => { actions.setTab('view'); actions.setSelectedPolymerName('Polyethylene (LDPE)'); },
        },
        {
            id: 'red',
            title: 'Step 4 · Quantify it with RED',
            body:
                "The **RED tab** turns the visual into a number: `RED = Ra / R`. " +
                "RED < 1 ⇒ inside the sphere ⇒ strong sorption ⇒ big ΔR/R₀.\n\n" +
                "I'll set the solvent to **Toluene** so you can read off `RED ≈ 0.30` against " +
                "LDPE — strong toluene-channel response predicted.",
            applyLabel: 'Open RED tab · Toluene',
            apply: () => { actions.setTab('red'); actions.setRedSolventName('Toluene'); },
        },
        {
            id: 'matrix',
            title: 'Step 5 · Build a discrimination matrix',
            body:
                "Switch to the **Database** tab — every row now shows a live **RED** column " +
                "computed against the active sphere. Cycle through the **Sphere** dropdown " +
                "(LDPE → PMMA → PVAc → Nylon-66) and sort the RED column for each. The " +
                "winner polymer per analyte is your sensor channel.\n\n" +
                "A well-designed array has a **different winner** for every target VOC.",
            applyLabel: 'Open Database',
            apply: () => { actions.setTab('db'); actions.setSelectedPolymerName('Poly(methyl methacrylate) (PMMA)'); },
        },
        {
            id: 'fit',
            title: 'Step 6 · Fit your own polymer sphere',
            body:
                "In real life the textbook polymer values rarely match *your* polymer/CB film. " +
                "The **Sphere Fit** tab does Hansen's classical fit from your Yes/No swelling data. " +
                "I've preloaded a sensible Y/N panel — click **Fit sphere** to run the optimiser.",
            applyLabel: 'Open Sphere Fit & run',
            apply: () => { actions.setTab('fit'); actions.runSphereFit(); },
        },
        {
            id: 'applyFit',
            title: 'Step 7 · Use the fit as the active sphere',
            body:
                "Click **Use as active sphere** in the Sphere Fit tab (I just did it for you). " +
                "From here on, the 3-D view, the database RED column, and the RED calculator " +
                "all use **your** fitted polymer, not the textbook one. " +
                "Switch back to the 3-D view to see how the sphere moves to the centre of the *good* cluster.",
            applyLabel: 'Apply fit · open 3D',
            apply: () => { actions.applyFitToCustom(); actions.setTab('view'); },
        },
        {
            id: 'blend',
            title: 'Step 8 · Design a calibration blend',
            body:
                "Open the **Blend** tab. The target HSP defaults to the active sphere centre " +
                "(I'll click **Use active sphere** for you). Then **Optimise blend** solves the " +
                "projected-gradient problem and returns the volume fractions that best match the " +
                "target — handy for generating a calibration vapour mixture that sits right inside " +
                "your polymer's sweet spot.",
            applyLabel: 'Open Blend & optimise',
            apply: () => {
                actions.setTab('blend');
                actions.setTargetFromSphere();
                /* Need to wait a tick so blendTarget propagates before optimisation. */
                setTimeout(() => actions.runBlend(), 30);
            },
        },
        {
            id: 'export',
            title: 'Step 9 · Export the recipe',
            body:
                "Down in the Blend tab there's an **Export CSV** button: it writes the solvent " +
                "names, volume fractions, the HSP coordinates of each component, and the final " +
                "blend HSP. Hand the CSV to a balance and you can pipette the calibration " +
                "mixture in minutes.\n\nYou can also **Save project** (top of this wizard) to " +
                "keep the entire HSP Studio state as a `.json` file.",
            tip: 'No data leaves the browser — everything runs locally.',
        },
        {
            id: 'done',
            title: 'You\'re done',
            body:
                "From here, you have the full workflow: visualise the HSP space, fit a polymer " +
                "sphere from lab data, score VOCs with RED, and design solvent blends.\n\n" +
                "If you want a deeper reference, open the **Read full reference** doc below — " +
                "it includes the precomputed 4-VOC × 5-polymer RED matrix, the sensor-design " +
                "cheat-sheet, and links to the [Hansen Solubility Parameters home page](https://www.hansen-solubility.com/HSPiP/).",
            applyLabel: 'Open written reference',
            apply: () => actions.openReference(),
        },
    ];
}

/* ============================================================
 * Wizard component
 * ============================================================ */

export default function HspTutorial({ open, onClose, actions }) {
    const [stepIdx, setStepIdx] = useState(0);
    const [minimised, setMinimised] = useState(false);
    const [appliedSteps, setAppliedSteps] = useState(() => new Set());

    const steps = useMemo(() => buildSteps(actions), [actions]);
    const step = steps[stepIdx];
    const total = steps.length;

    /* Keyboard nav: Esc closes, ←/→ change steps. We bind on window so the
       user doesn't need to focus the wizard before pressing keys. */
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') { onClose(); }
            if (e.key === 'ArrowRight') { setStepIdx((i) => Math.min(steps.length - 1, i + 1)); }
            if (e.key === 'ArrowLeft')  { setStepIdx((i) => Math.max(0, i - 1)); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, steps.length]);

    /* Helper: run the current step's apply() and remember we ran it so the
       button can render a "Re-apply" hint on second visit. */
    const applyCurrent = useCallback(() => {
        if (!step) return;
        try { step.apply?.(); } catch { /* tolerated — wizard never blocks page */ }
        setAppliedSteps((prev) => {
            const next = new Set(prev);
            next.add(step.id);
            return next;
        });
    }, [step]);

    const next = useCallback(() => {
        setStepIdx((i) => Math.min(steps.length - 1, i + 1));
    }, [steps.length]);

    const prev = useCallback(() => {
        setStepIdx((i) => Math.max(0, i - 1));
    }, []);

    const restart = useCallback(() => {
        setStepIdx(0);
        setAppliedSteps(new Set());
    }, []);

    const saveProject = useCallback(() => {
        const payload = actions.collectProject();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `hsp_studio_project_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [actions]);

    const downloadDemoFile = useCallback(() => {
        const blob = new Blob([JSON.stringify(DEMO_PROJECT, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hsp_studio_polymer_cb_demo.json';
        a.click();
        URL.revokeObjectURL(url);
    }, []);

    const loadProjectFile = useCallback((file) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const obj = JSON.parse(e.target.result);
                if (!obj || typeof obj !== 'object') throw new Error('not an object');
                actions.loadProject(obj);
            } catch (err) {
                window.alert(`Could not load project: ${err?.message ?? err}`);
            }
        };
        reader.readAsText(file);
    }, [actions]);

    if (!open) return null;

    /* Minimised pill — single button to expand again. */
    if (minimised) {
        return createPortal(
            <button
                className="hsp-tour-pill"
                onClick={() => setMinimised(false)}
                title="Reopen HSP Studio tutorial"
            >
                <GraduationCap size={14} aria-hidden /> Tutorial · {stepIdx + 1}/{total}
            </button>,
            document.body
        );
    }

    const isApplied = step.id ? appliedSteps.has(step.id) : false;

    return createPortal(
        <div className="hsp-tour" role="dialog" aria-label="HSP Studio interactive tutorial">
            <div className="hsp-tour-head">
                <span className="hsp-tour-title">
                    <GraduationCap size={15} aria-hidden /> HSP Studio · Interactive Tutorial
                </span>
                <span className="hsp-tour-progress" aria-label="Tutorial progress">
                    {stepIdx + 1} / {total}
                </span>
                <button
                    className="hsp-tour-icon"
                    onClick={() => setMinimised(true)}
                    title="Minimise"
                >
                    <Minus size={14} />
                </button>
                <button
                    className="hsp-tour-icon"
                    onClick={onClose}
                    title="Close tutorial (Esc)"
                    aria-label="Close tutorial"
                >
                    <CloseIcon size={15} />
                </button>
            </div>

            <div className="hsp-tour-toolrow">
                <button className="hsp-tour-mini-btn" onClick={saveProject}
                    title="Download the CURRENT app state as a .json project">
                    <Download size={12} /> Save project
                </button>
                <label className="hsp-tour-mini-btn" title="Load a previously-saved HSP Studio project">
                    <Upload size={12} /> Load
                    <input
                        type="file"
                        accept="application/json,.json"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            loadProjectFile(f);
                            e.target.value = '';
                        }}
                    />
                </label>
                <button className="hsp-tour-mini-btn" onClick={downloadDemoFile}
                    title="Download the bundled demo project as .json">
                    <Sparkles size={12} /> Demo .json
                </button>
                <button className="hsp-tour-mini-btn" onClick={() => actions.openReference()}
                    title="Open the full written reference (markdown)">
                    <BookOpen size={12} /> Reference
                </button>
                <button className="hsp-tour-mini-btn" onClick={restart}
                    title="Restart from step 1">
                    <RotateCcw size={12} /> Restart
                </button>
            </div>

            <div className="hsp-tour-progress-bar">
                <div className="hsp-tour-progress-bar-fill"
                    style={{ width: `${((stepIdx + 1) / total) * 100}%` }} />
            </div>

            <div className="hsp-tour-body">
                <h4 className="hsp-tour-step-title">
                    {isApplied && <CheckCircle2 size={14} aria-hidden style={{ color: '#34d399', marginRight: 6, verticalAlign: 'middle' }} />}
                    {step.title}
                </h4>
                <div className="hsp-tour-step-text">{renderMarkdown(step.body)}</div>
                {step.tip && (
                    <div className="hsp-tour-tip">
                        <PlayCircle size={12} aria-hidden /> {step.tip}
                    </div>
                )}
            </div>

            <div className="hsp-tour-footer">
                <button
                    className="hsp-btn hsp-btn--ghost"
                    onClick={prev}
                    disabled={stepIdx === 0}
                >
                    <ChevronLeft size={13} /> Back
                </button>
                {step.apply ? (
                    <button
                        className="hsp-btn hsp-btn--primary"
                        onClick={applyCurrent}
                        title="Run this step's action in the app behind the wizard"
                    >
                        {isApplied ? <RotateCcw size={13} /> : <Maximize2 size={13} />}
                        {' '}
                        {isApplied ? 'Re-apply' : (step.applyLabel ?? 'Apply')}
                    </button>
                ) : null}
                {stepIdx < total - 1 ? (
                    <button className="hsp-btn" onClick={next}>
                        Next <ChevronRight size={13} />
                    </button>
                ) : (
                    <button className="hsp-btn hsp-btn--primary" onClick={onClose}>
                        Finish
                    </button>
                )}
            </div>

            <div className="hsp-tour-dots" role="tablist" aria-label="Tutorial steps">
                {steps.map((s, idx) => (
                    <button
                        key={s.id}
                        className={`hsp-tour-dot ${idx === stepIdx ? 'is-active' : ''} ${appliedSteps.has(s.id) ? 'is-done' : ''}`}
                        onClick={() => setStepIdx(idx)}
                        title={`${idx + 1}. ${s.title}`}
                        aria-label={`Step ${idx + 1}: ${s.title}`}
                    />
                ))}
            </div>
        </div>,
        document.body
    );
}
