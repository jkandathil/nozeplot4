#!/usr/bin/env python3
"""
Generalized FeNOse-style CSV augmentation (baseline + scaled response + noise).

- Works with any workspace layout: pass globs or directories.
- Sensor columns: standard A1–H8 grid, or any columns matching /^[A-H][1-8]$/i present in the file.
- Device / AU grouping: extracts tokens ##########-####-<tag>-nz from the basename (prefers -asu-nz).
- Replicates: generate N synthetic files per source CSV (same as ML Studio “replicates per ppb” when one file encodes one concentration).

Example:
  python augment_fenose_general.py --input "../Raw_data/**/*.csv" --output ./synth_out --replicates 5
  python augment_fenose_general.py --input "./45/*.csv" --output ./Synth-45 --replicates 10 --au-unit 0000000045-0926-ASU-NZ
"""

from __future__ import annotations

import argparse
import os
import re
from glob import glob
from typing import Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

# Same event filter as generate_all_synthetic.py (curated FeNOse phases)
DEFAULT_VALID_EVENTS = (
    "AmbientSamplingRFC",
    "BreathSampleCollection",
    "FeNOWindow",
    "FeNOMeasurement",
)

# Same rules as fenoseModel.js: do not use \w boundaries (underscore adjoins digits in filenames).
DEVICE_TOKEN_RE = re.compile(
    r"(?<![0-9])(\d{10}-\d{4}-[a-z0-9]+-nz)(?![A-Za-z0-9])",
    re.IGNORECASE,
)


def parse_device_id_from_basename(basename: str) -> str:
    """Match JS parseFenoseDeviceIdFromFilename: prefer -asu-nz when multiple tokens exist."""
    found = DEVICE_TOKEN_RE.findall(basename or "")
    if not found:
        return "UNKNOWN"
    for t in found:
        if t.lower().endswith("-asu-nz"):
            return t.upper()
    return found[0].upper()


def discover_sensor_columns(df: pd.DataFrame) -> List[str]:
    """Use A1–H8 columns that exist in the frame (order A1..H8)."""
    grid = [f"{chr(r)}{c}" for r in range(ord("A"), ord("I")) for c in range(1, 9)]
    return [c for c in grid if c in df.columns]


def augment_dataframe(
    df: pd.DataFrame,
    sensor_cols: Sequence[str],
    valid_events: Iterable[str] = DEFAULT_VALID_EVENTS,
    rng: Optional[np.random.Generator] = None,
) -> Optional[pd.DataFrame]:
    """Return augmented copy of filtered df, or None if no rows after filter."""
    if rng is None:
        rng = np.random.default_rng()
    ev = set(valid_events)
    out = df[df["event_name"].isin(ev)].copy()
    if len(out) == 0:
        return None
    for col in sensor_cols:
        if col not in out.columns:
            continue
        real_curve = out[col].values.astype(float, copy=False)
        ambient_data = out.loc[out["event_name"] == "AmbientSamplingRFC", col].values.astype(
            float, copy=False
        )
        if len(ambient_data) > 0:
            r_base = float(np.mean(ambient_data))
        else:
            r_base = float(np.mean(real_curve[:50])) if len(real_curve) > 50 else float(np.mean(real_curve))
        response_shape = real_curve - r_base
        synth_base = r_base * rng.normal(1.0, 0.02)
        synth_response = response_shape * rng.normal(1.0, 0.10)
        noise = rng.normal(0, max(0.1, abs(r_base) * 0.001), len(real_curve))
        out[col] = synth_base + synth_response + noise
    return out


def augment_file(
    real_filepath: str,
    output_dir: str,
    n_samples: int,
    valid_events: Iterable[str] = DEFAULT_VALID_EVENTS,
    base_seed: int = 0,
    file_index: int = 0,
) -> int:
    """
    Write n_samples augmented CSVs next to structured names.
    Returns number of files written.
    """
    df_orig = pd.read_csv(real_filepath)
    sensor_cols = discover_sensor_columns(df_orig)
    if not sensor_cols:
        print(f"Skip (no A1–H8 columns): {real_filepath}")
        return 0
    base_name = os.path.basename(real_filepath).replace(".csv", "")
    written = 0
    for i in range(n_samples):
        seed = (base_seed + file_index * 9973 + i * 31) & 0xFFFFFFFF
        rng = np.random.default_rng(seed)
        synth_df = augment_dataframe(df_orig, sensor_cols, valid_events, rng)
        if synth_df is None:
            print(f"Skip (no rows after event filter): {real_filepath}")
            return written
        out_file = os.path.join(output_dir, f"{base_name}_synth_{i + 1:03d}.csv")
        synth_df.to_csv(out_file, index=False)
        written += 1
    return written


def collect_inputs(patterns: Sequence[str]) -> List[str]:
    paths: List[str] = []
    for p in patterns:
        if os.path.isdir(p):
            paths.extend(sorted(glob(os.path.join(p, "*.csv"))))
        else:
            paths.extend(sorted(glob(p, recursive=True)))
    # de-dupe, stable
    seen = set()
    uniq: List[str] = []
    for x in paths:
        if x not in seen and x.lower().endswith(".csv"):
            seen.add(x)
            uniq.append(x)
    return uniq


def filter_by_au(paths: Sequence[str], au_want: Optional[str]) -> List[str]:
    if not au_want:
        return list(paths)
    au_upper = au_want.strip().upper()
    out = []
    for p in paths:
        if parse_device_id_from_basename(os.path.basename(p)) == au_upper:
            out.append(p)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Generalized FeNOse CSV augmentation by AU / replicates.")
    ap.add_argument(
        "--input",
        nargs="+",
        required=True,
        help="CSV files, globs (use ** for recursive), and/or directories containing .csv",
    )
    ap.add_argument("--output", required=True, help="Output directory (created if missing)")
    ap.add_argument(
        "--replicates",
        type=int,
        default=5,
        help="Number of synthetic CSVs per input file (default 5)",
    )
    ap.add_argument(
        "--seed",
        type=int,
        default=0,
        help="Base RNG seed (default 0)",
    )
    ap.add_argument(
        "--au-unit",
        default=None,
        metavar="ID",
        help="Only process files whose basename contains this AU id (e.g. 0000000063-0926-ASU-NZ)",
    )
    args = ap.parse_args()
    n_samples = max(1, min(500, int(args.replicates)))
    os.makedirs(args.output, exist_ok=True)

    paths = collect_inputs(args.input)
    paths = filter_by_au(paths, args.au_unit)
    if not paths:
        print("No CSV files matched. Check --input and optional --au-unit.")
        return

    total = 0
    for idx, fp in enumerate(paths):
        dev = parse_device_id_from_basename(os.path.basename(fp))
        n = augment_file(fp, args.output, n_samples, base_seed=int(args.seed), file_index=idx)
        total += n
        print(f"[{dev}] {os.path.basename(fp)} -> {n} synthetic file(s)")

    print(f"\nDone. Wrote {total} file(s) under {args.output!r}.")


if __name__ == "__main__":
    main()
