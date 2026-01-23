#!/usr/bin/env python3
"""
20_fetch_osm.py - OSM Vector Download

Downloads OpenStreetMap data for the Blyth AOI using the Overpass API.

Input:
    - config/aoi.geojson (AOI boundary)

Output:
    - data/raw/osm/buildings.geojson
    - data/raw/osm/roads.geojson
    - data/raw/osm/water.geojson
    - data/raw/osm/coast.geojson

Usage:
    python 20_fetch_osm.py
"""

import json
import time
from pathlib import Path

import httpx
import yaml
from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
OSM_DIR = DATA_DIR / "raw" / "osm"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def load_aoi_bbox_wgs84() -> tuple[float, float, float, float]:
    """Load AOI and return bounding box in WGS84 (south, west, north, east)."""
    aoi_file = CONFIG_DIR / "aoi.geojson"
    with open(aoi_file) as f:
        aoi = json.load(f)

    geom = shape(aoi["features"][0]["geometry"])

    # Transform from BNG to WGS84
    transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    geom_wgs84 = transform(transformer.transform, geom)

    bounds = geom_wgs84.bounds  # (minx, miny, maxx, maxy)
    # Overpass wants (south, west, north, east)
    return (bounds[1], bounds[0], bounds[3], bounds[2])


def query_overpass(query: str, timeout: int = 180) -> dict:
    """Execute Overpass API query."""
    print(f"Querying Overpass API...")
    with httpx.Client(timeout=timeout) as client:
        response = client.post(OVERPASS_URL, data={"data": query})
        response.raise_for_status()
        return response.json()


def overpass_to_geojson(data: dict, feature_type: str) -> dict:
    """Convert Overpass JSON to GeoJSON."""
    features = []

    # Build node lookup for ways
    nodes = {n["id"]: (n["lon"], n["lat"]) for n in data.get("elements", []) if n["type"] == "node"}

    for element in data.get("elements", []):
        if element["type"] == "way" and "nodes" in element:
            coords = [nodes[nid] for nid in element["nodes"] if nid in nodes]
            if len(coords) < 2:
                continue

            # Close polygon if needed for areas
            if feature_type in ["building", "water"] and coords[0] != coords[-1]:
                coords.append(coords[0])

            geom_type = "Polygon" if feature_type in ["building", "water"] else "LineString"
            geometry = {
                "type": geom_type,
                "coordinates": [coords] if geom_type == "Polygon" else coords
            }

            features.append({
                "type": "Feature",
                "properties": element.get("tags", {}),
                "geometry": geometry
            })

    return {
        "type": "FeatureCollection",
        "features": features
    }


def fetch_buildings(bbox: tuple) -> dict:
    """Fetch building footprints."""
    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:180];
    (
      way["building"]({south},{west},{north},{east});
    );
    out body;
    >;
    out skel qt;
    """
    data = query_overpass(query)
    return overpass_to_geojson(data, "building")


def fetch_roads(bbox: tuple) -> dict:
    """Fetch roads and paths."""
    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:180];
    (
      way["highway"]({south},{west},{north},{east});
    );
    out body;
    >;
    out skel qt;
    """
    data = query_overpass(query)
    return overpass_to_geojson(data, "road")


def fetch_water(bbox: tuple) -> dict:
    """Fetch water features."""
    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:180];
    (
      way["natural"="water"]({south},{west},{north},{east});
      way["waterway"]({south},{west},{north},{east});
      relation["natural"="water"]({south},{west},{north},{east});
    );
    out body;
    >;
    out skel qt;
    """
    data = query_overpass(query)
    return overpass_to_geojson(data, "water")


def fetch_coastline(bbox: tuple) -> dict:
    """Fetch coastline."""
    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:180];
    (
      way["natural"="coastline"]({south},{west},{north},{east});
    );
    out body;
    >;
    out skel qt;
    """
    data = query_overpass(query)
    return overpass_to_geojson(data, "coast")


def save_geojson(data: dict, filepath: Path):
    """Save GeoJSON to file."""
    with open(filepath, "w") as f:
        json.dump(data, f)
    print(f"  Written: {filepath} ({len(data['features'])} features)")


def main():
    """Fetch all OSM data."""
    print("Loading AOI...")
    bbox = load_aoi_bbox_wgs84()
    print(f"Bounding box (WGS84): S={bbox[0]:.4f}, W={bbox[1]:.4f}, N={bbox[2]:.4f}, E={bbox[3]:.4f}")

    OSM_DIR.mkdir(parents=True, exist_ok=True)

    # Fetch each dataset with delays to be nice to Overpass
    print("\nFetching buildings...")
    buildings = fetch_buildings(bbox)
    save_geojson(buildings, OSM_DIR / "buildings.geojson")
    time.sleep(2)

    print("\nFetching roads...")
    roads = fetch_roads(bbox)
    save_geojson(roads, OSM_DIR / "roads.geojson")
    time.sleep(2)

    print("\nFetching water...")
    water = fetch_water(bbox)
    save_geojson(water, OSM_DIR / "water.geojson")
    time.sleep(2)

    print("\nFetching coastline...")
    coast = fetch_coastline(bbox)
    save_geojson(coast, OSM_DIR / "coast.geojson")

    print("\nDone!")
    print(f"\nSummary:")
    print(f"  Buildings: {len(buildings['features'])}")
    print(f"  Roads: {len(roads['features'])}")
    print(f"  Water: {len(water['features'])}")
    print(f"  Coastline: {len(coast['features'])}")


if __name__ == "__main__":
    main()
