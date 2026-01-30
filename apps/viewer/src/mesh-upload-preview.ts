/**
 * Mesh Upload Preview
 *
 * Provides a preview window for GLB files before uploading, with
 * rotation and scale controls to adjust the model.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { uploadMesh } from "./api-client.ts";
import { getEditState } from "./edit-mode.ts";
import { loadAndApplyCustomMesh } from "./asset-loader.ts";

interface UploadPreviewState {
  container: HTMLElement | null;
  canvas: HTMLCanvasElement | null;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  controls: OrbitControls | null;
  modelMesh: THREE.Object3D | null;
  originalGeometry: THREE.BufferGeometry | null;
  animationId: number | null;
  isOpen: boolean;
  pendingFile: File | null;
  // Transform values
  rotation: { x: number; y: number; z: number };
  scale: number;
  // Callbacks
  onComplete: ((success: boolean) => void) | null;
}

const state: UploadPreviewState = {
  container: null,
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  modelMesh: null,
  originalGeometry: null,
  animationId: null,
  isOpen: false,
  pendingFile: null,
  rotation: { x: 0, y: 0, z: 0 },
  scale: 1,
  onComplete: null,
};

/**
 * Create the upload preview window DOM.
 */
function createPreviewWindow(): HTMLElement {
  const container = document.createElement("div");
  container.id = "upload-preview-window";
  container.className = "upload-preview-window hidden";
  container.innerHTML = `
    <div class="upload-preview-header">
      <span class="upload-preview-title">Preview Upload</span>
      <button id="upload-preview-close" class="upload-preview-close" title="Cancel">&times;</button>
    </div>
    <div class="upload-preview-content">
      <canvas id="upload-preview-canvas"></canvas>
    </div>
    <div class="upload-preview-controls">
      <div class="transform-section">
        <h5>Rotation (degrees)</h5>
        <div class="transform-row">
          <label>X</label>
          <input type="range" id="rot-x" min="-180" max="180" value="0" step="1" />
          <input type="number" id="rot-x-val" value="0" min="-180" max="180" step="1" />
        </div>
        <div class="transform-row">
          <label>Y</label>
          <input type="range" id="rot-y" min="-180" max="180" value="0" step="1" />
          <input type="number" id="rot-y-val" value="0" min="-180" max="180" step="1" />
        </div>
        <div class="transform-row">
          <label>Z</label>
          <input type="range" id="rot-z" min="-180" max="180" value="0" step="1" />
          <input type="number" id="rot-z-val" value="0" min="-180" max="180" step="1" />
        </div>
      </div>
      <div class="transform-section">
        <h5>Scale</h5>
        <div class="transform-row">
          <label>Size</label>
          <input type="range" id="scale" min="0.1" max="5" value="1" step="0.1" />
          <input type="number" id="scale-val" value="1" min="0.1" max="10" step="0.1" />
        </div>
      </div>
      <div class="transform-actions">
        <button id="upload-preview-reset" class="btn-secondary">Reset</button>
        <button id="upload-preview-upload" class="btn-primary">Upload</button>
      </div>
    </div>
    <div id="upload-preview-loading" class="upload-preview-loading hidden">
      <div class="spinner-small"></div>
      <span>Uploading...</span>
    </div>
    <div id="upload-preview-error" class="upload-preview-error hidden"></div>
  `;
  return container;
}

/**
 * Initialize the Three.js scene.
 */
function initScene(): void {
  if (!state.canvas) return;

  state.renderer = new THREE.WebGLRenderer({
    canvas: state.canvas,
    antialias: true,
    alpha: true,
  });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.setClearColor(0x1a1a2e, 1);

  state.scene = new THREE.Scene();

  state.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  state.camera.position.set(5, 5, 5);
  state.camera.up.set(0, 0, 1); // Z-up

  state.controls = new OrbitControls(state.camera, state.canvas);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.1;

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  state.scene.add(ambient);

  const directional = new THREE.DirectionalLight(0xffffff, 0.8);
  directional.position.set(50, 100, 50);
  state.scene.add(directional);

  const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
  backLight.position.set(-50, 50, -50);
  state.scene.add(backLight);

  // Grid
  const grid = new THREE.GridHelper(10, 10, 0x444444, 0x333333);
  grid.rotation.x = Math.PI / 2;
  state.scene.add(grid);

  resizeCanvas();
}

/**
 * Resize the canvas.
 */
function resizeCanvas(): void {
  if (!state.container || !state.renderer || !state.camera) return;

  const content = state.container.querySelector(".upload-preview-content") as HTMLElement;
  if (!content) return;

  const width = content.clientWidth;
  const height = content.clientHeight;

  if (width <= 0 || height <= 0) {
    requestAnimationFrame(resizeCanvas);
    return;
  }

  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(width, height);
}

/**
 * Animation loop.
 */
function animate(): void {
  if (!state.isOpen) return;

  state.animationId = requestAnimationFrame(animate);

  if (state.controls) {
    state.controls.update();
  }

  if (state.renderer && state.scene && state.camera) {
    state.renderer.render(state.scene, state.camera);
  }
}

/**
 * Load a GLB file into the preview.
 */
async function loadModel(file: File): Promise<void> {
  if (!state.scene) return;

  // Clear existing model
  clearModel();

  const loader = new GLTFLoader();
  const arrayBuffer = await file.arrayBuffer();

  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      "",
      (gltf) => {
        const model = gltf.scene;

        // Find mesh and extract geometry
        let foundMesh: THREE.Mesh | null = null;
        model.traverse((child) => {
          if (child instanceof THREE.Mesh && !foundMesh) {
            foundMesh = child;
          }
        });

        if (!foundMesh) {
          reject(new Error("No mesh found in GLB file"));
          return;
        }

        // TypeScript needs explicit type after null check in closure
        const sourceMesh = foundMesh as THREE.Mesh;

        // Clone geometry for manipulation
        const geometry = (sourceMesh.geometry as THREE.BufferGeometry).clone();
        state.originalGeometry = geometry.clone();

        // Convert coordinate system if needed (Y-up to Z-up)
        // Many 3D tools export with Y-up, our scene uses Z-up
        // We'll apply a -90 degree X rotation by default
        const needsRotation = detectCoordinateSystem(geometry);
        if (needsRotation) {
          state.rotation.x = -90;
          updateRotationInputs();
        }

        // Center and normalize the model
        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox!;
        const center = new THREE.Vector3();
        bbox.getCenter(center);

        // Center geometry
        const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < positions.count; i++) {
          positions.setX(i, positions.getX(i) - center.x);
          positions.setY(i, positions.getY(i) - center.y);
          positions.setZ(i, positions.getZ(i) - bbox.min.z); // Base at Z=0
        }
        positions.needsUpdate = true;
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.computeVertexNormals();

        // Create material
        let material: THREE.Material;
        if (sourceMesh.material instanceof THREE.Material) {
          material = sourceMesh.material.clone();
          (material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
        } else {
          material = new THREE.MeshStandardMaterial({
            color: 0x8b7355,
            roughness: 0.8,
            metalness: 0.1,
            side: THREE.DoubleSide,
          });
        }

        // Create preview mesh
        const previewMesh = new THREE.Mesh(geometry, material);
        previewMesh.frustumCulled = false;

        // Add wireframe
        const wireframeMat = new THREE.MeshBasicMaterial({
          color: 0x000000,
          wireframe: true,
          transparent: true,
          opacity: 0.15,
        });
        const wireframe = new THREE.Mesh(geometry, wireframeMat);
        wireframe.frustumCulled = false;

        const group = new THREE.Group();
        group.add(previewMesh);
        group.add(wireframe);

        state.modelMesh = group;
        state.scene!.add(group);

        // Apply initial rotation if needed
        if (needsRotation) {
          applyTransforms();
        }

        // Fit camera
        fitCamera();

        resolve();
      },
      (error) => {
        reject(error);
      }
    );
  });
}

/**
 * Detect if the model needs coordinate system conversion.
 * If the bounding box is much taller in Y than Z, it's likely Y-up.
 */
function detectCoordinateSystem(geometry: THREE.BufferGeometry): boolean {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  // If Y extent is larger than Z extent by a significant margin,
  // the model is probably Y-up and needs rotation
  return size.y > size.z * 1.5;
}

/**
 * Clear the current model.
 */
function clearModel(): void {
  if (state.modelMesh && state.scene) {
    state.scene.remove(state.modelMesh);
    state.modelMesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    });
    state.modelMesh = null;
  }
  state.originalGeometry = null;
}

/**
 * Fit camera to the model.
 */
function fitCamera(): void {
  if (!state.modelMesh || !state.camera || !state.controls) return;

  const bbox = new THREE.Box3().setFromObject(state.modelMesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = state.camera.fov * (Math.PI / 180);
  const distance = Math.max(maxDim / (2 * Math.tan(fov / 2)) * 1.5, 3);

  state.camera.position.set(distance * 0.7, -distance * 0.7, center.z + distance * 0.4);
  state.controls.target.copy(center);
  state.controls.update();
}

/**
 * Apply transforms to the model.
 */
function applyTransforms(): void {
  if (!state.modelMesh || !state.originalGeometry) return;

  // Get the mesh from the group
  const mesh = state.modelMesh.children[0] as THREE.Mesh;
  const wireframe = state.modelMesh.children[1] as THREE.Mesh;
  if (!mesh) return;

  // Start with original geometry
  const geometry = state.originalGeometry.clone();

  // Center it first
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    positions.setX(i, positions.getX(i) - center.x);
    positions.setY(i, positions.getY(i) - center.y);
    positions.setZ(i, positions.getZ(i) - bbox.min.z);
  }

  // Apply rotation
  const rotMatrix = new THREE.Matrix4();
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(state.rotation.x),
    THREE.MathUtils.degToRad(state.rotation.y),
    THREE.MathUtils.degToRad(state.rotation.z),
    "XYZ"
  );
  rotMatrix.makeRotationFromEuler(euler);

  // Apply scale
  const scaleMatrix = new THREE.Matrix4();
  scaleMatrix.makeScale(state.scale, state.scale, state.scale);

  // Combine transforms
  const transformMatrix = new THREE.Matrix4();
  transformMatrix.multiply(scaleMatrix);
  transformMatrix.multiply(rotMatrix);

  // Apply to positions
  const pos = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    pos.set(positions.getX(i), positions.getY(i), positions.getZ(i));
    pos.applyMatrix4(transformMatrix);
    positions.setXYZ(i, pos.x, pos.y, pos.z);
  }

  // Re-center after rotation
  positions.needsUpdate = true;
  geometry.computeBoundingBox();
  const newBbox = geometry.boundingBox!;
  const newCenter = new THREE.Vector3();
  newBbox.getCenter(newCenter);

  for (let i = 0; i < positions.count; i++) {
    positions.setX(i, positions.getX(i) - newCenter.x);
    positions.setY(i, positions.getY(i) - newCenter.y);
    positions.setZ(i, positions.getZ(i) - newBbox.min.z);
  }

  positions.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.computeVertexNormals();

  // Update mesh geometry
  mesh.geometry.dispose();
  mesh.geometry = geometry;
  wireframe.geometry.dispose();
  wireframe.geometry = geometry;

  fitCamera();
}

/**
 * Update rotation input values.
 */
function updateRotationInputs(): void {
  const rotX = document.getElementById("rot-x") as HTMLInputElement;
  const rotXVal = document.getElementById("rot-x-val") as HTMLInputElement;
  const rotY = document.getElementById("rot-y") as HTMLInputElement;
  const rotYVal = document.getElementById("rot-y-val") as HTMLInputElement;
  const rotZ = document.getElementById("rot-z") as HTMLInputElement;
  const rotZVal = document.getElementById("rot-z-val") as HTMLInputElement;

  if (rotX) rotX.value = String(state.rotation.x);
  if (rotXVal) rotXVal.value = String(state.rotation.x);
  if (rotY) rotY.value = String(state.rotation.y);
  if (rotYVal) rotYVal.value = String(state.rotation.y);
  if (rotZ) rotZ.value = String(state.rotation.z);
  if (rotZVal) rotZVal.value = String(state.rotation.z);
}

/**
 * Reset transforms.
 */
function resetTransforms(): void {
  state.rotation = { x: 0, y: 0, z: 0 };
  state.scale = 1;

  updateRotationInputs();

  const scale = document.getElementById("scale") as HTMLInputElement;
  const scaleVal = document.getElementById("scale-val") as HTMLInputElement;
  if (scale) scale.value = "1";
  if (scaleVal) scaleVal.value = "1";

  applyTransforms();
}

/**
 * Set up event listeners.
 */
function setupEventListeners(): void {
  // Close button
  document.getElementById("upload-preview-close")?.addEventListener("click", closePreview);

  // Reset button
  document.getElementById("upload-preview-reset")?.addEventListener("click", resetTransforms);

  // Upload button
  document.getElementById("upload-preview-upload")?.addEventListener("click", handleUpload);

  // Rotation X
  const rotX = document.getElementById("rot-x") as HTMLInputElement;
  const rotXVal = document.getElementById("rot-x-val") as HTMLInputElement;
  rotX?.addEventListener("input", () => {
    state.rotation.x = parseFloat(rotX.value);
    if (rotXVal) rotXVal.value = rotX.value;
    applyTransforms();
  });
  rotXVal?.addEventListener("change", () => {
    state.rotation.x = parseFloat(rotXVal.value) || 0;
    if (rotX) rotX.value = String(state.rotation.x);
    applyTransforms();
  });

  // Rotation Y
  const rotY = document.getElementById("rot-y") as HTMLInputElement;
  const rotYVal = document.getElementById("rot-y-val") as HTMLInputElement;
  rotY?.addEventListener("input", () => {
    state.rotation.y = parseFloat(rotY.value);
    if (rotYVal) rotYVal.value = rotY.value;
    applyTransforms();
  });
  rotYVal?.addEventListener("change", () => {
    state.rotation.y = parseFloat(rotYVal.value) || 0;
    if (rotY) rotY.value = String(state.rotation.y);
    applyTransforms();
  });

  // Rotation Z
  const rotZ = document.getElementById("rot-z") as HTMLInputElement;
  const rotZVal = document.getElementById("rot-z-val") as HTMLInputElement;
  rotZ?.addEventListener("input", () => {
    state.rotation.z = parseFloat(rotZ.value);
    if (rotZVal) rotZVal.value = rotZ.value;
    applyTransforms();
  });
  rotZVal?.addEventListener("change", () => {
    state.rotation.z = parseFloat(rotZVal.value) || 0;
    if (rotZ) rotZ.value = String(state.rotation.z);
    applyTransforms();
  });

  // Scale
  const scale = document.getElementById("scale") as HTMLInputElement;
  const scaleVal = document.getElementById("scale-val") as HTMLInputElement;
  scale?.addEventListener("input", () => {
    state.scale = parseFloat(scale.value);
    if (scaleVal) scaleVal.value = scale.value;
    applyTransforms();
  });
  scaleVal?.addEventListener("change", () => {
    state.scale = parseFloat(scaleVal.value) || 1;
    if (scale) scale.value = String(state.scale);
    applyTransforms();
  });
}

/**
 * Show error message.
 */
function showError(message: string): void {
  const errorEl = document.getElementById("upload-preview-error");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }
}

/**
 * Hide error message.
 */
function hideError(): void {
  const errorEl = document.getElementById("upload-preview-error");
  if (errorEl) {
    errorEl.classList.add("hidden");
  }
}

/**
 * Export the current model as GLB.
 */
async function exportTransformedGLB(): Promise<Blob> {
  if (!state.modelMesh) {
    throw new Error("No model to export");
  }

  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");

  const mesh = state.modelMesh.children[0] as THREE.Mesh;
  if (!mesh) {
    throw new Error("No mesh found");
  }

  const exporter = new GLTFExporter();

  return new Promise((resolve, reject) => {
    exporter.parse(
      mesh,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Blob([result], { type: "model/gltf-binary" }));
        } else {
          reject(new Error("Expected binary GLB output"));
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
 * Handle upload.
 */
async function handleUpload(): Promise<void> {
  const editState = getEditState();
  if (!editState.selectedOsmId || !state.pendingFile) {
    showError("No building selected");
    return;
  }

  hideError();

  const loadingEl = document.getElementById("upload-preview-loading");
  if (loadingEl) loadingEl.classList.remove("hidden");

  try {
    // Export transformed model
    const blob = await exportTransformedGLB();
    const file = new File([blob], state.pendingFile.name, { type: "model/gltf-binary" });

    // Upload to API
    await uploadMesh(editState.selectedOsmId, file, "user_upload");

    // Apply to scene
    await loadAndApplyCustomMesh(editState.selectedOsmId);

    console.log("Mesh uploaded with transforms:", {
      rotation: state.rotation,
      scale: state.scale,
    });

    if (loadingEl) loadingEl.classList.add("hidden");

    // Close and notify success
    closePreview();
    if (state.onComplete) {
      state.onComplete(true);
    }
  } catch (error) {
    if (loadingEl) loadingEl.classList.add("hidden");
    showError(error instanceof Error ? error.message : "Upload failed");
  }
}

/**
 * Open the upload preview.
 */
export async function openUploadPreview(
  file: File,
  onComplete?: (success: boolean) => void
): Promise<void> {
  state.pendingFile = file;
  state.onComplete = onComplete || null;

  // Reset transforms
  state.rotation = { x: 0, y: 0, z: 0 };
  state.scale = 1;

  const isFirstOpen = !state.container;

  if (isFirstOpen) {
    state.container = createPreviewWindow();
    document.getElementById("ui")?.appendChild(state.container);

    state.canvas = document.getElementById("upload-preview-canvas") as HTMLCanvasElement;

    setupEventListeners();
  }

  // Reset UI
  hideError();
  const loadingEl = document.getElementById("upload-preview-loading");
  if (loadingEl) loadingEl.classList.add("hidden");

  // Reset input values
  updateRotationInputs();
  const scale = document.getElementById("scale") as HTMLInputElement;
  const scaleVal = document.getElementById("scale-val") as HTMLInputElement;
  if (scale) scale.value = "1";
  if (scaleVal) scaleVal.value = "1";

  // Show window
  state.container!.classList.remove("hidden");
  state.isOpen = true;

  if (isFirstOpen) {
    requestAnimationFrame(() => {
      initScene();
      animate();
      loadModel(file).catch((err) => {
        showError(err instanceof Error ? err.message : "Failed to load model");
      });
    });
  } else {
    animate();
    resizeCanvas();
    loadModel(file).catch((err) => {
      showError(err instanceof Error ? err.message : "Failed to load model");
    });
  }
}

/**
 * Close the upload preview.
 */
export function closePreview(): void {
  state.isOpen = false;

  if (state.animationId) {
    cancelAnimationFrame(state.animationId);
    state.animationId = null;
  }

  clearModel();

  state.container?.classList.add("hidden");
  state.pendingFile = null;

  if (state.onComplete) {
    state.onComplete(false);
    state.onComplete = null;
  }
}

/**
 * Check if preview is open.
 */
export function isUploadPreviewOpen(): boolean {
  return state.isOpen;
}
