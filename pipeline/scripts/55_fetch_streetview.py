#!/usr/bin/env python3
"""
55_fetch_streetview.py - Street View Reference Imagery

Downloads Google Street View 360° imagery for each building chunk
to use as reference for AI texturing (e.g., Meshy).

Also downloads aerial/satellite tiles from ESRI as additional reference.

Input:
    - data/processed/buildings/ (chunk GLB files for coordinates)
    - config/aoi.geojson (AOI center)

Output:
    - data/reference/streetview/{chunk_key}/ (8 directional images per chunk)
    - data/reference/aerial/{chunk_key}.jpg (aerial crop per chunk)

Usage:
    export GOOGLE_API_KEY="your_key_here"
    python 55_fetch_streetview.py

API Costs (approximate):
    - Street View Static: $7 per 1000 requests
    - 73 chunks × 8 headings = 584 requests ≈ $4
    - Metadata API: Free
    - ESRI tiles: Free
"""

import json
import os
import time
from pathlib import Path
from io import BytesIO

import requests
from pyproj import Transformer
from PIL import Image

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
REFERENCE_DIR = DATA_DIR / "reference"

# Coordinate transformers
BNG_TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

# Google Street View API
STREETVIEW_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"
STREETVIEW_IMG_URL = "https://maps.googleapis.com/maps/api/streetview"

# ESRI World Imagery tiles
ESRI_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TILE_ZOOM = 18  # High detail for building reference


def load_settings() -> dict:
    """Load settings from config."""
    import yaml
    with open(CONFIG_DIR / "settings.yaml") as f:
        return yaml.safe_load(f)


def load_aoi_origin() -> tuple[float, float]:
    """Load AOI center as BNG coordinates."""
    with open(CONFIG_DIR / "aoi.geojson") as f:
        aoi = json.load(f)
    return tuple(aoi["features"][0]["properties"]["centre_bng"])


def get_chunk_center_wgs84(chunk_x: int, chunk_y: int, origin: tuple, chunk_size: float) -> tuple[float, float]:
    """Convert chunk grid coordinates to WGS84 lat/lon."""
    # Chunk center in BNG (relative to origin)
    center_x = origin[0] + (chunk_x + 0.5) * chunk_size
    center_y = origin[1] + (chunk_y + 0.5) * chunk_size

    # Convert to WGS84
    lon, lat = BNG_TO_WGS84.transform(center_x, center_y)
    return lat, lon


def get_nearest_panorama(lat: float, lon: float, api_key: str, radius: int = 100) -> dict | None:
    """
    Find nearest Street View panorama to a location.

    Returns:
        Dict with pano_id, lat, lon, date if found, None otherwise
    """
    params = {
        "location": f"{lat},{lon}",
        "radius": radius,
        "key": api_key,
        "source": "outdoor"  # Prefer outdoor imagery
    }

    try:
        resp = requests.get(STREETVIEW_META_URL, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        if data.get("status") == "OK":
            return {
                "pano_id": data["pano_id"],
                "lat": data["location"]["lat"],
                "lon": data["location"]["lng"],
                "date": data.get("date", "unknown")
            }
    except Exception as e:
        print(f"    Error checking panorama: {e}")

    return None


def download_streetview_360(pano_id: str, output_dir: Path, api_key: str,
                            size: str = "640x640", pitch: int = 10) -> int:
    """
    Download 360° Street View imagery as 8 directional images.

    Args:
        pano_id: Google panorama ID
        output_dir: Directory to save images
        api_key: Google API key
        size: Image size (width x height)
        pitch: Camera pitch (-90 to 90, positive = up)

    Returns:
        Number of successfully downloaded images
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # 8 directions for full 360° coverage with 90° FOV overlap
    headings = [0, 45, 90, 135, 180, 225, 270, 315]
    success_count = 0

    for heading in headings:
        params = {
            "pano": pano_id,
            "size": size,
            "heading": heading,
            "pitch": pitch,
            "fov": 90,
            "key": api_key
        }

        try:
            resp = requests.get(STREETVIEW_IMG_URL, params=params, timeout=30)

            if resp.status_code == 200 and len(resp.content) > 1000:
                img_path = output_dir / f"h{heading:03d}.jpg"
                img_path.write_bytes(resp.content)
                success_count += 1
            else:
                print(f"      Warning: Heading {heading}° returned invalid image")

        except Exception as e:
            print(f"      Error downloading heading {heading}°: {e}")

        # Small delay to avoid rate limiting
        time.sleep(0.1)

    return success_count


def create_360_composite(input_dir: Path, output_path: Path) -> bool:
    """
    Stitch 8 directional images into a single panoramic strip.

    Creates a 5120x640 image (8 × 640px wide).
    """
    headings = [0, 45, 90, 135, 180, 225, 270, 315]
    images = []

    for heading in headings:
        img_path = input_dir / f"h{heading:03d}.jpg"
        if img_path.exists():
            images.append(Image.open(img_path))
        else:
            # Create placeholder for missing images
            images.append(Image.new("RGB", (640, 640), (128, 128, 128)))

    if not images:
        return False

    # Create horizontal strip
    width = sum(img.width for img in images)
    height = images[0].height
    composite = Image.new("RGB", (width, height))

    x_offset = 0
    for img in images:
        composite.paste(img, (x_offset, 0))
        x_offset += img.width

    composite.save(output_path, "JPEG", quality=90)
    return True


def lat_lon_to_tile(lat: float, lon: float, zoom: int) -> tuple[int, int]:
    """Convert lat/lon to tile coordinates."""
    import math
    n = 2 ** zoom
    x = int((lon + 180) / 360 * n)
    lat_rad = math.radians(lat)
    y = int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)
    return x, y


def download_aerial_tile(lat: float, lon: float, output_path: Path,
                         zoom: int = 18, size: int = 512) -> bool:
    """
    Download aerial imagery tile centered on a location.

    Downloads a 3x3 grid of tiles and crops to center.
    """
    center_x, center_y = lat_lon_to_tile(lat, lon, zoom)

    # Download 3x3 grid for better coverage
    tile_size = 256
    grid_size = 3
    canvas = Image.new("RGB", (tile_size * grid_size, tile_size * grid_size), (100, 120, 100))

    for dy in range(-1, 2):
        for dx in range(-1, 2):
            tx = center_x + dx
            ty = center_y + dy

            url = ESRI_TILE_URL.format(z=zoom, x=tx, y=ty)

            try:
                resp = requests.get(url, timeout=10)
                if resp.status_code == 200:
                    img = Image.open(BytesIO(resp.content))
                    canvas.paste(img, ((dx + 1) * tile_size, (dy + 1) * tile_size))
            except Exception:
                pass  # Keep green placeholder

            time.sleep(0.05)  # Be nice to ESRI

    # Crop to center
    margin = (tile_size * grid_size - size) // 2
    cropped = canvas.crop((margin, margin, margin + size, margin + size))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(output_path, "JPEG", quality=90)
    return True


def process_all_chunks(api_key: str, skip_existing: bool = True):
    """Process all building chunks."""
    settings = load_settings()
    chunk_size = settings["terrain"]["chunk_size_m"]
    origin = load_aoi_origin()

    buildings_dir = PROCESSED_DIR / "buildings"
    streetview_dir = REFERENCE_DIR / "streetview"
    aerial_dir = REFERENCE_DIR / "aerial"

    # Find all building chunks
    chunk_files = sorted(buildings_dir.glob("buildings_*.glb"))

    if not chunk_files:
        print("No building chunks found!")
        return

    print(f"Found {len(chunk_files)} building chunks")
    print(f"Origin (BNG): {origin}")
    print(f"Chunk size: {chunk_size}m")
    print()

    # Statistics
    stats = {
        "total": len(chunk_files),
        "streetview_found": 0,
        "streetview_downloaded": 0,
        "aerial_downloaded": 0,
        "skipped": 0
    }

    for i, chunk_file in enumerate(chunk_files):
        # Parse chunk coordinates from filename (buildings_X_Y.glb)
        parts = chunk_file.stem.split("_")
        chunk_x = int(parts[1])
        chunk_y = int(parts[2])
        chunk_key = f"{chunk_x}_{chunk_y}"

        print(f"[{i+1}/{len(chunk_files)}] Chunk {chunk_key}")

        # Get chunk center in WGS84
        lat, lon = get_chunk_center_wgs84(chunk_x, chunk_y, origin, chunk_size)
        print(f"  Center: {lat:.6f}, {lon:.6f}")

        # Check if already processed
        sv_dir = streetview_dir / chunk_key
        aerial_path = aerial_dir / f"{chunk_key}.jpg"

        if skip_existing and sv_dir.exists() and aerial_path.exists():
            print("  Skipping (already exists)")
            stats["skipped"] += 1
            continue

        # Download Street View
        if api_key:
            pano = get_nearest_panorama(lat, lon, api_key)

            if pano:
                print(f"  Street View: Found pano from {pano['date']} at {pano['lat']:.6f}, {pano['lon']:.6f}")
                stats["streetview_found"] += 1

                if not (skip_existing and sv_dir.exists()):
                    img_count = download_streetview_360(pano["pano_id"], sv_dir, api_key)
                    print(f"  Downloaded {img_count}/8 images")

                    if img_count > 0:
                        stats["streetview_downloaded"] += 1

                        # Create composite
                        composite_path = sv_dir / "composite.jpg"
                        create_360_composite(sv_dir, composite_path)
                        print(f"  Created composite panorama")
            else:
                print("  Street View: No coverage")

        # Download aerial imagery
        if not (skip_existing and aerial_path.exists()):
            download_aerial_tile(lat, lon, aerial_path, zoom=TILE_ZOOM)
            print(f"  Aerial: Downloaded")
            stats["aerial_downloaded"] += 1

        print()

        # Rate limiting
        time.sleep(0.2)

    # Summary
    print("=" * 50)
    print("SUMMARY")
    print("=" * 50)
    print(f"Total chunks: {stats['total']}")
    print(f"Skipped (existing): {stats['skipped']}")
    print(f"Street View coverage: {stats['streetview_found']}/{stats['total'] - stats['skipped']}")
    print(f"Street View downloaded: {stats['streetview_downloaded']}")
    print(f"Aerial downloaded: {stats['aerial_downloaded']}")
    print()
    print(f"Output directories:")
    print(f"  Street View: {streetview_dir}")
    print(f"  Aerial: {aerial_dir}")


def main():
    """Main entry point."""
    api_key = os.environ.get("GOOGLE_API_KEY")

    if not api_key:
        print("WARNING: GOOGLE_API_KEY not set")
        print("Street View imagery will be skipped.")
        print("Set it with: export GOOGLE_API_KEY='your_key_here'")
        print()
        print("Continuing with aerial imagery only...")
        print()

    process_all_chunks(api_key, skip_existing=True)
    print("Done!")


if __name__ == "__main__":
    main()
