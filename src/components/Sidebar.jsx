import React, { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    Folder, FileText, UploadCloud, ChevronRight, ChevronDown, BarChart2, Search, Trash2, Pencil,
    Activity, CheckSquare, Square, LineChart, FileSpreadsheet, Table2, Eye, FilePlus,
    Network, Calculator as CalcIcon, FlaskConical, Brain, Layers, DownloadCloud, MonitorUp, FolderPlus, Blend,
    PanelLeftClose, PanelLeftOpen, Target, BookOpen, Usb, Download, Atom, Terminal, Code2,
    Sparkles, Moon, Sun, Home as HomeIcon
} from 'lucide-react';
import './Sidebar.css';
import { readStoredTheme, cycleTheme } from '../utils/theme.js';
import { exportWorkspaceSession, importWorkspaceSession } from '../utils/fileSaver';
import {
    estimateWorkspaceFileBytes,
    formatWorkspaceDataSize,
    sumWorkspaceDataBytes,
    isSpreadsheetEditableWorkspaceFile,
} from '../utils/workspaceFilename';
import {
    downloadWorkspaceFileAsCsv,
    downloadFolderContentsAsCsvZip,
    downloadRootDataFilesAsCsvZip,
} from '../utils/workspaceCsvDownload';

const logo = `${import.meta.env.BASE_URL}logo_noze_circle.png`;

function fileBelongsToFolder(file, folderId) {
    if (!file || file.isFolder || folderId == null) return false;
    return String(file.folderId) === String(folderId);
}

const Sidebar = ({ files, onFileSelect, selectedFileId, compareFileIds = [], onUpload, onDeleteFile, onDeleteFiles, onDeleteAllFiles, onSelectAll, onSelectFiles, onOpenRecoveryForFileIds, userName = "User", activePage = 'dashboard', onPageChange, onCreateFolder, onDeleteFolder, onRenameFolder, onOpenWorkspaceSpreadsheet, onNewBlankSpreadsheet, onOpenSpreadsheetNav, onOpenWorkspaceFileViewer, onOpenFileViewerNav }) => {
    const fileInputRef = useRef(null);
    const folderInputRef = useRef(null);
    const nozeInputRef = useRef(null);
    const sidebarScrollRef = useRef(null);
    const workspaceAnchorRef = useRef(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [sidebarWidth, setSidebarWidth] = useState(392);
    const [expandedFolders, setExpandedFolders] = useState(() => new Set(['root-data-files']));
    const [activeUploadFolderId, setActiveUploadFolderId] = useState(null);
    const [workspaceSectionOpen, setWorkspaceSectionOpen] = useState(
        () => localStorage.getItem('sidebarWorkspaceOpen') !== '0'
    );

    // NEW: Global Sidebar minimization toggle
    const [isCollapsed, setIsCollapsed] = useState(() => localStorage.getItem('zenMode') === 'true');

    // Theme cycle (Noze → Dark → Light). Read stored value once; `cycleTheme` persists and updates DOM.
    const [theme, setTheme] = useState(() => readStoredTheme());
    useEffect(() => {
        const onThemeChange = (e) => {
            const next = e?.detail?.theme;
            if (next) setTheme(next);
        };
        window.addEventListener('noze-theme-change', onThemeChange);
        return () => window.removeEventListener('noze-theme-change', onThemeChange);
    }, []);
    const handleThemeCycle = useCallback(() => {
        const next = cycleTheme(theme);
        setTheme(next);
    }, [theme]);
    const themeLabel = theme === 'noze' ? 'Noze' : theme === 'dark' ? 'Dark' : 'Light';
    const ThemeIcon = theme === 'noze' ? Sparkles : theme === 'dark' ? Moon : Sun;

    const toggleWorkspaceSection = () => {
        setWorkspaceSectionOpen((v) => {
            const next = !v;
            localStorage.setItem('sidebarWorkspaceOpen', next ? '1' : '0');
            return next;
        });
    };

    /**
     * Shared props (className + inline style) for every button in the sidebar
     * page/tools nav. Returns BOTH because:
     *   - Inline style carries the active-state tint, font, geometry — one
     *     source of truth instead of 15 hand-rolled style objects.
     *   - The className lets `Sidebar.css` apply a :hover rule, which
     *     inline style alone can't express. The `is-active` modifier
     *     prevents the hover background from overriding the active tint.
     */
    const toolBtnProps = (active, activeBg, activeColor) => ({
        className: `sidebar-nav-btn${active ? ' is-active' : ''}`,
        style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            padding: '7px 6px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.74rem',
            fontWeight: 600,
            lineHeight: 1.15,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            background: active ? activeBg : 'transparent',
            color: active ? activeColor : 'var(--text-muted)',
            transition: 'background 0.15s ease, color 0.15s ease, transform 0.1s ease',
        },
    });

    const actualFiles = files.filter(f => !f.isFolder);
    const customFolders = files.filter(f => f.isFolder);

    const workspaceTotalDataBytes = useMemo(() => sumWorkspaceDataBytes(files), [files]);

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

    const [csvExportBusy, setCsvExportBusy] = useState(false);
    const [auDevicesExpanded, setAuDevicesExpanded] = useState(false);
    /** Which sticky jump control matches scroll position: page nav (top) vs workspace block */
    const [sidebarJumpActive, setSidebarJumpActive] = useState('menu');

    const updateSidebarJumpHighlight = useCallback(() => {
        const scrollEl = sidebarScrollRef.current;
        const anchor = workspaceAnchorRef.current;
        if (!scrollEl || !anchor) return;
        const scrollRect = scrollEl.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const threshold = scrollRect.top + 6;
        setSidebarJumpActive(anchorRect.top <= threshold ? 'workspace' : 'menu');
    }, []);

    useEffect(() => {
        if (isCollapsed) return;
        const el = sidebarScrollRef.current;
        if (!el) return;
        updateSidebarJumpHighlight();
        el.addEventListener('scroll', updateSidebarJumpHighlight, { passive: true });
        const ro =
            typeof ResizeObserver !== 'undefined'
                ? new ResizeObserver(() => updateSidebarJumpHighlight())
                : null;
        ro?.observe(el);
        const anchor = workspaceAnchorRef.current;
        if (anchor) ro?.observe(anchor);
        return () => {
            el.removeEventListener('scroll', updateSidebarJumpHighlight);
            ro?.disconnect();
        };
    }, [isCollapsed, workspaceSectionOpen, updateSidebarJumpHighlight]);

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

    /* Group files by AU tag (the first `_`-delimited token containing `asu`
       or `asau`). Files without a recognized tag are skipped so they don't
       show up as an anonymous "Unknown AU" entry inflating the device count. */
    const activeAUs = React.useMemo(() => {
        const groups = {};
        for (const f of files) {
            if (f.isFolder) continue;
            const baseName = f.name.split('/').pop().split('\\').pop();
            const fileParts = baseName.split('_');
            const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));
            if (!asauPart) continue;
            const auId = asauPart.toUpperCase();
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
            minWidth: isCollapsed ? 60 : sidebarWidth,
            flexShrink: 0,
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
                        right: -5,
                        width: '10px',
                        height: '100%',
                        cursor: 'col-resize',
                        zIndex: 100,
                        transition: 'background 0.2s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(56, 189, 248, 0.4)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                />
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
                    <div className="user-profile" style={{ padding: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button
                            type="button"
                            className="sidebar-theme-toggle"
                            onClick={handleThemeCycle}
                            title={`Theme: ${themeLabel} — click to cycle Noze → Dark → Light`}
                            aria-label={`Theme: ${themeLabel}. Click to change.`}
                        >
                            <ThemeIcon size={14} aria-hidden />
                            <span className="sidebar-theme-toggle-label">{themeLabel}</span>
                        </button>
                        <div className="avatar" style={{ width: 30, height: 30, fontSize: '0.85rem', cursor: 'pointer' }} title={`${userName} - Data Analyst`}>
                            {userName.charAt(0).toUpperCase()}
                        </div>
                    </div>
                )}
            </div>

            {/* Zen mode: icon rail so Drift Map / ML / t-SNE stay reachable when the full nav is hidden */}
            {isCollapsed && (
                <div className="sidebar-zen-page-rail">
                    {[
                        { page: 'dashboard', title: 'Dashboard', Icon: BarChart2 },
                        { page: 'csvPlotter', title: 'SE Analysis — plot CSV columns', Icon: FileSpreadsheet },
                        { page: 'codeStudio', title: 'Code Studio — Python & text in Codes folder', Icon: Code2 },
                        { page: 'gasMath', title: 'Gas dilution math', Icon: FlaskConical },
                        { page: 'aromaAnalysis', title: 'Aroma analysis', Icon: LineChart },
                        { page: 'recoveryAnalysis', title: 'Drift Map — baseline drift & recovery', Icon: Activity },
                        { page: 'mlStudio', title: 'FeNOse ML Studio', Icon: Brain },
                        { page: 'tsnePage', title: 't-SNE explorer', Icon: Atom },
                        { page: 'help', title: 'Help', Icon: BookOpen },
                    ].map(({ page, title, Icon }) => (
                        <button
                            key={page}
                            type="button"
                            onClick={() => onPageChange?.(page)}
                            title={title}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: 40,
                                height: 34,
                                padding: 0,
                                border: 'none',
                                borderRadius: 8,
                                cursor: 'pointer',
                                background:
                                    activePage === page
                                        ? page === 'codeStudio'
                                            ? 'rgba(0, 222, 147, 0.16)'
                                            : 'rgba(56, 189, 248, 0.18)'
                                        : 'transparent',
                                color: activePage === page ? 'var(--accent-primary)' : 'var(--text-muted)',
                            }}
                        >
                            <Icon size={15} strokeWidth={activePage === page ? 2.25 : 2} />
                        </button>
                    ))}
                </div>
            )}

            {/* HOME — sits OUTSIDE the scrolling container so it stays
                pinned at the top when the user jumps to the workspace
                section further down. Was previously the first child of
                .sidebar-body-scroll, which meant a click on "Workspace"
                scrolled it off-screen. */}
            {!isCollapsed && (
                <div
                    className="sidebar-home-row"
                    style={{
                        padding: '8px 12px 4px',
                        flexShrink: 0,
                    }}
                >
                    {(() => {
                        const p = toolBtnProps(
                            activePage === 'home',
                            'rgba(5, 192, 125, 0.16)',
                            'var(--accent-primary)'
                        );
                        return (
                            <button
                                onClick={() => onPageChange?.('home')}
                                className={`${p.className} sidebar-nav-btn-home`}
                                style={{
                                    ...p.style,
                                    width: '100%',
                                    padding: '9px 10px',
                                    fontSize: '0.82rem',
                                    gap: 7,
                                    letterSpacing: 0.2,
                                }}
                                title="Home — workspace launcher"
                            >
                                <HomeIcon size={14} /> Home
                            </button>
                        );
                    })()}
                </div>
            )}

            {!isCollapsed && (
            <div ref={sidebarScrollRef} className="sidebar-body-scroll">
                <div className="sidebar-scroll-jump" role="toolbar" aria-label="Scroll within sidebar">
                    <button
                        type="button"
                        className={`sidebar-scroll-jump-btn${sidebarJumpActive === 'workspace' ? ' is-active' : ''}`}
                        onClick={() => {
                            setSidebarJumpActive('workspace');
                            workspaceAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                        title="Scroll to workspace (uploads and files)"
                        aria-pressed={sidebarJumpActive === 'workspace'}
                    >
                        <Folder size={14} aria-hidden /> Workspace
                    </button>
                    <button
                        type="button"
                        className={`sidebar-scroll-jump-btn${sidebarJumpActive === 'menu' ? ' is-active' : ''}`}
                        onClick={() => {
                            setSidebarJumpActive('menu');
                            sidebarScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        title="Scroll to menu and tools"
                        aria-pressed={sidebarJumpActive === 'menu'}
                    >
                        <BarChart2 size={14} aria-hidden /> Menu
                    </button>
                </div>

            {/* Tool nav: everything else in a 2-column grid. Dashboard and
                Help live here too so the visual rhythm stays uniform. */}
            <div
                className="sidebar-tools-nav"
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: 4,
                    padding: '4px 12px 8px',
                    borderBottom: '1px solid var(--border-color)',
                    flexShrink: 0,
                }}
            >
                <button
                    onClick={() => onPageChange?.('dashboard')}
                    {...toolBtnProps(activePage === 'dashboard', 'rgba(56,189,248,0.15)', 'var(--accent-primary)')}
                    title="Dashboard — chart the selected file"
                >
                    <BarChart2 size={13} /> Dashboard
                </button>
                <button
                    onClick={() => onPageChange?.('help')}
                    {...toolBtnProps(activePage === 'help', 'rgba(129,140,248,0.2)', '#a5b4fc')}
                    title="User guide — instructions for every section"
                >
                    <BookOpen size={13} /> Help
                </button>
                <button
                    onClick={() => onPageChange?.('csvPlotter')}
                    {...toolBtnProps(activePage === 'csvPlotter', 'rgba(168,85,247,0.15)', '#a855f7')}
                    title="SE Analysis from Custom CSV Data"
                >
                    <FileSpreadsheet size={13} /> SE Analysis
                </button>
                <button
                    onClick={() => onPageChange?.('codeStudio')}
                    {...toolBtnProps(activePage === 'codeStudio', 'rgba(0, 222, 147, 0.14)', 'var(--accent-primary)')}
                    title="Code Studio — Monaco editor; files saved in Codes folder"
                >
                    <Code2 size={13} /> Code Studio
                </button>
                <button
                    onClick={() => onPageChange?.('normalize')}
                    {...toolBtnProps(activePage === 'normalize', 'rgba(251,191,36,0.15)', '#fbbf24')}
                    title="Baseline Normalization"
                >
                    <Activity size={13} /> Normalize
                </button>
                <button
                    onClick={() => onPageChange?.('aromaAnalysis')}
                    {...toolBtnProps(activePage === 'aromaAnalysis', 'rgba(16,185,129,0.15)', '#10b981')}
                    title="Aroma Sensor Data Analysis"
                >
                    <LineChart size={13} /> Aroma
                </button>
                <button
                    onClick={() => onPageChange?.('separability')}
                    {...toolBtnProps(activePage === 'separability', 'rgba(251,191,36,0.15)', '#fbbf24')}
                    title="Time-Resolved Separability Analysis"
                >
                    <Activity size={13} /> Separability
                </button>
                <button
                    onClick={() => onPageChange?.('sensitivity')}
                    {...toolBtnProps(activePage === 'sensitivity', 'rgba(59,130,246,0.15)', '#3b82f6')}
                    title="Element Sensitivity & Performance Map"
                >
                    <Target size={13} /> Sensitivity
                </button>
                <button
                    onClick={() => onPageChange?.('recoveryAnalysis')}
                    {...toolBtnProps(activePage === 'recoveryAnalysis', 'rgba(245,158,11,0.15)', '#f59e0b')}
                    title="Chronological Baseline Recovery & Drift Tracker"
                >
                    <Activity size={13} /> Drift Map
                </button>
                <button
                    onClick={() => onPageChange?.('manufacturing')}
                    {...toolBtnProps(activePage === 'manufacturing', 'rgba(244,63,94,0.15)', '#f43f5e')}
                    title="Manufacturing Variation and Yield Analysis"
                >
                    <Layers size={13} /> Mfg. Variation
                </button>
                <button
                    type="button"
                    onClick={() => onOpenSpreadsheetNav?.()}
                    {...toolBtnProps(activePage === 'spreadsheet', 'rgba(52,211,153,0.15)', '#34d399')}
                    title="Edit the selected CSV in a grid; Save writes back to the workspace"
                >
                    <Table2 size={13} /> Spreadsheet
                </button>
                {(() => {
                    /* "New sheet" is an action, not a page — it has no active state,
                       but still benefits from the shared geometry + hover polish. */
                    const p = toolBtnProps(false, '', '');
                    return (
                        <button
                            type="button"
                            onClick={() => onNewBlankSpreadsheet?.()}
                            className={p.className}
                            style={{
                                ...p.style,
                                background: 'rgba(52,211,153,0.08)',
                                color: '#6ee7b7',
                            }}
                            title="Create a blank CSV in the spreadsheets folder and open the editor"
                        >
                            <FilePlus size={13} /> New sheet
                        </button>
                    );
                })()}
                <button
                    type="button"
                    onClick={() => onOpenFileViewerNav?.()}
                    {...toolBtnProps(activePage === 'fileViewer', 'rgba(147,197,253,0.15)', '#93c5fd')}
                    title="Preview code, JSON, notes, PDF, Word, images — with syntax colors for code"
                >
                    <Eye size={13} /> Viewer
                </button>
                <button
                    onClick={() => onPageChange?.('aromaUnitCapture')}
                    {...toolBtnProps(activePage === 'aromaUnitCapture', 'rgba(45,212,191,0.15)', '#2dd4bf')}
                    title="Capture SiAC / aroma unit over USB serial (Chrome)"
                >
                    <Usb size={13} /> AU capture
                </button>
                <button
                    onClick={() => onPageChange?.('gasMath')}
                    {...toolBtnProps(activePage === 'gasMath', 'rgba(56,189,248,0.15)', '#38bdf8')}
                    title="Gas-Dilution Math Tool"
                >
                    <FlaskConical size={13} /> Dilution
                </button>
                <button
                    onClick={() => onPageChange?.('serialMonitor')}
                    {...toolBtnProps(activePage === 'serialMonitor', 'rgba(56,189,248,0.15)', '#38bdf8')}
                    title="Read any USB serial device line-by-line (Web Serial)"
                >
                    <Terminal size={13} /> Serial
                </button>
            </div>

            <div className="sidebar-tools-grid" style={{ padding: '0 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: 16, marginTop: 12 }}>
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
                    }}
                    title="Polymer–carbon black: wt% ↔ volume %"
                >
                    <Blend size={14} /> Polymer–CB
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
                    }}
                    title="FeNOse ML Studio (inference & training)"
                >
                    <Brain size={18} />
                </button>
                <button
                    onClick={() => onPageChange?.('tsnePage')}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        padding: '6px 0',
                        borderRadius: 8,
                        border: activePage === 'tsnePage' ? '1px solid rgba(0,222,147,0.35)' : '1px solid rgba(255,255,255,0.05)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background: activePage === 'tsnePage' ? 'rgba(0,222,147,0.12)' : 'rgba(255,255,255,0.02)',
                        color: activePage === 'tsnePage' ? '#00DE93' : 'var(--text-muted)',
                        boxShadow: activePage === 'tsnePage' ? '0 0 10px rgba(0,222,147,0.15)' : 'none',
                        transition: 'all 0.15s',
                    }}
                    title="t-SNE Concentration Explorer"
                >
                    <Atom size={16} />
                </button>
            </div>

                <section ref={workspaceAnchorRef} className="sidebar-workspace-section">
                    <button
                        type="button"
                        className="sidebar-workspace-section-toggle"
                        onClick={toggleWorkspaceSection}
                        aria-expanded={workspaceSectionOpen}
                        title={workspaceSectionOpen ? 'Collapse workspace' : 'Expand workspace'}
                    >
                        {workspaceSectionOpen ? (
                            <ChevronDown size={16} color="#38bdf8" aria-hidden />
                        ) : (
                            <ChevronRight size={16} color="#38bdf8" aria-hidden />
                        )}
                        <span className="sidebar-workspace-section-toggle-label">Workspace</span>
                        <span className="sidebar-workspace-section-toggle-meta">
                            {formatWorkspaceDataSize(workspaceTotalDataBytes)}
                        </span>
                    </button>
                    {workspaceSectionOpen ? (
                        <>
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
                    <div className="workspace-header-title-block">
                        <h3 className="workspace-header-heading">Files</h3>
                    </div>
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
                        <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={auDevicesExpanded}
                            onClick={() => setAuDevicesExpanded((v) => !v)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setAuDevicesExpanded((v) => !v);
                                }
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                cursor: 'pointer',
                                marginBottom: auDevicesExpanded ? '8px' : 0,
                                userSelect: 'none',
                            }}
                            title={auDevicesExpanded ? 'Collapse AU list' : 'Expand AU list (click an AU name to open Drift Map)'}
                        >
                            {auDevicesExpanded ? (
                                <ChevronDown size={14} color="#38bdf8" aria-hidden />
                            ) : (
                                <ChevronRight size={14} color="#38bdf8" aria-hidden />
                            )}
                            <span
                                style={{
                                    fontSize: '0.65rem',
                                    color: '#38bdf8',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                    fontWeight: 600,
                                    flex: 1,
                                }}
                            >
                                Available AU Devices
                            </span>
                            <span style={{ fontSize: '0.6rem', color: '#94a3b8', fontWeight: 500 }}>
                                ({Object.keys(activeAUs).length})
                            </span>
                        </div>
                        {auDevicesExpanded ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {Object.keys(activeAUs).map((auId, auIdx) => {
                                const auFiles = activeAUs[auId];
                                const auFileIds = auFiles.map(f => f.id);
                                const isAllSelected = auFileIds.length > 0 && auFileIds.every(id => id === selectedFileId || compareFileIds?.includes(id));
                                const chkId = `au-device-chk-${auIdx}`;

                                return (
                                    <div key={auId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                                            <input
                                                type="checkbox"
                                                id={chkId}
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
                                                title="Select all files from this device for charts / compare"
                                                style={{ width: 14, height: 14, accentColor: '#38bdf8', cursor: 'pointer', flexShrink: 0 }}
                                            />
                                            <label htmlFor={chkId} style={{ fontSize: '0.65rem', color: '#94a3b8', cursor: 'pointer', margin: 0, flexShrink: 0, userSelect: 'none' }}>
                                                All
                                            </label>
                                            <button
                                                type="button"
                                                onClick={() => auFileIds.length && onOpenRecoveryForFileIds?.(auFileIds)}
                                                disabled={!auFileIds.length}
                                                title="Open Baseline Drift & Recovery (Drift Map) for this AU — captures in chronological order"
                                                style={{
                                                    flex: 1,
                                                    minWidth: 0,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    background: 'transparent',
                                                    border: 'none',
                                                    padding: '2px 2px',
                                                    cursor: auFileIds.length ? 'pointer' : 'not-allowed',
                                                    fontSize: '0.75rem',
                                                    color: '#f8fafc',
                                                    fontWeight: 600,
                                                    textAlign: 'left',
                                                }}
                                            >
                                                {auId}
                                            </button>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: '0.65rem', color: '#94a3b8' }} title="Number of workspace files for this AU">
                                                ({auFiles.length})
                                            </span>
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
                        ) : null}
                    </div>
                )}
                <div className="workspace-files-container">
                    {(() => {
                        const renderFileItem = (file, keyPrefix = '') => (
                            <li
                                key={keyPrefix + file.id}
                                className={`file-item ${selectedFileId === file.id ? 'active' : ''} ${compareFileIds?.includes(file.id) ? 'compare-active' : ''}`}
                                onClick={(e) => onFileSelect(file.id, e.ctrlKey || e.metaKey)}
                                title={file.name}
                            >
                                <div className="file-icon">
                                    <FileText size={16} />
                                </div>
                                <div className="file-details">
                                    <span className="file-name">{file.name}</span>
                                    <span className="file-meta" title="Approximate size of stored data">
                                        {formatWorkspaceDataSize(estimateWorkspaceFileBytes(file))}
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
                                {onOpenWorkspaceFileViewer ? (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onOpenWorkspaceFileViewer(file.id);
                                        }}
                                        title="Open in file viewer (code, JSON, PDF, images, …)"
                                        style={{
                                            background: 'transparent',
                                            border: 'none',
                                            cursor: 'pointer',
                                            padding: 2,
                                            marginRight: 2,
                                            display: 'flex',
                                            alignItems: 'center',
                                            opacity: 0.85,
                                            color: '#93c5fd',
                                        }}
                                    >
                                        <Eye size={14} />
                                    </button>
                                ) : null}
                                {isSpreadsheetEditableWorkspaceFile(file.name) && onOpenWorkspaceSpreadsheet ? (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onOpenWorkspaceSpreadsheet(file.id);
                                        }}
                                        title="Open in spreadsheet editor"
                                        style={{
                                            background: 'transparent',
                                            border: 'none',
                                            cursor: 'pointer',
                                            padding: 2,
                                            marginRight: 2,
                                            display: 'flex',
                                            alignItems: 'center',
                                            opacity: 0.85,
                                            color: '#34d399',
                                        }}
                                    >
                                        <FileSpreadsheet size={14} />
                                    </button>
                                ) : null}
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
                                        filteredFiles.filter((f) => fileBelongsToFolder(f, folder.id))
                                    );
                                    const folderDataBytes = sumWorkspaceDataBytes(folderFiles);
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
                                                    <span style={{ fontSize: '0.7rem', fontWeight: 600, userSelect: 'none' }}>
                                                        {folder.name}
                                                        {folderFiles.length > 0 ? (
                                                            <span
                                                                style={{
                                                                    fontWeight: 500,
                                                                    color: '#94a3b8',
                                                                    marginLeft: 6,
                                                                }}
                                                                title="Approximate total data in this folder"
                                                            >
                                                                · {formatWorkspaceDataSize(folderDataBytes)}
                                                            </span>
                                                        ) : null}
                                                    </span>
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
                                                    {folderFiles.length > 0 && onOpenRecoveryForFileIds ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                void onOpenRecoveryForFileIds(folderFileIds);
                                                            }}
                                                            title="Open Drift Map for all files in this folder (chronological order)"
                                                            style={{
                                                                background: 'rgba(245, 158, 11, 0.12)',
                                                                border: '1px solid rgba(245, 158, 11, 0.25)',
                                                                borderRadius: 6,
                                                                cursor: 'pointer',
                                                                padding: '3px 5px',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                            }}
                                                        >
                                                            <Activity size={14} color="#f59e0b" />
                                                        </button>
                                                    ) : null}
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
                                                    {onRenameFolder ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => onRenameFolder(e, folder.id)}
                                                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 1, color: '#94a3b8' }}
                                                            title="Rename folder"
                                                        >
                                                            <Pencil size={14} />
                                                        </button>
                                                    ) : null}
                                                    <button onClick={(e) => onDeleteFolder(e, folder.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 1, color: '#ef4444' }} title="Delete Folder"><Trash2 size={14} /></button>
                                                </div>
                                            </div>
                                            {(folderFiles.length > 0 && isExpanded) && (
                                                <ul className="file-list file-list--folder-scroll" style={{ paddingLeft: '8px', background: 'rgba(0,0,0,0.1)', paddingBottom: '4px' }}>
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
                                    const rootDataBytes = sumWorkspaceDataBytes(allDataFiles);

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
                                                    <span style={{ fontSize: '0.7rem', fontWeight: 600, userSelect: 'none' }}>
                                                        DataFiles
                                                        {allDataFiles.length > 0 ? (
                                                            <span
                                                                style={{ fontWeight: 500, color: '#94a3b8', marginLeft: 6 }}
                                                                title="Approximate total data in root workspace files"
                                                            >
                                                                · {formatWorkspaceDataSize(rootDataBytes)}
                                                            </span>
                                                        ) : null}
                                                    </span>
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
                                                    {allDataFiles.length > 0 && onOpenRecoveryForFileIds ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                void onOpenRecoveryForFileIds(rootFileIds);
                                                            }}
                                                            title="Open Drift Map for all DataFiles (chronological order)"
                                                            style={{
                                                                background: 'rgba(245, 158, 11, 0.12)',
                                                                border: '1px solid rgba(245, 158, 11, 0.25)',
                                                                borderRadius: 6,
                                                                cursor: 'pointer',
                                                                padding: '3px 5px',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                            }}
                                                        >
                                                            <Activity size={14} color="#f59e0b" />
                                                        </button>
                                                    ) : null}
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
                                                <ul className="file-list file-list--folder-scroll" style={{ paddingLeft: '8px', background: 'rgba(0,0,0,0.1)', paddingBottom: '4px' }}>
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
                    ) : null}
                </section>
            </div>
            )}
        </aside>
    );
};

export default Sidebar;
