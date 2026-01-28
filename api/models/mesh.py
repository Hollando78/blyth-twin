"""Pydantic models for mesh data."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class MeshBounds(BaseModel):
    """3D bounding box for a mesh."""
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float


class MeshMetadata(BaseModel):
    """Metadata about a custom mesh."""
    osm_id: int
    vertex_count: Optional[int] = None
    face_count: Optional[int] = None
    bounds: Optional[MeshBounds] = None
    mesh_source: Optional[str] = None
    source_reference: Optional[str] = None
    has_inline_data: bool = False
    glb_url: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    created_by: Optional[str] = None


class MeshResponse(BaseModel):
    """Response for mesh GET request."""
    osm_id: int
    metadata: MeshMetadata
    download_url: str  # URL to download the GLB file


class MeshUploadResponse(BaseModel):
    """Response after uploading a mesh."""
    osm_id: int
    mesh_id: int
    message: str
    vertex_count: Optional[int] = None
    face_count: Optional[int] = None
    created_at: datetime
