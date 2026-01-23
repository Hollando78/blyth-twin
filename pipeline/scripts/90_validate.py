#!/usr/bin/env python3
"""
90_validate.py - Validation & QA

Generates a validation report for the pipeline output.

Input:
    - All processed data and assets

Output:
    - dist/blyth_mvp_v1/report/validation.md

Usage:
    python 90_validate.py
"""

import json
from pathlib import Path
from datetime import datetime
from collections import Counter

import yaml

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"
DIST_DIR = SCRIPT_DIR.parent.parent / "dist" / "blyth_mvp_v1"
REPORT_DIR = DIST_DIR / "report"


def load_settings() -> dict:
    """Load settings from YAML configuration."""
    with open(CONFIG_DIR / "settings.yaml") as f:
        return yaml.safe_load(f)


def check_file_exists(path: Path) -> tuple[bool, str]:
    """Check if file exists and return status."""
    if path.exists():
        size = path.stat().st_size
        return True, f"{size:,} bytes"
    return False, "MISSING"


def validate_buildings() -> dict:
    """Validate building data."""
    buildings_path = PROCESSED_DIR / "buildings_height.geojson"

    if not buildings_path.exists():
        return {"status": "MISSING", "count": 0, "height_sources": {}}

    with open(buildings_path) as f:
        buildings = json.load(f)

    features = buildings.get("features", [])

    # Count height sources
    sources = Counter()
    heights = []

    for feature in features:
        props = feature.get("properties", {})
        sources[props.get("height_source", "unknown")] += 1
        if "height" in props:
            heights.append(props["height"])

    # Height statistics
    height_stats = {}
    if heights:
        heights.sort()
        height_stats = {
            "min": min(heights),
            "max": max(heights),
            "median": heights[len(heights) // 2],
            "mean": sum(heights) / len(heights)
        }

    # Find outliers (> 50m)
    outliers = [f for f in features if f.get("properties", {}).get("height", 0) > 50]

    return {
        "status": "OK",
        "count": len(features),
        "height_sources": dict(sources),
        "height_stats": height_stats,
        "outlier_count": len(outliers)
    }


def validate_assets() -> dict:
    """Validate packed assets."""
    manifest_path = DIST_DIR / "manifest.json"

    if not manifest_path.exists():
        return {"status": "MISSING", "assets": []}

    with open(manifest_path) as f:
        manifest = json.load(f)

    assets = manifest.get("assets", [])

    # Check each asset exists
    missing = []
    for asset in assets:
        asset_path = DIST_DIR / asset["url"]
        if not asset_path.exists():
            missing.append(asset["url"])

    return {
        "status": "OK" if not missing else "INCOMPLETE",
        "total_assets": len(assets),
        "missing": missing,
        "version": manifest.get("version", "unknown")
    }


def generate_report(settings: dict) -> str:
    """Generate validation report as markdown."""
    lines = [
        "# Blyth Digital Twin - Validation Report",
        "",
        f"Generated: {datetime.utcnow().isoformat()}Z",
        "",
        "## Project Info",
        "",
        f"- **Name:** {settings['project']['name']}",
        f"- **Version:** {settings['project']['version']}",
        "",
        "## AOI",
        "",
        f"- **Centre:** {settings['aoi']['centre_lat']}, {settings['aoi']['centre_lon']}",
        f"- **Size:** {settings['aoi']['side_length_m']}m x {settings['aoi']['side_length_m']}m",
        f"- **CRS:** {settings['aoi']['crs_projected']}",
        "",
        "## Input Data",
        "",
        "### LiDAR",
        "",
    ]

    # Check LiDAR files
    dtm_files = list((RAW_DIR / "lidar_dtm").glob("*.tif")) if (RAW_DIR / "lidar_dtm").exists() else []
    dsm_files = list((RAW_DIR / "lidar_dsm").glob("*.tif")) if (RAW_DIR / "lidar_dsm").exists() else []

    lines.append(f"- DTM tiles: {len(dtm_files)}")
    lines.append(f"- DSM tiles: {len(dsm_files)}")

    # Check interim rasters
    lines.extend([
        "",
        "### Processed Rasters",
        "",
    ])

    for raster in ["dtm_clip.tif", "dsm_clip.tif", "ndsm_clip.tif"]:
        exists, info = check_file_exists(INTERIM_DIR / raster)
        status = "OK" if exists else "MISSING"
        lines.append(f"- {raster}: {status} ({info})")

    # OSM data
    lines.extend([
        "",
        "### OSM Data",
        "",
    ])

    osm_dir = RAW_DIR / "osm"
    for osm_file in ["buildings.geojson", "roads.geojson", "water.geojson", "coast.geojson"]:
        exists, info = check_file_exists(osm_dir / osm_file)
        status = "OK" if exists else "MISSING"
        lines.append(f"- {osm_file}: {status} ({info})")

    # Buildings validation
    lines.extend([
        "",
        "## Building Heights",
        "",
    ])

    building_validation = validate_buildings()
    lines.append(f"- **Status:** {building_validation['status']}")
    lines.append(f"- **Total buildings:** {building_validation['count']}")

    if building_validation.get("height_sources"):
        lines.append("")
        lines.append("### Height Source Breakdown")
        lines.append("")
        for source, count in building_validation["height_sources"].items():
            pct = (count / building_validation["count"] * 100) if building_validation["count"] > 0 else 0
            lines.append(f"- {source}: {count} ({pct:.1f}%)")

    if building_validation.get("height_stats"):
        stats = building_validation["height_stats"]
        lines.extend([
            "",
            "### Height Statistics",
            "",
            f"- Min: {stats['min']:.1f}m",
            f"- Max: {stats['max']:.1f}m",
            f"- Median: {stats['median']:.1f}m",
            f"- Mean: {stats['mean']:.1f}m",
        ])

    if building_validation.get("outlier_count", 0) > 0:
        lines.append(f"- **Outliers (>50m):** {building_validation['outlier_count']}")

    # Assets validation
    lines.extend([
        "",
        "## Packed Assets",
        "",
    ])

    asset_validation = validate_assets()
    lines.append(f"- **Status:** {asset_validation['status']}")
    lines.append(f"- **Total assets:** {asset_validation['total_assets']}")
    lines.append(f"- **Version:** {asset_validation['version']}")

    if asset_validation.get("missing"):
        lines.append("")
        lines.append("### Missing Assets")
        lines.append("")
        for missing in asset_validation["missing"]:
            lines.append(f"- {missing}")

    # Summary
    lines.extend([
        "",
        "## Summary",
        "",
    ])

    all_ok = (
        building_validation["status"] == "OK" and
        asset_validation["status"] == "OK" and
        len(dtm_files) > 0 and
        len(dsm_files) > 0
    )

    if all_ok:
        lines.append("Pipeline completed successfully. Ready for web deployment.")
    else:
        lines.append("Pipeline incomplete. Check missing items above.")

    return "\n".join(lines)


def main():
    """Run validation and generate report."""
    print("Loading settings...")
    settings = load_settings()

    print("Running validation checks...")
    report = generate_report(settings)

    # Save report
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_file = REPORT_DIR / "validation.md"

    with open(report_file, "w") as f:
        f.write(report)

    print(f"\nReport written to: {report_file}")
    print("\n" + "=" * 50)
    print(report)
    print("=" * 50)


if __name__ == "__main__":
    main()
