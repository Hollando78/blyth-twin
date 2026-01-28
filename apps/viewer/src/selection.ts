import * as THREE from "three";

import type { BuildingProperties, BuildingFaceMapEntry } from "./types.ts";
import type { ViewerState } from "./state.ts";

/**
 * Find building entry from face index in building metadata (returns BuildingFaceMapEntry)
 */
export function findBuildingFromFaceMap(state: ViewerState, chunkId: string, faceIndex: number): BuildingFaceMapEntry | null {
  if (!state.buildingMetadata) return null;

  const faceMap = state.buildingMetadata.chunks[chunkId];
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
export function getGlobalBuildingIdFromFaceMap(state: ViewerState, chunkId: string, faceIndex: number): number {
  const entry = findBuildingFromFaceMap(state, chunkId, faceIndex);
  return entry ? entry.global_id : -1;
}

/**
 * Find building entry by global ID (searches all chunks)
 */
export function findBuildingByGlobalId(state: ViewerState, globalId: number): BuildingFaceMapEntry | null {
  if (!state.buildingMetadata) return null;

  for (const entries of Object.values(state.buildingMetadata.chunks)) {
    for (const entry of entries) {
      if (entry.global_id === globalId) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * Find building ID from face index in footprint metadata (binary search)
 */
export function findBuildingFromFace(state: ViewerState, chunkId: string, faceIndex: number): number | null {
  if (!state.footprintMetadata) return null;

  const chunkData = state.footprintMetadata.chunks[chunkId];
  if (!chunkData) return null;

  const faceMap = chunkData.face_map;

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
export function getBuildingProperties(state: ViewerState, buildingId: number): BuildingProperties | null {
  if (!state.footprintMetadata) return null;
  return state.footprintMetadata.buildings[String(buildingId)] || null;
}

/**
 * Get building properties by OSM ID (searches through all buildings)
 */
export function getBuildingPropertiesByOsmId(state: ViewerState, osmId: number): BuildingProperties | null {
  if (!state.footprintMetadata) return null;

  for (const props of Object.values(state.footprintMetadata.buildings)) {
    if (props.osm_id === osmId) {
      return props;
    }
  }

  return null;
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
    const indexAttr = geometry.index;
    const faceStartIndex = faceIndex * 3;
    if (faceStartIndex >= indexAttr.count) return -1;
    vertexIndex = indexAttr.getX(faceStartIndex);
  } else {
    vertexIndex = faceIndex * 3;
  }

  if (vertexIndex >= buildingIdAttr.count) return -1;

  return Math.round(buildingIdAttr.getX(vertexIndex));
}

/**
 * Handle pointer move for hover effects (GPU-based on 3D buildings)
 */
export function onPointerMove(state: ViewerState, event: PointerEvent) {
  state.pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  state.pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast against 3D building meshes
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const allBuildingMeshes: THREE.Mesh[] = [];
  for (const meshList of state.buildingMeshes.values()) {
    allBuildingMeshes.push(...meshList);
  }
  const intersects = state.raycaster.intersectObjects(allBuildingMeshes, false);

  if (intersects.length > 0) {
    const intersection = intersects[0];
    const faceIndex = intersection.faceIndex;
    const hitMesh = intersection.object as THREE.Mesh;

    // Find chunk ID
    let hitChunkId: string | null = null;
    for (const [chunkId, meshList] of state.buildingMeshes.entries()) {
      if (meshList.includes(hitMesh)) {
        hitChunkId = chunkId;
        break;
      }
    }

    // Get building index from vertex attribute
    if (faceIndex !== undefined && hitChunkId) {
      const buildingIndex = getBuildingIdFromVertexAttribute(hitMesh, faceIndex);
      if (buildingIndex >= 0 && buildingIndex !== state.selectedBuildingIndex) {
        state.buildingShaderUniforms.hoveredBuildingId.value = buildingIndex;
      }
    }

    document.body.style.cursor = "pointer";
  } else {
    state.buildingShaderUniforms.hoveredBuildingId.value = -1.0;
    document.body.style.cursor = "default";
  }
}

/**
 * Handle click for selection (GPU-based)
 */
export function onClick(state: ViewerState, event: MouseEvent) {
  state.pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  state.pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Raycast against 3D building meshes
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const allBuildingMeshes: THREE.Mesh[] = [];
  for (const meshList of state.buildingMeshes.values()) {
    allBuildingMeshes.push(...meshList);
  }
  const intersects = state.raycaster.intersectObjects(allBuildingMeshes, false);

  if (intersects.length > 0) {
    const intersection = intersects[0];
    const faceIndex = intersection.faceIndex;
    const hitMesh = intersection.object as THREE.Mesh;

    // Find chunk ID for metadata lookup
    let hitChunkId: string | null = null;
    for (const [chunkId, meshList] of state.buildingMeshes.entries()) {
      if (meshList.includes(hitMesh)) {
        hitChunkId = chunkId;
        break;
      }
    }

    if (hitChunkId && faceIndex !== undefined) {
      const globalId = getBuildingIdFromVertexAttribute(hitMesh, faceIndex);

      if (globalId >= 0) {
        const entry = findBuildingByGlobalId(state, globalId);
        const osmId = entry?.osm_id || null;
        const props = osmId ? getBuildingPropertiesByOsmId(state, osmId) : null;

        state.selectedBuildingIndex = globalId;
        state.buildingShaderUniforms.selectedBuildingId.value = globalId;

        showBuildingInfo(props, osmId);
      }
    }
  } else {
    // Clicked empty space - deselect
    state.selectedBuildingIndex = -1;
    state.buildingShaderUniforms.selectedBuildingId.value = -1.0;
    hideBuildingInfo();
  }
}

function isMeaningfulType(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  return normalized !== "yes" && normalized !== "true" && normalized !== "1";
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, " ");
}

// Track the currently displayed building for edit mode
let currentDisplayedBuilding: { osmId: number | null; props: BuildingProperties | null } = {
  osmId: null,
  props: null,
};

/**
 * Get the currently displayed building info.
 */
export function getCurrentBuilding(): { osmId: number | null; props: BuildingProperties | null } {
  return currentDisplayedBuilding;
}

/**
 * Show building info panel
 */
export function showBuildingInfo(props: BuildingProperties | null, vertexOsmId?: number | null) {
  const panel = document.getElementById("building-info");
  const nameEl = document.getElementById("building-name");
  const propsEl = document.getElementById("building-props");

  if (!panel || !nameEl || !propsEl) return;

  // Track current building for edit mode
  currentDisplayedBuilding = {
    osmId: props?.osm_id || vertexOsmId || null,
    props,
  };

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

  let propsHtml = "";

  if (props?.building && isMeaningfulType(props.building)) {
    propsHtml += `<dt>Type</dt><dd>${capitalizeFirst(props.building)}</dd>`;
  }
  if (props?.amenity && isMeaningfulType(props.amenity)) {
    propsHtml += `<dt>Amenity</dt><dd>${capitalizeFirst(props.amenity)}</dd>`;
  }
  if (props?.shop && isMeaningfulType(props.shop)) {
    propsHtml += `<dt>Shop</dt><dd>${capitalizeFirst(props.shop)}</dd>`;
  }

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

  if (props?.height) {
    propsHtml += `<dt>Height</dt><dd>${props.height.toFixed(1)}m</dd>`;
  }

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
export function hideBuildingInfo() {
  const panel = document.getElementById("building-info");
  if (panel) {
    panel.classList.add("hidden");
  }

  // Clear tracked building
  currentDisplayedBuilding = { osmId: null, props: null };
}
