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
    python 70_pack_assets.py --twin-id <uuid>
"""

import argparse
import gzip
import json
import shutil
import subprocess
import sys
from pathlib import Path
from datetime import datetime

import yaml

# Draco compression settings
DRACO_ENABLED = False  # Disabled for now - enable after caching npx package
DRACO_QUANTIZE_POSITION = 14  # bits for position quantization
DRACO_QUANTIZE_NORMAL = 10   # bits for normal quantization
DRACO_QUANTIZE_TEXCOORD = 12 # bits for texcoord quantization

# Additional files to copy (not GLB assets)
EXTRA_FILES = [
    ("footprints_metadata.json", "footprints_metadata.json"),
    ("buildings_metadata.json", "buildings_metadata.json"),
]

# Texture files to copy
TEXTURE_FILES = [
    "facade_atlas.png",
    "facade_normal_atlas.png",
    "facade_atlas_meta.json",
]

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
DIST_DIR = SCRIPT_DIR.parent.parent / "dist" / "blyth_mvp_v1"

# Module-level paths
_config_dir = CONFIG_DIR
_processed_dir = PROCESSED_DIR
_dist_dir = DIST_DIR


def get_twin_paths(twin_id: str):
    """Get paths for twin-specific execution."""
    global _config_dir, _processed_dir, _dist_dir
    sys.path.insert(0, str(SCRIPT_DIR.parent))
    from lib.twin_config import get_twin_config
    config = get_twin_config(twin_id)
    _config_dir = config.config_dir
    _processed_dir = config.processed_dir
    _dist_dir = config.dist_dir
    config.ensure_directories()
    return config


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    with open(_config_dir / "settings.yaml") as f:
        return yaml.safe_load(f)


def load_aoi_info() -> dict:
    """Load AOI information for manifest."""
    with open(_config_dir / "aoi.geojson") as f:
        aoi = json.load(f)
    return aoi["features"][0]["properties"]


def apply_draco_compression(src: Path, dst: Path) -> bool:
    """
    Apply Draco compression to a GLB file using gltf-transform.

    Returns True on success, False on failure.
    """
    if not DRACO_ENABLED:
        return False

    try:
        cmd = [
            "npx", "--yes", "@gltf-transform/cli", "draco",
            str(src), str(dst),
            f"--quantize-position={DRACO_QUANTIZE_POSITION}",
            f"--quantize-normal={DRACO_QUANTIZE_NORMAL}",
            f"--quantize-texcoord={DRACO_QUANTIZE_TEXCOORD}",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        if result.returncode == 0 and dst.exists():
            return True
        else:
            if result.stderr:
                print(f"    Draco warning: {result.stderr[:100]}")
            return False

    except subprocess.TimeoutExpired:
        print("    Draco timeout")
        return False
    except Exception as e:
        print(f"    Draco error: {e}")
        return False


def compress_file(src: Path, dst: Path, use_gzip: bool = True, use_draco: bool = True):
    """Copy, optionally Draco compress, and optionally gzip compress a file."""

    # Apply Draco compression first if enabled and file is GLB
    if use_draco and DRACO_ENABLED and src.suffix.lower() == ".glb":
        draco_dst = dst.parent / f"{dst.stem}_draco.glb"
        if apply_draco_compression(src, draco_dst):
            src = draco_dst
            # Log compression ratio
            orig_size = dst.parent / src.name if not draco_dst.exists() else src

    if use_gzip:
        dst = dst.with_suffix(dst.suffix + ".gz")
        with open(src, "rb") as f_in:
            with gzip.open(dst, "wb") as f_out:
                shutil.copyfileobj(f_in, f_out)
        # Clean up intermediate Draco file
        if use_draco and DRACO_ENABLED and src.name.endswith("_draco.glb"):
            src.unlink()
    else:
        if src != dst:
            shutil.copy2(src, dst)
        # Clean up intermediate Draco file
        if use_draco and DRACO_ENABLED and src.name.endswith("_draco.glb"):
            if src != dst:
                src.unlink()
    return dst


def pack_buildings_hybrid(textured_dir: Path, detailed_dir: Path, original_dir: Path,
                          output_dir: Path, compress: bool, chunk_size: float) -> list[dict]:
    """
    Pack building assets using hybrid approach:
    - Use textured meshes where available (from Meshy AI)
    - Fall back to detailed meshes (procedural roofs)
    - Fall back to original meshes (flat roofs)
    """
    assets = []

    # Collect all chunk IDs from all sources
    chunk_ids = set()
    for dir_path in [textured_dir, detailed_dir, original_dir]:
        if dir_path and dir_path.exists():
            for f in dir_path.glob("buildings_*.glb"):
                chunk_id = f.stem.replace("buildings_", "")
                chunk_ids.add(chunk_id)

    print(f"  Found {len(chunk_ids)} building chunks")

    textured_count = 0
    detailed_count = 0
    original_count = 0

    for chunk_id in sorted(chunk_ids):
        # Priority: textured > detailed > original
        textured_file = textured_dir / f"buildings_{chunk_id}.glb" if textured_dir and textured_dir.exists() else None
        detailed_file = detailed_dir / f"buildings_{chunk_id}.glb" if detailed_dir and detailed_dir.exists() else None
        original_file = original_dir / f"buildings_{chunk_id}.glb" if original_dir and original_dir.exists() else None

        source_file = None
        if textured_file and textured_file.exists():
            source_file = textured_file
            textured_count += 1
        elif detailed_file and detailed_file.exists():
            source_file = detailed_file
            detailed_count += 1
        elif original_file and original_file.exists():
            source_file = original_file
            original_count += 1

        if source_file is None:
            continue

        # Parse chunk coordinates for bounding box
        try:
            parts = chunk_id.split("_")
            chunk_x = int(parts[0])
            chunk_y = int(parts[1])
            bbox = {
                "min_x": chunk_x * chunk_size,
                "min_y": chunk_y * chunk_size,
                "max_x": (chunk_x + 1) * chunk_size,
                "max_y": (chunk_y + 1) * chunk_size
            }
        except (IndexError, ValueError):
            bbox = None

        # Compress and copy
        output_file = output_dir / source_file.name
        final_file = compress_file(source_file, output_file, compress)
        file_size = final_file.stat().st_size

        asset_info = {
            "id": chunk_id,
            "type": "buildings",
            "url": f"assets/{final_file.name}",
            "size_bytes": file_size,
            "compressed": compress
        }
        if bbox:
            asset_info["bbox"] = bbox

        assets.append(asset_info)

    print(f"  Packed: {textured_count} textured, {detailed_count} detailed, {original_count} original")
    return assets


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
            "side_length_m": aoi_info["side_length_m"],
            "buffer_m": aoi_info.get("buffer_m") or settings.get("aoi", {}).get("buffer_m", 0)
        },
        "assets": assets
    }


def main(twin_id: str = None):
    """Pack assets for web delivery."""
    if twin_id:
        print(f"Twin mode: {twin_id}")
        get_twin_paths(twin_id)

    settings = load_settings()
    compress = settings["output"]["compress"]

    print("Loading AOI info...")
    aoi_info = load_aoi_info()

    # Create output directories
    assets_dir = _dist_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    all_assets = []

    chunk_size = settings["terrain"]["chunk_size_m"]

    # Pack terrain
    terrain_dir = _processed_dir / "terrain"
    if terrain_dir.exists():
        print("\nPacking terrain assets...")
        terrain_assets = pack_assets(terrain_dir, assets_dir, "terrain", compress, chunk_size)
        all_assets.extend(terrain_assets)

    # Pack buildings using hybrid approach (textured > detailed > original)
    buildings_textured_dir = _processed_dir / "buildings_textured"
    buildings_detailed_dir = _processed_dir / "buildings_detailed"
    buildings_dir = _processed_dir / "buildings"

    # Check what sources we have
    has_textured = buildings_textured_dir.exists() and list(buildings_textured_dir.glob("*.glb"))
    has_detailed = buildings_detailed_dir.exists() and list(buildings_detailed_dir.glob("*.glb"))
    has_original = buildings_dir.exists() and list(buildings_dir.glob("*.glb"))

    if has_textured or has_detailed or has_original:
        # Use hybrid approach: textured > detailed > original
        print("\nPacking building assets (hybrid: textured > detailed > original)...")
        building_assets = pack_buildings_hybrid(
            buildings_textured_dir,
            buildings_detailed_dir,
            buildings_dir,
            assets_dir,
            compress,
            chunk_size
        )
        all_assets.extend(building_assets)

    # Pack roads
    roads_dir = _processed_dir / "roads"
    if roads_dir.exists():
        print("\nPacking road assets...")
        road_assets = pack_assets(roads_dir, assets_dir, "roads", compress, chunk_size)
        all_assets.extend(road_assets)

    # Pack railways
    railways_dir = _processed_dir / "railways"
    if railways_dir.exists():
        print("\nPacking railway assets...")
        railway_assets = pack_assets(railways_dir, assets_dir, "railways", compress, chunk_size)
        all_assets.extend(railway_assets)

    # Pack water
    water_dir = _processed_dir / "water"
    if water_dir.exists():
        print("\nPacking water assets...")
        water_assets = pack_assets(water_dir, assets_dir, "water", compress, chunk_size)
        all_assets.extend(water_assets)

    # Pack sea
    sea_dir = _processed_dir / "sea"
    if sea_dir.exists():
        print("\nPacking sea assets...")
        sea_assets = pack_assets(sea_dir, assets_dir, "sea", compress, chunk_size)
        all_assets.extend(sea_assets)

    # Pack footprints
    footprints_dir = _processed_dir / "footprints"
    if footprints_dir.exists():
        print("\nPacking footprint assets...")
        footprint_assets = pack_assets(footprints_dir, assets_dir, "footprints", compress, chunk_size)
        all_assets.extend(footprint_assets)

    # Copy extra files (metadata, etc.)
    print("\nCopying extra files...")
    for src_name, dst_name in EXTRA_FILES:
        src_path = _processed_dir / src_name
        if src_path.exists():
            dst_path = _dist_dir / dst_name
            shutil.copy2(src_path, dst_path)
            print(f"  Copied: {dst_name}")

    # Copy texture files
    print("\nCopying texture files...")
    textures_src_dir = _processed_dir / "textures"
    textures_dst_dir = assets_dir / "textures"

    if textures_src_dir.exists():
        textures_dst_dir.mkdir(parents=True, exist_ok=True)
        texture_count = 0

        for tex_file in TEXTURE_FILES:
            src_path = textures_src_dir / tex_file
            if src_path.exists():
                dst_path = textures_dst_dir / tex_file
                shutil.copy2(src_path, dst_path)
                texture_count += 1
                print(f"  Copied: {tex_file}")

                # Add texture to assets list
                file_size = dst_path.stat().st_size
                all_assets.append({
                    "id": f"texture_{tex_file.replace('.', '_')}",
                    "type": "texture",
                    "url": f"assets/textures/{tex_file}",
                    "size_bytes": file_size,
                    "compressed": False
                })

        print(f"  Total textures: {texture_count}")
    else:
        print("  No textures directory found (run 52_create_facade_atlas.py first)")

    # Generate manifest
    print("\nGenerating manifest...")
    manifest = generate_manifest(all_assets, aoi_info, settings)

    manifest_file = _dist_dir / "manifest.json"
    with open(manifest_file, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Written: {manifest_file}")

    print(f"\nSummary:")
    print(f"  Total assets: {len(all_assets)}")
    print(f"  Output directory: {_dist_dir}")

    print("\nDone!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pack assets for web delivery")
    parser.add_argument("--twin-id", help="Twin UUID for twin-specific execution")
    args = parser.parse_args()
    main(args.twin_id)
