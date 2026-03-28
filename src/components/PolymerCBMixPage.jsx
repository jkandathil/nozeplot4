import React, { useMemo, useState } from 'react';
import { Blend, Info } from 'lucide-react';
import { wtPercentCbToVolumeFraction, volPercentCbToWtPercent } from '../utils/polymerCbMix';
import './GasDilutionMathPage.css';

const DEFAULT_RHO_CB = 1.85;
const DEFAULT_RHO_POLY = 0.95;

function formatPhr(phr) {
    if (!Number.isFinite(phr)) return '—';
    if (phr > 1e6) return '∞';
    return phr.toFixed(2);
}

const PolymerCBMixPage = () => {
    const [mode, setMode] = useState('wt_to_vol');
    const [wtCb, setWtCb] = useState(5);
    const [volCb, setVolCb] = useState(10);
    const [rhoCb, setRhoCb] = useState(DEFAULT_RHO_CB);
    const [rhoPoly, setRhoPoly] = useState(DEFAULT_RHO_POLY);

    const forward = useMemo(
        () => wtPercentCbToVolumeFraction(wtCb, rhoCb, rhoPoly),
        [wtCb, rhoCb, rhoPoly]
    );

    const inverse = useMemo(
        () => volPercentCbToWtPercent(volCb, rhoCb, rhoPoly),
        [volCb, rhoCb, rhoPoly]
    );

    return (
        <div className="math-page-container">
            <header className="math-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="icon-wrapper" style={{ background: 'rgba(52, 211, 153, 0.15)', borderColor: 'rgba(52, 211, 153, 0.35)' }}>
                        <Blend size={22} color="#34d399" />
                    </div>
                    <div>
                        <h1 className="page-title">Polymer–carbon black mix</h1>
                        <p className="subtitle">
                            Convert <strong>wt% CB</strong> to <strong>volume fraction</strong> (and <strong>phr</strong>) using densities and ideal volume additivity.
                        </p>
                    </div>
                </div>
            </header>

            <div className="math-content" style={{ gridTemplateColumns: '1fr 1fr', maxWidth: 960 }}>
                <section className="glass-panel">
                    <h3 className="section-title"><Blend size={18} /> Inputs</h3>
                    <div className="input-section">
                        <div className="form-group">
                            <label className="form-label">Mode</label>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => setMode('wt_to_vol')}
                                    style={{
                                        padding: '8px 14px',
                                        borderRadius: 8,
                                        border: mode === 'wt_to_vol' ? '1px solid #34d399' : '1px solid var(--border-color)',
                                        background: mode === 'wt_to_vol' ? 'rgba(52,211,153,0.12)' : 'transparent',
                                        color: 'var(--text-primary)',
                                        cursor: 'pointer',
                                        fontSize: '0.85rem',
                                        fontWeight: 600,
                                    }}
                                >
                                    wt% CB → vol%
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setMode('vol_to_wt')}
                                    style={{
                                        padding: '8px 14px',
                                        borderRadius: 8,
                                        border: mode === 'vol_to_wt' ? '1px solid #34d399' : '1px solid var(--border-color)',
                                        background: mode === 'vol_to_wt' ? 'rgba(52,211,153,0.12)' : 'transparent',
                                        color: 'var(--text-primary)',
                                        cursor: 'pointer',
                                        fontSize: '0.85rem',
                                        fontWeight: 600,
                                    }}
                                >
                                    vol% CB → wt%
                                </button>
                            </div>
                        </div>

                        <div className="form-group">
                            <label>ρ carbon black (g/cm³)</label>
                            <div className="input-with-unit">
                                <input
                                    type="number"
                                    className="text-input"
                                    min={0.01}
                                    step={0.01}
                                    value={rhoCb}
                                    onChange={(e) => setRhoCb(parseFloat(e.target.value) || 0)}
                                    style={{ padding: '10px 12px', width: '100%' }}
                                />
                                <span className="unit">g/cm³</span>
                            </div>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Typ. ~1.8–2.0; adjust for your CB grade.</span>
                        </div>

                        <div className="form-group">
                            <label>ρ polymer (g/cm³)</label>
                            <div className="input-with-unit">
                                <input
                                    type="number"
                                    className="text-input"
                                    min={0.01}
                                    step={0.01}
                                    value={rhoPoly}
                                    onChange={(e) => setRhoPoly(parseFloat(e.target.value) || 0)}
                                    style={{ padding: '10px 12px', width: '100%' }}
                                />
                                <span className="unit">g/cm³</span>
                            </div>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>e.g. PE ~0.92–0.96, PMMA ~1.18, PDMS ~0.97.</span>
                        </div>

                        {mode === 'wt_to_vol' ? (
                            <div className="form-group">
                                <label>Weight % carbon black</label>
                                <div className="input-with-unit">
                                    <input
                                        type="number"
                                        className="text-input"
                                        min={0}
                                        max={100}
                                        step={0.1}
                                        value={wtCb}
                                        onChange={(e) => setWtCb(parseFloat(e.target.value) || 0)}
                                        style={{ padding: '10px 12px', width: '100%' }}
                                    />
                                    <span className="unit">wt%</span>
                                </div>
                            </div>
                        ) : (
                            <div className="form-group">
                                <label>Volume % carbon black</label>
                                <div className="input-with-unit">
                                    <input
                                        type="number"
                                        className="text-input"
                                        min={0}
                                        max={100}
                                        step={0.1}
                                        value={volCb}
                                        onChange={(e) => setVolCb(parseFloat(e.target.value) || 0)}
                                        style={{ padding: '10px 12px', width: '100%' }}
                                    />
                                    <span className="unit">vol%</span>
                                </div>
                            </div>
                        )}
                    </div>
                </section>

                <section className="glass-panel">
                    <h3 className="section-title">Results</h3>
                    {mode === 'wt_to_vol' && forward && (
                        <div className="input-section" style={{ fontSize: '0.95rem' }}>
                            <ResultRow label="Volume fraction φ_CB" value={forward.phiCb.toFixed(4)} />
                            <ResultRow label="Volume fraction φ_polymer" value={forward.phiPolymer.toFixed(4)} />
                            <ResultRow label="Volume % CB" value={`${forward.volPercentCb.toFixed(2)} %`} />
                            <ResultRow label="phr (parts CB per 100 parts polymer)" value={formatPhr(forward.phr)} highlight />
                        </div>
                    )}
                    {mode === 'vol_to_wt' && inverse && (
                        <div className="input-section" style={{ fontSize: '0.95rem' }}>
                            <ResultRow label="Weight % CB" value={`${inverse.wtPercentCb.toFixed(2)} %`} highlight />
                            <ResultRow label="phr (parts CB per 100 parts polymer)" value={formatPhr(inverse.phr)} />
                        </div>
                    )}
                    {(mode === 'wt_to_vol' && !forward) || (mode === 'vol_to_wt' && !inverse) ? (
                        <p style={{ color: '#f87171' }}>Enter positive densities.</p>
                    ) : null}

                    <div
                        style={{
                            marginTop: 20,
                            padding: 12,
                            borderRadius: 8,
                            background: 'rgba(148, 163, 184, 0.08)',
                            border: '1px solid rgba(148, 163, 184, 0.2)',
                            fontSize: '0.8rem',
                            color: 'var(--text-muted)',
                            lineHeight: 1.5,
                        }}
                    >
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
                            <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                            <span>
                                For a binary blend, per gram of composite:{' '}
                                <em>V_CB = w_CB / ρ_CB</em>, <em>V_poly = w_poly / ρ_poly</em>, then{' '}
                                <em>φ_CB = V_CB / (V_CB + V_poly)</em>. Real films deviate (voids, agglomeration, interface); use as screening.
                            </span>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
};

function ResultRow({ label, value, highlight }) {
    return (
        <div
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 12,
                padding: '10px 0',
                borderBottom: '1px solid var(--border-color)',
            }}
        >
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            <strong style={{ color: highlight ? '#34d399' : 'var(--text-primary)', fontSize: highlight ? '1.05rem' : '1rem' }}>{value}</strong>
        </div>
    );
}

export default PolymerCBMixPage;
