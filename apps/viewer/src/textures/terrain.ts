/**
 * Terrain Texture Loader
 *
 * Loads satellite/aerial imagery tiles from free tile services
 * and applies them to terrain chunks.
 */

import * as THREE from "three";

// Tile service configuration
// Using ESRI World Imagery - supports CORS when accessed correctly
const ESRI_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

// Alternative tile services (uncomment to try):
// OpenStreetMap (not satellite, but reliable CORS)
// const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

// Stamen Terrain (styled terrain, good CORS support) - now hosted by Stadia
// const STAMEN_TILE_URL = "https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png";

// Use ESRI by default
const TILE_URL = ESRI_TILE_URL;

// DTM bounds in WGS84 - MUST match the actual DTM raster bounds
// These are derived from the DTM (EPSG:27700) converted to WGS84
// Run: python3 -c "from pyproj import Transformer; ... " to recalculate if DTM changes
const DTM_BOUNDS_WGS84 = {
  minLat: 55.095913,
  maxLat: 55.149454,
  minLon: -1.563491,
  maxLon: -1.468763,
};

// Texture cache
const textureCache: Map<string, THREE.Texture> = new Map();
const textureLoader = new THREE.TextureLoader();

/**
 * Convert lat/lon to tile coordinates
 */
function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

/**
 * Get tile URL for coordinates
 */
function getTileUrl(lat: number, lon: number, zoom: number): string {
  const { x, y } = latLonToTile(lat, lon, zoom);
  return TILE_URL
    .replace("{z}", zoom.toString())
    .replace("{x}", x.toString())
    .replace("{y}", y.toString());
}

/**
 * Load a terrain texture for the entire AOI
 * Uses a single tile at appropriate zoom level
 */
export async function loadTerrainTexture(zoom: number = 14): Promise<THREE.Texture> {
  const cacheKey = `terrain_${zoom}`;

  if (textureCache.has(cacheKey)) {
    return textureCache.get(cacheKey)!;
  }

  // Use center of DTM bounds
  const centerLat = (DTM_BOUNDS_WGS84.minLat + DTM_BOUNDS_WGS84.maxLat) / 2;
  const centerLon = (DTM_BOUNDS_WGS84.minLon + DTM_BOUNDS_WGS84.maxLon) / 2;
  const url = getTileUrl(centerLat, centerLon, zoom);
  console.log(`Loading terrain tile: ${url}`);

  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (texture) => {
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        textureCache.set(cacheKey, texture);
        resolve(texture);
      },
      undefined,
      (error) => {
        console.warn("Failed to load terrain tile:", error);
        reject(error);
      }
    );
  });
}

/**
 * Convert lat/lon to precise fractional tile coordinates
 */
function latLonToTileFractional(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

/**
 * Create a composite terrain texture from multiple tiles
 * Covers the AOI with a grid of tiles, cropped to exact bounds
 */
export async function loadTerrainTextureGrid(zoom: number = 16): Promise<THREE.CanvasTexture> {
  const cacheKey = `terrain_grid_${zoom}`;

  if (textureCache.has(cacheKey)) {
    return textureCache.get(cacheKey) as THREE.CanvasTexture;
  }

  // Use exact DTM bounds - no calculation needed
  const minLat = DTM_BOUNDS_WGS84.minLat;
  const maxLat = DTM_BOUNDS_WGS84.maxLat;
  const minLon = DTM_BOUNDS_WGS84.minLon;
  const maxLon = DTM_BOUNDS_WGS84.maxLon;

  // Get tile coordinates for corners (integer for fetching)
  const minTile = latLonToTile(maxLat, minLon, zoom); // NW corner
  const maxTile = latLonToTile(minLat, maxLon, zoom); // SE corner

  // Get fractional tile coords for precise cropping
  const nwFrac = latLonToTileFractional(maxLat, minLon, zoom);
  const seFrac = latLonToTileFractional(minLat, maxLon, zoom);

  const tilesX = maxTile.x - minTile.x + 1;
  const tilesY = maxTile.y - minTile.y + 1;

  const totalTiles = tilesX * tilesY;
  console.log(`Loading ${tilesX}x${tilesY} (${totalTiles}) terrain tiles at zoom ${zoom}`);

  // Debug: Show bounds being used
  console.log("Terrain texture bounds (WGS84):", {
    minLat: minLat.toFixed(6),
    maxLat: maxLat.toFixed(6),
    minLon: minLon.toFixed(6),
    maxLon: maxLon.toFixed(6),
  });

  // Create canvas to composite tiles
  const TILE_SIZE = 256;
  const canvas = document.createElement("canvas");
  canvas.width = tilesX * TILE_SIZE;
  canvas.height = tilesY * TILE_SIZE;
  const ctx = canvas.getContext("2d")!;

  // Fill with green as fallback
  ctx.fillStyle = "#4a7c4e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Load all tiles with success/failure tracking
  let successCount = 0;
  let failCount = 0;
  const loadPromises: Promise<void>[] = [];

  for (let ty = minTile.y; ty <= maxTile.y; ty++) {
    for (let tx = minTile.x; tx <= maxTile.x; tx++) {
      const url = TILE_URL
        .replace("{z}", zoom.toString())
        .replace("{x}", tx.toString())
        .replace("{y}", ty.toString());

      const canvasX = (tx - minTile.x) * TILE_SIZE;
      const canvasY = (ty - minTile.y) * TILE_SIZE;

      const promise = new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          ctx.drawImage(img, canvasX, canvasY, TILE_SIZE, TILE_SIZE);
          successCount++;
          resolve();
        };
        img.onerror = (err) => {
          failCount++;
          console.warn(`Failed to load tile ${tx},${ty} from ${url}`, err);
          resolve(); // Continue even if tile fails
        };
        img.src = url;
      });

      loadPromises.push(promise);
    }
  }

  await Promise.all(loadPromises);
  console.log(`Terrain tiles loaded: ${successCount}/${totalTiles} succeeded, ${failCount} failed`);

  if (successCount === 0) {
    console.error("All terrain tiles failed to load - likely CORS issue. Check browser console for details.");
  }

  // Calculate crop bounds - how much to trim from each edge
  // Fractional offset within the tile grid
  const cropLeft = (nwFrac.x - minTile.x) * TILE_SIZE;
  const cropTop = (nwFrac.y - minTile.y) * TILE_SIZE;
  const cropRight = ((maxTile.x + 1) - seFrac.x) * TILE_SIZE;
  const cropBottom = ((maxTile.y + 1) - seFrac.y) * TILE_SIZE;

  const croppedWidth = canvas.width - cropLeft - cropRight;
  const croppedHeight = canvas.height - cropTop - cropBottom;

  console.log(`Cropping texture: left=${cropLeft.toFixed(0)}, top=${cropTop.toFixed(0)}, size=${croppedWidth.toFixed(0)}x${croppedHeight.toFixed(0)}`);

  // Create cropped canvas
  const croppedCanvas = document.createElement("canvas");
  croppedCanvas.width = croppedWidth;
  croppedCanvas.height = croppedHeight;
  const croppedCtx = croppedCanvas.getContext("2d")!;
  croppedCtx.drawImage(canvas, cropLeft, cropTop, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight);

  // Resample to remove Mercator distortion
  // The cropped canvas is in Web Mercator where y is non-linear with latitude
  // The mesh UVs are linear in BNG meters, so we need to correct for this
  const correctedCanvas = document.createElement("canvas");
  correctedCanvas.width = croppedWidth;
  correctedCanvas.height = croppedHeight;
  const correctedCtx = correctedCanvas.getContext("2d")!;

  // Mercator y formula: y = ln(tan(π/4 + lat/2))
  const toMercatorY = (lat: number): number => {
    const latRad = lat * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  };

  // Calculate Mercator y range for our lat bounds
  const mercMinY = toMercatorY(minLat);
  const mercMaxY = toMercatorY(maxLat);
  const mercRangeY = mercMaxY - mercMinY;
  const latRange = maxLat - minLat;

  // Debug: show correction magnitude
  // At 55°N over 6km, expect ~0.1-0.2% distortion
  const scaleAtMin = 1 / Math.cos(minLat * Math.PI / 180);
  const scaleAtMax = 1 / Math.cos(maxLat * Math.PI / 180);
  console.log(`Mercator correction: scale varies from ${scaleAtMin.toFixed(4)} (south) to ${scaleAtMax.toFixed(4)} (north), diff=${((scaleAtMax/scaleAtMin - 1) * 100).toFixed(3)}%`);

  // Resample row by row
  // For each output row (linear in latitude), find the corresponding source row (in Mercator)
  for (let outY = 0; outY < croppedHeight; outY++) {
    // Output row position as fraction (0 = top = north, 1 = bottom = south)
    const outFrac = outY / croppedHeight;

    // Corresponding latitude (linear interpolation)
    // Note: in the cropped canvas, top is north (maxLat), bottom is south (minLat)
    const lat = maxLat - outFrac * latRange;

    // Convert to Mercator y and find source row
    const mercY = toMercatorY(lat);
    const srcFrac = (mercMaxY - mercY) / mercRangeY;
    const srcY = srcFrac * croppedHeight;

    // Draw a 1-pixel-high strip from source to output
    correctedCtx.drawImage(
      croppedCanvas,
      0, srcY, croppedWidth, 1,  // source: full width, 1px at srcY
      0, outY, croppedWidth, 1   // dest: full width, 1px at outY
    );
  }

  // Apply transform that was empirically determined to work
  const transformedCanvas = document.createElement("canvas");
  transformedCanvas.width = croppedWidth;
  transformedCanvas.height = croppedHeight;
  const ctx2 = transformedCanvas.getContext("2d")!;

  // First apply the orientation fix (rotate 180 + flip east-west)
  ctx2.translate(croppedWidth, croppedHeight);
  ctx2.rotate(Math.PI);
  ctx2.translate(croppedWidth, 0);
  ctx2.scale(-1, 1);
  ctx2.drawImage(correctedCanvas, 0, 0);

  // Apply a small rotation around center to correct for remaining drift
  // This compensates for grid convergence between Web Mercator and BNG
  const ROTATION_DEGREES = 0.7;
  const rotationRad = ROTATION_DEGREES * Math.PI / 180;

  const rotatedCanvas = document.createElement("canvas");
  rotatedCanvas.width = croppedWidth;
  rotatedCanvas.height = croppedHeight;
  const ctx3 = rotatedCanvas.getContext("2d")!;

  // Rotate around center
  ctx3.translate(croppedWidth / 2, croppedHeight / 2);
  ctx3.rotate(rotationRad);
  ctx3.translate(-croppedWidth / 2, -croppedHeight / 2);
  ctx3.drawImage(transformedCanvas, 0, 0);

  console.log(`Applied ${ROTATION_DEGREES}° rotation correction`);

  const texture = new THREE.CanvasTexture(rotatedCanvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  textureCache.set(cacheKey, texture);
  return texture;
}

/**
 * Generate a procedural grass/terrain texture as fallback
 */
function generateProceduralTerrainTexture(): THREE.CanvasTexture {
  const CANVAS_SIZE = 512;
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d")!;

  // Base grass color
  ctx.fillStyle = "#4a7c4e";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Add grass texture variation
  const grassColors = ["#3d6b41", "#557a4f", "#4a7c4e", "#628c5a", "#3a5f3d"];

  // Large patches
  for (let i = 0; i < 100; i++) {
    const x = Math.random() * CANVAS_SIZE;
    const y = Math.random() * CANVAS_SIZE;
    const size = 20 + Math.random() * 60;
    const color = grassColors[Math.floor(Math.random() * grassColors.length)];

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Small grass details
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * CANVAS_SIZE;
    const y = Math.random() * CANVAS_SIZE;
    const size = 2 + Math.random() * 8;
    const brightness = Math.random() > 0.5 ? 15 : -15;

    ctx.fillStyle = `rgba(${74 + brightness}, ${124 + brightness}, ${78 + brightness}, 0.5)`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 10);  // Tile the texture across terrain
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return texture;
}

/**
 * Create terrain material with satellite imagery
 * Uses MeshBasicMaterial to avoid lighting/normal issues across platforms
 */
export async function createTerrainMaterial(): Promise<THREE.MeshBasicMaterial> {
  try {
    // Use zoom 16 for good detail (zoom 17 may not be available in all areas)
    const texture = await loadTerrainTextureGrid(16);

    // Use MeshBasicMaterial - doesn't depend on lighting/normals
    // This ensures consistent rendering across mobile and desktop
    return new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
    });
  } catch (error) {
    console.warn("Failed to load terrain imagery, using procedural fallback");
    const fallbackTexture = generateProceduralTerrainTexture();
    return new THREE.MeshBasicMaterial({
      map: fallbackTexture,
      side: THREE.DoubleSide,
    });
  }
}
