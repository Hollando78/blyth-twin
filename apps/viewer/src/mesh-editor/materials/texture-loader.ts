/**
 * Texture Loader
 *
 * Drag-drop texture loading with preview.
 * Features:
 * - Supports common image formats (PNG, JPG, WebP)
 * - Generates mipmaps
 * - Handles texture wrapping modes
 * - Preview before applying
 */

import * as THREE from "three";

export interface TextureLoadResult {
  texture: THREE.Texture;
  width: number;
  height: number;
  format: string;
}

/**
 * Load a texture from a File object.
 */
export function loadTextureFromFile(file: File): Promise<TextureLoadResult> {
  return new Promise((resolve, reject) => {
    // Validate file type
    const validTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!validTypes.includes(file.type)) {
      reject(new Error(`Unsupported image format: ${file.type}`));
      return;
    }

    // Create object URL
    const url = URL.createObjectURL(file);

    // Load texture
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (texture) => {
        // Clean up object URL
        URL.revokeObjectURL(url);

        // Configure texture
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;

        // Get image dimensions
        const image = texture.image as HTMLImageElement;

        resolve({
          texture,
          width: image.width,
          height: image.height,
          format: file.type,
        });
      },
      undefined,
      (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      }
    );
  });
}

/**
 * Load a texture from a URL.
 */
export function loadTextureFromUrl(url: string): Promise<TextureLoadResult> {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (texture) => {
        // Configure texture
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;

        // Get image dimensions
        const image = texture.image as HTMLImageElement;

        resolve({
          texture,
          width: image.width,
          height: image.height,
          format: "unknown",
        });
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

/**
 * Load a texture from a data URL (base64).
 */
export function loadTextureFromDataUrl(dataUrl: string): Promise<TextureLoadResult> {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      dataUrl,
      (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;

        const image = texture.image as HTMLImageElement;

        // Extract format from data URL
        const formatMatch = dataUrl.match(/^data:image\/(\w+);/);
        const format = formatMatch ? formatMatch[1] : "unknown";

        resolve({
          texture,
          width: image.width,
          height: image.height,
          format: `image/${format}`,
        });
      },
      undefined,
      (error) => {
        reject(error);
      }
    );
  });
}

/**
 * Create a solid color texture.
 */
export function createColorTexture(
  color: THREE.Color | string | number,
  size: number = 4
): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d")!;
  const threeColor = new THREE.Color(color);
  ctx.fillStyle = `#${threeColor.getHexString()}`;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;

  return texture;
}

/**
 * Create a checker pattern texture.
 */
export function createCheckerTexture(
  color1: THREE.Color | string | number = 0xffffff,
  color2: THREE.Color | string | number = 0xcccccc,
  size: number = 64,
  squares: number = 8
): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d")!;
  const squareSize = size / squares;

  const c1 = new THREE.Color(color1);
  const c2 = new THREE.Color(color2);

  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      ctx.fillStyle =
        (x + y) % 2 === 0 ? `#${c1.getHexString()}` : `#${c2.getHexString()}`;
      ctx.fillRect(x * squareSize, y * squareSize, squareSize, squareSize);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  return texture;
}

/**
 * Create a procedural grid texture.
 */
export function createGridTexture(
  lineColor: THREE.Color | string | number = 0x333333,
  backgroundColor: THREE.Color | string | number = 0x666666,
  size: number = 64,
  lineWidth: number = 2
): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d")!;
  const bgColor = new THREE.Color(backgroundColor);
  const fgColor = new THREE.Color(lineColor);

  // Fill background
  ctx.fillStyle = `#${bgColor.getHexString()}`;
  ctx.fillRect(0, 0, size, size);

  // Draw grid lines
  ctx.strokeStyle = `#${fgColor.getHexString()}`;
  ctx.lineWidth = lineWidth;

  // Vertical line
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, size);
  ctx.stroke();

  // Horizontal line
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, 0);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;

  return texture;
}

/**
 * Set texture tiling/repeat.
 */
export function setTextureRepeat(
  texture: THREE.Texture,
  repeatX: number,
  repeatY: number
): void {
  texture.repeat.set(repeatX, repeatY);
  texture.needsUpdate = true;
}

/**
 * Set texture offset.
 */
export function setTextureOffset(
  texture: THREE.Texture,
  offsetX: number,
  offsetY: number
): void {
  texture.offset.set(offsetX, offsetY);
  texture.needsUpdate = true;
}

/**
 * Set texture rotation (in radians).
 */
export function setTextureRotation(
  texture: THREE.Texture,
  rotation: number,
  centerX: number = 0.5,
  centerY: number = 0.5
): void {
  texture.rotation = rotation;
  texture.center.set(centerX, centerY);
  texture.needsUpdate = true;
}

/**
 * Dispose of a texture and free memory.
 */
export function disposeTexture(texture: THREE.Texture | null): void {
  if (texture) {
    texture.dispose();
  }
}

/**
 * Clone a texture with all settings.
 */
export function cloneTexture(texture: THREE.Texture): THREE.Texture {
  const clone = texture.clone();
  clone.wrapS = texture.wrapS;
  clone.wrapT = texture.wrapT;
  clone.repeat.copy(texture.repeat);
  clone.offset.copy(texture.offset);
  clone.rotation = texture.rotation;
  clone.center.copy(texture.center);
  clone.minFilter = texture.minFilter;
  clone.magFilter = texture.magFilter;
  clone.generateMipmaps = texture.generateMipmaps;
  return clone;
}

/**
 * Get texture info for display.
 */
export function getTextureInfo(texture: THREE.Texture): {
  width: number;
  height: number;
  format: string;
  encoding: string;
} {
  const image = texture.image;

  return {
    width: image?.width || 0,
    height: image?.height || 0,
    format: String(texture.format),
    encoding: texture.colorSpace || "unknown",
  };
}
