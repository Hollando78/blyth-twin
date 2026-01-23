/**
 * Blyth Digital Twin - Web Viewer
 *
 * Three.js-based viewer for the Blyth digital twin.
 * Features:
 * - Fly controls (WASD + mouse)
 * - Chunk-based asset loading
 * - Progressive loading with distance-based prioritization
 * - Basic lighting and fog
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

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
  type: "terrain" | "buildings";
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
    fov: 60,
    near: 1,
    far: 10000,
    initialPosition: new THREE.Vector3(0, 300, 1000),
  },
  fog: {
    color: 0x87ceeb,
    near: 1000,
    far: 6000,
  },
  controls: {
    moveSpeed: 150,
    lookSpeed: 0.002,
    sprintMultiplier: 3,
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
  },
};

// Globals
let camera: THREE.PerspectiveCamera;
let scene: THREE.Scene;
let renderer: THREE.WebGLRenderer;
let manifest: Manifest | null = null;
const loadedAssets: Map<string, LoadedAsset> = new Map();
const loader = new GLTFLoader();

// Controls state
const keys: Record<string, boolean> = {};
let isPointerLocked = false;
const euler = new THREE.Euler(0, 0, 0, "YXZ");

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

  // Camera
  camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far
  );
  camera.position.copy(CONFIG.camera.initialPosition);
  camera.lookAt(0, 0, 0);

  // Lighting
  setupLighting();

  // Controls
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
 * Set up scene lighting
 */
function setupLighting() {
  // Ambient light
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);

  // Directional light (sun)
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(1000, 2000, 1000);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 100;
  sun.shadow.camera.far = 5000;
  sun.shadow.camera.left = -2500;
  sun.shadow.camera.right = 2500;
  sun.shadow.camera.top = 2500;
  sun.shadow.camera.bottom = -2500;
  scene.add(sun);

  // Hemisphere light for sky/ground color
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4a7c4e, 0.4);
  scene.add(hemi);
}

/**
 * Set up fly controls
 */
function setupControls(canvas: HTMLCanvasElement) {
  // Keyboard
  document.addEventListener("keydown", (e) => {
    keys[e.code] = true;
  });

  document.addEventListener("keyup", (e) => {
    keys[e.code] = false;
  });

  // Pointer lock for mouse look
  canvas.addEventListener("click", () => {
    canvas.requestPointerLock();
  });

  document.addEventListener("pointerlockchange", () => {
    isPointerLocked = document.pointerLockElement === canvas;
    const infoEl = document.getElementById("info");
    if (infoEl) {
      infoEl.style.opacity = isPointerLocked ? "0.3" : "1";
    }
  });

  document.addEventListener("mousemove", (e) => {
    if (!isPointerLocked) return;

    euler.setFromQuaternion(camera.quaternion);
    euler.y -= e.movementX * CONFIG.controls.lookSpeed;
    euler.x -= e.movementY * CONFIG.controls.lookSpeed;
    euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
    camera.quaternion.setFromEuler(euler);
  });
}

/**
 * Update camera position based on input
 */
function updateControls(delta: number) {
  const sprint = keys["ShiftLeft"] || keys["ShiftRight"] ? CONFIG.controls.sprintMultiplier : 1;
  const moveSpeed = CONFIG.controls.moveSpeed * delta * sprint;

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  const right = new THREE.Vector3();
  right.crossVectors(forward, new THREE.Vector3(0, 1, 0));

  if (keys["KeyW"]) camera.position.addScaledVector(forward, moveSpeed);
  if (keys["KeyS"]) camera.position.addScaledVector(forward, -moveSpeed);
  if (keys["KeyA"]) camera.position.addScaledVector(right, -moveSpeed);
  if (keys["KeyD"]) camera.position.addScaledVector(right, moveSpeed);
  if (keys["Space"]) camera.position.y += moveSpeed;
  if (keys["KeyQ"]) camera.position.y -= moveSpeed;
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

  // Sort assets: terrain first, then buildings
  const sortedAssets = [...manifest.assets].sort((a, b) => {
    if (a.type === "terrain" && b.type === "buildings") return -1;
    if (a.type === "buildings" && b.type === "terrain") return 1;
    return 0;
  });

  // Load assets in batches
  const batchSize = 10;
  for (let i = 0; i < sortedAssets.length; i += batchSize) {
    const batch = sortedAssets.slice(i, i + batchSize);
    await Promise.all(batch.map((asset) => loadAsset(asset, progressEl)));
  }
}

/**
 * Load a single asset
 */
async function loadAsset(asset: Asset, progressEl: HTMLElement | null): Promise<void> {
  // Handle gzipped assets - try uncompressed first, then gzipped
  let url = CONFIG.assetsBasePath + asset.url;

  // If URL ends with .gz, also try without .gz
  const baseUrl = url.endsWith(".gz") ? url.slice(0, -3) : url;

  return new Promise((resolve) => {
    // Try loading the asset
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
        // If base URL failed and we have a .gz version, the server might handle decompression
        // For now, just log the error
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
  // Apply materials based on type
  const material = asset.type === "terrain"
    ? new THREE.MeshLambertMaterial({
        color: CONFIG.materials.terrain.color,
        flatShading: CONFIG.materials.terrain.flatShading,
      })
    : new THREE.MeshLambertMaterial({
        color: CONFIG.materials.buildings.color,
        flatShading: CONFIG.materials.buildings.flatShading,
      });

  // Apply material to all meshes in the object
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = material;
      child.castShadow = asset.type === "buildings";
      child.receiveShadow = true;
    }
  });

  // Add to scene
  scene.add(object);

  // Track loaded asset
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
    posEl.textContent = `Position: ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`;
  }
}

/**
 * Animation loop
 */
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  updateControls(delta);
  updateHUD();

  renderer.render(scene, camera);
}

// Start
init().catch(console.error);
