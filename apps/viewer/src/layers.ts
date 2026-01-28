import * as THREE from "three";

import { CONFIG } from "./types.ts";
import type { ViewerState } from "./state.ts";
import { getDominantZoneForChunk } from "./state.ts";

/**
 * Toggle visibility of all assets of a given type
 */
export function setLayerVisibility(state: ViewerState, layerType: string, visible: boolean) {
  state.layerEnabled.set(layerType, visible);

  let count = 0;
  const typesFound = new Set<string>();
  for (const [, loadedAsset] of state.loadedAssets) {
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
export function setWireframeMode(state: ViewerState, enabled: boolean) {
  if (state.buildingMaterial) {
    (state.buildingMaterial as THREE.MeshStandardMaterial).wireframe = enabled;
  }
  console.log(`Wireframe mode: ${enabled}`);
}

/**
 * Toggle building textures on/off
 */
export function setBuildingTexturesMode(state: ViewerState, enabled: boolean) {
  state.buildingTexturesEnabled = enabled;

  const zoneToggle = document.getElementById("zone-toggle") as HTMLInputElement;
  if (zoneToggle) {
    zoneToggle.disabled = enabled;
    if (enabled) {
      zoneToggle.checked = false;
      state.zoneColorsEnabled = false;
    }
  }

  updateBuildingMaterials(state);

  const legend = document.getElementById("zone-legend");
  if (legend && enabled) {
    legend.classList.add("hidden");
  }

  console.log(`Building textures: ${enabled}`);
}

/**
 * Toggle SimCity-style zone colors on buildings
 */
export function setZoneColorsMode(state: ViewerState, enabled: boolean) {
  if (state.buildingTexturesEnabled) {
    enabled = false;
  }

  state.zoneColorsEnabled = enabled;
  updateBuildingMaterials(state);

  state.footprintUniforms.showZoneColors.value = enabled;

  const legend = document.getElementById("zone-legend");
  if (legend) {
    legend.classList.toggle("hidden", !enabled);
  }

  console.log(`Zone colors: ${enabled}`);
}

/**
 * Update building materials based on current toggle states
 */
function updateBuildingMaterials(state: ViewerState) {
  for (const [, loadedAsset] of state.loadedAssets) {
    if (loadedAsset.asset.type !== "buildings") continue;

    const chunkId = loadedAsset.asset.id;

    loadedAsset.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (!state.buildingOriginalMaterials.has(chunkId)) {
          state.buildingOriginalMaterials.set(chunkId, child.material);
        }

        if (state.buildingTexturesEnabled) {
          const originalMat = state.buildingOriginalMaterials.get(chunkId);
          if (originalMat) {
            child.material = originalMat;
          }
        } else if (state.zoneColorsEnabled) {
          let zoneMat = state.buildingZoneMaterials.get(chunkId);
          if (!zoneMat) {
            const dominantZone = getDominantZoneForChunk(state, chunkId, CONFIG);
            const zoneColor = CONFIG.materials.zones[dominantZone] as number;
            zoneMat = new THREE.MeshBasicMaterial({
              color: zoneColor,
              side: THREE.DoubleSide,
            });
            state.buildingZoneMaterials.set(chunkId, zoneMat);
          }
          child.material = zoneMat;
        } else {
          child.material = state.buildingNullMaterial;
        }
      }
    });
  }
}

/**
 * Update LOD visibility based on camera distance
 */
export function updateLOD(state: ViewerState) {
  if (!CONFIG.lod.enabled) return;

  const now = performance.now();
  if (now - state.lastLodUpdate < CONFIG.lod.updateInterval) return;
  state.lastLodUpdate = now;

  const camPos = new THREE.Vector2(state.camera.position.x, state.camera.position.y);
  const camAlt = state.camera.position.z;

  const altitudeScale = Math.max(1, camAlt / 1000);
  const cullDistance = CONFIG.lod.buildingCullDistance * altitudeScale;

  if (!state.layerEnabled.get("buildings")) return;

  for (const [, loadedAsset] of state.loadedAssets) {
    if (loadedAsset.asset.type !== "buildings") continue;

    const bbox = loadedAsset.asset.bbox;
    if (!bbox) continue;

    const chunkCenter = new THREE.Vector2(
      (bbox.min_x + bbox.max_x) / 2,
      (bbox.min_y + bbox.max_y) / 2,
    );

    const distance = camPos.distanceTo(chunkCenter);
    loadedAsset.mesh.visible = distance < cullDistance;
  }
}

/**
 * Set up layer menu controls
 */
export function setupLayerMenu(state: ViewerState) {
  const burgerBtn = document.getElementById("burger-btn");
  const layerPanel = document.getElementById("layer-panel");

  if (burgerBtn && layerPanel) {
    burgerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      burgerBtn.classList.toggle("open");
      layerPanel.classList.toggle("hidden");
    });

    layerPanel.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    document.addEventListener("click", () => {
      burgerBtn.classList.remove("open");
      layerPanel.classList.add("hidden");
    });
  }

  const checkboxes = document.querySelectorAll<HTMLInputElement>("#layer-panel input[type='checkbox'][data-layer]");
  console.log(`Setting up layer toggles: found ${checkboxes.length} checkboxes`);
  checkboxes.forEach((checkbox) => {
    const layerType = checkbox.dataset.layer;
    console.log(`  Adding change listener for layer: ${layerType}`);
    checkbox.addEventListener("change", () => {
      console.log(`Checkbox changed: ${layerType} → ${checkbox.checked}`);
      if (layerType) {
        setLayerVisibility(state, layerType, checkbox.checked);
      }
    });
  });

  const wireframeToggle = document.getElementById("wireframe-toggle") as HTMLInputElement;
  if (wireframeToggle) {
    wireframeToggle.addEventListener("change", () => {
      setWireframeMode(state, wireframeToggle.checked);
    });
  }

  const texturesToggle = document.getElementById("textures-toggle") as HTMLInputElement;
  if (texturesToggle) {
    texturesToggle.addEventListener("change", () => {
      setBuildingTexturesMode(state, texturesToggle.checked);
    });
  }

  const zoneToggle = document.getElementById("zone-toggle") as HTMLInputElement;
  if (zoneToggle) {
    zoneToggle.addEventListener("change", () => {
      setZoneColorsMode(state, zoneToggle.checked);
    });
  }
}
