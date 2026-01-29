import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { CONFIG } from "./types.ts";
import type { Asset } from "./types.ts";
import type { ViewerState } from "./state.ts";
import { getZoneFromBuildingType } from "./state.ts";
import {
  footprintVertexShader,
  footprintFragmentShader,
  buildingVertexShader,
  buildingFragmentShader,
} from "./shaders.ts";
import {
  getGlobalBuildingIdFromFaceMap,
  findBuildingFromFace,
  getBuildingProperties,
} from "./selection.ts";
import { listBuildingsWithCustomMeshes, downloadMeshGLB, checkApiHealth, getBuilding } from "./api-client.ts";

// Texture generators
import { getSharedRoadMaterial, preloadRoadTextures } from "./textures/roads";
import { createRailwayMaterial, preloadRailwayTextures } from "./textures/railways";
import { createSimpleWaterMaterial, createSimpleSeaMaterial } from "./textures/water";
import { createBuildingMaterial } from "./textures/buildings";
import { createTerrainMaterial } from "./textures/terrain";

// Cached viewer state reference for use by loadAndApplyCustomMesh
let cachedViewerState: ViewerState | null = null;

/**
 * Initialize textures and materials
 */
export async function initializeTextures(state: ViewerState) {
  console.log("Initializing textures...");

  await Promise.all([
    preloadRoadTextures(),
    preloadRailwayTextures(),
  ]);
  console.log("  Procedural textures preloaded");

  if (CONFIG.materials.roads.useTexture) {
    state.roadMaterial = await getSharedRoadMaterial();
    console.log("  Road textures ready");
  }

  if (CONFIG.materials.railways.useTexture) {
    state.railwayMaterial = await createRailwayMaterial();
    console.log("  Railway textures ready");
  }

  if (CONFIG.materials.water.useShader) {
    state.waterMaterial = createSimpleWaterMaterial(
      CONFIG.materials.water.color,
      CONFIG.materials.water.opacity,
    );
    console.log("  Water material ready");
  }

  if (CONFIG.materials.sea.useShader) {
    state.seaMaterial = createSimpleSeaMaterial();
    console.log("  Sea material ready");
  }

  if (CONFIG.materials.buildings.useTexture) {
    state.buildingMaterial = await createBuildingMaterial();
    const bmat = state.buildingMaterial as THREE.MeshStandardMaterial;
    console.log("  Building material created:", {
      hasMap: !!bmat.map,
      mapWidth: bmat.map?.image?.width,
      mapHeight: bmat.map?.image?.height,
    });
  } else {
    state.buildingMaterial = new THREE.MeshStandardMaterial({
      color: CONFIG.materials.buildings.color,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0.0,
    });
  }

  // Use fallback terrain material initially for faster startup
  state.terrainMaterial = new THREE.MeshBasicMaterial({
    color: CONFIG.materials.terrain.color,
  });
  console.log("  Terrain using fallback material (satellite loading in background)");

  console.log("Textures initialized");
}

/**
 * Load terrain satellite imagery in background and upgrade terrain meshes.
 * Call this after initial assets are loaded for faster perceived startup.
 */
export async function loadTerrainTextureDeferred(state: ViewerState): Promise<void> {
  try {
    const satelliteMaterial = await createTerrainMaterial();
    state.terrainMaterial = satelliteMaterial;

    // Upgrade all loaded terrain meshes to satellite imagery
    for (const [, loadedAsset] of state.loadedAssets) {
      if (loadedAsset.asset.type === "terrain") {
        loadedAsset.mesh.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.material = satelliteMaterial;
          }
        });
      }
    }
    console.log("Terrain satellite imagery loaded and applied");
  } catch (error) {
    console.warn("Failed to load terrain satellite imagery:", error);
  }
}

/**
 * Load manifest.json
 */
export async function loadManifest(state: ViewerState) {
  const response = await fetch(CONFIG.manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to load manifest: ${response.status}`);
  }
  state.manifest = await response.json();
  console.log("Manifest loaded:", state.manifest?.name, `v${state.manifest?.version}`);
  console.log(`  Assets: ${state.manifest?.assets.length}`);
}

/**
 * Load footprint metadata
 */
export async function loadFootprintMetadata(state: ViewerState) {
  try {
    const response = await fetch(CONFIG.footprintMetadataUrl);
    if (response.ok) {
      state.footprintMetadata = await response.json();
      console.log("Footprint metadata loaded:", Object.keys(state.footprintMetadata?.buildings || {}).length, "buildings");
    }
  } catch (error) {
    console.warn("Failed to load footprint metadata:", error);
  }
}

/**
 * Load building metadata (face map for 3D building selection)
 */
export async function loadBuildingMetadata(state: ViewerState) {
  try {
    const response = await fetch(CONFIG.buildingMetadataUrl);
    if (response.ok) {
      state.buildingMetadata = await response.json();
      const chunkCount = Object.keys(state.buildingMetadata?.chunks || {}).length;
      console.log("Building metadata loaded:", chunkCount, "chunks");
    }
  } catch (error) {
    console.warn("Failed to load building metadata:", error);
  }
}

/**
 * Update loading progress
 */
function updateProgress(state: ViewerState, progressEl: HTMLElement | null) {
  if (progressEl) {
    const percent = state.totalAssets > 0 ? Math.round((state.loadedCount / state.totalAssets) * 100) : 0;
    progressEl.textContent = `Loading: ${state.loadedCount}/${state.totalAssets} (${percent}%)`;
  }
}

/**
 * Load all assets from manifest
 */
export async function loadAllAssets(state: ViewerState, progressEl: HTMLElement | null) {
  // Cache viewer state for later use by loadAndApplyCustomMesh
  cachedViewerState = state;

  if (!state.manifest) return;

  const layerOrder: Record<string, number> = {
    terrain: 0,
    roads: 1,
    railways: 2,
    water: 3,
    sea: 4,
    buildings: 5,
    footprints: 6,
    texture: 99,
  };

  const glbAssets = state.manifest.assets.filter(a => a.type !== "texture");
  state.totalAssets = glbAssets.length;

  const sortedAssets = [...glbAssets].sort((a, b) => {
    return (layerOrder[a.type] ?? 99) - (layerOrder[b.type] ?? 99);
  });

  const BATCH_SIZE = 12;
  for (let i = 0; i < sortedAssets.length; i += BATCH_SIZE) {
    const batch = sortedAssets.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(asset => loadAsset(state, asset, progressEl)));
  }
}

/**
 * Load a single asset
 */
async function loadAsset(state: ViewerState, asset: Asset, progressEl: HTMLElement | null): Promise<void> {
  const url = CONFIG.assetsBasePath + asset.url;
  const baseUrl = url.endsWith(".gz") ? url.slice(0, -3) : url;

  return new Promise((resolve) => {
    state.loader.load(
      baseUrl,
      (gltf) => {
        processLoadedAsset(state, asset, gltf.scene);
        state.loadedCount++;
        updateProgress(state, progressEl);
        resolve();
      },
      undefined,
      (error) => {
        console.warn(`Failed to load ${asset.id}:`, error);
        state.loadedCount++;
        updateProgress(state, progressEl);
        resolve();
      },
    );
  });
}

/**
 * Process building assets with GPU selection shader
 */
function processBuildingAsset(state: ViewerState, asset: Asset, object: THREE.Object3D) {
  const chunkId = asset.id;
  const meshList: THREE.Mesh[] = [];
  let meshIndex = 0;

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry as THREE.BufferGeometry;
      const existingMat = child.material as THREE.MeshStandardMaterial;

      let texture: THREE.Texture | null = null;
      if (existingMat.map && existingMat.map.image) {
        const img = existingMat.map.image;
        if (img.width > 2 && img.height > 2) {
          texture = existingMat.map;
        }
      }

      if (!texture && state.buildingMaterial) {
        texture = (state.buildingMaterial as THREE.MeshStandardMaterial).map;
      }

      const hasGlobalIdAttr = geometry.attributes._global_id !== undefined;

      let workingGeometry = geometry;
      if (geometry.index) {
        workingGeometry = geometry.toNonIndexed();
        child.geometry = workingGeometry;
      }

      if (hasGlobalIdAttr) {
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
      } else if (state.buildingMetadata) {
        console.warn(`  Chunk ${chunkId}: No _global_id in GLB, falling back to face map`);

        const positionCount = workingGeometry.attributes.position.count;
        const buildingIds = new Float32Array(positionCount);

        const faceCount = Math.floor(positionCount / 3);
        for (let faceIdx = 0; faceIdx < faceCount; faceIdx++) {
          const globalId = getGlobalBuildingIdFromFaceMap(state, chunkId, faceIdx);
          for (let v = 0; v < 3; v++) {
            buildingIds[faceIdx * 3 + v] = globalId;
          }
        }

        workingGeometry.setAttribute("_building_id", new THREE.BufferAttribute(buildingIds, 1));
      }

      meshIndex++;
      const finalGeometry = child.geometry as THREE.BufferGeometry;
      if (!finalGeometry.attributes.normal) {
        finalGeometry.computeVertexNormals();
      }

      const shaderMaterial = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: texture },
          hasMap: { value: texture !== null },
          baseColor: { value: new THREE.Color(CONFIG.materials.buildings.color) },
          selectedBuildingId: state.buildingShaderUniforms.selectedBuildingId,
          hoveredBuildingId: state.buildingShaderUniforms.hoveredBuildingId,
          emissiveColor: state.buildingShaderUniforms.emissiveColor,
          time: state.buildingShaderUniforms.time,
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

  state.scene.add(object);

  state.buildingMeshes.set(chunkId, meshList);

  const assetKey = `${asset.type}_${asset.id}`;
  state.loadedAssets.set(assetKey, {
    asset,
    mesh: object,
    loaded: true,
  });

  const hasMetadata = state.buildingMetadata?.chunks[chunkId] ? state.buildingMetadata.chunks[chunkId].length : 0;
  console.log(`  Buildings ${chunkId}: ${meshList.length} meshes, ${hasMetadata} entries in metadata`);
}

/**
 * Process a loaded asset and add to scene
 */
function processLoadedAsset(state: ViewerState, asset: Asset, object: THREE.Object3D) {
  console.log(`processLoadedAsset called: type=${asset.type}, id=${asset.id}`);

  if (asset.type === "footprints") {
    processFootprintAsset(state, asset, object);
    return;
  }

  if (asset.type === "buildings") {
    processBuildingAsset(state, asset, object);
    return;
  }

  console.log(`Processing asset: ${asset.type} (${asset.id})`);

  let material: THREE.Material | null = null;
  let isWater = false;

  switch (asset.type) {
    case "terrain":
      if (state.terrainMaterial) {
        material = state.terrainMaterial;
      } else {
        material = new THREE.MeshBasicMaterial({
          color: CONFIG.materials.terrain.color,
        });
      }
      break;

    case "roads":
      if (state.roadMaterial) {
        material = state.roadMaterial;
        console.log("  Using textured road material, has map:", !!(state.roadMaterial as THREE.MeshBasicMaterial).map);
      } else {
        console.log("  Road material not ready, using fallback");
        material = new THREE.MeshBasicMaterial({
          color: CONFIG.materials.roads.color,
          side: THREE.DoubleSide,
        });
      }
      break;

    case "railways":
      if (state.railwayMaterial) {
        material = state.railwayMaterial;
        console.log("  Using textured railway material, has map:", !!(state.railwayMaterial as THREE.MeshBasicMaterial).map);
      } else {
        console.log("  Railway material not ready, using fallback");
        material = new THREE.MeshBasicMaterial({
          color: CONFIG.materials.railways.color,
          side: THREE.DoubleSide,
        });
      }
      break;

    case "water":
      material = state.waterMaterial || new THREE.MeshBasicMaterial({
        color: CONFIG.materials.water.color,
        transparent: true,
        opacity: CONFIG.materials.water.opacity,
        side: THREE.DoubleSide,
      });
      isWater = true;
      break;

    case "sea":
      material = state.seaMaterial || new THREE.MeshBasicMaterial({
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
      const geom = child.geometry as THREE.BufferGeometry;
      if (geom.attributes.uv) {
        meshWithUV++;
      }

      if (material !== null) {
        child.material = material;
      }
      child.castShadow = asset.type === "buildings";
      child.receiveShadow = asset.type === "terrain" || asset.type === "roads";

      if (isWater) {
        state.waterObjects.push(child);
      }
    }
  });

  if (asset.type === "roads" || asset.type === "terrain") {
    console.log(`  ${asset.type} ${asset.id}: ${meshCount} meshes, ${meshWithUV} with UVs`);
  }

  state.scene.add(object);

  const assetKey = `${asset.type}_${asset.id}`;
  state.loadedAssets.set(assetKey, {
    asset,
    mesh: object,
    loaded: true,
  });
}

/**
 * Process footprint assets with GPU highlight shader
 */
function processFootprintAsset(state: ViewerState, asset: Asset, object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry as THREE.BufferGeometry;

      if (state.footprintMetadata && geometry.attributes.position) {
        const positionCount = geometry.attributes.position.count;
        const colors = new Float32Array(positionCount * 3);
        const osmIds = new Float32Array(positionCount);

        const chunkData = state.footprintMetadata.chunks[asset.id];
        if (chunkData) {
          const faceCount = positionCount / 3;

          for (let faceIdx = 0; faceIdx < faceCount; faceIdx++) {
            const buildingId = findBuildingFromFace(state, asset.id, faceIdx);
            const props = buildingId !== null ? getBuildingProperties(state, buildingId) : null;
            const zone = getZoneFromBuildingType(props);
            const zoneColor = new THREE.Color(CONFIG.materials.zones[zone as keyof typeof CONFIG.materials.zones] as number);
            const osmId = props?.osm_id || 0;

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

      const shaderMaterial = new THREE.ShaderMaterial({
        uniforms: state.footprintUniforms,
        vertexShader: footprintVertexShader,
        fragmentShader: footprintFragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexColors: true,
      });

      child.material = shaderMaterial;

      state.footprintMeshes.set(asset.id, child);
      state.footprintMaterials.set(asset.id, shaderMaterial);
    }
  });

  state.scene.add(object);

  const assetKey = `${asset.type}_${asset.id}`;
  state.loadedAssets.set(assetKey, {
    asset,
    mesh: object,
    loaded: true,
  });
}

/**
 * Update water animation
 */
export function updateWaterAnimation(state: ViewerState, deltaTime: number) {
  for (const waterObj of state.waterObjects) {
    if (waterObj instanceof THREE.Mesh) {
      const mat = waterObj.material as THREE.MeshStandardMaterial;
      if (mat.normalMap) {
        mat.normalMap.offset.x += deltaTime * 0.02;
        mat.normalMap.offset.y += deltaTime * 0.015;
      }
    }
  }
}

/**
 * Load custom meshes from API on startup.
 * This fetches user-edited building meshes and displays them instead of the procedural ones.
 */
export async function loadCustomMeshes(state: ViewerState): Promise<void> {
  // Check if API is available
  const apiAvailable = await checkApiHealth();
  if (!apiAvailable) {
    console.log("API not available - skipping custom mesh loading");
    return;
  }

  // Get list of buildings with custom meshes
  const customMeshOsmIds = await listBuildingsWithCustomMeshes();
  if (customMeshOsmIds.length === 0) {
    console.log("No custom meshes to load");
    return;
  }

  console.log(`Loading ${customMeshOsmIds.length} custom meshes...`);

  // IMPORTANT: Compute all building positions BEFORE hiding any faces
  // (hiding faces modifies chunk geometry which would corrupt subsequent lookups)
  const buildingPositions = new Map<number, { center: THREE.Vector3; baseZ: number }>();
  for (const osmId of customMeshOsmIds) {
    const pos = getOriginalBuildingPositionFromMetadata(state, osmId);
    if (pos) {
      buildingPositions.set(osmId, pos);
      console.log(`  Building ${osmId} position: center=(${pos.center.x.toFixed(1)}, ${pos.center.y.toFixed(1)}, ${pos.center.z.toFixed(1)}), baseZ=${pos.baseZ.toFixed(1)}`);
    } else {
      console.warn(`  Could not find position for building ${osmId}`);
    }
  }

  // Create a temporary GLTF loader for custom meshes
  const loader = new GLTFLoader();

  // Load and transform all custom meshes
  for (const osmId of customMeshOsmIds) {
    try {
      // Download the GLB data
      const glbData = await downloadMeshGLB(osmId);
      if (!glbData) {
        console.warn(`Failed to download mesh for building ${osmId}`);
        continue;
      }

      // Parse the GLB
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.parse(
          glbData,
          "",
          (result) => resolve(result),
          (error) => reject(error)
        );
      });

      // Find the first mesh in the loaded scene
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          meshes.push(child);
        }
      });

      if (meshes.length === 0) {
        console.warn(`No mesh found in GLB for building ${osmId}`);
        continue;
      }

      const customMesh = meshes[0];

      // Debug: log material info from loaded GLB
      const loadedMat = customMesh.material as THREE.MeshStandardMaterial;
      console.log(`  Custom mesh ${osmId} loaded with material:`, {
        type: loadedMat?.type,
        color: loadedMat?.color?.getHexString?.() || 'N/A',
        roughness: loadedMat?.roughness,
        metalness: loadedMat?.metalness,
      });

      // Set up the mesh
      customMesh.name = `custom_building_${osmId}`;
      customMesh.userData.osmId = osmId;
      customMesh.userData.isCustomMesh = true;

      // Transform mesh to world coordinates using pre-computed position
      const worldPosition = buildingPositions.get(osmId);
      if (worldPosition) {
        // The custom mesh is saved centered at origin with base at Z=0
        // Transform it back to world coordinates
        const geometry = customMesh.geometry as THREE.BufferGeometry;
        const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < positions.count; i++) {
          positions.setX(i, positions.getX(i) + worldPosition.center.x);
          positions.setY(i, positions.getY(i) + worldPosition.center.y);
          positions.setZ(i, positions.getZ(i) + worldPosition.baseZ);
        }
        positions.needsUpdate = true;
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.computeVertexNormals();
      }

      // Set shadow properties to match other buildings
      customMesh.castShadow = true;
      customMesh.receiveShadow = true;

      // Add to scene and track
      state.scene.add(customMesh);
      state.customMeshes.set(osmId, customMesh);

      console.log(`  Loaded custom mesh for building ${osmId}`);
    } catch (error) {
      console.warn(`Error loading custom mesh for building ${osmId}:`, error);
    }
  }

  // Hide original building faces AFTER all positions have been computed and meshes loaded
  for (const osmId of customMeshOsmIds) {
    if (state.customMeshes.has(osmId)) {
      hideOriginalBuildingFacesForOsmId(state, osmId);
    }
  }

  // Fetch building properties from API in parallel (may have overrides)
  const loadedOsmIds = Array.from(state.customMeshes.keys());
  await Promise.all(
    loadedOsmIds.map(osmId =>
      updateBuildingPropertiesFromApi(state, osmId)
        .catch(err => console.warn(`Failed to update properties for ${osmId}:`, err))
    )
  );

  console.log(`Finished loading custom meshes`);
}

/**
 * Fetch building data from API and update local metadata cache.
 */
async function updateBuildingPropertiesFromApi(state: ViewerState, osmId: number): Promise<void> {
  if (!state.footprintMetadata) return;

  try {
    const apiData = await getBuilding(osmId);
    if (!apiData.has_override) return; // No changes from OSM data

    const apiProps = apiData.properties;

    // Find the building in local metadata and update it
    for (const localProps of Object.values(state.footprintMetadata.buildings)) {
      if (localProps.osm_id === osmId) {
        // Update local cache with API values (overrides)
        if (apiProps.name !== undefined) localProps.name = apiProps.name;
        if (apiProps.height !== undefined) localProps.height = apiProps.height;
        if (apiProps.height_source !== undefined) localProps.height_source = apiProps.height_source;
        if (apiProps.building_type !== undefined) localProps.building = apiProps.building_type;
        if (apiProps.addr_housenumber !== undefined) localProps.addr_housenumber = apiProps.addr_housenumber;
        if (apiProps.addr_street !== undefined) localProps.addr_street = apiProps.addr_street;
        if (apiProps.addr_postcode !== undefined) localProps.addr_postcode = apiProps.addr_postcode;
        if (apiProps.addr_city !== undefined) localProps.addr_city = apiProps.addr_city;
        console.log(`  Updated properties cache for building ${osmId}`);
        return;
      }
    }
  } catch (error) {
    console.warn(`Failed to fetch building ${osmId} from API:`, error);
  }
}

/**
 * Get the original world position of a building from chunk geometry.
 * Returns the center (X, Y) and base Z of the building.
 */
function getOriginalBuildingPositionFromMetadata(
  state: ViewerState,
  osmId: number
): { center: THREE.Vector3; baseZ: number } | null {
  if (!state.buildingMetadata) return null;

  // Find the building entry in metadata
  for (const [chunkId, entries] of Object.entries(state.buildingMetadata.chunks)) {
    for (const entry of entries) {
      if (entry.osm_id === osmId) {
        const meshList = state.buildingMeshes.get(chunkId);
        if (!meshList || meshList.length === 0) continue;

        const chunkMesh = meshList[0];
        const geometry = chunkMesh.geometry as THREE.BufferGeometry;
        const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
        const index = geometry.index;

        const { start_face: startFace, end_face: endFace } = entry;

        // Collect all vertices for this building to compute bounding box
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        if (index) {
          // Indexed geometry
          const visitedVertices = new Set<number>();
          for (let f = startFace; f < endFace; f++) {
            for (let v = 0; v < 3; v++) {
              const vertexIndex = index.getX(f * 3 + v);
              if (visitedVertices.has(vertexIndex)) continue;
              visitedVertices.add(vertexIndex);

              const x = positions.getX(vertexIndex);
              const y = positions.getY(vertexIndex);
              const z = positions.getZ(vertexIndex);

              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
              minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
            }
          }
        } else {
          // Non-indexed geometry
          const startVertex = startFace * 3;
          const endVertex = endFace * 3;
          for (let i = startVertex; i < endVertex; i++) {
            const x = positions.getX(i);
            const y = positions.getY(i);
            const z = positions.getZ(i);

            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
        }

        if (minX === Infinity) return null;

        return {
          center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
          baseZ: minZ,
        };
      }
    }
  }

  return null;
}

/**
 * Hide the original building faces in chunk meshes for a given OSM ID.
 */
function hideOriginalBuildingFacesForOsmId(state: ViewerState, osmId: number): void {
  if (!state.buildingMetadata) return;

  // Find the building in metadata
  for (const [chunkId, entries] of Object.entries(state.buildingMetadata.chunks)) {
    for (const entry of entries) {
      if (entry.osm_id === osmId) {
        const meshList = state.buildingMeshes.get(chunkId);
        if (!meshList || meshList.length === 0) continue;

        const chunkMesh = meshList[0];
        const geometry = chunkMesh.geometry as THREE.BufferGeometry;
        const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
        const index = geometry.index;

        const { start_face: startFace, end_face: endFace } = entry;

        // Store the hiding info
        state.hiddenBuildingFaces.set(osmId, { chunkId, startFace, endFace });

        if (index) {
          // Indexed geometry
          const verticesToHide = new Set<number>();
          for (let f = startFace; f < endFace; f++) {
            for (let v = 0; v < 3; v++) {
              verticesToHide.add(index.getX(f * 3 + v));
            }
          }
          for (const vertexIndex of verticesToHide) {
            positions.setZ(vertexIndex, -10000);
          }
        } else {
          // Non-indexed geometry
          const startVertex = startFace * 3;
          const endVertex = endFace * 3;
          for (let i = startVertex; i < endVertex; i++) {
            positions.setZ(i, -10000);
          }
        }

        positions.needsUpdate = true;
        return;
      }
    }
  }
}

/**
 * Load and apply a custom mesh for a building after upload.
 * This function downloads the mesh from the API and adds it to the scene.
 */
export async function loadAndApplyCustomMesh(osmId: number): Promise<boolean> {
  const state = cachedViewerState;
  if (!state) {
    console.error("loadAndApplyCustomMesh: No cached viewer state");
    return false;
  }

  try {
    // Download the GLB data
    const glbData = await downloadMeshGLB(osmId);
    if (!glbData) {
      console.warn(`Failed to download mesh for building ${osmId}`);
      return false;
    }

    // Parse the GLB
    const loader = new GLTFLoader();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.parse(
        glbData,
        "",
        (result) => resolve(result),
        (error) => reject(error)
      );
    });

    // Find the first mesh
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshes.push(child);
      }
    });

    if (meshes.length === 0) {
      console.warn(`No mesh found in GLB for building ${osmId}`);
      return false;
    }

    const customMesh = meshes[0];

    // Log material info
    const loadedMat = customMesh.material as THREE.MeshStandardMaterial;
    console.log(`Custom mesh ${osmId} loaded with material:`, {
      type: loadedMat?.type,
      color: loadedMat?.color?.getHexString?.() || 'N/A',
      roughness: loadedMat?.roughness,
      metalness: loadedMat?.metalness,
    });

    // Get original building position
    const worldPosition = getOriginalBuildingPositionFromMetadata(state, osmId);
    if (worldPosition) {
      // Transform mesh from centered/origin to world coordinates
      const geometry = customMesh.geometry as THREE.BufferGeometry;
      const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < positions.count; i++) {
        positions.setX(i, positions.getX(i) + worldPosition.center.x);
        positions.setY(i, positions.getY(i) + worldPosition.center.y);
        positions.setZ(i, positions.getZ(i) + worldPosition.baseZ);
      }
      positions.needsUpdate = true;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometry.computeVertexNormals();
    }

    // Set up the mesh
    customMesh.name = `custom_building_${osmId}`;
    customMesh.userData.osmId = osmId;
    customMesh.userData.isCustomMesh = true;
    customMesh.castShadow = true;
    customMesh.receiveShadow = true;

    // Remove existing custom mesh if present
    const existingMesh = state.customMeshes.get(osmId);
    if (existingMesh) {
      state.scene.remove(existingMesh);
      existingMesh.geometry.dispose();
      if (Array.isArray(existingMesh.material)) {
        existingMesh.material.forEach(m => m.dispose());
      } else if (existingMesh.material) {
        (existingMesh.material as THREE.Material).dispose();
      }
    }

    // Add to scene and track
    state.scene.add(customMesh);
    state.customMeshes.set(osmId, customMesh);

    // Hide original building faces
    hideOriginalBuildingFacesForOsmId(state, osmId);

    console.log(`Applied custom mesh for building ${osmId}`);
    return true;
  } catch (error) {
    console.error(`Error loading custom mesh for building ${osmId}:`, error);
    return false;
  }
}
