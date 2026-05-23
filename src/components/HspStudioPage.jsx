/**
 * HSP Studio — Hansen Solubility Parameter workbench.
 *
 * Tabs:
 *   - 3-D View        : orbit the (δD, δP, δH) space, overlay solvent dots
 *                       and one or more polymer / fit spheres.
 *   - Database        : searchable, filterable, sortable table of the
 *                       built-in solvent library (HSP, MW, BP, RER, density).
 *   - Sphere Fit      : enter a list of solvents with Yes/No solubility,
 *                       fit the Hansen sphere (δD₀, δP₀, δH₀, R) that
 *                       best classifies them.
 *   - Blend Optimizer : pick up to 8 solvents and a target HSP; the
 *                       projected-gradient solver returns the volume
 *                       fractions that minimise Ra to target.
 *   - RED Calculator  : one-click RED of a single solvent or blend
 *                       against any sphere in the library.
 *   - Calculator      : HSPiP-style DIY — SMILES / UNIFAC groups / physical
 *                       properties; Stefanis–Panayiotou, van Krevelen, Hoy,
 *                       Beerbower, polymer repeat units & co-polymers.
 *
 * All math lives in `src/hsp/hspMath.js`; this file is a thin orchestrator
 * around input UI, validation, and presentation.
 *
 * Persistence: the entire workbench state (custom polymer, sphere-fit
 * dataset, blend pick) is mirrored to `localStorage` under
 * `hsp_studio_state_v1` so the user doesn't lose work on a page refresh.
 * It is intentionally NOT saved into the .noze workspace — those files
 * are for sensor data, not solubility playgrounds.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    FlaskConical,
    Box,
    Database as DatabaseIcon,
    Target,
    Sigma,
    Layers,
    HelpCircle,
    Plus,
    Trash2,
    Download,
    Calculator as CalcIcon,
    Search,
    Beaker,
    Zap,
    Wand2,
    BookOpen,
    X as CloseIcon,
    GraduationCap,
    Atom,
    Copy,
    Upload,
    Wind,
    Sparkles,
    Thermometer,
    FileUp,
} from 'lucide-react';
import './HspStudioPage.css';
import { renderMarkdown } from '../utils/miniMarkdown.jsx';
import HspTutorial from './HspTutorial.jsx';
/* The tutorial Markdown is bundled at build time via Vite's `?raw`
   import suffix — no network fetch, works offline, and the doc stays in
   lock-step with the deployed app version. */
import tutorialMarkdown from '../../docs/hsp_studio_polymer_cb_sensor_tutorial.md?raw';
import {
    hspRa,
    hspRED,
    hspTotal,
    hspBlend,
    optimiseBlend,
    fitHansenSphere,
    fitHansenSphereDE,
    fitConcentricDoubleSphere,
    fitDoubleHansenSpheres,
    simulateEvaporation,
    hspSolubilityZone,
} from '../hsp/hspMath.js';
import {
    HSP_SOLVENTS,
    HSP_CATEGORIES,
    HSP_POLYMER_SPHERES,
    SOLVENT_DB_STATS,
    findSolventByName,
    mergeCustomSolvents,
} from '../hsp/hspSolvents.js';
import { correctSphereAtTemperature } from '../hsp/hspTemperature.js';
import { suggestSolvents, suggestBlendSolvents } from '../hsp/hspSuggest.js';
import {
    parseHsdText,
    parseHsdxText,
    exportHsdText,
    exportProjectJson,
    parseProjectJson,
} from '../hsp/hspHsdIo.js';
import HspSphereView from './HspSphereView.jsx';
import {
    estimateAllMethods,
    hspToTeas,
} from '../hsp/hspEstimate.js';
import {
    SP_GROUP_NAMES,
    SYMMETRY_OPTIONS,
} from '../hsp/hspGroupTables.js';
import {
    expandPolymerSmiles,
    smilesToUnifacGroups,
    SMILES_EXAMPLES,
} from '../hsp/hspSmilesGroups.js';
import {
    HSP_POLYMER_MONOMERS,
    buildCopolymerSmiles,
    findPolymerByName,
} from '../hsp/hspPolymerDb.js';

const STORAGE_KEY = 'hsp_studio_state_v2';
const MAX_BLEND_SOLVENTS = 8;

const NAV_ITEMS = [
    { id: 'view', label: '3D View', icon: Box, desc: 'Hansen space visualization' },
    { id: 'db', label: 'Database', icon: DatabaseIcon, desc: `${SOLVENT_DB_STATS.total}+ solvents` },
    { id: 'fit', label: 'Sphere Fit', icon: Target, desc: 'Single & double sphere' },
    { id: 'suggest', label: 'Solvent Find', icon: Sparkles, desc: 'Rank compatible solvents' },
    { id: 'blend', label: 'Blend', icon: Layers, desc: 'Optimize formulations' },
    { id: 'evap', label: 'Evaporation', icon: Wind, desc: 'Drying path & RED drift' },
    { id: 'calc', label: 'Calculator', icon: Atom, desc: 'HSP from structure' },
    { id: 'red', label: 'RED', icon: Sigma, desc: 'Distance checks' },
];

/** Persisted "custom polymer / user sphere" state. */
const DEFAULT_CUSTOM_SPHERE = {
    name: 'Custom polymer',
    dD: 18.0,
    dP: 8.0,
    dH: 6.0,
    R: 8.0,
    R_outer: 12.0,
    doubleSphere: false,
    dualSpheres: false,
};

const DEFAULT_SPHERE_FIT_DATA = [
    { name: 'Acetone',         score: 1 },
    { name: 'Ethanol',         score: 1 },
    { name: 'Toluene',         score: 0 },
    { name: 'n-Hexane',        score: 0 },
    { name: 'Methanol',        score: 1 },
    { name: 'Water',           score: 0 },
    { name: 'Ethyl acetate',   score: 1 },
    { name: 'Methyl ethyl ketone (MEK)', score: 1 },
    { name: 'Cyclohexane',     score: 0 },
    { name: 'Chloroform',      score: 1 },
    { name: 'Dichloromethane (DCM)', score: 1 },
    { name: 'Tetrahydrofuran (THF)', score: 1 },
    { name: 'iso-Propanol',    score: 1 },
    { name: 'n-Heptane',       score: 0 },
];

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
            || localStorage.getItem('hsp_studio_state_v1');
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (typeof obj !== 'object' || obj == null) return null;
        return obj;
    } catch { return null; }
}

function saveState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
}

export default function HspStudioPage() {
    const [tab, setTab] = useState('view');
    /* Tutorial state: the interactive wizard and the static markdown
       reference are two separate overlays. The wizard opens by default
       so first-time users see the guided walkthrough; the static
       reference is one click away from inside the wizard. */
    const [wizardOpen, setWizardOpen] = useState(() => {
        try { return localStorage.getItem('hsp_tutorial_seen_v1') !== '1'; }
        catch { return true; }
    });
    const [referenceOpen, setReferenceOpen] = useState(false);
    useEffect(() => {
        if (!wizardOpen) {
            try { localStorage.setItem('hsp_tutorial_seen_v1', '1'); } catch { /* quota */ }
        }
    }, [wizardOpen]);

    /* ============= Custom polymer (user-tunable sphere) ============= */
    const [customSphere, setCustomSphere] = useState(() => {
        const s = loadState();
        return s?.customSphere ?? DEFAULT_CUSTOM_SPHERE;
    });
    const [selectedPolymerName, setSelectedPolymerName] = useState(() => {
        const s = loadState();
        return s?.selectedPolymerName ?? 'Custom polymer';
    });
    const [highlightSolventName, setHighlightSolventName] = useState(null);

    /* ============= Database filters ============= */
    const [dbQuery, setDbQuery] = useState('');
    const [dbCategory, setDbCategory] = useState('all');
    const [dbSort, setDbSort] = useState({ col: 'name', dir: 'asc' });

    /* ============= Sphere fit data ============= */
    const [fitRows, setFitRows] = useState(() => {
        const s = loadState();
        if (s?.fitRows && Array.isArray(s.fitRows) && s.fitRows.length > 0) return s.fitRows;
        return DEFAULT_SPHERE_FIT_DATA;
    });
    const [fitResult, setFitResult] = useState(null);

    /* ============= Blend optimizer state ============= */
    const [blendSolventNames, setBlendSolventNames] = useState(() => {
        const s = loadState();
        return s?.blendSolventNames ?? ['Ethanol', 'Ethyl acetate', 'Toluene', 'Acetone'];
    });
    const [blendTarget, setBlendTarget] = useState(() => {
        const s = loadState();
        return s?.blendTarget ?? { dD: 18, dP: 8, dH: 6 };
    });
    const [blendResult, setBlendResult] = useState(null);

    /* ============= RED calculator state ============= */
    const [redSolventName, setRedSolventName] = useState('Acetone');

    /* ============= HSP Calculator (HSPiP-style) ============= */
    const [calcMode, setCalcMode] = useState(() => loadState()?.calcMode ?? 'molecule');
    const [calcSmiles, setCalcSmiles] = useState(() => loadState()?.calcSmiles ?? 'CCO');
    const [calcGroups, setCalcGroups] = useState(() => loadState()?.calcGroups ?? { CH3: 1, CH2: 1, OH: 1 });
    const [calcSecondOrder, setCalcSecondOrder] = useState(() => loadState()?.calcSecondOrder ?? {});
    const [calcUseSecondOrder, setCalcUseSecondOrder] = useState(() => loadState()?.calcUseSecondOrder ?? false);
    const [calcSymmetry, setCalcSymmetry] = useState(() => loadState()?.calcSymmetry ?? 0);
    const [calcNMer, setCalcNMer] = useState(() => loadState()?.calcNMer ?? 4);
    const [calcPolymerName, setCalcPolymerName] = useState(() => loadState()?.calcPolymerName ?? HSP_POLYMER_MONOMERS[0]?.name ?? '');
    const [calcPhysical, setCalcPhysical] = useState(() => loadState()?.calcPhysical ?? {
        enthalpyVap: '', molarVolume: '', refractiveIndex: '', dipoleMoment: '', dDEstimate: '',
    });
    const [calcBoilingPointC, setCalcBoilingPointC] = useState(() => loadState()?.calcBoilingPointC ?? '');
    const [calcResults, setCalcResults] = useState(null);
    const [calcSelectedMethod, setCalcSelectedMethod] = useState(null);

    /* ============= HSPiP parity: temperature, double sphere, custom solvents ============= */
    const [temperatureC, setTemperatureC] = useState(() => loadState()?.temperatureC ?? 25);
    const [fitMode, setFitMode] = useState(() => loadState()?.fitMode ?? 'single');
    const [fitEngine, setFitEngine] = useState(() => loadState()?.fitEngine ?? 'gradient');
    const [customSolvents, setCustomSolvents] = useState(() => loadState()?.customSolvents ?? []);
    const [dbInsideOnly, setDbInsideOnly] = useState(false);
    const [suggestZone, setSuggestZone] = useState('good');
    const [suggestMaxRED, setSuggestMaxRED] = useState(1.0);
    const [evapFraction, setEvapFraction] = useState(0.85);
    const [evapHistory, setEvapHistory] = useState(null);
    const fileInputRef = React.useRef(null);

    /* ---------------- persistence ---------------- */
    useEffect(() => {
        saveState({
            customSphere,
            selectedPolymerName,
            fitRows,
            blendSolventNames,
            blendTarget,
            calcMode,
            calcSmiles,
            calcGroups,
            calcSecondOrder,
            calcUseSecondOrder,
            calcSymmetry,
            calcNMer,
            calcPolymerName,
            calcPhysical,
            calcBoilingPointC,
            temperatureC,
            fitMode,
            fitEngine,
            customSolvents,
        });
    }, [customSphere, selectedPolymerName, fitRows, blendSolventNames, blendTarget,
        calcMode, calcSmiles, calcGroups, calcSecondOrder, calcUseSecondOrder,
        calcSymmetry, calcNMer, calcPolymerName, calcPhysical, calcBoilingPointC,
        temperatureC, fitMode, fitEngine, customSolvents]);

    const allSolvents = useMemo(
        () => mergeCustomSolvents(customSolvents),
        [customSolvents]
    );

    const baseSphere = useMemo(() => {
        if (selectedPolymerName === 'Custom polymer') return customSphere;
        const p = HSP_POLYMER_SPHERES.find((s) => s.name === selectedPolymerName);
        return p ?? customSphere;
    }, [selectedPolymerName, customSphere]);

    const resolvedSphere = useMemo(() => {
        const s = temperatureC !== 25
            ? correctSphereAtTemperature(baseSphere, temperatureC)
            : { ...baseSphere };
        return s;
    }, [baseSphere, temperatureC]);

    /* ---------------- 3-D view data ---------------- */
    const viewPoints = useMemo(() => allSolvents.map((s) => {
        const pt = { dD: s.dD, dP: s.dP, dH: s.dH };
        const zone = hspSolubilityZone(pt, resolvedSphere);
        const RED = hspRED(pt, resolvedSphere);
        return {
            name: s.name,
            dD: s.dD,
            dP: s.dP,
            dH: s.dH,
            score: zone === 'good' || RED <= 1 ? 1 : zone === 'marginal' ? 0.5 : 0,
            zone,
        };
    }), [resolvedSphere, allSolvents]);

    /* ============================================================
     *  Database tab
     * ============================================================ */
    const filteredDb = useMemo(() => {
        const q = dbQuery.trim().toLowerCase();
        let filtered = allSolvents.filter((s) => {
            if (dbCategory !== 'all' && s.category !== dbCategory) return false;
            if (!q) return true;
            return (
                s.name.toLowerCase().includes(q) ||
                (s.cas || '').includes(q) ||
                s.category.includes(q) ||
                (s.smiles || '').toLowerCase().includes(q)
            );
        });
        if (dbInsideOnly) {
            filtered = filtered.filter((s) => {
                const pt = { dD: s.dD, dP: s.dP, dH: s.dH };
                return hspSolubilityZone(pt, resolvedSphere) !== 'bad';
            });
        }
        const dir = dbSort.dir === 'asc' ? 1 : -1;
        const col = dbSort.col;
        const v = (s) =>
            col === 'name' || col === 'category' || col === 'cas'
                ? String(s[col] ?? '').toLowerCase()
                : Number(s[col] ?? 0);
        return [...filtered].sort((a, b) => {
            const va = v(a), vb = v(b);
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    }, [dbQuery, dbCategory, dbSort, dbInsideOnly, resolvedSphere, allSolvents]);

    const sortToggle = (col) => () => {
        setDbSort((s) => s.col === col
            ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
            : { col, dir: 'asc' });
    };

    /* ============================================================
     *  Sphere fit
     * ============================================================ */
    const runSphereFit = useCallback(() => {
        const pts = fitRows.map((r) => {
            const s = findSolventByName(r.name) || allSolvents.find((x) => x.name === r.name);
            const dD = Number(r.dD ?? s?.dD);
            const dP = Number(r.dP ?? s?.dP);
            const dH = Number(r.dH ?? s?.dH);
            if (!Number.isFinite(dD) || !Number.isFinite(dP) || !Number.isFinite(dH)) return null;
            return { dD, dP, dH, score: Number(r.score) };
        }).filter(Boolean);
        if (fitMode === 'double') {
            setFitResult(fitConcentricDoubleSphere(pts, { engine: fitEngine }));
        } else if (fitMode === 'dual') {
            setFitResult(fitDoubleHansenSpheres(pts));
        } else {
            const fitFn = fitEngine === 'de' ? fitHansenSphereDE : fitHansenSphere;
            setFitResult(fitFn(pts.map((p) => ({
                ...p,
                score: p.score >= 1 ? 1 : 0,
            }))));
        }
    }, [fitRows, fitMode, fitEngine, allSolvents]);

    const applyFitToCustom = useCallback(() => {
        if (!fitResult) return;
        if (fitResult.spheres) {
            const a = fitResult.spheres[0];
            setCustomSphere({
                name: 'Custom polymer (dual fit A)',
                dD: a.dD, dP: a.dP, dH: a.dH, R: a.R,
                dualSpheres: true,
            });
        } else {
            setCustomSphere({
                name: 'Custom polymer (fitted)',
                dD: fitResult.center.dD,
                dP: fitResult.center.dP,
                dH: fitResult.center.dH,
                R: fitResult.R_inner ?? fitResult.R,
                R_outer: fitResult.R_outer ?? fitResult.R * 1.3,
                doubleSphere: !!fitResult.R_outer,
            });
        }
        setSelectedPolymerName('Custom polymer');
    }, [fitResult]);

    const addFitRow = useCallback(() => {
        setFitRows((rows) => [...rows, { name: '', dD: 18, dP: 6, dH: 6, score: 1 }]);
    }, []);

    const updateFitRow = useCallback((idx, patch) => {
        setFitRows((rows) => rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
    }, []);

    const removeFitRow = useCallback((idx) => {
        setFitRows((rows) => rows.filter((_, i) => i !== idx));
    }, []);

    /* ============================================================
     *  Blend optimizer
     * ============================================================ */
    const blendCandidates = useMemo(() => {
        return blendSolventNames
            .map((n) => findSolventByName(n) || allSolvents.find((s) => s.name === n))
            .filter(Boolean);
    }, [blendSolventNames, allSolvents]);

    const runBlend = useCallback(() => {
        if (blendCandidates.length === 0) {
            setBlendResult({ phi: [], blend: { dD: 0, dP: 0, dH: 0 }, Ra: Infinity });
            return;
        }
        const res = optimiseBlend(blendCandidates, blendTarget);
        setBlendResult(res);
    }, [blendCandidates, blendTarget]);

    const setTargetFromSphere = useCallback(() => {
        setBlendTarget({
            dD: resolvedSphere.dD,
            dP: resolvedSphere.dP,
            dH: resolvedSphere.dH,
        });
    }, [resolvedSphere]);

    const addBlendSolvent = useCallback(() => {
        setBlendSolventNames((names) => {
            if (names.length >= MAX_BLEND_SOLVENTS) return names;
            /* Pick the first solvent that isn't already in the blend. */
            const used = new Set(names);
            const next = allSolvents.find((s) => !used.has(s.name));
            return next ? [...names, next.name] : names;
        });
    }, [allSolvents]);

    const removeBlendSolvent = useCallback((idx) => {
        setBlendSolventNames((names) => names.filter((_, i) => i !== idx));
    }, []);

    const updateBlendSolvent = useCallback((idx, name) => {
        setBlendSolventNames((names) => names.map((n, i) => i === idx ? name : n));
    }, []);

    /* ============================================================
     *  RED calculator (single solvent vs current sphere)
     * ============================================================ */
    const redSolvent = useMemo(
        () => findSolventByName(redSolventName) || allSolvents.find((s) => s.name === redSolventName),
        [redSolventName, allSolvents]
    );
    const redResult = useMemo(() => {
        if (!redSolvent) return null;
        return {
            Ra: hspRa(redSolvent, resolvedSphere),
            RED: hspRED(redSolvent, resolvedSphere),
        };
    }, [redSolvent, resolvedSphere]);

    /* ============================================================
     *  Project (de)serialisation for the wizard's Save / Load buttons.
     *  Keeps version field at top so future schema changes can branch.
     * ============================================================ */
    const collectProject = useCallback(() => ({
        version: 2,
        customSphere,
        selectedPolymerName,
        blendSolventNames,
        blendTarget,
        fitRows,
        highlightSolventName,
        temperatureC,
        fitMode,
        fitEngine,
        customSolvents,
        calcMode,
        calcSmiles,
        calcGroups,
        calcPolymerName,
    }), [customSphere, selectedPolymerName, blendSolventNames, blendTarget, fitRows,
        highlightSolventName, temperatureC, fitMode, fitEngine, customSolvents,
        calcMode, calcSmiles, calcGroups, calcPolymerName]);

    const loadProject = useCallback((proj) => {
        if (!proj || typeof proj !== 'object') return;
        if (proj.customSphere) setCustomSphere(proj.customSphere);
        if (typeof proj.selectedPolymerName === 'string') setSelectedPolymerName(proj.selectedPolymerName);
        if (Array.isArray(proj.blendSolventNames)) setBlendSolventNames(proj.blendSolventNames);
        if (proj.blendTarget && Number.isFinite(proj.blendTarget.dD)) setBlendTarget(proj.blendTarget);
        if (Array.isArray(proj.fitRows)) setFitRows(proj.fitRows);
        if (typeof proj.highlightSolventName === 'string' || proj.highlightSolventName === null) {
            setHighlightSolventName(proj.highlightSolventName);
        }
        if (Number.isFinite(proj.temperatureC)) setTemperatureC(proj.temperatureC);
        if (typeof proj.fitMode === 'string') setFitMode(proj.fitMode);
        if (typeof proj.fitEngine === 'string') setFitEngine(proj.fitEngine);
        if (Array.isArray(proj.customSolvents)) setCustomSolvents(proj.customSolvents);
        if (typeof proj.calcMode === 'string') setCalcMode(proj.calcMode);
        if (typeof proj.calcSmiles === 'string') setCalcSmiles(proj.calcSmiles);
        if (proj.calcGroups && typeof proj.calcGroups === 'object') setCalcGroups(proj.calcGroups);
        if (typeof proj.calcPolymerName === 'string') setCalcPolymerName(proj.calcPolymerName);
        setFitResult(null);
        setBlendResult(null);
        setEvapHistory(null);
    }, []);

    const exportBlendCsv = useCallback(() => {
        if (!blendResult || !blendResult.phi.length) return;
        const rows = ['solvent,volume_fraction,dD,dP,dH,density_gpercm3,mw_gpermol,rer_butyl_acetate_1'];
        blendCandidates.forEach((s, i) => {
            rows.push([
                s.name,
                blendResult.phi[i].toFixed(4),
                s.dD, s.dP, s.dH,
                s.density, s.mw, s.rer,
            ].join(','));
        });
        rows.push('');
        rows.push(`target,${blendTarget.dD},${blendTarget.dP},${blendTarget.dH}`);
        rows.push(`blend,${blendResult.blend.dD.toFixed(2)},${blendResult.blend.dP.toFixed(2)},${blendResult.blend.dH.toFixed(2)}`);
        rows.push(`Ra,${blendResult.Ra.toFixed(3)}`);
        const csv = rows.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hsp_blend.csv';
        a.click();
        URL.revokeObjectURL(url);
    }, [blendResult, blendCandidates, blendTarget]);

    /* ============================================================
     *  HSP Calculator — parse SMILES, run all methods
     * ============================================================ */
    const parseSmilesToGroups = useCallback((updateState = true) => {
        const oligomer = calcMode === 'polymer'
            ? expandPolymerSmiles(calcSmiles, calcNMer)
            : calcSmiles;
        const parsed = smilesToUnifacGroups(oligomer);
        if (updateState && parsed.groups && Object.keys(parsed.groups).length > 0) {
            setCalcGroups(parsed.groups);
        }
        return { ...parsed, oligomerSmiles: oligomer };
    }, [calcMode, calcSmiles, calcNMer]);

    const runHspCalculator = useCallback(() => {
        const parsed = parseSmilesToGroups(true);
        const groups = Object.keys(parsed.groups || {}).length > 0 ? parsed.groups : calcGroups;
        if (groups !== calcGroups) setCalcGroups(groups);
        const mapped = smilesToUnifacGroups(parsed.oligomerSmiles || calcSmiles).mapped;
        const phys = {
            enthalpyVap: parseFloat(calcPhysical.enthalpyVap) || undefined,
            molarVolume: parseFloat(calcPhysical.molarVolume) || undefined,
            refractiveIndex: parseFloat(calcPhysical.refractiveIndex) || undefined,
            dipoleMoment: parseFloat(calcPhysical.dipoleMoment) || undefined,
            dDEstimate: parseFloat(calcPhysical.dDEstimate) || undefined,
        };
        const hasPhys = phys.molarVolume > 0 && (phys.enthalpyVap > 0 || phys.refractiveIndex > 0);
        const results = estimateAllMethods({
            firstOrder: groups,
            secondOrder: calcSecondOrder,
            useSecondOrder: calcUseSecondOrder,
            beerbower: mapped?.beerbower,
            vanKrevelen: mapped?.vanKrevelen,
            hoy: mapped?.hoy,
            symmetryPlanes: calcSymmetry,
            boilingPointC: calcBoilingPointC !== '' ? parseFloat(calcBoilingPointC) : undefined,
            repeatUnits: calcMode === 'polymer' ? calcNMer : 1,
            physical: hasPhys ? phys : undefined,
        });
        setCalcResults({ results, parseWarnings: parsed.warnings, oligomerSmiles: parsed.oligomerSmiles });
        if (results.length > 0) setCalcSelectedMethod(results[0].method);
    }, [parseSmilesToGroups, calcSmiles, calcGroups, calcSecondOrder, calcUseSecondOrder,
        calcSymmetry, calcPhysical, calcBoilingPointC, calcMode, calcNMer]);

    const loadPolymerTemplate = useCallback((name) => {
        const p = findPolymerByName(name) || HSP_POLYMER_MONOMERS.find((x) => x.name === name);
        if (!p) return;
        setCalcPolymerName(p.name);
        setCalcSmiles(p.repeatSmiles);
        setCalcMode('polymer');
    }, []);

    const applyCalcToCustomSphere = useCallback(() => {
        if (!calcResults?.results?.length) return null;
        const pick = calcResults.results.find((r) => r.method === calcSelectedMethod)
            || calcResults.results[0];
        setCustomSphere({
            name: calcMode === 'polymer' ? `Calculated (${calcPolymerName || 'polymer'})` : 'Calculated molecule',
            dD: pick.dD,
            dP: pick.dP,
            dH: pick.dH,
            R: customSphere.R,
        });
        setSelectedPolymerName('Custom polymer');
        return pick;
    }, [calcResults, calcSelectedMethod, calcMode, calcPolymerName, customSphere.R]);

    const applyCalcAndFindSolvents = useCallback(() => {
        const pick = applyCalcToCustomSphere();
        if (!pick) return;
        setBlendTarget({ dD: pick.dD, dP: pick.dP, dH: pick.dH });
        setSuggestZone('good');
        setSuggestMaxRED(1.0);
        setTab('suggest');
    }, [applyCalcToCustomSphere]);

    const updateGroupCount = useCallback((group, count) => {
        setCalcGroups((g) => {
            const next = { ...g };
            const n = Math.max(0, Number(count) || 0);
            if (n === 0) delete next[group];
            else next[group] = n;
            return next;
        });
    }, []);

    const addGroupRow = useCallback((groupName) => {
        if (!groupName) return;
        setCalcGroups((g) => ({ ...g, [groupName]: (g[groupName] || 0) + 1 }));
    }, []);

    const suggestedSolvents = useMemo(() => suggestSolvents(allSolvents, resolvedSphere, {
        zone: suggestZone,
        maxRED: suggestMaxRED,
        sortBy: 'RED',
        limit: 80,
    }), [allSolvents, resolvedSphere, suggestZone, suggestMaxRED]);

    const viewSpheres = useMemo(() => {
        const list = [{ ...resolvedSphere, color: '#fbbf24', name: 'active' }];
        if (resolvedSphere.R_outer && resolvedSphere.R_outer > resolvedSphere.R) {
            list.push({
                dD: resolvedSphere.dD,
                dP: resolvedSphere.dP,
                dH: resolvedSphere.dH,
                R: resolvedSphere.R_outer,
                color: '#a78bfa',
                name: 'marginal',
            });
        }
        if (fitResult?.spheres) {
            fitResult.spheres.forEach((s, i) => {
                list.push({ ...s, color: i ? '#34d399' : '#fb7185', name: `fit-${i}` });
            });
        }
        return list;
    }, [resolvedSphere, fitResult]);

    const runEvaporation = useCallback(() => {
        const components = blendCandidates.map((s, i) => ({
            name: s.name,
            dD: s.dD, dP: s.dP, dH: s.dH,
            phi: blendResult?.phi?.[i] ?? 1 / Math.max(1, blendCandidates.length),
            rer: s.rer ?? 0.5,
            molarVolume: s.molarVolume ?? s.mw / (s.density || 0.8),
        }));
        if (!components.length) return;
        const hist = simulateEvaporation(components, {
            totalFractionEvaporated: evapFraction,
            steps: 120,
        });
        setEvapHistory(hist);
    }, [blendCandidates, blendResult, evapFraction]);

    const handleImportFile = useCallback((e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result || '');
            let parsed;
            if (file.name.endsWith('.json')) {
                const proj = parseProjectJson(text);
                if (proj) loadProject(proj);
                return;
            }
            if (file.name.endsWith('.xml') || file.name.endsWith('.hsdx')) {
                parsed = parseHsdxText(text);
            } else {
                parsed = parseHsdText(text);
            }
            if (parsed?.solvents?.length) {
                setCustomSolvents((prev) => [...prev, ...parsed.solvents]);
            }
            if (parsed?.spheres?.[0]) {
                const sp = parsed.spheres[0];
                setCustomSphere((prev) => ({
                    ...prev,
                    ...sp,
                    name: sp.name || parsed.meta?.material || 'Imported sphere',
                }));
                setSelectedPolymerName('Custom polymer');
            }
            if (parsed?.meta?.temperatureC != null) setTemperatureC(parsed.meta.temperatureC);
            if (parsed?.meta?.fitMode) setFitMode(parsed.meta.fitMode);
            if (parsed?.meta?.fitEngine) setFitEngine(parsed.meta.fitEngine);
            if (parsed?.meta?.material && !parsed?.spheres?.length) {
                setCustomSphere((prev) => ({ ...prev, name: parsed.meta.material }));
            }
            if (parsed?.solvents?.some((s) => s.score != null)) {
                setFitRows(parsed.solvents.filter((s) => s.score != null).map((s) => ({
                    name: s.name, score: s.score, dD: s.dD, dP: s.dP, dH: s.dH,
                })));
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }, [loadProject]);

    const exportHsd = useCallback(() => {
        const material = selectedPolymerName === 'Custom polymer'
            ? customSphere.name
            : selectedPolymerName;
        const blob = new Blob([exportHsdText(allSolvents, resolvedSphere, fitRows, {
            material,
            temperatureC,
            fitMode,
            fitEngine,
        })], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hsp_export.hsd';
        a.click();
        URL.revokeObjectURL(url);
    }, [allSolvents, resolvedSphere, fitRows, selectedPolymerName, customSphere.name,
        temperatureC, fitMode, fitEngine]);

    const exportProject = useCallback(() => {
        const blob = new Blob([exportProjectJson(collectProject())], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hsp_studio_project.json';
        a.click();
        URL.revokeObjectURL(url);
    }, [collectProject]);

    /* ============================================================
     *  Render
     * ============================================================ */
    return (
        <div className="hsp-page hsp-page--modern">
            <input ref={fileInputRef} type="file" accept=".hsd,.hsdx,.csv,.tsv,.txt,.json,.xml" hidden
                onChange={handleImportFile} />
            <aside className="hsp-sidebar">
                <div className="hsp-sidebar-brand">
                    <FlaskConical size={18} />
                    <div>
                        <div className="hsp-sidebar-title">HSP Studio</div>
                        <div className="hsp-sidebar-sub">Hansen workbench</div>
                    </div>
                </div>
                <nav className="hsp-sidebar-nav">
                    {NAV_ITEMS.map(({ id, label, icon: Icon, desc }) => (
                        <button
                            key={id}
                            className={`hsp-nav-item ${tab === id ? 'hsp-nav-item--active' : ''}`}
                            onClick={() => setTab(id)}
                            title={desc}
                        >
                            <Icon size={16} />
                            <span className="hsp-nav-label">{label}</span>
                        </button>
                    ))}
                </nav>
                <div className="hsp-sidebar-foot">
                    <button className="hsp-btn hsp-btn--ghost hsp-btn--block" onClick={() => fileInputRef.current?.click()}>
                        <Upload size={13} /> Import HSD
                    </button>
                    <button className="hsp-btn hsp-btn--ghost hsp-btn--block" onClick={exportHsd}>
                        <Download size={13} /> Export HSD
                    </button>
                    <button className="hsp-btn hsp-btn--ghost hsp-btn--block" onClick={() => setWizardOpen(true)}>
                        <GraduationCap size={13} /> Tutorial
                    </button>
                </div>
            </aside>

            <div className="hsp-workspace">
            <div className="hsp-toolbar hsp-toolbar--modern">
                <div className="hsp-toolbar-group">
                    <span className="hsp-label">Material</span>
                    <select
                        className="hsp-select"
                        value={selectedPolymerName}
                        onChange={(e) => setSelectedPolymerName(e.target.value)}
                        style={{ minWidth: 200 }}
                    >
                        <option value="Custom polymer">Custom ({customSphere.name})</option>
                        {HSP_POLYMER_SPHERES.map((p) => (
                            <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                    </select>
                </div>
                <div className="hsp-toolbar-group">
                    <Thermometer size={14} className="hsp-toolbar-icon" />
                    <input type="range" min={-20} max={120} value={temperatureC}
                        onChange={(e) => setTemperatureC(parseFloat(e.target.value))}
                        className="hsp-temp-slider" />
                    <span className="hsp-label">{temperatureC}°C</span>
                </div>
                <div className="hsp-toolbar-spacer" />
                <span className="hsp-stat-pill">{allSolvents.length} solvents</span>
                <button className="hsp-btn hsp-btn--ghost" onClick={exportProject}>
                    <FileUp size={13} /> Save project
                </button>
                <button className="hsp-btn hsp-btn--ghost" onClick={() => setReferenceOpen(true)}>
                    <BookOpen size={13} /> Docs
                </button>
            </div>

            <div className="hsp-main">
                {tab === 'view' && (
                    <ViewTab
                        viewPoints={viewPoints}
                        viewSpheres={viewSpheres}
                        sphere={resolvedSphere}
                        customSphere={customSphere}
                        setCustomSphere={setCustomSphere}
                        selectedPolymerName={selectedPolymerName}
                        highlightSolventName={highlightSolventName}
                        setHighlightSolventName={setHighlightSolventName}
                        allSolvents={allSolvents}
                    />
                )}
                {tab === 'db' && (
                    <DatabaseTab
                        filteredDb={filteredDb}
                        totalCount={allSolvents.length}
                        dbQuery={dbQuery}
                        setDbQuery={setDbQuery}
                        dbCategory={dbCategory}
                        setDbCategory={setDbCategory}
                        dbInsideOnly={dbInsideOnly}
                        setDbInsideOnly={setDbInsideOnly}
                        sphere={resolvedSphere}
                        sortToggle={sortToggle}
                        dbSort={dbSort}
                        highlightSolventName={highlightSolventName}
                        setHighlightSolventName={setHighlightSolventName}
                    />
                )}
                {tab === 'fit' && (
                    <SphereFitTab
                        fitRows={fitRows}
                        fitMode={fitMode}
                        setFitMode={setFitMode}
                        fitEngine={fitEngine}
                        setFitEngine={setFitEngine}
                        addFitRow={addFitRow}
                        updateFitRow={updateFitRow}
                        removeFitRow={removeFitRow}
                        runSphereFit={runSphereFit}
                        fitResult={fitResult}
                        applyFitToCustom={applyFitToCustom}
                        sphere={resolvedSphere}
                        viewPoints={viewPoints}
                        viewSpheres={viewSpheres}
                        allSolvents={allSolvents}
                    />
                )}
                {tab === 'suggest' && (
                    <SuggestTab
                        suggested={suggestedSolvents}
                        suggestZone={suggestZone}
                        setSuggestZone={setSuggestZone}
                        suggestMaxRED={suggestMaxRED}
                        setSuggestMaxRED={setSuggestMaxRED}
                        sphere={resolvedSphere}
                        setBlendSolventNames={setBlendSolventNames}
                        setTab={setTab}
                        allSolvents={allSolvents}
                        blendTarget={blendTarget}
                        setBlendTarget={setBlendTarget}
                    />
                )}
                {tab === 'blend' && (
                    <BlendTab
                        blendSolventNames={blendSolventNames}
                        addBlendSolvent={addBlendSolvent}
                        updateBlendSolvent={updateBlendSolvent}
                        removeBlendSolvent={removeBlendSolvent}
                        blendTarget={blendTarget}
                        setBlendTarget={setBlendTarget}
                        setTargetFromSphere={setTargetFromSphere}
                        runBlend={runBlend}
                        blendResult={blendResult}
                        blendCandidates={blendCandidates}
                        exportBlendCsv={exportBlendCsv}
                        sphere={resolvedSphere}
                        allSolvents={allSolvents}
                    />
                )}
                {tab === 'evap' && (
                    <EvaporationTab
                        blendCandidates={blendCandidates}
                        blendResult={blendResult}
                        evapFraction={evapFraction}
                        setEvapFraction={setEvapFraction}
                        runEvaporation={runEvaporation}
                        evapHistory={evapHistory}
                        sphere={resolvedSphere}
                        runBlend={runBlend}
                    />
                )}
                {tab === 'red' && (
                    <REDTab
                        redSolventName={redSolventName}
                        setRedSolventName={setRedSolventName}
                        redSolvent={redSolvent}
                        redResult={redResult}
                        sphere={resolvedSphere}
                        allSolvents={allSolvents}
                    />
                )}
                {tab === 'calc' && (
                    <CalculatorTab
                        calcMode={calcMode}
                        setCalcMode={setCalcMode}
                        calcSmiles={calcSmiles}
                        setCalcSmiles={setCalcSmiles}
                        calcGroups={calcGroups}
                        updateGroupCount={updateGroupCount}
                        addGroupRow={addGroupRow}
                        calcUseSecondOrder={calcUseSecondOrder}
                        setCalcUseSecondOrder={setCalcUseSecondOrder}
                        calcSymmetry={calcSymmetry}
                        setCalcSymmetry={setCalcSymmetry}
                        calcNMer={calcNMer}
                        setCalcNMer={setCalcNMer}
                        calcPolymerName={calcPolymerName}
                        loadPolymerTemplate={loadPolymerTemplate}
                        calcPhysical={calcPhysical}
                        setCalcPhysical={setCalcPhysical}
                        calcBoilingPointC={calcBoilingPointC}
                        setCalcBoilingPointC={setCalcBoilingPointC}
                        runHspCalculator={runHspCalculator}
                        parseSmilesToGroups={parseSmilesToGroups}
                        calcResults={calcResults}
                        calcSelectedMethod={calcSelectedMethod}
                        setCalcSelectedMethod={setCalcSelectedMethod}
                        applyCalcToCustomSphere={applyCalcToCustomSphere}
                        applyCalcAndFindSolvents={applyCalcAndFindSolvents}
                    />
                )}
            </div>
            </div>

            <HspTutorial
                open={wizardOpen}
                onClose={() => setWizardOpen(false)}
                actions={{
                    setTab,
                    setSelectedPolymerName,
                    setCustomSphere,
                    setHighlightSolventName,
                    setRedSolventName,
                    setBlendSolventNames,
                    setBlendTarget,
                    setFitRows,
                    setTargetFromSphere,
                    runSphereFit,
                    applyFitToCustom,
                    runBlend,
                    loadProject,
                    collectProject,
                    openReference: () => setReferenceOpen(true),
                }}
            />

            {referenceOpen && (
                <ReferenceModal onClose={() => setReferenceOpen(false)} />
            )}
        </div>
    );
}

/* -------------------------------------------------------------- */
/*  Static reference modal — the markdown tutorial.               */
/*  Portalled to <body> so the sidebar / page layout can't clip   */
/*  it (that was the original "tutorial overlapping sidebar" bug).*/
/* -------------------------------------------------------------- */
function ReferenceModal({ onClose }) {
    /* Close on Escape; trap focus to the close button so screen-readers
       land on a sensible control. */
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const downloadMd = useCallback(() => {
        const blob = new Blob([tutorialMarkdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hsp_studio_polymer_cb_sensor_tutorial.md';
        a.click();
        URL.revokeObjectURL(url);
    }, []);

    return createPortal(
        <div
            className="hsp-modal-backdrop"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            role="dialog"
            aria-modal="true"
            aria-label="HSP Studio reference"
        >
            <div className="hsp-modal">
                <div className="hsp-modal-head">
                    <span className="hsp-modal-title">
                        <BookOpen size={15} aria-hidden /> HSP Studio — Polymer / CB VOC-Sensor Reference
                    </span>
                    <div className="hsp-modal-spacer" />
                    <button
                        className="hsp-btn hsp-btn--ghost"
                        onClick={downloadMd}
                        title="Save the reference as a Markdown file"
                    >
                        <Download size={13} /> Save .md
                    </button>
                    <button
                        className="hsp-modal-close"
                        onClick={onClose}
                        title="Close (Esc)"
                        aria-label="Close reference"
                    >
                        <CloseIcon size={18} />
                    </button>
                </div>
                <div className="hsp-modal-body">
                    {renderMarkdown(tutorialMarkdown)}
                </div>
            </div>
        </div>,
        document.body
    );
}

/* -------------------------------------------------------------- */
/*  3-D View tab                                                 */
/* -------------------------------------------------------------- */
function ViewTab({
    viewPoints, viewSpheres, sphere, customSphere, setCustomSphere,
    selectedPolymerName, highlightSolventName, setHighlightSolventName, allSolvents,
}) {
    const totalSolvent = useMemo(() => hspTotal(sphere), [sphere]);
    return (
        <>
            <div className="hsp-section">
                <h3 className="hsp-section-title">3-D HSP Space</h3>
                <div className="hsp-section-sub">
                    Each dot is a solvent. The wire sphere is the polymer's solubility envelope —
                    solvents inside (green) are predicted to dissolve the polymer (RED &lt; 1);
                    outside (red) are predicted insoluble.
                </div>
                <HspSphereView
                    points={viewPoints}
                    spheres={viewSpheres}
                    height={460}
                    highlightName={highlightSolventName}
                />
            </div>

            <div className="hsp-grid-2">
                <div className="hsp-section">
                    <h3 className="hsp-section-title">Active sphere</h3>
                    <div className="hsp-readout">
                        <Cell label="δD" value={`${sphere.dD.toFixed(1)} MPa½`} />
                        <Cell label="δP" value={`${sphere.dP.toFixed(1)} MPa½`} />
                        <Cell label="δH" value={`${sphere.dH.toFixed(1)} MPa½`} />
                        <Cell label="R"  value={`${sphere.R.toFixed(1)} MPa½`} />
                        {sphere.R_outer && (
                            <Cell label="R_outer" value={`${sphere.R_outer.toFixed(1)} MPa½`} />
                        )}
                        <Cell label="δt (Hildebrand)" value={`${totalSolvent.toFixed(1)} MPa½`} />
                        <Cell label="Solvents inside"
                            value={viewPoints.filter((p) => p.score === 1).length} />
                    </div>
                </div>
                {selectedPolymerName === 'Custom polymer' && (
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Custom polymer editor</h3>
                        <div className="hsp-section-sub">
                            Tune these to model your own resin and watch the sphere envelope shrink
                            or expand around the solvent cloud.
                        </div>
                        <NumberField label="δD₀"
                            value={customSphere.dD}
                            onChange={(v) => setCustomSphere((s) => ({ ...s, dD: v }))}
                            min={5} max={30} step={0.1} />
                        <NumberField label="δP₀"
                            value={customSphere.dP}
                            onChange={(v) => setCustomSphere((s) => ({ ...s, dP: v }))}
                            min={0} max={25} step={0.1} />
                        <NumberField label="δH₀"
                            value={customSphere.dH}
                            onChange={(v) => setCustomSphere((s) => ({ ...s, dH: v }))}
                            min={0} max={45} step={0.1} />
                        <NumberField label="R"
                            value={customSphere.R}
                            onChange={(v) => setCustomSphere((s) => ({ ...s, R: v }))}
                            min={0.5} max={25} step={0.1} />
                        <NumberField label="R_outer (marginal)"
                            value={customSphere.R_outer ?? customSphere.R * 1.3}
                            onChange={(v) => setCustomSphere((s) => ({ ...s, R_outer: v, doubleSphere: true }))}
                            min={0.5} max={30} step={0.1} />
                    </div>
                )}
                <div className="hsp-section">
                    <h3 className="hsp-section-title">Solvent highlight</h3>
                    <div className="hsp-row">
                        <span className="hsp-label">Pick</span>
                        <select
                            className="hsp-select hsp-input--wide"
                            value={highlightSolventName ?? ''}
                            onChange={(e) => setHighlightSolventName(e.target.value || null)}
                        >
                            <option value="">— none —</option>
                            {allSolvents.map((s) => (
                                <option key={s.name} value={s.name}>{s.name}</option>
                            ))}
                        </select>
                    </div>
                    {highlightSolventName && (() => {
                        const s = findSolventByName(highlightSolventName);
                        if (!s) return null;
                        const RED = hspRED(s, sphere);
                        const Ra = hspRa(s, sphere);
                        return (
                            <div className="hsp-readout">
                                <Cell label="δD" value={s.dD.toFixed(1)} />
                                <Cell label="δP" value={s.dP.toFixed(1)} />
                                <Cell label="δH" value={s.dH.toFixed(1)} />
                                <Cell label="Ra"  value={Ra.toFixed(2)} />
                                <Cell label="RED" value={RED.toFixed(3)}
                                    pill={RED <= 1 ? 'good' : 'bad'} />
                                <Cell label="BP" value={`${s.bp} °C`} />
                            </div>
                        );
                    })()}
                </div>
            </div>
        </>
    );
}

/* -------------------------------------------------------------- */
/*  Database tab                                                 */
/* -------------------------------------------------------------- */
function DatabaseTab({
    filteredDb, totalCount, dbQuery, setDbQuery, dbCategory, setDbCategory,
    dbInsideOnly, setDbInsideOnly,
    sphere, sortToggle, dbSort,
    highlightSolventName, setHighlightSolventName,
}) {
    const cols = [
        { key: 'name',     label: 'Solvent' },
        { key: 'category', label: 'Class' },
        { key: 'dD',       label: 'δD' },
        { key: 'dP',       label: 'δP' },
        { key: 'dH',       label: 'δH' },
        { key: 'mw',       label: 'MW' },
        { key: 'density',  label: 'ρ (g/cm³)' },
        { key: 'bp',       label: 'BP (°C)' },
        { key: 'rer',      label: 'RER' },
    ];
    return (
        <div className="hsp-section">
            <h3 className="hsp-section-title">Solvent Database</h3>
            <div className="hsp-section-sub">
                Reference HSP for {filteredDb.length} of {totalCount} solvents.
                Click a row to highlight in 3D. RED is vs the active sphere.
            </div>
            <div className="hsp-row">
                <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
                    <Search
                        size={13}
                        style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }}
                    />
                    <input
                        className="hsp-input hsp-input--wide"
                        placeholder="Search by name, CAS, or class…"
                        value={dbQuery}
                        onChange={(e) => setDbQuery(e.target.value)}
                        style={{ paddingLeft: 26, width: '100%' }}
                    />
                </div>
                <select
                    className="hsp-select"
                    value={dbCategory}
                    onChange={(e) => setDbCategory(e.target.value)}
                    title="Filter by chemical class"
                >
                    <option value="all">All classes</option>
                    {HSP_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                    ))}
                </select>
                <label className="hsp-calc-check">
                    <input type="checkbox" checked={dbInsideOnly}
                        onChange={(e) => setDbInsideOnly(e.target.checked)} />
                    Inside sphere only
                </label>
            </div>
            <div className="hsp-table-wrap">
                <table className="hsp-table">
                    <thead>
                        <tr>
                            {cols.map((c) => (
                                <th key={c.key} onClick={sortToggle(c.key)} style={{ cursor: 'pointer' }}>
                                    {c.label}{dbSort.col === c.key ? (dbSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                                </th>
                            ))}
                            <th>RED</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredDb.map((s) => {
                            const RED = hspRED(s, sphere);
                            const inside = RED <= 1;
                            const sel = highlightSolventName === s.name;
                            return (
                                <tr
                                    key={s.name}
                                    onClick={() => setHighlightSolventName(s.name)}
                                    className={sel ? 'is-selected' : ''}
                                    title={`Click to highlight ${s.name} in the 3D viewer`}
                                >
                                    <td>{s.name}</td>
                                    <td><span className="hsp-pill">{s.category}</span></td>
                                    <td>{s.dD.toFixed(1)}</td>
                                    <td>{s.dP.toFixed(1)}</td>
                                    <td>{s.dH.toFixed(1)}</td>
                                    <td>{s.mw.toFixed(2)}</td>
                                    <td>{s.density.toFixed(3)}</td>
                                    <td>{s.bp}</td>
                                    <td>{s.rer.toFixed(2)}</td>
                                    <td>
                                        <span className={`hsp-pill ${inside ? 'hsp-pill--inside' : 'hsp-pill--neutral'}`}>
                                            {RED.toFixed(2)}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                        {filteredDb.length === 0 && (
                            <tr>
                                <td colSpan={cols.length + 1} style={{ color: '#94a3b8', padding: 12 }}>
                                    No solvents match those filters.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/* -------------------------------------------------------------- */
/*  Sphere Fit tab                                               */
/* -------------------------------------------------------------- */
function SphereFitTab({
    fitRows, fitMode, setFitMode, fitEngine, setFitEngine,
    addFitRow, updateFitRow, removeFitRow,
    runSphereFit, fitResult, applyFitToCustom,
    sphere, viewPoints, viewSpheres, allSolvents,
}) {
    /* Annotate each fit row with resolved HSP (from the database if the
       name is recognised), so the user can paste a name and immediately
       see the numbers without retyping them. */
    const rowsResolved = useMemo(() => fitRows.map((r) => {
        const s = findSolventByName(r.name) || allSolvents.find((x) => x.name === r.name);
        return {
            ...r,
            dD: r.dD ?? s?.dD ?? '',
            dP: r.dP ?? s?.dP ?? '',
            dH: r.dH ?? s?.dH ?? '',
        };
    }), [fitRows, allSolvents]);

    return (
        <>
            <div className="hsp-section">
                <h3 className="hsp-section-title">Sphere fit — Yes/No solubility data</h3>
                <div className="hsp-section-sub">
                    Tag solvents as <strong>Good (2)</strong>, <strong>Marginal (1)</strong>, or{' '}
                    <strong>Bad (0)</strong>. Choose single, concentric double, or dual-sphere fit (HSPiPy-style).
                </div>
                <div className="hsp-calc-mode-row">
                    {[
                        ['single', 'Single sphere'],
                        ['double', 'Double (Ri/Ro)'],
                        ['dual', 'Dual centres'],
                    ].map(([id, label]) => (
                        <button key={id}
                            className={`hsp-btn ${fitMode === id ? 'hsp-btn--primary' : 'hsp-btn--ghost'}`}
                            onClick={() => setFitMode(id)}>
                            {label}
                        </button>
                    ))}
                </div>
                {fitMode !== 'dual' && (
                    <div className="hsp-row" style={{ marginBottom: 8 }}>
                        <span className="hsp-label">Solver</span>
                        {[
                            ['gradient', 'Fast (gradient)'],
                            ['de', 'Global (DE)'],
                        ].map(([id, label]) => (
                            <button key={id}
                                className={`hsp-btn ${fitEngine === id ? 'hsp-btn--primary' : 'hsp-btn--ghost'}`}
                                onClick={() => setFitEngine(id)}
                                title={id === 'de'
                                    ? 'Differential evolution — better for noisy or split datasets (HSPiPy-style)'
                                    : 'Coordinate descent — fast default'}>
                                {label}
                            </button>
                        ))}
                    </div>
                )}
                <div className="hsp-yn-list">
                    <div className="hsp-yn-row" style={{ color: '#94a3b8', fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        <div>Solvent</div>
                        <div>δD</div>
                        <div>δP</div>
                        <div>δH</div>
                        <div>Score</div>
                        <div />
                    </div>
                    {rowsResolved.map((r, i) => {
                        const sc = Number(r.score);
                        const label = sc >= 2 ? 'Good' : sc >= 1 ? 'Marginal' : 'Bad';
                        const cls = sc >= 2 ? 'good' : sc >= 1 ? 'marginal' : 'bad';
                        return (
                            <div key={i} className="hsp-yn-row">
                                <input
                                    className="hsp-input"
                                    list="hsp-solvent-list"
                                    placeholder="Solvent name"
                                    value={r.name || ''}
                                    onChange={(e) => updateFitRow(i, { name: e.target.value, dD: undefined, dP: undefined, dH: undefined })}
                                />
                                <input className="hsp-input hsp-input--num" type="number" step="0.1"
                                    value={r.dD} onChange={(e) => updateFitRow(i, { dD: parseFloat(e.target.value) })} />
                                <input className="hsp-input hsp-input--num" type="number" step="0.1"
                                    value={r.dP} onChange={(e) => updateFitRow(i, { dP: parseFloat(e.target.value) })} />
                                <input className="hsp-input hsp-input--num" type="number" step="0.1"
                                    value={r.dH} onChange={(e) => updateFitRow(i, { dH: parseFloat(e.target.value) })} />
                                <button
                                    className={`hsp-yn-toggle hsp-yn-toggle--${cls}`}
                                    onClick={() => updateFitRow(i, { score: (sc + 2) % 3 })}
                                    title="Cycle Good → Marginal → Bad"
                                >
                                    {label}
                                </button>
                                <button className="hsp-icon-btn" onClick={() => removeFitRow(i)} title="Remove row">
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        );
                    })}
                </div>
                <datalist id="hsp-solvent-list">
                    {allSolvents.map((s) => <option key={s.name} value={s.name} />)}
                </datalist>
                <div className="hsp-row" style={{ marginTop: 10 }}>
                    <button className="hsp-btn hsp-btn--ghost" onClick={addFitRow}>
                        <Plus size={13} /> Add row
                    </button>
                    <button className="hsp-btn hsp-btn--primary" onClick={runSphereFit}>
                        <Wand2 size={13} /> Fit sphere
                    </button>
                    {fitResult && (
                        <button className="hsp-btn" onClick={applyFitToCustom}>
                            <Zap size={13} /> Use as active sphere
                        </button>
                    )}
                </div>
            </div>

            {fitResult && (
                <div className="hsp-grid-2">
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Fit result</h3>
                        {fitResult.spheres ? (
                            <div className="hsp-readout">
                                {fitResult.spheres.map((s, i) => (
                                    <React.Fragment key={i}>
                                        <Cell label={`Sphere ${s.label || String.fromCharCode(65 + i)} δD₀`} value={s.dD.toFixed(2)} />
                                        <Cell label="δP₀" value={s.dP.toFixed(2)} />
                                        <Cell label="δH₀" value={s.dH.toFixed(2)} />
                                        <Cell label="R" value={s.R.toFixed(2)} />
                                    </React.Fragment>
                                ))}
                                <Cell label="Fit (0–1)" value={fitResult.fit.toFixed(3)} />
                                {fitResult.mode && <Cell label="Mode" value={fitResult.mode} />}
                            </div>
                        ) : (
                            <div className="hsp-readout">
                                <Cell label="δD₀" value={fitResult.center.dD.toFixed(2)} />
                                <Cell label="δP₀" value={fitResult.center.dP.toFixed(2)} />
                                <Cell label="δH₀" value={fitResult.center.dH.toFixed(2)} />
                                <Cell label="R" value={(fitResult.R_inner ?? fitResult.R)?.toFixed?.(2) ?? fitResult.R} />
                                {fitResult.R_outer && (
                                    <Cell label="R_outer" value={fitResult.R_outer.toFixed(2)} />
                                )}
                                <Cell label="Fit (0–1)" value={fitResult.fit.toFixed(3)} />
                                <Cell label="Miscl." value={fitResult.misclassified ?? fitResult.misclassifiedGood ?? 0} />
                                {fitResult.misclassifiedBad != null && (
                                    <Cell label="Miscl. bad" value={fitResult.misclassifiedBad} />
                                )}
                                {fitResult.iterations != null && (
                                    <Cell label="Iters" value={fitResult.iterations} />
                                )}
                                {fitResult.engine && (
                                    <Cell label="Solver" value={fitResult.engine} />
                                )}
                            </div>
                        )}
                    </div>
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Fit visualised</h3>
                        <HspSphereView
                            points={viewPoints}
                            spheres={viewSpheres}
                            height={360}
                        />
                    </div>
                </div>
            )}
        </>
    );
}

/* -------------------------------------------------------------- */
/*  Blend Optimizer tab                                          */
/* -------------------------------------------------------------- */
function BlendTab({
    blendSolventNames, addBlendSolvent, updateBlendSolvent, removeBlendSolvent,
    blendTarget, setBlendTarget, setTargetFromSphere,
    runBlend, blendResult, blendCandidates, exportBlendCsv, sphere, allSolvents,
}) {
    return (
        <>
            <div className="hsp-section">
                <h3 className="hsp-section-title">Blend optimizer</h3>
                <div className="hsp-section-sub">
                    Pick up to {MAX_BLEND_SOLVENTS} solvents and a target HSP (typically the
                    centre of your polymer's sphere). The solver returns the volume fractions{' '}
                    <strong>φᵢ</strong> that minimise Ra to the target.
                </div>
                <div className="hsp-row">
                    <span className="hsp-label">Target δD</span>
                    <input className="hsp-input hsp-input--num" type="number" step="0.1"
                        value={blendTarget.dD}
                        onChange={(e) => setBlendTarget((t) => ({ ...t, dD: parseFloat(e.target.value) || 0 }))} />
                    <span className="hsp-label">δP</span>
                    <input className="hsp-input hsp-input--num" type="number" step="0.1"
                        value={blendTarget.dP}
                        onChange={(e) => setBlendTarget((t) => ({ ...t, dP: parseFloat(e.target.value) || 0 }))} />
                    <span className="hsp-label">δH</span>
                    <input className="hsp-input hsp-input--num" type="number" step="0.1"
                        value={blendTarget.dH}
                        onChange={(e) => setBlendTarget((t) => ({ ...t, dH: parseFloat(e.target.value) || 0 }))} />
                    <button className="hsp-btn hsp-btn--ghost" onClick={setTargetFromSphere}
                        title="Copy the active sphere's centre into the target fields">
                        <Beaker size={13} /> Use active sphere
                    </button>
                </div>

                <div className="hsp-blend-row hsp-blend-row--header">
                    <div>Solvent</div>
                    <div>δD</div>
                    <div>δP</div>
                    <div>δH</div>
                    <div>φ (vol frac)</div>
                    <div>%</div>
                    <div />
                </div>
                {blendSolventNames.map((name, i) => {
                    const s = findSolventByName(name) || allSolvents.find((x) => x.name === name);
                    const phi = blendResult?.phi?.[i] ?? 0;
                    return (
                        <div key={i} className="hsp-blend-row">
                            <select className="hsp-select" value={name}
                                onChange={(e) => updateBlendSolvent(i, e.target.value)}>
                                {allSolvents.map((opt) => (
                                    <option key={opt.name} value={opt.name}>{opt.name}</option>
                                ))}
                            </select>
                            <div>{s ? s.dD.toFixed(1) : '—'}</div>
                            <div>{s ? s.dP.toFixed(1) : '—'}</div>
                            <div>{s ? s.dH.toFixed(1) : '—'}</div>
                            <div>
                                {phi.toFixed(3)}
                                <div className="hsp-blend-bar">
                                    <div className="hsp-blend-bar-fill" style={{ width: `${Math.min(100, phi * 100)}%` }} />
                                </div>
                            </div>
                            <div>{(phi * 100).toFixed(1)}%</div>
                            <button className="hsp-icon-btn" onClick={() => removeBlendSolvent(i)}
                                title="Remove solvent">
                                <Trash2 size={13} />
                            </button>
                        </div>
                    );
                })}
                <div className="hsp-row" style={{ marginTop: 8 }}>
                    <button className="hsp-btn hsp-btn--ghost" onClick={addBlendSolvent}
                        disabled={blendSolventNames.length >= MAX_BLEND_SOLVENTS}>
                        <Plus size={13} /> Add solvent
                    </button>
                    <button className="hsp-btn hsp-btn--primary" onClick={runBlend}
                        disabled={blendSolventNames.length === 0}>
                        <CalcIcon size={13} /> Optimise blend
                    </button>
                    {blendResult && blendResult.phi.length > 0 && (
                        <button className="hsp-btn" onClick={exportBlendCsv}>
                            <Download size={13} /> Export CSV
                        </button>
                    )}
                </div>
                {blendSolventNames.length === 0 && (
                    <div className="hsp-warn" style={{ marginTop: 8 }}>
                        Add at least one solvent to optimise a blend.
                    </div>
                )}
            </div>

            {blendResult && blendCandidates.length > 0 && (
                <div className="hsp-grid-2">
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Blend HSP</h3>
                        <div className="hsp-readout">
                            <Cell label="Blend δD" value={blendResult.blend.dD.toFixed(2)} />
                            <Cell label="Blend δP" value={blendResult.blend.dP.toFixed(2)} />
                            <Cell label="Blend δH" value={blendResult.blend.dH.toFixed(2)} />
                            <Cell label="Target δD" value={blendTarget.dD.toFixed(2)} />
                            <Cell label="Target δP" value={blendTarget.dP.toFixed(2)} />
                            <Cell label="Target δH" value={blendTarget.dH.toFixed(2)} />
                            <Cell label="Ra (to target)" value={blendResult.Ra.toFixed(3)}
                                pill={blendResult.Ra <= sphere.R ? 'good' : 'bad'} />
                        </div>
                    </div>
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Mix recipe (100 g basis)</h3>
                        <table className="hsp-table">
                            <thead>
                                <tr>
                                    <th>Solvent</th>
                                    <th>φ</th>
                                    <th>%vol</th>
                                    <th>g / 100 g</th>
                                </tr>
                            </thead>
                            <tbody>
                                {blendCandidates.map((s, i) => {
                                    const phi = blendResult.phi[i] ?? 0;
                                    /* Convert volume fraction → mass per 100 g of total mixture.
                                       basis 100 g total → solve total volume by Σ phi*ρ*Vtot = 100. */
                                    const denomTotal = blendCandidates.reduce(
                                        (s2, c, j) => s2 + (blendResult.phi[j] ?? 0) * c.density, 0);
                                    const grams = denomTotal > 0 ? (phi * s.density / denomTotal) * 100 : 0;
                                    return (
                                        <tr key={s.name}>
                                            <td>{s.name}</td>
                                            <td>{phi.toFixed(3)}</td>
                                            <td>{(phi * 100).toFixed(1)}%</td>
                                            <td>{grams.toFixed(2)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </>
    );
}

/* -------------------------------------------------------------- */
/*  HSP Calculator tab (HSPiP-style DIY)                         */
/* -------------------------------------------------------------- */
function CalculatorTab({
    calcMode, setCalcMode,
    calcSmiles, setCalcSmiles,
    calcGroups, updateGroupCount, addGroupRow,
    calcUseSecondOrder, setCalcUseSecondOrder,
    calcSymmetry, setCalcSymmetry,
    calcNMer, setCalcNMer,
    calcPolymerName, loadPolymerTemplate,
    calcPhysical, setCalcPhysical,
    calcBoilingPointC, setCalcBoilingPointC,
    runHspCalculator, parseSmilesToGroups,
    calcResults, calcSelectedMethod, setCalcSelectedMethod,
    applyCalcToCustomSphere, applyCalcAndFindSolvents,
}) {
    const [newGroupName, setNewGroupName] = useState('CH3');
    const [copolyA, setCopolyA] = useState(HSP_POLYMER_MONOMERS[0]?.repeatSmiles ?? '0CC0');
    const [copolyB, setCopolyB] = useState(HSP_POLYMER_MONOMERS[2]?.repeatSmiles ?? '0CC(c1ccccc1)0');
    const [copolyPattern, setCopolyPattern] = useState('AB');

    const groupRows = useMemo(
        () => Object.entries(calcGroups).sort(([a], [b]) => a.localeCompare(b)),
        [calcGroups]
    );

    const selectedResult = useMemo(() => {
        if (!calcResults?.results?.length) return null;
        return calcResults.results.find((r) => r.method === calcSelectedMethod)
            || calcResults.results[0];
    }, [calcResults, calcSelectedMethod]);

    const teas = useMemo(
        () => (selectedResult ? hspToTeas(selectedResult) : null),
        [selectedResult]
    );

    const buildCopolymer = useCallback(() => {
        const smi = buildCopolymerSmiles(copolyA, copolyB, copolyPattern);
        setCalcSmiles(smi);
        setCalcMode('polymer');
    }, [copolyA, copolyB, copolyPattern, setCalcSmiles, setCalcMode]);

    return (
        <>
            <div className="hsp-section">
                <h3 className="hsp-section-title">HSP Calculator — estimate δD, δP, δH</h3>
                <div className="hsp-section-sub">
                    HSPiP-style DIY calculator: enter a <strong>SMILES</strong> string or edit
                    UNIFAC groups manually, then compare estimates from Stefanis–Panayiotou,
                    van Krevelen, Hansen/Beerbower, Hoy, and physical-property correlations.
                    For polymers, pick a repeat unit and set the oligomer length (n-mer).
                </div>

                <div className="hsp-calc-mode-row">
                    <button
                        className={`hsp-btn ${calcMode === 'molecule' ? 'hsp-btn--primary' : 'hsp-btn--ghost'}`}
                        onClick={() => setCalcMode('molecule')}
                    >Small molecule</button>
                    <button
                        className={`hsp-btn ${calcMode === 'polymer' ? 'hsp-btn--primary' : 'hsp-btn--ghost'}`}
                        onClick={() => setCalcMode('polymer')}
                    >Polymer repeat unit</button>
                </div>
            </div>

            <div className="hsp-grid-2">
                <div className="hsp-section">
                    <h3 className="hsp-section-title">Structure input</h3>
                    {calcMode === 'polymer' && (
                        <>
                            <div className="hsp-row">
                                <span className="hsp-label">Polymer library</span>
                                <select
                                    className="hsp-select hsp-input--wide"
                                    value={calcPolymerName}
                                    onChange={(e) => loadPolymerTemplate(e.target.value)}
                                >
                                    {HSP_POLYMER_MONOMERS.map((p) => (
                                        <option key={p.name} value={p.name}>{p.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="hsp-row">
                                <span className="hsp-label">n-mer</span>
                                <input type="range" min={1} max={8} step={1} value={calcNMer}
                                    onChange={(e) => setCalcNMer(parseInt(e.target.value, 10))}
                                    style={{ flex: 1 }} />
                                <span className="hsp-label">{calcNMer}</span>
                            </div>
                        </>
                    )}
                    <div className="hsp-row">
                        <span className="hsp-label">SMILES</span>
                        <input
                            className="hsp-input hsp-input--wide hsp-calc-smiles"
                            value={calcSmiles}
                            onChange={(e) => setCalcSmiles(e.target.value)}
                            placeholder="e.g. CCO, 0CC0 (PE repeat unit)"
                            spellCheck={false}
                        />
                    </div>
                    <div className="hsp-row hsp-calc-examples">
                        <span className="hsp-label">Examples</span>
                        <div className="hsp-calc-example-chips">
                            {Object.entries(SMILES_EXAMPLES).slice(0, 6).map(([smi, label]) => (
                                <button
                                    key={smi}
                                    className="hsp-btn hsp-btn--ghost hsp-calc-chip"
                                    onClick={() => setCalcSmiles(smi)}
                                    title={label}
                                >{label}</button>
                            ))}
                        </div>
                    </div>
                    <div className="hsp-row">
                        <button className="hsp-btn hsp-btn--ghost" onClick={parseSmilesToGroups}>
                            <Copy size={13} /> Parse SMILES → groups
                        </button>
                        <button className="hsp-btn hsp-btn--primary" onClick={runHspCalculator}>
                            <CalcIcon size={13} /> Calculate HSP
                        </button>
                    </div>

                    {calcMode === 'polymer' && (
                        <div className="hsp-calc-copoly">
                            <div className="hsp-section-sub" style={{ marginTop: 8 }}>Co-polymer builder (HSPiP CP)</div>
                            <div className="hsp-row">
                                <select className="hsp-select" value={copolyA}
                                    onChange={(e) => setCopolyA(e.target.value)}>
                                    {HSP_POLYMER_MONOMERS.map((p) => (
                                        <option key={p.abbrev} value={p.repeatSmiles}>{p.abbrev}</option>
                                    ))}
                                </select>
                                <span>+</span>
                                <select className="hsp-select" value={copolyB}
                                    onChange={(e) => setCopolyB(e.target.value)}>
                                    {HSP_POLYMER_MONOMERS.map((p) => (
                                        <option key={p.abbrev + 'b'} value={p.repeatSmiles}>{p.abbrev}</option>
                                    ))}
                                </select>
                                <select className="hsp-select" value={copolyPattern}
                                    onChange={(e) => setCopolyPattern(e.target.value)}>
                                    <option value="AB">AB</option>
                                    <option value="AABB">AABB</option>
                                    <option value="AAABBB">AAABBB</option>
                                </select>
                                <button className="hsp-btn hsp-btn--ghost" onClick={buildCopolymer}>Build</button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="hsp-section">
                    <h3 className="hsp-section-title">Physical properties (Method 1)</h3>
                    <div className="hsp-section-sub">Optional — δTot from ΔHv, δP from dipole, δD from RI</div>
                    <div className="hsp-calc-phys-grid">
                        <label>ΔHv (kJ/mol)
                            <input className="hsp-input hsp-input--num" type="number" step="0.1"
                                value={calcPhysical.enthalpyVap}
                                onChange={(e) => setCalcPhysical((p) => ({ ...p, enthalpyVap: e.target.value }))} />
                        </label>
                        <label>Molar vol (cm³/mol)
                            <input className="hsp-input hsp-input--num" type="number" step="0.1"
                                value={calcPhysical.molarVolume}
                                onChange={(e) => setCalcPhysical((p) => ({ ...p, molarVolume: e.target.value }))} />
                        </label>
                        <label>Refractive index
                            <input className="hsp-input hsp-input--num" type="number" step="0.001"
                                value={calcPhysical.refractiveIndex}
                                onChange={(e) => setCalcPhysical((p) => ({ ...p, refractiveIndex: e.target.value }))} />
                        </label>
                        <label>Dipole (Debye)
                            <input className="hsp-input hsp-input--num" type="number" step="0.01"
                                value={calcPhysical.dipoleMoment}
                                onChange={(e) => setCalcPhysical((p) => ({ ...p, dipoleMoment: e.target.value }))} />
                        </label>
                        <label>Tb (°C, Hoy)
                            <input className="hsp-input hsp-input--num" type="number" step="1"
                                value={calcBoilingPointC}
                                onChange={(e) => setCalcBoilingPointC(e.target.value)}
                                placeholder="auto" />
                        </label>
                        <label>Symmetry planes
                            <select className="hsp-select" value={calcSymmetry}
                                onChange={(e) => setCalcSymmetry(parseInt(e.target.value, 10))}>
                                {SYMMETRY_OPTIONS.map((s) => (
                                    <option key={s.id} value={s.id}>{s.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                </div>
            </div>

            <div className="hsp-section">
                <h3 className="hsp-section-title">UNIFAC group counts (Stefanis–Panayiotou)</h3>
                <div className="hsp-row">
                    <label className="hsp-calc-check">
                        <input type="checkbox" checked={calcUseSecondOrder}
                            onChange={(e) => setCalcUseSecondOrder(e.target.checked)} />
                        Include 2nd-order groups
                    </label>
                    <select className="hsp-select" value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}>
                        {SP_GROUP_NAMES.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <button className="hsp-btn hsp-btn--ghost" onClick={() => addGroupRow(newGroupName)}>
                        <Plus size={13} /> Add group
                    </button>
                </div>
                <div className="hsp-calc-group-grid">
                    {groupRows.map(([name, count]) => (
                        <div key={name} className="hsp-calc-group-row">
                            <span className="hsp-calc-group-name" title={name}>{name}</span>
                            <input type="number" min={0} step={1} className="hsp-input hsp-input--num"
                                value={count}
                                onChange={(e) => updateGroupCount(name, e.target.value)} />
                            <button className="hsp-icon-btn" onClick={() => updateGroupCount(name, 0)}
                                title="Remove"><Trash2 size={12} /></button>
                        </div>
                    ))}
                    {groupRows.length === 0 && (
                        <div className="hsp-warn">No groups — parse SMILES or add groups manually.</div>
                    )}
                </div>
            </div>

            {calcResults && (
                <div className="hsp-grid-2">
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Method comparison</h3>
                        {calcResults.oligomerSmiles && calcMode === 'polymer' && (
                            <div className="hsp-section-sub">Oligomer SMILES: <code>{calcResults.oligomerSmiles}</code></div>
                        )}
                        {calcResults.parseWarnings?.length > 0 && (
                            <div className="hsp-warn">{calcResults.parseWarnings.join('; ')}</div>
                        )}
                        <div className="hsp-table-wrap">
                            <table className="hsp-table">
                                <thead>
                                    <tr>
                                        <th>Method</th>
                                        <th>δD</th>
                                        <th>δP</th>
                                        <th>δH</th>
                                        <th>δt</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {calcResults.results.map((r) => (
                                        <tr
                                            key={r.method}
                                            className={calcSelectedMethod === r.method ? 'is-selected' : ''}
                                            onClick={() => setCalcSelectedMethod(r.method)}
                                            style={{ cursor: 'pointer' }}
                                        >
                                            <td>{r.method}</td>
                                            <td>{r.dD.toFixed(2)}</td>
                                            <td>{r.dP.toFixed(2)}</td>
                                            <td>{r.dH.toFixed(2)}</td>
                                            <td>{(r.dT ?? 0).toFixed(2)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="hsp-row" style={{ marginTop: 8 }}>
                            <button className="hsp-btn hsp-btn--primary" onClick={applyCalcToCustomSphere}>
                                <Zap size={13} /> Use selected as active sphere
                            </button>
                            <button className="hsp-btn" onClick={applyCalcAndFindSolvents}>
                                <Sparkles size={13} /> Apply &amp; find solvents
                            </button>
                        </div>
                    </div>

                    {selectedResult && (
                        <div className="hsp-section">
                            <h3 className="hsp-section-title">{selectedResult.method}</h3>
                            <div className="hsp-readout">
                                <Cell label="δD" value={`${selectedResult.dD.toFixed(2)} MPa½`} />
                                <Cell label="δP" value={`${selectedResult.dP.toFixed(2)} MPa½`} />
                                <Cell label="δH" value={`${selectedResult.dH.toFixed(2)} MPa½`} />
                                <Cell label="δt" value={`${(selectedResult.dT ?? 0).toFixed(2)} MPa½`} />
                                {teas && (
                                    <>
                                        <Cell label="Teas fd" value={`${teas.fd.toFixed(1)}%`} />
                                        <Cell label="Teas fp" value={`${teas.fp.toFixed(1)}%`} />
                                        <Cell label="Teas fh" value={`${teas.fh.toFixed(1)}%`} />
                                    </>
                                )}
                            </div>
                            {selectedResult.notes?.length > 0 && (
                                <ul className="hsp-calc-notes">
                                    {selectedResult.notes.map((n, i) => <li key={i}>{n}</li>)}
                                </ul>
                            )}
                            {selectedResult.warnings?.length > 0 && (
                                <div className="hsp-warn">{selectedResult.warnings.join('; ')}</div>
                            )}
                            <HspSphereView
                                points={[]}
                                spheres={[{
                                    dD: selectedResult.dD,
                                    dP: selectedResult.dP,
                                    dH: selectedResult.dH,
                                    R: 8,
                                    color: '#34d399',
                                    name: 'estimated',
                                }]}
                                height={280}
                            />
                        </div>
                    )}
                </div>
            )}
        </>
    );
}

/* -------------------------------------------------------------- */
/*  Solvent Suggest tab (SolvPred-style)                         */
/* -------------------------------------------------------------- */
function SuggestTab({
    suggested, suggestZone, setSuggestZone, suggestMaxRED, setSuggestMaxRED,
    sphere, setBlendSolventNames, setTab, allSolvents, blendTarget, setBlendTarget,
}) {
    const pickForBlend = useCallback((names) => {
        setBlendSolventNames(names.slice(0, 8));
        setTab('blend');
    }, [setBlendSolventNames, setTab]);

    const autoPick = useCallback(() => {
        const picks = suggestBlendSolvents(allSolvents, blendTarget, 4).map((s) => s.name);
        pickForBlend(picks);
    }, [allSolvents, blendTarget, pickForBlend]);

    return (
        <div className="hsp-section">
            <h3 className="hsp-section-title">Find compatible solvents</h3>
            <div className="hsp-section-sub">
                Rank solvents by RED against the active sphere — like HSPiP / SolvPred solvent search.
            </div>
            <div className="hsp-row">
                <span className="hsp-label">Zone</span>
                <select className="hsp-select" value={suggestZone}
                    onChange={(e) => setSuggestZone(e.target.value)}>
                    <option value="good">Good only (RED ≤ R)</option>
                    <option value="marginal">Good + marginal</option>
                    <option value="any">Show all (sorted)</option>
                </select>
                <span className="hsp-label">Max RED</span>
                <input className="hsp-input hsp-input--num" type="number" step="0.1" min={0.1} max={3}
                    value={suggestMaxRED} onChange={(e) => setSuggestMaxRED(parseFloat(e.target.value) || 1)} />
                <button className="hsp-btn hsp-btn--primary" onClick={autoPick}>
                    <Sparkles size={13} /> Suggest 4 for blend
                </button>
            </div>
            <div className="hsp-table-wrap">
                <table className="hsp-table">
                    <thead>
                        <tr>
                            <th>Solvent</th><th>Class</th><th>δD</th><th>δP</th><th>δH</th>
                            <th>BP</th><th>RED</th><th>Zone</th>
                        </tr>
                    </thead>
                    <tbody>
                        {suggested.map((s) => (
                            <tr key={s.name}>
                                <td>{s.name}</td>
                                <td><span className="hsp-pill">{s.category}</span></td>
                                <td>{s.dD.toFixed(1)}</td>
                                <td>{s.dP.toFixed(1)}</td>
                                <td>{s.dH.toFixed(1)}</td>
                                <td>{s.bp}</td>
                                <td>{s.RED.toFixed(3)}</td>
                                <td><span className={`hsp-pill hsp-pill--${s.zone === 'good' ? 'good' : s.zone === 'marginal' ? 'marginal' : 'bad'}`}>{s.zone}</span></td>
                            </tr>
                        ))}
                        {suggested.length === 0 && (
                            <tr><td colSpan={8} style={{ color: '#94a3b8' }}>No solvents match — widen Max RED or zone.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/* -------------------------------------------------------------- */
/*  Evaporation tab                                              */
/* -------------------------------------------------------------- */
function EvaporationTab({
    blendCandidates, blendResult, evapFraction, setEvapFraction,
    runEvaporation, evapHistory, sphere, runBlend,
}) {
    const last = evapHistory?.length ? evapHistory[evapHistory.length - 1] : null;
    const lastRED = last ? hspRED(last.blend, sphere) : null;

    return (
        <>
            <div className="hsp-section">
                <h3 className="hsp-section-title">Evaporation & drying path</h3>
                <div className="hsp-section-sub">
                    Simulate how blend HSP drifts as solvents evaporate (RER-weighted). Uses the current Blend tab recipe.
                </div>
                <div className="hsp-row">
                    <span className="hsp-label">Evaporated</span>
                    <input type="range" min={0.1} max={0.99} step={0.01} value={evapFraction}
                        onChange={(e) => setEvapFraction(parseFloat(e.target.value))} style={{ flex: 1 }} />
                    <span className="hsp-label">{(evapFraction * 100).toFixed(0)}%</span>
                    <button className="hsp-btn hsp-btn--ghost" onClick={runBlend}>Refresh blend</button>
                    <button className="hsp-btn hsp-btn--primary" onClick={runEvaporation}>
                        <Wind size={13} /> Simulate
                    </button>
                </div>
                {blendCandidates.length === 0 && (
                    <div className="hsp-warn">Set up a blend first (Blend tab), then return here.</div>
                )}
            </div>
            {evapHistory && (
                <div className="hsp-grid-2">
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Final blend HSP</h3>
                        <div className="hsp-readout">
                            <Cell label="δD" value={last?.blend.dD.toFixed(2)} />
                            <Cell label="δP" value={last?.blend.dP.toFixed(2)} />
                            <Cell label="δH" value={last?.blend.dH.toFixed(2)} />
                            <Cell label="Evap" value={`${((last?.evap ?? 0) * 100).toFixed(0)}%`} />
                            <Cell label="RED vs sphere" value={lastRED?.toFixed(3) ?? '—'}
                                pill={lastRED != null && lastRED <= 1 ? 'good' : 'bad'} />
                        </div>
                    </div>
                    <div className="hsp-section">
                        <h3 className="hsp-section-title">Composition trajectory</h3>
                        <div className="hsp-table-wrap" style={{ maxHeight: 320 }}>
                            <table className="hsp-table">
                                <thead>
                                    <tr><th>Evap %</th><th>Blend δD</th><th>δP</th><th>δH</th><th>RED</th></tr>
                                </thead>
                                <tbody>
                                    {evapHistory.filter((_, i) => i % Math.ceil(evapHistory.length / 15) === 0).map((h, i) => {
                                        const red = hspRED(h.blend, sphere);
                                        return (
                                            <tr key={i}>
                                                <td>{(h.evap * 100).toFixed(0)}</td>
                                                <td>{h.blend.dD.toFixed(2)}</td>
                                                <td>{h.blend.dP.toFixed(2)}</td>
                                                <td>{h.blend.dH.toFixed(2)}</td>
                                                <td>{red.toFixed(2)}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

/* -------------------------------------------------------------- */
/*  RED Calculator tab                                          */
/* -------------------------------------------------------------- */
function REDTab({ redSolventName, setRedSolventName, redSolvent, redResult, sphere, allSolvents }) {
    return (
        <div className="hsp-section">
            <h3 className="hsp-section-title">RED calculator</h3>
            <div className="hsp-section-sub">
                Quick check: pick any solvent and see its Hansen distance Ra and Relative Energy
                Difference RED against the currently-selected sphere. RED &lt; 1 ⇒ inside the
                sphere ⇒ predicted soluble.
            </div>
            <div className="hsp-row">
                <span className="hsp-label">Solvent</span>
                <select
                    className="hsp-select hsp-input--wide"
                    value={redSolventName}
                    onChange={(e) => setRedSolventName(e.target.value)}
                >
                    {allSolvents.map((s) => (
                        <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                </select>
            </div>
            {redSolvent && redResult && (
                <div className="hsp-readout">
                    <Cell label="Solvent δD" value={redSolvent.dD.toFixed(1)} />
                    <Cell label="Solvent δP" value={redSolvent.dP.toFixed(1)} />
                    <Cell label="Solvent δH" value={redSolvent.dH.toFixed(1)} />
                    <Cell label="Sphere δD₀" value={sphere.dD.toFixed(1)} />
                    <Cell label="Sphere δP₀" value={sphere.dP.toFixed(1)} />
                    <Cell label="Sphere δH₀" value={sphere.dH.toFixed(1)} />
                    <Cell label="Sphere R"   value={sphere.R.toFixed(1)} />
                    <Cell label="Ra"         value={redResult.Ra.toFixed(3)} />
                    <Cell label="RED"        value={redResult.RED.toFixed(3)}
                        pill={redResult.RED <= 1 ? 'good' : 'bad'} />
                </div>
            )}
        </div>
    );
}

/* -------------------------------------------------------------- */
/*  Small reusable presentational helpers                        */
/* -------------------------------------------------------------- */
function Cell({ label, value, pill }) {
    return (
        <div className="hsp-readout-cell">
            <div className="hsp-readout-label">{label}</div>
            <div className="hsp-readout-value">
                {pill ? (
                    <span className={`hsp-pill ${pill === 'good' ? 'hsp-pill--good' : 'hsp-pill--bad'}`}
                        style={{ fontSize: '0.9rem', padding: '2px 10px' }}>
                        {value}
                    </span>
                ) : value}
            </div>
        </div>
    );
}

function NumberField({ label, value, onChange, min, max, step }) {
    return (
        <div className="hsp-row">
            <span className="hsp-label">{label}</span>
            <input
                type="range"
                min={min} max={max} step={step}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                style={{ flex: 1 }}
            />
            <input
                type="number"
                className="hsp-input hsp-input--num"
                value={value}
                min={min} max={max} step={step}
                onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            />
        </div>
    );
}
