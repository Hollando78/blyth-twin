import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { CONFIG } from "./types.ts";
import type { ViewerState } from "./state.ts";

/**
 * Create renderer, scene, and camera. Mutates state in place.
 */
export function initRendererSceneCamera(state: ViewerState, canvas: HTMLCanvasElement) {
  // Renderer
  const renderer = new THREE.WebGLRenderer({
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

  state.renderer = renderer;

  // Scene
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(
    CONFIG.fog.color,
    CONFIG.fog.near,
    CONFIG.fog.far,
  );
  state.scene = scene;

  // Camera (Z-up coordinate system)
  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far,
  );
  camera.position.copy(CONFIG.camera.initialPosition);
  camera.up.set(0, 0, 1); // Z is up (geographic convention)
  camera.lookAt(0, 0, 0);
  state.camera = camera;
}

/**
 * Set up scene lighting (Z-up coordinate system)
 */
export function setupLighting(state: ViewerState) {
  // Ambient light
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  state.scene.add(ambient);

  // Directional light (sun) - positioned high in Z for Z-up system
  const sunLight = new THREE.DirectionalLight(0xffffff, 0.8);
  sunLight.position.set(1000, -1000, 3000);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 100;
  sunLight.shadow.camera.far = 6000;
  sunLight.shadow.camera.left = -3000;
  sunLight.shadow.camera.right = 3000;
  sunLight.shadow.camera.top = 3000;
  sunLight.shadow.camera.bottom = -3000;
  state.scene.add(sunLight);
  state.sunLight = sunLight;

  // Hemisphere light (sky above in Z, ground below)
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x4a7c4e, 0.4);
  hemi.position.set(0, 0, 1);
  state.scene.add(hemi);
}

/**
 * Add red border around AOI (5km x 5km square)
 */
export function addAOIBorder(state: ViewerState) {
  const halfSize = 2500;
  const z = 50;

  const points = [
    new THREE.Vector3(-halfSize, -halfSize, z),
    new THREE.Vector3(halfSize, -halfSize, z),
    new THREE.Vector3(halfSize, halfSize, z),
    new THREE.Vector3(-halfSize, halfSize, z),
    new THREE.Vector3(-halfSize, -halfSize, z),
  ];

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
  const border = new THREE.Line(geometry, material);

  state.scene.add(border);
}

/**
 * Set up OrbitControls for god's eye view navigation
 */
export function setupControls(state: ViewerState, canvas: HTMLCanvasElement) {
  const controls = new OrbitControls(state.camera, canvas);
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
  const AOI_HALF = 2500;
  const constrainTarget = () => {
    const target = controls.target;
    target.x = Math.max(-AOI_HALF, Math.min(AOI_HALF, target.x));
    target.y = Math.max(-AOI_HALF, Math.min(AOI_HALF, target.y));
    target.z = Math.max(0, Math.min(500, target.z));
  };

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

  state.controls = controls;
}

/**
 * Handle window resize
 */
export function onWindowResize(state: ViewerState) {
  state.camera.aspect = window.innerWidth / window.innerHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Update HUD with camera position
 */
export function updateHUD(state: ViewerState) {
  const posEl = document.getElementById("position");
  if (posEl) {
    const pos = state.camera.position;
    posEl.textContent = `Alt: ${pos.z.toFixed(0)}m | X: ${pos.x.toFixed(0)} Y: ${pos.y.toFixed(0)}`;
  }
}
