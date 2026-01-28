#!/usr/bin/env python3
"""
51_export_buildings.py - Export buildings from PostGIS to GeoJSON

Exports the buildings table from PostGIS to buildings_height.geojson for
consumption by the mesh generation pipeline.

Features:
- Transforms BNG (EPSG:27700) geometries to WGS84 (EPSG:4326)
- Maps database column names to OSM-style keys
- Merges building_overrides if they exist (Phase 2)
- Marks buildings with custom meshes (Phase 2)

Input:
    - PostGIS buildings table (with heights from 50_building_heights.py)
    - PostGIS building_overrides table (optional, Phase 2)
    - PostGIS building_meshes table (optional, Phase 2)

Output:
    - data/processed/buildings_height.geojson

Usage:
    python 51_export_buildings.py
"""

import json
import os
from pathlib import Path

import psycopg2
from pyproj import Transformer

# Paths
SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"

# Coordinate transformer (BNG to WGS84)
BNG_TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


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


def table_exists(conn, table_name: str) -> bool:
    """Check if a table exists in the database."""
    cur = conn.cursor()
    cur.execute("""
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = %s
        )
    """, (table_name,))
    exists = cur.fetchone()[0]
    cur.close()
    return exists


def export_buildings(conn, output_path: Path):
    """Export buildings from PostGIS to GeoJSON.

    If building_overrides table exists, merges overrides using COALESCE.
    If building_meshes table exists, marks buildings with custom meshes.
    """
    cur = conn.cursor()

    # Check for Phase 2 tables
    has_overrides = table_exists(conn, 'building_overrides')
    has_meshes = table_exists(conn, 'building_meshes')

    if has_overrides or has_meshes:
        print(f"  Phase 2 tables detected: overrides={has_overrides}, meshes={has_meshes}")

    # Build the export query
    if has_overrides and has_meshes:
        # Full Phase 2: merge overrides and mark custom meshes
        query = """
            SELECT
                b.osm_id,
                ST_AsGeoJSON(ST_Transform(
                    COALESCE(o.geometry, b.geometry), 4326
                ))::json as geometry,
                COALESCE(o.height, b.height) as height,
                COALESCE(o.height_source, b.height_source) as height_source,
                b.levels as "building:levels",
                b.building_type as building,
                COALESCE(o.name, b.name) as name,
                b.amenity,
                b.shop,
                b.office,
                COALESCE(o.addr_housenumber, b.addr_housenumber) as "addr:housenumber",
                b.addr_housename as "addr:housename",
                COALESCE(o.addr_street, b.addr_street) as "addr:street",
                COALESCE(o.addr_postcode, b.addr_postcode) as "addr:postcode",
                COALESCE(o.addr_city, b.addr_city) as "addr:city",
                b.addr_suburb as "addr:suburb",
                (o.id IS NOT NULL) as has_override,
                (m.id IS NOT NULL) as has_custom_mesh
            FROM buildings b
            LEFT JOIN building_overrides o ON b.osm_id = o.osm_id
            LEFT JOIN building_meshes m ON b.osm_id = m.osm_id
            WHERE b.geometry IS NOT NULL
            ORDER BY b.id
        """
    elif has_overrides:
        # Only overrides table exists
        query = """
            SELECT
                b.osm_id,
                ST_AsGeoJSON(ST_Transform(
                    COALESCE(o.geometry, b.geometry), 4326
                ))::json as geometry,
                COALESCE(o.height, b.height) as height,
                COALESCE(o.height_source, b.height_source) as height_source,
                b.levels as "building:levels",
                b.building_type as building,
                COALESCE(o.name, b.name) as name,
                b.amenity,
                b.shop,
                b.office,
                COALESCE(o.addr_housenumber, b.addr_housenumber) as "addr:housenumber",
                b.addr_housename as "addr:housename",
                COALESCE(o.addr_street, b.addr_street) as "addr:street",
                COALESCE(o.addr_postcode, b.addr_postcode) as "addr:postcode",
                COALESCE(o.addr_city, b.addr_city) as "addr:city",
                b.addr_suburb as "addr:suburb",
                (o.id IS NOT NULL) as has_override,
                FALSE as has_custom_mesh
            FROM buildings b
            LEFT JOIN building_overrides o ON b.osm_id = o.osm_id
            WHERE b.geometry IS NOT NULL
            ORDER BY b.id
        """
    elif has_meshes:
        # Only meshes table exists
        query = """
            SELECT
                b.osm_id,
                ST_AsGeoJSON(ST_Transform(b.geometry, 4326))::json as geometry,
                b.height,
                b.height_source,
                b.levels as "building:levels",
                b.building_type as building,
                b.name,
                b.amenity,
                b.shop,
                b.office,
                b.addr_housenumber as "addr:housenumber",
                b.addr_housename as "addr:housename",
                b.addr_street as "addr:street",
                b.addr_postcode as "addr:postcode",
                b.addr_city as "addr:city",
                b.addr_suburb as "addr:suburb",
                FALSE as has_override,
                (m.id IS NOT NULL) as has_custom_mesh
            FROM buildings b
            LEFT JOIN building_meshes m ON b.osm_id = m.osm_id
            WHERE b.geometry IS NOT NULL
            ORDER BY b.id
        """
    else:
        # Phase 1: simple export without overrides
        query = """
            SELECT
                b.osm_id,
                ST_AsGeoJSON(ST_Transform(b.geometry, 4326))::json as geometry,
                b.height,
                b.height_source,
                b.levels as "building:levels",
                b.building_type as building,
                b.name,
                b.amenity,
                b.shop,
                b.office,
                b.addr_housenumber as "addr:housenumber",
                b.addr_housename as "addr:housename",
                b.addr_street as "addr:street",
                b.addr_postcode as "addr:postcode",
                b.addr_city as "addr:city",
                b.addr_suburb as "addr:suburb",
                FALSE as has_override,
                FALSE as has_custom_mesh
            FROM buildings b
            WHERE b.geometry IS NOT NULL
            ORDER BY b.id
        """

    print("  Executing export query...")
    cur.execute(query)

    # Get column names from cursor description
    columns = [desc[0] for desc in cur.description]

    # Build GeoJSON features
    features = []
    overrides_count = 0
    custom_mesh_count = 0

    for row in cur:
        row_dict = dict(zip(columns, row))

        # Extract geometry
        geometry = row_dict.pop('geometry')
        if geometry is None:
            continue

        # Track Phase 2 features
        has_override = row_dict.pop('has_override', False)
        has_custom_mesh = row_dict.pop('has_custom_mesh', False)

        if has_override:
            overrides_count += 1
        if has_custom_mesh:
            custom_mesh_count += 1

        # Build properties, filtering out None values
        properties = {}
        for key, value in row_dict.items():
            if value is not None:
                properties[key] = value

        # Add Phase 2 markers if present
        if has_override:
            properties['_has_override'] = True
        if has_custom_mesh:
            properties['_has_custom_mesh'] = True

        feature = {
            "type": "Feature",
            "geometry": geometry,
            "properties": properties
        }
        features.append(feature)

    cur.close()

    # Build GeoJSON FeatureCollection
    geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    # Write output
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(geojson, f)

    print(f"\n  Exported {len(features):,} buildings to {output_path}")

    if has_overrides:
        print(f"  Buildings with overrides: {overrides_count:,}")
    if has_meshes:
        print(f"  Buildings with custom meshes: {custom_mesh_count:,}")

    return len(features)


def print_stats(conn):
    """Print export statistics."""
    cur = conn.cursor()

    print("\n" + "=" * 50)
    print("EXPORT STATISTICS")
    print("=" * 50)

    cur.execute("SELECT COUNT(*) FROM buildings")
    print(f"Total buildings in PostGIS: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE height IS NOT NULL")
    print(f"Buildings with height: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE addr_street IS NOT NULL")
    print(f"Buildings with street address: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE addr_postcode IS NOT NULL")
    print(f"Buildings with postcode: {cur.fetchone()[0]:,}")

    # Check for Phase 2 data
    if table_exists(conn, 'building_overrides'):
        cur.execute("SELECT COUNT(*) FROM building_overrides")
        print(f"Building overrides: {cur.fetchone()[0]:,}")

    if table_exists(conn, 'building_meshes'):
        cur.execute("SELECT COUNT(*) FROM building_meshes")
        print(f"Custom meshes: {cur.fetchone()[0]:,}")

    cur.close()


def main():
    """Export buildings from PostGIS to GeoJSON."""
    print("=" * 50)
    print("EXPORTING BUILDINGS FROM POSTGIS")
    print("=" * 50)
    print()

    conn = get_connection()
    output_path = PROCESSED_DIR / "buildings_height.geojson"

    # Check buildings exist
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM buildings WHERE height IS NOT NULL")
    count = cur.fetchone()[0]
    cur.close()

    if count == 0:
        print("No buildings with heights found. Run 50_building_heights.py first.")
        conn.close()
        return

    print(f"Found {count:,} buildings with heights")
    print()

    export_buildings(conn, output_path)
    print_stats(conn)

    conn.close()
    print("\nDone! Run 60_generate_meshes.py next to generate 3D meshes.")


if __name__ == "__main__":
    main()
