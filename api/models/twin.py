"""Pydantic models for digital twin management."""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class TwinCreate(BaseModel):
    """Request to create a new digital twin."""
    name: str = Field(..., min_length=1, max_length=255)
    location_name: Optional[str] = Field(None, max_length=255)
    centre_lat: float = Field(..., ge=-90, le=90)
    centre_lon: float = Field(..., ge=-180, le=180)
    side_length_m: int = Field(default=2000, ge=500, le=10000)
    buffer_m: int = Field(default=500, ge=0, le=2000)
    use_lidar: bool = Field(default=True, description="Use LiDAR terrain data if available")


class TwinProgress(BaseModel):
    """Progress information for a twin pipeline."""
    status: str  # pending, running, completed, failed
    current_step: Optional[str] = None
    progress_pct: int = 0
    error_message: Optional[str] = None


class TwinResponse(BaseModel):
    """Full twin response."""
    id: UUID
    name: str
    location_name: Optional[str] = None
    centre_lat: float
    centre_lon: float
    side_length_m: int
    buffer_m: int
    status: str
    current_step: Optional[str] = None
    progress_pct: int
    error_message: Optional[str] = None
    has_lidar: bool
    height_source: str
    tiles_needed: list[str] = []
    output_dir: Optional[str] = None
    building_count: Optional[int] = None
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TwinListItem(BaseModel):
    """Summary twin info for list responses."""
    id: UUID
    name: str
    location_name: Optional[str] = None
    centre_lat: float
    centre_lon: float
    side_length_m: int
    status: str
    progress_pct: int
    current_step: Optional[str] = None
    has_lidar: bool
    building_count: Optional[int] = None
    created_at: datetime
    completed_at: Optional[datetime] = None


class TwinListResponse(BaseModel):
    """List of twins."""
    total: int
    twins: list[TwinListItem]


class TwinCreateResponse(BaseModel):
    """Response after creating a twin."""
    id: UUID
    name: str
    status: str
    message: str


class TwinEvent(BaseModel):
    """SSE event for twin progress updates."""
    id: UUID
    status: str
    current_step: Optional[str] = None
    progress_pct: int
    error_message: Optional[str] = None
    building_count: Optional[int] = None


class LidarTilesResponse(BaseModel):
    """Response for LiDAR tiles endpoint."""
    status: str  # awaiting_lidar, has_tiles, not_needed
    tiles_needed: list[str] = []
    tiles_present: list[str] = []
    portal_url: str = "https://environment.data.gov.uk/survey"
    instructions: str = "Download DTM 1m tiles for the listed grid references"
    upload_path: str = ""
