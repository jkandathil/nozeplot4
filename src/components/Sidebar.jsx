import React, { useRef, useState } from 'react';
import {
    Folder, FileText, UploadCloud, ChevronRight, ChevronDown, BarChart2, Search, Trash2,
    Activity, CheckSquare, Square, LineChart, FileSpreadsheet,
    Network, Calculator as CalcIcon, FlaskConical, Brain, Layers, DownloadCloud, MonitorUp, FolderPlus, Blend,
    PanelLeftClose, PanelLeftOpen, Target, BookOpen, Usb, Download
} from 'lucide-react';
import './Sidebar.css';
import { exportWorkspaceSession, importWorkspaceSession } from '../utils/fileSaver';
import { estimateWorkspaceFileBytes } from '../utils/workspaceFilename';
import {
    downloadWorkspaceFileAsCsv,
    downloadFolderContentsAsCsvZip,
    downloadRootDataFilesAsCsvZip,
} from '../utils/workspaceCsvDownload';
const logo = `${import.meta.env.BASE_URL}logo_noze_circle.png`;

const Sidebar = ({ files, onFileSelect, selectedFileId, compareFileIds = [], onUpload, onDeleteFile, onDeleteFiles, onDeleteAllFiles, onSelectAll, onSelectFiles, userName = "User", activePage = 'dashboard', onPageChange, isCalculatorOpen, setIsCalculatorOpen, onCreateFolder, onDeleteFolder }) => {
    const fileInputRef = useRef(null);
    const folderInputRef = useRef(null);
    const nozeInputRef = useRef(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [sidebarWidth, setSidebarWidth] = useState(250);
    const [expandedFolders, setExpandedFolders] = useState(new Set());
    const [activeUploadFolderId, setActiveUploadFolderId] = useState(null);
    
    // NEW: Global Sidebar minimization toggle
    const [isCollapsed, setIsCollapsed] = useState(() => localStorage.getItem('zenMode') === 'true');

    const actualFiles = files.filter(f => !f.isFolder);
    const customFolders = files.filter(f => f.isFolder);

    const handleMouseDown = React.useCallback((e) => {
        if (isCollapsed) return; // disable resize while collapsed
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
    }, [sidebarWidth, isCollapsed]);

    const handleUploadClick = (folderId = null) => {
        setActiveUploadFolderId(typeof folderId === 'string' ? folderId : null);
        fileInputRef.current?.click();
    };

    const handleFolderUploadClick = (folderId = null) => {
        setActiveUploadFolderId(typeof folderId === 'string' ? folderId : null);
        folderInputRef.current?.click();
    };

    const [hoveredFile, setHoveredFile] = useState(null);
    const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
    const [csvExportBusy, setCsvExportBusy] = useState(false);

    const onDownloadFileCsv = async (e, file) => {
        e.stopPropagation();
        if (csvExportBusy || file.isFolder) return;
        setCsvExportBusy(true);
        try {
            await downloadWorkspaceFileAsCsv(file);
        } catch (err) {
            alert(err?.message || 'Could not download CSV.');
        } finally {
            setCsvExportBusy(false);
        }
    };

    const onDownloadFolderZip = async (e, folder) => {
        e.stopPropagation();
        if (csvExportBusy) return;
        setCsvExportBusy(true);
        try {
            await downloadFolderContentsAsCsvZip(folder, files);
        } catch (err) {
            alert(err?.message || 'Could not download folder.');
        } finally {
            setCsvExportBusy(false);
        }
    };

    const onDownloadRootZip = async (e) => {
        e.stopPropagation();
        if (csvExportBusy) return;
        setCsvExportBusy(true);
        try {
            await downloadRootDataFilesAsCsvZip(files);
        } catch (err) {
            alert(err?.message || 'Could not download DataFiles.');
        } finally {
            setCsvExportBusy(false);
        }
    };

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
            if (f.isFolder) continue;
            const baseName = f.name.split('/').pop().split('\\').pop();
            const fileParts = baseName.split('_');
            const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));
            const auId = asauPart ? asauPart.toUpperCase() : 'UNKNOWN_AU';
            if (!groups[auId]) groups[auId] = [];
            groups[auId].push(f);
        }
        return groups;
    }, [files]);

    const filteredFiles = actualFiles.filter(f =>
        f.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    /** Newest capture / upload first when a folder is expanded */
    const sortFolderFilesNewestFirst = (arr) =>
        [...arr].sort((a, b) => {
            const ta = Number(a.createdAt) || 0;
            const tb = Number(b.createdAt) || 0;
            if (tb !== ta) return tb - ta;
            return String(b.name || '').localeCompare(String(a.name || ''));
        });

    return (
        <aside className="sidebar" style={{ 
            width: isCollapsed ? 60 : sidebarWidth, 
            position: 'relative', 
            overflow: 'hidden',
            transition: 'width 0.4s cubic-bezier(0.33, 1, 0.68, 1)'
        }}>
            {/* Drag Handle */}
            {!isCollapsed && (
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
            )}
            
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
            <div className="sidebar-header" style={{ display: 'flex', flexDirection: 'row', justifyContent: isCollapsed ? 'center' : 'space-between', alignItems: 'center', paddingBottom: '0.5rem' }}>
                <div 
                    className="logo" 
                    style={{ borderBottom: 'none', paddingBottom: 0, cursor: 'pointer', padding: isCollapsed ? '8px 0' : '0', transition: 'opacity 0.2s' }}
                    onClick={() => {
                        const nextState = !isCollapsed;
                        setIsCollapsed(nextState);
                        localStorage.setItem('zenMode', nextState);
                        window.dispatchEvent(new CustomEvent('zen-mode-toggle', { detail: { isZen: nextState } }));
                    }}
                    title={isCollapsed ? "Expand Sidebar" : "Hide Sidebar"}
                    onMouseEnter={e => e.currentTarget.style.opacity = 0.8}
                    onMouseLeave={e => e.currentTarget.style.opacity = 1}
                >
                    <img src={logo} alt="NozePlots4 Logo" className="logo-icon" style={{ transition: 'transform 0.2s' }} />
                    {!isCollapsed && <span>NozePlot</span>}
                </div>
                {!isCollapsed && (
                    <div className="user-profile" style={{ padding: 0 }}>
                        <div className="avatar" style={{ width: 30, height: 30, fontSize: '0.85rem', cursor: 'pointer' }} title={`${userName} - Data Analyst`}>
                            {userName.charAt(0).toUpperCase()}
                        </div>
                    </div>
                )}
            </div>

            {/* Page navigation */}
            {!isCollapsed && (
            <div style={{
                display: 'flex',
                pointerEvents: 'auto',
                opacity: 1,
                gap: 6,
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-color)',
                flexShrink: 0,
                flexWrap: 'wrap',
                transition: 'opacity 0.2s'
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
                    onClick={() => onPageChange?.('help')}
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
                        background: activePage === 'help' ? 'rgba(129,140,248,0.2)' : 'transparent',
                        color: activePage === 'help' ? '#a5b4fc' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="User guide — instructions for every section"
                >
                    <BookOpen size={14} /> Help
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
                    onClick={() => onPageChange?.('separability')}
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
                        background: activePage === 'separability' ? 'rgba(251,191,36,0.15)' : 'transparent',
                        color: activePage === 'separability' ? '#fbbf24' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Time-Resolved Separability Analysis"
                >
                    <Activity size={14} /> Separability
                </button>
                <button
                    onClick={() => onPageChange?.('sensitivity')}
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
                        background: activePage === 'sensitivity' ? 'rgba(59,130,246,0.15)' : 'transparent',
                        color: activePage === 'sensitivity' ? '#3b82f6' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Element Sensitivity & Performance Map"
                >
                    <Target size={14} /> Sensitivity
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
                    onClick={() => onPageChange?.('aromaUnitCapture')}
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
                        background: activePage === 'aromaUnitCapture' ? 'rgba(45,212,191,0.15)' : 'transparent',
                        color: activePage === 'aromaUnitCapture' ? '#2dd4bf' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Capture SiAC / aroma unit over USB serial (Chrome)"
                >
                    <Usb size={13} /> AU capture
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
            )}

            {/* Utility Tools Section */}
            {!isCollapsed && (
                <>
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
                    onClick={() => onPageChange?.('polymerCbMix')}
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
                        background: activePage === 'polymerCbMix' ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.02)',
                        color: activePage === 'polymerCbMix' ? '#34d399' : 'var(--text-muted)',
                        transition: 'all 0.15s',
                    }}
                    title="Polymer–carbon black: wt% ↔ volume %"
                >
                    <Blend size={14} /> Polymer–CB
                </button>
                <button
                    onClick={() => setIsCalculatorOpen(!isCalculatorOpen)}
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
                        background: isCalculatorOpen ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.02)',
                        color: isCalculatorOpen ? '#10b981' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="Popup Calculator"
                >
                    <CalcIcon size={18} />
                </button>
                <button
                    onClick={() => onPageChange?.('mlStudio')}
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
                        background: activePage === 'mlStudio' ? 'rgba(244,63,94,0.15)' : 'rgba(255,255,255,0.02)',
                        color: activePage === 'mlStudio' ? '#f43f5e' : 'var(--text-muted)',
                        transition: 'all 0.15s'
                    }}
                    title="FeNOse ML Studio (inference & training)"
                >
                    <Brain size={18} />
                </button>
            </div>

            <div className="upload-section">
                <button className="btn-primary upload-btn" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)' }} onClick={() => handleFolderUploadClick()}>
                    <Folder className="icon" size={18} />
                    <span>Upload Folder</span>
                </button>
                <button
                    className="btn-secondary upload-btn-folder"
                    onClick={() => handleUploadClick()}
                    title="Upload Files"
                >
                    <FileText className="icon" size={18} color="#94a3b8" />
                </button>
                <button
                    className="btn-secondary upload-btn-folder"
                    onClick={() => {
                        const name = window.prompt("Enter new folder name:");
                        if (name && onCreateFolder) onCreateFolder(name);
                    }}
                    title="Create New Folder"
                >
                    <FolderPlus className="icon" size={18} color="#94a3b8" />
                </button>
                <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    multiple
                    accept=".csv,.xlsx,.xls"
                    onChange={(e) => {
                        onUpload(e, activeUploadFolderId);
                        setActiveUploadFolderId(null);
                        e.target.value = '';
                    }}
                />
                <input
                    type="file"
                    ref={folderInputRef}
                    style={{ display: 'none' }}
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={(e) => {
                        onUpload(e, activeUploadFolderId);
                        setActiveUploadFolderId(null);
                        e.target.value = '';
                    }}
                />
                <input
                    type="file"
                    accept=".noze"
                    style={{ display: 'none' }}
                    ref={nozeInputRef}
                    onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;

                        // We must reset the input value so the same file can trigger onChange again if needed
                        const resetInput = () => { e.target.value = ''; };

                        try {
                            const read = new FileReader();
                            read.onload = async (event) => {
                                try {
                                    const restoredAppState = await importWorkspaceSession(event.target.result);

                                    // Stash app state in local storage to automatically rebuild the workspace layout on window.location reload!
                                    localStorage.setItem('noze_restored_state', JSON.stringify(restoredAppState || {}));
                                    window.location.reload();
                                } catch (innerErr) {
                                    console.error("NOZE Restore Inner Error:", innerErr);
                                    alert("Failed to parse NOZE workspace file: " + (innerErr.message || "Invalid Format"));
                                } finally {
                                    resetInput();
                                }
                            };
                            read.onerror = (err) => {
                                console.error("File Read Error:", err);
                                alert("Failed to read the uploaded .noze file natively from disk.");
                                resetInput();
                            };
                            read.readAsText(file);
                        } catch (err) {
                            console.error("NOZE Restore Outer Error:", err);
                            alert("Failed to queue NOZE workspace file for upload.");
                            resetInput();
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
                                const isAllSelected = auFileIds.length > 0 && auFileIds.every(id => id === selectedFileId || compareFileIds?.includes(id));

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
                                                        const newSelected = Array.from(new Set([...currentSelected, ...auFileIds]));
                                                        onSelectFiles(newSelected);
                                                    } else {
                                                        const newSelected = currentSelected.filter(id => !auFileIds.includes(id));
                                                        onSelectFiles(newSelected.length ? newSelected : []);
                                                    }
                                                }}
                                                title="Load all files from this device into the workspace (main + compares)"
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
                                                        onDeleteFiles(e, auFileIds);
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
                <div className="workspace-files-container">
                    {(() => {
                        const renderFileItem = (file, keyPrefix = '') => (
                            <li
                                key={keyPrefix + file.id}
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
                                        {(estimateWorkspaceFileBytes(file) / 1024).toFixed(1)} KB
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
                                        <div style={{ color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <div style={{ width: 13, height: 13, border: '1.5px solid #38bdf8', background: 'rgba(56,189,248,0.2)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <div style={{ width: 7, height: 4, borderLeft: '1.5px solid white', borderBottom: '1.5px solid white', transform: 'rotate(-45deg) translate(1px, -1px)' }} />
                                            </div>
                                        </div>
                                    ) : compareFileIds?.includes(file.id) ? (
                                        <div style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <div style={{ width: 13, height: 13, border: '1.5px solid #fbbf24', background: 'rgba(251,191,36,0.2)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <div style={{ width: 7, height: 4, borderLeft: '1.5px solid white', borderBottom: '1.5px solid white', transform: 'rotate(-45deg) translate(1px, -1px)' }} />
                                            </div>
                                        </div>
                                    ) : (
                                        <div style={{ width: 13, height: 13, border: '1.5px solid #94a3b8', borderRadius: 3, opacity: 0.5 }} />
                                    )}
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => onDownloadFileCsv(e, file)}
                                    title="Download as CSV"
                                    disabled={csvExportBusy}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        cursor: csvExportBusy ? 'wait' : 'pointer',
                                        padding: 2,
                                        marginRight: 2,
                                        display: 'flex',
                                        alignItems: 'center',
                                        opacity: csvExportBusy ? 0.4 : 0.85,
                                        color: '#94a3b8',
                                    }}
                                >
                                    <Download size={14} />
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
                        );

                        const allDataFiles = filteredFiles.filter(f => !f.isFolder);

                        return (
                            <>
                                {customFolders.length > 0 && (
                                    <div className="section-title" style={{ marginTop: '4px', marginBottom: '8px', color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6rem', textTransform: 'uppercase', fontWeight: 600 }}>
                                        <Folder size={12} />
                                        Folders
                                    </div>
                                )}
                                {customFolders.map(folder => {
                                    const folderFiles = sortFolderFilesNewestFirst(
                                        filteredFiles.filter(f => f.folderId === folder.id)
                                    );
                                    const folderFileIds = folderFiles.map(f => f.id);
                                    const isAllSelected = folderFiles.length > 0 && folderFileIds.every(id => id === selectedFileId || compareFileIds?.includes(id));

                                    const isExpanded = expandedFolders.has(folder.id);

                                    return (
                                        <div key={folder.id} style={{ marginBottom: '12px', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', overflow: 'hidden' }}>
                                            <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: (folderFiles.length > 0 && isExpanded) ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                                                <div
                                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flex: 1 }}
                                                    onClick={() => {
                                                        const newExpanded = new Set(expandedFolders);
                                                        if (isExpanded) newExpanded.delete(folder.id);
                                                        else newExpanded.add(folder.id);
                                                        setExpandedFolders(newExpanded);
                                                    }}
                                                >
                                                    {isExpanded ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
                                                    <Folder size={14} color="#fbbf24" fill="rgba(251,191,36,0.2)" />
                                                    <span style={{ fontSize: '0.7rem', fontWeight: 600, userSelect: 'none' }}>{folder.name}</span>
                                                </div>
                                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                                    {folderFiles.length > 0 && (
                                                        <input type="checkbox" checked={isAllSelected} onChange={(e) => {
                                                            if (!onSelectFiles) return;
                                                            const currentSelected = [selectedFileId, ...(compareFileIds || [])].filter(Boolean);
                                                            if (e.target.checked) {
                                                                const newSelected = Array.from(new Set([...currentSelected, ...folderFileIds]));
                                                                onSelectFiles(newSelected);
                                                            } else {
                                                                const newSelected = currentSelected.filter(id => !folderFileIds.includes(id));
                                                                onSelectFiles(newSelected);
                                                            }
                                                        }} title="Select all files in folder for analysis" style={{ margin: 0, width: 14, height: 14, cursor: 'pointer', accentColor: '#38bdf8' }} />
                                                    )}
                                                    <button onClick={() => handleUploadClick(folder.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 1 }} title="Upload Files"><FileText size={14} color="#94a3b8" /></button>
                                                    <button onClick={() => handleFolderUploadClick(folder.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 1 }} title="Upload Folder Content"><UploadCloud size={14} color="#94a3b8" /></button>
                                                    {folderFiles.length > 0 && (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => onDownloadFolderZip(e, folder)}
                                                            disabled={csvExportBusy}
                                                            style={{ background: 'transparent', border: 'none', cursor: csvExportBusy ? 'wait' : 'pointer', padding: 1, opacity: csvExportBusy ? 0.45 : 1 }}
                                                            title="Download folder as CSV (ZIP)"
                                                        >
                                                            <Download size={14} color="#34d399" />
                                                        </button>
                                                    )}
                                                    <button onClick={(e) => onDeleteFolder(e, folder.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 1, color: '#ef4444' }} title="Delete Folder"><Trash2 size={14} /></button>
                                                </div>
                                            </div>
                                            {(folderFiles.length > 0 && isExpanded) && (
                                                <ul className="file-list" style={{ paddingLeft: '8px', background: 'rgba(0,0,0,0.1)', paddingBottom: '4px' }}>
                                                    {folderFiles.map(file => renderFileItem(file))}
                                                </ul>
                                            )}
                                        </div>
                                    );
                                })}
                                {true && (() => {
                                    const isRootExpanded = expandedFolders.has('root-data-files');
                                    const rootFileIds = allDataFiles.map(f => f.id);
                                    const isAllRootSelected = allDataFiles.length > 0 && rootFileIds.every(id => id === selectedFileId || compareFileIds?.includes(id));

                                    return (
                                        <div style={{ marginBottom: '12px', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', overflow: 'hidden' }}>
                                            <div style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: (allDataFiles.length > 0 && isRootExpanded) ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                                                <div
                                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', flex: 1 }}
                                                    onClick={() => {
                                                        const newExpanded = new Set(expandedFolders);
                                                        if (isRootExpanded) newExpanded.delete('root-data-files');
                                                        else newExpanded.add('root-data-files');
                                                        setExpandedFolders(newExpanded);
                                                    }}
                                                >
                                                    {isRootExpanded ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
                                                    <Folder size={14} color="#38bdf8" fill="rgba(56,189,248,0.2)" />
                                                    <span style={{ fontSize: '0.7rem', fontWeight: 600, userSelect: 'none' }}>DataFiles</span>
                                                </div>
                                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                                    {allDataFiles.length > 0 && (
                                                        <input type="checkbox" checked={isAllRootSelected} onChange={(e) => {
                                                            if (!onSelectFiles) return;
                                                            const currentSelected = [selectedFileId, ...(compareFileIds || [])].filter(Boolean);
                                                            if (e.target.checked) {
                                                                const newSelected = Array.from(new Set([...currentSelected, ...rootFileIds]));
                                                                onSelectFiles(newSelected);
                                                            } else {
                                                                const newSelected = currentSelected.filter(id => !rootFileIds.includes(id));
                                                                onSelectFiles(newSelected);
                                                            }
                                                        }} title="Select all DataFiles for analysis" style={{ margin: 0, width: 14, height: 14, cursor: 'pointer', accentColor: '#38bdf8' }} />
                                                    )}
                                                    {allDataFiles.length > 0 && (
                                                        <button
                                                            type="button"
                                                            onClick={onDownloadRootZip}
                                                            disabled={csvExportBusy}
                                                            style={{ background: 'transparent', border: 'none', cursor: csvExportBusy ? 'wait' : 'pointer', padding: 1, opacity: csvExportBusy ? 0.45 : 1 }}
                                                            title="Download all DataFiles as CSV (ZIP)"
                                                        >
                                                            <Download size={14} color="#34d399" />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                            {(isRootExpanded) && (
                                                <ul className="file-list" style={{ paddingLeft: '8px', background: 'rgba(0,0,0,0.1)', paddingBottom: '4px' }}>
                                                    {allDataFiles.length === 0 ? <li style={{ padding: '8px', fontSize: '0.75rem', color: '#94a3b8' }}>No files uploaded</li> : allDataFiles.map(file => renderFileItem(file, 'df-'))}
                                                </ul>
                                            )}
                                        </div>
                                    );
                                })()}
                            </>
                        );
                    })()}
                </div>
            </div>
            </>
            )}
        </aside>
    );
};

export default Sidebar;
