#!/usr/bin/env python3
"""
40_compute_ndsm.py - Normalized DSM Computation

Computes the normalized Digital Surface Model (nDSM = DSM - DTM).

Input:
    - data/[twins/{id}/]interim/dtm_clip.tif
    - data/[twins/{id}/]interim/dsm_clip.tif

Output:
    - data/[twins/{id}/]interim/ndsm_clip.tif

Usage:
    python 40_compute_ndsm.py --twin-id <uuid>
    python 40_compute_ndsm.py  # Uses default Blyth paths
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import rasterio
import yaml

# Paths
SCRIPT_DIR = Path(__file__).parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

# Module-level path variables (set by get_twin_paths)
_config_dir: Path = None
_interim_dir: Path = None


def get_twin_paths(twin_id: str | None) -> tuple[Path, Path]:
    """Get paths for twin-specific or default execution."""
    global _config_dir, _interim_dir

    if twin_id:
        from lib.twin_config import get_twin_config
        config = get_twin_config(twin_id)
        _config_dir = config.data_dir / "config"
        _interim_dir = config.data_dir / "interim"
    else:
        data_dir = PIPELINE_DIR.parent / "data"
        _config_dir = PIPELINE_DIR / "config"
        _interim_dir = data_dir / "interim"

    return _config_dir, _interim_dir


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    settings_file = _config_dir / "settings.yaml"
    if settings_file.exists():
        with open(settings_file) as f:
            return yaml.safe_load(f)
    # Return defaults if no settings file
    return {
        "buildings": {
            "min_height_m": 0,
            "max_height_m": 80
        }
    }


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


def main(twin_id: str | None = None):
    """Compute nDSM."""
    # Initialize paths
    get_twin_paths(twin_id)

    print("=" * 60)
    print("nDSM Computation")
    print("=" * 60)

    settings = load_settings()

    dtm_path = _interim_dir / "dtm_clip.tif"
    dsm_path = _interim_dir / "dsm_clip.tif"
    ndsm_path = _interim_dir / "ndsm_clip.tif"

    # Check inputs exist
    if not dtm_path.exists():
        print(f"DTM not found: {dtm_path}")
        print("Skipping nDSM computation (requires both DTM and DSM)")
        return 1
    if not dsm_path.exists():
        print(f"DSM not found: {dsm_path}")
        print("Skipping nDSM computation (requires both DTM and DSM)")
        return 1

    min_height = settings.get("buildings", {}).get("min_height_m", 0)
    max_height = settings.get("buildings", {}).get("max_height_m", 80)

    compute_ndsm(dtm_path, dsm_path, ndsm_path, min_height=0, max_height=max_height)

    print("\nDone!")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compute normalized DSM")
    parser.add_argument("--twin-id", help="Twin UUID for twin-specific execution")
    args = parser.parse_args()

    sys.exit(main(args.twin_id))
