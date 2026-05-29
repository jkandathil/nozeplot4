import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
    Usb,
    FileText,
    Table2,
    Code2,
    Brain,
    Terminal,
    UploadCloud,
    BookOpen,
    ArrowRight,
    FolderOpen,
    Activity,
    ShieldCheck,
    Sparkles,
    Moon,
    Sun,
    CircuitBoard,
} from 'lucide-react';
import {
    fileBasename,
    formatWorkspaceDataSize,
    sumWorkspaceDataBytes,
} from '../utils/workspaceFilename.js';
import { readStoredTheme, cycleTheme } from '../utils/theme.js';
import { normalizeEventValue, isRecoveryOffEvent } from '../utils/recoveryEventFilter.js';
import './HomePage.css';

const APP_VERSION = '0.1.2';

const LAUNCHERS = [
    {
        id: 'aromaUnitCapture',
        icon: Usb,
        tint: '#38bdf8',
        title: 'AU Capture',
        desc: 'Link a USB aroma unit and record raw sensor streams.',
    },
    {
        id: 'fileViewer',
        icon: FileText,
        tint: '#f472b6',
        title: 'File Viewer',
        desc: 'Browse, plot, and annotate any workspace CSV/TXT.',
    },
    {
        id: 'spreadsheet',
        icon: Table2,
        tint: '#fbbf24',
        title: 'Spreadsheet',
        desc: 'HyperFormula-backed sheets with inline charts.',
    },
    {
        id: 'codeStudio',
        icon: Code2,
        tint: '#a78bfa',
        title: 'Code Studio',
        desc: 'Run Python (Pyodide) over your data, no server.',
    },
    {
        id: 'mlStudio',
        icon: Brain,
        tint: '#34d399',
        title: 'ML Studio',
        desc: 'Train, compare and export models in-browser.',
    },
    {
        id: 'serialMonitor',
        icon: Terminal,
        tint: '#22d3ee',
        title: 'Serial Monitor',
        desc: 'Raw UART — read, send, and save logs.',
    },
    {
        id: 'arduinoFlasher',
        icon: CircuitBoard,
        tint: '#fb923c',
        title: 'MCU Flash',
        desc: 'Arduino & ESP32 — AI sketches, flash over USB.',
    },
];

/**
 * Pull a useful 1-D numeric series from a parsed file so the sparkline
 * shows something meaningful. Falls back gracefully to whatever first
 * numeric column we can find.
 *
 * If the file has an event/phase column and any row is tagged as a
 * RecoveryOff-style phase, those rows are dropped before sampling —
 * post-measurement hardware recovery isn't part of the real signal
 * and makes the sparkline look like a cliff at the end.
 */
function extractSparkSeries(parsed) {
    if (!parsed || !Array.isArray(parsed.data) || parsed.data.length < 2) return null;
    const rows = parsed.data;
    const fields = parsed.meta?.fields || Object.keys(rows[0] || {});
    const skip = new Set(['time', 'timestamp', 't', 'index', 'sample', 'id', 'row']);
    const numericField = fields.find((f) => {
        if (!f || skip.has(String(f).toLowerCase())) return false;
        const v = Number(rows[Math.min(5, rows.length - 1)]?.[f]);
        return Number.isFinite(v);
    });
    if (!numericField) return null;

    /* Find an event/phase-style column (case-insensitive) so we can strip
       out recoveryOff rows. Only the exact well-known column names —
       no fuzzy matching — so we don't accidentally treat a data column
       that happens to contain the word "event" as a phase label. */
    const eventCol = fields.find((f) => {
        const n = String(f || '').toLowerCase();
        return n === 'event_name' || n === 'event' || n === 'phase';
    });

    const cleanRows = eventCol
        ? rows.filter((r) => !isRecoveryOffEvent(normalizeEventValue(r, eventCol)))
        : rows;

    const values = cleanRows
        .map((r) => Number(r?.[numericField]))
        .filter((v) => Number.isFinite(v));
    if (values.length < 2) return null;
    const N = Math.min(values.length, 180);
    const step = values.length > N ? values.length / N : 1;
    const sampled = [];
    for (let i = 0; i < N; i++) {
        const idx = Math.floor(i * step);
        sampled.push(values[idx]);
    }
    return { field: numericField, values: sampled };
}

function Sparkline({ series }) {
    if (!series) return null;
    const { values } = series;
    const W = 620;
    const H = 140;
    const pad = 6;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const step = (W - pad * 2) / (values.length - 1 || 1);
    const points = values
        .map((v, i) => {
            const x = pad + i * step;
            const y = H - pad - ((v - min) / range) * (H - pad * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    const areaPoints = `${pad},${H - pad} ${points} ${W - pad},${H - pad}`;
    return (
        <svg
            className="home-sparkline"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden
        >
            <defs>
                <linearGradient id="home-spark-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0" />
                </linearGradient>
            </defs>
            <polygon points={areaPoints} fill="url(#home-spark-fill)" />
            <polyline
                points={points}
                fill="none"
                stroke="var(--accent-primary)"
                strokeWidth="1.6"
                strokeLinejoin="round"
                strokeLinecap="round"
            />
        </svg>
    );
}

function formatRelativeTime(dateLike) {
    if (!dateLike) return '—';
    const d = typeof dateLike === 'number' ? new Date(dateLike) : new Date(dateLike);
    if (!Number.isFinite(d.getTime())) return '—';
    const diff = Date.now() - d.getTime();
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} h ago`;
    const days = Math.floor(diff / (24 * 3600 * 1000));
    if (days < 7) return `${days} d ago`;
    return d.toLocaleDateString();
}

const THEME_META = {
    noze: { label: 'Noze', Icon: Sparkles },
    dark: { label: 'Dark', Icon: Moon },
    light: { label: 'Light', Icon: Sun },
};

/**
 * NozePlot home / landing page.
 *
 * Design brief: "mission console" — the front door for a scientific tool.
 * Optimised for the two jobs a returning user has: (1) pick up where they
 * left off, (2) jump into the right tool. New users get a single, obvious
 * primary action (upload) and a path to the guide, without being buried
 * in docs.
 */
const HomePage = ({
    files = [],
    selectedFileId = null,
    parsedData = null,
    onPageChange,
    onBrowse,
    onFileSelect,
    userName = 'User',
}) => {
    const dataFiles = useMemo(() => files.filter((f) => !f.isFolder), [files]);
    const totalBytes = useMemo(() => sumWorkspaceDataBytes(dataFiles), [dataFiles]);

    const recentFiles = useMemo(() => {
        const copy = [...dataFiles];
        copy.sort((a, b) => {
            const at = Number(a?.uploadedAt || a?.createdAt || 0);
            const bt = Number(b?.uploadedAt || b?.createdAt || 0);
            return bt - at;
        });
        return copy.slice(0, 5);
    }, [dataFiles]);

    const selectedFile = useMemo(
        () => dataFiles.find((f) => f.id === selectedFileId) || recentFiles[0] || null,
        [dataFiles, selectedFileId, recentFiles]
    );

    const sparkSeries = useMemo(() => extractSparkSeries(parsedData), [parsedData]);

    /* AU device count — mirror the Sidebar's `activeAUs` logic so this number
       matches the "Available AU Devices (N)" label in the sidebar. Files are
       grouped by the first `_`-delimited token containing `asu` or `asau`;
       files without a recognized tag are skipped entirely (not counted as an
       anonymous "Unknown AU" device). */
    const auDeviceCount = useMemo(() => {
        const groups = new Set();
        for (const f of files) {
            if (!f || f.isFolder) continue;
            const baseName = String(f.name || '').split('/').pop().split('\\').pop();
            const parts = baseName.split('_');
            const tag = parts.find(
                (p) => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau')
            );
            if (!tag) continue;
            groups.add(tag.toUpperCase());
        }
        return groups.size;
    }, [files]);

    const fileInputRef = useRef(null);
    const openFilePicker = useCallback(() => {
        if (typeof onBrowse === 'function') {
            onBrowse();
            return;
        }
        fileInputRef.current?.click();
    }, [onBrowse]);

    const [theme, setTheme] = useState(() => readStoredTheme());
    useEffect(() => {
        const onChange = (e) => {
            const next = e?.detail?.theme;
            if (next) setTheme(next);
        };
        window.addEventListener('noze-theme-change', onChange);
        return () => window.removeEventListener('noze-theme-change', onChange);
    }, []);
    const handleThemeCycle = useCallback(() => {
        const next = cycleTheme(theme);
        setTheme(next);
    }, [theme]);
    const ThemeIcon = THEME_META[theme]?.Icon || Sparkles;
    const themeLabel = THEME_META[theme]?.label || 'Noze';

    const firstName = String(userName || 'User').split(/\s+/)[0];
    const greeting = (() => {
        const h = new Date().getHours();
        if (h < 5) return 'Working late';
        if (h < 12) return 'Good morning';
        if (h < 18) return 'Good afternoon';
        return 'Good evening';
    })();

    return (
        <motion.div
            className="home-page"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
        >
            {/* ───────── HERO ───────── */}
            <header className="home-hero">
                <div className="home-hero-left">
                    <div className="home-hero-badge">
                        <span className="home-hero-badge-dot" />
                        NozePlot · v{APP_VERSION}
                    </div>
                    <h1 className="home-hero-title">
                        {greeting}, {firstName}.
                        <br />
                        <span className="home-hero-title-accent">
                            Aroma sensor analysis tools
                        </span>
                    </h1>
                    <p className="home-hero-sub">
                        Capture, plot, and model multi-channel sensor streams — from raw
                        UART to trained models.
                    </p>

                    <div className="home-hero-cta-row">
                        <button
                            type="button"
                            className="home-btn home-btn-ghost"
                            onClick={() => onPageChange?.('help')}
                        >
                            <BookOpen size={15} />
                            Read User Guide
                        </button>
                    </div>
                </div>

                <aside className="home-hero-right">
                    <div className="home-hero-stat">
                        <div className="home-hero-stat-label">Files</div>
                        <div className="home-hero-stat-value">{dataFiles.length}</div>
                    </div>
                    <div className="home-hero-stat">
                        <div className="home-hero-stat-label">Workspace</div>
                        <div className="home-hero-stat-value">
                            {formatWorkspaceDataSize(totalBytes)}
                        </div>
                    </div>
                    <div className="home-hero-stat">
                        <div className="home-hero-stat-label">AU devices</div>
                        <div className="home-hero-stat-value">{auDeviceCount}</div>
                    </div>
                </aside>
            </header>

            {/* ───────── RECENT + SPARKLINE ───────── */}
            <section className="home-row home-row-recent">
                <div className="home-panel home-panel-recent">
                    <header className="home-panel-head">
                        <div className="home-panel-head-left">
                            <FolderOpen size={14} />
                            <span className="home-panel-title">Recent workspace</span>
                        </div>
                        <button
                            type="button"
                            className="home-panel-link"
                            onClick={() => onPageChange?.('fileViewer')}
                        >
                            Open File Viewer <ArrowRight size={12} />
                        </button>
                    </header>
                    {recentFiles.length === 0 ? (
                        <div className="home-recent-empty">
                            <p>Your workspace is empty.</p>
                            <button
                                type="button"
                                className="home-btn home-btn-secondary"
                                onClick={openFilePicker}
                            >
                                <UploadCloud size={15} /> Upload CSV
                            </button>
                        </div>
                    ) : (
                        <ul className="home-recent-list">
                            {recentFiles.map((f) => (
                                <li key={f.id}>
                                    <button
                                        type="button"
                                        className="home-recent-row"
                                        onClick={() => {
                                            if (typeof onFileSelect === 'function') onFileSelect(f.id);
                                            if (typeof onPageChange === 'function')
                                                onPageChange('fileViewer');
                                        }}
                                        title={f.name}
                                    >
                                        <FileText
                                            size={14}
                                            className="home-recent-row-icon"
                                            aria-hidden
                                        />
                                        <span className="home-recent-row-name">
                                            {fileBasename(f.name)}
                                        </span>
                                        <span className="home-recent-row-size">
                                            {formatWorkspaceDataSize(
                                                f.bytes || f.size || f.dataBytes || 0
                                            )}
                                        </span>
                                        <span className="home-recent-row-time">
                                            {formatRelativeTime(
                                                f.uploadedAt || f.createdAt || f.modifiedAt
                                            )}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="home-panel home-panel-spark">
                    <header className="home-panel-head">
                        <div className="home-panel-head-left">
                            <Activity size={14} />
                            <span className="home-panel-title">Signal preview</span>
                        </div>
                        <span className="home-panel-meta">
                            {sparkSeries
                                ? `${fileBasename(selectedFile?.name || 'current file')} · ${
                                      sparkSeries.field
                                  }`
                                : 'No file selected'}
                        </span>
                    </header>
                    <div className="home-spark-wrap">
                        {sparkSeries ? (
                            <Sparkline series={sparkSeries} />
                        ) : (
                            <div className="home-spark-empty">
                                Select a file from the sidebar to see its first channel here.
                            </div>
                        )}
                    </div>
                </div>
            </section>

            {/* ───────── LAUNCHERS ───────── */}
            <section className="home-launchers">
                <h2 className="home-section-title">Jump in</h2>
                <div className="home-tiles">
                    {LAUNCHERS.map(({ id, icon: Icon, tint, title, desc }) => (
                        <button
                            key={id}
                            type="button"
                            className="home-tile"
                            onClick={() => onPageChange?.(id)}
                            style={{ '--tile-tint': tint }}
                        >
                            <div className="home-tile-icon">
                                <Icon size={18} />
                            </div>
                            <div className="home-tile-title">{title}</div>
                            <div className="home-tile-desc">{desc}</div>
                            <div className="home-tile-cta">
                                Open <ArrowRight size={12} />
                            </div>
                        </button>
                    ))}
                </div>
            </section>

            {/* ───────── FOOTER STRIP ───────── */}
            <footer className="home-footer">
                <div className="home-footer-left">
                    <ShieldCheck size={13} />
                    <span>
                        Runs 100% in your browser · No data leaves your machine · Works
                        offline after first load.
                    </span>
                </div>
                <div className="home-footer-right">
                    <span className="home-footer-version">v{APP_VERSION}</span>
                    <button
                        type="button"
                        className="home-footer-link"
                        onClick={() => onPageChange?.('help')}
                    >
                        <BookOpen size={13} /> Help
                    </button>
                    <button
                        type="button"
                        className="home-footer-theme"
                        onClick={handleThemeCycle}
                        title={`Theme: ${themeLabel}. Click to cycle Noze → Dark → Light.`}
                    >
                        <ThemeIcon size={13} /> {themeLabel}
                    </button>
                </div>
            </footer>
        </motion.div>
    );
};

export default HomePage;
