#!/usr/bin/env python3
"""
22_enrich_buildings.py - Enrich Buildings with OSM POI Data

Fetches amenity/shop/tourism nodes from OSM and matches them to nearby buildings,
enriching building records with POI metadata (name, amenity type, address, etc.).

This handles the common OSM pattern where POI data is stored as separate nodes
rather than as tags on building polygons.

Input:
    - PostGIS buildings table (from 21_migrate_to_postgis.py)
    - config/aoi.geojson (AOI boundary)

Output:
    - Updated buildings table with enriched metadata

Usage:
    python 22_enrich_buildings.py
    python 22_enrich_buildings.py --twin-id <uuid>
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx
import psycopg2
from pyproj import Transformer

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"

# Module-level paths
_config_dir = CONFIG_DIR
_twin_id = None

# Coordinate transformers
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Maximum distance (meters) to match a POI node to a building
MAX_MATCH_DISTANCE_M = 15.0

# POI types to fetch
POI_QUERIES = [
    'node["amenity"]',
    'node["shop"]',
    'node["tourism"]',
    'node["office"]',
    'node["craft"]',
    'node["healthcare"]',
    'node["leisure"]',
]


def get_twin_paths(twin_id: str):
    """Get paths for twin-specific execution."""
    global _config_dir, _twin_id
    sys.path.insert(0, str(SCRIPT_DIR.parent))
    from lib.twin_config import get_twin_config
    config = get_twin_config(twin_id)
    _config_dir = config.config_dir
    _twin_id = twin_id
    return config


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


def load_aoi_bbox_wgs84() -> tuple[float, float, float, float]:
    """Load AOI and return bounding box in WGS84 (south, west, north, east)."""
    from shapely.geometry import shape
    from shapely.ops import transform

    aoi_file = _config_dir / "aoi.geojson"
    with open(aoi_file) as f:
        aoi = json.load(f)

    geom = shape(aoi["features"][0]["geometry"])

    # Transform from BNG to WGS84
    transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    geom_wgs84 = transform(transformer.transform, geom)

    bounds = geom_wgs84.bounds  # (minx, miny, maxx, maxy)
    # Overpass wants (south, west, north, east)
    return (bounds[1], bounds[0], bounds[3], bounds[2])


def fetch_poi_nodes(bbox: tuple) -> list[dict]:
    """Fetch POI nodes from Overpass API."""
    south, west, north, east = bbox

    # Build query for all POI types
    poi_filters = "\n      ".join([
        f'{q}({south},{west},{north},{east});'
        for q in POI_QUERIES
    ])

    query = f"""
    [out:json][timeout:180];
    (
      {poi_filters}
    );
    out body;
    """

    print(f"  Querying Overpass API for POI nodes...")
    with httpx.Client(timeout=180) as client:
        response = client.post(OVERPASS_URL, data={"data": query})
        response.raise_for_status()
        data = response.json()

    nodes = []
    for element in data.get("elements", []):
        if element["type"] == "node" and element.get("tags"):
            nodes.append({
                "osm_id": element["id"],
                "lat": element["lat"],
                "lon": element["lon"],
                "tags": element["tags"]
            })

    return nodes


def match_and_enrich_buildings(conn, poi_nodes: list[dict]) -> dict:
    """Match POI nodes to nearby buildings and enrich building data."""
    cur = conn.cursor()

    stats = {
        "total_pois": len(poi_nodes),
        "matched": 0,
        "updated_name": 0,
        "updated_amenity": 0,
        "updated_shop": 0,
        "updated_address": 0,
        "no_match": 0,
    }

    for poi in poi_nodes:
        # Transform POI coords to BNG
        x, y = WGS84_TO_BNG.transform(poi["lon"], poi["lat"])
        tags = poi["tags"]

        # Find nearest building within threshold
        cur.execute("""
            SELECT osm_id, name, amenity, shop,
                   addr_housenumber, addr_street, addr_postcode, addr_city,
                   ST_Distance(centroid, ST_SetSRID(ST_MakePoint(%s, %s), 27700)) as distance
            FROM buildings
            WHERE ST_DWithin(centroid, ST_SetSRID(ST_MakePoint(%s, %s), 27700), %s)
            ORDER BY centroid <-> ST_SetSRID(ST_MakePoint(%s, %s), 27700)
            LIMIT 1
        """, (x, y, x, y, MAX_MATCH_DISTANCE_M, x, y))

        row = cur.fetchone()
        if not row:
            stats["no_match"] += 1
            continue

        building_osm_id = row[0]
        existing_name = row[1]
        existing_amenity = row[2]
        existing_shop = row[3]
        existing_housenumber = row[4]
        existing_street = row[5]
        existing_postcode = row[6]
        existing_city = row[7]
        distance = row[8]

        stats["matched"] += 1

        # Build update query - only update NULL fields
        updates = []
        params = []

        # Name
        poi_name = tags.get("name")
        if poi_name and not existing_name:
            updates.append("name = %s")
            params.append(poi_name)
            stats["updated_name"] += 1

        # Amenity
        poi_amenity = tags.get("amenity")
        if poi_amenity and not existing_amenity:
            updates.append("amenity = %s")
            params.append(poi_amenity)
            stats["updated_amenity"] += 1

        # Shop
        poi_shop = tags.get("shop")
        if poi_shop and not existing_shop:
            updates.append("shop = %s")
            params.append(poi_shop)
            stats["updated_shop"] += 1

        # Office (store in amenity if amenity is empty)
        poi_office = tags.get("office")
        if poi_office and not existing_amenity and "amenity" not in [u.split(" =")[0] for u in updates]:
            updates.append("office = %s")
            params.append(poi_office)

        # Address fields
        addr_updated = False

        poi_housenumber = tags.get("addr:housenumber")
        if poi_housenumber and not existing_housenumber:
            updates.append("addr_housenumber = %s")
            params.append(poi_housenumber)
            addr_updated = True

        poi_street = tags.get("addr:street")
        if poi_street and not existing_street:
            updates.append("addr_street = %s")
            params.append(poi_street)
            addr_updated = True

        poi_postcode = tags.get("addr:postcode")
        if poi_postcode and not existing_postcode:
            updates.append("addr_postcode = %s")
            params.append(poi_postcode)
            addr_updated = True

        poi_city = tags.get("addr:city")
        if poi_city and not existing_city:
            updates.append("addr_city = %s")
            params.append(poi_city)
            addr_updated = True

        if addr_updated:
            stats["updated_address"] += 1

        # Execute update if there are changes
        if updates:
            updates.append("updated_at = NOW()")
            params.append(building_osm_id)

            sql = f"UPDATE buildings SET {', '.join(updates)} WHERE osm_id = %s"
            cur.execute(sql, params)

            print(f"    Enriched building {building_osm_id} with POI '{poi_name or tags.get('amenity') or tags.get('shop')}' ({distance:.1f}m)")

    conn.commit()
    cur.close()

    return stats


def print_enrichment_stats(conn):
    """Print statistics about enriched buildings."""
    cur = conn.cursor()

    print("\n" + "=" * 50)
    print("ENRICHMENT STATISTICS")
    print("=" * 50)

    cur.execute("SELECT COUNT(*) FROM buildings")
    print(f"Total buildings: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE name IS NOT NULL")
    print(f"Buildings with name: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE amenity IS NOT NULL")
    print(f"Buildings with amenity: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE shop IS NOT NULL")
    print(f"Buildings with shop: {cur.fetchone()[0]:,}")

    cur.execute("SELECT COUNT(*) FROM buildings WHERE addr_street IS NOT NULL")
    print(f"Buildings with street address: {cur.fetchone()[0]:,}")

    # Show enriched buildings
    cur.execute("""
        SELECT osm_id, name, amenity, shop, addr_street
        FROM buildings
        WHERE name IS NOT NULL OR amenity IS NOT NULL OR shop IS NOT NULL
        ORDER BY name
        LIMIT 20
    """)

    rows = cur.fetchall()
    if rows:
        print("\nEnriched buildings:")
        for row in rows:
            osm_id, name, amenity, shop, street = row
            desc = name or amenity or shop
            print(f"  {osm_id}: {desc}" + (f" ({street})" if street else ""))

    cur.close()


def main(twin_id: str = None):
    """Enrich buildings with POI data from OSM."""
    if twin_id:
        print(f"Twin mode: {twin_id}")
        get_twin_paths(twin_id)

    print("=" * 50)
    print("ENRICHING BUILDINGS WITH OSM POI DATA")
    print("=" * 50)
    print()

    print("Loading AOI...")
    bbox = load_aoi_bbox_wgs84()
    print(f"Bounding box (WGS84): S={bbox[0]:.4f}, W={bbox[1]:.4f}, N={bbox[2]:.4f}, E={bbox[3]:.4f}")

    print("\nFetching POI nodes from OSM...")
    poi_nodes = fetch_poi_nodes(bbox)
    print(f"  Found {len(poi_nodes)} POI nodes")

    if not poi_nodes:
        print("\nNo POI nodes found in area. Skipping enrichment.")
        return

    # Categorize POIs
    amenity_count = sum(1 for p in poi_nodes if "amenity" in p["tags"])
    shop_count = sum(1 for p in poi_nodes if "shop" in p["tags"])
    other_count = len(poi_nodes) - amenity_count - shop_count
    print(f"  Amenities: {amenity_count}, Shops: {shop_count}, Other: {other_count}")

    print("\nMatching POIs to buildings...")
    conn = get_connection()
    stats = match_and_enrich_buildings(conn, poi_nodes)

    print("\n" + "-" * 50)
    print("MATCHING RESULTS")
    print("-" * 50)
    print(f"Total POIs processed: {stats['total_pois']}")
    print(f"Matched to buildings: {stats['matched']}")
    print(f"No nearby building: {stats['no_match']}")
    print(f"Names added: {stats['updated_name']}")
    print(f"Amenities added: {stats['updated_amenity']}")
    print(f"Shops added: {stats['updated_shop']}")
    print(f"Addresses added: {stats['updated_address']}")

    print_enrichment_stats(conn)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Enrich buildings with OSM POI data")
    parser.add_argument("--twin-id", help="Twin UUID for twin-specific execution")
    args = parser.parse_args()
    main(args.twin_id)
