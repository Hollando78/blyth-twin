/**
 * GLB Exporter
 *
 * Exports edited meshes to GLB format and uploads to API.
 * Features:
 * - Uses Three.js GLTFExporter
 * - Includes geometry, materials, and textures
 * - Uploads to the mesh API endpoint
 */

import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

import { getEditorState, markClean } from "../editor-state.ts";
import { uploadMesh } from "../../api-client.ts";

/**
 * Export options for GLB.
 */
export interface ExportOptions {
  binary: boolean;
  embedImages: boolean;
  onlyVisible: boolean;
  includeCustomExtensions: boolean;
}

const defaultExportOptions: ExportOptions = {
  binary: true,
  embedImages: true,
  onlyVisible: true,
  includeCustomExtensions: false,
};

/**
 * Export the current mesh to GLB ArrayBuffer.
 */
export function exportToGLB(
  mesh: THREE.Mesh,
  options: Partial<ExportOptions> = {}
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    const exportOptions = { ...defaultExportOptions, ...options };

    exporter.parse(
      mesh,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          // If JSON result (shouldn't happen with binary: true)
          const json = JSON.stringify(result);
          const blob = new Blob([json], { type: "application/json" });
          blob.arrayBuffer().then(resolve).catch(reject);
        }
      },
      (error) => {
        reject(error);
      },
      {
        binary: exportOptions.binary,
        onlyVisible: exportOptions.onlyVisible,
      }
    );
  });
}

/**
 * Export the current editor mesh to GLB and return as Blob.
 */
export async function exportEditorMeshToBlob(): Promise<Blob | null> {
  const state = getEditorState();

  if (!state.workingGeometry) {
    console.error("No geometry to export");
    return null;
  }

  // Create a mesh with the current geometry and material
  const material = state.workingMesh?.material as THREE.Material | undefined;
  const exportMaterial =
    material ||
    new THREE.MeshStandardMaterial({
      color: 0x8b7355,
      roughness: 0.8,
      metalness: 0.1,
    });

  const exportMesh = new THREE.Mesh(state.workingGeometry.clone(), exportMaterial);

  try {
    const arrayBuffer = await exportToGLB(exportMesh);
    return new Blob([arrayBuffer], { type: "model/gltf-binary" });
  } catch (error) {
    console.error("Export failed:", error);
    return null;
  } finally {
    exportMesh.geometry.dispose();
  }
}

/**
 * Download the current mesh as a GLB file.
 */
export async function downloadAsGLB(filename?: string): Promise<boolean> {
  const state = getEditorState();

  const blob = await exportEditorMeshToBlob();
  if (!blob) return false;

  // Create download link
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || `building_${state.osmId || "unknown"}.glb`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return true;
}

/**
 * Save the current mesh to the API.
 */
export async function saveToAPI(): Promise<{ success: boolean; message: string }> {
  const state = getEditorState();

  if (!state.osmId) {
    return { success: false, message: "No building ID set" };
  }

  const blob = await exportEditorMeshToBlob();
  if (!blob) {
    return { success: false, message: "Failed to export mesh" };
  }

  try {
    // Create a File from the Blob
    const file = new File([blob], `building_${state.osmId}.glb`, {
      type: "model/gltf-binary",
    });

    // Upload to API
    const result = await uploadMesh(state.osmId, file, "mesh_editor");

    // Mark as clean (no unsaved changes)
    markClean();

    return {
      success: true,
      message: result.message || "Mesh saved successfully",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return { success: false, message };
  }
}

/**
 * Export mesh with custom metadata.
 */
export async function exportWithMetadata(
  mesh: THREE.Mesh,
  metadata: Record<string, unknown>
): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();

  return new Promise((resolve, reject) => {
    exporter.parse(
      mesh,
      (result) => {
        if (result instanceof ArrayBuffer) {
          // For binary, we'd need to modify the GLB to add extras
          // For now, just return the GLB as-is
          resolve(result);
        } else {
          // JSON result - add metadata to extras
          const gltf = result as { extras?: Record<string, unknown> };
          gltf.extras = { ...gltf.extras, ...metadata };

          const json = JSON.stringify(gltf);
          const blob = new Blob([json], { type: "application/json" });
          blob.arrayBuffer().then(resolve).catch(reject);
        }
      },
      (error) => {
        reject(error);
      },
      { binary: true }
    );
  });
}

/**
 * Get export statistics.
 */
export function getExportStats(mesh: THREE.Mesh): {
  vertexCount: number;
  faceCount: number;
  materialCount: number;
  hasTextures: boolean;
  estimatedSizeKB: number;
} {
  const geometry = mesh.geometry;
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];

  const positions = geometry.getAttribute("position");
  const vertexCount = positions ? positions.count : 0;
  const faceCount = geometry.index
    ? geometry.index.count / 3
    : vertexCount / 3;

  const hasTextures = materials.some((mat) => {
    const stdMat = mat as THREE.MeshStandardMaterial;
    return stdMat.map || stdMat.normalMap || stdMat.roughnessMap;
  });

  // Rough estimate: ~20 bytes per vertex (position + normal + UV)
  // Plus indices, materials, etc.
  const estimatedSizeKB = Math.round(
    (vertexCount * 20 + faceCount * 12) / 1024
  );

  return {
    vertexCount,
    faceCount,
    materialCount: materials.length,
    hasTextures,
    estimatedSizeKB,
  };
}

/**
 * Validate geometry before export.
 */
export function validateForExport(geometry: THREE.BufferGeometry): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check for position attribute
  const positions = geometry.getAttribute("position");
  if (!positions) {
    issues.push("Missing position attribute");
  } else if (positions.count === 0) {
    issues.push("No vertices");
  } else if (positions.count % 3 !== 0) {
    issues.push("Vertex count not divisible by 3 (invalid triangles)");
  }

  // Check for NaN values
  if (positions) {
    for (let i = 0; i < positions.count; i++) {
      if (
        isNaN(positions.getX(i)) ||
        isNaN(positions.getY(i)) ||
        isNaN(positions.getZ(i))
      ) {
        issues.push("Contains NaN vertex positions");
        break;
      }
    }
  }

  // Check for degenerate triangles
  if (positions && positions.count >= 3) {
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    let degenerateCount = 0;

    for (let i = 0; i < positions.count; i += 3) {
      v0.set(positions.getX(i), positions.getY(i), positions.getZ(i));
      v1.set(
        positions.getX(i + 1),
        positions.getY(i + 1),
        positions.getZ(i + 1)
      );
      v2.set(
        positions.getX(i + 2),
        positions.getY(i + 2),
        positions.getZ(i + 2)
      );

      const edge1 = new THREE.Vector3().subVectors(v1, v0);
      const edge2 = new THREE.Vector3().subVectors(v2, v0);
      const area = new THREE.Vector3().crossVectors(edge1, edge2).length() / 2;

      if (area < 0.0001) {
        degenerateCount++;
      }
    }

    if (degenerateCount > 0) {
      issues.push(`Contains ${degenerateCount} degenerate triangles`);
    }
  }

  // Check bounding box
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  if (bbox) {
    const size = new THREE.Vector3();
    bbox.getSize(size);

    if (size.x === 0 || size.y === 0 || size.z === 0) {
      issues.push("Geometry is flat (zero dimension)");
    }

    if (size.length() > 10000) {
      issues.push("Geometry may be too large (> 10km)");
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
