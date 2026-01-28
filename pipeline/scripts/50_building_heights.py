#!/usr/bin/env python3
"""
50_building_heights.py - Building Height Derivation

Derives building heights using a priority order:
1. OSM 'height' tag (from raw data)
2. OSM 'building:levels' * storey_height
3. LiDAR nDSM (90th percentile within footprint)

Reads building geometries from PostGIS and UPDATEs heights directly.
This script replaces the previous GeoJSON-based workflow.

Input:
    - PostGIS buildings table (populated by 21_migrate_to_postgis.py)
    - data/interim/ndsm_clip.tif

Output:
    - Updated height/height_source columns in PostGIS

Usage:
    python 50_building_heights.py
"""

import json
import os
import re
from pathlib import Path

import numpy as np
import psycopg2
import rasterio
from rasterio.mask import mask
from shapely.geometry import shape, mapping
from shapely import wkb
import yaml

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
INTERIM_DIR = DATA_DIR / "interim"


def get_connection():
    """Get database connection."""
    password = os.environ.get("PGPASSWORD", "blyth123")
    try:
        return psycopg2.connect(
            host="localhost",
            database="blyth_twin",
            user="postgres",
            password=password
        )
    except Exception:
        return psycopg2.connect("dbname=blyth_twin")


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    with open(CONFIG_DIR / "settings.yaml") as f:
        return yaml.safe_load(f)


def parse_height(height_str: str) -> float | None:
    """Parse OSM height string to metres."""
    if not height_str:
        return None

    match = re.match(r"([\d.]+)\s*m?", str(height_str).strip())
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            return None
    return None


def get_ndsm_height(geometry, ndsm_src, percentile: int = 90) -> float | None:
    """Extract height from nDSM using percentile within footprint.

    Args:
        geometry: Shapely geometry in BNG (EPSG:27700)
        ndsm_src: Open rasterio dataset
        percentile: Percentile to use (default 90th)
    """
    try:
        # Create GeoJSON-like dict from shapely geometry (already in BNG)
        geom_dict = mapping(geometry)

        # Mask nDSM to building footprint
        out_image, _ = mask(ndsm_src, [geom_dict], crop=True, all_touched=True)
        data = out_image[0]

        # Filter valid values (> 0, not nodata)
        nodata = ndsm_src.nodata
        valid = data[(data > 0) & (data != nodata)] if nodata else data[data > 0]

        if len(valid) == 0:
            return None

        return float(np.percentile(valid, percentile))
    except Exception:
        return None


def derive_heights(conn, ndsm_path: Path, settings: dict):
    """Derive heights for all buildings in PostGIS."""
    storey_height = settings["buildings"]["storey_height_m"]
    percentile = settings["buildings"]["ndsm_percentile"]
    min_height = settings["buildings"]["min_height_m"]
    max_height = settings["buildings"]["max_height_m"]

    print(f"Opening nDSM: {ndsm_path}...")
    ndsm_src = rasterio.open(ndsm_path)

    cur = conn.cursor()

    # Get all buildings that need height calculation
    # Include OSM height tag from stored tags for priority 1
    cur.execute("""
        SELECT id, osm_id, geometry, levels, tags
        FROM buildings
        ORDER BY id
    """)

    buildings = cur.fetchall()
    total = len(buildings)
    print(f"Processing {total} buildings...")

    # Statistics
    stats = {"osm_height": 0, "osm_levels": 0, "lidar": 0, "default": 0}
    batch_updates = []

    for i, (building_id, osm_id, geom_wkb, levels, tags_json) in enumerate(buildings):
        height = None
        source = None

        # Parse tags JSON
        try:
            tags = json.loads(tags_json) if tags_json else {}
        except (json.JSONDecodeError, TypeError):
            tags = {}

        # Priority 1: OSM height tag
        osm_height_str = tags.get("height")
        if osm_height_str:
            height = parse_height(osm_height_str)
            if height:
                source = "osm_height"

        # Priority 2: OSM building:levels
        if height is None and levels:
            try:
                height = int(levels) * storey_height
                source = "osm_levels"
            except (ValueError, TypeError):
                pass

        # Priority 3: LiDAR nDSM
        if height is None and geom_wkb:
            try:
                # Convert WKB to shapely geometry (already in BNG)
                geom = wkb.loads(geom_wkb, hex=True)
                height = get_ndsm_height(geom, ndsm_src, percentile)
                if height:
                    source = "lidar"
            except Exception:
                pass

        # Fallback: default height
        if height is None:
            height = 6.0  # 2 storeys
            source = "default"

        # Clamp height
        height = max(min_height, min(height, max_height))

        stats[source] += 1
        batch_updates.append((round(height, 1), source, building_id))

        if (i + 1) % 500 == 0:
            print(f"  Processed {i + 1}/{total} buildings")

    ndsm_src.close()

    # Batch update
    print(f"\nUpdating {len(batch_updates)} buildings in PostGIS...")

    update_cur = conn.cursor()
    update_cur.executemany("""
        UPDATE buildings
        SET height = %s, height_source = %s, updated_at = NOW()
        WHERE id = %s
    """, batch_updates)

    conn.commit()
    update_cur.close()
    cur.close()

    print(f"\nHeight source breakdown:")
    print(f"  OSM height tag: {stats['osm_height']}")
    print(f"  OSM levels: {stats['osm_levels']}")
    print(f"  LiDAR nDSM: {stats['lidar']}")
    print(f"  Default: {stats['default']}")
    print(f"  Total: {sum(stats.values())}")


def print_stats(conn):
    """Print height statistics from PostGIS."""
    cur = conn.cursor()

    print("\n" + "=" * 50)
    print("HEIGHT STATISTICS")
    print("=" * 50)

    cur.execute("SELECT COUNT(*) FROM buildings WHERE height IS NOT NULL")
    print(f"Buildings with height: {cur.fetchone()[0]:,}")

    cur.execute("""
        SELECT height_source, COUNT(*)
        FROM buildings
        WHERE height IS NOT NULL
        GROUP BY height_source
        ORDER BY COUNT(*) DESC
    """)
    for source, count in cur.fetchall():
        print(f"  - {source}: {count:,}")

    cur.execute("""
        SELECT
            MIN(height) as min_h,
            AVG(height) as avg_h,
            MAX(height) as max_h
        FROM buildings
        WHERE height IS NOT NULL
    """)
    row = cur.fetchone()
    if row and row[0]:
        print(f"\nHeight range: {row[0]:.1f}m - {row[2]:.1f}m (avg: {row[1]:.1f}m)")

    cur.close()


def main():
    """Derive building heights and update PostGIS."""
    print("=" * 50)
    print("BUILDING HEIGHT DERIVATION (PostGIS)")
    print("=" * 50)
    print()

    settings = load_settings()
    ndsm_path = INTERIM_DIR / "ndsm_clip.tif"

    if not ndsm_path.exists():
        raise FileNotFoundError(f"nDSM not found: {ndsm_path}")

    conn = get_connection()

    # Check buildings exist
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM buildings")
    count = cur.fetchone()[0]
    cur.close()

    if count == 0:
        print("No buildings found in PostGIS. Run 21_migrate_to_postgis.py first.")
        conn.close()
        return

    print(f"Found {count:,} buildings in PostGIS")

    derive_heights(conn, ndsm_path, settings)
    print_stats(conn)

    conn.close()
    print("\nDone! Run 51_export_buildings.py to export to GeoJSON.")


if __name__ == "__main__":
    main()
