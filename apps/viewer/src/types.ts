import * as THREE from "three";

export interface Manifest {
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
    buffer_m?: number;
  };
  assets: Asset[];
}

export interface Asset {
  id: string;
  type: "terrain" | "buildings" | "roads" | "railways" | "water" | "sea" | "footprints" | "texture";
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

export interface LoadedAsset {
  asset: Asset;
  mesh: THREE.Object3D;
  loaded: boolean;
}

export interface FaceMapEntry {
  building_id: number;
  start_face: number;
  end_face: number;
}

export interface ChunkMetadata {
  face_map: FaceMapEntry[];
}

export interface BuildingProperties {
  name?: string;
  building?: string;
  amenity?: string;
  shop?: string;
  addr_housename?: string;
  addr_housenumber?: string;
  addr_street?: string;
  addr_postcode?: string;
  addr_city?: string;
  height?: number;
  height_source?: string;
  osm_id?: number;
}

export interface FootprintMetadata {
  chunks: Record<string, ChunkMetadata>;
  buildings: Record<string, BuildingProperties>;
}

export interface BuildingFaceMapEntry {
  osm_id: number;
  building_index: number;
  global_id: number;
  start_face: number;
  end_face: number;
}

export interface BuildingMetadata {
  chunks: Record<string, BuildingFaceMapEntry[]>;
}

/**
 * Get twin ID from URL query parameter.
 * Returns null for the default/static Blyth twin.
 */
function getTwinId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("twin");
}

/**
 * Get base path for twin assets.
 * For default twin, returns empty string.
 * For dynamic twins, returns "/twins/{uuid}".
 */
function getTwinBasePath(): string {
  const twinId = getTwinId();
  return twinId ? `/twins/${twinId}` : "";
}

// Compute paths based on twin ID
const basePath = getTwinBasePath();
const twinId = getTwinId();

// Debug logging
console.log("[CONFIG] Twin ID:", twinId);
console.log("[CONFIG] Base path:", basePath);

export const CONFIG = {
  twinId: getTwinId(),
  manifestUrl: `${basePath}/manifest.json`,
  footprintMetadataUrl: `${basePath}/footprints_metadata.json`,
  buildingMetadataUrl: `${basePath}/buildings_metadata.json`,
  facadeAtlasUrl: `${basePath}/assets/textures/facade_atlas.png`,
  facadeNormalUrl: `${basePath}/assets/textures/facade_normal_atlas.png`,
  facadeMetaUrl: `${basePath}/assets/textures/facade_atlas_meta.json`,
  assetsBasePath: `${basePath}/`,
  camera: {
    fov: 45,
    near: 1,
    far: 15000,
    initialPosition: new THREE.Vector3(0, 0, 4000),
  },
  fog: {
    color: 0x87ceeb,
    near: 3000,
    far: 8000,
  },
  controls: {
    minDistance: 100,
    maxDistance: 10000,
    maxPolarAngle: Math.PI / 2.1,
  },
  materials: {
    terrain: {
      color: 0x4a7c4e,
      flatShading: true,
    },
    buildings: {
      color: 0x8b7355,
      flatShading: true,
      useTexture: true,
    },
    roads: {
      color: 0x3a3a3a,
      useTexture: true,
    },
    railways: {
      color: 0x8b4513,
      useTexture: true,
    },
    water: {
      color: 0x4da6ff,
      opacity: 0.85,
      useShader: true,
    },
    sea: {
      color: 0x1a5c8c,
      opacity: 0.9,
      useShader: true,
    },
    footprints: {
      hoverColor: 0x00ff00,
      hoverOpacity: 0.3,
      selectedColor: 0xffff00,
      selectedOpacity: 0.6,
    },
    zones: {
      residential: 0x4CAF50,
      commercial: 0x2196F3,
      industrial: 0xFF9800,
      civic: 0x9C27B0,
      other: 0x795548,
      opacity: 0.6,
    },
  },
  lod: {
    enabled: true,
    buildingCullDistance: 4000,
    detailDistance: 1500,
    updateInterval: 100,
  },
};
