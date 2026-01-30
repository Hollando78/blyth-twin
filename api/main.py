"""
Blyth Digital Twin API

FastAPI backend for the digital twin viewer.
Provides endpoints for building data, user edits, and custom meshes.

Run with:
    uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .db import init_db, close_db
from .routers import buildings, meshes, export, twins

# Project paths
PROJECT_ROOT = Path(__file__).parent.parent
DIST_TWINS_DIR = PROJECT_ROOT / "dist" / "twins"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle."""
    # Startup
    init_db()
    yield
    # Shutdown
    close_db()


app = FastAPI(
    title="Blyth Digital Twin API",
    description="API for building data, user edits, and custom meshes",
    version="1.0.0",
    lifespan=lifespan
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to your viewer's origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(buildings.router, prefix="/api/buildings", tags=["buildings"])
app.include_router(meshes.router, prefix="/api/buildings", tags=["meshes"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(twins.router, prefix="/api/twins", tags=["twins"])

# Serve twin assets as static files
if DIST_TWINS_DIR.exists():
    app.mount("/twins", StaticFiles(directory=str(DIST_TWINS_DIR)), name="twins")


@app.get("/api/meshes", tags=["meshes"])
async def list_custom_meshes():
    """List all OSM IDs that have custom meshes."""
    from .db import get_db, get_cursor

    with get_db() as conn:
        cur = get_cursor(conn)
        cur.execute("SELECT osm_id FROM building_meshes ORDER BY osm_id")
        rows = cur.fetchall()
        cur.close()
        return {"osm_ids": [row['osm_id'] for row in rows]}


@app.get("/")
async def root():
    """API root endpoint."""
    return {
        "name": "Blyth Digital Twin API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "buildings": "/api/buildings",
            "export": "/api/export",
            "twins": "/api/twins"
        }
    }


@app.get("/health")
async def health():
    """Health check endpoint."""
    from .db import get_db, get_cursor
    try:
        with get_db() as conn:
            cur = get_cursor(conn)
            cur.execute("SELECT 1")
            cur.close()
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        return {"status": "unhealthy", "database": str(e)}
