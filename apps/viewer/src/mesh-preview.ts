/**
 * Mesh Preview Window
 *
 * A pop-out window that displays a single building mesh in isolation.
 * Features:
 * - Draggable/resizable window
 * - OrbitControls for rotation
 * - Auto-centers and fits the building
 * - Persistent (stays open when clicking elsewhere)
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { ViewerState } from "./state.ts";
import {
  openMeshEditor,
  closeMeshEditor,
  updateEditor,
} from "./mesh-editor/index.ts";

interface PreviewState {
  container: HTMLElement | null;
  canvas: HTMLCanvasElement | null;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  controls: OrbitControls | null;
  buildingMesh: THREE.Object3D | null;
  buildingGeometry: THREE.BufferGeometry | null;
  animationId: number | null;
  isOpen: boolean;
  isEditMode: boolean;
  currentOsmId: number | null;
  currentGlobalId: number | null;
  isDragging: boolean;
  dragOffset: { x: number; y: number };
}

const previewState: PreviewState = {
  container: null,
  canvas: null,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  buildingMesh: null,
  buildingGeometry: null,
  animationId: null,
  isOpen: false,
  isEditMode: false,
  currentOsmId: null,
  currentGlobalId: null,
  isDragging: false,
  dragOffset: { x: 0, y: 0 },
};

/**
 * Create the preview window DOM structure.
 */
function createPreviewWindow(): HTMLElement {
  const container = document.createElement("div");
  container.id = "mesh-preview-window";
  container.className = "preview-window";
  container.innerHTML = `
    <div class="preview-header">
      <span class="preview-title">Building Preview</span>
      <div class="preview-controls">
        <button id="preview-edit-btn" class="preview-edit-btn" title="Edit Mesh">✎</button>
        <button id="preview-reset-btn" title="Reset view">↺</button>
        <button id="preview-close-btn" title="Close">&times;</button>
      </div>
    </div>
    <div class="preview-content">
      <canvas id="preview-canvas"></canvas>
    </div>
    <div class="preview-info">
      <span id="preview-osm-id"></span>
    </div>
    <div class="preview-resize-handle"></div>
  `;
  return container;
}

/**
 * Initialize the Three.js scene for the preview.
 */
function initPreviewScene(): void {
  if (!previewState.canvas) return;

  // Renderer
  previewState.renderer = new THREE.WebGLRenderer({
    canvas: previewState.canvas,
    antialias: true,
    alpha: true,
  });
  previewState.renderer.setPixelRatio(window.devicePixelRatio);
  previewState.renderer.setClearColor(0x1a1a2e, 1);

  // Scene
  previewState.scene = new THREE.Scene();

  // Camera
  previewState.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  previewState.camera.position.set(50, 50, 50);

  // Controls - Z is up
  previewState.camera.up.set(0, 0, 1);
  previewState.controls = new OrbitControls(previewState.camera, previewState.canvas);
  previewState.controls.enableDamping = true;
  previewState.controls.dampingFactor = 0.1;
  previewState.controls.enablePan = true;
  previewState.controls.enableZoom = true;

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  previewState.scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(50, 100, 50);
  previewState.scene.add(directionalLight);

  const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
  backLight.position.set(-50, 50, -50);
  previewState.scene.add(backLight);

  // Grid helper
  const gridHelper = new THREE.GridHelper(100, 20, 0x444444, 0x333333);
  gridHelper.rotation.x = Math.PI / 2; // Rotate to XY plane (Z-up)
  previewState.scene.add(gridHelper);

  // Initial resize
  resizePreview();
}

/**
 * Resize the preview renderer to match container size.
 */
function resizePreview(): void {
  if (!previewState.container || !previewState.renderer || !previewState.camera) return;

  const content = previewState.container.querySelector(".preview-content") as HTMLElement;
  if (!content) return;

  const width = content.clientWidth;
  const height = content.clientHeight;

  previewState.camera.aspect = width / height;
  previewState.camera.updateProjectionMatrix();
  previewState.renderer.setSize(width, height);
}

/**
 * Animation loop for the preview.
 */
function animatePreview(): void {
  if (!previewState.isOpen) return;

  previewState.animationId = requestAnimationFrame(animatePreview);

  if (previewState.controls) {
    previewState.controls.update();
  }

  // Update mesh editor if active
  if (previewState.isEditMode) {
    updateEditor();
  }

  if (previewState.renderer && previewState.scene && previewState.camera) {
    previewState.renderer.render(previewState.scene, previewState.camera);
  }
}


/**
 * Load and display the building mesh in the preview window.
 */
export async function loadBuildingPreview(
  viewerState: ViewerState,
  osmId: number,
  globalId: number
): Promise<void> {
  if (!previewState.scene) return;

  // Clear existing mesh
  if (previewState.buildingMesh) {
    previewState.scene.remove(previewState.buildingMesh);
    previewState.buildingMesh = null;
  }

  previewState.currentOsmId = osmId;
  previewState.currentGlobalId = globalId;

  // Update info display
  const osmIdEl = document.getElementById("preview-osm-id");
  if (osmIdEl) {
    osmIdEl.textContent = `OSM ID: ${osmId}`;
  }

  let foundGeometry: THREE.BufferGeometry | null = null;

  // Search through building metadata to find the building's face range
  if (viewerState.buildingMetadata) {
    for (const [chunkId, entries] of Object.entries(viewerState.buildingMetadata.chunks)) {
      for (const entry of entries) {
        if (entry.global_id === globalId) {
          // Found the building entry
          const meshList = viewerState.buildingMeshes.get(chunkId);
          if (meshList && meshList.length > 0) {
            // Get the combined mesh for this chunk
            const chunkMesh = meshList[0];
            const geometry = chunkMesh.geometry as THREE.BufferGeometry;

            const startFace = entry.start_face;
            const endFace = entry.end_face;
            const faceCount = endFace - startFace;

            console.log(`Extracting building ${osmId}: faces ${startFace}-${endFace} (${faceCount} faces)`);

            const positions = geometry.getAttribute("position");
            const normals = geometry.getAttribute("normal");
            const uvs = geometry.getAttribute("uv");
            const index = geometry.index;

            const newPositions: number[] = [];
            const newNormals: number[] = [];
            const newUvs: number[] = [];

            if (index) {
              // Indexed geometry
              const newIndices: number[] = [];
              const vertexMap = new Map<number, number>();

              for (let f = startFace; f < endFace; f++) {
                for (let v = 0; v < 3; v++) {
                  const oldIndex = index.getX(f * 3 + v);

                  if (!vertexMap.has(oldIndex)) {
                    const newIndex = newPositions.length / 3;
                    vertexMap.set(oldIndex, newIndex);

                    newPositions.push(
                      positions.getX(oldIndex),
                      positions.getY(oldIndex),
                      positions.getZ(oldIndex)
                    );

                    if (normals) {
                      newNormals.push(
                        normals.getX(oldIndex),
                        normals.getY(oldIndex),
                        normals.getZ(oldIndex)
                      );
                    }

                    if (uvs) {
                      newUvs.push(uvs.getX(oldIndex), uvs.getY(oldIndex));
                    }
                  }

                  newIndices.push(vertexMap.get(oldIndex)!);
                }
              }

              if (newPositions.length > 0) {
                foundGeometry = new THREE.BufferGeometry();
                foundGeometry.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
                if (newNormals.length > 0) {
                  foundGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
                }
                if (newUvs.length > 0) {
                  foundGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(newUvs, 2));
                }
                foundGeometry.setIndex(newIndices);
              }
            } else {
              // Non-indexed geometry - each face is 3 consecutive vertices
              const startVertex = startFace * 3;
              const endVertex = endFace * 3;

              for (let i = startVertex; i < endVertex; i++) {
                newPositions.push(
                  positions.getX(i),
                  positions.getY(i),
                  positions.getZ(i)
                );

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
              }

              if (newPositions.length > 0) {
                foundGeometry = new THREE.BufferGeometry();
                foundGeometry.setAttribute("position", new THREE.Float32BufferAttribute(newPositions, 3));
                if (newNormals.length > 0) {
                  foundGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(newNormals, 3));
                }
                if (newUvs.length > 0) {
                  foundGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(newUvs, 2));
                }
              }
            }

            if (foundGeometry) {
              foundGeometry.computeVertexNormals();
              console.log(`Extracted geometry: ${foundGeometry.getAttribute("position").count} vertices`);
            }
          }
          break;
        }
      }
      if (foundGeometry) break;
    }
  }

  if (foundGeometry && foundGeometry.getAttribute("position").count > 0) {
    // Create material
    const material = new THREE.MeshStandardMaterial({
      color: 0x8b7355,
      roughness: 0.8,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });

    // Create mesh
    const mesh = new THREE.Mesh(foundGeometry, material);

    // Compute bounding box
    foundGeometry.computeBoundingBox();
    const bbox = foundGeometry.boundingBox!;
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    // Translate geometry: center in X/Y, place base on Z=0 plane
    const positions = foundGeometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      positions.setX(i, positions.getX(i) - center.x);
      positions.setY(i, positions.getY(i) - center.y);
      positions.setZ(i, positions.getZ(i) - bbox.min.z); // Base at Z=0
    }
    positions.needsUpdate = true;
    foundGeometry.computeBoundingBox();

    // Add wireframe overlay
    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    const wireframe = new THREE.Mesh(foundGeometry, wireframeMaterial);

    // Group mesh and wireframe
    const group = new THREE.Group();
    group.add(mesh);
    group.add(wireframe);

    previewState.buildingMesh = group;
    previewState.scene.add(group);

    // Fit camera to building
    const size = new THREE.Vector3();
    foundGeometry.boundingBox!.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = previewState.camera!.fov * (Math.PI / 180);
    const cameraDistance = Math.max(maxDim / (2 * Math.tan(fov / 2)) * 1.8, 20);

    // Position camera to view building from front-right, looking at center height
    const buildingCenterZ = size.z / 2;
    previewState.camera!.position.set(cameraDistance * 0.7, -cameraDistance * 0.7, buildingCenterZ + cameraDistance * 0.4);
    previewState.controls!.target.set(0, 0, buildingCenterZ);
    previewState.controls!.update();

    // Store geometry for editor
    previewState.buildingGeometry = foundGeometry;

    console.log(`Preview loaded: ${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}m`);
  } else {
    console.warn("Could not extract building geometry, showing placeholder");

    // Fallback: create a placeholder box
    const geometry = new THREE.BoxGeometry(10, 10, 20);
    const material = new THREE.MeshStandardMaterial({ color: 0x8b7355 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = 10;
    previewState.buildingMesh = mesh;
    previewState.scene.add(mesh);

    previewState.camera!.position.set(30, 30, 30);
    previewState.controls!.target.set(0, 0, 10);
    previewState.controls!.update();
  }
}

/**
 * Toggle edit mode for the current building.
 */
function toggleEditMode(): void {
  if (!previewState.scene || !previewState.camera || !previewState.container) {
    return;
  }

  if (previewState.isEditMode) {
    // Exit edit mode
    closeMeshEditor();
    previewState.isEditMode = false;

    // Update UI
    const editBtn = document.getElementById("preview-edit-btn");
    if (editBtn) {
      editBtn.classList.remove("active");
      editBtn.title = "Edit Mesh";
    }

    const title = previewState.container.querySelector(".preview-title");
    if (title) {
      title.textContent = "Building Preview";
    }

    console.log("Exited mesh edit mode");
  } else {
    // Enter edit mode
    if (!previewState.buildingGeometry || !previewState.currentOsmId) {
      console.warn("No geometry available for editing");
      return;
    }

    // Get the preview content element for the editor UI
    const content = previewState.container.querySelector(".preview-content") as HTMLElement;
    if (!content) return;

    openMeshEditor(
      previewState.scene,
      previewState.camera,
      previewState.controls,
      previewState.buildingGeometry,
      previewState.currentOsmId,
      content
    );

    previewState.isEditMode = true;

    // Update UI
    const editBtn = document.getElementById("preview-edit-btn");
    if (editBtn) {
      editBtn.classList.add("active");
      editBtn.title = "Exit Edit Mode";
    }

    const title = previewState.container.querySelector(".preview-title");
    if (title) {
      title.textContent = "Building Preview - Edit Mode";
    }

    // Remove the preview mesh (editor has its own)
    if (previewState.buildingMesh) {
      previewState.scene.remove(previewState.buildingMesh);
      previewState.buildingMesh = null;
    }

    console.log("Entered mesh edit mode");
  }
}

/**
 * Reset the camera to default view.
 */
function resetView(): void {
  if (!previewState.camera || !previewState.controls || !previewState.buildingMesh) return;

  const bbox = new THREE.Box3().setFromObject(previewState.buildingMesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = previewState.camera.fov * (Math.PI / 180);
  const cameraDistance = Math.max(maxDim / (2 * Math.tan(fov / 2)) * 1.8, 20);

  // Building is centered at X=0, Y=0 with base at Z=0
  const buildingCenterZ = size.z / 2;
  previewState.camera.position.set(cameraDistance * 0.7, -cameraDistance * 0.7, buildingCenterZ + cameraDistance * 0.4);
  previewState.controls.target.set(0, 0, buildingCenterZ);
  previewState.controls.update();
}

/**
 * Set up drag functionality for the window.
 */
function setupDragging(): void {
  const header = previewState.container?.querySelector(".preview-header") as HTMLElement;
  if (!header || !previewState.container) return;

  header.addEventListener("mousedown", (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;

    previewState.isDragging = true;
    const rect = previewState.container!.getBoundingClientRect();
    previewState.dragOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    header.style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!previewState.isDragging || !previewState.container) return;

    const x = e.clientX - previewState.dragOffset.x;
    const y = e.clientY - previewState.dragOffset.y;

    previewState.container.style.left = `${x}px`;
    previewState.container.style.top = `${y}px`;
    previewState.container.style.right = "auto";
    previewState.container.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    previewState.isDragging = false;
    if (header) header.style.cursor = "grab";
  });
}

/**
 * Set up resize functionality.
 */
function setupResizing(): void {
  const handle = previewState.container?.querySelector(".preview-resize-handle") as HTMLElement;
  if (!handle || !previewState.container) return;

  let isResizing = false;

  handle.addEventListener("mousedown", (e: MouseEvent) => {
    isResizing = true;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isResizing || !previewState.container) return;

    const rect = previewState.container.getBoundingClientRect();
    const width = e.clientX - rect.left;
    const height = e.clientY - rect.top;

    previewState.container.style.width = `${Math.max(250, width)}px`;
    previewState.container.style.height = `${Math.max(200, height)}px`;

    resizePreview();
  });

  document.addEventListener("mouseup", () => {
    isResizing = false;
  });
}

/**
 * Open the preview window.
 */
export function openPreviewWindow(viewerState: ViewerState, osmId: number, globalId: number): void {
  if (!previewState.container) {
    // Create window
    previewState.container = createPreviewWindow();
    document.getElementById("ui")?.appendChild(previewState.container);

    previewState.canvas = document.getElementById("preview-canvas") as HTMLCanvasElement;

    // Set up event listeners
    document.getElementById("preview-close-btn")?.addEventListener("click", closePreviewWindow);
    document.getElementById("preview-reset-btn")?.addEventListener("click", resetView);
    document.getElementById("preview-edit-btn")?.addEventListener("click", toggleEditMode);

    setupDragging();
    setupResizing();

    // Initialize Three.js
    initPreviewScene();
  }

  previewState.container.classList.remove("hidden");
  previewState.isOpen = true;

  // Start animation loop
  animatePreview();

  // Load the building
  loadBuildingPreview(viewerState, osmId, globalId);

  // Resize after showing
  setTimeout(resizePreview, 0);
}

/**
 * Close the preview window.
 */
export function closePreviewWindow(): void {
  // Close mesh editor if open
  if (previewState.isEditMode) {
    closeMeshEditor();
    previewState.isEditMode = false;
  }

  previewState.isOpen = false;

  if (previewState.animationId) {
    cancelAnimationFrame(previewState.animationId);
    previewState.animationId = null;
  }

  previewState.container?.classList.add("hidden");
}

/**
 * Check if preview window is open.
 */
export function isPreviewOpen(): boolean {
  return previewState.isOpen;
}

/**
 * Get current preview OSM ID.
 */
export function getPreviewOsmId(): number | null {
  return previewState.currentOsmId;
}
