/**
 * Blyth Digital Twin - Web Viewer
 *
 * Three.js-based viewer for the Blyth digital twin.
 * Features:
 * - OrbitControls for god's eye view navigation
 * - Chunk-based asset loading
 * - Z-up coordinate system (geographic convention)
 * - Building selection via footprints overlay
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Texture generators
import { getSharedRoadMaterial, preloadRoadTextures } from "./textures/roads";
import { createRailwayMaterial, preloadRailwayTextures } from "./textures/railways";
import { createSimpleWaterMaterial, createSimpleSeaMaterial } from "./textures/water";
import { createBuildingMaterial } from "./textures/buildings";
import { createTerrainMaterial } from "./textures/terrain";

// Types
interface Manifest {
  version: string;
  name: string;
  generated: string;
  origin: {
    crs: string;
    x: number;
    y: number;
    note: string;
  };
  aoi: {
    centre_wgs84: [number, number];
    side_length_m: number;
  };
  assets: Asset[];
}

interface Asset {
  id: string;
  type: "terrain" | "buildings" | "roads" | "railways" | "water" | "sea" | "footprints" | "texture";
  url: string;
  size_bytes: number;
  compressed: boolean;
  bbox?: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
  };
}

interface LoadedAsset {
  asset: Asset;
  mesh: THREE.Object3D;
  loaded: boolean;
}

interface FaceMapEntry {
  building_id: number;
  start_face: number;
  end_face: number;
}

interface ChunkMetadata {
  face_map: FaceMapEntry[];
}

interface BuildingProperties {
  name?: string;
  building?: string;
  amenity?: string;
  shop?: string;
  addr_housename?: string;
  addr_housenumber?: string;
  addr_street?: string;
  addr_postcode?: string;
  addr_city?: string;
  height?: number;
  height_source?: string;
  osm_id?: number;
}

interface FootprintMetadata {
  chunks: Record<string, ChunkMetadata>;
  buildings: Record<string, BuildingProperties>;
}

interface BuildingFaceMapEntry {
  osm_id: number;
  building_index: number;
  global_id: number;
  start_face: number;
  end_face: number;
}

interface BuildingMetadata {
  chunks: Record<string, BuildingFaceMapEntry[]>;
}

// Configuration
const CONFIG = {
  manifestUrl: "/manifest.json",
  footprintMetadataUrl: "/footprints_metadata.json",
  buildingMetadataUrl: "/buildings_metadata.json",
  facadeAtlasUrl: "/assets/textures/facade_atlas.png",
  facadeNormalUrl: "/assets/textures/facade_normal_atlas.png",
  facadeMetaUrl: "/assets/textures/facade_atlas_meta.json",
  assetsBasePath: "/",
  camera: {
    fov: 45,
    near: 1,
    far: 15000,
    initialPosition: new THREE.Vector3(0, 0, 4000),  // 4km above center (Z-up)
  },
  fog: {
    color: 0x87ceeb,
    near: 3000,
    far: 8000,
  },
  controls: {
    minDistance: 100,
    maxDistance: 10000,
    maxPolarAngle: Math.PI / 2.1,  // Slightly above horizon
  },
  materials: {
    terrain: {
      color: 0x4a7c4e,
      flatShading: true,
    },
    buildings: {
      color: 0x8b7355,
      flatShading: true,
      useTexture: true,  // Enable facade textures
    },
    roads: {
      color: 0x3a3a3a,
      useTexture: true,  // Enable procedural road textures
    },
    railways: {
      color: 0x8b4513,
      useTexture: true,  // Enable procedural railway textures
    },
    water: {
      color: 0x4da6ff,
      opacity: 0.85,
      useShader: true,  // Enable water shader
    },
    sea: {
      color: 0x1a5c8c,
      opacity: 0.9,
      useShader: true,  // Enable water shader
    },
    footprints: {
      hoverColor: 0x00ff00,
      hoverOpacity: 0.3,
      selectedColor: 0xffff00,
      selectedOpacity: 0.6,
    },
    zones: {
      residential: 0x4CAF50,  // Green
      commercial: 0x2196F3,   // Blue
      industrial: 0xFF9800,   // Orange
      civic: 0x9C27B0,        // Purple
      other: 0x795548,        // Brown
      opacity: 0.6,
    },
  },
  lod: {
    enabled: true,
    buildingCullDistance: 4000,   // Hide buildings beyond this distance
    detailDistance: 1500,         // Full detail within this distance
    updateInterval: 100,          // ms between LOD updates
  },
};

/**
 * Map building type to SimCity-style zone
 */
/**
 * Get dominant zone for a chunk based on building count
 */
function getDominantZoneForChunk(chunkId: string): keyof typeof CONFIG.materials.zones {
  if (!footprintMetadata) return "other";

  const chunkData = footprintMetadata.chunks[chunkId];
  if (!chunkData) return "other";

  // Count buildings per zone
  const zoneCounts: Record<string, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    civic: 0,
    other: 0,
  };

  for (const entry of chunkData.face_map) {
    const props = footprintMetadata.buildings[String(entry.building_id)];
    const zone = getZoneFromBuildingType(props);
    zoneCounts[zone]++;
  }

  // Find dominant zone
  let maxCount = 0;
  let dominantZone: keyof typeof CONFIG.materials.zones = "other";
  for (const [zone, count] of Object.entries(zoneCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantZone = zone as keyof typeof CONFIG.materials.zones;
    }
  }

  return dominantZone;
}

function getZoneFromBuildingType(props: BuildingProperties | null): keyof typeof CONFIG.materials.zones {
  if (!props) return "other";

  const buildingType = props.building?.toLowerCase() || "";
  const amenity = props.amenity?.toLowerCase() || "";
  const shop = props.shop?.toLowerCase() || "";

  // Residential
  if (["residential", "house", "terrace", "semidetached_house", "detached",
       "bungalow", "apartments", "flat", "dormitory"].includes(buildingType)) {
    return "residential";
  }

  // Commercial (shops, retail, hospitality)
  if (["retail", "commercial", "supermarket", "kiosk"].includes(buildingType) ||
      shop || ["pub", "restaurant", "cafe", "fast_food", "bar", "hotel", "bank"].includes(amenity)) {
    return "commercial";
  }

  // Industrial
  if (["industrial", "warehouse", "factory", "manufacture", "storage_tank"].includes(buildingType)) {
    return "industrial";
  }

  // Civic (public services, education, religious)
  if (["school", "university", "college", "church", "chapel", "cathedral",
       "hospital", "civic", "public", "government", "office", "fire_station",
       "police", "library", "community_centre", "sports_centre"].includes(buildingType) ||
      ["school", "hospital", "place_of_worship", "community_centre", "library",
       "police", "fire_station", "townhall", "theatre", "cinema"].includes(amenity)) {
    return "civic";
  }

  return "other";
}

// Globals
let camera: THREE.PerspectiveCamera;
let scene: THREE.Scene;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let manifest: Manifest | null = null;
let footprintMetadata: FootprintMetadata | null = null;
let buildingMetadata: BuildingMetadata | null = null;
const loadedAssets: Map<string, LoadedAsset> = new Map();
const loader = new GLTFLoader();

// Configure Draco decoder for compressed GLBs
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
dracoLoader.setDecoderConfig({ type: "js" }); // Use JS decoder for broader compatibility
loader.setDRACOLoader(dracoLoader);

// Sun light reference for water shader
let sunLight: THREE.DirectionalLight | null = null;

// Cached materials for performance
let roadMaterial: THREE.Material | null = null;
let railwayMaterial: THREE.Material | null = null;
let buildingMaterial: THREE.Material | null = null;
let waterMaterial: THREE.Material | null = null;
let seaMaterial: THREE.Material | null = null;
let terrainMaterial: THREE.Material | null = null;


// Water objects for animation
const waterObjects: THREE.Object3D[] = [];

// Layer visibility state (to prevent LOD from overriding user toggles)
const layerEnabled: Map<string, boolean> = new Map([
  ["terrain", true],
  ["buildings", true],
  ["roads", true],
  ["railways", true],
  ["water", true],
  ["sea", true],
]);

// Clock for animations
const clock = new THREE.Clock();

// LOD management
let lastLodUpdate = 0;

// Footprint meshes for raycasting
const footprintMeshes: Map<string, THREE.Mesh> = new Map();  // chunk_id -> mesh
const footprintMaterials: Map<string, THREE.ShaderMaterial> = new Map();  // chunk_id -> shader material

// Building meshes for 3D highlighting
const buildingMeshes: Map<string, THREE.Mesh[]> = new Map();  // chunk_id -> meshes

// GPU highlight shader for footprints
const footprintVertexShader = `
  attribute float _osm_id;
  varying float vOsmId;
  varying vec3 vColor;

  void main() {
    vOsmId = _osm_id;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const footprintFragmentShader = `
  precision highp float;

  uniform float selectedOsmId;
  uniform float hoveredOsmId;
  uniform vec3 selectedColor;
  uniform vec3 hoveredColor;
  uniform float selectedOpacity;
  uniform float hoveredOpacity;
  uniform bool showZoneColors;
  uniform float zoneOpacity;

  varying float vOsmId;
  varying vec3 vColor;

  void main() {
    // Use relative comparison for large OSM IDs (float precision issue)
    // Two floats from same source should have same precision loss
    bool isSelected = selectedOsmId > 0.0 && abs(vOsmId - selectedOsmId) < 1.0;
    bool isHovered = hoveredOsmId > 0.0 && abs(vOsmId - hoveredOsmId) < 1.0;

    if (isSelected) {
      gl_FragColor = vec4(selectedColor, selectedOpacity);
    } else if (isHovered) {
      gl_FragColor = vec4(hoveredColor, hoveredOpacity);
    } else if (showZoneColors) {
      gl_FragColor = vec4(vColor, zoneOpacity);
    } else {
      discard;  // Invisible when not selected/hovered and zones off
    }
  }
`;

// Shared uniforms for all footprint materials
const footprintUniforms = {
  selectedOsmId: { value: 0.0 },
  hoveredOsmId: { value: 0.0 },
  selectedColor: { value: new THREE.Color(0x00ff00) },
  hoveredColor: { value: new THREE.Color(0xffff00) },
  selectedOpacity: { value: 0.6 },
  hoveredOpacity: { value: 0.4 },
  showZoneColors: { value: false },
  zoneOpacity: { value: 0.7 },
};

// Building shader with selection tint/emissive
// Uses building_index (small int per chunk) instead of osm_id (too large for float32)
const buildingVertexShader = `
  attribute float _building_id;
  varying float vBuildingId;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    vBuildingId = _building_id;
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const buildingFragmentShader = `
  precision highp float;

  uniform sampler2D map;
  uniform bool hasMap;
  uniform vec3 baseColor;
  uniform float selectedBuildingId;
  uniform float hoveredBuildingId;
  uniform vec3 emissiveColor;
  uniform float time;

  varying float vBuildingId;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    // Base color from texture or solid color
    vec4 texColor = hasMap ? texture2D(map, vUv) : vec4(baseColor, 1.0);

    // Simple directional lighting
    vec3 lightDir = normalize(vec3(0.5, -0.5, 1.0));
    float diffuse = max(dot(vNormal, lightDir), 0.0);
    float ambient = 0.4;
    float lighting = ambient + diffuse * 0.6;

    vec3 finalColor = texColor.rgb * lighting;

    // Check for selection/hover (building IDs are small ints, use exact comparison)
    bool isSelected = selectedBuildingId >= 0.0 && abs(vBuildingId - selectedBuildingId) < 0.5;
    bool isHovered = hoveredBuildingId >= 0.0 && abs(vBuildingId - hoveredBuildingId) < 0.5;

    if (isSelected) {
      // Pulsing emissive glow for selected building
      float pulse = 0.5 + 0.5 * sin(time * 3.0);
      vec3 emissive = emissiveColor * pulse * 0.8;
      finalColor = finalColor + emissive;
      // Also tint slightly
      finalColor = mix(finalColor, emissiveColor, 0.2);
    } else if (isHovered) {
      // Subtle tint for hovered building
      finalColor = mix(finalColor, emissiveColor, 0.15);
    }

    gl_FragColor = vec4(finalColor, texColor.a);
  }
`;

// Shared uniforms for all building materials
const buildingShaderUniforms = {
  map: { value: null as THREE.Texture | null },
  hasMap: { value: false },
  baseColor: { value: new THREE.Color(0x8b7355) },
  selectedBuildingId: { value: -1.0 },  // -1 = none selected
  hoveredBuildingId: { value: -1.0 },   // -1 = none hovered
  emissiveColor: { value: new THREE.Color(0x00ffff) },  // Cyan
  time: { value: 0.0 },
};

// Raycasting
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selectedBuildingIndex: number = -1;

// Loading state
let totalAssets = 0;
let loadedCount = 0;

// Zone colors state
let zoneColorsEnabled = false;
let buildingTexturesEnabled = true;
const buildingOriginalMaterials: Map<string, THREE.Material | THREE.Material[]> = new Map();  // chunk_id -> original material
const buildingZoneMaterials: Map<string, THREE.MeshBasicMaterial> = new Map();  // chunk_id -> zone material
const buildingNullMaterial = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide });  // Dark material when textures off

/**
 * Initialize the viewer
 */
async function init() {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const loadingEl = document.getElementById("loading");
  const progressEl = document.getElementById("progress");

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(CONFIG.fog.color);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // PBR rendering settings for Meshy AI textured buildings
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(
    CONFIG.fog.color,
    CONFIG.fog.near,
    CONFIG.fog.far
  );

  // Camera (Z-up coordinate system)
  camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far
  );
  camera.position.copy(CONFIG.camera.initialPosition);
  camera.up.set(0, 0, 1);  // Z is up (geographic convention)
  camera.lookAt(0, 0, 0);

  // Lighting (adjusted for Z-up)
  setupLighting();

  // AOI border
  addAOIBorder();

  // OrbitControls
  setupControls(canvas);

  // Event listeners
  window.addEventListener("resize", onWindowResize);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("click", onClick);

  // Load textures, manifest and assets
  try {
    await initializeTextures();
    await loadManifest();
    await loadFootprintMetadata();
    await loadBuildingMetadata();
    if (manifest) {
      totalAssets = manifest.assets.length;
      updateProgress(progressEl);
      await loadAllAssets(progressEl);
    }
    if (loadingEl) loadingEl.classList.add("hidden");
  } catch (error) {
    console.error("Failed to load assets:", error);
    if (loadingEl) loadingEl.textContent = "Failed to load assets. Check console for details.";
  }

  // Start render loop
  animate();
}

/**
 * Set up scene lighting (Z-up coordinate system)
 */
function setupLighting() {
  // Ambient light
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  // Directional light (sun) - positioned high in Z for Z-up system
  sunLight = new THREE.DirectionalLight(0xffffff, 0.8);
  sunLight.position.set(1000, -1000, 3000);  // High Z = above terrain
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 100;
  sunLight.shadow.camera.far = 6000;
  sunLight.shadow.camera.left = -3000;
  sunLight.shadow.camera.right = 3000;
  sunLight.shadow.camera.top = 3000;
  sunLight.shadow.camera.bottom = -3000;
  scene.add(sunLight);

  // Hemisphere light (sky above in Z, ground below)
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4a7c4e, 0.4);
  hemi.position.set(0, 0, 1);  // Z-up
  scene.add(hemi);
}

/**
 * Add red border around AOI (5km × 5km square)
 */
function addAOIBorder() {
  const halfSize = 2500;  // 5000m / 2
  const z = 50;  // Slightly above ground level

  const points = [
    new THREE.Vector3(-halfSize, -halfSize, z),
    new THREE.Vector3(halfSize, -halfSize, z),
    new THREE.Vector3(halfSize, halfSize, z),
    new THREE.Vector3(-halfSize, halfSize, z),
    new THREE.Vector3(-halfSize, -halfSize, z),  // Close the loop
  ];

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
  const border = new THREE.Line(geometry, material);

  scene.add(border);
}

/**
 * Set up OrbitControls for god's eye view navigation
 */
function setupControls(canvas: HTMLCanvasElement) {
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = true;
  controls.minDistance = CONFIG.controls.minDistance;
  controls.maxDistance = CONFIG.controls.maxDistance;
  controls.maxPolarAngle = CONFIG.controls.maxPolarAngle;

  // Mobile touch settings
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };

  // Constrain target to AOI bounds to prevent zoom range drift on mobile
  const AOI_HALF = 2500;  // 5km / 2
  const constrainTarget = () => {
    const target = controls.target;
    target.x = Math.max(-AOI_HALF, Math.min(AOI_HALF, target.x));
    target.y = Math.max(-AOI_HALF, Math.min(AOI_HALF, target.y));
    target.z = Math.max(0, Math.min(500, target.z));  // Keep target near ground level
  };

  // Apply constraints after each control change
  controls.addEventListener("change", constrainTarget);

  // Update info text
  const infoEl = document.getElementById("info");
  if (infoEl) {
    infoEl.innerHTML = `
      <strong>Blyth Digital Twin</strong><br>
      Drag: Orbit | Right-drag: Pan | Scroll: Zoom<br>
      Click buildings to view info
    `;
  }
}

/**
 * Initialize textures and materials
 */
async function initializeTextures() {
  console.log("Initializing textures...");

  // Preload procedural textures (async - wait for image loads)
  await Promise.all([
    preloadRoadTextures(),
    preloadRailwayTextures(),
  ]);
  console.log("  Procedural textures preloaded");

  // Create shared materials (all async now - wait for image loads)
  if (CONFIG.materials.roads.useTexture) {
    roadMaterial = await getSharedRoadMaterial();
    console.log("  Road textures ready");
  }

  if (CONFIG.materials.railways.useTexture) {
    railwayMaterial = await createRailwayMaterial();
    console.log("  Railway textures ready");
  }

  // Create water materials (these are synchronous - no image loading)
  if (CONFIG.materials.water.useShader) {
    waterMaterial = createSimpleWaterMaterial(
      CONFIG.materials.water.color,
      CONFIG.materials.water.opacity
    );
    console.log("  Water material ready");
  }

  if (CONFIG.materials.sea.useShader) {
    seaMaterial = createSimpleSeaMaterial();
    console.log("  Sea material ready");
  }

  // Create building material with procedural brick texture (async)
  if (CONFIG.materials.buildings.useTexture) {
    buildingMaterial = await createBuildingMaterial();
    const bmat = buildingMaterial as THREE.MeshStandardMaterial;
    console.log("  Building material created:", {
      hasMap: !!bmat.map,
      mapWidth: bmat.map?.image?.width,
      mapHeight: bmat.map?.image?.height,
    });
  } else {
    buildingMaterial = new THREE.MeshStandardMaterial({
      color: CONFIG.materials.buildings.color,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0.0,
    });
  }

  // Load terrain satellite imagery
  try {
    terrainMaterial = await createTerrainMaterial();
    console.log("  Terrain satellite imagery ready");
  } catch (error) {
    console.warn("  Failed to load terrain imagery, will use fallback:", error);
  }

  console.log("Textures initialized");
}

/**
 * Load manifest.json
 */
async function loadManifest() {
  const response = await fetch(CONFIG.manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to load manifest: ${response.status}`);
  }
  manifest = await response.json();
  console.log("Manifest loaded:", manifest?.name, `v${manifest?.version}`);
  console.log(`  Assets: ${manifest?.assets.length}`);
}

/**
 * Load footprint metadata
 */
async function loadFootprintMetadata() {
  try {
    const response = await fetch(CONFIG.footprintMetadataUrl);
    if (response.ok) {
      footprintMetadata = await response.json();
      console.log("Footprint metadata loaded:", Object.keys(footprintMetadata?.buildings || {}).length, "buildings");
    }
  } catch (error) {
    console.warn("Failed to load footprint metadata:", error);
  }
}

/**
 * Load building metadata (face map for 3D building selection)
 */
async function loadBuildingMetadata() {
  try {
    const response = await fetch(CONFIG.buildingMetadataUrl);
    if (response.ok) {
      buildingMetadata = await response.json();
      const chunkCount = Object.keys(buildingMetadata?.chunks || {}).length;
      console.log("Building metadata loaded:", chunkCount, "chunks");
    }
  } catch (error) {
    console.warn("Failed to load building metadata:", error);
  }
}

/**
 * Update loading progress
 */
function updateProgress(progressEl: HTMLElement | null) {
  if (progressEl) {
    const percent = totalAssets > 0 ? Math.round((loadedCount / totalAssets) * 100) : 0;
    progressEl.textContent = `Loading: ${loadedCount}/${totalAssets} (${percent}%)`;
  }
}

/**
 * Load all assets from manifest
 */
async function loadAllAssets(progressEl: HTMLElement | null) {
  if (!manifest) return;

  // Sort assets by layer order: terrain → roads → railways → water → sea → buildings → footprints
  const layerOrder: Record<string, number> = {
    terrain: 0,
    roads: 1,
    railways: 2,
    water: 3,
    sea: 4,
    buildings: 5,
    footprints: 6,
    texture: 99,  // Textures are loaded separately
  };

  // Filter out texture assets (loaded separately via initializeTextures)
  const glbAssets = manifest.assets.filter(a => a.type !== "texture");
  totalAssets = glbAssets.length;

  const sortedAssets = [...glbAssets].sort((a, b) => {
    return (layerOrder[a.type] ?? 99) - (layerOrder[b.type] ?? 99);
  });

  // Load assets in parallel batches for faster loading
  const BATCH_SIZE = 8; // Load 8 assets concurrently
  for (let i = 0; i < sortedAssets.length; i += BATCH_SIZE) {
    const batch = sortedAssets.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(asset => loadAsset(asset, progressEl)));
  }
}

/**
 * Load a single asset
 */
async function loadAsset(asset: Asset, progressEl: HTMLElement | null): Promise<void> {
  let url = CONFIG.assetsBasePath + asset.url;
  const baseUrl = url.endsWith(".gz") ? url.slice(0, -3) : url;

  return new Promise((resolve) => {
    loader.load(
      baseUrl,
      (gltf) => {
        processLoadedAsset(asset, gltf.scene);
        loadedCount++;
        updateProgress(progressEl);
        resolve();
      },
      undefined,
      (error) => {
        console.warn(`Failed to load ${asset.id}:`, error);
        loadedCount++;
        updateProgress(progressEl);
        resolve();
      }
    );
  });
}

/**
 * Find OSM ID from building metadata face map
 */
/**
 * Find building entry from face index (returns building_index which fits in float32)
 */
function findBuildingFromFaceMap(chunkId: string, faceIndex: number): BuildingFaceMapEntry | null {
  if (!buildingMetadata) return null;

  const faceMap = buildingMetadata.chunks[chunkId];
  if (!faceMap) return null;

  // Binary search
  let left = 0;
  let right = faceMap.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const entry = faceMap[mid];

    if (faceIndex >= entry.start_face && faceIndex < entry.end_face) {
      return entry;
    } else if (faceIndex < entry.start_face) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null;
}

/**
 * Get global building ID from face map (unique across all chunks, fits in float32)
 */
function getGlobalBuildingIdFromFaceMap(chunkId: string, faceIndex: number): number {
  const entry = findBuildingFromFaceMap(chunkId, faceIndex);
  return entry ? entry.global_id : -1;
}

/**
 * Find building entry by global ID (searches all chunks)
 */
function findBuildingByGlobalId(globalId: number): BuildingFaceMapEntry | null {
  if (!buildingMetadata) return null;

  for (const entries of Object.values(buildingMetadata.chunks)) {
    for (const entry of entries) {
      if (entry.global_id === globalId) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * Process building assets with GPU selection shader
 * The _global_id vertex attribute is baked into the GLB during pipeline generation
 */
function processBuildingAsset(asset: Asset, object: THREE.Object3D) {
  const chunkId = asset.id;
  const meshList: THREE.Mesh[] = [];
  let meshIndex = 0;

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry as THREE.BufferGeometry;
      const existingMat = child.material as THREE.MeshStandardMaterial;

      // Get texture from existing material if present
      let texture: THREE.Texture | null = null;
      if (existingMat.map && existingMat.map.image) {
        const img = existingMat.map.image;
        if (img.width > 2 && img.height > 2) {
          texture = existingMat.map;
        }
      }

      // Fall back to building material texture if no embedded texture
      if (!texture && buildingMaterial) {
        texture = (buildingMaterial as THREE.MeshStandardMaterial).map;
      }

      // Check if GLB has _global_id vertex attribute baked in
      const hasGlobalIdAttr = geometry.attributes._global_id !== undefined;

      // Always convert to non-indexed geometry for correct per-face building IDs
      // (indexed geometry shares vertices between faces, causing shader issues)
      let workingGeometry = geometry;
      if (geometry.index) {
        workingGeometry = geometry.toNonIndexed();
        child.geometry = workingGeometry;
      }

      if (hasGlobalIdAttr) {
        // GLB has _global_id baked in - after toNonIndexed, attribute is expanded
        const globalIdAttr = workingGeometry.attributes._global_id;
        if (globalIdAttr) {
          workingGeometry.setAttribute("_building_id", globalIdAttr);

          if (meshIndex === 0) {
            const arr = globalIdAttr.array as Float32Array;
            const uniqueIds = new Set(arr);
            console.log(`  Chunk ${chunkId}: ${arr.length} vertices (non-indexed), ${uniqueIds.size} unique global IDs`);
          }
        } else {
          console.warn(`  Chunk ${chunkId}: _global_id lost after toNonIndexed`);
        }
      } else if (buildingMetadata) {
        // Fallback: compute from face map (shouldn't happen with new GLBs)
        console.warn(`  Chunk ${chunkId}: No _global_id in GLB, falling back to face map`);

        const positionCount = workingGeometry.attributes.position.count;
        const buildingIds = new Float32Array(positionCount);

        const faceCount = Math.floor(positionCount / 3);
        for (let faceIdx = 0; faceIdx < faceCount; faceIdx++) {
          const globalId = getGlobalBuildingIdFromFaceMap(chunkId, faceIdx);
          for (let v = 0; v < 3; v++) {
            buildingIds[faceIdx * 3 + v] = globalId;
          }
        }

        workingGeometry.setAttribute("_building_id", new THREE.BufferAttribute(buildingIds, 1));
      }

      meshIndex++;
      // Compute normals if not present
      const finalGeometry = child.geometry as THREE.BufferGeometry;
      if (!finalGeometry.attributes.normal) {
        finalGeometry.computeVertexNormals();
      }

      // Create custom shader material with selection support
      const shaderMaterial = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: texture },
          hasMap: { value: texture !== null },
          baseColor: { value: new THREE.Color(CONFIG.materials.buildings.color) },
          selectedBuildingId: buildingShaderUniforms.selectedBuildingId,
          hoveredBuildingId: buildingShaderUniforms.hoveredBuildingId,
          emissiveColor: buildingShaderUniforms.emissiveColor,
          time: buildingShaderUniforms.time,
        },
        vertexShader: buildingVertexShader,
        fragmentShader: buildingFragmentShader,
        side: THREE.DoubleSide,
      });

      child.material = shaderMaterial;
      child.castShadow = true;
      meshList.push(child);
    }
  });

  scene.add(object);

  // Store building meshes for raycasting
  buildingMeshes.set(chunkId, meshList);

  // Store in loaded assets
  const assetKey = `${asset.type}_${asset.id}`;
  loadedAssets.set(assetKey, {
    asset,
    mesh: object,
    loaded: true,
  });

  const hasMetadata = buildingMetadata?.chunks[chunkId] ? buildingMetadata.chunks[chunkId].length : 0;
  console.log(`  Buildings ${chunkId}: ${meshList.length} meshes, ${hasMetadata} entries in metadata`);
}

/**
 * Process a loaded asset and add to scene
 */
function processLoadedAsset(asset: Asset, object: THREE.Object3D) {
  console.log(`processLoadedAsset called: type=${asset.type}, id=${asset.id}`);

  // Special handling for footprints
  if (asset.type === "footprints") {
    processFootprintAsset(asset, object);
    return;
  }

  // Special handling for buildings (3D selection with OSM IDs)
  if (asset.type === "buildings") {
    processBuildingAsset(asset, object);
    return;
  }

  console.log(`Processing asset: ${asset.type} (${asset.id})`);

  let material: THREE.Material | null = null;
  let isWater = false;

  switch (asset.type) {
    case "terrain":
      // Terrain uses satellite imagery if available, otherwise fallback to solid color
      // Uses MeshBasicMaterial to avoid lighting/normal issues across platforms
      if (terrainMaterial) {
        material = terrainMaterial;
      } else {
        material = new THREE.MeshBasicMaterial({
          color: CONFIG.materials.terrain.color,
        });
      }
      break;

    case "roads":
      // Use procedural road texture material
      if (roadMaterial) {
        material = roadMaterial;
        console.log("  Using textured road material, has map:", !!(roadMaterial as THREE.MeshBasicMaterial).map);
      } else {
        console.log("  Road material not ready, using fallback");
        material = new THREE.MeshBasicMaterial({
          color: CONFIG.materials.roads.color,
          side: THREE.DoubleSide,
        });
      }
      break;

    case "railways":
      // Use procedural railway texture material
      if (railwayMaterial) {
        material = railwayMaterial;
        console.log("  Using textured railway material, has map:", !!(railwayMaterial as THREE.MeshBasicMaterial).map);
      } else {
        console.log("  Railway material not ready, using fallback");
        material = new THREE.MeshBasicMaterial({
          color: CONFIG.materials.railways.color,
          side: THREE.DoubleSide,
        });
      }
      break;

    case "water":
      // Use animated water material
      material = waterMaterial || new THREE.MeshBasicMaterial({
        color: CONFIG.materials.water.color,
        transparent: true,
        opacity: CONFIG.materials.water.opacity,
        side: THREE.DoubleSide,
      });
      isWater = true;
      break;

    case "sea":
      // Use animated sea material with larger waves
      material = seaMaterial || new THREE.MeshBasicMaterial({
        color: CONFIG.materials.sea.color,
        transparent: true,
        opacity: CONFIG.materials.sea.opacity,
        side: THREE.DoubleSide,
      });
      isWater = true;
      break;

    default:
      material = new THREE.MeshLambertMaterial({ color: 0x888888 });
  }

  let meshCount = 0;
  let meshWithUV = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshCount++;
      // Check if mesh has UV coordinates
      const geom = child.geometry as THREE.BufferGeometry;
      if (geom.attributes.uv) {
        meshWithUV++;
      }

      // Only override material if one was specified (null means keep embedded)
      if (material !== null) {
        child.material = material;
      }
      child.castShadow = asset.type === "buildings";
      child.receiveShadow = asset.type === "terrain" || asset.type === "roads";

      // Track water objects for animation
      if (isWater) {
        waterObjects.push(child);
      }
    }
  });

  if (asset.type === "roads" || asset.type === "terrain") {
    console.log(`  ${asset.type} ${asset.id}: ${meshCount} meshes, ${meshWithUV} with UVs`);
  }

  scene.add(object);

  // Use compound key to avoid collisions between asset types with same chunk ID
  const assetKey = `${asset.type}_${asset.id}`;
  loadedAssets.set(assetKey, {
    asset,
    mesh: object,
    loaded: true,
  });
}

/**
 * Process footprint assets with GPU highlight shader
 */
function processFootprintAsset(asset: Asset, object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry as THREE.BufferGeometry;

      // Add vertex colors and OSM IDs for GPU highlighting
      if (footprintMetadata && geometry.attributes.position) {
        const positionCount = geometry.attributes.position.count;
        const colors = new Float32Array(positionCount * 3);
        const osmIds = new Float32Array(positionCount);

        // Get face map for this chunk
        const chunkData = footprintMetadata.chunks[asset.id];
        if (chunkData) {
          // For each face in the geometry, determine its zone color and OSM ID
          const faceCount = positionCount / 3;

          for (let faceIdx = 0; faceIdx < faceCount; faceIdx++) {
            // Find building for this face
            const buildingId = findBuildingFromFace(asset.id, faceIdx);
            const props = buildingId !== null ? getBuildingProperties(buildingId) : null;
            const zone = getZoneFromBuildingType(props);
            const zoneColor = new THREE.Color(CONFIG.materials.zones[zone] as number);
            const osmId = props?.osm_id || 0;

            // Set color and OSM ID for all 3 vertices of this face
            for (let v = 0; v < 3; v++) {
              const vertexIdx = faceIdx * 3 + v;
              colors[vertexIdx * 3] = zoneColor.r;
              colors[vertexIdx * 3 + 1] = zoneColor.g;
              colors[vertexIdx * 3 + 2] = zoneColor.b;
              osmIds[vertexIdx] = osmId;
            }
          }
        }

        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute("_osm_id", new THREE.BufferAttribute(osmIds, 1));
      }

      // Create shader material for GPU-based highlighting
      const shaderMaterial = new THREE.ShaderMaterial({
        uniforms: footprintUniforms,
        vertexShader: footprintVertexShader,
        fragmentShader: footprintFragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexColors: true,
      });

      child.material = shaderMaterial;

      // Store references
      footprintMeshes.set(asset.id, child);
      footprintMaterials.set(asset.id, shaderMaterial);
    }
  });

  scene.add(object);

  // Use compound key to avoid collisions between asset types with same chunk ID
  const assetKey = `${asset.type}_${asset.id}`;
  loadedAssets.set(assetKey, {
    asset,
    mesh: object,
    loaded: true,
  });
}

/**
 * Find building ID from face index using binary search
 */
function findBuildingFromFace(chunkId: string, faceIndex: number): number | null {
  if (!footprintMetadata) return null;

  const chunkData = footprintMetadata.chunks[chunkId];
  if (!chunkData) return null;

  const faceMap = chunkData.face_map;

  // Binary search
  let left = 0;
  let right = faceMap.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const entry = faceMap[mid];

    if (faceIndex >= entry.start_face && faceIndex < entry.end_face) {
      return entry.building_id;
    } else if (faceIndex < entry.start_face) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null;
}

/**
 * Get building properties by ID
 */
function getBuildingProperties(buildingId: number): BuildingProperties | null {
  if (!footprintMetadata) return null;
  return footprintMetadata.buildings[String(buildingId)] || null;
}

/**
 * Get building properties by OSM ID (searches through all buildings)
 */
function getBuildingPropertiesByOsmId(osmId: number): BuildingProperties | null {
  if (!footprintMetadata) return null;

  for (const props of Object.values(footprintMetadata.buildings)) {
    if (props.osm_id === osmId) {
      return props;
    }
  }

  return null;
}

/**
 * Handle pointer move for hover effects (GPU-based on 3D buildings)
 */
function onPointerMove(event: PointerEvent) {
  // Calculate normalized device coordinates
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast against 3D building meshes
  raycaster.setFromCamera(pointer, camera);
  const allBuildingMeshes: THREE.Mesh[] = [];
  for (const meshList of buildingMeshes.values()) {
    allBuildingMeshes.push(...meshList);
  }
  const intersects = raycaster.intersectObjects(allBuildingMeshes, false);

  if (intersects.length > 0) {
    const intersection = intersects[0];
    const faceIndex = intersection.faceIndex;
    const hitMesh = intersection.object as THREE.Mesh;

    // Find chunk ID
    let hitChunkId: string | null = null;
    for (const [chunkId, meshList] of buildingMeshes.entries()) {
      if (meshList.includes(hitMesh)) {
        hitChunkId = chunkId;
        break;
      }
    }

    // Get building index from vertex attribute
    if (faceIndex !== undefined && hitChunkId) {
      const buildingIndex = getBuildingIdFromVertexAttribute(hitMesh, faceIndex);
      if (buildingIndex >= 0 && buildingIndex !== selectedBuildingIndex) {
        // Update GPU uniform for hover highlight
        buildingShaderUniforms.hoveredBuildingId.value = buildingIndex;
      }
    }

    // Always show pointer when over a building
    document.body.style.cursor = "pointer";
  } else {
    // Clear hover
    buildingShaderUniforms.hoveredBuildingId.value = -1.0;
    document.body.style.cursor = "default";
  }
}

/**
 * Get building ID from vertex attribute
 */
function getBuildingIdFromVertexAttribute(mesh: THREE.Mesh, faceIndex: number): number {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const buildingIdAttr = geometry.getAttribute("_building_id") as THREE.BufferAttribute | null;
  if (!buildingIdAttr) return -1;

  let vertexIndex: number;

  if (geometry.index) {
    // Indexed geometry: look up vertex index from index buffer
    const indexAttr = geometry.index;
    const faceStartIndex = faceIndex * 3;
    if (faceStartIndex >= indexAttr.count) return -1;
    vertexIndex = indexAttr.getX(faceStartIndex);
  } else {
    // Non-indexed geometry: faceIndex * 3 gives first vertex of face
    vertexIndex = faceIndex * 3;
  }

  if (vertexIndex >= buildingIdAttr.count) return -1;

  return Math.round(buildingIdAttr.getX(vertexIndex));
}

/**
 * Handle click for selection (GPU-based)
 */
function onClick(event: MouseEvent) {
  // Calculate normalized device coordinates
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast against 3D building meshes
  raycaster.setFromCamera(pointer, camera);
  const allBuildingMeshes: THREE.Mesh[] = [];
  for (const meshList of buildingMeshes.values()) {
    allBuildingMeshes.push(...meshList);
  }
  const intersects = raycaster.intersectObjects(allBuildingMeshes, false);

  if (intersects.length > 0) {
    const intersection = intersects[0];
    const faceIndex = intersection.faceIndex;
    const hitMesh = intersection.object as THREE.Mesh;

    // Find chunk ID for metadata lookup
    let hitChunkId: string | null = null;
    for (const [chunkId, meshList] of buildingMeshes.entries()) {
      if (meshList.includes(hitMesh)) {
        hitChunkId = chunkId;
        break;
      }
    }

    if (hitChunkId && faceIndex !== undefined) {
      // Get global building ID from vertex attribute
      const globalId = getBuildingIdFromVertexAttribute(hitMesh, faceIndex);

      if (globalId >= 0) {
        // Look up building entry by global ID to get OSM ID
        const entry = findBuildingByGlobalId(globalId);
        const osmId = entry?.osm_id || null;

        // Get building properties from footprint metadata using OSM ID
        const props = osmId ? getBuildingPropertiesByOsmId(osmId) : null;

        // Update selection state
        selectedBuildingIndex = globalId;

        // Update GPU uniform for selection highlight
        buildingShaderUniforms.selectedBuildingId.value = globalId;

        showBuildingInfo(props, osmId);
      }
    }
  } else {
    // Clicked empty space - deselect
    selectedBuildingIndex = -1;
    buildingShaderUniforms.selectedBuildingId.value = -1.0;
    hideBuildingInfo();
  }
}

/**
 * Check if a building type is meaningful (not just "yes")
 */
function isMeaningfulType(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  return normalized !== "yes" && normalized !== "true" && normalized !== "1";
}

/**
 * Show building info panel
 * @param props Building properties from metadata
 * @param vertexOsmId OSM ID from vertex attribute (fallback if not in props)
 */
function showBuildingInfo(props: BuildingProperties | null, vertexOsmId?: number | null) {
  const panel = document.getElementById("building-info");
  const nameEl = document.getElementById("building-name");
  const propsEl = document.getElementById("building-props");

  if (!panel || !nameEl || !propsEl) return;

  // Determine display name (prefer specific info over generic "yes")
  let displayName = "Building";
  if (props?.name) {
    displayName = props.name;
  } else if (props?.addr_housename) {
    displayName = props.addr_housename;
  } else if (props?.shop && isMeaningfulType(props.shop)) {
    displayName = capitalizeFirst(props.shop);
  } else if (props?.amenity && isMeaningfulType(props.amenity)) {
    displayName = capitalizeFirst(props.amenity);
  } else if (props?.building && isMeaningfulType(props.building)) {
    displayName = capitalizeFirst(props.building);
  }

  nameEl.textContent = displayName;

  // Build properties list
  let propsHtml = "";

  // Only show building type if it's meaningful
  if (props?.building && isMeaningfulType(props.building)) {
    propsHtml += `<dt>Type</dt><dd>${capitalizeFirst(props.building)}</dd>`;
  }
  if (props?.amenity && isMeaningfulType(props.amenity)) {
    propsHtml += `<dt>Amenity</dt><dd>${capitalizeFirst(props.amenity)}</dd>`;
  }
  if (props?.shop && isMeaningfulType(props.shop)) {
    propsHtml += `<dt>Shop</dt><dd>${capitalizeFirst(props.shop)}</dd>`;
  }

  // Address
  const addressParts: string[] = [];
  if (props?.addr_housenumber) addressParts.push(props.addr_housenumber);
  if (props?.addr_street) addressParts.push(props.addr_street);
  if (addressParts.length > 0) {
    propsHtml += `<dt>Address</dt><dd>${addressParts.join(" ")}</dd>`;
  }
  if (props?.addr_postcode) {
    propsHtml += `<dt>Postcode</dt><dd>${props.addr_postcode}</dd>`;
  }
  if (props?.addr_city) {
    propsHtml += `<dt>City</dt><dd>${props.addr_city}</dd>`;
  }

  // Height
  if (props?.height) {
    propsHtml += `<dt>Height</dt><dd>${props.height.toFixed(1)}m</dd>`;
  }

  // OSM ID with link (prefer metadata, fall back to vertex attribute)
  const osmId = props?.osm_id || vertexOsmId;
  if (osmId) {
    const osmUrl = `https://www.openstreetmap.org/way/${osmId}`;
    propsHtml += `<dt>OSM ID</dt><dd><a href="${osmUrl}" target="_blank" rel="noopener">${osmId}</a></dd>`;
  }

  if (propsHtml === "") {
    propsHtml = "<dt>Info</dt><dd>No additional data available</dd>";
  }

  propsEl.innerHTML = propsHtml;
  panel.classList.remove("hidden");
}

/**
 * Hide building info panel
 */
function hideBuildingInfo() {
  const panel = document.getElementById("building-info");
  if (panel) {
    panel.classList.add("hidden");
  }
}

/**
 * Capitalize first letter
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, " ");
}

/**
 * Handle window resize
 */
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Update HUD with camera position
 */
function updateHUD() {
  const posEl = document.getElementById("position");
  if (posEl) {
    const pos = camera.position;
    posEl.textContent = `Alt: ${pos.z.toFixed(0)}m | X: ${pos.x.toFixed(0)} Y: ${pos.y.toFixed(0)}`;
  }
}

/**
 * Update water animation
 */
function updateWaterAnimation(deltaTime: number) {
  // Animate water normal map offset for wave movement
  for (const waterObj of waterObjects) {
    if (waterObj instanceof THREE.Mesh) {
      const mat = waterObj.material as THREE.MeshStandardMaterial;
      if (mat.normalMap) {
        // Animate the normal map offset for wave movement
        mat.normalMap.offset.x += deltaTime * 0.02;
        mat.normalMap.offset.y += deltaTime * 0.015;
      }
    }
  }
}

/**
 * Update LOD visibility based on camera distance
 */
function updateLOD() {
  if (!CONFIG.lod.enabled) return;

  const now = performance.now();
  if (now - lastLodUpdate < CONFIG.lod.updateInterval) return;
  lastLodUpdate = now;

  // Get camera position in XY plane (Z-up coordinate system)
  const camPos = new THREE.Vector2(camera.position.x, camera.position.y);
  const camAlt = camera.position.z;

  // Scale cull distance based on camera altitude (farther when high up)
  const altitudeScale = Math.max(1, camAlt / 1000);
  const cullDistance = CONFIG.lod.buildingCullDistance * altitudeScale;

  // Skip if buildings layer is disabled
  if (!layerEnabled.get("buildings")) return;

  for (const [, loadedAsset] of loadedAssets) {
    // Only apply LOD to buildings
    if (loadedAsset.asset.type !== "buildings") continue;

    const bbox = loadedAsset.asset.bbox;
    if (!bbox) continue;

    // Calculate chunk center
    const chunkCenter = new THREE.Vector2(
      (bbox.min_x + bbox.max_x) / 2,
      (bbox.min_y + bbox.max_y) / 2
    );

    // Distance from camera to chunk center
    const distance = camPos.distanceTo(chunkCenter);

    // Update visibility based on distance
    loadedAsset.mesh.visible = distance < cullDistance;
  }
}

/**
 * Animation loop
 */
function animate() {
  requestAnimationFrame(animate);

  const deltaTime = clock.getDelta();

  // Update building highlight time for pulsing glow
    buildingShaderUniforms.time.value += deltaTime;

  controls.update();
  updateHUD();
  updateWaterAnimation(deltaTime);
  updateLOD();

  renderer.render(scene, camera);
}

/**
 * Toggle visibility of all assets of a given type
 */
function setLayerVisibility(layerType: string, visible: boolean) {
  // Track layer state
  layerEnabled.set(layerType, visible);

  let count = 0;
  const typesFound = new Set<string>();
  for (const [_id, loadedAsset] of loadedAssets) {
    typesFound.add(loadedAsset.asset.type);
    if (loadedAsset.asset.type === layerType) {
      loadedAsset.mesh.visible = visible;
      count++;
    }
  }
  console.log(`setLayerVisibility(${layerType}, ${visible}): affected ${count} assets`);
  console.log(`  Types in loadedAssets: ${Array.from(typesFound).join(", ")}`);
}

/**
 * Toggle wireframe mode
 */
function setWireframeMode(enabled: boolean) {
  if (buildingMaterial) {
    (buildingMaterial as THREE.MeshStandardMaterial).wireframe = enabled;
  }
  console.log(`Wireframe mode: ${enabled}`);
}

/**
 * Toggle building textures on/off
 */
function setBuildingTexturesMode(enabled: boolean) {
  buildingTexturesEnabled = enabled;

  // Update zone toggle state
  const zoneToggle = document.getElementById("zone-toggle") as HTMLInputElement;
  if (zoneToggle) {
    zoneToggle.disabled = enabled;
    if (enabled) {
      // When textures enabled, turn off zone colors
      zoneToggle.checked = false;
      zoneColorsEnabled = false;
    }
  }

  // Update building materials
  updateBuildingMaterials();

  // Hide zone legend if textures are on
  const legend = document.getElementById("zone-legend");
  if (legend && enabled) {
    legend.classList.add("hidden");
  }

  console.log(`Building textures: ${enabled}`);
}

/**
 * Toggle SimCity-style zone colors on buildings
 */
function setZoneColorsMode(enabled: boolean) {
  // Only allow zone colors when textures are off
  if (buildingTexturesEnabled) {
    enabled = false;
  }

  zoneColorsEnabled = enabled;
  updateBuildingMaterials();

  // Update footprint shader uniform
  footprintUniforms.showZoneColors.value = enabled;

  // Show/hide legend
  const legend = document.getElementById("zone-legend");
  if (legend) {
    legend.classList.toggle("hidden", !enabled);
  }

  console.log(`Zone colors: ${enabled}`);
}

/**
 * Update building materials based on current toggle states
 */
function updateBuildingMaterials() {
  for (const [, loadedAsset] of loadedAssets) {
    if (loadedAsset.asset.type !== "buildings") continue;

    const chunkId = loadedAsset.asset.id;

    loadedAsset.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Store original material if not already stored
        if (!buildingOriginalMaterials.has(chunkId)) {
          buildingOriginalMaterials.set(chunkId, child.material);
        }

        if (buildingTexturesEnabled) {
          // Show original textures
          const originalMat = buildingOriginalMaterials.get(chunkId);
          if (originalMat) {
            child.material = originalMat;
          }
        } else if (zoneColorsEnabled) {
          // Show zone colors (dominant zone per chunk)
          let zoneMat = buildingZoneMaterials.get(chunkId);
          if (!zoneMat) {
            const dominantZone = getDominantZoneForChunk(chunkId);
            const zoneColor = CONFIG.materials.zones[dominantZone] as number;
            zoneMat = new THREE.MeshBasicMaterial({
              color: zoneColor,
              side: THREE.DoubleSide,
            });
            buildingZoneMaterials.set(chunkId, zoneMat);
          }
          child.material = zoneMat;
        } else {
          // Show null/dark material
          child.material = buildingNullMaterial;
        }
      }
    });
  }
}

/**
 * Set up layer menu controls
 */
function setupLayerMenu() {
  const burgerBtn = document.getElementById("burger-btn");
  const layerPanel = document.getElementById("layer-panel");

  if (burgerBtn && layerPanel) {
    // Toggle menu on burger click
    burgerBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent document click handler from firing
      burgerBtn.classList.toggle("open");
      layerPanel.classList.toggle("hidden");
    });

    // Prevent clicks inside panel from closing it
    layerPanel.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // Close menu when clicking outside
    document.addEventListener("click", () => {
      burgerBtn.classList.remove("open");
      layerPanel.classList.add("hidden");
    });
  }

  // Layer toggle checkboxes
  const checkboxes = document.querySelectorAll<HTMLInputElement>("#layer-panel input[type='checkbox'][data-layer]");
  console.log(`Setting up layer toggles: found ${checkboxes.length} checkboxes`);
  checkboxes.forEach((checkbox) => {
    const layerType = checkbox.dataset.layer;
    console.log(`  Adding change listener for layer: ${layerType}`);
    checkbox.addEventListener("change", () => {
      console.log(`Checkbox changed: ${layerType} → ${checkbox.checked}`);
      if (layerType) {
        setLayerVisibility(layerType, checkbox.checked);
      }
    });
  });

  // Wireframe toggle
  const wireframeToggle = document.getElementById("wireframe-toggle") as HTMLInputElement;
  if (wireframeToggle) {
    wireframeToggle.addEventListener("change", () => {
      setWireframeMode(wireframeToggle.checked);
    });
  }

  // Building textures toggle
  const texturesToggle = document.getElementById("textures-toggle") as HTMLInputElement;
  if (texturesToggle) {
    texturesToggle.addEventListener("change", () => {
      setBuildingTexturesMode(texturesToggle.checked);
    });
  }

  // Zone colors toggle
  const zoneToggle = document.getElementById("zone-toggle") as HTMLInputElement;
  if (zoneToggle) {
    zoneToggle.addEventListener("change", () => {
      setZoneColorsMode(zoneToggle.checked);
    });
  }
}

// Close button handler
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("close-info");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      // Reset selection via GPU uniform
      selectedBuildingIndex = -1;
      buildingShaderUniforms.selectedBuildingId.value = -1.0;
      hideBuildingInfo();
    });
  }

  // Set up layer menu
  setupLayerMenu();
});

// Start
init().catch(console.error);
