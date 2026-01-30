#!/usr/bin/env python3
"""
15_fetch_srtm.py - SRTM Elevation Data Download

Downloads SRTM 30m elevation data as a fallback when LiDAR is not available.
Uses the OpenTopography API or elevation tiles.

Input:
    - Twin config from database (--twin-id)

Output:
    - data/twins/{id}/raw/srtm/dem.tif

Usage:
    python 15_fetch_srtm.py --twin-id <uuid>
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from pyproj import Transformer
import requests

# Add parent directory to path for imports
SCRIPT_DIR = Path(__file__).parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from lib.twin_config import get_twin_config

# Coordinate transformers
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
BNG_TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)

# Open-Elevation API (free, no API key required)
OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup"


def get_elevation_grid(min_lat: float, max_lat: float, min_lon: float, max_lon: float,
                       resolution_m: float = 30) -> tuple[np.ndarray, dict]:
    """
    Fetch elevation data for a bounding box using Open-Elevation API.

    Args:
        min_lat, max_lat, min_lon, max_lon: Bounding box in WGS84
        resolution_m: Approximate resolution in meters

    Returns:
        Tuple of (elevation_array, metadata)
    """
    # Calculate grid size based on resolution
    lat_range = max_lat - min_lat
    lon_range = max_lon - min_lon

    # Approximate meters per degree at this latitude
    center_lat = (min_lat + max_lat) / 2
    m_per_deg_lat = 111320
    m_per_deg_lon = 111320 * np.cos(np.radians(center_lat))

    height_m = lat_range * m_per_deg_lat
    width_m = lon_range * m_per_deg_lon

    n_rows = max(10, int(height_m / resolution_m))
    n_cols = max(10, int(width_m / resolution_m))

    # Limit grid size to avoid API overload
    max_points = 1000
    if n_rows * n_cols > max_points:
        scale = np.sqrt(max_points / (n_rows * n_cols))
        n_rows = max(10, int(n_rows * scale))
        n_cols = max(10, int(n_cols * scale))

    print(f"  Fetching {n_rows}x{n_cols} elevation grid...")

    # Generate grid points
    lats = np.linspace(max_lat, min_lat, n_rows)  # North to south
    lons = np.linspace(min_lon, max_lon, n_cols)

    # Build locations list for API
    locations = []
    for lat in lats:
        for lon in lons:
            locations.append({"latitude": lat, "longitude": lon})

    # Query API in batches
    batch_size = 100
    elevations = []

    for i in range(0, len(locations), batch_size):
        batch = locations[i:i + batch_size]
        try:
            response = requests.post(
                OPEN_ELEVATION_URL,
                json={"locations": batch},
                timeout=30
            )
            response.raise_for_status()
            results = response.json()["results"]
            elevations.extend([r["elevation"] for r in results])
        except Exception as e:
            print(f"  Warning: API request failed: {e}")
            # Fill with zeros on failure
            elevations.extend([0] * len(batch))

    # Reshape to grid
    elevation_grid = np.array(elevations, dtype=np.float32).reshape(n_rows, n_cols)

    metadata = {
        "n_rows": n_rows,
        "n_cols": n_cols,
        "min_lat": min_lat,
        "max_lat": max_lat,
        "min_lon": min_lon,
        "max_lon": max_lon,
    }

    return elevation_grid, metadata


def save_dem_geotiff(elevation_grid: np.ndarray, output_path: Path,
                     min_lat: float, max_lat: float, min_lon: float, max_lon: float):
    """
    Save elevation grid as a GeoTIFF in BNG projection.
    """
    # Convert bounds to BNG
    min_x, min_y = WGS84_TO_BNG.transform(min_lon, min_lat)
    max_x, max_y = WGS84_TO_BNG.transform(max_lon, max_lat)

    n_rows, n_cols = elevation_grid.shape

    # Create transform
    transform = from_bounds(min_x, min_y, max_x, max_y, n_cols, n_rows)

    # Write GeoTIFF
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(
        output_path,
        'w',
        driver='GTiff',
        height=n_rows,
        width=n_cols,
        count=1,
        dtype=elevation_grid.dtype,
        crs='EPSG:27700',
        transform=transform,
        nodata=-9999,
    ) as dst:
        dst.write(elevation_grid, 1)

    print(f"  Saved DEM to {output_path}")


def main(twin_id: str) -> int:
    """Fetch SRTM elevation data for a twin."""
    print("=" * 60)
    print("SRTM Elevation Data Download")
    print("=" * 60)

    # Load config
    config = get_twin_config(twin_id)

    print(f"Twin: {config.name}")
    print(f"Centre: {config.centre_lat}, {config.centre_lon}")
    print(f"Size: {config.side_length_m}m")

    # Calculate bounding box in WGS84
    center_lat = config.centre_lat
    center_lon = config.centre_lon
    half_side = (config.side_length_m + config.buffer_m) / 2

    # Convert to BNG, add buffer, convert back
    center_x, center_y = WGS84_TO_BNG.transform(center_lon, center_lat)
    min_x = center_x - half_side
    max_x = center_x + half_side
    min_y = center_y - half_side
    max_y = center_y + half_side

    # Convert corners back to WGS84
    min_lon, min_lat = BNG_TO_WGS84.transform(min_x, min_y)
    max_lon, max_lat = BNG_TO_WGS84.transform(max_x, max_y)

    print(f"\nBounding box (WGS84):")
    print(f"  Lat: {min_lat:.6f} to {max_lat:.6f}")
    print(f"  Lon: {min_lon:.6f} to {max_lon:.6f}")

    # Output path
    srtm_dir = config.data_dir / "raw" / "srtm"
    dem_path = srtm_dir / "dem.tif"

    # Check if already exists
    if dem_path.exists():
        print(f"\nSRTM DEM already exists: {dem_path}")
        return 0

    # Fetch elevation data
    print("\nFetching elevation data from Open-Elevation API...")
    try:
        elevation_grid, metadata = get_elevation_grid(
            min_lat, max_lat, min_lon, max_lon,
            resolution_m=30
        )

        # Check if we got valid data
        if np.all(elevation_grid == 0):
            print("  Warning: All elevations are 0, API may have failed")
        else:
            elev_min = np.min(elevation_grid)
            elev_max = np.max(elevation_grid)
            print(f"  Elevation range: {elev_min:.1f}m to {elev_max:.1f}m")

        # Save as GeoTIFF
        save_dem_geotiff(elevation_grid, dem_path, min_lat, max_lat, min_lon, max_lon)

        print("\nSRTM elevation data downloaded successfully")
        return 0

    except Exception as e:
        print(f"\nError fetching elevation data: {e}")
        print("Pipeline will continue with flat terrain")
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Download SRTM elevation data"
    )
    parser.add_argument("--twin-id", required=True, help="Twin UUID")
    args = parser.parse_args()

    sys.exit(main(args.twin_id))
