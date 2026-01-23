#!/usr/bin/env python3
"""
40_compute_ndsm.py - Normalized DSM Computation

Computes the normalized Digital Surface Model (nDSM = DSM - DTM).

Input:
    - data/interim/dtm_clip.tif
    - data/interim/dsm_clip.tif

Output:
    - data/interim/ndsm_clip.tif

Usage:
    python 40_compute_ndsm.py
"""

from pathlib import Path

import numpy as np
import rasterio
import yaml

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
INTERIM_DIR = DATA_DIR / "interim"


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    with open(CONFIG_DIR / "settings.yaml") as f:
        return yaml.safe_load(f)


def compute_ndsm(dtm_path: Path, dsm_path: Path, output_path: Path, min_height: float = 0, max_height: float = 80):
    """
    Compute normalized DSM.

    nDSM = DSM - DTM, clamped to [min_height, max_height]
    """
    print("Reading DTM...")
    with rasterio.open(dtm_path) as dtm_src:
        dtm = dtm_src.read(1)
        meta = dtm_src.meta.copy()
        nodata = dtm_src.nodata

    print("Reading DSM...")
    with rasterio.open(dsm_path) as dsm_src:
        dsm = dsm_src.read(1)

    print("Computing nDSM...")
    # Handle nodata
    valid_mask = (dtm != nodata) & (dsm != nodata) if nodata else np.ones_like(dtm, dtype=bool)

    ndsm = np.where(valid_mask, dsm - dtm, nodata if nodata else 0)

    # Clamp values
    ndsm = np.clip(ndsm, min_height, max_height)
    ndsm = np.where(valid_mask, ndsm, nodata if nodata else 0)

    # Update metadata
    meta.update(dtype=rasterio.float32)

    print(f"Writing nDSM to {output_path}...")
    with rasterio.open(output_path, "w", **meta) as dst:
        dst.write(ndsm.astype(rasterio.float32), 1)

    # Statistics
    valid_ndsm = ndsm[valid_mask]
    print(f"\nStatistics:")
    print(f"  Min height: {valid_ndsm.min():.2f} m")
    print(f"  Max height: {valid_ndsm.max():.2f} m")
    print(f"  Mean height: {valid_ndsm.mean():.2f} m")
    print(f"  Pixels > 2.5m (likely buildings): {(valid_ndsm > 2.5).sum():,}")


def main():
    """Compute nDSM."""
    settings = load_settings()

    dtm_path = INTERIM_DIR / "dtm_clip.tif"
    dsm_path = INTERIM_DIR / "dsm_clip.tif"
    ndsm_path = INTERIM_DIR / "ndsm_clip.tif"

    # Check inputs exist
    if not dtm_path.exists():
        raise FileNotFoundError(f"DTM not found: {dtm_path}")
    if not dsm_path.exists():
        raise FileNotFoundError(f"DSM not found: {dsm_path}")

    min_height = settings["buildings"].get("min_height_m", 0)
    max_height = settings["buildings"]["max_height_m"]

    compute_ndsm(dtm_path, dsm_path, ndsm_path, min_height=0, max_height=max_height)

    print("\nDone!")


if __name__ == "__main__":
    main()
