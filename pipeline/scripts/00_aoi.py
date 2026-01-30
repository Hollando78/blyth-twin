#!/usr/bin/env python3
"""
00_aoi.py - AOI Generator

Generates the Area of Interest (AOI) boundary files for the Blyth Digital Twin.

Input:
    - Centre coordinate (lat/lon from settings.yaml or twin database)
    - Side length in metres

Output:
    - config/aoi.geojson (exact square in EPSG:27700)
    - config/aoi_buffer.geojson (buffered AOI for raster operations)

Usage:
    python 00_aoi.py
    python 00_aoi.py --twin-id <uuid>
"""

import argparse
import json
import sys
from pathlib import Path

import yaml
from pyproj import CRS, Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
SETTINGS_FILE = CONFIG_DIR / "settings.yaml"


def get_twin_paths(twin_id: str):
    """Get paths for twin-specific execution."""
    sys.path.insert(0, str(SCRIPT_DIR.parent))
    from lib.twin_config import get_twin_config
    return get_twin_config(twin_id)


def load_settings(twin_config=None) -> dict:
    """Load settings from YAML configuration or twin config."""
    if twin_config:
        return twin_config.load_settings()
    with open(SETTINGS_FILE) as f:
        return yaml.safe_load(f)


def create_aoi(centre_lat: float, centre_lon: float, side_length_m: float, buffer_m: float = 0) -> dict:
    """
    Create a square AOI in EPSG:27700 (British National Grid).

    Args:
        centre_lat: Centre latitude (WGS84)
        centre_lon: Centre longitude (WGS84)
        side_length_m: Side length in metres
        buffer_m: Optional buffer distance in metres

    Returns:
        GeoJSON FeatureCollection
    """
    # Transform centre point from WGS84 to BNG
    transformer_to_bng = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    centre_x, centre_y = transformer_to_bng.transform(centre_lon, centre_lat)

    # Create square AOI
    half_side = side_length_m / 2
    aoi_box = box(
        centre_x - half_side,
        centre_y - half_side,
        centre_x + half_side,
        centre_y + half_side
    )

    # Apply buffer if specified
    if buffer_m > 0:
        aoi_box = aoi_box.buffer(buffer_m)

    # Build GeoJSON
    feature = {
        "type": "Feature",
        "properties": {
            "name": "Blyth AOI" + (" (buffered)" if buffer_m > 0 else ""),
            "centre_wgs84": [centre_lon, centre_lat],
            "centre_bng": [centre_x, centre_y],
            "side_length_m": side_length_m,
            "buffer_m": buffer_m,
            "crs": "EPSG:27700"
        },
        "geometry": mapping(aoi_box)
    }

    return {
        "type": "FeatureCollection",
        "name": "blyth_aoi",
        "crs": {
            "type": "name",
            "properties": {"name": "urn:ogc:def:crs:EPSG::27700"}
        },
        "features": [feature]
    }


def main(twin_id: str = None):
    """Generate AOI files."""
    twin_config = None
    config_dir = CONFIG_DIR

    if twin_id:
        print(f"Twin mode: {twin_id}")
        twin_config = get_twin_paths(twin_id)
        config_dir = twin_config.config_dir
        twin_config.ensure_directories()

    print("Loading settings...")
    settings = load_settings(twin_config)
    aoi_config = settings["aoi"]

    centre_lat = aoi_config["centre_lat"]
    centre_lon = aoi_config["centre_lon"]
    side_length = aoi_config["side_length_m"]
    buffer_m = aoi_config["buffer_m"]

    print(f"Centre: {centre_lat}, {centre_lon}")
    print(f"Side length: {side_length}m")
    print(f"Buffer: {buffer_m}m")

    # Generate exact AOI
    print("\nGenerating AOI...")
    aoi = create_aoi(centre_lat, centre_lon, side_length)

    # Update name for twin
    if twin_config:
        aoi["features"][0]["properties"]["name"] = twin_config.name

    aoi_file = config_dir / "aoi.geojson"
    with open(aoi_file, "w") as f:
        json.dump(aoi, f, indent=2)
    print(f"Written: {aoi_file}")

    # Generate buffered AOI
    print("\nGenerating buffered AOI...")
    aoi_buffered = create_aoi(centre_lat, centre_lon, side_length, buffer_m)
    if twin_config:
        aoi_buffered["features"][0]["properties"]["name"] = f"{twin_config.name} (buffered)"

    aoi_buffer_file = config_dir / "aoi_buffer.geojson"
    with open(aoi_buffer_file, "w") as f:
        json.dump(aoi_buffered, f, indent=2)
    print(f"Written: {aoi_buffer_file}")

    # Print bounds for verification
    bounds = aoi["features"][0]["geometry"]["coordinates"][0]
    print(f"\nAOI bounds (EPSG:27700):")
    print(f"  SW: {bounds[0]}")
    print(f"  NE: {bounds[2]}")

    print("\nDone!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate AOI files")
    parser.add_argument("--twin-id", help="Twin UUID for twin-specific execution")
    args = parser.parse_args()
    main(args.twin_id)
