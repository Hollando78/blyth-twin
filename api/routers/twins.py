"""
Twins API router.

Endpoints:
- POST /api/twins - Create a new twin, queue pipeline
- GET /api/twins - List all twins
- GET /api/twins/{id} - Get twin details
- DELETE /api/twins/{id} - Delete twin and its data
- GET /api/twins/{id}/events - SSE progress stream
"""

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..db import get_db, get_cursor
from ..models.twin import (
    TwinCreate,
    TwinResponse,
    TwinListResponse,
    TwinListItem,
    TwinCreateResponse,
    TwinEvent,
    LidarTilesResponse,
)

router = APIRouter()

# Base paths for twin data
PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data" / "twins"
DIST_DIR = PROJECT_ROOT / "dist" / "twins"
PIPELINE_DIR = PROJECT_ROOT / "pipeline"


def run_pipeline(twin_id: str):
    """Run the pipeline for a twin in a subprocess."""
    script_path = PIPELINE_DIR / "scripts" / "run_pipeline.py"
    pipeline_python = PIPELINE_DIR / ".venv" / "bin" / "python"

    # Fall back to system python if pipeline venv doesn't exist
    if not pipeline_python.exists():
        import sys
        pipeline_python = sys.executable

    env = os.environ.copy()
    env["PYTHONPATH"] = str(PIPELINE_DIR)

    subprocess.Popen(
        [str(pipeline_python), str(script_path), "--twin-id", twin_id],
        env=env,
        cwd=str(PIPELINE_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )


@router.post("", response_model=TwinCreateResponse)
async def create_twin(
    twin: TwinCreate,
    background_tasks: BackgroundTasks
):
    """Create a new digital twin and queue the pipeline."""
    with get_db() as conn:
        cur = get_cursor(conn)

        # Create the twin record
        cur.execute("""
            INSERT INTO twins (
                name, location_name,
                centre_lat, centre_lon,
                side_length_m, buffer_m,
                use_lidar,
                status
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending')
            RETURNING id, name, status
        """, (
            twin.name,
            twin.location_name,
            twin.centre_lat,
            twin.centre_lon,
            twin.side_length_m,
            twin.buffer_m,
            twin.use_lidar
        ))

        result = cur.fetchone()
        twin_id = str(result['id'])

        # Create twin directories
        twin_data_dir = DATA_DIR / twin_id
        twin_dist_dir = DIST_DIR / twin_id
        twin_data_dir.mkdir(parents=True, exist_ok=True)
        twin_dist_dir.mkdir(parents=True, exist_ok=True)

        # Update output_dir in database
        cur.execute("""
            UPDATE twins SET output_dir = %s WHERE id = %s
        """, (f"twins/{twin_id}", result['id']))

        cur.close()

        # Queue the pipeline in background
        background_tasks.add_task(run_pipeline, twin_id)

        return TwinCreateResponse(
            id=result['id'],
            name=result['name'],
            status=result['status'],
            message="Twin created and pipeline queued"
        )


@router.get("", response_model=TwinListResponse)
async def list_twins(
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0)
):
    """List all digital twins."""
    with get_db() as conn:
        cur = get_cursor(conn)

        # Build query
        conditions = []
        params = []

        if status:
            conditions.append("status = %s")
            params.append(status)

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        # Get total count
        cur.execute(f"SELECT COUNT(*) FROM twins {where_clause}", params)
        total = cur.fetchone()['count']

        # Get twins
        cur.execute(f"""
            SELECT
                id, name, location_name,
                centre_lat, centre_lon, side_length_m,
                status, progress_pct, current_step,
                has_lidar, building_count,
                created_at, completed_at
            FROM twins
            {where_clause}
            ORDER BY created_at DESC
            LIMIT %s OFFSET %s
        """, params + [limit, offset])

        twins = []
        for row in cur.fetchall():
            twins.append(TwinListItem(
                id=row['id'],
                name=row['name'],
                location_name=row['location_name'],
                centre_lat=row['centre_lat'],
                centre_lon=row['centre_lon'],
                side_length_m=row['side_length_m'],
                status=row['status'],
                progress_pct=row['progress_pct'],
                current_step=row['current_step'],
                has_lidar=row['has_lidar'],
                building_count=row['building_count'],
                created_at=row['created_at'],
                completed_at=row['completed_at']
            ))

        cur.close()

        return TwinListResponse(total=total, twins=twins)


@router.get("/{twin_id}", response_model=TwinResponse)
async def get_twin(twin_id: UUID):
    """Get details of a specific twin."""
    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("""
            SELECT *
            FROM twins
            WHERE id = %s
        """, (str(twin_id),))

        row = cur.fetchone()
        cur.close()

        if not row:
            raise HTTPException(404, f"Twin {twin_id} not found")

        # Parse tiles_needed
        tiles_needed = row.get('tiles_needed') or []
        if isinstance(tiles_needed, str):
            import json
            tiles_needed = json.loads(tiles_needed)

        return TwinResponse(
            id=row['id'],
            name=row['name'],
            location_name=row['location_name'],
            centre_lat=row['centre_lat'],
            centre_lon=row['centre_lon'],
            side_length_m=row['side_length_m'],
            buffer_m=row['buffer_m'],
            status=row['status'],
            current_step=row['current_step'],
            progress_pct=row['progress_pct'],
            error_message=row['error_message'],
            has_lidar=row['has_lidar'],
            height_source=row['height_source'],
            tiles_needed=tiles_needed,
            output_dir=row['output_dir'],
            building_count=row['building_count'],
            created_at=row['created_at'],
            started_at=row['started_at'],
            completed_at=row['completed_at']
        )


@router.delete("/{twin_id}")
async def delete_twin(twin_id: UUID):
    """Delete a twin and its data."""
    with get_db() as conn:
        cur = get_cursor(conn)

        # Check twin exists
        cur.execute("SELECT status FROM twins WHERE id = %s", (str(twin_id),))
        row = cur.fetchone()

        if not row:
            raise HTTPException(404, f"Twin {twin_id} not found")

        if row['status'] == 'running':
            raise HTTPException(400, "Cannot delete a running twin")

        # Delete from database
        cur.execute("DELETE FROM twins WHERE id = %s", (str(twin_id),))
        cur.close()

        # Delete data directories
        twin_data_dir = DATA_DIR / str(twin_id)
        twin_dist_dir = DIST_DIR / str(twin_id)

        if twin_data_dir.exists():
            shutil.rmtree(twin_data_dir)
        if twin_dist_dir.exists():
            shutil.rmtree(twin_dist_dir)

        return {"message": f"Twin {twin_id} deleted"}


@router.get("/{twin_id}/events")
async def twin_events(twin_id: UUID):
    """Server-Sent Events stream for twin progress updates."""

    async def event_generator():
        last_status = None
        last_progress = None

        while True:
            # Get current twin status
            with get_db() as conn:
                cur = get_cursor(conn)
                cur.execute("""
                    SELECT id, status, current_step, progress_pct,
                           error_message, building_count
                    FROM twins WHERE id = %s
                """, (str(twin_id),))
                row = cur.fetchone()
                cur.close()

            if not row:
                yield f"data: {json.dumps({'error': 'Twin not found'})}\n\n"
                break

            # Only send if there's a change
            if row['status'] != last_status or row['progress_pct'] != last_progress:
                event = TwinEvent(
                    id=row['id'],
                    status=row['status'],
                    current_step=row['current_step'],
                    progress_pct=row['progress_pct'],
                    error_message=row['error_message'],
                    building_count=row['building_count']
                )
                yield f"data: {event.model_dump_json()}\n\n"

                last_status = row['status']
                last_progress = row['progress_pct']

                # Stop streaming if completed or failed
                if row['status'] in ('completed', 'failed'):
                    break

            await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.get("/{twin_id}/lidar-tiles", response_model=LidarTilesResponse)
async def get_lidar_tiles(twin_id: UUID):
    """Get LiDAR tile information for a twin."""
    import sys
    sys.path.insert(0, str(PIPELINE_DIR))
    from lib.twin_config import get_required_tiles, check_tiles_exist, get_twin_config

    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("""
            SELECT status, tiles_needed, centre_lat, centre_lon,
                   side_length_m, buffer_m, has_lidar
            FROM twins WHERE id = %s
        """, (str(twin_id),))
        row = cur.fetchone()
        cur.close()

        if not row:
            raise HTTPException(404, f"Twin {twin_id} not found")

        # Get twin config for tile checking
        try:
            config = get_twin_config(str(twin_id))
        except Exception:
            config = None

        # Determine tiles needed
        tiles_needed = row['tiles_needed'] or []
        if isinstance(tiles_needed, str):
            import json
            tiles_needed = json.loads(tiles_needed)

        # Calculate required tiles if not stored
        if not tiles_needed and row['has_lidar']:
            tiles_needed = get_required_tiles(
                row['centre_lat'],
                row['centre_lon'],
                row['side_length_m'],
                row['buffer_m']
            )

        # Check which tiles exist
        tiles_present = []
        if config and tiles_needed:
            existing, missing = check_tiles_exist(config, tiles_needed)
            tiles_present = existing
            tiles_needed = missing

        # Determine status
        if row['status'] == 'awaiting_lidar':
            status = 'awaiting_lidar'
        elif not tiles_needed:
            status = 'has_tiles' if row['has_lidar'] else 'not_needed'
        else:
            status = 'awaiting_lidar'

        upload_path = f"data/twins/{twin_id}/raw/lidar_dtm/"

        return LidarTilesResponse(
            status=status,
            tiles_needed=tiles_needed,
            tiles_present=tiles_present,
            upload_path=upload_path
        )


@router.post("/{twin_id}/continue")
async def continue_twin(twin_id: UUID, background_tasks: BackgroundTasks):
    """Continue pipeline after user has uploaded LiDAR tiles."""
    import sys
    sys.path.insert(0, str(PIPELINE_DIR))
    from lib.twin_config import get_required_tiles, check_tiles_exist, get_twin_config

    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("""
            SELECT status, tiles_needed, centre_lat, centre_lon,
                   side_length_m, buffer_m
            FROM twins WHERE id = %s
        """, (str(twin_id),))
        row = cur.fetchone()

        if not row:
            cur.close()
            raise HTTPException(404, f"Twin {twin_id} not found")

        if row['status'] != 'awaiting_lidar':
            cur.close()
            raise HTTPException(
                400,
                f"Twin is not awaiting LiDAR, current status: {row['status']}"
            )

        # Verify tiles are now present
        try:
            config = get_twin_config(str(twin_id))
            tiles_needed = row['tiles_needed'] or []
            if isinstance(tiles_needed, str):
                import json
                tiles_needed = json.loads(tiles_needed)

            if not tiles_needed:
                tiles_needed = get_required_tiles(
                    row['centre_lat'],
                    row['centre_lon'],
                    row['side_length_m'],
                    row['buffer_m']
                )

            existing, missing = check_tiles_exist(config, tiles_needed)

            if missing:
                cur.close()
                raise HTTPException(
                    400,
                    f"Still missing {len(missing)} tiles: {', '.join(missing[:5])}"
                    + ("..." if len(missing) > 5 else "")
                )
        except HTTPException:
            raise
        except Exception as e:
            cur.close()
            raise HTTPException(500, f"Error checking tiles: {e}")

        # Reset status to running
        cur.execute("""
            UPDATE twins
            SET status = 'running',
                current_step = 'Resuming pipeline',
                tiles_needed = '[]'::jsonb
            WHERE id = %s
        """, (str(twin_id),))
        cur.close()

        # Queue pipeline
        background_tasks.add_task(run_pipeline, str(twin_id))

        return {"message": "Pipeline resumed with LiDAR tiles"}


@router.post("/{twin_id}/skip-lidar")
async def skip_lidar(twin_id: UUID, background_tasks: BackgroundTasks):
    """Skip LiDAR and continue with flat terrain."""
    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("SELECT status FROM twins WHERE id = %s", (str(twin_id),))
        row = cur.fetchone()

        if not row:
            cur.close()
            raise HTTPException(404, f"Twin {twin_id} not found")

        if row['status'] != 'awaiting_lidar':
            cur.close()
            raise HTTPException(
                400,
                f"Twin is not awaiting LiDAR, current status: {row['status']}"
            )

        # Update to skip LiDAR
        cur.execute("""
            UPDATE twins
            SET status = 'running',
                current_step = 'Resuming without LiDAR',
                has_lidar = FALSE,
                height_source = 'osm',
                tiles_needed = '[]'::jsonb
            WHERE id = %s
        """, (str(twin_id),))
        cur.close()

        # Queue pipeline
        background_tasks.add_task(run_pipeline, str(twin_id))

        return {"message": "Pipeline resumed with flat terrain (no LiDAR)"}


@router.post("/{twin_id}/retry")
async def retry_twin(twin_id: UUID, background_tasks: BackgroundTasks):
    """Retry a failed twin pipeline."""
    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("SELECT status FROM twins WHERE id = %s", (str(twin_id),))
        row = cur.fetchone()

        if not row:
            raise HTTPException(404, f"Twin {twin_id} not found")

        if row['status'] not in ('failed', 'pending'):
            raise HTTPException(400, f"Can only retry failed or pending twins, current status: {row['status']}")

        # Reset status
        cur.execute("""
            UPDATE twins
            SET status = 'pending',
                progress_pct = 0,
                current_step = NULL,
                error_message = NULL,
                started_at = NULL,
                completed_at = NULL
            WHERE id = %s
        """, (str(twin_id),))
        cur.close()

        # Queue pipeline
        background_tasks.add_task(run_pipeline, str(twin_id))

        return {"message": "Pipeline retry queued"}


class RegenerateOptions(BaseModel):
    """Options for regenerating a twin."""
    use_lidar: Optional[bool] = None
    side_length_m: Optional[int] = Field(None, ge=500, le=10000)
    buffer_m: Optional[int] = Field(None, ge=0, le=2000)


@router.post("/{twin_id}/regenerate")
async def regenerate_twin(
    twin_id: UUID,
    options: Optional[RegenerateOptions],
    background_tasks: BackgroundTasks
):
    """Regenerate a completed twin from scratch with optional new settings."""
    with get_db() as conn:
        cur = get_cursor(conn)

        cur.execute("SELECT status, output_dir FROM twins WHERE id = %s", (str(twin_id),))
        row = cur.fetchone()

        if not row:
            cur.close()
            raise HTTPException(404, f"Twin {twin_id} not found")

        if row['status'] == 'running':
            cur.close()
            raise HTTPException(400, "Cannot regenerate a running twin")

        # Clear output directories
        twin_data_dir = DATA_DIR / str(twin_id)
        twin_dist_dir = DIST_DIR / str(twin_id)

        # Remove processed/interim data but keep raw LiDAR tiles if present
        for subdir in ['interim', 'processed', 'config']:
            dir_path = twin_data_dir / subdir
            if dir_path.exists():
                shutil.rmtree(dir_path)

        if twin_dist_dir.exists():
            shutil.rmtree(twin_dist_dir)

        # Build update query with optional new settings
        updates = [
            "status = 'pending'",
            "progress_pct = 0",
            "current_step = NULL",
            "error_message = NULL",
            "building_count = NULL",
            "tiles_needed = '[]'::jsonb",
            "started_at = NULL",
            "completed_at = NULL",
            "has_lidar = FALSE",
            "height_source = 'osm'"
        ]
        params = []

        if options:
            if options.use_lidar is not None:
                updates.append("use_lidar = %s")
                params.append(options.use_lidar)
            if options.side_length_m is not None:
                updates.append("side_length_m = %s")
                params.append(options.side_length_m)
            if options.buffer_m is not None:
                updates.append("buffer_m = %s")
                params.append(options.buffer_m)

        params.append(str(twin_id))
        cur.execute(
            f"UPDATE twins SET {', '.join(updates)} WHERE id = %s",
            params
        )
        cur.close()

        # Queue pipeline
        background_tasks.add_task(run_pipeline, str(twin_id))

        return {"message": "Twin regeneration started"}
