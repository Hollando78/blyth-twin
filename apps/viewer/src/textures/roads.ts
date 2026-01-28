/**
 * Procedural Road Texture Generator
 *
 * Generates road textures via Canvas API at runtime:
 * - Asphalt base with noise
 * - Center line markings (varies by highway type)
 * - Edge markings for major roads
 */

import * as THREE from "three";

// Road texture configuration by highway type
export interface RoadTextureConfig {
  width: number; // Road width in metres
  hasCenter: boolean; // Center line marking
  centerColor: string; // Center line color (white or yellow)
  centerDashed: boolean; // Dashed or solid center line
  hasEdges: boolean; // Edge line markings
  asphaltColor: string; // Base asphalt color
}

// Road type configurations based on OSM highway tag
export const ROAD_CONFIGS: Record<string, RoadTextureConfig> = {
  motorway: {
    width: 25,
    hasCenter: true,
    centerColor: "#ffcc00",
    centerDashed: true,
    hasEdges: true,
    asphaltColor: "#2a2a2a",
  },
  trunk: {
    width: 15,
    hasCenter: true,
    centerColor: "#ffffff",
    centerDashed: true,
    hasEdges: true,
    asphaltColor: "#2d2d2d",
  },
  primary: {
    width: 15,
    hasCenter: true,
    centerColor: "#ffffff",
    centerDashed: true,
    hasEdges: true,
    asphaltColor: "#303030",
  },
  secondary: {
    width: 12,
    hasCenter: true,
    centerColor: "#ffffff",
    centerDashed: true,
    hasEdges: false,
    asphaltColor: "#333333",
  },
  tertiary: {
    width: 10,
    hasCenter: true,
    centerColor: "#ffffff",
    centerDashed: true,
    hasEdges: false,
    asphaltColor: "#353535",
  },
  residential: {
    width: 6,
    hasCenter: false,
    centerColor: "#ffffff",
    centerDashed: true,
    hasEdges: false,
    asphaltColor: "#383838",
  },
  unclassified: {
    width: 5,
    hasCenter: false,
    centerColor: "#ffffff",
    centerDashed: true,
    hasEdges: false,
    asphaltColor: "#3a3a3a",
  },
  service: {
    width: 4,
    hasCenter: false,
    centerColor: "#ffffff",
    centerDashed: false,
    hasEdges: false,
    asphaltColor: "#3c3c3c",
  },
  footway: {
    width: 2,
    hasCenter: false,
    centerColor: "#ffffff",
    centerDashed: false,
    hasEdges: false,
    asphaltColor: "#6b6b6b",
  },
  path: {
    width: 2,
    hasCenter: false,
    centerColor: "#ffffff",
    centerDashed: false,
    hasEdges: false,
    asphaltColor: "#7a6b5a",
  },
  cycleway: {
    width: 2.5,
    hasCenter: false,
    centerColor: "#ffffff",
    centerDashed: false,
    hasEdges: false,
    asphaltColor: "#4a6b4a",
  },
};

// Texture cache
const textureCache: Map<string, THREE.Texture> = new Map();
const texturePromiseCache: Map<string, Promise<THREE.Texture>> = new Map();

/**
 * Generate noise for asphalt texture
 */
function generateNoise(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  intensity: number = 0.15
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 255 * intensity;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Draw dashed line on canvas
 */
function drawDashedLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y1: number,
  y2: number,
  lineWidth: number,
  dashLength: number,
  gapLength: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([dashLength, gapLength]);
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.lineTo(x, y2);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Generate a road texture for a specific highway type
 * Returns a Promise that resolves when the image is fully loaded
 */
export function generateRoadTexture(
  highwayType: string = "residential"
): Promise<THREE.Texture> {
  const cacheKey = `road_${highwayType}`;

  if (textureCache.has(cacheKey)) {
    return Promise.resolve(textureCache.get(cacheKey)!);
  }

  // Return existing promise if already loading
  if (texturePromiseCache.has(cacheKey)) {
    return texturePromiseCache.get(cacheKey)!;
  }

  const config = ROAD_CONFIGS[highwayType] || ROAD_CONFIGS.residential;

  const promise = new Promise<THREE.Texture>((resolve) => {
    // Canvas size (texture resolution)
    const CANVAS_WIDTH = 256; // Across road width
    const CANVAS_HEIGHT = 512; // Along road length (tiled)

    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      console.error("Failed to get 2d context for road texture!");
      // Return a fallback colored texture
      const fallbackCanvas = document.createElement("canvas");
      fallbackCanvas.width = 64;
      fallbackCanvas.height = 64;
      const fallbackCtx = fallbackCanvas.getContext("2d")!;
      fallbackCtx.fillStyle = "#ff00ff"; // Magenta = error
      fallbackCtx.fillRect(0, 0, 64, 64);
      const fallbackTexture = new THREE.CanvasTexture(fallbackCanvas);
      fallbackTexture.needsUpdate = true;
      resolve(fallbackTexture);
      return;
    }

    // Fill with asphalt base color
    ctx.fillStyle = config.asphaltColor;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Add noise for realistic asphalt texture
    generateNoise(ctx, CANVAS_WIDTH, CANVAS_HEIGHT, 0.12);

    // Add some larger aggregate/patch variation
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * CANVAS_WIDTH;
      const y = Math.random() * CANVAS_HEIGHT;
      const size = 3 + Math.random() * 8;
      const brightness = Math.random() > 0.5 ? 10 : -10;
      ctx.fillStyle = `rgba(${128 + brightness}, ${128 + brightness}, ${128 + brightness}, 0.3)`;
      ctx.beginPath();
      ctx.ellipse(x, y, size, size * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    // Line marking dimensions (scaled to texture)
    const LINE_WIDTH = 8; // pixels
    const CENTER_X = CANVAS_WIDTH / 2;
    const EDGE_MARGIN = 15;

    // Draw center line
    if (config.hasCenter) {
      if (config.centerDashed) {
        drawDashedLine(
          ctx,
          CENTER_X,
          0,
          CANVAS_HEIGHT,
          LINE_WIDTH,
          40,
          30,
          config.centerColor
        );
      } else {
        ctx.strokeStyle = config.centerColor;
        ctx.lineWidth = LINE_WIDTH;
        ctx.beginPath();
        ctx.moveTo(CENTER_X, 0);
        ctx.lineTo(CENTER_X, CANVAS_HEIGHT);
        ctx.stroke();
      }
    }

    // Draw edge lines
    if (config.hasEdges) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = LINE_WIDTH * 0.8;

      // Left edge
      ctx.beginPath();
      ctx.moveTo(EDGE_MARGIN, 0);
      ctx.lineTo(EDGE_MARGIN, CANVAS_HEIGHT);
      ctx.stroke();

      // Right edge
      ctx.beginPath();
      ctx.moveTo(CANVAS_WIDTH - EDGE_MARGIN, 0);
      ctx.lineTo(CANVAS_WIDTH - EDGE_MARGIN, CANVAS_HEIGHT);
      ctx.stroke();
    }

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

      textureCache.set(cacheKey, texture);
      resolve(texture);
    };

    // Set src AFTER onload handler is attached
    img.src = dataUrl;
  });

  texturePromiseCache.set(cacheKey, promise);
  return promise;
}

/**
 * Create a road material for a specific highway type
 */
export async function createRoadMaterial(
  highwayType: string = "residential"
): Promise<THREE.MeshBasicMaterial> {
  const texture = await generateRoadTexture(highwayType);

  // Use MeshBasicMaterial for flat surfaces - no shading needed
  return new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
  });
}

/**
 * Get a shared road material (uses default residential texture)
 * For use when all roads share one material
 */
export async function getSharedRoadMaterial(): Promise<THREE.MeshBasicMaterial> {
  return createRoadMaterial("residential");
}

/**
 * Preload all road textures
 */
export async function preloadRoadTextures(): Promise<void> {
  const promises = Object.keys(ROAD_CONFIGS).map((type) =>
    generateRoadTexture(type)
  );
  await Promise.all(promises);
}
