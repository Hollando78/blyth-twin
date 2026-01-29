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
  loadCustomMeshes,
  loadTerrainTextureDeferred,
} from "./asset-loader.ts";
import { onPointerMove, onClick, hideBuildingInfo, getCurrentBuilding, setViewerStateRef } from "./selection.ts";
import { setupLayerMenu, updateLOD } from "./layers.ts";
import { toggleEditMode, isEditModeEnabled, subscribeToEditState } from "./edit-mode.ts";
import { initEditPanel, showEditPanel, hideEditPanel } from "./edit-panel.ts";
import { initMeshUpload } from "./mesh-upload.ts";
import { openPreviewWindow } from "./mesh-preview.ts";

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
    // Parallelize independent initialization tasks
    await Promise.all([
      initializeTextures(state),
      loadManifest(state),
      loadFootprintMetadata(state),
      loadBuildingMetadata(state),
    ]);

    // Set viewer state reference for cache updates from edit panel
    setViewerStateRef(state);

    if (state.manifest) {
      state.totalAssets = state.manifest.assets.length;
      await loadAllAssets(state, progressEl);
    }

    // Load custom meshes from API (replaces procedural buildings with user edits)
    await loadCustomMeshes(state);

    if (loadingEl) loadingEl.classList.add("hidden");

    // Load terrain satellite imagery in background (non-blocking for faster startup)
    loadTerrainTextureDeferred(state).catch(console.warn);
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

// Close button handler + layer menu + edit mode
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("close-info");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      state.selectedBuildingIndex = -1;
      state.buildingShaderUniforms.selectedBuildingId.value = -1.0;
      hideBuildingInfo();
      hideEditPanel();
    });
  }

  setupLayerMenu(state);

  // Initialize edit mode UI
  initEditPanel();
  initMeshUpload();

  // Set up view mesh button
  const viewMeshBtn = document.getElementById("view-mesh-btn");
  if (viewMeshBtn) {
    viewMeshBtn.addEventListener("click", () => {
      const current = getCurrentBuilding();
      if (current.osmId && state.selectedBuildingIndex >= 0) {
        openPreviewWindow(state, current.osmId, state.selectedBuildingIndex);
      }
    });
  }

  // Set up edit button in building info panel
  const editBtn = document.getElementById("edit-building-btn");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      const current = getCurrentBuilding();
      if (current.osmId && current.props) {
        if (!isEditModeEnabled()) {
          toggleEditMode();
        }
        showEditPanel(current.osmId, current.props);
      }
    });
  }

  // Set up edit mode toggle button
  const editToggleBtn = document.getElementById("edit-mode-toggle");
  if (editToggleBtn) {
    editToggleBtn.addEventListener("click", () => {
      toggleEditMode();
    });

    // Update button state when edit mode changes
    subscribeToEditState((editState) => {
      editToggleBtn.classList.toggle("active", editState.enabled);
      editToggleBtn.textContent = editState.enabled ? "Exit Edit Mode" : "Edit Mode";
    });
  }
});

// Start
init().catch(console.error);
