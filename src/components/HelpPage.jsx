import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
    BookOpen,
    Compass,
    LayoutDashboard,
    Activity,
    LineChart,
    Target,
    Zap,
    TrendingUp,
    Factory,
    FileSpreadsheet,
    Network,
    FlaskConical,
    Brain,
    Calculator,
    DownloadCloud,
    FolderOpen,
    Info,
} from 'lucide-react';
import './HelpPage.css';

/**
 * User guide sections: id = anchor for table of contents
 */
const GUIDE_SECTIONS = [
    {
        id: 'overview',
        icon: BookOpen,
        title: 'Overview',
        subtitle: 'What NozePlot is',
        intro:
            'NozePlot (NozePlot4) is a browser-based analytics workspace for sensor and CSV data. All processing runs locally in your browser; files are stored in IndexedDB on your device—nothing is uploaded to a server.',
        implemented: [
            'Multi-file workspace with folders, search, and compare selection',
            'CSV and Excel (.xlsx / .xls) import and parsing',
            'Session save/restore via .noze workspace files',
        ],
        steps: [
            'On first launch, enter your display name (stored locally).',
            'Upload files or a folder from the sidebar; select a main file and optionally add comparison files.',
            'Open the page you need from the sidebar (Dashboard, Normalize, Aroma, etc.).',
        ],
    },
    {
        id: 'workspace',
        icon: FolderOpen,
        title: 'Workspace & files',
        subtitle: 'Upload, folders, main vs compare',
        intro:
            'The sidebar lists every file in your workspace. You can organize uploads into custom folders, search by name, and export or restore the whole session.',
        implemented: [
            'Upload single files or an entire folder (preserves paths where supported)',
            'Create named folders and upload into a specific folder',
            'Main file: click once to plot as primary; multi-select adds comparison files',
            'Select all / clear compare for batch comparison on Dashboard and analysis pages',
            'Delete individual files, bulk delete, or clear entire workspace',
            'Tooltips on files when hovering for quick metadata',
        ],
        steps: [
            'Click **Upload Files** or **Upload Folder** in the sidebar.',
            'Click a file to set it as the **main** dataset (charts use this first).',
            'Ctrl/Cmd-click or use your app’s multi-select to add **comparison** files (where supported).',
            'Use **Export** (cloud-down icon) to save a `.noze` snapshot; **Restore** (monitor-up) to reload one.',
        ],
    },
    {
        id: 'dashboard',
        icon: LayoutDashboard,
        title: 'Dashboard',
        subtitle: 'Raw time-series grid',
        intro:
            'Shows **raw** numeric columns from the main file (and merged comparison series where configured). This is for quick visual inspection—not baseline-normalized data.',
        implemented: [
            'Automatic X-axis: uses a date/time/timestamp column if column names match (date, time, stamp, etc.); otherwise uses sample index **1, 2, 3…**',
            'Grid of mini charts per numeric series; click a chart to focus and zoom',
            'Zoom slider, brush, and wheel zoom on the focused chart',
            'Comparison overlay: merge by matching X values or row index when keys differ',
            'Multi-file picker to choose which files to compare',
        ],
        steps: [
            'Select a main file in the sidebar.',
            'Stay on **Dashboard** (default when a file is selected).',
            'Optionally add comparison files and pick series from the compare UI.',
            'Click a small chart to open the zoomable single-chart view.',
        ],
    },
    {
        id: 'normalize',
        icon: Activity,
        title: 'Normalize',
        subtitle: 'Baseline & % change',
        intro:
            'Interactive baseline selection and normalization to percent change relative to a chosen window. Supports the main file plus comparison files on one chart.',
        implemented: [
            'Drag on the chart to define a baseline region (highlighted band)',
            'Normalized view shows % change from baseline mean per series',
            'Brush for range selection; compare files shown with distinct colors/line styles',
            'Same X-axis rules as Dashboard (time column if detected, else index 1, 2, 3…)',
        ],
        steps: [
            'Open **Normalize** with a file selected.',
            'Drag horizontally on the plot to set the baseline interval.',
            'Toggle normalized vs raw as provided by the UI.',
            'Add comparison files from the workspace to align series on one plot.',
        ],
    },
    {
        id: 'aroma',
        icon: LineChart,
        title: 'Aroma analysis',
        subtitle: 'Batch pipeline & plots',
        intro:
            'Batch processing for aroma/sensor-style datasets: filtering, optional event-based truncation (e.g. FeNO/breath windows), moving average, baseline normalization from RFC/ambient rows or first N points, and many derived plots.',
        implemented: [
            'Configurable sensing element and temperature/humidity column patterns',
            'Moving-average filter window; baseline point count for automatic normalization',
            'Optional removal of non-breath event blocks when event columns exist; FeNO truncation (seconds × sample rate heuristic)',
            'Concentration labels from filenames (**ppb** pattern, ALAAC-style)',
            'Plots: time-series averages, monotonic curves, separations by unit, environmental overlays (T, RH, absolute humidity), etc.',
            'Single-plot modal: zoom, reset, **Download PNG** (with Y-axis label)',
            'Folder compare flow for batch aroma comparison (opens dedicated view from Aroma page when used)',
        ],
        steps: [
            'Select main file (and comparisons if batch note says to add them on Dashboard first).',
            'Adjust sidebar options (elements, temp/hum columns, filter, baseline points, toggles).',
            'Run **Run Pipeline & Plot** (or equivalent).',
            'Click a plot card to open fullscreen zoom; use **Download PNG** to export.',
        ],
    },
    {
        id: 'separability',
        icon: Target,
        title: 'Separability analysis',
        subtitle: 'Element discrimination metrics',
        intro:
            'Computes separability-style scores between conditions (e.g. concentrations) per sensing element, with visualizations such as heatmaps, radar-style views, and scatter summaries.',
        implemented: [
            'Pairwise separability statistics (variance-aware separation between groups)',
            'Baseline resistance and stability-style summaries per element',
            'Interactive charts with tooltips; optional panel layout and zen/sidebar modes where wired',
            'Batch-oriented workflows when multiple files are available from workspace',
        ],
        steps: [
            'Load data and open **Separability** from the sidebar.',
            'Configure any on-page filters or element scope.',
            'Run analysis and inspect charts; use plot interactions as on other pages.',
        ],
    },
    {
        id: 'sensitivity',
        icon: Zap,
        title: 'Sensitivity analysis',
        subtitle: '3D-style performance views',
        intro:
            'Visualizes sensitivity and related metrics across elements and conditions; supports trajectory-style views to see how responses evolve across concentrations or trials.',
        implemented: [
            'Aggregate sensitivity visualizations for the loaded dataset',
            'Trajectory toggles where implemented (connected series across conditions)',
            'Chart export or zoom patterns consistent with other analysis pages',
        ],
        steps: [
            'Select your main CSV and open **Sensitivity**.',
            'Use on-page toggles (e.g. trajectories) to change the view.',
            'Interpret axes using chart labels and legends.',
        ],
    },
    {
        id: 'recovery',
        icon: TrendingUp,
        title: 'Recovery analysis',
        subtitle: 'Exposure & recovery dynamics',
        intro:
            'Focuses on defining exposure vs recovery phases (via keywords in event or similar columns), computing recovery metrics, and plotting sensor and environmental traces over time.',
        implemented: [
            'Configurable exposure/recovery keywords; optional hardware recovery handling',
            'Humidity/temperature column patterns; optional filter to files with known **ppb** in filename',
            'Chronological ordering of batch files when timestamps appear in names',
            'Recovery result tables and plots; chrono plots with environmental overlays (e.g. absolute humidity)',
            'PNG export for charts where implemented',
        ],
        steps: [
            'Add main + compare files with consistent naming if using ppb filtering.',
            'Set sensing elements and temp/humidity columns to match your CSV headers.',
            'Tune exposure/recovery keywords to match your event labels.',
            'Run processing and open individual plots for detail.',
        ],
    },
    {
        id: 'manufacturing',
        icon: Factory,
        title: 'Manufacturing variation',
        subtitle: 'Lot / concentration consistency',
        intro:
            'Summarizes variation across files or concentration buckets—useful for manufacturing or repeatability studies using the same column naming conventions as other aroma-style tools.',
        implemented: [
            'Concentration filter and optional “known file” (ppb in name) filtering',
            'Bar/line/scatter style summaries of spread across elements',
            'Batch processing across workspace files selected for compare',
        ],
        steps: [
            'Open **Mfg Variation** with relevant files selected.',
            'Set sensing element patterns and optional concentration filter.',
            'Run analysis and review variation charts.',
        ],
    },
    {
        id: 'csv-plotter',
        icon: FileSpreadsheet,
        title: 'CSV plotter',
        subtitle: 'Standalone file → charts',
        intro:
            'A self-contained plotting area where you can load CSV files directly inside the page without using the main workspace list—handy for ad-hoc plots.',
        implemented: [
            'In-page CSV upload and parse',
            'Composed/line charts with zoom controls (similar patterns to Aroma-style plot cards)',
            'Does not require a sidebar-selected main file',
        ],
        steps: [
            'Open **CSV Plotter** from the sidebar.',
            'Upload a CSV through the page UI.',
            'Choose series and use zoom/export as offered on the page.',
        ],
    },
    {
        id: 'gas-design',
        icon: Network,
        title: 'Gas system design',
        subtitle: 'Flow diagram editor',
        intro:
            'Interactive node-based editor for gas delivery / plumbing style diagrams using React Flow.',
        implemented: [
            'Drag-and-drop style nodes and connections for system layout',
            'Local editing in the browser (diagram state is page-local unless you screenshot/export)',
        ],
        steps: [
            'Open **Gas Design**.',
            'Add nodes and connect edges to model your system.',
            'Use the page’s controls for layout or export if available.',
        ],
    },
    {
        id: 'dilution',
        icon: FlaskConical,
        title: 'Dilution math',
        subtitle: 'Gas dilution calculator',
        intro:
            'Calculator page for dilution-related formulas (mass flows, concentrations, etc.) as implemented in `GasDilutionMathPage`.',
        implemented: [
            'Dedicated inputs for dilution parameters and computed outputs',
            'Static reference math—no dataset required',
        ],
        steps: [
            'Open **Dilution**.',
            'Enter known quantities in the fields provided.',
            'Read calculated results from the page.',
        ],
    },
    {
        id: 'ml-studio',
        icon: Brain,
        title: 'ML Studio',
        subtitle: 'PCA, t-SNE, models',
        intro:
            'Machine-learning style exploration: feature extraction from time series per file, dimensionality reduction (PCA, t-SNE), and simple regressors/classifiers (e.g. random forest, linear models) via TensorFlow.js / ml.js libraries.',
        implemented: [
            'Target column selection and per-file label mapping where UI provides it',
            'Train/evaluate flows with charts for embeddings and predictions',
            'Resizable sidebar; zen mode integration when sidebar is hidden globally',
        ],
        steps: [
            'Load at least one data file.',
            'Open **ML Studio**; pick target column and task type (regression/classification).',
            'Map labels or parameters as the sidebar requests.',
            'Run training and inspect scatter/embeddings and metrics.',
        ],
    },
    {
        id: 'calculator',
        icon: Calculator,
        title: 'Calculator',
        subtitle: 'Floating tool',
        intro:
            'A popup scientific-style calculator available from the sidebar without leaving your current page.',
        implemented: [
            'Opens as overlay; toggle from calculator icon in the sidebar tool row',
            'Independent of selected dataset',
        ],
        steps: [
            'Click the **calculator** icon in the sidebar (next to Dilution / ML shortcuts).',
            'Dismiss the panel when finished.',
        ],
    },
    {
        id: 'workspace-export',
        icon: DownloadCloud,
        title: 'Workspace export & restore',
        subtitle: '.noze files',
        intro:
            'Saves which file is main, which are compared, and the active page into a downloadable `.noze` JSON file. Restoring reloads the app and reapplies that state from IndexedDB-backed files.',
        implemented: [
            'Export: serializes session metadata + file references stored locally',
            'Import: reads `.noze`, stashes restore payload in localStorage, reloads window',
            'After reload, main/compare selection and page are restored when file blobs/metadata exist in IndexedDB',
        ],
        steps: [
            'Click **Export** (green cloud) in the workspace header when files exist.',
            'Save the `.noze` file somewhere safe.',
            'Later, click **Restore** (purple monitor) and choose the same `.noze` file.',
            'If raw blobs were cleared, re-upload files and restore again to relink.',
        ],
    },
    {
        id: 'theory',
        icon: Info,
        title: 'Theory & metrics (reference)',
        subtitle: 'How some numbers are interpreted',
        intro:
            'Short reference for terminology used across separability/sensitivity-style pages.',
        implemented: [
            'Baseline resistance (Ω): mean resistance in a rest / reference window',
            'Sensitivity (% ΔR/R): relative change from baseline at response',
            'Separability: distance between distributions or conditions; higher suggests easier discrimination',
            'Signal spread: variability during exposure—lower often means tighter repeatability',
        ],
        steps: [],
    },
];

function SectionCard({ section, index }) {
    const Icon = section.icon;
    return (
        <motion.article
            id={`help-${section.id}`}
            className="help-section-card"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: Math.min(index * 0.03, 0.4) }}
        >
            <header className="help-section-header">
                <Icon className="help-section-icon" aria-hidden />
                <div>
                    <h2 className="help-section-title">{section.title}</h2>
                    <p className="help-section-subtitle">{section.subtitle}</p>
                </div>
            </header>
            <p className="help-section-intro">{section.intro}</p>

            <h3 className="help-subheading">What is implemented</h3>
            <ul className="help-list">
                {section.implemented.map((item, i) => (
                    <li key={i}>{item}</li>
                ))}
            </ul>

            {section.steps && section.steps.length > 0 && (
                <>
                    <h3 className="help-subheading">How to use</h3>
                    <ol className="help-steps">
                        {section.steps.map((step, i) => (
                            <li key={i}>
                                {step.split('**').map((part, j) =>
                                    j % 2 === 1 ? <strong key={j}>{part}</strong> : part
                                )}
                            </li>
                        ))}
                    </ol>
                </>
            )}
        </motion.article>
    );
}

const HelpPage = () => {
    const toc = useMemo(
        () =>
            GUIDE_SECTIONS.map((s) => ({
                id: s.id,
                label: s.title,
            })),
        []
    );

    const scrollToId = (id) => {
        const el = document.getElementById(`help-${id}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <div className="help-page-layout">
            <header className="help-header">
                <div>
                    <h1 className="help-title">User guide</h1>
                    <p className="help-subtitle">
                        Step-by-step instructions and a feature list for each section of NozePlot. All data stays on your device.
                    </p>
                </div>
                <BookOpen size={28} className="help-title-icon" aria-hidden />
            </header>

            <div className="help-body">
                <nav className="help-toc glass-toc" aria-label="Guide sections">
                    <div className="help-toc-title">On this page</div>
                    <ul className="help-toc-list">
                        {toc.map((item) => (
                            <li key={item.id}>
                                <button type="button" className="help-toc-link" onClick={() => scrollToId(item.id)}>
                                    {item.label}
                                </button>
                            </li>
                        ))}
                    </ul>
                </nav>

                <div className="help-sections">
                    {GUIDE_SECTIONS.map((section, idx) => (
                        <SectionCard key={section.id} section={section} index={idx} />
                    ))}
                </div>
            </div>

            <div className="help-footer-banner">
                <Compass className="footer-icon text-blue" aria-hidden />
                <div className="footer-text">
                    <h4>Need a specific page?</h4>
                    <p>
                        Use the sidebar to switch modules. This guide opens from the <strong>Help</strong> button and does not require a
                        file to be selected.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default HelpPage;
