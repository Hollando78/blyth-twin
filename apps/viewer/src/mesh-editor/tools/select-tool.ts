/**
 * Select Tool
 *
 * Raycaster-based selection for vertices and faces.
 * Features:
 * - Vertex selection via screen-space proximity
 * - Face selection via standard raycasting
 * - Shift+click for additive selection
 * - Visual feedback for selected elements
 */

import * as THREE from "three";

import {
  getEditorState,
  selectVertex,
  selectFace,
  selectVertices,
  clearSelection,
  setSelectionHelpers,
} from "../editor-state.ts";

// Selection threshold in pixels for vertex selection
const VERTEX_SELECT_THRESHOLD = 15;

// Colors
const SELECTED_VERTEX_COLOR = 0x00ff00;
const SELECTED_FACE_COLOR = 0x00ff00;
const SELECTION_POINT_SIZE = 8;

let raycaster: THREE.Raycaster;
let selectionPoints: THREE.Points | null = null;
let faceHighlightMesh: THREE.Mesh | null = null;
let hoveredVertexIndex: number = -1;
let hoveredFaceIndex: number = -1;

/**
 * Initialize the select tool.
 */
export function initSelectTool(scene: THREE.Scene): void {
  raycaster = new THREE.Raycaster();

  // Create selection visualization for vertices
  const pointsGeometry = new THREE.BufferGeometry();
  const pointsMaterial = new THREE.PointsMaterial({
    color: SELECTED_VERTEX_COLOR,
    size: SELECTION_POINT_SIZE,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
  });
  selectionPoints = new THREE.Points(pointsGeometry, pointsMaterial);
  selectionPoints.renderOrder = 999;
  scene.add(selectionPoints);

  // Create face highlight mesh
  const faceGeometry = new THREE.BufferGeometry();
  const faceMaterial = new THREE.MeshBasicMaterial({
    color: SELECTED_FACE_COLOR,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  faceHighlightMesh = new THREE.Mesh(faceGeometry, faceMaterial);
  faceHighlightMesh.renderOrder = 998;
  scene.add(faceHighlightMesh);

  setSelectionHelpers(selectionPoints, faceHighlightMesh);
}

/**
 * Clean up the select tool.
 */
export function disposeSelectTool(scene: THREE.Scene): void {
  if (selectionPoints) {
    scene.remove(selectionPoints);
    selectionPoints.geometry.dispose();
    (selectionPoints.material as THREE.Material).dispose();
    selectionPoints = null;
  }

  if (faceHighlightMesh) {
    scene.remove(faceHighlightMesh);
    faceHighlightMesh.geometry.dispose();
    (faceHighlightMesh.material as THREE.Material).dispose();
    faceHighlightMesh = null;
  }
}

/**
 * Update selection visualization.
 */
export function updateSelectionVisualization(): void {
  const state = getEditorState();

  if (!state.workingGeometry || !selectionPoints || !faceHighlightMesh) return;

  const positions = state.workingGeometry.getAttribute("position");
  if (!positions) return;

  // Update vertex selection points
  if (state.selectionMode === "vertex" || state.selectedVertices.size > 0) {
    const selectedPositions: number[] = [];

    for (const vertexIndex of state.selectedVertices) {
      selectedPositions.push(
        positions.getX(vertexIndex),
        positions.getY(vertexIndex),
        positions.getZ(vertexIndex)
      );
    }

    const newGeometry = new THREE.BufferGeometry();
    if (selectedPositions.length > 0) {
      newGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(selectedPositions, 3)
      );
    }

    selectionPoints.geometry.dispose();
    selectionPoints.geometry = newGeometry;
  }

  // Update face highlight
  if (state.selectionMode === "face" && state.selectedFaces.size > 0) {
    const facePositions: number[] = [];

    for (const faceIndex of state.selectedFaces) {
      const startVertex = faceIndex * 3;
      for (let i = 0; i < 3; i++) {
        const vi = startVertex + i;
        facePositions.push(
          positions.getX(vi),
          positions.getY(vi),
          positions.getZ(vi)
        );
      }
    }

    const newGeometry = new THREE.BufferGeometry();
    if (facePositions.length > 0) {
      newGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(facePositions, 3)
      );
    }

    faceHighlightMesh.geometry.dispose();
    faceHighlightMesh.geometry = newGeometry;
    faceHighlightMesh.visible = true;
  } else {
    faceHighlightMesh.visible = false;
  }
}

/**
 * Handle pointer move for hover effects.
 */
export function onPointerMove(
  event: PointerEvent,
  camera: THREE.Camera,
  container: HTMLElement
): void {
  const state = getEditorState();
  if (!state.workingGeometry || !state.workingMesh) return;

  const rect = container.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  if (state.selectionMode === "vertex") {
    // Find nearest vertex in screen space
    hoveredVertexIndex = findNearestVertex(mouse, camera, container);
  } else if (state.selectionMode === "face") {
    // Raycast for face selection
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(state.workingMesh);

    if (intersects.length > 0 && intersects[0].faceIndex !== undefined) {
      hoveredFaceIndex = intersects[0].faceIndex;
    } else {
      hoveredFaceIndex = -1;
    }
  }
}

/**
 * Handle click for selection.
 */
export function onClick(
  event: MouseEvent,
  camera: THREE.Camera,
  container: HTMLElement
): void {
  const state = getEditorState();
  if (!state.workingGeometry || !state.workingMesh) return;

  const additive = event.shiftKey;

  const rect = container.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  if (state.selectionMode === "vertex") {
    const vertexIndex = findNearestVertex(mouse, camera, container);
    if (vertexIndex >= 0) {
      selectVertex(vertexIndex, additive);
    } else if (!additive) {
      clearSelection();
    }
  } else if (state.selectionMode === "face") {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(state.workingMesh);

    if (intersects.length > 0 && intersects[0].faceIndex !== undefined) {
      selectFace(intersects[0].faceIndex, additive);
    } else if (!additive) {
      clearSelection();
    }
  } else if (state.selectionMode === "object") {
    // Select all vertices
    const positions = state.workingGeometry.getAttribute("position");
    const allVertices: number[] = [];
    for (let i = 0; i < positions.count; i++) {
      allVertices.push(i);
    }
    selectVertices(allVertices, false);
  }

  updateSelectionVisualization();
}

/**
 * Find the nearest vertex to the mouse position in screen space.
 */
function findNearestVertex(
  mouse: THREE.Vector2,
  camera: THREE.Camera,
  container: HTMLElement
): number {
  const state = getEditorState();
  if (!state.workingGeometry || !state.workingMesh) return -1;

  const positions = state.workingGeometry.getAttribute("position");
  if (!positions) return -1;

  const rect = container.getBoundingClientRect();
  const screenPosition = new THREE.Vector3();
  let nearestIndex = -1;
  let nearestDistance = VERTEX_SELECT_THRESHOLD;

  // Get world matrix from mesh
  const worldMatrix = state.workingMesh.matrixWorld;

  for (let i = 0; i < positions.count; i++) {
    // Get vertex position in world space
    screenPosition.set(
      positions.getX(i),
      positions.getY(i),
      positions.getZ(i)
    );
    screenPosition.applyMatrix4(worldMatrix);

    // Project to screen space
    screenPosition.project(camera);

    // Convert to pixel coordinates
    const screenX = ((screenPosition.x + 1) / 2) * rect.width;
    const screenY = ((-screenPosition.y + 1) / 2) * rect.height;

    // Mouse position in pixels
    const mouseX = ((mouse.x + 1) / 2) * rect.width;
    const mouseY = ((-mouse.y + 1) / 2) * rect.height;

    // Calculate distance
    const distance = Math.sqrt(
      Math.pow(screenX - mouseX, 2) + Math.pow(screenY - mouseY, 2)
    );

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }

  return nearestIndex;
}

/**
 * Handle box selection (drag to select multiple).
 */
export function boxSelect(
  startPoint: THREE.Vector2,
  endPoint: THREE.Vector2,
  camera: THREE.Camera,
  _container: HTMLElement,
  additive: boolean
): void {
  const state = getEditorState();
  if (!state.workingGeometry || !state.workingMesh) return;

  const positions = state.workingGeometry.getAttribute("position");
  if (!positions) return;

  const worldMatrix = state.workingMesh.matrixWorld;

  // Normalize selection box
  const minX = Math.min(startPoint.x, endPoint.x);
  const maxX = Math.max(startPoint.x, endPoint.x);
  const minY = Math.min(startPoint.y, endPoint.y);
  const maxY = Math.max(startPoint.y, endPoint.y);

  const selectedIndices: number[] = [];
  const screenPosition = new THREE.Vector3();

  for (let i = 0; i < positions.count; i++) {
    screenPosition.set(
      positions.getX(i),
      positions.getY(i),
      positions.getZ(i)
    );
    screenPosition.applyMatrix4(worldMatrix);
    screenPosition.project(camera);

    // Check if vertex is within selection box
    if (
      screenPosition.x >= minX &&
      screenPosition.x <= maxX &&
      screenPosition.y >= minY &&
      screenPosition.y <= maxY
    ) {
      selectedIndices.push(i);
    }
  }

  if (selectedIndices.length > 0) {
    selectVertices(selectedIndices, additive);
    updateSelectionVisualization();
  }
}

/**
 * Get the hovered vertex index.
 */
export function getHoveredVertexIndex(): number {
  return hoveredVertexIndex;
}

/**
 * Get the hovered face index.
 */
export function getHoveredFaceIndex(): number {
  return hoveredFaceIndex;
}
