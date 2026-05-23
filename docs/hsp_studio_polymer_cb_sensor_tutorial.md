# HSP Studio — Designing Polymer / Carbon-Black Chemiresistive VOC Sensors

> A hands-on tutorial: from "what does this app actually compute?" to
> "pick the four polymers I should coat my electrodes with to discriminate
> ethanol from acetone from toluene from water."

---

## 1. What does HSP Studio do?

HSP Studio is an in-browser workbench for **Hansen Solubility Parameters
(HSP)** — Charles Hansen's three-component generalisation of the
Hildebrand solubility parameter:

| Symbol | Meaning                          | Units    |
| ------ | -------------------------------- | -------- |
| `δD`   | Dispersion forces (van der Waals)| MPa^½    |
| `δP`   | Dipole–dipole / polar forces     | MPa^½    |
| `δH`   | Hydrogen bonding                 | MPa^½    |

Every solvent and every polymer is a single 3-D point (or sphere). Two
materials with **similar HSP** are predicted to be mutually compatible:
the solvent dissolves the polymer, the vapour sorbs into the polymer
film, the analyte plasticises the rubber, and so on. HSP turns
"chemistry intuition" into a measurable distance.

The app gives you five tabs (Beaker icon in the sidebar):

| Tab          | What it does                                                                      |
| ------------ | --------------------------------------------------------------------------------- |
| **3-D View** | Orbit the (δD, δP, δH) cube; overlay one or more polymer spheres + every solvent. |
| **Database** | Search/sort 70 solvents with HSP, MW, density, BP, RER (relative evaporation rate). |
| **Sphere Fit** | Hand the optimiser a Yes/No solubility table and it back-fits (δD₀, δP₀, δH₀, R). |
| **Blend**    | Pick up to 8 solvents + a target HSP; returns the **volume fractions** that match it. |
| **RED**      | One-click Ra & RED of any solvent against the currently-selected polymer sphere.  |

Everything runs **in-browser** — no server, no SaaS, your data never
leaves the machine. State is auto-saved to `localStorage`.

---

## 2. Why HSP matters for polymer / carbon-black chemiresistors

A polymer/carbon-black (CB) **chemiresistor** is a sensor where:

```
       VOC vapour
           │
           ▼
   ┌──────────────────────┐
   │  Polymer matrix  ●●● │ ← conductive CB filler (≈ percolation level)
   │      ●●  ●  ●●●   ●  │
   │   ●●●  ●● ● ●●   ●● │
   └──────────────────────┘
            │     │
         Electrode  Electrode
```

When a VOC partitions into the polymer, the film **swells**, the spacing
between CB aggregates grows, and the bulk resistance rises:

```
ΔR / R₀  ∝  swelling  ∝  partition coefficient  ∝  HSP compatibility
```

Three consequences for the design problem:

1. **High sensitivity to a target analyte** ⇒ pick a polymer whose HSP is
   **close** to that analyte (small `Ra`).
2. **Selectivity** comes from the *contrast* in HSP across many polymers —
   an array of N polymers gives N independent responses to the same VOC.
3. **Cross-sensitivity** to humidity is dominated by δH; choose
   low-δH polymers if you need to suppress water response.

The classic Lewis & Grate "electronic nose" used exactly this trick —
they covered the (δD, δP, δH) space with 17 different polymers so the
response *pattern* uniquely identified each VOC.

---

## 3. The 5-minute design workflow

Open **HSP Studio** in the sidebar.

### Step 1 — Look up your target VOCs (Database tab)

Suppose we want to discriminate four breath / industrial analytes:

| VOC      | δD (MPa^½) | δP   | δH   | Class      | BP (°C) |
| -------- | ---------- | ---- | ---- | ---------- | ------- |
| Acetone  | 15.5       | 10.4 | 7.0  | ketone     | 56      |
| Ethanol  | 15.8       | 8.8  | 19.4 | alcohol    | 78      |
| Toluene  | 18.0       | 1.4  | 2.0  | aromatic   | 111     |
| Water    | 15.5       | 16.0 | 42.3 | water      | 100     |

These four sit in **four different corners** of HSP space — that's
exactly the kind of spread a well-designed array should exploit.

In HSP Studio: **Database tab → search "acetone", "ethanol", "toluene",
"water"** to confirm the values. Click each row to highlight it in the
3-D viewer.

### Step 2 — Plot them in 3-D (3-D View tab)

Switch to the **3-D View** tab. Drag to orbit. With no polymer sphere
yet, every point is just an HSP coordinate. You should see:

- Toluene tucked in the **high δD / low δP / low δH** corner.
- Water alone in the **very high δH** corner.
- Acetone in the **high δP / moderate δH** region.
- Ethanol straddling **high δH, moderate δP**.

If a sensor array can't tell these four apart, no array will.

### Step 3 — Score candidate polymers against each VOC (RED tab + sphere selector)

The polymer dropdown (top toolbar) ships with 15 reference polymer
spheres from the Hansen Handbook. Useful chemiresistor candidates and
their stock HSPs:

| Polymer                  | δD₀  | δP₀  | δH₀  | R    | Why use it                  |
| ------------------------ | ---- | ---- | ---- | ---- | --------------------------- |
| **Polyethylene (LDPE)**  | 16.9 | 0.8  | 2.8  | 8.0  | Best for non-polar VOCs (alkanes, toluene). |
| **Polyisobutylene (PIB)** *(use LDPE as proxy)* | 14–17 | 1–3 | 2–4 | 8 | Hydrophobic, low water response.|
| **PMMA**                 | 18.6 | 10.5 | 7.5  | 8.6  | Sensitive to polar/H-bond VOCs (ketones, alcohols).|
| **PVAc**                 | 20.9 | 11.3 | 9.6  | 13.7 | Big sphere → broad-band response (good "wild-card" channel).|
| **PVC**                  | 17.6 | 7.8  | 3.4  | 3.5  | Narrow sphere → sharp selectivity ring.|
| **Polyamide-66 (Nylon)** | 18.6 | 5.1  | 12.2 | 10.0 | High δH₀ → preferential for alcohols + water.|
| **Cellulose acetate**    | 18.6 | 12.7 | 11.0 | 7.6  | Polar/H-bond zone, useful for breath analytes.|

For each candidate polymer, switch the **Sphere** dropdown in the top
toolbar — now go to the **RED tab** and read off Ra & RED for every
analyte. RED below is computed against the resolved sphere.

#### Predicted RED matrix for the 4-VOC × 5-polymer panel

(Calculated with HSP Studio's `RED` tab. **RED < 1 ⇒ strong swelling
expected**; **RED ≈ 1 ⇒ borderline / mild swelling**; **RED ≫ 1 ⇒ tiny
response**.)

|              | LDPE  | PMMA  | PVAc  | PVC   | Nylon-66 |
| ------------ | ----- | ----- | ----- | ----- | -------- |
| **Acetone**  | 1.36  | 0.72  | 0.81  | 1.75  | 0.97     |
| **Ethanol**  | 2.32  | 1.54  | 1.05  | 4.69  | 0.98     |
| **Toluene**  | 0.30  | 1.24  | 1.00  | 1.89  | 1.09     |
| **Water**    | 5.30  | 4.16  | 2.54  | 11.42 | 3.26     |

Reading the matrix (numbers verified against the app's own RED tab —
`Sphere selector → polymer → RED → solvent`):

- **LDPE** lights up dramatically for **toluene** (RED 0.30 — well
  inside the sphere) and rejects every polar VOC. Perfect "non-polar"
  channel.
- **PMMA** prefers **acetone** (RED 0.72, inside) and weakly responds to
  toluene/ethanol — the classic mid-polar channel.
- **PVAc** is the broad-band channel — its big R = 13.7 sphere makes
  it sensitive to **acetone, ethanol, and toluene**, all on the edge of
  the sphere.
- **PVC** has a sharp narrow sphere (R = 3.5) — most VOCs sit outside.
  Useful as a *reference / null* channel.
- **Nylon-66** is right at the edge for **ethanol** and **acetone**
  (RED ≈ 1) but rejects toluene; high δH₀ makes it the most water-
  sensitive of the five (RED 3.26 is the smallest in that column).

That's already a **discrimination matrix** suitable for principal-
component analysis or simple linear discriminant analysis. Note that
**every analyte has a different "winner" polymer** — that's the
hallmark of a well-chosen array.

### Step 4 — Maximise diversity (3-D View tab)

Re-open the 3-D View, switch to a custom sphere, and tick each polymer
in turn. Visually you want the polymer centres **spread out** in
(δD, δP, δH). The five above cover:

- Low-polar corner (LDPE, low δP, low δH)
- Mid-polar (PMMA, PVC)
- High δP (PVAc, Cellulose acetate)
- High δH (Nylon)

If two polymers' spheres almost overlap, they'll give nearly the same
response — wasted channel. Use the 3-D viewer to spot redundancy.

### Step 5 — Fit your own polymer with experimental data (Sphere Fit tab)

You'll usually want to **measure** rather than trust handbook spheres.
Procedure:

1. Cast the polymer + CB composite on a QCM or interdigitated
   electrode.
2. Expose it to 10–20 solvent vapours at a fixed activity (or briefly
   immerse the film in liquid solvents to bracket the response).
3. For each solvent record **Good** (large response, > some threshold)
   or **Bad** (no response).
4. Paste the list into the **Sphere Fit** tab (the default rows are a
   sensible starter set).
5. Click **Fit sphere**.

HSP Studio runs Hansen's classical objective —

```
FIT = (Π Aᵢ)^(1/N)
Aᵢ = 1                if classification matches
Aᵢ = exp(R − Raᵢ)     if good outside sphere (penalty)
Aᵢ = exp(Raᵢ − R)     if bad inside sphere (penalty)
```

— and returns:

| Output                  | What it tells you                                  |
| ----------------------- | -------------------------------------------------- |
| `δD₀, δP₀, δH₀`         | Your **polymer's HSP centre** (use for sphere selector).|
| `R`                     | The interaction radius (large R → soft / swellable polymer).|
| `Fit (0–1)`             | 1.0 = perfect classification; below ~0.85 indicates the polymer probably doesn't fit a sphere model well (e.g. crystalline polymers).|
| Misclassified good/bad  | How many points each "wrong" side; tells you which solvents disagreed with the fit.|

Click **Use as active sphere** to push the fitted sphere into the 3-D
view and the RED matrix. Re-run Step 3 and you get a discrimination
matrix calibrated to **your** specific polymer/CB film, not a textbook
value.

### Step 6 — Design a custom polymer blend (Blend tab)

Sometimes you can't find an off-the-shelf polymer whose HSP centre is
exactly where you want it. The Blend tab lets you mix solvents —
useful for two sensor-design tasks:

1. **Calibration vapour generator**: you want a vapour atmosphere that
   sits at a particular point in HSP space (e.g. the centre of your
   polymer's sphere). Pick the centre as the **target**, click
   **Use active sphere**, add 4–8 solvents, hit **Optimise blend**.
2. **Co-polymer / plasticiser blending**: although the math is
   strictly for liquid blends, the same volume-fraction-weighted
   mixing rule applies *roughly* to polymer blends. Pick two
   polymers' HSP triplets, choose a target, and read off the
   approximate blending ratio.

The optimiser uses **projected-gradient descent on the unit simplex**:

```
minimise   |HSP_blend − target|²   subject to   Σ φᵢ = 1,   φᵢ ≥ 0
```

It also produces a **grams-per-100 g recipe** using each solvent's
density, so you can hand the list to a balance and start pipetting.

---

## 4. What the parameters mean (cheat-sheet)

| Calculated | Formula                                                            | Why it matters for chemiresistor design |
| ---------- | ------------------------------------------------------------------ | --------------------------------------- |
| `Ra`       | `√(4(δD−δD₀)² + (δP−δP₀)² + (δH−δH₀)²)`                            | "Hansen distance" between solvent & polymer. The factor of 4 on dispersion is Hansen's empirical correction (without it the sphere collapses to an ellipsoid). **Small Ra ⇒ vapour sorbs strongly ⇒ big ΔR**. |
| `RED`      | `Ra / R`                                                           | Normalised distance. **< 1 = inside the sphere = predicted "soluble" = strong response.** Lets you compare polymers with different R on the same scale. |
| `δt`       | `√(δD² + δP² + δH²)`                                               | The old single-number Hildebrand parameter. **Misleading on its own** — Hansen exists precisely because two materials can have the same δt but very different sorption. Shown for reference. |
| Blend HSP  | `δX_blend = Σ φᵢ · δXᵢ`                                            | Volume-fraction-weighted; assumes ideal mixing. Useful for plasticisers, calibration mixes, and rough polymer-blend estimates. |
| Sphere fit | `argmax_{δD₀,δP₀,δH₀,R} (Π Aᵢ)^(1/N)`                              | Recovers a polymer's solubility sphere from binary swelling experiments — the most useful tab if you've actually run lab measurements. |

### What changes with environment

- **Temperature**: HSPs vary mildly with T (≈ a few % per 50 K). The
  app treats them as constants; for sensor work at near-ambient T this
  is fine.
- **Humidity**: water has the highest δH in the database — if your
  application is breath analysis (≈ 100 % RH), the water response will
  dominate any sensor with significant δH. Pick low-δH polymers (LDPE,
  PIB, polysiloxanes) for humidity rejection, or use a high-δH polymer
  *deliberately* as a humidity reference channel.
- **Polymer state**: HSP assumes the polymer is amorphous and above
  Tg. Crystalline / glassy polymers swell less than HSP predicts —
  treat the predicted RED as an upper bound on sorption.

---

## 5. Practical recipe for a 4-element VOC-discrimination array

Inputs: target analytes = {Acetone, Ethanol, Toluene, Water}.
Outputs: 4-polymer array + expected response pattern.

1. **Open HSP Studio → Database → search & note each analyte's HSP.**
2. **3-D View** — confirm the four analytes are spread out (they are).
3. **Sphere selector → cycle each candidate polymer**; on the RED tab
   record `RED(VOC, polymer)`.
4. **Pick four polymers** that maximise the *condition number* of the
   RED matrix — informally, no two columns should look the same.
   A clean choice from the table above is **{LDPE, PMMA, PVAc, Nylon-66}**:
   - LDPE → toluene-dominant.
   - PMMA → acetone-dominant.
   - PVAc → broad polar (acetone + ethanol).
   - Nylon-66 → ethanol/water-dominant.
5. **Estimate sensitivities**: a useful first-order proxy is

   ```
   sensitivity ∝ exp(−Ra² / 2σ²)
   ```

   with σ ≈ R / √3, so an RED of 0.7 gives ≈ 79 % of the maximum
   response; an RED of 1.5 gives ≈ 11 %. The RED matrix above already
   carries that information.
6. **Make a prototype**: spin-coat each polymer (with ~30 wt% CB N220
   or vapour-deposited gold) onto interdigitated electrodes, expose
   the device to fixed-concentration vapours of each VOC, and check
   that the **observed response ranking** matches the matrix. If it
   doesn't, the polymer's real sphere is different from the
   handbook value — go back to the **Sphere Fit** tab with your data
   and re-fit it.

---

## 6. Worked numerical example (reproduce in the app)

To make sure your local instance is computing the same numbers as this
tutorial, sanity-check these two values in the RED tab:

| Action                                              | Expected output |
| --------------------------------------------------- | --------------- |
| Sphere = **PMMA**, RED tab, solvent = **Acetone**   | `Ra ≈ 6.22`, `RED ≈ 0.72`. PMMA dissolves in acetone — the classic textbook result. |
| Sphere = **Polyethylene (LDPE)**, solvent = **Toluene** | `Ra ≈ 2.42`, `RED ≈ 0.30`. Toluene is the ideal LDPE-channel analyte (well inside the sphere). |
| Sphere = **PMMA**, solvent = **n-Hexane** | `Ra ≈ 14.87`, `RED ≈ 1.73`. n-Hexane is well outside the PMMA sphere — PMMA won't sense it. |

Anything within ±0.02 of those is healthy — the small variation comes
from the rounded HSP literature values shipped in the database.

---

## 7. Where to go next

- **VOC mixtures**: load each pure VOC into the **Blend** tab (set
  φᵢ ≈ partial pressure fractions you expect in the application) and
  read off the *effective* HSP of the mixture. Then look up RED for
  each polymer against that effective point — first-pass prediction
  for selectivity in real, multi-component breath/air samples.
- **Inverse design**: fit several candidate polymers in **Sphere Fit**,
  then use the **3-D View** to spot gaps in your coverage of the
  analyte cloud. Synthesise a new co-polymer aimed at the gap.
- **Cross-validate with literature**: compare predicted RED rankings to
  e-nose datasets in the JPL/NASA bibliography in `docs/` — those papers
  contain measured ΔR/R₀ vs HSP for many polymer/VOC pairs.

---

## 8. Reference

- Hansen, *Hansen Solubility Parameters: A User's Handbook*, 2nd ed.,
  CRC Press, 2007.
- Lewis, et al., *Sensors based on polymer–carbon-black composites*, in
  *Handbook of Machine Olfaction*, Wiley-VCH.
- Hansen-solubility.com — HSPiP commercial software:
  <https://www.hansen-solubility.com/HSPiP/>

The HSP Studio app in this repo is a small, open re-implementation of
the HSP workflows that are useful for sensor-array design; it does **not**
include HSPiP's proprietary group-contribution engines (Y-MB,
Stefanis–Panayiotou) or VLE/azeotrope predictor.

