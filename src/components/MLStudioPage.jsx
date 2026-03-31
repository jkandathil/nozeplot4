import React, { useState, useMemo, useEffect } from 'react';
import { Brain, PlayCircle, FileText, Download, Loader2 } from 'lucide-react';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { predictFenosePpbV1FromRows, predictFenosePpbV2FromRows, trainFenoseV1FromFiles, trainFenoseV2FromFiles } from '../utils/fenoseModel.js';
import { parseFile } from '../utils/fileParser.js';
import './MLStudioPage.css';

function looksLikeFenoseLabelledTabular(name) {
    const n = String(name || '');
    const lower = n.toLowerCase();
    const hasPpb = /(\d+(?:\.\d+)?)\s*ppb/i.test(n);
    const tabular = lower.endsWith('.csv') || lower.endsWith('.xlsx') || lower.endsWith('.xls');
    return hasPpb && tabular;
}

const MLStudioPage = ({ data, fileName, compareDataList = [], workspaceFiles = [], onSaveJsonToWorkspace = null }) => {
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
    const [fenoseTrainBusy, setFenoseTrainBusy] = useState(false);
    const [fenoseTrainProgress, setFenoseTrainProgress] = useState(null); // {epoch, loss}
    const [fenoseTrainOut, setFenoseTrainOut] = useState(null); // {weights, preprocessing, metrics}
    const [fenoseTrainErr, setFenoseTrainErr] = useState('');
    const [fenoseTrainLossHistory, setFenoseTrainLossHistory] = useState([]);
    const [fenoseModelName, setFenoseModelName] = useState('fenose');
    const [fenoseMainTab, setFenoseMainTab] = useState('inference'); // inference | training

    // Saved models in workspace folder "Model"
    const savedFenoseModels = useMemo(() => {
        const modelFolder = (workspaceFiles || []).find((f) => f.isFolder && String(f.name).toLowerCase() === 'model');
        if (!modelFolder) return [];
        const inFolder = (workspaceFiles || []).filter((f) => !f.isFolder && f.folderId === modelFolder.id);
        const models = new Map(); // key: name|version
        for (const f of inFolder) {
            const base = String(f.name || '');
            const m = base.match(/^(.*)_(v1|v2)_(weights|preprocessing|metrics)\.json$/i);
            if (!m) continue;
            const modelName = m[1];
            const version = m[2].toLowerCase();
            const kind = m[3].toLowerCase();
            const key = `${modelName}::${version}`;
            if (!models.has(key)) models.set(key, { modelName, version });
            models.get(key)[kind] = f;
        }
        return Array.from(models.values()).filter((m) => m.weights && m.preprocessing);
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
        if (!fenoseSelectedFileId && fileName) setFenoseSelectedFileId(fileName);
    }, [fileName, fenoseSelectedFileId]);

    const parseActualPpbFromName = (name) => {
        const b = String(name || '').split(/[/\\]/).pop() || '';
        const m = b.match(/(\d+(?:\.\d+)?)\s*ppb\b/i);
        return m ? parseFloat(m[1]) : null;
    };

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
                    : await predictFenosePpbV2FromRows(sel.data, { weights, preprocessing });
            const actual = parseActualPpbFromName(sel.fileName);
            const absErr = actual != null ? Math.abs(predicted - actual) : null;
            setFenoseResults([{ fileName: sel.fileName, predictedPpb: predicted, actualPpb: actual, absErr }]);
        } catch (e) {
            setFenoseError(e?.message || 'FeNOse prediction failed.');
        } finally {
            setFenoseRunning(false);
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
                          },
                          onProgress
                      );
            setFenoseTrainOut(out);

            // Save into workspace folder "Model" if handler provided
            const safeName = String(fenoseModelName || 'fenose').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'fenose';
            if (onSaveJsonToWorkspace) {
                await onSaveJsonToWorkspace({ folderName: 'Model', fileName: `${safeName}_${fenoseTrainVersion}_weights.json`, json: out.weights });
                await onSaveJsonToWorkspace({ folderName: 'Model', fileName: `${safeName}_${fenoseTrainVersion}_preprocessing.json`, json: out.preprocessing });
                await onSaveJsonToWorkspace({ folderName: 'Model', fileName: `${safeName}_${fenoseTrainVersion}_metrics.json`, json: out.metrics });
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
                        <h3 className="plot-title">Predict concentration</h3>
                        <p className="ml-fenose-card-desc">
                            Expects FeNOse-style captures: <code>event_name</code> phases (e.g. AmbientSamplingRFC, FeNOMeasurement) and sensor columns A1–H8. Choose a model from workspace folder <code>Model/</code> (train here or upload the JSON pair from disk).
                        </p>

                        {savedFenoseModels.length === 0 ? (
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
                                No models in workspace yet. Use the <strong>Training</strong> tab to train and save into <code>Model/</code>, or create that folder in the sidebar and upload{' '}
                                <code>{'{name}_{v1|v2}_weights.json'}</code> plus matching <code>preprocessing.json</code> and <code>metrics.json</code> (optional).
                            </div>
                        ) : null}

                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                            <select
                                className="text-input"
                                value={fenosePredictWorkspaceKey}
                                onChange={(e) => setFenosePredictWorkspaceKey(e.target.value)}
                                style={{ minWidth: 260, maxWidth: 520 }}
                                disabled={fenoseRunning || savedFenoseModels.length === 0}
                                title="Choose a model saved under workspace folder Model/"
                            >
                                <option value="">{savedFenoseModels.length === 0 ? 'No models in Model/' : 'Select saved model…'}</option>
                                {savedFenoseModels.map((m) => (
                                    <option key={`${m.modelName}::${m.version}`} value={`${m.modelName}::${m.version}`}>
                                        {m.modelName} ({m.version})
                                    </option>
                                ))}
                            </select>

                            <select
                                className="text-input"
                                value={fenoseSelectedFileId || ''}
                                onChange={(e) => setFenoseSelectedFileId(e.target.value)}
                                style={{ minWidth: 280, maxWidth: 520 }}
                                disabled={files.length === 0}
                                title="Choose which loaded file to run the predictor on"
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
                                className="btn-primary"
                                onClick={runFenosePrediction}
                                disabled={fenoseRunning || files.length === 0 || !fenosePredictWorkspaceKey}
                                title={selectedInferModel ? `${selectedInferModel.modelName} (${selectedInferModel.version})` : undefined}
                            >
                                {fenoseRunning ? <Loader2 className="spinner" size={16} /> : <PlayCircle size={16} />} Predict
                                {selectedInferModel ? ` · ${selectedInferModel.modelName} (${selectedInferModel.version})` : ''}
                            </button>
                        </div>

                        {fenoseError ? (
                            <div style={{ color: '#fecaca', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', padding: 12, borderRadius: 10 }}>
                                {fenoseError}
                                <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                                    Add a matching weights + preprocessing pair under workspace folder <code>Model/</code> (train on the Training tab or upload files).
                                </div>
                            </div>
                        ) : null}

                        {!fenoseResults ? (
                            <div className="empty-placeholder ml-fenose-empty">
                                <FileText size={26} />
                                <p style={{ margin: 0 }}>Choose the main or comparison file above, then run predict.</p>
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))', gap: 12 }}>
                                <div style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', padding: 12, borderRadius: 10 }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Predicted</div>
                                    <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#38bdf8' }}>{fenoseResults[0].predictedPpb} ppb</div>
                                </div>
                                <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', padding: 12, borderRadius: 10 }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Actual (from filename)</div>
                                    <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#f59e0b' }}>
                                        {fenoseResults[0].actualPpb == null ? '—' : `${fenoseResults[0].actualPpb} ppb`}
                                    </div>
                                </div>
                                <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', padding: 12, borderRadius: 10 }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Abs Error</div>
                                    <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#10b981' }}>
                                        {fenoseResults[0].absErr == null ? '—' : `${fenoseResults[0].absErr.toFixed(2)} ppb`}
                                    </div>
                                </div>
                            </div>
                        )}
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
                            Select workspace CSV/Excel files whose names include a concentration (e.g. <code>10ppb</code>). At least three files. Artifacts save to workspace folder <code>Model/</code>.
                        </p>

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
                                            <p className="ml-fenose-hint">Saved to workspace folder <code>Model</code> as <code>{'{name}_{version}_weights.json'}</code>, etc.</p>
                                        </div>
                                        <div className="ml-fenose-train-actions">
                                            <button type="button" className="btn-secondary" onClick={() => setFenoseTrainSelectedIds(trainingCandidates.map((f) => f.id))} disabled={fenoseTrainBusy || trainingCandidates.length === 0}>
                                                Select all
                                            </button>
                                            <button type="button" className="btn-secondary" onClick={() => setFenoseTrainSelectedIds([])} disabled={fenoseTrainBusy}>
                                                Clear
                                            </button>
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
                                        <input id="fenose-train-epochs" className="text-input ml-fenose-input-full" type="number" value={fenoseTrainEpochs} onChange={(e) => setFenoseTrainEpochs(e.target.value)} disabled={fenoseTrainBusy} />
                                    </div>
                                    <div className="ml-fenose-param">
                                        <label className="ml-fenose-label" htmlFor="fenose-train-lr">Learning rate</label>
                                        <input id="fenose-train-lr" className="text-input ml-fenose-input-full" type="number" step="0.0001" value={fenoseTrainLr} onChange={(e) => setFenoseTrainLr(e.target.value)} disabled={fenoseTrainBusy} />
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

                            <div className="ml-fenose-train-run-row">
                                <button type="button" className="btn-primary" onClick={runFenoseTraining} disabled={fenoseTrainBusy || fenoseTrainHydrateStatus === 'loading' || fenoseTrainEffectiveSelectionCount < 3}>
                                    {fenoseTrainBusy ? <Loader2 className="spinner" size={16} /> : <Brain size={16} />} Train FeNOse ({fenoseTrainVersion})
                                </button>
                                {fenoseTrainProgress ? (
                                    <div className="ml-fenose-train-progress">
                                        Epoch {fenoseTrainProgress.epoch}
                                        {fenoseTrainProgress.loss != null ? ` · loss ${Number(fenoseTrainProgress.loss).toFixed(4)}` : ''}
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        {(fenoseTrainBusy || fenoseTrainOut) && fenoseTrainLossHistory.length > 0 ? (
                            <div className="ml-fenose-chart-card">
                                <div className="ml-fenose-chart-head">
                                    <span className="ml-fenose-chart-title">Loss vs epoch</span>
                                    {fenoseTrainBusy ? <span className="ml-fenose-chart-badge">Training…</span> : null}
                                </div>
                                <div className="ml-fenose-chart-body">
                                    <ResponsiveContainer width="100%" height={280}>
                                        <LineChart data={fenoseTrainLossHistory} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                                            <CartesianGrid strokeDasharray="3 3" opacity={0.12} />
                                            <XAxis dataKey="epoch" stroke="var(--text-muted)" fontSize={11} />
                                            <YAxis stroke="var(--text-muted)" fontSize={11} width={48} />
                                            <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
                                            <Line type="monotone" dataKey="loss" stroke="#38bdf8" dot={fenoseTrainLossHistory.length < 40} strokeWidth={2} isAnimationActive={false} />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                                {fenoseTrainLossHistory.length === 1 ? (
                                    <p className="ml-fenose-hint" style={{ margin: '8px 0 0' }}>More points appear as training continues.</p>
                                ) : null}
                            </div>
                        ) : null}

                        {fenoseTrainErr ? (
                            <div style={{ marginTop: 12, color: '#fecaca', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', padding: 12, borderRadius: 10 }}>
                                {fenoseTrainErr}
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
