/**
 * Blyth Digital Twin - Web Viewer
 *
 * Three.js-based viewer for the Blyth digital twin.
 * Features:
 * - OrbitControls for god's eye view navigation
 * - Chunk-based asset loading
 * - Z-up coordinate system (geographic convention)
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
  type: "terrain" | "buildings" | "roads" | "railways" | "water" | "sea";
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

// Configuration
const CONFIG = {
  manifestUrl: "/manifest.json",
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
  },
};

// Globals
let camera: THREE.PerspectiveCamera;
let scene: THREE.Scene;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let manifest: Manifest | null = null;
const loadedAssets: Map<string, LoadedAsset> = new Map();
const loader = new GLTFLoader();

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

  // Window resize
  window.addEventListener("resize", onWindowResize);

  // Load manifest and assets
  try {
    await loadManifest();
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
      Drag: Orbit | Right-drag: Pan | Scroll: Zoom
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

  // Sort assets by layer order: terrain → roads → railways → water → sea → buildings
  const layerOrder: Record<string, number> = {
    terrain: 0,
    roads: 1,
    railways: 2,
    water: 3,
    sea: 4,
    buildings: 5,
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

// Start
init().catch(console.error);
