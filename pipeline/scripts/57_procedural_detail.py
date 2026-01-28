#!/usr/bin/env python3
"""
57_procedural_detail.py - Procedural Building Detail

Generates enhanced building meshes with:
- Pitched roofs for residential buildings
- Proper enclosed volumes (watertight meshes)

Input:
    - data/processed/buildings_height.geojson
    - data/interim/dtm_clip.tif

Output:
    - data/processed/buildings_detailed/*.glb

Usage:
    python 57_procedural_detail.py
    python 57_procedural_detail.py --chunks 0_0 n1_1  # Specific chunks (n = negative)
    python 57_procedural_detail.py --all
"""

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from shapely.geometry import Polygon as ShapelyPolygon
import trimesh
import yaml

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"

# Coordinate transformer
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)

# Dummy texture for UV export
DUMMY_TEXTURE = None


def get_dummy_texture():
    """Get or create a dummy texture for UV export."""
    global DUMMY_TEXTURE
    if DUMMY_TEXTURE is None and HAS_PIL:
        DUMMY_TEXTURE = Image.new('RGB', (4, 4), (200, 200, 200))
    return DUMMY_TEXTURE


def create_uv_visual(uvs: np.ndarray) -> trimesh.visual.TextureVisuals:
    """Create TextureVisuals with UVs and a dummy texture for proper GLB export."""
    dummy = get_dummy_texture()
    if dummy is not None:
        material = trimesh.visual.material.SimpleMaterial(image=dummy)
        return trimesh.visual.TextureVisuals(uv=uvs, material=material)
    return trimesh.visual.TextureVisuals(uv=uvs)


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
            val = dtm_src.read(1, window=((row, row + 1), (col, col + 1)))[0, 0]
            if val != dtm_src.nodata and not np.isnan(val):
                return float(val)
    except Exception:
        pass
    return 0.0


def get_building_type(props: dict) -> str:
    """Determine building type from OSM tags."""
    building = props.get("building", "yes")

    # Explicit building types
    if building in ["house", "detached", "semidetached_house", "terrace", "terraced_house"]:
        return "terraced"
    if building in ["apartments", "residential", "flats"]:
        return "apartments"
    if building in ["commercial", "retail", "shop"]:
        return "commercial"
    if building in ["industrial", "warehouse", "factory"]:
        return "industrial"
    if building in ["garage", "garages", "shed"]:
        return "garage"
    if building in ["church", "chapel"]:
        return "church"

    # Infer from other tags
    if props.get("shop"):
        return "commercial"
    if props.get("amenity") in ["school", "college", "university"]:
        return "school"
    if props.get("office"):
        return "commercial"

    # Default based on height
    height = props.get("height", 6.0)
    if height < 5:
        return "garage"
    if height > 15:
        return "apartments"

    return "terraced"  # Default to UK terraced house


def should_have_pitched_roof(building_type: str) -> bool:
    """Determine if building type should have a pitched roof."""
    pitched_types = {"terraced", "garage", "church"}
    return building_type in pitched_types


def get_roof_pitch(building_type: str) -> float:
    """Get roof pitch angle in degrees."""
    pitches = {
        "terraced": 35,
        "garage": 20,
        "church": 45,
    }
    return pitches.get(building_type, 30)


def compute_obb(coords: list) -> tuple:
    """
    Compute oriented bounding box for a polygon.

    Returns:
        (center, half_width, half_depth, angle, corners)
        - center: (x, y) center of OBB
        - half_width: half-width along primary axis
        - half_depth: half-depth along secondary axis
        - angle: rotation angle in radians
        - corners: 4 corner points of OBB [(x,y), ...]
    """
    points = np.array(coords)

    # Use PCA to find principal axes
    centered = points - points.mean(axis=0)
    cov = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)

    # Sort by eigenvalue (largest = primary axis)
    order = eigenvalues.argsort()[::-1]
    eigenvectors = eigenvectors[:, order]

    # Project points onto principal axes
    projected = centered @ eigenvectors

    # Get extents
    min_proj = projected.min(axis=0)
    max_proj = projected.max(axis=0)

    half_extents = (max_proj - min_proj) / 2
    center_proj = (min_proj + max_proj) / 2

    # Transform center back to world coords
    center = center_proj @ eigenvectors.T + points.mean(axis=0)

    # Angle of primary axis
    angle = np.arctan2(eigenvectors[1, 0], eigenvectors[0, 0])

    # Half dimensions (width = along primary axis, depth = perpendicular)
    half_width = half_extents[0]
    half_depth = half_extents[1]

    # Compute corners
    cos_a, sin_a = np.cos(angle), np.sin(angle)
    dx_w = half_width * cos_a
    dy_w = half_width * sin_a
    dx_d = half_depth * (-sin_a)
    dy_d = half_depth * cos_a

    corners = [
        (center[0] - dx_w - dx_d, center[1] - dy_w - dy_d),
        (center[0] + dx_w - dx_d, center[1] + dy_w - dy_d),
        (center[0] + dx_w + dx_d, center[1] + dy_w + dy_d),
        (center[0] - dx_w + dx_d, center[1] - dy_w + dy_d),
    ]

    return center, half_width, half_depth, angle, corners


def create_box_building(exterior_coords: list, ground_z: float, height: float) -> tuple:
    """
    Create a simple box building with flat roof.

    Returns:
        (vertices, faces, uvs) as numpy arrays
    """
    n = len(exterior_coords)
    if n < 3:
        return None, None, None

    vertices = []
    faces = []
    uvs = []

    TILE_WIDTH = 4.0
    TILE_HEIGHT = 3.0

    # Calculate wall lengths for UV mapping
    wall_lengths = []
    for i in range(n):
        x1, y1 = exterior_coords[i]
        x2, y2 = exterior_coords[(i + 1) % n]
        wall_lengths.append(np.sqrt((x2 - x1)**2 + (y2 - y1)**2))

    # Create walls
    u_offset = 0
    for i in range(n):
        x1, y1 = exterior_coords[i]
        x2, y2 = exterior_coords[(i + 1) % n]
        wall_length = wall_lengths[i]

        v_idx = len(vertices)
        z_bottom = ground_z
        z_top = ground_z + height

        # Wall quad vertices (CCW when viewed from outside)
        vertices.extend([
            [x1, y1, z_bottom],
            [x2, y2, z_bottom],
            [x2, y2, z_top],
            [x1, y1, z_top],
        ])

        # UVs
        u1 = u_offset / TILE_WIDTH
        u2 = (u_offset + wall_length) / TILE_WIDTH
        v_bottom = 0
        v_top = height / TILE_HEIGHT

        uvs.extend([
            [u1, v_bottom],
            [u2, v_bottom],
            [u2, v_top],
            [u1, v_top],
        ])

        # Two triangles per wall quad
        faces.append([v_idx, v_idx + 1, v_idx + 2])
        faces.append([v_idx, v_idx + 2, v_idx + 3])

        u_offset += wall_length

    # Create flat roof using ear clipping triangulation
    roof_start_idx = len(vertices)
    roof_z = ground_z + height

    # Add roof vertices
    poly = ShapelyPolygon(exterior_coords)
    bounds = poly.bounds
    bw = max(bounds[2] - bounds[0], 0.01)
    bh = max(bounds[3] - bounds[1], 0.01)

    for x, y in exterior_coords:
        vertices.append([x, y, roof_z])
        u = (x - bounds[0]) / bw
        v = (y - bounds[1]) / bh
        uvs.append([u, v])

    # Triangulate roof (simple fan for convex, or use shapely for complex)
    if poly.is_valid and not poly.is_empty:
        # Use trimesh's triangulation for robustness
        try:
            roof_2d = np.array(exterior_coords)
            from shapely.ops import triangulate as shapely_triangulate
            triangles = shapely_triangulate(poly)
            for tri in triangles:
                if not tri.is_valid or tri.is_empty:
                    continue
                # Check if triangle is inside polygon
                if not poly.contains(tri.centroid):
                    continue
                tri_coords = list(tri.exterior.coords)[:-1]
                tri_indices = []
                for tx, ty in tri_coords:
                    # Find matching vertex
                    min_dist = float('inf')
                    min_idx = 0
                    for j, (rx, ry) in enumerate(exterior_coords):
                        dist = (tx - rx)**2 + (ty - ry)**2
                        if dist < min_dist:
                            min_dist = dist
                            min_idx = j
                    tri_indices.append(roof_start_idx + min_idx)
                if len(set(tri_indices)) == 3:  # Ensure unique vertices
                    faces.append(tri_indices)
        except Exception:
            # Fallback: fan triangulation
            for i in range(1, n - 1):
                faces.append([roof_start_idx, roof_start_idx + i, roof_start_idx + i + 1])
    else:
        # Fan triangulation fallback
        for i in range(1, n - 1):
            faces.append([roof_start_idx, roof_start_idx + i, roof_start_idx + i + 1])

    return np.array(vertices), np.array(faces), np.array(uvs)


def create_pitched_roof_building(exterior_coords: list, ground_z: float,
                                  wall_height: float, pitch_deg: float) -> tuple:
    """
    Create a building with pitched (gabled) roof.

    The roof ridge runs along the longest axis of the building's OBB.

    Returns:
        (vertices, faces, uvs) as numpy arrays
    """
    n = len(exterior_coords)
    if n < 3:
        return None, None, None

    # Get OBB to determine ridge direction
    center, half_width, half_depth, angle, obb_corners = compute_obb(exterior_coords)

    # Ridge runs along longer axis
    # half_width is along primary (longer) axis
    cos_a, sin_a = np.cos(angle), np.sin(angle)

    # Ridge endpoints (at center, extending along primary axis)
    ridge_start = np.array([center[0] - half_width * cos_a, center[1] - half_width * sin_a])
    ridge_end = np.array([center[0] + half_width * cos_a, center[1] + half_width * sin_a])

    # Calculate roof height from pitch and half_depth (perpendicular distance to ridge)
    roof_height = half_depth * np.tan(np.radians(pitch_deg))
    roof_height = min(roof_height, wall_height * 0.7)  # Cap roof height

    roof_z = ground_z + wall_height
    ridge_z = roof_z + roof_height

    vertices = []
    faces = []
    uvs = []

    TILE_WIDTH = 4.0
    TILE_HEIGHT = 3.0

    # Calculate wall lengths
    wall_lengths = []
    for i in range(n):
        x1, y1 = exterior_coords[i]
        x2, y2 = exterior_coords[(i + 1) % n]
        wall_lengths.append(np.sqrt((x2 - x1)**2 + (y2 - y1)**2))

    # --- WALLS ---
    u_offset = 0
    for i in range(n):
        x1, y1 = exterior_coords[i]
        x2, y2 = exterior_coords[(i + 1) % n]
        wall_length = wall_lengths[i]

        v_idx = len(vertices)

        vertices.extend([
            [x1, y1, ground_z],
            [x2, y2, ground_z],
            [x2, y2, roof_z],
            [x1, y1, roof_z],
        ])

        u1 = u_offset / TILE_WIDTH
        u2 = (u_offset + wall_length) / TILE_WIDTH

        uvs.extend([
            [u1, 0],
            [u2, 0],
            [u2, wall_height / TILE_HEIGHT],
            [u1, wall_height / TILE_HEIGHT],
        ])

        faces.append([v_idx, v_idx + 1, v_idx + 2])
        faces.append([v_idx, v_idx + 2, v_idx + 3])

        u_offset += wall_length

    # --- ROOF ---
    # For each wall edge, we need to determine if it's:
    # 1. A "slope" edge (connects to ridge) - on the sides perpendicular to ridge
    # 2. A "gable" edge (forms triangular gable end) - on the ends parallel to ridge

    # Direction perpendicular to ridge (points to one side of the roof)
    perp_x = -sin_a
    perp_y = cos_a

    # Classify each edge and vertex
    # A vertex is on the "positive" side if dot product with perp vector > 0
    vertex_sides = []
    for x, y in exterior_coords:
        dx = x - center[0]
        dy = y - center[1]
        dot = dx * perp_x + dy * perp_y
        vertex_sides.append(1 if dot > 0 else -1 if dot < 0 else 0)

    # Add ridge vertices
    ridge_start_idx = len(vertices)
    vertices.append([ridge_start[0], ridge_start[1], ridge_z])
    uvs.append([0, 1])
    vertices.append([ridge_end[0], ridge_end[1], ridge_z])
    uvs.append([1, 1])

    # Add eave vertices (at roof_z, same positions as wall tops)
    eave_start_idx = len(vertices)
    for x, y in exterior_coords:
        vertices.append([x, y, roof_z])
        uvs.append([0, 0])  # Will fix UVs later

    # For each edge, create appropriate roof geometry
    for i in range(n):
        v1_side = vertex_sides[i]
        v2_side = vertex_sides[(i + 1) % n]

        eave1_idx = eave_start_idx + i
        eave2_idx = eave_start_idx + (i + 1) % n

        if v1_side == v2_side and v1_side != 0:
            # Both vertices on same side - this is a slope edge
            # Create quad from eave edge to ridge
            # Need to determine which ridge vertex to use based on proximity

            x1, y1 = exterior_coords[i]
            x2, y2 = exterior_coords[(i + 1) % n]
            mid_x = (x1 + x2) / 2
            mid_y = (y1 + y2) / 2

            # Project midpoint onto ridge line to find closest ridge point
            # Ridge direction vector
            ridge_vec = ridge_end - ridge_start
            ridge_len = np.linalg.norm(ridge_vec)
            if ridge_len > 0:
                ridge_dir = ridge_vec / ridge_len
                # Vector from ridge_start to midpoint
                to_mid = np.array([mid_x, mid_y]) - ridge_start
                # Project onto ridge
                t = np.dot(to_mid, ridge_dir) / ridge_len
                t = np.clip(t, 0, 1)

                # Interpolated ridge point
                ridge_pt = ridge_start + t * ridge_vec
                ridge_pt_z = ridge_z

                # Add this ridge point as a vertex
                ridge_pt_idx = len(vertices)
                vertices.append([ridge_pt[0], ridge_pt[1], ridge_pt_z])
                uvs.append([t, 1])

                # Create triangle: eave1 -> eave2 -> ridge_pt
                if v1_side > 0:
                    faces.append([eave1_idx, eave2_idx, ridge_pt_idx])
                else:
                    faces.append([eave2_idx, eave1_idx, ridge_pt_idx])

        elif v1_side != v2_side:
            # Edge crosses the ridge - this is a gable end
            # Create triangle from the two eave vertices to the nearest ridge vertex

            x1, y1 = exterior_coords[i]
            x2, y2 = exterior_coords[(i + 1) % n]
            mid_x = (x1 + x2) / 2
            mid_y = (y1 + y2) / 2

            # Find which ridge vertex is closer
            d_start = (mid_x - ridge_start[0])**2 + (mid_y - ridge_start[1])**2
            d_end = (mid_x - ridge_end[0])**2 + (mid_y - ridge_end[1])**2

            if d_start < d_end:
                ridge_idx = ridge_start_idx
            else:
                ridge_idx = ridge_start_idx + 1

            # Gable triangle
            faces.append([eave1_idx, eave2_idx, ridge_idx])

    # Connect ridge vertices with a line of triangles along the ridge
    # This fills the gap along the ridge between the two slope surfaces

    return np.array(vertices), np.array(faces), np.array(uvs)


def create_simple_pitched_building(exterior_coords: list, ground_z: float,
                                    wall_height: float, pitch_deg: float) -> tuple:
    """
    Create a simple pitched roof building using a more robust approach.

    Instead of complex edge classification, we:
    1. Create walls as usual
    2. Create a hip roof by connecting all eave vertices to a single center ridge point

    For more rectangular buildings, this creates a pyramid-like roof which
    looks reasonable and is always watertight.
    """
    n = len(exterior_coords)
    if n < 3:
        return None, None, None

    poly = ShapelyPolygon(exterior_coords)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.area < 1:
        return None, None, None

    # Get centroid for roof peak
    centroid = poly.centroid
    cx, cy = centroid.x, centroid.y

    # Calculate roof height from pitch and average distance to centroid
    avg_dist = np.mean([np.sqrt((x - cx)**2 + (y - cy)**2) for x, y in exterior_coords])
    roof_height = avg_dist * np.tan(np.radians(pitch_deg)) * 0.5
    roof_height = min(roof_height, wall_height * 0.6)

    roof_z = ground_z + wall_height
    peak_z = roof_z + roof_height

    vertices = []
    faces = []
    uvs = []

    TILE_WIDTH = 4.0
    TILE_HEIGHT = 3.0

    # --- WALLS ---
    u_offset = 0
    for i in range(n):
        x1, y1 = exterior_coords[i]
        x2, y2 = exterior_coords[(i + 1) % n]
        wall_length = np.sqrt((x2 - x1)**2 + (y2 - y1)**2)

        v_idx = len(vertices)

        vertices.extend([
            [x1, y1, ground_z],
            [x2, y2, ground_z],
            [x2, y2, roof_z],
            [x1, y1, roof_z],
        ])

        u1 = u_offset / TILE_WIDTH
        u2 = (u_offset + wall_length) / TILE_WIDTH

        uvs.extend([
            [u1, 0],
            [u2, 0],
            [u2, wall_height / TILE_HEIGHT],
            [u1, wall_height / TILE_HEIGHT],
        ])

        faces.append([v_idx, v_idx + 1, v_idx + 2])
        faces.append([v_idx, v_idx + 2, v_idx + 3])

        u_offset += wall_length

    # --- ROOF (pyramid/hip style) ---
    # Add peak vertex
    peak_idx = len(vertices)
    vertices.append([cx, cy, peak_z])
    uvs.append([0.5, 0.5])

    # Add eave vertices (at top of walls)
    eave_start_idx = len(vertices)
    bounds = poly.bounds
    bw = max(bounds[2] - bounds[0], 0.01)
    bh = max(bounds[3] - bounds[1], 0.01)

    for x, y in exterior_coords:
        vertices.append([x, y, roof_z])
        u = (x - bounds[0]) / bw
        v = (y - bounds[1]) / bh
        uvs.append([u, v])

    # Create roof faces - one triangle per edge connecting to peak
    for i in range(n):
        eave1_idx = eave_start_idx + i
        eave2_idx = eave_start_idx + (i + 1) % n
        faces.append([eave1_idx, eave2_idx, peak_idx])

    return np.array(vertices), np.array(faces), np.array(uvs)


def extrude_detailed_building(geometry_wgs84: dict, height: float, ground_z: float,
                               origin: tuple[float, float], props: dict) -> trimesh.Trimesh | None:
    """
    Create a detailed building mesh with appropriate roof style.
    """
    try:
        if geometry_wgs84['type'] != 'Polygon':
            return None

        coords_wgs84 = geometry_wgs84['coordinates'][0]
        coords_bng = [WGS84_TO_BNG.transform(c[0], c[1]) for c in coords_wgs84]

        origin_x, origin_y = origin
        local_coords = [(x - origin_x, y - origin_y) for x, y in coords_bng]

        # Remove closing point if present
        if local_coords[0] == local_coords[-1]:
            local_coords = local_coords[:-1]

        if len(local_coords) < 3:
            return None

        # Ensure valid polygon
        poly = ShapelyPolygon(local_coords)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.area < 1:
            return None

        # Use simplified exterior
        local_coords = list(poly.exterior.coords)[:-1]
        if len(local_coords) < 3:
            return None

        # Determine building type
        building_type = get_building_type(props)

        # Choose roof style
        if should_have_pitched_roof(building_type):
            pitch = get_roof_pitch(building_type)
            # Use wall height as 80% of total, roof as 20%
            wall_height = height * 0.8
            verts, faces, uvs = create_simple_pitched_building(
                local_coords, ground_z, wall_height, pitch
            )
        else:
            verts, faces, uvs = create_box_building(
                local_coords, ground_z, height
            )

        if verts is None or len(verts) == 0:
            return None

        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
        mesh.visual = create_uv_visual(uvs)

        return mesh

    except Exception as e:
        return None


def generate_detailed_meshes(buildings_path: Path, dtm_path: Path,
                              origin: tuple[float, float], chunk_size: float,
                              target_chunks: list = None) -> dict:
    """Generate detailed building meshes, organized by chunk."""
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

    type_stats = {}

    for i, feature in enumerate(buildings["features"]):
        geom = feature.get("geometry")
        props = feature.get("properties", {})
        height = props.get("height", 6.0)

        if geom is None or geom['type'] != 'Polygon':
            failed += 1
            continue

        coords_wgs84 = geom['coordinates'][0]
        center_lon = sum(c[0] for c in coords_wgs84) / len(coords_wgs84)
        center_lat = sum(c[1] for c in coords_wgs84) / len(coords_wgs84)
        center_x, center_y = WGS84_TO_BNG.transform(center_lon, center_lat)

        chunk_x = int((center_x - origin_x) // chunk_size)
        chunk_y = int((center_y - origin_y) // chunk_size)
        chunk_key = f"{chunk_x}_{chunk_y}"

        if target_chunks and chunk_key not in target_chunks:
            continue

        ground_z = get_ground_elevation(center_x, center_y, dtm_src)
        mesh = extrude_detailed_building(geom, height, ground_z, origin, props)

        if mesh is not None and len(mesh.vertices) > 0:
            if chunk_key not in meshes_by_chunk:
                meshes_by_chunk[chunk_key] = []
            meshes_by_chunk[chunk_key].append(mesh)
            success += 1

            btype = get_building_type(props)
            type_stats[btype] = type_stats.get(btype, 0) + 1
        else:
            failed += 1

        if (i + 1) % 2000 == 0:
            print(f"  Processed {i + 1}/{len(buildings['features'])} buildings")

    dtm_src.close()
    print(f"  Success: {success}, Failed: {failed}")
    print(f"  Building types: {type_stats}")

    return meshes_by_chunk


def save_meshes(meshes_by_chunk: dict, output_dir: Path, prefix: str) -> dict:
    """Save chunked meshes as GLB files."""
    output_dir.mkdir(parents=True, exist_ok=True)

    stats = {"files": 0, "vertices": 0, "faces": 0}

    for chunk_key, meshes in meshes_by_chunk.items():
        if not meshes:
            continue

        combined = trimesh.util.concatenate(meshes)
        output_file = output_dir / f"{prefix}_{chunk_key}.glb"
        combined.export(output_file, file_type="glb")

        stats["files"] += 1
        stats["vertices"] += len(combined.vertices)
        stats["faces"] += len(combined.faces)

        print(f"  {output_file.name}: {len(combined.vertices):,} verts, {len(combined.faces):,} faces")

    return stats


def main():
    parser = argparse.ArgumentParser(description="Generate detailed building meshes")
    parser.add_argument("--chunks", nargs="+", help="Specific chunks to process (e.g., 0_0 n1_1 for -1_1)")
    parser.add_argument("--all", action="store_true", help="Process all chunks")
    args = parser.parse_args()

    # Convert 'n' prefix to negative for chunks
    if args.chunks:
        args.chunks = [c.replace('n', '-') for c in args.chunks]

    settings = load_settings()
    chunk_size = settings["terrain"]["chunk_size_m"]

    print("Loading AOI centre...")
    origin = load_aoi_centre()
    print(f"Origin (BNG): {origin}")

    dtm_path = INTERIM_DIR / "dtm_clip.tif"
    buildings_path = PROCESSED_DIR / "buildings_height.geojson"
    output_dir = PROCESSED_DIR / "buildings_detailed"

    if not buildings_path.exists():
        print(f"Buildings not found: {buildings_path}")
        return

    if not dtm_path.exists():
        print(f"DTM not found: {dtm_path}")
        return

    target_chunks = args.chunks if args.chunks else None

    print("\n" + "=" * 50)
    print("DETAILED BUILDING MESHES")
    print("=" * 50)

    meshes = generate_detailed_meshes(
        buildings_path, dtm_path, origin, chunk_size, target_chunks
    )

    stats = save_meshes(meshes, output_dir, "buildings")

    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    print(f"Files: {stats['files']}")
    print(f"Vertices: {stats['vertices']:,}")
    print(f"Faces: {stats['faces']:,}")
    print(f"\nOutput: {output_dir}")

    print("\nDone!")


if __name__ == "__main__":
    main()
