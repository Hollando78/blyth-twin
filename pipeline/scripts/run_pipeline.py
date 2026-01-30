#!/usr/bin/env python3
"""
run_pipeline.py - Unified Pipeline Runner

Runs the complete pipeline for a specific twin.

Usage:
    python run_pipeline.py --twin-id <uuid>

This script:
1. Loads twin configuration from database
2. Creates twin-specific directories
3. Runs each pipeline step sequentially
4. Updates progress in database (for SSE streaming)
5. Handles errors gracefully

Elevation data sources (in order of preference):
1. EA LIDAR Composite (1m, ~99% England coverage) - automatic via WCS
2. SRTM (30m, global) - fallback for non-England locations
"""

import argparse
import subprocess
import sys
import traceback
from pathlib import Path

# Add parent directory to path for imports
SCRIPT_DIR = Path(__file__).parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from lib.twin_config import (
    get_twin_config,
    update_twin_status,
    TwinConfig,
)


# Pipeline steps with their scripts and progress percentages
PIPELINE_STEPS = [
    {
        "name": "Generate AOI",
        "script": "00_aoi.py",
        "progress": 5,
        "required": True,
    },
    {
        "name": "Fetch Elevation",
        "script": "15_fetch_elevation.py",
        "progress": 15,
        "required": False,  # Non-fatal - can use flat terrain
    },
    {
        "name": "Fetch OSM Data",
        "script": "20_fetch_osm.py",
        "progress": 25,
        "required": True,
    },
    {
        "name": "Migrate to PostGIS",
        "script": "21_migrate_to_postgis.py",
        "progress": 35,
        "required": True,
    },
    {
        "name": "Enrich Buildings",
        "script": "22_enrich_buildings.py",
        "progress": 45,
        "required": False,  # Non-fatal - enrichment is optional
    },
    {
        "name": "Compute Building Heights",
        "script": "50_building_heights.py",
        "progress": 55,
        "required": True,
    },
    {
        "name": "Export Buildings",
        "script": "51_export_buildings.py",
        "progress": 65,
        "required": True,
    },
    {
        "name": "Generate Meshes",
        "script": "60_generate_meshes.py",
        "progress": 80,
        "required": True,
    },
    {
        "name": "Generate Footprints",
        "script": "65_generate_footprints.py",
        "progress": 90,
        "required": True,
    },
    {
        "name": "Pack Assets",
        "script": "70_pack_assets.py",
        "progress": 95,
        "required": True,
    },
]


def run_step(script: str, twin_id: str, config: TwinConfig) -> tuple[bool, str]:
    """
    Run a pipeline step script.

    Returns (success, output/error message)
    """
    script_path = SCRIPT_DIR / script

    if not script_path.exists():
        return False, f"Script not found: {script}"

    try:
        result = subprocess.run(
            [sys.executable, str(script_path), "--twin-id", twin_id],
            capture_output=True,
            text=True,
            timeout=3600,  # 1 hour timeout per step
            cwd=str(SCRIPT_DIR),
        )

        if result.returncode != 0:
            error_msg = result.stderr or result.stdout or "Unknown error"
            return False, error_msg[-1000:]  # Last 1000 chars of error

        return True, result.stdout[-500:] if result.stdout else "OK"

    except subprocess.TimeoutExpired:
        return False, "Step timed out after 1 hour"
    except Exception as e:
        return False, str(e)


def run_pipeline(twin_id: str):
    """Run the complete pipeline for a twin."""
    print(f"=" * 60)
    print(f"PIPELINE RUNNER: {twin_id}")
    print(f"=" * 60)

    # Load twin config
    try:
        config = get_twin_config(twin_id)
    except ValueError as e:
        print(f"ERROR: {e}")
        return False

    print(f"Twin: {config.name}")
    print(f"Centre: {config.centre_lat}, {config.centre_lon}")
    print(f"Size: {config.side_length_m}m x {config.side_length_m}m")
    print()

    # Update status to running
    update_twin_status(twin_id, status="running", current_step="Initializing", progress_pct=0)

    # Setup directories and generate settings
    try:
        config.ensure_directories()
        config.save_settings()
        print(f"Created directories and settings for twin")
    except Exception as e:
        update_twin_status(
            twin_id,
            status="failed",
            error_message=f"Failed to initialize: {e}",
        )
        return False

    # Run pipeline steps
    for step in PIPELINE_STEPS:
        step_name = step["name"]
        script = step["script"]
        progress = step["progress"]
        required = step["required"]

        print(f"[{progress}%] {step_name}...")
        update_twin_status(
            twin_id,
            current_step=step_name,
            progress_pct=progress,
        )

        success, message = run_step(script, twin_id, config)

        if success:
            print(f"  OK")
        else:
            print(f"  FAILED: {message[:200]}")
            if required:
                update_twin_status(
                    twin_id,
                    status="failed",
                    error_message=f"{step_name}: {message[:500]}",
                )
                return False
            else:
                print(f"  (non-required step, continuing)")

    # Count buildings
    try:
        from lib.twin_config import get_db_connection

        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM buildings")
        building_count = cur.fetchone()[0]
        cur.close()
        conn.close()
    except Exception:
        building_count = None

    # Complete
    update_twin_status(
        twin_id,
        status="completed",
        current_step="Done",
        progress_pct=100,
        building_count=building_count,
    )

    print()
    print(f"=" * 60)
    print(f"PIPELINE COMPLETE")
    print(f"Output: {config.dist_dir}")
    if building_count:
        print(f"Buildings: {building_count}")
    print(f"=" * 60)

    return True


def main():
    parser = argparse.ArgumentParser(description="Run pipeline for a twin")
    parser.add_argument("--twin-id", required=True, help="Twin UUID")
    args = parser.parse_args()

    try:
        success = run_pipeline(args.twin_id)
        sys.exit(0 if success else 1)
    except Exception as e:
        traceback.print_exc()
        update_twin_status(
            args.twin_id,
            status="failed",
            error_message=str(e)[:500],
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
