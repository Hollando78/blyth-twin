"""
Twin configuration management.

Provides twin-specific configuration and paths for the pipeline.
Loads twin data from the database and generates appropriate settings.
"""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import psycopg2
import yaml
from pyproj import Transformer


# Coordinate transformers
WGS84_TO_BNG = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
BNG_TO_WGS84 = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


@dataclass
class TwinConfig:
    """Configuration for a specific twin."""

    # Identity
    twin_id: str
    name: str
    location_name: Optional[str] = None

    # AOI definition
    centre_lat: float = 0.0
    centre_lon: float = 0.0
    side_length_m: int = 2000
    buffer_m: int = 500

    # Status
    status: str = "pending"
    has_lidar: bool = False
    height_source: str = "osm"
    use_lidar: bool = True  # User preference for LiDAR

    # Base paths (set after init)
    project_root: Path = field(default_factory=Path)
    data_dir: Path = field(default_factory=Path)
    dist_dir: Path = field(default_factory=Path)
    config_dir: Path = field(default_factory=Path)

    def __post_init__(self):
        """Set up paths after initialization."""
        if not self.project_root or self.project_root == Path():
            self.project_root = Path(__file__).parent.parent.parent

        self.data_dir = self.project_root / "data" / "twins" / self.twin_id
        self.dist_dir = self.project_root / "dist" / "twins" / self.twin_id
        self.config_dir = self.data_dir / "config"

    @property
    def raw_osm_dir(self) -> Path:
        """Directory for raw OSM data."""
        return self.data_dir / "raw" / "osm"

    @property
    def raw_lidar_dtm_dir(self) -> Path:
        """Directory for raw LiDAR DTM data."""
        return self.data_dir / "raw" / "lidar_dtm"

    @property
    def raw_lidar_dsm_dir(self) -> Path:
        """Directory for raw LiDAR DSM data."""
        return self.data_dir / "raw" / "lidar_dsm"

    @property
    def interim_dir(self) -> Path:
        """Directory for intermediate processing files."""
        return self.data_dir / "interim"

    @property
    def processed_dir(self) -> Path:
        """Directory for processed output files."""
        return self.data_dir / "processed"

    @property
    def aoi_file(self) -> Path:
        """Path to AOI GeoJSON file."""
        return self.config_dir / "aoi.geojson"

    @property
    def aoi_buffer_file(self) -> Path:
        """Path to buffered AOI GeoJSON file."""
        return self.config_dir / "aoi_buffer.geojson"

    @property
    def settings_file(self) -> Path:
        """Path to settings YAML file."""
        return self.config_dir / "settings.yaml"

    @property
    def assets_dir(self) -> Path:
        """Directory for packaged assets."""
        return self.dist_dir / "assets"

    @property
    def manifest_file(self) -> Path:
        """Path to manifest JSON file."""
        return self.dist_dir / "manifest.json"

    def ensure_directories(self):
        """Create all required directories."""
        dirs = [
            self.config_dir,
            self.raw_osm_dir,
            self.raw_lidar_dtm_dir,
            self.raw_lidar_dsm_dir,
            self.interim_dir,
            self.processed_dir,
            self.assets_dir,
        ]
        for d in dirs:
            d.mkdir(parents=True, exist_ok=True)

    def generate_settings_yaml(self) -> dict:
        """Generate settings.yaml content for this twin."""
        return {
            "project": {
                "name": self.name,
                "version": "1.0.0",
                "twin_id": self.twin_id,
            },
            "aoi": {
                "centre_lat": self.centre_lat,
                "centre_lon": self.centre_lon,
                "side_length_m": self.side_length_m,
                "buffer_m": self.buffer_m,
                "crs_geographic": "EPSG:4326",
                "crs_projected": "EPSG:27700",
            },
            "lidar": {
                "resolution_m": 1.0,
                "datum": "Ordnance Datum Newlyn",
                "enabled": self.has_lidar,
            },
            "buildings": {
                "storey_height_m": 3.0,
                "ndsm_percentile": 90,
                "min_height_m": 2.5,
                "max_height_m": 80.0,
            },
            "terrain": {
                "chunk_size_m": 500,
                "lod_levels": [1, 2, 4],
            },
            "roads": {
                "width_primary_m": 8.0,
                "width_secondary_m": 7.0,
                "width_tertiary_m": 6.0,
                "width_residential_m": 5.0,
                "width_service_m": 4.0,
                "width_footway_m": 2.0,
                "width_cycleway_m": 2.5,
                "width_default_m": 4.0,
                "elevation_offset_m": 1.0,
            },
            "railways": {
                "width_m": 3.5,
                "elevation_offset_m": 0.8,
            },
            "water": {
                "elevation_offset_m": 0.3,
            },
            "sea": {
                "elevation_m": 0.0,
            },
            "output": {
                "mesh_format": "glb",
                "compress": False,
                "dist_dir": str(self.dist_dir),
            },
            "paths": {
                "raw_lidar_dtm": str(self.raw_lidar_dtm_dir),
                "raw_lidar_dsm": str(self.raw_lidar_dsm_dir),
                "raw_osm": str(self.raw_osm_dir),
                "interim": str(self.interim_dir),
                "processed": str(self.processed_dir),
            },
        }

    def save_settings(self):
        """Save settings.yaml to config directory."""
        self.ensure_directories()
        settings = self.generate_settings_yaml()
        with open(self.settings_file, "w") as f:
            yaml.dump(settings, f, default_flow_style=False)

    def load_settings(self) -> dict:
        """Load settings from YAML file."""
        if not self.settings_file.exists():
            self.save_settings()
        with open(self.settings_file) as f:
            return yaml.safe_load(f)


def get_db_connection():
    """Get database connection."""
    password = os.environ.get("PGPASSWORD", "blyth123")
    try:
        return psycopg2.connect(
            host=os.environ.get("PGHOST", "localhost"),
            database=os.environ.get("PGDATABASE", "blyth_twin"),
            user=os.environ.get("PGUSER", "postgres"),
            password=password,
            port=int(os.environ.get("PGPORT", 5432)),
        )
    except Exception:
        return psycopg2.connect("dbname=blyth_twin")


def get_twin_config(twin_id: str) -> TwinConfig:
    """Load twin configuration from database."""
    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
            id, name, location_name,
            centre_lat, centre_lon,
            side_length_m, buffer_m,
            status, has_lidar, height_source,
            use_lidar
        FROM twins
        WHERE id = %s
    """,
        (twin_id,),
    )

    row = cur.fetchone()
    cur.close()
    conn.close()

    if not row:
        raise ValueError(f"Twin {twin_id} not found")

    return TwinConfig(
        twin_id=str(row[0]),
        name=row[1],
        location_name=row[2],
        centre_lat=row[3],
        centre_lon=row[4],
        side_length_m=row[5],
        buffer_m=row[6],
        status=row[7],
        has_lidar=row[8] or False,
        height_source=row[9] or "osm",
        use_lidar=row[10] if row[10] is not None else True,
    )


def update_twin_status(
    twin_id: str,
    status: Optional[str] = None,
    current_step: Optional[str] = None,
    progress_pct: Optional[int] = None,
    error_message: Optional[str] = None,
    building_count: Optional[int] = None,
    has_lidar: Optional[bool] = None,
    height_source: Optional[str] = None,
):
    """Update twin status in database."""
    conn = get_db_connection()
    cur = conn.cursor()

    updates = []
    values = []

    if status is not None:
        updates.append("status = %s")
        values.append(status)
        if status == "running":
            updates.append("started_at = NOW()")
        elif status in ("completed", "failed"):
            updates.append("completed_at = NOW()")

    if current_step is not None:
        updates.append("current_step = %s")
        values.append(current_step)

    if progress_pct is not None:
        updates.append("progress_pct = %s")
        values.append(progress_pct)

    if error_message is not None:
        updates.append("error_message = %s")
        values.append(error_message)

    if building_count is not None:
        updates.append("building_count = %s")
        values.append(building_count)

    if has_lidar is not None:
        updates.append("has_lidar = %s")
        values.append(has_lidar)

    if height_source is not None:
        updates.append("height_source = %s")
        values.append(height_source)

    if updates:
        values.append(twin_id)
        cur.execute(
            f"UPDATE twins SET {', '.join(updates)} WHERE id = %s",
            values,
        )
        conn.commit()

    cur.close()
    conn.close()


def get_os_grid_ref(easting: float, northing: float) -> Optional[str]:
    """
    Convert BNG coordinates to OS National Grid reference (e.g., 'NT', 'NZ').
    Returns the 100km grid square letters.
    """
    # OS Grid letter scheme
    grid_letters = [
        ['SV', 'SW', 'SX', 'SY', 'SZ', 'TV', 'TW'],
        ['SQ', 'SR', 'SS', 'ST', 'SU', 'TQ', 'TR'],
        ['SL', 'SM', 'SN', 'SO', 'SP', 'TL', 'TM'],
        ['SF', 'SG', 'SH', 'SJ', 'SK', 'TF', 'TG'],
        ['SA', 'SB', 'SC', 'SD', 'SE', 'TA', 'TB'],
        ['NV', 'NW', 'NX', 'NY', 'NZ', 'OV', 'OW'],
        ['NQ', 'NR', 'NS', 'NT', 'NU', 'OQ', 'OR'],
        ['NL', 'NM', 'NN', 'NO', 'NP', 'OL', 'OM'],
        ['NF', 'NG', 'NH', 'NJ', 'NK', 'OF', 'OG'],
        ['NA', 'NB', 'NC', 'ND', 'NE', 'OA', 'OB'],
        ['HV', 'HW', 'HX', 'HY', 'HZ', 'JV', 'JW'],
        ['HQ', 'HR', 'HS', 'HT', 'HU', 'JQ', 'JR'],
        ['HL', 'HM', 'HN', 'HO', 'HP', 'JL', 'JM'],
    ]

    col = int(easting // 100000)
    row = int(northing // 100000)

    if 0 <= col < 7 and 0 <= row < 13:
        return grid_letters[row][col]
    return None


def get_required_tiles(
    centre_lat: float,
    centre_lon: float,
    side_length_m: float,
    buffer_m: float = 0
) -> list[str]:
    """
    Calculate OS National Grid 5km tile references for an AOI.

    Args:
        centre_lat: Centre latitude (WGS84)
        centre_lon: Centre longitude (WGS84)
        side_length_m: Side length of AOI in meters
        buffer_m: Additional buffer around AOI

    Returns:
        List of tile references like ['NZ28SW', 'NZ28SE']
    """
    # Convert centre to BNG
    centre_e, centre_n = WGS84_TO_BNG.transform(centre_lon, centre_lat)

    # Calculate bounding box with buffer
    half_side = (side_length_m / 2) + buffer_m
    min_e = centre_e - half_side
    max_e = centre_e + half_side
    min_n = centre_n - half_side
    max_n = centre_n + half_side

    tiles = set()

    # Iterate over 5km grid cells (EA tiles are 5km x 5km)
    for e in range(int(min_e // 5000) * 5000, int(max_e // 5000 + 1) * 5000, 5000):
        for n in range(int(min_n // 5000) * 5000, int(max_n // 5000 + 1) * 5000, 5000):
            # Get 100km grid reference
            grid_ref = get_os_grid_ref(e, n)
            if grid_ref is None:
                continue

            # Get 10km square numbers (00-99)
            e_10km = (e % 100000) // 10000
            n_10km = (n % 100000) // 10000

            # Get quadrant within 10km square (5km tiles)
            e_5km = (e % 10000) // 5000
            n_5km = (n % 10000) // 5000

            # Quadrant naming: SW, SE, NW, NE
            quadrant_ew = 'W' if e_5km == 0 else 'E'
            quadrant_ns = 'S' if n_5km == 0 else 'N'
            quadrant = f"{quadrant_ns}{quadrant_ew}"

            tile_ref = f"{grid_ref}{e_10km}{n_10km}{quadrant}"
            tiles.add(tile_ref)

    return sorted(tiles)


def is_in_england(centre_lat: float, centre_lon: float) -> bool:
    """
    Check if coordinates are within England (where EA LiDAR is available).

    Uses a simple bounding box check. EA LiDAR covers England only,
    not Scotland, Wales (which have separate agencies), or outside UK.
    """
    # England approximate bounds (excluding Scotland and Wales)
    # This is a rough approximation - actual coverage depends on EA data
    MIN_LAT = 49.9  # South coast
    MAX_LAT = 55.8  # North of Newcastle, below Scottish border
    MIN_LON = -5.7  # Cornwall
    MAX_LON = 1.8   # East coast

    # Convert to BNG to check if within valid grid
    try:
        easting, northing = WGS84_TO_BNG.transform(centre_lon, centre_lat)

        # Check if within BNG valid range (roughly England)
        if easting < 0 or easting > 700000:
            return False
        if northing < 0 or northing > 700000:
            return False

        # Check if within rough England bounds
        if not (MIN_LAT <= centre_lat <= MAX_LAT):
            return False
        if not (MIN_LON <= centre_lon <= MAX_LON):
            return False

        return True
    except Exception:
        return False


def check_tiles_exist(config: "TwinConfig", tiles: list[str]) -> tuple[list[str], list[str]]:
    """
    Check which tiles exist in the twin's LiDAR directory.

    Returns:
        Tuple of (existing_tiles, missing_tiles)
    """
    dtm_dir = config.raw_lidar_dtm_dir
    existing = []
    missing = []

    for tile_ref in tiles:
        # EA tiles are named like: LIDAR-DTM-1M-NZ28SW.zip or extracted TIFs
        # Check for any TIF file containing the tile reference
        if dtm_dir.exists():
            matches = list(dtm_dir.glob(f"*{tile_ref}*.tif"))
            if matches:
                existing.append(tile_ref)
                continue
        missing.append(tile_ref)

    return existing, missing


def save_tiles_needed(twin_id: str, tiles: list[str]):
    """Save the list of needed tiles to the database."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "UPDATE twins SET tiles_needed = %s WHERE id = %s",
        (json.dumps(tiles), twin_id)
    )
    conn.commit()
    cur.close()
    conn.close()


def get_tiles_needed(twin_id: str) -> list[str]:
    """Get the list of needed tiles from the database."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT tiles_needed FROM twins WHERE id = %s", (twin_id,))
    row = cur.fetchone()
    cur.close()
    conn.close()

    if row and row[0]:
        return row[0] if isinstance(row[0], list) else json.loads(row[0])
    return []
