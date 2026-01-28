"""Pydantic models for building data."""

from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel, Field


class BuildingProperties(BaseModel):
    """Building properties that can be viewed and edited."""
    osm_id: int
    height: Optional[float] = None
    height_source: Optional[str] = None
    name: Optional[str] = None
    building_type: Optional[str] = Field(None, alias="building")
    amenity: Optional[str] = None
    shop: Optional[str] = None
    office: Optional[str] = None
    addr_housenumber: Optional[str] = None
    addr_housename: Optional[str] = None
    addr_street: Optional[str] = None
    addr_postcode: Optional[str] = None
    addr_city: Optional[str] = None
    addr_suburb: Optional[str] = None

    class Config:
        populate_by_name = True


class BuildingGeometry(BaseModel):
    """GeoJSON geometry for a building."""
    type: str = "Polygon"
    coordinates: list[list[list[float]]]


class BuildingResponse(BaseModel):
    """Full building response including geometry and metadata."""
    osm_id: int
    geometry: Optional[BuildingGeometry] = None
    properties: BuildingProperties
    has_override: bool = False
    has_custom_mesh: bool = False
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BuildingListItem(BaseModel):
    """Summary building info for list responses."""
    osm_id: int
    name: Optional[str] = None
    height: Optional[float] = None
    addr_street: Optional[str] = None
    has_override: bool = False
    has_custom_mesh: bool = False
    centroid: Optional[dict] = None  # {x, y} in WGS84


class BuildingListResponse(BaseModel):
    """Paginated list of buildings."""
    total: int
    page: int
    page_size: int
    buildings: list[BuildingListItem]


class BuildingUpdate(BaseModel):
    """Fields that can be updated via PATCH."""
    height: Optional[float] = None
    height_source: Optional[str] = None
    name: Optional[str] = None
    building_type: Optional[str] = None
    addr_housenumber: Optional[str] = None
    addr_street: Optional[str] = None
    addr_postcode: Optional[str] = None
    addr_city: Optional[str] = None
    edit_note: Optional[str] = None


class BuildingOverrideResponse(BaseModel):
    """Response after creating/updating an override."""
    osm_id: int
    override_id: int
    message: str
    updated_fields: list[str]
    created_at: datetime
    updated_at: datetime
