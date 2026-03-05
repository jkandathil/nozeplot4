import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check } from 'lucide-react';
import './Calculator.css';

const Calculator = ({ isOpen, onClose }) => {
    const [display, setDisplay] = useState('0');
    const [equation, setEquation] = useState('');
    const [copied, setCopied] = useState(false);
    const [justCalculated, setJustCalculated] = useState(false);

    const handleNumber = (num) => {
        if (display === '0' || justCalculated) {
            setDisplay(num);
            setJustCalculated(false);
        } else {
            setDisplay(display + num);
        }
    };

    const handleOperator = (op) => {
        setEquation(display + ' ' + op + ' ');
        setJustCalculated(true);
    };

    const handleEqual = () => {
        try {
            // Evaluates simple math strings. In a production app you'd parse securely, 
            // but for a purely client-side basic calculator, eval or Function is OK-ish.
            // A safer simple approach:
            const fullEq = equation + display;
            // eslint-disable-next-line
            const result = new Function('return ' + fullEq)();

            // Format to avoid long decimals
            const formattedResult = Number.isInteger(result) ? result.toString() : parseFloat(result.toFixed(6)).toString();

            setDisplay(formattedResult);
            setEquation('');
            setJustCalculated(true);
        } catch (e) {
            setDisplay('Error');
            setJustCalculated(true);
        }
    };

    const handleClear = () => {
        setDisplay('0');
        setEquation('');
        setJustCalculated(false);
    };

    const handleDelete = () => {
        if (justCalculated) return;
        if (display.length > 1) {
            setDisplay(display.slice(0, -1));
        } else {
            setDisplay('0');
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(display);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Keyboard support
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e) => {
            const key = e.key;
            if (/[0-9.]/.test(key)) {
                handleNumber(key);
            } else if (['+', '-', '*', '/'].includes(key)) {
                handleOperator(key);
            } else if (key === 'Enter' || key === '=') {
                e.preventDefault();
                handleEqual();
            } else if (key === 'Escape') {
                onClose();
            } else if (key === 'Backspace') {
                handleDelete();
            } else if (key === 'c' || key === 'C') {
                handleClear();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, display, equation, justCalculated]); // eslint-disable-line

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    drag
                    dragMomentum={false}
                    initial={{ opacity: 0, scale: 0.8, y: -20, x: -20 }}
                    animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: -20 }}
                    transition={{ type: "spring", stiffness: 300, damping: 25 }}
                    style={{
                        position: 'fixed',
                        top: 80,
                        right: 80,
                        zIndex: 9999,
                        cursor: 'grab'
                    }}
                    whileDrag={{ cursor: 'grabbing', scale: 1.02 }}
                >
                    <div className="calc-container glass-panel">
                        <div className="calc-header">
                            <span className="calc-title">Calculator</span>
                            <div className="calc-actions">
                                <button className="icon-btn tiny" onClick={handleCopy} title="Copy Result">
                                    {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                                </button>
                                <button className="icon-btn tiny close-btn" onClick={onClose} title="Close">
                                    <X size={14} />
                                </button>
                            </div>
                        </div>

                        <div className="calc-screen">
                            <div className="calc-equation">{equation}</div>
                            <div className="calc-display" style={{ fontSize: display.length > 10 ? '1.5rem' : '2rem' }}>
                                {display}
                            </div>
                        </div>

                        <div className="calc-keypad">
                            <button className="calc-btn op-btn" onClick={handleClear}>C</button>
                            <button className="calc-btn op-btn" onClick={handleDelete}>⌫</button>
                            <button className="calc-btn op-btn" onClick={() => handleOperator('/')}>÷</button>
                            <button className="calc-btn op-btn" onClick={() => handleOperator('*')}>×</button>

                            <button className="calc-btn num-btn" onClick={() => handleNumber('7')}>7</button>
                            <button className="calc-btn num-btn" onClick={() => handleNumber('8')}>8</button>
                            <button className="calc-btn num-btn" onClick={() => handleNumber('9')}>9</button>
                            <button className="calc-btn op-btn" onClick={() => handleOperator('-')}>−</button>

                            <button className="calc-btn num-btn" onClick={() => handleNumber('4')}>4</button>
                            <button className="calc-btn num-btn" onClick={() => handleNumber('5')}>5</button>
                            <button className="calc-btn num-btn" onClick={() => handleNumber('6')}>6</button>
                            <button className="calc-btn op-btn" onClick={() => handleOperator('+')}>+</button>

                            <button className="calc-btn num-btn" onClick={() => handleNumber('1')}>1</button>
                            <button className="calc-btn num-btn" onClick={() => handleNumber('2')}>2</button>
                            <button className="calc-btn num-btn" onClick={() => handleNumber('3')}>3</button>

                            <button className="calc-btn op-btn eval-btn" style={{ gridRow: 'span 2' }} onClick={handleEqual}>=</button>

                            <button className="calc-btn num-btn" style={{ gridColumn: 'span 2' }} onClick={() => handleNumber('0')}>0</button>
                            <button className="calc-btn num-btn" onClick={() => handleNumber('.')}>.</button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default Calculator;
