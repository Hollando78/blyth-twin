/**
 * Water Shader Utilities
 *
 * Creates animated water surfaces using Three.js Water shader.
 * Supports both inland water bodies and sea/ocean.
 */

import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";

// Water configuration
export interface WaterConfig {
  textureWidth: number;
  textureHeight: number;
  waterColor: number;
  sunColor: number;
  distortionScale: number;
  fog: boolean;
  alpha: number;
}

// Default configurations
export const WATER_CONFIG: WaterConfig = {
  textureWidth: 512,
  textureHeight: 512,
  waterColor: 0x001e0f,
  sunColor: 0xffffff,
  distortionScale: 3.7,
  fog: true,
  alpha: 0.9,
};

export const SEA_CONFIG: WaterConfig = {
  textureWidth: 512,
  textureHeight: 512,
  waterColor: 0x001a33,
  sunColor: 0xffffff,
  distortionScale: 5.0,
  fog: true,
  alpha: 0.95,
};

// Cached water normal texture
let waterNormalsTexture: THREE.Texture | null = null;

/**
 * Generate a procedural water normal map
 * Creates a tileable wave pattern for water animation
 */
export function generateWaterNormals(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Create image data
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  // Generate wave pattern using multiple sine waves
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Calculate normal from height derivatives of multiple wave frequencies
      const scale = 0.1;

      // Derivatives of wave functions (for normal calculation)
      const dx = Math.cos((x / size) * Math.PI * 8) * Math.PI * 8 / size * 0.5 +
                 Math.cos((x / size) * Math.PI * 16 + 0.5) * Math.PI * 16 / size * 0.3;
      const dy = -Math.sin((y / size) * Math.PI * 8) * Math.PI * 8 / size * 0.5 +
                 -Math.sin((y / size) * Math.PI * 16 + 0.3) * Math.PI * 16 / size * 0.3;

      // Normalize and convert to RGB (128, 128, 255 = flat surface pointing up)
      const nx = Math.max(0, Math.min(255, 128 + dx * scale * 127));
      const ny = Math.max(0, Math.min(255, 128 + dy * scale * 127));
      const nz = 255;

      data[idx] = nx;
      data[idx + 1] = ny;
      data[idx + 2] = nz;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);

  return texture;
}

/**
 * Load or generate water normal texture
 */
export function getWaterNormalsTexture(): THREE.Texture {
  if (waterNormalsTexture) {
    return waterNormalsTexture;
  }

  // Generate procedural normals (more reliable than loading external files)
  waterNormalsTexture = generateWaterNormals();
  return waterNormalsTexture;
}

/**
 * Create an animated water surface
 */
export function createWater(
  geometry: THREE.BufferGeometry,
  sunLight: THREE.DirectionalLight,
  config: WaterConfig = WATER_CONFIG
): Water {
  const waterNormals = getWaterNormalsTexture();

  const water = new Water(geometry, {
    textureWidth: config.textureWidth,
    textureHeight: config.textureHeight,
    waterNormals: waterNormals,
    sunDirection: sunLight.position.clone().normalize(),
    sunColor: config.sunColor,
    waterColor: config.waterColor,
    distortionScale: config.distortionScale,
    fog: config.fog,
  });

  // Set alpha for transparency
  water.material.transparent = true;
  water.material.opacity = config.alpha;

  return water;
}

/**
 * Create a sea surface with larger waves
 */
export function createSea(
  geometry: THREE.BufferGeometry,
  sunLight: THREE.DirectionalLight
): Water {
  return createWater(geometry, sunLight, SEA_CONFIG);
}

/**
 * Update water animation (call in render loop)
 */
export function updateWater(water: Water, deltaTime: number): void {
  const material = water.material as THREE.ShaderMaterial;
  if (material.uniforms && material.uniforms["time"]) {
    material.uniforms["time"].value += deltaTime * 0.5;
  }
}

/**
 * Simple animated water material (fallback if Water shader not available)
 * Uses MeshBasicMaterial for reliable rendering without complex lighting
 */
export function createSimpleWaterMaterial(
  color: number = 0x4da6ff,
  opacity: number = 0.85
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: opacity,
    side: THREE.DoubleSide,
  });
}

/**
 * Create simple animated sea material
 */
export function createSimpleSeaMaterial(): THREE.MeshBasicMaterial {
  return createSimpleWaterMaterial(0x1a5c8c, 0.9);
}
