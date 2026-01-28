# Blyth Digital Twin API

FastAPI backend for the Blyth Digital Twin project, providing building data management and custom mesh storage.

## Features

- **Building CRUD** - Read and update building properties
- **Override System** - User edits stored separately from OSM data
- **Custom Meshes** - Store and retrieve user-uploaded 3D models
- **Export Pipeline** - Trigger data export for mesh regeneration
- **API Key Auth** - Simple authentication for all endpoints

## Quick Start

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows

# Install dependencies
pip install -r requirements.txt

# Start server
uvicorn main:app --reload --port 8000
```

## Project Structure

```
api/
├── main.py              # FastAPI application and middleware
├── db.py                # PostGIS database connection
├── auth.py              # API key authentication
├── requirements.txt     # Python dependencies
│
├── models/
│   └── building.py      # Pydantic models for requests/responses
│
└── routers/
    ├── buildings.py     # Building CRUD endpoints
    ├── meshes.py        # Custom mesh endpoints
    └── export.py        # Export pipeline endpoints
```

## Configuration

Environment variables (create `.env` file):

```env
# Database
PGHOST=localhost
PGDATABASE=blyth_twin
PGUSER=postgres
PGPASSWORD=your_password

# Authentication
API_KEY=your-api-key
```

## API Endpoints

### Buildings

#### List Buildings
```http
GET /api/buildings
```

Query parameters:
- `limit` (int, default 100) - Max results
- `offset` (int, default 0) - Pagination offset
- `bbox` (string) - Bounding box filter "minx,miny,maxx,maxy"

Response:
```json
{
  "buildings": [
    {
      "osm_id": 123456789,
      "properties": {
        "name": "Building Name",
        "height": 12.5,
        "addr_street": "High Street"
      },
      "has_override": false,
      "has_custom_mesh": false
    }
  ],
  "total": 17000,
  "limit": 100,
  "offset": 0
}
```

#### Get Building
```http
GET /api/buildings/{osm_id}
```

Returns building with merged override data (if exists).

Response:
```json
{
  "osm_id": 123456789,
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[...]]]
  },
  "properties": {
    "name": "Building Name",
    "height": 12.5,
    "height_source": "lidar",
    "building": "retail",
    "addr_housenumber": "42",
    "addr_street": "High Street",
    "addr_postcode": "NE24 1AB"
  },
  "has_override": true,
  "has_custom_mesh": false,
  "updated_at": "2024-01-15T10:30:00Z"
}
```

#### Update Building
```http
PATCH /api/buildings/{osm_id}
```

Creates or updates a building override.

Request body:
```json
{
  "name": "New Building Name",
  "height": 15.0,
  "height_source": "user",
  "addr_street": "New Street",
  "edit_note": "Corrected height from site survey"
}
```

Response:
```json
{
  "osm_id": 123456789,
  "override_id": 42,
  "message": "Override created",
  "updated_fields": ["name", "height", "height_source", "addr_street"],
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

#### Delete Override
```http
DELETE /api/buildings/{osm_id}/override
```

Removes user override, reverting to original OSM data.

Response:
```json
{
  "message": "Override deleted, reverted to OSM data"
}
```

### Custom Meshes

#### Get Mesh Metadata
```http
GET /api/buildings/{osm_id}/mesh
```

Returns 404 if no custom mesh exists.

Response:
```json
{
  "osm_id": 123456789,
  "vertex_count": 1234,
  "face_count": 2000,
  "mesh_source": "mesh_editor",
  "created_at": "2024-01-15T10:30:00Z"
}
```

#### Download Mesh
```http
GET /api/buildings/{osm_id}/mesh/download
```

Returns GLB binary file.

Headers:
```
Content-Type: model/gltf-binary
Content-Disposition: attachment; filename="building_123456789.glb"
```

#### Upload Mesh
```http
POST /api/buildings/{osm_id}/mesh
```

Multipart form upload.

Query parameters:
- `mesh_source` (string, default "user_upload") - Origin identifier

Form data:
- `file` - GLB binary file

Response:
```json
{
  "osm_id": 123456789,
  "mesh_id": 42,
  "message": "Mesh uploaded successfully"
}
```

#### Delete Mesh
```http
DELETE /api/buildings/{osm_id}/mesh
```

Response:
```json
{
  "message": "Custom mesh deleted"
}
```

### Export Pipeline

#### Trigger Export
```http
POST /api/export
```

Triggers the export pipeline to regenerate GeoJSON from PostGIS.

Response:
```json
{
  "message": "Export started",
  "status_url": "/api/export/status"
}
```

#### Check Export Status
```http
GET /api/export/status
```

Response:
```json
{
  "status": "running",
  "started_at": "2024-01-15T10:30:00Z",
  "completed_at": null,
  "error": null
}
```

Status values: `idle`, `running`, `completed`, `error`

## Authentication

All endpoints require an API key header:

```http
X-API-Key: your-api-key
```

The health endpoint is public:
```http
GET /health
```

## Database Schema

### buildings
Primary building data from OSM.

```sql
CREATE TABLE buildings (
    id SERIAL PRIMARY KEY,
    osm_id BIGINT UNIQUE NOT NULL,
    geometry GEOMETRY(Polygon, 27700),
    height REAL,
    height_source VARCHAR(50),
    levels INTEGER,
    building_type VARCHAR(100),
    name VARCHAR(255),
    amenity VARCHAR(100),
    shop VARCHAR(100),
    office VARCHAR(100),
    addr_housenumber VARCHAR(50),
    addr_housename VARCHAR(255),
    addr_street VARCHAR(255),
    addr_postcode VARCHAR(20),
    addr_city VARCHAR(100),
    addr_suburb VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    source VARCHAR(20) DEFAULT 'osm'
);
```

### building_overrides
User property edits, merged with buildings during export.

```sql
CREATE TABLE building_overrides (
    id SERIAL PRIMARY KEY,
    osm_id BIGINT NOT NULL UNIQUE,
    height REAL,
    height_source VARCHAR(50),
    name VARCHAR(255),
    building_type VARCHAR(100),
    addr_housenumber VARCHAR(50),
    addr_street VARCHAR(255),
    addr_postcode VARCHAR(20),
    addr_city VARCHAR(100),
    geometry GEOMETRY(Polygon, 27700),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by VARCHAR(100),
    edit_note TEXT,
    FOREIGN KEY (osm_id) REFERENCES buildings(osm_id)
);
```

### building_meshes
Custom 3D models uploaded by users.

```sql
CREATE TABLE building_meshes (
    id SERIAL PRIMARY KEY,
    osm_id BIGINT NOT NULL UNIQUE,
    glb_data BYTEA,
    glb_url VARCHAR(500),
    vertex_count INTEGER,
    face_count INTEGER,
    bounds_min GEOMETRY(PointZ, 27700),
    bounds_max GEOMETRY(PointZ, 27700),
    mesh_source VARCHAR(50),
    source_reference VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    created_by VARCHAR(100),
    FOREIGN KEY (osm_id) REFERENCES buildings(osm_id)
);
```

## Error Responses

All errors return JSON with `detail` field:

```json
{
  "detail": "Building not found"
}
```

HTTP status codes:
- `400` - Bad request (invalid parameters)
- `401` - Unauthorized (missing/invalid API key)
- `404` - Not found
- `500` - Internal server error

## Development

### Running Tests
```bash
pytest
```

### API Documentation

Interactive docs available at:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### Adding New Endpoints

1. Create router file in `routers/`
2. Define Pydantic models in `models/`
3. Register router in `main.py`
4. Add tests in `tests/`

## CORS Configuration

CORS is enabled for:
- `http://localhost:5173` (Vite dev server)
- `http://localhost:3000`
- `http://127.0.0.1:5173`

Add additional origins in `main.py`.
