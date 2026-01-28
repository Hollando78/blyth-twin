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

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# Dummy 1x1 white texture for UV export (trimesh requires a texture to export UVs)
DUMMY_TEXTURE = None

def get_dummy_texture():
    """Get or create a dummy texture for UV export."""
    global DUMMY_TEXTURE
    if DUMMY_TEXTURE is None and HAS_PIL:
        DUMMY_TEXTURE = Image.new('RGB', (4, 4), (200, 200, 200))
    return DUMMY_TEXTURE


# SimCity-style zone colors (RGB normalized 0-1)
ZONE_COLORS = {
    "residential": (0.298, 0.686, 0.314),  # Green #4CAF50
    "commercial": (0.129, 0.588, 0.953),   # Blue #2196F3
    "industrial": (1.0, 0.596, 0.0),       # Orange #FF9800
    "civic": (0.612, 0.153, 0.690),        # Purple #9C27B0
    "other": (0.475, 0.333, 0.282),        # Brown #795548
}


def get_zone_from_properties(props: dict) -> str:
    """Determine SimCity-style zone from building properties."""
    building_type = (props.get("building") or "").lower()
    amenity = (props.get("amenity") or "").lower()
    shop = props.get("shop")

    # Residential
    if building_type in ("residential", "house", "terrace", "semidetached_house", "detached",
                         "bungalow", "apartments", "flat", "dormitory"):
        return "residential"

    # Commercial
    if building_type in ("retail", "commercial", "supermarket", "kiosk") or shop:
        return "commercial"
    if amenity in ("pub", "restaurant", "cafe", "fast_food", "bar", "hotel", "bank"):
        return "commercial"

    # Industrial
    if building_type in ("industrial", "warehouse", "factory", "manufacture", "storage_tank"):
        return "industrial"

    # Civic
    if building_type in ("school", "university", "college", "church", "chapel", "cathedral",
                         "hospital", "civic", "public", "government", "office", "fire_station",
                         "police", "library", "community_centre", "sports_centre"):
        return "civic"
    if amenity in ("school", "hospital", "place_of_worship", "community_centre", "library",
                   "police", "fire_station", "townhall", "theatre", "cinema"):
        return "civic"

    return "other"


def create_uv_visual(uvs: np.ndarray) -> trimesh.visual.TextureVisuals:
    """Create TextureVisuals with UVs and a dummy texture for proper GLB export."""
    dummy = get_dummy_texture()
    if dummy is not None:
        material = trimesh.visual.material.SimpleMaterial(image=dummy)
        return trimesh.visual.TextureVisuals(uv=uvs, material=material)
    else:
        # Fallback without texture (UVs may not export)
        return trimesh.visual.TextureVisuals(uv=uvs)

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
    Generate chunked terrain meshes from DTM with UV coordinates.

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

            # Create UV coordinates mapped to full AOI extent
            # UVs should map each chunk to its correct portion of the satellite texture
            aoi_width = maxx - minx
            aoi_height = maxy - miny

            # Calculate UV range for this chunk relative to full AOI
            # Standard mapping - flip is done on the texture side
            u_min = (cx_min - minx) / aoi_width
            u_max = (cx_max - minx) / aoi_width
            v_min = (cy_min - miny) / aoi_height
            v_max = (cy_max - miny) / aoi_height

            u = np.linspace(u_min, u_max, cols)
            v = np.linspace(v_max, v_min, rows)  # North to south
            uu, vv = np.meshgrid(u, v)

            # Flatten for vertices
            vertices = np.column_stack([
                xx.flatten(),
                yy.flatten(),
                chunk_data.flatten()
            ])

            # UV coordinates
            uvs = np.column_stack([
                uu.flatten(),
                vv.flatten()
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

            # Create mesh with UV coordinates
            mesh = trimesh.Trimesh(vertices=vertices, faces=faces)
            mesh.visual = create_uv_visual(uvs)

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


def extrude_building_with_uvs(geometry_wgs84: dict, height: float, ground_z: float,
                               origin: tuple[float, float], building_type: str = "default",
                               building_id: int = 0, properties: dict = None) -> trimesh.Trimesh | None:
    """
    Extrude a building footprint to a 3D prism with UV coordinates for texturing.

    Args:
        geometry_wgs84: GeoJSON geometry in WGS84
        height: Building height in metres
        ground_z: Ground elevation at building location
        origin: Local origin for coordinate translation
        building_type: OSM building type for texture mapping
        building_id: Building ID for deterministic texture variation
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

        # Remove closing point
        polygon_2d = local_coords[:-1] if local_coords[0] == local_coords[-1] else local_coords

        if len(polygon_2d) < 3:
            return None

        from shapely.geometry import Polygon as ShapelyPolygon
        poly = ShapelyPolygon(polygon_2d)

        if not poly.is_valid:
            poly = poly.buffer(0)

        if poly.is_empty or poly.area < 1:  # Skip tiny buildings
            return None

        # Build mesh manually with UVs for walls
        vertices = []
        faces = []
        uvs = []

        # Get exterior coordinates
        exterior = list(poly.exterior.coords)[:-1]  # Remove closing point
        n = len(exterior)

        # Calculate wall perimeter for UV mapping
        wall_lengths = []
        total_perimeter = 0
        for i in range(n):
            x1, y1 = exterior[i]
            x2, y2 = exterior[(i + 1) % n]
            length = np.sqrt((x2 - x1)**2 + (y2 - y1)**2)
            wall_lengths.append(length)
            total_perimeter += length

        # Texture tile size (metres) - how often the texture repeats
        TILE_WIDTH = 4.0  # Horizontal repeat every 4m
        TILE_HEIGHT = 3.0  # Vertical repeat every 3m (one storey)

        # Build walls with UV coordinates
        u_offset = 0
        for i in range(n):
            x1, y1 = exterior[i]
            x2, y2 = exterior[(i + 1) % n]
            wall_length = wall_lengths[i]

            # 4 vertices per wall quad (bottom-left, bottom-right, top-right, top-left)
            v_idx = len(vertices)
            z_bottom = ground_z
            z_top = ground_z + height

            vertices.extend([
                [x1, y1, z_bottom],
                [x2, y2, z_bottom],
                [x2, y2, z_top],
                [x1, y1, z_top],
            ])

            # UV coordinates: U along wall (tiled), V up the wall (tiled)
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

            # Two triangles per quad
            faces.append([v_idx, v_idx + 1, v_idx + 2])
            faces.append([v_idx, v_idx + 2, v_idx + 3])

            u_offset += wall_length

        # Add roof (flat cap)
        roof_start_idx = len(vertices)

        # Use ear clipping or fan triangulation for roof
        roof_coords = list(poly.exterior.coords)[:-1]
        for x, y in roof_coords:
            vertices.append([x, y, ground_z + height])
            # Roof UV: map position to 0-1 range based on bounding box
            bounds = poly.bounds
            u_roof = (x - bounds[0]) / max(bounds[2] - bounds[0], 0.01)
            v_roof = (y - bounds[1]) / max(bounds[3] - bounds[1], 0.01)
            uvs.append([u_roof, v_roof])

        # Triangulate roof using fan from centroid
        if len(roof_coords) > 2:
            # Use shapely triangulation
            from shapely.ops import triangulate
            try:
                triangles = triangulate(poly)
                for tri in triangles:
                    if tri.within(poly) or tri.intersection(poly).area > tri.area * 0.5:
                        # Map triangle vertices to our vertex indices
                        tri_coords = list(tri.exterior.coords)[:-1]
                        tri_indices = []
                        for tx, ty in tri_coords:
                            # Find closest roof vertex
                            min_dist = float('inf')
                            min_idx = roof_start_idx
                            for j, (rx, ry) in enumerate(roof_coords):
                                dist = (tx - rx)**2 + (ty - ry)**2
                                if dist < min_dist:
                                    min_dist = dist
                                    min_idx = roof_start_idx + j
                            tri_indices.append(min_idx)
                        if len(tri_indices) == 3:
                            faces.append(tri_indices)
            except Exception:
                # Fallback: simple fan triangulation
                for i in range(1, len(roof_coords) - 1):
                    faces.append([roof_start_idx, roof_start_idx + i, roof_start_idx + i + 1])

        if len(vertices) == 0 or len(faces) == 0:
            return None

        # Create mesh (process=False prevents vertex merging which would break UV mapping)
        vertices = np.array(vertices)
        faces = np.array(faces)
        uvs = np.array(uvs)

        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)

        # Add OSM ID as vertex attribute (for direct lookup without face_map)
        if properties and 'osm_id' in properties:
            osm_id = properties['osm_id']
            mesh.vertex_attributes['osm_id'] = np.full(len(vertices), osm_id, dtype=np.float32)

        # Always use UV visual so textures work in the viewer
        mesh.visual = create_uv_visual(uvs)

        return mesh

    except Exception as e:
        return None


def extrude_building(geometry_wgs84: dict, height: float, ground_z: float,
                     origin: tuple[float, float]) -> trimesh.Trimesh | None:
    """
    Extrude a building footprint to a 3D prism (legacy function for compatibility).

    Args:
        geometry_wgs84: GeoJSON geometry in WGS84
        height: Building height in metres
        ground_z: Ground elevation at building location
        origin: Local origin for coordinate translation
    """
    return extrude_building_with_uvs(geometry_wgs84, height, ground_z, origin)


def generate_building_meshes(buildings_path: Path, dtm_path: Path,
                            origin: tuple[float, float], chunk_size: float) -> dict:
    """Generate building meshes, organized by chunk."""
    print(f"Loading buildings from {buildings_path}...")
    with open(buildings_path) as f:
        buildings = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    print(f"Processing {len(buildings['features'])} buildings...")

    meshes_by_chunk = {}  # chunk_key -> list of (mesh, osm_id)
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

        # Create mesh with zone colors
        props = feature.get("properties", {})
        mesh = extrude_building_with_uvs(geom, height, ground_z, origin, properties=props)
        osm_id = props.get("osm_id", 0)

        if mesh is not None and len(mesh.vertices) > 0:
            # Determine chunk based on centroid
            chunk_x = int((center_x - origin_x) // chunk_size)
            chunk_y = int((center_y - origin_y) // chunk_size)
            chunk_key = f"{chunk_x}_{chunk_y}"

            if chunk_key not in meshes_by_chunk:
                meshes_by_chunk[chunk_key] = []
            meshes_by_chunk[chunk_key].append((mesh, osm_id))
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
                       width: float, z_offset: float = 0.1,
                       highway_type: str = "default") -> trimesh.Trimesh | None:
    """
    Create a ribbon mesh along a path with UV coordinates.

    Args:
        coords: List of (x, y) local coordinates
        elevations: Ground elevation at each point
        width: Road width in metres
        z_offset: Height above ground to avoid z-fighting
        highway_type: OSM highway type for texture variation
    """
    if len(coords) < 2:
        return None

    vertices = []
    faces = []
    uvs = []
    half_width = width / 2

    # Track cumulative distance for UV.x (seamless tiling along road)
    cumulative_distance = 0.0

    # Texture tile length (metres) - how often texture repeats along road
    TILE_LENGTH = 10.0

    for i in range(len(coords) - 1):
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        z1 = elevations[i] + z_offset
        z2 = elevations[i + 1] + z_offset

        # Direction vector
        dx = x2 - x1
        dy = y2 - y1
        segment_length = np.sqrt(dx**2 + dy**2)

        if segment_length < 0.01:
            continue

        # Perpendicular vector (rotated 90°)
        px = -dy / segment_length * half_width
        py = dx / segment_length * half_width

        # 4 vertices per segment (quad)
        v_idx = len(vertices)
        vertices.extend([
            [x1 - px, y1 - py, z1],
            [x1 + px, y1 + py, z1],
            [x2 + px, y2 + py, z2],
            [x2 - px, y2 - py, z2],
        ])

        # UV coordinates:
        # U = position along road (for seamless tiling)
        # V = position across road width (0 = left edge, 1 = right edge)
        u1 = cumulative_distance / TILE_LENGTH
        u2 = (cumulative_distance + segment_length) / TILE_LENGTH

        uvs.extend([
            [u1, 0.0],  # left edge start
            [u1, 1.0],  # right edge start
            [u2, 1.0],  # right edge end
            [u2, 0.0],  # left edge end
        ])

        # Two triangles per quad
        faces.append([v_idx, v_idx + 1, v_idx + 2])
        faces.append([v_idx, v_idx + 2, v_idx + 3])

        cumulative_distance += segment_length

    if len(vertices) == 0:
        return None

    mesh = trimesh.Trimesh(vertices=np.array(vertices), faces=np.array(faces))
    mesh.visual = create_uv_visual(np.array(uvs))

    return mesh


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

        # Create mesh with UV coordinates
        mesh = create_ribbon_mesh(local_coords, elevations, width, z_offset, highway_type)

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

        # Create mesh with UV coordinates
        mesh = create_ribbon_mesh(local_coords, elevations, width, z_offset, "railway")

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


def get_waterway_width(waterway_type: str, settings: dict) -> float:
    """Get waterway width based on type."""
    waterway_settings = settings.get("waterways", {})
    width_map = {
        "river": waterway_settings.get("width_river_m", 15.0),
        "canal": waterway_settings.get("width_canal_m", 10.0),
        "stream": waterway_settings.get("width_stream_m", 3.0),
        "brook": waterway_settings.get("width_stream_m", 2.0),
        "drain": waterway_settings.get("width_drain_m", 2.0),
        "ditch": waterway_settings.get("width_drain_m", 1.5),
    }
    return width_map.get(waterway_type, waterway_settings.get("width_default_m", 3.0))


def generate_waterway_meshes(water_path: Path, dtm_path: Path, origin: tuple[float, float],
                             chunk_size: float, settings: dict) -> dict:
    """Generate linear waterway (streams, rivers) ribbon meshes."""
    print(f"Loading waterways from {water_path}...")
    with open(water_path) as f:
        water = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    # Filter for linear waterways only
    linear_features = [f for f in water["features"] if f.get("geometry", {}).get("type") == "LineString"]
    print(f"Processing {len(linear_features)} linear waterways...")

    meshes_by_chunk = {}
    success = 0
    failed = 0
    origin_x, origin_y = origin
    z_offset = settings.get("water", {}).get("elevation_offset_m", 0.3)

    for feature in linear_features:
        geom = feature.get("geometry")
        props = feature.get("properties", {})
        waterway_type = props.get("waterway", "stream")

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

        # Get waterway width
        width = get_waterway_width(waterway_type, settings)

        # Create ribbon mesh (reuse road ribbon function)
        mesh = create_ribbon_mesh(local_coords, elevations, width, z_offset, waterway_type)

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
    print(f"  Linear waterways - Success: {success}, Failed: {failed}")
    return meshes_by_chunk


def generate_water_meshes(water_path: Path, dtm_path: Path, origin: tuple[float, float],
                          chunk_size: float, aoi_bounds: tuple, settings: dict) -> dict:
    """Generate water body meshes (polygons only), organized by chunk and clipped to AOI."""
    from shapely.geometry import Polygon as ShapelyPolygon, box

    print(f"Loading water from {water_path}...")
    with open(water_path) as f:
        water = json.load(f)

    print(f"Opening DTM for ground elevation...")
    dtm_src = rasterio.open(dtm_path)

    # Create AOI clip box in local coordinates
    min_x, min_y, max_x, max_y = aoi_bounds
    aoi_box = box(min_x, min_y, max_x, max_y)

    # Filter for polygon water features only (ponds, lakes, reservoirs)
    polygon_features = [f for f in water["features"]
                        if f.get("geometry", {}).get("type") in ("Polygon", "MultiPolygon")]
    print(f"Processing {len(polygon_features)} polygon water features (clipping to AOI)...")

    meshes_by_chunk = {}
    success = 0
    failed = 0
    clipped = 0
    origin_x, origin_y = origin
    z_offset = settings.get("water", {}).get("elevation_offset_m", 0.3)

    for i, feature in enumerate(polygon_features):
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
    print(f"  Polygon water bodies - Success: {success}, Failed: {failed}, Clipped: {clipped}")
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


def save_building_meshes_with_metadata(meshes_by_chunk: dict, output_dir: Path, metadata_path: Path) -> dict:
    """Save chunked building meshes as GLB files with global_id vertex attribute for selection."""
    output_dir.mkdir(parents=True, exist_ok=True)

    stats = {"files": 0, "vertices": 0, "faces": 0}
    face_maps = {}  # chunk_key -> list of {osm_id, global_id, building_index, start_face, end_face}

    # First pass: assign global IDs across all chunks (sorted for consistency)
    global_id = 0
    chunk_global_ids = {}  # chunk_key -> list of global_ids for each building
    for chunk_key in sorted(meshes_by_chunk.keys()):
        mesh_osm_list = meshes_by_chunk[chunk_key]
        if not mesh_osm_list:
            continue
        chunk_global_ids[chunk_key] = []
        for _ in mesh_osm_list:
            chunk_global_ids[chunk_key].append(global_id)
            global_id += 1

    print(f"  Total buildings: {global_id}")

    # Second pass: build meshes with global_id vertex attribute
    for chunk_key in sorted(meshes_by_chunk.keys()):
        mesh_osm_list = meshes_by_chunk[chunk_key]
        if not mesh_osm_list:
            continue

        # Build face map and add global_id as vertex attribute to each mesh
        meshes = []
        face_map = []
        current_face = 0

        for idx, (mesh, osm_id) in enumerate(mesh_osm_list):
            gid = chunk_global_ids[chunk_key][idx]
            face_count = len(mesh.faces)

            # Add global_id as vertex attribute (same value for all vertices of this building)
            # Using underscore prefix for glTF custom attributes
            mesh.vertex_attributes['_global_id'] = np.full(len(mesh.vertices), gid, dtype=np.float32)

            face_map.append({
                "osm_id": osm_id,
                "global_id": gid,
                "building_index": idx,
                "start_face": current_face,
                "end_face": current_face + face_count
            })
            meshes.append(mesh)
            current_face += face_count

        face_maps[chunk_key] = face_map

        # Combine meshes (vertex attributes are preserved)
        combined = trimesh.util.concatenate(meshes)

        # Save as GLB
        output_file = output_dir / f"buildings_{chunk_key}.glb"
        combined.export(output_file, file_type="glb")

        stats["files"] += 1
        stats["vertices"] += len(combined.vertices)
        stats["faces"] += len(combined.faces)

        print(f"  {output_file.name}: {len(combined.vertices):,} verts, {len(combined.faces):,} faces, {len(face_map)} buildings")

    # Save metadata
    metadata = {"chunks": face_maps}
    with open(metadata_path, "w") as f:
        json.dump(metadata, f)
    print(f"\n  Saved building metadata to {metadata_path}")

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
        buildings_metadata_path = PROCESSED_DIR / "buildings_metadata.json"
        stats = save_building_meshes_with_metadata(building_chunks, buildings_dir, buildings_metadata_path)
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

    # Generate water meshes (both polygon bodies and linear waterways)
    if water_path.exists() and dtm_path.exists():
        print("\n" + "="*50)
        print("WATER MESHES")
        print("="*50)
        # Generate polygon water bodies (ponds, lakes, reservoirs)
        water_chunks = generate_water_meshes(water_path, dtm_path, origin, chunk_size, aoi_bounds, settings)

        # Generate linear waterways (streams, rivers)
        waterway_chunks = generate_waterway_meshes(water_path, dtm_path, origin, chunk_size, settings)

        # Merge waterway meshes into water chunks
        for chunk_key, meshes in waterway_chunks.items():
            if chunk_key not in water_chunks:
                water_chunks[chunk_key] = []
            if isinstance(meshes, list):
                water_chunks[chunk_key].extend(meshes)
            else:
                water_chunks[chunk_key].append(meshes)

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
