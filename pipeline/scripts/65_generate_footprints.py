#!/usr/bin/env python3
"""
65_generate_footprints.py - Generate Building Footprints for Selection

Generates flat footprint meshes with per-building identity for raycasting.

Input:
    - data/processed/buildings_height.geojson
    - data/interim/dtm_clip.tif

Output:
    - data/processed/footprints/ (chunked footprint GLB files)
    - data/processed/footprints_metadata.json

Usage:
    python 65_generate_footprints.py
"""

import json
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from shapely.geometry import Polygon as ShapelyPolygon
import trimesh
import yaml

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"

# Coordinate transformer
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

# Properties to extract from OSM data
METADATA_PROPERTIES = [
    "name",
    "building",
    "amenity",
    "shop",
    "addr:housename",
    "addr:housenumber",
    "addr:street",
    "addr:postcode",
    "addr:city",
    "height",
    "height_source",
]


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    with open(CONFIG_DIR / "settings.yaml") as f:
        return yaml.safe_load(f)


def load_aoi_centre() -> tuple[float, float]:
    """Load AOI centre for local origin."""
    with open(CONFIG_DIR / "aoi.geojson") as f:
        aoi = json.load(f)
    centre = aoi["features"][0]["properties"]["centre_bng"]
    return tuple(centre)


def get_ground_elevation(x: float, y: float, dtm_src) -> float:
    """Get ground elevation at a point from DTM."""
    try:
        row, col = dtm_src.index(x, y)
        if 0 <= row < dtm_src.height and 0 <= col < dtm_src.width:
            val = dtm_src.read(1, window=((row, row+1), (col, col+1)))[0, 0]
            if val != dtm_src.nodata and not np.isnan(val):
                return float(val)
    except Exception:
        pass
    return 0.0


def extract_metadata(properties: dict) -> dict:
    """Extract relevant metadata from building properties."""
    metadata = {}
    for prop in METADATA_PROPERTIES:
        if prop in properties and properties[prop] is not None:
            # Convert property name to safe key (replace : with _)
            key = prop.replace(":", "_")
            metadata[key] = properties[prop]
    return metadata


def create_footprint_mesh(geometry_wgs84: dict, ground_z: float,
                          origin: tuple[float, float], z_offset: float = 0.5) -> tuple[trimesh.Trimesh | None, int]:
    """
    Create a flat footprint polygon at ground level.

    Args:
        geometry_wgs84: GeoJSON geometry in WGS84
        ground_z: Ground elevation at building location
        origin: Local origin for coordinate translation
        z_offset: Height above ground to avoid z-fighting

    Returns:
        Tuple of (mesh, face_count) or (None, 0) on failure
    """
    try:
        if geometry_wgs84['type'] != 'Polygon':
            return None, 0

        coords_wgs84 = geometry_wgs84['coordinates'][0]
        coords_bng = [WGS84_TO_BNG.transform(c[0], c[1]) for c in coords_wgs84]

        # Translate to local origin
        origin_x, origin_y = origin
        local_coords = [(x - origin_x, y - origin_y) for x, y in coords_bng]

        # Create 2D polygon
        polygon_2d = local_coords[:-1]  # Remove closing point

        if len(polygon_2d) < 3:
            return None, 0

        poly = ShapelyPolygon(polygon_2d)

        if not poly.is_valid:
            poly = poly.buffer(0)

        if poly.is_empty or poly.area < 1:  # Skip tiny buildings
            return None, 0

        # Create flat mesh using thin extrusion
        mesh = trimesh.creation.extrude_polygon(poly, 0.01)

        # Flatten to ground_z + offset
        mesh.vertices[:, 2] = ground_z + z_offset

        return mesh, len(mesh.faces)
    except Exception:
        return None, 0


def generate_footprints(buildings_path: Path, dtm_path: Path,
                        origin: tuple[float, float], chunk_size: float) -> tuple[dict, dict]:
    """
    Generate footprint meshes and metadata, organized by chunk.

    Returns:
        Tuple of (meshes_by_chunk, metadata)
    """
    print(f"Loading buildings from {buildings_path}...")
    with open(buildings_path) as f:
        buildings = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    print(f"Processing {len(buildings['features'])} buildings...")

    meshes_by_chunk = {}  # chunk_key -> list of (mesh, building_id)
    face_maps_by_chunk = {}  # chunk_key -> list of {building_id, start_face, end_face}
    building_metadata = {}  # building_id -> properties

    origin_x, origin_y = origin
    success = 0
    failed = 0

    for building_id, feature in enumerate(buildings["features"]):
        geom = feature.get("geometry")
        props = feature.get("properties", {})

        if geom is None or geom['type'] != 'Polygon':
            failed += 1
            continue

        # Get building centroid in BNG for ground elevation
        coords_wgs84 = geom['coordinates'][0]
        center_lon = sum(c[0] for c in coords_wgs84) / len(coords_wgs84)
        center_lat = sum(c[1] for c in coords_wgs84) / len(coords_wgs84)
        center_x, center_y = WGS84_TO_BNG.transform(center_lon, center_lat)

        # Get ground elevation
        ground_z = get_ground_elevation(center_x, center_y, dtm_src)

        # Create footprint mesh
        mesh, face_count = create_footprint_mesh(geom, ground_z, origin)

        if mesh is not None and face_count > 0:
            # Determine chunk based on centroid
            chunk_x = int((center_x - origin_x) // chunk_size)
            chunk_y = int((center_y - origin_y) // chunk_size)
            chunk_key = f"{chunk_x}_{chunk_y}"

            if chunk_key not in meshes_by_chunk:
                meshes_by_chunk[chunk_key] = []
                face_maps_by_chunk[chunk_key] = []

            meshes_by_chunk[chunk_key].append((mesh, building_id))

            # Extract and store metadata
            metadata = extract_metadata(props)
            if metadata:
                building_metadata[str(building_id)] = metadata

            success += 1
        else:
            failed += 1

        if (building_id + 1) % 2000 == 0:
            print(f"  Processed {building_id + 1}/{len(buildings['features'])} buildings")

    dtm_src.close()

    # Build face maps for each chunk
    print("Building face maps...")
    for chunk_key, mesh_list in meshes_by_chunk.items():
        current_face = 0
        for mesh, building_id in mesh_list:
            face_count = len(mesh.faces)
            face_maps_by_chunk[chunk_key].append({
                "building_id": building_id,
                "start_face": current_face,
                "end_face": current_face + face_count
            })
            current_face += face_count

    # Convert mesh lists to just meshes (drop building_id)
    for chunk_key in meshes_by_chunk:
        meshes_by_chunk[chunk_key] = [m for m, _ in meshes_by_chunk[chunk_key]]

    print(f"  Success: {success}, Failed: {failed}")

    # Assemble metadata structure
    metadata = {
        "chunks": {k: {"face_map": v} for k, v in face_maps_by_chunk.items()},
        "buildings": building_metadata
    }

    return meshes_by_chunk, metadata


def save_footprint_meshes(meshes_by_chunk: dict, output_dir: Path) -> dict:
    """Save chunked footprint meshes as GLB files."""
    output_dir.mkdir(parents=True, exist_ok=True)

    stats = {"files": 0, "vertices": 0, "faces": 0}

    for chunk_key, meshes in meshes_by_chunk.items():
        if not meshes:
            continue

        # Combine meshes in chunk
        combined = trimesh.util.concatenate(meshes)

        # Save as GLB
        output_file = output_dir / f"footprints_{chunk_key}.glb"
        combined.export(output_file, file_type="glb")

        stats["files"] += 1
        stats["vertices"] += len(combined.vertices)
        stats["faces"] += len(combined.faces)

        print(f"  {output_file.name}: {len(combined.vertices):,} verts, {len(combined.faces):,} faces")

    return stats


def main():
    """Generate footprint meshes and metadata."""
    settings = load_settings()
    chunk_size = settings["terrain"]["chunk_size_m"]

    print("Loading AOI centre...")
    origin = load_aoi_centre()
    print(f"Origin (BNG): {origin}")

    # Input paths
    dtm_path = INTERIM_DIR / "dtm_clip.tif"
    buildings_path = PROCESSED_DIR / "buildings_height.geojson"

    # Output paths
    footprints_dir = PROCESSED_DIR / "footprints"
    metadata_path = PROCESSED_DIR / "footprints_metadata.json"

    if not buildings_path.exists():
        print(f"Buildings not found: {buildings_path}")
        return

    if not dtm_path.exists():
        print(f"DTM not found: {dtm_path}")
        return

    print("\n" + "="*50)
    print("FOOTPRINT MESHES")
    print("="*50)

    # Generate footprints and metadata
    meshes_by_chunk, metadata = generate_footprints(
        buildings_path, dtm_path, origin, chunk_size
    )

    # Save meshes
    print("\nSaving footprint meshes...")
    stats = save_footprint_meshes(meshes_by_chunk, footprints_dir)

    # Save metadata
    print(f"\nSaving metadata to {metadata_path}...")
    with open(metadata_path, "w") as f:
        json.dump(metadata, f)

    # Summary
    print("\n" + "="*50)
    print("SUMMARY")
    print("="*50)
    print(f"Footprint chunks: {stats['files']}")
    print(f"Total vertices: {stats['vertices']:,}")
    print(f"Total faces: {stats['faces']:,}")
    print(f"Buildings with metadata: {len(metadata['buildings'])}")

    print("\nDone!")


if __name__ == "__main__":
    main()
