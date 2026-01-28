#!/usr/bin/env python3
"""
25_fetch_uprn.py - Fetch OS Open UPRN Data

Downloads OS Open UPRN data and matches addresses to buildings.

OS Open UPRN provides:
- UPRN (Unique Property Reference Number)
- Coordinates (BNG and WGS84)

For full addresses, we use the OS Places API or fallback to
constructing addresses from OS Open Names.

Input:
    - config/aoi.geojson (AOI bounds)
    - data/processed/buildings_height.geojson

Output:
    - data/raw/uprn/uprn_points.geojson
    - data/processed/buildings_height.geojson (updated with UPRNs)

Usage:
    python 25_fetch_uprn.py

Note: OS Open UPRN is downloaded from OS Data Hub (free registration required)
      https://osdatahub.os.uk/downloads/open/OpenUPRN
"""

import json
import os
import zipfile
from pathlib import Path
from io import BytesIO

import requests
from pyproj import Transformer

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"

# Coordinate transformer
BNG_TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

# OS Data Hub - Open UPRN download
# The full dataset is ~2GB, so we'll need to filter by area
UPRN_DOWNLOAD_URL = "https://api.os.uk/downloads/v1/products/OpenUPRN/downloads"


def load_aoi_bounds():
    """Load AOI bounds in BNG coordinates."""
    with open(CONFIG_DIR / "aoi.geojson") as f:
        aoi = json.load(f)

    props = aoi["features"][0]["properties"]
    centre = props["centre_bng"]
    side = props["side_length_m"]

    half = side / 2
    return {
        "min_x": centre[0] - half,
        "min_y": centre[1] - half,
        "max_x": centre[0] + half,
        "max_y": centre[1] + half
    }


def download_uprn_csv(output_dir: Path) -> Path | None:
    """
    Download OS Open UPRN CSV for the relevant area.

    OS Open UPRN is split by grid square. We need to identify
    which grid squares cover our AOI.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # OS Open UPRN is available as a single national file or by grid square
    # For efficiency, we'll try to download just the relevant grid squares

    # Blyth is in grid square NU (Northumberland)
    # The 100km grid square for Blyth area is NZ

    # Direct download URL for the full dataset (CSV format)
    # This is a large file (~400MB compressed), but we'll filter it

    csv_url = "https://api.os.uk/downloads/v1/products/OpenUPRN/downloads?area=GB&format=CSV&redirect"

    print("Note: OS Open UPRN requires downloading from OS Data Hub")
    print("Visit: https://osdatahub.os.uk/downloads/open/OpenUPRN")
    print()
    print("For this script, we'll use an alternative approach:")
    print("Fetching address data via Nominatim reverse geocoding...")

    return None


def reverse_geocode_nominatim(lat: float, lon: float) -> dict | None:
    """
    Reverse geocode a coordinate using Nominatim (free, rate-limited).
    """
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "lat": lat,
        "lon": lon,
        "format": "jsonv2",
        "addressdetails": 1
    }
    headers = {
        "User-Agent": "BlythDigitalTwin/1.0 (building address lookup)"
    }

    try:
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        pass

    return None


def extract_address_from_nominatim(data: dict) -> dict:
    """Extract structured address from Nominatim response."""
    if not data:
        return {}

    addr = data.get("address", {})

    result = {}

    # House number
    if addr.get("house_number"):
        result["addr:housenumber"] = addr["house_number"]

    # Street
    road = addr.get("road") or addr.get("pedestrian") or addr.get("footway")
    if road:
        result["addr:street"] = road

    # Postcode
    if addr.get("postcode"):
        result["addr:postcode"] = addr["postcode"]

    # City/Town
    city = addr.get("city") or addr.get("town") or addr.get("village")
    if city:
        result["addr:city"] = city

    # Suburb
    if addr.get("suburb"):
        result["addr:suburb"] = addr["suburb"]

    return result


def batch_reverse_geocode(buildings_path: Path, output_path: Path,
                          max_requests: int = 1000, delay: float = 1.0):
    """
    Add addresses to buildings via reverse geocoding.

    Note: Nominatim has a rate limit of 1 request/second.
    For 17k buildings, this would take ~5 hours.
    We'll prioritize buildings without addresses.
    """
    import time

    print(f"Loading buildings from {buildings_path}...")
    with open(buildings_path) as f:
        data = json.load(f)

    features = data["features"]
    total = len(features)

    # Count buildings needing addresses
    needs_address = []
    has_address = 0

    for i, feat in enumerate(features):
        props = feat.get("properties", {})
        if props.get("addr:street") or props.get("addr:housenumber"):
            has_address += 1
        else:
            needs_address.append(i)

    print(f"Total buildings: {total}")
    print(f"Already have address: {has_address}")
    print(f"Need address: {len(needs_address)}")
    print()

    if not needs_address:
        print("All buildings already have addresses!")
        return

    # Limit requests
    to_process = needs_address[:max_requests]
    print(f"Will geocode {len(to_process)} buildings (rate limited)")
    print(f"Estimated time: {len(to_process) * delay / 60:.1f} minutes")
    print()

    success = 0
    failed = 0

    for idx, feat_idx in enumerate(to_process):
        feat = features[feat_idx]
        geom = feat.get("geometry", {})

        if geom.get("type") != "Polygon":
            continue

        # Get centroid
        coords = geom["coordinates"][0]
        lon = sum(c[0] for c in coords) / len(coords)
        lat = sum(c[1] for c in coords) / len(coords)

        # Reverse geocode
        result = reverse_geocode_nominatim(lat, lon)

        if result:
            addr = extract_address_from_nominatim(result)
            if addr:
                # Update properties
                feat["properties"].update(addr)
                success += 1
            else:
                failed += 1
        else:
            failed += 1

        # Progress
        if (idx + 1) % 50 == 0:
            print(f"  Processed {idx + 1}/{len(to_process)} - Success: {success}, Failed: {failed}")

        # Rate limiting
        time.sleep(delay)

    print()
    print(f"Geocoding complete: {success} addresses found, {failed} failed")

    # Save updated data
    print(f"Saving to {output_path}...")
    with open(output_path, "w") as f:
        json.dump(data, f)

    print("Done!")


def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="Fetch address data for buildings")
    parser.add_argument("--max-requests", type=int, default=500,
                        help="Maximum reverse geocoding requests (default: 500)")
    parser.add_argument("--delay", type=float, default=1.0,
                        help="Delay between requests in seconds (default: 1.0)")
    args = parser.parse_args()

    buildings_path = PROCESSED_DIR / "buildings_height.geojson"

    if not buildings_path.exists():
        print(f"Buildings file not found: {buildings_path}")
        return

    print("=" * 50)
    print("ADDRESS LOOKUP VIA NOMINATIM")
    print("=" * 50)
    print()
    print("This will reverse geocode building centroids to find addresses.")
    print("Nominatim is free but rate-limited to 1 request/second.")
    print()

    batch_reverse_geocode(
        buildings_path,
        buildings_path,  # Update in place
        max_requests=args.max_requests,
        delay=args.delay
    )


if __name__ == "__main__":
    main()
