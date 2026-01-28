# Blyth Digital Twin

A web-first digital twin MVP for Blyth, Northumberland, featuring an interactive 3D viewer with building editing capabilities.

## Overview

This project creates a browser-based 3D model of Blyth using:

- **LiDAR data** from Environment Agency for terrain and building heights
- **OpenStreetMap** for building footprints and vector features
- **PostGIS** as the single source of truth for building data
- **Three.js** for web-based 3D rendering
- **FastAPI** backend for building data management

### Area of Interest

- **Centre:** Broadway Circle (NE24 2PG)
- **Size:** 5km x 5km square
- **Coordinate System:** EPSG:27700 (British National Grid)

## Features

### 3D Viewer
- Interactive orbit, pan, and zoom controls
- Building selection with metadata display
- Layer toggles (terrain, buildings, roads, railways, water)
- Building preview window with isolated 3D view

### Building Editing (Phase 2)
- Edit building properties (name, height, address, type)
- Property overrides stored separately from OSM data
- Revert to original OSM data at any time
- Custom mesh upload support

### Mesh Editor (Phase 3)
- In-browser 3D geometry editing
- Vertex and face selection modes
- Transform tools (move, rotate, scale)
- Face extrusion
- Material editing with texture support
- Export to GLB format
- Save custom meshes to API

## Project Structure

```
blyth-twin/
├── apps/
│   └── viewer/              # Three.js web viewer
│       ├── src/
│       │   ├── main.ts              # Entry point
│       │   ├── scene-setup.ts       # Three.js scene
│       │   ├── asset-loader.ts      # GLB/texture loading
│       │   ├── selection.ts         # Building selection
│       │   ├── mesh-preview.ts      # Building preview window
│       │   ├── mesh-editor/         # In-browser mesh editor
│       │   │   ├── editor-state.ts  # State management
│       │   │   ├── editor-ui.ts     # Toolbar and panels
│       │   │   ├── tools/           # Selection, transform, extrude
│       │   │   ├── geometry/        # Geometry utilities
│       │   │   ├── materials/       # Material editing
│       │   │   └── export/          # GLB export
│       │   ├── edit-mode.ts         # Edit mode state
│       │   ├── edit-panel.ts        # Property edit form
│       │   ├── api-client.ts        # API client
│       │   └── mesh-upload.ts       # Mesh upload UI
│       └── public/
├── api/                     # FastAPI backend
│   ├── main.py              # FastAPI app
│   ├── db.py                # PostGIS connection
│   ├── auth.py              # API key authentication
│   ├── models/              # Pydantic models
│   └── routers/             # API endpoints
│       ├── buildings.py     # Building CRUD
│       ├── meshes.py        # Custom mesh management
│       └── export.py        # Export triggers
├── pipeline/
│   ├── config/              # AOI and settings
│   ├── scripts/             # Python processing scripts
│   ├── schema/              # Database migrations
│   ├── Makefile             # Build automation
│   └── requirements.txt     # Python dependencies
├── data/
│   ├── raw/                 # Source data (LiDAR, OSM)
│   ├── interim/             # Intermediate processing
│   └── processed/           # Final outputs
└── dist/
    └── viewer/              # Built web assets
```

## Prerequisites

- Python 3.10+
- Node.js 18+
- pnpm
- PostgreSQL 14+ with PostGIS extension

## Quick Start

### 1. Set up Python environment

```bash
cd pipeline
make setup
```

### 2. Set up PostgreSQL/PostGIS

```bash
# Create database
createdb blyth_twin
psql -d blyth_twin -c "CREATE EXTENSION postgis;"

# Run migrations
psql -d blyth_twin -f pipeline/schema/migrations/001_create_overrides_tables.sql
```

### 3. Generate AOI boundaries

```bash
make aoi
```

### 4. Download LiDAR data (manual)

Follow the instructions in `pipeline/scripts/10_fetch_lidar.md` to download DTM and DSM tiles from the Environment Agency.

### 5. Fetch OSM data and migrate to PostGIS

```bash
make fetch_osm
cd pipeline && python scripts/21_migrate_to_postgis.py
```

### 6. Process LiDAR and compute building heights

```bash
make process
cd pipeline && python scripts/50_building_heights.py
```

### 7. Export buildings and generate meshes

```bash
cd pipeline
python scripts/51_export_buildings.py
python scripts/60_generate_meshes.py
python scripts/65_generate_footprints.py
python scripts/70_pack_assets.py
```

### 8. Start the API server

```bash
cd api
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 9. Run the viewer

```bash
cd apps/viewer
pnpm install
pnpm dev
```

## Pipeline Scripts

| Script | Description |
|--------|-------------|
| `00_aoi.py` | Generate AOI boundary GeoJSON files |
| `10_fetch_lidar.md` | Instructions for LiDAR download |
| `20_fetch_osm.py` | Download OSM data via Overpass API |
| `21_migrate_to_postgis.py` | Import buildings to PostGIS |
| `25_fetch_uprn.py` | Fetch UPRN data for address matching |
| `26_geocode_addresses.py` | Geocode building addresses |
| `30_prepare_rasters.py` | Merge and clip LiDAR rasters |
| `40_compute_ndsm.py` | Compute normalized DSM |
| `50_building_heights.py` | Derive building heights (updates PostGIS) |
| `51_export_buildings.py` | Export PostGIS to GeoJSON (merges overrides) |
| `52_create_facade_atlas.py` | Generate facade texture atlas |
| `60_generate_meshes.py` | Generate 3D building meshes |
| `65_generate_footprints.py` | Generate selectable building footprints |
| `70_pack_assets.py` | Package assets for web |
| `90_validate.py` | Generate validation report |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/buildings` | List buildings (paginated, spatial filter) |
| `GET` | `/api/buildings/{osm_id}` | Get building with merged overrides |
| `PATCH` | `/api/buildings/{osm_id}` | Update building (creates/updates override) |
| `DELETE` | `/api/buildings/{osm_id}/override` | Remove override, revert to OSM |
| `GET` | `/api/buildings/{osm_id}/mesh` | Get custom mesh (GLB) |
| `POST` | `/api/buildings/{osm_id}/mesh` | Upload custom mesh |
| `DELETE` | `/api/buildings/{osm_id}/mesh` | Remove custom mesh |
| `POST` | `/api/export` | Trigger export pipeline |
| `GET` | `/api/export/status` | Check export progress |

## Database Schema

### buildings (OSM source data)
- `osm_id` - OpenStreetMap ID
- `geometry` - Building footprint (EPSG:27700)
- `height` - Building height in meters
- `height_source` - Source of height data
- `name`, `building_type`, `amenity`, `shop`, `office`
- `addr_*` - Address fields
- `created_at`, `updated_at`, `source`

### building_overrides (user edits)
- Stores user property edits separately from OSM data
- Uses `COALESCE` during export to merge with base data
- Preserves original OSM data for reverting

### building_meshes (custom 3D models)
- `glb_data` - Binary GLB mesh data
- `mesh_source` - Origin (user_upload, mesh_editor, etc.)
- Replaces procedural generation during export

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         PostGIS                                  │
├─────────────────────────────────────────────────────────────────┤
│  buildings (OSM source)     <── 21_migrate_to_postgis.py        │
│       │                          50_building_heights.py          │
│       │                          26_geocode_addresses.py         │
│       v                                                          │
│  building_overrides         <── API (user property edits)       │
│  building_meshes            <── API (user 3D meshes)            │
└─────────────────────────────────────────────────────────────────┘
                    │
                    v
            51_export_buildings.py (merges OSM + overrides)
                    │
                    v
            buildings_height.geojson + custom_meshes/
                    │
                    v
            60_generate_meshes.py (skips buildings with custom mesh)
            65_generate_footprints.py
                    │
                    v
            Viewer <──> API (real-time edits)
```

## Viewer Controls

### Navigation
- **Left-drag** - Orbit camera
- **Right-drag** - Pan
- **Scroll** - Zoom in/out
- **Click building** - View building info

### Mesh Editor Shortcuts
| Key | Action |
|-----|--------|
| Q | Select tool |
| W | Move tool |
| E | Rotate tool |
| R | Scale tool |
| T | Extrude tool |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+A | Select all |
| Escape | Clear selection |
| Delete | Delete selected faces |

## Building Height Priority

Heights are derived in this priority order:

1. User override (if present in building_overrides)
2. OSM `height` tag (if present)
3. OSM `building:levels` x 3.0m
4. LiDAR nDSM (90th percentile within footprint)
5. Default: 6.0m

## Environment Variables

### Viewer (`apps/viewer/.env`)
```
VITE_API_URL=http://localhost:8000/api
VITE_API_KEY=dev-api-key
```

### API (`api/.env`)
```
PGHOST=localhost
PGDATABASE=blyth_twin
PGUSER=postgres
PGPASSWORD=your_password
API_KEY=dev-api-key
```

## Data Sources

- **LiDAR:** [Environment Agency Open Data](https://environment.data.gov.uk/DefraDataDownload/?Mode=survey) (OGL v3.0)
- **Vectors:** [OpenStreetMap](https://www.openstreetmap.org/) (ODbL)
- **UPRN:** Ordnance Survey AddressBase

## Development

### Running Tests
```bash
# Viewer
cd apps/viewer && pnpm test

# API
cd api && pytest
```

### Type Checking
```bash
cd apps/viewer && pnpm tsc --noEmit
```

### Building for Production
```bash
cd apps/viewer && pnpm build
```

## License

Data licenses:
- Environment Agency LiDAR: Open Government Licence v3.0
- OpenStreetMap: Open Database License (ODbL)
