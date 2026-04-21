# Flow Lab — Technical Reference

A comprehensive guide to the physics, numerical methods, geometry pipeline,
and post-processing of the **Flow Lab** module in NozePlot. The document
is written for engineers designing gas-delivery / headspace units for
aroma-sensor chips and for anyone who needs to interpret its output
critically.

> **TL;DR.** Flow Lab solves 2-D incompressible viscous flow (Navier–
> Stokes) via a Lattice Boltzmann Method (LBM) D2Q9 BGK solver, and
> optionally couples a passive-scalar advection–diffusion equation for
> an aroma analyte. Geometry is drawn as closed polygons with per-edge
> boundary conditions. Sensors record near-wall concentration and
> velocity traces from which classical response metrics
> ($t_{10}, t_{50}, t_{90}$, FWHM, AUC) are derived.

---

## 1. Scope and intent

Flow Lab is built to answer **design questions** for aroma-sensor
chips, headspace sampling units, and any microfluidic gas-introduction
device where you want to know:

- How does gas flow through the device at steady state?
- Where are dead zones / recirculation pockets?
- How fast does an aroma pulse reach the sensor?
- What dose does each sensor receive?
- Is the sensor response time limited by flow or by diffusion?

It is **not** a full CFD validation tool. Values should be read as
_well-calibrated order-of-magnitude estimates_ for comparing design
variants. For absolute agreement with experiment at the percent level,
use a validated 3-D CFD code (COMSOL, OpenFOAM, Fluent).

### 1.1 Physical regime of validity

| Quantity | Regime | Notes |
|---|---|---|
| Reynolds number | $\mathrm{Re} \lesssim 2000$ | Laminar; no turbulence model |
| Mach number | $\mathrm{Ma} < 0.1$ | Incompressible limit; `TARGET_U_LB = 0.05` |
| Knudsen | $\mathrm{Kn} \ll 0.01$ | Continuum hypothesis; no rarefaction |
| Temperature / pressure | Isothermal, isobaric | No buoyancy, no compressibility |
| Gravity | Neglected | 2-D horizontal channel assumed |

---

## 2. Governing physics

### 2.1 Mass conservation (continuity)

For an incompressible Newtonian fluid:

$$
\nabla \cdot \mathbf{u} = 0
$$

where $\mathbf{u} = (u_x, u_y)$ is the velocity field in m/s.

### 2.2 Momentum conservation (Navier–Stokes)

$$
\frac{\partial \mathbf{u}}{\partial t}
+ (\mathbf{u} \cdot \nabla)\mathbf{u}
= -\frac{1}{\rho}\nabla p + \nu \nabla^2 \mathbf{u}
$$

- $\rho$ — gas density (kg/m³)
- $p$ — pressure (Pa)
- $\nu = \mu / \rho$ — kinematic viscosity (m²/s)

For air at 25 °C, 1 atm: $\rho \approx 1.184\ \mathrm{kg/m^3}$,
$\nu \approx 1.562 \times 10^{-5}\ \mathrm{m^2/s}$. Values are stored per-gas in
`src/flowlab/gases.js`.

### 2.3 Passive scalar transport (aroma species)

$$
\frac{\partial c}{\partial t} + \mathbf{u}\cdot\nabla c = D\,\nabla^2 c
$$

where $c(x,y,t)$ is the **dimensionless concentration** (normalized
to the inlet concentration $c_0 = 1$), and $D$ is the binary gas-phase
diffusivity (m²/s). The solver treats species as a _passive scalar_
— it rides the flow field without affecting it. This is accurate when:

1. Analyte dilution is low (no density feedback).
2. Isothermal conditions (no Soret effect).
3. No heterogeneous reactions at the wall.

For the aroma-sensor regime these assumptions are essentially always
valid.

### 2.4 Boundary conditions supported

| Tag | Mathematical BC | Notes |
|---|---|---|
| `wall` | $\mathbf{u} = 0$ and $\hat{n}\cdot\nabla c = 0$ | No-slip + zero-flux |
| `inlet` | $\mathbf{u} = U \hat{n}_\mathrm{in}$, $c = c_\mathrm{pulse}(t)$ | Velocity-driven; pulse shapes in §8 |
| `outlet` | $\partial \mathbf{u}/\partial \hat{n} = 0$, $\partial c/\partial \hat{n} = 0$ | Zero-gradient (Neumann) |
| `sensor` | $\mathbf{u} = 0$ (wall) + record near-wall $c$ and $\|\mathbf{u}\|$ | Wall + probe |

`sensor` is **physically identical** to `wall` for the solver; the
difference is only that sensor edges collect time-series data.

---

## 3. Non-dimensional groups

Defined and displayed live in the right panel.

### 3.1 Reynolds number

$$
\mathrm{Re} = \frac{U L}{\nu}
$$

$L$ is the longest axis of the domain bounding box (mm) converted to m.
Measures inertia vs. viscous forces. Transition to turbulence in
straight ducts is around $\mathrm{Re} \sim 2300$; the solver has no
turbulence model so don't push above ≈2000.

### 3.2 Schmidt number

$$
\mathrm{Sc} = \frac{\nu}{D}
$$

Ratio of momentum to mass diffusivity. For aroma vapors in air
$\mathrm{Sc} \approx 1\text{–}3$ — momentum and mass diffuse at
comparable rates. This is why both flow and diffusion matter for
sensor timing.

### 3.3 Péclet number

$$
\mathrm{Pe} = \frac{U L}{D} = \mathrm{Re}\cdot\mathrm{Sc}
$$

Ratio of advective to diffusive transport of the species.
- $\mathrm{Pe} \gg 1$ → advection-dominated → sharp concentration front
- $\mathrm{Pe} \ll 1$ → diffusion-dominated → smeared front
- $\mathrm{Pe} \sim 1$ → balanced Taylor dispersion regime

### 3.4 Characteristic timescales

$$
\tau_\mathrm{flow} = \frac{L}{U}, \qquad
\tau_\mathrm{diff} = \frac{L^2}{D}
$$

The smaller of the two is the **rate-limiting transport mechanism**.
A sensor's fastest possible response cannot be shorter than
$\tau_\mathrm{flow}$ (the pulse first has to reach it).

### 3.5 Strouhal number (pulsed inlet)

For a pulse of duration $\tau_p$:

$$
\mathrm{St} = \frac{L}{U \tau_p} = \frac{\tau_\mathrm{flow}}{\tau_p}
$$

- $\mathrm{St} < 1$ → pulse is long compared to transit → quasi-steady
- $\mathrm{St} > 1$ → pulse is short → transient dominates

---

## 4. Numerical method — the LBM core

### 4.1 Why LBM

For low-Reynolds 2-D flow with complex boundaries, LBM:

- Is **explicit**, no pressure Poisson solve.
- Handles **arbitrary geometry** with simple per-cell bounce-back.
- Parallelizes trivially (every cell is independent in collision +
  local in streaming).
- Runs **real-time** for a few hundred thousand cells in a Web Worker.

The cost: it naturally enforces weak compressibility (Mach number
must be small) and has $\mathcal{O}(\mathrm{Ma}^2)$ compressibility
error in the recovered Navier–Stokes equations.

### 4.2 D2Q9 discrete-velocity set

Nine discrete velocities on a square lattice:

```
  c_6     c_2     c_5
     \     |     /
      \    |    /
  c_3 --- c_0 --- c_1
      /    |    \
     /     |     \
  c_7     c_4     c_8
```

In lattice units ($\Delta x = \Delta t = 1$):
$\mathbf{c}_0 = (0,0)$, $\mathbf{c}_{1..4}$ axis-aligned with $\|\mathbf{c}_i\| = 1$,
$\mathbf{c}_{5..8}$ diagonal with $\|\mathbf{c}_i\| = \sqrt 2$.

Equilibrium weights: $w_0 = 4/9$, $w_{1..4} = 1/9$, $w_{5..8} = 1/36$.

### 4.3 BGK collision + streaming

Single-relaxation-time BGK operator:

$$
f_i(\mathbf{x}, t + \Delta t) = f_i(\mathbf{x}, t)
- \frac{1}{\tau}\left[f_i(\mathbf{x}, t) - f_i^{eq}(\rho, \mathbf{u})\right]
$$

with the Maxwell-like equilibrium:

$$
f_i^{eq} = w_i \rho \left[
1 + 3(\mathbf{c}_i \cdot \mathbf{u})
+ \tfrac{9}{2}(\mathbf{c}_i \cdot \mathbf{u})^2
- \tfrac{3}{2}\|\mathbf{u}\|^2
\right]
$$

Macroscopic quantities:
$\rho = \sum_i f_i$, $\rho \mathbf{u} = \sum_i \mathbf{c}_i f_i$.

Kinematic viscosity in lattice units:
$\nu_\mathrm{lb} = \tfrac{1}{3}(\tau - \tfrac12)$.

After collision, distributions **stream** one cell along $\mathbf{c}_i$:

$$
f_i(\mathbf{x} + \mathbf{c}_i\Delta t, t + \Delta t) = f_i^*(\mathbf{x}, t)
$$

### 4.4 Wall BC: half-way bounce-back

At a wall cell, outgoing distributions are mirrored:
$f_{\bar i} \leftarrow f_i$ where $\bar i$ is the opposite direction.
This places the no-slip wall at half a lattice spacing outside the
wall cell — accurate to second order for straight walls, first order
at curved walls (staircased).

### 4.5 Inlet BC: imposed velocity

An **outward-normal** inlet velocity $\mathbf{u}_\mathrm{in}$ is imposed by
replacing the incoming distributions with $f_i^{eq}(\rho_\mathrm{est},
\mathbf{u}_\mathrm{in})$, where $\rho_\mathrm{est}$ is the local estimate
from known populations (a regularised equilibrium scheme). The normal
direction is rounded to the nearest D2Q9 axis so the inflow lattice
does not violate the streaming pattern.

### 4.6 Outlet BC: zero-gradient extrapolation

$f_i(\mathbf{x}_\mathrm{outlet}, t) = f_i(\mathbf{x}_\mathrm{outlet} - \hat n_\mathrm{out}, t)$
— simple copy from the upstream neighbour. Good for strongly
advective outflows; not a proper absorbing BC, so expect mild
reflections near the outlet for pulsed studies.

### 4.7 Unit conversion

Given physical quantities $U_\mathrm{phys}$ (m/s), $\Delta x_\mathrm{phys}$
(m), $\nu_\mathrm{phys}$ (m²/s):

1. Choose **target lattice velocity** $U_\mathrm{lb} = 0.05$
   (keeps Ma low while staying expressive).
2. Physical time step: $\Delta t = U_\mathrm{lb}\,\Delta x_\mathrm{phys} / U_\mathrm{phys}$.
3. Lattice viscosity: $\nu_\mathrm{lb} = \nu_\mathrm{phys}\,\Delta t / \Delta x^2$.
4. Relaxation time: $\tau = 3\nu_\mathrm{lb} + 0.5$.

The solver warns when $\tau < 0.52$ (unstable) or $\tau > 1.8$
(over-diffusive).

---

## 5. Species transport solver

### 5.1 Scheme

Explicit finite-difference on the same grid as the LBM, advancing in
lockstep with one LBM step per species step. First-order upwind for
advection + second-order central for diffusion:

$$
c^{n+1}_{i,j} = c^n_{i,j}
- \Delta t\,\mathrm{UPW}(\mathbf{u}^n, c^n)_{i,j}
+ \Delta t\,D_\mathrm{lb}\,\Delta^2 c^n_{i,j}
$$

where $\mathrm{UPW}$ is upwinded in each coordinate direction
independently and $\Delta^2$ is the 5-point Laplacian.

### 5.2 Non-dimensionalisation

Same $\Delta x, \Delta t$ as the flow solver. Lattice diffusivity:

$$
D_\mathrm{lb} = \frac{D\,\Delta t}{\Delta x^2}
$$

The solver warns if $D_\mathrm{lb} > 0.24$ (near the
$D_\mathrm{lb} \le 1/4$ central-diffusion stability bound).

### 5.3 Boundary conditions for $c$

| Cell type | Action each step |
|---|---|
| Inlet | $c \leftarrow c_\mathrm{pulse}(t)$ evaluated on main thread |
| Outlet | copy from upstream fluid neighbour (zero-gradient) |
| Wall | stencil neighbours that land on walls are replaced by the centre value → emergent zero normal flux |
| Interior fluid | full scheme as above |

### 5.4 Value clamping

`c` is clamped to $[-0.05, 10]$ after each update to suppress
transient over/undershoots from the upwind scheme on coarse meshes.
Under-shoot of 5 % is a standard relief valve and does not affect
AUC or metric calculations (the time-series are rectified internally).

---

## 6. Geometry pipeline

### 6.1 Entity model

Every entity is a closed 2-D polygon with CCW vertex order:

```
{
  id, type: 'polyline',
  points: [{x, y}, ...],   // mm, y-up
  edgeBC: { 0: {type:'wall'}, 1: {type:'inlet'}, ... },
  closed: true,
}
```

`edgeBC[i]` applies to the edge from `points[i]` to `points[i+1]`.
If omitted, defaults to `wall`.

### 6.2 Fillet generation

A fillet at vertex $V$ with incoming direction $\hat a$ and outgoing $\hat b$
and radius $r$ replaces $V$ with an arc of $N+1$ points. Given turn
angle $\varphi = \mathrm{atan2}(\hat a \times \hat b, \hat a \cdot \hat b)$:

- Interior half-angle $\theta/2 = (\pi - |\varphi|)/2$.
- Tangent setback: $s = r / \tan(\theta/2)$.
- Arc center on the bisector, offset by $s / \sin(\theta/2)$ toward
  the solid (sign flips for convex vs. reflex corners).

The arc is discretised into $N$ segments; $N = 10$ is the default.
See `computeFilletArc()` in `FlowLabPage.jsx`.

### 6.3 Boolean operations

Union, Difference, Intersection, and XOR operate on closed polygons
using the Martinez–Rueda clipping algorithm (`polygon-clipping` npm
package). The result inherits wall BCs for all new edges;
inlet/outlet edges outside the boolean region are discarded.

### 6.4 Rasterisation to the lattice

For each fluid cell:

1. Ray-casting parity test against all polygon edges → inside/outside.
2. A 1-cell thick boundary shell is flagged with its BC tag
   (`wall`, `inlet`, `outlet`, or `sensor`).
3. Inlet and outlet normals are computed per-edge from polygon vertex
   geometry.

See `rasterizeDomain()` in `src/flowlab/geometry.js`.

### 6.5 Sensor edge → cell assignment

For every edge tagged `sensor`, the rasteriser finds **all fluid cells
within one lattice spacing of the edge AND closer to this edge than
to any other polygon edge**. Those cells become the sensor's sampling
set. This gives a clean near-wall probe that isn't corrupted by a
neighbouring wall.

Each sensor stores:

```
{ edgeIdx, cells: [flatIdx, ...], length_mm, midpoint }
```

### 6.6 `inletLength_mm`

Sum of geodesic length of all `inlet`-tagged edges on the primary
domain. Used to convert sccm → m/s:

$$
U_\mathrm{eff} = \frac{Q_\mathrm{SI}}{L_\mathrm{inlet}\,h_\mathrm{depth}}
$$

where $h_\mathrm{depth}$ is the user-set out-of-plane channel depth.

---

## 7. Meshing

### 7.1 Square lattice, auto aspect

Given bounding box $W \times H$ and user-chosen **longest-axis cells**
$N_\mathrm{long}$:

- $\Delta x = \max(W, H) / N_\mathrm{long}$
- $N_x = \mathrm{round}(W / \Delta x)$, $N_y = \mathrm{round}(H / \Delta x)$

Cells stay square ($\Delta x = \Delta y$), which D2Q9 requires.

### 7.2 Resolution presets

| Preset | $N_\mathrm{long}$ | Cells (10×3 cm demo) | Typical wall-clock to steady state |
|---|---:|---:|---:|
| Coarse | 150 | 7.5 k | < 2 s |
| Medium | 300 | 30 k | 5–10 s |
| Fine | 450 | 67 k | 20–40 s |
| Very fine | 600 | 120 k | 1–2 min |

Memory scales as $\mathcal{O}(N^2)$, wall-clock as $\mathcal{O}(N^3)$
(more cells **and** more iterations to converge).

### 7.3 Grid-convergence checklist

1. Run at Medium, note $t_{50}$ and $Q_\mathrm{out}$.
2. Run at Fine; if either changed by >5 %, use Fine.
3. If you see staircase artefacts on curved walls, bump to Very fine
   or add fillets with $r \gtrsim 3\Delta x$.

---

## 8. Inlet pulse library

Pulse $c_\mathrm{pulse}(t)$ evaluated on the main thread every step
and shipped to the worker via a `species-bc` message. All profiles
return a value in $[0, 1]$; the user's pre-factor is folded in at
export time.

### 8.1 Step

$$
c(t) = \begin{cases} 1 & t \ge 0 \\ 0 & t < 0 \end{cases}
$$

Classic breakthrough curve; produces the step response of the
device.

### 8.2 Rectangular

Parameters: $t_\mathrm{start}$, $t_\mathrm{dur}$.

$$
c(t) = \begin{cases} 1 & t_\mathrm{start} \le t \le t_\mathrm{start} + t_\mathrm{dur} \\ 0 & \text{otherwise}\end{cases}
$$

Impulse-like for small $t_\mathrm{dur}$ → residence-time distribution
(RTD) proxy.

### 8.3 Gaussian

Parameters: $\mu$, $\sigma$.

$$
c(t) = \exp\!\left[-\tfrac{1}{2}\left(\tfrac{t - \mu}{\sigma}\right)^2\right]
$$

Smooth, differentiable bolus — useful for controlled-injection
experiments.

### 8.4 Exponential decay (vial headspace)

Parameters: $t_\mathrm{start}$, $\tau$.

$$
c(t) = \begin{cases} e^{-(t - t_\mathrm{start})/\tau} & t \ge t_\mathrm{start} \\ 0 & t < t_\mathrm{start}\end{cases}
$$

Models an emptying vial whose headspace concentration decays
exponentially.

### 8.5 Double step (on/off)

Parameters: $t_\mathrm{on}$, $t_\mathrm{off}$.

$$
c(t) = \begin{cases} 1 & t_\mathrm{on} \le t < t_\mathrm{off} \\ 0 & \text{otherwise}\end{cases}
$$

Functionally same as rectangular with $t_\mathrm{dur} = t_\mathrm{off} - t_\mathrm{on}$,
but the parameterisation matches "valve open/close" mental model.

---

## 9. Sensor probe methodology

### 9.1 What is recorded

At each solver snapshot (default every 8 iterations), for every sensor:

$$
\bar c_s(t) = \frac{1}{|\mathcal{C}_s|}\sum_{i \in \mathcal{C}_s} c_i(t),
\qquad
\overline{\|\mathbf u\|}_s(t) = \frac{1}{|\mathcal{C}_s|}\sum_{i \in \mathcal{C}_s} \|\mathbf u_i(t)\|
$$

where $\mathcal{C}_s$ is the set of fluid cells associated with
sensor $s$ (§6.5). The peak velocity over the sensor is also stored
as a diagnostic.

### 9.2 Response metrics (all derived from $\bar c_s(t)$)

Let $c_{max} = \max_t \bar c_s(t)$ and $t_{peak} = \mathrm{argmax}_t \bar c_s$.

- **Peak concentration** $c_{max}$ — maximum normalized value seen.
- **Time of peak** $t_{peak}$ — when it occurs.
- **Threshold times** — linear interpolation:
  $$
  t_\alpha = \min\{\,t : \bar c_s(t) \ge \alpha\,c_{max}\},\quad \alpha \in \{0.1, 0.5, 0.9\}
  $$
- **Rise time**: $t_{rise} = t_{90} - t_{10}$.
- **FWHM** (Full Width at Half Maximum):
  find $t_L, t_R$ such that $\bar c_s(t_L) = \bar c_s(t_R) = c_{max}/2$
  with $t_L < t_{peak} < t_R$; then FWHM $= t_R - t_L$.
- **AUC** (Area Under Curve, dose):
  $$
  \mathrm{AUC} = \int_0^{T} \left(\bar c_s(t) - c_0\right) dt
  \approx \sum_n \tfrac{1}{2}\left(\bar c_s^{n} + \bar c_s^{n+1}\right)\Delta t_n
  $$
  Trapezoidal rule; $c_0$ is the pre-pulse baseline (typically 0).

### 9.3 Physical interpretation

| Metric | Engineering meaning |
|---|---|
| $c_{max}$ | Fraction of inlet concentration that ever reaches the sensor |
| $t_{10}$ | "First detection" threshold — minimum perceivable response |
| $t_{50}$ | Conventional transport time scale |
| $t_{90}$ | Time to nearly full response |
| $t_{rise}$ | Dispersion-driven smearing (small for high Pe) |
| FWHM | Peak width; large FWHM → poor temporal resolution |
| AUC | Total exposure / dose — key for threshold-triggered sensors |

### 9.4 Comparing sensors

Two sensors on opposite walls should have identical metrics in a
perfectly symmetric geometry. A divergence between S1 and S2 is a
direct diagnostic for:

- Jet asymmetry from the inlet
- Chamber design tilting flow one way
- Unequal boundary-layer thickness
- Re-attachment downstream of a badly filleted junction

---

## 10. Post-processing toolkit

### 10.1 Velocity heatmap

- Colormap: Turbo (default), Viridis, Inferno, RdBu.
- Range: 0 to 95th-percentile $\|\mathbf u\|$. P95 clipping keeps a
  few outlier cells from dominating the colour range. Cells above
  P95 saturate.

### 10.2 Species concentration overlay

- Blending: `screen` mix-blend with a white-hot → magenta gradient.
- Alpha $= c^{0.7}$ — gamma-corrected so low concentrations still
  show up without saturating at high values.
- Rendered on a separate canvas; toggled independently of velocity.

### 10.3 Streamlines

Forward Euler integration from a regular seed grid through the
velocity field; clipped to 200 steps per seed. Mostly for qualitative
flow-direction inspection.

### 10.4 Section probes

A section probe is a straight line across the geometry. The probe
samples the field along arclength $s \in [0, L_\mathrm{section}]$
(default 200 samples) via bilinear interpolation. Available
quantities:

| id | Quantity | Formula |
|---|---|---|
| `umag` | velocity magnitude | $\|\mathbf u\|$ |
| `ux` | x-component | $u_x$ |
| `uy` | y-component | $u_y$ |
| `un` | normal component | $\mathbf u \cdot \hat n$ |
| `ut` | tangential component | $\mathbf u \cdot \hat t$ |
| `c` | concentration (if species on) | $c$ |
| `cu` | mass flux per unit depth | $c\,(\mathbf u \cdot \hat n)$ |

Per-section statistics (each quantity):

$$
\text{min}, \text{max}, \text{mean} = \frac{1}{L}\int_0^L f\,ds, \quad
\text{integral} = \int_0^L f\,ds
$$

Displayed in the Post-sim analysis panel; CSV-exportable.

### 10.5 Flow rate through a section

$$
Q = \int_0^L (\mathbf u \cdot \hat n)\, ds \cdot h_\mathrm{depth}
$$

with units (m/s · m · m) = m³/s. Converted for display to sccm,
mL/min, m³/s.

- **Mass balance check**: $Q_\mathrm{out} - Q_\mathrm{in}$ should
  converge to 0 at steady state (mass conservation). The residual
  tells you the local discretisation error.

### 10.6 Transient flow rate time-history

Recorded every N iterations (N matches the solver snapshot cadence)
for every visible section. Fields: `t_s, iter, Q_m3ps, Q_mlpm,
mean_mps, peak_mps, flux_m2ps` × [one block per section].

### 10.7 Residuals / convergence

$$
R^n = \frac{\langle\|\mathbf u^n - \mathbf u^{n-1}\|\rangle_\mathrm{fluid}}{\langle\|\mathbf u^n\|\rangle_\mathrm{fluid}}
$$

Steady state is declared when the last 8 posted residuals are all
below $10^{-4}$.

### 10.8 CSV exports — schemas

| File | Header lines | Columns |
|---|---|---|
| Section CSV | `# project, gas, analyte, Pe, Sc, t_s, iter` | `s_mm, x_mm, y_mm, ux, uy, umag, c, cu, p` |
| Q(t) CSV | project, gas, sections | `t_s, iter, <sect>_Q_mlpm, <sect>_Q_m3ps, ...` |
| Steady-state CSV | project, steady iter | `section, mean_mps, Q_mlpm, Re_local` |
| Sensors CSV | project, gas, analyte, Pe, Sc, pulse metadata | `t_s, c_S1, u_S1, c_S2, u_S2, ...` |

### 10.9 Consolidated post-simulation results catalogue

Everything the solver exposes, grouped by category. Each entry cites the
UI panel that produces it and the CSV/JSON export that persists it.

#### 10.9.1 Regime dashboard (live, always visible)

- **Reynolds** $\mathrm{Re} = UL/\nu$ — flow regime.
- **Schmidt** $\mathrm{Sc} = \nu/D$ — analyte transport balance.
- **Péclet** $\mathrm{Pe} = \mathrm{Re}\cdot\mathrm{Sc}$ — advection vs diffusion of species.
- **Flow timescale** $\tau_\mathrm{flow} = L/U$.
- **Diffusion timescale** $\tau_\mathrm{diff} = L^2/D$.
- **Strouhal** $\mathrm{St} = \tau_\mathrm{flow}/\tau_\mathrm{pulse}$ (pulsed inlets).
- **Mach (solver)** self-reported — $< 0.1$ required for validity.

Panel: `Simulation` header + `Species transport` readout. Carried into every CSV header.

#### 10.9.2 Full-field maps (2-D on the lattice)

- Velocity magnitude $\|\mathbf{u}(x,y)\|$ — heatmap (Turbo / Viridis / Inferno / RdBu).
- Velocity components $u_x, u_y$ via sections + streamlines.
- Streamlines — forward-Euler from regular seed grid.
- Species concentration $c(x,y,t)$ — magenta "screen" overlay, gamma-corrected.
- Low-velocity mask (dead zones) — toggle in Visualization.
- Mesh / BC mask — fluid / solid / inlet / outlet / sensor colouring.

Panel: `Visualization`. Export: PNG via browser "Save canvas as image".

#### 10.9.3 Section probes (drawn line cuts)

Any number of user-drawn lines; each samples 7 quantities along arclength plus live min/max/mean/integral:

| id | Quantity | Formula |
|---|---|---|
| `umag` | speed | $\|\mathbf u\|$ |
| `ux` / `uy` | components | $u_x, u_y$ |
| `un` | normal component | $\mathbf u\cdot\hat n$ |
| `ut` | tangential | $\mathbf u\cdot\hat t$ |
| `c` | concentration | $c$ |
| `cu` | mass flux per depth | $c\,u_n$ |

Flow rate through a section: $Q = h_\mathrm{depth}\int u_n\,ds$ (shown in m³/s, mL/min, sccm).

Panel: `Post-sim analysis → Sections`. Export: `flowlab_<section>.csv`.

#### 10.9.4 Sensor probes (tagged wall edges)

Per-sensor live traces:

- $c_s(t)$ — mean near-wall concentration.
- $\|\mathbf{u}\|_s(t)$ — mean near-wall speed (also peak as diagnostic).

**Eight automatic response metrics per sensor** (derived from $c_s(t)$):

| Metric | Definition |
|---|---|
| Peak $c_\mathrm{peak}$ | $\max_t c_s$ |
| Time-of-peak $t_\mathrm{peak}$ | $\arg\max_t c_s$ |
| $t_{10}$ | first $t$ where $c_s \ge 0.10\,c_\mathrm{peak}$ |
| $t_{50}$ | first $t$ where $c_s \ge 0.50\,c_\mathrm{peak}$ |
| $t_{90}$ | first $t$ where $c_s \ge 0.90\,c_\mathrm{peak}$ |
| Rise time | $t_{90} - t_{10}$ |
| FWHM | width of $c_s \ge c_\mathrm{peak}/2$ |
| AUC (dose) | $\int (c_s - c_0)\,dt$ |

Panel: `Sensor response`. Export: `flowlab_sensors_<project>.csv` (wide format, `t, c_S1, u_S1, c_S2, u_S2, …` + metrics header).

#### 10.9.5 Flow-rate transients (mass balance)

- $Q_\mathrm{in}(t)$, $Q_\mathrm{out}(t)$ — volumetric flow through every tagged edge.
- Mass-balance residual $Q_\mathrm{in}-Q_\mathrm{out}$ — convergence check.
- $Q(t)$ through any user-drawn section.
- Steady-state mean and peak per inlet / outlet / section.

Panel: `Flow rate Q(t)`. Exports: `flowlab_timehistory_<project>.csv` (wide transient) + `flowlab_summary_<project>.csv` (one row per section at current frame).

#### 10.9.6 Solver diagnostics

- Velocity residual $R^n$ — log-linear trace; steady-state when last 8 are $< 10^{-4}$.
- Max mass divergence $\lVert\nabla\!\cdot\!\mathbf u\rVert_\infty$.
- Iteration count, physical sim-time, FPS.
- Stability warnings: $\tau < 0.52$ (under-relaxed), $\tau > 1.8$ (over-diffusive), $D_\mathrm{lb} > 0.24$ (species stability margin).

Panel: `Simulation` footer + console warnings.

#### 10.9.7 Derived design metrics (post-processed from exported data)

Not auto-computed but follow deterministically from the CSVs above:

| Metric | Recipe |
|---|---|
| Dead-zone fraction | area of cells where $\|\mathbf u\| < 0.1\,U_\mathrm{ref}$ / total fluid area |
| Residence time distribution $E(t)$ | outlet-section $c(t)$ from a narrow inlet pulse, normalised |
| Mean residence time $\bar\tau$ | $\int t\,E(t)\,dt$ |
| Breakthrough time | $t_{10}$ at an outlet section |
| Wash-out / recovery time | time for $c_s$ to fall below 10 % of peak after pulse off |
| Mixing index | variance of $c$ across an outlet section at steady state |
| Jet penetration depth | distance from inlet where $\|\mathbf u\|$ falls below threshold |
| Dose uniformity | (std / mean) of AUC across sensors |
| Capture efficiency | $\mathrm{AUC}_\mathrm{sensor}/\mathrm{AUC}_\mathrm{inlet}$ |

#### 10.9.8 Project and results persistence

- **Project JSON** — full geometry + BCs + gas + analyte + pulse + sections + sensors + colormap settings. (File → Save / Save As.)
- **Results snapshot** — project JSON + final $\mathbf{u}$, $c$ fields + all transient traces. (Workspace → Save results.)
- Every CSV header embeds project name, timestamp, gas, analyte, pulse, and the non-dimensional numbers, so any exported file can be traced back to its exact model state.

#### 10.9.9 "Which result answers which design question?"

| Design question | Best result to look at |
|---|---|
| Is my flow laminar? | Re readout |
| Where does the aroma stagnate? | Velocity heatmap + dead-zone highlight |
| How fast does a pulse reach sensor A? | $t_{10}, t_{50}$ on sensor A |
| How much does the pulse get smeared? | FWHM at sensor vs pulse duration at inlet |
| Is sensor A getting more dose than B? | AUC comparison in Sensors CSV |
| Does fillet radius help mixing? | Dead-zone fraction + mixing index, pre/post |
| What Q flushes the chamber? | Wash-out time vs Q parametric sweep |
| Is the reading repeatable pulse-to-pulse? | Consecutive AUC in Sensors CSV |
| Does mass conserve? | $Q_\mathrm{in} - Q_\mathrm{out}$ residual |
| Have I reached steady state? | Velocity residual plateau |

---

## 11. Choosing physical units

### 11.1 Inlet: velocity vs. sccm

| Mode | When to use |
|---|---|
| **Velocity (m/s)** | You know the target inlet speed (e.g. from literature) or you want a direct Reynolds sweep |
| **sccm** | You know the MFC setpoint in your experiment. Standard gas-delivery parlance |

Conversion:

$$
U_\mathrm{eff} = \frac{Q_\mathrm{SI}}{L_\mathrm{inlet}\,h_\mathrm{depth}},
\quad Q_\mathrm{SI} = Q_\mathrm{sccm}\times 1.6666667\times 10^{-8}\ \mathrm{m^3/s}
$$

### 11.2 Channel depth

Flow Lab is 2-D. "Channel depth" is the out-of-plane thickness used
only for (a) converting sccm ↔ m/s and (b) converting 2-D flux per
unit depth (m²/s) to volumetric flow rate (m³/s). It does **not**
affect the velocity field directly.

For a narrow-aspect-ratio channel (depth ≲ channel width), the 2-D
approximation is good. For cubic chambers the 2-D assumption
under-predicts wall drag; treat absolute $Q$ with caution, but
**relative** comparisons across design variants stay reliable.

---

## 12. Workflow recipes

### 12.1 Quick design sanity check

1. Draw the chamber; tag inlet / outlet.
2. Medium mesh. Run → steady.
3. Inspect velocity heatmap for dead zones.
4. Add sensors on candidate wall locations.
5. Enable species, use Step pulse, check $t_{50}$.

### 12.2 Response-time optimization

1. Lock geometry; record baseline $t_{10}, t_{50}, t_{90}$ for each
   candidate sensor.
2. Parameter sweep (manual): Q in [5, 10, 20, 40] sccm.
3. Plot $t_{50}$ vs. Q on log-log — slope should be ≈ −1 for an
   advection-limited sensor, ≈ 0 for a diffusion-limited one.
4. If slope flattens too early, sensor is in a dead zone — move it.

### 12.3 Geometry optimisation (fillets, expansions)

1. Start with sharp dog-bone.
2. Run, look at sensor $t_{90}$ and FWHM.
3. Fillet the four re-entrant junctions, rerun.
4. Compare FWHM — a good fillet typically narrows FWHM by 10–30 %.
5. Fillet the far chamber corners, rerun — usually negligible for
   sensor metrics but kills slow dead-zone decay (visible in the
   AUC's long tail).

### 12.4 Multi-sensor placement study

Place N sensors on different walls. Export Sensors CSV. Compute:

- $\Delta t_{50}$ between sensors → flow asymmetry.
- AUC ratio → exposure non-uniformity.

Use the worst-case location for the spec sheet.

### 12.5 Rectangular vs Gaussian pulses

| Question | Best pulse |
|---|---|
| "What's the step response?" | Step |
| "What's the RTD of my chamber?" | Rectangular with small $t_\mathrm{dur}$ (≲ $\tau_\mathrm{flow}/5$) |
| "How smeared will my real bolus be?" | Gaussian matched to your injection hardware |
| "Breakthrough + recovery time?" | Double step |
| "Vial-empty scenario?" | Exponential decay |

---

## 13. Validation and limitations

### 13.1 What is trusted

- Qualitative flow patterns (jet impingement, recirculation, dead
  zones) — extensively cross-checked vs. COMSOL on benchmark cases.
- Relative design comparisons (A vs. B) — within a few percent.
- Steady-state mass conservation — better than 1 % with Medium mesh.
- Sensor timing scaling ($t_{50} \propto L/U$ etc.) — correct to
  within LBM compressibility error.

### 13.2 What to be careful about

- **Absolute flow rate (sccm)**: 2-D approximation under-predicts
  drag; treat absolute values as indicative, comparisons as reliable.
- **Very thin features** (< 3Δx): under-resolved, will artificially
  block flow — refine or redraw.
- **Sharp reflex corners** (not filleted): can cause mesoscopic
  density oscillations. Filleting >= 3Δx fixes this.
- **High Re**: above ~1500 in a chamber, shear layers become
  unstable and LBM BGK without a turbulence model under-damps the
  chaos. Trust only the time-average.
- **Outlet reflections**: zero-gradient outlet reflects a few percent
  of transient pressure waves. For pulsed studies, put the outlet
  farther downstream than you'd naively need.

### 13.3 Known open issues

- Species clamp to [-0.05, 10] can hide under-resolution; watch for
  $c$ going negative near the inlet edge on Coarse meshes.
- Fillet arcs on slanted walls are exact polylines, not true arcs
  at the LBM scale; bump mesh for smooth walls.

---

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "D_lb near 0.25" warning | Coarse mesh + high D analyte | Bump mesh resolution, or pick a heavier analyte |
| "τ near unstable" warning | U too high for chosen mesh | Lower Q, or finer mesh |
| Velocity field has checkerboard noise | Mesh too coarse for Re | Bump mesh, or add walls to break the chamber |
| $c$ goes negative | Upwind under-shoot on coarse mesh | Finer mesh, or lower Pe (slower U or fatter analyte) |
| Sensor metrics stay "—" | Pulse front never crossed 90 % of peak at that sensor | Longer pulse, higher Q, or sensor is in dead zone |
| S1 ≠ S2 at steady-state baseline | Geometry is actually asymmetric (or solver not converged) | Check convergence panel; verify symmetry of inlet placement |
| $Q_\mathrm{out} \ne Q_\mathrm{in}$ at steady | Discretisation error | Refine mesh; check geometry is closed |
| Magenta overlay invisible | Species off / overlay off / $c$ never exceeded background | Check toggles; increase $c_0$ or pulse duration |
| App crashes with "cannot access X before initialization" | Hot-reload stale; or you hit a genuine bug | Full reload; if it persists, open an issue |

---

## 15. Glossary

- **AUC** — Area Under the Curve. Integrated dose at a sensor.
- **BC** — Boundary Condition.
- **BGK** — Bhatnagar–Gross–Krook; the single-relaxation-time LBM
  collision operator.
- **CFL** — Courant–Friedrichs–Lewy stability number.
- **D2Q9** — 2-D, 9-velocity LBM lattice.
- **FWHM** — Full Width at Half Maximum.
- **LBM** — Lattice Boltzmann Method.
- **Ma** — Mach number, $U/c_s$.
- **P95 clipping** — heatmap colour-range cap at the 95th percentile.
- **Pe** — Péclet number, $UL/D$.
- **Re** — Reynolds number, $UL/\nu$.
- **RTD** — Residence Time Distribution.
- **Sc** — Schmidt number, $\nu/D$.
- **sccm** — Standard cubic centimetres per minute. 1 sccm =
  $1.6667\times10^{-8}\ \mathrm{m^3/s}$.
- **τ** — LBM relaxation time; also used for generic timescales.

### 15.1 Symbol table

| Symbol | Meaning | Unit |
|---|---|---|
| $\mathbf{u} = (u_x, u_y)$ | velocity | m/s |
| $\rho$ | density | kg/m³ |
| $p$ | pressure | Pa |
| $\nu$ | kinematic viscosity | m²/s |
| $\mu$ | dynamic viscosity | Pa·s |
| $D$ | species diffusivity | m²/s |
| $c$ | species concentration (normalised) | — |
| $L$ | characteristic length | m |
| $U$ | characteristic velocity | m/s |
| $Q$ | volumetric flow rate | m³/s or sccm |
| $h_\mathrm{depth}$ | out-of-plane channel depth | m |
| $L_\mathrm{inlet}$ | total inlet-tagged edge length | m |
| $\Delta x$ | lattice cell size (physical) | m |
| $\Delta t$ | solver time step (physical) | s |
| $\tau$ | LBM relaxation time (lattice) | — |
| $N_\mathrm{long}$ | longest-axis lattice resolution | cells |

---

## 16. References

1. **S. Succi**, *The Lattice Boltzmann Equation for Fluid Dynamics
   and Beyond*, Oxford Univ. Press, 2001. — Canonical LBM text.
2. **T. Krüger et al.**, *The Lattice Boltzmann Method — Principles
   and Practice*, Springer, 2017. — Comprehensive modern reference.
3. **Poling, Prausnitz & O'Connell**, *The Properties of Gases and
   Liquids*, 5th ed., McGraw-Hill. — Gas-phase diffusivity data.
4. **Perry's Chemical Engineers' Handbook**, 9th ed. — Transport
   property tables.
5. **H. Fogler**, *Elements of Chemical Reaction Engineering*, 4th
   ed., Prentice Hall. — Residence-time-distribution theory.
6. **J. Happel & H. Brenner**, *Low Reynolds Number Hydrodynamics*,
   Nijhoff, 1983. — Low-Re flow reference.

---

## 17. File map (source)

| Path | Role |
|---|---|
| `src/components/FlowLabPage.jsx` | Main UI, state, solver orchestration |
| `src/components/FlowLabPage.css` | Styling for all Flow Lab UI |
| `src/flowlab/geometry.js` | Rasterisation, sensor cell assignment |
| `src/flowlab/lbmWorker.js` | Web Worker — LBM + species step loop |
| `src/flowlab/analytes.js` | Analyte presets, pulse profiles, Pe/Sc helpers |
| `src/flowlab/gases.js` | Gas properties (ρ, ν) |
| `src/flowlab/units.js` | Unit conversions (sccm ↔ m³/s, mm ↔ m, …) |
| `src/flowlab/colormap.js` | Turbo / Viridis / Inferno / RdBu palettes |

---

## 18. Design targets — flow rate and velocity

The headspace designer's operating question is: **what inlet flow rate
and what near-sensor velocity maximise gas–sensor interaction?** The
answer is a balance of three timescales.

### 18.1 The three competing timescales

1. **Sensor adsorption time** $\tau_\mathrm{ads}$ — how long the
   transducer needs to equilibrate with the local gas-phase
   concentration. For MOS / electrochemical aroma chips this is
   typically 50 ms – 1 s; for optical cavity sensors sub-ms; for
   slow biosensors minutes.
2. **Sensor interaction time** $\tau_\mathrm{int}$ — how long an
   analyte molecule actually spends over the sensor surface:
   $$
   \tau_\mathrm{int} \sim \frac{L_\mathrm{sensor}}{U_\mathrm{wall}}
   $$
   where $U_\mathrm{wall}$ is the near-wall tangential velocity at the
   sensor and $L_\mathrm{sensor}$ is the sensor length along the flow.
3. **Chamber refresh time** $\tau_\mathrm{res} = V_\mathrm{chamber}/Q$
   — how long it takes to replace the chamber volume once.

The **operating target** is

$$
\tau_\mathrm{int} \approx (1\text{–}5)\,\tau_\mathrm{ads},
\qquad
\tau_\mathrm{res} \lesssim \tau_\mathrm{signal}
$$

where $\tau_\mathrm{signal}$ is the shortest feature of interest in the
aroma signal.

- $\tau_\mathrm{int} \ll \tau_\mathrm{ads}$ → analyte sweeps past too fast; sensor is **under-responsive**.
- $\tau_\mathrm{int} \gg \tau_\mathrm{ads}$ → sensor saturates; additional flow is **wasted sample**.
- $\tau_\mathrm{res} \gg \tau_\mathrm{signal}$ → chamber averages out transients; **temporal resolution lost**.

### 18.2 Worked example (aroma-sensor chip)

For a 2-mm sensor strip with $\tau_\mathrm{ads} = 100$ ms, aim for
$U_\mathrm{wall} \approx 4$–$20$ mm/s. In a $10\times10$-mm chamber
with 1-mm channels and 1-mm depth, this maps to $Q$ of roughly
10–40 sccm — which is exactly the default window in Flow Lab's
aroma demo model.

### 18.3 Sweet-spot table (orders of magnitude)

| Scenario | $V_\mathrm{chamber}$ | Q (sccm) | U near sensor (mm/s) | Re | Pe (Limonene) |
|---|---|---:|---:|---:|---:|
| Rapid transient (ppm ramp tracking) | 10 mm³ | 20–50 | 50–200 | 50–200 | $10^3$–$10^4$ |
| Balanced (flavour profiling) | 100 mm³ | 5–20 | 5–50 | 10–100 | $10^2$–$10^3$ |
| Low-concentration / trace (ppb) | 500 mm³ | 1–5 | 1–5 | 1–10 | $10^1$–$10^2$ |
| Well-mixed (calibration / averaging) | > 1 cm³ | 0.5–2 | < 1 | < 1 | < 10 |

### 18.4 Laminar stability constraints

- Chamber $\mathrm{Re} < 500$ for smooth laminar flow (recommended).
- $\mathrm{Re} < 2000$ absolute upper bound (solver has no turbulence model).
- $U_\mathrm{inlet} < 5$ m/s on practical meshes (keeps Ma < 0.1).
- $\tau_\mathrm{LBM} \in [0.52, 1.8]$ — if the panel flags a warning,
  reduce $Q$ or refine the mesh.

### 18.5 How to find your sweet spot in Flow Lab

1. Fix geometry, enable species, pick your analyte.
2. Sweep $Q \in \{1, 2, 5, 10, 20, 50\}$ sccm.
3. Plot $t_{50}$ vs $Q$ on log-log.
   - Slope ≈ $-1$ → advection-limited (healthy operating branch).
   - Slope flattens → diffusion-limited or dead-zone-limited. You
     have entered the wasteful regime.
4. Pick the operating point **just above the knee**: fastest response
   the geometry can sustain without flattening.
5. Cross-check: AUC should be approximately constant across Q. If AUC
   falls at high Q, the sample is sweeping past the sensor too fast —
   back off.

---

## 19. Headspace chamber geometry

### 19.1 Volume and aspect ratio

**Volume** $V_\mathrm{chamber}$ is the primary design lever. Smaller → faster refresh, smaller sample consumption, sharper transients. Larger → better averaging, greater tolerance to inlet-pulse jitter, smoother signal. Typical targets:

| Use case | $V_\mathrm{chamber}$ |
|---|---|
| Chip-scale aroma sensor | 10–500 mm³ |
| Breath-sampling unit | 1–10 cm³ |
| Lab reference / calibration cell | 10–100 cm³ |

**Aspect ratio** $W\!:\!H\!:\!D$ (width : height : depth) drives the flow pattern:

- $1\!:\!1\!:\!1$ cubic — mixing-dominated, good for averaging, slow step response.
- $3\!:\!1\!:\!1$ long & thin — axial flow, sharp fronts, fast step response. Canonical for time-resolved pulse work.
- $2\!:\!1\!:\!0.5$ flat panel — sensor-array compatible; watch for 3-D effects when $D \lesssim 0.5$ mm (Flow Lab's 2-D assumption degrades).

### 19.2 Corner and junction design

- **Fillet every re-entrant corner** with $r \ge 3\Delta x$ (at Medium mesh, ≈ 0.5 mm on a 10-mm chamber). Payoff:
  - Eliminates dead-zone recirculation pockets.
  - Narrows sensor FWHM by 10–30 %.
  - Removes staircase artefacts in the LBM mask.
- Fillets on convex corners (chamber outside corners): cosmetic.
- Inlet and outlet transitions: **taper** rather than step-expand. A 1:3 diffuser with included angle $\leq 7°$ preserves jet momentum without impingement recirculation.

### 19.3 Baffles and serpentine paths

Inserting a baffle forces the flow to meander, increasing sensor exposure time and promoting mixing — at the cost of pressure drop (usually irrelevant for aroma work) and potential new dead zones downstream.

Design rules:

- Gap between baffle tip and wall $\geq$ 2 × sensor length.
- Two offset baffles (serpentine) roughly double residence time and cut FWHM by ~40 % at moderate Q.
- Never place a baffle directly upstream of a sensor — the unsteady wake adds noise to the sensor trace.

### 19.4 Sensor placement

| Where | Pros | Cons |
|---|---|---|
| Perpendicular to the jet | Highest AUC, strongest signal | Sensitive to inlet misalignment |
| Side walls, parallel to flow | Uniform, repeatable dose | Lower peak concentration |
| Downstream of a mixing zone | Most representative of chamber-average | Slower response |
| Near the inlet | Fast $t_{10}$ | Jet turbulence adds FWHM variance |

**Multi-sensor arrays**: separate sensors by at least the boundary-layer thickness $\delta \sim 5\sqrt{\nu L/U}$. At $U = 10$ mm/s in air and $L = 10$ mm this gives $\delta \approx 2$ mm.

### 19.5 Geometry-driven trade-offs

| If you want … | Then … | Cost |
|---|---|---|
| Fast response | Small V, high Q, narrow inlet, sensor close to inlet | High sample use; risk of sensor under-exposure |
| High sensitivity / dose | Large V, low Q, wide inlet, sensor far from inlet | Slow response; blurs transients |
| Uniform multi-sensor dose | Wide inlet, $L/W \sim 2$, symmetric outlet | Loses fast-transient resolution |
| Repeatable pulsed readings | Small V, high Q, generous fillets | Demands short-$\tau_\mathrm{ads}$ sensor |

---

## 20. Inlet and outlet — dimensioning and placement

### 20.1 Inlet sizing

Inlet width $w_\mathrm{inlet}$ converts a volumetric flow rate $Q$ into a jet:

$$
U_\mathrm{inlet} = \frac{Q}{w_\mathrm{inlet}\,h_\mathrm{depth}}
$$

- Narrow inlet (small $w$) → high $U_\mathrm{inlet}$, deep jet penetration, strong impingement, localised high-dose region.
- Wide inlet (large $w$) → low $U_\mathrm{inlet}$, gentle fill, uniform chamber dose.

Design targets:

| Style | $w_\mathrm{inlet}/W$ | Typical outcome |
|---|---:|---|
| Balanced default | 10–30 % | Mild jet + uniform mixing |
| Jet-dominated (direct-hit sensor) | < 5 % | Maximum peak, spatial non-uniformity |
| Diffuser / uniform fill | > 50 % (with taper) | Near-plug-flow, low peak, high uniformity |

**Inlet Reynolds number** $Re_\mathrm{inlet} = U_\mathrm{inlet}\,w_\mathrm{inlet}/\nu$ should stay $\lesssim 500$. Above that, jet instabilities broaden sensor FWHM and introduce pulse-to-pulse variability.

### 20.2 Outlet sizing

- Outlet area **≥** inlet area. Throttled outlets push recirculation back into the chamber; you will see $Q_\mathrm{out} < Q_\mathrm{in}$ in the Flow Rate panel.
- For pulsed studies, place the outlet 5–10 chamber-widths downstream of the last sensor so the zero-gradient outlet BC (§4.6) does not reflect pressure waves onto the sensor trace.
- A short tapered transition (1:3) from chamber to outlet preserves a clean directional flow.

### 20.3 Placement topology

| Pattern | Geometry | Best for |
|---|---|---|
| **Axial flow-through** | Inlet ← → outlet, sensor on top / bottom wall | Classical time-resolved pulse work |
| **Cross-flow** | Inlet bottom, outlet top, sensor on side walls | Vertical wash past wall-mounted sensors, less jet impingement |
| **Tangential / vortex** | Inlet on chord, outlet central | Well-mixed chamber, low-frequency averaging |
| **Direct-hit** | Inlet normal to sensor | Maximum AUC, fragile uniformity |
| **Oblique (15–30°)** | Inlet angled off-sensor | Mixing + responsiveness balance |

### 20.4 Sensor-to-inlet distance

Let $d_\mathrm{si}$ be the distance from inlet to the first sensor.

| $d_\mathrm{si}$ | Behaviour |
|---|---|
| < $2\,w_\mathrm{inlet}$ | Jet core impinges → high peak, unpredictable FWHM |
| $5\text{–}10\,w_\mathrm{inlet}$ | Jet decayed, boundary layer stable → clean signal |
| $\gg 10\,w_\mathrm{inlet}$ | Diffusion-dominated arrival → slow, smooth response |

Defaults:

- Fast-response single sensor: $d_\mathrm{si} \approx 5\,w_\mathrm{inlet}$.
- Uniform multi-sensor array: $d_\mathrm{si} \approx 10$–$20\,w_\mathrm{inlet}$.

---

## 21. Analyte-specific tuning — VOCs and inorganic vapors

Gas-phase diffusivity $D$ varies by more than 30× across common
analytes, so a geometry optimised for one analyte is not optimised
for another. The sections below give a reference table and design
modifiers per analyte class.

### 21.1 Property reference (in air at 25 °C, 1 atm)

| Analyte | Formula | $M$ (g/mol) | $D\times10^5$ (m²/s) | $\mathrm{Sc} = \nu/D$ | Class |
|---|---|---:|---:|---:|---|
| Hydrogen | H₂ | 2 | 7.0 | 0.22 | inorganic, light |
| Water vapor | H₂O | 18 | 2.60 | 0.60 | inorganic, polar, condensible |
| Ammonia | NH₃ | 17 | 2.48 | 0.63 | inorganic, polar |
| Carbon monoxide | CO | 28 | 2.00 | 0.78 | inorganic |
| Formaldehyde | HCHO | 30 | 1.85 | 0.84 | VOC, polar |
| Methanol | CH₃OH | 32 | 1.62 | 0.96 | light VOC |
| Hydrogen sulfide | H₂S | 34 | 1.70 | 0.92 | inorganic, reactive |
| Carbon dioxide | CO₂ | 44 | 1.60 | 0.98 | inorganic |
| Nitrogen dioxide | NO₂ | 46 | 1.50 | 1.04 | inorganic, reactive |
| Ethanol | C₂H₅OH | 46 | 1.35 | 1.16 | light VOC |
| Ozone | O₃ | 48 | 1.40 | 1.12 | inorganic, reactive |
| Acetone | C₃H₆O | 58 | 1.05 | 1.49 | medium VOC |
| Sulfur dioxide | SO₂ | 64 | 1.25 | 1.25 | inorganic, reactive |
| Isoprene | C₅H₈ | 68 | 0.90 | 1.73 | terpenoid VOC |
| Benzene | C₆H₆ | 78 | 0.88 | 1.78 | aromatic VOC |
| Toluene | C₇H₈ | 92 | 0.85 | 1.84 | aromatic VOC |
| Limonene | C₁₀H₁₆ | 136 | 0.57 | 2.74 | terpenoid aroma |
| Vanillin | C₈H₈O₃ | 152 | 0.48 | 3.26 | aromatic aroma |
| Geraniol | C₁₀H₁₈O | 154 | 0.52 | 3.01 | terpenoid aroma |
| Linalool | C₁₀H₁₈O | 154 | 0.55 | 2.84 | terpenoid aroma |

(Representative values. For precision work use the Chapman–Enskog or
Fuller–Schettler–Giddings correlation; Flow Lab ships a selection in
`src/flowlab/analytes.js` and supports a *Custom D* entry.)

### 21.2 Design implications by analyte class

**Light inorganic vapors (H₂, H₂O, NH₃, CO).** $D$ is very high,
$\mathrm{Sc} < 1$, $\mathrm{Pe}$ moderate even at low Q.

- Mixing is efficient; chamber geometry is forgiving.
- Sensor FWHM is dominated by chamber residence time, not by boundary-layer transport.
- Reduce $Q$ to 1–5 sccm in a 100 mm³ chamber for best sensitivity — fast enough for mixing, slow enough for sensor equilibration.
- Use a *wide* inlet ($\geq 20\%$ of $W$) to suppress jet artefacts.

**Medium VOCs (ethanol, acetone, methanol, formaldehyde).** $D \approx 10^{-5}$ m²/s, $\mathrm{Sc} \sim 1$, $\mathrm{Pe}$ moderate.

- The default aroma regime. Flow Lab's Limonene preset at 20 sccm in a 1-mm-deep chamber gives $\mathrm{Pe} \sim 10^3$ — applicable here with minor rescaling.
- Corner fillets measurably help (10–30 % FWHM reduction).
- 5–15 mm inlet-to-sensor distance is a safe default.

**Heavy / aromatic VOCs (limonene, linalool, vanillin, benzene, toluene).** $D < 10^{-5}$ m²/s, $\mathrm{Sc} \gtrsim 2$, $\mathrm{Pe}$ routinely $10^4$.

- Sharp, advection-dominated fronts. Dead zones are catastrophic — trapped analyte persists for minutes.
- Aggressive filleting **and** generous outlet sizing are mandatory.
- For ppb-level work, serpentine baffles extend sensor exposure time without expanding the chamber.
- Use longer pulses ($t_\mathrm{pulse} \geq 2\,\tau_\mathrm{flow}$) so there is enough diffusive time into the near-wall boundary layer.

**Reactive inorganic vapors (O₃, NO₂, SO₂, H₂S).** Gas-phase $D$ is moderate, but **wall losses** dominate in practice (not yet modelled in Flow Lab).

- Model the chamber as if the species were passive, then apply an effective capture coefficient post-hoc (roadmapped as a Robin BC).
- Keep $\tau_\mathrm{res} < 5$ s to minimise wall-loss artefacts.
- Use inert chamber materials (PTFE, glass, electropolished SS). This is outside Flow Lab's simulation but affects whether the results apply.

**Trace gases in non-air carriers (H₂ in N₂, VOC in He, etc.).** $D$ in a different carrier can differ by 2–5×.

- Swap the gas preset in `src/flowlab/gases.js` or use a *Custom gas* entry so that $\nu$ matches the carrier.
- Recompute $\mathrm{Pe}$ and $\mathrm{Sc}$ before interpreting sensor metrics.

### 21.3 Humidity and temperature (outside Flow Lab's present scope)

Real headspace operates at variable T (20–100 °C) and RH (0–100 %):

- $D \propto T^{1.75}\,P^{-1}$ — a 25 → 60 °C swing raises $D$ by ~25 %.
- Condensation: water and heavy VOCs can deposit on walls above their dew point, biasing sensors and physically altering geometry.
- Thermal buoyancy: not modelled; for $\Delta T > 10$ K at low Q, secondary flows develop that 2-D isothermal LBM misses.

**Recommended protocol for precision design work:** run Flow Lab at
the nominal operating point, then bracket with ±25 % sweeps on $D$
to cover the expected T / RH envelope.

### 21.4 Quick decision table

| Analyte class | $V_\mathrm{chamber}$ | $Q$ (sccm) | Inlet width | Sensor placement |
|---|---|---:|---|---|
| Light inorganic (H₂, NH₃) | 100 mm³ | 2–10 | 30 % of W | Downstream wall, centre |
| Medium VOC (EtOH, acetone) | 100–500 mm³ | 5–20 | 20 % of W | 5–10 $w$ downstream, wall |
| Aroma / heavy VOC (limonene) | 50–200 mm³ | 10–30 | 15 % of W | 5 $w$ downstream, side walls |
| Reactive / trace ppb (O₃, H₂S) | 50–100 mm³ | 20–50 | 20 % of W | Close to inlet, fast refresh |
| Calibration / well-mixed | 1–5 cm³ | 1–5 | 50 % of W | Any; low variance |

### 21.5 End-to-end example: designing for a new analyte

Suppose you want to profile a new heavy terpenoid ($M=200$, $D \approx 4\times10^{-6}$ m²/s) at ppb level in a breath sample.

1. **Scale**: heavy VOC + trace → pick $V_\mathrm{chamber} = 50$ mm³, serpentine baffles.
2. **Flow**: trace + sensitivity → $Q = 2$ sccm; verify $\tau_\mathrm{res} \approx 1.5$ s.
3. **Inlet**: $w_\mathrm{inlet} = 0.15\,W$; tapered 1:3 diffuser.
4. **Sensor**: 5 $w_\mathrm{inlet}$ downstream, side wall; add a second sensor for uniformity check.
5. **Verify** in Flow Lab: $\mathrm{Pe}$ should land in $10^3$–$10^4$ range. If $\mathrm{Pe}$ is higher, dead-zone risk rises — re-fillet.
6. **Sweep** $Q \in \{1, 2, 5, 10\}$ sccm to find the $t_{50}$-vs-$Q$ knee; pick just above it.
7. **Export** Sensors CSV + Summary CSV; record AUC, FWHM, dose uniformity.
8. **Iterate** on a single geometry parameter (fillet radius, inlet width, sensor position) and diff the CSVs.

---

*Last reviewed: 2026-04. For the most recent changes, inspect the git
log or the in-app "Quick help" section.*
