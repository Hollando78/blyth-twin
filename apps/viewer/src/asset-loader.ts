import * as THREE from "three";

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

// Texture generators
import { getSharedRoadMaterial, preloadRoadTextures } from "./textures/roads";
import { createRailwayMaterial, preloadRailwayTextures } from "./textures/railways";
import { createSimpleWaterMaterial, createSimpleSeaMaterial } from "./textures/water";
import { createBuildingMaterial } from "./textures/buildings";
import { createTerrainMaterial } from "./textures/terrain";

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

  try {
    state.terrainMaterial = await createTerrainMaterial();
    console.log("  Terrain satellite imagery ready");
  } catch (error) {
    console.warn("  Failed to load terrain imagery, will use fallback:", error);
  }

  console.log("Textures initialized");
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

  const BATCH_SIZE = 8;
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
