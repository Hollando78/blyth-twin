# Blyth Digital Twin

A web-first digital twin MVP for Blyth, Northumberland.

## Overview

This project creates a browser-based 3D model of Blyth using:

- **LiDAR data** from Environment Agency for terrain and building heights
- **OpenStreetMap** for building footprints and vector features
- **Three.js** for web-based 3D rendering

### Area of Interest

- **Centre:** Broadway Circle (NE24 2PG)
- **Size:** 5km × 5km square
- **Coordinate System:** EPSG:27700 (British National Grid)

## Project Structure

```
blyth-twin/
├── apps/
│   └── viewer/          # Three.js web viewer
├── pipeline/
│   ├── config/          # AOI and settings
│   ├── scripts/         # Python processing scripts
│   ├── Makefile         # Build automation
│   └── requirements.txt # Python dependencies
├── data/
│   ├── raw/             # Source data (LiDAR, OSM)
│   ├── interim/         # Intermediate processing
│   └── processed/       # Final outputs
└── dist/
    └── blyth_mvp_v1/    # Packaged assets for web
```

## Prerequisites

- Python 3.10+
- Node.js 18+
- pnpm

## Quick Start

### 1. Set up Python environment

```bash
cd pipeline
make setup
```

### 2. Generate AOI boundaries

```bash
make aoi
```

### 3. Download LiDAR data (manual)

Follow the instructions in `pipeline/scripts/10_fetch_lidar.md` to download DTM and DSM tiles from the Environment Agency.

### 4. Fetch OSM data

```bash
make fetch_osm
```

### 5. Process LiDAR (after downloading tiles)

```bash
make process
```

### 6. Pack assets

```bash
make pack
```

### 7. Run the viewer

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
| `30_prepare_rasters.py` | Merge and clip LiDAR rasters |
| `40_compute_ndsm.py` | Compute normalized DSM |
| `50_building_heights.py` | Derive building heights |
| `60_generate_meshes.py` | Generate 3D meshes |
| `65_generate_footprints.py` | Generate selectable building footprints |
| `70_pack_assets.py` | Package assets for web |
| `90_validate.py` | Generate validation report |

## Data Sources

- **LiDAR:** [Environment Agency Open Data](https://environment.data.gov.uk/DefraDataDownload/?Mode=survey) (OGL v3.0)
- **Vectors:** [OpenStreetMap](https://www.openstreetmap.org/) (ODbL)

## Building Height Priority

Heights are derived in this priority order:

1. OSM `height` tag (if present)
2. OSM `building:levels` × 3.0m
3. LiDAR nDSM (90th percentile within footprint)
4. Default: 6.0m

## Viewer Controls

- **Drag** - Orbit camera
- **Right-drag** - Pan
- **Scroll** - Zoom in/out
- **Click building** - View building info

## Building Selection

Click on any building to view its metadata including:
- Name and type
- Address and postcode
- Building height (from LiDAR)

The footprints layer provides per-building identity via face-to-building mapping, enabling efficient raycasting across 17k+ buildings.

## License

Data licenses:

- Environment Agency LiDAR: Open Government Licence v3.0
- OpenStreetMap: Open Database License (ODbL)
