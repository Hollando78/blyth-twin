/**
 * Mesh Editor State Management
 *
 * Manages the state of the in-browser mesh editor including:
 * - Tool selection
 * - Selection mode (vertex/face/object)
 * - Selected vertices/faces
 * - Undo/redo history
 * - Dirty state tracking
 */

import * as THREE from "three";

export type EditorTool = "select" | "move" | "rotate" | "scale" | "extrude";
export type SelectionMode = "vertex" | "face" | "object";

export interface GeometrySnapshot {
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  indices: Uint32Array | null;
  timestamp: number;
}

export interface MeshEditorState {
  isOpen: boolean;
  activeTool: EditorTool;
  selectionMode: SelectionMode;
  selectedVertices: Set<number>;
  selectedFaces: Set<number>;
  undoStack: GeometrySnapshot[];
  redoStack: GeometrySnapshot[];
  isDirty: boolean;
  workingGeometry: THREE.BufferGeometry | null;
  originalGeometry: THREE.BufferGeometry | null;
  workingMesh: THREE.Mesh | null;
  selectionHelper: THREE.Points | null;
  faceHighlight: THREE.Mesh | null;
  osmId: number | null;
  snapEnabled: boolean;
  snapGridSize: number;
}

// Maximum undo stack size
const MAX_UNDO_STACK = 50;

// Global editor state
let editorState: MeshEditorState = {
  isOpen: false,
  activeTool: "select",
  selectionMode: "vertex",
  selectedVertices: new Set(),
  selectedFaces: new Set(),
  undoStack: [],
  redoStack: [],
  isDirty: false,
  workingGeometry: null,
  originalGeometry: null,
  workingMesh: null,
  selectionHelper: null,
  faceHighlight: null,
  osmId: null,
  snapEnabled: false,
  snapGridSize: 0.5,
};

// State change listeners
const listeners: Set<(state: MeshEditorState) => void> = new Set();

/**
 * Get the current editor state.
 */
export function getEditorState(): MeshEditorState {
  return editorState;
}

/**
 * Subscribe to editor state changes.
 */
export function subscribeToEditorState(
  callback: (state: MeshEditorState) => void
): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Update the editor state and notify listeners.
 */
function updateState(updates: Partial<MeshEditorState>): void {
  editorState = { ...editorState, ...updates };
  listeners.forEach((cb) => cb(editorState));
}

/**
 * Initialize the editor with a geometry to edit.
 */
export function initializeEditor(
  geometry: THREE.BufferGeometry,
  osmId: number
): void {
  // Clone the geometry for editing
  const workingGeometry = geometry.clone();

  // Ensure geometry is non-indexed for easier vertex manipulation
  if (workingGeometry.index) {
    const nonIndexed = workingGeometry.toNonIndexed();
    workingGeometry.dispose();
    updateState({
      workingGeometry: nonIndexed,
      originalGeometry: geometry.clone(),
      osmId,
      isOpen: true,
      isDirty: false,
      selectedVertices: new Set(),
      selectedFaces: new Set(),
      undoStack: [],
      redoStack: [],
      activeTool: "select",
      selectionMode: "vertex",
    });
  } else {
    updateState({
      workingGeometry,
      originalGeometry: geometry.clone(),
      osmId,
      isOpen: true,
      isDirty: false,
      selectedVertices: new Set(),
      selectedFaces: new Set(),
      undoStack: [],
      redoStack: [],
      activeTool: "select",
      selectionMode: "vertex",
    });
  }

  // Save initial state for undo
  saveSnapshot();
}

/**
 * Close the editor and clean up.
 */
export function closeEditor(): void {
  if (editorState.workingGeometry) {
    editorState.workingGeometry.dispose();
  }
  if (editorState.originalGeometry) {
    editorState.originalGeometry.dispose();
  }
  if (editorState.selectionHelper) {
    editorState.selectionHelper.geometry.dispose();
    (editorState.selectionHelper.material as THREE.Material).dispose();
  }
  if (editorState.faceHighlight) {
    editorState.faceHighlight.geometry.dispose();
    (editorState.faceHighlight.material as THREE.Material).dispose();
  }

  updateState({
    isOpen: false,
    workingGeometry: null,
    originalGeometry: null,
    workingMesh: null,
    selectionHelper: null,
    faceHighlight: null,
    osmId: null,
    selectedVertices: new Set(),
    selectedFaces: new Set(),
    undoStack: [],
    redoStack: [],
    isDirty: false,
  });
}

/**
 * Set the active tool.
 */
export function setActiveTool(tool: EditorTool): void {
  updateState({ activeTool: tool });
}

/**
 * Set the selection mode.
 */
export function setSelectionMode(mode: SelectionMode): void {
  // Clear selection when changing modes
  updateState({
    selectionMode: mode,
    selectedVertices: new Set(),
    selectedFaces: new Set(),
  });
}

/**
 * Select a vertex.
 */
export function selectVertex(index: number, additive: boolean = false): void {
  const newSelection = additive
    ? new Set(editorState.selectedVertices)
    : new Set<number>();

  if (newSelection.has(index)) {
    newSelection.delete(index);
  } else {
    newSelection.add(index);
  }

  updateState({ selectedVertices: newSelection });
}

/**
 * Select multiple vertices.
 */
export function selectVertices(indices: number[], additive: boolean = false): void {
  const newSelection = additive
    ? new Set(editorState.selectedVertices)
    : new Set<number>();

  for (const index of indices) {
    newSelection.add(index);
  }

  updateState({ selectedVertices: newSelection });
}

/**
 * Select a face.
 */
export function selectFace(faceIndex: number, additive: boolean = false): void {
  const newSelection = additive
    ? new Set(editorState.selectedFaces)
    : new Set<number>();

  if (newSelection.has(faceIndex)) {
    newSelection.delete(faceIndex);
  } else {
    newSelection.add(faceIndex);
  }

  // Also select vertices of the face
  const vertexSelection = additive
    ? new Set(editorState.selectedVertices)
    : new Set<number>();

  if (newSelection.has(faceIndex)) {
    // Add vertices for this face
    const startVertex = faceIndex * 3;
    vertexSelection.add(startVertex);
    vertexSelection.add(startVertex + 1);
    vertexSelection.add(startVertex + 2);
  }

  updateState({
    selectedFaces: newSelection,
    selectedVertices: vertexSelection,
  });
}

/**
 * Clear all selection.
 */
export function clearSelection(): void {
  updateState({
    selectedVertices: new Set(),
    selectedFaces: new Set(),
  });
}

/**
 * Select all vertices/faces.
 */
export function selectAll(): void {
  if (!editorState.workingGeometry) return;

  const positions = editorState.workingGeometry.getAttribute("position");
  if (!positions) return;

  if (editorState.selectionMode === "vertex") {
    const allVertices = new Set<number>();
    for (let i = 0; i < positions.count; i++) {
      allVertices.add(i);
    }
    updateState({ selectedVertices: allVertices });
  } else if (editorState.selectionMode === "face") {
    const faceCount = positions.count / 3;
    const allFaces = new Set<number>();
    const allVertices = new Set<number>();
    for (let i = 0; i < faceCount; i++) {
      allFaces.add(i);
      allVertices.add(i * 3);
      allVertices.add(i * 3 + 1);
      allVertices.add(i * 3 + 2);
    }
    updateState({ selectedFaces: allFaces, selectedVertices: allVertices });
  }
}

/**
 * Save a snapshot of the current geometry for undo.
 */
export function saveSnapshot(): void {
  if (!editorState.workingGeometry) return;

  const positions = editorState.workingGeometry.getAttribute("position");
  const normals = editorState.workingGeometry.getAttribute("normal");
  const uvs = editorState.workingGeometry.getAttribute("uv");
  const index = editorState.workingGeometry.index;

  const snapshot: GeometrySnapshot = {
    positions: new Float32Array(positions.array),
    normals: normals ? new Float32Array(normals.array) : null,
    uvs: uvs ? new Float32Array(uvs.array) : null,
    indices: index ? new Uint32Array(index.array) : null,
    timestamp: Date.now(),
  };

  const newUndoStack = [...editorState.undoStack, snapshot];

  // Limit stack size
  if (newUndoStack.length > MAX_UNDO_STACK) {
    newUndoStack.shift();
  }

  updateState({
    undoStack: newUndoStack,
    redoStack: [], // Clear redo on new action
    isDirty: true,
  });
}

/**
 * Undo the last action.
 */
export function undo(): boolean {
  if (editorState.undoStack.length <= 1) return false; // Keep at least initial state

  const currentSnapshot = editorState.undoStack[editorState.undoStack.length - 1];
  const previousSnapshot = editorState.undoStack[editorState.undoStack.length - 2];

  if (!previousSnapshot || !editorState.workingGeometry) return false;

  // Save current state to redo stack
  const newRedoStack = [...editorState.redoStack, currentSnapshot];

  // Apply previous state
  applySnapshot(previousSnapshot);

  // Update stacks
  const newUndoStack = editorState.undoStack.slice(0, -1);

  updateState({
    undoStack: newUndoStack,
    redoStack: newRedoStack,
  });

  return true;
}

/**
 * Redo the last undone action.
 */
export function redo(): boolean {
  if (editorState.redoStack.length === 0) return false;

  const snapshot = editorState.redoStack[editorState.redoStack.length - 1];
  if (!snapshot || !editorState.workingGeometry) return false;

  // Save current state to undo stack
  saveSnapshot();

  // Apply redo state
  applySnapshot(snapshot);

  // Update redo stack
  const newRedoStack = editorState.redoStack.slice(0, -1);

  updateState({
    redoStack: newRedoStack,
  });

  return true;
}

/**
 * Apply a geometry snapshot.
 */
function applySnapshot(snapshot: GeometrySnapshot): void {
  if (!editorState.workingGeometry) return;

  const positions = editorState.workingGeometry.getAttribute("position") as THREE.BufferAttribute;
  positions.array.set(snapshot.positions);
  positions.needsUpdate = true;

  if (snapshot.normals) {
    const normals = editorState.workingGeometry.getAttribute("normal") as THREE.BufferAttribute;
    if (normals) {
      normals.array.set(snapshot.normals);
      normals.needsUpdate = true;
    }
  }

  if (snapshot.uvs) {
    const uvs = editorState.workingGeometry.getAttribute("uv") as THREE.BufferAttribute;
    if (uvs) {
      uvs.array.set(snapshot.uvs);
      uvs.needsUpdate = true;
    }
  }

  editorState.workingGeometry.computeBoundingBox();
  editorState.workingGeometry.computeBoundingSphere();
}

/**
 * Set the working mesh reference.
 */
export function setWorkingMesh(mesh: THREE.Mesh): void {
  updateState({ workingMesh: mesh });
}

/**
 * Set selection helper objects.
 */
export function setSelectionHelpers(
  points: THREE.Points | null,
  faceHighlight: THREE.Mesh | null
): void {
  updateState({
    selectionHelper: points,
    faceHighlight: faceHighlight,
  });
}

/**
 * Toggle snap to grid.
 */
export function toggleSnap(): void {
  updateState({ snapEnabled: !editorState.snapEnabled });
}

/**
 * Set snap grid size.
 */
export function setSnapGridSize(size: number): void {
  updateState({ snapGridSize: size });
}

/**
 * Mark the geometry as clean (after saving).
 */
export function markClean(): void {
  updateState({ isDirty: false });
}

/**
 * Check if there are unsaved changes.
 */
export function hasUnsavedChanges(): boolean {
  return editorState.isDirty;
}

/**
 * Get the selection centroid for transform operations.
 */
export function getSelectionCentroid(): THREE.Vector3 | null {
  if (!editorState.workingGeometry || editorState.selectedVertices.size === 0) {
    return null;
  }

  const positions = editorState.workingGeometry.getAttribute("position");
  const centroid = new THREE.Vector3();
  let count = 0;

  for (const vertexIndex of editorState.selectedVertices) {
    centroid.x += positions.getX(vertexIndex);
    centroid.y += positions.getY(vertexIndex);
    centroid.z += positions.getZ(vertexIndex);
    count++;
  }

  if (count > 0) {
    centroid.divideScalar(count);
  }

  return centroid;
}
