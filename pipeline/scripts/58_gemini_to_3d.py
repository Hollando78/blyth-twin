#!/usr/bin/env python3
"""
58_gemini_to_3d.py - Street View → Gemini → Image-to-3D Pipeline

Creates 3D building models using:
1. Street View imagery as input
2. Gemini 2.5 to generate "3D printed model" style image
3. Meshy image-to-3D to convert to actual GLB

Usage:
    # With Gemini API key:
    export GEMINI_API_KEY="your_key"
    export MESHY_API_KEY="your_key"
    python 58_gemini_to_3d.py --postcode "NE24 4LP"

    # Manual Gemini (outputs instructions):
    python 58_gemini_to_3d.py --postcode "NE24 4LP" --manual-gemini
"""

import argparse
import base64
import json
import os
import time
from pathlib import Path

import requests

# Paths
SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
REFERENCE_DIR = DATA_DIR / "reference"
OUTPUT_DIR = DATA_DIR / "processed" / "buildings_gemini"

# Gemini prompt from Nano Banana blog
GEMINI_PROMPT = """Use the provided architectural photo as reference.
Generate a high-fidelity 3D building model in the look of a 3D printed architecture model.
Show the buildings from a 45-degree aerial view angle.
Include all visible buildings in the scene as a cohesive neighborhood model."""


def get_postcode_info(postcode: str) -> dict:
    """Get centroid and chunk info for a postcode."""
    from pyproj import Transformer
    from shapely.geometry import shape
    import numpy as np

    # Load buildings
    with open(DATA_DIR / "processed" / "buildings_height.geojson") as f:
        buildings = json.load(f)

    # Load AOI origin
    with open(SCRIPT_DIR.parent / "config" / "aoi.geojson") as f:
        aoi = json.load(f)
        origin = aoi['features'][0]['properties']['centre_bng']

    # Find buildings with this postcode
    centroids = []
    building_ids = []
    for feat in buildings['features']:
        props = feat['properties']
        if props.get('addr:postcode') == postcode:
            geom = shape(feat['geometry'])
            c = geom.centroid
            centroids.append([c.x, c.y])
            building_ids.append(props.get('id'))

    if not centroids:
        return None

    centroids = np.array(centroids)
    center_wgs84 = centroids.mean(axis=0)  # lon, lat

    # Convert to BNG for chunk calculation
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    x, y = transformer.transform(center_wgs84[0], center_wgs84[1])

    local_x = x - origin[0]
    local_y = y - origin[1]

    chunk_x = int(local_x // 500)
    chunk_y = int(local_y // 500)

    return {
        "postcode": postcode,
        "building_count": len(centroids),
        "building_ids": building_ids,
        "center_wgs84": {"lat": center_wgs84[1], "lon": center_wgs84[0]},
        "center_bng": {"x": x, "y": y},
        "local_coords": {"x": local_x, "y": local_y},
        "chunk": f"{chunk_x}_{chunk_y}",
        "origin": origin
    }


def get_streetview_image(chunk: str) -> Path | None:
    """Get Street View composite image for a chunk."""
    composite = REFERENCE_DIR / "streetview" / chunk / "composite.jpg"
    if composite.exists():
        return composite

    # Try individual images
    sv_dir = REFERENCE_DIR / "streetview" / chunk
    if sv_dir.exists():
        images = sorted(sv_dir.glob("h*.jpg"))
        if images:
            return images[0]

    return None


def call_gemini_api(image_path: Path, api_key: str) -> Path | None:
    """Call Gemini API to generate 3D model image."""
    import google.generativeai as genai

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel('gemini-2.0-flash-exp')

    # Load and encode image
    with open(image_path, "rb") as f:
        image_data = f.read()

    # Create the prompt with image
    response = model.generate_content([
        GEMINI_PROMPT,
        {"mime_type": "image/jpeg", "data": image_data}
    ])

    # Extract generated image (if any)
    # Note: Gemini's image generation capabilities vary by model
    # This may need adjustment based on actual API response

    if response.candidates and response.candidates[0].content.parts:
        for part in response.candidates[0].content.parts:
            if hasattr(part, 'inline_data') and part.inline_data:
                output_path = OUTPUT_DIR / "gemini_output.png"
                output_path.parent.mkdir(parents=True, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(base64.b64decode(part.inline_data.data))
                return output_path

    return None


def manual_gemini_instructions(image_path: Path, postcode: str):
    """Print instructions for manual Gemini processing."""
    print("\n" + "=" * 60)
    print("MANUAL GEMINI PROCESSING")
    print("=" * 60)
    print(f"\n1. Open: https://aistudio.google.com/")
    print(f"2. Select Gemini 2.0 Flash (or 2.5 if available)")
    print(f"3. Upload this image: {image_path}")
    print(f"\n4. Use this prompt:")
    print("-" * 40)
    print(GEMINI_PROMPT)
    print("-" * 40)
    print(f"\n5. Save the generated image to:")
    output_path = OUTPUT_DIR / f"{postcode.replace(' ', '_')}_gemini.png"
    print(f"   {output_path}")
    print(f"\n6. Then run:")
    print(f"   python 58_gemini_to_3d.py --postcode \"{postcode}\" --from-gemini-image {output_path}")
    print("=" * 60)


def image_to_3d_meshy(image_path: Path, api_key: str, output_name: str) -> Path | None:
    """Convert image to 3D using Meshy's image-to-3D API."""

    # Read and encode image
    with open(image_path, "rb") as f:
        img_base64 = base64.b64encode(f.read()).decode()

    # Determine mime type
    suffix = image_path.suffix.lower()
    mime_type = "image/png" if suffix == ".png" else "image/jpeg"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    # Create image-to-3D task
    payload = {
        "image_url": f"data:{mime_type};base64,{img_base64}",
        "ai_model": "meshy-4",
        "topology": "quad",
        "target_polycount": 30000,
    }

    print("  Creating Meshy image-to-3D task...")
    resp = requests.post(
        "https://api.meshy.ai/openapi/v1/image-to-3d",
        headers=headers,
        json=payload,
        timeout=60
    )

    if resp.status_code not in [200, 201, 202]:
        print(f"  Error: {resp.status_code} - {resp.text}")
        return None

    task_id = resp.json().get("result")
    print(f"  Task ID: {task_id}")

    # Poll for completion
    for i in range(90):  # Up to 15 minutes
        time.sleep(10)
        status_resp = requests.get(
            f"https://api.meshy.ai/openapi/v1/image-to-3d/{task_id}",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30
        )

        if status_resp.status_code != 200:
            continue

        data = status_resp.json()
        status = data.get("status")
        progress = data.get("progress", 0)
        print(f"  [{i*10}s] {status} {progress}%", end="\r")

        if status == "SUCCEEDED":
            print()
            glb_url = data.get("model_urls", {}).get("glb")
            if glb_url:
                result = requests.get(glb_url, timeout=120)
                output_path = OUTPUT_DIR / f"{output_name}.glb"
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(result.content)
                print(f"  Saved: {output_path}")
                return output_path
            break
        elif status == "FAILED":
            print(f"\n  Failed: {data.get('task_error', {}).get('message', 'unknown')}")
            return None

    print("\n  Timeout")
    return None


def main():
    parser = argparse.ArgumentParser(description="Street View → Gemini → 3D pipeline")
    parser.add_argument("--postcode", required=True, help="UK postcode to process")
    parser.add_argument("--manual-gemini", action="store_true",
                        help="Print instructions for manual Gemini processing")
    parser.add_argument("--from-gemini-image", type=Path,
                        help="Skip Gemini, use this pre-generated image")
    parser.add_argument("--skip-meshy", action="store_true",
                        help="Skip Meshy conversion, just prepare Gemini input")
    args = parser.parse_args()

    # Get API keys
    gemini_key = os.environ.get("GEMINI_API_KEY")
    meshy_key = os.environ.get("MESHY_API_KEY")

    print(f"\nProcessing postcode: {args.postcode}")
    print("=" * 50)

    # Get postcode info
    info = get_postcode_info(args.postcode)
    if not info:
        print(f"Error: No buildings found for postcode {args.postcode}")
        return

    print(f"Buildings: {info['building_count']}")
    print(f"Chunk: {info['chunk']}")
    print(f"Center: {info['center_wgs84']['lat']:.6f}, {info['center_wgs84']['lon']:.6f}")

    # Get Street View image
    sv_image = get_streetview_image(info['chunk'])
    if not sv_image:
        print(f"Error: No Street View imagery for chunk {info['chunk']}")
        return

    print(f"Street View: {sv_image}")

    # Gemini processing
    gemini_output = None

    if args.from_gemini_image:
        # Use pre-generated Gemini image
        if args.from_gemini_image.exists():
            gemini_output = args.from_gemini_image
            print(f"Using Gemini image: {gemini_output}")
        else:
            print(f"Error: Gemini image not found: {args.from_gemini_image}")
            return
    elif args.manual_gemini or not gemini_key:
        # Manual processing instructions
        manual_gemini_instructions(sv_image, args.postcode)
        if args.skip_meshy:
            return
        print("\nTo continue with Meshy after generating Gemini image:")
        print(f"  python 58_gemini_to_3d.py --postcode \"{args.postcode}\" --from-gemini-image <path>")
        return
    else:
        # API processing
        print("\nCalling Gemini API...")
        gemini_output = call_gemini_api(sv_image, gemini_key)
        if not gemini_output:
            print("Error: Gemini API failed to generate image")
            print("Try --manual-gemini for manual processing")
            return

    # Meshy image-to-3D
    if args.skip_meshy:
        print(f"\nGemini output: {gemini_output}")
        return

    if not meshy_key:
        print("\nError: MESHY_API_KEY not set")
        print("Set it and run with --from-gemini-image")
        return

    print("\nConverting to 3D with Meshy...")
    output_name = args.postcode.replace(" ", "_")
    glb_path = image_to_3d_meshy(gemini_output, meshy_key, output_name)

    if glb_path:
        print("\n" + "=" * 50)
        print("SUCCESS!")
        print(f"Output: {glb_path}")
        print(f"\nTo view: copy to viewer public/assets/ and add to manifest")

        # Save metadata for positioning
        meta_path = OUTPUT_DIR / f"{output_name}_meta.json"
        with open(meta_path, "w") as f:
            json.dump(info, f, indent=2)
        print(f"Metadata: {meta_path}")


if __name__ == "__main__":
    main()
