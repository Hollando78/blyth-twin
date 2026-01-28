#!/usr/bin/env python3
"""
52_create_facade_atlas.py - Building Facade Texture Atlas

Creates a texture atlas for building facades by either:
1. Downloading textures from Poly Haven (CC0)
2. Generating procedural brick/concrete textures as fallback

Output:
    - data/processed/textures/facade_atlas.png
    - data/processed/textures/facade_normal_atlas.png
    - data/processed/textures/facade_atlas_meta.json

Usage:
    python 52_create_facade_atlas.py
"""

import json
import math
import random
from pathlib import Path

import yaml

try:
    from PIL import Image, ImageDraw, ImageFilter
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    Image = None  # type: ignore
    ImageDraw = None  # type: ignore
    ImageFilter = None  # type: ignore
    print("Warning: Pillow not installed. Install with: pip install Pillow")

# Paths
SCRIPT_DIR = Path(__file__).parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
TEXTURE_DIR = DATA_DIR / "processed" / "textures"
TEXTURE_SOURCE_DIR = DATA_DIR / "raw" / "textures"


def load_config() -> dict:
    """Load facade configuration."""
    with open(CONFIG_DIR / "facades.yaml") as f:
        return yaml.safe_load(f)


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """Convert hex color to RGB tuple."""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def generate_brick_texture(width: int, height: int, color: tuple[int, int, int],
                           mortar_color: tuple[int, int, int] = (180, 180, 175)) -> "Image.Image":
    """Generate a procedural brick texture."""
    img = Image.new('RGB', (width, height), mortar_color)
    draw = ImageDraw.Draw(img)

    # Brick dimensions
    brick_width = width // 8
    brick_height = height // 16
    mortar_width = max(2, brick_width // 12)

    rows = height // brick_height + 1

    for row in range(rows):
        offset = (brick_width // 2) if row % 2 else 0
        y1 = row * brick_height
        y2 = y1 + brick_height - mortar_width

        cols = width // brick_width + 2
        for col in range(-1, cols):
            x1 = col * brick_width + offset
            x2 = x1 + brick_width - mortar_width

            # Vary brick color slightly
            r = max(0, min(255, color[0] + random.randint(-15, 15)))
            g = max(0, min(255, color[1] + random.randint(-15, 15)))
            b = max(0, min(255, color[2] + random.randint(-15, 15)))
            brick_color = (r, g, b)

            draw.rectangle([x1, y1, x2, y2], fill=brick_color)

            # Add subtle texture variation within brick
            for _ in range(3):
                px_min = max(0, int(x1))
                px_max = min(width - 1, int(x2))
                py_min = max(0, int(y1))
                py_max = min(height - 1, int(y2))
                if px_max > px_min and py_max > py_min:
                    px = random.randint(px_min, px_max)
                    py = random.randint(py_min, py_max)
                    variation = random.randint(-10, 10)
                    pcolor = (
                        max(0, min(255, r + variation)),
                        max(0, min(255, g + variation)),
                        max(0, min(255, b + variation))
                    )
                    if 0 <= px < width and 0 <= py < height:
                        img.putpixel((px, py), pcolor)

    return img


def generate_concrete_texture(width: int, height: int, color: tuple[int, int, int]) -> "Image.Image":
    """Generate a procedural concrete texture."""
    img = Image.new('RGB', (width, height), color)
    draw = ImageDraw.Draw(img)

    # Add noise variation
    for y in range(height):
        for x in range(width):
            noise = random.randint(-20, 20)
            r = max(0, min(255, color[0] + noise))
            g = max(0, min(255, color[1] + noise))
            b = max(0, min(255, color[2] + noise))
            img.putpixel((x, y), (r, g, b))

    # Add some larger patches
    for _ in range(20):
        px = random.randint(0, width)
        py = random.randint(0, height)
        radius = random.randint(10, 40)
        variation = random.randint(-15, 15)
        patch_color = (
            max(0, min(255, color[0] + variation)),
            max(0, min(255, color[1] + variation)),
            max(0, min(255, color[2] + variation))
        )
        draw.ellipse([px-radius, py-radius, px+radius, py+radius], fill=patch_color)

    # Slight blur for smoother appearance
    img = img.filter(ImageFilter.GaussianBlur(radius=1))

    return img


def generate_stone_texture(width: int, height: int, color: tuple[int, int, int]) -> "Image.Image":
    """Generate a procedural stone/ashlar texture."""
    img = Image.new('RGB', (width, height), (150, 150, 145))
    draw = ImageDraw.Draw(img)

    # Stone block dimensions (larger than bricks)
    stone_width = width // 4
    stone_height = height // 6
    mortar_width = max(3, stone_width // 15)

    rows = height // stone_height + 1

    for row in range(rows):
        # Vary offset per row
        offset = random.randint(0, stone_width // 2) if row % 2 else 0
        y1 = row * stone_height
        y2 = y1 + stone_height - mortar_width

        cols = width // stone_width + 2
        for col in range(-1, cols):
            # Vary stone width slightly
            sw = stone_width + random.randint(-stone_width//8, stone_width//8)
            x1 = col * stone_width + offset
            x2 = x1 + sw - mortar_width

            # Vary stone color
            r = max(0, min(255, color[0] + random.randint(-25, 25)))
            g = max(0, min(255, color[1] + random.randint(-25, 25)))
            b = max(0, min(255, color[2] + random.randint(-25, 25)))
            stone_color = (r, g, b)

            draw.rectangle([x1, y1, x2, y2], fill=stone_color)

    return img


def generate_metal_texture(width: int, height: int, color: tuple[int, int, int]) -> "Image.Image":
    """Generate a procedural metal cladding texture."""
    img = Image.new('RGB', (width, height), color)
    draw = ImageDraw.Draw(img)

    # Vertical ribs
    rib_spacing = width // 16
    for x in range(0, width, rib_spacing):
        # Highlight
        highlight = (
            min(255, color[0] + 30),
            min(255, color[1] + 30),
            min(255, color[2] + 30)
        )
        draw.line([(x, 0), (x, height)], fill=highlight, width=2)

        # Shadow
        shadow = (
            max(0, color[0] - 20),
            max(0, color[1] - 20),
            max(0, color[2] - 20)
        )
        draw.line([(x + 2, 0), (x + 2, height)], fill=shadow, width=1)

    # Add some weathering/dirt streaks
    for _ in range(10):
        x = random.randint(0, width)
        y1 = random.randint(0, height // 2)
        y2 = y1 + random.randint(50, 150)
        streak_color = (
            max(0, color[0] - 30),
            max(0, color[1] - 30),
            max(0, color[2] - 25)
        )
        draw.line([(x, y1), (x, y2)], fill=streak_color, width=random.randint(1, 3))

    return img


def generate_texture(name: str, width: int, height: int, fallback_color: str) -> "Image.Image":
    """Generate a texture based on its name."""
    color = hex_to_rgb(fallback_color)

    if 'brick' in name:
        return generate_brick_texture(width, height, color)
    elif 'stone' in name or 'sandstone' in name or 'limestone' in name:
        return generate_stone_texture(width, height, color)
    elif 'metal' in name or 'corrugated' in name:
        return generate_metal_texture(width, height, color)
    elif 'glass' in name:
        # Glass is mostly transparent/reflective - use solid color
        img = Image.new('RGB', (width, height), color)
        # Add slight grid for window frames
        draw = ImageDraw.Draw(img)
        frame_color = (80, 80, 80)
        spacing = width // 4
        for x in range(0, width, spacing):
            draw.line([(x, 0), (x, height)], fill=frame_color, width=2)
        for y in range(0, height, spacing):
            draw.line([(0, y), (width, y)], fill=frame_color, width=2)
        return img
    elif 'wood' in name:
        # Simple wood grain
        img = Image.new('RGB', (width, height), color)
        draw = ImageDraw.Draw(img)
        for y in range(0, height, 4):
            grain_color = (
                max(0, color[0] + random.randint(-20, 20)),
                max(0, color[1] + random.randint(-20, 20)),
                max(0, color[2] + random.randint(-20, 20))
            )
            draw.line([(0, y), (width, y)], fill=grain_color, width=1)
        return img
    else:
        return generate_concrete_texture(width, height, color)


def generate_normal_map(source_img: Image.Image) -> "Image.Image":
    """Generate a simple normal map from a source image."""
    # Convert to grayscale for height
    gray = source_img.convert('L')
    width, height = gray.size

    # Create normal map (RGB where R=X, G=Y, B=Z)
    normal = Image.new('RGB', (width, height), (128, 128, 255))
    pixels = normal.load()
    gray_pixels = gray.load()

    for y in range(1, height - 1):
        for x in range(1, width - 1):
            # Sobel-like operator
            left = gray_pixels[x - 1, y]
            right = gray_pixels[x + 1, y]
            up = gray_pixels[x, y - 1]
            down = gray_pixels[x, y + 1]

            # Calculate normal
            dx = (right - left) / 255.0
            dy = (down - up) / 255.0

            # Convert to normal map format (0-255)
            nx = int((dx + 1) * 127.5)
            ny = int((dy + 1) * 127.5)
            nz = 255  # Always pointing up

            pixels[x, y] = (nx, ny, nz)

    return normal


def create_atlas(config: dict) -> tuple[Image.Image, Image.Image, dict]:
    """Create the texture atlas and normal map atlas."""
    atlas_size = config['atlas']['size']
    tile_size = config['atlas']['tile_size']

    # Create blank atlases
    atlas = Image.new('RGB', (atlas_size, atlas_size), (128, 128, 128))
    normal_atlas = Image.new('RGB', (atlas_size, atlas_size), (128, 128, 255))

    metadata = {
        'size': atlas_size,
        'tile_size': tile_size,
        'textures': {}
    }

    textures_config = config['textures']

    for tex_name, tex_info in textures_config.items():
        row, col = tex_info['slot']
        fallback_color = tex_info['color_fallback']

        # Try to load source texture, fall back to procedural
        source_path = TEXTURE_SOURCE_DIR / tex_info['source']
        if source_path.exists() and HAS_PIL:
            try:
                tex_img = Image.open(source_path).convert('RGB')
                tex_img = tex_img.resize((tile_size, tile_size), Image.LANCZOS)
            except Exception as e:
                print(f"  Warning: Could not load {source_path}: {e}")
                tex_img = generate_texture(tex_name, tile_size, tile_size, fallback_color)
        else:
            tex_img = generate_texture(tex_name, tile_size, tile_size, fallback_color)

        # Calculate position in atlas
        x = col * tile_size
        y = row * tile_size

        # Paste into atlas
        atlas.paste(tex_img, (x, y))

        # Generate and paste normal map
        normal_img = generate_normal_map(tex_img)
        normal_atlas.paste(normal_img, (x, y))

        # Store metadata
        metadata['textures'][tex_name] = {
            'slot': [row, col],
            'uv_offset': [col / config['atlas']['grid'], row / config['atlas']['grid']],
            'uv_scale': 1.0 / config['atlas']['grid'],
            'color_fallback': fallback_color
        }

        print(f"  Added {tex_name} at slot [{row}, {col}]")

    return atlas, normal_atlas, metadata


def main():
    """Generate facade atlas."""
    if not HAS_PIL:
        print("Error: Pillow is required for atlas generation")
        print("Install with: pip install Pillow")
        return

    print("Loading configuration...")
    config = load_config()

    # Create output directory
    TEXTURE_DIR.mkdir(parents=True, exist_ok=True)
    TEXTURE_SOURCE_DIR.mkdir(parents=True, exist_ok=True)

    print("\nGenerating facade atlas...")
    atlas, normal_atlas, metadata = create_atlas(config)

    # Save outputs
    atlas_path = TEXTURE_DIR / "facade_atlas.png"
    normal_path = TEXTURE_DIR / "facade_normal_atlas.png"
    meta_path = TEXTURE_DIR / "facade_atlas_meta.json"

    atlas.save(atlas_path, "PNG")
    print(f"\nSaved: {atlas_path}")

    normal_atlas.save(normal_path, "PNG")
    print(f"Saved: {normal_path}")

    # Add building type mappings to metadata
    metadata['building_types'] = config['building_types']

    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"Saved: {meta_path}")

    print("\nAtlas generation complete!")
    print(f"  Size: {config['atlas']['size']}x{config['atlas']['size']} pixels")
    print(f"  Textures: {len(metadata['textures'])}")


if __name__ == "__main__":
    main()
