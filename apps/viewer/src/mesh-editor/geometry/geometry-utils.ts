/**
 * Geometry Utilities
 *
 * Helper functions for BufferGeometry manipulation.
 * Features:
 * - Weld vertices (merge nearby vertices)
 * - Flip normals
 * - Recalculate normals
 * - Get geometry statistics
 */

import * as THREE from "three";

import { getEditorState, saveSnapshot } from "../editor-state.ts";

/**
 * Get geometry statistics.
 */
export function getGeometryStats(): {
  vertexCount: number;
  faceCount: number;
  boundingBox: THREE.Box3 | null;
  dimensions: THREE.Vector3 | null;
} {
  const state = getEditorState();

  if (!state.workingGeometry) {
    return {
      vertexCount: 0,
      faceCount: 0,
      boundingBox: null,
      dimensions: null,
    };
  }

  const positions = state.workingGeometry.getAttribute("position");

  state.workingGeometry.computeBoundingBox();
  const bbox = state.workingGeometry.boundingBox;
  const dimensions = bbox ? new THREE.Vector3() : null;
  if (bbox && dimensions) {
    bbox.getSize(dimensions);
  }

  return {
    vertexCount: positions.count,
    faceCount: positions.count / 3,
    boundingBox: bbox,
    dimensions,
  };
}

/**
 * Flip normals of selected faces (or all if none selected).
 */
export function flipNormals(): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  saveSnapshot();

  const positions = state.workingGeometry.getAttribute("position") as THREE.BufferAttribute;
  const normals = state.workingGeometry.getAttribute("normal") as THREE.BufferAttribute | null;

  const faceCount = positions.count / 3;
  const facesToFlip =
    state.selectedFaces.size > 0
      ? state.selectedFaces
      : new Set(Array.from({ length: faceCount }, (_, i) => i));

  for (const faceIndex of facesToFlip) {
    const startVertex = faceIndex * 3;

    // Swap vertices 1 and 2 to flip winding order
    const v1x = positions.getX(startVertex + 1);
    const v1y = positions.getY(startVertex + 1);
    const v1z = positions.getZ(startVertex + 1);

    const v2x = positions.getX(startVertex + 2);
    const v2y = positions.getY(startVertex + 2);
    const v2z = positions.getZ(startVertex + 2);

    positions.setXYZ(startVertex + 1, v2x, v2y, v2z);
    positions.setXYZ(startVertex + 2, v1x, v1y, v1z);

    // Flip normals
    if (normals) {
      for (let i = 0; i < 3; i++) {
        const vi = startVertex + i;
        normals.setXYZ(
          vi,
          -normals.getX(vi),
          -normals.getY(vi),
          -normals.getZ(vi)
        );
      }
    }
  }

  positions.needsUpdate = true;
  if (normals) normals.needsUpdate = true;

  return true;
}

/**
 * Recalculate all normals.
 */
export function recalculateNormals(): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  saveSnapshot();

  state.workingGeometry.computeVertexNormals();

  return true;
}

/**
 * Weld vertices that are within a given distance.
 */
export function weldVertices(threshold: number = 0.001): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  saveSnapshot();

  const positions = state.workingGeometry.getAttribute("position");
  const normals = state.workingGeometry.getAttribute("normal");
  const uvs = state.workingGeometry.getAttribute("uv");

  // Build a map of unique positions
  const positionMap = new Map<string, number>();
  const vertexMap = new Map<number, number>(); // old index -> new index

  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const newUvs: number[] = [];

  function positionKey(x: number, y: number, z: number): string {
    // Round to threshold to merge nearby vertices
    const rx = Math.round(x / threshold) * threshold;
    const ry = Math.round(y / threshold) * threshold;
    const rz = Math.round(z / threshold) * threshold;
    return `${rx.toFixed(6)}_${ry.toFixed(6)}_${rz.toFixed(6)}`;
  }

  // First pass: identify unique vertices
  let uniqueIndex = 0;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    const key = positionKey(x, y, z);

    if (positionMap.has(key)) {
      vertexMap.set(i, positionMap.get(key)!);
    } else {
      positionMap.set(key, uniqueIndex);
      vertexMap.set(i, uniqueIndex);

      newPositions.push(x, y, z);

      if (normals) {
        newNormals.push(
          normals.getX(i),
          normals.getY(i),
          normals.getZ(i)
        );
      }

      if (uvs) {
        newUvs.push(uvs.getX(i), uvs.getY(i));
      }

      uniqueIndex++;
    }
  }

  // Create new indexed geometry
  const indices: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    indices.push(vertexMap.get(i)!);
  }

  // Update geometry
  state.workingGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(newPositions, 3)
  );

  if (normals && newNormals.length > 0) {
    state.workingGeometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(newNormals, 3)
    );
  }

  if (uvs && newUvs.length > 0) {
    state.workingGeometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(newUvs, 2)
    );
  }

  state.workingGeometry.setIndex(indices);

  console.log(
    `Welded vertices: ${positions.count} -> ${uniqueIndex} (removed ${positions.count - uniqueIndex})`
  );

  return true;
}

/**
 * Center the geometry at the origin.
 */
export function centerGeometry(): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  saveSnapshot();

  state.workingGeometry.computeBoundingBox();
  const bbox = state.workingGeometry.boundingBox;
  if (!bbox) return false;

  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const positions = state.workingGeometry.getAttribute("position") as THREE.BufferAttribute;

  for (let i = 0; i < positions.count; i++) {
    positions.setXYZ(
      i,
      positions.getX(i) - center.x,
      positions.getY(i) - center.y,
      positions.getZ(i) - center.z
    );
  }

  positions.needsUpdate = true;
  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();

  return true;
}

/**
 * Move the geometry so its base is at Z=0.
 */
export function placeOnGround(): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  saveSnapshot();

  state.workingGeometry.computeBoundingBox();
  const bbox = state.workingGeometry.boundingBox;
  if (!bbox) return false;

  const positions = state.workingGeometry.getAttribute("position") as THREE.BufferAttribute;
  const minZ = bbox.min.z;

  for (let i = 0; i < positions.count; i++) {
    positions.setZ(i, positions.getZ(i) - minZ);
  }

  positions.needsUpdate = true;
  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();

  return true;
}

/**
 * Scale the geometry uniformly.
 */
export function scaleGeometry(factor: number): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  saveSnapshot();

  const positions = state.workingGeometry.getAttribute("position") as THREE.BufferAttribute;

  // Get current center
  state.workingGeometry.computeBoundingBox();
  const center = new THREE.Vector3();
  state.workingGeometry.boundingBox?.getCenter(center);

  // Scale around center
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);

    positions.setXYZ(
      i,
      center.x + (x - center.x) * factor,
      center.y + (y - center.y) * factor,
      center.z + (z - center.z) * factor
    );
  }

  positions.needsUpdate = true;
  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();

  return true;
}

/**
 * Triangulate any non-triangular faces (for compatibility).
 */
export function ensureTriangulated(): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  // BufferGeometry should already be triangulated
  // This is a no-op for now but could handle quad conversion if needed
  return true;
}

/**
 * Remove degenerate triangles (zero area).
 */
export function removeDegenerate(areaThreshold: number = 0.0001): boolean {
  const state = getEditorState();

  if (!state.workingGeometry) return false;

  saveSnapshot();

  const positions = state.workingGeometry.getAttribute("position");
  const normals = state.workingGeometry.getAttribute("normal");
  const uvs = state.workingGeometry.getAttribute("uv");

  const faceCount = positions.count / 3;

  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const newUvs: number[] = [];

  let removedCount = 0;

  for (let f = 0; f < faceCount; f++) {
    const startVertex = f * 3;

    // Get vertices
    const v0 = new THREE.Vector3(
      positions.getX(startVertex),
      positions.getY(startVertex),
      positions.getZ(startVertex)
    );
    const v1 = new THREE.Vector3(
      positions.getX(startVertex + 1),
      positions.getY(startVertex + 1),
      positions.getZ(startVertex + 1)
    );
    const v2 = new THREE.Vector3(
      positions.getX(startVertex + 2),
      positions.getY(startVertex + 2),
      positions.getZ(startVertex + 2)
    );

    // Calculate area using cross product
    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    const cross = new THREE.Vector3().crossVectors(edge1, edge2);
    const area = cross.length() / 2;

    if (area >= areaThreshold) {
      // Keep this face
      for (let i = 0; i < 3; i++) {
        const vi = startVertex + i;
        newPositions.push(
          positions.getX(vi),
          positions.getY(vi),
          positions.getZ(vi)
        );

        if (normals) {
          newNormals.push(
            normals.getX(vi),
            normals.getY(vi),
            normals.getZ(vi)
          );
        }

        if (uvs) {
          newUvs.push(uvs.getX(vi), uvs.getY(vi));
        }
      }
    } else {
      removedCount++;
    }
  }

  // Update geometry
  state.workingGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(newPositions, 3)
  );

  if (normals && newNormals.length > 0) {
    state.workingGeometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(newNormals, 3)
    );
  }

  if (uvs && newUvs.length > 0) {
    state.workingGeometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(newUvs, 2)
    );
  }

  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();

  console.log(`Removed ${removedCount} degenerate triangles`);

  return removedCount > 0;
}
