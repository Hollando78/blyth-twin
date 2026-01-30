#!/usr/bin/env python3
"""
15_fetch_elevation.py - Elevation Data Download

Downloads elevation data from Environment Agency LIDAR Composite via WCS.
Covers ~99% of England at 1m resolution.
- DTM (Digital Terrain Model) - bare ground
- DSM (Digital Surface Model) - includes buildings/trees

Fallback: Open Topo Data EU-DEM (25m) for non-England locations (DTM only).

Input:
    - Twin config from database (--twin-id)

Output:
    - data/twins/{id}/raw/lidar_dtm/dtm.tif
    - data/twins/{id}/raw/lidar_dsm/dsm.tif (England only)
    - data/twins/{id}/raw/elevation/dem.tif (legacy, copy of DTM)

Usage:
    python 15_fetch_elevation.py --twin-id <uuid>
"""

import argparse
import sys
import time
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

from lib.twin_config import get_twin_config, is_in_england

# Coordinate transformers
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
BNG_TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)

# EA LIDAR Composite WCS endpoints (1m resolution, ~99% England coverage)
EA_DTM_WCS_URL = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs"
EA_DTM_COVERAGE_ID = "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m"

EA_DSM_WCS_URL = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-last-return-dsm-1m/wcs"
EA_DSM_COVERAGE_ID = "9ba4d5ac-d596-445a-9056-dae3ddec0178__Lidar_Composite_Elevation_LZ_DSM_1m"

# Open Topo Data fallback
OPEN_TOPO_DATA_URL = "https://api.opentopodata.org/v1/eudem25m"


def fetch_ea_lidar_wcs(min_x: float, min_y: float, max_x: float, max_y: float,
                       output_path: Path, wcs_url: str, coverage_id: str,
                       label: str = "elevation") -> bool:
    """
    Fetch elevation data from EA LIDAR Composite via WCS.

    Args:
        min_x, min_y, max_x, max_y: Bounding box in BNG (EPSG:27700)
        output_path: Path to save GeoTiff
        wcs_url: WCS endpoint URL
        coverage_id: Coverage ID for the dataset
        label: Label for logging (e.g., "DTM", "DSM")

    Returns:
        True if successful, False otherwise
    """
    print(f"  Requesting EA LIDAR {label} via WCS...")
    print(f"  Bounding box (BNG): {min_x:.0f}, {min_y:.0f} to {max_x:.0f}, {max_y:.0f}")

    # Build WCS 2.0.1 GetCoverage request
    # Key: use E/N for subset axes, not x/y
    url = f"{wcs_url}?service=WCS&version=2.0.1&request=GetCoverage"
    url += f"&CoverageId={coverage_id}"
    url += f"&format=image/tiff"
    url += f"&subset=E({min_x:.0f},{max_x:.0f})"
    url += f"&subset=N({min_y:.0f},{max_y:.0f})"

    try:
        response = requests.get(url, timeout=300)  # 5 min timeout for large areas

        content_type = response.headers.get('content-type', '')

        if response.status_code != 200:
            print(f"  WCS returned status {response.status_code}")
            return False

        if 'tiff' not in content_type.lower() and len(response.content) < 1000:
            print(f"  WCS returned non-TIFF response: {content_type}")
            print(f"  Response: {response.text[:200]}")
            return False

        # Save response
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, 'wb') as f:
            f.write(response.content)

        # Verify the file
        with rasterio.open(output_path) as src:
            data = src.read(1)
            print(f"  Downloaded: {src.width}x{src.height} pixels at {abs(src.transform[0]):.1f}m resolution")
            print(f"  Data type: {data.dtype}")

            # Check for valid data
            valid = ~np.isnan(data) & (data > -1000) & (data < 2000)
            coverage = np.sum(valid) / data.size * 100
            print(f"  Valid data: {coverage:.1f}%")

            if coverage < 10:
                print(f"  Warning: Very low coverage")
                return False

            elev_min = np.nanmin(data[valid]) if np.any(valid) else 0
            elev_max = np.nanmax(data[valid]) if np.any(valid) else 0
            print(f"  Elevation range: {elev_min:.1f}m to {elev_max:.1f}m")

        return True

    except requests.exceptions.Timeout:
        print(f"  WCS request timed out")
        return False
    except Exception as e:
        print(f"  WCS request failed: {e}")
        return False


def fetch_opentopo_fallback(min_lat: float, max_lat: float, min_lon: float, max_lon: float,
                            output_path: Path, resolution_m: float = 25) -> bool:
    """
    Fetch elevation data from Open Topo Data as fallback.
    """
    print(f"  Fetching from Open Topo Data (EU-DEM 25m)...")

    try:
        # Calculate grid size
        center_lat = (min_lat + max_lat) / 2
        m_per_deg_lat = 111320
        m_per_deg_lon = 111320 * np.cos(np.radians(center_lat))

        height_m = (max_lat - min_lat) * m_per_deg_lat
        width_m = (max_lon - min_lon) * m_per_deg_lon

        n_rows = max(10, int(height_m / resolution_m))
        n_cols = max(10, int(width_m / resolution_m))

        print(f"  Grid: {n_cols}x{n_rows} points")

        # Generate grid
        lats = np.linspace(max_lat, min_lat, n_rows)
        lons = np.linspace(min_lon, max_lon, n_cols)

        locations = [(lat, lon) for lat in lats for lon in lons]

        # Fetch in batches
        elevations = []
        batch_size = 100
        total_batches = (len(locations) - 1) // batch_size + 1

        for i in range(0, len(locations), batch_size):
            batch = locations[i:i + batch_size]
            locations_str = "|".join([f"{lat},{lon}" for lat, lon in batch])

            try:
                r = requests.get(OPEN_TOPO_DATA_URL, params={"locations": locations_str}, timeout=30)
                r.raise_for_status()
                result = r.json()
                if result.get("status") == "OK":
                    elevations.extend([p.get("elevation", 0) or 0 for p in result["results"]])
                else:
                    elevations.extend([0] * len(batch))
            except Exception:
                elevations.extend([0] * len(batch))

            if i + batch_size < len(locations):
                time.sleep(1.0)  # Rate limit

        # Reshape and save
        elevation_grid = np.array(elevations, dtype=np.float32).reshape(n_rows, n_cols)

        min_x, min_y = WGS84_TO_BNG.transform(min_lon, min_lat)
        max_x, max_y = WGS84_TO_BNG.transform(max_lon, max_lat)
        transform = from_bounds(min_x, min_y, max_x, max_y, n_cols, n_rows)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with rasterio.open(
            output_path, 'w',
            driver='GTiff',
            height=n_rows, width=n_cols, count=1,
            dtype=np.float32, crs='EPSG:27700',
            transform=transform, nodata=-9999,
        ) as dst:
            dst.write(elevation_grid, 1)

        print(f"  Saved: {n_cols}x{n_rows} at ~{resolution_m}m resolution")
        return True

    except Exception as e:
        print(f"  Open Topo Data failed: {e}")
        return False


def main(twin_id: str) -> int:
    """Fetch elevation data for a twin."""
    print("=" * 60)
    print("ELEVATION DATA DOWNLOAD")
    print("=" * 60)

    config = get_twin_config(twin_id)

    print(f"Twin: {config.name}")
    print(f"Centre: {config.centre_lat}, {config.centre_lon}")
    print(f"Size: {config.side_length_m}m")

    # Output paths - use lidar_dtm/dsm directories for compatibility with prepare_rasters
    dtm_dir = config.data_dir / "raw" / "lidar_dtm"
    dsm_dir = config.data_dir / "raw" / "lidar_dsm"
    elevation_dir = config.data_dir / "raw" / "elevation"

    dtm_path = dtm_dir / "dtm.tif"
    dsm_path = dsm_dir / "dsm.tif"
    dem_path = elevation_dir / "dem.tif"  # Legacy path (copy of DTM)

    # Calculate bounding box in BNG
    center_x, center_y = WGS84_TO_BNG.transform(config.centre_lon, config.centre_lat)
    half_side = (config.side_length_m + config.buffer_m) / 2

    min_x = center_x - half_side
    max_x = center_x + half_side
    min_y = center_y - half_side
    max_y = center_y + half_side

    # WGS84 bounds for fallback
    min_lon, min_lat = BNG_TO_WGS84.transform(min_x, min_y)
    max_lon, max_lat = BNG_TO_WGS84.transform(max_x, max_y)

    in_england = is_in_england(config.centre_lat, config.centre_lon)
    dtm_success = False
    dsm_success = False

    # Fetch DTM
    if dtm_path.exists():
        print(f"\nDTM already exists: {dtm_path}")
        dtm_success = True
    elif in_england:
        print("\n1. Fetching EA LIDAR DTM (1m resolution)...")
        dtm_success = fetch_ea_lidar_wcs(
            min_x, min_y, max_x, max_y, dtm_path,
            EA_DTM_WCS_URL, EA_DTM_COVERAGE_ID, "DTM"
        )

    # Fallback to Open Topo Data for DTM
    if not dtm_success:
        print("\n   Open Topo Data fallback (25m resolution)...")
        dtm_success = fetch_opentopo_fallback(min_lat, max_lat, min_lon, max_lon, dtm_path)

    # Fetch DSM (England only - needed for building heights via nDSM)
    if dsm_path.exists():
        print(f"\nDSM already exists: {dsm_path}")
        dsm_success = True
    elif in_england:
        print("\n2. Fetching EA LIDAR DSM (1m resolution)...")
        dsm_success = fetch_ea_lidar_wcs(
            min_x, min_y, max_x, max_y, dsm_path,
            EA_DSM_WCS_URL, EA_DSM_COVERAGE_ID, "DSM"
        )
        if dsm_success:
            print("   DSM fetched - building heights from nDSM will be available")
        else:
            print("   DSM not available - buildings will use default/OSM heights")
    else:
        print("\n   DSM not available outside England - buildings will use default/OSM heights")

    # Create legacy dem.tif as copy/link to DTM for backwards compatibility
    if dtm_success and not dem_path.exists():
        import shutil
        elevation_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(dtm_path, dem_path)
        print(f"\n   Created legacy dem.tif copy")

    if dtm_success:
        print(f"\nElevation data complete:")
        print(f"  DTM: {dtm_path}")
        if dsm_success:
            print(f"  DSM: {dsm_path}")
        return 0
    else:
        print("\nFailed to fetch elevation data - using flat terrain")
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Download elevation data")
    parser.add_argument("--twin-id", required=True, help="Twin UUID")
    args = parser.parse_args()

    sys.exit(main(args.twin_id))
