# Synthetic / augmented FeNOse CSV helpers

| Script | Role |
|--------|------|
| `augment_fenose_general.py` | **General entry**: globs or folders, optional `--au-unit`, configurable `--replicates`, discovers `A1`–`H8` columns, same event filter as bulk scripts. |
| `generate_all_synthetic.py` | Batch augment per device folder `45` / `54` (fixed layout). |
| `generate_synthetic_fenose.py` | Parametric curve demo + single-file plot. |

The web app’s **ML Studio → Synthetic demo dataset** uses browser-side generation (`src/utils/fenoseSyntheticDataset.js`); device ids in filenames follow `##########-####-<tag>-nz` with preference for `-asu-nz` when multiple tokens exist (see `parseFenoseDeviceIdFromFilename` in `src/utils/fenoseModel.js`).

Example (CLI augmentation):

```bash
python augment_fenose_general.py --input "./45/*.csv" --output ./Synth-out --replicates 10
python augment_fenose_general.py --input "../path/to/files/**/*.csv" --output ./Synth-out --replicates 5 --au-unit 0000000063-0926-ASU-NZ
```
