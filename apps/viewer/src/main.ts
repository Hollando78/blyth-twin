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

import { createViewerState } from "./state.ts";
import {
  initRendererSceneCamera,
  setupLighting,
  addAOIBorder,
  setupControls,
  onWindowResize,
  updateHUD,
} from "./scene-setup.ts";
import {
  initializeTextures,
  loadManifest,
  loadFootprintMetadata,
  loadBuildingMetadata,
  loadAllAssets,
  updateWaterAnimation,
} from "./asset-loader.ts";
import { onPointerMove, onClick, hideBuildingInfo } from "./selection.ts";
import { setupLayerMenu, updateLOD } from "./layers.ts";

const state = createViewerState();

async function init() {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const loadingEl = document.getElementById("loading");
  const progressEl = document.getElementById("progress");

  // Set up renderer, scene, camera
  initRendererSceneCamera(state, canvas);
  setupLighting(state);
  addAOIBorder(state);
  setupControls(state, canvas);

  // Event listeners
  window.addEventListener("resize", () => onWindowResize(state));
  canvas.addEventListener("pointermove", (e) => onPointerMove(state, e));
  canvas.addEventListener("click", (e) => onClick(state, e));

  // Load textures, manifest and assets
  try {
    await initializeTextures(state);
    await loadManifest(state);
    await loadFootprintMetadata(state);
    await loadBuildingMetadata(state);
    if (state.manifest) {
      state.totalAssets = state.manifest.assets.length;
      await loadAllAssets(state, progressEl);
    }
    if (loadingEl) loadingEl.classList.add("hidden");
  } catch (error) {
    console.error("Failed to load assets:", error);
    if (loadingEl) loadingEl.textContent = "Failed to load assets. Check console for details.";
  }

  // Start render loop
  animate();
}

function animate() {
  requestAnimationFrame(animate);

  const deltaTime = state.clock.getDelta();

  // Update building highlight time for pulsing glow
  state.buildingShaderUniforms.time.value += deltaTime;

  state.controls.update();
  updateHUD(state);
  updateWaterAnimation(state, deltaTime);
  updateLOD(state);

  state.renderer.render(state.scene, state.camera);
}

// Close button handler + layer menu
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("close-info");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      state.selectedBuildingIndex = -1;
      state.buildingShaderUniforms.selectedBuildingId.value = -1.0;
      hideBuildingInfo();
    });
  }

  setupLayerMenu(state);
});

// Start
init().catch(console.error);
