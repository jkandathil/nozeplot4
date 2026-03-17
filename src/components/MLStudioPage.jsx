import React, { useState, useMemo, useEffect } from 'react';
import { Brain, Settings2, ScatterChart as ScatterChartIcon, PlayCircle, FileText, Download, Loader2 } from 'lucide-react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList, Cell, ZAxis, Legend } from 'recharts';
import { PCA } from 'ml-pca';
import { RandomForestRegression as RFRegression, RandomForestClassifier as RFClassifier } from 'ml-random-forest';
import MultivariateLinearRegression from 'ml-regression-multivariate-linear';
import { Matrix } from 'ml-matrix';
import tsnejs from 'tsne';
import * as tf from '@tensorflow/tfjs';
import './MLStudioPage.css';

const MLStudioPage = ({ data, fileName, compareDataList = [] }) => {
    const files = useMemo(() => {
        const arr = [];
        if (data && fileName) arr.push({ id: fileName, name: fileName, fileName: fileName, data });
        if (compareDataList && compareDataList.length > 0) {
            compareDataList.forEach(c => arr.push({ id: c.fileName, name: c.fileName, fileName: c.fileName, data: c.data }));
        }
        return arr;
    }, [data, fileName, compareDataList]);

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
    const [algorithm, setAlgorithm] = useState('RandomForest'); // 'RandomForest' or 'Linear' or 'TensorFlow'

    // TensorFlow Config
    const [tfEpochs, setTfEpochs] = useState(100);
    const [tfLR, setTfLR] = useState(0.01);
    const [tfSplit, setTfSplit] = useState(80);
    const [tfModelRef, setTfModelRef] = useState(null);
    const [isTraining, setIsTraining] = useState(false);
    const [tfLossHistory, setTfLossHistory] = useState([]);

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

    const runModelTraining = async () => {
        if (allFeatures.length < 3) return;

        const featureKeys = ['maxPeak', 'minPeak', 'area', 'baseline', 'stdDev', 'mean'];
        const X = allFeatures.map(f => featureKeys.map(k => f.features[k]));

        let Y;
        try {
            if (taskType === 'regression') {
                if (algorithm === 'TensorFlow') {
                    setTfLossHistory([]);
                    setIsTraining(true);
                    setTimeout(async () => {
                        try {
                            const elements = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'];

                            const extractedX = [];
                            const extractedY = [];
                            const extractedInfo = [];

                            for (const file of files) {
                                if (!file.data || file.data.length === 0) continue;
                                const target = parseFloat(targetMap[file.id]);
                                if (isNaN(target)) continue;

                                const keys = Object.keys(file.data[0]);
                                const tCol = keys.find(k => /bt1|aqt0|temperature|^t$/i.test(k));
                                const hCol = keys.find(k => /aqh0|trhh0|humidity|^h$/i.test(k));
                                const evCol = keys.find(k => /event|phase/i.test(k));
                                const elCols = elements.map(el => keys.find(k => RegExp(`^${el}$|^${el}_|_${el}$`, 'i').test(k)));

                                let sumT = 0, countT = 0;
                                let sumH = 0, countH = 0;

                                // Fallback generic bins if specific names don't match perfectly
                                const eventsData = {
                                    'phase1': { sums: new Array(64).fill(0), counts: 0 },
                                    'phase2': { sums: new Array(64).fill(0), counts: 0 },
                                    'phase3': { sums: new Array(64).fill(0), counts: 0 }
                                };

                                // Analyze sequence of events to map unknown names to phases
                                let uniqueEvents = [];
                                if (evCol) {
                                    for (let r of file.data) {
                                        if (r[evCol] && !uniqueEvents.includes(r[evCol])) uniqueEvents.push(r[evCol]);
                                    }
                                }

                                for (const r of file.data) {
                                    if (tCol && typeof r[tCol] === 'number') { sumT += r[tCol]; countT++; }
                                    if (hCol && typeof r[hCol] === 'number') { sumH += r[hCol]; countH++; }

                                    let tgt = eventsData['phase1']; // Default fallback everything to phase1 if no events exist

                                    if (evCol && r[evCol]) {
                                        const evStr = String(r[evCol]).toLowerCase().replace(/[^a-z0-9]/g, '');
                                        if (evStr.includes('sample') || evStr.includes('collect') || evStr.includes('breath') || (uniqueEvents.indexOf(r[evCol]) === 0)) tgt = eventsData['phase1'];
                                        else if (evStr.includes('window') || evStr.includes('wait') || (uniqueEvents.indexOf(r[evCol]) === 1)) tgt = eventsData['phase2'];
                                        else if (evStr.includes('measure') || evStr.includes('eval') || (uniqueEvents.indexOf(r[evCol]) >= 2)) tgt = eventsData['phase3'];
                                    }

                                    if (tgt) {
                                        tgt.counts++;
                                        for (let i = 0; i < 64; i++) {
                                            const k = elCols[i];
                                            if (k && typeof r[k] === 'number') tgt.sums[i] += r[k];
                                        }
                                    }
                                }

                                const avgT = countT > 0 ? sumT / countT : 0;
                                const avgH = countH > 0 ? sumH / countH : 0;

                                const makeMean = (evObj) => evObj.counts > 0 ? evObj.sums.map(s => s / evObj.counts) : new Array(64).fill(0);

                                const featVec = [
                                    avgT, avgH,
                                    ...makeMean(eventsData['phase1']),
                                    ...makeMean(eventsData['phase2']),
                                    ...makeMean(eventsData['phase3'])
                                ];

                                extractedX.push(featVec);
                                extractedY.push(target);
                                extractedInfo.push({ fileName: file.name, actual: target });
                            }

                            if (extractedX.length < 2) {
                                alert("Not enough valid files with numbers mapped in Map Targets to train TF network securely.");
                                setIsTraining(false);
                                return;
                            }

                            // Shuffle indices
                            const indices = extractedX.map((_, i) => i);
                            tf.util.shuffle(indices);

                            // 80/20 split based on slider
                            const numTrain = Math.floor(extractedX.length * (tfSplit / 100)) || 1;

                            const xTrain = indices.slice(0, numTrain).map(i => extractedX[i]);
                            const yTrain = indices.slice(0, numTrain).map(i => extractedY[i]);
                            const xVal = indices.slice(numTrain).map(i => extractedX[i]);
                            const yVal = indices.slice(numTrain).map(i => extractedY[i]);

                            const model = tf.sequential();
                            model.add(tf.layers.dense({ units: 128, activation: 'relu', inputShape: [194] }));
                            model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
                            model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
                            model.add(tf.layers.dense({ units: 1 }));

                            model.compile({
                                optimizer: tf.train.adam(parseFloat(tfLR) || 0.01),
                                loss: 'meanSquaredError'
                            });

                            const xsT = tf.tensor2d(xTrain);
                            const ysT = tf.tensor2d(yTrain, [yTrain.length, 1]);
                            let xsV = null, ysV = null;
                            if (xVal.length > 0) {
                                xsV = tf.tensor2d(xVal);
                                ysV = tf.tensor2d(yVal, [yVal.length, 1]);
                            }

                            await model.fit(xsT, ysT, {
                                epochs: parseInt(tfEpochs) || 50,
                                validationData: (xsV && ysV) ? [xsV, ysV] : undefined,
                                shuffle: true,
                                callbacks: {
                                    onEpochEnd: (epoch, logs) => {
                                        setTfLossHistory(prev => [...prev, { epoch: epoch + 1, loss: logs.loss, val_loss: logs.val_loss }]);
                                    }
                                }
                            });

                            const finalPreds = model.predict(tf.tensor2d(extractedX)).dataSync();
                            setTfModelRef(model);

                            // Calc Validation or Train R^2 Score
                            const evalY = yVal.length > 0 ? yVal : extractedY;
                            const evalPreds = yVal.length > 0 ? model.predict(xsV).dataSync() : finalPreds;

                            const yMean = evalY.reduce((a, b) => a + b, 0) / evalY.length;
                            const ssTot = evalY.reduce((a, b) => a + Math.pow(b - yMean, 2), 0);
                            const ssRes = evalY.reduce((a, b, i) => a + Math.pow(b - evalPreds[i], 2), 0);
                            const r2 = 1 - (ssRes / (ssTot || 1));

                            setModelResults({
                                metricName: yVal.length > 0 ? `TensorFlow R² (Val)` : `TensorFlow R² (Train)`,
                                metricValue: r2.toFixed(3),
                                plotData: extractedInfo.map((info, i) => ({
                                    fileName: info.fileName,
                                    actual: info.actual,
                                    predicted: finalPreds[i],
                                    split: indices.slice(0, numTrain).includes(i) ? 'Training Data' : 'Validation Data'
                                }))
                            });

                        } catch (err) {
                            console.error("TF error", err);
                            alert("TensorFlow training failed. Check developer console.");
                        }
                        setIsTraining(false);
                    }, 50);
                    return;
                }

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
                        predicted: predictions[i],
                        split: 'Training Data'
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
                            {taskType === 'regression' && <option value="TensorFlow">TensorFlow (Deep Learning)</option>}
                        </select>
                    </div>

                    {algorithm === 'TensorFlow' && taskType === 'regression' && (
                        <div style={{ background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 8, marginTop: 12 }}>
                            <div className="form-group" style={{ marginBottom: 12 }}>
                                <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <span>Train / Validation Split</span>
                                    <span style={{ color: '#38bdf8' }}>{tfSplit}% / {100 - tfSplit}%</span>
                                </label>
                                <input
                                    type="range"
                                    min="50" max="95"
                                    value={tfSplit}
                                    onChange={e => setTfSplit(e.target.value)}
                                    style={{ width: '100%', accentColor: '#38bdf8' }}
                                />
                                <small style={{ color: 'var(--text-muted)' }}>TF vector merges Global Avg T/H and maps the full means of 64 sensing arrays per analytical phase (194 dense features).</small>
                            </div>
                            <div className="form-group-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                <div>
                                    <label>Epochs</label>
                                    <input type="number" className="text-input" value={tfEpochs} onChange={e => setTfEpochs(e.target.value)} />
                                </div>
                                <div>
                                    <label>Learning Rate</label>
                                    <input type="number" step="0.001" className="text-input" value={tfLR} onChange={e => setTfLR(e.target.value)} />
                                </div>
                            </div>
                            {tfModelRef && (
                                <button className="btn-secondary" style={{ width: '100%', marginTop: 12 }} onClick={() => tfModelRef.save('downloads://noze-regression-model')}>
                                    <Download size={14} /> Download Model
                                </button>
                            )}
                        </div>
                    )}

                    <button className="btn-primary" onClick={runModelTraining} style={{ marginTop: 12 }} disabled={allFeatures.length < 3 || isTraining}>
                        {isTraining ? <Loader2 className="spinner" size={16} /> : <Brain size={16} />} Train Model
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
                                    isTraining ? (
                                        <div style={{ height: 400 }}>
                                            <h4 style={{ textAlign: 'center', marginBottom: 8, color: '#38bdf8' }}>Training in Progress... Computing Epoch Limits</h4>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                                                    <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                                                    <XAxis type="number" dataKey="epoch" name="Epoch" stroke="var(--text-muted)" />
                                                    <YAxis type="number" yAxisId="left" name="Loss" stroke="#38bdf8" />
                                                    <YAxis type="number" yAxisId="right" orientation="right" name="Val Loss" stroke="#f59e0b" />
                                                    <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
                                                    <Legend />
                                                    <Scatter name="Training Loss" data={tfLossHistory} fill="#38bdf8" line yAxisId="left" />
                                                    <Scatter name="Validation Loss" data={tfLossHistory} fill="#f59e0b" line yAxisId="right" />
                                                </ScatterChart>
                                            </ResponsiveContainer>
                                        </div>
                                    ) : (
                                        <div style={{ height: 400 }}>
                                            <h4 style={{ textAlign: 'center', marginBottom: 8 }}>Predicted vs Actual</h4>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                                                    <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                                                    <XAxis type="number" dataKey="actual" name="Actual Target" stroke="var(--text-muted)" />
                                                    <YAxis type="number" dataKey="predicted" name="Predicted" stroke="var(--text-muted)" />
                                                    <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid var(--border-color)', borderRadius: 8 }} cursor={{ strokeDasharray: '3 3' }} />
                                                    <Legend wrapperStyle={{ paddingTop: 20 }} />
                                                    <Scatter name="Training Data" data={modelResults.plotData.filter(d => d.split === 'Training Data')} fill="#38bdf8" />
                                                    {modelResults.plotData.some(d => d.split === 'Validation Data') && (
                                                        <Scatter name="Validation Data" data={modelResults.plotData.filter(d => d.split === 'Validation Data')} fill="#f59e0b" />
                                                    )}
                                                </ScatterChart>
                                            </ResponsiveContainer>
                                        </div>
                                    )
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
