#!/usr/bin/env python3
"""
10_fetch_lidar.py - LiDAR Tile Verification

Checks if required LiDAR tiles exist in the twin's data directory.
Tiles must be manually downloaded from the EA portal and placed in
the raw/lidar_dtm/ directory.

EA LiDAR Portal: https://environment.data.gov.uk/survey

Input:
    - Twin config from database (--twin-id)
    - LiDAR tiles in data/twins/{id}/raw/lidar_dtm/*.tif

Output:
    - Returns 0 if tiles present, 1 if missing

Usage:
    python 10_fetch_lidar.py --twin-id <uuid>
"""

import argparse
import sys
from pathlib import Path

# Add parent directory to path for imports
SCRIPT_DIR = Path(__file__).parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from lib.twin_config import (
    get_twin_config,
    get_required_tiles,
    check_tiles_exist,
)


def main(twin_id: str) -> int:
    """Verify LiDAR tiles exist."""
    print("=" * 60)
    print("LiDAR Tile Verification")
    print("=" * 60)

    # Load config
    config = get_twin_config(twin_id)
    dtm_dir = config.raw_lidar_dtm_dir

    print(f"Twin: {config.name}")
    print(f"LiDAR directory: {dtm_dir}")

    # Calculate required tiles
    required_tiles = get_required_tiles(
        config.centre_lat,
        config.centre_lon,
        config.side_length_m,
        config.buffer_m
    )

    if not required_tiles:
        print("No tiles required (location outside coverage area)")
        return 0

    print(f"\nRequired tiles: {', '.join(required_tiles)}")

    # Check which tiles exist
    existing, missing = check_tiles_exist(config, required_tiles)

    print(f"\nExisting tiles: {len(existing)}")
    for tile in existing:
        print(f"  - {tile}")

    if missing:
        print(f"\nMissing tiles: {len(missing)}")
        for tile in missing:
            print(f"  - {tile}")
        print("\nTo download missing tiles:")
        print("1. Visit: https://environment.data.gov.uk/survey")
        print("2. Search for each tile reference (e.g., NZ28SW)")
        print("3. Download DTM 1m resolution")
        print(f"4. Extract TIF files to: {dtm_dir}/")
        return 1

    print("\nAll required tiles present")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Verify LiDAR tiles are present"
    )
    parser.add_argument("--twin-id", required=True, help="Twin UUID")
    args = parser.parse_args()

    sys.exit(main(args.twin_id))
