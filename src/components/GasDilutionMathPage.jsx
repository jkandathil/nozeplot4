import React, { useState } from 'react';
import { Settings, Calculator as CalculatorIcon, FlaskConical, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import './GasDilutionMathPage.css';

const GasDilutionMathPage = () => {
    const [desiredConc, setDesiredConc] = useState(5);
    const [desiredUnit, setDesiredUnit] = useState('ppb');
    const [cylinderConc, setCylinderConc] = useState(5);
    const [cylinderUnit, setCylinderUnit] = useState('ppm');
    const [totalFlow, setTotalFlow] = useState(100); // sccm

    // Humidity
    const [targetRH, setTargetRH] = useState(0); // %
    const [bubblerTemp, setBubblerTemp] = useState(25); // Celsius

    const [mfcs, setMfcs] = useState([
        { id: '1', name: 'Ammonia', isDiluent: false, isHumidifier: false, maxFlow: 500 },
        { id: '2', name: 'Air (Dry)', isDiluent: true, isHumidifier: false, maxFlow: 500 },
        { id: '3', name: 'Air (Wet)', isDiluent: false, isHumidifier: true, maxFlow: 500 }
    ]);

    // Ensure we have properly assigned MFCs
    const analyteMFC = mfcs.find(m => (!m.isDiluent && !m.isHumidifier));
    const diluentMFC = mfcs.find(m => m.isDiluent);
    const humidifierMFC = mfcs.find(m => m.isHumidifier);

    // Calculate flows: normalize to ppb for calculation
    const cylConcPpb = cylinderUnit === 'ppm' ? cylinderConc * 1000 : cylinderConc;
    const targetConcPpb = desiredUnit === 'ppm' ? desiredConc * 1000 : desiredConc;

    // C1 * V1 = C2 * V2 -> V1 = (C2 * V2) / C1
    const analyteFlow = cylConcPpb > 0 ? (targetConcPpb * totalFlow) / cylConcPpb : 0;

    // --- Humidity Calculation ---
    // Antoine equation for water vapor pressure (P_v in mmHg, T in Celsius)
    // P_v = 10^(A - B / (C + T))
    // Constants for water: A=8.07131, B=1730.63, C=233.426
    const A = 8.07131;
    const B = 1730.63;
    const C = 233.426;
    const vaporPressure_mmHg = Math.pow(10, A - (B / (C + bubblerTemp)));
    const atmosphericPressure_mmHg = 760; // Assume standard atmospheric pressure

    // Saturation ratio (absolute humidity at 100% RH for given bubbler temp)
    const saturationRatio = vaporPressure_mmHg / atmosphericPressure_mmHg;

    // Required bubbler flow rate to achieve target RH at room temp (assuming room temp = bubbler temp for simplicity, 
    // or RH is calculated based on the bubbler's saturation capacity. Usually room temp is ~25C).
    // Target partial pressure of water = (targetRH / 100) * vaporPressure(roomTemp)
    // Assuming room temp is same as bubbler temp for the RH target definition
    const targetPartialPressure = (targetRH / 100) * vaporPressure_mmHg;
    const targetRatio = targetPartialPressure / atmosphericPressure_mmHg;

    // bubblerFlow * saturationRatio = totalFlow * targetRatio
    let bubblerFlow = 0;
    if (saturationRatio > 0 && targetRH > 0) {
        bubblerFlow = (totalFlow * targetRatio) / saturationRatio;
    }

    // Safety checks
    if (bubblerFlow > totalFlow) {
        bubblerFlow = totalFlow; // Cannot exceed total flow
    }

    // Diluent flow makes up the rest
    const diluentFlow = totalFlow - analyteFlow - bubblerFlow;

    const addMfc = () => {
        setMfcs([...mfcs, {
            id: Date.now().toString(),
            name: `MFC ${mfcs.length + 1}`,
            isDiluent: false,
            isHumidifier: false,
            maxFlow: 100
        }]);
    };

    const removeMfc = (id) => {
        if (mfcs.length <= 2) {
            alert("Minimum 2 MFCs required");
            return;
        }
        setMfcs(mfcs.filter(m => m.id !== id));
    };

    const updateMfc = (id, field, value) => {
        setMfcs(mfcs.map(m => m.id === id ? { ...m, [field]: value } : m));
    };

    return (
        <div className="math-page-container">
            <div className="math-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="icon-wrapper" style={{ background: 'rgba(56, 189, 248, 0.15)', borderColor: 'rgba(56, 189, 248, 0.3)' }}>
                        <FlaskConical size={20} color="#38bdf8" />
                    </div>
                    <h1 className="page-title">Gas-Dilution Math</h1>
                </div>
                <p className="subtitle">Calculate flow rates to reach a desired target concentration.</p>
            </div>

            <div className="math-content">
                <div className="input-section glass-panel">
                    <h3 className="section-title"><Settings size={18} /> Parameters</h3>

                    <div className="form-group">
                        <label>Desired Concentration (Target)</label>
                        <div className="input-with-unit">
                            <input
                                type="number"
                                value={desiredConc}
                                onChange={e => {
                                    const val = e.target.value;
                                    setDesiredConc(val === '' ? '' : parseFloat(val));
                                }}
                                className="text-input"
                            />
                            <select
                                className="unit"
                                value={desiredUnit}
                                onChange={e => setDesiredUnit(e.target.value)}
                                style={{ border: 'none', background: 'transparent', outline: 'none', appearance: 'none', cursor: 'pointer', paddingRight: '20px' }}
                            >
                                <option value="ppb">ppb</option>
                                <option value="ppm">ppm</option>
                            </select>
                        </div>
                    </div>

                    <div className="form-group">
                        <label>Cylinder Concentration</label>
                        <div className="input-with-unit">
                            <input
                                type="number"
                                value={cylinderConc}
                                onChange={e => {
                                    const val = e.target.value;
                                    setCylinderConc(val === '' ? '' : parseFloat(val));
                                }}
                                className="text-input"
                            />
                            <select
                                className="unit"
                                value={cylinderUnit}
                                onChange={e => setCylinderUnit(e.target.value)}
                                style={{ border: 'none', background: 'transparent', outline: 'none', appearance: 'none', cursor: 'pointer', paddingRight: '20px' }}
                            >
                                <option value="ppb">ppb</option>
                                <option value="ppm">ppm</option>
                            </select>
                        </div>
                    </div>

                    <div className="form-group">
                        <label>Net Flow Rate (Total Diluted)</label>
                        <div className="input-with-unit">
                            <input
                                type="number"
                                value={totalFlow}
                                onChange={e => {
                                    const val = e.target.value;
                                    setTotalFlow(val === '' ? '' : parseFloat(val));
                                }}
                                className="text-input"
                            />
                            <span className="unit">sccm</span>
                        </div>
                    </div>

                    <div className="form-group" style={{ marginTop: '12px', borderTop: '1px dashed var(--border-color)', paddingTop: '16px' }}>
                        <label>Target Relative Humidity</label>
                        <div className="input-with-unit">
                            <input
                                type="number"
                                value={targetRH}
                                onChange={e => {
                                    const val = e.target.value;
                                    setTargetRH(val === '' ? '' : Math.min(100, Math.max(0, parseFloat(val))));
                                }}
                                className="text-input"
                            />
                            <span className="unit">%</span>
                        </div>
                    </div>

                    <div className="form-group">
                        <label>Bubbler/Water Temp.</label>
                        <div className="input-with-unit">
                            <input
                                type="number"
                                value={bubblerTemp}
                                onChange={e => {
                                    const val = e.target.value;
                                    setBubblerTemp(val === '' ? '' : parseFloat(val));
                                }}
                                className="text-input"
                            />
                            <span className="unit">°C</span>
                        </div>
                    </div>
                </div>

                <div className="results-section glass-panel">
                    <h3 className="section-title"><CalculatorIcon size={18} /> Calculated Results</h3>

                    <div className="result-card">
                        <div className="result-label">Required Analyte Flow Rate</div>
                        <div className="result-value" style={{ color: '#38bdf8' }}>
                            {analyteFlow.toFixed(3)} sccm
                        </div>
                        {analyteMFC && analyteFlow > analyteMFC.maxFlow && (
                            <div className="warning-text">
                                <AlertTriangle size={14} /> Exceeds configured MFC max ({analyteMFC.maxFlow} sccm)
                            </div>
                        )}
                        {analyteFlow < 0 && (
                            <div className="warning-text">
                                <AlertTriangle size={14} /> Invalid parameters
                            </div>
                        )}
                    </div>

                    {targetRH > 0 && (
                        <div className="result-card">
                            <div className="result-label">Required Humidifier (Wet) Flow Rate</div>
                            <div className="result-value" style={{ color: '#10b981' }}>
                                {bubblerFlow.toFixed(3)} sccm
                            </div>
                            {humidifierMFC && bubblerFlow > humidifierMFC.maxFlow && (
                                <div className="warning-text">
                                    <AlertTriangle size={14} /> Exceeds configured MFC max ({humidifierMFC.maxFlow} sccm)
                                </div>
                            )}
                            {!humidifierMFC && (
                                <div className="warning-text">
                                    <AlertTriangle size={14} /> No Humidifier MFC configured!
                                </div>
                            )}
                            {bubblerFlow > totalFlow && (
                                <div className="warning-text">
                                    <AlertTriangle size={14} /> Imposssible: Exceeds total net flow rate.
                                </div>
                            )}
                        </div>
                    )}

                    <div className="result-card">
                        <div className="result-label">Required Diluent (Dry) Flow Rate</div>
                        <div className="result-value" style={{ color: '#fbbf24' }}>
                            {diluentFlow.toFixed(3)} sccm
                        </div>
                        {diluentMFC && diluentFlow > diluentMFC.maxFlow && (
                            <div className="warning-text">
                                <AlertTriangle size={14} /> Exceeds configured MFC max ({diluentMFC.maxFlow} sccm)
                            </div>
                        )}
                        {diluentFlow < 0 && (
                            <div className="warning-text">
                                <AlertTriangle size={14} /> Total flow too low to achieve concentration.
                            </div>
                        )}
                    </div>
                </div>

                <div className="mfc-section glass-panel">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <h3 className="section-title" style={{ border: 'none', margin: 0, padding: 0 }}>MFC Configuration</h3>
                        <button className="icon-btn small" onClick={addMfc}>
                            <Plus size={16} /> Add MFC
                        </button>
                    </div>

                    <div className="mfc-list">
                        {mfcs.map((mfc, idx) => (
                            <div key={mfc.id} className="mfc-card">
                                <div className="mfc-header">
                                    <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>MFC {idx + 1}</span>
                                    <button className="icon-btn delete-mfc" onClick={() => removeMfc(mfc.id)}>
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                                <div className="mfc-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                    <div className="form-group" style={{ width: '100%' }}>
                                        <label>Gas Name</label>
                                        <input
                                            type="text"
                                            value={mfc.name}
                                            onChange={e => updateMfc(mfc.id, 'name', e.target.value)}
                                            className="text-input"
                                            placeholder="e.g. Ammonia"
                                        />
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                        <div className="form-group" style={{ width: '100%' }}>
                                            <label>Max Flow</label>
                                            <div className="input-with-unit" style={{ gridTemplateColumns: '1fr' }}>
                                                <input
                                                    type="number"
                                                    value={mfc.maxFlow === 0 ? '' : mfc.maxFlow}
                                                    onChange={e => {
                                                        const val = e.target.value;
                                                        updateMfc(mfc.id, 'maxFlow', val === '' ? '' : parseFloat(val));
                                                    }}
                                                    className="text-input"
                                                />
                                            </div>
                                        </div>
                                        <div className="form-group" style={{ width: '100%' }}>
                                            <label>Function (Type)</label>
                                            <select
                                                value={mfc.isHumidifier ? "humidifier" : (mfc.isDiluent ? "diluent" : "analyte")}
                                                onChange={e => {
                                                    const val = e.target.value;
                                                    updateMfc(mfc.id, 'isHumidifier', val === 'humidifier');
                                                    updateMfc(mfc.id, 'isDiluent', val === 'diluent');
                                                }}
                                                className="text-input"
                                                style={{ padding: '9px 12px' }}
                                            >
                                                <option value="analyte">Analyte source</option>
                                                <option value="diluent">Dry Diluent</option>
                                                <option value="humidifier">Wet Humidifier</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default GasDilutionMathPage;
