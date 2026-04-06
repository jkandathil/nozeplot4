import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
    Brain,
    PlayCircle,
    FileText,
    Download,
    Loader2,
    Upload,
    FolderInput,
    Sparkles,
    FolderOpen,
    ChevronDown,
} from 'lucide-react';
import {
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    LineChart,
    Line,
    ScatterChart,
    Scatter,
    BarChart,
    Bar,
    Legend,
    Brush,
    ReferenceLine,
} from 'recharts';
import {
    predictFenosePpbV1FromRows,
    predictFenosePpbV2FromRows,
    trainFenoseV1FromFiles,
    trainFenoseV2FromFiles,
    parseFenosePpbFromFilename,
    parseFenoseDeviceIdFromFilename,
} from '../utils/fenoseModel.js';
import { FENOSE_SYNTH_UNKNOWN_KEY, parseConcentrationsList } from '../utils/fenoseSyntheticDataset.js';
import { parseFile } from '../utils/fileParser.js';
import { FENOSE_MODEL_FOLDER_NAME, FENOSE_SYNTHETIC_FOLDER_NAME } from '../utils/fenoseWorkspace.js';
import {
    getBrowserStorageEstimate,
    syntheticWorkloadHints,
    formatBytes,
    getDeviceMemoryGb,
} from '../utils/browserCapacityHints.js';
import {
    FENOSE_V2_TRAINING_ENGINES,
    ML_ENGINE_TF_MLP,
    ML_ENGINE_RIDGE_PCA,
    ONNX_INFERENCE_HINT,
} from '../utils/mlEngines/registry.js';
import './MLStudioPage.css';

function looksLikeFenoseLabelledTabular(name) {
    const n = String(name || '');
    const lower = n.toLowerCase();
    const hasPpb = /(\d+(?:\.\d+)?)\s*ppb/i.test(n);
    const tabular = lower.endsWith('.csv') || lower.endsWith('.xlsx') || lower.endsWith('.xls');
    return hasPpb && tabular;
}

/** Must match App.jsx FENOSE_MODEL_JSON_RE */
const FENOSE_MODEL_FILE_RE = /^(.*)_(v1|v2)_(weights|preprocessing|metrics)\.json$/i;

function isWorkspaceTabularFile(f) {
    if (!f || f.isFolder) return false;
    const n = String(f.name || '').toLowerCase();
    return n.endsWith('.csv') || n.endsWith('.xlsx') || n.endsWith('.xls');
}

function basenameOnly(p) {
    return String(p || '').split(/[/\\]/).pop() || '';
}

const MLStudioPage = ({
    data,
    fileName,
    compareDataList = [],
    workspaceFiles = [],
    workspaceSelectedFileId = null,
    workspaceCompareFileIds = [],
    onSaveJsonToWorkspace = null,
    onUploadModelJsonToWorkspace = null,
    onAddSyntheticFenoseToWorkspace = null,
}) => {
    const modelJsonInputRef = useRef(null);
    const [modelUploadBusy, setModelUploadBusy] = useState(false);
    const [modelUploadBanner, setModelUploadBanner] = useState(null); // { type: 'ok'|'err', text: string }
    const [importModelName, setImportModelName] = useState('fenose');
    const [importModelVersion, setImportModelVersion] = useState('auto'); // auto | v1 | v2
    const files = useMemo(() => {
        const arr = [];
        if (data && fileName) arr.push({ id: fileName, name: fileName, fileName: fileName, data });
        if (compareDataList && compareDataList.length > 0) {
            compareDataList.forEach(c => arr.push({ id: c.fileName, name: c.fileName, fileName: c.fileName, data: c.data }));
        }
        return arr;
    }, [data, fileName, compareDataList]);

    // FeNOse labelled tabular files in workspace (uploaded files usually have a File blob but no `data` until parsed).
    const fenosePpbWorkspaceEntries = useMemo(() => {
        return (workspaceFiles || []).filter((f) => !f?.isFolder && looksLikeFenoseLabelledTabular(f?.name || f?.fileName));
    }, [workspaceFiles]);

    const [trainingCandidates, setTrainingCandidates] = useState([]);
    const [fenoseTrainHydrateStatus, setFenoseTrainHydrateStatus] = useState('idle'); // idle | loading | done
    const [fenoseTrainSelectedIds, setFenoseTrainSelectedIds] = useState([]);

    useEffect(() => {
        let cancelled = false;
        const entries = fenosePpbWorkspaceEntries;
        if (entries.length === 0) {
            setTrainingCandidates([]);
            setFenoseTrainHydrateStatus('done');
            return undefined;
        }
        setFenoseTrainHydrateStatus('loading');
        (async () => {
            const withData = [];
            const needParse = [];
            for (const f of entries) {
                if (Array.isArray(f?.data) && f.data.length > 0) {
                    withData.push({ id: f.id, name: f.name, fileName: f.name, data: f.data, folderId: f.folderId });
                } else {
                    needParse.push(f);
                }
            }
            const parsed = await Promise.all(
                needParse.map(async (f) => {
                    try {
                        const r = await parseFile(f);
                        if (r?.data?.length) return { id: f.id, name: f.name, fileName: f.name, data: r.data, folderId: f.folderId };
                    } catch (e) {
                        console.warn('[FeNOse training] skipped file (parse error)', f?.name, e);
                    }
                    return null;
                })
            );
            const merged = [...withData, ...parsed.filter(Boolean)];
            if (!cancelled) {
                setTrainingCandidates(merged);
                setFenoseTrainHydrateStatus('done');
                setFenoseTrainSelectedIds((prev) => prev.filter((id) => merged.some((m) => m.id === id)));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [fenosePpbWorkspaceEntries]);

    const fenoseTrainEffectiveSelectionCount =
        fenoseTrainSelectedIds.length > 0 ? fenoseTrainSelectedIds.length : trainingCandidates.length;

    // FeNOse predictor — weights only from workspace Model/ (train in app or upload JSON there)
    const [fenoseSelectedFileId, setFenoseSelectedFileId] = useState(() => (fileName || ''));
    const [fenoseRunning, setFenoseRunning] = useState(false);
    const [fenoseError, setFenoseError] = useState('');
    const [fenoseResults, setFenoseResults] = useState(null); // [{fileName, predictedPpb, actualPpb, absErr}]
    const [fenoseTrainVersion, setFenoseTrainVersion] = useState('v2');
    const [fenoseTrainTopK, setFenoseTrainTopK] = useState(300);
    const [fenoseTrainPca, setFenoseTrainPca] = useState(50);
    const [fenoseTrainEpochs, setFenoseTrainEpochs] = useState(300);
    const [fenoseTrainLr, setFenoseTrainLr] = useState(0.001);
    const [fenoseTrainFrac, setFenoseTrainFrac] = useState(20);
    const [fenoseTrainSeed, setFenoseTrainSeed] = useState(0);
    const [fenoseV2TrainEngine, setFenoseV2TrainEngine] = useState(ML_ENGINE_TF_MLP);
    const [fenoseV2RidgeLambda, setFenoseV2RidgeLambda] = useState('0.05');
    const [fenoseV2TextEmbed, setFenoseV2TextEmbed] = useState(false);
    const [fenoseV2TextEmbedDims, setFenoseV2TextEmbedDims] = useState('8');
    const [fenoseTrainBusy, setFenoseTrainBusy] = useState(false);
    const [fenoseTrainProgress, setFenoseTrainProgress] = useState(null); // {epoch, loss}
    const [fenoseTrainOut, setFenoseTrainOut] = useState(null); // {weights, preprocessing, metrics}
    const [fenoseTrainErr, setFenoseTrainErr] = useState('');
    const [fenoseTrainLossHistory, setFenoseTrainLossHistory] = useState([]);
    const fenoseTrainLossChartRef = useRef(null);
    const fenoseTrainValChartRef = useRef(null);
    const [fenoseModelName, setFenoseModelName] = useState('fenose');
    const [fenoseMainTab, setFenoseMainTab] = useState('inference'); // inference | training
    const [fenoseImportOpen, setFenoseImportOpen] = useState(false);

    const [fenoseSynthConc, setFenoseSynthConc] = useState('0, 5, 10, 25, 50, 100');
    const [fenoseSynthReps, setFenoseSynthReps] = useState(2);
    const [fenoseSynthSeed, setFenoseSynthSeed] = useState(0);
    const [fenoseSynthBusy, setFenoseSynthBusy] = useState(false);
    const [fenoseSynthMsg, setFenoseSynthMsg] = useState(null); // { type, text }
    const [fenoseSynthSelectedAuKeys, setFenoseSynthSelectedAuKeys] = useState([]);

    /** Labelled FeNOse-like workspace files → distinct AU ids (excludes FeNOse_synthetic/). */
    const fenoseSynthAuOptions = useMemo(() => {
        const synthFolder = (workspaceFiles || []).find(
            (f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_SYNTHETIC_FOLDER_NAME.toLowerCase()
        );
        const synthId = synthFolder ? String(synthFolder.id) : null;
        const byKey = new Map();
        for (const f of workspaceFiles || []) {
            if (f.isFolder) continue;
            if (synthId && String(f.folderId) === synthId) continue;
            if (!looksLikeFenoseLabelledTabular(f.name)) continue;
            const raw = parseFenoseDeviceIdFromFilename(f.name);
            const key = raw === 'UNKNOWN' ? FENOSE_SYNTH_UNKNOWN_KEY : String(raw).toUpperCase();
            if (!byKey.has(key)) {
                byKey.set(key, {
                    key,
                    label: key === FENOSE_SYNTH_UNKNOWN_KEY ? 'Unknown AU (no device id in filename)' : raw.toUpperCase(),
                    fileCount: 0,
                });
            }
            byKey.get(key).fileCount += 1;
        }
        return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    }, [workspaceFiles]);

    const fenoseSynthAuKeysFingerprint = useMemo(
        () => fenoseSynthAuOptions.map((o) => o.key).sort().join('\n'),
        [fenoseSynthAuOptions]
    );

    useEffect(() => {
        if (!fenoseSynthAuKeysFingerprint) {
            setFenoseSynthSelectedAuKeys([]);
            return;
        }
        const keys = fenoseSynthAuKeysFingerprint.split('\n');
        setFenoseSynthSelectedAuKeys((prev) => {
            const allowed = new Set(keys);
            const kept = prev.filter((k) => allowed.has(k));
            const added = keys.filter((k) => !kept.includes(k));
            if (kept.length === 0) return keys;
            return [...kept, ...added];
        });
    }, [fenoseSynthAuKeysFingerprint]);

    const fenoseSynthConcCount = useMemo(() => parseConcentrationsList(fenoseSynthConc).length, [fenoseSynthConc]);

    const fenoseSynthPlannedFileCount = useMemo(() => {
        const nConc = fenoseSynthConcCount;
        const r = Math.max(1, Math.min(200, Math.floor(Number(fenoseSynthReps) || 2)));
        if (nConc === 0) return 0;
        const nAu = fenoseSynthAuOptions.length > 0 ? fenoseSynthSelectedAuKeys.length : 1;
        if (fenoseSynthAuOptions.length > 0 && nAu === 0) return 0;
        return nAu * nConc * r;
    }, [fenoseSynthAuOptions.length, fenoseSynthSelectedAuKeys.length, fenoseSynthConcCount, fenoseSynthReps]);

    const [browserStorageEst, setBrowserStorageEst] = useState(null);
    useEffect(() => {
        let cancelled = false;
        getBrowserStorageEstimate().then((est) => {
            if (!cancelled) setBrowserStorageEst(est);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const fenoseSyntheticCapacityHints = useMemo(
        () => syntheticWorkloadHints(fenoseSynthPlannedFileCount, browserStorageEst),
        [fenoseSynthPlannedFileCount, browserStorageEst]
    );

    const [fenoseBatchResults, setFenoseBatchResults] = useState(null);
    const [fenoseBatchRunning, setFenoseBatchRunning] = useState(false);
    const [fenoseBatchProgress, setFenoseBatchProgress] = useState(null);

    const fenoseBatchSelectionSig = useMemo(() => {
        const ids = [workspaceSelectedFileId, ...(workspaceCompareFileIds || [])].filter(Boolean);
        return [...new Set(ids.map(String))].sort().join('|');
    }, [workspaceSelectedFileId, workspaceCompareFileIds]);

    useEffect(() => {
        setFenoseBatchResults(null);
    }, [fenoseBatchSelectionSig]);

    // FeNOse JSON under every workspace folder named "Model" (any casing), merged by file name
    const { savedFenoseModels, fenoseIncompleteModels, fenoseIgnoredJsonInModel } = useMemo(() => {
        const folders = (workspaceFiles || []).filter(
            (f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_MODEL_FOLDER_NAME.toLowerCase()
        );
        const folderIds = new Set(folders.map((f) => String(f.id)));
        const allInModelDirs = (workspaceFiles || []).filter(
            (f) => !f.isFolder && folderIds.size > 0 && folderIds.has(String(f.folderId))
        );
        /* Workspace root (no folderId): FeNOse JSON only, for older / edge saves */
        const atRootFenose = (workspaceFiles || []).filter((f) => {
            if (f.isFolder) return false;
            const fid = f.folderId;
            if (fid != null && fid !== '') return false;
            return FENOSE_MODEL_FILE_RE.test(String(f.name || ''));
        });
        const seenIds = new Set(allInModelDirs.map((f) => f.id));
        const inFolder = [...allInModelDirs, ...atRootFenose.filter((f) => !seenIds.has(f.id))];
        if (inFolder.length === 0) {
            return { savedFenoseModels: [], fenoseIncompleteModels: [], fenoseIgnoredJsonInModel: [] };
        }
        const models = new Map();
        const ignored = [];
        for (const f of inFolder) {
            const base = String(f.name || '');
            if (!base.toLowerCase().endsWith('.json')) continue;
            const m = base.match(FENOSE_MODEL_FILE_RE);
            if (!m) {
                ignored.push(base);
                continue;
            }
            const modelName = m[1];
            const version = m[2].toLowerCase();
            const kind = m[3].toLowerCase();
            const key = `${modelName}::${version}`;
            if (!models.has(key)) models.set(key, { modelName, version });
            models.get(key)[kind] = f;
        }
        const all = Array.from(models.values());
        const complete = all.filter((x) => x.weights && x.preprocessing);
        const incomplete = all.filter((x) => !x.weights || !x.preprocessing);
        return {
            savedFenoseModels: complete,
            fenoseIncompleteModels: incomplete,
            fenoseIgnoredJsonInModel: ignored,
        };
    }, [workspaceFiles]);

    const [fenosePredictWorkspaceKey, setFenosePredictWorkspaceKey] = useState('');

    const selectedInferModel = useMemo(
        () => savedFenoseModels.find((x) => `${x.modelName}::${x.version}` === fenosePredictWorkspaceKey) || null,
        [savedFenoseModels, fenosePredictWorkspaceKey]
    );

    useEffect(() => {
        const keys = savedFenoseModels.map((m) => `${m.modelName}::${m.version}`);
        setFenosePredictWorkspaceKey((prev) => {
            if (prev && keys.includes(prev)) return prev;
            return keys[0] || '';
        });
    }, [savedFenoseModels]);

    useEffect(() => {
        if (savedFenoseModels.length === 0) setFenoseImportOpen(true);
    }, [savedFenoseModels.length]);

    useEffect(() => {
        if (!fenoseSelectedFileId && fileName) setFenoseSelectedFileId(fileName);
    }, [fileName, fenoseSelectedFileId]);

    /** Main + comparison files from the sidebar, in order; CSV/Excel only (workspace DB objects). */
    const fenoseBatchWorkspaceEntries = useMemo(() => {
        const orderIds = [workspaceSelectedFileId, ...(workspaceCompareFileIds || [])].filter(Boolean);
        const byId = new Map(
            (workspaceFiles || [])
                .filter((f) => f && !f.isFolder)
                .map((f) => [String(f.id), f])
        );
        const out = [];
        const seen = new Set();
        for (const id of orderIds) {
            const f = byId.get(String(id));
            if (!f || seen.has(f.id)) continue;
            if (!isWorkspaceTabularFile(f)) continue;
            seen.add(f.id);
            out.push(f);
        }
        return out;
    }, [workspaceFiles, workspaceSelectedFileId, workspaceCompareFileIds]);

    const fenoseBatchScatterChartData = useMemo(() => {
        const rows = (fenoseBatchResults || []).filter(
            (r) => !r.error && r.predictedPpb != null && r.actualPpb != null && Number.isFinite(r.actualPpb)
        );
        return rows.map((r) => ({
            actual: r.actualPpb,
            predicted: r.predictedPpb,
            label: r.shortName || basenameOnly(r.fileName),
        }));
    }, [fenoseBatchResults]);

    const fenoseBatchIdentityLineData = useMemo(() => {
        const pts = fenoseBatchScatterChartData;
        if (pts.length === 0) return [];
        const vals = [...pts.flatMap((p) => [p.actual, p.predicted]), 0];
        const lo = Math.min(...vals);
        const hi = Math.max(...vals);
        const pad = Math.max((hi - lo) * 0.05, 1);
        return [
            { actual: lo - pad, predicted: lo - pad },
            { actual: hi + pad, predicted: hi + pad },
        ];
    }, [fenoseBatchScatterChartData]);

    const fenoseBatchIdentitySegment = useMemo(() => {
        const d = fenoseBatchIdentityLineData;
        if (d.length < 2) return null;
        return [
            { x: d[0].actual, y: d[0].predicted },
            { x: d[1].actual, y: d[1].predicted },
        ];
    }, [fenoseBatchIdentityLineData]);

    const fenoseBatchBarChartData = useMemo(() => {
        const rows = (fenoseBatchResults || []).filter((r) => !r.error && r.predictedPpb != null);
        return rows.map((r, i) => {
            const base = r.shortName || basenameOnly(r.fileName);
            return {
                idx: i + 1,
                short: base.length > 20 ? `${base.slice(0, 20)}…` : base,
                predicted: r.predictedPpb,
            };
        });
    }, [fenoseBatchResults]);

    const fenoseTrainValScatterData = useMemo(() => {
        const pts = fenoseTrainOut?.metrics?.validationPoints;
        if (!Array.isArray(pts) || pts.length === 0) return [];
        return pts.map((p, i) => ({
            actual: Number(p.actual),
            predicted: Number(p.predicted),
            label: p.label || `Sample ${i + 1}`,
        }));
    }, [fenoseTrainOut]);

    const fenoseTrainValIdentitySegment = useMemo(() => {
        const pts = fenoseTrainValScatterData;
        if (pts.length === 0) return null;
        const vals = [...pts.flatMap((p) => [p.actual, p.predicted]), 0];
        const lo = Math.min(...vals);
        const hi = Math.max(...vals);
        const pad = Math.max((hi - lo) * 0.05, 1);
        return [
            { x: lo - pad, y: lo - pad },
            { x: hi + pad, y: hi + pad },
        ];
    }, [fenoseTrainValScatterData]);

    useEffect(() => {
        if (!fenoseTrainBusy) return;
        const t = window.setTimeout(() => {
            fenoseTrainLossChartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
        return () => window.clearTimeout(t);
    }, [fenoseTrainBusy]);

    const fenoseTrainPrevLossLenRef = useRef(0);
    useEffect(() => {
        const n = fenoseTrainLossHistory.length;
        if (fenoseTrainBusy && fenoseTrainPrevLossLenRef.current === 0 && n > 0) {
            const t = window.setTimeout(() => {
                fenoseTrainLossChartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 80);
            fenoseTrainPrevLossLenRef.current = n;
            return () => window.clearTimeout(t);
        }
        fenoseTrainPrevLossLenRef.current = n;
        return undefined;
    }, [fenoseTrainBusy, fenoseTrainLossHistory.length]);

    useEffect(() => {
        const pts = fenoseTrainOut?.metrics?.validationPoints;
        if (!fenoseTrainOut || !Array.isArray(pts) || pts.length === 0) return;
        const t = window.setTimeout(() => {
            fenoseTrainValChartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 400);
        return () => window.clearTimeout(t);
    }, [fenoseTrainOut]);

    const runFenosePrediction = async () => {
        setFenoseError('');
        setFenoseResults(null);
        const sel = files.find((f) => f.id === fenoseSelectedFileId) || files[0];
        if (!sel?.data?.length) {
            setFenoseError('No data available. Load a CSV first (main file or compare).');
            return;
        }
        setFenoseRunning(true);
        try {
            const m = savedFenoseModels.find((x) => `${x.modelName}::${x.version}` === fenosePredictWorkspaceKey);
            if (!m) {
                throw new Error(
                    'No workspace model selected. Train on the Training tab (saves to folder Model/) or upload matching *_v1_weights.json + *_v1_preprocessing.json (or v2) into Model/ via the sidebar.'
                );
            }
            const weights = m.weights?.data;
            const preprocessing = m.preprocessing?.data;
            if (!weights || !preprocessing) throw new Error('Workspace model files are missing parsed JSON (weights/preprocessing).');
            const predicted =
                m.version === 'v1'
                    ? await predictFenosePpbV1FromRows(sel.data, { weights, preprocessing })
                    : await predictFenosePpbV2FromRows(sel.data, {
                          weights,
                          preprocessing,
                          predictContext: {
                              fileName: sel.fileName,
                              deviceId: parseFenoseDeviceIdFromFilename(sel.fileName),
                          },
                      });
            const actual = parseFenosePpbFromFilename(sel.fileName);
            const absErr = actual != null ? Math.abs(predicted - actual) : null;
            setFenoseResults([{ fileName: sel.fileName, predictedPpb: predicted, actualPpb: actual, absErr }]);
        } catch (e) {
            setFenoseError(e?.message || 'FeNOse prediction failed.');
        } finally {
            setFenoseRunning(false);
        }
    };

    const runFenoseBatchPrediction = async () => {
        setFenoseError('');
        const m = savedFenoseModels.find((x) => `${x.modelName}::${x.version}` === fenosePredictWorkspaceKey);
        if (!m) {
            setFenoseError(
                'Select a workspace model first. Train or import weights + preprocessing JSON into folder Model/.'
            );
            return;
        }
        const list = fenoseBatchWorkspaceEntries;
        if (list.length === 0) {
            setFenoseError(
                'No CSV/Excel files in your sidebar selection. Select a main file and/or add comparison files (checkboxes or + in the sidebar), then try again.'
            );
            return;
        }
        const weights = m.weights?.data;
        const preprocessing = m.preprocessing?.data;
        if (!weights || !preprocessing) {
            setFenoseError('Workspace model files are missing parsed JSON (weights/preprocessing).');
            return;
        }

        setFenoseBatchRunning(true);
        setFenoseBatchResults([]);
        setFenoseBatchProgress({ current: 0, total: list.length, name: '' });

        const out = [];
        for (let i = 0; i < list.length; i++) {
            const wf = list[i];
            const shortName = basenameOnly(wf.name);
            setFenoseBatchProgress({ current: i + 1, total: list.length, name: shortName });
            const actualPpb = parseFenosePpbFromFilename(wf.name);
            try {
                let data = wf.data;
                if (!Array.isArray(data) || data.length === 0) {
                    const r = await parseFile(wf);
                    data = r?.data;
                }
                if (!Array.isArray(data) || data.length === 0) {
                    throw new Error('No rows after parse');
                }
                const predicted =
                    m.version === 'v1'
                        ? await predictFenosePpbV1FromRows(data, { weights, preprocessing })
                        : await predictFenosePpbV2FromRows(data, {
                              weights,
                              preprocessing,
                              predictContext: {
                                  fileName: wf.name,
                                  deviceId: parseFenoseDeviceIdFromFilename(wf.name),
                              },
                          });
                const absErr = actualPpb != null && Number.isFinite(actualPpb) ? Math.abs(predicted - actualPpb) : null;
                out.push({
                    fileName: wf.name,
                    shortName,
                    predictedPpb: predicted,
                    actualPpb,
                    absErr,
                    error: null,
                });
            } catch (err) {
                out.push({
                    fileName: wf.name,
                    shortName,
                    predictedPpb: null,
                    actualPpb,
                    absErr: null,
                    error: err?.message || String(err),
                });
            }
            setFenoseBatchResults([...out]);
            await new Promise((r) => setTimeout(r, 0));
        }

        setFenoseBatchProgress(null);
        setFenoseBatchRunning(false);
    };

    const handleModelJsonInputChange = async (e) => {
        const list = e.target.files;
        e.target.value = '';
        if (!onUploadModelJsonToWorkspace || !list?.length) return;
        setModelUploadBanner(null);
        setModelUploadBusy(true);
        try {
            const r = await onUploadModelJsonToWorkspace(list, { modelName: importModelName, version: importModelVersion });
            if (r.ok) {
                const extra = r.createdFolder ? ` Created workspace folder ${FENOSE_MODEL_FOLDER_NAME}/.` : '';
                const hints = Array.isArray(r.pairHints) && r.pairHints.length > 0 ? ` Still needed: ${r.pairHints.join('; ')}.` : '';
                const saved = Array.isArray(r.savedNames) && r.savedNames.length > 0 ? ` Saved as: ${r.savedNames.join(', ')}.` : '';
                setModelUploadBanner({
                    type: 'ok',
                    text: `Saved ${r.count} file(s) to ${FENOSE_MODEL_FOLDER_NAME}/ only.${extra}${saved}${hints}`,
                });
            } else {
                setModelUploadBanner({ type: 'err', text: r.error || 'Upload failed.' });
            }
        } catch (err) {
            setModelUploadBanner({ type: 'err', text: err?.message || 'Upload failed.' });
        } finally {
            setModelUploadBusy(false);
        }
    };

    const downloadJson = (obj, filename) => {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const runAddSyntheticFenose = async () => {
        if (!onAddSyntheticFenoseToWorkspace) return;
        setFenoseSynthMsg(null);
        if (fenoseSynthAuOptions.length > 0 && fenoseSynthSelectedAuKeys.length === 0) {
            setFenoseSynthMsg({ type: 'err', text: 'Select at least one Aroma Unit from the workspace list.' });
            return;
        }
        setFenoseSynthBusy(true);
        try {
            const freshEst = await getBrowserStorageEstimate();
            if (freshEst) setBrowserStorageEst(freshEst);
            const capHints = syntheticWorkloadHints(fenoseSynthPlannedFileCount, freshEst || browserStorageEst);
            if (capHints.severity === 'severe' && capHints.messages.length > 0) {
                const proceed = window.confirm(
                    `${capHints.messages.join('\n\n')}\n\nContinue with synthetic generation anyway?`
                );
                if (!proceed) return;
            }

            const { count, folderName } = await onAddSyntheticFenoseToWorkspace({
                concentrationsText: fenoseSynthConc,
                replicates: fenoseSynthReps,
                seed: fenoseSynthSeed,
                deviceKeys: fenoseSynthAuOptions.length > 0 ? fenoseSynthSelectedAuKeys : undefined,
            });
            const folder = folderName || FENOSE_SYNTHETIC_FOLDER_NAME;
            setFenoseSynthMsg({
                type: 'ok',
                text: `Added ${count} synthetic CSV(s) under ${folder}/ for the unit(s) you selected (calibrated per unit when possible). Open Training to pick files, or remove the folder from the sidebar when done.`,
            });
        } catch (e) {
            setFenoseSynthMsg({ type: 'err', text: e?.message || String(e) });
        } finally {
            setFenoseSynthBusy(false);
        }
    };

    const runFenoseTraining = async () => {
        setFenoseTrainErr('');
        setFenoseTrainOut(null);
        setFenoseTrainProgress(null);
        setFenoseTrainLossHistory([]);
        const selectedTrainingFiles =
            fenoseTrainSelectedIds.length > 0
                ? trainingCandidates.filter((f) => fenoseTrainSelectedIds.includes(f.id))
                : trainingCandidates;
        if (!selectedTrainingFiles || selectedTrainingFiles.length < 3) {
            setFenoseTrainErr('Select at least 3 curated CSV files to train (use the Training Data picker).');
            return;
        }
        setFenoseTrainBusy(true);
        try {
            const common = {
                testFrac: Math.min(0.8, Math.max(0.05, Number(fenoseTrainFrac) / 100)),
                seed: Number(fenoseTrainSeed) || 0,
                epochs: Math.max(20, Number(fenoseTrainEpochs) || 300),
                lr: Number(fenoseTrainLr) || 0.001,
            };
            const onProgress = (p) => {
                setFenoseTrainProgress(p);
                if (p?.phase === 'txt_embed') return;
                if (p && typeof p.epoch === 'number' && p.loss != null) {
                    setFenoseTrainLossHistory((prev) => [...prev, { epoch: p.epoch, loss: Number(p.loss) }]);
                }
            };
            const out =
                fenoseTrainVersion === 'v1'
                    ? await trainFenoseV1FromFiles(
                          selectedTrainingFiles,
                          {
                              ...common,
                              topK: Math.max(10, Number(fenoseTrainTopK) || 80),
                          },
                          onProgress
                      )
                    : await trainFenoseV2FromFiles(
                          selectedTrainingFiles,
                          {
                              ...common,
                              topK: Math.max(20, Number(fenoseTrainTopK) || 300),
                              nPca: Math.max(2, Number(fenoseTrainPca) || 50),
                              mlEngine: fenoseV2TrainEngine,
                              ridgeLambda: Number(fenoseV2RidgeLambda) || 0.05,
                              textEmbeddingAugment: fenoseV2TextEmbed,
                              textEmbeddingDims: Number(fenoseV2TextEmbedDims) || 8,
                          },
                          onProgress
                      );
            setFenoseTrainOut(out);

            // Save into workspace folder "Model" if handler provided
            const safeName = String(fenoseModelName || 'fenose').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'fenose';
            if (onSaveJsonToWorkspace) {
                await onSaveJsonToWorkspace({
                    folderName: FENOSE_MODEL_FOLDER_NAME,
                    fileName: `${safeName}_${fenoseTrainVersion}_weights.json`,
                    json: out.weights,
                });
                await onSaveJsonToWorkspace({
                    folderName: FENOSE_MODEL_FOLDER_NAME,
                    fileName: `${safeName}_${fenoseTrainVersion}_preprocessing.json`,
                    json: out.preprocessing,
                });
                await onSaveJsonToWorkspace({
                    folderName: FENOSE_MODEL_FOLDER_NAME,
                    fileName: `${safeName}_${fenoseTrainVersion}_metrics.json`,
                    json: out.metrics,
                });
            }
        } catch (e) {
            setFenoseTrainErr(e?.message || 'FeNOse training failed.');
        } finally {
            setFenoseTrainBusy(false);
        }
    };


    return (
        <div className="ml-studio-page ml-studio-page--fenose">
            <main className="ml-content ml-content--fenose">
                <header className="ml-fenose-header">
                    <div className="ml-fenose-header-icon" aria-hidden>
                        <Brain size={26} color="#38bdf8" />
                    </div>
                    <div>
                        <h1 className="page-title">FeNOse — ML Studio</h1>
                        <p className="ml-fenose-header-sub">
                            Run a NO (ppb) model from your workspace on the chart’s active file, or train a new FeNOse model from labelled workspace captures. Models stay in the browser workspace (not bundled with the site).
                        </p>
                    </div>
                </header>

                <div className="ml-fenose-tabs" role="tablist" aria-label="FeNOse workspace">
                    <button
                        type="button"
                        role="tab"
                        id="fenose-tab-inference"
                        aria-selected={fenoseMainTab === 'inference'}
                        aria-controls="fenose-panel-inference"
                        className={`ml-fenose-tab ${fenoseMainTab === 'inference' ? 'ml-fenose-tab--active' : ''}`}
                        onClick={() => setFenoseMainTab('inference')}
                    >
                        <PlayCircle size={18} aria-hidden />
                        Inference
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="fenose-tab-training"
                        aria-selected={fenoseMainTab === 'training'}
                        aria-controls="fenose-panel-training"
                        className={`ml-fenose-tab ${fenoseMainTab === 'training' ? 'ml-fenose-tab--active' : ''}`}
                        onClick={() => setFenoseMainTab('training')}
                    >
                        <Brain size={18} aria-hidden />
                        Training
                    </button>
                </div>

                <div className="ml-fenose-tab-panels">
                    {/* Inference */}
                    <section
                        id="fenose-panel-inference"
                        role="tabpanel"
                        aria-labelledby="fenose-tab-inference"
                        hidden={fenoseMainTab !== 'inference'}
                        className="ml-fenose-tab-panel plot-card glass-panel ml-fenose-card"
                    >
                        <div className="ml-fenose-panel-head">
                            <h3 className="plot-title ml-fenose-panel-title">Predict concentration</h3>
                            <p className="ml-fenose-card-desc ml-fenose-panel-desc">
                                FeNOse captures need <code>event_name</code> phases and sensors A1–H8. Choose a model from <code>{FENOSE_MODEL_FOLDER_NAME}/</code>, then run a single prediction or a sidebar batch.
                            </p>
                        </div>

                        {onUploadModelJsonToWorkspace ? (
                            <div className={`ml-fenose-import-disclosure ${fenoseImportOpen ? 'ml-fenose-import-disclosure--open' : ''}`}>
                                <button
                                    type="button"
                                    className="ml-fenose-import-toggle"
                                    aria-expanded={fenoseImportOpen}
                                    aria-controls="fenose-import-model-panel"
                                    aria-label={`Import model — saves JSON under ${FENOSE_MODEL_FOLDER_NAME}`}
                                    onClick={() => setFenoseImportOpen((o) => !o)}
                                >
                                    <span className="ml-fenose-import-toggle__icon" aria-hidden>
                                        <FolderInput size={20} strokeWidth={1.75} />
                                    </span>
                                    <span className="ml-fenose-import-toggle__label">Import model</span>
                                    <ChevronDown
                                        size={20}
                                        strokeWidth={2}
                                        className={`ml-fenose-import-toggle__chev${fenoseImportOpen ? ' ml-fenose-import-toggle__chev--open' : ''}`}
                                        aria-hidden
                                    />
                                </button>
                            </div>
                        ) : null}

                        {onUploadModelJsonToWorkspace && fenoseImportOpen ? (
                            <div id="fenose-import-model-panel" className="ml-fenose-model-import">
                                <div className="ml-fenose-model-import__header">
                                    <div className="ml-fenose-model-import__icon" aria-hidden>
                                        <FolderInput size={22} strokeWidth={1.75} />
                                    </div>
                                    <div className="ml-fenose-model-import__headlines">
                                        <h4 className="ml-fenose-model-import__title">Import model files</h4>
                                        <p className="ml-fenose-model-import__subtitle">
                                            JSON is stored <strong>only</strong> in workspace <code className="ml-fenose-model-import__folder-pill">{FENOSE_MODEL_FOLDER_NAME}</code> — not in the root list or other
                                            folders. The folder is created automatically if it does not exist.
                                        </p>
                                    </div>
                                </div>
                                <ul className="ml-fenose-model-import__list">
                                    <li>
                                        <span className="ml-fenose-model-import__list-label">Required pair</span>
                                        <code className="ml-fenose-model-import__code">{'{name}_{v1|v2}_weights.json'}</code>
                                        <span className="ml-fenose-model-import__list-join">+</span>
                                        <code className="ml-fenose-model-import__code">{'{name}_{v1|v2}_preprocessing.json'}</code>
                                    </li>
                                    <li>
                                        <span className="ml-fenose-model-import__list-label">Optional</span>
                                        <code className="ml-fenose-model-import__code">{'{name}_{v1|v2}_metrics.json'}</code>
                                    </li>
                                </ul>
                                <div className="ml-fenose-model-import__actions">
                                    <input
                                        ref={modelJsonInputRef}
                                        type="file"
                                        accept=".json,application/json"
                                        multiple
                                        className="ml-fenose-file-input-offscreen"
                                        aria-label={`Choose FeNOse JSON files to save under ${FENOSE_MODEL_FOLDER_NAME}`}
                                        onChange={handleModelJsonInputChange}
                                    />
                                    <button
                                        type="button"
                                        className="btn-primary ml-fenose-model-import__btn"
                                        disabled={fenoseRunning || modelUploadBusy}
                                        onClick={() => modelJsonInputRef.current?.click()}
                                    >
                                        {modelUploadBusy ? <Loader2 className="spinner" size={18} /> : <Upload size={18} />}
                                        Choose files…
                                    </button>
                                    <div className="ml-fenose-model-import__inline-controls">
                                        <label className="ml-fenose-model-import__field">
                                            <span>Model name</span>
                                            <input
                                                className="text-input"
                                                value={importModelName}
                                                onChange={(e) => setImportModelName(e.target.value)}
                                                disabled={modelUploadBusy}
                                                placeholder="fenose"
                                            />
                                        </label>
                                        <label className="ml-fenose-model-import__field">
                                            <span>Version</span>
                                            <select
                                                className="text-input"
                                                value={importModelVersion}
                                                onChange={(e) => setImportModelVersion(e.target.value)}
                                                disabled={modelUploadBusy}
                                            >
                                                <option value="auto">auto-detect</option>
                                                <option value="v2">v2</option>
                                                <option value="v1">v1</option>
                                            </select>
                                        </label>
                                        <span className="ml-fenose-model-import__actions-note">
                                            If your JSON files aren’t named with <code>_v1/_v2</code> + <code>_weights/_preprocessing</code>, we’ll rename them into{' '}
                                            <strong>{FENOSE_MODEL_FOLDER_NAME}/</strong> using this model name/version.
                                        </span>
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        {modelUploadBanner ? (
                            <div
                                className={
                                    modelUploadBanner.type === 'ok' ? 'ml-fenose-upload-banner ml-fenose-upload-banner--ok' : 'ml-fenose-upload-banner ml-fenose-upload-banner--err'
                                }
                            >
                                {modelUploadBanner.text}
                            </div>
                        ) : null}

                        {fenoseIncompleteModels.length > 0 ? (
                            <div className="ml-fenose-upload-banner ml-fenose-upload-banner--warn">
                                <strong>Incomplete FeNOse files in {FENOSE_MODEL_FOLDER_NAME}/:</strong> inference needs <em>both</em>{' '}
                                <code>{'{name}_{v1|v2}_weights.json'}</code> and <code>{'{name}_{v1|v2}_preprocessing.json'}</code> with the{' '}
                                <strong>same</strong> name and version (e.g. <code>mymodel_v2_weights.json</code> + <code>mymodel_v2_preprocessing.json</code>).
                                <ul style={{ margin: '8px 0 0', paddingLeft: '1.25rem' }}>
                                    {fenoseIncompleteModels.map((m) => {
                                        const miss = [!m.weights && 'weights', !m.preprocessing && 'preprocessing'].filter(Boolean);
                                        return (
                                            <li key={`${m.modelName}::${m.version}`}>
                                                <code>
                                                    {m.modelName}_{m.version}
                                                </code>
                                                : missing {miss.join(' and ')}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ) : null}

                        {fenoseIgnoredJsonInModel.length > 0 ? (
                            <div className="ml-fenose-upload-banner ml-fenose-upload-banner--warn" style={{ marginBottom: 12 }}>
                                These files in {FENOSE_MODEL_FOLDER_NAME}/ don’t match the FeNOse name pattern (ignored):{' '}
                                {fenoseIgnoredJsonInModel.map((n) => (
                                    <code key={n} style={{ marginRight: 8 }}>
                                        {n}
                                    </code>
                                ))}
                            </div>
                        ) : null}

                        {savedFenoseModels.length === 0 && fenoseIncompleteModels.length === 0 ? (
                            <div
                                style={{
                                    marginBottom: 12,
                                    padding: 12,
                                    borderRadius: 10,
                                    border: '1px solid rgba(245, 158, 11, 0.35)',
                                    background: 'rgba(245, 158, 11, 0.08)',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.88rem',
                                    lineHeight: 1.45,
                                }}
                            >
                                No complete FeNOse model yet. Train on the <strong>Training</strong> tab (saves to{' '}
                                <code>{FENOSE_MODEL_FOLDER_NAME}/</code>) or use <strong>Import model</strong> and upload both{' '}
                                <code>{'{name}_{v1|v2}_weights.json'}</code> and <code>{'{name}_{v1|v2}_preprocessing.json'}</code>.{' '}
                                <code>metrics.json</code> is optional.
                            </div>
                        ) : null}

                        <div className="ml-fenose-infer-body">
                        <div className="ml-fenose-infer-controls">
                        <div className="ml-fenose-infer-toolbar">
                            <div className="ml-fenose-infer-row ml-fenose-infer-row--model">
                                <label className="ml-fenose-infer-label" htmlFor="fenose-model-select">
                                    Model ({FENOSE_MODEL_FOLDER_NAME}/)
                                </label>
                                <select
                                    id="fenose-model-select"
                                    className="text-input ml-fenose-infer-select-grow"
                                    value={fenosePredictWorkspaceKey}
                                    onChange={(e) => setFenosePredictWorkspaceKey(e.target.value)}
                                    disabled={fenoseRunning || fenoseBatchRunning || savedFenoseModels.length === 0}
                                    title={`Choose a model saved under workspace folder ${FENOSE_MODEL_FOLDER_NAME}/`}
                                >
                                    <option value="">
                                        {savedFenoseModels.length === 0 ? `No models in ${FENOSE_MODEL_FOLDER_NAME}/` : 'Select saved model…'}
                                    </option>
                                    {savedFenoseModels.map((m) => (
                                        <option key={`${m.modelName}::${m.version}`} value={`${m.modelName}::${m.version}`}>
                                            {m.modelName} ({m.version})
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="ml-fenose-infer-row ml-fenose-infer-row--single">
                                <label className="ml-fenose-infer-label" htmlFor="fenose-single-file-select">
                                    Single predict (loaded chart files)
                                </label>
                                <div className="ml-fenose-infer-row-inner">
                                    <select
                                        id="fenose-single-file-select"
                                        className="text-input ml-fenose-infer-select-grow"
                                        value={fenoseSelectedFileId || ''}
                                        onChange={(e) => setFenoseSelectedFileId(e.target.value)}
                                        disabled={files.length === 0 || fenoseRunning || fenoseBatchRunning}
                                        title="Main or comparison file currently loaded for charts"
                                    >
                                        {files.length === 0 ? (
                                            <option value="">No files loaded</option>
                                        ) : (
                                            files.map((f) => (
                                                <option key={f.id} value={f.id}>
                                                    {String(f.name).split(/[/\\]/).pop()}
                                                </option>
                                            ))
                                        )}
                                    </select>
                                    <button
                                        type="button"
                                        className="btn-primary ml-fenose-predict-single-btn"
                                        onClick={runFenosePrediction}
                                        disabled={fenoseRunning || fenoseBatchRunning || files.length === 0 || !fenosePredictWorkspaceKey}
                                        title={selectedInferModel ? `${selectedInferModel.modelName} (${selectedInferModel.version})` : undefined}
                                    >
                                        {fenoseRunning ? <Loader2 className="spinner" size={16} /> : <PlayCircle size={16} />} Predict one
                                    </button>
                                </div>
                            </div>

                            <div className="ml-fenose-batch-inline">
                                <div className="ml-fenose-batch-inline-head">
                                    <FolderOpen size={18} aria-hidden className="ml-fenose-batch-inline-icon" />
                                    <span className="ml-fenose-batch-inline-title">Batch inference</span>
                                </div>
                                <p className="ml-fenose-batch-inline-desc">
                                    Uses the <strong>same files you select in the sidebar</strong>: the main file plus any comparison files (checkbox on a folder = all captures in that folder, or add files with the + button). Runs the model on each CSV/Excel one by one, then shows a chart and table below. Put{' '}
                                    <code>ppb</code> in the filename (e.g. <code>…25ppb.csv</code>) for actual vs predicted plots.
                                </p>
                                <div className="ml-fenose-batch-inline-meta">
                                    <span className="ml-fenose-batch-inline-count" title="Tabular files in sidebar selection (main + comparisons)">
                                        {fenoseBatchWorkspaceEntries.length === 0
                                            ? '0 CSV/Excel files in sidebar selection'
                                            : `${fenoseBatchWorkspaceEntries.length} CSV/Excel file${fenoseBatchWorkspaceEntries.length === 1 ? '' : 's'} ready`}
                                    </span>
                                    {fenoseBatchWorkspaceEntries.length > 0 ? (
                                        <span className="ml-fenose-batch-inline-names" title={fenoseBatchWorkspaceEntries.map((f) => basenameOnly(f.name)).join(', ')}>
                                            {fenoseBatchWorkspaceEntries
                                                .slice(0, 3)
                                                .map((f) => basenameOnly(f.name))
                                                .join(', ')}
                                            {fenoseBatchWorkspaceEntries.length > 3
                                                ? ` +${fenoseBatchWorkspaceEntries.length - 3} more`
                                                : ''}
                                        </span>
                                    ) : null}
                                </div>
                                <button
                                    type="button"
                                    className="btn-primary ml-fenose-batch-run-btn"
                                    onClick={runFenoseBatchPrediction}
                                    disabled={
                                        fenoseBatchRunning ||
                                        fenoseRunning ||
                                        !fenosePredictWorkspaceKey ||
                                        fenoseBatchWorkspaceEntries.length === 0
                                    }
                                    title={
                                        fenoseBatchWorkspaceEntries.length === 0
                                            ? 'Select CSV/Excel files in the sidebar first'
                                            : selectedInferModel
                                              ? `Run ${selectedInferModel.modelName} (${selectedInferModel.version}) on ${fenoseBatchWorkspaceEntries.length} file(s); results appear below`
                                              : undefined
                                    }
                                >
                                    {fenoseBatchRunning ? (
                                        <>
                                            <Loader2 className="spinner" size={18} /> Running batch inference…
                                        </>
                                    ) : (
                                        <>
                                            <FolderOpen size={18} /> Run batch inference — show chart &amp; table
                                        </>
                                    )}
                                </button>
                                {fenoseBatchProgress ? (
                                    <div className="ml-fenose-batch-progress" role="status" aria-live="polite">
                                        <Loader2 className="spinner" size={14} style={{ verticalAlign: 'middle', marginRight: 8 }} />
                                        File {fenoseBatchProgress.current} / {fenoseBatchProgress.total}
                                        {fenoseBatchProgress.name ? ` — ${fenoseBatchProgress.name}` : ''}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                        </div>

                        <div className="ml-fenose-infer-results">
                        {fenoseError ? (
                            <div style={{ color: '#fecaca', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', padding: 12, borderRadius: 10 }}>
                                {fenoseError}
                                <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                    Add a matching weights + preprocessing pair under workspace folder{' '}
                                    <code>{FENOSE_MODEL_FOLDER_NAME}/</code> (train on the Training tab or use Import above).
                                </div>
                            </div>
                        ) : null}

                        {!fenoseResults && fenoseBatchResults == null ? (
                            <div className="empty-placeholder ml-fenose-empty">
                                <FileText size={26} />
                                <p style={{ margin: 0 }}>
                                    Use <strong>Predict one</strong> for the loaded file, or select CSV/Excel files in the sidebar and click <strong>Run batch inference</strong> for the chart and table.
                                </p>
                            </div>
                        ) : null}

                        {fenoseResults ? (
                            <div className="ml-fenose-kpi-grid">
                                <div className="ml-fenose-kpi ml-fenose-kpi--pred">
                                    <div className="ml-fenose-kpi-label">Predicted</div>
                                    <div className="ml-fenose-kpi-value">{fenoseResults[0].predictedPpb} ppb</div>
                                </div>
                                <div className="ml-fenose-kpi ml-fenose-kpi--actual">
                                    <div className="ml-fenose-kpi-label">Actual (from filename)</div>
                                    <div className="ml-fenose-kpi-value">
                                        {fenoseResults[0].actualPpb == null ? '—' : `${fenoseResults[0].actualPpb} ppb`}
                                    </div>
                                </div>
                                <div className="ml-fenose-kpi ml-fenose-kpi--err">
                                    <div className="ml-fenose-kpi-label">Abs error</div>
                                    <div className="ml-fenose-kpi-value">
                                        {fenoseResults[0].absErr == null ? '—' : `${fenoseResults[0].absErr.toFixed(2)} ppb`}
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        {fenoseBatchResults != null ? (
                            <div className="ml-fenose-batch-output">
                                {!fenoseBatchRunning && fenoseBatchScatterChartData.length >= 2 ? (
                                    <div className="ml-fenose-batch-chart-wrap ml-fenose-chart-surface">
                                        <div className="ml-fenose-batch-chart-title">Actual vs predicted (ppb)</div>
                                        <p className="ml-fenose-batch-chart-sub">
                                            Hover points for details. Gray dashed line is ideal (y = x). Use the brush below to zoom the actual-ppb range.
                                        </p>
                                        <ResponsiveContainer width="100%" height={380}>
                                            <ScatterChart margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                                                <XAxis
                                                    type="number"
                                                    dataKey="actual"
                                                    name="Actual"
                                                    tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                                                    label={{ value: 'Actual (ppb)', position: 'insideBottom', offset: -2, fill: 'var(--text-muted)', fontSize: 11 }}
                                                />
                                                <YAxis
                                                    type="number"
                                                    dataKey="predicted"
                                                    name="Predicted"
                                                    tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                                                    width={44}
                                                    label={{ value: 'Predicted (ppb)', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)', fontSize: 11 }}
                                                />
                                                <Tooltip
                                                    cursor={{ strokeDasharray: '4 4' }}
                                                    content={({ active, payload }) => {
                                                        if (!active || !payload?.length) return null;
                                                        const p = payload[0]?.payload;
                                                        if (!p) return null;
                                                        return (
                                                            <div className="ml-fenose-batch-tooltip">
                                                                <div className="ml-fenose-batch-tooltip-name">{p.label}</div>
                                                                <div>Actual: {p.actual} ppb</div>
                                                                <div>Predicted: {p.predicted} ppb</div>
                                                            </div>
                                                        );
                                                    }}
                                                />
                                                <Legend wrapperStyle={{ fontSize: 12 }} />
                                                {fenoseBatchIdentitySegment ? (
                                                    <ReferenceLine
                                                        segment={fenoseBatchIdentitySegment}
                                                        stroke="#94a3b8"
                                                        strokeWidth={2}
                                                        strokeDasharray="6 4"
                                                        ifOverflow="extendDomain"
                                                    />
                                                ) : null}
                                                <Scatter
                                                    data={fenoseBatchScatterChartData}
                                                    fill="#38bdf8"
                                                    name="Captures"
                                                    isAnimationActive={false}
                                                    activeDot={{ r: 8, stroke: '#0ea5e9', strokeWidth: 2, fill: '#e0f2fe' }}
                                                />
                                                {fenoseBatchScatterChartData.length > 4 ? (
                                                    <Brush dataKey="actual" height={24} stroke="#38bdf8" travellerWidth={10} fill="rgba(15,23,42,0.5)" />
                                                ) : null}
                                            </ScatterChart>
                                        </ResponsiveContainer>
                                    </div>
                                ) : !fenoseBatchRunning && fenoseBatchScatterChartData.length === 1 ? (
                                    <div className="ml-fenose-batch-chart-hint">
                                        Add at least two labelled files (…ppb in the name) to draw an actual-vs-predicted scatter plot. Table below lists all runs.
                                    </div>
                                ) : !fenoseBatchRunning && fenoseBatchBarChartData.length > 0 && fenoseBatchScatterChartData.length === 0 ? (
                                    <div className="ml-fenose-batch-chart-wrap ml-fenose-chart-surface">
                                        <div className="ml-fenose-batch-chart-title">Predicted concentration by file (no ppb labels in names)</div>
                                        <p className="ml-fenose-batch-chart-sub">Hover bars for values. Use the brush when many files are selected.</p>
                                        <ResponsiveContainer width="100%" height={Math.min(480, 140 + fenoseBatchBarChartData.length * 26)}>
                                            <BarChart data={fenoseBatchBarChartData} margin={{ top: 8, right: 12, left: 4, bottom: fenoseBatchBarChartData.length > 6 ? 88 : 64 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                                                <XAxis
                                                    dataKey="short"
                                                    tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                                                    interval={0}
                                                    angle={-28}
                                                    textAnchor="end"
                                                    height={70}
                                                />
                                                <YAxis
                                                    dataKey="predicted"
                                                    tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                                                    width={44}
                                                    label={{ value: 'Predicted (ppb)', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)', fontSize: 11 }}
                                                />
                                                <Tooltip
                                                    cursor={{ fill: 'rgba(56, 189, 248, 0.12)' }}
                                                    content={({ active, payload }) => {
                                                        if (!active || !payload?.length) return null;
                                                        const p = payload[0]?.payload;
                                                        return (
                                                            <div className="ml-fenose-batch-tooltip">
                                                                <div>{p?.short}</div>
                                                                <div>Predicted: {p?.predicted} ppb</div>
                                                            </div>
                                                        );
                                                    }}
                                                />
                                                <Bar dataKey="predicted" fill="#38bdf8" name="Predicted ppb" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                                                {fenoseBatchBarChartData.length > 6 ? (
                                                    <Brush dataKey="short" height={24} stroke="#38bdf8" travellerWidth={10} fill="rgba(15,23,42,0.5)" />
                                                ) : null}
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                ) : !fenoseBatchRunning &&
                                  fenoseBatchBarChartData.length === 0 &&
                                  fenoseBatchScatterChartData.length === 0 &&
                                  !fenoseBatchResults.some((r) => !r.error) ? (
                                    <div className="ml-fenose-batch-chart-hint">No successful predictions in this batch. See the table for errors.</div>
                                ) : null}

                                <div className="ml-fenose-batch-table-wrap">
                                    <div className="ml-fenose-batch-chart-title">Results</div>
                                    <div className="ml-fenose-batch-table-scroll">
                                        <table className="ml-fenose-batch-table">
                                            <thead>
                                                <tr>
                                                    <th scope="col">File</th>
                                                    <th scope="col" className="ml-fenose-batch-table-num">
                                                        Actual (ppb)
                                                    </th>
                                                    <th scope="col" className="ml-fenose-batch-table-num">
                                                        Predicted (ppb)
                                                    </th>
                                                    <th scope="col" className="ml-fenose-batch-table-num">
                                                        |Error|
                                                    </th>
                                                    <th scope="col">Status</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {fenoseBatchResults.map((r, idx) => (
                                                    <tr key={`${r.fileName}::${idx}`}>
                                                        <td className="ml-fenose-batch-table-file" title={r.fileName}>
                                                            {r.shortName}
                                                        </td>
                                                        <td className="ml-fenose-batch-table-num">
                                                            {r.actualPpb != null && Number.isFinite(r.actualPpb) ? r.actualPpb : '—'}
                                                        </td>
                                                        <td className="ml-fenose-batch-table-num">
                                                            {r.predictedPpb != null ? r.predictedPpb : '—'}
                                                        </td>
                                                        <td className="ml-fenose-batch-table-num">
                                                            {r.absErr != null ? r.absErr.toFixed(2) : '—'}
                                                        </td>
                                                        <td className={r.error ? 'ml-fenose-batch-table-err' : 'ml-fenose-batch-table-ok'}>{r.error || 'OK'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                        </div>
                        </div>
                    </section>

                    <section
                        id="fenose-panel-training"
                        role="tabpanel"
                        aria-labelledby="fenose-tab-training"
                        hidden={fenoseMainTab !== 'training'}
                        className="ml-fenose-tab-panel plot-card glass-panel ml-fenose-card"
                    >
                        <h3 className="plot-title">Train new model</h3>
                        <p className="ml-fenose-card-desc">
                            Select workspace CSV/Excel files whose names include a concentration (e.g. <code>10ppb</code>). At least three files. Artifacts save to workspace folder{' '}
                            <code>{FENOSE_MODEL_FOLDER_NAME}/</code>. To load weights from disk, use <strong>Import model files</strong> on the Inference tab (only writes to{' '}
                            <code>{FENOSE_MODEL_FOLDER_NAME}/</code>; folder is created if needed).
                        </p>

                        {onAddSyntheticFenoseToWorkspace ? (
                            <div className="ml-fenose-synthetic-panel">
                                <div className="ml-fenose-synthetic-title">
                                    <Sparkles size={18} aria-hidden />
                                    Synthetic demo dataset
                                </div>
                                <p className="ml-fenose-synthetic-desc">
                                    Writes to <code>{FENOSE_SYNTHETIC_FOLDER_NAME}/</code> only. <strong>Select which Aroma Units</strong> below (detected from labelled workspace filenames). Each selected unit gets synthetic CSVs for every concentration, repeated <code>replicates</code> times. Calibration is per unit when possible (≥2 files for that id), else pooled, else built-in. Large jobs (many devices × ppb × replicates) may take a while; rows stay in the database and load when you open a file. Supplement real data — do not rely on synthetic alone.
                                </p>
                                {fenoseSynthAuOptions.length > 0 ? (
                                    <div className="ml-fenose-synth-au-block">
                                        <div className="ml-fenose-synth-au-head">
                                            <span className="ml-fenose-label" style={{ marginBottom: 0 }}>
                                                Aroma Units (workspace)
                                            </span>
                                            <div className="ml-fenose-synth-au-toolbar">
                                                <button
                                                    type="button"
                                                    className="btn-secondary ml-fenose-train-pill-btn"
                                                    onClick={() => setFenoseSynthSelectedAuKeys(fenoseSynthAuOptions.map((o) => o.key))}
                                                    disabled={fenoseSynthBusy || fenoseTrainBusy}
                                                >
                                                    Select all
                                                </button>
                                                <button
                                                    type="button"
                                                    className="btn-secondary ml-fenose-train-pill-btn ml-fenose-train-pill-btn--muted"
                                                    onClick={() => setFenoseSynthSelectedAuKeys([])}
                                                    disabled={fenoseSynthBusy || fenoseTrainBusy}
                                                >
                                                    Clear
                                                </button>
                                            </div>
                                        </div>
                                        <p className="ml-fenose-hint ml-fenose-synth-au-hint">
                                            Device id in the file name should match <code>##########-####-…-nz</code> (e.g. <code>asu-nz</code>, <code>oms-nz</code>); if several appear, the AU token ending in <code>asu-nz</code> is preferred. File count = selected units × ppb list × replicates.
                                        </p>
                                        <div className="ml-fenose-synth-au-list">
                                            {fenoseSynthAuOptions.map((o) => (
                                                <label key={o.key} className="ml-fenose-synth-au-row">
                                                    <input
                                                        type="checkbox"
                                                        checked={fenoseSynthSelectedAuKeys.includes(o.key)}
                                                        onChange={(e) => {
                                                            const on = e.target.checked;
                                                            setFenoseSynthSelectedAuKeys((prev) =>
                                                                on ? [...prev, o.key] : prev.filter((k) => k !== o.key)
                                                            );
                                                        }}
                                                        disabled={fenoseSynthBusy || fenoseTrainBusy}
                                                    />
                                                    <span className="ml-fenose-synth-au-label" title={o.key}>
                                                        {o.label}
                                                    </span>
                                                    <span className="ml-fenose-synth-au-meta">
                                                        {o.fileCount} file{o.fileCount === 1 ? '' : 's'}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <p className="ml-fenose-hint ml-fenose-synth-au-hint">
                                        No labelled workspace captures found — generation uses one built-in calibration bucket and a placeholder device id in filenames. Add real <code>…ppb…</code> CSVs to see selectable Aroma Units.
                                    </p>
                                )}
                                {fenoseSynthPlannedFileCount > 0 ? (
                                    <p className="ml-fenose-synth-plan-preview" role="status">
                                        <strong>{fenoseSynthPlannedFileCount}</strong> synthetic CSV
                                        {fenoseSynthPlannedFileCount === 1 ? '' : 's'} will be created (
                                        {fenoseSynthAuOptions.length > 0 ? `${fenoseSynthSelectedAuKeys.length} selected unit${fenoseSynthSelectedAuKeys.length === 1 ? '' : 's'}` : '1 default run'}
                                        {' × '}
                                        {fenoseSynthConcCount} ppb level{fenoseSynthConcCount === 1 ? '' : 's'} ×{' '}
                                        {Math.max(1, Math.min(200, Math.floor(Number(fenoseSynthReps) || 2)))} replicate
                                        {Math.max(1, Math.min(200, Math.floor(Number(fenoseSynthReps) || 2))) === 1 ? '' : 's'}
                                        ).
                                    </p>
                                ) : fenoseSynthAuOptions.length > 0 ? (
                                    <p className="ml-fenose-synth-plan-preview ml-fenose-synth-plan-preview--muted" role="status">
                                        Select at least one unit and one valid concentration to see the CSV count.
                                    </p>
                                ) : null}
                                {browserStorageEst && browserStorageEst.quota > 0 ? (
                                    <p className="ml-fenose-hint ml-fenose-capacity-meter" role="status">
                                        Browser storage for this site: ~{formatBytes(browserStorageEst.usage)} /{' '}
                                        {formatBytes(browserStorageEst.quota)} (
                                        {Math.round(browserStorageEst.fractionUsed * 100)}% used). This is separate from
                                        total PC RAM; it limits how much the workspace can grow in this browser.
                                    </p>
                                ) : (
                                    <p className="ml-fenose-hint ml-fenose-capacity-meter" role="status">
                                        Storage quota for this site isn&apos;t available in this browser; large uploads or
                                        synthetic batches may still fail if disk or browser limits are reached.
                                    </p>
                                )}
                                {getDeviceMemoryGb() != null ? (
                                    <p className="ml-fenose-hint" role="note">
                                        Reported device memory hint: ~{getDeviceMemoryGb()} GB (Chrome-style estimate only;
                                        not exact RAM).
                                    </p>
                                ) : null}
                                {fenoseSynthPlannedFileCount > 0 &&
                                fenoseSyntheticCapacityHints.messages.length > 0 ? (
                                    <div
                                        className={
                                            fenoseSyntheticCapacityHints.severity === 'severe'
                                                ? 'ml-fenose-capacity-banner ml-fenose-capacity-banner--severe'
                                                : 'ml-fenose-capacity-banner ml-fenose-capacity-banner--warn'
                                        }
                                        role="alert"
                                    >
                                        <strong>
                                            {fenoseSyntheticCapacityHints.severity === 'severe'
                                                ? 'High load warning'
                                                : 'Heads-up'}
                                        </strong>
                                        <ul className="ml-fenose-capacity-banner-list">
                                            {fenoseSyntheticCapacityHints.messages.map((m, i) => (
                                                <li key={i}>{m}</li>
                                            ))}
                                        </ul>
                                        {fenoseSyntheticCapacityHints.severity === 'severe' ? (
                                            <p className="ml-fenose-capacity-banner-foot">
                                                You will be asked to confirm before generation starts.
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}
                                <div className="ml-fenose-synthetic-controls">
                                    <label className="ml-fenose-label">
                                        Concentrations (ppb)
                                        <input
                                            className="text-input ml-fenose-input-full"
                                            value={fenoseSynthConc}
                                            onChange={(e) => setFenoseSynthConc(e.target.value)}
                                            disabled={fenoseSynthBusy || fenoseTrainBusy}
                                            placeholder="0, 10, 25, 50"
                                        />
                                    </label>
                                    <label className="ml-fenose-label">
                                        Replicates per ppb (X per unit)
                                        <input
                                            className="text-input ml-fenose-input-full"
                                            type="number"
                                            min={1}
                                            max={200}
                                            value={fenoseSynthReps}
                                            onChange={(e) => setFenoseSynthReps(Number(e.target.value))}
                                            disabled={fenoseSynthBusy || fenoseTrainBusy}
                                        />
                                    </label>
                                    <label className="ml-fenose-label">
                                        RNG seed
                                        <input
                                            className="text-input ml-fenose-input-full"
                                            type="number"
                                            value={fenoseSynthSeed}
                                            onChange={(e) => setFenoseSynthSeed(Number(e.target.value))}
                                            disabled={fenoseSynthBusy || fenoseTrainBusy}
                                        />
                                    </label>
                                    <div className="ml-fenose-synthetic-actions">
                                        <button
                                            type="button"
                                            className="ml-fenose-btn-generate"
                                            onClick={runAddSyntheticFenose}
                                            disabled={fenoseSynthBusy || fenoseTrainBusy}
                                        >
                                            {fenoseSynthBusy ? <Loader2 className="spinner" size={16} /> : <Sparkles size={16} aria-hidden />}
                                            Generate &amp; add to workspace
                                        </button>
                                    </div>
                                </div>
                                {fenoseSynthMsg ? (
                                    <div
                                        className={
                                            fenoseSynthMsg.type === 'err'
                                                ? 'ml-fenose-synthetic-banner ml-fenose-synthetic-banner--err'
                                                : 'ml-fenose-synthetic-banner ml-fenose-synthetic-banner--ok'
                                        }
                                        role="status"
                                    >
                                        {fenoseSynthMsg.text}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}

                        <div className="ml-fenose-train-layout">
                            <div className="ml-fenose-train-data-block">
                                <label className="ml-fenose-label">Training data (workspace)</label>
                                <div className="ml-fenose-train-cols">
                                    <div className="ml-fenose-file-list">
                                        {fenoseTrainHydrateStatus === 'loading' ? (
                                            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                                <Loader2 className="spinner" size={16} style={{ verticalAlign: 'middle', marginRight: 8 }} />
                                                Loading rows from workspace ({fenosePpbWorkspaceEntries.length} file{fenosePpbWorkspaceEntries.length === 1 ? '' : 's'})…
                                            </div>
                                        ) : trainingCandidates.length === 0 ? (
                                            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                                {fenosePpbWorkspaceEntries.length === 0
                                                    ? 'No workspace CSV/Excel files with “ppb” in the name. Upload captures and use names like …5ppb… .'
                                                    : 'Found labelled files in the sidebar but could not read rows (missing file blob or parse error). Try re-uploading the CSVs.'}
                                            </div>
                                        ) : (
                                            trainingCandidates.map((f) => (
                                                <label key={f.id} className="ml-fenose-file-row">
                                                    <input
                                                        type="checkbox"
                                                        checked={fenoseTrainSelectedIds.includes(f.id)}
                                                        onChange={(e) => {
                                                            const on = e.target.checked;
                                                            setFenoseTrainSelectedIds((prev) => (on ? [...prev, f.id] : prev.filter((x) => x !== f.id)));
                                                        }}
                                                        disabled={fenoseTrainBusy}
                                                    />
                                                    <span className="ml-fenose-file-row-name" title={f.name}>
                                                        {String(f.name).split(/[/\\]/).pop()}
                                                    </span>
                                                </label>
                                            ))
                                        )}
                                    </div>
                                    <div className="ml-fenose-train-side">
                                        <div>
                                            <label className="ml-fenose-label">Model name</label>
                                            <input className="text-input ml-fenose-input-full" value={fenoseModelName} onChange={(e) => setFenoseModelName(e.target.value)} disabled={fenoseTrainBusy} />
                                            <p className="ml-fenose-hint">
                                                Saved to workspace folder <code>{FENOSE_MODEL_FOLDER_NAME}</code> as{' '}
                                                <code>{'{name}_{version}_weights.json'}</code>, etc.
                                            </p>
                                        </div>
                                        <div className="ml-fenose-train-actions" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <button
                                                    type="button"
                                                    className="btn-secondary ml-fenose-train-pill-btn"
                                                    onClick={() => setFenoseTrainSelectedIds(trainingCandidates.map((f) => f.id))}
                                                    disabled={fenoseTrainBusy || trainingCandidates.length === 0}
                                                >
                                                    Select all
                                                </button>
                                                <button type="button" className="btn-secondary ml-fenose-train-pill-btn ml-fenose-train-pill-btn--muted" onClick={() => setFenoseTrainSelectedIds([])} disabled={fenoseTrainBusy}>
                                                    Clear
                                                </button>
                                            </div>
                                            {fenoseSynthAuOptions.length > 0 && (
                                                <select
                                                    className="text-input ml-fenose-input-full"
                                                    defaultValue=""
                                                    onChange={(e) => {
                                                        const k = e.target.value;
                                                        if (!k) return;
                                                        const ids = trainingCandidates.filter(f => {
                                                            const raw = parseFenoseDeviceIdFromFilename(f.name);
                                                            const fKey = raw === 'UNKNOWN' ? FENOSE_SYNTH_UNKNOWN_KEY : String(raw).toUpperCase();
                                                            return fKey === k;
                                                        }).map(f => f.id);
                                                        setFenoseTrainSelectedIds(ids);
                                                        setFenoseModelName(k === FENOSE_SYNTH_UNKNOWN_KEY ? 'fenose_unknown' : `fenose_${k.toLowerCase()}`);
                                                        e.target.value = '';
                                                    }}
                                                    disabled={fenoseTrainBusy}
                                                >
                                                    <option value="">Quick select specific AU…</option>
                                                    {fenoseSynthAuOptions.map(o => (
                                                        <option key={o.key} value={o.key}>{o.label} ({o.fileCount} files)</option>
                                                    ))}
                                                </select>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <fieldset className="ml-fenose-params-fieldset">
                                <legend className="ml-fenose-params-legend">Hyperparameters</legend>
                                <div className="ml-fenose-train-params">
                                    <div className="ml-fenose-param ml-fenose-param--wide">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-version">Version</label>
                                        <select id="fenose-train-version" className="text-input ml-fenose-input-full" value={fenoseTrainVersion} onChange={(e) => setFenoseTrainVersion(e.target.value)} disabled={fenoseTrainBusy}>
                                            <option value="v2">v2 (PCA + scaled)</option>
                                            <option value="v1">v1 (topK + log)</option>
                                        </select>
                                    </div>
                                    <div className="ml-fenose-param">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-topk">Top‑K</label>
                                        <input id="fenose-train-topk" className="text-input ml-fenose-input-full" type="number" value={fenoseTrainTopK} onChange={(e) => setFenoseTrainTopK(e.target.value)} disabled={fenoseTrainBusy} />
                                    </div>
                                    <div className="ml-fenose-param">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-pca">PCA</label>
                                        <input id="fenose-train-pca" className="text-input ml-fenose-input-full" type="number" value={fenoseTrainPca} onChange={(e) => setFenoseTrainPca(e.target.value)} disabled={fenoseTrainBusy || fenoseTrainVersion !== 'v2'} />
                                    </div>
                                    <div className="ml-fenose-param">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-epochs">Epochs</label>
                                        <input
                                            id="fenose-train-epochs"
                                            className="text-input ml-fenose-input-full"
                                            type="number"
                                            value={fenoseTrainEpochs}
                                            onChange={(e) => setFenoseTrainEpochs(e.target.value)}
                                            disabled={
                                                fenoseTrainBusy ||
                                                (fenoseTrainVersion === 'v2' && fenoseV2TrainEngine === ML_ENGINE_RIDGE_PCA)
                                            }
                                        />
                                    </div>
                                    <div className="ml-fenose-param">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-lr">Learning rate</label>
                                        <input
                                            id="fenose-train-lr"
                                            className="text-input ml-fenose-input-full"
                                            type="number"
                                            step="0.0001"
                                            value={fenoseTrainLr}
                                            onChange={(e) => setFenoseTrainLr(e.target.value)}
                                            disabled={
                                                fenoseTrainBusy ||
                                                (fenoseTrainVersion === 'v2' && fenoseV2TrainEngine === ML_ENGINE_RIDGE_PCA)
                                            }
                                        />
                                    </div>
                                    <div className="ml-fenose-param">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-testpct">Test %</label>
                                        <input id="fenose-train-testpct" className="text-input ml-fenose-input-full" type="number" value={fenoseTrainFrac} onChange={(e) => setFenoseTrainFrac(e.target.value)} disabled={fenoseTrainBusy} />
                                    </div>
                                    <div className="ml-fenose-param">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-seed">Seed</label>
                                        <input id="fenose-train-seed" className="text-input ml-fenose-input-full" type="number" value={fenoseTrainSeed} onChange={(e) => setFenoseTrainSeed(e.target.value)} disabled={fenoseTrainBusy} />
                                    </div>
                                </div>
                            </fieldset>

                            {fenoseTrainVersion === 'v2' ? (
                                <fieldset className="ml-fenose-params-fieldset">
                                    <legend className="ml-fenose-params-legend">v2 engine &amp; optional embeddings</legend>
                                    <div className="ml-fenose-train-params">
                                        <div className="ml-fenose-param ml-fenose-param--wide">
                                            <label className="ml-fenose-label" htmlFor="fenose-v2-engine">
                                                Training head
                                            </label>
                                            <select
                                                id="fenose-v2-engine"
                                                className="text-input ml-fenose-input-full"
                                                value={fenoseV2TrainEngine}
                                                onChange={(e) => setFenoseV2TrainEngine(e.target.value)}
                                                disabled={fenoseTrainBusy}
                                            >
                                                {FENOSE_V2_TRAINING_ENGINES.map((eng) => (
                                                    <option key={eng.id} value={eng.id}>
                                                        {eng.label}
                                                    </option>
                                                ))}
                                            </select>
                                            <p className="ml-fenose-hint" style={{ marginTop: 6 }}>
                                                {FENOSE_V2_TRAINING_ENGINES.find((e) => e.id === fenoseV2TrainEngine)?.description}
                                            </p>
                                        </div>
                                        <div className="ml-fenose-param">
                                            <label className="ml-fenose-label" htmlFor="fenose-v2-ridge-lambda">
                                                Ridge λ
                                            </label>
                                            <input
                                                id="fenose-v2-ridge-lambda"
                                                className="text-input ml-fenose-input-full"
                                                type="number"
                                                step="0.001"
                                                min="1e-8"
                                                value={fenoseV2RidgeLambda}
                                                onChange={(e) => setFenoseV2RidgeLambda(e.target.value)}
                                                disabled={fenoseTrainBusy || fenoseV2TrainEngine !== ML_ENGINE_RIDGE_PCA}
                                            />
                                        </div>
                                        <div className="ml-fenose-param ml-fenose-param--wide">
                                            <label className="ml-fenose-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <input
                                                    type="checkbox"
                                                    checked={fenoseV2TextEmbed}
                                                    onChange={(e) => setFenoseV2TextEmbed(e.target.checked)}
                                                    disabled={fenoseTrainBusy}
                                                />
                                                Augment with Transformers.js text embeddings (device + filename → MiniLM slice)
                                            </label>
                                            <p className="ml-fenose-hint" style={{ marginTop: 4 }}>
                                                Uses a small WASM model; first run downloads weights. Keep slice dimensions low (e.g. 8–16) for bundle and memory.
                                            </p>
                                        </div>
                                        <div className="ml-fenose-param">
                                            <label className="ml-fenose-label" htmlFor="fenose-v2-embed-dims">
                                                Embed dims
                                            </label>
                                            <input
                                                id="fenose-v2-embed-dims"
                                                className="text-input ml-fenose-input-full"
                                                type="number"
                                                min="2"
                                                max="32"
                                                value={fenoseV2TextEmbedDims}
                                                onChange={(e) => setFenoseV2TextEmbedDims(e.target.value)}
                                                disabled={fenoseTrainBusy || !fenoseV2TextEmbed}
                                            />
                                        </div>
                                    </div>
                                    <p className="ml-fenose-hint" style={{ marginTop: 10, marginBottom: 0 }}>
                                        <strong>ONNX Runtime Web:</strong> {ONNX_INFERENCE_HINT}
                                    </p>
                                </fieldset>
                            ) : null}

                            <div className="ml-fenose-train-run-row">
                                <button type="button" className="btn-primary" onClick={runFenoseTraining} disabled={fenoseTrainBusy || fenoseTrainHydrateStatus === 'loading' || fenoseTrainEffectiveSelectionCount < 3}>
                                    {fenoseTrainBusy ? <Loader2 className="spinner" size={16} /> : <Brain size={16} />} Train FeNOse ({fenoseTrainVersion})
                                </button>
                                {fenoseTrainProgress ? (
                                    <div className="ml-fenose-train-progress">
                                        {fenoseTrainProgress.phase === 'txt_embed' ? (
                                            <>
                                                Text embeddings{' '}
                                                {fenoseTrainProgress.index}/{fenoseTrainProgress.total}
                                            </>
                                        ) : fenoseTrainProgress.phase === 'ridge' ? (
                                            <>Ridge fit (closed-form)</>
                                        ) : (
                                            <>
                                                Epoch {fenoseTrainProgress.epoch}
                                                {fenoseTrainProgress.loss != null
                                                    ? ` · loss ${Number(fenoseTrainProgress.loss).toFixed(4)}`
                                                    : ''}
                                            </>
                                        )}
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        {fenoseTrainBusy || fenoseTrainOut ? (
                            <div ref={fenoseTrainLossChartRef} className="ml-fenose-chart-card ml-fenose-train-loss-card">
                                <div className="ml-fenose-chart-head">
                                    <span className="ml-fenose-chart-title">Training loss vs epoch</span>
                                    {fenoseTrainBusy ? <span className="ml-fenose-chart-badge">Training…</span> : null}
                                </div>
                                {fenoseTrainLossHistory.length === 0 && fenoseTrainBusy ? (
                                    <div className="ml-fenose-train-loss-placeholder" role="status" aria-live="polite">
                                        <Loader2 className="spinner" size={22} aria-hidden />
                                        <span>Starting training… the loss curve appears after the first epoch completes.</span>
                                    </div>
                                ) : fenoseTrainLossHistory.length > 0 ? (
                                    <>
                                        <div className="ml-fenose-chart-body">
                                            <ResponsiveContainer width="100%" height={fenoseTrainLossHistory.length > 40 ? 320 : 280}>
                                                <LineChart data={fenoseTrainLossHistory} margin={{ top: 8, right: 12, left: 0, bottom: fenoseTrainLossHistory.length > 30 ? 28 : 8 }}>
                                                    <CartesianGrid strokeDasharray="3 3" opacity={0.12} />
                                                    <XAxis dataKey="epoch" stroke="var(--text-muted)" fontSize={11} />
                                                    <YAxis stroke="var(--text-muted)" fontSize={11} width={48} />
                                                    <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
                                                    <Line
                                                        type="monotone"
                                                        dataKey="loss"
                                                        stroke="#38bdf8"
                                                        dot={fenoseTrainLossHistory.length < 40}
                                                        strokeWidth={2}
                                                        isAnimationActive={false}
                                                        activeDot={{ r: 5, stroke: '#0ea5e9', strokeWidth: 2 }}
                                                    />
                                                    {fenoseTrainLossHistory.length > 30 ? (
                                                        <Brush dataKey="epoch" height={22} stroke="#38bdf8" travellerWidth={10} fill="rgba(15,23,42,0.5)" />
                                                    ) : null}
                                                </LineChart>
                                            </ResponsiveContainer>
                                        </div>
                                        {fenoseTrainLossHistory.length === 1 ? (
                                            <p className="ml-fenose-hint" style={{ margin: '8px 0 0' }}>
                                                More points appear as training continues.
                                            </p>
                                        ) : null}
                                    </>
                                ) : fenoseTrainOut ? (
                                    <p className="ml-fenose-hint" style={{ margin: 0 }}>
                                        No loss history was recorded for this run (unexpected). Metrics below still reflect the hold-out set.
                                    </p>
                                ) : null}
                            </div>
                        ) : null}

                        {fenoseTrainErr ? (
                            <div style={{ marginTop: 12, color: '#fecaca', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', padding: 12, borderRadius: 10 }}>
                                {fenoseTrainErr}
                            </div>
                        ) : null}

                        {fenoseTrainOut && fenoseTrainValScatterData.length > 0 ? (
                            <div ref={fenoseTrainValChartRef} className="ml-fenose-chart-card ml-fenose-chart-surface ml-fenose-train-val-card">
                                <div className="ml-fenose-chart-head">
                                    <span className="ml-fenose-chart-title">Hold-out validation: actual vs predicted (ppb)</span>
                                </div>
                                <p className="ml-fenose-batch-chart-sub" style={{ marginBottom: 10 }}>
                                    Each point is one file in the stratified test split ({fenoseTrainOut.metrics.testCount} sample{fenoseTrainOut.metrics.testCount === 1 ? '' : 's'}). Gray dashed line is ideal (y = x).
                                </p>
                                <ResponsiveContainer width="100%" height={fenoseTrainValScatterData.length === 1 ? 260 : 340}>
                                    <ScatterChart margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                                        <XAxis
                                            type="number"
                                            dataKey="actual"
                                            name="Actual"
                                            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                                            label={{ value: 'Actual (ppb)', position: 'insideBottom', offset: -2, fill: 'var(--text-muted)', fontSize: 11 }}
                                        />
                                        <YAxis
                                            type="number"
                                            dataKey="predicted"
                                            name="Predicted"
                                            width={44}
                                            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                                            label={{ value: 'Predicted (ppb)', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)', fontSize: 11 }}
                                        />
                                        <Tooltip
                                            cursor={{ strokeDasharray: '4 4' }}
                                            content={({ active, payload }) => {
                                                if (!active || !payload?.length) return null;
                                                const p = payload[0]?.payload;
                                                if (!p) return null;
                                                return (
                                                    <div className="ml-fenose-batch-tooltip">
                                                        <div className="ml-fenose-batch-tooltip-name">{p.label}</div>
                                                        <div>Actual: {p.actual} ppb</div>
                                                        <div>Predicted: {p.predicted} ppb</div>
                                                    </div>
                                                );
                                            }}
                                        />
                                        <Legend wrapperStyle={{ fontSize: 12 }} />
                                        {fenoseTrainValIdentitySegment ? (
                                            <ReferenceLine
                                                segment={fenoseTrainValIdentitySegment}
                                                stroke="#94a3b8"
                                                strokeWidth={2}
                                                strokeDasharray="6 4"
                                                ifOverflow="extendDomain"
                                            />
                                        ) : null}
                                        <Scatter
                                            data={fenoseTrainValScatterData}
                                            fill="#a78bfa"
                                            name="Test set"
                                            isAnimationActive={false}
                                            activeDot={{ r: 8, stroke: '#8b5cf6', strokeWidth: 2, fill: '#ede9fe' }}
                                        />
                                        {fenoseTrainValScatterData.length > 4 ? (
                                            <Brush dataKey="actual" height={24} stroke="#a78bfa" travellerWidth={10} fill="rgba(15,23,42,0.5)" />
                                        ) : null}
                                    </ScatterChart>
                                </ResponsiveContainer>
                            </div>
                        ) : null}

                        {fenoseTrainOut ? (
                            <div className="ml-fenose-train-results">
                                <div className="ml-fenose-metrics-grid">
                                    <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', padding: 12, borderRadius: 10 }}>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>MAE</div>
                                        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#10b981' }}>{fenoseTrainOut.metrics.MAE_ppb.toFixed(2)} ppb</div>
                                    </div>
                                    <div style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', padding: 12, borderRadius: 10 }}>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>RMSE</div>
                                        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#38bdf8' }}>{fenoseTrainOut.metrics.RMSE_ppb.toFixed(2)} ppb</div>
                                    </div>
                                    <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', padding: 12, borderRadius: 10 }}>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Train / Test</div>
                                        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f59e0b' }}>{fenoseTrainOut.metrics.trainCount} / {fenoseTrainOut.metrics.testCount}</div>
                                    </div>
                                    <div style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)', padding: 12, borderRadius: 10 }}>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Artifacts</div>
                                        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                                            <button className="btn-secondary" onClick={() => downloadJson(fenoseTrainOut.weights, `fenose_${fenoseTrainVersion}_weights.json`)}>
                                                <Download size={14} /> weights.json
                                            </button>
                                            <button className="btn-secondary" onClick={() => downloadJson(fenoseTrainOut.preprocessing, `fenose_${fenoseTrainVersion}_preprocessing.json`)}>
                                                <Download size={14} /> preprocessing.json
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                    </section>
                </div>
            </main>
        </div>
    );
};

export default MLStudioPage;
