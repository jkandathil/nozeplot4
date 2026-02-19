import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronDown, X, FileText } from 'lucide-react';
import './MultiFileSelect.css';

const MultiFileSelect = ({ options, selected, onChange, placeholder = "Select files..." }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (containerRef.current && !containerRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelect = (e, optionId) => {
        e.preventDefault();
        e.stopPropagation();
        if (selected.includes(optionId)) {
            onChange(selected.filter(id => id !== optionId));
        } else {
            onChange([...selected, optionId]);
        }
    };

    const handleRemove = (e, optionId) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(selected.filter(id => id !== optionId));
    };

    const handleSelectAll = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (selected.length === options.length) {
            onChange([]);
        } else {
            onChange(options.map(opt => opt.id));
        }
    };

    const selectedOptions = options.filter(opt => selected.includes(opt.id));
    const MAX_VISIBLE_CHIPS = 2;

    return (
        <div className="multi-select-container" ref={containerRef}>
            <div
                className={`multi-select-trigger glass-panel ${isOpen ? 'active' : ''}`}
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="selected-chips">
                    {selectedOptions.length === 0 ? (
                        <span className="placeholder">{placeholder}</span>
                    ) : (
                        <>
                            {selectedOptions.slice(0, MAX_VISIBLE_CHIPS).map(opt => (
                                <span key={opt.id} className="chip">
                                    <span className="chip-text" title={opt.name}>{opt.name}</span>
                                    <span
                                        className="chip-remove"
                                        onClick={(e) => handleRemove(e, opt.id)}
                                    >
                                        <X size={12} />
                                    </span>
                                </span>
                            ))}
                            {selectedOptions.length > MAX_VISIBLE_CHIPS && (
                                <span className="chip more-chip">
                                    +{selectedOptions.length - MAX_VISIBLE_CHIPS} more
                                </span>
                            )}
                        </>
                    )}
                </div>
                <ChevronDown size={16} className={`arrow ${isOpen ? 'open' : ''}`} />
            </div>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        className="multi-select-dropdown glass-panel"
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2 }}
                    >
                        {options.length > 0 && (
                            <div
                                className="multi-select-option select-all"
                                onClick={handleSelectAll}
                            >
                                <div className={`checkbox ${selected.length === options.length ? 'checked' : ''}`}>
                                    {selected.length === options.length && <Check size={12} />}
                                </div>
                                <span>Select All</span>
                            </div>
                        )}

                        {options.map(option => (
                            <div
                                key={option.id}
                                className="multi-select-option"
                                onClick={(e) => handleSelect(e, option.id)}
                            >
                                <div className={`checkbox ${selected.includes(option.id) ? 'checked' : ''}`}>
                                    {selected.includes(option.id) && <Check size={12} />}
                                </div>
                                <FileText size={14} className="option-icon" />
                                <span className="option-label">{option.name}</span>
                            </div>
                        ))}

                        {options.length === 0 && (
                            <div className="no-options">No files available</div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default MultiFileSelect;
