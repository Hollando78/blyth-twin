#!/usr/bin/env python3
"""
26_geocode_addresses.py - Batch reverse geocode building addresses

Uses Nominatim to find house numbers and postcodes for buildings
without address data. Updates PostGIS database directly.

Usage:
    python 26_geocode_addresses.py [--batch-size 1000] [--delay 1.1]
"""

import argparse
import os
import sys
import time
from datetime import datetime

import psycopg2
import requests
from pyproj import Transformer

# Coordinate transformer (BNG to WGS84 for Nominatim)
BNG_TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)

# Nominatim settings
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "BlythDigitalTwin/1.0 (building address lookup)"


def get_connection():
    """Get database connection."""
    password = os.environ.get("PGPASSWORD", "blyth123")
    return psycopg2.connect(
        host="localhost",
        database="blyth_twin",
        user="postgres",
        password=password
    )


def reverse_geocode(lat: float, lon: float) -> dict | None:
    """Reverse geocode a coordinate using Nominatim."""
    params = {
        "lat": lat,
        "lon": lon,
        "format": "jsonv2",
        "addressdetails": 1
    }
    headers = {"User-Agent": USER_AGENT}

    try:
        resp = requests.get(NOMINATIM_URL, params=params, headers=headers, timeout=10)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        print(f"    Error: {e}")

    return None


def extract_address(data: dict) -> dict:
    """Extract house number and postcode from Nominatim response."""
    if not data:
        return {}

    addr = data.get("address", {})
    result = {}

    if addr.get("house_number"):
        result["housenumber"] = addr["house_number"]

    if addr.get("postcode"):
        result["postcode"] = addr["postcode"]

    # Also grab street if available
    road = addr.get("road") or addr.get("pedestrian") or addr.get("footway")
    if road:
        result["street"] = road

    return result


def get_buildings_needing_addresses(conn, limit: int) -> list:
    """Get buildings that need address data."""
    cur = conn.cursor()

    # Get buildings without house number AND without postcode
    # Order by OSM ID for consistent batching
    cur.execute("""
        SELECT id, osm_id, ST_X(centroid), ST_Y(centroid)
        FROM buildings
        WHERE centroid IS NOT NULL
          AND addr_housenumber IS NULL
          AND addr_postcode IS NULL
        ORDER BY id
        LIMIT %s
    """, (limit,))

    buildings = cur.fetchall()
    cur.close()
    return buildings


def update_building_address(conn, building_id: int, address: dict):
    """Update a building's address in the database."""
    cur = conn.cursor()

    updates = []
    values = []

    if address.get("housenumber"):
        updates.append("addr_housenumber = %s")
        values.append(address["housenumber"])

    if address.get("postcode"):
        updates.append("addr_postcode = %s")
        values.append(address["postcode"])

    if address.get("street") and not address.get("existing_street"):
        updates.append("addr_street = COALESCE(addr_street, %s)")
        values.append(address["street"])

    if updates:
        updates.append("updated_at = NOW()")
        values.append(building_id)

        sql = f"UPDATE buildings SET {', '.join(updates)} WHERE id = %s"
        cur.execute(sql, values)

    cur.close()


def run_batch(batch_size: int, delay: float):
    """Run a batch of geocoding requests."""
    conn = get_connection()

    print(f"\n{'='*60}")
    print(f"BATCH REVERSE GEOCODING")
    print(f"{'='*60}")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Batch size: {batch_size}")
    print(f"Delay: {delay}s between requests")
    print()

    # Get buildings needing addresses
    buildings = get_buildings_needing_addresses(conn, batch_size)
    total = len(buildings)

    if total == 0:
        print("No buildings need addresses!")
        conn.close()
        return

    print(f"Processing {total} buildings...")
    print()

    found_housenumber = 0
    found_postcode = 0
    failed = 0

    start_time = time.time()

    for idx, (building_id, osm_id, x, y) in enumerate(buildings):
        # Convert BNG to WGS84
        lon, lat = BNG_TO_WGS84.transform(x, y)

        # Reverse geocode
        result = reverse_geocode(lat, lon)
        address = extract_address(result)

        if address:
            update_building_address(conn, building_id, address)
            conn.commit()

            if address.get("housenumber"):
                found_housenumber += 1
            if address.get("postcode"):
                found_postcode += 1
        else:
            failed += 1

        # Progress every 100
        if (idx + 1) % 100 == 0:
            elapsed = time.time() - start_time
            rate = (idx + 1) / elapsed
            remaining = (total - idx - 1) / rate if rate > 0 else 0
            print(f"  [{idx+1}/{total}] House#: {found_housenumber}, Postcode: {found_postcode}, Failed: {failed} | {remaining/60:.1f}m remaining")

        # Rate limiting
        time.sleep(delay)

    elapsed = time.time() - start_time

    print()
    print(f"{'='*60}")
    print(f"COMPLETE")
    print(f"{'='*60}")
    print(f"Processed: {total}")
    print(f"Found house numbers: {found_housenumber}")
    print(f"Found postcodes: {found_postcode}")
    print(f"Failed: {failed}")
    print(f"Time: {elapsed/60:.1f} minutes")
    print()

    # Show remaining count
    remaining = get_buildings_needing_addresses(conn, 1)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM buildings WHERE addr_housenumber IS NULL AND addr_postcode IS NULL")
    still_need = cur.fetchone()[0]
    cur.close()

    print(f"Buildings still needing addresses: {still_need}")

    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Batch reverse geocode building addresses")
    parser.add_argument("--batch-size", type=int, default=1000,
                        help="Number of buildings to process (default: 1000)")
    parser.add_argument("--delay", type=float, default=1.1,
                        help="Delay between requests in seconds (default: 1.1)")
    args = parser.parse_args()

    run_batch(args.batch_size, args.delay)


if __name__ == "__main__":
    main()
