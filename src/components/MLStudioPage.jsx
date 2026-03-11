import React, { useState, useMemo, useEffect } from 'react';
import { Brain, Settings2, ScatterChart as ScatterChartIcon, PlayCircle, FileText } from 'lucide-react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList, Cell, ZAxis } from 'recharts';
import { PCA } from 'ml-pca';
import { RandomForestRegression as RFRegression, RandomForestClassifier as RFClassifier } from 'ml-random-forest';
import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import { Matrix } from 'ml-matrix';
import tsnejs from 'tsne';
import './MLStudioPage.css';

const MLStudioPage = ({ files }) => {
    const [targetColName, setTargetColName] = useState('Voltage');
    const [taskType, setTaskType] = useState('regression'); // regression or classification

    // User-entered mapping: fileId -> targetValue
    const [targetMap, setTargetMap] = useState({});

    // Layout
    const [sidebarWidth, setSidebarWidth] = useState(380);

    const handleMouseDown = React.useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebarWidth;

        const onMouseMove = (moveEvent) => {
            let newWidth = startWidth + (moveEvent.clientX - startX);
            if (newWidth < 300) newWidth = 300;
            if (newWidth > 600) newWidth = 600;
            setSidebarWidth(newWidth);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'default';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'col-resize';
    }, [sidebarWidth]);

    // Extracted features
    const allFeatures = useMemo(() => {
        const result = [];
        for (const file of files) {
            if (!file.data || file.data.length === 0) continue;

            let colKey = targetColName;
            const keys = Object.keys(file.data[0]);
            if (!keys.includes(colKey)) {
                colKey = keys.find(k => k.toLowerCase() !== 'time' && k.toLowerCase() !== 'date' && k.toLowerCase() !== 'datetime') || keys[1] || keys[0];
            }

            const values = file.data.map(row => parseFloat(row[colKey])).filter(v => !isNaN(v));
            if (values.length === 0) continue;

            const n = values.length;
            let baseline = 0;
            const baseLen = Math.max(1, Math.floor(n * 0.05));
            for (let i = 0; i < baseLen; i++) baseline += values[i];
            baseline /= baseLen;

            const bcValues = values.map(v => v - baseline);

            let maxPeak = -Infinity;
            let minPeak = Infinity;
            let area = 0;

            for (const v of bcValues) {
                if (v > maxPeak) maxPeak = v;
                if (v < minPeak) minPeak = v;
                area += v;
            }

            const mean = values.reduce((a, b) => a + b, 0) / n;
            const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
            const stdDev = Math.sqrt(variance);

            result.push({
                fileId: file.id,
                fileName: file.name,
                features: { maxPeak, minPeak, area, baseline, stdDev, mean }
            });
        }
        return result;
    }, [files, targetColName]);

    // Guess targets
    useEffect(() => {
        const map = { ...targetMap };
        let changed = false;

        allFeatures.forEach(f => {
            if (map[f.fileId] === undefined) {
                const match = f.fileName.match(/_([0-9.]+)p/i);
                if (match) {
                    map[f.fileId] = match[1];
                } else {
                    const match2 = f.fileName.match(/_([a-zA-Z0-9]+)\.csv/i);
                    map[f.fileId] = match2 ? match2[1] : '';
                }
                changed = true;
            }
        });
        if (changed) {
            setTargetMap(map);
        }
    }, [allFeatures]);

    // Auto-train PCA & tSNE
    const [dimRedResults, setDimRedResults] = useState(null);
    const [tsneRunning, setTsneRunning] = useState(false);

    const runDimensionalityReduction = () => {
        if (allFeatures.length < 3) return; // Need a few samples

        const featureKeys = ['maxPeak', 'minPeak', 'area', 'baseline', 'stdDev', 'mean'];
        const matrixList = allFeatures.map(f => featureKeys.map(k => f.features[k]));

        // Normalize columns (standard scaling)
        const M = new Matrix(matrixList);
        for (let col = 0; col < M.columns; col++) {
            const colData = M.getColumn(col);
            const mean = colData.reduce((a, b) => a + b, 0) / colData.length;
            const std = Math.sqrt(colData.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / colData.length) || 1e-6;
            for (let row = 0; row < M.rows; row++) {
                M.set(row, col, (M.get(row, col) - mean) / std);
            }
        }

        try {
            // PCA
            const pca = new PCA(M);
            const pcaData = pca.predict(M).to2DArray();

            // t-SNE
            setTsneRunning(true);
            setTimeout(() => {
                const tsneModel = new tsnejs.tSNE({
                    dim: 2,
                    perplexity: Math.min(Math.floor(allFeatures.length / 3), 30),
                    epsilon: 10
                });
                tsneModel.initDataRaw(M.to2DArray());

                // Run iterations
                for (let k = 0; k < 500; k++) {
                    tsneModel.step();
                }

                const tsneData = tsneModel.getSolution();

                const finalResults = allFeatures.map((f, i) => ({
                    fileName: f.fileName,
                    target: targetMap[f.fileId],
                    pcaX: pcaData[i][0],
                    pcaY: pcaData[i][1],
                    tsneX: tsneData[i][0],
                    tsneY: tsneData[i][1],
                    color: getColorForTarget(targetMap[f.fileId])
                }));

                setDimRedResults(finalResults);
                setTsneRunning(false);
            }, 100);

        } catch (e) {
            console.error("Dim reduction error", e);
            setTsneRunning(false);
        }
    };

    // Train Predictive Model
    const [modelResults, setModelResults] = useState(null);
    const [algorithm, setAlgorithm] = useState('RandomForest'); // 'RandomForest' or 'Linear'

    const colorPalette = ['#38bdf8', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e'];
    let colorMemo = {};
    let colIdx = 0;
    const getColorForTarget = (val) => {
        if (!val || val === '') return '#94a3b8'; // default gray
        if (!colorMemo[val]) {
            colorMemo[val] = colorPalette[colIdx % colorPalette.length];
            colIdx++;
        }
        return colorMemo[val];
    };

    const runModelTraining = () => {
        if (allFeatures.length < 3) return;

        const featureKeys = ['maxPeak', 'minPeak', 'area', 'baseline', 'stdDev', 'mean'];
        const X = allFeatures.map(f => featureKeys.map(k => f.features[k]));

        let Y;
        try {
            if (taskType === 'regression') {
                Y = allFeatures.map(f => [parseFloat(targetMap[f.fileId]) || 0]);

                let predictions;
                if (algorithm === 'RandomForest') {
                    const options = {
                        seed: 42,
                        maxFeatures: 1.0,
                        replacement: true,
                        nEstimators: 50
                    };
                    const y1D = Y.map(v => v[0]);
                    const reg = new RFRegression(options);
                    reg.train(X, y1D);
                    predictions = reg.predict(X);
                } else {
                    const mlr = new MultivariateLinearRegression(X, Y);
                    predictions = mlr.predict(X).map(v => v[0]);
                }

                // Calc R^2
                const yTrue = Y.map(v => v[0]);
                const yMean = yTrue.reduce((a, b) => a + b, 0) / yTrue.length;
                const ssTot = yTrue.reduce((a, b) => a + Math.pow(b - yMean, 2), 0);
                const ssRes = yTrue.reduce((a, b, i) => a + Math.pow(b - predictions[i], 2), 0);
                const r2 = 1 - (ssRes / (ssTot || 1));

                setModelResults({
                    metricName: 'R² Score',
                    metricValue: r2.toFixed(3),
                    plotData: allFeatures.map((f, i) => ({
                        fileName: f.fileName,
                        actual: yTrue[i],
                        predicted: predictions[i]
                    }))
                });

            } else {
                // Classification
                Y = allFeatures.map(f => targetMap[f.fileId] || 'Unknown');

                if (algorithm === 'RandomForest') {
                    const options = {
                        seed: 42,
                        maxFeatures: 2.0,
                        replacement: true,
                        nEstimators: 50
                    };
                    const classifier = new RFClassifier(options);
                    classifier.train(X, Y);
                    const predictions = classifier.predict(X);

                    let correct = 0;
                    for (let i = 0; i < Y.length; i++) {
                        if (Y[i] === predictions[i]) correct++;
                    }
                    const accuracy = correct / Y.length;

                    setModelResults({
                        metricName: 'Accuracy',
                        metricValue: (accuracy * 100).toFixed(1) + '%',
                        plotData: allFeatures.map((f, i) => ({
                            fileName: f.fileName,
                            actual: Y[i],
                            predicted: predictions[i],
                            match: Y[i] === predictions[i] ? 'Yes' : 'No'
                        }))
                    });
                } else {
                    alert("Linear Regression not suitable for Classification. Use Random Forest.");
                }
            }
        } catch (e) {
            console.error("Training error", e);
            alert("Model training failed. Check data format and targets (must be numbers for regression).");
        }
    };

    return (
        <div className="ml-studio-page">
            <aside className="ml-sidebar glass-panel" style={{ width: sidebarWidth, position: 'relative' }}>
                <div
                    onMouseDown={handleMouseDown}
                    style={{
                        position: 'absolute',
                        top: 0,
                        right: -5,
                        width: '10px',
                        height: '100%',
                        cursor: 'col-resize',
                        zIndex: 10,
                    }}
                />

                <h3 className="sidebar-title"><Settings2 size={18} /> Preprocessing & Targets</h3>

                <div className="form-group">
                    <label>Main Sensor Column</label>
                    <input
                        type="text"
                        value={targetColName}
                        onChange={e => setTargetColName(e.target.value)}
                        className="text-input"
                    />
                    <small style={{ color: 'var(--text-muted)' }}>We will extract Baseline, Peak, and Area from this column.</small>
                </div>

                <div className="form-group" style={{ marginTop: 16 }}>
                    <label>Task Type</label>
                    <select
                        className="text-input"
                        value={taskType}
                        onChange={e => setTaskType(e.target.value)}
                    >
                        <option value="regression">Regression (Predict Concentration)</option>
                        <option value="classification">Classification (Predict Category/Gas)</option>
                    </select>
                </div>

                <div className="targets-section">
                    <label style={{ marginBottom: 8, display: 'block', fontWeight: 600 }}>Map Targets</label>
                    <div className="targets-list">
                        {allFeatures.map(f => (
                            <div key={f.fileId} className="target-item">
                                <span className="file-name" title={f.fileName}>{f.fileName}</span>
                                <input
                                    type="text"
                                    className="text-input small"
                                    placeholder="Label/Val"
                                    value={targetMap[f.fileId] || ''}
                                    onChange={e => setTargetMap({ ...targetMap, [f.fileId]: e.target.value })}
                                />
                            </div>
                        ))}
                        {allFeatures.length === 0 && (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', padding: 12 }}>
                                No files uploaded.
                            </div>
                        )}
                    </div>
                </div>

                <div className="action-buttons">
                    <button className="btn-primary" onClick={runDimensionalityReduction} disabled={allFeatures.length < 3}>
                        <ScatterChartIcon size={16} /> Run PCA & t-SNE
                    </button>

                    <div className="form-group" style={{ marginTop: 16 }}>
                        <label>Training Algorithm</label>
                        <select
                            className="text-input"
                            value={algorithm}
                            onChange={e => setAlgorithm(e.target.value)}
                        >
                            <option value="RandomForest">Random Forest</option>
                            {taskType === 'regression' && <option value="Linear">Multivariate Linear</option>}
                        </select>
                    </div>

                    <button className="btn-primary" onClick={runModelTraining} style={{ marginTop: 8 }} disabled={allFeatures.length < 3}>
                        <Brain size={16} /> Train Model
                    </button>
                </div>
            </aside>

            <main className="ml-content">
                <div className="header-bar">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div className="icon-wrapper" style={{ background: 'rgba(56, 189, 248, 0.15)', borderColor: 'rgba(56, 189, 248, 0.3)', padding: 8, borderRadius: 12, border: '1px solid' }}>
                            <Brain size={24} color="#38bdf8" />
                        </div>
                        <div>
                            <h1 className="page-title">Advanced ML Studio</h1>
                            <p className="subtitle" style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.85rem' }}>Preprocessing, dimensionality reduction, and auto-ML modeling.</p>
                        </div>
                    </div>
                </div>

                <div className="ml-plots-grid">
                    {/* Dim Red Plot */}
                    <div className="plot-card glass-panel" style={{ gridColumn: '1 / -1' }}>
                        <h3 className="plot-title">Feature Extraction & Dimensionality Reduction</h3>
                        {!dimRedResults ? (
                            <div className="empty-placeholder">
                                <ScatterChartIcon size={32} />
                                <p>Click "Run PCA & t-SNE" to visualize cluster distributions.</p>
                            </div>
                        ) : tsneRunning ? (
                            <div className="empty-placeholder">
                                <div className="spinner" style={{ border: '3px solid rgba(56,189,248,0.3)', borderTopColor: '#38bdf8', borderRadius: '50%', width: 30, height: 30, animation: 'spin 1s linear infinite' }} />
                                <p>Computing t-SNE...</p>
                            </div>
                        ) : (
                            <div className="dual-plots" style={{ display: 'flex', gap: 20, height: '400px' }}>
                                <div style={{ flex: 1 }}>
                                    <h4 style={{ textAlign: 'center', marginBottom: 8 }}>PCA Plot</h4>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                                            <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                                            <XAxis type="number" dataKey="pcaX" name="PC 1" stroke="var(--text-muted)" />
                                            <YAxis type="number" dataKey="pcaY" name="PC 2" stroke="var(--text-muted)" />
                                            <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid var(--border-color)', borderRadius: 8 }} cursor={{ strokeDasharray: '3 3' }} />
                                            <Scatter name="PCA" data={dimRedResults} fill="#8884d8">
                                                {dimRedResults.map((entry, index) => (
                                                    <Cell key={`cell-${index}`} fill={entry.color} />
                                                ))}
                                                <LabelList dataKey="target" position="top" fill="rgba(255,255,255,0.7)" fontSize={11} />
                                            </Scatter>
                                        </ScatterChart>
                                    </ResponsiveContainer>
                                </div>
                                <div style={{ flex: 1 }}>
                                    <h4 style={{ textAlign: 'center', marginBottom: 8 }}>t-SNE Plot</h4>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                                            <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                                            <XAxis type="number" dataKey="tsneX" name="t-SNE 1" stroke="var(--text-muted)" />
                                            <YAxis type="number" dataKey="tsneY" name="t-SNE 2" stroke="var(--text-muted)" />
                                            <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid var(--border-color)', borderRadius: 8 }} cursor={{ strokeDasharray: '3 3' }} />
                                            <Scatter name="t-SNE" data={dimRedResults} fill="#82ca9d">
                                                {dimRedResults.map((entry, index) => (
                                                    <Cell key={`cell-${index}`} fill={entry.color} />
                                                ))}
                                            </Scatter>
                                        </ScatterChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Model Training Plot */}
                    <div className="plot-card glass-panel" style={{ gridColumn: '1 / -1' }}>
                        <h3 className="plot-title">Model Training Results</h3>
                        {!modelResults ? (
                            <div className="empty-placeholder">
                                <Brain size={32} />
                                <p>Click "Train Model" to view predictive performance.</p>
                            </div>
                        ) : (
                            <div>
                                <div className="metrics-banner" style={{ display: 'flex', gap: 20, padding: 16, background: 'rgba(0,0,0,0.2)', borderRadius: 8, marginBottom: 20, alignItems: 'center' }}>
                                    <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{modelResults.metricName}:</div>
                                    <div style={{ fontSize: '1.8rem', color: 'var(--accent-secondary)', fontWeight: 700 }}>{modelResults.metricValue}</div>
                                </div>

                                {taskType === 'regression' ? (
                                    <div style={{ height: 400 }}>
                                        <h4 style={{ textAlign: 'center', marginBottom: 8 }}>Predicted vs Actual</h4>
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                                                <XAxis type="number" dataKey="actual" name="Actual Target" stroke="var(--text-muted)" />
                                                <YAxis type="number" dataKey="predicted" name="Predicted" stroke="var(--text-muted)" />
                                                <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid var(--border-color)', borderRadius: 8 }} cursor={{ strokeDasharray: '3 3' }} />
                                                <Scatter name="Predictions" data={modelResults.plotData} fill="#38bdf8" />
                                            </ScatterChart>
                                        </ResponsiveContainer>
                                    </div>
                                ) : (
                                    <div className="confusion-matrix">
                                        <h4 style={{ textAlign: 'center', marginBottom: 16 }}>Classification Results Table</h4>
                                        <div style={{ background: 'rgba(15,23,42,0.5)', borderRadius: 8, padding: 16, maxHeight: 300, overflowY: 'auto' }}>
                                            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                                                <thead>
                                                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                                        <th style={{ padding: 8 }}>File Name</th>
                                                        <th style={{ padding: 8 }}>Actual Class</th>
                                                        <th style={{ padding: 8 }}>Predicted Class</th>
                                                        <th style={{ padding: 8 }}>Match?</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {modelResults.plotData.map((row, i) => (
                                                        <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                                            <td style={{ padding: 8 }}>{row.fileName}</td>
                                                            <td style={{ padding: 8 }}>{row.actual}</td>
                                                            <td style={{ padding: 8 }}>{row.predicted}</td>
                                                            <td style={{ padding: 8, color: row.match === 'Yes' ? '#10b981' : '#ef4444', fontWeight: 600 }}>{row.match}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
};

export default MLStudioPage;
