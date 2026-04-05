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
    Layers,
    Terminal,
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

/**
 * Comprehensive ML Studio deep-dive guide embedded into the Help page.
 * Covers: device overview, capture phases, feature extraction, training
 * pipelines v1/v2, synthetic data calibration, inference, and DS fundamentals.
 */
function MLStudioDeepDive() {
    return (
        <div className="ml-guide-wrapper">

            {/* ── 1. Device overview ───────────────────────────────────── */}
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">The FeNOse device</h3>
            <p className="help-eq-para">
                FeNOse is a breath-analysis instrument containing <strong>64 metal-oxide (MOx) gas sensors</strong> arranged in an 8 × 8 grid (columns A–H, rows 1–8, giving identifiers <code>A1</code>–<code>H8</code>). When a patient exhales slowly and steadily into the device, each sensor shifts its electrical resistance in response to the chemistry of the breath — primarily <strong>fractional exhaled nitric oxide (FeNO)</strong>, a validated biomarker for eosinophilic airway inflammation.
                Each measurement capture is saved as a CSV file with one row per time-step, 64 sensor-resistance columns, environmental readings (temperature, humidity, pressure), and an <code>event_name</code> column that labels each phase of the measurement.
            </p>

            {/* ── 2. Capture phases ────────────────────────────────────── */}
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Measurement phases</h3>
            <p className="help-eq-para">Every FeNOse capture contains three labeled phases:</p>
            <div className="ml-phase-grid">
                <div className="ml-phase-card ml-phase-ambient">
                    <span className="ml-phase-badge">Phase 1</span>
                    <strong className="ml-phase-name">AmbientSamplingRFC</strong>
                    <p className="ml-phase-desc">~100 rows in ambient room air. Establishes each sensor's resting resistance before any breath gas reaches the array.</p>
                </div>
                <span className="ml-phase-arrow">→</span>
                <div className="ml-phase-card ml-phase-feno">
                    <span className="ml-phase-badge">Phase 2</span>
                    <strong className="ml-phase-name">FeNOMeasurement</strong>
                    <p className="ml-phase-desc">~100 rows during active exhalation. Sensors respond to NO and other trace gases present in the breath sample.</p>
                </div>
                <span className="ml-phase-arrow">→</span>
                <div className="ml-phase-card ml-phase-window">
                    <span className="ml-phase-badge">Phase 3</span>
                    <strong className="ml-phase-name">FeNOWindow</strong>
                    <p className="ml-phase-desc">~15 rows of steady-state plateau. Captures the most stable NO signal with the lowest row-to-row noise — the key diagnostic window.</p>
                </div>
            </div>
            <div className="ml-callout ml-callout-tip">
                <strong>Why separate phases?</strong> Absolute sensor resistances drift with temperature and humidity. Measuring the <em>relative change</em> from ambient to breath (not the raw value) makes the feature independent of slow environmental drift and device-to-device baseline differences.
            </div>

            {/* ── 3. Feature extraction ────────────────────────────────── */}
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Feature extraction — from phases to a numeric vector</h3>
            <p className="help-eq-para">
                For each capture, the extractor collapses the three phases into a fixed-length vector the model can digest. Four features are computed per sensor (64 sensors × 4 = 256 per-sensor values), plus 6 global cross-sensor statistics and 3 environmental features — <strong>up to ~267 features total</strong>.
            </p>
            <div className="ml-table-wrap">
                <table className="ml-data-table">
                    <thead>
                        <tr>
                            <th>Prefix</th>
                            <th>Source phases</th>
                            <th>Formula</th>
                            <th>What it captures</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><code>nd_*</code></td>
                            <td>Ambient → FeNO</td>
                            <td>(FeNO mean − amb mean) / amb mean</td>
                            <td><strong>Normalised delta</strong> — fractional change from baseline; the primary NO-sensitivity signal</td>
                        </tr>
                        <tr>
                            <td><code>d_*</code></td>
                            <td>Ambient → FeNO</td>
                            <td>FeNO mean − amb mean (Ω)</td>
                            <td><strong>Raw delta</strong> — absolute resistance change; complements nd_ for sensors with very high or low baseline</td>
                        </tr>
                        <tr>
                            <td><code>fs_*</code></td>
                            <td>FeNOWindow std</td>
                            <td>Std dev of window-phase rows</td>
                            <td><strong>FeNO window noise</strong> — sensor stability during the plateau; high values indicate noisy or partially saturated sensors</td>
                        </tr>
                        <tr>
                            <td><code>wd_*</code></td>
                            <td>Window − Ambient</td>
                            <td>Window phase mean − ambient mean</td>
                            <td><strong>Window delta</strong> — plateau-level response; cross-validates nd_ using only the most stable rows</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p className="help-eq-para">
                Global features include the mean <code>nd_</code> across all 64 sensors, mean raw delta, and four cross-sensor spread statistics. Environmental features (<code>AQT0</code> temperature, <code>AQH0</code> humidity, <code>AQP0</code> pressure) help the model account for ambient conditions that shift sensor baselines.
            </p>

            {/* ── 4. Training pipelines ────────────────────────────────── */}
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Training pipelines</h3>
            <p className="help-eq-para">
                ML Studio supports two pipeline variants. Both end in the same type of neural network — a <strong>multilayer perceptron (MLP)</strong> implemented in TensorFlow.js — but differ in how features are selected, compressed, and how the ppb target is scaled before training.
            </p>

            <h4 className="ml-subhead-2">Version 1 — Top-K → Scale → MLP (log target)</h4>
            <div className="ml-pipeline-flow">
                <div className="ml-pipeline-step">~267 features<br/><small>per capture</small></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>Top-K selection</strong><small>rank by |corr(feat, log(ppb+1))|</small></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>StandardScaler</strong><small>subtract mean, divide σ</small></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>MLP</strong><small>predict log(ppb+1)</small></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>exp(x) − 1</strong><small>back to ppb</small></div>
            </div>
            <p className="help-eq-para">
                Log-transforming the target (log(ppb + 1)) compresses the upper range of the 0–100 ppb scale so the model minimises percentage error rather than raw absolute error. This is especially important near the clinical decision boundaries (~25 ppb and ~50 ppb), where a 5 ppb error matters far more than it does at 100 ppb.
            </p>

            <h4 className="ml-subhead-2">Version 2 — Top-K → Scale → PCA → MLP (scaled target)</h4>
            <div className="ml-pipeline-flow">
                <div className="ml-pipeline-step">~267 features</div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>Top-K selection</strong><small>rank by |corr(feat, ppb)|</small></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>StandardScaler</strong></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>PCA</strong><small>retain 95% variance</small></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>MLP</strong><small>predict ppb ÷ yMax</small></div>
                <span className="ml-pipeline-arrow">→</span>
                <div className="ml-pipeline-step"><strong>× yMax</strong><small>back to ppb</small></div>
            </div>
            <p className="help-eq-para">
                PCA is inserted after scaling to <em>decorrelate</em> sensor features. Because many MOx sensors respond similarly to NO, their <code>nd_</code> values are highly correlated — PCA collapses these into a smaller set of orthogonal components, reducing the MLP's input dimension and its tendency to overfit. The target is divided by the maximum training ppb (<code>yMax</code>), pushing it into the [0, 1] range, which generally produces a more stable training curve than an unbounded regression target.
            </p>

            {/* ── 5. MLP architecture ──────────────────────────────────── */}
            <h3 className="help-subheading">MLP architecture</h3>
            <p className="help-eq-para">
                The network runs entirely in the browser via <strong>TensorFlow.js</strong> — no server-side compute is required. Default architecture (all values configurable in the Training tab):
            </p>
            <ul className="help-list">
                <li><strong>Input layer:</strong> one neuron per retained feature (after Top-K and optional PCA, typically 20–40 inputs)</li>
                <li><strong>Hidden layer 1:</strong> 64 neurons, ReLU activation</li>
                <li><strong>Hidden layer 2:</strong> 32 neurons, ReLU activation</li>
                <li><strong>Output layer:</strong> 1 neuron, linear activation — predicts the transformed target (log ppb or ppb/yMax)</li>
                <li><strong>Optimiser:</strong> Adam (adaptive learning rate, default lr = 0.001)</li>
                <li><strong>Loss function:</strong> mean squared error (MSE) on the transformed target</li>
            </ul>
            <div className="ml-callout ml-callout-warn">
                <strong>Small-dataset caution:</strong> a default network with 64+32 hidden neurons has several thousand trainable parameters. The standard FeNOse dataset has only ~35 labelled captures — the model <em>will</em> overfit without sufficient training data. Synthetic augmentation (30–50 replicates per concentration level) is the primary mitigation.
            </div>

            {/* ── 6. Synthetic data pipeline ───────────────────────────── */}
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Synthetic data pipeline</h3>
            <p className="help-eq-para">
                Collecting real FeNOse captures is time-consuming. ML Studio's synthetic generator produces <em>physics-informed</em> captures for any target ppb value, using the same three-phase structure as a real measurement. Each synthetic capture inherits realistic noise and device variability derived from whatever real data exists in your workspace.
            </p>

            <h4 className="ml-subhead-2">Calibration parameters — 6 values per sensor</h4>
            <p className="help-eq-para">
                The generator is governed by 6 calibration parameters for each of the 64 sensors. These are computed automatically from labelled real captures in the workspace; if real data is unavailable for a sensor, the app falls back to device-batch defaults.
            </p>
            <div className="ml-table-wrap">
                <table className="ml-data-table">
                    <thead>
                        <tr>
                            <th>Parameter</th>
                            <th>Meaning</th>
                            <th>Estimated from real data as…</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><code>amb_med</code></td>
                            <td>Median ambient resistance (Ω)</td>
                            <td>Median of all ambient-phase readings across real captures</td>
                        </tr>
                        <tr>
                            <td><code>nd_slope</code></td>
                            <td>NO sensitivity — Δnd per ppb</td>
                            <td>OLS slope of normalised delta (nd) regressed against ppb across all real captures</td>
                        </tr>
                        <tr>
                            <td><code>amb_cv</code></td>
                            <td>Device-to-device baseline spread (log-normal σ)</td>
                            <td>Coefficient of variation of per-capture ambient medians</td>
                        </tr>
                        <tr>
                            <td><code>noise_cv</code></td>
                            <td>Within-phase electronic noise (σ as a fraction of baseline)</td>
                            <td>Median of per-capture within-phase std divided by amb_med</td>
                        </tr>
                        <tr>
                            <td><code>sens_cv</code></td>
                            <td>Capture-to-capture sensitivity jitter (σ of nd_slope multiplier)</td>
                            <td>Standard deviation of per-capture (nd/ppb) values relative to their mean</td>
                        </tr>
                        <tr>
                            <td><code>zero_std_nd</code></td>
                            <td>Zero-point offset noise (σ of nd at 0 ppb)</td>
                            <td>Std of nd values from 0 ppb captures only</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <h4 className="ml-subhead-2">Generation steps for one synthetic capture at target ppb</h4>
            <ol className="help-steps">
                <li>
                    <strong>Seed the PRNG:</strong> a deterministic <em>mulberry32</em> pseudo-random number generator is seeded from the user-supplied seed, producing reproducible augmentation data regardless of session or browser.
                </li>
                <li>
                    <strong>Sample per-device baseline spread:</strong> for each sensor, draw a log-normal multiplier using <code>amb_cv</code>. This simulates unit-to-unit variation in baseline resistance across different physical devices or measurement sessions.
                    <br/><small style={{color:'#64748b'}}>ambBase = amb_med × exp(N(0, amb_cv))</small>
                </li>
                <li>
                    <strong>Sample sensitivity jitter:</strong> scale <code>nd_slope</code> by a Gaussian multiplier with σ = <code>sens_cv</code> (~13%). This captures the fact that the same sensor's sensitivity to NO varies slightly from one breath capture to the next.
                    <br/><small style={{color:'#64748b'}}>effSlope = nd_slope × (1 + N(0, sens_cv))</small>
                </li>
                <li>
                    <strong>Sample zero-point offset:</strong> draw a small nd offset from N(0, <code>zero_std_nd</code>) to simulate drift in the sensor's zero reading — i.e., the nd value the sensor shows even at 0 ppb.
                </li>
                <li>
                    <strong>Generate ambient rows (~100):</strong> Gaussian noise around <code>ambBase</code> with σ = <code>noise_cv × ambBase</code> per sensor. These rows mimic Phase 1 of a real capture.
                </li>
                <li>
                    <strong>Generate FeNO rows (~100):</strong> for each row, compute the expected sensor value as{' '}
                    <code>ambBase × (1 + effSlope × ppb + zeroOffset) + noise</code>. The key driver is the <code>effSlope × ppb</code> term — how much the sensor shifts from baseline in response to NO.
                </li>
                <li>
                    <strong>Generate window rows (~15):</strong> same model as FeNO rows, but with slightly lower noise, representing the stable plateau phase.
                </li>
            </ol>
            <div className="ml-callout ml-callout-tip">
                <strong>Recommended augmentation strategy:</strong> generate <strong>30–50 synthetic replicates per concentration level</strong> (covering 0, 5, 10, 20, 50, 75, 100 ppb). Train exclusively on synthetic data and keep all 35 real captures as a <em>held-out test set</em>. This prevents real-data quirks from contaminating training and gives an honest estimate of generalisation performance.
            </div>

            {/* ── 7. Inference workflow ────────────────────────────────── */}
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Model inference workflow</h3>
            <ol className="help-steps">
                <li>Upload a FeNOse-style CSV capture to the workspace. It must contain sensor columns <code>A1</code>–<code>H8</code> and an <code>event_name</code> column with the three phase labels.</li>
                <li>Open <strong>ML Studio → Inference</strong> and select a saved model from the <code>Model/</code> folder. A model consists of a paired <code>*.json</code> (architecture + pipeline metadata) and <code>*.weights.bin</code> (trained weights).</li>
                <li>The app extracts features from the capture using the <em>same</em> feature extractor, Top-K indices, StandardScaler parameters, and (for v2) PCA components that were frozen at training time.</li>
                <li>The normalised feature vector is passed through the TensorFlow.js model to produce a single output — the transformed ppb prediction.</li>
                <li>The output is inverse-transformed (exp(x)−1 for v1; × yMax for v2) and displayed as the predicted FeNO concentration in ppb.</li>
            </ol>
            <div className="ml-callout ml-callout-warn">
                <strong>Pipeline lock-in:</strong> the scaler, PCA (if v2), and the list of selected feature indices are all stored inside the model JSON at training time. Changing any pipeline parameter (K, feature types, etc.) requires retraining. Running inference with a mismatched pipeline will silently produce incorrect predictions.
            </div>

            {/* ── 8. Data science fundamentals ─────────────────────────── */}
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Data science fundamentals</h3>

            <h4 className="ml-subhead-2">Error metrics — MAE and RMSE</h4>
            <p className="help-eq-para">
                After training, ML Studio reports two error metrics computed on the training split:
            </p>
            <ul className="help-list">
                <li>
                    <strong>MAE (Mean Absolute Error)</strong> — the average absolute difference between predicted and true ppb. Intuitive interpretation: an MAE of 4 ppb means predictions are off by 4 ppb on average. Treats all errors equally regardless of their magnitude.
                </li>
                <li>
                    <strong>RMSE (Root Mean Square Error)</strong> — the square root of the average squared error. Penalises large individual errors more heavily than MAE. An RMSE much larger than MAE suggests occasional large outlier predictions. For clinical FeNO use, large errors near diagnostic thresholds are more consequential, so RMSE is often the key metric to watch.
                </li>
            </ul>
            <MathBlock label="Error metrics">
                <MRow>
                    <Mi>MAE</Mi><Mo>=</Mo>
                    <Frac num={<>1</>} den={<>n</>}/>
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                        <sub className="help-math-sum-sub">i=1…n</sub>
                    </span>
                    <span className="help-math-abs">|</span>
                    <Mi>ŷ<sub>i</sub></Mi><Mo className="help-math-minus">−</Mo><Mi>y<sub>i</sub></Mi>
                    <span className="help-math-abs">|</span>
                </MRow>
                <MRow>
                    <Mi>RMSE</Mi><Mo>=</Mo>
                    <span style={{fontSize:'1.3em',lineHeight:1,verticalAlign:'middle',color:'#cbd5e1'}}>√</span>
                    <Frac num={<>1</>} den={<>n</>}/>
                    <span className="help-math-sum-wrap">
                        <span className="help-math-sum">∑</span>
                        <sub className="help-math-sum-sub">i=1…n</sub>
                    </span>
                    <Mo>(</Mo><Mi>ŷ<sub>i</sub></Mi><Mo className="help-math-minus">−</Mo><Mi>y<sub>i</sub></Mi><Mo>)</Mo>
                    <sup>2</sup>
                </MRow>
                <p className="help-math-caption">n = number of samples; ŷ = predicted ppb; y = true ppb</p>
            </MathBlock>

            <h4 className="ml-subhead-2">Overfitting and underfitting</h4>
            <div className="help-theory-box">
                <p className="help-theory-lead">The central challenge in supervised learning is finding the right model complexity:</p>
                <ul className="help-theory-list">
                    <li>
                        <strong>Underfitting:</strong> the model is too simple (or undertrained) to capture the signal. Training loss and test loss are both high. Fix: more epochs, larger network, better features.
                    </li>
                    <li>
                        <strong>Overfitting:</strong> the model memorises training data including its noise — training loss is low but test loss is high. The model fails on unseen captures. Fix: more data (synthetic augmentation), dropout regularisation, early stopping, or a smaller network.
                    </li>
                    <li>
                        <strong>The FeNOse situation:</strong> with only 35 real captures and an MLP with hundreds of parameters, overfitting is almost guaranteed without augmentation. The training loss curve falling while validation loss levels off or rises is the diagnostic signal to watch.
                    </li>
                </ul>
            </div>

            <h4 className="ml-subhead-2">Train / validation / test split</h4>
            <p className="help-eq-para">
                <strong>Training set:</strong> data the model sees and optimises its weights against.{' '}
                <strong>Validation set:</strong> data used to monitor generalisation during training and to choose hyperparameters (learning rate, K, network size). The model never trains directly on validation data, but choices made using it indirectly influence the final model.{' '}
                <strong>Test set:</strong> data held out entirely until the very end — never touched during training or hyperparameter search. Performance on the test set is the only honest estimate of real-world accuracy.
            </p>
            <div className="ml-callout ml-callout-info">
                <strong>FeNOse recommendation:</strong> hold all 35 real captures as the test set. Train only on synthetic data. This treats real data as the true evaluation benchmark rather than mixing it into the training pipeline.
            </div>

            <h4 className="ml-subhead-2">Feature selection — Top-K by correlation</h4>
            <p className="help-eq-para">
                Starting with 267 features and fewer training examples than features is dangerous — many features will be noise, and the model will learn spurious correlations. Top-K selection ranks all features by <strong>Pearson correlation with the target</strong> (log ppb for v1, raw ppb for v2) and retains the K highest-magnitude correlators. Because correlation is computed only on training examples, the test set remains uncontaminated.
            </p>
            <p className="help-eq-para">
                Typical K values: 20–50. Too small: useful features are discarded. Too large: noisy features overwhelm the signal. The optimal K can be found via cross-validation, or by monitoring validation loss as K is varied.
            </p>

            <h4 className="ml-subhead-2">StandardScaler — zero-mean, unit-variance normalisation</h4>
            <p className="help-eq-para">
                Raw sensor features span very different numerical ranges. <code>nd_</code> values are small fractions (typically −0.1 to +0.1), while <code>d_</code> values (raw Ω changes) can be hundreds or thousands. Feeding un-scaled features to a neural network causes some weights to dominate simply because their inputs are numerically larger. StandardScaler subtracts the per-feature training mean and divides by the per-feature training standard deviation, giving each feature a mean of 0 and a variance of 1. This normalisation is computed on training data only and applied identically to validation, test, and future inference data.
            </p>

            <h4 className="ml-subhead-2">Principal Component Analysis (PCA)</h4>
            <p className="help-eq-para">
                PCA finds the directions in feature space (principal components) along which data varies the most. The first component points in the direction of maximum variance; each subsequent component is orthogonal to all previous ones and captures the next largest variance. By keeping only the components that explain 95% of the total variance, PCA:
            </p>
            <ul className="help-list">
                <li>Removes redundancy — many FeNOse sensors respond similarly to NO, so their <code>nd_</code> features are correlated; PCA collapses these into fewer, uncorrelated components</li>
                <li>Reduces the MLP's input dimension, lowering parameter count and overfitting risk</li>
                <li>Produces uncorrelated inputs, which generally makes gradient descent converge faster and more reliably</li>
            </ul>
            <p className="help-eq-para">
                PCA is fit on the <em>training set only</em> and applied (transform, no refit) to validation, test, and inference data using the same component vectors.
            </p>

            <h4 className="ml-subhead-2">Log-transforming the target</h4>
            <p className="help-eq-para">
                FeNO concentrations range from 0 to ~100 ppb, but the clinically important boundaries are at ~25 ppb and ~50 ppb. Without transformation, MSE loss disproportionately penalises large errors at high ppb values (because (100−90)² = 100 while (25−15)² = 100 too, but the latter is diagnostically far more critical). Taking <code>log(ppb + 1)</code> maps the range to approximately 0–4.6, compressing the upper end and forcing the model to optimise something closer to percentage error — which is the medically meaningful quantity. The +1 ensures log(0) is defined and equals 0.
            </p>

            <h4 className="ml-subhead-2">Adam optimiser</h4>
            <p className="help-eq-para">
                Adam (Adaptive Moment Estimation) adapts the learning rate separately for each weight parameter based on estimates of the first and second moments of the gradient. Compared to vanilla stochastic gradient descent, Adam converges much faster on problems with sparse or noisy gradients — which is typical of small, augmented sensor datasets. Default hyperparameters (β₁ = 0.9, β₂ = 0.999, ε = 1×10⁻⁸) work well in most cases; the main tunable knob is the global learning rate (default: 0.001).
            </p>

        </div>
    );
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
                    <div style={{ marginBottom: '12px' }}>
                        <strong>Separability (per row, averaged):</strong>{' '}
                        <span className="help-math-greek">σ</span>
                        <sub>1</sub>, <span className="help-math-greek">σ</span>
                        <sub>2</sub> = (σ<sub>max</sub> − σ<sub>min</sub>)/2; v<sub>i</sub> = <span className="help-math-greek">σ</span>
                        <sub>i</sub>
                        <sup>2</sup>.
                    </div>
                    <MathBlock label="Row separability">
                        <MRow>
                            <Mi>S<sub>row</sub></Mi>
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
                    <p className="help-eq-note" style={{ marginTop: '8px' }}>
                        <strong>Physics Tip:</strong> When μ₁ ≈ μ₂, the sensor is "blind" to the gas change. When spread (v) is high, the sensor is "noisy." The best sensors have high μ separation and low variance.
                    </p>
                </li>
            </ul>

            <h3 className="help-subheading">Principal Component Analysis (PCA) — Variance Maximization</h3>
            <p className="help-eq-para">
                PCA is the fundamental cornerstone of <strong>Chemometrics</strong>. In a 64-sensor array, sensors close to each other often respond identically. PCA identifies the "Directions of Variation" and collapses the 64 sensors into a few "Principal Components" that capture 95% of the information.
            </p>
            <MathBlock label="PCA projection">
                <MRow>
                    <Mi><strong>z</strong></Mi><Mo>=</Mo>
                    <Mi><strong>V</strong><sub>:,1…d</sub><sup>T</sup></Mi>
                    <Mo>(</Mo>
                    <Mi><strong>x</strong></Mi><Mo className="help-math-minus">−</Mo><Mi><strong>μ</strong></Mi>
                    <Mo>)</Mo>
                </MRow>
                <p className="help-math-caption">
                    z = Compressed feature vector; V = Eigenvectors (Principal Directions); x = Scaled original features.
                </p>
            </MathBlock>

            <ul className="help-list help-eq-list" style={{ marginTop: '24px' }}>
                <li>
                    <strong>Other pages:</strong> Separability and Aroma PCA use their own statistics independently of ML Studio training. The <strong>t-SNE Explorer</strong> uses the
                    same <strong>per-file FeNOse feature vector</strong> as ML Studio (see the <strong>t-SNE Explorer</strong> section in this guide for the full file → features → point
                    pipeline).
                </li>
            </ul>

            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Fundamentals of Digital Olfaction</h3>
            <div className="help-theory-box">
                <p className="help-theory-lead"><strong>Why 64 Sensors?</strong></p>
                <p className="help-eq-para">
                    In biology, the mammalian nose doesn't have one "gold" sensor for each smell. Instead, it uses a large array of hundreds of <strong>semi-selective</strong> receptors. A single odorant molecule might trigger many different receptors to varying degrees, creating a unique <strong>combinatorial code</strong> (a fingerprint).
                </p>
                <p className="help-eq-para">
                    FeNOse mimics this by using 64 different metal-oxide (MOx) formulations. Some are highly sensitive to Nitric Oxide (NO), while others respond more to humidity, alcohols, or sulfur compounds. By analyzing the <em>entire array</em>, the ML model can "filter out" the background interference and isolate the true FeNO signal.
                </p>
            </div>
        </div>
    );
}

/**
 * t-SNE Explorer: end-to-end path from CSV file → feature vector → 2D/3D point.
 * Aligns with extractFenoseFeaturesFromRows (fenoseModel.js) and TSNEPage.jsx behaviour.
 */
function TSNEExplorerHelpDeepDive() {
    return (
        <div className="ml-guide-wrapper">
            <hr className="ml-section-sep" />
            <h3 className="help-subheading">What one dot on the plot represents</h3>
            <p className="help-eq-para">
                In the <strong>t-SNE Explorer</strong>, <strong>each point is exactly one workspace file</strong> — typically one FeNOse-style CSV capture (one measurement at one
                nominal gas challenge). The horizontal/vertical (or 3-D) position is produced only by the t-SNE algorithm from that file&apos;s <strong>feature vector</strong>. The
                plot does <strong>not</strong> place points by concentration or by AU id; those are shown visually as <strong>dot size</strong> (larger = higher parsed ppb) and{' '}
                <strong>colour</strong> (one stable colour per aroma unit / synthetic), and in tooltips.
            </p>

            <hr className="ml-section-sep" />
            <h3 className="help-subheading">How concentration is tied to a file (before t-SNE)</h3>
            <p className="help-eq-para">
                Concentration is <strong>read from the filename</strong>, not inferred from sensor data. The app looks for a pattern such as <code>25ppb</code>,{' '}
                <code>10 ppb</code>, or <code>0.5ppb</code> in the file basename (case-insensitive). That number is the <strong>label</strong> attached to the capture for colouring
                by size, filtering, and legends. Files without a parsable <code>…ppb…</code> token are <strong>excluded</strong> from t-SNE in this view. If two different experiments
                share the same nominal ppb in the name, they still produce <strong>two separate points</strong> (two files → two vectors → two embeddings).
            </p>

            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Feature extraction — every sensor element (A1–H8)</h3>
            <p className="help-eq-para">
                For each eligible CSV, the app parses rows and groups them by <code>event_name</code>, using the same phase model as ML Studio:{' '}
                <strong>AmbientSamplingRFC</strong> (ambient baseline), <strong>FeNOMeasurement</strong> (breath / challenge phase), and optionally{' '}
                <strong>FeNOWindow</strong> (short steady plateau). If ambient or FeNO phases are missing, that file is skipped.
            </p>
            <p className="help-eq-para">
                For <strong>each</strong> of the 64 grid cells <code>A1</code> through <code>H8</code>:
            </p>
            <ul className="help-list help-eq-list">
                <li>
                    <strong>ambMean</strong> — mean resistance of that cell over all <em>ambient</em> rows.
                </li>
                <li>
                    <strong>fenoMean</strong> — mean resistance over <em>FeNOMeasurement</em> rows for that cell.
                </li>
                <li>
                    <strong>fenoStd</strong> — standard deviation of resistances in the FeNO phase (stability / noise during the challenge).
                </li>
                <li>
                    <strong>windowMean</strong> — mean over <em>FeNOWindow</em> rows if present; otherwise 0 for window-derived features.
                </li>
            </ul>
            <p className="help-eq-para">From those, four numbers per sensor are stored as features (names match ML Studio):</p>
            <ul className="help-list help-eq-list">
                <li>
                    <code>d_A1</code> … <code>d_H8</code>: <strong>fenoMean − ambMean</strong> (raw ΔR for that element).
                </li>
                <li>
                    <code>nd_A1</code> … <code>nd_H8</code>: <strong>(fenoMean − ambMean) / (|ambMean| + 10⁻⁶)</strong> — normalised fractional change from baseline.
                </li>
                <li>
                    <code>fs_A1</code> … <code>fs_H8</code>: <strong>fenoStd</strong> for that element.
                </li>
                <li>
                    <code>wd_A1</code> … <code>wd_H8</code>: <strong>windowMean − ambMean</strong> when a window exists; else 0.
                </li>
            </ul>
            <p className="help-eq-para">
                <strong>Cross-sensor summaries</strong> are added once per file: mean/max/min/std of all 64 deltas, and mean/std of all 64 <code>nd_*</code> values.{' '}
                <strong>Environmental</strong> features are the file-wide means of <code>AQT0</code>, <code>AQH0</code>, and <code>AQP0</code> (temperature, humidity, pressure), when
                those columns exist. Altogether this is the same high-dimensional description used for FeNOse ML features (on the order of <strong>~260+ numbers per file</strong>).
            </p>

            <hr className="ml-section-sep" />
            <h3 className="help-subheading">Building the matrix and running t-SNE</h3>
            <ol className="help-steps">
                <li>
                    <strong>Align dimensions:</strong> feature names from every file are unioned; keys are sorted. Each file becomes one row; missing keys are filled with 0 so every row
                    has the same length.
                </li>
                <li>
                    <strong>Standardise:</strong> each column is z-scored (subtract mean, divide by standard deviation) across the points included in that t-SNE run so no single
                    feature dominates purely because of scale.
                </li>
                <li>
                    <strong>t-SNE:</strong> the library maps each high-dimensional row to <strong>2 or 3 coordinates</strong> (your choice in the UI). Settings such as perplexity,
                    iterations, and learning rate (ε) control how strongly local neighbourhoods are preserved. Nearby points in the plot mean “similar feature vectors,” not necessarily
                    the same ppb or the same device.
                </li>
                <li>
                    <strong>Multiple views:</strong> the app can compute a <em>combined</em> embedding (all included files) and separate embeddings per AU (each AU&apos;s real files plus
                    optional synthetic points). Progressive “add one AU at a time” re-runs t-SNE on a growing subset so you can see how the joint layout changes.
                </li>
            </ol>

            <div className="ml-callout ml-callout-tip">
                <strong>Summary chain:</strong> one labelled CSV → phase-wise means/stds per <code>A1</code>–<code>H8</code> → fixed feature dictionary → sorted numeric vector →
                column-wise normalisation → t-SNE → <strong>one (x,y)</strong> or <strong>(x,y,z)</strong> point. The <strong>ppb in the filename</strong> labels that point for size
                and filters; it is <em>not</em> an input coordinate to t-SNE.
            </div>
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
        subtitle: 'The Digital Olfaction Workspace',
        intro:
            'NozePlot (NozePlot4) is a next-generation analytics platform for **Digital Olfaction**—the science of converting chemical signals into digital insights. It provides a browser-based, privacy-first environment for processing high-dimensional sensor data.',
        fundamentals: [
            '**The Sensing Principle:** Most sensors in the app are "Chemiresistors." They change their electrical resistance when gas molecules adsorb onto their surface.',
            '**Browser-First Compute:** By running all logic (including ML) locally, we ensure your proprietary chemical data never leaves your machine, while providing a hardware-accelerated UI.',
            '**Data Privacy:** Zero cloud-storage of your CSV files ensures compliance with strict research and IP requirements.',
        ],
        implemented: [
            'Multi-file workspace with folders, search, and compare selection',
            'CSV and Excel (.xlsx / .xls) import and parsing',
            'Session save/restore via .noze workspace files',
            '**AU capture:** live USB serial capture from supported aroma units (Chrome / Edge)',
        ],
        steps: [
            'On first launch, enter your display name (stored locally).',
            'Upload files or a folder from the sidebar; select a main file and optionally add comparison files.',
            'Open the page you need from the sidebar (Dashboard, Normalize, Aroma, etc.).',
        ],
    },
    {
        id: 'dashboard',
        icon: LayoutDashboard,
        title: 'Dashboard',
        subtitle: 'Raw Time-Series Analysis',
        intro:
            'The Dashboard is your primary window into the **raw physics** of the experiment. It visualizes the absolute electrical state of every sensor in the array simultaneously.',
        fundamentals: [
            '**Absolute Resistance (Ω):** This is the raw "at-rest" value of a sensor. It depends on the sensor\'s material lot, age, and temperature.',
            '**Baseline Drift:** Sensors naturally drift over minutes or hours. The dashboard helps you identify if a sensor has "stabilized" before starting a measurement.',
            '**Cross-Sensor Correlation:** High-quality arrays show synchronous movement across related sensors. Random "spikes" in one sensor usually indicate electrical noise rather than chemical signal.',
        ],
        implemented: [
            'Automatic X-axis detection (date/time/timestamp vs sample index)',
            'Grid of mini charts per numeric series; click to focus and zoom',
            'Comparison overlay: merge multiple files by matching time or index',
            'Interactive brush and wheel zoom for high-resolution inspection',
        ],
        steps: [
            'Select a main file in the sidebar.',
            'Optionally add comparison files and pick series from the compare UI.',
            'Click a small chart to open the zoomable single-chart view.',
        ],
    },
    {
        id: 'normalize',
        icon: Activity,
        title: 'Normalize',
        subtitle: 'The Physics of Relative Response',
        intro:
            'In chemical sensing, **absolute values are deceptive**. Normalization converts raw resistance into a **dimensionless ratio**, which is the fundamental unit of chemical sensitivity.',
        fundamentals: [
            '**Why dR/R?** A sensor shifting from 10kΩ to 9kΩ (10% drop) is physically equivalent to a sensor of the same type shifting from 100kΩ to 90kΩ. Normalization removes the "baseline bias" and allows you to compare different sensors directly.',
            '**Fractional Change:** By calculating `(Current - Baseline) / Baseline`, we isolate the chemical interaction from the electronic background.',
            '**Thermal Stability:** Because baseline windows usually occur at the start of a run, normalization "zeros out" the impact of ambient temperature at the moment the test began.',
        ],
        implemented: [
            'Interactive baseline selection via horizontal drag (highlighted band)',
            'Automatic concentration parsing and color-coordinated traces',
            'Moving average and Gaussian smoothing to enhance Signal-to-Noise Ratio (SNR)',
            'Recovery filtering to remove "tail" data and focus on the peak response',
        ],
        steps: [
            'Open **Normalize** and drag on the chart to set the baseline interval.',
            'Add comparison files; the baseline window is automatically applied to all.',
            'Toggle between "Normalized" and "Raw" to see the impact of the baseline shift.',
        ],
    },
    {
        id: 'aroma',
        icon: LineChart,
        title: 'Aroma analysis',
        subtitle: 'Pattern Recognition & Fingerprinting',
        intro:
            'Aroma analysis moves from looking at single sensors to looking at the **Shape of the Array**. This is where we extract the "chemical fingerprint" of a sample.',
        fundamentals: [
            '**Combinatorial Sensing:** We don\'t rely on one "best" sensor. Different chemical elements (analytes) produce different <em>patterns</em> across the 64-sensor grid.',
            '**Phase Truncation:** By focusing only on the "Window" phase (the steady-state plateau), we remove the kinetic rise-time noise and get a more stable estimate of concentration.',
            '**Environmental Decoupling:** Uses temperature and humidity data to compute **Absolute Humidity (g/m³)**, which is often a better predictor of sensor interference than Relative Humidity.',
        ],
        implemented: [
            'Batch pipeline processing for multiple files simultaneously',
            'Automatic RFC (Reference) baseline extraction',
            'Plots for Time-series, Monotonicity, and Environmental Overlays',
            'PNG export with axes and labels for report generation',
        ],
        steps: [
            'Select files and adjust pipeline settings (filtering, smoothing).',
            'Run **Run Pipeline & Plot** to generate the analysis suite.',
            'Use the "Folder Compare" view for side-by-side batch evaluation.',
        ],
    },
    {
        id: 'separability',
        icon: Target,
        title: 'Separability analysis',
        subtitle: 'Metric of Discrimination Power',
        intro:
            'Separability asks the core question: **Can we actually see the difference?** It provides a statistical score for how well an element distinguishes between two states.',
        fundamentals: [
            '**Signal-to-Spread Ratio:** A high "Signal" (difference in means) is useless if the "Noise" (variance) is higher. Separability penalizes noisy data.',
            '**The Epsilon Term (ε):** A small stability factor added to prevent division by zero when sensors are perfectly stable, ensuring robust scoring.',
            '**Discriminative Power:** Use this to rank your sensors. High-separability sensors are candidates for "Top-K" feature selection in ML models.',
        ],
        implemented: [
            'Pairwise separability heatmaps and radar views',
            'Variance-aware comparison between concentrations',
            'Statistical ranking of sensors based on discrimination performance',
        ],
        steps: [
            'Load multiple concentrations into the workspace.',
            'Open **Separability** to see which sensors are the most "honest" reporters of gas change.',
        ],
    },
    {
        id: 'ml-studio',
        icon: Brain,
        title: 'ML Studio',
        subtitle: 'Advanced Prediction & Generalization',
        intro:
            'ML Studio uses Neural Networks to map complex sensor patterns to precise gas concentrations (ppb). It solves the "Cross-Sensitivity" problem using non-linear math.',
        fundamentals: [
            '**The Challenge of "Small Data":** Biological data is expensive to collect. We use **Synthetic Augmentation** to teach the model about variance without needing thousands of real human samples.',
            '**Dimensionality Reduction (PCA):** In a 64-sensor array, many sensors are redundant. PCA collapses these into "Principal Components," preventing the model from "overfitting" on noise.',
            '**Log-Space Optimization:** We train models to minimize relative error (log-space) rather than absolute error, because a 5 ppb error at low levels is more critical than at high levels.',
        ],
        implemented: [
            'Training pipelines (v1: Correlation-based, v2: PCA-based)',
            'Local TensorFlow.js model training and weights management',
            'Physics-informed synthetic data generator with calibration cloning',
            'Inference engine for real-time ppb prediction on new CSVs',
        ],
        steps: [
            'Generate 30-50 synthetic replicates per concentration to "pre-train" your model.',
            'Run the Training pipeline and watch the Loss Curve.',
            'Use the Inference tab to validate your model against high-quality real samples.',
        ],
        CustomContent: MLStudioDeepDive,
    },
    {
        id: 'tsne-explorer',
        icon: Layers,
        title: 't-SNE Explorer',
        subtitle: 'From each CSV to one point in the embedding',
        intro:
            'The t-SNE page visualises **similarity between whole captures**: each workspace file with a **ppb label in the filename** becomes one point. Position comes from **t-SNE of FeNOse-style features** (same per-sensor physics as ML Studio); **colour** identifies the aroma unit; **dot size** reflects the parsed **ppb** label.',
        fundamentals: [
            '**One file → one vector → one point:** phases (ambient / FeNO / window) are collapsed into ~260+ features per sensor grid and environment, then embedded in 2D or 3D.',
            '**Concentration is a label, not a coordinate:** ppb is read from the name (e.g. `25ppb`); t-SNE only sees the numeric feature vector.',
            '**Per element (A1–H8):** for each cell the app uses ambient mean, FeNO mean and std, window-vs-ambient delta, and normalised delta (`nd_*`) — the same family of features documented under ML Studio.',
        ],
        implemented: [
            'Filename ppb parsing and AU id parsing for colour and progressive multi-AU builds',
            'Optional synthetic captures (same feature pipeline) saved under FeNOse_synthetic/',
            '2D/3D toggle with re-embedding; concentration hide/show; stepwise “add AU” recomputation',
        ],
        steps: [
            'Add PPB-labelled FeNOse-style CSVs to the workspace (`Xppb` in the basename).',
            'Open **t-SNE Explorer** from the sidebar, set options if needed, and run **Run t-SNE**.',
            'Use the legend: AU colours, concentration filter, and (with several AUs) progressive controls to grow the combined plot one unit at a time.',
        ],
        CustomContent: TSNEExplorerHelpDeepDive,
    },
    {
        id: 'recovery',
        icon: TrendingUp,
        title: 'Recovery analysis',
        subtitle: 'Adsorption & Desorption Kinetics',
        intro:
            'Sensor "Recovery" is the time it takes for gas molecules to unbind from the sensor surface. This section analyzes the **speed and completeness** of that return to baseline.',
        fundamentals: [
            '**Hysteresis:** Sensors often return to baseline slower than they rose. This "memory effect" is a critical factor in how quickly you can run the next test.',
            '**Drift Mapping:** By looking at the "post-exposure" level, we can calculate the drift or "poisoning" of the sensor material.',
            '**Kinetic Constants:** The shape of the recovery curve (exponential decay) can reveal the binding energy of the gas to the sensor surface.',
        ],
        implemented: [
            'Exposure vs. recovery phase identification using optional keywords (defaults match FeNOse-style phases)',
            '`FeNOWindow` is treated as post-breath idle, not a separate gas challenge; trials anchor on `FeNOMeasurement` (or your keyword)',
            'Chrono-plots showing return-to-base dynamics over multiple trials',
            'Environmental tracking to see if humidity spikes delay sensor recovery',
            'Analysis uses the **main file + comparison picks** when set; otherwise all labelled workspace captures',
        ],
        steps: [
            'Select a **main** CSV (and add **compare** files if you want a multi-trial batch). Or leave selection empty to scan all known workspace files.',
            'Open **Drift Map** (Baseline Drift & Recovery). Leave **Exposure keyword** empty for auto-detect, or set a substring (e.g. `measurement` for FeNO breath only; use `window` if you need `FeNOWindow` explicitly).',
            'Set **Recovery keyword** if your logs use a custom recovery phase name (default `recovery`).',
            'Click **Analyze baseline drift**, then use **Chronological Plot** for time-resolved recovery.',
        ],
    },
    {
        id: 'dilution',
        icon: FlaskConical,
        title: 'Dilution math',
        subtitle: 'Mastering the Gas Mix',
        intro:
            'Precision sensing requires precision sources. This tool handles the mass-balance math needed to create specific gas concentrations in the lab.',
        fundamentals: [
            '**Conservation of Mass:** Flow rate math assumes that gas molecules are neither created nor destroyed during mixing.',
            '**MFC Scaling:** Mass Flow Controllers (MFCs) are often calibrated for N2. The tool helps you calculate the correct setpoints for varied carrier gases.',
            '**Concentration Scaling:** `C1V1 = C2V2` — the fundamental law of dilution used to calculate the final target ppb.',
        ],
        implemented: [
            'Multi-stage gas dilution calculator',
            'Support for Mass Flow Controller (MFC) setpoint derivation',
            'Common gas constants for correction factors',
        ],
        steps: [
            'Enter your source tank concentration and target ppb.',
            'The tool provides the flow rates needed for your dilution system.',
        ],
    },
    {
        id: 'gas-design',
        icon: Network,
        title: 'Gas system design',
        subtitle: 'Fluidic Architecture',
        intro:
            'The physical "plumbing" of a gas system impacts the signal. This editor helps you document the topology of your delivery system.',
        fundamentals: [
            '**Dead Volume:** Unused space in pipes causes "smearing" of the gas signal. Mapping your system helps identify slow-response bottlenecks.',
            '**Flow Path Topology:** Understanding where pressure drops occur and how gas reaches the sensor array is critical for troubleshooting "laggy" data.',
            '**Documenting the Rig:** A stable rig is a stable signal. Use the diagram to version your experimental setups.',
        ],
        implemented: [
            'Node-based editor (React Flow) for plumbing diagrams',
            'Configurable connectors for MFCs, Valves, Tanks, and Sensors',
            'Visual documentation of experimental setup',
        ],
        steps: [
            'Drag nodes from the palette to model your mass-flow rig.',
            'Connect components to show the flow path from tanks to the array.',
        ],
    },
    {
        id: 'manufacturing',
        icon: Factory,
        title: 'Manufacturing variation',
        subtitle: 'Repeatability & Quality Control',
        intro:
            'Every sensor is slightly different. This view quantifies the "Batch Effect" across hundreds of sensors or dozens of devices.',
        fundamentals: [
            '**Lot Variation:** Differences in ink thickness or firing temperature cause "Lot-to-Lot" variation.',
            '**Coefficient of Variation (CV):** A standard measure of precision. Lower CV means your sensor process is more stable and repeatable.',
            '**Statistical Envelopes:** By looking at the Min/Max bands, you can set "Gating" criteria to reject bad sensors before they reach the customer.',
        ],
        implemented: [
            'Variation summaries across files and concentration buckets',
            'CV calculations per element across multiple runs',
            'Statistical spread visualizations (error bars, box summaries)',
        ],
        steps: [
            'Select a large batch of baseline files.',
            'Run analysis to identify "outlier" sensors that fall outside the normal spread.',
        ],
    },
    {
        id: 'aroma-unit-capture',
        icon: Usb,
        title: 'AU capture',
        subtitle: 'Real-Time Hardware Interfacing',
        intro:
            'Live data acquisition directly from aroma-unit (AU) hardware over USB serial. Supports multiple device generations — from compact SiAC32 units to the 64-sensor SiAC64 and the passive GEN3 CSV-streaming AU — all within the browser via the Web Serial API (Chrome / Edge only).',
        fundamentals: [
            '**Device profiles:** the app ships with four profiles — `SiAC32-V2` (JSON stream, 115200 baud), `SiAC64 v0.3 RPC` (TELEMETRY JSON-RPC, 115200 baud, with piezo pump control), and `GEN3 AU` (passive CSV/TSV stream, fixed 9600 baud). Select the profile that matches your hardware before connecting.',
            '**Auto-scan / probe:** clicking "Scan for AU" sends a lightweight telemetry probe to every linked port and classifies the response automatically — no manual profile guessing needed for SiAC32/SiAC64 devices.',
            '**Stream modes:** SiAC32 and SiAC64 devices emit newline-delimited JSON objects; GEN3 AU emits raw comma- or tab-delimited CSV rows. The parser switches automatically based on the selected profile.',
            '**Capture sequence:** define a named sequence of timed events (e.g. Baseline 60 s → FeNOMeasurement 120 s → Recovery 60 s). Each row is tagged with its `event_name` so the file integrates directly with Aroma analysis and ML Studio.',
            '**Pump control (SiAC64):** set the piezo pump flow rate (CCM) and telemetry period (ms) from the UI without needing a separate serial terminal.',
            '**Multi-device capture:** link and record from several AUs simultaneously; each device saves to its own folder named after its serial number.',
        ],
        implemented: [
            'Web Serial API integration (Chrome / Edge)',
            'Device profiles: SiAC32-V2 · SiAC64 v0.3 RPC · GEN3 AU (9600 baud CSV)',
            'Auto-scan port probe with automatic SiAC32 / SiAC64 classification',
            'Configurable named capture sequence with per-event durations',
            'Multi-AU parallel recording — each AU saved to its own workspace subfolder',
            'SiAC64 piezo pump flow and telemetry-period control via RPC',
            'Real-time row preview and parse-error counter during capture',
            'Auto-save CSV to workspace on capture end; custom event-name library',
        ],
        steps: [
            'Click **Link USB device** to grant browser access to the port, then select the matching **Device profile** (or leave on SiAC64 and click **Scan for AU** to auto-detect).',
            'Build your **capture sequence**: add events, set each duration, name them (e.g. Baseline, FeNOMeasurement).',
            'For SiAC64: optionally set the **telemetry period** (ms) and **pump flow** (CCM) before starting.',
            'Click **Start capture** — data streams in real time; the file is saved automatically to the device\'s workspace subfolder when the sequence ends.',
            'To record from several devices at once, link all ports first, then enable **Multi-AU capture** and select the units to include.',
        ],
    },
    {
        id: 'serial-monitor',
        icon: Terminal,
        title: 'Serial monitor',
        subtitle: 'General-Purpose USB Serial Terminal',
        intro:
            'A lightweight, browser-based serial terminal for any USB device — not just aroma units. Useful for debugging firmware, logging raw UART output, or sending commands to embedded systems, all without leaving the app.',
        fundamentals: [
            '**Web Serial API:** runs entirely in the browser (Chrome / Edge); no drivers or native apps required. The browser prompts the user to select a port; the app then reads and writes bytes directly.',
            '**Port identification:** once a device is linked, the monitor shows its USB Vendor ID (VID) and Product ID (PID) so you can confirm you\'ve picked the right port.',
            '**Baud rate flexibility:** supports the eight most common UART rates — 9600, 19200, 38400, 57600, 115200, 230400, 460800, and 921600 bps — selectable before connecting.',
            '**Send & receive:** type any text into the send panel and append no extra bytes, a line feed (LF), or CR+LF — matching whatever your device expects. Keyboard shortcut Ctrl/⌘+Enter sends immediately.',
            '**Timestamped log:** every incoming line is captured with an ISO-8601 timestamp. The buffer holds up to 4000 lines; older lines are trimmed automatically to stay responsive.',
        ],
        implemented: [
            'Web Serial API port linking, refresh, connect, and disconnect',
            'VID / PID display for connected USB devices',
            'Baud rate selector: 9600 · 19200 · 38400 · 57600 · 115200 · 230400 · 460800 · 921600',
            'UART send panel with configurable line ending (none / LF / CRLF)',
            'Live scrolling log with up to 4000 timestamped lines',
            'Save log as **CSV** (timestamp column + one column per delimited field) or **TXT** (tab-separated timestamp + raw line)',
            'Clear log and status indicator (connected baud rate / disconnected)',
        ],
        steps: [
            'Click **Link USB device** and select the port in the browser dialog. Click **Refresh** if the device was plugged in after the page loaded.',
            'Choose the correct **Baud rate** for your device, then click **Connect**.',
            'Incoming data appears in the log panel in real time. To send a command, type it in the send box and press **Send** (or Ctrl/⌘+Enter). Choose the line ending your firmware expects.',
            'After disconnecting, click **Save CSV** or **Save TXT** to export the timestamped log to your workspace.',
        ],
    },
    {
        id: 'equations-theory',
        icon: Sigma,
        title: 'Equations & statistical theory',
        subtitle: 'Deep-Dive: The Math Behind the Insights',
        intro:
            'This logic-centric section explains the exact mathematical definitions used throughout the app—from Pearson correlations to sensor slopes.',
        implemented: [
            'Normalize: fractional vs percent change definitions',
            'Aroma: moving average, absolute humidity, and median-based baselines',
            'Separability: detailed S-score formula with unbiased variance',
            'ML Studio: v1/v2 pipelines and PCA eigenvectors',
            't-SNE Explorer: FeNOse feature extraction per A1–H8, matrix normalisation, and t-SNE embedding (see the t-SNE Explorer guide section)',
        ],
        steps: [],
        equationsAppendix: true,
    },
    {
        id: 'workspace',
        icon: FolderOpen,
        title: 'Workspace & files',
        subtitle: 'Project Management Basis',
        intro:
            'Your workspace is a **Stateful Environment**. It preserves your analysis context across browser refreshes using LocalStorage and IndexedDB.',
        fundamentals: [
            '**Persistent State:** Settings like sensor names, filter windows, and selected models are saved to your browser database.',
            '**.noze Archives:** These files don\'t just contain data—they contain the "Analysis Session," including which files were being compared.',
            '**File Immutability:** The app never "edits" your original CSV files; it creates "virtual views" of the data to preserve the original findings.',
        ],
        implemented: [
            'Folder-based organization and batch file export',
            'Session Save/Restore via binary `.noze` snapshots',
            'Direct Excel to CSV conversion in the browser',
        ],
        steps: [
            'Use folders to group replicates or concentrations.',
            'Download a `.noze` session at the end of the day to backup your progress.',
        ],
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

            {section.fundamentals && section.fundamentals.length > 0 && (
                <div className="help-fundamentals-box">
                    <h3 className="help-subheading">Scientific Basis & Fundamentals</h3>
                    <ul className="help-list fundamentals-list">
                        {section.fundamentals.map((item, i) => (
                            <li key={i}>
                                {item.split('**').map((part, j) =>
                                    j % 2 === 1 ? <strong key={j}>{part}</strong> : part
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {section.implemented && section.implemented.length > 0 && (
                <>
                    <h3 className="help-subheading">Features Included</h3>
                    <ul className="help-list">
                        {section.implemented.map((item, i) => (
                            <li key={i}>
                                {item.split('**').map((part, j) =>
                                    j % 2 === 1 ? <strong key={j}>{part}</strong> : part
                                )}
                            </li>
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

            {/* Optional deep-dive component for sections that need rich content */}
            {section.CustomContent && <section.CustomContent />}
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
