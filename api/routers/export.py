"""
Export API router.

Endpoints:
- POST /api/export - Trigger export pipeline
- GET /api/export/status - Check export progress
"""

import subprocess
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks

from ..auth import verify_api_key

router = APIRouter()

# Export state (in production, use Redis or database)
_export_state = {
    "status": "idle",  # idle, running, completed, failed
    "started_at": None,
    "completed_at": None,
    "error": None,
    "output": []
}

SCRIPT_DIR = Path(__file__).parent.parent.parent / "pipeline" / "scripts"


def run_export():
    """Run the export pipeline in background."""
    global _export_state

    _export_state["status"] = "running"
    _export_state["started_at"] = datetime.now()
    _export_state["completed_at"] = None
    _export_state["error"] = None
    _export_state["output"] = []

    try:
        # Run 51_export_buildings.py
        _export_state["output"].append("Running 51_export_buildings.py...")
        result = subprocess.run(
            ["python", str(SCRIPT_DIR / "51_export_buildings.py")],
            capture_output=True,
            text=True,
            cwd=str(SCRIPT_DIR)
        )

        if result.returncode != 0:
            _export_state["status"] = "failed"
            _export_state["error"] = result.stderr
            _export_state["output"].append(f"Export failed: {result.stderr}")
            return

        _export_state["output"].append(result.stdout)
        _export_state["output"].append("Export completed successfully")

        _export_state["status"] = "completed"
        _export_state["completed_at"] = datetime.now()

    except Exception as e:
        _export_state["status"] = "failed"
        _export_state["error"] = str(e)
        _export_state["completed_at"] = datetime.now()


@router.post("")
async def trigger_export(
    background_tasks: BackgroundTasks,
    regenerate_meshes: bool = False,
    user: str = Depends(verify_api_key)
):
    """Trigger the export pipeline.

    Args:
        regenerate_meshes: If True, also regenerate building meshes after export
    """
    global _export_state

    if _export_state["status"] == "running":
        raise HTTPException(409, "Export already in progress")

    # Start export in background
    background_tasks.add_task(run_export)

    return {
        "message": "Export started",
        "status_url": "/api/export/status"
    }


@router.get("/status")
async def get_export_status(
    user: Optional[str] = Depends(verify_api_key)
):
    """Get the current export status."""
    return {
        "status": _export_state["status"],
        "started_at": _export_state["started_at"],
        "completed_at": _export_state["completed_at"],
        "error": _export_state["error"],
        "output": _export_state["output"][-10:] if _export_state["output"] else []  # Last 10 lines
    }


@router.post("/regenerate-meshes")
async def regenerate_meshes(
    background_tasks: BackgroundTasks,
    user: str = Depends(verify_api_key)
):
    """Regenerate all building meshes (runs 60_generate_meshes.py)."""
    global _export_state

    if _export_state["status"] == "running":
        raise HTTPException(409, "Another operation in progress")

    def run_mesh_generation():
        global _export_state
        _export_state["status"] = "running"
        _export_state["started_at"] = datetime.now()
        _export_state["output"] = ["Running 60_generate_meshes.py..."]

        try:
            result = subprocess.run(
                ["python", str(SCRIPT_DIR / "60_generate_meshes.py")],
                capture_output=True,
                text=True,
                cwd=str(SCRIPT_DIR)
            )

            if result.returncode != 0:
                _export_state["status"] = "failed"
                _export_state["error"] = result.stderr
                return

            _export_state["output"].append(result.stdout)
            _export_state["status"] = "completed"
            _export_state["completed_at"] = datetime.now()

        except Exception as e:
            _export_state["status"] = "failed"
            _export_state["error"] = str(e)

    background_tasks.add_task(run_mesh_generation)

    return {
        "message": "Mesh regeneration started",
        "status_url": "/api/export/status"
    }
