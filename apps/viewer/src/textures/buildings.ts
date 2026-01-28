/**
 * Procedural Building Texture Generator
 *
 * Generates simple brick textures via Canvas API
 */

import * as THREE from "three";

let cachedBrickTexture: THREE.Texture | null = null;
let brickTexturePromise: Promise<THREE.Texture> | null = null;

/**
 * Generate a simple brick texture
 * Returns a Promise that resolves when the image is fully loaded
 */
export function generateBrickTexture(): Promise<THREE.Texture> {
  if (cachedBrickTexture) {
    return Promise.resolve(cachedBrickTexture);
  }

  // Return existing promise if already loading (prevent duplicate loads)
  if (brickTexturePromise) {
    return brickTexturePromise;
  }

  brickTexturePromise = new Promise((resolve) => {
    const CANVAS_WIDTH = 256;
    const CANVAS_HEIGHT = 256;

    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      console.error("Failed to get 2d context for brick texture");
      // Return a simple colored texture as fallback
      const fallbackCanvas = document.createElement("canvas");
      fallbackCanvas.width = 64;
      fallbackCanvas.height = 64;
      const fallbackCtx = fallbackCanvas.getContext("2d")!;
      fallbackCtx.fillStyle = "#8b7355";
      fallbackCtx.fillRect(0, 0, 64, 64);
      const fallbackTexture = new THREE.CanvasTexture(fallbackCanvas);
      fallbackTexture.needsUpdate = true;
      resolve(fallbackTexture);
      return;
    }

    // Mortar color
    const mortarColor = "#a0a0a0";
    ctx.fillStyle = mortarColor;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Brick dimensions
    const brickWidth = 32;
    const brickHeight = 16;
    const mortarWidth = 2;

    // Brick colors (variations of red/brown)
    const brickColors = [
      "#8B4513", "#A0522D", "#8B5A2B", "#CD853F", "#9C6B3C",
      "#7C4A2D", "#8C5A3D", "#9A6348", "#885533", "#7B5544"
    ];

    const rows = Math.ceil(CANVAS_HEIGHT / brickHeight);
    const cols = Math.ceil(CANVAS_WIDTH / brickWidth) + 1;

    for (let row = 0; row < rows; row++) {
      // Offset every other row by half brick width
      const offset = (row % 2) * (brickWidth / 2);
      const y = row * brickHeight;

      for (let col = -1; col < cols; col++) {
        const x = col * brickWidth + offset;

        // Random brick color
        const color = brickColors[Math.floor(Math.random() * brickColors.length)];
        ctx.fillStyle = color;

        // Draw brick (slightly smaller than cell to show mortar)
        ctx.fillRect(
          x + mortarWidth / 2,
          y + mortarWidth / 2,
          brickWidth - mortarWidth,
          brickHeight - mortarWidth
        );

        // Add some texture variation within brick
        for (let i = 0; i < 5; i++) {
          const px = x + mortarWidth + Math.random() * (brickWidth - mortarWidth * 2);
          const py = y + mortarWidth + Math.random() * (brickHeight - mortarWidth * 2);
          const variation = Math.random() > 0.5 ? 15 : -15;
          ctx.fillStyle = `rgba(${128 + variation}, ${80 + variation}, ${60 + variation}, 0.3)`;
          ctx.fillRect(px, py, 2, 2);
        }
      }
    }

    // Convert canvas to image for better Safari compatibility
    // Safari desktop has issues with CanvasTexture not uploading to GPU properly
    const dataUrl = canvas.toDataURL("image/png");
    const img = new Image();

    // CRITICAL: Wait for image to load before creating texture
    // This fixes the race condition on fast desktop browsers
    img.onload = () => {
      const texture = new THREE.Texture(img);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;

      // Debug: verify texture was created properly
      console.log("Brick texture created:", {
        width: img.width,
        height: img.height,
        dataUrlLength: dataUrl.length,
      });

      cachedBrickTexture = texture;
      resolve(texture);
    };

    // Set src AFTER onload handler is attached
    img.src = dataUrl;
  });

  return brickTexturePromise;
}

/**
 * Create a building material with brick texture
 * Uses MeshStandardMaterial for PBR compatibility with Meshy AI textures
 */
export async function createBuildingMaterial(): Promise<THREE.MeshStandardMaterial> {
  const texture = await generateBrickTexture();

  return new THREE.MeshStandardMaterial({
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.9,  // Brick is quite rough
    metalness: 0.0,  // Non-metallic
  });
}
