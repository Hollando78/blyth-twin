/**
 * API client for the Blyth Digital Twin backend.
 *
 * Provides typed methods for interacting with the building data API.
 */

// Extend ImportMeta for Vite environment variables
declare global {
  interface ImportMetaEnv {
    VITE_API_URL?: string;
    VITE_API_KEY?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

// API configuration
const API_BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000/api";
const API_KEY = import.meta.env.VITE_API_KEY || "dev-api-key";

export interface BuildingProperties {
  osm_id: number;
  height?: number;
  height_source?: string;
  name?: string;
  building_type?: string;
  amenity?: string;
  shop?: string;
  office?: string;
  addr_housenumber?: string;
  addr_housename?: string;
  addr_street?: string;
  addr_postcode?: string;
  addr_city?: string;
  addr_suburb?: string;
}

export interface BuildingGeometry {
  type: string;
  coordinates: number[][][];
}

export interface BuildingResponse {
  osm_id: number;
  geometry?: BuildingGeometry;
  properties: BuildingProperties;
  has_override: boolean;
  has_custom_mesh: boolean;
  updated_at?: string;
}

export interface BuildingUpdate {
  height?: number;
  height_source?: string;
  name?: string;
  building_type?: string;
  addr_housenumber?: string;
  addr_street?: string;
  addr_postcode?: string;
  addr_city?: string;
  edit_note?: string;
}

export interface BuildingOverrideResponse {
  osm_id: number;
  override_id: number;
  message: string;
  updated_fields: string[];
  created_at: string;
  updated_at: string;
}

export interface MeshMetadata {
  osm_id: number;
  vertex_count?: number;
  face_count?: number;
  mesh_source?: string;
  created_at?: string;
}

export interface ApiError {
  detail: string;
}

/**
 * Make an authenticated API request.
 */
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error: ApiError = await response.json().catch(() => ({
      detail: `HTTP ${response.status}: ${response.statusText}`,
    }));
    throw new Error(error.detail);
  }

  return response.json();
}

/**
 * Get a building by OSM ID.
 */
export async function getBuilding(osmId: number): Promise<BuildingResponse> {
  return apiRequest<BuildingResponse>(`/buildings/${osmId}`);
}

/**
 * Update a building (creates or updates an override).
 */
export async function updateBuilding(
  osmId: number,
  update: BuildingUpdate
): Promise<BuildingOverrideResponse> {
  return apiRequest<BuildingOverrideResponse>(`/buildings/${osmId}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

/**
 * Delete a building override, reverting to OSM data.
 */
export async function deleteOverride(osmId: number): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/buildings/${osmId}/override`, {
    method: "DELETE",
  });
}

/**
 * Get mesh metadata for a building.
 * Returns null if no custom mesh exists (404).
 */
export async function getMeshMetadata(osmId: number): Promise<MeshMetadata | null> {
  const url = `${API_BASE_URL}/buildings/${osmId}/mesh`;

  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
  });

  if (response.status === 404) {
    return null; // No custom mesh - this is expected
  }

  if (!response.ok) {
    const error: ApiError = await response.json().catch(() => ({
      detail: `HTTP ${response.status}: ${response.statusText}`,
    }));
    throw new Error(error.detail);
  }

  return response.json();
}

/**
 * Upload a custom mesh for a building.
 */
export async function uploadMesh(
  osmId: number,
  file: File,
  meshSource: string = "user_upload"
): Promise<{ osm_id: number; mesh_id: number; message: string }> {
  const url = `${API_BASE_URL}/buildings/${osmId}/mesh?mesh_source=${encodeURIComponent(meshSource)}`;

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-API-Key": API_KEY,
    },
    body: formData,
  });

  if (!response.ok) {
    const error: ApiError = await response.json().catch(() => ({
      detail: `HTTP ${response.status}: ${response.statusText}`,
    }));
    throw new Error(error.detail);
  }

  return response.json();
}

/**
 * Delete a custom mesh for a building.
 */
export async function deleteMesh(osmId: number): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/buildings/${osmId}/mesh`, {
    method: "DELETE",
  });
}

/**
 * Trigger an export of the building data.
 */
export async function triggerExport(): Promise<{ message: string; status_url: string }> {
  return apiRequest<{ message: string; status_url: string }>("/export", {
    method: "POST",
  });
}

/**
 * Get the current export status.
 */
export async function getExportStatus(): Promise<{
  status: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
}> {
  return apiRequest("/export/status");
}

/**
 * Check if the API is available.
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL.replace("/api", "")}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * List buildings that have custom meshes.
 */
export async function listBuildingsWithCustomMeshes(): Promise<number[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/meshes`, {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
    });

    if (!response.ok) {
      console.warn("Failed to fetch custom meshes list");
      return [];
    }

    const data = await response.json();
    return data.osm_ids || [];
  } catch (error) {
    console.warn("Error fetching custom meshes list:", error);
    return [];
  }
}

/**
 * Download a custom mesh GLB as ArrayBuffer.
 */
export async function downloadMeshGLB(osmId: number): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/buildings/${osmId}/mesh/download`, {
      headers: {
        "X-API-Key": API_KEY,
      },
    });

    if (!response.ok) {
      console.warn(`Failed to download mesh for building ${osmId}`);
      return null;
    }

    return response.arrayBuffer();
  } catch (error) {
    console.warn(`Error downloading mesh for building ${osmId}:`, error);
    return null;
  }
}
