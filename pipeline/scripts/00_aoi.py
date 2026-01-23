#!/usr/bin/env python3
"""
00_aoi.py - AOI Generator

Generates the Area of Interest (AOI) boundary files for the Blyth Digital Twin.

Input:
    - Centre coordinate (lat/lon from settings.yaml)
    - Side length in metres

Output:
    - config/aoi.geojson (exact 5km square in EPSG:27700)
    - config/aoi_buffer.geojson (buffered AOI for raster operations)

Usage:
    python 00_aoi.py
"""

import json
from pathlib import Path

import yaml
from pyproj import CRS, Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
SETTINGS_FILE = CONFIG_DIR / "settings.yaml"


def load_settings() -> dict:
    """Load settings from YAML configuration."""
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


def main():
    """Generate AOI files."""
    print("Loading settings...")
    settings = load_settings()
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
    aoi_file = CONFIG_DIR / "aoi.geojson"
    with open(aoi_file, "w") as f:
        json.dump(aoi, f, indent=2)
    print(f"Written: {aoi_file}")

    # Generate buffered AOI
    print("\nGenerating buffered AOI...")
    aoi_buffered = create_aoi(centre_lat, centre_lon, side_length, buffer_m)
    aoi_buffer_file = CONFIG_DIR / "aoi_buffer.geojson"
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
    main()
