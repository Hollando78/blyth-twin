#!/usr/bin/env python3
"""
70_pack_assets.py - Asset Packing

Compresses assets and generates manifest for web delivery.

Input:
    - data/processed/terrain/*.glb
    - data/processed/buildings/*.glb

Output:
    - dist/blyth_mvp_v1/assets/ (compressed GLB files)
    - dist/blyth_mvp_v1/manifest.json

Usage:
    python 70_pack_assets.py
"""

import gzip
import json
import shutil
from pathlib import Path
from datetime import datetime

import yaml

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
DIST_DIR = SCRIPT_DIR.parent.parent / "dist" / "blyth_mvp_v1"


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    with open(CONFIG_DIR / "settings.yaml") as f:
        return yaml.safe_load(f)


def load_aoi_info() -> dict:
    """Load AOI information for manifest."""
    with open(CONFIG_DIR / "aoi.geojson") as f:
        aoi = json.load(f)
    return aoi["features"][0]["properties"]


def compress_file(src: Path, dst: Path, use_gzip: bool = True):
    """Copy or gzip compress a file."""
    if use_gzip:
        dst = dst.with_suffix(dst.suffix + ".gz")
        with open(src, "rb") as f_in:
            with gzip.open(dst, "wb") as f_out:
                shutil.copyfileobj(f_in, f_out)
    else:
        shutil.copy2(src, dst)
    return dst


def pack_assets(input_dir: Path, output_dir: Path, asset_type: str, compress: bool, chunk_size: float) -> list[dict]:
    """Pack assets from a directory."""
    assets = []

    glb_files = sorted(input_dir.glob("*.glb"))
    if not glb_files:
        print(f"  No GLB files found in {input_dir}")
        return assets

    for glb_file in glb_files:
        # Extract chunk ID from filename (e.g., "buildings_0_1.glb" -> "0_1")
        chunk_id = glb_file.stem.replace(f"{asset_type}_", "")

        # Parse chunk coordinates for bounding box
        try:
            parts = chunk_id.split("_")
            chunk_x = int(parts[0])
            chunk_y = int(parts[1])
            # Bounding box in local coordinates (relative to origin)
            bbox = {
                "min_x": chunk_x * chunk_size,
                "min_y": chunk_y * chunk_size,
                "max_x": (chunk_x + 1) * chunk_size,
                "max_y": (chunk_y + 1) * chunk_size
            }
        except (IndexError, ValueError):
            bbox = None

        # Compress and copy
        output_file = output_dir / glb_file.name
        final_file = compress_file(glb_file, output_file, compress)

        # Get file size
        file_size = final_file.stat().st_size

        asset_info = {
            "id": chunk_id,
            "type": asset_type,
            "url": f"assets/{final_file.name}",
            "size_bytes": file_size,
            "compressed": compress
        }
        if bbox:
            asset_info["bbox"] = bbox

        assets.append(asset_info)

    print(f"  Packed {len(glb_files)} {asset_type} files")

    return assets


def generate_manifest(assets: list[dict], aoi_info: dict, settings: dict) -> dict:
    """Generate asset manifest."""
    return {
        "version": settings["project"]["version"],
        "name": settings["project"]["name"],
        "generated": datetime.utcnow().isoformat() + "Z",
        "origin": {
            "crs": "EPSG:27700",
            "x": aoi_info["centre_bng"][0],
            "y": aoi_info["centre_bng"][1],
            "note": "All mesh coordinates are relative to this origin"
        },
        "aoi": {
            "centre_wgs84": aoi_info["centre_wgs84"],
            "side_length_m": aoi_info["side_length_m"]
        },
        "assets": assets
    }


def main():
    """Pack assets for web delivery."""
    settings = load_settings()
    compress = settings["output"]["compress"]

    print("Loading AOI info...")
    aoi_info = load_aoi_info()

    # Create output directories
    assets_dir = DIST_DIR / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    all_assets = []

    chunk_size = settings["terrain"]["chunk_size_m"]

    # Pack terrain
    terrain_dir = PROCESSED_DIR / "terrain"
    if terrain_dir.exists():
        print("\nPacking terrain assets...")
        terrain_assets = pack_assets(terrain_dir, assets_dir, "terrain", compress, chunk_size)
        all_assets.extend(terrain_assets)

    # Pack buildings
    buildings_dir = PROCESSED_DIR / "buildings"
    if buildings_dir.exists():
        print("\nPacking building assets...")
        building_assets = pack_assets(buildings_dir, assets_dir, "buildings", compress, chunk_size)
        all_assets.extend(building_assets)

    # Generate manifest
    print("\nGenerating manifest...")
    manifest = generate_manifest(all_assets, aoi_info, settings)

    manifest_file = DIST_DIR / "manifest.json"
    with open(manifest_file, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Written: {manifest_file}")

    print(f"\nSummary:")
    print(f"  Total assets: {len(all_assets)}")
    print(f"  Output directory: {DIST_DIR}")

    print("\nDone!")


if __name__ == "__main__":
    main()
