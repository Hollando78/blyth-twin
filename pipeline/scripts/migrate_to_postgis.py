#!/usr/bin/env python3
"""
migrate_to_postgis.py - Migrate GeoJSON data to PostGIS

Loads all GeoJSON data into the PostGIS database.

Usage:
    python migrate_to_postgis.py
"""

import json
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values
from shapely.geometry import shape
from shapely import wkb
from pyproj import Transformer

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
RAW_DIR = DATA_DIR / "raw" / "osm"
PROCESSED_DIR = DATA_DIR / "processed"

# Database connection
DB_CONFIG = {
    "host": "localhost",
    "database": "blyth_twin",
    "user": "postgres",
    "password": ""  # Local trust auth
}

# Coordinate transformer
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)


def get_connection():
    """Get database connection."""
    # Try different connection methods
    import os

    # Method 1: If running as postgres user or with trust auth
    try:
        return psycopg2.connect("dbname=blyth_twin")
    except:
        pass

    # Method 2: Use password from environment
    password = os.environ.get("PGPASSWORD", "")
    try:
        return psycopg2.connect(
            host="localhost",
            database="blyth_twin",
            user="postgres",
            password=password
        )
    except:
        pass

    # Method 3: Try with local socket and trust
    return psycopg2.connect(
        "dbname=blyth_twin host=localhost user=postgres"
    )


def transform_geometry(geom_dict: dict) -> str:
    """Transform GeoJSON geometry to WKB in BNG (EPSG:27700)."""
    geom = shape(geom_dict)

    # Transform coordinates from WGS84 to BNG
    if geom.geom_type == 'Polygon':
        exterior = [WGS84_TO_BNG.transform(x, y) for x, y in geom.exterior.coords]
        interiors = [[WGS84_TO_BNG.transform(x, y) for x, y in ring.coords]
                     for ring in geom.interiors]
        from shapely.geometry import Polygon
        geom = Polygon(exterior, interiors)
    elif geom.geom_type == 'LineString':
        coords = [WGS84_TO_BNG.transform(x, y) for x, y in geom.coords]
        from shapely.geometry import LineString
        geom = LineString(coords)
    elif geom.geom_type == 'Point':
        x, y = WGS84_TO_BNG.transform(geom.x, geom.y)
        from shapely.geometry import Point
        geom = Point(x, y)
    elif geom.geom_type == 'MultiPolygon':
        from shapely.geometry import MultiPolygon, Polygon
        polygons = []
        for poly in geom.geoms:
            exterior = [WGS84_TO_BNG.transform(x, y) for x, y in poly.exterior.coords]
            interiors = [[WGS84_TO_BNG.transform(x, y) for x, y in ring.coords]
                         for ring in poly.interiors]
            polygons.append(Polygon(exterior, interiors))
        geom = MultiPolygon(polygons)

    return geom.wkb_hex


def migrate_buildings(conn):
    """Migrate buildings from GeoJSON to PostGIS."""
    buildings_path = PROCESSED_DIR / "buildings_height.geojson"

    if not buildings_path.exists():
        print(f"  Buildings file not found: {buildings_path}")
        return 0

    print(f"  Loading {buildings_path}...")
    with open(buildings_path) as f:
        data = json.load(f)

    features = data["features"]
    print(f"  Found {len(features)} buildings")

    cur = conn.cursor()

    # Clear existing data
    cur.execute("TRUNCATE buildings RESTART IDENTITY CASCADE")

    # Prepare batch insert
    rows = []
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry")

        if not geom or geom.get("type") != "Polygon":
            continue

        try:
            geom_wkb = transform_geometry(geom)
        except Exception as e:
            continue

        # Extract address fields (handle both : and _ variants)
        addr_housenumber = props.get("addr:housenumber") or props.get("addr_housenumber")
        addr_housename = props.get("addr:housename") or props.get("addr_housename")
        addr_street = props.get("addr:street") or props.get("addr_street")
        addr_postcode = props.get("addr:postcode") or props.get("addr_postcode")
        addr_city = props.get("addr:city") or props.get("addr_city")
        addr_suburb = props.get("addr:suburb") or props.get("addr_suburb")

        row = (
            props.get("osm_id"),
            geom_wkb,
            props.get("height"),
            props.get("height_source"),
            props.get("building:levels"),
            props.get("building", "yes"),
            addr_housenumber,
            addr_housename,
            addr_street,
            addr_postcode,
            addr_city,
            addr_suburb,
            props.get("name"),
            props.get("amenity"),
            props.get("shop"),
            props.get("office"),
            json.dumps(props)
        )
        rows.append(row)

    # Batch insert
    sql = """
        INSERT INTO buildings (
            osm_id, geometry, height, height_source, levels, building_type,
            addr_housenumber, addr_housename, addr_street, addr_postcode,
            addr_city, addr_suburb, name, amenity, shop, office, tags
        ) VALUES %s
    """

    template = """(
        %s, ST_SetSRID(ST_GeomFromWKB(decode(%s, 'hex')), 27700),
        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
    )"""

    execute_values(cur, sql, rows, template=template, page_size=1000)

    # Update centroids
    cur.execute("UPDATE buildings SET centroid = ST_Centroid(geometry)")

    conn.commit()

    # Count
    cur.execute("SELECT COUNT(*) FROM buildings")
    count = cur.fetchone()[0]

    cur.close()
    return count


def migrate_roads(conn):
    """Migrate roads from GeoJSON to PostGIS."""
    roads_path = RAW_DIR / "roads.geojson"

    if not roads_path.exists():
        print(f"  Roads file not found: {roads_path}")
        return 0

    print(f"  Loading {roads_path}...")
    with open(roads_path) as f:
        data = json.load(f)

    features = data["features"]
    print(f"  Found {len(features)} roads")

    cur = conn.cursor()
    cur.execute("TRUNCATE roads RESTART IDENTITY CASCADE")

    rows = []
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry")

        if not geom or geom.get("type") != "LineString":
            continue

        try:
            geom_wkb = transform_geometry(geom)
        except Exception:
            continue

        row = (
            props.get("osm_id"),
            geom_wkb,
            props.get("highway"),
            props.get("name"),
            props.get("ref"),
            json.dumps(props)
        )
        rows.append(row)

    sql = """
        INSERT INTO roads (osm_id, geometry, highway_type, name, ref, tags)
        VALUES %s
    """
    template = "(%s, ST_SetSRID(ST_GeomFromWKB(decode(%s, 'hex')), 27700), %s, %s, %s, %s)"

    execute_values(cur, sql, rows, template=template, page_size=1000)
    conn.commit()

    cur.execute("SELECT COUNT(*) FROM roads")
    count = cur.fetchone()[0]
    cur.close()
    return count


def migrate_water(conn):
    """Migrate water features from GeoJSON to PostGIS."""
    water_path = RAW_DIR / "water.geojson"

    if not water_path.exists():
        print(f"  Water file not found: {water_path}")
        return 0

    print(f"  Loading {water_path}...")
    with open(water_path) as f:
        data = json.load(f)

    features = data["features"]
    print(f"  Found {len(features)} water features")

    cur = conn.cursor()
    cur.execute("TRUNCATE water_features RESTART IDENTITY CASCADE")

    rows = []
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry")

        if not geom:
            continue

        try:
            geom_wkb = transform_geometry(geom)
        except Exception:
            continue

        water_type = props.get("waterway") or props.get("natural") or props.get("water") or "unknown"

        row = (
            props.get("osm_id"),
            geom_wkb,
            water_type,
            props.get("name"),
            json.dumps(props)
        )
        rows.append(row)

    sql = """
        INSERT INTO water_features (osm_id, geometry, water_type, name, tags)
        VALUES %s
    """
    template = "(%s, ST_SetSRID(ST_GeomFromWKB(decode(%s, 'hex')), 27700), %s, %s, %s)"

    execute_values(cur, sql, rows, template=template, page_size=1000)
    conn.commit()

    cur.execute("SELECT COUNT(*) FROM water_features")
    count = cur.fetchone()[0]
    cur.close()
    return count


def migrate_aoi(conn):
    """Migrate AOI from GeoJSON to PostGIS."""
    aoi_path = CONFIG_DIR / "aoi.geojson"

    if not aoi_path.exists():
        print(f"  AOI file not found: {aoi_path}")
        return 0

    print(f"  Loading {aoi_path}...")
    with open(aoi_path) as f:
        data = json.load(f)

    feat = data["features"][0]
    props = feat["properties"]

    cur = conn.cursor()
    cur.execute("TRUNCATE aoi RESTART IDENTITY CASCADE")

    # AOI geometry (already in WGS84, need to transform)
    geom = feat["geometry"]
    geom_wkb = transform_geometry(geom)

    # Centre point
    centre_bng = props["centre_bng"]

    cur.execute("""
        INSERT INTO aoi (name, geometry, centre, side_length_m)
        VALUES (%s, ST_SetSRID(ST_GeomFromWKB(decode(%s, 'hex')), 27700),
                ST_SetSRID(ST_MakePoint(%s, %s), 27700), %s)
    """, (props.get("name", "Blyth"), geom_wkb, centre_bng[0], centre_bng[1], props["side_length_m"]))

    conn.commit()
    cur.close()
    return 1


def create_chunks(conn):
    """Create chunk records based on building distribution."""
    cur = conn.cursor()
    cur.execute("TRUNCATE chunks RESTART IDENTITY CASCADE")

    # Get settings for chunk size
    import yaml
    settings_path = CONFIG_DIR / "settings.yaml"
    with open(settings_path) as f:
        settings = yaml.safe_load(f)

    chunk_size = settings["terrain"]["chunk_size_m"]

    # Get AOI centre
    cur.execute("SELECT ST_X(centre), ST_Y(centre) FROM aoi LIMIT 1")
    row = cur.fetchone()
    if not row:
        cur.close()
        return 0

    origin_x, origin_y = row

    # Find unique chunks from buildings
    cur.execute(f"""
        SELECT
            FLOOR((ST_X(centroid) - {origin_x}) / {chunk_size})::int AS chunk_x,
            FLOOR((ST_Y(centroid) - {origin_y}) / {chunk_size})::int AS chunk_y,
            COUNT(*) as building_count
        FROM buildings
        WHERE centroid IS NOT NULL
        GROUP BY chunk_x, chunk_y
    """)

    chunks = cur.fetchall()

    for chunk_x, chunk_y, building_count in chunks:
        chunk_key = f"{chunk_x}_{chunk_y}"

        # Calculate chunk bounds
        min_x = origin_x + chunk_x * chunk_size
        min_y = origin_y + chunk_y * chunk_size
        max_x = min_x + chunk_size
        max_y = min_y + chunk_size

        # Check for reference imagery
        sv_path = DATA_DIR / "reference" / "streetview" / chunk_key
        aerial_path = DATA_DIR / "reference" / "aerial" / f"{chunk_key}.jpg"

        cur.execute("""
            INSERT INTO chunks (chunk_key, chunk_x, chunk_y, geometry, building_count, has_streetview, has_aerial)
            VALUES (%s, %s, %s,
                    ST_SetSRID(ST_MakeEnvelope(%s, %s, %s, %s), 27700),
                    %s, %s, %s)
        """, (chunk_key, chunk_x, chunk_y, min_x, min_y, max_x, max_y,
              building_count, sv_path.exists(), aerial_path.exists()))

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM chunks")
    count = cur.fetchone()[0]
    cur.close()
    return count


def print_stats(conn):
    """Print database statistics."""
    cur = conn.cursor()

    print("\n" + "=" * 50)
    print("DATABASE STATISTICS")
    print("=" * 50)

    # Buildings
    cur.execute("SELECT COUNT(*) FROM buildings")
    print(f"Buildings: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE addr_street IS NOT NULL")
    print(f"  - with street address: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE addr_postcode IS NOT NULL")
    print(f"  - with postcode: {cur.fetchone()[0]:,}")

    # Roads
    cur.execute("SELECT COUNT(*) FROM roads")
    print(f"Roads: {cur.fetchone()[0]:,}")

    # Water
    cur.execute("SELECT COUNT(*) FROM water_features")
    print(f"Water features: {cur.fetchone()[0]:,}")

    # Chunks
    cur.execute("SELECT COUNT(*) FROM chunks")
    print(f"Chunks: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM chunks WHERE has_streetview")
    print(f"  - with Street View: {cur.fetchone()[0]:,}")

    # Sample addresses
    print("\nSample addresses:")
    cur.execute("""
        SELECT addr_housenumber, addr_street, addr_postcode
        FROM buildings
        WHERE addr_street IS NOT NULL AND addr_housenumber IS NOT NULL
        LIMIT 5
    """)
    for row in cur.fetchall():
        print(f"  {row[0]} {row[1]}, {row[2] or 'no postcode'}")

    cur.close()


def main():
    """Run migration."""
    print("=" * 50)
    print("MIGRATING DATA TO POSTGIS")
    print("=" * 50)
    print()

    conn = get_connection()

    print("Migrating buildings...")
    building_count = migrate_buildings(conn)
    print(f"  Migrated: {building_count:,} buildings")

    print("\nMigrating roads...")
    road_count = migrate_roads(conn)
    print(f"  Migrated: {road_count:,} roads")

    print("\nMigrating water features...")
    water_count = migrate_water(conn)
    print(f"  Migrated: {water_count:,} water features")

    print("\nMigrating AOI...")
    aoi_count = migrate_aoi(conn)
    print(f"  Migrated: {aoi_count} AOI")

    print("\nCreating chunks...")
    chunk_count = create_chunks(conn)
    print(f"  Created: {chunk_count} chunks")

    print_stats(conn)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
