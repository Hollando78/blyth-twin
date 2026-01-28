/**
 * Mesh Editor Module
 *
 * In-browser 3D mesh editor for modifying building geometry.
 * Integrates with the Building Preview window.
 *
 * Usage:
 *   import { openMeshEditor, closeMeshEditor } from './mesh-editor';
 *   openMeshEditor(scene, camera, geometry, osmId, container);
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  initializeEditor,
  closeEditor as closeEditorState,
  getEditorState,
  setWorkingMesh,
} from "./editor-state.ts";

import {
  initSelectTool,
  disposeSelectTool,
  onPointerMove as selectPointerMove,
  onClick as selectClick,
  updateSelectionVisualization,
} from "./tools/select-tool.ts";

import {
  initTransformTool,
  disposeTransformTool,
  isTransformDragging,
} from "./tools/transform-tool.ts";

import { initEditorUI, disposeEditorUI, confirmClose } from "./editor-ui.ts";
import { initMaterialPanel, disposeMaterialPanel, setEditingMaterial } from "./materials/material-panel.ts";

// Re-export types and functions for external use
export type { MeshEditorState, EditorTool, SelectionMode } from "./editor-state.ts";
export { getEditorState } from "./editor-state.ts";

interface EditorContext {
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: OrbitControls | null;
  container: HTMLElement;
  workingMesh: THREE.Mesh | null;
  wireframeMesh: THREE.Mesh | null;
}

let editorContext: EditorContext | null = null;

/**
 * Open the mesh editor for a given geometry.
 */
export function openMeshEditor(
  scene: THREE.Scene,
  camera: THREE.Camera,
  controls: OrbitControls | null,
  geometry: THREE.BufferGeometry,
  osmId: number,
  container: HTMLElement
): void {
  // Close any existing editor
  if (getEditorState().isOpen) {
    if (!confirmClose()) return;
    closeMeshEditor();
  }

  // Initialize editor state
  initializeEditor(geometry, osmId);

  const state = getEditorState();
  if (!state.workingGeometry) {
    console.error("Failed to initialize editor geometry");
    return;
  }

  // Create working mesh
  const material = new THREE.MeshStandardMaterial({
    color: 0x8b7355,
    roughness: 0.8,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });

  const workingMesh = new THREE.Mesh(state.workingGeometry, material);
  scene.add(workingMesh);
  setWorkingMesh(workingMesh);

  // Create wireframe overlay
  const wireframeMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    wireframe: true,
    transparent: true,
    opacity: 0.1,
  });
  const wireframeMesh = new THREE.Mesh(state.workingGeometry, wireframeMaterial);
  scene.add(wireframeMesh);

  // Store context
  editorContext = {
    scene,
    camera,
    controls,
    container,
    workingMesh,
    wireframeMesh,
  };

  // Initialize tools
  initSelectTool(scene);
  const transformControls = initTransformTool(scene, camera, container);

  // Disable orbit controls when using transform
  if (controls && transformControls) {
    transformControls.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
    });
  }

  // Initialize UI
  initEditorUI(container);
  initMaterialPanel(container);
  setEditingMaterial(material);

  // Set up event listeners
  container.addEventListener("pointermove", handlePointerMove);
  container.addEventListener("click", handleClick);

  console.log(`Mesh editor opened for building ${osmId}`);
}

/**
 * Close the mesh editor.
 */
export function closeMeshEditor(): void {
  if (!editorContext) return;

  const { scene, container, workingMesh, wireframeMesh } = editorContext;

  // Remove event listeners
  container.removeEventListener("pointermove", handlePointerMove);
  container.removeEventListener("click", handleClick);

  // Dispose tools
  disposeSelectTool(scene);
  disposeTransformTool(scene);

  // Dispose UI
  disposeEditorUI();
  disposeMaterialPanel();

  // Remove meshes
  if (workingMesh) {
    scene.remove(workingMesh);
    workingMesh.geometry.dispose();
    (workingMesh.material as THREE.Material).dispose();
  }

  if (wireframeMesh) {
    scene.remove(wireframeMesh);
    (wireframeMesh.material as THREE.Material).dispose();
  }

  // Close editor state
  closeEditorState();

  editorContext = null;

  console.log("Mesh editor closed");
}

/**
 * Check if the mesh editor is open.
 */
export function isEditorOpen(): boolean {
  return getEditorState().isOpen;
}

/**
 * Get the current OSM ID being edited.
 */
export function getEditingOsmId(): number | null {
  return getEditorState().osmId;
}

/**
 * Handle pointer move events.
 */
function handlePointerMove(event: PointerEvent): void {
  if (!editorContext) return;

  const state = getEditorState();
  if (!state.isOpen || state.activeTool !== "select") return;

  // Don't handle if transform is dragging
  if (isTransformDragging()) return;

  selectPointerMove(event, editorContext.camera, editorContext.container);
}

/**
 * Handle click events.
 */
function handleClick(event: MouseEvent): void {
  if (!editorContext) return;

  const state = getEditorState();
  if (!state.isOpen) return;

  // Don't handle if transform is active and dragging
  if (isTransformDragging()) return;

  // Only handle selection on select tool
  if (state.activeTool === "select") {
    selectClick(event, editorContext.camera, editorContext.container);
  }
}

/**
 * Update the editor (call in animation loop).
 */
export function updateEditor(): void {
  if (!editorContext) return;

  const state = getEditorState();
  if (!state.isOpen) return;

  // Update selection visualization
  updateSelectionVisualization();
}

/**
 * Get the working mesh for external manipulation.
 */
export function getWorkingMesh(): THREE.Mesh | null {
  return editorContext?.workingMesh || null;
}

/**
 * Refresh the working mesh geometry from state.
 */
export function refreshMesh(): void {
  if (!editorContext?.workingMesh) return;

  const state = getEditorState();
  if (!state.workingGeometry) return;

  // The geometry is already updated in place, just mark for update
  state.workingGeometry.attributes.position.needsUpdate = true;
  if (state.workingGeometry.attributes.normal) {
    state.workingGeometry.attributes.normal.needsUpdate = true;
  }

  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();
}
