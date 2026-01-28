"""
Buildings API router.

Endpoints:
- GET /api/buildings - List buildings (paginated, spatial filter)
- GET /api/buildings/{osm_id} - Get building with merged overrides
- PATCH /api/buildings/{osm_id} - Update building (creates/updates override)
- DELETE /api/buildings/{osm_id}/override - Remove override, revert to OSM
"""

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Depends

from ..db import get_db, get_cursor
from ..auth import verify_api_key, optional_auth
from ..models.building import (
    BuildingResponse,
    BuildingListResponse,
    BuildingListItem,
    BuildingUpdate,
    BuildingOverrideResponse,
    BuildingProperties,
    BuildingGeometry
)

router = APIRouter()


@router.get("", response_model=BuildingListResponse)
async def list_buildings(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=500, description="Items per page"),
    bbox: Optional[str] = Query(None, description="Bounding box: min_lon,min_lat,max_lon,max_lat"),
    search: Optional[str] = Query(None, description="Search by name or address"),
    has_override: Optional[bool] = Query(None, description="Filter by override status"),
    has_custom_mesh: Optional[bool] = Query(None, description="Filter by custom mesh status"),
    user: Optional[str] = Depends(optional_auth)
):
    """List buildings with pagination and optional filters."""
    with get_db() as conn:
        cur = get_cursor(conn)

        # Build WHERE clause
        conditions = ["b.geometry IS NOT NULL"]
        params = []

        if bbox:
            try:
                min_lon, min_lat, max_lon, max_lat = map(float, bbox.split(","))
                conditions.append("""
                    ST_Intersects(
                        b.geometry,
                        ST_Transform(
                            ST_MakeEnvelope(%s, %s, %s, %s, 4326),
                            27700
                        )
                    )
                """)
                params.extend([min_lon, min_lat, max_lon, max_lat])
            except ValueError:
                raise HTTPException(400, "Invalid bbox format. Use: min_lon,min_lat,max_lon,max_lat")

        if search:
            conditions.append("""
                (b.name ILIKE %s OR b.addr_street ILIKE %s OR b.addr_housenumber ILIKE %s)
            """)
            search_pattern = f"%{search}%"
            params.extend([search_pattern, search_pattern, search_pattern])

        # Check if override tables exist
        cur.execute("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables WHERE table_name = 'building_overrides'
            )
        """)
        has_override_table = cur.fetchone()['exists']

        cur.execute("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables WHERE table_name = 'building_meshes'
            )
        """)
        has_mesh_table = cur.fetchone()['exists']

        # Build join and select based on available tables
        override_join = ""
        mesh_join = ""
        override_select = "FALSE as has_override"
        mesh_select = "FALSE as has_custom_mesh"

        if has_override_table:
            override_join = "LEFT JOIN building_overrides o ON b.osm_id = o.osm_id"
            override_select = "(o.id IS NOT NULL) as has_override"
            if has_override is not None:
                if has_override:
                    conditions.append("o.id IS NOT NULL")
                else:
                    conditions.append("o.id IS NULL")

        if has_mesh_table:
            mesh_join = "LEFT JOIN building_meshes m ON b.osm_id = m.osm_id"
            mesh_select = "(m.id IS NOT NULL) as has_custom_mesh"
            if has_custom_mesh is not None:
                if has_custom_mesh:
                    conditions.append("m.id IS NOT NULL")
                else:
                    conditions.append("m.id IS NULL")

        where_clause = " AND ".join(conditions)

        # Count total
        count_query = f"""
            SELECT COUNT(*)
            FROM buildings b
            {override_join}
            {mesh_join}
            WHERE {where_clause}
        """
        cur.execute(count_query, params)
        total = cur.fetchone()['count']

        # Get page of results
        offset = (page - 1) * page_size
        query = f"""
            SELECT
                b.osm_id,
                COALESCE(o.name, b.name) as name,
                COALESCE(o.height, b.height) as height,
                COALESCE(o.addr_street, b.addr_street) as addr_street,
                {override_select},
                {mesh_select},
                ST_AsGeoJSON(ST_Transform(ST_Centroid(b.geometry), 4326))::json as centroid
            FROM buildings b
            {override_join}
            {mesh_join}
            WHERE {where_clause}
            ORDER BY b.id
            LIMIT %s OFFSET %s
        """
        cur.execute(query, params + [page_size, offset])

        buildings = []
        for row in cur.fetchall():
            centroid = None
            if row['centroid']:
                coords = row['centroid'].get('coordinates', [])
                if len(coords) >= 2:
                    centroid = {"x": coords[0], "y": coords[1]}

            buildings.append(BuildingListItem(
                osm_id=row['osm_id'],
                name=row['name'],
                height=row['height'],
                addr_street=row['addr_street'],
                has_override=row['has_override'],
                has_custom_mesh=row['has_custom_mesh'],
                centroid=centroid
            ))

        cur.close()

        return BuildingListResponse(
            total=total,
            page=page,
            page_size=page_size,
            buildings=buildings
        )


@router.get("/{osm_id}", response_model=BuildingResponse)
async def get_building(
    osm_id: int,
    user: Optional[str] = Depends(optional_auth)
):
    """Get a single building with merged overrides."""
    with get_db() as conn:
        cur = get_cursor(conn)

        # Check if override tables exist
        cur.execute("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables WHERE table_name = 'building_overrides'
            )
        """)
        has_override_table = cur.fetchone()['exists']

        cur.execute("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables WHERE table_name = 'building_meshes'
            )
        """)
        has_mesh_table = cur.fetchone()['exists']

        # Build query based on available tables
        if has_override_table and has_mesh_table:
            query = """
                SELECT
                    b.osm_id,
                    ST_AsGeoJSON(ST_Transform(
                        COALESCE(o.geometry, b.geometry), 4326
                    ))::json as geometry,
                    COALESCE(o.height, b.height) as height,
                    COALESCE(o.height_source, b.height_source) as height_source,
                    COALESCE(o.name, b.name) as name,
                    COALESCE(o.building_type, b.building_type) as building_type,
                    b.amenity,
                    b.shop,
                    b.office,
                    COALESCE(o.addr_housenumber, b.addr_housenumber) as addr_housenumber,
                    b.addr_housename,
                    COALESCE(o.addr_street, b.addr_street) as addr_street,
                    COALESCE(o.addr_postcode, b.addr_postcode) as addr_postcode,
                    COALESCE(o.addr_city, b.addr_city) as addr_city,
                    b.addr_suburb,
                    (o.id IS NOT NULL) as has_override,
                    (m.id IS NOT NULL) as has_custom_mesh,
                    GREATEST(b.updated_at, o.updated_at) as updated_at
                FROM buildings b
                LEFT JOIN building_overrides o ON b.osm_id = o.osm_id
                LEFT JOIN building_meshes m ON b.osm_id = m.osm_id
                WHERE b.osm_id = %s
            """
        elif has_override_table:
            query = """
                SELECT
                    b.osm_id,
                    ST_AsGeoJSON(ST_Transform(
                        COALESCE(o.geometry, b.geometry), 4326
                    ))::json as geometry,
                    COALESCE(o.height, b.height) as height,
                    COALESCE(o.height_source, b.height_source) as height_source,
                    COALESCE(o.name, b.name) as name,
                    COALESCE(o.building_type, b.building_type) as building_type,
                    b.amenity,
                    b.shop,
                    b.office,
                    COALESCE(o.addr_housenumber, b.addr_housenumber) as addr_housenumber,
                    b.addr_housename,
                    COALESCE(o.addr_street, b.addr_street) as addr_street,
                    COALESCE(o.addr_postcode, b.addr_postcode) as addr_postcode,
                    COALESCE(o.addr_city, b.addr_city) as addr_city,
                    b.addr_suburb,
                    (o.id IS NOT NULL) as has_override,
                    FALSE as has_custom_mesh,
                    GREATEST(b.updated_at, o.updated_at) as updated_at
                FROM buildings b
                LEFT JOIN building_overrides o ON b.osm_id = o.osm_id
                WHERE b.osm_id = %s
            """
        else:
            query = """
                SELECT
                    b.osm_id,
                    ST_AsGeoJSON(ST_Transform(b.geometry, 4326))::json as geometry,
                    b.height,
                    b.height_source,
                    b.name,
                    b.building_type,
                    b.amenity,
                    b.shop,
                    b.office,
                    b.addr_housenumber,
                    b.addr_housename,
                    b.addr_street,
                    b.addr_postcode,
                    b.addr_city,
                    b.addr_suburb,
                    FALSE as has_override,
                    FALSE as has_custom_mesh,
                    b.updated_at
                FROM buildings b
                WHERE b.osm_id = %s
            """

        cur.execute(query, (osm_id,))
        row = cur.fetchone()
        cur.close()

        if not row:
            raise HTTPException(404, f"Building {osm_id} not found")

        # Parse geometry
        geometry = None
        if row['geometry']:
            geometry = BuildingGeometry(
                type=row['geometry']['type'],
                coordinates=row['geometry']['coordinates']
            )

        return BuildingResponse(
            osm_id=row['osm_id'],
            geometry=geometry,
            properties=BuildingProperties(
                osm_id=row['osm_id'],
                height=row['height'],
                height_source=row['height_source'],
                name=row['name'],
                building_type=row['building_type'],
                amenity=row['amenity'],
                shop=row['shop'],
                office=row['office'],
                addr_housenumber=row['addr_housenumber'],
                addr_housename=row['addr_housename'],
                addr_street=row['addr_street'],
                addr_postcode=row['addr_postcode'],
                addr_city=row['addr_city'],
                addr_suburb=row['addr_suburb']
            ),
            has_override=row['has_override'],
            has_custom_mesh=row['has_custom_mesh'],
            updated_at=row['updated_at']
        )


@router.patch("/{osm_id}", response_model=BuildingOverrideResponse)
async def update_building(
    osm_id: int,
    update: BuildingUpdate,
    user: str = Depends(verify_api_key)
):
    """Update a building by creating or updating an override."""
    with get_db() as conn:
        cur = get_cursor(conn)

        # Verify building exists
        cur.execute("SELECT id FROM buildings WHERE osm_id = %s", (osm_id,))
        building = cur.fetchone()
        if not building:
            raise HTTPException(404, f"Building {osm_id} not found")

        building_id = building['id']

        # Get update data (exclude None values)
        update_data = update.model_dump(exclude_none=True)
        if not update_data:
            raise HTTPException(400, "No fields to update")

        # Check if override exists
        cur.execute("SELECT id FROM building_overrides WHERE osm_id = %s", (osm_id,))
        existing = cur.fetchone()

        if existing:
            # Update existing override
            set_clauses = []
            values = []
            for key, value in update_data.items():
                set_clauses.append(f"{key} = %s")
                values.append(value)

            set_clauses.append("updated_at = NOW()")
            values.append(osm_id)

            cur.execute(f"""
                UPDATE building_overrides
                SET {', '.join(set_clauses)}
                WHERE osm_id = %s
                RETURNING id, created_at, updated_at
            """, values)
            result = cur.fetchone()
            message = "Override updated"
        else:
            # Create new override
            columns = ["osm_id", "building_id", "created_by"] + list(update_data.keys())
            placeholders = ["%s"] * len(columns)
            values = [osm_id, building_id, user] + list(update_data.values())

            cur.execute(f"""
                INSERT INTO building_overrides ({', '.join(columns)})
                VALUES ({', '.join(placeholders)})
                RETURNING id, created_at, updated_at
            """, values)
            result = cur.fetchone()
            message = "Override created"

        cur.close()

        return BuildingOverrideResponse(
            osm_id=osm_id,
            override_id=result['id'],
            message=message,
            updated_fields=list(update_data.keys()),
            created_at=result['created_at'],
            updated_at=result['updated_at']
        )


@router.delete("/{osm_id}/override")
async def delete_override(
    osm_id: int,
    user: str = Depends(verify_api_key)
):
    """Remove override, reverting building to OSM data."""
    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("""
            DELETE FROM building_overrides
            WHERE osm_id = %s
            RETURNING id
        """, (osm_id,))
        result = cur.fetchone()
        cur.close()

        if not result:
            raise HTTPException(404, f"No override found for building {osm_id}")

        return {
            "osm_id": osm_id,
            "message": "Override removed, building reverted to OSM data"
        }
