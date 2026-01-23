#!/usr/bin/env python3
"""
30_prepare_rasters.py - Raster Preparation

Merges, warps, and clips LiDAR rasters to the AOI.

Input:
    - data/raw/lidar_dtm/*.tif
    - data/raw/lidar_dsm/*.tif
    - config/aoi_buffer.geojson

Output:
    - data/interim/dtm_clip.tif
    - data/interim/dsm_clip.tif

Usage:
    python 30_prepare_rasters.py
"""

import json
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
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"


def load_aoi_geometry():
    """Load buffered AOI geometry."""
    aoi_file = CONFIG_DIR / "aoi_buffer.geojson"
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

    # Merge tiles
    print("  Merging tiles...")
    mosaic, meta = merge_rasters(input_dir)

    # Clip to AOI
    print("  Clipping to AOI...")
    clip_raster(mosaic, meta, aoi_geom, output_file)


def verify_alignment(dtm_path: Path, dsm_path: Path):
    """Verify DTM and DSM have identical grids."""
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


def main():
    """Prepare rasters."""
    print("Loading AOI...")
    aoi_geom = load_aoi_geometry()

    INTERIM_DIR.mkdir(parents=True, exist_ok=True)

    dtm_output = INTERIM_DIR / "dtm_clip.tif"
    dsm_output = INTERIM_DIR / "dsm_clip.tif"

    # Process DTM
    process_raster(
        RAW_DIR / "lidar_dtm",
        dtm_output,
        aoi_geom,
        "DTM"
    )

    # Process DSM
    process_raster(
        RAW_DIR / "lidar_dsm",
        dsm_output,
        aoi_geom,
        "DSM"
    )

    # Verify alignment
    print("\nVerifying alignment...")
    verify_alignment(dtm_output, dsm_output)

    print("\nDone!")


if __name__ == "__main__":
    main()
