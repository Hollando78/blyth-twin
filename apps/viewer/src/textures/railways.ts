/**
 * Procedural Railway Texture Generator
 *
 * Generates railway track textures via Canvas API:
 * - Ballast (gravel) base
 * - Wooden sleepers at regular intervals
 * - Steel rails with weathering
 */

import * as THREE from "three";

// Railway texture configuration
interface RailwayTextureConfig {
  ballastColor: string;
  sleeperColor: string;
  railColor: string;
  sleeperSpacing: number; // pixels between sleepers
  sleeperWidth: number; // pixels
  sleeperHeight: number; // pixels (across track)
  railWidth: number; // pixels
  gauge: number; // pixels (distance between rails)
}

const RAILWAY_CONFIG: RailwayTextureConfig = {
  ballastColor: "#6b6b5a",
  sleeperColor: "#4a3c2a",
  railColor: "#5a5a5a",
  sleeperSpacing: 40,
  sleeperWidth: 12,
  sleeperHeight: 200,
  railWidth: 8,
  gauge: 100,
};

// Texture cache
let cachedRailwayTexture: THREE.Texture | null = null;
let cachedRailwayNormalMap: THREE.Texture | null = null;
let railwayTexturePromise: Promise<THREE.Texture> | null = null;
let railwayNormalMapPromise: Promise<THREE.Texture> | null = null;

/**
 * Generate gravel/ballast noise pattern
 */
function generateBallastTexture(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  // Base color
  ctx.fillStyle = RAILWAY_CONFIG.ballastColor;
  ctx.fillRect(0, 0, width, height);

  // Add individual gravel stones
  const stoneColors = ["#7a7a6a", "#5c5c4c", "#686858", "#545444", "#6a6a5a"];

  for (let i = 0; i < 800; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const size = 2 + Math.random() * 6;
    const color = stoneColors[Math.floor(Math.random() * stoneColors.length)];

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(
      x,
      y,
      size,
      size * (0.6 + Math.random() * 0.4),
      Math.random() * Math.PI,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // Add some darker shadows between stones
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const size = 1 + Math.random() * 3;

    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Draw wooden sleeper with grain texture
 */
function drawSleeper(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  // Base sleeper color
  ctx.fillStyle = RAILWAY_CONFIG.sleeperColor;
  ctx.fillRect(x - width / 2, y - height / 2, width, height);

  // Add wood grain lines
  ctx.strokeStyle = "#3a2c1a";
  ctx.lineWidth = 1;

  for (let i = 0; i < 5; i++) {
    const offsetY = y - height / 2 + (height / 6) * (i + 1);
    ctx.beginPath();
    ctx.moveTo(x - width / 2 + 2, offsetY + (Math.random() - 0.5) * 2);
    ctx.lineTo(x + width / 2 - 2, offsetY + (Math.random() - 0.5) * 2);
    ctx.stroke();
  }

  // Add some weathering/knots
  for (let i = 0; i < 3; i++) {
    const knotX = x - width / 2 + Math.random() * width;
    const knotY = y - height / 2 + Math.random() * height;
    ctx.fillStyle = "#2a1c0a";
    ctx.beginPath();
    ctx.arc(knotX, knotY, 2 + Math.random() * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Edge highlight (3D effect)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x - width / 2, y - height / 2, width, height);
}

/**
 * Draw steel rail with weathering
 */
function drawRail(
  ctx: CanvasRenderingContext2D,
  x: number,
  y1: number,
  y2: number,
  width: number
): void {
  // Rail base (darker steel)
  ctx.fillStyle = RAILWAY_CONFIG.railColor;
  ctx.fillRect(x - width / 2, y1, width, y2 - y1);

  // Rail head (shinier top surface)
  ctx.fillStyle = "#7a7a7a";
  ctx.fillRect(x - width / 2 + 1, y1, width - 2, y2 - y1);

  // Add some rust spots
  for (let i = 0; i < 10; i++) {
    const rustX = x - width / 2 + Math.random() * width;
    const rustY = y1 + Math.random() * (y2 - y1);
    ctx.fillStyle = `rgba(139, 90, 43, ${0.3 + Math.random() * 0.3})`;
    ctx.beginPath();
    ctx.arc(rustX, rustY, 1 + Math.random() * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight on rail head
  ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
  ctx.fillRect(x - 1, y1, 2, y2 - y1);
}

/**
 * Generate the main railway texture
 * Returns a Promise that resolves when the image is fully loaded
 */
export function generateRailwayTexture(): Promise<THREE.Texture> {
  if (cachedRailwayTexture) {
    return Promise.resolve(cachedRailwayTexture);
  }

  // Return existing promise if already loading
  if (railwayTexturePromise) {
    return railwayTexturePromise;
  }

  railwayTexturePromise = new Promise((resolve) => {
    const CANVAS_WIDTH = 256;
    const CANVAS_HEIGHT = 512;

    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d")!;

    // Generate ballast background
    generateBallastTexture(ctx, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Draw sleepers
    const centerX = CANVAS_WIDTH / 2;
    const numSleepers = Math.ceil(
      CANVAS_HEIGHT / RAILWAY_CONFIG.sleeperSpacing
    );

    for (let i = 0; i < numSleepers; i++) {
      const sleeperY = i * RAILWAY_CONFIG.sleeperSpacing + RAILWAY_CONFIG.sleeperSpacing / 2;
      drawSleeper(
        ctx,
        centerX,
        sleeperY,
        RAILWAY_CONFIG.sleeperWidth,
        RAILWAY_CONFIG.sleeperHeight
      );
    }

    // Draw rails
    const railOffset = RAILWAY_CONFIG.gauge / 2;
    drawRail(ctx, centerX - railOffset, 0, CANVAS_HEIGHT, RAILWAY_CONFIG.railWidth);
    drawRail(ctx, centerX + railOffset, 0, CANVAS_HEIGHT, RAILWAY_CONFIG.railWidth);

    // Convert canvas to image for Safari compatibility
    const dataUrl = canvas.toDataURL("image/png");
    const img = new Image();

    // CRITICAL: Wait for image to load before creating texture
    img.onload = () => {
      const texture = new THREE.Texture(img);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1, 1);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = true;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;

      cachedRailwayTexture = texture;
      resolve(texture);
    };

    // Set src AFTER onload handler is attached
    img.src = dataUrl;
  });

  return railwayTexturePromise;
}

/**
 * Generate a simple normal map for the railway
 * Adds depth to sleepers and rails
 * Returns a Promise that resolves when the image is fully loaded
 */
export function generateRailwayNormalMap(): Promise<THREE.Texture> {
  if (cachedRailwayNormalMap) {
    return Promise.resolve(cachedRailwayNormalMap);
  }

  // Return existing promise if already loading
  if (railwayNormalMapPromise) {
    return railwayNormalMapPromise;
  }

  railwayNormalMapPromise = new Promise((resolve) => {
    const CANVAS_WIDTH = 256;
    const CANVAS_HEIGHT = 512;

    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d")!;

    // Flat normal (pointing up) as base - RGB(128, 128, 255)
    ctx.fillStyle = "#8080ff";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Add bumps for ballast (random variations)
    for (let i = 0; i < 500; i++) {
      const x = Math.random() * CANVAS_WIDTH;
      const y = Math.random() * CANVAS_HEIGHT;
      const size = 2 + Math.random() * 4;

      // Slight normal variation
      const nx = Math.floor(128 + (Math.random() - 0.5) * 40);
      const ny = Math.floor(128 + (Math.random() - 0.5) * 40);
      ctx.fillStyle = `rgb(${nx}, ${ny}, 255)`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sleeper heights (raised areas)
    const centerX = CANVAS_WIDTH / 2;
    const numSleepers = Math.ceil(CANVAS_HEIGHT / RAILWAY_CONFIG.sleeperSpacing);

    for (let i = 0; i < numSleepers; i++) {
      const sleeperY = i * RAILWAY_CONFIG.sleeperSpacing + RAILWAY_CONFIG.sleeperSpacing / 2;
      const x = centerX - RAILWAY_CONFIG.sleeperWidth / 2;
      const y = sleeperY - RAILWAY_CONFIG.sleeperHeight / 2;

      // Top edge (facing up-ish)
      ctx.fillStyle = "#8090ff";
      ctx.fillRect(x, y, RAILWAY_CONFIG.sleeperWidth, 2);

      // Bottom edge
      ctx.fillStyle = "#8070ff";
      ctx.fillRect(x, y + RAILWAY_CONFIG.sleeperHeight - 2, RAILWAY_CONFIG.sleeperWidth, 2);
    }

    // Rail heights
    const railOffset = RAILWAY_CONFIG.gauge / 2;
    const railX1 = centerX - railOffset - RAILWAY_CONFIG.railWidth / 2;
    const railX2 = centerX + railOffset - RAILWAY_CONFIG.railWidth / 2;

    // Rails are highest points
    ctx.fillStyle = "#8888ff";
    ctx.fillRect(railX1, 0, RAILWAY_CONFIG.railWidth, CANVAS_HEIGHT);
    ctx.fillRect(railX2, 0, RAILWAY_CONFIG.railWidth, CANVAS_HEIGHT);

    // Convert canvas to image for consistency with other textures
    const dataUrl = canvas.toDataURL("image/png");
    const img = new Image();

    img.onload = () => {
      const texture = new THREE.Texture(img);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.needsUpdate = true;

      cachedRailwayNormalMap = texture;
      resolve(texture);
    };

    img.src = dataUrl;
  });

  return railwayNormalMapPromise;
}

/**
 * Create a railway material
 */
export async function createRailwayMaterial(): Promise<THREE.MeshBasicMaterial> {
  const texture = await generateRailwayTexture();

  // Use MeshBasicMaterial for flat surfaces - no shading needed
  return new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
  });
}

/**
 * Preload railway textures
 */
export async function preloadRailwayTextures(): Promise<void> {
  await Promise.all([
    generateRailwayTexture(),
    generateRailwayNormalMap(),
  ]);
}
