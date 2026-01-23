#!/usr/bin/env python3
"""
60_generate_meshes.py - Mesh Generation

Generates 3D meshes for terrain and buildings.

Input:
    - data/interim/dtm_clip.tif
    - data/processed/buildings_height.geojson

Output:
    - data/processed/terrain/ (chunked terrain GLB files)
    - data/processed/buildings/ (chunked building GLB files)

Usage:
    python 60_generate_meshes.py
"""

import json
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from shapely.geometry import shape
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


def generate_terrain_mesh(dtm_path: Path, chunk_size: float, origin: tuple[float, float], simplify: int = 4) -> dict:
    """
    Generate chunked terrain meshes from DTM.

    Args:
        dtm_path: Path to DTM GeoTIFF
        chunk_size: Size of each chunk in metres
        origin: Local origin (x, y) for coordinate translation
        simplify: Downsample factor (1=full res, 4=every 4th pixel)

    Returns:
        Dictionary of {chunk_key: trimesh.Trimesh}
    """
    print(f"Reading DTM from {dtm_path}...")
    with rasterio.open(dtm_path) as src:
        dtm = src.read(1)
        transform = src.transform
        bounds = src.bounds
        nodata = src.nodata

    print(f"  Shape: {dtm.shape}, Bounds: {bounds}")

    # Replace nodata with 0 (sea level)
    if nodata is not None:
        dtm = np.where(dtm == nodata, 0, dtm)
    dtm = np.nan_to_num(dtm, nan=0)

    origin_x, origin_y = origin
    minx, miny, maxx, maxy = bounds

    # Downsample for performance
    dtm_small = dtm[::simplify, ::simplify]
    step = simplify  # metres per pixel after downsampling

    print(f"  Downsampled to {dtm_small.shape} (factor {simplify})")

    chunks = {}

    # Calculate chunk boundaries
    chunk_cols = int(np.ceil((maxx - minx) / chunk_size))
    chunk_rows = int(np.ceil((maxy - miny) / chunk_size))

    print(f"  Generating {chunk_cols}x{chunk_rows} chunks...")

    for ci in range(chunk_cols):
        for cj in range(chunk_rows):
            # Chunk bounds in world coordinates
            cx_min = minx + ci * chunk_size
            cy_min = miny + cj * chunk_size
            cx_max = min(cx_min + chunk_size, maxx)
            cy_max = min(cy_min + chunk_size, maxy)

            # Pixel indices (accounting for downsampling)
            px_min = int((cx_min - minx) / step)
            px_max = int((cx_max - minx) / step)
            py_min = int((maxy - cy_max) / step)  # Raster is top-down
            py_max = int((maxy - cy_min) / step)

            # Clamp to array bounds
            px_min = max(0, px_min)
            px_max = min(dtm_small.shape[1], px_max)
            py_min = max(0, py_min)
            py_max = min(dtm_small.shape[0], py_max)

            if px_max <= px_min or py_max <= py_min:
                continue

            # Extract chunk elevation data
            chunk_data = dtm_small[py_min:py_max, px_min:px_max]

            if chunk_data.size == 0:
                continue

            rows, cols = chunk_data.shape

            # Create vertex grid
            x = np.linspace(cx_min - origin_x, cx_max - origin_x, cols)
            y = np.linspace(cy_max - origin_y, cy_min - origin_y, rows)  # Flip Y
            xx, yy = np.meshgrid(x, y)

            # Flatten for vertices
            vertices = np.column_stack([
                xx.flatten(),
                yy.flatten(),
                chunk_data.flatten()
            ])

            # Create faces (two triangles per grid cell)
            faces = []
            for i in range(rows - 1):
                for j in range(cols - 1):
                    idx = i * cols + j
                    # Triangle 1
                    faces.append([idx, idx + cols, idx + 1])
                    # Triangle 2
                    faces.append([idx + 1, idx + cols, idx + cols + 1])

            if len(faces) == 0:
                continue

            faces = np.array(faces)

            # Create mesh
            mesh = trimesh.Trimesh(vertices=vertices, faces=faces)

            chunk_key = f"{ci}_{cj}"
            chunks[chunk_key] = mesh

    print(f"  Generated {len(chunks)} terrain chunks")
    return chunks


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


def extrude_building(geometry_wgs84: dict, height: float, ground_z: float,
                     origin: tuple[float, float]) -> trimesh.Trimesh | None:
    """
    Extrude a building footprint to a 3D prism.

    Args:
        geometry_wgs84: GeoJSON geometry in WGS84
        height: Building height in metres
        ground_z: Ground elevation at building location
        origin: Local origin for coordinate translation
    """
    try:
        # Transform geometry from WGS84 to BNG
        if geometry_wgs84['type'] != 'Polygon':
            return None

        coords_wgs84 = geometry_wgs84['coordinates'][0]
        coords_bng = [WGS84_TO_BNG.transform(c[0], c[1]) for c in coords_wgs84]

        # Translate to local origin
        origin_x, origin_y = origin
        local_coords = [(x - origin_x, y - origin_y) for x, y in coords_bng]

        # Create 2D polygon for extrusion
        polygon_2d = np.array(local_coords[:-1])  # Remove closing point

        if len(polygon_2d) < 3:
            return None

        # Use trimesh to create extruded polygon
        # First create a Path2D, then extrude
        from shapely.geometry import Polygon as ShapelyPolygon
        poly = ShapelyPolygon(polygon_2d)

        if not poly.is_valid:
            poly = poly.buffer(0)

        if poly.is_empty or poly.area < 1:  # Skip tiny buildings
            return None

        # Extrude polygon
        mesh = trimesh.creation.extrude_polygon(poly, height)

        # Translate Z to ground elevation
        mesh.vertices[:, 2] += ground_z

        return mesh
    except Exception as e:
        return None


def generate_building_meshes(buildings_path: Path, dtm_path: Path,
                            origin: tuple[float, float], chunk_size: float) -> dict:
    """Generate building meshes, organized by chunk."""
    print(f"Loading buildings from {buildings_path}...")
    with open(buildings_path) as f:
        buildings = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    print(f"Processing {len(buildings['features'])} buildings...")

    meshes_by_chunk = {}
    success = 0
    failed = 0
    origin_x, origin_y = origin

    for i, feature in enumerate(buildings["features"]):
        geom = feature.get("geometry")
        height = feature["properties"].get("height", 6.0)

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

        # Create mesh
        mesh = extrude_building(geom, height, ground_z, origin)

        if mesh is not None and len(mesh.vertices) > 0:
            # Determine chunk based on centroid
            chunk_x = int((center_x - origin_x) // chunk_size)
            chunk_y = int((center_y - origin_y) // chunk_size)
            chunk_key = f"{chunk_x}_{chunk_y}"

            if chunk_key not in meshes_by_chunk:
                meshes_by_chunk[chunk_key] = []
            meshes_by_chunk[chunk_key].append(mesh)
            success += 1
        else:
            failed += 1

        if (i + 1) % 2000 == 0:
            print(f"  Processed {i + 1}/{len(buildings['features'])} buildings")

    dtm_src.close()
    print(f"  Success: {success}, Failed: {failed}")
    return meshes_by_chunk


def save_meshes(meshes_by_chunk: dict, output_dir: Path, prefix: str) -> dict:
    """Save chunked meshes as GLB files. Returns stats."""
    output_dir.mkdir(parents=True, exist_ok=True)

    stats = {"files": 0, "vertices": 0, "faces": 0}

    for chunk_key, meshes in meshes_by_chunk.items():
        if not meshes:
            continue

        # Combine meshes in chunk
        if isinstance(meshes, list):
            combined = trimesh.util.concatenate(meshes)
        else:
            combined = meshes

        # Save as GLB
        output_file = output_dir / f"{prefix}_{chunk_key}.glb"
        combined.export(output_file, file_type="glb")

        stats["files"] += 1
        stats["vertices"] += len(combined.vertices)
        stats["faces"] += len(combined.faces)

        print(f"  {output_file.name}: {len(combined.vertices):,} verts, {len(combined.faces):,} faces")

    return stats


def main():
    """Generate meshes."""
    settings = load_settings()
    chunk_size = settings["terrain"]["chunk_size_m"]

    print("Loading AOI centre...")
    origin = load_aoi_centre()
    print(f"Origin (BNG): {origin}")

    dtm_path = INTERIM_DIR / "dtm_clip.tif"
    buildings_path = PROCESSED_DIR / "buildings_height.geojson"

    terrain_dir = PROCESSED_DIR / "terrain"
    buildings_dir = PROCESSED_DIR / "buildings"

    total_stats = {"terrain": {}, "buildings": {}}

    # Generate terrain meshes
    if dtm_path.exists():
        print("\n" + "="*50)
        print("TERRAIN MESHES")
        print("="*50)
        terrain_chunks = generate_terrain_mesh(dtm_path, chunk_size, origin, simplify=4)
        stats = save_meshes(terrain_chunks, terrain_dir, "terrain")
        total_stats["terrain"] = stats
    else:
        print(f"DTM not found: {dtm_path}")

    # Generate building meshes
    if buildings_path.exists():
        print("\n" + "="*50)
        print("BUILDING MESHES")
        print("="*50)
        building_chunks = generate_building_meshes(buildings_path, dtm_path, origin, chunk_size)
        stats = save_meshes(building_chunks, buildings_dir, "buildings")
        total_stats["buildings"] = stats
    else:
        print(f"Buildings not found: {buildings_path}")

    # Summary
    print("\n" + "="*50)
    print("SUMMARY")
    print("="*50)
    for mesh_type, stats in total_stats.items():
        if stats:
            print(f"{mesh_type.capitalize()}:")
            print(f"  Files: {stats['files']}")
            print(f"  Vertices: {stats['vertices']:,}")
            print(f"  Faces: {stats['faces']:,}")

    print("\nDone!")


if __name__ == "__main__":
    main()
