import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Download, Cpu } from 'lucide-react';
import { addFootprint } from '../pcb/footprintLib.js';

const MOCK_API_RESULTS = [
    {
        id: 'NE555P',
        name: 'NE555P',
        description: 'Precision Timer, DIP-8, 0 to 70°C',
        manufacturer: 'Texas Instruments',
        footprint: {
            id: 'DIP-8_W7.62mm',
            name: 'DIP-8_W7.62mm',
            family: 'IC',
            pads: [
                { id: '1', num: '1', x: -3.81, y: -2.54, w: 1.6, h: 1.2 },
                { id: '2', num: '2', x: -1.27, y: -2.54, w: 1.6, h: 1.2 },
                { id: '3', num: '3', x: 1.27, y: -2.54, w: 1.6, h: 1.2 },
                { id: '4', num: '4', x: 3.81, y: -2.54, w: 1.6, h: 1.2 },
                { id: '5', num: '5', x: 3.81, y: 2.54, w: 1.6, h: 1.2 },
                { id: '6', num: '6', x: 1.27, y: 2.54, w: 1.6, h: 1.2 },
                { id: '7', num: '7', x: -1.27, y: 2.54, w: 1.6, h: 1.2 },
                { id: '8', num: '8', x: -3.81, y: 2.54, w: 1.6, h: 1.2 },
            ],
            silk: [{ kind: 'line', x1: -4.5, y1: -3.5, x2: 4.5, y2: -3.5 }]
        },
        spiceModel: `* NE555 Timer Model\n.subckt NE555 GND TRIG OUT RESET CONT THRES DISCH VCC\n* (Simplified macromodel)\n.ends NE555`
    },
    {
        id: 'STM32F103C8T6',
        name: 'STM32F103C8T6',
        description: 'ARM Cortex-M3 32-bit MCU, 64KB Flash, 72MHz, LQFP-48',
        manufacturer: 'STMicroelectronics',
        footprint: {
            id: 'LQFP-48_7x7mm_P0.5mm',
            name: 'LQFP-48_7x7mm_P0.5mm',
            family: 'IC',
            pads: Array.from({length: 48}).map((_, i) => {
                const side = Math.floor(i / 12);
                const pos = i % 12;
                const offset = (pos - 5.5) * 0.5;
                if (side === 0) return { id: `${i + 1}`, num: `${i + 1}`, x: -4.5, y: offset, w: 1.2, h: 0.3 };
                if (side === 1) return { id: `${i + 1}`, num: `${i + 1}`, x: offset, y: 4.5, w: 0.3, h: 1.2 };
                if (side === 2) return { id: `${i + 1}`, num: `${i + 1}`, x: 4.5, y: -offset, w: 1.2, h: 0.3 };
                return { id: `${i + 1}`, num: `${i + 1}`, x: -offset, y: -4.5, w: 0.3, h: 1.2 };
            }),
            silk: [{ kind: 'line', x1: -3.5, y1: -3.5, x2: -3.5, y2: -2.5 }]
        },
        spiceModel: `* STM32 MCU Base Model\n.subckt STM32F103 VDD VSS\n.ends STM32F103`
    }
];

export default function OnlineComponentModal({ onClose, onComponentDownloaded }) {
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(false);
    const [results, setResults] = useState([]);

    const handleSearch = () => {
        setBusy(true);
        // Simulate network API request to SnapEDA / ComponentSearchEngine
        setTimeout(() => {
            const query = q.toLowerCase();
            const matches = MOCK_API_RESULTS.filter(r => r.name.toLowerCase().includes(query) || r.description.toLowerCase().includes(query));
            setResults(matches.length > 0 ? matches : MOCK_API_RESULTS); // default show all if no exact match for demo
            setBusy(false);
        }, 800);
    };

    const handleDownload = (comp) => {
        // 1. Add Footprint to PCB Layout Library
        addFootprint(comp.footprint);
        
        // 2. Alert user and pass back to parent (to add to SPICE library)
        alert(`Downloaded ${comp.name}! Footprint ${comp.footprint.id} added to PCB Studio.`);
        if (onComponentDownloaded) {
            onComponentDownloaded(comp);
        }
        onClose();
    };

    if (typeof document === 'undefined') return null;

    return createPortal(
        <div className="cs-model-lib-root" role="dialog" aria-modal="true">
            <button type="button" className="cs-model-lib-backdrop" onClick={onClose} aria-label="Close" />
            <div className="cs-model-lib-card" style={{ maxWidth: '700px' }}>
                <div className="cs-model-lib-head">
                    <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Cpu size={20} /> Online Component Search (API Demo)
                    </h2>
                    <button type="button" className="cs-model-lib-x" onClick={onClose} aria-label="Close">
                        <X size={18} />
                    </button>
                </div>
                <p className="cs-model-lib-lead">
                    Search for real-world electronic components. Downloads include the <strong>SPICE Symbol</strong> for Circuit Studio and the accurate <strong>PCB Footprint</strong> for PCB Studio.
                </p>
                
                <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                    <label className="cs-model-lib-search" style={{ flex: 1 }}>
                        <Search size={14} />
                        <input
                            type="search"
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                            placeholder="e.g. NE555, STM32..."
                        />
                    </label>
                    <button type="button" className="cs-topbtn cs-topbtn-primary" onClick={handleSearch} disabled={busy}>
                        {busy ? 'Searching...' : 'Search'}
                    </button>
                </div>

                <div className="cs-model-lib-body" style={{ flexDirection: 'column' }}>
                    <ul className="cs-model-lib-list">
                        {results.length === 0 && !busy && q && (
                            <p className="cs-model-lib-empty">No components found. Try NE555 or STM32.</p>
                        )}
                        {results.map((comp) => (
                            <li key={comp.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <div className="cs-model-lib-item-title" style={{ fontSize: '1.1rem', color: '#a855f7' }}>{comp.name}</div>
                                    <div className="cs-model-lib-item-meta">{comp.manufacturer}</div>
                                    <div className="cs-model-lib-item-desc">{comp.description}</div>
                                    <div className="cs-model-lib-item-meta" style={{ marginTop: '4px' }}>
                                        <strong>Footprint:</strong> {comp.footprint.name} | <strong>Pads:</strong> {comp.footprint.pads.length}
                                    </div>
                                </div>
                                <div>
                                    <button
                                        type="button"
                                        className="cs-topbtn cs-topbtn-primary"
                                        onClick={() => handleDownload(comp)}
                                    >
                                        <Download size={14} /> Download CAD
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>,
        document.body
    );
}
