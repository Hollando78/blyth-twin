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


def is_linear_waterway(tags: dict) -> bool:
    """Check if a water feature is a linear waterway (stream, river, etc.) vs area."""
    # Linear waterway types that should be rendered as ribbons
    linear_types = {"stream", "river", "drain", "ditch", "canal", "brook"}
    waterway = tags.get("waterway", "")
    return waterway in linear_types


def overpass_to_geojson(data: dict, feature_type: str) -> dict:
    """Convert Overpass JSON to GeoJSON."""
    features = []

    # Build node lookup for ways
    nodes = {n["id"]: (n["lon"], n["lat"]) for n in data.get("elements", []) if n["type"] == "node"}

    # Build way lookup for relations
    ways = {}
    for element in data.get("elements", []):
        if element["type"] == "way" and "nodes" in element:
            coords = [nodes[nid] for nid in element["nodes"] if nid in nodes]
            if len(coords) >= 2:
                ways[element["id"]] = coords

    for element in data.get("elements", []):
        # Handle point features (e.g., wind turbines)
        if element["type"] == "node" and element.get("tags"):
            tags = element.get("tags", {})
            tags["osm_id"] = element["id"]  # Add OSM ID
            tags["osm_type"] = "node"
            geometry = {
                "type": "Point",
                "coordinates": (element["lon"], element["lat"])
            }
            features.append({
                "type": "Feature",
                "properties": tags,
                "geometry": geometry
            })

        elif element["type"] == "way" and "nodes" in element:
            coords = [nodes[nid] for nid in element["nodes"] if nid in nodes]
            if len(coords) < 2:
                continue

            tags = element.get("tags", {})

            # Determine geometry type based on feature
            if feature_type == "water":
                # Linear waterways (streams, rivers) stay as LineStrings
                # Area water bodies (ponds, lakes) become Polygons
                if is_linear_waterway(tags):
                    geom_type = "LineString"
                else:
                    geom_type = "Polygon"
                    if coords[0] != coords[-1]:
                        coords.append(coords[0])
            elif feature_type == "building":
                geom_type = "Polygon"
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
            else:
                geom_type = "LineString"

            geometry = {
                "type": geom_type,
                "coordinates": [coords] if geom_type == "Polygon" else coords
            }

            tags["osm_id"] = element["id"]  # Add OSM ID
            tags["osm_type"] = "way"
            features.append({
                "type": "Feature",
                "properties": tags,
                "geometry": geometry
            })

        elif element["type"] == "relation" and "members" in element:
            # Handle multipolygon relations
            tags = element.get("tags", {})
            outer_rings = []
            inner_rings = []

            for member in element["members"]:
                if member["type"] == "way" and member["ref"] in ways:
                    coords = ways[member["ref"]][:]
                    if coords[0] != coords[-1]:
                        coords.append(coords[0])
                    if member.get("role") == "inner":
                        inner_rings.append(coords)
                    else:
                        outer_rings.append(coords)

            if outer_rings:
                # Create polygon(s) from outer rings
                # For simplicity, treat each outer ring as separate polygon
                tags["osm_id"] = element["id"]  # Add OSM ID
                tags["osm_type"] = "relation"
                for outer in outer_rings:
                    if len(outer) >= 4:  # Valid polygon needs at least 4 points
                        geometry = {
                            "type": "Polygon",
                            "coordinates": [outer] + inner_rings
                        }
                        features.append({
                            "type": "Feature",
                            "properties": tags.copy(),  # Copy to avoid sharing between polygons
                            "geometry": geometry
                        })

    return {
        "type": "FeatureCollection",
        "features": features
    }


def fetch_buildings(bbox: tuple) -> dict:
    """Fetch building footprints and wind turbines."""
    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:180];
    (
      way["building"]({south},{west},{north},{east});
      relation["building"]({south},{west},{north},{east});
      node["man_made"="wind_turbine"]({south},{west},{north},{east});
      node["power"="generator"]["generator:source"="wind"]({south},{west},{north},{east});
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


def fetch_railways(bbox: tuple) -> dict:
    """Fetch railway lines."""
    south, west, north, east = bbox
    query = f"""
    [out:json][timeout:180];
    (
      way["railway"~"rail|light_rail|tram|subway|narrow_gauge"]({south},{west},{north},{east});
    );
    out body;
    >;
    out skel qt;
    """
    data = query_overpass(query)
    return overpass_to_geojson(data, "railway")


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
    time.sleep(2)

    print("\nFetching railways...")
    railways = fetch_railways(bbox)
    save_geojson(railways, OSM_DIR / "railways.geojson")

    print("\nDone!")
    print(f"\nSummary:")
    print(f"  Buildings: {len(buildings['features'])}")
    print(f"  Roads: {len(roads['features'])}")
    print(f"  Water: {len(water['features'])}")
    print(f"  Coastline: {len(coast['features'])}")
    print(f"  Railways: {len(railways['features'])}")


if __name__ == "__main__":
    main()
