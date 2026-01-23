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


def get_road_width(highway_type: str, settings: dict) -> float:
    """Get road width based on highway type."""
    road_settings = settings.get("roads", {})
    width_map = {
        "primary": road_settings.get("width_primary_m", 8.0),
        "primary_link": road_settings.get("width_primary_m", 8.0),
        "secondary": road_settings.get("width_secondary_m", 7.0),
        "secondary_link": road_settings.get("width_secondary_m", 7.0),
        "tertiary": road_settings.get("width_tertiary_m", 6.0),
        "tertiary_link": road_settings.get("width_tertiary_m", 6.0),
        "residential": road_settings.get("width_residential_m", 5.0),
        "unclassified": road_settings.get("width_residential_m", 5.0),
        "service": road_settings.get("width_service_m", 4.0),
        "footway": road_settings.get("width_footway_m", 2.0),
        "path": road_settings.get("width_footway_m", 2.0),
        "cycleway": road_settings.get("width_cycleway_m", 2.5),
        "track": road_settings.get("width_service_m", 4.0),
        "pedestrian": road_settings.get("width_footway_m", 2.0),
        "steps": road_settings.get("width_footway_m", 1.5),
        "trunk": road_settings.get("width_primary_m", 8.0),
        "trunk_link": road_settings.get("width_primary_m", 8.0),
    }
    return width_map.get(highway_type, road_settings.get("width_default_m", 4.0))


def create_ribbon_mesh(coords: list[tuple], elevations: list[float],
                       width: float, z_offset: float = 0.1) -> trimesh.Trimesh | None:
    """
    Create a ribbon mesh along a path.

    Args:
        coords: List of (x, y) local coordinates
        elevations: Ground elevation at each point
        width: Road width in metres
        z_offset: Height above ground to avoid z-fighting
    """
    if len(coords) < 2:
        return None

    vertices = []
    faces = []
    half_width = width / 2

    for i in range(len(coords) - 1):
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        z1 = elevations[i] + z_offset
        z2 = elevations[i + 1] + z_offset

        # Direction vector
        dx = x2 - x1
        dy = y2 - y1
        length = np.sqrt(dx**2 + dy**2)

        if length < 0.01:
            continue

        # Perpendicular vector (rotated 90°)
        px = -dy / length * half_width
        py = dx / length * half_width

        # 4 vertices per segment (quad)
        v_idx = len(vertices)
        vertices.extend([
            [x1 - px, y1 - py, z1],
            [x1 + px, y1 + py, z1],
            [x2 + px, y2 + py, z2],
            [x2 - px, y2 - py, z2],
        ])

        # Two triangles per quad
        faces.append([v_idx, v_idx + 1, v_idx + 2])
        faces.append([v_idx, v_idx + 2, v_idx + 3])

    if len(vertices) == 0:
        return None

    return trimesh.Trimesh(vertices=np.array(vertices), faces=np.array(faces))


def generate_road_meshes(roads_path: Path, dtm_path: Path, origin: tuple[float, float],
                         chunk_size: float, settings: dict) -> dict:
    """Generate road ribbon meshes, organized by chunk."""
    print(f"Loading roads from {roads_path}...")
    with open(roads_path) as f:
        roads = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    print(f"Processing {len(roads['features'])} roads...")

    meshes_by_chunk = {}
    success = 0
    failed = 0
    origin_x, origin_y = origin
    z_offset = settings.get("roads", {}).get("elevation_offset_m", 0.1)

    for i, feature in enumerate(roads["features"]):
        geom = feature.get("geometry")
        props = feature.get("properties", {})
        highway_type = props.get("highway", "unclassified")

        if geom is None or geom["type"] != "LineString":
            failed += 1
            continue

        coords_wgs84 = geom["coordinates"]
        if len(coords_wgs84) < 2:
            failed += 1
            continue

        # Transform to local coordinates and get elevations
        local_coords = []
        elevations = []

        for lon, lat in coords_wgs84:
            x, y = WGS84_TO_BNG.transform(lon, lat)
            local_x = x - origin_x
            local_y = y - origin_y
            local_coords.append((local_x, local_y))
            elevations.append(get_ground_elevation(x, y, dtm_src))

        # Get road width
        width = get_road_width(highway_type, settings)

        # Create mesh
        mesh = create_ribbon_mesh(local_coords, elevations, width, z_offset)

        if mesh is not None and len(mesh.vertices) > 0:
            # Determine chunk based on road midpoint
            mid_idx = len(local_coords) // 2
            mid_x, mid_y = local_coords[mid_idx]
            chunk_x = int(mid_x // chunk_size)
            chunk_y = int(mid_y // chunk_size)
            chunk_key = f"{chunk_x}_{chunk_y}"

            if chunk_key not in meshes_by_chunk:
                meshes_by_chunk[chunk_key] = []
            meshes_by_chunk[chunk_key].append(mesh)
            success += 1
        else:
            failed += 1

        if (i + 1) % 1000 == 0:
            print(f"  Processed {i + 1}/{len(roads['features'])} roads")

    dtm_src.close()
    print(f"  Success: {success}, Failed: {failed}")
    return meshes_by_chunk


def generate_railway_meshes(railways_path: Path, dtm_path: Path, origin: tuple[float, float],
                            chunk_size: float, settings: dict) -> dict:
    """Generate railway ribbon meshes, organized by chunk."""
    print(f"Loading railways from {railways_path}...")
    with open(railways_path) as f:
        railways = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    print(f"Processing {len(railways['features'])} railways...")

    meshes_by_chunk = {}
    success = 0
    failed = 0
    origin_x, origin_y = origin
    railway_settings = settings.get("railways", {})
    width = railway_settings.get("width_m", 3.5)
    z_offset = railway_settings.get("elevation_offset_m", 0.8)

    for i, feature in enumerate(railways["features"]):
        geom = feature.get("geometry")

        if geom is None or geom["type"] != "LineString":
            failed += 1
            continue

        coords_wgs84 = geom["coordinates"]
        if len(coords_wgs84) < 2:
            failed += 1
            continue

        # Transform to local coordinates and get elevations
        local_coords = []
        elevations = []

        for lon, lat in coords_wgs84:
            x, y = WGS84_TO_BNG.transform(lon, lat)
            local_x = x - origin_x
            local_y = y - origin_y
            local_coords.append((local_x, local_y))
            elevations.append(get_ground_elevation(x, y, dtm_src))

        # Create mesh
        mesh = create_ribbon_mesh(local_coords, elevations, width, z_offset)

        if mesh is not None and len(mesh.vertices) > 0:
            # Determine chunk based on midpoint
            mid_idx = len(local_coords) // 2
            mid_x, mid_y = local_coords[mid_idx]
            chunk_x = int(mid_x // chunk_size)
            chunk_y = int(mid_y // chunk_size)
            chunk_key = f"{chunk_x}_{chunk_y}"

            if chunk_key not in meshes_by_chunk:
                meshes_by_chunk[chunk_key] = []
            meshes_by_chunk[chunk_key].append(mesh)
            success += 1
        else:
            failed += 1

    dtm_src.close()
    print(f"  Success: {success}, Failed: {failed}")
    return meshes_by_chunk


def create_polygon_mesh(coords: list[tuple], z: float = 0.0) -> trimesh.Trimesh | None:
    """Create a flat polygon mesh from coordinates."""
    from shapely.geometry import Polygon as ShapelyPolygon

    if len(coords) < 3:
        return None

    try:
        poly = ShapelyPolygon(coords)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.area < 1:
            return None

        # Create flat mesh at z height
        mesh = trimesh.creation.extrude_polygon(poly, 0.01)  # Very thin extrusion
        mesh.vertices[:, 2] = z  # Flatten to z height

        return mesh
    except Exception:
        return None


def generate_water_meshes(water_path: Path, dtm_path: Path, origin: tuple[float, float],
                          chunk_size: float, aoi_bounds: tuple, settings: dict) -> dict:
    """Generate water body meshes, organized by chunk and clipped to AOI."""
    from shapely.geometry import Polygon as ShapelyPolygon, box
    from shapely.ops import unary_union

    print(f"Loading water from {water_path}...")
    with open(water_path) as f:
        water = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    # Create AOI clip box in local coordinates
    min_x, min_y, max_x, max_y = aoi_bounds
    aoi_box = box(min_x, min_y, max_x, max_y)

    print(f"Processing {len(water['features'])} water features (clipping to AOI)...")

    meshes_by_chunk = {}
    success = 0
    failed = 0
    clipped = 0
    origin_x, origin_y = origin
    z_offset = settings.get("water", {}).get("elevation_offset_m", 0.3)

    for i, feature in enumerate(water["features"]):
        geom = feature.get("geometry")

        if geom is None:
            failed += 1
            continue

        # Handle both Polygon and MultiPolygon
        if geom["type"] == "Polygon":
            polygons = [geom["coordinates"]]
        elif geom["type"] == "MultiPolygon":
            polygons = geom["coordinates"]
        else:
            failed += 1
            continue

        for poly_coords in polygons:
            coords_wgs84 = poly_coords[0]  # Exterior ring

            # Transform to local coordinates
            local_coords = []
            bng_coords = []
            for lon, lat in coords_wgs84:
                x, y = WGS84_TO_BNG.transform(lon, lat)
                local_coords.append((x - origin_x, y - origin_y))
                bng_coords.append((x, y))

            # Create shapely polygon and clip to AOI
            try:
                water_poly = ShapelyPolygon(local_coords)
                if not water_poly.is_valid:
                    water_poly = water_poly.buffer(0)

                clipped_poly = water_poly.intersection(aoi_box)

                if clipped_poly.is_empty or clipped_poly.area < 1:
                    failed += 1
                    continue

                # Track if we clipped
                if clipped_poly.area < water_poly.area * 0.99:
                    clipped += 1

                # Get coordinates from clipped polygon
                if clipped_poly.geom_type == 'Polygon':
                    local_coords = list(clipped_poly.exterior.coords)
                elif clipped_poly.geom_type == 'MultiPolygon':
                    # Take largest polygon
                    largest = max(clipped_poly.geoms, key=lambda p: p.area)
                    local_coords = list(largest.exterior.coords)
                else:
                    failed += 1
                    continue
            except Exception:
                failed += 1
                continue

            # Get ground elevation at polygon centroid
            cx = sum(c[0] for c in bng_coords) / len(bng_coords)
            cy = sum(c[1] for c in bng_coords) / len(bng_coords)
            ground_z = get_ground_elevation(cx, cy, dtm_src)
            water_z = ground_z + z_offset

            # Create mesh at terrain-relative height
            mesh = create_polygon_mesh(local_coords, water_z)

            if mesh is not None and len(mesh.vertices) > 0:
                # Determine chunk based on centroid
                xs = [c[0] for c in local_coords]
                ys = [c[1] for c in local_coords]
                center_x = sum(xs) / len(xs)
                center_y = sum(ys) / len(ys)
                chunk_x = int(center_x // chunk_size)
                chunk_y = int(center_y // chunk_size)
                chunk_key = f"{chunk_x}_{chunk_y}"

                if chunk_key not in meshes_by_chunk:
                    meshes_by_chunk[chunk_key] = []
                meshes_by_chunk[chunk_key].append(mesh)
                success += 1
            else:
                failed += 1

    dtm_src.close()
    print(f"  Success: {success}, Failed: {failed}, Clipped: {clipped}")
    return meshes_by_chunk


def generate_sea_mesh(coast_path: Path, origin: tuple[float, float],
                      aoi_bounds: tuple, settings: dict) -> dict:
    """
    Generate sea mesh east of coastline, properly clipped to AOI.

    Args:
        coast_path: Path to coastline GeoJSON
        origin: Local origin (x, y)
        aoi_bounds: (min_x, min_y, max_x, max_y) in local coordinates
        settings: Configuration settings
    """
    from shapely.geometry import LineString, Polygon as ShapelyPolygon, box
    from shapely.ops import linemerge

    print(f"Loading coastline from {coast_path}...")
    with open(coast_path) as f:
        coast = json.load(f)

    origin_x, origin_y = origin
    sea_z = settings.get("sea", {}).get("elevation_m", 0.0)
    min_x, min_y, max_x, max_y = aoi_bounds

    # 1. Filter: only mainland coastline (exclude islands/islets)
    coastline_segments = []
    skipped_islands = 0
    for feature in coast["features"]:
        props = feature.get("properties", {})
        # Skip islands and islets
        if props.get("place") in ["island", "islet"]:
            skipped_islands += 1
            continue

        geom = feature.get("geometry")
        if geom is None or geom["type"] != "LineString":
            continue

        coords = geom["coordinates"]
        local_coords = []
        for lon, lat in coords:
            x, y = WGS84_TO_BNG.transform(lon, lat)
            local_coords.append((x - origin_x, y - origin_y))

        if len(local_coords) >= 2:
            coastline_segments.append(LineString(local_coords))

    if not coastline_segments:
        print("  No coastline segments found")
        return {}

    print(f"  Found {len(coastline_segments)} coastline segments (skipped {skipped_islands} islands)")

    # 2. Merge coastline segments to preserve connectivity
    merged = linemerge(coastline_segments)
    if merged.geom_type == 'MultiLineString':
        # Take longest segment if merge didn't fully connect
        merged = max(merged.geoms, key=lambda g: g.length)
        print(f"  Warning: Coastline has gaps, using longest segment")

    coast_coords = list(merged.coords)
    print(f"  Merged coastline: {len(coast_coords)} points")

    # 3. Build sea polygon: coastline + eastern boundary + close
    sea_coords = list(coast_coords)
    # Add eastern corners (extend to AOI east boundary)
    sea_coords.append((max_x, coast_coords[-1][1]))
    sea_coords.append((max_x, coast_coords[0][1]))
    # Close polygon
    sea_coords.append(coast_coords[0])

    try:
        sea_poly = ShapelyPolygon(sea_coords)
        if not sea_poly.is_valid:
            sea_poly = sea_poly.buffer(0)

        # 4. Clip to AOI
        aoi_box = box(min_x, min_y, max_x, max_y)
        clipped = sea_poly.intersection(aoi_box)

        if clipped.is_empty or clipped.area < 1:
            print("  Sea polygon empty after clipping")
            return {}

        # Handle MultiPolygon (take largest)
        if clipped.geom_type == 'MultiPolygon':
            clipped = max(clipped.geoms, key=lambda p: p.area)

        # 5. Create mesh using trimesh's proper triangulation
        mesh = trimesh.creation.extrude_polygon(clipped, 0.01)
        mesh.vertices[:, 2] = sea_z  # Flatten to sea level

        print(f"  Created sea mesh: {len(mesh.vertices)} verts, {len(mesh.faces)} faces")
        return {"0_0": mesh}

    except Exception as e:
        print(f"  Error creating sea mesh: {e}")
        return {}


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

    # Input paths
    dtm_path = INTERIM_DIR / "dtm_clip.tif"
    buildings_path = PROCESSED_DIR / "buildings_height.geojson"
    roads_path = DATA_DIR / "raw" / "osm" / "roads.geojson"
    railways_path = DATA_DIR / "raw" / "osm" / "railways.geojson"
    water_path = DATA_DIR / "raw" / "osm" / "water.geojson"
    coast_path = DATA_DIR / "raw" / "osm" / "coast.geojson"

    # Output directories
    terrain_dir = PROCESSED_DIR / "terrain"
    buildings_dir = PROCESSED_DIR / "buildings"
    roads_dir = PROCESSED_DIR / "roads"
    railways_dir = PROCESSED_DIR / "railways"
    water_dir = PROCESSED_DIR / "water"
    sea_dir = PROCESSED_DIR / "sea"

    total_stats = {"terrain": {}, "buildings": {}, "roads": {}, "railways": {}, "water": {}, "sea": {}}

    # Calculate AOI bounds for sea mesh
    aoi_side = settings["aoi"]["side_length_m"]
    aoi_bounds = (-aoi_side / 2, -aoi_side / 2, aoi_side / 2, aoi_side / 2)

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

    # Generate road meshes
    if roads_path.exists() and dtm_path.exists():
        print("\n" + "="*50)
        print("ROAD MESHES")
        print("="*50)
        road_chunks = generate_road_meshes(roads_path, dtm_path, origin, chunk_size, settings)
        stats = save_meshes(road_chunks, roads_dir, "roads")
        total_stats["roads"] = stats
    else:
        print(f"Roads or DTM not found")

    # Generate railway meshes
    if railways_path.exists() and dtm_path.exists():
        print("\n" + "="*50)
        print("RAILWAY MESHES")
        print("="*50)
        railway_chunks = generate_railway_meshes(railways_path, dtm_path, origin, chunk_size, settings)
        stats = save_meshes(railway_chunks, railways_dir, "railways")
        total_stats["railways"] = stats
    else:
        print(f"Railways not found: {railways_path}")

    # Generate water meshes
    if water_path.exists() and dtm_path.exists():
        print("\n" + "="*50)
        print("WATER MESHES")
        print("="*50)
        water_chunks = generate_water_meshes(water_path, dtm_path, origin, chunk_size, aoi_bounds, settings)
        stats = save_meshes(water_chunks, water_dir, "water")
        total_stats["water"] = stats
    else:
        print(f"Water or DTM not found")

    # Generate sea mesh
    if coast_path.exists():
        print("\n" + "="*50)
        print("SEA MESH")
        print("="*50)
        sea_chunks = generate_sea_mesh(coast_path, origin, aoi_bounds, settings)
        stats = save_meshes(sea_chunks, sea_dir, "sea")
        total_stats["sea"] = stats
    else:
        print(f"Coastline not found: {coast_path}")

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
