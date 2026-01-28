/**
 * Transform Tool
 *
 * Move, rotate, and scale selected vertices using TransformControls.
 * Features:
 * - Creates a helper object at selection centroid
 * - Applies transformations to all selected vertices
 * - Recomputes normals after transform
 * - Supports snap-to-grid
 */

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

import {
  getEditorState,
  getSelectionCentroid,
  saveSnapshot,
} from "../editor-state.ts";

let transformControls: TransformControls | null = null;
let transformHelper: THREE.Object3D | null = null;
let isDragging = false;
let initialPositions: Map<number, THREE.Vector3> = new Map();

/**
 * Initialize the transform tool.
 */
export function initTransformTool(
  scene: THREE.Scene,
  camera: THREE.Camera,
  domElement: HTMLElement
): TransformControls {
  // Create helper object for positioning transform controls
  transformHelper = new THREE.Object3D();
  scene.add(transformHelper);

  // Create transform controls
  transformControls = new TransformControls(camera, domElement);
  transformControls.attach(transformHelper);
  transformControls.setSize(0.8);
  scene.add(transformControls);

  // Set up event listeners
  transformControls.addEventListener("dragging-changed", (event) => {
    isDragging = (event as { value: boolean }).value;

    if (event.value) {
      // Starting drag - save initial positions
      saveInitialPositions();
    } else {
      // Finished drag - save undo snapshot
      saveSnapshot();
    }
  });

  transformControls.addEventListener("objectChange", () => {
    applyTransform();
  });

  // Initially hidden
  transformControls.visible = false;
  transformControls.enabled = false;

  return transformControls;
}

/**
 * Dispose of the transform tool.
 */
export function disposeTransformTool(scene: THREE.Scene): void {
  if (transformControls) {
    scene.remove(transformControls);
    transformControls.dispose();
    transformControls = null;
  }

  if (transformHelper) {
    scene.remove(transformHelper);
    transformHelper = null;
  }

  initialPositions.clear();
}

/**
 * Set the transform mode (translate, rotate, scale).
 */
export function setTransformMode(mode: "translate" | "rotate" | "scale"): void {
  if (!transformControls) return;
  transformControls.setMode(mode);
}

/**
 * Update the transform controls position based on selection.
 */
export function updateTransformPosition(): void {
  const state = getEditorState();

  if (!transformControls || !transformHelper) return;

  if (state.selectedVertices.size === 0) {
    transformControls.visible = false;
    transformControls.enabled = false;
    return;
  }

  // Get selection centroid
  const centroid = getSelectionCentroid();
  if (!centroid) {
    transformControls.visible = false;
    transformControls.enabled = false;
    return;
  }

  // Position helper at centroid
  transformHelper.position.copy(centroid);
  transformHelper.rotation.set(0, 0, 0);
  transformHelper.scale.set(1, 1, 1);

  // Show and enable controls
  transformControls.visible = true;
  transformControls.enabled = true;
}

/**
 * Save initial positions of selected vertices before transform.
 */
function saveInitialPositions(): void {
  const state = getEditorState();
  if (!state.workingGeometry) return;

  initialPositions.clear();
  const positions = state.workingGeometry.getAttribute("position");

  for (const vertexIndex of state.selectedVertices) {
    initialPositions.set(
      vertexIndex,
      new THREE.Vector3(
        positions.getX(vertexIndex),
        positions.getY(vertexIndex),
        positions.getZ(vertexIndex)
      )
    );
  }
}

/**
 * Apply the current transform to selected vertices.
 */
function applyTransform(): void {
  const state = getEditorState();

  if (
    !state.workingGeometry ||
    !transformHelper ||
    !transformControls ||
    initialPositions.size === 0
  ) {
    return;
  }

  const positions = state.workingGeometry.getAttribute("position") as THREE.BufferAttribute;

  // Get transform from helper
  const mode = transformControls.mode;

  if (mode === "translate") {
    // Calculate delta from original centroid
    const centroid = new THREE.Vector3();
    let count = 0;
    for (const [, pos] of initialPositions) {
      centroid.add(pos);
      count++;
    }
    centroid.divideScalar(count);

    const delta = new THREE.Vector3()
      .copy(transformHelper.position)
      .sub(centroid);

    // Apply snap if enabled
    if (state.snapEnabled) {
      delta.x = Math.round(delta.x / state.snapGridSize) * state.snapGridSize;
      delta.y = Math.round(delta.y / state.snapGridSize) * state.snapGridSize;
      delta.z = Math.round(delta.z / state.snapGridSize) * state.snapGridSize;
    }

    // Apply translation to all selected vertices
    for (const [vertexIndex, initialPos] of initialPositions) {
      positions.setXYZ(
        vertexIndex,
        initialPos.x + delta.x,
        initialPos.y + delta.y,
        initialPos.z + delta.z
      );
    }
  } else if (mode === "rotate") {
    // Get centroid of initial positions
    const centroid = new THREE.Vector3();
    let count = 0;
    for (const [, pos] of initialPositions) {
      centroid.add(pos);
      count++;
    }
    centroid.divideScalar(count);

    // Create rotation matrix
    const rotationMatrix = new THREE.Matrix4();
    rotationMatrix.makeRotationFromEuler(transformHelper.rotation);

    // Apply rotation around centroid
    for (const [vertexIndex, initialPos] of initialPositions) {
      const relativePos = new THREE.Vector3()
        .copy(initialPos)
        .sub(centroid);
      relativePos.applyMatrix4(rotationMatrix);
      relativePos.add(centroid);

      positions.setXYZ(vertexIndex, relativePos.x, relativePos.y, relativePos.z);
    }
  } else if (mode === "scale") {
    // Get centroid of initial positions
    const centroid = new THREE.Vector3();
    let count = 0;
    for (const [, pos] of initialPositions) {
      centroid.add(pos);
      count++;
    }
    centroid.divideScalar(count);

    // Apply scale from centroid
    const scale = transformHelper.scale;

    for (const [vertexIndex, initialPos] of initialPositions) {
      const relativePos = new THREE.Vector3()
        .copy(initialPos)
        .sub(centroid);

      relativePos.x *= scale.x;
      relativePos.y *= scale.y;
      relativePos.z *= scale.z;

      relativePos.add(centroid);

      positions.setXYZ(vertexIndex, relativePos.x, relativePos.y, relativePos.z);
    }
  }

  positions.needsUpdate = true;

  // Recompute normals
  state.workingGeometry.computeVertexNormals();

  // Update bounding box
  state.workingGeometry.computeBoundingBox();
  state.workingGeometry.computeBoundingSphere();
}

/**
 * Enable/disable the transform controls.
 */
export function setTransformEnabled(enabled: boolean): void {
  if (!transformControls) return;

  if (enabled) {
    updateTransformPosition();
  } else {
    transformControls.visible = false;
    transformControls.enabled = false;
  }
}

/**
 * Check if currently dragging.
 */
export function isTransformDragging(): boolean {
  return isDragging;
}

/**
 * Get the transform controls instance.
 */
export function getTransformControls(): TransformControls | null {
  return transformControls;
}

/**
 * Set transform controls space (world or local).
 */
export function setTransformSpace(space: "world" | "local"): void {
  if (!transformControls) return;
  transformControls.setSpace(space);
}

/**
 * Toggle snap mode for transform controls.
 */
export function setTransformSnap(snap: boolean, gridSize: number = 0.5): void {
  if (!transformControls) return;

  if (snap) {
    transformControls.setTranslationSnap(gridSize);
    transformControls.setRotationSnap(THREE.MathUtils.degToRad(15)); // 15 degree snap
    transformControls.setScaleSnap(0.1);
  } else {
    transformControls.setTranslationSnap(null);
    transformControls.setRotationSnap(null);
    transformControls.setScaleSnap(null);
  }
}
