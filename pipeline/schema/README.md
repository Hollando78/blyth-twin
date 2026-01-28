# Database Schema

PostgreSQL/PostGIS database schema for the Blyth Digital Twin project.

## Prerequisites

- PostgreSQL 14+
- PostGIS extension

## Setup

```bash
# Create database
createdb blyth_twin

# Enable PostGIS
psql -d blyth_twin -c "CREATE EXTENSION postgis;"

# Run migrations
psql -d blyth_twin -f migrations/001_create_overrides_tables.sql
```

## Tables

### buildings
Primary building data imported from OpenStreetMap.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| osm_id | BIGINT | OpenStreetMap ID (unique) |
| geometry | GEOMETRY(Polygon, 27700) | Building footprint in BNG |
| height | REAL | Building height in meters |
| height_source | VARCHAR(50) | Source: osm, lidar, levels, default |
| levels | INTEGER | Number of floors (building:levels) |
| building_type | VARCHAR(100) | OSM building tag value |
| name | VARCHAR(255) | Building name |
| amenity | VARCHAR(100) | OSM amenity tag |
| shop | VARCHAR(100) | OSM shop tag |
| office | VARCHAR(100) | OSM office tag |
| addr_* | VARCHAR | Address components |
| tags | JSONB | Additional OSM tags |
| centroid | GEOMETRY(Point, 27700) | Footprint centroid |
| created_at | TIMESTAMP | Record creation time |
| updated_at | TIMESTAMP | Last modification time |
| source | VARCHAR(20) | Data source (osm, lidar, geocode, user) |

Populated by:
- `21_migrate_to_postgis.py` - Initial OSM import
- `50_building_heights.py` - LiDAR heights
- `26_geocode_addresses.py` - Address enrichment

### building_overrides
User property edits, stored separately from OSM data.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| osm_id | BIGINT | References buildings.osm_id |
| height | REAL | Override height |
| height_source | VARCHAR(50) | Override source |
| name | VARCHAR(255) | Override name |
| building_type | VARCHAR(100) | Override type |
| addr_* | VARCHAR | Override address fields |
| geometry | GEOMETRY(Polygon, 27700) | Override footprint |
| created_at | TIMESTAMP | Override creation time |
| updated_at | TIMESTAMP | Last modification time |
| created_by | VARCHAR(100) | User identifier |
| edit_note | TEXT | Description of changes |

Key features:
- NULL values mean "use OSM base value"
- One override per building (UNIQUE on osm_id)
- Merged with base data using COALESCE during export

### building_meshes
Custom 3D models that replace procedural generation.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| osm_id | BIGINT | References buildings.osm_id |
| glb_data | BYTEA | Inline GLB binary data |
| glb_url | VARCHAR(500) | External URL (alternative) |
| vertex_count | INTEGER | Mesh statistics |
| face_count | INTEGER | Mesh statistics |
| bounds_* | REAL | Bounding box coordinates |
| mesh_source | VARCHAR(50) | Origin: user_upload, mesh_editor, meshy_ai |
| source_reference | VARCHAR(500) | Original filename, API job ID |
| created_at | TIMESTAMP | Upload time |
| updated_at | TIMESTAMP | Last modification time |
| created_by | VARCHAR(100) | User identifier |

Key features:
- Either glb_data or glb_url must be set (CHECK constraint)
- During mesh generation, buildings with custom meshes are skipped

## Views

### buildings_merged
Combines base buildings with overrides for easy querying.

```sql
SELECT * FROM buildings_merged WHERE osm_id = 123456789;
```

Returns:
- All building fields with COALESCE applied for overrides
- `has_override` boolean
- `has_custom_mesh` boolean
- `edit_note` from override
- `override_created_by`

## Triggers

All tables have `update_updated_at_column()` trigger that automatically sets `updated_at` on UPDATE.

## Indexes

- `idx_overrides_osm_id` - Fast override lookups
- `idx_overrides_building_id` - Join optimization
- `idx_meshes_osm_id` - Fast mesh lookups
- `idx_meshes_source` - Filter by mesh source

## Migrations

### 001_create_overrides_tables.sql
- Creates `building_overrides` table
- Creates `building_meshes` table
- Adds audit columns to `buildings` table
- Creates `buildings_merged` view
- Sets up update triggers

Run order:
1. `001_create_overrides_tables.sql` - Phase 2 tables

## Usage Examples

### Get building with merged data
```sql
SELECT * FROM buildings_merged WHERE osm_id = 123456789;
```

### List buildings with overrides
```sql
SELECT osm_id, name, edit_note, updated_at
FROM building_overrides
ORDER BY updated_at DESC;
```

### List buildings with custom meshes
```sql
SELECT osm_id, mesh_source, vertex_count, face_count
FROM building_meshes
ORDER BY created_at DESC;
```

### Find buildings modified today
```sql
SELECT b.osm_id, b.name, b.has_override, b.has_custom_mesh
FROM buildings_merged b
WHERE b.updated_at > CURRENT_DATE;
```

### Export buildings with overrides merged
```sql
SELECT
    b.osm_id,
    ST_AsGeoJSON(ST_Transform(
        COALESCE(o.geometry, b.geometry), 4326
    )) as geometry,
    COALESCE(o.height, b.height) as height,
    COALESCE(o.name, b.name) as name
FROM buildings b
LEFT JOIN building_overrides o ON b.osm_id = o.osm_id
WHERE b.geometry IS NOT NULL;
```

## Coordinate Reference System

All geometry is stored in **EPSG:27700** (British National Grid).

Transform to WGS84 for GeoJSON export:
```sql
ST_Transform(geometry, 4326)
```
