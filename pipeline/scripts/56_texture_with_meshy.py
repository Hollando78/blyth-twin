#!/usr/bin/env python3
"""
56_texture_with_meshy.py - AI Texture Generation with Meshy

Sends building chunk meshes to Meshy for AI texturing,
using Street View and aerial imagery as style reference.

Input:
    - data/processed/buildings/*.glb (chunk meshes)
    - data/reference/streetview/{chunk}/ (360° Street View images)
    - data/reference/aerial/{chunk}.jpg (aerial tiles)

Output:
    - data/processed/buildings_textured/*.glb (textured meshes)

Usage:
    export MESHY_API_KEY="your_key_here"
    python 56_texture_with_meshy.py

    # Process specific chunks:
    python 56_texture_with_meshy.py --chunks 0_0 -1_1 -2_0

    # Dry run (check coverage without API calls):
    python 56_texture_with_meshy.py --dry-run

API Costs:
    - Meshy Text-to-Texture: ~$0.10-0.20 per model
    - 73 chunks ≈ $7-15 total
"""

import argparse
import json
import os
import time
from pathlib import Path

import requests

# Paths
SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
REFERENCE_DIR = DATA_DIR / "reference"

# Meshy API
MESHY_API_URL = "https://api.meshy.ai"
MESHY_TEXTURE_ENDPOINT = "/v2/text-to-texture"

# Default texturing prompt
DEFAULT_PROMPT = """
UK town buildings in Blyth, Northumberland.
Mix of Victorian terraced houses with red/brown brick,
rendered semis, and modern commercial buildings.
Realistic weathered materials, windows with frames,
appropriate roof tiles. Northern England architectural style.
"""

# Building type specific prompts
BUILDING_PROMPTS = {
    "residential": "UK residential buildings, red brick terraced houses, rendered semis, slate roofs, sash windows",
    "commercial": "UK commercial buildings, shop fronts, large windows, signage areas, modern cladding",
    "industrial": "UK industrial buildings, corrugated metal, large warehouse doors, functional design",
    "retail": "UK retail buildings, shop windows, awnings, mixed materials",
    "default": DEFAULT_PROMPT.strip().replace("\n", " ")
}


def get_meshy_headers(api_key: str) -> dict:
    """Get headers for Meshy API requests."""
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }


def upload_model_to_meshy(glb_path: Path, api_key: str) -> str | None:
    """
    Upload a GLB model to Meshy and return the model URL.

    Note: Meshy may require models to be hosted at a public URL.
    This function handles the upload if Meshy provides an upload endpoint,
    otherwise you may need to host the files externally.
    """
    # Check if Meshy has a direct upload endpoint
    # As of 2024, Meshy typically requires a public URL
    # You may need to upload to S3/GCS/similar first

    # For now, return None to indicate manual hosting needed
    return None


def create_texture_task(model_url: str, prompt: str, api_key: str,
                        style_reference_url: str = None) -> dict | None:
    """
    Create a Meshy text-to-texture task.

    Args:
        model_url: Public URL to the GLB model
        prompt: Text description for texturing
        api_key: Meshy API key
        style_reference_url: Optional URL to style reference image

    Returns:
        Task info dict with task_id, or None on failure
    """
    headers = get_meshy_headers(api_key)

    payload = {
        "model_url": model_url,
        "prompt": prompt,
        "art_style": "realistic",
        "negative_prompt": "cartoon, anime, stylized, low quality, blurry"
    }

    # Add style reference if available
    if style_reference_url:
        payload["style_reference_url"] = style_reference_url

    try:
        resp = requests.post(
            f"{MESHY_API_URL}{MESHY_TEXTURE_ENDPOINT}",
            headers=headers,
            json=payload,
            timeout=60
        )

        if resp.status_code == 200 or resp.status_code == 201:
            return resp.json()
        else:
            print(f"    Error: {resp.status_code} - {resp.text}")
            return None

    except Exception as e:
        print(f"    Error creating task: {e}")
        return None


def check_task_status(task_id: str, api_key: str) -> dict | None:
    """Check the status of a Meshy task."""
    headers = get_meshy_headers(api_key)

    try:
        resp = requests.get(
            f"{MESHY_API_URL}{MESHY_TEXTURE_ENDPOINT}/{task_id}",
            headers=headers,
            timeout=30
        )

        if resp.status_code == 200:
            return resp.json()
        else:
            return None

    except Exception:
        return None


def wait_for_task(task_id: str, api_key: str, timeout: int = 600,
                  poll_interval: int = 10) -> dict | None:
    """
    Wait for a Meshy task to complete.

    Args:
        task_id: Meshy task ID
        api_key: API key
        timeout: Maximum wait time in seconds
        poll_interval: Time between status checks

    Returns:
        Completed task info, or None on timeout/failure
    """
    start_time = time.time()

    while time.time() - start_time < timeout:
        status = check_task_status(task_id, api_key)

        if status is None:
            print("    Warning: Failed to check status")
            time.sleep(poll_interval)
            continue

        task_status = status.get("status", "unknown")

        if task_status == "SUCCEEDED":
            return status
        elif task_status == "FAILED":
            print(f"    Task failed: {status.get('error', 'unknown error')}")
            return None
        elif task_status in ["PENDING", "IN_PROGRESS"]:
            progress = status.get("progress", 0)
            print(f"    Status: {task_status} ({progress}%)")
        else:
            print(f"    Status: {task_status}")

        time.sleep(poll_interval)

    print("    Timeout waiting for task")
    return None


def download_textured_model(task_result: dict, output_path: Path) -> bool:
    """Download the textured model from Meshy."""
    model_url = task_result.get("model_urls", {}).get("glb")

    if not model_url:
        print("    No GLB URL in result")
        return False

    try:
        resp = requests.get(model_url, timeout=120)

        if resp.status_code == 200:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(resp.content)
            return True
        else:
            print(f"    Download failed: {resp.status_code}")
            return False

    except Exception as e:
        print(f"    Download error: {e}")
        return False


def rescale_to_original(original_path: Path, textured_path: Path, output_path: Path) -> bool:
    """
    Rescale a Meshy-textured mesh to match the original mesh bounds.

    Meshy normalizes vertices to -1 to 1 range, so we need to transform
    back to the original coordinate space.
    """
    try:
        import trimesh
        import numpy as np

        # Load meshes
        orig = trimesh.load(str(original_path), force='mesh')
        textured = trimesh.load(str(textured_path), force='mesh')

        # Get bounds
        orig_bounds = orig.bounds
        orig_center = (orig_bounds[0] + orig_bounds[1]) / 2
        orig_size = orig_bounds[1] - orig_bounds[0]

        text_bounds = textured.bounds
        text_center = (text_bounds[0] + text_bounds[1]) / 2
        text_size = text_bounds[1] - text_bounds[0]

        # Calculate scale factor (use max dimension to preserve aspect ratio)
        scale = np.max(orig_size) / np.max(text_size) if np.max(text_size) > 0 else 1.0

        # Transform: center to origin, scale, translate to original center
        textured.vertices -= text_center
        textured.vertices *= scale
        textured.vertices += orig_center

        # Export with preserved textures
        output_path.parent.mkdir(parents=True, exist_ok=True)
        textured.export(str(output_path), file_type='glb')

        return True

    except Exception as e:
        print(f"    Rescale error: {e}")
        return False


def get_reference_images(chunk_key: str) -> dict:
    """Get available reference images for a chunk."""
    refs = {
        "streetview_composite": None,
        "streetview_images": [],
        "aerial": None
    }

    # Street View composite
    sv_composite = REFERENCE_DIR / "streetview" / chunk_key / "composite.jpg"
    if sv_composite.exists():
        refs["streetview_composite"] = sv_composite

    # Individual Street View images
    sv_dir = REFERENCE_DIR / "streetview" / chunk_key
    if sv_dir.exists():
        refs["streetview_images"] = sorted(sv_dir.glob("h*.jpg"))

    # Aerial
    aerial = REFERENCE_DIR / "aerial" / f"{chunk_key}.jpg"
    if aerial.exists():
        refs["aerial"] = aerial

    return refs


def generate_chunk_prompt(chunk_key: str, refs: dict) -> str:
    """Generate a texturing prompt based on available references."""
    # Base prompt
    prompt = BUILDING_PROMPTS["default"]

    # Could analyze aerial image to determine building types
    # For now, use generic UK town prompt

    return prompt


def process_chunk_local(chunk_path: Path, output_dir: Path, refs: dict, prompt: str):
    """
    Prepare a chunk for manual Meshy upload.

    Creates a task file with all necessary info for manual processing.
    """
    chunk_key = chunk_path.stem.replace("buildings_", "")

    task_info = {
        "chunk_key": chunk_key,
        "source_glb": str(chunk_path),
        "prompt": prompt,
        "references": {
            "streetview_composite": str(refs["streetview_composite"]) if refs["streetview_composite"] else None,
            "aerial": str(refs["aerial"]) if refs["aerial"] else None,
            "streetview_count": len(refs["streetview_images"])
        }
    }

    task_file = output_dir / f"{chunk_key}_task.json"
    task_file.parent.mkdir(parents=True, exist_ok=True)

    with open(task_file, "w") as f:
        json.dump(task_info, f, indent=2)

    return task_info


def texture_chunk_with_meshy(chunk_path: Path, style_image_path: Path, api_key: str,
                             output_dir: Path, max_retries: int = 3) -> bool:
    """
    Send a chunk to Meshy for texturing using a style reference image.

    Args:
        chunk_path: Path to the GLB mesh
        style_image_path: Path to style reference (Street View composite or aerial)
        api_key: Meshy API key
        output_dir: Output directory for textured meshes
        max_retries: Number of retry attempts

    Returns True on success, False on failure.
    """
    import base64

    chunk_key = chunk_path.stem.replace("buildings_", "")

    # Load GLB as base64
    with open(chunk_path, "rb") as f:
        glb_base64 = base64.b64encode(f.read()).decode()

    # Load style reference image as base64
    with open(style_image_path, "rb") as f:
        img_base64 = base64.b64encode(f.read()).decode()

    print(f"    Style reference: {style_image_path.name}")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    payload = {
        "model_url": f"data:application/octet-stream;base64,{glb_base64}",
        "image_style_url": f"data:image/jpeg;base64,{img_base64}",
        "ai_model": "latest",
        "enable_original_uv": False,  # Must be False - Meshy needs to generate its own UVs
        "enable_pbr": False
    }

    for attempt in range(max_retries):
        try:
            # Create task
            resp = requests.post(
                "https://api.meshy.ai/openapi/v1/retexture",
                headers=headers,
                json=payload,
                timeout=60
            )

            if resp.status_code != 202:
                print(f"    Error creating task: {resp.status_code} {resp.text}")
                continue

            task_id = resp.json().get("result")
            print(f"    Task: {task_id}")

            # Poll for result (up to 10 minutes)
            for poll_count in range(60):
                time.sleep(10)
                status_resp = requests.get(
                    f"https://api.meshy.ai/openapi/v1/retexture/{task_id}",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=30
                )
                data = status_resp.json()
                status = data.get("status")
                progress = data.get("progress", 0)
                print(f"    [{poll_count*10}s] {status} {progress}%", end="\r")

                if status == "SUCCEEDED":
                    glb_url = data.get("model_urls", {}).get("glb")
                    if glb_url:
                        result = requests.get(glb_url, timeout=120)
                        out_path = output_dir / f"buildings_{chunk_key}.glb"
                        out_path.parent.mkdir(parents=True, exist_ok=True)

                        # Rescale to match original mesh bounds
                        out_path_temp = output_dir / f"buildings_{chunk_key}_temp.glb"
                        out_path_temp.write_bytes(result.content)

                        if rescale_to_original(chunk_path, out_path_temp, out_path):
                            out_path_temp.unlink()
                            print(f"\n    Saved (rescaled): {out_path.name}")
                        else:
                            out_path_temp.rename(out_path)
                            print(f"\n    Saved (no rescale): {out_path.name}")
                        return True
                    break
                elif status == "FAILED":
                    error = data.get("task_error", {}).get("message", "unknown")
                    print(f"    Failed: {error}")
                    break

            # If we get here, task didn't complete successfully
            if attempt < max_retries - 1:
                print(f"    Retrying ({attempt + 2}/{max_retries})...")
                time.sleep(30)  # Wait before retry

        except Exception as e:
            print(f"    Error: {e}")
            if attempt < max_retries - 1:
                time.sleep(30)

    return False


def main():
    parser = argparse.ArgumentParser(description="Texture building chunks with Meshy AI")
    parser.add_argument("--chunks", nargs="+", help="Specific chunks to process (e.g., 0_0 -1_1)")
    parser.add_argument("--dry-run", action="store_true", help="Check coverage without API calls")
    parser.add_argument("--prepare-only", action="store_true",
                        help="Prepare task files for manual upload (no API calls)")
    parser.add_argument("--run", action="store_true", help="Actually run texturing via Meshy API")
    parser.add_argument("--max-chunks", type=int, default=5, help="Max chunks to process in one run")
    args = parser.parse_args()

    api_key = os.environ.get("MESHY_API_KEY")

    if not api_key and not args.dry_run and not args.prepare_only:
        print("ERROR: MESHY_API_KEY not set")
        print("Set it with: export MESHY_API_KEY='your_key_here'")
        print()
        print("Or use --dry-run to check reference coverage")
        print("Or use --prepare-only to create task files for manual upload")
        return

    buildings_dir = PROCESSED_DIR / "buildings"
    output_dir = PROCESSED_DIR / "buildings_textured"
    tasks_dir = DATA_DIR / "meshy_tasks"

    # Find chunks to process
    if args.chunks:
        chunk_files = [buildings_dir / f"buildings_{c}.glb" for c in args.chunks]
        chunk_files = [f for f in chunk_files if f.exists()]
    else:
        chunk_files = sorted(buildings_dir.glob("buildings_*.glb"))

    if not chunk_files:
        print("No building chunks found!")
        return

    print(f"Processing {len(chunk_files)} chunks")
    print()

    # Statistics
    stats = {
        "total": len(chunk_files),
        "with_streetview": 0,
        "with_aerial": 0,
        "processed": 0,
        "failed": 0,
        "skipped": 0
    }

    for i, chunk_path in enumerate(chunk_files):
        chunk_key = chunk_path.stem.replace("buildings_", "")
        print(f"[{i+1}/{len(chunk_files)}] Chunk {chunk_key}")

        # Get reference images
        refs = get_reference_images(chunk_key)

        has_sv = refs["streetview_composite"] is not None
        has_aerial = refs["aerial"] is not None

        if has_sv:
            stats["with_streetview"] += 1
        if has_aerial:
            stats["with_aerial"] += 1

        print(f"  References: Street View={'Yes' if has_sv else 'No'}, Aerial={'Yes' if has_aerial else 'No'}")

        if args.dry_run:
            continue

        # Generate prompt
        prompt = generate_chunk_prompt(chunk_key, refs)

        if args.prepare_only:
            # Create task file for manual processing
            task_info = process_chunk_local(chunk_path, tasks_dir, refs, prompt)
            print(f"  Created task file: {tasks_dir}/{chunk_key}_task.json")
            stats["processed"] += 1
            continue

        if args.run:
            # Run actual Meshy API texturing
            if stats["processed"] >= args.max_chunks:
                print(f"  Skipping (reached max {args.max_chunks} chunks)")
                stats["skipped"] += 1
                continue

            # Check if already textured
            textured_path = PROCESSED_DIR / "buildings_textured" / f"buildings_{chunk_key}.glb"
            if textured_path.exists():
                print("  Skipping (already textured)")
                stats["skipped"] += 1
                continue

            # Prefer Street View composite (shows actual facades), fallback to aerial
            style_ref = refs["streetview_composite"] or refs["aerial"]

            if style_ref:
                output_dir = PROCESSED_DIR / "buildings_textured"
                success = texture_chunk_with_meshy(
                    chunk_path, style_ref, api_key, output_dir
                )
                if success:
                    stats["processed"] += 1
                else:
                    stats["failed"] += 1
            else:
                print("  Skipping (no reference imagery)")
                stats["skipped"] += 1
        else:
            print("  Use --run to process via Meshy API")

    # Summary
    print()
    print("=" * 50)
    print("SUMMARY")
    print("=" * 50)
    print(f"Total chunks: {stats['total']}")
    print(f"With Street View: {stats['with_streetview']} ({100*stats['with_streetview']/stats['total']:.0f}%)")
    print(f"With Aerial: {stats['with_aerial']} ({100*stats['with_aerial']/stats['total']:.0f}%)")

    if args.prepare_only:
        print(f"Task files created: {stats['processed']}")
        print(f"Task directory: {tasks_dir}")

    if args.run:
        print(f"Successfully textured: {stats['processed']}")
        print(f"Failed: {stats['failed']}")
        print(f"Output: {PROCESSED_DIR / 'buildings_textured'}")

    print()
    print("Next steps:")
    print("1. Run 55_fetch_streetview.py to download reference imagery")
    print("2. Host GLB files at public URLs (S3, GCS, etc.)")
    print("3. Upload to Meshy manually or implement API flow")


if __name__ == "__main__":
    main()
