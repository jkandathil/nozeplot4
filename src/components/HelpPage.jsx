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
    Sigma,
    Blend,
    Usb,
} from 'lucide-react';
import './HelpPage.css';

/** Reusable math layout: fractions, rows, blocks */
function MathBlock({ label, children }) {
    return (
        <div className="help-math-block" role="region" aria-label={label}>
            {children}
        </div>
    );
}

function MRow({ children, className = '' }) {
    return <div className={`help-math-row ${className}`.trim()}>{children}</div>;
}

/** Stacked fraction: num over den */
function Frac({ num, den }) {
    return (
        <span className="help-math-frac" role="presentation">
            <span className="help-math-num">{num}</span>
            <span className="help-math-bar" aria-hidden="true" />
            <span className="help-math-den">{den}</span>
        </span>
    );
}

function Mi({ children }) {
    return <span className="help-math-ident">{children}</span>;
}

function Mo({ children, className = '' }) {
    return <span className={`help-math-op ${className}`.trim()}>{children}</span>;
}

/** User-facing formulas for the Help guide */
function EquationsTheoryAppendix() {
    return (
        <div className="help-equations-appendix">
            <h3 className="help-subheading">Normalize tab (fractional change)</h3>
            <p className="help-eq-para">
                For each numeric series <em>k</em>, the mean is taken over all points in the X-axis window you select on the chart (baseline window). Let{' '}
                <span className="help-math-inline">x<sub>k</sub>(t)</span> be the raw value and{' '}
                <span className="help-math-inline">
                    <span className="help-math-greek">μ̄</span>
                    <sub>k</sub>
                </span>{' '}
                the baseline mean.
            </p>
            <MathBlock label="Baseline mean">
                <MRow>
                    <Mi>
                        <span className="help-math-greek">μ̄</span>
                        <sub>k</sub>
                    </Mi>
                    <Mo>=</Mo>
                    <Frac
                        num={<>1</>}
                        den={
                            <>
                                <span className="help-math-greek">N</span>
                            </>
                        }
                    />
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                        <sub className="help-math-sum-sub">i</sub>
                    </span>
                    <Mi>
                        x<sub>k</sub>(t<sub>i</sub>)
                    </Mi>
                </MRow>
                <p className="help-math-caption">summed over baseline rows i = 1 … N</p>
            </MathBlock>
            <p className="help-eq-para">
                The chart and tooltips show <strong>percent change</strong>; that is the following fractional change multiplied by 100:
            </p>
            <MathBlock label="Normalized fractional change">
                <MRow>
                    <Mi>
                        y<sub>k</sub>(t)
                    </Mi>
                    <Mo>=</Mo>
                    <Frac
                        num={
                            <>
                                x<sub>k</sub>(t) <Mo className="help-math-minus">−</Mo> <span className="help-math-greek">μ̄</span>
                                <sub>k</sub>
                            </>
                        }
                        den={
                            <>
                                <span className="help-math-greek">μ̄</span>
                                <sub>k</sub>
                            </>
                        }
                    />
                </MRow>
                <MRow className="help-math-row-implies">
                    <Mo>⇒</Mo>
                    <span className="help-math-desc">tooltip / axis: y<sub>k</sub> × 100 as percent change</span>
                </MRow>
            </MathBlock>
            <p className="help-eq-note">If <span className="help-math-greek">μ̄</span><sub>k</sub> = 0, that series is left unchanged.</p>
            <p className="help-eq-note">
                The baseline window is stored as X-axis labels (time stamps or indices). It is kept when you add or remove comparison files or change concentration filters, so you do not have to redraw it for every new trace. It clears when you select a different main file, when the chart switches between a date/time axis and row indices, or when recovery-event trimming is toggled. If labels are no longer present after such a change, the selection is cleared instead of averaging the wrong rows.
            </p>

            <h3 className="help-subheading">Aroma pipeline — baseline, response %, smoothing</h3>
            <p className="help-eq-para">
                For each raw sensing column <em>k</em> (columns that are not already “normalized” in the file), baseline <span className="help-math-inline">b<sub>k</sub></span> is
                the <strong>median</strong> of up to <strong>the number of baseline points</strong> you set in the Aroma sidebar, taken from RFC / ambient / BL rows when those exist;
                otherwise from the first that many rows of the file before event trimming.
            </p>
            <MathBlock label="Median baseline">
                <MRow>
                    <Mi>
                        b<sub>k</sub>
                    </Mi>
                    <Mo>=</Mo>
                    <span className="help-math-fn">median</span>
                    <Mo>(</Mo>
                    <span className="help-math-set">
                        {'{ '}
                        x<sub>k</sub>
                        {' }'}
                    </span>
                    <Mo>)</Mo>
                </MRow>
                <p className="help-math-caption">over the chosen baseline rows</p>
            </MathBlock>
            <p className="help-eq-para">If b<sub>k</sub> is 0 or invalid, it is set to 1.0. Per-row normalized response (%):</p>
            <MathBlock label="Percent change from baseline">
                <MRow>
                    <Mi>
                        R′<sub>k</sub>(t)
                    </Mi>
                    <Mo>=</Mo>
                    <span>100</span>
                    <Mo>×</Mo>
                    <Mo>(</Mo>
                    <Frac num={<>R<sub>k</sub>(t)</>} den={<>b<sub>k</sub></>} />
                    <Mo className="help-math-minus">−</Mo>
                    <span>1</span>
                    <Mo>)</Mo>
                </MRow>
            </MathBlock>
            <p className="help-eq-para">
                If your data already uses a “normalized” column (by name), it is treated as a small fraction and only multiplied by 100 for display scaling.
            </p>
            <p className="help-eq-para">
                <strong>Moving average</strong> (window <em>W</em>): causal mean over rows j = max(0, i − W + 1) … i.
            </p>
            <MathBlock label="Moving average">
                <MRow>
                    <Mi>
                        <span className="help-math-greek">x̃</span>
                        <sub>k</sub>(i)
                    </Mi>
                    <Mo>=</Mo>
                    <Frac num={<>1</>} den={<>W</>} />
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                        <sub className="help-math-sum-sub">j</sub>
                    </span>
                    <Mi>
                        x<sub>k</sub>(j)
                    </Mi>
                </MRow>
                <p className="help-math-caption">for j = max(0, i − W + 1), …, i</p>
            </MathBlock>

            <h3 className="help-subheading">Absolute humidity (Magnus-type, as implemented)</h3>
            <p className="help-eq-para">
                Paired temperature <em>T</em> (°C) and relative-humidity columns. The constants 6.112, 17.67, 243.5, 2.16679, and 273.15 come from a standard Magnus-type
                saturation-vapor formulation adapted for absolute humidity.
            </p>
            <MathBlock label="Saturation vapor pressure and absolute humidity">
                <MRow>
                    <Mi>
                        e<sub>s</sub>(T)
                    </Mi>
                    <Mo>=</Mo>
                    <span>6.112</span>
                    <Mo>×</Mo>
                    <span className="help-math-fn">exp</span>
                    <Mo>(</Mo>
                    <Frac
                        num={
                            <>
                                17.67 <Mo>×</Mo> T
                            </>
                        }
                        den={<>T + 243.5</>}
                    />
                    <Mo>)</Mo>
                </MRow>
                <MRow>
                    <Mi>abs. humidity</Mi>
                    <Mo>=</Mo>
                    <Frac
                        num={
                            <>
                                e<sub>s</sub>(T) <Mo>×</Mo> RH <Mo>×</Mo> 2.16679
                            </>
                        }
                        den={<>T + 273.15</>}
                    />
                </MRow>
            </MathBlock>
            <p className="help-eq-note">
                <strong>RH</strong> is the numeric value from your file (use the same units as recorded—often 0–100%).
            </p>

            <h3 className="help-subheading">Separability analysis (pairwise <em>S</em>)</h3>
            <div className="help-theory-box" role="note">
                <p className="help-theory-lead">
                    <strong>What “separability” means here:</strong> you have two sets of sensor readings—often one at a reference condition (e.g. 0 ppb or baseline) and one at
                    another condition (e.g. a test concentration). The question is how easy it is to <em>tell the two conditions apart</em> from the numbers alone, given noise and
                    repeatability.
                </p>
                <ul className="help-theory-list">
                    <li>
                        <strong>Signal (numerator):</strong>{' '}
                        <span className="help-math-inline">
                            <span className="help-math-abs">|</span>
                            <span className="help-math-greek">μ</span>
                            <sub>A</sub> − <span className="help-math-greek">μ</span>
                            <sub>B</sub>
                            <span className="help-math-abs">|</span>
                        </span>{' '}
                        is the gap between the <em>average</em> response in condition A and in condition B. A larger gap means the two conditions sit farther apart on average.
                    </li>
                    <li>
                        <strong>Noise / spread (denominator):</strong>{' '}
                        <span className="help-math-inline">
                            <span className="help-math-greek">s</span>
                            <sup>2</sup>
                            <sub>A</sub> + <span className="help-math-greek">s</span>
                            <sup>2</sup>
                            <sub>B</sub>
                        </span>{' '}
                        is how much each group fluctuates around its own mean (unbiased sample variances). If both groups are very noisy, the same mean gap is harder to trust—so it
                        should count for less in the ratio.
                    </li>
                    <li>
                        <strong>Combined score <em>S</em>:</strong> dividing the mean gap by the sum of variances gives a <em>signal-to-spread</em>-style ratio (similar in spirit to a
                        Fisher linear discriminant, but using scalar means and variances only). <strong>Higher <em>S</em></strong> ⇒ the between-condition shift is large <em>relative
                        to</em> within-condition variability ⇒ <strong>better separability</strong> for classification or ranking elements. <strong>Lower <em>S</em></strong> ⇒
                        overlapping or noisy responses ⇒ harder to distinguish conditions.
                    </li>
                    <li>
                        <strong>
                            Why <span className="help-math-greek">ε</span> (epsilon):
                        </strong>{' '}
                        when both groups are almost constant, variances are near zero and the ratio would explode or be undefined. A small constant 10<sup>−3</sup> is added in the
                        denominator to keep the score stable.
                    </li>
                    <li>
                        <strong>Not a p-value:</strong> <em>S</em> is a descriptive score, not a formal hypothesis test. Use it to <em>compare elements or conditions relative to each
                        other</em> on the same dataset, not as an absolute universal threshold.
                    </li>
                </ul>
            </div>
            <p className="help-eq-para">
                Two sample sets <em>A</em> and <em>B</em> are summarized by the <strong>sample mean</strong> and <strong>unbiased sample variance</strong> (divide by{' '}
                <em>n</em> − 1 when <em>n</em> &gt; 1). These enter the separability score <em>S</em> below.
            </p>
            <MathBlock label="Means and variances">
                <MRow>
                    <Mi>
                        <span className="help-math-greek">μ</span>
                        <sub>A</sub>
                    </Mi>
                    <Mo>=</Mo>
                    <Frac num={<>1</>} den={<>n<sub>A</sub></>} />
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                    </span>
                    <Mi>
                        a<sub>i</sub>
                    </Mi>
                    <span className="help-math-punct">,</span>
                    <Mi>
                        <span className="help-math-greek">μ</span>
                        <sub>B</sub>
                    </Mi>
                    <Mo>=</Mo>
                    <Frac num={<>1</>} den={<>n<sub>B</sub></>} />
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                    </span>
                    <Mi>
                        b<sub>i</sub>
                    </Mi>
                </MRow>
                <MRow>
                    <Mi>
                        s<sup>2</sup>
                        <sub>A</sub>
                    </Mi>
                    <Mo>=</Mo>
                    <Frac
                        num={<>1</>}
                        den={
                            <>
                                n<sub>A</sub> <Mo className="help-math-minus">−</Mo> 1
                            </>
                        }
                    />
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                    </span>
                    <Mo>(</Mo>
                    <Mi>
                        a<sub>i</sub> <Mo className="help-math-minus">−</Mo> <span className="help-math-greek">μ</span>
                        <sub>A</sub>
                    </Mi>
                    <Mo>)</Mo>
                    <sup>2</sup>
                    <span className="help-math-desc help-math-desc-inline">(0 if n<sub>A</sub> ≤ 1)</span>
                </MRow>
                <MRow>
                    <Mi>
                        s<sup>2</sup>
                        <sub>B</sub>
                    </Mi>
                    <Mo>=</Mo>
                    <Frac
                        num={<>1</>}
                        den={
                            <>
                                n<sub>B</sub> <Mo className="help-math-minus">−</Mo> 1
                            </>
                        }
                    />
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                    </span>
                    <Mo>(</Mo>
                    <Mi>
                        b<sub>i</sub> <Mo className="help-math-minus">−</Mo> <span className="help-math-greek">μ</span>
                        <sub>B</sub>
                    </Mi>
                    <Mo>)</Mo>
                    <sup>2</sup>
                    <span className="help-math-desc help-math-desc-inline">(0 if n<sub>B</sub> ≤ 1)</span>
                </MRow>
            </MathBlock>
            <p className="help-eq-para">
                <strong>Pairwise separability</strong> combines those means and variances (with <span className="help-math-inline help-math-greek">ε</span> = 10<sup>−3</sup> in the
                denominator):
            </p>
            <MathBlock label="Separability S">
                <MRow>
                    <Mi>S</Mi>
                    <Mo>=</Mo>
                    <Frac
                        num={
                            <>
                                <span className="help-math-abs">|</span>
                                <span className="help-math-greek">μ</span>
                                <sub>A</sub>
                                <Mo className="help-math-minus">−</Mo>
                                <span className="help-math-greek">μ</span>
                                <sub>B</sub>
                                <span className="help-math-abs">|</span>
                            </>
                        }
                        den={
                            <>
                                s<sup>2</sup>
                                <sub>A</sub> + s<sup>2</sup>
                                <sub>B</sub> + <span className="help-math-greek">ε</span>
                            </>
                        }
                    />
                </MRow>
            </MathBlock>
            <p className="help-eq-note">
                The <strong>Separability</strong> analysis view may aggregate <em>S</em> over many pairwise comparisons (e.g. different concentration pairs) and elements, so charts
                show averages or summaries—interpret them as <em>relative</em> rankings. The <strong>Sensitivity</strong> view uses a related idea row-by-row when your exported table
                includes, for each element and concentration, a <strong>mean</strong> plus <strong>min/max or sigma spread</strong> columns—see below.
            </p>

            <h3 className="help-subheading">Sensitivity view (wide tables, e.g. FeNO-style exports)</h3>
            <p className="help-eq-para">
                Some workflows provide a <strong>wide</strong> table: a reference level (often 0 ppb) and each test level, with one column per element for the <strong>mean</strong>{' '}
                response and companion columns for <strong>spread</strong> (minimum, maximum, or sigma-style bounds). The Sensitivity charts read those columns directly.
            </p>
            <ul className="help-list help-eq-list">
                <li>
                    <strong>R₀:</strong> mean raw/mean on RFC / breath / ambient rows.
                </li>
                <li>
                    <strong>Sensitivity (% dR/R):</strong> max |negative excursion| on min/mean in FeNO window, or mean of means on central 20–80% of FeNO rows.
                </li>
                <li className="help-eq-li-with-block">
                    <strong>Separability (per row, averaged):</strong>{' '}
                    <span className="help-math-greek">σ</span>
                    <sub>1</sub>, <span className="help-math-greek">σ</span>
                    <sub>2</sub> = (σ<sub>max</sub> − σ<sub>min</sub>)/2; v<sub>i</sub> = <span className="help-math-greek">σ</span>
                    <sub>i</sub>
                    <sup>2</sup>.
                    <MathBlock label="Row separability">
                        <MRow>
                            <Mi>
                                S<sub>row</sub>
                            </Mi>
                            <Mo>=</Mo>
                            <Frac
                                num={
                                    <>
                                        <span className="help-math-abs">|</span>
                                        <span className="help-math-greek">μ</span>
                                        <sub>1</sub>
                                        <Mo className="help-math-minus">−</Mo>
                                        <span className="help-math-greek">μ</span>
                                        <sub>2</sub>
                                        <span className="help-math-abs">|</span>
                                    </>
                                }
                                den={<>v<sub>1</sub> + v<sub>2</sub> + 10<sup>−3</sup></>}
                            />
                        </MRow>
                    </MathBlock>
                </li>
                <li>
                    <strong>Signal spread:</strong> mean of <span className="help-math-abs">|</span>σ<sub>max</sub> − σ<sub>min</sub>
                    <span className="help-math-abs">|</span> over the same rows.
                </li>
            </ul>

            <h3 className="help-subheading">Pearson correlation <em>r</em></h3>
            <p className="help-eq-para">For <em>n</em> pairs (x<sub>i</sub>, y<sub>i</sub>):</p>
            <MathBlock label="Pearson correlation coefficient">
                <MRow className="help-math-row-multiline">
                    <Mi>r</Mi>
                    <Mo>=</Mo>
                    <Frac
                        num={
                            <span className="help-math-pearson-num">
                                n <span className="help-math-sum">∑</span> x<sub>i</sub>y<sub>i</sub>
                                <span className="help-math-minus"> − </span>
                                <span className="help-math-parens">
                                    (<span className="help-math-sum">∑</span> x<sub>i</sub>)
                                </span>
                                <span className="help-math-parens">
                                    (<span className="help-math-sum">∑</span> y<sub>i</sub>)
                                </span>
                            </span>
                        }
                        den={
                            <span className="help-math-pearson-den">
                                <span className="help-math-sqrt-prefix">√</span>
                                <span className="help-math-sqrt-content">
                                    <span className="help-math-bracket-pair">
                                        <span>
                                            n<span className="help-math-sum">∑</span> x<sub>i</sub>
                                            <sup>2</sup>
                                            <span className="help-math-minus"> − </span>
                                            <span className="help-math-parens">
                                                (<span className="help-math-sum">∑</span> x<sub>i</sub>)<sup>2</sup>
                                            </span>
                                        </span>
                                        <span className="help-math-times-between">·</span>
                                        <span>
                                            n<span className="help-math-sum">∑</span> y<sub>i</sub>
                                            <sup>2</sup>
                                            <span className="help-math-minus"> − </span>
                                            <span className="help-math-parens">
                                                (<span className="help-math-sum">∑</span> y<sub>i</sub>)<sup>2</sup>
                                            </span>
                                        </span>
                                    </span>
                                </span>
                            </span>
                        }
                    />
                </MRow>
            </MathBlock>
            <p className="help-eq-note">Relates baseline resistance to sensitivity or separability in the Sensitivity view.</p>

            <h3 className="help-subheading">ML Studio — PCA &amp; t-SNE (reference)</h3>
            <ul className="help-list help-eq-list">
                <li>
                    <strong>PCA:</strong> orthogonal directions maximizing variance; eigenvectors of the covariance matrix of (often standardized) features.
                </li>
                <li>
                    <strong>t-SNE:</strong> nonlinear 2D embedding preserving local neighborhoods; interpret distances cautiously.
                </li>
                <li>
                    <strong>Supervised models:</strong> random forest / linear models on extracted features; metrics depend on regression vs classification.
                </li>
            </ul>
        </div>
    );
}

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
            'NozePlot (NozePlot4) is a browser-based analytics workspace for sensor and CSV data. Everything runs on your computer in the browser—your files stay on your device and are not uploaded to a server.',
        implemented: [
            'Multi-file workspace with folders, search, and compare selection',
            'CSV and Excel (.xlsx / .xls) import and parsing',
            'Session save/restore via .noze workspace files',
            '**AU capture:** live USB serial capture from supported aroma units (Chrome / Edge) saves straight into the workspace',
        ],
        steps: [
            'On first launch, enter your display name (stored locally).',
            'Upload files or a folder from the sidebar; select a main file and optionally add comparison files.',
            'Open the page you need from the sidebar (Dashboard, Normalize, Aroma, etc.).',
        ],
    },
    {
        id: 'sign-in',
        icon: Info,
        title: 'Sign-in',
        subtitle: 'Required — Google + allowed email domain',
        intro:
            'The app **requires** **Google sign-in** (Firebase). Only verified emails on allowed domains (for example <strong>@noze.ca</strong>) can use the workspace. There is no anonymous or offline mode.',
        implemented: [
            'Firebase web config is supplied at **build time** (see <code>.env.example</code>): <code>VITE_FIREBASE_*</code> plus <code>VITE_ALLOWED_EMAIL_DOMAIN</code> or <code>VITE_ALLOWED_EMAIL_DOMAINS</code>',
            '**Google** sign-in: Firebase must mark the email verified (normal for Google); domain must match the allow list',
            '**Email / password**: register with an allowed-domain address; Firebase sends a **verification link** — you cannot use the app until you open that link and click **I’ve verified**',
            'If the Google popup is blocked, use **Continue with Google (full page)**; the sign-in layout scales for small screens and safe areas (notches)',
            'A session bar shows the signed-in email and **Sign out**',
        ],
        steps: [
            'Open the app and either **Continue with Google** or sign in with **email + password** (after registering).',
            'Use an address on the allowed domain (e.g. <code>name@noze.ca</code>).',
            'If you registered by email, open the Firebase verification message, then return and click **I’ve verified — continue**.',
            'Deployers: enable **Google** and **Email/Password** in Firebase, set authorized domains and env vars, then rebuild.',
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
            '**Export CSV:** download icon on a file row saves that workspace file as CSV',
            '**Folder ZIP:** from a folder’s menu, download all files in that folder as CSV files inside a ZIP',
            '**All DataFiles ZIP:** workspace header action downloads every data file at the root as CSV inside a ZIP',
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
            'Brush for horizontal navigation on long runs',
            'All traces for a given concentration use the **same color**; labels come from **ppb/ppm** in the filename, concentration-like CSV columns, or—when folder uploads preserve paths—a built-in map that matches session-folder names to curated normalized exports',
            'Baseline window **stays** when you add or remove compare files or toggle concentration chips; it **resets** when you pick another main file, when the chart switches between a time column and index **1, 2, 3…**, or when recovery-event trimming is turned on or off',
            'Optional recovery filtering on event/phase columns; optional moving average or Gaussian smoothing',
            'Concentration chips limit which levels appear when those levels can be parsed',
            'Same X-axis rules as Dashboard (time column if detected, else index 1, 2, 3…)',
        ],
        steps: [
            'Open **Normalize** with a file selected.',
            'Drag horizontally on the plot to set the baseline interval.',
            'Add comparison files; the baseline band is kept so you do not have to reselect it for each new file.',
            'Use concentration chips when shown to choose which levels are plotted.',
            'Toggle normalized vs raw as provided by the UI.',
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
            'Concentration labels from filenames (**ppb** pattern, ALAAC-style), optional in-file columns, or folder paths that match the app’s bundled concentration map (same idea as Normalize)',
            'Plots: time-series averages, monotonic curves, separations by unit, environmental overlays (T, RH, absolute humidity), etc.',
            'Single-plot modal: zoom, reset, **Download PNG** (with Y-axis label)',
            '**Folder compare:** on the Aroma page, open the full-screen **folder compare** view for batch side-by-side work; closing it returns you to Aroma',
        ],
        steps: [
            'Select main file (and comparisons if batch note says to add them on Dashboard first).',
            'Adjust sidebar options (elements, temp/hum columns, filter, baseline points, toggles).',
            'Run **Run Pipeline & Plot** (or equivalent).',
            'Click a plot card to open fullscreen zoom; use **Download PNG** to export.',
        ],
    },
    {
        id: 'aroma-unit-capture',
        icon: Usb,
        title: 'AU capture',
        subtitle: 'SiAC / aroma unit over USB (Web Serial)',
        intro:
            'Record live JSON lines from a supported **SiAC / aroma unit** over USB using the browser’s **Web Serial** API. Captures are normalized to table rows and can be **saved into the workspace** as files for Aroma, Normalize, and other tools.',
        implemented: [
            '**Browser:** Chromium-based desktop browsers with Web Serial (e.g. **Chrome**, **Edge**). Not available in Firefox, Safari, or typical mobile browsers',
            '**Device profiles** (e.g. SIAC32_V2) set baud rate and how lines are parsed into columns',
            'Connect to a port, optional **scan** to list candidate devices, timed capture with progress, stop early, and **save to workspace** with generated filenames (including serial-based folder naming when detected)',
            '**Multi-AU:** select several discovered units and run the **same timed window** in parallel',
            'The capture module **stays mounted** while you use other pages so an in-progress recording is not torn down when you navigate away (you can return to AU capture to monitor or finish)',
        ],
        steps: [
            'Connect the unit with USB and use **Chrome or Edge** on desktop.',
            'Open **AU capture** from the sidebar (next to SE Analysis).',
            'Choose the profile, **Connect** (or **Scan** and pick a device), set duration, then start capture.',
            'When done, **Save to workspace**; select the new file in the sidebar and open **Aroma** or another analysis page.',
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
        subtitle: 'Exposure & recovery dynamics (sidebar: Drift Map)',
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
            '**Baseline sampling window (points)** for R0 extraction—adjustable slider; the same value is kept in sync with **Aroma baseline points** (shared preference)',
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
        title: 'SE Analysis (CSV plotter)',
        subtitle: 'Workspace files or ad-hoc upload',
        intro:
            'Plot CSV data in a dedicated view. The sidebar label is **SE Analysis**; you can **pick files already in the workspace** (including inside folders) or **upload** CSV / Excel for a one-off chart without changing the global main file.',
        implemented: [
            'Browse **workspace files and folders** from the page, or upload CSV / Excel from disk',
            'Composed/line charts with column search, X-axis choice, and zoom controls (patterns similar to Aroma plot cards)',
            'Does not require the Dashboard **main** file to be set to the same dataset',
        ],
        steps: [
            'Open **SE Analysis** from the sidebar.',
            'Either attach a workspace file / folder from the in-page browser or **upload** a file.',
            'Choose X axis and series, then use zoom and export options on the page.',
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
            'Calculator for dilution-related quantities (mass flows, concentrations, and related gas-mixing math).',
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
        id: 'polymer-cb',
        icon: Blend,
        title: 'Polymer–CB mix',
        subtitle: 'wt% ↔ volume %',
        intro:
            'Converts **weight percent carbon black** to **volume fraction** (and **phr**) for a two-component polymer composite, using **ideal volume additivity** and densities you enter (g/cm³).',
        implemented: [
            'Forward: wt% CB + ρ_CB + ρ_polymer → φ_CB, volume % CB, phr',
            'Inverse: volume % CB → wt% CB and phr',
            'Defaults are editable (e.g. ρ_CB ≈ 1.85, ρ_polymer ≈ 0.95 g/cm³)—tune to your materials',
        ],
        steps: [
            'Open **Polymer–CB** in the sidebar tool row (under Dilution).',
            'Set carbon black and polymer densities.',
            'Choose **wt% → vol%** or **vol% → wt%** and enter the known value.',
        ],
    },
    {
        id: 'ml-studio',
        icon: Brain,
        title: 'ML Studio',
        subtitle: 'PCA, t-SNE, models',
        intro:
            'Explore patterns in your data with machine learning: features built from each file’s time series, dimensionality reduction (PCA, t-SNE), and simple predictive models (e.g. random forest, linear regression or classification).',
        implemented: [
            'Choose a target column and map labels per file when the panel asks for them',
            'Train models and view embedding scatter plots and basic accuracy or error summaries',
            'Adjustable side panel; more chart room when the main sidebar is collapsed',
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
            'Saves your current setup—main file, comparison files, and which page you were on—into a single downloadable <strong>.noze</strong> file. Restoring opens that layout again after a refresh.',
        implemented: [
            'Export packs your workspace layout and references to the files you had loaded',
            'Import applies the saved layout; the browser reloads once to put everything back in place',
            'Your uploaded files must still be present in the workspace after restore (re-upload if you cleared them)',
        ],
        steps: [
            'Click **Export** (green cloud) in the workspace header when files exist.',
            'Save the `.noze` file somewhere safe.',
            'Later, click **Restore** (purple monitor) and choose the same `.noze` file.',
            'If you removed files from the workspace, add them again, then restore if needed.',
        ],
    },
    {
        id: 'equations-theory',
        icon: Sigma,
        title: 'Equations & statistical theory',
        subtitle: 'Formulas behind the charts and analysis views',
        intro:
            'This section explains the main math in plain language: how baseline and percent change are defined, how environmental humidity is derived, what the separability score means, and how wide sensitivity tables are read.',
        implemented: [
            'Normalize: mean over your chosen X window, percent change from that mean; baseline selection persists when adding compares (see Normalize section)',
            'Aroma: median baseline, percent change from baseline, moving average, absolute humidity from T and RH',
            'Separability: score S from mean difference and variances (plus a small stability term ε)',
            'Sensitivity (wide tables): baseline R₀, response size, row-wise separability from spread bands, correlation r',
            'ML Studio: what PCA, t-SNE, and simple models do conceptually',
        ],
        steps: [],
        equationsAppendix: true,
    },
    {
        id: 'theory',
        icon: Info,
        title: 'Theory & metrics (reference)',
        subtitle: 'How to read the numbers',
        intro:
            'Short glossary. For full formulas see **Equations & statistical theory** above.',
        implemented: [
            'Baseline resistance (Ω): typical “at rest” level before or without target exposure; estimated from RFC/ambient/breath rows where applicable',
            'Sensitivity (% ΔR/R): magnitude of relative resistance change from baseline at response (sign convention depends on page—often largest negative excursion for chemiresistors)',
            'Separability S: mean separation between conditions relative to spread (variance-based); higher → easier to tell conditions apart',
            'Signal spread: within-condition variability (e.g. from σ_max − σ_min bands in wide-format data); lower → tighter repeatability',
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
            <p className="help-section-intro">
                {section.intro.split('**').map((part, j) =>
                    j % 2 === 1 ? <strong key={j}>{part}</strong> : part
                )}
            </p>

            {section.implemented && section.implemented.length > 0 && (
                <>
                    <h3 className="help-subheading">What is implemented</h3>
                    <ul className="help-list">
                        {section.implemented.map((item, i) => (
                            <li key={i}>{item}</li>
                        ))}
                    </ul>
                </>
            )}

            {section.equationsAppendix && <EquationsTheoryAppendix />}

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
                        Step-by-step instructions, feature lists, and an <strong>Equations &amp; statistical theory</strong> section with the main formulas explained in plain terms. All
                        data stays on your device.
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
