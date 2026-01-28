import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type {
  Manifest,
  FootprintMetadata,
  BuildingMetadata,
  LoadedAsset,
  BuildingProperties,
  CONFIG,
} from "./types.ts";
import type {
  FootprintUniforms,
  BuildingShaderUniforms,
} from "./shaders.ts";
import { createFootprintUniforms, createBuildingShaderUniforms } from "./shaders.ts";

export interface ViewerState {
  // Core Three.js objects (set during init)
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;

  // Data
  manifest: Manifest | null;
  footprintMetadata: FootprintMetadata | null;
  buildingMetadata: BuildingMetadata | null;
  loadedAssets: Map<string, LoadedAsset>;

  // Loaders
  loader: GLTFLoader;
  dracoLoader: DRACOLoader;

  // Sun light reference for water shader
  sunLight: THREE.DirectionalLight | null;

  // Cached materials
  roadMaterial: THREE.Material | null;
  railwayMaterial: THREE.Material | null;
  buildingMaterial: THREE.Material | null;
  waterMaterial: THREE.Material | null;
  seaMaterial: THREE.Material | null;
  terrainMaterial: THREE.Material | null;

  // Water objects for animation
  waterObjects: THREE.Object3D[];

  // Layer visibility state
  layerEnabled: Map<string, boolean>;

  // Clock for animations
  clock: THREE.Clock;

  // LOD management
  lastLodUpdate: number;

  // Footprint meshes for raycasting
  footprintMeshes: Map<string, THREE.Mesh>;
  footprintMaterials: Map<string, THREE.ShaderMaterial>;

  // Building meshes for 3D highlighting
  buildingMeshes: Map<string, THREE.Mesh[]>;

  // Shader uniforms (shared by reference across materials)
  footprintUniforms: FootprintUniforms;
  buildingShaderUniforms: BuildingShaderUniforms;

  // Raycasting
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  selectedBuildingIndex: number;

  // Loading state
  totalAssets: number;
  loadedCount: number;

  // Zone/texture toggle state
  zoneColorsEnabled: boolean;
  buildingTexturesEnabled: boolean;
  buildingOriginalMaterials: Map<string, THREE.Material | THREE.Material[]>;
  buildingZoneMaterials: Map<string, THREE.MeshBasicMaterial>;
  buildingNullMaterial: THREE.MeshBasicMaterial;
}

export function createViewerState(): ViewerState {
  // Set up Draco-enabled GLTF loader
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  dracoLoader.setDecoderConfig({ type: "js" });

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  // Placeholder camera/scene/renderer/controls - replaced during init
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const renderer = null!; // Set in scene-setup before any use
  const controls = null!; // Set in scene-setup before any use

  return {
    camera,
    scene,
    renderer,
    controls,

    manifest: null,
    footprintMetadata: null,
    buildingMetadata: null,
    loadedAssets: new Map(),

    loader,
    dracoLoader,

    sunLight: null,

    roadMaterial: null,
    railwayMaterial: null,
    buildingMaterial: null,
    waterMaterial: null,
    seaMaterial: null,
    terrainMaterial: null,

    waterObjects: [],

    layerEnabled: new Map([
      ["terrain", true],
      ["buildings", true],
      ["roads", true],
      ["railways", true],
      ["water", true],
      ["sea", true],
    ]),

    clock: new THREE.Clock(),
    lastLodUpdate: 0,

    footprintMeshes: new Map(),
    footprintMaterials: new Map(),
    buildingMeshes: new Map(),

    footprintUniforms: createFootprintUniforms(),
    buildingShaderUniforms: createBuildingShaderUniforms(),

    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    selectedBuildingIndex: -1,

    totalAssets: 0,
    loadedCount: 0,

    zoneColorsEnabled: false,
    buildingTexturesEnabled: true,
    buildingOriginalMaterials: new Map(),
    buildingZoneMaterials: new Map(),
    buildingNullMaterial: new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide }),
  };
}

/**
 * Get dominant zone for a chunk based on building count
 */
export function getDominantZoneForChunk(
  state: ViewerState,
  chunkId: string,
  config: typeof CONFIG,
): keyof typeof config.materials.zones {
  if (!state.footprintMetadata) return "other";

  const chunkData = state.footprintMetadata.chunks[chunkId];
  if (!chunkData) return "other";

  const zoneCounts: Record<string, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    civic: 0,
    other: 0,
  };

  for (const entry of chunkData.face_map) {
    const props = state.footprintMetadata.buildings[String(entry.building_id)];
    const zone = getZoneFromBuildingType(props);
    zoneCounts[zone]++;
  }

  let maxCount = 0;
  let dominantZone: keyof typeof config.materials.zones = "other";
  for (const [zone, count] of Object.entries(zoneCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantZone = zone as keyof typeof config.materials.zones;
    }
  }

  return dominantZone;
}

export function getZoneFromBuildingType(props: BuildingProperties | null): string {
  if (!props) return "other";

  const buildingType = props.building?.toLowerCase() || "";
  const amenity = props.amenity?.toLowerCase() || "";
  const shop = props.shop?.toLowerCase() || "";

  // Residential
  if (["residential", "house", "terrace", "semidetached_house", "detached",
       "bungalow", "apartments", "flat", "dormitory"].includes(buildingType)) {
    return "residential";
  }

  // Commercial (shops, retail, hospitality)
  if (["retail", "commercial", "supermarket", "kiosk"].includes(buildingType) ||
      shop || ["pub", "restaurant", "cafe", "fast_food", "bar", "hotel", "bank"].includes(amenity)) {
    return "commercial";
  }

  // Industrial
  if (["industrial", "warehouse", "factory", "manufacture", "storage_tank"].includes(buildingType)) {
    return "industrial";
  }

  // Civic (public services, education, religious)
  if (["school", "university", "college", "church", "chapel", "cathedral",
       "hospital", "civic", "public", "government", "office", "fire_station",
       "police", "library", "community_centre", "sports_centre"].includes(buildingType) ||
      ["school", "hospital", "place_of_worship", "community_centre", "library",
       "police", "fire_station", "townhall", "theatre", "cinema"].includes(amenity)) {
    return "civic";
  }

  return "other";
}
