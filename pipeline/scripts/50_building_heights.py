#!/usr/bin/env python3
"""
50_building_heights.py - Building Height Derivation

Derives building heights using a priority order:
1. OSM 'height' tag
2. OSM 'building:levels' * storey_height
3. LiDAR nDSM (90th percentile within footprint)

Input:
    - data/raw/osm/buildings.geojson
    - data/interim/ndsm_clip.tif

Output:
    - data/processed/buildings_height.geojson

Usage:
    python 50_building_heights.py
"""

import json
import re
from pathlib import Path

import numpy as np
import rasterio
from rasterio.mask import mask
from shapely.geometry import shape, mapping
from pyproj import Transformer
import yaml

# Coordinate transformer (WGS84 to BNG)
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    with open(CONFIG_DIR / "settings.yaml") as f:
        return yaml.safe_load(f)


def parse_height(height_str: str) -> float | None:
    """Parse OSM height string to metres."""
    if not height_str:
        return None

    # Handle common formats: "10", "10m", "10 m", "10.5"
    match = re.match(r"([\d.]+)\s*m?", str(height_str).strip())
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            return None
    return None


def transform_geometry_to_bng(geometry: dict) -> dict:
    """Transform geometry from WGS84 to BNG (EPSG:27700)."""
    def transform_coords(coords):
        return [list(WGS84_TO_BNG.transform(c[0], c[1])) for c in coords]

    if geometry['type'] == 'Polygon':
        new_coords = [transform_coords(ring) for ring in geometry['coordinates']]
        return {'type': 'Polygon', 'coordinates': new_coords}
    elif geometry['type'] == 'MultiPolygon':
        new_coords = [[transform_coords(ring) for ring in poly] for poly in geometry['coordinates']]
        return {'type': 'MultiPolygon', 'coordinates': new_coords}
    return geometry


def get_ndsm_height(geometry, ndsm_src, percentile: int = 90) -> float | None:
    """Extract height from nDSM using percentile within footprint."""
    try:
        # Transform geometry from WGS84 to BNG
        geom_bng = transform_geometry_to_bng(geometry)

        # Mask nDSM to building footprint
        out_image, _ = mask(ndsm_src, [geom_bng], crop=True, all_touched=True)
        data = out_image[0]

        # Filter valid values (> 0, not nodata)
        nodata = ndsm_src.nodata
        valid = data[(data > 0) & (data != nodata)] if nodata else data[data > 0]

        if len(valid) == 0:
            return None

        return float(np.percentile(valid, percentile))
    except Exception:
        return None


def derive_heights(buildings_path: Path, ndsm_path: Path, output_path: Path, settings: dict):
    """Derive heights for all buildings."""
    storey_height = settings["buildings"]["storey_height_m"]
    percentile = settings["buildings"]["ndsm_percentile"]
    min_height = settings["buildings"]["min_height_m"]
    max_height = settings["buildings"]["max_height_m"]

    print(f"Loading buildings from {buildings_path}...")
    with open(buildings_path) as f:
        buildings = json.load(f)

    print(f"Opening nDSM: {ndsm_path}...")
    ndsm_src = rasterio.open(ndsm_path)

    # Statistics
    stats = {"osm_height": 0, "osm_levels": 0, "lidar": 0, "default": 0}

    print(f"Processing {len(buildings['features'])} buildings...")

    for i, feature in enumerate(buildings["features"]):
        props = feature.get("properties", {})
        geom = feature.get("geometry")

        height = None
        source = None

        # Priority 1: OSM height tag
        if "height" in props:
            height = parse_height(props["height"])
            if height:
                source = "osm_height"

        # Priority 2: OSM building:levels
        if height is None and "building:levels" in props:
            try:
                levels = int(props["building:levels"])
                height = levels * storey_height
                source = "osm_levels"
            except (ValueError, TypeError):
                pass

        # Priority 3: LiDAR nDSM
        if height is None and geom:
            height = get_ndsm_height(geom, ndsm_src, percentile)
            if height:
                source = "lidar"

        # Fallback: default height
        if height is None:
            height = 6.0  # 2 storeys
            source = "default"

        # Clamp height
        height = max(min_height, min(height, max_height))

        # Update feature
        feature["properties"]["height"] = round(height, 1)
        feature["properties"]["height_source"] = source

        stats[source] += 1

        if (i + 1) % 500 == 0:
            print(f"  Processed {i + 1}/{len(buildings['features'])} buildings")

    ndsm_src.close()

    # Save output
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(buildings, f)

    print(f"\nWritten: {output_path}")
    print(f"\nHeight source breakdown:")
    print(f"  OSM height tag: {stats['osm_height']}")
    print(f"  OSM levels: {stats['osm_levels']}")
    print(f"  LiDAR nDSM: {stats['lidar']}")
    print(f"  Default: {stats['default']}")
    print(f"  Total: {sum(stats.values())}")


def main():
    """Derive building heights."""
    settings = load_settings()

    buildings_path = RAW_DIR / "osm" / "buildings.geojson"
    ndsm_path = INTERIM_DIR / "ndsm_clip.tif"
    output_path = PROCESSED_DIR / "buildings_height.geojson"

    if not buildings_path.exists():
        raise FileNotFoundError(f"Buildings not found: {buildings_path}")
    if not ndsm_path.exists():
        raise FileNotFoundError(f"nDSM not found: {ndsm_path}")

    derive_heights(buildings_path, ndsm_path, output_path, settings)

    print("\nDone!")


if __name__ == "__main__":
    main()
