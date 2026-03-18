import React, { useRef, useState } from 'react';
import {
    Folder, FileText, UploadCloud, ChevronRight, BarChart2, Search, Trash2,
    Activity, CheckSquare, Square, LineChart, FileSpreadsheet,
    Network, Calculator as CalcIcon, FlaskConical, Brain, Layers, DownloadCloud, MonitorUp
} from 'lucide-react';
import './Sidebar.css';
import { exportWorkspaceSession, importWorkspaceSession } from '../utils/fileSaver';
const logo = `${import.meta.env.BASE_URL}logo_noze_circle.png`;

const Sidebar = ({ files, onFileSelect, selectedFileId, compareFileIds = [], onUpload, onDeleteFile, onDeleteFiles, onDeleteAllFiles, onSelectAll, onSelectFiles, userName = "User", activePage = 'dashboard', onPageChange, isCalculatorOpen, setIsCalculatorOpen }) => {
    const fileInputRef = useRef(null);
    const folderInputRef = useRef(null);
    const nozeInputRef = useRef(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [sidebarWidth, setSidebarWidth] = useState(250);

    const handleMouseDown = React.useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebarWidth;

        const onMouseMove = (moveEvent) => {
            let newWidth = startWidth + (moveEvent.clientX - startX);
            if (newWidth < 200) newWidth = 200;
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

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleFolderUploadClick = () => {
        folderInputRef.current?.click();
    };

    const filteredFiles = files.filter(f =>
        f.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const [hoveredFile, setHoveredFile] = useState(null);
    const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });

    const handleMouseEnter = (e, file) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setTooltipPos({
            top: rect.top + (rect.height / 2),
            left: rect.right + 10
        });
        setHoveredFile(file);
    };

    const activeAUs = React.useMemo(() => {
        const groups = {};
        for (const f of files) {
            // Ensure we strictly extract the ASAU ID from the CSV filename itself, not its parent folder paths
            const baseName = f.name.split('/').pop().split('\\').pop();
            const fileParts = baseName.split('_');
            const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));
            const auId = asauPart ? asauPart.toUpperCase() : 'UNKNOWN_AU';
            if (!groups[auId]) groups[auId] = [];
            groups[auId].push(f);
        }
        return groups;
    }, [files]);

    return (
        <aside className="sidebar" style={{ width: sidebarWidth, position: 'relative' }}>
            {/* Drag Handle */}
            <div
                onMouseDown={handleMouseDown}
                style={{
                    position: 'absolute',
                    top: 0,
                    right: -3,
                    width: '6px',
                    height: '100%',
                    cursor: 'col-resize',
                    zIndex: 100,
                    transition: 'background 0.2s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(56, 189, 248, 0.4)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            />
            {hoveredFile && (
                <div
                    className="fixed-tooltip"
                    style={{
                        position: 'fixed',
                        top: tooltipPos.top,
                        left: tooltipPos.left,
                        transform: 'translateY(-50%)',
                        zIndex: 9999,
                        background: '#0f172a',
                        color: '#f8fafc',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                        pointerEvents: 'none',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                        border: '1px solid rgba(56, 189, 248, 0.2)'
                    }}
                >
                    {hoveredFile.name}
                </div>
            )}
            <div className="sidebar-header" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '0.5rem' }}>
                <div className="logo" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                    <img src={logo} alt="NozePlots4 Logo" className="logo-icon" />
                    <span>NozePlot</span>
                </div>
                <div className="user-profile" style={{ padding: 0 }}>
                    <div className="avatar" style={{ width: 30, height: 30, fontSize: '0.85rem', cursor: 'pointer' }} title={`${userName} - Data Analyst`}>
                        {userName.charAt(0).toUpperCase()}
                    </div>
                </div>
            </div>

            {/* Page navigation */}
            <div style={{
                display: 'flex',
                gap: 6,
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-color)',
                flexShrink: 0,
                flexWrap: 'wrap'
            }}>
                <button
                    onClick={() => onPageChange?.('dashboard')}
                    style={{
                        flex: '1 1 40%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        background: activePage === 'dashboard' ? 'rgba(56,189,248,0.15)' : 'transparent',
                        color: activePage === 'dashboard' ? 'var(--accent-primary)' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Dashboard"
                >
                    <BarChart2 size={14} /> Dashboard
                </button>
                <button
                    onClick={() => onPageChange?.('normalize')}
                    style={{
                        flex: '1 1 40%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        background: activePage === 'normalize' ? 'rgba(251,191,36,0.15)' : 'transparent',
                        color: activePage === 'normalize' ? '#fbbf24' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Baseline Normalization"
                >
                    <Activity size={14} /> Normalize
                </button>
                <button
                    onClick={() => onPageChange?.('aromaAnalysis')}
                    style={{
                        flex: '1 1 40%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        background: activePage === 'aromaAnalysis' ? 'rgba(16,185,129,0.15)' : 'transparent',
                        color: activePage === 'aromaAnalysis' ? '#10b981' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Aroma Sensor Data Analysis"
                >
                    <LineChart size={14} /> Aroma
                </button>
                <button
                    onClick={() => onPageChange?.('recoveryAnalysis')}
                    style={{
                        flex: '1 1 40%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        background: activePage === 'recoveryAnalysis' ? 'rgba(245,158,11,0.15)' : 'transparent',
                        color: activePage === 'recoveryAnalysis' ? '#f59e0b' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Chronological Baseline Recovery & Drift Tracker"
                >
                    <Activity size={14} /> Drift Map
                </button>
                <button
                    onClick={() => onPageChange?.('csvPlotter')}
                    style={{
                        flex: '1 1 40%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 3,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.70rem',
                        fontWeight: 600,
                        background: activePage === 'csvPlotter' ? 'rgba(168,85,247,0.15)' : 'transparent',
                        color: activePage === 'csvPlotter' ? '#a855f7' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="SE Analysis from Custom CSV Data"
                >
                    <FileSpreadsheet size={13} /> SE Analysis
                </button>
                <button
                    onClick={() => onPageChange?.('manufacturing')}
                    style={{
                        flex: '1 1 40%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 3,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '0.70rem',
                        fontWeight: 600,
                        background: activePage === 'manufacturing' ? 'rgba(244,63,94,0.15)' : 'transparent',
                        color: activePage === 'manufacturing' ? '#f43f5e' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Manufacturing Variation and Yield Analysis"
                >
                    <Layers size={13} /> Mfg. Variation
                </button>
            </div>

            {/* Utility Tools Section */}
            <div style={{ padding: '0 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: 16, marginTop: 12 }}>
                <button
                    onClick={() => onPageChange?.('gasDesign')}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.05)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background: activePage === 'gasDesign' ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.02)',
                        color: activePage === 'gasDesign' ? '#a855f7' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Design of Gas Dilution System"
                >
                    <Network size={14} /> System
                </button>
                <button
                    onClick={() => onPageChange?.('gasMath')}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.05)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background: activePage === 'gasMath' ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.02)',
                        color: activePage === 'gasMath' ? '#38bdf8' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Gas-Dilution Math Tool"
                >
                    <FlaskConical size={14} /> Dilution
                </button>
                <button
                    onClick={() => setIsCalculatorOpen(!isCalculatorOpen)}
                    style={{
                        gridColumn: '1 / -1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.05)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background: isCalculatorOpen ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.02)',
                        color: isCalculatorOpen ? '#10b981' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Popup Calculator"
                >
                    <CalcIcon size={14} /> Calculator
                </button>
                <button
                    onClick={() => onPageChange?.('mlStudio')}
                    style={{
                        gridColumn: '1 / -1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.05)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background: activePage === 'mlStudio' ? 'rgba(244,63,94,0.15)' : 'rgba(255,255,255,0.02)',
                        color: activePage === 'mlStudio' ? '#f43f5e' : 'var(--text-muted)',
                        transition: 'all 0.15s',
                        marginBottom: '8px'
                    }}
                    title="Machine Learning & Prediction"
                >
                    <Brain size={14} /> ML Studio
                </button>
            </div>

            <div className="upload-section">
                <button className="btn-primary upload-btn" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)' }} onClick={handleFolderUploadClick}>
                    <Folder className="icon" size={18} />
                    <span>Upload Folder</span>
                </button>
                <button
                    className="btn-secondary upload-btn-folder"
                    onClick={handleUploadClick}
                    title="Upload Files"
                >
                    <FileText className="icon" size={18} color="#94a3b8" />
                </button>
                <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    multiple
                    accept=".csv,.xlsx,.xls"
                    onChange={onUpload}
                />
                <input
                    type="file"
                    ref={folderInputRef}
                    style={{ display: 'none' }}
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={onUpload}
                />
                <input
                    type="file"
                    accept=".noze"
                    style={{ display: 'none' }}
                    ref={nozeInputRef}
                    onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        try {
                            const read = new FileReader();
                            read.onload = async (e) => {
                                const restoredAppState = await importWorkspaceSession(e.target.result);
                                alert("Workspace restored successfully! Press OK to refresh the window to safely inject datasets.");
                                window.location.reload();
                            };
                            read.readAsText(file);
                        } catch (err) {
                            alert("Failed to restore NOZE workspace.");
                        }
                    }}
                />
            </div>

            {files.length > 0 && (
                <div className="search-box">
                    <Search className="search-icon" size={14} />
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="search-input"
                    />
                </div>
            )}

            <div className="file-list-container">
                <div className="workspace-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h3 className="section-title" style={{ margin: 0, fontSize: '0.65rem', fontWeight: 600 }}>Workspace ({files.length})</h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {/* Session Restore Button */}
                        <button
                            onClick={(e) => { e.stopPropagation(); nozeInputRef.current?.click(); }}
                            title="Restore Workspace Session (.noze)"
                            style={{
                                background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px',
                                transition: 'background 0.2s', opacity: 0.8
                            }}
                            onMouseOver={(e) => e.currentTarget.style.background = 'rgba(168, 85, 247, 0.15)'}
                            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                            <MonitorUp size={16} color="#a855f7" strokeWidth={2} />
                        </button>
                        {/* Session Export Button */}
                        {files.length > 0 && (
                            <button
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                        await exportWorkspaceSession({ selectedFileId, compareFileIds, activePage });
                                        alert("Workspace session downloaded successfully!");
                                    } catch (err) {
                                        alert("Error exporting session.");
                                    }
                                }}
                                title="Export Workspace Session to .noze file"
                                style={{
                                    background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px',
                                    transition: 'background 0.2s', opacity: 0.8
                                }}
                                onMouseOver={(e) => e.currentTarget.style.background = 'rgba(16, 185, 129, 0.15)'}
                                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                <DownloadCloud size={16} color="#10b981" strokeWidth={2} />
                            </button>
                        )}

                        {/* Select All Button */}
                        {files.length > 1 && onSelectAll && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onSelectAll(); }}
                                title={compareFileIds?.length === (files.length - 1) && selectedFileId ? "Deselect All" : "Select All for Compare"}
                                style={{
                                    background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px',
                                    transition: 'background 0.2s', opacity: 0.8
                                }}
                                onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                {compareFileIds?.length === (files.length - 1) && selectedFileId ?
                                    <CheckSquare size={16} color="#fbbf24" strokeWidth={2} /> :
                                    <Square size={16} color="#94a3b8" strokeWidth={2} />
                                }
                            </button>
                        )}

                        {/* Delete All Button */}
                        {files.length > 0 && onDeleteAllFiles && (
                            <button
                                className="delete-all-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (onDeleteAllFiles) onDeleteAllFiles(e);
                                }}
                                title="Delete All Files"
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#ef4444',
                                    cursor: 'pointer',
                                    padding: '4px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderRadius: '4px',
                                    transition: 'background 0.2s',
                                }}
                                onMouseOver={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                <Trash2 size={16} />
                            </button>
                        )}
                    </div>
                </div>

                {Object.keys(activeAUs).length > 0 && (
                    <div style={{ marginBottom: '16px', padding: '10px', background: 'rgba(56, 189, 248, 0.08)', borderRadius: '6px', border: '1px solid rgba(56, 189, 248, 0.15)' }}>
                        <span style={{ fontSize: '0.65rem', color: '#38bdf8', display: 'block', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>Available AU Devices</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {Object.keys(activeAUs).map(auId => {
                                const auFiles = activeAUs[auId];
                                const auFileIds = auFiles.map(f => f.id);
                                // Check if ALL files in this AU are currently selected
                                const isAllSelected = auFileIds.every(id => id === selectedFileId || compareFileIds?.includes(id));

                                return (
                                    <div key={auId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: 0 }}>
                                            <input
                                                type="checkbox"
                                                checked={isAllSelected}
                                                onChange={(e) => {
                                                    if (!onSelectFiles) return;
                                                    const currentSelected = [selectedFileId, ...(compareFileIds || [])].filter(Boolean);
                                                    if (e.target.checked) {
                                                        // Select all files in this AU (union)
                                                        const newSelected = Array.from(new Set([...currentSelected, ...auFileIds]));
                                                        onSelectFiles(newSelected);
                                                    } else {
                                                        // Deselect all files in this AU
                                                        const newSelected = currentSelected.filter(id => !auFileIds.includes(id));
                                                        onSelectFiles(newSelected);
                                                    }
                                                }}
                                                style={{ width: 14, height: 14, accentColor: '#38bdf8', cursor: 'pointer' }}
                                            />
                                            <span style={{ fontSize: '0.75rem', color: '#f8fafc', fontWeight: 500 }}>{auId}</span>
                                        </label>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: '0.65rem', color: '#94a3b8' }}>({auFiles.length})</span>
                                            {onDeleteFiles && (
                                                <button
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        if (window.confirm(`Are you sure you want to delete all ${auFiles.length} files from ${auId}?`)) {
                                                            onDeleteFiles(e, auFileIds);
                                                        }
                                                    }}
                                                    title={`Delete all ${auId} files`}
                                                    style={{
                                                        background: 'transparent',
                                                        border: 'none',
                                                        color: '#ef4444',
                                                        cursor: 'pointer',
                                                        padding: '2px',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        borderRadius: '4px',
                                                        transition: 'background 0.2s',
                                                    }}
                                                    onMouseOver={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                                                    onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
                {files.length === 0 ? (
                    <div className="empty-files">
                        <p>No files uploaded</p>
                    </div>
                ) : (
                    <ul className="file-list">
                        {filteredFiles.map((file) => (
                            <li
                                key={file.id}
                                className={`file-item ${selectedFileId === file.id ? 'active' : ''} ${compareFileIds?.includes(file.id) ? 'compare-active' : ''}`}
                                onClick={(e) => onFileSelect(file.id, e.ctrlKey || e.metaKey)}
                                onMouseEnter={(e) => handleMouseEnter(e, file)}
                                onMouseLeave={() => setHoveredFile(null)}
                            >
                                <div className="file-icon">
                                    <FileText size={16} />
                                </div>
                                <div className="file-details">
                                    <span className="file-name">{file.name}</span>
                                    <span className="file-meta">
                                        {(file.file.size / 1024).toFixed(1)} KB
                                    </span>
                                </div>
                                <button
                                    className={`compare-btn ${compareFileIds?.includes(file.id) || selectedFileId === file.id ? 'active' : ''}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onFileSelect(file.id, true);
                                    }}
                                    title={selectedFileId === file.id ? "Main File (Click to deselect)" : (compareFileIds?.includes(file.id) ? "Remove comparison" : "Add to comparison")}
                                    style={{
                                        background: 'transparent', border: 'none', cursor: 'pointer',
                                        marginRight: 4, display: 'flex', alignItems: 'center', opacity: 0.8
                                    }}
                                >
                                    {selectedFileId === file.id ? (
                                        /* Main File: Blue Check */
                                        <div style={{ color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <div style={{ width: 13, height: 13, border: '1.5px solid #38bdf8', background: 'rgba(56,189,248,0.2)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <div style={{ width: 7, height: 4, borderLeft: '1.5px solid white', borderBottom: '1.5px solid white', transform: 'rotate(-45deg) translate(1px, -1px)' }} />
                                            </div>
                                        </div>
                                    ) : compareFileIds?.includes(file.id) ? (
                                        /* Compare File: Amber Check */
                                        <div style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <div style={{ width: 13, height: 13, border: '1.5px solid #fbbf24', background: 'rgba(251,191,36,0.2)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <div style={{ width: 7, height: 4, borderLeft: '1.5px solid white', borderBottom: '1.5px solid white', transform: 'rotate(-45deg) translate(1px, -1px)' }} />
                                            </div>
                                        </div>
                                    ) : (
                                        /* Inactive: Empty Box */
                                        <div style={{ width: 13, height: 13, border: '1.5px solid #94a3b8', borderRadius: 3, opacity: 0.5 }} />
                                    )}
                                </button>
                                <button
                                    className="delete-file-btn"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (onDeleteFile) onDeleteFile(e, file.id);
                                    }}
                                    title="Delete file"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

        </aside>
    );
};

export default Sidebar;
