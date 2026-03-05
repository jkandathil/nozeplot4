import React, { useState, useEffect, useRef } from 'react';
import { X, Calculator } from 'lucide-react';

export const UnitConverterWidget = ({ onClose }) => {
    const [inputValue, setInputValue] = useState(10);
    const [fromUnit, setFromUnit] = useState('ppm');
    const [toUnit, setToUnit] = useState('ppb');
    const [molarMass, setMolarMass] = useState(17.03); // default NH3
    const [temperature, setTemperature] = useState(25); // °C
    const [pressure, setPressure] = useState(1); // atm
    const [result, setResult] = useState(0);

    const [position, setPosition] = useState({ x: 100, y: 100 });
    const [isDragging, setIsDragging] = useState(false);
    const dragRef = useRef(null);

    const units = [
        { label: 'Volume', options: ['%', 'ppm', 'ppb'] },
        { label: 'Mass Concentration', options: ['mg/m³', 'µg/L', 'µg/m³'] },
        { label: 'Partial Pressure', options: ['atm', 'mmHg', 'Pa'] }
    ];

    // Drag logic
    useEffect(() => {
        const handleMouseMove = (e) => {
            if (isDragging) {
                setPosition(prev => ({
                    x: prev.x + e.movementX,
                    y: prev.y + e.movementY
                }));
            }
        };
        const handleMouseUp = () => setIsDragging(false);

        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);

    const calculateConversion = () => {
        let val = parseFloat(inputValue);
        if (isNaN(val)) return 0;

        // Convert everything to a base unit first: mole fraction (pure number)
        let moleFraction = 0;

        // 1. Convert FROM unit to Mole Fraction
        if (['%', 'ppm', 'ppb'].includes(fromUnit)) {
            if (fromUnit === '%') moleFraction = val / 100;
            if (fromUnit === 'ppm') moleFraction = val / 1e6;
            if (fromUnit === 'ppb') moleFraction = val / 1e9;
        } else if (['mg/m³', 'µg/L', 'µg/m³'].includes(fromUnit)) {
            // mg/m³ is equivalent to µg/L.
            // Formula: ppm = (mg/m³) * (24.45) / Molar Mass
            // where 24.45 is the molar volume of ideal gas at 25°C and 1 atm.
            // More accurately: V_m = R * T / P
            const T_K = parseFloat(temperature) + 273.15;
            const P_atm = parseFloat(pressure);
            const V_m = (0.08206 * T_K) / P_atm; // L/mol

            let mg_per_m3 = val;
            if (fromUnit === 'µg/m³') mg_per_m3 = val / 1000;

            const ppm = (mg_per_m3 * V_m) / parseFloat(molarMass);
            moleFraction = ppm / 1e6;
        } else if (['atm', 'mmHg', 'Pa'].includes(fromUnit)) {
            let partialPressureAtm = val;
            if (fromUnit === 'mmHg') partialPressureAtm = val / 760;
            if (fromUnit === 'Pa') partialPressureAtm = val / 101325;

            moleFraction = partialPressureAtm / parseFloat(pressure);
        }

        // 2. Convert Mole Fraction to TO unit
        let output = 0;
        if (['%', 'ppm', 'ppb'].includes(toUnit)) {
            if (toUnit === '%') output = moleFraction * 100;
            if (toUnit === 'ppm') output = moleFraction * 1e6;
            if (toUnit === 'ppb') output = moleFraction * 1e9;
        } else if (['mg/m³', 'µg/L', 'µg/m³'].includes(toUnit)) {
            const T_K = parseFloat(temperature) + 273.15;
            const P_atm = parseFloat(pressure);
            const V_m = (0.08206 * T_K) / P_atm; // L/mol

            const ppm = moleFraction * 1e6;
            const mg_per_m3 = (ppm * parseFloat(molarMass)) / V_m;

            if (toUnit === 'µg/m³') output = mg_per_m3 * 1000;
            else output = mg_per_m3; // mg/m³ and µg/L are same magnitude
        } else if (['atm', 'mmHg', 'Pa'].includes(toUnit)) {
            const partialPressureAtm = moleFraction * parseFloat(pressure);
            if (toUnit === 'atm') output = partialPressureAtm;
            if (toUnit === 'mmHg') output = partialPressureAtm * 760;
            if (toUnit === 'Pa') output = partialPressureAtm * 101325;
        }

        return output;
    };

    useEffect(() => {
        setResult(calculateConversion());
    }, [inputValue, fromUnit, toUnit, molarMass, temperature, pressure]);

    // Helpers to format output
    const formatOutput = (val) => {
        if (Math.abs(val) < 0.001 || Math.abs(val) > 1e6) return val.toExponential(4);
        return window.parseFloat(val.toFixed(4));
    };

    const needsMolarMass = ['mg/m³', 'µg/L', 'µg/m³'].includes(fromUnit) || ['mg/m³', 'µg/L', 'µg/m³'].includes(toUnit);

    return (
        <div style={{
            position: 'absolute',
            left: position.x,
            top: position.y,
            width: '320px',
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(16px)',
            borderRadius: '12px',
            border: '1px solid rgba(56, 189, 248, 0.3)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
            overflow: 'hidden',
            fontFamily: 'Inter, sans-serif',
            color: '#f8fafc'
        }}>
            {/* Header / Drag handle */}
            <div
                ref={dragRef}
                onMouseDown={() => setIsDragging(true)}
                style={{
                    padding: '12px 16px',
                    background: 'rgba(56, 189, 248, 0.1)',
                    borderBottom: '1px solid rgba(56, 189, 248, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: isDragging ? 'grabbing' : 'grab',
                    userSelect: 'none'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#38bdf8', fontWeight: 600 }}>
                    <Calculator size={16} /> Unit Converter
                </div>
                <button
                    onClick={onClose}
                    style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 4 }}
                >
                    <X size={16} />
                </button>
            </div>

            {/* Body */}
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

                {/* Input Row */}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>Value</label>
                        <input
                            type="number"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '8px',
                                background: 'rgba(0,0,0,0.3)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px',
                                color: 'white',
                                outline: 'none'
                            }}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>From Unit</label>
                        <select
                            value={fromUnit}
                            onChange={(e) => setFromUnit(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '8px',
                                background: 'rgba(0,0,0,0.6)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px',
                                color: 'white',
                                outline: 'none'
                            }}
                        >
                            {units.map((group, i) => (
                                <optgroup label={group.label} key={i}>
                                    {group.options.map((opt, j) => <option key={j} value={opt}>{opt}</option>)}
                                </optgroup>
                            ))}
                        </select>
                    </div>
                </div>

                {/* To Unit Row */}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, textAlign: 'center', color: '#64748b' }}>
                        &#8595; Equals
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '4px' }}>To Unit</label>
                        <select
                            value={toUnit}
                            onChange={(e) => setToUnit(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '8px',
                                background: 'rgba(0,0,0,0.6)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '6px',
                                color: 'white',
                                outline: 'none'
                            }}
                        >
                            {units.map((group, i) => (
                                <optgroup label={group.label} key={i}>
                                    {group.options.map((opt, j) => <option key={j} value={opt}>{opt}</option>)}
                                </optgroup>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Result Display */}
                <div style={{
                    padding: '12px',
                    background: 'rgba(56, 189, 248, 0.05)',
                    border: '1px dashed rgba(56, 189, 248, 0.3)',
                    borderRadius: '8px',
                    textAlign: 'center',
                    marginTop: '4px'
                }}>
                    <strong style={{ fontSize: '1.2rem', color: '#38bdf8' }}>
                        {formatOutput(result)} {toUnit}
                    </strong>
                </div>

                {/* Conditional Inputs for Ideal Gas calculations */}
                <div style={{
                    marginTop: '8px',
                    paddingTop: '12px',
                    borderTop: '1px solid rgba(255,255,255,0.05)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                }}>
                    {needsMolarMass && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <label style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Molar Mass (g/mol)</label>
                            <input
                                type="number"
                                value={molarMass}
                                onChange={(e) => setMolarMass(e.target.value)}
                                style={{
                                    width: '80px',
                                    padding: '4px 8px',
                                    background: 'rgba(0,0,0,0.3)',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: '4px',
                                    color: 'white',
                                    fontSize: '0.8rem'
                                }}
                            />
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <label style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Temperature (°C)</label>
                        <input
                            type="number"
                            value={temperature}
                            onChange={(e) => setTemperature(e.target.value)}
                            style={{
                                width: '80px',
                                padding: '4px 8px',
                                background: 'rgba(0,0,0,0.3)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '4px',
                                color: 'white',
                                fontSize: '0.8rem'
                            }}
                        />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <label style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Pressure (atm)</label>
                        <input
                            type="number"
                            value={pressure}
                            onChange={(e) => setPressure(e.target.value)}
                            step="0.1"
                            style={{
                                width: '80px',
                                padding: '4px 8px',
                                background: 'rgba(0,0,0,0.3)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '4px',
                                color: 'white',
                                fontSize: '0.8rem'
                            }}
                        />
                    </div>
                </div>

            </div>
        </div>
    );
};
