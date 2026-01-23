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
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
  type: "terrain" | "buildings" | "roads" | "railways" | "water" | "sea" | "footprints";
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
}

interface FootprintMetadata {
  chunks: Record<string, ChunkMetadata>;
  buildings: Record<string, BuildingProperties>;
}

// Configuration
const CONFIG = {
  manifestUrl: "/manifest.json",
  footprintMetadataUrl: "/footprints_metadata.json",
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
    },
    roads: {
      color: 0x3a3a3a,
    },
    railways: {
      color: 0x8b4513,
    },
    water: {
      color: 0x4da6ff,
      opacity: 0.85,
    },
    sea: {
      color: 0x1a5c8c,
      opacity: 0.9,
    },
    footprints: {
      hoverColor: 0x00ff00,
      hoverOpacity: 0.3,
      selectedColor: 0xffff00,
      selectedOpacity: 0.6,
    },
  },
};

// Globals
let camera: THREE.PerspectiveCamera;
let scene: THREE.Scene;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let manifest: Manifest | null = null;
let footprintMetadata: FootprintMetadata | null = null;
const loadedAssets: Map<string, LoadedAsset> = new Map();
const loader = new GLTFLoader();

// Footprint meshes for raycasting
const footprintMeshes: Map<string, THREE.Mesh> = new Map();  // chunk_id -> mesh
const footprintMaterials: Map<string, THREE.MeshBasicMaterial> = new Map();  // chunk_id -> material

// Raycasting
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoveredBuildingId: number | null = null;
let hoveredChunkId: string | null = null;
let selectedBuildingId: number | null = null;
let selectedChunkId: string | null = null;

// Loading state
let totalAssets = 0;
let loadedCount = 0;

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

  // Load manifest and assets
  try {
    await loadManifest();
    await loadFootprintMetadata();
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
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(1000, -1000, 3000);  // High Z = above terrain
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 100;
  sun.shadow.camera.far = 6000;
  sun.shadow.camera.left = -3000;
  sun.shadow.camera.right = 3000;
  sun.shadow.camera.top = 3000;
  sun.shadow.camera.bottom = -3000;
  scene.add(sun);

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
  };
  const sortedAssets = [...manifest.assets].sort((a, b) => {
    return (layerOrder[a.type] ?? 99) - (layerOrder[b.type] ?? 99);
  });

  // Load assets sequentially to avoid memory issues
  for (const asset of sortedAssets) {
    await loadAsset(asset, progressEl);
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
 * Process a loaded asset and add to scene
 */
function processLoadedAsset(asset: Asset, object: THREE.Object3D) {
  // Special handling for footprints
  if (asset.type === "footprints") {
    processFootprintAsset(asset, object);
    return;
  }

  let material: THREE.Material;

  switch (asset.type) {
    case "terrain":
      material = new THREE.MeshLambertMaterial({
        color: CONFIG.materials.terrain.color,
        flatShading: CONFIG.materials.terrain.flatShading,
      });
      break;
    case "buildings":
      material = new THREE.MeshLambertMaterial({
        color: CONFIG.materials.buildings.color,
        flatShading: CONFIG.materials.buildings.flatShading,
      });
      break;
    case "roads":
      material = new THREE.MeshBasicMaterial({
        color: CONFIG.materials.roads.color,
        side: THREE.DoubleSide,
      });
      break;
    case "railways":
      material = new THREE.MeshBasicMaterial({
        color: CONFIG.materials.railways.color,
        side: THREE.DoubleSide,
      });
      break;
    case "water":
      material = new THREE.MeshBasicMaterial({
        color: CONFIG.materials.water.color,
        transparent: true,
        opacity: CONFIG.materials.water.opacity,
        side: THREE.DoubleSide,
      });
      break;
    case "sea":
      material = new THREE.MeshBasicMaterial({
        color: CONFIG.materials.sea.color,
        transparent: true,
        opacity: CONFIG.materials.sea.opacity,
        side: THREE.DoubleSide,
      });
      break;
    default:
      material = new THREE.MeshLambertMaterial({ color: 0x888888 });
  }

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = material;
      child.castShadow = asset.type === "buildings";
      child.receiveShadow = asset.type === "terrain" || asset.type === "roads";
    }
  });

  scene.add(object);

  loadedAssets.set(asset.id, {
    asset,
    mesh: object,
    loaded: true,
  });
}

/**
 * Process footprint assets with special material for selection
 */
function processFootprintAsset(asset: Asset, object: THREE.Object3D) {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,  // Invisible until hover
    depthWrite: false,
    side: THREE.DoubleSide,
    color: CONFIG.materials.footprints.hoverColor,
  });

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = material;
      // Store reference for raycasting
      footprintMeshes.set(asset.id, child);
      footprintMaterials.set(asset.id, material);
    }
  });

  scene.add(object);

  loadedAssets.set(asset.id, {
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
 * Handle pointer move for hover effects
 */
function onPointerMove(event: PointerEvent) {
  // Calculate normalized device coordinates
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast against footprint meshes
  raycaster.setFromCamera(pointer, camera);
  const meshes = Array.from(footprintMeshes.values());
  const intersects = raycaster.intersectObjects(meshes, false);

  // Reset previous hover
  if (hoveredChunkId && hoveredBuildingId !== selectedBuildingId) {
    const mat = footprintMaterials.get(hoveredChunkId);
    if (mat && hoveredChunkId !== selectedChunkId) {
      mat.opacity = 0;
    }
  }

  if (intersects.length > 0) {
    const intersection = intersects[0];
    const faceIndex = intersection.faceIndex;

    // Find which chunk was hit
    let hitChunkId: string | null = null;
    for (const [chunkId, mesh] of footprintMeshes.entries()) {
      if (mesh === intersection.object) {
        hitChunkId = chunkId;
        break;
      }
    }

    if (hitChunkId && faceIndex !== undefined) {
      const buildingId = findBuildingFromFace(hitChunkId, faceIndex);

      if (buildingId !== null && buildingId !== selectedBuildingId) {
        hoveredBuildingId = buildingId;
        hoveredChunkId = hitChunkId;

        // Apply hover effect
        const mat = footprintMaterials.get(hitChunkId);
        if (mat) {
          mat.color.setHex(CONFIG.materials.footprints.hoverColor);
          mat.opacity = CONFIG.materials.footprints.hoverOpacity;
        }

        // Change cursor
        document.body.style.cursor = "pointer";
      }
    }
  } else {
    hoveredBuildingId = null;
    hoveredChunkId = null;
    document.body.style.cursor = "default";
  }
}

/**
 * Handle click for selection
 */
function onClick(event: MouseEvent) {
  // Calculate normalized device coordinates
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast against footprint meshes
  raycaster.setFromCamera(pointer, camera);
  const meshes = Array.from(footprintMeshes.values());
  const intersects = raycaster.intersectObjects(meshes, false);

  // Reset previous selection visual
  if (selectedChunkId) {
    const mat = footprintMaterials.get(selectedChunkId);
    if (mat) {
      mat.opacity = 0;
    }
  }

  if (intersects.length > 0) {
    const intersection = intersects[0];
    const faceIndex = intersection.faceIndex;

    // Find which chunk was hit
    let hitChunkId: string | null = null;
    for (const [chunkId, mesh] of footprintMeshes.entries()) {
      if (mesh === intersection.object) {
        hitChunkId = chunkId;
        break;
      }
    }

    if (hitChunkId && faceIndex !== undefined) {
      const buildingId = findBuildingFromFace(hitChunkId, faceIndex);

      if (buildingId !== null) {
        selectedBuildingId = buildingId;
        selectedChunkId = hitChunkId;

        // Apply selection effect
        const mat = footprintMaterials.get(hitChunkId);
        if (mat) {
          mat.color.setHex(CONFIG.materials.footprints.selectedColor);
          mat.opacity = CONFIG.materials.footprints.selectedOpacity;
        }

        // Show info panel
        const props = getBuildingProperties(buildingId);
        showBuildingInfo(props);
      }
    }
  } else {
    // Clicked empty space - deselect
    selectedBuildingId = null;
    selectedChunkId = null;
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
 */
function showBuildingInfo(props: BuildingProperties | null) {
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
 * Animation loop
 */
function animate() {
  requestAnimationFrame(animate);

  controls.update();
  updateHUD();

  renderer.render(scene, camera);
}

// Close button handler
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("close-info");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      // Reset selection
      if (selectedChunkId) {
        const mat = footprintMaterials.get(selectedChunkId);
        if (mat) {
          mat.opacity = 0;
        }
      }
      selectedBuildingId = null;
      selectedChunkId = null;
      hideBuildingInfo();
    });
  }
});

// Start
init().catch(console.error);
