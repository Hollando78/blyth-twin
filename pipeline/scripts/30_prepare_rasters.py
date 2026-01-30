#!/usr/bin/env python3
"""
30_prepare_rasters.py - Raster Preparation

Merges, warps, and clips LiDAR rasters to the AOI.

Input:
    - data/[twins/{id}/]raw/lidar_dtm/*.tif
    - data/[twins/{id}/]raw/lidar_dsm/*.tif
    - config/aoi_buffer.geojson

Output:
    - data/[twins/{id}/]interim/dtm_clip.tif
    - data/[twins/{id}/]interim/dsm_clip.tif

Usage:
    python 30_prepare_rasters.py --twin-id <uuid>
    python 30_prepare_rasters.py  # Uses default Blyth paths
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.mask import mask
from rasterio.warp import calculate_default_transform, reproject, Resampling
from shapely.geometry import shape
import yaml

# Paths
SCRIPT_DIR = Path(__file__).parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

# Module-level path variables (set by get_twin_paths)
_config_dir: Path = None
_raw_dir: Path = None
_interim_dir: Path = None


def get_twin_paths(twin_id: str | None) -> tuple[Path, Path, Path]:
    """Get paths for twin-specific or default execution."""
    global _config_dir, _raw_dir, _interim_dir

    if twin_id:
        from lib.twin_config import get_twin_config
        config = get_twin_config(twin_id)
        _config_dir = config.data_dir / "config"
        _raw_dir = config.data_dir / "raw"
        _interim_dir = config.data_dir / "interim"
    else:
        data_dir = PIPELINE_DIR.parent / "data"
        _config_dir = PIPELINE_DIR / "config"
        _raw_dir = data_dir / "raw"
        _interim_dir = data_dir / "interim"

    return _config_dir, _raw_dir, _interim_dir


def load_aoi_geometry():
    """Load buffered AOI geometry."""
    aoi_file = _config_dir / "aoi_buffer.geojson"
    if not aoi_file.exists():
        aoi_file = _config_dir / "aoi.geojson"

    with open(aoi_file) as f:
        aoi = json.load(f)
    return [aoi["features"][0]["geometry"]]


def merge_rasters(input_dir: Path) -> tuple:
    """Merge multiple raster tiles."""
    tif_files = list(input_dir.glob("*.tif"))
    if not tif_files:
        raise FileNotFoundError(f"No .tif files found in {input_dir}")

    print(f"  Found {len(tif_files)} tiles")

    src_files = [rasterio.open(f) for f in tif_files]
    mosaic, out_transform = merge(src_files)

    # Get metadata from first file
    out_meta = src_files[0].meta.copy()
    out_meta.update({
        "height": mosaic.shape[1],
        "width": mosaic.shape[2],
        "transform": out_transform
    })

    for src in src_files:
        src.close()

    return mosaic, out_meta


def clip_raster(raster: np.ndarray, meta: dict, geometries: list, output_path: Path):
    """Clip raster to geometry and save."""
    # Create temporary in-memory file for clipping
    with rasterio.MemoryFile() as memfile:
        with memfile.open(**meta) as src:
            src.write(raster)

        with memfile.open() as src:
            clipped, clipped_transform = mask(src, geometries, crop=True)
            clipped_meta = src.meta.copy()
            clipped_meta.update({
                "height": clipped.shape[1],
                "width": clipped.shape[2],
                "transform": clipped_transform
            })

    # Write output
    with rasterio.open(output_path, "w", **clipped_meta) as dst:
        dst.write(clipped)

    print(f"  Written: {output_path}")
    print(f"  Shape: {clipped.shape[1]} x {clipped.shape[2]}")


def process_raster(input_dir: Path, output_file: Path, aoi_geom: list, name: str):
    """Full processing pipeline for a raster dataset."""
    print(f"\nProcessing {name}...")

    if not input_dir.exists():
        print(f"  Input directory not found: {input_dir}")
        return False

    tif_files = list(input_dir.glob("*.tif"))
    if not tif_files:
        print(f"  No .tif files found in {input_dir}")
        return False

    # Merge tiles
    print("  Merging tiles...")
    mosaic, meta = merge_rasters(input_dir)

    # Clip to AOI
    print("  Clipping to AOI...")
    clip_raster(mosaic, meta, aoi_geom, output_file)
    return True


def verify_alignment(dtm_path: Path, dsm_path: Path):
    """Verify DTM and DSM have identical grids."""
    if not dtm_path.exists() or not dsm_path.exists():
        print("  Skipping alignment check (one or both files missing)")
        return True

    with rasterio.open(dtm_path) as dtm, rasterio.open(dsm_path) as dsm:
        dtm_shape = (dtm.height, dtm.width)
        dsm_shape = (dsm.height, dsm.width)

        if dtm_shape != dsm_shape:
            print(f"  WARNING: Shape mismatch - DTM: {dtm_shape}, DSM: {dsm_shape}")
            return False

        if dtm.transform != dsm.transform:
            print(f"  WARNING: Transform mismatch")
            return False

        if dtm.crs != dsm.crs:
            print(f"  WARNING: CRS mismatch")
            return False

        print(f"  Verified: Identical extent, resolution, and CRS")
        print(f"  Shape: {dtm_shape}")
        print(f"  Resolution: {dtm.res}")
        print(f"  CRS: {dtm.crs}")
        return True


def main(twin_id: str | None = None):
    """Prepare rasters."""
    # Initialize paths
    get_twin_paths(twin_id)

    print("=" * 60)
    print("Raster Preparation")
    print("=" * 60)

    print("Loading AOI...")
    try:
        aoi_geom = load_aoi_geometry()
    except FileNotFoundError as e:
        print(f"ERROR: {e}")
        return 1

    _interim_dir.mkdir(parents=True, exist_ok=True)

    dtm_output = _interim_dir / "dtm_clip.tif"
    dsm_output = _interim_dir / "dsm_clip.tif"

    dtm_success = False
    dsm_success = False

    # Process DTM
    dtm_success = process_raster(
        _raw_dir / "lidar_dtm",
        dtm_output,
        aoi_geom,
        "DTM"
    )

    # Process DSM (optional)
    dsm_success = process_raster(
        _raw_dir / "lidar_dsm",
        dsm_output,
        aoi_geom,
        "DSM"
    )

    if dtm_success and dsm_success:
        # Verify alignment
        print("\nVerifying alignment...")
        verify_alignment(dtm_output, dsm_output)
    elif dtm_success:
        print("\nDTM processed, DSM skipped")
    else:
        print("\nNo LiDAR rasters to process")
        return 1

    print("\nDone!")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare LiDAR rasters")
    parser.add_argument("--twin-id", help="Twin UUID for twin-specific execution")
    args = parser.parse_args()

    sys.exit(main(args.twin_id))
