/**
 * Extrude Tool
 *
 * Extrudes selected faces along their average normal.
 * Features:
 * - Calculates average normal of selected faces
 * - Duplicates vertices at offset positions
 * - Creates side faces connecting old and new vertices
 * - Rebuilds geometry attributes
 */

import * as THREE from "three";

import {
  getEditorState,
  saveSnapshot,
} from "../editor-state.ts";

/**
 * Extrude selected faces by a given distance.
 */
export function extrudeFaces(distance: number): boolean {
  const state = getEditorState();

  if (!state.workingGeometry || state.selectedFaces.size === 0) {
    return false;
  }

  // Save snapshot for undo
  saveSnapshot();

  const positions = state.workingGeometry.getAttribute("position");
  const normals = state.workingGeometry.getAttribute("normal");
  const uvs = state.workingGeometry.getAttribute("uv");

  // Get current arrays
  const posArray = Array.from(positions.array);
  const normArray = normals ? Array.from(normals.array) : [];
  const uvArray = uvs ? Array.from(uvs.array) : [];

  // Calculate average normal of selected faces
  const avgNormal = calculateAverageNormal(state.selectedFaces, positions);

  // Map old vertex indices to new vertex indices
  const vertexMap = new Map<number, number>();

  // Collect all vertices that need to be duplicated (vertices of selected faces)
  const selectedVertices = new Set<number>();
  for (const faceIndex of state.selectedFaces) {
    const startVertex = faceIndex * 3;
    selectedVertices.add(startVertex);
    selectedVertices.add(startVertex + 1);
    selectedVertices.add(startVertex + 2);
  }

  // Create new vertices at offset positions
  const newVertexStartIndex = positions.count;
  let newVertexIndex = newVertexStartIndex;

  for (const oldVertexIndex of selectedVertices) {
    // Original position
    const x = positions.getX(oldVertexIndex);
    const y = positions.getY(oldVertexIndex);
    const z = positions.getZ(oldVertexIndex);

    // New position (offset by normal * distance)
    const newX = x + avgNormal.x * distance;
    const newY = y + avgNormal.y * distance;
    const newZ = z + avgNormal.z * distance;

    // Add new vertex
    posArray.push(newX, newY, newZ);

    // Copy normal
    if (normals) {
      normArray.push(
        normals.getX(oldVertexIndex),
        normals.getY(oldVertexIndex),
        normals.getZ(oldVertexIndex)
      );
    }

    // Copy UV
    if (uvs) {
      uvArray.push(
        uvs.getX(oldVertexIndex),
        uvs.getY(oldVertexIndex)
      );
    }

    vertexMap.set(oldVertexIndex, newVertexIndex);
    newVertexIndex++;
  }

  // Update positions of selected face vertices to new positions
  for (const faceIndex of state.selectedFaces) {
    const startVertex = faceIndex * 3;
    for (let i = 0; i < 3; i++) {
      const oldIndex = startVertex + i;
      const newIndex = vertexMap.get(oldIndex);
      if (newIndex !== undefined) {
        // Move old vertex position to new position
        posArray[oldIndex * 3] = posArray[newIndex * 3];
        posArray[oldIndex * 3 + 1] = posArray[newIndex * 3 + 1];
        posArray[oldIndex * 3 + 2] = posArray[newIndex * 3 + 2];
      }
    }
  }

  // Create side faces connecting old and new vertices
  // We need to find the edges of selected faces that are not shared
  const edgeSet = new Map<string, { v1: number; v2: number; count: number }>();

  for (const faceIndex of state.selectedFaces) {
    const startVertex = faceIndex * 3;
    const v0 = startVertex;
    const v1 = startVertex + 1;
    const v2 = startVertex + 2;

    // Add edges (sorted to handle both directions)
    addEdge(edgeSet, v0, v1);
    addEdge(edgeSet, v1, v2);
    addEdge(edgeSet, v2, v0);
  }

  // Find boundary edges (edges that appear only once)
  const boundaryEdges: Array<{ v1: number; v2: number }> = [];
  for (const [, edge] of edgeSet) {
    if (edge.count === 1) {
      boundaryEdges.push({ v1: edge.v1, v2: edge.v2 });
    }
  }

  // Create side faces for each boundary edge
  for (const edge of boundaryEdges) {
    const oldV1 = edge.v1;
    const oldV2 = edge.v2;
    const newV1 = vertexMap.get(oldV1);
    const newV2 = vertexMap.get(oldV2);

    if (newV1 === undefined || newV2 === undefined) continue;

    // Create two triangles for the side quad
    // We need to get positions from the arrays since we moved some vertices

    // First get the "old" positions (now at the base)
    // These are the original positions before we moved them
    const baseV1Index = newV1; // New vertices are at original positions
    const baseV2Index = newV2;

    // "New" positions are now at the moved positions (at oldV1, oldV2)
    const topV1Index = oldV1;
    const topV2Index = oldV2;

    // We need to add new vertices for the side faces to avoid issues
    // with non-indexed geometry

    // Base left vertex
    const blX = posArray[baseV1Index * 3];
    const blY = posArray[baseV1Index * 3 + 1];
    const blZ = posArray[baseV1Index * 3 + 2];

    // Base right vertex
    const brX = posArray[baseV2Index * 3];
    const brY = posArray[baseV2Index * 3 + 1];
    const brZ = posArray[baseV2Index * 3 + 2];

    // Top left vertex
    const tlX = posArray[topV1Index * 3];
    const tlY = posArray[topV1Index * 3 + 1];
    const tlZ = posArray[topV1Index * 3 + 2];

    // Top right vertex
    const trX = posArray[topV2Index * 3];
    const trY = posArray[topV2Index * 3 + 1];
    const trZ = posArray[topV2Index * 3 + 2];

    // Calculate side face normal
    const edge1 = new THREE.Vector3(brX - blX, brY - blY, brZ - blZ);
    const edge2 = new THREE.Vector3(tlX - blX, tlY - blY, tlZ - blZ);
    const sideNormal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

    // Triangle 1: BL, BR, TR
    posArray.push(blX, blY, blZ);
    posArray.push(brX, brY, brZ);
    posArray.push(trX, trY, trZ);

    if (normals) {
      normArray.push(sideNormal.x, sideNormal.y, sideNormal.z);
      normArray.push(sideNormal.x, sideNormal.y, sideNormal.z);
      normArray.push(sideNormal.x, sideNormal.y, sideNormal.z);
    }

    if (uvs) {
      // Simple UV mapping for side faces
      uvArray.push(0, 0);
      uvArray.push(1, 0);
      uvArray.push(1, 1);
    }

    // Triangle 2: BL, TR, TL
    posArray.push(blX, blY, blZ);
    posArray.push(trX, trY, trZ);
    posArray.push(tlX, tlY, tlZ);

    if (normals) {
      normArray.push(sideNormal.x, sideNormal.y, sideNormal.z);
      normArray.push(sideNormal.x, sideNormal.y, sideNormal.z);
      normArray.push(sideNormal.x, sideNormal.y, sideNormal.z);
    }

    if (uvs) {
      uvArray.push(0, 0);
      uvArray.push(1, 1);
      uvArray.push(0, 1);
    }
  }

  // Update geometry with new arrays
  const newPositions = new THREE.Float32BufferAttribute(posArray, 3);
  state.workingGeometry.setAttribute("position", newPositions);

  if (normals && normArray.length > 0) {
    const newNormals = new THREE.Float32BufferAttribute(normArray, 3);
    state.workingGeometry.setAttribute("normal", newNormals);
  }

  if (uvs && uvArray.length > 0) {
    const newUvs = new THREE.Float32BufferAttribute(uvArray, 2);
    state.workingGeometry.setAttribute("uv", newUvs);
  }

  // Recompute normals for smooth shading
  state.workingGeometry.computeVertexNormals();
  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();

  return true;
}

/**
 * Calculate the average normal of selected faces.
 */
function calculateAverageNormal(
  selectedFaces: Set<number>,
  positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
): THREE.Vector3 {
  const avgNormal = new THREE.Vector3();
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  for (const faceIndex of selectedFaces) {
    const startVertex = faceIndex * 3;

    v0.set(
      positions.getX(startVertex),
      positions.getY(startVertex),
      positions.getZ(startVertex)
    );
    v1.set(
      positions.getX(startVertex + 1),
      positions.getY(startVertex + 1),
      positions.getZ(startVertex + 1)
    );
    v2.set(
      positions.getX(startVertex + 2),
      positions.getY(startVertex + 2),
      positions.getZ(startVertex + 2)
    );

    // Calculate face normal
    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    faceNormal.crossVectors(edge1, edge2).normalize();

    avgNormal.add(faceNormal);
  }

  return avgNormal.normalize();
}

/**
 * Add an edge to the edge set.
 */
function addEdge(
  edgeSet: Map<string, { v1: number; v2: number; count: number }>,
  v1: number,
  v2: number
): void {
  // Create a canonical key for the edge (smaller index first)
  const key = v1 < v2 ? `${v1}_${v2}` : `${v2}_${v1}`;

  if (edgeSet.has(key)) {
    const edge = edgeSet.get(key)!;
    edge.count++;
  } else {
    edgeSet.set(key, { v1: Math.min(v1, v2), v2: Math.max(v1, v2), count: 1 });
  }
}

/**
 * Inset selected faces (scale towards center).
 */
export function insetFaces(amount: number): boolean {
  const state = getEditorState();

  if (!state.workingGeometry || state.selectedFaces.size === 0) {
    return false;
  }

  saveSnapshot();

  const positions = state.workingGeometry.getAttribute("position") as THREE.BufferAttribute;

  for (const faceIndex of state.selectedFaces) {
    const startVertex = faceIndex * 3;

    // Calculate face centroid
    const centroid = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      centroid.x += positions.getX(startVertex + i);
      centroid.y += positions.getY(startVertex + i);
      centroid.z += positions.getZ(startVertex + i);
    }
    centroid.divideScalar(3);

    // Move each vertex towards centroid
    for (let i = 0; i < 3; i++) {
      const vi = startVertex + i;
      const x = positions.getX(vi);
      const y = positions.getY(vi);
      const z = positions.getZ(vi);

      // Interpolate towards centroid
      const newX = x + (centroid.x - x) * amount;
      const newY = y + (centroid.y - y) * amount;
      const newZ = z + (centroid.z - z) * amount;

      positions.setXYZ(vi, newX, newY, newZ);
    }
  }

  positions.needsUpdate = true;
  state.workingGeometry.computeVertexNormals();
  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();

  return true;
}

/**
 * Delete selected faces.
 */
export function deleteFaces(): boolean {
  const state = getEditorState();

  if (!state.workingGeometry || state.selectedFaces.size === 0) {
    return false;
  }

  saveSnapshot();

  const positions = state.workingGeometry.getAttribute("position");
  const normals = state.workingGeometry.getAttribute("normal");
  const uvs = state.workingGeometry.getAttribute("uv");

  const faceCount = positions.count / 3;

  // Collect positions of non-deleted faces
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const newUvs: number[] = [];

  for (let f = 0; f < faceCount; f++) {
    if (!state.selectedFaces.has(f)) {
      const startVertex = f * 3;
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

  return true;
}
