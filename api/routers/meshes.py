"""
Meshes API router.

Endpoints:
- GET /api/buildings/{osm_id}/mesh - Get custom mesh (GLB)
- POST /api/buildings/{osm_id}/mesh - Upload custom mesh
- DELETE /api/buildings/{osm_id}/mesh - Remove custom mesh
"""

import io
from datetime import datetime

from fastapi import APIRouter, HTTPException, UploadFile, File, Depends, Response

from ..db import get_db, get_cursor
from ..auth import verify_api_key, optional_auth
from ..models.mesh import MeshMetadata, MeshResponse, MeshUploadResponse, MeshBounds

router = APIRouter()

# Maximum mesh file size (50MB)
MAX_MESH_SIZE = 50 * 1024 * 1024


@router.get("/{osm_id}/mesh")
async def get_mesh(
    osm_id: int,
    user: str = Depends(optional_auth)
):
    """Get custom mesh metadata and download URL."""
    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("""
            SELECT
                id, osm_id,
                glb_data IS NOT NULL as has_inline_data,
                glb_url,
                vertex_count, face_count,
                bounds_min_x, bounds_min_y, bounds_min_z,
                bounds_max_x, bounds_max_y, bounds_max_z,
                mesh_source, source_reference,
                created_at, updated_at, created_by
            FROM building_meshes
            WHERE osm_id = %s
        """, (osm_id,))
        row = cur.fetchone()
        cur.close()

        if not row:
            raise HTTPException(404, f"No custom mesh found for building {osm_id}")

        bounds = None
        if row['bounds_min_x'] is not None:
            bounds = MeshBounds(
                min_x=row['bounds_min_x'],
                min_y=row['bounds_min_y'],
                min_z=row['bounds_min_z'],
                max_x=row['bounds_max_x'],
                max_y=row['bounds_max_y'],
                max_z=row['bounds_max_z']
            )

        metadata = MeshMetadata(
            osm_id=row['osm_id'],
            vertex_count=row['vertex_count'],
            face_count=row['face_count'],
            bounds=bounds,
            mesh_source=row['mesh_source'],
            source_reference=row['source_reference'],
            has_inline_data=row['has_inline_data'],
            glb_url=row['glb_url'],
            created_at=row['created_at'],
            updated_at=row['updated_at'],
            created_by=row['created_by']
        )

        # Determine download URL
        if row['has_inline_data']:
            download_url = f"/api/buildings/{osm_id}/mesh/download"
        elif row['glb_url']:
            download_url = row['glb_url']
        else:
            download_url = None

        return MeshResponse(
            osm_id=row['osm_id'],
            metadata=metadata,
            download_url=download_url
        )


@router.get("/{osm_id}/mesh/download")
async def download_mesh(
    osm_id: int,
    user: str = Depends(optional_auth)
):
    """Download the actual GLB file for a custom mesh."""
    with get_db() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT glb_data, glb_url
            FROM building_meshes
            WHERE osm_id = %s
        """, (osm_id,))
        row = cur.fetchone()
        cur.close()

        if not row:
            raise HTTPException(404, f"No custom mesh found for building {osm_id}")

        glb_data, glb_url = row

        if glb_data:
            return Response(
                content=bytes(glb_data),
                media_type="model/gltf-binary",
                headers={
                    "Content-Disposition": f"attachment; filename=building_{osm_id}.glb"
                }
            )
        elif glb_url:
            # Redirect to external URL
            return Response(
                status_code=302,
                headers={"Location": glb_url}
            )
        else:
            raise HTTPException(404, "Mesh has no data")


@router.post("/{osm_id}/mesh", response_model=MeshUploadResponse)
async def upload_mesh(
    osm_id: int,
    file: UploadFile = File(..., description="GLB file to upload"),
    mesh_source: str = "user_upload",
    source_reference: str = None,
    user: str = Depends(verify_api_key)
):
    """Upload a custom mesh for a building."""
    # Validate file type
    if not file.filename.lower().endswith('.glb'):
        raise HTTPException(400, "Only GLB files are supported")

    # Read file content
    content = await file.read()
    if len(content) > MAX_MESH_SIZE:
        raise HTTPException(400, f"File too large. Maximum size is {MAX_MESH_SIZE // (1024*1024)}MB")

    # Basic GLB validation (check magic number)
    if len(content) < 12 or content[:4] != b'glTF':
        raise HTTPException(400, "Invalid GLB file")

    # Parse GLB header for basic metadata
    import struct
    version = struct.unpack('<I', content[4:8])[0]
    if version != 2:
        raise HTTPException(400, f"Unsupported glTF version: {version}")

    with get_db() as conn:
        cur = get_cursor(conn)

        # Verify building exists
        cur.execute("SELECT osm_id FROM buildings WHERE osm_id = %s", (osm_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"Building {osm_id} not found")

        # Check if mesh already exists
        cur.execute("SELECT id FROM building_meshes WHERE osm_id = %s", (osm_id,))
        existing = cur.fetchone()

        # Try to extract mesh stats using trimesh
        vertex_count = None
        face_count = None
        bounds = {}

        try:
            import trimesh
            mesh = trimesh.load(io.BytesIO(content), file_type='glb')
            if hasattr(mesh, 'vertices'):
                vertex_count = len(mesh.vertices)
                face_count = len(mesh.faces) if hasattr(mesh, 'faces') else None
                if hasattr(mesh, 'bounds'):
                    bounds = {
                        'bounds_min_x': float(mesh.bounds[0][0]),
                        'bounds_min_y': float(mesh.bounds[0][1]),
                        'bounds_min_z': float(mesh.bounds[0][2]),
                        'bounds_max_x': float(mesh.bounds[1][0]),
                        'bounds_max_y': float(mesh.bounds[1][1]),
                        'bounds_max_z': float(mesh.bounds[1][2])
                    }
        except Exception:
            pass

        if existing:
            # Update existing mesh
            cur.execute("""
                UPDATE building_meshes
                SET glb_data = %s,
                    glb_url = NULL,
                    vertex_count = %s,
                    face_count = %s,
                    bounds_min_x = %s, bounds_min_y = %s, bounds_min_z = %s,
                    bounds_max_x = %s, bounds_max_y = %s, bounds_max_z = %s,
                    mesh_source = %s,
                    source_reference = %s,
                    updated_at = NOW()
                WHERE osm_id = %s
                RETURNING id, created_at
            """, (
                content, vertex_count, face_count,
                bounds.get('bounds_min_x'), bounds.get('bounds_min_y'), bounds.get('bounds_min_z'),
                bounds.get('bounds_max_x'), bounds.get('bounds_max_y'), bounds.get('bounds_max_z'),
                mesh_source, source_reference, osm_id
            ))
            result = cur.fetchone()
            message = "Mesh updated"
        else:
            # Create new mesh
            cur.execute("""
                INSERT INTO building_meshes (
                    osm_id, glb_data, vertex_count, face_count,
                    bounds_min_x, bounds_min_y, bounds_min_z,
                    bounds_max_x, bounds_max_y, bounds_max_z,
                    mesh_source, source_reference, created_by
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, created_at
            """, (
                osm_id, content, vertex_count, face_count,
                bounds.get('bounds_min_x'), bounds.get('bounds_min_y'), bounds.get('bounds_min_z'),
                bounds.get('bounds_max_x'), bounds.get('bounds_max_y'), bounds.get('bounds_max_z'),
                mesh_source, source_reference, user
            ))
            result = cur.fetchone()
            message = "Mesh uploaded"

        cur.close()

        return MeshUploadResponse(
            osm_id=osm_id,
            mesh_id=result['id'],
            message=message,
            vertex_count=vertex_count,
            face_count=face_count,
            created_at=result['created_at']
        )


@router.delete("/{osm_id}/mesh")
async def delete_mesh(
    osm_id: int,
    user: str = Depends(verify_api_key)
):
    """Remove custom mesh for a building."""
    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("""
            DELETE FROM building_meshes
            WHERE osm_id = %s
            RETURNING id
        """, (osm_id,))
        result = cur.fetchone()
        cur.close()

        if not result:
            raise HTTPException(404, f"No custom mesh found for building {osm_id}")

        return {
            "osm_id": osm_id,
            "message": "Custom mesh removed"
        }
